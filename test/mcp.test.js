import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import {
  policyMcpServer, makeMcpServer, makeMcpConn, mcpTool, mcpResource, handleMessage, httpHandle,
  mcpTextResult, mcpToolError, mcpInputRequired, inputRequired, originAllowed, encodeHeaderValue, decodeHeaderValue,
  serveStdio, modernVersion, legacyVersions, supportedVersions, metaProtocolVersion, metaClientCapabilities, metaServerInfo, policyToJson,
} from '../src/mcp.js';
import { policy as ticket } from '../examples/ticket-router.js';

const modernMeta = { [metaProtocolVersion]: modernVersion, [metaClientCapabilities]: {} };
const answers = {
  department: { type: 'choice', choice: 'billing', confidence: 0.93, probabilities: { billing: 0.93 } },
  frustration: { type: 'score', score: 0.2, confidence: 0.9, probabilities: { 0: 0.8, 1: 0.2, 2: 0 } },
  'refund-requested?': { type: 'noul', noul: 0.1 },
};

test('a modern request is served statelessly, and a legacy one only after initialize', async () => {
  const server = policyMcpServer(ticket);
  const fresh = () => makeMcpConn();
  // Modern: no handshake, and the reply carries resultType and the server info.
  const listed = await handleMessage(server, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: modernMeta } }, fresh());
  assert.equal(listed.result.resultType, 'complete');
  assert.deepEqual(listed.result._meta[metaServerInfo].name, 'jev-ticket-router');
  assert.equal(listed.result.cacheScope, 'private');
  // A legacy version before initialize is refused, and says what to do.
  const early = await handleMessage(server, { jsonrpc: '2.0', id: 2, method: 'ping', params: { _meta: { [metaProtocolVersion]: legacyVersions[0], [metaClientCapabilities]: {} } } }, fresh());
  assert.equal(early.error.code, -32022);
  assert.match(early.error.message, /send initialize first/);
  assert.deepEqual(early.error.data.supported, supportedVersions);
  // After initialize the same connection is legacy, and its replies carry none
  // of the 2026-07-28 fields.
  const conn = fresh();
  const handshake = await handleMessage(server, { jsonrpc: '2.0', id: 3, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'hand', version: '0' } } }, conn);
  assert.equal(handshake.result.protocolVersion, '2025-06-18');
  const legacy = await handleMessage(server, { jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} }, conn);
  assert.equal(legacy.result.resultType, undefined);
  assert.equal(legacy.result.ttlMs, undefined);
  assert.equal(legacy.result._meta, undefined);
  // An unknown version the client asks to initialize with falls back to ours.
  const odd = await handleMessage(server, { jsonrpc: '2.0', id: 5, method: 'initialize', params: { protocolVersion: '1999-01-01' } }, fresh());
  assert.equal(odd.result.protocolVersion, legacyVersions[0]);
});

test('decide runs the policy, and a tool error is a result the model can read', async () => {
  const server = policyMcpServer(ticket);
  const conn = makeMcpConn();
  const called = await handleMessage(server, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { _meta: modernMeta, name: 'decide', arguments: { answers } } }, conn);
  assert.equal(called.result.isError, false);
  assert.equal(called.result.structuredContent.target, 'billing-queue');
  assert.match(called.result.content[0].text, /assign billing-queue/);
  // Answers that do not fit the questions are a tool error, not a JSON-RPC one.
  const bad = await handleMessage(server, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { _meta: modernMeta, name: 'decide', arguments: { answers: { department: { type: 'choice', choice: 'nope' } } } } }, conn);
  assert.equal(bad.result.isError, true);
  assert.match(bad.result.content[0].text, /not a declared option|missing question answer/);
  // evaluate is only there when it is allowed, and it is capped.
  const listed = await handleMessage(server, { jsonrpc: '2.0', id: 3, method: 'tools/list', params: { _meta: modernMeta } }, conn);
  assert.deepEqual(listed.result.tools.map(t => t.name), ['decide']);
  const withEvaluate = policyMcpServer(ticket, { allowEvaluate: true, maxCalls: 1, evaluate: async () => ticket.decide(answers) });
  const first = await handleMessage(withEvaluate, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { _meta: modernMeta, name: 'evaluate', arguments: { state: { ticket: 'x' } } } }, conn);
  assert.equal(first.result.structuredContent.target, 'billing-queue');
  const second = await handleMessage(withEvaluate, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { _meta: modernMeta, name: 'evaluate', arguments: { state: { ticket: 'x' } } } }, conn);
  assert.match(second.result.content[0].text, /has run 1 times/);
});

test('a tool can ask for input, and a legacy client can be asked over stdio', async () => {
  const asking = mcpTool({
    name: 'ask', inputSchema: { type: 'object' },
    run: async (args, call) => {
      if (call.inputResponses) return mcpTextResult(`heard ${JSON.stringify(call.inputResponses)}`);
      if (call.elicit) {
        const answer = await call.elicit('Which room?', { type: 'object' });
        return mcpTextResult(`elicited ${JSON.stringify(answer?.content ?? null)}`);
      }
      return mcpInputRequired({ room: { method: 'elicitation/create', params: { message: 'Which room?' } } }, { state: 'abc' });
    },
  });
  const server = makeMcpServer({ name: 'asking', tools: [asking] });
  // A modern client is told what is needed, and retries with the answers.
  const needed = await handleMessage(server, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { _meta: modernMeta, name: 'ask', arguments: {} } }, makeMcpConn());
  assert.ok(inputRequired(needed.result));
  assert.equal(needed.result.requestState, 'abc');
  // input_required is not cached, and keeps its own resultType.
  assert.equal(needed.result.ttlMs, undefined);
  const retried = await handleMessage(server, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { _meta: modernMeta, name: 'ask', arguments: {}, inputResponses: { room: 'kitchen' } } }, makeMcpConn());
  assert.match(retried.result.content[0].text, /heard {"room":"kitchen"}/);
  // A legacy client that declared elicitation is asked directly.
  const sent = [];
  const conn = makeMcpConn({ sendRequest: async (method, params) => { sent.push([method, params]); return { content: { room: 'bedroom' } }; } });
  await handleMessage(server, { jsonrpc: '2.0', id: 3, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: { elicitation: {} } } }, conn);
  const elicited = await handleMessage(server, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'ask', arguments: {} } }, conn);
  assert.match(elicited.result.content[0].text, /elicited {"room":"bedroom"}/);
  assert.deepEqual(sent[0][0], 'elicitation/create');
  assert.equal(sent[0][1].mode, 'form');
  // A legacy client with no way back cannot be handed an input_required.
  const legacyOnly = makeMcpConn({ legacyVersion: '2025-06-18' });
  const refused = await handleMessage(server, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'ask', arguments: {} } }, legacyOnly);
  assert.equal(refused.error.code, -32603);
  assert.match(refused.error.message, /can only be asked over stdio with elicitation/);
});

test('POST /mcp checks the origin and the headers that must match the body', async () => {
  const server = policyMcpServer(ticket);
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: modernMeta } });
  const headers = { 'mcp-protocol-version': modernVersion, 'mcp-method': 'tools/list' };
  const ok = await httpHandle(server, headers, body);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.result.resultType, 'complete');
  // A header that disagrees with the body is a header mismatch.
  const mismatched = await httpHandle(server, { ...headers, 'mcp-method': 'tools/call' }, body);
  assert.equal(mismatched.status, 400);
  assert.equal(mismatched.body.error.code, -32020);
  const missing = await httpHandle(server, { 'mcp-method': 'tools/list' }, body);
  assert.equal(missing.body.error.code, -32020);
  // A foreign origin is refused; loopback and an allowed origin are not.
  const foreign = await httpHandle(server, { ...headers, origin: 'https://evil.example' }, body);
  assert.equal(foreign.status, 403);
  assert.equal((await httpHandle(server, { ...headers, origin: 'http://localhost:3000' }, body)).status, 200);
  assert.equal((await httpHandle(server, { ...headers, origin: 'https://app.example.com' }, body, { origins: ['https://app.example.com'] })).status, 200);
  assert.ok(originAllowed(null));
  assert.ok(!originAllowed('https://evil.example', []));
  // A batch, a bad body and a response are all refused.
  assert.equal((await httpHandle(server, headers, '[{"jsonrpc":"2.0"}]')).body.error.code, -32600);
  assert.equal((await httpHandle(server, headers, 'not json')).body.error.code, -32700);
  // A notification is accepted with no body.
  const notified = await httpHandle(server, { 'mcp-protocol-version': modernVersion }, JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: { _meta: modernMeta } }));
  assert.equal(notified.status, 202);
  assert.equal(notified.body, null);
  // A header value that is not plain ASCII travels base64-encoded.
  assert.equal(decodeHeaderValue(encodeHeaderValue('naïve')), 'naïve');
  assert.equal(encodeHeaderValue('plain'), 'plain');
});

test('stdio serves newline-delimited JSON-RPC and nothing else', async () => {
  const input = new PassThrough(), output = new PassThrough();
  const written = [];
  output.on('data', chunk => written.push(...chunk.toString('utf8').split('\n').filter(l => l !== '')));
  const server = policyMcpServer(ticket);
  const serving = serveStdio(server, { input, output });
  input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: modernMeta } })}\n`);
  input.write('not json\n');
  input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { _meta: modernMeta, name: 'decide', arguments: { answers } } })}\n`);
  input.end();
  await serving;
  const replies = written.map(line => JSON.parse(line));
  assert.deepEqual(replies.map(r => r.id ?? null), [1, null, 2]);
  assert.equal(replies[1].error.code, -32700);
  assert.equal(replies[2].result.structuredContent.target, 'billing-queue');
});

test('the policy resource describes the policy the server runs', () => {
  const described = policyToJson(ticket);
  assert.equal(described.name, 'ticket-router');
  assert.deepEqual(described.state_fields, ['ticket']);
  assert.deepEqual(described.targets.sort(), ['billing-queue', 'engineering-oncall', 'human-triage', 'retention-oncall', 'sales-inbox']);
  assert.equal(described.dynamic_questions, false);
  assert.equal(described.questions_sha256, ticket.identity());
  assert.deepEqual(Object.keys(described.questions).sort(), ['department', 'frustration', 'refund-requested?']);
});
