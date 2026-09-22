// The Claude CLI as a provider: one non-interactive run per request, structured
// output checked against the request's schema, and the CLI's own accounting.
import { existsSync } from 'node:fs';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { object, own, finite } from '../../common.js';
import { ProviderError, availability, capabilities, provider, unreportedCost } from '../core.js';
import { findExecutable } from '../command.js';
import { runProgram } from '../process.js';
import { jsonSchemaValid } from '../schema.js';

const parseJson = text => {
  try { return JSON.parse(text); } catch { return null; }
};
// The last structured call in a stream transcript: a StructuredOutput tool use,
// else a block of parameters or tags in the assistant's text.
export function lastStructuredCall(transcript) {
  const fromText = text => {
    const blocks = [...text.matchAll(/<StructuredOutput>([\s\S]*?)<\/StructuredOutput>/g)].map(m => m[1]);
    if (!blocks.length) return null;
    const block = blocks[blocks.length - 1];
    const asJson = /^\s*(\{[\s\S]*\})\s*$/.exec(block);
    const value = asJson ? parseJson(asJson[1]) : null;
    if (object(value)) return value;
    const pairs = [...block.matchAll(/<parameter name="([^"]+)">([\s\S]*?)<\/parameter>/g)].map(m => [m[1], m[2]]);
    const tags = [...block.matchAll(/<([a-z_]+)>([\s\S]*?)<\/\1>/g)].map(m => [m[1], m[2]]);
    const chosen = pairs.length ? pairs : tags;
    return chosen.length ? Object.fromEntries(chosen.map(([k, v]) => [k, v.trim()])) : null;
  };
  let found = null;
  for (const line of transcript.split('\n')) {
    if (!line.includes('StructuredOutput')) continue;
    const event = parseJson(line);
    if (!(object(event) && event.type === 'assistant' && object(event.message))) continue;
    const content = Array.isArray(event.message.content) ? event.message.content : [];
    for (const item of content) {
      if (!object(item)) continue;
      if (item.type === 'tool_use' && item.name === 'StructuredOutput' && object(item.input)) found = item.input;
      else if (item.type === 'text' && typeof item.text === 'string') {
        const text = fromText(item.text);
        if (text) found = text;
      }
    }
  }
  return found;
}
const lastResultEvent = transcript => transcript.split('\n')
  .map(parseJson).filter(e => object(e) && e.type === 'result').pop() ?? null;
// A reported amount, else a subscription call: never an invented price.
const reportedCost = reply => finite(reply?.total_cost_usd)
  ? { mode: 'reported-usd', usd: reply.total_cost_usd }
  : { mode: 'subscription', usd: null };
const providerError = (kind, target, message, { retryable = false, usage = null, cost = unreportedCost(), status = null } = {}) =>
  new ProviderError(message, { kind, target, retryable, usage, cost, status, detail: message });

const canonicalImages = (request, target) => request.images.map(image => {
  const path = resolvePath(image);
  if (!existsSync(path)) throw providerError('configuration', target, `Claude image input is not a readable file: ${path}`);
  return path;
});
const permissionTools = request => request.mode !== 'workspace' ? [] : [
  'Read', 'Glob', 'Grep',
  ...(request.permissions.includes('write') ? ['Write', 'Edit'] : []),
  ...(request.permissions.includes('shell') ? ['Bash'] : []),
];
const metadataList = (request, key) => Array.isArray(request.metadata[key]) ? request.metadata[key] : [];
const promptWithImages = (prompt, images) => images.length === 0 ? prompt
  : `${prompt}\n\n<jev-image-inputs>\n${images.map(p => `- ${p}`).join('\n')}\n</jev-image-inputs>\nUse the Read tool to inspect every listed image.`;

export async function claudeCliRunner(executable, request, target) {
  const images = canonicalImages(request, target);
  const metadata = request.metadata;
  const streamTo = metadata.stream_to ?? null;
  const stream = Boolean(metadata.stream || streamTo);
  const tools = [...new Set([...metadataList(request, 'tools'), ...permissionTools(request), ...(images.length ? ['Read'] : [])])];
  const disallowed = metadataList(request, 'disallowed');
  const system = own(metadata, 'system') ? metadata.system
    : (request.mode === 'workspace' ? 'default' : 'You are a careful assistant. Answer with the requested JSON.');
  const budget = request.limits.max_budget_usd ?? null;
  const timeoutSeconds = request.limits.timeout_seconds ?? 600;
  const schema = request.schema;
  const args = [
    '-p', '--output-format', stream ? 'stream-json' : 'json', '--no-session-persistence',
    ...(target.model ? ['--model', target.model] : []),
    ...(budget ? ['--max-budget-usd', String(budget)] : []),
    ...(schema ? ['--json-schema', JSON.stringify(schema)] : []),
    '--tools', tools.join(','), '--disable-slash-commands', '--strict-mcp-config', '--setting-sources', '',
    ...(system === 'default' ? [] : ['--system-prompt', system]),
    ...(metadata.append_system ? ['--append-system-prompt', metadata.append_system] : []),
    ...(metadata.permission_mode ? ['--permission-mode', metadata.permission_mode] : []),
    ...(disallowed.length ? ['--disallowedTools', ...disallowed] : []),
    ...(target.effectiveEffort ? ['--effort', target.effectiveEffort] : []),
    ...(stream ? ['--verbose'] : []),
    ...(tools.length ? ['--allowedTools', tools.join(',')] : []),
    ...(request.directory ? ['--add-dir', resolvePath(request.directory)] : []),
  ];
  if (streamTo) mkdirSync(dirname(resolvePath(streamTo)), { recursive: true });
  const { status, stdout } = await runProgram(findExecutable(executable) ?? executable, args, {
    stdin: promptWithImages(request.prompt, images),
    timeoutSeconds,
    dir: request.directory,
    onLine: stream && streamTo ? line => appendFileSync(resolvePath(streamTo), `${line}\n`) : null,
  });
  if (status === null) throw providerError('timeout', target, 'Claude timed out', { retryable: true });
  const reply = stream ? lastResultEvent(stdout) : parseJson(stdout);
  if (!object(reply)) {
    throw providerError('invalid-output', target, 'Claude returned invalid structured output', { retryable: true, status });
  }
  const cost = reportedCost(reply);
  const usage = object(reply.usage) ? reply.usage : null;
  if (status !== 0 || reply.is_error) {
    throw providerError('provider-failure', target, 'Claude failed', { retryable: true, usage, cost, status });
  }
  const output = reply.structured_output ?? (stream ? lastStructuredCall(stdout) : null);
  if (!output || !jsonSchemaValid(schema, output)) {
    throw providerError('invalid-output', target, 'Claude returned invalid structured output', { retryable: true, usage, cost, status });
  }
  return {
    output, target,
    model: reply.model ?? target.model ?? null,
    usage: usage ?? {},
    cost,
    requestId: reply.provider_request_id ?? reply.request_id ?? reply.session_id ?? null,
    exitStatus: status,
    changed: object(output) && Array.isArray(output.changed) ? output.changed : [],
    attempts: [],
  };
}

export function claudeProvider({ command = 'claude', maxParallel = 2 } = {}) {
  return provider({
    id: 'claude',
    caps: capabilities({
      modes: ['structured', 'workspace'], modalities: ['text', 'image'], permissions: ['read', 'write', 'shell'],
      controls: ['structured-output', 'reasoning-effort', 'hard-usd-cap', 'streaming', 'tool-policy'],
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'], maxParallel,
    }),
    discover: async () => {
      const executable = findExecutable(command);
      if (!executable) return availability('missing', { detail: 'Claude CLI is not on PATH' });
      const version = await runProgram(executable, ['--version'], { timeoutSeconds: 10 });
      const auth = await runProgram(executable, ['auth', 'status', '--json'], { timeoutSeconds: 10 });
      const parsed = parseJson(auth.stdout);
      const reported = version.status === 0 ? (version.stdout.trim().split(/\s+/)[0] ?? null) : null;
      if (object(parsed) && parsed.loggedIn) {
        return availability('ready', {
          version: reported,
          billing: parsed.subscriptionType ? 'subscription' : 'unreported',
          detail: 'authenticated Claude CLI',
        });
      }
      if ((object(parsed) && parsed.loggedIn === false) || (auth.status !== null && auth.status !== 0)) {
        return availability('unauthenticated', { version: reported, detail: 'run `claude auth login`' });
      }
      return availability('unavailable', { version: reported, detail: 'could not read Claude authentication status' });
    },
    run: (request, target) => claudeCliRunner(command, request, target),
  });
}
