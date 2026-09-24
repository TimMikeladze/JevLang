import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeFile, readFile, mkdtemp, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateWithProvider, typesafeProvider, sharedPolicyRegistry } from '../src/evaluate.js';
import { settings as client } from '../src/client.js';
import { ProviderRegistry, mergeProviderConfig, clearProviderDiscoveryCache } from '../src/provider/index.js';
import { noul, definePolicy, rule, assign, hold } from '../src/index.js';
import { policy as ticket } from '../examples/ticket-router.js';

const answers = {
  department: { type: 'choice', choice: 'billing', confidence: 0.93 },
  frustration: { type: 'score', score: 0, confidence: 0.9 },
  'refund-requested?': { type: 'noul', noul: 0.2 },
};
const restore = () => {
  client.transport = null; client.onUsage = null;
  client.sleep = seconds => new Promise(r => setTimeout(r, Math.min(seconds, 0.01) * 1000));
  client.environment = name => ({ TYPESAFE_API_KEY: 'test-key' })[name];
};
const tick = ms => new Promise(r => setTimeout(r, ms));

test('an answer cache asks once per distinct row, and a failed call is asked again', async t => {
  restore();
  t.after(restore);
  const asked = [];
  let fail = false;
  client.transport = async request => {
    asked.push(request);
    await tick(20);
    if (fail) { fail = false; throw Object.assign(new Error('bad request'), { status: 400 }); }
    return { answers, model: 'jev-1.13.0', usage: { input_tokens: 10 } };
  };
  const registry = new ProviderRegistry();
  registry.register(typesafeProvider());
  clearProviderDiscoveryCache(registry);
  const config = mergeProviderConfig({ project: { provider: 'typesafe' } });
  const cache = new Map();
  const rows = ['refund please', 'my card failed', 'refund please', 'refund please', 'my card failed'];
  const decisions = await Promise.all(rows.map(text => evaluateWithProvider(ticket, { ticket: text }, { config, registry, cache })));
  assert.equal(asked.length, 2);
  assert.deepEqual(decisions.map(d => d.cached ?? false), [false, false, true, true, true]);
  assert.ok(decisions.every(d => d.target === 'billing-queue' && d.provider === 'typesafe'));

  fail = true;
  await assert.rejects(evaluateWithProvider(ticket, { ticket: 'new one' }, { config, registry, cache }));
  const retried = await evaluateWithProvider(ticket, { ticket: 'new one' }, { config, registry, cache });
  assert.equal(retried.cached, undefined);
  assert.equal(asked.length, 4);
});

test('calls without a registry share one per configuration, so max_parallel holds across them', async t => {
  restore();
  t.after(restore);
  let live = 0, peak = 0;
  client.transport = async () => {
    live += 1; peak = Math.max(peak, live);
    await tick(20);
    live -= 1;
    return { answers, model: 'jev-1.13.0' };
  };
  const config = mergeProviderConfig({ project: { provider: 'typesafe', providers: { typesafe: { max_parallel: 2 } } } });
  assert.equal(sharedPolicyRegistry(config), sharedPolicyRegistry(mergeProviderConfig({ project: { provider: 'typesafe', providers: { typesafe: { max_parallel: 2 } } } })));
  await Promise.all(Array.from({ length: 6 }, (_, i) => evaluateWithProvider(ticket, { ticket: `row ${i}` }, { config })));
  assert.equal(peak, 2);
  assert.throws(() => sharedPolicyRegistry(mergeProviderConfig({ project: { providers: { gateway: { max_parallel: 0 } } } })), /positive integer/);
});

test('jev batch writes one line per row in input order and asks once per distinct row', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jev-batch-'));
  const log = join(dir, 'calls.log');
  const fake = join(dir, 'fake-answerer');
  await writeFile(fake, `#!/usr/bin/env node
let input = '';
process.stdin.on('data', c => { input += c; });
process.stdin.on('end', () => {
  const request = JSON.parse(input);
  require('fs').appendFileSync(process.env.FAKE_LOG, 'call\\n');
  const spam = /buy now/i.test(request.prompt);
  setTimeout(() => process.stdout.write(JSON.stringify({ output: { 'spam?': { type: 'noul', noul: spam ? 0.97 : 0.03 } }, usage: { input_tokens: 7 } })), 30);
});
`);
  await chmod(fake, 0o755);
  await writeFile(log, '');
  const config = join(dir, 'jev.json');
  await writeFile(config, JSON.stringify({ provider: 'fake', providers: { fake: { command: fake, environment: ['FAKE_LOG'], capabilities: { max_parallel: 4 } } } }));
  const spam = noul('spam?', 'Is this message spam?');
  const policy = definePolicy({ name: 'spam', questions: [spam], state: { text: { path: ['text'] } }, route: { clauses: [rule(spam.yes(0.9), hold())], otherwise: assign('inbox') } });
  await writeFile(join(dir, 'policy.json'), JSON.stringify(policy.toJSON()));
  const texts = ['BUY NOW', 'lunch?', 'buy now!!', 'invoice'];
  await writeFile(join(dir, 'rows.ndjson'), texts.concat(texts, texts).map(text => JSON.stringify({ text })).join('\n') + '\n\n');

  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const run = spawnSync('node', [cli, 'batch', join(dir, 'policy.json'), join(dir, 'rows.ndjson'), '--workers', '8'], {
    encoding: 'utf8', env: { ...process.env, JEV_PROVIDER_CONFIG: config, FAKE_LOG: log },
  });
  assert.equal(run.status, 0, run.stderr);
  const lines = run.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(lines.map(l => l.row), [...Array(12).keys()]);
  assert.deepEqual(lines.slice(0, 4).map(l => l.decision.action), ['hold', 'assign', 'hold', 'assign']);
  assert.equal(lines.filter(l => l.decision.cached).length, 8);
  assert.equal((await readFile(log, 'utf8')).trim().split('\n').length, 4);
  assert.match(run.stderr, /runs at most 4 calls at once/);
  assert.match(run.stderr, /12 rows, 0 failed, 8 cached, 28 input tokens/);

  // A row that cannot be asked is an error line, and the exit code says so.
  const failed = spawnSync('node', [cli, 'batch', join(dir, 'policy.json'), '-', '--provider', 'nope'], {
    encoding: 'utf8', input: '{"text":"hi"}\n', env: { ...process.env, JEV_PROVIDER_CONFIG: config },
  });
  assert.equal(failed.status, 1);
  assert.match(JSON.parse(failed.stdout).error.message, /no eligible provider/);
});
