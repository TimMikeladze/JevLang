import test from 'node:test';
import assert from 'node:assert/strict';
import { redactorNames, capValue, redactQuestions, restoreAnswerKeys, checkTokenBudget } from '../src/state.js';
import { definePolicy, rule, hold, fact, eq } from '../src/index.js';

test('redaction before caps never leaves partial secrets or markers; local facts are trace-redacted', () => {
  const p = definePolicy({ name: 'private', questions: [], stateOptions: { redact: ['cards', 'emails'] }, state: { request: { maxChars: 1200 }, observed: { local: true } }, route: { clauses: [rule(eq(fact('observed'), 'ops@example.com'), hold())], otherwise: hold() } });
  const input = { request: 'x'.repeat(1180) + ' 4111 1111 1111 1111 ' + 'y'.repeat(30), observed: 'ops@example.com', undeclared: 'private' };
  const built = p.buildState(input);
  assert.equal(built.state.request, 'x'.repeat(1180) + '  ...[truncated]');
  assert.equal(built.facts.observed, 'ops@example.com');
  assert.deepEqual(Object.keys(built.state), ['request']);
  assert.equal(p.decide({}, { facts: built.facts }).readings[0].value, '<email>');
});

test('question redaction keeps colliding options distinct and restores only corresponding answer keys', () => {
  const qs = { owner: { type: 'choice', instructions: 'email ops@example.com', criteria: { 'a@example.com': 'First', 'b@example.com': 'Second', '<email>': 'Existing' } } };
  const { questions, renames } = redactQuestions(qs, ['emails']);
  assert.deepEqual(Object.keys(questions.owner.criteria), ['<email>#1', '<email>#2', '<email>']);
  assert.equal(questions.owner.instructions, 'email <email>');
  const restored = restoreAnswerKeys({ owner: { choice: '<email>#2', confidence: 0.9, probabilities: { '<email>#1': 0.1, '<email>#2': 0.9 } } }, renames);
  assert.equal(restored.owner.choice, 'b@example.com');
  assert.deepEqual(restored.owner.probabilities, { 'a@example.com': 0.1, 'b@example.com': 0.9 });
});

test('unshrinkable structures and estimated token overflow fail before sending', () => {
  assert.throws(() => capValue({ number: 1234567890 }, 3), /after shrinking/);
  assert.throws(() => checkTokenBudget('short', { q: { type: 'noul', instructions: 'q'.repeat(100) } }, 20), /rough estimate/);
  assert.equal(checkTokenBudget('short', {}, null), 'short');
});
