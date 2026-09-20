// ticket-router, written the 2.0 way: the portable mirror of
// jev-lang/examples/ticket-router-v2.rkt. The questions are identical to
// ticket-router.mjs's, so every fixture recorded for one replays against the
// other; the gates are the difference. They are on-read, so an uncertain
// frustration answer only escalates a ticket whose route actually reads it.
import { choice, score, noul, definePolicy, gate, escalate, rule, all, page, assign, threshold } from '../src/index.mjs';

const department = choice('department', 'Which team should handle this ticket?', {
  billing: 'Payments, invoicing, refunds, payouts, card failures',
  technical: 'Bugs, outages, API errors, integration problems',
  sales: 'Pricing, upgrades, quotas, new accounts',
});
const frustration = score('frustration', 'How frustrated is the customer?', [
  'Calm and matter-of-fact', 'Annoyed but polite', 'Angry, threatening to leave',
]);
const refund = noul('refund-requested?', 'Is the customer asking for money back?', {
  criteria: { true: 'Explicitly asks for a refund, credit, or chargeback', false: 'No mention of getting money back' },
});

export const policy = definePolicy({
  name: 'ticket-router', version: '2', owner: 'support', model: 'jev-1.13.0',
  questions: [department, frustration, refund],
  state: { ticket: { path: [] } },
  thresholds: { 'refund-min': 0.8 },
  gates: [
    gate(department, 0.8, escalate('human-triage', { reason: 'unclear which team owns this' }), { onRead: true }),
    gate(frustration, 0.7, escalate('human-triage', { reason: 'unclear how upset they are' }), { onRead: true }),
  ],
  route: { clauses: [
    rule(all(refund.yes(threshold('refund-min')), frustration.mostLikely('Angry, threatening to leave')),
      page('retention-oncall', { reason: 'angry refund request' })),
    rule(department.is('billing'), assign('billing-queue')),
    rule(department.is('technical'), assign('engineering-oncall')),
    rule(department.is('sales'), assign('sales-inbox')),
  ] },
});
