// Token and cost estimates.
//
// There is no public tokenizer. By default a token is ~4 characters of the
// serialized JSON request body, which is good for an order of magnitude and
// nothing more: on the recorded calls that default undercounted real charges by
// about 2.2x. A fit against recorded usage replaces it with a straight line,
// which is still an estimate, and only as good as the calls it came from.
import { own, object, requireAt, finite } from './common.mjs';
import { stateSize } from './state.mjs';

// The characters a request body serializes to, counted in code points as the
// Racket implementation counts them.
export const chars = v => stateSize(v);
export const requestBody = (state, model, questions) => ({ state, model, questions });
export const estimateTokens = n => Math.ceil(n / 4);
export const roughEstimator = { tokens: estimateTokens, label: '~4 chars/token (rough estimate)' };

// A straight-line fit of tokens against request size, or null when there are
// too few samples or the fit is degenerate.
export function fitTokenModel(samples, { minN = 5 } = {}) {
  const n = samples.length;
  if (n < minN) return null;
  const xs = samples.map(s => s[0]), ys = samples.map(s => s[1]);
  const mean = zs => zs.reduce((a, b) => a + b, 0) / zs.length;
  const mx = mean(xs), my = mean(ys);
  const sxx = xs.reduce((s, x) => s + (x - mx) ** 2, 0);
  let intercept, slope;
  if (sxx > 1e-9) {
    slope = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0) / sxx;
    intercept = my - slope * mx;
  } else {
    // Every request the same size: fit a rate through the origin.
    intercept = 0;
    slope = xs.reduce((s, x, i) => s + x * ys[i], 0) / Math.max(1e-9, xs.reduce((s, x) => s + x * x, 0));
  }
  const spread = Math.sqrt(xs.reduce((s, x, i) => s + ((intercept + slope * x - ys[i]) / Math.max(ys[i], 1)) ** 2, 0) / n);
  return slope > 0 ? { n, intercept, slope, spread, lo: Math.round(Math.min(...xs)), hi: Math.round(Math.max(...xs)) } : null;
}
export const fitTokens = (fit, n) => Math.max(1, Math.ceil(fit.intercept + fit.slope * n));
export const fittedEstimator = fit => ({
  tokens: n => fitTokens(fit, n),
  label: `calibrated on ${fit.n} recorded call${fit.n === 1 ? '' : 's'}, +/- ${Math.round(100 * fit.spread)}% (least-squares fit of input_tokens against request size, fitted on ${fit.lo} to ${fit.hi} chars; still an estimate)`,
});

// Tokens for a part of a body, at the body's own rate, so the parts add up.
const partTokens = (estimator, bodyChars, n) => bodyChars === 0 ? 0 : Math.ceil(n * (estimator.tokens(bodyChars) / bodyChars));

// What a fixture's request body measured, paired with the tokens it really
// cost. Synthetic fixtures are ignored, and so is a fixture whose questions are
// neither recorded nor this policy's.
export function samplesFromFixtures(policy, fixtures, model) {
  const identity = policy.identity();
  const questions = policy.staticQuestions();
  return fixtures.filter(f => f.synthetic !== true
    && object(f.usage) && finite(f.usage.input_tokens) && f.usage.input_tokens > 0
    && (object(f.questions) || f.questions_sha256 == null || f.questions_sha256.toLowerCase() === identity))
    .map(f => [chars(requestBody(object(f.state) || typeof f.state === 'string' ? f.state : '', f.model ?? model, f.questions ?? questions)), f.usage.input_tokens]);
}

// The documented input price. Output is free; nothing here invents a price.
export const inputPricePerMtok = 0.042;
export const usageCost = (usage, price = inputPricePerMtok) => (finite(usage?.input_tokens) ? usage.input_tokens : 0) * (price / 1e6);

// TODO(api): models.md gives 32k tokens for the state plus the longest question
// and 64k for the whole request; primitives.md says "around 32,000" shared.
export const stateAndQuestionBudget = 32000;
export const requestBudget = 64000;
const longestQuestion = questions => Object.values(questions).reduce((m, q) => Math.max(m, chars(q)), 0);
export function budgetWarnings(estimator, stateChars, questions, bodyChars) {
  const both = partTokens(estimator, bodyChars, stateChars + longestQuestion(questions));
  const total = estimator.tokens(bodyChars);
  return [
    ...(both > stateAndQuestionBudget ? [`the state plus the longest question is about ${both} tokens, over the ${stateAndQuestionBudget} models.md allows them (primitives.md says "around 32,000"). This is an estimate (${estimator.label}); shrink the state or add a maxChars cap.`] : []),
    ...(total > requestBudget ? [`the whole request is about ${total} tokens, over the ${requestBudget} per request in models.md. This is an estimate (${estimator.label}).`] : []),
  ];
}

// policy   : a compiled policy
// input    : optional raw input, so the state and runtime questions are real
// fixtures : optional recorded fixtures to calibrate against
// volume   : how many calls to price
export function cost(policy, { input = null, fixtures = null, volume = 1, model = null, price = inputPricePerMtok } = {}) {
  requireAt(Number.isInteger(volume) && volume > 0, 'volume', 'volume must be a positive integer');
  const built = input === null ? null : policy.buildState(input);
  const state = built ? built.state : '';
  const questions = built ? policy.questions(state) : policy.staticQuestions();
  const chosenModel = model ?? policy.policy.model ?? null;
  let estimator = roughEstimator, note = null;
  if (fixtures) {
    const samples = samplesFromFixtures(policy, fixtures, chosenModel);
    const fit = fitTokenModel(samples);
    if (fit) estimator = fittedEstimator(fit);
    else {
      const synthetic = fixtures.filter(f => f.synthetic === true).length;
      note = `${samples.length} usable recorded call${samples.length === 1 ? '' : 's'} (at least 5 needed; ${synthetic} synthetic fixture${synthetic === 1 ? '' : 's'} ignored), so this uses the rough estimate`;
    }
  }
  const bodyChars = chars(requestBody(state, chosenModel, questions));
  const questionTokens = partTokens(estimator, bodyChars, chars(questions));
  const stateTokens = built ? partTokens(estimator, bodyChars, chars(state)) : 0;
  const perCall = estimator.tokens(bodyChars);
  return {
    mode: estimator.label,
    note,
    model: chosenModel,
    chars: bodyChars,
    questions_tokens: questionTokens,
    state_tokens: stateTokens,
    envelope_tokens: Math.max(0, perCall - questionTokens - stateTokens),
    per_call: { tokens: perCall, usd: usageCost({ input_tokens: perCall }, price) },
    volume: { calls: volume, tokens: perCall * volume, usd: usageCost({ input_tokens: perCall * volume }, price) },
    input_price_per_mtok: price,
    warnings: budgetWarnings(estimator, chars(state), questions, bodyChars),
  };
}
