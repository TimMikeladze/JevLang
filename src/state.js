// Redaction and bounded state assembly.
// Redaction is heuristic, with documented false positives/negatives.
import { object, requireAt, own } from './common.js';

export const redactorNames = ['emails', 'ssn', 'cards', 'phones', 'ips', 'keys', 'urls'];
const phoneKey = /phone|mobile|cell|fax|whatsapp|sms|(?<![a-z])tel(?![a-z])/i;
const idKey = /order|invoice|ref|tracking|sku|ticket|txn|transaction|confirmation|account|acct|serial|item|product|(?<![a-z])id|id$/i;
const secretKey = /(?:api[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|secret(?:[_-]?key)?|private[_-]?key|password|passwd|pwd|token|authorization|credentials?)$/i;
const phoneCue = /(?<![a-z<])(phone|tel|call|cell|mobile|text|sms|fax|whatsapp|contact|reach|dial)(?![a-z>])|(?<![a-z])(?:order|invoice|inv|ref|reference|tracking|sku|ticket|case|txn|transaction|confirmation|conf|id|acct|account|po|serial|item|product|part|no\.)(?![a-z])|#/gi;
const ssnCue = /(?<![a-z<])(?:ssns?|ss#|s\.s\.n\.?|social[ _-]?sec(?:urity)?)(?![a-z>])/i;
const octet = '(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])';
const ipv4Exact = new RegExp(`^(?:${octet}\\.){3}${octet}$`);

function isCard(s) {
  if (!/^[2-6][0-9]{12,18}$/.test(s)) return false;
  const sum = [...s].reverse().reduce((sum, digit, i) => { const n = Number(digit) * (i % 2 ? 2 : 1); return sum + (n > 9 ? n - 9 : n); }, 0);
  return sum % 10 === 0;
}
function redactCardRun(run) {
  const groups = [...run.matchAll(/[0-9]+/g)];
  let at = 0, out = '';
  for (let i = 0; i < groups.length; i++) {
    let digits = '', end = -1;
    for (let j = i; j < groups.length; j++) {
      if (j > i && groups[j - 1][0].length < 4) break;
      digits += groups[j][0]; if (digits.length > 19) break;
      if (isCard(digits)) end = j;
    }
    let startOffset, endOffset;
    if (end >= 0) {
      startOffset = groups[i].index; endOffset = groups[end].index + groups[end][0].length; i = end;
    } else {
      const s = groups[i][0];
      if (s.length >= 20 && s.length <= 25) {
        for (const side of ['prefix', 'suffix']) {
          for (let n = 19; n >= 13; n--) {
            const part = side === 'prefix' ? s.slice(0, n) : s.slice(-n);
            if (isCard(part)) { startOffset = groups[i].index + (side === 'prefix' ? 0 : s.length - n); endOffset = startOffset + n; break; }
          }
          if (startOffset !== undefined) break;
        }
      }
    }
    if (startOffset !== undefined) { out += run.slice(at, startOffset) + '<card>'; at = endOffset; }
  }
  return out + run.slice(at);
}
function validIPv6(s) {
  let hex = s;
  if (s.includes('.')) { const match = /^(.*:)([0-9.]+)$/.exec(s); if (!match || !ipv4Exact.test(match[2])) return false; hex = `${match[1]}0:0`; }
  if (hex.includes(':::') || (hex.startsWith(':') && !hex.startsWith('::')) || (hex.endsWith(':') && !hex.endsWith('::'))) return false;
  const doubles = [...hex.matchAll(/::/g)].length, groups = hex.split(':').filter(Boolean);
  return doubles <= 1 && groups.every(g => /^[0-9a-f]{1,4}$/i.test(g)) && (doubles ? groups.length <= 7 : groups.length === 8) && groups.join('').length >= 3;
}

// Replacement callbacks receive (match, whole string, offset, context).
const redactors = [
  ['emails', /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@(?:(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}|localhost(?![A-Za-z0-9-]|\.[A-Za-z0-9]))/gi, '<email>'],
  ['urls', /\bhttps?:\/\/[^\s"'<>]*[^\]\s"'<>.,;:!?)]/g, '<url>'],
  ['urls', /\bwww\.[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+(?:[/?#](?:[^\s"'<>]*[^\]\s"'<>.,;:!?)])?)?/g, '<url>'],
  ['keys', /(?<![A-Za-z0-9])(bearer[ \t]+)([A-Za-z0-9._~+/-]{11,}[A-Za-z0-9_~+/-]=*)/gi, m => /[0-9]/.test(m[2]) || m[2].length >= 32 ? m[1] + '<key>' : m[0]],
  ['keys', /(?<![A-Za-z0-9])((?:api[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|client[_-]?secret|secret[_-]?key|private[_-]?key|password|passwd|pwd)["']?[ \t]*[:=][ \t]*["']?)([^\s"'&,;<>]{4,})/gi, m => /[0-9]/.test(m[2]) || m[2].length >= 12 || /=["']?$/.test(m[1]) ? m[1] + '<key>' : m[0]],
  ['keys', /(?<![A-Za-z0-9_-])(?:(?:AKIA|ASIA)[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*|AIza[0-9A-Za-z_-]{35})(?![A-Za-z0-9])/g, '<key>'],
  ['keys', /(?<![A-Za-z0-9])(?:sk|pk|rk|api|key|token|secret|bearer)[-_][A-Za-z0-9_-]{12,}(?![A-Za-z0-9_-])/g, m => [...m[0].matchAll(/[A-Za-z0-9]{8,}/g)].some(x => /[A-Za-z]/.test(x[0]) && /[0-9]/.test(x[0])) ? '<key>' : m[0]],
  ['ssn', /(?<![0-9-])[0-9]{3}-[0-9]{2}-[0-9]{4}(?![0-9]|-[0-9])|(?<![0-9])(?<![0-9] )[0-9]{3} [0-9]{2} [0-9]{4}(?![0-9]| [0-9])/g, '<ssn>'],
  ['ssn', /(?<![0-9])[0-9]{9}(?![0-9])/g, (m, s, i, ctx) => /ssn|social[ _-]?sec/i.test(ctx ?? '') || ssnCue.test(s.slice(Math.max(0, i - 24), i)) || ssnCue.test(s.slice(i + m[0].length, i + m[0].length + 24)) ? '<ssn>' : m[0]],
  ['cards', /(?<![0-9])[0-9]+(?:(?:[ \t]{1,2}|[ \t]?[-./][ \t]?|[ \t]*\r?\n[ \t]*)[0-9]+)*/g, m => redactCardRun(m[0])],
  ['phones', /(?<![\w+])\+[0-9](?:[ .-]?\(?[0-9]\)?){7,14}(?![0-9])/g, '<phone>'],
  ['phones', /(?<![\w+.-])(?:1[ .-]?)?(?:\([0-9]{3}\)[ .-]?|[0-9]{3}[ .-])[0-9]{3}[ .-][0-9]{4}(?![0-9]|[.-][0-9])/g, '<phone>'],
  ['phones', /(?<![\w+.-])1?[2-9][0-9]{2}[2-9][0-9]{6}(?![\w]|[.-][0-9])/g, (m, s, i, ctx) => {
    if (phoneKey.test(ctx ?? '')) return '<phone>';
    if (idKey.test(ctx ?? '')) return m[0];
    const cues = [...s.slice(Math.max(0, i - 24), i).matchAll(phoneCue)];
    return cues.length && !cues.at(-1)[1] ? m[0] : '<phone>';
  }],
  ['ips', /(?<![\w:.])(?:[0-9A-Fa-f]{0,4}:){2,7}(?:[0-9]{1,3}(?:\.[0-9]{1,3}){3}|[0-9A-Fa-f]{0,4})(?![\w:]|\.[0-9A-Za-z])/g, m => validIPv6(m[0]) ? '<ip>' : m[0]],
  ['ips', new RegExp(`(?<![0-9.])(?:${octet}\\.){3}${octet}(?![0-9]|\\.[0-9])`, 'g'), (m, s, i, ctx) => /version|release|build|firmware/i.test(ctx ?? '') || /(?<![a-z])(?:version|ver|release|rel|v|firmware|fw|build|rev)\.?[ \t]*[:=#]?[ \t]*$/i.test(s.slice(Math.max(0, i - 16), i)) ? m[0] : '<ip>'],
];
export function redactString(value, specs = redactorNames, context = null) {
  for (const [name, regex, replacement] of redactors) if (specs.includes(name)) {
    const original = value;
    value = value.replace(regex, (...args) => {
      const index = args.at(-2), match = args.slice(0, -2);
      return typeof replacement === 'string' ? replacement : replacement(match, original, index, context);
    });
  }
  return value;
}
function renameKeys(obj, specs) {
  const keys = Object.keys(obj).sort(), proposed = keys.map(k => redactString(k, specs));
  const taken = new Set(keys.filter((k, i) => k === proposed[i])), renames = new Map();
  keys.forEach((k, i) => {
    if (k === proposed[i]) return;
    let n = proposed[i], j = 0;
    while (taken.has(n)) n = `${proposed[i]}#${++j}`;
    taken.add(n); renames.set(k, n);
  });
  return renames;
}
export function redact(value, specs = redactorNames, context = null, byName = true) {
  if (!specs.length) return value;
  if (byName && context && specs.includes('keys') && secretKey.test(context) && (typeof value === 'number' || (typeof value === 'string' && value.length))) return '<key>';
  if (typeof value === 'string') return redactString(value, specs, context);
  if (typeof value === 'number' && Number.isInteger(value) && Math.abs(value) < 1e25) {
    const digits = BigInt(value).toString(), redacted = redactString(digits, specs, context);
    return redacted === digits || (redacted === '<phone>' && !phoneKey.test(context ?? '')) ? value : redacted;
  }
  if (Array.isArray(value)) return value.map(x => redact(x, specs, context, byName));
  if (object(value)) {
    const renamed = renameKeys(value, specs);
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [renamed.get(k) ?? k, redact(v, specs, k, byName)]));
  }
  return value;
}
export function redactQuestions(questions, specs = redactorNames) {
  const maps = {}, result = {};
  for (const [id, q] of Object.entries(questions)) {
    const renames = q.type === 'choice' ? renameKeys(q.criteria, specs) : new Map();
    const wire = Object.fromEntries(Object.entries(q).map(([k, v]) => [k, k === 'type' ? v : k === 'criteria' && renames.size ? Object.fromEntries(Object.entries(v).map(([key, content]) => [renames.get(key) ?? key, redact(content, specs, null, false)])) : redact(v, specs, null, false)]));
    Object.defineProperty(result, id, { value: wire, enumerable: true });
    if (renames.size) Object.defineProperty(maps, id, { value: Object.fromEntries([...renames].map(([a, b]) => [b, a])), enumerable: true });
  }
  return { questions: result, renames: maps };
}
export function restoreAnswerKeys(answers, renames) {
  return Object.fromEntries(Object.entries(answers).map(([id, a]) => {
    const map = own(renames, id) ? renames[id] : null;
    if (!map) return [id, a];
    const original = key => own(map, key) ? map[key] : key;
    return [id, { ...a, ...(typeof a.choice === 'string' ? { choice: original(a.choice) } : {}), ...(object(a.probabilities) ? { probabilities: Object.fromEntries(Object.entries(a.probabilities).map(([k, v]) => [original(k), v])) } : {}) }];
  }));
}

const truncation = ' ...[truncated]';
const markers = ['<email>', '<phone>', '<card>', '<ssn>', '<key>', '<url>', '<ip>'];
const length = s => [...s].length;
export const stateSize = v => length(JSON.stringify(v));
export function capString(s, n) {
  const chars = [...s]; if (chars.length <= n) return s;
  const kept = n <= truncation.length ? n : n - truncation.length;
  const suffix = n <= truncation.length ? '' : truncation;
  for (let i = Math.max(0, kept - 6); i < kept; i++) if (markers.some(m => chars.slice(i, i + m.length).join('') === m)) return chars.slice(0, i).join('') + suffix;
  return chars.slice(0, kept).join('') + suffix;
}
const mapStrings = (v, fn) => typeof v === 'string' ? fn(v) : Array.isArray(v) ? v.map(x => mapStrings(x, fn)) : object(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mapStrings(x, fn)])) : v;
function cutStrings(v, over, floor) {
  if (over <= 0) return v;
  const lens = []; mapStrings(v, s => { if (length(s) > floor) lens.push(length(s)); return s; }); lens.sort((a, b) => b - a);
  let sum = 0, cut = floor;
  for (let i = 0; i < lens.length; i++) {
    sum += lens[i]; const n = Math.floor((sum - over) / (i + 1));
    if (n >= (lens[i + 1] ?? floor)) { cut = n; break; }
  }
  return mapStrings(v, s => capString(s, cut));
}
function splitMore(xs) {
  const m = typeof xs.at(-1) === 'string' ? /^\.\.\.\[([0-9]+) more\]$/.exec(xs.at(-1)) : null;
  return { items: m ? xs.slice(0, -1) : xs, dropped: m ? Number(m[1]) : 0 };
}
function dropTails(v, limit) {
  // Iterative traversal avoids retaining mutable references to the caller's input.
  while (stateSize(v) > limit) {
    let best = null, biggest = -1;
    const walk = (x, path) => {
      if (Array.isArray(x)) {
        if (splitMore(x).items.length && stateSize(x) > biggest) { biggest = stateSize(x); best = path; }
        x.forEach((item, i) => walk(item, [...path, i]));
      } else if (object(x)) Object.entries(x).forEach(([key, item]) => walk(item, [...path, key]));
    };
    walk(v, []); if (best === null) break;
    const xs = best.reduce((x, k) => x[k], v), { items, dropped } = splitMore(xs);
    let replacement;
    for (let k = 1; k <= items.length; k++) {
      replacement = [...items.slice(0, -k), `...[${dropped + k} more]`];
      if (stateSize(xs) - stateSize(replacement) >= stateSize(v) - limit) break;
    }
    const set = (x, path) => !path.length ? replacement : Array.isArray(x) ? x.map((item, i) => i === path[0] ? set(item, path.slice(1)) : item) : Object.fromEntries(Object.entries(x).map(([k, item]) => [k, k === path[0] ? set(item, path.slice(1)) : item]));
    v = set(v, best);
  }
  return v;
}
export function capValue(value, limit, path = 'state', stringField = true) {
  if (typeof value === 'string' && stringField) return capString(value, limit);
  let out = value;
  for (const floor of [256, 24]) out = dropTails(cutStrings(out, stateSize(out) - limit, floor), limit);
  requireAt(stateSize(out) <= limit, path, `state remains ${stateSize(out)} characters after shrinking, above ${limit}`, 'Raise maxChars, give large fields a per-field cap, or send fewer fields.', 'state');
  return out;
}
export function checkTokenBudget(state, questions = {}, limit = 32768) {
  const chars = stateSize(state) + Math.max(0, ...Object.values(questions).map(stateSize));
  const estimated = Math.ceil(chars / 4);
  requireAt(limit === null || estimated <= limit, 'state', `state plus longest question is about ${estimated} tokens, above ${limit} (~4 chars/token, rough estimate)`, 'Cap the state or send fewer fields; there is no public tokenizer.', 'state');
  return state;
}
