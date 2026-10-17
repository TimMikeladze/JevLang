"""The MCP server, ported from src/mcp.mjs, checked against mcp-oracle.rkt.

Development-only oracle parts skip when Racket or the monorepo layout is
absent, like every oracle test in this suite."""
from __future__ import annotations

import asyncio
import json
import os
import subprocess
import shutil
import unittest
from pathlib import Path

PACKAGES = Path(__file__).resolve().parents[2]
TS_TEST = PACKAGES / 'test'

from jevlang._mcp import (LEGACY_VERSIONS, META_CLIENT_CAPABILITIES, META_PROTOCOL_VERSION,
                          META_SERVER_INFO, MODERN_VERSION, SUPPORTED_VERSIONS, decode_header_value,
                          encode_header_value, handle_message, http_handle, input_required,
                          make_mcp_conn, make_mcp_server, mcp_input_required, mcp_text_result,
                          mcp_tool, mcp_tool_error, origin_allowed, policy_mcp_server,
                          policy_to_json, serve_stdio)
from tests.test_local import ticket_policy  # noqa: E402

MODERN_META = {META_PROTOCOL_VERSION: MODERN_VERSION, META_CLIENT_CAPABILITIES: {}}
ANSWERS = {
    'department': {'type': 'choice', 'choice': 'billing', 'confidence': 0.93,
                   'probabilities': {'billing': 0.93}},
    'frustration': {'type': 'score', 'score': 0.2, 'confidence': 0.9,
                    'probabilities': {'0': 0.8, '1': 0.2, '2': 0.0}},
    'refund-requested?': {'type': 'noul', 'noul': 0.1},
}


def racket_available() -> bool:
    return (TS_TEST / 'mcp-oracle.rkt').is_file() and shutil.which('racket') is not None and subprocess.run(['racket', '--version'], capture_output=True).returncode == 0


def run_racket(file: str, *args: str):
    env = {**os.environ, 'TYPESAFE_API_KEY': '', 'ANTHROPIC_API_KEY': '', 'OPENAI_API_KEY': '',
           'JEV_PROVIDER': '', 'JEV_MODEL': '', 'JEV_EFFORT': ''}
    result = subprocess.run(['racket', str(TS_TEST / file), *args], capture_output=True,
                            encoding='utf8', env=env, timeout=300, cwd=str(TS_TEST))
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


class OracleTests(unittest.TestCase):
    @unittest.skipUnless(racket_available() and TS_TEST.is_dir(), 'Racket and the monorepo are required')
    def test_the_same_mcp_messages_get_the_same_replies(self):
        expected = [row['reply'] for row in run_racket('mcp-oracle.rkt')]
        session_path = Path(__file__).parent / 'fixtures' / 'legacy-examples' / 'mcp-session.jsonl'
        session = [json.loads(line) for line in session_path.read_text().split('\n')
                   if line.strip() != '']
        extra = [
            {'jsonrpc': '2.0', 'id': 10, 'method': 'tools/list',
             'params': {'_meta': {META_PROTOCOL_VERSION: MODERN_VERSION}}},
            {'jsonrpc': '2.0', 'id': 11, 'method': 'ping',
             'params': {'_meta': {META_PROTOCOL_VERSION: '1999-01-01',
                                  META_CLIENT_CAPABILITIES: {}}}},
            {'jsonrpc': '2.0', 'id': 12, 'method': 'nonsense/method', 'params': {}},
            {'jsonrpc': '2.0', 'id': 13, 'method': 'tools/call',
             'params': {'name': 'nope', 'arguments': {}}},
            {'jsonrpc': '2.0', 'id': 14, 'method': 'resources/list', 'params': {}},
            {'jsonrpc': '2.0', 'id': 15, 'method': 'resources/read',
             'params': {'uri': 'jev://policy/actions'}},
            {'jsonrpc': '2.0', 'id': 16, 'method': 'resources/read', 'params': {'uri': 'jev://nowhere'}},
            {'jsonrpc': '2.0', 'id': 17, 'method': 'tools/list', 'params': {'cursor': 'abc'}},
            {'jsonrpc': '2.0', 'id': {'bad': True}, 'method': 'ping', 'params': {}},
            {'jsonrpc': '2.0', 'method': 'notifications/cancelled', 'params': {}},
        ]
        server = policy_mcp_server(ticket_policy())
        conn = make_mcp_conn()

        async def replies() -> list:
            return [await handle_message(server, msg, conn) for msg in session + extra]

        got = asyncio.run(replies())
        self.assertEqual(len(got), len(expected))
        for i, reply in enumerate(got):
            want = expected[i]
            if want is None:
                self.assertIsNone(reply, f'message {i}')
                continue
            if want.get('error'):
                self.assertEqual(reply['error']['code'], want['error']['code'], f'message {i} code')
                self.assertEqual(reply['error']['message'].split('\n')[0],
                                 want['error']['message'].split('\n')[0], f'message {i} message')
                self.assertEqual(reply['error'].get('data'), want['error'].get('data'),
                                 f'message {i} data')
                continue
            self.assertEqual(reply.get('id'), want.get('id'), f'message {i} id')
            result = reply.get('result', {})
            wresult = want.get('result', {})
            if wresult.get('contents'):
                def parsed(contents):
                    return [{**{k: v for k, v in c.items() if k != 'text'},
                             'text': json.loads(c['text'])
                             if c.get('mimeType') == 'application/json' else c.get('text')}
                            for c in contents]
                self.assertEqual(parsed(result['contents']), parsed(wresult['contents']),
                                 f'message {i} contents')
            for key in ('resultType', 'ttlMs', 'cacheScope', 'protocolVersion', 'supportedVersions',
                        'capabilities', 'isError', 'resources'):
                if key in wresult:
                    self.assertEqual(result.get(key), wresult[key], f'message {i} {key}')
            if wresult.get('structuredContent'):
                comparable = lambda s: {**{k: v for k, v in s.items()
                                           if k not in ('file', 'line', 'source', 'explain', 'policy')},
                                        'policyName': (s.get('policy') or {}).get('name'),
                                        'policyHash': (s.get('policy') or {}).get('hash')}
                self.assertEqual(comparable(result['structuredContent']),
                                 comparable(wresult['structuredContent']), f'message {i} structured')
            if wresult.get('tools'):
                self.assertEqual([t['name'] for t in result['tools']],
                                 [t['name'] for t in wresult['tools']], f'message {i} tool names')
                self.assertEqual([t.get('inputSchema') for t in result['tools']],
                                 [t.get('inputSchema') for t in wresult['tools']])
                self.assertEqual([t.get('annotations') for t in result['tools']],
                                 [t.get('annotations') for t in wresult['tools']])
            if wresult.get('_meta'):
                self.assertEqual(list(result.get('_meta', {}).keys()),
                                 list(wresult['_meta'].keys()), f'message {i} _meta keys')


class ServerTests(unittest.TestCase):
    def test_modern_stateless_and_legacy_only_after_initialize(self):
        server = policy_mcp_server(ticket_policy())

        async def run():
            fresh = lambda: make_mcp_conn()  # noqa: E731
            listed = await handle_message(server, {'jsonrpc': '2.0', 'id': 1, 'method': 'tools/list',
                                                   'params': {'_meta': MODERN_META}}, fresh())
            self.assertEqual(listed['result']['resultType'], 'complete')
            self.assertEqual(listed['result']['_meta'][META_SERVER_INFO]['name'], 'jev-ticket-router')
            self.assertEqual(listed['result']['cacheScope'], 'private')
            early = await handle_message(server, {'jsonrpc': '2.0', 'id': 2, 'method': 'ping',
                                                  'params': {'_meta': {
                                                      META_PROTOCOL_VERSION: LEGACY_VERSIONS[0],
                                                      META_CLIENT_CAPABILITIES: {}}}}, fresh())
            self.assertEqual(early['error']['code'], -32022)
            self.assertIn('send initialize first', early['error']['message'])
            self.assertEqual(early['error']['data']['supported'], SUPPORTED_VERSIONS)
            conn = fresh()
            handshake = await handle_message(server, {
                'jsonrpc': '2.0', 'id': 3, 'method': 'initialize',
                'params': {'protocolVersion': '2025-06-18', 'capabilities': {},
                           'clientInfo': {'name': 'hand', 'version': '0'}}}, conn)
            self.assertEqual(handshake['result']['protocolVersion'], '2025-06-18')
            legacy = await handle_message(server, {'jsonrpc': '2.0', 'id': 4,
                                                   'method': 'tools/list', 'params': {}}, conn)
            self.assertNotIn('resultType', legacy['result'])
            self.assertNotIn('ttlMs', legacy['result'])
            self.assertNotIn('_meta', legacy['result'])
            odd = await handle_message(server, {'jsonrpc': '2.0', 'id': 5, 'method': 'initialize',
                                                'params': {'protocolVersion': '1999-01-01'}}, fresh())
            self.assertEqual(odd['result']['protocolVersion'], LEGACY_VERSIONS[0])

        asyncio.run(run())

    def test_decide_runs_the_policy_and_errors_are_tool_results(self):
        server = policy_mcp_server(ticket_policy())
        conn = make_mcp_conn()

        async def run():
            called = await handle_message(server, {'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call',
                                                   'params': {'_meta': MODERN_META, 'name': 'decide',
                                                              'arguments': {'answers': ANSWERS}}}, conn)
            self.assertFalse(called['result']['isError'])
            self.assertEqual(called['result']['structuredContent']['target'], 'billing-queue')
            self.assertIn('assign billing-queue', called['result']['content'][0]['text'])
            bad = await handle_message(server, {'jsonrpc': '2.0', 'id': 2, 'method': 'tools/call',
                                                'params': {'_meta': MODERN_META, 'name': 'decide',
                                                           'arguments': {'answers': {
                                                               'department': {'type': 'choice',
                                                                              'choice': 'nope'}}}}}, conn)
            self.assertTrue(bad['result']['isError'])
            listed = await handle_message(server, {'jsonrpc': '2.0', 'id': 3, 'method': 'tools/list',
                                                   'params': {'_meta': MODERN_META}}, conn)
            self.assertEqual([t['name'] for t in listed['result']['tools']], ['decide'])
            with_evaluate = policy_mcp_server(
                ticket_policy(), allow_evaluate=True, max_calls=1,
                evaluate=lambda state: ticket_policy().decide(ANSWERS))
            first = await handle_message(with_evaluate, {'jsonrpc': '2.0', 'id': 4,
                                                         'method': 'tools/call',
                                                         'params': {'_meta': MODERN_META,
                                                                    'name': 'evaluate',
                                                                    'arguments': {'state': {'ticket': 'x'}}}}, conn)
            self.assertEqual(first['result']['structuredContent']['target'], 'billing-queue')
            second = await handle_message(with_evaluate, {'jsonrpc': '2.0', 'id': 5,
                                                          'method': 'tools/call',
                                                          'params': {'_meta': MODERN_META,
                                                                     'name': 'evaluate',
                                                                     'arguments': {'state': {'ticket': 'x'}}}}, conn)
            self.assertIn('has run 1 times', second['result']['content'][0]['text'])

        asyncio.run(run())

    def test_a_tool_can_ask_and_a_legacy_client_can_be_asked(self):
        async def ask_run(args, call):
            if call.get('inputResponses'):
                return mcp_text_result(f'heard {json.dumps(call["inputResponses"], separators=(",", ":"))}')
            if call.get('elicit'):
                answer = await call['elicit']('Which room?', {'type': 'object'})
                return mcp_text_result(f'elicited {json.dumps(answer.get("content") if answer else None, separators=(",", ":"))}')
            return mcp_input_required(
                {'room': {'method': 'elicitation/create', 'params': {'message': 'Which room?'}}},
                state='abc')

        asking = mcp_tool(name='ask', input_schema={'type': 'object'}, run=ask_run)
        server = make_mcp_server('asking', tools=[asking])

        async def run():
            needed = await handle_message(server, {'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call',
                                                   'params': {'_meta': MODERN_META, 'name': 'ask',
                                                              'arguments': {}}}, make_mcp_conn())
            self.assertTrue(input_required(needed['result']))
            self.assertEqual(needed['result']['requestState'], 'abc')
            self.assertNotIn('ttlMs', needed['result'])
            retried = await handle_message(server, {'jsonrpc': '2.0', 'id': 2, 'method': 'tools/call',
                                                    'params': {'_meta': MODERN_META, 'name': 'ask',
                                                               'arguments': {},
                                                               'inputResponses': {'room': 'kitchen'}}},
                                           make_mcp_conn())
            self.assertIn('heard {"room":"kitchen"}', retried['result']['content'][0]['text'])
            sent = []

            async def send_request(method, params):
                sent.append((method, params))
                return {'content': {'room': 'bedroom'}}

            conn = make_mcp_conn(send_request=send_request)
            await handle_message(server, {'jsonrpc': '2.0', 'id': 3, 'method': 'initialize',
                                          'params': {'protocolVersion': '2025-11-25',
                                                     'capabilities': {'elicitation': {}}}}, conn)
            elicited = await handle_message(server, {'jsonrpc': '2.0', 'id': 4, 'method': 'tools/call',
                                                     'params': {'name': 'ask', 'arguments': {}}}, conn)
            self.assertIn('elicited {"room":"bedroom"}', elicited['result']['content'][0]['text'])
            self.assertEqual(sent[0][0], 'elicitation/create')
            self.assertEqual(sent[0][1]['mode'], 'form')
            refused = await handle_message(server, {'jsonrpc': '2.0', 'id': 5, 'method': 'tools/call',
                                                    'params': {'name': 'ask', 'arguments': {}}},
                                           make_mcp_conn(legacy_version='2025-06-18'))
            self.assertEqual(refused['error']['code'], -32603)
            self.assertIn('can only be asked over stdio with elicitation', refused['error']['message'])

        asyncio.run(run())

    def test_post_mcp_checks_origin_and_matching_headers(self):
        server = policy_mcp_server(ticket_policy())
        body = json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'tools/list',
                           'params': {'_meta': MODERN_META}})
        headers = {'mcp-protocol-version': MODERN_VERSION, 'mcp-method': 'tools/list'}

        async def run():
            ok = await http_handle(server, headers, body)
            self.assertEqual(ok['status'], 200)
            self.assertEqual(ok['body']['result']['resultType'], 'complete')
            mismatched = await http_handle(server, {**headers, 'mcp-method': 'tools/call'}, body)
            self.assertEqual(mismatched['status'], 400)
            self.assertEqual(mismatched['body']['error']['code'], -32020)
            missing = await http_handle(server, {'mcp-method': 'tools/list'}, body)
            self.assertEqual(missing['body']['error']['code'], -32020)
            foreign = await http_handle(server, {**headers, 'origin': 'https://evil.example'}, body)
            self.assertEqual(foreign['status'], 403)
            self.assertEqual((await http_handle(server, {**headers, 'origin': 'http://localhost:3000'},
                                                body))['status'], 200)
            self.assertEqual((await http_handle(server, {**headers, 'origin': 'https://app.example.com'},
                                                body, origins=['https://app.example.com']))['status'], 200)
            self.assertTrue(origin_allowed(None))
            self.assertFalse(origin_allowed('https://evil.example', []))
            self.assertEqual((await http_handle(server, headers, '[{"jsonrpc":"2.0"}]'))['body']['error']['code'], -32600)
            self.assertEqual((await http_handle(server, headers, 'not json'))['body']['error']['code'], -32700)
            notified = await http_handle(
                server, {'mcp-protocol-version': MODERN_VERSION},
                json.dumps({'jsonrpc': '2.0', 'method': 'notifications/initialized',
                            'params': {'_meta': MODERN_META}}))
            self.assertEqual(notified['status'], 202)
            self.assertIsNone(notified['body'])

        asyncio.run(run())
        self.assertEqual(decode_header_value(encode_header_value('naïve')), 'naïve')
        self.assertEqual(encode_header_value('plain'), 'plain')

    def test_stdio_serves_newline_delimited_json_rpc(self):
        async def better():
            reader = asyncio.StreamReader()
            collector = _Collector()
            lines = [
                json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'tools/list',
                            'params': {'_meta': MODERN_META}}),
                'not json',
                json.dumps({'jsonrpc': '2.0', 'method': 'notifications/initialized'}),
                json.dumps({'jsonrpc': '2.0', 'id': 2, 'method': 'tools/call',
                            'params': {'_meta': MODERN_META, 'name': 'decide',
                                       'arguments': {'answers': ANSWERS}}}),
            ]
            task = asyncio.ensure_future(serve_stdio(policy_mcp_server(ticket_policy()),
                                                     reader, collector, elicit_timeout_seconds=5))
            for line in lines:
                reader.feed_data((line + '\n').encode('utf8'))
                await asyncio.sleep(0)
            reader.feed_eof()
            await asyncio.wait_for(task, 5)
            replies = [json.loads(line) for line in collector.lines if line != '']
            self.assertEqual([r.get('id') for r in replies], [1, None, 2])
            self.assertEqual(replies[1]['error']['code'], -32700)
            self.assertEqual(replies[2]['result']['structuredContent']['target'], 'billing-queue')

        asyncio.run(better())

    def test_the_policy_resource_describes_the_policy(self):
        described = policy_to_json(ticket_policy())
        self.assertEqual(described['name'], 'ticket-router')
        self.assertEqual(described['state_fields'], ['ticket'])
        self.assertEqual(sorted(described['targets']),
                         ['billing-queue', 'engineering-oncall', 'human-triage',
                          'retention-oncall', 'sales-inbox'])
        self.assertFalse(described['dynamic_questions'])
        from jevlang._engine import CompiledPolicy
        self.assertEqual(described['questions_sha256'], CompiledPolicy(ticket_policy().to_json()).identity())
        self.assertEqual(sorted(described['questions'].keys()),
                         ['department', 'frustration', 'refund-requested?'])


class _Collector:
    def __init__(self):
        self.lines = []
        self._buffer = b''

    def write(self, data: bytes) -> None:
        self._buffer += data
        while b'\n' in self._buffer:
            line, self._buffer = self._buffer.split(b'\n', 1)
            self.lines.append(line.decode('utf8'))

    async def drain(self) -> None:
        pass


if __name__ == '__main__':
    unittest.main()
