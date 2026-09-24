import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeProvider, lastStructuredCall, codexProvider, codexOutputSchema, restoreOptionalFields, catalogToSettings, fxProvider, targetSpec, runner, makeDefaultRegistry } from '../src/provider/index.js';

test("Claude's stream transcript gives up its last structured call", () => {
  const transcript = [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'thinking' }] } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'StructuredOutput', input: { verdict: 'first' } }] } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'StructuredOutput', input: { verdict: 'last' } }] } }),
    JSON.stringify({ type: 'result', structured_output: { verdict: 'last' } }),
  ].join('\n');
  assert.deepEqual(lastStructuredCall(transcript), { verdict: 'last' });
  // A model that writes the block as text is read too: JSON, parameters, or tags.
  const asJson = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '<StructuredOutput>{"verdict": "ok"}</StructuredOutput>' }] } });
  assert.deepEqual(lastStructuredCall(asJson), { verdict: 'ok' });
  const asParameters = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '<StructuredOutput><parameter name="verdict">ok</parameter></StructuredOutput>' }] } });
  assert.deepEqual(lastStructuredCall(asParameters), { verdict: 'ok' });
  const asTags = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '<StructuredOutput><verdict>ok</verdict></StructuredOutput>' }] } });
  assert.deepEqual(lastStructuredCall(asTags), { verdict: 'ok' });
  assert.equal(lastStructuredCall('no structured output here'), null);
});

test("Codex's strict schema is widened for it and narrowed again on the way back", () => {
  const schema = {
    type: 'object',
    properties: { verdict: { type: 'string' }, note: { type: 'string' }, count: { type: 'number' } },
    required: ['verdict'],
  };
  const strict = codexOutputSchema(schema);
  // Every property is required, and an optional one may be null.
  assert.deepEqual(strict.required.sort(), ['count', 'note', 'verdict']);
  assert.equal(strict.additionalProperties, false);
  assert.deepEqual(strict.properties.verdict, { type: 'string' });
  assert.deepEqual(strict.properties.note, { anyOf: [{ type: 'string' }, { type: 'null' }] });
  // And the nulls it sends back for those go again.
  assert.deepEqual(restoreOptionalFields({ verdict: 'ok', note: null, count: 2 }, schema), { verdict: 'ok', count: 2 });
  // A property that was allowed to be null keeps its null.
  const nullable = { type: 'object', properties: { note: { type: ['string', 'null'] } }, required: ['note'] };
  assert.deepEqual(restoreOptionalFields({ note: null }, nullable), { note: null });
  // A nested object and a list of them are treated the same way.
  const nested = {
    type: 'object',
    properties: { items: { type: 'array', items: { type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' } }, required: ['a'] } } },
    required: ['items'],
  };
  assert.deepEqual(restoreOptionalFields({ items: [{ a: 'x', b: null }] }, nested), { items: [{ a: 'x' }] });
  // The bundled catalog says which efforts and modalities a model takes.
  assert.deepEqual(catalogToSettings(JSON.stringify({
    models: [{ slug: 'gpt-6', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }], default_reasoning_level: 'high', input_modalities: ['text', 'image'] }],
  })), { 'gpt-6': { efforts: ['low', 'high'], default_effort: 'high', modalities: ['text', 'image'] } });
  assert.equal(catalogToSettings('not json'), null);
});

test('discovery reads each CLI, and says what is wrong when it cannot', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'jev-cli-'));
  const original = runner.run;
  t.after(() => { runner.run = original; });
  // A CLI that is not installed is missing, and nothing else is run.
  const { environmentReader } = await import('../src/provider/index.js');
  const originalEnv = environmentReader.get;
  environmentReader.get = name => (name === 'PATH' ? dir : originalEnv.call(environmentReader, name));
  t.after(() => { environmentReader.get = originalEnv; });
  assert.equal((await claudeProvider().discover()).status, 'missing');
  assert.equal((await codexProvider().discover()).status, 'missing');
  assert.equal((await fxProvider().discover()).status, 'missing');

  // With the CLIs on PATH, their own answers decide.
  await writeFile(join(dir, 'claude'), '');
  await writeFile(join(dir, 'codex'), '');
  await writeFile(join(dir, 'fx'), '');
  runner.run = async (executable, args) => {
    const command = `${executable.split('/').pop()} ${args.join(' ')}`;
    if (command.includes('claude --version')) return { status: 0, stdout: '1.2.3 (Claude Code)', stderr: '' };
    if (command.includes('claude auth status')) return { status: 0, stdout: JSON.stringify({ loggedIn: true, subscriptionType: 'max' }), stderr: '' };
    if (command.includes('codex --version')) return { status: 0, stdout: 'codex-cli 0.155.1', stderr: '' };
    if (command.includes('codex login status')) return { status: 0, stdout: 'Logged in using ChatGPT', stderr: '' };
    if (command.includes('codex debug models')) return { status: 0, stdout: JSON.stringify({ models: [{ slug: 'gpt-6', supported_reasoning_levels: [{ effort: 'xhigh' }] }] }), stderr: '' };
    if (command.includes('fx --version')) return { status: 0, stdout: 'fx 0.0.11', stderr: '' };
    if (command.includes('fx status')) return { status: 0, stdout: JSON.stringify({ kind: 'status', model: 'grok-4', auth: 'Grok subscription', permission_mode: 'auto' }), stderr: '' };
    if (command.includes('fx models')) return { status: 0, stdout: JSON.stringify({ kind: 'models', ids: ['grok-4'] }), stderr: '' };
    return { status: 1, stdout: '', stderr: 'unexpected' };
  };
  const claude = await claudeProvider().discover();
  assert.deepEqual([claude.status, claude.version, claude.billing], ['ready', '1.2.3', 'subscription']);
  const codex = codexProvider();
  const codexReady = await codex.discover();
  assert.deepEqual([codexReady.status, codexReady.version, codexReady.billing], ['ready', '0.155.1', 'subscription']);
  // The catalog it printed becomes the model's own capabilities.
  assert.deepEqual(codex.modelCapabilities['gpt-6'].efforts, ['xhigh']);
  const fx = fxProvider();
  const fxReady = await fx.discover();
  assert.deepEqual([fxReady.status, fxReady.version, fxReady.billing], ['ready', '0.0.11', 'subscription']);
  assert.deepEqual(Object.keys(fx.modelCapabilities), ['grok-4']);

  // A CLI that is installed but not logged in, and one that is too old.
  runner.run = async (executable, args) => {
    const command = `${executable.split('/').pop()} ${args.join(' ')}`;
    if (command.includes('--version')) return { status: 0, stdout: 'fx 0.0.9\nclaude 1.0.0\ncodex-cli 0.1.0', stderr: '' };
    if (command.includes('auth status')) return { status: 0, stdout: JSON.stringify({ loggedIn: false }), stderr: '' };
    if (command.includes('login status')) return { status: 1, stdout: 'Not logged in', stderr: '' };
    return { status: 1, stdout: '', stderr: '' };
  };
  assert.equal((await claudeProvider().discover()).status, 'unauthenticated');
  assert.equal((await codexProvider().discover()).status, 'unauthenticated');
  const old = await fxProvider().discover();
  assert.equal(old.status, 'unavailable');
  assert.match(old.detail, /0\.0\.10 or newer/);
});

test('the default registry carries the built-in adapters, and the configuration may replace them', () => {
  const plain = makeDefaultRegistry({});
  assert.deepEqual(plain.providers().map(p => p.id), ['claude', 'codex', 'fx', 'laya']);
  const configured = makeDefaultRegistry({
    providers: { claude: { command: '/opt/claude', max_parallel: 1 }, house: { command: 'house-agent' } },
  });
  assert.deepEqual(configured.providers().map(p => p.id), ['claude', 'codex', 'fx', 'laya', 'house']);
  assert.equal(configured.get('claude').caps.maxParallel, 1);
  assert.throws(() => makeDefaultRegistry({ providers: { codex: { command: 5 } } }), /must be a string/);
  assert.throws(() => makeDefaultRegistry({ providers: { fx: { max_parallel: 0 } } }), /positive integer/);
  assert.throws(() => makeDefaultRegistry({ providers: { laya: { timeout_seconds: 0 } } }), /positive number/);
});
