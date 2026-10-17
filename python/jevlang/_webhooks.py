"""Webhooks: signed decisions out, signed events in.

The portable mirror of src/webhooks.mjs. Out: webhook_handler(url, secret=...)
is a dispatcher handler that POSTs a Standard Webhooks message for each
decision, retried with backoff on connection errors, timeouts, 408, 429 and
5xx. In: a verifier is (headers, body, now) -> {'ok', 'deliveryId',
'reason'}; it runs before anything parses the body."""
from __future__ import annotations

import asyncio
import base64
import datetime
import hashlib
import hmac
import json
import os
import re
import secrets
from typing import Any, Callable, Dict, List, Optional
from urllib.parse import urlsplit

from ._common import finite, is_object, own, require_at
from ._explain import explain_decision
from ._numberfmt import jsonify


def _sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _hmac_hex(key: bytes, data: bytes) -> str:
    return hmac.new(key, data, hashlib.sha256).hexdigest()


def _hmac_b64(key: bytes, data: bytes) -> str:
    return base64.b64encode(hmac.new(key, data, hashlib.sha256).digest()).decode('ascii')


def _bytes(v: Any) -> bytes:
    return v if isinstance(v, bytes) else str(v).encode('utf8')


def _same_text(a: Any, b: Any) -> bool:
    x, y = _bytes(a), _bytes(b)
    return len(x) == len(y) and hmac.compare_digest(x, y)


def _same_hex(a: Any, b: Any) -> bool:
    return _same_text(str(a).lower(), str(b).lower())


def _iso(seconds: int) -> str:
    return datetime.datetime.fromtimestamp(seconds, datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def env_secret(name: str) -> dict:
    """env_secret('TICKETS_SECRET') reads the variable each time it is needed,
    so a missing secret is reported by name instead of as nothing."""
    return {'envSecret': name}


def is_env_secret(v: Any) -> bool:
    return is_object(v) and isinstance(v.get('envSecret'), str)


def resolve_secret(s: Any) -> dict:
    """-> {'secret', 'problem'}"""
    if is_env_secret(s):
        value = os.environ.get(s['envSecret'])
        return ({'secret': value.strip(), 'problem': None}
                if isinstance(value, str) and value.strip() != ''
                else {'secret': None, 'problem': f'{s["envSecret"]} is unset or empty'})
    if isinstance(s, str) and s.strip() != '':
        return {'secret': s, 'problem': None}
    if isinstance(s, bytes) and len(s) > 0:
        return {'secret': s, 'problem': None}
    if not s or isinstance(s, str) or isinstance(s, bytes):
        return {'secret': None, 'problem': 'the secret is missing or empty'}
    return {'secret': None,
            'problem': 'the secret must be a string, bytes or env_secret("NAME")'}


def standard_webhooks_key(secret: Any) -> Optional[bytes]:
    """The HMAC key for a Standard Webhooks secret: the base64 after whsec_,
    else the UTF-8 bytes of the whole secret. -> the key, or None when the
    base64 is bad."""
    if isinstance(secret, bytes):
        return secret
    require_at(isinstance(secret, str), 'secret', 'a webhook secret is a string or bytes')
    if not secret.startswith('whsec_'):
        return secret.encode('utf8')
    rest = secret[6:]
    # b64decode ignores what it cannot decode, so check it round-trips.
    try:
        key = base64.b64decode(rest + '=' * (-len(rest) % 4), validate=True)
    except Exception:
        return None
    if len(key) == 0:
        return None
    return key if base64.b64encode(key).decode('ascii').rstrip('=') == rest.rstrip('=') else None


def standard_webhooks_sign(secret: Any, id: Any, timestamp: Any, body: Any) -> str:
    """'"v1,<base64>"' for one message."""
    key = standard_webhooks_key(secret)
    require_at(key is not None, 'secret',
               'the webhook secret starts with whsec_ but the rest is not base64')
    return 'v1,' + _hmac_b64(key, b''.join([_bytes(id), b'.', _bytes(timestamp), b'.', _bytes(body)]))


def header_ref(headers: Any, name: str) -> Any:
    wanted = name.lower()
    if isinstance(headers, list):
        for k, v in headers:
            if str(k).lower() == wanted:
                return v
        return None
    for k, v in (headers or {}).items():
        if str(k).lower() == wanted:
            return v
    return None


def _body_id(body: bytes, key: str) -> str:
    try:
        parsed = json.loads(_bytes(body).decode('utf8'))
    except Exception:  # not JSON
        parsed = None
    v = parsed.get(key) if is_object(parsed) else None
    if isinstance(v, str):
        return v
    if isinstance(v, int) and not isinstance(v, bool):
        return str(v)
    return _sha256_hex(body)


def _stale(text: Any, now: int, tolerance: int, what: str) -> Optional[str]:
    """None when fresh, else the reason."""
    m = re.match(r'^\s*-?[0-9]{1,12}\s*$', text) if isinstance(text, str) else None
    if m is None:
        return f'{what} is not a Unix timestamp'
    ts = int(text.strip())
    off = abs(now - ts)
    if off > tolerance:
        when = 'old' if ts < now else 'in the future'
        return f'{what} is {round(off)} seconds {when}; the tolerance is {tolerance} seconds'
    return None


def _make_verifier(kind: str, secret: Any, check: Callable[..., dict]) -> Callable[..., dict]:
    def verifier(headers: Any, body: Any, now: int) -> dict:
        resolved = resolve_secret(secret)
        if resolved['problem']:
            return {'ok': False, 'deliveryId': None,
                    'reason': f'the {kind} verifier has no secret: {resolved["problem"]}'}
        return check(resolved['secret'], headers, _bytes(body), now)

    verifier.kind = kind
    verifier.secret = secret
    return verifier


def verifier_problem(v: Any) -> Optional[str]:
    """None when the verifier can check signatures, else why not."""
    if not callable(v) or not getattr(v, 'kind', None):
        return None
    resolved = resolve_secret(v.secret)
    if resolved['problem']:
        return resolved['problem']
    if getattr(v, 'kind', None) == 'standard-webhooks' and standard_webhooks_key(resolved['secret']) is None:
        return 'the secret starts with whsec_ but the rest is not base64'
    return None


def standard_webhooks_verifier(secret: Any, *, tolerance: int = 300) -> Callable[..., dict]:
    """Standard Webhooks: webhook-id, webhook-timestamp, webhook-signature (a
    space-separated list of v1,<base64>; any match is enough)."""
    return _make_verifier('standard-webhooks', secret, lambda s, headers, body, now: _sw_check(
        s, headers, body, now, tolerance))


def _sw_check(s: Any, headers: Any, body: bytes, now: int, tolerance: int) -> dict:
    id = header_ref(headers, 'webhook-id')
    ts = header_ref(headers, 'webhook-timestamp')
    sigs = header_ref(headers, 'webhook-signature')
    if id is None or ts is None or sigs is None:
        return {'ok': False, 'deliveryId': None,
                'reason': 'missing webhook-id, webhook-timestamp or webhook-signature'}
    old = _stale(ts, now, tolerance, 'webhook-timestamp')
    if old:
        return {'ok': False, 'deliveryId': None, 'reason': old}
    key = standard_webhooks_key(s)
    if key is None:
        return {'ok': False, 'deliveryId': None,
                'reason': 'the secret starts with whsec_ but the rest is not base64'}
    want = _hmac_b64(key, b''.join([_bytes(id), b'.', _bytes(str(ts).strip()), b'.', body]))
    matched = any(sig.startswith('v1,') and _same_text(sig[3:], want)
                  for sig in re.split(r'\s+', sigs))
    return ({'ok': True, 'deliveryId': id, 'reason': None} if matched
            else {'ok': False, 'deliveryId': None, 'reason': 'webhook-signature does not match'})


def github_verifier(secret: Any) -> Callable[..., dict]:
    """GitHub signs no timestamp, so replays are caught only by the seen markers."""
    def check(s: Any, headers: Any, body: bytes, now: int) -> dict:
        sig = header_ref(headers, 'x-hub-signature-256')
        if sig is None:
            return {'ok': False, 'deliveryId': None, 'reason': 'missing X-Hub-Signature-256'}
        want = f'sha256={_hmac_hex(_bytes(s), body)}'
        if _same_hex(str(sig).strip(), want):
            delivery = header_ref(headers, 'x-github-delivery')
            return {'ok': True, 'deliveryId': delivery if delivery is not None else _sha256_hex(body),
                    'reason': None}
        return {'ok': False, 'deliveryId': None, 'reason': 'X-Hub-Signature-256 does not match'}
    return _make_verifier('github', secret, check)


def stripe_verifier(secret: Any, *, tolerance: int = 300) -> Callable[..., dict]:
    """Stripe: t=<ts>,v1=<hex> over 't.body', keyed by the whole secret as text."""
    def check(s: Any, headers: Any, body: bytes, now: int) -> dict:
        header = header_ref(headers, 'stripe-signature')
        if header is None:
            return {'ok': False, 'deliveryId': None, 'reason': 'missing Stripe-Signature'}
        items = []
        for part in str(header).split(','):
            m = re.match(r'^\s*([^=\s]+)=(.*?)\s*$', part)
            if m:
                items.append((m.group(1), m.group(2)))
        t = next((v for k, v in items if k == 't'), None)
        v1s = [v for k, v in items if k == 'v1']
        if t is None or not v1s:
            return {'ok': False, 'deliveryId': None,
                    'reason': 'Stripe-Signature has no t= or no v1='}
        old = _stale(t, now, tolerance, 'the Stripe-Signature timestamp')
        if old:
            return {'ok': False, 'deliveryId': None, 'reason': old}
        want = _hmac_hex(_bytes(s), b''.join([_bytes(t), b'.', body]))
        if any(_same_hex(v, want) for v in v1s):
            return {'ok': True, 'deliveryId': _body_id(body, 'id'), 'reason': None}
        return {'ok': False, 'deliveryId': None, 'reason': 'Stripe-Signature does not match'}
    return _make_verifier('stripe', secret, check)


def slack_verifier(secret: Any, *, tolerance: int = 300) -> Callable[..., dict]:
    """Slack: v0=<hex> over 'v0:ts:body'."""
    def check(s: Any, headers: Any, body: bytes, now: int) -> dict:
        sig = header_ref(headers, 'x-slack-signature')
        ts = header_ref(headers, 'x-slack-request-timestamp')
        if sig is None or ts is None:
            return {'ok': False, 'deliveryId': None,
                    'reason': 'missing X-Slack-Signature or X-Slack-Request-Timestamp'}
        old = _stale(ts, now, tolerance, 'X-Slack-Request-Timestamp')
        if old:
            return {'ok': False, 'deliveryId': None, 'reason': old}
        want = 'v0=' + _hmac_hex(_bytes(s), b''.join([b'v0:', _bytes(str(ts).strip()), b':', body]))
        if _same_hex(str(sig).strip(), want):
            return {'ok': True, 'deliveryId': _body_id(body, 'event_id'), 'reason': None}
        return {'ok': False, 'deliveryId': None, 'reason': 'X-Slack-Signature does not match'}
    return _make_verifier('slack', secret, check)


def hmac_verifier(secret: Any, *, header: str, encoding: str = 'hex', prefix: str = '',
                  id_header: Optional[str] = None) -> Callable[..., dict]:
    """Anything else that signs the raw body with HMAC-SHA256."""
    require_at(isinstance(header, str), 'header',
               'an HMAC verifier names the header carrying the signature')
    require_at(encoding in ('hex', 'base64'), 'encoding', "encoding is 'hex' or 'base64'")

    def check(s: Any, headers: Any, body: bytes, now: int) -> dict:
        sig = header_ref(headers, header)
        want = prefix + (_hmac_hex(_bytes(s), body) if encoding == 'hex'
                         else _hmac_b64(_bytes(s), body))
        if sig is None:
            return {'ok': False, 'deliveryId': None, 'reason': f'missing {header}'}
        matched = _same_hex(str(sig).strip(), want) if encoding == 'hex' else _same_text(str(sig).strip(), want)
        if matched:
            delivery = header_ref(headers, id_header) if id_header else None
            return {'ok': True, 'deliveryId': delivery or _sha256_hex(body), 'reason': None}
        return {'ok': False, 'deliveryId': None, 'reason': f'{header} does not match'}
    return _make_verifier('hmac', secret, check)


# A dispatch key is used as it is when it is plain (Standard Webhooks asks for
# no dots), else hashed into a msg_ id. Either way it is stable across retries.
def key_to_message_id(key: Any) -> str:
    s = str(key)
    return s if re.match(r'^[A-Za-z0-9_:/-]{1,128}$', s) else f'msg_{_sha256_hex(s.encode("utf8"))[:32]}'


def redact_url(value: Any) -> str:
    """The URL without its path or query, for messages: a webhook URL can
    itself be a secret (Slack's are)."""
    try:
        url = urlsplit(str(value))
        if url.scheme and url.netloc:
            return f'{url.scheme}://{url.netloc}/...'
    except ValueError:
        pass
    return 'the webhook URL'


def _retryable_status(status: int) -> bool:
    return status == 408 or status == 429 or status >= 500


def _check_url(who: str, value: Any) -> None:
    try:
        url = urlsplit(str(value))
        ok = url.scheme in ('http', 'https') and url.netloc != ''
    except ValueError:
        ok = False
    require_at(ok, who, 'the URL must be http:// or https:// with a host')


async def _default_sleep(seconds: float) -> None:
    await asyncio.sleep(seconds)


def webhook_handler(url: str, *, secret: Any, attempts: int = 3, timeout_seconds: float = 10,
                    include_state: bool = False, backoff: float = 1, type: str = 'jev.decision',
                    sleep: Any = _default_sleep, now: Any = None,
                    post: Any = None) -> Callable[..., Any]:
    """-> a handler returning {'status', 'webhook_id', 'attempts'}"""
    if now is None:
        import time as _time
        now = lambda: int(_time.time())  # noqa: E731
    _check_url('webhookHandler', url)
    resolved = resolve_secret(secret)
    require_at(resolved['problem'] is None, 'secret', f"webhookHandler: {resolved['problem']}")
    key = standard_webhooks_key(resolved['secret'])
    require_at(key is not None, 'secret',
               'webhookHandler: the secret starts with whsec_ but the rest is not base64')
    require_at(isinstance(attempts, int) and not isinstance(attempts, bool) and attempts > 0,
               'attempts', 'attempts is a positive integer')
    require_at(finite(timeout_seconds) and timeout_seconds > 0, 'timeoutSeconds',
               'a timeout is positive seconds')
    require_at(finite(backoff) and backoff >= 0, 'backoff', 'backoff is seconds, at least 0')
    where = redact_url(url)
    sender = post or _urllib_post

    async def handler(state: Any, decision: dict, context: Any = None) -> dict:
        id = (key_to_message_id(context.get('key'))
              if is_object(context) and context.get('key') is not None
              else f'msg_{secrets.token_bytes(8).hex()}')
        data: Dict[str, Any] = {'decision': decision, 'explain': explain_decision(decision)}
        if include_state:
            data['state'] = state
        body = jsonify({'type': type, 'timestamp': _iso(now()), 'data': data})
        attempt = 1
        while True:
            ts = str(now())
            status, text, retry_after, trouble = None, '', None, None
            try:
                status, text, retry_after = await sender(url, body, {
                    'Content-Type': 'application/json',
                    'User-Agent': 'jev-webhooks',
                    'webhook-id': id,
                    'webhook-timestamp': ts,
                    'webhook-signature': standard_webhooks_sign(key, id, ts, body),
                }, timeout_seconds)
                text = text.strip()
            except TimeoutError:
                trouble = f'timed out after {timeout_seconds} seconds'
            except Exception:
                trouble = 'could not connect'
            what = trouble or (f'answered {status}'
                               + (f': {text[:200] if len(text) > 200 else text}' if text != '' else ''))
            if status is not None and 200 <= status <= 299:
                return {'status': status, 'webhook_id': id, 'attempts': attempt}
            if status is not None and not _retryable_status(status):
                raise Exception(f'the webhook receiver at {where} {what}\n'
                                '  not retried: only a connection error, a timeout, 408, 429 and 5xx are')
            if attempt >= attempts:
                raise Exception(f'the webhook receiver at {where} {what}, after '
                                f'{attempts} attempt{"" if attempts == 1 else "s"} (webhook-id {id})')
            wait = backoff * 2 ** (attempt - 1)
            if retry_after is not None and retry_after <= 60:
                wait = max(wait, retry_after)
            await sleep(wait)
            attempt += 1

    handler.handlerName = f'webhook {where}'
    return handler


async def _urllib_post(url: str, body: str, headers: Dict[str, str], timeout_seconds: float):
    import urllib.error
    import urllib.request
    import socket

    def run():
        try:
            return urllib.request.urlopen(
                urllib.request.Request(url, data=body.encode('utf8'), method='POST',
                                       headers=headers),
                timeout=timeout_seconds)
        except urllib.error.HTTPError as error:
            return error
        except urllib.error.URLError as error:
            reason = getattr(error, 'reason', error)
            if isinstance(reason, (TimeoutError, socket.timeout)):
                raise TimeoutError(str(reason))
            raise OSError(str(reason))

    response = await asyncio.to_thread(run)
    try:
        text = response.read().decode('utf8')
        after = response.headers.get('retry-after')
        retry_after = (int(str(after).strip())
                       if after is not None and re.match(r'^\s*[0-9]+\s*$', after) else None)
        return response.status, text, retry_after
    finally:
        response.close()


# For a handlers file ("type": "webhook"). Keys: url, secret_env (the name of
# the variable holding the secret, never the secret), attempts, timeout,
# include_state.
_SPEC_KEYS = ['url', 'secret_env', 'attempts', 'timeout', 'include_state']
_SPEC_IGNORED = ['type', 'name', 'description', 'target']


def webhook_handler_from_spec(spec: Any) -> Callable[..., Any]:
    def bad(key: str, message: str) -> None:
        require_at(False, f'webhook.{key}', f'"{key}" {message}', None, 'handler')

    require_at(is_object(spec), 'webhook',
               f'a webhook handler is a JSON object with {", ".join(_SPEC_KEYS)}', None, 'handler')
    for key in spec:
        if key not in _SPEC_KEYS and key not in _SPEC_IGNORED:
            bad(key, f'is not a webhook handler key\n  the keys are: {", ".join(_SPEC_KEYS)}')

    def get(key: str) -> Any:
        return spec.get(key) if spec.get(key) is not None else None

    url = get('url')
    if not isinstance(url, str):
        bad('url', 'is required: the http(s) URL to POST to')
    try:
        _check_url('webhook', url)
    except Exception:
        bad('url', f'must be http:// or https:// with a host; got {jsonify(url)}')
    env = get('secret_env')
    if not (isinstance(env, str) and re.match(r'^[A-Za-z_][A-Za-z0-9_]*$', env)):
        bad('secret_env', 'is required: the name of the environment variable holding the secret\n'
                          '  (the secret itself never goes in the file)')
    if resolve_secret(env_secret(env))['problem']:
        bad('secret_env', f'names {env}, which is unset or empty')
    attempts = get('attempts') if get('attempts') is not None else 3
    if not (isinstance(attempts, int) and not isinstance(attempts, bool) and attempts > 0):
        bad('attempts', 'must be a positive integer')
    timeout_seconds = get('timeout') if get('timeout') is not None else 10
    if not (finite(timeout_seconds) and timeout_seconds > 0):
        bad('timeout', 'must be a positive number of seconds')
    include_state = spec.get('include_state') if own(spec, 'include_state') else False
    if not isinstance(include_state, bool):
        bad('include_state', 'must be true or false')
    return webhook_handler(url, secret=env_secret(env), attempts=attempts,
                           timeout_seconds=timeout_seconds, include_state=include_state)


def _register_webhook_handler_type() -> None:
    from ._handlers import register_handler_type
    register_handler_type('webhook', lambda spec, base: webhook_handler_from_spec(spec))


_register_webhook_handler_type()


def webhook_source(name: Any, *, verify: Any = None, event: Any, sync: Any = None,
                   insecure: bool = False) -> dict:
    """A source names the <name> in POST /webhook/<name>, how to verify it, and
    how to turn its body into events."""
    id = str(name)
    require_at(re.match(r'^[A-Za-z0-9_-]+$', id) is not None, 'name',
               'a source name is letters, digits, _ and -, as it is the <name> in POST /webhook/<name>')
    require_at(callable(event), f'source.{id}', 'event is a function of (json, headers)')
    require_at(sync is None or callable(sync), f'source.{id}',
               'sync is None or a function of (json, headers)')
    require_at(verify is None or verify == 'none' or callable(verify), f'source.{id}',
               'verify is a verifier, a function of (headers, body, now), or "none"')
    return {'name': id, 'verify': verify, 'event': event, 'sync': sync, 'insecure': bool(insecure)}


def case_event(id: Any, input: Any) -> dict:
    """One case to decide."""
    return {'kind': 'case', 'id': None if id is None else str(id), 'input': input}


def outcome_event(id: Any, *, kind: Any = None, label: Any = None, labels: Any = None) -> dict:
    """One outcome that labels a case a person already saw."""
    return {'kind': 'outcome', 'id': str(id), 'outcomeKind': kind, 'label': label, 'labels': labels}


def is_case_event(v: Any) -> bool:
    return is_object(v) and v.get('kind') == 'case'


def is_outcome_event(v: Any) -> bool:
    return is_object(v) and v.get('kind') == 'outcome'
