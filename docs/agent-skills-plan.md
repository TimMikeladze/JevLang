# One JevLang command

Ship one installable skill, `skills/jevlang`, for creating, checking, testing,
and integrating policies. `/jevlang` in Claude Code and `$jevlang` in Codex
handle the requested job through completion. Preserve review-only and offline
requests; building for an existing app includes its requested integration.

Move diagnostics, fixtures, and integration guidance into the default skill's
references. Remove the three specialized skill packages and their metadata.
Keep one short entrypoint that loads only the references needed for the task.
Keep JavaScript/Python starters and the existing language/image guidance.

Getting started is one global install and one request. Remove command tables
and duplicated examples from README, guide, website, and agent-facing output.
The generated image keeps the friendly white/blue design and purpose-first
heading; remove the command catalog and show a request to build, test, and
connect a support router. Keep website and social copies identical. Regenerate all seven social PNGs,
including the archived Python card, in the same friendly white/blue style.
Keep each topic intact and record the exact prompts and file hashes.

Verify resource links, runnable examples, actual CLI installation for both
agents, and a fresh consumer task that reaches app integration through the
single skill. Update the packaging/site checks, run the JavaScript suite and
type check, then inspect the site at desktop and mobile sizes.

## Progress

- Scope and consolidation plan: complete.
- Single skill and getting-started copy: complete.
- Image and website integration: complete; all seven social images regenerated.
- Installation, behavior, and browser checks: complete.

## Existing verification note

The earlier broad `bun site/verify.js` run reported one baseline failure:
`phone header: icons and toggle stay, text links collapse`. Original HEAD files
reproduced it in isolation. This task checks the getting-started section and
its navigation separately; it does not change unrelated header behavior.

## Verification

The repository now installs only `jevlang` for Claude Code and Codex. Actual
skills CLI installation passed with all references and both starter scripts
intact; skill-creator validation passed. The full JavaScript suite passed
238 tests with seven skips, and the TypeScript check passed. The included
six skill checks and nineteen site checks passed.

A fresh consumer task built a support policy and connected the existing HTTP
endpoint to queue handlers using only the default skill. Fourteen tests passed,
including both queues, uncertainty, equality, evaluator/handler failures, and
configured-provider selection. A separate read-only review preserved all seven
file hashes. The previous skill also completed the explicitly requested task
with nine passing tests but needed more installed-API inspection; this is a
consolidation of the workflow and references, not evidence of an accuracy gain.

The website passed desktop light/dark and 390px/320px checks: the image loads,
installation copies correctly, the command catalog is gone, and navigation has
no horizontal overflow. The social gallery passed 1280px and 390px checks with
all seven images decoded and full-size links working. Every social PNG changed
and is 1536x1024. The website, guide, and social first-policy PNGs are identical.

The social examples were checked offline for spam decisions, package
presence/confidence, support routing, and Python decisions. The support card's
missing route brace was corrected during image review. No live model calls,
external queue effects, deployment, or global configuration changes were used.

[Social gallery](../output/social/index.html), [image prompts](../output/social/prompts.md),
and [image hashes](../output/social/images.json) record the final set.
