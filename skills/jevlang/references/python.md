# Native Python

The module is `jevlang`; the distribution in this repository is `jevlang-sh`
(currently a development package). Python 3.9+ runs the native engine without
Node or Racket. For an upstream checkout, install with
`python3 -m pip install ./python` from its root. In another project, first check
the existing dependency or obtain the upstream Python directory; do not assume
`./python` exists or that `pip install jevlang` names this distribution.

Use [router.py](../assets/router.py) as a runnable starting point. Its exported
`policy` can be imported without running its demonstration.

| JavaScript | Python |
| --- | --- |
| `definePolicy({...})` | `Policy(name=..., questions=[...], route={...})` |
| `question.is('billing')` | `question.is_('billing')` |
| `all`, `any`, `not` | `all_of`, `any_of`, `not_` |
| `mostLikely`, `noulEach`, `scoreEach` | `most_likely`, `noul_each`, `score_each` |
| `toJSON`, `buildState` | `to_json`, `build_state` |

Python builder settings use keyword arguments. Portable settings inside policy
dicts retain camelCase: `maxChars`, `stateOptions`, `optionsFrom`, `onRead`.
`gate(team, 0.8, hold(), onRead=True)` is a builder call with a canonical setting.
Python `and`, `or`, `if expression`, and `bool(expression)` do not evaluate policy
logic; use the expression builders.

Python answer maps must be portable JSON, including **string** probability
keys. For a two-level Score, use `{'score': 1, 'confidence': 0.95,
'probabilities': {'0': 0.05, '1': 0.95}}`. Integer dict keys such as `0` and `1`
are rejected before evaluation. `most_likely` requires the distribution.

```python
built = policy.build_state(input_value)
decision = policy.decide(answers, state=built['state'], facts=built['facts'])
```

The result is a dict: `decision['action']`, `decision['target']`,
`decision['readings']`. `Policy.from_json(artifact)` loads a portable policy.

```python
import json
from pathlib import Path
Path('policy.json').write_text(json.dumps(policy.to_json(), indent=2) + '\n')
```

The native CLI is `python3 -m jevlang`. Use `--help` for its supported commands;
the npm binary is called `jev`, while Python's installed script is `jevlang`.
`policy.replay(fixtures)` is offline. Live evaluation and integrations have
their own Python APIs: inspect the installed module instead of mechanically
translating every JavaScript integration name. The Python package does not
claim complete parity with every hosted/automation surface.
