import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
import { choice, definePolicy, gate, escalate, rule, assign } from 'jevlang';
import { explainDecision } from 'jevlang/explain';

const team = choice('team', 'Which team should handle this message?', {
  billing: 'Charges, invoices, refunds',
  technical: 'Bugs, outages, integration errors',
});

export const policy = definePolicy({
  name: 'support-router',
  questions: [team],
  state: { message: { path: ['message'], maxChars: 4000 } },
  gates: [gate(team, 0.8, escalate('human-triage', { reason: 'Uncertain team' }))],
  route: {
    clauses: [rule(team.is('billing'), assign('billing-queue'))],
    otherwise: assign('technical-queue'),
  },
});

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  for (const confidence of [0.95, 0.55]) {
    console.log(explainDecision(policy.decide({ team: { choice: 'billing', confidence } })));
  }
}
