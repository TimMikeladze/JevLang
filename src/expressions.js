import { own, object, requireAt, finite, probability, equal, fail, didYouMean } from './common.js';

export const expression = (op, ...args) => ({ op, args });
export const literal = value => expression('literal', value);
export const isExpression = v => object(v) && own(v, 'op');
export const asExpression = v => isExpression(v) ? v : literal(v);
export const fact = name => expression('fact', name);
export const threshold = name => expression('threshold', name);
export const signal = name => expression('signal', name);
export const variable = name => expression('variable', name);
export const all = (...xs) => expression('and', ...xs.map(asExpression));
export const any = (...xs) => expression('or', ...xs.map(asExpression));
export const not = x => expression('not', asExpression(x));
export const eq = (a, b) => expression('eq', asExpression(a), asExpression(b));
export const compare = (op, a, b) => expression(op, asExpression(a), asExpression(b));
export const compute = (op, ...xs) => expression(op, ...xs.map(asExpression));
export const choose = (condition, yes, no) => expression('if', asExpression(condition), asExpression(yes), asExpression(no));
export const record = fields => expression('object', Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, asExpression(v)])));
export const list = (...values) => expression('array', ...values.map(asExpression));

const accessors = {
  value: ['choice', 'score', 'noul'], confidence: ['choice', 'score'],
  chosen: ['choice'], rawAnswer: ['raw'],
  is: ['choice'], yes: ['noul'], no: ['noul'], mostLikely: ['score'], atLeast: ['score'],
  prob: ['choice', 'score'], topProb: ['choice', 'score'], runnerUp: ['choice'],
  margin: ['choice', 'score'], nearest: ['score'], normalized: ['score'], spread: ['score'],
  max: ['noul-each', 'score-each'], min: ['noul-each', 'score-each'], mean: ['noul-each', 'score-each'],
  countYes: ['noul-each', 'score-each'], anyYes: ['noul-each', 'score-each'], allYes: ['noul-each', 'score-each'],
  argmax: ['noul-each', 'score-each'], yesItems: ['noul-each'],
};
const arities = {
  literal: [1, 1], fact: [1, 1], threshold: [1, 1], signal: [1, 1], variable: [1, 1],
  and: [0, Infinity], or: [0, Infinity], not: [1, 1], eq: [2, 2], ne: [2, 2],
  gt: [2, 2], gte: [2, 2], lt: [2, 2], lte: [2, 2], add: [2, Infinity], sub: [2, 2],
  mul: [2, Infinity], div: [2, 2], if: [3, 3], contains: [2, 2], length: [1, 1],
  get: [2, 3], object: [1, 1], array: [0, Infinity],
};

export function checkExpression(x, policy, path, options = {}) {
  const reads = new Set(), confidences = new Set();
  const variables = options.variables ?? new Set();
  const stack = options.stack ?? [];
  const merge = r => { r.reads.forEach(q => reads.add(q)); r.confidences.forEach(q => confidences.add(q)); };
  const child = (v, p = path) => merge(checkExpression(v, policy, p, { ...options, stack }));
  requireAt(object(x) && typeof x.op === 'string' && Array.isArray(x.args), path, 'expected a tagged expression', 'Use a Jev expression builder or {op, args}.');
  requireAt(Object.keys(x).every(k => ['op', 'args'].includes(k)), path, 'unknown expression property');
  const { op, args } = x;
  if (own(accessors, op)) {
    const two = ['is', 'yes', 'no', 'mostLikely', 'atLeast', 'prob', 'countYes', 'anyYes', 'allYes', 'yesItems'].includes(op);
    requireAt(args.length === (two ? 2 : 1), path, `${op} expects ${two ? 2 : 1} arguments`);
    const q = policy.questions[args[0]];
    requireAt(typeof args[0] === 'string' && own(policy.questions, args[0]), path, `unknown question '${args[0]}'`, 'Declare the question before referencing it.');
    requireAt(accessors[op].includes(q.type), path, `${op} cannot read a ${q.type} question`,
      q.type === 'noul' && op === 'confidence' ? 'Noul has no confidence; use its probability.'
        : q.type === 'raw' ? 'A raw question has no declared shape; read it only with rawAnswer.'
        : op === 'rawAnswer' ? 'Use the typed accessors (is, yes, value, ...) on declared questions.'
        : `Use ${accessors[op].join(' or ')}.`);
    requireAt(!options.noAnswers, path, 'prechecks cannot read model answers', 'Use facts in prechecks.');
    reads.add(args[0]);
    if (op === 'confidence') confidences.add(args[0]);
    if (op === 'is' || (op === 'prob' && q.type === 'choice')) {
      // Options are named by their code name or by the wire key they send.
      requireAt(optionWire(q, args[1]) !== undefined, path, `'${args[1]}' is not an option of '${args[0]}'`,
        q.optionsFrom
          ? `'${args[0]}' takes runtime options from '${q.optionsFrom}'; name one of its declared options (${optionNames(q).join(', ') || 'none declared'}), or compare chosen('${args[0]}') with a string.`
          : `Use one of: ${optionNames(q).join(', ')}.${didYouMean(args[1], optionNames(q))}`);
    } else if (['mostLikely', 'atLeast', 'prob'].includes(op)) {
      const index = levelIndex(q, args[1]);
      requireAt(index >= 0, path, `'${args[1]}' is not a level of '${args[0]}'`,
        `Use a declared level or its zero-based index.${didYouMean(args[1], [...(q.levelNames ?? []), ...q.criteria])}`);
      requireAt(op !== 'atLeast' || index > 0, path, 'atLeast at the bottom level is always true', 'Use mostLikely or a higher level.');
    } else if (two) {
      child(args[1], `${path}.args[1]`);
      if (args[1].op === 'literal') requireAt(probability(args[1].args[0]), path, 'threshold must be between 0 and 1');
    }
  } else {
    requireAt(own(arities, op), path, `unknown expression '${op}'`, `Use a supported expression operator.`);
    const [lo, hi] = arities[op];
    requireAt(args.length >= lo && args.length <= hi, path, `${op} expects ${lo === hi ? lo : `at least ${lo}`} arguments`);
    if (op === 'literal') { /* Literal payload is data, never traversed as code. */ }
    else if (op === 'fact' || op === 'threshold') {
      const table = op === 'fact' ? policy.state : policy.thresholds;
      requireAt(typeof args[0] === 'string' && own(table, args[0]), path, `unknown ${op} '${args[0]}'`,
        `Declare it in ${op === 'fact' ? 'state' : 'thresholds'}.${didYouMean(String(args[0]), Object.keys(table))}`);
    } else if (op === 'variable') requireAt(variables.has(args[0]), path, `unbound variable '${args[0]}'`, 'Use a variable bound by planFor.');
    else if (op === 'signal') {
      requireAt(own(policy.signals, args[0]), path, `unknown signal '${args[0]}'`);
      requireAt(!stack.includes(args[0]), path, `cyclic signal '${args[0]}'`, 'Remove the recursive signal dependency.');
      merge(checkExpression(policy.signals[args[0]], policy, `$.signals.${args[0]}`, { ...options, stack: [...stack, args[0]] }));
    } else if (op === 'object') {
      requireAt(object(args[0]), path, 'object expression needs a field map');
      Object.entries(args[0]).forEach(([k, v]) => child(v, `${path}.args[0].${k}`));
    } else args.forEach((v, i) => child(v, `${path}.args[${i}]`));
  }
  return { reads, confidences };
}

// A level is named by its declared name, its text, or its zero-based index.
export function levelIndex(q, v) {
  if (Number.isInteger(v)) return v >= 0 && v < q.criteria.length ? v : -1;
  const named = typeof v === 'string' ? (q.levelNames ?? []).indexOf(v) : -1;
  return named >= 0 ? named : q.criteria.findIndex(x => equal(x, v));
}
// An option reference resolves to the wire key the model answers with.
export function optionWire(q, ref) {
  if (typeof ref !== 'string') return undefined;
  if (own(q.names ?? {}, ref)) return q.names[ref];
  return own(q.criteria, ref) ? ref : undefined;
}
// The name the policy uses for a wire key: its code name, else the key itself.
export const optionCode = (q, wire) => Object.entries(q.names ?? {}).find(([, w]) => w === wire)?.[0] ?? wire;
export const optionNames = q => [...Object.keys(q.names ?? {}), ...Object.keys(q.criteria).filter(k => !Object.values(q.names ?? {}).includes(k))];
export function evaluateExpression(x, ctx) {
  const { op, args: a } = x;
  const run = y => evaluateExpression(y, ctx);
  if (own(accessors, op)) return ctx.read(op, a[0], a[1], run);
  switch (op) {
    case 'literal': return a[0];
    case 'fact': {
      requireAt(own(ctx.facts, a[0]), `facts.${a[0]}`, 'missing observed fact', 'Pass facts or build them from the input.', 'answers');
      ctx.logFact?.(a[0], ctx.facts[a[0]]);
      return ctx.facts[a[0]];
    }
    case 'threshold': return ctx.threshold(a[0]);
    case 'signal': return run(ctx.policy.signals[a[0]]);
    case 'variable': return ctx.variables[a[0]];
    case 'and': return a.every(x => truth(run(x)));
    case 'or': return a.some(x => truth(run(x)));
    case 'not': return !truth(run(a[0]));
    case 'if': return run(a[truth(run(a[0])) ? 1 : 2]);
    case 'object': return Object.fromEntries(Object.entries(a[0]).map(([k, v]) => [k, run(v)]));
    case 'array': return a.map(run);
    case 'eq': return equal(run(a[0]), run(a[1]));
    case 'ne': return !equal(run(a[0]), run(a[1]));
    case 'get': {
      const obj = run(a[0]), key = run(a[1]);
      requireAt(typeof key === 'string' || Number.isInteger(key), 'expression.get', 'key must be a string or integer');
      if (own(obj, key)) return obj[key];
      if (a.length === 3) return run(a[2]);
      fail('expression', 'expression.get', `missing field '${key}'`, 'Provide a default or a present field.');
      break;
    }
    case 'length': {
      const v = run(a[0]); requireAt(typeof v === 'string' || Array.isArray(v), 'expression.length', 'expected string or array'); return v.length;
    }
    case 'contains': {
      const xs = run(a[0]), v = run(a[1]); requireAt(Array.isArray(xs), 'expression.contains', 'expected an array'); return xs.some(x => equal(x, v));
    }
    default: {
      const values = a.map(run);
      requireAt(values.every(finite), `expression.${op}`, 'arithmetic/comparison needs finite numbers');
      const [l, r] = values;
      if (op === 'gt') return l > r;
      if (op === 'gte') return l >= r;
      if (op === 'lt') return l < r;
      if (op === 'lte') return l <= r;
      const value = op === 'add' ? values.reduce((x, y) => x + y) : op === 'mul' ? values.reduce((x, y) => x * y)
        : op === 'sub' ? l - r : l / r;
      requireAt(finite(value), `expression.${op}`, 'arithmetic produced a non-finite result', 'Avoid division by zero and numeric overflow.');
      return value;
    }
  }
}
// Conditions have the same false-only semantics as Racket; null is JSON null.
export const truth = v => v !== false;
