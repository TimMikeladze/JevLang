import test from 'node:test';
import assert from 'node:assert/strict';
import { makeGate, gateCheck, gateState, callDigest, signRequestState, verifyRequestState, detectHookHost, hookResponse } from '../src/gate.js';
import { policy as toolGate } from '../examples/tool-gate.js';
import { McpError } from '../src/mcp.js';

const decision = (action, target, reason) => ({
  action, target, reason, data: null, rule: 'route', clause: 0, source: null, line: null, file: null,
  model: null, provider: null, requested_model: null, requested_effort: null, effective_effort: null,
  request_id: null, stage: null, proposed: null, evidence: [], steps: [], readings: [],
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
