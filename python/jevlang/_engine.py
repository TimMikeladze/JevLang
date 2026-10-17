"""The decision interpreter: state, questions, gates, routes, traces.

Ported from the TypeScript engine's engine.mjs.
"""
from __future__ import annotations

import math
from ._assets import validate_asset_references, inspect_image, asset_identity, MAX_PORTABLE_BYTES
from ._budgets import model_limits
from typing import Any

from ._common import require_at, own, is_object, finite, probability, json_copy, fingerprint, equal
from ._expressions import evaluate_expression, level_index, truth, option_wire, option_code
from ._validate import validate_policy, parameter_ok, item_identity
from ._state import redact, cap_value, check_token_budget
from ._numberfmt import to_fixed, jsonify


def _wire_question(q: dict) -> dict:
    """A raw question is sent exactly as written; everything else sends its declared shape."""
    if q.get('type') == 'raw':
        return q['wire']
    return {k: q[k] for k in ('type', 'instructions', 'criteria') if own(q, k)}


def build_state(policy: dict, input: Any, options=None) -> dict:
    raw = json_copy(input)
    settings = policy.get('stateOptions') or {}
    options = options or {}
    experimental = {**policy.get('typesafe', {}).get('experimental', {}), **options.get('experimental', {})}
    asset_refs = validate_asset_references({**policy.get('typesafe', {}).get('assets', {}), **options.get('assets', {})})
    max_chars = settings.get('maxChars') if own(settings, 'maxChars') else None
    token_limit = settings.get('tokenLimit') if own(settings, 'tokenLimit') else model_limits(experimental)['question']

    def finish(state):
        return check_token_budget(cap_value(state, max_chars, 'state', False, asset_refs) if max_chars else state, {},
                                  token_limit)

    if not len(policy.get('state') or {}):
        return {'state': finish(redact(raw, settings.get('redact') or [], asset_references=asset_refs)),
                'facts': raw if is_object(raw) else {}}
    facts: dict = {}
    state: dict = {}
    for name, spec in policy['state'].items():
        v = raw
        missing = False
        for key in spec.get('path', [name]):
            if not own(v, key):
                missing = True
                break
            v = v[key] if not isinstance(v, list) else v[int(key)]
        if missing:
            require_at(own(spec, 'default'), f'input.{name}', 'missing state field',
                       'Supply the field or declare a default.', 'state')
            v = spec['default']
        facts[name] = v
        if spec.get('local'):
            continue
        if not spec.get('unredacted'):
            v = redact(v, [*(settings.get('redact') or []), *(spec.get('redact') or [])], name, asset_references=asset_refs)
        if spec.get('maxChars'):
            v = cap_value(v, spec['maxChars'], f'state.{name}', asset_references=asset_refs)
        state[name] = v
    return {'state': finish(state), 'facts': facts}


def build_questions(policy: dict, state: dict | None = None) -> dict:
    state = state or {}
    entries: list = []
    for name, q in policy['questions'].items():
        wire = _wire_question(q)
        if q.get('type') == 'raw':
            entries.append((name, wire))
            continue
        if q.get('optionsFrom'):
            inventory = state.get(q['optionsFrom'])
            require_at(isinstance(inventory, (list, dict)), f"state.{q['optionsFrom']}",
                       'runtime options must be a list or map')
            if isinstance(inventory, list):
                dynamic = []
                for item in inventory:
                    if isinstance(item, str) or (finite(item) and not isinstance(item, bool)):
                        dynamic.append((str(item), None))
                        continue
                    require_at(is_object(item) and (own(item, 'key') or own(item, 'name')),
                               f"state.{q['optionsFrom']}",
                               'option must be a string, number, or {key, description}')
                    key = item.get('key', item.get('name'))
                    require_at(isinstance(key, str), f"state.{q['optionsFrom']}", 'option key must be a string')
                    dynamic.append((key, item.get('description')))
            else:
                dynamic = list(inventory.items())
            all_pairs = [*dynamic, *q['criteria'].items()]
            require_at(2 <= len(all_pairs) <= 255 and len({k for k, _ in all_pairs}) == len(all_pairs),
                       f'questions.{name}', 'runtime choice needs 2 to 255 distinct options')
            wire = dict(wire)
            wire['criteria'] = dict(all_pairs)
        if q.get('over'):
            items = state.get(q['over'])
            require_at(isinstance(items, list), f"state.{q['over']}", 'family inventory must be an array')
            for i, item in enumerate(items):
                if is_object(q.get('instructions')):
                    instructions = {**q['instructions'], q.get('itemKey') or 'item': item}
                else:
                    instructions = {'question': q['instructions'], q.get('itemKey') or 'item': item}
                entries.append((f'{name}--{i}', {**wire, 'type': q['type'].replace('-each', ''),
                                                 'instructions': instructions}))
        else:
            entries.append((name, wire))
    require_at(len({id for id, _ in entries}) == len(entries), '$.questions',
               'generated family question collides with another question')
    return dict(entries)


def validate_answers(questions: dict, answers: Any):
    require_at(is_object(answers), 'answers', 'answers must be a JSON object', None, 'answers')
    for id, q in questions.items():
        a = answers.get(id) if own(answers, id) else None
        path = f'answers.{id}'
        require_at(is_object(a), path, 'missing question answer',
                   'Supply an answer for every question, or re-record stale fixtures.', 'answers')
        require_at(not own(a, 'type') or a.get('type') == q.get('type'), path,
                   f"expected {q.get('type')}, got {a.get('type')}", None, 'answers')
        if q.get('type') == 'choice':
            require_at(isinstance(a.get('choice'), str) and own(q.get('criteria', {}), a.get('choice')),
                       f'{path}.choice', 'answer is not a declared option',
                       'Re-record answers for the current questions.', 'answers')
        if q.get('type') == 'score':
            require_at(finite(a.get('score')), f'{path}.score', 'score must be numeric', None, 'answers')
            if is_object(a.get('probabilities')):
                require_at(len(a['probabilities']) == len(q.get('criteria', [])), f'{path}.probabilities',
                           'number of level probabilities differs from declared levels', None, 'answers')
        if q.get('type') == 'box':
            edges = a.get('box')
            require_at(is_object(edges) and all(probability(edges.get(k)) for k in ('top', 'bottom', 'left', 'right')) and edges['left'] < edges['right'] and edges['top'] < edges['bottom'], path + '.box', 'box edges must be finite, ordered fractions between 0 and 1', code='answers')
            require_at(a.get('confidence') is None or probability(a['confidence']), path + '.confidence', 'Box confidence must be null or between 0 and 1', code='answers')
        if q.get('type') == 'noul':
            require_at(probability(a.get('noul')), f'{path}.noul', 'noul must be between 0 and 1', None, 'answers')


def _empty_decision(action: str, target: str | None = None, reason: Any = None, data: Any = None) -> dict:
    return {
        'action': action, 'target': target, 'reason': reason, 'rule': None, 'clause': None, 'source': None,
        'line': None, 'file': None, 'model': None, 'provider': None, 'requested_model': None,
        'requested_effort': None, 'effective_effort': None, 'request_id': None, 'stage': None, 'data': data,
        'proposed': None, 'evidence': [], 'steps': [], 'readings': [],
    }


def _plan_decision(steps: list) -> dict:
    d = _empty_decision('plan', None, f"{len(steps)} step{'' if len(steps) == 1 else 's'}")
    d['steps'] = steps
    return d


class GateExit(Exception):
    def __init__(self, decision):
        self.decision = decision


def _rounded_even(x: float) -> int:
    lo = math.floor(x)
    frac = x - lo
    if frac == 0.5:
        return lo if lo % 2 == 0 else lo + 1
    return math.floor(x + 0.5)


class Ctx:
    """The evaluation context a policy's expressions run against."""

    def __init__(self, policy, answers, facts, options=None, override_keys=None):
        options = options or {}
        p = policy
        require_at(not options.get('profile') or options['profile'] in p.get('profiles', {}),
                   'profile', f"unknown profile '{options.get('profile')}'")
        overrides = {**(p['profiles'].get(options['profile'], {}) if options.get('profile') else {}),
                     **(options.get('overrides') or {})}
        self._override_keys: list = override_keys if override_keys is not None else []
        for k, v in overrides.items():
            require_at(k in self._override_keys and probability(v), f'overrides.{k}',
                       'override must name a threshold/gate and be between 0 and 1')
        self.policy: Any = p
        self.facts: Any = facts
        self.answers: Any = answers
        self.variables: dict = {}
        self.readings: dict = {}
        self.checked: set = set()
        self.gates_enabled = True
        # Reads inside reason, data and evidence still trip on-read gates, but they
        # are informational: they are not part of the clause's readings.
        self.logging = True
        self.last_reading: Any = None
        self.would_route: Any = None
        self._thresholds: Any = p.get('thresholds', {})
        self._overrides: dict = overrides
        self._setup(p, overrides)

    def threshold(self, name):
        return self._overrides.get(name, self._thresholds.get(name))

    def gate_value(self, key, fallback):
        return self._overrides.get(key, fallback)

    def _setup(self, p, overrides):
        self._overrides = overrides
        for g in p['gates']:
            if own(g, 'low'):
                require_at(self.gate_value(f"{g['question']}/lo", g['low']) < self.gate_value(f"{g['question']}/hi", g['high']),
                           'overrides', 'band low must remain below high')
            if own(g, 'option'):
                b = next((x for x in p['gates'] if x['question'] == g['question']
                          and not own(x, 'option') and not own(x, 'low')), None)
                require_at(b is None or b.get('by', 'confidence') != g.get('by', 'confidence')
                           or self.gate_value(f"{g['question']}/{g['option']}", g['threshold']) >= self.gate_value(g['question'], b['threshold']),
                           'overrides', 'option gate must remain at least as strict as base gate')

    def log_fact(self, name, value):
        if not self.logging:
            return
        p = self.policy
        specs = [*((p.get('stateOptions') or {}).get('redact') or []),
                 *((p['state'].get(name) or {}).get('redact') or [])]
        self.readings[f'fact:{name}'] = {'question': name, 'kind': 'fact', 'value': redact(value, specs, name),
                                         'confidence': None, 'detail': 'observed'}

    def _answer(self, id):
        a = self.answers.get(id) if own(self.answers, id) else None
        require_at(is_object(a), f'answers.{id}', 'missing question answer', None, 'answers')
        return a

    def _probabilities(self, a, id):
        ps = a.get('probabilities')
        require_at(is_object(ps) and all(probability(v) for v in ps.values()) and len(ps) > 0,
                   f'answers.{id}.probabilities', 'accessor requires a probability distribution', None, 'answers')
        return sorted(ps.items(), key=lambda kv: (-kv[1], kv[0]))

    def _confidence(self, a, id):
        if self.policy['questions'][id].get('type') == 'box' and a.get('confidence') is None: return None
        require_at(probability(a.get('confidence')), f'answers.{id}.confidence',
                   'accessor requires confidence between 0 and 1', None, 'answers')
        return a['confidence']

    def _log_answer(self, id, q, a):
        # A raw answer is only described by what it carries: its own type, else "raw".
        kind = (a.get('type') if q.get('type') == 'raw' and a.get('type') in ('choice', 'score', 'noul')
                else ('raw' if q.get('type') == 'raw' else q.get('type')))
        if kind == 'raw':
            return self._record(id, {'question': id, 'kind': kind, 'value': 'raw', 'confidence': None,
                                     'detail': 'raw answer'})
        detail = None
        if kind == 'score' and is_object(a.get('probabilities')):
            idx = self._score_argmax(a, id)
            detail = f"most likely: {_level_description(a, idx)} (p={to_fixed(a['probabilities'][str(idx)], 2)})"
        return self._record(id, {'question': id, 'kind': kind,
                                 'value': a.get('box', a.get('choice', a.get('score', a.get('noul')))),
                                 'confidence': None if kind == 'noul' else self._confidence(a, id),
                                 'detail': detail})

    def _record(self, id, reading):
        self.last_reading = reading
        if self.logging:
            self.readings[id] = reading
        return reading

    def _score_argmax(self, a, id):
        import re as _re
        ps = self._probabilities(a, id)
        ps = sorted(ps, key=lambda kv: (-kv[1], float(kv[0])))
        require_at(all(_re.fullmatch(r'0|[1-9][0-9]*', k) for k, _ in ps),
                   f'answers.{id}.probabilities', 'score distribution needs integer level keys')
        return int(ps[0][0])

    def read(self, op, id, arg=None, run=None):
        if run is None:
            run = lambda x: evaluate_expression(x, self)  # noqa: E731
        p = self.policy
        q = p['questions'].get(id)
        if self.gates_enabled and id not in self.checked:
            self.checked.add(id)
            for i, g in enumerate(p['gates']):
                if g.get('onRead') and g['question'] == id:
                    d = self.gate(g, i)
                    if d:
                        raise GateExit(d)
        if q.get('over'):
            items = self.facts.get(q['over'])
            # An aggregator reads the answers the family came back with; only
            # yesItems needs the inventory itself, because it returns the items.
            require_at(op != 'yesItems' or isinstance(items, list), f"facts.{q['over']}",
                       'yesItems needs the inventory in facts')
            if isinstance(items, list):
                members = list(range(len(items)))
            else:
                members = []
                while own(self.answers, f'{id}--{len(members)}'):
                    members.append(len(members))
            values = []
            for i in members:
                member = self._answer(f'{id}--{i}')
                values.append(member.get('noul', member.get('score')))
            # A family reads as its member count, with the strongest member named.
            top = max(values) if values else None
            detail = (f"{len(values)} members, max {to_fixed(top, 2)} at #{values.index(top)}"
                      if values else 'no members')
            self._record(id, {'question': id, 'kind': 'family', 'value': len(values), 'confidence': None,
                              'detail': detail})
            if op == 'yesItems':
                threshold = run(arg)
                require_at(probability(threshold), 'threshold', 'threshold must be between 0 and 1')
                kept = []
                for i in members:
                    if values[i] < threshold:
                        continue
                    name = f'{id}[{item_identity(items[i])}]'
                    self._record(name, {'question': name, 'kind': 'noul', 'value': values[i],
                                        'confidence': None, 'detail': None})
                    kept.append(items[i])
                return kept
            if op in ('countYes', 'anyYes', 'allYes'):
                threshold = run(arg)
                require_at(probability(threshold), 'threshold', 'threshold must be between 0 and 1')
                count = sum(1 for v in values if v >= threshold)
                if op == 'countYes':
                    return count
                if op == 'anyYes':
                    return count > 0
                return len(values) > 0 and count == len(values)
            if not values:
                return 0 if op != 'argmax' else False
            if op == 'argmax':
                return values.index(max(values))
            if op == 'max':
                return max(values)
            if op == 'min':
                return min(values)
            return sum(values) / len(values)
        a = self._answer(id)
        self._log_answer(id, q, a)
        if op == 'value':
            return option_code(q, a['choice']) if q.get('type') == 'choice' else a.get('box', a.get('score', a.get('noul')))
        if op in ('boxTop', 'boxBottom', 'boxLeft', 'boxRight'): return a['box'][op[3:].lower()]
        if op == 'hasConfidence': return probability(a.get('confidence'))
        if op == 'chosen':
            return a.get('choice')
        if op == 'rawAnswer':
            return json_copy(a)
        if op == 'confidence':
            return self._confidence(a, id)
        if op == 'is':
            return a.get('choice') == option_wire(q, arg)
        if op in ('yes', 'no'):
            threshold = run(arg)
            require_at(probability(threshold), 'threshold', 'threshold must be between 0 and 1')
            return (a['noul'] if op == 'yes' else 1 - a['noul']) >= threshold
        if op == 'mostLikely':
            return self._score_argmax(a, id) == level_index(q, arg)
        if op == 'atLeast':
            return a['score'] >= level_index(q, arg)
        if op == 'prob':
            self._probabilities(a, id)
            key = level_index(q, arg) if q.get('type') == 'score' else option_wire(q, arg)
            return a.get('probabilities', {}).get(key, 0)
        if op == 'topProb':
            return self._probabilities(a, id)[0][1]
        if op == 'runnerUp':
            ps = self._probabilities(a, id)
            return ps[1][0] if len(ps) > 1 else False
        if op == 'margin':
            ps = self._probabilities(a, id)
            return ps[0][1] - (ps[1][1] if len(ps) > 1 else 0)
        if op == 'nearest':
            # The nearest level is named the way the policy names it: its code name
            # where it has one, otherwise the level text.
            i = max(0, min(len(q['criteria']) - 1, _rounded_even(a['score'])))
            names = q.get('levelNames') or []
            return names[i] if i < len(names) and names[i] is not None else q['criteria'][i]
        if op == 'normalized':
            return a['score'] / (len(q['criteria']) - 1)
        if op == 'spread':
            ps = self._probabilities(a, id)
            mean = sum(float(i) * v for i, v in ps)
            return math.sqrt(sum(v * (float(i) - mean) ** 2 for i, v in ps))
        raise RuntimeError(f'unimplemented accessor {op}')

    def reading(self, id):
        result = {}

        def thunk():
            self.read('value', id)
            result['r'] = self.last_reading
        _informational(self, thunk)
        return result.get('r')

    def gate(self, g, i):
        a = self._answer(g['question'])
        p = self.policy
        q = p['questions'][g['question']]
        if own(g, 'option') and a.get('choice') != g['option']:
            return None
        band = own(g, 'low')
        if band:
            value = a.get('noul')
        elif g.get('by') == 'topProb':
            value = self._probabilities(a, g['question'])[0][1]
        elif g.get('by') == 'margin':
            ps = self._probabilities(a, g['question'])
            value = ps[0][1] - (ps[1][1] if len(ps) > 1 else 0)
        else:
            value = self._confidence(a, g['question'])
        if band:
            trips = (self.gate_value(f"{g['question']}/lo", g['low']) <= value
                     <= self.gate_value(f"{g['question']}/hi", g['high']))
        else:
            key = f"{g['question']}/{g['option']}" if own(g, 'option') else g['question']
            trips = value is None or value < self.gate_value(key, g['threshold'])
        if not trips:
            return None
        saved_readings, saved_enabled = self.readings, self.gates_enabled
        self.readings = {}
        self.gates_enabled = False
        try:
            detail = _gate_detail(g, self, band)
            reading = self._log_answer(g['question'], q, a)
            self.readings[g['question']] = {**reading, 'detail': f"{reading['detail']}; {detail}" if reading['detail'] else detail}
            self.last_reading = reading
            d = _materialize(g['decision'], self)
            return _trace(d, 'band' if band else ('option-gate' if own(g, 'option') else 'gate'), i, f'$.gates[{i}]', self)
        finally:
            self.readings = saved_readings
            self.gates_enabled = saved_enabled


class CompiledPolicy:
    def __init__(self, input: Any):
        result = validate_policy(input)
        self._policy = result['policy']
        self.warnings = result['warnings']
        self._override_keys = result['overrideKeys']

    @property
    def policy(self):
        return self._policy

    def to_json(self) -> dict:
        return json_copy(self._policy, max_bytes=MAX_PORTABLE_BYTES if self._policy.get('typesafe', {}).get('assets') else 2 * 1024 * 1024)

    def build_state(self, input, options=None):
        return build_state(self._policy, input, options)

    def questions(self, state=None):
        return build_questions(self._policy, state or {})

    def fingerprint(self, state=None):
        return fingerprint(self._image_identity(self.questions(state or {})))

    def _image_identity(self, questions):
        assets = self._policy.get('typesafe', {}).get('assets', {})
        if not assets: return questions
        return asset_identity(None, questions, {ref: inspect_image(a) for ref, a in assets.items()})

    def static_questions(self) -> dict:
        """The questions that do not depend on runtime state: the policy's recorded identity."""
        return {id: _wire_question(q) for id, q in self._policy['questions'].items()
                if not q.get('optionsFrom') and not q.get('over')}

    def identity(self) -> str:
        templates = [{'question': id, 'optionsFrom': q.get('optionsFrom'), 'over': q.get('over'),
                      'itemKey': q.get('itemKey'), 'wire': _wire_question(q)}
                     for id, q in self._policy['questions'].items() if q.get('optionsFrom') or q.get('over')]
        questions = self.static_questions()
        return fingerprint(self._image_identity({**questions, '%templates': templates} if templates else questions))

    def _context(self, answers, facts, options=None):
        return Ctx(self._policy, answers, facts, options, self._override_keys)

    def precheck(self, input, options=None):
        facts = self.build_state(input, options)['facts']
        ctx = self._context({}, facts, options or {})
        ctx.gates_enabled = False
        for i, c in enumerate(self._policy.get('prechecks', [])):
            ctx.readings = {}
            if truth(evaluate_expression(c['when'], ctx)):
                return _trace(_materialize(c['decision'], ctx), 'precheck', i,
                              c.get('source', f'$.prechecks[{i}]'), ctx)
        return None

    def _route(self, ctx):
        p = self._policy
        matched = []
        for i, clause in enumerate(p['route']['clauses']):
            ctx.readings = {}
            if not truth(evaluate_expression(clause['when'], ctx)):
                continue
            d = _guard_confidence(_trace(_materialize(clause['decision'], ctx), 'route', i,
                                         clause.get('source', f'$.route.clauses[{i}]'), ctx), p)
            matched.append(d)
            if p['route']['mode'] == 'first':
                break
        if not matched and own(p['route'], 'otherwise'):
            ctx.readings = {}
            matched.append(_guard_confidence(_trace(_materialize(p['route']['otherwise'], ctx), 'route',
                                                    len(p['route']['clauses']), '$.route.otherwise', ctx), p))
        if p['route']['mode'] == 'all':
            # Every matching clause runs. One match is its own decision; several become
            # one plan whose readings are every clause's, each question once.
            if len(matched) > 1:
                result = _plan_decision(matched)
                result['rule'] = 'plan'
                result['source'] = f"(route #:all): {len(matched)} clauses matched"
                merged = {}
                for d in matched:
                    for r in d['readings']:
                        merged[r['question']] = r
                result['readings'] = list(merged.values())
            else:
                result = matched[0]
        elif p['route']['mode'] == 'collect':
            precedence = p['route']['precedence']

            def rank(d):
                target = d.get('target') or d.get('action')
                return precedence.index(target) if target in precedence else len(precedence)
            result = None
            for d in matched:
                if result is None or rank(d) < rank(result):
                    result = d
        else:
            result = matched[0] if matched else None
        require_at(result is not None, '$.route', 'no clause matched validated answers',
                   'Add an otherwise clause.', 'decision')
        return result

    def decide(self, raw_answers, options=None):
        options = options or {}
        answers = json_copy(raw_answers)
        facts = json_copy(options.get('facts') or {})
        p = self._policy
        questions = self.questions(options.get('state') or facts)
        validate_answers(questions, answers)
        ctx = self._context(answers, facts, options)

        def would_route():
            readings, enabled, checked = ctx.readings, ctx.gates_enabled, ctx.checked
            ctx.gates_enabled = False
            ctx.checked = set()
            try:
                return self._route(ctx)
            except Exception:
                return None
            finally:
                ctx.readings = readings
                ctx.gates_enabled = enabled
                ctx.checked = checked
        # What the route would have decided without the gates, for a gate's trace.
        ctx.would_route = would_route
        try:
            for i, g in enumerate(p['gates']):
                if not g.get('onRead'):
                    d = ctx.gate(g, i)
                    if d:
                        return d
            result = self._route(ctx)
            flags = []
            for flag in p.get('flags', []):
                if truth(evaluate_expression(flag['when'], ctx)):
                    flags.append(flag['flag'])
            if flags:
                if is_object(result.get('data')):
                    result['data'] = {**result['data'], 'flags': [*(result['data'].get('flags') or []), *flags]}
                elif result.get('data') is None:
                    result['data'] = {'flags': flags}
                else:
                    result['data'] = {'value': result['data'], 'flags': flags}
            return result
        except GateExit as e:
            return e.decision


def _level_description(a, i) -> str:
    """The level text the answer itself reported, else its index; long JSON is clipped."""
    legend = a.get('legend') if is_object(a.get('legend')) else {}
    key = str(i)
    if key not in legend:
        return key
    v = legend[key]
    if isinstance(v, str):
        return v
    s = jsonify(v)
    return f'{s[:57]}...' if len(s) > 60 else s


def _gate_detail(g, ctx, band) -> str:
    """A tripped gate says what the bar was, and what the route would have done."""
    if band:
        base = f"inside the review band {g['low']}..{g['high']}"
    else:
        metric = 'top probability' if g.get('by') == 'topProb' else ('margin' if g.get('by') == 'margin' else 'confidence')
        key = f"{g['question']}/{g['option']}" if own(g, 'option') else g['question']
        base = f"needed {metric} >= {to_fixed(ctx.gate_value(key, g['threshold']), 2)}"
    d = ctx.would_route() if ctx.would_route else None
    return f"{base}; otherwise: {d['action']} {d['target']}" if d and d.get('target') else (f"{base}; otherwise: {d['action']}" if d else base)


def _trace(d, rule, index, source, ctx) -> dict:
    return {**d, 'rule': rule, 'clause': index, 'source': source, 'readings': list(ctx.readings.values())}


def _informational(ctx, thunk):
    logging = ctx.logging
    ctx.logging = False
    try:
        return thunk()
    finally:
        ctx.logging = logging


def _materialize(spec, ctx) -> dict:
    def run(x):
        return evaluate_expression(x, ctx)

    reason = _informational(ctx, lambda: run(spec['reason'])) if own(spec, 'reason') else None
    require_at(reason is None or isinstance(reason, str), 'decision.reason', 'reason must be a string or null')
    data = _informational(ctx, lambda: run(spec['data'])) if own(spec, 'data') else None
    d = _empty_decision(spec['action'], spec.get('target'), reason, data)
    action = spec['action']
    if action == 'act':
        d['data'] = {k: run(v) for k, v in spec['params'].items()}
        a = ctx.policy['actions'][spec['target']]
        for k, v in d['data'].items():
            require_at(parameter_ok(a['params'][k], v, ctx.facts), f"action.{spec['target']}.{k}",
                       f"parameter must satisfy {a['params'][k]['type']}",
                       'Supply a value within the declared type/range/inventory.', 'action')
    elif action == 'confirm':
        d['proposed'] = _materialize(spec['proposed'], ctx)
        d['target'] = d['proposed']['target']
        d['data'] = d['proposed']['data']
        d['reason'] = d['reason'] if d['reason'] is not None else d['proposed']['reason']
        d['evidence'] = d['proposed']['evidence']
    elif action == 'schedule':
        seconds = run(spec['seconds'])
        require_at(finite(seconds) and seconds > 0, 'schedule.seconds', 'delay must be positive seconds')
        d['proposed'] = _materialize(spec['proposed'], ctx)
        d['data'] = {'seconds': seconds}
        if d['reason'] is None:
            d['reason'] = f'in {seconds} s'
    elif action == 'clarify':
        question = run(spec['question'])
        require_at(isinstance(question, str), 'clarify.question', 'question must be text')
        if d['reason'] is None:
            d['reason'] = question
        d['data'] = {'question': question, 'about': spec.get('about')}
    elif action == 'plan':
        d = _plan_decision([_materialize(x, ctx) for x in spec['steps']])
    elif action == 'planFor':
        items = run(spec['items'])
        require_at(isinstance(items, list) and len(items) <= 10000, 'planFor.items',
                   'planFor needs an array of at most 10,000 items')
        saved = ctx.variables
        try:
            steps = []
            for item in items:
                ctx.variables = {**saved, spec['variable']: item}
                steps.append(_materialize(spec['decision'], ctx))
        finally:
            ctx.variables = saved
        # No items is nothing to do; one item is that decision, not a plan of one.
        if len(steps) == 0:
            d = _empty_decision('hold', None, 'nothing to do: no items')
        elif len(steps) == 1:
            d = steps[0]
        else:
            d = _plan_decision(steps)
    elif action == 'branch':
        d = _materialize(spec['then'] if truth(run(spec['when'])) else spec['otherwise'], ctx)
    if spec.get('show'):
        d['evidence'] = [ctx.reading(id) for id in spec['show']]
    return d


def _guard_confidence(d, p) -> dict:
    requirements: list = []

    def visit(x):
        if x['action'] == 'act' and own(p['actions'][x['target']], 'minConfidence'):
            requirements.append(p['actions'][x['target']]['minConfidence'])
        if x.get('proposed'):
            visit(x['proposed'])
        for step in x.get('steps', []):
            visit(step)

    visit(d)
    if not requirements:
        return d
    minimum = max(requirements)

    def certainty(r):
        if r.get('confidence') is not None:
            return r['confidence']
        if r.get('kind') == 'noul':
            return max(r['value'], 1 - r['value'])
        return None

    weak = next((r for r in d['readings'] if certainty(r) is not None and certainty(r) < minimum), None)
    if not weak:
        return d
    blocked = d.get('target') or (d.get('proposed') or {}).get('target') or d['action']
    return {**d, 'action': 'hold', 'target': None, 'data': {'blocked': blocked}, 'proposed': None, 'steps': [],
            'evidence': [],
            'reason': f"not sure enough to {blocked}: '{weak['question']}' is only {to_fixed(certainty(weak), 2)} sure, and it needs {minimum}"}


def compile_policy(input) -> CompiledPolicy:
    return CompiledPolicy(input)
