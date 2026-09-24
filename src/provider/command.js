// A provider that is any executable speaking the jev-provider/1 protocol: one
// JSON request on stdin, one JSON object on stdout (or a stream of events whose
// last "result" event carries it). The executable sees only the environment it
// was allowed, and its structured output is checked against the request schema.
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { own, object, finite } from '../common.js';
import { ProviderError, availability, provider, unreportedCost } from './core.js';
import { environmentReader } from './config.js';
import { runProgram } from './process.js';
import { jsonSchemaValid } from './schema.js';

const minimumEnvironment = ['HOME', 'PATH'];
export function findExecutable(name) {
  if (name.includes('/')) return existsSync(name) ? name : null;
  const path = environmentReader.get('PATH') ?? '';
  for (const directory of path.split(delimiter)) {
    if (directory === '') continue;
    const candidate = join(directory, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
export const allowedEnvironment = names => Object.fromEntries([...new Set([...minimumEnvironment, ...names])]
  .map(name => [name, environmentReader.get(name)])
  .filter(([, value]) => value != null));

const requestWire = (request, target) => ({
  protocol: 'jev-provider/1',
  operation: request.operation,
  mode: request.mode,
  role: request.role,
  task: { kind: request.kind ?? null, tier: request.tier ?? null },
  model: target.model ?? null,
  effort: target.effectiveEffort ?? null,
  prompt: request.prompt,
  schema: request.schema ?? null,
  inputs: { images: request.images },
  workspace: request.directory ? { directory: request.directory, permissions: request.permissions } : null,
  limits: request.limits,
  metadata: request.metadata,
});

const parseJson = text => { try { return JSON.parse(text); } catch { return null; } };
// A whole-document response, else the last "result" event of a stream.
function parseResponse(stdout) {
  const whole = parseJson(stdout);
  if (object(whole)) return whole;
  return stdout.split('\n').map(line => line.trim()).filter(line => line !== '')
    .map(parseJson).filter(event => object(event) && event.type === 'result').pop() ?? null;
}
const responseUsage = response => object(response?.usage) ? response.usage : {};
// Reported USD, a subscription call, and unreported usage stay distinct.
function responseCost(response) {
  const value = response?.cost;
  if (object(value)) return { mode: value.mode ?? 'unreported', usd: finite(value.usd) ? value.usd : null };
  if (finite(value)) return { mode: 'reported-usd', usd: value };
  return unreportedCost();
}
const retryableKinds = ['unavailable', 'authentication', 'timeout', 'rate-limit', 'overload', 'invalid-output', 'provider-failure'];
function commandError(id, target, kind, status, response, { retryable = retryableKinds.includes(kind), mutated = false } = {}) {
  const message = kind === 'timeout' ? `provider ${id} timed out`
    : kind === 'invalid-output' ? `provider ${id} returned invalid structured output`
    : `provider ${id} failed (${kind})`;
  return new ProviderError(message, {
    kind, target, retryable: Boolean(retryable), mutated: Boolean(mutated),
    usage: responseUsage(response), cost: responseCost(response), status, detail: message,
  });
}

export function commandProvider(id, command, { caps, environment = [], timeoutSeconds = 300 } = {}) {
  const parts = typeof command === 'string' ? [command] : command;
  if (!Array.isArray(parts) || parts.length === 0 || !parts.every(x => typeof x === 'string')) {
    throw new TypeError('a command is an executable name or a non-empty list of strings');
  }
  const [executable, ...args] = parts;
  return provider({
    id,
    caps,
    discover: async () => {
      const path = findExecutable(executable);
      return path ? availability('ready', { detail: path }) : availability('missing', { detail: `${executable} is not on PATH` });
    },
    run: async (request, target) => {
      const timeout = own(request.limits, 'timeout_seconds') ? request.limits.timeout_seconds : timeoutSeconds;
      // Resolved before spawning, so a restricted environment cannot change
      // which executable runs.
      const resolved = findExecutable(executable) ?? executable;
      const { status, stdout } = await runProgram(resolved, args, {
        stdin: JSON.stringify(requestWire(request, target)),
        timeoutSeconds: timeout,
        dir: request.directory,
        env: allowedEnvironment(environment),
      });
      if (status === null) throw commandError(id, target, 'timeout', null, null);
      const response = parseResponse(stdout);
      if (status !== 0) {
        const error = object(response?.error) ? response.error : null;
        const kind = typeof error?.kind === 'string' ? error.kind : 'provider-failure';
        throw commandError(id, target, kind, status, response, {
          retryable: error && own(error, 'retryable') ? error.retryable : retryableKinds.includes(kind),
          mutated: error?.mutated ?? false,
        });
      }
      if (!response || !own(response, 'output')) throw commandError(id, target, 'invalid-output', status, response);
      if (!jsonSchemaValid(request.schema, response.output)) throw commandError(id, target, 'invalid-output', status, response);
      return {
        output: response.output,
        target,
        model: response.model ?? target.model ?? null,
        usage: responseUsage(response),
        cost: responseCost(response),
        requestId: response.provider_request_id ?? null,
        exitStatus: status,
        changed: Array.isArray(response.changed) ? response.changed : [],
        attempts: [],
      };
    },
  });
}
