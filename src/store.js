// Decision records in a place you choose. The engine decides in memory and the
// journal covers dispatch durability; a store keeps what a decision was about,
// so an embedded app keeps its own history — replayable with `replay`,
// summarizable with `summarize`, auditable on its own disk.
//
//   const store = sqliteStore('jev-decisions.sqlite')
//   await store.append({ policy: 'support-routing', input, answers, decision })
//   const recent = await store.list({ policy: 'support-routing', limit: 100 })
//
// The same shape as the journal: an interface, memory and SQL backends, and a
// SQLite file this module opens itself. Appends are idempotent on `id`, which
// defaults to the fingerprint of the record — recording the same run twice
// stores it once.
//
//   withStore(evaluate, store, { policy })   wraps any evaluate(input)
//   makeLoop({ store })                      records every event's decision
//
// A recording failure rejects (the caller decides whether a decision that
// cannot be written down should still be acted on); a null decision is not
// recorded. Recording never changes the decision itself.
import { appendFileSync, readFileSync } from 'node:fs';
import { fingerprint, requireAt } from './common.js';

// record: { id?, at?, policy?, input, answers?, decision, key? }
export function recordOf(run, at = Date.now()) {
  requireAt(run && typeof run === 'object', 'record', 'a store record is an object');
  requireAt(run.decision !== undefined && run.decision !== null, 'decision', 'a store record needs a decision');
  const record = {
    at: typeof run.at === 'number' ? run.at : at,
    policy: run.policy ?? null,
    input: run.input ?? null,
    answers: run.answers ?? null,
    decision: run.decision,
    key: run.key ?? null,
  };
  // The id is the fingerprint of everything but `at`, so the same run recorded
  // twice — at slightly different times — is still one record.
  const { at: when, ...core } = record;
  record.id = typeof run.id === 'string' && run.id !== '' ? run.id : fingerprint(core);
  return record;
}

const matches = (r, { policy = null, since = null } = {}) =>
  (policy === null || r.policy === policy) && (since === null || r.at >= since);

export function memoryStore() {
  const rows = new Map();
  return {
    append(run) {
      const record = recordOf(run);
      if (rows.has(record.id)) return record.id;
      rows.set(record.id, record);
      return record.id;
    },
    get(id) { return rows.get(id) ?? null; },
    list(options = {}) {
      const found = [...rows.values()].filter(r => matches(r, options)).sort((a, b) => a.at - b.at);
      return options.limit ? found.slice(-options.limit) : found;
    },
    close() {},
  };
}

export function ndjsonStore(path) {
  requireAt(typeof path === 'string' && path !== '', 'path', 'an ndjson store needs a file path');
  const { appendFileSync: appendFile, readFileSync: readFile } = { appendFileSync, readFileSync };
  const write = record => appendFile(path, JSON.stringify(record) + '\n');
  const read = () => {
    try { return readFile(path, 'utf8').split('\n').filter(Boolean).map(JSON.parse); }
    catch { return []; } // nothing written yet
  };
  return {
    append(run) {
      const record = recordOf(run);
      if (!read().some(r => r.id === record.id)) write(record);
      return record.id;
    },
    get(id) { return read().find(r => r.id === id) ?? null; },
    list(options = {}) {
      const found = read().filter(r => matches(r, options)).sort((a, b) => a.at - b.at);
      return options.limit ? found.slice(-options.limit) : found;
    },
    close() {},
  };
}

const schema = t => [
  `CREATE TABLE IF NOT EXISTS ${t} (id TEXT PRIMARY KEY, at BIGINT NOT NULL, policy TEXT, key TEXT, input TEXT, answers TEXT, decision TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS ${t}_at ON ${t} (at)`,
  `CREATE INDEX IF NOT EXISTS ${t}_policy_at ON ${t} (policy, at)`,
];

// driver.query(sql, params) -> rows as objects (the same SqlDriver a journal
// takes). Tables are created on first use, prefixed jev_ by default.
export function dbStore(driver, { dialect = 'postgres', prefix = 'jev_' } = {}) {
  const t = `${prefix}decisions`;
  const sql = text => dialect === 'sqlite' ? text.replace(/\$(\d+)/g, '?$1') : text;
  const query = (text, params = []) => driver.query(sql(text), params);
  const then = (value, fn) => value instanceof Promise ? value.then(fn) : fn(value);
  const parse = r => ({
    id: r.id, at: Number(r.at), policy: r.policy ?? null, key: r.key ?? null,
    input: r.input === null ? null : JSON.parse(r.input),
    answers: r.answers === null ? null : JSON.parse(r.answers),
    decision: JSON.parse(r.decision),
  });
  const ready = (async () => { for (const statement of schema(t)) await query(statement); })();
  return {
    async append(run) {
      await ready;
      const record = recordOf(run);
      await query(
        `INSERT INTO ${t} (id, at, policy, key, input, answers, decision) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (id) DO NOTHING`,
        [record.id, Math.round(record.at), record.policy, record.key,
         JSON.stringify(record.input ?? null), JSON.stringify(record.answers ?? null), JSON.stringify(record.decision)]);
      return record.id;
    },
    async get(id) {
      await ready;
      const rows = await query(`SELECT * FROM ${t} WHERE id = $1`, [id]);
      return rows.length ? parse(rows[0]) : null;
    },
    async list(options = {}) {
      await ready;
      const where = [], params = [];
      if (options.policy !== null && options.policy !== undefined) { where.push(`policy = $${params.length + 1}`); params.push(options.policy); }
      if (options.since !== null && options.since !== undefined) { where.push(`at >= $${params.length + 1}`); params.push(Math.round(options.since)); }
      const limit = options.limit ? ` LIMIT $${params.length + 1}` : '';
      if (limit) params.push(options.limit);
      // The newest `limit`, oldest first, as memoryStore returns them.
      const rows = await query(`SELECT * FROM ${t}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY at DESC${limit}`, params);
      return rows.map(parse).reverse();
    },
    async close() { await ready; await driver.close?.(); },
  };
}

export async function sqliteStore(path, { prefix = 'jev_' } = {}) {
  const { DatabaseSync } = await import('node:sqlite');
  const database = new DatabaseSync(path);
  database.exec('PRAGMA journal_mode = WAL');
  database.exec('PRAGMA busy_timeout = 5000');
  const driver = {
    query(text, params = []) {
      const statement = database.prepare(text);
      return /^\s*(SELECT|.*RETURNING)/is.test(text) ? statement.all(...params) : (statement.run(...params), []);
    },
    close() { database.close(); },
  };
  requireAt(typeof path === 'string' && path !== '', 'path', 'a SQLite store needs a file path');
  return dbStore(driver, { dialect: 'sqlite', prefix });
}

export const isStore = value => !!(value && typeof value.append === 'function' && typeof value.list === 'function');

// Wrap any evaluate(input) — the one function makeLoop, serve and resolve all
// take — so every decision it returns is recorded. The decision passes through
// unchanged; a null decision (a precheck that decided nothing) is not recorded.
export function withStore(evaluate, store, { policy = null, key = null, clock = () => Date.now() } = {}) {
  requireAt(typeof evaluate === 'function', 'evaluate', 'withStore wraps an evaluate function');
  requireAt(isStore(store), 'store', 'withStore needs a store');
  return async input => {
    const decision = await evaluate(input);
    if (decision !== null && decision !== undefined) {
      await store.append({ policy, input, decision, key, at: clock() });
    }
    return decision;
  };
}
