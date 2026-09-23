import test from 'node:test';
import assert from 'node:assert/strict';
import { noul, definePolicy, rule, assign, hold } from '../src/index.js';
import { evaluateWithProvider } from '../src/evaluate.js';
import { ProviderRegistry, mergeProviderConfig, openaiProvider, anthropicProvider, gatewayProvider, vercelOidcToken } from '../src/provider/index.js';

const spam = noul('spam?', 'Is this message spam?');
const policy = definePolicy({
  name: 'hello', questions: [spam],
  route: { clauses: [rule(spam.yes(0.9), hold({ reason: 'spam' }))], otherwise: assign('inbox') },
});
const answers = { 'spam?': { type: 'noul', noul: 0.95 } };
const decide = (value, id) => {
  const registry = new ProviderRegistry();
  registry.register(value);
  return evaluateWithProvider(policy, 'win a prize', { registry, config: mergeProviderConfig({ project: { provider: id } }) });
};
const fakeFetch = (status, body, seen = []) => async (url, init) => {
  seen.push({ url, init, body: JSON.parse(init.body) });
  return new Response(JSON.stringify(body), { status, headers: { 'x-request-id': 'req-1' } });
};

test('openai: sends the answer schema as a json_schema response format and decides from the answers', async () => {
  const seen = [];
  const decision = await decide(openaiProvider({ apiKey: 'k', fetch: fakeFetch(200, { model: 'gpt-x', choices: [{ message: { content: JSON.stringify(answers) } }] }, seen) }), 'openai');
  assert.equal(decision.action, 'hold');
  assert.equal(decision.provider, 'openai');
  assert.equal(decision.request_id, 'req-1');
  assert.equal(seen[0].url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(seen[0].init.headers.authorization, 'Bearer k');
  assert.deepEqual(Object.keys(seen[0].body.response_format.json_schema.schema.properties), ['spam?']);
});

test('gateway: the same protocol at the AI Gateway URL', async () => {
  const seen = [];
  await decide(gatewayProvider({ apiKey: 'g', fetch: fakeFetch(200, { choices: [{ message: { content: JSON.stringify(answers) } }] }, seen) }), 'gateway');
  assert.equal(seen[0].url, 'https://ai-gateway.vercel.sh/v1/chat/completions');
  assert.equal(seen[0].body.model, 'openai/gpt-5-mini');
});

test('anthropic: forces a tool call whose input is the answer object', async () => {
  const seen = [];
  const decision = await decide(anthropicProvider({ apiKey: 'a', fetch: fakeFetch(200, { content: [{ type: 'tool_use', name: 'answer', input: answers }] }, seen) }), 'anthropic');
  assert.equal(decision.action, 'hold');
  assert.equal(seen[0].init.headers['x-api-key'], 'a');
  assert.deepEqual(seen[0].body.tool_choice, { type: 'tool', name: 'answer' });
});

test('HTTP failures map to provider error kinds; a missing key is not ready', async () => {
  await assert.rejects(decide(openaiProvider({ apiKey: 'k', fetch: fakeFetch(429, { error: 'slow down' }) }), 'openai'),
    error => error.attempts.some(a => a.outcome === 'rate-limit'));
  await assert.rejects(decide(openaiProvider({ apiKey: 'k', fetch: fakeFetch(401, {}) }), 'openai'),
    error => error.kind === 'authentication' || error.attempts.some(a => a.outcome === 'authentication'));
  assert.equal((await openaiProvider({ apiKey: () => null }).discover()).status, 'unauthenticated');
});

test('gateway: inside a Vercel Function the OIDC token comes from the request context', async () => {
  const key = Symbol.for('@vercel/request-context');
  globalThis[key] = { get: () => ({ headers: { 'x-vercel-oidc-token': 'oidc-from-request' } }) };
  try {
    assert.equal(vercelOidcToken(), 'oidc-from-request');
    assert.equal((await gatewayProvider().discover()).status, 'ready');
  } finally { delete globalThis[key]; }
});

test('the schema sent to a model API requires confidence wherever an answer offers it', async () => {
  const seen = [];
  const { choice, gate } = await import('../src/index.js');
  const kind = choice('kind', 'Which?', ['a', 'b']);
  const gated = definePolicy({ name: 'gated', questions: [kind, spam], gates: [gate(kind, 0.8, hold())], route: { clauses: [rule(kind.is('a'), hold())], otherwise: assign('inbox') } });
  const registry = new ProviderRegistry();
  registry.register(openaiProvider({ apiKey: 'k', fetch: fakeFetch(200, { choices: [{ message: { content: JSON.stringify({ kind: { type: 'choice', choice: 'a', confidence: 0.9 }, ...answers }) } }] }, seen) }));
  await evaluateWithProvider(gated, 'x', { registry, config: mergeProviderConfig({ project: { provider: 'openai' } }) });
  const props = seen[0].body.response_format.json_schema.schema.properties;
  assert.ok(props.kind.required.includes('confidence'));
  assert.deepEqual(props['spam?'].required, ['type', 'noul']);
});
