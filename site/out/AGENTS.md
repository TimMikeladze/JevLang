# AGENTS.md — using JevLang from an agent

Install: `npm install jevlang`. Node 22+,
no runtime dependencies. Pure decisions, validation and replay work offline.

Minimal working policy (from the README, verified by the captured runs there):

```typescript
import { noul, definePolicy, rule, assign, hold } from 'jevlang';

const spam = noul('spam?', 'Is this message spam?');

const policy = definePolicy({
  name: 'hello',
  questions: [spam],
  route: {
    clauses: [rule(spam.yes(0.9), hold({ reason: 'almost certainly spam' }))],
    otherwise: assign('inbox'),
  },
});

const decision = policy.decide({ 'spam?': { noul: 0.97 } });
// decision.action === 'hold' — 0.97 clears the 0.9 bar, and the decision
// carries the reading that got it there
```

Decide with `policy.decide({ 'spam?': { noul: 0.97 } })` — every question needs an
answer; `choice` answers carry `{ choice, confidence }`, `noul` answers `{ noul }`.

## Options that matter

| Option | Effect |
| --- | --- |
| `questions` | declared `noul` / `choice` / `score` questions; answers are validated against them |
| `gates` | `gate(question, bar, escalate(...))` — below the bar, escalate instead of guessing |
| `route.clauses` | ordered rules; first match wins, clause order is policy |
| `route.otherwise` | the no-match action; a route with a hole is refused |
| `state` / `stateOptions` | what the decision may see, redacted and capped |

## Three mistakes that break it

- An ungated clause on a runtime question — the validator refuses it; declare a `gate` first.
- A non-exhaustive route — every option must land somewhere or carry `otherwise`.
- A mistyped option or fact name — construction fails with the nearest declared name as the fix.

Full reference: https://jevlang.sh/reference. Repo: https://github.com/TimMikeladze/JevLang.
