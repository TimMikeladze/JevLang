// Webhooks: signed decisions out, signed events in.
//
// Out. webhookHandler(url, { secret }) is a dispatcher handler that POSTs a
// Standard Webhooks message (standardwebhooks.com) for each decision:
//
//   webhook-id:        the same on every retry, so the receiver can dedupe
//   webhook-timestamp: Unix seconds, per attempt
//   webhook-signature: v1,<base64 HMAC-SHA256(key, id.timestamp.body)>
//   body: {"type": "jev.decision", "timestamp", "data": {"decision", "explain", "state"?}}
//
// The key is the base64 part of a whsec_ secret; any other secret is used as its
// UTF-8 bytes. A connection error, a timeout, 408, 429 and 5xx are retried with
// backoff; any other status raises at once. The User-Agent is jev-webhooks and
// nothing else identifying is sent.
//
// In. A verifier is (headers, body, now) -> { ok, deliveryId, reason }. It runs
// before anything parses the body. headers are lowercased-name pairs, body the
// raw bytes, now Unix seconds. The delivery id falls back to the body's SHA-256.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { object, own, requireAt, finite } from './common.mjs';
import { explainDecision } from './explain.mjs';
import { registerHandlerType } from './handlers.mjs';

const sha256Hex = data => createHash('sha256').update(data).digest('hex');
const hmacHex = (key, data) => createHmac('sha256', key).update(data).digest('hex');
const hmacBase64 = (key, data) => createHmac('sha256', key).update(data).digest('base64');
const bytes = v => Buffer.isBuffer(v) ? v : Buffer.from(typeof v === 'string' ? v : String(v), 'utf8');
const sameText = (a, b) => {
  const x = Buffer.from(String(a), 'utf8'), y = Buffer.from(String(b), 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
};
const sameHex = (a, b) => sameText(String(a).toLowerCase(), String(b).toLowerCase());
const iso = seconds => new Date(seconds * 1000).toISOString().replace(/\.\d+Z$/, 'Z');

// envSecret('TICKETS_SECRET') reads the variable each time it is needed, so a
// missing secret is reported by name instead of as nothing.
export const envSecret = name => ({ envSecret: name });
export const isEnvSecret = v => object(v) && typeof v.envSecret === 'string';
// -> { secret, problem }
export function resolveSecret(s) {
  if (isEnvSecret(s)) {
    const value = process.env[s.envSecret];
    return typeof value === 'string' && value.trim() !== ''
      ? { secret: value.trim(), problem: null }
      : { secret: null, problem: `${s.envSecret} is unset or empty` };
  }
  if (typeof s === 'string' && s.trim() !== '') return { secret: s, problem: null };
  if (Buffer.isBuffer(s) && s.length > 0) return { secret: s, problem: null };
  if (!s || typeof s === 'string' || Buffer.isBuffer(s)) return { secret: null, problem: 'the secret is missing or empty' };
  return { secret: null, problem: 'the secret must be a string, bytes or envSecret("NAME")' };
}
// The HMAC key for a Standard Webhooks secret: the base64 after whsec_, else the
// UTF-8 bytes of the whole secret. -> the key, or null when the base64 is bad.
export function standardWebhooksKey(secret) {
  if (Buffer.isBuffer(secret)) return secret;
  requireAt(typeof secret === 'string', 'secret', 'a webhook secret is a string or bytes');
  if (!secret.startsWith('whsec_')) return Buffer.from(secret, 'utf8');
  const rest = secret.slice(6);
  const key = Buffer.from(rest, 'base64');
  // Buffer.from ignores what it cannot decode, so check it round-trips.
  return key.length > 0 && key.toString('base64').replace(/=+$/, '') === rest.replace(/=+$/, '') ? key : null;
}
// "v1,<base64>" for one message.
export function standardWebhooksSign(secret, id, timestamp, body) {
  const key = standardWebhooksKey(secret);
  requireAt(key !== null, 'secret', 'the webhook secret starts with whsec_ but the rest is not base64');
  return `v1,${hmacBase64(key, Buffer.concat([bytes(id), bytes('.'), bytes(timestamp), bytes('.'), bytes(body)]))}`;
}

export const headerRef = (headers, name) => {
  const wanted = name.toLowerCase();
  if (Array.isArray(headers)) {
    const hit = headers.find(([k]) => String(k).toLowerCase() === wanted);
    return hit ? hit[1] : null;
  }
  const hit = Object.entries(headers ?? {}).find(([k]) => k.toLowerCase() === wanted);
  return hit ? hit[1] : null;
};
const bodyId = (body, key) => {
  let parsed = null;
  try { parsed = JSON.parse(bytes(body).toString('utf8')); } catch { /* not JSON */ }
  const v = object(parsed) ? parsed[key] : null;
  if (typeof v === 'string') return v;
  if (Number.isInteger(v)) return String(v);
  return sha256Hex(bytes(body));
};
// null when fresh, else the reason.
function stale(text, now, tolerance, what) {
  const ts = typeof text === 'string' && /^\s*-?[0-9]{1,12}\s*$/.test(text) ? Number(text.trim()) : null;
  if (ts === null) return `${what} is not a Unix timestamp`;
  const off = Math.abs(now - ts);
  return off > tolerance
    ? `${what} is ${Math.round(off)} seconds ${ts < now ? 'old' : 'in the future'}; the tolerance is ${tolerance} seconds`
    : null;
}
const makeVerifier = (kind, secret, check) => {
  const verifier = (headers, body, now) => {
    const { secret: resolved, problem } = resolveSecret(secret);
    return problem
      ? { ok: false, deliveryId: null, reason: `the ${kind} verifier has no secret: ${problem}` }
      : check(resolved, headers, bytes(body), now);
  };
  verifier.kind = kind;
  verifier.secret = secret;
  return verifier;
};
// null when the verifier can check signatures, else why not.
export function verifierProblem(v) {
  if (typeof v !== 'function' || !v.kind) return null;
  const { secret, problem } = resolveSecret(v.secret);
  if (problem) return problem;
  if (v.kind === 'standard-webhooks' && standardWebhooksKey(secret) === null) {
    return 'the secret starts with whsec_ but the rest is not base64';
  }
  return null;
}

// Standard Webhooks: webhook-id, webhook-timestamp, webhook-signature (a
// space-separated list of v1,<base64>; any match is enough).
export const standardWebhooksVerifier = (secret, { tolerance = 300 } = {}) =>
  makeVerifier('standard-webhooks', secret, (s, headers, body, now) => {
    const id = headerRef(headers, 'webhook-id');
    const ts = headerRef(headers, 'webhook-timestamp');
    const sigs = headerRef(headers, 'webhook-signature');
    if (!(id && ts && sigs)) return { ok: false, deliveryId: null, reason: 'missing webhook-id, webhook-timestamp or webhook-signature' };
    const old = stale(ts, now, tolerance, 'webhook-timestamp');
    if (old) return { ok: false, deliveryId: null, reason: old };
    const key = standardWebhooksKey(s);
    if (key === null) return { ok: false, deliveryId: null, reason: 'the secret starts with whsec_ but the rest is not base64' };
    const want = hmacBase64(key, Buffer.concat([bytes(id), bytes('.'), bytes(ts.trim()), bytes('.'), body]));
    const matched = sigs.split(/\s+/).some(sig => sig.startsWith('v1,') && sameText(sig.slice(3), want));
    return matched ? { ok: true, deliveryId: id, reason: null } : { ok: false, deliveryId: null, reason: 'webhook-signature does not match' };
  });
// GitHub signs no timestamp, so replays are caught only by the seen markers.
export const githubVerifier = secret => makeVerifier('github', secret, (s, headers, body) => {
  const sig = headerRef(headers, 'x-hub-signature-256');
  if (!sig) return { ok: false, deliveryId: null, reason: 'missing X-Hub-Signature-256' };
  return sameHex(sig.trim(), `sha256=${hmacHex(bytes(s), body)}`)
    ? { ok: true, deliveryId: headerRef(headers, 'x-github-delivery') ?? sha256Hex(body), reason: null }
    : { ok: false, deliveryId: null, reason: 'X-Hub-Signature-256 does not match' };
});
// Stripe: t=<ts>,v1=<hex> over "t.body", keyed by the whole secret as text.
export const stripeVerifier = (secret, { tolerance = 300 } = {}) =>
  makeVerifier('stripe', secret, (s, headers, body, now) => {
    const header = headerRef(headers, 'stripe-signature');
    if (!header) return { ok: false, deliveryId: null, reason: 'missing Stripe-Signature' };
    const items = header.split(',').map(part => /^\s*([^=\s]+)=(.*?)\s*$/.exec(part)).filter(Boolean).map(m => [m[1], m[2]]);
    const t = items.find(([k]) => k === 't')?.[1];
    const v1s = items.filter(([k]) => k === 'v1').map(([, v]) => v);
    if (!t || v1s.length === 0) return { ok: false, deliveryId: null, reason: 'Stripe-Signature has no t= or no v1=' };
    const old = stale(t, now, tolerance, 'the Stripe-Signature timestamp');
    if (old) return { ok: false, deliveryId: null, reason: old };
    const want = hmacHex(bytes(s), Buffer.concat([bytes(t), bytes('.'), body]));
    return v1s.some(v => sameHex(v, want))
      ? { ok: true, deliveryId: bodyId(body, 'id'), reason: null }
      : { ok: false, deliveryId: null, reason: 'Stripe-Signature does not match' };
  });
// Slack: v0=<hex> over "v0:ts:body".
export const slackVerifier = (secret, { tolerance = 300 } = {}) =>
  makeVerifier('slack', secret, (s, headers, body, now) => {
    const sig = headerRef(headers, 'x-slack-signature');
    const ts = headerRef(headers, 'x-slack-request-timestamp');
    if (!(sig && ts)) return { ok: false, deliveryId: null, reason: 'missing X-Slack-Signature or X-Slack-Request-Timestamp' };
    const old = stale(ts, now, tolerance, 'X-Slack-Request-Timestamp');
    if (old) return { ok: false, deliveryId: null, reason: old };
    const want = `v0=${hmacHex(bytes(s), Buffer.concat([bytes('v0:'), bytes(ts.trim()), bytes(':'), body]))}`;
    return sameHex(sig.trim(), want)
      ? { ok: true, deliveryId: bodyId(body, 'event_id'), reason: null }
      : { ok: false, deliveryId: null, reason: 'X-Slack-Signature does not match' };
  });
// Anything else that signs the raw body with HMAC-SHA256.
export function hmacVerifier(secret, { header, encoding = 'hex', prefix = '', idHeader = null } = {}) {
  requireAt(typeof header === 'string', 'header', 'an HMAC verifier names the header carrying the signature');
  requireAt(['hex', 'base64'].includes(encoding), 'encoding', "encoding is 'hex' or 'base64'");
  return makeVerifier('hmac', secret, (s, headers, body) => {
    const sig = headerRef(headers, header);
    const want = prefix + (encoding === 'hex' ? hmacHex(bytes(s), body) : hmacBase64(bytes(s), body));
    if (!sig) return { ok: false, deliveryId: null, reason: `missing ${header}` };
    const matched = encoding === 'hex' ? sameHex(sig.trim(), want) : sameText(sig.trim(), want);
    return matched
      ? { ok: true, deliveryId: (idHeader && headerRef(headers, idHeader)) || sha256Hex(body), reason: null }
      : { ok: false, deliveryId: null, reason: `${header} does not match` };
  });
}

// A dispatch key is used as it is when it is plain (Standard Webhooks asks for
// no dots), else hashed into a msg_ id. Either way it is stable across retries.
export const keyToMessageId = key => {
  const s = String(key);
  return /^[A-Za-z0-9_:/-]{1,128}$/.test(s) ? s : `msg_${sha256Hex(s).slice(0, 32)}`;
};
// The URL without its path or query, for messages: a webhook URL can itself be
// a secret (Slack's are).
export function redactUrl(value) {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}/...`;
  } catch { return 'the webhook URL'; }
}
const retryableStatus = status => status === 408 || status === 429 || status >= 500;
const checkUrl = (who, value) => {
  let url = null;
  try { url = new URL(value); } catch { /* not a URL */ }
  requireAt(url && ['http:', 'https:'].includes(url.protocol) && url.hostname !== '', who,
    'the URL must be http:// or https:// with a host');
};

// -> a handler returning { status, webhook_id, attempts }
export function webhookHandler(url, {
  secret, attempts = 3, timeoutSeconds = 10, includeState = false, backoff = 1,
  type = 'jev.decision', sleep = seconds => new Promise(r => setTimeout(r, seconds * 1000)),
  now = () => Math.floor(Date.now() / 1000),
} = {}) {
  checkUrl('webhookHandler', url);
  const { secret: resolved, problem } = resolveSecret(secret);
  requireAt(!problem, 'secret', `webhookHandler: ${problem}`);
  const key = standardWebhooksKey(resolved);
  requireAt(key !== null, 'secret', 'webhookHandler: the secret starts with whsec_ but the rest is not base64');
  requireAt(Number.isInteger(attempts) && attempts > 0, 'attempts', 'attempts is a positive integer');
  requireAt(finite(timeoutSeconds) && timeoutSeconds > 0, 'timeoutSeconds', 'a timeout is positive seconds');
  requireAt(finite(backoff) && backoff >= 0, 'backoff', 'backoff is seconds, at least 0');
  const where = redactUrl(url);
  const handler = async (state, decision, context) => {
    const id = context?.key ? keyToMessageId(context.key) : `msg_${randomBytes(8).toString('hex')}`;
    const body = JSON.stringify({
      type,
      timestamp: iso(now()),
      data: {
        decision, explain: explainDecision(decision),
        ...(includeState ? { state } : {}),
      },
    });
    const fail = message => { throw new Error(message); };
    for (let attempt = 1; ; attempt += 1) {
      const ts = String(Math.floor(now()));
      let status = null, text = '', retryAfter = null, trouble = null;
      try {
        const response = await fetch(url, {
          method: 'POST',
          signal: AbortSignal.timeout(timeoutSeconds * 1000),
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'jev-webhooks',
            'webhook-id': id,
            'webhook-timestamp': ts,
            'webhook-signature': standardWebhooksSign(key, id, ts, body),
          },
          body,
        });
        status = response.status;
        text = (await response.text()).trim();
        const after = response.headers.get('retry-after');
        retryAfter = after !== null && /^\s*[0-9]+\s*$/.test(after) ? Number(after.trim()) : null;
      } catch (error) {
        trouble = error.name === 'TimeoutError' || error.name === 'AbortError'
          ? `timed out after ${timeoutSeconds} seconds` : 'could not connect';
      }
      const what = trouble ?? `answered ${status}${text === '' ? '' : `: ${text.length > 200 ? text.slice(0, 200) : text}`}`;
      if (status !== null && status >= 200 && status <= 299) return { status, webhook_id: id, attempts: attempt };
      if (status !== null && !retryableStatus(status)) {
        fail(`the webhook receiver at ${where} ${what}\n  not retried: only a connection error, a timeout, 408, 429 and 5xx are`);
      }
      if (attempt >= attempts) {
        fail(`the webhook receiver at ${where} ${what}, after ${attempts} attempt${attempts === 1 ? '' : 's'} (webhook-id ${id})`);
      }
      await sleep(Math.max(backoff * 2 ** (attempt - 1), retryAfter !== null && retryAfter <= 60 ? retryAfter : 0));
    }
  };
  handler.handlerName = `webhook ${where}`;
  return handler;
}

// For a handlers file ("type": "webhook"). Keys: url, secret_env (the name of
// the variable holding the secret, never the secret), attempts, timeout,
// include_state.
const specKeys = ['url', 'secret_env', 'attempts', 'timeout', 'include_state'];
const specIgnored = ['type', 'name', 'description', 'target'];
export function webhookHandlerFromSpec(spec) {
  const bad = (key, message) => requireAt(false, `webhook.${key}`, `"${key}" ${message}`, undefined, 'handler');
  requireAt(object(spec), 'webhook', `a webhook handler is a JSON object with ${specKeys.join(', ')}`, undefined, 'handler');
  for (const key of Object.keys(spec)) {
    if (!specKeys.includes(key) && !specIgnored.includes(key)) bad(key, `is not a webhook handler key\n  the keys are: ${specKeys.join(', ')}`);
  }
  const get = key => (spec[key] === null ? undefined : spec[key]);
  const url = get('url');
  if (typeof url !== 'string') bad('url', 'is required: the http(s) URL to POST to');
  try { checkUrl('webhook', url); } catch { bad('url', `must be http:// or https:// with a host; got ${JSON.stringify(url)}`); }
  const env = get('secret_env');
  if (!(typeof env === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(env))) {
    bad('secret_env', 'is required: the name of the environment variable holding the secret\n  (the secret itself never goes in the file)');
  }
  const { problem } = resolveSecret(envSecret(env));
  if (problem) bad('secret_env', `names ${env}, which is unset or empty`);
  const attempts = get('attempts') ?? 3;
  if (!(Number.isInteger(attempts) && attempts > 0)) bad('attempts', 'must be a positive integer');
  const timeoutSeconds = get('timeout') ?? 10;
  if (!(finite(timeoutSeconds) && timeoutSeconds > 0)) bad('timeout', 'must be a positive number of seconds');
  const includeState = own(spec, 'include_state') ? spec.include_state : false;
  if (typeof includeState !== 'boolean') bad('include_state', 'must be true or false');
  return webhookHandler(url, { secret: envSecret(env), attempts, timeoutSeconds, includeState });
}
// A handlers file can now declare signed delivery.
registerHandlerType('webhook', spec => webhookHandlerFromSpec(spec));

// What a wiring receives. A source names the <name> in POST /webhook/<name>,
// how to verify it, and how to turn its body into events.
export function webhookSource(name, { verify = null, event, sync = null, insecure = false } = {}) {
  const id = String(name);
  requireAt(/^[A-Za-z0-9_-]+$/.test(id), 'name',
    'a source name is letters, digits, _ and -, as it is the <name> in POST /webhook/<name>');
  requireAt(typeof event === 'function', `source.${id}`, 'event is a function of (json, headers)');
  requireAt(sync === null || typeof sync === 'function', `source.${id}`, 'sync is null or a function of (json, headers)');
  requireAt(verify === null || verify === 'none' || typeof verify === 'function', `source.${id}`,
    'verify is a verifier, a function of (headers, body, now), or "none"');
  return { name: id, verify, event, sync, insecure: Boolean(insecure) };
}
// One case to decide, and one outcome that labels a case a person already saw.
export const caseEvent = (id, input) => ({ kind: 'case', id: id === null || id === undefined ? null : String(id), input });
export const outcomeEvent = (id, { kind = null, label = null, labels = null } = {}) =>
  ({ kind: 'outcome', id: String(id), outcomeKind: kind, label, labels });
export const isCaseEvent = v => object(v) && v.kind === 'case';
export const isOutcomeEvent = v => object(v) && v.kind === 'outcome';
