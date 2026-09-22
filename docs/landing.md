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
  is a complete file; `test/readme-examples.test.mjs` writes them to a scratch
  project with `jevlang` installed the way npm installs it, runs each `$`
  command, and fails when the recorded output differs. Runs marked `live` (a real
  model call, a server, the suite itself) are pasted from a real run and labelled.
- **Plain copy.** Two to three short sentences per section, the exact API in
  inline code, no jargon the section has not already explained.

## Pieces

- `site/content.mjs` — the page model: copy, section order, which README block or
  captured run each section shows, figure regexes, link table,
  `origin = https://jevlang.sh`.
- `site/render.mjs` — README fence parser (`file=` attributes), reference
  resolver (`terminal()` / `snippet()` must match exactly one block, else throw),
  policy-source readers for the diagrams, HTML + head emitter, sibling artefacts.
- `site/diagrams.mjs` — the six diagram components. `site/styles.mjs` — the CSS.
- `site/build.mjs` — writes `site/out/`: `index.html`, `reference.html`,
  `index.md`, `llms.txt`, `AGENTS.md`, `sitemap.xml`, `robots.txt`; `og.png` comes
  from `site/card.html` via `bun run site:card`.
- `site/site.test.mjs` — the assertions.
- `site/verify.mjs` — real-browser checks and screenshots: layout defects, theme
  cycle and persistence, copy buttons, no-script mode, 390px overflow.

## Sources the page quotes (anti-drift)

- `README.md` — `file=` code blocks and `$` captured runs; module bullets; the
  question-kinds table. Diagrams read numbers, option names, clauses and gate
  bars out of them.
- `docs/cloud-api.md` — API route table for the cloud section (vendored from
  `../jevcloud/README.md`; a test keeps it in sync when the sibling is cloned).
- `COMPATIBILITY.md` — the "not here yet" column traces to its known gaps.

## Sections (H2 → option named)

1. **How one decision works** — `policy.decide()`. Flow diagram of the real
   `ask.mjs` run: ticket, the model's readings, the rule that fired, the action.
2. **Run it in one file** — `definePolicy`. Install, save `policy.mjs`, run.
3. **Three kinds of question** — `noul`, `choice`, `score`. Answer-shape diagram
   for one ticket, plus the kinds table from the README.
4. **Low confidence escalates** — `gate()`. Meter diagram, `support.mjs`, the
   three-ticket `decide.mjs` run.
5. **Rules run in order** — `rule()`, `otherwise`. Ladder read from `support.mjs`,
   and the three build errors from `broken.mjs`.
6. **Every decision says why** — `explainDecision`, `evaluateWithProvider`.
   Annotated output of the real model run in `ask.mjs`.
7. **Guard an agent's tools** — `jev gate hook`. Ladder of checks, `gate.mjs`,
   options, hook settings, offline allow/deny runs and one live model verdict.
8. **Call it from anywhere** — `startServer`, `policyMcpServer`, `jev decide`.
   Doors diagram read from the README list, `serve.mjs`, module table.
9. **Same engine, hosted** — Jev Cloud, the hosted HTTP API (not an npm package). Lifecycle flow, API table, aside.

Then **What holds, what doesn't** (three counted columns: holds / judgement / not
here yet) and **Start** (install, verify).

## Constraints honoured

Self-contained (one inline stylesheet, one inline script in `<head>`: theme boot,
theme toggle, copy buttons — `localStorage` key `jevlang-theme`), OKLCH tokens
dark + light + system, no network fonts, deterministic output, `og.png` shot from
`site/card.html` at 1200×630.

## Deploy

`site/out/` is the static output. `vercel.json` points `outputDirectory` at it;
`jevlang.sh` is served by this project.
