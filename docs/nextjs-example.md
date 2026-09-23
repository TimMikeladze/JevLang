# Next.js example: policy-backed API routes

This app is also jevlang.sh. `/` and `/reference` are the static pages
`site/build.js` writes (`scripts/site.js` copies `site/out` into `public/` before
`dev` and `build`; `next.config.mjs` rewrites the two paths), and the demos live
under `/examples/<name>`, reached from the Examples dropdown in the site's nav
(there is no examples index; `/examples` redirects to the first demo). The demo
pages wear the site's own chrome: `scripts/site.js` renders the same header,
footer, theme script and styles `site/render.js` gives the landing page into
`app/_kit/chrome.json`, and `app/layout.js` wraps every page in them. Old demo
paths (`/doorstep`, ...) redirect. One deploy
serves both: the Vercel project's Root Directory is `examples/nextjs`.

`examples/nextjs` puts JevLang behind Next.js App Router route handlers. Each
route is a job teams usually hand to one big prompt, where a wrong branch has
a real cost:

| Route | Problem | Outcomes |
| --- | --- | --- |
| `POST /api/maintenance` | A tenant texts the building | page `emergency-oncall` on any hint of danger, page `plumber-oncall` / `hvac-oncall` when time or weather makes it urgent, otherwise the right day queue |
| `POST /api/reservation` | A restaurant's SMS host | `confirm-booking`, `confirm-and-alert-kitchen` for serious allergies, `offer-waitlist` when full, `events-manager` for big parties, `manager` for complaints |
| `POST /api/doorstep` | A courier asks where to leave a parcel | `hand-over`, `leave-at-door`, `parcel-locker`, `reattempt-tomorrow`, `call-recipient` |

## Decisions

- **Node.js runtime, not `runtime = 'edge'`.** Vercel deprecated the Edge
  runtime; Fluid Compute gives the same cold-start profile. JevLang also imports
  `node:crypto`, which the Edge runtime lacks.
- **Model only answers questions.** Handlers call `evaluateWithProvider` with
  the provider `JEV_PROVIDER` names: `typesafe` (default, `TYPESAFE_API_KEY`),
  `gateway` (Vercel AI Gateway; `AI_GATEWAY_API_KEY`, or the OIDC token on
  Vercel), `openai` or `anthropic`. All HTTP, so they run inside a function.
- **Offline mode.** A body with `answers` skips the model and calls
  `policy.decide`, so the demo, tests and replays work with no key.
- **Facts stay local.** Hour, temperature, party size, free seats, parcel value,
  rain: `local: true` state. Rules read them; the model never sees them.
- **Safety bars are low on purpose.** `danger?` pages at 0.3, `unsafe?` at 0.5.
- **Decision log on Upstash Redis.** After each decision, `after()` appends a
  record to `redisStore` from `jevlang/redis`: the policy fingerprint, the
  redacted state the model saw, the local facts and the readings. A store
  failure never delays or fails a decision. Records expire after
  `DECISION_RETENTION_HOURS` (default 24) by TTL, so there is no prune cron.
  `GET /api/<route>` returns the 10 newest. Without Upstash env the same code
  uses `memoryStore`.
- **Live model calls are capped twice.** `rateLimit(redisJournal(redis), ...)`
  allows `LIVE_PER_CLIENT_PER_HOUR` (default 5) per client IP and
  `LIVE_PER_DAY` (default 200) for the whole site, across every instance; over
  either is a 429. `JEV_STATE` picks where the counts live: `memory` (each
  instance counts on its own, so the caps hold per instance), `upstash`
  (shared), or unset for Upstash when its env is present. Offline
  `answers` are never limited: they cost nothing. Production uses
  `JEV_PROVIDER=gateway` with `JEV_GATEWAY_MODEL=google/gemini-2.5-flash-lite`,
  the cheapest and fastest model that answered correctly in testing.
- **Local Redis = Docker.** `npm run dev` needs nothing (memory). `npm run
  dev:redis` starts Redis and the Upstash REST proxy
  (`hiett/serverless-redis-http`) on free ports and points the app at it, so
  dev runs the Vercel code path. `next dev` takes the first free port from 3000.
- **npm, not bun, for install.** Bun's `file:../..` copies the repo, including
  this example, into itself; npm symlinks. `next.config.mjs` widens the Turbopack
  root to reach the symlink. An app installing jevlang from npm needs neither.
- **Response:** `{ action, target, reason, explanation, fingerprint, decision }`;
  bad input or answers are 400, rate limited 429, missing key 503, model
  failure 502.

## Pieces

- `lib/policies.js` — the three policies.
- `lib/handle.js` — shared POST handler: provider choice, rate limit, errors.
- `lib/backend.js` — Redis or memory: the decision log and the rate limiter.
- `lib/route.js` — `policyRoute(policy)`: the POST and GET every route exports.
- `app/api/*/route.js` — one line each.
- `scripts/site.js` — builds the landing page and copies it into `public/`.
- `app/examples/maintenance`, `app/examples/reservation`, `app/examples/doorstep` — one UI per route: a
  tenant text thread, a host-stand SMS console, a courier app. Each lets you
  play the model (sliders per question) or use the live model, and shows the
  decision, its readings and the decision log.
- `lib/source.js` — reads each policy's block from `lib/policies.js` at build
  time and maps `$.gates[i]` / `$.route.clauses[i]` / `$.route.otherwise` to
  source lines. Every demo shows the policy beside the UI and highlights the
  clause that decided.
- `app/layout.js`, `app/_kit/chrome.json` (generated) — the site's header with
  the Examples dropdown, footer, theme script and chrome styles.
- `app/globals.css`, `app/_kit/icons.js` — page styles for the demos: frames,
  controls and decision colours (green assign, amber escalate/page, red hold).
- `app/_kit/kit.js` — shared client pieces.
- `scripts/dev.js` — `next dev` on a free port; `--redis` adds Redis in Docker.
- `lib/*.test.js` — offline decisions, the decision log (memory, and Redis
  when `JEV_TEST_UPSTASH_URL` is set), rate limits and provider errors
  (`npm test`, runs with bun).
