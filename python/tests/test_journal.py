"""Journal parity (against the Racket oracle data), durability, concurrency
and the no-RETURNING fallback. No Node, no network."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any, List

from jevlang._journal import memory_journal, sqlite_journal

OPS_PATH = Path(__file__).resolve().parents[2] / 'test' / 'parity' / 'journal-ops.json'
EXPECTED = [
    'new', 'running', None, {'result': {'locked': True}, 'status': 'ran'},
    'new', None, 'new', None, {'result': {'error': 'the door is stuck'}, 'status': 'error'},
    True, True, False, True, False, True, True, False, True, True, True, False, True,
    None, None, None, 8500, False,
    [['later/2', {'decision': {'action': 'act', 'target': 'lights-on'}}]],
    9000, True, None,
]


def run_ops(journal: Any, ops: List[List[Any]]) -> List[Any]:
    out = []
    for op, args in ops:
        out.append(getattr(journal, op)(*args))
    return out


class JournalParityTest(unittest.TestCase):
    def setUp(self) -> None:
        self.ops = json.loads(OPS_PATH.read_text(encoding='utf-8'))

    def test_memory_journal_matches_the_racket_oracle(self) -> None:
        self.assertEqual(run_ops(memory_journal(), self.ops), EXPECTED)

    def test_sqlite_journal_matches_the_racket_oracle(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            journal = sqlite_journal(os.path.join(tmp, 'portable.sqlite'))
            try:
                self.assertEqual(run_ops(journal, self.ops), EXPECTED)
            finally:
                journal.close()

    def test_sqlite_fallback_without_returning_matches_the_racket_oracle(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            journal = sqlite_journal(os.path.join(tmp, 'fallback.sqlite'), returning=False)
            try:
                self.assertEqual(run_ops(journal, self.ops), EXPECTED)
            finally:
                journal.close()

    def test_memory_and_sqlite_answer_the_same_script(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            journal = sqlite_journal(os.path.join(tmp, 'same.sqlite'))
            try:
                self.assertEqual(run_ops(memory_journal(), self.ops),
                                 run_ops(journal, self.ops))
            finally:
                journal.close()


class SharedJournalTest(unittest.TestCase):
    def test_two_journals_one_file_and_reopen(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, 'shared.sqlite')
            first = sqlite_journal(path)
            second = sqlite_journal(path)
            self.assertEqual(first.beginStep('act/1', 'unlock-door', 1000), 'new')
            self.assertEqual(second.beginStep('act/1', 'unlock-door', 1001), 'running')
            first.finishStep('act/1', 'ran', {'unlocked': True}, 1100)
            self.assertEqual(second.beginStep('act/1', 'unlock-door', 1200),
                             {'status': 'ran', 'result': {'unlocked': True}})
            self.assertIs(first.claimCooldown('unlock-door', 2000, 30000), True)
            self.assertIs(second.claimCooldown('unlock-door', 2100, 30000), False)
            self.assertIs(first.claimBudget('spend', 3000, 86400000, 8, 10), True)
            self.assertIs(second.claimBudget('spend', 3100, 86400000, 8, 10), False)
            first.schedule('later/1', 5000, {'decision': {'action': 'act', 'target': 'lights-off'}})
            first.close()
            second.close()
            reopened = sqlite_journal(path)
            try:
                self.assertEqual(reopened.nextDue(), 5000)
                self.assertEqual(reopened.takeDue(5000),
                                 [['later/1', {'decision': {'action': 'act', 'target': 'lights-off'}}]])
                self.assertIs(reopened.coolingDown('unlock-door', 2200, 30000), True)
                self.assertEqual(reopened.beginStep('act/1', 'unlock-door', 9000),
                                 {'status': 'ran', 'result': {'unlocked': True}})
            finally:
                reopened.close()

    def test_concurrent_claims_hand_out_exactly_as_many_as_fit(self) -> None:
        import threading
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, 'race.sqlite')
            journals = [sqlite_journal(path) for _ in range(6)]
            budgets: List[Any] = [None] * 6
            steps: List[Any] = [None] * 6

            def claim_budget(i: int) -> None:
                budgets[i] = journals[i].claimBudget('calls', 1000, 60000, 1, 3)

            def claim_step(i: int) -> None:
                steps[i] = journals[i].beginStep('one/step', 'act', 1000)

            threads = [threading.Thread(target=claim_budget, args=(i,)) for i in range(6)]
            for t in threads:
                t.start()
            for t in threads:
                t.join()
            threads = [threading.Thread(target=claim_step, args=(i,)) for i in range(6)]
            for t in threads:
                t.start()
            for t in threads:
                t.join()
            self.assertEqual(len([c for c in budgets if c]), 3)
            self.assertEqual(len([s for s in steps if s == 'new']), 1)
            for journal in journals:
                journal.close()


WORKER = '''
import sys
sys.path.insert(0, {package!r})
from jevlang._journal import sqlite_journal
journal = sqlite_journal({path!r}, returning={returning})
won = journal.beginStep('proc/1', 'act', 1000)
with open({out!r}, 'w') as f:
    f.write('new' if won == 'new' else 'other')
journal.close()
'''


class TwoProcessTest(unittest.TestCase):
    def _run_two_processes(self, returning: Any = None) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, 'procs.sqlite')
            package = str(Path(__file__).resolve().parents[1])
            outputs = []
            procs = []
            for i in range(2):
                out = os.path.join(tmp, f'out{i}')
                outputs.append(out)
                script = WORKER.format(package=package, path=path, out=out, returning=returning)
                env = dict(os.environ, PATH='/usr/bin:/bin')
                procs.append(subprocess.Popen([sys.executable, '-c', script], env=env,
                                              stderr=subprocess.PIPE, text=True))
            for i, proc in enumerate(procs):
                code = proc.wait()
                stderr = proc.stderr.read()
                proc.stderr.close()
                self.assertEqual(code, 0, f'worker {i} stderr: {stderr}')
            results = [Path(out).read_text(encoding='utf-8') for out in outputs]
            self.assertEqual(sorted(results), ['new', 'other'])

    def test_exactly_one_process_wins_the_step(self) -> None:
        self._run_two_processes()

    def test_exactly_one_process_wins_without_returning(self) -> None:
        self._run_two_processes(returning=False)


class MemoryJournalSemanticsTest(unittest.TestCase):
    def test_release_then_begin_is_new_again(self) -> None:
        journal = memory_journal()
        self.assertEqual(journal.beginStep('k', 't', 1), 'new')
        journal.releaseStep('k')
        self.assertEqual(journal.beginStep('k', 't', 2), 'new')

    def test_cooldown_window_boundary(self) -> None:
        journal = memory_journal()
        self.assertIs(journal.claimCooldown('c', 1000, 500), True)
        self.assertIs(journal.claimCooldown('c', 1499, 500), False)
        self.assertIs(journal.claimCooldown('c', 1500, 500), True)

    def test_budget_usage_expires_with_the_window(self) -> None:
        journal = memory_journal()
        self.assertIs(journal.claimBudget('b', 1000, 100, 5, 5), True)
        self.assertIs(journal.claimBudget('b', 1050, 100, 1, 5), False)
        self.assertIs(journal.claimBudget('b', 1101, 100, 5, 5), True)

    def test_take_due_is_earliest_first_and_removes(self) -> None:
        journal = memory_journal()
        journal.schedule('a', 300, {'x': 1})
        journal.schedule('b', 200, {'y': 2})
        journal.schedule('c', 999, {'z': 3})
        self.assertEqual(journal.takeDue(300), [['b', {'y': 2}], ['a', {'x': 1}]])
        self.assertEqual(journal.nextDue(), 999)
        self.assertIs(journal.cancel('c'), True)
        self.assertIs(journal.cancel('c'), False)
        self.assertIsNone(journal.nextDue())


if __name__ == '__main__':
    unittest.main()
