// MCP, the server side: a policy (or any set of tools) as an MCP server.
//
// MCP 2026-07-28 is stateless. There is no initialize: every request carries its
// protocol version and the client's capabilities in _meta, every result carries a
// resultType, and a server that needs input from a person returns an
// InputRequiredResult instead of sending a request of its own.
//
// Most clients in the field still speak the legacy versions, which open with an
// initialize handshake. So this server is dual-era:
//   - a request carrying the modern _meta is served statelessly
//   - initialize switches that connection to the legacy version it negotiated,
//     and a legacy client with the elicitation capability can be asked a
//     question with a server-to-client request
//   - a request with neither gets -32602, and an unknown version -32022
//
// The core is handleMessage: one parsed JSON-RPC message in, the reply (or null)
// out, with no I/O. serveStdio and httpHandle are thin wrappers around it.
import { object, own, requireAt } from './common.js';
import { policyActions } from './json-schema.js';
import { policyTargetsOf } from './dispatch.js';
import { explainDecision } from './explain.js';

export const modernVersion = '2026-07-28';
export const modernVersions = [modernVersion];
// Newest first; initialize falls back to the first.
export const legacyVersions = ['2025-11-25', '2025-06-18', '2025-03-26'];
export const supportedVersions = [...modernVersions, ...legacyVersions];

export const metaProtocolVersion = 'io.modelcontextprotocol/protocolVersion';
export const metaClientCapabilities = 'io.modelcontextprotocol/clientCapabilities';
export const metaClientInfo = 'io.modelcontextprotocol/clientInfo';
export const metaServerInfo = 'io.modelcontextprotocol/serverInfo';

export const mcpErrorCodes = {
  'parse-error': -32700, 'invalid-request': -32600, 'method-not-found': -32601,
  'invalid-params': -32602, 'internal-error': -32603,
  'header-mismatch': -32020, 'missing-capability': -32021, 'unsupported-version': -32022,
  // Resource not found before 2026-07-28; legacy clients still get it.
  'legacy-resource-not-found': -32002,
};
const codeOf = name => typeof name === 'number' ? name : mcpErrorCodes[name];

export class McpError extends Error {
  constructor(code, message, data = undefined) {
    super(message);
    this.name = 'McpError';
    this.code = codeOf(code);
    this.data = data;
  }
}
export const raiseMcp = (code, message, data) => { throw new McpError(code, message, data); };
export const jsonrpcError = (id, code, message, data = undefined) => ({
  jsonrpc: '2.0',
  ...(id === null || id === undefined ? {} : { id }),
  error: { code, message, ...(data === undefined ? {} : { data }) },
});

// run : (arguments, call) -> a CallToolResult, or an InputRequiredResult.
// Anything it throws becomes a result with isError, except an McpError, which
// becomes that JSON-RPC error.
export const mcpTool = ({ name, title = null, description = null, inputSchema, annotations = null, meta = null, run }) =>
  ({ name, title, description, inputSchema, annotations, meta, run });
export const mcpResource = ({ uri, name, description = null, mimeType = null, read }) =>
  ({ uri, name, description, mimeType, read });

export function makeMcpServer({
  name, version = '0', title = null, instructions = null, tools = [], resources = [],
  methods = {}, fallback = null, capabilities = null, ttlMs = 300_000, cacheScope = 'private',
} = {}) {
  requireAt(typeof name === 'string', 'name', 'an MCP server needs a name');
  const names = tools.map(t => t.name);
  requireAt(new Set(names).size === names.length, 'tools', 'tool names must be unique');
  requireAt(['public', 'private'].includes(cacheScope), 'cacheScope', 'cacheScope is "public" or "private"');
  return {
    info: { name, version, ...(title ? { title } : {}) },
    instructions, tools, resources, methods, fallback, ttlMs, cacheScope,
    capabilities: capabilities ?? {
      ...(tools.length || own(methods, 'tools/list') ? { tools: {} } : {}),
      ...(resources.length || own(methods, 'resources/list') ? { resources: {} } : {}),
    },
  };
}
export const toolToJson = t => ({
  name: t.name, inputSchema: t.inputSchema,
  ...(t.title ? { title: t.title } : {}),
  ...(t.description ? { description: t.description } : {}),
  ...(t.annotations ? { annotations: t.annotations } : {}),
  ...(t.meta ? { _meta: t.meta } : {}),
});

// A CallToolResult with one text block, and structuredContent when given.
export const mcpTextResult = (text, { structured = undefined, error = false } = {}) => ({
  content: [{ type: 'text', text }],
  isError: Boolean(error),
  ...(structured === undefined ? {} : { structuredContent: structured }),
});
// A tool execution error: the model sees it and can correct itself.
export const mcpToolError = text => mcpTextResult(text, { error: true });
export const mcpInputRequired = (requests, { state = null } = {}) => ({
  resultType: 'input_required', inputRequests: requests, ...(state ? { requestState: state } : {}),
});
export const inputRequired = r => object(r) && r.resultType === 'input_required';

// One client: a stdio process, or one HTTP request. sendRequest is how a
// server-to-client request goes out, or null where there is no way back.
export const makeMcpConn = ({ sendRequest = null, legacyVersion = null } = {}) => ({
  era: legacyVersion ? 'legacy' : null, version: legacyVersion,
  capabilities: {}, clientInfo: null, sendRequest,
});

const cacheableMethods = ['tools/list', 'resources/list', 'resources/read', 'resources/templates/list', 'prompts/list', 'server/discover'];
const validId = id => typeof id === 'string' || Number.isInteger(id);

// msg : a parsed JSON-RPC message; conn : the connection it came in on.
// -> the reply to send, or null (a notification, or a response to one of ours).
export async function handleMessage(server, msg, conn) {
  if (!object(msg)) return jsonrpcError(null, mcpErrorCodes['invalid-request'], 'Invalid request: expected a JSON-RPC object');
  const hasId = own(msg, 'id');
  const id = msg.id ?? null;
  const method = msg.method;
  // A response to a request we sent; the transport routes those.
  if (method === undefined && hasId && (own(msg, 'result') || own(msg, 'error'))) return null;
  if (typeof method !== 'string') return jsonrpcError(validId(id) ? id : null, mcpErrorCodes['invalid-request'], "Invalid request: `method' must be a string");
  if (!hasId) return null;  // notifications need no reply
  if (!validId(id)) return jsonrpcError(null, mcpErrorCodes['invalid-request'], 'Invalid request: the id must be a string or an integer');
  try {
    const params = msg.params ?? {};
    if (!object(params)) raiseMcp('invalid-params', "`params' must be an object");
    const result = method === 'initialize'
      ? handleInitialize(server, params, conn)
      : await (async () => {
        const call = requestCall(params, conn);
        return finish(server, method, call, await runMethod(server, method, params, call));
      })();
    return { jsonrpc: '2.0', id, result };
  } catch (error) {
    if (error instanceof McpError) return jsonrpcError(id, error.code, error.message, error.data);
    return jsonrpcError(id, mcpErrorCodes['internal-error'], `Internal error: ${error.message}`);
  }
}

// Which era, version and capabilities serve this request.
function requestCall(params, conn) {
  const meta = params._meta;
  const version = object(meta) ? meta[metaProtocolVersion] : undefined;
  const legacyCall = () => ({
    era: 'legacy', version: conn.version, capabilities: conn.capabilities, clientInfo: conn.clientInfo,
    elicit: legacyElicit(conn), inputResponses: params.inputResponses ?? null, requestState: params.requestState ?? null, params,
  });
  if (version !== undefined && typeof version !== 'string') raiseMcp('invalid-params', `_meta.${metaProtocolVersion} must be a string`);
  if (modernVersions.includes(version)) {
    const capabilities = meta[metaClientCapabilities];
    if (!object(capabilities)) {
      raiseMcp('invalid-params', `missing _meta.${metaClientCapabilities}\n  every ${modernVersion} request carries the client's capabilities ({} for none)`);
    }
    const info = meta[metaClientInfo];
    return {
      era: 'modern', version, capabilities, clientInfo: object(info) ? info : null, elicit: null,
      inputResponses: object(params.inputResponses) ? params.inputResponses : null,
      requestState: typeof params.requestState === 'string' ? params.requestState : null,
      params,
    };
  }
  if (version && conn.era === 'legacy' && legacyVersions.includes(version)) return legacyCall();
  if (version) {
    raiseMcp('unsupported-version', `Unsupported protocol version: ${version}${legacyVersions.includes(version) ? ' (a legacy version: send initialize first)' : ''}`,
      { supported: supportedVersions, requested: version });
  }
  if (conn.era === 'legacy') return legacyCall();
  raiseMcp('invalid-params', `missing _meta.${metaProtocolVersion}\n  a ${modernVersion} request names its version and capabilities in _meta;\n  a legacy client sends initialize first`);
}
// A legacy stdio client that declared elicitation can be asked directly.
const legacyElicit = conn => {
  if (!conn.sendRequest || !object(conn.capabilities?.elicitation)) return null;
  return async (message, schema) => {
    // `mode` arrived in 2025-11-25; older clients do not know the field.
    const base = { message, requestedSchema: schema };
    return conn.sendRequest('elicitation/create', conn.version === '2025-11-25' ? { ...base, mode: 'form' } : base);
  };
};
function handleInitialize(server, params, conn) {
  const asked = params.protocolVersion;
  // The legacy rule: answer the client's version if we have it, else our newest.
  const chosen = legacyVersions.includes(asked) ? asked : legacyVersions[0];
  conn.era = 'legacy';
  conn.version = chosen;
  conn.capabilities = object(params.capabilities) ? params.capabilities : {};
  conn.clientInfo = object(params.clientInfo) ? params.clientInfo : null;
  return {
    protocolVersion: chosen, capabilities: server.capabilities, serverInfo: server.info,
    ...(server.instructions ? { instructions: server.instructions } : {}),
  };
}
const notFound = method => raiseMcp('method-not-found', `Method not found: ${method}`);
// We never hand out cursors, so any cursor is one we did not issue.
const checkNoCursor = params => {
  if (params.cursor) raiseMcp('invalid-params', 'invalid cursor: this server returns every item on the first page');
};
async function runMethod(server, method, params, call) {
  const override = server.methods[method];
  if (override) return override(params, call);
  switch (method) {
    case 'server/discover': return {
      supportedVersions, capabilities: server.capabilities,
      ...(server.instructions ? { instructions: server.instructions } : {}),
    };
    case 'ping': return {};
    case 'tools/list': checkNoCursor(params); return { tools: server.tools.map(toolToJson) };
    case 'tools/call': return callTool(server, params, call);
    case 'resources/list': checkNoCursor(params); return {
      resources: server.resources.map(r => ({
        uri: r.uri, name: r.name,
        ...(r.description ? { description: r.description } : {}),
        ...(r.mimeType ? { mimeType: r.mimeType } : {}),
      })),
    };
    case 'resources/templates/list':
      return own(server.capabilities, 'resources') ? { resourceTemplates: [] } : notFound(method);
    case 'resources/read': return readResource(server, params, call);
    default: return server.fallback ? server.fallback(method, params, call) : notFound(method);
  }
}
async function callTool(server, params, call) {
  const name = params.name;
  if (typeof name !== 'string') raiseMcp('invalid-params', "tools/call needs params.name, the tool's name");
  const tool = server.tools.find(t => t.name === name);
  if (!tool) raiseMcp('invalid-params', `Unknown tool: ${name}`, { tools: server.tools.map(t => t.name) });
  const args = params.arguments ?? {};
  if (!object(args)) return mcpToolError("`arguments' must be an object");
  let result;
  try { result = await tool.run(args, call); } catch (error) {
    if (error instanceof McpError) throw error;
    return mcpToolError(error.message);
  }
  if (!object(result)) raiseMcp('internal-error', `the handler for tool ${name} returned no result object`);
  return result;
}
async function readResource(server, params, call) {
  const uri = params.uri;
  if (typeof uri !== 'string') raiseMcp('invalid-params', 'resources/read needs params.uri');
  const resource = server.resources.find(r => r.uri === uri);
  if (!resource) raiseMcp(call.era === 'legacy' ? 'legacy-resource-not-found' : 'invalid-params', `Resource not found: ${uri}`, { uri });
  return { contents: [{ uri, text: await resource.read(), ...(resource.mimeType ? { mimeType: resource.mimeType } : {}) }] };
}
// resultType, serverInfo and the cache hints for a modern client; none of the
// 2026-07-28 fields for a legacy one.
function finish(server, method, call, r) {
  if (!object(r)) raiseMcp('internal-error', `the ${method} handler returned no object`);
  if (call.era === 'legacy') {
    if (inputRequired(r)) {
      raiseMcp('internal-error', `${method} needs input from the client, and a ${call.version} client can only be asked over stdio with elicitation`);
    }
    const { resultType, ttlMs, cacheScope, ...rest } = r;
    return rest;
  }
  const typed = own(r, 'resultType') ? r : { ...r, resultType: 'complete' };
  const meta = object(typed._meta) ? typed._meta : {};
  const withInfo = { ...typed, _meta: { ...meta, [metaServerInfo]: server.info } };
  if (!cacheableMethods.includes(method) || inputRequired(r)) return withInfo;
  return {
    ...withInfo,
    ...(own(withInfo, 'ttlMs') ? {} : { ttlMs: server.ttlMs }),
    ...(own(withInfo, 'cacheScope') ? {} : { cacheScope: server.cacheScope }),
  };
}

// An Origin header, when present, must be a loopback origin or listed in
// JEV_MCP_ORIGINS. This is the spec's defence against DNS rebinding.
const normalizeOrigin = s => s.toLowerCase().replace(/\/+$/, '');
export const envOrigins = (value = process.env.JEV_MCP_ORIGINS) =>
  (value ?? '').split(',').map(s => normalizeOrigin(s.trim())).filter(s => s.length > 0);
export function originAllowed(origin, allowed = envOrigins()) {
  if (!origin) return true;
  try {
    const url = new URL(origin);
    if (['http:', 'https:'].includes(url.protocol) && ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname)) return true;
  } catch { /* not a URL: only the allow list can permit it */ }
  return allowed.includes(normalizeOrigin(origin));
}
// `=?base64?...?=` is how a header carries a value that is not plain ASCII.
export const decodeHeaderValue = v => {
  const m = typeof v === 'string' ? /^=\?base64\?(.*)\?=$/.exec(v) : null;
  if (!m) return v;
  try { return Buffer.from(m[1], 'base64').toString('utf8'); } catch { return null; }
};
export const encodeHeaderValue = s =>
  /[^\x20-\x7e]/.test(s) || /^\s|\s$/.test(s) || /^=\?base64\?.*\?=$/.test(s)
    ? `=?base64?${Buffer.from(s, 'utf8').toString('base64')}?=`
    : s;

// -> { status, body, headers }, for a POST /mcp route.
export async function httpHandle(server, headers, body, { origins = envOrigins() } = {}) {
  const header = name => headers[name] ?? headers[name.toLowerCase()] ?? null;
  const reject = (status, id, code, message) => ({ status, body: jsonrpcError(id, code, message), headers: {} });
  const origin = header('origin');
  let msg;
  try { msg = JSON.parse(typeof body === 'string' ? body : Buffer.from(body).toString('utf8')); } catch { msg = undefined; }
  if (!originAllowed(origin, origins)) {
    return reject(403, null, mcpErrorCodes['invalid-request'],
      `Forbidden: origin ${origin} is not allowed\n  add it to JEV_MCP_ORIGINS (comma-separated) to allow it`);
  }
  if (msg === undefined) return reject(400, null, mcpErrorCodes['parse-error'], 'Parse error: the body must be one JSON-RPC message');
  if (!object(msg)) return reject(400, null, mcpErrorCodes['invalid-request'], 'Invalid request: send one JSON-RPC object per POST (no batches)');
  if (typeof msg.method !== 'string') return reject(400, null, mcpErrorCodes['invalid-request'], 'Invalid request: this endpoint takes requests and notifications');
  const id = validId(msg.id) ? msg.id : null;
  const params = object(msg.params) ? msg.params : {};
  const bodyVersion = object(params._meta) ? params._meta[metaProtocolVersion] : undefined;
  const headerVersion = header('mcp-protocol-version');
  const modern = typeof bodyVersion === 'string' || (headerVersion && modernVersions.includes(headerVersion));
  const notification = !own(msg, 'id');
  const mismatch = !modern ? null
    : !headerVersion ? 'the MCP-Protocol-Version header is missing'
    : typeof bodyVersion !== 'string' ? null
    : headerVersion !== bodyVersion ? `MCP-Protocol-Version header value '${headerVersion}' does not match body value '${bodyVersion}'`
    : notification ? null
    : header('mcp-method') !== msg.method
      ? (header('mcp-method')
        ? `Mcp-Method header value '${header('mcp-method')}' does not match body value '${msg.method}'`
        : 'the Mcp-Method header is missing')
      : null;
  if (mismatch) return reject(400, id, mcpErrorCodes['header-mismatch'], `Header mismatch: ${mismatch}`);
  // One HTTP request is one connection, so a legacy client cannot be asked
  // anything: there is no way back.
  const conn = makeMcpConn({ legacyVersion: !modern && headerVersion && legacyVersions.includes(headerVersion) ? headerVersion : null });
  const reply = await handleMessage(server, msg, conn);
  return reply ? { status: 200, body: reply, headers: {} } : { status: 202, body: null, headers: {} };
}

// Serves newline-delimited JSON-RPC until the input ends. Requests are answered
// in order, except a handler waiting on a legacy client's answer: the next
// message is read meanwhile, since it may be that answer.
export async function serveStdio(server, { input = process.stdin, output = process.stdout, elicitTimeoutSeconds = 600 } = {}) {
  const pending = new Map();
  let counter = 0, suspendResolve = null;
  const send = msg => output.write(`${JSON.stringify(msg)}\n`);
  const sendRequest = (method, params) => new Promise(resolve => {
    const id = `jev-${counter += 1}`;
    const timer = setTimeout(() => { pending.delete(id); resolve(null); }, elicitTimeoutSeconds * 1000);
    timer.unref?.();
    pending.set(id, reply => {
      clearTimeout(timer);
      resolve(object(reply?.result) ? reply.result : null);
    });
    send({ jsonrpc: '2.0', id, method, params });
    // The reader may continue: the next message may be this answer.
    suspendResolve?.();
  });
  const conn = makeMcpConn({ sendRequest });
  let buffer = '', running = Promise.resolve();
  const lines = [];
  const onData = chunk => { buffer += chunk; const parts = buffer.split('\n'); buffer = parts.pop() ?? ''; lines.push(...parts); };
  input.setEncoding?.('utf8');
  input.on('data', onData);
  const ended = new Promise(resolve => { input.on('end', resolve); input.on('close', resolve); });
  const drain = async () => {
    while (lines.length) {
      const line = lines.shift();
      if (line.trim() === '') continue;
      let msg;
      try { msg = JSON.parse(line); } catch {
        send(jsonrpcError(null, mcpErrorCodes['parse-error'], 'Parse error: each line must be one JSON-RPC message'));
        continue;
      }
      if (object(msg) && !own(msg, 'method') && own(msg, 'id')) {
        pending.get(msg.id)?.(msg);
        pending.delete(msg.id);
        continue;
      }
      // Wait for this handler, unless it suspends on an elicitation.
      const handled = handleMessage(server, msg, conn).then(reply => { if (reply) send(reply); });
      const suspended = new Promise(resolve => { suspendResolve = resolve; });
      running = handled;
      await Promise.race([handled, suspended]);
      suspendResolve = null;
    }
  };
  const pump = setInterval(drain, 1);
  pump.unref?.();
  await ended;
  await drain();
  clearInterval(pump);
  input.off?.('data', onData);
  for (const resolve of pending.values()) resolve(null);
  await running;
}

// The policy as a server: decide from answers you already have, and, when it is
// allowed, evaluate a case with the model. The resources describe the policy and
// its actions.
export function policyMcpServer(policy, { allowEvaluate = false, maxCalls = 100, name = null, evaluate = null } = {}) {
  const spec = policy.policy;
  const label = name ?? spec.name ?? 'policy';
  const meta = { 'jev/questions_sha256': policy.identity() };
  const decideTool = mcpTool({
    name: 'decide', title: 'Decide from answers',
    description: `Run the ${label} policy on answers you already have: the \`answers' object of a provider response, question id -> answer. No model call, no cost. Read the jev://policy resource for the questions.`,
    inputSchema: {
      type: 'object',
      properties: { answers: { type: 'object', description: 'question id -> answer, as a policy provider returns them' } },
      required: ['answers'], additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    meta,
    run: async args => {
      if (!object(args.answers)) return mcpToolError('expected {"answers": {...}}, the answers object of a policy provider response');
      try { return decisionResult(policy, policy.decide(args.answers)); }
      catch (error) { return mcpToolError(error.message); }
    },
  });
  let calls = 0;
  const fields = Object.keys(spec.state ?? {});
  const evaluateTool = mcpTool({
    name: 'evaluate', title: 'Evaluate with the model',
    description: `Send a case to the model and run the ${label} policy on its answers. Each call is billed, and this server allows ${maxCalls} per process.`,
    inputSchema: {
      type: 'object',
      properties: { state: { description: fields.length ? `the input the policy reads; it sends these fields: ${fields.join(', ')}` : "the input the policy's evaluate takes" } },
      required: ['state'], additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    meta,
    run: async args => {
      if (!own(args, 'state')) return mcpToolError('expected {"state": ...}, the input the policy\'s evaluate takes');
      if (!evaluate) return mcpToolError('this server was built without an evaluate function');
      if (calls >= maxCalls) return mcpToolError(`evaluate has run ${maxCalls} times, this server's cap\n  restart it, or raise the cap`);
      calls += 1;
      try { return decisionResult(policy, await evaluate(args.state)); }
      catch (error) { return mcpToolError(error.message); }
    },
  });
  return makeMcpServer({
    name: `jev-${label}`,
    version: spec.version ? String(spec.version) : 'unversioned',
    title: `JevLang policy ${label}`,
    instructions: `This server runs the ${label} decision policy. \`decide' takes the answers of a System One response and returns the decision, the clause that fired and why${allowEvaluate ? "; `evaluate' sends a case to the model first (billed)" : ''}. jev://policy describes the questions, targets and gates; jev://policy/actions lists the actions as JSON Schema.`,
    tools: allowEvaluate ? [decideTool, evaluateTool] : [decideTool],
    resources: [
      mcpResource({ uri: 'jev://policy', name: 'policy', description: 'The policy: questions, targets, gates, thresholds, state fields', mimeType: 'application/json', read: () => JSON.stringify(policyToJson(policy)) }),
      mcpResource({ uri: 'jev://policy/actions', name: 'actions', description: 'Each declared action as JSON Schema, with its safety rules in _meta', mimeType: 'application/json', read: () => JSON.stringify(policyActions(policy)) }),
    ],
    cacheScope: 'private',
  });
}
// The decision as a tool result: the text a person reads, and the decision
// itself with the policy that made it, as the structured content.
const decisionResult = (policy, decision) => {
  const text = explainDecision(decision);
  return mcpTextResult(text, {
    structured: {
      ...decision, explain: text,
      policy: { name: policy.policy.name ?? null, hash: policy.identity(), file: null },
    },
  });
};
// What the jev://policy resource carries: the policy as JSON. The action entries
// are the portable declarations.
export const policyToJson = policy => {
  const spec = policy.policy;
  return {
    name: spec.name ?? null, version: spec.version ?? null, owner: spec.owner ?? null,
    file: null, model: spec.model ?? null,
    questions_sha256: policy.identity(),
    questions: policy.staticQuestions(),
    dynamic_questions: Object.values(spec.questions).some(q => q.optionsFrom || q.over),
    targets: policyTargetsOf(spec),
    computed_targets: policyTargetsOf(spec).includes('computed'),
    gates: spec.gates ?? [],
    thresholds: spec.thresholds ?? {},
    profiles: spec.profiles ?? {},
    state_fields: Object.keys(spec.state ?? {}),
    redactors: spec.stateOptions?.redact ?? [],
    max_chars: spec.stateOptions?.maxChars ?? null,
    actions: Object.entries(spec.actions ?? {}).map(([name, a]) => ({ name, ...a })),
  };
};
