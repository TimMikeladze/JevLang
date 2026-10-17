"""Shared engine plumbing: errors, checks, portable JSON, fingerprints."""
from __future__ import annotations

import hashlib
import math
from typing import Any

from ._numberfmt import canonical, jsonify

MAX_SAFE_INTEGER = 2 ** 53 - 1


class JevError(ValueError):
    def __init__(self, code: str, path: str, message: str, fix: str | None = None):
        super().__init__(f"{path}: {message}" + (f"\n  {fix}" if fix else ''))
        self.code = code
        self.path = path
        self.message = f"{path}: {message}" + (f"\n  {fix}" if fix else '')
        self.fix = fix

    def to_json(self) -> dict:
        return {'code': self.code, 'path': self.path, 'message': self.message, 'fix': self.fix}


def own(o: Any, k: Any) -> bool:
    if isinstance(o, dict):
        return k in o
    if isinstance(o, list) and isinstance(k, int) and not isinstance(k, bool):
        return 0 <= k < len(o)
    return False


def is_object(v: Any) -> bool:
    return isinstance(v, dict)


def finite(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def probability(v: Any) -> bool:
    return finite(v) and 0 <= v <= 1


def text(v: Any) -> bool:
    return isinstance(v, str) and len(v.strip()) > 0


def fail(code: str, path: str, message: str, fix: str | None = None):
    raise JevError(code, path, message, fix)


def require_at(ok: bool, path: str, message: str, fix: str | None = None, code: str = 'validation'):
    if not ok:
        fail(code, path, message, fix)


def json_copy(value: Any, *, max_bytes: int = 2 * 1024 * 1024) -> Any:
    """Accept only portable JSON, with deterministic resource bounds."""
    nodes = 0
    ancestors: set[int] = set()

    def visit(v: Any, path: str, depth: int) -> Any:
        nonlocal nodes
        nodes += 1
        require_at(nodes <= 50000 and depth <= 64, path,
                   'policy/input exceeds structural limits',
                   'Use at most 50,000 nodes and 64 nesting levels.')
        if v is None or isinstance(v, str) or isinstance(v, bool):
            return v
        if isinstance(v, int):
            # JS parses every number as a double; mirror it past the safe range.
            return float(v) if not (-MAX_SAFE_INTEGER - 1 < v < MAX_SAFE_INTEGER + 1) else v
        if isinstance(v, float):
            require_at(math.isfinite(v), path, 'number must be finite')
            return v
        if isinstance(v, (list, tuple)):
            require_at(id(v) not in ancestors, path, 'cyclic values are not portable JSON')
            ancestors.add(id(v))
            result = [visit(x, f'{path}[{i}]', depth + 1) for i, x in enumerate(v)]
            ancestors.discard(id(v))
            return result
        if isinstance(v, dict):
            require_at(id(v) not in ancestors, path, 'cyclic values are not portable JSON')
            require_at(True, path, 'expected portable JSON',
                       'Use JSON values or a Jev expression builder; callbacks cannot be deployed.')
            ancestors.add(id(v))
            result = {}
            for k, x in v.items():
                require_at(isinstance(k, str), path, 'expected portable JSON',
                           'Use JSON values or a Jev expression builder; callbacks cannot be deployed.')
                result[k] = visit(x, f'{path}.{k}', depth + 1)
            ancestors.discard(id(v))
            return result
        fail('validation', path, 'expected portable JSON',
             'Use JSON values or a Jev expression builder; callbacks cannot be deployed.')

    result = visit(value, '$', 0)
    require_at(len(jsonify(result).encode('utf-8')) <= max_bytes, '$', f'JSON exceeds {max_bytes // (1024 * 1024)} MiB limit')
    return result


def fingerprint(v: Any) -> str:
    return hashlib.sha256(canonical(v).encode('utf-8')).hexdigest()


def equal(a: Any, b: Any) -> bool:
    return canonical(a) == canonical(b)


def keys_only(v: Any, allowed: list[str], path: str):
    require_at(is_object(v), path, 'expected an object')
    for k in v:
        require_at(k in allowed, f'{path}.{k}', f"unknown field '{k}'",
                   f"Allowed fields: {', '.join(allowed)}.")


def _edit_distance(a: str, b: str) -> int:
    prev = list(range(len(b) + 1))
    for i in range(1, len(a) + 1):
        cur = [i]
        for j in range(1, len(b) + 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (0 if a[i - 1] == b[j - 1] else 1)))
        prev = cur
    return prev[len(b)]


def closest(key: str, known: list[str]) -> str | None:
    scored = sorted((_edit_distance(key, k), k) for k in known if isinstance(k, str))
    return scored[0][1] if scored and scored[0][0] <= 2 else None


def did_you_mean(key: Any, known: list[str]) -> str:
    guess = closest(str(key), known)
    return f" Did you mean '{guess}'?" if guess else ''
