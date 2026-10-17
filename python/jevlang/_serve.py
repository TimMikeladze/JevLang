"""An HTTP sidecar for one policy, so services in any language can use it.

The portable mirror of src/serve.mjs: GET /healthz, GET /policy, POST /decide
(offline and pure), POST /evaluate (asks the selected provider), POST /dispatch
(evaluates, then runs the handlers). With a token, every request but GET
/healthz needs 'Authorization: Bearer <token>'. /dispatch runs side effects,
so outside a dry run it answers 403 unless the server has a token or is bound
to loopback. It binds 127.0.0.1 by default; if the port is taken it tries the
next ones and reports the port it got. Other modules add routes: MCP's
POST /mcp, and the webhook receivers' POST /webhook/<name>."""
from __future__ import annotations

import asyncio
import hmac
import json
import re
from typing import Any, Dict, List, Optional

from ._surface_options import surface_options, invoke_evaluate
from ._common import is_object, own, require_at
from ._dispatch import dispatch_for_input, make_dispatcher, outcome_to_json
from ._explain import explain_decision
from ._mcp import policy_to_json

_BUILTIN_ROUTES = [['GET', '/healthz'], ['GET', '/policy'], ['POST', '/decide'],
                   ['POST', '/evaluate'], ['POST', '/dispatch']]


def serve_route(*, method: str, path: str, prefix: bool = False, auth: str = 'token',
                handler: Any) -> dict:
    return {'method': method, 'path': path, 'prefix': prefix, 'auth': auth, 'handler': handler}


def _route_of(path: Any) -> str:
    return '/' + (path or '/').split('?')[0].lstrip('/').rstrip('/')


def _route_matches(route: dict, path: str) -> bool:
    return path.startswith(route['path']) if route['prefix'] else path == route['path']


def loopback_host(host: str) -> bool:
    return host in ('127.0.0.1', 'localhost', '::1', '[::1]')


def token_matches(token: str, header: Any) -> bool:
    m = re.match(r'^Bearer\s+(.*)$', str(header if header is not None else '').strip(), re.I)
    if not m:
        return False
    a, b = m.group(1).encode('utf8'), token.encode('utf8')
    return len(a) == len(b) and hmac.compare_digest(a, b)


def make_serve_dispatchers(policy: Any, handlers: Dict[str, Any], *, journal: Any = None) -> dict:
    """The dispatchers /dispatch uses, from a handlers table. A confirm entry
    becomes the confirm handler, and the dry one runs nothing."""
    table = {k: v for k, v in handlers.items() if k != 'confirm'}
    confirm = handlers.get('confirm')
    return {'run': make_dispatcher(table, policy=policy, confirm=confirm, journal=journal),
            'dry': make_dispatcher(table, policy=policy, confirm=confirm, dry_run=True)}


def _error_body(message: str, kind: str) -> dict:
    return {'error': message, 'kind': kind}


def _decision_response(policy: Any, d: dict) -> dict:
    return {**d, 'explain': explain_decision(d),
            'policy': {'name': policy.policy.get('name'), 'hash': policy.identity(), 'file': None}}


def _outcome_response(o: dict) -> dict:
    return {**outcome_to_json(o), 'explain': explain_decision(o['initial'])}


def _error_kind(error: Any) -> str:
    # /decide gets answers from the caller, so a bad answer is the caller's
    # (422); /evaluate gets them from a provider, so a bad answer is
    # upstream's (502).
    code = getattr(error, 'code', None) or getattr(error, 'kind', None)
    if code in ('answers', 'response', 'state', 'timeout'):
        return code
    if code in ('rate-limit', 'overload', 'authentication', 'auth'):
        return 'upstream'
    if code == 'connection':
        return 'connection'
    if isinstance(code, str) and code != 'internal':
        return 'jev'
    return 'internal'


def _error_status(error: Any, route: str) -> int:
    kind = _error_kind(error)
    if kind == 'timeout':
        return 504
    if kind in ('upstream', 'connection'):
        return 502
    if kind == 'response':
        return 502 if route == '/evaluate' else 422
    if kind in ('answers', 'state'):
        return 422
    return 500


async def handle_request(policy: Any, method: str, path: str, body: Any, *,
                         dispatchers: Any = None, dispatch_allowed: bool = True,
                         headers: Any = None, routes: Optional[List[dict]] = None,
                         evaluate: Any = None, experimental: Any = None) -> dict:
    """-> {'status', 'body', 'headers'}"""
    if headers is None:
        headers = {}
    routes = routes or []
    route = _route_of(path)
    matching = [r for r in routes if _route_matches(r, route)]
    if matching:
        chosen = next((r for r in matching if r['method'] == method), None)
        if chosen:
            return await _await_if(chosen['handler'](method, path, headers, body))
        allow = ', '.join(r['method'] for r in matching)
        return {'status': 405, 'body': _error_body(f'{route} takes {allow}', 'method'),
                'headers': {'Allow': allow}}
    allowed = [m for m, p in _BUILTIN_ROUTES if p == route]
    if not allowed:
        return {'status': 404,
                'body': {**_error_body(f'no route {route}', 'not-found'),
                         'routes': [f'{m} {p}' for m, p in _BUILTIN_ROUTES]
                         + [f"{r['method']} {r['path']}{'<name>' if r['prefix'] else ''}"
                            for r in routes]},
                'headers': {}}
    if method not in allowed:
        return {'status': 405, 'body': _error_body(f'{route} takes {", ".join(allowed)}', 'method'),
                'headers': {}}
    if route == '/healthz':
        return {'status': 200, 'body': {'ok': True, 'policy': policy.policy.get('name')},
                'headers': {}}
    if route == '/policy':
        return {'status': 200, 'body': policy_to_json(policy), 'headers': {}}
    if route == '/dispatch':
        return await _dispatch_request(policy, body, dispatchers, dispatch_allowed, evaluate, experimental)
    try:
        request = json.loads(body if isinstance(body, str) else bytes(body or b'').decode('utf8'))
    except Exception:
        request = None
    key = 'answers' if route == '/decide' else 'state'
    if request is None:
        return {'status': 400, 'body': _error_body('the body is not valid JSON', 'request'),
                'headers': {}}
    if not (is_object(request) and own(request, key)):
        return {'status': 400, 'body': _error_body(
            'expected {"answers": {...}}, the answers object of a policy provider response'
            if route == '/decide'
            else 'expected {"state": ...}, the input the policy\'s evaluate takes', 'request'),
            'headers': {}}
    if route == '/evaluate' and not evaluate:
        return {'status': 501,
                'body': _error_body('this server was started without an evaluate function',
                                    'unsupported'),
                'headers': {}}
    try:
        options = {'facts': request.get('facts')} if is_object(request.get('facts')) else {}
        decision = (policy.decide(request['answers'], options)
                    if route == '/decide'
                    else await _await_if(invoke_evaluate(evaluate, request['state'], surface_options(policy, request, experimental))))
        return {'status': 200, 'body': _decision_response(policy, decision), 'headers': {}}
    except Exception as error:
        return {'status': _error_status(error, route),
                'body': _error_body(str(error), _error_kind(error)), 'headers': {}}


async def _await_if(value: Any) -> Any:
    if asyncio.iscoroutine(value) or asyncio.isfuture(value):
        return await value
    return value


async def _dispatch_request(policy: Any, body: Any, dispatchers: Any, allowed: bool,
                            evaluate: Any, experimental: Any = None) -> dict:
    try:
        request = json.loads(body if isinstance(body, str) else bytes(body or b'').decode('utf8'))
    except Exception:
        request = None

    def field(key: str) -> Any:
        value = request.get(key) if is_object(request) else None
        return None if value is None else value

    dry = field('dry_run') is True
    if not dispatchers:
        return {'status': 400,
                'body': _error_body('this server has no handlers; start it with handlers',
                                    'unsupported'), 'headers': {}}
    if request is None:
        return {'status': 400, 'body': _error_body('the body is not valid JSON', 'request'),
                'headers': {}}
    if not (is_object(request) and own(request, 'input')):
        return {'status': 400,
                'body': _error_body('expected {"input": ..., "principal": ..., "key": ..., '
                                    '"dry_run": false}', 'request'),
                'headers': {}}
    if not dry and not allowed:
        return {'status': 403,
                'body': _error_body('/dispatch runs handlers, so it needs a token or a loopback '
                                    'bind; a dry run is allowed', 'forbidden'),
                'headers': {}}
    if not field('answers') and not evaluate:
        return {'status': 501,
                'body': _error_body('this server was started without an evaluate function; '
                                    'send "answers"', 'unsupported'),
                'headers': {}}
    route = '/decide' if field('answers') else '/evaluate'
    try:
        input_value = request['input']
        request_options = surface_options(policy, request, experimental)
        facts = policy.build_state(input_value, request_options)['facts']
        decision = await _await_if(
            policy.decide(request['answers'], {'facts': facts}) if field('answers')
            else invoke_evaluate(evaluate, input_value, request_options))
        outcome = await dispatch_for_input(dispatchers['dry'] if dry else dispatchers['run'],
                                           input_value, decision,
                                           principal=field('principal'),
                                           key=None if field('key') is None else str(field('key')))
        return {'status': 200, 'body': _outcome_response(outcome), 'headers': {}}
    except Exception as error:
        return {'status': _error_status(error, route),
                'body': _error_body(str(error), _error_kind(error)), 'headers': {}}


class _Server:
    def __init__(self, host: str, port: int, wanted: int, dispatch_allowed: bool, server: Any,
                 log: Any):
        self.host = host
        self.port = port
        self.wanted = wanted
        self.dispatch_allowed = dispatch_allowed
        self.url = f'http://{host}:{port}'
        self._server = server
        self._log = log

    async def stop(self) -> None:
        if self._server is None:
            return
        self._server.close()
        await self._server.wait_closed()
        self._server = None


async def _read_message(reader: asyncio.StreamReader) -> bytes:
    """Read one HTTP message: the head, then Content-Length bytes of body."""
    data = b''
    while b'\r\n\r\n' not in data and b'\n\n' not in data:
        chunk = await reader.read(4096)
        if not chunk:
            return data
        data += chunk
    head, sep, rest = data.partition(b'\r\n\r\n')
    if not sep:
        head, sep, rest = data.partition(b'\n\n')
    length = 0
    for line in head.decode('latin1').split('\n'):
        at = line.find(':')
        if at > 0 and line[:at].strip().lower() == 'content-length':
            length = int(line[at + 1:].strip() or 0)
    while len(rest) < length:
        chunk = await reader.read(4096)
        if not chunk:
            break
        rest += chunk
    return head + sep + rest


async def start_server(policy: Any, *, host: str = '127.0.0.1', port: int = 8080, tries: int = 20,
                       token: Optional[str] = None, dispatchers: Any = None,
                       routes: Optional[List[dict]] = None, evaluate: Any = None,
                       log: Any = None, experimental: Any = None) -> _Server:
    """Binds the port, or the next free one after it, and never touches
    whatever holds the one it wanted."""
    routes = routes or []
    require_at(isinstance(port, int) and not isinstance(port, bool) and port >= 0, 'port',
               'a port is a non-negative integer')
    dispatch_allowed = bool(token) or loopback_host(host)

    async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            data = await _read_message(reader)
            head, _, body = data.partition(b'\r\n\r\n')
            if not _:
                head, _, body = data.partition(b'\n\n')
            lines = head.decode('latin1').split('\n')
            request_line = lines[0].strip()
            parts = request_line.split(' ')
            method = parts[0] if parts else 'GET'
            url = parts[1] if len(parts) > 1 else '/'
            headers = {}
            for line in lines[1:]:
                at = line.find(':')
                if at > 0:
                    headers[line[:at].strip().lower()] = line[at + 1:].strip()
            route = _route_of(url)
            extra = next((r for r in routes if _route_matches(r, route)), None)
            needs_token = (token and route != '/healthz'
                           and (extra is None or extra['auth'] == 'token'))
            if needs_token and not token_matches(token, headers.get('authorization')):
                answer = {'status': 401,
                          'body': _error_body('this server needs Authorization: Bearer <token>',
                                              'auth'), 'headers': {}}
            else:
                try:
                    answer = await handle_request(policy, method, url, body, dispatchers=dispatchers,
                                                  dispatch_allowed=dispatch_allowed,
                                                  headers=headers, routes=routes, evaluate=evaluate, experimental=experimental)
                except Exception as error:
                    answer = {'status': 500, 'body': _error_body(str(error), 'internal'),
                              'headers': {}}
            if answer['body'] is None:
                text = b''
            elif isinstance(answer['body'], (bytes, bytearray)):
                text = answer['body']
            else:
                from ._numberfmt import jsonify
                text = jsonify(answer['body']).encode('utf8')
            status = answer['status']
            reason = {200: 'OK', 202: 'Accepted', 400: 'Bad Request', 401: 'Unauthorized',
                      403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed',
                      422: 'Unprocessable Entity', 500: 'Internal Server Error',
                      501: 'Not Implemented', 502: 'Bad Gateway', 504: 'Gateway Timeout'}.get(
                          status, 'OK')
            body_bytes = text
            header_lines = [f'HTTP/1.1 {status} {reason}', 'Connection: close']
            if body_bytes:
                header_lines.append('Content-Type: application/json')
            header_lines.append(f'Content-Length: {len(body_bytes)}')
            for k, v in (answer.get('headers') or {}).items():
                header_lines.append(f'{k}: {v}')
            writer.write(('\r\n'.join(header_lines) + '\r\n\r\n').encode('latin1') + body_bytes)
            await writer.drain()
            if log is not None and hasattr(log, 'write'):
                log.write(f'{method} {route} {status}\n')
        except Exception:  # a broken connection is not the server's failure
            pass
        finally:
            try:
                writer.close()
            except Exception:
                pass

    wanted = port
    bound = None
    server = None
    for attempt in range(tries):
        candidate = 0 if port == 0 else wanted + attempt
        try:
            server = await asyncio.start_server(handle, host, candidate)
            bound = server.sockets[0].getsockname()[1]
            break
        except OSError as error:
            if error.errno != 48:  # EADDRINUSE
                raise
    require_at(bound is not None, 'port',
               f'every port from {wanted} to {wanted + tries - 1} is taken')
    return _Server(host, bound, wanted, dispatch_allowed, server, log)
