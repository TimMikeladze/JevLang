import type { AnswerCache, Decision, JSONValue } from './index.js';
import type { SqlDriver } from './journal.d.ts';

export interface StoreRecord {
  id: string; at: number; policy: string | null; input: JSONValue | null;
  answers: JSONValue | null; decision: Decision | JSONValue; key: string | null;
}
export interface Store {
  append(record: Omit<StoreRecord, 'id' | 'at'> & { id?: string; at?: number }): Promise<string> | string;
  get(id: string): Promise<StoreRecord | null> | StoreRecord | null;
  list(options?: { policy?: string | null; since?: number | null; limit?: number }): Promise<StoreRecord[]> | StoreRecord[];
  close(): Promise<void> | void;
}
export function recordOf(run: Omit<StoreRecord, 'id' | 'at'> & { id?: string; at?: number }, at?: number): StoreRecord;
export function memoryStore(): Store;
export function ndjsonStore(path: string): Store;
export function dbStore(driver: SqlDriver, options?: { dialect?: 'sqlite' | 'postgres'; prefix?: string }): Store;
export function sqliteStore(path: string, options?: { prefix?: string }): Promise<Store>;
export function isStore(value: unknown): value is Store;
/** A durable AnswerCache over any SqlDriver: preloaded, then flushed (docs/answer-cache.md). */
export interface DbAnswerCache extends AnswerCache {
  has(key: string): boolean;
  readonly size: number;
  /** Write answers added since the last flush; `prune` deletes this scope's answers nothing touched since opening. */
  flush(options?: { prune?: boolean }): Promise<{ saved: number; pruned: number }>;
}
export function dbAnswerCache(driver: SqlDriver, options?: { dialect?: 'sqlite' | 'postgres'; prefix?: string; scope?: string }): Promise<DbAnswerCache>;
export function withStore(evaluate: (input: JSONValue) => Promise<Decision> | Decision, store: Store, options?: { policy?: string | null; key?: string | null; clock?: () => number }): (input: JSONValue) => Promise<Decision>;
