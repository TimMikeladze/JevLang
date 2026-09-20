import type { CompiledPolicy, Decision, JSONValue } from './index.js';
import type { Dispatcher, Handler } from './dispatch.js';

export type Secret = string | Uint8Array | { envSecret: string };
export interface VerifierResult { ok: boolean; deliveryId: string | null; reason: string | null }
export interface Verifier { (headers: Record<string, string> | [string, string][], body: string | Uint8Array, now: number): VerifierResult; kind: string; secret: Secret }
export function envSecret(name: string): { envSecret: string };
export function resolveSecret(secret: Secret): { secret: string | Uint8Array | null; problem: string | null };
export function standardWebhooksKey(secret: string | Uint8Array): Uint8Array | null;
export function standardWebhooksSign(secret: Secret, id: string, timestamp: string | number, body: string | Uint8Array): string;
export function standardWebhooksVerifier(secret: Secret, options?: { tolerance?: number }): Verifier;
export function githubVerifier(secret: Secret): Verifier;
export function stripeVerifier(secret: Secret, options?: { tolerance?: number }): Verifier;
export function slackVerifier(secret: Secret, options?: { tolerance?: number }): Verifier;
export function hmacVerifier(secret: Secret, options: { header: string; encoding?: 'hex' | 'base64'; prefix?: string; idHeader?: string | null }): Verifier;
export function verifierProblem(verifier: Verifier | unknown): string | null;
export function headerRef(headers: Record<string, string> | [string, string][], name: string): string | null;
export function keyToMessageId(key: string): string;
export function redactUrl(url: string): string;
export function webhookHandler(url: string, options: {
  secret: Secret; attempts?: number; timeoutSeconds?: number; includeState?: boolean; backoff?: number;
  type?: string; sleep?: (seconds: number) => Promise<void>; now?: () => number;
}): Handler;
export function webhookHandlerFromSpec(spec: Record<string, JSONValue>): Handler;
export interface CaseEvent { kind: 'case'; id: string | null; input: JSONValue }
export interface OutcomeEvent { kind: 'outcome'; id: string; outcomeKind: string | null; label: JSONValue; labels: JSONValue }
export interface WebhookSource {
  name: string; verify: Verifier | 'none' | null;
  event: (json: JSONValue, headers: Record<string, string>) => CaseEvent | OutcomeEvent | (CaseEvent | OutcomeEvent)[] | null | Promise<CaseEvent | OutcomeEvent | (CaseEvent | OutcomeEvent)[] | null>;
  sync: ((json: JSONValue, headers: Record<string, string>) => JSONValue | null) | null;
  insecure: boolean;
}
export function webhookSource(name: string, options: Partial<Omit<WebhookSource, 'name'>> & { event: WebhookSource['event'] }): WebhookSource;
export function caseEvent(id: string | number | null, input: JSONValue): CaseEvent;
export function outcomeEvent(id: string | number, options?: { kind?: string | null; label?: JSONValue; labels?: JSONValue }): OutcomeEvent;
export function isCaseEvent(value: unknown): value is CaseEvent;
export function isOutcomeEvent(value: unknown): value is OutcomeEvent;

export interface Label { action: string; target?: string }
export interface HarvestResult { caseId: string; where: 'pending' | 'labeled' | 'unlabeled' | null; label: Label | null; strength: 'strong' | 'weak' | null; source: string | null; path: string | null; status: 'added' | 'updated' | 'settled' | 'unknown' }
export function safeCaseName(id: string | number): string;
export function normalizeLabel(value: JSONValue): Label;
export function parseLabelSpec(text: string): Label;
export function labelToString(label: Label): string;
export function escalationDecision(decision: Decision): boolean;
export function escalatedDecision(decision: Decision): boolean;
export function deriveLabel(record: Record<string, JSONValue>): { where: string; label: Label | null; strength: string | null; source: string | null };
export function parseIso8601(text: string): number | null;
export function harvestDirs(dir: string): string[];
export function harvestFind(dir: string, id: string | number): Promise<{ where: string | null; record: Record<string, JSONValue> | null; path: string | null }>;
export function harvestAdd(dir: string, options: { caseId: string | number; fixture: JSONValue; decision: Decision; source?: string | null; now?: () => number }): Promise<HarvestResult>;
export function harvestOutcome(dir: string, id: string | number, kind: 'correction' | 'close', options?: { label?: JSONValue; labels?: JSONValue; now?: () => number }): Promise<HarvestResult>;
export function harvestSettle(dir: string, options?: { after?: number; now?: () => number; dryRun?: boolean }): Promise<{ settled: HarvestResult[]; skipped: string[] }>;
export function harvestStatus(dir: string, options?: { after?: number; now?: () => number }): Promise<Record<string, JSONValue>>;

export interface DecidedCase { decision: Decision; state?: JSONValue; facts?: Record<string, JSONValue> | null; questions?: JSONValue; answers?: JSONValue; fixture?: JSONValue }
export interface Wiring {
  spool: string; sources: WebhookSource[]; dispatcher: Dispatcher | null;
  evaluate: (input: JSONValue) => Promise<DecidedCase>; recordDir: string | null; harvest: string | null;
  settleAfterDays: number; shadow: CompiledPolicy | null; shadowEvaluate: ((input: JSONValue) => Promise<Decision>) | null;
  shadowLog: string | null; dispatchLog: string | null; workers: number;
}
export function jevWiring(options: Partial<Wiring> & { spool: string; sources: WebhookSource[]; evaluate: Wiring['evaluate'] }): Wiring;
export function wiringProblems(wiring: Wiring): string[];
export interface WiringRuntime {
  accept(path: string, headers: Record<string, string>, body: string | Uint8Array): Promise<{ status: number; body: JSONValue | null }>;
  routes: Record<string, WiringRuntime['accept']>;
  dispatcher: Dispatcher | null; summary: string[]; lines: string[]; stats: Record<string, number>;
  drain(): Promise<void>; stop(): Promise<void>; maintain(): Promise<void>;
}
export function startWiring(wiring: Wiring, policy: CompiledPolicy, options?: { now?: () => number; log?: { write(text: string): unknown } | null; startWorkers?: boolean }): Promise<WiringRuntime>;
