# Jev current API research

Verified 2026-10-17 against TypeSafe-owned documentation. This note records upstream facts and repository gaps; proposed implementation belongs in the companion specification. No authenticated model request was made.

## Release and upgrade target

| Item | Latest documented version | Meaning for JevLang |
| --- | --- | --- |
| Jev model | `jev-1.14.0`, released 2026-10-14 | Explicit target for the newest release |
| Stable alias | `jev-latest` → `jev-1.13.0` | Currently excludes Box |
| Preview alias | `jev-preview` → `jev-1.14.0` | Moving newest-release target |
| JavaScript SDK | `@typesafe-ai/sdk` 0.7.0 | Requires Node ≥22; not installed here |
| Python SDK | `typesafe-sdk` 0.7.5 | Not installed by JevLang's native Python engine |

Model and alias facts: [Models](https://docs.typesafe.ai/models). SDK versions: [JavaScript changelog](https://docs.typesafe.ai/sdk/javascript/changelog), [Python changelog](https://docs.typesafe.ai/sdk/python/changelog).

The root package has no runtime dependencies. `src/client.js` implements HTTP directly. This update changes its fallback from `jev-latest` to `jev-1.14.0`, preserving explicit configuration/environment overrides. “Update Jev” therefore means selecting a newer hosted model and updating compatibility; there is no Jev dependency to bump. Record the returned version when migrating thresholds.

## New model access and context

All models use `POST /v1/systemone`. `GET /v1/models` returns available names, descriptions, and release dates; it currently lists aliases, so absence of a versioned ID does not mean that ID is invalid. Default request/question limits are 64k/32k tokens. The header `TypeSafe-Danger-Zone-Long-Context: true` raises both to 262k on 1.13 and 1.14. Long context retains input pricing but can reduce speed and accuracy. Limits are organization-specific, visible in the console; do not hard-code old global throughput claims. [Models](https://docs.typesafe.ai/models)

## Images and assets

Images and Box require `TypeSafe-Danger-Zone-Images: true`; both remain experimental. Images work on 1.13 and 1.14. Asset references substitute in state, instructions, and criteria string values, including within sentences; object keys stay text. Each occurrence expands independently. [Images](https://docs.typesafe.ai/images)

The wire request adds `assets: { reference: { type?: "image", format: "png" | "jpg" | "jpeg", data_base64: "..." } }`. Base64 uses standard padding without whitespace or data-URL prefix. Multipart uses a first `request` JSON part and image file parts named by `assets[reference].part`; `part` takes precedence over base64. Every asset must be used. [Images](https://docs.typesafe.ai/images)

| Image constraint | Current documented limit |
| --- | --- |
| Formats | Still PNG/JPEG |
| File | 16 MiB decoded |
| Each dimension | 280–1568 px |
| Pixels | 78,400–2,458,624 |
| Body / processed distinct images / expanded request | Separate 32 MiB limits |
| Reference / combined references | 1,024 / 65,536 UTF-8 bytes |

References should be collision-resistant. Invalid images reject the entire request. EXIF orientation is not applied. Image tokens enter input usage; no estimation formula is published. [Images](https://docs.typesafe.ai/images)

The JS SDK provides `image`, `Image.fromBase64`, `withAssets`, `withAssets.join`, and named assets; Python provides `Image` from bytes/paths/base64/Pillow and `attach_assets`. JS also adds nullable usage token counts. [JavaScript changelog](https://docs.typesafe.ai/sdk/javascript/changelog), [Python changelog](https://docs.typesafe.ai/sdk/python/changelog)

The Python asset helper loads once on first use and can reuse bytes across requests. Its base64 helper accepts whitespace, which is stricter on the raw HTTP wire. [Python assets](https://docs.typesafe.ai/sdk/python/api/types/assets)

## Box primitive

Box requires 1.14 (`jev-preview` or `jev-1.14.0`) and an image. It takes no criteria:

```json
{ "type": "box", "instructions": "the mug in `photo`" }
```

Answer:

```json
{ "type": "box", "box": { "top": 0.25, "bottom": 0.82, "left": 0.44, "right": 0.84 }, "confidence": 0.92 }
```

Edges are normalized to image size, finite in [0,1], ordered left < right and top < bottom. One question returns one box. There is no absent/null result: even an absent target produces a box, so pair with a presence Noul and gate use of coordinates. Confidence has no recommended universal threshold. [Box](https://docs.typesafe.ai/primitives/box)

## HTTP compatibility

Bearer authentication, JSON state/model/questions, same-key answers, and model/usage response remain. Body limit is 32 MiB; UTF-8 without BOM, depth ≤64, finite numbers. Choice allows ≤255 options; Score uses 2–10 ordered criteria. Compression accepts gzip/x-gzip or zstd, one layer; zstd window ≤8 MiB and size limits apply before/after decompression. Relevant errors: 400 invalid body/context, 413 size, 415 encoding, 422 schema, 429 rate, 529 overload. Retrying 429/529 uses backoff. [HTTP API](https://docs.typesafe.ai/api)

Latest SDKs compress bodies ≥1 KiB with zstd; JS automatic compression requires Node ≥22.15 and can be disabled. [JavaScript changelog](https://docs.typesafe.ai/sdk/javascript/changelog)

Structured instructions and criteria are already upstream behavior, not uniquely 1.14 features. They include string/object/array/null; Score levels and Noul outcomes may be structured. [Advanced structure](https://docs.typesafe.ai/primitives/advanced)

## Repository support audit

| Surface | Current implementation | Gap |
| --- | --- | --- |
| Model selection | `src/client.js`, arbitrary strings and environment override | Newest-release default/catalog guidance; no models-list API |
| Questions | `src/validate.js`, `src/index.js`, `src/index.d.ts` | No first-class Box; raw question escape exists |
| Answers and expressions | `src/engine.js`, `src/expressions.js`, `src/evaluate.js` | No typed coordinates, schema, or Box confidence handling |
| Assets and headers | `src/client.js` JSON-only; `settings.extraBody` | Assets may be manually injected, but required opt-in headers and multipart unsupported |
| Provider selection | `src/evaluate.js`: TypeSafe text modality | Images must reach provider requests and capability resolution |
| Validation and state | Existing structured JSON support | Image references/bytes, depth/body limits, redaction, cost and token accounting need design |
| Replay, fixtures, cache, monitoring | JSON values and canonical fingerprints | Content-based image identity and reference-independent cache keys |
| Python parity | Sibling `../jev-lang/packages/jevlang-python/jevlang/_evaluate.py`, native urllib HTTP, no SDK dependency | Same feature work; separate checkout/release coordination |

Repo audit describes source inspection, not upstream guarantees. The sibling Python package is outside this checkout; do not imply it was upgraded here.

## Documentation inconsistencies to preserve as explicit decisions

The model table still labels input “Text” despite the dedicated Images page enabling images for both versions. The main HTTP page omits Box/assets/multipart; use their dedicated pages plus SDK changelogs as the newer contract. Advanced structure admits null where some HTTP field tables omit it. The canonical documentation index is [llms.txt](https://docs.typesafe.ai/llms.txt), not third-party guides whose 1.13-only content is now stale.

Box's prose says confidence is numeric, but the [Python response schema](https://docs.typesafe.ai/sdk/python/api/types/responses) explicitly requires `confidence` with a number-or-null value. Accept `null` as unavailable in the portable representation and fail closed when a numeric gate/accessor needs it; do not coerce it to certainty or derive it from coordinates. Choice/Score confidence remains numeric and Noul has none. The [confidence page](https://docs.typesafe.ai/confidence) supplies exact Choice/Score formulas, but no Box confidence formula.

SDK environment references list `TYPESAFE_API_KEY`, `TYPESAFE_BASE_URL`, `TYPESAFE_DEFAULT_MODEL`, and `TYPESAFE_LOG_LEVEL`; no compression environment variable is documented. [JavaScript ENV](https://docs.typesafe.ai/sdk/javascript/api/variables/ENV), [Python constants](https://docs.typesafe.ai/sdk/python/api/constants)

Do not infer streaming, native bulk jobs, video/audio input, image token formulas, Box not-found semantics, or provider-channel image parity: these are not documented new capabilities.
