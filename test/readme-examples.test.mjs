// The README's examples are runnable, and their captured output is checked.
//
//   - Every fenced block tagged `file=NAME` is written to a scratch project that
//     has `jevlang` installed the way npm installs it: node_modules/jevlang and a
//     node_modules/.bin/jev symlink.
//   - Every `$ command` block runs there, in document order, and its output must
//     equal what the block records. A command whose comment starts with `live`
//     (a real model call, a server that keeps running, this suite itself) is
//     pasted from a real run and not re-run.
//
// After changing an example, refresh the recorded output in place:
//   UPDATE_README=1 bun test test/readme-examples.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { policy as ticketRouter } from '../examples/ticket-router.mjs';
import { policy as toolGate } from '../examples/tool-gate.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const readmePath = join(root, 'README.md');
const readme = readFileSync(readmePath, 'utf8');

function readBlocks(md) {
  const out = [];
  const re = /^```([\w-]*)([^\n]*)\n([\s\S]*?)^```[ \t]*$/gm;
  let m;
  while ((m = re.exec(md))) {
    const body = m[3].replace(/\n$/, '');
    const start = m.index + m[0].length - m[3].length - 3;
    out.push({ lang: m[1], file: /(?:^|\s)file=(\S+)/.exec(m[2])?.[1] ?? null, body, start, end: start + body.length });
  }
  return out;
}

const blocks = readBlocks(readme);
const sources = blocks.filter(b => b.file);
const captured = blocks.filter(b => b.body.startsWith('$ '));
const commandOf = block => block.body.split('\n')[0].slice(2).split('  #')[0];
const commentOf = block => block.body.split('\n')[0].slice(2).split('  #')[1]?.trim() ?? '';
const isLive = block => commentOf(block).startsWith('live');
const outputOf = block => block.body.split('\n').slice(1).join('\n');

function scratchProject() {
  const dir = mkdtempSync(join(tmpdir(), 'jev-readme-'));
  mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true });
  symlinkSync(root, join(dir, 'node_modules', 'jevlang'));
  symlinkSync(join(root, 'src', 'cli.mjs'), join(dir, 'node_modules', '.bin', 'jev'));
  for (const s of sources) {
    mkdirSync(dirname(join(dir, s.file)), { recursive: true });
    writeFileSync(join(dir, s.file), s.body + '\n');
  }
  return dir;
}

const run = (dir, command) => spawnSync('sh', ['-c', command], {
  cwd: dir, encoding: 'utf8', env: { ...process.env, PATH: `${join(dir, 'node_modules', '.bin')}:${process.env.PATH}` },
});

test('README sources parse, and their JSON files are JSON', () => {
  assert.ok(sources.length >= 8, 'the README ships its examples as file= blocks');
  const dir = scratchProject();
  try {
    for (const s of sources) {
      if (s.file.endsWith('.json')) assert.doesNotThrow(() => JSON.parse(s.body), s.file);
      if (s.file.endsWith('.mjs')) {
        const check = spawnSync('node', ['--check', join(dir, s.file)], { encoding: 'utf8' });
        assert.equal(check.status, 0, `${s.file}: ${check.stderr}`);
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('README captured runs match what the examples print', async () => {
  const dir = scratchProject();
  const update = process.env.UPDATE_README === '1';
  const fresh = new Map();
  try {
    for (const block of captured.filter(b => !isLive(b))) {
      const result = run(dir, commandOf(block));
      assert.equal(result.status, 0, `${commandOf(block)} exited ${result.status}: ${result.stderr}`);
      const actual = result.stdout.trimEnd();
      if (update) fresh.set(block, actual);
      else assert.equal(actual, outputOf(block).trimEnd(), `${commandOf(block)}: the captured run in README.md is stale`);
    }
    // The README's policies are the tested ones in examples/, not near copies.
    const support = await import(pathToFileURL(join(dir, 'support.mjs')).href);
    assert.deepEqual(support.policy.toJSON(), ticketRouter.toJSON());
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'gate.json'), 'utf8')), toolGate.toJSON());
  } finally { rmSync(dir, { recursive: true, force: true }); }
  if (update) {
    let out = readme;
    for (const [block, actual] of [...fresh].reverse()) {
      const first = block.body.split('\n')[0];
      out = out.slice(0, block.start) + first + (actual ? '\n' + actual : '') + out.slice(block.end);
    }
    writeFileSync(readmePath, out);
  }
});

test('live runs are labelled, and each names what it did', () => {
  for (const block of captured.filter(isLive)) {
    assert.match(commentOf(block), /^live: \S/, `${commandOf(block)}: say what the live run did`);
  }
});
