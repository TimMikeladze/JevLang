// Fraud review on a payment dispute: the portable mirror of
// jev-lang/examples/dispute-review.rkt. The state form declares exactly which
// fields leave the network, what is stripped from them, and how large they get.
import { choice, score, noul, definePolicy, gate, rule, all, assign, escalate } from '../src/index.mjs';

const verdict = choice('verdict', 'How should this payment dispute be resolved?', {
  refund: "The customer's account is clearly in the right: refund it",
  deny: 'The charge is valid and well evidenced: deny the dispute',
  investigate: 'The record is contradictory or incomplete',
});
const risk = score('risk', 'How likely is this dispute to be fraudulent?', [
  'Clearly legitimate, consistent with the account history',
  'Some inconsistencies worth a look',
  'Strong fraud signals: mismatched patterns or a fresh account',
]);
const firstTime = noul('first-time?', "Is this the customer's first dispute?", {
  criteria: { true: 'No prior disputes appear in the record', false: 'The record shows earlier disputes' },
});

export const policy = definePolicy({
  name: 'dispute-review',
  questions: [verdict, risk, firstTime],
  state: {
    claim: { path: ['claim'], default: '', maxChars: 1200 },
    'amount-usd': { path: ['amount'], default: 0 },
    'account-age': { path: ['account-age-days'], default: 0 },
    'prior-disputes': { path: ['prior-disputes'], default: 0 },
    merchant: { path: ['merchant'], default: 'unknown' },
    'recent-activity': { path: ['activity'], default: [] },
  },
  stateOptions: { redact: ['emails', 'phones', 'cards', 'ssn', 'keys', 'ips'], maxChars: 3000 },
  gates: [
    gate(verdict, 0.85, escalate('fraud-analyst', { reason: 'verdict not clear enough to act on' })),
    gate(risk, 0.75, escalate('fraud-analyst', { reason: 'risk read is unstable' })),
  ],
  route: {
    clauses: [
      // High risk outranks a confident verdict: never auto-refund a likely fraud.
      rule(risk.mostLikely('Strong fraud signals: mismatched patterns or a fresh account'),
        escalate('fraud-analyst', { reason: 'strong fraud signals' })),
      rule(all(verdict.is('refund'), firstTime.yes(0.7)), assign('auto-refund', { reason: 'clean first dispute' })),
      rule(verdict.is('refund'), escalate('fraud-analyst', { reason: 'repeat disputer wants a refund' })),
      rule(verdict.is('deny'), assign('deny-with-evidence')),
      rule(verdict.is('investigate'), escalate('fraud-analyst', { reason: 'contradictory record' })),
    ],
  },
});
