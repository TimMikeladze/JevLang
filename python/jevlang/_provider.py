"""The provider stack: the provider contract, layered configuration, the
bounded subprocess runner, the JSON Schema subset, the jev-provider/1 command
adapter, deterministic routing, the fallback run loop, and the default
registry. Ported from the TypeScript engine's src/provider/ modules; camelCase
record keys (usage, cost, attempts, exitStatus, ...) are kept exactly, because
they flow into journals and fixtures."""
from __future__ import annotations

import asyncio
import codecs
import json
import os
import signal
import weakref
from typing import Any, Awaitable, Callable, Dict, List, Optional

from ._common import fail, finite, is_object, own, require_at
from ._numberfmt import jsonify

RETRYABLE_KINDS = ['unavailable', 'authentication', 'timeout', 'rate-limit', 'overload', 'invalid-output', 'provider-failure']


def nn(value: Any, default: Any) -> Any:
    """JS `a ?? b`: the default when the value is missing or null."""
    return default if value is None else value


def js_truthy(value: Any) -> bool:
    if value is None or value is False:
        return False
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return value != 0 and value == value
    if isinstance(value, (str, list, dict)):
        return len(value) > 0
    return True


def js_str(value: Any) -> str:
    if value is True:
        return 'true'
    if value is False:
        return 'false'
    if value is None:
        return 'null'
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        from ._numberfmt import js_number_str
        return js_number_str(value)
    return str(value)


class ProviderError(Exception):
    def __init__(self, message: str, *, kind: str = 'provider-failure', target: Any = None,
                 retryable: bool = False, mutated: bool = False, usage: Any = None,
                 cost: Optional[dict] = None, status: Any = None, detail: Any = None,
                 attempts: Optional[list] = None):
        super().__init__(message)
        self.name = 'ProviderError'
        self.message = message
        self.kind = kind
        self.target = target
        self.retryable = bool(retryable)
        self.mutated = bool(mutated)
        self.usage = usage
        self.cost = cost if cost is not None else unreported_cost()
        self.status = status
        self.detail = detail
        self.attempts = attempts if attempts is not None else []

    def to_json(self) -> dict:
        return {'kind': self.kind, 'message': self.message, 'retryable': self.retryable,
                'mutated': self.mutated, 'usage': self.usage, 'cost': self.cost,
                'status': self.status, 'detail': self.detail, 'attempts': self.attempts}


def unreported_cost() -> dict:
    return {'mode': 'unreported', 'usd': None}


def capabilities(modes: Optional[List[str]] = None, modalities: Optional[List[str]] = None,
                 permissions: Optional[List[str]] = None, controls: Optional[List[str]] = None,
                 efforts: Optional[List[str]] = None, max_parallel: Optional[int] = None) -> dict:
    return {
        'modes': modes if modes is not None else ['structured'],
        'modalities': modalities if modalities is not None else ['text'],
        'permissions': permissions if permissions is not None else ['read'],
        'controls': controls if controls is not None else ['structured-output'],
        'efforts': efforts if efforts is not None else [],
        'maxParallel': max_parallel if max_parallel is not None else 1,
    }


def availability(status: str, version: Any = None, billing: str = 'unreported', detail: Any = None) -> dict:
    return {'status': status, 'version': version, 'billing': billing, 'detail': detail}


def target_spec(value: Optional[dict] = None) -> dict:
    value = value if value is not None else {}
    return {'provider': value.get('provider'), 'model': value.get('model'),
            'effort': value.get('effort'), 'fallback': nn(value.get('fallback'), [])}


def provider_request(operation: str, mode: str, role: Optional[str] = None, kind: Optional[str] = None,
                     tier: Optional[str] = None, modalities: Optional[List[str]] = None,
                     permissions: Optional[List[str]] = None, prompt: str = '', schema: Optional[dict] = None,
                     images: Optional[List[str]] = None, directory: Optional[str] = None,
                     target: Optional[dict] = None, limits: Optional[dict] = None,
                     metadata: Optional[dict] = None) -> dict:
    return {
        'operation': operation,
        'mode': mode,
        'role': role if role is not None else operation,
        'kind': kind,
        'tier': tier,
        'modalities': modalities if modalities is not None else ['text'],
        'permissions': permissions if permissions is not None else ['read'],
        'prompt': prompt,
        'schema': schema,
        'images': images if images is not None else [],
        'directory': directory,
        'target': target if target is not None else target_spec(),
        'limits': limits if limits is not None else {},
        'metadata': metadata if metadata is not None else {},
    }


class Provider:
    def __init__(self, id: str, caps: dict, discover: Callable[[], Awaitable[dict]],
                 run: Callable[[dict, dict], Awaitable[dict]], model_capabilities: Optional[dict] = None):
        self.id = id
        self.caps = caps
        self.discover = discover
        self.run = run
        self.model_capabilities = model_capabilities if model_capabilities is not None else {}


def model_capability_settings(value: Provider, model: Any) -> dict:
    settings = value.model_capabilities
    if settings is None:
        settings = {}
    if model is not None and is_object(settings) and own(settings, model):
        return settings[model]
    return {}


class ProviderRegistry:
    def __init__(self) -> None:
        self._order: List[str] = []
        self._by_id: Dict[str, Provider] = {}
        self._slots: Dict[str, asyncio.Semaphore] = {}

    def register(self, value: Provider) -> Provider:
        if value is None or not getattr(value, 'id', None):
            raise TypeError('a provider needs an id')
        if value.id not in self._by_id:
            self._order.append(value.id)
        self._by_id[value.id] = value
        self._slots.pop(value.id, None)
        return value

    def get(self, id: str, fallback: Any = None) -> Any:
        return self._by_id.get(id, fallback)

    def providers(self) -> List[Provider]:
        return [self._by_id[id] for id in self._order]

    def overlay(self, values: List[Provider], prepend: bool = False) -> ProviderRegistry:
        additions = [v for v in values if v.id not in self._by_id]
        next_registry = ProviderRegistry()
        addition_ids = [v.id for v in additions]
        ids = addition_ids + list(self._order) if prepend else list(self._order) + addition_ids
        by_addition = {v.id: v for v in additions}
        for id in ids:
            next_registry.register(self._by_id.get(id) or by_addition[id])
        return next_registry

    async def with_slot(self, value: Provider, thunk: Callable[[], Awaitable[Any]]) -> Any:
        slots = self._slots.get(value.id)
        if slots is None:
            limit = value.caps['maxParallel']
            if not isinstance(limit, int) or isinstance(limit, bool) or limit <= 0:
                raise TypeError(f'provider {value.id} max parallel must be a positive integer')
            slots = asyncio.Semaphore(limit)
            self._slots[value.id] = slots
        await slots.acquire()
        try:
            return await thunk()
        finally:
            slots.release()


LAYER_ORDER = ['default', 'user', 'project', 'package', 'environment', 'request']


class EnvironmentReader:
    def get(self, name: str) -> Optional[str]:
        return os.environ.get(name)


environment_reader = EnvironmentReader()


def user_config_path() -> str:
    xdg = environment_reader.get('XDG_CONFIG_HOME')
    base = xdg if xdg and xdg != '' else os.path.join(os.path.expanduser('~'), '.config')
    return os.path.join(base, 'jev', 'providers.json')


PROJECT_CONFIG_NAME = os.path.join('.jev', 'providers.json')


def _as_config(value: Any) -> dict:
    if value is None:
        return {}
    require_at(is_object(value), 'config', 'provider configuration must be a JSON object')
    return value


def _deep_merge(lower: dict, higher: dict) -> dict:
    result = dict(lower)
    for key, high in higher.items():
        low = result.get(key)
        result[key] = _deep_merge(low, high) if is_object(low) and is_object(high) else high
    return result


def _role_settings(pkg: dict, role: Optional[str]) -> dict:
    if not role:
        return {}
    agents = pkg.get('agents')
    if is_object(agents) and is_object(agents.get(role)):
        return agents[role]
    return {}


def merge_provider_config(defaults: Optional[dict] = None, user: Optional[dict] = None,
                          project: Optional[dict] = None, pkg: Optional[dict] = None,
                          environment: Optional[dict] = None, request: Optional[dict] = None,
                          role: Optional[str] = None) -> dict:
    raw = {'default': _as_config(defaults), 'user': _as_config(user), 'project': _as_config(project),
           'package': _as_config(pkg), 'environment': _as_config(environment), 'request': _as_config(request)}
    layers = [(name, _deep_merge(raw['package'], _role_settings(raw['package'], role)) if name == 'package' else raw[name])
              for name in LAYER_ORDER]
    merged: dict = {}
    for _, layer in layers:
        merged = _deep_merge(merged, layer)
    return {**merged, '_layers': list(reversed(layers)), '_role': role}


def config_layers(config: dict) -> List[List[Any]]:
    layers = config.get('_layers') if is_object(config) else None
    return layers if layers is not None else [['config', config]]


def _read_config(path: Optional[str]) -> dict:
    if not path or not os.path.exists(path):
        return {}
    with open(path, 'r', encoding='utf-8') as handle:
        value = json.load(handle)
    require_at(is_object(value), path, 'provider configuration must be a JSON object')
    return value


def _starting_directory(value: str) -> str:
    complete = os.path.abspath(value)
    if os.path.isdir(complete):
        return complete
    return os.path.dirname(complete)


def find_project_config(start: str) -> Optional[str]:
    directory = _starting_directory(start)
    while True:
        candidate = os.path.join(directory, PROJECT_CONFIG_NAME)
        if os.path.exists(candidate):
            return candidate
        if os.path.exists(os.path.join(directory, '.git')):
            return None
        parent = os.path.dirname(directory)
        if parent == directory:
            return None
        directory = parent


def _environment_config() -> dict:
    out = {}
    for name, key in (('JEV_PROVIDER', 'provider'), ('JEV_MODEL', 'model'), ('JEV_EFFORT', 'effort')):
        value = environment_reader.get(name)
        if value is not None and value != '':
            out[key] = value
    return out


def load_provider_config(start: Optional[str] = None, defaults: Optional[dict] = None,
                         pkg: Optional[dict] = None, request: Optional[dict] = None,
                         role: Optional[str] = None) -> dict:
    alternate = environment_reader.get('JEV_PROVIDER_CONFIG')
    if alternate and alternate != '':
        project_path = alternate if os.path.isabs(alternate) else os.path.abspath(alternate)
    else:
        project_path = find_project_config(start if start is not None else os.getcwd())
    return merge_provider_config(
        defaults=defaults, user=_read_config(user_config_path()), project=_read_config(project_path),
        pkg=pkg, environment=_environment_config(), request=request, role=role)


async def subprocess_runner(executable: str, args: List[str], options: Optional[dict] = None) -> dict:
    options = options if options is not None else {}
    stdin = options.get('stdin') or ''
    timeout_seconds = options.get('timeoutSeconds', 300)
    dir = options.get('dir')
    env = options.get('env')
    on_line = options.get('onLine')
    try:
        proc = await asyncio.create_subprocess_exec(
            executable, *args,
            cwd=dir if dir is not None else None,
            env=dict(env) if is_object(env) else None,
            start_new_session=True,
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    except OSError as error:
        raise error
    out_decoder = codecs.getincrementaldecoder('utf-8')('replace')
    err_decoder = codecs.getincrementaldecoder('utf-8')('replace')
    stdout: List[str] = []
    stderr: List[str] = []
    pending = ['']
    timed_out = False

    async def drain_input() -> None:
        if proc.stdin is None:
            return
        proc.stdin.write(stdin.encode('utf-8'))
        await proc.stdin.drain()
        proc.stdin.close()

    async def read_stdout() -> None:
        if proc.stdout is None:
            return
        while True:
            chunk = await proc.stdout.read(65536)
            if not chunk:
                break
            text = out_decoder.decode(chunk)
            stdout.append(text)
            if on_line is None:
                continue
            pending[0] += text
            lines = pending[0].split('\n')
            pending[0] = lines.pop()
            for line in lines:
                on_line(line)

    async def read_stderr() -> None:
        if proc.stderr is None:
            return
        while True:
            chunk = await proc.stderr.read(65536)
            if not chunk:
                break
            stderr.append(err_decoder.decode(chunk))

    async def pump() -> None:
        await asyncio.gather(drain_input(), read_stdout(), read_stderr())

    try:
        await asyncio.wait_for(pump(), timeout_seconds)
    except asyncio.TimeoutError:
        timed_out = True
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        except (ProcessLookupError, PermissionError, OSError):
            try:
                proc.kill()
            except ProcessLookupError:
                pass
    if timed_out:
        try:
            await asyncio.wait_for(proc.wait(), 5)
        except asyncio.TimeoutError:
            pass
    else:
        await proc.wait()
    for stream in (proc.stdin, proc.stdout, proc.stderr):
        if stream is not None:
            try:
                stream.close()
            except Exception:
                pass
    out_text = ''.join(stdout) + out_decoder.decode(b'', final=True)
    err_text = ''.join(stderr) + err_decoder.decode(b'', final=True)
    if timed_out:
        return {'status': None, 'stdout': out_text, 'stderr': f'{err_text}\ntimed out after {js_str(timeout_seconds)}s'}
    return {'status': proc.returncode, 'stdout': out_text, 'stderr': err_text}


class Runner:
    def __init__(self) -> None:
        self.run = subprocess_runner


runner = Runner()


def run_program(executable: str, args: List[str], options: Optional[dict] = None) -> Awaitable[dict]:
    return runner.run(executable, args, options if options is not None else {})


def _type_valid(type_value: Any, value: Any) -> bool:
    if isinstance(type_value, list):
        return any(_type_valid(one, value) for one in type_value)
    if type_value == 'object':
        return is_object(value)
    if type_value == 'array':
        return isinstance(value, list)
    if type_value == 'string':
        return isinstance(value, str)
    if type_value == 'number':
        return finite(value)
    if type_value == 'integer':
        return isinstance(value, (int, float)) and not isinstance(value, bool) and float(value).is_integer()
    if type_value == 'boolean':
        return isinstance(value, bool)
    if type_value == 'null':
        return value is None
    return True


def _json_equal(a: Any, b: Any) -> bool:
    return jsonify(a) == jsonify(b)


def _schema_valid(schema: dict, value: Any) -> bool:
    if not is_object(schema):
        return False
    if own(schema, 'type') and not _type_valid(schema['type'], value):
        return False
    if own(schema, 'const') and not _json_equal(value, schema['const']):
        return False
    if own(schema, 'enum') and not any(_json_equal(one, value) for one in schema['enum']):
        return False
    if any(not _schema_valid(sub, value) for sub in nn(schema.get('allOf'), [])):
        return False
    if len(nn(schema.get('anyOf'), [])) and not any(_schema_valid(sub, value) for sub in schema['anyOf']):
        return False
    one_of = nn(schema.get('oneOf'), [])
    if len(one_of) and len([sub for sub in one_of if _schema_valid(sub, value)]) != 1:
        return False
    if is_object(value):
        properties = nn(schema.get('properties'), {})
        if any(not own(value, key) for key in nn(schema.get('required'), [])):
            return False
        if any(own(value, key) and not _schema_valid(sub, value[key]) for key, sub in properties.items()):
            return False
        if schema.get('additionalProperties') is False and any(key not in properties for key in value):
            return False
    elif isinstance(value, list):
        items = schema.get('items')
        if items and any(not _schema_valid(items, item) for item in value):
            return False
        if own(schema, 'minItems') and len(value) < schema['minItems']:
            return False
        if own(schema, 'maxItems') and len(value) > schema['maxItems']:
            return False
    elif isinstance(value, str):
        if own(schema, 'minLength') and len(value) < schema['minLength']:
            return False
        if own(schema, 'maxLength') and len(value) > schema['maxLength']:
            return False
    elif isinstance(value, (int, float)) and not isinstance(value, bool):
        if own(schema, 'minimum') and value < schema['minimum']:
            return False
        if own(schema, 'maximum') and value > schema['maximum']:
            return False
    return True


def json_schema_valid(schema: Optional[dict], value: Any) -> bool:
    return not schema or _schema_valid(schema, value)


def validate_json_schema(schema: Optional[dict], value: Any) -> Any:
    if not json_schema_valid(schema, value):
        raise TypeError('value does not match JSON Schema')
    return value


MINIMUM_ENVIRONMENT = ['HOME', 'PATH']


def find_executable(name: str) -> Optional[str]:
    if '/' in name:
        return name if os.path.exists(name) else None
    path = nn(environment_reader.get('PATH'), '')
    for directory in path.split(os.pathsep):
        if directory == '':
            continue
        candidate = os.path.join(directory, name)
        if os.path.exists(candidate):
            return candidate
    return None


def _allowed_environment(names: List[str]) -> Dict[str, str]:
    out = {}
    for name in dict.fromkeys([*MINIMUM_ENVIRONMENT, *names]):
        value = environment_reader.get(name)
        if value is not None:
            out[name] = value
    return out


def _request_wire(request: dict, target: dict) -> dict:
    return {
        'protocol': 'jev-provider/1',
        'operation': request['operation'],
        'mode': request['mode'],
        'role': request['role'],
        'task': {'kind': nn(request.get('kind'), None), 'tier': nn(request.get('tier'), None)},
        'model': nn(target.get('model'), None),
        'effort': nn(target.get('effectiveEffort'), None),
        'prompt': request['prompt'],
        'schema': nn(request.get('schema'), None),
        'inputs': {'images': request['images']},
        'workspace': {'directory': request['directory'], 'permissions': request['permissions']} if request['directory'] else None,
        'limits': request['limits'],
        'metadata': request['metadata'],
    }


def _parse_json(text: str) -> Any:
    try:
        return json.loads(text)
    except (ValueError, TypeError):
        return None


def _parse_response(stdout: str) -> Any:
    whole = _parse_json(stdout)
    if is_object(whole):
        return whole
    results = []
    for line in stdout.split('\n'):
        stripped = line.strip()
        if stripped == '':
            continue
        event = _parse_json(stripped)
        if is_object(event) and event.get('type') == 'result':
            results.append(event)
    return results[-1] if results else None


def _response_usage(response: Any) -> dict:
    usage = response.get('usage') if is_object(response) else None
    return usage if is_object(usage) else {}


def _response_cost(response: Any) -> dict:
    value = response.get('cost') if is_object(response) else None
    if is_object(value):
        return {'mode': nn(value.get('mode'), 'unreported'), 'usd': value['usd'] if finite(value.get('usd')) else None}
    if finite(value):
        return {'mode': 'reported-usd', 'usd': value}
    return unreported_cost()


def _command_error(id: str, target: Any, kind: str, status: Any, response: Any,
                   retryable: Any = None, mutated: bool = False) -> ProviderError:
    message = (f'provider {id} timed out' if kind == 'timeout'
               else f'provider {id} returned invalid structured output' if kind == 'invalid-output'
               else f'provider {id} failed ({kind})')
    if retryable is None:
        retryable = kind in RETRYABLE_KINDS
    return ProviderError(message, kind=kind, target=target, retryable=bool(retryable), mutated=bool(mutated),
                         usage=_response_usage(response), cost=_response_cost(response), status=status, detail=message)


def command_provider(id: str, command: Any, caps: Optional[dict] = None,
                     environment: Optional[List[str]] = None,
                     timeout_seconds: float = 300) -> Provider:
    parts = [command] if isinstance(command, str) else command
    if not isinstance(parts, list) or len(parts) == 0 or not all(isinstance(x, str) for x in parts):
        raise TypeError('a command is an executable name or a non-empty list of strings')
    executable, args = parts[0], parts[1:]
    resolved_caps = caps if caps is not None else capabilities()

    async def discover() -> dict:
        path = find_executable(executable)
        return availability('ready', detail=path) if path else availability('missing', detail=f'{executable} is not on PATH')

    async def run(request: dict, target: dict) -> dict:
        limits = request.get('limits') or {}
        timeout = limits['timeout_seconds'] if own(limits, 'timeout_seconds') else timeout_seconds
        resolved = find_executable(executable) or executable
        outcome = await run_program(resolved, args, {
            'stdin': jsonify(_request_wire(request, target)),
            'timeoutSeconds': timeout,
            'dir': request.get('directory'),
            'env': _allowed_environment(environment or []),
        })
        status, stdout = outcome['status'], outcome['stdout']
        if status is None:
            raise _command_error(id, target, 'timeout', None, None)
        response = _parse_response(stdout)
        if status != 0:
            error = response.get('error') if is_object(response) else None
            error = error if is_object(error) else None
            kind = error.get('kind') if is_object(error) and isinstance(error.get('kind'), str) else 'provider-failure'
            raise _command_error(id, target, kind, status, response,
                                 retryable=(error.get('retryable') if error is not None and own(error, 'retryable') else None),
                                 mutated=nn(error.get('mutated'), False) if error is not None else False)
        if not response or not own(response, 'output'):
            raise _command_error(id, target, 'invalid-output', status, response)
        if not json_schema_valid(request.get('schema'), response['output']):
            raise _command_error(id, target, 'invalid-output', status, response)
        return {
            'output': response['output'],
            'target': target,
            'model': nn(response.get('model'), nn(target.get('model'), None)),
            'usage': _response_usage(response),
            'cost': _response_cost(response),
            'requestId': nn(response.get('provider_request_id'), None),
            'exitStatus': status,
            'changed': response['changed'] if isinstance(response.get('changed'), list) else [],
            'attempts': [],
        }

    return Provider(id, resolved_caps, discover, run)


_discovery_cache: 'weakref.WeakKeyDictionary[Provider, dict]' = weakref.WeakKeyDictionary()


def clear_provider_discovery_cache(registry: Optional[ProviderRegistry] = None) -> None:
    if not registry:
        return
    for value in registry.providers():
        try:
            _discovery_cache.pop(value, None)
        except TypeError:
            pass


async def _safe_discover(value: Provider) -> dict:
    try:
        result = await value.discover()
        return result if is_object(result) and isinstance(result.get('status'), str) \
            else availability('unavailable', detail='discovery returned an invalid value')
    except Exception as error:
        return availability('unavailable', detail=str(error))


async def _discover_one(value: Provider, refresh: bool) -> dict:
    # Only a ready provider is remembered: a key set or a login made after a
    # miss is seen on the next call.
    if refresh:
        try:
            _discovery_cache.pop(value, None)
        except TypeError:
            pass
    if value in _discovery_cache:
        return _discovery_cache[value]
    found = await _safe_discover(value)
    if found.get('status') == 'ready':
        _discovery_cache[value] = found
    return found


async def discover_providers(registry: ProviderRegistry, refresh: bool = False) -> List[dict]:
    return [{'provider': value, 'availability': await _discover_one(value, refresh)} for value in registry.providers()]


def _requires_tool_policy(request: dict) -> bool:
    disallowed = (request.get('metadata') or {}).get('disallowed')
    return isinstance(disallowed, list) and len(disallowed) > 0


def capable(caps: dict, request: dict) -> bool:
    return (request['mode'] in caps['modes']
            and all(m in caps['modalities'] for m in request['modalities'])
            and all(p in caps['permissions'] for p in request['permissions'])
            and (not request.get('schema') or 'structured-output' in caps['controls'])
            and all(c in caps['controls'] for c in (request.get('metadata') or {}).get('requiredControls', []))
            and (not _requires_tool_policy(request) or 'tool-policy' in caps['controls']))


ROUTE_FIELDS = ['operation', 'role', 'kind', 'tier']


def route_specificity(route: dict) -> int:
    when = route.get('when') or {}
    return len([f for f in ROUTE_FIELDS if f in when])


def _request_field(request: dict, field: str) -> Any:
    return request.get(field) if field in ROUTE_FIELDS else None


def _same_config_value(actual: Any, expected: Any) -> bool:
    return js_str(actual) == js_str(expected)


def _route_matches(route: dict, request: dict) -> bool:
    when = route.get('when') or {}
    for field, expected in when.items():
        actual = _request_field(request, field)
        values = expected if isinstance(expected, list) else [expected]
        if actual is None or not any(_same_config_value(actual, one) for one in values):
            return False
    return True


def _best_route_in_layer(layer: dict, request: dict) -> Optional[dict]:
    best, best_score = None, -1
    for route in nn(layer.get('routes'), []):
        score = route_specificity(route)
        if _route_matches(route, request) and score > best_score:
            best, best_score = route, score
    return best


def _select_route(config: dict, request: dict) -> Optional[dict]:
    for source, layer in config_layers(config):
        route = _best_route_in_layer(layer, request)
        if route:
            return {'source': source, 'value': route}
    return None


def matching_provider_route(config: dict, request: dict) -> Optional[dict]:
    selected = _select_route(config, request)
    return selected['value'] if selected else None


def _layer_field(config: dict, route: Optional[dict], fields: List[str]) -> Optional[dict]:
    for source, layer in config_layers(config):
        use = (nn(route['value'].get('use'), {}) if route is not None and source == route['source'] else None) if route is not None else None
        if use is not None:
            for field in fields:
                if own(use, field):
                    return {'value': use[field], 'source': f'{source}-route'}
        for field in fields:
            if own(layer, field):
                return {'value': layer[field], 'source': source}
    return None


def _key_ref(table: Any, key: Any, fallback: Any = None) -> Any:
    if is_object(table) and key is not None and own(table, js_str(key)):
        return table[js_str(key)]
    return fallback


def _provider_settings(config: dict, id: str) -> dict:
    return _key_ref(nn(config.get('providers'), {}), id, {})


def _provider_keyed(value: Any, id: str) -> Any:
    return _key_ref(value, id, None) if is_object(value) else value


def _is_auto(value: Any) -> bool:
    return isinstance(value, str) and value.lower() == 'auto'


def _normalize_fallback_target(value: Any) -> Any:
    if is_object(value):
        return {'provider': nn(value.get('provider'), 'auto'), 'model': nn(value.get('model'), None),
                'effort': nn(value.get('effort'), 'auto'), 'fallback': []}
    return value


def _field_source_layer(source: str) -> str:
    return source[:-len('-route')] if source.endswith('-route') else source


def _field_source_priority(config: dict, source: str) -> int:
    names = [name for name, _ in config_layers(config)]
    layer = _field_source_layer(source)
    return names.index(layer) if layer in names else -1


def _higher_precedence_field(config: dict, higher: Optional[dict], lower: Optional[dict]) -> bool:
    if not higher or not lower:
        return False
    h = _field_source_priority(config, higher['source'])
    lo = _field_source_priority(config, lower['source'])
    return h >= 0 and lo >= 0 and h < lo


def _candidate_order(request: dict, config: dict, route: Optional[dict], registry: ProviderRegistry) -> List[Any]:
    request_provider = nn(request['target'].get('provider'), None)
    target_provider = request_provider if request_provider and not _is_auto(request_provider) else None
    provider_field = _layer_field(config, route, ['provider'])
    preference_field = _layer_field(config, route, ['prefer', 'preferences'])
    configured = provider_field['value'] if not request_provider and provider_field else None
    exact = target_provider or (configured if configured and configured != 'auto'
                                 and not _higher_precedence_field(config, preference_field, provider_field) else None)
    preferences = (preference_field['value'] if isinstance(preference_field['value'], list) else [preference_field['value']]) if preference_field else []
    configured_fallback = _layer_field(config, route, ['fallback'])
    fallback_values = ([*(request['target'].get('fallback') or []),
                        *((configured_fallback['value'] if isinstance(configured_fallback['value'], list) else [configured_fallback['value']]) if configured_fallback else [])])
    fallback = [_normalize_fallback_target(v) for v in fallback_values]
    declared = [p.id for p in registry.providers()]
    if exact:
        order = [{**request['target'], 'provider': exact, 'fallback': []}, *fallback] if target_provider else [exact, *fallback]
    else:
        order = [*preferences, *fallback, *declared]
    seen = set()
    out = []
    for candidate in order:
        key = jsonify(candidate)
        if key not in seen:
            seen.add(key)
            out.append(candidate)
    return out


def _candidate_provider(candidate: Any) -> Any:
    return candidate.get('provider') if is_object(candidate) else candidate


def _candidate_request(request: dict, candidate: Any) -> dict:
    if is_object(candidate):
        return {**request, 'target': {**candidate, 'fallback': []}}
    return request


def _same_resolved_target(a: dict, b: dict) -> bool:
    return a['provider'].id == b['provider'].id and a.get('model') == b.get('model') \
        and a.get('effectiveEffort') == b.get('effectiveEffort')


def _candidate_excluded(candidate: Any, resolved: dict, excluded: List[dict]) -> bool:
    if is_object(candidate):
        return any(_same_resolved_target(resolved, prior) for prior in excluded)
    return any(candidate == prior['provider'].id for prior in excluded)


def _refine_capabilities(base: dict, settings: dict) -> dict:
    def pick(key: str, list_key: str):
        value = settings.get(list_key)
        return value if isinstance(value, list) else base[key]
    return {
        'modes': pick('modes', 'modes'),
        'modalities': pick('modalities', 'modalities'),
        'permissions': pick('permissions', 'permissions'),
        'controls': pick('controls', 'controls'),
        'efforts': pick('efforts', 'efforts'),
        'maxParallel': settings['max_parallel'] if 'max_parallel' in settings else base['maxParallel'],
    }


def _tier_setting(table: Any, tier: Any) -> Any:
    return _key_ref(table, tier, None) if tier else None


def _resolve_model(request: dict, config: dict, route: Optional[dict], id: str, settings: dict) -> Any:
    configured = _layer_field(config, route, ['model'])
    raw = (request['target'].get('model')
           if request['target'].get('model') is not None
           else (_provider_keyed(configured['value'], id) if configured else None))
    raw = raw if raw is not None else _tier_setting(nn(settings.get('models'), {}), request.get('tier'))
    raw = raw if raw is not None else nn(nn(settings.get('model'), settings.get('default_model')), None)
    return nn(raw.get('id'), None) if is_object(raw) else raw


def _resolve_effort(request: dict, config: dict, route: Optional[dict], id: str, settings: dict, model_settings: dict) -> tuple:
    requested = nn(request['target'].get('effort'), None)
    explicit = requested if requested and not _is_auto(requested) else None
    configured = _layer_field(config, route, ['effort'])
    configured_effort = _provider_keyed(configured['value'], id) if configured else None
    model_default = nn(model_settings.get('default_effort'), None)
    if explicit:
        return explicit, explicit
    if requested and _is_auto(requested):
        return 'auto', model_default
    if configured_effort and _is_auto(configured_effort):
        return 'auto', model_default
    if configured_effort:
        return configured_effort, configured_effort
    provider_default = _tier_setting(nn(settings.get('efforts'), {}), request.get('tier'))
    provider_default = nn(nn(provider_default, settings.get('effort')), None) if provider_default is None else provider_default
    provider_default = provider_default if provider_default is not None else nn(settings.get('default_effort'), None)
    if provider_default:
        return provider_default, provider_default
    return None, model_default


def _resolution_error(kind: str, target: Any, detail: Any, message: str) -> ProviderError:
    return ProviderError(message, kind=kind, target=target, detail=detail, cost=unreported_cost())


async def resolve_provider(request: dict, config: dict, registry: ProviderRegistry,
                           refresh: bool = False, exclude: Optional[List[dict]] = None, offline: bool = False) -> dict:
    excluded = exclude if exclude is not None else []
    route = _select_route(config, request)
    order = _candidate_order(request, config, route, registry)
    provider_field = _layer_field(config, route, ['provider'])
    request_provider = nn(request['target'].get('provider'), None)
    exact_request = request_provider if request_provider and not _is_auto(request_provider) else None
    exact = bool(exact_request or (not request_provider and provider_field and provider_field['value'] != 'auto'))
    # Only candidates are discovered, and only until one wins: discovering a CLI
    # provider starts processes, which an HTTP request should never wait on.
    rejections: List[dict] = []

    def reject(id: Any, kind: Any, detail: Any) -> None:
        rejections.append({'provider': id, 'kind': kind, 'detail': detail})

    winner = None
    for candidate in order:
        id = _candidate_provider(candidate)
        candidate_req = _candidate_request(request, candidate)
        settings = _provider_settings(config, id)
        if settings.get('enabled') is False:
            reject(id, 'disabled', 'disabled by configuration')
            continue
        value = registry.get(id)
        if value is None:
            reject(id, 'missing', 'provider is not registered')
            continue
        available = {'status': 'ready'} if offline else await _discover_one(value, refresh)
        if available['status'] != 'ready':
            reject(id, available['status'], available.get('detail'))
            continue
        model = _resolve_model(candidate_req, config, route, id, settings)
        model_settings = {**model_capability_settings(value, model),
                          **(_key_ref(nn(settings.get('model_capabilities'), {}), model, {}) if model else {})}
        caps = _refine_capabilities(value.caps, model_settings)
        requested_effort, effective_effort = _resolve_effort(candidate_req, config, route, id, settings, model_settings)
        if not capable(caps, candidate_req):
            reject(id, 'unsupported-capability', 'provider/model lacks a requested mode, modality, permission, or structured output')
            continue
        if effective_effort and effective_effort not in caps['efforts']:
            detail = f"effort {effective_effort} is unsupported; accepts: {', '.join(caps['efforts'])}"
            if exact or is_object(candidate):
                raise _resolution_error('configuration',
                                        {'provider': value, 'model': model, 'requestedEffort': requested_effort,
                                         'effectiveEffort': effective_effort, 'sources': {'provider': 'request'}},
                                        detail, f"provider {id} model {nn(model, '<default>')} {detail}")
            reject(id, 'unsupported-effort', detail)
            continue
        candidate_target = candidate_req['target']
        candidate_exact = candidate_target.get('provider') and not _is_auto(candidate_target.get('provider'))
        resolved = {
            'provider': value, 'model': model, 'requestedEffort': requested_effort, 'effectiveEffort': effective_effort,
            'sources': {
                'provider': 'request' if candidate_exact else ('config' if provider_field else 'preference'),
                'model': 'request' if candidate_target.get('model') else 'config',
                'effort': 'request' if candidate_target.get('effort') and not _is_auto(candidate_target.get('effort')) else 'config',
            },
        }
        if not _candidate_excluded(candidate, resolved, excluded):
            winner = resolved
            break
    if not winner:
        raise _resolution_error('unavailable' if exact else 'unsupported-capability', None, rejections,
                                f"no eligible provider for {request['operation']}/{request['mode']}")
    return {'target': winner, 'rejections': rejections, 'matchedRoute': route['value'] if route else None}


def _attempt_from_error(target: dict, error: ProviderError) -> dict:
    return {'target': target, 'outcome': error.kind, 'usage': error.usage, 'cost': error.cost,
            'requestId': None, 'diagnostic': error.detail}


def _success_attempt(result: dict) -> dict:
    return {'target': result['target'], 'outcome': 'success', 'usage': result['usage'], 'cost': result['cost'],
            'requestId': result['requestId'], 'diagnostic': None}


def _normalize_error(target: dict, error: Exception) -> ProviderError:
    if isinstance(error, ProviderError):
        return error
    return ProviderError(f"provider {target['provider'].id} failed",
                          kind='provider-failure', target=target, detail='provider raised an unexpected error')


def _fallback_error(last: Optional[ProviderError], attempts: List[dict]) -> ProviderError:
    last_target = last.target if last is not None else None
    return ProviderError('no eligible fallback provider remains', kind='unavailable', target=last_target,
                         usage=last.usage if last is not None else None,
                         cost=last.cost if last is not None else unreported_cost(),
                         status=last.status if last is not None else None,
                         detail=last.detail if last is not None else None, attempts=attempts)


def _semantic_error(result: dict, diagnostic: Any) -> ProviderError:
    return ProviderError('provider returned semantically invalid output', kind='invalid-output', target=result['target'],
                         retryable=True, usage=result['usage'], cost=result['cost'], status=result['exitStatus'],
                         detail=diagnostic)


async def run_provider_request(request: dict, config: dict, registry: ProviderRegistry,
                               validate: Optional[Callable[[Any], Any]] = None,
                               observe: Optional[Callable[[dict], None]] = None) -> dict:
    excluded: List[dict] = []
    attempts: List[dict] = []
    last_error: Optional[ProviderError] = None
    while True:
        try:
            resolution = await resolve_provider(request, config, registry, exclude=excluded)
        except ProviderError as error:
            if attempts:
                raise _fallback_error(last_error, attempts) from None
            raise
        target = resolution['target']
        try:
            result = await registry.with_slot(target['provider'], lambda: target['provider'].run(request, target))
            if observe is not None:
                observe(result)
            if validate is not None:
                diagnostic = None
                try:
                    diagnostic = validate(result['output'])
                except Exception as error:
                    diagnostic = str(error)
                if diagnostic:
                    raise _semantic_error(result, diagnostic)
            return {**result, 'attempts': [*attempts, *result['attempts'], _success_attempt(result)]}
        except Exception as raw:
            error = _normalize_error(target, raw)
            attempts.append(_attempt_from_error(target, error))
            if error.retryable and not error.mutated and request['mode'] != 'workspace':
                excluded.append(target)
                last_error = error
                continue
            error.attempts = [*attempts]
            raise error


def _configured_caps(value: dict) -> dict:
    def picked(key: str, default: List[str]) -> List[str]:
        setting = value.get(key)
        return setting if isinstance(setting, list) else default
    max_parallel = value.get('max_parallel')
    return capabilities(
        modes=picked('modes', ['structured']),
        modalities=picked('modalities', ['text']),
        permissions=picked('permissions', ['read']),
        controls=picked('controls', ['structured-output']),
        efforts=picked('efforts', []),
        max_parallel=max_parallel if isinstance(max_parallel, int) and not isinstance(max_parallel, bool) and max_parallel > 0 else 1)


def make_default_registry(config: Optional[dict] = None) -> ProviderRegistry:
    from ._provider_cli import claude_provider, codex_provider, fx_provider
    if config is None:
        config = load_provider_config()
    registry = ProviderRegistry()
    built_in = {'claude': (claude_provider, 'claude', 2), 'codex': (codex_provider, 'codex', 4), 'fx': (fx_provider, 'fx', 2)}
    providers = config.get('providers') if is_object(config.get('providers')) else {}
    for id, (make, default_command, default_parallel) in built_in.items():
        settings = providers.get(id) if is_object(providers.get(id)) else {}
        command = settings['command'] if own(settings, 'command') else default_command
        require_at(isinstance(command, str), f'providers.{id}.command', 'a built-in provider command must be a string')
        max_parallel = settings['max_parallel'] if own(settings, 'command') and own(settings, 'max_parallel') else (
            settings['max_parallel'] if own(settings, 'max_parallel') else default_parallel)
        require_at(isinstance(max_parallel, int) and not isinstance(max_parallel, bool) and max_parallel > 0,
                   f'providers.{id}.max_parallel', 'max_parallel must be a positive integer')
        registry.register(make(command=command, max_parallel=max_parallel))
    for id in sorted(providers):
        if id in built_in:
            continue
        settings = providers[id]
        if not is_object(settings) or not own(settings, 'command'):
            continue
        caps = settings.get('capabilities')
        environment = settings.get('environment')
        registry.register(command_provider(id, settings['command'],
                                           caps=_configured_caps(caps if is_object(caps) else {}),
                                           environment=environment if isinstance(environment, list) else [],
                                           timeout_seconds=settings['timeout_seconds'] if own(settings, 'timeout_seconds') else 300))
    return registry
