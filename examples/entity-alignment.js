// Knowledge-graph entity alignment. The score's three levels are the three
// things you can do with a pair, and the middle level is the review path. The
// gate matters: nearest() rounds the answer's expected level, so without it an
// unsure answer (p(same) ≈ 0.3, an expected level near 1.5) would merge, and
// merges chain. Below 0.7 confidence the pair goes to the curator instead. The
// nouls ride along as evidence for the curator.
import { noul, score, definePolicy, rule, assign, escalate, eq, gate } from '../src/index.js';

const link = score('link', 'Do `left` and `right` describe the same product?', [
  { name: 'different', level: 'They describe two different products.' },
  { name: 'curator', level: 'They might be the same product; a person should check.' },
  { name: 'same', level: 'They describe the same product.' },
]);
const sameName = noul('same-name?', 'Do `left` and `right` give the same product name?');
const sameBrewery = noul('same-brewery?', 'Do `left` and `right` name the same brewery?');

export const policy = definePolicy({
  name: 'entity-alignment', version: '2', model: 'jev-1.13.0',
  questions: [link, sameName, sameBrewery],
  state: { left: { path: ['left'] }, right: { path: ['right'] } },
  gates: [gate(link, 0.7, escalate('curator', { reason: 'not sure these are the same product', show: [sameName, sameBrewery] }))],
  route: {
    clauses: [
      rule(eq(link.nearest(), 'same'), assign('merge')),
      rule(eq(link.nearest(), 'different'), assign('leave-unlinked')),
    ],
    otherwise: escalate('curator', { reason: 'might be the same product', show: [sameName, sameBrewery] }),
  },
});
