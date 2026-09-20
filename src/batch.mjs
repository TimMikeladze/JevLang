// Batch evaluation.
//
// The common shape is "run this policy over ten thousand rows". Each row is one
// call taking somewhere in the low hundreds of milliseconds, so throughput comes
// from concurrency, not from batching rows into one request.
//
// Concurrency has to respect the rate limits, so every request start, retries
// included, goes through a pacer: one start every 60/rpm seconds, and a token
// bucket holding one second's worth. A start reserves the average input tokens
// seen so far and the reservation is corrected when the real count arrives;
// before any usage is known the estimate is zero, so only the request limit
// applies. A retry-after from any row pauses every start until it has passed.
import { requireAt, finite, object } from './common.mjs';
import { settings as client, usageCostOf } from './client-usage.mjs';

// Requests: one start every 60/rpm ms, no burst. Tokens: a bucket refilled
// continuously. Starts are handed out one at a time, and the waiting happens in
// that queue, so the next worker waits behind the current one.
export function makePacer({ rpm = 1200, tokensPerSecond = 250_000, sleep, clock } = {}) {
  const interval = rpm ? 60_000 / rpm : null;
  const cap = tokensPerSecond ? tokensPerSecond : null;
  let nextStart = null, pausedUntil = null, level = cap, levelAt = null, seen = 0, seenTokens = 0;
  let queue = Promise.resolve();
  const estimate = () => seen === 0 ? 0 : seenTokens / seen;
  const refill = now => {
    if (!cap) return;
    if (levelAt !== null) level = Math.min(cap, level + cap * ((now - levelAt) / 1000));
    levelAt = now;
  };
  const waitMs = now => {
    refill(now);
    const need = cap ? Math.min(cap, estimate()) : 0;
    return Math.max(0,
      nextStart === null ? 0 : nextStart - now,
      pausedUntil === null ? 0 : pausedUntil - now,
      cap && level < need ? 1000 * ((need - level) / cap) : 0);
  };
  const acquire = () => {
    const mine = queue.then(async () => {
      for (;;) {
        const now = clock();
        const wait = waitMs(now);
        if (wait > 0) { await sleep(wait / 1000); continue; }
        if (interval) nextStart = now + interval;
        if (cap) level -= estimate();
        return;
      }
    });
    queue = mine.catch(() => {});
    return mine;
  };
  const observe = usage => {
    const tokens = usage?.input_tokens;
    if (!finite(tokens)) return;
    if (cap) level -= tokens - estimate();
    seen += 1; seenTokens += tokens;
  };
  const pause = seconds => {
    const until = clock() + 1000 * seconds;
    pausedUntil = pausedUntil === null ? until : Math.max(pausedUntil, until);
  };
  return { acquire, observe, pause };
}

// evaluate : (row) -> a decision, or anything it throws
// results are in input order; failed counts the rows that are not decisions
export async function evaluateMany(evaluate, rows, {
  workers = 8, rpm = 1200, tokensPerSecond = 250_000,
  sleep = client.sleep, clock = client.clock, onResult = null,
} = {}) {
  requireAt(typeof evaluate === 'function', 'evaluate', 'evaluateMany takes a function of one row');
  requireAt(Array.isArray(rows), 'rows', 'evaluateMany takes an array of rows');
  requireAt(Number.isInteger(workers) && workers > 0, 'workers', 'workers must be a positive integer');
  const n = rows.length;
  if (n === 0) return { results: [], failed: 0, tokens: 0, cost: 0 };
  const out = new Array(n);
  let nextRow = 0, tokens = 0;
  const pacer = makePacer({ rpm, tokensPerSecond, sleep, clock });
  // Every call any row makes lands here, retries and multi-call rows included.
  const outerUsage = client.onUsage, outerPacer = client.pacer, outerPause = client.onRetryAfter;
  client.onUsage = usage => {
    if (finite(usage?.input_tokens)) tokens += usage.input_tokens;
    pacer.observe(usage);
    outerUsage?.(usage);
  };
  client.pacer = async () => { await pacer.acquire(); await outerPacer?.(); };
  client.onRetryAfter = seconds => { pacer.pause(seconds); outerPause?.(seconds); };
  const work = async () => {
    for (;;) {
      const i = nextRow;
      if (i >= n) return;
      nextRow += 1;
      try { out[i] = await evaluate(rows[i]); } catch (error) { out[i] = error; }
      // A throwing onResult stops the batch, as it does in Racket.
      if (onResult) await onResult(i, out[i]);
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(workers, n) }, work));
  } finally {
    client.onUsage = outerUsage; client.pacer = outerPacer; client.onRetryAfter = outerPause;
  }
  const results = [...out];
  return {
    results,
    failed: results.filter(r => !(object(r) && typeof r.action === 'string')).length,
    tokens,
    cost: usageCostOf({ input_tokens: tokens }),
  };
}
