# Landing page spec

One-page site for `jevlang`, in the diffs.com / trees.software shape: near-black
page, one claim, then one section per capability with the real artefact under it.
A second page renders the README in full as the reference. The hosted offering
(`../jevcloud`, "@jev/cloud") is presented as one capability section plus an
aside — the angle: **the same decision on your laptop and in the cloud**.

## Pieces

- `site/content.mjs` — the page model: copy, section order, which captured
  example each section shows, link table, `origin = https://jevlang.sh`.
- `site/render.mjs` — markdown/fence parser, reference resolver
  (`terminal()` / `snippet()` must match exactly one block, else throw), HTML +
  CSS + head emitter, sibling artefact emitters.
- `site/build.mjs` — writes `site/out/`: `index.html`, `reference.html`,
  `index.md`, `llms.txt`, `AGENTS.md`, `sitemap.xml`, `robots.txt`, `og.png`.
- `site/card.html` — the 1200×630 OG card source, same tokens.
- `site/site.test.mjs` — the assertions (references resolve, figures match,
  committed HTML equals fresh render, self-contained, metadata, artefacts).

## Sources the page quotes (anti-drift)

- `README.md` — code blocks for hello world, ticket router, tool gate, module
  table; fenced runs pasted in by me after really running them.
- `../jevcloud/README.md` — API route table for the cloud section.
- `COMPATIBILITY.md` — boundaries columns (known gaps).

## Sections (H2 → option named)

1. Write the policy in code — `definePolicy` + hello example (README block) and
   a real `node examples/hello.mjs` run.
2. Uncertainty escalates — `gate(department, 0.8, escalate(...))`, ticket-router
   block + real decision run of `examples/ticket-router.mjs` with answers.
3. Guard an agent's tools — `jevlang/gate`, README block + real `tool-gate`
   verdict run.
4. Everything else in the box — enumeration table of subpath exports.
5. Host it, or run it here — jevcloud API surface, tenant isolation, deploy →
   promote → replay; aside links the sibling.

Boundaries (3 columns, from COMPATIBILITY): holds / judgement / not yet.
Start: two shell panels (install + verify), real captured runs.

## Constraints honoured

Self-contained (one inline stylesheet, one small inline script for theme boot +
toggle + copy chip), OKLCH tokens dark+light+system, no network fonts,
deterministic output, `og.png` shot from `site/card.html` at 1200×630.

## Deploy

`site/out/` is the static output. `vercel.json` points `outputDirectory` at it;
repo is `vercel link`ed and `jevlang.sh` moved to this project.
