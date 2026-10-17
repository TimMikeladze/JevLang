"""Fixture version 3, fingerprinted replay, diff and tuning."""
from __future__ import annotations

import re
from typing import Any

from ._common import require_at, is_object, own, text, equal, json_copy


def validate_fixture(raw: Any) -> dict:
    from ._assets import MAX_PORTABLE_BYTES, validate_asset_references
    from ._typesafe_request import validate_jev_options
    f = json_copy(raw, max_bytes=MAX_PORTABLE_BYTES if is_object(raw) and raw.get('fixture_version') == 4 else 2 * 1024 * 1024)
    require_at(is_object(f) and f.get('fixture_version') in (3, 4), 'fixture.fixture_version',
               'unsupported fixture version', 'Migrate to fixture_version 3 with provider/model/effort provenance.')
    if f['fixture_version'] == 4:
        require_at(is_object(f.get('assets')) and is_object(f.get('experimental')), 'fixture.assets', 'asset-aware fixture needs asset manifest and experimental settings')
        validate_jev_options({'experimental': f['experimental']})
        validate_asset_references(f['assets'])
        for ref, a in f['assets'].items():
            require_at(is_object(a) and a.get('format') in ('png', 'jpg', 'jpeg') and isinstance(a.get('sha256'), str) and re.fullmatch('[a-f0-9]{64}', a['sha256']) and all(type(a.get(k)) is int and 280 <= a[k] <= 1568 for k in ('width', 'height')) and type(a.get('occurrences')) is int and a['occurrences'] > 0, 'fixture.assets.' + ref, 'invalid image manifest')
    require_at(text(f.get('provider')), 'fixture.provider', 'fixture needs a non-empty provider')
    for key in ('requested_model', 'model', 'requested_effort', 'effective_effort'):
        require_at(own(f, key) and (f[key] is None or isinstance(f[key], str)), f'fixture.{key}',
                   'required provenance must be a string or null')
    require_at(is_object(f.get('answers')), 'fixture.answers', 'fixture needs an answers object')
    for key in ('expect', 'label', 'labels', 'facts', 'questions', 'usage'):
        if f.get(key) is not None:
            require_at(is_object(f[key]), f'fixture.{key}', 'expected an object')
    if f.get('questions_sha256') is not None:
        require_at(isinstance(f['questions_sha256'], str) and re.fullmatch(r'[a-fA-F0-9]{64}', f['questions_sha256']) is not None,
                   'fixture.questions_sha256', 'expected a SHA-256 fingerprint')
    return f


def matches(expected, actual) -> bool:
    """Deep partial matching includes action parameters, confirmation and ordered plans."""
    if isinstance(expected, list):
        return (isinstance(actual, list) and len(expected) == len(actual)
                and all(matches(x, actual[i]) for i, x in enumerate(expected)))
    if is_object(expected):
        return is_object(actual) and all(
            (True if k == 'action' and v is None else own(actual, k) and matches(v, actual[k]))
            for k, v in expected.items())
    return equal(expected, actual)


def replay(policy, fixtures, options=None) -> list:
    options = options or {}
    rows = []
    for index, raw in enumerate(fixtures):
        name = raw.get('name') if is_object(raw) else None
        name = name if name is not None else str(index)
        try:
            f = validate_fixture(raw)
            facts = f.get('facts') or (f.get('state') if is_object(f.get('state')) else {})
            # A fixture that recorded the questions it sent is checked against them
            # exactly; otherwise its hash is checked against the policy's identity.
            current = policy.identity()
            recorded = f.get('questions') if is_object(f.get('questions')) else None
            if recorded is not None:
                stale = not equal(recorded, policy.questions(f.get('state') or facts))
            else:
                stale = (f.get('questions_sha256') is not None
                         and f['questions_sha256'].lower() != current)
            stale = stale or (f['fixture_version'] == 4 and f.get('questions_sha256') is not None and f['questions_sha256'].lower() != current)
            if stale and not options.get('allowStale'):
                rows.append({'name': name, 'status': 'stale',
                             'message': 'Questions changed; re-record this fixture or explicitly allow stale answers.',
                             'fingerprint': current})
                continue
            assets_verified = False
            if f['fixture_version'] == 4 and ('assets' in options or 'asset_data' in f):
                from ._assets import inspect_assets, inspect_image, asset_manifest
                static = policy.policy.get('typesafe', {}).get('assets', {})
                supplied = options['assets'] if 'assets' in options else f['asset_data']
                require_at(is_object(supplied), 'assets', 'expected asset map')
                for ref in supplied:
                    if ref in static:
                        require_at(inspect_image(supplied[ref])['sha256'] == inspect_image(static[ref])['sha256'], 'fixture.assets.' + ref, 'image contents differ from the static policy asset')
                actual = asset_manifest(inspect_assets({**static, **supplied}, f.get('state'), recorded if recorded is not None else policy.questions(f.get('state'))))
                require_at(equal(actual, f['assets']), 'fixture.assets', 'image contents or reference placements differ from recorded assets')
                assets_verified = True
            decision = policy.decide(f['answers'], {**options, 'facts': facts, 'state': f.get('state') or facts})
            if f.get('expect'):
                status = 'pass' if matches(f['expect'], decision) else 'fail'
            else:
                status = 'unasserted'
            rows.append({'name': name, 'status': status, 'stale': stale,
                         **({'decisionVerified': (recorded is not None or f.get('questions_sha256') is not None) and not stale, 'assetsVerified': assets_verified} if f['fixture_version'] == 4 else {}),
                         'fingerprintVerified': (recorded is not None or f.get('questions_sha256') is not None) and not stale,
                         'verifiedBy': 'questions' if recorded is not None else ('identity' if f.get('questions_sha256') is not None else None),
                         'synthetic': f.get('synthetic') is True, 'decision': decision})
        except Exception as error:
            rows.append({'name': name, 'status': 'error', 'message': str(error)})
    return rows


def _behavioral(d):
    if not d:
        return None
    return {'action': d.get('action'), 'target': d.get('target'), 'data': d.get('data'),
            'proposed': _behavioral(d.get('proposed')),
            'steps': [_behavioral(x) for x in d.get('steps', [])]}


def diff(before, after, fixtures, options=None) -> list:
    a = replay(before, fixtures, options or {})
    b = replay(after, fixtures, options or {})
    return [{'name': row['name'],
             'changed': (not equal(_behavioral(row['decision']), _behavioral(b[i]['decision']))
                         if row.get('decision') and b[i].get('decision') else None),
             'before': row, 'after': b[i]}
            for i, row in enumerate(a)]


def tune(policy, fixtures, grid) -> dict:
    require_at(is_object(grid), 'grid', 'tuning grid must be an object')
    cases = [validate_fixture(f) for f in fixtures if is_object(f) and f.get('label') is not None]
    cases = [f for f in cases if f.get('label')]
    require_at(len(cases) > 0, 'fixtures', 'tuning needs human-label fields')
    configurations: list[dict] = [{}]
    for key, values in grid.items():
        require_at(isinstance(values, list) and len(values) > 0 and len(configurations) * len(values) <= 10000,
                   f'grid.{key}', 'grid needs non-empty values and at most 10,000 combinations')
        configurations = [{**c, key: value} for c in configurations for value in values]
    results = []
    for overrides in configurations:
        correct = 0
        for f in cases:
            d = policy.decide(f['answers'], {'facts': f.get('facts') or (f.get('state') if is_object(f.get('state')) else {}),
                                             'state': f.get('state'), 'overrides': overrides})
            if matches(f['label'], d):
                correct += 1
        results.append({'overrides': overrides, 'correct': correct, 'total': len(cases),
                        'accuracy': correct / len(cases)})
    results.sort(key=lambda r: -r['correct'])
    warnings = []
    if len(cases) < 200:
        warnings.append('Fewer than 200 labels; results are exploratory.')
    if any(f.get('synthetic') for f in cases):
        warnings.append('Includes synthetic fixtures; this does not measure real model quality.')
    return {'warnings': warnings, 'results': results}
