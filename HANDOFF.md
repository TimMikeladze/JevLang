# Where the work stands

This file is the working note: what is finished, what is next, and how each piece
was proved.

## How this is checked

Nothing in the suite reaches the network. The HTTP behaviour is exercised
against a local `node:http` server, and providers against fake executables.

Run it all: `bun install && bun test && bun run test:types` in `packages/jevlang`,
`python3 -m unittest discover -s tests` in `packages/jevlang-python`, and
`python3 tools/verify-portable.py` from the repo root.

**Python runs the whole product natively; the Node wrapper is gone.** A native Python engine
inside `packages/jevlang-python/jevlang/` covers validation, decisions, state,
fixtures, monitoring, cost, providers, evaluate, record, dispatch, journals,
batch, pipelines, handlers, the event loop, sessions, MCP (server, client,
import), the gate and its hooks, webhooks, the wiring spool, harvesting and
serving — byte-identical to this engine's text reports (`tests/test_differential.py`). The subprocess wrapper,
`JEV_NODE` and the `rpc` protocol are deleted with migration errors, the wheel
bundles no Node engine, and the suite (149 tests) passes with Node stripped
from PATH.

## Finished

1. **Representation, validation, pure decisions.** The whole language except the
   gaps listed below, including the trace prose a gate prints and the reading
   detail a score takes from its answer's legend.
2. **State.** Whitelisting, recursive redactors, caps, question-key redaction and
   restoration, rough token budgets.
3. **Local product.** TypeScript and Python builders with typed packages, the
   CLI, fixtures (replay with honest verification, diff, tune), action JSON
   Schema, monitoring summaries, calibration, token and cost estimates, the
   two-window clause-share comparison, and the text reports a person reads. Only
   the provider calls a stability run makes are left out; its statistics are
   ported.
4. **Provider spine.** Layered configuration, discovery, deterministic
   resolution with routes and explicit fallback, exact effort, bounded process
   lifetimes, the custom executable protocol, separated accounting.
5. **Evaluation.** The TypeSafe System One call with its retry policy and status
   classification, the same evaluation through any executable, provenance on the
   decision, version 3 fixture recording.
6. **Batch and pipelines.** Rate-aware concurrent evaluation with the documented
   limits, and multi-stage policies that hand off with `next`.
7. **Automation.** The dispatcher (the coverage check, guards, confirmation,
   permissions, budgets with windows, cooldowns, atomic idempotency claims,
   chains and retries, timeouts, plans with stop, continue and rollback,
   durable schedules), the in-memory and SQLite journals, handlers declared in a
   file (shell, http, log, mqtt), the event loop, and clarify sessions.
8. **Integrations.** Signed webhooks in and out, the webhook spool with
   at-least-once delivery and per-case ordering, shadow policies, and label
   harvesting.
9. **The gate.** Verdicts that fail closed, the deny and allow lists, the
   Claude and Codex hooks with one-shot approvals, and the MCP proxy with signed, single-use approvals.
10. **MCP.** The server (dual-era, the pure message handler, stdio, POST /mcp with
   its origin and header checks, a policy as tools and resources), the client
   (probe and fallback, elicitation, the HTTP header rules, tools as dispatcher
   handlers), and importing a tool list as action declarations with drift.
11. **Serving one policy over HTTP.** The five built-in routes, token auth,
   /dispatch's loopback rule, extra MCP and webhook routes, and a taken port
   stepped over instead of taken.
12. **The Claude, Codex and fx CLI adapters.** The default registry carries all
   three; configuration may repoint a command or cap its parallelism. Each
   adapter builds its own command line, prompt and timeout and maps the result
   or error. A writable Codex call passes
   `--approve-for-me` with `sandbox_workspace_write.network_access=true` and no
   `--sandbox`, because naming a sandbox alongside `--approve-for-me` conflicts;
   and `jev-provider/README.md` says so.

12a. **The Laya adapter** (`docs/laya.md`): open-weights decisions through an
   embedded Python bridge (`pip install laya`, no network egress, $0). Built
   into the default registry as `laya`, with `model` selecting `router`
   (default), `english`, `multilingual` or `typed-decisions`; questions are
   adapted and answers normalized inside the bridge, and the errors are
   classified (missing package = configuration, runtime failure = retryable).
   `test/laya.test.js` runs the real bridge against a stub `laya` package, so
   no weights are downloaded.

13. **Every broken policy.** `test/broken.test.js` shows each common policy
   mistake refused with the fix named.

14. **Installed evidence.** `tools/verify-portable.py` now also proves that every
   entrypoint in the published `exports` map resolves from the installed package
   and that the dispatcher runs a handler there.
   `tools/linux-check.sh` repeats it in a Debian container on Linux aarch64 and
   passes: the TypeScript tests, the type tests, the Python tests and
   `verify-portable.py`.

15. **The hosted product** lives in `packages/jev-cloud`: the store (SQLite and PostgreSQL),
   accounts and scoped API keys, projects, immutable deployments with promotion
   and rollback, sealed secrets scoped to one call, evaluate/dispatch with
   idempotency claims, traces and replay, a leased job queue, quotas, a billing
   report, per-tenant rate limiting, password sign-in, the dashboard, a container
   and operating documentation; mail, invitations and password resets on
   single-use hashed tokens; Stripe delivery (the customer mapping, a closed
   month reported once, the signed webhook back). 50 tests and 6 browser tests,
   no network.
16. **A durable answer cache** (`docs/answer-cache.md`): `dbAnswerCache` over any
   SQL driver (preload, flush, prune), `answerRecord`, and `cacheOnly` on
   `evaluateWithProvider`. `examples/entity-alignment.js` is gated, since
   `nearest()` rounds an unsure answer into a merge. JavaScript only;
   `test/answer-cache.test.js`.

## Next, in order

1. **Finish the hosted product**: an actual deployment, which needs the owner's
   call on where. The dashboard is now driven through a real browser by
   `npm run test:browser` (Playwright, no network), and email delivery,
   invitations and password resets are in, on an `EmailSender` with a console and
   an SMTP sender written on node:net/node:tls.
2. **Release**: what is left is the release itself — version and spec updates
   across the packages, and publishing under the settled names. The full offline
   verify loop passes, and the install check has run on
   macOS arm64 and on Linux aarch64. Other platforms (Linux x86_64, Windows)
   have not been tried.

## Known limits

- **Source locations.** A clause's source text, file and line come from the host
  language.
- **Code lookup** (`jev/code`) needs an SGX executable and is out of scope until
  the rest lands.
