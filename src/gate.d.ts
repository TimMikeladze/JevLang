import type { CompiledPolicy, Decision, JSONValue } from './index.js';
import type { McpClient } from './mcp-client.js';
import type { McpServer } from './mcp.js';

export type Verdict = 'allow' | 'deny' | 'ask';
export interface GateState {
  tool: string; arguments: JSONValue; source: string;
  server: string | null; annotations: Record<string, JSONValue> | null;
}
export interface GateVerdict { verdict: Verdict; reason: string; by: 'deny-list' | 'allow-list' | 'policy' | 'error' | 'person'; decision: Decision | null }
export interface Gate {
  policy: CompiledPolicy; evaluate: (state: GateState) => Promise<Decision> | Decision;
  allow: string[]; deny: string[]; onError: 'ask' | 'deny'; log: string | null;
  label: string; policyHash: string | null;
}
export function makeGate(policy: CompiledPolicy, options: {
  evaluate: Gate['evaluate']; allow?: string[]; deny?: string[]; onError?: 'ask' | 'deny';
  log?: string | null; onCapture?: ((state: GateState, decision: Decision) => unknown) | null;
  label?: string | null; policyHash?: string | null;
}): Gate;
export function gateCheck(gate: Gate, state: GateState): Promise<GateVerdict>;
export function gateState(tool: string, args: JSONValue, options: { source: string; server?: string | null; annotations?: Record<string, JSONValue> | null }): GateState;
export function decisionToVerdict(decision: Decision): { verdict: Verdict; reason: string };
export function parseToolList(value: string): string[];
export function toolMatches(patterns: string[], tool: string): boolean;
export function callDigest(tool: string, args: JSONValue): string;
export function signRequestState(key: Uint8Array | string, payload: Record<string, JSONValue>): string;
export function verifyRequestState(key: Uint8Array | string, state: string, tool: string, args: JSONValue, now: number): Record<string, JSONValue>;
export function gateProxyServer(gate: Gate, upstream: McpClient, options?: { stateKey?: Uint8Array; stateTtl?: number; clock?: () => number }): McpServer;
export const approvalKey: string;
export function mcpServerOfTool(name: string): string | null;
export function detectHookHost(input: unknown): 'claude' | 'codex';
export interface HookEvent { host: 'claude' | 'codex'; event: string | null; tool: string; input: JSONValue; cwd: string; annotations: Record<string, JSONValue> | null }
export function normalizeHookEvent(input: Record<string, JSONValue>, options?: { host?: 'auto' | 'claude' | 'codex' }): HookEvent;
export function callFingerprint(input: Record<string, JSONValue>, policyHash: string | null): string;
export const approvalSettings: { directory: string | null; ttlSeconds: number };
export function approveOnce(fingerprint: string, options?: { now?: number; cwd?: string }): Promise<string>;
export function approvedOnce(fingerprint: string, options?: { now?: number; cwd?: string }): Promise<boolean>;
export function hookOutput(verdict: Verdict, reason: string, options?: { host?: 'claude' | 'codex' }): JSONValue;
export function hookVerdictToResponse(verdict: string, input: Record<string, JSONValue>, policyHash: string | null, options?: { now?: number }): Promise<Verdict>;
export function hookResponse(input: unknown, loadGate: () => Gate | Promise<Gate>, options?: { onError?: 'ask' | 'deny'; host?: 'auto' | 'claude' | 'codex'; now?: number }): Promise<JSONValue | null>;
export function explainDecision(decision: Decision): string;
