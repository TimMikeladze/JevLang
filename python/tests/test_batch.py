"""Batch and pipeline, mirroring packages/jevlang/test/batch.test.mjs offline.

A clock and a sleep that move only when the code asks them to, so pacing is
deterministic and the test takes no time.
"""
import unittest

from jevlang import _evaluate as evaluate
from jevlang._batch import evaluate_many, make_pacer
from jevlang._pipeline import default_next_input, pipeline_to_json, run_pipeline, top_options


class FakeTime:
    def __init__(self):
        self.now = 0.0

    def clock(self):
        return self.now

    async def sleep(self, seconds):
        self.now += seconds * 1000

    def at(self):
        return self.now


class BatchTest(unittest.TestCase):
    def setUp(self):
        self.time = FakeTime()
        # Whatever accounting a previous test left installed is restored below.
        self.saved = (evaluate.settings.on_usage, evaluate.settings.pacer,
                      evaluate.settings.on_retry_after, evaluate.settings.transport,
                      evaluate.settings.api_key, evaluate.settings.sleep, evaluate.settings.clock)

    def tearDown(self):
        (evaluate.settings.on_usage, evaluate.settings.pacer,
         evaluate.settings.on_retry_after, evaluate.settings.transport,
         evaluate.settings.api_key, evaluate.settings.sleep, evaluate.settings.clock) = self.saved

    def test_order_failed_and_tokens(self):
        import asyncio

        rows = ['a', 'b', 'c', 'd']
        seen = []

        async def row_evaluate(row):
            sink = evaluate.settings.on_usage
            if sink:
                sink({'input_tokens': 10})
            if row == 'c':
                raise RuntimeError('no answer for c')
            return {'action': 'assign', 'target': row.upper()}

        async def on_result(i, r):
            seen.append(i)

        report = asyncio.run(evaluate_many(row_evaluate, rows, workers=2, rpm=None,
                                           tokens_per_second=None, clock=self.time.clock,
                                           sleep=self.time.sleep, on_result=on_result))
        self.assertEqual([r.get('target') if isinstance(r, dict) else str(r)
                          for r in report['results']],
                         ['A', 'B', 'no answer for c', 'D'])
        self.assertEqual(report['failed'], 1)
        self.assertEqual(report['tokens'], 40)
        self.assertGreater(report['cost'], 0)
        self.assertEqual(sorted(seen), [0, 1, 2, 3])
        # The batch restores whatever accounting was installed around it.
        self.assertIsNone(evaluate.settings.on_usage)

    def test_pacer_spaces_reserves_and_honours_retry_after(self):
        import asyncio
        pacer = make_pacer(rpm=600, tokens_per_second=1000,
                           sleep=self.time.sleep, clock=self.time.clock)
        asyncio.run(pacer.acquire())
        self.assertEqual(self.time.at(), 0)
        # 600 a minute is one start every 100 ms.
        asyncio.run(pacer.acquire())
        self.assertEqual(self.time.at(), 100)
        # Once a call's usage is known, a start reserves that many tokens; with
        # a bucket of 1000 a second, a 900-token average waits for the refill.
        pacer.observe({'input_tokens': 900})
        before = self.time.at()
        asyncio.run(pacer.acquire())
        self.assertGreaterEqual(self.time.at() - before, 100)
        # A server's retry-after pauses every start until it has passed.
        pacer.pause(2)
        paused = self.time.at()
        asyncio.run(pacer.acquire())
        self.assertGreaterEqual(self.time.at() - paused, 2000)

    def test_batch_paces_the_calls_through_the_client(self):
        import asyncio
        evaluate.settings.api_key = 'test-key'

        async def transport(payload):
            return {'answers': {'q': {'type': 'noul', 'noul': 0.5}}, 'model': 'm',
                    'usage': {'input_tokens': 100}}
        evaluate.settings.transport = transport
        evaluate.settings.sleep = self.time.sleep
        evaluate.settings.clock = self.time.clock

        async def row_evaluate(_row):
            response = await evaluate.jev_call({'row': 1}, {'q': {'type': 'noul'}})
            return {'action': 'assign', 'target': response['model']}

        report = asyncio.run(evaluate_many(row_evaluate, [1, 2, 3], workers=3, rpm=600,
                                           tokens_per_second=None, clock=self.time.clock,
                                           sleep=self.time.sleep))
        self.assertEqual(report['failed'], 0)
        self.assertEqual(report['tokens'], 300)
        # Three starts, 100 ms apart.
        self.assertGreaterEqual(self.time.at(), 200)

    def test_empty_rows(self):
        import asyncio

        async def row_evaluate(row):
            return {'action': 'assign', 'target': row}
        report = asyncio.run(evaluate_many(row_evaluate, []))
        self.assertEqual(report, {'results': [], 'failed': 0, 'tokens': 0, 'cost': 0.0,
                                  'usage_complete': True, 'unreported_calls': 0})


class PipelineTest(unittest.TestCase):
    def setUp(self):
        self.saved_usage = evaluate.settings.on_usage

    def tearDown(self):
        evaluate.settings.on_usage = self.saved_usage

    def test_hands_off_sums_usage_and_refuses_to_loop(self):
        import asyncio

        def usage(u):
            sink = evaluate.settings.on_usage
            if sink:
                sink(u)

        async def triage(_input):
            usage({'input_tokens': 10, 'output_tokens': 2})
            return {'action': 'next', 'target': 'severity', 'data': {'dept': 'billing'}}

        async def severity(input):
            usage({'input_tokens': 5, 'output_tokens': 1})
            return {'action': 'assign', 'target': f"{input['previous']['data']['dept']}-queue"}

        result = asyncio.run(run_pipeline({'triage': triage, 'severity': severity},
                                          {'ticket': 'a refund'}, start='triage'))
        self.assertEqual(result['decision']['target'], 'billing-queue')
        self.assertEqual([stage for stage, _ in result['steps']], ['triage', 'severity'])
        self.assertEqual(result['usage'], {'input_tokens': 15, 'output_tokens': 3})
        # Every stage says which stage it was.
        self.assertEqual([s['stage'] for s in pipeline_to_json(result)['steps']],
                         ['triage', 'severity'])
        self.assertEqual(result['decision']['stage'], 'severity')

        async def to_b(_input):
            return {'action': 'next', 'target': 'b'}

        async def to_a(_input):
            return {'action': 'next', 'target': 'a'}
        looping = {'a': to_b, 'b': to_a}
        with self.assertRaisesRegex(Exception, "reached stage 'a' twice"):
            asyncio.run(run_pipeline(looping, {}, start='a'))

        async def nowhere(_input):
            return {'action': 'next', 'target': 'nowhere'}
        with self.assertRaisesRegex(Exception, 'does not have'):
            asyncio.run(run_pipeline({'a': nowhere}, {}, start='a'))

        async def to_c(_input):
            return {'action': 'next', 'target': 'c'}

        async def to_d(_input):
            return {'action': 'next', 'target': 'd'}
        endless = {'a': to_b, 'b': to_c, 'c': to_d, 'd': to_a}
        with self.assertRaisesRegex(Exception, 'without a final decision'):
            asyncio.run(run_pipeline(endless, {}, start='a', max_requests=3))

        async def not_a_decision(_input):
            return 'not a decision'
        with self.assertRaisesRegex(Exception, 'did not return a decision'):
            asyncio.run(run_pipeline({'a': not_a_decision}, {}, start='a'))

    def test_builder_and_top_options(self):
        import asyncio

        async def shortlist(_input):
            return {'action': 'next', 'target': 'pick',
                    'data': {'answer': {'probabilities': {'billing': 0.5, 'technical': 0.3, 'sales': 0.2}}}}

        async def pick(input):
            return {'action': 'assign', 'target': '+'.join(input['options'])}

        def build(previous, decision):
            return {**previous, 'options': top_options(decision['data']['answer'], 2)}
        result = asyncio.run(run_pipeline({'shortlist': shortlist, 'pick': [pick, build]},
                                          {'ticket': 'x'}, start='shortlist'))
        self.assertEqual(result['decision']['target'], 'billing+technical')
        # Ties are broken by the key, so a shortlist is stable.
        self.assertEqual(top_options({'probabilities': {'b': 0.4, 'a': 0.4, 'c': 0.2}}, 2), ['a', 'b'])
        self.assertEqual(top_options({'probabilities': {'a': 1}}, 5), ['a'])
        with self.assertRaisesRegex(Exception, 'probabilities'):
            top_options({}, 1)
        # Without a builder the previous input carries the previous decision.
        self.assertEqual(default_next_input({'ticket': 'x'}, {'action': 'next', 'target': 'b'}),
                         {'ticket': 'x', 'previous': {'action': 'next', 'target': 'b'}})
        self.assertEqual(default_next_input('plain text', {'action': 'next'}),
                         {'input': 'plain text', 'previous': {'action': 'next'}})


if __name__ == '__main__':
    unittest.main()
