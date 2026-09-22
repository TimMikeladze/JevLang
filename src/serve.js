// An HTTP sidecar for one policy, so services in any language can use it.
//
//   GET  /healthz    {"ok": true, "policy": ...}
//   GET  /policy     questions, targets, gates, thresholds, model
//   POST /decide     {"answers": {...}}  -> the decision, offline and pure
//   POST /evaluate   {"state": ...}      -> asks the selected provider, then decides
//   POST /dispatch   {"input", "principal", "key", "dry_run"} -> evaluates, then
//                    runs the handlers; with "answers" it decides on those
//                    instead of asking a provider
//
// Every decision comes back as the decision plus an "explain" string.
//
// With a token, every request but GET /healthz needs
// "Authorization: Bearer <token>". The check is part of the HTTP layer;
// handleRequest, which has no socket, does not make it.
//
// /dispatch runs side effects, so outside a dry run it answers 403 unless the
// server has a token or is bound to loopback. The principal in the body is
// trusted because the caller is: keep the token secret.
//
// It binds 127.0.0.1 by default. If the port is taken it tries the next ones and
// reports the port it got; it never touches whatever holds the port it wanted.
//
// Other modules add routes: MCP's POST /mcp, and the webhook receivers' POST
// /webhook/<name>. A route's auth is 'token' (the bearer token applies, as for
// /evaluate) or 'open' (the route authenticates the request itself, as a webhook
// does with its signature).
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { object, own, requireAt } from './common.js';
import { explainDecision } from './explain.js';
import { policyToJson } from './mcp.js';
import { makeDispatcher, dispatchForInput, outcomeToJson } from './dispatch.js';

const builtinRoutes = [['GET', '/healthz'], ['GET', '/policy'], ['POST', '/decide'], ['POST', '/evaluate'], ['POST', '/dispatch']];
export const serveRoute = ({ method, path, prefix = false, auth = 'token', handler }) => ({ method, path, prefix, auth, handler });
const routeOf = path => `/${(path ?? '/').split('?')[0].replace(/^\/+/, '').replace(/\/+$/, '')}`;
const routeMatches = (route, path) => route.prefix ? path.startsWith(route.path) : path === route.path;

export const loopbackHost = host => ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host);
export function tokenMatches(token, header) {
  const m = /^Bearer\s+(.*)$/i.exec(String(header ?? '').trim());
  if (!m) return false;
  const a = Buffer.from(m[1], 'utf8'), b = Buffer.from(token, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

// The dispatchers /dispatch uses, from a handlers table. A confirm entry becomes
// the confirm handler, and the dry one runs nothing.
export function makeServeDispatchers(policy, handlers, { journal = null } = {}) {
  const { confirm, ...table } = handlers;
  return {
    run: makeDispatcher(table, { policy, confirm: confirm ?? null, journal }),
    dry: makeDispatcher(table, { policy, confirm: confirm ?? null, dryRun: true }),
  };
}
const errorBody = (message, kind) => ({ error: message, kind });
const decisionResponse = (policy, d) => ({
  ...d, explain: explainDecision(d),
  policy: { name: policy.policy.name ?? null, hash: policy.identity(), file: null },
});
const outcomeResponse = o => ({ ...outcomeToJson(o), explain: explainDecision(o.initial) });
// /decide gets answers from the caller, so a bad answer is the caller's (422);
// /evaluate gets them from a provider, so a bad answer is upstream's (502).
const errorKind = error => {
  const code = error.code ?? error.kind;
  if (['answers', 'response', 'state', 'timeout'].includes(code)) return code;
  if (['rate-limit', 'overload', 'authentication', 'auth'].includes(code)) return 'upstream';
  if (code === 'connection') return 'connection';
  if (typeof code === 'string' && code !== 'internal') return 'jev';
  return 'internal';
};
const errorStatus = (error, route) => {
  const kind = errorKind(error);
  if (kind === 'timeout') return 504;
  if (['upstream', 'connection'].includes(kind)) return 502;
  if (kind === 'response') return route === '/evaluate' ? 502 : 422;
  if (['answers', 'state'].includes(kind)) return 422;
  return 500;
};

// -> { status, body, headers }
export async function handleRequest(policy, method, path, body, {
  dispatchers = null, dispatchAllowed = true, headers = {}, routes = [], evaluate = null,
} = {}) {
  const route = routeOf(path);
  const matching = routes.filter(r => routeMatches(r, route));
  if (matching.length) {
    const chosen = matching.find(r => r.method === method);
    if (chosen) return chosen.handler(method, path, headers, body);
    const allow = matching.map(r => r.method).join(', ');
    return { status: 405, body: errorBody(`${route} takes ${allow}`, 'method'), headers: { Allow: allow } };
  }
  const allowed = builtinRoutes.filter(([, p]) => p === route).map(([m]) => m);
  if (!allowed.length) {
    return {
      status: 404,
      body: {
        ...errorBody(`no route ${route}`, 'not-found'),
        routes: [...builtinRoutes.map(r => r.join(' ')), ...routes.map(r => `${r.method} ${r.path}${r.prefix ? '<name>' : ''}`)],
      },
    };
  }
  if (!allowed.includes(method)) return { status: 405, body: errorBody(`${route} takes ${allowed.join(', ')}`, 'method') };
  if (route === '/healthz') return { status: 200, body: { ok: true, policy: policy.policy.name ?? null } };
  if (route === '/policy') return { status: 200, body: policyToJson(policy) };
  if (route === '/dispatch') return dispatchRequest(policy, body, dispatchers, dispatchAllowed, evaluate);
  let request;
  try { request = JSON.parse(typeof body === 'string' ? body : Buffer.from(body ?? '').toString('utf8')); } catch { request = undefined; }
  const key = route === '/decide' ? 'answers' : 'state';
  if (request === undefined) return { status: 400, body: errorBody('the body is not valid JSON', 'request') };
  if (!(object(request) && own(request, key))) {
    return {
      status: 400,
      body: errorBody(route === '/decide'
        ? 'expected {"answers": {...}}, the answers object of a policy provider response'
        : 'expected {"state": ...}, the input the policy\'s evaluate takes', 'request'),
    };
  }
  if (route === '/evaluate' && !evaluate) {
    return { status: 501, body: errorBody('this server was started without an evaluate function', 'unsupported') };
  }
  try {
    const decision = route === '/decide'
      ? policy.decide(request.answers, { facts: object(request.facts) ? request.facts : null })
      : await evaluate(request.state);
    return { status: 200, body: decisionResponse(policy, decision) };
  } catch (error) {
    return { status: errorStatus(error, route), body: errorBody(error.message, errorKind(error)) };
  }
}

async function dispatchRequest(policy, body, dispatchers, allowed, evaluate) {
  let request;
  try { request = JSON.parse(typeof body === 'string' ? body : Buffer.from(body ?? '').toString('utf8')); } catch { request = undefined; }
  const field = key => {
    const value = object(request) ? request[key] : null;
    return value === null || value === undefined ? null : value;
  };
  const dry = field('dry_run') === true;
  if (!dispatchers) return { status: 400, body: errorBody('this server has no handlers; start it with handlers', 'unsupported') };
  if (request === undefined) return { status: 400, body: errorBody('the body is not valid JSON', 'request') };
  if (!(object(request) && own(request, 'input'))) {
    return { status: 400, body: errorBody('expected {"input": ..., "principal": ..., "key": ..., "dry_run": false}', 'request') };
  }
  if (!dry && !allowed) {
    return {
      status: 403,
      body: errorBody('/dispatch runs handlers, so it needs a token or a loopback bind; a dry run is allowed', 'forbidden'),
    };
  }
  if (!field('answers') && !evaluate) {
    return { status: 501, body: errorBody('this server was started without an evaluate function; send "answers"', 'unsupported') };
  }
  const route = field('answers') ? '/decide' : '/evaluate';
  try {
    const input = request.input;
    const facts = policy.buildState(input).facts;
    const decide = field('answers')
      ? () => policy.decide(request.answers, { facts })
      : () => evaluate(input);
    const outcome = await dispatchForInput(dry ? dispatchers.dry : dispatchers.run, input, await decide(), {
      principal: field('principal'), key: field('key') === null ? null : String(field('key')),
    });
    return { status: 200, body: outcomeResponse(outcome) };
  } catch (error) {
    return { status: errorStatus(error, route), body: errorBody(error.message, errorKind(error)) };
  }
}

// Binds the port, or the next free one after it, and never touches whatever
// holds the one it wanted.
export async function startServer(policy, {
  host = '127.0.0.1', port = 8080, tries = 20, token = null, dispatchers = null,
  routes = [], evaluate = null, log = null,
} = {}) {
  requireAt(Number.isInteger(port) && port >= 0, 'port', 'a port is a non-negative integer');
  const dispatchAllowed = Boolean(token) || loopbackHost(host);
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', async () => {
      const body = Buffer.concat(chunks);
      const route = routeOf(request.url);
      const extra = routes.find(r => routeMatches(r, route));
      const needsToken = token && route !== '/healthz' && (!extra || extra.auth === 'token');
      let answer;
      if (needsToken && !tokenMatches(token, request.headers.authorization)) {
        answer = { status: 401, body: errorBody('this server needs Authorization: Bearer <token>', 'auth') };
      } else {
        try {
          answer = await handleRequest(policy, request.method, request.url, body, {
            dispatchers, dispatchAllowed, headers: request.headers, routes, evaluate,
          });
        } catch (error) {
          answer = { status: 500, body: errorBody(error.message, 'internal') };
        }
      }
      const text = answer.body === null || answer.body === undefined ? ''
        : Buffer.isBuffer(answer.body) ? answer.body : JSON.stringify(answer.body);
      response.writeHead(answer.status, {
        ...(text === '' ? {} : { 'Content-Type': 'application/json' }),
        'Content-Length': Buffer.byteLength(text),
        Connection: 'close',
        ...(answer.headers ?? {}),
      }).end(text);
      log?.write?.(`${request.method} ${route} ${answer.status}\n`);
    });
  });
  const wanted = port;
  let bound = null;
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const candidate = port === 0 ? 0 : wanted + attempt;
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(candidate, host, () => { server.removeListener('error', reject); resolve(); });
      });
      bound = server.address().port;
      break;
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error;
    }
  }
  requireAt(bound !== null, 'port', `every port from ${wanted} to ${wanted + tries - 1} is taken`);
  return {
    host, port: bound, wanted, dispatchAllowed,
    url: `http://${host}:${bound}`,
    async stop() { await new Promise(resolve => server.close(resolve)); },
  };
}
