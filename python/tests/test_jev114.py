"""Jev 1.14 native tests: no model calls, SDK, Racket or Node required."""
import asyncio
import copy
import json
import struct
import unittest
import zlib
from jevlang import Policy, box, noul, gate, rule, assign, hold, escalate, all_of, compute, image_asset
from jevlang._assets import inspect_assets, asset_identity
from jevlang._budgets import check_request_budget
from jevlang import _evaluate as evaluate


def png(width=280, height=280, byte=0):
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
    pixels = (b'\0' + bytes([byte]) * (width * 3)) * height
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(pixels)) + chunk(b'IEND', b''))


def policy():
    present, mug = noul('present', 'Is a mug in `photo`?'), box('mug', 'The mug in `photo`')
    return Policy(name='localize', typesafe={'experimental': {'images': True}}, questions=[present, mug],
                  gates=[gate(mug, .8, escalate('review'), onRead=True)],
                  route={'clauses': [rule(all_of(present.yes(.9), compute('lt', mug.left(), .5)),
                                          assign('found', data=mug.value()))], 'otherwise': hold()})


def answers(confidence=.9, present=.99):
    return {'present': {'type': 'noul', 'noul': present},
            'mug': {'type': 'box', 'box': {'left': .1, 'right': .8, 'top': .2, 'bottom': .9}, 'confidence': confidence}}


class AssetsAndLanguageTests(unittest.TestCase):
    def test_assets_are_portable_and_content_identity_ignores_reference_names(self):
        image = image_asset(png(), format='png')
        first = inspect_assets({'image-a': image}, {'photo': 'image-a'}, {})
        second = inspect_assets({'image-b': image}, {'photo': 'image-b'}, {})
        self.assertEqual(first['image-a']['width'], 280)
        self.assertEqual(asset_identity({'photo': 'image-a'}, {}, first), asset_identity({'photo': 'image-b'}, {}, second))
        with self.assertRaisesRegex(Exception, 'referenced'):
            inspect_assets({'unused': image}, 'hello', {})
        with self.assertRaises(Exception): image_asset(png(279), format='png')
        with self.assertRaises(Exception): image_asset(bytes.fromhex('ffd8ffc00008080118011800'), format='jpg')

    def test_box_decides_offline_and_null_confidence_falls_back(self):
        p = policy()
        self.assertEqual(p.decide(answers())['target'], 'found')
        self.assertEqual(p.decide(answers(None))['target'], 'review')
        self.assertEqual(p.decide(answers(None, .01))['action'], 'hold')
        broken = answers(); broken['mug']['box']['left'] = .99
        with self.assertRaises(Exception): p.decide(broken)
        self.assertEqual(Policy.from_json(p.to_json()).to_json(), p.to_json())

    def test_long_context_checks_independent_request_and_question_limits(self):
        with self.assertRaisesRegex(Exception, 'per-question'): check_request_budget('x' * 140000, {})
        check_request_budget('x' * 140000, {}, {'experimental': {'longContext': True}})
        with self.assertRaisesRegex(Exception, 'per-request'):
            check_request_budget('', {str(i): {'type': 'noul', 'instructions': 'x' * 80000} for i in range(4)})


class EvaluationTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.old = vars(evaluate.settings).copy()
        evaluate.settings.environment = lambda name: None
        evaluate.settings.default_model = None
        self.sent = []
        async def transport(payload, options=None):
            self.sent.append((payload, options))
            return {'answers': answers(), 'model': payload['model'], 'usage': {'input_tokens': 10}}
        evaluate.settings.transport = transport

    def tearDown(self): vars(evaluate.settings).update(self.old)

    async def test_image_evaluation_caches_contents_and_preserves_provenance(self):
        p, cache, image = policy(), {}, image_asset(png(), format='png')
        first = await evaluate.evaluate_with_provider(p, {'photo': 'image-a'}, assets={'image-a': image}, cache=cache)
        second = await evaluate.evaluate_with_provider(p, {'photo': 'image-b'}, assets={'image-b': image}, cache=cache)
        self.assertEqual(first['model'], 'jev-1.14.0')
        self.assertTrue(second['cached'])
        self.assertEqual(len(self.sent), 1)
        self.assertEqual(self.sent[0][1]['headers']['TypeSafe-Danger-Zone-Images'], 'true')

    async def test_image_and_box_opt_in_and_model_constraints(self):
        image = image_asset(png(), format='png')
        with self.assertRaises(Exception):
            await evaluate.jev_call({'photo': 'image-a'}, policy().questions(), assets={'image-a': image})
        with self.assertRaises(Exception):
            await evaluate.jev_call({'photo': 'image-a'}, policy().questions(), model='jev-1.13.0', assets={'image-a': image}, experimental={'images': True})
        self.assertFalse(self.sent)


class FixtureAndUsageTests(unittest.TestCase):
    def test_image_fixture_roundtrip_and_separate_verification(self):
        from jevlang._fixtures import replay
        from jevlang._engine import CompiledPolicy
        from jevlang._provider import Provider
        p = CompiledPolicy(policy().to_json()); image = image_asset(png(), format='png')
        inspected = inspect_assets({'photo': image}, {'photo': 'photo'}, p.questions())
        from jevlang._assets import asset_manifest
        result = {'output': answers(), 'target': {'provider': evaluate.typesafe_provider(), 'model': 'jev-1.14.0'}, 'assets': asset_manifest(inspected), 'experimental': {'images': True}, 'usage': {'input_tokens': None}}
        fixture = evaluate.fixture_from_run(name='image', policy=p, state={'photo': 'photo'}, questions=p.questions(), result=result, decision=p.decide(answers()))
        self.assertEqual(fixture['fixture_version'], 4)
        row = replay(p, [fixture])[0]
        self.assertTrue(row['decisionVerified']); self.assertFalse(row['assetsVerified'])
        self.assertTrue(replay(p, [fixture], {'assets': {'photo': image}})[0]['assetsVerified'])
        self.assertEqual(replay(p, [fixture], {'assets': {'photo': image_asset(png(byte=1), format='png')}})[0]['status'], 'error')

    def test_unreported_cost_and_image_estimates_stay_unknown(self):
        from jevlang._cost import usage_cost, cost
        from jevlang._engine import CompiledPolicy
        self.assertIsNone(usage_cost({'input_tokens': None}))
        self.assertEqual(usage_cost({'input_tokens': 0}), 0)
        report = cost(CompiledPolicy(policy().to_json()), input={'photo': 'photo'}, assets={'photo': image_asset(png(), format='png')})
        self.assertIsNone(report['per_call']['tokens'])
        self.assertIsNone(report['per_call']['usd'])


class NativeHttpTests(unittest.IsolatedAsyncioTestCase):
    async def test_http_get_models_and_compressed_post(self):
        from jevlang._http import request_http
        seen = []
        async def handle(reader, writer):
            head = await reader.readuntil(b'\r\n\r\n'); seen.append(head)
            length = next((int(v.split(b':')[1]) for v in head.split(b'\r\n') if v.lower().startswith(b'content-length:')), 0)
            if length: seen.append(await reader.readexactly(length))
            body = b'{"models":[{"name":"jev-1.14.0","description":"test","release_date":"2026-10-01"}]}'
            writer.write(b'HTTP/1.1 200 OK\r\nContent-Length: '+str(len(body)).encode()+b'\r\n\r\n'+body)
            await writer.drain(); writer.close(); await writer.wait_closed()
        server = await asyncio.start_server(handle, '127.0.0.1', 0)
        old = vars(evaluate.settings).copy()
        try:
            evaluate.settings.transport = None; evaluate.settings.api_key = 'test'
            evaluate.settings.base_url = f'http://127.0.0.1:{server.sockets[0].getsockname()[1]}'
            models = await evaluate.list_models()
            self.assertEqual(models['models'][0]['name'], 'jev-1.14.0')
            self.assertIn(b'GET /v1/models ', seen[0])
        finally:
            vars(evaluate.settings).update(old); server.close(); await server.wait_closed()

    async def test_cancellation_closes_stalled_socket(self):
        from jevlang._http import request_http
        connected, closed = asyncio.Event(), asyncio.Event()
        async def handle(reader, writer):
            await reader.readuntil(b'\r\n\r\n'); connected.set()
            await reader.read(); closed.set(); writer.close(); await writer.wait_closed()
        server = await asyncio.start_server(handle, '127.0.0.1', 0)
        try:
            task = asyncio.create_task(request_http(f'http://127.0.0.1:{server.sockets[0].getsockname()[1]}', 'GET', {}))
            await asyncio.wait_for(connected.wait(), 1)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError): await task
            await asyncio.wait_for(closed.wait(), 1)
        finally: server.close(); await server.wait_closed()

class SharedGoldenTests(unittest.TestCase):
    def test_standalone_javascript_golden(self):
        from pathlib import Path
        from jevlang._engine import CompiledPolicy
        from jevlang._assets import asset_manifest
        from jevlang._common import fingerprint, equal
        fixture = json.loads((Path(__file__).parent / 'fixtures/jev114-shared.json').read_text())
        p = CompiledPolicy(fixture['policy']); state = fixture['state']; questions = p.questions(state)
        images = inspect_assets(fixture['assets'], state, questions)
        self.assertEqual(asset_manifest(images), fixture['manifest'])
        identity = asset_identity(state, questions, images)
        self.assertEqual(identity, fixture['identity'])
        self.assertEqual(p.identity(), fixture['policyIdentity'])
        self.assertEqual(fingerprint({'cache_version': 2, **identity, 'provider': 'typesafe', 'model': 'jev-1.14.0', 'effort': None, 'experimental': {'images': True, 'longContext': False}}), fixture['cacheKey'])
        for a, expected in zip(fixture['answers'], fixture['decisions']):
            actual = p.decide(a)
            self.assertTrue(equal(actual, expected), (actual, expected))

    def test_box_metrics_and_bad_option_shapes_are_validation_errors(self):
        from jevlang._common import JevError
        from jevlang._engine import CompiledPolicy
        raw = policy().to_json()
        for metric in ('topProb', 'margin'):
            bad = copy.deepcopy(raw); bad['gates'][0]['by'] = metric
            with self.assertRaisesRegex(JevError, 'confidence'): CompiledPolicy(bad)
        for value in (None, [], 1):
            bad = copy.deepcopy(raw); bad['typesafe'] = value
            with self.assertRaises(JevError): CompiledPolicy(bad)


class MoreEvaluationTests(EvaluationTests):
    async def test_cache_only_works_without_credentials_and_alias_expires(self):
        p, cache, image = policy(), {}, image_asset(png(), format='png')
        options = {'assets': {'photo': image}, 'cache': cache, 'model': 'jev-preview'}
        evaluate.settings.clock = lambda: 1000
        await evaluate.evaluate_with_provider(p, {'photo': 'photo'}, **options)
        evaluate.settings.transport = None; evaluate.settings.api_key = None
        hit = await evaluate.evaluate_with_provider(p, {'photo': 'photo'}, cache_only=True, **options)
        self.assertTrue(hit['cached'])
        evaluate.settings.clock = lambda: 302000
        with self.assertRaisesRegex(Exception, 'no cached answer'):
            await evaluate.evaluate_with_provider(p, {'photo': 'photo'}, cache_only=True, **options)

    async def test_concurrent_rows_share_one_request(self):
        image, cache = image_asset(png(), format='png'), {}
        result = await asyncio.gather(*[evaluate.evaluate_with_provider(policy(), {'photo': 'photo'}, assets={'photo': image}, cache=cache) for _ in range(5)])
        self.assertEqual(len(self.sent), 1)
        self.assertEqual(sum(bool(x.get('cached')) for x in result), 4)

    async def test_cancel_event_does_not_retry(self):
        event, entered = asyncio.Event(), asyncio.Event()
        calls = []
        async def stalled(payload):
            calls.append(payload); entered.set(); await asyncio.Event().wait()
        evaluate.settings.transport = stalled
        task = asyncio.create_task(evaluate.jev_call('text', {}, cancel_event=event))
        await entered.wait(); event.set()
        with self.assertRaises(asyncio.CancelledError): await task
        self.assertEqual(len(calls), 1)

    async def test_owner_cancellation_clears_inflight_cache(self):
        entered = asyncio.Event()
        async def stalled(payload):
            entered.set(); await asyncio.Event().wait()
        evaluate.settings.transport = stalled
        cache = {}; image = image_asset(png(), format='png')
        task = asyncio.create_task(evaluate.evaluate_with_provider(policy(), {'photo': 'photo'}, assets={'photo': image}, cache=cache))
        await entered.wait(); task.cancel()
        with self.assertRaises(asyncio.CancelledError): await task
        self.assertFalse(cache)


class SurfaceTests(unittest.IsolatedAsyncioTestCase):
    async def test_http_forwards_assets_and_rejects_remote_opt_in(self):
        from jevlang._serve import handle_request
        from jevlang._engine import CompiledPolicy
        p = CompiledPolicy(policy().to_json()); seen = []
        async def callback(state, options):
            seen.append(options); return p.decide(answers())
        image = image_asset(png(), format='png')
        body = json.dumps({'state': {'photo': 'photo'}, 'assets': {'photo': image}}).encode()
        result = await handle_request(p, 'POST', '/evaluate', body, evaluate=callback)
        self.assertEqual(result['status'], 200)
        self.assertEqual(seen[0]['assets'], {'photo': image})
        raw = p.to_json(); raw['typesafe'] = {}
        disabled = CompiledPolicy(raw)
        rejected = await handle_request(disabled, 'POST', '/evaluate', body, evaluate=callback)
        self.assertEqual(rejected['status'], 422)
        rejected = await handle_request(p, 'POST', '/evaluate', json.dumps({'state': {}, 'model': 'jev-preview'}).encode(), evaluate=callback)
        self.assertEqual(rejected['status'], 422)

    async def test_mcp_schema_and_metadata_exclude_image_bytes(self):
        from jevlang._mcp import policy_mcp_server, policy_to_json, handle_message, make_mcp_conn, META_PROTOCOL_VERSION, META_CLIENT_CAPABILITIES, MODERN_VERSION
        from jevlang._engine import CompiledPolicy
        raw = policy().to_json(); raw['typesafe']['assets'] = {'photo': image_asset(png(), format='png')}
        p = CompiledPolicy(raw)
        metadata = policy_to_json(p)
        self.assertNotIn('data_base64', json.dumps(metadata))
        server = policy_mcp_server(p, allow_evaluate=True)
        reply = await handle_message(server, {'jsonrpc': '2.0', 'id': 1, 'method': 'tools/list', 'params': {'_meta': {META_PROTOCOL_VERSION: MODERN_VERSION, META_CLIENT_CAPABILITIES: {}}}}, make_mcp_conn())
        tool = next(t for t in reply['result']['tools'] if t['name'] == 'evaluate')
        self.assertIn('assets', tool['inputSchema']['properties'])

class EncodingTests(unittest.TestCase):
    def test_gzip_json_and_multipart_preserve_bytes(self):
        import gzip
        from email.parser import BytesParser
        from email.policy import default
        from jevlang._typesafe_request import prepare_jev_request, encode_jev_request
        image = image_asset(png(), format='png')
        options = {'assets': {'photo': image}, 'experimental': {'images': True}, 'compression': 'gzip'}
        prepared = prepare_jev_request({'photo': 'photo'}, policy().questions(), 'jev-1.14.0', options)
        body, headers = encode_jev_request(prepared, options)
        self.assertEqual(headers['Content-Encoding'], 'gzip')
        message = BytesParser(policy=default).parsebytes(('Content-Type: '+headers['Content-Type']+'\r\n\r\n').encode()+gzip.decompress(body))
        parts = list(message.iter_parts())
        payload = json.loads(parts[0].get_payload(decode=True))
        self.assertEqual(payload['assets']['photo'], {'type': 'image', 'part': 'image-0'})
        self.assertEqual(parts[1].get_payload(decode=True), png())
        body, headers = encode_jev_request(prepared, {**options, 'assetTransport': 'json'})
        self.assertEqual(json.loads(gzip.decompress(body))['assets']['photo'], image)

    def test_headers_and_explicit_zstd_runtime_errors(self):
        from unittest.mock import patch
        from jevlang._typesafe_request import prepare_jev_request, encode_jev_request
        for header in ('AUTHORIZATION', 'Host', 'TypeSafe-Danger-Zone-Images', 'Content-Encoding'):
            with self.assertRaises(Exception): prepare_jev_request('', {}, 'jev-1.14.0', {'headers': {header: 'x'}})
        prepared = prepare_jev_request('', {}, 'jev-1.14.0')
        with patch('jevlang._typesafe_request._zstd_codec', return_value=None):
            with self.assertRaisesRegex(Exception, 'unavailable'): encode_jev_request(prepared, {'compression': 'zstd'})
            self.assertNotIn('Content-Encoding', encode_jev_request(prepared)[1])

    def test_reference_survives_redaction_and_capping(self):
        from jevlang._engine import CompiledPolicy
        raw = policy().to_json(); raw['stateOptions'] = {'redact': ['emails'], 'maxChars': 50}
        p = CompiledPolicy(raw); ref = 'user@example.com'
        image = image_asset(png(), format='png')
        state = p.build_state({'photo': ref, 'text': 'other@example.com'}, {'assets': {ref: image}})['state']
        self.assertEqual(state['photo'], ref)
        self.assertNotIn('other@example.com', json.dumps(state))

    def test_jpeg_fixtures_match_geometry(self):
        from pathlib import Path
        from jevlang._assets import inspect_image
        for filename in ('jev-baseline.jpg', 'jev-progressive.jpg'):
            data = (Path(__file__).parent/'fixtures'/filename).read_bytes()
            info = inspect_image(image_asset(data, format='jpeg'))
            self.assertEqual((info['width'], info['height']), (280, 280))


class UsageTests(unittest.IsolatedAsyncioTestCase):
    async def test_batch_and_pipeline_preserve_unknown_usage(self):
        from jevlang._batch import evaluate_many
        from jevlang._pipeline import run_pipeline
        async def stage(row):
            evaluate.settings.on_usage({'input_tokens': None, 'output_tokens': None})
            return {'action': 'hold'}
        batch = await evaluate_many(stage, [1], rpm=None, tokens_per_second=None)
        self.assertIsNone(batch['cost']); self.assertEqual(batch['unreported_calls'], 1)
        pipeline = await run_pipeline({'only': stage}, {}, start='only')
        self.assertIsNone(pipeline['usage']['input_tokens']); self.assertFalse(pipeline['usage_complete'])

class RecordingTests(unittest.TestCase):
    def setUp(self):
        self.old = vars(evaluate.settings).copy(); self.sent = []
        async def transport(payload):
            self.sent.append(payload); return {'answers': answers(), 'model': payload['model']}
        evaluate.settings.transport = transport
        evaluate.settings.environment = lambda name: None
    def tearDown(self): vars(evaluate.settings).update(self.old)
    def test_record_obeys_policy_model_and_request_limit(self):
        image = image_asset(png(), format='png'); raw = policy().to_json()
        raw['model'] = 'jev-1.13.0'
        with self.assertRaises(Exception): Policy.from_json(raw).record({'photo': 'photo'}, assets={'photo': image})
        raw.pop('model'); raw['stateOptions'] = {'requestTokenLimit': 1}
        with self.assertRaises(Exception): Policy.from_json(raw).record({'photo': 'photo'}, assets={'photo': image})
        self.assertFalse(self.sent)

class ProviderAccountingTests(unittest.IsolatedAsyncioTestCase):
    async def test_missing_usage_from_other_provider_is_not_free(self):
        from jevlang._provider import Provider, ProviderRegistry, capabilities, availability, merge_provider_config, unreported_cost
        from jevlang._batch import evaluate_many
        async def discover(): return availability('ready')
        async def run(request, target):
            return {'output': {}, 'target': target, 'model': 'local', 'usage': {}, 'cost': unreported_cost(), 'requestId': None, 'exitStatus': 0, 'changed': [], 'attempts': []}
        registry = ProviderRegistry(); registry.register(Provider('local', capabilities(), discover, run))
        config = merge_provider_config(project={'provider': 'local'})
        p = Policy(name='local', questions=[], route={'clauses': [], 'otherwise': hold()})
        async def row(value): return await evaluate.evaluate_with_provider(p, value, registry=registry, config=config)
        result = await evaluate_many(row, [{}], rpm=None, tokens_per_second=None)
        self.assertIsNone(result['cost']); self.assertEqual(result['unreported_calls'], 1)


if __name__ == "__main__": unittest.main()
