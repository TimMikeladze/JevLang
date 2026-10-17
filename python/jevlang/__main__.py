"""The `jevlang` command: every command runs on the native Python engine."""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

from . import _call_native

NATIVE = {'validate', 'decide', 'state', 'schema', 'stats', 'calibrate', 'cost', 'replay', 'diff', 'tune',
          'evaluate', 'record', 'providers', 'gate', 'models', 'batch'}


def _json_file(path: str):
    return json.loads(Path(path).read_text())


def _fixture_files(directory: str) -> list:
    return [_json_file(str(p)) for p in sorted(Path(directory).glob('*.json'))]


def _gate(policy: dict, options: dict):
    from ._engine import CompiledPolicy
    from ._evaluate import evaluate_with_provider
    from ._gate import make_gate
    compiled = CompiledPolicy(policy)
    provider = options.get('provider')
    return make_gate(compiled,
                     evaluate=lambda state: evaluate_with_provider(compiled, state, provider=provider),
                     allow=options.get('allow') or [], deny=options.get('deny') or [],
                     on_error=options.get('onError') or 'ask', log=options.get('log') or None)


def _run_gate(argv: list) -> int:
    from ._gate import approve_once, hook_response
    if argv and argv[0] == 'approve-once':
        if len(argv) < 2:
            print('jevlang gate approve-once FINGERPRINT', file=sys.stderr)
            return 2
        print(json.dumps({'path': asyncio.run(approve_once(argv[1]))}, indent=2))
        return 0
    if not argv or argv[0] != 'hook':
        print("Unknown gate command. Run jevlang --help.", file=sys.stderr)
        return 2
    event = None
    try:
        event = json.loads(sys.stdin.read())
    except Exception:
        event = None
    policy = _json_file(argv[1])
    options = _json_file(argv[2]) if len(argv) > 2 else {}
    answer = asyncio.run(hook_response(event, lambda: _gate(policy, options),
                                       host=options.get('host') or 'auto',
                                       on_error=options.get('onError') or 'ask'))
    if answer is not None:
        print(json.dumps(answer))
    return 0


def main(argv=None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if not argv or argv[0] in ('help', '--help', '-h'):
        print((__doc__ or '').strip())
        print('jevlang validate POLICY.json\n'
              'jevlang decide POLICY.json ANSWERS.json [FACTS.json]\n'
              'jevlang state POLICY.json INPUT.json\n'
              'jevlang schema POLICY.json\n'
              'jevlang stats POLICY.json FIXTURE_DIR\n'
              'jevlang calibrate POLICY.json FIXTURE_DIR\n'
              'jevlang cost POLICY.json [INPUT.json] [FIXTURE_DIR]\n'
              'jevlang models                            (lists current Jev models)\n'
              'jevlang batch POLICY.json ROWS.json [OPTIONS.json]\n'
              'jevlang evaluate POLICY.json INPUT.json [OPTIONS.json]\n'
              'jevlang record POLICY.json INPUT.json [OPTIONS.json]\n'
              'jevlang providers\n'
              'jevlang gate hook POLICY.json [OPTIONS.json] < event.json   (calls the provider)\n'
              'jevlang gate approve-once FINGERPRINT\n'
              'jevlang replay POLICY.json FIXTURE_DIR\n'
              'jevlang diff BEFORE.json AFTER.json FIXTURE_DIR\n'
              'jevlang tune POLICY.json FIXTURE_DIR GRID.json')
        return 0
    command, rest = argv[0], argv[1:]
    if command == 'rpc':
        print("'rpc' was the shared Node engine's subprocess protocol, which is gone: the "
              'engine is native Python now (docs/python-port.md). Call the jevlang package '
              'from Python instead.',
              file=sys.stderr)
        return 2
    if command == 'gate':
        try:
            return _run_gate(rest)
        except Exception as error:
            print(f'{type(error).__name__}: {error}', file=sys.stderr)
            return 1
    if command not in NATIVE:
        print(f"Unknown command '{command}'. Run jevlang --help.", file=sys.stderr)
        return 2
    try:
        if command == 'models':
            from ._evaluate import list_models
            result = asyncio.run(list_models())
        elif command == 'batch':
            from . import Policy
            from ._batch import evaluate_many
            from ._evaluate import evaluate_with_provider
            policy = Policy.from_json(_json_file(rest[0]))
            rows = _json_file(rest[1])
            options = _json_file(rest[2]) if len(rest) > 2 else {}
            async def evaluate_row(row):
                return await evaluate_with_provider(policy, row, **options)
            result = asyncio.run(evaluate_many(evaluate_row, rows))
            result['results'] = [str(r) if isinstance(r, Exception) else r for r in result['results']]
        elif command == 'validate':
            result = _call_native('validate', _json_file(rest[0]))
        elif command == 'decide':
            policy = _json_file(rest[0])
            options = {'facts': _json_file(rest[2])} if len(rest) > 2 else {}
            result = _call_native('decide', policy, answers=_json_file(rest[1]), options=options)
        elif command == 'state':
            result = _call_native('state', _json_file(rest[0]), input=_json_file(rest[1]))
        elif command == 'schema':
            result = _call_native('schema', _json_file(rest[0]))
        elif command in ('stats', 'calibrate'):
            result = _call_native(command, _json_file(rest[0]), fixtures=_fixture_files(rest[1]))
        elif command == 'cost':
            options = {}
            if len(rest) > 1:
                options['input'] = _json_file(rest[1])
            if len(rest) > 2:
                options['fixtures'] = _fixture_files(rest[2])
            result = _call_native('cost', _json_file(rest[0]), options=options)
        elif command == 'replay':
            result = _call_native('replay', _json_file(rest[0]), fixtures=_fixture_files(rest[1]))
        elif command == 'diff':
            result = _call_native('diff', _json_file(rest[0]), after=_json_file(rest[1]),
                                  fixtures=_fixture_files(rest[2]))
        elif command == 'tune':
            result = _call_native('tune', _json_file(rest[0]), fixtures=_fixture_files(rest[1]),
                                  grid=_json_file(rest[2]))
        elif command == 'providers':
            from . import providers
            result = providers(**(_json_file(rest[0]) if rest else {}))
        elif command in ('evaluate', 'record'):
            result = _call_native(command, _json_file(rest[0]), input=_json_file(rest[1]),
                                  options=_json_file(rest[2]) if len(rest) > 2 else {})
        else:  # pragma: no cover - NATIVE is exhaustively handled above
            raise ValueError(command)
        print(json.dumps(result, indent=2))
        if command == 'replay' and any(row.get('status') in ('error', 'fail', 'stale') for row in result):
            return 1
        return 0
    except Exception as error:
        from . import JevError
        if isinstance(error, JevError):
            print(json.dumps({'code': error.code, 'message': str(error), 'fix': error.fix}), file=sys.stderr)
        else:
            print(f'{type(error).__name__}: {error}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
