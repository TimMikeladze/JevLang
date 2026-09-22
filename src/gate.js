// The gate: a policy that decides whether an agent's tool call runs.
//
// Two front ends share one state shape and one verdict mapping:
//   - a Claude Code or Codex PreToolUse hook
//   - a stdio MCP server in front of another one
//
// The state the policy sees:
//   {"tool", "arguments", "source": "mcp-proxy" | "claude-code" | "codex",
//    "server", "annotations"}
//
// The verdict fails closed:
//   - assign / page / escalate to allow, deny or ask means that verdict
//   - hold and confirm mean ask
//   - anything else means deny, with a reason that says so
// The deny and allow lists run before the model, so hard rules stay in code.
// When the policy cannot decide (no key, the API is down), the verdict is
// onError: ask for the hook, deny for the proxy.
//
// Asking a person, in the proxy:
//   - a 2026-07-28 client with the elicitation capability gets an input-required
//     result with an approve/deny form. Its requestState is HMAC-signed with a
//     per-process key, expires, and names a digest of the tool and its
//     arguments, so an approval cannot be replayed on another call. An approved
//     retry runs the tool without asking the model again.
//   - a legacy client with the capability gets elicitation/create
//   - any other client cannot ask, so the call is denied
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile, rename, rmdir, stat, chmod } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { canonical, object, own, requireAt, finite } from './common.js';
import { explainDecision } from './explain.js';
import {
  makeMcpServer, mcpToolError, mcpInputRequired, inputRequired, raiseMcp, McpError,
} from './mcp.js';
import { mcpCallTool, mcpListTools, mcpRequest } from './mcp-client.js';

const sha256Hex = text => createHash('sha256').update(text).digest('hex');
const hmac = (key, text) => createHmac('sha256', key).update(text).digest();
const base64url = buffer => Buffer.from(buffer).toString('base64url');
const fromBase64url = text => { try { return Buffer.from(text, 'base64url'); } catch { return null; } };
const sameBytes = (a, b) => a.length === b.length && timingSafeEqual(a, b);
const nowIso = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');
const firstLine = s => String(s).replace(/^jev: /, '').split('\n')[0];

// policy   : the compiled policy the gate asks
// evaluate : (state) -> a decision (the model call); a throw means onError
// allow, deny : tool name patterns, where * matches any run of characters
// onError  : 'ask' or 'deny'
// log      : a JSONL file for one line per verdict, or null
// onCapture: called with (state, decision) after the policy decides, so a
//            caller can record a fixture
export function makeGate(policy, { evaluate, allow = [], deny = [], onError = 'ask', log = null, onCapture = null, label = null, policyHash = null } = {}) {
  requireAt(typeof evaluate === 'function', 'evaluate', 'a gate needs an evaluate function for its policy');
  requireAt(['ask', 'deny'].includes(onError), 'onError', "onError is 'ask' or 'deny'");
  for (const [name, list] of [['allow', allow], ['deny', deny]]) {
    requireAt(Array.isArray(list) && list.every(x => typeof x === 'string'), name, 'a tool list is an array of patterns');
  }
  return {
    policy, evaluate, allow, deny, onError, log, onCapture,
    label: label ?? policy?.policy?.name ?? 'gate',
    policyHash: policyHash ?? policy?.identity?.() ?? null,
    writing: Promise.resolve(),
  };
}
// "a,b, c" -> ['a', 'b', 'c']
export const parseToolList = s => s.split(',').map(x => x.trim()).filter(x => x.length > 0);
const globPattern = g => new RegExp(`^${g.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
export const toolMatches = (patterns, tool) => typeof tool === 'string' && patterns.some(p => globPattern(p).test(tool));

export const gateState = (tool, args, { source, server = null, annotations = null } = {}) => ({
  tool, arguments: object(args) || Array.isArray(args) ? args : {},
  source, server: server ?? null, annotations: object(annotations) ? annotations : null,
});

// -> { verdict, reason }
export function decisionToVerdict(d) {
  const reason = d.reason ?? explainDecision(d).split('\n')[0];
  if (['assign', 'page', 'escalate'].includes(d.action) && ['allow', 'deny', 'ask'].includes(d.target)) {
    return { verdict: d.target, reason };
  }
  if (['hold', 'confirm'].includes(d.action)) return { verdict: 'ask', reason };
  return {
    verdict: 'deny',
    reason: `the gate policy decided ${d.action}${d.target ? ` ${d.target}` : ''}, which is not allow, deny or ask, so the call is denied`,
  };
}

// state : gateState's shape. -> { verdict, reason, by, decision }
export async function gateCheck(g, state) {
  const tool = state.tool ?? '';
  let v;
  if (toolMatches(g.deny, tool)) v = { verdict: 'deny', reason: `'${tool}' is on the deny list`, by: 'deny-list', decision: null };
  else if (toolMatches(g.allow, tool)) v = { verdict: 'allow', reason: `'${tool}' is on the allow list`, by: 'allow-list', decision: null };
  else {
    try {
      const decision = await g.evaluate(state);
      await g.onCapture?.(state, decision);
      v = { ...decisionToVerdict(decision), by: 'policy', decision };
    } catch (error) {
      v = {
        verdict: g.onError, by: 'error', decision: null,
        reason: `the gate policy could not decide, so the answer is ${g.onError}: ${firstLine(error.message)}`,
      };
    }
  }
  await logVerdict(g, state, v);
  return v;
}
// One line per verdict. The arguments are summarized by a digest: they can hold
// secrets, and the policy's redactors do not run on the log.
async function logVerdict(g, state, v) {
  if (!g.log) return;
  const d = v.decision;
  const line = {
    at: nowIso(),
    tool: state.tool ?? null,
    source: state.source ?? null,
    server: state.server ?? null,
    arguments_sha256: sha256Hex(canonical(state.arguments ?? {})),
    verdict: v.verdict,
    by: v.by,
    reason: v.reason,
    decision: d ? { action: d.action, target: d.target ?? null, request_id: d.request_id ?? null } : null,
  };
  // One writer at a time, so concurrent verdicts do not interleave.
  g.writing = g.writing.then(() => appendFile(g.log, `${JSON.stringify(line)}\n`))
    .catch(error => process.stderr.write(`jev gate: could not write the log: ${error.message}\n`));
  await g.writing;
}

// requestState: signed, expiring, and bound to one call.
export const callDigest = (tool, args) => sha256Hex(canonical({ tool, arguments: args }));
export function signRequestState(key, payload) {
  const body = base64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  return `${body}.${base64url(hmac(key, body))}`;
}
// -> the payload, or an McpError naming what is wrong. Checked in order: the
// signature, the expiry, then the tool and arguments it was issued for.
export function verifyRequestState(key, state, tool, args, now) {
  const bad = why => raiseMcp('invalid-params', `requestState rejected: ${why}\n  call the tool again without it`);
  const parts = typeof state === 'string' ? state.split('.') : null;
  if (!parts || parts.length !== 2) bad('it is not one this gate issued');
  const mac = fromBase64url(parts[1]);
  if (!mac || !sameBytes(mac, hmac(key, parts[0]))) bad('its signature does not verify (it was altered, or issued by another process)');
  let payload = null;
  try { payload = JSON.parse(fromBase64url(parts[0]).toString('utf8')); } catch { /* not ours */ }
  if (!object(payload)) bad('it is not one this gate issued');
  if (!(finite(payload.exp) && now < payload.exp)) bad('it expired');
  if (payload.tool !== tool || payload.digest !== callDigest(tool, args)) bad('it was issued for another tool or other arguments');
  return payload;
}

export const approvalKey = 'jev_gate_approval';
const approvalSchema = {
  type: 'object',
  properties: { approve: { type: 'boolean', title: 'Allow this call', description: 'true runs the tool once; false denies it' } },
  required: ['approve'],
};
const approvalMessage = (tool, args, reason) => {
  const shown = JSON.stringify(args);
  return `Allow the tool call '${tool}'?\nThe gate asks because: ${reason}\nArguments: ${shown.length > 600 ? `${shown.slice(0, 600)}...` : shown}`;
};
const approved = r => object(r) && r.action === 'accept' && object(r.content) && r.content.approve === true;
// A client that declared elicitation, with form mode (an empty object means form).
const canElicit = caps => {
  const e = object(caps) ? caps.elicitation : null;
  return object(e) && (Object.keys(e).length === 0 || own(e, 'form'));
};
export const mcpServerOfTool = name => {
  const m = typeof name === 'string' ? /^mcp__(.+?)__/.exec(name) : null;
  return m ? m[1] : null;
};
// The upstream's own request fields, minus ours: its client adds its own version
// and capabilities, and progress is not relayed.
const stripMeta = params => {
  if (!object(params._meta)) return params;
  const kept = Object.fromEntries(Object.entries(params._meta)
    .filter(([k]) => k !== 'progressToken' && !k.startsWith('io.modelcontextprotocol/')));
  const { _meta, ...rest } = params;
  return Object.keys(kept).length ? { ...rest, _meta: kept } : rest;
};

// upstream : an MCP client, with no onElicit: the gate does not relay the
// upstream's own questions.
export function gateProxyServer(g, upstream, { stateKey = randomBytes(32), stateTtl = 300, clock = () => Math.floor(Date.now() / 1000) } = {}) {
  const upstreamName = (object(upstream.serverInfo) && typeof upstream.serverInfo.name === 'string')
    ? upstream.serverInfo.name : upstream.source;
  let cached = [];
  const refreshTools = async () => { cached = await mcpListTools(upstream); return cached; };
  const annotationsOf = async name => {
    const find = tools => tools.find(t => t.name === name);
    let tool = find(cached);
    if (!tool) { try { tool = find(await refreshTools()); } catch { tool = null; } }
    return tool && object(tool.annotations) ? tool.annotations : null;
  };
  const forward = async (name, args) => {
    try {
      const r = await mcpCallTool(upstream, name, args);
      return inputRequired(r)
        ? mcpToolError(`'${name}' asked for more input, and the jev gate doesn't relay an upstream server's questions`)
        : r;
    } catch (error) {
      if (error instanceof McpError) throw error;
      return mcpToolError(`the upstream server failed: ${error.message}`);
    }
  };
  const denyResult = reason => mcpToolError(`Blocked by the jev gate (${g.label}): ${reason}`);
  const personSaid = async (name, args, answer) => {
    const ok = approved(answer);
    await logVerdict(g, gateState(name, args, { source: 'mcp-proxy', server: upstreamName }), {
      verdict: ok ? 'allow' : 'deny', by: 'person', decision: null,
      reason: ok ? 'a person approved it' : answer ? `a person answered ${answer.action ?? '?'}` : 'no answer came',
    });
    return ok ? forward(name, args) : denyResult(answer ? 'a person did not approve it' : 'nobody answered the approval request');
  };
  const ask = async (name, args, reason, call) => {
    if (call.era === 'modern' && canElicit(call.capabilities)) {
      return mcpInputRequired({
        [approvalKey]: {
          method: 'elicitation/create',
          params: { mode: 'form', message: approvalMessage(name, args, reason), requestedSchema: approvalSchema },
        },
      }, {
        state: signRequestState(stateKey, {
          kind: 'ask', tool: name, digest: callDigest(name, args),
          exp: clock() + stateTtl, reason, nonce: base64url(randomBytes(8)),
        }),
      });
    }
    if (call.elicit) return personSaid(name, args, await call.elicit(approvalMessage(name, args, reason), approvalSchema));
    return denyResult(`it needs a person's approval (${reason}), and this client can't ask one: it declared no elicitation capability`);
  };
  const callTool = async (params, call) => {
    const name = params.name;
    if (typeof name !== 'string') raiseMcp('invalid-params', "tools/call needs params.name, the tool's name");
    const args = params.arguments ?? {};
    if (!object(args)) raiseMcp('invalid-params', "tools/call: `arguments' must be an object");
    if (params.requestState) {
      const payload = verifyRequestState(stateKey, params.requestState, name, args, clock());
      const answer = object(params.inputResponses) ? params.inputResponses[approvalKey] : null;
      // A retry that left out the answer is asked again.
      return answer ? personSaid(name, args, answer) : ask(name, args, payload.reason ?? 'the gate asks', call);
    }
    const v = await gateCheck(g, gateState(name, args, {
      source: 'mcp-proxy', server: upstreamName, annotations: await annotationsOf(name),
    }));
    if (v.verdict === 'allow') return forward(name, args);
    if (v.verdict === 'ask') return ask(name, args, v.reason, call);
    return denyResult(v.reason);
  };
  const relay = method => async params => {
    try { return await mcpRequest(upstream, method, stripMeta(params)); } catch (error) {
      if (error instanceof McpError) throw error;
      raiseMcp('internal-error', `the upstream server failed: ${error.message}`);
    }
  };
  const upCaps = object(upstream.capabilities) ? upstream.capabilities : {};
  return makeMcpServer({
    name: `jev-gate(${upstreamName})`,
    version: '2.3',
    title: `${upstreamName}, gated by ${g.label}`,
    instructions: upstream.instructions,
    // list-changed and subscriptions are left out: the proxy relays no notifications.
    capabilities: {
      tools: {},
      ...Object.fromEntries(['resources', 'prompts', 'completions'].filter(k => own(upCaps, k)).map(k => [k, {}])),
    },
    methods: {
      'tools/list': async () => ({ tools: await refreshTools() }),
      'tools/call': callTool,
      'resources/list': relay('resources/list'),
      'resources/read': relay('resources/read'),
      'resources/templates/list': relay('resources/templates/list'),
    },
    fallback: (method, params) => relay(method)(params),
  });
}

// Claude Code and Codex hooks.
const eventRef = (event, key, fallback = null) => object(event) ? event[key] ?? fallback : fallback;
export const detectHookHost = input => object(input) && (eventRef(input, 'turn_id') || eventRef(input, 'model')) ? 'codex' : 'claude';
// A directory path may carry a trailing separator, which must not make a
// different approval fingerprint for the same working directory.
const canonicalCwd = value => {
  const path = resolvePath(typeof value === 'string' && value !== '' ? value : process.cwd());
  // Symlinks are resolved, so the same directory reached two ways is one
  // approval fingerprint.
  try { return realpathSync(path); } catch { return path; }
};

export function normalizeHookEvent(input, { host = 'auto' } = {}) {
  requireAt(object(input), 'input', 'a hook event is a JSON object');
  const selected = host === 'auto' ? detectHookHost(input) : host;
  requireAt(['claude', 'codex'].includes(selected), 'host', "host is 'auto', 'claude' or 'codex'");
  const tool = eventRef(input, 'tool_name', '');
  const toolInput = eventRef(input, 'tool_input', {});
  const annotations = eventRef(input, 'tool_annotations') ?? eventRef(input, 'annotations');
  return {
    host: selected,
    event: eventRef(input, 'hook_event_name'),
    tool: typeof tool === 'string' ? tool.trim() : String(tool),
    input: object(toolInput) || Array.isArray(toolInput) ? toolInput : {},
    cwd: canonicalCwd(eventRef(input, 'cwd', process.cwd())),
    annotations: object(annotations) ? annotations : null,
  };
}
export function callFingerprint(input, policyHash) {
  const event = normalizeHookEvent(input);
  return sha256Hex(canonical({ tool: event.tool, input: event.input, cwd: event.cwd, policy: policyHash ?? null }));
}

// One approval, for one exact call, that is consumed when it is used.
export const approvalSettings = { directory: null, ttlSeconds: 600 };
const approvalFile = cwd => join(approvalSettings.directory ?? canonicalCwd(cwd), '.jev', 'gate-approvals.jsonl');
const readApprovals = async path => {
  if (!existsSync(path)) return [];
  const text = await readFile(path, 'utf8');
  return text.split('\n').filter(line => line.trim() !== '').map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(object);
};
const writeApprovals = async (path, entries) => {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, entries.map(e => `${JSON.stringify(e)}\n`).join(''), { mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
};
// A lock directory, so two processes cannot lose each other's approvals.
async function withApprovalLock(path, thunk) {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const lock = join(directory, 'gate-approvals.lock');
  for (let attempt = 0; ; attempt += 1) {
    try { await mkdir(lock); break; } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // A lock left behind by a dead process is broken after half a minute.
      try {
        const stats = await stat(lock);
        if (Date.now() - stats.mtimeMs > 30_000) { await rmdir(lock).catch(() => {}); continue; }
      } catch { /* it vanished; try again */ }
      requireAt(attempt < 500, 'gate', `timed out waiting for ${lock}`);
      await new Promise(r => setTimeout(r, 10));
    }
  }
  try { return await thunk(); } finally { await rmdir(lock).catch(() => {}); }
}
const liveApproval = (entry, now) => typeof entry.fingerprint === 'string' && finite(entry.expires_at) && now < entry.expires_at;

export async function approveOnce(fingerprint, { now = Math.floor(Date.now() / 1000), cwd = process.cwd() } = {}) {
  requireAt(typeof fingerprint === 'string' && /^[0-9a-f]{64}$/.test(fingerprint), 'fingerprint', 'an approval names a SHA-256 hex digest');
  const path = approvalFile(cwd);
  await withApprovalLock(path, async () => {
    const kept = (await readApprovals(path)).filter(e => liveApproval(e, now) && e.fingerprint !== fingerprint);
    await writeApprovals(path, [...kept, { fingerprint, approved_at: now, expires_at: now + approvalSettings.ttlSeconds }]);
  });
  return path;
}
// A consuming predicate: a true result removes the matching entry.
export async function approvedOnce(fingerprint, { now = Math.floor(Date.now() / 1000), cwd = process.cwd() } = {}) {
  const path = approvalFile(cwd);
  return withApprovalLock(path, async () => {
    const entries = await readApprovals(path);
    const found = entries.some(e => liveApproval(e, now) && e.fingerprint === fingerprint);
    const kept = entries.filter(e => liveApproval(e, now) && e.fingerprint !== fingerprint);
    if (existsSync(path) || kept.length) await writeApprovals(path, kept);
    return found;
  });
}

export const hookOutput = (verdict, reason, { host = 'claude' } = {}) => ({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    // Codex has no "ask": a call that needs a person is denied with the reason.
    permissionDecision: host === 'codex' && verdict === 'ask' ? 'deny' : verdict,
    permissionDecisionReason: reason,
  },
});
export async function hookVerdictToResponse(verdict, input, policyHash, { now = Math.floor(Date.now() / 1000) } = {}) {
  if (verdict === 'ask') {
    return await approvedOnce(callFingerprint(input, policyHash), { now, cwd: normalizeHookEvent(input).cwd }) ? 'allow' : 'deny';
  }
  return ['allow', 'deny'].includes(verdict) ? verdict : 'deny';
}

// input    : the hook's stdin, parsed, or null when it was not JSON
// loadGate : () -> a gate; a load failure means onError
// -> the JSON to print, or null to print nothing (not a PreToolUse event)
export async function hookResponse(input, loadGate, { onError = 'ask', host = 'auto', now = Math.floor(Date.now() / 1000) } = {}) {
  const selected = host === 'auto' ? detectHookHost(input) : host;
  if (!object(input)) {
    return hookOutput(onError, 'jev gate: the hook\'s input was not a JSON object, so the gate could not look at the call', { host: selected });
  }
  if (eventRef(input, 'hook_event_name') !== 'PreToolUse') return null;
  const event = normalizeHookEvent(input, { host: selected });
  const tool = event.tool;
  let g;
  try { g = await loadGate(); } catch (error) {
    return hookOutput(onError, `jev gate: the gate policy did not load, so the answer is ${onError}: ${firstLine(error.message)}`, { host: selected });
  }
  const state = gateState(tool, event.input, {
    source: selected === 'codex' ? 'codex' : 'claude-code',
    server: mcpServerOfTool(tool),
    annotations: event.annotations,
  });
  const fingerprint = callFingerprint(input, g.policyHash);
  const hardDeny = toolMatches(g.deny, tool);
  const hardAllow = toolMatches(g.allow, tool);
  // Codex cannot be asked, so a person's one-shot approval is consumed here.
  if (selected === 'codex' && !hardDeny && !hardAllow && await approvedOnce(fingerprint, { now, cwd: event.cwd })) {
    const reason = 'jev gate: a person approved this exact call once';
    await logVerdict(g, state, { verdict: 'allow', reason, by: 'person', decision: null });
    return hookOutput('allow', reason, { host: 'codex' });
  }
  const v = await gateCheck(g, state);
  const reason = `jev gate (${g.label}): ${v.reason}`;
  if (selected === 'codex' && v.verdict === 'allow') return null;
  if (selected === 'codex' && v.verdict === 'ask') {
    return hookOutput('deny',
      `${reason}. Approval fingerprint: ${fingerprint}. To allow only this exact call, run \`jev gate approve-once ${fingerprint}\` and retry it within ten minutes`,
      { host: 'codex' });
  }
  return hookOutput(v.verdict, reason, { host: selected });
}
