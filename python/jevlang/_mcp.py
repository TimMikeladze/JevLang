"""MCP, the server side: a policy (or any set of tools) as an MCP server.

The portable mirror of src/mcp.mjs. MCP 2026-07-28 is stateless; most clients
in the field still speak the legacy initialize versions, so this server is
dual-era. The core is handle_message: one parsed JSON-RPC message in, the
reply (or None) out, with no I/O. serve_stdio and http_handle are thin
wrappers around it."""
from __future__ import annotations

import asyncio
import base64
import json
import os
import re
from typing import Any, Awaitable, Callable, Dict, List, Optional
from urllib.parse import urlsplit

from ._assets import inspect_image
from ._surface_options import surface_options, invoke_evaluate, ASSET_INPUT_SCHEMA
from ._common import is_object, own, require_at
from ._dispatch import policy_targets_of
from ._explain import explain_decision
from ._numberfmt import jsonify
from ._schema import policy_actions

MODERN_VERSION = '2026-07-28'
MODERN_VERSIONS = [MODERN_VERSION]
# Newest first; initialize falls back to the first.
LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26']
SUPPORTED_VERSIONS = MODERN_VERSIONS + LEGACY_VERSIONS

META_PROTOCOL_VERSION = 'io.modelcontextprotocol/protocolVersion'
META_CLIENT_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities'
META_CLIENT_INFO = 'io.modelcontextprotocol/clientInfo'
META_SERVER_INFO = 'io.modelcontextprotocol/serverInfo'

MCP_ERROR_CODES = {
    'parse-error': -32700, 'invalid-request': -32600, 'method-not-found': -32601,
    'invalid-params': -32602, 'internal-error': -32603,
    'header-mismatch': -32020, 'missing-capability': -32021, 'unsupported-version': -32022,
    # Resource not found before 2026-07-28; legacy clients still get it.
    'legacy-resource-not-found': -32002,
}


def _code_of(code: Any) -> int:
    return code if isinstance(code, int) and not isinstance(code, bool) else MCP_ERROR_CODES[code]


class McpError(Exception):
    def __init__(self, code: Any, message: str, data: Any = None):
        super().__init__(message)
        self.name = 'McpError'
        self.code = _code_of(code)
        self.data = data


def raise_mcp(code: Any, message: str, data: Any = None):
    raise McpError(code, message, data)


def jsonrpc_error(id: Any, code: int, message: str, data: Any = None) -> dict:
    error: Dict[str, Any] = {'code': code, 'message': message}
    if data is not None:
        error['data'] = data
    out: Dict[str, Any] = {'jsonrpc': '2.0'}
    if id is not None:
        out['id'] = id
    out['error'] = error
    return out


def mcp_tool(*, name: str, title: Optional[str] = None, description: Optional[str] = None,
             input_schema: Any, annotations: Any = None, meta: Any = None,
             run: Callable[..., Any]) -> dict:
    return {'name': name, 'title': title, 'description': description, 'inputSchema': input_schema,
            'annotations': annotations, 'meta': meta, 'run': run}


def mcp_resource(*, uri: str, name: str, description: Optional[str] = None,
                 mimeType: Optional[str] = None, read: Callable[..., Any]) -> dict:
    return {'uri': uri, 'name': name, 'description': description, 'mimeType': mimeType, 'read': read}


def make_mcp_server(name: str = None, *, version: str = '0', title: Optional[str] = None,
                    instructions: Optional[str] = None, tools: Optional[List[dict]] = None,
                    resources: Optional[List[dict]] = None, methods: Optional[Dict[str, Any]] = None,
                    fallback: Any = None, capabilities: Any = None, ttl_ms: int = 300_000,
                    cache_scope: str = 'private') -> dict:
    tools = tools or []
    resources = resources or []
    methods = methods or {}
    require_at(isinstance(name, str), 'name', 'an MCP server needs a name')
    names = [t['name'] for t in tools]
    require_at(len(set(names)) == len(names), 'tools', 'tool names must be unique')
    require_at(cache_scope in ('public', 'private'), 'cacheScope', 'cacheScope is "public" or "private"')
    info: Dict[str, Any] = {'name': name, 'version': version}
    if title:
        info['title'] = title
    if capabilities is None:
        capabilities = {}
        if tools or own(methods, 'tools/list'):
            capabilities['tools'] = {}
        if resources or own(methods, 'resources/list'):
            capabilities['resources'] = {}
    return {'info': info, 'instructions': instructions, 'tools': tools, 'resources': resources,
            'methods': methods, 'fallback': fallback, 'ttlMs': ttl_ms, 'cacheScope': cache_scope,
            'capabilities': capabilities}


def tool_to_json(t: dict) -> dict:
    out: Dict[str, Any] = {'name': t['name'], 'inputSchema': t['inputSchema']}
    if t.get('title'):
        out['title'] = t['title']
    if t.get('description'):
        out['description'] = t['description']
    if t.get('annotations'):
        out['annotations'] = t['annotations']
    if t.get('meta'):
        out['_meta'] = t['meta']
    return out


def mcp_text_result(text: str, *, structured: Any = None, error: Any = False) -> dict:
    out: Dict[str, Any] = {'content': [{'type': 'text', 'text': text}], 'isError': bool(error)}
    if structured is not None:
        out['structuredContent'] = structured
    return out


def mcp_tool_error(text: str) -> dict:
    return mcp_text_result(text, error=True)


def mcp_input_required(requests: Any, *, state: Any = None) -> dict:
    out: Dict[str, Any] = {'resultType': 'input_required', 'inputRequests': requests}
    if state:
        out['requestState'] = state
    return out


def input_required(r: Any) -> bool:
    return is_object(r) and r.get('resultType') == 'input_required'


def make_mcp_conn(*, send_request: Any = None, legacy_version: Optional[str] = None) -> dict:
    return {'era': 'legacy' if legacy_version else None, 'version': legacy_version,
            'capabilities': {}, 'clientInfo': None, 'sendRequest': send_request}


_CACHEABLE_METHODS = ['tools/list', 'resources/list', 'resources/read', 'resources/templates/list',
                      'prompts/list', 'server/discover']


def _valid_id(id: Any) -> bool:
    return isinstance(id, str) or (isinstance(id, int) and not isinstance(id, bool))


async def handle_message(server: dict, msg: Any, conn: dict) -> Optional[dict]:
    """msg: a parsed JSON-RPC message; conn: the connection it came in on.

    -> the reply to send, or None (a notification, or a response to one of ours)."""
    if not is_object(msg):
        return jsonrpc_error(None, MCP_ERROR_CODES['invalid-request'],
                             'Invalid request: expected a JSON-RPC object')
    has_id = own(msg, 'id')
    id = msg.get('id') if msg.get('id') is not None else None
    method = msg.get('method')
    # A response to a request we sent; the transport routes those.
    if method is None and has_id and (own(msg, 'result') or own(msg, 'error')):
        return None
    if not isinstance(method, str):
        return jsonrpc_error(id if _valid_id(id) else None, MCP_ERROR_CODES['invalid-request'],
                             "Invalid request: `method' must be a string")
    if not has_id:
        return None  # notifications need no reply
    if not _valid_id(id):
        return jsonrpc_error(None, MCP_ERROR_CODES['invalid-request'],
                             'Invalid request: the id must be a string or an integer')
    try:
        params = msg.get('params') if msg.get('params') is not None else {}
        if not is_object(params):
            raise_mcp('invalid-params', "`params' must be an object")
        if method == 'initialize':
            result = _handle_initialize(server, params, conn)
        else:
            call = _request_call(params, conn)
            result = _finish(server, method, call, await _run_method(server, method, params, call))
        return {'jsonrpc': '2.0', 'id': id, 'result': result}
    except McpError as error:
        return jsonrpc_error(id, error.code, str(error), error.data)
    except Exception as error:  # a broken handler is an internal error, not a crash
        return jsonrpc_error(id, MCP_ERROR_CODES['internal-error'], f'Internal error: {error}')


def _request_call(params: dict, conn: dict) -> dict:
    meta = params.get('_meta')
    version = meta.get(META_PROTOCOL_VERSION) if is_object(meta) else None
    if version is not None and not isinstance(version, str):
        raise_mcp('invalid-params', f'_meta.{META_PROTOCOL_VERSION} must be a string')
    if version in MODERN_VERSIONS:
        capabilities = meta.get(META_CLIENT_CAPABILITIES) if is_object(meta) else None
        if not is_object(capabilities):
            raise_mcp('invalid-params', f'missing _meta.{META_CLIENT_CAPABILITIES}\n'
                                        f'  every {MODERN_VERSION} request carries the client\'s '
                                        'capabilities ({} for none)')
        info = meta.get(META_CLIENT_INFO) if is_object(meta) else None
        return {'era': 'modern', 'version': version, 'capabilities': capabilities,
                'clientInfo': info if is_object(info) else None, 'elicit': None,
                'inputResponses': params.get('inputResponses') if is_object(params.get('inputResponses')) else None,
                'requestState': params.get('requestState') if isinstance(params.get('requestState'), str) else None,
                'params': params}
    if version and conn.get('era') == 'legacy' and version in LEGACY_VERSIONS:
        return _legacy_call(params, conn)
    if version:
        raise_mcp('unsupported-version',
                  f'Unsupported protocol version: {version}'
                  + (' (a legacy version: send initialize first)' if version in LEGACY_VERSIONS else ''),
                  {'supported': SUPPORTED_VERSIONS, 'requested': version})
    if conn.get('era') == 'legacy':
        return _legacy_call(params, conn)
    raise_mcp('invalid-params', f'missing _meta.{META_PROTOCOL_VERSION}\n'
                                f'  a {MODERN_VERSION} request names its version and capabilities in _meta;\n'
                                '  a legacy client sends initialize first')


def _legacy_call(params: dict, conn: dict) -> dict:
    return {'era': 'legacy', 'version': conn.get('version'), 'capabilities': conn.get('capabilities'),
            'clientInfo': conn.get('clientInfo'), 'elicit': _legacy_elicit(conn),
            'inputResponses': params.get('inputResponses') if params.get('inputResponses') is not None else None,
            'requestState': params.get('requestState') if params.get('requestState') is not None else None,
            'params': params}


def _legacy_elicit(conn: dict) -> Optional[Callable[[str, Any], Awaitable[Any]]]:
    """A legacy stdio client that declared elicitation can be asked directly."""
    send_request = conn.get('sendRequest')
    capabilities = conn.get('capabilities') if is_object(conn.get('capabilities')) else None
    if not send_request or not is_object((capabilities or {}).get('elicitation')):
        return None

    async def elicit(message: str, schema: Any) -> Any:
        # `mode` arrived in 2025-11-25; older clients do not know the field.
        base = {'message': message, 'requestedSchema': schema}
        if conn.get('version') == '2025-11-25':
            base = {**base, 'mode': 'form'}
        return await send_request('elicitation/create', base)

    return elicit


def _handle_initialize(server: dict, params: dict, conn: dict) -> dict:
    asked = params.get('protocolVersion')
    # The legacy rule: answer the client's version if we have it, else our newest.
    chosen = asked if asked in LEGACY_VERSIONS else LEGACY_VERSIONS[0]
    conn['era'] = 'legacy'
    conn['version'] = chosen
    conn['capabilities'] = params.get('capabilities') if is_object(params.get('capabilities')) else {}
    conn['clientInfo'] = params.get('clientInfo') if is_object(params.get('clientInfo')) else None
    out: Dict[str, Any] = {'protocolVersion': chosen, 'capabilities': server['capabilities'],
                           'serverInfo': server['info']}
    if server.get('instructions'):
        out['instructions'] = server['instructions']
    return out


def _not_found(method: str):
    raise_mcp('method-not-found', f'Method not found: {method}')


def _check_no_cursor(params: dict) -> None:
    # We never hand out cursors, so any cursor is one we did not issue.
    if params.get('cursor'):
        raise_mcp('invalid-params', 'invalid cursor: this server returns every item on the first page')


async def _run_method(server: dict, method: str, params: dict, call: dict) -> Any:
    override = server['methods'].get(method)
    if override:
        return await _maybe_await(override(params, call))
    if method == 'server/discover':
        out: Dict[str, Any] = {'supportedVersions': SUPPORTED_VERSIONS, 'capabilities': server['capabilities']}
        if server.get('instructions'):
            out['instructions'] = server['instructions']
        return out
    if method == 'ping':
        return {}
    if method == 'tools/list':
        _check_no_cursor(params)
        return {'tools': [tool_to_json(t) for t in server['tools']]}
    if method == 'tools/call':
        return await _call_tool(server, params, call)
    if method == 'resources/list':
        _check_no_cursor(params)
        listed = []
        for r in server['resources']:
            entry: Dict[str, Any] = {'uri': r['uri'], 'name': r['name']}
            if r.get('description'):
                entry['description'] = r['description']
            if r.get('mimeType'):
                entry['mimeType'] = r['mimeType']
            listed.append(entry)
        return {'resources': listed}
    if method == 'resources/templates/list':
        if own(server['capabilities'], 'resources'):
            return {'resourceTemplates': []}
        _not_found(method)
    if method == 'resources/read':
        return await _read_resource(server, params, call)
    if server.get('fallback'):
        return await _maybe_await(server['fallback'](method, params, call))
    _not_found(method)


async def _maybe_await(value: Any) -> Any:
    return await value if _is_awaitable(value) else value


def _is_awaitable(value: Any) -> bool:
    import inspect
    return inspect.isawaitable(value)


async def _call_tool(server: dict, params: dict, call: dict) -> dict:
    name = params.get('name')
    if not isinstance(name, str):
        raise_mcp('invalid-params', "tools/call needs params.name, the tool's name")
    tool = next((t for t in server['tools'] if t['name'] == name), None)
    if not tool:
        raise_mcp('invalid-params', f'Unknown tool: {name}', {'tools': [t['name'] for t in server['tools']]})
    args = params.get('arguments') if params.get('arguments') is not None else {}
    if not is_object(args):
        return mcp_tool_error("`arguments' must be an object")
    try:
        result = await _maybe_await(tool['run'](args, call))
    except McpError:
        raise
    except Exception as error:
        return mcp_tool_error(str(error))
    if not is_object(result):
        raise_mcp('internal-error', f'the handler for tool {name} returned no result object')
    return result


async def _read_resource(server: dict, params: dict, call: dict) -> dict:
    uri = params.get('uri')
    if not isinstance(uri, str):
        raise_mcp('invalid-params', 'resources/read needs params.uri')
    resource = next((r for r in server['resources'] if r['uri'] == uri), None)
    if not resource:
        raise_mcp('legacy-resource-not-found' if call['era'] == 'legacy' else 'invalid-params',
                  f'Resource not found: {uri}', {'uri': uri})
    text = await _maybe_await(resource['read']())
    content: Dict[str, Any] = {'uri': uri, 'text': text}
    if resource.get('mimeType'):
        content['mimeType'] = resource['mimeType']
    return {'contents': [content]}


def _finish(server: dict, method: str, call: dict, r: Any) -> Any:
    # resultType, serverInfo and the cache hints for a modern client; none of the
    # 2026-07-28 fields for a legacy one.
    if not is_object(r):
        raise_mcp('internal-error', f'the {method} handler returned no object')
    if call['era'] == 'legacy':
        if input_required(r):
            raise_mcp('internal-error', f'{method} needs input from the client, and a '
                                        f'{call.get("version")} client can only be asked over stdio '
                                        'with elicitation')
        return {k: v for k, v in r.items() if k not in ('resultType', 'ttlMs', 'cacheScope')}
    typed = r if own(r, 'resultType') else {**r, 'resultType': 'complete'}
    meta = typed.get('_meta') if is_object(typed.get('_meta')) else {}
    with_info = {**typed, '_meta': {**meta, META_SERVER_INFO: server['info']}}
    if method not in _CACHEABLE_METHODS or input_required(r):
        return with_info
    out = dict(with_info)
    if 'ttlMs' not in out:
        out['ttlMs'] = server['ttlMs']
    if 'cacheScope' not in out:
        out['cacheScope'] = server['cacheScope']
    return out


# An Origin header, when present, must be a loopback origin or listed in
# JEV_MCP_ORIGINS. This is the spec's defence against DNS rebinding.
def _normalize_origin(s: str) -> str:
    return s.lower().rstrip('/')


def env_origins(value: Optional[str] = None) -> List[str]:
    if value is None:
        value = os.environ.get('JEV_MCP_ORIGINS')
    return [o for o in (_normalize_origin(s.strip()) for s in (value or '').split(',')) if o]


def origin_allowed(origin: Optional[str], allowed: Optional[List[str]] = None) -> bool:
    if allowed is None:
        allowed = env_origins()
    if not origin:
        return True
    try:
        url = urlsplit(origin)
        if url.scheme in ('http', 'https') and (url.hostname or '') in (
                'localhost', '127.0.0.1', '::1', '[::1]'):
            return True
    except ValueError:  # not a URL: only the allow list can permit it
        pass
    return _normalize_origin(origin) in allowed


_B64_HEADER = re.compile(r'^=\?base64\?(.*)\?=$')
_NON_ASCII = re.compile(r'[^\x20-\x7e]')
_EDGE_SPACE = re.compile(r'^\s|\s$')


def decode_header_value(v: Any) -> Any:
    m = _B64_HEADER.match(v) if isinstance(v, str) else None
    if not m:
        return v
    try:
        return base64.b64decode(m.group(1)).decode('utf8')
    except Exception:
        return None


def encode_header_value(s: str) -> str:
    if _NON_ASCII.search(s) or _EDGE_SPACE.search(s) or _B64_HEADER.match(s):
        return f'=?base64?{base64.b64encode(s.encode("utf8")).decode("ascii")}?='
    return s


async def http_handle(server: dict, headers: Any, body: Any, *, origins: Optional[List[str]] = None) -> dict:
    """-> {status, body, headers}, for a POST /mcp route."""
    if origins is None:
        origins = env_origins()

    def header(name: str) -> Any:
        if isinstance(headers, dict):
            if name in headers:
                return headers[name]
            return headers.get(name.lower())
        for k, v in headers or []:
            if str(k).lower() == name:
                return v
        return None

    def reject(status: int, id: Any, code: int, message: str) -> dict:
        return {'status': status, 'body': jsonrpc_error(id, code, message), 'headers': {}}

    origin = header('origin')
    try:
        msg = json.loads(body if isinstance(body, str) else bytes(body).decode('utf8'))
    except Exception:
        msg = None
    if not origin_allowed(origin, origins):
        return reject(403, None, MCP_ERROR_CODES['invalid-request'],
                      f'Forbidden: origin {origin} is not allowed\n'
                      '  add it to JEV_MCP_ORIGINS (comma-separated) to allow it')
    if msg is None:
        return reject(400, None, MCP_ERROR_CODES['parse-error'],
                      'Parse error: the body must be one JSON-RPC message')
    if not is_object(msg):
        return reject(400, None, MCP_ERROR_CODES['invalid-request'],
                      'Invalid request: send one JSON-RPC object per POST (no batches)')
    if not isinstance(msg.get('method'), str):
        return reject(400, None, MCP_ERROR_CODES['invalid-request'],
                      'Invalid request: this endpoint takes requests and notifications')
    id = msg.get('id') if _valid_id(msg.get('id')) else None
    params = msg.get('params') if is_object(msg.get('params')) else {}
    body_version = params.get('_meta').get(META_PROTOCOL_VERSION) if is_object(params.get('_meta')) else None
    header_version = header('mcp-protocol-version')
    modern = isinstance(body_version, str) or (header_version and header_version in MODERN_VERSIONS)
    notification = not own(msg, 'id')
    if not modern:
        mismatch = None
    elif not header_version:
        mismatch = 'the MCP-Protocol-Version header is missing'
    elif not isinstance(body_version, str):
        mismatch = None
    elif header_version != body_version:
        mismatch = (f'MCP-Protocol-Version header value \'{header_version}\' does not match '
                    f'body value \'{body_version}\'')
    elif notification:
        mismatch = None
    elif header('mcp-method') != msg.get('method'):
        mismatch = (f'Mcp-Method header value \'{header("mcp-method")}\' does not match '
                    f'body value \'{msg.get("method")}\'' if header('mcp-method')
                    else 'the Mcp-Method header is missing')
    else:
        mismatch = None
    if mismatch:
        return reject(400, id, MCP_ERROR_CODES['header-mismatch'], f'Header mismatch: {mismatch}')
    # One HTTP request is one connection, so a legacy client cannot be asked
    # anything: there is no way back.
    legacy = None if modern else (header_version if header_version and header_version in LEGACY_VERSIONS else None)
    conn = make_mcp_conn(legacy_version=legacy)
    reply = await handle_message(server, msg, conn)
    return {'status': 200, 'body': reply, 'headers': {}} if reply else {'status': 202, 'body': None, 'headers': {}}


async def serve_stdio(server: dict, reader: asyncio.StreamReader, writer: asyncio.StreamWriter,
                      *, elicit_timeout_seconds: float = 600) -> None:
    """Serves newline-delimited JSON-RPC until the input ends. Requests are
    answered in order, except a handler waiting on a legacy client's answer:
    the next message is read meanwhile, since it may be that answer."""
    pending: Dict[str, Callable[[Any], None]] = {}
    counter = 0
    suspend_box: List[Optional[asyncio.Future]] = [None]

    def send(msg: Any) -> None:
        writer.write(f'{jsonify(msg)}\n'.encode('utf8'))

    def send_request(method: str, params: Any) -> Awaitable[Any]:
        nonlocal counter
        loop = asyncio.get_running_loop()
        future: asyncio.Future = loop.create_future()
        counter += 1
        new_id = f'jev-{counter}'

        def expire() -> None:
            pending.pop(new_id, None)
            if not future.done():
                future.set_result(None)

        timer = loop.call_later(elicit_timeout_seconds, expire)

        def settle(reply: Any) -> None:
            timer.cancel()
            if future.done():
                return
            result = reply.get('result') if is_object(reply) else None
            future.set_result(result if is_object(result) else None)

        pending[new_id] = settle
        send({'jsonrpc': '2.0', 'id': new_id, 'method': method, 'params': params})
        # The reader may continue: the next message may be this answer.
        waiting = suspend_box[0]
        if waiting is not None and not waiting.done():
            waiting.set_result(None)
        return future

    conn = make_mcp_conn(send_request=send_request)
    running: Optional[asyncio.Task] = None

    async def handle_line(line: str) -> None:
        nonlocal running
        try:
            msg = json.loads(line)
        except Exception:
            send(jsonrpc_error(None, MCP_ERROR_CODES['parse-error'],
                               'Parse error: each line must be one JSON-RPC message'))
            return
        if is_object(msg) and 'method' not in msg and own(msg, 'id'):
            settle = pending.pop(msg['id'], None)
            if settle:
                settle(msg)
            return
        handled = asyncio.ensure_future(handle_message(server, msg, conn))
        suspend_future: asyncio.Future = asyncio.get_running_loop().create_future()
        suspend_box[0] = suspend_future
        running = handled

        def done(_: Any) -> None:
            reply = handled.result()
            if reply is not None:
                send(reply)

        handled.add_done_callback(done)
        # Wait for this handler, unless it suspends on an elicitation.
        await asyncio.wait([handled, suspend_future], return_when=asyncio.FIRST_COMPLETED)
        suspend_box[0] = None

    async def drain(lines: List[str]) -> None:
        for line in lines:
            if line.strip() == '':
                continue
            await handle_line(line)

    buffered: List[str] = []
    while True:
        line = await reader.readline()
        if not line:
            break
        buffered.append(line.decode('utf8').rstrip('\n'))
        await drain(buffered)
        buffered.clear()
    await drain(buffered)
    for settle in pending.values():
        settle(None)
    if running is not None:
        await running


def _compiled(policy: Any) -> Any:
    """A builder Policy or an already-compiled policy: both work."""
    if hasattr(policy, 'identity') and hasattr(policy, 'decide'):
        return policy
    from ._engine import CompiledPolicy
    return CompiledPolicy(policy.to_json() if hasattr(policy, 'to_json') else policy)


def policy_mcp_server(policy: Any, *, allow_evaluate: bool = False, max_calls: int = 100,
                      name: Optional[str] = None, evaluate: Any = None, experimental: Any = None) -> dict:
    """The policy as a server: decide from answers you already have, and, when it
    is allowed, evaluate a case with the model."""
    policy = _compiled(policy)
    spec = policy.policy
    label = name or spec.get('name') or 'policy'
    meta = {'jev/questions_sha256': policy.identity()}
    state = {'calls': 0}

    async def decide_run(args: dict, call: dict) -> dict:
        if not is_object(args.get('answers')):
            return mcp_tool_error('expected {"answers": {...}}, the answers object of a policy provider response')
        try:
            return _decision_result(policy, policy.decide(args['answers']))
        except Exception as error:
            return mcp_tool_error(str(error))

    decide_tool = mcp_tool(
        name='decide', title='Decide from answers',
        description=(f'Run the {label} policy on answers you already have: the `answers\' object '
                     'of a provider response, question id -> answer. No model call, no cost. '
                     'Read the jev://policy resource for the questions.'),
        input_schema={
            'type': 'object',
            'properties': {'answers': {'type': 'object',
                                       'description': 'question id -> answer, as a policy provider returns them'}},
            'required': ['answers'], 'additionalProperties': False,
        },
        annotations={'readOnlyHint': True, 'destructiveHint': False, 'idempotentHint': True,
                     'openWorldHint': False},
        meta=meta, run=decide_run)

    fields = list((spec.get('state') or {}).keys())

    async def evaluate_run(args: dict, call: dict) -> dict:
        if 'state' not in args:
            return mcp_tool_error("expected {\"state\": ...}, the input the policy's evaluate takes")
        if not evaluate:
            return mcp_tool_error('this server was built without an evaluate function')
        if state['calls'] >= max_calls:
            return mcp_tool_error(f'evaluate has run {max_calls} times, this server\'s cap\n'
                                  '  restart it, or raise the cap')
        state['calls'] += 1
        try:
            return _decision_result(policy, await _maybe_await(invoke_evaluate(evaluate, args['state'], surface_options(policy, args, experimental))))
        except Exception as error:
            return mcp_tool_error(str(error))

    evaluate_tool = mcp_tool(
        name='evaluate', title='Evaluate with the model',
        description=(f'Send a case to the model and run the {label} policy on its answers. '
                     f'Each call is billed, and this server allows {max_calls} per process.'),
        input_schema={
            'type': 'object',
            'properties': {'state': {'description': (f'the input the policy reads; it sends these fields: '
                                                     f'{", ".join(fields)}' if fields
                                                     else "the input the policy's evaluate takes")}, 'assets': ASSET_INPUT_SCHEMA, 'experimental': {'type': 'object', 'properties': {'images': {'type': 'boolean'}, 'longContext': {'type': 'boolean'}}, 'additionalProperties': False}},
            'required': ['state'], 'additionalProperties': False,
        },
        annotations={'readOnlyHint': True, 'destructiveHint': False, 'idempotentHint': False,
                     'openWorldHint': True},
        meta=meta, run=evaluate_run)

    def read_policy() -> str:
        return jsonify(policy_to_json(policy))

    def read_actions() -> str:
        return jsonify(policy_actions(policy))

    return make_mcp_server(
        f'jev-{label}',
        version=str(spec['version']) if spec.get('version') else 'unversioned',
        title=f'JevLang policy {label}',
        instructions=(f'This server runs the {label} decision policy. `decide\' takes the answers '
                      'of a System One response and returns the decision, the clause that fired '
                      'and why' + ("; `evaluate' sends a case to the model first (billed)"
                                   if allow_evaluate else '')
                      + '. jev://policy describes the questions, targets and gates; '
                        'jev://policy/actions lists the actions as JSON Schema.'),
        tools=[decide_tool, evaluate_tool] if allow_evaluate else [decide_tool],
        resources=[
            mcp_resource(uri='jev://policy', name='policy',
                         description='The policy: questions, targets, gates, thresholds, state fields',
                         mimeType='application/json', read=read_policy),
            mcp_resource(uri='jev://policy/actions', name='actions',
                         description='Each declared action as JSON Schema, with its safety rules in _meta',
                         mimeType='application/json', read=read_actions),
        ],
        cache_scope='private')


def _decision_result(policy: Any, decision: dict) -> dict:
    """The decision as a tool result: the text a person reads, and the decision
    itself with the policy that made it, as the structured content."""
    text = explain_decision(decision)
    structured = {**decision, 'explain': text,
                  'policy': {'name': policy.policy.get('name'), 'hash': policy.identity(), 'file': None}}
    return mcp_text_result(text, structured=structured)


def policy_to_json(policy_any: Any) -> dict:
    """What the jev://policy resource carries: the policy as JSON, with the same
    keys the Racket server uses. The action entries are the portable
    declarations."""
    policy = _compiled(policy_any)
    spec = policy.policy
    targets = policy_targets_of(spec)
    questions = spec.get('questions') or {}
    return {
        **({'typesafe': {'experimental': spec.get('typesafe', {}).get('experimental', {}), 'assets': {k: {field: info[field] for field in ('format', 'width', 'height', 'sha256')} for k, v in spec.get('typesafe', {}).get('assets', {}).items() for info in [inspect_image(v)]}}} if spec.get('typesafe') else {}),
        'name': spec.get('name'), 'version': spec.get('version'), 'owner': spec.get('owner'),
        'file': None, 'model': spec.get('model'),
        'questions_sha256': policy.identity(),
        'questions': policy.static_questions(),
        'dynamic_questions': any(q.get('optionsFrom') or q.get('over') for q in questions.values()),
        'targets': targets,
        'computed_targets': 'computed' in targets,
        'gates': spec.get('gates') or [],
        'thresholds': spec.get('thresholds') or {},
        'profiles': spec.get('profiles') or {},
        'state_fields': list((spec.get('state') or {}).keys()),
        'redactors': (spec.get('stateOptions') or {}).get('redact') or [],
        'max_chars': (spec.get('stateOptions') or {}).get('maxChars'),
        'actions': [{'name': name, **a} for name, a in (spec.get('actions') or {}).items()],
    }
