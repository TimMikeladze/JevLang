import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdtemp, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  mcpConnect, mcpClose, mcpListTools, mcpCallTool, mcpRequest, mcpResultText, mcpToolHandler, mcpHandlers,
  McpClientError, paramHeadersProblem,
} from '../src/mcp-client.mjs';
import { McpError, modernVersion, legacyVersions, metaProtocolVersion, metaClientCapabilities } from '../src/mcp.mjs';
import { toolToAction, toolConfirm, snapshotDrift, snapshotToActions, writeMcpImport, readMcpSnapshot, mcpImportSnapshot, jsonSchemaToParameter } from '../src/mcp-import.mjs';
import { policyActions } from '../src/json-schema.mjs';
import { makeDispatcher, dispatch } from '../src/dispatch.mjs';
import { definePolicy, choice, gate, rule, act, confirm, hold } from '../src/index.mjs';
import { skipUnlessInMonorepo } from './monorepo.mjs';

const serverPath = fileURLToPath(new URL('../examples/mcp-policy-server.mjs', import.meta.url));
const answers = {
  department: { type: 'choice', choice: 'billing', confidence: 0.93, probabilities: { billing: 0.93 } },
  frustration: { type: 'score', score: 0.2, confidence: 0.9, probabilities: { 0: 0.8, 1: 0.2, 2: 0 } },
  'refund-requested?': { type: 'noul', noul: 0.1 },
};

test('the client probes, finds a modern server, and calls its tools over stdio', async t => {
  const client = await mcpConnect([process.execPath, serverPath], { timeoutSeconds: 20 });
  t.after(() => mcpClose(client));
  assert.equal(client.era, 'modern');
  assert.equal(client.version, modernVersion);
  assert.equal(client.serverInfo.name, 'jev-ticket-router');
  assert.match(client.instructions, /ticket-router decision policy/);
  const tools = await mcpListTools(client);
  assert.deepEqual(tools.map(t => t.name), ['decide', 'which-room', 'always-fails']);
  const decided = await mcpCallTool(client, 'decide', { answers });
  assert.equal(decided.structuredContent.target, 'billing-queue');
  assert.match(mcpResultText(decided), /assign billing-queue/);
  // A resource read goes through the same client.
  const read = await mcpRequest(client, 'resources/read', { uri: 'jev://policy' });
  assert.equal(JSON.parse(read.contents[0].text).name, 'ticket-router');
  // A tool that raises comes back as a result the caller can read.
  const failed = await mcpCallTool(client, 'always-fails', {});
  assert.equal(failed.isError, true);
  assert.match(mcpResultText(failed), /the door is jammed/);
  // An unknown tool is a JSON-RPC error, with the tool list in its data.
  await assert.rejects(mcpCallTool(client, 'nope', {}), error => error instanceof McpError && /Unknown tool/.test(error.message));
});

test('a tool that needs a person is answered and retried, or comes back unanswered', async t => {
  const asked = [];
  const client = await mcpConnect([process.execPath, serverPath], {
    onElicit: async params => { asked.push(params.message); return { action: 'accept', content: { room: 'kitchen' } }; },
  });
  t.after(() => mcpClose(client));
  const answered = await mcpCallTool(client, 'which-room', {});
  assert.match(mcpResultText(answered), /room: {"action":"accept","content":{"room":"kitchen"}}/);
  assert.deepEqual(asked, ['Which room?']);
  // With nobody to ask, the input-required result comes back as it is.
  const plain = await mcpConnect([process.execPath, serverPath]);
  t.after(() => mcpClose(plain));
  const unanswered = await mcpCallTool(plain, 'which-room', {});
  assert.equal(unanswered.resultType, 'input_required');
  assert.equal(unanswered.requestState, 'asked');
});

test('a server that only speaks a legacy version is met with initialize', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'jev-legacy-mcp-'));
  const path = join(dir, 'legacy-server.mjs');
  await writeFile(path, `
    let buffer = '';
    process.stdin.setEncoding('utf8');
    const send = msg => process.stdout.write(JSON.stringify(msg) + '\\n');
    process.stdin.on('data', chunk => {
      buffer += chunk;
      const lines = buffer.split('\\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (line.trim() === '') continue;
        const msg = JSON.parse(line);
        if (msg.method === 'server/discover') { send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } }); continue; }
        if (msg.method === 'initialize') { send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '${legacyVersions[1]}', capabilities: { tools: {} }, serverInfo: { name: 'old', version: '1' } } }); continue; }
        if (msg.method === 'tools/list') { send({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'ping-back', inputSchema: { type: 'object' } }] } }); continue; }
        if (msg.method === 'tools/call') { send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'pong' }] } }); continue; }
        if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found: ' + msg.method } });
      }
    });
  `);
  const client = await mcpConnect([process.execPath, path], { probeTimeoutSeconds: 2 });
  t.after(() => mcpClose(client));
  assert.equal(client.era, 'legacy');
  assert.equal(client.version, legacyVersions[1]);
  assert.equal(client.serverInfo.name, 'old');
  const called = await mcpCallTool(client, 'ping-back', {});
  // A legacy result has no resultType of its own; the client fills it in.
  assert.equal(called.resultType, 'complete');
  assert.equal(mcpResultText(called), 'pong');
});

test('a silent server times out on the probe, and a dead one is reported', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'jev-silent-mcp-'));
  const silent = join(dir, 'silent.mjs');
  await writeFile(silent, 'process.stdin.resume();\n');
  // Silence means legacy, and initialize then times out: the client says so.
  await assert.rejects(mcpConnect([process.execPath, silent], { probeTimeoutSeconds: 0.2, timeoutSeconds: 0.3 }),
    error => error instanceof McpClientError && error.kind === 'timeout');
  const dying = join(dir, 'dying.mjs');
  await writeFile(dying, 'process.exit(0);\n');
  await assert.rejects(mcpConnect([process.execPath, dying], { probeTimeoutSeconds: 1, timeoutSeconds: 1 }),
    error => error instanceof McpClientError && error.kind === 'connection');
  await assert.rejects(mcpConnect(['no-such-program-anywhere'], {}), /no program named/);
});

test('an HTTP server is met modern first, with the headers the spec asks for', async t => {
  const seen = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', c => { body += c; });
    request.on('end', () => {
      const msg = JSON.parse(body);
      seen.push({ method: msg.method, headers: request.headers });
      const send = result => response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
      if (msg.method === 'server/discover') return send({ supportedVersions: [modernVersion], capabilities: { tools: {} }, _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'over-http', version: '2' } } });
      if (msg.method === 'tools/list') {
        return send({ tools: [
          { name: 'lock-door', inputSchema: { type: 'object', properties: { door: { type: 'string', 'x-mcp-header': 'Door' } }, required: ['door'] } },
          { name: 'bad-headers', inputSchema: { type: 'object', properties: { a: { type: 'object', 'x-mcp-header': 'A' } } } },
        ] });
      }
      if (msg.method === 'tools/call') {
        // An SSE body is a legal answer, and the client reads its data events.
        response.writeHead(200, { 'content-type': 'text/event-stream' })
          .end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'locked' }], structuredContent: { locked: true } } })}\n\n`);
        return undefined;
      }
      return send({});
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const client = await mcpConnect(`http://127.0.0.1:${server.address().port}`, { headers: ['Authorization: Bearer token'] });
  assert.equal(client.era, 'modern');
  assert.equal(client.serverInfo.name, 'over-http');
  // A tool whose x-mcp-header annotations break the rules is left out.
  const tools = await mcpListTools(client);
  assert.deepEqual(tools.map(t => t.name), ['lock-door']);
  const called = await mcpCallTool(client, 'lock-door', { door: 'front' });
  assert.deepEqual(called.structuredContent, { locked: true });
  const call = seen.find(s => s.method === 'tools/call');
  assert.equal(call.headers['mcp-protocol-version'], modernVersion);
  assert.equal(call.headers['mcp-method'], 'tools/call');
  assert.equal(call.headers['mcp-name'], 'lock-door');
  // A parameter the tool annotates travels in its own header, too.
  assert.equal(call.headers['mcp-param-door'], 'front');
  assert.equal(call.headers.authorization, 'Bearer token');
});

test("another server's tools become dispatcher handlers", async t => {
  const client = await mcpConnect([process.execPath, serverPath]);
  t.after(() => mcpClose(client));
  const handlers = await mcpHandlers(client, { only: ['decide'] });
  assert.deepEqual(Object.keys(handlers), ['decide']);
  // The tool returns a decision, so the dispatcher re-dispatches it: that is how
  // another server's answer reaches the queue it names.
  const queued = [];
  const d = makeDispatcher({ ...handlers, 'billing-queue': (state, dec) => { queued.push(dec.target); return 'queued'; } },
    { policyTargets: ['decide', 'billing-queue'] });
  const outcome = await dispatch(d, {}, {
    action: 'act', target: 'decide', reason: null, data: { answers }, rule: 'route', clause: 0,
    source: null, line: null, file: null, model: null, provider: null, requested_model: null,
    requested_effort: null, effective_effort: null, request_id: null, stage: null, proposed: null,
    evidence: [], steps: [], readings: [],
  });
  assert.equal(outcome.status, 'ran');
  assert.equal(outcome.handler, 'billing-queue');
  assert.deepEqual(outcome.chain.map(([key]) => key), ['decide', 'billing-queue']);
  assert.deepEqual(queued, ['billing-queue']);
  // A tool that fails raises, so the dispatcher's plan safeguards see it.
  const failing = mcpToolHandler(client, 'always-fails');
  await assert.rejects(failing({}, { action: 'act', target: 'always-fails', data: {} }), /the MCP tool 'always-fails' failed: the door is jammed/);
  // A tool that asks for input cannot be answered by a dispatcher.
  const asking = mcpToolHandler(client, 'which-room');
  await assert.rejects(asking({}, { action: 'act', target: 'which-room', data: {} }), /asked for more input/);
  // Naming a tool the server does not have is an error, with its tool list.
  await assert.rejects(mcpHandlers(client, { only: ['nope'] }), /has no tool named nope[\s\S]*its tools: decide/);
});

test('Racket oracle: a tool list imports to the same action declarations, and drift reads the same', async t => {
  if (skipUnlessInMonorepo(t)) return;
  const oracle = fileURLToPath(new URL('./mcp-import-oracle.rkt', import.meta.url));
  const run = spawnSync('racket', [oracle], { encoding: 'utf8', env: { ...process.env, TYPESAFE_API_KEY: '', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '' } });
  assert.equal(run.status, 0, run.stderr);
  const expected = JSON.parse(run.stdout);
  const cases = JSON.parse(await readFile(new URL('./parity/mcp-import-cases.json', import.meta.url), 'utf8'));

  // The portable declaration, written the way the Racket form prints.
  const typeText = t => t.type === 'one-of' ? `(one-of ${t.values.join(' ')})`
    : t.type === 'member-of' ? `(member-of ${t.field})`
    : t.type === 'list-of' ? `(list-of ${typeText(t.of)})`
    : t.type;
  const normalize = (name, action) => ({
    name,
    params: Object.entries(action.params).map(([param, t]) => ({
      name: param, type: typeText(t),
      rest: [
        ...(t.type === 'number' && t.min !== undefined ? ['#:range', String(t.min), String(t.max)] : []),
        ...(t.optional ? ['#:optional'] : []),
      ],
    })),
    flags: {
      ...(action.doc ? { doc: action.doc } : {}),
      ...(action.confirm ? { confirm: true } : {}),
      ...(action.minConfidence ? { 'min-confidence': action.minConfidence } : {}),
      ...(action.cooldown ? { cooldown: action.cooldown } : {}),
      ...(action.allow ? { allow: action.allow } : {}),
      ...(action.timeout ? { timeout: action.timeout } : {}),
      ...(action.undo ? { undo: { target: action.undo.target, args: Object.fromEntries(Object.entries(action.undo.params).map(([k, x]) => [k, x.op === 'variable' ? ['param', x.args[0]] : ['value', x.args[0]]])) } } : {}),
    },
  });
  cases.tools.forEach((tool, i) => {
    const mine = toolToAction(tool);
    const want = expected.imported[i];
    assert.equal(toolConfirm(tool), expected.confirm[i], `${tool.name}: confirm`);
    if (want.action === null) {
      // Both refuse the same tools; the sentence differs in its quoting.
      assert.ok(mine.warning, `${tool.name}: expected a warning`);
      assert.match(mine.warning, /^skipped tool /);
    } else {
      assert.ok(!mine.warning, `${tool.name}: ${mine.warning}`);
      assert.deepEqual(normalize(mine.name, mine.action), want.action, `${tool.name}`);
    }
  });
  cases.drift.forEach(([before, after], i) => {
    assert.deepEqual(snapshotDrift(before, after), expected.drift[i], `drift ${i}`);
  });
});

test('imported actions validate, and their JSON Schema round-trips back to the tool', async () => {
  const cases = JSON.parse(await readFile(new URL('./parity/mcp-import-cases.json', import.meta.url), 'utf8'));
  const snapshot = { source: 'test', serverInfo: { name: 'fake', version: '1' }, protocolVersion: modernVersion, era: 'modern', captured_at: '2026-01-01T00:00:00Z', tools: cases.tools };
  const { actions, warnings } = snapshotToActions(snapshot);
  assert.equal(warnings.length, 4);
  assert.ok(actions['unlock-door'], 'the inverse the undo names is declared too');
  // A declared inverse may not itself need confirmation, so a server that calls
  // the inverse destructive has to be overridden deliberately. The validator
  // says so rather than letting a rollback stall on a question.
  const q = choice('q', 'Which?', ['a', 'b']);
  assert.throws(() => definePolicy({
    name: 'confirmed-inverse', questions: [q], state: { rooms: {} }, actions,
    gates: [gate(q, 0.8, hold())], route: { clauses: [], otherwise: hold() },
  }), /undo cannot require confirmation/);
  const declared = { ...actions, 'unlock-door': { ...actions['unlock-door'], confirm: undefined } };
  delete declared['unlock-door'].confirm;
  const policy = definePolicy({
    name: 'imported', questions: [q], state: { rooms: {} }, actions: declared,
    gates: [gate(q, 0.8, hold())],
    route: { clauses: [rule(q.is('a'), confirm(act('lock-door', { door: 'front' })))], otherwise: hold() },
  });
  assert.ok(policy.policy.actions['lock-door'].confirm);
  // An act with a value the declaration forbids does not validate.
  assert.throws(() => definePolicy({
    name: 'bad', questions: [q], state: { rooms: {} }, actions: declared,
    gates: [gate(q, 0.8, hold())],
    route: { clauses: [rule(q.is('a'), confirm(act('lock-door', { door: 'roof' })))], otherwise: hold() },
  }), /one-of/);
  // What came from a tool's schema renders back to that schema, except where the
  // mapping is deliberately lossy: an element type carries no range, and
  // anything that is not a primitive becomes "any value".
  const rendered = Object.fromEntries(policyActions(policy).actions.map(tool => [tool.name, tool.inputSchema]));
  const lossy = new Set(['send-many', 'unbounded']);
  for (const tool of cases.tools) {
    if (!rendered[tool.name] || !tool.inputSchema?.properties || lossy.has(tool.name)) continue;
    assert.deepEqual(rendered[tool.name], {
      type: 'object',
      properties: tool.inputSchema.properties,
      required: tool.inputSchema.required ?? [],
      additionalProperties: false,
    }, `${tool.name} round-trips`);
  }
  // An integer is a number, and a range needs both bounds, so one bound is dropped.
  assert.deepEqual(rendered.unbounded.properties, { n: { type: 'number' } });
  assert.deepEqual(rendered['send-many'].properties, {
    rooms: { type: 'array', items: { type: 'string' } },
    levels: { type: 'array', items: { type: 'number' } },   // the element range is dropped
    payload: {},                                            // an object parameter is any value
  });
  // The import writes the snapshot and a module beside it.
  const dir = await mkdtemp(join(tmpdir(), 'jev-import-'));
  const { modulePath } = await writeMcpImport(snapshot, join(dir, 'tools.json'));
  const loaded = await import(modulePath);
  assert.deepEqual(loaded.actions, actions);
  assert.deepEqual((await readMcpSnapshot(join(dir, 'tools.json'))).tools.length, cases.tools.length);
  const text = await readFile(modulePath, 'utf8');
  assert.match(text, /Generated from test/);
  assert.match(text, /skipped tool hold/);
  assert.equal(paramHeadersProblem({ type: 'object', properties: { a: { type: 'object', 'x-mcp-header': 'A' } } }), 'x-mcp-header is only for string, integer and boolean parameters');
  assert.deepEqual(jsonSchemaToParameter({ type: 'integer' }, false), { type: 'number', optional: true });
});

test('a live snapshot of a server reports no drift against itself', async t => {
  const client = await mcpConnect([process.execPath, serverPath]);
  t.after(() => mcpClose(client));
  const snapshot = await mcpImportSnapshot(client);
  assert.equal(snapshot.era, 'modern');
  assert.equal(snapshot.serverInfo.name, 'jev-ticket-router');
  assert.match(snapshot.captured_at, /^\d{4}-\d{2}-\d{2}T/);
  const again = await mcpImportSnapshot(client);
  assert.deepEqual(snapshotDrift(snapshot.tools, again.tools), { drift: [], notes: [] });
  const { actions } = snapshotToActions(snapshot);
  // decide is read-only, so it needs no confirmation; a tool with no hints does.
  assert.equal(actions.decide.confirm, undefined);
  assert.equal(actions['which-room'].confirm, true);
});
