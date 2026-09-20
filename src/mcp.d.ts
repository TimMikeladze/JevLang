import type { CompiledPolicy, Decision, JSONValue } from './index.js';

export interface McpCall {
  era: 'modern' | 'legacy'; version: string | null; capabilities: Record<string, JSONValue>;
  clientInfo: Record<string, JSONValue> | null;
  elicit: ((message: string, schema: JSONValue) => Promise<Record<string, JSONValue> | null>) | null;
  inputResponses: Record<string, JSONValue> | null; requestState: string | null;
  params: Record<string, JSONValue>;
}
export interface McpTool {
  name: string; title: string | null; description: string | null; inputSchema: JSONValue;
  annotations: Record<string, JSONValue> | null; meta: Record<string, JSONValue> | null;
  run(args: Record<string, JSONValue>, call: McpCall): Promise<Record<string, JSONValue>> | Record<string, JSONValue>;
}
export interface McpResource { uri: string; name: string; description: string | null; mimeType: string | null; read(): Promise<string> | string }
export interface McpServer {
  info: { name: string; version: string; title?: string }; instructions: string | null;
  tools: McpTool[]; resources: McpResource[]; capabilities: Record<string, JSONValue>;
  methods: Record<string, (params: Record<string, JSONValue>, call: McpCall) => unknown>;
  fallback: ((method: string, params: Record<string, JSONValue>, call: McpCall) => unknown) | null;
  ttlMs: number; cacheScope: 'public' | 'private';
}
export interface McpConn { era: 'legacy' | null; version: string | null; capabilities: Record<string, JSONValue>; clientInfo: Record<string, JSONValue> | null; sendRequest: ((method: string, params: JSONValue) => Promise<Record<string, JSONValue> | null>) | null }
export class McpError extends Error { code: number; data: JSONValue | undefined }
export const modernVersion: string;
export const modernVersions: readonly string[];
export const legacyVersions: readonly string[];
export const supportedVersions: readonly string[];
export const metaProtocolVersion: string;
export const metaClientCapabilities: string;
export const metaClientInfo: string;
export const metaServerInfo: string;
export const mcpErrorCodes: Record<string, number>;
export function raiseMcp(code: string | number, message: string, data?: JSONValue): never;
export function jsonrpcError(id: string | number | null, code: number, message: string, data?: JSONValue): JSONValue;
export function mcpTool(definition: Partial<McpTool> & { name: string; inputSchema: JSONValue; run: McpTool['run'] }): McpTool;
export function mcpResource(definition: Partial<McpResource> & { uri: string; name: string; read: McpResource['read'] }): McpResource;
export function makeMcpServer(options: { name: string; version?: string; title?: string | null; instructions?: string | null; tools?: McpTool[]; resources?: McpResource[]; methods?: McpServer['methods']; fallback?: McpServer['fallback']; capabilities?: Record<string, JSONValue> | null; ttlMs?: number; cacheScope?: 'public' | 'private' }): McpServer;
export function makeMcpConn(options?: { sendRequest?: McpConn['sendRequest']; legacyVersion?: string | null }): McpConn;
export function handleMessage(server: McpServer, message: unknown, conn: McpConn): Promise<JSONValue | null>;
export function toolToJson(tool: McpTool): JSONValue;
export function mcpTextResult(text: string, options?: { structured?: JSONValue; error?: boolean }): Record<string, JSONValue>;
export function mcpToolError(text: string): Record<string, JSONValue>;
export function mcpInputRequired(requests: JSONValue, options?: { state?: string | null }): Record<string, JSONValue>;
export function inputRequired(result: unknown): boolean;
export function httpHandle(server: McpServer, headers: Record<string, string>, body: string | Uint8Array, options?: { origins?: string[] }): Promise<{ status: number; body: JSONValue | null; headers: Record<string, string> }>;
export function serveStdio(server: McpServer, options?: { input?: unknown; output?: { write(chunk: string): unknown }; elicitTimeoutSeconds?: number }): Promise<void>;
export function originAllowed(origin: string | null, allowed?: string[]): boolean;
export function envOrigins(value?: string): string[];
export function encodeHeaderValue(value: string): string;
export function decodeHeaderValue(value: string): string | null;
export function policyMcpServer(policy: CompiledPolicy, options?: { allowEvaluate?: boolean; maxCalls?: number; name?: string | null; evaluate?: ((state: JSONValue) => Promise<Decision> | Decision) | null }): McpServer;
export function policyToJson(policy: CompiledPolicy): JSONValue;
