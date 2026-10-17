# Jev for Python (in development)

Python builders on a native policy validator and interpreter, ported from the
shared engine and checked against the Racket implementation as the oracle.
Jev 1.14 image/Box support is documented in [JEV114.md](JEV114.md), with an
[offline example](examples/image_localization.py).

Python 3.9+, and pure Python: validation, decisions, replay, diff, tune,
monitoring, calibration, cost, providers, evaluate, record, dispatch, MCP,
the gate, webhooks and serving all run on the native engine — no Racket, no
Node, no internet, no credentials or account
(development oracle tests may require the legacy monorepo).

```sh
python3 -m pip install ./python
```

```python
from jevlang import Policy, choice, gate, rule, assign, hold

department = choice("department", "Which team?", ["billing", "technical"])
policy = Policy(
    name="router",
    questions=[department],
    gates=[gate(department, 0.8, hold())],
    route={
        "clauses": [rule(department.is_("billing"), assign("billing-team"))],
        "otherwise": assign("engineering"),
    },
)
decision = policy.decide({
    "department": {"type": "choice", "choice": "billing", "confidence": 0.95}
})
assert decision["target"] == "billing-team"
```

Options and levels can carry the name the policy refers to them by, separately
from the key or text that is sent:

```python
intent = choice("intent", "What is the user asking to do?", [
    {"key": "check-balance", "description": "Check an account balance"},
    {"name": "approve-transfer", "key": "approve_transfer", "description": "Approve the pending transfer"},
])
urgency = score("urgency", "How urgent?", [{"name": "calm", "level": "No time pressure"},
                                           {"name": "now", "level": "Needs it immediately"}])
intent.is_("approve-transfer")   # the code name, or "approve_transfer", the wire key
intent.chosen()                  # the wire key that was answered
urgency.most_likely("now")       # a level by name, its text, or its index
```

`raw_question(id, wire)` sends a question exactly as written and only `raw()`
reads its answer; `extraBody` adds undocumented request fields. Both bypass the
checks and both raise a validation warning.

Use `all_of`, `any_of`, `not_`, and `branch` for policy logic. Python `if`,
`and`, and `or` cannot execute a policy expression; attempting boolean coercion
raises an error. Helpers can return policy fragments. Use `literal()` to carry
data that happens to contain an `op` key. Settings inside the portable format
use canonical camelCase names in both SDKs.

Run the CLI with `python -m jevlang --help`; `validate`, `decide`, `state`,
`schema`, `stats`, `calibrate`, `cost`, `replay`, `diff` and `tune` run on the
native engine. Export `policy.to_json()` to move a policy between Python,
TypeScript and the future hosting layer; both engines load the same
format-1 artifact.

Parity evidence: `tests/test_racket_oracle.py` compares decisions, readings
included, against the Racket oracles over the shared fixtures;
`tests/test_differential.py` compares replay, stats, calibration, cost and
every text report byte-for-byte against the TypeScript engine. Both are
development-only and skip outside the monorepo.

Full automation, providers, integrations and SaaS are still in progress; see
[Jev 1.14 compatibility guide](JEV114.md). This is not a parity release.
