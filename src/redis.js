// Redis-backed state for serverless: a journal (idempotency, cooldowns, budgets
// and rate limits, scheduled work), a decision store and a session table, shared
// by every instance that points at the same Redis.
//
//   import { upstash, redisJournal, redisStore } from 'jevlang/redis'
//   const redis = upstash()                    // UPSTASH_REDIS_REST_URL/_TOKEN or KV_REST_API_URL/_TOKEN
//   const journal = redisJournal(redis)
//   const store = redisStore(redis, { ttl: 7 * 86400 })
//
// A client is anything with eval(script, keys, args) -> result, which is the
// @upstash/redis signature, so an Upstash client passes straight in. upstash()
// is a dependency-free client over Upstash's REST API; fromIoredis and
// fromNodeRedis adapt the other two common clients. Every operation is one Lua
// script, so each claim is atomic across instances without a lock.
//
// Times are integer milliseconds. Numbers cross into Lua as strings, and a
// script returns strings, never floats (Redis truncates Lua numbers).
import { requireAt } from './common.js';
import { recordOf } from './store.js';

const isClient = value => !!(value && typeof value.eval === 'function');
const env = name => (typeof process !== 'undefined' ? process.env[name] : undefined) || undefined;

// A Redis client over the Upstash REST API, with fetch. Credentials default to
// Upstash's variables, then the ones Vercel's Marketplace Redis sets.
export function upstash({ url = env('UPSTASH_REDIS_REST_URL') ?? env('KV_REST_API_URL'), token = env('UPSTASH_REDIS_REST_TOKEN') ?? env('KV_REST_API_TOKEN'), fetch: fetchImpl = globalThis.fetch } = {}) {
  requireAt(typeof url === 'string' && url !== '', 'url', 'an Upstash client needs a REST URL', 'Set UPSTASH_REDIS_REST_URL (or KV_REST_API_URL), or pass url.');
  requireAt(typeof token === 'string' && token !== '', 'token', 'an Upstash client needs a REST token', 'Set UPSTASH_REDIS_REST_TOKEN (or KV_REST_API_TOKEN), or pass token.');
  const endpoint = url.replace(/\/+$/, '');
  return {
    async eval(script, keys = [], args = []) {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(['EVAL', script, String(keys.length), ...keys, ...args.map(String)]),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || !body || body.error) throw new Error(`upstash: ${body?.error ?? `HTTP ${response.status}`}`);
      return body.result;
    },
  };
}
export const fromIoredis = client => ({ eval: (script, keys = [], args = []) => client.eval(script, keys.length, ...keys, ...args.map(String)) });
export const fromNodeRedis = client => ({ eval: (script, keys = [], args = []) => client.eval(script, { keys, arguments: args.map(String) }) });

const STEP_BEGIN = `
local s = redis.call('HGET', KEYS[1], 'status')
local take = not s
if s == 'running' and ARGV[2] ~= '' then
  take = tonumber(redis.call('HGET', KEYS[1], 'at')) <= tonumber(ARGV[1]) - tonumber(ARGV[2])
end
if take then
  redis.call('HSET', KEYS[1], 'status', 'running', 'at', ARGV[1])
  redis.call('HDEL', KEYS[1], 'result')
  redis.call('PEXPIRE', KEYS[1], ARGV[3])
  return {'new'}
end
if s == 'running' then return {'running'} end
return {s, redis.call('HGET', KEYS[1], 'result') or 'null'}`;
const STEP_FINISH = `
redis.call('HSET', KEYS[1], 'status', ARGV[1], 'result', ARGV[2], 'at', ARGV[3])
redis.call('PEXPIRE', KEYS[1], ARGV[4])
return 1`;
const STEP_RELEASE = `
if redis.call('HGET', KEYS[1], 'status') == 'running' then redis.call('DEL', KEYS[1]) end
return 1`;
const COOLDOWN_CLAIM = `
local last = redis.call('GET', KEYS[1])
if last and tonumber(ARGV[1]) - tonumber(last) < tonumber(ARGV[2]) then return 0 end
redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
return 1`;
const COOLDOWN_PEEK = `
local last = redis.call('GET', KEYS[1])
if last and tonumber(ARGV[1]) - tonumber(last) < tonumber(ARGV[2]) then return 1 end
return 0`;
// Usage lives in a sorted set scored by time; each member ends in its amount.
const BUDGET_CLAIM = `
local now, window, amount, max = tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3]), tonumber(ARGV[4])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - window)
local used = 0
for _, member in ipairs(redis.call('ZRANGE', KEYS[1], 0, -1)) do
  used = used + tonumber(string.match(member, ':([^:]+)$'))
end
if used + amount > max then return 0 end
redis.call('ZADD', KEYS[1], now, ARGV[1] .. ':' .. ARGV[5] .. ':' .. ARGV[3])
redis.call('PEXPIRE', KEYS[1], ARGV[2])
return 1`;
const SCHEDULE = `
redis.call('ZADD', KEYS[1], ARGV[2], ARGV[1])
redis.call('HSET', KEYS[2], ARGV[1], ARGV[3])
return 1`;
const TAKE_DUE = `
local due = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
local out = {}
for _, key in ipairs(due) do
  table.insert(out, key)
  table.insert(out, redis.call('HGET', KEYS[2], key) or 'null')
  if ARGV[2] == '' then
    redis.call('ZREM', KEYS[1], key)
    redis.call('HDEL', KEYS[2], key)
  else
    redis.call('ZADD', KEYS[1], tonumber(ARGV[1]) + tonumber(ARGV[2]), key)
  end
end
return out`;
const CANCEL = `
local n = redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('HDEL', KEYS[2], ARGV[1])
return n`;
const NEXT_DUE = `
local first = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
if #first == 0 then return false end
return first[2]`;

const ms = x => String(Math.round(x));
let nonce = 0;

// stepTtl: how long a finished step is remembered, which is how long a retried
// request with the same key is recognised as a duplicate (default 7 days).
export function redisJournal(client, { prefix = 'jev:', stepTtl = 7 * 86400 } = {}) {
  requireAt(isClient(client), 'client', 'a Redis journal needs a client with eval(script, keys, args)', 'Pass upstash(), an @upstash/redis client, fromIoredis(client) or fromNodeRedis(client).');
  const k = (kind, name = '') => `${prefix}${kind}${name === '' ? '' : `:${name}`}`;
  const run = (script, keys, args) => client.eval(script, keys, args.map(String));
  const due = [k('due'), k('payload')];
  return {
    async beginStep(key, target, now, staleAfter = null) {
      const r = await run(STEP_BEGIN, [k('step', key)], [ms(now), staleAfter == null ? '' : ms(staleAfter), ms(1000 * stepTtl)]);
      if (r[0] === 'new' || r[0] === 'running') return r[0];
      return { status: r[0], result: JSON.parse(r[1]) };
    },
    async finishStep(key, status, result, now) {
      await run(STEP_FINISH, [k('step', key)], [status, JSON.stringify(result ?? null), ms(now), ms(1000 * stepTtl)]);
    },
    async releaseStep(key) { await run(STEP_RELEASE, [k('step', key)], []); },
    async claimCooldown(name, now, window) {
      return Number(await run(COOLDOWN_CLAIM, [k('cooldown', String(name))], [ms(now), ms(window)])) === 1;
    },
    async coolingDown(name, now, window) {
      return Number(await run(COOLDOWN_PEEK, [k('cooldown', String(name))], [ms(now), ms(window)])) === 1;
    },
    async claimBudget(name, now, window, amount, max) {
      nonce = (nonce + 1) % 1e9;
      const id = `${ms(now)}-${nonce}-${Math.random().toString(36).slice(2, 8)}`;
      return Number(await run(BUDGET_CLAIM, [k('budget', String(name))], [ms(now), ms(window), String(amount), String(max), id])) === 1;
    },
    async schedule(key, dueAt, payload) { await run(SCHEDULE, due, [key, ms(dueAt), JSON.stringify(payload)]); },
    async takeDue(now, lease = null) {
      const flat = await run(TAKE_DUE, due, [ms(now), lease == null ? '' : ms(lease)]);
      const items = [];
      for (let i = 0; i < flat.length; i += 2) items.push([flat[i], JSON.parse(flat[i + 1])]);
      return items;
    },
    async cancel(key) { return Number(await run(CANCEL, due, [key])) > 0; },
    async nextDue() {
      const first = await run(NEXT_DUE, [k('due')], []);
      return first === null || first === undefined || first === false ? null : Number(first);
    },
    close() {},
  };
}

const STORE_APPEND = `
if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
if ARGV[3] == '' then redis.call('SET', KEYS[1], ARGV[2]) else redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3]) end
redis.call('ZADD', KEYS[2], ARGV[1], ARGV[4])
redis.call('ZADD', KEYS[3], ARGV[1], ARGV[4])
return 1`;
// Newest `limit` ids at or after `since`, oldest first; ids whose record has
// expired are dropped from the index on the way.
const STORE_LIST = `
local ids = redis.call('ZREVRANGEBYSCORE', KEYS[1], '+inf', ARGV[1], 'LIMIT', 0, tonumber(ARGV[2]))
local out = {}
for i = #ids, 1, -1 do
  local value = redis.call('GET', ARGV[3] .. ids[i])
  if value then table.insert(out, value) else redis.call('ZREM', KEYS[1], ids[i]) end
end
return out`;
const STORE_GET = `return redis.call('GET', KEYS[1])`;

// Decision records with an optional time to live (seconds): retention without
// a cleanup job. The same interface as memoryStore and dbStore.
export function redisStore(client, { prefix = 'jev:', ttl = null } = {}) {
  requireAt(isClient(client), 'client', 'a Redis store needs a client with eval(script, keys, args)');
  requireAt(ttl === null || (Number.isFinite(ttl) && ttl > 0), 'ttl', 'ttl is positive seconds, or null to keep records');
  const rec = `${prefix}rec:`;
  const index = policy => policy == null ? `${prefix}recs` : `${prefix}recs:${policy}`;
  return {
    async append(run) {
      const record = recordOf(run);
      await client.eval(STORE_APPEND, [rec + record.id, index(null), index(record.policy ?? '-')],
        [ms(record.at), JSON.stringify(record), ttl === null ? '' : ms(1000 * ttl), record.id]);
      return record.id;
    },
    async get(id) {
      const value = await client.eval(STORE_GET, [rec + id], []);
      return value ? JSON.parse(value) : null;
    },
    async list({ policy = null, since = null, limit = null } = {}) {
      const values = await client.eval(STORE_LIST, [index(policy)], [since == null ? '-inf' : ms(since), String(limit ?? -1), rec]);
      return values.map(v => JSON.parse(v));
    },
    close() {},
  };
}

const SESSION_GET = `return redis.call('GET', KEYS[1])`;
const SESSION_SET = `redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2]) return 1`;
const SESSION_DEL = `return redis.call('DEL', KEYS[1])`;

// A session table for makeSessions({ table }): pending clarify questions live in
// Redis, so the reply can land on any instance. Entries expire after ttl seconds.
export function redisSessions(client, { prefix = 'jev:', ttl = 300 } = {}) {
  requireAt(isClient(client), 'client', 'a Redis session table needs a client with eval(script, keys, args)');
  const k = id => `${prefix}session:${id}`;
  return {
    async get(id) { const v = await client.eval(SESSION_GET, [k(id)], []); return v ? JSON.parse(v) : undefined; },
    async set(id, value) { await client.eval(SESSION_SET, [k(id)], [JSON.stringify(value), ms(1000 * ttl)]); },
    async delete(id) { return Number(await client.eval(SESSION_DEL, [k(id)], [])) > 0; },
  };
}
