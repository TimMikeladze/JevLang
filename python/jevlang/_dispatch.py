"""Cascade dispatch: the portable TS engine's src/dispatch.mjs, in Python.

A policy decides; it does not act. This is the layer that acts. The dispatcher
verifies at construction that every target the policy can name has a handler
(and no handler is registered for a target the policy never produces); at
dispatch time a decision is handled, passed through on purpose, skipped by a
safeguard that says so, or it raises. It never silently goes nowhere.

For actions with side effects it also re-checks an act decision's parameters
against its declaration, enforces its cooldown, runs a per-target guard just
before the handler, claims an idempotency key so an interrupted run is never
repeated blindly, and carries out a plan one step at a time.

Concurrency is asyncio: handler invocation, timeouts and retries are async;
journal calls are synchronous and called directly. Outcome and audit record
keys stay camelCase exactly as in the TypeScript engine, since they flow into
journals and reports.
"""
from __future__ import annotations

import asyncio
import inspect
import itertools
import time
from typing import Any, Awaitable, Callable, Dict, List, Optional, Tuple

from ._common import closest, equal, finite, is_object, own, require_at
from ._journal import _ms, is_journal, memory_journal
from ._validate import parameter_ok

__all__ = [
    'DispatchError', 'Budget', 'budget', 'Dispatcher', 'make_dispatcher',
    'handler_chain', 'is_handler_chain', 'retry', 'is_retry', 'act_handler',
    'handler_for', 'dispatch', 'dispatch_for_input', 'resolve', 'run_due',
    'cancel_scheduled', 'stop_scheduler', 'outcome_to_json',
    'outcome_declined', 'outcome_failed_steps', 'policy_targets_of',
]

_SCHEDULE_COUNTER = itertools.count(1)


class DispatchError(Exception):
    def __init__(self, message: str, kind: str = 'dispatch', key: Optional[str] = None,
                 seconds: Optional[float] = None):
        super().__init__(message)
        self.name = 'DispatchError'
        self.kind = kind
        self.key = key
        self.seconds = seconds


async def _resolved(value: Any) -> Any:
    """Handlers, guards and confirms may be plain functions or coroutines."""
    if inspect.isawaitable(value):
        return await value
    return value


def _js_string(value: Any) -> str:
    if value is True:
        return 'true'
    if value is False:
        return 'false'
    if value is None:
        return 'null'
    return str(value)


class Budget:
    """A budget covers every act decision, or the targets named in `only`."""

    def __init__(self, name: str, max: float, per: float,
                 amount: Optional[Callable[[dict], float]] = None,
                 only: Optional[List[str]] = None):
        require_at(finite(max) and max >= 0, 'budget.max',
                   'a budget needs a maximum of at least 0')
        require_at(finite(per) and per > 0, 'budget.per',
                   'a budget needs a positive window in seconds')
        self.name = name
        self.max = max
        self.per = per
        self.amount = amount if amount is not None else (lambda decision: 1)
        self.only = only


def budget(name: str, *, max: float, per: float,
           amount: Optional[Callable[[dict], float]] = None,
           only: Optional[List[str]] = None) -> Budget:
    return Budget(name, max, per, amount, only)


def _link_name(link: Any, i: Optional[int]) -> str:
    name = getattr(link, 'handler_name', None)
    if name is None:
        name = getattr(link, '__name__', None)
    return name if isinstance(name, str) and name != '' else \
        ('handler' if i is None else f'link {i + 1}')


async def _run_chain(chain: Any, key: Optional[str], state: Any, decision: dict,
                     context: Optional[dict]) -> Dict[str, Any]:
    tried: List[Tuple[str, str]] = []
    for i, link in enumerate(chain.links):
        value: Any = None
        failed = False
        try:
            value = await _resolved(link(state, decision, context))
        except Exception as error:  # a link that raises passes the case on
            failed = True
            message = str(error).split('\n')[0] if str(error) else ''
            tried.append((_link_name(link, i), f'raised: {message}'))
        if failed:
            continue
        if value is False:
            tried.append((_link_name(link, i), 'declined'))
            continue
        return {'result': value, 'link': {'key': key, 'index': i, 'name': _link_name(link, i)}}
    raise DispatchError(
        'every link in the handler chain' + (f" for '{key}'" if key else '') + ' failed or declined'
        + '\n  tried:' + ''.join(f'\n    {j + 1}. {name}: {why}' for j, (name, why) in enumerate(tried)),
        key=key if key is not None else (decision.get('target') if decision else None))


def handler_chain(*links: Any) -> Callable[..., Awaitable[Any]]:
    """Links run in order: one that raises or returns False passes the case on,
    the first other value stops the chain, and a chain that runs out raises
    naming every link it tried. A chain is itself a handler, so chains nest."""
    require_at(len(links) > 0, 'handlerChain', 'a chain needs at least one link')
    for i, link in enumerate(links):
        require_at(callable(link), f'handlerChain[{i}]',
                   'a link is a function of (state, decision)')

    async def chain(state: Any, decision: dict, context: Optional[dict] = None) -> Any:
        return (await _run_chain(chain, None, state, decision, context))['result']

    chain.links = list(links)  # type: ignore[attr-defined]
    chain.chain = True  # type: ignore[attr-defined]
    chain.handler_name = 'chain(' + ', '.join(_link_name(link, i) for i, link in enumerate(links)) + ')'  # type: ignore[attr-defined]
    return chain


def is_handler_chain(value: Any) -> bool:
    return callable(value) and getattr(value, 'chain', False) is True


def retry(proc: Any, attempts: int = 3, backoff: float = 0.5,
          sleep: Optional[Callable[[float], Awaitable[None]]] = None) -> Callable[..., Awaitable[Any]]:
    """Calls proc up to `attempts` times while it raises, sleeping backoff,
    2x, 4x between attempts. It never sleeps before the first attempt or after
    the last failure, and re-raises the last error unchanged."""
    require_at(callable(proc), 'retry', 'retry takes a function of (state, decision)')
    require_at(isinstance(attempts, int) and not isinstance(attempts, bool) and attempts > 0,
               'retry.attempts', 'attempts must be a positive integer')
    if sleep is None:
        async def sleep(seconds: float) -> None:  # type: ignore[misc]
            await asyncio.sleep(seconds)

    async def handler(state: Any, decision: dict, context: Optional[dict] = None) -> Any:
        n = 1
        while True:
            try:
                return await _resolved(proc(state, decision, context))
            except Exception as error:
                if n >= attempts:
                    raise error
                await sleep(backoff * 2 ** (n - 1))
                n += 1

    handler.handler_name = f'{_link_name(proc, None)} ({attempts} attempts)'  # type: ignore[attr-defined]
    handler.retrying = True  # type: ignore[attr-defined]
    return handler


def is_retry(value: Any) -> bool:
    return callable(value) and getattr(value, 'retrying', False) is True


def _decision_params(decision: dict) -> dict:
    data = decision.get('data') if isinstance(decision, dict) else None
    return data if is_object(data) else {}


def act_handler(proc: Any) -> Callable[..., Awaitable[Any]]:
    """A handler that calls proc with the act decision's parameters, the
    idempotency key of this run, and the state:
        proc({'room': 'kitchen', 'idempotencyKey': 'req_1/lights-on'}, state, decision)
    """
    require_at(callable(proc), 'actHandler', 'actHandler takes a function')

    async def handler(state: Any, decision: dict, context: Optional[dict] = None) -> Any:
        params = dict(_decision_params(decision))
        params['idempotencyKey'] = context.get('key') if context is not None and context.get('key') is not None else None
        return await _resolved(proc(params, state, decision))

    handler.handler_name = getattr(proc, '__name__', None) or 'actHandler'  # type: ignore[attr-defined]
    return handler


def _default_roles(principal: Any) -> List[str]:
    if not principal:
        return []
    if isinstance(principal, list):
        return [_js_string(x) for x in principal]
    if is_object(principal):
        roles = principal.get('roles')
        if roles is None:  # JS `??`: missing or null
            roles = []
        return [_js_string(x) for x in roles] if isinstance(roles, list) else [_js_string(roles)]
    return [_js_string(principal)]


def policy_targets_of(spec: dict) -> List[str]:
    """The targets a policy can name: its route's, its actions', and 'computed'
    when a target is built at run time."""
    targets = set((spec.get('actions') or {}).keys())
    computed = False

    def visit(d: Any) -> None:
        nonlocal computed
        if not is_object(d):
            return
        if d.get('action') in ('assign', 'page', 'escalate', 'next'):
            if isinstance(d.get('target'), str):
                targets.add(d['target'])
            else:
                computed = True
        for key in ('proposed', 'then', 'otherwise', 'decision'):
            if d.get(key):
                visit(d[key])
        for step in d.get('steps') or []:
            visit(step)

    route = spec.get('route') or {}
    for clause in route.get('clauses') or []:
        visit(clause.get('decision'))
    if route.get('otherwise'):
        visit(route['otherwise'])
    for clause in spec.get('prechecks') or []:
        visit(clause.get('decision'))
    for g in spec.get('gates') or []:
        visit(g.get('decision'))
    return list(targets) + (['computed'] if computed else [])


def _policy_can_confirm(spec: dict) -> bool:
    found = False

    def visit(d: Any) -> None:
        nonlocal found
        if not is_object(d):
            return
        if d.get('action') == 'confirm':
            found = True
        for key in ('proposed', 'then', 'otherwise', 'decision'):
            if d.get(key):
                visit(d[key])
        for step in d.get('steps') or []:
            visit(step)

    route = spec.get('route') or {}
    for clause in route.get('clauses') or []:
        visit(clause.get('decision'))
    if route.get('otherwise'):
        visit(route['otherwise'])
    for g in spec.get('gates') or []:
        visit(g.get('decision'))
    return found


class Dispatcher:
    table: Dict[str, Any]
    default: Any
    confirm: Any
    maxHops: int
    known: List[str]
    policy: Any
    schemas: Dict[str, Any]
    guards: Dict[str, Any]
    dryRun: bool
    planFailure: str
    clock: Callable[[], float]
    roles: Callable[[Any], List[str]]
    allow: Dict[str, List[str]]
    timeout: Optional[float]
    journal: Any
    budgets: List[Budget]
    onScheduled: Any
    autoRunDue: bool
    waker: Dict[str, Any]

    def targets(self) -> List[str]:
        return sorted(self.table.keys())


def make_dispatcher(handlers: Dict[str, Any], *, policy: Any = None,
                    policy_targets: Optional[List[str]] = None,
                    actions: Optional[Dict[str, Any]] = None,
                    default: Optional[Callable[..., Any]] = None,
                    allow_extra: bool = False, computed_targets: Any = 'unset',
                    confirm: Optional[Callable[..., Any]] = None, max_hops: int = 4,
                    guards: Optional[Dict[str, Callable[..., Any]]] = None,
                    dry_run: bool = False, plan_failure: str = 'stop',
                    clock: Optional[Callable[[], float]] = None,
                    roles: Optional[Callable[[Any], List[str]]] = None,
                    allow: Optional[Dict[str, List[str]]] = None,
                    timeout: Optional[float] = None,
                    journal: Any = None, budgets: Optional[List[Budget]] = None,
                    on_scheduled: Optional[Callable[[str, Any], None]] = None,
                    auto_run_due: bool = True) -> Dispatcher:
    guards = guards or {}
    allow = allow or {}
    budgets = budgets or []
    fallback = default
    require_at(is_object(handlers), 'handlers', 'handlers is a map of target to handler')
    for key, value in handlers.items():
        require_at(callable(value), f'handlers.{key}', 'a handler is a function of (state, decision)')
    if fallback:
        require_at(callable(fallback), 'default', 'a handler is a function of (state, decision)')
    if confirm:
        require_at(callable(confirm), 'confirm', 'a confirm handler is a function of (state, decision)')
    require_at(isinstance(max_hops, int) and not isinstance(max_hops, bool) and max_hops > 0,
               'maxHops', 'maxHops must be a positive integer')
    require_at(plan_failure in ('stop', 'continue', 'rollback'), 'planFailure',
               "planFailure is 'stop', 'continue' or 'rollback'")
    require_at(timeout is None or (finite(timeout) and timeout > 0), 'timeout',
               'a timeout is positive seconds')
    require_at(journal is None or is_journal(journal), 'journal',
               'a journal implements the journal operations')
    for key, guard in guards.items():
        require_at(callable(guard), f'guards.{key}', 'a guard is a function of (state, decision)')

    spec: Optional[dict] = None
    if policy is not None:
        if hasattr(policy, 'to_json'):
            spec = policy.to_json()      # the Policy builder wrapper
        elif hasattr(policy, 'policy'):
            spec = policy.policy          # a CompiledPolicy
        elif is_object(policy):
            spec = policy                 # a raw policy spec
    # The action declarations the dispatcher re-checks against: the policy's,
    # or the ones a caller dispatching decisions from elsewhere hands over.
    schemas = actions if actions is not None else ((spec or {}).get('actions') or {})
    # Every target the policy can name, from its route and its actions.
    targets = policy_targets if policy_targets is not None else \
        (policy_targets_of(spec) if spec else None)
    computed = bool(targets and 'computed' in targets) if computed_targets == 'unset' else bool(computed_targets)
    declared = [t for t in (targets or []) if t != 'computed']
    table = dict(handlers)

    if targets is not None:
        missing = [t for t in declared if not own(table, t)]
        extra = sorted(t for t in table.keys() if t not in declared and t != 'hold')
        require_at(not missing or fallback, 'handlers',
                   f"no handler for {'a target' if len(missing) == 1 else 'targets'} that the policy can produce: {', '.join(missing)}",
                   'Add handlers for them, or pass a default.'
                   + (f' Unused handlers, did you mean one of these? {", ".join(extra)}' if extra else ''),
                   'dispatch')
        require_at(allow_extra or not extra, 'handlers',
                   f"handler{'' if len(extra) == 1 else 's'} registered for {', '.join(extra)}, which this policy never produces",
                   f'Policy targets: {", ".join(declared)}. Pass allowExtra if this is deliberate.', 'dispatch')
        unknown_guards = [k for k in guards.keys() if k not in declared and not own(table, k)]
        require_at(not unknown_guards, 'guards',
                   f"guard{'' if len(unknown_guards) == 1 else 's'} for {', '.join(unknown_guards)}, which this policy never produces",
                   f'Policy targets: {", ".join(declared)}.', 'dispatch')
    # A policy that can produce confirm decisions needs someone to confirm them.
    if spec and not dry_run and _policy_can_confirm(spec):
        require_at(confirm, 'confirm',
                   'this policy can produce confirm decisions, but no confirm handler was given',
                   'Pass a confirm handler that returns true to approve.', 'dispatch')
    require_at(not computed or fallback, 'handlers',
               'this policy computes at least one target, so coverage cannot be checked statically',
               'Pass a default handler.', 'dispatch')

    d = Dispatcher()
    d.table = table
    d.default = fallback
    d.confirm = confirm
    d.maxHops = max_hops
    d.known = declared
    d.policy = policy
    d.schemas = schemas
    d.guards = dict(guards)
    d.dryRun = dry_run
    d.planFailure = plan_failure
    d.clock = clock if clock is not None else (lambda: time.time() * 1000)
    d.roles = roles if roles is not None else _default_roles
    d.allow = {k: [_js_string(x) for x in v] for k, v in allow.items()}
    d.timeout = timeout
    d.journal = journal if journal is not None else memory_journal()
    d.budgets = budgets
    d.onScheduled = on_scheduled
    d.autoRunDue = auto_run_due
    d.waker = {'timer': None, 'task': None, 'left': set()}
    return d


def handler_for(d: Dispatcher, target: str) -> Optional[Callable[..., Any]]:
    return d.table[target] if own(d.table, target) else d.default


def _now(d: Dispatcher) -> int:
    return _ms(d.clock())


def _sub_path(path: str, i: Any) -> str:
    return str(i) if path == '' else f'{path}/{i}'


def _step_key(context: dict, path: str, key: str) -> Optional[str]:
    if not context.get('base'):
        return None
    return f"{context['base']}/{'' if path == '' else path + '/'}{key}"


def _outcome(initial: dict, final: dict, handler: Optional[str], result: Any,
             chain: List[Tuple[str, dict]], link: Optional[dict], status: str,
             steps: Optional[List[dict]] = None) -> dict:
    return {'initial': initial, 'final': final, 'handler': handler, 'result': result,
            'chain': chain, 'link': link, 'status': status, 'steps': steps or []}


def _known_targets(d: Dispatcher) -> List[str]:
    return sorted(set(d.known) | {k for k in d.table.keys() if k != 'hold'})


def _did_you_mean(d: Dispatcher, key: str) -> str:
    guess = closest(key, _known_targets(d))
    return f"\n  did you mean '{guess}'?" if guess else ''


def _forbidden(d: Dispatcher, key: str, schema: Optional[dict], principal: Any) -> bool:
    allowed = schema.get('allow') if isinstance(schema, dict) and isinstance(schema.get('allow'), list) \
        else (d.allow.get(key) if own(d.allow, key) else None)
    if not allowed:
        return False
    have = d.roles(principal)
    return not any(role in allowed for role in have)


def _handler_timeout(d: Dispatcher, schema: Optional[dict]) -> Optional[float]:
    t = schema.get('timeout') if isinstance(schema, dict) else None
    return t if finite(t) else d.timeout


async def _cooling_down(d: Dispatcher, key: str, schema: Optional[dict]) -> bool:
    cooldown = schema.get('cooldown') if isinstance(schema, dict) else None
    return finite(cooldown) and d.journal.coolingDown(key, _now(d), 1000 * cooldown)


async def _claim_cooldown(d: Dispatcher, key: str, schema: Optional[dict]) -> bool:
    cooldown = schema.get('cooldown') if isinstance(schema, dict) else None
    return not finite(cooldown) or d.journal.claimCooldown(key, _now(d), 1000 * cooldown)


async def _claim_budgets(d: Dispatcher, key: str, decision: dict) -> bool:
    # Every budget that covers this decision must have room. A claim made
    # before a later budget refused stays counted: the conservative reading.
    for b in d.budgets:
        covers = key in b.only if b.only else decision.get('action') == 'act'
        if not covers:
            continue
        amount = b.amount(decision)
        require_at(finite(amount) and amount >= 0, f'budget.{b.name}',
                   f"the amount for '{key}' is not a number of at least 0", None, 'dispatch')
        if not d.journal.claimBudget(b.name, _now(d), 1000 * b.per, amount, b.max):
            return False
    return True


def _result_json(r: Any) -> Any:
    if r is None:
        return None
    if isinstance(r, (str, int, float, bool)):
        return r
    if is_object(r) or isinstance(r, list):
        return r
    return str(r)


async def _call_handler(h: Any, key: Optional[str], state: Any, decision: dict,
                        context: Optional[dict]) -> Dict[str, Any]:
    if is_handler_chain(h):
        return await _run_chain(h, key, state, decision, context)
    return {'result': await _resolved(h(state, decision, context)), 'link': None}


async def _call_handler_with_timeout(d: Dispatcher, h: Any, key: str, state: Any,
                                     decision: dict, context: Optional[dict],
                                     seconds: Optional[float]) -> Dict[str, Any]:
    if not seconds:
        return await _call_handler(h, key, state, decision, context)
    # A handler under a time limit. Like the TypeScript engine, the dispatcher
    # cannot stop a running handler: one that passes its deadline is left
    # running (never cancelled), reported as possibly having acted, and the
    # dispatcher stops waiting for it.
    task = asyncio.ensure_future(_call_handler(h, key, state, decision, context))
    done, pending = await asyncio.wait({task}, timeout=seconds)
    if pending:
        d.waker['left'].add(task)
        task.add_done_callback(d.waker['left'].discard)
        raise DispatchError(
            f"the handler for '{key}' ran longer than {seconds} seconds and was left running; it may already have acted",
            kind='timeout', key=key, seconds=seconds)
    return task.result()


def _empty_step(action: str, target: Optional[str], reason: Optional[str]) -> dict:
    return {
        'action': action, 'target': target, 'reason': reason, 'data': None, 'rule': None,
        'clause': None, 'source': None, 'line': None, 'file': None, 'model': None,
        'provider': None, 'requested_model': None, 'requested_effort': None,
        'effective_effort': None, 'request_id': None, 'stage': None, 'proposed': None,
        'evidence': [], 'steps': [], 'readings': [],
    }


def _check_action_params(d: Dispatcher, target: str, params: dict, facts: Any) -> None:
    schema = d.schemas.get(target) if own(d.schemas, target) else None
    if not schema:
        return
    for k, v in params.items():
        require_at(own(schema['params'], k), f'action.{target}.{k}', f"unknown parameter '{k}'",
                   None, 'action')
        require_at(parameter_ok(schema['params'][k], v, facts), f'action.{target}.{k}',
                   f"parameter must satisfy {schema['params'][k].get('type')}",
                   'Supply a value within the declared type, range or inventory.', 'action')
    for k, t in schema['params'].items():
        require_at(t.get('optional') or own(params, k), f'action.{target}',
                   f"missing required parameter '{k}'", None, 'action')


async def _run_plan(d: Dispatcher, context: dict, plan_decision: dict,
                    from_policy: bool, path: str) -> dict:
    mode = d.planFailure
    stop = mode in ('stop', 'rollback')
    steps: List[dict] = []
    failed = False
    for i, step in enumerate(plan_decision.get('steps') or []):
        if failed and stop:
            steps.append(_outcome(step, step, None, False, [], None, 'not-run'))
            continue
        try:
            o = await _dispatch_one(d, context, step, from_policy, _sub_path(path, i))
            steps.append(o)
            failed = failed or o['status'] == 'error'
        except Exception as error:
            steps.append(_outcome(step, step, None, error, [], None, 'error'))
            failed = True
    if failed and mode == 'rollback' and not d.dryRun:
        marked, undos, complete = await _roll_back(d, context, steps, path)
        return _outcome(plan_decision, plan_decision, None, None, [], None,
                        'rolled-back' if complete else 'error', marked + undos)
    return _outcome(plan_decision, plan_decision, None, None, [], None,
                    'error' if failed else ('dry-run' if d.dryRun else 'ran'), steps)


async def _roll_back(d: Dispatcher, context: dict, steps: List[dict],
                     path: str) -> Tuple[List[dict], List[dict], bool]:
    # #:undo is a declared inverse, not a snapshot: each undo is itself an
    # action that runs, newest-first.
    ran = [(i, o) for i, o in enumerate(steps) if o['status'] == 'ran']
    ran.reverse()
    results: List[Tuple[int, Optional[dict]]] = []
    for i, o in ran:
        done = o['final']
        schema = d.schemas.get(done['target']) if done.get('action') == 'act' and own(d.schemas, done['target']) else None
        undo = schema.get('undo') if isinstance(schema, dict) else None
        if not is_object(undo):
            results.append((i, None))
            continue
        params = _decision_params(done)
        args = {k: (params.get(x['args'][0]) if x.get('op') == 'variable' else x['args'][0])
                for k, x in (undo.get('params') or {}).items()}
        undo_decision = dict(_empty_step('act', undo.get('target'), f'undo step {i + 1}'), data=args)
        try:
            _check_action_params(d, undo['target'], args, context.get('facts'))
            results.append((i, await _dispatch_one(d, context, undo_decision, True, _sub_path(path, f'{i}/undo'))))
        except Exception as error:
            results.append((i, _outcome(undo_decision, undo_decision, None, error, [], None, 'error')))
    undone = {i for i, o in results if o is not None and o['status'] == 'ran'}
    return (
        [{**o, 'status': 'rolled-back'} if i in undone else o for i, o in enumerate(steps)],
        [o for _, o in results if o is not None],
        len(undone) == len(ran),
    )


def _path_string(hops: List[Tuple[str, dict]], key: Optional[str]) -> str:
    return ' -> '.join([k for k, _ in hops] + [key])


async def _dispatch_one(d: Dispatcher, context: dict, decision_in: dict,
                        from_policy_in: bool, path: str) -> dict:
    state = context.get('state')
    j = d.journal
    # No result yet is false, as it is in the Racket implementation, so an audit
    # record made from either says the same thing.
    dec = decision_in
    from_policy = from_policy_in
    hops: List[Tuple[str, dict]] = []
    handler: Optional[str] = None
    result: Any = False
    link: Optional[dict] = None
    while True:
        dry = d.dryRun

        def done() -> dict:
            return _outcome(decision_in, dec, handler, result, list(hops), link,
                            ('dry-run' if hops else 'passed') if dry else ('ran' if handler else 'passed'))

        def skipped(status: str, r: Any = None) -> dict:
            return _outcome(decision_in, dec, None, status if r is None else r, list(hops), link, status)

        def check_hops(key: Optional[str]) -> None:
            if len(hops) >= d.maxHops:
                raise DispatchError(
                    f'dispatch ran {len(hops)} handlers and was asked for another\n'
                    f'  path: {_path_string(hops, key)}\n'
                    '  a handler that is finished should return something other than a decision, or raise maxHops',
                    key=key)

        def schema_of(x: dict) -> Optional[dict]:
            if x.get('action') == 'act':
                return d.schemas.get(x.get('target')) if own(d.schemas, x.get('target')) else None
            return None

        action = dec.get('action')
        if action == 'next':
            return done()
        if action == 'clarify' and not own(d.table, 'clarify'):
            return done()
        if action == 'plan':
            o = await _run_plan(d, context, dec, from_policy, path)
            if len(hops) == 0 and dec is decision_in:
                return o
            return {**o, 'initial': decision_in, 'chain': list(hops), 'link': link}
        if action == 'schedule':
            inner = dec.get('proposed')
            seconds = dec.get('data').get('seconds') if is_object(dec.get('data')) else None
            require_at(is_object(inner) and finite(seconds) and seconds > 0, 'schedule',
                       'a schedule decision needs a positive delay and a decision')
            inner_schema = schema_of(inner)
            if inner_schema:
                _check_action_params(d, inner['target'], _decision_params(inner), context.get('facts'))
            hops_with = hops + [('schedule', dec)]
            if inner_schema and _forbidden(d, inner['target'], inner_schema, context.get('principal')):
                return skipped('forbidden')
            if dry:
                return _outcome(decision_in, dec, None, 'dry-run', hops_with, link, 'dry-run')
            k = _step_key(context, path, 'schedule')
            if k is None:
                k = f'schedule-{_now(d)}-{next(_SCHEDULE_COUNTER)}'
            j.schedule(k, _now(d) + _ms(1000 * seconds), {
                'decision': inner,
                'state': state if state is not None else None,
                'principal': context.get('principal') if context.get('principal') is not None else None,
                'facts': context.get('facts') if context.get('facts') is not None else None,
                'key': k,
            })
            _wake_scheduler(d)
            return _outcome(decision_in, dec, None, k, hops_with, link, 'scheduled')
        if action == 'confirm':
            proposed = dec.get('proposed')
            require_at(is_object(proposed), 'confirm', 'a confirm decision has no proposed decision',
                       'Build it with confirm(decision).', 'dispatch')
            if dry:
                hops = hops + [('confirm', dec)]
                dec = proposed
                continue
            target_phrase = f" for '{dec.get('target')}'" if dec.get('target') else ''
            require_at(d.confirm, 'confirm',
                       f'a confirm decision{target_phrase} reached a dispatcher with no confirm handler',
                       'Pass a confirm handler: a function of (state, decision) that returns true to approve.',
                       'dispatch')
            check_hops('confirm')
            # No point asking a person to approve what will be refused or skipped.
            proposed_schema = schema_of(proposed)
            if proposed_schema:
                if _forbidden(d, proposed.get('target'), proposed_schema, context.get('principal')):
                    return skipped('forbidden')
                if await _cooling_down(d, proposed.get('target'), proposed_schema):
                    return skipped('cooldown')
            called = await _call_handler(d.confirm, 'confirm', state, dec,
                                         {'key': _step_key(context, path, 'confirm'), 'path': path,
                                          'principal': context.get('principal')})
            r, l = called['result'], called['link']
            hops_with = hops + [('confirm', dec)]
            if r is True:
                hops = hops_with
                handler = 'confirm'
                result = r
                link = l if l is not None else link
                dec = proposed
                continue
            return _outcome(decision_in, dec, 'confirm', r, hops_with,
                            l if l is not None else link, 'declined')

        key = 'hold' if action == 'hold' else ('clarify' if action == 'clarify' else dec.get('target'))
        require_at(bool(key), 'dispatch', f'a {action} decision has no target',
                   'Only hold, clarify and next decisions may omit one.', 'dispatch')
        in_table = d.table[key] if own(d.table, key) else None
        if in_table:
            h = in_table
        elif key == 'hold':
            h = d.default
        elif not d.default:
            from_phrase = '' if from_policy else f" (returned by the handler for '{handler}')"
            raise DispatchError(
                f"no handler for target '{key}'{from_phrase}\n"
                '  dispatch never drops a decision silently; either:\n'
                f"    add a handler for '{key}' to the table\n"
                f"    pass a default handler{_did_you_mean(d, key)}", key=key)
        elif from_policy or key in d.known:
            h = d.default
        else:
            raise DispatchError(
                f"the handler for '{handler}' returned a decision for '{key}', which this dispatcher does not know\n"
                '  a default covers the policy\'s targets, not a handler\'s typo\n'
                f"  known targets: {', '.join(_known_targets(d))}{_did_you_mean(d, key)}", key=key)
        schema = schema_of(dec)
        # Defence in depth: the policy checked these, a handler's act may not have.
        if schema:
            _check_action_params(d, dec.get('target'), _decision_params(dec), context.get('facts'))
        if not h:
            return done()  # a hold with nothing registered passes through
        if _forbidden(d, key, schema, context.get('principal')):
            return skipped('forbidden')
        if dry:
            return _outcome(decision_in, dec, None, 'dry-run', hops + [(key, dec)], link, 'dry-run')

        skey = _step_key(context, path, key)
        claim = j.beginStep(skey, key, _now(d)) if skey else 'new'
        if claim == 'running':
            return skipped('uncertain',
                           f"'{key}' started under key {skey} and never finished; it may have acted, so it is not re-run")
        if is_object(claim):
            return _outcome(decision_in, dec, None, claim.get('result'), list(hops), link, 'duplicate')

        async def release_and_skip(status: str) -> dict:
            if skey:
                j.releaseStep(skey)
            return skipped(status)

        guard = d.guards[key] if own(d.guards, key) else None
        if guard and not await _resolved(guard(state, dec)):
            return await release_and_skip('guard-failed')
        if schema and await _cooling_down(d, key, schema):
            return await release_and_skip('cooldown')
        if not await _claim_budgets(d, key, dec):
            return await release_and_skip('over-budget')
        if schema and not await _claim_cooldown(d, key, schema):
            return await release_and_skip('cooldown')
        if any(k == key for k, _ in hops):
            raise DispatchError(
                f"dispatch cycle: the handler for '{key}' already ran\n"
                f'  path: {_path_string(hops, key)}\n'
                '  a handler that is finished should return something other than a decision', key=key)
        check_hops(key)
        try:
            called = await _call_handler_with_timeout(
                d, h, key, state, dec,
                {'key': skey, 'path': path, 'principal': context.get('principal')},
                _handler_timeout(d, schema))
            r, l = called['result'], called['link']
        except asyncio.CancelledError:
            # A cancelled dispatch leaves its step claim running on purpose: the
            # handler may already have acted, so a retry of the same key must
            # surface as uncertain rather than silently run it again.
            raise
        except Exception as error:
            if skey:
                j.finishStep(skey, 'error', {'error': str(error)}, _now(d))
            raise
        if skey:
            j.finishStep(skey, 'ran', _result_json(r), _now(d))
        hops_with = hops + [(key, dec)]
        if is_object(r) and isinstance(r.get('action'), str) and not equal(r, dec):
            hops = hops_with
            from_policy = False
            handler = key
            result = r
            link = l if l is not None else link
            dec = r
            continue
        return _outcome(decision_in, dec, key, r, hops_with, l if l is not None else link, 'ran')


async def dispatch(d: Dispatcher, state: Any, decision: dict, *,
                   principal: Any = None, key: Optional[str] = None,
                   facts: Optional[dict] = None) -> dict:
    base = key if key is not None else (decision.get('request_id') if decision.get('request_id') is not None else None)
    return await _dispatch_one(d, {'state': state, 'principal': principal, 'facts': facts, 'base': base},
                               decision, True, '')


async def dispatch_for_input(d: Dispatcher, input: Any, decision: dict, *,
                             raw_state: bool = False, principal: Any = None,
                             key: Optional[str] = None) -> dict:
    policy = d.policy
    build = getattr(policy, 'build_state', None)
    built = build(input) if policy is not None and not raw_state and build else None
    return await dispatch(d, built['state'] if built else input, decision,
                          principal=principal, key=key,
                          facts=built['facts'] if built else None)


async def resolve(evaluate: Any, d: Dispatcher, input: Any, *,
                  raw_state: bool = False, principal: Any = None,
                  key: Optional[str] = None) -> dict:
    decision = evaluate(input)
    if inspect.isawaitable(decision):
        decision = await decision
    return await dispatch_for_input(d, input, decision, raw_state=raw_state,
                                    principal=principal, key=key)


async def run_due(d: Dispatcher) -> int:
    items = d.journal.takeDue(_now(d))
    for key, payload in items:
        try:
            r = await _dispatch_one(
                d,
                {'state': payload.get('state') if payload.get('state') is not None else None,
                 'principal': payload.get('principal') if payload.get('principal') is not None else None,
                 'facts': payload.get('facts') if payload.get('facts') is not None else None,
                 'base': key},
                payload['decision'], True, '')
        except Exception as error:  # noqa: BLE001 - the callback sees the error
            r = error
        if d.onScheduled is not None:
            d.onScheduled(key, r)
    return len(items)


def cancel_scheduled(d: Dispatcher, key: str) -> bool:
    return d.journal.cancel(key)


def _wake_scheduler(d: Dispatcher) -> None:
    if not d.autoRunDue:
        return

    async def fire() -> None:
        await run_due(d)
        _wake_scheduler(d)

    async def schedule() -> None:
        next_due = d.journal.nextDue()
        if next_due is None:
            return
        wait = max(0, next_due - _now(d)) / 1000.0
        stop_scheduler(d)
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        d.waker['timer'] = loop.call_later(wait, lambda: asyncio.ensure_future(fire()))

    asyncio.ensure_future(schedule())


def stop_scheduler(d: Dispatcher) -> None:
    timer = d.waker.get('timer')
    if timer is not None:
        timer.cancel()
    d.waker['timer'] = None
    task = d.waker.get('task')
    if task is not None:
        task.cancel()
    d.waker['task'] = None


def outcome_declined(o: dict) -> bool:
    return o['final'].get('action') == 'confirm'


def outcome_failed_steps(o: dict) -> List[dict]:
    failed: List[dict] = []
    for s in o.get('steps') or []:
        if s['status'] == 'error':
            failed.append(s)
        else:
            failed.extend(outcome_failed_steps(s))
    return failed


def outcome_to_json(o: dict) -> Dict[str, Any]:
    rehandled = not equal(o['initial'], o['final'])
    r = o['result']
    confirm_ran = o['status'] != 'dry-run' and any(k == 'confirm' for k, _ in o['chain'])
    if is_object(r) and isinstance(r.get('action'), str):
        result = None
    elif o.get('steps'):
        result = None
    elif isinstance(r, BaseException):
        result = str(r)
    else:
        result = _result_json(r)
    return {
        **o['initial'],
        'handler': o['handler'] if o['handler'] is not None else None,
        'result': result,
        'rehandled': rehandled,
        'chain': [{'key': k, 'action': dec.get('action'),
                   'target': dec.get('target') if dec.get('target') is not None else None,
                   'reason': dec.get('reason') if dec.get('reason') is not None else None}
                  for k, dec in o['chain']],
        'link': ({'key': o['link']['key'], 'index': o['link']['index'], 'name': o['link']['name']}
                 if o['link'] else None),
        'confirmed': (not outcome_declined(o)) if confirm_ran else None,
        'final': o['final'] if rehandled else None,
        'status': o['status'],
        'steps': [outcome_to_json(s) for s in o.get('steps') or []],
    }


# CamelCase aliases, mirroring the TypeScript exports exactly.
makeDispatcher = make_dispatcher
dispatchForInput = dispatch_for_input
handlerChain = handler_chain
isHandlerChain = is_handler_chain
actHandler = act_handler
runDue = run_due
cancelScheduled = cancel_scheduled
stopScheduler = stop_scheduler
outcomeToJson = outcome_to_json
outcomeDeclined = outcome_declined
outcomeFailedSteps = outcome_failed_steps
policyTargetsOf = policy_targets_of
handlerFor = handler_for
