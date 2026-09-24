import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseLabelSpec, escalatedDecision, escalationDecision, deriveLabel, harvestAdd, harvestOutcome, harvestSettle, harvestStatus, harvestFind, harvestDirs } from '../src/harvest.js';
import { fixtureFromRun } from '../src/evaluate.js';
import { replay, tune } from '../src/fixtures.js';
import { policy as ticket } from '../examples/ticket-router.js';

const answers = {
  department: { type: 'choice', choice: 'billing', confidence: 0.93, probabilities: { billing: 0.93 } },
  frustration: { type: 'score', score: 0.2, confidence: 0.9, probabilities: { 0: 0.8, 1: 0.2, 2: 0 } },
  'refund-requested?': { type: 'noul', noul: 0.1 },
};
// What a real run leaves behind: a version 3 fixture and the decision it made.
const decidedCase = () => {
  const input = { ticket: 'please refund my invoice' };
  const { state, facts } = ticket.buildState(input);
  const questions = ticket.questions(state);
  const decision = ticket.decide(answers, { facts, state });
  const result = {
    output: answers, model: 'jev-1.13.0', usage: { input_tokens: 10 }, requestId: null,
    target: { provider: { id: 'typesafe' }, model: 'jev-1.13.0', requestedEffort: null, effectiveEffort: null },
  };
  return { decision, fixture: fixtureFromRun({ name: 'case', policy: ticket, state, questions, decision, result }) };
};
const fixed = () => 1_800_000_000;

test('the settle rules hold over a whole history, whatever order things arrived in', async () => {
  const cases = JSON.parse(await readFile(new URL('./parity/harvest-cases.json', import.meta.url), 'utf8'));
  assert.deepEqual(cases.histories.map(h => deriveLabel({ ...h, expect: h.expect ?? undefined })), [
    { where: 'pending', label: null, strength: null, source: null },
    { where: 'labeled', label: { action: 'assign', target: 'q' }, strength: 'strong', source: 'close' },
    { where: 'unlabeled', label: null, strength: null, source: 'close' },
    { where: 'labeled', label: { action: 'page', target: 'oncall' }, strength: 'strong', source: 'close' },
    // A close after a correction keeps the correction's label.
    { where: 'labeled', label: { action: 'assign', target: 'other' }, strength: 'strong', source: 'correction' },
    // The last correction wins.
    { where: 'labeled', label: { action: 'assign', target: 'second' }, strength: 'strong', source: 'correction' },
    // Silence is a weak label; an escalation leaves nothing known.
    { where: 'labeled', label: { action: 'assign', target: 'q' }, strength: 'weak', source: 'timeout' },
    { where: 'unlabeled', label: null, strength: null, source: 'timeout' },
    { where: 'unlabeled', label: null, strength: null, source: 'close' },
  ]);
  // A gate or band that fired is an escalation, whatever the action says.
  assert.equal(escalationDecision({ action: 'assign', target: 'q', rule: 'gate' }), true);
  assert.equal(escalatedDecision({ action: 'assign', target: 'q', rule: 'band' }), true);
  assert.equal(escalatedDecision({ action: 'assign', target: 'q', rule: 'route' }), false);
});

test('a harvested store replays and tunes, and a settled case is left alone', async () => {
  const store = await mkdtemp(join(tmpdir(), 'jev-harvest-'));
  const { decision, fixture } = decidedCase();
  await harvestAdd(store, { caseId: 'c-1', fixture, decision, now: fixed });
  await harvestAdd(store, { caseId: 'c-2', fixture, decision, now: fixed });
  await harvestOutcome(store, 'c-1', 'close', { now: fixed });
  await harvestOutcome(store, 'c-2', 'correction', { label: 'page:retention-oncall', now: fixed });
  // labeled/ holds fixtures, so replay and tune read the store directly.
  const [labeled] = harvestDirs(store).filter(d => d.endsWith('labeled'));
  const files = (await readdir(labeled)).filter(f => f.endsWith('.json'));
  assert.equal(files.length, 2);
  const fixtures = await Promise.all(files.map(async f => JSON.parse(await readFile(join(labeled, f), 'utf8'))));
  assert.deepEqual(replay(ticket, fixtures).map(r => r.status), ['pass', 'pass']);
  const report = tune(ticket, fixtures, { department: [0.8, 0.95] });
  // One case was corrected, so the policy agrees with one of the two labels.
  assert.equal(report.results[0].total, 2);
  assert.equal(report.results[0].correct, 1);
  assert.ok(report.warnings.some(w => /Fewer than 200 labels/.test(w)));

  // A case that is already settled is left alone, and says so.
  const again = await harvestAdd(store, { caseId: 'c-1', fixture, decision, now: fixed });
  assert.equal(again.status, 'settled');
  assert.equal(again.where, 'labeled');
  // An outcome for a case nobody decided is reported, not invented.
  const unknown = await harvestOutcome(store, 'never-seen', 'close', { now: fixed });
  assert.deepEqual([unknown.status, unknown.where, unknown.path], ['unknown', null, null]);
  // A correction needs the label the person chose.
  await assert.rejects(harvestOutcome(store, 'c-1', 'correction', { now: fixed }), /needs the label/);
  await assert.rejects(harvestOutcome(store, 'c-1', 'nonsense', { now: fixed }), /'correction' or 'close'/);
  // A second copy of one case, from a crash, is reconciled by the longer history.
  const found = await harvestFind(store, 'c-1');
  assert.equal(found.where, 'labeled');
  assert.equal(found.record.case_id, 'c-1');
});

test('a settle only touches what is due, and a dry run writes nothing', async () => {
  const store = await mkdtemp(join(tmpdir(), 'jev-harvest-'));
  const { decision, fixture } = decidedCase();
  await harvestAdd(store, { caseId: 'old', fixture, decision, now: () => 1_000_000 });
  await harvestAdd(store, { caseId: 'fresh', fixture, decision, now: () => 2_000_000 });
  const dry = await harvestSettle(store, { after: 86_400, now: () => 2_000_100, dryRun: true });
  assert.deepEqual(dry.settled.map(r => [r.caseId, r.where, r.strength]), [['old', 'labeled', 'weak']]);
  // Nothing moved: the case is still pending.
  assert.equal((await harvestFind(store, 'old')).where, 'pending');
  const real = await harvestSettle(store, { after: 86_400, now: () => 2_000_100 });
  assert.deepEqual(real.settled.map(r => [r.caseId, r.where, r.source]), [['old', 'labeled', 'timeout']]);
  assert.equal((await harvestFind(store, 'old')).where, 'labeled');
  assert.equal((await harvestFind(store, 'fresh')).where, 'pending');
  const status = await harvestStatus(store, { after: 86_400, now: () => 2_000_100 });
  assert.deepEqual([status.pending, status.pending_due, status.labeled, status.weak, status.strong],
    [1, 0, 1, 1, 0]);
  assert.deepEqual(status.labeled_by_source, { timeout: 1 });
  assert.equal(status.oldest_pending_seconds, 100);
});
