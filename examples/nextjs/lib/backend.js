// Shared state for the routes: a decision log and a rate limiter.
//
// In memory each instance keeps its own counts, so the caps below hold per
// instance, not site-wide; switch to Upstash (JEV_STATE=upstash) for shared caps.
//
// With Upstash env (UPSTASH_REDIS_REST_URL/_TOKEN, or the KV_REST_API_URL/_TOKEN
// Vercel's Marketplace Redis sets) both live in Redis, shared by every
// instance; records expire after DECISION_RETENTION_HOURS, so there is no
// cleanup cron. Without it they live in this process, which is enough for
// `npm run dev` and tests.
import { randomUUID } from 'node:crypto';
import { memoryJournal } from 'jevlang/journal';
import { memoryStore } from 'jevlang/store';
import { rateLimit } from 'jevlang/dispatch';
import { upstash, redisJournal, redisStore } from 'jevlang/redis';

const redisConfigured = () => Boolean((process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL)
  && (process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN));
// JEV_STATE picks the backend: 'memory', 'upstash', or unset for Upstash when
// its env is present and memory otherwise.
const useRedis = () => {
  const choice = process.env.JEV_STATE;
  if (choice === 'memory') return false;
  if (choice === 'upstash') {
    if (!redisConfigured()) throw new Error('JEV_STATE=upstash but no Upstash env (UPSTASH_REDIS_REST_URL/_TOKEN or KV_REST_API_URL/_TOKEN)');
    return true;
  }
  return redisConfigured();
};

// Live model calls cost money, so they are capped twice: per client
// (LIVE_PER_CLIENT_PER_HOUR, default 5) and for the whole site
// (LIVE_PER_DAY, default 200), which also bounds a distributed flood.
function limits(journal) {
  const perClient = rateLimit(journal, 'live-client', { max: Number(process.env.LIVE_PER_CLIENT_PER_HOUR ?? 5), per: 3600 });
  const site = rateLimit(journal, 'live-site', { max: Number(process.env.LIVE_PER_DAY ?? 200), per: 86400 });
  // The client's claim first: a refused client never spends the site's budget.
  return async client => {
    if (!(await perClient(client)).ok) return { ok: false, scope: 'client' };
    if (!(await site('all')).ok) return { ok: false, scope: 'site' };
    return { ok: true };
  };
}

function create() {
  const ttl = 3600 * Number(process.env.DECISION_RETENTION_HOURS ?? 24);
  if (useRedis()) {
    const redis = upstash();
    return { name: 'upstash', store: redisStore(redis, { prefix: 'jevdemo:', ttl }), limit: limits(redisJournal(redis, { prefix: 'jevdemo:' })) };
  }
  return { name: 'memory', store: memoryStore(), limit: limits(memoryJournal()) };
}

// One per process; kept on globalThis so dev hot reloads keep the log.
export function backend() {
  globalThis.__jevBackend ??= create();
  return globalThis.__jevBackend;
}
export const resetBackend = () => { globalThis.__jevBackend = undefined; };

// The record keeps what explains the decision: the redacted state the model
// saw, the local facts the rules read, the readings and the policy fingerprint.
export async function recordDecision({ policy, state, facts, decision }) {
  return backend().store.append({
    policy: policy.policy.name,
    key: randomUUID(),   // every request is its own record, even with identical input
    input: { state, facts },
    decision: {
      action: decision.action, target: decision.target ?? null, reason: decision.reason ?? null,
      readings: decision.readings ?? [], source: decision.source ?? null,
      provider: decision.provider ?? null, model: decision.model ?? null, request_id: decision.request_id ?? null,
      fingerprint: policy.fingerprint(),
    },
  });
}

// Newest first, in the shape the UI's log reads.
export async function recentDecisions(policyName, limit = 10) {
  const records = await backend().store.list({ policy: policyName, limit });
  return records.reverse().map(r => ({
    at: new Date(r.at).toISOString(), policy: r.policy, fingerprint: r.decision.fingerprint,
    state: r.input?.state ?? null, facts: r.input?.facts ?? null, decision: r.decision,
  }));
}
