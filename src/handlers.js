// Handlers declared in a file, so devices can be wired up without writing code.
//
//   {"handlers": {
//     "set-light":   {"type": "mqtt", "broker": "localhost:1883", "topic": "home/{room}/light"},
//     "unlock-door": {"type": "shell", "argv": ["/usr/local/bin/door", "unlock", "{door}"], "timeout": 5},
//     "chat-model":  {"type": "http", "url": "http://localhost:8080/chat"},
//     "ask-user":    {"type": "log"},
//     "confirm":     {"type": "http", "url": "http://localhost:8080/approve"}}}
//
// loadHandlers('handlers.json') returns the map a dispatcher takes. Other
// top-level keys are left alone, for other tools that share the file.
//
// {name} in a string is replaced by that parameter of the act decision (or
// action, target, reason, key for any decision). A shell argument that is
// exactly "{name}" becomes one argument, whatever the value holds, and a list
// becomes several; nothing is ever passed through a shell, and the executable
// itself cannot be a placeholder.
//
// A "confirm" entry approves when its result is true, or an object with
// "approved": true. Anything else declines.
import { readFile } from 'node:fs/promises';
import { appendFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { connect as netConnect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { dirname, isAbsolute, resolve as resolvePath } from 'node:path';
import { object, requireAt, finite } from './common.js';
import { findExecutable } from './provider/command.js';

const types = new Map();
export function registerHandlerType(type, make) {
  requireAt(typeof type === 'string' && typeof make === 'function', 'registerHandlerType', 'a type name and a function of (spec, baseDir)');
  types.set(type, make);
}
const specError = (target, message, fix) => requireAt(false, `handlers.${target}`, message, fix, 'handler');

export function handlerFromSpec(target, spec, baseDir = process.cwd()) {
  if (!object(spec)) specError(target, 'expected an object with a "type"');
  const make = types.get(spec.type);
  if (!make) specError(target, `unknown type ${JSON.stringify(spec.type)}`, `Types: ${[...types.keys()].sort().join(', ')}.`);
  return make({ ...spec, target: String(target) }, baseDir);
}

// src: a file path, or the parsed file.
export async function loadHandlers(src) {
  const [parsed, base] = object(src)
    ? [src, process.cwd()]
    : [JSON.parse(await readFile(src, 'utf8')), dirname(resolvePath(src))];
  const specs = parsed?.handlers;
  requireAt(object(specs), 'handlers', 'expected {"handlers": {"target": {"type": ...}, ...}}', undefined, 'handler');
  return Object.fromEntries(Object.entries(specs).map(([target, spec]) => {
    const handler = handlerFromSpec(target, spec, base);
    return [target, target === 'confirm' ? confirmHandler(handler) : handler];
  }));
}
// Only true, or {"approved": true}, approves.
export const confirmHandler = h => {
  const handler = async (state, decision, context) => {
    const r = await h(state, decision, context);
    return r === true || (object(r) && r.approved === true);
  };
  handler.handlerName = 'confirm';
  return handler;
};

const decisionVars = (decision, context) => ({
  action: decision.action,
  target: decision.target ?? '',
  reason: decision.reason ?? '',
  key: context?.key ?? '',
  ...(object(decision.data) ? decision.data : {}),
});
const valueString = v => typeof v === 'string' ? v
  : typeof v === 'number' ? String(v)
  : typeof v === 'boolean' ? String(v)
  : JSON.stringify(v);
// "home/{room}/light" -> "home/kitchen/light". An unknown name is an error.
export function fillTemplate(text, vars, who) {
  return text.replace(/{([a-zA-Z0-9_?!-]+)}/g, (all, name) => {
    requireAt(Object.hasOwn(vars, name), who, `{${name}} is not a parameter of this decision`,
      `It has: ${Object.keys(vars).sort().join(', ')}.`, 'handler');
    return valueString(vars[name]);
  });
}
const specNumber = (spec, key, fallback, target) => {
  const v = Object.hasOwn(spec, key) ? spec[key] : fallback;
  if (v !== null && v !== false && !(finite(v) && v > 0)) specError(target, `"${key}" must be a positive number`);
  return v;
};
const tail = (text, n = 2000) => text.length > n ? text.slice(-n) : text;
const jsonSafe = v => Array.isArray(v) ? v.map(jsonSafe)
  : object(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, jsonSafe(x)]))
  : (v === undefined ? null : v);

// shell: run a declared argv, with no shell in between.
registerHandlerType('shell', (spec, base) => {
  const target = spec.target;
  const argv = spec.argv;
  if (!Array.isArray(argv) || argv.length === 0 || !argv.every(x => typeof x === 'string')) {
    specError(target, '"argv" must be a non-empty list of strings');
  }
  if (argv[0].includes('{')) specError(target, 'the executable (argv[0]) cannot be a placeholder; only arguments can');
  const executable = isAbsolute(argv[0]) ? argv[0]
    : argv[0].includes('/') ? resolvePath(base, argv[0])
    : findExecutable(argv[0]) ?? specError(target, `no executable ${argv[0]} on PATH`);
  const timeoutSeconds = specNumber(spec, 'timeout', 30, target);
  const cwd = spec.cwd ? resolvePath(base, spec.cwd) : base;
  return (state, decision, context) => new Promise((resolve, reject) => {
    const vars = decisionVars(decision, context);
    const args = argv.slice(1).flatMap(a => {
      const whole = /^{([a-zA-Z0-9_?!-]+)}$/.exec(a);
      if (whole && Object.hasOwn(vars, whole[1])) {
        const v = vars[whole[1]];
        return Array.isArray(v) ? v.map(valueString) : [valueString(v)];
      }
      return [fillTemplate(a, vars, `handlers.${target}`)];
    });
    const child = spawn(executable, args, { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '', settled = false;
    const timer = setTimeout(() => {
      settled = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      reject(new Error(`handler '${target}': ${executable} ran longer than ${timeoutSeconds} seconds and was killed`));
    }, timeoutSeconds * 1000);
    child.stdout.setEncoding('utf8'); child.stdout.on('data', c => { out += c; });
    child.stderr.setEncoding('utf8'); child.stderr.on('data', c => { err += c; });
    child.on('error', error => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } });
    child.on('close', code => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (code !== 0) reject(new Error(`handler '${target}': ${executable} exited with ${code}\n  ${tail(err).trim()}`));
      else resolve({ exit: code, stdout: tail(out) });
    });
  });
});

// http: an unsigned JSON POST (use "webhook" for signed delivery).
registerHandlerType('http', (spec) => {
  const target = spec.target;
  if (typeof spec.url !== 'string') specError(target, '"url" is required');
  const timeoutSeconds = specNumber(spec, 'timeout', 10, target);
  const includeState = spec.include_state === true;
  return async (state, decision, context) => {
    const url = fillTemplate(spec.url, decisionVars(decision, context), `handlers.${target}`);
    const body = JSON.stringify({
      decision, key: context?.key ?? null,
      ...(includeState ? { state: jsonSafe(state) } : {}),
    });
    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        signal: AbortSignal.timeout(timeoutSeconds * 1000),
        headers: { 'Content-Type': 'application/json', ...(context?.key ? { 'Idempotency-Key': context.key } : {}) },
        body,
      });
    } catch (error) {
      const timedOut = error.name === 'TimeoutError' || error.name === 'AbortError';
      throw new Error(`handler '${target}': ${url} ${timedOut ? `gave no answer within ${timeoutSeconds} seconds` : `could not be reached: ${error.message}`}`);
    }
    const text = await response.text();
    if (response.status < 200 || response.status > 299) {
      throw new Error(`handler '${target}': ${url} answered ${response.status}\n  ${text.slice(0, 500)}`);
    }
    try { return JSON.parse(text); } catch { return text; }
  };
});

// log: one JSON line per decision, to stdout or a file.
registerHandlerType('log', (spec, base) => {
  const path = spec.path ? resolvePath(base, spec.path) : null;
  let queue = Promise.resolve();
  return async (state, decision, context) => {
    const line = JSON.stringify({ decision, key: context?.key ?? null });
    // One line at a time, so concurrent handlers do not interleave.
    queue = queue.then(async () => {
      if (path) await appendFile(path, `${line}\n`);
      else process.stdout.write(`${line}\n`);
    });
    await queue;
    return 'logged';
  };
});

// mqtt: a minimal MQTT 3.1.1 publisher (CONNECT, PUBLISH QoS 0/1, DISCONNECT).
const varint = n => {
  const bytes = [];
  let rest = n;
  do { const b = rest & 127; rest >>= 7; bytes.push(rest ? b | 128 : b); } while (rest);
  return Buffer.from(bytes);
};
const mqttString = s => {
  const b = Buffer.from(s, 'utf8');
  return Buffer.concat([Buffer.from([b.length >> 8, b.length & 255]), b]);
};
const packet = (typeFlags, body) => Buffer.concat([Buffer.from([typeFlags]), varint(body.length), body]);

export function mqttPublish(host, port, topic, payload, {
  qos = 0, retain = false, clientId = null, username = null, password = null, tls = false, timeoutSeconds = 10,
} = {}) {
  const who = `mqtt ${host}:${port}`;
  return new Promise((resolve, reject) => {
    const socket = tls ? tlsConnect({ host, port }) : netConnect({ host, port });
    let buffer = Buffer.alloc(0), stage = 'connack', settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true; clearTimeout(timer); socket.destroy();
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(() => finish(new Error(`${who}: no answer within ${timeoutSeconds} seconds`)), timeoutSeconds * 1000);
    socket.on('error', error => finish(new Error(`${who}: ${error.message}`)));
    socket.on('close', () => { if (stage !== 'done') finish(new Error(`${who}: the broker closed the connection`)); });
    socket.on('connect', () => {
      const flags = 0x02 | (username ? 0x80 : 0) | (password ? 0x40 : 0);
      socket.write(packet(0x10, Buffer.concat([
        mqttString('MQTT'), Buffer.from([4, flags, 0, 60]),
        mqttString(clientId ?? `jev-${Math.floor(Math.random() * 1e8)}`),
        username ? mqttString(username) : Buffer.alloc(0),
        password ? mqttString(password) : Buffer.alloc(0),
      ])));
    });
    const publish = () => {
      socket.write(packet(0x30 | (qos << 1) | (retain ? 1 : 0), Buffer.concat([
        mqttString(topic),
        qos === 1 ? Buffer.from([0, 1]) : Buffer.alloc(0),
        Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8'),
      ])));
      if (qos === 1) { stage = 'puback'; return; }
      stage = 'done';
      socket.write(Buffer.from([0xE0, 0]));
      finish(null);
    };
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      // Every packet here has a one-byte remaining length.
      while (buffer.length >= 2 && buffer.length >= 2 + buffer[1]) {
        const header = buffer[0], body = buffer.subarray(2, 2 + buffer[1]);
        buffer = buffer.subarray(2 + buffer[1]);
        if (stage === 'connack') {
          if (header !== 0x20 || body.length !== 2) return finish(new Error(`${who}: expected CONNACK`));
          if (body[1] !== 0) {
            const why = body[1] === 4 ? ', bad user name or password' : body[1] === 5 ? ', not authorized' : '';
            return finish(new Error(`${who}: the broker refused the connection (code ${body[1]}${why})`));
          }
          publish();
        } else if (stage === 'puback') {
          if (header !== 0x40) return finish(new Error(`${who}: expected PUBACK for the message`));
          stage = 'done';
          socket.write(Buffer.from([0xE0, 0]));
          return finish(null);
        }
      }
    });
  });
}
registerHandlerType('mqtt', (spec) => {
  const target = spec.target;
  const broker = spec.broker ?? 'localhost:1883';
  const parts = /^([^:]+)(?::([0-9]+))?$/.exec(broker);
  if (!parts) specError(target, '"broker" must be host or host:port');
  const tls = spec.tls === true;
  const host = parts[1], port = parts[2] ? Number(parts[2]) : (tls ? 8883 : 1883);
  if (typeof spec.topic !== 'string') specError(target, '"topic" is required');
  const qos = spec.qos ?? 0;
  if (qos !== 0 && qos !== 1) specError(target, '"qos" must be 0 or 1');
  const payload = spec.payload ?? 'params';
  const timeoutSeconds = specNumber(spec, 'timeout', 10, target);
  return async (state, decision, context) => {
    const vars = decisionVars(decision, context);
    const topic = fillTemplate(spec.topic, vars, `handlers.${target}`);
    const body = payload === 'params' ? JSON.stringify(jsonSafe(object(decision.data) ? decision.data : {}))
      : payload === 'decision' ? JSON.stringify(decision)
      : fillTemplate(payload, vars, `handlers.${target}`);
    await mqttPublish(host, port, topic, body, {
      qos, retain: spec.retain === true, clientId: spec.client_id ?? null,
      username: spec.username ?? null, password: spec.password_env ? process.env[spec.password_env] ?? null : null,
      tls, timeoutSeconds,
    });
    return { published: topic };
  };
});

// webhook: signed delivery, which comes with the integrations work.
registerHandlerType('webhook', (spec) => specError(spec.target,
  'the "webhook" type (signed delivery) comes with the integrations work, which is not ported yet',
  'Use "http" for a plain JSON POST.'));
