import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { evaluateWithProvider, typesafeProvider } from '../src/evaluate.js';
import { settings as client } from '../src/client.js';
import { ProviderRegistry, mergeProviderConfig, clearProviderDiscoveryCache } from '../src/provider/index.js';
import { dbAnswerCache } from '../src/store.js';
import { assign, definePolicy, eq, fact, rule } from '../src/index.js';
import { policy as ticket } from '../examples/ticket-router.js';
import { policy as alignment } from '../examples/entity-alignment.js';

const answers = {
  department: { type: 'choice', choice: 'billing', confidence: 0.93 },
  frustration: { type: 'score', score: 0, confidence: 0.9 },
  'refund-requested?': { type: 'noul', noul: 0.2 },
};
const restore = () => {
  client.transport = null;
  client.sleep = seconds => new Promise(r => setTimeout(r, Math.min(seconds, 0.01) * 1000));
  client.environment = name => ({ TYPESAFE_API_KEY: 'test-key' })[name];
};
const setup = t => {
  restore();
  t.after(restore);
  const asked = [];
  client.transport = async request => {
    asked.push(request);
    if (JSON.stringify(request.state).includes('boom')) throw Object.assign(new Error('bad request'), { status: 400 });
    return { answers, model: 'jev-1.13.0', request_id: `r${asked.length}` };
  };
  const registry = new ProviderRegistry();
  registry.register(typesafeProvider());
  clearProviderDiscoveryCache(registry);
  return { asked, registry, config: mergeProviderConfig({ project: { provider: 'typesafe' } }) };
};
const sqlite = () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-answers-'));
  const db = new DatabaseSync(join(dir, 'answers.sqlite'));
  const driver = {
    query(text, params = []) {
      const statement = db.prepare(text);
      return /^\s*SELECT/i.test(text) ? statement.all(...params) : (statement.run(...params), []);
    },
  };
  return { driver, done: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
};

test('dbAnswerCache: a re-run asks only for new inputs and decides the same', async t => {
  const { asked, registry, config } = setup(t);
  const { driver, done } = sqlite();
  t.after(done);
  const run = async rows => {
    const cache = await dbAnswerCache(driver, { dialect: 'sqlite', scope: 'tickets' });
    const decisions = [];
    for (const text of rows) {
      try { decisions.push(await evaluateWithProvider(ticket, { ticket: text }, { config, registry, cache })); } catch { decisions.push(null); }
    }
    return { decisions, flushed: await cache.flush({ prune: true }) };
  };

  const first = await run(['refund please', 'my card failed', 'refund please', 'boom']);
  assert.equal(asked.length, 3); // the repeat shares one call; the failure is asked and dropped
  assert.deepEqual(first.flushed, { saved: 2, pruned: 0 });

  const second = await run(['refund please', 'my card failed']);
  assert.equal(asked.length, 3); // nothing new asked
  assert.deepEqual(second.decisions.map(d => [d.target, d.cached, d.provider, d.model]), [
    ['billing-queue', true, 'typesafe', 'jev-1.13.0'],
    ['billing-queue', true, 'typesafe', 'jev-1.13.0'],
  ]);
  assert.equal(second.decisions[0].request_id, first.decisions[0].request_id);

  const third = await run(['my card failed']); // 'refund please' wasn't touched: pruned
  assert.deepEqual(third.flushed, { saved: 0, pruned: 1 });
  assert.equal((await dbAnswerCache(driver, { dialect: 'sqlite', scope: 'tickets' })).size, 1);
  assert.equal((await dbAnswerCache(driver, { dialect: 'sqlite', scope: 'other' })).size, 0);
});

test('cacheOnly decides from the cache, or throws uncached without asking', async t => {
  const { asked, registry, config } = setup(t);
  const cache = new Map();
  await evaluateWithProvider(ticket, { ticket: 'refund please' }, { config, registry, cache });
  assert.equal(asked.length, 1);

  const hit = await evaluateWithProvider(ticket, { ticket: 'refund please' }, { config, registry, cache, cacheOnly: true });
  assert.equal(hit.cached, true);
  await assert.rejects(
    evaluateWithProvider(ticket, { ticket: 'something new' }, { config, registry, cache, cacheOnly: true }),
    error => error.code === 'uncached',
  );
  assert.equal(asked.length, 1);
  await assert.rejects(evaluateWithProvider(ticket, { ticket: 'x' }, { cacheOnly: true }), /cacheOnly needs a cache/);

  // A precheck still decides with nothing cached.
  const gated = definePolicy({
    ...ticket.toJSON(), questions: ticket.policy.questions,
    state: { ticket: { path: ['ticket'] }, vip: { path: ['vip'], local: true, default: false } },
    prechecks: [rule(eq(fact('vip'), true), assign('vip-desk'))],
  });
  assert.equal((await evaluateWithProvider(gated, { ticket: 'hi', vip: true }, { cache: new Map(), cacheOnly: true })).target, 'vip-desk');
});

test('entity-alignment: an unsure "same" goes to the curator instead of merging', () => {
  const answer = (score, confidence) => ({
    link: { score, confidence, probabilities: { 0: (1 - confidence) / 2, 1: (1 - confidence) / 2, 2: confidence } },
    'same-name?': { noul: 0.5 },
    'same-brewery?': { noul: 0.5 },
  });
  assert.equal(alignment.decide(answer(1.53, 0.3)).target, 'curator');
  assert.equal(alignment.decide(answer(2, 0.9)).target, 'merge');
  assert.equal(alignment.decide(answer(0, 0.9)).target, 'leave-unlinked');
});
