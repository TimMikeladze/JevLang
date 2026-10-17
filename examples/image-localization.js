// Offline by default. To evaluate your own prepared PNG/JPEG:
// TYPESAFE_API_KEY=... node examples/image-localization.js --live photo.png
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { box, noul, definePolicy, gate, rule, assign, hold, escalate, imageAsset, evaluateWithProvider } from '../src/index.js';

const present = noul('mug-present', 'Is there a coffee mug in `photo`?');
const mug = box('mug', 'The coffee mug in `photo`');
export const policy = definePolicy({
  name: 'image-localization', model: 'jev-1.14.0',
  typesafe: { experimental: { images: true } },
  state: { photo: { path: ['photo'] } },
  questions: [present, mug],
  gates: [gate(mug, 0.8, escalate('review', { reason: 'Location is uncertain' }), { onRead: true })],
  route: {
    clauses: [rule(present.yes(0.9), assign('found', { data: mug.value(), show: [mug] }))],
    otherwise: hold({ reason: 'No reliable evidence of a mug' }),
  },
});

export async function locatePhoto(path) {
  const reference = randomUUID();
  const format = extname(path).toLowerCase() === '.png' ? 'png' : 'jpg';
  return evaluateWithProvider(policy, { photo: reference }, {
    assets: { [reference]: imageAsset(await readFile(path), { format }) },
  });
}
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const decision = process.argv[2] === '--live'
    ? await locatePhoto(process.argv[3])
    : policy.decide({
      'mug-present': { type: 'noul', noul: 0.99 },
      mug: { type: 'box', box: { left: 0.44, right: 0.84, top: 0.25, bottom: 0.82 }, confidence: 0.92 },
    });
  console.log(JSON.stringify({ action: decision.action, target: decision.target, box: decision.data }, null, 2));
}
