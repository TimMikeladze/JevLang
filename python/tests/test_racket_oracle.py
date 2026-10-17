"""Racket is the oracle: the native Python engine against the Racket reference.

These mirror the TypeScript suite's oracle tests (test/oracle.rkt,
test/names-oracle.rkt): the same shared data, decisions compared exactly,
readings included. Development-only, like every oracle: they skip when Racket
or the monorepo layout is absent, and the Python engine's own tests (and the
installed wheel) never require Racket.
"""
from __future__ import annotations

import json
import os
import subprocess
import shutil
import unittest
from pathlib import Path

PACKAGES = Path(__file__).resolve().parents[2]
TS = PACKAGES
TS_TEST = TS / 'test'

from jevlang import Policy  # noqa: E402
from jevlang._numberfmt import canonical  # noqa: E402
from tests.test_local import names_policy, ticket_policy  # noqa: E402


def _racket_available() -> bool:
    return (TS_TEST / 'oracle.rkt').is_file() and shutil.which('racket') is not None and subprocess.run(['racket', '--version'], capture_output=True).returncode == 0


def _racket(file: str):
    env = {**os.environ, 'TYPESAFE_API_KEY': '', 'ANTHROPIC_API_KEY': '', 'OPENAI_API_KEY': '',
           'JEV_PROVIDER': '', 'JEV_MODEL': '', 'JEV_EFFORT': ''}
    result = subprocess.run(['racket', str(TS_TEST / file)], capture_output=True, encoding='utf-8',
                            env=env, timeout=300, cwd=str(TS_TEST))
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def _semantic(d):
    """Blank what the host language owns: source text, file and line."""
    if not isinstance(d, dict):
        return d
    return {k: (None if k in ('source', 'line', 'file') else _semantic(v)) for k, v in d.items()}


@unittest.skipUnless(_racket_available() and TS_TEST.is_dir(), 'Racket and the monorepo are required')
class RacketOracleTests(unittest.TestCase):

    def test_ticket_fixtures_decide_as_racket_does(self):
        policy = ticket_policy()
        rows = _racket('oracle.rkt')
        self.assertGreaterEqual(len(rows), 11)
        for row in rows:
            actual = _semantic(policy.decide(row['answers']))
            expected = _semantic(row['decision'])
            self.assertEqual(canonical(actual), canonical(expected), row['name'])

    def test_names_levels_and_raw_questions_as_racket_checks_them(self):
        policy = names_policy()
        oracle = _racket('names-oracle.rkt')
        self.assertEqual(canonical(policy.questions({'request': 'the request text'})),
                         canonical(oracle['questions']))
        for row in oracle['cases']:
            actual = _semantic(policy.decide(row['answers']))
            expected = _semantic(row['decision'])
            self.assertEqual(canonical(actual), canonical(expected), row['name'])


if __name__ == '__main__':
    unittest.main()
