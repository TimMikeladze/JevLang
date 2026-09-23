import type { CompiledPolicy, Decision, JSONValue } from './index.js';
import type { Dispatcher, Handler } from './dispatch.js';
import type { Journal } from './journal.js';

export interface ServeRoute {
  method: string; path: string; prefix: boolean; auth: 'token' | 'open';
  handler: (method: string, path: string, headers: Record<string, string>, body: Uint8Array | string)
    => Promise<{ status: number; body: JSONValue | Uint8Array | null; headers?: Record<string, string> }>
    | { status: number; body: JSONValue | Uint8Array | null; headers?: Record<string, string> };
}
export function serveRoute(route: Partial<ServeRoute> & { method: string; path: string; handler: ServeRoute['handler'] }): ServeRoute;
export interface ServeDispatchers { run: Dispatcher; dry: Dispatcher }
export function makeServeDispatchers(policy: CompiledPolicy, handlers: Record<string, Handler>, options?: { journal?: Journal | null }): ServeDispatchers;
export function handleRequest(policy: CompiledPolicy, method: string, path: string, body: Uint8Array | string | null, options?: {
  dispatchers?: ServeDispatchers | null; dispatchAllowed?: boolean; headers?: Record<string, string>;
  routes?: ServeRoute[]; evaluate?: ((input: JSONValue) => Promise<Decision> | Decision) | null;
}): Promise<{ status: number; body: JSONValue | Uint8Array | null; headers?: Record<string, string> }>;
export interface JevServer { host: string; port: number; wanted: number; url: string; dispatchAllowed: boolean; stop(): Promise<void> }
export function startServer(policy: CompiledPolicy, options?: {
  host?: string; port?: number; tries?: number; token?: string | null;
  dispatchers?: ServeDispatchers | null; routes?: ServeRoute[];
  evaluate?: ((input: JSONValue) => Promise<Decision> | Decision) | null;
  log?: { write(text: string): unknown } | null;
  /** Largest accepted body in bytes (default 1 MB); bigger bodies get 413. */
  maxBody?: number;
  /** Seconds a request may take, headers included (default 60). */
  requestTimeout?: number;
}): Promise<JevServer>;
export function tokenMatches(token: string, header: string | undefined): boolean;
export function loopbackHost(host: string): boolean;
