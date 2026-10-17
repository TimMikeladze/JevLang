"""An MCP server's tools as a policy's action declarations.

The portable mirror of src/mcp-import.mjs. The JSON file is the tools/list
snapshot, verbatim; beside it goes a module of portable action declarations,
so a policy spreads them into its actions and the validator becomes the
check. snapshot_drift reports what changed against a live server.

The mapping is the inverse of json-schema:
  string with an enum of plain words  one-of
  string                              string
  boolean                             boolean
  number, integer                     number, with a range only when both
                                      minimum and maximum are given
  array with an item schema           list-of
  x-jev-member-of                     member-of
  anything else                       json
  not in "required"                   optional
A tool is confirmed unless readOnlyHint is true or destructiveHint is false.
Those are MCP's own defaults: a tool with no annotations may be destructive."""
from __future__ import annotations

import datetime
import json
import os
import re
from typing import Any, Dict, List, Optional

from ._common import canonical, finite, is_object, own, require_at
from ._mcp_client import mcp_list_tools
from ._numberfmt import jsonify

_IDENTIFIER = re.compile(r'^[A-Za-z_][A-Za-z0-9_-]*$')
_TOOL_NAME = re.compile(r'^[A-Za-z_][A-Za-z0-9_.-]*$')
RESERVED_ACTIONS = ['hold', 'confirm', 'computed', 'plan']
# A decision's own metadata keys, so a parameter cannot take their names.
RESERVED_PARAMS = ['reason', 'show']


def _now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


async def mcp_import_snapshot(client: dict, *, source: Optional[str] = None) -> dict:
    if source is None:
        source = client.get('source')
    return {
        'source': source,
        'serverInfo': client.get('serverInfo') if client.get('serverInfo') is not None else None,
        'protocolVersion': client.get('version') if client.get('version') is not None else None,
        'era': client.get('era'),
        'captured_at': _now_iso(),
        'tools': await mcp_list_tools(client),
    }


def read_mcp_snapshot(path: str) -> dict:
    with open(path, encoding='utf8') as handle:
        snapshot = json.load(handle)
    require_at(is_object(snapshot) and isinstance(snapshot.get('tools'), list), path,
               'not a tools snapshot',
               'Expected a JSON object with a "tools" list, as the import writes.')
    return snapshot


def tool_confirm(tool: Any) -> bool:
    """MCP's own defaults: a tool with no annotations may be destructive."""
    a = tool.get('annotations') if is_object(tool) and is_object(tool.get('annotations')) else {}
    return not (a.get('readOnlyHint') is True or a.get('destructiveHint') is False)


def _plain_word_enum(values: Any) -> bool:
    return (isinstance(values, list) and len(values) > 0
            and all(isinstance(v, str) and _IDENTIFIER.match(v) for v in values)
            and len(set(values)) == len(values))


def json_schema_to_parameter(prop: Any, required: bool) -> dict:
    p = prop if is_object(prop) else {}
    optional = {} if required else {'optional': True}
    member = p.get('x-jev-member-of')
    if isinstance(member, str) and _IDENTIFIER.match(member):
        return {'type': 'member-of', 'field': member, **optional}
    if p.get('type') == 'string' and _plain_word_enum(p.get('enum')):
        return {'type': 'one-of', 'values': p['enum'], **optional}
    if p.get('type') == 'string':
        return {'type': 'string', **optional}
    if p.get('type') == 'boolean':
        return {'type': 'boolean', **optional}
    if p.get('type') in ('number', 'integer'):
        if finite(p.get('minimum')) and finite(p.get('maximum')) and p['minimum'] < p['maximum']:
            return {'type': 'number', 'min': p['minimum'], 'max': p['maximum'], **optional}
        return {'type': 'number', **optional}
    if p.get('type') == 'array' and is_object(p.get('items')):
        # An element type takes no range, so a bounded number inside is just a number.
        inner = json_schema_to_parameter(p['items'], True)
        inner.pop('optional', None)
        inner.pop('min', None)
        inner.pop('max', None)
        return {'type': 'list-of', 'of': inner, **optional}
    return {'type': 'json', **optional}


# The 2.2 _meta form {"name": ..., "args": {k: ["param", x] | ["value", v]}}
def _undo_from(u: Any) -> Optional[dict]:
    if not is_object(u) or not isinstance(u.get('name'), str) or not _TOOL_NAME.match(u['name']) \
            or not is_object(u.get('args')):
        return None
    params: Dict[str, Any] = {}
    for key in sorted(u['args'].keys()):
        v = u['args'][key]
        if isinstance(v, list) and len(v) == 2 and v[0] == 'param' \
                and isinstance(v[1], str) and _IDENTIFIER.match(v[1]):
            params[key] = {'op': 'variable', 'args': [v[1]]}
        elif isinstance(v, list) and len(v) == 2 and v[0] == 'value' \
                and isinstance(v[1], (str, int, float, bool)):
            params[key] = {'op': 'literal', 'args': [v[1]]}
        else:
            return None
    return {'action': 'act', 'target': u['name'], 'params': params}


def tool_to_action(tool: Any) -> dict:
    """-> {'name', 'action'} for a tool a policy can declare, else {'warning'}."""
    name = tool.get('name') if is_object(tool) else None
    schema = tool.get('inputSchema') if is_object(tool) and is_object(tool.get('inputSchema')) else {}
    properties = schema.get('properties') if is_object(schema.get('properties')) else {}
    required = ([r for r in schema.get('required')
                 if isinstance(r, str)]
                if isinstance(schema.get('required'), list) else [])
    names = list(properties.keys())
    bad = sorted(n for n in names if not _IDENTIFIER.match(n))
    clash = sorted(n for n in names if n in RESERVED_PARAMS)
    if not isinstance(name, str) or not _TOOL_NAME.match(name):
        return {'warning': f'skipped tool {jsonify(name)}: its name is not one a policy '
                           'can declare ([A-Za-z_][A-Za-z0-9_.-]*)'}
    if name in RESERVED_ACTIONS:
        return {'warning': f"skipped tool {name}: '{name}' is reserved in a policy"}
    if bad:
        quoted = ', '.join(jsonify(b) for b in bad)
        plural = '' if len(bad) == 1 else 's'
        verb = 'is' if len(bad) == 1 else 'are'
        return {'warning': (f'skipped tool {name}: parameter name{plural} {quoted} {verb} '
                            'not an identifier ([A-Za-z_][A-Za-z0-9_-]*)')}
    if clash:
        return {'warning': (f"skipped tool {name}: a parameter named '{clash[0]}' collides "
                            f"with a decision's own {clash[0]}")}
    # Required parameters first, in the schema's order, then the rest by name.
    ordered = [r for r in required if r in names] + sorted(n for n in names if n not in required)
    meta = tool.get('_meta') if is_object(tool.get('_meta')) else {}
    min_confidence = meta.get('jev/min_confidence')
    cooldown = meta.get('jev/cooldown_seconds')
    allow = meta.get('jev/allow')
    timeout = meta.get('jev/timeout_seconds')
    undo = _undo_from(meta.get('jev/undo'))
    doc = tool.get('description') if isinstance(tool.get('description'), str) \
        and len(tool['description']) > 0 else None
    action: Dict[str, Any] = {}
    if doc:
        action['doc'] = doc
    action['params'] = {n: json_schema_to_parameter(properties[n], n in required) for n in ordered}
    if tool_confirm(tool):
        action['confirm'] = True
    if finite(min_confidence) and 0 < min_confidence < 1:
        action['minConfidence'] = min_confidence
    if finite(cooldown) and cooldown > 0:
        action['cooldown'] = cooldown
    if isinstance(allow, list) and allow and all(isinstance(r, str) and _IDENTIFIER.match(r) for r in allow):
        action['allow'] = allow
    if finite(timeout) and timeout > 0:
        action['timeout'] = timeout
    if undo:
        action['undo'] = undo
    return {'name': name, 'action': action}


def snapshot_to_actions(snapshot: dict) -> dict:
    """-> {'actions', 'warnings'}"""
    actions: Dict[str, Any] = {}
    warnings: List[str] = []
    for tool in snapshot.get('tools') or []:
        imported = tool_to_action(tool)
        if 'warning' in imported:
            warnings.append(imported['warning'])
        else:
            actions[imported['name']] = imported['action']
    return {'actions': actions, 'warnings': warnings}


def _one_line(s: Any) -> str:
    return re.sub(r'[\r\n]+', ' ', str(s))


def format_actions_module(snapshot: dict, imported: dict, snapshot_name: str) -> str:
    """The module a policy imports its actions from."""
    info = snapshot.get('serverInfo') if is_object(snapshot.get('serverInfo')) else None
    who = (_one_line(f"{info.get('name', '?')} {info.get('version', '')}".strip()) if info
           else 'an unnamed server')
    lines = [
        f"// Generated from {_one_line(snapshot.get('source') or '?')}",
        f"// {who}, MCP {snapshot.get('protocolVersion') or '?'}, "
        f"captured {snapshot.get('captured_at') or '?'}",
        f'// Do not edit it: re-import. Drift against the live server is reported from {snapshot_name}.',
        '// A policy spreads these into its actions, so validation checks every act.',
    ]
    lines += [f'// {_one_line(w)}' for w in imported.get('warnings') or []]
    lines += ['', f'export const actions = {json.dumps(imported["actions"], indent=2)};', '']
    return '\n'.join(lines)


def write_mcp_import(snapshot: dict, json_path: str) -> dict:
    """Writes <json_path> and, beside it, <name>.actions.mjs.

    -> {'modulePath', 'actions', 'warnings'}"""
    imported = snapshot_to_actions(snapshot)
    name = re.sub(r'\.json$', '', os.path.basename(json_path))
    module_path = os.path.join(os.path.dirname(json_path), f'{name}.actions.mjs')
    os.makedirs(os.path.dirname(json_path), exist_ok=True)
    with open(json_path, 'w', encoding='utf8') as handle:
        handle.write(json.dumps(snapshot, indent=2) + '\n')
    with open(module_path, 'w', encoding='utf8') as handle:
        handle.write(format_actions_module(snapshot, imported, os.path.basename(json_path)))
    return {'modulePath': module_path, **imported}


def _own_or_none(t: Any, key: str) -> Any:
    return t[key] if own(t, key) else None


def snapshot_drift(old_tools: List[dict], new_tools: List[dict]) -> dict:
    """old, new: tools/list entries. Drift is a tool missing or new, or a changed
    inputSchema or annotations, compared as canonical JSON. A changed
    description is only a note."""
    def by_name(tools: List[dict]) -> Dict[str, dict]:
        return {t['name']: t for t in tools if is_object(t) and isinstance(t.get('name'), str)}

    o, n = by_name(old_tools), by_name(new_tools)

    def canon(t: Any, key: str) -> str:
        return canonical(_own_or_none(t, key))

    def item(kind: str, tool: str, detail: str) -> dict:
        return {'kind': kind, 'tool': tool, 'detail': detail}

    drift: List[dict] = []
    for name in sorted(o.keys()):
        if name not in n:
            drift.append(item('missing', name, 'the server no longer lists it'))
    for name in sorted(n.keys()):
        if name not in o:
            drift.append(item('new', name, "the server lists it, and the snapshot doesn't"))
    for name in sorted(o.keys()):
        if name not in n:
            continue
        a, b = o[name], n[name]
        if canon(a, 'inputSchema') != canon(b, 'inputSchema'):
            drift.append(item('schema', name,
                              f'inputSchema was {canon(a, "inputSchema")}\n'
                              f'      now {canon(b, "inputSchema")}'))
        if canon(a, 'annotations') != canon(b, 'annotations'):
            drift.append(item('annotations', name,
                              f'annotations were {canon(a, "annotations")}\n'
                              f'      now {canon(b, "annotations")}'))
    notes = [item('description', name, 'its description changed; read it before re-importing')
             for name in sorted(o.keys())
             if name in n and canon(o[name], 'description') != canon(n[name], 'description')]
    return {'drift': drift, 'notes': notes}
