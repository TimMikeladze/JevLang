"""The runtime behind serving webhooks: signed events in, decisions recorded,
harvested, dispatched and shadowed.

The portable mirror of src/wiring.mjs. POST /webhook/<name> answers 404 (no
such source), 401 (bad signature, checked before the body is parsed), 400
(not JSON), 200 (the source's sync answer, or a duplicate/ignored delivery),
500 (the adapter threw) or 202 (written to queue/ first, then marked seen —
delivery is at least once). Workers take queue/ in arrival order, one event
per case at a time, so a case's outcome never overtakes its decision.

queue/ and failed/ hold the adapter's output until it is processed; keep the
spool private. The fixtures and the harvest store hold only the built,
redacted state. Raw bodies and headers are never written."""
from __future__ import annotations

import asyncio
import datetime
import hashlib
import json
import os
import time
from typing import Any, Dict, List, Optional

from ._common import equal, is_object, require_at
from ._dispatch import dispatch as run_dispatch
from ._dispatch import outcome_to_json
from ._harvest import harvest_add, harvest_dirs, harvest_outcome, harvest_settle, label_to_string, safe_case_name
from ._numberfmt import jsonify
from ._webhooks import is_case_event, is_outcome_event, verifier_problem


def _sha256_hex(text: str) -> str:
    return hashlib.sha256(text.encode('utf8')).hexdigest()


def _sha256_raw(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _iso(seconds: int) -> str:
    return datetime.datetime.fromtimestamp(seconds, datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def _first_line(s: Any) -> str:
    return str(s).replace('jev: ', '', 1).split('\n')[0]


def _pad(n: int, width: int) -> str:
    return str(n).rjust(width, '0')


_SEEN_TTL = 7 * 86400


def _brief(d: Any) -> dict:
    out = {'action': d.get('action')}
    if d.get('target'):
        out['target'] = d['target']
    return out


def jev_wiring(*, spool: str, sources: List[dict], dispatcher: Any = None, evaluate: Any,
               record_dir: Optional[str] = None, harvest: Optional[str] = None,
               settle_after_days: float = 7, shadow: Any = None, shadow_evaluate: Any = None,
               shadow_log: Optional[str] = None, dispatch_log: Optional[str] = None,
               workers: int = 2) -> dict:
    """A wiring: where the spool lives, which sources feed it, and what happens
    to a decided case."""
    require_at(isinstance(spool, str) and spool != '', 'spool', 'a wiring needs a spool directory')
    require_at(isinstance(sources, list) and len(sources) > 0, 'sources',
               'a wiring needs at least one source')
    names = [s['name'] for s in sources]
    require_at(len(set(names)) == len(names), 'sources', 'two sources have the same name')
    require_at(callable(evaluate), 'evaluate', 'a wiring needs an evaluate function for its policy')
    require_at(settle_after_days > 0, 'settleAfterDays', 'settleAfterDays is a positive number of days')
    require_at(isinstance(workers, int) and not isinstance(workers, bool) and workers > 0,
               'workers', 'workers is a positive integer')
    return {'spool': spool, 'sources': sources, 'dispatcher': dispatcher, 'evaluate': evaluate,
            'recordDir': record_dir, 'harvest': harvest, 'settleAfterDays': settle_after_days,
            'shadow': shadow, 'shadowEvaluate': shadow_evaluate, 'shadowLog': shadow_log,
            'dispatchLog': dispatch_log, 'workers': workers}


def wiring_problems(w: dict) -> List[str]:
    """Everything that stops a wiring from starting, as sentences. A source must
    be able to check signatures: no verifier, or one whose secret is missing,
    is refused rather than run unsigned."""
    out: List[str] = []
    for source in w['sources']:
        name, verify, insecure = source['name'], source.get('verify'), source.get('insecure')
        if not verify:
            out.append(f"source '{name}' has no verifier; every source checks a signature\n"
                       '    (verify: "none" with insecure: true accepts unsigned requests)')
        elif verify == 'none':
            if not insecure:
                out.append(f'source \'{name}\' has verify: "none", which also needs insecure: true')
        else:
            problem = verifier_problem(verify)
            if problem:
                out.append(f"source '{name}': {problem}\n"
                           '    refusing to start rather than accept unsigned webhooks')
    return out


def _write_private(path: str, text: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    temporary = f'{path}.{os.getpid()}.tmp'
    with open(temporary, 'w', encoding='utf8') as handle:
        handle.write(text)
        os.chmod(temporary, 0o600)
    os.replace(temporary, path)


def _event_to_json(ev: dict) -> dict:
    if is_case_event(ev):
        return {'kind': 'case', 'id': ev.get('id'), 'input': ev.get('input')}
    return {'kind': 'outcome', 'id': ev.get('id'), 'outcome': ev.get('outcomeKind'),
            'label': ev.get('label') if ev.get('label') is not None else None,
            'labels': ev.get('labels') if ev.get('labels') is not None else None}


async def start_wiring(w: dict, policy: Any, *, now: Any = None, log: Any = None,
                       start_workers: bool = True) -> dict:
    """-> the runtime: a route handler, the dispatcher, a summary, stats,
    drain, stop."""
    if now is None:
        now = lambda: int(time.time())  # noqa: E731
    problems = wiring_problems(w)
    require_at(not problems, 'wiring',
               "the wiring can't start:\n" + '\n'.join(f'  {s}' for s in problems))
    spool = os.path.realpath(w['spool'])
    queue_dir = os.path.join(spool, 'queue')
    seen_dir = os.path.join(spool, 'seen')
    failed_dir = os.path.join(spool, 'failed')
    for directory in (queue_dir, seen_dir, failed_dir):
        os.makedirs(directory, exist_ok=True)
    record_dir = os.path.realpath(w['recordDir']) if w['recordDir'] else None
    harvest_dir = os.path.realpath(w['harvest']) if w['harvest'] else None
    if record_dir:
        os.makedirs(record_dir, exist_ok=True)
    if harvest_dir:
        for directory in harvest_dirs(harvest_dir):
            os.makedirs(directory, exist_ok=True)
    shadow_log = os.path.realpath(w['shadowLog'] or os.path.join(spool, 'shadow.jsonl')) if w['shadow'] else None
    dispatch_log = os.path.realpath(w['dispatchLog'] or os.path.join(spool, 'dispatch.jsonl')) if w['dispatcher'] else None
    sources = {s['name']: s for s in w['sources']}
    settle_after = int(86400 * w['settleAfterDays'])
    stats: Dict[str, int] = {}

    def bump(key: str) -> None:
        stats[key] = stats.get(key, 0) + 1

    lines: List[str] = []

    def say(*parts: Any) -> None:
        line = ''.join(str(p) for p in parts)
        lines.append(line)
        if log is not None and hasattr(log, 'write'):
            log.write(f'{line}\n')

    writing: List[Optional[asyncio.Task]] = [None]

    async def append_jsonl(path: Optional[str], value: Any) -> None:
        if path is None:
            return

        async def append() -> None:
            try:
                os.makedirs(os.path.dirname(path), exist_ok=True)
                with open(path, 'a', encoding='utf8') as handle:
                    handle.write(jsonify(value) + '\n')
            except Exception:
                pass

        previous = writing[0]
        writing[0] = asyncio.ensure_future(_after(previous, append()))
        await writing[0]

    async def _after(previous: Optional[asyncio.Task], task: Any) -> None:
        if previous is not None:
            try:
                await previous
            except Exception:
                pass
        await task

    def queue_files() -> List[str]:
        return sorted(f for f in os.listdir(queue_dir) if f.endswith('.json')) \
            if os.path.exists(queue_dir) else []

    state: Dict[str, Any] = {'sequence': 0}

    def seen_path(name: str, id: str) -> str:
        return os.path.join(seen_dir, name, _sha256_hex(id))

    def error(status: int, message: str, kind: str) -> dict:
        return {'status': status, 'body': {'error': message, 'kind': kind}}

    # Accepting. One request at a time through the duplicate check and the
    # write, so a redelivery cannot slip past a marker being written.
    accepting: List[Optional[asyncio.Task]] = [None]

    async def accept(path: str, headers: Any, body: Any) -> dict:
        route = path.split('?')[0]
        name = route[len('/webhook/'):]
        source = sources.get(name)
        if not source:
            bump('not_found')
            return error(404, f'no webhook source {jsonify(name)}', 'not-found')
        text = body.decode('utf8') if isinstance(body, (bytes, bytearray)) else str(body)
        raw = body if isinstance(body, (bytes, bytearray)) else text.encode('utf8')
        ok, id, reason = True, _sha256_raw(raw), None
        if source.get('verify') != 'none':
            try:
                answer = await _maybe_await(source['verify'](headers, raw, now()))
                ok = answer.get('ok')
                reason = answer.get('reason') if answer.get('reason') is not None else None
                id = answer.get('deliveryId') or _sha256_raw(raw)
            except Exception as thrown:
                ok, reason = False, f'the verifier raised: {_first_line(thrown)}'
        if not ok:
            bump('rejected')
            say(f'webhook {name}: rejected (401): {reason}')
            return error(401, reason, 'signature')
        try:
            parsed = json.loads(text)
        except Exception:
            bump('rejected')
            return error(400, 'the body is not valid JSON', 'request')

        def adapter_failed(what: str, thrown: Any) -> dict:
            bump('adapter_errors')
            m = _first_line(thrown).replace('jev: ', '', 1)
            message = (f"the {what} adapter for source '{name}' "
                       + (m if m.startswith('returned') else f'raised: {m}'))
            say(f'webhook {name}: 500: {message}')
            return error(500, message, 'adapter')

        if source.get('sync'):
            try:
                answer = await _maybe_await(source['sync'](parsed, headers))
            except Exception as thrown:
                return adapter_failed('sync', thrown)
            if answer:
                return {'status': 200, 'body': answer}

        async def mine() -> dict:
            if os.path.exists(seen_path(name, id)):
                bump('duplicate')
                say(f'webhook {name}: duplicate delivery {id}, ignored')
                return {'status': 200, 'body': {'duplicate': True, 'id': id}}
            try:
                produced = await _maybe_await(source['event'](parsed, headers))
            except Exception as thrown:
                return adapter_failed('event', thrown)
            if produced is None or produced is False:
                events: Optional[List[dict]] = []
            elif is_case_event(produced) or is_outcome_event(produced):
                events = [produced]
            elif isinstance(produced, list) and all(is_case_event(e) or is_outcome_event(e) for e in produced):
                events = produced
            else:
                events = None
            if events is None:
                return adapter_failed('event', Exception(
                    'returned something that is not a case event, an outcome event, a list of them, or nothing'))
            if len(events) == 0:
                bump('ignored')
                return {'status': 200, 'body': {'ignored': True, 'id': id}}
            for ev in events:
                state['sequence'] += 1
                file = f'{_pad(int(time.time() * 1000), 15)}-{_pad(state["sequence"], 6)}-{name}.json'
                _write_private(os.path.join(queue_dir, file), jsonify({
                    'source': name, 'delivery_id': id, 'received_at': _iso(now()),
                    'event': _event_to_json(ev),
                }))
            os.makedirs(os.path.join(seen_dir, name), exist_ok=True)
            _write_private(seen_path(name, id), str(now()))
            bump('accepted')
            return {'status': 202, 'body': {'accepted': True, 'id': id, 'events': len(events)}}

        previous = accepting[0]

        async def guarded() -> dict:
            if previous is not None:
                await previous
            return await mine()

        task = asyncio.ensure_future(guarded())
        accepting[0] = asyncio.ensure_future(_swallow(task))
        return await task

    async def _swallow(task: Any) -> None:
        try:
            await task
        except Exception:
            pass

    async def _maybe_await(value: Any) -> Any:
        if asyncio.iscoroutine(value) or asyncio.isfuture(value):
            return await value
        return value

    # Processing.
    warned_shadow = [False]

    async def run_shadow(source: str, id: Any, input_value: Any, decided: dict) -> str:
        shadow_decision, mode, why = None, 'error', None
        try:
            pre = w['shadow'].precheck(input_value)
            if pre:
                shadow_decision, mode = pre, 'precheck'
            elif equal(w['shadow'].questions(w['shadow'].build_state(input_value)['state']),
                       decided.get('questions')):
                # The same questions, so the primary's answers are the shadow's too.
                shadow_decision = w['shadow'].decide(
                    decided['answers'], {'facts': w['shadow'].build_state(input_value)['facts']})
                mode = 'same-answers'
            elif w['shadowEvaluate']:
                shadow_decision = await _maybe_await(w['shadowEvaluate'](input_value))
                mode = 'evaluated'
            else:
                mode, why = 'skipped', 'the shadow asks different questions'
                if not warned_shadow[0]:
                    warned_shadow[0] = True
                    say('warning: the shadow policy asks different questions than the primary, '
                        "so it cannot reuse the primary's answers; shadow cases are skipped. "
                        'Pass shadowEvaluate to evaluate it separately (one more billed call per case).')
        except Exception as thrown:
            mode, why = 'error', _first_line(thrown)
        changed = (None if not shadow_decision
                   else not equal(_brief(decided['decision']), _brief(shadow_decision)))
        await append_jsonl(shadow_log, {
            'case_id': id, 'source': source, 'primary': _brief(decided['decision']),
            'shadow': _brief(shadow_decision) if shadow_decision else None,
            'changed': changed, 'mode': mode, 'reason': why, 'at': _iso(now())})
        if not shadow_decision:
            return f', shadow {mode}'
        return (f', shadow says {label_to_string(_brief(shadow_decision))}' if changed
                else ', shadow agrees')

    async def process_case(source: str, id: Any, input_value: Any) -> None:
        # evaluate returns what a real run leaves behind: the decision, the
        # answers, the questions it asked, and the fixture to record.
        decided = await _maybe_await(w['evaluate'](input_value))
        name = safe_case_name(id)
        recorded = None
        if record_dir and decided.get('fixture'):
            recorded = os.path.join(record_dir, f'{name}.json')
            _write_private(recorded, json.dumps(decided['fixture'], indent=2) + '\n')
        harvested = (await harvest_add(harvest_dir, case_id=id, fixture=decided['fixture'],
                                       decision=decided['decision'], source=source, now=now)
                     if harvest_dir and decided.get('fixture') else None)
        outcome = None
        if w['dispatcher']:
            st = decided.get('state') if decided.get('state') is not None else None
            outcome = await run_dispatch(w['dispatcher'], st, decided['decision'],
                                         key=f'{source}:{id}',
                                         facts=decided.get('facts') if decided.get('facts') is not None else None)
            await append_jsonl(dispatch_log, {**outcome_to_json(outcome), 'case_id': id,
                                              'source': source, 'at': _iso(now())})
        shadow_note = await run_shadow(source, id, input_value, decided) if w['shadow'] else ''
        bump('decided')
        say(f'webhook {source} {id}: {label_to_string(_brief(decided["decision"]))}',
            f', dispatched ({outcome["status"]})' if outcome else '',
            f', recorded {os.path.basename(recorded)}' if recorded else '',
            ('' if not harvest_dir else
             ', already settled in the harvest store' if harvested and harvested['status'] == 'settled'
             else ', pending' if harvested else ', not harvested (nothing to replay)'),
            shadow_note)

    async def process_outcome(source: str, ev: dict) -> None:
        id = ev.get('id')
        if not harvest_dir:
            say(f'webhook {source} {id}: {ev.get("outcome")} ignored (the wiring has no harvest store)')
            return
        r = await harvest_outcome(harvest_dir, id, ev['outcome'],
                                  label=ev.get('label') if is_object(ev.get('label')) else None,
                                  labels=ev.get('labels') if is_object(ev.get('labels')) else None,
                                  now=now)
        bump('outcomes')
        if r['status'] == 'unknown':
            say(f'webhook {source} {id}: {ev.get("outcome")} ignored: no decided case with this id')
        else:
            say(f'webhook {source} {id}: {ev.get("outcome")} -> {r["where"]}',
                f' ({label_to_string(r["label"])}, {r["strength"]})' if r.get('label') else '')

    async def fail_file(file: str, thrown: Any) -> None:
        bump('failed')
        src, dst = os.path.join(queue_dir, file), os.path.join(failed_dir, file)
        message = str(getattr(thrown, 'message', None) or thrown)
        parsed = None
        try:
            with open(src, encoding='utf8') as handle:
                parsed = json.load(handle)
        except Exception:
            parsed = None
        try:
            if is_object(parsed):
                _write_private(dst, json.dumps({**parsed, 'error': message,
                                                'failed_at': _iso(now())}, indent=2) + '\n')
                os.unlink(src)
            else:
                os.replace(src, dst)
                _write_private(f'{dst}.error', message)
        except Exception as moving:
            say(f'webhook: could not move {file} to failed/: {moving}')
        say(f"webhook {parsed.get('source', '?') if is_object(parsed) else '?'}: "
            f'failed, moved to failed/{file}: {_first_line(message)}')

    async def process_file(file: str) -> None:
        try:
            with open(os.path.join(queue_dir, file), encoding='utf8') as handle:
                parsed = json.load(handle)
            ev = parsed.get('event') if is_object(parsed) else None
            source = parsed.get('source', '?') if is_object(parsed) else '?'
            if is_object(ev) and ev.get('kind') == 'case':
                await process_case(source, ev.get('id'), ev.get('input'))
            elif is_object(ev) and ev.get('kind') == 'outcome':
                await process_outcome(source, ev)
            else:
                raise Exception(f'{file} is not a queued event')
            os.unlink(os.path.join(queue_dir, file))
        except Exception as thrown:
            await fail_file(file, thrown)

    async def case_key_of(file: str) -> str:
        try:
            with open(os.path.join(queue_dir, file), encoding='utf8') as handle:
                parsed = json.load(handle)
            return parsed['event'].get('id') or file
        except Exception:
            return file

    # Maintenance: forget old seen markers, and settle pending cases.
    last_maintained: List[Optional[int]] = [None]

    async def maintain() -> None:
        try:
            at = now()
            if os.path.exists(seen_dir):
                for name in os.listdir(seen_dir):
                    directory = os.path.join(seen_dir, name)
                    if not os.path.isdir(directory):
                        continue
                    for marker in os.listdir(directory):
                        path = os.path.join(directory, marker)
                        try:
                            with open(path, encoding='utf8') as handle:
                                wrote = int(handle.read().strip())
                        except Exception:
                            wrote = None
                        when = wrote if isinstance(wrote, int) else int(os.stat(path).st_mtime)
                        if at - when > _SEEN_TTL:
                            try:
                                os.unlink(path)
                            except OSError:
                                pass
            if harvest_dir:
                settled = await harvest_settle(harvest_dir, after=settle_after, now=now)
                if settled['settled']:
                    plural = '' if len(settled['settled']) == 1 else 's'
                    say(f'harvest: {len(settled["settled"])} pending case{plural} timed out '
                        f'after {w["settleAfterDays"]} days')
        except Exception as thrown:
            say(f'webhook: maintenance failed: {_first_line(thrown)}')

    # Scheduling: workers take the queue in arrival order, one event per case
    # at a time, so a case's outcome never overtakes its decision.
    running = [start_workers]
    pumping: List[Optional[asyncio.Task]] = [None]
    busy: set = set()
    in_flight: set = set()

    async def pump() -> None:
        while True:
            if last_maintained[0] is None or now() - last_maintained[0] >= 3600:
                await maintain()
                last_maintained[0] = now()
            files = queue_files()
            blocked: set = set()
            started = False
            for file in files:
                if file in in_flight or len(in_flight) >= w['workers']:
                    continue
                key = await case_key_of(file)
                if key in busy or key in blocked:
                    blocked.add(key)
                    continue
                busy.add(key)
                in_flight.add(file)
                started = True

                async def run(file=file, key=key) -> None:  # noqa: F811,E306
                    try:
                        await process_file(file)
                    finally:
                        busy.discard(key)
                        in_flight.discard(file)

                asyncio.ensure_future(run())
            if not started:
                return
            # Let the started work make progress before looking again.
            await asyncio.sleep(0)
            if not in_flight and not queue_files():
                return

    def wake() -> None:
        if not running[0]:
            return
        async def pumped() -> None:
            if pumping[0] is not None:
                await pumping[0]
            await pump()
        pumping[0] = asyncio.ensure_future(pumped())

    running[0] = start_workers
    # Anything left in the queue by a stop or a crash is processed on the next start.
    if start_workers:
        wake()

    summary = [
        f'spool {spool}',
        f"sources {', '.join(sources.keys())}",
        'dispatching decisions' if w['dispatcher'] else
        'no handlers: decisions are recorded, not dispatched',
        f'recording fixtures to {record_dir}' if record_dir else 'not recording fixtures',
        f'harvesting to {harvest_dir}, settling after {w["settleAfterDays"]} days'
        if harvest_dir else 'no harvest store',
        'running a shadow policy' if w['shadow'] else 'no shadow policy',
        f'{w["workers"]} worker{"" if w["workers"] == 1 else "s"}',
    ]

    async def drain() -> None:
        running[0] = True
        while True:
            await pump()
            if pumping[0] is not None:
                await pumping[0]
            while in_flight:
                await asyncio.sleep(0)
            if not queue_files():
                return

    async def stop() -> None:
        running[0] = False
        if pumping[0] is not None:
            await pumping[0]
        while in_flight:
            await asyncio.sleep(0)
        if writing[0] is not None:
            await writing[0]

    return {'routes': {'POST /webhook/:name': accept}, 'accept': accept,
            'dispatcher': w['dispatcher'], 'summary': summary, 'lines': lines, 'stats': stats,
            'drain': drain, 'stop': stop, 'maintain': maintain}
