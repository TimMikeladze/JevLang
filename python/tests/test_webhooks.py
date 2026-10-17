"""Webhooks, ported from src/webhooks.mjs, checked against webhooks-oracle.rkt
over the shared parity cases. The handler's HTTP goes through a fake post."""
from __future__ import annotations

import asyncio
import json
import unittest
from pathlib import Path

PACKAGES = Path(__file__).resolve().parents[2]
TS_TEST = PACKAGES / 'test'

from jevlang._webhooks import (env_secret, github_verifier, hmac_verifier, key_to_message_id,
                               redact_url, resolve_secret, slack_verifier,
                               standard_webhooks_key, standard_webhooks_sign,
                               standard_webhooks_verifier, stripe_verifier, verifier_problem,
                               webhook_handler, webhook_handler_from_spec, webhook_source,
                               case_event, outcome_event)
from tests.test_mcp import racket_available, run_racket  # noqa: E402

CASES = json.loads((TS_TEST / 'parity' / 'webhook-cases.json').read_text())
BODY = CASES['body'].encode('utf8')
NOW = CASES['now']


@unittest.skipUnless(racket_available() and TS_TEST.is_dir(), 'Racket and the monorepo are required')
class OracleTests(unittest.TestCase):
    def test_signatures_and_verifiers_answer_as_racket_does(self):
        oracle = run_racket('webhooks-oracle.rkt')
        secret = CASES['secret']
        self.assertEqual([standard_webhooks_sign(secret, id, ts, BODY)
                          for id, ts in CASES['sign']], oracle['sign'])
        keys = [list(standard_webhooks_key(s)) if standard_webhooks_key(s) is not None else None
                for s in CASES['keys']]
        self.assertEqual(keys, oracle['keys'])

        def check(verifier, entries, expected):
            answers = [verifier([(k, v) for k, v in e['headers'].items()], BODY, NOW)
                       for e in entries]
            for got, want in zip(answers, expected):
                self.assertEqual(got['ok'], want['ok'])
                self.assertEqual(got['deliveryId'], want['id'])
                self.assertEqual(got['reason'], want['reason'])

        check(standard_webhooks_verifier(secret), CASES['standard'], oracle['standard'])
        check(github_verifier('gh-secret'), CASES['github'], oracle['github'])
        check(stripe_verifier('stripe-secret'), CASES['stripe'], oracle['stripe'])
        check(slack_verifier('slack-secret'), CASES['slack'], oracle['slack'])
        hmac_expected = []
        for e, want in zip(CASES['hmac'], oracle['hmac']):
            verifier = hmac_verifier('plain-secret', header='x-signature',
                                     encoding=e['encoding'], prefix=e['prefix'],
                                     id_header=e.get('idHeader') or None)
            answer = verifier([(k, v) for k, v in e['headers'].items()], BODY, NOW)
            self.assertEqual([answer['ok'], answer['deliveryId'], answer['reason']],
                             [want['ok'], want['id'], want['reason']])
        self.assertEqual(hmac_expected, [])
        missing = standard_webhooks_verifier(env_secret('JEV_NO_SUCH_SECRET'))([], BODY, NOW)
        self.assertEqual([missing['ok'], missing['reason']],
                         [oracle['missing-secret']['ok'], oracle['missing-secret']['reason']])
        self.assertEqual([verifier_problem(standard_webhooks_verifier(env_secret('JEV_NO_SUCH_SECRET'))),
                          verifier_problem(standard_webhooks_verifier('whsec_not!base64')),
                          verifier_problem(github_verifier('gh-secret'))],
                         oracle['problems'])


class WebhookTests(unittest.TestCase):
    def test_message_ids_and_urls(self):
        self.assertEqual(key_to_message_id('plain/key-1_2:3'), 'plain/key-1_2:3')
        hashed = key_to_message_id('a key with spaces and unicode é')
        self.assertTrue(hashed.startswith('msg_'))
        self.assertEqual(key_to_message_id('a key with spaces and unicode é'), hashed)
        self.assertEqual(redact_url('https://hooks.example.com/x/y?z=1'), 'https://hooks.example.com/...')
        self.assertEqual(redact_url('not a url'), 'the webhook URL')

    def test_secrets(self):
        self.assertEqual(resolve_secret(env_secret('JEV_NO_SUCH_SECRET'))['problem'],
                         'JEV_NO_SUCH_SECRET is unset or empty')
        self.assertEqual(resolve_secret('  '), {'secret': None,
                                                'problem': 'the secret is missing or empty'})
        self.assertEqual(resolve_secret(b'bytes')['secret'], b'bytes')
        self.assertIsNone(standard_webhooks_key('whsec_%%%'))

    def test_a_delivery_is_signed_and_retried(self):
        seen = []

        async def post(url, body, headers, timeout_seconds):
            seen.append((url, body, headers))
            if len(seen) == 1:
                raise OSError('refused')
            if len(seen) == 2:
                return 429, 'slow down', 0
            return 200, 'ok', None

        handler = webhook_handler('https://receive.example/hook', secret='a-secret',
                                  attempts=3, post=post, now=lambda: 1700000000,
                                  sleep=_no_sleep)
        decision = {'action': 'assign', 'target': 'billing-queue', 'reason': 'billing',
                    'rule': 'route', 'clause': 1, 'readings': []}
        result = asyncio.run(handler({'ticket': 'x'}, decision, {'key': 'case-1'}))
        self.assertEqual(result['attempts'], 3)
        self.assertEqual(result['webhook_id'], 'case-1')
        first_headers = seen[0][2]
        self.assertEqual(first_headers['User-Agent'], 'jev-webhooks')
        self.assertTrue(first_headers['webhook-signature'].startswith('v1,'))
        # The signature verifies over exactly what was sent.
        want = standard_webhooks_sign(b'a-secret', first_headers['webhook-id'],
                                      first_headers['webhook-timestamp'], seen[0][1])
        self.assertEqual(first_headers['webhook-signature'], want)
        # Not retried when the receiver answers anything else.
        async def bad_post(url, body, headers, timeout_seconds):
            return 403, 'no', None
        strict = webhook_handler('https://receive.example/hook', secret='s', attempts=3,
                                 post=bad_post, now=lambda: 1700000000, sleep=_no_sleep)
        with self.assertRaises(Exception) as raised:
            asyncio.run(strict({}, decision, None))
        self.assertIn('not retried', str(raised.exception))

    def test_a_handlers_file_spec_builds_the_handler(self):
        import os
        os.environ['JEV_TEST_WEBHOOK_SECRET'] = 'whsec-plain'
        handler = webhook_handler_from_spec({'type': 'webhook', 'url': 'https://x.example/hook',
                                             'secret_env': 'JEV_TEST_WEBHOOK_SECRET'})
        self.assertEqual(handler.handlerName, 'webhook https://x.example/...')
        with self.assertRaises(Exception) as raised:
            webhook_handler_from_spec({'type': 'webhook', 'url': 'https://x.example/hook',
                                       'secret_env': 'MISSING_VAR'})
        self.assertIn('MISSING_VAR', str(raised.exception))
        with self.assertRaises(Exception) as raised2:
            webhook_handler_from_spec({'type': 'webhook', 'url': 'https://x.example/hook',
                                       'secret_env': 'JEV_TEST_WEBHOOK_SECRET', 'stray': 1})
        self.assertIn('stray', str(raised2.exception))

    def test_sources_and_events(self):
        source = webhook_source('tickets', verify=standard_webhooks_verifier('s'),
                                event=lambda json_value, headers: case_event('t1', json_value))
        self.assertEqual(source['name'], 'tickets')
        with self.assertRaises(Exception):
            webhook_source('bad name!', event=lambda j, h: None)
        self.assertEqual(case_event(None, {'x': 1}), {'kind': 'case', 'id': None, 'input': {'x': 1}})
        self.assertEqual(outcome_event('t1', kind='close'),
                         {'kind': 'outcome', 'id': 't1', 'outcomeKind': 'close',
                          'label': None, 'labels': None})


async def _no_sleep(seconds: float) -> None:
    pass


if __name__ == '__main__':
    unittest.main()
