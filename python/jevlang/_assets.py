"""Portable image assets and unambiguous cross-language content identity."""
from __future__ import annotations
import base64
import binascii
import hashlib
import struct
from ._common import is_object, require_at, keys_only
from ._numberfmt import jsonify

MAX_REQUEST_BYTES = 32 * 1024 * 1024
MAX_PORTABLE_BYTES = 48 * 1024 * 1024
MAX_IMAGE_BYTES = 16 * 1024 * 1024


def validate_asset_references(assets=None):
    assets = {} if assets is None else assets
    require_at(is_object(assets), 'assets', 'assets must be an object')
    total = 0
    for ref in assets:
        require_at(isinstance(ref, str), 'assets', 'asset reference must be a string')
        count = len(ref.encode('utf-8'))
        total += count
        require_at(ref.strip() and count <= 1024, 'assets', 'asset reference must be nonblank and at most 1,024 UTF-8 bytes')
    require_at(total <= 65536, 'assets', 'asset references exceed 65,536 UTF-8 bytes')
    return list(assets)


def _geometry(data, format, path):
    if format == 'png':
        require_at(len(data) >= 33 and data[:8] == b'\x89PNG\r\n\x1a\n' and data[12:16] == b'IHDR' and int.from_bytes(data[8:12], 'big') == 13, path, 'invalid PNG image header')
        width, height = struct.unpack('>II', data[16:24])
        at, ended, pixels = 8, False, False
        while at + 12 <= len(data):
            size, kind = int.from_bytes(data[at:at + 4], 'big'), data[at + 4:at + 8]
            require_at(at + 12 + size <= len(data), path, 'incomplete PNG image')
            require_at(kind != b'acTL', path, 'animated PNG images are unsupported')
            pixels = pixels or kind == b'IDAT'
            if kind == b'IEND':
                ended = True
                break
            at += size + 12
        require_at(ended and pixels, path, 'incomplete PNG image')
    else:
        require_at(len(data) > 4 and data[:2] == b'\xff\xd8', path, 'invalid JPEG image header')
        at, ended, scan_bytes, width, height = 2, False, 0, None, None
        while at < len(data):
            require_at(data[at] == 255, path, 'invalid JPEG marker')
            while at < len(data) and data[at] == 255:
                at += 1
            require_at(at < len(data), path, 'incomplete JPEG image')
            marker, at = data[at], at + 1
            if marker == 0xd9:
                ended = True
                break
            require_at(marker not in (0, 0xd8), path, 'invalid JPEG marker')
            if marker == 1 or 0xd0 <= marker <= 0xd7:
                continue
            require_at(at + 2 <= len(data), path, 'incomplete JPEG image')
            size = int.from_bytes(data[at:at + 2], 'big')
            require_at(size >= 2 and at + size <= len(data), path, 'incomplete JPEG segment')
            if marker in (0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf):
                require_at(size >= 11 and data[at + 7] > 0 and size == 8 + 3 * data[at + 7], path, 'invalid JPEG frame component structure')
                height, width = struct.unpack('>HH', data[at + 3:at + 7])
            if marker == 0xda:
                require_at(size >= 8 and data[at + 2] > 0 and size == 6 + 2 * data[at + 2], path, 'invalid JPEG scan header')
                at += size
                while at < len(data):
                    if data[at] != 255:
                        scan_bytes, at = scan_bytes + 1, at + 1
                        continue
                    require_at(at + 1 < len(data), path, 'incomplete JPEG image')
                    next_byte = data[at + 1]
                    if next_byte == 0:
                        scan_bytes, at = scan_bytes + 1, at + 2
                    elif 0xd0 <= next_byte <= 0xd7:
                        at += 2
                    elif next_byte == 255:
                        at += 1
                    else:
                        break
            else:
                at += size
        require_at(ended and scan_bytes > 0, path, 'incomplete JPEG image: missing scan data or end marker')
        require_at(width and height, path, 'JPEG image has no dimensions')
    require_at(280 <= width <= 1568 and 280 <= height <= 1568, path, 'image dimensions must each be 280 to 1568 pixels')
    return {'width': width, 'height': height}


def inspect_image(asset, path='image'):
    keys_only(asset, ['type', 'format', 'data_base64'], path)
    require_at(asset.get('type', 'image') == 'image', path, 'asset type must be image')
    format, encoded = asset.get('format'), asset.get('data_base64')
    require_at(format in ('png', 'jpg', 'jpeg'), path + '.format', 'image format must be png, jpg or jpeg')
    require_at(isinstance(encoded, str) and 0 < len(encoded) <= ((MAX_IMAGE_BYTES + 2) // 3) * 4 and len(encoded) % 4 == 0, path + '.data_base64', 'expected standard padded base64; image limit is 16 MiB')
    try:
        data = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error):
        require_at(False, path + '.data_base64', 'invalid base64 without whitespace or a data URL prefix')
    require_at(len(data) <= MAX_IMAGE_BYTES and base64.b64encode(data).decode('ascii') == encoded, path, 'invalid base64 or image exceeds 16 MiB')
    return {'format': 'jpg' if format == 'jpeg' else format, 'bytes': data, 'sha256': hashlib.sha256(data).hexdigest(), **_geometry(data, format, path)}


def image_asset(data, *, format):
    require_at(isinstance(data, (bytes, bytearray, memoryview)), 'image', 'expected image bytes')
    asset = {'type': 'image', 'format': format, 'data_base64': base64.b64encode(data).decode('ascii')}
    inspect_image(asset)
    return asset


def _segments(text, refs):
    if text in refs:
        return [(True, text)]
    parts, at = [], 0
    while at < len(text):
        found, pos = None, len(text)
        for ref in refs:
            start = text.find(ref, at)
            if start >= 0 and (start < pos or start == pos and len(ref) > len(found or '')):
                found, pos = ref, start
        if found is None:
            parts.append((False, text[at:]))
            break
        if pos > at:
            parts.append((False, text[at:pos]))
        parts.append((True, found))
        at = pos + len(found)
    return parts


def replace_references(value, references, replace):
    refs = validate_asset_references(references)
    def walk(item):
        if isinstance(item, str):
            return ''.join(replace(text) if image else text for image, text in _segments(item, refs))
        if isinstance(item, list):
            return [walk(v) for v in item]
        if isinstance(item, dict):
            return {k: walk(v) for k, v in item.items()}
        return item
    return walk(value)


def inspect_assets(assets, state, questions):
    validate_asset_references(assets)
    inspected = {ref: {**inspect_image(asset, 'assets.' + ref), 'occurrences': 0} for ref, asset in assets.items()}
    require_at(sum(len(info['bytes']) for info in inspected.values()) <= MAX_REQUEST_BYTES, 'assets', 'image uploads exceed 32 MiB')
    content = {id: {k: q[k] for k in ('instructions', 'criteria') if k in q} for id, q in questions.items()}
    def count(ref):
        inspected[ref]['occurrences'] += 1
        return ref
    replace_references({'state': state, 'questions': content}, inspected, count)
    expanded = len(jsonify({'state': state, 'questions': questions}).encode('utf-8'))
    for ref, info in inspected.items():
        require_at(info['occurrences'] > 0, 'assets.' + ref, 'asset is unused; every asset must be referenced in state, instructions or criteria')
        expanded += info['occurrences'] * (len(info['bytes']) - len(ref.encode('utf-8')))
    require_at(expanded <= MAX_REQUEST_BYTES, 'assets', 'expanded image request exceeds 32 MiB before server image processing')
    return inspected


def asset_manifest(inspected):
    return {ref: {k: info[k] for k in ('format', 'width', 'height', 'sha256', 'occurrences')} for ref, info in inspected.items()}


def asset_identity(state, questions, inspected):
    refs = validate_asset_references(inspected)
    def normalize(value, images=True):
        if isinstance(value, str):
            if not images or not refs:
                return ['string', value]
            return ['content', [['image', inspected[s]['sha256']] if image else ['text', s] for image, s in _segments(value, refs)]]
        if isinstance(value, list):
            return ['array', [normalize(v, images) for v in value]]
        if isinstance(value, dict):
            return ['object', [[k, normalize(value[k], images)] for k in sorted(value, key=lambda key: key.encode('utf-16-be', errors='surrogatepass'))]]
        return ['scalar', value]
    return {'state': normalize(state), 'questions': {id: {k: normalize(v, k in ('instructions', 'criteria')) for k, v in q.items()} for id, q in questions.items()}, 'images': sorted({a['sha256'] for a in inspected.values()})}


def merge_assets(*maps):
    result = {}
    for mapping in maps:
        mapping = {} if mapping is None else mapping
        validate_asset_references(mapping)
        for ref, asset in mapping.items():
            require_at(ref not in result, 'assets.' + ref, 'duplicate static/runtime asset reference')
            result[ref] = asset
    return result
