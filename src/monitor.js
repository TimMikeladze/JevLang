// Aggregate monitoring. A trace explains one decision; nobody reads ten
// thousand of them. This folds a batch of decisions into the numbers an
// operator watches, and holds the calibration table that needs a label per
// question rather than per decision.
//
// Nothing here raises an alarm: any fixed drift threshold would be invented.
import { own, object, requireAt, finite } from './common.js';
import { matches } from './fixtures.js';
import { usageCost } from './cost.js';

// Below 0.5 is one bucket: a gate that low changes nothing. From 0.5 to 0.9 the
// buckets are 0.1 wide, the range tuning sweeps. The top is split at 0.95
// because confident answers pile up there.
export const confidenceEdges = [0, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 1.0];
// Noul answers spread over the whole of 0..1, so their reliability table uses
// ten equal bins instead.
export const decileEdges = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];

// The bucket holding c: [edge, next), with the last bucket closed.
export function bucketIndex(c, edges = confidenceEdges) {
  const i = edges.slice(1).findIndex(hi => c < hi);
  return i < 0 ? edges.length - 2 : i;
}

const gateRules = ['gate', 'option-gate', 'band'];
// Escalated means a person or a slower tier gets the case: the policy said
// escalate, or a gate or band fired because the model was not sure enough.
export const escalated = d => d.action === 'escalate' || gateRules.includes(d.rule);

const ruleOrder = ['precheck', 'gate', 'option-gate', 'band', 'route', 'else', 'untraced'];
const ruleRank = r => { const i = ruleOrder.indexOf(r); return i < 0 ? ruleOrder.length : i; };
// Clauses are keyed by file, rule and index, so one summary can hold decisions
// from several policies without merging clause 0 of one with clause 0 of another.
const clauseKey = d => d.rule ? [d.file ?? null, d.rule, d.clause ?? null] : [null, 'untraced', null];
const keyOrder = (a, b) => {
  const s = v => v === null || v === undefined ? '' : String(v);
  if (s(a[0]) !== s(b[0])) return s(a[0]) < s(b[0]) ? -1 : 1;
  if (a[1] !== b[1]) return ruleRank(a[1]) - ruleRank(b[1]);
  return (a[2] ?? -1) - (b[2] ?? -1);
};
// Families are sent as name--0, name--1, ...; a histogram groups them under the
// family name.
const questionGroup = id => /^(.+)--[0-9]+$/.exec(id)?.[1] ?? id;
const rate = (n, d) => d === 0 ? null : n / d;
const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
const counted = xs => { const h = new Map(); for (const x of xs) h.set(x, (h.get(x) ?? 0) + 1); return h; };
const countsObject = h => Object.fromEntries([...h].map(([k, v]) => [k, v]));

function observations(d, answers) {
  if (answers) {
    return Object.entries(answers)
      .filter(([, x]) => object(x) && ['choice', 'score'].includes(x.type) && finite(x.confidence))
      .map(([id, x]) => [questionGroup(id), x.type, x.confidence]);
  }
  const seen = new Set();
  return [...(d.readings ?? []), ...(d.evidence ?? [])]
    .filter(r => ['choice', 'score'].includes(r.kind) && finite(r.confidence))
    .map(r => [questionGroup(r.question), r.kind, r.confidence])
    .filter(([q]) => !seen.has(q) && seen.add(q));
}

// decisions : the decisions to fold together
// answers   : optional, aligned with decisions: full answers, so the histograms
//             cover every question rather than only the ones a clause read
// labels    : optional, aligned with decisions: the decision a person wanted
export function summarize(decisions, { answers = null, labels = null } = {}) {
  for (const [xs, what] of [[answers, 'answers'], [labels, 'labels']]) {
    if (xs) requireAt(xs.length === decisions.length, what, `${what} must be aligned with the decisions`);
  }
  const total = decisions.length;
  const actions = counted(decisions.map(d => d.action));
  const targets = counted(decisions.map(d => d.target ?? '(no target)'));
  const escalations = counted(decisions.filter(escalated).map(d => d.rule ?? 'untraced'));
  const clauses = new Map();
  for (const d of decisions) {
    const key = clauseKey(d), id = JSON.stringify(key);
    const entry = clauses.get(id) ?? { key, file: key[0], rule: key[1], index: key[2], source: d.rule ? d.source ?? null : null, line: d.rule ? d.line ?? null : null, count: 0 };
    entry.count += 1; clauses.set(id, entry);
  }
  const table = new Map();
  decisions.forEach((d, i) => {
    for (const [q, kind, confidence] of observations(d, answers ? answers[i] : null)) {
      const id = `${q}\u0000${kind}`;
      const counts = table.get(id) ?? { question: q, kind, counts: Array(confidenceEdges.length - 1).fill(0) };
      counts.counts[bucketIndex(confidence)] += 1;
      table.set(id, counts);
    }
  });
  const tally = labels && labels.some(Boolean) ? decisions.reduce((acc, d, i) => {
    const l = labels[i];
    if (!l) return acc;
    if (escalated(d)) return { ...acc, labeled: acc.labeled + 1, escalated: acc.escalated + 1 };
    const right = matches(l, d);
    return { ...acc, labeled: acc.labeled + 1, auto: acc.auto + 1, wrong: acc.wrong + (right ? 0 : 1) };
  }, { labeled: 0, escalated: 0, auto: 0, wrong: 0 }) : null;
  return {
    total,
    escalated: decisions.filter(escalated).length,
    escalation_rate: rate(decisions.filter(escalated).length, total),
    escalations_by_rule: countsObject(escalations),
    actions: countsObject(actions),
    targets: countsObject(targets),
    clauses: [...clauses.values()].sort((a, b) => keyOrder(a.key, b.key)).map(c => ({
      file: c.file, rule: c.rule, index: c.index, source: c.source, line: c.line,
      count: c.count, share: rate(c.count, total) ?? 0,
    })),
    confidence: {
      source: answers ? 'answers' : 'readings',
      edges: confidenceEdges,
      questions: [...table.values()].sort((a, b) => a.question < b.question ? -1 : a.question > b.question ? 1 : 0)
        .map(h => ({ question: h.question, kind: h.kind, n: h.counts.reduce((a, b) => a + b, 0), counts: h.counts })),
    },
    labels: tally && { ...tally, wrong_rate: rate(tally.wrong, tally.auto) },
  };
}

// The same floor tuning uses before it will call a table meaningful.
export const calibrationMinLabels = 200;

// A score label is a level index, or the level's text as the answer's legend
// gives it.
function scoreLabelIndex(a, label) {
  if (Number.isInteger(label) && label >= 0) return label;
  if (typeof label !== 'string') return null;
  const legend = object(a.legend) ? a.legend : {};
  const hit = Object.entries(legend).find(([, v]) => v === label);
  return hit ? Number(hit[0]) : null;
}
function noulLabel(label) {
  if (label === true || label === 1 || label === 'yes' || label === 'true') return true;
  if (label === false || label === 0 || label === 'no' || label === 'false') return false;
  return null;
}
// -> {kind, p, outcome}, with p null when the label cannot be scored
function scoreCase(a, label) {
  switch (a.type) {
    case 'choice':
      return finite(a.confidence) && typeof a.choice === 'string'
        ? { kind: 'choice', p: a.confidence, outcome: a.choice === String(label) }
        : { kind: 'choice', p: null };
    case 'score': {
      const index = scoreLabelIndex(a, label);
      const ps = object(a.probabilities) ? Object.entries(a.probabilities) : null;
      const predicted = ps && ps.length
        ? Number(ps.sort(([ka, va], [kb, vb]) => vb - va || Number(ka) - Number(kb))[0][0])
        : null;
      return finite(a.confidence) && index !== null && predicted !== null
        ? { kind: 'score', p: a.confidence, outcome: predicted === index }
        : { kind: 'score', p: null };
    }
    case 'noul': {
      const y = noulLabel(label);
      return finite(a.noul) && y !== null ? { kind: 'noul', p: a.noul, outcome: y } : { kind: 'noul', p: null };
    }
    default: return { kind: null, p: null };
  }
}

// cases : [{answers, labels}], labels keyed by question, naming the right answer
export function calibrate(cases) {
  const table = new Map();
  for (const c of cases) {
    if (!object(c?.answers) || !object(c?.labels)) continue;
    for (const [q, label] of Object.entries(c.labels)) {
      const a = c.answers[q];
      if (!object(a)) continue;
      const { kind, p, outcome } = scoreCase(a, label);
      if (!kind) continue;
      const entry = table.get(q) ?? { kind, entries: [] };
      entry.entries.push(p === null ? 'skipped' : { p, outcome });
      table.set(q, entry);
    }
  }
  return [...table.keys()].sort().map(q => {
    const { kind, entries } = table.get(q);
    const observed = entries.filter(e => e !== 'skipped');
    const edges = kind === 'noul' ? decileEdges : confidenceEdges;
    const n = observed.length;
    const bins = edges.slice(0, -1).map((lo, i) => {
      const inBin = observed.filter(o => bucketIndex(o.p, edges) === i);
      return {
        lo, hi: edges[i + 1], n: inBin.length,
        mean_p: inBin.length ? mean(inBin.map(o => o.p)) : null,
        accuracy: inBin.length ? mean(inBin.map(o => (o.outcome ? 1 : 0))) : null,
      };
    });
    return {
      question: q, kind, n,
      hits: observed.filter(o => o.outcome).length,
      skipped: entries.length - n,
      // Expected calibration error, and the Brier score of the same answers.
      ece: n ? bins.filter(b => b.n > 0).reduce((s, b) => s + (b.n / n) * Math.abs(b.accuracy - b.mean_p), 0) : null,
      brier: n ? mean(observed.map(o => (o.p - (o.outcome ? 1 : 0)) ** 2)) : null,
      enough_labels: n >= calibrationMinLabels,
      bins,
    };
  });
}

// ---------------------------------------------------------------------------
// Text reports
//
// The JSON views above are what a program reads. These are what a person reads,
// and they are the same text `raco jev` prints: every line here is compared with
// monitor.rkt's over shared data (test/monitor-text-oracle.rkt).
// ---------------------------------------------------------------------------

// Racket's real->decimal-string: the exact value of the double, rounded half to
// even at `places`. toFixed rounds half away from zero on some values, so the
// exact expansion is taken first.
export function decimalString(x, places = 2) {
  if (!finite(x)) return String(x);
  const negative = x < 0;
  const exact = exactDecimal(Math.abs(x));
  const digits = exact.digits;
  const point = exact.point;
  // Scale so `places` digits sit left of the cut.
  const keep = point + places;
  let head = keep <= 0 ? '' : digits.slice(0, keep).padEnd(keep, '0');
  const tail = keep <= 0 ? '0'.repeat(-keep) + digits : digits.slice(keep);
  let value = BigInt(head === '' ? '0' : head);
  const first = tail[0] ?? '0';
  const rest = tail.slice(1).replace(/0+$/, '');
  if (first > '5' || (first === '5' && rest !== '')) value += 1n;
  else if (first === '5' && rest === '' && value % 2n === 1n) value += 1n; // half to even
  const text = value.toString().padStart(places + 1, '0');
  const whole = places === 0 ? text : text.slice(0, text.length - places);
  const fraction = places === 0 ? '' : `.${text.slice(text.length - places)}`;
  return `${negative && /[1-9]/.test(text) ? '-' : ''}${whole}${fraction}`;
}
// The exact decimal expansion of a non-negative double: its digits, and how many
// of them are left of the point.
function exactDecimal(x) {
  if (x === 0) return { digits: '0', point: 1 };
  const [mantissa, exponent] = x.toExponential(20).split('e');
  const digits = mantissa.replace('.', '').replace(/0+$/, '') || '0';
  return { digits, point: Number(exponent) + 1 };
}
// 0.95 -> "0.95", 1.0 -> "1"
const trimmed = x => decimalString(x, 3).replace(/\.?0+$/, '');
export const edgeString = e => (Number.isInteger(e) ? String(e) : trimmed(e));
export const bucketLabel = (i, edges = confidenceEdges) => `${edgeString(edges[i])}-${edgeString(edges[i + 1])}`;

// Racket's ~a with #:min-width, #:max-width and #:align.
const fit = (value, width, align = 'left', max = null) => {
  let s = String(value);
  if (max !== null && s.length > max) s = s.slice(0, max);
  return s.length >= width ? s : align === 'right' ? s.padStart(width) : s.padEnd(width);
};
const pct = (n, d) => (d === 0 ? '-' : `${decimalString((100 * n) / d, 1)}%`);
const pct1 = x => (x === null || x === undefined ? '-' : `${decimalString(100 * x, 1)}%`);
const points = x => `${x < 0 ? '' : '+'}${decimalString(100 * x, 1)}`;
const r3 = x => (finite(x) ? decimalString(x, 3) : '-');
const clauseName = c => `${c.file ? `${c.file} ` : ''}${c.rule}${c.index === null || c.index === undefined ? '' : ` ${c.index}`}`;
// Most frequent first; ties in name order, so the line is stable.
const countsLine = counts => Object.entries(counts)
  .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  .sort(([, a], [, b]) => b - a)
  .map(([k, v]) => `${k} ${v}`).join(', ');

export function formatSummary(s) {
  const n = s.total;
  const width = Math.max(6, ...s.clauses.map(c => clauseName(c).length));
  const l = s.labels;
  const lines = [
    `${n} decision${n === 1 ? '' : 's'}`,
    `escalated: ${s.escalated} (${pct(s.escalated, n)})${s.escalated === 0 ? '' : `  by ${countsLine(s.escalations_by_rule)}`}`,
    `actions:   ${countsLine(s.actions)}`,
    `targets:   ${countsLine(s.targets)}`,
    '',
    `  ${fit('clause', width)}  count   share  source`,
    ...s.clauses.map(c => `  ${fit(clauseName(c), width)}  ${fit(c.count, 5, 'right')}  ${fit(pct(c.count, n), 6, 'right')}  ${c.source ?? ''}`),
    '',
    `confidence, ${s.confidence.source === 'answers' ? 'every choice and score answer' : 'from trace readings: only questions the firing clause read'} (bucket lower edges)`,
    `  ${fit('', 24)}${confidenceEdges.slice(0, -1).map(e => fit(edgeString(e), 5, 'right')).join(' ')}`,
    ...s.confidence.questions.map(h => `  ${fit(`${h.question} (${h.kind})`, 24, 'left', 24)}${h.counts.map(c => fit(c, 5, 'right')).join(' ')}`),
    ...(s.confidence.questions.length === 0 ? ['  (no choice or score confidences)'] : []),
    '',
    l
      ? `labels: ${l.labeled} labeled; ${l.escalated} escalated, ${l.auto} decided by the policy, ${l.wrong} of those wrong (${pct(l.wrong, l.auto)})`
      : 'labels: none, so no wrong rate',
  ];
  return lines.join('\n');
}

// --- comparing two windows --------------------------------------------------
// share_a / share_b are each clause's fraction of its own window, and delta is
// b - a. Nothing here raises an alarm: how large a move matters depends on the
// traffic, so that bar is the reader's to set.
export function compareWindows(a, b) {
  const sa = Array.isArray(a) ? summarize(a) : a;
  const sb = Array.isArray(b) ? summarize(b) : b;
  const key = c => JSON.stringify([c.file ?? null, c.rule, c.index ?? null]);
  const ta = new Map(sa.clauses.map(c => [key(c), c]));
  const tb = new Map(sb.clauses.map(c => [key(c), c]));
  const keys = [...new Set([...ta.keys(), ...tb.keys()])]
    .map(k => JSON.parse(k))
    .sort(keyOrder);
  const shifts = keys.map(k => {
    const ca = ta.get(JSON.stringify(k)) ?? null;
    const cb = tb.get(JSON.stringify(k)) ?? null;
    const na = ca?.count ?? 0;
    const nb = cb?.count ?? 0;
    const shareA = rate(na, sa.total) ?? 0;
    const shareB = rate(nb, sb.total) ?? 0;
    return {
      file: k[0], rule: k[1], index: k[2], source: ca?.source ?? cb?.source ?? null,
      count_a: na, count_b: nb, share_a: shareA, share_b: shareB, delta: shareB - shareA,
    };
  });
  return {
    a: { total: sa.total, escalation_rate: rate(sa.escalated, sa.total) },
    b: { total: sb.total, escalation_rate: rate(sb.escalated, sb.total) },
    // A stable sort, so equal movements keep clause order.
    shifts: shifts.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta)),
  };
}

export function formatComparison(c, { labels = ['A', 'B'] } = {}) {
  const ea = c.a.escalation_rate;
  const eb = c.b.escalation_rate;
  return [
    `window ${labels[0]}: ${c.a.total} decisions, escalation rate ${pct1(ea)}`,
    `window ${labels[1]}: ${c.b.total} decisions, escalation rate ${pct1(eb)}${ea !== null && eb !== null ? `  (${points(eb - ea)} points)` : ''}`,
    '',
    'clause share movement, largest first:',
    ...c.shifts.map(s => `  ${fit(points(s.delta), 6, 'right')} pts  ${fit(clauseName(s), 24)}  ${fit(pct1(s.share_a), 6, 'right')} -> ${fit(pct1(s.share_b), 6, 'right')}  ${s.source ?? ''}`),
    '',
    'This reports movement only. No threshold is applied; how large a move',
    'matters depends on your traffic, so that bar is yours to set.',
  ].join('\n');
}

export function formatCalibration(c) {
  const noul = c.kind === 'noul';
  const edges = noul ? decileEdges : confidenceEdges;
  return [
    `${c.question} (${c.kind}): ${c.n} labeled answer${c.n === 1 ? '' : 's'}${c.skipped > 0 ? `, ${c.skipped} label${c.skipped === 1 ? '' : 's'} could not be scored` : ''}`,
    `  ${fit('bucket', 10)}${fit('n', 5, 'right')}${fit(noul ? 'mean p' : 'mean conf', 11, 'right')}${fit(noul ? 'labeled yes' : 'accuracy', 13, 'right')}${fit('gap', 8, 'right')}`,
    ...c.bins.map((b, i) => [b, i]).filter(([b]) => b.n > 0).map(([b, i]) => {
      const gap = b.accuracy - b.mean_p;
      return `  ${fit(bucketLabel(i, edges), 10)}${fit(b.n, 5, 'right')}${fit(r3(b.mean_p), 11, 'right')}${fit(r3(b.accuracy), 13, 'right')}${fit(`${gap < 0 ? '' : '+'}${r3(gap)}`, 8, 'right')}`;
    }),
    `  ECE ${r3(c.ece)}   Brier ${r3(c.brier)}${noul ? '' : '   (Brier of confidence against right/wrong)'}`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Stability: the same input, asked n times
//
// Running the repeats calls a provider, so that part is not here and not under
// test; what is here is everything that turns the answers into numbers, and the
// report a person reads. A caller collects the runs (the local CLI does it by
// evaluating n times with a throwaway `_uid` in the state, as monitor.rkt does)
// and hands them to `stabilityReport`.
// ---------------------------------------------------------------------------

// Population standard deviation, as numpy's default, which is what the
// consistency cookbooks' figures use.
const stdev = xs => {
  if (!xs.length) return 0;
  const m = mean(xs);
  return Math.sqrt(mean(xs.map(x => (x - m) ** 2)));
};
// Ties go to the name that sorts first, so the result never depends on order.
const modeOf = xs => {
  const h = counted(xs);
  const keys = [...h.keys()].sort((a, b) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0));
  const best = keys.reduce((a, b) => (h.get(b) > h.get(a) ? b : a));
  return [best, h.get(best)];
};
const levelPairs = a => (object(a.probabilities) ? Object.entries(a.probabilities).map(([k, v]) => [Number(k), v]) : []);
// The index of the single most probable level. Ties go to the lower level.
const argmaxLevel = a => {
  const ps = levelPairs(a);
  return ps.length ? ps.reduce((best, p) => (p[1] > best[1] ? p : best))[0] : null;
};
const choiceProbability = (a, option) => (object(a.probabilities) ? a.probabilities[option] ?? 0 : 0);
const topProbability = a => {
  const ps = object(a.probabilities) ? Object.entries(a.probabilities) : [];
  if (!ps.length) return 0;
  return ps.sort(([ka, va], [kb, vb]) => vb - va || (String(ka) < String(kb) ? -1 : 1))[0][1];
};

// A gate as this module reads one: the question it guards, its kind, the name
// its threshold is overridden under, and the numbers it compares.
//   {question, kind: 'gate'|'option-gate'|'band', threshold?, by?, option?, lo?, hi?}
// `gatesOf` builds that list from a policy artifact.
export const gatesOf = policy => (policy.gates ?? []).map(g => {
  const band = own(g, 'low');
  const kind = band ? 'band' : own(g, 'option') ? 'option-gate' : 'gate';
  return {
    question: g.question, kind,
    name: kind === 'option-gate' ? `${g.question}/${g.option}` : g.question,
    threshold: g.threshold ?? null, by: g.by === 'topProb' ? 'top-prob' : g.by ?? null,
    option: g.option ?? null, lo: band ? g.low : null, hi: band ? g.high : null,
  };
});

// A threshold t is crossed when some runs fell below it and some did not. A
// band's high edge is inclusive, so it is crossed when some runs were at or
// below it and some above.
const crosses = (xs, t) => xs.length > 0 && Math.min(...xs) < t && t <= Math.max(...xs);
const crossesHigh = (xs, t) => xs.length > 0 && Math.min(...xs) <= t && t < Math.max(...xs);
const bandEdgeName = (q, edge) => `${q}/${edge}`;

function crossingsFor(id, answers, measures, gates, thresholds, thresholdValue) {
  const out = [];
  const hit = (kind, name, t, measure, xs, test = crosses) => {
    if (finite(t) && test(xs, t)) out.push({ kind, name: String(name), threshold: t, measure, lo: Math.min(...xs), hi: Math.max(...xs) });
  };
  const bandEdges = new Set(gates.filter(g => g.kind === 'band').flatMap(g => ['lo', 'hi'].map(e => bandEdgeName(g.question, e))));
  for (const g of gates.filter(g => g.question === id)) {
    if (g.kind === 'gate' || g.kind === 'option-gate') {
      const measure = g.by === 'top-prob' ? 'top-prob' : 'confidence';
      // An option gate only applies to the runs that chose that option.
      const xs = g.option
        ? answers.filter(a => a.choice === String(g.option) && finite(a.confidence)).map(a => (measure === 'top-prob' ? topProbability(a) : a.confidence))
        : measures[measure] ?? [];
      hit(g.kind, g.name, thresholdValue(g.name, g.threshold), measure, xs);
    } else if (g.kind === 'band') {
      const xs = measures.probability ?? [];
      const edge = (e, written) => (finite(written) ? thresholdValue(bandEdgeName(id, e), written) : null);
      hit('band-lo', g.name, edge('lo', g.lo), 'probability', xs);
      hit('band-hi', g.name, edge('hi', g.hi), 'probability', xs, crossesHigh);
    }
  }
  // A named threshold is not tied to a question, so this only says that its
  // value lies inside this question's observed range.
  for (const th of thresholds) {
    if (bandEdges.has(th.name)) continue;
    const measure = { probability: 'probability', confidence: 'confidence', score: 'score' }[th.kind] ?? null;
    if (measure) hit('threshold', th.name, thresholdValue(th.name, th.default), measure, measures[measure] ?? []);
  }
  return out;
}

// allAnswers : one answers object per run
// gates      : as `gatesOf` returns them
// thresholds : [{name, kind: 'probability'|'confidence'|'score', default}]
export function questionStabilities(allAnswers, { gates = [], thresholds = [], overrides = {} } = {}) {
  const thresholdValue = (name, fallback) => (own(overrides, name) ? overrides[name] : fallback);
  const ids = [...new Set(allAnswers.flatMap(a => Object.keys(a ?? {})))].sort();
  const out = [];
  for (const id of ids) {
    const as = allAnswers.map(a => a?.[id]).filter(object);
    if (!as.length) continue;
    const kind = as[0].type ?? 'unknown';
    const reals = key => as.map(a => a[key]).filter(finite);
    const confidences = reals('confidence');
    let values = [], modal = null, flip = null, measures = {};
    if (kind === 'noul') {
      values = reals('noul');
      measures = { probability: values };
    } else if (kind === 'score') {
      values = reals('score');
      const levels = as.filter(a => object(a.probabilities)).map(argmaxLevel);
      const [m, count] = levels.length ? modeOf(levels) : [null, 0];
      modal = m;
      flip = m === null ? null : 1 - count / levels.length;
      measures = { score: values, confidence: confidences };
    } else if (kind === 'choice') {
      const picks = as.map(a => a.choice ?? '');
      const [m, count] = modeOf(picks);
      modal = m;
      values = as.map(a => choiceProbability(a, m));
      flip = 1 - count / picks.length;
      measures = { probability: values, confidence: confidences, 'top-prob': as.map(topProbability) };
    }
    out.push({
      question: id, kind, n: as.length,
      mean: values.length ? mean(values) : 0,
      stdev: stdev(values),
      min: values.length ? Math.min(...values) : null,
      max: values.length ? Math.max(...values) : null,
      modal: modal === null || modal === false ? null : modal,
      flip_rate: flip,
      confidence_stdev: ['choice', 'score'].includes(kind) ? stdev(confidences) : null,
      crossings: crossingsFor(id, as, measures, gates, thresholds, thresholdValue),
    });
  }
  return out;
}

const decisionDescription = d => (object(d) ? `${d.action}${d.target ? ` ${d.target}` : ''}` : 'error');

// runs : [{answers, decision}] — a decision object, or a string, which is the
//        message from a decide that failed.
export function stabilityReport({
  policy = null, runs = [], gates = [], thresholds = [], overrides = {},
  uidAdded = false, usage = { input_tokens: 0, output_tokens: 0 }, precheck = null, n = null,
} = {}) {
  const count = n ?? runs.length;
  if (precheck) {
    return {
      policy, runs: count, uid_added: false, precheck, questions: [], decisions: [], errors: [],
      usage, cost: usageCost(usage),
    };
  }
  const tally = counted(runs.map(r => decisionDescription(r.decision)));
  return {
    policy, runs: count, uid_added: uidAdded, precheck: null,
    questions: questionStabilities(runs.map(r => r.answers ?? {}), { gates, thresholds, overrides }),
    decisions: [...tally.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .sort(([, a], [, b]) => b - a)
      .map(([decision, c]) => ({ decision, count: c })),
    errors: runs.map(r => r.decision).filter(d => typeof d === 'string'),
    usage, cost: usageCost(usage),
  };
}

export function formatStability(r) {
  const n = r.runs;
  if (r.precheck) {
    return `${r.policy}: precheck decides this input without calling the model, so there is\nnothing to repeat.\n  ${decisionDescription(r.precheck)}`;
  }
  const qs = r.questions;
  const w = Math.max(8, ...qs.map(q => q.question.length));
  const xs = qs.flatMap(q => q.crossings);
  const kindWord = { gate: 'gate', 'option-gate': 'option gate', 'band-lo': 'band (low edge)', 'band-hi': 'band (high edge)' };
  return [
    `${n} runs of ${r.policy}${r.uid_added ? ', each with a throwaway _uid in the state' : '; the state is text, so the runs were identical requests (no _uid)'}`,
    '',
    `  ${fit('question', w)}  kind     mean   stdev  range          flips   conf stdev`,
    ...qs.map(q => `  ${fit(q.question, w)}  ${fit(q.kind, 6)}  ${r3(q.mean)}  ${r3(q.stdev)}  ${fit(`${r3(q.min)}-${r3(q.max)}`, 13)}  ${fit(q.flip_rate === null ? '-' : `${roundHalfEven(100 * q.flip_rate)}%`, 6)}  ${r3(q.confidence_stdev)}`),
    '',
    '  mean/stdev/range are of: noul -> its probability; score -> the score;',
    '  choice -> the probability of the option chosen most often.',
    '',
    ...(xs.length === 0
      ? ['no gate, band or named threshold lies inside the observed ranges']
      : ['the observed noise crosses:',
        ...xs.map(c => `  ${kindWord[c.kind] ?? 'threshold'} ${c.name} at ${r3(c.threshold)}: ${c.measure} ranged ${r3(c.lo)}-${r3(c.hi)}`)]),
    '',
    `decisions: ${r.decisions.map(d => `${d.decision} ${d.count}/${n}`).join(', ')}`,
    ...[...new Set(r.errors)].map(e => `  decide failed: ${e}`),
    `${r.usage.input_tokens} input tokens over ${n} calls, $${decimalString(r.cost, 6)}`,
  ].join('\n');
}
// Racket's exact-round: half to even.
const roundHalfEven = x => {
  const down = Math.floor(x);
  const rest = x - down;
  if (rest > 0.5) return down + 1;
  if (rest < 0.5) return down;
  return down % 2 === 0 ? down : down + 1;
};
