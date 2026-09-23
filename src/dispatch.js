// Cascade dispatch.
//
// A policy decides; it does not act. This is the layer that acts. The confident
// majority is routed cheaply, deterministic code handles what it can, and the
// uncertain minority goes to a slower handler: a frontier model, a queue, or a
// person.
//
// The point of doing this here rather than in a switch at the call site is the
// coverage check: a dispatcher verifies at construction that every target the
// policy can name has a handler, and that no handler is registered for a target
// the policy never produces. At dispatch time the same promise holds — a
// decision is handled, passed through on purpose, skipped by a safeguard that
// says so, or it raises. It never silently goes nowhere.
//
// For actions with side effects the dispatcher also re-checks an act decision's
// parameters against its declaration, enforces its cooldown, runs a per-target
// guard just before the handler, claims an idempotency key so an interrupted
// run is never repeated blindly, and carries out a plan one step at a time.
import { own, object, requireAt, equal, finite, closest } from './common.js';
import { parameterOK, itemIdentity } from './validate.js';
import { memoryJournal, isJournal } from './journal.js';

export class DispatchError extends Error {
  constructor(message, { kind = 'dispatch', key = null, seconds = null } = {}) {
    super(message);
    this.name = 'DispatchError';
    Object.assign(this, { kind, key, seconds });
  }
}

// A budget covers every act decision, or the targets named in `only`. With
// `by`, each value it returns (a customer, a target) gets its own budget.
export function budget(name, { max, per, amount = () => 1, only = null, by = null } = {}) {
  requireAt(finite(max) && max >= 0, 'budget.max', 'a budget needs a maximum of at least 0');
  requireAt(finite(per) && per > 0, 'budget.per', 'a budget needs a positive window in seconds');
  requireAt(by === null || typeof by === 'function', 'budget.by', 'by is a function of the decision');
  return { name, max, per, amount, only, by };
}

// A sliding-window rate limit over any journal: at most `max` takes per key in
// any `per` seconds. It is a budget with an amount of 1, so every journal
// (memory, SQL, Redis) enforces it atomically.
//
//   const limit = rateLimit(journal, 'evaluate', { max: 20, per: 60 });
//   if (!(await limit(ip)).ok) return new Response('slow down', { status: 429 });
export function rateLimit(journal, name, { max, per, clock = () => Date.now() } = {}) {
  requireAt(isJournal(journal), 'journal', 'a rate limit needs a journal');
  requireAt(Number.isInteger(max) && max >= 0, 'rateLimit.max', 'max is a count of at least 0');
  requireAt(finite(per) && per > 0, 'rateLimit.per', 'per is a positive window in seconds');
  return async (key = '') => ({ ok: await journal.claimBudget(`${name}:${key}`, clock(), 1000 * per, 1, max) });
}

// Links run in order: one that throws or returns false passes the case on, the
// first other value stops the chain, and a chain that runs out raises naming
// every link it tried. A chain is itself a handler, so chains nest.
export function handlerChain(...links) {
  requireAt(links.length > 0, 'handlerChain', 'a chain needs at least one link');
  links.forEach((link, i) => requireAt(typeof link === 'function', `handlerChain[${i}]`, 'a link is a function of (state, decision)'));
  const chain = async (state, decision, context) => (await runChain(chain, null, state, decision, context)).result;
  chain.links = links;
  chain.chain = true;
  chain.handlerName = `chain(${links.map((link, i) => linkName(link, i)).join(', ')})`;
  return chain;
}
export const isHandlerChain = value => typeof value === 'function' && value.chain === true;

// Calls proc up to `attempts` times while it throws, sleeping backoff, 2x, 4x
// between attempts. It never sleeps before the first attempt or after the last
// failure, and re-raises the last error unchanged. A false or any other value
// returns at once.
export function retry(proc, { attempts = 3, backoff = 0.5, sleep = seconds => new Promise(r => setTimeout(r, seconds * 1000)) } = {}) {
  requireAt(typeof proc === 'function', 'retry', 'retry takes a function of (state, decision)');
  requireAt(Number.isInteger(attempts) && attempts > 0, 'retry.attempts', 'attempts must be a positive integer');
  const handler = async (state, decision, context) => {
    for (let n = 1; ; n += 1) {
      try { return await proc(state, decision, context); } catch (error) {
        if (n >= attempts) throw error;
        await sleep(backoff * 2 ** (n - 1));
      }
    }
  };
  handler.handlerName = `${linkName(proc, null)} (${attempts} attempts)`;
  handler.retrying = true;
  return handler;
}
export const isRetry = value => typeof value === 'function' && value.retrying === true;

function linkName(link, i) {
  const name = link.handlerName ?? link.name;
  return typeof name === 'string' && name !== '' ? name : (i === null ? 'handler' : `link ${i + 1}`);
}
async function runChain(chain, key, state, decision, context) {
  const tried = [];
  for (const [i, link] of chain.links.entries()) {
    let value, failed = false;
    try { value = await link(state, decision, context); } catch (error) { failed = true; tried.push([linkName(link, i), `raised: ${String(error.message).split('\n')[0]}`]); }
    if (failed) continue;
    if (value === false) { tried.push([linkName(link, i), 'declined']); continue; }
    return { result: value, link: { key, index: i, name: linkName(link, i) } };
  }
  throw new DispatchError(`every link in the handler chain${key ? ` for '${key}'` : ''} failed or declined\n  tried:${tried.map(([name, why], j) => `\n    ${j + 1}. ${name}: ${why}`).join('')}`,
    { key: key ?? decision.target ?? null });
}

// (actHandler(proc)) is a handler that calls proc with the act decision's
// parameters, the idempotency key of this run, and the state:
//   proc({ room: 'kitchen', idempotencyKey: 'req_1/lights-on' }, state, decision)
export function actHandler(proc) {
  requireAt(typeof proc === 'function', 'actHandler', 'actHandler takes a function');
  const handler = (state, decision, context) => proc({ ...decisionParams(decision), idempotencyKey: context?.key ?? null }, state, decision);
  handler.handlerName = proc.name || 'actHandler';
  return handler;
}

const decisionParams = decision => object(decision.data) ? decision.data : {};
const roleString = value => String(value);
const defaultRoles = principal => {
  if (!principal) return [];
  if (Array.isArray(principal)) return principal.map(roleString);
  if (object(principal)) {
    const roles = principal.roles ?? [];
    return Array.isArray(roles) ? roles.map(roleString) : [roleString(roles)];
  }
  return [roleString(principal)];
};


export function makeDispatcher(handlers, {
  policy = null, policyTargets = null, actions = null, default: fallback = null, allowExtra = false, computedTargets = 'unset',
  confirm = null, maxHops = 4, guards = {}, dryRun = false, planFailure = 'stop',
  clock = () => Date.now(), roles = defaultRoles, allow = {}, timeout = null,
  journal = null, budgets = [], onScheduled = null, autoRunDue = true, stepLease = null, scheduleLease = null,
} = {}) {
  requireAt(object(handlers), 'handlers', 'handlers is a map of target to handler');
  for (const [key, value] of Object.entries(handlers)) requireAt(typeof value === 'function', `handlers.${key}`, 'a handler is a function of (state, decision)');
  if (fallback) requireAt(typeof fallback === 'function', 'default', 'a handler is a function of (state, decision)');
  if (confirm) requireAt(typeof confirm === 'function', 'confirm', 'a confirm handler is a function of (state, decision)');
  requireAt(Number.isInteger(maxHops) && maxHops > 0, 'maxHops', 'maxHops must be a positive integer');
  requireAt(['stop', 'continue', 'rollback'].includes(planFailure), 'planFailure', "planFailure is 'stop', 'continue' or 'rollback'");
  requireAt(timeout === null || (finite(timeout) && timeout > 0), 'timeout', 'a timeout is positive seconds');
  requireAt(journal === null || isJournal(journal), 'journal', 'a journal implements the journal operations');
  for (const [k, v] of [['stepLease', stepLease], ['scheduleLease', scheduleLease]]) requireAt(v === null || (finite(v) && v > 0), k, `${k} is positive seconds`);
  for (const [key, guard] of Object.entries(guards)) requireAt(typeof guard === 'function', `guards.${key}`, 'a guard is a function of (state, decision)');

  const spec = policy?.policy ?? null;
  // The action declarations the dispatcher re-checks against: the policy's, or
  // the ones a caller dispatching decisions from elsewhere hands over.
  const schemas = actions ?? spec?.actions ?? {};
  // Every target the policy can name, from its route and its actions.
  const targets = policyTargets ?? (spec ? policyTargetsOf(spec) : null);
  const computed = computedTargets === 'unset' ? Boolean(targets?.includes('computed')) : computedTargets;
  const declared = (targets ?? []).filter(t => t !== 'computed');
  const table = { ...handlers };

  if (targets) {
    const missing = declared.filter(t => !own(table, t));
    const extra = Object.keys(table).filter(t => !declared.includes(t) && t !== 'hold').sort();
    requireAt(!missing.length || fallback, 'handlers',
      `no handler for ${missing.length === 1 ? 'a target' : 'targets'} that the policy can produce: ${missing.join(', ')}`,
      `Add handlers for them, or pass a default.${extra.length ? ` Unused handlers, did you mean one of these? ${extra.join(', ')}` : ''}`, 'dispatch');
    requireAt(allowExtra || !extra.length, 'handlers',
      `handler${extra.length === 1 ? '' : 's'} registered for ${extra.join(', ')}, which this policy never produces`,
      `Policy targets: ${declared.join(', ')}. Pass allowExtra if this is deliberate.`, 'dispatch');
    const unknownGuards = Object.keys(guards).filter(k => !declared.includes(k) && !own(table, k));
    requireAt(!unknownGuards.length, 'guards', `guard${unknownGuards.length === 1 ? '' : 's'} for ${unknownGuards.join(', ')}, which this policy never produces`, `Policy targets: ${declared.join(', ')}.`, 'dispatch');
  }
  // A policy that can produce confirm decisions needs someone to confirm them.
  if (spec && !dryRun && policyCanConfirm(spec)) {
    requireAt(confirm, 'confirm', 'this policy can produce confirm decisions, but no confirm handler was given', 'Pass a confirm handler that returns true to approve.', 'dispatch');
  }
  requireAt(!computed || fallback, 'handlers', 'this policy computes at least one target, so coverage cannot be checked statically', 'Pass a default handler.', 'dispatch');

  return {
    table, default: fallback, confirm, maxHops, known: declared, policy, schemas,
    guards: { ...guards }, dryRun, planFailure, clock, roles,
    allow: Object.fromEntries(Object.entries(allow).map(([k, v]) => [k, v.map(roleString)])),
    timeout, journal: journal ?? memoryJournal(), budgets, onScheduled, autoRunDue, waker: { timer: null },
    stepLease: stepLease === null ? null : 1000 * stepLease, scheduleLease: scheduleLease === null ? null : 1000 * scheduleLease,
    targets() { return Object.keys(table).sort(); },
  };
}
// The targets a policy can name: its route's, its actions', and 'computed' when
// a target is built at run time.
export function policyTargetsOf(spec) {
  const targets = new Set(Object.keys(spec.actions ?? {}));
  let computed = false;
  const visit = d => {
    if (!object(d)) return;
    if (['assign', 'page', 'escalate', 'next'].includes(d.action)) {
      if (typeof d.target === 'string') targets.add(d.target); else computed = true;
    }
    for (const key of ['proposed', 'then', 'otherwise', 'decision']) if (d[key]) visit(d[key]);
    for (const step of d.steps ?? []) visit(step);
  };
  for (const clause of spec.route?.clauses ?? []) visit(clause.decision);
  if (spec.route?.otherwise) visit(spec.route.otherwise);
  for (const clause of spec.prechecks ?? []) visit(clause.decision);
  for (const g of spec.gates ?? []) visit(g.decision);
  return [...targets, ...(computed ? ['computed'] : [])];
}
const policyCanConfirm = spec => {
  let found = false;
  const visit = d => {
    if (!object(d)) return;
    if (d.action === 'confirm') found = true;
    for (const key of ['proposed', 'then', 'otherwise', 'decision']) if (d[key]) visit(d[key]);
    for (const step of d.steps ?? []) visit(step);
  };
  for (const clause of spec.route?.clauses ?? []) visit(clause.decision);
  if (spec.route?.otherwise) visit(spec.route.otherwise);
  for (const g of spec.gates ?? []) visit(g.decision);
  return found;
};

export const handlerFor = (d, target) => own(d.table, target) ? d.table[target] : d.default;
const now = d => Math.round(d.clock());
const subPath = (path, i) => path === '' ? String(i) : `${path}/${i}`;
const stepKey = (context, path, key) => context.base ? `${context.base}/${path === '' ? '' : `${path}/`}${key}` : null;
const outcome = (initial, final, handler, result, chain, link, status, steps = []) => ({ initial, final, handler, result, chain, link, status, steps });
const knownTargets = d => [...new Set([...d.known, ...Object.keys(d.table).filter(k => k !== 'hold')])].sort();
const didYouMean = (d, key) => { const guess = closest(key, knownTargets(d)); return guess ? `\n  did you mean '${guess}'?` : ''; };

const forbidden = (d, key, schema, principal) => {
  const allowed = Array.isArray(schema?.allow) ? schema.allow : (own(d.allow, key) ? d.allow[key] : null);
  if (!allowed) return false;
  const have = d.roles(principal);
  return !have.some(role => allowed.includes(role));
};
const handlerTimeout = (d, schema) => finite(schema?.timeout) ? schema.timeout : d.timeout;
const coolingDown = async (d, key, schema) => finite(schema?.cooldown) && await d.journal.coolingDown(key, now(d), 1000 * schema.cooldown);
const claimCooldown = async (d, key, schema) => !finite(schema?.cooldown) || await d.journal.claimCooldown(key, now(d), 1000 * schema.cooldown);
// Every budget that covers this decision must have room. A claim made before a
// later budget refused stays counted: the conservative reading.
async function claimBudgets(d, key, decision) {
  for (const b of d.budgets) {
    const covers = b.only ? b.only.includes(key) : decision.action === 'act';
    if (!covers) continue;
    const amount = b.amount(decision);
    requireAt(finite(amount) && amount >= 0, `budget.${b.name}`, `the amount for '${key}' is not a number of at least 0`, undefined, 'dispatch');
    const name = b.by ? `${b.name}:${b.by(decision)}` : b.name;
    if (!await d.journal.claimBudget(name, now(d), 1000 * b.per, amount, b.max)) return false;
  }
  return true;
}
const resultJson = r => r === undefined || r === null ? null : (typeof r === 'string' || typeof r === 'number' || typeof r === 'boolean' ? r : (object(r) || Array.isArray(r) ? r : String(r)));

// A handler under a time limit. JavaScript cannot stop a running function, so a
// handler that passes its deadline is reported as possibly still running, and
// possibly having acted; the dispatcher stops waiting for it.
async function callHandlerWithTimeout(d, h, key, state, decision, context, seconds) {
  if (!seconds) return callHandler(h, key, state, decision, context);
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new DispatchError(
      `the handler for '${key}' ran longer than ${seconds} seconds and was left running; it may already have acted`,
      { kind: 'timeout', key, seconds })), seconds * 1000);
  });
  try { return await Promise.race([callHandler(h, key, state, decision, context), deadline]); }
  finally { clearTimeout(timer); }
}
async function callHandler(h, key, state, decision, context) {
  if (isHandlerChain(h)) return runChain(h, key, state, decision, context);
  return { result: await h(state, decision, context), link: null };
}

export async function dispatch(d, state, decision, { principal = null, key = null, facts = null } = {}) {
  const base = key ?? decision.request_id ?? null;
  return dispatchOne(d, { state, principal, facts, base }, decision, true, '');
}

async function runPlan(d, context, planDecision, fromPolicy, path) {
  const mode = d.planFailure;
  const stop = mode === 'stop' || mode === 'rollback';
  const steps = [];
  let failed = false;
  for (const [i, step] of planDecision.steps.entries()) {
    if (failed && stop) { steps.push(outcome(step, step, null, false, [], null, 'not-run')); continue; }
    try {
      const o = await dispatchOne(d, context, step, fromPolicy, subPath(path, i));
      steps.push(o);
      failed = failed || o.status === 'error';
    } catch (error) {
      steps.push(outcome(step, step, null, error, [], null, 'error'));
      failed = true;
    }
  }
  if (failed && mode === 'rollback' && !d.dryRun) {
    const { steps: marked, undos, complete } = await rollBack(d, context, steps, path);
    return outcome(planDecision, planDecision, null, null, [], null, complete ? 'rolled-back' : 'error', [...marked, ...undos]);
  }
  return outcome(planDecision, planDecision, null, null, [], null,
    failed ? 'error' : d.dryRun ? 'dry-run' : 'ran', steps);
}

// Undo the steps that ran, last first, with each action's declared inverse.
// An inverse is a declaration, not a snapshot: it does not restore a state.
async function rollBack(d, context, steps, path) {
  const ran = steps.map((o, i) => [i, o]).filter(([, o]) => o.status === 'ran').reverse();
  const results = [];
  for (const [i, o] of ran) {
    const done = o.final;
    const schema = done.action === 'act' ? d.schemas[done.target] : null;
    const undo = schema?.undo;
    if (!object(undo)) { results.push([i, null]); continue; }
    const params = decisionParams(done);
    const args = Object.fromEntries(Object.entries(undo.params ?? {}).map(([k, x]) => [k, x.op === 'variable' ? params[x.args[0]] ?? null : x.args[0]]));
    const undoDecision = { ...emptyStep('act', undo.target, `undo step ${i + 1}`), data: args };
    try {
      checkActionParams(d, undo.target, args, context.facts);
      results.push([i, await dispatchOne(d, context, undoDecision, true, subPath(path, `${i}/undo`))]);
    } catch (error) {
      results.push([i, outcome(undoDecision, undoDecision, null, error, [], null, 'error')]);
    }
  }
  const undone = new Set(results.filter(([, o]) => o?.status === 'ran').map(([i]) => i));
  return {
    steps: steps.map((o, i) => undone.has(i) ? { ...o, status: 'rolled-back' } : o),
    undos: results.map(([, o]) => o).filter(Boolean),
    complete: undone.size === ran.length,
  };
}
const emptyStep = (action, target, reason) => ({
  action, target, reason, data: null, rule: null, clause: null, source: null, line: null, file: null,
  model: null, provider: null, requested_model: null, requested_effort: null, effective_effort: null,
  request_id: null, stage: null, proposed: null, evidence: [], steps: [], readings: [],
});
function checkActionParams(d, target, params, facts) {
  const schema = d.schemas[target];
  if (!schema) return;
  for (const [k, v] of Object.entries(params)) {
    requireAt(own(schema.params, k), `action.${target}.${k}`, `unknown parameter '${k}'`, undefined, 'action');
    requireAt(parameterOK(schema.params[k], v, facts ?? undefined), `action.${target}.${k}`,
      `parameter must satisfy ${schema.params[k].type}`, 'Supply a value within the declared type, range or inventory.', 'action');
  }
  for (const [k, t] of Object.entries(schema.params)) {
    requireAt(t.optional || own(params, k), `action.${target}`, `missing required parameter '${k}'`, undefined, 'action');
  }
}

async function dispatchOne(d, context, decisionIn, fromPolicyIn, path) {
  const state = context.state;
  const j = d.journal;
  // No result yet is false, as it is in the Racket implementation, so an audit
  // record made from either says the same thing.
  let dec = decisionIn, fromPolicy = fromPolicyIn, hops = [], handler = null, result = false, link = null;
  for (;;) {
    const dry = d.dryRun;
    const done = () => outcome(decisionIn, dec, handler, result, [...hops], link,
      dry ? (hops.length ? 'dry-run' : 'passed') : handler ? 'ran' : 'passed');
    const skipped = (status, r = status) => outcome(decisionIn, dec, null, r, [...hops], link, status);
    const action = dec.action;
    const checkHops = key => {
      if (hops.length >= d.maxHops) {
        throw new DispatchError(`dispatch ran ${hops.length} handlers and was asked for another\n  path: ${pathString(hops, key)}\n  a handler that is finished should return something other than a decision, or raise maxHops`, { key });
      }
    };
    const schemaOf = x => x.action === 'act' ? d.schemas[x.target] ?? null : null;

    if (action === 'next') return done();
    if (action === 'clarify' && !own(d.table, 'clarify')) return done();
    if (action === 'plan') {
      const o = await runPlan(d, context, dec, fromPolicy, path);
      return hops.length === 0 && dec === decisionIn ? o : { ...o, initial: decisionIn, chain: [...hops], link };
    }
    if (action === 'schedule') {
      const inner = dec.proposed;
      const seconds = object(dec.data) ? dec.data.seconds : null;
      requireAt(object(inner) && finite(seconds) && seconds > 0, 'schedule', 'a schedule decision needs a positive delay and a decision', undefined, 'dispatch');
      const innerSchema = schemaOf(inner);
      if (innerSchema) checkActionParams(d, inner.target, decisionParams(inner), context.facts);
      const hopsWith = [...hops, ['schedule', dec]];
      if (innerSchema && forbidden(d, inner.target, innerSchema, context.principal)) return skipped('forbidden');
      if (dry) return outcome(decisionIn, dec, null, 'dry-run', hopsWith, link, 'dry-run');
      const k = stepKey(context, path, 'schedule') ?? `schedule-${now(d)}-${scheduleCounter += 1}`;
      await j.schedule(k, now(d) + Math.round(1000 * seconds), {
        decision: inner, state: state ?? null, principal: context.principal ?? null, facts: context.facts ?? null, key: k,
      });
      wakeScheduler(d);
      return outcome(decisionIn, dec, null, k, hopsWith, link, 'scheduled');
    }
    if (action === 'confirm') {
      const proposed = dec.proposed;
      requireAt(object(proposed), 'confirm', 'a confirm decision has no proposed decision', 'Build it with confirm(decision).', 'dispatch');
      if (dry) { hops = [...hops, ['confirm', dec]]; dec = proposed; continue; }
      requireAt(d.confirm, 'confirm', `a confirm decision${dec.target ? ` for '${dec.target}'` : ''} reached a dispatcher with no confirm handler`,
        'Pass a confirm handler: a function of (state, decision) that returns true to approve.', 'dispatch');
      checkHops('confirm');
      // No point asking a person to approve what will be refused or skipped.
      const proposedSchema = schemaOf(proposed);
      if (proposedSchema) {
        if (forbidden(d, proposed.target, proposedSchema, context.principal)) return skipped('forbidden');
        if (await coolingDown(d, proposed.target, proposedSchema)) return skipped('cooldown');
      }
      const { result: r, link: l } = await callHandler(d.confirm, 'confirm', state, dec, { key: stepKey(context, path, 'confirm'), path, principal: context.principal });
      const hopsWith = [...hops, ['confirm', dec]];
      if (r === true) { hops = hopsWith; handler = 'confirm'; result = r; link = l ?? link; dec = proposed; continue; }
      return outcome(decisionIn, dec, 'confirm', r, hopsWith, l ?? link, 'declined');
    }

    const key = action === 'hold' ? 'hold' : action === 'clarify' ? 'clarify' : dec.target;
    requireAt(key, 'dispatch', `a ${action} decision has no target`, 'Only hold, clarify and next decisions may omit one.', 'dispatch');
    const inTable = own(d.table, key) ? d.table[key] : null;
    let h;
    if (inTable) h = inTable;
    else if (key === 'hold') h = d.default;
    else if (!d.default) {
      throw new DispatchError(`no handler for target '${key}'${fromPolicy ? '' : ` (returned by the handler for '${handler}')`}\n  dispatch never drops a decision silently; either:\n    add a handler for '${key}' to the table\n    pass a default handler${didYouMean(d, key)}`, { key });
    } else if (fromPolicy || d.known.includes(key)) h = d.default;
    else {
      throw new DispatchError(`the handler for '${handler}' returned a decision for '${key}', which this dispatcher does not know\n  a default covers the policy's targets, not a handler's typo\n  known targets: ${knownTargets(d).join(', ')}${didYouMean(d, key)}`, { key });
    }
    const schema = schemaOf(dec);
    // Defence in depth: the policy checked these, a handler's act may not have.
    if (schema) checkActionParams(d, dec.target, decisionParams(dec), context.facts);
    if (!h) return done();   // a hold with nothing registered passes through
    if (forbidden(d, key, schema, context.principal)) return skipped('forbidden');
    if (dry) return outcome(decisionIn, dec, null, 'dry-run', [...hops, [key, dec]], link, 'dry-run');

    const skey = stepKey(context, path, key);
    const claim = skey ? await (d.stepLease === null ? j.beginStep(skey, key, now(d)) : j.beginStep(skey, key, now(d), d.stepLease)) : 'new';
    if (claim === 'running') {
      return skipped('uncertain', `'${key}' started under key ${skey} and never finished; it may have acted, so it is not re-run`);
    }
    if (object(claim)) return outcome(decisionIn, dec, null, claim.result, [...hops], link, 'duplicate');
    const releaseAndSkip = async status => {
      if (skey) await j.releaseStep(skey);
      return skipped(status);
    };
    const guard = own(d.guards, key) ? d.guards[key] : null;
    if (guard && !await guard(state, dec)) return releaseAndSkip('guard-failed');
    if (schema && await coolingDown(d, key, schema)) return releaseAndSkip('cooldown');
    if (!await claimBudgets(d, key, dec)) return releaseAndSkip('over-budget');
    if (schema && !await claimCooldown(d, key, schema)) return releaseAndSkip('cooldown');
    if (hops.some(([k]) => k === key)) {
      throw new DispatchError(`dispatch cycle: the handler for '${key}' already ran\n  path: ${pathString(hops, key)}\n  a handler that is finished should return something other than a decision`, { key });
    }
    checkHops(key);
    let r, l;
    try {
      ({ result: r, link: l } = await callHandlerWithTimeout(d, h, key, state, dec, { key: skey, path, principal: context.principal }, handlerTimeout(d, schema)));
    } catch (error) {
      if (skey) await j.finishStep(skey, 'error', { error: error.message }, now(d));
      throw error;
    }
    if (skey) await j.finishStep(skey, 'ran', resultJson(r), now(d));
    const hopsWith = [...hops, [key, dec]];
    if (object(r) && typeof r.action === 'string' && !equal(r, dec)) {
      hops = hopsWith; fromPolicy = false; handler = key; result = r; link = l ?? link; dec = r;
      continue;
    }
    return outcome(decisionIn, dec, key, r, hopsWith, l ?? link, 'ran');
  }
}
let scheduleCounter = 0;
const pathString = (hops, key) => [...hops.map(([k]) => k), key].join(' -> ');

// Dispatch every scheduled decision that is due; returns how many ran. Each
// result goes to onScheduled as (key, outcome or error). On serverless, call
// this from a cron route: the in-process timer does not survive a frozen
// instance. With scheduleLease, an item is removed only after it ran, so a
// crash mid-run delivers it again after the lease.
export async function runDue(d) {
  const leased = d.scheduleLease !== null;
  const items = await (leased ? d.journal.takeDue(now(d), d.scheduleLease) : d.journal.takeDue(now(d)));
  for (const [key, payload] of items) {
    let r;
    try {
      r = await dispatchOne(d, { state: payload.state ?? null, principal: payload.principal ?? null, facts: payload.facts ?? null, base: key }, payload.decision, true, '');
    } catch (error) { r = error; }
    if (leased) await d.journal.cancel(key);
    d.onScheduled?.(key, r);
  }
  return items.length;
}
export const cancelScheduled = (d, key) => d.journal.cancel(key);
// One timer per dispatcher, waiting for the next due item. A new schedule
// resets it, so an earlier item is not missed. The timer never holds the
// process open.
function wakeScheduler(d) {
  if (!d.autoRunDue) return;
  const schedule = async () => {
    const next = await d.journal.nextDue();
    if (next === null) return;
    const wait = Math.max(0, next - now(d));
    clearTimeout(d.waker.timer);
    d.waker.timer = setTimeout(async () => { await runDue(d); await schedule(); }, wait);
    d.waker.timer.unref?.();
  };
  schedule();
}
export function stopScheduler(d) { clearTimeout(d.waker.timer); d.waker.timer = null; }

export const outcomeDeclined = o => o.final.action === 'confirm';
export const outcomeFailedSteps = o => o.steps.flatMap(s => s.status === 'error' ? [s] : outcomeFailedSteps(s));

// One record per outcome: the policy's decision with its readings, the hops the
// case took, the handler that finished it and what it returned, and the final
// decision when a handler replaced the policy's.
export function outcomeToJson(o) {
  const rehandled = !equal(o.initial, o.final);
  const r = o.result;
  const confirmRan = o.status !== 'dry-run' && o.chain.some(([k]) => k === 'confirm');
  return {
    ...o.initial,
    handler: o.handler ?? null,
    result: object(r) && typeof r.action === 'string' ? null : o.steps.length ? null
      : r instanceof Error ? r.message : resultJson(r),
    rehandled,
    chain: o.chain.map(([k, dec]) => ({ key: k, action: dec.action, target: dec.target ?? null, reason: dec.reason ?? null })),
    link: o.link ? { key: o.link.key, index: o.link.index, name: o.link.name } : null,
    confirmed: confirmRan ? !outcomeDeclined(o) : null,
    final: rehandled ? o.final : null,
    status: o.status,
    steps: o.steps.map(outcomeToJson),
  };
}

// The whole path: an input in, a handled outcome out. Handlers receive the state
// the policy actually sent — the declared fields, redacted and capped — unless
// rawState asks for the caller's input instead.
export async function resolve(evaluate, d, input, { rawState = false, principal = null, key = null } = {}) {
  return dispatchForInput(d, input, await evaluate(input), { rawState, principal, key });
}
export async function dispatchForInput(d, input, decision, { rawState = false, principal = null, key = null } = {}) {
  const policy = d.policy;
  const built = policy && !rawState ? policy.buildState(input) : null;
  return dispatch(d, built ? built.state : input, decision, { principal, key, facts: built ? built.facts : null });
}
