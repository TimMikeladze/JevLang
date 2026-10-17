"""Provider routing and the jev-provider/1 executable protocol, natively.

The routing scenarios and the shared parity file are the same ones the
TypeScript suite and the Racket oracle use, so all three implementations are
pinned to one expectation. The fake executables are Python scripts: no Node is
needed or used anywhere in this file."""
from __future__ import annotations

import asyncio
import json
import os
import shutil
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

from jevlang import _provider as provider

PACKAGES = Path(__file__).resolve().parents[2]
SCENARIOS = PACKAGES / 'test' / 'parity' / 'routing-scenarios.json'
ORACLE = PACKAGES / 'test' / 'routing-oracle.rkt'
COMMAND_ORACLE = PACKAGES / 'test' / 'command-oracle.rkt'


def _racket_available() -> bool:
    return ORACLE.is_file() and shutil.which('racket') is not None and SCENARIOS.is_file()


def _racket(oracle: Path, *args: str):
    env = dict(os.environ, TYPESAFE_API_KEY='', ANTHROPIC_API_KEY='', OPENAI_API_KEY='',
               JEV_PROVIDER='', JEV_MODEL='', JEV_EFFORT='')
    return subprocess.run(['racket', str(oracle), *args], encoding='utf8', capture_output=True, env=env)


def stub(entry: dict) -> provider.Provider:
    state = entry.get('availability') or {}

    async def discover():
        return provider.availability(state.get('status', 'ready'), detail=state.get('detail'))

    async def run(request, target):
        raise RuntimeError('the scenarios never run a provider')

    return provider.Provider(entry['id'], provider.capabilities(
        **{k: v for k, v in (entry.get('caps') or {}).items()}), discover, run)


def scenario_config(s: dict) -> dict:
    layers = s.get('layers') or {}
    return provider.merge_provider_config(
        defaults=layers.get('default') or {}, user=layers.get('user') or {}, project=layers.get('project') or {},
        pkg=layers.get('package') or {}, environment=layers.get('environment') or {},
        request=layers.get('request') or {}, role=s.get('role'))


def scenario_request(r: dict) -> dict:
    target = r.get('target') or {}
    return provider.provider_request(r['operation'], r['mode'],
                                     role=r.get('role', r['operation']), kind=r.get('kind'), tier=r.get('tier'),
                                     modalities=r.get('modalities') or ['text'], permissions=r.get('permissions') or ['read'],
                                     schema=r.get('schema'), metadata=r.get('metadata') or {},
                                     target=provider.target_spec({'provider': target.get('provider'),
                                                                  'model': target.get('model'),
                                                                  'effort': target.get('effort'),
                                                                  'fallback': target.get('fallback') or []}))


def project_target(t: dict) -> dict:
    return {'provider': t['provider'].id, 'model': t.get('model') or None,
            'requested_effort': t.get('requestedEffort') or None, 'effective_effort': t.get('effectiveEffort') or None,
            'sources': t['sources']}


def project_rejection(r: dict) -> dict:
    return {'provider': str(r['provider']), 'kind': str(r['kind']),
            'detail': r['detail'] if isinstance(r['detail'], str) else None}


def script(body: str, name: str = 'fake-provider') -> str:
    directory = tempfile.mkdtemp(prefix='jev-provider-')
    path = os.path.join(directory, name)
    with open(path, 'w', encoding='utf-8') as handle:
        handle.write('#!/usr/bin/env python3\n' + body + '\n')
    os.chmod(path, 0o755)
    return path


class PathOverride:
    def __init__(self, directories):
        self.directories = directories
        self._original = None

    def __enter__(self):
        self._original = provider.environment_reader.get

        def get(name, _original=self._original, _dirs=tuple(self.directories)):
            if name == 'PATH':
                return os.pathsep.join([*_dirs, os.environ.get('PATH', '')])
            return _original(name)
        provider.environment_reader.get = get
        return self

    def __exit__(self, *exc):
        provider.environment_reader.get = self._original


@unittest.skipUnless(_racket_available(), 'Racket and the monorepo are required')
class RoutingScenariosTests(unittest.TestCase):
    def test_resolution_matches_the_racket_oracle(self):
        run = _racket(ORACLE)
        self.assertEqual(run.returncode, 0, run.stderr)
        expected = json.loads(run.stdout)
        scenarios = json.loads(SCENARIOS.read_text(encoding='utf-8'))
        self.assertEqual(len(scenarios), len(expected))
        for s, want in zip(scenarios, expected):
            name = s['name']
            self.assertEqual(want['name'], name)
            registry = provider.ProviderRegistry()
            for entry in s['providers']:
                registry.register(stub(entry))
            provider.clear_provider_discovery_cache(registry)
            exclude = [{'provider': registry.get(id), 'model': None, 'effectiveEffort': None}
                       for id in s.get('exclude') or []]
            try:
                resolution = asyncio.run(provider.resolve_provider(scenario_request(s['request']),
                                                                   scenario_config(s), registry, exclude=exclude))
                self.assertFalse(want.get('error'), f'{name}: expected an error')
                self.assertEqual(project_target(resolution['target']), want['target'], name)
                self.assertEqual([project_rejection(r) for r in resolution['rejections']],
                                 want['rejections'], f'{name}: rejections')
                self.assertEqual(resolution['matchedRoute'] if resolution['matchedRoute'] is not None else None,
                                 want['matched_route'], f'{name}: route')
            except provider.ProviderError as error:
                self.assertTrue(want.get('error'), f'{name}: unexpected {error.message}')
                self.assertEqual(error.kind, want['error']['kind'], name)
                self.assertEqual(error.message, want['error']['message'], name)
                detail = error.detail if isinstance(error.detail, list) else []
                self.assertEqual([project_rejection(r) for r in detail], want['error']['rejections'],
                                 f'{name}: rejections')


class CommandProviderTests(unittest.TestCase):
    def test_a_custom_executable_speaks_jev_provider_1(self):
        path = script(
            "import json, sys\n"
            "request = json.load(sys.stdin)\n"
            "json.dump({'output': {'verdict': 'ok', 'saw': request['protocol'], 'effort': request['effort'],\n"
            "         'model': request['model'], 'prompt': request['prompt']},\n"
            "         'model': request['model'], 'usage': {'input_tokens': 11},\n"
            "         'cost': {'mode': 'subscription', 'usd': None},\n"
            "         'provider_request_id': 'req_1', 'changed': ['a.txt']}, sys.stdout)")
        with PathOverride([os.path.dirname(path)]):
            registry = provider.ProviderRegistry()
            registry.register(provider.command_provider('fake', 'fake-provider',
                                                        caps=provider.capabilities(efforts=['low', 'high'])))
            provider.clear_provider_discovery_cache(registry)
            config = provider.merge_provider_config(project={'provider': 'fake', 'model': 'fake-1', 'effort': 'high'})
            request = provider.provider_request('review', 'structured', prompt='look at this',
                                                schema={'type': 'object', 'required': ['verdict']})
            result = asyncio.run(provider.run_provider_request(request, config, registry))
            self.assertEqual(result['output'], {'verdict': 'ok', 'saw': 'jev-provider/1', 'effort': 'high',
                                                'model': 'fake-1', 'prompt': 'look at this'})
            self.assertEqual(result['cost'], {'mode': 'subscription', 'usd': None})
            self.assertEqual(result['usage'], {'input_tokens': 11})
            self.assertEqual(result['requestId'], 'req_1')
            self.assertEqual(result['changed'], ['a.txt'])
            self.assertEqual([a['outcome'] for a in result['attempts']], ['success'])

    def test_retryable_failure_falls_back_mutating_does_not_and_output_is_schema_checked(self):
        broken = script("import json, sys; sys.stdin.read(); print(json.dumps({'error': {'kind': 'overload', 'retryable': True}})); sys.exit(3)",
                        'broken-provider')
        mutating = script("import json, sys; sys.stdin.read(); print(json.dumps({'error': {'kind': 'provider-failure', 'retryable': True, 'mutated': True}})); sys.exit(4)",
                          'mutating-provider')
        wrong = script("import json, sys; sys.stdin.read(); print(json.dumps({'output': {'nope': True}}))",
                       'wrong-provider')
        good = script("import json, sys; sys.stdin.read(); print(json.dumps({'output': {'verdict': 'ok'}, 'cost': 0.25}))",
                      'good-provider')
        with PathOverride([os.path.dirname(p) for p in (broken, mutating, wrong, good)]):
            registry = provider.ProviderRegistry()
            for id, command in [('broken', 'broken-provider'), ('mutating', 'mutating-provider'),
                                ('wrong', 'wrong-provider'), ('good', 'good-provider')]:
                registry.register(provider.command_provider(id, command))
            provider.clear_provider_discovery_cache(registry)
            schema = {'type': 'object', 'required': ['verdict']}
            request = provider.provider_request('review', 'structured', schema=schema)
            result = asyncio.run(provider.run_provider_request(
                request, provider.merge_provider_config(project={'prefer': ['broken', 'good']}), registry))
            self.assertEqual(result['output']['verdict'], 'ok')
            self.assertEqual(result['cost'], {'mode': 'reported-usd', 'usd': 0.25})
            self.assertEqual([a['outcome'] for a in result['attempts']], ['overload', 'success'])

            with self.assertRaises(provider.ProviderError) as caught:
                asyncio.run(provider.run_provider_request(
                    request, provider.merge_provider_config(project={'prefer': ['mutating', 'good']}), registry))
            self.assertEqual(caught.exception.kind, 'provider-failure')
            self.assertTrue(caught.exception.mutated)
            self.assertEqual(len(caught.exception.attempts), 1)

            with self.assertRaises(provider.ProviderError) as caught:
                asyncio.run(provider.run_provider_request(
                    request, provider.merge_provider_config(project={'provider': 'wrong'}), registry))
            self.assertEqual(caught.exception.kind, 'unavailable')
            self.assertEqual([a['outcome'] for a in caught.exception.attempts], ['invalid-output'])

            with self.assertRaises(provider.ProviderError) as caught:
                asyncio.run(provider.run_provider_request(
                    request, provider.merge_provider_config(project={'provider': 'good'}), registry,
                    validate=lambda output: 'the verdict is not one of ours'))
            self.assertEqual(caught.exception.kind, 'unavailable')
            self.assertEqual(caught.exception.detail, 'the verdict is not one of ours')

    def test_a_timeout_kills_the_executable_and_is_reported_as_a_timeout(self):
        slow = script("import time, sys; sys.stdin.read(); time.sleep(5)", 'slow-provider')
        with PathOverride([os.path.dirname(slow)]):
            registry = provider.ProviderRegistry()
            registry.register(provider.command_provider('slow', 'slow-provider', timeout_seconds=0.3))
            provider.clear_provider_discovery_cache(registry)
            started = time.monotonic()
            with self.assertRaises(provider.ProviderError) as caught:
                asyncio.run(provider.run_provider_request(
                    provider.provider_request('review', 'structured'),
                    provider.merge_provider_config(project={'provider': 'slow'}), registry))
            self.assertEqual(caught.exception.kind, 'unavailable')
            self.assertIn('timed out', str(caught.exception.detail))
            self.assertEqual([a['outcome'] for a in caught.exception.attempts], ['timeout'])
            self.assertLess(time.monotonic() - started, 4)

    def test_only_the_allowed_environment_reaches_the_executable(self):
        echo = script("import json, os, sys; sys.stdin.read(); json.dump({'output': {'seen': sorted(os.environ)}}, sys.stdout)",
                      'env-provider')
        directory = os.path.dirname(echo)
        original = provider.environment_reader.get
        provider.environment_reader.get = lambda name: {
            'PATH': os.pathsep.join([directory, os.environ.get('PATH', '')]),
            'HOME': '/tmp', 'SECRET_TOKEN': 'never', 'ALLOWED': 'yes'}.get(name)
        try:
            registry = provider.make_default_registry(
                {'providers': {'env': {'command': 'env-provider', 'environment': ['ALLOWED'],
                                       'capabilities': {'efforts': ['low']}}}})
            provider.clear_provider_discovery_cache(registry)
            result = asyncio.run(provider.run_provider_request(
                provider.provider_request('review', 'structured'),
                provider.merge_provider_config(project={'provider': 'env'}), registry))
            seen = [n for n in result['output']['seen'] if not n.startswith('__')]
            python_runtime = {'CPATH', 'LIBRARY_PATH', 'LC_CTYPE', 'SDKROOT', 'MANPATH', 'HOME'}
            self.assertEqual([n for n in seen if n not in python_runtime], ['ALLOWED', 'PATH'])
            self.assertNotIn('SECRET_TOKEN', result['output']['seen'])
        finally:
            provider.environment_reader.get = original

    def test_advertised_parallelism_is_respected(self):
        live = [0]
        peak = [0]
        original = provider.runner.run

        async def fake_run(executable, args, options=None):
            live[0] += 1
            peak[0] = max(peak[0], live[0])
            await asyncio.sleep(0.02)
            live[0] -= 1
            return {'status': 0, 'stdout': '{"output": {"ok": true}}', 'stderr': ''}

        async def discover():
            return provider.availability('ready')

        async def drive():
            registry = provider.ProviderRegistry()
            found = provider.command_provider('twice', 'anything', caps=provider.capabilities(max_parallel=2))
            registry.register(provider.Provider(found.id, found.caps, discover, found.run))
            provider.clear_provider_discovery_cache(registry)
            config = provider.merge_provider_config(project={'provider': 'twice'})
            return await asyncio.gather(*[provider.run_provider_request(
                provider.provider_request('review', 'structured'), config, registry) for _ in range(6)])

        try:
            provider.runner.run = fake_run
            results = asyncio.run(drive())
            self.assertEqual(len(results), 6)
            self.assertEqual(peak[0], 2)
        finally:
            provider.runner.run = original

    def test_the_json_schema_subset(self):
        self.assertTrue(provider.json_schema_valid(None, {'anything': True}))
        self.assertTrue(provider.json_schema_valid(
            {'type': 'object', 'required': ['a'], 'properties': {'a': {'type': 'integer'}}}, {'a': 1}))
        self.assertFalse(provider.json_schema_valid({'type': 'object', 'required': ['a']}, {}))
        self.assertFalse(provider.json_schema_valid(
            {'type': 'object', 'additionalProperties': False, 'properties': {'a': {}}}, {'a': 1, 'b': 2}))
        self.assertFalse(provider.json_schema_valid({'type': 'integer'}, 1.5))
        self.assertTrue(provider.json_schema_valid({'enum': ['low', 'high']}, 'high'))
        self.assertFalse(provider.json_schema_valid({'enum': ['low', 'high']}, 'mid'))
        self.assertTrue(provider.json_schema_valid({'oneOf': [{'type': 'string'}, {'type': 'integer'}]}, 'x'))
        self.assertFalse(provider.json_schema_valid({'oneOf': [{'type': 'number'}, {'type': 'integer'}]}, 3))
        self.assertFalse(provider.json_schema_valid(
            {'type': 'array', 'items': {'type': 'string'}, 'maxItems': 1}, ['a', 'b']))
        self.assertFalse(provider.json_schema_valid({'type': 'string', 'minLength': 2}, 'a'))
        self.assertFalse(provider.json_schema_valid({'type': 'number', 'maximum': 1}, 2))


@unittest.skipUnless(_racket_available(), 'Racket and the monorepo are required')
class CommandWireTests(unittest.TestCase):
    def test_the_custom_executable_sees_the_same_jev_provider_1_request(self):
        echo = script(
            "import json, sys\n"
            "request = json.load(sys.stdin)\n"
            "json.dump({'output': {'request': request}, 'model': 'fake-1-served',\n"
            "          'usage': {'input_tokens': 7, 'output_tokens': 2},\n"
            "          'cost': {'mode': 'reported-usd', 'usd': 0.0001},\n"
            "          'provider_request_id': 'req_wire', 'changed': ['x.txt']}, sys.stdout)",
            'wire-provider')
        directory = tempfile.mkdtemp(prefix='jev-workspace-')
        run = _racket(COMMAND_ORACLE, echo, directory)
        self.assertEqual(run.returncode, 0, run.stderr)
        expected = json.loads(run.stdout)
        registry = provider.ProviderRegistry()
        registry.register(provider.command_provider('fake', echo, caps=provider.capabilities(
            modes=['structured', 'workspace'], permissions=['read', 'write'],
            controls=['structured-output', 'tool-policy'], efforts=['low', 'high']),
            environment=['ALLOWED'], timeout_seconds=30))
        provider.clear_provider_discovery_cache(registry)
        request = provider.provider_request('review', 'workspace',
                                            role='audit', kind='diff', tier='deep', permissions=['read', 'write'],
                                            prompt='look at this', schema={'type': 'object'}, images=['/tmp/a.png'],
                                            directory=directory, limits={'timeout_seconds': 30},
                                            metadata={'disallowed': ['Bash']})
        result = asyncio.run(provider.run_provider_request(
            request, provider.merge_provider_config(project={'provider': 'fake', 'model': 'fake-1', 'effort': 'high'}),
            registry))
        self.assertEqual(result['output']['request'], expected['wire'])
        self.assertEqual({
            'model': result['model'], 'usage': result['usage'],
            'cost': {'mode': result['cost']['mode'], 'usd': result['cost']['usd']},
            'request_id': result['requestId'], 'exit_status': result['exitStatus'], 'changed': result['changed'],
            'attempts': [a['outcome'] for a in result['attempts']],
        }, expected['result'])


class RegistryTests(unittest.TestCase):
    def test_the_default_registry_reads_the_config(self):
        plain = provider.make_default_registry({})
        self.assertEqual([p.id for p in plain.providers()], ['claude', 'codex', 'fx'])
        configured = provider.make_default_registry(
            {'providers': {'claude': {'command': '/opt/claude', 'max_parallel': 1}, 'house': {'command': 'house-agent'}}})
        self.assertEqual([p.id for p in configured.providers()], ['claude', 'codex', 'fx', 'house'])
        self.assertEqual(configured.get('claude').caps['maxParallel'], 1)
        with self.assertRaisesRegex(Exception, 'must be a string'):
            provider.make_default_registry({'providers': {'codex': {'command': 5}}})
        with self.assertRaisesRegex(Exception, 'positive integer'):
            provider.make_default_registry({'providers': {'fx': {'max_parallel': 0}}})


class LazyDiscoveryTests(unittest.TestCase):
    @staticmethod
    def _counting(id: str, status, seen: list) -> provider.Provider:
        async def discover():
            seen.append(id)
            return provider.availability(status() if callable(status) else status)

        async def run(request, target):
            return {}
        return provider.Provider(id, provider.capabilities(), discover, run)

    def test_only_the_candidates_tried_are_discovered_stopping_at_the_winner(self):
        seen: list = []
        registry = provider.ProviderRegistry()
        for id, status in [('slow-cli', 'ready'), ('http', 'ready'), ('offline', 'missing')]:
            registry.register(self._counting(id, status, seen))
        exact = asyncio.run(provider.resolve_provider(
            provider.provider_request('review', 'structured', target=provider.target_spec({'provider': 'http'})),
            provider.merge_provider_config(), registry))
        self.assertEqual(exact['target']['provider'].id, 'http')
        self.assertEqual(seen, ['http'])
        preferred = asyncio.run(provider.resolve_provider(
            provider.provider_request('review', 'structured'),
            provider.merge_provider_config(project={'preferences': ['offline', 'http', 'slow-cli']}), registry))
        self.assertEqual(preferred['target']['provider'].id, 'http')
        self.assertEqual([(r['provider'], r['kind']) for r in preferred['rejections']], [('offline', 'missing')])
        self.assertEqual(seen, ['http', 'offline'])

    def test_only_a_ready_discovery_is_remembered(self):
        seen: list = []
        logged_in = {'value': False}
        registry = provider.ProviderRegistry()
        registry.register(self._counting('cli', lambda: 'ready' if logged_in['value'] else 'unauthenticated', seen))
        request = provider.provider_request('review', 'structured', target=provider.target_spec({'provider': 'cli'}))
        with self.assertRaises(provider.ProviderError):
            asyncio.run(provider.resolve_provider(request, provider.merge_provider_config(), registry))
        logged_in['value'] = True
        asyncio.run(provider.resolve_provider(request, provider.merge_provider_config(), registry))
        asyncio.run(provider.resolve_provider(request, provider.merge_provider_config(), registry))
        self.assertEqual(len(seen), 2)


if __name__ == '__main__':
    unittest.main()
