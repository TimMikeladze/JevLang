import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdtemp, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProviderRegistry, capabilities, availability, provider, providerRequest, targetSpec, mergeProviderConfig, resolveProvider, runProviderRequest, commandProvider, makeDefaultRegistry, clearProviderDiscoveryCache, jsonSchemaValid, runner, environmentReader } from '../src/provider/index.js';

const script = async (body, { name = 'fake-provider' } = {}) => {
  const dir = await mkdtemp(join(tmpdir(), 'jev-provider-'));
  const path = join(dir, name);
  await writeFile(path, `#!/usr/bin/env node\n${body}\n`);
  await chmod(path, 0o755);
  return path;
};
const withPath = async (dirs, thunk) => {
  const original = environmentReader.get;
  // The fake executables have a node shebang, so the real PATH stays reachable.
  environmentReader.get = name => name === 'PATH' ? [...dirs, process.env.PATH].join(':') : original.call(environmentReader, name);
  try { return await thunk(); } finally { environmentReader.get = original; }
};

test('a custom executable speaks jev-provider/1: request in, output and accounting out', async () => {
  const path = await script(`
    let input = '';
    process.stdin.on('data', c => { input += c; });
    process.stdin.on('end', () => {
      const request = JSON.parse(input);
      process.stdout.write(JSON.stringify({
        output: { verdict: 'ok', saw: request.protocol, effort: request.effort, model: request.model, prompt: request.prompt },
        model: request.model, usage: { input_tokens: 11 }, cost: { mode: 'subscription', usd: null },
        provider_request_id: 'req_1', changed: ['a.txt'],
      }));
    });
  `);
  const dir = path.slice(0, path.lastIndexOf('/'));
  await withPath([dir], async () => {
    const p = commandProvider('fake', 'fake-provider', { caps: capabilities({ efforts: ['low', 'high'] }) });
    const registry = new ProviderRegistry();
    registry.register(p);
    clearProviderDiscoveryCache(registry);
    const config = mergeProviderConfig({ project: { provider: 'fake', model: 'fake-1', effort: 'high' } });
    const request = providerRequest('review', 'structured', { prompt: 'look at this', schema: { type: 'object', required: ['verdict'] } });
    const result = await runProviderRequest(request, config, registry);
    assert.deepEqual(result.output, { verdict: 'ok', saw: 'jev-provider/1', effort: 'high', model: 'fake-1', prompt: 'look at this' });
    // Reported USD, a subscription call and unreported usage stay distinct.
    assert.deepEqual(result.cost, { mode: 'subscription', usd: null });
    assert.deepEqual(result.usage, { input_tokens: 11 });
    assert.equal(result.requestId, 'req_1');
    assert.deepEqual(result.changed, ['a.txt']);
    assert.deepEqual(result.attempts.map(a => a.outcome), ['success']);
  });
});

test('a retryable failure falls back, a mutating one does not, and output is schema-checked', async () => {
  const broken = await script(`
    process.stdin.resume();
    process.stdin.on('end', () => {
      process.stdout.write(JSON.stringify({ error: { kind: 'overload', retryable: true } }));
      process.exitCode = 3;
    });
  `, { name: 'broken-provider' });
  const mutating = await script(`
    process.stdin.resume();
    process.stdin.on('end', () => {
      process.stdout.write(JSON.stringify({ error: { kind: 'provider-failure', retryable: true, mutated: true } }));
      process.exitCode = 4;
    });
  `, { name: 'mutating-provider' });
  const wrong = await script(`
    process.stdin.resume();
    process.stdin.on('end', () => { process.stdout.write(JSON.stringify({ output: { nope: true } })); });
  `, { name: 'wrong-provider' });
  const good = await script(`
    process.stdin.resume();
    process.stdin.on('end', () => { process.stdout.write(JSON.stringify({ output: { verdict: 'ok' }, cost: 0.25 })); });
  `, { name: 'good-provider' });
  const dirs = [broken, mutating, wrong, good].map(p => p.slice(0, p.lastIndexOf('/')));
  await withPath(dirs, async () => {
    const registry = new ProviderRegistry();
    for (const [id, command] of [['broken', 'broken-provider'], ['mutating', 'mutating-provider'], ['wrong', 'wrong-provider'], ['good', 'good-provider']]) {
      registry.register(commandProvider(id, command, { caps: capabilities({}) }));
    }
    clearProviderDiscoveryCache(registry);
    const schema = { type: 'object', required: ['verdict'] };
    const request = providerRequest('review', 'structured', { schema });
    const result = await runProviderRequest(request, mergeProviderConfig({ project: { prefer: ['broken', 'good'] } }), registry);
    assert.equal(result.output.verdict, 'ok');
    assert.deepEqual(result.cost, { mode: 'reported-usd', usd: 0.25 });
    assert.deepEqual(result.attempts.map(a => a.outcome), ['overload', 'success']);

    // A provider that may have changed something is never retried.
    await assert.rejects(runProviderRequest(request, mergeProviderConfig({ project: { prefer: ['mutating', 'good'] } }), registry),
      error => error.kind === 'provider-failure' && error.mutated && error.attempts.length === 1);
    // Output that does not match the request schema is invalid output, which is
    // retryable: with no other provider left, the attempt says what happened.
    await assert.rejects(runProviderRequest(request, mergeProviderConfig({ project: { provider: 'wrong' } }), registry),
      error => error.kind === 'unavailable' && error.attempts.map(a => a.outcome).join() === 'invalid-output');
    // A validator's own complaint travels the same way, with its diagnostic.
    await assert.rejects(runProviderRequest(request, mergeProviderConfig({ project: { provider: 'good' } }), registry,
      { validate: () => 'the verdict is not one of ours' }),
      error => error.kind === 'unavailable' && error.detail === 'the verdict is not one of ours');
  });
});

test('a timeout kills the executable and is reported as a timeout', async () => {
  const slow = await script(`
    process.stdin.resume();
    setTimeout(() => process.stdout.write(JSON.stringify({ output: {} })), 5000);
  `, { name: 'slow-provider' });
  await withPath([slow.slice(0, slow.lastIndexOf('/'))], async () => {
    const registry = new ProviderRegistry();
    registry.register(commandProvider('slow', 'slow-provider', { caps: capabilities({}), timeoutSeconds: 0.3 }));
    clearProviderDiscoveryCache(registry);
    const started = Date.now();
    // A timeout is retryable, so with no other provider left the failure is that
    // nothing eligible remains, carrying the timeout it came from.
    await assert.rejects(runProviderRequest(providerRequest('review', 'structured'), mergeProviderConfig({ project: { provider: 'slow' } }), registry),
      error => error.kind === 'unavailable' && /timed out/.test(error.detail) && error.attempts.map(a => a.outcome).join() === 'timeout');
    assert.ok(Date.now() - started < 3000, 'the deadline is enforced, not waited out');
  });
});

test('only the allowed environment reaches the executable, and the default registry reads the config', async () => {
  const echo = await script(`
    process.stdin.resume();
    process.stdin.on('end', () => {
      process.stdout.write(JSON.stringify({ output: { seen: Object.keys(process.env).sort() } }));
    });
  `, { name: 'env-provider' });
  const dir = echo.slice(0, echo.lastIndexOf('/'));
  const original = environmentReader.get;
  environmentReader.get = name => ({ PATH: `${dir}:${process.env.PATH}`, HOME: '/tmp', SECRET_TOKEN: 'never', ALLOWED: 'yes' })[name];
  try {
    const registry = makeDefaultRegistry({ providers: { env: { command: 'env-provider', environment: ['ALLOWED'], capabilities: { efforts: ['low'] } } } });
    clearProviderDiscoveryCache(registry);
    const result = await runProviderRequest(providerRequest('review', 'structured'), mergeProviderConfig({ project: { provider: 'env' } }), registry);
    // Nothing else is inherited; the platform's own additions are ignored.
    assert.deepEqual(result.output.seen.filter(name => !name.startsWith('__')), ['ALLOWED', 'HOME', 'PATH']);
  } finally { environmentReader.get = original; }
});

test('the parallelism a provider advertises is respected, and the runner can be replaced', async () => {
  let live = 0, peak = 0;
  const original = runner.run;
  runner.run = async () => {
    live += 1; peak = Math.max(peak, live);
    await new Promise(resolve => setTimeout(resolve, 20));
    live -= 1;
    return { status: 0, stdout: JSON.stringify({ output: { ok: true } }), stderr: '' };
  };
  try {
    const registry = new ProviderRegistry();
    registry.register(commandProvider('twice', 'anything', { caps: capabilities({ maxParallel: 2 }) }));
    // Discovery also goes through the replaced runner's world, so stub it.
    const found = registry.get('twice');
    registry.register({ ...found, discover: async () => availability('ready') });
    clearProviderDiscoveryCache(registry);
    const config = mergeProviderConfig({ project: { provider: 'twice' } });
    const results = await Promise.all(Array.from({ length: 6 }, () => runProviderRequest(providerRequest('review', 'structured'), config, registry)));
    assert.equal(results.length, 6);
    assert.equal(peak, 2);
  } finally { runner.run = original; }
});

test('resolution discovers only the candidates it tries, stopping at the winner', async () => {
  const discovered = [];
  const registry = new ProviderRegistry();
  for (const [id, status] of [['slow-cli', 'ready'], ['http', 'ready'], ['offline', 'missing']]) {
    registry.register(provider({ id, caps: capabilities(), discover: async () => { discovered.push(id); return availability(status); }, run: async () => ({}) }));
  }
  const exact = await resolveProvider(providerRequest('review', 'structured', { target: targetSpec({ provider: 'http' }) }), mergeProviderConfig({}), registry);
  assert.equal(exact.target.provider.id, 'http');
  assert.deepEqual(discovered, ['http']);
  const preferred = await resolveProvider(providerRequest('review', 'structured'), mergeProviderConfig({ project: { preferences: ['offline', 'http', 'slow-cli'] } }), registry);
  assert.equal(preferred.target.provider.id, 'http');
  assert.deepEqual(preferred.rejections.map(r => [r.provider, r.kind]), [['offline', 'missing']]);
  assert.deepEqual(discovered, ['http', 'offline']);
});

test('only a ready discovery is remembered, so a later login is seen', async () => {
  let loggedIn = false, discoveries = 0;
  const registry = new ProviderRegistry();
  registry.register(provider({ id: 'cli', caps: capabilities(), discover: async () => { discoveries += 1; return availability(loggedIn ? 'ready' : 'unauthenticated'); }, run: async () => ({}) }));
  const request = providerRequest('review', 'structured', { target: targetSpec({ provider: 'cli' }) });
  await assert.rejects(resolveProvider(request, mergeProviderConfig({}), registry));
  loggedIn = true;
  assert.equal((await resolveProvider(request, mergeProviderConfig({}), registry)).target.provider.id, 'cli');
  await resolveProvider(request, mergeProviderConfig({}), registry);
  assert.equal(discoveries, 2);
});

test('the JSON Schema subset checks types, enums, closed objects and bounds', () => {
  assert.ok(jsonSchemaValid(null, { anything: true }));
  assert.ok(jsonSchemaValid({ type: 'object', required: ['a'], properties: { a: { type: 'integer' } } }, { a: 1 }));
  assert.ok(!jsonSchemaValid({ type: 'object', required: ['a'] }, {}));
  assert.ok(!jsonSchemaValid({ type: 'object', additionalProperties: false, properties: { a: {} } }, { a: 1, b: 2 }));
  assert.ok(!jsonSchemaValid({ type: 'integer' }, 1.5));
  assert.ok(jsonSchemaValid({ enum: ['low', 'high'] }, 'high'));
  assert.ok(!jsonSchemaValid({ enum: ['low', 'high'] }, 'mid'));
  assert.ok(jsonSchemaValid({ oneOf: [{ type: 'string' }, { type: 'integer' }] }, 'x'));
  assert.ok(!jsonSchemaValid({ oneOf: [{ type: 'number' }, { type: 'integer' }] }, 3));
  assert.ok(!jsonSchemaValid({ type: 'array', items: { type: 'string' }, maxItems: 1 }, ['a', 'b']));
  assert.ok(!jsonSchemaValid({ type: 'string', minLength: 2 }, 'a'));
  assert.ok(!jsonSchemaValid({ type: 'number', maximum: 1 }, 2));
});
