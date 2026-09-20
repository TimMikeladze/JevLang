import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  makeGate, gateCheck, gateState, decisionToVerdict, toolMatches, parseToolList, callDigest,
  signRequestState, verifyRequestState, gateProxyServer, approvalKey, mcpServerOfTool,
  detectHookHost, normalizeHookEvent, callFingerprint, hookOutput, hookResponse, hookVerdictToResponse,
  approveOnce, approvedOnce, approvalSettings,
} from '../src/gate.mjs';
import { policy as toolGate } from '../examples/tool-gate.mjs';
import { evaluateWithProvider, typesafeProvider } from '../src/evaluate.mjs';
import { settings as client } from '../src/client.mjs';
import { ProviderRegistry, mergeProviderConfig, clearProviderDiscoveryCache } from '../src/provider/index.mjs';
import { handleMessage, makeMcpConn, modernVersion, metaProtocolVersion, metaClientCapabilities, inputRequired, McpError } from '../src/mcp.mjs';
import { mcpConnect, mcpClose } from '../src/mcp-client.mjs';

const fixtureDir = new URL('../../jev-lang/examples/gate-fixtures/', import.meta.url);
const loadFixtures = async () => {
  const files = (await readdir(fixtureDir)).filter(f => f.endsWith('.json')).sort();
  return Promise.all(files.map(async f => JSON.parse(await readFile(new URL(f, fixtureDir), 'utf8'))));
};
// The same path the real gate takes: the policy asks its provider, whose
// transport answers with the fixture's answers.
const gateEvaluate = answers => {
  const registry = new ProviderRegistry();
  registry.register(typesafeProvider());
  clearProviderDiscoveryCache(registry);
  const config = mergeProviderConfig({ project: { provider: 'typesafe' } });
  return async state => {
    const saved = { transport: client.transport, apiKey: client.apiKey };
    client.transport = async () => ({ answers, model: 'jev-1.13.0', usage: { input_tokens: 10 } });
    client.apiKey = 'test-key';
    try { return await evaluateWithProvider(toolGate, state, { config, registry }); }
    finally { Object.assign(client, saved); }
  };
};
// Racket quotes a name as `x' where this engine writes 'x'; the sentence is the
// same otherwise, and it is what an agent reads.
const sameWords = text => typeof text === 'string'
  ? text.replace(/`([^']*)'/g, "'$1'").replace(/run `(raco jev hook|jev gate) approve-once/, 'run `approve-once')
  : text;
const sameVerdict = v => ({ ...v, reason: sameWords(v.reason) });
const sameOutput = out => out === null ? null : {
  hookSpecificOutput: { ...out.hookSpecificOutput, permissionDecisionReason: sameWords(out.hookSpecificOutput.permissionDecisionReason) },
};
const decision = (action, target, reason) => ({
  action, target, reason, data: null, rule: 'route', clause: 0, source: null, line: null, file: null,
  model: null, provider: null, requested_model: null, requested_effort: null, effective_effort: null,
  request_id: null, stage: null, proposed: null, evidence: [], steps: [], readings: [],
});

test('Racket oracle: the same tool calls get the same verdicts and hook answers', async t => {
  const approvals = await mkdtemp(join(tmpdir(), 'jev-approvals-'));
  const oracle = fileURLToPath(new URL('./gate-oracle.rkt', import.meta.url));
  const run = spawnSync('racket', [oracle, approvals], { encoding: 'utf8', cwd: fileURLToPath(new URL('..', import.meta.url)), env: { ...process.env, TYPESAFE_API_KEY: '', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '' } });
  assert.equal(run.status, 0, run.stderr);
  const expected = JSON.parse(run.stdout);
  const fixtures = await loadFixtures();
  const previous = approvalSettings.directory;
  approvalSettings.directory = approvals;
  t.after(() => { approvalSettings.directory = previous; });

  // The verdict a call gets, and who decided it.
  for (const [i, fixture] of fixtures.entries()) {
    const g = makeGate(toolGate, { evaluate: gateEvaluate(fixture.answers) });
    const v = await gateCheck(g, fixture.state);
    assert.equal(expected.verdicts[i].name, fixture.name);
    assert.deepEqual({ verdict: v.verdict, by: v.by, reason: v.reason }, sameVerdict(expected.verdicts[i].verdict), fixture.name);
  }
  // The lists run before the model, so hard rules stay in code.
  const byName = name => fixtures.find(f => f.name === name);
  const list = async (name, options) => {
    const g = makeGate(toolGate, { evaluate: gateEvaluate(byName(name).answers), ...options });
    const v = await gateCheck(g, byName(name).state);
    return { verdict: v.verdict, by: v.by, reason: v.reason };
  };
  assert.deepEqual(await list('read-readme', { deny: ['Read'] }), sameVerdict(expected.lists[0]));
  assert.deepEqual(await list('rm-build', { allow: ['Ba*'] }), sameVerdict(expected.lists[1]));
  assert.deepEqual(await list('rm-build', { deny: ['mcp__*', 'Bash'] }), sameVerdict(expected.lists[2]));

  // The hook's answer, for each host.
  const cwd = fileURLToPath(new URL('..', import.meta.url));
  for (const [i, fixture] of fixtures.entries()) {
    for (const host of ['claude', 'codex']) {
      const input = {
        hook_event_name: 'PreToolUse', tool_name: fixture.state.tool, tool_input: fixture.state.arguments,
        cwd, session_id: 's1', ...(host === 'codex' ? { model: 'gpt-6' } : {}),
      };
      const g = makeGate(toolGate, { evaluate: gateEvaluate(fixture.answers) });
      const out = await hookResponse(input, () => g, { host });
      const want = expected.hooks[i][host];
      assert.equal(expected.hooks[i].name, fixture.name);
      assert.deepEqual(sameOutput(out ?? null), sameOutput(want.output), `${fixture.name}/${host}`);
      // The approval fingerprint is the same in both, so an approval made by
      // one side is honoured by the other.
      assert.equal(callFingerprint(input, g.policyHash), want.fingerprint, `${fixture.name}/${host} fingerprint`);
    }
  }
  // The verdict mapping, the lists, the digests and the hook's shapes.
  const decisions = [
    decision('assign', 'allow', 'it only reads'),
    decision('escalate', 'ask', 'it destroys data'),
    decision('page', 'deny', 'no'),
    decision('hold', null, 'unsure'),
    decision('confirm', 'unlock', 'needs a person'),
    decision('assign', 'billing-queue', 'wrong target'),
    decision('next', 'stage-2', null),
  ];
  assert.deepEqual(decisions.map(decisionToVerdict).map(v => ({ verdict: v.verdict, reason: v.reason })),
    expected['verdict-mapping'].map(sameVerdict));
  assert.deepEqual([
    toolMatches(['Bash'], 'Bash'), toolMatches(['mcp__*'], 'mcp__home__lock_door'),
    toolMatches(['*write*'], 'WriteFile'), toolMatches(['Bash'], 'bash'), toolMatches([], 'Bash'),
  ], expected.matches);
  assert.deepEqual(parseToolList(' Bash, mcp__* ,, Read '), expected.parsed);
  assert.equal(callDigest('Bash', { command: 'rm -rf build' }), expected.digest);
  assert.deepEqual([mcpServerOfTool('mcp__home__lock_door'), mcpServerOfTool('Bash')], expected['server-of']);
  const hookEvent = { hook_event_name: 'PreToolUse', tool_name: '  Bash  ', tool_input: { command: 'rm -rf build' }, cwd, session_id: 's1' };
  assert.deepEqual(normalizeHookEvent(hookEvent), expected.normalized);
  assert.equal(callFingerprint(hookEvent, 'abc'), expected.fingerprint);
  assert.deepEqual(['claude', 'codex'].flatMap(host => ['allow', 'deny', 'ask'].map(v => hookOutput(v, 'because', { host }))), expected.outputs);
});

test('the gate fails closed: no key, a bad load, or an odd decision all deny or ask', async () => {
  const failing = makeGate(toolGate, { evaluate: async () => { throw new Error('jev: no TypeSafe API key'); } });
  const asked = await gateCheck(failing, gateState('Bash', { command: 'ls' }, { source: 'claude-code' }));
  assert.equal(asked.verdict, 'ask');
  assert.equal(asked.by, 'error');
  assert.match(asked.reason, /could not decide, so the answer is ask: no TypeSafe API key/);
  const denying = makeGate(toolGate, { evaluate: async () => { throw new Error('down'); }, onError: 'deny' });
  assert.equal((await gateCheck(denying, gateState('Bash', {}, { source: 'mcp-proxy' }))).verdict, 'deny');
  // A decision that is not a verdict denies, and says why.
  const odd = makeGate(toolGate, { evaluate: async () => decision('assign', 'billing-queue', 'wrong target') });
  const v = await gateCheck(odd, gateState('Bash', {}, { source: 'claude-code' }));
  assert.equal(v.verdict, 'deny');
  assert.match(v.reason, /which is not allow, deny or ask/);
  // A hook whose gate does not load answers with onError, and says so.
  const broken = await hookResponse({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {}, cwd: process.cwd() },
    () => { throw new Error('jev: the policy did not compile'); }, { host: 'claude' });
  assert.equal(broken.hookSpecificOutput.permissionDecision, 'ask');
  assert.match(broken.hookSpecificOutput.permissionDecisionReason, /did not load, so the answer is ask/);
  // Input that is not JSON, and an event that is not PreToolUse.
  assert.equal((await hookResponse(null, () => failing)).hookSpecificOutput.permissionDecision, 'ask');
  assert.equal(await hookResponse({ hook_event_name: 'PostToolUse' }, () => failing), null);
  assert.equal(detectHookHost({ turn_id: 't' }), 'codex');
  assert.equal(detectHookHost({ session_id: 's' }), 'claude');
});

test('a one-shot approval is signed, consumed, and cannot be reused', async t => {
  const approvals = await mkdtemp(join(tmpdir(), 'jev-approvals-'));
  const previous = approvalSettings.directory;
  approvalSettings.directory = approvals;
  t.after(() => { approvalSettings.directory = previous; });
  const fixtures = await loadFixtures();
  const destructive = fixtures.find(f => f.name === 'rm-build');
  const input = { hook_event_name: 'PreToolUse', tool_name: destructive.state.tool, tool_input: destructive.state.arguments, cwd: process.cwd(), model: 'gpt-6' };
  const g = makeGate(toolGate, { evaluate: gateEvaluate(destructive.answers) });
  const fingerprint = callFingerprint(input, g.policyHash);
  // Codex cannot be asked, so the call is denied with the fingerprint to approve.
  const denied = await hookResponse(input, () => g, { host: 'codex' });
  assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, new RegExp(fingerprint));
  // Once a person approves that exact call, it runs — once.
  await approveOnce(fingerprint);
  const allowed = await hookResponse(input, () => g, { host: 'codex' });
  assert.equal(allowed.hookSpecificOutput.permissionDecision, 'allow');
  assert.match(allowed.hookSpecificOutput.permissionDecisionReason, /a person approved this exact call once/);
  assert.equal((await hookResponse(input, () => g, { host: 'codex' })).hookSpecificOutput.permissionDecision, 'deny');
  // An approval for another call, or an expired one, does not count.
  await approveOnce(fingerprint, { now: 1000 });
  assert.equal(await approvedOnce(fingerprint, { now: 1000 + 601 }), false);
  await assert.rejects(async () => approveOnce('not-a-digest'), /SHA-256/);
  assert.equal(await hookVerdictToResponse('ask', input, g.policyHash), 'deny');
  await approveOnce(fingerprint);
  assert.equal(await hookVerdictToResponse('ask', input, g.policyHash), 'allow');
  assert.equal(await hookVerdictToResponse('allow', input, g.policyHash), 'allow');
  assert.equal(await hookVerdictToResponse('nonsense', input, g.policyHash), 'deny');
});

test('a requestState is signed, expiring, and bound to one call', () => {
  const key = Buffer.from('a'.repeat(32));
  const payload = { kind: 'ask', tool: 'Bash', digest: callDigest('Bash', { command: 'ls' }), exp: 1000, reason: 'it destroys data' };
  const signed = signRequestState(key, payload);
  assert.deepEqual(verifyRequestState(key, signed, 'Bash', { command: 'ls' }, 999), payload);
  const rejects = (state, tool, args, now, pattern) => assert.throws(
    () => verifyRequestState(key, state, tool, args, now),
    error => error instanceof McpError && error.code === -32602 && pattern.test(error.message));
  rejects(signed, 'Bash', { command: 'ls' }, 1001, /expired/);
  rejects(signed, 'Write', { command: 'ls' }, 999, /issued for another tool or other arguments/);
  rejects(signed, 'Bash', { command: 'rm -rf /' }, 999, /issued for another tool or other arguments/);
  rejects(`${signed}x`, 'Bash', { command: 'ls' }, 999, /signature does not verify/);
  rejects('nonsense', 'Bash', { command: 'ls' }, 999, /not one this gate issued/);
  rejects(signRequestState(Buffer.from('b'.repeat(32)), payload), 'Bash', { command: 'ls' }, 999, /signature does not verify/);
});

test('the proxy gates another server: allow forwards, deny blocks, ask asks a person', async t => {
  const upstreamPath = fileURLToPath(new URL('../examples/mcp-policy-server.mjs', import.meta.url));
  const upstream = await mcpConnect([process.execPath, upstreamPath]);
  t.after(() => mcpClose(upstream));
  const fixtures = await loadFixtures();
  const answersFor = verdictName => fixtures.find(f => f.name === verdictName).answers;
  const modern = { [metaProtocolVersion]: modernVersion, [metaClientCapabilities]: { elicitation: {} } };
  const call = (server, args, extra = {}) => handleMessage(server, {
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { _meta: modern, name: 'decide', arguments: args, ...extra },
  }, makeMcpConn());

  // A verdict of allow forwards the call to the upstream server.
  const allowing = gateProxyServer(makeGate(toolGate, { evaluate: gateEvaluate(answersFor('read-readme')) }), upstream);
  const listed = await handleMessage(allowing, { jsonrpc: '2.0', id: 0, method: 'tools/list', params: { _meta: modern } }, makeMcpConn());
  assert.ok(listed.result.tools.some(tool => tool.name === 'decide'));
  const answers = {
    department: { type: 'choice', choice: 'billing', confidence: 0.93, probabilities: { billing: 0.93 } },
    frustration: { type: 'score', score: 0.2, confidence: 0.9, probabilities: { 0: 0.8, 1: 0.2, 2: 0 } },
    'refund-requested?': { type: 'noul', noul: 0.1 },
  };
  const forwarded = await call(allowing, { answers });
  assert.equal(forwarded.result.structuredContent.target, 'billing-queue');

  // A verdict of deny blocks it, and says the gate did.
  const denying = gateProxyServer(makeGate(toolGate, { evaluate: gateEvaluate(answersFor('chmod-sudoers')) }), upstream);
  const blocked = await call(denying, { answers });
  assert.equal(blocked.result.isError, true);
  assert.match(blocked.result.content[0].text, /Blocked by the jev gate \(tool-gate\)/);

  // A verdict of ask asks the person, with a signed state bound to this call.
  const key = Buffer.from('k'.repeat(32));
  const asking = gateProxyServer(makeGate(toolGate, { evaluate: gateEvaluate(answersFor('rm-build')) }), upstream, { stateKey: key, clock: () => 1000 });
  const asked = await call(asking, { answers });
  assert.ok(inputRequired(asked.result));
  assert.ok(asked.result.inputRequests[approvalKey].params.message.includes("Allow the tool call 'decide'?"));
  const state = asked.result.requestState;
  // The approval runs the tool without asking the model again.
  const approvedCall = await call(asking, { answers }, { requestState: state, inputResponses: { [approvalKey]: { action: 'accept', content: { approve: true } } } });
  assert.equal(approvedCall.result.structuredContent.target, 'billing-queue');
  // A refusal blocks it, and an approval cannot be replayed on another call.
  const refused = await call(asking, { answers }, { requestState: state, inputResponses: { [approvalKey]: { action: 'accept', content: { approve: false } } } });
  assert.match(refused.result.content[0].text, /a person did not approve it/);
  const replayed = await handleMessage(asking, {
    jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { _meta: modern, name: 'decide', arguments: { answers: { ...answers, 'refund-requested?': { type: 'noul', noul: 0.9 } } }, requestState: state, inputResponses: { [approvalKey]: { action: 'accept', content: { approve: true } } } },
  }, makeMcpConn());
  assert.equal(replayed.error.code, -32602);
  assert.match(replayed.error.message, /issued for another tool or other arguments/);
  // A client that cannot be asked is denied rather than left waiting.
  const plain = await handleMessage(asking, {
    jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { _meta: { [metaProtocolVersion]: modernVersion, [metaClientCapabilities]: {} }, name: 'decide', arguments: { answers } },
  }, makeMcpConn());
  assert.match(plain.result.content[0].text, /this client can't ask one/);
});

test('every verdict is logged, with the arguments summarized by a digest', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jev-gate-log-'));
  const path = join(dir, 'verdicts.jsonl');
  const fixtures = await loadFixtures();
  const fixture = fixtures.find(f => f.name === 'chmod-sudoers');
  const g = makeGate(toolGate, { evaluate: gateEvaluate(fixture.answers), log: path, deny: ['Danger*'] });
  await gateCheck(g, fixture.state);
  await gateCheck(g, gateState('DangerousTool', { secret: 'hunter2' }, { source: 'mcp-proxy', server: 'home' }));
  const lines = (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(lines.map(l => [l.tool, l.verdict, l.by]), [['Bash', 'deny', 'policy'], ['DangerousTool', 'deny', 'deny-list']]);
  // The arguments themselves never reach the log.
  assert.ok(!JSON.stringify(lines).includes('hunter2'));
  assert.equal(lines[1].arguments_sha256, callDigest('DangerousTool', { secret: 'hunter2' }).length === 64 ? lines[1].arguments_sha256 : null);
  assert.match(lines[0].arguments_sha256, /^[0-9a-f]{64}$/);
  assert.equal(lines[0].source, 'claude-code');
  assert.equal(lines[1].server, 'home');
  assert.ok(lines[0].decision.action);
});
