# Check a JevLang policy

Produce a concrete diagnostic and reproduce the decision offline. Treat a
review request as review; edit the policy when the user asks for a fix.

1. Locate the policy and installed JevLang version. Inspect code before importing
   a module that might run application code. JavaScript `definePolicy(...)` and
   Python `Policy(...)` validate on construction; JSON loads via `compile(json)`
   or `Policy.from_json(json)`. Preserve the full error path, code, and hint.
2. Validate the exported artifact with `jev validate policy.json` or
   `python3 -m jevlang validate policy.json`. The CLI reads JSON, not a JS/TS
   source file. Export JS with `JSON.stringify(policy.toJSON())`; Python uses
   `json.dumps(policy.to_json())`. Review `policy.warnings` as well as errors.
3. Reproduce with the supplied answers. `policy.decide(answers)` is offline;
   `evaluateWithProvider` calls a provider. If state is involved, build it from
   the original input and pass `{ state, facts }` to `decide`; Python uses
   keyword arguments. Preserve both for dynamic choices and question families.
4. Explain the fired gate/clause, input readings, threshold, and expected
   alternative. JavaScript `explainDecision` comes from `jevlang/explain`;
   Python decisions expose `rule`, `clause`, and `readings` as dict keys.
   Test the smallest counterexample and relevant threshold equality.
5. Return findings by severity with source locations and the exact command run.
   For a requested fix, rerun the reproducer and relevant existing tests.
   Distinguish validation, route behavior, and model accuracy; offline answers
   establish only the first two.

## Diagnostic map

| Symptom | Check and repair |
| --- | --- |
| Unknown option or question | Match the declared ID, wire key/code alias, and generated question inventory. Fix the reference rather than expanding allowed values to hide a typo. |
| Ungated read or route not exhaustive | Add the intended confidence behavior and fallback. Static choice coverage can prove exhaustiveness; runtime options cannot. |
| A rule always wins or never runs | Use expression builders, not JS `&&`/`===` or Python `and`/`or`. Inspect first-match order and gates that run before routing. |
| Missing answer, confidence, or distribution | Supply all generated answers and the fields read by the policy. Score `mostLikely` needs probabilities. Noul uses `{ noul: p }`, not a confidence gate. |
| Unexpected facts, image result, or replay status | Follow the checks below; do not change a threshold to cover a malformed input. |

`buildState` yields model-facing `state` and local `facts`. Empty state maps
pass through input; `local: true` excludes a field from model state. Missing
fields require declared defaults. A nested output object containing expressions
needs `record(...)` to evaluate its fields. Wrap literal data with an `op` key
in `literal(...)`.

Confidence below a gate threshold exits; equality passes. A Noul review `band`
handles uncertainty in P(yes); Noul has no separate confidence. An on-read gate
fires only when its question is used, including output data reads.

Box coordinates do not prove presence: require a companion presence question.
Null/missing Box confidence trips its gate. Images require explicit experimental
enablement and a capable model; package version and model version differ.

Replay `stale` means the questions/identity changed; `unasserted` means no
expected result was supplied. A v4 decision-only replay does not verify image
bytes. Retain recorded provenance and require actual evidence before reporting
the issue fixed.

For API differences, inspect installed sources/declarations or the
[upstream source](https://github.com/TimMikeladze/JevLang). Do not require this
repository layout in a consumer app.
