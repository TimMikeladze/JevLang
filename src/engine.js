import { requireAt, own, object, finite, probability, jsonCopy, fingerprint, equal } from './common.js';
import { evaluateExpression, levelIndex, truth, optionWire, optionCode } from './expressions.js';
import { validatePolicy, parameterOK, itemIdentity } from './validate.js';
import { redact, capValue, checkTokenBudget } from './state.js';

// A raw question is sent exactly as written; everything else sends its declared shape.
const wireQuestion = q => q.type === 'raw' ? q.wire : Object.fromEntries(['type', 'instructions', 'criteria'].filter(k => own(q, k)).map(k => [k, q[k]]));
export function buildState(policy, input) {
  const raw = jsonCopy(input);
  const settings = policy.stateOptions ?? {};
  const finish = state => checkTokenBudget(settings.maxChars ? capValue(state, settings.maxChars, 'state', false) : state, {}, own(settings, 'tokenLimit') ? settings.tokenLimit : 32768);
  if (!Object.keys(policy.state).length) return { state: finish(redact(raw, settings.redact ?? [])), facts: object(raw) ? raw : {} };
  const facts = {}, state = {};
  for (const [name, spec] of Object.entries(policy.state)) {
    let v = raw, missing = false;
    for (const key of spec.path ?? [name]) {
      if (!own(v, key)) { missing = true; break; }
      v = v[key];
    }
    if (missing) { requireAt(own(spec, 'default'), `input.${name}`, 'missing state field', 'Supply the field or declare a default.', 'state'); v = spec.default; }
    // defineProperty preserves literal JSON keys, including __proto__.
    Object.defineProperty(facts, name, { value: v, enumerable: true });
    if (spec.local) continue;
    if (!spec.unredacted) v = redact(v, [...(settings.redact ?? []), ...(spec.redact ?? [])], name);
    if (spec.maxChars) v = capValue(v, spec.maxChars, `state.${name}`);
    Object.defineProperty(state, name, { value: v, enumerable: true });
  }
  return { state: finish(state), facts };
}

export function buildQuestions(policy, state = {}) {
  const entries = [];
  for (const [name, q] of Object.entries(policy.questions)) {
    const wire = wireQuestion(q);
    if (q.type === 'raw') { entries.push([name, wire]); continue; }
    if (q.optionsFrom) {
      const inventory = state[q.optionsFrom];
      requireAt(Array.isArray(inventory) || object(inventory), `state.${q.optionsFrom}`, 'runtime options must be a list or map');
      const dynamic = Array.isArray(inventory) ? inventory.map(item => {
        if (typeof item === 'string' || finite(item)) return [String(item), null];
        requireAt(object(item) && (own(item, 'key') || own(item, 'name')), `state.${q.optionsFrom}`, 'option must be a string, number, or {key, description}');
        requireAt(typeof (item.key ?? item.name) === 'string', `state.${q.optionsFrom}`, 'option key must be a string');
        return [item.key ?? item.name, item.description ?? null];
      }) : Object.entries(inventory);
      const all = [...dynamic, ...Object.entries(q.criteria)];
      requireAt(all.length >= 2 && all.length <= 255 && new Set(all.map(([k]) => k)).size === all.length, `questions.${name}`, 'runtime choice needs 2 to 255 distinct options');
      wire.criteria = Object.fromEntries(all);
    }
    if (q.over) {
      const items = state[q.over];
      requireAt(Array.isArray(items), `state.${q.over}`, 'family inventory must be an array');
      for (const [i, item] of items.entries()) {
        const instructions = object(q.instructions) ? { ...q.instructions, [q.itemKey ?? 'item']: item }
          : { question: q.instructions, [q.itemKey ?? 'item']: item };
        entries.push([`${name}--${i}`, { ...wire, type: q.type.replace('-each', ''), instructions }]);
      }
    } else entries.push([name, wire]);
  }
  requireAt(new Set(entries.map(([id]) => id)).size === entries.length, '$.questions', 'generated family question collides with another question');
  return Object.fromEntries(entries);
}

export function validateAnswers(questions, answers) {
  requireAt(object(answers), 'answers', 'answers must be a JSON object', undefined, 'answers');
  for (const [id, q] of Object.entries(questions)) {
    const a = own(answers, id) ? answers[id] : null, path = `answers.${id}`;
    requireAt(object(a), path, 'missing question answer', 'Supply an answer for every question, or re-record stale fixtures.', 'answers');
    requireAt(!own(a, 'type') || a.type === q.type, path, `expected ${q.type}, got ${a.type}`, undefined, 'answers');
    if (q.type === 'choice') requireAt(typeof a.choice === 'string' && own(q.criteria, a.choice), `${path}.choice`, 'answer is not a declared option', 'Re-record answers for the current questions.', 'answers');
    if (q.type === 'score') {
      requireAt(finite(a.score), `${path}.score`, 'score must be numeric', undefined, 'answers');
      if (object(a.probabilities)) requireAt(Object.keys(a.probabilities).length === q.criteria.length, `${path}.probabilities`, 'number of level probabilities differs from declared levels', undefined, 'answers');
    }
    if (q.type === 'noul') requireAt(probability(a.noul), `${path}.noul`, 'noul must be between 0 and 1', undefined, 'answers');
  }
}

const emptyDecision = (action, target = null, reason = null, data = null) => ({
  action, target, reason, rule: null, clause: null, source: null, line: null, file: null,
  model: null, provider: null, requested_model: null, requested_effort: null,
  effective_effort: null, request_id: null, stage: null, data, proposed: null,
  evidence: [], steps: [], readings: [],
});
const planDecision = steps => ({ ...emptyDecision('plan', null, `${steps.length} step${steps.length === 1 ? '' : 's'}`), steps });
class GateExit { constructor(decision) { this.decision = decision; } }
function roundedEven(x) { const lo = Math.floor(x), frac = x - lo; return frac === 0.5 ? (lo % 2 === 0 ? lo : lo + 1) : Math.round(x); }

export class CompiledPolicy {
  #policy; #overrideKeys;
  constructor(input) {
    const { policy, warnings, overrideKeys } = validatePolicy(input);
    this.#policy = policy; this.warnings = warnings; this.#overrideKeys = overrideKeys;
    Object.freeze(this);
  }
  get policy() { return this.#policy; }
  toJSON() { return jsonCopy(this.#policy); }
  buildState(input) { return buildState(this.#policy, input); }
  questions(state = {}) { return buildQuestions(this.#policy, state); }
  fingerprint(state = {}) { return fingerprint(this.questions(state)); }
  // The questions that do not depend on runtime state. This is the policy's
  // recorded identity: what a fixture's questions_sha256 is compared against,
  // as in the Racket implementation, so a home with different rooms does not
  // make every recorded answer stale.
  staticQuestions() {
    return Object.fromEntries(Object.entries(this.#policy.questions)
      .filter(([, q]) => !q.optionsFrom && !q.over)
      .map(([id, q]) => [id, wireQuestion(q)]));
  }
  // A policy with runtime questions folds in a portable description of each
  // template. This identity is this engine's own: a fixture recorded by the
  // Racket implementation carries a hash of a Racket-printed template list,
  // which nothing here can recompute, so replay compares the recorded
  // questions themselves whenever a fixture carries them.
  identity() {
    const templates = Object.entries(this.#policy.questions)
      .filter(([, q]) => q.optionsFrom || q.over)
      .map(([id, q]) => ({ question: id, optionsFrom: q.optionsFrom ?? null, over: q.over ?? null, itemKey: q.itemKey ?? null, wire: wireQuestion(q) }));
    const questions = this.staticQuestions();
    return fingerprint(templates.length ? { ...questions, '%templates': templates } : questions);
  }

  #context(answers, facts, options = {}) {
    const p = this.#policy;
    requireAt(!options.profile || own(p.profiles, options.profile), 'profile', `unknown profile '${options.profile}'`);
    const overrides = { ...(options.profile ? p.profiles[options.profile] : {}), ...(options.overrides ?? {}) };
    for (const [k, v] of Object.entries(overrides)) requireAt(this.#overrideKeys.includes(k) && probability(v), `overrides.${k}`, 'override must name a threshold/gate and be between 0 and 1');
    const ctx = {
      policy: p, facts, answers, variables: {}, readings: new Map(), checked: new Set(), gatesEnabled: true,
      // Reads inside reason, data and evidence still trip on-read gates, but they
      // are informational: they are not part of the clause's readings.
      logging: true, lastReading: null,
      threshold: name => overrides[name] ?? p.thresholds[name],
      gateValue: (key, fallback) => overrides[key] ?? fallback,
      logFact(name, value) { if (!ctx.logging) return; ctx.readings.set(`fact:${name}`, { question: name, kind: 'fact', value: redact(value, [...(p.stateOptions.redact ?? []), ...(p.state[name]?.redact ?? [])], name), confidence: null, detail: 'observed' }); },
    };
    for (const g of p.gates) {
      if (own(g, 'low')) requireAt(ctx.gateValue(`${g.question}/lo`, g.low) < ctx.gateValue(`${g.question}/hi`, g.high), 'overrides', 'band low must remain below high');
      if (own(g, 'option')) {
        const b = p.gates.find(x => x.question === g.question && !own(x, 'option') && !own(x, 'low'));
        requireAt(!b || (b.by ?? 'confidence') !== (g.by ?? 'confidence') || ctx.gateValue(`${g.question}/${g.option}`, g.threshold) >= ctx.gateValue(g.question, b.threshold), 'overrides', 'option gate must remain at least as strict as base gate');
      }
    }
    const answer = id => {
      const a = own(answers, id) ? answers[id] : null;
      requireAt(object(a), `answers.${id}`, 'missing question answer', undefined, 'answers'); return a;
    };
    const probabilities = (a, id) => {
      requireAt(object(a.probabilities) && Object.values(a.probabilities).every(probability) && Object.keys(a.probabilities).length > 0, `answers.${id}.probabilities`, 'accessor requires a probability distribution', undefined, 'answers');
      return Object.entries(a.probabilities).sort(([ka, va], [kb, vb]) => vb - va || (ka < kb ? -1 : ka > kb ? 1 : 0));
    };
    const confidence = (a, id) => {
      requireAt(probability(a.confidence), `answers.${id}.confidence`, 'accessor requires confidence between 0 and 1', undefined, 'answers'); return a.confidence;
    };
    const logAnswer = (id, q, a) => {
      // A raw answer is only described by what it carries: its own type, else "raw".
      const kind = q.type === 'raw' ? (['choice', 'score', 'noul'].includes(a.type) ? a.type : 'raw') : q.type;
      if (kind === 'raw') return record(id, { question: id, kind, value: 'raw', confidence: null, detail: 'raw answer' });
      let detail = null;
      if (kind === 'score' && object(a.probabilities)) {
        const idx = scoreArgmax(a, id);
        detail = `most likely: ${levelDescription(a, idx)} (p=${a.probabilities[idx].toFixed(2)})`;
      }
      return record(id, { question: id, kind, value: a.choice ?? a.score ?? a.noul, confidence: kind === 'noul' ? null : confidence(a, id), detail });
    };
    const record = (id, reading) => {
      ctx.lastReading = reading;
      if (ctx.logging) ctx.readings.set(id, reading);
      return reading;
    };
    const scoreArgmax = (a, id) => {
      const ps = probabilities(a, id).sort(([ka, va], [kb, vb]) => vb - va || Number(ka) - Number(kb));
      requireAt(ps.every(([k]) => /^(0|[1-9][0-9]*)$/.test(k)), `answers.${id}.probabilities`, 'score distribution needs integer level keys');
      return Number(ps[0][0]);
    };
    ctx.read = (op, id, arg, run = x => evaluateExpression(x, ctx)) => {
      const q = p.questions[id];
      if (ctx.gatesEnabled && !ctx.checked.has(id)) {
        ctx.checked.add(id);
        for (const [i, g] of p.gates.entries()) if (g.onRead && g.question === id) {
          const d = gate(g, i); if (d) throw new GateExit(d);
        }
      }
      if (q.over) {
        const items = facts[q.over];
        // An aggregator reads the answers the family came back with, as Racket's
        // family-values does; only yesItems needs the inventory itself, because
        // it returns the items.
        requireAt(op !== 'yesItems' || Array.isArray(items), `facts.${q.over}`, 'yesItems needs the inventory in facts');
        const members = Array.isArray(items)
          ? items.map((_, i) => i)
          : (() => { const out = []; while (own(answers, `${id}--${out.length}`)) out.push(out.length); return out; })();
        const values = members.map(i => { const a = answer(`${id}--${i}`); return a.noul ?? a.score; });
        // A family reads as its member count, with the strongest member named.
        const top = values.length ? Math.max(...values) : null;
        record(id, {
          question: id, kind: 'family', value: values.length, confidence: null,
          detail: values.length ? `${values.length} members, max ${top.toFixed(2)} at #${values.indexOf(top)}` : 'no members',
        });
        if (op === 'yesItems') {
          const threshold = run(arg); requireAt(probability(threshold), 'threshold', 'threshold must be between 0 and 1');
          return members.map(i => items[i]).filter((item, i) => {
            if (values[i] < threshold) return false;
            const name = `${id}[${itemIdentity(item)}]`;
            record(name, { question: name, kind: 'noul', value: values[i], confidence: null, detail: null }); return true;
          });
        }
        if (['countYes', 'anyYes', 'allYes'].includes(op)) {
          const threshold = run(arg); requireAt(probability(threshold), 'threshold', 'threshold must be between 0 and 1');
          const count = values.filter(v => v >= threshold).length;
          return op === 'countYes' ? count : op === 'anyYes' ? count > 0 : values.length > 0 && count === values.length;
        }
        if (!values.length) return op === 'argmax' ? false : 0;
        if (op === 'argmax') return values.indexOf(Math.max(...values));
        return op === 'max' ? Math.max(...values) : op === 'min' ? Math.min(...values) : values.reduce((x, y) => x + y, 0) / values.length;
      }
      const a = answer(id); logAnswer(id, q, a);
      switch (op) {
        case 'value': return q.type === 'choice' ? optionCode(q, a.choice) : a.score ?? a.noul;
        case 'chosen': return a.choice;
        case 'rawAnswer': return jsonCopy(a);
        case 'confidence': return confidence(a, id);
        case 'is': return a.choice === optionWire(q, arg);
        case 'yes': case 'no': {
          const threshold = run(arg); requireAt(probability(threshold), 'threshold', 'threshold must be between 0 and 1');
          return (op === 'yes' ? a.noul : 1 - a.noul) >= threshold;
        }
        case 'mostLikely': return scoreArgmax(a, id) === levelIndex(q, arg);
        case 'atLeast': return a.score >= levelIndex(q, arg);
        case 'prob': { probabilities(a, id); return a.probabilities[q.type === 'score' ? levelIndex(q, arg) : optionWire(q, arg)] ?? 0; }
        case 'topProb': return probabilities(a, id)[0][1];
        case 'runnerUp': return probabilities(a, id)[1]?.[0] ?? false;
        case 'margin': { const ps = probabilities(a, id); return ps[0][1] - (ps[1]?.[1] ?? 0); }
        // The nearest level is named the way the policy names it: its code name
        // where it has one, otherwise the level text, as Racket's does.
        case 'nearest': {
          const i = Math.max(0, Math.min(q.criteria.length - 1, roundedEven(a.score)));
          return q.levelNames?.[i] ?? q.criteria[i];
        }
        case 'normalized': return a.score / (q.criteria.length - 1);
        case 'spread': {
          const ps = probabilities(a, id); const mean = ps.reduce((s, [i, v]) => s + Number(i) * v, 0);
          return Math.sqrt(ps.reduce((s, [i, v]) => s + v * (Number(i) - mean) ** 2, 0));
        }
        default: throw new Error(`unimplemented accessor ${op}`);
      }
    };
    ctx.reading = id => informational(ctx, () => { ctx.read('value', id); return ctx.lastReading; });
    const gate = (g, i) => {
      const a = answer(g.question), q = p.questions[g.question];
      if (own(g, 'option') && a.choice !== g.option) return null;
      const band = own(g, 'low');
      const value = band ? a.noul : g.by === 'topProb' ? probabilities(a, g.question)[0][1] : g.by === 'margin' ? (() => { const ps = probabilities(a, g.question); return ps[0][1] - (ps[1]?.[1] ?? 0); })() : confidence(a, g.question);
      const trips = band ? value >= ctx.gateValue(`${g.question}/lo`, g.low) && value <= ctx.gateValue(`${g.question}/hi`, g.high)
        : value < ctx.gateValue(`${g.question}${own(g, 'option') ? `/${g.option}` : ''}`, g.threshold);
      if (!trips) return null;
      const saved = ctx.readings, enabled = ctx.gatesEnabled;
      ctx.readings = new Map(); ctx.gatesEnabled = false;
      try {
        const detail = gateDetail(g, ctx, band);
        const reading = logAnswer(g.question, q, a);
        ctx.readings.set(g.question, { ...reading, detail: reading.detail ? `${reading.detail}; ${detail}` : detail });
        ctx.lastReading = reading;
        const d = materialize(g.decision, ctx);
        return trace(d, band ? 'band' : own(g, 'option') ? 'option-gate' : 'gate', i, `$.gates[${i}]`, ctx);
      } finally { ctx.readings = saved; ctx.gatesEnabled = enabled; }
    };
    ctx.gate = gate;
    return ctx;
  }

  precheck(input, options = {}) {
    const { facts } = this.buildState(input);
    const ctx = this.#context({}, facts, options); ctx.gatesEnabled = false;
    for (const [i, c] of this.#policy.prechecks.entries()) {
      ctx.readings = new Map();
      if (truth(evaluateExpression(c.when, ctx))) return trace(materialize(c.decision, ctx), 'precheck', i, c.source ?? `$.prechecks[${i}]`, ctx);
    }
    return null;
  }

  #route(ctx) {
    const p = this.#policy;
    const matched = [];
    for (const [i, clause] of p.route.clauses.entries()) {
      ctx.readings = new Map();
      if (!truth(evaluateExpression(clause.when, ctx))) continue;
      const d = guardConfidence(trace(materialize(clause.decision, ctx), 'route', i, clause.source ?? `$.route.clauses[${i}]`, ctx), p);
      matched.push(d); if (p.route.mode === 'first') break;
    }
    if (!matched.length && own(p.route, 'otherwise')) {
      ctx.readings = new Map();
      matched.push(guardConfidence(trace(materialize(p.route.otherwise, ctx), 'route', p.route.clauses.length, '$.route.otherwise', ctx), p));
    }
    let result;
    if (p.route.mode === 'all') {
      // Every matching clause runs. One match is its own decision; several become
      // one plan whose readings are every clause's, each question once.
      if (matched.length > 1) {
        result = planDecision(matched); result.rule = 'plan';
        result.source = `(route #:all): ${matched.length} clauses matched`;
        result.readings = [...new Map(matched.flatMap(d => d.readings).map(r => [r.question, r])).values()];
      } else result = matched[0];
    } else if (p.route.mode === 'collect') {
      const rank = d => { const i = p.route.precedence.indexOf(d.target ?? d.action); return i < 0 ? p.route.precedence.length : i; };
      result = matched.reduce((best, d) => !best || rank(d) < rank(best) ? d : best, null);
    } else result = matched[0];
    requireAt(result, '$.route', 'no clause matched validated answers', 'Add an otherwise clause.', 'decision');
    return result;
  }

  decide(rawAnswers, options = {}) {
    const answers = jsonCopy(rawAnswers), facts = jsonCopy(options.facts ?? {}), p = this.#policy;
    const questions = this.questions(options.state ?? facts);
    validateAnswers(questions, answers);
    const ctx = this.#context(answers, facts, options);
    // What the route would have decided without the gates, for a gate's trace.
    ctx.wouldRoute = () => {
      const readings = ctx.readings, enabled = ctx.gatesEnabled, checked = ctx.checked;
      ctx.gatesEnabled = false; ctx.checked = new Set();
      try { return this.#route(ctx); }
      catch { return null; }
      finally { ctx.readings = readings; ctx.gatesEnabled = enabled; ctx.checked = checked; }
    };
    try {
      for (const [i, g] of p.gates.entries()) if (!g.onRead) { const d = ctx.gate(g, i); if (d) return d; }
      const result = this.#route(ctx);
      const flags = [];
      for (const flag of p.flags) if (truth(evaluateExpression(flag.when, ctx))) flags.push(flag.flag);
      if (flags.length) result.data = object(result.data) ? { ...result.data, flags: [...(result.data.flags ?? []), ...flags] }
        : result.data === null ? { flags } : { value: result.data, flags };
      return result;
    } catch (e) { if (e instanceof GateExit) return e.decision; throw e; }
  }
}

// The level text the answer itself reported, else its index; long JSON is clipped.
function levelDescription(a, i) {
  const legend = object(a.legend) ? a.legend : {};
  if (!own(legend, String(i))) return String(i);
  const v = legend[String(i)];
  if (typeof v === 'string') return v;
  const s = JSON.stringify(v);
  return s.length > 60 ? `${s.slice(0, 57)}...` : s;
}
// A tripped gate says what the bar was, and what the route would have done.
function gateDetail(g, ctx, band) {
  const base = band
    ? `inside the review band ${g.low}..${g.high}`
    : `needed ${g.by === 'topProb' ? 'top probability' : g.by === 'margin' ? 'margin' : 'confidence'} >= ${ctx.gateValue(`${g.question}${own(g, 'option') ? `/${g.option}` : ''}`, g.threshold).toFixed(2)}`;
  const d = ctx.wouldRoute?.();
  return d ? `${base}; otherwise: ${d.action}${d.target ? ` ${d.target}` : ''}` : base;
}

function trace(d, rule, index, source, ctx) {
  return { ...d, rule, clause: index, source, readings: [...ctx.readings.values()] };
}
// Informational reads see the answers and trip on-read gates, but log nothing.
function informational(ctx, thunk) {
  const logging = ctx.logging;
  ctx.logging = false;
  try { return thunk(); } finally { ctx.logging = logging; }
}
function materialize(spec, ctx) {
  const run = x => evaluateExpression(x, ctx);
  const reason = own(spec, 'reason') ? informational(ctx, () => run(spec.reason)) : null;
  requireAt(reason === null || typeof reason === 'string', 'decision.reason', 'reason must be a string or null');
  const data = own(spec, 'data') ? informational(ctx, () => run(spec.data)) : null;
  let d = emptyDecision(spec.action, spec.target ?? null, reason, data);
  switch (spec.action) {
    case 'act': {
      d.data = Object.fromEntries(Object.entries(spec.params).map(([k, v]) => [k, run(v)]));
      const a = ctx.policy.actions[spec.target];
      for (const [k, v] of Object.entries(d.data)) requireAt(parameterOK(a.params[k], v, ctx.facts), `action.${spec.target}.${k}`, `parameter must satisfy ${a.params[k].type}`, 'Supply a value within the declared type/range/inventory.', 'action');
      break;
    }
    case 'confirm':
      d.proposed = materialize(spec.proposed, ctx); d.target = d.proposed.target; d.data = d.proposed.data;
      d.reason ??= d.proposed.reason; d.evidence = d.proposed.evidence; break;
    case 'schedule': {
      const seconds = run(spec.seconds); requireAt(finite(seconds) && seconds > 0, 'schedule.seconds', 'delay must be positive seconds');
      d.proposed = materialize(spec.proposed, ctx); d.data = { seconds }; d.reason ??= `in ${seconds} s`; break;
    }
    case 'clarify': {
      const question = run(spec.question); requireAt(typeof question === 'string', 'clarify.question', 'question must be text');
      d.reason ??= question; d.data = { question, about: spec.about ?? null }; break;
    }
    case 'plan': d = planDecision(spec.steps.map(x => materialize(x, ctx))); break;
    case 'planFor': {
      const items = run(spec.items); requireAt(Array.isArray(items) && items.length <= 10000, 'planFor.items', 'planFor needs an array of at most 10,000 items');
      const saved = ctx.variables;
      let steps;
      try { steps = items.map(item => { ctx.variables = { ...saved, [spec.variable]: item }; return materialize(spec.decision, ctx); }); }
      finally { ctx.variables = saved; }
      // No items is nothing to do; one item is that decision, not a plan of one.
      d = steps.length === 0 ? emptyDecision('hold', null, 'nothing to do: no items')
        : steps.length === 1 ? steps[0] : planDecision(steps);
      break;
    }
    case 'branch': d = materialize(truth(run(spec.when)) ? spec.then : spec.otherwise, ctx); break;
  }
  if (spec.show) d.evidence = spec.show.map(id => ctx.reading(id));
  return d;
}
function guardConfidence(d, p) {
  const requirements = [];
  function visit(x) {
    if (x.action === 'act' && own(p.actions[x.target], 'minConfidence')) requirements.push(p.actions[x.target].minConfidence);
    if (x.proposed) visit(x.proposed); x.steps.forEach(visit);
  }
  visit(d);
  if (!requirements.length) return d;
  const minimum = Math.max(...requirements);
  const certainty = r => r.confidence ?? (r.kind === 'noul' ? Math.max(r.value, 1 - r.value) : null);
  const weak = d.readings.find(r => certainty(r) !== null && certainty(r) < minimum);
  if (!weak) return d;
  const blocked = d.target ?? d.proposed?.target ?? d.action;
  return { ...d, action: 'hold', target: null, data: { blocked }, proposed: null, steps: [], evidence: [],
    reason: `not sure enough to ${blocked}: '${weak.question}' is only ${certainty(weak).toFixed(2)} sure, and it needs ${minimum}` };
}

export const compile = input => new CompiledPolicy(input);
