import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { cloud, CloudError, runner } from '../src/cloud.js';
import { makeDispatcher, dispatch } from '../src/dispatch.js';
import { definePolicy, noul, rule, assign, hold } from '../src/index.js';

// A JevLang Cloud on 127.0.0.1. The client is fetch and nothing else, so this
// is the whole of what it needs; no test here reaches the network.
function fakeCloud(routes) {
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://127.0.0.1');
      seen.push({ method: req.method, path: url.pathname, query: url.searchParams, headers: req.headers, body: body ? JSON.parse(body) : null });
      const route = routes[`${req.method} ${url.pathname}`] ?? routes[url.pathname];
      if (!route) { res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'No such project.' })); return; }
      const answer = typeof route === 'function' ? route(seen.at(-1)) : route;
      res.writeHead(answer.status ?? 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answer.body ?? answer));
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${server.address().port}`,
      seen,
      stop: () => server.close(),
    }));
  });
}

const decision = { action: 'assign', target: 'billing-queue', reason: null, readings: [] };

test('evaluate sends the input and returns the decision the service made', async () => {
  const service = await fakeCloud({ 'POST /api/v1/projects/support/evaluate': { body: { decision, trace: 'trc_1' } } });
  const jc = cloud({ key: 'jev_live_test', baseUrl: service.url });
  assert.deepEqual(await jc.evaluate('support', { ticket: 'an invoice question' }), decision);
  const call = service.seen[0];
  assert.equal(call.headers.authorization, 'Bearer jev_live_test');
  assert.deepEqual(call.body, { input: { ticket: 'an invoice question' } });
  service.stop();
});

test('a publishable key goes to the public door, and carries the end user', async () => {
  const service = await fakeCloud({ 'POST /api/public/evaluate': { body: { decision } } });
  const jc = cloud({ key: 'jev_pub_test', baseUrl: service.url });
  await jc.evaluate('support', { ticket: 'hello' }, { endUser: 'u_42' });
  const call = service.seen[0];
  assert.equal(call.path, '/api/public/evaluate');
  assert.equal(call.headers['x-jev-key'], 'jev_pub_test');
  assert.equal(call.headers['x-jev-end-user'], 'u_42');
  assert.deepEqual(call.body.project, 'support');
  service.stop();
});

test('an idempotency key rides on the request that needs it', async () => {
  const service = await fakeCloud({ 'POST /api/v1/projects/support/evaluate': { body: { decision } } });
  const jc = cloud({ key: 'jev_live_test', baseUrl: service.url });
  await jc.evaluate('support', {}, { idempotencyKey: 'case-1' });
  assert.equal(service.seen[0].headers['idempotency-key'], 'case-1');
  service.stop();
});

test('an environment is a header, not an argument the caller can forget', async () => {
  const service = await fakeCloud({ 'POST /api/v1/projects/support/decide': { body: { decision } } });
  const jc = cloud({ key: 'jev_live_test', baseUrl: service.url, environment: 'preview' });
  await jc.decide('support', {}, { 'refund-requested?': { noul: 0.1 } });
  assert.equal(service.seen[0].headers['x-jev-environment'], 'preview');
  service.stop();
});

test('deploy takes a compiled policy or its artifact', async () => {
  const service = await fakeCloud({
    'POST /api/v1/projects/support/deployments': { status: 201, body: { id: 'dep_1', number: 2, identity: 'abc', production: false } },
  });
  const spam = noul('spam?', 'Is this spam?');
  const policy = definePolicy({
    name: 'hello', questions: [spam],
    route: { clauses: [rule(spam.yes(0.9), hold({ reason: 'spam' }))], otherwise: assign('inbox') },
  });
  const jc = cloud({ key: 'jev_live_test', baseUrl: service.url });
  const published = await jc.deploy('support', policy, { note: 'first' });
  assert.equal(published.number, 2);
  assert.equal(service.seen[0].body.policy.name, 'hello');
  assert.equal(service.seen[0].body.note, 'first');
  service.stop();
});

test('promote passes expect and a gate through, and reports what the gate saw', async () => {
  const service = await fakeCloud({
    'POST /api/v1/projects/support/promote': call => ({
      body: { production: 3, deployment: 'dep_3', rollback: false, gate: { replayed: 40, changed: 1, refused: 0, rate: 0.025 }, echo: call.body },
    }),
  });
  const jc = cloud({ key: 'jev_live_test', baseUrl: service.url });
  const moved = await jc.promote('support', 3, { expect: 2, gate: { max_changed: 0.05, sample: 40 } });
  assert.equal(moved.production, 3);
  assert.deepEqual(service.seen[0].body, { deployment: 3, expect: 2, gate: { max_changed: 0.05, sample: 40 } });
  service.stop();
});

test('a refusal keeps its status, code and words', async () => {
  const service = await fakeCloud({
    'POST /api/v1/projects/support/promote': { status: 422, body: { error: 'The gate refused: 40 of 100 decisions changed.', code: 'gate_changed' } },
  });
  const jc = cloud({ key: 'jev_live_test', baseUrl: service.url });
  await assert.rejects(() => jc.promote('support', 3, { gate: { max_changed: 0.1 } }), error => {
    assert.ok(error instanceof CloudError);
    assert.equal(error.status, 422);
    assert.equal(error.code, 'gate_changed');
    assert.match(error.message, /40 of 100/);
    return true;
  });
  service.stop();
});

test("another tenant's project is a 404, with the words an unknown one gets", async () => {
  const service = await fakeCloud({});
  const jc = cloud({ key: 'jev_live_test', baseUrl: service.url });
  await assert.rejects(() => jc.project('theirs'), error => {
    assert.equal(error.status, 404);
    assert.equal(error.message, 'No such project.');
    return true;
  });
  service.stop();
});

test('the journal is the Journal interface, and a dispatcher takes it unchanged', async () => {
  const claims = [];
  const service = await fakeCloud({
    'POST /api/v1/projects/support/state': call => {
      claims.push(call.body);
      const { op } = call.body;
      if (op === 'beginStep') return { body: { result: 'new' } };
      if (op === 'claimBudget' || op === 'claimCooldown' || op === 'cancel') return { body: { result: true } };
      if (op === 'coolingDown') return { body: { result: false } };
      if (op === 'takeDue') return { body: { result: [['k', { x: 1 }]] } };
      if (op === 'nextDue') return { body: { result: null } };
      return { body: { result: null } };
    },
  });
  const jc = cloud({ key: 'jev_live_test', baseUrl: service.url });
  const journal = jc.journal('support');

  assert.equal(await journal.beginStep('k', 'billing-queue', 1000), 'new');
  await journal.finishStep('k', 'done', { ok: true }, 1001);
  assert.equal(await journal.claimBudget('refunds', 1000, 86400, 1, 3), true);
  assert.deepEqual(await journal.takeDue(1000, 60), [['k', { x: 1 }]]);
  assert.deepEqual(claims.map(c => c.op), ['beginStep', 'finishStep', 'claimBudget', 'takeDue']);

  // What a dispatcher needs from a journal, it gets from this one.
  const ran = [];
  const dispatcher = makeDispatcher({ 'billing-queue': () => { ran.push('ran'); return { ok: true }; } }, { journal });
  const outcome = await dispatch(dispatcher, {}, { action: 'assign', target: 'billing-queue', steps: [], data: null, proposed: null }, { key: 'case-1' });
  assert.equal(outcome.status, 'ran');
  assert.deepEqual(ran, ['ran']);
  service.stop();
});

test('logs and the playground link need no request to guess at', async () => {
  const service = await fakeCloud({
    'GET /api/v1/projects/support/traces': { body: { traces: [{ id: 't1', at: '2026-09-23T10:00:00Z', kind: 'evaluate', status: 'ok', decision }] } },
  });
  const jc = cloud({ key: 'jev_live_test', baseUrl: service.url });
  const traces = await jc.traces('support', { limit: 5 });
  assert.equal(traces.length, 1);
  assert.equal(service.seen[0].query.get('limit'), '5');
  assert.equal(jc.playground('support'), `${service.url}/app/projects/support/playground`);
  service.stop();
});

test('a client with no key says so before it sends anything', () => {
  assert.throws(() => cloud({ key: '' }), /needs a key/);
});

test('an unreachable service is a connection error, not a hang', async () => {
  const jc = cloud({ key: 'jev_live_test', baseUrl: 'http://127.0.0.1:1', timeoutSeconds: 1 });
  await assert.rejects(() => jc.usage(), error => {
    assert.ok(error instanceof CloudError);
    assert.ok(['connection', 'timeout'].includes(error.code));
    return true;
  });
});

// A runner claims from its pool, runs the handler the target names, and
// reports with the claim's token; a thrown error fails the job for a retry,
// and a target it has no handler for fails without one.
test('runner: claim, run, complete; a throw fails and retries; an unknown target does not retry', async () => {
  const job = (id, target) => ({ id, claim: `jrc_${id}`, project: 'support', environment: 'production', target,
    decision: { ...decision, target }, state: { ticket: 'T-1' }, attempt: 1, lease_until: '2026-01-01T00:00:00Z' });
  const service = await fakeCloud({
    'POST /api/v1/runners/claim': { jobs: [job('a', 'billing-queue'), job('b', 'flaky'), job('c', 'nobody')] },
    'POST /api/v1/runners/jobs/a/complete': { body: { id: 'a', status: 'done' } },
    'POST /api/v1/runners/jobs/b/fail': { body: { id: 'b', status: 'queued', retrying: true } },
    'POST /api/v1/runners/jobs/c/fail': { body: { id: 'c', status: 'failed' } },
  });
  const events = [];
  const r = runner({
    key: 'jev_live_test', baseUrl: service.url, pool: 'prod-east', name: 'box', concurrency: 3, wait: 0,
    handlers: {
      'billing-queue': async (state, d) => ({ filed: state.ticket, to: d.target }),
      flaky: async () => { throw new Error('db down'); },
    },
    onEvent: e => events.push(e.type),
  });
  assert.equal(await r.runOnce(), 3);
  service.stop();

  const claim = service.seen.find(s => s.path === '/api/v1/runners/claim');
  assert.deepEqual(claim.body, { pool: 'prod-east', max: 3, wait: 0, lease: 300, name: 'box' });
  assert.equal(claim.headers.authorization, 'Bearer jev_live_test');
  const body = p => service.seen.find(s => s.path === p).body;
  assert.deepEqual(body('/api/v1/runners/jobs/a/complete'), { claim: 'jrc_a', result: { filed: 'T-1', to: 'billing-queue' } });
  assert.deepEqual(body('/api/v1/runners/jobs/b/fail'), { claim: 'jrc_b', error: 'db down', retry: true });
  assert.deepEqual(body('/api/v1/runners/jobs/c/fail'), { claim: 'jrc_c', error: "this runner has no handler for 'nobody'", retry: false });
  assert.deepEqual(events.filter(e => e !== 'claimed').sort(), ['done', 'failed', 'failed']);
});

test('runner: a long handler extends its lease while it runs', async () => {
  const service = await fakeCloud({
    'POST /api/v1/runners/claim': { jobs: [{ id: 'a', claim: 'jrc_a', target: 'slow', decision, state: null, attempt: 1 }] },
    'POST /api/v1/runners/jobs/a/extend': { body: { id: 'a', status: 'claimed' } },
    'POST /api/v1/runners/jobs/a/complete': { body: { id: 'a', status: 'done' } },
  });
  // A 0.3 s lease beats every 0.1 s; the handler takes 0.35 s.
  const r = runner({ key: 'jev_live_test', baseUrl: service.url, lease: 0.3, wait: 0,
    handlers: { slow: () => new Promise(res => setTimeout(() => res('ok'), 350)) } });
  await r.runOnce();
  service.stop();
  const extends_ = service.seen.filter(s => s.path.endsWith('/extend'));
  assert.ok(extends_.length >= 2, `${extends_.length} heartbeats`);
  assert.deepEqual(extends_[0].body, { claim: 'jrc_a', lease: 0.3 });
});
