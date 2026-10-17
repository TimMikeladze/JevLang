# JavaScript and TypeScript policies

Import builders from `jevlang`. Use ESM (`.mjs`, a module package, or the
project's TypeScript tooling). `definePolicy` validates on construction;
`compile(json)` loads the same portable format. Inspect `policy.warnings`.

## Questions and answers

| Builder | Answer | Expression |
| --- | --- | --- |
| `noul('spam', 'Is this spam?')` | `{ noul: 0.97 }` | `spam.yes(0.9)`, `spam.no(0.9)` |
| `choice('team', 'Which team?', { billing: 'Payments', technical: 'Bugs' })` | `{ choice: 'billing', confidence: 0.95 }` | `team.is('billing')`, `team.chosen()` |
| `score('urgency', 'How urgent?', ['Low', 'High'])` | `{ score: 1, confidence: 0.95, probabilities: { 0: 0.05, 1: 0.95 } }` | `urgency.mostLikely('High')`, `urgency.value()` |

Answers are keyed by question ID. Optional `type` must match the declared kind.
Supply every generated question's answer. A Noul's number is P(yes), not an
independent confidence field: `no(0.9)` means P(yes) <= 0.1. A Score can be
fractional; `mostLikely` reads the level probability distribution, not rounding
of `score`. Include that distribution when using distribution-based accessors.

Choice options are wire keys or `{ key, name, description }` entries. The
optional `name` is a code alias; answers and `chosen()` use the wire key.
Score levels are ordered lowest first; `{ name, level }` gives a code alias.

## Gates and routing

`gate(team, 0.8, escalate('review'))` exits when confidence is **below** 0.8;
equality passes. `band(spam, 0.2, 0.8, hold())` reviews the inclusive interval
0.2 through 0.8. Include both endpoints in boundary tests.

Ordinary gates run before routes. `{ onRead: true }` defers a gate until its
question is read, including reads in output data. Use this for an optional
question whose uncertainty should not block unrelated routes. It does not
mean the provider can omit its answer.

Routes have `{ clauses: [rule(condition, decision)], otherwise: decision }`.
The first matching clause wins. An `otherwise` is required unless an
unconditional clause or complete static choice coverage proves exhaustiveness.
Dynamic choices require a fallback. Do not silence diagnostics with `ungated`
unless bypassing uncertainty is part of the intended policy and has a reason.

Use `all(a, b)`, `any(a, b)`, `not(a)`, `eq(a, b)`, `gte(a, b)` and related
builders, not host-language conditionals. `record({ key: expression })` evaluates
fields; a plain object is literal data. Wrap data with an `op` key in `literal`.
`threshold('name')` reads `thresholds`; `signal('name')` reads `signals`.

Decisions include `assign(target)`, `page(target)`, `escalate(target)`, `hold()`,
and `act(target, params)`. Optional `reason` and `data` can be expressions.
`act` requires a matching declared `actions` schema. `confirm(proposed)` and
`plan(...steps)` describe execution intent; they do not execute it.

## State and facts

```js
const stateSpec = {
  message: { path: ['body'], maxChars: 4000 },
  accountTier: { path: ['account', 'tier'], local: true },
  attachments: { path: ['attachments'], default: [] },
};
```

`state` fields are selected from the raw input. Missing fields fail unless a
default is declared. `path: []` selects the entire input. An empty state map
passes through raw input, so declare a whitelist when limiting model exposure.
`stateOptions.redact` supports names such as `emails`, `phones`, `cards`, `ssn`,
`keys`, and `ips`; choose them for the task. Redacting candidate email addresses
would break a task that asks the model to select one.

```js
const { state, facts } = policy.buildState(input);
const questions = policy.questions(state);
const decision = policy.decide(answers, { state, facts });
```

`fact('accountTier')` reads local application data. Facts remain unredacted for
local execution; keep sensitive facts out of returned data and logs unless
needed. `prechecks` can decide from facts before a provider call.

## Extraction and inventories

Parse candidate values in application code, then ask JevLang to choose among
them. A choice with `{ optionsFrom: 'addresses' }` combines runtime candidates
from model-facing state with static criteria such as `none`. The combined list
needs 2–255 distinct keys. Return `chosen()` as data; do not ask Choice to
generate unrestricted text.

`noulEach(id, instructions, 'items', { itemKey: 'item' })` and
`scoreEach(id, instructions, levels, 'items')` expand over a state inventory.
Their wire answer IDs are `id--0`, `id--1`, etc. Read them through aggregators
such as `countYes`, `anyYes`, `yesItems`, `max`, or `argmax`. Preserve the same
inventory/order in recorded state and facts; `yesItems` needs the facts inventory.

## Export and inspect

```js
import { writeFile } from 'node:fs/promises';
await writeFile('policy.json', JSON.stringify(policy.toJSON(), null, 2) + '\n');
```

The `jev` binary expects **JSON artifacts**, not `.js` or `.ts` modules:

```sh
jev validate policy.json
jev decide policy.json answers.json
jev state policy.json input.json
```

For local facts, `jev decide policy.json answers.json facts.json` supplies facts
only. Use the SDK with `{ state, facts }` when dynamic questions need projected
state. `explainDecision` is exported from `jevlang/explain`.
