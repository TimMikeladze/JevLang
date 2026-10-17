// From a policy and an input to a decision: build the state, build the
// questions, ask the selected provider for the answers, validate them, and
// decide. The provider is chosen by the same layered routing every other call
// uses, and the decision carries which provider, model and effort answered.
import { object, own, requireAt, canonical, fingerprint, jsonCopy, fail } from './common.js';
import { validateAnswers } from './engine.js';
import { defaultModel } from './client.js';
import { prepareJevRequest } from './typesafe-request.js';
import { inspectAssets, assetIdentity, mergeAssets, maxPortableBytes } from './assets.js';
import { checkRequestBudget } from './budgets.js';
import { jevCall, apiKeyConfigured, settings as clientSettings } from './client.js';
import {
  ProviderError, ProviderRegistry, availability, capabilities, provider, providerRequest, targetSpec,
  loadProviderConfig, matchingProviderRoute, configLayers, resolveProvider, runProviderRequest, unreportedCost,
  makeDefaultRegistry, openaiProvider, gatewayProvider, anthropicProvider,
} from './provider/index.js';

const probabilitySchema = { type: 'object' };
// The schema the answers must satisfy, question by question.
function answerSchema(question) {
  const common = { type: { type: 'string', const: question.type } };
  switch (question.type) {
    case 'choice': return {
      type: 'object',
      properties: {
        ...common,
        choice: { type: 'string', enum: Object.keys(question.criteria ?? {}).sort() },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        probabilities: probabilitySchema,
      },
      required: ['type', 'choice'],
      additionalProperties: true,
    };
    case 'score': return {
      type: 'object',
      properties: {
        ...common,
        score: { type: 'number' },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        probabilities: probabilitySchema,
        legend: { type: 'object' },
      },
      required: ['type', 'score'],
      additionalProperties: true,
    };
    case 'box': return {
      type: 'object', properties: { ...common, box: { type: 'object', properties: Object.fromEntries(['top','bottom','left','right'].map(k => [k, { type: 'number', minimum: 0, maximum: 1 }])), required: ['top','bottom','left','right'], additionalProperties: false }, confidence: { type: ['number','null'], minimum: 0, maximum: 1 } }, required: ['type','box'], additionalProperties: true,
    };
    case 'noul': return {
      type: 'object',
      properties: { ...common, noul: { type: 'number', minimum: 0, maximum: 1 } },
      required: ['type', 'noul'],
      additionalProperties: true,
    };
    default: return { type: 'object' };
  }
}
export function questionsAnswerSchema(questions) {
  requireAt(object(questions), 'questions', 'expected a question map');
  const ids = Object.keys(questions).sort();
  return {
    type: 'object',
    properties: Object.fromEntries(ids.map(id => [id, answerSchema(questions[id])])),
    required: ids,
    additionalProperties: false,
  };
}
export const policyPrompt = (state, questions) =>
  'Answer every Jev policy question using only the supplied state. '
  + 'Return the answer object required by the JSON Schema.\n\n'
  + `<jev-state>\n${JSON.stringify(state)}\n</jev-state>\n\n`
  + `<jev-questions>\n${JSON.stringify(questions)}\n</jev-questions>`;

// The TypeSafe System One provider: the policy's own API, wrapped in the same
// provider contract as every executable, so routing and fallback treat it alike.
export function typesafeProvider({ maxParallel = 4 } = {}) {
  return provider({
    id: 'typesafe',
    caps: capabilities({ modes: ['structured'], modalities: ['text', 'image'], permissions: ['read'], controls: ['structured-output', 'box', 'typesafe-options'], efforts: [], maxParallel }),
    discover: async () => apiKeyConfigured()
      ? availability('ready', { detail: 'configured TypeSafe System One API' })
      : availability('unauthenticated', { detail: 'set TYPESAFE_API_KEY' }),
    run: async (request, target) => {
      const state = request.metadata.state;
      const questions = request.metadata.questions;
      if (!object(questions)) {
        throw new ProviderError('TypeSafe policy requests require a question map', { kind: 'configuration', target, detail: 'missing questions metadata' });
      }
      let response;
      try {
        response = await jevCall(state, questions, { ...request.metadata.typesafe, ...request.typesafeRequestOptions, model: target.model });
      } catch (error) {
        const kind = { cancelled: 'cancelled', auth: 'authentication', timeout: 'timeout', 'rate-limit': 'rate-limit', server: 'overload', response: 'invalid-output', connection: 'connection' }[error.kind] ?? 'provider-failure';
        throw new ProviderError(error.message, {
          kind, target,
          retryable: ['timeout', 'connection', 'rate-limit', 'overload'].includes(kind),
          usage: {}, cost: unreportedCost(), status: error.status ?? null, detail: error.message,
        });
      }
      return {
        assets: response.assets, experimental: response.experimental,
        output: response.answers,
        target: target.model ? target : { ...target, model: response.requestedModel },
        model: response.model,
        usage: response.usage ?? {},
        cost: unreportedCost(),
        requestId: response.requestId,
        exitStatus: 0,
        changed: [],
        attempts: [],
      };
    },
  });
}
// The registry a policy asks through: TypeSafe first, then every configured
// executable, then the direct HTTP providers (openai, gateway, anthropic), each
// ready once its key is set. An application's own registration of an id wins.
// `providers.<id>.max_parallel` sets each one's limit, as it does for the CLIs.
export function makePolicyRegistry(config = loadProviderConfig()) {
  const parallel = id => {
    const settings = object(config.providers) && object(config.providers[id]) ? config.providers[id] : {};
    if (!own(settings, 'max_parallel')) return {};
    requireAt(Number.isInteger(settings.max_parallel) && settings.max_parallel > 0, `providers.${id}.max_parallel`, 'max_parallel must be a positive integer');
    return { maxParallel: settings.max_parallel };
  };
  return makeDefaultRegistry(config).overlay([typesafeProvider(parallel('typesafe'))], { prepend: true })
    .overlay([openaiProvider(parallel('openai')), gatewayProvider(parallel('gateway')), anthropicProvider(parallel('anthropic'))]);
}
// One registry per configuration, so calls that pass none share discovery and
// parallelism slots: max_parallel then holds across concurrent calls.
const sharedRegistries = new Map();
export function sharedPolicyRegistry(config) {
  const key = canonical(config);
  if (!sharedRegistries.has(key)) {
    if (sharedRegistries.size >= 16) sharedRegistries.clear();
    sharedRegistries.set(key, makePolicyRegistry(config));
  }
  return sharedRegistries.get(key);
}
export const policyConfigDefaults = { provider: 'typesafe', preferences: ['typesafe', 'claude', 'codex'] };

const normalizeEffort = value => value == null ? null : (String(value).toLowerCase() === 'auto' ? 'auto' : value);
export function policyProviderRequest(state, questions, options = {}) {
  const { provider: id = null, model = null, effort = null, role = 'policy' } = options;
  const typesafe = Object.fromEntries(['assets','experimental','compression','assetTransport'].filter(k => own(options,k)).map(k=>[k,options[k]]));
  const hasImages = Object.keys(options.assets ?? {}).length > 0;
  const hasBox = Object.values(questions).some(q=>q.type==='box');
  const request = providerRequest('policy', 'structured', {
    role, kind: 'policy', tier: 'policy', modalities: hasImages ? ['text','image'] : ['text'], permissions: ['read'],
    prompt: hasImages ? '' : policyPrompt(state, questions),
    schema: questionsAnswerSchema(questions),
    target: targetSpec({ provider: id, model, effort: normalizeEffort(effort) }),
    metadata: { state, questions, ...(Object.keys(typesafe).length ? { typesafe } : {}), requiredControls: [...(hasBox ? ['box'] : []), ...(Object.keys(typesafe).length ? ['typesafe-options'] : [])] },
  });
  request.typesafeRequestOptions = Object.fromEntries(['signal','headers','timeoutSeconds','retry'].filter(k=>own(options,k)).map(k=>[k,options[k]]));
  return request;
}
export function policyJevOptions(spec, options = {}) {
  const defaults = spec.typesafe ?? {};
  const typesafe = { ...defaults, ...Object.fromEntries(['compression','assetTransport'].filter(k=>own(options,k)).map(k=>[k,options[k]])) };
  if (defaults.assets || options.assets) typesafe.assets = mergeAssets(defaults.assets, options.assets);
  if (defaults.experimental || options.experimental) typesafe.experimental = { ...defaults.experimental, ...options.experimental };
  return typesafe;
}

/**
 * A model may name a score's level instead of numbering it: `{"score": "Angry,
 * threatening to leave"}`, or a distribution keyed by the level's name. That is
 * the same answer in the question's own words, so it is translated to the
 * levels the policy declared — a name that matches no level is left exactly as
 * it came, and validation refuses it. Nothing is guessed at.
 */
export function normalizeAnswers(questions, answers) {
  if (!object(questions) || !object(answers)) return answers;
  for (const [id, question] of Object.entries(questions)) {
    const answer = answers[id];
    if (object(answer) && question?.type === 'box' && answer.confidence == null) answer.confidence = null;
    if (!object(answer) || question?.type !== 'score') continue;
    const levels = Array.isArray(question.criteria) ? question.criteria : [];
    const names = levels.map(level => object(level) ? (level.name ?? null) : level);
    const indexOf = name => names.findIndex(n => n !== null && String(n) === String(name));
    if (typeof answer.score === 'string') {
      const index = /^(0|[1-9][0-9]*)$/.test(answer.score) ? Number(answer.score) : indexOf(answer.score);
      if (index >= 0) answer.score = index;
    }
    // A model that numbered the levels itself says so in `legend`; a score
    // read against its own legend is read in the question's terms.
    if (typeof answer.score === 'number' && object(answer.legend)) {
      const named = answer.legend[String(answer.score)];
      const index = named === undefined ? -1 : indexOf(named);
      if (index >= 0) answer.score = index;
    }
    if (object(answer.probabilities)) {
      const mapped = {};
      let changed = false;
      for (const [key, value] of Object.entries(answer.probabilities)) {
        const index = /^(0|[1-9][0-9]*)$/.test(key) ? -1 : indexOf(key);
        if (index >= 0) { mapped[String(index)] = value; changed = true; } else { mapped[key] = value; }
      }
      if (changed) answer.probabilities = mapped;
    }
  }
  return answers;
}

export async function runPolicyProvider(state, questions, options = {}) {
  const { provider: id = null, model = null, effort = null, config = null, registry = null, role = 'policy' } = options;
  const request = policyProviderRequest(state, questions, options);
  if (request.metadata.typesafe) prepareJevRequest(state, questions, model, options);
  checkRequestBudget(state, questions, options);
  const resolvedConfig = config ?? loadProviderConfig({ defaults: policyConfigDefaults, role });
  const resolvedRegistry = registry ?? sharedPolicyRegistry(resolvedConfig);
  return runProviderRequest(request, resolvedConfig, resolvedRegistry, {
    observe: result => { if (result.target.provider.id !== 'typesafe' && result.usage) clientSettings.onUsage?.(result.usage); },
    validate: answers => {
      try { validateAnswers(questions, normalizeAnswers(questions, answers)); return null; } catch (error) { return error.message; }
    },
  });
}

// Whether anything but the defaults asked for a particular provider, model or
// effort. A missing implicit credential then means "no configured decision",
// while an explicit selection that cannot resolve stays an error.
export function explicitPolicySelection(config, request, { provider: id = null, model = null, effort = null } = {}) {
  if (id || model || effort) return true;
  if (matchingProviderRoute(config, request)) return true;
  return configLayers(config).some(([name, layer]) =>
    name !== 'default' && ['provider', 'prefer', 'preferences', 'model', 'effort', 'fallback'].some(key => Object.hasOwn(layer, key)));
}

// The answers a provider gave, keyed by what it was asked and who was asked:
// the built state, the questions and the provider/model/effort selection. The
// routes are not in the key, so editing them keeps the cache.
export const answerCacheKey = (state, questions, selection, options = {}) => {
  const assets = inspectAssets(options.assets ?? {}, { state, questions });
  return fingerprint({ cache_version: 2, ...assetIdentity(state, questions, assets), provider: selection.provider, model: selection.model, effort: selection.effort, experimental: { images: options.experimental?.images === true, longContext: options.experimental?.longContext === true } });
};

// What evaluateWithProvider reads back from a cached provider result, as plain
// JSON: a durable cache stores this, and the decision it produces carries the
// same answers and provenance as the live one.
export const answerRecord = result => ({
  output: jsonCopy(result.output),
  ...(typeof result.cacheTime === 'number' ? { cacheTime: result.cacheTime } : {}),
  ...(result.assets ? { assets: result.assets } : {}),
  ...(result.experimental ? { experimental: result.experimental } : {}),
  model: result.model ?? null,
  requestId: result.requestId ?? null,
  target: {
    provider: { id: result.target.provider.id },
    model: result.target.model ?? null,
    requestedEffort: result.target.requestedEffort ?? null,
    effectiveEffort: result.target.effectiveEffort ?? null,
  },
});

// policy    : a CompiledPolicy
// cache     : a Map-like store with synchronous get/set (optional delete) holding
//             each call's promise; an identical row waits on the same call, and a
//             failed call is not kept
// cacheOnly : decide from the cache or throw code 'uncached'; no provider is asked
export async function evaluateWithProvider(policy, input, { provider: id = null, model = null, effort = null, profile = null, config = null, registry = null, role = 'policy', cache = null, cacheOnly = false, ...requestOptions } = {}) {
  requireAt(!cacheOnly || cache, 'cacheOnly', 'cacheOnly needs a cache to read answers from');
  const spec = policy.policy;
  const selection = { provider: id ?? spec.provider ?? null, model: model ?? spec.model ?? null, effort: effort ?? spec.effort ?? null };
  const jevOptions = policyJevOptions(spec, requestOptions);
  const { state, facts } = policy.buildState(input, { ...jevOptions, ...requestOptions });
  const pre = policy.precheck(input, { ...jevOptions, profile });
  if (pre) return pre;
  const questions = policy.questions(state);
  checkRequestBudget(state, questions, { ...spec.stateOptions, ...jevOptions });
  if (Object.keys(jevOptions).length) prepareJevRequest(state, questions, selection.model, jevOptions);
  const resolvedConfig = config ?? loadProviderConfig({ defaults: policyConfigDefaults, role });
  const resolvedRegistry = registry ?? sharedPolicyRegistry(resolvedConfig);
  const ask = () => runPolicyProvider(state, questions, { ...requestOptions, ...jevOptions, ...selection, config: resolvedConfig, registry: resolvedRegistry, role });
  let result, cached = false;
  if (cache) {
    // Looked up and claimed with no await between, so rows that start together
    // share one call.
    const { target } = await resolveProvider(policyProviderRequest(state, questions, { ...selection, ...jevOptions }), resolvedConfig, resolvedRegistry, { offline: cacheOnly });
    const effective = { provider: target.provider.id, model: target.model ?? (target.provider.id === 'typesafe' ? defaultModel() : null), effort: target.effectiveEffort };
    const key = answerCacheKey(state, questions, effective, jevOptions);
    let hit = cache.get(key);
    const maxAge = requestOptions.cacheMaxAgeSeconds ?? (/^jev-(latest|preview)$/.test(effective.model ?? '') ? 300 : null);
    requireAt(maxAge === null || typeof maxAge === 'number' && Number.isFinite(maxAge) && maxAge >= 0, 'cacheMaxAgeSeconds', 'expected nonnegative seconds');
    if (hit && typeof hit.then !== 'function' && maxAge !== null && (!Number.isFinite(hit.cacheTime) || clientSettings.clock() - hit.cacheTime >= maxAge * 1000)) { cache.delete?.(key); hit = null; }
    if (hit !== undefined && hit !== null) {
      result = await hit; cached = true;
    } else if (cacheOnly) {
      fail('uncached', '$.cache', 'no cached answer for this input', 'Drop cacheOnly to ask the provider, or warm the cache first.');
    } else {
      const pending = ask().then(value => ({ ...value, cacheTime: clientSettings.clock() }));
      cache.set(key, pending);
      try {
        result = await pending;
        if (cache.get(key) === pending) {
          const actual = { provider: result.target.provider.id, model: result.target.model ?? (result.target.provider.id === 'typesafe' ? defaultModel() : null), effort: result.target.effectiveEffort };
          if (canonical(actual) === canonical(effective)) cache.set(key, result);
          else if (cache.delete) cache.delete(key); else cache.set(key, undefined);
        }
      } catch (error) { cache.delete?.(key); throw error; }
    }
  } else {
    result = await ask();
  }
  const answers = jsonCopy(result.output);
  validateAnswers(questions, answers);
  const decision = policy.decide(answers, { facts, state, profile });
  const target = result.target;
  return {
    ...decision,
    provider: target.provider.id,
    requested_model: target.model ?? null,
    model: result.model ?? null,
    requested_effort: target.requestedEffort ?? null,
    effective_effort: target.effectiveEffort ?? null,
    request_id: result.requestId ?? null,
    ...(cached ? { cached: true } : {}),
  };
}

// A package-owned policy: the same routing, but an unresolvable implicit
// TypeSafe credential means there is no configured decision, so a caller can
// keep its documented facts-only behaviour.
export async function evaluateConfiguredPolicy(policy, input, { start = process.cwd(), package: pkg = {}, provider: id = null, model = null, effort = null, registry = null, ...requestOptions } = {}) {
  const config = loadProviderConfig({ start, defaults: policyConfigDefaults, package: pkg, role: 'policy' });
  const resolvedRegistry = registry ?? sharedPolicyRegistry(config);
  const request = policyProviderRequest('', policy.staticQuestions(), { provider: id, model, effort });
  try {
    await resolveProvider(request, config, resolvedRegistry);
  } catch (error) {
    if (error instanceof ProviderError && error.kind === 'unavailable' && !explicitPolicySelection(config, request, { provider: id, model, effort })) return null;
    throw error;
  }
  return evaluateWithProvider(policy, input, { ...requestOptions, provider: id, model, effort, config, registry: resolvedRegistry });
}

// A fixture (version 3) recorded from a real call: the provenance is required,
// so a replay can never claim an answer came from somewhere it did not.
export function fixtureFromRun({ name, policy, state, questions, decision = null, result, synthetic = false, expect = null, assets = null, embedAssets = false }) {
  const target = result.target;
  return {
    fixture_version: Object.keys(result.assets ?? {}).length || result.experimental?.longContext || result.experimental?.images ? 4 : 3,
    ...(Object.keys(result.assets ?? {}).length || result.experimental?.longContext || result.experimental?.images ? { assets: result.assets ?? {}, experimental: result.experimental ?? {}, ...(embedAssets && assets ? { asset_data: jsonCopy(assets, { maxBytes: maxPortableBytes }) } : {}) } : {}),
    name,
    policy: policy.policy.name ?? null,
    provider: target.provider.id,
    requested_model: target.model ?? null,
    model: result.model ?? null,
    requested_effort: target.requestedEffort ?? null,
    effective_effort: target.effectiveEffort ?? null,
    request_id: result.requestId ?? null,
    state,
    questions,
    questions_sha256: policy.identity(),
    answers: result.output,
    usage: result.usage ?? {},
    ...(expect ? { expect } : decision ? { expect: { action: decision.action, ...(decision.target ? { target: decision.target } : {}) } } : {}),
    synthetic,
    recorded_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
  };
}
