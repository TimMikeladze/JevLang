# The hosted API

Verbatim extract of `## The API` from the jevcloud-next README (the Next.js
Jev Cloud). Re-copy it when the API changes; the landing page reads this file
at build time and the site test checks it against the sibling repo.

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
| `GET/PUT /api/v1/billing`, `POST /api/v1/billing/report` | the Stripe mapping, and reporting a closed month |
| `GET /api/v1/audit` | what changed, and who did it |
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

Bring your own everything: model keys and endpoints, Redis or Postgres for
state, and where traces are kept, chosen per environment. The rate limits and
the hard spend cap apply to a customer's own key too, because the cap protects
them as much as us — and usage on their key is never marked up.

The dashboard signs a person in with an email and password (better-auth,
scrypt-hashed, never stored in the clear). Organizations are the default:
signing up creates one you own, and people you invite join yours, with one of
six roles — owner, admin, developer, approver, reviewer, viewer — enforced
server-side on every route and action.
