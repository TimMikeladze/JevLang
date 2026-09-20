// The runtime behind serving webhooks: signed events in, decisions recorded,
// harvested, dispatched and shadowed.
//
// POST /webhook/<name> answers, in this order:
//
//   404  no such source
//   401  bad signature or stale timestamp (checked before the body is parsed)
//   400  not JSON
//   200  the source's sync answer, when it has one
//   200  {"duplicate": true}: a seen marker for this delivery exists
//   200  {"ignored": true}: the event adapter returned nothing
//   500  the adapter threw (the sender retries later, after you fix it)
//   202  {"accepted": true, "id", "events"}: written to queue/ first, then
//        marked seen, then answered. A crash after the write loses nothing; a
//        crash before the mark means a redelivery is processed twice. Delivery
//        is at least once.
//
// Workers take queue/ in name order (arrival order), one event per case at a
// time, so a case's outcome never overtakes its decision. A case is evaluated
// (one billed call), its fixture written, saved as pending in the harvest store,
// dispatched, and run through the shadow policy. An outcome goes to the harvest
// store. A failure moves the file to failed/ with the error; move it back to
// queue/ to retry. Files left in queue/ by a stop or a crash are processed on
// the next start.
//
// queue/ and failed/ hold the adapter's output (the policy input, before the
// policy's redactors run) until it is processed; keep the spool private. The
// fixtures and the harvest store hold only the built, redacted state. Raw bodies
// and headers are never written.
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile, mkdir, rename, unlink, appendFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve as resolvePath, basename } from 'node:path';
import { object, own, requireAt, equal } from './common.mjs';
import { verifierProblem, isCaseEvent, isOutcomeEvent } from './webhooks.mjs';
import { harvestAdd, harvestOutcome, harvestSettle, harvestDirs, safeCaseName, labelToString, parseIso8601 } from './harvest.mjs';
import { dispatch, outcomeToJson } from './dispatch.mjs';

const sha256Hex = text => createHash('sha256').update(text).digest('hex');
const iso = seconds => new Date(seconds * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
const firstLine = s => String(s).replace(/^jev: /, '').split('\n')[0];
const pad = (n, width) => String(n).padStart(width, '0');
const seenTtl = 7 * 86400;
const brief = d => ({ action: d.action, ...(d.target ? { target: d.target } : {}) });

// A wiring: where the spool lives, which sources feed it, and what happens to a
// decided case.
export function jevWiring({
  spool, sources, dispatcher = null, evaluate, recordDir = null, harvest = null,
  settleAfterDays = 7, shadow = null, shadowEvaluate = null, shadowLog = null,
  dispatchLog = null, workers = 2,
} = {}) {
  requireAt(typeof spool === 'string' && spool !== '', 'spool', 'a wiring needs a spool directory');
  requireAt(Array.isArray(sources) && sources.length > 0, 'sources', 'a wiring needs at least one source');
  const names = sources.map(s => s.name);
  requireAt(new Set(names).size === names.length, 'sources', 'two sources have the same name');
  requireAt(typeof evaluate === 'function', 'evaluate', 'a wiring needs an evaluate function for its policy');
  requireAt(settleAfterDays > 0, 'settleAfterDays', 'settleAfterDays is a positive number of days');
  requireAt(Number.isInteger(workers) && workers > 0, 'workers', 'workers is a positive integer');
  return {
    spool, sources, dispatcher, evaluate, recordDir, harvest, settleAfterDays,
    shadow, shadowEvaluate, shadowLog, dispatchLog, workers,
  };
}

// Everything that stops a wiring from starting, as sentences. A source must be
// able to check signatures: no verifier, or one whose secret is missing, is
// refused rather than run unsigned.
export function wiringProblems(w) {
  return w.sources.flatMap(source => {
    const { name, verify, insecure } = source;
    if (!verify) {
      return [`source '${name}' has no verifier; every source checks a signature\n    (verify: "none" with insecure: true accepts unsigned requests)`];
    }
    if (verify === 'none') {
      return insecure ? [] : [`source '${name}' has verify: "none", which also needs insecure: true`];
    }
    const problem = verifierProblem(verify);
    return problem ? [`source '${name}': ${problem}\n    refusing to start rather than accept unsigned webhooks`] : [];
  });
}

const writePrivate = async (path, text) => {
  await mkdir(join(path, '..'), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, text, { mode: 0o600 });
  await rename(temporary, path);
};
const eventToJson = ev => isCaseEvent(ev)
  ? { kind: 'case', id: ev.id, input: ev.input }
  : { kind: 'outcome', id: ev.id, outcome: ev.outcomeKind, label: ev.label ?? null, labels: ev.labels ?? null };

// -> the runtime: a route handler, the dispatcher, a summary, stats, drain, stop.
export async function startWiring(w, policy, {
  now = () => Math.floor(Date.now() / 1000), log = null, startWorkers = true,
} = {}) {
  const problems = wiringProblems(w);
  requireAt(problems.length === 0, 'wiring', `the wiring can't start:\n${problems.map(s => `  ${s}`).join('\n')}`);
  const spool = resolvePath(w.spool);
  const queueDir = join(spool, 'queue');
  const seenDir = join(spool, 'seen');
  const failedDir = join(spool, 'failed');
  for (const dir of [queueDir, seenDir, failedDir]) await mkdir(dir, { recursive: true });
  const recordDir = w.recordDir ? resolvePath(w.recordDir) : null;
  const harvestDir = w.harvest ? resolvePath(w.harvest) : null;
  if (recordDir) await mkdir(recordDir, { recursive: true });
  if (harvestDir) for (const dir of harvestDirs(harvestDir)) await mkdir(dir, { recursive: true });
  const shadowLog = w.shadow ? resolvePath(w.shadowLog ?? join(spool, 'shadow.jsonl')) : null;
  const dispatchLog = w.dispatcher ? resolvePath(w.dispatchLog ?? join(spool, 'dispatch.jsonl')) : null;
  const sources = new Map(w.sources.map(s => [s.name, s]));
  const settleAfter = 86400 * w.settleAfterDays;
  const stats = {};
  const bump = key => { stats[key] = (stats[key] ?? 0) + 1; };
  const lines = [];
  const say = (...parts) => {
    const line = parts.join('');
    lines.push(line);
    log?.write?.(`${line}\n`);
  };
  let writing = Promise.resolve();
  const appendJsonl = async (path, value) => {
    writing = writing.then(() => appendFile(path, `${JSON.stringify(value)}\n`)).catch(() => {});
    await writing;
  };
  const queueFiles = async () => (existsSync(queueDir) ? (await readdir(queueDir)) : [])
    .filter(f => f.endsWith('.json')).sort();

  let sequence = 0;
  const seenPath = (name, id) => join(seenDir, name, sha256Hex(id));
  const error = (status, message, kind) => ({ status, body: { error: message, kind } });

  // Accepting. One request at a time through the duplicate check and the write,
  // so a redelivery cannot slip past a marker being written.
  let accepting = Promise.resolve();
  const accept = async (path, headers, body) => {
    const route = `${path}?`.split('?')[0];
    const name = route.slice('/webhook/'.length);
    const source = sources.get(name);
    if (!source) { bump('not_found'); return error(404, `no webhook source ${JSON.stringify(name)}`, 'not-found'); }
    const text = Buffer.isBuffer(body) ? body.toString('utf8') : String(body);
    const raw = Buffer.isBuffer(body) ? body : Buffer.from(text, 'utf8');
    let ok = true, id = sha256Hex(raw), reason = null;
    if (source.verify !== 'none') {
      try {
        const answer = await source.verify(headers, raw, now());
        ({ ok, reason } = { ok: answer.ok, reason: answer.reason ?? null });
        id = answer.deliveryId ?? sha256Hex(raw);
      } catch (thrown) { ok = false; reason = `the verifier raised: ${firstLine(thrown.message)}`; }
    }
    if (!ok) {
      bump('rejected');
      say(`webhook ${name}: rejected (401): ${reason}`);
      return error(401, reason, 'signature');
    }
    let json;
    try { json = JSON.parse(text); } catch { bump('rejected'); return error(400, 'the body is not valid JSON', 'request'); }
    const adapterFailed = (what, thrown) => {
      bump('adapter_errors');
      const m = firstLine(thrown.message).replace(/^jev: /, '');
      const message = `the ${what} adapter for source '${name}' ${m.startsWith('returned') ? m : `raised: ${m}`}`;
      say(`webhook ${name}: 500: ${message}`);
      return error(500, message, 'adapter');
    };
    if (source.sync) {
      let answer;
      try { answer = await source.sync(json, headers); } catch (thrown) { return adapterFailed('sync', thrown); }
      if (answer) return { status: 200, body: answer };
    }
    const mine = accepting.then(async () => {
      if (existsSync(seenPath(name, id))) {
        bump('duplicate');
        say(`webhook ${name}: duplicate delivery ${id}, ignored`);
        return { status: 200, body: { duplicate: true, id } };
      }
      let produced;
      try { produced = await source.event(json, headers); } catch (thrown) { return adapterFailed('event', thrown); }
      const events = produced === null || produced === undefined || produced === false ? []
        : isCaseEvent(produced) || isOutcomeEvent(produced) ? [produced]
        : Array.isArray(produced) && produced.every(e => isCaseEvent(e) || isOutcomeEvent(e)) ? produced
        : null;
      if (events === null) {
        return adapterFailed('event', new Error('returned something that is not a case event, an outcome event, a list of them, or nothing'));
      }
      if (events.length === 0) { bump('ignored'); return { status: 200, body: { ignored: true, id } }; }
      for (const ev of events) {
        sequence += 1;
        const file = `${pad(Date.now(), 15)}-${pad(sequence, 6)}-${name}.json`;
        await writePrivate(join(queueDir, file), JSON.stringify({
          source: name, delivery_id: id, received_at: iso(now()), event: eventToJson(ev),
        }));
      }
      await mkdir(join(seenDir, name), { recursive: true });
      await writePrivate(seenPath(name, id), String(now()));
      bump('accepted');
      return { status: 202, body: { accepted: true, id, events: events.length } };
    });
    accepting = mine.then(() => {}, () => {});
    return mine;
  };

  // Processing.
  let warnedShadow = false;
  const runShadow = async (source, id, input, decided) => {
    let shadowDecision = null, mode = 'error', why = null;
    try {
      const pre = w.shadow.precheck(input);
      if (pre) { shadowDecision = pre; mode = 'precheck'; }
      else if (equal(w.shadow.questions(w.shadow.buildState(input).state), decided.questions)) {
        // The same questions, so the primary's answers are the shadow's too.
        shadowDecision = w.shadow.decide(decided.answers, { facts: w.shadow.buildState(input).facts });
        mode = 'same-answers';
      } else if (w.shadowEvaluate) {
        shadowDecision = await w.shadowEvaluate(input);
        mode = 'evaluated';
      } else {
        mode = 'skipped';
        why = 'the shadow asks different questions';
        if (!warnedShadow) {
          warnedShadow = true;
          say('warning: the shadow policy asks different questions than the primary, so it cannot reuse',
            " the primary's answers; shadow cases are skipped. Pass shadowEvaluate to evaluate it",
            ' separately (one more billed call per case).');
        }
      }
    } catch (thrown) { mode = 'error'; why = firstLine(thrown.message); }
    const changed = shadowDecision ? !equal(brief(decided.decision), brief(shadowDecision)) : null;
    await appendJsonl(shadowLog, {
      case_id: id, source, primary: brief(decided.decision),
      shadow: shadowDecision ? brief(shadowDecision) : null,
      changed, mode, reason: why, at: iso(now()),
    });
    if (!shadowDecision) return `, shadow ${mode}`;
    return changed ? `, shadow says ${labelToString(brief(shadowDecision))}` : ', shadow agrees';
  };

  const processCase = async (source, id, input) => {
    // evaluate returns what a real run leaves behind: the decision, the answers,
    // the questions it asked, and the fixture to record.
    const decided = await w.evaluate(input);
    const name = safeCaseName(id);
    let recorded = null;
    if (recordDir && decided.fixture) {
      recorded = join(recordDir, `${name}.json`);
      await writePrivate(recorded, `${JSON.stringify(decided.fixture, null, 2)}\n`);
    }
    const harvested = harvestDir && decided.fixture
      ? await harvestAdd(harvestDir, { caseId: id, fixture: decided.fixture, decision: decided.decision, source, now })
      : null;
    let outcome = null;
    if (w.dispatcher) {
      const state = decided.state ?? null;
      outcome = await dispatch(w.dispatcher, state, decided.decision, { key: `${source}:${id}`, facts: decided.facts ?? null });
      await appendJsonl(dispatchLog, { ...outcomeToJson(outcome), case_id: id, source, at: iso(now()) });
    }
    const shadowNote = w.shadow ? await runShadow(source, id, input, decided) : '';
    bump('decided');
    say(`webhook ${source} ${id}: ${labelToString(brief(decided.decision))}`,
      outcome ? `, dispatched (${outcome.status})` : '',
      recorded ? `, recorded ${basename(recorded)}` : '',
      !harvestDir ? '' : !harvested ? ', not harvested (nothing to replay)'
        : harvested.status === 'settled' ? ', already settled in the harvest store' : ', pending',
      shadowNote);
  };
  const processOutcome = async (source, ev) => {
    const id = ev.id;
    if (!harvestDir) { say(`webhook ${source} ${id}: ${ev.outcome} ignored (the wiring has no harvest store)`); return; }
    const r = await harvestOutcome(harvestDir, id, ev.outcome, {
      label: object(ev.label) ? ev.label : null, labels: object(ev.labels) ? ev.labels : null, now,
    });
    bump('outcomes');
    if (r.status === 'unknown') say(`webhook ${source} ${id}: ${ev.outcome} ignored: no decided case with this id`);
    else say(`webhook ${source} ${id}: ${ev.outcome} -> ${r.where}`, r.label ? ` (${labelToString(r.label)}, ${r.strength})` : '');
  };
  const failFile = async (file, thrown) => {
    bump('failed');
    const from = join(queueDir, file), to = join(failedDir, file);
    const message = thrown?.message ?? String(thrown);
    let parsed = null;
    try { parsed = JSON.parse(await readFile(from, 'utf8')); } catch { parsed = null; }
    try {
      if (object(parsed)) {
        await writePrivate(to, `${JSON.stringify({ ...parsed, error: message, failed_at: iso(now()) }, null, 2)}\n`);
        await unlink(from);
      } else {
        await rename(from, to);
        await writePrivate(`${to}.error`, message);
      }
    } catch (moving) { say(`webhook: could not move ${file} to failed/: ${moving.message}`); }
    say(`webhook ${object(parsed) ? parsed.source ?? '?' : '?'}: failed, moved to failed/${file}: ${firstLine(message)}`);
  };
  const processFile = async file => {
    try {
      const parsed = JSON.parse(await readFile(join(queueDir, file), 'utf8'));
      const ev = object(parsed) ? parsed.event : null;
      const source = object(parsed) ? parsed.source ?? '?' : '?';
      if (ev?.kind === 'case') await processCase(source, ev.id, ev.input);
      else if (ev?.kind === 'outcome') await processOutcome(source, ev);
      else throw new Error(`${file} is not a queued event`);
      await unlink(join(queueDir, file));
    } catch (thrown) { await failFile(file, thrown); }
  };
  const caseKeyOf = async file => {
    try {
      const parsed = JSON.parse(await readFile(join(queueDir, file), 'utf8'));
      return parsed.event.id ?? file;
    } catch { return file; }
  };

  // Maintenance: forget old seen markers, and settle pending cases.
  let lastMaintained = null;
  const maintain = async () => {
    try {
      const at = now();
      for (const name of existsSync(seenDir) ? await readdir(seenDir) : []) {
        const dir = join(seenDir, name);
        if (!(await stat(dir)).isDirectory()) continue;
        for (const marker of await readdir(dir)) {
          const path = join(dir, marker);
          let wrote = null;
          try { wrote = Number((await readFile(path, 'utf8')).trim()); } catch { wrote = null; }
          const when = Number.isFinite(wrote) ? wrote : Math.floor((await stat(path)).mtimeMs / 1000);
          if (at - when > seenTtl) await unlink(path).catch(() => {});
        }
      }
      if (harvestDir) {
        const { settled } = await harvestSettle(harvestDir, { after: settleAfter, now });
        if (settled.length) {
          say(`harvest: ${settled.length} pending case${settled.length === 1 ? '' : 's'} timed out after ${w.settleAfterDays} days`);
        }
      }
    } catch (thrown) { say(`webhook: maintenance failed: ${firstLine(thrown.message)}`); }
  };

  // Scheduling: workers take the queue in arrival order, one event per case at a
  // time, so a case's outcome never overtakes its decision.
  let running = false, pumping = null;
  const busy = new Set();
  const inFlight = new Set();
  const pump = async () => {
    for (;;) {
      if (!lastMaintained || now() - lastMaintained >= 3600) { await maintain(); lastMaintained = now(); }
      const files = await queueFiles();
      const blocked = new Set();
      let started = false;
      for (const file of files) {
        if (inFlight.has(file) || inFlight.size >= w.workers) continue;
        const key = await caseKeyOf(file);
        if (busy.has(key) || blocked.has(key)) { blocked.add(key); continue; }
        busy.add(key);
        inFlight.add(file);
        started = true;
        // eslint-disable-next-line no-loop-func
        (async () => {
          try { await processFile(file); } finally { busy.delete(key); inFlight.delete(file); }
        })();
      }
      if (!started) return;
      // Let the started work make progress before looking again.
      await new Promise(resolve => setImmediate(resolve));
      if (inFlight.size === 0 && (await queueFiles()).length === 0) return;
    }
  };
  const wake = () => {
    if (!running) return;
    pumping = (pumping ?? Promise.resolve()).then(pump).catch(() => {});
  };
  running = startWorkers;
  // Anything left in the queue by a stop or a crash is processed on the next start.
  if (startWorkers) wake();

  const summary = [
    `spool ${spool}`,
    `sources ${[...sources.keys()].join(', ')}`,
    w.dispatcher ? 'dispatching decisions' : 'no handlers: decisions are recorded, not dispatched',
    recordDir ? `recording fixtures to ${recordDir}` : 'not recording fixtures',
    harvestDir ? `harvesting to ${harvestDir}, settling after ${w.settleAfterDays} days` : 'no harvest store',
    w.shadow ? 'running a shadow policy' : 'no shadow policy',
    `${w.workers} worker${w.workers === 1 ? '' : 's'}`,
  ];
  return {
    routes: { 'POST /webhook/:name': accept },
    accept,
    dispatcher: w.dispatcher,
    summary,
    lines,
    stats,
    // Process everything in the queue and wait for it.
    async drain() {
      running = true;
      for (;;) {
        await pump();
        await pumping;
        while (inFlight.size) await new Promise(resolve => setImmediate(resolve));
        if ((await queueFiles()).length === 0) return;
      }
    },
    async stop() {
      running = false;
      await pumping;
      while (inFlight.size) await new Promise(resolve => setImmediate(resolve));
      await writing;
    },
    maintain,
  };
}
