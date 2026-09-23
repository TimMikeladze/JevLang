import type { CompiledPolicy, Decision, JSONValue } from './index.js';
import type { Journal } from './journal.js';

export type Handler = (state: JSONValue, decision: Decision, context: { key: string | null; path: string; principal: JSONValue }) => unknown;
export type OutcomeStatus = 'ran' | 'passed' | 'declined' | 'dry-run' | 'guard-failed' | 'cooldown' | 'error'
  | 'not-run' | 'forbidden' | 'over-budget' | 'duplicate' | 'uncertain' | 'scheduled' | 'rolled-back';
export interface Outcome {
  initial: Decision; final: Decision; handler: string | null; result: unknown;
  chain: [string, Decision][]; link: { key: string | null; index: number; name: string } | null;
  status: OutcomeStatus; steps: Outcome[];
}
export interface Budget { name: string; max: number; per: number; amount: (decision: Decision) => number; only: string[] | null; by: ((decision: Decision) => string) | null }
export interface Dispatcher {
  table: Record<string, Handler>; default: Handler | null; confirm: Handler | null; maxHops: number;
  known: string[]; policy: CompiledPolicy | null; schemas: Record<string, JSONValue>;
  guards: Record<string, Handler>; dryRun: boolean; planFailure: 'stop' | 'continue' | 'rollback';
  journal: Journal; budgets: Budget[]; targets(): string[];
}
export class DispatchError extends Error { kind: string; key: string | null; seconds: number | null }
export function makeDispatcher(handlers: Record<string, Handler>, options?: {
  policy?: CompiledPolicy | null; policyTargets?: string[] | null; actions?: Record<string, JSONValue> | null;
  default?: Handler | null; allowExtra?: boolean; computedTargets?: boolean | 'unset';
  confirm?: Handler | null; maxHops?: number; guards?: Record<string, Handler>; dryRun?: boolean;
  planFailure?: 'stop' | 'continue' | 'rollback'; clock?: () => number;
  roles?: (principal: JSONValue) => string[]; allow?: Record<string, string[]>; timeout?: number | null;
  journal?: Journal | null; budgets?: Budget[]; onScheduled?: ((key: string, outcome: Outcome | Error) => void) | null;
  autoRunDue?: boolean; stepLease?: number | null; scheduleLease?: number | null;
}): Dispatcher;
export function budget(name: string, options: { max: number; per: number; amount?: (decision: Decision) => number; only?: string[] | null; by?: ((decision: Decision) => string) | null }): Budget;
export function rateLimit(journal: Journal, name: string, options: { max: number; per: number; clock?: () => number }): (key?: string) => Promise<{ ok: boolean }>;
export function handlerChain(...links: Handler[]): Handler;
export function isHandlerChain(value: unknown): boolean;
export function retry(proc: Handler, options?: { attempts?: number; backoff?: number; sleep?: (seconds: number) => Promise<void> }): Handler;
export function isRetry(value: unknown): boolean;
export function actHandler(proc: (params: Record<string, JSONValue> & { idempotencyKey: string | null }, state: JSONValue, decision: Decision) => unknown): Handler;
export function handlerFor(dispatcher: Dispatcher, target: string): Handler | null;
export function dispatch(dispatcher: Dispatcher, state: JSONValue, decision: Decision, options?: { principal?: JSONValue; key?: string | null; facts?: Record<string, JSONValue> | null }): Promise<Outcome>;
export function dispatchForInput(dispatcher: Dispatcher, input: JSONValue, decision: Decision, options?: { rawState?: boolean; principal?: JSONValue; key?: string | null }): Promise<Outcome>;
export function resolve(evaluate: (input: JSONValue) => Promise<Decision> | Decision, dispatcher: Dispatcher, input: JSONValue, options?: { rawState?: boolean; principal?: JSONValue; key?: string | null }): Promise<Outcome>;
export function runDue(dispatcher: Dispatcher): Promise<number>;
export function cancelScheduled(dispatcher: Dispatcher, key: string): Promise<boolean> | boolean;
export function stopScheduler(dispatcher: Dispatcher): void;
export function outcomeToJson(outcome: Outcome): Record<string, JSONValue>;
export function outcomeDeclined(outcome: Outcome): boolean;
export function outcomeFailedSteps(outcome: Outcome): Outcome[];
export function policyTargetsOf(spec: JSONValue): string[];
