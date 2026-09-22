// The Laya adapter, exercised without network or weights: the real bridge runs
// under the real python3 with a stub `laya` package on PYTHONPATH, so the
// question adaptation, answer normalization and error classification are the
// shipped code. Machines without python3 still get the fake-interpreter tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFile, mkdir, rm, chmod, mkdtemp } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { layaProvider, ProviderRegistry } from '../src/provider/index.js';
import { evaluateWithProvider, policyProviderRequest } from '../src/evaluate.js';
import { policy as ticket } from '../examples/ticket-router.js';

const python = spawnSync('python3', ['-c', 'print(1)'], { encoding: 'utf8' });
const havePython = python.status === 0;

const stubPackage = async log => {
  const dir = await mkdtemp(join(tmpdir(), 'laya-stub-'));
  await mkdir(join(dir, 'laya'));
  await writeFile(join(dir, 'laya', '__init__.py'), [
    'import json',
    `LOG = ${JSON.stringify(log)}`,
    '',
    'def _answer(question):',
    '    kind = question.get("type")',
    '    if kind == "choice":',
    '        options = sorted((question.get("criteria") or {}).keys())',
    '        return {"choice": options[0], "confidence": 0.9}',
    '    if kind == "score":',
    '        levels = question.get("criteria") or []',
    '        probabilities = {str(i): (0.9 if i == len(levels) - 1 else 0.05) for i in range(len(levels))}',
    '        return {"score": float(len(levels) - 1), "confidence": 0.9, "probabilities": probabilities}',
    '    return {"noul": 0.9}',
    '',
    'def _record(call, state, questions):',
    '    with open(LOG, "a") as handle:',
    '        handle.write(json.dumps({"call": call, "state": state, "questions": questions}) + "\\n")',
    '',
    'class Router:',
    '    def __init__(self, preload=False):',
    '        self.preload = preload',
    '    def predict(self, state, questions, model=None):',
    '        _record("router(preload=%s,model=%s)" % (self.preload, model), state, questions)',
    '        return {"answers": {n: _answer(q) for n, q in questions.items()}, "routing": {"model": "english"}}',
    '',
    'class _Agent:',
    '    def __init__(self, repo, subfolder=None):',
    '        self.repo, self.subfolder = repo, subfolder',
    '    def predict(self, state, questions):',
    '        _record("load(%s,subfolder=%s)" % (self.repo, self.subfolder), state, questions)',
    '        return {"answers": {n: _answer(q) for n, q in questions.items()}}',
    '',
    'def load(repo, subfolder=None):',
    '    return _Agent(repo, subfolder)',
    '',
  ].join('\n'));
  return dir;
};

const withPythonPath = async (value, thunk) => {
  const previous = process.env.PYTHONPATH;
  if (value === null) delete process.env.PYTHONPATH; else process.env.PYTHONPATH = value;
  try { return await thunk(); } finally {
    if (previous === undefined) delete process.env.PYTHONPATH; else process.env.PYTHONPATH = previous;
  }
};

const input = { ticket: { body: 'we were billed twice for march and want the duplicate charge back today' } };

test('the bridge adapts questions, normalizes answers, and the decision carries laya provenance', { skip: !havePython && 'no python3' }, async t => {
  const log = join(tmpdir(), `laya-log-${process.pid}.jsonl`);
  await rm(log, { force: true });
  t.after(() => rm(log, { force: true }));
  const stub = await stubPackage(log);
  const registry = new ProviderRegistry();
  registry.register(layaProvider());
  const decision = await withPythonPath(stub, () =>
    evaluateWithProvider(ticket, input, { provider: 'laya', registry }));
  // The stub answers billing / most-frustrated / refund-yes, which pages retention.
  assert.equal(decision.action, 'page');
  assert.equal(decision.target, 'retention-oncall');
  assert.equal(decision.provider, 'laya');
  assert.equal(decision.model, 'english');

  const [record] = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(record.call, 'router(preload=True,model=None)');
  assert.ok(JSON.stringify(record.state).includes('billed twice'), 'the built state reaches the bridge');
  const questions = record.questions;
  // Instructions flattened to a string, criteria passed through untouched.
  assert.equal(questions.department.instructions, 'Which team should handle this ticket?');
  assert.deepEqual(Object.keys(questions.department.criteria).sort(), ['billing', 'sales', 'technical']);
  assert.ok(Array.isArray(questions.frustration.criteria) && questions.frustration.criteria.length === 3);
  assert.equal(questions['refund-requested?'].type, 'noul');
});

test('the model field selects a checkpoint instead of the router', { skip: !havePython && 'no python3' }, async t => {
  const log = join(tmpdir(), `laya-log-2-${process.pid}.jsonl`);
  await rm(log, { force: true });
  t.after(() => rm(log, { force: true }));
  const stub = await stubPackage(log);
  const registry = new ProviderRegistry();
  registry.register(layaProvider());
  const decision = await withPythonPath(stub, () =>
    evaluateWithProvider(ticket, input, { provider: 'laya', model: 'multilingual', registry }));
  assert.equal(decision.model, 'multilingual');
  const [record] = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(record.call, 'load(convaiinnovations/laya,subfolder=multilingual)');
});

test('a missing laya package is a configuration error, not a retry', { skip: !havePython && 'no python3' }, async () => {
  const empty = await mkdtemp(join(tmpdir(), 'laya-empty-'));
  await withPythonPath(empty, async () => {
    const request = policyProviderRequest({}, ticket.questions(ticket.buildState(input).state), { provider: 'laya' });
    const provider = layaProvider();
    await assert.rejects(provider.run(request, { provider, model: null, requestedEffort: null, effectiveEffort: null, sources: {} }), error =>
      error.kind === 'configuration' && error.retryable === false && /pip install laya/.test(error.message));
  });
});

test('a laya runtime failure is a retryable provider failure', { skip: !havePython && 'no python3' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'laya-broken-'));
  await mkdir(join(dir, 'laya'));
  await writeFile(join(dir, 'laya', '__init__.py'), [
    'class Router:',
    '    def __init__(self, preload=False): pass',
    '    def predict(self, state, questions):',
    '        raise RuntimeError("checkpoint download interrupted")',
    'def load(repo, subfolder=None): raise RuntimeError("nope")',
  ].join('\n'));
  await withPythonPath(dir, async () => {
    const provider = layaProvider();
    const request = policyProviderRequest({}, {}, { provider: 'laya' });
    await assert.rejects(provider.run(request, { provider, model: null, requestedEffort: null, effectiveEffort: null, sources: {} }), error =>
      error.kind === 'provider-failure' && error.retryable === true && /checkpoint download interrupted/.test(error.message));
  });
});

// A fake interpreter for machines without python3: it speaks the bridge
// protocol from the outside, so the adapter's result mapping is still covered.
const fakeInterpreter = async response => {
  const dir = await mkdtemp(join(tmpdir(), 'laya-fake-'));
  const path = join(dir, 'laya-python');
  await writeFile(path, `#!/usr/bin/env node
import('node:fs').then(async fs => {
  const seen = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (seen.protocol !== 'laya-bridge/1') { console.error('bad protocol'); process.exit(2); }
  ${response}
});`);
  await chmod(path, 0o755);
  return path;
};

test('the adapter maps a bridge result with no model requested', async t => {
  const path = await fakeInterpreter(`console.log(JSON.stringify({ output: { q: { choice: 'a', confidence: 1 } }, model: 'english', usage: {} }));`);
  t.after(() => rm(dirname(path), { recursive: true, force: true }));
  const provider = layaProvider({ command: path });
  const request = policyProviderRequest({}, { q: { type: 'choice', instructions: 'pick', criteria: { a: 'x', b: 'y' } } }, { provider: 'laya' });
  const target = { provider, model: null, requestedEffort: null, effectiveEffort: null, sources: {} };
  const result = await provider.run(request, target);
  assert.deepEqual(result.output, { q: { choice: 'a', confidence: 1 } });
  assert.equal(result.model, 'english');
  assert.equal(result.target.model, 'english');
  assert.deepEqual(result.cost, { mode: 'self-hosted', usd: 0 });
});

test('a bridge error object is classified, and a crash without one too', async t => {
  const failing = await fakeInterpreter(`console.log(JSON.stringify({ error: { kind: 'rate-limit', message: 'too hot', retryable: true } })); process.exit(1);`);
  const crashing = await fakeInterpreter(`console.error('Traceback (most recent call last):'); process.exit(3);`);
  t.after(() => rm(dirname(failing), { recursive: true, force: true }));
  const provider = layaProvider({ command: failing });
  const request = policyProviderRequest({}, {}, { provider: 'laya' });
  const target = { provider, model: null, requestedEffort: null, effectiveEffort: null, sources: {} };
  await assert.rejects(provider.run(request, target), error =>
    error.kind === 'rate-limit' && error.retryable === true && /too hot/.test(error.message));
  const crasher = layaProvider({ command: crashing });
  await assert.rejects(crasher.run(request, { ...target, provider: crasher }), error =>
    error.kind === 'provider-failure' && error.retryable === true);
});

test('a slow interpreter is timed out', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'laya-slow-'));
  const path = join(dir, 'laya-slow');
  await writeFile(path, `#!/usr/bin/env node\nsetTimeout(() => {}, 10000);`);
  await chmod(path, 0o755);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const provider = layaProvider({ command: path, timeoutSeconds: 1 });
  const request = policyProviderRequest({}, {}, { provider: 'laya' });
  await assert.rejects(provider.run(request, { provider, model: null, requestedEffort: null, effectiveEffort: null, sources: {} }), error =>
    error.kind === 'timeout' && error.retryable === true);
});

test('discovery reports a missing interpreter, and a ready one names the bridge', async () => {
  const missing = await layaProvider({ command: 'no-such-interpreter-for-laya' }).discover();
  assert.equal(missing.status, 'missing');
  if (!havePython) return;
  const ready = await layaProvider().discover();
  assert.equal(ready.status, 'ready');
  assert.equal(ready.billing, 'free');
});

test('the default registry carries laya next to the CLI adapters', async () => {
  const { makeDefaultRegistry } = await import('../src/provider/registry.js');
  const registry = makeDefaultRegistry({});
  assert.ok(registry.get('laya'), 'laya is registered');
  assert.equal(registry.get('laya').caps.controls.includes('structured-output'), true);
});
