import test from 'node:test';
import assert from 'node:assert/strict';
import { compile, choice, score, noul, noulEach, definePolicy, gate, band, rule, assign, hold, confirm, act, all, any, not, eq, fact, compute, variable, planFor, schedule, branch, literal, record } from '../src/index.js';
import { replay, diff, tune } from '../src/fixtures.js';
import * as names from './parity/names.js';

const answer = (choice, confidence = 0.95) => ({ choice, confidence, probabilities: { a: choice === 'a' ? confidence : 1 - confidence, b: choice === 'b' ? confidence : 1 - confidence } });
const q = choice('q', 'Which?', ['a', 'b']);
const simple = overrides => definePolicy({ name: 'simple', questions: [q], gates: [gate(q, 0.8, hold())], route: { clauses: [rule(q.is('a'), assign('a'))], otherwise: assign('b') }, ...overrides });

test('option code names, named levels and raw questions are checked, and typos rejected', () => {
  assert.equal(names.policy.decide({ intent: { type: 'choice', choice: 'approve_transfer', confidence: 0.91, probabilities: { approve_transfer: 0.91 } }, urgency: { type: 'score', score: 0.4, confidence: 0.9, probabilities: { 0: 0.7, 1: 0.25, 2: 0.05 } }, sentiment: { type: 'noul', noul: 0.1 } }).data.code, 'approve-transfer');
  // A reference is a code name, a wire key, or a level name; a typo is not.
  const route = when => compile({ ...names.policy.toJSON(), route: { clauses: [rule(when, assign('x'))], otherwise: assign('y') } });
  assert.throws(() => route(names.intent.is('approve-transfers')), /not an option/);
  assert.throws(() => route(names.urgency.mostLikely('urgent')), /not a level/);
  assert.equal(route(names.intent.is('approve_transfer')).policy.name, 'names');
  const bad = fn => { const p = names.policy.toJSON(); fn(p); assert.throws(() => compile(p)); };
  bad(p => { p.questions.intent.names = { 'approve-transfer': 'missing' }; });
  bad(p => { p.questions.intent.names = { 'check-balance': 'approve_transfer' }; });
  bad(p => { p.questions.urgency.levelNames = ['calm', 'soon']; });
  bad(p => { p.questions.urgency.levelNames = ['Wants it today', 'soon', 'now']; });
  bad(p => { p.questions.sentiment.wire = { instructions: 'no type' }; });
  bad(p => { p.questions.sentiment.instructions = 'raw questions have no declared shape'; });
  bad(p => { p.extraBody = { model: 'jev-1.13.0' }; });
  // Only rawAnswer reads a raw question, and it reads nothing else.
  bad(p => { p.route.clauses[0].when = { op: 'yes', args: ['sentiment', literal(0.5)] }; });
  bad(p => { p.route.clauses[0].decision.data = { op: 'rawAnswer', args: ['intent'] }; });
  assert.deepEqual(names.policy.warnings.map(w => w.path), ['$.extraBody', '$.questions.sentiment']);
});

test('validator rejects missing gates, bypass between clauses, unknown options and incomplete routes', () => {
  const raw = simple().toJSON();
  const bad = fn => { const p = structuredClone(raw); fn(p); assert.throws(() => compile(p)); };
  bad(p => { p.gates = []; });
  bad(p => { p.route.clauses[0].when.args[1] = 'typo'; });
  bad(p => { delete p.route.otherwise; });
  bad(p => { p.route.clauses[0].decision = { action: 'hold', target: 'bad' }; });
  bad(p => { p.gates = []; p.route.clauses.unshift(rule(compute('gt', q.confidence(), 0.9), hold())); });
  bad(p => { p.format = 0; });
  bad(p => { p.questions.q.ungated = ''; });
  assert.throws(() => definePolicy({ ...raw, questions: [q, q] }), /Duplicate/);
  assert.throws(() => compile({ ...raw, bad: true }), /unknown field/);
});

test('on-read gates respect short-circuit evaluation, including informational data reads', () => {
  const other = choice('other', 'Other?', ['a', 'b']);
  const p = definePolicy({ name: 'lazy', questions: [q, other], gates: [gate(q, 0.8, hold(), { onRead: true }), gate(other, 0.8, assign('review'), { onRead: true })], route: { clauses: [rule(all(q.is('a'), other.is('a')), assign('both')), rule(q.is('b'), assign('b'))], otherwise: hold() } });
  const d = p.decide({ q: answer('b'), other: answer('a', 0.2) });
  assert.equal(d.target, 'b'); assert.deepEqual(d.readings.map(r => r.question), ['q']);
  assert.equal(p.decide({ q: answer('a'), other: answer('a', 0.2) }).target, 'review');
  const raw = p.toJSON(); raw.route.clauses[1].decision.data = record({ other: other.value() });
  assert.equal(compile(raw).decide({ q: answer('b'), other: answer('a', 0.2) }).target, 'review');
});

test('threshold boundaries, option gates, profiles and invalid overrides', () => {
  const p = simple({ gates: [gate(q, 0.8, hold()), gate(q, 0.9, assign('review'), { option: 'a' })], profiles: { strict: { q: 0.85 } } });
  assert.equal(p.decide({ q: answer('b', 0.8) }).target, 'b');
  assert.equal(p.decide({ q: answer('a', 0.89) }).target, 'review');
  assert.equal(p.decide({ q: answer('a', 0.9) }).target, 'a');
  assert.equal(p.decide({ q: answer('b', 0.8) }, { profile: 'strict' }).action, 'hold');
  assert.throws(() => p.decide({ q: answer('a') }, { overrides: { q: 0.99 } }), /option gate/);
  assert.throws(() => p.decide({ q: answer('a') }, { profile: 'missing' }), /unknown profile/);
});

test('noul has no confidence; band edges and action certainty use probability', () => {
  const n = noul('n', 'Yes?');
  const p = definePolicy({ name: 'noul', questions: [n], actions: { unlock: { params: {}, confirm: true, minConfidence: 0.9 } }, gates: [band(n, 0.4, 0.6, hold())], route: { clauses: [rule(n.yes(0.7), confirm(act('unlock')))], otherwise: hold() } });
  assert.equal(p.decide({ n: { noul: 0.4 } }).rule, 'band');
  assert.equal(p.decide({ n: { noul: 0.6 } }).rule, 'band');
  assert.equal(p.decide({ n: { noul: 0.8 } }).action, 'hold');
  assert.equal(p.decide({ n: { noul: 0.95 } }).action, 'confirm');
  const raw = p.toJSON(); raw.route.clauses[0].when = compute('gt', n.confidence(), 0.9);
  assert.throws(() => compile(raw), /no confidence/);
});

test('typed actions validate confirmation, parameters, dynamic values and inventories', () => {
  const actions = { unlock: { params: { door: { type: 'member-of', field: 'doors' }, seconds: { type: 'number', min: 1, max: 10 } }, confirm: true } };
  const p = definePolicy({ name: 'actions', questions: [], state: { doors: {}, seconds: {} }, actions, route: { clauses: [], otherwise: confirm(act('unlock', { door: 'front', seconds: fact('seconds') })) } });
  assert.equal(p.decide({}, { facts: { doors: ['front'], seconds: 3 } }).proposed.data.seconds, 3);
  assert.throws(() => p.decide({}, { facts: { doors: ['back'], seconds: 3 } }), /member-of/);
  assert.throws(() => p.decide({}, { facts: { doors: ['front'], seconds: 11 } }), /number/);
  const raw = p.toJSON(); raw.route.otherwise = act('unlock', { door: 'front', seconds: 2 });
  assert.throws(() => compile(raw), /requires confirmation/);
  raw.route.otherwise = confirm(act('unlock', { door: 'front', seconds: true }));
  assert.throws(() => compile(raw), /number/);
  raw.route.otherwise = confirm(act('unlock', { door: 'front' }));
  assert.throws(() => compile(raw), /missing required/);
});

test('all routes preserve clause order; collect uses severity order', () => {
  const raw = simple().toJSON();
  raw.route = { mode: 'all', clauses: [rule(true, assign('low')), rule(true, assign('high'))] };
  assert.deepEqual(compile(raw).decide({ q: answer('a') }).steps.map(d => d.target), ['low', 'high']);
  raw.route.mode = 'collect'; raw.route.precedence = ['high', 'low'];
  assert.equal(compile(raw).decide({ q: answer('a') }).target, 'high');
});

test('families build questions, select items and produce typed scheduled plans', () => {
  const lights = noulEach('lights', 'Turn this on?', 'rooms', { itemKey: 'room' });
  const p = definePolicy({ name: 'lights', questions: [lights], state: { rooms: {} }, actions: { on: { params: { room: { type: 'member-of', field: 'rooms' } } } }, route: { clauses: [], otherwise: schedule(60, planFor('room', lights.yesItems(0.9), act('on', { room: variable('room') }))) } });
  assert.deepEqual(Object.keys(p.questions({ rooms: ['kitchen', 'bedroom'] })), ['lights--0', 'lights--1']);
  const d = p.decide({ 'lights--0': { noul: 0.98 }, 'lights--1': { noul: 0.2 } }, { facts: { rooms: ['kitchen', 'bedroom'] } });
  // One item is that decision, not a plan of one; two are a plan; none is a hold.
  assert.equal(d.action, 'schedule'); assert.equal(d.data.seconds, 60);
  assert.equal(d.proposed.action, 'act'); assert.equal(d.proposed.data.room, 'kitchen');
  const both = p.decide({ 'lights--0': { noul: 0.98 }, 'lights--1': { noul: 0.95 } }, { facts: { rooms: ['kitchen', 'bedroom'] } });
  assert.deepEqual(both.proposed.steps.map(s => s.data.room), ['kitchen', 'bedroom']);
  const none = p.decide({ 'lights--0': { noul: 0.1 }, 'lights--1': { noul: 0.2 } }, { facts: { rooms: ['kitchen', 'bedroom'] } });
  assert.equal(none.proposed.action, 'hold'); assert.match(none.proposed.reason, /no items/);
  assert.deepEqual(d.readings.map(r => [r.question, r.kind, r.value]), [['lights', 'family', 2], ['lights[kitchen]', 'noul', 0.98]]);
});

test('state whitelist, local facts, defaults, unicode caps and dynamic options', () => {
  const d = choice('door', 'Which?', { none: 'No door' }, { optionsFrom: 'doors', ungated: 'Reviewed by a person' });
  const p = definePolicy({ name: 'state', questions: [d], state: { doors: {}, request: { maxChars: 2 }, open: { local: true, default: [] } }, route: { clauses: [], otherwise: assign('review', { data: d.value() }) } });
  const built = p.buildState({ doors: ['front'], request: '😀xy', secret: 'never included' });
  assert.deepEqual(built.state, { doors: ['front'], request: '😀x' }); assert.deepEqual(built.facts.open, []);
  assert.deepEqual(p.questions(built.state).door.criteria, { front: null, none: 'No door' });
  assert.throws(() => p.questions({ doors: ['none'] }), /distinct options/);
  assert.throws(() => p.decide({ door: answer('other') }, { facts: built.facts }), /not a declared option/);
});

test('prechecks reject indirect answer reads and return before answers are needed', () => {
  const p = simple({ state: { urgent: {} }, prechecks: [rule(eq(fact('urgent'), true), assign('manual'))] });
  assert.equal(p.precheck({ urgent: true }).target, 'manual');
  const raw = p.toJSON(); raw.signals = { hidden: q.is('a') }; raw.prechecks[0].when = { op: 'signal', args: ['hidden'] };
  assert.throws(() => compile(raw), /prechecks cannot read/);
});

test('immutable compiled artifacts, unsupported nodes and resource bounds', () => {
  const raw = simple().toJSON(), p = compile(raw); raw.gates[0].threshold = 0;
  assert.equal(p.decide({ q: answer('a', 0.2) }).action, 'hold');
  assert.throws(() => { p.policy.gates[0].threshold = 0; }, TypeError);
  raw.route.otherwise = { action: 'assign', target: 'x', data: { op: 'eval', args: ['evil'] } };
  assert.throws(() => compile(raw), /unknown expression/);
  const cyclic = {}; cyclic.x = cyclic; assert.throws(() => compile(cyclic), /cyclic/);
});

test('fixtures reject legacy format, detect stale questions, diff routing and tune honest labels', () => {
  const p = simple();
  const f = { fixture_version: 3, provider: 'fixture', requested_model: null, model: null, requested_effort: null, effective_effort: null, answers: { q: answer('a', 0.85) }, expect: { action: 'assign', target: 'a' }, label: { action: 'assign', target: 'a' }, synthetic: true, questions_sha256: p.fingerprint() };
  assert.equal(replay(p, [{ ...f, fixture_version: 2 }])[0].status, 'error');
  const changed = p.toJSON(); changed.questions.q.instructions = 'Changed?';
  assert.equal(replay(compile(changed), [f])[0].status, 'stale');
  const after = p.toJSON(); after.route.clauses[0].decision.target = 'new';
  assert.equal(diff(p, compile(after), [f])[0].changed, true);
  const report = tune(p, [f], { q: [0.8, 0.9] });
  assert.equal(report.warnings.length, 2); assert.equal(report.results[0].correct, 1);
});
