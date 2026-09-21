import { choice, score, noul, definePolicy, gate, escalate, rule, all, page, assign } from '../src/index.mjs';

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
  name: 'ticket-router',
  questions: [department, frustration, refund],
  state: { ticket: { path: [] } },
  gates: [
    gate(department, 0.8, escalate('human-triage', { reason: 'unclear which team owns this' })),
    gate(frustration, 0.7, escalate('human-triage', { reason: 'unclear how upset they are' })),
  ],
  route: { clauses: [
    rule(all(refund.yes(0.8), frustration.mostLikely('Angry, threatening to leave')), page('retention-oncall', { reason: 'angry refund request' })),
    rule(department.is('billing'), assign('billing-queue')),
    rule(department.is('technical'), assign('engineering-oncall')),
    rule(department.is('sales'), assign('sales-inbox')),
  ] },
});

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const ok = { department: { choice: 'billing', confidence: 0.92 }, frustration: { score: 0.2, confidence: 0.9 }, 'refund-requested?': { noul: 0.05 } };
  const low = { department: { choice: 'billing', confidence: 0.55 }, frustration: { score: 0.4, confidence: 0.8 }, 'refund-requested?': { noul: 0.02 } };
  for (const answers of [ok, low]) {
    const d = policy.decide(answers);
    console.log(JSON.stringify({ action: d.action, target: d.target, reason: d.reason, rule: d.rule, detail: d.readings[0].detail ?? null }));
  }
}
