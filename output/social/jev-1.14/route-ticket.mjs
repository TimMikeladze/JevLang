import {
  choice, definePolicy, gate, rule, assign,
  evaluateWithProvider,
} from 'jevlang';

const issue = choice('issue', 'Does this ticket report an active service outage?', [
  'outage', 'routine',
]);

const policy = definePolicy({
  name: 'ticket-triage', model: 'jev-1.14.0',
  questions: [issue],
  state: { ticket: { path: ['ticket'] } },
  gates: [gate(issue, 0.85, assign('human-review'))],
  route: {
    clauses: [rule(issue.is('outage'), assign('on-call'))],
    otherwise: assign('support'),
  },
});

const ticket = process.argv[2];
if (!ticket) throw new Error('Pass the ticket text as the first argument.');
const decision = await evaluateWithProvider(policy, { ticket }, { provider: 'typesafe' });
console.log(JSON.stringify({ queue: decision.target }, null, 2));
