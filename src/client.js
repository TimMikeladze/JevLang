// The TypeSafe System One call: POST {TYPESAFE_BASE_URL}/v1/systemone with the
// state, the model and the questions, and the answers back. TLS is verified (the
// platform's fetch does it), each attempt has a timeout, and the retry policy is
// the SDKs': 408, 429 and 5xx, exponential backoff with subtractive jitter, a
// server's retry-after honoured up to a minute, and a total budget.
//
// Nothing here invents an API detail: every field and status comes from the
// documented behaviour the Racket client implements.
import { object, own, requireAt } from './common.js';

export const settings = {
  apiKey: null,            // null reads TYPESAFE_API_KEY at call time
  baseUrl: null,           // null reads TYPESAFE_BASE_URL
  defaultModel: null,      // null reads TYPESAFE_DEFAULT_MODEL, else jev-latest
  timeoutSeconds: 10,
  // A function (payload) -> response body, for tests and replay. A transport has
  // no headers, so a request_id key in its result stands in for the header.
  transport: null,
  extraBody: null,
  sleep: seconds => new Promise(resolve => setTimeout(resolve, seconds * 1000)),
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
const endpoint = () => {
  const base = (settings.baseUrl ?? settings.environment('TYPESAFE_BASE_URL') ?? 'https://api.typesafe.ai').trim().replace(/\/+$/, '');
  return `${base}/v1/systemone`;
};
export const defaultModel = () => settings.defaultModel ?? settings.environment('TYPESAFE_DEFAULT_MODEL') ?? 'jev-latest';
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
async function withRetries(policy, what, attempt) {
  const attempts = policy.maxRetries + 1;
  let deadline = policy.totalBudget ? settings.clock() + policy.totalBudget * 1000 : null;
  let last = null;
  for (let n = 0; ; n += 1) {
    if (settings.pacer) {
      const before = settings.clock();
      await settings.pacer();
      // Pacing waits do not count against the total budget.
      if (deadline !== null) deadline += settings.clock() - before;
    }
    const remaining = deadline === null ? null : (deadline - settings.clock()) / 1000;
    if (remaining !== null && remaining <= 0) {
      throw new JevApiError(`${last ? `${last.message}\n  ` : ''}gave up after ${n} of ${attempts} attempts: the ${policy.totalBudget} s total budget ran out`,
        { kind: last?.kind ?? 'timeout', status: last?.status ?? null, requestId: last?.requestId ?? null, body: last?.body ?? null });
    }
    try {
      return await attempt(remaining);
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
      if (delay > 0) await settings.sleep(delay);
    }
  }
}

export async function jevCall(state, questions, { model = null, timeoutSeconds = settings.timeoutSeconds, retry = defaultRetryPolicy } = {}) {
  const requestedModel = model ?? defaultModel();
  let payload = { state, model: requestedModel, questions };
  if (settings.extraBody) {
    for (const key of Object.keys(settings.extraBody)) {
      requireAt(!['state', 'model', 'questions'].includes(key), `extraBody.${key}`, `extraBody cannot set '${key}'`);
    }
    payload = { ...payload, ...settings.extraBody };
  }
  const transport = settings.transport;
  const response = await withRetries(retry, transport ? 'transport' : endpoint(), async remaining => {
    if (transport) {
      const body = await transport(payload);
      // A transport has no headers, so a request_id key stands in for one.
      return responseFrom('transport', typeof body?.request_id === 'string' ? body.request_id : null, body);
    }
    const url = endpoint();
    const seconds = [timeoutSeconds, remaining].filter(x => typeof x === 'number' && x > 0);
    const signal = seconds.length ? AbortSignal.timeout(Math.min(...seconds) * 1000) : undefined;
    let raw;
    try {
      raw = await fetch(url, {
        method: 'POST', signal,
        headers: { Authorization: `Bearer ${apiKey()}`, Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch (error) {
      const timedOut = error.name === 'TimeoutError' || error.name === 'AbortError';
      throw new JevApiError(`jev: ${timedOut ? 'the request timed out' : 'could not reach'} ${url}: ${error.message}`,
        { kind: timedOut ? 'timeout' : 'connection' });
    }
    const requestId = raw.headers.get('x-typesafe-request-id');
    const text = await raw.text();
    if (raw.status < 200 || raw.status > 299) throw statusError(url, raw.status, requestId, retryAfterMs(raw.headers), text);
    let body;
    try { body = JSON.parse(text); } catch {
      throw new JevApiError(`jev: the response from ${url} is not JSON\n  it starts: ${text.slice(0, 200)}`, { kind: 'response', status: raw.status, requestId });
    }
    return responseFrom(url, requestId, body);
  });
  const result = { ...response, requestedModel };
  // Recorded before anything validates it: the call was paid for either way.
  if (result.usage) settings.onUsage?.(result.usage);
  return result;
}
