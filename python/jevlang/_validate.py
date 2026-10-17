"""Whole-policy validation: the portable format-1 artifact's gatekeeper.

Ported from the TypeScript engine's validate.mjs; every error carries a path
and names the fix, matching the Racket implementation's messages.
"""
from __future__ import annotations

import re
from typing import Any

from ._common import json_copy, require_at, own, is_object, text, probability, finite, keys_only, equal
from ._expressions import check_expression, option_wire
from ._state import REDACTOR_NAMES
from ._assets import MAX_PORTABLE_BYTES
from ._typesafe_request import validate_jev_options

_RESERVED = {'hold', 'confirm', 'computed'}


def _map_at(x, path):
    require_at(is_object(x), path, 'expected a map')


def _list_at(x, path):
    require_at(isinstance(x, list), path, 'expected an array')


def _nonempty(x, path):
    require_at(text(x), path, 'expected a non-empty string')


def validate_policy(input: Any) -> dict:
    p = json_copy(input, max_bytes=MAX_PORTABLE_BYTES if is_object(input) and is_object(input.get('typesafe')) and input['typesafe'].get('assets') else 2 * 1024 * 1024)
    keys_only(p, ['format', 'name', 'version', 'owner', 'questions', 'state', 'stateOptions', 'thresholds',
                  'profiles', 'signals', 'gates', 'route', 'prechecks', 'flags', 'actions', 'provider',
                  'model', 'effort', 'extraBody', 'typesafe'], '$')
    require_at(p.get('format') == 1, '$.format', f"unsupported policy format '{p.get('format')}'",
               'Migrate to portable policy format 1.')
    _nonempty(p.get('name'), '$.name')
    for key in ('questions', 'state', 'thresholds', 'profiles', 'signals', 'actions'):
        p.setdefault(key, {})
        _map_at(p[key], f'$.{key}')
    for key in ('gates', 'prechecks', 'flags'):
        p.setdefault(key, [])
        _list_at(p[key], f'$.{key}')
    for key in ('version', 'owner', 'provider', 'model', 'effort'):
        if own(p, key):
            _nonempty(p[key], f'$.{key}')
    if 'typesafe' in p: validate_jev_options(p['typesafe'])
    warnings: list[dict] = []
    p.setdefault('stateOptions', {})
    keys_only(p['stateOptions'], ['redact', 'maxChars', 'tokenLimit', 'requestTokenLimit'], '$.stateOptions')
    if own(p['stateOptions'], 'redact'):
        require_at(isinstance(p['stateOptions']['redact'], list) and all(x in REDACTOR_NAMES for x in p['stateOptions']['redact']),
                   '$.stateOptions.redact', 'unknown redactor')
    for k in ('maxChars', 'tokenLimit', 'requestTokenLimit'):
        if own(p['stateOptions'], k):
            v = p['stateOptions'][k]
            require_at(v is None or (isinstance(v, int) and not isinstance(v, bool) and v > 0),
                       f'$.stateOptions.{k}', 'limit must be a positive integer or null')
    for id, s in p['state'].items():
        _nonempty(id, '$.state')
        keys_only(s, ['path', 'default', 'local', 'maxChars', 'redact', 'unredacted'], f'$.state.{id}')
        if own(s, 'path'):
            require_at(isinstance(s['path'], list) and all(isinstance(k, str) or (isinstance(k, int) and not isinstance(k, bool)) for k in s['path']),
                       f'$.state.{id}.path', 'path must be an array of field names or indexes')
        if own(s, 'local'):
            require_at(isinstance(s['local'], bool), f'$.state.{id}.local', 'local must be boolean')
        if own(s, 'maxChars'):
            require_at(isinstance(s['maxChars'], int) and not isinstance(s['maxChars'], bool) and s['maxChars'] > 0 and not s.get('local'),
                       f'$.state.{id}.maxChars', 'maxChars must be a positive integer on a non-local field')
        if own(s, 'unredacted'):
            require_at(text(s['unredacted']) and not s.get('local'), f'$.state.{id}.unredacted',
                       'unredacted requires an audit reason on a non-local field')
        if own(s, 'redact'):
            require_at(isinstance(s['redact'], list) and all(x in REDACTOR_NAMES for x in s['redact']),
                       f'$.state.{id}.redact', 'unknown redactor')
    require_at(not len(p['state']) or any(not s.get('local') for s in p['state'].values()), '$.state',
               'all fields are local; no model state remains', 'Declare at least one non-local field.')
    if own(p, 'extraBody'):
        _map_at(p['extraBody'], '$.extraBody')
        keys = list(p['extraBody'])
        require_at(len(keys) > 0, '$.extraBody', 'an extra request body needs at least one field')
        for k in keys:
            require_at(k not in ('state', 'model', 'questions'), f'$.extraBody.{k}',
                       f"extraBody cannot set '{k}'",
                       'Set the model and state through the policy, not the raw body.')
        warnings.append({'path': '$.extraBody',
                         'message': f"extraBody adds request fields the API docs do not describe: {', '.join(keys)}"})
    for id, q in p['questions'].items():
        _nonempty(id, '$.questions')
        require_at(isinstance(q, dict) and q.get('type') in ('choice', 'score', 'noul', 'box', 'noul-each', 'score-each', 'raw'),
                   f'$.questions.{id}.type', 'unknown question type')
        if q.get('type') == 'raw':
            # A raw question is sent exactly as written and nothing about it is checked.
            keys_only(q, ['type', 'wire'], f'$.questions.{id}')
            require_at(is_object(q.get('wire')) and text(q['wire'].get('type')), f'$.questions.{id}.wire',
                       'a raw question is a JSON object with a non-empty string "type"',
                       'Write {type: "noul", instructions: "..."} as the wire question.')
            warnings.append({'path': f'$.questions.{id}',
                             'message': f"raw question '{id}' bypasses every check; its answer is only readable with rawAnswer('{id}')"})
            continue
        keys_only(q, ['type', 'instructions', 'criteria', 'ungated', 'optionsFrom', 'over', 'itemKey', 'names', 'levelNames'],
                  f'$.questions.{id}')
        require_at(own(q, 'instructions') and (q['instructions'] is None or is_object(q['instructions'])
                                                or isinstance(q['instructions'], list) or text(q['instructions'])),
                   f'$.questions.{id}.instructions', 'instructions must be non-empty text, JSON object, array or null')
        if own(q, 'ungated'):
            _nonempty(q['ungated'], f'$.questions.{id}.ungated')
        if q['type'] == 'box': require_at('criteria' not in q, f'$.questions.{id}.criteria', 'Box takes no criteria')
        if q['type'] == 'choice':
            _map_at(q.get('criteria'), f'$.questions.{id}.criteria')
            criteria = q['criteria']
            n = len(criteria)
            for k in criteria:
                _nonempty(k, f'$.questions.{id}.criteria')
            require_at(n <= 255 and (n >= 2 or own(q, 'optionsFrom')), f'$.questions.{id}.criteria',
                       'choice requires 2 to 255 options', 'Declare at least two options, or supply runtime options.')
            if n > 240:
                warnings.append({'path': f'$.questions.{id}.criteria',
                                 'message': f"choice '{id}' has {n} options; the docs report reliable behavior up to roughly 240"})
        elif str(q['type']).startswith('score'):
            require_at(isinstance(q.get('criteria'), list) and 2 <= len(q['criteria']) <= 10,
                       f'$.questions.{id}.criteria', 'score requires 2 to 10 ordered levels')
            from ._numberfmt import jsonify
            require_at(len({jsonify(x) for x in q['criteria']}) == len(q['criteria']),
                       f'$.questions.{id}.criteria', 'duplicate score levels')
        elif own(q, 'criteria'):
            keys_only(q['criteria'], ['true', 'false'], f'$.questions.{id}.criteria')
        if own(q, 'names'):
            # A code name is how the policy refers to an option; the key is what it sends.
            path = f'$.questions.{id}.names'
            _map_at(q['names'], path)
            require_at(q['type'] == 'choice', path, 'only a choice has option code names')
            wires = list(q['names'].values())
            require_at(len(set(wires)) == len(wires), path, 'two code names send the same wire key')
            for name, wire in q['names'].items():
                _nonempty(name, path)
                require_at(isinstance(wire, str) and wire in q['criteria'], f'{path}.{name}',
                           f"code name '{name}' names no declared option",
                           f"Declare the option, or use one of: {', '.join(q['criteria'])}.")
                require_at(name == wire or name not in q['criteria'], f'{path}.{name}',
                           f"code name '{name}' is also another option's wire key",
                           'Rename the option so a reference means one thing.')
        if own(q, 'levelNames'):
            path = f'$.questions.{id}.levelNames'
            require_at(str(q['type']).startswith('score') and isinstance(q.get('levelNames'), list)
                       and len(q['levelNames']) == len(q['criteria']), path,
                       'levelNames declares one name or null per score level')
            named = [x for x in q['levelNames'] if x is not None]
            for x in named:
                _nonempty(x, path)
            require_at(len(set(named)) == len(named), path, 'duplicate level name')
            for i, name in enumerate(q['levelNames']):
                clash = -1
                for j, x in enumerate(q['criteria']):
                    if x == name:
                        clash = j
                        break
                require_at(name is None or clash < 0 or clash == i, f'{path}[{i}]',
                           f"level name '{name}' is also another level's text",
                           'Rename the level so a reference means one thing.')
        for key in ('optionsFrom', 'over'):
            if own(q, key):
                require_at(isinstance(q[key], str) and q[key] in p['state'] and not p['state'][q[key]].get('local'),
                           f'$.questions.{id}.{key}', 'runtime questions need a declared non-local state field')
                require_at(str(q['type']).endswith('-each') if key == 'over' else q['type'] == 'choice',
                           f'$.questions.{id}.{key}', 'field is not supported on this question type')
        require_at(not str(q['type']).endswith('-each') or own(q, 'over'), f'$.questions.{id}.over',
                   'family needs its inventory field')
        if own(q, 'itemKey'):
            require_at(str(q['type']).endswith('-each') and text(q['itemKey']), f'$.questions.{id}.itemKey',
                       'itemKey is a non-empty name for a family item')
        _check_paths(q.get('instructions'), p, f'$.questions.{id}.instructions',
                     list(q['instructions']) if is_object(q.get('instructions')) else [])
    for name, value in p['thresholds'].items():
        require_at(text(name) and probability(value), f'$.thresholds.{name}', 'threshold must be between 0 and 1')
    for name, x in p['signals'].items():
        check_expression(x, p, f'$.signals.{name}', {'stack': [name]})
    for name, action in p['actions'].items():
        _check_action_schema(name, action, p)
    base_gates: set[str] = set()
    gate_keys: set[str] = set()
    for i, gate in enumerate(p['gates']):
        path = f'$.gates[{i}]'
        keys_only(gate, ['question', 'threshold', 'option', 'by', 'onRead', 'low', 'high', 'decision'], path)
        require_at(gate.get('question') in p['questions'], f'{path}.question', f"unknown question '{gate.get('question')}'")
        q = p['questions'].get(gate.get('question'), {})
        if own(gate, 'onRead'):
            require_at(isinstance(gate['onRead'], bool), f'{path}.onRead', 'onRead must be boolean')
        band = own(gate, 'low') or own(gate, 'high')
        key = f"{gate['question']}/band" if band else gate['question'] + (f"/{gate['option']}" if own(gate, 'option') else '')
        require_at(key not in gate_keys, path, f"duplicate gate '{key}'")
        gate_keys.add(key)
        if band:
            require_at(q.get('type') == 'noul' and probability(gate.get('low')) and probability(gate.get('high'))
                       and gate['low'] < gate['high'], path, 'review band needs a noul and 0 <= low < high <= 1')
            require_at(not own(gate, 'threshold') and not own(gate, 'option') and not own(gate, 'by'), path,
                       'band cannot also have a threshold, option or metric')
        else:
            require_at(q.get('type') in ('choice', 'score', 'box'), path, 'confidence gates require choice, score or box',
                       'Use a review band for noul.')
            require_at(probability(gate.get('threshold')), f'{path}.threshold', 'gate threshold must be between 0 and 1')
            require_at(not own(gate, 'by') or gate['by'] in ('confidence', 'topProb', 'margin'), f'{path}.by',
                       'unknown gate metric')
            require_at(q.get('type') != 'box' or gate.get('by', 'confidence') == 'confidence', f'{path}.by', 'Box gates require confidence')
            if own(gate, 'option'):
                require_at(q.get('type') == 'choice' and gate['option'] in q.get('criteria', {}), f'{path}.option',
                           'gate option must be a declared static choice option')
            else:
                base_gates.add(gate['question'])
        check_decision(gate['decision'], p, f'{path}.decision')
    for i, gate in enumerate(p['gates']):
        if not own(gate, 'option'):
            continue
        base = next((g for g in p['gates'] if g['question'] == gate['question'] and not own(g, 'option') and not own(g, 'low')), None)
        require_at(base is None or base.get('by', 'confidence') != gate.get('by', 'confidence') or gate['threshold'] >= base['threshold'],
                   f'$.gates[{i}]', 'option gate is below its base gate', 'Make the option gate at least as strict as the base gate.')
    override_keys: set[str] = set(p['thresholds'])
    for g in p['gates']:
        if own(g, 'low'):
            override_keys.add(f"{g['question']}/lo")
            override_keys.add(f"{g['question']}/hi")
        else:
            override_keys.add(g['question'] + (f"/{g['option']}" if own(g, 'option') else ''))
    for name, profile in p['profiles'].items():
        _map_at(profile, f'$.profiles.{name}')
        for key, value in profile.items():
            require_at(key in override_keys and probability(value), f'$.profiles.{name}.{key}',
                       'override must name a threshold or gate and be between 0 and 1')

    def gated(reads, path):
        for id in reads.reads:
            q = p['questions'][id]
            require_at(q.get('type') not in ('choice', 'score', 'box') or own(q, 'ungated') or id in base_gates
                       or id in reads.confidences, path,
                       f"'{id}' decides a clause without a confidence gate",
                       'Add a base gate, read confidence in this clause, or declare an ungated audit reason.')

    keys_only(p['route'], ['mode', 'clauses', 'otherwise', 'precedence'], '$.route')
    p['route'].setdefault('mode', 'first')
    require_at(p['route']['mode'] in ('first', 'all', 'collect'), '$.route.mode', 'route mode must be first, all or collect')
    _list_at(p['route']['clauses'], '$.route.clauses')
    require_at(len(p['route']['clauses']) > 0 or own(p['route'], 'otherwise'), '$.route', 'route has no decisions')
    if p['route']['mode'] == 'collect':
        prec = p['route'].get('precedence')
        require_at(isinstance(prec, list) and len(prec) > 0 and all(text(x) for x in prec) and len(set(prec)) == len(prec),
                   '$.route.precedence', 'collect requires a unique non-empty target precedence list')
    else:
        require_at(not own(p['route'], 'precedence'), '$.route.precedence', 'precedence is only legal with collect')
    unconditional = False
    for i, clause in enumerate(p['route']['clauses']):
        path = f'$.route.clauses[{i}]'
        keys_only(clause, ['when', 'decision', 'source'], path)
        if unconditional and p['route']['mode'] == 'first':
            warnings.append({'path': path, 'message': 'unreachable clause after unconditional clause'})
        refs = check_expression(clause['when'], p, f'{path}.when')
        action_refs = check_decision(clause['decision'], p, f'{path}.decision')
        refs.merge(action_refs)
        gated(refs, path)
        unconditional = unconditional or (clause['when'].get('op') == 'literal' and clause['when'].get('args', [None])[0] is True)
    if own(p['route'], 'otherwise'):
        gated(check_decision(p['route']['otherwise'], p, '$.route.otherwise'), '$.route.otherwise')
    require_at(own(p['route'], 'otherwise') or unconditional or _exhaustive(p), '$.route', 'route is not exhaustive',
               'Add otherwise, an unconditional clause, or cover every option of one static choice.')
    for i, clause in enumerate(p['prechecks']):
        path = f'$.prechecks[{i}]'
        keys_only(clause, ['when', 'decision', 'source'], path)
        check_expression(clause['when'], p, f'{path}.when', {'noAnswers': True})
        check_decision(clause['decision'], p, f'{path}.decision', {'noAnswers': True})
    for i, flag in enumerate(p['flags']):
        path = f'$.flags[{i}]'
        keys_only(flag, ['when', 'flag'], path)
        _nonempty(flag.get('flag'), f'{path}.flag')
        gated(check_expression(flag['when'], p, f'{path}.when'), path)
    return {'policy': p, 'warnings': warnings, 'overrideKeys': sorted(override_keys)}


def _check_paths(v, p, path, local_keys):
    if isinstance(v, str):
        for match in re.finditer(r'`([^`]+)`', v):
            root = re.split(r'[.\[]', match.group(1))[0]
            # A policy with no declared state accepts a raw state value, as #lang jev does.
            require_at(not len(p['state']) or root in p['state'] or root in local_keys, path,
                       f"backtick path '{match.group(1)}' has no declared root",
                       'Declare the state field or use a key from this question object.')
    elif isinstance(v, list):
        for x in v:
            _check_paths(x, p, path, local_keys)
    elif is_object(v):
        for x in v.values():
            _check_paths(x, p, path, local_keys)


def _exhaustive(p) -> bool:
    covered: dict[str, set] = {}

    def visit(x):
        if x.get('op') == 'is':
            covered.setdefault(x['args'][0], set()).add(option_wire(p['questions'][x['args'][0]], x['args'][1]))
        if x.get('op') == 'or':
            for a in x['args']:
                visit(a)

    for c in p['route']['clauses']:
        visit(c['when'])
    return any(not p['questions'][id].get('optionsFrom') and set(p['questions'][id].get('criteria', {})) <= s
               for id, s in covered.items())


def check_parameter_type(t, p, path):
    keys_only(t, ['type', 'optional', 'min', 'max', 'values', 'of', 'field'], path)
    require_at(t.get('type') in ('string', 'number', 'boolean', 'json', 'one-of', 'list-of', 'member-of'), path,
               f"unknown parameter type '{t.get('type')}'")
    if own(t, 'optional'):
        require_at(isinstance(t['optional'], bool), path, 'optional must be boolean')
    if own(t, 'min') or own(t, 'max'):
        require_at(t.get('type') == 'number' and (not own(t, 'min') or finite(t['min'])) and (not own(t, 'max') or finite(t['max']))
                   and t.get('min', float('-inf')) <= t.get('max', float('inf')), path,
                   'range must be ordered finite numbers on a number parameter')
    if t.get('type') == 'one-of':
        require_at(isinstance(t.get('values'), list) and len(t['values']) > 0 and all(text(x) for x in t['values'])
                   and len(set(t['values'])) == len(t['values']), path, 'one-of needs unique non-empty string values')
    if t.get('type') == 'list-of':
        check_parameter_type(t['of'], p, f'{path}.of')
    if t.get('type') == 'member-of':
        require_at(isinstance(t.get('field'), str) and t['field'] in p['state'], path,
                   'member-of needs a declared fact field')
    for key, kind in (('values', 'one-of'), ('of', 'list-of'), ('field', 'member-of')):
        require_at(not own(t, key) or t.get('type') == kind, path, f'{key} is only legal on {kind}')


def _check_action_schema(name, a, p):
    path = f'$.actions.{name}'
    _nonempty(name, path)
    require_at(name not in _RESERVED, path, 'reserved action name')
    keys_only(a, ['params', 'doc', 'confirm', 'minConfidence', 'cooldown', 'allow', 'timeout', 'undo'], path)
    _map_at(a.get('params'), f'{path}.params')
    for k, t in a['params'].items():
        _nonempty(k, f'{path}.params')
        check_parameter_type(t, p, f'{path}.params.{k}')
    if own(a, 'confirm'):
        require_at(isinstance(a['confirm'], bool), path, 'confirm must be boolean')
    if own(a, 'minConfidence'):
        require_at(probability(a['minConfidence']), path, 'minConfidence must be between 0 and 1')
    for k in ('timeout', 'cooldown'):
        if own(a, k):
            require_at(finite(a[k]) and a[k] > 0, f'{path}.{k}', f'{k} must be positive seconds')
    if own(a, 'allow'):
        require_at(isinstance(a['allow'], list) and len(a['allow']) > 0 and all(text(x) for x in a['allow']),
                   f'{path}.allow', 'allow needs a non-empty principal list')
    if own(a, 'undo'):
        require_at(is_object(a['undo']) and a['undo'].get('action') == 'act' and a['undo'].get('target') in p['actions'],
                   f'{path}.undo', 'undo must invoke a declared action')
        require_at(not p['actions'][a['undo']['target']].get('confirm'), f'{path}.undo',
                   'undo cannot require confirmation')
        check_decision(a['undo'], p, f'{path}.undo',
                       {'variables': set(a['params']), 'undo': True})


def parameter_ok(t, v, facts=None) -> bool:
    kind = t.get('type')
    if kind == 'string':
        return isinstance(v, str)
    if kind == 'number':
        return finite(v) and t.get('min', float('-inf')) <= v <= t.get('max', float('inf'))
    if kind == 'boolean':
        return isinstance(v, bool)
    if kind == 'json':
        return True
    if kind == 'one-of':
        return v in t.get('values', [])
    if kind == 'list-of':
        return isinstance(v, list) and all(parameter_ok(t['of'], x, facts) for x in v)
    if kind == 'member-of':
        return facts is None or (isinstance(facts, dict) and isinstance(facts.get(t['field']), list)
                                 and any(item_identity(x) == item_identity(v) for x in facts[t['field']]))
    return False


def item_identity(v) -> str:
    from ._numberfmt import js_number_str
    if is_object(v):
        for k in ('id', 'key', 'name'):
            if own(v, k):
                return str(v[k])
        from ._numberfmt import jsonify
        return jsonify(v)
    return js_number_str(v) if isinstance(v, float) else str(v)


_SHAPES = {
    'assign': ['target'], 'page': ['target'], 'escalate': ['target'], 'next': ['target'], 'hold': [],
    'act': ['target', 'params'], 'confirm': ['proposed'], 'schedule': ['seconds', 'proposed'],
    'clarify': ['question', 'about'], 'plan': ['steps'], 'planFor': ['variable', 'items', 'decision'],
    'branch': ['when', 'then', 'otherwise'],
}


def check_decision(d, p, path, options=None) -> Any:
    from ._expressions import Refs
    options = options or {}
    require_at(is_object(d), path, 'expected a decision')
    require_at(d.get('action') in _SHAPES, path, f"unknown decision '{d.get('action')}'")
    # hold parks the case for a person, so a target given to it is a mistake worth
    # naming, as the Racket compiler names it.
    require_at(d.get('action') != 'hold' or not own(d, 'target'), f'{path}.target',
               'hold takes no target; it parks the case for a person to pick up',
               "For a named destination use assign('target') or escalate('target').")
    keys_only(d, ['action', 'reason', 'data', 'show', *_SHAPES[d['action']]], path)
    refs = Refs()

    def expr(x, at, informational=False):
        r = check_expression(x, p, at, options)
        if not informational:
            refs.merge(r)

    if own(d, 'reason'):
        expr(d['reason'], f'{path}.reason', True)
    if own(d, 'data'):
        expr(d['data'], f'{path}.data', True)
    if own(d, 'show'):
        require_at(isinstance(d['show'], list) and all(q in p['questions'] for q in d['show']),
                   f'{path}.show', 'evidence must name declared questions')
        require_at(not options.get('noAnswers') or not len(d['show']), f'{path}.show',
                   'prechecks cannot show model answers')
    if 'target' in _SHAPES[d['action']]:
        _nonempty(d.get('target'), f'{path}.target')
        require_at(d['target'] not in _RESERVED, f'{path}.target', 'reserved target name')
    action = d['action']
    if action == 'act':
        require_at(d['target'] in p['actions'], f'{path}.target', f"undeclared action '{d['target']}'",
                   'Declare the action and its parameters.')
        a = p['actions'][d['target']]
        require_at(not a.get('confirm') or options.get('confirmed') is True, path,
                   f"'{d['target']}' requires confirmation", 'Wrap it in confirm().')
        _map_at(d.get('params'), f'{path}.params')
        for k, x in d['params'].items():
            require_at(k in a['params'], f'{path}.params.{k}', f"unknown parameter '{k}'")
            expr(x, f'{path}.params.{k}')
            if options.get('undo'):
                require_at(x.get('op') in ('literal', 'variable'), f'{path}.params.{k}',
                           "undo may use only literals or this action's parameters")
            if x.get('op') == 'literal':
                require_at(parameter_ok(a['params'][k], x['args'][0]), f'{path}.params.{k}',
                           f"parameter must satisfy {a['params'][k]['type']}",
                           'Use a value within the declared type and range.')
        for k, t in a['params'].items():
            require_at(t.get('optional') or own(d['params'], k), f'{path}.params',
                       f"missing required parameter '{k}'")
    elif action == 'confirm':
        refs.merge(check_decision(d['proposed'], p, f'{path}.proposed', {**options, 'confirmed': True}))
    elif action == 'schedule':
        expr(d['seconds'], f'{path}.seconds')
        if d['seconds'].get('op') == 'literal':
            require_at(finite(d['seconds']['args'][0]) and d['seconds']['args'][0] > 0, f'{path}.seconds',
                       'schedule delay must be positive seconds')
        refs.merge(check_decision(d['proposed'], p, f'{path}.proposed', options))
    elif action == 'clarify':
        expr(d['question'], f'{path}.question')
        if own(d, 'about'):
            require_at(d['about'] in p['questions'], f'{path}.about', 'clarify about must name a question')
    elif action == 'plan':
        _list_at(d.get('steps'), f'{path}.steps')
        for i, x in enumerate(d['steps']):
            refs.merge(check_decision(x, p, f'{path}.steps[{i}]', options))
    elif action == 'planFor':
        _nonempty(d.get('variable'), f'{path}.variable')
        expr(d['items'], f'{path}.items')
        refs.merge(check_decision(d['decision'], p, f'{path}.decision',
                                  {**options, 'variables': {*options.get('variables', set()), d['variable']}}))
    elif action == 'branch':
        expr(d['when'], f'{path}.when')
        refs.merge(check_decision(d['then'], p, f'{path}.then', options))
        refs.merge(check_decision(d['otherwise'], p, f'{path}.otherwise', options))
    return refs
