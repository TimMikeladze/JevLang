"""Handlers declared in a file, ported from src/handlers.mjs.

::

    {"handlers": {
      "set-light":   {"type": "mqtt", "broker": "localhost:1883", "topic": "home/{room}/light"},
      "unlock-door": {"type": "shell", "argv": ["/usr/local/bin/door", "unlock", "{door}"], "timeout": 5},
      "chat-model":  {"type": "http", "url": "http://localhost:8080/chat"},
      "ask-user":    {"type": "log"},
      "confirm":     {"type": "http", "url": "http://localhost:8080/approve"}}}

``load_handlers`` returns the map a dispatcher takes. Other top-level keys are
left alone, for other tools that share the file.

``{name}`` in a string is replaced by that parameter of the act decision (or
action, target, reason, key for any decision). A shell argument that is
exactly ``{name}`` becomes one argument, whatever the value holds, and a list
becomes several; nothing is ever passed through a shell, and the executable
itself cannot be a placeholder.

A "confirm" entry approves when its result is true, or an object with
"approved": true. Anything else declines.
"""
from __future__ import annotations

import asyncio
import json
import os
import random
import re
import signal
import socket
import sys
import urllib.error
import urllib.request
from typing import Any, Awaitable, Callable, Optional

from ._common import finite, is_object, own, require_at
from ._numberfmt import jsonify, js_number_str
from ._provider import find_executable

Handler = Callable[[Any, Any, dict], Awaitable[Any]]
Context = dict

_types: dict = {}
_PLACEHOLDER = r'{([a-zA-Z0-9_?!-]+)}'


def register_handler_type(type: str, make: Callable[[dict, str], Handler]) -> None:
    require_at(isinstance(type, str) and callable(make), 'registerHandlerType',
               'a type name and a function of (spec, baseDir)')
    _types[type] = make


def _spec_error(target: Any, message: str, fix: Optional[str] = None) -> None:
    require_at(False, f'handlers.{target}', message, fix, 'handler')


def handler_from_spec(target: Any, spec: Any, base_dir: Optional[str] = None) -> Any:
    base = base_dir if base_dir is not None else os.getcwd()
    if not is_object(spec):
        _spec_error(target, 'expected an object with a "type"')
    make = _types.get(spec.get('type'))
    if not make:
        _spec_error(target, f'unknown type {jsonify(spec.get("type"))}',
                    f"Types: {', '.join(sorted(_types))}.")
    return make({**spec, 'target': str(target)}, base)


def load_handlers(src: Any, base_dir: Optional[str] = None) -> dict:
    """src: a file path, or the parsed file."""
    if is_object(src):
        parsed, base = src, (base_dir if base_dir is not None else os.getcwd())
    else:
        path = os.path.abspath(src)
        with open(path, 'r', encoding='utf-8') as handle:
            parsed = json.load(handle)
        base = os.path.dirname(path)
    specs = parsed.get('handlers') if is_object(parsed) else None
    require_at(is_object(specs), 'handlers', 'expected {"handlers": {"target": {"type": ...}, ...}}',
               None, 'handler')
    table: dict = {}
    for target, spec in specs.items():
        handler = handler_from_spec(target, spec, base)
        table[target] = confirm_handler(handler) if target == 'confirm' else handler
    return table


def confirm_handler(h: Handler) -> Handler:
    """Only true, or {"approved": true}, approves."""
    async def handler(state: Any, decision: Any, context: Context) -> bool:
        r = await h(state, decision, context)
        return r is True or (is_object(r) and r.get('approved') is True)
    handler.handler_name = 'confirm'  # type: ignore[attr-defined]
    handler.handlerName = 'confirm'  # type: ignore[attr-defined]
    return handler


def _context_key(context: Any) -> Any:
    return context.get('key') if is_object(context) else None


def decision_vars(decision: Any, context: Any) -> dict:
    def nn(value: Any) -> Any:
        return '' if value is None else value
    vars: dict = {
        'action': decision.get('action') if is_object(decision) else None,
        'target': nn(decision.get('target') if is_object(decision) else None),
        'reason': nn(decision.get('reason') if is_object(decision) else None),
        'key': nn(_context_key(context)),
    }
    data = decision.get('data') if is_object(decision) else None
    if is_object(data):
        vars.update(data)
    return vars


def value_string(v: Any) -> str:
    if isinstance(v, str):
        return v
    if isinstance(v, bool):
        return 'true' if v else 'false'
    if isinstance(v, (int, float)):
        return js_number_str(v)
    return jsonify(v)


def fill_template(text: str, vars: dict, who: str) -> str:
    """``home/{room}/light`` -> ``home/kitchen/light``. An unknown name is an error."""
    def replace(match: 're.Match[str]') -> str:
        name = match.group(1)
        require_at(own(vars, name), who, f'{{{name}}} is not a parameter of this decision',
                   f"It has: {', '.join(sorted(vars))}.", 'handler')
        return value_string(vars[name])
    return re.sub(_PLACEHOLDER, replace, text)


def _spec_number(spec: dict, key: str, fallback: Any, target: str) -> Any:
    v = spec[key] if key in spec else fallback
    if v is not None and v is not False and not (finite(v) and v > 0):
        _spec_error(target, f'"{key}" must be a positive number')
    return v


def _tail(text: str, n: int = 2000) -> str:
    return text[-n:] if len(text) > n else text


def _json_safe(v: Any) -> Any:
    if isinstance(v, list):
        return [_json_safe(x) for x in v]
    if is_object(v):
        return {k: _json_safe(x) for k, x in v.items()}
    return v


def _to_str(v: Any) -> str:
    if isinstance(v, str):
        return v
    if isinstance(v, bool):
        return 'true' if v else 'false'
    if isinstance(v, (int, float)):
        return js_number_str(v)
    return jsonify(v)


# shell: run a declared argv, with no shell in between.
def _shell_type(spec: dict, base: str) -> Handler:
    target = spec.get('target')
    argv = spec.get('argv')
    if not isinstance(argv, list) or not argv or not all(isinstance(x, str) for x in argv):
        _spec_error(target, '"argv" must be a non-empty list of strings')
    if '{' in argv[0]:
        _spec_error(target, 'the executable (argv[0]) cannot be a placeholder; only arguments can')
    if os.path.isabs(argv[0]):
        executable = argv[0]
    elif '/' in argv[0]:
        executable = os.path.normpath(os.path.join(base, argv[0]))
    else:
        executable = find_executable(argv[0])
        if executable is None:
            _spec_error(target, f'no executable {argv[0]} on PATH')
    timeout_seconds = _spec_number(spec, 'timeout', 30, target)
    cwd = os.path.normpath(os.path.join(base, spec['cwd'])) if spec.get('cwd') else base

    async def handler(state: Any, decision: Any, context: Context) -> dict:
        vars = decision_vars(decision, context)
        args: list = []
        for a in argv[1:]:
            whole = re.fullmatch(_PLACEHOLDER, a)
            if whole and own(vars, whole.group(1)):
                v = vars[whole.group(1)]
                if isinstance(v, list):
                    args.extend(_to_str(x) for x in v)
                else:
                    args.append(_to_str(v))
            else:
                args.append(fill_template(a, vars, f'handlers.{target}'))
        proc = await asyncio.create_subprocess_exec(
            executable, *args, cwd=cwd, start_new_session=True,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        try:
            out, err = await asyncio.wait_for(proc.communicate(), timeout_seconds)
        except asyncio.TimeoutError:
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            except (OSError, PermissionError):
                proc.kill()
            await proc.wait()
            raise RuntimeError(f"handler '{target}': {executable} ran longer than "
                               f"{_to_str(timeout_seconds)} seconds and was killed") from None
        code = proc.returncode
        if code != 0:
            raise RuntimeError(f"handler '{target}': {executable} exited with {code}\n"
                               f"  {_tail(err.decode('utf-8', 'replace')).strip()}")
        return {'exit': code, 'stdout': _tail(out.decode('utf-8', 'replace'))}
    return handler


register_handler_type('shell', _shell_type)


# http: an unsigned JSON POST (use "webhook" for signed delivery).
def _http_type(spec: dict, base: str) -> Handler:
    target = spec.get('target')
    if not isinstance(spec.get('url'), str):
        _spec_error(target, '"url" is required')
    timeout_seconds = _spec_number(spec, 'timeout', 10, target)
    include_state = spec.get('include_state') is True

    async def handler(state: Any, decision: Any, context: Context) -> Any:
        vars = decision_vars(decision, context)
        url = fill_template(spec['url'], vars, f'handlers.{target}')
        body: dict = {'decision': decision, 'key': _context_key(context)}
        if include_state:
            body['state'] = _json_safe(state)
        headers = {'Content-Type': 'application/json'}
        key = _context_key(context)
        if key:
            headers['Idempotency-Key'] = str(key)
        request = urllib.request.Request(url, data=jsonify(body).encode('utf-8'), method='POST',
                                         headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=timeout_seconds or None) as raw:
                status, text = raw.status, raw.read().decode('utf-8', 'replace')
        except urllib.error.HTTPError as error:
            status, text = error.code, error.read().decode('utf-8', 'replace')
        except (socket.timeout, TimeoutError):
            raise RuntimeError(f"handler '{target}': {url} gave no answer within "
                               f"{_to_str(timeout_seconds)} seconds") from None
        except urllib.error.URLError as error:
            detail = str(error.reason) if error.reason is not None else str(error)
            raise RuntimeError(f"handler '{target}': {url} could not be reached: {detail}") from None
        if status < 200 or status > 299:
            raise RuntimeError(f"handler '{target}': {url} answered {status}\n  {text[:500]}")
        try:
            return json.loads(text)
        except ValueError:
            return text
    return handler


register_handler_type('http', _http_type)


# log: one JSON line per decision, to stdout or a file.
def _log_type(spec: dict, base: str) -> Handler:
    path = os.path.normpath(os.path.join(base, spec['path'])) if spec.get('path') else None
    lock: list = []  # created inside the loop: 3.9 binds a Lock at construction

    async def handler(state: Any, decision: Any, context: Context) -> str:
        line = jsonify({'decision': decision, 'key': _context_key(context)})
        if not lock:
            lock.append(asyncio.Lock())
        # One line at a time, so concurrent handlers do not interleave.
        async with lock[0]:
            if path:
                with open(path, 'a', encoding='utf-8') as handle:
                    handle.write(line + '\n')
            else:
                sys.stdout.write(line + '\n')
                sys.stdout.flush()
        return 'logged'
    return handler


register_handler_type('log', _log_type)


# mqtt: a minimal MQTT 3.1.1 publisher (CONNECT, PUBLISH QoS 0/1, DISCONNECT).
def _varint(n: int) -> bytes:
    out = bytearray()
    rest = n
    while True:
        b = rest & 127
        rest >>= 7
        out.append(b | 128 if rest else b)
        if not rest:
            return bytes(out)


def _mqtt_string(s: str) -> bytes:
    b = s.encode('utf-8')
    return bytes([len(b) >> 8, len(b) & 255]) + b


def _packet(type_flags: int, body: bytes) -> bytes:
    return bytes([type_flags]) + _varint(len(body)) + body


async def mqtt_publish(host: str, port: int, topic: str, payload: Any,
                       qos: int = 0, retain: bool = False, client_id: Optional[str] = None,
                       username: Optional[str] = None, password: Optional[str] = None,
                       tls: bool = False, timeout_seconds: float = 10) -> None:
    who = f'mqtt {host}:{port}'

    async def run() -> None:
        reader, writer = await asyncio.open_connection(host, port, ssl=True if tls else None)
        buffer = bytearray()
        stage = 'connack'
        try:
            flags = 0x02 | (0x80 if username else 0) | (0x40 if password else 0)
            writer.write(_packet(0x10, _mqtt_string('MQTT') + bytes([4, flags, 0, 60]) +
                                 _mqtt_string(client_id if client_id is not None
                                              else f'jev-{int(random.random() * 1e8)}') +
                                 (_mqtt_string(username) if username else b'') +
                                 (_mqtt_string(password) if password else b'')))
            await writer.drain()

            def publish() -> None:
                nonlocal stage
                writer.write(_packet(0x30 | (qos << 1) | (1 if retain else 0),
                                     _mqtt_string(topic) +
                                     (bytes([0, 1]) if qos == 1 else b'') +
                                     (payload if isinstance(payload, bytes)
                                      else _to_str(payload).encode('utf-8'))))
                if qos == 1:
                    stage = 'puback'
                    return
                stage = 'done'
                writer.write(bytes([0xE0, 0]))

            while stage != 'done':
                chunk = await reader.read(4096)
                if not chunk:
                    raise RuntimeError(f'{who}: the broker closed the connection')
                buffer.extend(chunk)
                # Every packet here has a one-byte remaining length.
                while len(buffer) >= 2 and len(buffer) >= 2 + buffer[1]:
                    header = buffer[0]
                    body = bytes(buffer[2:2 + buffer[1]])
                    del buffer[:2 + buffer[1]]
                    if stage == 'connack':
                        if header != 0x20 or len(body) != 2:
                            raise RuntimeError(f'{who}: expected CONNACK')
                        if body[1] != 0:
                            why = ', bad user name or password' if body[1] == 4 else \
                                ', not authorized' if body[1] == 5 else ''
                            raise RuntimeError(f'{who}: the broker refused the connection '
                                               f'(code {body[1]}{why})')
                        publish()
                    elif stage == 'puback':
                        if header != 0x40:
                            raise RuntimeError(f'{who}: expected PUBACK for the message')
                        writer.write(bytes([0xE0, 0]))
                        await writer.drain()
                        return
            await writer.drain()
        finally:
            writer.close()
            try:
                await writer.wait_closed()
            except (OSError, RuntimeError):
                pass
    await asyncio.wait_for(run(), timeout_seconds)


def _mqtt_type(spec: dict, base: str) -> Handler:
    target = spec.get('target')
    broker = spec.get('broker')
    if broker is None:
        broker = 'localhost:1883'
    parts = re.match(r'^([^:]+)(?::([0-9]+))?$', broker) if isinstance(broker, str) else None
    if not parts:
        _spec_error(target, '"broker" must be host or host:port')
    tls = spec.get('tls') is True
    host = parts.group(1)
    port = int(parts.group(2)) if parts.group(2) else (8883 if tls else 1883)
    if not isinstance(spec.get('topic'), str):
        _spec_error(target, '"topic" is required')
    qos = spec.get('qos')
    if qos is None:
        qos = 0
    if isinstance(qos, bool) or qos not in (0, 1):
        _spec_error(target, '"qos" must be 0 or 1')
    payload = spec.get('payload')
    if payload is None:
        payload = 'params'
    timeout_seconds = _spec_number(spec, 'timeout', 10, target)

    async def handler(state: Any, decision: Any, context: Context) -> dict:
        vars = decision_vars(decision, context)
        topic = fill_template(spec['topic'], vars, f'handlers.{target}')
        data = decision.get('data') if is_object(decision) else None
        if payload == 'params':
            body = jsonify(_json_safe(data if is_object(data) else {}))
        elif payload == 'decision':
            body = jsonify(decision)
        else:
            body = fill_template(payload, vars, f'handlers.{target}')
        password_env = spec.get('password_env')
        await mqtt_publish(host, port, topic, body,
                           qos=qos, retain=spec.get('retain') is True,
                           client_id=spec.get('client_id') if spec.get('client_id') is not None else None,
                           username=spec.get('username') if spec.get('username') is not None else None,
                           password=(os.environ.get(password_env) if password_env else None) or None,
                           tls=tls, timeout_seconds=timeout_seconds)
        return {'published': topic}
    return handler


register_handler_type('mqtt', _mqtt_type)


# webhook: signed delivery, which comes with the integrations work.
def _webhook_type(spec: dict, base: str) -> Handler:
    from ._webhooks import webhook_handler_from_spec
    return webhook_handler_from_spec(spec)


register_handler_type('webhook', _webhook_type)
