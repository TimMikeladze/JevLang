#!/usr/bin/env node
import { readFile, readdir } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { compile } from './engine.js';
import { replay, diff, tune } from './fixtures.js';
import { policyActions } from './json-schema.js';
import { summarize, calibrate } from './monitor.js';
import { cost } from './cost.js';
import { loadProviderConfig, makeDefaultRegistry, discoverProviders, resolveProvider, providerRequest, targetSpec } from './provider/index.js';
import { evaluateWithProvider, runPolicyProvider, fixtureFromRun, policyConfigDefaults, makePolicyRegistry, sharedPolicyRegistry, policyProviderRequest } from './evaluate.js';
import { evaluateMany } from './batch.js';
import { makeGate, hookResponse, approveOnce, parseToolList } from './gate.js';
import { cloud, runner } from './cloud.js';
import { loadHandlers } from './handlers.js';

async function providerReport(options = {}) {
  const config = options.config ?? loadProviderConfig({ role: options.role ?? null });
  const registry = makeDefaultRegistry(config);
  const request = providerRequest(options.operation ?? 'decide', options.mode ?? 'structured', {
    role: options.role ?? options.operation ?? 'decide', kind: options.kind ?? null, tier: options.tier ?? null,
    target: targetSpec(options.target ?? {}),
  });
  const discovered = (await discoverProviders(registry)).map(({ provider, availability }) => ({ provider: provider.id, ...availability }));
  try {
    const { target, rejections, matchedRoute } = await resolveProvider(request, config, registry);
    return {
      discovered, rejections, matched_route: matchedRoute,
      selected: { provider: target.provider.id, model: target.model, requested_effort: target.requestedEffort, effective_effort: target.effectiveEffort, sources: target.sources },
    };
  } catch (error) {
    return { discovered, rejections: Array.isArray(error.detail) ? error.detail : [], selected: null, error: { kind: error.kind, message: error.message } };
  }
}

export async function handle(request) {
  if (request.method === 'providers') return providerReport(request.options ?? {});
  // The gate's hook: a tool call in, a permission decision out. It reaches the
  // selected provider, like evaluate does.
  if (request.method === 'hook') {
    const options = request.options ?? {};
    const policy = compile(request.policy);
    const gate = makeGate(policy, {
      evaluate: state => evaluateWithProvider(policy, state, options.provider ? { provider: options.provider } : {}),
      allow: options.allow ?? [], deny: options.deny ?? [],
      onError: options.onError ?? 'ask', log: options.log ?? null,
    });
    return hookResponse(request.input, () => gate, { host: options.host ?? 'auto', onError: options.onError ?? 'ask' });
  }
  if (request.method === 'approve-once') return { path: await approveOnce(request.fingerprint) };
  const p = compile(request.policy);
  switch (request.method) {
    case 'validate': return { policy: p.toJSON(), warnings: p.warnings };
    case 'decide': return p.decide(request.answers, request.options);
    case 'state': return p.buildState(request.input);
    case 'questions': return p.questions(request.state);
    case 'precheck': return p.precheck(request.input, request.options);
    case 'replay': return replay(p, request.fixtures, request.options);
    case 'diff': return diff(p, compile(request.after), request.fixtures, request.options);
    case 'tune': return tune(p, request.fixtures, request.grid);
    case 'schema': return policyActions(p);
    // evaluate and record reach the selected provider; everything else is offline.
    case 'evaluate': return evaluateWithProvider(p, request.input, request.options ?? {});
    case 'record': {
      const options = request.options ?? {};
      const config = options.config ?? loadProviderConfig({ defaults: policyConfigDefaults, role: 'policy' });
      const registry = makePolicyRegistry(config);
      const { state, facts } = p.buildState(request.input);
      const questions = p.questions(state);
      const result = await runPolicyProvider(state, questions, { ...options, config, registry });
      const decision = p.decide(result.output, { facts, state, profile: options.profile ?? null });
      return { decision, fixture: fixtureFromRun({ name: options.name ?? 'recorded', policy: p, state, questions, decision, result }) };
    }
    case 'stats': {
      const rows = replay(p, request.fixtures, { ...request.options, allowStale: true });
      const kept = rows.map((row, i) => ({ row, fixture: request.fixtures[i] })).filter(({ row }) => row.decision);
      return {
        unusable: rows.length - kept.length,
        summary: summarize(kept.map(({ row }) => row.decision), {
          answers: kept.map(({ fixture }) => fixture.answers),
          labels: kept.map(({ fixture }) => fixture.label ?? null),
        }),
      };
    }
    case 'cost': return cost(p, request.options ?? {});
    case 'calibrate': return calibrate(request.fixtures.map(f => ({ answers: f.answers, labels: f.labels })));
    default: throw new Error(`Unknown method '${request.method}'.`);
  }
}
async function jsonFile(path) { return JSON.parse(await readFile(path, 'utf8')); }
async function fixtureFiles(dir) {
  const files = (await readdir(dir, { withFileTypes: true })).filter(f => f.isFile() && f.name.endsWith('.json')).map(f => f.name).sort();
  return Promise.all(files.map(f => jsonFile(resolve(dir, f))));
}
// The cloud commands. The key is the tenant, so none of them name one.
function flags(args) {
  const rest = [];
  const options = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) options[args[i].slice(2)] = args[i + 1]?.startsWith('--') === false ? args[++i] : true;
    else rest.push(args[i]);
  }
  return { rest, options };
}

// `jev runner POOL HANDLERS.json`: run a pool's `{ "type": "runner" }` work
// here, with the same handler file `makeDispatcher` takes. Ctrl-C finishes the
// jobs in hand, then stops.
async function runnerCommand(args) {
  const { rest, options } = flags(args);
  const [pool, file] = rest;
  if (!pool || !file) throw new Error('jev runner needs a pool and a handlers file: jev runner prod-east handlers.json');
  const handlers = await loadHandlers(resolve(file));
  const r = runner({
    pool,
    handlers,
    ...(options.url ? { baseUrl: options.url } : {}),
    ...(typeof options.name === 'string' ? { name: options.name } : {}),
    concurrency: Number(options.concurrency ?? 1),
    onEvent: (e) => {
      if (e.type === 'done') console.log(`done    ${e.job.id}  ${e.job.target}`);
      else if (e.type === 'failed') console.log(`failed  ${e.job.id}  ${e.job.target}: ${e.error?.message ?? e.error}${e.retry ? ' (will retry)' : ''}`);
      else if (e.type === 'claim-failed') console.error(`claim failed: ${e.error?.message ?? e.error}; asking again`);
    },
  });
  console.log(`runner ${r.name} pulling from pool ${pool} (${Object.keys(handlers).join(', ')})`);
  process.once('SIGINT', () => { console.log('finishing the jobs in hand…'); r.stop().then(() => process.exit(0)); });
  await r.start();
}

// `jev batch POLICY.json ROWS.ndjson`: one input per line (`-` reads stdin),
// one line out per row in input order, a summary on stderr. Identical rows are
// asked once.
async function readRows(path) {
  let text;
  if (path === '-') { const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk); text = Buffer.concat(chunks).toString('utf8'); }
  else text = await readFile(path, 'utf8');
  return text.split('\n').flatMap((line, i) => {
    if (!line.trim()) return [];
    try { return [JSON.parse(line)]; } catch (error) { throw new Error(`${path}:${i + 1}: not a JSON line (${error.message})`); }
  });
}
async function batchCommand(args) {
  const { rest, options } = flags(args);
  const [policyPath, rowsPath] = rest;
  if (!policyPath || !rowsPath) throw new Error('jev batch needs a policy and a rows file: jev batch policy.json rows.ndjson');
  const policy = compile(await jsonFile(policyPath));
  const rows = await readRows(rowsPath);
  const text = name => typeof options[name] === 'string' ? options[name] : null;
  const selection = { provider: text('provider'), model: text('model'), effort: text('effort') };
  const workers = Number(options.workers ?? 8), rpm = Number(options.rpm ?? 1200);
  const config = loadProviderConfig({ defaults: policyConfigDefaults, role: 'policy' });
  const registry = sharedPolicyRegistry(config);
  // More workers than the provider takes at once only queue behind its slots.
  try {
    const { target } = await resolveProvider(policyProviderRequest('', policy.staticQuestions(), selection), config, registry);
    const limit = target.provider.caps.maxParallel;
    if (workers > limit) console.error(`jev batch: ${target.provider.id} runs at most ${limit} calls at once; raise its max_parallel in the provider configuration to use ${workers} workers`);
  } catch { /* each row reports why it could not be asked */ }
  const cache = new Map(), done = new Array(rows.length).fill(false), results = new Array(rows.length);
  let next = 0, cached = 0;
  const started = performance.now();
  const line = (i, r) => r && typeof r === 'object' && typeof r.action === 'string'
    ? { row: i, decision: r }
    : { row: i, error: r?.toJSON?.() ?? { code: 'error', message: String(r?.message ?? r) } };
  const { failed, tokens } = await evaluateMany(row => evaluateWithProvider(policy, row, { ...selection, config, registry, cache }), rows, {
    workers, rpm,
    onResult: (i, r) => {
      done[i] = true; results[i] = r;
      if (r?.cached) cached += 1;
      for (; next < rows.length && done[next]; next++) { process.stdout.write(`${JSON.stringify(line(next, results[next]))}\n`); results[next] = null; }
    },
  });
  console.error(`jev batch: ${rows.length} rows, ${failed} failed, ${cached} cached, ${tokens} input tokens, ${((performance.now() - started) / 1000).toFixed(1)}s`);
  if (failed) process.exitCode = 1;
}

async function cloudCommand(command, args) {
  const { rest, options } = flags(args);
  const jc = cloud({ ...(options.url ? { baseUrl: options.url } : {}), ...(options.environment ? { environment: options.environment } : {}) });
  const [project, second] = rest;
  if (!project) throw new Error(`jev ${command} needs a project.`);

  if (command === 'open') { console.log(jc.playground(project)); return; }

  if (command === 'logs') {
    const traces = await jc.traces(project, { limit: Number(options.limit ?? 20), environment: options.environment ?? null });
    for (const trace of traces) {
      const decision = trace.decision ?? {};
      console.log(`${trace.at}  ${trace.kind.padEnd(9)} ${String(decision.action ?? trace.status).padEnd(9)} ${decision.target ?? ''}`.trimEnd());
    }
    if (!traces.length) console.log('nothing recorded yet');
    return;
  }

  if (command === 'deploy') {
    if (!second) throw new Error('jev deploy needs the policy artifact: jev deploy PROJECT POLICY.json');
    const published = await jc.deploy(project, await jsonFile(second), { note: typeof options.note === 'string' ? options.note : null });
    console.log(`published #${published.number} (${published.identity})${published.production ? ' — the first, so it is production' : ' — a preview until promoted'}`);
    return;
  }

  // promote
  if (!second) throw new Error('jev promote needs the deployment: jev promote PROJECT 3');
  const gate = options.gate === undefined ? null : { max_changed: Number(options.gate), ...(options.sample ? { sample: Number(options.sample) } : {}) };
  const moved = await jc.promote(project, second, {
    expect: options.expect === undefined ? null : Number(options.expect),
    gate,
    environment: options.environment ?? null,
  });
  console.log(moved.rollback
    ? `rolled back to #${moved.production}`
    : `production is #${moved.production}${moved.gate ? ` (the gate saw ${moved.gate.changed} of ${moved.gate.replayed} change)` : ''}`);
}

async function main(args) {
  if (args[0] === 'rpc') {
    for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
      let response;
      try { response = { ok: true, result: await handle(JSON.parse(line)) }; }
      catch (error) { response = { ok: false, error: error.toJSON?.() ?? { code: 'error', message: error.message } }; }
      process.stdout.write(`${JSON.stringify(response)}\n`);
    }
    return;
  }
  const [command, path, input, extra] = args;
  if (!command || ['help', '--help', '-h'].includes(command)) {
    console.log('jev validate POLICY.json\njev decide POLICY.json ANSWERS.json [FACTS.json]\njev state POLICY.json INPUT.json\njev schema POLICY.json\njev stats POLICY.json FIXTURE_DIR\njev calibrate POLICY.json FIXTURE_DIR\njev cost POLICY.json [INPUT.json] [FIXTURE_DIR]\njev evaluate POLICY.json INPUT.json   (calls the selected provider)\njev record POLICY.json INPUT.json     (calls it, and writes a fixture)\njev batch POLICY.json ROWS.ndjson [--workers 8] [--rpm 1200] [--provider ID] [--model M] [--effort E]   (one input per line, - for stdin)\njev providers\njev gate hook POLICY.json [OPTIONS.json] < event.json   (calls the provider)\njev gate approve-once FINGERPRINT\njev replay POLICY.json FIXTURE_DIR\njev diff BEFORE.json AFTER.json FIXTURE_DIR\njev tune POLICY.json FIXTURE_DIR GRID.json\njev deploy PROJECT POLICY.json [--note "what changed"]   (JevLang Cloud)\njev promote PROJECT DEPLOYMENT [--expect N] [--gate 0.05]\njev logs PROJECT [--limit 20]\njev open PROJECT                    (prints the playground link)\njev runner POOL HANDLERS.json [--concurrency N] [--name NAME]   (runs runner targets here)\njev rpc'); return;
  }
  if (command === 'runner') { await runnerCommand(args.slice(1)); return; }
  if (command === 'batch') { await batchCommand(args.slice(1)); return; }
  if (['deploy', 'promote', 'logs', 'open'].includes(command)) {
    await cloudCommand(command, args.slice(1));
    return;
  }
  if (command === 'providers') { console.log(JSON.stringify(await handle({ method: command, options: path ? await jsonFile(path) : {} }), null, 2)); return; }
  if (command === 'gate') {
    if (path === 'approve-once') {
      console.log(JSON.stringify(await handle({ method: 'approve-once', fingerprint: input }), null, 2));
      return;
    }
    if (path !== 'hook') throw new Error("Unknown gate command. Run jev --help.");
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    let event = null;
    try { event = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { event = null; }
    const answer = await handle({ method: 'hook', policy: await jsonFile(input), input: event, options: extra ? await jsonFile(extra) : {} });
    if (answer) console.log(JSON.stringify(answer));
    return;
  }
  const policy = await jsonFile(path);
  let result;
  if (command === 'validate' || command === 'schema') result = await handle({ method: command, policy });
  else if (command === 'decide') result = await handle({ method: command, policy, answers: await jsonFile(input), options: extra ? { facts: await jsonFile(extra) } : {} });
  else if (command === 'state') result = await handle({ method: command, policy, input: await jsonFile(input) });
  else if (command === 'replay') result = await handle({ method: command, policy, fixtures: await fixtureFiles(input) });
  else if (command === 'diff') result = await handle({ method: command, policy, after: await jsonFile(input), fixtures: await fixtureFiles(extra) });
  else if (command === 'tune') result = await handle({ method: command, policy, fixtures: await fixtureFiles(input), grid: await jsonFile(extra) });
  else if (command === 'stats' || command === 'calibrate') result = await handle({ method: command, policy, fixtures: await fixtureFiles(input) });
  else if (command === 'evaluate' || command === 'record') result = await handle({ method: command, policy, input: await jsonFile(input), options: extra ? await jsonFile(extra) : {} });
  else if (command === 'cost') result = await handle({ method: command, policy, options: { ...(input ? { input: await jsonFile(input) } : {}), ...(extra ? { fixtures: await fixtureFiles(extra) } : {}) } });
  else throw new Error(`Unknown command '${command}'. Run jev --help.`);
  console.log(JSON.stringify(result, null, 2));
  if (command === 'replay' && result.some(row => ['error', 'fail', 'stale'].includes(row.status))) process.exitCode = 1;
}
// npm runs a bin through a symlink (node_modules/.bin/jev), and argv[1] keeps the
// link's path while import.meta.url is the real file, so compare real paths.
const realPath = path => { try { return realpathSync(path); } catch { return resolve(path); } };
if (process.argv[1] && import.meta.url === pathToFileURL(realPath(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => { console.error(JSON.stringify(error.toJSON?.() ?? { code: 'error', message: error.message })); process.exitCode = 1; });
}
