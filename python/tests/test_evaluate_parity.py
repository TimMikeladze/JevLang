"""The evaluate layer, natively: the answer schema and prompt against the
Racket oracle, the TypeSafe call and its retry policy against a fake transport
and a loopback HTTP server, evaluate with provenance against a fake provider,
and fixture recording. No network; the one differential against the TypeScript
engine's fixture output skips when Node is absent."""
from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from jevlang import Policy, choice, score, noul, gate, rule, all_of, assign, escalate, page
from jevlang import _evaluate as evaluate
from jevlang import _provider as provider
from jevlang._numberfmt import canonical

PACKAGES = Path(__file__).resolve().parents[2]
TS = PACKAGES
ORACLE = TS / 'test' / 'evaluate-oracle.rkt'
SCENARIOS = None

ANSWERS = {
    'department': {'type': 'choice', 'choice': 'billing', 'confidence': 0.93,
                   'probabilities': {'billing': 0.93, 'technical': 0.05, 'sales': 0.02}},
    'frustration': {'type': 'score', 'score': 0.4, 'confidence': 0.9,
                    'probabilities': {'0': 0.7, '1': 0.2, '2': 0.1}},
    'refund-requested?': {'type': 'noul', 'noul': 0.2},
}

_NODE_FOUND = shutil.which(os.environ.get('JEV_NODE', 'node'))
NODE = _NODE_FOUND or 'node'


def _racket_available() -> bool:
    return shutil.which('racket') is not None and ORACLE.is_file()


def _node_available() -> bool:
    return _NODE_FOUND is not None and TS.is_dir()


def ticket_policy() -> Policy:
    department = choice('department', 'Which team should handle this ticket?', {
        'billing': 'Payments, invoicing, refunds, payouts, card failures',
        'technical': 'Bugs, outages, API errors, integration problems',
        'sales': 'Pricing, upgrades, quotas, new accounts',
    })
    frustration = score('frustration', 'How frustrated is the customer?', [
        'Calm and matter-of-fact', 'Annoyed but polite', 'Angry, threatening to leave',
    ])
    refund = noul('refund-requested?', 'Is the customer asking for money back?', criteria={
        'true': 'Explicitly asks for a refund, credit, or chargeback',
        'false': 'No mention of getting money back',
    })
    return Policy(name='ticket-router', questions=[department, frustration, refund],
                  state={'ticket': {'path': []}}, gates=[
                      gate(department, 0.8, escalate('human-triage', reason='unclear which team owns this')),
                      gate(frustration, 0.7, escalate('human-triage', reason='unclear how upset they are')),
                  ], route={'clauses': [
                      rule(all_of(refund.yes(0.8), frustration.most_likely('Angry, threatening to leave')),
                           page('retention-oncall', reason='angry refund request')),
                      rule(department.is_('billing'), assign('billing-queue')),
                      rule(department.is_('technical'), assign('engineering-oncall')),
                      rule(department.is_('sales'), assign('sales-inbox')),
                  ]})


def restore():
    async def fast_sleep(seconds):
        await asyncio.sleep(min(seconds, 0.01))
    evaluate.settings.transport = None
    evaluate.settings.api_key = None
    evaluate.settings.base_url = None
    evaluate.settings.sleep = fast_sleep
    evaluate.settings.clock = lambda: __import__('time').time() * 1000
    evaluate.settings.random = lambda: 0
    evaluate.settings.pacer = None
    evaluate.settings.on_retry_after = None
    evaluate.settings.on_usage = None
    evaluate.settings.extra_body = None
    evaluate.settings.environment = lambda name: {'TYPESAFE_API_KEY': 'test-key'}.get(name)


def prompt_parts(prompt: str) -> dict:
    match = re.match(r'^([\s\S]*?)<jev-state>\n([\s\S]*?)\n</jev-state>\n\n<jev-questions>\n([\s\S]*?)\n</jev-questions>$', prompt)
    return {'head': match.group(1), 'state': json.loads(match.group(2)), 'questions': json.loads(match.group(3))}


class Loopback:
    def __init__(self, handler):
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f'http://127.0.0.1:{self.server.server_port}'

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)


@unittest.skipUnless(_racket_available(), 'Racket and the monorepo are required')
class OracleTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        env = dict(os.environ, TYPESAFE_API_KEY='', ANTHROPIC_API_KEY='', OPENAI_API_KEY='',
                   JEV_PROVIDER='', JEV_MODEL='', JEV_EFFORT='')
        run = subprocess.run(['racket', str(ORACLE)], encoding='utf8', capture_output=True, env=env)
        assert run.returncode == 0, run.stderr
        cls.expected = json.loads(run.stdout)

    def test_the_answer_schema_and_the_prompt_match_racket(self):
        for key in ('ticket', 'smart-home'):
            parts = prompt_parts(self.expected[key]['prompt'])
            self.assertEqual(evaluate.questions_answer_schema(parts['questions']), self.expected[key]['schema'])
            again = evaluate.policy_prompt(parts['state'], parts['questions'])
            self.assertEqual(prompt_parts(again), parts)


class ClientTests(unittest.TestCase):
    def setUp(self):
        restore()

    def tearDown(self):
        restore()

    def test_the_call_sends_state_model_and_questions(self):
        sent = []

        async def transport(payload):
            sent.append(payload)
            return {'answers': ANSWERS, 'model': 'jev-1.13.0', 'usage': {'input_tokens': 1044}, 'request_id': 'req_x'}

        evaluate.settings.transport = transport
        response = asyncio.run(evaluate.jev_call({'ticket': 'a ticket'}, ticket_policy().questions(), model='jev-1.13.0'))
        self.assertEqual(sorted(sent[0]), ['model', 'questions', 'state'])
        self.assertEqual(sent[0]['model'], 'jev-1.13.0')
        self.assertEqual(response['model'], 'jev-1.13.0')
        self.assertEqual(response['requestedModel'], 'jev-1.13.0')
        self.assertEqual(response['usage'], {'input_tokens': 1044})

        evaluate.settings.extra_body = {'trace': 'abc'}

        async def empty(payload):
            sent.append(payload)
            return {'answers': {}, 'model': 'm'}
        evaluate.settings.transport = empty
        asyncio.run(evaluate.jev_call({}, {}))
        self.assertEqual(sent[1]['trace'], 'abc')
        evaluate.settings.extra_body = {'model': 'other'}
        with self.assertRaisesRegex(Exception, "extraBody cannot set 'model'"):
            asyncio.run(evaluate.jev_call({}, {}))

    def test_http_failures_are_classified_and_retried(self):
        state = {'calls': 0}

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                self.rfile.read(int(self.headers.get('Content-Length') or 0))
                state['calls'] += 1
                if self.path != '/v1/systemone':
                    self.send_response(404)
                    self.end_headers()
                    self.wfile.write(b'nothing here')
                    return
                if state['calls'] == 1:
                    self.send_response(429)
                    self.send_header('retry-after-ms', '5')
                    self.send_header('x-typesafe-request-id', 'req_429')
                    self.end_headers()
                    self.wfile.write(b'{"error":"slow down"}')
                    return
                body = json.dumps({'answers': ANSWERS, 'model': 'jev-1.13.0', 'usage': {'input_tokens': 9}}).encode()
                self.send_response(200)
                self.send_header('content-type', 'application/json')
                self.send_header('x-typesafe-request-id', 'req_ok')
                self.send_header('content-length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        server = Loopback(Handler)
        try:
            evaluate.settings.base_url = server.url
            waits = []
            evaluate.settings.on_retry_after = waits.append
            response = asyncio.run(evaluate.jev_call({'ticket': 'x'}, ticket_policy().questions()))
            self.assertEqual(state['calls'], 2)
            self.assertEqual(response['requestId'], 'req_ok')
            self.assertEqual(waits, [0.005])
        finally:
            server.close()

        class Unauthorized(BaseHTTPRequestHandler):
            def do_POST(self):
                self.rfile.read(int(self.headers.get('Content-Length') or 0))
                self.send_response(401)
                self.end_headers()
                self.wfile.write(b'{"error":"bad key"}')

            def log_message(self, *args):
                pass

        server = Loopback(Unauthorized)
        try:
            evaluate.settings.base_url = server.url
            with self.assertRaises(evaluate.JevApiError) as caught:
                asyncio.run(evaluate.jev_call({}, {}, retry=dict(evaluate.DEFAULT_RETRY_POLICY)))
            self.assertEqual(caught.exception.kind, 'auth')
            self.assertEqual(caught.exception.status, 401)
            self.assertRegex(caught.exception.message, 'check TYPESAFE_API_KEY')
        finally:
            server.close()

        class Garbage(BaseHTTPRequestHandler):
            def do_POST(self):
                self.rfile.read(int(self.headers.get('Content-Length') or 0))
                self.send_response(200)
                self.send_header('content-type', 'text/plain')
                self.end_headers()
                self.wfile.write(b'not json at all')

            def log_message(self, *args):
                pass

        server = Loopback(Garbage)
        try:
            evaluate.settings.base_url = server.url
            with self.assertRaises(evaluate.JevApiError) as caught:
                asyncio.run(evaluate.jev_call({}, {}))
            self.assertEqual(caught.exception.kind, 'response')
            self.assertRegex(caught.exception.message, 'is not JSON')
        finally:
            server.close()

        class NoAnswers(BaseHTTPRequestHandler):
            def do_POST(self):
                self.rfile.read(int(self.headers.get('Content-Length') or 0))
                body = b'{"model":"m"}'
                self.send_response(200)
                self.send_header('content-type', 'application/json')
                self.send_header('content-length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        server = Loopback(NoAnswers)
        try:
            evaluate.settings.base_url = server.url
            with self.assertRaisesRegex(Exception, "no 'answers' object"):
                asyncio.run(evaluate.jev_call({}, {}))
        finally:
            server.close()


class EvaluateTests(unittest.TestCase):
    def setUp(self):
        restore()

    def tearDown(self):
        restore()

    def _registry(self):
        registry = provider.ProviderRegistry()
        registry.register(evaluate.typesafe_provider())
        provider.clear_provider_discovery_cache(registry)
        return registry

    def test_evaluate_builds_state_asks_validates_and_decides(self):
        async def transport(payload):
            return {'answers': ANSWERS, 'model': 'jev-1.13.0', 'usage': {'input_tokens': 44}, 'request_id': 'req_eval'}
        evaluate.settings.transport = transport
        registry = self._registry()
        config = provider.merge_provider_config(project={'provider': 'typesafe', 'model': 'jev-1.13.0'})
        decision = asyncio.run(evaluate.evaluate_with_provider(
            ticket_policy(), {'ticket': 'I want a refund'}, config=config, registry=registry))
        self.assertEqual(decision['target'], 'billing-queue')
        self.assertEqual(decision['provider'], 'typesafe')
        self.assertEqual(decision['requested_model'], 'jev-1.13.0')
        self.assertEqual(decision['model'], 'jev-1.13.0')
        self.assertEqual(decision['request_id'], 'req_eval')
        self.assertEqual([r['question'] for r in decision['readings']], ['department'])

        async def bad(payload):
            return {'answers': {'department': {'type': 'choice', 'choice': 'nope', 'confidence': 0.9}}, 'model': 'm'}
        evaluate.settings.transport = bad
        with self.assertRaises(provider.ProviderError) as caught:
            asyncio.run(evaluate.evaluate_with_provider(
                ticket_policy(), {'ticket': 'x'}, config=config, registry=registry))
        self.assertEqual(caught.exception.kind, 'unavailable')
        self.assertRegex(str(caught.exception.detail), 'not a declared option')

    def test_a_missing_key_means_no_configured_decision(self):
        evaluate.settings.environment = lambda name: None
        registry = self._registry()
        empty = tempfile.mkdtemp(prefix='jev-empty-')
        self.assertIsNone(asyncio.run(evaluate.evaluate_configured_policy(
            ticket_policy(), {'ticket': 'x'}, registry=registry, start=empty)))
        with self.assertRaises(provider.ProviderError) as caught:
            asyncio.run(evaluate.evaluate_configured_policy(
                ticket_policy(), {'ticket': 'x'}, registry=registry, provider='typesafe', start=empty))
        self.assertEqual(caught.exception.kind, 'unavailable')

    def test_any_executable_can_answer_and_the_run_records_a_replayable_fixture(self):
        directory = tempfile.mkdtemp(prefix='jev-answerer-')
        executable = os.path.join(directory, 'answer-provider')
        with open(executable, 'w', encoding='utf-8') as handle:
            handle.write(
                '#!/usr/bin/env python3\n'
                'import json, sys\n'
                'request = json.load(sys.stdin)\n'
                'answers = {}\n'
                'for id, q in request["metadata"]["questions"].items():\n'
                '    if q["type"] == "choice":\n'
                '        key = sorted(q["criteria"])[0]\n'
                '        answers[id] = {"type": "choice", "choice": key, "confidence": 0.95, "probabilities": {key: 0.95}}\n'
                '    elif q["type"] == "score":\n'
                '        answers[id] = {"type": "score", "score": 0, "confidence": 0.95,\n'
                '                       "probabilities": {str(i): (0.9 if i == 0 else 0.05) for i in range(len(q["criteria"]))}}\n'
                '    else:\n'
                '        answers[id] = {"type": "noul", "noul": 0.02}\n'
                'json.dump({"output": answers, "model": "fake-answerer", "usage": {"input_tokens": 3},\n'
                '           "cost": {"mode": "subscription"}}, sys.stdout)\n')
        os.chmod(executable, 0o755)
        original = provider.environment_reader.get

        def get(name):
            if name == 'PATH':
                return os.pathsep.join([directory, os.environ.get('PATH', '')])
            return original(name)
        provider.environment_reader.get = get
        try:
            registry = provider.ProviderRegistry()
            registry.register(provider.command_provider('answerer', 'answer-provider',
                                                        caps=provider.capabilities(efforts=['low'])))
            provider.clear_provider_discovery_cache(registry)
            config = provider.merge_provider_config(project={'provider': 'answerer'})
            policy = ticket_policy()
            decision = asyncio.run(evaluate.evaluate_with_provider(
                policy, {'ticket': 'I want a refund'}, config=config, registry=registry))
            self.assertEqual(decision['provider'], 'answerer')
            self.assertEqual(decision['model'], 'fake-answerer')

            from jevlang._engine import CompiledPolicy
            compiled = CompiledPolicy(policy.to_json())
            built = compiled.build_state({'ticket': 'I want a refund'})
            state, facts = built['state'], built['facts']
            questions = compiled.questions(state)
            result = asyncio.run(evaluate.run_policy_provider(state, questions, config=config, registry=registry))
            fixture = evaluate.fixture_from_run(name='refund', policy=compiled, state=state,
                                                questions=questions, decision=decision, result=result)
            self.assertEqual(fixture['fixture_version'], 3)
            self.assertEqual(fixture['provider'], 'answerer')
            self.assertEqual(fixture['questions_sha256'], compiled.identity())
            rows = policy.replay([fixture])
            self.assertEqual(rows[0]['status'], 'pass')
            self.assertEqual(rows[0]['verifiedBy'], 'questions')
        finally:
            provider.environment_reader.get = original


@unittest.skipUnless(_node_available(), 'Node and the monorepo are required')
class FixtureDifferentialTests(unittest.TestCase):
    def test_fixture_from_run_matches_the_typescript_engine(self):
        script = (
            "import { fixtureFromRun } from './src/evaluate.js';\n"
            "import { compile } from './src/engine.js';\n"
            "let raw = '';\n"
            "process.stdin.on('data', c => { raw += c; });\n"
            "process.stdin.on('end', () => {\n"
            "  const input = JSON.parse(raw);\n"
            "  const policy = compile(input.policy);\n"
            "  const result = { output: input.output,\n"
            "    target: { provider: { id: input.providerId }, model: input.model, requestedEffort: null, effectiveEffort: null },\n"
            "    model: input.model, usage: input.usage, cost: { mode: 'subscription', usd: null },\n"
            "    requestId: 'req_diff', exitStatus: 0, changed: [], attempts: [] };\n"
            "  const fixture = fixtureFromRun({ name: input.name, policy, state: input.state,\n"
            "    questions: input.questions, decision: input.decision, result, synthetic: true });\n"
            "  delete fixture.recorded_at;\n"
            "  console.log(JSON.stringify(fixture));\n"
            "});\n"
        )
        policy = ticket_policy()
        compiled_policy = policy.to_json()
        decision = policy.decide(ANSWERS)
        payload = json.dumps({'policy': compiled_policy, 'output': ANSWERS, 'providerId': 'answerer',
                              'model': 'fake-answerer', 'usage': {'input_tokens': 3},
                              'name': 'diff-fixture', 'state': {'ticket': 'x'},
                              'questions': policy.questions(), 'decision': decision})
        result = subprocess.run([NODE, '--input-type=module', '-e', script], input=payload,
                                encoding='utf8', capture_output=True, cwd=str(TS), timeout=120)
        self.assertEqual(result.returncode, 0, result.stderr)
        expected = json.loads(result.stdout)

        from jevlang._engine import CompiledPolicy
        compiled = CompiledPolicy(compiled_policy)
        fixture = evaluate.fixture_from_run(name='diff-fixture', policy=compiled, state={'ticket': 'x'},
                                            questions=compiled.questions({'ticket': 'x'}), decision=decision,
                                            result={'output': ANSWERS,
                                                    'target': {'provider': provider.Provider('answerer', provider.capabilities(), None, None),
                                                               'model': 'fake-answerer', 'requestedEffort': None, 'effectiveEffort': None},
                                                    'model': 'fake-answerer', 'usage': {'input_tokens': 3},
                                                    'cost': {'mode': 'subscription', 'usd': None},
                                                    'requestId': 'req_diff', 'exitStatus': 0, 'changed': [], 'attempts': []},
                                            synthetic=True)
        fixture.pop('recorded_at', None)
        self.assertEqual(canonical(fixture), canonical(expected))


if __name__ == '__main__':
    unittest.main()
