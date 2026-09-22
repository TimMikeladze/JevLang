import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as createSocketServer } from 'node:net';
import { Readable } from 'node:stream';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadHandlers, handlerFromSpec, confirmHandler, fillTemplate, registerHandlerType, mqttPublish } from '../src/handlers.js';
import { makeLoop, loopStart, loopStop, loopPost, loopIdle, makeEvent, runEvents, timerSource, iterableSource, lineSource } from '../src/loop.js';
import { makeSessions, sessionMessage, sessionPending, sessionForget, defaultMerge } from '../src/session.js';
import { makeDispatcher, dispatch } from '../src/dispatch.js';
import { skipUnlessInMonorepo } from './monorepo.js';

const decision = (action, target, data = null, extra = {}) => ({
  action, target, reason: null, data, rule: 'route', clause: 0, source: null, line: null, file: null,
  model: null, provider: null, requested_model: null, requested_effort: null, effective_effort: null,
  request_id: null, stage: null, proposed: null, evidence: [], steps: [], readings: [], ...extra,
});

test('Racket oracle: the template grammar and the clarify merge', t => {
  if (skipUnlessInMonorepo(t)) return;
  const oracle = fileURLToPath(new URL('./automation-oracle.rkt', import.meta.url));
  const run = spawnSync('racket', [oracle], { encoding: 'utf8', env: { ...process.env, TYPESAFE_API_KEY: '', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '' } });
  assert.equal(run.status, 0, run.stderr);
  const expected = JSON.parse(run.stdout);
  const cases = [
    ['home/{room}/light', { room: 'kitchen' }],
    ['{action}:{target}', { action: 'act', target: 'lights-on' }],
    ['count={n} on={on} missing-nothing', { n: 3, on: true }],
    ['{list}', { list: ['a', 'b'] }],
    ['{obj}', { obj: { a: 1 } }],
    ['no placeholders', {}],
    ['{a-b?}', { 'a-b?': 'yes' }],
  ];
  assert.deepEqual(cases.map(([text, vars]) => ({ filled: fillTemplate(text, vars, 'oracle') })), expected.templates);
  // A name the decision does not have is an error, not an empty string.
  assert.equal(expected.missing, 'error');
  assert.throws(() => fillTemplate('{nope}', { room: 'kitchen' }, 'oracle'), /is not a parameter/);
  assert.equal(defaultMerge('turn the lights on', 'Which room?', 'the bedroom'), expected['merge-string']);
  assert.deepEqual(defaultMerge({ request: 'turn the lights on', rooms: ['kitchen'] }, 'Which room?', 'the bedroom'), expected['merge-object']);
});

test('a shell handler runs a declared argv, one argument per placeholder, and never a shell', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jev-handlers-'));
  const handlers = await loadHandlers({
    handlers: {
      'lock-door': { type: 'shell', argv: ['/bin/echo', 'lock', '{door}', 'at', '{key}'] },
      'many': { type: 'shell', argv: ['/bin/echo', '{rooms}'] },
      'failing': { type: 'shell', argv: ['/bin/sh', '-c', 'echo trouble >&2; exit 3'] },
      'slow': { type: 'shell', argv: ['/bin/sleep', '5'], timeout: 0.2 },
    },
  });
  const ran = await handlers['lock-door']({}, decision('act', 'lock-door', { door: 'front; rm -rf /' }), { key: 'req-1/lock-door' });
  // The argument holds a shell metacharacter and is still one argument.
  assert.equal(ran.stdout.trim(), 'lock front; rm -rf / at req-1/lock-door');
  const list = await handlers.many({}, decision('act', 'many', { rooms: ['kitchen', 'bedroom'] }), {});
  assert.equal(list.stdout.trim(), 'kitchen bedroom');
  await assert.rejects(handlers.failing({}, decision('act', 'failing'), {}), /exited with 3[\s\S]*trouble/);
  await assert.rejects(handlers.slow({}, decision('act', 'slow'), {}), /ran longer than 0.2 seconds and was killed/);
  // A placeholder for the executable is refused when the handler is built.
  assert.throws(() => handlerFromSpec('bad', { type: 'shell', argv: ['{exe}'] }, dir), /cannot be a placeholder/);
  assert.throws(() => handlerFromSpec('bad', { type: 'nonsense' }, dir), /unknown type/);
});

test('an http handler posts the decision with its idempotency key, and a confirm entry only approves on true', async t => {
  const seen = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      seen.push({ url: request.url, key: request.headers['idempotency-key'], body: JSON.parse(body) });
      if (request.url === '/approve') { response.writeHead(200, { 'content-type': 'application/json' }).end('{"approved": true}'); return; }
      if (request.url === '/deny') { response.writeHead(200, { 'content-type': 'application/json' }).end('{"approved": false}'); return; }
      if (request.url === '/boom') { response.writeHead(500).end('the model is down'); return; }
      response.writeHead(200, { 'content-type': 'application/json' }).end('{"queued": true}');
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;
  const handlers = await loadHandlers({
    handlers: {
      'chat-model': { type: 'http', url: `${url}/chat/{target}`, include_state: true },
      confirm: { type: 'http', url: `${url}/approve` },
      broken: { type: 'http', url: `${url}/boom` },
    },
  });
  const answer = await handlers['chat-model']({ ticket: 'x' }, decision('assign', 'chat-model'), { key: 'req-2/chat-model' });
  assert.deepEqual(answer, { queued: true });
  assert.equal(seen[0].url, '/chat/chat-model');
  assert.equal(seen[0].key, 'req-2/chat-model');
  assert.deepEqual(seen[0].body.state, { ticket: 'x' });
  // The confirm entry is wrapped: only true or {approved: true} approves.
  assert.equal(await handlers.confirm({}, decision('confirm', 'unlock'), {}), true);
  const denying = confirmHandler(async () => ({ approved: false }));
  assert.equal(await denying({}, decision('confirm', 'unlock'), {}), false);
  await assert.rejects(handlers.broken({}, decision('assign', 'broken'), {}), /answered 500[\s\S]*the model is down/);
});

test('a log handler writes one JSON line per decision', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jev-handlers-'));
  const path = join(dir, 'decisions.log');
  const handlers = await loadHandlers({ handlers: { 'ask-user': { type: 'log', path: 'decisions.log' } } }, dir);
  const logger = handlerFromSpec('ask-user', { type: 'log', path }, dir);
  assert.equal(await logger({}, decision('escalate', 'ask-user', null, { reason: 'which room?' }), { key: 'req-3/ask-user' }), 'logged');
  await logger({}, decision('escalate', 'ask-user'), {});
  const lines = (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].decision.reason, 'which room?');
  assert.equal(lines[0].key, 'req-3/ask-user');
  assert.equal(lines[1].key, null);
  assert.ok(handlers['ask-user']);
});

test('an mqtt handler speaks enough MQTT 3.1.1 to publish', async t => {
  const packets = [];
  const server = createSocketServer(socket => {
    socket.on('data', chunk => {
      packets.push(chunk);
      const type = chunk[0] & 0xF0;
      if (type === 0x10) socket.write(Buffer.from([0x20, 2, 0, 0]));       // CONNACK
      if (type === 0x30 && (chunk[0] & 0x06)) socket.write(Buffer.from([0x40, 2, 0, 1])); // PUBACK
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const port = server.address().port;
  const handler = handlerFromSpec('set-light', { type: 'mqtt', broker: `127.0.0.1:${port}`, topic: 'home/{room}/light', qos: 1 }, process.cwd());
  assert.deepEqual(await handler({}, decision('act', 'set-light', { room: 'kitchen', power: 'off' }), {}), { published: 'home/kitchen/light' });
  const publish = packets.find(p => (p[0] & 0xF0) === 0x30);
  assert.ok(publish, 'the broker saw a PUBLISH');
  assert.match(publish.toString('utf8'), /home\/kitchen\/light/);
  // The payload defaults to the act decision's parameters.
  assert.match(publish.toString('utf8'), /"room":"kitchen"/);
  // A broker that refuses the connection is an error, not a silent no-op.
  const refusing = createSocketServer(socket => socket.on('data', () => socket.write(Buffer.from([0x20, 2, 0, 5]))));
  await new Promise(resolve => refusing.listen(0, '127.0.0.1', resolve));
  t.after(() => refusing.close());
  await assert.rejects(mqttPublish('127.0.0.1', refusing.address().port, 'home/x', 'hi', { timeoutSeconds: 1 }), /not authorized/);
});

test('a loop serializes one key, debounces a burst, and drops what went stale', async () => {
  const handled = [];
  const d = makeDispatcher({ queue: async () => { await new Promise(r => setTimeout(r, 5)); return 'queued'; } });
  const l = makeLoop({
    evaluate: async input => decision('assign', 'queue', { input }),
    dispatcher: d, workers: 4, maxAge: 1,
    onOutcome: (event, result) => handled.push([event.input, result === 'stale' ? 'stale' : result.status]),
  });
  loopStart(l);
  // Same key: handled one at a time, in order.
  loopPost(l, makeEvent('a1', { key: 'panel' }));
  loopPost(l, makeEvent('a2', { key: 'panel' }));
  loopPost(l, makeEvent('b1', { key: 'sensor' }));
  // Older than maxAge when its turn comes: stale, never evaluated.
  loopPost(l, makeEvent('old', { key: 'other', at: Date.now() - 5000 }));
  await new Promise(r => setTimeout(r, 60));
  await loopStop(l);
  assert.deepEqual(handled.map(([input]) => input).sort(), ['a1', 'a2', 'b1', 'old']);
  assert.equal(handled.find(([input]) => input === 'old')[1], 'stale');
  assert.deepEqual(handled.filter(([input]) => input.startsWith('a')).map(([input]) => input), ['a1', 'a2']);
  assert.ok(loopIdle(l));

  // With a debounce, a burst for one key collapses to its latest.
  const debounced = [];
  const quick = makeLoop({
    evaluate: async input => decision('assign', 'queue', { input }),
    dispatcher: d, debounce: 0.02, onOutcome: event => debounced.push(event.input),
  });
  loopStart(quick);
  for (const input of ['x1', 'x2', 'x3']) loopPost(quick, makeEvent(input, { key: 'panel' }));
  await new Promise(r => setTimeout(r, 80));
  await loopStop(quick);
  assert.deepEqual(debounced, ['x3']);
});

test('sources post events, and a scenario run handles them in order', async () => {
  const d = makeDispatcher({ queue: () => 'queued' });
  const seen = [];
  const lines = Readable.from(['{"input": "from a line", "id": "delivery-1"}\n', 'not json\n', '"bare input"\n']);
  const bad = [];
  const l = makeLoop({
    evaluate: async input => decision('assign', 'queue', { input }),
    dispatcher: d, onOutcome: event => seen.push(event.input),
    sources: [
      lineSource(lines, { onError: (line, error) => bad.push(line) }),
      iterableSource((async function* () { yield 'from an iterable'; })()),
      timerSource(0.01, () => 'from a timer', { key: 'timer' }),
    ],
  });
  loopStart(l);
  await new Promise(r => setTimeout(r, 60));
  await loopStop(l);
  assert.ok(seen.includes('from a line'));
  assert.ok(seen.includes('bare input'));
  assert.ok(seen.includes('from an iterable'));
  assert.ok(seen.includes('from a timer'));
  assert.deepEqual(bad, ['not json']);

  const results = await runEvents(async input => decision('assign', 'queue', { input }), d,
    [makeEvent('one'), makeEvent('two'), makeEvent('old', { at: Date.now() - 10_000 })], { maxAge: 1 });
  assert.deepEqual(results.map(([event, result]) => [event.input, result === 'stale' ? 'stale' : result.status]),
    [['one', 'ran'], ['two', 'ran'], ['old', 'stale']]);
});

test('a session remembers a clarify, merges the reply, and holds after too many rounds', async () => {
  const d = makeDispatcher({ queue: () => 'queued' });
  const asked = [];
  const evaluate = async input => {
    asked.push(input);
    return typeof input === 'string' && input.includes('bedroom')
      ? decision('assign', 'queue')
      : decision('clarify', null, { question: 'Which room?', about: 'lights-on-in' });
  };
  const s = makeSessions(evaluate, d, { maxRounds: 2 });
  const first = await sessionMessage(s, 'panel', 'turn the lights on');
  assert.equal(first.status, 'passed');            // no clarify handler: it passes through
  assert.equal(first.final.action, 'clarify');
  assert.equal(sessionPending(s, 'panel'), 'Which room?');
  const second = await sessionMessage(s, 'panel', 'the bedroom');
  assert.equal(second.status, 'ran');
  assert.equal(second.final.target, 'queue');
  assert.equal(sessionPending(s, 'panel'), null);
  // The reply was merged into the original input, not sent on its own.
  assert.match(asked[1], /turn the lights on[\s\S]*Which room\?[\s\S]*the bedroom/);

  // Asking forever is not an option: after maxRounds it holds and says so.
  const stubborn = makeSessions(async () => decision('clarify', null, { question: 'Which room?' }), d, { maxRounds: 1 });
  await sessionMessage(stubborn, 'panel', 'lights');
  const held = await sessionMessage(stubborn, 'panel', 'still vague');
  assert.equal(held.final.action, 'hold');
  assert.match(held.final.reason, /still not clear after 1 question/);
  assert.deepEqual(held.final.data, { last_question: 'Which room?' });

  // A pending question expires, and can be forgotten.
  const expiring = makeSessions(async () => decision('clarify', null, { question: 'Which room?' }), d, { ttl: 0 });
  await sessionMessage(expiring, 'panel', 'lights');
  assert.equal(sessionPending(expiring, 'panel'), 'Which room?');
  await sessionMessage(expiring, 'panel', 'anything');
  sessionForget(expiring, 'panel');
  assert.equal(sessionPending(expiring, 'panel'), null);
});
