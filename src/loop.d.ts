import type { Decision, JSONValue } from './index.js';
import type { Dispatcher, Outcome } from './dispatch.js';
import type { Store } from './store.js';

export interface LoopEvent { input: JSONValue; key: string | null; principal: JSONValue; id: string | null; at: number }
export type EventResult = Outcome | 'stale' | Error;
export type Source = (post: (event: LoopEvent) => void) => (() => void | Promise<void>);
export interface Loop { running: boolean; inFlight: number }
export function makeEvent(input: JSONValue, options?: { key?: string | null; principal?: JSONValue; id?: string | null; at?: number }): LoopEvent;
export function makeLoop(options: {
  evaluate: (input: JSONValue) => Promise<Decision> | Decision; dispatcher: Dispatcher; sources?: Source[];
  debounce?: number; maxAge?: number | null; workers?: number;
  onOutcome?: ((event: LoopEvent, result: EventResult) => void | Promise<void>) | null;
  clock?: () => number; runDueEvery?: number | null; store?: Store | null;
}): Loop;
export function loopStart(loop: Loop): Loop;
export function loopStop(loop: Loop): Promise<void>;
export function loopPost(loop: Loop, event: LoopEvent): void;
export function loopIdle(loop: Loop): boolean;
export function runEvents(evaluate: (input: JSONValue) => Promise<Decision> | Decision, dispatcher: Dispatcher, events: LoopEvent[], options?: { maxAge?: number | null; clock?: () => number }): Promise<[LoopEvent, EventResult][]>;
export function timerSource(seconds: number, makeInput: () => JSONValue | Promise<JSONValue>, options?: { key?: string | null; principal?: JSONValue }): Source;
export function iterableSource(iterable: AsyncIterable<JSONValue | LoopEvent>, options?: { key?: string | null; principal?: JSONValue }): Source;
export function lineSource(readable: { on(event: string, fn: (chunk: string) => void): void; off(event: string, fn: (chunk: string) => void): void; setEncoding?(encoding: string): void }, options?: { onError?: ((line: string, error: Error) => void) | null }): Source;

export interface Sessions { table: Map<string, { input: JSONValue; question: string; rounds: number; at: number }> }
export function makeSessions(evaluate: (input: JSONValue) => Promise<Decision> | Decision, dispatcher: Dispatcher, options?: {
  merge?: (original: JSONValue, question: string, reply: string) => JSONValue;
  ttl?: number; maxRounds?: number; clock?: () => number;
}): Sessions;
export function sessionMessage(sessions: Sessions, id: string, message: string, options?: { principal?: JSONValue; key?: string | null }): Promise<Outcome>;
export function sessionPending(sessions: Sessions, id: string): string | null;
export function sessionForget(sessions: Sessions, id: string): boolean;
export function defaultMerge(original: JSONValue, question: string, reply: string): JSONValue;
