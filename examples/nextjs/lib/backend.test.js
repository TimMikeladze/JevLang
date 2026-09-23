import { test, expect, beforeEach, afterAll } from 'bun:test';
import { doorstep } from './policies.js';
import { backend, resetBackend, recordDecision, recentDecisions } from './backend.js';
import { decideRequest } from './handle.js';

// The Redis half runs against any Upstash-compatible endpoint (see `npm run dev:redis`):
//   JEV_TEST_UPSTASH_URL=http://localhost:8089 JEV_TEST_UPSTASH_TOKEN=... npm test
const saved = { ...process.env };
const useMemory = () => { for (const k of ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'KV_REST_API_URL', 'KV_REST_API_TOKEN']) delete process.env[k]; };
beforeEach(() => { useMemory(); resetBackend(); });
afterAll(() => { Object.assign(process.env, saved); resetBackend(); });

const record = async noul => {
  const { state, facts } = doorstep.buildState({ message: 'nobody home', valueUsd: 40, raining: false });
  const decision = doorstep.decide({ situation: { choice: 'nobody-home', confidence: 0.95 }, 'unsafe?': { noul } }, { state, facts });
  await recordDecision({ policy: doorstep, state, facts, decision });
};
async function roundTrip() {
  await record(0.05);
  await record(0.9);
  await record(0.9);   // identical input is still its own record
  const [newest, , oldest] = await recentDecisions('doorstep-dispatch');
  expect(newest.decision.target).toBe('reattempt-tomorrow');
  expect(oldest.decision.target).toBe('leave-at-door');
  expect(newest.state).toEqual({ message: 'nobody home' });
  expect(newest.facts.valueUsd ?? newest.facts['value-usd']).toBe(40);
  expect(newest.fingerprint).toBe(doorstep.fingerprint());
}

test('memory: decisions round-trip newest first', async () => {
  expect(backend().name).toBe('memory');
  await roundTrip();
});

test('upstash: the same round trip through Redis', async () => {
  if (!process.env.JEV_TEST_UPSTASH_URL && !saved.JEV_TEST_UPSTASH_URL) return;
  process.env.UPSTASH_REDIS_REST_URL = saved.JEV_TEST_UPSTASH_URL;
  process.env.UPSTASH_REDIS_REST_TOKEN = saved.JEV_TEST_UPSTASH_TOKEN;
  resetBackend();
  expect(backend().name).toBe('upstash');
  // A fresh namespace per run: other runs' records stay out of the check.
  const { upstash, redisStore } = await import('jevlang/redis');
  backend().store = redisStore(upstash(), { prefix: `jevdemo-test:${Date.now()}:`, ttl: 60 });
  await roundTrip();
});

test('live model calls are rate limited per client; offline answers are not', async () => {
  process.env.RATE_LIMIT_PER_MINUTE = '2';
  process.env.JEV_PROVIDER = 'openai';
  process.env.OPENAI_API_KEY = 'test';
  resetBackend();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ choices: [{ message: { content: JSON.stringify({ situation: { type: 'choice', choice: 'nobody-home', confidence: 0.9 }, 'unsafe?': { type: 'noul', noul: 0.1 } }) } }] });
  try {
    const post = (ip, body) => decideRequest(doorstep, new Request('http://x/api/doorstep', { method: 'POST', headers: { 'x-forwarded-for': ip }, body: JSON.stringify(body) }));
    const input = { message: 'nobody home', valueUsd: 40, raining: false };
    expect((await post('1.1.1.1', { input })).status).toBe(200);
    expect((await post('1.1.1.1', { input })).status).toBe(200);
    const limited = await post('1.1.1.1', { input });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('60');
    expect((await post('2.2.2.2', { input })).status).toBe(200);
    const answers = { situation: { choice: 'nobody-home', confidence: 0.9 }, 'unsafe?': { noul: 0.1 } };
    expect((await post('1.1.1.1', { input, answers })).status).toBe(200);
  } finally {
    globalThis.fetch = originalFetch;
    for (const k of ['RATE_LIMIT_PER_MINUTE', 'JEV_PROVIDER', 'OPENAI_API_KEY']) delete process.env[k];
  }
});

test('an unknown provider or a missing key is reported, not attempted', async () => {
  const input = { message: 'nobody home', valueUsd: 40, raining: false };
  const post = () => decideRequest(doorstep, new Request('http://x', { method: 'POST', body: JSON.stringify({ input }) }));
  try {
    process.env.JEV_PROVIDER = 'nope';
    expect((await post()).status).toBe(500);
    process.env.JEV_PROVIDER = 'anthropic';
    delete process.env.ANTHROPIC_API_KEY;
    const missing = await post();
    expect(missing.status).toBe(503);
    expect((await missing.json()).error).toContain('ANTHROPIC_API_KEY');
  } finally { delete process.env.JEV_PROVIDER; }
});
