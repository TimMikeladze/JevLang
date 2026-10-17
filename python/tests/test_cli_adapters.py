"""The Claude, Codex and fx CLI adapters, natively.

The parity scenarios are the same ones the TypeScript suite and the Racket
oracle use. A fake runner stands in for each CLI, exactly as both other suites
do it, so nothing is installed, nothing is called and no Node is needed."""
from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from jevlang import _provider as provider
from jevlang import _provider_cli as cli

PACKAGES = Path(__file__).resolve().parents[2]
CASES = PACKAGES / 'test' / 'parity' / 'cli-adapter-scenarios.json'
ORACLE = PACKAGES / 'test' / 'cli-adapters-oracle.rkt'
HERE = PACKAGES


def _racket_available() -> bool:
    return ORACLE.is_file() and shutil.which('racket') is not None and CASES.is_file()


def _racket(directory: str):
    env = dict(os.environ, TYPESAFE_API_KEY='', ANTHROPIC_API_KEY='', OPENAI_API_KEY='')
    return subprocess.run(['racket', str(ORACLE), directory], encoding='utf8', capture_output=True,
                          env=env, cwd=directory)


def scenario_request(s: dict, directory: str) -> dict:
    r = s['request']
    return provider.provider_request(r['operation'], r['mode'],
                                     permissions=r.get('permissions') or ['read'],
                                     prompt=r.get('prompt', ''),
                                     schema=r.get('schema'),
                                     directory=directory if r.get('directory') else None,
                                     limits=r.get('limits') or {},
                                     metadata=r.get('metadata') or {})


def scenario_target(s: dict, value) -> dict:
    return {'provider': value, 'model': s.get('model'), 'requestedEffort': s.get('effort'),
            'effectiveEffort': s.get('effort'), 'sources': {'provider': 'request'}}


def make_fake_runner(s: dict, captured: dict):
    async def fake_run(executable, args, options=None):
        options = options or {}
        if s.get('result') is not None:
            at = args.index('--output-last-message') if '--output-last-message' in args else -1
            if at >= 0:
                with open(args[at + 1], 'w', encoding='utf-8') as handle:
                    json.dump(s['result'], handle)
        captured['call'] = {'args': args, 'stdin': options.get('stdin') or '',
                            'timeout': options.get('timeoutSeconds', 300)}
        return {'status': s.get('status', 0), 'stdout': s.get('stdout', ''), 'stderr': ''}
    return fake_run


def sort_keys(value):
    if isinstance(value, list):
        return [sort_keys(v) for v in value]
    if isinstance(value, dict):
        return {k: sort_keys(value[k]) for k in sorted(value)}
    return value


def canonical_arg(a):
    if not isinstance(a, str) or not re.match(r'^[[{]', a):
        return a
    try:
        return json.dumps(sort_keys(json.loads(a)), separators=(',', ':'))
    except (ValueError, TypeError):
        return a


def scrub(args, directory: str):
    out = []
    for a in args:
        if not isinstance(a, str):
            out.append(canonical_arg(a))
            continue
        if a == directory or a == directory + '/':
            out.append('<dir>')
        elif re.search(r'schema\.json$', a):
            out.append('<schema>')
        elif re.search(r'result\.json$', a):
            out.append('<result>')
        else:
            out.append(canonical_arg(a))
    return out


def canonical_lines(text: str) -> str:
    return '\n'.join(canonical_arg(line) for line in text.split('\n'))


@unittest.skipUnless(_racket_available(), 'Racket and the monorepo are required')
class CliAdapterScenarioTests(unittest.TestCase):
    def test_each_adapter_builds_the_same_command_line_and_reads_the_same_answer(self):
        original_cwd = os.getcwd()
        os.chdir(HERE)
        try:
            self._run_scenarios()
        finally:
            os.chdir(original_cwd)

    def _run_scenarios(self):
        run = _racket(str(HERE))
        self.assertEqual(run.returncode, 0, run.stderr)
        expected = json.loads(run.stdout)
        cases = json.loads(CASES.read_text(encoding='utf-8'))
        original = provider.runner.run
        try:
            for s, want in zip(cases['scenarios'], expected):
                name = s['name']
                self.assertEqual(want['name'], name)
                value = {'claude': cli.claude_provider, 'codex': cli.codex_provider, 'fx': cli.fx_provider}[s['provider']]()
                captured = {}
                provider.runner.run = make_fake_runner(s, captured)
                request = scenario_request(s, str(HERE))
                target = scenario_target(s, value)
                try:
                    result = asyncio.run({
                        'claude': lambda: cli.claude_cli_runner('claude', request, target),
                        'codex': lambda: cli.codex_cli_runner('codex', request, target, billing='subscription'),
                        'fx': lambda: cli.fx_cli_runner('fx', request, target, billing='subscription'),
                    }[s['provider']]())
                    answer = {'result': {
                        'output': result['output'], 'model': result.get('model') or None, 'usage': result['usage'],
                        'cost': {'mode': result['cost']['mode'], 'usd': result['cost'].get('usd')},
                        'request_id': result.get('requestId'), 'exit_status': result.get('exitStatus'),
                        'changed': result['changed'],
                    }}
                except provider.ProviderError as error:
                    answer = {'error': {
                        'kind': error.kind, 'retryable': error.retryable, 'mutated': error.mutated,
                        'status': error.status if error.status is not None else None,
                        'cost': {'mode': error.cost['mode'], 'usd': error.cost.get('usd')},
                    }}
                if want['call'] is None:
                    self.assertNotIn('call', captured, f'{name}: expected no call')
                else:
                    self.assertIn('call', captured, f'{name}: expected a call')
                    self.assertEqual(scrub(captured['call']['args'], str(HERE)),
                                     [canonical_arg(a) for a in want['call']['args']], f'{name}: arguments')
                    self.assertEqual(canonical_lines(captured['call']['stdin']),
                                     canonical_lines(want['call']['stdin']), f'{name}: prompt')
                    self.assertEqual(captured['call']['timeout'], want['call']['timeout'], f'{name}: timeout')
                if want['answer'].get('error'):
                    self.assertIn('error', answer, f'{name}: expected an error, got a result')
                    for key in ('kind', 'retryable', 'mutated', 'status', 'cost'):
                        self.assertEqual(answer['error'][key], want['answer']['error'][key], f'{name}: error {key}')
                else:
                    self.assertIn('result', answer, f'{name}: expected a result, got {json.dumps(answer.get("error"))}')
                    self.assertEqual(answer['result'], want['answer']['result'], name)
        finally:
            provider.runner.run = original


class ClaudeTranscriptTests(unittest.TestCase):
    def test_the_stream_transcript_gives_up_its_last_structured_call(self):
        transcript = '\n'.join([
            json.dumps({'type': 'assistant', 'message': {'content': [{'type': 'text', 'text': 'thinking'}]}}),
            json.dumps({'type': 'assistant', 'message': {'content': [
                {'type': 'tool_use', 'name': 'StructuredOutput', 'input': {'verdict': 'first'}}]}}),
            json.dumps({'type': 'assistant', 'message': {'content': [
                {'type': 'tool_use', 'name': 'StructuredOutput', 'input': {'verdict': 'last'}}]}}),
            json.dumps({'type': 'result', 'structured_output': {'verdict': 'last'}}),
        ])
        self.assertEqual(cli.last_structured_call(transcript), {'verdict': 'last'})
        as_json = json.dumps({'type': 'assistant', 'message': {'content': [
            {'type': 'text', 'text': '<StructuredOutput>{"verdict": "ok"}</StructuredOutput>'}]}})
        self.assertEqual(cli.last_structured_call(as_json), {'verdict': 'ok'})
        as_parameters = json.dumps({'type': 'assistant', 'message': {'content': [
            {'type': 'text', 'text': '<StructuredOutput><parameter name="verdict">ok</parameter></StructuredOutput>'}]}})
        self.assertEqual(cli.last_structured_call(as_parameters), {'verdict': 'ok'})
        as_tags = json.dumps({'type': 'assistant', 'message': {'content': [
            {'type': 'text', 'text': '<StructuredOutput><verdict>ok</verdict></StructuredOutput>'}]}})
        self.assertEqual(cli.last_structured_call(as_tags), {'verdict': 'ok'})
        self.assertIsNone(cli.last_structured_call('no structured output here'))


class CodexSchemaTests(unittest.TestCase):
    def test_strict_schema_widened_and_narrowed_again(self):
        schema = {
            'type': 'object',
            'properties': {'verdict': {'type': 'string'}, 'note': {'type': 'string'}, 'count': {'type': 'number'}},
            'required': ['verdict'],
        }
        strict = cli.codex_output_schema(schema)
        self.assertEqual(sorted(strict['required']), ['count', 'note', 'verdict'])
        self.assertIs(strict['additionalProperties'], False)
        self.assertEqual(strict['properties']['verdict'], {'type': 'string'})
        self.assertEqual(strict['properties']['note'], {'anyOf': [{'type': 'string'}, {'type': 'null'}]})
        self.assertEqual(cli.restore_optional_fields({'verdict': 'ok', 'note': None, 'count': 2}, schema),
                         {'verdict': 'ok', 'count': 2})
        nullable = {'type': 'object', 'properties': {'note': {'type': ['string', 'null']}}, 'required': ['note']}
        self.assertEqual(cli.restore_optional_fields({'note': None}, nullable), {'note': None})
        nested = {
            'type': 'object',
            'properties': {'items': {'type': 'array', 'items': {
                'type': 'object', 'properties': {'a': {'type': 'string'}, 'b': {'type': 'string'}},
                'required': ['a']}}},
            'required': ['items'],
        }
        self.assertEqual(cli.restore_optional_fields({'items': [{'a': 'x', 'b': None}]}, nested),
                         {'items': [{'a': 'x'}]})
        self.assertEqual(cli.catalog_to_settings(json.dumps({
            'models': [{'slug': 'gpt-6', 'supported_reasoning_levels': [{'effort': 'low'}, {'effort': 'high'}],
                        'default_reasoning_level': 'high', 'input_modalities': ['text', 'image']}],
        })), {'gpt-6': {'efforts': ['low', 'high'], 'default_effort': 'high', 'modalities': ['text', 'image']}})
        self.assertIsNone(cli.catalog_to_settings('not json'))


class DiscoveryTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.mkdtemp(prefix='jev-cli-')
        for name in ('claude', 'codex', 'fx'):
            Path(self.directory, name).write_text('')
        self.original_run = provider.runner.run
        self.original_env = provider.environment_reader.get
        provider.environment_reader.get = lambda name: (
            self.directory if name == 'PATH' else self.original_env(name))

    def tearDown(self):
        provider.runner.run = self.original_run
        provider.environment_reader.get = self.original_env

    def test_missing_when_not_installed(self):
        empty = tempfile.mkdtemp(prefix='jev-cli-empty-')
        provider.environment_reader.get = lambda name: (
            empty if name == 'PATH' else self.original_env(name))

        async def unexpected(executable, args, options=None):
            raise AssertionError('nothing else is run')
        provider.runner.run = unexpected
        self.assertEqual(asyncio.run(cli.claude_provider().discover())['status'], 'missing')
        self.assertEqual(asyncio.run(cli.codex_provider().discover())['status'], 'missing')
        self.assertEqual(asyncio.run(cli.fx_provider().discover())['status'], 'missing')

    def test_their_own_answers_decide(self):
        for name in ('claude', 'codex', 'fx'):
            Path(self.directory, name).write_text('')
        answers = {
            'claude --version': {'status': 0, 'stdout': '1.2.3 (Claude Code)', 'stderr': ''},
            'claude auth status': {'status': 0, 'stdout': json.dumps({'loggedIn': True, 'subscriptionType': 'max'}), 'stderr': ''},
            'codex --version': {'status': 0, 'stdout': 'codex-cli 0.155.1', 'stderr': ''},
            'codex login status': {'status': 0, 'stdout': 'Logged in using ChatGPT', 'stderr': ''},
            'codex debug models': {'status': 0, 'stdout': json.dumps(
                {'models': [{'slug': 'gpt-6', 'supported_reasoning_levels': [{'effort': 'xhigh'}]}]}), 'stderr': ''},
            'fx --version': {'status': 0, 'stdout': 'fx 0.0.11', 'stderr': ''},
            'fx status': {'status': 0, 'stdout': json.dumps(
                {'kind': 'status', 'model': 'grok-4', 'auth': 'Grok subscription', 'permission_mode': 'auto'}), 'stderr': ''},
            'fx models': {'status': 0, 'stdout': json.dumps({'kind': 'models', 'ids': ['grok-4']}), 'stderr': ''},
        }

        async def fake_run(executable, args, options=None):
            command = f"{os.path.basename(executable)} {' '.join(args)}"
            for key, value in answers.items():
                if command.startswith(key):
                    return value
            return {'status': 1, 'stdout': '', 'stderr': 'unexpected'}

        provider.runner.run = fake_run
        claude = asyncio.run(cli.claude_provider().discover())
        self.assertEqual([claude['status'], claude['version'], claude['billing']], ['ready', '1.2.3', 'subscription'])
        codex = cli.codex_provider()
        codex_ready = asyncio.run(codex.discover())
        self.assertEqual([codex_ready['status'], codex_ready['version'], codex_ready['billing']],
                         ['ready', '0.155.1', 'subscription'])
        self.assertEqual(codex.model_capabilities['gpt-6']['efforts'], ['xhigh'])
        fx = cli.fx_provider()
        fx_ready = asyncio.run(fx.discover())
        self.assertEqual([fx_ready['status'], fx_ready['version'], fx_ready['billing']],
                         ['ready', '0.0.11', 'subscription'])
        self.assertEqual(list(fx.model_capabilities), ['grok-4'])

    def test_unauthenticated_and_too_old(self):
        async def fake_run(executable, args, options=None):
            command = f"{os.path.basename(executable)} {' '.join(args)}"
            if '--version' in command:
                return {'status': 0, 'stdout': 'fx 0.0.9\nclaude 1.0.0\ncodex-cli 0.1.0', 'stderr': ''}
            if 'auth status' in command:
                return {'status': 0, 'stdout': json.dumps({'loggedIn': False}), 'stderr': ''}
            if 'login status' in command:
                return {'status': 1, 'stdout': 'Not logged in', 'stderr': ''}
            return {'status': 1, 'stdout': '', 'stderr': ''}
        provider.runner.run = fake_run
        self.assertEqual(asyncio.run(cli.claude_provider().discover())['status'], 'unauthenticated')
        self.assertEqual(asyncio.run(cli.codex_provider().discover())['status'], 'unauthenticated')
        old = asyncio.run(cli.fx_provider().discover())
        self.assertEqual(old['status'], 'unavailable')
        self.assertRegex(old['detail'], r'0\.0\.10 or newer')


if __name__ == '__main__':
    unittest.main()
