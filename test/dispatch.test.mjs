import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  makeDispatcher, dispatch, dispatchForInput, resolve, handlerChain, retry, actHandler, budget,
  runDue, cancelScheduled, stopScheduler, outcomeToJson, outcomeFailedSteps, outcomeDeclined, policyTargetsOf,
} from '../src/dispatch.mjs';
import { memoryJournal } from '../src/journal.mjs';
import { sqliteJournal } from '../src/journal-db.mjs';
import { definePolicy, choice, noul, gate, rule, assign, escalate, hold, act, confirm, plan, schedule, hold as holdDecision } from '../src/index.mjs';
import { policy as ticket } from '../examples/ticket-router.mjs';
import { policy as home } from '../examples/smart-home.mjs';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const decision = (action, target, extra = {}) => ({
  action, target, reason: null, data: null, rule: 'route', clause: 0, source: null, line: null, file: null,
  model: null, provider: null, requested_model: null, requested_effort: null, effective_effort: null,
  request_id: null, stage: null, proposed: null, evidence: [], steps: [], readings: [], ...extra,
});
const clockFrom = start => { let t = start; return { clock: () => t, advance: ms => { t += ms; } }; };

test('a dispatcher checks coverage in both directions before it runs anything', () => {
  const handlers = { 'billing-queue': () => 'ok', 'engineering-oncall': () => 'ok', 'sales-inbox': () => 'ok', 'retention-oncall': () => 'ok', 'human-triage': () => 'ok' };
  assert.deepEqual(policyTargetsOf(ticket.policy).sort(), ['billing-queue', 'engineering-oncall', 'human-triage', 'retention-oncall', 'sales-inbox']);
  makeDispatcher(handlers, { policy: ticket });
  // A target the policy can produce with no handler and no default.
  const { 'sales-inbox': _omitted, ...incomplete } = handlers;
  assert.throws(() => makeDispatcher(incomplete, { policy: ticket }), /no handler for/);
  makeDispatcher(incomplete, { policy: ticket, default: () => 'ok' });
  // A handler the policy never produces.
  assert.throws(() => makeDispatcher({ ...handlers, 'sales-inboxx': () => 'ok' }, { policy: ticket }), /never produces/);
  makeDispatcher({ ...handlers, 'sales-inboxx': () => 'ok' }, { policy: ticket, allowExtra: true });
  // A guard for a target that does not exist.
  assert.throws(() => makeDispatcher(handlers, { policy: ticket, guards: { 'sales-inboxx': () => true } }), /never produces/);
});

test('a decision is handled, passed through on purpose, or raises — never dropped', async () => {
  const seen = [];
  const d = makeDispatcher({ queue: (state, dec) => { seen.push([state, dec.target]); return 'queued'; } });
  const ran = await dispatch(d, { ticket: 'x' }, decision('assign', 'queue'));
  assert.equal(ran.status, 'ran');
  assert.equal(ran.handler, 'queue');
  assert.equal(ran.result, 'queued');
  assert.deepEqual(seen, [[{ ticket: 'x' }, 'queue']]);
  // hold with nothing registered passes through; next always does.
  assert.equal((await dispatch(d, {}, decision('hold', null))).status, 'passed');
  assert.equal((await dispatch(d, {}, decision('next', 'stage-2'))).status, 'passed');
  // an unknown target raises, and suggests the near miss
  await assert.rejects(dispatch(d, {}, decision('assign', 'queu')), error => /no handler for target 'queu'/.test(error.message) && /did you mean 'queue'/.test(error.message));
});

test('a handler that re-decides is re-dispatched, and cycles and hops are bounded', async () => {
  const d = makeDispatcher({
    triage: () => decision('assign', 'queue'),
    queue: () => 'queued',
    settled: (state, dec) => dec,
    pingpong: () => decision('assign', 'pong'),
    pong: () => decision('assign', 'pingpong'),
  }, { maxHops: 4 });
  const o = await dispatch(d, {}, decision('escalate', 'triage'));
  assert.equal(o.status, 'ran');
  assert.equal(o.handler, 'queue');
  assert.deepEqual(o.chain.map(([k]) => k), ['triage', 'queue']);
  // Returning the decision it was given is terminal, not a re-dispatch.
  assert.equal((await dispatch(d, {}, decision('assign', 'settled'))).handler, 'settled');
  await assert.rejects(dispatch(d, {}, decision('assign', 'pingpong')), /dispatch cycle/);
});

test('confirm approves, declines, and is never asked about what would be refused', async () => {
  const asked = [];
  const { clock, advance } = clockFrom(1000);
  const actions = { unlock: { params: { door: { type: 'string' } }, confirm: true, cooldown: 30, allow: ['owner'] } };
  const d = makeDispatcher({ unlock: () => 'unlocked' }, {
    confirm: (state, dec) => { asked.push(dec.proposed.target); return state.approve === true; },
    actions, policyTargets: ['unlock'], clock,
  });
  const proposed = decision('act', 'unlock', { data: { door: 'front' } });
  const request = decision('confirm', 'unlock', { proposed, data: { door: 'front' } });
  const owner = { principal: { roles: ['owner'] } };
  const approved = await dispatch(d, { approve: true }, request, owner);
  assert.equal(approved.status, 'ran');
  assert.equal(approved.result, 'unlocked');
  assert.deepEqual(approved.chain.map(([k]) => k), ['confirm', 'unlock']);
  advance(31_000);
  const declined = await dispatch(d, { approve: false }, request, owner);
  assert.equal(declined.status, 'declined');
  assert.ok(outcomeDeclined(declined));
  // A principal without the role is refused before anyone is asked.
  advance(31_000);
  const forbidden = await dispatch(d, { approve: true }, request, { principal: { roles: ['guest'] } });
  assert.equal(forbidden.status, 'forbidden');
  assert.equal(asked.length, 2);
  // No confirm handler at all is an error, not a silent act.
  const bare = makeDispatcher({ unlock: () => 'unlocked' });
  await assert.rejects(dispatch(bare, {}, request, owner), /no confirm handler/);
});

test('an act decision is re-checked, cooled down, budgeted and claimed exactly once', async () => {
  const { clock, advance } = clockFrom(10_000);
  const runs = [];
  const journal = memoryJournal();
  const d = makeDispatcher({ 'lights-on': actHandler(params => { runs.push(params); return 'on'; }) }, {
    policyTargets: ['lights-on'], clock, journal,
    actions: { 'lights-on': { params: { room: { type: 'member-of', field: 'rooms' } }, cooldown: 5 } },
    budgets: [budget('calls', { max: 2, per: 60 })],
  });
  const dec = (room, id) => decision('act', 'lights-on', { data: { room }, request_id: id });
  const facts = { rooms: ['kitchen', 'bedroom'] };
  const first = await dispatch(d, {}, dec('kitchen', 'req-1'), { facts });
  assert.equal(first.status, 'ran');
  assert.deepEqual(runs[0], { room: 'kitchen', idempotencyKey: 'req-1/lights-on' });
  // The same key again is a duplicate: the handler does not run twice.
  const again = await dispatch(d, {}, dec('kitchen', 'req-1'), { facts });
  assert.equal(again.status, 'duplicate');
  assert.equal(runs.length, 1);
  // A cooldown that has not elapsed skips it, and the claim is released.
  assert.equal((await dispatch(d, {}, dec('bedroom', 'req-2'), { facts })).status, 'cooldown');
  advance(6000);
  assert.equal((await dispatch(d, {}, dec('bedroom', 'req-2'), { facts })).status, 'ran');
  advance(6000);
  // The third call in the window is over budget.
  assert.equal((await dispatch(d, {}, dec('kitchen', 'req-3'), { facts })).status, 'over-budget');
  // A parameter the facts do not allow is an action error, not a device call.
  await assert.rejects(dispatch(d, {}, dec('garage', 'req-4'), { facts }), /member-of/);
  assert.equal(runs.length, 2);
});

test('a key that started and never finished is uncertain, and is not re-run', async () => {
  const journal = memoryJournal();
  const d = makeDispatcher({ 'lock-door': async () => { throw new Error('the radio dropped'); } }, { policyTargets: ['lock-door'], journal });
  const dec = decision('act', 'lock-door', { data: {}, request_id: 'req-9' });
  await assert.rejects(dispatch(d, {}, dec), /the radio dropped/);
  // The journal remembers the failure, so a retry of the same key is a duplicate
  // rather than a second attempt at the device.
  const second = await dispatch(d, {}, dec);
  assert.equal(second.status, 'duplicate');
  // A claim left running (a process that died mid-run) is uncertain.
  await journal.beginStep('req-10/lock-door', 'lock-door', 1);
  const uncertain = await dispatch(d, {}, decision('act', 'lock-door', { data: {}, request_id: 'req-10' }));
  assert.equal(uncertain.status, 'uncertain');
  assert.match(uncertain.result, /may have acted/);
});

test('a guard runs just before the handler, and a dry run runs nothing at all', async () => {
  let ran = 0;
  const d = makeDispatcher({ ship: () => { ran += 1; return 'shipped'; } }, { guards: { ship: (state) => state.fresh === true } });
  assert.equal((await dispatch(d, { fresh: false }, decision('assign', 'ship'))).status, 'guard-failed');
  assert.equal((await dispatch(d, { fresh: true }, decision('assign', 'ship'))).status, 'ran');
  assert.equal(ran, 1);
  const rehearsal = makeDispatcher({ ship: () => { ran += 1; return 'shipped'; } }, { dryRun: true, guards: { ship: () => false } });
  const o = await dispatch(rehearsal, {}, decision('assign', 'ship'));
  assert.equal(o.status, 'dry-run');
  assert.deepEqual(o.chain.map(([k]) => k), ['ship']);
  assert.equal(ran, 1);
});

test('a chain tries each link, a retry repeats, and an exhausted chain names what it tried', async () => {
  const calls = [];
  const flaky = () => { calls.push('flaky'); throw new Error('timed out'); };
  const chain = handlerChain(
    (state, dec) => { calls.push('cheap'); return false; },
    retry(flaky, { attempts: 2, backoff: 0, sleep: async () => {} }),
    () => { calls.push('person'); return 'queued for a person'; },
  );
  const d = makeDispatcher({ review: chain });
  const o = await dispatch(d, {}, decision('escalate', 'review'));
  assert.equal(o.result, 'queued for a person');
  assert.deepEqual(calls, ['cheap', 'flaky', 'flaky', 'person']);
  assert.deepEqual({ key: o.link.key, index: o.link.index }, { key: 'review', index: 2 });
  const hopeless = makeDispatcher({ review: handlerChain(() => false, () => { throw new Error('nope'); }) });
  await assert.rejects(dispatch(hopeless, {}, decision('escalate', 'review')),
    error => /every link in the handler chain for 'review' failed or declined/.test(error.message) && /raised: nope/.test(error.message));
});

test('a plan runs step by step, and stops, continues or rolls back as asked', async () => {
  const schemas = {
    'lights-on': { params: { room: { type: 'string' } }, undo: act('lights-off', { room: { op: 'variable', args: ['room'] } }) },
    'lights-off': { params: { room: { type: 'string' } } },
    'lock-door': { params: { door: { type: 'string' } } },
  };
  const make = (planFailure, failing) => {
    const ran = [];
    const d = makeDispatcher({
      'lights-on': actHandler(p => { ran.push(['on', p.room]); return 'on'; }),
      'lights-off': actHandler(p => { ran.push(['off', p.room]); return 'off'; }),
      'lock-door': actHandler(p => { ran.push(['lock', p.door]); if (failing) throw new Error('the lock is jammed'); return 'locked'; }),
    }, { policyTargets: ['lights-on', 'lights-off', 'lock-door'], planFailure, actions: schemas });
    return { d, ran };
  };
  const steps = [
    decision('act', 'lights-on', { data: { room: 'kitchen' } }),
    decision('act', 'lock-door', { data: { door: 'front' } }),
    decision('act', 'lights-on', { data: { room: 'bedroom' } }),
  ];
  const planDecision = decision('plan', null, { steps, reason: '3 steps' });

  const ok = make('stop', false);
  const fine = await dispatch(ok.d, {}, planDecision);
  assert.equal(fine.status, 'ran');
  assert.deepEqual(fine.steps.map(s => s.status), ['ran', 'ran', 'ran']);

  const stopping = make('stop', true);
  const stopped = await dispatch(stopping.d, {}, planDecision);
  assert.equal(stopped.status, 'error');
  assert.deepEqual(stopped.steps.map(s => s.status), ['ran', 'error', 'not-run']);
  assert.equal(outcomeFailedSteps(stopped).length, 1);

  const continuing = make('continue', true);
  const carried = await dispatch(continuing.d, {}, planDecision);
  assert.deepEqual(carried.steps.map(s => s.status), ['ran', 'error', 'ran']);

  const undoing = make('rollback', true);
  const rolled = await dispatch(undoing.d, {}, planDecision);
  assert.equal(rolled.status, 'rolled-back');
  assert.deepEqual(rolled.steps.slice(0, 3).map(s => s.status), ['rolled-back', 'error', 'not-run']);
  // The inverse is a declared action, not a snapshot: it turned the light off.
  assert.deepEqual(undoing.ran, [['on', 'kitchen'], ['lock', 'front'], ['off', 'kitchen']]);
});

test('a schedule is held in the journal, runs when due, and can be cancelled', async () => {
  const { clock, advance } = clockFrom(1_000_000);
  const dir = await mkdtemp(join(tmpdir(), 'jev-dispatch-'));
  const journal = await sqliteJournal(join(dir, 'schedule.sqlite'));
  const ran = [], scheduled = [];
  const d = makeDispatcher({ 'lights-off': actHandler(p => { ran.push(p.room); return 'off'; }) }, {
    policyTargets: ['lights-off'], clock, journal, autoRunDue: false,
    actions: { 'lights-off': { params: { room: { type: 'string' } } } },
    onScheduled: (key, outcome) => scheduled.push([key, outcome.status]),
  });
  const later = decision('schedule', null, {
    data: { seconds: 600 }, request_id: 'req-s',
    proposed: decision('act', 'lights-off', { data: { room: 'kitchen' } }),
  });
  const held = await dispatch(d, { home: true }, later);
  assert.equal(held.status, 'scheduled');
  assert.equal(held.result, 'req-s/schedule');
  assert.equal(ran.length, 0);
  assert.equal(await runDue(d), 0);
  advance(600_000);
  assert.equal(await runDue(d), 1);
  assert.deepEqual(ran, ['kitchen']);
  assert.deepEqual(scheduled, [['req-s/schedule', 'ran']]);
  // Cancelling removes pending work.
  await dispatch(d, {}, { ...later, request_id: 'req-t' });
  assert.equal(await cancelScheduled(d, 'req-t/schedule'), true);
  advance(600_000);
  assert.equal(await runDue(d), 0);
  stopScheduler(d);
  await journal.close();
});

test('a handler that passes its deadline is reported, not waited out', async () => {
  const d = makeDispatcher({ slow: async () => new Promise(resolve => setTimeout(() => resolve('late'), 5000)) }, { timeout: 0.05 });
  const started = Date.now();
  await assert.rejects(dispatch(d, {}, decision('assign', 'slow')),
    error => error.kind === 'timeout' && /may already have acted/.test(error.message));
  assert.ok(Date.now() - started < 2000);
});

test('the audit record carries the hops, the chain link, the confirmation and the steps', async () => {
  const d = makeDispatcher({
    triage: handlerChain(() => false, () => decision('assign', 'queue')),
    queue: () => 'queued',
  });
  const record = outcomeToJson(await dispatch(d, {}, decision('escalate', 'triage', { reason: 'unclear' })));
  assert.equal(record.status, 'ran');
  assert.equal(record.handler, 'queue');
  assert.equal(record.rehandled, true);
  assert.deepEqual(record.chain.map(hop => hop.key), ['triage', 'queue']);
  assert.equal(record.link.index, 1);
  assert.equal(record.confirmed, null);
  assert.equal(record.final.target, 'queue');
  assert.equal(record.result, 'queued');
});

test('handlers receive the state the policy sent, redacted, unless the caller asks for the input', async () => {
  const seen = [];
  const d = makeDispatcher({ 'billing-queue': state => { seen.push(state); return 'ok'; }, 'engineering-oncall': () => 'ok', 'sales-inbox': () => 'ok', 'retention-oncall': () => 'ok', 'human-triage': () => 'ok' }, { policy: ticket });
  const input = { ticket: 'card 4111111111111111, mail jane@example.com' };
  const dec = decision('assign', 'billing-queue');
  await dispatchForInput(d, input, dec);
  // The handler sees the state the policy built, not the caller's input object.
  assert.deepEqual(seen[0], ticket.buildState(input).state);
  const outcome = await resolve(async () => dec, d, input);
  assert.equal(outcome.status, 'ran');
  await dispatchForInput(d, input, dec, { rawState: true });
  assert.deepEqual(seen[2], input);
});

// A handler built from data: "ok", "decline", {raise}, {decide}, {chain}.
const behaviour = b => {
  if (b === 'ok') return () => 'ok';
  if (b === 'decline') return () => false;
  if (b.raise) return () => { throw new Error(b.raise); };
  if (b.decide) return () => ({ ...decision(b.decide.action, b.decide.target), data: b.decide.data ?? null });
  if (b.chain) return handlerChain(...b.chain.map(behaviour));
  throw new Error(`unknown behaviour ${JSON.stringify(b)}`);
};
const scenarioDecision = j => ({
  ...decision(j.action, j.target ?? null),
  reason: j.reason ?? null, data: j.data ?? null,
  proposed: j.proposed ? scenarioDecision(j.proposed) : null,
  steps: (j.steps ?? []).map(scenarioDecision),
  rule: null, clause: null,
});

test('Racket oracle: cascade dispatch over the shared scenarios', async () => {
  const oracle = fileURLToPath(new URL('./dispatch-oracle.rkt', import.meta.url));
  const run = spawnSync('racket', [oracle], { encoding: 'utf8', env: { ...process.env, TYPESAFE_API_KEY: '', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '' } });
  assert.equal(run.status, 0, run.stderr);
  const expected = JSON.parse(run.stdout);
  const scenarios = JSON.parse(await readFile(new URL('./parity/dispatch-scenarios.json', import.meta.url), 'utf8'));
  assert.equal(scenarios.length, expected.length);
  for (const [i, s] of scenarios.entries()) {
    const want = expected[i];
    assert.equal(want.name, s.name);
    const handlers = Object.fromEntries(Object.entries(s.handlers ?? {}).map(([target, b]) => [target, behaviour(b)]));
    const d = makeDispatcher(handlers, {
      policy: home, actions: home.policy.actions, policyTargets: Object.keys(handlers), allowExtra: true,
      guards: Object.fromEntries(Object.entries(s.guards ?? {}).map(([target, allow]) => [target, () => Boolean(allow)])),
      budgets: (s.budgets ?? []).map(b => budget(b.name, { max: b.max, per: b.per })),
      dryRun: s.dry_run === true, planFailure: s.plan_failure ?? 'stop',
      clock: () => 1_000_000, confirm: () => s.confirm !== false, autoRunDue: false,
    });
    try {
      const o = await dispatch(d, { request: 'the request' }, scenarioDecision(s.decision), { principal: s.principal ?? null, key: s.key ?? null, facts: s.facts ?? null });
      assert.ok(!want.error, `${s.name}: expected an error, got ${o.status}`);
      const mine = outcomeToJson(o);
      // Source spelling, line numbers and a handler's own name differ per host.
      const comparable = record => ({
        status: record.status, handler: record.handler, result: record.result, rehandled: record.rehandled,
        confirmed: record.confirmed, action: record.action, target: record.target, data: record.data,
        chain: record.chain, link: record.link && { key: record.link.key, index: record.link.index },
        final: record.final && { action: record.final.action, target: record.final.target, data: record.final.data },
        steps: record.steps.map(comparable),
      });
      assert.deepEqual(comparable(mine), comparable(want.outcome), s.name);
    } catch (error) {
      if (error?.code === 'ERR_ASSERTION') throw error;
      assert.ok(want.error, `${s.name}: unexpected ${error.message}`);
      // Both implementations name the target and why nothing ran.
      assert.match(error.message, /failed or declined|no handler for target/, s.name);
    }
  }
});
