# JevLang — Decide once, trust everywhere

jevlang is an open source policy engine for the decisions that used to live inside a prompt — routing, triage, approvals, guarding an agent's tools. Built on plain TypeScript or Python (https://github.com/TimMikeladze/JevLang), no runtime dependencies. Made by linesofcode (https://x.com/linesofcode).

Install: `npm install github:TimMikeladze/JevLang` · Currently v0.1.0-dev.1

## A policy, not a prompt

Declare each question once with noul, choice or score, then hand definePolicy({ questions, route }) a list of clauses. A typo like department.is('billling') is a construction-time error, and a route with a hole is refused before anything deploys. Below is the README's whole example, and the decision it really made.

## Uncertainty escalates

Every question can carry a gate: gate(department, 0.8, escalate('human-triage', …)) sends the ticket to a person when confidence drops below the bar — by declaration, not by hoping the model says it is unsure. Clause order is policy, diffable in review.

## Guard an agent's tools

jevlang/gate decides whether a tool call runs — allow, deny or ask — as a Claude Code or Codex PreToolUse hook, or an MCP server standing in front of another one. It fails closed: anything the policy cannot decide denies and says so, and hard rules like Bash(rm *) block before the model is ever called.

## Everything else in the box

The core is small; the surface is what a production decision needs. jevlang/provider is the one call that leaves the machine — and a precheck that already decides makes no call at all. This table is read out of the README at build time.

## Same engine, hosted

@jev/cloud runs this engine for many tenants: deploy, promote, evaluate and replay over HTTP. Every route but /healthz takes Authorization: Bearer jev_live_…, and the organization comes from the credential, never the path. Deployments are immutable; promote with expect is the only thing that moves production.

## Boundaries

**Holds**
- Decisions, wire questions, built state and reports match the Racket jev engine byte-for-byte, pinned by differential oracles.
- npm test: 97 tests, 0 failures, offline — the number is read out of the captured run below.
- Pure decisions, validation and replay work fully offline: no account, no network, no Racket.

**Judgement**
- Cost estimates are fitted to your recorded usage, or a stated ~4-chars-per-token estimate when you have none.
- calibrate reports ECE and a reliability table, and tells you when you don't have enough labels to trust them.

**Not here yet**
- Code lookup (jev/code), which needs an SGX executable.
- Compile-time conveniences: include-questions, #:options-file, #:options.
- Nothing published to npm yet — install from this repo. The names are settled and recorded.

## Start

```sh
$ npm install github:TimMikeladze/JevLang
```
