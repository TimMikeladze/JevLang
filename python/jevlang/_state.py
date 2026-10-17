"""Redaction and bounded state assembly, ported from jev-lang/state.rkt.

These are heuristics with the same documented false positives/negatives.
"""
from __future__ import annotations

import re
from typing import Any, Callable

from ._common import is_object, require_at, own

REDACTOR_NAMES = ['emails', 'ssn', 'cards', 'phones', 'ips', 'keys', 'urls']

_phone_key = re.compile(r'phone|mobile|cell|fax|whatsapp|sms|(?<![a-z])tel(?![a-z])', re.I)
_id_key = re.compile(r'order|invoice|ref|tracking|sku|ticket|txn|transaction|confirmation|account|acct|serial|item|product|(?<![a-z])id|id$', re.I)
_secret_key = re.compile(r'(?:api[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|secret(?:[_-]?key)?|private[_-]?key|password|passwd|pwd|token|authorization|credentials?)$', re.I)
_phone_cue = re.compile(r'(?<![a-z<])(phone|tel|call|cell|mobile|text|sms|fax|whatsapp|contact|reach|dial)(?![a-z>])|(?<![a-z])(?:order|invoice|inv|ref|reference|tracking|sku|ticket|case|txn|transaction|confirmation|conf|id|acct|account|po|serial|item|product|part|no\.)(?![a-z])|#', re.I)
_ssn_cue = re.compile(r'(?<![a-z<])(?:ssns?|ss#|s\.s\.n\.?|social[ _-]?sec(?:urity)?)(?![a-z>])', re.I)
_octet = r'(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])'
_ipv4_exact = re.compile(rf'^(?:{_octet}\.){{3}}{_octet}$')


def _is_card(s: str) -> bool:
    if not re.fullmatch(r'[2-6][0-9]{12,18}', s):
        return False
    total = 0
    for i, digit in enumerate(reversed(s)):
        n = int(digit) * (2 if i % 2 else 1)
        total += n - 9 if n > 9 else n
    return total % 10 == 0


def _redact_card_run(run: str) -> str:
    groups = list(re.finditer(r'[0-9]+', run))
    at = 0
    out = ''
    i = 0
    while i < len(groups):
        digits = ''
        end = -1
        j = i
        while j < len(groups):
            if j > i and len(groups[j - 1].group()) < 4:
                break
            digits += groups[j].group()
            if len(digits) > 19:
                break
            if _is_card(digits):
                end = j
            j += 1
        start_offset = end_offset = None
        if end >= 0:
            start_offset = groups[i].start()
            end_offset = groups[end].end()
            i = end
        else:
            s = groups[i].group()
            if 20 <= len(s) <= 25:
                for side in ('prefix', 'suffix'):
                    for n in range(19, 12, -1):
                        part = s[:n] if side == 'prefix' else s[-n:]
                        if _is_card(part):
                            start_offset = groups[i].start() + (0 if side == 'prefix' else len(s) - n)
                            end_offset = start_offset + n
                            break
                    if start_offset is not None:
                        break
        if start_offset is not None:
            out += run[:at] + '<card>'
            at = end_offset
        i += 1
    return out + run[at:]


def _valid_ipv6(s: str) -> bool:
    hexpart = s
    if '.' in s:
        m = re.match(r'^(.*:)([0-9.]+)$', s)
        if not m or not _ipv4_exact.match(m.group(2)):
            return False
        hexpart = f'{m.group(1)}0:0'
    if ':::' in hexpart or (hexpart.startswith(':') and not hexpart.startswith('::')) or (hexpart.endswith(':') and not hexpart.endswith('::')):
        return False
    doubles = len(re.findall('::', hexpart))
    groups = [g for g in hexpart.split(':') if g]
    ok = (doubles <= 1 and all(re.fullmatch(r'[0-9a-f]{1,4}', g, re.I) for g in groups)
          and (groups and len(groups) <= 7 if doubles else len(groups) == 8)
          and len(''.join(groups)) >= 3)
    return bool(ok)


# Each callback receives (match tuple, whole string, offset, context).
def _bearer(m, s, i, ctx):
    return m[1] + '<key>' if (re.search(r'[0-9]', m[2] or '') or len(m[2]) >= 32) else m[0]


def _pair(m, s, i, ctx):
    return m[1] + '<key>' if (re.search(r'[0-9]', m[2] or '') or len(m[2]) >= 12 or re.search(r'=["\']?$', m[1])) else m[0]


def _prefixed(m, s, i, ctx):
    return '<key>' if any(re.search(r'[A-Za-z]', x.group()) and re.search(r'[0-9]', x.group())
                          for x in re.finditer(r'[A-Za-z0-9]{8,}', m[0])) else m[0]


def _ssn9(m, s, i, ctx):
    around = (re.search(r'ssn|social[ _-]?sec', ctx or '', re.I)
              or _ssn_cue.search(s[max(0, i - 24):i])
              or _ssn_cue.search(s[i + len(m[0]):i + len(m[0]) + 24]))
    return '<ssn>' if around else m[0]


def _cards(m, s, i, ctx):
    return _redact_card_run(m[0])


def _phone_10(m, s, i, ctx):
    if _phone_key.search(ctx or ''):
        return '<phone>'
    if _id_key.search(ctx or ''):
        return m[0]
    cues = list(_phone_cue.finditer(s[max(0, i - 24):i]))
    return m[0] if cues and not cues[-1].group(1) else '<phone>'


def _ipv6(m, s, i, ctx):
    return '<ip>' if _valid_ipv6(m[0]) else m[0]


def _ipv4(m, s, i, ctx):
    keep = (re.search(r'version|release|build|firmware', ctx or '', re.I)
            or re.search(r'(?<![a-z])(?:version|ver|release|rel|v|firmware|fw|build|rev)\.?[ \t]*[:=#]?[ \t]*$', s[max(0, i - 16):i], re.I))
    return m[0] if keep else '<ip>'


# (name, compiled pattern, replacement) in application order.
_REDACTORS: list[tuple[str, re.Pattern, Any]] = [
    ('emails', re.compile(r'(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@(?:(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}|localhost(?![A-Za-z0-9-]|\.[A-Za-z0-9]))', re.I), '<email>'),
    ('urls', re.compile(r'\bhttps?://[^\s"\'<>]*[^\]\s"\'<>.,;:!?)]'), '<url>'),
    ('urls', re.compile(r'\bwww\.[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+(?:[/?#](?:[^\s"\'<>]*[^\]\s"\'<>.,;:!?)]))?'), '<url>'),
    ('keys', re.compile(r'(?<![A-Za-z0-9])(bearer[ \t]+)([A-Za-z0-9._~+/-]{11,}[A-Za-z0-9_~+/-]=*)', re.I), _bearer),
    ('keys', re.compile(r'(?<![A-Za-z0-9])((?:api[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|client[_-]?secret|secret[_-]?key|private[_-]?key|password|passwd|pwd)["\']?[ \t]*[:=][ \t]*["\']?)([^\s"\'&,;<>]{4,})', re.I), _pair),
    ('keys', re.compile(r'(?<![A-Za-z0-9_-])(?:(?:AKIA|ASIA)[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*|AIza[0-9A-Za-z_-]{35})(?![A-Za-z0-9])'), '<key>'),
    ('keys', re.compile(r'(?<![A-Za-z0-9])(?:sk|pk|rk|api|key|token|secret|bearer)[-_][A-Za-z0-9_-]{12,}(?![A-Za-z0-9_-])'), _prefixed),
    ('ssn', re.compile(r'(?<![0-9-])[0-9]{3}-[0-9]{2}-[0-9]{4}(?![0-9]|-[0-9])|(?<![0-9])(?<![0-9] )[0-9]{3} [0-9]{2} [0-9]{4}(?![0-9]| [0-9])'), '<ssn>'),
    ('ssn', re.compile(r'(?<![0-9])[0-9]{9}(?![0-9])'), _ssn9),
    ('cards', re.compile(r'(?<![0-9])[0-9]+(?:(?:[ \t]{1,2}|[ \t]?[-./][ \t]?|[ \t]*\r?\n[ \t]*)[0-9]+)*'), _cards),
    ('phones', re.compile(r'(?<![\w+])\+[0-9](?:[ .-]?\(?[0-9]\)?){7,14}(?![0-9])'), '<phone>'),
    ('phones', re.compile(r'(?<![\w+.-])(?:1[ .-]?)?(?:\([0-9]{3}\)[ .-]?|[0-9]{3}[ .-])[0-9]{3}[ .-][0-9]{4}(?![0-9]|[.-][0-9])'), '<phone>'),
    ('phones', re.compile(r'(?<![\w+.-])1?[2-9][0-9]{2}[2-9][0-9]{6}(?![\w]|[.-][0-9])'), _phone_10),
    ('ips', re.compile(r'(?<![\w:.])(?:[0-9A-Fa-f]{0,4}:){2,7}(?:[0-9]{1,3}(?:\.[0-9]{1,3}){3}|[0-9A-Fa-f]{0,4})(?![\w:]|\.[0-9A-Za-z])'), _ipv6),
    ('ips', re.compile(rf'(?<![0-9.])(?:{_octet}\.){{3}}{_octet}(?![0-9]|\.[0-9])'), _ipv4),
]


def redact_string(value: str, specs: list[str] | None = None, context: str | None = None) -> str:
    specs = REDACTOR_NAMES if specs is None else specs
    for name, pattern, replacement in _REDACTORS:
        if name not in specs:
            continue
        original = value

        def apply(m, _replacement=replacement, _original=original):
            match = (m.group(0), *[m.group(g) for g in range(1, (m.re.groups if hasattr(m, 're') else 0) + 1)])
            return _replacement if isinstance(_replacement, str) else _replacement(match, _original, m.start(), context)
        value = pattern.sub(apply, value)
    return value


def _rename_keys(obj: dict, specs: list[str]) -> dict:
    keys = sorted(obj)
    proposed = [redact_string(k, specs) for k in keys]
    taken = {k for k, p in zip(keys, proposed) if k == p}
    renames = {}
    for k, p in zip(keys, proposed):
        if k == p:
            continue
        n, j = p, 0
        while n in taken:
            j += 1
            n = f'{p}#{j}'
        taken.add(n)
        renames[k] = n
    return renames


def redact(value: Any, specs: list[str] | None = None, context: str | None = None, by_name: bool = True, asset_references=None) -> Any:
    specs = REDACTOR_NAMES if specs is None else specs
    if not len(specs):
        return value
    if by_name and context and 'keys' in specs and _secret_key.search(context) and (isinstance(value, (int, float)) and not isinstance(value, bool) or (isinstance(value, str) and len(value))):
        return '<key>'
    if isinstance(value, str):
        if asset_references:
            from ._assets import _segments
            return ''.join(text if image else redact_string(text, specs, context) for image, text in _segments(value, [r for r in asset_references if r]))
        return redact_string(value, specs, context)
    if isinstance(value, int) and not isinstance(value, bool) and abs(value) < 1e25:
        digits = str(abs(value)) if value < 0 else str(value)
        redacted = redact_string(digits, specs, context)
        return value if redacted == digits or (redacted == '<phone>' and not _phone_key.search(context or '')) else redacted
    if isinstance(value, float) and value.is_integer() and abs(value) < 1e25:
        digits = str(int(abs(value)))
        redacted = redact_string(digits, specs, context)
        return value if redacted == digits or (redacted == '<phone>' and not _phone_key.search(context or '')) else redacted
    if isinstance(value, list):
        return [redact(x, specs, context, by_name, asset_references) for x in value]
    if isinstance(value, dict):
        renamed = _rename_keys(value, specs)
        return {renamed.get(k, k): redact(v, specs, k, by_name, asset_references) for k, v in value.items()}
    return value


def redact_questions(questions: dict, specs: list[str] | None = None):
    specs = REDACTOR_NAMES if specs is None else specs
    maps: dict = {}
    result: dict = {}
    for id, q in questions.items():
        criteria = q.get('criteria') if is_object(q.get('criteria')) else {}
        renames = _rename_keys(criteria, specs) if q.get('type') == 'choice' else {}
        wire = {}
        for k, v in q.items():
            if k == 'type':
                wire[k] = v
            elif k == 'criteria' and renames:
                wire[k] = {renames.get(key, key): redact(content, specs, None, False) for key, content in v.items()}
            else:
                wire[k] = redact(v, specs, None, False)
        result[id] = wire
        if renames:
            maps[id] = {b: a for a, b in renames.items()}
    return {'questions': result, 'renames': maps}


def restore_answer_keys(answers: dict, renames: dict) -> dict:
    out = {}
    for id, a in answers.items():
        mapping = renames.get(id)
        if not mapping:
            out[id] = a
            continue
        table = mapping
        original = lambda key: table.get(key, key)
        fixed = dict(a)
        if isinstance(a.get('choice'), str):
            fixed['choice'] = original(a['choice'])
        if is_object(a.get('probabilities')):
            fixed['probabilities'] = {original(k): v for k, v in a['probabilities'].items()}
        out[id] = fixed
    return out


_TRUNCATION = ' ...[truncated]'
_MARKERS = ['<email>', '<phone>', '<card>', '<ssn>', '<key>', '<url>', '<ip>']
_length = len  # code points, as the Racket implementation counts them


def state_size(v: Any) -> int:
    from ._numberfmt import jsonify
    return _length(jsonify(v))


def cap_string(s: str, n: int, asset_references=None) -> str:
    chars = list(s)
    if len(chars) <= n:
        return s
    kept = n if n <= len(_TRUNCATION) else n - len(_TRUNCATION)
    for ref in (asset_references or []):
        if not ref: continue
        at = s.find(ref)
        while at >= 0:
            if at < kept < at + len(ref): kept = at
            at = s.find(ref, at + len(ref))
    suffix = '' if n <= len(_TRUNCATION) else _TRUNCATION
    for i in range(max(0, kept - 6), kept):
        if any(''.join(chars[i:i + len(m)]) == m for m in _MARKERS):
            return ''.join(chars[:i]) + suffix
    return ''.join(chars[:kept]) + suffix


def _map_strings(v: Any, fn: Callable[[str], str]) -> Any:
    if isinstance(v, str):
        return fn(v)
    if isinstance(v, list):
        return [_map_strings(x, fn) for x in v]
    if is_object(v):
        return {k: _map_strings(x, fn) for k, x in v.items()}
    return v


def _cut_strings(v: Any, over: int, floor: int, asset_references=None) -> Any:
    if over <= 0:
        return v
    lens: list[int] = []

    def collect(s: str) -> str:
        if _length(s) > floor:
            lens.append(_length(s))
        return s

    _map_strings(v, collect)
    lens.sort(reverse=True)
    total = 0
    cut = floor
    for i, x in enumerate(lens):
        total += x
        n = (total - over) // (i + 1)
        if n >= (lens[i + 1] if i + 1 < len(lens) else floor):
            cut = n
            break
    return _map_strings(v, lambda s: cap_string(s, cut, asset_references))


def _split_more(xs: list):
    if xs and isinstance(xs[-1], str):
        m = re.match(r'^\.\.\.\[([0-9]+) more\]$', xs[-1])
        if m:
            return {'items': xs[:-1], 'dropped': int(m.group(1))}
    return {'items': xs, 'dropped': 0}


def _drop_tails(v: Any, limit: int) -> Any:
    while state_size(v) > limit:
        best: list | None = None
        biggest = -1

        def walk(x, path):
            nonlocal best, biggest
            if isinstance(x, list):
                if len(_split_more(x)['items']) and state_size(x) > biggest:
                    biggest = state_size(x)
                    best = path
                for i, item in enumerate(x):
                    walk(item, path + [i])
            elif is_object(x):
                for key, item in x.items():
                    walk(item, path + [key])

        walk(v, [])
        if best is None or not isinstance(best, list):
            break
        path = best
        xs = v
        for k in path:
            xs = xs[k]
        items, dropped = _split_more(xs)['items'], _split_more(xs)['dropped']
        replacement = None
        for k in range(1, len(items) + 1):
            replacement = [*items[:-k], f'...[{dropped + k} more]']
            if state_size(xs) - state_size(replacement) >= state_size(v) - limit:
                break

        def set_at(x, path):
            if not path:
                return replacement
            if isinstance(x, list):
                return [set_at(item, path[1:]) if i == path[0] else item for i, item in enumerate(x)]
            return {k: set_at(item, path[1:]) if k == path[0] else item for k, item in x.items()}

        v = set_at(v, best)
    return v


def cap_value(value: Any, limit: int, path: str = 'state', string_field: bool = True, asset_references=None) -> Any:
    if isinstance(value, str) and string_field:
        return cap_string(value, limit, asset_references)
    out = value
    for floor in (256, 24):
        out = _drop_tails(_cut_strings(out, state_size(out) - limit, floor, asset_references), limit)
    require_at(state_size(out) <= limit, path,
               f'state remains {state_size(out)} characters after shrinking, above {limit}',
               'Raise maxChars, give large fields a per-field cap, or send fewer fields.', 'state')
    return out


def check_token_budget(state: Any, questions: dict | None = None, limit: int | float | None = 32000) -> Any:
    questions = questions or {}
    chars = state_size(state) + max([0] + [state_size(q) for q in questions.values()])
    estimated = -(-chars // 4)  # ceil
    require_at(limit is None or estimated <= limit, 'state',
               f'state plus longest question is about {estimated} tokens, above {limit} (~4 chars/token, rough estimate)',
               'Cap the state or send fewer fields; there is no public tokenizer.', 'state')
    return state
