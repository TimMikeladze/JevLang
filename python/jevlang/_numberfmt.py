"""JS- and Racket-compatible number and JSON formatting.

The Racket oracle prints numbers through real->decimal-string and the TypeScript
engine through ECMAScript's Number::toString, so every report that must match
byte-for-byte formats through here. Nothing else in the package may invent a
number format.
"""
from __future__ import annotations

import json
import math
from decimal import Decimal, ROUND_FLOOR, ROUND_HALF_EVEN
from typing import Any


def js_number_str(x: Any) -> str:
    """ECMAScript Number::toString(10) for a finite number."""
    if isinstance(x, bool):
        return 'true' if x else 'false'
    if isinstance(x, int):
        if -(2 ** 53) < x < 2 ** 53:
            return str(x)
        x = float(x)
    if not math.isfinite(x):
        raise ValueError('non-finite number is not portable JSON')
    if x == 0:
        return '0'
    s = repr(abs(x))
    if 'e' in s:
        mant, _, exp = s.partition('e')
        e = int(exp)
    else:
        mant, e = s, 0
    int_part, _, frac = mant.partition('.')
    digits = int_part + frac
    e -= len(frac)
    digits = digits.lstrip('0')
    stripped = digits.rstrip('0')
    e += len(digits) - len(stripped)
    digits = stripped or '0'
    k = len(digits)
    n = e + k  # digits left of the decimal point
    negative = math.copysign(1, x) < 0
    if k <= n <= 21:
        body = digits + '0' * (n - k)
    elif 0 < n <= 21:
        body = digits[:n] + '.' + digits[n:]
    elif -6 < n <= 0:
        body = '0.' + '0' * -n + digits
    else:
        e = n - 1
        sign = '+' if e > 0 else '-'
        body = (digits if k == 1 else digits[0] + '.' + digits[1:]) + 'e' + sign + str(abs(e))
    return ('-' if negative else '') + body


def jsonify(value: Any) -> str:
    """JSON.stringify: compact separators, JS number spelling, insertion order."""
    if value is None:
        return 'null'
    if value is True:
        return 'true'
    if value is False:
        return 'false'
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, (int, float)):
        return js_number_str(value)
    if isinstance(value, (list, tuple)):
        return '[' + ','.join(jsonify(x) for x in value) + ']'
    if isinstance(value, dict):
        return '{' + ','.join(json.dumps(k, ensure_ascii=False) + ':' + jsonify(v) for k, v in value.items()) + '}'
    raise ValueError('value is not portable JSON')


def canonical(value: Any) -> str:
    """Sorted-key JSON text: the identity behind fingerprints and equality."""
    if isinstance(value, (list, tuple)):
        return '[' + ','.join(canonical(x) for x in value) + ']'
    if isinstance(value, dict):
        return '{' + ','.join(json.dumps(k, ensure_ascii=False) + ':' + canonical(value[k]) for k in sorted(value)) + '}'
    return jsonify(value)


def to_fixed(x: Any, places: int) -> str:
    """ECMAScript Number.prototype.toFixed: nearest, ties pick the larger n."""
    scaled = Decimal(x) * (Decimal(10) ** places)
    low = scaled.to_integral_value(rounding=ROUND_FLOOR)
    rest = scaled - low
    if rest > Decimal('0.5'):
        n = low + 1
    elif rest < Decimal('0.5'):
        n = low
    else:
        n = low + 1
    sign = '-' if n < 0 else ''
    text = str(abs(n)).rjust(places + 1, '0')
    return sign + (text if places == 0 else text[:-places] + '.' + text[-places:])


def decimal_string(x: Any, places: int = 2) -> str:
    """Racket's real->decimal-string: the exact double, rounded half to even."""
    if not math.isfinite(x):
        return js_number_str(x)
    d = Decimal(x).quantize(Decimal(1).scaleb(-places), rounding=ROUND_HALF_EVEN)
    sign = '-' if d < 0 else ''
    return sign + f'{abs(d):.{places}f}'
