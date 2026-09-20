# Portable Jev (in development)

A shared local policy validator and interpreter for TypeScript and Python.
The engine runs on Node.js 22.13+ and has no runtime package dependencies.
It requires no Racket, SaaS account, credentials, or connection for supplied
answers, validation, and replay. Racket is used only by differential tests.

This is active implementation, **not a completed replacement or SaaS release**.
See [COMPATIBILITY.md](COMPATIBILITY.md) for the full remaining contract.

```sh
cd packages/jevlang
npm install
npm test
npm run test:types
```

```typescript
import { choice, definePolicy, gate, hold, rule, assign } from 'jevlang';

const department = choice('department', 'Which team?', ['billing', 'technical']);
const policy = definePolicy({
  name: 'router',
  questions: [department],
  gates: [gate(department, 0.8, hold())],
  route: {
    clauses: [rule(department.is('billing'), assign('billing-team'))],
    otherwise: assign('engineering'),
  },
});
const decision = policy.decide({
  department: { type: 'choice', choice: 'billing', confidence: 0.95 },
});
```

`department.is('billling')` is a TypeScript error. The shared validator also
rejects it in Python and raw JSON, before deployment or model calls. Policies
are validated immediately on construction and defensively copied and frozen.

Use `all`, `any`, `not`, `compare`, and `branch` to compose inspectable policy
logic; ordinary host callbacks cannot be serialized. Question, signal and action
reads are checked across the entire policy, including nested plans. Informational
reason/data/evidence reads are distinct from reads that decide behavior.

`policy.toJSON()` exports a portable format-1 artifact; `compile(json)` loads
it. `node src/cli.mjs --help` lists local validate, decide, state, replay, diff
and tune commands. `src/fixtures.mjs` exposes the same offline tools. Fixture
version 3 and provider provenance are required; existing fixture files remain
unchanged. Missing fingerprints are reported as unverified, never verified.

The Python package in `../jevlang-python` bundles these same engine sources.
Its interpreter is not an independent port. Python requires a local Node
executable (`JEV_NODE` may select it).

## Names, levels and escape hatches

An option can carry the code name the policy refers to it by, separately from
the wire key it sends; a score level can carry a name. Both are checked, so a
typo is an error rather than a clause that never fires.

```javascript
const intent = choice('intent', 'What is the user asking to do?', [
  { key: 'check-balance', description: 'Check an account balance' },
  { name: 'approve-transfer', key: 'approve_transfer', description: 'Approve the pending transfer' },
]);
const urgency = score('urgency', 'How urgent is the request?', [
  { name: 'calm', level: 'No time pressure' },
  { name: 'now', level: 'Needs it immediately' },
]);
intent.is('approve-transfer');   // the code name
intent.is('approve_transfer');   // or the wire key it sends
intent.value();                  // the code name that was answered
intent.chosen();                 // the wire key that was answered
urgency.mostLikely('now');       // a level by name, its text, or its index
```

`rawQuestion(id, wire)` sends a question exactly as written, and only
`question.raw()` reads its answer; `extraBody` adds request fields the API docs
do not describe. Both bypass the checks, so both raise a validation warning.

Reads inside `reason`, `data` and `show` are informational: they still trip
on-read gates, but they are not part of a clause's readings, exactly as in
`#lang jev`.

## Fixtures and identity

`policy.identity()` fingerprints the questions that do not depend on runtime
state, and `replay` compares it with a fixture's `questions_sha256`. A fixture
that recorded the questions it sent is instead compared against the rebuilt
questions themselves, which is exact; the row says which check ran
(`verifiedBy`). A policy with runtime questions has a Racket-recorded hash this
engine cannot recompute, because that hash folds in Racket-printed templates, so
such fixtures must carry their questions to be verified rather than reported as
verified on trust.

## Schema and monitoring

`policyActions(policy)` renders every declared action as JSON Schema 2020-12,
the way an MCP tool listing carries it: an `inputSchema`, `annotations` (a
confirmed action is `destructiveHint`), and the safety rules under `_meta`
(`jev/confirm`, `jev/min_confidence`, `jev/cooldown_seconds`, `jev/allow`,
`jev/timeout_seconds`, `jev/undo`). It matches `raco jev schema --json`.

`summarize(decisions, { answers, labels })` folds a batch of decisions into the
numbers an operator watches: escalation rate and which rule escalated, the share
each clause carried, a confidence histogram per question, and, where a person
labelled the case, how often the policy decided it itself and was wrong.
Histograms come from full answers when they are supplied, and otherwise from
what the firing clause read. Nothing here raises an alarm: any fixed drift
threshold would be invented.

`calibrate(cases)` checks confidence against per-question labels — a reliability
table, the expected calibration error and the Brier score — and reports
`enough_labels: false` below 200 labels, as `tune` does.

`node src/cli.mjs schema|stats|calibrate` exposes all three, and the Python
`Policy` has `schema()`, `stats()` and `calibrate()`.

`cost(policy, { input, fixtures, volume })` prices a request. There is no public
tokenizer, so the default counts ~4 characters per token of the serialized
request body and says so; on the recorded smart-home calls that default
undercounts the real charges by about 2.2x. Passing recorded fixtures replaces
it with a least-squares fit against their real `input_tokens`, which is still an
estimate and reports how many calls it was fitted on, over what size range, and
its spread. Synthetic fixtures are ignored. Output is free; the input price is
the documented one and nothing here invents another.

## Providers

`jevlang/provider` is the provider spine: layered configuration, capability
discovery, deterministic resolution, explicit fallback, bounded process
lifetimes and separated accounting.

Resolution consults an explicit request target, then the environment, the
package's role or tier settings, the project configuration, the user
configuration and the defaults, in that order. A layer can carry `routes`, and
the most specific matching route in the highest-precedence layer wins. Exact
effort is honoured or rejected, never silently changed: when the caller or the
configuration named a provider, an unsupported effort is an error; otherwise
that provider is passed over and the rejection says why.

Any executable can be a provider by speaking `jev-provider/1`: one JSON request
on stdin, one JSON object (or a stream whose last `result` event carries it) on
stdout. It sees only the environment it was allowed, runs in its own process
group under a deadline, and its structured output is checked against the
request's schema. Reported USD, subscription calls and unreported usage stay
distinct, and a failure that may have changed something is never retried.

```javascript
import { makeDefaultRegistry, loadProviderConfig, providerRequest, runProviderRequest } from 'jevlang/provider';

const config = loadProviderConfig({ role: 'review' });
const registry = makeDefaultRegistry(config);
const result = await runProviderRequest(providerRequest('review', 'structured', { prompt, schema }), config, registry);
```

`node src/cli.mjs providers` (and `jev.providers()` in Python) reports what
resolution would choose here, what it passed over, and why. The default registry
carries the same three built-in CLI adapters the Racket implementation ships —
Claude, Codex and fx — and configuration may point any of them at another
command, cap its parallelism, or add providers of its own. Each adapter builds
that CLI's own command line (Claude's `--json-schema` and stream transcript,
Codex's strict output schema written to a file, fx's workspace-only permission
rules), separates a reported dollar cost from a subscription call, and says
whether a failed run may have changed the workspace.

## Asking a provider

`evaluateWithProvider(policy, input)` is the one call that leaves the machine: it
builds the state, builds the questions, asks the selected provider for the
answers, validates them against the questions, and decides. The decision carries
which provider, requested and served model, requested and effective effort, and
request id answered. A precheck that decides needs no call at all.

The TypeSafe System One provider posts the state, the model and the questions to
`{TYPESAFE_BASE_URL}/v1/systemone` with the SDKs' retry policy — 408, 429 and
5xx, exponential backoff with jitter, a server's `retry-after` honoured up to a
minute, and a total budget — and classifies each status. Any executable can
answer instead: it receives the questions in its `jev-provider/1` metadata and
returns the answers as its output, which is checked against the answer schema
before anything decides.

`fixtureFromRun` writes a version 3 fixture from a real run, with the provider
provenance a replay requires, and `record` (CLI and Python) does both at once.

`evaluateConfiguredPolicy` is for a package-owned policy: when nothing but the
defaults asked for a provider and no TypeSafe credential is configured, it
returns null — no configured decision — rather than failing, while an explicit
provider, model, effort or route that cannot resolve stays an error.

## Dispatch

A policy decides; `jevlang/dispatch` acts. A dispatcher checks coverage when it
is built — every target the policy can name has a handler, and no handler is
registered for a target the policy never produces — and at dispatch time a
decision is handled, passed through on purpose, skipped by a safeguard that says
so, or it raises. It never silently goes nowhere.

```javascript
import { makeDispatcher, dispatch, actHandler, budget, handlerChain, retry } from 'jevlang/dispatch';
import { sqliteJournal } from 'jevlang/journal-db';

const d = makeDispatcher({
  'lights-on': actHandler(({ room, idempotencyKey }) => turnOn(room, idempotencyKey)),
  'ask-user': handlerChain(retry(pageOnCall, { attempts: 2 }), queueForAPerson),
}, {
  policy, confirm: (state, decision) => askAResident(decision),
  guards: { 'lock-door': (state, decision) => doorIsClosed(decision.data.door) },
  budgets: [budget('unlocks', { max: 10, per: 86400 })],
  journal: await sqliteJournal('jev-journal.sqlite'),
  planFailure: 'rollback',
});
const outcome = await dispatch(d, state, decision, { principal, key: decision.request_id, facts });
```

An outcome's status says what happened: `ran`, `passed`, `declined`, `dry-run`,
`guard-failed`, `cooldown`, `over-budget`, `forbidden`, `duplicate`,
`uncertain`, `scheduled`, `rolled-back`, `error` or `not-run`. `outcomeToJson`
turns it into one audit record, with every hop, the chain link that answered and
the steps of a plan.

The safeguards are the point: an action's parameters are re-checked against its
declaration, its cooldown and the dispatcher's budgets are claimed atomically in
the journal, a per-target guard runs just before the handler, a principal's
roles must include the action's `allow`, and a dispatch key that started and
never finished comes back `uncertain` rather than being run again. A plan runs
step by step and, with `planFailure: 'rollback'`, undoes the steps that ran using
each action's declared inverse — a declared inverse, not a snapshot. A schedule
is held in the journal and runs when it is due, so it survives a restart with a
durable journal.

Two differences from the Racket dispatcher are worth knowing. JavaScript cannot
stop a running function, so a handler that passes its timeout is reported and
abandoned rather than killed — the error says it may already have acted. And
handlers are host functions, so the Python SDK does not dispatch: it decides,
and the acting happens in whichever host holds the handlers.

`jevlang/journal` is the in-memory journal; `jevlang/journal-db` has SQLite
through the built-in `node:sqlite`, and `dbJournal` takes any SQL driver (a
PostgreSQL driver is a dependency this package does not carry).

## Volume and several calls

`evaluateMany(evaluate, rows)` runs a policy over many rows concurrently, and
paces every call — retries included — through the documented rate limits: one
start every 60/rpm seconds and a token bucket holding one second's worth, where
a start reserves the average input tokens seen so far and the reservation is
corrected when the real count arrives. A server's `retry-after` pauses every
start. The report keeps the results in input order, counts the rows that are not
decisions, and totals the tokens the batch spent.

`runPipeline(stages, input, { start })` is for decisions that take more than one
call: a stage hands off by deciding `next('stage')`, an optional builder shapes
the next stage's input, and `topOptions(answer, k)` shortlists a choice for the
stage that re-asks with only those options. The run stops at the first decision
that is not a `next`, refuses to reach a stage twice, and refuses to exceed
`maxRequests` — each stage is one billed call.

## Handlers in a file, a loop, and sessions

`jevlang/handlers` builds handlers from a JSON file, so devices can be wired up
without writing code: `shell` (a declared argv, one argument per placeholder,
never a shell), `http` (a JSON POST carrying the decision and its idempotency
key), `log` (one JSON line per decision) and `mqtt` (a minimal MQTT 3.1.1
publisher, no dependency). `{name}` in a string is that parameter of the
decision, and an unknown name is an error rather than an empty string. A
`confirm` entry approves only on `true` or `{"approved": true}`. The `webhook`
type belongs to the integrations work and is not ported yet.

`jevlang/loop` runs continuously: events in, decisions dispatched. Events with
the same key are handled one at a time and, with a debounce, a burst for one key
collapses to its latest; different keys run in parallel up to `workers`; an event
older than `maxAge` when its turn comes is `stale` and never evaluated; and one
event's failure never stops the loop. Sources are a timer, an async iterable, or
JSON lines from a stream, and `runEvents` replays a scenario in order.

`jevlang/session` turns a clarify into a conversation: the input that led to
the question is remembered, the next message is merged into it and evaluated
again, and after `maxRounds` questions it holds and says what it last asked.

## MCP

`jevlang/mcp` serves a policy, or any set of tools, over MCP. It is dual-era:
a request carrying the 2026-07-28 `_meta` is served statelessly, `initialize`
switches that connection to the legacy version it negotiated, and a request with
neither gets `-32602`. `handleMessage` is pure — one parsed JSON-RPC message in,
the reply out, no I/O — and `serveStdio` and `httpHandle` are thin wrappers.

```javascript
import { policyMcpServer, serveStdio } from 'jevlang/mcp';
await serveStdio(policyMcpServer(policy, { allowEvaluate: true, evaluate }));
```

`policyMcpServer` gives a policy a `decide` tool (answers you already have: no
model call, no cost), an `evaluate` tool when it is allowed and capped, and two
resources: `jev://policy` and `jev://policy/actions`. A tool that needs a person
returns an input-required result to a modern client, and asks a legacy stdio
client through elicitation; a legacy client with no way back gets an error
saying so rather than a silent wait. `POST /mcp` checks the `Origin` header
against loopback and `JEV_MCP_ORIGINS`, and rejects a protocol or method header
that disagrees with the body.

`jevlang/mcp-client` calls another server's tools, and turns them into
dispatcher handlers. It is dual-era the way the spec asks: over stdio it probes
with `server/discover` and falls back to `initialize` on any other error or on
silence; over HTTP it tries modern first. A server that asks for input is
answered through `onElicit` and the call is retried, up to three rounds; a
legacy server that sends `elicitation/create` itself is answered the same way.
Over HTTP a tool whose `x-mcp-header` annotations break the spec's rules is left
out with a warning, and a parameter that is annotated travels in its own
`Mcp-Param-` header.

```javascript
const client = await mcpConnect(['npx', '-y', 'some-server']);
const d = makeDispatcher(await mcpHandlers(client, { policy }), { policy, confirm });
```

`jevlang/mcp-import` turns a `tools/list` snapshot into portable action
declarations — the inverse of the JSON Schema view — so the validator becomes the
check: an act against a tool that no longer exists, or with a parameter it does
not take, fails to validate. `writeMcpImport` writes the snapshot and a module
beside it, and `snapshotDrift` reports what changed against a live server. A tool
is confirmed unless it says `readOnlyHint` or denies `destructiveHint`, which are
MCP's own defaults. The mapping is lossy in three documented places: an integer
is a number, a range needs both bounds, and an element type carries no range.

## The gate

`jevlang/gate` is a policy that decides whether an agent's tool call runs, with
two front ends over one state shape: a Claude Code or Codex PreToolUse hook, and
an MCP server that stands in front of another one. The verdict fails closed — a
decision that assigns, pages or escalates to `allow`, `deny` or `ask` means that;
`hold` and `confirm` mean ask; anything else denies and says so — and when the
policy cannot decide at all the answer is the configured `onError`: ask for a
hook, deny for a proxy. The deny and allow lists run before the model, so hard
rules stay in code.

```javascript
const gate = makeGate(policy, { evaluate: state => evaluateWithProvider(policy, state), deny: ['Bash(rm *)'] });
process.stdout.write(JSON.stringify(await hookResponse(JSON.parse(event), () => gate)));
```

Asking a person, in the proxy: a modern client with the elicitation capability
gets an input-required result carrying an approve/deny form whose `requestState`
is HMAC-signed with a per-process key, expires, and names a digest of the tool
and its arguments — so an approval cannot be replayed on another call. A legacy
client with the capability is asked directly, and a client that cannot be asked
is denied rather than left waiting. Codex has no "ask", so such a call is denied
with an approval fingerprint; `jev gate approve-once <fingerprint>` lets that one
exact call through once, and the approval is consumed when it is used. The
fingerprints are identical to the Racket implementation's, so an approval made by
either is honoured by the other.

Every verdict can go to a JSONL log, where the arguments appear only as a
digest: they carry secrets, and the policy's redactors do not run on the log.

## Webhooks, a spool, and labels

`jevlang/webhooks` signs decisions out and checks events in. Out:
`webhookHandler(url, { secret })` is a dispatcher handler that POSTs a Standard
Webhooks message whose `webhook-id` is the dispatch key, so it is the same on
every retry and a receiver can dedupe; a connection error, a timeout, 408, 429
and 5xx are retried with backoff and a server's `Retry-After`, and any other
status raises at once. A URL's path never appears in a message, because a webhook
URL can itself be a secret. In: verifiers for Standard Webhooks, GitHub, Stripe,
Slack, and any other HMAC scheme, each checking the signature and the timestamp
before anything parses the body, and each naming what was wrong.

`jevlang/wiring` is the runtime behind serving them: `POST /webhook/<name>`
answers 404, 401, 400, a source's sync answer, `duplicate`, `ignored`, 500 or
202 — in that order — and an accepted delivery is written to the spool's queue
before it is marked seen, so a crash loses nothing and delivery is at least once.
Workers take the queue in arrival order, one event per case at a time, so a
case's outcome never overtakes its decision. A case is decided, recorded as a
fixture, saved pending in the harvest store, dispatched, and run through an
optional shadow policy; a failure moves to `failed/` with its error, and moving
the file back retries it. Maintenance forgets delivery markers after a week and
settles pending cases.

`jevlang/harvest` turns those cases plus what people did with them into labeled
fixtures that tuning and calibration read: a correction is a strong label (the
last one wins), a close without one leaves the decision standing unless the
policy escalated, and silence for N days is a weak label. A store is three
directories of version 3 fixtures, so `replay` and `tune` read `labeled/`
directly.

## Serving one policy

`jevlang/serve` is an HTTP sidecar, so a service in any language can use a
policy: `GET /healthz`, `GET /policy`, `POST /decide` (offline and pure),
`POST /evaluate` (asks the provider) and `POST /dispatch` (evaluates, then runs
the handlers, with `dry_run` to rehearse). Every decision comes back with an
`explain` string. A token guards everything but the health check, `/dispatch`
needs that token or a loopback bind before it runs anything for real, and
`handleRequest` is a pure function so a host can route however it likes. MCP's
`POST /mcp` and the webhook receivers' `POST /webhook/<name>` mount as extra
routes, each with its own auth. If the port it wants is taken it steps to the next
free one and reports it, and never touches whatever holds the port it wanted.

Known incomplete areas include code lookup, and hosting (accounts,
deployments, the dashboard, quotas, billing). State whitelisting, recursive redactors, caps, question key
redaction/restoration and rough token budgets have initial differential tests.
Regex redaction has the same known false positives and negatives as the Racket
version; it is not a substitute for excluding sensitive fields. This development
package has not passed the full production compatibility gates.

`python3 tools/verify-portable.py` from the repo root checks both SDKs, builds
distributions offline (after dependencies have been installed), and executes
installed packages outside the checkout with Racket absent from PATH.
