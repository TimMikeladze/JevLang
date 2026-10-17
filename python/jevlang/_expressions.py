"""Tagged expressions: static checking and evaluation.

Ported from the TypeScript engine's expressions.mjs; the builders in
``jevlang/__init__.py`` produce the same {op, args} trees.
"""
from __future__ import annotations

from typing import Any

from ._common import own, is_object, require_at, finite, probability, equal, fail, did_you_mean

ACCESSORS = {
    'value': ['choice', 'score', 'noul', 'box'], 'confidence': ['choice', 'score', 'box'],
    'hasConfidence': ['box'], 'boxTop': ['box'], 'boxBottom': ['box'], 'boxLeft': ['box'], 'boxRight': ['box'],
    'chosen': ['choice'], 'rawAnswer': ['raw'],
    'is': ['choice'], 'yes': ['noul'], 'no': ['noul'], 'mostLikely': ['score'], 'atLeast': ['score'],
    'prob': ['choice', 'score'], 'topProb': ['choice', 'score'], 'runnerUp': ['choice'],
    'margin': ['choice', 'score'], 'nearest': ['score'], 'normalized': ['score'], 'spread': ['score'],
    'max': ['noul-each', 'score-each'], 'min': ['noul-each', 'score-each'], 'mean': ['noul-each', 'score-each'],
    'countYes': ['noul-each', 'score-each'], 'anyYes': ['noul-each', 'score-each'], 'allYes': ['noul-each', 'score-each'],
    'argmax': ['noul-each', 'score-each'], 'yesItems': ['noul-each'],
}
_TWO_ARG = ['is', 'yes', 'no', 'mostLikely', 'atLeast', 'prob', 'countYes', 'anyYes', 'allYes', 'yesItems']
# [lo, hi] with None for unbounded.
ARITIES = {
    'literal': (1, 1), 'fact': (1, 1), 'threshold': (1, 1), 'signal': (1, 1), 'variable': (1, 1),
    'and': (0, None), 'or': (0, None), 'not': (1, 1), 'eq': (2, 2), 'ne': (2, 2),
    'gt': (2, 2), 'gte': (2, 2), 'lt': (2, 2), 'lte': (2, 2), 'add': (2, None), 'sub': (2, 2),
    'mul': (2, None), 'div': (2, 2), 'if': (3, 3), 'contains': (2, 2), 'length': (1, 1),
    'get': (2, 3), 'object': (1, 1), 'array': (0, None),
}


class Refs:
    def __init__(self):
        self.reads: set[str] = set()
        self.confidences: set[str] = set()

    def merge(self, other: 'Refs'):
        self.reads |= other.reads
        self.confidences |= other.confidences


def check_expression(x: Any, policy: dict, path: str, options: dict | None = None) -> Refs:
    options = options or {}
    refs = Refs()
    variables = options.get('variables') or set()
    stack = options.get('stack') or []

    def child(v, p=None):
        refs.merge(check_expression(v, policy, p or path, options))

    require_at(is_object(x) and isinstance(x.get('op'), str) and isinstance(x.get('args'), list), path,
               'expected a tagged expression', 'Use a Jev expression builder or {op, args}.')
    require_at(all(k in ('op', 'args') for k in x), path, 'unknown expression property')
    op, args = x['op'], x['args']
    if op in ACCESSORS:
        two = op in _TWO_ARG
        require_at(len(args) == (2 if two else 1), path, f'{op} expects {2 if two else 1} arguments')
        require_at(isinstance(args[0], str) and args[0] in policy['questions'], path,
                   f"unknown question '{args[0]}'", 'Declare the question before referencing it.')
        q = policy['questions'].get(args[0], {})
        require_at(q.get('type') in ACCESSORS[op], path, f"{op} cannot read a {q.get('type')} question",
                   ('Noul has no confidence; use its probability.' if q.get('type') == 'noul' and op == 'confidence'
                    else 'A raw question has no declared shape; read it only with rawAnswer.' if q.get('type') == 'raw'
                    else 'Use the typed accessors (is, yes, value, ...) on declared questions.' if op == 'rawAnswer'
                    else f"Use {' or '.join(ACCESSORS[op])}."))
        require_at(not options.get('noAnswers'), path, 'prechecks cannot read model answers', 'Use facts in prechecks.')
        refs.reads.add(args[0])
        if op in ('confidence', 'hasConfidence'):
            refs.confidences.add(args[0])
        if op == 'is' or (op == 'prob' and q.get('type') == 'choice'):
            require_at(option_wire(q, args[1]) is not None, path, f"'{args[1]}' is not an option of '{args[0]}'",
                       (f"'{args[0]}' takes runtime options from '{q.get('optionsFrom')}'; name one of its declared options ({', '.join(option_names(q)) or 'none declared'}), or compare chosen('{args[0]}') with a string."
                        if q.get('optionsFrom')
                        else f"Use one of: {', '.join(option_names(q))}.{did_you_mean(args[1], option_names(q))}"))
        elif op in ('mostLikely', 'atLeast', 'prob'):
            index = level_index(q, args[1])
            require_at(index >= 0, path, f"'{args[1]}' is not a level of '{args[0]}'",
                       f"Use a declared level or its zero-based index.{did_you_mean(args[1], [*(q.get('levelNames') or []), *q.get('criteria', [])])}")
            require_at(op != 'atLeast' or index > 0, path, 'atLeast at the bottom level is always true',
                       'Use mostLikely or a higher level.')
        elif two:
            child(args[1], f'{path}.args[1]')
            if isinstance(args[1], dict) and args[1].get('op') == 'literal':
                require_at(probability(args[1]['args'][0]), path, 'threshold must be between 0 and 1')
    else:
        require_at(op in ARITIES, path, f"unknown expression '{op}'", 'Use a supported expression operator.')
        lo, hi = ARITIES[op]
        require_at(len(args) >= lo and (hi is None or len(args) <= hi), path,
                   f'{op} expects {lo if lo == hi else f"at least {lo}"} arguments')
        if op == 'literal':
            pass  # Literal payload is data, never traversed as code.
        elif op in ('fact', 'threshold'):
            table = policy['state'] if op == 'fact' else policy['thresholds']
            require_at(isinstance(args[0], str) and args[0] in table, path, f"unknown {op} '{args[0]}'",
                       f"Declare it in {'state' if op == 'fact' else 'thresholds'}.{did_you_mean(args[0], list(table))}")
        elif op == 'variable':
            require_at(args[0] in variables, path, f"unbound variable '{args[0]}'",
                       'Use a variable bound by planFor.')
        elif op == 'signal':
            require_at(args[0] in policy['signals'], path, f"unknown signal '{args[0]}'")
            require_at(args[0] not in stack, path, f"cyclic signal '{args[0]}'",
                       'Remove the recursive signal dependency.')
            refs.merge(check_expression(policy['signals'][args[0]], policy, f'$.signals.{args[0]}',
                                        {**options, 'stack': [*stack, args[0]]}))
        elif op == 'object':
            require_at(is_object(args[0]), path, 'object expression needs a field map')
            for k, v in args[0].items():
                child(v, f'{path}.args[0].{k}')
        else:
            for i, v in enumerate(args):
                child(v, f'{path}.args[{i}]')
    return refs


def level_index(q: dict, v: Any) -> int:
    """A level is named by its declared name, its text, or its zero-based index."""
    criteria = q.get('criteria', [])
    if isinstance(v, int) and not isinstance(v, bool):
        return v if 0 <= v < len(criteria) else -1
    named = -1
    if isinstance(v, str):
        names = q.get('levelNames') or []
        named = names.index(v) if v in names else -1
    if named >= 0:
        return named
    for i, x in enumerate(criteria):
        if equal(x, v):
            return i
    return -1


def option_wire(q: dict, ref: Any):
    """An option reference resolves to the wire key the model answers with."""
    if not isinstance(ref, str):
        return None
    names = q.get('names') or {}
    if ref in names:
        return names[ref]
    return ref if ref in q.get('criteria', {}) else None


def option_code(q: dict, wire: str) -> str:
    """The name the policy uses for a wire key: its code name, else the key itself."""
    for name, w in (q.get('names') or {}).items():
        if w == wire:
            return name
    return wire


def option_names(q: dict) -> list[str]:
    names = q.get('names') or {}
    wires = list(names.values())
    return [*names, *(k for k in q.get('criteria', {}) if k not in wires)]


def evaluate_expression(x: dict, ctx) -> Any:
    op, a = x['op'], x['args']

    def run(y):
        return evaluate_expression(y, ctx)

    if op in ACCESSORS:
        return ctx.read(op, a[0], a[1] if len(a) > 1 else None, run)
    if op == 'literal':
        return a[0]
    if op == 'fact':
        require_at(own(ctx.facts, a[0]), f'facts.{a[0]}', 'missing observed fact',
                   'Pass facts or build them from the input.', 'answers')
        if getattr(ctx, 'log_fact', None):
            ctx.log_fact(a[0], ctx.facts[a[0]])
        return ctx.facts[a[0]]
    if op == 'threshold':
        return ctx.threshold(a[0])
    if op == 'signal':
        return run(ctx.policy['signals'][a[0]])
    if op == 'variable':
        return ctx.variables.get(a[0])
    if op == 'and':
        return all(truth(run(x)) for x in a)
    if op == 'or':
        return any(truth(run(x)) for x in a)
    if op == 'not':
        return not truth(run(a[0]))
    if op == 'if':
        return run(a[1] if truth(run(a[0])) else a[2])
    if op == 'object':
        return {k: run(v) for k, v in a[0].items()}
    if op == 'array':
        return [run(x) for x in a]
    if op == 'eq':
        return equal(run(a[0]), run(a[1]))
    if op == 'ne':
        return not equal(run(a[0]), run(a[1]))
    if op == 'get':
        obj, key = run(a[0]), run(a[1])
        require_at(isinstance(key, str) or (isinstance(key, int) and not isinstance(key, bool)),
                   'expression.get', 'key must be a string or integer')
        if own(obj, key):
            return obj[key] if not isinstance(obj, list) else obj[int(key)]
        if len(a) == 3:
            return run(a[2])
        fail('expression', 'expression.get', f"missing field '{key}'", 'Provide a default or a present field.')
    if op == 'length':
        v = run(a[0])
        require_at(isinstance(v, (str, list)), 'expression.length', 'expected string or array')
        return len(v)
    if op == 'contains':
        xs, v = run(a[0]), run(a[1])
        require_at(isinstance(xs, list), 'expression.contains', 'expected an array')
        return any(equal(x, v) for x in xs)
    values = [run(x) for x in a]
    require_at(all(finite(v) for v in values), f'expression.{op}',
               'arithmetic/comparison needs finite numbers')
    l, r = values[0], values[1]
    if op == 'gt':
        return l > r
    if op == 'gte':
        return l >= r
    if op == 'lt':
        return l < r
    if op == 'lte':
        return l <= r
    if op == 'add':
        value = sum(values)
    elif op == 'mul':
        value: Any = 1
        for x in values:
            value = value * x
    elif op == 'sub':
        value = l - r
    else:
        value = l / r
    require_at(finite(value), f'expression.{op}', 'arithmetic produced a non-finite result',
               'Avoid division by zero and numeric overflow.')
    return value


def truth(v: Any) -> bool:
    """Conditions have the same false-only semantics as Racket; None is JSON null."""
    return v is not False
