# Landing page spec

One-page site for `jevlang`, in the diffs.com / trees.software shape: near-black
page, one claim, then one section per capability with the real artefact under it.
A second page renders the README in full as the reference. The hosted offering
(`../jevcloud`, "@jev/cloud") is presented as one capability section plus an
aside — the angle: **the same decision on your laptop and in the cloud**.

## This pass: design upgrade — more diagrams, more color

Keep the honest core (captured runs, anti-drift resolver, boundaries) and make
the page louder where meaning allows:

- **Five inline SVG diagrams**, drawn in the renderer, named from content
  (`diagram(name)` throws on unknown, like `icon(name)`):
  1. `pipeline` (§1) — how a decision flows: input → questions → gates →
     route → journal, plus the dotted optional provider lane.
  2. `gate-meter` (§2) — a confidence axis 0→1; the bar, the pass and the
     fail markers are **read out of the captured run by regex**, never typed.
  3. `router-tree` (§2) — the ticket router as a tree: gates, ordered
     clauses, targets colored by action semantics.
  4. `gate-verdict` (§3) — tool call → hard rules / questions → allow/deny/ask,
     fails closed; effect confidence read from the captured run.
  5. `cloud-lifecycle` (§5) — deploy → promote(expect) → replay.
- **Syntax highlighting** in code frames: a deterministic TS tokenizer
  (keywords, strings, numbers, calls, comments) using new `--tk-*` tokens in
  both schemes. Color carries syntax, chrome stays greyscale.
- **Terminal output colored semantically**: JSON keys accented; `action`
  values colored by meaning (`assign` add, `escalate`/`page`/`ask` warn,
  `hold`/`deny` del).
- **Meaning-tinted chrome**: real traffic-light colors on frame dots, the
  `captured output` chip in add (it means "real run"), headline figures in
  accent mono, "Built for production" columns tinted add/warn/accent.
- Diagrams render as `<figure class="diagram">` **without** the captured-output
  title bar — the bar is reserved for things the repo really produced.

## Pieces

- `site/content.mjs` — the page model: copy, section order, which captured
  example each section shows, diagram demos (name + figure regexes), link
  table, `origin = https://jevlang.sh`.
- `site/render.mjs` — markdown/fence parser, reference resolver
  (`terminal()` / `snippet()` must match exactly one block, else throw),
  tokenizer, diagram registry, HTML + CSS + head emitter, sibling artefacts.
- `site/build.mjs` — writes `site/out/`: `index.html`, `reference.html`,
  `index.md`, `llms.txt`, `AGENTS.md`, `sitemap.xml`, `robots.txt`, `og.png`.
- `site/card.html` — the 1200×630 OG card source, same tokens + accent marks.
- `site/site.test.mjs` — the assertions (references resolve, figures match,
  diagrams render with resolved values, committed HTML equals fresh render,
  self-contained, metadata, artefacts).

## Sources the page quotes (anti-drift)

- `README.md` — code blocks for hello world, ticket router, tool gate, module
  table; fenced runs pasted in after really running them. The gate meter and
  verdict diagram read their numbers out of these blocks by regex.
- `docs/cloud-api.md` (vendored from `../jevcloud/README.md`) — API route
  table for the cloud section; a test keeps it in sync when the sibling is
  cloned.
- `COMPATIBILITY.md` — boundaries columns (known gaps).

## Sections (H2 → option named)

1. A policy, not a prompt — `definePolicy` + pipeline diagram + hello example
   (README block) and a real `node examples/hello.mjs` run.
2. Uncertainty escalates — `gate(department, 0.8, escalate(...))`, gate meter
   and router-tree diagrams (values from the captured run), ticket-router
   block + real decision run of `examples/ticket-router.mjs`.
3. Guard an agent's tools — `jevlang/gate`, verdict diagram, README block +
   real `tool-gate` verdict run.
4. Everything else in the box — enumeration table of subpath exports.
5. Same engine, hosted — jevcloud API surface, tenant isolation, deploy →
   promote → replay lifecycle diagram; aside links the sibling.

Boundaries → "Built for production" (3 columns): guarantees / honest numbers / ships today.
Start: two shell panels (install + verify), real captured runs.

## Constraints honoured

Self-contained (one inline stylesheet, one small inline script for theme boot +
toggle + copy chip), OKLCH tokens dark+light+system, no network fonts,
deterministic output, `og.png` shot from `site/card.html` at 1200×630.

## Deploy

`site/out/` is the static output. `vercel.json` points `outputDirectory` at it;
repo is `vercel link`ed and `jevlang.sh` moved to this project.
