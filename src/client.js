// The TypeSafe System One call: POST {TYPESAFE_BASE_URL}/v1/systemone with the
// state, the model and the questions, and the answers back. TLS is verified (the
// platform's fetch does it), each attempt has a timeout, and the retry policy is
// the SDKs': 408, 429 and 5xx, exponential backoff with subtractive jitter, a
// server's retry-after honoured up to a minute, and a total budget.
//
// Nothing here invents an API detail: every field and status comes from the
// documented API behaviour.
import { setTimeout as waitFor } from 'node:timers/promises';
import { object, own, requireAt } from './common.js';
import { prepareJevRequest, encodeJevRequest, requestHeaders } from './typesafe-request.js';

export const settings = {
  apiKey: null,            // null reads TYPESAFE_API_KEY at call time
  baseUrl: null,           // null reads TYPESAFE_BASE_URL
  defaultModel: null,      // null reads TYPESAFE_DEFAULT_MODEL, else jev-1.14.0
  timeoutSeconds: 10,
  // A function (payload) -> response body, for tests and replay. A transport has
  // no headers, so a request_id key in its result stands in for the header.
  transport: null,
  extraBody: null,
  sleep: (seconds, signal) => waitFor(seconds * 1000, undefined, { signal }),
  clock: () => Date.now(),
  random: Math.random,
  pacer: null,             // called before every attempt; batching paces with it
  onRetryAfter: null,      // (seconds) -> void, when a response asks us to wait
  onUsage: null,           // (usage) -> void, after every successful call
  environment: name => process.env[name],
};
export const defaultRetryPolicy = {
  maxRetries: 2, backoffInitial: 0.5, backoffMax: 5, jitter: 0.25,
  statuses: [408, 429, ...Array.from({ length: 100 }, (_, i) => 500 + i)],
  respectRetryAfter: true, retryConnection: true, totalBudget: 30,
};
const retryAfterCap = 60;

export class JevApiError extends Error {
  constructor(message, { kind, status = null, requestId = null, retryAfterMs = null, body = null, retryable = false }) {
    super(message);
    this.name = 'JevApiError';
    Object.assign(this, { kind, status, requestId, retryAfterMs, body, retryable });
  }
}
const endpoint = (path = '/v1/systemone') => {
  const base = (settings.baseUrl ?? settings.environment('TYPESAFE_BASE_URL') ?? 'https://api.typesafe.ai').trim().replace(/\/+$/, '');
  return `${base}${path}`;
};
export const defaultModel = () => settings.defaultModel ?? settings.environment('TYPESAFE_DEFAULT_MODEL') ?? 'jev-1.14.0';
const apiKey = () => {
  const key = settings.apiKey ?? settings.environment('TYPESAFE_API_KEY');
  requireAt(typeof key === 'string' && key.trim() !== '', 'TYPESAFE_API_KEY', 'no TypeSafe API key', 'Set TYPESAFE_API_KEY, or inject a transport.', 'auth');
  return key;
};
export const apiKeyConfigured = () => {
  if (settings.transport) return true;
  const key = settings.apiKey ?? settings.environment('TYPESAFE_API_KEY');
  return typeof key === 'string' && key.trim() !== '';
};

const statusError = (url, status, requestId, retryAfterMs, text) => {
  let body = text;
  try { body = JSON.parse(text); } catch { /* the body may not be JSON */ }
  const [kind, hint] = status === 401 || status === 403 ? ['auth', 'check TYPESAFE_API_KEY: the key is missing, wrong, or not allowed this call']
    : status === 404 ? ['invalid', 'check TYPESAFE_BASE_URL: nothing is served at that URL']
    : status === 400 || status === 422 ? ['invalid', 'the request failed validation; the body names the offending field']
    : status === 413 ? ['size', 'request exceeds an image or body size limit']
    : status === 415 ? ['encoding', 'unsupported request encoding']
    : status === 429 ? ['rate-limit', 'rate limited: slow down or retry later']
    : status === 529 ? ['server', 'the API is overloaded; retry after a short delay']
    : status >= 500 && status <= 599 ? ['server', 'the server failed; this is usually transient']
    : ['http', null];
  const note = requestId ? ` (request ${requestId})` : '';
  const shown = text.trim() === '' ? '' : `\n  body: ${text.replace(/\s+/g, ' ').slice(0, 500)}`;
  return new JevApiError(`jev: HTTP ${status} from ${url}${note}${hint ? `\n  ${hint}` : ''}${shown}`,
    { kind, status, requestId, retryAfterMs, body });
};
// retry-after-ms wins over retry-after, which may be seconds or an HTTP date.
function retryAfterMs(headers) {
  const ms = headers.get('retry-after-ms');
  if (ms !== null && Number.isFinite(Number(ms))) return Number(ms);
  const after = headers.get('retry-after');
  if (after === null) return null;
  if (Number.isFinite(Number(after))) return Number(after) * 1000;
  const date = Date.parse(after);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}
const responseFrom = (url, requestId, body) => {
  const note = requestId ? ` (request ${requestId})` : '';
  requireAt(object(body), url, `the response from ${url}${note} is not a JSON object`, undefined, 'response');
  requireAt(object(body.answers), url, `the response from ${url}${note} has no 'answers' object`, `Keys present: ${Object.keys(body).sort().join(', ') || 'none'}.`, 'response');
  return {
    answers: body.answers,
    model: typeof body.model === 'string' ? body.model : null,
    usage: object(body.usage) ? body.usage : null,
    requestId: requestId ?? null,
    body,
    provider: 'typesafe',
    requestedModel: null, requestedEffort: null, effectiveEffort: null,
  };
};

const retryable = (policy, error) => {
  if (error instanceof JevApiError) {
    if (error.kind === 'connection' || error.kind === 'timeout') return policy.retryConnection;
    return error.status !== null && policy.statuses.includes(error.status);
  }
  return false;
};
const backoff = (policy, n) => Math.min(policy.backoffMax, policy.backoffInitial * 2 ** n) * (1 - policy.jitter * settings.random());
const requestedWait = error => {
  const ms = error.retryAfterMs;
  return Number.isFinite(ms) && ms > 0 ? Math.min(retryAfterCap, ms / 1000) : null;
};
// attempt : (remainingSeconds | null) -> value
async function withRetries(policy, what, attempt, signal) {
  cancelled(signal);
  const attempts = policy.maxRetries + 1;
  let deadline = policy.totalBudget ? settings.clock() + policy.totalBudget * 1000 : null;
  let last = null;
  for (let n = 0; ; n += 1) {
    if (settings.pacer) {
      const before = settings.clock();
      await cancellable(() => settings.pacer(signal), signal);
      // Pacing waits do not count against the total budget.
      if (deadline !== null) deadline += settings.clock() - before;
    }
    const remaining = deadline === null ? null : (deadline - settings.clock()) / 1000;
    if (remaining !== null && remaining <= 0) {
      throw new JevApiError(`${last ? `${last.message}\n  ` : ''}gave up after ${n} of ${attempts} attempts: the ${policy.totalBudget} s total budget ran out`,
        { kind: last?.kind ?? 'timeout', status: last?.status ?? null, requestId: last?.requestId ?? null, body: last?.body ?? null });
    }
    try {
      cancelled(signal);
      return await cancellable(() => attempt(remaining), signal);
    } catch (error) {
      if (!retryable(policy, error)) throw error;
      last = error;
      if (n + 1 >= attempts) {
        error.message = attempts > 1 ? `${error.message}\n  gave up after ${attempts} attempts` : error.message;
        throw error;
      }
      const wait = policy.respectRetryAfter ? requestedWait(error) : null;
      if (wait) settings.onRetryAfter?.(wait);
      const delay = Math.max(backoff(policy, n), wait ?? 0);
      if (deadline !== null && settings.clock() + delay * 1000 > deadline) {
        error.message = `${error.message}\n  gave up after ${n + 1} of ${attempts} attempts: the next retry would pass the ${policy.totalBudget} s total budget`;
        throw error;
      }
      if (delay > 0) await cancellable(() => settings.sleep(delay, signal), signal);
    }
  }
}

const cancelled = signal => {
  if (signal?.aborted) throw new JevApiError('jev: request cancelled', { kind: 'cancelled' });
};
// Remove the listener after either branch settles; no unhandled rejection from a late attempt.
async function cancellable(thunk, signal) {
  cancelled(signal);
  if (!signal) return thunk();
  let stop;
  const aborted = new Promise((_, reject) => {
    stop = () => reject(new JevApiError('jev: request cancelled', { kind: 'cancelled' }));
    signal.addEventListener('abort', stop, { once: true });
  });
  try { return await Promise.race([aborted, Promise.resolve().then(() => { cancelled(signal); return thunk(); })]); }
  finally { signal.removeEventListener('abort', stop); }
}
function retryPolicy(overrides) {
  const policy = { ...defaultRetryPolicy, ...(overrides ?? {}) };
  requireAt(Number.isInteger(policy.maxRetries) && policy.maxRetries >= 0, 'retry.maxRetries', 'expected nonnegative integer');
  for (const key of ['backoffInitial', 'backoffMax', 'jitter', 'totalBudget']) requireAt(typeof policy[key] === 'number' && Number.isFinite(policy[key]) && policy[key] >= 0, `retry.${key}`, 'expected nonnegative finite number');
  requireAt(policy.jitter <= 1 && Array.isArray(policy.statuses), 'retry', 'invalid retry jitter or statuses');
  return policy;
}
async function requestJson(url, method, prepared, options, remaining) {
  const seconds = [options.timeoutSeconds ?? settings.timeoutSeconds, remaining].filter(x => typeof x === 'number' && x > 0);
  const timeout = seconds.length ? AbortSignal.timeout(Math.max(1, Math.ceil(Math.min(...seconds) * 1000))) : null;
  const signals = [options.signal, timeout].filter(Boolean);
  const signal = signals.length ? AbortSignal.any(signals) : undefined;
  let raw;
  try {
    const encoded = method === 'GET' ? { headers: requestHeaders(options) } : await encodeJevRequest(prepared, options);
    cancelled(options.signal);
    raw = await fetch(url, { method, signal, ...encoded, headers: { ...encoded.headers, Authorization: `Bearer ${apiKey()}` } });
    const text = await raw.text();
    const requestId = raw.headers.get('x-typesafe-request-id');
    if (!raw.ok) throw statusError(url, raw.status, requestId, retryAfterMs(raw.headers), text);
    let body;
    try { body = JSON.parse(text); } catch {
      throw new JevApiError(`jev: the response from ${url} is not JSON\n  it starts: ${text.slice(0, 200)}`, { kind: 'response', status: raw.status, requestId });
    }
    return { body, requestId };
  } catch (error) {
    cancelled(options.signal);
    if (error instanceof JevApiError || error.code === 'validation' || error.code === 'state') throw error;
    const timedOut = timeout?.aborted || error.name === 'TimeoutError' || error.name === 'AbortError';
    throw new JevApiError(`jev: ${timedOut ? 'the request timed out' : 'could not reach'} ${url}: ${error.message}`, { kind: timedOut ? 'timeout' : 'connection' });
  }
}
export async function jevCall(state, questions, options = {}) {
  cancelled(options.signal);
  const requestedModel = options.model ?? defaultModel();
  const prepared = prepareJevRequest(state, questions, requestedModel, options, settings.extraBody);
  const transport = settings.transport;
  const response = await withRetries(retryPolicy(options.retry), transport ? 'transport' : endpoint(), async remaining => {
    if (transport) {
      const body = await transport(prepared.payload, { headers: prepared.headers, signal: options.signal, assets: prepared.manifest });
      return responseFrom('transport', typeof body?.request_id === 'string' ? body.request_id : null, body);
    }
    const { body, requestId } = await requestJson(endpoint(), 'POST', prepared, options, remaining);
    return responseFrom(endpoint(), requestId, body);
  }, options.signal);
  const result = { ...response, requestedModel, assets: prepared.manifest, experimental: prepared.experimental };
  // Paid calls count even when usage is unavailable or answers later fail validation.
  settings.onUsage?.(result.usage ?? {});
  return result;
}
export async function listModels(options = {}) {
  cancelled(options.signal);
  requestHeaders(options);
  const { body } = await withRetries(retryPolicy(options.retry), endpoint('/v1/models'), remaining => requestJson(endpoint('/v1/models'), 'GET', null, options, remaining), options.signal);
  requireAt(object(body) && Array.isArray(body.models) && body.models.every(m => object(m) && ['name', 'description', 'release_date'].every(k => typeof m[k] === 'string')), 'models', 'invalid models response', undefined, 'response');
  return body;
}
