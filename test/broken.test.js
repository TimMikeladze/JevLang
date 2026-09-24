// Common policy mistakes: the validator has to refuse each one and name the fix.
import test from 'node:test';
import assert from 'node:assert/strict';
import { definePolicy, choice, score, noul, gate, band, rule, all, any, assign, page, hold, escalate, act, confirm, fact } from '../src/index.js';

const refuse = build => {
  try { build(); } catch (error) { return `${error.message}${error.fix ? `\n  ${error.fix}` : ''}`; }
  assert.fail('the validator accepted a broken policy');
};

const department = () => choice('department', 'Which team?', { billing: 'money', technical: 'bugs' });
const frustration = () => score('frustration', 'How upset?', ['Calm', 'Annoyed', 'Angry']);

// Each entry: the mistake, a policy that makes it, and
// the words the refusal has to carry.
const cases = [
  {
    name: 'bad-level', says: ['is not a level'],
    build: () => {
      const f = frustration();
      return definePolicy({
        name: 'bad-level', questions: [f], state: { ticket: { path: [] } },
        gates: [gate(f, 0.7, escalate('triage'))],
        route: { clauses: [rule(f.atLeast('Furious'), page('oncall'))], otherwise: assign('normal') },
      });
    },
  },
  {
    name: 'gate-bypass', says: ['without a confidence gate'],
    build: () => {
      const d = department();
      return definePolicy({
        name: 'gate-bypass', questions: [d],
        route: {
          clauses: [
            // Reading confidence gates this clause, and only this clause.
            rule(all({ op: 'gt', args: [d.confidence(), { op: 'literal', args: [0.9] }] }, d.is('technical')), assign('oncall')),
            rule(d.is('billing'), assign('billing-queue')),
          ],
          otherwise: assign('catch-all'),
        },
      });
    },
  },
  {
    name: 'no-confidence-gate', says: ['without a confidence gate'],
    build: () => {
      const d = department();
      return definePolicy({
        name: 'no-gate', questions: [d], state: { ticket: { path: [] } },
        route: { clauses: [rule(d.is('billing'), assign('billing-queue'))], otherwise: assign('catch-all') },
      });
    },
  },
  {
    name: 'not-exhaustive', says: ['not exhaustive'],
    build: () => {
      const d = choice('department', 'Which team?', { billing: 'money', technical: 'bugs', sales: 'pricing' });
      return definePolicy({
        name: 'not-exhaustive', questions: [d], state: { ticket: { path: [] } },
        gates: [gate(d, 0.8, escalate('triage'))],
        route: { clauses: [rule(d.is('billing'), assign('billing-queue')), rule(d.is('technical'), assign('oncall'))] },
      });
    },
  },
  {
    name: 'noul-confidence', says: ['noul', 'confidence'],
    build: () => {
      const urgent = noul('urgent?', 'Is this urgent?');
      return definePolicy({
        name: 'noul-confidence', questions: [urgent], state: { ticket: { path: [] } },
        gates: [gate(urgent, 0.8, escalate('triage'))],
        route: { clauses: [rule(urgent.yes(), page('oncall'))], otherwise: assign('normal') },
      });
    },
  },
  {
    name: 'too-many-levels', says: ['2 to 10 ordered levels'],
    build: () => {
      const severity = score('severity', 'How severe is the issue?',
        ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10'], { ungated: 'demo' });
      return definePolicy({ name: 'too-many-levels', questions: [severity], route: { otherwise: hold() } });
    },
  },
  {
    name: 'typo-option', says: ['is not an option', "Did you mean 'billing'?"],
    build: () => {
      const d = department();
      return definePolicy({
        name: 'typo-option', questions: [d], state: { ticket: { path: [] } },
        gates: [gate(d, 0.8, escalate('triage'))],
        route: { clauses: [rule(d.is('billling'), assign('billing-queue'))], otherwise: assign('catch-all') },
      });
    },
  },
  {
    name: 'unconfirmed-action', says: ['requires confirmation'],
    build: () => {
      const unlock = noul('unlock?', 'Does the person ask to unlock the front door?');
      return definePolicy({
        name: 'unconfirmed', questions: [unlock],
        actions: { 'unlock-door': { doc: 'Unlock a door', params: { door: { type: 'one-of', values: ['front', 'back'] } }, confirm: true } },
        route: { clauses: [rule(unlock.yes(0.9), act('unlock-door', { door: 'front' }))], otherwise: hold() },
      });
    },
  },
  {
    name: 'unknown-fact', says: ['unknown fact', "Did you mean 'door-open'?"],
    build: () => {
      const lock = noul('lock?', 'Does `request` ask to lock the door?');
      return definePolicy({
        name: 'unknown-fact', questions: [lock],
        state: { request: { path: ['request'] }, 'door-open': { path: ['door-open'], default: false, local: true } },
        route: { clauses: [rule(all(lock.yes(0.8), fact('door-opn')), hold({ reason: 'the door is open' }))], otherwise: assign('lock') },
      });
    },
  },
  {
    name: 'hold-target', says: ['hold takes no target', 'escalate'],
    build: () => {
      const spam = noul('spam?', 'Is this message spam?');
      // hold takes no target: a target given to it is not a known key.
      return definePolicy({
        name: 'hold-target', questions: [spam],
        route: { clauses: [rule(spam.yes(0.9), { action: 'hold', target: 'spam-folder' })], otherwise: assign('inbox') },
      });
    },
  },
];

test('every broken example is refused here too, with the fix named', () => {
  for (const { name, says, build } of cases) {
    const message = refuse(build);
    for (const words of says) assert.ok(message.includes(words), `${name}: refusal should mention ${words}\n${message}`);
  }
});
