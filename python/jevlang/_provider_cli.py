"""The Claude, Codex and fx CLI adapters: one non-interactive run per request,
a strict output schema for Codex, and fx's own result envelope, with each CLI's
own accounting. Ported from the TypeScript engine's src/provider/providers/
modules; the command lines are pinned by the cli-adapter parity files."""
from __future__ import annotations

import json
import os
import re
import tempfile
import time
from typing import Any, Dict, List, Optional, Tuple

from ._common import finite, is_object, own
from ._numberfmt import jsonify
from ._provider import (Provider, ProviderError, availability, capabilities, find_executable,
                        js_str, js_truthy, nn, run_program)


def parse_json(text: str) -> Any:
    try:
        return json.loads(text)
    except (ValueError, TypeError):
        return None


def _provider_error(kind: str, target: Any, message: str, retryable: bool = False, mutated: bool = False,
                    usage: Any = None, cost: Optional[dict] = None, status: Any = None) -> ProviderError:
    return ProviderError(message, kind=kind, target=target, retryable=retryable, mutated=mutated,
                         usage=usage, cost=cost, status=status, detail=message)


def _resolve_path(value: str) -> str:
    return os.path.abspath(value)


def last_structured_call(transcript: str) -> Optional[dict]:
    def from_text(text: str) -> Optional[dict]:
        blocks = re.findall(r'<StructuredOutput>([\s\S]*?)</StructuredOutput>', text)
        if not blocks:
            return None
        block = blocks[-1]
        as_json = re.match(r'^\s*(\{[\s\S]*\})\s*$', block)
        value = parse_json(as_json.group(1)) if as_json else None
        if is_object(value):
            return value
        pairs = re.findall(r'<parameter name="([^"]+)">([\s\S]*?)</parameter>', block)
        tags = re.findall(r'<([a-z_]+)>([\s\S]*?)</\1>', block)
        chosen = pairs if pairs else tags
        return {k: v.strip() for k, v in chosen} if chosen else None

    found = None
    for line in transcript.split('\n'):
        if 'StructuredOutput' not in line:
            continue
        event = parse_json(line)
        if not (is_object(event) and event.get('type') == 'assistant' and is_object(event.get('message'))):
            continue
        content = event['message'].get('content')
        content = content if isinstance(content, list) else []
        for item in content:
            if not is_object(item):
                continue
            if item.get('type') == 'tool_use' and item.get('name') == 'StructuredOutput' and is_object(item.get('input')):
                found = item['input']
            elif item.get('type') == 'text' and isinstance(item.get('text'), str):
                text = from_text(item['text'])
                if text:
                    found = text
    return found


def _last_result_event(transcript: str) -> Any:
    results = []
    for line in transcript.split('\n'):
        event = parse_json(line)
        if is_object(event) and event.get('type') == 'result':
            results.append(event)
    return results[-1] if results else None


def _reported_cost(reply: Any) -> dict:
    total = reply.get('total_cost_usd') if is_object(reply) else None
    if finite(total):
        return {'mode': 'reported-usd', 'usd': total}
    return {'mode': 'subscription', 'usd': None}


def _canonical_images(request: dict, target: Any) -> List[str]:
    out = []
    for image in request['images']:
        path = _resolve_path(image)
        if not os.path.exists(path):
            raise _provider_error('configuration', target, f'Claude image input is not a readable file: {path}')
        out.append(path)
    return out


def _permission_tools(request: dict) -> List[str]:
    if request['mode'] != 'workspace':
        return []
    tools = ['Read', 'Glob', 'Grep']
    if 'write' in request['permissions']:
        tools += ['Write', 'Edit']
    if 'shell' in request['permissions']:
        tools += ['Bash']
    return tools


def _metadata_list(request: dict, key: str) -> List[Any]:
    value = request['metadata'].get(key)
    return value if isinstance(value, list) else []


def _prompt_with_images(prompt: str, images: List[str]) -> str:
    if len(images) == 0:
        return prompt
    listed = '\n'.join(f'- {p}' for p in images)
    return f'{prompt}\n\n<jev-image-inputs>\n{listed}\n</jev-image-inputs>\nUse the Read tool to inspect every listed image.'


async def claude_cli_runner(executable: str, request: dict, target: dict) -> dict:
    images = _canonical_images(request, target)
    metadata = request['metadata']
    stream_to = nn(metadata.get('stream_to'), None)
    stream = js_truthy(metadata.get('stream')) or stream_to is not None
    tools = list(dict.fromkeys([*_metadata_list(request, 'tools'), *_permission_tools(request), *(['Read'] if images else [])]))
    disallowed = _metadata_list(request, 'disallowed')
    system = metadata['system'] if own(metadata, 'system') else (
        'default' if request['mode'] == 'workspace' else 'You are a careful assistant. Answer with the requested JSON.')
    budget = nn(request['limits'].get('max_budget_usd'), None)
    timeout_seconds = nn(request['limits'].get('timeout_seconds'), 600)
    schema = request.get('schema')
    args = [
        '-p', '--output-format', 'stream-json' if stream else 'json', '--no-session-persistence',
        *(['--model', target['model']] if target.get('model') else []),
        *(['--max-budget-usd', js_str(budget)] if budget else []),
        *(['--json-schema', jsonify(schema)] if schema else []),
        '--tools', ','.join(tools), '--disable-slash-commands', '--strict-mcp-config', '--setting-sources', '',
        *([] if system == 'default' else ['--system-prompt', system]),
        *(['--append-system-prompt', metadata['append_system']] if metadata.get('append_system') else []),
        *(['--permission-mode', metadata['permission_mode']] if metadata.get('permission_mode') else []),
        *(['--disallowedTools', *disallowed] if disallowed else []),
        *(['--effort', target['effectiveEffort']] if target.get('effectiveEffort') else []),
        *(['--verbose'] if stream else []),
        *(['--allowedTools', ','.join(tools)] if tools else []),
        *(['--add-dir', _resolve_path(request['directory'])] if request.get('directory') else []),
    ]
    if stream_to:
        os.makedirs(os.path.dirname(_resolve_path(stream_to)), exist_ok=True)

    def on_line(line: str) -> None:
        if stream and stream_to:
            with open(_resolve_path(stream_to), 'a', encoding='utf-8') as handle:
                handle.write(f'{line}\n')

    outcome = await run_program(find_executable(executable) or executable, args, {
        'stdin': _prompt_with_images(request['prompt'], images),
        'timeoutSeconds': timeout_seconds,
        'dir': request.get('directory'),
        'onLine': on_line if (stream and stream_to) else None,
    })
    status, stdout = outcome['status'], outcome['stdout']
    if status is None:
        raise _provider_error('timeout', target, 'Claude timed out', retryable=True)
    reply = _last_result_event(stdout) if stream else parse_json(stdout)
    if not is_object(reply):
        raise _provider_error('invalid-output', target, 'Claude returned invalid structured output', retryable=True, status=status)
    cost = _reported_cost(reply)
    usage = reply['usage'] if is_object(reply.get('usage')) else None
    if status != 0 or reply.get('is_error'):
        raise _provider_error('provider-failure', target, 'Claude failed', retryable=True, usage=usage, cost=cost, status=status)
    output = nn(reply.get('structured_output'), last_structured_call(stdout) if stream else None)
    if not js_truthy(output) or not _schema_ok(schema, output):
        raise _provider_error('invalid-output', target, 'Claude returned invalid structured output', retryable=True, usage=usage, cost=cost, status=status)
    return {
        'output': output, 'target': target,
        'model': nn(reply.get('model'), nn(target.get('model'), None)),
        'usage': nn(usage, {}),
        'cost': cost,
        'requestId': nn(nn(nn(reply.get('provider_request_id'), reply.get('request_id')), reply.get('session_id')), None),
        'exitStatus': status,
        'changed': output.get('changed') if is_object(output) and isinstance(output.get('changed'), list) else [],
        'attempts': [],
    }


def _schema_ok(schema: Optional[dict], output: Any) -> bool:
    from ._provider import json_schema_valid
    return json_schema_valid(schema, output)


def claude_provider(command: str = 'claude', max_parallel: int = 2) -> Provider:
    async def discover() -> dict:
        executable = find_executable(command)
        if not executable:
            return availability('missing', detail='Claude CLI is not on PATH')
        version = await run_program(executable, ['--version'], {'timeoutSeconds': 10})
        auth = await run_program(executable, ['auth', 'status', '--json'], {'timeoutSeconds': 10})
        parsed = parse_json(auth['stdout'])
        reported = version['stdout'].strip().split()[0] if version['status'] == 0 and version['stdout'].strip() else None
        if is_object(parsed) and parsed.get('loggedIn'):
            return availability('ready', version=reported,
                                billing='subscription' if parsed.get('subscriptionType') else 'unreported',
                                detail='authenticated Claude CLI')
        if (is_object(parsed) and parsed.get('loggedIn') is False) or (auth['status'] is not None and auth['status'] != 0):
            return availability('unauthenticated', version=reported, detail='run `claude auth login`')
        return availability('unavailable', version=reported, detail='could not read Claude authentication status')

    async def run(request: dict, target: dict) -> dict:
        return await claude_cli_runner(command, request, target)

    return Provider('claude', capabilities(
        modes=['structured', 'workspace'], modalities=['text', 'image'], permissions=['read', 'write', 'shell'],
        controls=['structured-output', 'reasoning-effort', 'hard-usd-cap', 'streaming', 'tool-policy'],
        efforts=['low', 'medium', 'high', 'xhigh', 'max'], max_parallel=max_parallel), discover, run)


def _canonical_directory(value: Any, target: Any, label: str) -> str:
    path = _resolve_path(value)
    try:
        if not os.path.isdir(path):
            raise OSError('not a directory')
        os.listdir(path)
    except OSError:
        raise _provider_error('configuration', target, f'Codex {label} is not a readable directory: {path}') from None
    return path


def _canonical_file(value: str, target: Any, label: str) -> str:
    path = _resolve_path(value)
    if not os.path.exists(path):
        raise _provider_error('configuration', target, f'Codex {label} is not a readable file: {path}')
    return path


def _codex_metadata_list(request: dict, key: str) -> List[Any]:
    value = request['metadata'].get(key)
    return value if isinstance(value, list) else []


def _forbidden_prefixes(request: dict, target: Any) -> List[List[str]]:
    value = nn(request['metadata'].get('disallowed'), [])
    if not (isinstance(value, list) and all(isinstance(e, str) and e.strip() != '' for e in value)):
        raise _provider_error('configuration', target, 'Codex disallowed command prefixes must be non-empty strings')
    return [[w for w in re.split(r'\s+', entry) if w != ''] for entry in value]


def _repository_root(directory: str) -> str:
    path = _resolve_path(directory)
    while True:
        if os.path.exists(os.path.join(path, '.git')):
            return path
        parent = os.path.dirname(path)
        if parent == path:
            return _resolve_path(directory)
        path = parent


def _write_forbidden_rules(path: str, prefixes: List[List[str]]) -> None:
    rules = ''.join(
        'prefix_rule(\n    pattern = [' + ', '.join(json.dumps(w) for w in prefix) + '],\n'
        '    decision = "forbidden",\n    justification = "Jev worker boundary",\n)\n\n'
        for prefix in prefixes)
    with open(path, 'w', encoding='utf-8') as handle:
        handle.write(rules)


def _prompt_with_instructions(request: dict, target: Any) -> str:
    metadata = request['metadata']
    system = metadata.get('system') if 'system' in metadata else None
    append_system = metadata.get('append_system') if 'append_system' in metadata else None
    for entry in (system, append_system):
        if entry is not None and entry != 'default' and not isinstance(entry, str):
            raise _provider_error('configuration', target, 'Codex system instructions must be strings or "default"')
    instructions = [x for x in (None if system == 'default' else system, append_system) if isinstance(x, str)]
    if len(instructions) == 0:
        return request['prompt']
    return f'<jev-system-instructions>\n' + '\n\n'.join(instructions) + '\n</jev-system-instructions>\n\n' + request['prompt']


def _jsonl_facts(transcript: str) -> Tuple[Optional[str], dict]:
    request_id = None
    usage: dict = {}
    for line in transcript.split('\n'):
        event = parse_json(line)
        if not is_object(event):
            continue
        if event.get('thread_id') is not None:
            request_id = event['thread_id']
        elif event.get('request_id') is not None:
            request_id = event['request_id']
        if is_object(event.get('usage')):
            usage = event['usage']
    return request_id, usage


def _schema_ref(table: Any, key: str, fallback: Any = None) -> Any:
    if is_object(table) and key in table:
        return table[key]
    return fallback


def _schema_allows_null(schema: Any) -> bool:
    type_value = _schema_ref(schema, 'type')
    enum_value = _schema_ref(schema, 'enum', [])
    alternatives = [*_schema_ref(schema, 'anyOf', []), *_schema_ref(schema, 'oneOf', [])]
    return (type_value == 'null'
            or (isinstance(type_value, list) and 'null' in type_value)
            or (isinstance(enum_value, list) and None in enum_value)
            or any(_schema_allows_null(sub) for sub in alternatives))


def codex_output_schema(value: Any) -> Any:
    if isinstance(value, list):
        return [codex_output_schema(v) for v in value]
    if not is_object(value):
        return value
    normalized = {k: codex_output_schema(v) for k, v in value.items()}
    if normalized.get('type') != 'object':
        return normalized
    properties = nn(normalized.get('properties'), {})
    source_properties = nn(value.get('properties'), {})
    source_required = nn(value.get('required'), [])
    strict = {}
    for key, item in properties.items():
        source = _schema_ref(source_properties, key, {})
        strict[key] = item if (key in source_required or _schema_allows_null(source)) else {'anyOf': [item, {'type': 'null'}]}
    return {**normalized, 'properties': strict, 'required': list(strict), 'additionalProperties': False}


def restore_optional_fields(value: Any, schema: Any) -> Any:
    alternatives = [*_schema_ref(schema, 'anyOf', []), *_schema_ref(schema, 'oneOf', [])] if is_object(schema) else []
    matching = next((choice for choice in alternatives if _schema_ok(choice, value)), None)
    if matching is not None:
        return restore_optional_fields(value, matching)
    if is_object(value) and is_object(schema):
        properties = _schema_ref(schema, 'properties', {})
        required = _schema_ref(schema, 'required', [])
        out = {}
        for key, item in value.items():
            property_schema = _schema_ref(properties, key)
            if property_schema is not None and item is None and key not in required and not _schema_allows_null(property_schema):
                continue
            out[key] = restore_optional_fields(item, property_schema) if property_schema is not None else item
        return out
    if isinstance(value, list) and is_object(schema):
        items = _schema_ref(schema, 'items')
        return [restore_optional_fields(item, items) for item in value] if items is not None else value
    return value


async def codex_cli_runner(executable: str, request: dict, target: dict, billing: str = 'unreported') -> dict:
    directory = _canonical_directory(nn(request.get('directory'), os.getcwd()), target, 'working directory')
    add_directories = [_canonical_directory(v, target, 'additional directory') for v in _codex_metadata_list(request, 'add_dirs')]
    images = [_canonical_file(v, target, 'image input') for v in request['images']]
    timeout_seconds = nn(request['limits'].get('timeout_seconds'), 600)
    stream_to = nn(request['metadata'].get('stream_to'), None)
    temporary = tempfile.mkdtemp(prefix='jev-codex-')
    schema_path = os.path.join(temporary, 'schema.json')
    result_path = os.path.join(temporary, 'result.json')
    forbidden = _forbidden_prefixes(request, target)
    codex_directory = os.path.join(_repository_root(directory), '.codex')
    rules_directory = os.path.join(codex_directory, 'rules')
    rules_path = None
    made_codex = made_rules = False
    try:
        with open(schema_path, 'w', encoding='utf-8') as handle:
            handle.write(jsonify(codex_output_schema(nn(request.get('schema'), {}))))
        if forbidden:
            if not os.path.exists(codex_directory):
                os.mkdir(codex_directory)
                made_codex = True
            if not os.path.exists(rules_directory):
                os.mkdir(rules_directory)
                made_rules = True
            rules_path = os.path.join(rules_directory, f'jev-{os.getpid()}-{int(time.time() * 1000)}.rules')
            _write_forbidden_rules(rules_path, forbidden)
        if stream_to:
            os.makedirs(os.path.dirname(_resolve_path(stream_to)), exist_ok=True)

        workspace = request['mode'] == 'workspace'
        write = 'write' in request['permissions']
        shell = 'shell' in request['permissions']
        if write and not workspace:
            raise _provider_error('configuration', target, 'Codex write permission requires workspace mode')
        if write and not shell:
            raise _provider_error('configuration', target, 'Codex cannot grant write permission while denying shell permission')
        writable = workspace and write and shell
        if add_directories and not writable:
            raise _provider_error('configuration', target, 'Codex additional writable directories require write and shell permissions')
        args = [
            'exec', '--ephemeral', '--ignore-user-config', '--json',
            *(['--model', target['model']] if target.get('model') else []),
            *(['-c', f'model_reasoning_effort="{target["effectiveEffort"]}"'] if target.get('effectiveEffort') else []),
            *([] if shell else ['--disable', 'shell_tool']),
            *(['--approve-for-me', '-c', 'sandbox_workspace_write.network_access=true'] if writable else ['--sandbox', 'read-only']),
            '--output-schema', schema_path, '--output-last-message', result_path, '--cd', directory,
            *[x for path in add_directories for x in ['--add-dir', path]],
            *[x for path in images for x in ['--image', path]],
            '-',
        ]

        def on_line(line: str) -> None:
            with open(_resolve_path(stream_to), 'a', encoding='utf-8') as handle:
                handle.write(f'{line}\n')

        outcome = await run_program(find_executable(executable) or executable, args, {
            'stdin': _prompt_with_instructions(request, target),
            'timeoutSeconds': timeout_seconds,
            'dir': directory,
            'onLine': on_line if stream_to else None,
        })
        cost = {'mode': billing, 'usd': None}
        status, stdout = outcome['status'], outcome['stdout']
        if status is None:
            raise _provider_error('timeout', target, 'Codex timed out', retryable=True, cost=cost)
        request_id, usage = _jsonl_facts(stdout)
        if status != 0:
            raise _provider_error('provider-failure', target, 'Codex failed', retryable=True, usage=usage, cost=cost, status=status)
        raw = parse_json(open(result_path, encoding='utf-8').read()) if os.path.exists(result_path) else None
        output = None if raw is None else restore_optional_fields(raw, request.get('schema'))
        if not js_truthy(output) or not _schema_ok(request.get('schema'), output):
            raise _provider_error('invalid-output', target, 'Codex returned invalid structured output', retryable=True, usage=usage, cost=cost, status=status)
        return {
            'output': output, 'target': target, 'model': nn(target.get('model'), None), 'usage': usage, 'cost': cost,
            'requestId': request_id, 'exitStatus': status,
            'changed': output.get('changed') if is_object(output) and isinstance(output.get('changed'), list) else [],
            'attempts': [],
        }
    finally:
        if rules_path and os.path.exists(rules_path):
            os.remove(rules_path)
        if made_rules and os.path.isdir(rules_directory) and not os.listdir(rules_directory):
            os.rmdir(rules_directory)
        if made_codex and os.path.isdir(codex_directory) and not os.listdir(codex_directory):
            os.rmdir(codex_directory)
        for entry in os.listdir(temporary):
            os.remove(os.path.join(temporary, entry))
        os.rmdir(temporary)


def catalog_to_settings(text: str) -> Optional[Dict[str, dict]]:
    parsed = parse_json(text)
    models = parsed.get('models') if is_object(parsed) else None
    if not isinstance(models, list):
        return None
    out = {}
    for model in models:
        if not (is_object(model) and isinstance(model.get('slug'), str)):
            continue
        levels = model.get('supported_reasoning_levels')
        efforts = [l['effort'] for l in levels if is_object(l) and isinstance(l.get('effort'), str)] if isinstance(levels, list) else []
        modalities = model.get('input_modalities')
        out[model['slug']] = {
            'efforts': efforts,
            'default_effort': nn(model.get('default_reasoning_level'), None),
            'modalities': modalities if isinstance(modalities, list) and all(isinstance(x, str) for x in modalities) else [],
        }
    return out


def codex_provider(command: str = 'codex', max_parallel: int = 4) -> Provider:
    state = {'billing': 'unreported'}
    value: Provider

    async def discover() -> dict:
        executable = find_executable(command)
        if not executable:
            return availability('missing', detail='Codex CLI is not on PATH')
        version = await run_program(executable, ['--version'], {'timeoutSeconds': 10})
        login = await run_program(executable, ['login', 'status'], {'timeoutSeconds': 10})
        reported = version['stdout'].strip().split()[-1] if version['status'] == 0 and version['stdout'].strip() else None
        text = f"{login['stdout']}\n{login['stderr']}".strip().lower()
        if login['status'] == 0 and 'logged in' in text and 'not logged in' not in text:
            state['billing'] = 'subscription' if 'chatgpt' in text else 'unreported'
            catalog = await run_program(executable, ['debug', 'models', '--bundled'], {'timeoutSeconds': 30})
            if catalog['status'] == 0:
                settings = catalog_to_settings(catalog['stdout'])
                if settings:
                    value.model_capabilities = settings
            return availability('ready', version=reported, billing=state['billing'], detail='authenticated Codex CLI')
        state['billing'] = 'unreported'
        return availability('unauthenticated', version=reported, detail='run `codex login`')

    async def run(request: dict, target: dict) -> dict:
        return await codex_cli_runner(command, request, target, billing=state['billing'])

    value = Provider('codex', capabilities(
        modes=['structured', 'workspace'], modalities=['text', 'image'], permissions=['read', 'write', 'shell'],
        controls=['structured-output', 'reasoning-effort', 'streaming', 'tool-policy'],
        efforts=['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'], max_parallel=max_parallel), discover, run)
    return value


MINIMUM_FX_VERSION = [0, 0, 10]


def _read_json_value(text: str) -> Optional[dict]:
    try:
        return {'value': json.loads(text)}
    except (ValueError, TypeError):
        return None


def _fx_parse_json(text: str) -> Any:
    parsed = _read_json_value(text)
    return parsed['value'] if parsed else None


def _parse_version(text: str) -> Optional[List[int]]:
    match = re.search(r'([0-9]+)\.([0-9]+)\.([0-9]+)', text)
    return [int(x) for x in match.groups()] if match else None


def _version_at_least(actual: List[int], required: List[int]) -> bool:
    for i, needed in enumerate(required):
        have = actual[i] if i < len(actual) else 0
        if have > needed:
            return True
        if have < needed:
            return False
    return True


def _version_string(version: Optional[List[int]]) -> Optional[str]:
    return '.'.join(str(x) for x in version) if version else None


def _nonempty_string(v: Any) -> bool:
    return isinstance(v, str) and v.strip() != ''


def _subscription_auth(auth: str) -> bool:
    return auth.strip().lower() in ('codex subscription', 'grok subscription')


def _valid_status(value: Any) -> Optional[dict]:
    if is_object(value) and value.get('kind') == 'status' \
            and _nonempty_string(value.get('model')) and _nonempty_string(value.get('auth')) and _nonempty_string(value.get('permission_mode')):
        return value
    return None


def _valid_model_catalog(value: Any) -> Optional[List[str]]:
    if is_object(value) and value.get('kind') == 'models' \
            and isinstance(value.get('ids'), list) and len(value['ids']) > 0 and all(_nonempty_string(x) for x in value['ids']):
        return value['ids']
    return None


def _safe_error_code(reply: Any) -> Optional[str]:
    error = reply.get('error') if is_object(reply) else None
    if isinstance(error, str) and re.match(r'^[A-Za-z][A-Za-z0-9_.:-]{0,127}$', error):
        return error
    return None


def _failure_message(reply: Any) -> str:
    code = _safe_error_code(reply)
    return f'fx failed: {code}' if code else 'fx failed'


def _fx_canonical_directory(value: Any, target: Any, label: str) -> str:
    if not isinstance(value, str) or value == '':
        raise _provider_error('configuration', target, f'fx {label} must be a directory path')
    path = _resolve_path(value)
    try:
        if not os.path.isdir(path):
            raise OSError('not a directory')
        os.listdir(path)
    except OSError:
        raise _provider_error('configuration', target, f'fx {label} is not a readable directory: {path}') from None
    return path


def _fx_canonical_file(value: str, target: Any, label: str) -> str:
    path = _resolve_path(value)
    if not os.path.exists(path):
        raise _provider_error('configuration', target, f'fx {label} is not a readable file: {path}')
    return path


def _fx_metadata_list(request: dict, key: str, target: Any, label: str) -> List[Any]:
    value = request['metadata'][key] if own(request['metadata'], key) else []
    if not isinstance(value, list):
        raise _provider_error('configuration', target, f'fx {label} must be a list')
    return value


def _validate_permissions(request: dict, target: Any) -> None:
    have = request['permissions']
    wanted = ['read', 'write', 'shell']
    if not (len(have) == 3 and all(p in have for p in wanted)):
        raise _provider_error('configuration', target, 'fx workspace requests require exactly read, write, and shell permissions')


def _request_system(request: dict, target: Any) -> Optional[str]:
    value = nn(request['metadata'].get('system'), None)
    if not (value is None or value == 'default' or isinstance(value, str)):
        raise _provider_error('configuration', target, 'fx system instructions must be a string or "default"')
    return value if (isinstance(value, str) and value != 'default') else None


def _request_prompt(request: dict, target: Any) -> str:
    append_system = nn(request['metadata'].get('append_system'), None)
    if not (append_system is None or isinstance(append_system, str)):
        raise _provider_error('configuration', target, 'fx appended system instructions must be a string')
    schema = request.get('schema')
    schema_instruction = f'Return only one JSON value matching this JSON Schema:\n{jsonify(schema)}' if schema else None
    instructions = [x for x in (append_system, schema_instruction) if isinstance(x, str)]
    if len(instructions) == 0:
        return request['prompt']
    return f'<jev-system-instructions>\n' + '\n\n'.join(instructions) + '\n</jev-system-instructions>\n\n' + request['prompt']


def _normalize_usage(reply: dict) -> dict:
    raw = reply['usage'] if is_object(reply.get('usage')) else {}
    usage: Dict[str, Any] = {}
    for key in ('input_tokens', 'output_tokens'):
        value = raw.get(key)
        if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
            usage[key] = value
    if 'input_tokens' in usage and 'output_tokens' in usage:
        usage['total_tokens'] = usage['input_tokens'] + usage['output_tokens']
    steps = reply.get('steps')
    if isinstance(steps, int) and not isinstance(steps, bool) and steps >= 0:
        usage['steps'] = steps
    usage['tool_calls'] = len(reply['tool_calls'])
    return usage


async def fx_cli_runner(command: str, request: dict, target: dict, billing: str = 'unreported') -> dict:
    if request['mode'] != 'workspace':
        raise _provider_error('configuration', target, 'fx supports workspace mode only')
    _validate_permissions(request, target)
    if target.get('effectiveEffort'):
        raise _provider_error('configuration', target, 'fx v0.0.10 does not support exact effort selection')
    forbidden = _fx_metadata_list(request, 'disallowed', target, 'disallowed command prefixes')
    if not all(isinstance(v, str) and v.strip() != '' for v in forbidden):
        raise _provider_error('configuration', target, 'fx disallowed command prefixes must be non-empty strings')
    if forbidden:
        raise _provider_error('configuration', target, 'fx cannot enforce per-run disallowed command prefixes')
    directory = _fx_canonical_directory(request.get('directory'), target, 'workspace')
    add_directories = [_fx_canonical_directory(path, target, 'additional directory')
                       for path in _fx_metadata_list(request, 'add_dirs', target, 'additional directories')]
    images = [_fx_canonical_file(path, target, 'image') for path in request['images']]
    system = _request_system(request, target)
    prompt = _request_prompt(request, target)
    timeout_seconds = nn(request['limits'].get('timeout_seconds'), 600)
    if not (finite(timeout_seconds) and timeout_seconds > 0):
        raise _provider_error('configuration', target, 'fx timeout_seconds must be positive')
    model = nn(target.get('model'), None)
    if not (model is None or isinstance(model, str)):
        raise _provider_error('configuration', target, 'fx model must be a string')
    args = [
        '--no-additional-dirs',
        *[x for path in add_directories for x in ['--add-dir', path]],
        'ask', '--json', '--no-save', '--no-color', '--auto',
        *(['--system', system] if system else []),
        *[x for path in images for x in ['--image', path]],
    ]
    cost = {'mode': billing, 'usd': None}
    env = {**os.environ, **({'FX_MODEL': model} if model else {})}
    outcome = await run_program(find_executable(command) or command, args, {
        'stdin': prompt, 'timeoutSeconds': timeout_seconds, 'dir': directory, 'env': env})
    status, stdout = outcome['status'], outcome['stdout']
    if status is None:
        raise _provider_error('timeout', target, 'fx timed out', retryable=True, mutated=True, cost=cost)
    parsed = _read_json_value(stdout)
    if not (parsed and is_object(parsed['value'])):
        raise _provider_error('protocol', target, 'fx returned a malformed JSON result', retryable=True, mutated=True, cost=cost, status=status)
    reply = parsed['value']
    exit_code = reply.get('exit_code')
    def _clean(key: str) -> bool:
        return (not own(reply, key)) or reply.get(key) is None or isinstance(reply.get(key), str)
    if not (isinstance(exit_code, int) and not isinstance(exit_code, bool)
            and _clean('model') and _clean('session_id')
            and isinstance(reply.get('tool_calls'), list) and is_object(reply.get('usage'))):
        raise _provider_error('protocol', target, 'fx returned an invalid result envelope', retryable=True, mutated=True, cost=cost, status=status)
    usage = _normalize_usage(reply)

    def fail_call(kind: str, message: str, **extra: Any) -> None:
        raise _provider_error(kind, target, message, retryable=True, mutated=True, usage=usage, cost=cost, **extra)

    if status != 0 and exit_code != 0 and status != exit_code:
        fail_call('protocol', 'fx process and result exit codes disagree', status=status)
    if status != exit_code:
        if status == 0:
            fail_call('provider-failure', _failure_message(reply), status=exit_code)
        fail_call('protocol', 'fx process and result exit codes disagree', status=status)
    if status != 0:
        fail_call('provider-failure', _failure_message(reply), status=status)
    final_text = reply['final_output'] if _nonempty_string(reply.get('final_output')) else (
        reply['output'] if isinstance(reply.get('output'), str) else None)
    if final_text is None:
        fail_call('invalid-output', 'fx returned no final output', status=status)
    schema = request.get('schema')
    structured = _read_json_value(final_text) if schema else None
    output = (structured['value'] if structured else None) if schema else final_text
    if (schema and not structured) or not _schema_ok(schema, output):
        fail_call('invalid-output', 'fx returned invalid structured output', status=status)
    return {
        'output': output, 'target': target, 'model': nn(nn(reply.get('model'), model), None), 'usage': usage, 'cost': cost,
        'requestId': nn(reply.get('session_id'), None), 'exitStatus': status,
        'changed': output.get('changed') if is_object(output) and isinstance(output.get('changed'), list) else [],
        'attempts': [],
    }


def fx_provider(command: str = 'fx', max_parallel: int = 2) -> Provider:
    state = {'billing': 'unreported'}
    value: Provider

    async def discover() -> dict:
        executable = find_executable(command)
        if not executable:
            return availability('missing', detail='fx CLI is not on PATH')
        version = await run_program(executable, ['--version'], {'timeoutSeconds': 10})
        parsed = _parse_version(version['stdout']) if version['status'] == 0 else None
        if not parsed:
            return availability('unavailable', detail='could not read fx CLI version')
        if not _version_at_least(parsed, MINIMUM_FX_VERSION):
            return availability('unavailable', version=_version_string(parsed), detail='fx 0.0.10 or newer is required')
        status_run = await run_program(executable, ['status', '--json'], {'timeoutSeconds': 10})
        state_value = _valid_status(_fx_parse_json(status_run['stdout'])) if status_run['status'] == 0 else None
        auth = state_value.get('auth') if state_value else None
        if not isinstance(auth, str):
            return availability('unavailable', version=_version_string(parsed), detail='could not read fx authentication status')
        if auth.strip().lower() == 'missing':
            state['billing'] = 'unreported'
            return availability('unauthenticated', version=_version_string(parsed), detail='run `fx login` or `fx setup`')
        models = await run_program(executable, ['models', '--json'], {'timeoutSeconds': 30})
        ids = _valid_model_catalog(_fx_parse_json(models['stdout'])) if models['status'] == 0 else None
        if not ids:
            return availability('unavailable', version=_version_string(parsed), detail='could not read fx model catalog')
        state['billing'] = 'subscription' if _subscription_auth(auth) else 'unreported'
        value.model_capabilities = {id: {} for id in ids}
        return availability('ready', version=_version_string(parsed), billing=state['billing'], detail='authenticated fx CLI')

    async def run(request: dict, target: dict) -> dict:
        return await fx_cli_runner(command, request, target, billing=state['billing'])

    value = Provider('fx', capabilities(
        modes=['workspace'], modalities=['text', 'image'], permissions=['read', 'write', 'shell'],
        controls=['structured-output'], efforts=[], max_parallel=max_parallel), discover, run)
    return value
