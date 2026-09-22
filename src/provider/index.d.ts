import type { JSONValue } from '../index.js';

export interface Capabilities {
  modes: string[]; modalities: string[]; permissions: string[]; controls: string[];
  efforts: string[]; maxParallel: number;
}
export interface Availability { status: string; version: string | null; billing: string; detail: string | null }
export interface TargetSpec { provider: string | null; model: string | null; effort: string | null; fallback: (string | Partial<TargetSpec>)[] }
export interface ProviderRequest {
  operation: string; mode: string; role: string; kind: string | null; tier: string | null;
  modalities: string[]; permissions: string[]; prompt: string; schema: JSONValue | null;
  images: string[]; directory: string | null; target: TargetSpec;
  limits: Record<string, JSONValue>; metadata: Record<string, JSONValue>;
}
export interface Provider {
  id: string; caps: Capabilities;
  discover(): Promise<Availability>;
  run(request: ProviderRequest, target: ResolvedTarget): Promise<ProviderResult>;
  modelCapabilities?: Record<string, Record<string, JSONValue>>;
}
export interface ResolvedTarget {
  provider: Provider; model: string | null; requestedEffort: string | null; effectiveEffort: string | null;
  sources: { provider?: string; model?: string; effort?: string };
}
export interface ProviderCost { mode: string; usd: number | null }
export interface ProviderAttempt { target: ResolvedTarget; outcome: string; usage: JSONValue; cost: ProviderCost; requestId: string | null; diagnostic: string | null }
export interface ProviderResult {
  output: JSONValue; target: ResolvedTarget; model: string | null; usage: Record<string, JSONValue>;
  cost: ProviderCost; requestId: string | null; exitStatus: number | null; changed: string[]; attempts: ProviderAttempt[];
}
export interface Rejection { provider: string; kind: string; detail: string | null }
export interface Resolution { target: ResolvedTarget; rejections: Rejection[]; matchedRoute: JSONValue | null }
export class ProviderError extends Error {
  kind: string; target: ResolvedTarget | null; retryable: boolean; mutated: boolean;
  usage: JSONValue; cost: ProviderCost; status: number | null; detail: unknown; attempts: ProviderAttempt[];
}
export class ProviderRegistry {
  register(value: Provider): Provider;
  get(id: string, fallback?: Provider | null): Provider | null;
  providers(): Provider[];
  overlay(values: Provider[], options?: { prepend?: boolean }): ProviderRegistry;
  withSlot<T>(value: Provider, thunk: () => Promise<T>): Promise<T>;
}
export function capabilities(settings?: Partial<Capabilities> & { maxParallel?: number }): Capabilities;
export function availability(status: string, settings?: { version?: string | null; billing?: string; detail?: string | null }): Availability;
export function targetSpec(settings?: Partial<TargetSpec>): TargetSpec;
export function providerRequest(operation: string, mode: string, settings?: Partial<Omit<ProviderRequest, 'operation' | 'mode'>>): ProviderRequest;
export function provider(definition: { id: string; caps: Capabilities; discover: Provider['discover']; run: Provider['run']; modelCapabilities?: Provider['modelCapabilities'] }): Provider;
export function unreportedCost(): ProviderCost;
export function mergeProviderConfig(layers?: { defaults?: JSONValue; user?: JSONValue; project?: JSONValue; package?: JSONValue; environment?: JSONValue; request?: JSONValue; role?: string | null }): Record<string, JSONValue>;
export function loadProviderConfig(options?: { start?: string; defaults?: JSONValue; package?: JSONValue; request?: JSONValue; role?: string | null }): Record<string, JSONValue>;
export function configLayers(config: Record<string, JSONValue>): [string, Record<string, JSONValue>][];
export function findProjectConfig(start: string): string | null;
export const environmentReader: { get(name: string): string | undefined };
export const layerOrder: readonly string[];
export function userConfigPath(): string;
export const projectConfigName: string;
export function resolveProvider(request: ProviderRequest, config: Record<string, JSONValue>, registry: ProviderRegistry, options?: { refresh?: boolean; exclude?: ResolvedTarget[] }): Promise<Resolution>;
export function discoverProviders(registry: ProviderRegistry, options?: { refresh?: boolean }): Promise<{ provider: Provider; availability: Availability }[]>;
export function clearProviderDiscoveryCache(registry?: ProviderRegistry | null): void;
export function capable(caps: Capabilities, request: ProviderRequest): boolean;
export function routeSpecificity(route: { when?: Record<string, JSONValue> }): number;
export function matchingProviderRoute(config: Record<string, JSONValue>, request: ProviderRequest): JSONValue | null;
export function runProviderRequest(request: ProviderRequest, config: Record<string, JSONValue>, registry: ProviderRegistry, options?: { validate?: (output: JSONValue) => string | null; observe?: (result: ProviderResult) => void }): Promise<ProviderResult>;
export function commandProvider(id: string, command: string | string[], options: { caps: Capabilities; environment?: string[]; timeoutSeconds?: number }): Provider;
export function makeDefaultRegistry(config?: Record<string, JSONValue>): ProviderRegistry;
export function findExecutable(name: string): string | null;
export const runner: { run(executable: string, args: string[], options?: { stdin?: string; timeoutSeconds?: number; dir?: string | null; env?: Record<string, string> | null; onLine?: ((line: string) => void) | null }): Promise<{ status: number | null; stdout: string; stderr: string }> };
export function runProgram(executable: string, args: string[], options?: Parameters<typeof runner.run>[2]): ReturnType<typeof runner.run>;
export function subprocessRunner(executable: string, args: string[], options?: Parameters<typeof runner.run>[2]): ReturnType<typeof runner.run>;
export function jsonSchemaValid(schema: JSONValue | null, value: JSONValue): boolean;
export function validateJsonSchema(schema: JSONValue | null, value: JSONValue): JSONValue;

// The bundled CLI adapters. Each runner builds that CLI's command line and maps
// its output onto a ProviderResult, or throws a ProviderError.
export type CliRunner = (executable: string, request: ProviderRequest, target: ResolvedTarget, availability?: Availability | { billing?: string } | null) => Promise<ProviderResult>;
export function claudeProvider(): Provider;
export const claudeCliRunner: CliRunner;
export function lastStructuredCall(transcript: string): JSONValue | null;
export function codexProvider(): Provider;
export const codexCliRunner: CliRunner;
export function codexOutputSchema(schema: JSONValue): JSONValue;
export function restoreOptionalFields(value: JSONValue, schema: JSONValue): JSONValue;
export function catalogToSettings(text: string): Record<string, { efforts: string[]; default_effort?: string | null; modalities?: string[] }> | null;
export function fxProvider(): Provider;
export const fxCliRunner: CliRunner;
export function layaProvider(options?: { command?: string | string[]; maxParallel?: number; timeoutSeconds?: number; environment?: string[] }): Provider;
