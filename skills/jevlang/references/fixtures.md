# Test a JevLang policy

1. Locate the policy, current tests, and the user's expected decisions. Use
   the fixture format below when writing fixtures.
   Construct/compile the policy first so malformed policy errors stay separate
   from behavioral failures.
2. Build a compact case set for the intended route, fallback, uncertain answer,
   exact threshold boundary, and relevant malformed answer. Add clause-order
   cases when multiple rules can match. Handwritten answers are synthetic:
   assert policy behavior, not model accuracy.
3. Exercise `policy.decide(answers, { state, facts })` using `buildState(input)`
   for stateful cases; Python uses `build_state` and keyword arguments. Assert
   the important action, target, data, or proposed steps rather than snapshotting
   the whole trace. Keep invalid-answer cases as expected exceptions.
4. Replay valid fixtures and inspect every status. Compare old/new policies with
   `diff` when requested. Treat `unasserted`, `stale`, and errors as unresolved;
   a CLI exit of zero alone is insufficient. Use `allowStale` only for an
   explicitly labeled exploration, never to make a regression suite green.
5. Run the project's test command and report counts, changed decisions, and
   unverified cases. Recording with a live provider, dispatching actions, and
   changing deployed policies are separate operations from offline testing.

Test confidence gates immediately below and exactly at their threshold. For
Noul, test the probability condition or review band; it has no separate
confidence. For Score `mostLikely`, supply the probability distribution. For
Box, cover absent presence, null confidence, and invalid edge order. Runtime
choices/families need the same inventory and projected state used to build
their questions.

Preserve original recorded fixtures when proposing policy changes. Updating an
expected result requires the intended behavior to change, not merely a failing
assertion. A fixture copied from a decision is useful for future regression
checks, but the initial expected behavior still needs independent review.

## Synthetic text fixture

Ordinary text fixtures use version 3. Keep provenance fields even for supplied
answers; label them synthetic instead of pretending a model returned them.
Assuming `policy` is a compiled policy, `input` is application input, and
`answers` contains every generated answer:

```js
const { state, facts } = policy.buildState(input);
const fixture = {
  fixture_version: 3,
  name: 'billing-at-threshold',
  synthetic: true,
  provider: 'synthetic',
  requested_model: null,
  model: null,
  requested_effort: null,
  effective_effort: null,
  state,
  facts,
  questions: policy.questions(state),
  questions_sha256: policy.identity(),
  answers,
  expect: { action: 'assign', target: 'billing-queue' },
};
```

`expect` is a deep partial match, so include the output fields that define the
behavior. For plans, order and array length matter. `label` is a human-labeled
target for tuning, separate from regression `expect`; `labels` holds per-question
labels for calibration. Synthetic expectations do not establish model quality.

```js
import assert from 'node:assert/strict';
import { replay, diff } from 'jevlang';

const rows = replay(policy, [fixture]);
assert.ok(rows.length > 0);
assert.ok(rows.every(row => row.status === 'pass'), JSON.stringify(rows));
const changes = diff(before, after, [fixture]);
```

Use a test framework's assertions so failures exit nonzero. `console.assert`
alone is not a test runner. In Python use `policy.replay(fixtures)` and
`before.diff(after, fixtures)`; construct fixtures using `build_state` and
`questions`. The Python `Policy` wrapper has no public `identity()` method:
include the recorded `questions` and omit the optional `questions_sha256` for
synthetic text cases. Replay then verifies the questions directly.

## CLI

Export policies to JSON first. Put one fixture object per `.json` file in a
dedicated directory; unrelated JSON files there are parsed as fixtures too.

```sh
jev validate policy.json
jev replay policy.json fixtures
jev diff before.json after.json fixtures
```

Use `python3 -m jevlang` for the native Python CLI. `jev replay` exits nonzero
for `fail`, `error`, or `stale`, but **not** `unasserted`. `jev diff` prints
comparison rows; inspect them and enforce the desired changed-case policy in
the caller rather than relying on exit status.

| Status | Meaning |
| --- | --- |
| `pass` | The decision matches `expect` |
| `fail` | The decision differs from `expect` |
| `error` | Validation or decision evaluation failed |
| `stale` | Recorded questions or identity no longer match |
| `unasserted` | No `expect`; a successful execution is not an assertion |

Diff rows contain `changed`, `before`, and `after`. `changed: null` means a
decision could not be compared. `changed: false` does not mean either side's
expectations passed. Review the nested statuses. Route/threshold changes can
be compared using old answers; question wording, criteria, or inventory changes
can invalidate those answers and require re-recording.

## Recordings and images

`jev record policy.json input.json` calls the selected provider and prints
`{ decision, fixture }`. Save the nested `fixture`, not the outer envelope, in
the fixture directory. Choose reviewed `expect` values separately. Preserve
actual provider/model/effort provenance from the recording.

Image/experimental recordings use version 4. Generate these through recording
or `fixtureFromRun`, rather than inventing digests and manifests. `replay` can
evaluate recorded answers without images; `assetsVerified` remains false until
bytes are passed as `{ assets }` or embedded in `asset_data`. `decisionVerified`
and `fingerprintVerified` describe question identity, not model accuracy.

`tune(policy, fixtures, grid)` requires human `label` fields. Report the labeled
sample size and its warnings; thresholds chosen from a small synthetic sample
do not demonstrate accuracy on future traffic.
