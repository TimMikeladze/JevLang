"""Aggregate monitoring: summaries, calibration, window comparison, stability.

Nothing here raises an alarm: any fixed drift threshold would be invented.
Ported from monitor.mjs; the text reports are byte-identical to `raco jev`'s.
"""
from __future__ import annotations

import functools
import re
from typing import Any

from ._common import own, is_object, require_at, finite
from ._fixtures import matches
from ._cost import usage_cost
from ._numberfmt import decimal_string, js_number_str

# Below 0.5 is one bucket: a gate that low changes nothing. From 0.5 to 0.9 the
# buckets are 0.1 wide, the range tuning sweeps. The top is split at 0.95
# because confident answers pile up there.
CONFIDENCE_EDGES = [0, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 1.0]
# Noul answers spread over the whole of 0..1, so their reliability table uses
# ten equal bins instead.
DECILE_EDGES = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0]

GATE_RULES = ['gate', 'option-gate', 'band']
RULE_ORDER = ['precheck', 'gate', 'option-gate', 'band', 'route', 'else', 'untraced']


def bucket_index(c: float, edges=None) -> int:
    """The bucket holding c: [edge, next), with the last bucket closed."""
    edges = CONFIDENCE_EDGES if edges is None else edges
    for i, hi in enumerate(edges[1:]):
        if c < hi:
            return i
    return len(edges) - 2


def escalated(d: dict) -> bool:
    """A person or a slower tier gets the case: the policy said escalate, or a gate fired."""
    return d.get('action') == 'escalate' or d.get('rule') in GATE_RULES


def _rule_rank(r):
    i = RULE_ORDER.index(r) if r in RULE_ORDER else len(RULE_ORDER)
    return i


def _clause_key(d: dict):
    # Clauses are keyed by file, rule and index, so one summary can hold decisions
    # from several policies without merging clause 0 of one with clause 0 of another.
    if d.get('rule'):
        return [d.get('file'), d['rule'], d.get('clause')]
    return [None, 'untraced', None]


def _key_order(a, b):
    def s(v):
        return '' if v is None or v is False else str(v)
    if s(a[0]) != s(b[0]):
        return -1 if s(a[0]) < s(b[0]) else 1
    if a[1] != b[1]:
        return _rule_rank(a[1]) - _rule_rank(b[1])
    return (a[2] if a[2] is not None else -1) - (b[2] if b[2] is not None else -1)


def _question_group(id: str) -> str:
    # Families are sent as name--0, name--1, ...; a histogram groups them under
    # the family name.
    m = re.match(r'^(.+)--[0-9]+$', id)
    return m.group(1) if m else id


def _rate(n, d):
    return None if d == 0 else n / d


def _mean(xs):
    return sum(xs) / len(xs)


def _counted(xs):
    h: dict = {}
    for x in xs:
        h[x] = h.get(x, 0) + 1
    return h


def _observations(d: dict, answers):
    if answers:
        return [( _question_group(id), x['type'], x['confidence'])
                for id, x in answers.items()
                if is_object(x) and x.get('type') in ('choice', 'score', 'box') and finite(x.get('confidence'))]
    seen: set = set()
    out = []
    for r in [*(d.get('readings') or []), *(d.get('evidence') or [])]:
        if r.get('kind') in ('choice', 'score', 'box') and finite(r.get('confidence')):
            q = _question_group(r['question'])
            if q not in seen:
                seen.add(q)
                out.append((q, r['kind'], r['confidence']))
    return out


def summarize(decisions, answers=None, labels=None) -> dict:
    if answers is not None:
        require_at(len(answers) == len(decisions), 'answers', 'answers must be aligned with the decisions')
    if labels is not None:
        require_at(len(labels) == len(decisions), 'labels', 'labels must be aligned with the decisions')
    total = len(decisions)
    actions = _counted(d['action'] for d in decisions)
    targets = _counted(d.get('target') or '(no target)' for d in decisions)
    escalations = _counted(d.get('rule') or 'untraced' for d in decisions if escalated(d))
    clauses: dict = {}
    for d in decisions:
        key = _clause_key(d)
        from ._numberfmt import jsonify
        id = jsonify(key)
        entry = clauses.get(id)
        if entry is None:
            entry = {'key': key, 'file': key[0], 'rule': key[1], 'index': key[2],
                     'source': d.get('source') if d.get('rule') else None,
                     'line': d.get('line') if d.get('rule') else None, 'count': 0}
            clauses[id] = entry
        entry['count'] += 1
    table: dict = {}
    for i, d in enumerate(decisions):
        for q, kind, confidence in _observations(d, answers[i] if answers else None):
            id = f'{q}\x00{kind}'
            counts = table.get(id)
            if counts is None:
                counts = {'question': q, 'kind': kind, 'counts': [0] * (len(CONFIDENCE_EDGES) - 1)}
                table[id] = counts
            counts['counts'][bucket_index(confidence)] += 1
    tally = None
    if labels and any(labels):
        labeled = escalated_n = auto = wrong = 0
        for i, d in enumerate(decisions):
            l = labels[i]
            if not l:
                continue
            labeled += 1
            if escalated(d):
                escalated_n += 1
                continue
            auto += 1
            if not matches(l, d):
                wrong += 1
        tally = {'labeled': labeled, 'escalated': escalated_n, 'auto': auto, 'wrong': wrong}
    escalated_total = sum(1 for d in decisions if escalated(d))
    return {
        'total': total,
        'escalated': escalated_total,
        'escalation_rate': _rate(escalated_total, total),
        'escalations_by_rule': dict(sorted(escalations.items())),
        'actions': dict(sorted(actions.items())),
        'targets': dict(sorted(targets.items())),
        'clauses': [ {'file': c['file'], 'rule': c['rule'], 'index': c['index'], 'source': c['source'],
                      'line': c['line'], 'count': c['count'], 'share': _rate(c['count'], total) or 0}
                    for c in sorted(clauses.values(), key=functools.cmp_to_key(lambda a, b: _key_order(a['key'], b['key'])))],
        'confidence': {
            'source': 'answers' if answers else 'readings',
            'edges': CONFIDENCE_EDGES,
            'questions': [{'question': h['question'], 'kind': h['kind'], 'n': sum(h['counts']),
                           'counts': h['counts']}
                          for h in sorted(table.values(), key=lambda h: h['question'])],
        },
        'labels': ({**tally, 'wrong_rate': _rate(tally['wrong'], tally['auto'])} if tally else None),
    }


CALIBRATION_MIN_LABELS = 200


def _score_label_index(a, label):
    """A score label is a level index, or the level's text as the answer's legend gives it."""
    if isinstance(label, int) and not isinstance(label, bool) and label >= 0:
        return label
    if not isinstance(label, str):
        return None
    legend = a.get('legend') if is_object(a.get('legend')) else {}
    for k, v in legend.items():
        if v == label:
            return int(k)
    return None


def _noul_label(label):
    if label is True or label == 1 or label == 'yes' or label == 'true':
        return True
    if label is False or label == 0 or label == 'no' or label == 'false':
        return False
    return None


def _score_case(a, label):
    kind = a.get('type')
    if kind == 'choice':
        if finite(a.get('confidence')) and isinstance(a.get('choice'), str):
            return {'kind': 'choice', 'p': a['confidence'], 'outcome': a['choice'] == str(label)}
        return {'kind': 'choice', 'p': None}
    if kind == 'score':
        index = _score_label_index(a, label)
        ps = list(a['probabilities'].items()) if is_object(a.get('probabilities')) else None
        predicted = None
        if ps:
            predicted = int(sorted(ps, key=lambda t: (-t[1], float(t[0])))[0][0])
        if finite(a.get('confidence')) and index is not None and predicted is not None:
            return {'kind': 'score', 'p': a['confidence'], 'outcome': predicted == index}
        return {'kind': 'score', 'p': None}
    if kind == 'noul':
        y = _noul_label(label)
        if finite(a.get('noul')) and y is not None:
            return {'kind': 'noul', 'p': a['noul'], 'outcome': y}
        return {'kind': 'noul', 'p': None}
    return {'kind': None, 'p': None}


def calibrate(cases) -> list:
    """cases: [{answers, labels}], labels keyed by question, naming the right answer."""
    table: dict = {}
    for c in cases:
        if not (is_object(c) and is_object(c.get('answers')) and is_object(c.get('labels'))):
            continue
        for q, label in c['labels'].items():
            a = c['answers'].get(q)
            if not is_object(a):
                continue
            case = _score_case(a, label)
            if case['kind'] is None:
                continue
            entry = table.setdefault(q, {'kind': case['kind'], 'entries': []})
            entry['entries'].append('skipped' if case['p'] is None else {'p': case['p'], 'outcome': case['outcome']})
    out = []
    for q in sorted(table):
        kind, entries = table[q]['kind'], table[q]['entries']
        observed = [e for e in entries if e != 'skipped']
        edges = DECILE_EDGES if kind == 'noul' else CONFIDENCE_EDGES
        n = len(observed)
        bins = []
        for i, lo in enumerate(edges[:-1]):
            in_bin = [o for o in observed if bucket_index(o['p'], edges) == i]
            bins.append({
                'lo': lo, 'hi': edges[i + 1], 'n': len(in_bin),
                'mean_p': _mean([o['p'] for o in in_bin]) if in_bin else None,
                'accuracy': _mean([1 if o['outcome'] else 0 for o in in_bin]) if in_bin else None,
            })
        out.append({
            'question': q, 'kind': kind, 'n': n,
            'hits': sum(1 for o in observed if o['outcome']),
            'skipped': len(entries) - n,
            # Expected calibration error, and the Brier score of the same answers.
            'ece': sum((b['n'] / n) * abs(b['accuracy'] - b['mean_p']) for b in bins if b['n'] > 0) if n else None,
            'brier': _mean([(o['p'] - (1 if o['outcome'] else 0)) ** 2 for o in observed]) if n else None,
            'enough_labels': n >= CALIBRATION_MIN_LABELS,
            'bins': bins,
        })
    return out


# --- text reports ------------------------------------------------------------

def _fit(value, width, align='left', maximum=None):
    s = str(value)
    if maximum is not None and len(s) > maximum:
        s = s[:maximum]
    if len(s) >= width:
        return s
    return s.rjust(width) if align == 'right' else s.ljust(width)


def _pct(n, d):
    return '-' if d == 0 else f"{decimal_string((100 * n) / d, 1)}%"


def _pct1(x):
    return '-' if x is None else f"{decimal_string(100 * x, 1)}%"


def _points(x):
    return f"{'' if x < 0 else '+'}{decimal_string(100 * x, 1)}"


def _r3(x):
    return decimal_string(x, 3) if finite(x) else '-'


def _trimmed(x):
    return re.sub(r'\.?0+$', '', decimal_string(x, 3))


def _edge_string(e):
    return str(e) if isinstance(e, int) else _trimmed(e)


def _bucket_label(i, edges=None):
    edges = CONFIDENCE_EDGES if edges is None else edges
    return f'{_edge_string(edges[i])}-{_edge_string(edges[i + 1])}'


def _clause_name(c):
    file_part = f"{c['file']} " if c.get('file') else ''
    index_part = '' if c.get('index') is None else f" {c['index']}"
    return f"{file_part}{c['rule']}{index_part}"


def _counts_line(counts: dict) -> str:
    # Most frequent first; ties in name order, so the line is stable.
    return ', '.join(f'{k} {v}' for k, v in sorted(counts.items(), key=lambda t: (-t[1], t[0])))


def format_summary(s: dict) -> str:
    n = s['total']
    width = max([6] + [len(_clause_name(c)) for c in s['clauses']])
    l = s.get('labels')
    lines = [
        f"{n} decision{'' if n == 1 else 's'}",
        f"escalated: {s['escalated']} ({_pct(s['escalated'], n)})" + ('' if s['escalated'] == 0 else f"  by {_counts_line(s['escalations_by_rule'])}"),
        f"actions:   {_counts_line(s['actions'])}",
        f"targets:   {_counts_line(s['targets'])}",
        '',
        f"  {_fit('clause', width)}  count   share  source",
        *[f"  {_fit(_clause_name(c), width)}  {_fit(c['count'], 5, 'right')}  {_fit(_pct(c['count'], n), 6, 'right')}  {c.get('source') or ''}"
          for c in s['clauses']],
        '',
        f"confidence, {'every choice and score answer' if s['confidence']['source'] == 'answers' else 'from trace readings: only questions the firing clause read'} (bucket lower edges)",
        f"  {_fit('', 24)}{' '.join(_fit(_edge_string(e), 5, 'right') for e in CONFIDENCE_EDGES[:-1])}",
        *[f"  {_fit(str(h['question']) + ' (' + str(h['kind']) + ')', 24, 'left', 24)}{' '.join(_fit(c, 5, 'right') for c in h['counts'])}"
          for h in s['confidence']['questions']],
        *([] if s['confidence']['questions'] else ['  (no choice or score confidences)']),
        '',
        (f"labels: {l['labeled']} labeled; {l['escalated']} escalated, {l['auto']} decided by the policy, {l['wrong']} of those wrong ({_pct(l['wrong'], l['auto'])})"
         if l else 'labels: none, so no wrong rate'),
    ]
    return '\n'.join(lines)


def compare_windows(a, b) -> dict:
    """share_a / share_b are each clause's fraction of its own window; delta is b - a."""
    sa = summarize(a) if isinstance(a, list) else a
    sb = summarize(b) if isinstance(b, list) else b

    def key(c):
        from ._numberfmt import jsonify
        return jsonify([c.get('file'), c['rule'], c.get('index')])
    ta = {key(c): c for c in sa['clauses']}
    tb = {key(c): c for c in sb['clauses']}
    keys = sorted({*ta, *tb}, key=lambda k: functools.cmp_to_key(_key_order)( _json_key(k)))
    shifts = []
    for k in keys:
        ca = ta.get(k)
        cb = tb.get(k)
        parsed = _parse_key(k)
        na = ca['count'] if ca else 0
        nb = cb['count'] if cb else 0
        share_a = _rate(na, sa['total']) or 0
        share_b = _rate(nb, sb['total']) or 0
        shifts.append({'file': parsed[0], 'rule': parsed[1], 'index': parsed[2],
                       'source': (ca or cb or {}).get('source'),
                       'count_a': na, 'count_b': nb, 'share_a': share_a, 'share_b': share_b,
                       'delta': share_b - share_a})
    # A stable sort, so equal movements keep clause order.
    shifts = [s for _, s in sorted(enumerate(shifts), key=lambda t: -abs(t[1]['delta']))]
    return {
        'a': {'total': sa['total'], 'escalation_rate': _rate(sa['escalated'], sa['total'])},
        'b': {'total': sb['total'], 'escalation_rate': _rate(sb['escalated'], sb['total'])},
        'shifts': shifts,
    }


def _json_key(k):
    return _parse_key(k)


def _parse_key(k: str):
    import json as _json
    v = _json.loads(k)
    return v


def format_comparison(c: dict, labels=None) -> str:
    labels = labels or ['A', 'B']
    ea, eb = c['a']['escalation_rate'], c['b']['escalation_rate']
    return '\n'.join([
        f"window {labels[0]}: {c['a']['total']} decisions, escalation rate {_pct1(ea)}",
        f"window {labels[1]}: {c['b']['total']} decisions, escalation rate {_pct1(eb)}"
        + (f"  ({_points(eb - ea)} points)" if ea is not None and eb is not None else ''),
        '',
        'clause share movement, largest first:',
        *[f"  {_fit(_points(s['delta']), 6, 'right')} pts  {_fit(_clause_name(s), 24)}  {_fit(_pct1(s['share_a']), 6, 'right')} -> {_fit(_pct1(s['share_b']), 6, 'right')}  {s['source'] or ''}"
          for s in c['shifts']],
        '',
        'This reports movement only. No threshold is applied; how large a move',
        'matters depends on your traffic, so that bar is yours to set.',
    ])


def format_calibration(c: dict) -> str:
    noul = c['kind'] == 'noul'
    edges = DECILE_EDGES if noul else CONFIDENCE_EDGES
    lines = [
        f"{c['question']} ({c['kind']}): {c['n']} labeled answer{'' if c['n'] == 1 else 's'}"
        + (f", {c['skipped']} label{'' if c['skipped'] == 1 else 's'} could not be scored" if c['skipped'] > 0 else ''),
        f"  {_fit('bucket', 10)}{_fit('n', 5, 'right')}{_fit('mean p' if noul else 'mean conf', 11, 'right')}{_fit('labeled yes' if noul else 'accuracy', 13, 'right')}{_fit('gap', 8, 'right')}",
    ]
    for i, b in enumerate(c['bins']):
        if b['n'] <= 0:
            continue
        gap = b['accuracy'] - b['mean_p']
        gap_text = ('' if gap < 0 else '+') + _r3(gap)
        lines.append(f"  {_fit(_bucket_label(i, edges), 10)}{_fit(b['n'], 5, 'right')}{_fit(_r3(b['mean_p']), 11, 'right')}{_fit(_r3(b['accuracy']), 13, 'right')}{_fit(gap_text, 8, 'right')}")
    lines.append(f"  ECE {_r3(c['ece'])}   Brier {_r3(c['brier'])}" + ('' if noul else '   (Brier of confidence against right/wrong)'))
    return '\n'.join(lines)


# --- stability: the same input, asked n times --------------------------------

def _stdev(xs):
    """Population standard deviation, as numpy's default."""
    if not xs:
        return 0
    m = _mean(xs)
    return (_mean([(x - m) ** 2 for x in xs])) ** 0.5


def _mode_of(xs):
    # Ties go to the name that sorts first, so the result never depends on order.
    h = _counted(xs)
    keys = sorted(h, key=str)
    best = keys[0]
    for k in keys[1:]:
        if h[k] > h[best]:
            best = k
    return best, h[best]


def _level_pairs(a):
    if is_object(a.get('probabilities')):
        return [(int(k), v) for k, v in a['probabilities'].items()]
    return []


def _argmax_level(a):
    """The index of the single most probable level. Ties go to the lower level."""
    ps = _level_pairs(a)
    if not ps:
        return None
    best = ps[0]
    for p in ps[1:]:
        if p[1] > best[1]:
            best = p
    return best[0]


def _choice_probability(a, option):
    return (a.get('probabilities') or {}).get(option, 0) if is_object(a.get('probabilities')) else 0


def _top_probability(a):
    ps = list(a['probabilities'].items()) if is_object(a.get('probabilities')) else []
    if not ps:
        return 0
    return sorted(ps, key=lambda t: (-t[1], t[0]))[0][1]


def gates_of(policy: dict) -> list:
    """A gate as this module reads one, from a policy artifact."""
    out = []
    for g in policy.get('gates') or []:
        band = own(g, 'low')
        kind = 'band' if band else ('option-gate' if own(g, 'option') else 'gate')
        out.append({
            'question': g['question'], 'kind': kind,
            'name': f"{g['question']}/{g['option']}" if kind == 'option-gate' else g['question'],
            'threshold': g.get('threshold'), 'by': 'top-prob' if g.get('by') == 'topProb' else g.get('by'),
            'option': g.get('option'), 'lo': g['low'] if band else None, 'hi': g['high'] if band else None,
        })
    return out


def _crosses(xs, t):
    return len(xs) > 0 and min(xs) < t <= max(xs)


def _crosses_high(xs, t):
    return len(xs) > 0 and min(xs) <= t < max(xs)


def _crossings_for(id, answers, measures, gates, thresholds, threshold_value):
    out = []

    def hit(kind, name, t, measure, xs, test=_crosses):
        if finite(t) and test(xs, t):
            out.append({'kind': kind, 'name': str(name), 'threshold': t, 'measure': measure,
                        'lo': min(xs), 'hi': max(xs)})

    band_edges = {f"{g['question']}/{e}" for g in gates if g['kind'] == 'band' for e in ('lo', 'hi')}
    for g in gates:
        if g['question'] != id:
            continue
        if g['kind'] in ('gate', 'option-gate'):
            measure = 'top-prob' if g.get('by') == 'top-prob' else 'confidence'
            if g.get('option') is not None:
                xs = [(_top_probability(a) if measure == 'top-prob' else a['confidence'])
                      for a in answers if a.get('choice') == str(g['option']) and finite(a.get('confidence'))]
            else:
                xs = measures.get(measure, [])
            hit(g['kind'], g['name'], threshold_value(g['name'], g['threshold']), measure, xs)
        elif g['kind'] == 'band':
            xs = measures.get('probability', [])

            def edge(e, written):
                return threshold_value(f'{id}/{e}', written) if finite(written) else None
            hit('band-lo', g['name'], edge('lo', g['lo']), 'probability', xs)
            hit('band-hi', g['name'], edge('hi', g['hi']), 'probability', xs, _crosses_high)
    # A named threshold is not tied to a question, so this only says that its
    # value lies inside this question's observed range.
    for th in thresholds:
        if th['name'] in band_edges:
            continue
        measure = {'probability': 'probability', 'confidence': 'confidence', 'score': 'score'}.get(th.get('kind'))
        if measure:
            hit('threshold', th['name'], threshold_value(th['name'], th['default']), measure, measures.get(measure, []))
    return out


def question_stabilities(all_answers, gates=None, thresholds=None, overrides=None) -> list:
    gates = gates or []
    thresholds = thresholds or []
    overrides = overrides or {}

    def threshold_value(name, fallback):
        return overrides[name] if own(overrides, name) else fallback

    ids = sorted({k for a in all_answers for k in (a or {})})
    out = []
    for id in ids:
        as_ = [a.get(id) for a in all_answers if is_object(a.get(id))]
        if not as_:
            continue
        kind = as_[0].get('type') or 'unknown'

        def reals(key):
            return [a[key] for a in as_ if finite(a.get(key))]
        confidences = reals('confidence')
        values: list = []
        modal = None
        flip = None
        measures: dict = {}
        if kind == 'noul':
            values = reals('noul')
            measures = {'probability': values}
        elif kind == 'score':
            values = reals('score')
            levels = [_argmax_level(a) for a in as_ if is_object(a.get('probabilities'))]
            m, count = _mode_of(levels) if levels else (None, 0)
            modal = m
            flip = None if m is None else 1 - count / len(levels)
            measures = {'score': values, 'confidence': confidences}
        elif kind == 'choice':
            picks = [a.get('choice') or '' for a in as_]
            m, count = _mode_of(picks)
            modal = m
            values = [_choice_probability(a, m) for a in as_]
            flip = 1 - count / len(picks)
            measures = {'probability': values, 'confidence': confidences, 'top-prob': [_top_probability(a) for a in as_]}
        out.append({
            'question': id, 'kind': kind, 'n': len(as_),
            'mean': _mean(values) if values else 0,
            'stdev': _stdev(values),
            'min': min(values) if values else None,
            'max': max(values) if values else None,
            'modal': None if modal is None or modal is False else modal,
            'flip_rate': flip,
            'confidence_stdev': _stdev(confidences) if kind in ('choice', 'score', 'box') else None,
            'crossings': _crossings_for(id, as_, measures, gates, thresholds, threshold_value),
        })
    return out


def _decision_description(d) -> str:
    if is_object(d):
        target = f" {d['target']}" if d.get('target') else ''
        return f"{d['action']}{target}"
    return 'error'


def stability_report(policy=None, runs=None, gates=None, thresholds=None, overrides=None,
                     uid_added=False, usage=None, precheck=None, n=None) -> dict:
    """runs: [{answers, decision}] — a decision object, or a string, which is the
    message from a decide that failed."""
    runs = runs or []
    usage = usage or {'input_tokens': 0, 'output_tokens': 0}
    count = n if n is not None else len(runs)
    if precheck:
        return {'policy': policy, 'runs': count, 'uid_added': False, 'precheck': precheck,
                'questions': [], 'decisions': [], 'errors': [],
                'usage': usage, 'cost': usage_cost(usage)}
    tally = _counted(_decision_description(r.get('decision')) for r in runs)
    return {
        'policy': policy, 'runs': count, 'uid_added': uid_added, 'precheck': None,
        'questions': question_stabilities([r.get('answers') or {} for r in runs],
                                          gates or [], thresholds or [], overrides or {}),
        'decisions': [{'decision': k, 'count': v} for k, v in sorted(tally.items(), key=lambda t: (-t[1], t[0]))],
        'errors': [r['decision'] for r in runs if isinstance(r.get('decision'), str)],
        'usage': usage, 'cost': usage_cost(usage),
    }


def _round_half_even(x) -> int:
    import math
    down = math.floor(x)
    rest = x - down
    if rest > 0.5:
        return down + 1
    if rest < 0.5:
        return down
    return down if down % 2 == 0 else down + 1


def format_stability(r: dict) -> str:
    n = r['runs']
    if r.get('precheck'):
        return (f"{r['policy']}: precheck decides this input without calling the model, so there is\n"
                f"nothing to repeat.\n  {_decision_description(r['precheck'])}")
    qs = r['questions']
    w = max([8] + [len(q['question']) for q in qs])
    xs = [c for q in qs for c in q['crossings']]
    kind_word = {'gate': 'gate', 'option-gate': 'option gate', 'band-lo': 'band (low edge)', 'band-hi': 'band (high edge)'}
    seen_errors: list = []
    for e in r['errors']:
        if e not in seen_errors:
            seen_errors.append(e)
    lines = [
        f"{n} runs of {r['policy']}" + (', each with a throwaway _uid in the state' if r['uid_added'] else '; the state is text, so the runs were identical requests (no _uid)'),
        '',
        f"  {_fit('question', w)}  kind     mean   stdev  range          flips   conf stdev",
    ]
    for q in qs:
        flips = '-' if q['flip_rate'] is None else f"{_round_half_even(100 * q['flip_rate'])}%"
        lines.append(f"  {_fit(q['question'], w)}  {_fit(q['kind'], 6)}  {_r3(q['mean'])}  {_r3(q['stdev'])}  {_fit(_r3(q['min']) + '-' + _r3(q['max']), 13)}  {_fit(flips, 6)}  {_r3(q['confidence_stdev'])}")
    lines += [
        '',
        '  mean/stdev/range are of: noul -> its probability; score -> the score;',
        '  choice -> the probability of the option chosen most often.',
        '',
    ]
    if not xs:
        lines.append('no gate, band or named threshold lies inside the observed ranges')
    else:
        lines.append('the observed noise crosses:')
        lines.extend(f"  {kind_word.get(c['kind'], 'threshold')} {c['name']} at {_r3(c['threshold'])}: {c['measure']} ranged {_r3(c['lo'])}-{_r3(c['hi'])}" for c in xs)
    lines.append('')
    lines.append('decisions: ' + ', '.join(str(d['decision']) + ' ' + str(d['count']) + '/' + str(n) for d in r['decisions']))
    lines.extend(f'  decide failed: {e}' for e in seen_errors)
    reported_tokens = r['usage'].get('input_tokens')
    tokens_text = 'unreported' if reported_tokens is None else str(reported_tokens)
    cost_text = 'unreported' if r['cost'] is None else '$' + decimal_string(r['cost'], 6)
    lines.append(f'{tokens_text} input tokens over {n} calls, {cost_text}')
    return '\n'.join(lines)
