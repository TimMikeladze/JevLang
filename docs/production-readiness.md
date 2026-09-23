# Production readiness: serverless, Redis, rate limits

Goal: run JevLang for real on Vercel (many short-lived instances, no local
disk) with Upstash-style Redis for shared state. Good enough, not perfect.

## Decisions

- **One Redis interface: `{ eval(script, keys, args) }`.** That is the
  `@upstash/redis` signature, so an Upstash client passes straight in. Every
  operation is one Lua script, so each claim is atomic across instances.
  `upstash()` is a zero-dependency client over Upstash's REST API (`fetch`),
  reading `UPSTASH_REDIS_REST_URL`/`_TOKEN` or Vercel's `KV_REST_API_URL`/`_TOKEN`.
  `fromIoredis(client)` and `fromNodeRedis(client)` adapt the other two.
  No vendor SDK is a dependency.
- **Rate limits are budgets with an amount of 1.** `claimBudget(name, now,
  window, amount, max)` is already a sliding-window counter on every journal.
  New: `rateLimit(journal, name, { max, per })` returns `take(key)` →
  `{ ok }`, for route handlers; and `budget(name, { by })` keys a dispatch
  budget per customer/target. No new policy-JSON primitive, so fingerprints
  and Python parity are untouched.
- **Redis journal, store and session table** (`jevlang/redis`):
  `redisJournal`, `redisStore`, `redisSessions`. Budget usage and store records
  expire by TTL, so retention is free.
- **Step leases.** A step left `running` by a crashed or frozen instance is
  reclaimed after `stepLease` seconds (dispatcher option; off by default to
  keep today's "never re-run an uncertain step" behaviour).
- **Scheduled-work leases.** `takeDue(now, lease)` pushes items forward by the
  lease instead of deleting them; `runDue` deletes each after it runs. A crash
  mid-run re-delivers instead of losing work. Without a lease, behaviour is
  unchanged. On serverless, call `runDue` from a cron route; don't rely on the
  in-process timer.
- **Sessions take a table** (`get/set/delete`, sync or async), so a clarify
  round-trip survives landing on another instance.
- **Direct HTTP providers**: `openai` (any OpenAI-compatible endpoint),
  `gateway` (Vercel AI Gateway, the same code with its base URL), `anthropic`.
  `fetch` only; registered in the policy registry and ready when their key is
  set. (The TypeSafe provider was already HTTP.)
- **SQL fixes**: `nextDue` coerces `BIGINT` strings (node-pg); indexes on
  `budget_usage(name, at)`, `scheduled(due_at)`, store `(policy, at)`.
- **Security**: `serve` caps bodies (1 MB), sets timeouts, refuses a
  non-loopback host without a token, returns generic 500s; the http handler
  refuses a placeholder in the URL's host unless `allowHosts` lists it; the
  shell handler refuses substituted values starting with `-`; child processes
  get an allowlisted environment, not all of `process.env`.

## Out of scope

OTel, canary rollout, multi-tenancy, review-queue UI, decision cache, the
filesystem webhook spool on serverless, Python mirrors of the Redis adapters.

## Next.js example

- Decision log moves from Vercel Blob to the jevlang `Store` abstraction:
  `redisStore(upstash())` when Upstash env is set, `memoryStore()` otherwise.
  Retention is a TTL, so the prune cron goes away.
- Live model calls are rate limited per client IP with `rateLimit` on a
  `redisJournal` (memory fallback); over the limit is a 429.
- `JEV_PROVIDER` picks `typesafe` (default), `gateway`, `openai` or `anthropic`.
- `npm run dev` needs nothing; with Docker it can run Redis plus the Upstash
  REST proxy (`npm run dev:redis`).
