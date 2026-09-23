import type { JSONValue } from './index.js';

export interface StepResult { status: string; result: JSONValue }
export interface Journal {
  beginStep(key: string, target: string, now: number, staleAfter?: number | null): Promise<'new' | 'running' | StepResult> | 'new' | 'running' | StepResult;
  finishStep(key: string, status: string, result: JSONValue, now: number): Promise<void> | void;
  releaseStep(key: string): Promise<void> | void;
  claimCooldown(name: string, now: number, window: number): Promise<boolean> | boolean;
  coolingDown(name: string, now: number, window: number): Promise<boolean> | boolean;
  claimBudget(name: string, now: number, window: number, amount: number, max: number): Promise<boolean> | boolean;
  schedule(key: string, due: number, payload: JSONValue): Promise<void> | void;
  takeDue(now: number, lease?: number | null): Promise<[string, JSONValue][]> | [string, JSONValue][];
  cancel(key: string): Promise<boolean> | boolean;
  nextDue(): Promise<number | null> | number | null;
  close(): Promise<void> | void;
}
export function memoryJournal(): Journal;
export function isJournal(value: unknown): value is Journal;
export interface SqlDriver {
  query(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]> | Record<string, unknown>[];
  transaction<T>(thunk: () => T | Promise<T>): Promise<T> | T;
  close?(): Promise<void> | void;
}
export function dbJournal(driver: SqlDriver, options?: { dialect?: 'sqlite' | 'postgres'; prefix?: string }): Journal;
export function sqliteJournal(path: string, options?: { prefix?: string }): Promise<Journal>;
