# Jev

**Decide once, trust everywhere.** Jev is a policy engine for decisions that
used to live inside a prompt: routing, triage, approvals, escalation, guarding
an agent's tools. You write the policy once in plain TypeScript (or Python);
Jev asks the model only the questions the policy needs, checks the answers,
decides — and can prove, from a signed journal, exactly why it decided that.

```sh
npm install jevlang
```

No runtime dependencies. Node 22+. Pure decisions, validation and replay work
fully offline — no Racket, no account, no network.

## Why you need this

If an LLM picks a branch in your product today, you probably have some version
of these problems:

- **A prompt that is also your routing table.** The logic is invisible, so
  every change is a vibe and every regression a surprise.
- **No fence between the model and the action.** The same model that decides
  also executes, so a hallucinated tool call just... runs.
- **Nothing to audit.** When a customer asks why their ticket went to the
  wrong queue, the honest answer is a shrug in the shape of a log line.
- **Costs that surprise you.** Every call sends everything, because who knows
  what the model will need.

Jev turns that freeform prompt into a **declared, validated, inspectable
policy**:

- **The logic is code you can read.** Routes, thresholds, gates and fallbacks
  are clauses in a file. A typo is a build error, not a dead branch.
  `department.is('billling')` does not typecheck; the shared validator rejects
  the same mistake in Python and raw JSON before anything is deployed.
- **The model only answers questions.** It never picks the branch. A
  confidence gate above every question escalates to a human instead of
  guessing — the policy fails safe, not loud.
- **Every decision is explainable and replayable.** Each one carries its
  readings, its confidence, and the clause that fired. Recorded runs become
  fixtures that replay byte-for-byte, so you can diff a policy change against
  real history before it ships.
- **Actions are guarded, idempotent and journaled.** Confirmation, cooldowns,
  budgets, per-target guards, rollback through declared inverses, and an audit
  record for every dispatch. Nothing silently goes nowhere.
- **It's portable.** `policy.toJSON()` is a frozen artifact with a
  fingerprint; `compile(json)` loads it in the other language. One policy,
  verified identical in TypeScript and Python.

## Hello, world

The smallest useful policy: one question, one branch. If the model is at least
90% sure the message is spam, hold it; otherwise it goes to the inbox.

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

Already in these six lines: the question is declared once, the answer is
validated against it, the threshold is explicit, and there is no `otherwise`
hole — a non-spam answer can only go to `inbox`.

Run it from the shell, no code:

```sh
npx jev decide policy.json --input answers.json
```

## A real one: support routing

Three questions, two confidence gates, and a route where every ticket lands
somewhere on purpose. This is `examples/ticket-router.mjs` — runnable as-is.

```typescript
import { choice, score, noul, definePolicy, gate, escalate, rule, all, page, assign } from 'jevlang';

const department = choice('department', 'Which team should handle this ticket?', {
  billing: 'Payments, invoicing, refunds, payouts, card failures',
  technical: 'Bugs, outages, API errors, integration problems',
  sales: 'Pricing, upgrades, quotas, new accounts',
});
const frustration = score('frustration', 'How frustrated is the customer?', [
  'Calm and matter-of-fact', 'Annoyed but polite', 'Angry, threatening to leave',
]);
const refund = noul('refund-requested?', 'Is the customer asking for money back?');

export const policy = definePolicy({
  name: 'ticket-router',
  questions: [department, frustration, refund],
  gates: [
    gate(department, 0.8, escalate('human-triage', { reason: 'unclear which team owns this' })),
    gate(frustration, 0.7, escalate('human-triage', { reason: 'unclear how upset they are' })),
  ],
  route: { clauses: [
    rule(all(refund.yes(0.8), frustration.mostLikely('Angry, threatening to leave')),
         page('retention-oncall', { reason: 'angry refund request' })),
    rule(department.is('billing'), assign('billing-queue')),
    rule(department.is('technical'), assign('engineering-oncall')),
    rule(department.is('sales'), assign('sales-inbox')),
  ] },
});
```

Why this is better than a prompt:

- **Uncertainty has a place to go.** Below 80% confidence on the department,
  the ticket escalates to `human-triage` — by declaration, not by hoping the
  model says "I'm not sure".
- **The angry-refund rule is first for a reason.** Clause order is policy,
  visible and diffable in review.
- **`mostLikely`, `is`, `yes` are checked.** Mismatched option names, missing
  levels, ungated clauses and non-exhaustive routes are all construction-time
  errors.

## Guard an agent's tools

`jevlang/gate` is a policy that decides whether an agent's tool call runs —
as a Claude Code / Codex PreToolUse hook, or an MCP server standing in front
of another one. The verdict fails closed: `allow`, `deny` or `ask` means that;
anything the policy can't decide denies and says so. Hard allow/deny rules run
before the model is ever called, so `Bash(rm *)` stays blocked in code.
Arguments are redacted (emails, keys, cards, ...) before they leave the
machine, and the verdict log records arguments only as digests.

```typescript
const effect = choice('effect', 'What would this tool call do if it ran?', { /* read-only, destructive, ... */ });
const leaks = noul('leaks-secrets?', "Could this call send secrets somewhere they don't belong?");
// rule(leaks.yes(0.5), assign('deny', ...)), rule(effect.is('destructive'), escalate('ask', ...)), ...
```

Asking a person is real: modern clients get a signed, expiring
approve/deny form whose `requestState` names a digest of the exact call — an
approval cannot be replayed on a different one. Codex, which has no "ask",
denies with an approval fingerprint that `jev gate approve-once` lets through
exactly once.

## Everything else in the box

The core is small; the surface around it is what a production decision needs.

- **`jevlang`** — the language: `choice`, `score`, `noul`, `rule`, `all`,
  `any`, `not`, `gate`, `assign`, `escalate`, `page`, `hold`, plans, actions,
  JSON Schema for every action, and portable frozen artifacts.
- **`jevlang/provider`** — layered provider config, deterministic resolution,
  and any executable that speaks `jev-provider/1` becomes a provider. Built-in
  CLI adapters for Claude, Codex and fx. `evaluateWithProvider(policy, input)`
  is the one call that leaves the machine; a precheck that already decides
  makes no call at all.
- **`jevlang/dispatch`** — handlers with confirmation, cooldowns, budgets,
  guards, idempotency keys, plan rollback, and one audit record per outcome.
- **`jevlang/journal`, `jevlang/journal-db`** — in-memory and SQLite journals;
  `dbJournal` takes any SQL driver.
- **`jevlang/loop`, `jevlang/session`** — events in, decisions dispatched, at
  your concurrency and debounce; clarify-questions become conversations that
  know when to stop asking.
- **`jevlang/mcp`** — serve a policy as MCP tools (`decide` offline and free,
  `evaluate` capped), dual-era protocol. `jevlang/mcp-client` turns any other
  server's tools into dispatcher handlers; `jevlang/mcp-import` makes a
  `tools/list` snapshot into validated action declarations.
- **`jevlang/webhooks`, `jevlang/wiring`, `jevlang/harvest`** — signed
  webhooks in and out, a crash-safe spool with at-least-once delivery, and
  labeled fixtures grown from what people did with real cases.
- **`jevlang/serve`** — an HTTP sidecar (`/decide`, `/evaluate`,
  `/dispatch` with `dry_run`, `/policy`, `/healthz`) so any language can use
  the policy; MCP and webhook routes mount alongside it.

Monitoring is built in, honestly: `summarize` gives escalation rate, clause
shares and confidence histograms; `calibrate` gives a reliability table, ECE
and Brier score, and tells you when you don't have enough labels to trust
them; `cost` prices a call — fitted to your recorded usage when you have it,
a stated ~4-chars-per-token estimate when you don't.

## Verify it yourself

```sh
git clone <this repo> && cd jevlang
npm install
npm test            # 97 tests offline; the Racket differential oracles run too when Racket is on PATH
npm run test:types
```

The engine is pinned by differential tests against the Racket `jev`
implementation — decisions, wire questions, built state, reports, signatures
and verdicts match byte-for-byte — and the Python port
(`jevlang-sh` on PyPI) runs the same product on a pure-Python engine with the
same oracles. See [COMPATIBILITY.md](COMPATIBILITY.md) for the full evidence
table and the short list of known gaps (code lookup, a hosted offering, and a
few compile-time conveniences).

MIT licensed.
