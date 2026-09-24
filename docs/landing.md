# Landing page spec

One-page site for `jevlang`, in the diffs.com / trees.software shape: near-black
page, one claim, then one section per capability with the real artefact under it.
A second page renders the README in full as the reference.

## This pass: a redesign for a cold reader

The angle: **the model answers, your policy decides** — told in plain words, one
running story (a support ticket), every step with a diagram and an example you
can copy and run.

- **One story.** A support ticket goes through the whole page: the model answers
  three questions, gates catch the unsure answers, rules pick the action, the
  decision explains itself. The tool gate is the one second story.
- **Diagrams are HTML, not scaled SVG.** Six components (`flow`, `answers`,
  `meter`, `ladder`, `explain`, `doors`) built from real elements, so text stays
  real size at phone width, follows the theme tokens, and is readable by agents.
  Colour is reserved for meaning: green `assign`/`allow`, amber
  `escalate`/`page`/`ask`, red `hold`/`deny`, and the accent outline marks the
  one step that calls a model. Every value a diagram shows is read out of a
  captured run or a README code block by regex.
- **Every example is copy-ready.** Code frames carry a Copy button (script-free
  fallback: the block is plain selectable text). Each `file=` block in the README
  is a complete file; `test/readme-examples.test.js` writes them to a scratch
  project with `jevlang` installed the way npm installs it, runs each `$`
  command, and fails when the recorded output differs. Runs marked `live` (a real
  model call, a server, the suite itself) are pasted from a real run and labelled.
- **Plain copy.** Two to three short sentences per section, the exact API in
  inline code, no jargon the section has not already explained.

## Pieces

- `site/content.js` — the page model: copy, section order, which README block or
  captured run each section shows, figure regexes, link table,
  `origin = https://jevlang.sh`.
- `site/render.js` — README fence parser (`file=` attributes), reference
  resolver (`terminal()` / `snippet()` must match exactly one block, else throw),
  policy-source readers for the diagrams, HTML + head emitter, sibling artefacts.
- `site/diagrams.js` — the six diagram components. `site/styles.js` — the CSS.
- `site/build.js` — writes `site/out/`: `index.html`, `reference.html`,
  `index.md`, `llms.txt`, `AGENTS.md`, `sitemap.xml`, `robots.txt`; `og.png` comes
  from `site/card.html` via `bun run site:card`.
- `site/site.test.js` — the assertions.
- `site/verify.js` — real-browser checks and screenshots: layout defects, theme
  cycle and persistence, copy buttons, no-script mode, 390px overflow.

## Hero: a live decision console

The hero's right column is `support.js` running in the browser (`site/hero.js`).
Presets are the three `decide.js` tickets; the model's answers are controls
(option pills, confidence and probability sliders with the gate/rule bars
marked); the gates and rules light up as checked, and the output prints in
`explainDecision`'s format. Questions, gates and clauses are parsed from the
README block (`whenTree` refuses clause forms it does not understand). One
evaluator, `simDecide`: the server renders preset 0 with it (the no-script
state), the page's second script is its source text (capped at 8 KB, end of
`<body>`), and the site test checks all three presets against the captured
`node decide.js` output, line for line.

## Sources the page quotes (anti-drift)

- `README.md` — `file=` code blocks and `$` captured runs; module bullets; the
  question-kinds table. Diagrams read numbers, option names, clauses and gate
  bars out of them.
- `docs/cloud-api.md` — the cloud sections' tables and figures (vendored from
  `../jevcloud-next/README.md`; a test keeps it in sync when the sibling is cloned).

## Sections (H2 → option named)

1. **How one decision works** — `policy.decide()`. Flow diagram of the real
   `ask.js` run: ticket, the model's readings, the rule that fired, the action.
2. **Run it in one file** — `definePolicy`. Install, save `policy.js`, run.
3. **Three kinds of question** — `noul`, `choice`, `score`. Answer-shape diagram
   for one ticket, plus the kinds table from the README.
4. **Low confidence escalates** — `gate()`. Meter diagram, `support.js`, the
   three-ticket `decide.js` run.
5. **Rules run in order** — `rule()`, `otherwise`. Ladder read from `support.js`,
   and the three build errors from `broken.js`.
6. **Every decision says why** — `explainDecision`, `evaluateWithProvider`.
   Annotated output of the real model run in `ask.js`.
7. **Guard an agent's tools** — `jev gate hook`. Ladder of checks, `gate.js`,
   options, hook settings, offline allow/deny runs and one live model verdict.
8. **Call it from anywhere** — `startServer`, `policyMcpServer`, `jev decide`.
   Doors diagram read from the README list, `serve.js`, module table.
9. **Same engine, hosted** — `jevlang/cloud`, `jc.evaluate`. README client block.
10. **Promote behind a replay gate** — `jev deploy`, `jev promote --expect --gate`. Lifecycle diagram + README CLI block.
11. **Managed state, same interface** — `jc.journal(project)` into `makeDispatcher`. README block.
11b. **Actions on your own machine** — `{ "type": "runner" }`, `runner()`, `jev runner`. README runner block.
12. **Bring your own everything** — table from the cloud README.
13. **Tenants isolated by construction** — `org_id` RLS; the cloud README's isolation bullets as a table.
14. **One HTTP API** — scopes, `Idempotency-Key`, `jev_pub_…`; the route table.
15. **Free to start** — `/pricing`; plan names, the Pro price and how each is paid are read by regex out of the cloud README's Billing prose.

An aside before 9 says Cloud is a hosted product, not something you `bun add`.
The hero lede links the repo and cloud.jevlang.sh; the footer has a Jev Cloud
column. The nav's Cloud link still waits on the `cloud-nav` flag.

`docs/cloud-api.md` vendors four jevcloud-next README sections verbatim (Bring
your own everything, The API, Billing, Isolation); the site test fails when any
drifts from `../jevcloud-next/README.md`.

## Constraints honoured

Self-contained (one inline stylesheet, one inline script in `<head>`: theme boot,
theme toggle, copy buttons; plus the hero console's script at the end of `<body>` — `localStorage` key `jevlang-theme`), OKLCH tokens
dark + light + system, no network fonts, deterministic output, `og.png` shot from
`site/card.html` at 1200×630.

## Deploy

`site/out/` is the static output. `vercel.json` points `outputDirectory` at it;
`jevlang.sh` is served by this project.
