"""MCP tool import and drift, ported from src/mcp-import.mjs, checked against
mcp-import-oracle.rkt over the shared parity cases."""
from __future__ import annotations

import asyncio
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

PACKAGES = Path(__file__).resolve().parents[2]
TS_TEST = PACKAGES / 'test'

from jevlang._mcp_import import (format_actions_module, json_schema_to_parameter, read_mcp_snapshot,
                                 snapshot_drift, snapshot_to_actions, tool_confirm, tool_to_action,
                                 write_mcp_import)
from tests.test_mcp import racket_available, run_racket  # noqa: E402

CASES = json.loads((TS_TEST / 'parity' / 'mcp-import-cases.json').read_text())


@unittest.skipUnless(racket_available() and TS_TEST.is_dir(), 'Racket and the monorepo are required')
class OracleTests(unittest.TestCase):
    def test_tools_import_and_drift_as_racket_does(self):
        oracle = run_racket('mcp-import-oracle.rkt')
        tools = CASES['tools']
        self.assertEqual(len(oracle['imported']), len(tools))
        for got, want in zip([tool_to_action(t) for t in tools], oracle['imported']):
            if want['warning'] is None:
                self.assertNotIn('warning', got)
                # The oracle normalizes the (action ...) form to JSON; compare
                # name, the parameters and each safety flag.
                action = got['action']
                self.assertEqual(got['name'], want['action']['name'])
                names = [p['name'] for p in want['action']['params']]
                self.assertEqual(list(action.get('params', {}).keys()), names)
                for p in want['action']['params']:
                    ours = action['params'][p['name']]
                    # The oracle prints the Racket form: "string", "number",
                    # "(one-of a b)", "(list-of string)", "(member-of f)".
                    racket_type = p['type']
                    if racket_type.startswith('(one-of '):
                        kind, values = 'one-of', racket_type[len('(one-of '):-1].split(' ')
                    elif racket_type.startswith('(list-of '):
                        kind, values = 'list-of', None
                    elif racket_type.startswith('(member-of '):
                        kind, values = 'member-of', None
                    else:
                        kind, values = racket_type, None
                    self.assertEqual(ours['type'], kind, p['name'])
                    if kind == 'one-of':
                        self.assertEqual(ours['values'], values)
                    if '#:optional' in p['rest']:
                        self.assertTrue(ours.get('optional'))
                    if '#:range' in p['rest']:
                        at = p['rest'].index('#:range')
                        self.assertEqual(ours.get('min'), float(p['rest'][at + 1])
                                         if '.' in p['rest'][at + 1] else int(p['rest'][at + 1]))
                        self.assertEqual(ours.get('max'), float(p['rest'][at + 2])
                                         if '.' in p['rest'][at + 2] else int(p['rest'][at + 2]))
                flags = want['action']['flags']
                self.assertEqual(action.get('confirm', False), bool(flags.get('confirm')))
                for key, ours_key in (('doc', 'doc'), ('min-confidence', 'minConfidence'),
                                      ('cooldown', 'cooldown'), ('timeout', 'timeout'),
                                      ('allow', 'allow')):
                    self.assertEqual(action.get(ours_key), flags.get(key, None) or None
                                     if key != 'doc' else flags.get(key))
            else:
                # Racket quotes a name as `x' and names the field #:reason;
                # this engine writes 'x' and names it plainly.
                normalized = (want['warning'].replace('`', "'")
                              .replace("act's own #:reason", "a decision's own reason"))
                self.assertEqual(got.get('warning'), normalized)
        self.assertEqual([tool_confirm(t) for t in tools], oracle['confirm'])
        for pair, want in zip(CASES['drift'], oracle['drift']):
            got = snapshot_drift(pair[0], pair[1])
            self.assertEqual(got['drift'], want['drift'])
            self.assertEqual(got['notes'], want['notes'])


class ImportTests(unittest.TestCase):
    def test_the_json_schema_mapping(self):
        self.assertEqual(json_schema_to_parameter({'type': 'string'}, True), {'type': 'string'})
        self.assertEqual(json_schema_to_parameter({'type': 'string'}, False),
                         {'type': 'string', 'optional': True})
        self.assertEqual(json_schema_to_parameter(
            {'type': 'string', 'enum': ['billing', 'sales']}, True), {'type': 'one-of', 'values': ['billing', 'sales']})
        self.assertEqual(json_schema_to_parameter({'type': 'boolean'}, True), {'type': 'boolean'})
        self.assertEqual(json_schema_to_parameter(
            {'type': 'number', 'minimum': 0, 'maximum': 10}, True),
            {'type': 'number', 'min': 0, 'max': 10})
        self.assertEqual(json_schema_to_parameter({'type': 'integer'}, True), {'type': 'number'})
        # A bounded number inside an element type is just a number.
        self.assertEqual(json_schema_to_parameter(
            {'type': 'array', 'items': {'type': 'number', 'minimum': 0, 'maximum': 5}}, False),
            {'type': 'list-of', 'of': {'type': 'number'}, 'optional': True})
        self.assertEqual(json_schema_to_parameter({'x-jev-member-of': 'department'}, True),
                         {'type': 'member-of', 'field': 'department'})

    def test_names_the_policy_cannot_declare_are_skipped_with_a_warning(self):
        skipped = tool_to_action({'name': 'hold', 'inputSchema': {}})
        self.assertIn('is reserved', skipped['warning'])
        bad_param = tool_to_action({'name': 'fine', 'inputSchema': {
            'properties': {'not an id': {'type': 'string'}}}})
        self.assertIn('not an identifier', bad_param['warning'])
        clash = tool_to_action({'name': 'fine', 'inputSchema': {
            'properties': {'reason': {'type': 'string'}}}})
        self.assertIn("collides with a decision's own reason", clash['warning'])

    def test_meta_safety_rules_come_back(self):
        action = tool_to_action({
            'name': 'lock-door', 'description': 'Locks a door',
            'inputSchema': {'type': 'object', 'properties': {'door': {'type': 'string'}},
                            'required': ['door']},
            'annotations': {'readOnlyHint': False},
            '_meta': {'jev/min_confidence': 0.8, 'jev/cooldown_seconds': 30,
                      'jev/allow': ['owner'], 'jev/timeout_seconds': 5,
                      'jev/undo': {'name': 'unlock-door', 'args': {'door': ['param', 'door']}}}})['action']
        self.assertEqual(action['doc'], 'Locks a door')
        self.assertTrue(action['confirm'])
        self.assertEqual(action['minConfidence'], 0.8)
        self.assertEqual(action['cooldown'], 30)
        self.assertEqual(action['allow'], ['owner'])
        self.assertEqual(action['timeout'], 5)
        self.assertEqual(action['undo'], {'action': 'act', 'target': 'unlock-door',
                                          'params': {'door': {'op': 'variable', 'args': ['door']}}})

    def test_write_and_read_the_snapshot(self):
        snapshot = {'source': 'test://server', 'serverInfo': {'name': 'test', 'version': '1'},
                    'protocolVersion': '2026-07-28', 'era': 'modern', 'captured_at': '2026-09-18T12:00:00Z',
                    'tools': [{'name': 'lock-door',
                               'inputSchema': {'type': 'object',
                                               'properties': {'door': {'type': 'string'}},
                                                'required': ['door']}}]}
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, 'tools.json')
            written = write_mcp_import(snapshot, path)
            self.assertEqual(written['modulePath'], os.path.join(tmp, 'tools.actions.mjs'))
            self.assertEqual(written['actions']['lock-door']['params']['door'], {'type': 'string'})
            self.assertTrue(written['actions']['lock-door']['confirm'])
            read = read_mcp_snapshot(path)
            self.assertEqual(read['tools'], snapshot['tools'])
            module = Path(written['modulePath']).read_text()
            self.assertIn('// Generated from test://server', module)
            self.assertIn('export const actions =', module)
            # A second snapshot with a moved tool reports drift.
            drift = snapshot_drift(snapshot['tools'],
                                   [{'name': 'lock-door',
                                     'inputSchema': {'type': 'object',
                                                     'properties': {'door': {'type': 'string'},
                                                                    'pin': {'type': 'number'}}}}])
            self.assertEqual([d['kind'] for d in drift['drift']], ['schema'])

    def test_snapshot_to_actions_collects_warnings(self):
        got = snapshot_to_actions({'tools': [{'name': 'hold', 'inputSchema': {}},
                                             {'name': 'ok', 'inputSchema': {
                                                 'properties': {'x': {'type': 'string'}}}}]})
        self.assertEqual(list(got['actions'].keys()), ['ok'])
        self.assertEqual(len(got['warnings']), 1)

    def test_format_actions_module_carries_the_header(self):
        snapshot = {'source': 'test://s', 'serverInfo': None, 'protocolVersion': None,
                    'captured_at': None, 'tools': []}
        text = format_actions_module(snapshot, {'actions': {}, 'warnings': ['skip it']}, 'tools.json')
        self.assertTrue(text.startswith('// Generated from test://s'))
        self.assertIn('// skip it', text)


if __name__ == '__main__':
    unittest.main()
