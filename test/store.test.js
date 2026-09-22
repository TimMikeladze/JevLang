import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memoryStore, ndjsonStore, dbStore, sqliteStore, recordOf, isStore, withStore } from '../src/store.js';
import { definePolicy, assign, summarize, literal } from '../src/index.js';
import { makeDispatcher } from '../src/dispatch.js';
import { makeLoop, makeEvent, loopStart, loopPost, loopStop } from '../src/loop.js';

const policy = definePolicy({
  name: 'store-test',
  questions: {},
  route: { clauses: [{ when: literal(true), decision: assign('done') }], otherwise: assign('other') },
});

test('a record gets a fingerprint id and stays plain JSON', () => {
  const decision = policy.decide({});
  const record = recordOf({ policy: 'p', input: { a: 1 }, answers: null, decision });
  assert.match(record.id, /^[0-9a-f]{64}$/);
  assert.equal(recordOf({ policy: 'p', input: { a: 1 }, answers: null, decision }).id, record.id);
  assert.ok(JSON.parse(JSON.stringify(record)));
});

test('a record without a decision is refused', () => {
  assert.throws(() => recordOf({ input: {} }), /decision/);
});

test('memory store: append is idempotent, list filters and caps', () => {
  const store = memoryStore();
  const decision = policy.decide({});
  const id = store.append({ policy: 'a', input: 1, decision, at: 1000 });
  assert.equal(store.append({ policy: 'a', input: 1, decision }), id);
  store.append({ policy: 'a', input: 2, decision, at: 2000 });
  store.append({ policy: 'b', input: 3, decision, at: 3000 });
  assert.equal(store.list({ policy: 'a' }).length, 2);
  assert.equal(store.list({ policy: 'a', since: 1500 }).length, 1);
  assert.equal(store.list({ limit: 2 }).length, 2);
  assert.equal(store.list({ limit: 2 })[0].input, 2); // the most recent two, oldest first
  assert.deepEqual(store.get(id).decision, decision);
  assert.equal(store.get('missing'), null);
  assert.ok(isStore(store) && !isStore({}));
});

test('store decisions feed summarize directly', () => {
  const store = memoryStore();
  store.append({ policy: 'p', input: 1, decision: policy.decide({}) });
  store.append({ policy: 'p', input: 2, decision: policy.decide({}) });
  const summary = summarize(store.list().map(r => r.decision));
  assert.equal(summary.total, 2);
  assert.equal(summary.actions.assign, 2);
});

const dir = mkdtempSync(join(tmpdir(), 'jev-store-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));

test('ndjson store: one record per line, survives reopen', () => {
  const path = join(dir, 'decisions.ndjson');
  const store = ndjsonStore(path);
  const decision = policy.decide({});
  const id = store.append({ policy: 'p', input: { x: 1 }, decision });
  assert.equal(store.append({ policy: 'p', input: { x: 1 }, decision }), id); // not written twice
  const reopened = ndjsonStore(path);
  assert.equal(reopened.list().length, 1);
  assert.deepEqual(reopened.get(id).decision, decision);
  assert.throws(() => ndjsonStore(''), /path/);
});

test('db store over sqlite: round trip, filters, idempotency', async () => {
  const path = join(dir, 'decisions.sqlite');
  const store = await sqliteStore(path);
  const decision = policy.decide({});
  const id = await store.append({ policy: 'a', input: { q: 'help' }, answers: { tier: 'paid' }, decision, key: 'k1' });
  assert.equal(await store.append({ policy: 'a', input: { q: 'help' }, answers: { tier: 'paid' }, decision, key: 'k1' }), id);
  await store.append({ policy: 'b', input: { q: 'no' }, decision, at: 123 });
  const got = await store.get(id);
  assert.deepEqual(got.decision, decision);
  assert.deepEqual(got.answers, { tier: 'paid' });
  assert.equal(got.key, 'k1');
  assert.equal((await store.list({ policy: 'a' })).length, 1);
  assert.equal((await store.list({ since: 124 })).length, 1);
  assert.equal((await store.list())[0].at, 123); // oldest first
  assert.equal(await store.get('missing'), null);
  await store.close();
  // Same file reopened keeps its rows.
  const again = await sqliteStore(path);
  assert.equal((await again.list()).length, 2);
  await again.close();
});

test('db store takes any sql driver', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const database = new DatabaseSync(join(dir, 'raw-driver.sqlite'));
  const driver = {
    query(text, params = []) {
      const statement = database.prepare(text);
      return /^\s*(SELECT|.*RETURNING)/is.test(text) ? statement.all(...params) : (statement.run(...params), []);
    },
    close() { database.close(); },
  };
  const store = dbStore(driver, { dialect: 'sqlite', prefix: 'custom_' });
  const id = await store.append({ policy: 'p', input: 1, decision: policy.decide({}) });
  assert.equal((await store.list({ policy: 'p' }))[0].id, id);
  await store.close();
});

test('withStore records and passes the decision through unchanged', async () => {
  const store = memoryStore();
  const evaluate = async input => policy.decide({});
  const wrapped = withStore(evaluate, store, { policy: 'p' });
  const decision = await wrapped({ a: 1 });
  assert.equal(decision.action, 'assign');
  const records = store.list();
  assert.equal(records.length, 1);
  assert.deepEqual(records[0].decision, decision);
  assert.throws(() => withStore(null, store), /evaluate/);
  assert.throws(() => withStore(evaluate, {}), /store/);
});

test('a null decision is not recorded', async () => {
  const store = memoryStore();
  const wrapped = withStore(async () => null, store);
  assert.equal(await wrapped({}), null);
  assert.equal(store.list().length, 0);
});

test('makeLoop with a store records every event', async () => {
  const store = memoryStore();
  const seen = [];
  const dispatcher = makeDispatcher({ done: () => 'ok', other: () => 'ok' });
  const loop = makeLoop({
    evaluate: input => policy.decide({}),
    dispatcher,
    store,
    onOutcome: (event, result) => seen.push([event, result]),
  });
  loopStart(loop);
  loopPost(loop, makeEvent('first', { key: 'one' }));
  loopPost(loop, makeEvent('second', { key: 'two' }));
  await loopStop(loop);
  assert.equal(seen.length, 2);
  const records = store.list();
  assert.equal(records.length, 2);
  assert.deepEqual(records.map(r => r.input), ['first', 'second']);
  assert.ok(records.every(r => r.decision.action === 'assign'));
});
