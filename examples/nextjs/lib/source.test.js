import { test, expect } from 'bun:test';
import { policySource } from './source.js';
import { maintenance, doorstep } from './policies.js';

// Every clause the engine can name must map to lines that declare it.
test('decision sources map to the lines that declare them', () => {
  for (const [route, policy] of [['maintenance', maintenance], ['doorstep', doorstep]]) {
    const src = policySource(route);
    expect(src.clauses).toHaveLength(policy.policy.route.clauses.length);
    expect(src.gates).toHaveLength(policy.policy.gates.length);
    for (const [s, e] of src.clauses) expect(src.lines.slice(s, e + 1).join('\n')).toMatch(/^\s*rule\([\s\S]*\)\),?\s*$/);
  }
  const { lines, clauses } = policySource('doorstep');
  expect(lines[clauses[3][0]]).toContain("fact('value-usd')");
  expect(lines[clauses[3][1]]).toContain("assign('parcel-locker'");
});
