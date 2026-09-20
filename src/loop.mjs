// Running continuously: events in, decisions dispatched.
//
//   const l = makeLoop({ evaluate, dispatcher, sources: [timerSource(60, readSensors, { key: 'sensors' })], debounce: 0.5, maxAge: 30 });
//   loopStart(l);
//   loopPost(l, makeEvent('turn off the lights', { key: 'living-room', principal: ['owner'] }));
//   await loopStop(l);
//
// - Events with the same key are handled one at a time, in order. With a
//   debounce, a burst of events for one key collapses to its latest.
// - An event older than maxAge when its turn comes is not evaluated; its result
//   is 'stale'. The world it described has moved on.
// - Different keys run in parallel, up to workers.
// - Every result goes to onOutcome as (event, result), where result is an
//   outcome, 'stale', or the error the evaluation or dispatch raised. One
//   event's failure never stops the loop.
import { requireAt, finite } from './common.mjs';
import { resolve as resolveDecision, runDue } from './dispatch.mjs';

// input     : what the policy's evaluate takes
// key       : events with the same key are serialized and debounced
// principal : who is asking, from the caller, never from the model
// id        : the event's own id (a webhook delivery id, say); it becomes the
//             dispatch key, so a redelivered event is not run again
// at        : when it happened, on the loop's clock
export const makeEvent = (input, { key = null, principal = null, id = null, at = Date.now() } = {}) =>
  ({ input, key, principal, id, at });

export function makeLoop({
  evaluate, dispatcher, sources = [], debounce = 0, maxAge = null, workers = 4,
  onOutcome = null, clock = () => Date.now(), runDueEvery = null,
} = {}) {
  requireAt(typeof evaluate === 'function', 'evaluate', 'a loop needs an evaluate function');
  requireAt(dispatcher && typeof dispatcher.targets === 'function', 'dispatcher', 'a loop needs a dispatcher');
  requireAt(finite(debounce) && debounce >= 0, 'debounce', 'debounce is seconds, at least 0');
  requireAt(maxAge === null || (finite(maxAge) && maxAge > 0), 'maxAge', 'maxAge is positive seconds, or null');
  requireAt(Number.isInteger(workers) && workers > 0, 'workers', 'workers must be a positive integer');
  return {
    evaluate, dispatcher, sources, debounce, maxAge, workers, onOutcome, clock, runDueEvery,
    running: false, pending: new Map(), waiting: new Map(), busy: new Set(), readyQueue: [],
    inFlight: 0, timer: null, dueTimer: null, stops: [], counter: 0, settled: [],
  };
}

// Handle one event now: an outcome, 'stale', or the error it raised.
async function handle(l, event) {
  if (l.maxAge !== null && l.clock() - event.at > 1000 * l.maxAge) return 'stale';
  try {
    return await resolveDecision(l.evaluate, l.dispatcher, event.input, {
      principal: event.principal, key: event.id === null ? null : String(event.id),
    });
  } catch (error) { return error; }
}

const start = (l, key, event) => {
  l.busy.add(key);
  l.inFlight += 1;
  const finished = (async () => {
    const result = await handle(l, event);
    try { await l.onOutcome?.(event, result); } catch { /* one event's failure never stops the loop */ }
    l.inFlight -= 1;
    l.busy.delete(key);
    const queue = l.waiting.get(key) ?? [];
    if (queue.length) {
      if (queue.length === 1) l.waiting.delete(key); else l.waiting.set(key, queue.slice(1));
      ready(l, key, queue[0]);
    }
    pump(l);
  })();
  l.settled.push(finished);
  return finished;
};
function ready(l, key, event) {
  if (l.busy.has(key)) {
    // With a debounce, only the latest event for a busy key is kept.
    l.waiting.set(key, l.debounce > 0 ? [event] : [...(l.waiting.get(key) ?? []), event]);
    return;
  }
  l.readyQueue.push([key, event]);
  pump(l);
}
function pump(l) {
  while (l.inFlight < l.workers && l.readyQueue.length) {
    const [key, event] = l.readyQueue.shift();
    if (l.busy.has(key)) { l.waiting.set(key, [...(l.waiting.get(key) ?? []), event]); continue; }
    start(l, key, event);
  }
  scheduleDebounce(l);
}
function scheduleDebounce(l) {
  clearTimeout(l.timer);
  l.timer = null;
  if (!l.running || l.pending.size === 0) return;
  const now = l.clock();
  const next = Math.min(...[...l.pending.values()].map(entry => entry.due));
  l.timer = setTimeout(() => {
    const t = l.clock();
    for (const [key, entry] of [...l.pending]) {
      if (entry.due <= t) { l.pending.delete(key); ready(l, key, entry.event); }
    }
    scheduleDebounce(l);
  }, Math.max(0, next - now));
  l.timer.unref?.();
}

export function loopPost(l, event) {
  requireAt(l.running, 'loop', 'the loop is not running; call loopStart first');
  if (l.debounce > 0 && event.key !== null) {
    l.pending.set(event.key, { event, due: l.clock() + 1000 * l.debounce });
    scheduleDebounce(l);
    return;
  }
  ready(l, event.key ?? `event-${l.counter += 1}`, event);
}
export const loopIdle = l => l.inFlight === 0 && l.pending.size === 0 && l.waiting.size === 0 && l.readyQueue.length === 0;

export function loopStart(l) {
  requireAt(!l.running, 'loop', 'the loop is already running');
  l.running = true;
  if (l.runDueEvery) {
    const tick = async () => {
      try { await runDue(l.dispatcher); } catch { /* scheduled work that fails never stops the loop */ }
      if (l.running) { l.dueTimer = setTimeout(tick, 1000 * l.runDueEvery); l.dueTimer.unref?.(); }
    };
    l.dueTimer = setTimeout(tick, 1000 * l.runDueEvery);
    l.dueTimer.unref?.();
  }
  l.stops = l.sources.map(source => source(event => loopPost(l, event)));
  return l;
}
// Stop the sources, then wait for what is already in flight. Events not yet
// started are dropped.
export async function loopStop(l) {
  for (const stop of l.stops) { try { await stop(); } catch { /* a source that will not stop is not fatal */ } }
  l.running = false;
  clearTimeout(l.timer); clearTimeout(l.dueTimer);
  l.timer = null; l.dueTimer = null; l.stops = [];
  l.pending.clear(); l.waiting.clear(); l.readyQueue.length = 0;
  await Promise.all(l.settled);
  l.settled = [];
}
// Scenario runs: every event handled in order, with the same staleness rule and
// no debounce.
export async function runEvents(evaluate, dispatcher, events, { maxAge = null, clock = () => Date.now() } = {}) {
  const l = makeLoop({ evaluate, dispatcher, maxAge, clock });
  const out = [];
  for (const event of events) out.push([event, await handle(l, event)]);
  return out;
}

// Sources. A source is (post) -> a stop function.
export const timerSource = (seconds, makeInput, { key = null, principal = null } = {}) => post => {
  const timer = setInterval(async () => post(makeEvent(await makeInput(), { key, principal })), 1000 * seconds);
  timer.unref?.();
  return () => clearInterval(timer);
};
// Everything an async iterable yields: an event, or a bare input.
export const iterableSource = (iterable, { key = null, principal = null } = {}) => post => {
  let stopped = false;
  (async () => {
    for await (const value of iterable) {
      if (stopped) return;
      post(value?.input !== undefined && Object.hasOwn(value, 'at') ? value : makeEvent(value, { key, principal }));
    }
  })().catch(() => { /* a source that ends or fails just stops posting */ });
  return () => { stopped = true; };
};
// JSON lines from a readable stream: {"input", "key", "principal", "id"}, or any
// other JSON value as the input itself. A bad line is skipped and reported.
export const lineSource = (readable, { onError = null } = {}) => post => {
  let buffer = '', stopped = false;
  const onData = chunk => {
    if (stopped) return;
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim() === '') continue;
      try {
        const value = JSON.parse(line);
        post(value !== null && typeof value === 'object' && Object.hasOwn(value, 'input')
          ? makeEvent(value.input, { key: value.key ?? null, principal: value.principal ?? null, id: value.id ?? null })
          : makeEvent(value));
      } catch (error) { onError?.(line, error); }
    }
  };
  readable.setEncoding?.('utf8');
  readable.on('data', onData);
  return () => { stopped = true; readable.off('data', onData); };
};
