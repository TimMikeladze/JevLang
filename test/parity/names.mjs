// The portable mirror of test/parity/names.rkt: option code names and wire keys,
// named score levels, a raw question, and an extra request body.
import { choice, score, rawQuestion, definePolicy, gate, escalate, rule, all, page, assign, hold, record, compute } from '../../src/index.mjs';

export const intent = choice('intent', 'What is the user asking to do?', [
  { key: 'check-balance', description: 'Check an account balance' },
  { name: 'approve-transfer', key: 'approve_transfer', description: 'Approve the pending transfer' },
  { key: 'other request', description: 'Anything else' },
]);
export const urgency = score('urgency', 'How urgent is the request?', [
  { name: 'calm', level: 'No time pressure' },
  { name: 'soon', level: 'Wants it today' },
  { name: 'now', level: 'Needs it immediately' },
]);
export const sentiment = rawQuestion('sentiment', { type: 'noul', instructions: 'Is the customer upset?' });

export const policy = definePolicy({
  name: 'names',
  questions: [intent, urgency, sentiment],
  state: { request: {} },
  extraBody: { trace: 'portable-parity' },
  gates: [
    gate(intent, 0.8, escalate('human', { reason: 'unclear intent' })),
    gate(urgency, 0.7, escalate('human', { reason: 'unclear urgency' })),
  ],
  route: {
    clauses: [
      rule(all(intent.is('approve-transfer'), urgency.mostLikely('now')),
        page('transfer-desk', {
          reason: 'urgent transfer approval',
          data: record({ wire: intent.chosen(), code: intent.value(), upset: compute('get', sentiment.raw(), 'noul', null) }),
        })),
      rule(intent.is('approve-transfer'),
        assign('transfer-queue', { data: record({ wire: intent.chosen(), code: intent.value() }) })),
      rule(all(intent.is('check-balance'), urgency.atLeast('soon')), assign('balance-fast')),
      rule(intent.is('check-balance'), assign('self-serve')),
      rule(intent.is('other request'), hold({ reason: 'nothing to route' })),
    ],
  },
});
