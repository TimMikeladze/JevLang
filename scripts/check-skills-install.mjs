import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const workspace = mkdtempSync(join(tmpdir(), 'jev-skills-install-'));
const name = 'jevlang';
const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]);

try {
  const project = join(workspace, name);
  mkdirSync(project);
  const result = spawnSync('npx', ['--yes', 'skills', 'add', root, '-a', 'claude-code', '-a', 'codex', '--copy', '-y'], {
    cwd: project, encoding: 'utf8', timeout: 120000,
    env: { ...process.env, DISABLE_TELEMETRY: '1' },
  });
  assert.equal(result.status, 0, `${name}: ${result.stderr}\n${result.stdout}`);
  for (const agent of ['.claude', '.agents']) {
    assert.deepEqual(readdirSync(join(project, agent, 'skills')), [name]);
    const installed = join(project, agent, 'skills', name);
    const source = join(root, 'skills', name);
    for (const file of walk(source)) {
      assert.deepEqual(readFileSync(join(installed, relative(source, file))), readFileSync(file));
    }
    for (const file of walk(installed).filter(file => file.endsWith('.md'))) {
      for (const [, href] of readFileSync(file, 'utf8').matchAll(/\]\(([^)]+)\)/g)) {
        if (/^https?:|^#/.test(href)) continue;
        const target = resolve(dirname(file), href.split('#')[0]);
        assert.ok(!relative(installed, target).startsWith('..'));
        assert.ok(readFileSync(target).length > 0);
      }
    }
    mkdirSync(join(project, 'node_modules'), { recursive: true });
    if (agent === '.claude') symlinkSync(root, join(project, 'node_modules', 'jevlang'), 'dir');
    const js = spawnSync('node', [join(installed, 'assets/router.mjs')], { cwd: project, encoding: 'utf8' });
    assert.equal(js.status, 0, js.stderr);
    assert.match(js.stdout, /assign billing-queue/);
    assert.match(js.stdout, /escalate human-triage/);
    const py = spawnSync('python3', [join(installed, 'assets/router.py')], {
      cwd: project, encoding: 'utf8', env: { ...process.env, PYTHONPATH: join(root, 'python') },
    });
    assert.equal(py.status, 0, py.stderr);
    assert.match(py.stdout, /assign billing-queue/);
  }
  console.log(`${name}: installed from the repository for Claude Code and Codex; resources verified`);
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
