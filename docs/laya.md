# Laya provider: self-hosted, open-weights decisions

[Laya](https://huggingface.co/convaiinnovations/laya) (Apache 2.0, 421M) answers
exactly the three question kinds this engine asks — `choice`, `score`, `noul` —
from `(state, questions)` in one forward pass, with calibrated probabilities.
Its SDK is Python-only (`pip install laya`), so the adapter is a subprocess
provider like the CLI adapters, not an HTTP client like TypeSafe.

## What "drop-in" means here

- A built-in provider `laya` in the default registry, so
  `evaluateWithProvider(policy, input, { provider: 'laya' })`, provider config
  (`provider: 'laya'`), routing routes, and `preferences` all select it with no
  other setup than `pip install laya`.
- The `model` field selects the checkpoint:
  `null`/`router` → `laya.Router(preload=True)` (auto script/language routing),
  `english` → `laya.load("convaiinnovations/laya")`,
  `multilingual` / `typed-decisions` → the bundled subfolders.
- Cost is reported as `{ mode: 'self-hosted', usd: 0 }`; usage stays empty.

## The bridge

`src/provider/providers/laya.js` embeds a small Python program and runs it as
`<python> -c <bridge>` with one JSON request on stdin and one JSON result on
stdout:

- Request: `{ protocol: 'laya-bridge/1', state, questions, model }` — the same
  wire questions the engine builds, with two adaptations the bridge does:
  `instructions` may be an object (per-item families); it is flattened to one
  string (`question` first, then the other keys). `criteria` passes through
  untouched (choice's option map and score's level list already match Laya's
  shapes). A question whose type is not `choice`/`score`/`noul` (e.g. `raw`) is
  a configuration error, named plainly.
- Result: `{ output, model, usage }` where `output` is Laya's answer map with
  each answer's `type` re-attached from its question (Laya omits it; the
  validator wants it), and `model` is the checkpoint that answered (`router`
  reports the routed checkpoint from `result.routing.model`).
- Failure: `{ error: { kind, message, retryable } }` and a nonzero exit.
  `import laya` failing maps to `configuration` (not retryable); a runtime
  failure maps to `provider-failure` (retryable); the subprocess timeout maps
  to `timeout`.

`USE_TF=0` is always set (the model card: transformers' TensorFlow probe can
deadlock model construction). The child sees only `HOME`, `PATH`,
`PYTHONPATH`, the Hugging Face cache/offline variables, and whatever
`providers.laya.environment` allows.

## Configuration

`providers.laya` in any provider config layer:

- `command` (default `python3`; may be a list, e.g. `[".venv/bin/python"]`)
- `max_parallel` (default 1; a checkpoint is one process-local model)
- `timeout_seconds` (default 600; a first run downloads ~800 MB of weights)
- `environment` (extra env names to pass through)

## Verification

`test/laya.test.js` runs the real bridge under the real `python3` with a stub
`laya` package on `PYTHONPATH` (no network, no weights): the adapted questions
the stub receives, the answer normalization, end-to-end evaluation through
`evaluateWithProvider` with provenance, checkpoint selection via `model`, and
the error classifications. A fake-executable path covers machines without
python3, and discovery says `missing` when the interpreter is absent.
