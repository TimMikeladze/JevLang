import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { memoryJournal } from '../src/journal.js';
import { sqliteJournal } from '../src/journal-db.js';
import { skipUnlessInMonorepo } from './monorepo.js';

const opsPath = new URL('./parity/journal-ops.json', import.meta.url);
async function runOps(journal, ops) {
  const out = [];
  for (const [op, args] of ops) {
    const value = await journal[op](...args);
    out.push(value === undefined ? null : value);
  }
  return out;
}

test('Racket oracle: the in-memory and SQLite journals answer the same script', async t => {
  if (skipUnlessInMonorepo(t)) return;
  const ops = JSON.parse(await readFile(opsPath, 'utf8'));
  const dir = await mkdtemp(join(tmpdir(), 'jev-journal-'));
  const oracle = fileURLToPath(new URL('./journal-oracle.rkt', import.meta.url));
  const run = spawnSync('racket', [oracle, join(dir, 'racket.sqlite')], { encoding: 'utf8', env: { ...process.env, TYPESAFE_API_KEY: '', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '' } });
  assert.equal(run.status, 0, run.stderr);
  const expected = JSON.parse(run.stdout);
  assert.deepEqual(expected.memory, expected.sqlite, 'the Racket backends agree with each other');
  assert.deepEqual(await runOps(memoryJournal(), ops), expected.memory);
  const durable = await sqliteJournal(join(dir, 'portable.sqlite'));
  assert.deepEqual(await runOps(durable, ops), expected.sqlite);
  await durable.close();
});

test('a shared SQLite journal gives one claim to one process, and survives reopening', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jev-journal-'));
  const path = join(dir, 'shared.sqlite');
  const first = await sqliteJournal(path);
  const second = await sqliteJournal(path);
  // Two dispatchers, one key: exactly one runs it.
  assert.equal(await first.beginStep('act/1', 'unlock-door', 1000), 'new');
  assert.equal(await second.beginStep('act/1', 'unlock-door', 1001), 'running');
  await first.finishStep('act/1', 'ran', { unlocked: true }, 1100);
  assert.deepEqual(await second.beginStep('act/1', 'unlock-door', 1200), { status: 'ran', result: { unlocked: true } });
  // One cooldown, one winner.
  assert.equal(await first.claimCooldown('unlock-door', 2000, 30000), true);
  assert.equal(await second.claimCooldown('unlock-door', 2100, 30000), false);
  // One budget, spent once.
  assert.equal(await first.claimBudget('spend', 3000, 86400000, 8, 10), true);
  assert.equal(await second.claimBudget('spend', 3100, 86400000, 8, 10), false);
  await first.schedule('later/1', 5000, { decision: { action: 'act', target: 'lights-off' } });
  await first.close();
  await second.close();

  // Reopened, the scheduled work and the claims are still there.
  const reopened = await sqliteJournal(path);
  assert.equal(await reopened.nextDue(), 5000);
  assert.deepEqual(await reopened.takeDue(5000), [['later/1', { decision: { action: 'act', target: 'lights-off' } }]]);
  assert.equal(await reopened.coolingDown('unlock-door', 2200, 30000), true);
  assert.deepEqual(await reopened.beginStep('act/1', 'unlock-door', 9000), { status: 'ran', result: { unlocked: true } });
  await reopened.close();
});

test('concurrent claims on one journal hand the budget to exactly as many as fit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jev-journal-'));
  const path = join(dir, 'race.sqlite');
  const journals = await Promise.all(Array.from({ length: 6 }, () => sqliteJournal(path)));
  const claims = await Promise.all(journals.map(j => j.claimBudget('calls', 1000, 60000, 1, 3)));
  assert.equal(claims.filter(Boolean).length, 3);
  const steps = await Promise.all(journals.map(j => j.beginStep('one/step', 'act', 1000)));
  assert.equal(steps.filter(s => s === 'new').length, 1);
  await Promise.all(journals.map(j => j.close()));
});
