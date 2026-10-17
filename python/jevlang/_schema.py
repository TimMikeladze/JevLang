"""JSON Schema (2020-12) views of a policy's action declarations, for MCP tool
listings and anything else that speaks JSON Schema.

Nothing here claims an action is read-only or idempotent: a declaration does
not say. A confirmed action is destructive.
"""
from __future__ import annotations

from typing import Any


def parameter_schema(t: dict) -> dict:
    kind = t.get('type')
    if kind == 'string':
        return {'type': 'string'}
    if kind == 'boolean':
        return {'type': 'boolean'}
    if kind == 'number':
        out = {'type': 'number'}
        if 'min' in t:
            out['minimum'] = t['min']
        if 'max' in t:
            out['maximum'] = t['max']
        return out
    if kind == 'one-of':
        return {'type': 'string', 'enum': t['values']}
    if kind == 'list-of':
        return {'type': 'array', 'items': parameter_schema(t['of'])}
    if kind == 'member-of':
        # The allowed values come from the facts at run time, so no static enum exists.
        return {'description': f"one of the values in the facts' {t['field']} list, known only at run time",
                'x-jev-member-of': t['field']}
    return {}


def action_input_schema(a: dict) -> dict:
    return {
        'type': 'object',
        'properties': {k: parameter_schema(t) for k, t in a.get('params', {}).items()},
        'required': [k for k, t in a.get('params', {}).items() if not t.get('optional')],
        'additionalProperties': False,
    }


def action_annotations(a: dict) -> dict:
    return {'destructiveHint': a.get('confirm') is True}


def _undo_argument(x) -> Any:
    # A parameter of the action it undoes appears as ["param", name].
    return ['param', x['args'][0]] if x.get('op') == 'variable' else x['args'][0]


def action_meta(a: dict) -> dict:
    undo = a.get('undo')
    return {
        'jev/confirm': a.get('confirm') is True,
        'jev/min_confidence': a.get('minConfidence'),
        'jev/cooldown_seconds': a.get('cooldown'),
        'jev/allow': a.get('allow'),
        'jev/timeout_seconds': a.get('timeout'),
        'jev/undo': ({'name': undo['target'],
                      'args': {k: _undo_argument(x) for k, x in undo['params'].items()}} if undo else None),
    }


def action_tool(name: str, a: dict) -> dict:
    tool = {
        'name': name,
        'inputSchema': action_input_schema(a),
        'annotations': action_annotations(a),
        '_meta': action_meta(a),
    }
    if isinstance(a.get('doc'), str):
        tool['description'] = a['doc']
    return tool


def policy_actions(policy) -> dict:
    """What `jev schema --json` shows, and what an MCP tool listing carries."""
    p = policy.policy if hasattr(policy, 'policy') else policy
    return {'policy': p.get('name'),
            'actions': [action_tool(name, a) for name, a in (p.get('actions') or {}).items()]}
