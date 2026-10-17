"""The evaluate layer: from a policy and an input to a decision with provider
provenance. Ported from the TypeScript engine's src/evaluate.mjs plus the
TypeSafe HTTP call and its retry policy from src/client.mjs. Internal response
keys keep the TypeScript camelCase names; decision and fixture keys are the
snake_case wire format."""
from __future__ import annotations

import asyncio
import email.utils
import inspect
import weakref
import copy
import json
import math
import os
import random
import re
import socket
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Dict, Optional

from ._common import JevError, is_object, own, require_at
from ._numberfmt import jsonify

RETRY_AFTER_CAP = 60


class ClientSettings:
    def __init__(self) -> None:
        self.api_key: Optional[str] = None
        self.base_url: Optional[str] = None
        self.default_model: Optional[str] = None
        self.timeout_seconds: float = 10
        self.transport: Optional[Callable[[dict], Awaitable[Any]]] = None
        self.extra_body: Optional[dict] = None
        self.pacer: Optional[Callable[[], Awaitable[Any]]] = None
        self.on_retry_after: Optional[Callable[[float], None]] = None
        self.on_usage: Optional[Callable[[dict], None]] = None
        self.environment: Callable[[str], Optional[str]] = lambda name: os.environ.get(name)

        async def _sleep(seconds: float) -> None:
            await asyncio.sleep(seconds)

        self.sleep = _sleep
        self.clock: Callable[[], float] = lambda: time.time() * 1000
        self.random: Callable[[], float] = random.random


settings = ClientSettings()

DEFAULT_RETRY_POLICY: Dict[str, Any] = {
    'maxRetries': 2, 'backoffInitial': 0.5, 'backoffMax': 5, 'jitter': 0.25,
    'statuses': [408, 429, *range(500, 600)],
    'respectRetryAfter': True, 'retryConnection': True, 'totalBudget': 30,
}


class JevApiError(Exception):
    def __init__(self, message: str, *, kind: str, status: Optional[int] = None,
                 request_id: Optional[str] = None, retry_after_ms: Optional[float] = None,
                 body: Any = None, retryable: bool = False):
        super().__init__(message)
        self.name = 'JevApiError'
        self.message = message
        self.kind = kind
        self.status = status
        self.request_id = request_id
        self.retry_after_ms = retry_after_ms
        self.body = body
        self.retryable = retryable


def _endpoint() -> str:
    base = (nn(settings.base_url, nn(settings.environment('TYPESAFE_BASE_URL'), 'https://api.typesafe.ai'))).strip()
    base = re.sub(r'/+$', '', base)
    return f'{base}/v1/systemone'


def nn(value: Any, default: Any) -> Any:
    return default if value is None else value


def default_model() -> str:
    return nn(nn(settings.default_model, settings.environment('TYPESAFE_DEFAULT_MODEL')), 'jev-1.14.0')


def _api_key() -> str:
    key = nn(settings.api_key, settings.environment('TYPESAFE_API_KEY'))
    require_at(isinstance(key, str) and key.strip() != '', 'TYPESAFE_API_KEY', 'no TypeSafe API key',
               'Set TYPESAFE_API_KEY, or inject a transport.', 'auth')
    return key


def api_key_configured() -> bool:
    if settings.transport:
        return True
    key = nn(settings.api_key, settings.environment('TYPESAFE_API_KEY'))
    return isinstance(key, str) and key.strip() != ''


def _status_error(url: str, status: int, request_id: Optional[str], retry_after_ms: Optional[float], text: str) -> JevApiError:
    body: Any = text
    try:
        body = json.loads(text)
    except (ValueError, TypeError):
        pass
    if status in (401, 403):
        kind, hint = 'auth', 'check TYPESAFE_API_KEY: the key is missing, wrong, or not allowed this call'
    elif status == 404:
        kind, hint = 'invalid', 'check TYPESAFE_BASE_URL: nothing is served at that URL'
    elif status in (413, 415):
        kind, hint = ('size', 'request body exceeds the server limit') if status == 413 else ('encoding', 'server rejected the request encoding')
    elif status in (400, 422):
        kind, hint = 'invalid', 'the request failed validation; the body names the offending field'
    elif status == 429:
        kind, hint = 'rate-limit', 'rate limited: slow down or retry later'
    elif status == 529:
        kind, hint = 'server', 'the API is overloaded; retry after a short delay'
    elif 500 <= status <= 599:
        kind, hint = 'server', 'the server failed; this is usually transient'
    else:
        kind, hint = 'http', None
    note = f' (request {request_id})' if request_id else ''
    shown = '' if text.strip() == '' else '\n  body: ' + re.sub(r'\s+', ' ', text)[:500]
    return JevApiError(f'jev: HTTP {status} from {url}{note}' + (f'\n  {hint}' if hint else '') + shown,
                       kind=kind, status=status, request_id=request_id, retry_after_ms=retry_after_ms, body=body)


def _retry_after_ms(headers: Any) -> Optional[float]:
    ms = headers.get('retry-after-ms')
    if ms is not None:
        try:
            return float(ms)
        except (ValueError, TypeError):
            pass
    after = headers.get('retry-after')
    if after is None:
        return None
    try:
        return float(after) * 1000
    except (ValueError, TypeError):
        try:
            parsed = email.utils.parsedate_to_datetime(after)
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            delta = parsed.timestamp() * 1000 - settings.clock()
            return max(0.0, delta) if math.isfinite(delta) else None
        except (ValueError, TypeError, OverflowError):
            return None


def _response_from(url: str, request_id: Optional[str], body: Any) -> dict:
    note = f' (request {request_id})' if request_id else ''
    require_at(is_object(body), url, f'the response from {url}{note} is not a JSON object', None, 'response')
    require_at(is_object(body.get('answers')), url, f"the response from {url}{note} has no 'answers' object",
               "Keys present: " + (', '.join(sorted(body)) or 'none') + '.', 'response')
    return {
        'answers': body['answers'],
        'model': body.get('model') if isinstance(body.get('model'), str) else None,
        'usage': body['usage'] if is_object(body.get('usage')) else None,
        'requestId': nn(request_id, None),
        'body': body,
        'provider': 'typesafe',
        'requestedModel': None, 'requestedEffort': None, 'effectiveEffort': None,
    }


def _retryable(policy: dict, error: Exception) -> bool:
    if isinstance(error, JevApiError):
        if error.kind in ('connection', 'timeout'):
            return bool(policy['retryConnection'])
        return error.status is not None and error.status in policy['statuses']
    return False


def _backoff(policy: dict, n: int) -> float:
    return min(policy['backoffMax'], policy['backoffInitial'] * 2 ** n) * (1 - policy['jitter'] * settings.random())


def _requested_wait(error: JevApiError) -> Optional[float]:
    ms = error.retry_after_ms
    if ms is not None and math.isfinite(ms) and ms > 0:
        return min(RETRY_AFTER_CAP, ms / 1000)
    return None


def _remessage(error: JevApiError, message: str) -> JevApiError:
    error.message = message
    error.args = (message,)
    return error


async def _with_retries(policy: dict, what: str, attempt: Callable[[Optional[float]], Awaitable[Any]]) -> Any:
    attempts = policy['maxRetries'] + 1
    deadline = settings.clock() + policy['totalBudget'] * 1000 if policy['totalBudget'] else None
    last: Optional[JevApiError] = None
    n = 0
    while True:
        if settings.pacer:
            before = settings.clock()
            await settings.pacer()
            if deadline is not None:
                deadline += settings.clock() - before
        remaining = None if deadline is None else (deadline - settings.clock()) / 1000
        if remaining is not None and remaining <= 0:
            prefix = f'{last.message}\n  ' if last else ''
            raise JevApiError(f'{prefix}gave up after {n} of {attempts} attempts: the {policy["totalBudget"]} s total budget ran out',
                              kind=last.kind if last else 'timeout', status=last.status if last else None,
                              request_id=last.request_id if last else None, body=last.body if last else None)
        try:
            return await attempt(remaining)
        except JevApiError as error:
            if not _retryable(policy, error):
                raise
            last = error
            if n + 1 >= attempts:
                if attempts > 1:
                    raise _remessage(error, f'{error.message}\n  gave up after {attempts} attempts')
                raise error
            wait = _requested_wait(error) if policy['respectRetryAfter'] else None
            if wait and settings.on_retry_after:
                settings.on_retry_after(wait)
            delay = max(_backoff(policy, n), wait if wait is not None else 0)
            if deadline is not None and settings.clock() + delay * 1000 > deadline:
                raise _remessage(error, f'{error.message}\n  gave up after {n + 1} of {attempts} attempts: the next retry would pass the {policy["totalBudget"]} s total budget')
            if delay > 0:
                await settings.sleep(delay)
        n += 1


async def _injected(payload, metadata):
    transport = settings.transport
    try:
        inspect.signature(transport).bind(payload, metadata)
    except (TypeError, ValueError):
        return await transport(payload)
    return await transport(payload, metadata)


async def _http_json(url, method, headers, body, seconds):
    from ._http import request_http
    try:
        status, returned, raw = await request_http(url, method, headers, body, seconds)
    except (asyncio.TimeoutError, TimeoutError) as error:
        raise JevApiError(f'jev: the request timed out {url}: {error}', kind='timeout') from None
    except (OSError, asyncio.IncompleteReadError) as error:
        raise JevApiError(f'jev: could not reach {url}: {error}', kind='connection') from None
    request_id = returned.get('x-typesafe-request-id')
    text = raw.decode('utf-8', errors='replace')
    if not 200 <= status <= 299:
        raise _status_error(url, status, request_id, _retry_after_ms(returned), text)
    try:
        return json.loads(text), request_id
    except (ValueError, TypeError):
        raise JevApiError(f'jev: the response from {url} is not JSON', kind='response', status=status, request_id=request_id) from None


async def _cancellable(operation, event=None):
    if event is None:
        return await operation
    task = asyncio.ensure_future(operation)
    cancel = asyncio.create_task(event.wait())
    try:
        done, _ = await asyncio.wait((task, cancel), return_when=asyncio.FIRST_COMPLETED)
        if cancel in done:
            raise asyncio.CancelledError()
        return await task
    finally:
        for pending in (task, cancel):
            if not pending.done(): pending.cancel()
        await asyncio.gather(task, cancel, return_exceptions=True)


async def jev_call(state: Any, questions: Any, model: Optional[str] = None,
                   timeout_seconds: Optional[float] = None,
                   retry: Optional[dict] = None, **options) -> dict:
    from ._typesafe_request import prepare_jev_request, encode_jev_request
    requested_model = model if model is not None else default_model()
    if 'asset_transport' in options: options['assetTransport'] = options.pop('asset_transport')
    prepared = prepare_jev_request(state, questions, requested_model, options, settings.extra_body)
    body, headers = encode_jev_request(prepared, options)
    policy = {**DEFAULT_RETRY_POLICY, **(retry or {})}
    seconds_limit = timeout_seconds if timeout_seconds is not None else settings.timeout_seconds
    transport = settings.transport

    async def attempt(remaining):
        seconds = [x for x in (seconds_limit, remaining) if isinstance(x, (int, float)) and not isinstance(x, bool) and x > 0]
        timeout = min(seconds) if seconds else None
        if transport:
            operation = _injected(prepared['payload'], {'headers': headers, 'body': body, 'method': 'POST', 'url': _endpoint()})
            response = await asyncio.wait_for(operation, timeout) if timeout else await operation
            return _response_from('transport', response.get('request_id') if is_object(response) else None, response)
        response, request_id = await _http_json(_endpoint(), 'POST', {**headers, 'Authorization': f'Bearer {_api_key()}'}, body, timeout)
        return _response_from(_endpoint(), request_id, response)

    response = await _cancellable(_with_retries(policy, 'transport' if transport else _endpoint(), attempt), options.get('cancel_event'))
    result = {**response, 'requestedModel': requested_model, 'assets': prepared['manifest'], 'experimental': prepared['experimental']}
    if settings.on_usage: settings.on_usage(result.get('usage') or {})
    return result


async def list_models(*, timeout_seconds=None, retry=None, headers=None, cancel_event=None):
    from ._typesafe_request import request_headers
    url = _endpoint().rsplit('/systemone', 1)[0] + '/models'
    request_headers_value = request_headers({'headers': headers or {}})
    async def attempt(remaining):
        timeout = min(x for x in (timeout_seconds or settings.timeout_seconds, remaining or float('inf')) if x > 0)
        if settings.transport:
            return await asyncio.wait_for(_injected(None, {'method': 'GET', 'url': url, 'headers': request_headers_value}), timeout)
        body, _ = await _http_json(url, 'GET', {**request_headers_value, 'Authorization': f'Bearer {_api_key()}'}, None, timeout)
        return body
    result = await _cancellable(_with_retries({**DEFAULT_RETRY_POLICY, **(retry or {})}, url, attempt), cancel_event)
    require_at(is_object(result) and isinstance(result.get('models'), list) and all(is_object(m) and all(isinstance(m.get(k), str) for k in ('name', 'description', 'release_date')) for m in result['models']), 'models', 'invalid models response', code='response')
    return result


PROBABILITY_SCHEMA = {'type': 'object'}


def _answer_schema(question: dict) -> dict:
    common = {'type': {'type': 'string', 'const': question.get('type')}}
    qtype = question.get('type')
    if qtype == 'choice':
        criteria = nn(question.get('criteria'), {})
        return {
            'type': 'object',
            'properties': {
                **common,
                'choice': {'type': 'string', 'enum': sorted(criteria)},
                'confidence': {'type': 'number', 'minimum': 0, 'maximum': 1},
                'probabilities': PROBABILITY_SCHEMA,
            },
            'required': ['type', 'choice'],
            'additionalProperties': True,
        }
    if qtype == 'score':
        return {
            'type': 'object',
            'properties': {
                **common,
                'score': {'type': 'number'},
                'confidence': {'type': 'number', 'minimum': 0, 'maximum': 1},
                'probabilities': PROBABILITY_SCHEMA,
                'legend': {'type': 'object'},
            },
            'required': ['type', 'score'],
            'additionalProperties': True,
        }
    if qtype == 'box':
        return {'type': 'object', 'properties': {**common, 'box': {'type': 'object', 'properties': {edge: {'type': 'number', 'minimum': 0, 'maximum': 1} for edge in ('top', 'bottom', 'left', 'right')}, 'required': ['top', 'bottom', 'left', 'right'], 'additionalProperties': False}, 'confidence': {'type': ['number', 'null'], 'minimum': 0, 'maximum': 1}}, 'required': ['type', 'box'], 'additionalProperties': True}
    if qtype == 'noul':
        return {
            'type': 'object',
            'properties': {**common, 'noul': {'type': 'number', 'minimum': 0, 'maximum': 1}},
            'required': ['type', 'noul'],
            'additionalProperties': True,
        }
    return {'type': 'object'}


def questions_answer_schema(questions: Any) -> dict:
    require_at(is_object(questions), 'questions', 'expected a question map')
    ids = sorted(questions)
    return {
        'type': 'object',
        'properties': {id: _answer_schema(questions[id]) for id in ids},
        'required': ids,
        'additionalProperties': False,
    }


def policy_prompt(state: Any, questions: Any) -> str:
    return ('Answer every Jev policy question using only the supplied state. '
            'Return the answer object required by the JSON Schema.\n\n'
            f'<jev-state>\n{jsonify(state)}\n</jev-state>\n\n'
            f'<jev-questions>\n{jsonify(questions)}\n</jev-questions>')


def typesafe_provider(max_parallel: int = 4):
    from ._provider import Provider, capabilities

    async def discover() -> dict:
        from ._provider import availability
        return (availability('ready', detail='configured TypeSafe System One API') if api_key_configured()
                else availability('unauthenticated', detail='set TYPESAFE_API_KEY'))

    async def run(request: dict, target: dict) -> dict:
        from ._provider import ProviderError, unreported_cost
        state = request['metadata'].get('state')
        questions = request['metadata'].get('questions')
        if not is_object(questions):
            raise ProviderError('TypeSafe policy requests require a question map',
                                kind='configuration', target=target, detail='missing questions metadata')
        try:
            response = await jev_call(state, questions, model=target.get('model'), **request['metadata'].get('typesafe', {}), **request.get('_jev_private', {}))
        except JevApiError as error:
            kind = {'auth': 'authentication', 'timeout': 'timeout', 'rate-limit': 'rate-limit',
                    'server': 'overload', 'response': 'invalid-output', 'connection': 'connection'}.get(error.kind, 'provider-failure')
            raise ProviderError(error.message, kind=kind, target=target,
                                retryable=kind in ('timeout', 'connection', 'rate-limit', 'overload'),
                                usage={}, cost=unreported_cost(),
                                status=nn(error.status, None), detail=error.message) from None
        return {
            'output': response['answers'],
            'assets': response['assets'], 'experimental': response['experimental'],
            'target': target if target.get('model') else {**target, 'model': response['requestedModel']},
            'model': response['model'],
            'usage': nn(response.get('usage'), {}),
            'cost': unreported_cost(),
            'requestId': response['requestId'],
            'exitStatus': 0,
            'changed': [],
            'attempts': [],
        }

    return Provider('typesafe', capabilities(
        modes=['structured'], modalities=['text', 'image'], permissions=['read'],
        controls=['structured-output', 'box', 'typesafe-options'], efforts=[], max_parallel=max_parallel), discover, run)


def make_policy_registry(config: Optional[dict] = None):
    from ._provider import load_provider_config, make_default_registry
    if config is None:
        config = load_provider_config()
    return make_default_registry(config).overlay([typesafe_provider()], prepend=True)


_registry_by_loop = weakref.WeakKeyDictionary()


def shared_policy_registry(config):
    from ._numberfmt import canonical
    loop = asyncio.get_running_loop()
    entries = _registry_by_loop.setdefault(loop, {})
    key = canonical(config)
    if key not in entries: entries[key] = make_policy_registry(config)
    return entries[key]


POLICY_CONFIG_DEFAULTS = {'provider': 'typesafe', 'preferences': ['typesafe', 'claude', 'codex']}


def _normalize_effort(value: Any) -> Any:
    if value is None:
        return None
    return 'auto' if isinstance(value, str) and value.lower() == 'auto' else value


def policy_jev_options(spec, options):
    from ._assets import merge_assets
    from ._typesafe_request import validate_jev_options
    result = copy.deepcopy(spec.get('typesafe', {}))
    options = dict(options)
    if 'asset_transport' in options: options['assetTransport'] = options.pop('asset_transport')
    validate_jev_options({k: options[k] for k in ('assets', 'experimental', 'compression', 'assetTransport') if k in options})
    if 'assets' in options: result['assets'] = merge_assets(result.get('assets', {}), options['assets'])
    if 'experimental' in options: result['experimental'] = {**result.get('experimental', {}), **options['experimental']}
    for key in ('compression', 'assetTransport'):
        if key in options: result[key] = options[key]
    return result


def policy_provider_request(state: Any, questions: Any, provider: Optional[str] = None,
                            model: Optional[str] = None, effort: Optional[str] = None,
                            role: str = 'policy', **options) -> dict:
    from ._provider import provider_request, target_spec
    from ._typesafe_request import prepare_jev_request
    portable = {k: options[k] for k in ('assets', 'experimental', 'compression', 'assetTransport') if k in options}
    prepared = prepare_jev_request(state, questions, model, portable)
    has_images, has_box = bool(prepared['inspected']), any(q.get('type') == 'box' for q in questions.values())
    controls = (['typesafe-options'] if portable or any(k in options for k in ('headers', 'cancel_event', 'retry', 'timeout_seconds')) else []) + (['box'] if has_box else [])
    request = provider_request('policy', 'structured',
                            role=role, kind='policy', tier='policy', modalities=['text', 'image'] if has_images else ['text'], permissions=['read'],
                            prompt='' if has_images else policy_prompt(state, questions),
                            schema=questions_answer_schema(questions),
                            target=target_spec({'provider': provider, 'model': model, 'effort': _normalize_effort(effort)}),
                            metadata={'state': state, 'questions': questions, 'typesafe': portable, 'requiredControls': controls})
    request['_jev_private'] = {k: options[k] for k in ('headers', 'cancel_event', 'retry', 'timeout_seconds') if k in options}
    return request


async def run_policy_provider(state: Any, questions: Any, provider: Optional[str] = None,
                              model: Optional[str] = None, effort: Optional[str] = None,
                              config: Optional[dict] = None, registry=None, role: str = 'policy', **options) -> dict:
    from ._engine import validate_answers
    from ._provider import load_provider_config, run_provider_request
    request = policy_provider_request(state, questions, provider=provider, model=model, effort=effort, role=role, **options)
    resolved_config = config if config is not None else load_provider_config(defaults=POLICY_CONFIG_DEFAULTS, role=role)
    resolved_registry = registry if registry is not None else shared_policy_registry(resolved_config)

    def observe(result: dict) -> None:
        if result['target']['provider'].id != 'typesafe' and settings.on_usage:
            settings.on_usage(result.get('usage') or {})

    def validate(answers: Any) -> Any:
        if is_object(answers):
            for id, q in questions.items():
                if q.get('type') == 'box' and is_object(answers.get(id)): answers[id].setdefault('confidence', None)
        try:
            validate_answers(questions, answers)
            return None
        except JevError as error:
            return error.message

    return await run_provider_request(request, resolved_config, resolved_registry, validate=validate, observe=observe)


def explicit_policy_selection(config: dict, request: dict, provider: Optional[str] = None,
                              model: Optional[str] = None, effort: Optional[str] = None) -> bool:
    from ._provider import config_layers, matching_provider_route
    if provider or model or effort:
        return True
    if matching_provider_route(config, request):
        return True
    keys = ('provider', 'prefer', 'preferences', 'model', 'effort', 'fallback')
    return any(name != 'default' and any(key in layer for key in keys)
               for name, layer in config_layers(config))


def _compiled(policy: Any):
    from ._engine import CompiledPolicy
    if isinstance(policy, CompiledPolicy):
        return policy
    return CompiledPolicy(policy.to_json())


async def evaluate_with_provider(policy: Any, input: Any, provider: Optional[str] = None,
                                 model: Optional[str] = None, effort: Optional[str] = None,
                                 profile: Optional[str] = None, config: Optional[dict] = None,
                                 registry=None, role: str = 'policy', **options) -> dict:
    from ._engine import validate_answers
    from ._provider import load_provider_config
    from ._state import check_token_budget
    compiled = _compiled(policy)
    spec = compiled.policy
    selection = {'provider': nn(provider, nn(spec.get('provider'), None)),
                 'model': nn(model, nn(spec.get('model'), None)),
                 'effort': nn(effort, nn(spec.get('effort'), None))}
    jev_options = policy_jev_options(spec, options)
    built = compiled.build_state(input, jev_options)
    state, facts = built['state'], built['facts']
    pre = compiled.precheck(input, {**jev_options, **({'profile': profile} if profile else {})})
    if pre:
        return pre
    questions = compiled.questions(state)
    from ._budgets import check_request_budget
    check_request_budget(state, questions, {**spec.get('stateOptions', {}), **jev_options})
    resolved_config = config if config is not None else load_provider_config(defaults=POLICY_CONFIG_DEFAULTS, role=role)
    resolved_registry = registry if registry is not None else shared_policy_registry(resolved_config)
    async def ask():
        return await run_policy_provider(state, questions, config=resolved_config, registry=resolved_registry,
                                         role=role, **selection, **{**options, **jev_options})
    cache = options.get('cache')
    cache_only = options.get('cache_only', options.get('cacheOnly', False))
    require_at(not cache_only or cache is not None, 'cache_only', 'cache_only needs a cache')
    cached = False
    if cache is not None:
        from ._provider import resolve_provider
        from ._assets import inspect_assets, asset_identity
        from ._common import fingerprint
        request = policy_provider_request(state, questions, **selection, **{**{k: options[k] for k in ('headers', 'cancel_event', 'retry', 'timeout_seconds') if k in options}, **jev_options})
        target = (await resolve_provider(request, resolved_config, resolved_registry, offline=cache_only))['target']
        def effective(t):
            return {'provider': t['provider'].id, 'model': t.get('model') or (default_model() if t['provider'].id == 'typesafe' else None), 'effort': t.get('effectiveEffort')}
        selected = effective(target)
        identity = asset_identity(state, questions, inspect_assets(jev_options.get('assets', {}), state, questions))
        key = fingerprint({'cache_version': 2, **identity, **selected, 'experimental': {k: jev_options.get('experimental', {}).get(k) is True for k in ('images', 'longContext')}})
        hit = cache.get(key)
        age = options.get('cache_max_age_seconds', options.get('cacheMaxAgeSeconds', 300 if selected['model'] in ('jev-latest', 'jev-preview') else None))
        require_at(age is None or (type(age) in (int, float) and math.isfinite(age) and age >= 0), 'cache_max_age_seconds', 'expected nonnegative seconds')
        if isinstance(hit, dict) and age is not None and (type(hit.get('cacheTime')) not in (int, float) or not math.isfinite(hit['cacheTime']) or settings.clock() - hit['cacheTime'] >= age * 1000):
            cache.pop(key, None); hit = None
        if hit is not None:
            result = await asyncio.shield(hit) if isinstance(hit, asyncio.Future) else hit
            cached = True
        else:
            require_at(not cache_only, 'cache', 'no cached answer for this input', code='uncached')
            async def populate():
                try:
                    value = await ask()
                    value['cacheTime'] = settings.clock()
                    if effective(value['target']) == selected: cache[key] = value
                    else: cache.pop(key, None)
                    return value
                except BaseException:
                    cache.pop(key, None)
                    raise
            pending = asyncio.create_task(populate())
            cache[key] = pending
            result = await pending
    else:
        result = await ask()
    answers = result['output']
    validate_answers(questions, answers)
    decision = compiled.decide(answers, {**({'profile': profile} if profile else {}), 'facts': facts, 'state': state})
    target = result['target']
    return {
        **decision,
        **({'cached': True} if cached else {}),
        'provider': target['provider'].id,
        'requested_model': nn(target.get('model'), None),
        'model': nn(result.get('model'), None),
        'requested_effort': nn(target.get('requestedEffort'), None),
        'effective_effort': nn(target.get('effectiveEffort'), None),
        'request_id': nn(result.get('requestId'), None),
    }


async def evaluate_configured_policy(policy: Any, input: Any, start: Optional[str] = None,
                                     pkg: Optional[dict] = None, provider: Optional[str] = None,
                                     model: Optional[str] = None, effort: Optional[str] = None,
                                     registry=None, **options) -> Optional[dict]:
    from ._provider import ProviderError, load_provider_config, resolve_provider
    compiled = _compiled(policy)
    config = load_provider_config(start if start is not None else os.getcwd(),
                                  defaults=POLICY_CONFIG_DEFAULTS, pkg=pkg, role='policy')
    resolved_registry = registry if registry is not None else make_policy_registry(config)
    jev_options = policy_jev_options(compiled.policy, options)
    built = compiled.build_state(input, jev_options)
    request = policy_provider_request(built['state'], compiled.questions(built['state']), provider=provider, model=model, effort=effort, **jev_options)
    try:
        await resolve_provider(request, config, resolved_registry)
    except ProviderError as error:
        if error.kind == 'unavailable' and not explicit_policy_selection(config, request, provider=provider, model=model, effort=effort):
            return None
        raise
    return await evaluate_with_provider(policy, input, provider=provider, model=model, effort=effort,
                                        config=config, registry=resolved_registry, **options)


def fixture_from_run(*, name: str, policy: Any, state: Any, questions: Any,
                     decision: Optional[dict] = None, result: dict,
                     synthetic: bool = False, expect: Optional[dict] = None, assets=None, include_assets=False) -> dict:
    compiled = _compiled(policy)
    target = result['target']
    fixture: Dict[str, Any] = {
        'fixture_version': 3,
        'name': name,
        'policy': nn(compiled.policy.get('name'), None),
        'provider': target['provider'].id,
        'requested_model': nn(target.get('model'), None),
        'model': nn(result.get('model'), None),
        'requested_effort': nn(target.get('requestedEffort'), None),
        'effective_effort': nn(target.get('effectiveEffort'), None),
        'request_id': nn(result.get('requestId'), None),
        'state': state,
        'questions': questions,
        'questions_sha256': compiled.identity(),
        'answers': result['output'],
        'usage': nn(result.get('usage'), {}),
    }
    if result.get('assets') or any(q.get('type') == 'box' for q in questions.values()):
        fixture.update(fixture_version=4, assets=result.get('assets', {}), experimental=result.get('experimental', {}))
        if include_assets and assets is not None: fixture['asset_data'] = assets
    if expect:
        fixture['expect'] = expect
    elif decision:
        fixture['expect'] = {'action': decision.get('action'),
                             **({'target': decision['target']} if decision.get('target') else {})}
    fixture['synthetic'] = synthetic
    fixture['recorded_at'] = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    return fixture


def provider_report(options: Optional[dict] = None) -> dict:
    from ._provider import (capabilities, discover_providers, load_provider_config, make_default_registry,
                            provider_request, resolve_provider, target_spec)
    options = options if options is not None else {}

    async def run() -> dict:
        config = nn(options.get('config'), load_provider_config(role=nn(options.get('role'), None)))
        registry = make_default_registry(config)
        request = provider_request(nn(options.get('operation'), 'decide'), nn(options.get('mode'), 'structured'),
                                   role=nn(nn(options.get('role'), options.get('operation')), 'decide'),
                                   kind=options.get('kind'), tier=options.get('tier'),
                                   target=target_spec(options.get('target') or {}))
        discovered = [{'provider': entry['provider'].id, **entry['availability']}
                      for entry in await discover_providers(registry)]
        try:
            resolution = await resolve_provider(request, config, registry)
            target = resolution['target']
            return {
                'discovered': discovered, 'rejections': resolution['rejections'], 'matched_route': resolution['matchedRoute'],
                'selected': {'provider': target['provider'].id, 'model': target.get('model'),
                             'requested_effort': target.get('requestedEffort'), 'effective_effort': target.get('effectiveEffort'),
                             'sources': target['sources']},
            }
        except Exception as error:
            detail = getattr(error, 'detail', None)
            return {'discovered': discovered, 'rejections': detail if isinstance(detail, list) else [],
                    'selected': None, 'error': {'kind': getattr(error, 'kind', 'error'), 'message': str(error)}}

    return asyncio.run(run())


def evaluate_policy(policy: Any, input: Any, options: Optional[dict] = None) -> dict:
    options = options if options is not None else {}
    return asyncio.run(evaluate_with_provider(
        policy, input, provider=options.get('provider'), model=options.get('model'), effort=options.get('effort'),
        profile=options.get('profile'), config=options.get('config'), role=options.get('role') or 'policy',
        **{k: v for k, v in options.items() if k not in ('provider', 'model', 'effort', 'profile', 'config', 'role')}))


def record_policy(policy: Any, input: Any, options: Optional[dict] = None) -> dict:
    from ._engine import CompiledPolicy
    options = options if options is not None else {}

    async def run() -> dict:
        compiled = policy if isinstance(policy, CompiledPolicy) else CompiledPolicy(policy.to_json())
        config = nn(options.get('config'), load_provider_config_for_record())
        registry = make_policy_registry(config)
        jev_options = policy_jev_options(compiled.policy, options)
        built = compiled.build_state(input, jev_options)
        state, facts = built['state'], built['facts']
        questions = compiled.questions(state)
        from ._budgets import check_request_budget
        check_request_budget(state, questions, {**compiled.policy.get('stateOptions', {}), **jev_options})
        result = await run_policy_provider(state, questions, provider=nn(options.get('provider'), compiled.policy.get('provider')),
                                           model=nn(options.get('model'), compiled.policy.get('model')), effort=nn(options.get('effort'), compiled.policy.get('effort')),
                                           config=config, registry=registry, **{**{k: options[k] for k in ('headers', 'retry', 'timeout_seconds', 'cancel_event') if k in options}, **jev_options})
        profile_options = {'profile': options['profile']} if options.get('profile') is not None else {}
        decision = compiled.decide(result['output'], {**profile_options, 'facts': facts, 'state': state})
        return {'decision': decision,
                'fixture': fixture_from_run(name=nn(options.get('name'), 'recorded'), policy=compiled,
                                            state=state, questions=questions, decision=decision, result=result, assets=jev_options.get('assets'), include_assets=options.get('include_assets', options.get('includeAssets', False)))}

    def load_provider_config_for_record() -> dict:
        from ._provider import load_provider_config
        return load_provider_config(defaults=POLICY_CONFIG_DEFAULTS, role='policy')

    return asyncio.run(run())
