# The hosted product

Verbatim extract of four sections of the jevcloud-next README (the Next.js
Jev Cloud at cloud.jevlang.sh). Re-copy them when the sibling changes; the
landing page reads this file at build time and the site test checks each
section against the sibling repo when it is cloned.

## Bring your own everything

Every managed piece has a bring-your-own option, chosen per environment, with
the same code path either way.

| Piece | Managed | Bring your own |
| --- | --- | --- |
| Model keys | AI Gateway on the deployment's OIDC token, so we hold no gateway key | Your OpenAI, Anthropic or AI Gateway key, sealed as a secret. Never marked up |
| Model endpoint | AI Gateway | Any OpenAI-compatible URL, including a self-hosted one |
| State (journal, limits, budgets) | Our Upstash, namespaced per tenant | Your Upstash, or your Postgres |
| Traces | Our Postgres, retention by plan, redaction on write | Your Postgres, or nothing at all |
| Handlers | `http` and `webhook` behind an egress allowlist | Your own runner |

The rate limits and the hard spend cap apply to your own key too, because the
cap protects you as much as us.

## The API

Every route under `/api/v1` needs `Authorization: Bearer jev_live_...`. The
organization comes from the credential, never from the path, so a request
cannot name another tenant's resource: a wrong tenant is a 404, never a 403
that admits the resource exists. `x-jev-environment` picks `dev`, `preview` or
`production`; production is the default.

| | |
| --- | --- |
| `POST /api/v1/projects` | create a project, with its three environments |
| `GET /api/v1/projects` | this organization's projects |
| `GET /api/v1/projects/:slug` | one project, its environments and what each serves |
| `PUT /api/v1/projects/:slug` | replace one environment's configuration |
| `POST /api/v1/projects/:slug/deployments` | publish a policy artifact — the first becomes production, later ones move dev and preview |
| `GET /api/v1/projects/:slug/deployments` | newest first |
| `POST /api/v1/projects/:slug/promote` | `{deployment, expect}` moves production; `{deployment, gate}` replays real traces first and refuses when too much changed |
| `POST /api/v1/projects/:slug/replay-diff` | production's recent traces decided again against another deployment; a trace whose inputs cannot be rebuilt is counted as refused, never skipped |
| `POST /api/v1/projects/:slug/evaluate` | ask the model the policy's questions, then decide |
| `POST /api/v1/projects/:slug/decide` | decide on answers you already have; no model is asked |
| `POST /api/v1/projects/:slug/dispatch` | decide, then run the project's handlers (`dry_run` rehearses) |
| `POST /api/v1/projects/:slug/state` | the project's managed journal: steps, cooldowns, budgets, scheduled work |
| `GET /api/v1/projects/:slug/traces[/:id]` | what happened, newest first |
| `POST /api/v1/projects/:slug/traces/:id/replay` | one trace decided again, against another deployment |
| `GET/PUT/DELETE /api/v1/projects/:slug/secrets[/:name]` | names, versions and a hint; values never come back |
| `GET/PATCH /api/v1/projects/:slug/escalations[/:id]` | the review queue; a resolution becomes a labeled fixture |
| `GET/POST /api/v1/projects/:slug/fixtures` | what the project keeps to replay |
| `GET /api/v1/projects/:slug/docs/:file` | generated per deployment: `openapi.json`, `llms.txt`, `AGENTS.md`, `mcp.json`, `snippets.md` |
| `GET/POST /api/v1/keys`, `DELETE /api/v1/keys/:id` | credentials |
| `GET /api/v1/usage` | rows, and a total that separates money from estimates |
| `GET/PUT /api/v1/billing`, `POST /api/v1/billing/report` | the plan and its limits (from one config), the Stripe mapping, and reporting a closed month |
| `GET /api/v1/audit` | what changed, and who did it |
| `POST /api/v1/stripe/webhook` | the only writer of subscription state: Stripe signs, the raw body is verified, and the projection is idempotent |
| `POST /api/public/evaluate` | the browser door: a publishable key, an origin allowlist, an end-user limit |

Scopes are `evaluate`, `dispatch`, `deploy` and `read`; a key missing one is
told which it needs. A key also carries one of six roles, and cannot be minted
with more than the person minting it has. `Idempotency-Key` on evaluate and
dispatch makes a retry return the first answer instead of paying or acting
twice.

A deployment is immutable. The first one a project publishes becomes
production; later ones move dev and preview until they are promoted. `expect`
on a promotion is the version the caller believes production to be, so two
promotions racing cannot both win, and a rollback is a promotion back to an
earlier deployment. Nothing a deployment did is undone by a rollback: it moves
a pointer.

## Billing

Three plans — Free, Pro ($24/seat/month), Team — defined once in
`src/lib/plans.ts`, which the pricing page, the gates and the tests all read,
so they cannot drift apart ([docs/billing.md](docs/billing.md)). Pro is
Stripe-hosted Checkout at the member count, with everything after the first
payment in the Customer Portal; Team is a conversation and a `mailto:`. A
signature-verified webhook is the only writer of subscription state, a lapsed
payment keeps what was bought while the free limits apply, and a hand-set
Team plan survives any Stripe event. Without `STRIPE_SECRET_KEY` and
`STRIPE_PRICE_ID_PRO` both set, billing is off and every limit is unlimited —
a self-hosted deployment is not a crippled one. `bun run stripe:setup` creates
the Stripe objects idempotently and prints what to paste; a public
[`/pricing`](https://cloud.jevlang.sh/pricing) page is generated from the same
config.

Bring your own everything: model keys and endpoints, Redis or Postgres for
state, and where traces are kept, chosen per environment. The rate limits and
the hard spend cap apply to a customer's own key too, because the cap protects
them as much as us — and usage on their key is never marked up.

The dashboard signs a person in with an email and password (better-auth,
scrypt-hashed, never stored in the clear). Organizations are the default:
signing up creates one you own, and people you invite join yours, with one of
six roles — owner, admin, developer, approver, reviewer, viewer — enforced
server-side on every route and action.

## Isolation, by construction

- **The tenant comes from the credential.** Every store function takes the
  organization first; a wrong tenant is the 404 an unknown slug gets.
- **Every Redis key and every journal name is prefixed** `t:{org}:p:{project}:e:{env}:`
  server-side, so a project's configuration cannot reach another namespace —
  and two tenants' identical `Idempotency-Key`s are not the same case.
- **Row-level security on `org_id` is the second wall.** The app connects as
  the database's owner and drops to a role with no `BYPASSRLS` inside every
  transaction, naming the organization it is reading. A query that forgets
  reads nothing rather than everything.
- **The negatives are tested**: org B's key reads, writes, limits, spends and
  promotes nothing of org A's.
