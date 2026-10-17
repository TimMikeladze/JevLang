"""The serve sidecar, ported from src/serve.mjs: handle_request's answers and
a live loopback server with a token."""
from __future__ import annotations

import asyncio
import json
import unittest
import urllib.error
import urllib.request
from typing import Any

from jevlang._dispatch import policy_targets_of
from jevlang._serve import (handle_request, loopback_host, make_serve_dispatchers,
                            serve_route, start_server, token_matches)
from tests.test_harvest import ANSWERS
from tests.test_local import ticket_policy


def compiled():
    from jevlang._engine import CompiledPolicy
    return CompiledPolicy(ticket_policy().to_json())


class HandleRequestTests(unittest.TestCase):
    def test_the_builtin_routes(self):
        policy = compiled()

        async def run():
            health = await handle_request(policy, 'GET', '/healthz', None)
            self.assertEqual(health['status'], 200)
            self.assertEqual(health['body'], {'ok': True, 'policy': 'ticket-router'})
            described = await handle_request(policy, 'GET', '/policy', None)
            self.assertEqual(described['body']['name'], 'ticket-router')
            no_route = await handle_request(policy, 'GET', '/nope', None)
            self.assertEqual(no_route['status'], 404)
            self.assertIn('GET /healthz', no_route['body']['routes'])
            wrong_method = await handle_request(policy, 'POST', '/healthz', None)
            self.assertEqual(wrong_method['status'], 405)
            bad_json = await handle_request(policy, 'POST', '/decide', b'not json')
            self.assertEqual((bad_json['status'], bad_json['body']['kind']), (400, 'request'))
            missing = await handle_request(policy, 'POST', '/decide', b'{}')
            self.assertEqual(missing['status'], 400)
            decided = await handle_request(policy, 'POST', '/decide',
                                           json.dumps({'answers': ANSWERS}).encode('utf8'))
            self.assertEqual(decided['status'], 200)
            self.assertEqual(decided['body']['target'], 'billing-queue')
            self.assertIn('explain', decided['body'])
            no_evaluate = await handle_request(policy, 'POST', '/evaluate', b'{"state": {}}')
            self.assertEqual(no_evaluate['status'], 501)
            bad_answers = await handle_request(policy, 'POST', '/decide',
                                               json.dumps({'answers': {
                                                   'department': {'type': 'choice',
                                                                  'choice': 'nope'}}}).encode('utf8'))
            # /decide gets answers from the caller, so a bad answer is a 422.
            self.assertEqual(bad_answers['status'], 422)

        asyncio.run(run())

    def test_extra_routes_and_dispatch_rules(self):
        policy = compiled()

        async def run():
            def handler(method, path, headers, body):
                return {'status': 200, 'body': {'route': path}, 'headers': {}}

            routes = [serve_route(method='POST', path='/webhook/', prefix=True, auth='open',
                                  handler=handler)]
            hit = await handle_request(policy, 'POST', '/webhook/tickets?a=1', b'{}', routes=routes)
            self.assertEqual(hit['body'], {'route': '/webhook/tickets?a=1'})
            wrong = await handle_request(policy, 'GET', '/webhook/tickets', None, routes=routes)
            self.assertEqual((wrong['status'], wrong['headers']['Allow']), (405, 'POST'))
            # /dispatch needs handlers, an input and a token or loopback.
            no_handlers = await handle_request(policy, 'POST', '/dispatch', b'{"input": {}}')
            self.assertEqual(no_handlers['status'], 400)
            not_json = await handle_request(policy, 'POST', '/dispatch', b'x',
                                            dispatchers={'dry': None, 'run': None})
            self.assertEqual(not_json['status'], 400)
            no_input = await handle_request(policy, 'POST', '/dispatch', b'{}',
                                            dispatchers={'dry': None, 'run': None})
            self.assertEqual(no_input['status'], 400)
            forbidden = await handle_request(
                policy, 'POST', '/dispatch', b'{"input": {}}',
                dispatchers={'dry': None, 'run': None}, dispatch_allowed=False)
            self.assertEqual(forbidden['status'], 403)
            async def bill(state, decision, context=None):
                return {'ran': True}

            async def any_target(state, decision, context=None):
                return {'ran': True}

            all_targets = {t: any_target for t in policy_targets_of(policy.policy)}
            dispatchers = make_serve_dispatchers(policy, all_targets)
            dry_ok = await handle_request(
                policy, 'POST', '/dispatch',
                json.dumps({'input': {'ticket': 'x'}, 'answers': ANSWERS, 'dry_run': True}).encode('utf8'),
                dispatchers=dispatchers, dispatch_allowed=False)
            self.assertEqual(dry_ok['status'], 200)
            self.assertEqual(dry_ok['body']['status'], 'dry-run')

        asyncio.run(run())

    def test_tokens(self):
        self.assertTrue(loopback_host('127.0.0.1'))
        self.assertFalse(loopback_host('0.0.0.0'))
        self.assertTrue(token_matches('secret', 'Bearer secret'))
        self.assertTrue(token_matches('secret', 'bearer secret'))
        self.assertFalse(token_matches('secret', 'Bearer wrong'))
        self.assertFalse(token_matches('secret', None))


class ServerTests(unittest.TestCase):
    def test_a_live_server_answers_over_http(self):
        log = []

        class Log:
            def write(self, line):
                log.append(line)

        logger = Log()

        async def run():
            policy = compiled()

            async def evaluate(state):
                return policy.decide(ANSWERS, {'facts': policy.build_state(state)['facts']})

            server = await start_server(policy, host='127.0.0.1', port=0, token='tok',
                                        evaluate=evaluate, log=logger)
            try:
                self.assertTrue(server.url.startswith('http://127.0.0.1:'))
                no_token = await asyncio.to_thread(_post, server.url, '/decide',
                                                   {'answers': ANSWERS})
                self.assertEqual(no_token.status, 401)
                health = await asyncio.to_thread(_get, server.url, '/healthz')
                self.assertEqual(health.status, 200)
                with_token = await asyncio.to_thread(_post, server.url, '/decide',
                                                     {'answers': ANSWERS}, token='tok')
                self.assertEqual(with_token.status, 200)
                self.assertEqual(json.loads(with_token.read())['target'], 'billing-queue')
                # A port that is taken is not touched: the next one is used.
                second = await start_server(policy, host='127.0.0.1', port=server.port,
                                            token='tok', evaluate=evaluate)
                self.assertNotEqual(second.port, server.port)
                await second.stop()
            finally:
                await server.stop()
            self.assertTrue(any('POST /decide 200' in line for line in log))

        asyncio.run(run())


def _post(url, path, body, token=None):
    headers = {'Content-Type': 'application/json'}
    if token:
        headers['Authorization'] = f'Bearer {token}'
    request = urllib.request.Request(url + path, data=json.dumps(body).encode('utf8'),
                                     method='POST', headers=headers)
    try:
        return urllib.request.urlopen(request, timeout=10)
    except urllib.error.HTTPError as error:
        return error


def _get(url, path):
    return urllib.request.urlopen(url + path, timeout=10)




class PortabilityTests(unittest.IsolatedAsyncioTestCase):
    async def test_port_collision_uses_platform_errno(self):
        import errno
        from types import SimpleNamespace
        from unittest.mock import AsyncMock, patch
        from jevlang._serve import start_server
        fake = SimpleNamespace(sockets=[SimpleNamespace(getsockname=lambda: ('127.0.0.1', 8001))])
        bind = AsyncMock(side_effect=[OSError(98, 'address already in use'), fake])
        with patch.object(errno, 'EADDRINUSE', 98), patch('jevlang._serve.asyncio.start_server', bind):
            result = await start_server(compiled(), port=8000)
        self.assertEqual(result.port, 8001)
        self.assertEqual([c.args[2] for c in bind.call_args_list], [8000, 8001])


if __name__ == '__main__':
    unittest.main()
