// Development-only differential driver: formats the text reports the Python
// engine must match byte-for-byte. Reads one JSON request from stdin:
//   {ticketArtifact, fixtureDirs, calibrationCases, stabilityCases}
// Prints a JSON object of the same reports core.test.mjs checks against Racket.
import { readFile, readdir } from 'node:fs/promises';
import { compile } from '../../src/engine.js';
import { replay } from '../../src/fixtures.js';
import { summarize, compareWindows, formatSummary, formatComparison, formatCalibration, calibrate, stabilityReport, formatStability, decimalString } from '../../src/monitor.js';

const request = JSON.parse((await readFile('/dev/stdin', 'utf8')).trim());
const policy = compile(request.ticketArtifact);
const fixtures = [];
for (const dir of request.fixtureDirs) {
  for (const f of (await readdir(dir)).filter(x => x.endsWith('.json')).sort()) {
    fixtures.push(JSON.parse(await readFile(`${dir}/${f}`, 'utf8')));
  }
}
fixtures.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
const decisions = fixtures.map(f => policy.decide(f.answers, { facts: f.facts ?? f.state, state: f.state }));
const half = Math.floor(decisions.length / 2);
const plain = s => ({ ...s, clauses: s.clauses.map(({ file, source, line, ...rest }) => rest) });
const sa = plain(summarize(decisions.slice(0, half)));
const sb = plain(summarize(decisions.slice(half)));
const labelled = plain(summarize(decisions, { answers: fixtures.map(f => f.answers), labels: fixtures.map(f => f.label ?? null) }));
const cmp = compareWindows(sa, sb);
const shared = request.stabilityCases;
const gates = shared.gates.map(g => ({ ...g, name: g.kind === 'option-gate' ? `${g.question}/${g.option}` : g.question }));
const stability = stabilityReport({
  policy: shared.policy, runs: shared.runs, gates, thresholds: shared.thresholds,
  uidAdded: true, usage: shared.usage,
});
const calm = {
  department: { type: 'choice', choice: 'billing', confidence: 0.99, probabilities: { billing: 0.99, technical: 0.005, sales: 0.005 } },
  frustration: { type: 'score', score: 0.2, confidence: 0.95, probabilities: { 0: 0.9, 1: 0.07, 2: 0.03 } },
  'refund-requested?': { type: 'noul', noul: 0.1 },
};
console.log(JSON.stringify({
  summary_a_text: formatSummary(sa),
  summary_labelled_text: formatSummary(labelled),
  comparison_text: formatComparison(cmp),
  comparison_text_named: formatComparison(cmp, { labels: ['last week', 'this week'] }),
  calibration_text: calibrate(request.calibrationCases).map(formatCalibration),
  stability_text: formatStability(stability),
  precheck_text: formatStability(stabilityReport({ policy: shared.policy, n: 12, precheck: policy.decide(calm) })),
  decimals: [0.125, 0.5, 0.0005, 33.333333, 99.95, 1.0005].map(x => [1, 3, 6].map(p => decimalString(x, p))),
}));
