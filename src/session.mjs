// Clarify, then resume.
//
//   const s = makeSessions(evaluate, dispatcher);
//   await sessionMessage(s, 'kitchen-panel', 'turn the lights on');  // -> clarify "Which room?"
//   await sessionMessage(s, 'kitchen-panel', 'the bedroom');         // -> lights on in the bedroom
//
// When a policy answers with a clarify decision, the session remembers the
// input. The next message in the same session is merged with it and evaluated
// again. After maxRounds questions it holds instead of asking forever. Pending
// questions expire after ttl seconds and live in this process only.
import { object, requireAt } from './common.mjs';
import { dispatchForInput } from './dispatch.mjs';

export function defaultMerge(original, question, reply) {
  if (typeof original === 'string') return `${original}\n(Asked: ${question}) ${reply}`;
  requireAt(object(original), 'merge', 'the default merge takes a string or an object input',
    'Pass merge: (original, question, reply) => input.');
  return { ...original, clarification: { question, reply: String(reply) } };
}

export const makeSessions = (evaluate, dispatcher, { merge = defaultMerge, ttl = 300, maxRounds = 2, clock = () => Date.now() } = {}) => {
  requireAt(typeof evaluate === 'function', 'evaluate', 'sessions need an evaluate function');
  requireAt(dispatcher && typeof dispatcher.targets === 'function', 'dispatcher', 'sessions need a dispatcher');
  requireAt(Number.isInteger(maxRounds) && maxRounds >= 0, 'maxRounds', 'maxRounds is a count of at least 0');
  return { evaluate, dispatcher, merge, ttl, maxRounds, clock, table: new Map() };
};
const take = (s, id) => {
  const p = s.table.get(id);
  s.table.delete(id);
  return p && s.clock() - p.at <= 1000 * s.ttl ? p : null;
};
export const sessionPending = (s, id) => s.table.get(id)?.question ?? null;
export const sessionForget = (s, id) => s.table.delete(id);

// -> the dispatch outcome. A clarify outcome passes through unless the
// dispatcher has a clarify handler; the question is in the decision's data.
export async function sessionMessage(s, id, message, { principal = null, key = null } = {}) {
  const held = take(s, id);
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
      s.table.set(id, { input, question, rounds: rounds + 1, at: s.clock() });
    }
  }
  return dispatchForInput(s.dispatcher, input, final, { principal, key });
}
