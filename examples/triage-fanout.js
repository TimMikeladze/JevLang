// Speculative fan-out: the portable mirror of jev-lang/examples/triage-fanout.rkt.
// One request asks every question the route might need; the gates are on-read, so
// a speculative question only escalates when the route actually reads it.
import { choice, definePolicy, gate, rule, all, not, compare, threshold, record, assign, escalate } from '../src/index.js';

const department = choice('department', 'Which team should handle this?', {
  returns: 'Exchanges, refunds, wrong or damaged items',
  shipping: 'Delivery status, delays, lost packages',
  billing: 'Charges, invoices, payment problems',
});
const returnReason = choice('return-reason', 'If the customer wants to return something, why?', {
  wrong_size: "The item doesn't fit",
  wrong_item: 'A different product was delivered',
  damaged: 'The item arrived broken or faulty',
  changed_mind: 'The item is fine, the customer no longer wants it',
  other: 'A return reason that fits none of the above',
});
const shippingIssue = choice('shipping-issue', 'If this is a shipping problem, which kind is it?', {
  not_delivered: 'The package never arrived',
  delayed: 'The package is late but still on its way',
  wrong_address: 'The package went to the wrong place',
  damaged_in_transit: 'The package arrived damaged',
  other: 'A shipping problem that fits none of the above',
});
const resolution = choice('resolution', 'What does the customer want to happen?', {
  exchange: 'Swap the item for a different one',
  refund: 'Money back',
  replacement: 'The same item sent again',
  information: 'Just an answer, no action needed',
  other: 'Something else, or nothing stated',
});

export const policy = definePolicy({
  name: 'triage-fanout', version: '1', owner: 'support', model: 'jev-1.13.0',
  questions: [department, returnReason, shippingIssue, resolution],
  thresholds: { 'second-team': 0.25 },
  gates: [
    gate(department, 0.3, escalate('manual-triage', { reason: 'not clear which team owns this' }), { onRead: true }),
    gate(returnReason, 0.5, escalate('manual-triage', { reason: 'return reason unclear' }), { onRead: true }),
    gate(shippingIssue, 0.6, escalate('manual-triage', { reason: 'shipping issue unclear' }), { onRead: true }),
  ],
  route: {
    clauses: [
      rule(department.is('returns'), assign('returns', { data: record({ issue: returnReason.value() }) })),
      rule(department.is('shipping'), assign('shipping', { data: record({ issue: shippingIssue.value() }) })),
      rule(department.is('billing'), assign('billing')),
    ],
  },
  // Side effects that apply whatever the route decided.
  flags: [
    { when: all(not(department.is('billing')), compare('gt', department.prob('billing'), threshold('second-team'))), flag: 'copy-billing' },
    { when: compare('lt', resolution.confidence(), 0.5), flag: 'ask-customer' },
  ],
});
