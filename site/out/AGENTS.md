# AGENTS.md — using JevLang from an agent

Install: `npm install jevlang`. Node 22+, no runtime dependencies. Deciding, validating
and replaying work offline; only `evaluateWithProvider` and `jev gate hook`
(for calls on neither list) reach a model.

Minimal working policy — save it as `policy.mjs` and run `node policy.mjs`
(this exact file is re-run by the test suite):

```js
import { noul, definePolicy, rule, assign, hold } from 'jevlang';
import { explainDecision } from 'jevlang/explain';

const spam = noul('spam?', 'Is this message spam?');

const policy = definePolicy({
  name: 'hello',
  questions: [spam],
  route: {
    clauses: [rule(spam.yes(0.9), hold({ reason: 'almost certainly spam' }))],
    otherwise: assign('inbox'),
  },
});

// A model would answer 'spam?' with a probability. Here you pass one yourself.
console.log(explainDecision(policy.decide({ 'spam?': { noul: 0.97 } })));
```

Every question needs an answer: `noul` answers are `{ noul: 0.97 }`, `choice` answers
`{ choice: 'billing', confidence: 0.94 }`, `score` answers a level with its `probabilities`.

## Options that matter

| Option | Effect |
| --- | --- |
| `questions` | declared `noul` / `choice` / `score` questions; answers are validated against them |
| `gates` | `gate(question, bar, escalate(...))` — below the bar, escalate instead of guessing |
| `route.clauses` | ordered rules; the first match wins, so clause order is policy |
| `route.otherwise` | the no-match action; a route with a hole is refused |
| `state` | what the decision may see, mapped from the input, redacted and capped |

## Three mistakes that break it

- A clause on a model answer with no confidence gate — definePolicy refuses it; add a gate, or read confidence in the clause.
- A route that can miss a case — add otherwise, an unconditional clause, or a rule for every option of one choice.
- An answer that does not fit its question — decide needs one answer per question, and an option that was never declared is an error.

Guarding tool calls: deny and allow lists on jev gate hook match tool names (WebFetch, mcp__prod__*), not command text such as Bash(rm *); calls on neither list go to the policy.

Full reference: https://jevlang.sh/reference. Repo: https://github.com/TimMikeladze/JevLang.
