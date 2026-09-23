import type { Journal } from './journal.js';
import type { Store } from './store.js';
import type { SessionTable } from './loop.js';

/** Anything with the @upstash/redis `eval` signature. */
export interface RedisClient { eval(script: string, keys: string[], args: string[]): Promise<unknown> }
export function upstash(options?: { url?: string; token?: string; fetch?: typeof fetch }): RedisClient;
export function fromIoredis(client: { eval(script: string, numkeys: number, ...rest: string[]): Promise<unknown> }): RedisClient;
export function fromNodeRedis(client: { eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown> }): RedisClient;
export function redisJournal(client: RedisClient, options?: { prefix?: string; stepTtl?: number }): Journal;
export function redisStore(client: RedisClient, options?: { prefix?: string; ttl?: number | null }): Store;
export function redisSessions(client: RedisClient, options?: { prefix?: string; ttl?: number }): SessionTable;
