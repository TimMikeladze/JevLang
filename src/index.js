export { JevError, canonical, fingerprint } from './common.js';
export { CompiledPolicy, compile, buildState, buildQuestions, validateAnswers } from './engine.js';
export { validatePolicy } from './validate.js';
export * from './expressions.js';
export { redact, redactString, redactQuestions, restoreAnswerKeys, capValue, checkTokenBudget, stateSize, redactorNames } from './state.js';
export { replay, diff, tune, validateFixture, matches } from './fixtures.js';
export { questionsAnswerSchema, policyPrompt, typesafeProvider, makePolicyRegistry, sharedPolicyRegistry, answerCacheKey, answerRecord, policyProviderRequest, runPolicyProvider, normalizeAnswers, evaluateWithProvider, evaluateConfiguredPolicy, explicitPolicySelection, fixtureFromRun, policyConfigDefaults } from './evaluate.js';
export { evaluateMany, makePacer } from './batch.js';
export { runPipeline, pipelineToJson, topOptions, defaultNextInput } from './pipeline.js';
export { jevCall, settings as clientSettings, defaultRetryPolicy, defaultModel, apiKeyConfigured, JevApiError } from './client.js';
export { cost, chars, requestBody, estimateTokens, fitTokenModel, fitTokens, samplesFromFixtures, usageCost, inputPricePerMtok, budgetWarnings } from './cost.js';
export {
  summarize, calibrate, bucketIndex, bucketLabel, escalated, confidenceEdges, decileEdges, calibrationMinLabels,
  compareWindows, gatesOf, questionStabilities, stabilityReport,
  formatSummary, formatComparison, formatCalibration, formatStability, decimalString, edgeString,
} from './monitor.js';
export { parameterSchema, actionInputSchema, actionAnnotations, actionMeta, actionTool, policyActions } from './json-schema.js';
import { asExpression, expression, literal } from './expressions.js';
import { CompiledPolicy } from './engine.js';

export class Question {
  constructor(id, schema) { this.id = id; this.schema = schema; }
  value() { return expression('value', this.id); }
  confidence() { return expression('confidence', this.id); }
  is(option) { return expression('is', this.id, option); }
  chosen() { return expression('chosen', this.id); }
  raw() { return expression('rawAnswer', this.id); }
  yes(threshold = 0.5) { return expression('yes', this.id, asExpression(threshold)); }
  no(threshold = 0.5) { return expression('no', this.id, asExpression(threshold)); }
  mostLikely(level) { return expression('mostLikely', this.id, level); }
  atLeast(level) { return expression('atLeast', this.id, level); }
  prob(option) { return expression('prob', this.id, option); }
  topProb() { return expression('topProb', this.id); }
  runnerUp() { return expression('runnerUp', this.id); }
  margin() { return expression('margin', this.id); }
  nearest() { return expression('nearest', this.id); }
  normalized() { return expression('normalized', this.id); }
  spread() { return expression('spread', this.id); }
  max() { return expression('max', this.id); }
  min() { return expression('min', this.id); }
  mean() { return expression('mean', this.id); }
  countYes(threshold = 0.5) { return expression('countYes', this.id, asExpression(threshold)); }
  anyYes(threshold = 0.5) { return expression('anyYes', this.id, asExpression(threshold)); }
  allYes(threshold = 0.5) { return expression('allYes', this.id, asExpression(threshold)); }
  argmax() { return expression('argmax', this.id); }
  yesItems(threshold = 0.5) { return expression('yesItems', this.id, asExpression(threshold)); }
}
// An option is a wire key, or {key, name, description}: the name is how the
// policy refers to it, the key is what the model answers with.
function options(list) {
  const entries = Array.isArray(list)
    ? list.map(o => typeof o === 'string' ? { key: o } : o)
    : Object.entries(list).map(([key, description]) => ({ key, description }));
  for (const e of entries) if (typeof e?.key !== 'string') throw new Error('An option is a wire key, or {key, name, description}.');
  const keys = entries.map(e => e.key);
  if (new Set(keys).size !== keys.length) throw new Error('Duplicate choice option; use distinct keys.');
  const named = entries.filter(e => e.name && e.name !== e.key);
  if (new Set(named.map(e => e.name)).size !== named.length) throw new Error('Duplicate option code name; use distinct names.');
  return {
    criteria: Object.fromEntries(entries.map(e => [e.key, e.description ?? null])),
    ...(named.length ? { names: Object.fromEntries(named.map(e => [e.name, e.key])) } : {}),
  };
}
export function choice(id, instructions, opts, settings = {}) {
  return new Question(id, { type: 'choice', instructions, ...options(opts), ...settings });
}
// A level is its content, or {name, level}: the name is how the policy refers to it.
function levels(list) {
  if (!Array.isArray(list)) throw new Error('Score levels are an ordered array, lowest first.');
  const named = list.map(l => l !== null && typeof l === 'object' && !Array.isArray(l) && Object.hasOwn(l, 'level') ? l : { level: l });
  const names = named.map(l => l.name ?? null);
  return { criteria: named.map(l => l.level), ...(names.some(n => n !== null) ? { levelNames: names } : {}) };
}
export const score = (id, instructions, lv, settings = {}) => new Question(id, { type: 'score', instructions, ...levels(lv), ...settings });
// A raw question is sent exactly as written; only rawAnswer can read its answer.
export const rawQuestion = (id, wire) => new Question(id, { type: 'raw', wire });
export const noul = (id, instructions, settings = {}) => new Question(id, { type: 'noul', instructions, ...settings });
export const noulEach = (id, instructions, over, settings = {}) => new Question(id, { type: 'noul-each', instructions, over, ...settings });
export const scoreEach = (id, instructions, lv, over, settings = {}) => new Question(id, { type: 'score-each', instructions, ...levels(lv), over, ...settings });

function metadata(settings) {
  const out = {};
  for (const [k, v] of Object.entries(settings)) out[k] = ['reason', 'data'].includes(k) ? asExpression(v) : k === 'show' ? v.map(q => typeof q === 'string' ? q : q.id) : v;
  return out;
}
const targetDecision = action => (target, settings = {}) => ({ action, target, ...metadata(settings) });
export const assign = targetDecision('assign');
export const page = targetDecision('page');
export const escalate = targetDecision('escalate');
export const next = targetDecision('next');
export const hold = (settings = {}) => ({ action: 'hold', ...metadata(settings) });
export const act = (target, params = {}, settings = {}) => ({ action: 'act', target, params: Object.fromEntries(Object.entries(params).map(([k, v]) => [k, asExpression(v)])), ...metadata(settings) });
export const confirm = (proposed, settings = {}) => ({ action: 'confirm', proposed, ...metadata(settings) });
export const plan = (...steps) => ({ action: 'plan', steps });
export const schedule = (seconds, proposed, settings = {}) => ({ action: 'schedule', seconds: asExpression(seconds), proposed, ...metadata(settings) });
export const clarify = (question, about, settings = {}) => ({ action: 'clarify', question: asExpression(question), ...(about ? { about: typeof about === 'string' ? about : about.id } : {}), ...metadata(settings) });
export const planFor = (variable, items, decision) => ({ action: 'planFor', variable, items: asExpression(items), decision });
export const branch = (when, then, otherwise) => ({ action: 'branch', when: asExpression(when), then, otherwise });
export const rule = (when, decision, source) => ({ when: asExpression(when), decision, ...(source ? { source } : {}) });
export const gate = (question, threshold, decision, settings = {}) => ({ question: typeof question === 'string' ? question : question.id, threshold, decision, ...settings });
export const band = (question, low, high, decision, settings = {}) => ({ question: typeof question === 'string' ? question : question.id, low, high, decision, ...settings });

export function definePolicy({ questions, ...options }) {
  let mapped;
  if (Array.isArray(questions)) {
    if (new Set(questions.map(q => q.id)).size !== questions.length) throw new Error('Duplicate question id; use unique names.');
    mapped = Object.fromEntries(questions.map(q => [q.id, q.schema]));
  } else mapped = Object.fromEntries(Object.entries(questions ?? {}).map(([id, q]) => {
    if (q instanceof Question && q.id !== id) throw new Error(`Question map key '${id}' differs from its declared id '${q.id}'.`);
    return [id, q instanceof Question ? q.schema : q];
  }));
  return new CompiledPolicy({ format: 1, ...options, questions: mapped });
}
