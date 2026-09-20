// MCP, the client side: call another server's tools, and use them as dispatcher
// handlers.
//
//   const c = await mcpConnect(['node', 'examples/mcp-home-server.mjs']);
//   await mcpListTools(c);
//   await mcpCallTool(c, 'lock-door', { door: 'front' });
//   makeDispatcher(await mcpHandlers(c, { policy }), { policy, ... });
//   await mcpClose(c);
//
// It is dual-era, as the spec asks:
//   - stdio: probe with server/discover. A result, or a modern error such as
//     -32022, means a 2026-07-28 server. Any other error, or silence for
//     probeTimeoutSeconds, means a legacy server: fall back to initialize.
//   - HTTP: a modern POST first. A 4xx whose body is not a recognized modern
//     error means legacy, and the client falls back to initialize.
//
// A legacy server may send requests of its own: ping gets {}, and
// elicitation/create goes to onElicit when given, else -32601. A modern server
// asks with an input-required result instead; mcpCallTool answers it through
// onElicit too, and retries.
import { spawn } from 'node:child_process';
import { object, own, requireAt } from './common.mjs';
import { findExecutable } from './provider/command.mjs';
import {
  McpError, jsonrpcError, mcpErrorCodes, modernVersion, modernVersions, legacyVersions, supportedVersions,
  metaProtocolVersion, metaClientCapabilities, metaClientInfo, metaServerInfo, inputRequired, encodeHeaderValue,
} from './mcp.mjs';

const clientInfo = { name: 'jev', version: '2.3' };
const modernErrorCodes = [mcpErrorCodes['header-mismatch'], mcpErrorCodes['missing-capability'], mcpErrorCodes['unsupported-version']];

export class McpClientError extends Error {
  constructor(kind, message, { status = null } = {}) {
    super(message);
    this.name = 'McpClientError';
    this.kind = kind;   // connection | timeout | auth | response
    this.status = status;
  }
}

// target : a command array, like ['npx', '-y', 'some-server'], or an http(s) URL
export async function mcpConnect(target, {
  headers = [], timeoutSeconds = 30, probeTimeoutSeconds = 5, onElicit = null, stderr = 'inherit',
} = {}) {
  const client = typeof target === 'string' && /^https?:\/\//.test(target)
    ? httpClient(target, headers, timeoutSeconds, onElicit)
    : (requireAt(Array.isArray(target) && target.length > 0 && target.every(x => typeof x === 'string'),
      'target', 'an MCP target is a command array or an http(s):// URL'),
      stdioClient(target, timeoutSeconds, onElicit, stderr));
  try {
    await open(client, probeTimeoutSeconds);
  } catch (error) {
    await mcpClose(client, { force: true });
    throw error;
  }
  return client;
}

const clientCapabilities = c => c.onElicit ? { elicitation: { form: {} } } : {};
const modernMeta = c => ({
  [metaProtocolVersion]: modernVersion,
  [metaClientCapabilities]: clientCapabilities(c),
  [metaClientInfo]: clientInfo,
});
const noCommonVersion = (c, versions, message = null) => {
  throw new McpClientError('connection',
    `${c.source} speaks no protocol version this client does${message ? ` (${message})` : ''}\n  it supports: ${versions.length ? versions.join(', ') : "(it didn't say)"}\n  this client: ${supportedVersions.join(', ')}`);
};

async function open(c, probeTimeoutSeconds) {
  const probe = requestMessage(c, 'server/discover', { _meta: modernMeta(c) });
  let status = 0, reply = null;
  try {
    ({ status, reply } = await c.send(probe, modernVersion, probeTimeoutSeconds, { cancel: false }));
  } catch (error) {
    if (error.kind !== 'timeout') throw error;
  }
  const error = object(reply) ? reply.error : null;
  const result = object(reply) ? reply.result : null;
  if (object(result) && status >= 200 && status <= 299) {
    const versions = Array.isArray(result.supportedVersions) ? result.supportedVersions : [];
    if (versions.includes(modernVersion)) {
      c.era = 'modern';
      c.version = modernVersion;
      c.capabilities = object(result.capabilities) ? result.capabilities : {};
      c.instructions = typeof result.instructions === 'string' ? result.instructions : null;
      const info = object(result._meta) ? result._meta[metaServerInfo] : null;
      c.serverInfo = object(info) ? info : null;
      return;
    }
    if (versions.some(v => legacyVersions.includes(v))) return initialize(c);
    noCommonVersion(c, versions);
  }
  // A modern server that does not speak our version: do not fall back.
  if (object(error) && modernErrorCodes.includes(error.code)) {
    const supported = object(error.data) && Array.isArray(error.data.supported) ? error.data.supported : [];
    noCommonVersion(c, supported, error.message ?? '');
  }
  if ([401, 403].includes(status)) {
    throw new McpClientError('auth', `${c.source} answered ${status}\n  it wants credentials: pass headers, or set JEV_MCP_TOKEN`, { status });
  }
  if (status >= 500) throw new McpClientError('connection', `${c.source} answered HTTP ${status} to server/discover`, { status });
  return initialize(c);
}
async function initialize(c) {
  const msg = requestMessage(c, 'initialize', {
    protocolVersion: legacyVersions[0], capabilities: clientCapabilities(c), clientInfo,
  });
  const { status, reply } = await c.send(msg, null, c.timeoutSeconds);
  const result = checkReply(c, 'initialize', status, reply);
  if (!legacyVersions.includes(result.protocolVersion)) noCommonVersion(c, [result.protocolVersion]);
  c.era = 'legacy';
  c.version = result.protocolVersion;
  c.capabilities = object(result.capabilities) ? result.capabilities : {};
  c.serverInfo = object(result.serverInfo) ? result.serverInfo : null;
  c.instructions = typeof result.instructions === 'string' ? result.instructions : null;
  await c.notify({ jsonrpc: '2.0', method: 'notifications/initialized' }, c.version);
}

const requestMessage = (c, method, params) => ({ jsonrpc: '2.0', id: (c.nextId += 1), method, params });
function checkReply(c, method, status, reply) {
  if (!object(reply)) {
    throw new McpClientError('connection', `${c.source} gave no JSON-RPC reply to ${method}${status && status !== 200 ? ` (HTTP ${status})` : ''}`, { status });
  }
  if (object(reply.error)) {
    const e = reply.error;
    throw new McpError(Number.isInteger(e.code) ? e.code : mcpErrorCodes['internal-error'],
      `${c.source}: ${method} failed: ${e.message ?? ''}`, e.data);
  }
  if (object(reply.result)) return reply.result;
  throw new McpClientError('response', `${c.source}: the reply to ${method} has no result object`);
}

// -> the result object. A JSON-RPC error throws an McpError; a timeout or a dead
// server an McpClientError.
export async function mcpRequest(c, method, params = {}, { timeoutSeconds = c.timeoutSeconds, headers = [] } = {}) {
  requireAt(object(params), 'params', 'MCP params are an object');
  const full = c.era === 'modern'
    ? { ...params, _meta: { ...(object(params._meta) ? params._meta : {}), ...modernMeta(c) } }
    : params;
  const msg = requestMessage(c, method, full);
  const { status, reply } = await c.send(msg, c.version, timeoutSeconds, { headers });
  const result = checkReply(c, method, status, reply);
  // Results from servers before 2026-07-28 have no resultType: "complete".
  return own(result, 'resultType') ? result : { ...result, resultType: 'complete' };
}
export const mcpNotify = (c, method, params = {}) => c.notify({ jsonrpc: '2.0', method, params }, c.version);

// Every tool, following nextCursor. Over HTTP, a tool whose x-mcp-header
// annotations break the spec's rules is left out, with a warning, as the spec
// requires of an HTTP client.
export async function mcpListTools(c) {
  const all = [];
  const seen = new Set();
  let cursor = null;
  for (;;) {
    const result = await mcpRequest(c, 'tools/list', cursor ? { cursor } : {});
    all.push(...(Array.isArray(result.tools) ? result.tools.filter(object) : []));
    const next = result.nextCursor;
    if (typeof next !== 'string' || seen.has(next) || seen.size >= 1000) break;
    seen.add(next);
    cursor = next;
  }
  const kept = c.kind !== 'http' ? all : all.filter(tool => {
    const why = paramHeadersProblem(tool.inputSchema);
    if (why) process.stderr.write(`jev mcp: warning: leaving out tool ${tool.name ?? '?'} from ${c.source}: ${why}\n`);
    return !why;
  });
  c.tools = new Map(kept.filter(t => typeof t.name === 'string').map(t => [t.name, t]));
  return kept;
}

// x-mcp-header: tool parameters mirrored into Mcp-Param-<name> headers.
const tokenPattern = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
// [path, annotation, schema] for each x-mcp-header reachable through properties
// alone, where path is the property names from the root.
function reachableParamHeaders(schema, path = []) {
  if (!object(schema)) return [];
  const here = own(schema, 'x-mcp-header') ? [[path, schema['x-mcp-header'], schema]] : [];
  const properties = object(schema.properties) ? schema.properties : null;
  return [
    ...(path.length ? here : []),
    ...(properties ? Object.entries(properties).flatMap(([k, v]) => reachableParamHeaders(v, [...path, k])) : []),
  ];
}
const countAnnotations = v => object(v)
  ? (own(v, 'x-mcp-header') ? 1 : 0) + Object.values(v).reduce((n, x) => n + countAnnotations(x), 0)
  : Array.isArray(v) ? v.reduce((n, x) => n + countAnnotations(x), 0) : 0;
// null when the tool's annotations are fine, else why they are not.
export function paramHeadersProblem(schema) {
  if (!object(schema)) return null;
  const found = reachableParamHeaders(schema);
  const names = found.map(([, name]) => name);
  if (found.length !== countAnnotations(schema)) return 'an x-mcp-header sits somewhere other than a chain of properties';
  if (names.some(n => typeof n !== 'string' || !tokenPattern.test(n))) return 'an x-mcp-header value is not a header-name token';
  const lowered = names.map(n => n.toLowerCase());
  if (new Set(lowered).size !== lowered.length) return 'two x-mcp-header values are the same';
  if (found.some(([, , s]) => !['string', 'integer', 'boolean'].includes(s.type))) return 'x-mcp-header is only for string, integer and boolean parameters';
  return null;
}
const paramHeaders = (tool, args) => reachableParamHeaders(object(tool) ? tool.inputSchema : null)
  .map(([path, name]) => {
    let value = args;
    for (const key of path) value = object(value) ? value[key] : undefined;
    return value === undefined || value === null ? null
      : `Mcp-Param-${name}: ${encodeHeaderValue(typeof value === 'string' ? value : typeof value === 'boolean' ? String(value) : String(value))}`;
  })
  .filter(Boolean);

// -> the CallToolResult. When the server asks for input and every request is an
// elicitation, onElicit answers them and the call is retried, up to three
// rounds; otherwise the input-required result comes back.
export async function mcpCallTool(c, name, args = {}, { inputResponses = null, requestState = null, timeoutSeconds = c.timeoutSeconds } = {}) {
  let responses = inputResponses, state = requestState;
  for (let round = 0; ; round += 1) {
    const params = {
      name, arguments: args,
      ...(responses ? { inputResponses: responses } : {}),
      ...(state ? { requestState: state } : {}),
    };
    let headers = [];
    if (c.kind === 'http' && c.era === 'modern') {
      // The headers come from the tool's schema, so list the tools first.
      if (!c.tools.has(name)) await mcpListTools(c);
      headers = paramHeaders(c.tools.get(name), args);
    }
    const result = await mcpRequest(c, 'tools/call', params, { timeoutSeconds, headers });
    const asks = inputRequired(result) ? result.inputRequests : null;
    const answerable = object(asks) && c.onElicit && round < 3
      && Object.values(asks).every(q => object(q) && q.method === 'elicitation/create');
    if (!answerable) return result;
    const answered = {};
    for (const [key, q] of Object.entries(asks)) answered[key] = await answerElicitation(c, object(q.params) ? q.params : {});
    responses = answered;
    state = typeof result.requestState === 'string' ? result.requestState : null;
  }
}
async function answerElicitation(c, params) {
  try {
    const r = await c.onElicit(params);
    return object(r) ? r : { action: 'cancel' };
  } catch { return { action: 'cancel' }; }
}
export const mcpClose = (c, { force = false } = {}) => c.close(force);
// The text blocks of a result, joined.
export const mcpResultText = r => (Array.isArray(r?.content) ? r.content : [])
  .filter(b => object(b) && b.type === 'text' && typeof b.text === 'string')
  .map(b => b.text).join('\n');

function baseClient({ source, kind, send, notify, close, timeoutSeconds, onElicit }) {
  return {
    source, kind, send, notify, close, timeoutSeconds, onElicit,
    tools: new Map(), era: null, version: null, serverInfo: null, capabilities: {}, instructions: null, nextId: 0,
  };
}

function stdioClient(command, timeoutSeconds, onElicit, stderr) {
  const [name, ...args] = command;
  const executable = findExecutable(name);
  if (!executable) {
    throw new McpClientError('connection', `cannot start the MCP server: no program named ${JSON.stringify(name)}\n  give its full path, or put it on PATH`);
  }
  const source = command.join(' ');
  const child = spawn(executable, args, { stdio: ['pipe', 'pipe', stderr === 'inherit' ? 'inherit' : 'ignore'] });
  if (object(stderr) && typeof stderr.write === 'function') child.stderr?.pipe?.(stderr);
  const pending = new Map();
  let dead = null, buffer = '', client = null;
  const failAll = why => {
    dead = why;
    for (const settle of pending.values()) settle(null);
    pending.clear();
  };
  const write = msg => child.stdin.write(`${JSON.stringify(msg)}\n`);
  const answerServerRequest = async msg => {
    const reply = r => { try { write({ jsonrpc: '2.0', id: msg.id, result: r }); } catch { /* the server is gone */ } };
    if (msg.method === 'ping') { reply({}); return; }
    if (msg.method === 'elicitation/create' && client?.onElicit) {
      reply(await answerElicitation(client, object(msg.params) ? msg.params : {}));
      return;
    }
    try { write(jsonrpcError(msg.id, mcpErrorCodes['method-not-found'], `Method not found: ${msg.method}`)); } catch { /* gone */ }
  };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }   // a misbehaving server's log line
      if (!object(msg)) continue;
      if (own(msg, 'id') && typeof msg.method === 'string') { answerServerRequest(msg); continue; }
      if (own(msg, 'id')) { pending.get(msg.id)?.(msg); pending.delete(msg.id); }
    }
  });
  child.on('error', error => failAll(`cannot run the server: ${error.message}`));
  child.on('close', () => failAll('the server closed its stdout (it exited?)'));

  const send = (msg, version, seconds, { cancel = true } = {}) => new Promise((resolve, reject) => {
    if (dead) { reject(new McpClientError('connection', `${source}: ${dead}`)); return; }
    const timer = setTimeout(() => {
      pending.delete(msg.id);
      if (cancel) notify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: msg.id, reason: `no answer in ${seconds} seconds` } });
      reject(new McpClientError('timeout', `${source} took longer than ${seconds} seconds to answer ${msg.method}`));
    }, seconds * 1000);
    timer.unref?.();
    pending.set(msg.id, reply => {
      clearTimeout(timer);
      if (reply) resolve({ status: 200, reply, headers: {} });
      else reject(new McpClientError('connection', `${source}: ${dead ?? 'no reply'}`));
    });
    try { write(msg); } catch (error) {
      clearTimeout(timer);
      pending.delete(msg.id);
      reject(new McpClientError('connection', `${source}: cannot write to the server: ${error.message}`));
    }
  });
  const notify = msg => { try { write(msg); } catch { /* a notification is best effort */ } };
  let closed = false;
  // The spec's shutdown: close stdin, wait, then signal, then kill.
  const close = async (force = false) => {
    if (closed) return;
    closed = true;
    try { child.stdin.end(); } catch { /* already gone */ }
    if (force) child.kill('SIGKILL');
    const exited = new Promise(resolve => child.once('close', resolve));
    const waited = await Promise.race([exited.then(() => true), new Promise(r => setTimeout(() => r(false), 2000))]);
    if (!waited) {
      child.kill('SIGTERM');
      const again = await Promise.race([exited.then(() => true), new Promise(r => setTimeout(() => r(false), 1000))]);
      if (!again) child.kill('SIGKILL');
    }
    failAll('the connection was closed');
  };
  client = baseClient({ source, kind: 'stdio', send, notify, close, timeoutSeconds, onElicit });
  return client;
}

function httpClient(url, extraHeaders, timeoutSeconds, onElicit) {
  let session = null;
  const headersFor = (msg, version, extra = []) => {
    const params = object(msg.params) ? msg.params : {};
    const named = ['tools/call', 'prompts/get', 'resources/read'].includes(msg.method)
      ? params[msg.method === 'resources/read' ? 'uri' : 'name'] : null;
    return [
      'Content-Type: application/json',
      'Accept: application/json, text/event-stream',
      ...(version ? [`MCP-Protocol-Version: ${version}`] : []),
      ...(modernVersions.includes(version)
        ? [`Mcp-Method: ${msg.method}`, ...(typeof named === 'string' ? [`Mcp-Name: ${encodeHeaderValue(named)}`] : [])]
        : []),
      ...(session ? [`Mcp-Session-Id: ${session}`] : []),
      ...extra, ...extraHeaders,
    ];
  };
  const asObject = lines => Object.fromEntries(lines.map(line => {
    const at = line.indexOf(':');
    return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
  }));
  const post = async (msg, version, seconds, extra) => {
    let response;
    try {
      response = await fetch(url, {
        method: 'POST', headers: asObject(headersFor(msg, version, extra)),
        body: JSON.stringify(msg), signal: AbortSignal.timeout(seconds * 1000),
      });
    } catch (error) {
      const timedOut = error.name === 'TimeoutError' || error.name === 'AbortError';
      throw new McpClientError(timedOut ? 'timeout' : 'connection',
        timedOut ? `${url} took longer than ${seconds} seconds to answer ${msg.method}` : `${url}: ${error.message}`);
    }
    const sessionId = response.headers.get('mcp-session-id');
    if (sessionId && msg.method === 'initialize') session = sessionId;
    const text = await response.text();
    const contentType = response.headers.get('content-type') ?? '';
    const reply = contentType.includes('text/event-stream')
      ? sseReply(text, msg.id)
      : (() => { try { return JSON.parse(text); } catch { return null; } })();
    return { status: response.status, reply, headers: response.headers };
  };
  return baseClient({
    source: url, kind: 'http', timeoutSeconds, onElicit,
    send: (msg, version, seconds, { headers = [] } = {}) => post(msg, version, seconds, headers),
    notify: async (msg, version) => { try { await post(msg, version, timeoutSeconds, []); } catch { /* best effort */ } },
    close: async () => {},
  });
}
// The response with this id among an SSE body's events.
function sseReply(body, id) {
  for (const event of body.split(/\r?\n\r?\n/)) {
    const data = event.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.replace(/^data: ?/, '')).join('\n');
    let msg;
    try { msg = JSON.parse(data); } catch { continue; }
    if (object(msg) && msg.id === id && !own(msg, 'method')) return msg;
  }
  return null;
}

// A (state, decision) handler that calls `tool` with the decision's data as its
// arguments. A result with isError raises, and so does an input-required result:
// a dispatcher cannot answer a person's questions — a confirm handler does that.
export function mcpToolHandler(c, tool, { timeoutSeconds = c.timeoutSeconds } = {}) {
  const name = String(tool);
  const handler = async (state, decision) => {
    const args = object(decision.data) ? decision.data : {};
    const result = await mcpCallTool(c, name, args, { timeoutSeconds });
    if (inputRequired(result)) {
      throw new McpClientError('connection',
        `the MCP tool '${name}' asked for more input, which a dispatcher cannot give\n  ask the person first: make the action confirmed and pass a confirm handler`);
    }
    if (result.isError === true) {
      const text = mcpResultText(result);
      throw new McpClientError('connection', `the MCP tool '${name}' failed: ${text === '' ? '(no message)' : text}`);
    }
    return own(result, 'structuredContent') ? result.structuredContent : result.content ?? [];
  };
  handler.handlerName = name;
  return handler;
}

// tool name -> handler, for: only these names (each must exist on the server),
// else the policy's declared actions the server has, else every tool it lists.
export async function mcpHandlers(c, { only = null, policy = null, timeoutSeconds = c.timeoutSeconds } = {}) {
  const have = (await mcpListTools(c)).map(t => t.name).filter(n => typeof n === 'string');
  let names;
  if (only) {
    const want = only.map(String);
    const missing = want.filter(n => !have.includes(n));
    if (missing.length) {
      throw new McpClientError('connection',
        `${c.source} has no tool${missing.length === 1 ? '' : 's'} named ${missing.join(', ')}\n  its tools: ${have.join(', ')}`);
    }
    names = want;
  } else if (policy) {
    names = Object.keys(policy.policy.actions ?? {}).filter(n => have.includes(n));
  } else names = have;
  return Object.fromEntries(names.map(n => [n, mcpToolHandler(c, n, { timeoutSeconds })]));
}
