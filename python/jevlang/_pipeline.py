"""Requests that depend on earlier answers, ported from src/pipeline.mjs.

Some decisions take more than one call: shortlist the likely skills, then ask
again with only those as options; pick a department, then ask that
department's questions. Each call is a stage, and a stage hands off by
deciding next('stage').

The run stops at the first decision that is not a next. It refuses to loop:
reaching a stage twice is an error, and so is needing more than maxRequests
stages, since each stage is one billed call.
"""
from __future__ import annotations

from typing import Any, Awaitable, Callable, Optional, Union

from ._common import finite, is_object, own, require_at
from ._evaluate import settings

Stage = Union[Callable[[Any], Any], list, tuple]


def default_next_input(previous: Any, decision: Any) -> dict:
    """The input a stage gets when its entry has no builder.

    The previous input with the previous decision under ``previous``. A
    non-object input is wrapped.
    """
    if is_object(previous):
        return {**previous, 'previous': decision}
    return {'input': previous, 'previous': decision}


def _stage_parts(stages: dict, name: Any) -> tuple:
    entry = stages.get(name)
    pair = isinstance(entry, (list, tuple))
    evaluate = entry[0] if pair else entry
    build = (entry[1] if len(entry) > 1 and entry[1] is not None else default_next_input) if pair else default_next_input
    require_at(callable(evaluate), f'stages.{name}', 'a stage is an evaluate function, or [evaluate, builder]')
    require_at(callable(build), f'stages.{name}', 'a stage builder takes (previousInput, decision)')
    return evaluate, build


def _add_usage(acc: dict, usage: Any) -> dict:
    def part(key: str) -> float:
        value = usage.get(key) if is_object(usage) else None
        return value if isinstance(value, (int, float)) and not isinstance(value, bool) and finite(value) else None
    return {k: None if acc.get(k) is None or part(k) is None else acc[k] + part(k) for k in ('input_tokens', 'output_tokens')}


async def run_pipeline(stages: dict, input: Any, start: Optional[str] = None, max_requests: int = 4) -> dict:
    require_at(is_object(stages) and len(stages) > 0, 'stages', 'a pipeline is a map of stage name to evaluate')
    require_at(isinstance(max_requests, int) and not isinstance(max_requests, bool) and max_requests > 0,
               'maxRequests', 'maxRequests must be a positive integer')
    known = sorted(stages)

    def check_stage(name: Any, from_: str) -> None:
        require_at(own(stages, name), 'stages',
                   f"{from_} names stage '{name}', which the pipeline does not have",
                   f"Stages: {' -> '.join(known)}.")
    check_stage(start, 'start')
    stage = start
    current = input
    steps: list = []
    usage = {'input_tokens': 0, 'output_tokens': 0}
    unreported_calls = 0
    while True:
        path = [name for name, _ in steps]
        require_at(len(steps) < max_requests, 'pipeline',
                   f"the pipeline ran {len(steps)} stages without a final decision: {' -> '.join(path + [str(stage)])}",
                   f'Each stage is one request, and maxRequests is {max_requests}; raise it if this path is expected.')
        evaluate, _ = _stage_parts(stages, stage)
        # Every call the stage makes reports here, and still reaches any outer
        # sink, so a batch counting tokens still sees them.
        outer = settings.on_usage
        holder = [usage]

        def sink(u: dict) -> None:
            nonlocal unreported_calls
            if not all(finite(u.get(k)) for k in ('input_tokens', 'output_tokens')): unreported_calls += 1
            holder[0] = _add_usage(holder[0], u)
            if outer:
                outer(u)
        settings.on_usage = sink
        try:
            decision = await evaluate(current)
        finally:
            settings.on_usage = outer
        usage = holder[0]
        require_at(is_object(decision) and isinstance(decision.get('action'), str),
                   'pipeline', f"stage '{stage}' did not return a decision")
        staged = {**decision, 'stage': stage}
        steps = steps + [(stage, staged)]
        if staged['action'] != 'next':
            return {'decision': staged, 'steps': steps, 'usage': usage, 'usage_complete': unreported_calls == 0, 'unreported_calls': unreported_calls}
        to = staged.get('target')
        check_stage(to, f"stage '{stage}'")
        require_at(to != stage and to not in path, 'pipeline',
                   f"the pipeline reached stage '{to}' twice: {' -> '.join(path + [str(stage), str(to)])}",
                   'Stages form a chain without loops; to ask the same questions again, name a separate stage.')
        build = _stage_parts(stages, to)[1]
        current = build(current, staged)
        stage = to


def pipeline_to_json(result: dict) -> dict:
    return {
        'decision': result['decision'],
        'steps': [{'stage': stage, 'decision': decision} for stage, decision in result['steps']],
        'usage': result['usage'],
        'usage_complete': result.get('usage_complete', True), 'unreported_calls': result.get('unreported_calls', 0),
    }


def top_options(answer: Any, k: int) -> list:
    """The k most probable options of a choice answer, most probable first.

    The keys are as sent on the wire, ready to put in the next stage's state.
    Ties go to the key that sorts first, so the result is stable.
    """
    require_at(isinstance(k, int) and not isinstance(k, bool) and k >= 0, 'k', 'topOptions takes a count of at least 0')
    require_at(is_object(answer) and is_object(answer.get('probabilities')), 'answer',
               'topOptions needs a choice answer with probabilities', None, 'response')
    items = list(answer['probabilities'].items())

    def sort_key(item: tuple):
        value = item[1]
        return (-value if isinstance(value, (int, float)) and not isinstance(value, bool) else 0.0, item[0])
    items.sort(key=sort_key)
    return [key for key, _ in items[:k]]
