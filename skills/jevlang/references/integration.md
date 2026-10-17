# Integrate a JevLang policy

1. Identify the compiled policy, application entrypoint, installed SDK version,
   and requested host. Establish which boundary is needed: supplying answers,
   calling a model, or executing a decision. Preserve existing provider and
   credential configuration. Read the relevant host section below.
2. Validate the policy and reproduce an expected decision with supplied answers.
   Use declared state fields to project application input. Keep local facts out
   of model requests; preserve them for guards and action execution.
3. Wire the smallest requested boundary. `evaluateWithProvider` returns a
   decision; `dispatchForInput` invokes registered handlers. Provider, model,
   and effort are distinct configuration fields. Inspect the installed API for
   host-specific details rather than inferring Python names from JavaScript.
4. Verify the boundary with a fake evaluator and stub handlers first. Exercise
   success, uncertainty, and an evaluator/handler failure where relevant. For
   HTTP, call the running local endpoint; for a gate, check allow, ask, and deny
   without performing a destructive tool call. A dry-run does not prove a live
   external handler ran.
5. Report the entrypoint, configuration names, test command, and what executed.
   Run a live model or real action only within the user's requested scope and
   existing authorization. Creating this integration does not grant permission
   to install global hooks, publish a policy, or send external messages.

Keep decisions and effects separate: `assign`, `act`, `confirm`, and `plan`
construct decision data. Register handlers for reachable targets, including
review targets. Retain actual provider/model provenance in recordings. Failures
should use the application's explicit review/error path; a provider outage is
not permission to allow a tool or execute an action.

These references follow the current JavaScript APIs. The native Python engine
supports core decisions and many integrations, but its package is in development.
Read installed Python signatures and its compatibility notes for the requested
surface before promising parity.

## In-process evaluation

```js
import { evaluateWithProvider } from 'jevlang';
const decision = await evaluateWithProvider(policy, input);
```

This projects state, builds questions, calls the selected provider, validates
answers, and decides. `policy.decide(answers, { state, facts })` performs only
the last offline part. Match the policy's declared input shape.

The TypeSafe Jev provider uses `TYPESAFE_API_KEY`. Configuration can also select
HTTP providers or local Claude/Codex CLI adapters. Discover with `jev providers`
and inspect `.jev/providers.json` and environment variable **names**, without
printing secret values. Selection precedence includes request, environment
(`JEV_PROVIDER`, `JEV_MODEL`, `JEV_EFFORT`), package, project, user, and defaults.
Check the resolved provider instead of assuming the policy's model is a provider.

An explicit selection can be passed as `{ provider: 'typesafe', model:
'jev-1.14.0' }`. Use the user's chosen provider; do not change it merely to make
a test pass. Model calls may send state off-machine and incur usage charges.
Images require capability support and `experimental.images`; forward `assets`
and options through wrappers. Read the repository's image guide when needed.

## Dispatch

```js
import { makeDispatcher, dispatchForInput } from 'jevlang/dispatch';

const dispatcher = makeDispatcher({
  'billing-queue': async (state, decision) => ({ queued: decision.target }),
  'technical-queue': async (state, decision) => ({ queued: decision.target }),
  'human-triage': async (state, decision) => ({ review: decision.reason }),
}, { policy, dryRun: true });
const outcome = await dispatchForInput(dispatcher, input, decision, { key: requestId });
```

The handlers above are stubs. `dryRun: true` returns a dry-run outcome without
executing them. `makeDispatcher` checks target coverage against the policy;
missing review/confirmation targets are integration errors too. `dispatchForInput`
builds local facts before dispatch; `dispatch` takes already prepared state.
For `act`, handlers receive evaluated parameters as decision data; `actHandler`
adapts a parameter-oriented function. Inspect declared action schemas.

Use a stable request key for retries, a suitable journal/store for the process
model, and existing application authorization. Do not claim exactly-once
external effects from an in-memory journal. Confirmation requires an actual
approval path, not an unconditional true callback.

## HTTP

```js
import { startServer } from 'jevlang/serve';
const server = await startServer(policy, { host: '127.0.0.1', port: 0 });
console.log(server.url);
// Stop with await server.stop() when the caller is finished.
```

`POST /decide` with `{ "answers": { ... } }` is offline and returns the decision
fields at the response root, plus `explain`. Model-backed `POST /evaluate` takes
`{ "state": input }` and needs an evaluate callback. Forward its second options argument:
`evaluate: (input, options) => evaluateWithProvider(policy, input, options)`.
Local ephemeral port 0 avoids colliding with other apps. Use the returned URL.
Check authentication/dispatch configuration before exposing a server externally.
Do not enable `/dispatch` for a read-only decision service.

## MCP and tool gates

`policyMcpServer` and `serveStdio` come from `jevlang/mcp`. A policy MCP server
offers policy operations; live evaluation is controlled by its options.
Do not confuse this with an MCP proxy that gates upstream tool execution.

`makeGate`, `gateCheck`, `gateState`, and `gateProxyServer` come from
`jevlang/gate`. A gate's input is `{ tool, arguments, source, server, annotations }`.
It requires an evaluate callback and returns a verdict separate from the policy
decision. Use explicit `allow`, `deny`, or `ask` targets. `hold`/`confirm` mean
ask; unknown decisions deny. Hard deny lists take precedence over allow lists;
both run before the model, so an allow list bypasses model analysis. Match tool
names narrowly and inspect arguments in deterministic code where required.

```js
import { makeGate, gateCheck, gateState } from 'jevlang/gate';
const gate = makeGate(toolPolicy, {
  evaluate: input => evaluateWithProvider(toolPolicy, input),
  onError: 'ask',
});
const verdict = await gateCheck(gate, gateState('Read', { path: 'README.md' }, {
  source: 'application',
}));
```

The CLI hook is `jev gate hook policy.json [options.json] < event.json`.
It can call the provider. Verify the current agent's hook protocol and actual
tool names before writing its configuration. Creating a development skill does
not require installing a permission hook. `approve-once` consumes a separate
approval workflow; never automate it just to make a blocked test pass.

For details beyond this reference, inspect installed declarations for
`jevlang/dispatch`, `jevlang/serve`, `jevlang/gate`, and `jevlang/mcp`, or the
[upstream repository](https://github.com/TimMikeladze/JevLang).
