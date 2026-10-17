"""Clarify, then resume. Ported from src/session.mjs::

    s = make_sessions(evaluate, dispatcher)
    await session_message(s, 'kitchen-panel', 'turn the lights on')  # -> clarify "Which room?"
    await session_message(s, 'kitchen-panel', 'the bedroom')         # -> lights on in the bedroom

When a policy answers with a clarify decision, the session remembers the
input. The next message in the same session is merged with it and evaluated
again. After maxRounds questions it holds instead of asking forever. Pending
questions expire after ttl seconds and live in this process only.

The dispatch seam (dispatch_for_input) is imported lazily from
``jevlang._dispatch`` so this module loads before that slice lands.
"""
from __future__ import annotations

import time
from typing import Any, Awaitable, Callable, Optional

from ._common import is_object, require_at
from ._numberfmt import js_number_str

Evaluate = Callable[[Any], Any]
Merge = Callable[[Any, Any, Any], Any]


def _dispatch_module() -> Any:
    from . import _dispatch
    return _dispatch


def _to_str(reply: Any) -> str:
    if isinstance(reply, str):
        return reply
    if isinstance(reply, bool):
        return 'true' if reply else 'false'
    if isinstance(reply, (int, float)):
        return js_number_str(reply)
    from ._numberfmt import jsonify
    return jsonify(reply)


def default_merge(original: Any, question: Any, reply: Any) -> Any:
    if isinstance(original, str):
        return f'{original}\n(Asked: {question}) {reply}'
    require_at(is_object(original), 'merge', 'the default merge takes a string or an object input',
               'Pass merge: (original, question, reply) => input.')
    return {**original, 'clarification': {'question': question, 'reply': _to_str(reply)}}


class Sessions:
    def __init__(self, evaluate: Evaluate, dispatcher: Any, merge: Merge,
                 ttl: float, max_rounds: int, clock: Callable[[], float]) -> None:
        self.evaluate = evaluate
        self.dispatcher = dispatcher
        self.merge = merge
        self.ttl = ttl
        self.max_rounds = max_rounds
        self.clock = clock
        self.table: dict = {}


def make_sessions(evaluate: Evaluate, dispatcher: Any, merge: Merge = default_merge,
                  ttl: float = 300, max_rounds: int = 2,
                  clock: Optional[Callable[[], float]] = None) -> Sessions:
    require_at(callable(evaluate), 'evaluate', 'sessions need an evaluate function')
    require_at(dispatcher is not None and callable(getattr(dispatcher, 'targets', None)),
               'dispatcher', 'sessions need a dispatcher')
    require_at(isinstance(max_rounds, int) and not isinstance(max_rounds, bool) and max_rounds >= 0,
               'maxRounds', 'maxRounds is a count of at least 0')
    return Sessions(evaluate, dispatcher, merge, ttl, max_rounds,
                    clock if clock is not None else (lambda: time.time() * 1000))


def _take(s: Sessions, id: Any) -> Optional[dict]:
    p = s.table.get(id)
    s.table.pop(id, None)
    if p is None:
        return None
    return p if s.clock() - p['at'] <= 1000 * s.ttl else None


def session_pending(s: Sessions, id: Any) -> Optional[Any]:
    p = s.table.get(id)
    return p['question'] if p is not None else None


def session_forget(s: Sessions, id: Any) -> bool:
    return s.table.pop(id, None) is not None


async def session_message(s: Sessions, id: Any, message: Any,
                          principal: Any = None, key: Optional[str] = None) -> Any:
    """-> the dispatch outcome. A clarify outcome passes through unless the
    dispatcher has a clarify handler; the question is in the decision's data."""
    held = _take(s, id)
    input = s.merge(held['input'], held['question'], message) if held else message
    rounds = held['rounds'] if held else 0
    decision = await s.evaluate(input)
    final = decision
    if is_object(decision) and decision.get('action') == 'clarify':
        data = decision.get('data')
        question = data.get('question') if is_object(data) else None
        if question is None:
            question = ''
        if rounds >= s.max_rounds:
            final = {**decision, 'action': 'hold', 'target': None, 'proposed': None,
                     'reason': f"still not clear after {rounds} question{'' if rounds == 1 else 's'}",
                     'data': {'last_question': question}}
        else:
            s.table[id] = {'input': input, 'question': question, 'rounds': rounds + 1, 'at': s.clock()}
    return await _dispatch_module().dispatch_for_input(s.dispatcher, input, final,
                                                       principal=principal, key=key)
