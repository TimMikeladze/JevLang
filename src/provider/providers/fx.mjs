// The fx CLI as a provider: workspace runs only, with fx's own result envelope
// checked before anything is believed. fx grants read, write and shell together
// or not at all, and it has no exact effort selection, so both are refused
// rather than quietly approximated.
import { existsSync, statSync, readdirSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { object, own, finite } from '../../common.mjs';
import { ProviderError, availability, capabilities, provider, unreportedCost } from '../core.mjs';
import { findExecutable } from '../command.mjs';
import { runProgram } from '../process.mjs';
import { jsonSchemaValid } from '../schema.mjs';

const minimumVersion = [0, 0, 10];
// One JSON value, and nothing but whitespace after it.
const readJsonValue = text => { try { return { value: JSON.parse(text) }; } catch { return null; } };
const parseJson = text => readJsonValue(text)?.value ?? null;
const parseVersion = text => {
  const m = /([0-9]+)\.([0-9]+)\.([0-9]+)/.exec(text);
  return m ? m.slice(1).map(Number) : null;
};
const versionAtLeast = (actual, required) => {
  for (const [i, needed] of required.entries()) {
    const have = actual[i] ?? 0;
    if (have > needed) return true;
    if (have < needed) return false;
  }
  return true;
};
const versionString = version => version ? version.join('.') : null;
const nonemptyString = v => typeof v === 'string' && v.trim() !== '';
const subscriptionAuth = auth => ['codex subscription', 'grok subscription'].includes(auth.trim().toLowerCase());
const validStatus = value => object(value) && value.kind === 'status'
  && nonemptyString(value.model) && nonemptyString(value.auth) && nonemptyString(value.permission_mode)
  ? value : null;
const validModelCatalog = value => object(value) && value.kind === 'models'
  && Array.isArray(value.ids) && value.ids.length > 0 && value.ids.every(nonemptyString)
  ? value.ids : null;
// An error code is echoed only when it looks like a code, never free text.
const safeErrorCode = reply => typeof reply.error === 'string' && /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(reply.error) ? reply.error : null;
const failureMessage = reply => { const code = safeErrorCode(reply); return code ? `fx failed: ${code}` : 'fx failed'; };
const providerError = (kind, target, message, { retryable = false, mutated = false, usage = {}, cost = unreportedCost(), status = null } = {}) =>
  new ProviderError(message, { kind, target, retryable, mutated, usage, cost, status, detail: message });

const canonicalDirectory = (value, target, label) => {
  if (typeof value !== 'string' || value === '') throw providerError('configuration', target, `fx ${label} must be a directory path`);
  const path = resolvePath(value);
  try { if (!statSync(path).isDirectory()) throw new Error('not a directory'); readdirSync(path); }
  catch { throw providerError('configuration', target, `fx ${label} is not a readable directory: ${path}`); }
  return path;
};
const canonicalFile = (value, target, label) => {
  const path = resolvePath(value);
  if (!existsSync(path)) throw providerError('configuration', target, `fx ${label} is not a readable file: ${path}`);
  return path;
};
const metadataList = (request, key, target, label) => {
  const value = own(request.metadata, key) ? request.metadata[key] : [];
  if (!Array.isArray(value)) throw providerError('configuration', target, `fx ${label} must be a list`);
  return value;
};
const validatePermissions = (request, target) => {
  const have = request.permissions;
  const wanted = ['read', 'write', 'shell'];
  if (!(have.length === 3 && wanted.every(p => have.includes(p)))) {
    throw providerError('configuration', target, 'fx workspace requests require exactly read, write, and shell permissions');
  }
};
const requestSystem = (request, target) => {
  const value = request.metadata.system ?? null;
  if (!(value === null || value === 'default' || typeof value === 'string')) {
    throw providerError('configuration', target, 'fx system instructions must be a string or "default"');
  }
  return typeof value === 'string' && value !== 'default' ? value : null;
};
const requestPrompt = (request, target) => {
  const appendSystem = request.metadata.append_system ?? null;
  if (!(appendSystem === null || typeof appendSystem === 'string')) {
    throw providerError('configuration', target, 'fx appended system instructions must be a string');
  }
  const schema = request.schema;
  const schemaInstruction = schema ? `Return only one JSON value matching this JSON Schema:\n${JSON.stringify(schema)}` : null;
  const instructions = [appendSystem, schemaInstruction].filter(x => typeof x === 'string');
  return instructions.length === 0 ? request.prompt
    : `<jev-system-instructions>\n${instructions.join('\n\n')}\n</jev-system-instructions>\n\n${request.prompt}`;
};
// fx reports tokens and steps; a total is only added when both halves are there.
const normalizeUsage = reply => {
  const raw = object(reply.usage) ? reply.usage : {};
  const usage = {};
  for (const key of ['input_tokens', 'output_tokens']) {
    if (Number.isInteger(raw[key]) && raw[key] >= 0) usage[key] = raw[key];
  }
  if (own(usage, 'input_tokens') && own(usage, 'output_tokens')) usage.total_tokens = usage.input_tokens + usage.output_tokens;
  if (Number.isInteger(reply.steps) && reply.steps >= 0) usage.steps = reply.steps;
  usage.tool_calls = reply.tool_calls.length;
  return usage;
};

export async function fxCliRunner(command, request, target, { billing = 'unreported' } = {}) {
  if (request.mode !== 'workspace') throw providerError('configuration', target, 'fx supports workspace mode only');
  validatePermissions(request, target);
  if (target.effectiveEffort) throw providerError('configuration', target, 'fx v0.0.10 does not support exact effort selection');
  const forbidden = metadataList(request, 'disallowed', target, 'disallowed command prefixes');
  if (!forbidden.every(v => typeof v === 'string' && v.trim() !== '')) {
    throw providerError('configuration', target, 'fx disallowed command prefixes must be non-empty strings');
  }
  if (forbidden.length) throw providerError('configuration', target, 'fx cannot enforce per-run disallowed command prefixes');
  const directory = canonicalDirectory(request.directory, target, 'workspace');
  const addDirectories = metadataList(request, 'add_dirs', target, 'additional directories')
    .map(path => canonicalDirectory(path, target, 'additional directory'));
  const images = request.images.map(path => canonicalFile(path, target, 'image'));
  const system = requestSystem(request, target);
  const prompt = requestPrompt(request, target);
  const timeoutSeconds = request.limits.timeout_seconds ?? 600;
  if (!(finite(timeoutSeconds) && timeoutSeconds > 0)) throw providerError('configuration', target, 'fx timeout_seconds must be positive');
  const model = target.model ?? null;
  if (!(model === null || typeof model === 'string')) throw providerError('configuration', target, 'fx model must be a string');
  const args = [
    '--no-additional-dirs',
    ...addDirectories.flatMap(path => ['--add-dir', path]),
    'ask', '--json', '--no-save', '--no-color', '--auto',
    ...(system ? ['--system', system] : []),
    ...images.flatMap(path => ['--image', path]),
  ];
  const cost = { mode: billing, usd: null };
  const { status, stdout } = await runProgram(findExecutable(command) ?? command, args, {
    stdin: prompt, timeoutSeconds, dir: directory,
    env: { ...process.env, ...(model ? { FX_MODEL: model } : {}) },
  });
  // fx works in the workspace, so an interrupted run may have changed files.
  if (status === null) throw providerError('timeout', target, 'fx timed out', { retryable: true, mutated: true, cost });
  const parsed = readJsonValue(stdout);
  if (!(parsed && object(parsed.value))) {
    throw providerError('protocol', target, 'fx returned a malformed JSON result', { retryable: true, mutated: true, cost, status });
  }
  const reply = parsed.value;
  const exitCode = reply.exit_code;
  if (!(Number.isInteger(exitCode)
    && (reply.model === undefined || reply.model === null || typeof reply.model === 'string')
    && (reply.session_id === undefined || reply.session_id === null || typeof reply.session_id === 'string')
    && Array.isArray(reply.tool_calls) && object(reply.usage))) {
    throw providerError('protocol', target, 'fx returned an invalid result envelope', { retryable: true, mutated: true, cost, status });
  }
  const usage = normalizeUsage(reply);
  const fail = (kind, message, extra = {}) => { throw providerError(kind, target, message, { retryable: true, mutated: true, usage, cost, ...extra }); };
  if (status !== 0 && exitCode !== 0 && status !== exitCode) fail('protocol', 'fx process and result exit codes disagree', { status });
  if (status !== exitCode) {
    if (status === 0) fail('provider-failure', failureMessage(reply), { status: exitCode });
    fail('protocol', 'fx process and result exit codes disagree', { status });
  }
  if (status !== 0) fail('provider-failure', failureMessage(reply), { status });
  const finalText = nonemptyString(reply.final_output) ? reply.final_output
    : typeof reply.output === 'string' ? reply.output : null;
  if (finalText === null) fail('invalid-output', 'fx returned no final output', { status });
  const schema = request.schema;
  const structured = schema ? readJsonValue(finalText) : null;
  const output = schema ? structured?.value ?? null : finalText;
  if ((schema && !structured) || !jsonSchemaValid(schema, output)) {
    fail('invalid-output', 'fx returned invalid structured output', { status });
  }
  return {
    output, target, model: reply.model ?? model ?? null, usage, cost,
    requestId: reply.session_id ?? null, exitStatus: status,
    changed: object(output) && Array.isArray(output.changed) ? output.changed : [],
    attempts: [],
  };
}

export function fxProvider({ command = 'fx', maxParallel = 2 } = {}) {
  let billing = 'unreported';
  const value = provider({
    id: 'fx',
    caps: capabilities({
      modes: ['workspace'], modalities: ['text', 'image'], permissions: ['read', 'write', 'shell'],
      controls: ['structured-output'], efforts: [], maxParallel,
    }),
    discover: async () => {
      const executable = findExecutable(command);
      if (!executable) return availability('missing', { detail: 'fx CLI is not on PATH' });
      const version = await runProgram(executable, ['--version'], { timeoutSeconds: 10 });
      const parsed = version.status === 0 ? parseVersion(version.stdout) : null;
      if (!parsed) return availability('unavailable', { detail: 'could not read fx CLI version' });
      if (!versionAtLeast(parsed, minimumVersion)) {
        return availability('unavailable', { version: versionString(parsed), detail: 'fx 0.0.10 or newer is required' });
      }
      const status = await runProgram(executable, ['status', '--json'], { timeoutSeconds: 10 });
      const state = status.status === 0 ? validStatus(parseJson(status.stdout)) : null;
      const auth = state ? state.auth : null;
      if (typeof auth !== 'string') {
        return availability('unavailable', { version: versionString(parsed), detail: 'could not read fx authentication status' });
      }
      if (auth.trim().toLowerCase() === 'missing') {
        billing = 'unreported';
        return availability('unauthenticated', { version: versionString(parsed), detail: 'run `fx login` or `fx setup`' });
      }
      const models = await runProgram(executable, ['models', '--json'], { timeoutSeconds: 30 });
      const ids = models.status === 0 ? validModelCatalog(parseJson(models.stdout)) : null;
      if (!ids) return availability('unavailable', { version: versionString(parsed), detail: 'could not read fx model catalog' });
      billing = subscriptionAuth(auth) ? 'subscription' : 'unreported';
      value.modelCapabilities = Object.fromEntries(ids.map(id => [id, {}]));
      return availability('ready', { version: versionString(parsed), billing, detail: 'authenticated fx CLI' });
    },
    run: (request, target) => fxCliRunner(command, request, target, { billing }),
  });
  return value;
}
