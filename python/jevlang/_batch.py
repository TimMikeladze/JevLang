"""Batch evaluation, ported from src/batch.mjs.

The common shape is "run this policy over ten thousand rows". Each row is one
call taking somewhere in the low hundreds of milliseconds, so throughput comes
from concurrency, not from batching rows into one request.

Concurrency has to respect the rate limits, so every request start, retries
included, goes through a pacer: one start every 60/rpm seconds, and a token
bucket holding one second's worth. A start reserves the average input tokens
seen so far and the reservation is corrected when the real count arrives;
before any usage is known the estimate is zero, so only the request limit
applies. A retry-after from any row pauses every start until it has passed.
"""
from __future__ import annotations

import asyncio
import inspect
from typing import Any, Awaitable, Callable, Optional

from ._common import finite, is_object, require_at
from ._cost import usage_cost
from ._evaluate import settings
from ._numberfmt import js_number_str

Sleep = Callable[[float], Awaitable[Any]]
Clock = Callable[[], float]


class Pacer:
    """Requests: one start every 60/rpm ms, no burst.

    Tokens: a bucket refilled continuously. Starts are handed out one at a
    time through a lock, so the next worker waits behind the current one.
    """

    def __init__(self, rpm: Optional[float] = 1200, tokens_per_second: Optional[float] = 250000,
                 sleep: Optional[Sleep] = None, clock: Optional[Clock] = None) -> None:
        self.interval = (60000.0 / rpm) if rpm else None
        self.cap = float(tokens_per_second) if tokens_per_second else None
        self.next_start: Optional[float] = None
        self.paused_until: Optional[float] = None
        self.level = self.cap if self.cap is not None else 0.0
        self.level_at: Optional[float] = None
        self.seen = 0
        self.seen_tokens = 0.0
        self._lock: Optional[asyncio.Lock] = None
        self._sleep = sleep if sleep is not None else settings.sleep
        self._clock = clock if clock is not None else settings.clock

    def _estimate(self) -> float:
        return 0.0 if self.seen == 0 else self.seen_tokens / self.seen

    def _refill(self, now: float) -> None:
        cap = self.cap
        if cap is None:
            return
        if self.level_at is not None:
            self.level = min(cap, self.level + cap * ((now - self.level_at) / 1000))
        self.level_at = now

    def _wait_ms(self, now: float) -> float:
        self._refill(now)
        cap = self.cap
        need = min(cap, self._estimate()) if cap else 0
        waits = [0.0]
        if self.next_start is not None:
            waits.append(self.next_start - now)
        if self.paused_until is not None:
            waits.append(self.paused_until - now)
        if cap and self.level < need:
            waits.append(1000 * ((need - self.level) / cap))
        return max(waits)

    async def acquire(self) -> None:
        if self._lock is None:  # created inside the loop: 3.9 binds it at construction
            self._lock = asyncio.Lock()
        async with self._lock:
            while True:
                now = self._clock()
                wait = self._wait_ms(now)
                if wait > 0:
                    await self._sleep(wait / 1000)
                    continue
                if self.interval:
                    self.next_start = now + self.interval
                if self.cap:
                    self.level -= self._estimate()
                return

    def observe(self, usage: Any) -> None:
        tokens = usage.get('input_tokens') if is_object(usage) else None
        if isinstance(tokens, bool) or not isinstance(tokens, (int, float)):
            return
        if self.cap:
            self.level -= float(tokens) - self._estimate()
        self.seen += 1
        self.seen_tokens += float(tokens)

    def pause(self, seconds: float) -> None:
        until = self._clock() + 1000 * seconds
        self.paused_until = until if self.paused_until is None else max(self.paused_until, until)


def make_pacer(rpm: Optional[float] = 1200, tokens_per_second: Optional[float] = 250000,
               sleep: Optional[Sleep] = None, clock: Optional[Clock] = None) -> Pacer:
    return Pacer(rpm=rpm, tokens_per_second=tokens_per_second, sleep=sleep, clock=clock)


def _is_decision(value: Any) -> bool:
    return is_object(value) and isinstance(value.get('action'), str)


async def evaluate_many(evaluate: Callable[[Any], Awaitable[Any]], rows: list,
                        workers: int = 8, rpm: Optional[float] = 1200,
                        tokens_per_second: Optional[float] = 250000,
                        sleep: Optional[Sleep] = None, clock: Optional[Clock] = None,
                        on_result: Optional[Callable[[int, Any], Any]] = None) -> dict:
    """Evaluate : (row) -> a decision, or anything it raises.

    Results are in input order; ``failed`` counts the rows that are not
    decisions. Every call any row makes is paced and accounted, retries and
    multi-call rows included, through the client settings.
    """
    require_at(callable(evaluate), 'evaluate', 'evaluateMany takes a function of one row')
    require_at(isinstance(rows, list), 'rows', 'evaluateMany takes an array of rows')
    require_at(isinstance(workers, int) and not isinstance(workers, bool) and workers > 0,
               'workers', 'workers must be a positive integer')
    n = len(rows)
    if n == 0:
        return {'results': [], 'failed': 0, 'tokens': 0, 'cost': usage_cost({'input_tokens': 0}), 'usage_complete': True, 'unreported_calls': 0}
    out: list = [None] * n
    next_row = 0
    tokens = 0
    unreported_calls = 0
    pacer = make_pacer(rpm=rpm, tokens_per_second=tokens_per_second, sleep=sleep, clock=clock)

    def on_usage(usage: Any) -> None:
        nonlocal tokens, unreported_calls
        value = usage.get('input_tokens') if is_object(usage) else None
        if not isinstance(value, bool) and isinstance(value, (int, float)):
            tokens += value
        else:
            unreported_calls += 1
        pacer.observe(usage)
        sink = outer_usage
        if sink:
            sink(usage)

    async def pacer_hook() -> None:
        await pacer.acquire()
        hook = outer_pacer
        if hook:
            await hook()

    def on_retry_after(seconds: float) -> None:
        pacer.pause(seconds)
        pause = outer_pause
        if pause:
            pause(seconds)

    outer_usage = settings.on_usage
    outer_pacer = settings.pacer
    outer_pause = settings.on_retry_after
    settings.on_usage = on_usage
    settings.pacer = pacer_hook
    settings.on_retry_after = on_retry_after

    async def work() -> None:
        nonlocal next_row
        while True:
            i = next_row
            if i >= n:
                return
            next_row += 1
            try:
                out[i] = await evaluate(rows[i])
            except Exception as error:  # a failed row is a result, not a stop
                out[i] = error
            # A raising on_result stops the batch, as it does in Racket.
            reporter = on_result
            if reporter:
                reported = reporter(i, out[i])
                if inspect.isawaitable(reported):
                    await reported

    try:
        await asyncio.gather(*[work() for _ in range(min(workers, n))])
    finally:
        settings.on_usage = outer_usage
        settings.pacer = outer_pacer
        settings.on_retry_after = outer_pause
    results = list(out)
    return {
        'results': results,
        'failed': sum(1 for r in results if not _is_decision(r)),
        'tokens': tokens,
        'cost': None if unreported_calls else usage_cost({'input_tokens': tokens}),
        'usage_complete': unreported_calls == 0, 'unreported_calls': unreported_calls,
    }
