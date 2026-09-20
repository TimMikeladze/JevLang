import type { CompiledPolicy, JSONValue, ParameterType, ActionSchema } from './index.js';
import type { Handler } from './dispatch.js';

export interface McpClient {
  source: string; kind: 'stdio' | 'http'; era: 'modern' | 'legacy' | null; version: string | null;
  serverInfo: Record<string, JSONValue> | null; capabilities: Record<string, JSONValue>;
  instructions: string | null; tools: Map<string, Record<string, JSONValue>>; timeoutSeconds: number;
}
export class McpClientError extends Error { kind: 'connection' | 'timeout' | 'auth' | 'response'; status: number | null }
export function mcpConnect(target: string | string[], options?: {
  headers?: string[]; timeoutSeconds?: number; probeTimeoutSeconds?: number;
  onElicit?: ((params: Record<string, JSONValue>) => Promise<Record<string, JSONValue>> | Record<string, JSONValue>) | null;
  stderr?: 'inherit' | 'ignore' | { write(chunk: string): unknown };
}): Promise<McpClient>;
export function mcpRequest(client: McpClient, method: string, params?: Record<string, JSONValue>, options?: { timeoutSeconds?: number; headers?: string[] }): Promise<Record<string, JSONValue>>;
export function mcpNotify(client: McpClient, method: string, params?: Record<string, JSONValue>): Promise<void> | void;
export function mcpListTools(client: McpClient): Promise<Record<string, JSONValue>[]>;
export function mcpCallTool(client: McpClient, name: string, args?: Record<string, JSONValue>, options?: { inputResponses?: Record<string, JSONValue> | null; requestState?: string | null; timeoutSeconds?: number }): Promise<Record<string, JSONValue>>;
export function mcpClose(client: McpClient, options?: { force?: boolean }): Promise<void>;
export function mcpResultText(result: unknown): string;
export function mcpToolHandler(client: McpClient, tool: string, options?: { timeoutSeconds?: number }): Handler;
export function mcpHandlers(client: McpClient, options?: { only?: string[] | null; policy?: CompiledPolicy | null; timeoutSeconds?: number }): Promise<Record<string, Handler>>;
export function paramHeadersProblem(schema: JSONValue): string | null;

export interface McpSnapshot {
  source: string; serverInfo: Record<string, JSONValue> | null; protocolVersion: string | null;
  era: string; captured_at: string; tools: Record<string, JSONValue>[];
}
export interface DriftItem { kind: 'missing' | 'new' | 'schema' | 'annotations' | 'description'; tool: string; detail: string }
export function mcpImportSnapshot(client: McpClient, options?: { source?: string }): Promise<McpSnapshot>;
export function readMcpSnapshot(path: string): Promise<McpSnapshot>;
export function toolToAction(tool: Record<string, JSONValue>): { name: string; action: ActionSchema } | { warning: string };
export function toolConfirm(tool: Record<string, JSONValue>): boolean;
export function jsonSchemaToParameter(property: JSONValue, required: boolean): ParameterType;
export function snapshotToActions(snapshot: McpSnapshot): { actions: Record<string, ActionSchema>; warnings: string[] };
export function formatActionsModule(snapshot: McpSnapshot, imported: { actions: Record<string, ActionSchema>; warnings: string[] }, snapshotName: string): string;
export function writeMcpImport(snapshot: McpSnapshot, jsonPath: string): Promise<{ modulePath: string; actions: Record<string, ActionSchema>; warnings: string[] }>;
export function snapshotDrift(oldTools: Record<string, JSONValue>[], newTools: Record<string, JSONValue>[]): { drift: DriftItem[]; notes: DriftItem[] };
