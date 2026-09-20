import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { policy as hello } from '../examples/hello.mjs';
import { policy as v2 } from '../examples/ticket-router-v2.mjs';
import { policy as alignment } from '../examples/entity-alignment.mjs';
import { policy as extraction, receiptInput } from '../examples/extraction.mjs';
import { policy as ticket } from '../examples/ticket-router.mjs';

const racket = file => {
  const run = spawnSync('racket', [fileURLToPath(new URL(file, import.meta.url))], { encoding: 'utf8', env: { ...process.env, TYPESAFE_API_KEY: '', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', JEV_PROVIDER: '', JEV_MODEL: '', JEV_EFFORT: '' } });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
};
// Source spelling and line numbers come from the host language.
const decisionKeys = ['action', 'target', 'reason', 'data', 'rule', 'clause', 'steps', 'proposed', 'evidence', 'readings'];

test('Racket oracle: the remaining reference policies decide alike', () => {
  const oracle = racket('./reference-extra-oracle.rkt');
  // ticket-router's state form takes the whole ticket, as v1's port does.
  const inputs = { 'ticket-router-v2': 'the ticket text', 'entity-alignment': { left: 'Hazy Little Thing IPA', right: 'Sierra Nevada Hazy Little Thing' } };
  const policies = { hello, 'ticket-router-v2': v2, 'entity-alignment': alignment, extraction };
  for (const [name, expected] of Object.entries(oracle)) {
    const policy = policies[name];
    // Extraction computes its candidate lists from the body, the way the Racket
    // state form does; the state it builds from them must be the same.
    const input = name === 'extraction' ? receiptInput(expected.input) : inputs[name] ?? {};
    const state = policy.buildState(input).state;
    if (expected.state) assert.deepEqual(state, expected.state, `${name}: state`);
    assert.deepEqual(policy.questions(state), expected.questions, `${name}: questions`);
    for (const row of expected.cases) {
      const actual = policy.decide(row.answers, { state });
      for (const key of decisionKeys) assert.deepEqual(actual[key], row.decision[key], `${name}/${row.name}: ${key}`);
    }
  }
});

test('ticket-router v2 asks exactly what v1 asks, so one fixture serves both', () => {
  assert.deepEqual(v2.questions({ ticket: 't' }), ticket.questions({ ticket: 't' }));
  assert.equal(v2.identity(), ticket.identity());
});
