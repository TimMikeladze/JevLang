"""Handlers, loop and session, mirroring packages/jevlang/test/automation.test.mjs
offline. The dispatcher seam (jevlang._dispatch, another slice) is faked here
with the same semantics the TS tests got from makeDispatcher: a handler for the
decision's target runs, otherwise the outcome passes through.
"""
import asyncio
import json
import os
import shutil
import subprocess
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import jevlang._loop as loop_module
from jevlang._dispatch import make_dispatcher
from jevlang._handlers import (confirm_handler, fill_template, handler_from_spec,
                               load_handlers, mqtt_publish)
from jevlang._loop import (iterable_source, line_source, loop_idle, loop_post,
                           loop_start, loop_stop, make_event, make_loop, run_events,
                           timer_source)
from jevlang._session import (default_merge, make_sessions, session_forget,
                              session_message, session_pending)


def decision(action, target, data=None, **extra):
    d = {'action': action, 'target': target, 'reason': None, 'data': data}
    d.update(extra)
    return d


# ---- template and merge -------------------------------------------------------

class TemplateTest(unittest.TestCase):
    CASES = [
        ('home/{room}/light', {'room': 'kitchen'}, 'home/kitchen/light'),
        ('{action}:{target}', {'action': 'act', 'target': 'lights-on'}, 'act:lights-on'),
        ('count={n} on={on} missing-nothing', {'n': 3, 'on': True}, 'count=3 on=true missing-nothing'),
        ('{list}', {'list': ['a', 'b']}, '["a","b"]'),
        ('{obj}', {'obj': {'a': 1}}, '{"a":1}'),
        ('no placeholders', {}, 'no placeholders'),
        ('{a-b?}', {'a-b?': 'yes'}, 'yes'),
    ]

    def test_template_grammar(self):
        for text, vars, filled in self.CASES:
            self.assertEqual(fill_template(text, vars, 'oracle'), filled)
        # A name the decision does not have is an error, not an empty string.
        with self.assertRaisesRegex(Exception, 'is not a parameter'):
            fill_template('{nope}', {'room': 'kitchen'}, 'oracle')

    def test_racket_oracle(self):
        """Racket is the only oracle: check the grammar and the merge against it."""
        import pathlib
        oracle = pathlib.Path(__file__).resolve().parents[2] / 'test' / 'automation-oracle.rkt'
        if not oracle.exists() or shutil.which('racket') is None:
            self.skipTest('the Racket oracle is not available outside the monorepo')
        env = dict(os.environ)
        for key in ('TYPESAFE_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY'):
            env.pop(key, None)
        run = subprocess.run(['racket', str(oracle)], capture_output=True, text=True, env=env)
        self.assertEqual(run.returncode, 0, run.stderr)
        expected = json.loads(run.stdout)
        for (text, vars, _filled), want in zip(self.CASES, expected['templates']):
            self.assertEqual(fill_template(text, vars, 'oracle'), want['filled'])
        self.assertEqual(expected['missing'], 'error')
        self.assertEqual(default_merge('turn the lights on', 'Which room?', 'the bedroom'),
                         expected['merge-string'])
        self.assertEqual(default_merge({'request': 'turn the lights on', 'rooms': ['kitchen']},
                                       'Which room?', 'the bedroom'),
                         expected['merge-object'])


# ---- handlers -----------------------------------------------------------------

class ShellHandlerTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix='jev-handlers-')

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_declared_argv_one_argument_per_placeholder_never_a_shell(self):
        handlers = load_handlers({
            'handlers': {
                'lock-door': {'type': 'shell', 'argv': ['/bin/echo', 'lock', '{door}', 'at', '{key}']},
                'many': {'type': 'shell', 'argv': ['/bin/echo', '{rooms}']},
                'failing': {'type': 'shell', 'argv': ['/bin/sh', '-c', 'echo trouble >&2; exit 3']},
                'slow': {'type': 'shell', 'argv': ['/bin/sleep', '5'], 'timeout': 0.2},
            }})
        ran = asyncio.run(handlers['lock-door'](
            {}, decision('act', 'lock-door', {'door': 'front; rm -rf /'}), {'key': 'req-1/lock-door'}))
        # The argument holds a shell metacharacter and is still one argument.
        self.assertEqual(ran['stdout'].strip(), 'lock front; rm -rf / at req-1/lock-door')
        listed = asyncio.run(handlers['many'](
            {}, decision('act', 'many', {'rooms': ['kitchen', 'bedroom']}), {}))
        self.assertEqual(listed['stdout'].strip(), 'kitchen bedroom')
        with self.assertRaisesRegex(Exception, r'exited with 3[\s\S]*trouble'):
            asyncio.run(handlers['failing']({}, decision('act', 'failing'), {}))
        with self.assertRaisesRegex(Exception, r'ran longer than 0\.2 seconds and was killed'):
            asyncio.run(handlers['slow']({}, decision('act', 'slow'), {}))
        # A placeholder for the executable is refused when the handler is built.
        with self.assertRaisesRegex(Exception, 'cannot be a placeholder'):
            handler_from_spec('bad', {'type': 'shell', 'argv': ['{exe}']}, self.dir)
        with self.assertRaisesRegex(Exception, 'unknown type'):
            handler_from_spec('bad', {'type': 'nonsense'}, self.dir)


class _LoopbackHandler(BaseHTTPRequestHandler):
    seen = []

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get('Content-Length', 0))).decode('utf-8')
        _LoopbackHandler.seen.append({'url': self.path,
                                      'key': self.headers.get('Idempotency-Key'),
                                      'body': json.loads(body)})
        if self.path == '/approve':
            reply = '{"approved": true}'
        elif self.path == '/deny':
            reply = '{"approved": false}'
        elif self.path == '/boom':
            self.send_response(500)
            self.send_header('Content-Type', 'text/plain')
            self.end_headers()
            self.wfile.write(b'the model is down')
            return
        else:
            reply = '{"queued": true}'
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(reply.encode('utf-8'))

    def log_message(self, format, *args):  # noqa: A002 - base class signature
        pass


class HttpHandlerTest(unittest.TestCase):
    def setUp(self):
        _LoopbackHandler.seen = []
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), _LoopbackHandler)
        self.url = f'http://127.0.0.1:{self.server.server_address[1]}'
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def test_posts_the_decision_with_its_idempotency_key(self):
        handlers = load_handlers({
            'handlers': {
                'chat-model': {'type': 'http', 'url': f'{self.url}/chat/{{target}}', 'include_state': True},
                'confirm': {'type': 'http', 'url': f'{self.url}/approve'},
                'deny': {'type': 'http', 'url': f'{self.url}/deny'},
                'broken': {'type': 'http', 'url': f'{self.url}/boom'},
            }})
        answer = asyncio.run(handlers['chat-model'](
            {'ticket': 'x'}, decision('assign', 'chat-model'), {'key': 'req-2/chat-model'}))
        self.assertEqual(answer, {'queued': True})
        self.assertEqual(_LoopbackHandler.seen[0]['url'], '/chat/chat-model')
        self.assertEqual(_LoopbackHandler.seen[0]['key'], 'req-2/chat-model')
        self.assertEqual(_LoopbackHandler.seen[0]['body']['state'], {'ticket': 'x'})
        self.assertEqual(_LoopbackHandler.seen[0]['body']['key'], 'req-2/chat-model')
        # The confirm entry is wrapped: only true or {approved: true} approves.
        self.assertIs(asyncio.run(handlers['confirm']({}, decision('confirm', 'unlock'), {})), True)

        async def denying(_s, _d, _c):
            return {'approved': False}
        self.assertIs(asyncio.run(confirm_handler(denying)({}, decision('confirm', 'unlock'), {})), False)
        with self.assertRaisesRegex(Exception, r'answered 500[\s\S]*the model is down'):
            asyncio.run(handlers['broken']({}, decision('assign', 'broken'), {}))

    def test_a_broken_url_is_an_error_not_a_hang(self):
        handlers = load_handlers({'handlers': {
            'dead': {'type': 'http', 'url': 'http://127.0.0.1:1/nope', 'timeout': 1}}})
        with self.assertRaisesRegex(Exception, 'could not be reached'):
            asyncio.run(handlers['dead']({}, decision('assign', 'dead'), {}))


class LogHandlerTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix='jev-handlers-')

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_one_json_line_per_decision(self):
        path = os.path.join(self.dir, 'decisions.log')
        handlers = load_handlers({'handlers': {'ask-user': {'type': 'log', 'path': 'decisions.log'}}},
                                 self.dir)
        logger = handler_from_spec('ask-user', {'type': 'log', 'path': path}, self.dir)
        first = asyncio.run(logger(
            {}, decision('escalate', 'ask-user', None, **{'reason': 'which room?'}),
            {'key': 'req-3/ask-user'}))
        self.assertEqual(first, 'logged')
        asyncio.run(logger({}, decision('escalate', 'ask-user'), {}))
        with open(path, encoding='utf-8') as handle:
            lines = [json.loads(line) for line in handle.read().strip().split('\n')]
        self.assertEqual(len(lines), 2)
        self.assertEqual(lines[0]['decision']['reason'], 'which room?')
        self.assertEqual(lines[0]['key'], 'req-3/ask-user')
        self.assertIsNone(lines[1]['key'])
        self.assertTrue(handlers['ask-user'])


class MqttHandlerTest(unittest.TestCase):
    def test_publishes_and_reports_a_refusal(self):
        async def run():
            packets = []

            async def handle_client(reader, writer):
                while True:
                    chunk = await reader.read(4096)
                    if not chunk:
                        return
                    packets.append(chunk)
                    packet_type = chunk[0] & 0xF0
                    if packet_type == 0x10:
                        writer.write(bytes([0x20, 2, 0, 0]))          # CONNACK
                    if packet_type == 0x30 and (chunk[0] & 0x06):
                        writer.write(bytes([0x40, 2, 0, 1]))          # PUBACK
                    await writer.drain()
            server = await asyncio.start_server(handle_client, '127.0.0.1', 0)
            port = server.sockets[0].getsockname()[1]
            try:
                handler = handler_from_spec('set-light',
                                            {'type': 'mqtt', 'broker': f'127.0.0.1:{port}',
                                             'topic': 'home/{room}/light', 'qos': 1},
                                            os.getcwd())
                result = await handler({}, decision('act', 'set-light',
                                                    {'room': 'kitchen', 'power': 'off'}), {})
                self.assertEqual(result, {'published': 'home/kitchen/light'})
                publish = next(p for p in packets if (p[0] & 0xF0) == 0x30)
                self.assertIn('home/kitchen/light', publish.decode('utf-8'))
                # The payload defaults to the act decision's parameters.
                self.assertIn('"room":"kitchen"', publish.decode('utf-8'))

                refusing = await asyncio.start_server(_refusing_reader, '127.0.0.1', 0)
                # A broker that refuses the connection is an error, not a silent no-op.
                refusing_port = refusing.sockets[0].getsockname()[1]
                with self.assertRaisesRegex(Exception, 'not authorized'):
                    await mqtt_publish('127.0.0.1', refusing_port, 'home/x', 'hi', timeout_seconds=1)
                refusing.close()
                await refusing.wait_closed()
            finally:
                server.close()
                await server.wait_closed()
        asyncio.run(run())


async def _refusing_reader(reader, writer):
    await reader.read(4096)
    writer.write(bytes([0x20, 2, 0, 5]))
    await writer.drain()


# ---- the loop -----------------------------------------------------------------

def _status(result):
    return 'stale' if result == 'stale' else result['status']


class LoopTest(unittest.TestCase):
    def test_serializes_one_key_debounces_and_drops_stale(self):
        async def run():
            handled = []

            async def queue(_s, _d, _c):
                await asyncio.sleep(0.005)
                return 'queued'
            d = make_dispatcher({'queue': queue})
            l = make_loop(evaluate=lambda input: decision('assign', 'queue', {'input': input}),
                          dispatcher=d, workers=4, max_age=1,
                          on_outcome=lambda event, result: handled.append([event['input'], _status(result)]))
            loop_start(l)
            # Same key: handled one at a time, in order.
            loop_post(l, make_event('a1', key='panel'))
            loop_post(l, make_event('a2', key='panel'))
            loop_post(l, make_event('b1', key='sensor'))
            # Older than maxAge when its turn comes: stale, never evaluated.
            loop_post(l, make_event('old', key='other', at=l.clock() - 5000))
            await asyncio.sleep(0.06)
            await loop_stop(l)
            self.assertEqual(sorted(i for i, _ in handled), ['a1', 'a2', 'b1', 'old'])
            self.assertEqual(next(s for i, s in handled if i == 'old'), 'stale')
            self.assertEqual([i for i, _ in handled if i.startswith('a')], ['a1', 'a2'])
            self.assertTrue(loop_idle(l))

            # With a debounce, a burst for one key collapses to its latest.
            debounced = []
            quick = make_loop(evaluate=lambda input: decision('assign', 'queue', {'input': input}),
                              dispatcher=d, debounce=0.02,
                              on_outcome=lambda event, _result: debounced.append(event['input']))
            loop_start(quick)
            for value in ('x1', 'x2', 'x3'):
                loop_post(quick, make_event(value, key='panel'))
            await asyncio.sleep(0.08)
            await loop_stop(quick)
            self.assertEqual(debounced, ['x3'])
        asyncio.run(run())

    def test_sources_post_events_and_run_events_handles_in_order(self):
        async def run():
            async def queue(_s, _d, _c):
                return 'queued'
            d = make_dispatcher({'queue': queue})
            seen = []
            bad = []
            lines_path = os.path.join(tempfile.mkdtemp(prefix='jev-lines-'), 'events.jsonl')
            with open(lines_path, 'w', encoding='utf-8') as handle:
                handle.write('{"input": "from a line", "id": "delivery-1"}\nnot json\n"bare input"\n')
            l = make_loop(evaluate=lambda input: decision('assign', 'queue', {'input': input}),
                          dispatcher=d,
                          on_outcome=lambda event, _result: seen.append(event['input']),
                          sources=[])
            loop_start(l)
            lines_file = open(lines_path, 'r', encoding='utf-8')
            file_source = line_source(lines_file, on_error=lambda line, _error: bad.append(line))

            async def gen():
                yield 'from an iterable'
            stop_iterable = iterable_source(gen())(lambda event: loop_post(l, event))
            stop_timer = timer_source(0.01, lambda: 'from a timer', key='timer')(
                lambda event: loop_post(l, event))
            stop_lines = file_source(lambda event: loop_post(l, event))
            await asyncio.sleep(0.06)
            for stop in (stop_lines, stop_iterable, stop_timer):
                stop()
            lines_file.close()
            await loop_stop(l)
            self.assertIn('from a line', seen)
            self.assertIn('bare input', seen)
            self.assertIn('from an iterable', seen)
            self.assertIn('from a timer', seen)
            self.assertEqual(bad, ['not json'])

            results = await run_events(
                lambda input: decision('assign', 'queue', {'input': input}), d,
                [make_event('one'), make_event('two'), make_event('old', at=l.clock() - 10000)],
                max_age=1)
            self.assertEqual([(e['input'], _status(r)) for e, r in results],
                             [('one', 'ran'), ('two', 'ran'), ('old', 'stale')])
        asyncio.run(run())

    def test_a_failed_evaluation_is_an_outcome_not_a_stop(self):
        async def run():
            handled = []

            async def boom(_input):
                raise RuntimeError('the model is down')
            async def queue(_s, _d, _c):
                return 'queued'
            d = make_dispatcher({'queue': queue})
            l = make_loop(evaluate=boom, dispatcher=d,
                          on_outcome=lambda event, result: handled.append(result))
            loop_start(l)
            loop_post(l, make_event('a1'))
            await asyncio.sleep(0.02)
            await loop_stop(l)
            self.assertEqual(len(handled), 1)
            self.assertIsInstance(handled[0], RuntimeError)
        asyncio.run(run())

    def test_loop_stop_waits_for_the_in_flight_outcome(self):
        async def run():
            delivered = []

            async def slow_evaluate(_input):
                await asyncio.sleep(0.05)
                return decision('assign', 'queue')
            async def queue(_s, _d, _c):
                return 'queued'
            d = make_dispatcher({'queue': queue})
            l = make_loop(evaluate=slow_evaluate, dispatcher=d,
                          on_outcome=lambda _event, result: delivered.append(_status(result)))
            loop_start(l)
            loop_post(l, make_event('slow'))
            await asyncio.sleep(0.005)
            self.assertEqual(l.in_flight, 1)
            await loop_stop(l)
            # The in-flight event was not swallowed and ran exactly once.
            self.assertEqual(delivered, ['ran'])
            self.assertTrue(loop_idle(l))
        asyncio.run(run())

    def test_a_cancelled_worker_frees_its_key_and_the_next_runs_once(self):
        async def run():
            ran = []

            async def slow_evaluate(input):
                await asyncio.sleep(0.5)  # long enough to be cancelled mid-flight
                ran.append(f'evaluated:{input}')
                return decision('assign', 'queue', {'input': input})
            async def queue(_s, _d, _c):
                return 'queued'
            d = make_dispatcher({'queue': queue})
            l = make_loop(evaluate=slow_evaluate, dispatcher=d, workers=1,
                          on_outcome=lambda _event, result: ran.append(_status(result)))
            loop_start(l)
            loop_post(l, make_event('first', key='k'))
            await asyncio.sleep(0.01)
            loop_post(l, make_event('second', key='k'))
            self.assertEqual(len(l.settled), 1)
            # Cancel the in-flight worker, as a dying process would be.
            l.settled[0].cancel()
            await asyncio.sleep(0.02)
            # The count is honest (the queued event took the freed slot, it was
            # neither dropped nor double-run) and the first event never landed.
            self.assertEqual(l.in_flight, 1)
            await asyncio.wait([t for t in l.settled if t is not l.settled[0]], timeout=2)
            self.assertEqual(ran, ['evaluated:second', 'ran'])
            self.assertEqual(l.in_flight, 0)
            await loop_stop(l)
            self.assertTrue(loop_idle(l))
        asyncio.run(run())

    def test_run_due_ticks_on_a_schedule(self):
        async def run():
            due = []

            async def slow_evaluate(_input):
                return decision('assign', 'queue')
            async def queue(_s, _d, _c):
                return 'queued'
            d = make_dispatcher({'queue': queue})
            real_module = loop_module._dispatch_module()

            class Counting:
                def __getattr__(self, name):
                    return getattr(real_module, name)

                async def run_due(self, dispatcher):
                    due.append(1)
            counting = Counting()
            saved_seam = loop_module._dispatch_module
            loop_module._dispatch_module = lambda: counting
            try:
                l = make_loop(evaluate=slow_evaluate, dispatcher=d, run_due_every=0.01)
                loop_start(l)
                await asyncio.sleep(0.05)
                await loop_stop(l)
            finally:
                loop_module._dispatch_module = saved_seam
            self.assertGreaterEqual(len(due), 2)
        asyncio.run(run())


# ---- sessions -----------------------------------------------------------------

class SessionTest(unittest.TestCase):
    def test_clarify_merge_resume_and_hold(self):
        async def run():
            async def queue(_s, _d, _c):
                return 'queued'
            d = make_dispatcher({'queue': queue})
            asked = []

            async def evaluate(input):
                asked.append(input)
                if isinstance(input, str) and 'bedroom' in input:
                    return decision('assign', 'queue')
                return decision('clarify', None, {'question': 'Which room?', 'about': 'lights-on-in'})
            s = make_sessions(evaluate, d, max_rounds=2)
            first = await session_message(s, 'panel', 'turn the lights on')
            self.assertEqual(first['status'], 'passed')          # no clarify handler: it passes through
            self.assertEqual(first['final']['action'], 'clarify')
            self.assertEqual(session_pending(s, 'panel'), 'Which room?')
            second = await session_message(s, 'panel', 'the bedroom')
            self.assertEqual(second['status'], 'ran')
            self.assertEqual(second['final']['target'], 'queue')
            self.assertIsNone(session_pending(s, 'panel'))
            # The reply was merged into the original input, not sent on its own.
            self.assertRegex(asked[1], r'turn the lights on[\s\S]*Which room\?[\s\S]*the bedroom')

            # Asking forever is not an option: after maxRounds it holds and says so.
            async def stubborn_evaluate(_input):
                return decision('clarify', None, {'question': 'Which room?'})
            stubborn = make_sessions(stubborn_evaluate, d, max_rounds=1)
            await session_message(stubborn, 'panel', 'lights')
            held = await session_message(stubborn, 'panel', 'still vague')
            self.assertEqual(held['final']['action'], 'hold')
            self.assertRegex(held['final']['reason'], r'still not clear after 1 question')
            self.assertEqual(held['final']['data'], {'last_question': 'Which room?'})

            # A pending question expires, and can be forgotten.
            expiring = make_sessions(stubborn_evaluate, d, ttl=0)
            await session_message(expiring, 'panel', 'lights')
            self.assertEqual(session_pending(expiring, 'panel'), 'Which room?')
            await session_message(expiring, 'panel', 'anything')
            session_forget(expiring, 'panel')
            self.assertIsNone(session_pending(expiring, 'panel'))
        asyncio.run(run())


if __name__ == '__main__':
    unittest.main()
