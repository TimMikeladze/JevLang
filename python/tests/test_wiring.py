"""The webhook wiring runtime, ported from src/wiring.mjs: the accept answers,
the spool, dedupe, one case at a time, failures moved to failed/, shadow."""
from __future__ import annotations

import asyncio
import json
import os
import tempfile
import unittest
from pathlib import Path

from jevlang._webhooks import (case_event, hmac_verifier, outcome_event,
                               standard_webhooks_verifier, webhook_source)
from jevlang._wiring import jev_wiring, start_wiring, wiring_problems

SECRET = 'whsec-cycled-secret'
NOW = {'t': 1800000000}


def now():
    return NOW['t']


def signed_body(body: bytes, at: int, key: bytes = b'cycled-key') -> dict:
    import hashlib
    import hmac as hmac_mod
    digest = hmac_mod.new(key, body, hashlib.sha256).hexdigest()
    return {'x-signature': digest}


def verifier():
    return hmac_verifier(b'cycled-key', header='x-signature')


def decide_of(answers, decision):
    def evaluate(input_value):
        return {'decision': {**decision}, 'answers': answers, 'questions': {},
                'fixture': None, 'state': None, 'facts': None}
    return evaluate


class WiringTests(unittest.TestCase):
    def test_problems_refuse_unsigned_sources(self):
        source = webhook_source('tickets', event=lambda j, h: None)
        problems = wiring_problems(jev_wiring(spool='/tmp/x', sources=[source],
                                              evaluate=lambda i: None))
        self.assertIn('has no verifier', problems[0])
        self.assertEqual(wiring_problems(jev_wiring(
            spool='/tmp/x',
            sources=[webhook_source('t', verify='none', insecure=True, event=lambda j, h: None)],
            evaluate=lambda i: None)), [])
        self.assertIn('needs insecure: true', wiring_problems(jev_wiring(
            spool='/tmp/x', sources=[webhook_source('t', verify='none', event=lambda j, h: None)],
            evaluate=lambda i: None))[0])
        self.assertIn('refusing to start', wiring_problems(jev_wiring(
            spool='/tmp/x',
            sources=[webhook_source('t', verify=standard_webhooks_verifier('whsec_%%bad'),
                                    event=lambda j, h: None)],
            evaluate=lambda i: None))[0])

    def test_accept_answers_in_order(self):
        with tempfile.TemporaryDirectory() as spool:
            decided = []
            source = webhook_source('tickets', verify=verifier(),
                                    event=lambda body, headers: case_event(body['id'], body))
            w = jev_wiring(spool=spool, sources=[source],
                           evaluate=lambda i: decided.append(i) or {
                               'decision': {'action': 'assign', 'target': 'q'},
                               'answers': {}, 'questions': {}, 'fixture': None,
                               'state': None, 'facts': None})

            async def run():
                runtime = await start_wiring(w, None, now=now, start_workers=False)
                body = json.dumps({'id': 't-1'}).encode('utf8')
                headers = signed_body(body, now())
                self.assertEqual((await runtime['accept']('/webhook/nowhere', {}, body))['status'], 404)
                rejected = await runtime['accept']('/webhook/tickets', {}, body)
                self.assertEqual(rejected['status'], 401)
                self.assertEqual(rejected['body']['kind'], 'signature')
                bad = await runtime['accept']('/webhook/tickets', signed_body(b'not json', now()), b'not json')
                self.assertEqual((bad['status'], bad['body']['kind']), (400, 'request'))
                first = await runtime['accept']('/webhook/tickets', headers, body)
                self.assertEqual(first['status'], 202)
                self.assertEqual(first['body'], {'accepted': True, 'id': first['body']['id'],
                                                 'events': 1})
                duplicate = await runtime['accept']('/webhook/tickets', headers, body)
                self.assertEqual(duplicate['body'], {'duplicate': True, 'id': first['body']['id']})
                await runtime['drain']()
                self.assertEqual(decided, [{'id': 't-1'}])
                self.assertFalse(os.listdir(os.path.join(spool, 'queue')))
                await runtime['stop']()
                # The delivery id is the body's SHA-256, and the marker exists.
                import hashlib
                marker = hashlib.sha256(first['body']['id'].encode('utf8')).hexdigest()
                self.assertTrue(os.path.exists(os.path.join(spool, 'seen', 'tickets', marker)))
                self.assertEqual(runtime['stats']['accepted'], 1)
                self.assertEqual(runtime['stats']['duplicate'], 1)
                self.assertEqual(runtime['stats']['decided'], 1)

            asyncio.run(run())

    def test_an_ignored_or_failing_adapter(self):
        with tempfile.TemporaryDirectory() as spool:
            quiet = webhook_source('quiet', verify='none', insecure=True,
                                   event=lambda j, h: None)
            def boom_event(j, h):
                raise ValueError('jev: bad adapter')

            boom = webhook_source('boom', verify='none', insecure=True, event=boom_event)
            w = jev_wiring(spool=spool, sources=[quiet, boom], evaluate=lambda i: None)

            async def run():
                runtime = await start_wiring(w, None, now=now, start_workers=False)
                ignored = await runtime['accept']('/webhook/quiet', {}, b'{}')
                self.assertEqual(ignored['body'], {'ignored': True, 'id': ignored['body']['id']})
                failed = await runtime['accept']('/webhook/boom', {}, b'{}')
                self.assertEqual(failed['status'], 500)
                self.assertEqual(failed['body']['kind'], 'adapter')
                self.assertIn('raised: bad adapter', failed['body']['error'])
                await runtime['stop']()

            asyncio.run(run())

    def test_processing_records_fixtures_harvests_and_shadows(self):
        with tempfile.TemporaryDirectory() as spool, \
                tempfile.TemporaryDirectory() as records, \
                tempfile.TemporaryDirectory() as harvest:
            seen = []

            def evaluate(input_value):
                seen.append(input_value)
                from tests.test_harvest import capture_case
                case = capture_case()
                case['decision'] = {'action': 'assign', 'target': 'billing-queue'}
                return case

            source = webhook_source('tickets', verify='none', insecure=True,
                                    event=lambda j, h: case_event(j['id'], {'ticket': 'x'}))
            from tests.test_local import ticket_policy
            from jevlang._engine import CompiledPolicy
            shadow = CompiledPolicy(ticket_policy().to_json())
            w = jev_wiring(spool=spool, sources=[source], evaluate=evaluate,
                           record_dir=records, harvest=harvest, shadow=shadow)

            async def run():
                runtime = await start_wiring(w, None, now=now, start_workers=False)
                got = await runtime['accept']('/webhook/tickets', {}, json.dumps(
                    {'id': 'case-9'}).encode('utf8'))
                self.assertEqual(got['status'], 202)
                outcome = await runtime['accept']('/webhook/tickets', {}, json.dumps(
                    {'outcome': 'close', 'id': 'case-9'}).encode('utf8'))
                # Nothing matched the event adapter, so both were ignored.

                await runtime['stop']()
                source2 = webhook_source('tickets', verify='none', insecure=True,
                                         event=lambda j, h: (
                                             outcome_event(j['id'], kind=j['outcome'])
                                             if j.get('outcome') else case_event(j['id'], j)))
                w['sources'] = [source2]
                runtime2 = await start_wiring(w, None, now=now, start_workers=False)
                body = json.dumps({'id': 'case-9', 'phase': 2}).encode('utf8')
                await runtime2['accept']('/webhook/tickets', {}, body)
                out_body = json.dumps({'id': 'case-9', 'outcome': 'close', 'phase': 2}).encode('utf8')
                await runtime2['accept']('/webhook/tickets', {}, out_body)
                await runtime2['drain']()
                lines = '\n'.join(runtime2['lines'])
                self.assertIn('webhook tickets case-9: assign billing-queue', lines)
                self.assertIn('recorded', lines)
                self.assertIn('pending', lines)
                self.assertIn('close -> labeled', lines)
                self.assertIn('shadow agrees', lines)
                self.assertEqual(len(list(Path(records).glob('*.json'))), 1)
                self.assertTrue(list(Path(harvest, 'labeled').glob('*.json')))
                await runtime2['stop']()

            asyncio.run(run())

    def test_one_case_at_a_time_so_an_outcome_cannot_overtake(self):
        with tempfile.TemporaryDirectory() as spool:
            order = []

            def evaluate(input_value):
                order.append('case')
                return {'decision': {'action': 'assign', 'target': 'q'}, 'answers': {},
                        'questions': {}, 'fixture': None, 'state': None, 'facts': None}

            events = [case_event('c1', {}), outcome_event('c1', kind='close')]

            def adapter(body, headers):
                return events[body.get('i', 0)]

            source = webhook_source('s', verify='none', insecure=True, event=adapter)
            w = jev_wiring(spool=spool, sources=[source], evaluate=evaluate, workers=1)

            async def run():
                runtime = await start_wiring(w, None, now=now, start_workers=False)
                await runtime['accept']('/webhook/s', {}, json.dumps({'i': 1}).encode('utf8'))
                await runtime['accept']('/webhook/s', {}, json.dumps({'i': 0}).encode('utf8'))
                # The outcome arrived first, but the case is decided first.
                await runtime['drain']()
                self.assertEqual(runtime['stats']['decided'], 1)
                await runtime['stop']()

            asyncio.run(run())

    def test_a_failed_case_moves_to_failed_with_the_error(self):
        with tempfile.TemporaryDirectory() as spool:
            def evaluate(input_value):
                raise ValueError('jev: the policy did not load')

            source = webhook_source('s', verify='none', insecure=True,
                                    event=lambda j, h: case_event('bad', {}))
            w = jev_wiring(spool=spool, sources=[source], evaluate=evaluate)

            async def run():
                runtime = await start_wiring(w, None, now=now, start_workers=False)
                await runtime['accept']('/webhook/s', {}, b'{}')
                await runtime['drain']()
                failed = list(Path(spool, 'failed').glob('*.json'))
                self.assertEqual(len(failed), 1)
                record = json.loads(failed[0].read_text())
                self.assertEqual(record['error'], 'jev: the policy did not load')
                self.assertIn('failed_at', record)
                self.assertFalse(list(Path(spool, 'queue').glob('*.json')))
                self.assertEqual(runtime['stats']['failed'], 1)
                await runtime['stop']()

            asyncio.run(run())

    def test_the_summary_names_every_piece(self):
        source = webhook_source('s', verify='none', insecure=True, event=lambda j, h: None)
        w = jev_wiring(spool='/tmp/jev-wiring-summary', sources=[source],
                       evaluate=lambda i: None, workers=1)
        with tempfile.TemporaryDirectory() as spool:
            w['spool'] = spool

            async def run():
                runtime = await start_wiring(w, None, now=now, start_workers=False)
                self.assertIn('no handlers: decisions are recorded, not dispatched',
                              runtime['summary'])
                self.assertIn('no harvest store', runtime['summary'])
                self.assertIn('1 worker', runtime['summary'])
                await runtime['stop']()

            asyncio.run(run())


if __name__ == '__main__':
    unittest.main()
