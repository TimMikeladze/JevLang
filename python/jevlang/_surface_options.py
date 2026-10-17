"""Server operators enable features; remote callers supply portable data."""
import inspect
from ._common import require_at, is_object
from ._typesafe_request import validate_jev_options

ASSET_INPUT_SCHEMA = {'type': 'object', 'additionalProperties': {'type': 'object', 'properties': {'type': {'type': 'string', 'const': 'image'}, 'format': {'type': 'string', 'enum': ['png', 'jpg', 'jpeg']}, 'data_base64': {'type': 'string'}}, 'required': ['format', 'data_base64'], 'additionalProperties': False}}


def surface_options(policy, request, permissions=None):
    for key in ('headers', 'apiKey', 'baseUrl', 'model', 'provider', 'compression', 'typesafe'):
        require_at(key not in request, 'request.' + key, 'upstream controls are configured by the server operator', code='state')
    allowed = {**policy.policy.get('typesafe', {}).get('experimental', {}), **(permissions or {})}
    requested = request.get('experimental', {})
    validate_jev_options({'experimental': requested})
    for key, enabled in requested.items():
        require_at(not enabled or allowed.get(key) is True, 'experimental.' + key, 'experimental feature is disabled by the server operator', code='state')
    require_at('assets' not in request or allowed.get('images') is True, 'assets', 'image uploads are disabled by the server operator', code='state')
    result = {}
    if 'assets' in request:
        require_at(is_object(request['assets']), 'assets', 'expected asset map', code='state')
        result['assets'] = request['assets']
    if allowed or requested: result['experimental'] = {**allowed, **requested}
    return result


def invoke_evaluate(evaluate, value, options):
    # Keep legacy one-argument callbacks working for text-only servers.
    if not options: return evaluate(value)
    try:
        inspect.signature(evaluate).bind(value, options)
    except (TypeError, ValueError):
        require_at(False, 'evaluate', 'image/experimental requests need an evaluate(state, options) callback', code='state')
    return evaluate(value, options)
