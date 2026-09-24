// Pre-parsed value extraction. Code finds the candidates; the model picks
// one. The candidate addresses are the options of a choice built at run time, and
// each amount gets its own yes/no question. `receiptInput` is that code, so the
// state a host sends is built the same way and passes the same whitelist.
//
// Choosing an email address is the task, so emails are not redacted here: the
// model has to see which address the sender asked for. Phones, cards and keys
// still are.
import { choice, noulEach, definePolicy, gate, rule, assign, escalate, record, threshold } from '../src/index.js';

const emailRx = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const amountRx = /\$[0-9][0-9,]*(?:\.[0-9]{2})?/g;

// The state fields computed from the message body.
export const receiptInput = message => ({
  body: message.body,
  addresses: [...new Set(message.body.match(emailRx) ?? [])],
  amounts: message.body.match(amountRx) ?? [],
});

const receiptTo = choice('receipt-to', 'Which email address does the sender want their receipt sent to?', {
  none: 'None of the listed addresses is the one they asked for',
}, { optionsFrom: 'addresses' });
const credit = noulEach('credit?', {
  question: 'Is this amount a credit or refund to the customer, rather than a charge?',
}, 'amounts', { itemKey: 'amount' });

export const policy = definePolicy({
  name: 'receipt-extraction', version: '1', model: 'jev-1.13.0',
  questions: [receiptTo, credit],
  state: {
    body: { path: ['body'], maxChars: 4000 },
    addresses: { path: ['addresses'] },
    amounts: { path: ['amounts'] },
  },
  stateOptions: { redact: ['phones', 'cards', 'keys'] },
  thresholds: { 'credit-min': 0.7 },
  gates: [gate(receiptTo, 0.6, escalate('review', { reason: 'unsure which address' }))],
  route: {
    clauses: [rule(receiptTo.is('none'), escalate('review', { reason: 'no candidate fits' }))],
    otherwise: assign('send-receipt', {
      data: record({ to: receiptTo.chosen(), credits: credit.countYes(threshold('credit-min')) }),
    }),
  },
});
