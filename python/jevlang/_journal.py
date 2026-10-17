"""The dispatcher's memory: which steps ran, cooldown claims, budget usage and
scheduled decisions.

A journal is a bundle of operations, so a backend is anything that fills them
in. This module has the in-memory one, the default, plus the SQLite one, which
survive restarts and let several processes share cooldowns, budgets and
idempotency.

Every claim is atomic: two dispatchers sharing a journal never both win the
same cooldown, both spend the last of a budget, or both run the same step.
SQLite gives that with single conditional statements (INSERT ... ON CONFLICT
... RETURNING, DELETE ... RETURNING) where the linked library is 3.35 or
later, and with BEGIN IMMEDIATE transactions otherwise; budgets always run in
a locking transaction because they need a sum and an insert together.

Times are integer milliseconds, matching the TypeScript and Racket engines.
"""
from __future__ import annotations

import json
import math
import re
import sqlite3
import time
from typing import Any, Callable, Dict, List, Optional

from ._common import is_object, require_at
from ._numberfmt import jsonify

_NEW = object()


def _ms(x: Any) -> int:
    """JavaScript's Math.round: nearest, halves toward positive infinity."""
    if isinstance(x, int) and not isinstance(x, bool):
        return x
    return math.floor(x + 0.5)


class MemoryJournal:
    """The in-memory backend: one caller at a time, so each claim is atomic
    without a lock."""

    def __init__(self) -> None:
        self._steps: Dict[str, Dict[str, Any]] = {}
        self._cooldowns: Dict[str, int] = {}
        self._usage: Dict[str, List[List[float]]] = {}
        self._pending: Dict[str, Any] = {}

    def beginStep(self, key: str, target: Any = None, now: Any = None) -> Any:
        s = self._steps.get(key)
        if s is None:
            self._steps[key] = {'status': 'running', 'result': None}
            return 'new'
        if s['status'] == 'running':
            return 'running'
        return {'status': s['status'], 'result': s['result']}

    def finishStep(self, key: str, status: str, result: Any = None,
                   now: Any = None) -> None:
        self._steps[key] = {'status': status,
                            'result': None if result is None else result}

    def releaseStep(self, key: str) -> None:
        self._steps.pop(key, None)

    def claimCooldown(self, name: str, now: Any, window: Any) -> bool:
        last = self._cooldowns.get(name)
        if last is not None and now - last < window:
            return False
        self._cooldowns[name] = now
        return True

    def coolingDown(self, name: str, now: Any, window: Any) -> bool:
        last = self._cooldowns.get(name)
        return last is not None and now - last < window

    def claimBudget(self, name: str, now: Any, window: Any, amount: Any,
                    max: Any) -> bool:
        live = [pair for pair in self._usage.get(name, []) if pair[0] > now - window]
        used = sum(pair[1] for pair in live)
        if used + amount > max:
            self._usage[name] = live
            return False
        self._usage[name] = [[now, amount]] + live
        return True

    def schedule(self, key: str, due: Any, payload: Any) -> None:
        self._pending[key] = (due, payload)

    def takeDue(self, now: Any) -> List[List[Any]]:
        due = sorted(((key, pair) for key, pair in self._pending.items()
                      if pair[0] <= now), key=lambda item: item[1][0])
        for key, _ in due:
            del self._pending[key]
        return [[key, pair[1]] for key, pair in due]

    def cancel(self, key: str) -> bool:
        return self._pending.pop(key, None) is not None

    def nextDue(self) -> Optional[int]:
        earliest: Optional[int] = None
        for _, (at, _) in self._pending.items():
            if earliest is None or at < earliest:
                earliest = at
        return earliest

    def close(self) -> None:
        return None

    begin_step = beginStep
    finish_step = finishStep
    release_step = releaseStep
    claim_cooldown = claimCooldown
    cooling_down = coolingDown
    claim_budget = claimBudget
    take_due = takeDue
    next_due = nextDue


def memory_journal() -> MemoryJournal:
    return MemoryJournal()


memoryJournal = memory_journal


def is_journal(value: Any) -> bool:
    return is_object(value) or hasattr(value, 'beginStep') or hasattr(value, 'begin_step')


isJournal = is_journal


class _Driver:
    """The SQL contract db_journal sits on, matching the TypeScript driver."""

    returning: bool = True

    def query(self, text: str, params: List[Any] = []) -> List[Dict[str, Any]]:
        raise NotImplementedError

    def transaction(self, thunk: Callable[[], Any]) -> Any:
        raise NotImplementedError

    def close(self) -> None:
        return None


_SCHEMA = (
    "CREATE TABLE IF NOT EXISTS {steps} (key TEXT PRIMARY KEY, target TEXT, status TEXT NOT NULL, result TEXT, started_at BIGINT, finished_at BIGINT)",
    "CREATE TABLE IF NOT EXISTS {cooldowns} (name TEXT PRIMARY KEY, last_at BIGINT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS {budgets} (name TEXT PRIMARY KEY)",
    "CREATE TABLE IF NOT EXISTS {budget_usage} (id {serial}, name TEXT NOT NULL, at BIGINT NOT NULL, amount {real} NOT NULL)",
    "CREATE TABLE IF NOT EXISTS {scheduled} (key TEXT PRIMARY KEY, due_at BIGINT NOT NULL, payload TEXT NOT NULL)",
)


class DbJournal:
    """A durable journal over any SQL driver; SQLite is built in, PostgreSQL
    needs one handed in."""

    def __init__(self, driver: _Driver, dialect: str = 'postgres',
                 prefix: str = 'jev_') -> None:
        self._driver = driver
        self._t = lambda name: prefix + name
        self._sqlite = dialect == 'sqlite'
        for statement in _SCHEMA:
            self._query(statement.format(
                steps=self._t('steps'), cooldowns=self._t('cooldowns'),
                budgets=self._t('budgets'), budget_usage=self._t('budget_usage'),
                scheduled=self._t('scheduled'),
                serial='INTEGER PRIMARY KEY AUTOINCREMENT' if self._sqlite else 'BIGSERIAL PRIMARY KEY',
                real='REAL' if self._sqlite else 'DOUBLE PRECISION'))

    def _query(self, text: str, params: List[Any] = []) -> List[Dict[str, Any]]:
        if self._sqlite:
            text = re.sub(r'\$(\d+)', r'?\1', text)
        return self._driver.query(text, params)

    def beginStep(self, key: str, target: Any, now: Any) -> Any:
        if self._driver.returning:  # type: ignore[attr-defined]
            claimed = self._query(
                f"INSERT INTO {self._t('steps')} (key, target, status, started_at)"
                f" VALUES ($1, $2, 'running', $3)"
                f" ON CONFLICT (key) DO NOTHING RETURNING key",
                [key, str(target), _ms(now)])
            if claimed:
                return 'new'
            rows = self._query(
                f"SELECT status, result FROM {self._t('steps')} WHERE key = $1", [key])
        else:
            rows = self._driver.transaction(lambda: self._claim_step_locked(key, target, now))
            if rows is _NEW:
                return 'new'
        if not rows:
            return 'running'
        if rows[0]['status'] == 'running':
            return 'running'
        result = rows[0]['result']
        return {'status': rows[0]['status'],
                'result': json.loads(result) if isinstance(result, str) else None}

    def _claim_step_locked(self, key: str, target: Any, now: Any) -> Any:
        rows = self._query(
            f"SELECT status, result FROM {self._t('steps')} WHERE key = $1", [key])
        if not rows:
            self._query(
                f"INSERT INTO {self._t('steps')} (key, target, status, started_at)"
                f" VALUES ($1, $2, 'running', $3)", [key, str(target), _ms(now)])
            return _NEW
        return rows

    def finishStep(self, key: str, status: str, result: Any = None,
                   now: Any = None) -> None:
        self._query(
            f"UPDATE {self._t('steps')} SET status = $1, result = $2, finished_at = $3"
            f" WHERE key = $4", [status, jsonify(None if result is None else result),
                                 _ms(now), key])

    def releaseStep(self, key: str) -> None:
        self._query(
            f"DELETE FROM {self._t('steps')} WHERE key = $1 AND status = 'running'", [key])

    def claimCooldown(self, name: str, now: Any, window: Any) -> bool:
        ident = str(name)
        if self._driver.returning:  # type: ignore[attr-defined]
            rows = self._query(
                f"INSERT INTO {self._t('cooldowns')} (name, last_at) VALUES ($1, $2)"
                f" ON CONFLICT (name) DO UPDATE SET last_at = excluded.last_at"
                f" WHERE {self._t('cooldowns')}.last_at <= $3 RETURNING name",
                [ident, _ms(now), _ms(now - window)])
            return len(rows) > 0
        return bool(self._driver.transaction(
            lambda: self._claim_cooldown_locked(ident, now, window)))

    def _claim_cooldown_locked(self, ident: str, now: Any, window: Any) -> bool:
        rows = self._query(
            f"SELECT last_at FROM {self._t('cooldowns')} WHERE name = $1", [ident])
        if rows and rows[0]['last_at'] > _ms(now - window):
            return False
        self._query(
            f"INSERT INTO {self._t('cooldowns')} (name, last_at) VALUES ($1, $2)"
            f" ON CONFLICT (name) DO UPDATE SET last_at = excluded.last_at",
            [ident, _ms(now)])
        return True

    def coolingDown(self, name: str, now: Any, window: Any) -> bool:
        rows = self._query(
            f"SELECT name FROM {self._t('cooldowns')} WHERE name = $1 AND last_at > $2",
            [str(name), _ms(now - window)])
        return len(rows) > 0

    def claimBudget(self, name: str, now: Any, window: Any, amount: Any,
                    max: Any) -> bool:
        ident = str(name)

        def thunk() -> bool:
            self._query(
                f"INSERT INTO {self._t('budgets')} (name) VALUES ($1)"
                f" ON CONFLICT (name) DO NOTHING", [ident])
            if not self._sqlite:
                self._query(
                    f"SELECT name FROM {self._t('budgets')} WHERE name = $1 FOR UPDATE",
                    [ident])
            rows = self._query(
                f"SELECT COALESCE(SUM(amount), 0) AS used FROM {self._t('budget_usage')}"
                f" WHERE name = $1 AND at > $2", [ident, _ms(now - window)])
            used = rows[0]['used'] if rows and rows[0]['used'] is not None else 0
            if used + amount > max:
                return False
            self._query(
                f"INSERT INTO {self._t('budget_usage')} (name, at, amount)"
                f" VALUES ($1, $2, $3)", [ident, _ms(now), amount])
            return True

        return bool(self._driver.transaction(thunk))

    def schedule(self, key: str, due: Any, payload: Any) -> None:
        self._query(
            f"INSERT INTO {self._t('scheduled')} (key, due_at, payload) VALUES ($1, $2, $3)"
            f" ON CONFLICT (key) DO UPDATE SET due_at = excluded.due_at,"
            f" payload = excluded.payload", [key, _ms(due), jsonify(payload)])

    def takeDue(self, now: Any) -> List[List[Any]]:
        if self._driver.returning:  # type: ignore[attr-defined]
            rows = self._query(
                f"DELETE FROM {self._t('scheduled')} WHERE due_at <= $1"
                f" RETURNING key, payload, due_at", [_ms(now)])
        else:
            rows = self._driver.transaction(
                lambda: self._take_due_locked(now))
        rows = sorted(rows, key=lambda row: row['due_at'])
        return [[row['key'], json.loads(row['payload'])] for row in rows]

    def _take_due_locked(self, now: Any) -> List[Dict[str, Any]]:
        rows = self._query(
            f"SELECT key, payload, due_at FROM {self._t('scheduled')} WHERE due_at <= $1",
            [_ms(now)])
        if rows:
            self._query(
                f"DELETE FROM {self._t('scheduled')} WHERE due_at <= $1", [_ms(now)])
        return rows

    def cancel(self, key: str) -> bool:
        if self._driver.returning:  # type: ignore[attr-defined]
            rows = self._query(
                f"DELETE FROM {self._t('scheduled')} WHERE key = $1 RETURNING key", [key])
            return len(rows) > 0
        return bool(self._driver.transaction(lambda: self._cancel_locked(key)))

    def _cancel_locked(self, key: str) -> bool:
        rows = self._query(
            f"SELECT key FROM {self._t('scheduled')} WHERE key = $1", [key])
        if not rows:
            return False
        self._query(f"DELETE FROM {self._t('scheduled')} WHERE key = $1", [key])
        return True

    def nextDue(self) -> Optional[float]:
        rows = self._query(f"SELECT MIN(due_at) AS due FROM {self._t('scheduled')}")
        due = rows[0]['due'] if rows else None
        return due if isinstance(due, (int, float)) else None

    def close(self) -> None:
        close = getattr(self._driver, 'close', None)
        if close is not None:
            close()

    begin_step = beginStep
    finish_step = finishStep
    release_step = releaseStep
    claim_cooldown = claimCooldown
    cooling_down = coolingDown
    claim_budget = claimBudget
    take_due = takeDue
    next_due = nextDue


def db_journal(driver: _Driver, dialect: str = 'postgres',
               prefix: str = 'jev_') -> DbJournal:
    return DbJournal(driver, dialect=dialect, prefix=prefix)


dbJournal = db_journal


class _SqliteDriver(_Driver):
    """The stdlib sqlite3 driver: synchronous, so a transaction never yields
    between BEGIN and COMMIT."""

    def __init__(self, path: str, returning: Optional[bool] = None) -> None:
        self._database = sqlite3.connect(path, isolation_level=None, timeout=5.0,
                                         check_same_thread=False)
        self._database.row_factory = sqlite3.Row
        self._database.execute('PRAGMA busy_timeout = 5000')
        # Switching to WAL needs the file to itself for a moment; a second
        # process opening the same journal may have to wait for it.
        deadline = time.monotonic() + 5.0
        while True:
            try:
                self._database.execute('PRAGMA journal_mode = WAL')
                break
            except sqlite3.OperationalError:
                require_at(time.monotonic() < deadline, 'path',
                           'the SQLite journal could not be opened in WAL mode')
                time.sleep(0.01)
        self.returning = (sqlite3.sqlite_version_info >= (3, 35, 0)) \
            if returning is None else returning

    def query(self, text: str, params: List[Any] = []) -> List[Dict[str, Any]]:
        cursor = self._database.execute(text, params)
        reads = text.lstrip().upper().startswith('SELECT') or 'RETURNING' in text.upper()
        if not reads:
            return []
        return [dict(row) for row in cursor.fetchall()]

    def transaction(self, thunk: Callable[[], Any]) -> Any:
        self._database.execute('BEGIN IMMEDIATE')
        try:
            result = thunk()
            self._database.execute('COMMIT')
            return result
        except BaseException:
            try:
                self._database.execute('ROLLBACK')
            except sqlite3.Error:
                pass
            raise

    def close(self) -> None:
        self._database.close()


def sqlite_journal(path: str, prefix: str = 'jev_',
                   returning: Optional[bool] = None) -> DbJournal:
    """A durable journal in one SQLite file; needs SQLite 3.35 for RETURNING
    and falls back to locking transactions when the library is older."""
    require_at(isinstance(path, str) and path != '', 'path',
               'a SQLite journal needs a file path')
    return DbJournal(_SqliteDriver(path, returning), dialect='sqlite', prefix=prefix)


sqliteJournal = sqlite_journal
