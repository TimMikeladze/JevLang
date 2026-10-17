"""Label harvesting: decided cases plus what people did with them become labeled
fixtures that tuning and calibration read.

The portable mirror of src/harvest.mjs. A store is a directory with three
subdirectories, one JSON file per case: pending/ (decided, no outcome yet),
labeled/ (settled with a label), unlabeled/ (settled, but nothing says what
the right decision was). Each file is a version 3 fixture, plus case_id,
decided_at, escalated, the outcome history, and once settled label_strength,
label_source and settled_at.

The label is derived from the whole history every time an outcome arrives, so
the rules hold whatever order things came in. A weak label is silence taken
as agreement, which tuning can leave out."""
from __future__ import annotations

import datetime
import hashlib
import json
import os
import re
from typing import Any, Dict, List, Optional

from ._common import is_object, require_at
from ._numberfmt import jsonify


def _sha256_hex(text: str) -> str:
    return hashlib.sha256(text.encode('utf8')).hexdigest()


def _iso(seconds: int) -> str:
    return datetime.datetime.fromtimestamp(seconds, datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


_SAFE_CHAR = re.compile(r'[A-Za-z0-9._-]')
_MAX_NAME = 64


def _escape_char(c: str) -> str:
    return ''.join(f'%{b:02X}' for b in c.encode('utf8'))


def safe_case_name(id: Any) -> str:
    """A case id as a file name: characters outside [A-Za-z0-9._-] become %XX
    (UTF-8 bytes), as does a leading dot, so no id can climb out of the store
    or hide. An escaped name longer than 64 characters is cut at a character
    boundary and gets '~' plus 16 hex digits of the id's SHA-256."""
    s = id if isinstance(id, str) else str(id)
    require_at(s != '', 'caseId', 'a case id must not be empty')
    pieces = [c if (_SAFE_CHAR.match(c) and not (i == 0 and c == '.')) else _escape_char(c)
              for i, c in enumerate(s)]
    whole = ''.join(pieces)
    if len(whole) <= _MAX_NAME:
        return whole
    kept = ''
    for piece in pieces:
        if len(kept) + len(piece) > _MAX_NAME:
            break
        kept += piece
    return f'{kept}~{_sha256_hex(s)[:16]}'


DECISION_KINDS = ['assign', 'page', 'escalate', 'hold', 'confirm', 'next', 'act', 'plan']


def _check_action(action: Any, what: str) -> str:
    require_at(action in DECISION_KINDS, what, f"'{action}' is not a decision kind",
               f"One of: {', '.join(DECISION_KINDS)}.")
    return action


_LABEL_SPEC = re.compile(r'^\s*([^:\s]+)\s*(?::\s*(\S.*?)\s*)?$')


def parse_label_spec(text: str) -> dict:
    """'"assign:billing-queue"' or '"hold"' -> {'action', 'target'?}"""
    m = _LABEL_SPEC.match(text)
    require_at(m is not None, 'label', 'a label is action[:target], like assign:billing-queue')
    action = _check_action(m.group(1), f"label '{text}'")
    return {'action': action, 'target': m.group(2)} if m.group(2) else {'action': action}


def normalize_label(v: Any) -> dict:
    """A label in the fixture format: a decision, that object, or
    'action[:target]'."""
    if isinstance(v, str):
        return parse_label_spec(v)
    require_at(is_object(v), 'label',
               'a label is {action, target}, a decision, or "action[:target]"')
    action = v.get('action')
    require_at(isinstance(action, str), 'label',
               'a label needs an "action", like {"action": "assign", "target": "billing-queue"}')
    _check_action(action, 'label')
    target = v.get('target') if v.get('target') is not None else None
    if target is None:
        return {'action': action}
    require_at(isinstance(target, str), 'label', 'a label\'s "target" must be a string')
    return {'action': action, 'target': target}


def label_to_string(l: Any) -> str:
    if is_object(l):
        return f"{l.get('action')} {l['target']}" if l.get('target') else f"{l.get('action', '?')}"
    return '?'


def escalation_decision(d: Any) -> bool:
    """A gate or band fired, so the model was not sure enough."""
    return (is_object(d) and d.get('rule') in ('gate', 'option-gate', 'band'))


def escalated_decision(d: Any) -> bool:
    """An escalation says 'a person decides', so a close without a label says
    nothing about what the right decision was."""
    return escalation_decision(d) or (is_object(d) and d.get('action') in ('hold', 'confirm', 'escalate'))


_WHERES = ['pending', 'labeled', 'unlabeled']


def harvest_dirs(directory: str) -> List[str]:
    return [os.path.join(directory, where) for where in _WHERES]


def _case_path(directory: str, where: str, name: str) -> str:
    return os.path.join(directory, where, f'{name}.json')


def _write_record(path: str, record: dict) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    temporary = f'{path}.{os.getpid()}.tmp'
    with open(temporary, 'w', encoding='utf8') as handle:
        handle.write(json.dumps(record, indent=2) + '\n')
    os.replace(temporary, path)


def _read_record(path: str) -> dict:
    with open(path, encoding='utf8') as handle:
        value = json.load(handle)
    require_at(is_object(value), path, 'not a JSON object')
    return value


async def harvest_find(directory: str, id: Any) -> dict:
    """-> {'where', 'record', 'path'}, or Nones when the case is unknown. A
    crash between writing a case's new file and deleting its old one leaves it
    in two places; the copy with the longer history wins and the other goes."""
    sid = str(id)
    name = safe_case_name(sid)
    found = []
    for where in _WHERES:
        path = _case_path(directory, where, name)
        if not os.path.exists(path):
            continue
        record = _read_record(path)
        stored = record.get('case_id')
        require_at(not isinstance(stored, str) or stored == sid, path,
                   f"case ids '{stored}' and '{sid}' map to the same file",
                   'The file system ignores letter case; make the ids differ by more than case.')
        found.append({'where': where, 'record': record, 'path': path})
    if not found:
        return {'where': None, 'record': None, 'path': None}
    best = found[0]
    for other in found[1:]:
        if len(other['record'].get('outcomes') or []) > len(best['record'].get('outcomes') or []):
            best = other
    for other in found:
        if other is not best:
            os.unlink(other['path'])
    return best


async def harvest_add(directory: str, *, case_id: Any, fixture: dict, decision: Optional[dict],
                      source: Any = None, now: Any = None) -> dict:
    """Saves a decided case as pending. A second case with the same id replaces
    a pending one and keeps its history; a settled case is left alone."""
    if now is None:
        import time
        now = lambda: int(time.time())  # noqa: E731
    sid = str(case_id)
    name = safe_case_name(sid)
    found = await harvest_find(directory, sid)
    if found['where'] and found['where'] != 'pending':
        record = found['record']
        return {'caseId': sid, 'where': found['where'],
                'label': record.get('label') if record.get('label') is not None else None,
                'strength': record.get('label_strength') if record.get('label_strength') is not None else None,
                'source': record.get('label_source') if record.get('label_source') is not None else None,
                'path': found['path'], 'status': 'settled'}
    record: Dict[str, Any] = {**fixture,
                              'name': name,
                              'case_id': sid,
                              'decided_at': _iso(now()),
                              'escalated': escalated_decision(decision),
                              'outcomes': (found['record'].get('outcomes') or []) if found['record'] else []}
    if source:
        record['source'] = str(source)
    if decision:
        expect: Dict[str, Any] = {'action': decision.get('action')}
        if decision.get('target'):
            expect['target'] = decision['target']
        record['expect'] = expect
    path = _case_path(directory, 'pending', name)
    _write_record(path, record)
    return {'caseId': sid, 'where': 'pending', 'label': None, 'strength': None, 'source': None,
            'path': path, 'status': 'updated' if found['record'] else 'added'}


def _last_where(lst: List[Any], predicate: Any) -> Any:
    hits = [x for x in lst if predicate(x)]
    return hits[-1] if hits else None


def derive_label(record: dict) -> dict:
    """The settle rules, over the whole history."""
    outcomes = record.get('outcomes') or []
    escalated = record.get('escalated') is True
    expect = record.get('expect') if is_object(record.get('expect')) else None
    correction = _last_where(outcomes, lambda o: o.get('kind') == 'correction')
    labeled_close = _last_where(outcomes, lambda o: o.get('kind') == 'close' and is_object(o.get('label')))
    close = _last_where(outcomes, lambda o: o.get('kind') == 'close')
    timeout = _last_where(outcomes, lambda o: o.get('kind') == 'timeout')
    if correction:
        return {'where': 'labeled', 'label': correction.get('label'), 'strength': 'strong',
                'source': 'correction'}
    if labeled_close:
        return {'where': 'labeled', 'label': labeled_close.get('label'), 'strength': 'strong',
                'source': 'close'}
    if close:
        if escalated or not expect:
            return {'where': 'unlabeled', 'label': None, 'strength': None, 'source': 'close'}
        return {'where': 'labeled', 'label': expect, 'strength': 'strong', 'source': 'close'}
    if timeout:
        if escalated or not expect:
            return {'where': 'unlabeled', 'label': None, 'strength': None, 'source': 'timeout'}
        return {'where': 'labeled', 'label': expect, 'strength': 'weak', 'source': 'timeout'}
    return {'where': 'pending', 'label': None, 'strength': None, 'source': None}


def _merged_labels(record: dict) -> dict:
    """Per-question labels from every outcome, later ones winning per question."""
    acc: Dict[str, Any] = dict(record.get('labels')) if is_object(record.get('labels')) else {}
    for o in record.get('outcomes') or []:
        if is_object(o.get('labels')):
            acc = {**acc, **o['labels']}
    return acc


async def _settle_record(directory: str, record: dict, old_path: Optional[str], now: Any) -> dict:
    """Re-derives the label and moves the file to where it now belongs."""
    settled_info = derive_label(record)
    where, label, strength, source = (settled_info['where'], settled_info['label'],
                                      settled_info['strength'], settled_info['source'])
    labels = _merged_labels(record)
    base = {k: v for k, v in record.items()
            if k not in ('label', 'label_strength', 'label_source', 'settled_at', 'labels')}
    settled = {**base,
               **({'labels': labels} if labels else {}),
               **({'label': label, 'label_strength': strength} if label else {}),
               **({} if where == 'pending' else {'label_source': source, 'settled_at': _iso(now())})}
    path = _case_path(directory, where, safe_case_name(record['case_id']))
    _write_record(path, settled)
    if old_path and os.path.realpath(old_path) != os.path.realpath(path):
        os.unlink(old_path)
    return {'caseId': record['case_id'], 'where': where, 'label': label, 'strength': strength,
            'source': source, 'path': path, 'status': 'updated'}


async def harvest_outcome(directory: str, id: Any, kind: str, *, label: Any = None,
                          labels: Any = None, now: Any = None) -> dict:
    """kind: 'correction' (a person changed the decision; needs a label) or
    'close'."""
    if now is None:
        import time
        now = lambda: int(time.time())  # noqa: E731
    require_at(kind in ('correction', 'close'), 'kind', "an outcome is 'correction' or 'close'")
    require_at(kind != 'correction' or label, 'label',
               'a correction needs the label the person chose',
               'Pass a label, or record a close.')
    require_at(labels is None or is_object(labels), 'labels',
               'per-question labels are an object, like {"department": "billing"}')
    normalized = normalize_label(label) if label else None
    found = await harvest_find(directory, id)
    if not found['where']:
        return {'caseId': str(id), 'where': None, 'label': None, 'strength': None, 'source': None,
                'path': None, 'status': 'unknown'}
    outcome = {'kind': kind, 'label': normalized, 'labels': labels, 'at': _iso(now())}
    return await _settle_record(directory,
                                {**found['record'], 'outcomes': [*(found['record'].get('outcomes') or []), outcome]},
                                found['path'], now)


_ISO8601 = re.compile(r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$')


def parse_iso8601(text: Any) -> Optional[int]:
    """'"2026-09-18T12:00:00Z"' -> seconds, or None"""
    if not isinstance(text, str) or not _ISO8601.match(text):
        return None
    try:
        at = datetime.datetime.strptime(text, '%Y-%m-%dT%H:%M:%S.%fZ').replace(tzinfo=datetime.timezone.utc)
    except ValueError:
        try:
            at = datetime.datetime.strptime(text, '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=datetime.timezone.utc)
        except ValueError:
            return None
    return int(at.timestamp())


def _pending_paths(directory: str) -> List[str]:
    d = os.path.join(directory, 'pending')
    if not os.path.exists(d):
        return []
    return [os.path.join(d, f) for f in sorted(os.listdir(d)) if f.endswith('.json')]


async def harvest_settle(directory: str, *, after: int = 7 * 86400, now: Any = None,
                         dry_run: bool = False) -> dict:
    """Settles every pending case decided at least `after` seconds ago as a
    timeout. With dry_run, says what would happen and writes nothing. Files
    whose decided_at cannot be read are skipped and named."""
    if now is None:
        import time
        now = lambda: int(time.time())  # noqa: E731
    at = now()
    done, skipped = [], []
    for path in _pending_paths(directory):
        record = None
        try:
            record = _read_record(path)
        except Exception:
            record = None
        decided = parse_iso8601(record.get('decided_at')) if record else None
        if not record or decided is None or not isinstance(record.get('case_id'), str):
            skipped.append(path)
            continue
        if at - decided < after:
            continue
        updated = {**record,
                   'outcomes': [*(record.get('outcomes') or []),
                                {'kind': 'timeout', 'label': None, 'labels': None, 'at': _iso(at)}]}
        if dry_run:
            done.append({'caseId': record['case_id'], **derive_label(updated), 'path': path,
                         'status': 'updated'})
        else:
            done.append(await _settle_record(directory, updated, path, lambda: at))
    return {'settled': done, 'skipped': skipped}


async def harvest_status(directory: str, *, after: int = 7 * 86400, now: Any = None) -> dict:
    """Counts for a status report. after and now say how many pending cases a
    settle would time out."""
    if now is None:
        import time
        now = lambda: int(time.time())  # noqa: E731
    at = now()

    def records(where: str) -> List[dict]:
        d = os.path.join(directory, where)
        if not os.path.exists(d):
            return []
        out = []
        for file in sorted(os.listdir(d)):
            if not file.endswith('.json'):
                continue
            try:
                out.append(_read_record(os.path.join(d, file)))
            except Exception:  # unreadable files are not counted
                pass
        return out

    pending = records('pending')
    labeled = records('labeled')
    unlabeled = records('unlabeled')

    def count_by(key: str, rs: List[dict]) -> Dict[str, int]:
        acc: Dict[str, int] = {}
        for r in rs:
            k = r[key] if isinstance(r.get(key), str) else 'unknown'
            acc[k] = acc.get(k, 0) + 1
        return acc

    ages = [a for a in (parse_iso8601(r.get('decided_at')) for r in pending) if a is not None]
    return {
        'dir': os.path.realpath(directory),
        'pending': len(pending),
        'pending_due': sum(1 for a in ages if at - a >= after),
        'oldest_pending_seconds': (at - min(ages)) if ages else None,
        'labeled': len(labeled),
        'strong': sum(1 for r in labeled if r.get('label_strength') == 'strong'),
        'weak': sum(1 for r in labeled if r.get('label_strength') == 'weak'),
        'labeled_by_source': count_by('label_source', labeled),
        'unlabeled': len(unlabeled),
        'unlabeled_by_source': count_by('label_source', unlabeled),
    }
