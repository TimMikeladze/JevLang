"""Running continuously: events in, decisions dispatched.

Ported from src/loop.mjs::

    l = make_loop(evaluate=ev, dispatcher=d,
                  sources=[timer_source(60, read_sensors, key='sensors')],
                  debounce=0.5, max_age=30)
    loop_start(l)
    loop_post(l, make_event('turn off the lights', key='living-room', principal=['owner']))
    await loop_stop(l)

- Events with the same key are handled one at a time, in order. With a
  debounce, a burst of events for one key collapses to its latest.
- An event older than max_age when its turn comes is not evaluated; its result
  is 'stale'. The world it described has moved on.
- Different keys run in parallel, up to workers.
- Every result goes to on_outcome as (event, result), where result is an
  outcome, 'stale', or the error the evaluation or dispatch raised. One
  event's failure never stops the loop.

The dispatcher seam (resolve, run_due) is imported lazily from
``jevlang._dispatch`` so this module loads before that slice lands.
"""
from __future__ import annotations

import asyncio
import inspect
import json
import time
from typing import Any, Awaitable, Callable, Iterable, Optional, Union

from ._common import finite, require_at

Event = dict
Evaluate = Callable[[Any], Any]
OnOutcome = Callable[[Event, Any], Any]
Source = Callable[[Callable[[Event], None]], Callable[[], Any]]


def _dispatch_module() -> Any:
    from . import _dispatch
    return _dispatch


def make_event(input: Any, key: Any = None, principal: Any = None, id: Any = None,
               at: Optional[float] = None) -> Event:
    """input: what the policy's evaluate takes.

    key: events with the same key are serialized and debounced. principal:
    who is asking, from the caller, never from the model. id: the event's own
    id (a webhook delivery id, say); it becomes the dispatch key, so a
    redelivered event is not run again. at: when it happened, on the loop's
    clock.
    """
    return {'input': input, 'key': key, 'principal': principal, 'id': id,
            'at': time.time() * 1000 if at is None else at}


class Loop:
    def __init__(self, evaluate: Evaluate, dispatcher: Any, sources: Iterable[Source],
                 debounce: float, max_age: Optional[float], workers: int,
                 on_outcome: Optional[OnOutcome], clock: Callable[[], float],
                 run_due_every: Optional[float]) -> None:
        self.evaluate = evaluate
        self.dispatcher = dispatcher
        self.sources = list(sources)
        self.debounce = debounce
        self.max_age = max_age
        self.workers = workers
        self.on_outcome = on_outcome
        self.clock = clock
        self.run_due_every = run_due_every
        self.running = False
        self.pending: dict = {}
        self.waiting: dict = {}
        self.busy: set = set()
        self.ready_queue: list = []
        self.in_flight = 0
        self.timer: Optional[asyncio.TimerHandle] = None
        self.due_timer: Optional[asyncio.Task] = None
        self.stops: list = []
        self.counter = 0
        self.settled: list = []


def make_loop(evaluate: Evaluate, dispatcher: Any, sources: Iterable[Source] = (),
              debounce: float = 0, max_age: Optional[float] = None, workers: int = 4,
              on_outcome: Optional[OnOutcome] = None, clock: Optional[Callable[[], float]] = None,
              run_due_every: Optional[float] = None) -> Loop:
    require_at(callable(evaluate), 'evaluate', 'a loop needs an evaluate function')
    require_at(dispatcher is not None and callable(getattr(dispatcher, 'targets', None)),
               'dispatcher', 'a loop needs a dispatcher')
    require_at(finite(debounce) and debounce >= 0, 'debounce', 'debounce is seconds, at least 0')
    require_at(max_age is None or (finite(max_age) and max_age > 0),
               'maxAge', 'maxAge is positive seconds, or null')
    require_at(isinstance(workers, int) and not isinstance(workers, bool) and workers > 0,
               'workers', 'workers must be a positive integer')
    return Loop(evaluate, dispatcher, sources, debounce, max_age, workers, on_outcome,
                clock if clock is not None else (lambda: time.time() * 1000), run_due_every)


# Handle one event now: an outcome, 'stale', or the error it raised.
async def _handle(l: Loop, event: Event) -> Any:
    if l.max_age is not None and l.clock() - event['at'] > 1000 * l.max_age:
        return 'stale'
    try:
        return await _dispatch_module().resolve(l.evaluate, l.dispatcher, event['input'],
                                                principal=event['principal'],
                                                key=None if event['id'] is None else str(event['id']))
    except Exception as error:
        return error


def _start(l: Loop, key: Any, event: Event) -> asyncio.Task:
    l.busy.add(key)
    l.in_flight += 1

    async def finished() -> None:
        # The bookkeeping runs in finally, so a cancelled worker cannot wedge
        # its key, lose count of what is in flight, or swallow the next event.
        try:
            result = await _handle(l, event)
            outcome = l.on_outcome
            if outcome is not None:
                reported = outcome(event, result)
                if inspect.isawaitable(reported):
                    await reported
        except Exception:
            pass  # one event's failure never stops the loop
        finally:
            l.in_flight -= 1
            l.busy.discard(key)
            queue = l.waiting.get(key) or []
            if queue:
                if len(queue) == 1:
                    l.waiting.pop(key, None)
                else:
                    l.waiting[key] = queue[1:]
                _ready(l, key, queue[0])
            _pump(l)
    task = asyncio.ensure_future(finished())
    l.settled.append(task)
    return task


def _ready(l: Loop, key: Any, event: Event) -> None:
    if key in l.busy:
        # With a debounce, only the latest event for a busy key is kept.
        l.waiting[key] = [event] if l.debounce > 0 else (l.waiting.get(key) or []) + [event]
        return
    l.ready_queue.append((key, event))
    _pump(l)


def _pump(l: Loop) -> None:
    while l.in_flight < l.workers and l.ready_queue:
        key, event = l.ready_queue.pop(0)
        if key in l.busy:
            l.waiting[key] = (l.waiting.get(key) or []) + [event]
            continue
        _start(l, key, event)
    _schedule_debounce(l)


def _schedule_debounce(l: Loop) -> None:
    if l.timer is not None:
        l.timer.cancel()
        l.timer = None
    if not l.running or not l.pending:
        return
    now = l.clock()
    next_due = min(entry['due'] for entry in l.pending.values())

    def fire() -> None:
        t = l.clock()
        for key, entry in list(l.pending.items()):
            if entry['due'] <= t:
                del l.pending[key]
                _ready(l, key, entry['event'])
        _schedule_debounce(l)
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    l.timer = loop.call_later(max(0, (next_due - now)) / 1000, fire)


def loop_post(l: Loop, event: Event) -> None:
    require_at(l.running, 'loop', 'the loop is not running; call loopStart first')
    if l.debounce > 0 and event['key'] is not None:
        l.pending[event['key']] = {'event': event, 'due': l.clock() + 1000 * l.debounce}
        _schedule_debounce(l)
        return
    key = event['key']
    if key is None:
        l.counter += 1
        key = f'event-{l.counter}'
    _ready(l, key, event)


def loop_idle(l: Loop) -> bool:
    return l.in_flight == 0 and not l.pending and not l.waiting and not l.ready_queue


def loop_start(l: Loop) -> Loop:
    require_at(not l.running, 'loop', 'the loop is already running')
    l.running = True
    if l.run_due_every:
        async def tick() -> None:
            while l.running:
                every = l.run_due_every
                await asyncio.sleep(every if every is not None else 0)
                if not l.running:
                    return
                try:
                    await _dispatch_module().run_due(l.dispatcher)
                except Exception:
                    pass  # scheduled work that fails never stops the loop
        l.due_timer = asyncio.ensure_future(tick())
    l.stops = [source(lambda event: loop_post(l, event)) for source in l.sources]
    return l


async def loop_stop(l: Loop) -> None:
    """Stop the sources, then wait for what is already in flight.

    Events not yet started are dropped.
    """
    for stop in l.stops:
        try:
            result = stop()
            if inspect.isawaitable(result):
                await result
        except Exception:
            pass  # a source that will not stop is not fatal
    l.running = False
    if l.timer is not None:
        l.timer.cancel()
    if l.due_timer is not None:
        l.due_timer.cancel()
    l.timer = None
    l.due_timer = None
    l.stops = []
    l.pending.clear()
    l.waiting.clear()
    l.ready_queue.clear()
    if l.settled:
        await asyncio.gather(*l.settled, return_exceptions=True)
    l.settled = []


async def run_events(evaluate: Evaluate, dispatcher: Any, events: Iterable[Event],
                     max_age: Optional[float] = None,
                     clock: Optional[Callable[[], float]] = None) -> list:
    """Scenario runs: every event handled in order, with the same staleness rule
    and no debounce."""
    l = make_loop(evaluate, dispatcher, max_age=max_age, clock=clock)
    out = []
    for event in events:
        out.append((event, await _handle(l, event)))
    return out


# Sources. A source is (post) -> a stop function.
def timer_source(seconds: float, make_input: Callable[[], Any],
                 key: Any = None, principal: Any = None) -> Source:
    def source(post: Callable[[Event], None]) -> Callable[[], None]:
        stopped = False

        async def run() -> None:
            nonlocal stopped
            while not stopped:
                await asyncio.sleep(seconds)
                if stopped:
                    return
                try:
                    value = make_input()
                    if inspect.isawaitable(value):
                        value = await value
                    post(make_event(value, key=key, principal=principal))
                except Exception:
                    return  # a source that fails just stops posting
        asyncio.ensure_future(run())

        def stop() -> None:
            nonlocal stopped
            stopped = True
        return stop
    return source


# Everything an (async) iterable yields: an event, or a bare input.
def iterable_source(iterable: Any, key: Any = None, principal: Any = None) -> Source:
    def source(post: Callable[[Event], None]) -> Callable[[], None]:
        stopped = False

        async def run() -> None:
            nonlocal stopped
            try:
                if hasattr(iterable, '__aiter__'):
                    async for value in iterable:
                        if stopped:
                            return
                        post(value if (isinstance(value, dict) and 'input' in value and 'at' in value)
                             else make_event(value, key=key, principal=principal))
                else:
                    for value in iterable:
                        if stopped:
                            return
                        post(value if (isinstance(value, dict) and 'input' in value and 'at' in value)
                             else make_event(value, key=key, principal=principal))
            except Exception:
                pass  # a source that ends or fails just stops posting
        asyncio.ensure_future(run())

        def stop() -> None:
            nonlocal stopped
            stopped = True
        return stop
    return source


# JSON lines from a readable stream: {"input", "key", "principal", "id"}, or any
# other JSON value as the input itself. A bad line is skipped and reported.
def line_source(readable: Any, on_error: Optional[Callable[[str, Any], None]] = None) -> Source:
    def source(post: Callable[[Event], None]) -> Callable[[], None]:
        stopped = False

        async def read_chunk() -> str:
            if isinstance(readable, asyncio.StreamReader):
                chunk = await readable.read(4096)
            else:
                chunk = await asyncio.to_thread(readable.read, 4096)
            return chunk.decode('utf-8', 'replace') if isinstance(chunk, bytes) else (chunk or '')

        async def run() -> None:
            nonlocal stopped
            buffer = ''
            while not stopped:
                chunk = await read_chunk()
                if not chunk:
                    return
                buffer += chunk
                lines = buffer.split('\n')
                buffer = lines.pop()
                for line in lines:
                    if line.strip() == '':
                        continue
                    try:
                        value = json.loads(line)
                        if isinstance(value, dict) and 'input' in value:
                            post(make_event(value['input'],
                                            key=value.get('key') if value.get('key') is not None else None,
                                            principal=value.get('principal') if value.get('principal') is not None else None,
                                            id=value.get('id') if value.get('id') is not None else None))
                        else:
                            post(make_event(value))
                    except ValueError as error:
                        if on_error is not None:
                            on_error(line, error)
        asyncio.ensure_future(run())

        def stop() -> None:
            nonlocal stopped
            stopped = True
        return stop
    return source
