// jevlang/cloud — a thin client for a hosted JevLang deployment.
//
//   import { cloud } from 'jevlang/cloud';
//   const jc = cloud({ key: process.env.JEV_KEY });     // jev_live_… or jev_pub_…
//   const decision = await jc.evaluate('doorstep', input);
//   const journal = jc.journal('doorstep');             // drop-in for makeDispatcher({ journal })
//   runner({ pool: 'prod-east', handlers }).start();     // run `{ type: "runner" }` targets here
//
// It is `fetch` and nothing else — no dependency, and no engine logic. The
// decision it returns is the decision the engine made, because the service
// runs this same package. The tenant comes from the key, never from an
// argument, so a client cannot name another tenant's project.
const DEFAULT_BASE = 'https://cloud.jevlang.sh';

class CloudError extends Error {
  constructor(message, { status = null, code = null, detail = null } = {}) {
    super(message);
    this.name = 'CloudError';
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
  toJSON() { return { code: this.code ?? 'cloud', status: this.status, message: this.message }; }
}

const trimmed = url => String(url).replace(/\/+$/, '');

export function cloud({
  key = (typeof process !== 'undefined' ? process.env.JEV_KEY : null),
  baseUrl = (typeof process !== 'undefined' ? process.env.JEV_CLOUD_URL : null) ?? DEFAULT_BASE,
  environment = null,
  fetch: fetchImpl = (...args) => globalThis.fetch(...args),
  timeoutSeconds = 60,
} = {}) {
  if (!key) throw new CloudError('jevlang/cloud needs a key: set JEV_KEY, or pass { key }.');
  const base = trimmed(baseUrl);
  const publishable = key.startsWith('jev_pub_');

  async function call(path, { method = 'POST', body = null, headers = {}, query = null } = {}) {
    const url = new URL(`${base}${path}`);
    for (const [name, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(name, String(value));
    }
    let response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: {
          authorization: `Bearer ${key}`,
          ...(body === null ? {} : { 'content-type': 'application/json' }),
          ...(environment ? { 'x-jev-environment': environment } : {}),
          ...headers,
        },
        ...(body === null ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutSeconds * 1000),
      });
    } catch (error) {
      const timedOut = error.name === 'TimeoutError' || error.name === 'AbortError';
      throw new CloudError(timedOut ? `${base} did not answer in ${timeoutSeconds}s` : `${base} could not be reached: ${error.message}`,
        { code: timedOut ? 'timeout' : 'connection' });
    }
    const text = await response.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
    if (!response.ok) {
      throw new CloudError(parsed?.error ?? `the cloud answered HTTP ${response.status}`,
        { status: response.status, code: parsed?.code ?? null, detail: parsed?.detail ?? null });
    }
    return parsed;
  }

  const projectPath = project => `/api/v1/projects/${encodeURIComponent(project)}`;

  const client = {
    /** Ask the model the policy's questions, then decide. */
    async evaluate(project, input, { idempotencyKey = null, endUser = null } = {}) {
      if (publishable) {
        const answer = await call('/api/public/evaluate', {
          body: { project, input, ...(environment ? { environment } : {}) },
          headers: { 'x-jev-key': key, ...(endUser ? { 'x-jev-end-user': endUser } : {}) },
        });
        return answer.decision;
      }
      const answer = await call(`${projectPath(project)}/evaluate`, {
        body: { input },
        headers: {
          ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
          ...(endUser ? { 'x-jev-end-user': endUser } : {}),
        },
      });
      return answer.decision;
    },

    /** Decide on answers you already have. Offline for the service too: no model is asked. */
    async decide(project, input, answers) {
      const answer = await call(`${projectPath(project)}/decide`, { body: { input, answers } });
      return answer.decision;
    },

    /** Decide, then run the project's handlers. */
    dispatch(project, input, { answers = undefined, dryRun = false, key: stepKey = null } = {}) {
      return call(`${projectPath(project)}/dispatch`, {
        body: { input, ...(answers === undefined ? {} : { answers }), dry_run: dryRun, ...(stepKey ? { key: stepKey } : {}) },
      });
    },

    /** What this project did, newest first. */
    async traces(project, { limit = 50, environment: env = null } = {}) {
      const answer = await call(`${projectPath(project)}/traces`, { method: 'GET', query: { limit, environment: env } });
      return answer.traces;
    },

    async trace(project, id) {
      return call(`${projectPath(project)}/traces/${encodeURIComponent(id)}`, { method: 'GET' });
    },

    /** Publish a policy artifact. The first one a project publishes is production. */
    deploy(project, policy, { note = null } = {}) {
      const artifact = typeof policy?.toJSON === 'function' ? policy.toJSON() : policy;
      return call(`${projectPath(project)}/deployments`, { body: { policy: artifact, note } });
    },

    deployments(project) {
      return call(`${projectPath(project)}/deployments`, { method: 'GET' }).then(a => a.deployments);
    },

    /**
     * Move production. `expect` is the number you believe is live, so two
     * promotions racing cannot both win; `gate` replays real traces first and
     * refuses when too much changed.
     */
    promote(project, deployment, { expect = null, gate = null, environment: env = null } = {}) {
      return call(`${projectPath(project)}/promote`, {
        body: { deployment, expect, ...(gate ? { gate } : {}), ...(env ? { environment: env } : {}) },
      });
    },

    replayDiff(project, deployment, { limit = 100, since = null } = {}) {
      return call(`${projectPath(project)}/replay-diff`, { body: { deployment, limit, since } });
    },

    project(project) { return call(projectPath(project), { method: 'GET' }); },
    projects() { return call('/api/v1/projects', { method: 'GET' }).then(a => a.projects); },
    createProject(slug) { return call('/api/v1/projects', { body: { slug } }); },
    usage() { return call('/api/v1/usage', { method: 'GET' }); },

    /** The generated documents for a deployment: openapi.json, llms.txt, AGENTS.md, mcp.json, snippets.md. */
    async docs(project, file = 'AGENTS.md', { environment: env = null } = {}) {
      const url = new URL(`${base}${projectPath(project)}/docs/${file}`);
      if (env) url.searchParams.set('environment', env);
      const response = await fetchImpl(url, { headers: { authorization: `Bearer ${key}` } });
      if (!response.ok) throw new CloudError(`the cloud answered HTTP ${response.status}`, { status: response.status });
      return response.text();
    },

    /**
     * The project's managed state as a `Journal`: the same interface
     * `redisJournal` and `dbJournal` satisfy, so `makeDispatcher({ journal })`
     * takes it unchanged. Every key is namespaced to this tenant server-side.
     */
    journal(project) { return cloudJournal(client, project); },

    /** The playground link for a project, to hand to somebody. */
    playground(project, { environment: env = null } = {}) {
      const url = new URL(`${base}/app/projects/${encodeURIComponent(project)}/playground`);
      if (env ?? environment) url.searchParams.set('environment', env ?? environment);
      return url.toString();
    },

    call,
    baseUrl: base,
  };
  return client;
}

/**
 * A Journal over the cloud's state endpoint. Each operation is one request and
 * one claim, exactly as the Redis and SQL journals are — the difference is
 * only where the claim is made.
 */
export function cloudJournal(client, project) {
  const state = (op, body) => client.call(`/api/v1/projects/${encodeURIComponent(project)}/state`, { body: { op, ...body } });
  return {
    beginStep: (key, target, now, staleAfter = null) => state('beginStep', { key, target, now, staleAfter }).then(r => r.result),
    finishStep: (key, status, result, now) => state('finishStep', { key, status, result, now }).then(() => undefined),
    releaseStep: key => state('releaseStep', { key }).then(() => undefined),
    claimCooldown: (name, now, window) => state('claimCooldown', { name, now, window }).then(r => r.result),
    coolingDown: (name, now, window) => state('coolingDown', { name, now, window }).then(r => r.result),
    claimBudget: (name, now, window, amount, max) => state('claimBudget', { name, now, window, amount, max }).then(r => r.result),
    schedule: (key, due, payload) => state('schedule', { key, due, payload }).then(() => undefined),
    takeDue: (now, lease = null) => state('takeDue', { now, lease }).then(r => r.result),
    cancel: key => state('cancel', { key }).then(r => r.result),
    nextDue: () => state('nextDue', {}).then(r => r.result),
    close: () => undefined,
  };
}

/**
 * A runner: the process that runs a `{ "type": "runner" }` target's work on
 * your own machine. It pulls — claims jobs from a pool with a lease, runs the
 * handler the job's target names, and reports back — so nothing on your
 * network accepts a connection. The cloud decided already; the runner acts.
 *
 *   runner({ key: process.env.JEV_RUNNER_KEY, pool: 'prod-east', handlers: {
 *     'billing-queue': async (state, decision) => ({ ticket: await file(decision) }),
 *   } }).start();
 *
 * A handler that throws fails the job, and the cloud re-queues it until its
 * attempts run out; while one runs, the lease is extended so a long action is
 * not handed to another runner. A target this runner has no handler for fails
 * without a retry, since retrying cannot help.
 */
export function runner({
  pool = 'default',
  handlers = {},
  run = null,
  name = defaultName(),
  concurrency = 1,
  wait = 20,
  lease = 300,
  client = null,
  onEvent = () => {},
  ...options
} = {}) {
  const jc = client ?? cloud(options);
  let stopping = false;
  let loop = null;
  const call = (path, body) => jc.call(path, { body });
  const report = (job, op, body) => call(`/api/v1/runners/jobs/${encodeURIComponent(job.id)}/${op}`, { claim: job.claim, ...body });

  const execute = run ?? (async (job) => {
    const handler = Object.prototype.hasOwnProperty.call(handlers, job.target) ? handlers[job.target] : handlers.default;
    if (typeof handler !== 'function') throw Object.assign(new Error(`this runner has no handler for '${job.target}'`), { retry: false });
    return handler(job.state, job.decision, { job });
  });

  async function runJob(job) {
    onEvent({ type: 'claimed', job });
    const beat = setInterval(() => {
      report(job, 'extend', { lease }).catch(error => onEvent({ type: 'heartbeat-failed', job, error }));
    }, Math.max(0.05, lease / 3) * 1000);
    try {
      const result = await execute(job);
      await report(job, 'complete', { result: result === undefined ? null : result });
      onEvent({ type: 'done', job, result });
    } catch (error) {
      const retry = error?.retry !== false;
      await report(job, 'fail', { error: String(error?.message ?? error), retry })
        .catch(e => onEvent({ type: 'report-failed', job, error: e }));
      onEvent({ type: 'failed', job, error, retry });
    } finally {
      clearInterval(beat);
    }
  }

  /** One claim, and the jobs it returned, run to their reports. Returns how many ran. */
  async function runOnce({ wait: w = wait } = {}) {
    const { jobs } = await call('/api/v1/runners/claim', { pool, max: concurrency, wait: w, lease, name });
    await Promise.all(jobs.map(runJob));
    return jobs.length;
  }

  return {
    runOnce,
    /** Claim and run until `stop()`. A failed claim waits and asks again. */
    start() {
      if (loop) return loop;
      stopping = false;
      loop = (async () => {
        let backoff = 1;
        while (!stopping) {
          try { await runOnce(); backoff = 1; }
          catch (error) {
            onEvent({ type: 'claim-failed', error });
            await new Promise(r => setTimeout(r, backoff * 1000));
            backoff = Math.min(30, backoff * 2);
          }
        }
      })();
      return loop;
    },
    /** Finish the jobs in hand, then stop asking. */
    async stop() { stopping = true; await loop; loop = null; },
    pool,
    name,
  };
}

function defaultName() {
  const host = typeof process !== 'undefined' ? (process.env.HOSTNAME ?? process.env.COMPUTERNAME ?? null) : null;
  return `${host ?? 'runner'}-${typeof process !== 'undefined' ? process.pid : Math.floor(Math.random() * 1e6)}`;
}

export { CloudError };
