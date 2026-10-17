import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { compile, replay, diff } from '../src/index.js';
import { policy } from '../skills/jevlang/assets/router.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = path => readFileSync(join(root, path), 'utf8');
const blocks = path => [...read(path).matchAll(/```js\n([\s\S]*?)\n```/g)].map(m => m[1]);
const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]);

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'jev-skill-test-'));
  mkdirSync(join(dir, 'node_modules'));
  symlinkSync(root, join(dir, 'node_modules', 'jevlang'), 'dir');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('one installable skill contains all referenced resources', () => {
  assert.deepEqual(walk(join(root, 'skills')).filter(file => file.endsWith('/SKILL.md')),
    [join(root, 'skills/jevlang/SKILL.md')]);
  const dir = join(root, 'skills/jevlang');
  for (const file of walk(dir).filter(file => file.endsWith('.md'))) {
    for (const [, href] of readFileSync(file, 'utf8').matchAll(/\]\(([^)]+)\)/g)) {
      if (/^https?:|^#/.test(href)) continue;
      const target = resolve(dirname(file), href.split('#')[0]);
      assert.ok(!relative(dir, target).startsWith('..'), `${file}: reference escapes the skill: ${href}`);
      assert.ok(readFileSync(target).length > 0, `${file}: missing resource ${href}`);
    }
  }
});

test('JS starter routes, escalates below the gate, accepts equality, and rejects unknown answers', () => {
  for (const [choice, confidence, action, target] of [
    ['billing', 0.95, 'assign', 'billing-queue'],
    ['technical', 0.95, 'assign', 'technical-queue'],
    ['billing', 0.799, 'escalate', 'human-triage'],
    ['billing', 0.8, 'assign', 'billing-queue'],
  ]) {
    const result = policy.decide({ team: { choice, confidence } });
    assert.equal(result.action, action);
    assert.equal(result.target, target);
  }
  assert.throws(() => policy.decide({ team: { choice: 'unknown', confidence: 0.9 } }));
  assert.throws(() => policy.decide({}));
  const built = policy.buildState({ message: 'Charged twice', privateField: 'excluded' });
  assert.deepEqual(built.state, { message: 'Charged twice' });
});

test('Python starter exports the same portable policy and decisions', t => {
  const dir = scratch(t);
  const script = `import runpy, json
p = runpy.run_path(${JSON.stringify(join(root, 'skills/jevlang/assets/router.py'))})['policy']
rows = [p.decide({'team': {'choice': c, 'confidence': n}}) for c,n in [('billing', .95), ('technical', .95), ('billing', .799), ('billing', .8)]]
print(json.dumps({'policy': p.to_json(), 'decisions': [[r['action'], r['target']] for r in rows]}))
`;
  writeFileSync(join(dir, 'check.py'), script);
  const result = spawnSync('python3', [join(dir, 'check.py')], {
    encoding: 'utf8', env: { ...process.env, PYTHONPATH: join(root, 'python') },
  });
  assert.equal(result.status, 0, result.stderr);
  const actual = JSON.parse(result.stdout);
  assert.deepEqual(actual.policy, policy.toJSON());
  assert.deepEqual(actual.decisions, [
    ['assign', 'billing-queue'], ['assign', 'technical-queue'],
    ['escalate', 'human-triage'], ['assign', 'billing-queue'],
  ]);
});

test('documented fixture replays, detects stale questions, and shows changed decisions', async t => {
  const dir = scratch(t);
  const sample = blocks('skills/jevlang/references/fixtures.md')[0];
  writeFileSync(join(dir, 'fixture.mjs'), `export function makeFixture(policy, input, answers) {\n${sample}\nreturn fixture;\n}`);
  const { makeFixture } = await import(pathToFileURL(join(dir, 'fixture.mjs')));
  const fixture = makeFixture(policy, { message: 'Invoice' }, { team: { choice: 'billing', confidence: 0.8 } });
  const rows = replay(policy, [fixture]);
  assert.equal(rows[0].status, 'pass');
  assert.equal(rows[0].fingerprintVerified, true);
  const revised = policy.toJSON();
  revised.gates[0].threshold = 0.9;
  const change = diff(policy, compile(revised), [fixture])[0];
  assert.equal(change.changed, true);
  assert.equal(change.after.decision.action, 'escalate');
  revised.questions.team.instructions = 'Changed meaning';
  assert.equal(replay(compile(revised), [fixture])[0].status, 'stale');

  writeFileSync(join(dir, 'policy.json'), JSON.stringify(policy.toJSON()));
  mkdirSync(join(dir, 'fixtures'));
  const fixtureFile = join(dir, 'fixtures', 'billing.json');
  writeFileSync(fixtureFile, JSON.stringify(fixture));
  const cli = () => spawnSync('node', [join(root, 'src/cli.js'), 'replay', join(dir, 'policy.json'), join(dir, 'fixtures')], { encoding: 'utf8' });
  assert.equal(cli().status, 0);
  writeFileSync(fixtureFile, JSON.stringify({ ...fixture, expect: { action: 'hold' } }));
  assert.equal(cli().status, 1);
});

test('documented Box policy checks presence before location and reviews missing confidence', async t => {
  const dir = scratch(t);
  writeFileSync(join(dir, 'image-policy.mjs'), blocks('skills/jevlang/references/images.md')[0]);
  const { policy: imagePolicy } = await import(pathToFileURL(join(dir, 'image-policy.mjs')));
  const box = { left: 0.1, right: 0.8, top: 0.2, bottom: 0.6 };
  const decide = (noul, confidence) => imagePolicy.decide({ present: { noul }, location: { box, confidence } });
  assert.equal(decide(0.1, null).action, 'hold');
  assert.equal(decide(0.99, null).target, 'review');
  assert.deepEqual(decide(0.99, 0.9).data, box);
  assert.throws(() => imagePolicy.decide({ present: { noul: 0.99 }, location: { box: { ...box, right: 0.05 }, confidence: 0.9 } }));
});

test('documented integration starts an offline endpoint and keeps dispatch dry', async t => {
  const dir = scratch(t);
  const examples = blocks('skills/jevlang/references/integration.md');
  writeFileSync(join(dir, 'integration.mjs'), `
import { policy } from ${JSON.stringify(pathToFileURL(join(root, 'skills/jevlang/assets/router.mjs')).href)};
const input = { message: 'Invoice' };
const requestId = 'skill-test';
const decision = policy.decide({ team: { choice: 'billing', confidence: 0.95 } });
${examples[1]}
${examples[2].replace('console.log(server.url);', '')}
export { server, outcome };
`);
  const { server, outcome } = await import(pathToFileURL(join(dir, 'integration.mjs')));
  t.after(() => server.stop());
  assert.equal(outcome.status, 'dry-run');
  const result = await fetch(`${server.url}/decide`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ answers: { team: { choice: 'billing', confidence: 0.95 } } }),
  });
  assert.equal(result.status, 200);
  const body = await result.json();
  assert.equal(body.target, 'billing-queue');
});
