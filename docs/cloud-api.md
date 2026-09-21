# The hosted API

Verbatim extract of `## The API` from the jevcloud README (private repo).
Re-copy it when the API changes; the landing page reads this file at build time.

## The API

Every route but `/healthz` needs `Authorization: Bearer jev_live_...`. The
organization comes from the credential, never from the path, so a request cannot
name another tenant's resource: a wrong tenant is a 404, never a 403 that admits
the resource exists.

| | |
| --- | --- |
| `POST /v1/projects` | create a project (`{slug, config}`) |
| `GET /v1/projects`, `GET /v1/projects/:slug` | list, or one with its production deployment |
| `POST /v1/projects/:slug/deployments` | publish a policy artifact (`{policy, note}`) |
| `GET /v1/projects/:slug/deployments` | newest first |
| `POST /v1/projects/:slug/promote` | `{deployment, expect}` moves production; `{deployment, gate: {sample, max_changed}}` diffs `sample` production traces against the deployment first and refuses (422) when the changed fraction is over `max_changed` — or when fewer than 30 traces are replayable, because a gate over too little evidence is not a gate. A refusal is audited as `deployment.promote_refused` and moves nothing |
| `PUT /v1/projects/:slug` | replace a project's `config` (`alerts`, `event_urls`, `schedule`, `provider`), validated where the service reads it |
| `GET/PUT/DELETE /v1/projects/:slug/secrets[/:name]` | names and versions only; values never come back |
| `POST /v1/projects/:slug/evaluate` | ask the provider, then decide |
| `POST /v1/projects/:slug/decide` | decide on answers the caller already has |
| `POST /v1/projects/:slug/dispatch` | decide, then run the handlers (`dry_run` rehearses) |
| `GET /v1/projects/:slug/traces[/:id]` | what happened |
| `POST /v1/projects/:slug/traces/:id/replay` | decide again, against `?deployment=` |
| `POST /v1/projects/:slug/replay-diff` | production's recent traces decided again against `{deployment, limit, since}`; rows `{trace_id, old, new, changed}` and a `{replayed, changed, refused}` summary — a trace whose inputs cannot be rebuilt is counted as `refused`, never skipped |
| `GET /v1/usage` | rows, and a total that separates money from estimates |
| `GET/POST /v1/keys`, `DELETE /v1/keys/:id` | credentials |
| `GET /v1/users`, `POST /v1/users` | who can sign in, and inviting one by email |
| `GET/PUT /v1/billing` | the Stripe mapping, and what has been reported |
| `POST /v1/billing/report` | report a closed month (`{month: "2026-08"}`) |
| `POST /v1/stripe/webhook` | Stripe's own events; signed, and the only `/v1` route with no key |
| `GET /v1/audit` | what changed, and who did it |

Scopes are `evaluate`, `dispatch`, `deploy` and `read`; a key missing one is told
which it needs. `Idempotency-Key` on evaluate and dispatch makes a retry return
the first answer instead of paying or acting twice.

A deployment is immutable. The first one a project publishes becomes production;
later ones are previews until promoted. `expect` on a promotion is the version
the caller believes production to be, so two promotions racing cannot both win,
and a rollback is a promotion back to an earlier deployment. Nothing a deployment
did is undone by a rollback: it moves a pointer.

The dashboard signs in with an email and password (scrypt, never stored in the
clear) or with an API key pasted in. A person's session mints a key of its own, so
the dashboard has no path to the store that the API does not have, and the page
shows exactly what a script would see.

