import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  standardWebhooksSign, standardWebhooksKey, standardWebhooksVerifier, githubVerifier, stripeVerifier,
  slackVerifier, hmacVerifier, verifierProblem, envSecret, headerRef, keyToMessageId, redactUrl,
  webhookHandler, webhookHandlerFromSpec, webhookSource, caseEvent, outcomeEvent, isCaseEvent, isOutcomeEvent,
} from '../src/webhooks.js';
import { loadHandlers } from '../src/handlers.js';
import { skipUnlessInMonorepo } from './monorepo.js';

const decision = (action, target, reason = null) => ({
  action, target, reason, data: null, rule: 'route', clause: 0, source: null, line: null, file: null,
  model: null, provider: null, requested_model: null, requested_effort: null, effective_effort: null,
  request_id: null, stage: null, proposed: null, evidence: [], steps: [], readings: [],
});
const casesPath = new URL('./parity/webhook-cases.json', import.meta.url);

test('Racket oracle: the same signature, and the same verdict from every verifier', async t => {
  if (skipUnlessInMonorepo(t)) return;
  const oracle = fileURLToPath(new URL('./webhooks-oracle.rkt', import.meta.url));
  const run = spawnSync('racket', [oracle], { encoding: 'utf8', env: { ...process.env, JEV_NO_SUCH_SECRET: '' } });
  assert.equal(run.status, 0, run.stderr);
  const expected = JSON.parse(run.stdout);
  const cases = JSON.parse(await readFile(casesPath, 'utf8'));
  const { secret, body, now } = cases;

  assert.deepEqual(cases.sign.map(([id, ts]) => standardWebhooksSign(secret, id, ts, body)), expected.sign);
  assert.deepEqual(cases.keys.map(s => {
    const key = standardWebhooksKey(s);
    return key === null ? null : [...key];
  }), expected.keys);

  const shape = ({ ok, deliveryId, reason }) => ({ ok, id: deliveryId ?? null, reason: reason ?? null });
  const run_ = (verifier, entry) => shape(verifier(entry.headers, body, now));
  assert.deepEqual(cases.standard.map(e => run_(standardWebhooksVerifier(secret), e)), expected.standard);
  assert.deepEqual(cases.github.map(e => run_(githubVerifier('gh-secret'), e)), expected.github);
  assert.deepEqual(cases.stripe.map(e => run_(stripeVerifier('stripe-secret'), e)), expected.stripe);
  assert.deepEqual(cases.slack.map(e => run_(slackVerifier('slack-secret'), e)), expected.slack);
  assert.deepEqual(cases.hmac.map(e => run_(hmacVerifier('plain-secret', {
    header: 'x-signature', encoding: e.encoding, prefix: e.prefix, idHeader: e.idHeader,
  }), e)), expected.hmac);

  // A verifier with no secret says so instead of rejecting silently.
  const missing = standardWebhooksVerifier(envSecret('JEV_NO_SUCH_SECRET'));
  assert.deepEqual({ ok: missing({}, body, now).ok, reason: missing({}, body, now).reason }, expected['missing-secret']);
  assert.deepEqual([
    verifierProblem(standardWebhooksVerifier(envSecret('JEV_NO_SUCH_SECRET'))),
    verifierProblem(standardWebhooksVerifier('whsec_not!base64')),
    verifierProblem(githubVerifier('gh-secret')),
  ], expected.problems);
});

const secret = `whsec_${Buffer.from('a'.repeat(32)).toString('base64')}`;
const collectingServer = async (answer) => {
  const seen = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      seen.push({ headers: request.headers, body });
      const { status, headers = {}, text = '' } = answer(seen.length, body);
      response.writeHead(status, headers).end(text);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { seen, server, url: `http://127.0.0.1:${server.address().port}/hook` };
};

test('a decision goes out signed, dedupable, and retried only where it should be', async t => {
  const { seen, server, url } = await collectingServer(attempt => attempt < 3 ? { status: 500, text: 'later' } : { status: 202, text: 'ok' });
  t.after(() => server.close());
  const waits = [];
  const handler = webhookHandler(url, {
    secret, attempts: 3, backoff: 1, sleep: async seconds => waits.push(seconds), now: () => 1700000000,
  });
  const result = await handler({ ticket: 'a refund' }, decision('assign', 'billing-queue', 'a refund'), { key: 'req-7/billing-queue' });
  assert.deepEqual(result, { status: 202, webhook_id: 'req-7/billing-queue', attempts: 3 });
  // The same webhook-id on every attempt, so the receiver can dedupe.
  assert.deepEqual(seen.map(s => s.headers['webhook-id']), Array(3).fill('req-7/billing-queue'));
  assert.deepEqual(waits, [1, 2]);
  assert.equal(seen[0].headers['user-agent'], 'jev-webhooks');
  // The receiver's own verifier accepts what was sent.
  const verify = standardWebhooksVerifier(secret);
  const check = verify(seen[0].headers, seen[0].body, 1700000000);
  assert.equal(check.ok, true);
  assert.equal(check.deliveryId, 'req-7/billing-queue');
  const sent = JSON.parse(seen[0].body);
  assert.equal(sent.type, 'jev.decision');
  assert.equal(sent.data.decision.target, 'billing-queue');
  assert.match(sent.data.explain, /assign billing-queue/);
  // The state is left out unless it was asked for.
  assert.equal(sent.data.state, undefined);
});

test('a webhook that is refused, times out or keeps failing raises, and says which', async t => {
  const refusing = await collectingServer(() => ({ status: 422, text: 'no such queue' }));
  t.after(() => refusing.server.close());
  const refused = webhookHandler(refusing.url, { secret, attempts: 3, backoff: 0, sleep: async () => {} });
  await assert.rejects(refused({}, decision('assign', 'q'), {}),
    error => /not retried: only a connection error, a timeout, 408, 429 and 5xx are/.test(error.message)
      && /answered 422: no such queue/.test(error.message));
  assert.equal(refusing.seen.length, 1);

  const failing = await collectingServer(() => ({ status: 503, headers: { 'retry-after': '5' }, text: 'busy' }));
  t.after(() => failing.server.close());
  const waits = [];
  const giving = webhookHandler(failing.url, { secret, attempts: 2, backoff: 1, sleep: async s => waits.push(s) });
  await assert.rejects(giving({}, decision('assign', 'q'), { key: 'k' }),
    error => /after 2 attempts \(webhook-id k\)/.test(error.message));
  // A Retry-After of up to a minute is honoured when it is longer than the backoff.
  assert.deepEqual(waits, [5]);

  const slow = createServer(() => { /* never answers */ });
  await new Promise(resolve => slow.listen(0, '127.0.0.1', resolve));
  t.after(() => slow.close());
  const timing = webhookHandler(`http://127.0.0.1:${slow.address().port}/hook`, { secret, attempts: 1, timeoutSeconds: 0.2 });
  await assert.rejects(timing({}, decision('assign', 'q'), {}), /timed out after 0.2 seconds/);
  // The URL's path never appears in a message: it can be the secret.
  await assert.rejects(webhookHandler('https://hooks.example.com/services/T/B/secret', { secret, attempts: 1, timeoutSeconds: 0.2 })({}, decision('assign', 'q'), {}),
    error => error.message.includes('https://hooks.example.com/...') && !error.message.includes('/services/T/B/secret'));
  // A bad URL or a bad secret is refused when the handler is built.
  assert.throws(() => webhookHandler('ftp://example.com', { secret }), /must be http:\/\/ or https:\/\//);
  assert.throws(() => webhookHandler('https://example.com', { secret: 'whsec_not!base64' }), /not base64/);
  assert.throws(() => webhookHandler('https://example.com', { secret: envSecret('JEV_NO_SUCH_SECRET') }), /unset or empty/);
});

test('a handlers file can declare signed delivery, with the secret named not written', async t => {
  process.env.JEV_TEST_WEBHOOK_SECRET = secret;
  t.after(() => { delete process.env.JEV_TEST_WEBHOOK_SECRET; });
  const { seen, server, url } = await collectingServer(() => ({ status: 200, text: '{}' }));
  t.after(() => server.close());
  const handlers = await loadHandlers({
    handlers: { 'billing-queue': { type: 'webhook', url, secret_env: 'JEV_TEST_WEBHOOK_SECRET', include_state: true } },
  });
  const result = await handlers['billing-queue']({ ticket: 'x' }, decision('assign', 'billing-queue'), { key: 'req-1/billing-queue' });
  assert.equal(result.status, 200);
  assert.deepEqual(JSON.parse(seen[0].body).data.state, { ticket: 'x' });
  // The keys are checked, and the secret itself is never a key.
  assert.throws(() => webhookHandlerFromSpec({ url, secret: secret }), /is not a webhook handler key/);
  assert.throws(() => webhookHandlerFromSpec({ url }), /secret_env.*is required/s);
  assert.throws(() => webhookHandlerFromSpec({ url, secret_env: 'JEV_NO_SUCH_SECRET' }), /unset or empty/);
  assert.throws(() => webhookHandlerFromSpec({ url: 'nope', secret_env: 'JEV_TEST_WEBHOOK_SECRET' }), /must be http/);
  assert.throws(() => webhookHandlerFromSpec({ url, secret_env: 'JEV_TEST_WEBHOOK_SECRET', attempts: 0 }), /positive integer/);
});

test('message ids stay stable, sources are checked, and events carry what a wiring needs', () => {
  assert.equal(keyToMessageId('req-1/lock-door'), 'req-1/lock-door');
  assert.match(keyToMessageId('has.dots.in.it'), /^msg_[0-9a-f]{32}$/);
  assert.match(keyToMessageId('x'.repeat(200)), /^msg_[0-9a-f]{32}$/);
  assert.equal(redactUrl('http://localhost:8080/hook?token=abc'), 'http://localhost:8080/...');
  assert.equal(redactUrl('not a url'), 'the webhook URL');
  assert.equal(headerRef([['Webhook-Id', 'a']], 'webhook-id'), 'a');
  assert.equal(headerRef({ 'Webhook-Id': 'a' }, 'WEBHOOK-ID'), 'a');

  const source = webhookSource('tickets', { verify: standardWebhooksVerifier(secret), event: json => caseEvent(json.id, json) });
  assert.equal(source.name, 'tickets');
  assert.equal(source.insecure, false);
  assert.throws(() => webhookSource('not a name', { event: () => null }), /letters, digits/);
  assert.throws(() => webhookSource('tickets', {}), /event is a function/);
  assert.throws(() => webhookSource('tickets', { event: () => null, verify: 'maybe' }), /verify is a verifier/);

  const one = caseEvent('t-1', { subject: 'refund' });
  assert.ok(isCaseEvent(one) && !isOutcomeEvent(one));
  assert.deepEqual(one, { kind: 'case', id: 't-1', input: { subject: 'refund' } });
  const settled = outcomeEvent('t-1', { kind: 'resolved', label: { action: 'assign', target: 'billing-queue' } });
  assert.ok(isOutcomeEvent(settled));
  assert.equal(settled.outcomeKind, 'resolved');
  assert.deepEqual(settled.label, { action: 'assign', target: 'billing-queue' });
});
