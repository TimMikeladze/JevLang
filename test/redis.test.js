import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memoryJournal } from '../src/journal.js';
import { sqliteJournal } from '../src/journal-db.js';
import { memoryStore } from '../src/store.js';
import { upstash, redisJournal, redisStore, redisSessions } from '../src/redis.js';
import { makeDispatcher, dispatch, rateLimit, budget, runDue } from '../src/dispatch.js';
import { makeSessions, sessionMessage, sessionPending } from '../src/session.js';

// The Redis half runs against any Upstash-compatible REST endpoint, e.g.
//   docker run -p 8089:80 -e SRH_MODE=env -e SRH_TOKEN=t -e SRH_CONNECTION_STRING=redis://... hiett/serverless-redis-http
//   JEV_TEST_UPSTASH_URL=http://localhost:8089 JEV_TEST_UPSTASH_TOKEN=t bun test test/redis.test.js
const url = process.env.JEV_TEST_UPSTASH_URL, token = process.env.JEV_TEST_UPSTASH_TOKEN;
const skipRedis = t => { if (!url) t.skip('set JEV_TEST_UPSTASH_URL to run against Redis'); return !url; };
const prefix = () => `jevtest:${Date.now()}:${Math.random().toString(36).slice(2)}:`;
const client = () => upstash({ url, token });

async function runOps(journal, ops) {
  const out = [];
  for (const [op, args] of ops) {
    const value = await journal[op](...args);
    out.push(value === undefined ? null : value);
  }
  return out;
}
const ops = async () => JSON.parse(await readFile(new URL('./parity/journal-ops.json', import.meta.url), 'utf8'));

test('the Redis journal answers the shared journal script exactly as memory and SQLite do', async t => {
  if (skipRedis(t)) return;
  const script = await ops();
  const expected = await runOps(memoryJournal(), script);
  const sqlite = await sqliteJournal(join(await mkdtemp(join(tmpdir(), 'jev-redis-')), 'j.sqlite'));
  assert.deepEqual(await runOps(sqlite, script), expected);
  assert.deepEqual(await runOps(redisJournal(client(), { prefix: prefix() }), script), expected);
});

test('concurrent budget claims on Redis hand out exactly as many as fit', async t => {
  if (skipRedis(t)) return;
  const shared = redisJournal(client(), { prefix: 'race:' + prefix() });
  const wins = await Promise.all(Array.from({ length: 20 }, () => shared.claimBudget('calls', 1000, 60_000, 1, 5)));
  assert.equal(wins.filter(Boolean).length, 5);
});

for (const [name, make] of [
  ['memory', async () => memoryJournal()],
  ['sqlite', async () => sqliteJournal(join(await mkdtemp(join(tmpdir(), 'jev-lease-')), 'j.sqlite'))],
  ['redis', async () => redisJournal(client(), { prefix: prefix() })],
]) {
  test(`${name}: a stale running step is taken over after its lease, a fresh one is not`, async t => {
    if (name === 'redis' && skipRedis(t)) return;
    const j = await make();
    assert.equal(await j.beginStep('k', 'x', 1000), 'new');
    assert.equal(await j.beginStep('k', 'x', 1500, 1000), 'running');
    assert.equal(await j.beginStep('k', 'x', 2000, 1000), 'new');
    await j.finishStep('k', 'ran', { ok: true }, 2100);
    assert.deepEqual(await j.beginStep('k', 'x', 9000, 1000), { status: 'ran', result: { ok: true } });
  });

  test(`${name}: a leased takeDue re-delivers until cancelled`, async t => {
    if (name === 'redis' && skipRedis(t)) return;
    const j = await make();
    await j.schedule('a', 100, { n: 1 });
    assert.deepEqual(await j.takeDue(200, 1000), [['a', { n: 1 }]]);
    assert.deepEqual(await j.takeDue(300, 1000), [], 'leased, not due again yet');
    assert.equal(await j.nextDue(), 1200);
    assert.deepEqual(await j.takeDue(1300, 1000), [['a', { n: 1 }]], 'the lease ran out: delivered again');
    assert.equal(await j.cancel('a'), true);
    assert.equal(await j.nextDue(), null);
  });

  test(`${name}: rateLimit allows max per window per key`, async t => {
    if (name === 'redis' && skipRedis(t)) return;
    let now = 10_000;
    const take = rateLimit(await make(), 'api', { max: 2, per: 60, clock: () => now });
    assert.deepEqual([(await take('a')).ok, (await take('a')).ok, (await take('a')).ok, (await take('b')).ok], [true, true, false, true]);
    now += 60_001;
    assert.equal((await take('a')).ok, true, 'the window slid past');
  });
}

test('budget({ by }) limits each key on its own', async () => {
  const d = makeDispatcher({ refund: () => 'ok' }, { allowExtra: true, clock: () => 1000,
    budgets: [budget('refunds', { max: 1, per: 3600, by: dec => dec.params.customer })] });
  const act = customer => ({ action: 'act', target: 'refund', params: { customer } });
  assert.equal((await dispatch(d, null, act('c1'))).status, 'ran');
  assert.equal((await dispatch(d, null, act('c1'))).status, 'over-budget');
  assert.equal((await dispatch(d, null, act('c2'))).status, 'ran');
});

test('runDue with a scheduleLease removes an item only after it ran', async () => {
  const journal = memoryJournal();
  const ran = [];
  const d = makeDispatcher({ ping: () => { ran.push('ping'); return 'pong'; } }, { allowExtra: true, journal, clock: () => 5000, autoRunDue: false, scheduleLease: 30 });
  await journal.schedule('s1', 1000, { decision: { action: 'act', target: 'ping', params: {} } });
  assert.equal(await runDue(d), 1);
  assert.deepEqual(ran, ['ping']);
  assert.equal(await journal.nextDue(), null);
});

test('the Redis store keeps newest records per policy, dedupes, and expires by ttl', async t => {
  if (skipRedis(t)) return;
  const store = redisStore(client(), { prefix: prefix(), ttl: 1 });
  const reference = memoryStore();
  for (const [i, policy] of [[1, 'a'], [2, 'b'], [3, 'a'], [4, 'a']]) {
    const run = { policy, input: { i }, decision: { action: 'hold' }, at: i * 1000 };
    await store.append(run); reference.append(run);
  }
  await store.append({ policy: 'a', input: { i: 4 }, decision: { action: 'hold' }, at: 4000 });
  assert.deepEqual(await store.list({ policy: 'a', limit: 2 }), reference.list({ policy: 'a', limit: 2 }));
  assert.deepEqual(await store.list(), reference.list());
  const [first] = await store.list({ since: 1000, limit: 10 });
  assert.deepEqual(await store.get(first.id), first);
  await new Promise(r => setTimeout(r, 1200));
  assert.deepEqual(await store.list(), [], 'records expired');
});

test('a clarify session survives moving to another instance through a shared table', async t => {
  const table = url ? redisSessions(client(), { prefix: prefix() }) : null;
  if (skipRedis(t)) return;
  const d = makeDispatcher({}, { default: () => 'done', allowExtra: true });
  const evaluate = async input => typeof input === 'string' && input.includes('bedroom')
    ? { action: 'act', target: 'lights', params: {} }
    : { action: 'clarify', target: null, data: { question: 'Which room?' } };
  const first = makeSessions(evaluate, d, { table });
  const second = makeSessions(evaluate, d, { table });
  await sessionMessage(first, 'panel', 'lights on');
  assert.equal(await sessionPending(second, 'panel'), 'Which room?');
  const outcome = await sessionMessage(second, 'panel', 'the bedroom');
  assert.equal(outcome.final.target, 'lights');
  assert.equal(await sessionPending(first, 'panel'), null);
});
