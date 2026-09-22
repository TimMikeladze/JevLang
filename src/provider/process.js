// Running a provider executable with a bounded lifetime: its own process group,
// a hard deadline, and no inherited environment beyond what was allowed.
import { spawn } from 'node:child_process';
import { object } from '../common.js';

export const runner = { run: subprocessRunner };
export const runProgram = (executable, args, options = {}) => runner.run(executable, args, options);

export function subprocessRunner(executable, args, { stdin = '', timeoutSeconds = 300, dir = null, env = null, onLine = null } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(executable, args, {
        cwd: dir ?? process.cwd(),
        env: object(env) ? env : process.env,
        // Its own process group, so a timeout kills whatever it started.
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) { reject(error); return; }
    let stdout = '', stderr = '', settled = false, timedOut = false, pending = '';
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    }, timeoutSeconds * 1000);
    const finish = status => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(timedOut
        ? { status: null, stdout, stderr: `${stderr}\ntimed out after ${timeoutSeconds}s` }
        : { status, stdout, stderr });
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (!onLine) return;
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) onLine(line);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } });
    child.on('close', code => { if (onLine && pending !== '') onLine(pending); finish(code); });
    child.stdin.on('error', () => { /* the child may exit before reading its input */ });
    child.stdin.end(stdin);
  });
}
