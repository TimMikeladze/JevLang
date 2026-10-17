"""MCP, the client side: call another server's tools, and use them as dispatcher
handlers.

The portable mirror of src/mcp-client.mjs. It is dual-era, as the spec asks:
stdio probes with server/discover and falls back to initialize; HTTP tries a
modern POST first and falls back to initialize on an unrecognized 4xx. A
legacy server may send requests of its own (ping, elicitation/create); a
modern server asks with an input-required result instead, which mcp_call_tool
answers through on_elicit and retries."""
from __future__ import annotations

import asyncio
import json
import re
from typing import Any, Awaitable, Callable, Dict, List, Optional, Tuple

from ._common import is_object, own, require_at
from ._mcp import (MCP_ERROR_CODES, MODERN_VERSION, MODERN_VERSIONS, LEGACY_VERSIONS,
                   SUPPORTED_VERSIONS, META_PROTOCOL_VERSION, META_CLIENT_CAPABILITIES,
                   META_CLIENT_INFO, META_SERVER_INFO, McpError, encode_header_value,
                   input_required, jsonrpc_error)
from ._numberfmt import jsonify
from ._provider import find_executable

CLIENT_INFO = {'name': 'jev', 'version': '2.3'}
_MODERN_ERROR_CODES = [MCP_ERROR_CODES['header-mismatch'], MCP_ERROR_CODES['missing-capability'],
                       MCP_ERROR_CODES['unsupported-version']]


class McpClientError(Exception):
    def __init__(self, kind: str, message: str, *, status: Optional[int] = None):
        super().__init__(message)
        self.name = 'McpClientError'
        self.kind = kind  # connection | timeout | auth | response
        self.status = status


async def mcp_connect(target: Any, *, headers: Optional[List[str]] = None,
                      timeout_seconds: float = 30, probe_timeout_seconds: float = 5,
                      on_elicit: Any = None, stderr: str = 'inherit') -> dict:
    """target: a command array, like ['npx', '-y', 'some-server'], or an http(s) URL."""
    headers = headers or []
    if isinstance(target, str) and re.match(r'^https?://', target):
        client = _http_client(target, headers, timeout_seconds, on_elicit)
    else:
        require_at(isinstance(target, list) and len(target) > 0
                   and all(isinstance(x, str) for x in target),
                   'target', 'an MCP target is a command array or an http(s):// URL')
        client = _stdio_client(target, timeout_seconds, on_elicit, stderr)
    try:
        await _open(client, probe_timeout_seconds)
    except Exception:
        await mcp_close(client, force=True)
        raise
    return client


def _client_capabilities(c: dict) -> dict:
    return {'elicitation': {'form': {}}} if c.get('onElicit') else {}


def _modern_meta(c: dict) -> dict:
    return {META_PROTOCOL_VERSION: MODERN_VERSION,
            META_CLIENT_CAPABILITIES: _client_capabilities(c),
            META_CLIENT_INFO: CLIENT_INFO}


def _no_common_version(c: dict, versions: List[str], message: Optional[str] = None) -> None:
    raise McpClientError('connection',
                         f"{c['source']} speaks no protocol version this client does"
                         + (f' ({message})' if message else '')
                         + "\n  it supports: " + (', '.join(versions) if versions else "(it didn't say)")
                         + f"\n  this client: {', '.join(SUPPORTED_VERSIONS)}")


async def _open(c: dict, probe_timeout_seconds: float) -> None:
    probe = _request_message(c, 'server/discover', {'_meta': _modern_meta(c)})
    answer = {'status': 0, 'reply': None}
    try:
        answer = await c['send'](probe, MODERN_VERSION, probe_timeout_seconds, cancel=False)
    except McpClientError as error:
        if error.kind != 'timeout':
            raise
    status, reply = answer['status'], answer['reply']
    error = reply.get('error') if is_object(reply) else None
    result = reply.get('result') if is_object(reply) else None
    if is_object(result) and 200 <= status <= 299:
        versions = result.get('supportedVersions') if isinstance(result.get('supportedVersions'), list) else []
        if MODERN_VERSION in versions:
            c['era'] = 'modern'
            c['version'] = MODERN_VERSION
            c['capabilities'] = result.get('capabilities') if is_object(result.get('capabilities')) else {}
            c['instructions'] = result.get('instructions') if isinstance(result.get('instructions'), str) else None
            info = result.get('_meta', {}).get(META_SERVER_INFO) if is_object(result.get('_meta')) else None
            c['serverInfo'] = info if is_object(info) else None
            return
        if any(v in LEGACY_VERSIONS for v in versions):
            await _initialize(c)
            return
        _no_common_version(c, versions)
    # A modern server that does not speak our version: do not fall back.
    if is_object(error) and error.get('code') in _MODERN_ERROR_CODES:
        supported = (error.get('data', {}).get('supported')
                     if is_object(error.get('data')) and isinstance(error.get('data').get('supported'), list)
                     else [])
        _no_common_version(c, supported, error.get('message') or '')
    if status in (401, 403):
        raise McpClientError('auth', f"{c['source']} answered {status}\n"
                                     '  it wants credentials: pass headers, or set JEV_MCP_TOKEN',
                             status=status)
    if status >= 500:
        raise McpClientError('connection', f"{c['source']} answered HTTP {status} to server/discover",
                             status=status)
    await _initialize(c)


async def _initialize(c: dict) -> None:
    msg = _request_message(c, 'initialize', {
        'protocolVersion': LEGACY_VERSIONS[0], 'capabilities': _client_capabilities(c),
        'clientInfo': CLIENT_INFO,
    })
    answer = await c['send'](msg, None, c['timeoutSeconds'])
    status, reply = answer['status'], answer['reply']
    result = _check_reply(c, 'initialize', status, reply)
    if result.get('protocolVersion') not in LEGACY_VERSIONS:
        _no_common_version(c, [result.get('protocolVersion')])
    c['era'] = 'legacy'
    c['version'] = result.get('protocolVersion')
    c['capabilities'] = result.get('capabilities') if is_object(result.get('capabilities')) else {}
    c['serverInfo'] = result.get('serverInfo') if is_object(result.get('serverInfo')) else None
    c['instructions'] = result.get('instructions') if isinstance(result.get('instructions'), str) else None
    await c['notify']({'jsonrpc': '2.0', 'method': 'notifications/initialized'}, c['version'])


def _request_message(c: dict, method: str, params: Any) -> dict:
    c['nextId'] += 1
    return {'jsonrpc': '2.0', 'id': c['nextId'], 'method': method, 'params': params}


def _check_reply(c: dict, method: str, status: int, reply: Any) -> dict:
    if not is_object(reply):
        raise McpClientError('connection',
                             f"{c['source']} gave no JSON-RPC reply to {method}"
                             + (f' (HTTP {status})' if status and status != 200 else ''),
                             status=status)
    if is_object(reply.get('error')):
        e = reply['error']
        code = e.get('code') if isinstance(e.get('code'), int) and not isinstance(e.get('code'), bool) \
            else MCP_ERROR_CODES['internal-error']
        raise McpError(code, f"{c['source']}: {method} failed: {e.get('message') or ''}", e.get('data'))
    if is_object(reply.get('result')):
        return reply['result']
    raise McpClientError('response', f"{c['source']}: the reply to {method} has no result object")


async def mcp_request(c: dict, method: str, params: Any = None, *,
                      timeout_seconds: Optional[float] = None,
                      headers: Optional[List[str]] = None) -> dict:
    """-> the result object. A JSON-RPC error raises McpError; a timeout or a
    dead server an McpClientError."""
    params = params if params is not None else {}
    headers = headers or []
    if timeout_seconds is None:
        timeout_seconds = c['timeoutSeconds']
    require_at(is_object(params), 'params', 'MCP params are an object')
    if c['era'] == 'modern':
        meta = params.get('_meta') if is_object(params.get('_meta')) else {}
        full = {**params, '_meta': {**meta, **_modern_meta(c)}}
    else:
        full = params
    msg = _request_message(c, method, full)
    answer = await c['send'](msg, c['version'], timeout_seconds, headers=headers)
    status, reply = answer['status'], answer['reply']
    result = _check_reply(c, method, status, reply)
    # Results from servers before 2026-07-28 have no resultType: "complete".
    return result if own(result, 'resultType') else {**result, 'resultType': 'complete'}


async def mcp_notify(c: dict, method: str, params: Any = None) -> Any:
    return await c['notify']({'jsonrpc': '2.0', 'method': method,
                              'params': params if params is not None else {}}, c['version'])


async def mcp_list_tools(c: dict) -> List[dict]:
    """Every tool, following nextCursor. Over HTTP, a tool whose x-mcp-header
    annotations break the spec's rules is left out, with a warning, as the spec
    requires of an HTTP client."""
    all_tools: List[dict] = []
    seen = set()
    cursor = None
    while True:
        result = await mcp_request(c, 'tools/list', {'cursor': cursor} if cursor else {})
        tools = result.get('tools') if isinstance(result.get('tools'), list) else []
        all_tools.extend(t for t in tools if is_object(t))
        nxt = result.get('nextCursor')
        if not isinstance(nxt, str) or nxt in seen or len(seen) >= 1000:
            break
        seen.add(nxt)
        cursor = nxt
    kept = all_tools
    if c['kind'] == 'http':
        def fine(tool: dict) -> bool:
            why = param_headers_problem(tool.get('inputSchema'))
            if why:
                import sys
                print(f"jev mcp: warning: leaving out tool {tool.get('name', '?')} "
                      f"from {c['source']}: {why}", file=sys.stderr)
            return not why
        kept = [t for t in all_tools if fine(t)]
    c['tools'] = {t['name']: t for t in kept if isinstance(t.get('name'), str)}
    return kept


# x-mcp-header: tool parameters mirrored into Mcp-Param-<name> headers.
_TOKEN = re.compile(r"^[!#$%&'*+.^_`|~0-9A-Za-z-]+$")


def _reachable_param_headers(schema: Any, path: Optional[List[str]] = None) -> List[Tuple[List[str], Any, dict]]:
    """[path, annotation, schema] for each x-mcp-header reachable through
    properties alone, where path is the property names from the root."""
    path = path or []
    if not is_object(schema):
        return []
    here = [(path, schema['x-mcp-header'], schema)] if own(schema, 'x-mcp-header') else []
    out = list(here) if path else []
    properties = schema.get('properties') if is_object(schema.get('properties')) else None
    if properties:
        for k, v in properties.items():
            out.extend(_reachable_param_headers(v, path + [k]))
    return out


def _count_annotations(v: Any) -> int:
    if is_object(v):
        return (1 if own(v, 'x-mcp-header') else 0) + sum(_count_annotations(x) for x in v.values())
    if isinstance(v, list):
        return sum(_count_annotations(x) for x in v)
    return 0


def param_headers_problem(schema: Any) -> Optional[str]:
    """None when the tool's annotations are fine, else why they are not."""
    if not is_object(schema):
        return None
    found = _reachable_param_headers(schema)
    names = [name for _, name, _ in found]
    if len(found) != _count_annotations(schema):
        return 'an x-mcp-header sits somewhere other than a chain of properties'
    if any(not isinstance(n, str) or not _TOKEN.match(n) for n in names):
        return 'an x-mcp-header value is not a header-name token'
    lowered = [n.lower() for n in names]
    if len(set(lowered)) != len(lowered):
        return 'two x-mcp-header values are the same'
    if any(s.get('type') not in ('string', 'integer', 'boolean') for _, _, s in found):
        return 'x-mcp-header is only for string, integer and boolean parameters'
    return None


def _param_headers(tool: Any, args: dict) -> List[str]:
    out = []
    for path, name, _schema in _reachable_param_headers(tool.get('inputSchema') if is_object(tool) else None):
        value = args
        for key in path:
            value = value.get(key) if is_object(value) else None
        if value is None:
            continue
        text = value if isinstance(value, str) else str(value).lower() if isinstance(value, bool) else str(value)
        out.append(f'Mcp-Param-{name}: {encode_header_value(text)}')
    return out


async def mcp_call_tool(c: dict, name: str, args: Any = None, *, input_responses: Any = None,
                        request_state: Any = None, timeout_seconds: Optional[float] = None) -> dict:
    """-> the CallToolResult. When the server asks for input and every request
    is an elicitation, on_elicit answers them and the call is retried, up to
    three rounds; otherwise the input-required result comes back."""
    if args is None:
        args = {}
    if timeout_seconds is None:
        timeout_seconds = c['timeoutSeconds']
    responses, state = input_responses, request_state
    round_ = 0
    while True:
        params: Dict[str, Any] = {'name': name, 'arguments': args}
        if responses:
            params['inputResponses'] = responses
        if state:
            params['requestState'] = state
        headers: List[str] = []
        if c['kind'] == 'http' and c['era'] == 'modern':
            # The headers come from the tool's schema, so list the tools first.
            if name not in c['tools']:
                await mcp_list_tools(c)
            headers = _param_headers(c['tools'].get(name), args)
        result = await mcp_request(c, 'tools/call', params, timeout_seconds=timeout_seconds, headers=headers)
        asks = result.get('inputRequests') if input_required(result) else None
        answerable = (is_object(asks) and c.get('onElicit') and round_ < 3
                      and all(is_object(q) and q.get('method') == 'elicitation/create'
                              for q in asks.values()))
        if not answerable:
            return result
        answered = {}
        for key, q in asks.items():
            answered[key] = await _answer_elicitation(c, q.get('params') if is_object(q.get('params')) else {})
        responses = answered
        state = result.get('requestState') if isinstance(result.get('requestState'), str) else None
        round_ += 1


async def _answer_elicitation(c: dict, params: dict) -> dict:
    try:
        r = await c['onElicit'](params)
        return r if is_object(r) else {'action': 'cancel'}
    except Exception:
        return {'action': 'cancel'}


async def mcp_close(c: dict, *, force: bool = False) -> Any:
    return await c['close'](force)


def mcp_result_text(r: Any) -> str:
    """The text blocks of a result, joined."""
    content = r.get('content') if is_object(r) and isinstance(r.get('content'), list) else []
    return '\n'.join(b['text'] for b in content
                     if is_object(b) and b.get('type') == 'text' and isinstance(b.get('text'), str))


def _base_client(source: str, kind: str, send: Any, notify: Any, close: Any,
                 timeout_seconds: float, on_elicit: Any) -> dict:
    return {'source': source, 'kind': kind, 'send': send, 'notify': notify, 'close': close,
            'timeoutSeconds': timeout_seconds, 'onElicit': on_elicit, 'tools': {}, 'era': None,
            'version': None, 'serverInfo': None, 'capabilities': {}, 'instructions': None,
            'nextId': 0}


def _stdio_client(command: List[str], timeout_seconds: float, on_elicit: Any, stderr: str) -> dict:
    name, args = command[0], command[1:]
    executable = find_executable(name)
    if not executable:
        raise McpClientError('connection',
                             f'cannot start the MCP server: no program named {jsonify(name)}\n'
                             '  give its full path, or put it on PATH')
    source = ' '.join(command)
    state: Dict[str, Any] = {'dead': None, 'client': None, 'closed': False, 'process': None}

    async def start() -> Any:
        import sys
        err = None if stderr == 'inherit' else asyncio.subprocess.DEVNULL
        state['process'] = await asyncio.create_subprocess_exec(
            executable, *args, stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE, stderr=err)
        asyncio.ensure_future(_read_stdout(state))
        return state['process']

    state['start'] = start

    async def _read_stdout(st: dict) -> None:
        process = st['process']
        buffer = ''
        while True:
            chunk = await process.stdout.read(4096)
            if not chunk:
                _fail_all(st, 'the server closed its stdout (it exited?)')
                return
            buffer += chunk.decode('utf8')
            lines = buffer.split('\n')
            buffer = lines.pop()
            for line in lines:
                try:
                    msg = json.loads(line)
                except Exception:
                    continue  # a misbehaving server's log line
                if not is_object(msg):
                    continue
                if own(msg, 'id') and isinstance(msg.get('method'), str):
                    asyncio.ensure_future(_answer_server_request(st, msg))
                    continue
                if own(msg, 'id'):
                    settle = st['pending'].pop(msg['id'], None)
                    if settle:
                        settle(msg)

    def _fail_all(st: dict, why: str) -> None:
        st['dead'] = why
        for settle in list(st['pending'].values()):
            settle(None)
        st['pending'].clear()

    def _write(st: dict, msg: Any) -> None:
        process = st['process']
        if process is None or process.stdin is None:
            raise McpClientError('connection', 'the server is gone')
        process.stdin.write(f'{jsonify(msg)}\n'.encode('utf8'))

    async def _answer_server_request(st: dict, msg: dict) -> None:
        def reply(r: Any) -> None:
            try:
                _write(st, {'jsonrpc': '2.0', 'id': msg['id'], 'result': r})
            except Exception:  # the server is gone
                pass

        if msg.get('method') == 'ping':
            reply({})
            return
        if msg.get('method') == 'elicitation/create' and st['client'] and st['client'].get('onElicit'):
            reply(await _answer_elicitation(st['client'],
                                            msg.get('params') if is_object(msg.get('params')) else {}))
            return
        try:
            _write(st, jsonrpc_error(msg['id'], MCP_ERROR_CODES['method-not-found'],
                                     f"Method not found: {msg.get('method')}"))
        except Exception:  # gone
            pass

    async def send(msg: dict, version: Optional[str], seconds: float,
                   *, cancel: bool = True, headers: Optional[List[str]] = None) -> Any:
        if state['process'] is None:
            await start()
        if state['dead']:
            raise McpClientError('connection', f"{source}: {state['dead']}")
        loop = asyncio.get_running_loop()
        future: asyncio.Future = loop.create_future()

        def settle(reply: Any) -> None:
            if future.done():
                return
            if reply is not None:
                future.set_result({'status': 200, 'reply': reply, 'headers': {}})
            else:
                future.set_exception(McpClientError('connection',
                                                    f"{source}: {state['dead'] or 'no reply'}"))

        def expire() -> None:
            state['pending'].pop(msg['id'], None)
            if future.done():
                return
            future.set_exception(McpClientError(
                'timeout', f'{source} took longer than {seconds} seconds to answer {msg.get("method")}'))
            if cancel:
                try:
                    _write(state, {'jsonrpc': '2.0', 'method': 'notifications/cancelled',
                                   'params': {'requestId': msg['id'],
                                              'reason': f'no answer in {seconds} seconds'}})
                except Exception:
                    pass

        loop.call_later(seconds, expire)
        state['pending'][msg['id']] = settle
        try:
            _write(state, msg)
        except Exception as error:
            state['pending'].pop(msg['id'], None)
            if not future.done():
                future.set_exception(McpClientError('connection',
                                                    f'{source}: cannot write to the server: {error}'))
        return await future

    async def notify(msg: dict, version: Optional[str] = None) -> None:
        try:
            if state['process'] is None:
                await start()
            _write(state, msg)
        except Exception:  # a notification is best effort
            pass

    async def close(force: bool = False) -> None:
        if state['closed']:
            return
        state['closed'] = True
        process = state['process']
        if process is None:
            return
        try:
            if process.stdin:
                process.stdin.close()
        except Exception:  # already gone
            pass
        if force:
            process.kill()
        try:
            await asyncio.wait_for(process.wait(), 2)
        except asyncio.TimeoutError:
            process.terminate()
            try:
                await asyncio.wait_for(process.wait(), 1)
            except asyncio.TimeoutError:
                process.kill()
                await process.wait()
        _fail_all(state, 'the connection was closed')

    client = _base_client(source, 'stdio', send, notify, close, timeout_seconds, on_elicit)
    state['pending'] = {}
    state['client'] = client
    return client


def _http_client(url: str, extra_headers: List[str], timeout_seconds: float, on_elicit: Any) -> dict:
    state: Dict[str, Any] = {'session': None}

    def headers_for(msg: dict, version: Optional[str], extra: Optional[List[str]] = None) -> List[str]:
        extra = extra or []
        params = msg.get('params') if is_object(msg.get('params')) else {}
        named = None
        if msg.get('method') in ('tools/call', 'prompts/get', 'resources/read'):
            key = 'uri' if msg['method'] == 'resources/read' else 'name'
            named = params.get(key)
        out = ['Content-Type: application/json', 'Accept: application/json, text/event-stream']
        if version:
            out.append(f'MCP-Protocol-Version: {version}')
        if version in MODERN_VERSIONS:
            out.append(f'Mcp-Method: {msg.get("method")}')
            if isinstance(named, str):
                out.append(f'Mcp-Name: {encode_header_value(named)}')
        if state['session']:
            out.append(f"Mcp-Session-Id: {state['session']}")
        return out + extra + extra_headers

    async def post(msg: dict, version: Optional[str], seconds: float,
                   extra: Optional[List[str]] = None) -> Any:
        import urllib.error
        import urllib.request
        lines = headers_for(msg, version, extra)
        headers = {}
        for line in lines:
            at = line.index(':')
            headers[line[:at].strip()] = line[at + 1:].strip()
        body = jsonify(msg).encode('utf8')
        request = urllib.request.Request(url, data=body, method='POST', headers=headers)

        def run() -> Any:
            try:
                return urllib.request.urlopen(request, timeout=seconds)
            except urllib.error.HTTPError as error:
                return error
            except urllib.error.URLError as error:
                reason = getattr(error, 'reason', error)
                if isinstance(reason, (TimeoutError, __import__('socket').timeout)):
                    raise TimeoutError(str(reason))
                raise OSError(str(reason))

        try:
            response = await asyncio.to_thread(run)
        except TimeoutError:
            raise McpClientError('timeout',
                                 f'{url} took longer than {seconds} seconds to answer {msg.get("method")}')
        except Exception as error:
            raise McpClientError('connection', f'{url}: {error}')
        try:
            session_id = response.headers.get('mcp-session-id')
            if session_id and msg.get('method') == 'initialize':
                state['session'] = session_id
            text = response.read().decode('utf8').strip()
            content_type = response.headers.get('content-type') or ''
            reply = (_sse_reply(text, msg['id']) if 'text/event-stream' in content_type
                     else _json_or_none(text))
            return {'status': response.status, 'reply': reply, 'headers': response.headers}
        finally:
            response.close()

    return _base_client(
        url, 'http', timeout_seconds=timeout_seconds, on_elicit=on_elicit,
        send=lambda msg, version, seconds, headers=None, cancel=True:
            post(msg, version, seconds, headers or []),
        notify=_http_notify(post, timeout_seconds),
        close=_noop_close)


async def _noop_close(force: bool = False) -> None:
    pass


def _http_notify(post: Any, timeout_seconds: float) -> Any:
    async def notify(msg: dict, version: Optional[str] = None) -> None:
        try:  # best effort
            await post(msg, version, timeout_seconds, [])
        except Exception:
            pass
    return notify


def _json_or_none(text: str) -> Any:
    try:
        return json.loads(text)
    except Exception:
        return None


def _sse_reply(body: str, id: Any) -> Any:
    """The response with this id among an SSE body's events."""
    for event in re.split(r'\r?\n\r?\n', body):
        data = '\n'.join(re.sub(r'^data: ?', '', line)
                         for line in re.split(r'\r?\n', event) if line.startswith('data:'))
        msg = _json_or_none(data)
        if is_object(msg) and msg.get('id') == id and not own(msg, 'method'):
            return msg
    return None


def mcp_tool_handler(c: dict, tool: Any, *, timeout_seconds: Optional[float] = None) -> Callable[..., Awaitable[Any]]:
    """A (state, decision) handler that calls `tool` with the decision's data as
    its arguments. A result with isError raises, and so does an input-required
    result: a dispatcher cannot answer a person's questions."""
    if timeout_seconds is None:
        timeout_seconds = c['timeoutSeconds']
    name = str(tool)

    async def handler(state: Any, decision: dict) -> Any:
        args = decision.get('data') if is_object(decision.get('data')) else {}
        result = await mcp_call_tool(c, name, args, timeout_seconds=timeout_seconds)
        if input_required(result):
            raise McpClientError('connection',
                                 f"the MCP tool '{name}' asked for more input, which a dispatcher "
                                 'cannot give\n  ask the person first: make the action confirmed and '
                                 'pass a confirm handler')
        if result.get('isError') is True:
            text = mcp_result_text(result)
            raise McpClientError('connection',
                                 f"the MCP tool '{name}' failed: {text if text else '(no message)'}")
        return result['structuredContent'] if own(result, 'structuredContent') else result.get('content', [])

    handler.handlerName = name
    return handler


async def mcp_handlers(c: dict, *, only: Optional[List[str]] = None, policy: Any = None,
                       timeout_seconds: Optional[float] = None) -> Dict[str, Any]:
    """tool name -> handler, for: only these names (each must exist on the
    server), else the policy's declared actions the server has, else every tool
    it lists."""
    if timeout_seconds is None:
        timeout_seconds = c['timeoutSeconds']
    have = [t['name'] for t in await mcp_list_tools(c) if isinstance(t.get('name'), str)]
    if only:
        want = [str(n) for n in only]
        missing = [n for n in want if n not in have]
        if missing:
            raise McpClientError('connection',
                                 f"{c['source']} has no tool{'' if len(missing) == 1 else 's'} "
                                 f"named {', '.join(missing)}\n  its tools: {', '.join(have)}")
        names = want
    elif policy:
        names = [n for n in (policy.policy.get('actions') or {}).keys() if n in have]
    else:
        names = have
    return {n: mcp_tool_handler(c, n, timeout_seconds=timeout_seconds) for n in names}
