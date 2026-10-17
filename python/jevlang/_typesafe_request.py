"""Request preparation independent of HTTP and policy execution."""
import gzip
import uuid
from ._assets import inspect_assets, asset_manifest, validate_asset_references, MAX_REQUEST_BYTES, MAX_PORTABLE_BYTES
from ._budgets import check_request_budget
from ._common import require_at, keys_only, json_copy, is_object
from ._numberfmt import jsonify


def validate_jev_options(options, path='typesafe'):
    keys_only(options, ['assets', 'experimental', 'compression', 'assetTransport'], path)
    if 'assets' in options:
        validate_asset_references(options['assets'])
    if 'experimental' in options:
        keys_only(options['experimental'], ['images', 'longContext'], path + '.experimental')
        for key, value in options['experimental'].items():
            require_at(type(value) is bool, path + '.experimental.' + key, 'expected boolean')
    if 'compression' in options:
        require_at(options['compression'] is False or options['compression'] in ('auto', 'zstd', 'gzip'), path + '.compression', 'expected auto, zstd, gzip or false')
    if 'assetTransport' in options:
        require_at(options['assetTransport'] in ('json', 'multipart'), path + '.assetTransport', 'expected json or multipart')
    return options


def request_headers(options):
    import re
    headers = {'Accept': 'application/json'}
    extra = options.get('headers', {})
    require_at(is_object(extra), 'headers', 'expected header map')
    for name, value in extra.items():
        require_at(name.lower() not in ('authorization', 'content-type', 'content-length', 'content-encoding', 'host', 'transfer-encoding', 'connection') and not name.lower().startswith('typesafe-danger-zone-'), 'headers.' + name, 'cannot override protected request header')
        require_at(re.fullmatch(r"[!#$%&'*+.^_`|~0-9A-Za-z-]+", name) and isinstance(value, str) and '\r' not in value and '\n' not in value, 'headers.' + name, 'invalid HTTP header')
        headers[name] = value
    for option, name in [('images', 'TypeSafe-Danger-Zone-Images'), ('longContext', 'TypeSafe-Danger-Zone-Long-Context')]:
        if options.get('experimental', {}).get(option):
            headers[name] = 'true'
    return headers


def prepare_jev_request(state, questions, model, options=None, extra_body=None):
    options = options or {}
    validate_jev_options({k: options[k] for k in ('assets', 'experimental', 'compression', 'assetTransport') if k in options})
    payload = json_copy({'state': state, 'model': model, 'questions': questions}, max_bytes=MAX_REQUEST_BYTES)
    for key, value in (extra_body or {}).items():
        require_at(key not in ('state', 'model', 'questions', 'assets'), 'extraBody.' + key, f"extraBody cannot set '{key}'")
        payload[key] = json_copy(value)
    check_request_budget(state, questions, options)
    inspected = inspect_assets(options.get('assets', {}), state, questions)
    has_box = any(q.get('type') == 'box' for q in questions.values())
    require_at(not (inspected or has_box) or options.get('experimental', {}).get('images') is True, 'experimental.images', 'images and Box require experimental.images: true')
    require_at(not has_box or inspected, 'assets', 'Box questions require at least one image')
    require_at(not has_box or model != 'jev-1.13.0', 'model', 'Box requires Jev 1.14 or newer')
    if inspected:
        payload['assets'] = json_copy(options['assets'], max_bytes=MAX_PORTABLE_BYTES)
    return {'payload': payload, 'headers': request_headers(options), 'inspected': inspected, 'manifest': asset_manifest(inspected),
            'experimental': {k: options.get('experimental', {}).get(k) is True for k in ('images', 'longContext')}}


def _zstd_codec():
    # Optional runtime capability; Python 3.9 stays dependency-free.
    try:
        from compression import zstd
        return lambda data: zstd.compress(data, options={zstd.CompressionParameter.window_log: 23})
    except ImportError:
        return None


def encode_jev_request(prepared, options=None):
    options, headers = options or {}, dict(prepared['headers'])
    if prepared['inspected'] and options.get('assetTransport') != 'json':
        boundary = 'jev-' + uuid.uuid4().hex
        mapping = {ref: {'type': 'image', 'part': f'image-{i}'} for i, ref in enumerate(prepared['inspected'])}
        chunks = [f'--{boundary}\r\nContent-Disposition: form-data; name="request"; filename="blob"\r\nContent-Type: application/json\r\n\r\n'.encode(),
                  jsonify({**prepared['payload'], 'assets': mapping}).encode('utf-8'), b'\r\n']
        for ref, info in prepared['inspected'].items():
            part = mapping[ref]['part']
            mime = 'image/png' if info['format'] == 'png' else 'image/jpeg'
            chunks += [f'--{boundary}\r\nContent-Disposition: form-data; name="{part}"; filename="{part}.{info["format"]}"\r\nContent-Type: {mime}\r\n\r\n'.encode(), info['bytes'], b'\r\n']
        chunks.append(f'--{boundary}--\r\n'.encode())
        body = b''.join(chunks)
        headers['Content-Type'] = 'multipart/form-data; boundary=' + boundary
    else:
        body = jsonify(prepared['payload']).encode('utf-8')
        headers['Content-Type'] = 'application/json'
    require_at(len(body) <= MAX_REQUEST_BYTES, 'request', 'request body exceeds 32 MiB')
    mode = options.get('compression', 'auto')
    codec = _zstd_codec() if mode in ('auto', 'zstd') else None
    if mode == 'zstd':
        require_at(codec is not None, 'compression', 'zstd is unavailable on this Python runtime')
    encoding = ('zstd' if codec and len(body) >= 1024 else False) if mode == 'auto' else mode
    if encoding == 'gzip': body = gzip.compress(body, mtime=0)
    if encoding == 'zstd': body = codec(body)
    if encoding: headers['Content-Encoding'] = encoding
    require_at(len(body) <= MAX_REQUEST_BYTES, 'request', 'compressed request exceeds 32 MiB')
    return body, headers
