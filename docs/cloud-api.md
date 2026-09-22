# The hosted API

Verbatim extract of `## The API` from the jevcloud-next README (the Next.js
Jev Cloud). Re-copy it when the API changes; the landing page reads this file
at build time and the site test checks it against the sibling repo.

## The API

Every route needs `Authorization: Bearer jev_live_...` under `/api/v1`. The
organization comes from the credential, never from the path, so a request
cannot name another tenant's resource: a wrong tenant is a 404, never a 403
that admits the resource exists.

| | |
| --- | --- |
| `POST /api/v1/projects` | create a project (`{slug}`) |
| `GET /api/v1/projects` | this organization's projects |
| `GET /api/v1/projects/:slug` | one project, with its production deployment |
| `POST /api/v1/projects/:slug/deployments` | publish a policy artifact (`{policy, note}`) — the first becomes production, later ones are previews |
| `GET /api/v1/projects/:slug/deployments` | newest first |
| `POST /api/v1/projects/:slug/promote` | `{deployment, expect}` moves production; a wrong `expect` refuses (422) and nothing moves, because two promotions racing cannot both win |
| `POST /api/v1/projects/:slug/evaluate` | validate the answers, decide on them, and write a trace and a usage row |
| `GET /api/v1/projects/:slug/traces` | what happened, newest first |
| `GET /api/v1/usage` | rows, and a total that separates money from estimates |

Scopes are `evaluate`, `dispatch`, `deploy` and `read`; a key missing one is
told which it needs. The plaintext of a key is shown once at creation and the
store keeps only `sha256` and a prefix.

A deployment is immutable. The first one a project publishes becomes
production; later ones are previews until promoted. `expect` on a promotion
is the version the caller believes production to be, so two promotions racing
cannot both win, and a rollback is a promotion back to an earlier deployment.
Nothing a deployment did is undone by a rollback: it moves a pointer.

The dashboard signs a person in with an email and password (better-auth,
scrypt-hashed, never stored in the clear). Organizations are the default:
signing up creates one you own, and people you invite from the team page
join yours. The dashboard shows projects, deployments, traces, usage, keys
(plaintext shown once), the team and the audit log — and the API answer a
script would get is the same one a person's click produces.
