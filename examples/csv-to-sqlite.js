// CSV files into existing SQLite tables. Code parses the files and writes the
// rows; the model only picks, for each file, a table the database has, and for
// each header, a column that table has. Both are choices built at run time from
// the schema, so an answer naming a table or column that doesn't exist fails
// validation instead of reaching an INSERT.
//
// A file is written only when every choice cleared its gate and no two headers
// landed on the same column. Anything else comes back as `review` with the
// reasons, and nothing from that file is inserted.
//
//   node examples/csv-to-sqlite.js shop.sqlite examples/csv/*.csv --schema examples/csv/schema.sql
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { choice, definePolicy, gate, rule, assign, escalate, record, evaluateMany } from '../src/index.js';
import { evaluateWithProvider } from '../src/evaluate.js';
import { dbAnswerCache } from '../src/store.js';

const SAMPLE_ROWS = 3;

const table = choice('table', 'Which of `tables` should the rows of this CSV file be loaded into? `schema` lists each table\'s columns.', {
  none: 'None of the tables holds this kind of data',
}, { optionsFrom: 'tables' });

export const tablePolicy = definePolicy({
  name: 'csv-table', version: '1', model: 'jev-1.14.0',
  questions: [table],
  state: {
    file: { path: ['file'] },
    headers: { path: ['headers'] },
    samples: { path: ['samples'], maxChars: 2000 },
    tables: { path: ['tables'] },
    schema: { path: ['schema'] },
  },
  gates: [gate(table, 0.7, escalate('review', { reason: 'not sure which table this file belongs to' }))],
  route: {
    clauses: [rule(table.is('none'), escalate('review', { reason: 'no table fits this file' }))],
    otherwise: assign('load', { data: record({ table: table.chosen() }) }),
  },
});

const column = choice('column', 'Which of `columns` in table `table` should values from the CSV column `header` (examples in `samples`) be stored in?', {
  skip: 'No listed column fits',
}, { optionsFrom: 'columns' });

export const columnPolicy = definePolicy({
  name: 'csv-column', version: '1', model: 'jev-1.14.0',
  questions: [column],
  state: {
    header: { path: ['header'] },
    samples: { path: ['samples'], maxChars: 500 },
    table: { path: ['table'] },
    columns: { path: ['columns'] },
  },
  gates: [gate(column, 0.7, escalate('review', { reason: 'not sure which column this header fills' }))],
  route: {
    clauses: [rule(column.is('skip'), assign('skip'))],
    otherwise: assign('map', { data: record({ column: column.chosen() }) }),
  },
});

// RFC 4180: quoted fields, "" inside quotes, CRLF or LF. Blank lines are dropped.
export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(f => f !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some(f => f !== '')) rows.push(row);
  const [headers = [], ...body] = rows;
  return { headers, rows: body };
}

// Tables and their writable columns. An INTEGER PRIMARY KEY is the rowid, so
// it is left for SQLite to fill and never offered as an option.
export function readSchema(db) {
  const schema = {};
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'jev_%' ORDER BY name").all()) {
    schema[name] = db.prepare(`PRAGMA table_info("${name.replaceAll('"', '""')}")`).all()
      .filter(c => !(c.pk && /^INTEGER$/i.test(c.type)))
      .map(c => ({ name: c.name, type: c.type || 'ANY' }));
  }
  return schema;
}

const live = (policy, input, { cache }) => evaluateWithProvider(policy, input, { cache });
const quote = name => `"${name.replaceAll('"', '""')}"`;

// file: { name, csv }. Returns { status: 'inserted', table, mapping, rows }
// or { status: 'review', table?, mapping?, reasons }.
export async function ingestFile(db, file, { evaluate = live, cache = new Map(), workers = 8 } = {}) {
  const { headers, rows } = parseCsv(file.csv);
  const schema = readSchema(db);
  const samples = rows.slice(0, SAMPLE_ROWS);
  // Blank cells say nothing about a column, so each header gets its first non-empty values.
  const valuesOf = i => rows.map(r => r[i] ?? '').filter(v => v !== '').slice(0, SAMPLE_ROWS);
  const picked = await evaluate(tablePolicy, {
    file: file.name, headers, samples,
    tables: Object.keys(schema),
    schema: Object.entries(schema).map(([t, cols]) => `${t}(${cols.map(c => `${c.name} ${c.type}`).join(', ')})`).join('\n'),
  }, { cache });
  if (picked.action !== 'assign') return { status: 'review', reasons: [`file: ${picked.reason}`] };
  const target = picked.data.table;
  const columns = schema[target].map(c => c.name);

  const { results } = await evaluateMany(
    i => evaluate(columnPolicy, {
      header: headers[i], samples: valuesOf(i), table: target, columns,
    }, { cache }),
    headers.map((_, i) => i), { workers },
  );
  const mapping = {}, reasons = [], used = new Map();
  results.forEach((d, i) => {
    const header = headers[i];
    if (d instanceof Error) return reasons.push(`${header}: ${d.message}`);
    if (d.action === 'escalate') return reasons.push(`${header}: ${d.reason}`);
    if (d.target === 'skip') return mapping[header] = null;
    const col = d.data.column;
    if (used.has(col)) reasons.push(`${header}: ${col} is already filled by ${used.get(col)}`);
    used.set(col, header);
    mapping[header] = col;
  });
  if (reasons.length) return { status: 'review', table: target, mapping, reasons };

  const pairs = headers.map((h, i) => [mapping[h], i]).filter(([col]) => col);
  if (!pairs.length) return { status: 'review', table: target, mapping, reasons: ['no header maps to a column'] };
  const insert = db.prepare(`INSERT INTO ${quote(target)} (${pairs.map(([c]) => quote(c)).join(', ')}) VALUES (${pairs.map(() => '?').join(', ')})`);
  db.exec('BEGIN');
  try {
    for (const row of rows) insert.run(...pairs.map(([, i]) => row[i] === '' || row[i] === undefined ? null : row[i]));
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    return { status: 'review', table: target, mapping, reasons: [`insert failed: ${error.message}`] };
  }
  return { status: 'inserted', table: target, mapping, rows: rows.length };
}

// The query shape dbAnswerCache takes, over node:sqlite.
export const sqliteDriver = db => ({
  query(text, params = []) {
    const statement = db.prepare(text);
    return /^\s*SELECT|\bRETURNING\b/i.test(text) ? statement.all(...params) : (statement.run(...params), []);
  },
});

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const args = process.argv.slice(2);
  const at = args.indexOf('--schema');
  const schemaFile = at >= 0 ? args.splice(at, 2)[1] : null;
  const [dbPath, ...files] = args;
  if (!dbPath || !files.length) {
    console.error('usage: node examples/csv-to-sqlite.js DB.sqlite FILE.csv... [--schema schema.sql]');
    process.exit(2);
  }
  const db = new DatabaseSync(dbPath);
  if (schemaFile) db.exec(readFileSync(schemaFile, 'utf8'));
  // Answers live next to the data, so a re-run over the same files asks nothing.
  const cache = await dbAnswerCache(sqliteDriver(db), { dialect: 'sqlite', scope: 'csv-to-sqlite' });
  let held = 0;
  for (const path of files) {
    const result = await ingestFile(db, { name: basename(path), csv: readFileSync(path, 'utf8') }, { cache });
    if (result.status !== 'inserted') held += 1;
    console.log(JSON.stringify({ file: path, ...result }));
  }
  await cache.flush();
  db.close();
  process.exit(held ? 1 : 0);
}
