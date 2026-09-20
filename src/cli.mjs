#!/usr/bin/env node
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { compile } from './engine.mjs';
import { replay, diff, tune } from './fixtures.mjs';
import { policyActions } from './json-schema.mjs';
import { summarize, calibrate } from './monitor.mjs';
import { cost } from './cost.mjs';
import { loadProviderConfig, makeDefaultRegistry, discoverProviders, resolveProvider, providerRequest, targetSpec } from './provider/index.mjs';
import { evaluateWithProvider, runPolicyProvider, fixtureFromRun, policyConfigDefaults, makePolicyRegistry } from './evaluate.mjs';
import { makeGate, hookResponse, approveOnce, parseToolList } from './gate.mjs';

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
    console.log('jev validate POLICY.json\njev decide POLICY.json ANSWERS.json [FACTS.json]\njev state POLICY.json INPUT.json\njev schema POLICY.json\njev stats POLICY.json FIXTURE_DIR\njev calibrate POLICY.json FIXTURE_DIR\njev cost POLICY.json [INPUT.json] [FIXTURE_DIR]\njev evaluate POLICY.json INPUT.json   (calls the selected provider)\njev record POLICY.json INPUT.json     (calls it, and writes a fixture)\njev providers\njev gate hook POLICY.json [OPTIONS.json] < event.json   (calls the provider)\njev gate approve-once FINGERPRINT\njev replay POLICY.json FIXTURE_DIR\njev diff BEFORE.json AFTER.json FIXTURE_DIR\njev tune POLICY.json FIXTURE_DIR GRID.json\njev rpc'); return;
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
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => { console.error(JSON.stringify(error.toJSON?.() ?? { code: 'error', message: error.message })); process.exitCode = 1; });
}
