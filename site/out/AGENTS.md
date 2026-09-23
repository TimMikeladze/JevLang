# AGENTS.md — using JevLang from an agent

Install: `bun add jevlang`. Node 22+, no runtime dependencies. Deciding, validating
and replaying work offline; only `evaluateWithProvider` and `jev gate hook`
(for calls on neither list) reach a model.

Minimal working policy — save it as `policy.js` and run `node policy.js`
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

## Run it on serverless

- `jevlang/redis` — `redisJournal`, `redisStore`, `redisSessions` on any Redis with `eval(script, keys, args)`; `upstash()` is a dependency-free client (UPSTASH_REDIS_REST_URL/_TOKEN or KV_REST_API_URL/_TOKEN).
- `rateLimit(journal, name, { max, per })` from `jevlang/dispatch` — a sliding window per key on any journal; `budget(name, { max, per, by })` limits each customer inside dispatch.
- HTTP providers `gateway` (Vercel AI Gateway, OIDC on Vercel), `openai` and `anthropic` sit beside `typesafe`: `evaluateWithProvider(policy, input, { provider: 'gateway' })`.
- `makeDispatcher(handlers, { journal, stepLease, scheduleLease })` re-delivers work a crashed instance left; call `runDue(dispatcher)` from a cron route.

## Examples

Three live Next.js route handlers, each decided by a policy. Try them at https://jevlang.sh/examples/maintenance; source: https://github.com/TimMikeladze/JevLang/tree/main/examples/nextjs.

### Tenant hotline — https://jevlang.sh/examples/maintenance

Tenants text one number; the policy decides who gets woken up. Time and outside temperature are local facts the model never sees; a 0.3 danger bar pages on-call.

```sh
curl https://jevlang.sh/api/maintenance -H 'content-type: application/json' \
  -d '{"input":{"message":"smells like gas in the hall","hour":3,"outsideTempC":2},"answers":{"issue":{"choice":"other","confidence":0.6},"danger?":{"noul":0.92}}}'
```


### Restaurant SMS host — https://jevlang.sh/examples/reservation

Guests text the restaurant; the model reads intent and flags serious allergies. Party size and free seats come from the booking system.

```sh
curl https://jevlang.sh/api/reservation -H 'content-type: application/json' \
  -d '{"input":{"message":"Table for 4 Sat 7pm? My son carries an EpiPen","partySize":4,"seatsFree":12},"answers":{"intent":{"choice":"book","confidence":0.97},"severe-allergy?":{"noul":0.96}}}'
```


### Courier app — https://jevlang.sh/examples/doorstep

A driver says what is happening at the door; parcel value, rain and a nearby locker decide door, locker or tomorrow. Anything unsafe means nobody risks it.

```sh
curl https://jevlang.sh/api/doorstep -H 'content-type: application/json' \
  -d '{"input":{"message":"Big dog loose in the yard, nobody answering","valueUsd":120,"raining":false,"lockerNearby":true},"answers":{"situation":{"choice":"nobody-home","confidence":0.93},"unsafe?":{"noul":0.91}}}'
```


Full reference: https://jevlang.sh/reference. Examples source: https://github.com/TimMikeladze/JevLang/tree/main/examples/nextjs. Repo: https://github.com/TimMikeladze/JevLang.
