import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { startServer, handleRequest, makeServeDispatchers, serveRoute, tokenMatches, loopbackHost } from '../src/serve.js';
import { policyMcpServer, httpHandle, modernVersion, metaProtocolVersion, metaClientCapabilities } from '../src/mcp.js';
import { policy as ticket } from '../examples/ticket-router.js';

const answers = {
  department: { type: 'choice', choice: 'billing', confidence: 0.93, probabilities: { billing: 0.93 } },
  frustration: { type: 'score', score: 0.2, confidence: 0.9, probabilities: { 0: 0.8, 1: 0.2, 2: 0 } },
  'refund-requested?': { type: 'noul', noul: 0.1 },
};
const evaluate = async () => ticket.decide(answers);
const post = (url, path, body, headers = {}) => fetch(`${url}${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
});

test('the sidecar serves the policy, decides, and says what it does not know', async t => {
  const server = await startServer(ticket, { port: 0, evaluate });
  t.after(() => server.stop());
  assert.deepEqual(await (await fetch(`${server.url}/healthz`)).json(), { ok: true, policy: 'ticket-router' });
  const described = await (await fetch(`${server.url}/policy`)).json();
  assert.deepEqual(Object.keys(described.questions).sort(), ['department', 'frustration', 'refund-requested?']);
  const decided = await post(server.url, '/decide', { answers });
  assert.equal(decided.status, 200);
  const decision = await decided.json();
  assert.equal(decision.target, 'billing-queue');
  assert.match(decision.explain, /assign billing-queue/);
  assert.equal(decision.policy.hash, ticket.identity());
  // /evaluate asks the provider; here that is the injected evaluate.
  const evaluated = await post(server.url, '/evaluate', { state: { ticket: 'a refund' } });
  assert.equal((await evaluated.json()).target, 'billing-queue');

  // A route that does not exist lists the ones that do; a wrong method says so.
  const missing = await fetch(`${server.url}/nope`);
  assert.equal(missing.status, 404);
  assert.ok((await missing.json()).routes.includes('POST /decide'));
  const wrongMethod = await fetch(`${server.url}/decide`);
  assert.equal(wrongMethod.status, 405);
  // A bad body, and answers that do not fit the questions.
  const badJson = await fetch(`${server.url}/decide`, { method: 'POST', body: 'nonsense' });
  assert.equal(badJson.status, 400);
  assert.equal((await badJson.json()).kind, 'request');
  const missingKey = await post(server.url, '/decide', { nope: true });
  assert.equal(missingKey.status, 400);
  const badAnswers = await post(server.url, '/decide', { answers: { department: { type: 'choice', choice: 'nope' } } });
  assert.equal(badAnswers.status, 422);
  assert.equal((await badAnswers.json()).kind, 'answers');
});

test('a token guards everything but the health check, and a wrong one is 401', async t => {
  const server = await startServer(ticket, { port: 0, token: 'sekret', evaluate });
  t.after(() => server.stop());
  assert.equal((await fetch(`${server.url}/healthz`)).status, 200);
  assert.equal((await fetch(`${server.url}/policy`)).status, 401);
  assert.equal((await fetch(`${server.url}/policy`, { headers: { authorization: 'Bearer nope' } })).status, 401);
  assert.equal((await fetch(`${server.url}/policy`, { headers: { authorization: 'Bearer sekret' } })).status, 200);
  assert.equal((await post(server.url, '/decide', { answers }, { authorization: 'Bearer sekret' })).status, 200);
  assert.ok(tokenMatches('sekret', 'Bearer sekret'));
  assert.ok(!tokenMatches('sekret', 'Bearer sekre'));
  assert.ok(!tokenMatches('sekret', 'sekret'));
  assert.ok(loopbackHost('127.0.0.1') && loopbackHost('::1') && !loopbackHost('0.0.0.0'));
});

test('/dispatch runs handlers, dry-runs on request, and is refused where it must be', async t => {
  const ran = [];
  const handlers = {
    'billing-queue': (state, d) => { ran.push(d.target); return 'queued'; },
    'engineering-oncall': () => 'ok', 'sales-inbox': () => 'ok', 'retention-oncall': () => 'ok', 'human-triage': () => 'ok',
  };
  const dispatchers = makeServeDispatchers(ticket, handlers);
  const server = await startServer(ticket, { port: 0, dispatchers, evaluate });
  t.after(() => server.stop());
  const dispatched = await post(server.url, '/dispatch', { input: { ticket: 'a refund' }, key: 'req-1' });
  assert.equal(dispatched.status, 200);
  const outcome = await dispatched.json();
  assert.equal(outcome.status, 'ran');
  assert.equal(outcome.handler, 'billing-queue');
  assert.match(outcome.explain, /assign billing-queue/);
  assert.deepEqual(ran, ['billing-queue']);
  // A dry run reports what would run and runs nothing.
  const rehearsed = await post(server.url, '/dispatch', { input: { ticket: 'a refund' }, dry_run: true });
  assert.equal((await rehearsed.json()).status, 'dry-run');
  assert.deepEqual(ran, ['billing-queue']);
  // Answers in the body decide without asking a provider.
  const offline = await post(server.url, '/dispatch', { input: { ticket: 'x' }, answers, key: 'req-2' });
  assert.equal((await offline.json()).status, 'ran');
  // A server with no handlers says so.
  const bare = await startServer(ticket, { port: 0, evaluate });
  t.after(() => bare.stop());
  assert.equal((await post(bare.url, '/dispatch', { input: {} })).status, 400);
  // Bound off loopback with no token, only a dry run is allowed.
  const open = await startServer(ticket, { port: 0, host: '0.0.0.0', dispatchers, evaluate });
  t.after(() => open.stop());
  const refused = await post(`http://127.0.0.1:${open.port}`, '/dispatch', { input: { ticket: 'x' } });
  assert.equal(refused.status, 403);
  assert.equal((await refused.json()).kind, 'forbidden');
  const allowedDry = await post(`http://127.0.0.1:${open.port}`, '/dispatch', { input: { ticket: 'x' }, dry_run: true });
  assert.equal(allowedDry.status, 200);
});

test('extra routes are served, with their own auth', async t => {
  const mcp = policyMcpServer(ticket);
  const seen = [];
  const routes = [
    serveRoute({
      method: 'POST', path: '/mcp', auth: 'token',
      handler: async (method, path, headers, body) => httpHandle(mcp, headers, body),
    }),
    serveRoute({
      method: 'POST', path: '/webhook/', prefix: true, auth: 'open',
      handler: async (method, path, headers, body) => { seen.push(path); return { status: 202, body: { accepted: true } }; },
    }),
  ];
  const server = await startServer(ticket, { port: 0, token: 'sekret', routes, evaluate });
  t.after(() => server.stop());
  // A token route needs the token.
  const meta = { [metaProtocolVersion]: modernVersion, [metaClientCapabilities]: {} };
  assert.equal((await post(server.url, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: meta } })).status, 401);
  const listed = await post(server.url, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: meta } }, {
    authorization: 'Bearer sekret', 'mcp-protocol-version': modernVersion, 'mcp-method': 'tools/list',
  });
  assert.equal(listed.status, 200);
  assert.deepEqual((await listed.json()).result.tools.map(t => t.name), ['decide']);
  // An open route authenticates itself, so no token is needed.
  const delivered = await post(server.url, '/webhook/tickets', { type: 'ticket.created' });
  assert.equal(delivered.status, 202);
  assert.deepEqual(seen, ['/webhook/tickets']);
  // A prefix route still answers 405 for the wrong method.
  const wrong = await fetch(`${server.url}/webhook/tickets`);
  assert.equal(wrong.status, 405);
  assert.equal(wrong.headers.get('allow'), 'POST');
});

test('a taken port is stepped over, never taken from whoever holds it', async t => {
  const holder = createServer(() => {});
  await new Promise(resolve => holder.listen(0, '127.0.0.1', resolve));
  const taken = holder.address().port;
  t.after(() => holder.close());
  const server = await startServer(ticket, { port: taken, evaluate });
  t.after(() => server.stop());
  assert.equal(server.wanted, taken);
  assert.ok(server.port > taken, 'it moved to a free port');
  // The other server still holds its own port.
  assert.equal(holder.listening, true);
  assert.deepEqual(await (await fetch(`${server.url}/healthz`)).json(), { ok: true, policy: 'ticket-router' });
});

test('handleRequest is a pure function, so a host can route however it likes', async () => {
  const answered = await handleRequest(ticket, 'POST', '/decide', JSON.stringify({ answers }));
  assert.equal(answered.status, 200);
  assert.equal(answered.body.target, 'billing-queue');
  // No token check here: that belongs to the HTTP layer.
  const described = await handleRequest(ticket, 'GET', '/policy', null);
  assert.equal(described.body.name, 'ticket-router');
  const unsupported = await handleRequest(ticket, 'POST', '/evaluate', JSON.stringify({ state: {} }));
  assert.equal(unsupported.status, 501);
  // A trailing slash and a query string name the same route.
  assert.equal((await handleRequest(ticket, 'GET', '/healthz/?x=1', null)).status, 200);
});

test('a body over maxBody is refused with 413 before it is parsed', async t => {
  const server = await startServer(ticket, { port: 0, maxBody: 64 });
  t.after(() => server.stop());
  const response = await fetch(`${server.url}/decide`, { method: 'POST', body: JSON.stringify({ answers: {}, pad: 'x'.repeat(500) }) });
  assert.equal(response.status, 413);
  assert.equal((await response.json()).kind, 'too-large');
});
