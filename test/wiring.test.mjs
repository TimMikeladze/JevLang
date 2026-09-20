import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jevWiring, startWiring, wiringProblems } from '../src/wiring.mjs';
import { webhookSource, caseEvent, outcomeEvent, standardWebhooksVerifier, standardWebhooksSign, envSecret, githubVerifier } from '../src/webhooks.mjs';
import { harvestFind, harvestStatus } from '../src/harvest.mjs';
import { makeDispatcher } from '../src/dispatch.mjs';
import { fixtureFromRun } from '../src/evaluate.mjs';
import { policy as ticket } from '../examples/ticket-router.mjs';

const secret = `whsec_${Buffer.from('a'.repeat(32)).toString('base64')}`;
const answers = {
  department: { type: 'choice', choice: 'billing', confidence: 0.93, probabilities: { billing: 0.93 } },
  frustration: { type: 'score', score: 0.2, confidence: 0.9, probabilities: { 0: 0.8, 1: 0.2, 2: 0 } },
  'refund-requested?': { type: 'noul', noul: 0.1 },
};
// What one billed call leaves behind, for the wiring to record, harvest and dispatch.
const evaluate = async input => {
  const { state, facts } = ticket.buildState(input);
  const questions = ticket.questions(state);
  const decision = ticket.decide(answers, { facts, state });
  const result = {
    output: answers, model: 'jev-1.13.0', usage: { input_tokens: 10 }, requestId: null,
    target: { provider: { id: 'typesafe' }, model: 'jev-1.13.0', requestedEffort: null, effectiveEffort: null },
  };
  return {
    decision, state, facts, questions, answers,
    fixture: fixtureFromRun({ name: 'case', policy: ticket, state, questions, decision, result }),
  };
};
const signed = (body, { id = 'msg_1', at = 1_800_000_000 } = {}) => ({
  'webhook-id': id, 'webhook-timestamp': String(at),
  'webhook-signature': standardWebhooksSign(secret, id, String(at), body),
});
const now = () => 1_800_000_000;
const ticketSource = () => webhookSource('tickets', {
  verify: standardWebhooksVerifier(secret),
  event: json => (json.type === 'ticket.created'
    ? caseEvent(json.id, { ticket: json.subject })
    : json.type === 'ticket.closed'
      ? outcomeEvent(json.id, { kind: 'close', label: json.label ?? null, labels: json.labels ?? null })
      : null),
  sync: json => (json.type === 'url_verification' ? { challenge: json.challenge } : null),
});
const startedWiring = async (options = {}) => {
  const spool = await mkdtemp(join(tmpdir(), 'jev-wiring-'));
  const wiring = jevWiring({
    spool, sources: [ticketSource()], evaluate,
    harvest: join(spool, 'harvest'), recordDir: join(spool, 'fixtures'),
    ...options,
  });
  return { spool, runtime: await startWiring(wiring, ticket, { now, startWorkers: false }) };
};

test('a wiring refuses to start where it could accept unsigned webhooks', async () => {
  const spool = await mkdtemp(join(tmpdir(), 'jev-wiring-'));
  const unsigned = jevWiring({ spool, sources: [webhookSource('tickets', { event: () => null })], evaluate });
  assert.deepEqual(wiringProblems(unsigned).map(s => s.split('\n')[0]),
    ["source 'tickets' has no verifier; every source checks a signature"]);
  await assert.rejects(startWiring(unsigned, ticket, { now }), /the wiring can't start/);
  const none = jevWiring({ spool, sources: [webhookSource('tickets', { verify: 'none', event: () => null })], evaluate });
  assert.match(wiringProblems(none)[0], /also needs insecure: true/);
  const deliberate = jevWiring({ spool, sources: [webhookSource('tickets', { verify: 'none', insecure: true, event: () => null })], evaluate });
  assert.deepEqual(wiringProblems(deliberate), []);
  // A verifier whose secret is missing is refused rather than run unsigned.
  const missing = jevWiring({ spool, sources: [webhookSource('tickets', { verify: standardWebhooksVerifier(envSecret('JEV_NO_SUCH_SECRET')), event: () => null })], evaluate });
  assert.match(wiringProblems(missing)[0], /refusing to start rather than accept unsigned webhooks/);
  // Two sources cannot share a name, and a wiring needs one.
  assert.throws(() => jevWiring({ spool, sources: [ticketSource(), ticketSource()], evaluate }), /same name/);
  assert.throws(() => jevWiring({ spool, sources: [], evaluate }), /at least one source/);
});

test('POST /webhook/<name> answers in the order the contract says', async () => {
  const { runtime } = await startedWiring();
  const body = JSON.stringify({ type: 'ticket.created', id: 't-1', subject: 'please refund my invoice' });

  // No such source, before anything else.
  assert.equal((await runtime.accept('/webhook/nope', signed(body), body)).status, 404);
  // A bad signature, before the body is parsed.
  const bad = await runtime.accept('/webhook/tickets', { ...signed(body), 'webhook-signature': 'v1,wrong' }, body);
  assert.equal(bad.status, 401);
  assert.equal(bad.body.kind, 'signature');
  // A stale timestamp is the same answer.
  assert.equal((await runtime.accept('/webhook/tickets', signed(body, { at: now() - 4000 }), body)).status, 401);
  // A body that is not JSON.
  const notJson = 'nonsense';
  assert.equal((await runtime.accept('/webhook/tickets', signed(notJson), notJson)).status, 400);
  // A sync answer, for a challenge that needs no queue.
  const challenge = JSON.stringify({ type: 'url_verification', challenge: 'abc' });
  assert.deepEqual(await runtime.accept('/webhook/tickets', signed(challenge), challenge), { status: 200, body: { challenge: 'abc' } });
  // An adapter that says nothing.
  const other = JSON.stringify({ type: 'ticket.updated', id: 't-9' });
  assert.deepEqual((await runtime.accept('/webhook/tickets', signed(other), other)).body, { ignored: true, id: 'msg_1' });
  // Accepted: written to the queue, then marked seen, then answered.
  const accepted = await runtime.accept('/webhook/tickets', signed(body, { id: 'msg_2' }), body);
  assert.deepEqual(accepted, { status: 202, body: { accepted: true, id: 'msg_2', events: 1 } });
  // The same delivery again is a duplicate, and is not queued twice.
  assert.deepEqual((await runtime.accept('/webhook/tickets', signed(body, { id: 'msg_2' }), body)).body, { duplicate: true, id: 'msg_2' });
  assert.deepEqual(runtime.stats, { not_found: 1, rejected: 3, ignored: 1, accepted: 1, duplicate: 1 });
});

test('an adapter that raises is a 500, and the sender can retry it later', async () => {
  const spool = await mkdtemp(join(tmpdir(), 'jev-wiring-'));
  const wiring = jevWiring({
    spool, evaluate,
    sources: [webhookSource('tickets', {
      verify: standardWebhooksVerifier(secret),
      event: () => { throw new Error('the adapter is broken'); },
    })],
  });
  const runtime = await startWiring(wiring, ticket, { now, startWorkers: false });
  const body = JSON.stringify({ type: 'ticket.created', id: 't-1' });
  const answer = await runtime.accept('/webhook/tickets', signed(body), body);
  assert.equal(answer.status, 500);
  assert.equal(answer.body.kind, 'adapter');
  assert.match(answer.body.error, /the event adapter for source 'tickets' raised: the adapter is broken/);
  // Nothing was marked seen, so a retry is not a duplicate.
  assert.equal((await runtime.accept('/webhook/tickets', signed(body), body)).status, 500);
  // An adapter that returns the wrong kind of thing is the same 500.
  const odd = jevWiring({ spool, evaluate, sources: [webhookSource('tickets', { verify: standardWebhooksVerifier(secret), event: () => 'nonsense' })] });
  const other = await startWiring(odd, ticket, { now, startWorkers: false });
  assert.match((await other.accept('/webhook/tickets', signed(body), body)).body.error, /not a case event/);
});

test('a case is decided, recorded, harvested and dispatched, and its outcome labels it', async () => {
  const queued = [];
  const dispatcher = makeDispatcher({
    'billing-queue': (state, d) => { queued.push([state.ticket, d.target]); return 'queued'; },
    'engineering-oncall': () => 'ok', 'sales-inbox': () => 'ok', 'retention-oncall': () => 'ok', 'human-triage': () => 'ok',
  }, { policy: ticket });
  const { spool, runtime } = await startedWiring({ dispatcher });
  const created = JSON.stringify({ type: 'ticket.created', id: 't-1', subject: 'please refund my invoice' });
  await runtime.accept('/webhook/tickets', signed(created, { id: 'd-1' }), created);
  await runtime.drain();
  assert.equal(runtime.stats.decided, 1);
  // ticket-router's one state field is the whole input, so that is what a
  // handler sees: the built, redacted state, never the raw body.
  assert.deepEqual(queued, [[{ ticket: 'please refund my invoice' }, 'billing-queue']]);
  // The queue is empty, the fixture is written, and the case is pending.
  assert.deepEqual(await readdir(join(spool, 'queue')), []);
  assert.deepEqual(await readdir(join(spool, 'fixtures')), ['t-1.json']);
  assert.equal((await harvestFind(join(spool, 'harvest'), 't-1')).where, 'pending');
  // The dispatch log holds one line per case.
  const dispatched = (await readFile(join(spool, 'dispatch.jsonl'), 'utf8')).trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(dispatched.map(l => [l.case_id, l.source, l.status, l.handler]), [['t-1', 'tickets', 'ran', 'billing-queue']]);
  assert.match(runtime.lines.join('\n'), /webhook tickets t-1: assign billing-queue, dispatched \(ran\), recorded t-1.json, pending/);

  // A closing outcome labels the case it names.
  const closed = JSON.stringify({ type: 'ticket.closed', id: 't-1', labels: { department: 'billing' } });
  await runtime.accept('/webhook/tickets', signed(closed, { id: 'd-2' }), closed);
  await runtime.drain();
  const found = await harvestFind(join(spool, 'harvest'), 't-1');
  assert.equal(found.where, 'labeled');
  assert.deepEqual(found.record.label, { action: 'assign', target: 'billing-queue' });
  assert.equal(found.record.label_strength, 'strong');
  assert.deepEqual(found.record.labels, { department: 'billing' });
  // An outcome for a case nobody decided is reported, not invented.
  const orphan = JSON.stringify({ type: 'ticket.closed', id: 'never-seen' });
  await runtime.accept('/webhook/tickets', signed(orphan, { id: 'd-3' }), orphan);
  await runtime.drain();
  assert.match(runtime.lines.join('\n'), /never-seen: close ignored: no decided case with this id/);
  const status = await harvestStatus(join(spool, 'harvest'), { now });
  assert.deepEqual([status.pending, status.labeled, status.strong], [0, 1, 0 + 1]);
});

test('a case that fails goes to failed/ with its error, and can be put back', async () => {
  const spool = await mkdtemp(join(tmpdir(), 'jev-wiring-'));
  let attempts = 0;
  const wiring = jevWiring({
    spool, sources: [ticketSource()],
    evaluate: async input => {
      attempts += 1;
      if (attempts === 1) throw new Error('jev: the provider is down');
      return evaluate(input);
    },
    harvest: join(spool, 'harvest'),
  });
  const runtime = await startWiring(wiring, ticket, { now, startWorkers: false });
  const body = JSON.stringify({ type: 'ticket.created', id: 't-7', subject: 'refund' });
  await runtime.accept('/webhook/tickets', signed(body, { id: 'd-7' }), body);
  await runtime.drain();
  assert.equal(runtime.stats.failed, 1);
  const failed = await readdir(join(spool, 'failed'));
  assert.equal(failed.length, 1);
  const record = JSON.parse(await readFile(join(spool, 'failed', failed[0]), 'utf8'));
  assert.match(record.error, /the provider is down/);
  assert.equal(record.event.id, 't-7');
  assert.match(runtime.lines.join('\n'), /failed, moved to failed\//);
  // Moving it back to queue/ retries it, and this time it is decided.
  await rename(join(spool, 'failed', failed[0]), join(spool, 'queue', failed[0]));
  await runtime.drain();
  assert.equal(runtime.stats.decided, 1);
  assert.equal((await harvestFind(join(spool, 'harvest'), 't-7')).where, 'pending');
});

test('one case at a time, in arrival order, and what is left in the queue is picked up on the next start', async () => {
  const spool = await mkdtemp(join(tmpdir(), 'jev-wiring-'));
  const order = [];
  let live = 0, peak = 0;
  const wiring = jevWiring({
    spool, sources: [ticketSource()], workers: 2,
    evaluate: async input => {
      live += 1; peak = Math.max(peak, live);
      order.push(input.ticket);
      await new Promise(resolve => setTimeout(resolve, 10));
      live -= 1;
      return evaluate(input);
    },
  });
  const runtime = await startWiring(wiring, ticket, { now, startWorkers: false });
  // Two events for one case, and one for another: the case's own order holds.
  for (const [i, event] of [
    { type: 'ticket.created', id: 't-1', subject: 'first' },
    { type: 'ticket.created', id: 't-1', subject: 'second' },
    { type: 'ticket.created', id: 't-2', subject: 'other' },
  ].entries()) {
    const body = JSON.stringify(event);
    await runtime.accept('/webhook/tickets', signed(body, { id: `d-${i}` }), body);
  }
  await runtime.drain();
  assert.equal(order.length, 3);
  assert.deepEqual(order.slice(0, 2).includes('other') ? 'parallel' : 'ordered', 'parallel');
  // t-1's two events never ran at once, and at most two workers ran at all.
  assert.ok(peak <= 2, `peak was ${peak}`);
  assert.deepEqual(order.filter(t => t !== 'other'), ['first', 'second']);

  // A file left in the queue by a stop is processed when workers next run.
  const body = JSON.stringify({ type: 'ticket.created', id: 't-3', subject: 'left over' });
  await runtime.accept('/webhook/tickets', signed(body, { id: 'd-9' }), body);
  await runtime.stop();
  assert.equal((await readdir(join(spool, 'queue'))).length, 1);
  const restarted = await startWiring(wiring, ticket, { now, startWorkers: false });
  await restarted.drain();
  assert.deepEqual(await readdir(join(spool, 'queue')), []);
  assert.equal(restarted.stats.decided, 1);
});

test('a shadow policy runs beside the primary and says what it would have done', async () => {
  const spool = await mkdtemp(join(tmpdir(), 'jev-wiring-'));
  // The same questions, so the shadow reuses the primary's answers at no cost.
  const shadow = (await import('../examples/ticket-router.mjs')).policy;
  const changed = (await import('../src/index.mjs')).compile({
    ...shadow.toJSON(),
    route: { ...shadow.toJSON().route, clauses: shadow.toJSON().route.clauses.map(c => (c.decision.target === 'billing-queue' ? { ...c, decision: { ...c.decision, target: 'payments-queue' } } : c)) },
  });
  const wiring = jevWiring({ spool, sources: [ticketSource()], evaluate, shadow: changed });
  const runtime = await startWiring(wiring, ticket, { now, startWorkers: false });
  const body = JSON.stringify({ type: 'ticket.created', id: 't-1', subject: 'please refund my invoice' });
  await runtime.accept('/webhook/tickets', signed(body, { id: 'd-1' }), body);
  await runtime.drain();
  const lines = (await readFile(join(spool, 'shadow.jsonl'), 'utf8')).trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(lines.map(l => [l.case_id, l.mode, l.changed, l.primary.target, l.shadow.target]),
    [['t-1', 'same-answers', true, 'billing-queue', 'payments-queue']]);
  assert.match(runtime.lines.join('\n'), /shadow says assign payments-queue/);
});

test('maintenance forgets old delivery markers and settles pending cases', async () => {
  const { spool, runtime } = await startedWiring({ settleAfterDays: 1 });
  const body = JSON.stringify({ type: 'ticket.created', id: 't-1', subject: 'refund' });
  await runtime.accept('/webhook/tickets', signed(body, { id: 'd-1' }), body);
  await runtime.drain();
  assert.equal((await readdir(join(spool, 'seen', 'tickets'))).length, 1);
  // A week on, the marker is gone and the pending case has settled weakly.
  const later = await startWiring(
    jevWiring({ spool, sources: [ticketSource()], evaluate, harvest: join(spool, 'harvest'), settleAfterDays: 1 }),
    ticket, { now: () => now() + 8 * 86400, startWorkers: false });
  await later.maintain();
  assert.deepEqual(await readdir(join(spool, 'seen', 'tickets')), []);
  const found = await harvestFind(join(spool, 'harvest'), 't-1');
  assert.equal(found.where, 'labeled');
  assert.equal(found.record.label_strength, 'weak');
  assert.match(later.lines.join('\n'), /1 pending case timed out after 1 days/);
});

test('a source can be a different scheme, and the summary says what runs', async () => {
  const spool = await mkdtemp(join(tmpdir(), 'jev-wiring-'));
  const wiring = jevWiring({
    spool, evaluate, workers: 3,
    sources: [webhookSource('github', { verify: githubVerifier('gh-secret'), event: json => caseEvent(json.number, { ticket: json.title }) })],
  });
  const runtime = await startWiring(wiring, ticket, { now, startWorkers: false });
  assert.deepEqual(runtime.summary.slice(1), [
    'sources github',
    'no handlers: decisions are recorded, not dispatched',
    'not recording fixtures',
    'no harvest store',
    'no shadow policy',
    '3 workers',
  ]);
  const body = JSON.stringify({ number: 42, title: 'a bug' });
  const { createHmac } = await import('node:crypto');
  const headers = { 'x-hub-signature-256': `sha256=${createHmac('sha256', 'gh-secret').update(body).digest('hex')}`, 'x-github-delivery': 'gh-1' };
  assert.deepEqual((await runtime.accept('/webhook/github', headers, body)).body, { accepted: true, id: 'gh-1', events: 1 });
  await runtime.drain();
  assert.equal(runtime.stats.decided, 1);
});
