import type { Decision, JSONValue } from './index.js';
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
export function withStore(evaluate: (input: JSONValue) => Promise<Decision> | Decision, store: Store, options?: { policy?: string | null; key?: string | null; clock?: () => number }): (input: JSONValue) => Promise<Decision>;
