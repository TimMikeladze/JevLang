// From a policy and an input to a decision: build the state, build the
// questions, ask the selected provider for the answers, validate them, and
// decide. The provider is chosen by the same layered routing every other call
// uses, and the decision carries which provider, model and effort answered.
import { object, requireAt } from './common.js';
import { validateAnswers } from './engine.js';
import { checkTokenBudget } from './state.js';
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
    caps: capabilities({ modes: ['structured'], modalities: ['text'], permissions: ['read'], controls: ['structured-output'], efforts: [], maxParallel }),
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
        response = await jevCall(state, questions, { model: target.model });
      } catch (error) {
        const kind = { auth: 'authentication', timeout: 'timeout', 'rate-limit': 'rate-limit', server: 'overload', response: 'invalid-output', connection: 'connection' }[error.kind] ?? 'provider-failure';
        throw new ProviderError(error.message, {
          kind, target,
          retryable: ['timeout', 'connection', 'rate-limit', 'overload'].includes(kind),
          usage: {}, cost: unreportedCost(), status: error.status ?? null, detail: error.message,
        });
      }
      return {
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
export function makePolicyRegistry(config = loadProviderConfig()) {
  return makeDefaultRegistry(config).overlay([typesafeProvider()], { prepend: true })
    .overlay([openaiProvider(), gatewayProvider(), anthropicProvider()]);
}
export const policyConfigDefaults = { provider: 'typesafe', preferences: ['typesafe', 'claude', 'codex'] };

const normalizeEffort = value => value == null ? null : (String(value).toLowerCase() === 'auto' ? 'auto' : value);
export const policyProviderRequest = (state, questions, { provider: id = null, model = null, effort = null, role = 'policy' } = {}) =>
  providerRequest('policy', 'structured', {
    role, kind: 'policy', tier: 'policy', modalities: ['text'], permissions: ['read'],
    prompt: policyPrompt(state, questions),
    schema: questionsAnswerSchema(questions),
    target: targetSpec({ provider: id, model, effort: normalizeEffort(effort) }),
    metadata: { state, questions },
  });

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
    if (!object(answer) || question?.type !== 'score') continue;
    const levels = Array.isArray(question.criteria) ? question.criteria : [];
    const names = levels.map(level => object(level) ? (level.name ?? null) : level);
    const indexOf = name => names.findIndex(n => n !== null && String(n) === String(name));
    if (typeof answer.score === 'string') {
      const index = /^(0|[1-9][0-9]*)$/.test(answer.score) ? Number(answer.score) : indexOf(answer.score);
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

export async function runPolicyProvider(state, questions, { provider: id = null, model = null, effort = null, config = null, registry = null, role = 'policy' } = {}) {
  const request = policyProviderRequest(state, questions, { provider: id, model, effort, role });
  const resolvedConfig = config ?? loadProviderConfig({ defaults: policyConfigDefaults, role });
  const resolvedRegistry = registry ?? makePolicyRegistry(resolvedConfig);
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

// policy : a CompiledPolicy
export async function evaluateWithProvider(policy, input, { provider: id = null, model = null, effort = null, profile = null, config = null, registry = null, role = 'policy' } = {}) {
  const spec = policy.policy;
  const selection = { provider: id ?? spec.provider ?? null, model: model ?? spec.model ?? null, effort: effort ?? spec.effort ?? null };
  const { state, facts } = policy.buildState(input);
  const pre = policy.precheck(input, { profile });
  if (pre) return pre;
  const questions = policy.questions(state);
  checkTokenBudget(state, questions);
  const resolvedConfig = config ?? loadProviderConfig({ defaults: policyConfigDefaults, role });
  const resolvedRegistry = registry ?? makePolicyRegistry(resolvedConfig);
  const result = await runPolicyProvider(state, questions, { ...selection, config: resolvedConfig, registry: resolvedRegistry, role });
  const answers = result.output;
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
  };
}

// A package-owned policy: the same routing, but an unresolvable implicit
// TypeSafe credential means there is no configured decision, so a caller can
// keep its documented facts-only behaviour.
export async function evaluateConfiguredPolicy(policy, input, { start = process.cwd(), package: pkg = {}, provider: id = null, model = null, effort = null, registry = null } = {}) {
  const config = loadProviderConfig({ start, defaults: policyConfigDefaults, package: pkg, role: 'policy' });
  const resolvedRegistry = registry ?? makePolicyRegistry(config);
  const request = policyProviderRequest('', policy.staticQuestions(), { provider: id, model, effort });
  try {
    await resolveProvider(request, config, resolvedRegistry);
  } catch (error) {
    if (error instanceof ProviderError && error.kind === 'unavailable' && !explicitPolicySelection(config, request, { provider: id, model, effort })) return null;
    throw error;
  }
  return evaluateWithProvider(policy, input, { provider: id, model, effort, config, registry: resolvedRegistry });
}

// A fixture (version 3) recorded from a real call: the provenance is required,
// so a replay can never claim an answer came from somewhere it did not.
export function fixtureFromRun({ name, policy, state, questions, decision = null, result, synthetic = false, expect = null }) {
  const target = result.target;
  return {
    fixture_version: 3,
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
