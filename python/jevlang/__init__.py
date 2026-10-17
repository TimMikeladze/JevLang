"""Python policy builders. Validation, offline execution, providers, the gate,
MCP, webhooks and serving all run on the native engine in this package; no
Node.js is needed or used."""
from __future__ import annotations
import json
import os
from typing import Any, Dict, Iterable, Optional


class JevError(ValueError):
    def __init__(self, error):
        super().__init__(error.get("message", str(error)))
        self.code = error.get("code", "error")
        self.path = error.get("path")
        self.fix = error.get("fix")


class Expr(dict):
    """An inspectable expression, never a Python boolean."""
    def __bool__(self):
        raise TypeError("Jev expressions are policy data. Use all_of(), any_of(), not_(), or branch(), not Python if/and/or.")


def expression(op: str, *args: Any) -> Expr:
    return Expr(op=op, args=list(args))


def literal(value: Any) -> Expr:
    return expression("literal", value)


def _expr(value: Any) -> Expr:
    return value if isinstance(value, Expr) else literal(value)


def fact(name: str) -> Expr: return expression("fact", name)
def threshold(name: str) -> Expr: return expression("threshold", name)
def signal(name: str) -> Expr: return expression("signal", name)
def variable(name: str) -> Expr: return expression("variable", name)
def all_of(*xs: Any) -> Expr: return expression("and", *map(_expr, xs))
def any_of(*xs: Any) -> Expr: return expression("or", *map(_expr, xs))
def not_(x: Any) -> Expr: return expression("not", _expr(x))
def eq(a: Any, b: Any) -> Expr: return expression("eq", _expr(a), _expr(b))
def compute(op: str, *xs: Any) -> Expr: return expression(op, *map(_expr, xs))
def choose(condition: Any, yes: Any, no: Any) -> Expr: return expression("if", _expr(condition), _expr(yes), _expr(no))
def record(fields: Dict[str, Any]) -> Expr: return expression("object", {k: _expr(v) for k, v in fields.items()})
def array(*values: Any) -> Expr: return expression("array", *map(_expr, values))


class Question:
    def __init__(self, id: str, schema: Dict[str, Any]): self.id, self.schema = id, schema
    def top(self) -> Expr: return expression("boxTop", self.id)
    def bottom(self) -> Expr: return expression("boxBottom", self.id)
    def left(self) -> Expr: return expression("boxLeft", self.id)
    def right(self) -> Expr: return expression("boxRight", self.id)
    def has_confidence(self) -> Expr: return expression("hasConfidence", self.id)
    def value(self) -> Expr: return expression("value", self.id)
    def confidence(self) -> Expr: return expression("confidence", self.id)
    def is_(self, option: str) -> Expr: return expression("is", self.id, option)
    def chosen(self) -> Expr: return expression("chosen", self.id)
    def raw(self) -> Expr: return expression("rawAnswer", self.id)
    def yes(self, threshold: Any = 0.5) -> Expr: return expression("yes", self.id, _expr(threshold))
    def no(self, threshold: Any = 0.5) -> Expr: return expression("no", self.id, _expr(threshold))
    def most_likely(self, level: Any) -> Expr: return expression("mostLikely", self.id, level)
    def at_least(self, level: Any) -> Expr: return expression("atLeast", self.id, level)
    def prob(self, option: Any) -> Expr: return expression("prob", self.id, option)
    def top_prob(self) -> Expr: return expression("topProb", self.id)
    def runner_up(self) -> Expr: return expression("runnerUp", self.id)
    def margin(self) -> Expr: return expression("margin", self.id)
    def nearest(self) -> Expr: return expression("nearest", self.id)
    def normalized(self) -> Expr: return expression("normalized", self.id)
    def spread(self) -> Expr: return expression("spread", self.id)
    def max(self) -> Expr: return expression("max", self.id)
    def min(self) -> Expr: return expression("min", self.id)
    def mean(self) -> Expr: return expression("mean", self.id)
    def count_yes(self, threshold: Any = 0.5) -> Expr: return expression("countYes", self.id, _expr(threshold))
    def any_yes(self, threshold: Any = 0.5) -> Expr: return expression("anyYes", self.id, _expr(threshold))
    def all_yes(self, threshold: Any = 0.5) -> Expr: return expression("allYes", self.id, _expr(threshold))
    def argmax(self) -> Expr: return expression("argmax", self.id)
    def yes_items(self, threshold: Any = 0.5) -> Expr: return expression("yesItems", self.id, _expr(threshold))


def _options(options: Any) -> Dict[str, Any]:
    """An option is a wire key, or {"key", "name", "description"}: the name is how
    the policy refers to it, the key is what the model answers with."""
    entries = ([dict(key=o) if isinstance(o, str) else o for o in options] if not isinstance(options, dict)
               else [dict(key=k, description=v) for k, v in options.items()])
    for e in entries:
        if not isinstance(e, dict) or not isinstance(e.get("key"), str):
            raise ValueError('An option is a wire key, or {"key", "name", "description"}.')
    keys = [e["key"] for e in entries]
    if len(set(keys)) != len(keys): raise ValueError("Duplicate choice option; use distinct keys.")
    named = [e for e in entries if e.get("name") and e["name"] != e["key"]]
    if len({e["name"] for e in named}) != len(named): raise ValueError("Duplicate option code name; use distinct names.")
    schema: Dict[str, Any] = {"criteria": {e["key"]: e.get("description") for e in entries}}
    if named: schema["names"] = {e["name"]: e["key"] for e in named}
    return schema


def _levels(levels: Any) -> Dict[str, Any]:
    """A level is its content, or {"name", "level"}."""
    if not isinstance(levels, (list, tuple)): raise ValueError("Score levels are an ordered list, lowest first.")
    named = [l if isinstance(l, dict) and "level" in l else {"level": l} for l in levels]
    names = [l.get("name") for l in named]
    schema: Dict[str, Any] = {"criteria": [l["level"] for l in named]}
    if any(n is not None for n in names): schema["levelNames"] = names
    return schema


def choice(id: str, instructions: Any, options: Any, **settings: Any) -> Question:
    return Question(id, dict(type="choice", instructions=instructions, **_options(options), **settings))


def score(id: str, instructions: Any, levels: list, **settings: Any) -> Question:
    return Question(id, dict(type="score", instructions=instructions, **_levels(levels), **settings))


def raw_question(id: str, wire: Dict[str, Any]) -> Question:
    """Sent exactly as written; only raw() reads its answer."""
    return Question(id, dict(type="raw", wire=wire))


def box(id: str, instructions: Any = None, **settings: Any) -> Question:
    return Question(id, dict(type="box", instructions=instructions, **settings))


def noul(id: str, instructions: Any, **settings: Any) -> Question:
    return Question(id, dict(type="noul", instructions=instructions, **settings))


def noul_each(id: str, instructions: Any, over: str, **settings: Any) -> Question:
    return Question(id, dict(type="noul-each", instructions=instructions, over=over, **settings))


def score_each(id: str, instructions: Any, levels: list, over: str, **settings: Any) -> Question:
    return Question(id, dict(type="score-each", instructions=instructions, **_levels(levels), over=over, **settings))


def _metadata(settings):
    return {k: _expr(v) if k in ("reason", "data") else [q.id if isinstance(q, Question) else q for q in v] if k == "show" else v for k, v in settings.items()}


def assign(target: str, **settings: Any) -> dict: return dict(action="assign", target=target, **_metadata(settings))
def page(target: str, **settings: Any) -> dict: return dict(action="page", target=target, **_metadata(settings))
def escalate(target: str, **settings: Any) -> dict: return dict(action="escalate", target=target, **_metadata(settings))
def next_(target: str, **settings: Any) -> dict: return dict(action="next", target=target, **_metadata(settings))
def hold(**settings: Any) -> dict: return dict(action="hold", **_metadata(settings))
def act(target: str, params: Optional[dict] = None, **settings: Any) -> dict: return dict(action="act", target=target, params={k: _expr(v) for k, v in (params or {}).items()}, **_metadata(settings))
def confirm(proposed: dict, **settings: Any) -> dict: return dict(action="confirm", proposed=proposed, **_metadata(settings))
def plan(*steps: dict) -> dict: return dict(action="plan", steps=list(steps))
def schedule(seconds: Any, proposed: dict, **settings: Any) -> dict: return dict(action="schedule", seconds=_expr(seconds), proposed=proposed, **_metadata(settings))
def clarify(question: Any, about: Any = None, **settings: Any) -> dict: return dict(action="clarify", question=_expr(question), **({"about": about.id if isinstance(about, Question) else about} if about is not None else {}), **_metadata(settings))
def plan_for(variable: str, items: Any, decision: dict) -> dict: return dict(action="planFor", variable=variable, items=_expr(items), decision=decision)
def branch(when: Any, then: dict, otherwise: dict) -> dict: return dict(action="branch", when=_expr(when), then=then, otherwise=otherwise)
def rule(when: Any, decision: dict, source: Optional[str] = None) -> dict: return dict(when=_expr(when), decision=decision, **({"source": source} if source else {}))
def gate(question: Any, threshold: float, decision: dict, **settings: Any) -> dict: return dict(question=question.id if isinstance(question, Question) else question, threshold=threshold, decision=decision, **settings)
def band(question: Any, low: float, high: float, decision: dict, **settings: Any) -> dict: return dict(question=question.id if isinstance(question, Question) else question, low=low, high=high, decision=decision, **settings)


def _call(method: str, policy: Optional[dict], **kwargs: Any) -> Any:
    if os.environ.get("JEV_NODE"):
        raise RuntimeError(
            "JEV_NODE is gone: the Python engine is native as of slice 3 (docs/python-port.md) "
            "and no longer shells out to Node. Unset JEV_NODE.")
    return _call_native(method, policy, **kwargs)


def _call_native(method: str, policy: Optional[dict], **kwargs: Any) -> Any:
    from . import _engine as engine
    from . import _fixtures as fixtures
    from . import _monitor as monitor
    from . import _cost as costmod
    from . import _schema as schema
    from ._common import JevError as EngineError
    try:
        return _dispatch_native(engine, fixtures, monitor, costmod, schema, method, policy, kwargs)
    except EngineError as error:
        raise JevError(error.to_json()) from None


def _dispatch_native(engine, fixtures, monitor, costmod, schema, method: str, policy: Optional[dict], kwargs: dict) -> Any:
    if method == "validate":
        compiled = engine.CompiledPolicy(policy)
        return {"policy": compiled.to_json(), "warnings": compiled.warnings}
    compiled = engine.CompiledPolicy(policy)
    options = kwargs.get("options") or {}
    if method == "decide": return compiled.decide(kwargs.get("answers") or {}, options)
    if method == "state": return compiled.build_state(kwargs.get("input"), options)
    if method == "questions": return compiled.questions(kwargs.get("state") or {})
    if method == "precheck": return compiled.precheck(kwargs.get("input"), options)
    if method == "replay": return fixtures.replay(compiled, kwargs.get("fixtures") or [], options)
    if method == "diff": return fixtures.diff(compiled, engine.CompiledPolicy(kwargs["after"]), kwargs.get("fixtures") or [], options)
    if method == "tune": return fixtures.tune(compiled, kwargs.get("fixtures") or [], kwargs.get("grid") or {})
    if method == "schema": return schema.policy_actions(compiled)
    if method == "cost": return costmod.cost(compiled, **{k: v for k, v in options.items()
                                                          if k in ("input", "fixtures", "volume", "model", "price", "assets", "experimental")})
    if method == "stats":
        rows = fixtures.replay(compiled, kwargs.get("fixtures") or [], {**options, "allowStale": True})
        kept = [(row, fixture) for row, fixture in zip(rows, kwargs.get("fixtures") or []) if row.get("decision")]
        return {"unusable": len(rows) - len(kept),
                "summary": monitor.summarize([row["decision"] for row, _ in kept],
                                             [fixture.get("answers") for _, fixture in kept],
                                             [fixture.get("label") for _, fixture in kept])}
    if method == "calibrate":
        return monitor.calibrate([{"answers": f.get("answers"), "labels": f.get("labels")}
                                  for f in kwargs.get("fixtures") or []])
    from . import _evaluate
    if method == "evaluate":
        return _evaluate.evaluate_policy(engine.CompiledPolicy(policy), kwargs.get("input"), options)
    if method == "record":
        return _evaluate.record_policy(engine.CompiledPolicy(policy), kwargs.get("input"), options)
    if method == "providers":
        return _evaluate.provider_report(options)
    raise ValueError(f"Unknown native method '{method}'.")


def providers(**options: Any) -> dict:
    """What provider resolution would choose here, and what it passed over."""
    from . import _evaluate
    return _evaluate.provider_report(options)


class Policy:
    def __init__(self, *, name: str, questions: Any = (), **options: Any):
        if isinstance(questions, dict):
            for id, q in questions.items():
                if isinstance(q, Question) and q.id != id:
                    raise ValueError("Question map key differs from its declared id: " + id)
            mapped = {id: q.schema if isinstance(q, Question) else q for id, q in questions.items()}
        else:
            questions = list(questions)
            if len({q.id for q in questions}) != len(questions): raise ValueError("Duplicate question id; use unique names.")
            mapped = {q.id: q.schema for q in questions}
        result = _call("validate", dict(format=1, name=name, questions=mapped, **options))
        self._json = json.dumps(result["policy"], allow_nan=False)
        self.warnings = result["warnings"]

    @classmethod
    def from_json(cls, value: dict) -> Policy:
        result = _call("validate", value)
        instance = object.__new__(cls)
        instance._json = json.dumps(result["policy"], allow_nan=False)
        instance.warnings = result["warnings"]
        return instance

    def to_json(self) -> dict: return json.loads(self._json)
    def validate(self) -> dict: return _call("validate", self.to_json())
    def decide(self, answers: dict, **options: Any) -> dict: return _call("decide", self.to_json(), answers=answers, options=options)
    def build_state(self, input: Any, **options: Any) -> dict: return _call("state", self.to_json(), input=input, options=options)
    def questions(self, state: Any = None) -> dict: return _call("questions", self.to_json(), state={} if state is None else state)
    def precheck(self, input: Any, **options: Any) -> Any: return _call("precheck", self.to_json(), input=input, options=options)
    def replay(self, fixtures: Iterable[dict], **options: Any) -> list: return _call("replay", self.to_json(), fixtures=list(fixtures), options=options)
    def diff(self, after: Policy, fixtures: Iterable[dict], **options: Any) -> list: return _call("diff", self.to_json(), after=after.to_json(), fixtures=list(fixtures), options=options)
    def tune(self, fixtures: Iterable[dict], grid: dict) -> dict: return _call("tune", self.to_json(), fixtures=list(fixtures), grid=grid)
    def evaluate(self, input: Any, **options: Any) -> dict:
        """Ask the selected provider to answer this policy's questions, then decide.

        This is the one call that leaves the machine."""
        return _call("evaluate", self.to_json(), input=input, options=options)

    def record(self, input: Any, **options: Any) -> dict:
        """Evaluate and return {decision, fixture}: a provenance fixture (v4 for images/Box, otherwise v3)."""
        return _call("record", self.to_json(), input=input, options=options)

    def schema(self) -> dict: return _call("schema", self.to_json())
    def stats(self, fixtures: Iterable[dict], **options: Any) -> dict: return _call("stats", self.to_json(), fixtures=list(fixtures), options=options)
    def cost(self, **options: Any) -> dict: return _call("cost", self.to_json(), options=options)
    def calibrate(self, fixtures: Iterable[dict]) -> list: return _call("calibrate", self.to_json(), fixtures=list(fixtures))


from ._assets import image_asset
from ._budgets import check_request_budget, model_limits

from ._evaluate import list_models, jev_call, evaluate_with_provider
