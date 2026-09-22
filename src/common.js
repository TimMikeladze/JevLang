import { createHash } from 'node:crypto';

export class JevError extends Error {
  constructor(code, path, message, fix) {
    super(`${path}: ${message}${fix ? `\n  ${fix}` : ''}`);
    this.name = 'JevError';
    this.code = code;
    this.path = path;
    this.fix = fix ?? null;
  }
  toJSON() { return { code: this.code, path: this.path, message: this.message, fix: this.fix }; }
}
export const own = (o, k) => o != null && Object.hasOwn(o, k);
export const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
export const fail = (code, path, message, fix) => { throw new JevError(code, path, message, fix); };
export function requireAt(ok, path, message, fix, code = 'validation') {
  if (!ok) fail(code, path, message, fix);
}
export const finite = v => typeof v === 'number' && Number.isFinite(v);
export const probability = v => finite(v) && v >= 0 && v <= 1;
export const text = v => typeof v === 'string' && v.trim().length > 0;

// Accept only portable JSON, with deterministic resource bounds before walking it.
export function jsonCopy(value) {
  let nodes = 0;
  const ancestors = new Set();
  function visit(v, path, depth) {
    requireAt(++nodes <= 50000 && depth <= 64, path, 'policy/input exceeds structural limits', 'Use at most 50,000 nodes and 64 nesting levels.');
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
    if (typeof v === 'number') { requireAt(finite(v), path, 'number must be finite'); return v; }
    requireAt(Array.isArray(v) || (object(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v))), path, 'expected portable JSON', 'Use JSON values or a Jev expression builder; callbacks cannot be deployed.');
    requireAt(!ancestors.has(v), path, 'cyclic values are not portable JSON');
    ancestors.add(v);
    const result = Array.isArray(v) ? v.map((x, i) => visit(x, `${path}[${i}]`, depth + 1))
      : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, visit(x, `${path}.${k}`, depth + 1)]));
    ancestors.delete(v);
    return result;
  }
  const result = visit(value, '$', 0);
  requireAt(Buffer.byteLength(JSON.stringify(result)) <= 2 * 1024 * 1024, '$', 'JSON exceeds 2 MiB limit');
  return result;
}
export function freeze(v) {
  if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); }
  return v;
}
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (object(v)) return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}
export const fingerprint = v => createHash('sha256').update(canonical(v)).digest('hex');
export const equal = (a, b) => canonical(a) === canonical(b);
export function keysOnly(v, allowed, path) {
  requireAt(object(v), path, 'expected an object');
  for (const k of Object.keys(v)) requireAt(allowed.includes(k), `${path}.${k}`, `unknown field '${k}'`, `Allowed fields: ${allowed.join(', ')}.`);
}

// The nearest known name, for an error that names the fix the way the Racket
// implementation's "did you mean" does.
const editDistance = (a, b) => {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    for (let j = 1; j <= b.length; j += 1) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
};
export const closest = (key, known) => {
  const scored = known.filter(k => typeof k === 'string').map(k => [editDistance(key, k), k]).sort((x, y) => x[0] - y[0]);
  return scored.length && scored[0][0] <= 2 ? scored[0][1] : null;
};
export const didYouMean = (key, known) => { const guess = closest(key, known); return guess ? ` Did you mean '${guess}'?` : ''; };
