# Images and Box localization

Use `box(id, instructions)` for a rectangle and a companion Noul for presence.
Box returns coordinates even if the target is absent. Check presence before
reading its coordinates and use an on-read confidence gate for localization.

```js
import { box, noul, definePolicy, gate, rule, assign, hold, escalate } from 'jevlang';

const present = noul('present', 'Is there a signature in photo?');
const location = box('location', 'The signature in photo');
export const policy = definePolicy({
  name: 'signature', model: 'jev-1.14.0',
  typesafe: { experimental: { images: true } },
  state: { photo: { path: ['photo'] } },
  questions: [present, location],
  gates: [gate(location, 0.8, escalate('review'), { onRead: true })],
  route: {
    clauses: [rule(present.yes(0.9), assign('found', { data: location.value() }))],
    otherwise: hold({ reason: 'No reliable evidence of a signature' }),
  },
});
```

An offline answer is `{ box: { left: 0.1, right: 0.8, top: 0.2, bottom: 0.6 },
confidence: 0.92 }`. Edges are finite fractions in [0,1], with left < right and
top < bottom. Missing or null Box confidence trips a confidence gate. Box
accepts no criteria; its gates support confidence, not margin or top probability.

Live images require explicit `experimental.images: true` on the policy or call.
Use `imageAsset(bytes, { format: 'png' })` and an `assets` map keyed by random
UUID strings; put those references in state or question content. Short tokens
can accidentally substitute ordinary text. The client supports still, upright
PNG/JPEG, each side 280–1568 pixels, at most 16 MiB per file; it never resizes
or rotates images for the caller. Account for the 32 MiB encoded request limit.
The service validates decoded pixels; header validation is not image decoding.

Keep `jev-1.14.0` separate from the JevLang npm version. Do not substitute a
moving model alias without checking its capabilities. Long context is a
separate opt-in (`experimental.longContext`).

Image runs record fixture version 4. Offline replay can check decisions without
image bytes, but `assetsVerified` remains false until bytes are supplied or
embedded. Do not call a decision-only replay proof of image-content equality.
For full transport details consult the upstream
[image guide](https://github.com/TimMikeladze/JevLang/blob/main/docs/jev-images.md)
or the matching file in the user's checkout.
