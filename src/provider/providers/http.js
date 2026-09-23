// Direct HTTP providers: answer a policy's questions by calling a model API with
// fetch, so decisions run on serverless and edge-style hosts where starting a
// CLI process is not an option.
//
//   openaiProvider()     any OpenAI-compatible chat completions endpoint (OPENAI_API_KEY)
//   gatewayProvider()    Vercel AI Gateway, the same protocol (AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN)
//   anthropicProvider()  the Anthropic Messages API (ANTHROPIC_API_KEY)
//
// Each asks for the answer object with the policy's JSON Schema (json_schema
// response format, or a forced tool call), and maps HTTP failures onto the
// provider error kinds routing and fallback already understand.
import { ProviderError, availability, capabilities, provider, unreportedCost } from '../core.js';

const env = name => (typeof process !== 'undefined' ? process.env[name] : undefined) || null;
const retryable = ['timeout', 'connection', 'rate-limit', 'overload', 'invalid-output'];
const kindOf = status => status === 401 || status === 403 ? 'authentication'
  : status === 429 ? 'rate-limit'
  : status >= 500 ? 'overload'
  : 'provider-failure';
const fail = (id, target, kind, message, { status = null, detail = null, usage = {} } = {}) => new ProviderError(`provider ${id} ${message}`, {
  kind, target, retryable: retryable.includes(kind), mutated: false, usage, cost: unreportedCost(), status, detail: detail ?? message,
});

async function post(id, target, url, headers, body, timeoutSeconds, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST', signal: AbortSignal.timeout(timeoutSeconds * 1000),
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  } catch (error) {
    const timedOut = error.name === 'TimeoutError' || error.name === 'AbortError';
    throw fail(id, target, timedOut ? 'timeout' : 'connection', timedOut ? 'timed out' : `could not be reached: ${error.message}`);
  }
  const text = await response.text();
  // The body of an error is logged as detail, never echoed with credentials.
  if (!response.ok) throw fail(id, target, kindOf(response.status), `failed with HTTP ${response.status}`, { status: response.status, detail: text.slice(0, 500) });
  try { return { json: JSON.parse(text), requestId: response.headers.get('x-request-id') ?? response.headers.get('request-id') }; } catch {
    throw fail(id, target, 'invalid-output', 'returned a response that is not JSON', { status: response.status, detail: text.slice(0, 500) });
  }
}

const result = (output, target, model, usage, requestId) => ({
  output, target: target.model ? target : { ...target, model }, model, usage: usage ?? {},
  cost: unreportedCost(), requestId: requestId ?? null, exitStatus: 0, changed: [], attempts: [],
});
const schemaOf = (id, request, target) => {
  if (request.schema) return request.schema;
  throw fail(id, target, 'configuration', 'needs the answer schema on the request');
};

// OpenAI-compatible chat completions with a json_schema response format.
export function openaiProvider({
  id = 'openai', baseURL = env('OPENAI_BASE_URL') ?? 'https://api.openai.com/v1', apiKey = () => env('OPENAI_API_KEY'),
  model = env('JEV_OPENAI_MODEL') ?? 'gpt-5-mini', maxParallel = 8, timeoutSeconds = 60, headers = {}, fetch: fetchImpl = (...a) => globalThis.fetch(...a),
  keyHint = 'set OPENAI_API_KEY',
} = {}) {
  const key = () => typeof apiKey === 'function' ? apiKey() : apiKey;
  return provider({
    id,
    caps: capabilities({ modes: ['structured'], modalities: ['text'], permissions: ['read'], controls: ['structured-output'], efforts: [], maxParallel }),
    discover: async () => key() ? availability('ready', { detail: `${baseURL}` }) : availability('unauthenticated', { detail: keyHint }),
    run: async (request, target) => {
      const schema = schemaOf(id, request, target);
      const used = target.model ?? model;
      const { json, requestId } = await post(id, target, `${baseURL.replace(/\/+$/, '')}/chat/completions`, { authorization: `Bearer ${key()}`, ...headers }, {
        model: used,
        messages: [{ role: 'user', content: request.prompt }],
        response_format: { type: 'json_schema', json_schema: { name: 'jev_answers', schema, strict: false } },
      }, request.limits?.timeout_seconds ?? timeoutSeconds, fetchImpl);
      const content = json?.choices?.[0]?.message?.content;
      let output;
      try { output = typeof content === 'string' ? JSON.parse(content) : null; } catch { output = null; }
      if (!output || typeof output !== 'object') throw fail(id, target, 'invalid-output', 'returned no JSON answer object', { detail: String(content).slice(0, 500) });
      return result(output, target, json.model ?? used, json.usage, requestId ?? json.id);
    },
  });
}

// The deployment's OIDC token inside a Vercel Function: Vercel hands it to each
// request as the x-vercel-oidc-token header, reachable through the request
// context (what @vercel/oidc reads). In builds and `vercel env pull` it is the
// VERCEL_OIDC_TOKEN variable instead.
export function vercelOidcToken() {
  try {
    const headers = globalThis[Symbol.for('@vercel/request-context')]?.get?.()?.headers;
    const token = headers?.['x-vercel-oidc-token'];
    if (typeof token === 'string' && token) return token;
  } catch { /* not on Vercel */ }
  return env('VERCEL_OIDC_TOKEN');
}

// Vercel AI Gateway speaks the OpenAI protocol; models are "provider/model".
// On Vercel, the deployment's OIDC token authenticates without a key.
export const gatewayProvider = (options = {}) => openaiProvider({
  id: 'gateway', baseURL: 'https://ai-gateway.vercel.sh/v1',
  apiKey: () => env('AI_GATEWAY_API_KEY') ?? vercelOidcToken(),
  model: env('JEV_GATEWAY_MODEL') ?? 'openai/gpt-5-mini',
  keyHint: 'set AI_GATEWAY_API_KEY (or deploy on Vercel for VERCEL_OIDC_TOKEN)',
  ...options,
});

// Anthropic Messages API, with the answer object forced through a tool call.
export function anthropicProvider({
  id = 'anthropic', baseURL = env('ANTHROPIC_BASE_URL') ?? 'https://api.anthropic.com/v1', apiKey = () => env('ANTHROPIC_API_KEY'),
  model = env('JEV_ANTHROPIC_MODEL') ?? 'claude-haiku-4-5', maxTokens = 2048, maxParallel = 8, timeoutSeconds = 60,
  fetch: fetchImpl = (...a) => globalThis.fetch(...a),
} = {}) {
  const key = () => typeof apiKey === 'function' ? apiKey() : apiKey;
  return provider({
    id,
    caps: capabilities({ modes: ['structured'], modalities: ['text'], permissions: ['read'], controls: ['structured-output'], efforts: [], maxParallel }),
    discover: async () => key() ? availability('ready', { detail: baseURL }) : availability('unauthenticated', { detail: 'set ANTHROPIC_API_KEY' }),
    run: async (request, target) => {
      const schema = schemaOf(id, request, target);
      const used = target.model ?? model;
      const { json, requestId } = await post(id, target, `${baseURL.replace(/\/+$/, '')}/messages`, { 'x-api-key': key(), 'anthropic-version': '2023-06-01' }, {
        model: used, max_tokens: maxTokens,
        messages: [{ role: 'user', content: request.prompt }],
        tools: [{ name: 'answer', description: 'Return the answer object for every question.', input_schema: schema }],
        tool_choice: { type: 'tool', name: 'answer' },
      }, request.limits?.timeout_seconds ?? timeoutSeconds, fetchImpl);
      const call = Array.isArray(json?.content) ? json.content.find(part => part.type === 'tool_use') : null;
      if (!call || typeof call.input !== 'object') throw fail(id, target, 'invalid-output', 'returned no tool call with the answers', { detail: JSON.stringify(json).slice(0, 500) });
      return result(call.input, target, json.model ?? used, json.usage, requestId ?? json.id);
    },
  });
}
