# Durable answer cache

`evaluateWithProvider(policy, input, { cache })` already shares one call among
identical rows, but only in memory. A batch that re-runs on a schedule (every
worker tick, every night) needs the cache to survive the process. Then only
rows whose inputs changed are asked again, and every row is still re-decided,
so a route or threshold change reaches all of them at once. The app that asked
for this (a lead classifier re-run after every scrape) had built it by hand on
Postgres, reading provider-result fields that aren't a public shape.

## Decided

1. **`dbAnswerCache(driver, { dialect, prefix, scope })`** in `jevlang/store`.
   Any `SqlDriver` (the one `dbJournal` and `dbStore` take). Table
   `prefix + 'answers'`: `(scope, key)` primary key, the stored answer as JSON
   text, `at`. It is async because it preloads the scope's rows, and then it
   *is* an `AnswerCache`: synchronous `get` / `set` / `delete`, plus `has`.
   - `flush({ prune })` writes the answers added since the last flush. With
     `prune: true` it also deletes the scope's answers that no `get` or `set`
     touched since the cache was opened: their inputs changed, so nothing will
     ask for them again. It returns `{ saved, pruned }`. Failed calls are never
     written, since `evaluateWithProvider` deletes them.
   - `scope` separates policies (or environments) that share one table. The key
     is already a fingerprint of state, questions and provider selection, so
     scope is for pruning, not correctness.
2. **`answerRecord(result)`** in `jevlang`: the part of a provider result that
   `evaluateWithProvider` reads back from a cache (output, model, request id,
   the target's provider id, model and efforts), as plain JSON. The cache stores
   this, so a stored answer produces the same decision and provenance as the
   live one.
3. **`cacheOnly: true`** on `evaluateWithProvider`: decide from a cached answer
   or throw a `JevError` with code `uncached`, and never resolve a provider.
   Prechecks still decide first. This is for running without a key (CI, a
   read-only replica, a worker whose key is missing) without guessing: the caller
   sees exactly which rows had no answer. Provider configuration is now loaded
   only when a provider is actually asked.
4. **`examples/entity-alignment.js` gets a confidence gate.** `nearest()` rounds
   the answer's expected level, so an ungated three-level score merges a pair
   the model gave p≈0.3 for "same" (an expected level of about 1.5). Merges
   chain through union-find, and in the field that joined 19 unrelated
   companies that shared a filing agent's phone number. An unsure answer now
   goes to the curator.

## Not changed

Engine semantics, the wire, fixtures and the shared validator. Items 1–3 are
JavaScript only, like `jev batch`.
