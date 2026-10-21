import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { parseCsv, readSchema, ingestFile, tablePolicy } from '../examples/csv-to-sqlite.js';

const read = name => readFileSync(new URL(`../examples/csv/${name}`, import.meta.url), 'utf8');
const shop = () => {
  const db = new DatabaseSync(':memory:');
  db.exec(read('schema.sql'));
  return db;
};

// Answers by file name for the table, by header for the column. A missing
// entry throws, so a test fails loudly if the example asks something new.
const answering = ({ tables = {}, columns = {} }) => (policy, input) => {
  const answer = policy === tablePolicy
    ? { table: tables[input.file] }
    : { column: columns[input.header] };
  if (!Object.values(answer)[0]) throw new Error(`no answer for ${input.file ?? input.header}`);
  const { state, facts } = policy.buildState(input);
  return policy.decide(answer, { state, facts });
};

const crm = {
  tables: { 'crm-export.csv': { choice: 'customers', confidence: 0.95 } },
  columns: {
    'Full Name': { choice: 'name', confidence: 0.97 },
    'E-mail Address': { choice: 'email', confidence: 0.99 },
    Nation: { choice: 'country', confidence: 0.9 },
    Fax: { choice: 'skip', confidence: 0.92 },
  },
};

test('parseCsv: quoted commas, escaped quotes, CRLF and blank lines', () => {
  assert.deepEqual(parseCsv('a,b\r\n"x, y","say ""hi"""\r\n\r\n1,\n'), {
    headers: ['a', 'b'],
    rows: [['x, y', 'say "hi"'], ['1', '']],
  });
});

test('readSchema: the rowid primary key is not offered as a column', () => {
  assert.deepEqual(readSchema(shop()).customers.map(c => c.name), ['name', 'email', 'country']);
});

test('ingestFile: maps headers onto the chosen table and inserts every row', async () => {
  const db = shop();
  const result = await ingestFile(db, { name: 'crm-export.csv', csv: read('crm-export.csv') }, { evaluate: answering(crm) });
  assert.deepEqual(result, {
    status: 'inserted', table: 'customers', rows: 2,
    mapping: { 'Full Name': 'name', 'E-mail Address': 'email', Nation: 'country', Fax: null },
  });
  assert.deepEqual(db.prepare('SELECT name, email, country FROM customers ORDER BY id').all().map(r => ({ ...r })), [
    { name: 'Ada Lovelace', email: 'ada@example.com', country: 'UK' },
    { name: 'Hopper, Grace', email: 'grace@example.com', country: 'US' },
  ]);
});

test('ingestFile: one unsure header holds the whole file for review', async () => {
  const db = shop();
  const unsure = { ...crm, columns: { ...crm.columns, Nation: { choice: 'country', confidence: 0.4 } } };
  const result = await ingestFile(db, { name: 'crm-export.csv', csv: read('crm-export.csv') }, { evaluate: answering(unsure) });
  assert.equal(result.status, 'review');
  assert.deepEqual(result.reasons, ['Nation: not sure which column this header fills']);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM customers').get().n, 0);
});

test('ingestFile: two headers on one column is a review, not an overwrite', async () => {
  const db = shop();
  const clash = { ...crm, columns: { ...crm.columns, Fax: { choice: 'email', confidence: 0.8 } } };
  const result = await ingestFile(db, { name: 'crm-export.csv', csv: read('crm-export.csv') }, { evaluate: answering(clash) });
  assert.deepEqual(result.reasons, ['Fax: email is already filled by E-mail Address']);
});

test('ingestFile: a file no table fits is not inserted, and an invented table is rejected', async () => {
  const db = shop();
  const none = await ingestFile(db, { name: 'x.csv', csv: 'a\n1\n' }, { evaluate: answering({ tables: { 'x.csv': { choice: 'none', confidence: 0.9 } } }) });
  assert.deepEqual(none, { status: 'review', reasons: ['file: no table fits this file'] });
  await assert.rejects(
    ingestFile(db, { name: 'x.csv', csv: 'a\n1\n' }, { evaluate: answering({ tables: { 'x.csv': { choice: 'invoices', confidence: 0.9 } } }) }),
    /not a declared option/,
  );
});
