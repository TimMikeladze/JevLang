// The smallest useful policy.
// One question, one branch.
import { noul, definePolicy, rule, assign, hold } from '../src/index.js';

const spam = noul('spam?', 'Is this message spam?');

export const policy = definePolicy({
  name: 'hello',
  questions: [spam],
  route: { clauses: [rule(spam.yes(0.9), hold({ reason: 'almost certainly spam' }))], otherwise: assign('inbox') },
});

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const d = policy.decide({ 'spam?': { noul: 0.97 } });
  console.log(JSON.stringify({ action: d.action, reason: d.reason, clause: d.clause, readings: d.readings }));
}
