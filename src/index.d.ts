export type JSONValue = null | boolean | number | string | JSONValue[] | { [key: string]: JSONValue };
export interface Expr<T = JSONValue> { readonly op: string; readonly args: readonly unknown[]; readonly __type?: T }
export type Value<T> = T | Expr<T>;
export interface QuestionSchema {
  type: 'choice' | 'score' | 'noul' | 'noul-each' | 'score-each' | 'raw';
  instructions?: JSONValue;
  criteria?: Record<string, JSONValue> | JSONValue[];
  ungated?: string;
  optionsFrom?: string;
  over?: string;
  itemKey?: string;
  /** Option code name -> the wire key it sends. */
  names?: Record<string, string>;
  /** One name, or null, per declared score level. */
  levelNames?: (string | null)[];
  /** A raw question's wire JSON, sent exactly as written. */
  wire?: { type: string } & Record<string, JSONValue>;
}
export interface QuestionRef { readonly id: string; readonly schema: QuestionSchema }
export interface ChoiceQuestion<K extends string = string, W extends string = K> extends QuestionRef {
  /** The option's code name, which is its wire key unless one was declared. */
  value(): Expr<K>;
  /** The wire key the model answered with. */
  chosen(): Expr<W>;
  confidence(): Expr<number>; is(option: K): Expr<boolean>;
  prob(option: K): Expr<number>; topProb(): Expr<number>; runnerUp(): Expr<W | false>; margin(): Expr<number>;
}
export interface ScoreQuestion<L extends JSONValue = JSONValue, R = L> extends QuestionRef {
  value(): Expr<number>; confidence(): Expr<number>; mostLikely(level: R | number): Expr<boolean>;
  atLeast(level: R | number): Expr<boolean>; prob(level: R | number): Expr<number>;
  topProb(): Expr<number>; margin(): Expr<number>; nearest(): Expr<L>; normalized(): Expr<number>; spread(): Expr<number>;
}
export interface NoulQuestion extends QuestionRef {
  value(): Expr<number>; yes(threshold?: Value<number>): Expr<boolean>; no(threshold?: Value<number>): Expr<boolean>;
}
export interface FamilyQuestion extends QuestionRef {
  max(): Expr<number>; min(): Expr<number>; mean(): Expr<number>; countYes(threshold?: Value<number>): Expr<number>;
  anyYes(threshold?: Value<number>): Expr<boolean>; allYes(threshold?: Value<number>): Expr<boolean>; argmax(): Expr<number | false>;
}
export interface NoulFamily extends FamilyQuestion { yesItems(threshold?: Value<number>): Expr<JSONValue[]> }
export interface RawQuestion extends QuestionRef { raw(): Expr<JSONValue> }
/** An option is a wire key, or a key with the code name the policy refers to it by. */
export type OptionSpec<K extends string, N extends string> = K | { key: K; name?: N; description?: JSONValue };
/** A level is its content, or its content with the name the policy refers to it by. */
export type LevelSpec<L extends JSONValue, N extends string> = L | { name: N; level: L };
export function choice<const K extends string, const N extends string = K>(id: string, instructions: JSONValue, options: readonly OptionSpec<K, N>[] | Record<K, JSONValue>, settings?: { ungated?: string; optionsFrom?: string }): ChoiceQuestion<K | N, K>;
export function score<const L extends JSONValue, const N extends string = never>(id: string, instructions: JSONValue, levels: readonly LevelSpec<L, N>[], settings?: { ungated?: string }): ScoreQuestion<L, L | N>;
export function rawQuestion(id: string, wire: { type: string } & Record<string, JSONValue>): RawQuestion;
export function noul(id: string, instructions: JSONValue, settings?: { criteria?: { true?: JSONValue; false?: JSONValue } }): NoulQuestion;
export function noulEach(id: string, instructions: JSONValue, over: string, settings?: { itemKey?: string; criteria?: { true?: JSONValue; false?: JSONValue } }): NoulFamily;
export function scoreEach<const L extends JSONValue, const N extends string = never>(id: string, instructions: JSONValue, levels: readonly LevelSpec<L, N>[], over: string, settings?: { itemKey?: string }): FamilyQuestion;
export function expression<T = JSONValue>(op: string, ...args: unknown[]): Expr<T>;
export function literal<T extends JSONValue>(value: T): Expr<T>;
export function isExpression(value: unknown): value is Expr;
export function asExpression<T extends JSONValue>(value: Value<T>): Expr<T>;
export function fact<T extends JSONValue = JSONValue>(name: string): Expr<T>;
export function threshold(name: string): Expr<number>;
export function signal<T extends JSONValue = JSONValue>(name: string): Expr<T>;
export function variable<T extends JSONValue = JSONValue>(name: string): Expr<T>;
export function all(...conditions: Value<boolean>[]): Expr<boolean>;
export function any(...conditions: Value<boolean>[]): Expr<boolean>;
export function not(condition: Value<boolean>): Expr<boolean>;
export function eq(a: Value<JSONValue>, b: Value<JSONValue>): Expr<boolean>;
export function compare(op: 'gt' | 'gte' | 'lt' | 'lte', a: Value<number>, b: Value<number>): Expr<boolean>;
export function compute(op: string, ...args: Value<JSONValue>[]): Expr;
export function choose<T extends JSONValue>(condition: Value<boolean>, yes: Value<T>, no: Value<T>): Expr<T>;
export function record(fields: Record<string, Value<JSONValue>>): Expr<Record<string, JSONValue>>;
export function list(...values: Value<JSONValue>[]): Expr<JSONValue[]>;
export interface DecisionSpec { action: string; [key: string]: unknown }
export interface Metadata { reason?: Value<string | null>; data?: Value<JSONValue>; show?: readonly (QuestionRef | string)[] }
export function assign(target: string, settings?: Metadata): DecisionSpec;
export function page(target: string, settings?: Metadata): DecisionSpec;
export function escalate(target: string, settings?: Metadata): DecisionSpec;
export function next(target: string, settings?: Metadata): DecisionSpec;
export function hold(settings?: Metadata): DecisionSpec;
export function act(target: string, params?: Record<string, Value<JSONValue>>, settings?: Metadata): DecisionSpec;
export function confirm(proposed: DecisionSpec, settings?: Metadata): DecisionSpec;
export function plan(...steps: DecisionSpec[]): DecisionSpec;
export function schedule(seconds: Value<number>, proposed: DecisionSpec, settings?: Metadata): DecisionSpec;
export function clarify(question: Value<string>, about?: QuestionRef | string, settings?: Metadata): DecisionSpec;
export function planFor(variable: string, items: Value<JSONValue[]>, decision: DecisionSpec): DecisionSpec;
export function branch(when: Value<boolean>, then: DecisionSpec, otherwise: DecisionSpec): DecisionSpec;
export interface Clause { when: Expr; decision: DecisionSpec; source?: string }
export function rule(when: Value<boolean>, decision: DecisionSpec, source?: string): Clause;
export interface Gate { question: string; threshold?: number; low?: number; high?: number; option?: string; by?: 'confidence' | 'topProb' | 'margin'; onRead?: boolean; decision: DecisionSpec }
export function gate(question: QuestionRef | string, threshold: number, decision: DecisionSpec, settings?: Pick<Gate, 'option' | 'by' | 'onRead'>): Gate;
export function band(question: NoulQuestion | string, low: number, high: number, decision: DecisionSpec, settings?: Pick<Gate, 'onRead'>): Gate;
export interface Field { path?: (string | number)[]; default?: JSONValue; local?: boolean; maxChars?: number; redact?: string[]; unredacted?: string }
export interface ParameterType { type: 'string' | 'number' | 'boolean' | 'json' | 'one-of' | 'list-of' | 'member-of'; optional?: boolean; min?: number; max?: number; values?: string[]; of?: ParameterType; field?: string }
export interface ActionSchema { params: Record<string, ParameterType>; doc?: string; confirm?: boolean; minConfidence?: number; cooldown?: number; allow?: string[]; timeout?: number; undo?: DecisionSpec }
export interface PolicySpec {
  format: 1; name: string; version?: string; owner?: string;
  questions: Record<string, QuestionSchema>; state?: Record<string, Field>;
  stateOptions?: { redact?: string[]; maxChars?: number | null; tokenLimit?: number | null };
  thresholds?: Record<string, number>; profiles?: Record<string, Record<string, number>>;
  signals?: Record<string, Expr>; gates?: Gate[];
  route: { mode?: 'first' | 'all' | 'collect'; clauses: Clause[]; otherwise?: DecisionSpec; precedence?: string[] };
  prechecks?: Clause[]; flags?: { when: Expr; flag: string }[]; actions?: Record<string, ActionSchema>;
  provider?: string; model?: string; effort?: string;
  /** Request fields the API docs do not describe; validation warns about them. */
  extraBody?: Record<string, JSONValue>;
}
export interface Decision {
  action: string; target: string | null; reason: string | null; data: JSONValue; proposed: Decision | null;
  steps: Decision[]; evidence: Reading[]; readings: Reading[]; rule: string | null; clause: number | null;
  source: string | null; line: number | null; file: string | null; model: string | null; provider: string | null;
  requested_model: string | null; requested_effort: string | null; effective_effort: string | null; request_id: string | null; stage: string | null;
}
export interface Reading { question: string; kind: string; value: JSONValue; confidence: number | null; detail: string | null }
export interface DecideOptions { facts?: Record<string, JSONValue>; state?: JSONValue; profile?: string; overrides?: Record<string, number> }
export class CompiledPolicy {
  constructor(policy: PolicySpec);
  readonly policy: Readonly<PolicySpec>; readonly warnings: readonly { path: string; message: string }[];
  toJSON(): PolicySpec; buildState(input: JSONValue): { state: JSONValue; facts: Record<string, JSONValue> };
  questions(state?: JSONValue): Record<string, QuestionSchema>; fingerprint(state?: JSONValue): string;
  /** The questions that do not depend on runtime state, and their fingerprint: the policy's recorded identity. */
  staticQuestions(): Record<string, QuestionSchema>; identity(): string;
  precheck(input: JSONValue, options?: DecideOptions): Decision | null;
  decide(answers: Record<string, JSONValue>, options?: DecideOptions): Decision;
}
export function definePolicy(spec: Omit<PolicySpec, 'format' | 'questions'> & { questions: readonly QuestionRef[] | Record<string, QuestionSchema | QuestionRef> }): CompiledPolicy;
export function compile(spec: PolicySpec): CompiledPolicy;
export function validatePolicy(spec: PolicySpec): { policy: PolicySpec; warnings: { path: string; message: string }[]; overrideKeys: string[] };
export function buildState(policy: PolicySpec, input: JSONValue): { state: JSONValue; facts: Record<string, JSONValue> };
export function buildQuestions(policy: PolicySpec, state?: JSONValue): Record<string, QuestionSchema>;
export function validateAnswers(questions: Record<string, QuestionSchema>, answers: unknown): void;
export function fingerprint(value: JSONValue): string;
export function canonical(value: JSONValue): string;
export class JevError extends Error { readonly code: string; readonly path: string; readonly fix: string | null; toJSON(): { code: string; path: string; message: string; fix: string | null } }
export function redact(value: JSONValue, specs?: string[], context?: string | null): JSONValue;
export function redactString(value: string, specs?: string[], context?: string | null): string;
export const redactorNames: readonly string[];
export function redactQuestions(questions: Record<string, QuestionSchema>, specs?: string[]): { questions: Record<string, QuestionSchema>; renames: Record<string, Record<string, string>> };
export function restoreAnswerKeys(answers: Record<string, JSONValue>, renames: Record<string, Record<string, string>>): Record<string, JSONValue>;
export function capValue(value: JSONValue, limit: number, path?: string, stringField?: boolean): JSONValue;
export function checkTokenBudget(state: JSONValue, questions?: Record<string, JSONValue>, limit?: number | null): JSONValue;
export function stateSize(value: JSONValue): number;
export function replay(policy: CompiledPolicy, fixtures: JSONValue[], options?: DecideOptions & { allowStale?: boolean }): { name: string; status: 'pass' | 'fail' | 'stale' | 'error' | 'unasserted'; decision?: Decision; message?: string; fingerprintVerified?: boolean }[];
export function diff(before: CompiledPolicy, after: CompiledPolicy, fixtures: JSONValue[], options?: DecideOptions): unknown[];
export function tune(policy: CompiledPolicy, fixtures: JSONValue[], grid: Record<string, number[]>): { warnings: string[]; results: { overrides: Record<string, number>; correct: number; total: number; accuracy: number }[] };
export function validateFixture(fixture: JSONValue): JSONValue;
export function matches(expected: JSONValue, actual: JSONValue): boolean;
export interface ActionTool {
  name: string; description?: string;
  inputSchema: { type: 'object'; properties: Record<string, JSONValue>; required: string[]; additionalProperties: false };
  annotations: { destructiveHint: boolean };
  _meta: Record<string, JSONValue>;
}
export function parameterSchema(type: ParameterType): JSONValue;
export function actionInputSchema(action: ActionSchema): ActionTool['inputSchema'];
export function actionAnnotations(action: ActionSchema): ActionTool['annotations'];
export function actionMeta(action: ActionSchema): Record<string, JSONValue>;
export function actionTool(name: string, action: ActionSchema): ActionTool;
export function policyActions(policy: CompiledPolicy | PolicySpec): { policy: string | null; actions: ActionTool[] };
export interface Histogram { question: string; kind: string; n: number; counts: number[] }
export interface ClauseCount { file: string | null; rule: string; index: number | null; source: string | null; line: number | null; count: number; share: number }
export interface Summary {
  total: number; escalated: number; escalation_rate: number | null;
  escalations_by_rule: Record<string, number>; actions: Record<string, number>; targets: Record<string, number>;
  clauses: ClauseCount[]; confidence: { source: 'answers' | 'readings'; edges: number[]; questions: Histogram[] };
  labels: { labeled: number; escalated: number; auto: number; wrong: number; wrong_rate: number | null } | null;
}
export interface ReliabilityBin { lo: number; hi: number; n: number; mean_p: number | null; accuracy: number | null }
export interface Calibration {
  question: string; kind: string; n: number; hits: number; skipped: number;
  ece: number | null; brier: number | null; enough_labels: boolean; bins: ReliabilityBin[];
}
export function summarize(decisions: Decision[], options?: { answers?: (Record<string, JSONValue> | null)[]; labels?: (JSONValue | null)[] }): Summary;
export function calibrate(cases: { answers: Record<string, JSONValue>; labels: Record<string, JSONValue> }[]): Calibration[];
export interface ClauseShift {
  file: string | null; rule: string; index: number | null; source: string | null;
  count_a: number; count_b: number; share_a: number; share_b: number; delta: number;
}
export interface Comparison {
  a: { total: number; escalation_rate: number | null };
  b: { total: number; escalation_rate: number | null };
  shifts: ClauseShift[];
}
// `compare` is already an expression builder, so the two-window comparison is
// named for what it does.
export function compareWindows(a: Summary | Decision[], b: Summary | Decision[]): Comparison;
export interface StabilityGate {
  question: string; kind: 'gate' | 'option-gate' | 'band'; name?: string;
  threshold?: number | null; by?: 'confidence' | 'top-prob' | null; option?: string | null;
  lo?: number | null; hi?: number | null;
}
export interface StabilityThreshold { name: string; kind: 'probability' | 'confidence' | 'score'; default: number }
export interface Crossing { kind: string; name: string; threshold: number; measure: string; lo: number; hi: number }
export interface QuestionStability {
  question: string; kind: string; n: number; mean: number; stdev: number;
  min: number | null; max: number | null; modal: string | number | null;
  flip_rate: number | null; confidence_stdev: number | null; crossings: Crossing[];
}
export interface StabilityReport {
  policy: string | null; runs: number; uid_added: boolean; precheck: Decision | null;
  questions: QuestionStability[]; decisions: { decision: string; count: number }[];
  errors: string[]; usage: { input_tokens: number; output_tokens: number }; cost: number;
}
export function gatesOf(policy: PolicySpec | { gates?: unknown[] }): StabilityGate[];
export function questionStabilities(
  allAnswers: Record<string, JSONValue>[],
  options?: { gates?: StabilityGate[]; thresholds?: StabilityThreshold[]; overrides?: Record<string, number> },
): QuestionStability[];
export function stabilityReport(options: {
  policy?: string | null; runs?: { answers?: Record<string, JSONValue>; decision?: Decision | string }[];
  gates?: StabilityGate[]; thresholds?: StabilityThreshold[]; overrides?: Record<string, number>;
  uidAdded?: boolean; usage?: { input_tokens: number; output_tokens: number };
  precheck?: Decision | null; n?: number | null;
}): StabilityReport;
export function formatSummary(summary: Summary): string;
export function formatComparison(comparison: Comparison, options?: { labels?: [string, string] }): string;
export function formatCalibration(calibration: Calibration): string;
export function formatStability(report: StabilityReport): string;
export function decimalString(x: number, places?: number): string;
export function bucketLabel(index: number, edges?: number[]): string;
export function bucketIndex(confidence: number, edges?: number[]): number;
export function escalated(decision: Decision): boolean;
export const confidenceEdges: readonly number[];
export const decileEdges: readonly number[];
export const calibrationMinLabels: number;
export interface TokenFit { n: number; intercept: number; slope: number; spread: number; lo: number; hi: number }
export interface CostReport {
  mode: string; note: string | null; model: string | null; chars: number;
  questions_tokens: number; state_tokens: number; envelope_tokens: number;
  per_call: { tokens: number; usd: number }; volume: { calls: number; tokens: number; usd: number };
  input_price_per_mtok: number; warnings: string[];
}
export function cost(policy: CompiledPolicy, options?: { input?: JSONValue; fixtures?: JSONValue[]; volume?: number; model?: string; price?: number }): CostReport;
export function chars(value: JSONValue): number;
export function requestBody(state: JSONValue, model: string | null, questions: JSONValue): JSONValue;
export function estimateTokens(chars: number): number;
export function fitTokenModel(samples: [number, number][], options?: { minN?: number }): TokenFit | null;
export function fitTokens(fit: TokenFit, chars: number): number;
export function samplesFromFixtures(policy: CompiledPolicy, fixtures: JSONValue[], model: string | null): [number, number][];
export function usageCost(usage: { input_tokens?: number }, price?: number): number;
export const inputPricePerMtok: number;
export function budgetWarnings(estimator: { tokens(chars: number): number; label: string }, stateChars: number, questions: Record<string, JSONValue>, bodyChars: number): string[];
export interface ProvenancedDecision extends Decision { provider: string | null; request_id: string | null; cached?: true }
/** A Map, or any store with synchronous get/set; it holds each call's in-flight promise. */
export interface AnswerCache { get(key: string): unknown; set(key: string, value: unknown): unknown; delete?(key: string): unknown }
export function questionsAnswerSchema(questions: Record<string, QuestionSchema>): JSONValue;
export function policyPrompt(state: JSONValue, questions: Record<string, QuestionSchema>): string;
export function evaluateWithProvider(policy: CompiledPolicy, input: JSONValue, options?: { provider?: string | null; model?: string | null; effort?: string | null; profile?: string | null; config?: Record<string, JSONValue>; registry?: unknown; role?: string; cache?: AnswerCache | null }): Promise<ProvenancedDecision>;
export function evaluateConfiguredPolicy(policy: CompiledPolicy, input: JSONValue, options?: { start?: string; package?: JSONValue; provider?: string | null; model?: string | null; effort?: string | null; registry?: unknown }): Promise<ProvenancedDecision | null>;
export function normalizeAnswers(questions: Record<string, QuestionSchema>, answers: Record<string, JSONValue>): Record<string, JSONValue>;
export function runPolicyProvider(state: JSONValue, questions: Record<string, QuestionSchema>, options?: { provider?: string | null; model?: string | null; effort?: string | null; config?: Record<string, JSONValue>; registry?: unknown; role?: string }): Promise<unknown>;
export function fixtureFromRun(options: { name: string; policy: CompiledPolicy; state: JSONValue; questions: Record<string, QuestionSchema>; decision?: Decision | null; result: { output: JSONValue; model: string | null; usage: JSONValue; requestId: string | null; target: { provider: { id: string }; model: string | null; requestedEffort: string | null; effectiveEffort: string | null } }; synthetic?: boolean; expect?: JSONValue }): JSONValue;
export function typesafeProvider(options?: { maxParallel?: number }): unknown;
export function makePolicyRegistry(config?: Record<string, JSONValue>): unknown;
export function sharedPolicyRegistry(config: Record<string, JSONValue>): unknown;
export function answerCacheKey(state: JSONValue, questions: Record<string, QuestionSchema>, selection: { provider: string | null; model: string | null; effort: string | null }): string;
export function policyProviderRequest(state: JSONValue, questions: Record<string, QuestionSchema>, options?: { provider?: string | null; model?: string | null; effort?: string | null; role?: string }): unknown;
export function explicitPolicySelection(config: Record<string, JSONValue>, request: unknown, selection?: { provider?: string | null; model?: string | null; effort?: string | null }): boolean;
export const policyConfigDefaults: Record<string, JSONValue>;
export function jevCall(state: JSONValue, questions: Record<string, QuestionSchema>, options?: { model?: string | null; timeoutSeconds?: number; retry?: typeof defaultRetryPolicy }): Promise<{ answers: Record<string, JSONValue>; model: string | null; usage: Record<string, JSONValue> | null; requestId: string | null; requestedModel: string }>;
export const clientSettings: Record<string, unknown>;
export const defaultRetryPolicy: { maxRetries: number; backoffInitial: number; backoffMax: number; jitter: number; statuses: number[]; respectRetryAfter: boolean; retryConnection: boolean; totalBudget: number };
export function defaultModel(): string;
export function apiKeyConfigured(): boolean;
export class JevApiError extends Error { kind: string; status: number | null; requestId: string | null; retryAfterMs: number | null; body: unknown; retryable: boolean }
export interface BatchReport { results: unknown[]; failed: number; tokens: number; cost: number }
export function evaluateMany<Row>(evaluate: (row: Row) => Promise<Decision> | Decision, rows: Row[], options?: { workers?: number; rpm?: number | null; tokensPerSecond?: number | null; sleep?: (seconds: number) => Promise<void>; clock?: () => number; onResult?: ((index: number, result: unknown) => void | Promise<void>) | null }): Promise<BatchReport>;
export function makePacer(options?: { rpm?: number | null; tokensPerSecond?: number | null; sleep: (seconds: number) => Promise<void>; clock: () => number }): { acquire(): Promise<void>; observe(usage: { input_tokens?: number }): void; pause(seconds: number): void };
export type PipelineStage<I = JSONValue> = ((input: I) => Promise<Decision> | Decision) | [(input: I) => Promise<Decision> | Decision, (previous: I, decision: Decision) => I];
export interface PipelineResult { decision: Decision & { stage?: string }; steps: [string, Decision][]; usage: { input_tokens: number; output_tokens: number } }
export function runPipeline(stages: Record<string, PipelineStage>, input: JSONValue, options: { start: string; maxRequests?: number }): Promise<PipelineResult>;
export function pipelineToJson(result: PipelineResult): JSONValue;
export function topOptions(answer: { probabilities?: Record<string, number> }, k: number): string[];
export function defaultNextInput(previous: JSONValue, decision: Decision): JSONValue;
