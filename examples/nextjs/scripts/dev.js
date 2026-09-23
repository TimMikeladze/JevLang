// Local dev: `next dev` on the first free port from 3000 (or $PORT), so nothing
// already running is touched.
//
//   npm run dev          decision log and rate limits in memory
//   npm run dev:redis    Redis + the Upstash REST proxy in Docker, on free ports,
//                        so the app runs the same code path it runs on Vercel
import { createServer } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';

const free = start => new Promise(resolve => {
  const server = createServer().once('error', () => resolve(free(start + 1)))
    .listen(start, () => server.close(() => resolve(start)));
});
const docker = (...args) => spawnSync('docker', args, { encoding: 'utf8' });

const env = { ...process.env };
const cleanup = [];
if (process.argv.includes('--redis') && !env.UPSTASH_REDIS_REST_URL) {
  if (docker('info').status !== 0) { console.error('dev:redis needs Docker running'); process.exit(1); }
  const id = `jevdemo-${process.pid}`;
  const [redisPort, restPort] = [await free(6390), await free(8090)];
  const token = 'jevdemo-local-token';
  docker('network', 'create', id);
  docker('run', '-d', '--rm', '--name', `${id}-redis`, '--network', id, '-p', `${redisPort}:6379`, 'redis:7-alpine');
  docker('run', '-d', '--rm', '--name', `${id}-rest`, '--network', id, '-p', `${restPort}:80`,
    '-e', 'SRH_MODE=env', '-e', `SRH_TOKEN=${token}`, '-e', `SRH_CONNECTION_STRING=redis://${id}-redis:6379`,
    'hiett/serverless-redis-http:latest');
  cleanup.push(() => { docker('rm', '-f', `${id}-rest`, `${id}-redis`); docker('network', 'rm', id); });
  Object.assign(env, { UPSTASH_REDIS_REST_URL: `http://localhost:${restPort}`, UPSTASH_REDIS_REST_TOKEN: token });
  console.log(`upstash (local)  http://localhost:${restPort}`);
}

const appPort = await free(Number(env.PORT ?? 3000));
const next = spawn('npx', ['next', 'dev', '-p', String(appPort)], { stdio: 'inherit', env });
const stop = code => { next.kill(); for (const fn of cleanup) fn(); process.exit(code ?? 0); };
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
next.on('exit', code => stop(code));
