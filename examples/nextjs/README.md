# JevLang on Next.js

This app serves jevlang.sh as well: the landing page and reference at `/` and
`/reference` (built from `site/` by `npm run site`, which `dev` and `build` run
first), and the three demos under `/examples/<name>`, reached from the Examples
dropdown in the site's nav. Every page shares the site's header and footer.

Three API routes, each backed by a policy, each with its own UI. The model
answers a couple of questions; the policy — plain code — decides, using facts
from your own systems that never leave the server. Every decision is logged to
Upstash Redis (in memory when no Redis is configured) and expires on its own;
live model calls are rate limited per client.

- **Tenant hotline** — `POST /api/maintenance`. A gas smell at 3am pages
  on-call; a drip at noon goes to today's plumber; chipped paint waits.
- **Restaurant SMS host** — `POST /api/reservation`. An EpiPen mention alerts
  the kitchen; a full house offers the waitlist; 14 people go to the events manager.
- **Courier app** — `POST /api/doorstep`. Price and rain decide door vs locker
  vs tomorrow; a loose dog means nobody risks it.

```sh
npm install
npm run dev        # next dev on a free port; log and rate limits in memory
npm run dev:redis  # + Redis and the Upstash REST proxy in Docker, on free ports
npm test           # bun: policies, the decision log, rate limits
```

Styled with the jevlang.sh design system (dark, light and system themes). Each
page shows the JevLang policy side by side with the UI and highlights the
clause that decided. Answer the model's questions yourself with sliders, or flip
to the live model: set `TYPESAFE_API_KEY` in `.env.local`, or pick another
provider with `JEV_PROVIDER` — `gateway` (Vercel AI Gateway, `AI_GATEWAY_API_KEY`),
`openai` (`OPENAI_API_KEY`) or `anthropic` (`ANTHROPIC_API_KEY`).

```sh
curl localhost:3000/api/reservation -d '{
  "input": { "message": "Table for 4 Sat 7pm? My son carries an EpiPen", "partySize": 4, "seatsFree": 12 }
}'
# {"action":"assign","target":"confirm-and-alert-kitchen","reason":"serious allergy flagged on the ticket", ...}
curl localhost:3000/api/reservation   # newest logged decisions
```

Pass `answers` alongside `input` to skip the model (demos, tests, replays).
Live model calls are capped at `LIVE_PER_CLIENT_PER_HOUR` (default 5) per
client and `LIVE_PER_DAY` (default 200) for the whole site; over either is a
429. Offline answers are never limited.

## Deploying

The Vercel project's Root Directory is `examples/nextjs`: one deploy serves the
landing page and the examples. Add Upstash Redis from the Vercel Marketplace (sets `KV_REST_API_URL` and
`KV_REST_API_TOKEN`; `UPSTASH_REDIS_REST_URL`/`_TOKEN` work too). Optionally set
`DECISION_RETENTION_HOURS` (default 24), `LIVE_PER_CLIENT_PER_HOUR` (default 5),
`LIVE_PER_DAY` (default 200), and a provider: `TYPESAFE_API_KEY`, or
`JEV_PROVIDER=gateway` (with `JEV_GATEWAY_MODEL`), which authenticates with the
deployment's OIDC token and needs no key. In production the live model stays
off until Redis is connected, so the caps are shared. No cron: records expire
in Redis.

Design notes: [docs/nextjs-example.md](../../docs/nextjs-example.md).
