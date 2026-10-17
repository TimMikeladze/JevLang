"""Label harvesting, ported from src/harvest.mjs, checked against
harvest-oracle.rkt over the shared parity cases and a real store."""
from __future__ import annotations

import asyncio
import json
import os
import tempfile
import unittest
from pathlib import Path

PACKAGES = Path(__file__).resolve().parents[2]
TS_TEST = PACKAGES / 'test'

from jevlang._harvest import (derive_label, escalated_decision, harvest_add, harvest_find,
                              harvest_outcome, harvest_settle, harvest_status, label_to_string,
                              normalize_label, parse_iso8601, safe_case_name)
from tests.test_mcp import racket_available, run_racket  # noqa: E402

CASES = json.loads((TS_TEST / 'parity' / 'harvest-cases.json').read_text())


def norm(d):
    """The oracle writes snake_case keys; this engine's results use camelCase."""
    return {({'case_id': 'caseId'}.get(k, k)): v for k, v in d.items() if k != 'path'}
FIXED = lambda: 1800000000  # noqa: E731
ANSWERS = {
    'department': {'type': 'choice', 'choice': 'billing', 'confidence': 0.93,
                   'probabilities': {'billing': 0.93}},
    'frustration': {'type': 'score', 'score': 0.2, 'confidence': 0.9,
                    'probabilities': {'0': 0.8, '1': 0.2, '2': 0.0}},
    'refund-requested?': {'type': 'noul', 'noul': 0.1},
}


def capture_case():
    """What evaluate leaves behind, offline: decide on fixed answers."""
    from jevlang._engine import CompiledPolicy
    from jevlang._evaluate import fixture_from_run
    from tests.test_local import ticket_policy
    policy = CompiledPolicy(ticket_policy().to_json())
    built = policy.build_state({'ticket': 'please refund my invoice'})
    decision = policy.decide(ANSWERS, {'facts': built['facts']})
    from jevlang import _provider
    target = {'provider': _provider.Provider('typesafe', _provider.capabilities(), None, None),
              'model': 'jev-1.13.0', 'requestedEffort': None, 'effectiveEffort': None}
    result = {'output': ANSWERS, 'target': target, 'model': 'jev-1.13.0',
              'usage': {'input_tokens': 10}, 'requestId': None}
    fixture = fixture_from_run(name='capture', policy=policy, state=built['state'],
                               questions=policy.questions(built['state']), decision=decision,
                               result=result)
    return {'decision': decision, 'answers': ANSWERS, 'questions': policy.questions(built['state']),
            'fixture': fixture, 'state': built['state'], 'facts': built['facts']}


@unittest.skipUnless(racket_available() and TS_TEST.is_dir(), 'Racket and the monorepo are required')
class OracleTests(unittest.TestCase):
    def test_names_labels_and_the_lifecycle_as_racket_does(self):
        with tempfile.TemporaryDirectory() as oracle_store, tempfile.TemporaryDirectory() as store:
            oracle = run_racket('harvest-oracle.rkt', oracle_store)
            self.assertEqual([safe_case_name(n) for n in CASES['names']], oracle['names'])
            for label, want_label, want_string in zip(CASES['labels'], oracle['labels'],
                                                      oracle['strings']):
                if want_label is None:
                    with self.assertRaises(Exception):
                        normalize_label(label)
                else:
                    self.assertEqual(normalize_label(label), want_label)
                    self.assertEqual(label_to_string(normalize_label(label)), want_string)
            self.assertEqual(oracle['badLabels'], [None] * len(CASES['badLabels']))
            # The oracle's jsexpr->decision carries the action, so compare with
            # the rule set to route on both sides; the rule itself is checked
            # in HarvestTests.
            self.assertEqual([escalated_decision({'rule': 'route', 'action': d.get('action')})
                              for d in CASES['escalated']], oracle['escalated'])
            self.assertEqual([parse_iso8601(t) for t in CASES['times']], oracle['times'])

            # The lifecycle, in a store this test owns.
            case = capture_case()
            added = asyncio.run(harvest_add(store, case_id='ticket/42', fixture=case['fixture'],
                                            decision=case['decision'], source='tickets', now=FIXED))
            self.assertEqual(norm(added), {'caseId': 'ticket/42', 'where': 'pending',
                                          'label': None, 'strength': None, 'source': None,
                                          'status': 'added'})
            added_record = json.loads(Path(added['path']).read_text())
            ra = oracle['lifecycle']['added_record']
            self.assertEqual(added_record['case_id'], ra['case_id'])
            self.assertEqual(added_record['name'], ra['name'])
            self.assertEqual(added_record['decided_at'], ra['decided_at'])
            self.assertEqual(added_record['escalated'], ra['escalated'])
            self.assertEqual(added_record.get('source'), ra['source'])
            self.assertEqual(added_record.get('expect'), ra['expect'])
            self.assertEqual(len(added_record['outcomes']), len(ra['outcomes']))

            closed = asyncio.run(harvest_outcome(store, 'ticket/42', 'close',
                                                 labels={'department': 'billing'}, now=FIXED))
            self.assertEqual(norm(closed),
                             norm(oracle['lifecycle']['closed']))
            closed_record = json.loads(Path(closed['path']).read_text())
            rc = oracle['lifecycle']['closed_record']
            for key in ('label', 'label_strength', 'label_source', 'settled_at', 'labels'):
                self.assertEqual(closed_record.get(key), rc[key], key)

            corrected = asyncio.run(harvest_outcome(store, 'ticket/42', 'correction',
                                                    label='page:retention-oncall', now=FIXED))
            self.assertEqual(norm(corrected),
                             norm(oracle['lifecycle']['corrected']))
            self.assertEqual(json.loads(Path(corrected['path']).read_text())['label'],
                             oracle['lifecycle']['corrected_label'])

            second = asyncio.run(harvest_add(store, case_id='ticket/43',
                                             fixture=case['fixture'], decision=case['decision'],
                                             now=FIXED))
            self.assertEqual(norm(second),
                             norm(oracle['lifecycle']['second']))

            settled = asyncio.run(harvest_settle(store, after=0, now=lambda: FIXED() + 1))
            self.assertEqual([norm(row) for row in settled['settled']],
                             [norm(r) for r in oracle['lifecycle']['settled']])
            self.assertEqual(len(settled['skipped']), oracle['lifecycle']['skipped'])

            status = asyncio.run(harvest_status(store, after=0, now=lambda: FIXED() + 1))
            want_status = oracle['lifecycle']['status']
            self.assertEqual({k: v for k, v in status.items() if k != 'dir'}, want_status)


class HarvestTests(unittest.TestCase):
    def test_names_escape_and_cut(self):
        self.assertEqual(safe_case_name('ticket/42'), 'ticket%2F42')
        self.assertEqual(safe_case_name('.hidden'), '%2Ehidden')
        self.assertEqual(safe_case_name('Ticket%2F53'), 'Ticket%252F53')
        long_id = 'a' * 100
        cut = safe_case_name(long_id)
        self.assertLessEqual(len(cut), 64 + 1 + 16)
        self.assertIn('~', cut)

    def test_a_gate_or_band_that_fired_is_an_escalation(self):
        from jevlang._harvest import escalation_decision
        self.assertTrue(escalation_decision({'action': 'assign', 'target': 'q', 'rule': 'gate'}))
        self.assertTrue(escalated_decision({'action': 'assign', 'target': 'q', 'rule': 'band'}))
        self.assertFalse(escalated_decision({'action': 'assign', 'target': 'q', 'rule': 'route'}))

    def test_the_settle_rules_over_whole_histories(self):
        for history, expected in zip(CASES['histories'], [
                {'where': 'pending', 'label': None, 'strength': None, 'source': None},
                {'where': 'labeled', 'label': {'action': 'assign', 'target': 'q'}, 'strength': 'strong', 'source': 'close'},
                {'where': 'unlabeled', 'label': None, 'strength': None, 'source': 'close'},
                {'where': 'labeled', 'label': {'action': 'page', 'target': 'oncall'}, 'strength': 'strong', 'source': 'close'},
                {'where': 'labeled', 'label': {'action': 'assign', 'target': 'other'}, 'strength': 'strong', 'source': 'correction'},
                {'where': 'labeled', 'label': {'action': 'assign', 'target': 'second'}, 'strength': 'strong', 'source': 'correction'},
                {'where': 'labeled', 'label': {'action': 'assign', 'target': 'q'}, 'strength': 'weak', 'source': 'timeout'},
                {'where': 'unlabeled', 'label': None, 'strength': None, 'source': 'timeout'},
                {'where': 'unlabeled', 'label': None, 'strength': None, 'source': 'close'}]):
            self.assertEqual(derive_label({**history,
                                           'expect': history.get('expect') or None}), expected)

    def test_the_settle_rules_over_a_history(self):
        expect = {'action': 'assign', 'target': 'billing-queue'}
        close = lambda label: {'kind': 'close', 'label': label}  # noqa: E731
        self.assertEqual(derive_label({'outcomes': [close(None)], 'expect': expect}),
                         {'where': 'labeled', 'label': expect, 'strength': 'strong',
                          'source': 'close'})
        self.assertEqual(derive_label({'outcomes': [{'kind': 'correction',
                                                     'label': {'action': 'hold'}}]}),
                         {'where': 'labeled', 'label': {'action': 'hold'}, 'strength': 'strong',
                          'source': 'correction'})
        self.assertEqual(derive_label({'outcomes': [close(None)], 'escalated': True,
                                       'expect': expect}),
                         {'where': 'unlabeled', 'label': None, 'strength': None,
                          'source': 'close'})
        self.assertEqual(derive_label({'outcomes': [{'kind': 'timeout'}], 'expect': expect}),
                         {'where': 'labeled', 'label': expect, 'strength': 'weak',
                          'source': 'timeout'})
        self.assertEqual(derive_label({'outcomes': []}),
                         {'where': 'pending', 'label': None, 'strength': None, 'source': None})

    def test_a_correction_after_a_close_wins(self):
        with tempfile.TemporaryDirectory() as store:
            case = capture_case()
            asyncio.run(harvest_add(store, case_id='c1', fixture=case['fixture'],
                                    decision=case['decision'], now=FIXED))
            closed = asyncio.run(harvest_outcome(store, 'c1', 'close', label='hold', now=FIXED))
            self.assertEqual(closed['label'], {'action': 'hold'})
            corrected = asyncio.run(harvest_outcome(store, 'c1', 'correction',
                                                    label='assign:billing', now=FIXED))
            self.assertEqual(corrected['label'], {'action': 'assign', 'target': 'billing'})
            self.assertEqual(corrected['where'], 'labeled')

    def test_an_unknown_outcome_changes_nothing(self):
        with tempfile.TemporaryDirectory() as store:
            r = asyncio.run(harvest_outcome(store, 'nope', 'close', now=FIXED))
            self.assertEqual(r['status'], 'unknown')
            self.assertFalse(os.listdir(store))

    def test_a_duplicate_copy_is_resolved_by_history_length(self):
        with tempfile.TemporaryDirectory() as store:
            case = capture_case()
            name = safe_case_name('dup')
            for where in ('pending', 'labeled'):
                os.makedirs(os.path.join(store, where), exist_ok=True)
                Path(os.path.join(store, where, f'{name}.json')).write_text(json.dumps(
                    {'case_id': 'dup', 'outcomes': ([{'kind': 'close', 'label': None,
                                                      'labels': None, 'at': 'x'}] if where == 'labeled' else [])}))
            found = asyncio.run(harvest_find(store, 'dup'))
            self.assertEqual(found['where'], 'labeled')
            self.assertFalse(os.path.exists(os.path.join(store, 'pending', f'{name}.json')))

    def test_a_settled_case_is_left_alone(self):
        with tempfile.TemporaryDirectory() as store:
            case = capture_case()
            asyncio.run(harvest_add(store, case_id='s1', fixture=case['fixture'],
                                    decision=case['decision'], now=FIXED))
            asyncio.run(harvest_outcome(store, 's1', 'close', now=FIXED))
            again = asyncio.run(harvest_add(store, case_id='s1', fixture=case['fixture'],
                                            decision=case['decision'], now=FIXED))
            self.assertEqual(again['status'], 'settled')


if __name__ == '__main__':
    unittest.main()
