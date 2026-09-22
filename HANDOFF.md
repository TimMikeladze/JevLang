# Portable platform: where the work stands

The contract is [portable-platform.md](../jev-lang/docs/portable-platform.md);
the evidence table is [COMPATIBILITY.md](COMPATIBILITY.md). This file is the
working note: what is finished, what is next, and how each piece was proved.

## How this port is checked

Every slice is compared against the Racket implementation as an oracle, over
shared data rather than restated expectations:

| Oracle | What it pins down |
| --- | --- |
| `test/oracle.rkt` | ticket-router over all 11 synthetic and real fixtures |
| `test/names-oracle.rkt` + `test/parity/names.rkt` | option code names against wire keys, named levels, raw questions, extra body |
| `test/reference-oracle.rkt` | dispute-review, triage-fanout, guardrails, smart-home: questions, built state, decisions, readings, action JSON Schema, token fit |
| `test/monitor-oracle.rkt` + `test/parity/calibration-cases.json` | the summary over 71 decisions, and the reliability table |
| `test/monitor-text-oracle.rkt` + `test/parity/stability-cases.json` | the two-window comparison, the stability statistics, and every text report |
| `test/routing-oracle.rkt` + `test/parity/routing-scenarios.json` | provider resolution over 17 scenarios |
| `test/command-oracle.rkt` | the `jev-provider/1` wire request and result mapping |
| `test/evaluate-oracle.rkt` | the answer schema and the prompt a policy sends |
| `test/dispatch-oracle.rkt` + `test/parity/dispatch-scenarios.json` | cascade dispatch over 16 scenarios, audit record for audit record |
| `test/journal-oracle.rkt` + `test/parity/journal-ops.json` | the journal's claims, budgets and schedules, in memory and in SQLite |
| `test/mcp-import-oracle.rkt` + `test/parity/mcp-import-cases.json` | importing a tool list as action declarations, and the drift report |
| `test/mcp-oracle.rkt` | the MCP server's replies over a recorded session and ten more messages |
| `test/automation-oracle.rkt` | the file-handler template grammar and the clarify merge |
| `test/state-oracle.rkt` | redaction and caps over every string in the Racket regression tests |
| `test/reference-extra-oracle.rkt` | hello, ticket-router-v2's on-read gates, entity-alignment's ungated score, extraction's runtime options and noul family |
| `test/cli-adapters-oracle.rkt` + `test/parity/cli-adapter-scenarios.json` | the Claude, Codex and fx command lines and their mapped answers over 14 scenarios |

Nothing in the suite reaches the network. The HTTP behaviour is exercised
against a local `node:http` server, and providers against fake executables.

Run it all: `bun install && bun test && bun run test:types` in `packages/jevlang`,
`python3 -m unittest discover -s tests` in `packages/jevlang-python`, and
`python3 tools/verify-portable.py` from the repo root.

**Python runs the whole product natively; the Node wrapper is gone.** All
three slices of `jev-lang/docs/python-port.md` landed: a native Python engine
inside `packages/jevlang-python/jevlang/` covers validation, decisions, state,
fixtures, monitoring, cost, providers, evaluate, record, dispatch, journals,
batch, pipelines, handlers, the event loop, sessions, MCP (server, client,
import), the gate and its hooks, webhooks, the wiring spool, harvesting and
serving — checked against the Racket oracles (`tests/test_racket_oracle.py`
plus the routing, CLI-adapter, journal, dispatch, automation, mcp,
mcp-import, gate, webhooks and harvest oracles) and byte-identical to this
engine's text reports (`tests/test_differential.py`). The subprocess wrapper,
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
   Claude and Codex hooks with one-shot approvals whose fingerprints match the
   Racket implementation's, and the MCP proxy with signed, single-use approvals.
10. **MCP.** The server (dual-era, the pure message handler, stdio, POST /mcp with
   its origin and header checks, a policy as tools and resources), the client
   (probe and fallback, elicitation, the HTTP header rules, tools as dispatcher
   handlers), and importing a tool list as action declarations with drift.
11. **Serving one policy over HTTP.** The five built-in routes, token auth,
   /dispatch's loopback rule, extra MCP and webhook routes, and a taken port
   stepped over instead of taken.
12. **The Claude, Codex and fx CLI adapters.** The default registry carries all
   three; configuration may repoint a command or cap its parallelism. Each
   adapter's command line, prompt, timeout and mapped result or error match the
   Racket adapter's over 14 shared scenarios. A writable Codex call passes
   `--approve-for-me` with `sandbox_workspace_write.network_access=true` and no
   `--sandbox`, because naming a sandbox alongside `--approve-for-me` conflicts;
   both implementations do that, and `jev-provider/README.md` says so.

13. **Every reference policy, and every broken one.** The differential now
   covers all of `jev-lang/examples/` but the two code-lookup examples, and
   `test/broken.test.js` shows each mistake in `examples/broken/` refused here
   with the same fix named, while Racket still refuses all eleven files.

14. **Installed evidence.** `tools/verify-portable.py` now also proves that every
   entrypoint in the published `exports` map resolves from the installed package
   and that the dispatcher runs a handler there, with no Racket on PATH. The
   Racket verify loop and a clean rebuild pass: 873 tests across the five
   packages, 632 for jev-lang alone. A stale `.zo` will report a
   `mcp-close` linklet mismatch; rebuild rather than chase it.
   `tools/linux-check.sh` repeats the portable side in a Debian container on
   Linux aarch64 — Racket 9.3 from download.racket-lang.org, because Debian's
   8.7 is older than the `base` these packages need — and passes: 122 TypeScript
   tests with every Racket oracle, the type tests, 12 Python tests and
   `verify-portable.py`. The published names are settled and written down in
   `portable-platform.md`; nothing has been published.

15. **The hosted product** lives in `packages/jev-cloud`, designed in
   `jev-lang/docs/hosted-platform.md`: the store (SQLite and PostgreSQL),
   accounts and scoped API keys, projects, immutable deployments with promotion
   and rollback, sealed secrets scoped to one call, evaluate/dispatch with
   idempotency claims, traces and replay, a leased job queue, quotas, a billing
   report, per-tenant rate limiting, password sign-in, the dashboard, a container
   and operating documentation; mail, invitations and password resets on
   single-use hashed tokens; Stripe delivery (the customer mapping, a closed
   month reported once, the signed webhook back). 50 tests and 6 browser tests,
   no network.

## Next, in order

1. **Finish the hosted product**: an actual deployment, which needs the owner's
   call on where. The dashboard is now driven through a real browser by
   `npm run test:browser` (Playwright, no network), and email delivery,
   invitations and password resets are in, on an `EmailSender` with a console and
   an SMTP sender written on node:net/node:tls.
2. **Release**: what is left is the release itself — version and spec updates
   across the packages, and publishing under the settled names. The differential
   covers every reference policy and every broken example, the full offline
   verify loop and a clean Racket rebuild pass, and the install check has run on
   macOS arm64 and on Linux aarch64. Other platforms (Linux x86_64, Windows)
   have not been tried.

## Known differences that are deliberate

- **Fixture identity.** Racket's `questions_sha256` folds Racket-printed
  templates into the hash for a policy with runtime questions, which no other
  language can reproduce. The portable engine has its own identity over the
  state-independent questions plus a portable template description, and a
  fixture that recorded its questions is compared against those instead. Replay
  says which check ran.
- **Source locations.** A clause's source text, file and line come from the host
  language, so they differ; the differential tests compare everything else.
- **Prompt key order.** The prompt embeds the state and questions as JSON, and
  neither implementation canonicalizes it, so the bytes differ while the content
  matches.
- **Compile-time option sources.** `include-questions`, `#:options-file` and
  `#:options` are Racket-time mechanisms; the portable builders express those in
  host code.
- **Code lookup** (`jev/code`) needs an SGX executable and is out of scope until
  the rest lands.
