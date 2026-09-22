import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { policy } from '../examples/hello.mjs';

const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));

// `npm install jevlang` puts jev in node_modules/.bin as a symlink to cli.mjs.
// Run through one, the CLI must still answer instead of exiting silently. It runs
// under node, as the bin's shebang does; bun resolves the link itself and would
// pass with or without the fix.
test('jev answers when started through a symlink', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-bin-'));
  try {
    const bin = join(dir, 'jev');
    symlinkSync(cli, bin);
    writeFileSync(join(dir, 'policy.json'), JSON.stringify(policy.toJSON()));
    writeFileSync(join(dir, 'answers.json'), JSON.stringify({ 'spam?': { noul: 0.97 } }));
    const help = spawnSync('node', [bin, '--help'], { encoding: 'utf8' });
    assert.match(help.stdout, /jev decide POLICY\.json ANSWERS\.json/);
    const run = spawnSync('node', [bin, 'decide', join(dir, 'policy.json'), join(dir, 'answers.json')], { encoding: 'utf8' });
    assert.equal(run.status, 0);
    const decision = JSON.parse(run.stdout);
    assert.equal(decision.action, 'hold');
    assert.equal(decision.reason, 'almost certainly spam');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
