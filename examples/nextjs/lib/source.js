// Reads a policy's own source out of lib/policies.js so each demo page can show
// it next to the UI, and maps decision sources ($.gates[0], $.route.clauses[3],
// $.route.otherwise) to the lines that declare them. Runs at build time.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const file = () => readFileSync(join(process.cwd(), 'lib/policies.js'), 'utf8').split('\n');

export function policySource(route) {
  const all = file();
  const start = all.findIndex(line => line.startsWith(`// --- /api/${route}:`));
  const next = all.findIndex((line, i) => i > start && line.startsWith('// --- /api/'));
  const lines = all.slice(start, next === -1 ? all.length : next);
  while (lines.at(-1) === '') lines.pop();

  // A clause runs from its `rule(` / `gate(` to the line where its parentheses close.
  const spans = pattern => lines.flatMap((line, i) => {
    const at = line.search(pattern);
    if (at === -1) return [];
    let depth = 0;
    for (let j = i; j < lines.length; j++) {
      for (const ch of (j === i ? line.slice(at) : lines[j]).replace(/'[^']*'|`[^`]*`|"[^"]*"/g, '')) {
        if (ch === '(') depth++;
        if (ch === ')' && --depth === 0) return [[i, j]];
      }
    }
    return [[i, i]];
  });
  const otherwise = lines.findIndex(line => /^\s*otherwise:/.test(line));
  return {
    lines,
    firstLine: start + 1,
    gates: spans(/\bgate\(/),
    clauses: spans(/\brule\(/),
    otherwise: otherwise === -1 ? null : [otherwise, otherwise],
  };
}
