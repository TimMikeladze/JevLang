# Brief: JevLang Cloud as a generic SaaS

**The ask:** turn what we hand-built for jevlang.sh into a hosted product.
Every team that ships a JevLang policy should get it for free, and it should be
multi-tenant and multi-user.

**The short answer:** `jevcloud` already solves the account side: tenancy,
keys, immutable deployments, traces, replay-gated promotion, quotas and
Stripe. What it lacks is the **runtime layer** we spent this session
assembling by hand:
- shared state
- rate limits
- model spend control
- safe public endpoints
- a playground
- agent-readable docs

Ship those as managed primitives behind the interfaces `jevlang` already
exposes. Self-hosted code then moves to the cloud with a one-line import
change, and back again.

## Where it lives

- **`jevcloud-next`** is the product: the Next.js app on Vercel with the
  dashboard, API, tenancy, BYOK secrets, limits, playground, review queue and
  billing. All the cloud work lands here.
- **`jevcloud`** (Bun) is the reference it catches up to. Its remaining
  surface (replay gates, secrets, billing, webhooks, schedules) gets ported,
  then it's retired.
- **`jevlang`** stays the engine, and keeps anything a self-hosted user also
  needs: `jevlang/redis`, `rateLimit`, the HTTP providers, and a new
  `jevlang/cloud` client. The cloud imports these rather than forking them,
  so a decision in the cloud is the same decision on a laptop.

## Principle: bring your own everything

Every managed piece has a bring-your-own option, chosen per project in config,
with the same code path either way:

| Piece | Managed default | Bring your own |
|---|---|---|
| Model keys | Metered through our gateway | Their OpenAI, Anthropic or AI Gateway key, stored as an encrypted secret; we never mark up BYOK calls |
| Model endpoint | AI Gateway | Any OpenAI-compatible URL (`openaiProvider({ baseURL })`), their own Vercel AI Gateway, or self-hosted Laya |
| State (journal, limits, sessions) | Our Upstash, namespaced per tenant | Their Upstash or Redis URL, or Postgres (`dbJournal`) |
| Traces and decision store | Our Postgres, with retention by plan | Their Postgres or a stream to their bucket; we keep only the counts billing needs |
| Handlers | Egress-limited http/webhook, Sandbox for code | Their own runner, which pulls work (keys and systems stay on their side) |

BYOK is the default for the Free tier and always available on paid tiers. The
spend cap and rate limits apply either way, because the cap also protects the
customer's own key.

## What we solved by hand, and what it becomes

| We did, for one site | Every customer hits it | Cloud primitive |
|---|---|---|
| Provisioned Upstash, wrote `redisJournal`/`redisStore`, `JEV_STATE` switch | State that survives many serverless instances | **Managed state:** per-project journal, store, sessions and limits behind `cloudJournal(key)`, the same `Journal`/`Store` interfaces |
| `rateLimit` per IP and per day, in-memory fallback | Public routes get abused | **Edge limits:** per-project, per-end-user and per-key limits, declared in project config and enforced before any model call |
| Gateway + OIDC + cheapest model + spend worries | Model cost is unbounded | **Metered model access:** a managed gateway with a per-tenant hard spend cap, a model allowlist, and BYOK stored as encrypted secrets |
| Demo calls from the browser, no key | Browser and mobile apps can't hold secrets | **Publishable keys:** browser-safe, scoped to evaluate one project, with an origin allowlist and a built-in end-user limit |
| The four-step demo flow (`Flow.js`) | People need to see and test a policy | **Hosted playground** generated from the deployment: questions, facts and outcomes, with shareable scenario links, and a scenario can be saved as a fixture |
| Decision log with TTL, a preview flag | Audit, debugging, retention law | **Traces** (exist) plus retention per plan, redaction on write, export (S3/BigQuery), and "don't record" for previews |
| Hand-written `llms.txt`, `AGENTS.md`, curl samples | Their agents need to call the policy | **Generated agent docs** per deployment: OpenAPI, `llms.txt`, `AGENTS.md`, MCP tool and SDK snippet, always matching the fingerprint |
| `escalate` goes nowhere in the demo | Escalations need a human | **Review queue:** escalations land in an inbox, get assigned and resolved, and the answer becomes a labeled fixture |
| Upstash terms, env vars, root dirs | Setup friction | **One-click projects:** template policies like the three examples, deploy, get a URL |

## Built on Vercel

The whole product runs on Vercel, using the platform's primitives rather than
our own infrastructure:

| Need | Vercel piece |
|---|---|
| App, API, dashboard | One Next.js app (`jevcloud-next`) on Fluid Compute, Node.js runtime |
| Control-plane database | Neon Postgres from the Marketplace (Drizzle, row-level security on `org_id`) |
| Hot state, limits | Upstash Redis from the Marketplace, through `jevlang/redis` |
| Model calls | AI Gateway: managed usage bills through our team, BYOK passes the customer's key through the Gateway's own BYOK support; OIDC, so we hold no gateway key |
| Dispatch, retries, webhooks out | Vercel Queues (at-least-once) replacing `jevcloud`'s job table; handlers are queue consumers |
| Schedules, `runDue`, retention | Vercel Cron routes |
| Custom handler code | Vercel Sandbox, with CPU/time caps and an egress allowlist |
| Abuse on public keys | Vercel Firewall rate rules plus BotID in front of publishable-key routes; our per-end-user limits behind them |
| Hot deployment pointer | Global Config (production fingerprint per project), so evaluate never reads Postgres |
| Trace export, artifacts | Private Vercel Blob |
| Our own releases | Rolling Releases; preview deployments per PR |
| Customer onboarding | A Vercel Marketplace integration that provisions a project and sets `JEV_KEY` |

A customer on Vercel installs the integration and never leaves the platform.
Everyone else calls the same HTTPS API.

## Multi-tenant shape

- **Two planes.**
  - The *control plane* is the Next.js app with Neon Postgres: orgs, users,
    keys, deployments, config, billing and the audit log.
  - The *data plane* is the same app's evaluate/dispatch routes: stateless
    functions, Redis for hot state, and Global Config for the production
    pointer, so the hot path never touches Postgres.
- **Isolation by construction.**
  - The tenant comes from the credential, never the path. `jevcloud` already
    enforces this, and a wrong tenant gets a 404.
  - Every Redis key is prefixed `t:{org}:p:{project}:`. The journal is created
    with that prefix server-side, so tenant code can't reach another tenant's
    namespace.
  - Postgres gets row-level security on `org_id` as a second wall.
- **Noisy neighbours.**
  - Each tenant gets a concurrency slot count (the provider registry's
    `withSlot`, lifted to the tenant) and a fair-share queue for dispatch.
  - One tenant's model rate limit never consumes another's gateway quota.
- **Handlers.**
  - `http` and `webhook` handlers run as-is, behind an egress allowlist and a
    block on private IPs (`allow_hosts` exists already).
  - `shell` is off in the cloud. Custom code runs in Vercel Sandbox with CPU
    and time caps, or in the customer's own runner.
- **Regions.** Start with one. The data plane is stateless apart from Redis,
  so adding an EU region means a Redis replica plus pinning tenants to it.

## Multi-user

- **Orgs by default** (as today). Roles:
  - `owner`: billing and deletion.
  - `admin`: keys, members and secrets.
  - `developer`: deploy previews.
  - `approver`: promote to production.
  - `reviewer`: work the escalation queue.
  - `viewer`.
- **Environments per project:** `dev`, `preview`, `production`, each with its
  own limits, secrets and state namespace.
- **Promotion policy:** production needs an approver, and optionally the
  replay-diff gate (which exists). Every action goes to the audit log.
- **SSO/SCIM** later, for the enterprise tier.

## The developer experience

```js
// Self-hosted today
const journal = redisJournal(upstash());
// Cloud: the same interface, the tenant from the key
import { cloud } from 'jevlang/cloud';
const jc = cloud({ key: process.env.JEV_KEY });                    // jev_live_… or jev_pub_…
const decision = await jc.evaluate('doorstep', input);            // limits, spend cap, trace: all server-side
const journal = jc.journal('doorstep');                           // drop-in for makeDispatcher({ journal })
```

- `jevlang/cloud` is a thin, dependency-free `fetch` client, like `upstash()`.
- The CLI adds `jev deploy`, `jev promote`, `jev logs` and `jev open`
  (playground).
- The Vercel Marketplace integration provisions a project and sets
  `JEV_KEY`, the same way Upstash did for us.

## Pricing sketch

- **Free:** one project, 1k decisions a month, 7-day traces, BYOK only.
- **Pro:** metered decisions. Model calls are BYOK at no markup, or managed
  pass-through at cost plus a margin. A hard spend cap is on by default, and
  traces keep 30 days.
- **Team/Enterprise:** roles and approvals, SSO, longer retention, export,
  a region choice and an SLA.

Offline `decide` (answers supplied) stays cheap or free, just as it costs
nothing on our demo.

## Build order

1. **BYOK and managed state.** Encrypted provider secrets wired through AI
   Gateway BYOK, plus `cloudJournal` and edge limits on Upstash (their Redis
   or ours), reusing the Lua scripts from `jevlang/redis`. This unblocks
   serverless customers.
2. **Publishable keys and the spend cap.** Safe browser use behind Firewall
   and BotID, with a hard stop on spend for managed and BYOK alike.
3. **Generated agent docs and the playground**, both from the deployment.
4. **Review queue**, with its answers turned into fixtures.
5. **Roles and environments.** Port `jevcloud`'s remaining surface (replay
   gates, billing, secrets) into `jevcloud-next` along the way.

## Open questions

- **Managed models at launch, or BYOK only?** BYOK is required either way.
  The question is whether managed pass-through ships on day one or follows
  once billing is ported.
- **Where does dispatch run for customers with private systems?** An agent or
  runner they host (like CI runners) would keep secrets on their side.
