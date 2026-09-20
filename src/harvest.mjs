// Label harvesting: decided cases plus what people did with them become labeled
// fixtures that tuning and calibration read.
//
// A store is a directory with three subdirectories, one JSON file per case:
//
//   pending/    decided, no outcome yet
//   labeled/    settled with a label (strong or weak)
//   unlabeled/  settled, but nothing says what the right decision was
//
// Each file is a version 3 fixture, so replay, diff and tune read labeled/
// directly, plus case_id, decided_at, escalated, the outcome history, and once
// settled label_strength, label_source and settled_at.
//
// The label is derived from the whole history every time an outcome arrives, so
// the rules hold whatever order things came in:
//
//   a correction (a person changed the decision)  -> strong, its label; the last
//       correction wins, and a close after a correction keeps it
//   a close with a label                          -> strong, that label
//   a close without one                           -> strong, the decision
//       stands; unless the policy escalated, then unlabeled (nothing known)
//   no outcome after N days (a settle)            -> weak, the decision; an
//       escalation goes to unlabeled
//
// A weak label is silence taken as agreement, which tuning can leave out.
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { object, own, requireAt } from './common.mjs';

const sha256Hex = text => createHash('sha256').update(text, 'utf8').digest('hex');
const iso = seconds => new Date(seconds * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
const safeChar = c => /[A-Za-z0-9._-]/.test(c);
const escapeChar = c => [...Buffer.from(c, 'utf8')].map(b => `%${b.toString(16).toUpperCase().padStart(2, '0')}`).join('');
const maxName = 64;

// A case id as a file name: characters outside [A-Za-z0-9._-] become %XX (UTF-8
// bytes), as does a leading dot, so no id can climb out of the store or hide. An
// escaped name longer than 64 characters is cut at a character boundary and gets
// "~" plus 16 hex digits of the id's SHA-256; "~" never occurs in an escaped
// name, so a cut name cannot equal an uncut one.
export function safeCaseName(id) {
  const s = typeof id === 'string' ? id : String(id);
  requireAt(s !== '', 'caseId', 'a case id must not be empty');
  const pieces = [...s].map((c, i) => (safeChar(c) && !(i === 0 && c === '.') ? c : escapeChar(c)));
  const whole = pieces.join('');
  if (whole.length <= maxName) return whole;
  let kept = '';
  for (const piece of pieces) {
    if (kept.length + piece.length > maxName) break;
    kept += piece;
  }
  return `${kept}~${sha256Hex(s).slice(0, 16)}`;
}

const decisionKinds = ['assign', 'page', 'escalate', 'hold', 'confirm', 'next', 'act', 'plan'];
const checkAction = (action, what) => {
  requireAt(decisionKinds.includes(action), what, `'${action}' is not a decision kind`, `One of: ${decisionKinds.join(', ')}.`);
  return action;
};
// "assign:billing-queue" or "hold" -> { action, target? }
export function parseLabelSpec(text) {
  const m = /^\s*([^:\s]+)\s*(?::\s*(\S.*?)\s*)?$/.exec(text);
  requireAt(m, 'label', 'a label is action[:target], like assign:billing-queue');
  const action = checkAction(m[1], `label '${text}'`);
  return m[2] ? { action, target: m[2] } : { action };
}
// A label in the fixture format: a decision, that object, or "action[:target]".
export function normalizeLabel(v) {
  if (typeof v === 'string') return parseLabelSpec(v);
  requireAt(object(v), 'label', 'a label is {action, target}, a decision, or "action[:target]"');
  const action = v.action;
  requireAt(typeof action === 'string', 'label',
    'a label needs an "action", like {"action": "assign", "target": "billing-queue"}');
  checkAction(action, 'label');
  const target = v.target ?? null;
  if (target === null) return { action };
  requireAt(typeof target === 'string', 'label', 'a label\'s "target" must be a string');
  return { action, target };
}
export const labelToString = l => object(l) && l.target ? `${l.action} ${l.target}` : `${object(l) ? l.action ?? '?' : '?'}`;
// A gate or band fired, so the model was not sure enough.
export const escalationDecision = d => ['gate', 'option-gate', 'band'].includes(d?.rule);
// An escalation says "a person decides", so a close without a label says nothing
// about what the right decision was.
export const escalatedDecision = d => escalationDecision(d) || ['hold', 'confirm', 'escalate'].includes(d?.action);

const wheres = ['pending', 'labeled', 'unlabeled'];
export const harvestDirs = dir => wheres.map(where => join(dir, where));
const casePath = (dir, where, name) => join(dir, where, `${name}.json`);
const writeRecord = async (path, record) => {
  await mkdir(join(path, '..'), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`);
  await rename(temporary, path);
};
const readRecord = async path => {
  const value = JSON.parse(await readFile(path, 'utf8'));
  requireAt(object(value), path, 'not a JSON object');
  return value;
};

// -> { where, record, path }, or nulls when the case is unknown. A crash between
// writing a case's new file and deleting its old one leaves it in two places;
// the copy with the longer history wins and the other goes.
export async function harvestFind(dir, id) {
  const sid = String(id);
  const name = safeCaseName(sid);
  const found = [];
  for (const where of wheres) {
    const path = casePath(dir, where, name);
    if (!existsSync(path)) continue;
    const record = await readRecord(path);
    const stored = record.case_id;
    requireAt(typeof stored !== 'string' || stored === sid, path,
      `case ids '${stored}' and '${sid}' map to the same file`,
      'The file system ignores letter case; make the ids differ by more than case.');
    found.push({ where, record, path });
  }
  if (!found.length) return { where: null, record: null, path: null };
  const best = found.reduce((a, b) => ((b.record.outcomes ?? []).length > (a.record.outcomes ?? []).length ? b : a));
  for (const other of found) if (other !== best) await unlink(other.path);
  return best;
}

// Saves a decided case as pending. fixture is a version 3 fixture (from
// fixtureFromRun), decision the policy's decision. A second case with the same
// id replaces a pending one and keeps its history; a settled case is left alone.
export async function harvestAdd(dir, { caseId, fixture, decision, source = null, now = () => Math.floor(Date.now() / 1000) } = {}) {
  const sid = String(caseId);
  const name = safeCaseName(sid);
  const found = await harvestFind(dir, sid);
  if (found.where && found.where !== 'pending') {
    return {
      caseId: sid, where: found.where, label: found.record.label ?? null,
      strength: found.record.label_strength ?? null, source: found.record.label_source ?? null,
      path: found.path, status: 'settled',
    };
  }
  const record = {
    ...fixture,
    name,
    case_id: sid,
    decided_at: iso(now()),
    escalated: escalatedDecision(decision),
    outcomes: found.record ? found.record.outcomes ?? [] : [],
    ...(source ? { source: String(source) } : {}),
    ...(decision ? { expect: { action: decision.action, ...(decision.target ? { target: decision.target } : {}) } } : {}),
  };
  const path = casePath(dir, 'pending', name);
  await writeRecord(path, record);
  return { caseId: sid, where: 'pending', label: null, strength: null, source: null, path, status: found.record ? 'updated' : 'added' };
}

const lastWhere = (list, predicate) => list.filter(predicate).pop() ?? null;
// The settle rules, over the whole history.
export function deriveLabel(record) {
  const outcomes = record.outcomes ?? [];
  const escalated = record.escalated === true;
  const expect = object(record.expect) ? record.expect : null;
  const correction = lastWhere(outcomes, o => o.kind === 'correction');
  const labeledClose = lastWhere(outcomes, o => o.kind === 'close' && object(o.label));
  const close = lastWhere(outcomes, o => o.kind === 'close');
  const timeout = lastWhere(outcomes, o => o.kind === 'timeout');
  if (correction) return { where: 'labeled', label: correction.label, strength: 'strong', source: 'correction' };
  if (labeledClose) return { where: 'labeled', label: labeledClose.label, strength: 'strong', source: 'close' };
  if (close) {
    return escalated || !expect
      ? { where: 'unlabeled', label: null, strength: null, source: 'close' }
      : { where: 'labeled', label: expect, strength: 'strong', source: 'close' };
  }
  if (timeout) {
    return escalated || !expect
      ? { where: 'unlabeled', label: null, strength: null, source: 'timeout' }
      : { where: 'labeled', label: expect, strength: 'weak', source: 'timeout' };
  }
  return { where: 'pending', label: null, strength: null, source: null };
}
// Per-question labels from every outcome, later ones winning per question.
const mergedLabels = record => (record.outcomes ?? []).reduce(
  (acc, o) => (object(o.labels) ? { ...acc, ...o.labels } : acc),
  object(record.labels) ? { ...record.labels } : {});

// Re-derives the label and moves the file to where it now belongs.
async function settleRecord(dir, record, oldPath, now) {
  const { where, label, strength, source } = deriveLabel(record);
  const labels = mergedLabels(record);
  const { label: _l, label_strength: _s, label_source: _src, settled_at: _at, labels: _ls, ...base } = record;
  const settled = {
    ...base,
    ...(Object.keys(labels).length ? { labels } : {}),
    ...(label ? { label, label_strength: strength } : {}),
    ...(where === 'pending' ? {} : { label_source: source, settled_at: iso(now()) }),
  };
  const path = casePath(dir, where, safeCaseName(record.case_id));
  await writeRecord(path, settled);
  if (oldPath && resolvePath(oldPath) !== resolvePath(path)) await unlink(oldPath);
  return { caseId: record.case_id, where, label, strength, source, path, status: 'updated' };
}

// kind : 'correction' (a person changed the decision; needs a label) or 'close'
export async function harvestOutcome(dir, id, kind, { label = null, labels = null, now = () => Math.floor(Date.now() / 1000) } = {}) {
  requireAt(['correction', 'close'].includes(kind), 'kind', "an outcome is 'correction' or 'close'");
  requireAt(kind !== 'correction' || label, 'label',
    'a correction needs the label the person chose', 'Pass a label, or record a close.');
  requireAt(labels === null || object(labels), 'labels', 'per-question labels are an object, like {"department": "billing"}');
  const normalized = label ? normalizeLabel(label) : null;
  const found = await harvestFind(dir, id);
  if (!found.where) return { caseId: String(id), where: null, label: null, strength: null, source: null, path: null, status: 'unknown' };
  const outcome = { kind, label: normalized, labels, at: iso(now()) };
  return settleRecord(dir, { ...found.record, outcomes: [...(found.record.outcomes ?? []), outcome] }, found.path, now);
}

// "2026-09-18T12:00:00Z" -> seconds, or null
export function parseIso8601(text) {
  if (typeof text !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(text)) return null;
  const at = Date.parse(text);
  return Number.isFinite(at) ? Math.floor(at / 1000) : null;
}
const pendingPaths = async dir => {
  const d = join(dir, 'pending');
  if (!existsSync(d)) return [];
  return (await readdir(d)).filter(f => f.endsWith('.json')).sort().map(f => join(d, f));
};

// Settles every pending case decided at least `after` seconds ago as a timeout.
// With dryRun, says what would happen and writes nothing. Files whose decided_at
// cannot be read are skipped and named.
export async function harvestSettle(dir, { after = 7 * 86400, now = () => Math.floor(Date.now() / 1000), dryRun = false } = {}) {
  const at = now();
  const done = [], skipped = [];
  for (const path of await pendingPaths(dir)) {
    let record = null;
    try { record = await readRecord(path); } catch { record = null; }
    const decided = record ? parseIso8601(record.decided_at) : null;
    if (!record || decided === null || typeof record.case_id !== 'string') { skipped.push(path); continue; }
    if (at - decided < after) continue;
    const updated = { ...record, outcomes: [...(record.outcomes ?? []), { kind: 'timeout', label: null, labels: null, at: iso(at) }] };
    done.push(dryRun
      ? { caseId: record.case_id, ...deriveLabel(updated), path, status: 'updated' }
      : await settleRecord(dir, updated, path, () => at));
  }
  return { settled: done, skipped };
}

// Counts for a status report. after and now say how many pending cases a settle
// would time out.
export async function harvestStatus(dir, { after = 7 * 86400, now = () => Math.floor(Date.now() / 1000) } = {}) {
  const at = now();
  const records = async where => {
    const d = join(dir, where);
    if (!existsSync(d)) return [];
    const files = (await readdir(d)).filter(f => f.endsWith('.json')).sort();
    const out = [];
    for (const file of files) {
      try { out.push(await readRecord(join(d, file))); } catch { /* unreadable files are not counted */ }
    }
    return out;
  };
  const pending = await records('pending');
  const labeled = await records('labeled');
  const unlabeled = await records('unlabeled');
  const countBy = (key, rs) => rs.reduce((acc, r) => {
    const k = typeof r[key] === 'string' ? r[key] : 'unknown';
    return { ...acc, [k]: (acc[k] ?? 0) + 1 };
  }, {});
  const ages = pending.map(r => parseIso8601(r.decided_at)).filter(a => a !== null);
  return {
    dir: resolvePath(dir),
    pending: pending.length,
    pending_due: ages.filter(a => at - a >= after).length,
    oldest_pending_seconds: ages.length ? at - Math.min(...ages) : null,
    labeled: labeled.length,
    strong: labeled.filter(r => r.label_strength === 'strong').length,
    weak: labeled.filter(r => r.label_strength === 'weak').length,
    labeled_by_source: countBy('label_source', labeled),
    unlabeled: unlabeled.length,
    unlabeled_by_source: countBy('label_source', unlabeled),
  };
}
