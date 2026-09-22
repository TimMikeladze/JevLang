// Durable journals: SQLite through node:sqlite, and any SQL database a caller
// hands a driver for (PostgreSQL needs a driver, which this package does not
// depend on).
//
//   sqliteJournal('jev-journal.sqlite')
//   dbJournal({ dialect: 'postgres', query: async (sql, params) => rows, close })
//
// Each claim is a single conditional statement (INSERT ... ON CONFLICT ...
// RETURNING, or DELETE ... RETURNING), so processes sharing one database share
// cooldowns, idempotency and scheduled work without a coordinator. Budgets need
// a sum and an insert together, so they run in a transaction that locks the
// budget's row (PostgreSQL) or the database (SQLite, BEGIN IMMEDIATE).
//
// SQLite needs 3.35 or later, for RETURNING. Tables are created on first use,
// prefixed jev_.
import { requireAt } from './common.js';

const schema = (t, { serial, real }) => [
  `CREATE TABLE IF NOT EXISTS ${t('steps')} (key TEXT PRIMARY KEY, target TEXT, status TEXT NOT NULL, result TEXT, started_at BIGINT, finished_at BIGINT)`,
  `CREATE TABLE IF NOT EXISTS ${t('cooldowns')} (name TEXT PRIMARY KEY, last_at BIGINT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS ${t('budgets')} (name TEXT PRIMARY KEY)`,
  `CREATE TABLE IF NOT EXISTS ${t('budget_usage')} (id ${serial}, name TEXT NOT NULL, at BIGINT NOT NULL, amount ${real} NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS ${t('scheduled')} (key TEXT PRIMARY KEY, due_at BIGINT NOT NULL, payload TEXT NOT NULL)`,
];
const ms = x => Math.round(x);
// A driver may answer synchronously (node:sqlite does) or with a promise. This
// keeps a synchronous driver's transaction from yielding between BEGIN and
// COMMIT, which would deadlock a second connection on the same file.
const then = (value, fn) => value instanceof Promise ? value.then(fn) : fn(value);

// driver.query(sql, params) -> rows as objects; driver.transaction(thunk) runs a
// locking transaction; driver.close() releases it.
export function dbJournal(driver, { dialect = 'postgres', prefix = 'jev_' } = {}) {
  const t = name => `${prefix}${name}`;
  const sqlite = dialect === 'sqlite';
  // The statements are written with $1 placeholders; SQLite wants ?1.
  const sql = text => sqlite ? text.replace(/\$(\d+)/g, '?$1') : text;
  const query = (text, params = []) => driver.query(sql(text), params);
  const ready = (async () => {
    for (const statement of schema(t, { serial: sqlite ? 'INTEGER PRIMARY KEY AUTOINCREMENT' : 'BIGSERIAL PRIMARY KEY', real: sqlite ? 'REAL' : 'DOUBLE PRECISION' })) {
      await query(statement);
    }
  })();
  const journal = {
    async beginStep(key, target, now) {
      await ready;
      const claimed = await query(`INSERT INTO ${t('steps')} (key, target, status, started_at) VALUES ($1, $2, 'running', $3) ON CONFLICT (key) DO NOTHING RETURNING key`, [key, String(target), ms(now)]);
      if (claimed.length) return 'new';
      const rows = await query(`SELECT status, result FROM ${t('steps')} WHERE key = $1`, [key]);
      // Released between the two statements: treat it as in flight.
      if (!rows.length) return 'running';
      if (rows[0].status === 'running') return 'running';
      return { status: rows[0].status, result: typeof rows[0].result === 'string' ? JSON.parse(rows[0].result) : null };
    },
    async finishStep(key, status, result, now) {
      await ready;
      await query(`UPDATE ${t('steps')} SET status = $1, result = $2, finished_at = $3 WHERE key = $4`, [status, JSON.stringify(result ?? null), ms(now), key]);
    },
    async releaseStep(key) {
      await ready;
      await query(`DELETE FROM ${t('steps')} WHERE key = $1 AND status = 'running'`, [key]);
    },
    async claimCooldown(name, now, window) {
      await ready;
      const rows = await query(`INSERT INTO ${t('cooldowns')} (name, last_at) VALUES ($1, $2) ON CONFLICT (name) DO UPDATE SET last_at = excluded.last_at WHERE ${t('cooldowns')}.last_at <= $3 RETURNING name`,
        [String(name), ms(now), ms(now - window)]);
      return rows.length > 0;
    },
    async coolingDown(name, now, window) {
      await ready;
      const rows = await query(`SELECT name FROM ${t('cooldowns')} WHERE name = $1 AND last_at > $2`, [String(name), ms(now - window)]);
      return rows.length > 0;
    },
    async claimBudget(name, now, window, amount, max) {
      await ready;
      const id = String(name);
      // A sum and an insert together, so the transaction holds the row (or the
      // database) for both. Nothing awaits inside it on a synchronous driver.
      return driver.transaction(() => then(
        query(`INSERT INTO ${t('budgets')} (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`, [id]),
        () => then(sqlite ? [] : query(`SELECT name FROM ${t('budgets')} WHERE name = $1 FOR UPDATE`, [id]),
          () => then(query(`SELECT COALESCE(SUM(amount), 0) AS used FROM ${t('budget_usage')} WHERE name = $1 AND at > $2`, [id, ms(now - window)]),
            rows => {
              const used = Number(rows[0]?.used ?? 0);
              if (used + amount > max) return false;
              return then(query(`INSERT INTO ${t('budget_usage')} (name, at, amount) VALUES ($1, $2, $3)`, [id, ms(now), amount]), () => true);
            }))));
    },
    async schedule(key, due, payload) {
      await ready;
      await query(`INSERT INTO ${t('scheduled')} (key, due_at, payload) VALUES ($1, $2, $3) ON CONFLICT (key) DO UPDATE SET due_at = excluded.due_at, payload = excluded.payload`,
        [key, ms(due), JSON.stringify(payload)]);
    },
    async takeDue(now) {
      await ready;
      const rows = await query(`DELETE FROM ${t('scheduled')} WHERE due_at <= $1 RETURNING key, payload, due_at`, [ms(now)]);
      return rows.sort((a, b) => a.due_at - b.due_at).map(row => [row.key, JSON.parse(row.payload)]);
    },
    async cancel(key) {
      await ready;
      const rows = await query(`DELETE FROM ${t('scheduled')} WHERE key = $1 RETURNING key`, [key]);
      return rows.length > 0;
    },
    async nextDue() {
      await ready;
      const rows = await query(`SELECT MIN(due_at) AS due FROM ${t('scheduled')}`);
      const due = rows[0]?.due;
      return typeof due === 'number' ? due : null;
    },
    async close() { await ready; await driver.close?.(); },
  };
  return journal;
}

// node:sqlite is built in, so a durable journal needs no dependency.
export async function sqliteJournal(path, { prefix = 'jev_' } = {}) {
  const { DatabaseSync } = await import('node:sqlite');
  const database = new DatabaseSync(path);
  database.exec('PRAGMA journal_mode = WAL');
  database.exec('PRAGMA busy_timeout = 5000');
  const driver = {
    query(text, params = []) {
      const statement = database.prepare(text);
      // A statement that returns nothing still has to run.
      return /^\s*(SELECT|.*RETURNING)/is.test(text) ? statement.all(...params) : (statement.run(...params), []);
    },
    // Synchronous from BEGIN to COMMIT: a yield here would let another
    // connection in this process block the one holding the write lock.
    transaction(thunk) {
      database.exec('BEGIN IMMEDIATE');
      try {
        const result = thunk();
        if (result instanceof Promise) {
          database.exec('ROLLBACK');
          throw new TypeError('a SQLite transaction body must not await');
        }
        database.exec('COMMIT');
        return result;
      } catch (error) {
        try { database.exec('ROLLBACK'); } catch { /* the transaction is already gone */ }
        throw error;
      }
    },
    close() { database.close(); },
  };
  requireAt(typeof path === 'string' && path !== '', 'path', 'a SQLite journal needs a file path');
  return dbJournal(driver, { dialect: 'sqlite', prefix });
}
