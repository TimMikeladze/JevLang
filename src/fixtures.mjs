import { requireAt, object, own, text, equal, jsonCopy } from './common.mjs';

export function validateFixture(raw) {
  const f = jsonCopy(raw);
  requireAt(object(f) && f.fixture_version === 3, 'fixture.fixture_version', 'unsupported fixture version', 'Migrate to fixture_version 3 with provider/model/effort provenance.');
  requireAt(text(f.provider), 'fixture.provider', 'fixture needs a non-empty provider');
  for (const key of ['requested_model', 'model', 'requested_effort', 'effective_effort']) requireAt(own(f, key) && (f[key] === null || typeof f[key] === 'string'), `fixture.${key}`, 'required provenance must be a string or null');
  requireAt(object(f.answers), 'fixture.answers', 'fixture needs an answers object');
  for (const key of ['expect', 'label', 'labels', 'facts', 'questions', 'usage']) if (f[key] != null) requireAt(object(f[key]), `fixture.${key}`, 'expected an object');
  if (f.questions_sha256 != null) requireAt(typeof f.questions_sha256 === 'string' && /^[a-fA-F0-9]{64}$/.test(f.questions_sha256), 'fixture.questions_sha256', 'expected a SHA-256 fingerprint');
  return f;
}
// Deep partial matching includes action parameters, confirmation and ordered plans.
export function matches(expected, actual) {
  if (Array.isArray(expected)) return Array.isArray(actual) && expected.length === actual.length && expected.every((x, i) => matches(x, actual[i]));
  if (object(expected)) return object(actual) && Object.entries(expected).every(([k, v]) => k === 'action' && v === null ? true : own(actual, k) && matches(v, actual[k]));
  return equal(expected, actual);
}
export function replay(policy, fixtures, options = {}) {
  return fixtures.map((raw, index) => {
    const name = raw?.name ?? String(index);
    try {
      const f = validateFixture(raw);
      const facts = f.facts ?? (object(f.state) ? f.state : {});
      // A fixture that recorded the questions it sent is checked against them
      // exactly; otherwise its hash is checked against the policy's identity.
      const current = policy.identity();
      const recorded = object(f.questions) ? f.questions : null;
      const stale = recorded !== null
        ? !equal(recorded, policy.questions(f.state ?? facts))
        : f.questions_sha256 != null && f.questions_sha256.toLowerCase() !== current;
      if (stale && !options.allowStale) return { name, status: 'stale', message: 'Questions changed; re-record this fixture or explicitly allow stale answers.', fingerprint: current };
      const decision = policy.decide(f.answers, { ...options, facts, state: f.state ?? facts });
      const status = f.expect ? matches(f.expect, decision) ? 'pass' : 'fail' : 'unasserted';
      return { name, status, stale, fingerprintVerified: (recorded !== null || f.questions_sha256 != null) && !stale, verifiedBy: recorded !== null ? 'questions' : f.questions_sha256 != null ? 'identity' : null, synthetic: f.synthetic === true, decision };
    } catch (error) { return { name, status: 'error', message: error.message }; }
  });
}
export function diff(before, after, fixtures, options = {}) {
  const a = replay(before, fixtures, options), b = replay(after, fixtures, options);
  const behavioral = d => d && ({ action: d.action, target: d.target, data: d.data, proposed: behavioral(d.proposed), steps: d.steps.map(behavioral) });
  return a.map((row, i) => ({ name: row.name, changed: row.decision && b[i].decision ? !equal(behavioral(row.decision), behavioral(b[i].decision)) : null, before: row, after: b[i] }));
}
export function tune(policy, fixtures, grid) {
  requireAt(object(grid), 'grid', 'tuning grid must be an object');
  const cases = fixtures.map(validateFixture).filter(f => f.label);
  requireAt(cases.length > 0, 'fixtures', 'tuning needs human-label fields');
  let configurations = [{}];
  for (const [key, values] of Object.entries(grid)) {
    requireAt(Array.isArray(values) && values.length > 0 && configurations.length * values.length <= 10000, `grid.${key}`, 'grid needs non-empty values and at most 10,000 combinations');
    configurations = configurations.flatMap(c => values.map(value => ({ ...c, [key]: value })));
  }
  const results = configurations.map(overrides => {
    let correct = 0;
    for (const f of cases) {
      const d = policy.decide(f.answers, { facts: f.facts ?? (object(f.state) ? f.state : {}), state: f.state, overrides });
      if (matches(f.label, d)) correct++;
    }
    return { overrides, correct, total: cases.length, accuracy: correct / cases.length };
  }).sort((a, b) => b.correct - a.correct);
  return { warnings: [...(cases.length < 200 ? ['Fewer than 200 labels; results are exploratory.'] : []), ...(cases.some(f => f.synthetic) ? ['Includes synthetic fixtures; this does not measure real model quality.'] : [])], results };
}
