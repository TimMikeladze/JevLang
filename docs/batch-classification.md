# Fast bulk classification

Running one policy over thousands of rows should cost about one model call per
distinct row, and nothing else. It didn't: each `evaluateWithProvider` call
without a `registry` built a fresh registry, and resolving a provider
discovered every registered provider, which started `claude`, `codex` and `fx`
processes. That took ~900 ms per row before any model was asked, even for an
HTTP provider.

## Decided

1. **Discover lazily.** `resolveProvider` discovers only the candidates it
   tries, in order, and stops at the winner. Only a `ready` result is cached,
   so a key set or a login made after a miss is seen on the next call. Ported
   to the Python engine (`_provider.py`).
2. **One default registry per configuration.** When no `registry` is passed,
   `evaluateWithProvider`, `runPolicyProvider` and `evaluateConfiguredPolicy`
   reuse one registry per canonical configuration. Discovery results and
   parallelism slots are then shared across calls, so `max_parallel` holds
   across concurrent calls instead of per call. `providers.<id>.max_parallel`
   now also sets the limit for `typesafe`, `openai`, `gateway` and `anthropic`
   (the defaults stay 4, 8, 8 and 8, matching Racket). A batch with more
   workers than the provider's limit runs at the limit.
3. **Answer cache.** `evaluateWithProvider(policy, input, { cache })` takes a
   Map-like store with synchronous `get`/`set` (optional `delete`) that holds
   each call's promise. The key is a fingerprint of the built state, the
   questions and the provider/model/effort selection. It leaves out the routes,
   so a route edit keeps the cache. The lookup and the claim happen with no
   `await` between them, so rows that start together share one call. A failed
   call is not cached. The rules still run on every row with that row's own
   facts, and a decision whose answers came from the cache carries
   `cached: true`.
4. **`jev batch POLICY.json ROWS.ndjson`** (`-` reads stdin). It runs
   `evaluateMany` with an in-memory answer cache and writes one line per row to
   stdout in input order: `{"row":i,"decision":…}` or `{"row":i,"error":…}`.
   A summary goes to stderr (rows, failed, cached, input tokens, seconds). It
   warns when `--workers` exceeds the chosen provider's parallelism limit. Flags:
   `--workers` (8), `--rpm` (1200), `--provider`, `--model`, `--effort`. The
   exit code is 1 if any row failed.

## Not changed

Engine semantics, decisions, wire prompts and fixtures. The Racket and Python
oracles still pass unchanged. Items 2–4 are JavaScript only.
