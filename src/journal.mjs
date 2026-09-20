// The dispatcher's memory: which steps ran, cooldown claims, budget usage and
// scheduled decisions.
//
// A journal is an object of operations, so a backend is anything that fills them
// in. This module has the in-memory one, the default; journal-db.mjs has SQLite
// and any SQL database a caller hands a driver for, which survive restarts and
// let several processes share cooldowns, budgets and idempotency.
//
// Every claim is atomic: two dispatchers sharing a journal never both win the
// same cooldown, both spend the last of a budget, or both run the same step.
//
// Times are integer milliseconds.
import { object } from './common.mjs';

// beginStep(key, target, now) -> 'new' | 'running' | { status, result }
//   'new' means this caller claimed the key and must finish or release it
// finishStep(key, status, result, now)
// releaseStep(key)                      forget a claim that did not run
// claimCooldown(name, now, window)      true: claimed, the last run is now
// coolingDown(name, now, window)        a peek; claims nothing
// claimBudget(name, now, window, amount, max)
//   true: the usage in (now - window, now] plus amount fits max, and is recorded
// schedule(key, due, payload)
// takeDue(now) -> [[key, payload], ...] removed atomically, earliest first
// cancel(key)                           true: it was pending
// nextDue() -> the earliest pending due time, or null
// close()
export function memoryJournal() {
  // JavaScript runs one of these to completion before the next, so each claim
  // is atomic without a lock.
  const steps = new Map();      // key -> { status, result }; "running" until finished
  const cooldowns = new Map();  // name -> last
  const usage = new Map();      // name -> [[at, amount], ...]
  const pending = new Map();    // key -> [due, payload]
  return {
    beginStep(key) {
      const s = steps.get(key);
      if (!s) { steps.set(key, { status: 'running', result: null }); return 'new'; }
      return s.status === 'running' ? 'running' : { status: s.status, result: s.result };
    },
    finishStep(key, status, result) { steps.set(key, { status, result: result ?? null }); },
    releaseStep(key) { steps.delete(key); },
    claimCooldown(name, now, window) {
      const last = cooldowns.get(name);
      if (last !== undefined && now - last < window) return false;
      cooldowns.set(name, now);
      return true;
    },
    coolingDown(name, now, window) {
      const last = cooldowns.get(name);
      return last !== undefined && now - last < window;
    },
    claimBudget(name, now, window, amount, max) {
      const live = (usage.get(name) ?? []).filter(([at]) => at > now - window);
      const used = live.reduce((sum, [, a]) => sum + a, 0);
      if (used + amount > max) { usage.set(name, live); return false; }
      usage.set(name, [[now, amount], ...live]);
      return true;
    },
    schedule(key, due, payload) { pending.set(key, [due, payload]); },
    takeDue(now) {
      const due = [...pending].filter(([, [at]]) => at <= now).sort((a, b) => a[1][0] - b[1][0]);
      for (const [key] of due) pending.delete(key);
      return due.map(([key, [, payload]]) => [key, payload]);
    },
    cancel(key) { return pending.delete(key); },
    nextDue() {
      let earliest = null;
      for (const [, [at]] of pending) if (earliest === null || at < earliest) earliest = at;
      return earliest;
    },
    close() {},
  };
}
export const isJournal = value => object(value) && typeof value.beginStep === 'function' && typeof value.claimBudget === 'function';
