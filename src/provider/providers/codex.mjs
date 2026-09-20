// The Codex CLI as a provider: one ephemeral exec per request, a strict output
// schema written to a file, the result read back from another, and the CLI's own
// sandbox flags for the permissions the request asked for.
import { existsSync, mkdirSync, appendFileSync, writeFileSync, readFileSync, rmSync, mkdtempSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { object, own } from '../../common.mjs';
import { ProviderError, availability, capabilities, provider, unreportedCost } from '../core.mjs';
import { findExecutable } from '../command.mjs';
import { runProgram } from '../process.mjs';
import { jsonSchemaValid } from '../schema.mjs';

const parseJson = text => { try { return JSON.parse(text); } catch { return null; } };
const providerError = (kind, target, message, { retryable = false, usage = {}, cost = unreportedCost(), status = null } = {}) =>
  new ProviderError(message, { kind, target, retryable, usage, cost, status, detail: message });

const canonicalDirectory = (value, target, label) => {
  const path = resolvePath(value);
  try { if (!statSync(path).isDirectory()) throw new Error('not a directory'); readdirSync(path); }
  catch { throw providerError('configuration', target, `Codex ${label} is not a readable directory: ${path}`); }
  return path;
};
const canonicalFile = (value, target, label) => {
  const path = resolvePath(value);
  if (!existsSync(path)) throw providerError('configuration', target, `Codex ${label} is not a readable file: ${path}`);
  return path;
};
const metadataList = (request, key) => Array.isArray(request.metadata[key]) ? request.metadata[key] : [];
// A disallowed entry is a command prefix, split into its words.
const forbiddenPrefixes = (request, target) => {
  const value = request.metadata.disallowed ?? [];
  if (!(Array.isArray(value) && value.every(e => typeof e === 'string' && e.trim() !== ''))) {
    throw providerError('configuration', target, 'Codex disallowed command prefixes must be non-empty strings');
  }
  return value.map(entry => entry.split(/\s+/).filter(w => w !== ''));
};
const repositoryRoot = directory => {
  let path = resolvePath(directory);
  for (;;) {
    if (existsSync(join(path, '.git'))) return path;
    const parent = dirname(path);
    if (parent === path) return resolvePath(directory);
    path = parent;
  }
};
const writeForbiddenRules = (path, prefixes) => writeFileSync(path, prefixes.map(prefix =>
  `prefix_rule(\n    pattern = [${prefix.map(w => JSON.stringify(w)).join(', ')}],\n    decision = "forbidden",\n    justification = "Jev worker boundary",\n)\n\n`).join(''));

const promptWithInstructions = (request, target) => {
  const { system, append_system: appendSystem } = request.metadata;
  for (const entry of [system, appendSystem]) {
    if (entry !== undefined && entry !== null && entry !== 'default' && typeof entry !== 'string') {
      throw providerError('configuration', target, 'Codex system instructions must be strings or "default"');
    }
  }
  const instructions = [system === 'default' ? null : system, appendSystem].filter(x => typeof x === 'string');
  return instructions.length === 0 ? request.prompt
    : `<jev-system-instructions>\n${instructions.join('\n\n')}\n</jev-system-instructions>\n\n${request.prompt}`;
};
// The thread id and the last usage a run reported.
const jsonlFacts = transcript => transcript.split('\n').reduce((acc, line) => {
  const event = parseJson(line);
  if (!object(event)) return acc;
  return {
    requestId: event.thread_id ?? event.request_id ?? acc.requestId,
    usage: object(event.usage) ? event.usage : acc.usage,
  };
}, { requestId: null, usage: {} });

const schemaRef = (table, key, fallback = null) => object(table) && own(table, key) ? table[key] : fallback;
const schemaAllowsNull = schema => {
  const type = schemaRef(schema, 'type');
  return type === 'null'
    || (Array.isArray(type) && type.includes('null'))
    || (Array.isArray(schemaRef(schema, 'enum', [])) && schemaRef(schema, 'enum', []).includes(null))
    || [...schemaRef(schema, 'anyOf', []), ...schemaRef(schema, 'oneOf', [])].some(schemaAllowsNull);
};
// Codex wants every property required, so an optional one is widened to allow
// null and listed as required.
export function codexOutputSchema(value) {
  if (Array.isArray(value)) return value.map(codexOutputSchema);
  if (!object(value)) return value;
  const normalized = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, codexOutputSchema(v)]));
  if (normalized.type !== 'object') return normalized;
  const properties = normalized.properties ?? {};
  const sourceProperties = value.properties ?? {};
  const sourceRequired = value.required ?? [];
  const strict = Object.fromEntries(Object.entries(properties).map(([key, item]) => {
    const source = schemaRef(sourceProperties, key, {});
    return [key, sourceRequired.includes(key) || schemaAllowsNull(source) ? item : { anyOf: [item, { type: 'null' }] }];
  }));
  return { ...normalized, properties: strict, required: Object.keys(strict), additionalProperties: false };
}
// And the answer comes back with those nulls, which the request's own schema
// never asked for, so they go again.
export function restoreOptionalFields(value, schema) {
  const alternatives = object(schema) ? [...schemaRef(schema, 'anyOf', []), ...schemaRef(schema, 'oneOf', [])] : [];
  const matching = alternatives.find(choice => jsonSchemaValid(choice, value));
  if (matching) return restoreOptionalFields(value, matching);
  if (object(value) && object(schema)) {
    const properties = schemaRef(schema, 'properties', {});
    const required = schemaRef(schema, 'required', []);
    return Object.fromEntries(Object.entries(value)
      .filter(([key, item]) => {
        const property = schemaRef(properties, key);
        return !(property && item === null && !required.includes(key) && !schemaAllowsNull(property));
      })
      .map(([key, item]) => {
        const property = schemaRef(properties, key);
        return [key, property ? restoreOptionalFields(item, property) : item];
      }));
  }
  if (Array.isArray(value) && object(schema)) {
    const items = schemaRef(schema, 'items');
    return items ? value.map(item => restoreOptionalFields(item, items)) : value;
  }
  return value;
}

export async function codexCliRunner(executable, request, target, { billing = 'unreported' } = {}) {
  const directory = canonicalDirectory(request.directory ?? process.cwd(), target, 'working directory');
  const addDirectories = metadataList(request, 'add_dirs').map(v => canonicalDirectory(v, target, 'additional directory'));
  const images = request.images.map(v => canonicalFile(v, target, 'image input'));
  const timeoutSeconds = request.limits.timeout_seconds ?? 600;
  const streamTo = request.metadata.stream_to ?? null;
  const temporary = mkdtempSync(join(tmpdir(), 'jev-codex-'));
  const schemaPath = join(temporary, 'schema.json');
  const resultPath = join(temporary, 'result.json');
  const forbidden = forbiddenPrefixes(request, target);
  const codexDirectory = join(repositoryRoot(directory), '.codex');
  const rulesDirectory = join(codexDirectory, 'rules');
  let rulesPath = null, madeCodex = false, madeRules = false;
  try {
    writeFileSync(schemaPath, JSON.stringify(codexOutputSchema(request.schema ?? {})));
    if (forbidden.length) {
      if (!existsSync(codexDirectory)) { mkdirSync(codexDirectory); madeCodex = true; }
      if (!existsSync(rulesDirectory)) { mkdirSync(rulesDirectory); madeRules = true; }
      rulesPath = join(rulesDirectory, `jev-${process.pid}-${Date.now()}.rules`);
      writeForbiddenRules(rulesPath, forbidden);
    }
    if (streamTo) mkdirSync(dirname(resolvePath(streamTo)), { recursive: true });

    const workspace = request.mode === 'workspace';
    const write = request.permissions.includes('write');
    const shell = request.permissions.includes('shell');
    if (write && !workspace) throw providerError('configuration', target, 'Codex write permission requires workspace mode');
    if (write && !shell) throw providerError('configuration', target, 'Codex cannot grant write permission while denying shell permission');
    const writable = workspace && write && shell;
    if (addDirectories.length && !writable) {
      throw providerError('configuration', target, 'Codex additional writable directories require write and shell permissions');
    }
    const args = [
      'exec', '--ephemeral', '--ignore-user-config', '--json',
      ...(target.model ? ['--model', target.model] : []),
      ...(target.effectiveEffort ? ['-c', `model_reasoning_effort="${target.effectiveEffort}"`] : []),
      ...(shell ? [] : ['--disable', 'shell_tool']),
      ...(writable ? ['--approve-for-me', '-c', 'sandbox_workspace_write.network_access=true'] : ['--sandbox', 'read-only']),
      '--output-schema', schemaPath, '--output-last-message', resultPath, '--cd', directory,
      ...addDirectories.flatMap(path => ['--add-dir', path]),
      ...images.flatMap(path => ['--image', path]),
      '-',
    ];
    const { status, stdout } = await runProgram(findExecutable(executable) ?? executable, args, {
      stdin: promptWithInstructions(request, target),
      timeoutSeconds,
      dir: directory,
      onLine: streamTo ? line => appendFileSync(resolvePath(streamTo), `${line}\n`) : null,
    });
    const cost = { mode: billing, usd: null };
    if (status === null) throw providerError('timeout', target, 'Codex timed out', { retryable: true, cost });
    const { requestId, usage } = jsonlFacts(stdout);
    if (status !== 0) throw providerError('provider-failure', target, 'Codex failed', { retryable: true, usage, cost, status });
    const raw = existsSync(resultPath) ? parseJson(readFileSync(resultPath, 'utf8')) : null;
    const output = raw === null ? null : restoreOptionalFields(raw, request.schema);
    if (!output || !jsonSchemaValid(request.schema, output)) {
      throw providerError('invalid-output', target, 'Codex returned invalid structured output', { retryable: true, usage, cost, status });
    }
    return {
      output, target, model: target.model ?? null, usage, cost, requestId, exitStatus: status,
      changed: object(output) && Array.isArray(output.changed) ? output.changed : [],
      attempts: [],
    };
  } finally {
    if (rulesPath && existsSync(rulesPath)) rmSync(rulesPath);
    if (madeRules && existsSync(rulesDirectory) && readdirSync(rulesDirectory).length === 0) rmSync(rulesDirectory, { recursive: true });
    if (madeCodex && existsSync(codexDirectory) && readdirSync(codexDirectory).length === 0) rmSync(codexDirectory, { recursive: true });
    rmSync(temporary, { recursive: true, force: true });
  }
}

// The bundled catalog says which efforts and modalities each model takes.
export function catalogToSettings(text) {
  const parsed = parseJson(text);
  const models = object(parsed) ? parsed.models : null;
  if (!Array.isArray(models)) return null;
  return Object.fromEntries(models.filter(m => object(m) && typeof m.slug === 'string').map(model => [model.slug, {
    efforts: (Array.isArray(model.supported_reasoning_levels) ? model.supported_reasoning_levels : [])
      .filter(l => object(l) && typeof l.effort === 'string').map(l => l.effort),
    default_effort: model.default_reasoning_level ?? null,
    modalities: Array.isArray(model.input_modalities) && model.input_modalities.every(x => typeof x === 'string')
      ? model.input_modalities : [],
  }]));
}

export function codexProvider({ command = 'codex', maxParallel = 4 } = {}) {
  let billing = 'unreported';
  const value = provider({
    id: 'codex',
    caps: capabilities({
      modes: ['structured', 'workspace'], modalities: ['text', 'image'], permissions: ['read', 'write', 'shell'],
      controls: ['structured-output', 'reasoning-effort', 'streaming', 'tool-policy'],
      efforts: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'], maxParallel,
    }),
    discover: async () => {
      const executable = findExecutable(command);
      if (!executable) return availability('missing', { detail: 'Codex CLI is not on PATH' });
      const version = await runProgram(executable, ['--version'], { timeoutSeconds: 10 });
      const login = await runProgram(executable, ['login', 'status'], { timeoutSeconds: 10 });
      const reported = version.status === 0 ? (version.stdout.trim().split(/\s+/).pop() ?? null) : null;
      const text = `${login.stdout}\n${login.stderr}`.trim().toLowerCase();
      if (login.status === 0 && text.includes('logged in') && !text.includes('not logged in')) {
        billing = text.includes('chatgpt') ? 'subscription' : 'unreported';
        const catalog = await runProgram(executable, ['debug', 'models', '--bundled'], { timeoutSeconds: 30 });
        if (catalog.status === 0) {
          const settings = catalogToSettings(catalog.stdout);
          if (settings) value.modelCapabilities = settings;
        }
        return availability('ready', { version: reported, billing, detail: 'authenticated Codex CLI' });
      }
      billing = 'unreported';
      return availability('unauthenticated', { version: reported, detail: 'run `codex login`' });
    },
    run: (request, target) => codexCliRunner(command, request, target, { billing }),
  });
  return value;
}
