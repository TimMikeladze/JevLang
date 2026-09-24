# The hosted product behind a Vercel flag

Everything on the site about Jev Cloud ships in the static HTML but is hidden
by default, and one Vercel flag, `cloud`, decides when it shows:

- the nav's Cloud link (opens `cloud.jevlang.sh/sign-in` in a new tab)
- the landing page's cloud sections — `cloud`, `promote`, `managed-state`,
  `own-runner`, `bring-your-own`, `isolation`, `cloud-api`, `plans` — and the
  aside before them
- the hero lede's cloud sentence
- the footer's Jev Cloud column

In `site/content.js` each of these carries `flag: 'cloud'`. The agent files
(`llms.txt`, `index.md`) cannot ask a flag, so they leave flagged sections out;
`AGENTS.md` never had them.

## Why the indirection

`/` and `/reference` are static files built by `site/build.js` and served from
`public/` through rewrites — no server rendering to consult a flag in. The one
server code that runs for them is the proxy (Next 16's middleware).

## Pieces

- `examples/nextjs/flags.js` — the `cloud` flag (`flags/next`). Default off.
  `decide()` reads `FLAG_CLOUD=1` so it can be flipped for everyone with an env
  var, no code change. Toolbar overrides (encrypted `vercel-flag-overrides`
  cookie, needs `FLAGS_SECRET`) win over `decide`.
- `examples/nextjs/app/.well-known/vercel/flags/route.js` — the discovery
  endpoint; it is what makes the flag appear in Vercel's Flags Explorer.
- `examples/nextjs/proxy.js` — evaluates the flag for `/`, `/reference` and
  `/examples/*`, and answers with a plain `jev-cloud=1` cookie when on (deletes
  it when off).
- `site/render.js` + `site/styles.js` — flagged elements carry
  `data-flag="cloud"`; one rule, `html:not([data-flags~=cloud])
  [data-flag=cloud]{display:none!important}`, hides them; the boot script (in
  `<head>`, before first paint, same pattern as the theme) sets
  `data-flags="cloud"` on `<html>` when the cookie is present. The response's
  Set-Cookie is already in the jar when the head parses, so there is no flash
  either way.

## Behaviour

| Flag state | Result |
| --- | --- |
| off (default) | no cloud content visible, for everyone |
| toolbar override on | cloud content shows for that browser, instantly, no deploy |
| `FLAG_CLOUD=1` env | cloud content shows for everyone on the next deploy |

Without JavaScript the cloud content stays hidden — the safe default for a flag
that is off. The HTML still contains it, so it is hidden, not secret.
