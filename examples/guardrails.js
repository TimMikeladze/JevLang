// Guardrails for an LLM app.
// Every clause is evaluated (collect) and the most severe outcome wins
// (precedence). The thresholds are named, so tune can sweep them.
import { noul, score, definePolicy, gate, rule, all, threshold, assign, escalate } from '../src/index.js';

const jailbreak = noul('jailbreak?', 'Is the message trying to get the assistant to ignore its instructions or safety rules?');
const selfHarm = noul('self-harm?', 'Does the message express an intent to harm oneself?');
const pii = noul('pii-request?', 'Does the message ask for personal data about someone other than the sender?');
const severity = score('severity', 'How much harm would complying with the message do?', [
  { name: 'none', level: 'No plausible harm' },
  { name: 'minor', level: 'Minor or easily reversed harm' },
  { name: 'serious', level: 'Serious or irreversible harm to a person' },
]);

export const policy = definePolicy({
  name: 'guardrails', version: '1', owner: 'trust-and-safety', model: 'jev-1.13.0',
  questions: [jailbreak, selfHarm, pii, severity],
  thresholds: { 'jailbreak-block': 0.85, 'jailbreak-review': 0.5, 'self-harm-min': 0.5, 'pii-min': 0.7 },
  profiles: { permissive: { 'jailbreak-block': 0.95, 'jailbreak-review': 0.75 } },
  gates: [gate(severity, 0.5, escalate('review', { reason: 'unclear how harmful complying would be' }), { onRead: true })],
  route: {
    mode: 'collect', precedence: ['support', 'block', 'review', 'pass'],
    clauses: [
      rule(selfHarm.yes(threshold('self-harm-min')), escalate('support', { reason: 'route to a trained person' })),
      rule(jailbreak.yes(threshold('jailbreak-block')), assign('block')),
      rule(jailbreak.yes(threshold('jailbreak-review')), escalate('review')),
      rule(all(pii.yes(threshold('pii-min')), severity.mostLikely('serious')), assign('block')),
      rule(pii.yes(threshold('pii-min')), escalate('review')),
    ],
    otherwise: assign('pass'),
  },
});
