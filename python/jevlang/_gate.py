"""The gate: a policy that decides whether an agent's tool call runs.

The portable mirror of src/gate.mjs. Two front ends share one state shape and
one verdict mapping: a Claude Code or Codex PreToolUse hook, and a stdio MCP
server in front of another one. The verdict fails closed; the deny and allow
lists run before the model, so hard rules stay in code. When the policy cannot
decide, the verdict is onError: ask for the hook, deny for the proxy."""
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
import time
from typing import Any, Awaitable, Callable, Dict, List, Optional

from ._common import canonical, finite, is_object, own, require_at
from ._explain import explain_decision
from ._mcp import McpError, input_required, make_mcp_server, mcp_input_required, mcp_tool_error, raise_mcp
from ._mcp_client import mcp_call_tool, mcp_list_tools, mcp_request
from ._numberfmt import jsonify


def _sha256_hex(text: str) -> str:
    return hashlib.sha256(text.encode('utf8')).hexdigest()


def _hmac(key: bytes, text: str) -> bytes:
    return hmac.new(key, text.encode('utf8'), hashlib.sha256).digest()


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode('ascii').rstrip('=')


def _from_b64url(text: str) -> Optional[bytes]:
    try:
        return base64.urlsafe_b64decode(text + '=' * (-len(text) % 4))
    except Exception:
        return None


def _same_bytes(a: bytes, b: bytes) -> bool:
    return hmac.compare_digest(a, b)


def _now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def _first_line(s: Any) -> str:
    return str(s).replace('jev: ', '', 1).split('\n')[0]


def make_gate(policy: Any, *, evaluate: Any, allow: Optional[List[str]] = None,
              deny: Optional[List[str]] = None, on_error: str = 'ask', log: Optional[str] = None,
              on_capture: Any = None, label: Optional[str] = None,
              policy_hash: Optional[str] = None) -> dict:
    """policy: the compiled policy the gate asks; evaluate: (state) -> a
    decision (the model call); a raise means onError. allow/deny are tool name
    patterns, where * matches any run of characters. on_capture is called with
    (state, decision) after the policy decides, so a caller can record a
    fixture."""
    if policy is not None and not (hasattr(policy, 'identity') and hasattr(policy, 'decide')):
        from ._engine import CompiledPolicy
        policy = CompiledPolicy(policy.to_json() if hasattr(policy, 'to_json') else policy)
    allow = allow or []
    deny = deny or []
    require_at(callable(evaluate), 'evaluate', 'a gate needs an evaluate function for its policy')
    require_at(on_error in ('ask', 'deny'), 'onError', "onError is 'ask' or 'deny'")
    for name, lst in (('allow', allow), ('deny', deny)):
        require_at(isinstance(lst, list) and all(isinstance(x, str) for x in lst), name,
                   'a tool list is an array of patterns')
    return {'policy': policy, 'evaluate': evaluate, 'allow': allow, 'deny': deny,
            'onError': on_error, 'log': log, 'onCapture': on_capture,
            'label': label or (policy.policy.get('name') if policy is not None else None) or 'gate',
            'policyHash': policy_hash or (policy.identity() if policy is not None and
                                          hasattr(policy, 'identity') else None),
            'writing': None}


def parse_tool_list(s: str) -> List[str]:
    """'"a,b, c"' -> ['a', 'b', 'c']"""
    return [x.strip() for x in s.split(',') if x.strip()]


def _glob_pattern(g: str) -> re.Pattern:
    escaped = '.*'.join(re.escape(part) for part in g.split('*'))
    return re.compile(f'^{escaped}$')


def tool_matches(patterns: List[str], tool: Any) -> bool:
    return isinstance(tool, str) and any(_glob_pattern(p).match(tool) for p in patterns)


def gate_state(tool: Any, args: Any, *, source: str, server: Any = None,
               annotations: Any = None) -> dict:
    return {'tool': tool,
            'arguments': args if is_object(args) or isinstance(args, list) else {},
            'source': source, 'server': server if server is not None else None,
            'annotations': annotations if is_object(annotations) else None}


def decision_to_verdict(d: dict) -> dict:
    """-> {'verdict', 'reason'}"""
    reason = d.get('reason') or explain_decision(d).split('\n')[0]
    if d.get('action') in ('assign', 'page', 'escalate') and d.get('target') in ('allow', 'deny', 'ask'):
        return {'verdict': d['target'], 'reason': reason}
    if d.get('action') in ('hold', 'confirm'):
        return {'verdict': 'ask', 'reason': reason}
    return {'verdict': 'deny',
            'reason': (f"the gate policy decided {d.get('action')}"
                       + (f" {d.get('target')}" if d.get('target') else '')
                       + ', which is not allow, deny or ask, so the call is denied')}


async def gate_check(g: dict, state: dict) -> dict:
    """state: gate_state's shape. -> {'verdict', 'reason', 'by', 'decision'}"""
    tool = state.get('tool') or ''
    if tool_matches(g['deny'], tool):
        v = {'verdict': 'deny', 'reason': f"'{tool}' is on the deny list",
             'by': 'deny-list', 'decision': None}
    elif tool_matches(g['allow'], tool):
        v = {'verdict': 'allow', 'reason': f"'{tool}' is on the allow list",
             'by': 'allow-list', 'decision': None}
    else:
        try:
            decision = await _await_if(g['evaluate'](state))
            if g.get('onCapture'):
                await _await_if(g['onCapture'](state, decision))
            v = {**decision_to_verdict(decision), 'by': 'policy', 'decision': decision}
        except Exception as error:
            v = {'verdict': g['onError'], 'by': 'error', 'decision': None,
                 'reason': (f"the gate policy could not decide, so the answer is {g['onError']}: "
                            f'{_first_line(error)}')}
    await _log_verdict(g, state, v)
    return v


async def _await_if(value: Any) -> Any:
    if asyncio.iscoroutine(value) or asyncio.isfuture(value):
        return await value
    return value


async def _log_verdict(g: dict, state: dict, v: dict) -> None:
    """One line per verdict. The arguments are summarized by a digest: they can
    hold secrets, and the policy's redactors do not run on the log."""
    if not g.get('log'):
        return
    d = v.get('decision')
    line = {
        'at': _now_iso(),
        'tool': state.get('tool') if state.get('tool') is not None else None,
        'source': state.get('source') if state.get('source') is not None else None,
        'server': state.get('server') if state.get('server') is not None else None,
        'arguments_sha256': _sha256_hex(canonical(state.get('arguments') if state.get('arguments') is not None else {})),
        'verdict': v['verdict'], 'by': v['by'], 'reason': v['reason'],
        'decision': ({'action': d.get('action'),
                      'target': d.get('target') if d.get('target') is not None else None,
                      'request_id': d.get('request_id') if d.get('request_id') is not None else None}
                     if d else None),
    }
    # One writer at a time, so concurrent verdicts do not interleave.
    async def append() -> None:
        try:
            os.makedirs(os.path.dirname(g['log']) or '.', exist_ok=True)
            with open(g['log'], 'a', encoding='utf8') as handle:
                handle.write(jsonify(line) + '\n')
        except Exception as error:
            import sys
            print(f'jev gate: could not write the log: {error}', file=sys.stderr)

    previous = g.get('writing')
    g['writing'] = _chain(previous, append())
    await g['writing']


def _chain(previous: Optional[asyncio.Task], writing: Any) -> asyncio.Task:
    async def run() -> None:
        if previous is not None:
            try:
                await previous
            except Exception:
                pass
        await writing

    return asyncio.ensure_future(run())


def call_digest(tool: Any, args: Any) -> str:
    return _sha256_hex(canonical({'tool': tool, 'arguments': args}))


def sign_request_state(key: bytes, payload: dict) -> str:
    body = _b64url(json.dumps(payload).encode('utf8'))
    return f'{body}.{_b64url(_hmac(key, body))}'


def verify_request_state(key: bytes, state: Any, tool: Any, args: Any, now: int) -> dict:
    """-> the payload, or raises an McpError naming what is wrong. Checked in
    order: the signature, the expiry, then the tool and arguments it was
    issued for."""
    def bad(why: str) -> None:
        raise_mcp('invalid-params', f'requestState rejected: {why}\n  call the tool again without it')

    parts = state.split('.') if isinstance(state, str) else None
    if not parts or len(parts) != 2:
        bad('it is not one this gate issued')
    mac = _from_b64url(parts[1])
    if not mac or not _same_bytes(mac, _hmac(key, parts[0])):
        bad('its signature does not verify (it was altered, or issued by another process)')
    payload = None
    try:
        parsed = _from_b64url(parts[0])
        payload = json.loads(parsed.decode('utf8')) if parsed is not None else None
    except Exception:  # not ours
        payload = None
    if not is_object(payload):
        bad('it is not one this gate issued')
    if not (finite(payload.get('exp')) and now < payload['exp']):
        bad('it expired')
    if payload.get('tool') != tool or payload.get('digest') != call_digest(tool, args):
        bad('it was issued for another tool or other arguments')
    return payload


APPROVAL_KEY = 'jev_gate_approval'
_APPROVAL_SCHEMA = {
    'type': 'object',
    'properties': {'approve': {'type': 'boolean', 'title': 'Allow this call',
                               'description': 'true runs the tool once; false denies it'}},
    'required': ['approve'],
}


def _approval_message(tool: Any, args: Any, reason: str) -> str:
    shown = jsonify(args)
    return (f"Allow the tool call '{tool}'?\nThe gate asks because: {reason}\n"
            f'Arguments: {shown[:600] + "..." if len(shown) > 600 else shown}')


def _approved(r: Any) -> bool:
    return (is_object(r) and r.get('action') == 'accept' and is_object(r.get('content'))
            and r['content'].get('approve') is True)


def _can_elicit(caps: Any) -> bool:
    """A client that declared elicitation, with form mode ({} means form)."""
    e = caps.get('elicitation') if is_object(caps) else None
    return is_object(e) and (len(e) == 0 or own(e, 'form'))


def mcp_server_of_tool(name: Any) -> Optional[str]:
    m = re.match(r'^mcp__(.+?)__', name) if isinstance(name, str) else None
    return m.group(1) if m else None


def _strip_meta(params: dict) -> dict:
    """The upstream's own request fields, minus ours: its client adds its own
    version and capabilities, and progress is not relayed."""
    if not is_object(params.get('_meta')):
        return params
    kept = {k: v for k, v in params['_meta'].items()
            if k != 'progressToken' and not k.startswith('io.modelcontextprotocol/')}
    rest = {k: v for k, v in params.items() if k != '_meta'}
    return {**rest, '_meta': kept} if kept else rest


def _wrap_tools(refresh):
    async def listed(params, call):
        return {'tools': await refresh()}
    return listed


def gate_proxy_server(g: dict, upstream: dict, *, state_key: Optional[bytes] = None,
                      state_ttl: int = 300, clock: Any = None) -> dict:
    """upstream: an MCP client, with no on_elicit: the gate does not relay the
    upstream's own questions."""
    if state_key is None:
        state_key = secrets.token_bytes(32)
    if clock is None:
        clock = lambda: int(time.time())  # noqa: E731
    upstream_name = (upstream['serverInfo'].get('name')
                     if is_object(upstream.get('serverInfo')) and isinstance(upstream['serverInfo'].get('name'), str)
                     else upstream['source'])
    cached: List[dict] = []

    async def refresh_tools() -> List[dict]:
        nonlocal cached
        cached = await mcp_list_tools(upstream)
        return cached

    async def annotations_of(name: str) -> Any:
        tool = next((t for t in cached if t.get('name') == name), None)
        if not tool:
            try:
                refreshed = await refresh_tools()
                tool = next((t for t in refreshed if t.get('name') == name), None)
            except Exception:
                tool = None
        return tool.get('annotations') if tool and is_object(tool.get('annotations')) else None

    async def forward(name: str, args: dict) -> Any:
        try:
            r = await mcp_call_tool(upstream, name, args)
            if input_required(r):
                return mcp_tool_error(f"'{name}' asked for more input, and the jev gate doesn't "
                                      "relay an upstream server's questions")
            return r
        except McpError:
            raise
        except Exception as error:
            return mcp_tool_error(f'the upstream server failed: {error}')

    def deny_result(reason: str) -> dict:
        return mcp_tool_error(f'Blocked by the jev gate ({g["label"]}): {reason}')

    async def person_said(name: str, args: dict, answer: Any) -> Any:
        ok = _approved(answer)
        await _log_verdict(g, gate_state(name, args, source='mcp-proxy', server=upstream_name), {
            'verdict': 'allow' if ok else 'deny', 'by': 'person', 'decision': None,
            'reason': ('a person approved it' if ok else
                       f"a person answered {answer.get('action', '?') if answer else '?'}"
                       if answer else 'no answer came'),
        })
        if ok:
            return await forward(name, args)
        return deny_result('a person did not approve it' if answer
                           else 'nobody answered the approval request')

    async def ask(name: str, args: dict, reason: str, call: dict) -> Any:
        if call['era'] == 'modern' and _can_elicit(call.get('capabilities')):
            return mcp_input_required(
                {APPROVAL_KEY: {'method': 'elicitation/create',
                                'params': {'mode': 'form', 'message': _approval_message(name, args, reason),
                                           'requestedSchema': _APPROVAL_SCHEMA}}},
                state=sign_request_state(state_key, {
                    'kind': 'ask', 'tool': name, 'digest': call_digest(name, args),
                    'exp': clock() + state_ttl, 'reason': reason,
                    'nonce': _b64url(secrets.token_bytes(8))}))
        if call.get('elicit'):
            return await person_said(name, args, await call['elicit'](
                _approval_message(name, args, reason), _APPROVAL_SCHEMA))
        return deny_result(f"it needs a person's approval ({reason}), and this client can't ask one: "
                           'it declared no elicitation capability')

    async def call_tool(params: dict, call: dict) -> Any:
        name = params.get('name')
        if not isinstance(name, str):
            raise_mcp('invalid-params', "tools/call needs params.name, the tool's name")
        args = params.get('arguments') if params.get('arguments') is not None else {}
        if not is_object(args):
            raise_mcp('invalid-params', "tools/call: `arguments' must be an object")
        if params.get('requestState'):
            payload = verify_request_state(state_key, params['requestState'], name, args, clock())
            answer = (params.get('inputResponses').get(APPROVAL_KEY)
                      if is_object(params.get('inputResponses')) else None)
            # A retry that left out the answer is asked again.
            return (await person_said(name, args, answer) if answer
                    else await ask(name, args, payload.get('reason') or 'the gate asks', call))
        v = await gate_check(g, gate_state(name, args, source='mcp-proxy', server=upstream_name,
                                           annotations=await annotations_of(name)))
        if v['verdict'] == 'allow':
            return await forward(name, args)
        if v['verdict'] == 'ask':
            return await ask(name, args, v['reason'], call)
        return deny_result(v['reason'])

    def relay(method: str):
        async def run(params: dict) -> Any:
            try:
                return await mcp_request(upstream, method, _strip_meta(params))
            except McpError:
                raise
            except Exception as error:
                raise_mcp('internal-error', f'the upstream server failed: {error}')
        return run

    up_caps = upstream.get('capabilities') if is_object(upstream.get('capabilities')) else {}
    capabilities: Dict[str, Any] = {'tools': {}}
    for key in ('resources', 'prompts', 'completions'):
        if own(up_caps, key):
            capabilities[key] = {}
    return make_mcp_server(
        f'jev-gate({upstream_name})',
        version='2.3',
        title=f'{upstream_name}, gated by {g["label"]}',
        instructions=upstream.get('instructions'),
        # list-changed and subscriptions are left out: the proxy relays no notifications.
        capabilities=capabilities,
        methods={
            'tools/list': _wrap_tools(refresh_tools),
            'tools/call': call_tool,
            'resources/list': relay('resources/list'),
            'resources/read': relay('resources/read'),
            'resources/templates/list': relay('resources/templates/list'),
        },
        fallback=lambda method, params: relay(method)(params))


# Claude Code and Codex hooks.
def _event_ref(event: Any, key: str, fallback: Any = None) -> Any:
    if not is_object(event):
        return fallback
    return event[key] if event.get(key) is not None else fallback


def detect_hook_host(input_value: Any) -> str:
    if is_object(input_value) and (_event_ref(input_value, 'turn_id') or _event_ref(input_value, 'model')):
        return 'codex'
    return 'claude'


def _canonical_cwd(value: Any) -> str:
    """A directory path may carry a trailing separator, which must not make a
    different approval fingerprint for the same working directory. Symlinks are
    resolved, so the same directory reached two ways is one fingerprint."""
    path = os.path.realpath(value if isinstance(value, str) and value != '' else os.getcwd())
    return path


def normalize_hook_event(input_value: Any, *, host: str = 'auto') -> dict:
    require_at(is_object(input_value), 'input', 'a hook event is a JSON object')
    selected = detect_hook_host(input_value) if host == 'auto' else host
    require_at(selected in ('claude', 'codex'), 'host', "host is 'auto', 'claude' or 'codex'")
    tool = _event_ref(input_value, 'tool_name', '')
    tool_input = _event_ref(input_value, 'tool_input', {})
    annotations = _event_ref(input_value, 'tool_annotations', _event_ref(input_value, 'annotations'))
    return {
        'host': selected,
        'event': _event_ref(input_value, 'hook_event_name'),
        'tool': tool.strip() if isinstance(tool, str) else str(tool),
        'input': tool_input if is_object(tool_input) or isinstance(tool_input, list) else {},
        'cwd': _canonical_cwd(_event_ref(input_value, 'cwd', os.getcwd())),
        'annotations': annotations if is_object(annotations) else None,
    }


def call_fingerprint(input_value: Any, policy_hash: Optional[str]) -> str:
    event = normalize_hook_event(input_value)
    return _sha256_hex(canonical({'tool': event['tool'], 'input': event['input'],
                                  'cwd': event['cwd'], 'policy': policy_hash if policy_hash is not None else None}))


# One approval, for one exact call, that is consumed when it is used.
APPROVAL_SETTINGS = {'directory': None, 'ttlSeconds': 600}


def _approval_file(cwd: Any) -> str:
    return os.path.join(APPROVAL_SETTINGS['directory'] or _canonical_cwd(cwd), '.jev',
                        'gate-approvals.jsonl')


def _read_approvals(path: str) -> List[dict]:
    if not os.path.exists(path):
        return []
    with open(path, encoding='utf8') as handle:
        text = handle.read()
    out = []
    for line in text.split('\n'):
        if line.strip() == '':
            continue
        try:
            value = json.loads(line)
        except Exception:
            continue
        if is_object(value):
            out.append(value)
    return out


def _write_approvals(path: str, entries: List[dict]) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    temporary = f'{path}.{os.getpid()}.{int(time.time() * 1000)}.tmp'
    with open(temporary, 'w', encoding='utf8') as handle:
        handle.write(''.join(jsonify(e) + '\n' for e in entries))
        handle.flush()
        os.fsync(handle.fileno())
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)
    os.chmod(path, 0o600)


async def _with_approval_lock(path: str, thunk: Any) -> Any:
    """A lock directory, so two processes cannot lose each other's approvals."""
    directory = os.path.dirname(path)
    os.makedirs(directory, exist_ok=True)
    lock = os.path.join(directory, 'gate-approvals.lock')
    attempt = 0
    while True:
        try:
            os.mkdir(lock)
            break
        except FileExistsError:
            # A lock left behind by a dead process is broken after half a minute.
            try:
                if time.time() * 1000 - os.stat(lock).st_mtime * 1000 > 30_000:
                    try:
                        os.rmdir(lock)
                    except OSError:
                        pass
                    continue
            except OSError:  # it vanished; try again
                pass
            require_at(attempt < 500, 'gate', f'timed out waiting for {lock}')
            attempt += 1
            await asyncio.sleep(0.01)
        except OSError as error:
            raise
    try:
        return await thunk()
    finally:
        try:
            os.rmdir(lock)
        except OSError:
            pass


def _live_approval(entry: dict, now: int) -> bool:
    return (isinstance(entry.get('fingerprint'), str) and finite(entry.get('expires_at'))
            and now < entry['expires_at'])


async def approve_once(fingerprint: Any, *, now: Optional[int] = None,
                       cwd: Optional[str] = None) -> str:
    if now is None:
        now = int(time.time())
    if cwd is None:
        cwd = os.getcwd()
    require_at(isinstance(fingerprint, str) and re.match(r'^[0-9a-f]{64}$', fingerprint) is not None,
               'fingerprint', 'an approval names a SHA-256 hex digest')
    path = _approval_file(cwd)

    async def write() -> None:
        kept = [e for e in _read_approvals(path)
                if _live_approval(e, now) and e.get('fingerprint') != fingerprint]
        _write_approvals(path, kept + [{'fingerprint': fingerprint, 'approved_at': now,
                                        'expires_at': now + APPROVAL_SETTINGS['ttlSeconds']}])

    await _with_approval_lock(path, write)
    return path


async def approved_once(fingerprint: str, *, now: Optional[int] = None,
                        cwd: Optional[str] = None) -> bool:
    """A consuming predicate: a True result removes the matching entry."""
    if now is None:
        now = int(time.time())
    if cwd is None:
        cwd = os.getcwd()
    path = _approval_file(cwd)

    async def check() -> bool:
        entries = _read_approvals(path)
        found = any(_live_approval(e, now) and e.get('fingerprint') == fingerprint for e in entries)
        kept = [e for e in entries
                if _live_approval(e, now) and e.get('fingerprint') != fingerprint]
        if os.path.exists(path) or kept:
            _write_approvals(path, kept)
        return found

    return await _with_approval_lock(path, check)


def hook_output(verdict: str, reason: str, *, host: str = 'claude') -> dict:
    return {'hookSpecificOutput': {
        'hookEventName': 'PreToolUse',
        # Codex has no "ask": a call that needs a person is denied with the reason.
        'permissionDecision': 'deny' if host == 'codex' and verdict == 'ask' else verdict,
        'permissionDecisionReason': reason,
    }}


async def hook_verdict_to_response(verdict: str, input_value: Any, policy_hash: Optional[str],
                                   *, now: Optional[int] = None) -> str:
    if now is None:
        now = int(time.time())
    if verdict == 'ask':
        return ('allow' if await approved_once(call_fingerprint(input_value, policy_hash),
                                               now=now, cwd=normalize_hook_event(input_value)['cwd'])
                else 'deny')
    return verdict if verdict in ('allow', 'deny') else 'deny'


async def hook_response(input_value: Any, load_gate: Any, *, on_error: str = 'ask',
                        host: str = 'auto', now: Optional[int] = None) -> Optional[dict]:
    """input_value: the hook's stdin, parsed, or None when it was not JSON;
    load_gate: () -> a gate; a load failure means on_error.

    -> the JSON to print, or None to print nothing (not a PreToolUse event)."""
    if now is None:
        now = int(time.time())
    selected = detect_hook_host(input_value) if host == 'auto' else host
    if not is_object(input_value):
        return hook_output(on_error, "jev gate: the hook's input was not a JSON object, "
                          'so the gate could not look at the call', host=selected)
    if _event_ref(input_value, 'hook_event_name') != 'PreToolUse':
        return None
    event = normalize_hook_event(input_value, host=selected)
    tool = event['tool']
    try:
        g = await _await_if(load_gate())
    except Exception as error:
        return hook_output(on_error, f'jev gate: the gate policy did not load, so the answer is '
                          f'{on_error}: {_first_line(error)}', host=selected)
    state = gate_state(tool, event['input'],
                       source='codex' if selected == 'codex' else 'claude-code',
                       server=mcp_server_of_tool(tool), annotations=event['annotations'])
    fingerprint = call_fingerprint(input_value, g['policyHash'])
    hard_deny = tool_matches(g['deny'], tool)
    hard_allow = tool_matches(g['allow'], tool)
    # Codex cannot be asked, so a person's one-shot approval is consumed here.
    if selected == 'codex' and not hard_deny and not hard_allow \
            and await approved_once(fingerprint, now=now, cwd=event['cwd']):
        reason = 'jev gate: a person approved this exact call once'
        await _log_verdict(g, state, {'verdict': 'allow', 'reason': reason, 'by': 'person',
                                      'decision': None})
        return hook_output('allow', reason, host='codex')
    v = await gate_check(g, state)
    reason = f"jev gate ({g['label']}): {v['reason']}"
    if selected == 'codex' and v['verdict'] == 'allow':
        return None
    if selected == 'codex' and v['verdict'] == 'ask':
        return hook_output('deny',
                           f'{reason}. Approval fingerprint: {fingerprint}. To allow only this '
                           'exact call, run `jev gate approve-once ' + fingerprint + '` and retry '
                           'it within ten minutes', host='codex')
    return hook_output(v['verdict'], reason, host=selected)
