"""The portable dispatcher, natively: every behavior the TypeScript suite's
dispatch.test.mjs pins, the shared Racket oracle scenarios, and the asyncio
adversarial cases the port's design calls for. No network, no Node."""
from __future__ import annotations

import asyncio
import json
import os
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

from jevlang._dispatch import (  # noqa: E402
    DispatchError, act_handler, budget, cancel_scheduled, dispatch, dispatch_for_input,
    handler_chain, is_handler_chain, is_retry, make_dispatcher, outcome_declined,
    outcome_failed_steps, outcome_to_json, policy_targets_of, resolve, retry,
    run_due, stop_scheduler,
)
from jevlang._journal import memory_journal, sqlite_journal  # noqa: E402

PACKAGES = Path(__file__).resolve().parents[2]
TS_TEST = PACKAGES / 'test'


def decision(action, target, **extra):
    d = {
        'action': action, 'target': target, 'reason': None, 'data': None, 'rule': 'route',
        'clause': 0, 'source': None, 'line': None, 'file': None, 'model': None, 'provider': None,
        'requested_model': None, 'requested_effort': None, 'effective_effort': None,
        'request_id': None, 'stage': None, 'proposed': None, 'evidence': [], 'steps': [],
        'readings': [],
    }
    d.update(extra)
    return d


class Clock:
    def __init__(self, start):
        self.t = start

    def clock(self):
        return self.t

    def advance(self, ms):
        self.t += ms


def run(coro):
    return asyncio.run(asyncio.wait_for(coro, 30))


def _racket_available() -> bool:
    try:
        return (TS_TEST / 'dispatch-oracle.rkt').is_file() and subprocess.run(['racket', '--version'], capture_output=True).returncode == 0
    except FileNotFoundError:
        return False


def _racket(file):
    env = {**os.environ, 'TYPESAFE_API_KEY': '', 'ANTHROPIC_API_KEY': '', 'OPENAI_API_KEY': '',
           'JEV_PROVIDER': '', 'JEV_MODEL': '', 'JEV_EFFORT': ''}
    result = subprocess.run(['racket', str(TS_TEST / file)], capture_output=True, encoding='utf-8',
                            env=env, timeout=300, cwd=str(TS_TEST))
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def _ticket_policy():
    from tests.test_local import ticket_policy
    return ticket_policy()


class DispatchTests(unittest.TestCase):
    def test_a_dispatcher_checks_coverage_in_both_directions(self):
        ticket = _ticket_policy()
        handlers = {t: (lambda state, dec: 'ok') for t in
                    ('billing-queue', 'engineering-oncall', 'sales-inbox', 'retention-oncall', 'human-triage')}
        self.assertEqual(sorted(policy_targets_of(ticket.to_json())),
                         ['billing-queue', 'engineering-oncall', 'human-triage', 'retention-oncall', 'sales-inbox'])
        make_dispatcher(handlers, policy=ticket)
        incomplete = dict(handlers)
        del incomplete['sales-inbox']
        with self.assertRaisesRegex(Exception, 'no handler for'):
            make_dispatcher(incomplete, policy=ticket)
        make_dispatcher(incomplete, policy=ticket, default=lambda state, dec: 'ok')
        extra = dict(handlers)
        extra['sales-inboxx'] = lambda state, dec: 'ok'
        with self.assertRaisesRegex(Exception, 'never produces'):
            make_dispatcher(extra, policy=ticket)
        make_dispatcher(extra, policy=ticket, allow_extra=True)
        with self.assertRaisesRegex(Exception, 'never produces'):
            make_dispatcher(handlers, policy=ticket, guards={'sales-inboxx': lambda state, dec: True})

    def test_a_decision_is_handled_passed_through_or_raises(self):
        seen = []

        async def queue(state, dec, context):
            seen.append((state, dec['target']))
            return 'queued'

        d = make_dispatcher({'queue': queue})
        ran = run(dispatch(d, {'ticket': 'x'}, decision('assign', 'queue')))
        self.assertEqual(ran['status'], 'ran')
        self.assertEqual(ran['handler'], 'queue')
        self.assertEqual(ran['result'], 'queued')
        self.assertEqual(seen, [({'ticket': 'x'}, 'queue')])
        self.assertEqual(run(dispatch(d, {}, decision('hold', None)))['status'], 'passed')
        self.assertEqual(run(dispatch(d, {}, decision('next', 'stage-2')))['status'], 'passed')
        with self.assertRaisesRegex(DispatchError, "no handler for target 'queu'"):
            run(dispatch(d, {}, decision('assign', 'queu')))
        try:
            run(dispatch(d, {}, decision('assign', 'queu')))
        except DispatchError as error:
            self.assertIn("did you mean 'queue'", str(error))

    def test_a_handler_that_re_decides_is_re_dispatched(self):
        def triage(state, dec, context): return decision('assign', 'queue')
        def settled(state, dec, context): return dec
        def pingpong(state, dec, context): return decision('assign', 'pong')
        def pong(state, dec, context): return decision('assign', 'pingpong')
        d = make_dispatcher({
            'triage': triage,
            'queue': lambda state, dec, context: 'queued',
            'settled': settled,
            'pingpong': pingpong,
            'pong': pong,
        }, max_hops=4)
        o = run(dispatch(d, {}, decision('escalate', 'triage')))
        self.assertEqual(o['status'], 'ran')
        self.assertEqual(o['handler'], 'queue')
        self.assertEqual([k for k, _ in o['chain']], ['triage', 'queue'])
        # Returning the decision it was given is terminal, not a re-dispatch.
        self.assertEqual(run(dispatch(d, {}, decision('assign', 'settled')))['handler'], 'settled')
        with self.assertRaisesRegex(DispatchError, 'dispatch cycle'):
            run(dispatch(d, {}, decision('assign', 'pingpong')))

    def test_confirm_approves_declines_and_skips_the_doomed(self):
        asked = []
        clock = Clock(1000)

        def confirm(state, dec, context):
            asked.append(dec['proposed']['target'])
            return state.get('approve') is True

        actions = {'unlock': {'params': {'door': {'type': 'string'}}, 'confirm': True,
                              'cooldown': 30, 'allow': ['owner']}}
        d = make_dispatcher({'unlock': lambda state, dec, context: 'unlocked'}, confirm=confirm,
                            actions=actions, policy_targets=['unlock'], clock=clock.clock)
        proposed = decision('act', 'unlock', data={'door': 'front'})
        request = decision('confirm', 'unlock', proposed=proposed, data={'door': 'front'})
        owner = {'principal': {'roles': ['owner']}}
        approved = run(dispatch(d, {'approve': True}, request, **owner))
        self.assertEqual(approved['status'], 'ran')
        self.assertEqual(approved['result'], 'unlocked')
        self.assertEqual([k for k, _ in approved['chain']], ['confirm', 'unlock'])
        clock.advance(31000)
        declined = run(dispatch(d, {'approve': False}, request, **owner))
        self.assertEqual(declined['status'], 'declined')
        self.assertTrue(outcome_declined(declined))
        # A principal without the role is refused before anyone is asked.
        clock.advance(31000)
        forbidden = run(dispatch(d, {'approve': True}, request, principal={'roles': ['guest']}))
        self.assertEqual(forbidden['status'], 'forbidden')
        self.assertEqual(len(asked), 2)
        # No confirm handler at all is an error, not a silent act.
        bare = make_dispatcher({'unlock': lambda state, dec, context: 'unlocked'})
        with self.assertRaisesRegex(Exception, 'no confirm handler'):
            run(dispatch(bare, {}, request, **owner))

    def test_an_act_is_re_checked_cooled_down_budgeted_and_claimed_once(self):
        clock = Clock(10000)
        runs = []
        journal = memory_journal()

        def lights_on(params, state, dec):
            runs.append(params)
            return 'on'

        d = make_dispatcher({'lights-on': act_handler(lights_on)}, policy_targets=['lights-on'],
                            clock=clock.clock, journal=journal,
                            actions={'lights-on': {'params': {'room': {'type': 'member-of', 'field': 'rooms'}},
                                                   'cooldown': 5}},
                            budgets=[budget('calls', max=2, per=60)])

        def dec(room, id):
            return decision('act', 'lights-on', data={'room': room}, request_id=id)

        facts = {'rooms': ['kitchen', 'bedroom']}
        first = run(dispatch(d, {}, dec('kitchen', 'req-1'), facts=facts))
        self.assertEqual(first['status'], 'ran')
        self.assertEqual(runs[0], {'room': 'kitchen', 'idempotencyKey': 'req-1/lights-on'})
        # The same key again is a duplicate: the handler does not run twice.
        again = run(dispatch(d, {}, dec('kitchen', 'req-1'), facts=facts))
        self.assertEqual(again['status'], 'duplicate')
        self.assertEqual(len(runs), 1)
        # A cooldown that has not elapsed skips it, and the claim is released.
        self.assertEqual(run(dispatch(d, {}, dec('bedroom', 'req-2'), facts=facts))['status'], 'cooldown')
        clock.advance(6000)
        self.assertEqual(run(dispatch(d, {}, dec('bedroom', 'req-2'), facts=facts))['status'], 'ran')
        clock.advance(6000)
        # The third call in the window is over budget.
        self.assertEqual(run(dispatch(d, {}, dec('kitchen', 'req-3'), facts=facts))['status'], 'over-budget')
        # A parameter the facts do not allow is an action error, not a device call.
        with self.assertRaisesRegex(Exception, 'member-of'):
            run(dispatch(d, {}, dec('garage', 'req-4'), facts=facts))
        self.assertEqual(len(runs), 2)

    def test_a_key_that_started_and_never_finished_is_uncertain(self):
        journal = memory_journal()

        async def lock_door(state, dec, context):
            raise RuntimeError('the radio dropped')

        d = make_dispatcher({'lock-door': lock_door}, policy_targets=['lock-door'], journal=journal)
        dec = decision('act', 'lock-door', data={}, request_id='req-9')
        with self.assertRaisesRegex(Exception, 'the radio dropped'):
            run(dispatch(d, {}, dec))
        # The journal remembers the failure, so a retry of the same key is a
        # duplicate rather than a second attempt at the device.
        second = run(dispatch(d, {}, dec))
        self.assertEqual(second['status'], 'duplicate')
        # A claim left running (a process that died mid-run) is uncertain.
        journal.beginStep('req-10/lock-door', 'lock-door', 1)
        uncertain = run(dispatch(d, {}, decision('act', 'lock-door', data={}, request_id='req-10')))
        self.assertEqual(uncertain['status'], 'uncertain')
        self.assertIn('may have acted', uncertain['result'])

    def test_a_guard_runs_just_before_the_handler_and_a_dry_run_runs_nothing(self):
        counter = [0]

        def ship(state, dec, context):
            counter[0] += 1
            return 'shipped'

        d = make_dispatcher({'ship': ship}, guards={'ship': lambda state, dec: state.get('fresh') is True})
        self.assertEqual(run(dispatch(d, {'fresh': False}, decision('assign', 'ship')))['status'], 'guard-failed')
        self.assertEqual(run(dispatch(d, {'fresh': True}, decision('assign', 'ship')))['status'], 'ran')
        self.assertEqual(counter[0], 1)
        rehearsal = make_dispatcher({'ship': ship}, dry_run=True, guards={'ship': lambda state, dec: False})
        o = run(dispatch(rehearsal, {}, decision('assign', 'ship')))
        self.assertEqual(o['status'], 'dry-run')
        self.assertEqual([k for k, _ in o['chain']], ['ship'])
        self.assertEqual(counter[0], 1)

    def test_a_chain_tries_each_link_a_retry_repeats_and_exhaustion_names_links(self):
        calls = []

        def flaky(state, dec, context):
            calls.append('flaky')
            raise RuntimeError('timed out')

        async def nosleep(seconds):
            return None

        chain = handler_chain(
            lambda state, dec, context: (calls.append('cheap') or False),
            retry(flaky, attempts=2, backoff=0, sleep=nosleep),
            lambda state, dec, context: (calls.append('person') or 'queued for a person'),
        )
        self.assertTrue(is_handler_chain(chain))
        self.assertTrue(is_retry(chain.links[1]))
        d = make_dispatcher({'review': chain})
        o = run(dispatch(d, {}, decision('escalate', 'review')))
        self.assertEqual(o['result'], 'queued for a person')
        self.assertEqual(calls, ['cheap', 'flaky', 'flaky', 'person'])
        self.assertEqual((o['link']['key'], o['link']['index']), ('review', 2))

        def raise_nope(state, dec, context):
            raise RuntimeError('nope')

        hopeless = make_dispatcher({'review': handler_chain(lambda state, dec, context: False, raise_nope)})
        with self.assertRaisesRegex(DispatchError, "every link in the handler chain for 'review' failed or declined"):
            run(dispatch(hopeless, {}, decision('escalate', 'review')))
        try:
            run(dispatch(hopeless, {}, decision('escalate', 'review')))
        except DispatchError as error:
            self.assertIn('raised: nope', str(error))

    def _plan_maker(self, plan_failure, failing=True):
        ran = []

        def on(params, state, dec):
            ran.append(['on', params['room']])
            return 'on'

        def off(params, state, dec):
            ran.append(['off', params['room']])
            return 'off'

        def lock(params, state, dec):
            ran.append(['lock', params['door']])
            if failing:
                raise RuntimeError('the lock is jammed')
            return 'locked'

        schemas = {
            'lights-on': {'params': {'room': {'type': 'string'}},
                          'undo': {'target': 'lights-off', 'params': {'room': {'op': 'variable', 'args': ['room']}}}},
            'lights-off': {'params': {'room': {'type': 'string'}}},
            'lock-door': {'params': {'door': {'type': 'string'}}},
        }
        d = make_dispatcher({
            'lights-on': act_handler(on),
            'lights-off': act_handler(off),
            'lock-door': act_handler(lock),
        }, policy_targets=['lights-on', 'lights-off', 'lock-door'], plan_failure=plan_failure,
            actions=schemas)
        return d, ran

    def test_a_plan_runs_step_by_step_and_stops_continues_or_rolls_back(self):
        steps = [
            decision('act', 'lights-on', data={'room': 'kitchen'}),
            decision('act', 'lock-door', data={'door': 'front'}),
            decision('act', 'lights-on', data={'room': 'bedroom'}),
        ]
        plan_decision = decision('plan', None, steps=steps, reason='3 steps')

        ok, _ = self._plan_maker('stop', failing=False)
        fine = run(dispatch(ok, {}, plan_decision))
        self.assertEqual(fine['status'], 'ran')
        self.assertEqual([s['status'] for s in fine['steps']], ['ran', 'ran', 'ran'])

        stopping, _ = self._plan_maker('stop')
        stopped = run(dispatch(stopping, {}, plan_decision))
        self.assertEqual(stopped['status'], 'error')
        self.assertEqual([s['status'] for s in stopped['steps']], ['ran', 'error', 'not-run'])
        self.assertEqual(len(outcome_failed_steps(stopped)), 1)

        continuing, _ = self._plan_maker('continue')
        carried = run(dispatch(continuing, {}, plan_decision))
        self.assertEqual([s['status'] for s in carried['steps']], ['ran', 'error', 'ran'])

        undoing, ran = self._plan_maker('rollback')
        rolled = run(dispatch(undoing, {}, plan_decision))
        self.assertEqual(rolled['status'], 'rolled-back')
        self.assertEqual([s['status'] for s in rolled['steps'][:3]], ['rolled-back', 'error', 'not-run'])
        # The inverse is a declared action, not a snapshot: it turned the light off.
        self.assertEqual(ran, [['on', 'kitchen'], ['lock', 'front'], ['off', 'kitchen']])

    def test_rollback_undoes_newest_first_and_a_failing_undo_leaves_error(self):
        ran = []

        def on(params, state, dec):
            ran.append(['on', params['room']])
            return 'on'

        def off(params, state, dec):
            ran.append(['off', params['room']])
            if params['room'] == 'bedroom':
                raise RuntimeError('the switch is stuck')
            return 'off'

        def lock(params, state, dec):
            ran.append(['lock', params['door']])
            raise RuntimeError('the lock is jammed')

        schemas = {
            'lights-on': {'params': {'room': {'type': 'string'}},
                          'undo': {'target': 'lights-off', 'params': {'room': {'op': 'variable', 'args': ['room']}}}},
            'lights-off': {'params': {'room': {'type': 'string'}}},
            'lock-door': {'params': {'door': {'type': 'string'}}},
        }
        d = make_dispatcher({
            'lights-on': act_handler(on), 'lights-off': act_handler(off), 'lock-door': act_handler(lock),
        }, policy_targets=['lights-on', 'lights-off', 'lock-door'], plan_failure='rollback', actions=schemas)
        plan_decision = decision('plan', None, steps=[
            decision('act', 'lights-on', data={'room': 'kitchen'}),
            decision('act', 'lights-on', data={'room': 'bedroom'}),
            decision('act', 'lock-door', data={'door': 'front'}),
        ], reason='3 steps')
        rolled = run(dispatch(d, {}, plan_decision))
        # Newest ran step is undone first; the stuck undo leaves the plan in error.
        self.assertEqual(ran, [['on', 'kitchen'], ['on', 'bedroom'], ['lock', 'front'],
                               ['off', 'bedroom'], ['off', 'kitchen']])
        self.assertEqual(rolled['status'], 'error')
        # Only the step whose declared inverse ran is marked rolled-back; the
        # bedroom light's undo raised, so it keeps its own status.
        self.assertEqual([s['status'] for s in rolled['steps'][:3]], ['rolled-back', 'ran', 'error'])
        self.assertEqual([s['status'] for s in rolled['steps'][3:]], ['error', 'ran'])

    def test_a_schedule_is_held_runs_when_due_and_cancels(self):
        clock = Clock(1000000)
        with tempfile.TemporaryDirectory() as folder:
            journal = sqlite_journal(str(Path(folder) / 'schedule.sqlite'))
            ran, scheduled = [], []

            def lights_off(params, state, dec):
                ran.append(params['room'])
                return 'off'

            d = make_dispatcher({'lights-off': act_handler(lights_off)}, policy_targets=['lights-off'],
                                clock=clock.clock, journal=journal, auto_run_due=False,
                                actions={'lights-off': {'params': {'room': {'type': 'string'}}}},
                                on_scheduled=lambda key, outcome: scheduled.append((key, outcome['status'])))
            later = decision('schedule', None, data={'seconds': 600}, request_id='req-s',
                             proposed=decision('act', 'lights-off', data={'room': 'kitchen'}))
            held = run(dispatch(d, {'home': True}, later))
            self.assertEqual(held['status'], 'scheduled')
            self.assertEqual(held['result'], 'req-s/schedule')
            self.assertEqual(len(ran), 0)
            self.assertEqual(run(run_due(d)), 0)
            clock.advance(600000)
            self.assertEqual(run(run_due(d)), 1)
            self.assertEqual(ran, ['kitchen'])
            self.assertEqual(scheduled, [('req-s/schedule', 'ran')])
            # Cancelling removes pending work.
            run(dispatch(d, {}, dict(later, request_id='req-t')))
            self.assertTrue(cancel_scheduled(d, 'req-t/schedule'))
            clock.advance(600000)
            self.assertEqual(run(run_due(d)), 0)
            stop_scheduler(d)
            journal.close()

    def test_a_handler_that_passes_its_deadline_is_reported_not_waited_out(self):
        async def slow(state, dec, context):
            await asyncio.sleep(0.3)
            return 'late'

        d = make_dispatcher({'slow': slow}, timeout=0.05)
        started = time.monotonic()
        with self.assertRaises(DispatchError) as caught:
            run(dispatch(d, {}, decision('assign', 'slow')))
        self.assertEqual(caught.exception.kind, 'timeout')
        self.assertIn('may already have acted', str(caught.exception))
        self.assertLess(time.monotonic() - started, 0.25)
        # Let the left-running handler settle so the loop closes cleanly.
        run(asyncio.sleep(0.35))

    def test_the_audit_record_carries_hops_link_confirmation_and_steps(self):
        def link2(state, dec, context):
            return decision('assign', 'queue')

        d = make_dispatcher({
            'triage': handler_chain(lambda state, dec, context: False, link2),
            'queue': lambda state, dec, context: 'queued',
        })
        record = outcome_to_json(run(dispatch(d, {}, decision('escalate', 'triage', reason='unclear'))))
        self.assertEqual(record['status'], 'ran')
        self.assertEqual(record['handler'], 'queue')
        self.assertIs(record['rehandled'], True)
        self.assertEqual([hop['key'] for hop in record['chain']], ['triage', 'queue'])
        self.assertEqual(record['link']['index'], 1)
        self.assertIsNone(record['confirmed'])
        self.assertEqual(record['final']['target'], 'queue')
        self.assertEqual(record['result'], 'queued')

    def test_handlers_receive_the_state_the_policy_built_unless_asked_otherwise(self):
        seen = []
        ticket = _ticket_policy()
        handlers = {t: (lambda state, dec, context: (seen.append(state) or 'ok')) for t in
                    ('billing-queue', 'engineering-oncall', 'sales-inbox', 'retention-oncall', 'human-triage')}
        d = make_dispatcher(handlers, policy=ticket)
        card_input = {'ticket': 'card 4111111111111111, mail jane@example.com'}
        dec = decision('assign', 'billing-queue')
        run(dispatch_for_input(d, card_input, dec))
        # The handler sees the state the policy built, not the caller's input object.
        self.assertEqual(seen[0], ticket.build_state(card_input)['state'])
        outcome = run(resolve(lambda raw_input: dec, d, card_input))
        self.assertEqual(outcome['status'], 'ran')
        run(dispatch_for_input(d, card_input, dec, raw_state=True))
        self.assertEqual(seen[2], card_input)

    def test_a_cancelled_dispatch_surfaces_as_uncertain_not_success(self):
        async def scenario():
            journal = memory_journal()
            started = asyncio.Event()

            async def lock_door(state, dec, context):
                started.set()
                await asyncio.sleep(0.2)
                return 'locked'

            d = make_dispatcher({'lock-door': lock_door}, policy_targets=['lock-door'], journal=journal)
            task = asyncio.ensure_future(
                dispatch(d, {}, decision('act', 'lock-door', data={}, request_id='req-c')))
            await started.wait()
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
            # The claim is still running: a re-dispatch of the same key reports
            # that the handler may already have acted, and never re-runs it.
            return await dispatch(d, {}, decision('act', 'lock-door', data={}, request_id='req-c'))

        second = run(scenario())
        self.assertEqual(second['status'], 'uncertain')
        self.assertIn('may have acted', second['result'])

    def test_cooldown_contention_two_concurrent_dispatches_one_winner(self):
        async def scenario():
            journal = memory_journal()
            ran = []

            async def lights_on(state, dec, context):
                ran.append(dec['data']['room'])
                await asyncio.sleep(0.01)
                return 'on'

            d = make_dispatcher({'lights-on': lights_on}, policy_targets=['lights-on'],
                                clock=lambda: 1000000, journal=journal,
                                actions={'lights-on': {'params': {'room': {'type': 'string'}}, 'cooldown': 60}})
            results = await asyncio.gather(
                dispatch(d, {}, decision('act', 'lights-on', data={'room': 'kitchen'}, request_id='req-a')),
                dispatch(d, {}, decision('act', 'lights-on', data={'room': 'bedroom'}, request_id='req-b')))
            return results, ran

        results, ran = run(scenario())
        # One memory journal, two dispatches in flight: the cooldown claim is
        # atomic, so exactly one runs and the other is skipped.
        self.assertEqual(sorted(o['status'] for o in results), ['cooldown', 'ran'])
        self.assertEqual(len(ran), 1)

    def test_budget_contention_shares_one_window(self):
        async def scenario():
            journal = memory_journal()

            async def nudge(state, dec, context):
                return 'nudged'

            d = make_dispatcher({'nudge-thermostat': nudge}, policy_targets=['nudge-thermostat'],
                                clock=lambda: 1000000, journal=journal,
                                budgets=[budget('calls', max=1, per=60)])
            return await asyncio.gather(*[
                dispatch(d, {}, decision('act', 'nudge-thermostat', data={'direction': 'warmer'},
                                         request_id=f'req-{i}'))
                for i in range(3)])

        statuses = sorted(o['status'] for o in run(scenario()))
        self.assertEqual(statuses, ['over-budget', 'over-budget', 'ran'])

    def test_the_scheduler_runs_due_work_on_the_loop(self):
        async def scenario():
            clock = Clock(1000000)
            ran = []

            def lights_off(params, state, dec):
                ran.append(params['room'])
                return 'off'

            d = make_dispatcher({'lights-off': act_handler(lights_off)}, policy_targets=['lights-off'],
                                clock=clock.clock, journal=memory_journal(),
                                actions={'lights-off': {'params': {'room': {'type': 'string'}}}})
            later = decision('schedule', None, data={'seconds': 600}, request_id='req-w',
                             proposed=decision('act', 'lights-off', data={'room': 'attic'}))
            held = await dispatch(d, {}, later)
            self.assertEqual(held['status'], 'scheduled')
            clock.advance(600000)
            await asyncio.sleep(0.05)
            stop_scheduler(d)
            return ran

        self.assertEqual(run(scenario()), ['attic'])


def _behaviour(b):
    """A handler built from data: "ok", "decline", {raise}, {decide}, {chain}."""
    if b == 'ok':
        return lambda state, dec, context=None: 'ok'
    if b == 'decline':
        return lambda state, dec, context=None: False
    if isinstance(b, dict) and b.get('raise'):
        message = b['raise']

        def raiser(state, dec, context=None):
            raise RuntimeError(message)
        return raiser
    if isinstance(b, dict) and b.get('decide'):
        j = b['decide']

        def decider(state, dec, context=None):
            return {**decision(j['action'], j.get('target') if j.get('target') is not None else None),
                    'data': j.get('data') if j.get('data') is not None else None}
        return decider
    if isinstance(b, dict) and b.get('chain'):
        return handler_chain(*[_behaviour(link) for link in b['chain']])
    raise ValueError(f'unknown behaviour {json.dumps(b)}')


def _scenario_decision(j):
    d = decision(j['action'], j.get('target') if j.get('target') is not None else None)
    d['reason'] = j.get('reason') if j.get('reason') is not None else None
    d['data'] = j.get('data') if j.get('data') is not None else None
    d['proposed'] = _scenario_decision(j['proposed']) if j.get('proposed') else None
    d['steps'] = [_scenario_decision(s) for s in (j.get('steps') or [])]
    d['rule'] = None
    d['clause'] = None
    return d


def _comparable(record):
    return {
        'status': record['status'], 'handler': record['handler'], 'result': record['result'],
        'rehandled': record['rehandled'], 'confirmed': record['confirmed'],
        'action': record['action'], 'target': record['target'], 'data': record['data'],
        'chain': record['chain'],
        'link': ({'key': record['link']['key'], 'index': record['link']['index']}
                 if record.get('link') else None),
        'final': ({'action': record['final']['action'], 'target': record['final']['target'],
                   'data': record['final']['data']} if record.get('final') else None),
        'steps': [_comparable(s) for s in record['steps']],
    }


@unittest.skipUnless(_racket_available() and TS_TEST.is_dir(), 'Racket and the monorepo are required')
class DispatchOracleTests(unittest.TestCase):
    def test_racket_oracle_cascade_dispatch_over_the_shared_scenarios(self):
        from tests.test_local import smart_home_policy
        expected = _racket('dispatch-oracle.rkt')
        scenarios = json.loads((TS_TEST / 'parity' / 'dispatch-scenarios.json').read_text())
        self.assertEqual(len(scenarios), len(expected))
        home = smart_home_policy().to_json()
        for i, s in enumerate(scenarios):
            want = expected[i]
            self.assertEqual(want['name'], s['name'])
            handlers = {target: _behaviour(b) for target, b in (s.get('handlers') or {}).items()}
            d = make_dispatcher(handlers, policy=home, actions=home.get('actions'),
                                policy_targets=list(handlers), allow_extra=True,
                                guards={target: (lambda allow: lambda state, dec: bool(allow))(allow)
                                        for target, allow in (s.get('guards') or {}).items()},
                                budgets=[budget(b['name'], max=b['max'], per=b['per']) for b in (s.get('budgets') or [])],
                                dry_run=s.get('dry_run') is True,
                                plan_failure=s.get('plan_failure') if s.get('plan_failure') is not None else 'stop',
                                clock=lambda: 1000000,
                                confirm=lambda state, dec, context=None: s.get('confirm') is not False,
                                auto_run_due=False)
            try:
                o = run(dispatch(d, {'request': 'the request'}, _scenario_decision(s['decision']),
                                 principal=s.get('principal') if s.get('principal') is not None else None,
                                 key=s.get('key') if s.get('key') is not None else None,
                                 facts=s.get('facts') if s.get('facts') is not None else None))
                self.assertNotIn('error', want, f"{s['name']}: expected an error, got {o['status']}")
                mine = _comparable(outcome_to_json(o))
                self.assertEqual(mine, _comparable(want['outcome']), s['name'])
            except Exception as error:
                if isinstance(error, AssertionError):
                    raise
                self.assertIn('error', want, f"{s['name']}: unexpected {error}")
                # Both implementations name the target and why nothing ran.
                self.assertRegex(str(error), 'failed or declined|no handler for target', s['name'])


if __name__ == '__main__':
    unittest.main()
