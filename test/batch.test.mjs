import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateMany, makePacer } from '../src/batch.mjs';
import { runPipeline, pipelineToJson, topOptions, defaultNextInput } from '../src/pipeline.mjs';
import { jevCall, settings as client } from '../src/client.mjs';

// A clock and a sleep that move only when the code asks them to, so pacing is
// deterministic and the test takes no time.
const fakeTime = () => {
  let now = 0;
  return { clock: () => now, sleep: async seconds => { now += seconds * 1000; }, advance: ms => { now += ms; }, at: () => now };
};

test('a batch keeps input order, counts what failed, and totals the tokens it spent', async () => {
  const time = fakeTime();
  const rows = ['a', 'b', 'c', 'd'];
  const seen = [];
  const report = await evaluateMany(async row => {
    client.onUsage?.({ input_tokens: 10 });
    if (row === 'c') throw new Error('no answer for c');
    return { action: 'assign', target: row.toUpperCase() };
  }, rows, { workers: 2, rpm: null, tokensPerSecond: null, clock: time.clock, sleep: time.sleep, onResult: (i, r) => seen.push(i) });
  assert.deepEqual(report.results.map(r => r.target ?? r.message), ['A', 'B', 'no answer for c', 'D']);
  assert.equal(report.failed, 1);
  assert.equal(report.tokens, 40);
  assert.ok(report.cost > 0);
  assert.deepEqual(seen.sort(), [0, 1, 2, 3]);
  // The batch restores whatever accounting was installed around it.
  assert.equal(client.onUsage, null);
});

test('the pacer spaces starts, reserves tokens, and honours a retry-after', async () => {
  const time = fakeTime();
  const pacer = makePacer({ rpm: 600, tokensPerSecond: 1000, sleep: time.sleep, clock: time.clock });
  await pacer.acquire();
  assert.equal(time.at(), 0);
  // 600 a minute is one start every 100 ms.
  await pacer.acquire();
  assert.equal(time.at(), 100);
  // Once a call's usage is known, a start reserves that many tokens; with a
  // bucket of 1000 a second, a 900-token average waits for the refill.
  pacer.observe({ input_tokens: 900 });
  const before = time.at();
  await pacer.acquire();
  assert.ok(time.at() - before >= 100);
  // A server's retry-after pauses every start until it has passed.
  pacer.pause(2);
  const paused = time.at();
  await pacer.acquire();
  assert.ok(time.at() - paused >= 2000);
});

test('a batch paces the calls its rows make, through the client', async t => {
  const time = fakeTime();
  const original = { transport: client.transport, apiKey: client.apiKey, sleep: client.sleep, clock: client.clock };
  t.after(() => Object.assign(client, original));
  client.apiKey = 'test-key';
  client.transport = async () => ({ answers: { q: { type: 'noul', noul: 0.5 } }, model: 'm', usage: { input_tokens: 100 } });
  client.sleep = time.sleep;
  client.clock = time.clock;
  const report = await evaluateMany(async () => {
    const response = await jevCall({ row: 1 }, { q: { type: 'noul' } }, {});
    return { action: 'assign', target: response.model };
  }, [1, 2, 3], { workers: 3, rpm: 600, tokensPerSecond: null, clock: time.clock, sleep: time.sleep });
  assert.equal(report.failed, 0);
  assert.equal(report.tokens, 300);
  // Three starts, 100 ms apart.
  assert.ok(time.at() >= 200, `expected the batch to have paced itself, clock is ${time.at()}`);
});

test('a pipeline hands off by deciding next, sums usage, and refuses to loop', async () => {
  const stages = {
    triage: async () => { client.onUsage?.({ input_tokens: 10, output_tokens: 2 }); return { action: 'next', target: 'severity', data: { dept: 'billing' } }; },
    severity: async input => { client.onUsage?.({ input_tokens: 5, output_tokens: 1 }); return { action: 'assign', target: `${input.previous.data.dept}-queue` }; },
  };
  const result = await runPipeline(stages, { ticket: 'a refund' }, { start: 'triage' });
  assert.equal(result.decision.target, 'billing-queue');
  assert.deepEqual(result.steps.map(([stage]) => stage), ['triage', 'severity']);
  assert.deepEqual(result.usage, { input_tokens: 15, output_tokens: 3 });
  // Every stage says which stage it was.
  assert.deepEqual(pipelineToJson(result).steps.map(s => s.stage), ['triage', 'severity']);
  assert.equal(result.decision.stage, 'severity');

  const looping = { a: async () => ({ action: 'next', target: 'b' }), b: async () => ({ action: 'next', target: 'a' }) };
  await assert.rejects(runPipeline(looping, {}, { start: 'a' }), /reached stage 'a' twice/);
  const missing = { a: async () => ({ action: 'next', target: 'nowhere' }) };
  await assert.rejects(runPipeline(missing, {}, { start: 'a' }), /does not have/);
  const endless = { a: async () => ({ action: 'next', target: 'b' }), b: async () => ({ action: 'next', target: 'c' }), c: async () => ({ action: 'next', target: 'd' }), d: async () => ({ action: 'next', target: 'a' }) };
  await assert.rejects(runPipeline(endless, {}, { start: 'a', maxRequests: 3 }), /without a final decision/);
  await assert.rejects(runPipeline({ a: async () => 'not a decision' }, {}, { start: 'a' }), /did not return a decision/);
});

test('a stage can build the next input, and topOptions shortlists a choice', async () => {
  const stages = {
    shortlist: async () => ({ action: 'next', target: 'pick', data: { answer: { probabilities: { billing: 0.5, technical: 0.3, sales: 0.2 } } } }),
    pick: [async input => ({ action: 'assign', target: input.options.join('+') }),
      (previous, decision) => ({ ...previous, options: topOptions(decision.data.answer, 2) })],
  };
  const result = await runPipeline(stages, { ticket: 'x' }, { start: 'shortlist' });
  assert.equal(result.decision.target, 'billing+technical');
  // Ties are broken by the key, so a shortlist is stable.
  assert.deepEqual(topOptions({ probabilities: { b: 0.4, a: 0.4, c: 0.2 } }, 2), ['a', 'b']);
  assert.deepEqual(topOptions({ probabilities: { a: 1 } }, 5), ['a']);
  assert.throws(() => topOptions({}, 1), /probabilities/);
  // Without a builder the previous input carries the previous decision.
  assert.deepEqual(defaultNextInput({ ticket: 'x' }, { action: 'next', target: 'b' }), { ticket: 'x', previous: { action: 'next', target: 'b' } });
  assert.deepEqual(defaultNextInput('plain text', { action: 'next' }), { input: 'plain text', previous: { action: 'next' } });
});
