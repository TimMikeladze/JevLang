# Jev images and client controls

JevLang supports Jev 1.14 Box localization, images in every question type, opt-in long context, multipart uploads, compression and cancellation. The default model is pinned to `jev-1.14.0`. The native [Python package](../python/JEV114.md) implements these portable features and documents usage and runtime boundaries. Shared golden fixtures verify both engines. Package releases remain separate from committing the source. TypeSafe labels images, Box and long context experimental. [Official images documentation](https://docs.typesafe.ai/images), [models](https://docs.typesafe.ai/models)

## Run the localization example

```sh
node examples/image-localization.js
```

This runs offline using recorded example answers and prints `assign`, `found` and normalized rectangle coordinates. To ask the hosted model about your own prepared image:

```sh
TYPESAFE_API_KEY=your-key node examples/image-localization.js --live photo.png
```

The example pairs a presence Noul with the Box. Box always returns a rectangle, including when the target is absent; low presence avoids reading the rectangle. Its on-read confidence gate sends uncertain localization to review. A Box confidence of null or an omitted confidence also trips the gate. There is no recommended universal confidence threshold. [Box documentation](https://docs.typesafe.ai/primitives/box)

## Prepare images explicitly

`imageAsset(bytes, { format })` accepts a Buffer or Uint8Array and returns portable JSON. Use a random UUID as the reference. References are literal substitutions in state, instructions and criteria, including inside sentences; a short reference can accidentally replace ordinary words. Object keys remain text.

```js
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { imageAsset, evaluateWithProvider } from 'jevlang';

const reference = randomUUID();
const image = imageAsset(await readFile('photo.png'), { format: 'png' });
const decision = await evaluateWithProvider(policy, { photo: reference }, {
  experimental: { images: true },
  assets: { [reference]: image },
});
```

This snippet assumes `policy` is a compiled policy that reads `photo`. Enable images on the policy with `typesafe: { experimental: { images: true } }` or per evaluation. Policy-owned example images go in `typesafe.assets`; runtime assets are merged without allowing reference collisions. Unused assets fail before sending. Compiling a policy never reads files or calls the network.

Accepted encodings are still PNG and JPEG (`png`, `jpg`, `jpeg`), ≤16 MiB per decoded file. Each side must be 280–1568 pixels. JevLang checks format signatures, structural headers, dimensions and PNG animation markers; the service remains responsible for decoding and validating pixel content. It never resizes or rotates images. Rotate the actual pixels upright before upload: the API strips metadata without applying EXIF orientation. [Image preparation and limits](https://docs.typesafe.ai/images#preparing-images)

Uploads prefer multipart, with the request JSON first and one file part per asset. Pass `assetTransport: 'json'` to send base64 JSON instead. The actual encoded body must fit 32 MiB, including multipart framing or base64 overhead. Internal portable storage has a separate bounded allowance for base64 expansion. Server re-encoding and repeated-reference expansion have additional limits that local upload sizes cannot predict exactly.

## Declare and use Box answers

```js
import { box } from 'jevlang';
const location = box('location', 'The signature in `photo`');
```

`value()` yields `{ top, bottom, left, right }`. Edge accessors return numeric expressions; `confidence()` returns a numeric-or-null expression and `hasConfidence()` tests availability. Edges must be finite fractions in [0,1], ordered left < right and top < bottom. Box accepts no criteria. Confidence gates support the confidence metric; option gates, top-probability and margin are invalid for Box.

Offline `policy.decide(answers)` works without image bytes. Coordinates are relative to the image named in the instructions; multiply by width/height in the application when cropping or drawing. Transform offsets yourself when localizing a crop. JevLang does not perform the crop.

## Long context and client options

```js
import { jevCall, listModels } from 'jevlang';

const controller = new AbortController();
const result = await jevCall(state, questions, {
  model: 'jev-1.14.0',
  experimental: { longContext: true },
  compression: 'auto',
  signal: controller.signal,
  timeoutSeconds: 10,
  retry: { maxRetries: 1 },
  headers: { 'X-Application': 'reviewer' },
});
const catalog = await listModels({ signal: controller.signal });
```

`state` and `questions` are the raw System One payload in this snippet. These client controls also pass through `evaluateWithProvider`. Cancellation stops fetch, body reads and pending waits without retrying. Partial retry overrides inherit the other defaults. Timeout values remain seconds; the existing total retry budget remains in force.

`compression: 'auto'` uses zstd for bodies ≥1 KiB when the Node runtime provides it, otherwise uncompressed bytes. Explicit `gzip` works across supported Node releases; explicit `zstd` requires runtime support. `false` disables compression for custom gateways. Compression cannot raise the body limit. Authentication, framing, encoding and experimental headers are generated by the client and cannot be overridden through `headers`.

By default the client estimates separate 32,000-token per-question and 64,000-token per-request ceilings. `experimental.longContext` raises both conservative local ceilings to 262,000 and sends the upstream long-context header. Application `stateOptions.tokenLimit` and `requestTokenLimit` can impose smaller limits. These are rough text estimates; no public image-token estimator exists, so an image request can still exceed server context limits. [Context limits](https://docs.typesafe.ai/models#context-length)

Model aliases are explicit choices. As verified on October 17, `jev-preview` points to 1.14 while `jev-latest` points to 1.13; `listModels()` returns the account's catalog without using its omissions to reject valid versioned IDs. TypeSafe 1.13 supports images but cannot answer Box questions.

## CLI image manifests

An asset manifest maps references to portable base64 assets or explicit files. Resolve file paths relative to the manifest:

```json
{
  "a26cff7f-e05e-4562-a491-ff8d1906ba40": { "path": "photo.png", "format": "png" }
}
```

Put the matching reference in `input.json`, then run:

```sh
jev evaluate policy.json input.json --assets assets.json --experimental-images
jev record policy.json input.json --assets assets.json --experimental-images
jev batch policy.json rows.ndjson --assets assets.json --experimental-images
jev models
```

A batch manifest is shared by every row; each row must reference its supplied images. Use an application evaluate callback for per-row asset maps. Add `--experimental-long-context`, `--compression gzip`, `--compression false`, or `--asset-transport json` when needed. Existing positional options JSON files still work for evaluate/record.

## Cache and fixture behavior

Answer cache keys include canonical image contents and placement, effective provider/model/effort and experimental flags. Renaming UUID references keeps a hit; changing image bytes or a configured model causes a miss. Changing compression does not invalidate inference answers. A fallback provider's completed answer is not persisted under the primary provider's key.

Moving Jev aliases expire after 300 seconds by default. `cacheMaxAgeSeconds` sets an explicit age; zero disables reuse of completed answers while still allowing in-flight deduplication. `cacheOnly: true` uses configured capability resolution without credential discovery or model calls. The cache stores the actual answering provider and model as provenance.

Image and experimental runs produce fixture version 4; ordinary text recordings remain version 3. V4 records image digests, dimensions, format, reference counts, effective flags and actual model provenance. It omits image bytes by default. To embed them use CLI `record --embed-assets` or `fixtureFromRun({ ..., assets, embedAssets: true })`.

`replay(policy, fixtures)` can decide from recorded answers without image bytes or network. `decisionVerified` reports whether the recorded questions or policy identity match; `assetsVerified` remains false without verified bytes. Provide `replay(policy, fixtures, { assets })` or use embedded bytes to verify asset digests. A changed static criterion image makes old fixtures stale. Replay never retrieves a file or URL automatically.

## HTTP MCP and automation

For HTTP, retain the operator's explicit feature permissions and forward the second callback argument:

```js
import { evaluateWithProvider } from 'jevlang';
import { startServer } from 'jevlang/serve';

await startServer(policy, {
  experimental: { images: true },
  maxBody: 32 * 1024 * 1024,
  evaluate: (input, options) => evaluateWithProvider(policy, input, options),
});
```

POST `/evaluate` accepts `{ state, assets, experimental }`; `/dispatch` accepts assets alongside its existing input. Clients can disable an allowed feature but cannot enable a disabled one or inject upstream credentials/headers. The default body cap remains 1 MiB, so larger workloads require an explicit operator setting. Existing authentication and dispatch rules still apply.

`policyMcpServer` takes the same `experimental` permissions and two-argument evaluate callback. It advertises JSON asset data, not binary upload support. Generic pipelines, sessions and webhook wiring continue using evaluate callbacks; bind image maps in those callbacks or declare static policy assets. Text-only fallback adapters remain ineligible for image/Box requests.

## Usage and cost

Nullable token counts remain unknown. Batch and pipeline reports expose `usage_complete` and `unreported_calls` alongside known-token subtotals. Batch cost is null when input usage is incomplete. A measured zero stays zero. Image cost estimates expose `image_tokens: null` and `text_tokens`; total token/cost estimates are null until actual usage is available. Real image tokens are billed as input tokens at the same rate as text. [Image token accounting](https://docs.typesafe.ai/images#image-tokens)
