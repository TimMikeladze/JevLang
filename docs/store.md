# Spec: `jevlang/store` — decision records in a place you choose

The engine decides in memory; the journal covers dispatch durability (steps,
cooldowns, budgets, scheduling); Jev Cloud stores traces hosted. What is missing
is a library-level way to persist **decision records** — input, answers,
decision — so an embedded app can keep its own history, replay it with
`replay`, and summarize it with `monitor`.

## What we build

One module, `jevlang/store`, following the Journal's shape (interface, memory
backend, SQL backend over any driver, SQLite file backend), plus one plumbing
point (`makeLoop({ store })`) and one wrapper (`withStore(evaluate, store)`).

### The record

A store record is plain JSON:

```
{ id, at, policy, input, answers, decision, key }
```

- `id` — optional; defaults to `fingerprint` of the rest, so recording the same
  run twice is idempotent (the second append returns the first id and stores
  nothing).
- `at` — ms epoch; defaults to now.
- `policy` — a name string the caller chooses (not the compiled policy).
- `input` / `answers` / `decision` — exactly what `evaluateWithProvider` saw and
  returned (`answers` may be null for offline decides).
- `key` — optional correlation key (dispatch key, request id).

### The interface

```
Store {
  append(record): Promise<id> | id
  get(id): Promise<record | null> | record | null
  list({ policy?, since?, limit? }): Promise<record[]> | record[]   // newest last
  close(): void | Promise<void>
}
isStore(value)
```

### Backends

- `memoryStore()` — arrays; tests and scratch use.
- `ndjsonStore(path)` — append-only JSON-lines file; one record per line, read
  back on `list`/`get`. The zero-dependency default.
- `dbStore(driver, { dialect, prefix })` — any `SqlDriver` (same contract as
  `dbJournal`); table `prefix + 'decisions'`, `id` primary key,
  `ON CONFLICT DO NOTHING` for idempotency. Postgres and SQLite dialects.
- `sqliteStore(path)` — opens the file itself (WAL, like `sqliteJournal`).
- `redisStore(client, { prefix, ttl })` (`jevlang/redis`) — one key per record
  plus sorted-set indexes by time and policy; `ttl` seconds gives retention
  without a cleanup job. For serverless; see `docs/production-readiness.md`.

`list({ limit })` returns the newest `limit` records, oldest first, on every
backend.

### Integration

- `withStore(evaluate, store, { policy })` — wraps any `evaluate(input)` (the
  function `evaluateWithProvider`, `makeLoop`, `serve` and `resolve` all take);
  records input + decision, passes the decision through. Recording never
  changes the answer: a store error rejects, a null decision is not recorded.
- `makeLoop({ store })` — records every event's input and decision.
- `recordsFor(decisions, ...)` is deliberately **not** built: `list()` returns
  records whose `decision` field feeds `summarize` / `calibrate` directly, and
  whose `input`+`answers` feed `replay`/`tune` via `fixtureFromRun`.

## Tests

`test/store.test.js`: record normalization and fingerprint idempotency; memory,
ndjson (tmp file), SQLite (node:sqlite) round-trips; `withStore` passthrough and
recording; loop `store` option. No Racket oracle — this is host-side
infrastructure like the journal's SQL layer (its oracle covers engine semantics,
not SQL).

## Docs

README bullet under "Everything else in the box" with a runnable example.
