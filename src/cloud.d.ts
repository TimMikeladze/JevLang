import type { Decision, JSONValue, PolicySpec, CompiledPolicy } from './index.js';
import type { Journal } from './journal.js';

export class CloudError extends Error {
  status: number | null;
  code: string | null;
  detail: unknown;
  toJSON(): { code: string; status: number | null; message: string };
}

export interface CloudOptions {
  /** `jev_live_…` for a server, `jev_pub_…` in a browser. Defaults to JEV_KEY. */
  key?: string;
  /** Defaults to JEV_CLOUD_URL, then https://cloud.jevlang.sh. */
  baseUrl?: string;
  /** `dev`, `preview` or `production`. The service defaults to production. */
  environment?: string | null;
  fetch?: typeof fetch;
  timeoutSeconds?: number;
}

export interface Deployment {
  id: string; number: number; identity: string; name: string | null;
  note: string | null; published_by: string | null; published_at: string;
}

export interface PromoteResult {
  production: number; deployment: string; rollback: boolean;
  gate: { replayed: number; changed: number; refused: number; rate: number | null } | null;
}

export interface DiffResult {
  rows: { trace_id: string; at: string; old: string; new: string; changed: boolean }[];
  summary: { replayed: number; changed: number; refused: number };
  against: number | null;
}

export interface CloudClient {
  evaluate(project: string, input: JSONValue, options?: { idempotencyKey?: string | null; endUser?: string | null }): Promise<Decision>;
  decide(project: string, input: JSONValue, answers: Record<string, JSONValue>): Promise<Decision>;
  dispatch(project: string, input: JSONValue, options?: { answers?: Record<string, JSONValue>; dryRun?: boolean; key?: string | null }): Promise<Record<string, JSONValue>>;
  traces(project: string, options?: { limit?: number; environment?: string | null }): Promise<Record<string, JSONValue>[]>;
  trace(project: string, id: string): Promise<Record<string, JSONValue>>;
  deploy(project: string, policy: CompiledPolicy | PolicySpec, options?: { note?: string | null }): Promise<{ id: string; number: number; identity: string; production: boolean }>;
  deployments(project: string): Promise<Deployment[]>;
  promote(project: string, deployment: string | number, options?: { expect?: number | null; gate?: { sample?: number; max_changed: number } | null; environment?: string | null }): Promise<PromoteResult>;
  replayDiff(project: string, deployment: string | number, options?: { limit?: number; since?: string | null }): Promise<DiffResult>;
  project(project: string): Promise<Record<string, JSONValue>>;
  projects(): Promise<Record<string, JSONValue>[]>;
  createProject(slug: string): Promise<Record<string, JSONValue>>;
  usage(): Promise<Record<string, JSONValue>>;
  docs(project: string, file?: 'openapi.json' | 'llms.txt' | 'AGENTS.md' | 'mcp.json' | 'snippets.md', options?: { environment?: string | null }): Promise<string>;
  /** The project's managed state, as the Journal a dispatcher takes. */
  journal(project: string): Journal;
  playground(project: string, options?: { environment?: string | null }): string;
  call(path: string, options?: { method?: string; body?: JSONValue; headers?: Record<string, string>; query?: Record<string, string | number | null> }): Promise<Record<string, JSONValue>>;
  readonly baseUrl: string;
}

export function cloud(options?: CloudOptions): CloudClient;
export function cloudJournal(client: CloudClient, project: string): Journal;

/** A job a runner claimed: the decision the cloud made, and the state it saw. */
export interface RunnerJob {
  id: string;
  /** One-time token for this claim; reports need it. */
  claim: string;
  project: string;
  environment: string;
  target: string;
  decision: Decision;
  state: JSONValue | null;
  attempt: number;
  lease_until: string;
}

export type RunnerHandler = (state: JSONValue | null, decision: Decision, context: { job: RunnerJob }) => unknown;

export type RunnerEvent =
  | { type: 'claimed'; job: RunnerJob }
  | { type: 'done'; job: RunnerJob; result: unknown }
  | { type: 'failed'; job: RunnerJob; error: unknown; retry: boolean }
  | { type: 'heartbeat-failed' | 'report-failed'; job: RunnerJob; error: unknown }
  | { type: 'claim-failed'; error: unknown };

export interface RunnerOptions extends CloudOptions {
  /** The pool a `{ "type": "runner", "pool": … }` handler names. Default `default`. */
  pool?: string;
  /** Target → handler. `default` catches targets with no handler of their own. */
  handlers?: Record<string, RunnerHandler>;
  /** Replaces the handler lookup: run the whole job yourself. */
  run?: (job: RunnerJob) => unknown;
  /** How this runner appears on the dashboard. */
  name?: string;
  /** Jobs claimed and run at once. Default 1, at most 10. */
  concurrency?: number;
  /** Seconds a claim long-polls for work. Default 20, at most 25. */
  wait?: number;
  /** Seconds a claim holds a job; extended every third of it while a handler runs. Default 300. */
  lease?: number;
  /** An existing client, instead of making one from the options. */
  client?: CloudClient;
  onEvent?: (event: RunnerEvent) => void;
}

export interface Runner {
  /** Claim once, run what came back, and report. Resolves to how many jobs ran. */
  runOnce(options?: { wait?: number }): Promise<number>;
  /** Claim and run until `stop()`. */
  start(): Promise<void>;
  /** Finish the jobs in hand, then stop. */
  stop(): Promise<void>;
  readonly pool: string;
  readonly name: string;
}

export function runner(options?: RunnerOptions): Runner;
