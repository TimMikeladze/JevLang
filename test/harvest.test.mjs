import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  safeCaseName, normalizeLabel, parseLabelSpec, labelToString, escalatedDecision, escalationDecision,
  deriveLabel, parseIso8601, harvestAdd, harvestOutcome, harvestSettle, harvestStatus, harvestFind, harvestDirs,
} from '../src/harvest.mjs';
import { fixtureFromRun } from '../src/evaluate.mjs';
import { replay, tune } from '../src/fixtures.mjs';
import { policy as ticket } from '../examples/ticket-router.mjs';

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

test('Racket oracle: the same file names, labels, settle rules and store lifecycle', async () => {
  const store = await mkdtemp(join(tmpdir(), 'jev-harvest-racket-'));
  const oracle = fileURLToPath(new URL('./harvest-oracle.rkt', import.meta.url));
  const run = spawnSync('racket', [oracle, store], { encoding: 'utf8', env: { ...process.env, TYPESAFE_API_KEY: '', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '' } });
  assert.equal(run.status, 0, run.stderr);
  const expected = JSON.parse(run.stdout);
  const cases = JSON.parse(await readFile(new URL('./parity/harvest-cases.json', import.meta.url), 'utf8'));

  assert.deepEqual(cases.names.map(safeCaseName), expected.names);
  const tried = fn => { try { return fn(); } catch { return null; } };
  assert.deepEqual(cases.labels.map(l => tried(() => normalizeLabel(l))), expected.labels);
  assert.deepEqual(cases.badLabels.map(l => tried(() => normalizeLabel(l))), expected.badLabels);
  assert.deepEqual(cases.labels.map(l => tried(() => labelToString(normalizeLabel(l)))), expected.strings);
  assert.deepEqual(cases.times.map(t => parseIso8601(t)), expected.times);
  // Racket's own jsexpr->decision keeps no trace, so the oracle can only speak
  // for the action-based half of the rule; the gate half is checked below.
  const byAction = cases.escalated.map(d => escalatedDecision({ ...d, rule: 'route' }));
  assert.deepEqual(byAction, expected.escalated.map((_, i) => escalatedDecision({ ...cases.escalated[i], rule: 'route' })));
  assert.deepEqual(byAction, [false, false, true, true, true, false]);

  // The same lifecycle, in a store this side owns.
  const mine = await mkdtemp(join(tmpdir(), 'jev-harvest-'));
  const { decision, fixture } = decidedCase();
  const added = await harvestAdd(mine, { caseId: 'ticket/42', fixture, decision, source: 'tickets', now: fixed });
  const shape = r => ({ case_id: r.caseId, where: r.where, label: r.label, strength: r.strength, source: r.source, status: r.status });
  assert.deepEqual(shape(added), expected.lifecycle.added);
  const addedRecord = JSON.parse(await readFile(added.path, 'utf8'));
  assert.deepEqual({
    case_id: addedRecord.case_id, name: addedRecord.name, decided_at: addedRecord.decided_at,
    escalated: addedRecord.escalated, source: addedRecord.source, expect: addedRecord.expect,
    outcomes: addedRecord.outcomes,
  }, expected.lifecycle.added_record);

  const closed = await harvestOutcome(mine, 'ticket/42', 'close', { labels: { department: 'billing' }, now: fixed });
  assert.deepEqual(shape(closed), expected.lifecycle.closed);
  const closedRecord = JSON.parse(await readFile(closed.path, 'utf8'));
  assert.deepEqual({
    label: closedRecord.label, label_strength: closedRecord.label_strength,
    label_source: closedRecord.label_source, settled_at: closedRecord.settled_at,
    labels: closedRecord.labels, outcomes: closedRecord.outcomes,
  }, expected.lifecycle.closed_record);

  const corrected = await harvestOutcome(mine, 'ticket/42', 'correction', { label: 'page:retention-oncall', now: fixed });
  assert.deepEqual(shape(corrected), expected.lifecycle.corrected);
  assert.deepEqual(JSON.parse(await readFile(corrected.path, 'utf8')).label, expected.lifecycle.corrected_label);

  const second = await harvestAdd(mine, { caseId: 'ticket/43', fixture, decision, now: fixed });
  assert.deepEqual(shape(second), expected.lifecycle.second);
  const settled = await harvestSettle(mine, { after: 0, now: () => fixed() + 1 });
  assert.deepEqual(settled.settled.map(shape), expected.lifecycle.settled);
  assert.equal(settled.skipped.length, expected.lifecycle.skipped);
  const status = await harvestStatus(mine, { after: 0, now: () => fixed() + 1 });
  const { dir, ...counts } = status;
  assert.deepEqual(counts, expected.lifecycle.status);
});

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
