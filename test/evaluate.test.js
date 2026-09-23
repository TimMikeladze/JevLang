import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeFile, mkdtemp, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { questionsAnswerSchema, policyPrompt, evaluateWithProvider, evaluateConfiguredPolicy, typesafeProvider, fixtureFromRun, runPolicyProvider, normalizeAnswers } from '../src/evaluate.js';
import { validateAnswers } from '../src/engine.js';
import { jevCall, settings as client, defaultRetryPolicy, JevApiError } from '../src/client.js';
import { ProviderRegistry, mergeProviderConfig, capabilities, commandProvider, clearProviderDiscoveryCache, environmentReader } from '../src/provider/index.js';
import { replay } from '../src/fixtures.js';
import { policy as ticket } from '../examples/ticket-router.js';
import { policy as home } from '../examples/smart-home.js';
import { skipUnlessInMonorepo } from './monorepo.js';

const answers = {
  department: { type: 'choice', choice: 'billing', confidence: 0.93, probabilities: { billing: 0.93, technical: 0.05, sales: 0.02 } },
  frustration: { type: 'score', score: 0.4, confidence: 0.9, probabilities: { 0: 0.7, 1: 0.2, 2: 0.1 } },
  'refund-requested?': { type: 'noul', noul: 0.2 },
};
const restore = () => {
  client.transport = null; client.apiKey = null; client.baseUrl = null; client.sleep = seconds => new Promise(r => setTimeout(r, Math.min(seconds, 0.01) * 1000));
  client.clock = () => Date.now(); client.random = () => 0; client.onRetryAfter = null; client.onUsage = null; client.extraBody = null;
  client.environment = name => ({ TYPESAFE_API_KEY: 'test-key' })[name];
};

test('Racket oracle: the answer schema and the prompt that carries the questions', t => {
  if (skipUnlessInMonorepo(t)) return;
  const oracle = fileURLToPath(new URL('./evaluate-oracle.rkt', import.meta.url));
  const run = spawnSync('racket', [oracle], { encoding: 'utf8', env: { ...process.env, TYPESAFE_API_KEY: '', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', JEV_PROVIDER: '', JEV_MODEL: '', JEV_EFFORT: '' } });
  assert.equal(run.status, 0, run.stderr);
  const expected = JSON.parse(run.stdout);
  assert.deepEqual(questionsAnswerSchema(ticket.questions()), expected.ticket.schema);
  const state = home.buildState({ request: 'lock the front door' }).state;
  const questions = home.questions(state);
  assert.deepEqual(questionsAnswerSchema(questions), expected['smart-home'].schema);
  // The prompt is the same text carrying the same JSON; only key order differs.
  const parts = prompt => {
    const [, head, stateText, questionsText] = /^([\s\S]*?)<jev-state>\n([\s\S]*?)\n<\/jev-state>\n\n<jev-questions>\n([\s\S]*?)\n<\/jev-questions>$/.exec(prompt);
    return { head, state: JSON.parse(stateText), questions: JSON.parse(questionsText) };
  };
  assert.deepEqual(parts(policyPrompt({ ticket: 'a ticket' }, ticket.questions())), parts(expected.ticket.prompt));
  assert.deepEqual(parts(policyPrompt(state, questions)), parts(expected['smart-home'].prompt));
});

test('the TypeSafe call sends state, model and questions, and reports its provenance', async t => {
  restore();
  t.after(restore);
  const sent = [];
  client.transport = async payload => {
    sent.push(payload);
    return { answers, model: 'jev-1.13.0', usage: { input_tokens: 1044 }, request_id: 'req_x' };
  };
  const response = await jevCall({ ticket: 'a ticket' }, ticket.questions(), { model: 'jev-1.13.0' });
  assert.deepEqual(Object.keys(sent[0]).sort(), ['model', 'questions', 'state']);
  assert.equal(sent[0].model, 'jev-1.13.0');
  assert.equal(response.model, 'jev-1.13.0');
  assert.equal(response.requestedModel, 'jev-1.13.0');
  assert.deepEqual(response.usage, { input_tokens: 1044 });
  // extraBody cannot replace what the call is made of.
  client.extraBody = { trace: 'abc' };
  await jevCall({}, {}, {});
  assert.equal(sent[1].trace, 'abc');
  client.extraBody = { model: 'other' };
  await assert.rejects(jevCall({}, {}, {}), /extraBody cannot set 'model'/);
});

const serve = handler => new Promise(resolve => {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
});

test('HTTP failures are classified, retried where the policy says, and never on a 401', async t => {
  restore();
  t.after(restore);
  let calls = 0;
  const { server, url } = await serve((request, response) => {
    calls += 1;
    if (request.url !== '/v1/systemone') { response.writeHead(404).end('nothing here'); return; }
    if (calls === 1) {
      response.writeHead(429, { 'retry-after-ms': '5', 'x-typesafe-request-id': 'req_429' }).end('{"error":"slow down"}');
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json', 'x-typesafe-request-id': 'req_ok' })
      .end(JSON.stringify({ answers, model: 'jev-1.13.0', usage: { input_tokens: 9 } }));
  });
  t.after(() => server.close());
  client.baseUrl = url;
  const waits = [];
  client.onRetryAfter = seconds => waits.push(seconds);
  const response = await jevCall({ ticket: 'x' }, ticket.questions(), {});
  assert.equal(calls, 2);
  assert.equal(response.requestId, 'req_ok');
  assert.deepEqual(waits, [0.005]);

  const unauthorized = await serve((request, response) => { response.writeHead(401).end('{"error":"bad key"}'); });
  t.after(() => unauthorized.server.close());
  client.baseUrl = unauthorized.url;
  let attempts = 0;
  const counting = { ...defaultRetryPolicy };
  await assert.rejects(jevCall({}, {}, { retry: counting }), error => {
    attempts += 1;
    return error instanceof JevApiError && error.kind === 'auth' && error.status === 401 && /check TYPESAFE_API_KEY/.test(error.message);
  });
  assert.equal(attempts, 1);

  const garbage = await serve((request, response) => { response.writeHead(200, { 'content-type': 'text/plain' }).end('not json at all'); });
  t.after(() => garbage.server.close());
  client.baseUrl = garbage.url;
  await assert.rejects(jevCall({}, {}, {}), error => error.kind === 'response' && /is not JSON/.test(error.message));

  const empty = await serve((request, response) => { response.writeHead(200, { 'content-type': 'application/json' }).end('{"model":"m"}'); });
  t.after(() => empty.server.close());
  client.baseUrl = empty.url;
  await assert.rejects(jevCall({}, {}, {}), /no 'answers' object/);
});

test('evaluate builds the state, asks the provider, validates and decides with provenance', async t => {
  restore();
  t.after(restore);
  client.transport = async () => ({ answers, model: 'jev-1.13.0', usage: { input_tokens: 44 }, request_id: 'req_eval' });
  const registry = new ProviderRegistry();
  registry.register(typesafeProvider());
  clearProviderDiscoveryCache(registry);
  const config = mergeProviderConfig({ project: { provider: 'typesafe', model: 'jev-1.13.0' } });
  const decision = await evaluateWithProvider(ticket, { ticket: 'I want a refund' }, { config, registry });
  assert.equal(decision.target, 'billing-queue');
  assert.equal(decision.provider, 'typesafe');
  assert.equal(decision.requested_model, 'jev-1.13.0');
  assert.equal(decision.model, 'jev-1.13.0');
  assert.equal(decision.request_id, 'req_eval');
  assert.deepEqual(decision.readings.map(r => r.question), ['department']);

  // Answers that do not match the questions are invalid output, not a decision.
  client.transport = async () => ({ answers: { department: { type: 'choice', choice: 'nope', confidence: 0.9 } }, model: 'm' });
  await assert.rejects(evaluateWithProvider(ticket, { ticket: 'x' }, { config, registry }),
    error => error.kind === 'unavailable' && /not a declared option/.test(error.detail));
});

test('a precheck decides without asking, and a missing key means no configured decision', async t => {
  restore();
  t.after(restore);
  client.environment = () => undefined;
  const registry = new ProviderRegistry();
  registry.register(typesafeProvider());
  clearProviderDiscoveryCache(registry);
  // Nothing but the defaults asked for a provider, so an unauthenticated
  // TypeSafe means "no configured decision" rather than an error.
  assert.equal(await evaluateConfiguredPolicy(ticket, { ticket: 'x' }, { registry, start: await mkdtemp(join(tmpdir(), 'jev-empty-')) }), null);
  // An explicit provider that cannot resolve stays an error.
  await assert.rejects(evaluateConfiguredPolicy(ticket, { ticket: 'x' }, { registry, provider: 'typesafe', start: await mkdtemp(join(tmpdir(), 'jev-empty-')) }),
    error => error.kind === 'unavailable');
});

test('any executable can answer a policy, and its run records a replayable fixture', async t => {
  restore();
  t.after(restore);
  const dir = await mkdtemp(join(tmpdir(), 'jev-answerer-'));
  const path = join(dir, 'answer-provider');
  await writeFile(path, `#!/usr/bin/env node
    let input = '';
    process.stdin.on('data', c => { input += c; });
    process.stdin.on('end', () => {
      const request = JSON.parse(input);
      const questions = request.metadata.questions;
      const answers = {};
      for (const [id, q] of Object.entries(questions)) {
        if (q.type === 'choice') answers[id] = { type: 'choice', choice: Object.keys(q.criteria)[0], confidence: 0.95, probabilities: { [Object.keys(q.criteria)[0]]: 0.95 } };
        else if (q.type === 'score') answers[id] = { type: 'score', score: 0, confidence: 0.95, probabilities: Object.fromEntries(q.criteria.map((_, i) => [i, i === 0 ? 0.9 : 0.05])) };
        else answers[id] = { type: 'noul', noul: 0.02 };
      }
      process.stdout.write(JSON.stringify({ output: answers, model: 'fake-answerer', usage: { input_tokens: 3 }, cost: { mode: 'subscription' } }));
    });
  `);
  await chmod(path, 0o755);
  const original = environmentReader.get;
  environmentReader.get = name => name === 'PATH' ? `${dir}:${process.env.PATH}` : original.call(environmentReader, name);
  t.after(() => { environmentReader.get = original; });
  const registry = new ProviderRegistry();
  registry.register(commandProvider('answerer', 'answer-provider', { caps: capabilities({ efforts: ['low'] }) }));
  clearProviderDiscoveryCache(registry);
  const config = mergeProviderConfig({ project: { provider: 'answerer' } });
  const input = { request: 'turn on the kitchen lights' };
  const decision = await evaluateWithProvider(home, input, { config, registry });
  assert.equal(decision.provider, 'answerer');
  assert.equal(decision.model, 'fake-answerer');

  const state = home.buildState(input).state;
  const questions = home.questions(state);
  const result = await runPolicyProvider(state, questions, { config, registry });
  const fixture = fixtureFromRun({ name: 'kitchen-on', policy: home, state, questions, decision, result });
  assert.equal(fixture.fixture_version, 3);
  assert.equal(fixture.provider, 'answerer');
  assert.equal(fixture.questions_sha256, home.identity());
  const rows = replay(home, [fixture]);
  assert.equal(rows[0].status, 'pass');
  assert.equal(rows[0].verifiedBy, 'questions');
});

// A model that answers a score in the question's own words is answering the
// question, not a different one: the names it used are translated to the
// levels the policy declared, and anything that matches no level is left as it
// came so validation still refuses it.
test('score answers given by name are translated to their levels', () => {
  const questions = {
    frustration: {
      type: 'score',
      instructions: 'How frustrated is the customer?',
      criteria: ['Calm and matter-of-fact', 'Annoyed but polite', 'Angry, threatening to leave'],
    },
  };
  const answers = normalizeAnswers(questions, {
    frustration: {
      type: 'score',
      score: 'Angry, threatening to leave',
      confidence: 0.95,
      probabilities: { 'Calm and matter-of-fact': 0.01, 'Annoyed but polite': 0.04, 'Angry, threatening to leave': 0.95 },
    },
  });
  assert.equal(answers.frustration.score, 2);
  assert.deepEqual(answers.frustration.probabilities, { 0: 0.01, 1: 0.04, 2: 0.95 });
  assert.doesNotThrow(() => validateAnswers(questions, answers));
});

test('a level name nothing declared is left alone, and refused', () => {
  const questions = { f: { type: 'score', instructions: 'x', criteria: ['a', 'b'] } };
  const answers = normalizeAnswers(questions, { f: { type: 'score', score: 0, probabilities: { 'c': 1 } } });
  assert.deepEqual(answers.f.probabilities, { c: 1 });
  assert.throws(() => validateAnswers(questions, answers), /probabilities/);
});

test('numbered answers are untouched, and other kinds are left alone', () => {
  const questions = {
    f: { type: 'score', instructions: 'x', criteria: ['a', 'b'] },
    spam: { type: 'noul', instructions: 'spam?' },
  };
  const answers = normalizeAnswers(questions, {
    f: { type: 'score', score: 1, probabilities: { 0: 0.2, 1: 0.8 } },
    spam: { type: 'noul', noul: 0.9 },
  });
  assert.deepEqual(answers.f.probabilities, { 0: 0.2, 1: 0.8 });
  assert.equal(answers.spam.noul, 0.9);
});

test("a model's own legend is how its numbering is read", () => {
  const questions = {
    frustration: {
      type: 'score',
      instructions: 'How frustrated is the customer?',
      criteria: ['Calm and matter-of-fact', 'Annoyed but polite', 'Angry, threatening to leave'],
    },
  };
  // What gpt-5-mini answered through AI Gateway: a one-based legend of its own.
  const answers = normalizeAnswers(questions, {
    frustration: {
      type: 'score',
      score: 3,
      legend: { 1: 'Calm and matter-of-fact', 2: 'Annoyed but polite', 3: 'Angry, threatening to leave' },
      confidence: 0.96,
      probabilities: { 0: 0.01, 1: 0.04, 2: 0.95 },
    },
  });
  assert.equal(answers.frustration.score, 2);
  assert.doesNotThrow(() => validateAnswers(questions, answers));
});
