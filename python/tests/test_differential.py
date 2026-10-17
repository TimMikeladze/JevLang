"""Differential parity of the native Python engine against the TypeScript engine.

Development-only: like the TypeScript suite's Racket oracles, this compares two
implementations over shared data (the reference ticket fixtures and the parity
cases both suites already pin to Racket). The Python engine's own tests never
need Node; this one does, and skips when the monorepo layout or Node is absent.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import unittest
from pathlib import Path

PACKAGES = Path(__file__).resolve().parents[2]        # packages/
REPO = PACKAGES.parent                                # repository root
TS = PACKAGES                             # packages/jevlang
ENGINE = TS / 'src' / 'cli.js'
EXAMPLES = Path(__file__).parent / 'fixtures' / 'legacy-examples'

from jevlang import Policy, _call_native  # noqa: E402
from jevlang import _monitor as monitor   # noqa: E402
from jevlang._numberfmt import canonical  # noqa: E402

_NODE_FOUND = shutil.which(os.environ.get('JEV_NODE', 'node'))
NODE = _NODE_FOUND or 'node'


def _available() -> bool:
    return _NODE_FOUND is not None and ENGINE.is_file() and EXAMPLES.is_dir()


def _ts_rpc_raw(method: str, policy=None, **kwargs):
    request = json.dumps(dict(method=method, **({} if policy is None else {'policy': policy}), **kwargs))
    result = subprocess.run([NODE, str(ENGINE), 'rpc'], input=request + '\n', encoding='utf-8',
                            capture_output=True, check=True, timeout=120)
    return json.loads(result.stdout)


def _ts_rpc(method: str, policy=None, **kwargs):
    response = _ts_rpc_raw(method, policy, **kwargs)
    assert response['ok'], response['error']
    return response['result']


def _ts_ticket_artifact() -> dict:
    script = (
        "import('./examples/ticket-router.js').then(m => "
        "console.log(JSON.stringify(m.policy.toJSON())))"
    )
    result = subprocess.run([NODE, '--input-type=module', '-e', script], encoding='utf-8',
                            capture_output=True, check=True, timeout=120, cwd=str(TS))
    return json.loads(result.stdout)


def _fixtures() -> list:
    files = []
    for sub in ('fixtures', 'recorded', 'labeled'):
        directory = EXAMPLES / sub
        if directory.is_dir():
            files.extend(sorted(directory.glob('*.json')))
    fixtures = [json.loads(p.read_text()) for p in files]
    return sorted(fixtures, key=lambda f: f.get('name', ''))


@unittest.skipUnless(_available(), 'the monorepo, its TypeScript engine and Node are required')
class DifferentialTests(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.artifact = _ts_ticket_artifact()
        cls.policy = Policy.from_json(cls.artifact)
        cls.fixtures = _fixtures()

    def test_replay_rows_match_the_typescript_engine(self):
        expected = _ts_rpc('replay', self.artifact, fixtures=self.fixtures)
        actual = _call_native('replay', self.artifact, fixtures=self.fixtures)
        self.assertEqual(canonical(actual), canonical(expected))

    def test_every_fixture_decision_matches_the_typescript_engine(self):
        for fixture in self.fixtures:
            expected = _ts_rpc('decide', self.artifact, answers=fixture['answers'],
                               options={'facts': fixture.get('facts') or fixture.get('state'),
                                        'state': fixture.get('state')})
            actual = _call_native('decide', self.artifact, answers=fixture['answers'],
                                  options={'facts': fixture.get('facts') or fixture.get('state'),
                                           'state': fixture.get('state')})
            self.assertEqual(canonical(actual), canonical(expected), fixture.get('name'))

    def test_stats_calibrate_and_cost_match(self):
        for method, kwargs in (('stats', {'fixtures': self.fixtures}),
                               ('calibrate', {'fixtures': self.fixtures}),
                               ('cost', {'options': {'fixtures': self.fixtures, 'volume': 3}}),
                               ('cost', {'options': {'input': {'subject': 'a refund please', 'body': 'text'}}})):
            with self.subTest(method=method):
                expected = _ts_rpc(method, self.artifact, **kwargs)
                actual = _call_native(method, self.artifact, **kwargs)
                self.assertEqual(canonical(actual), canonical(expected))

    def test_state_and_questions_match(self):
        for fixture in self.fixtures[:6]:
            expected = _ts_rpc('state', self.artifact, input=fixture.get('state'))
            actual = _call_native('state', self.artifact, input=fixture.get('state'))
            self.assertEqual(canonical(actual), canonical(expected), fixture.get('name'))

    def test_validation_errors_match(self):
        def with_options(criteria):
            return {**self.artifact, 'questions': {**self.artifact['questions'], 'department': {
                **self.artifact['questions']['department'], 'criteria': criteria}}}
        ok_criteria = {'billing': 'x', 'technical': 'y', 'sales': 'z'}
        for name, mutate in (
            ('unknown question', lambda p: {**p, 'route': {'mode': 'first', 'clauses': [
                {'when': {'op': 'is', 'args': ['nope', 'billing']}, 'decision': {'action': 'hold'}}],
                'otherwise': {'action': 'hold'}}}),
            ('missing option', lambda p: {**p, 'route': {'mode': 'first', 'clauses': [
                {'when': {'op': 'is', 'args': ['department', 'sale']}, 'decision': {'action': 'hold'}}],
                'otherwise': {'action': 'hold'}}}),
            ('bad gate metric', lambda p: {**p, 'gates': [{'question': 'department', 'threshold': 0.5,
                                                           'by': 'vibes', 'decision': {'action': 'hold'}}]}),
            ('not exhaustive', lambda p: {**p, 'route': {'mode': 'first', 'clauses': [
                {'when': {'op': 'is', 'args': ['department', 'billing']}, 'decision': {'action': 'hold'}}]}}),
            ('single option', lambda p: with_options({'billing': 'x'})),
        ):
            with self.subTest(case=name):
                policy = mutate(with_options(ok_criteria)) if name != 'single option' else mutate(None)
                from jevlang import JevError
                try:
                    _call_native('validate', policy)
                    self.fail('the Python engine accepted it')
                except JevError as error:
                    python_error = error
                response = _ts_rpc_raw('validate', policy)
                self.assertFalse(response['ok'], name)
                expected = response['error']
                self.assertEqual(python_error.code, expected['code'], name)
                self.assertEqual(python_error.path, expected['path'], name)
                self.assertEqual(python_error.fix, expected['fix'], name)
                self.assertEqual(str(python_error), expected['message'], name)

    def test_text_reports_are_byte_identical(self):
        stability = json.loads((TS / 'test' / 'parity' / 'stability-cases.json').read_text())
        calibration = json.loads((TS / 'test' / 'parity' / 'calibration-cases.json').read_text())
        request = json.dumps({
            'ticketArtifact': self.artifact,
            'fixtureDirs': [str(EXAMPLES / sub) for sub in ('fixtures', 'recorded', 'labeled')],
            'calibrationCases': calibration,
            'stabilityCases': stability,
        })
        result = subprocess.run([NODE, str(Path(__file__).parent / 'monitor-driver.mjs')],
                                input=request, encoding='utf-8', capture_output=True, timeout=120)
        self.assertEqual(result.returncode, 0, result.stderr[:2000])
        expected = json.loads(result.stdout)

        decisions = [self.policy.decide(f['answers'], options={'facts': f.get('facts') or f.get('state'),
                                                               'state': f.get('state')}) for f in self.fixtures]
        half = len(decisions) // 2

        def plain(s):
            return {**s, 'clauses': [{k: v for k, v in c.items() if k not in ('file', 'source', 'line')}
                                     for c in s['clauses']]}

        sa = plain(monitor.summarize(decisions[:half]))
        sb = plain(monitor.summarize(decisions[half:]))
        labelled = plain(monitor.summarize(decisions, [f['answers'] for f in self.fixtures],
                                           [f.get('label') for f in self.fixtures]))
        comparison = monitor.compare_windows(sa, sb)
        self.assertEqual(monitor.format_summary(sa), expected['summary_a_text'])
        self.assertEqual(monitor.format_summary(labelled), expected['summary_labelled_text'])
        self.assertEqual(monitor.format_comparison(comparison), expected['comparison_text'])
        self.assertEqual(monitor.format_comparison(comparison, ['last week', 'this week']),
                         expected['comparison_text_named'])
        self.assertEqual([monitor.format_calibration(c) for c in monitor.calibrate(calibration)],
                         expected['calibration_text'])

        gates = [{**g, 'name': f"{g['question']}/{g['option']}" if g['kind'] == 'option-gate' else g['question']}
                 for g in stability['gates']]
        report = monitor.stability_report(policy=stability['policy'], runs=stability['runs'], gates=gates,
                                          thresholds=stability['thresholds'], uid_added=True,
                                          usage=stability['usage'])
        self.assertEqual(monitor.format_stability(report), expected['stability_text'])
        calm = {
            'department': {'type': 'choice', 'choice': 'billing', 'confidence': 0.99,
                           'probabilities': {'billing': 0.99, 'technical': 0.005, 'sales': 0.005}},
            'frustration': {'type': 'score', 'score': 0.2, 'confidence': 0.95,
                            'probabilities': {'0': 0.9, '1': 0.07, '2': 0.03}},
            'refund-requested?': {'type': 'noul', 'noul': 0.1},
        }
        precheck = monitor.stability_report(policy=stability['policy'], n=12,
                                            precheck=self.policy.decide(calm))
        self.assertEqual(monitor.format_stability(precheck), expected['precheck_text'])
        self.assertEqual([[monitor.__dict__['decimal_string'](x, p) for p in (1, 3, 6)]
                          for x in (0.125, 0.5, 0.0005, 33.333333, 99.95, 1.0005)],
                         expected['decimals'])


if __name__ == '__main__':
    unittest.main()
