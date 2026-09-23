// Clarify, then resume.
//
//   const s = makeSessions(evaluate, dispatcher);
//   await sessionMessage(s, 'kitchen-panel', 'turn the lights on');  // -> clarify "Which room?"
//   await sessionMessage(s, 'kitchen-panel', 'the bedroom');         // -> lights on in the bedroom
//
// When a policy answers with a clarify decision, the session remembers the
// input. The next message in the same session is merged with it and evaluated
// again. After maxRounds questions it holds instead of asking forever. Pending
// questions expire after ttl seconds. They live in this process unless `table`
// is shared (redisSessions from jevlang/redis): on serverless the reply can
// land on another instance, so pass one there.
import { object, requireAt } from './common.js';
import { dispatchForInput } from './dispatch.js';

export function defaultMerge(original, question, reply) {
  if (typeof original === 'string') return `${original}\n(Asked: ${question}) ${reply}`;
  requireAt(object(original), 'merge', 'the default merge takes a string or an object input',
    'Pass merge: (original, question, reply) => input.');
  return { ...original, clarification: { question, reply: String(reply) } };
}

// table: get(id) / set(id, value) / delete(id), synchronous or async; a Map by default.
export const makeSessions = (evaluate, dispatcher, { merge = defaultMerge, ttl = 300, maxRounds = 2, clock = () => Date.now(), table = new Map() } = {}) => {
  requireAt(typeof evaluate === 'function', 'evaluate', 'sessions need an evaluate function');
  requireAt(dispatcher && typeof dispatcher.targets === 'function', 'dispatcher', 'sessions need a dispatcher');
  requireAt(Number.isInteger(maxRounds) && maxRounds >= 0, 'maxRounds', 'maxRounds is a count of at least 0');
  requireAt(['get', 'set', 'delete'].every(m => typeof table?.[m] === 'function'), 'table', 'a session table has get, set and delete');
  return { evaluate, dispatcher, merge, ttl, maxRounds, clock, table };
};
const then = (value, fn) => value instanceof Promise ? value.then(fn) : fn(value);
const take = async (s, id) => {
  const p = await s.table.get(id);
  await s.table.delete(id);
  return p && s.clock() - p.at <= 1000 * s.ttl ? p : null;
};
export const sessionPending = (s, id) => then(s.table.get(id), p => p?.question ?? null);
export const sessionForget = (s, id) => s.table.delete(id);

// -> the dispatch outcome. A clarify outcome passes through unless the
// dispatcher has a clarify handler; the question is in the decision's data.
export async function sessionMessage(s, id, message, { principal = null, key = null } = {}) {
  const held = await take(s, id);
  const input = held ? s.merge(held.input, held.question, message) : message;
  const rounds = held ? held.rounds : 0;
  const decision = await s.evaluate(input);
  let final = decision;
  if (decision.action === 'clarify') {
    const question = object(decision.data) ? decision.data.question ?? '' : '';
    if (rounds >= s.maxRounds) {
      final = {
        ...decision, action: 'hold', target: null, proposed: null,
        reason: `still not clear after ${rounds} question${rounds === 1 ? '' : 's'}`,
        data: { last_question: question },
      };
    } else {
      await s.table.set(id, { input, question, rounds: rounds + 1, at: s.clock() });
    }
  }
  return dispatchForInput(s.dispatcher, input, final, { principal, key });
}
