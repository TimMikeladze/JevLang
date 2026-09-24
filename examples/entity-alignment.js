// Knowledge-graph entity alignment. The score's three levels are the three
// things you can do with a pair, so there is no threshold to fit: the question is
// ungated with the reason on record, and the middle level is the review path. The
// nouls ride along as evidence for the curator.
import { noul, score, definePolicy, rule, assign, escalate, eq } from '../src/index.js';

const link = score('link', 'Do `left` and `right` describe the same product?', [
  { name: 'different', level: 'They describe two different products.' },
  { name: 'curator', level: 'They might be the same product; a person should check.' },
  { name: 'same', level: 'They describe the same product.' },
], { ungated: 'the three levels are the three outcomes; the middle one is the review path' });
const sameName = noul('same-name?', 'Do `left` and `right` give the same product name?');
const sameBrewery = noul('same-brewery?', 'Do `left` and `right` name the same brewery?');

export const policy = definePolicy({
  name: 'entity-alignment', version: '1', model: 'jev-1.13.0',
  questions: [link, sameName, sameBrewery],
  state: { left: { path: ['left'] }, right: { path: ['right'] } },
  route: {
    clauses: [
      rule(eq(link.nearest(), 'same'), assign('merge')),
      rule(eq(link.nearest(), 'different'), assign('leave-unlinked')),
    ],
    otherwise: escalate('curator', { reason: 'might be the same product', show: [sameName, sameBrewery] }),
  },
});
