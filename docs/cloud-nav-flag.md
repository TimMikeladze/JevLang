# The Cloud nav link behind a Vercel flag

The nav's Cloud link (opens `cloud.jevlang.sh/sign-in` in a new tab) ships in
the static HTML but is hidden by default. A Vercel flag decides when it shows.

## Why the indirection

`/` and `/reference` are static files built by `site/build.js` and served from
`public/` through rewrites — no server rendering to consult a flag in. The one
server code that runs for them is the proxy (Next 16's middleware).

## Pieces

- `examples/nextjs/flags.js` — `cloudNav` flag (`flags/next`). Default off.
  `decide()` reads `FLAG_CLOUD_NAV=1` so the link can be flipped for everyone
  with an env var, no code change. Toolbar overrides (encrypted
  `vercel-flag-overrides` cookie, needs `FLAGS_SECRET`) win over `decide`.
- `examples/nextjs/app/.well-known/vercel/flags/route.js` — the discovery
  endpoint; it is what makes the flag appear in Vercel's Flags Explorer.
- `examples/nextjs/proxy.js` — evaluates the flag for `/`, `/reference` and
  `/examples/*`, and answers with a plain `jev-cloud-nav=1` cookie when on
  (deletes it when off).
- `site/render.js` + `site/styles.js` — the link carries
  `data-flag="cloud-nav"`, is `display:none` by default, and the boot script
  (in `<head>`, before first paint, same pattern as the theme) sets
  `data-flags="cloud-nav"` on `<html>` when the cookie is present. The
  response's Set-Cookie is already in the jar when the head parses, so there
  is no flash either way.

## Behaviour

| Flag state | Result |
| --- | --- |
| off (default) | link absent visually on every page, for everyone |
| toolbar override on | link shows for that browser, instantly, no deploy |
| `FLAG_CLOUD_NAV=1` env | link shows for everyone on the next deploy |

Without JavaScript the link stays hidden — same degradation as the theme
toggle's persistence, and the safe default for a flag that is off.
