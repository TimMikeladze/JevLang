// The Laya adapter: open-weights, self-hosted answers to the same three
// question kinds the engine asks. Laya's SDK is Python-only, so this provider
// runs an embedded bridge program under the configured interpreter: one JSON
// request on stdin, one JSON result on stdout — the same shape of contract the
// custom executables speak, but built in, with the question wire format adapted
// (flattened instructions, criteria passed through) and the answers normalized
// (each answer's `type` re-attached from its question).
//
// The model card asks for USE_TF=0 (transformers' TensorFlow probe can
// deadlock model construction); it is set on every run.
import { object, own, requireAt } from '../../common.js';
import { ProviderError, availability, provider, unreportedCost, capabilities } from '../core.js';
import { findExecutable, allowedEnvironment } from '../command.js';
import { runProgram } from '../process.js';

// Environment the bridge always sees: enough for Python and the Hugging Face
// cache, and nothing that could steer the engine itself.
const bridgeEnvironment = ['PATH', 'HOME', 'PYTHONPATH', 'HF_HOME', 'HF_HUB_CACHE', 'HF_HUB_OFFLINE', 'TRANSFORMERS_OFFLINE', 'HF_HUB_DISABLE_TELEMETRY'];

const BRIDGE = [
  'import json, sys',
  '',
  'def fail(kind, message, retryable=False):',
  '    print(json.dumps({"error": {"kind": kind, "message": message, "retryable": retryable}}))',
  '    sys.exit(1)',
  '',
  'try:',
  '    request = json.load(sys.stdin)',
  'except Exception as error:',
  '    fail("invalid-output", "the bridge request is not JSON: %s" % error)',
  '',
  'state = request.get("state")',
  'questions = request.get("questions") or {}',
  'model = request.get("model")',
  '',
  'def instructions_text(value):',
  '    if isinstance(value, str):',
  '        return value',
  '    if isinstance(value, dict):',
  '        parts = []',
  '        if "question" in value:',
  '            parts.append(value["question"])',
  '        for key, item in value.items():',
  '            if key == "question":',
  '                continue',
  '            parts.append("%s: %s" % (key, item if isinstance(item, str) else json.dumps(item)))',
  '        return " ".join(part for part in parts if part)',
  '    return json.dumps(value)',
  '',
  'adapted = {}',
  'for name, question in questions.items():',
  '    kind = question.get("type")',
  '    if kind not in ("choice", "score", "noul"):',
  '        fail("configuration", "question \'%s\' has type \'%s\'; laya answers choice, score and noul questions only" % (name, kind))',
  '    adapted[name] = {"type": kind, "instructions": instructions_text(question.get("instructions", name))}',
  '    if "criteria" in question:',
  '        adapted[name]["criteria"] = question["criteria"]',
  '',
  'try:',
  '    import laya',
  'except Exception as error:',
  '    fail("configuration", "the laya package is not usable here: pip install laya (%s)" % error)',
  '',
  'try:',
  '    if model in (None, "", "router", "laya-latest"):',
  '        agent = laya.Router(preload=True)',
  '        result = agent.predict(state, adapted)',
  '        answers = result["answers"]',
  '        used = (result.get("routing") or {}).get("model") or "router"',
  '    elif model == "english":',
  '        answers = laya.load("convaiinnovations/laya").predict(state, adapted)["answers"]',
  '        used = "english"',
  '    else:',
  '        answers = laya.load("convaiinnovations/laya", subfolder=model).predict(state, adapted)["answers"]',
  '        used = model',
  'except Exception as error:',
  '    fail("provider-failure", "%s: %s" % (type(error).__name__, error), retryable=True)',
  '',
  'normalized = {}',
  'for name, question in adapted.items():',
  '    answer = answers.get(name) if isinstance(answers, dict) else None',
  '    if not isinstance(answer, dict):',
  '        fail("invalid-output", "laya returned no answer for question \'%s\'" % name)',
  '    normalized[name] = dict(answer, type=question["type"])',
  '',
  'print(json.dumps({"output": normalized, "model": used, "usage": {}, "cost": {"mode": "self-hosted", "usd": 0.0}}))',
].join('\n');

const parseJson = text => { try { return JSON.parse(text); } catch { return null; } };
const retryableKinds = ['unavailable', 'authentication', 'timeout', 'rate-limit', 'overload', 'invalid-output', 'provider-failure'];

export function layaProvider({ command = 'python3', maxParallel = 1, timeoutSeconds = 600, environment = [] } = {}) {
  const parts = typeof command === 'string' ? [command] : command;
  if (!Array.isArray(parts) || parts.length === 0 || !parts.every(x => typeof x === 'string')) {
    throw new TypeError('a command is an executable name or a non-empty list of strings');
  }
  const [executable, ...args] = parts;
  return provider({
    id: 'laya',
    caps: capabilities({ modes: ['structured'], modalities: ['text'], permissions: ['read'], controls: ['structured-output'], efforts: [], maxParallel }),
    discover: async () => {
      const path = findExecutable(executable);
      return path
        ? availability('ready', { billing: 'free', detail: `${path} runs the laya bridge; the checkpoint weights are downloaded on first use` })
        : availability('missing', { detail: `${executable} is not on PATH` });
    },
    run: async (request, target) => {
      const state = request.metadata.state;
      const questions = request.metadata.questions;
      requireAt(object(questions), 'metadata.questions', 'Laya policy requests require a question map', 'missing questions metadata', 'configuration');
      const timeout = own(request.limits, 'timeout_seconds') ? request.limits.timeout_seconds : timeoutSeconds;
      // Resolved before spawning, as the custom executables resolve it, so a
      // restricted environment cannot change which interpreter runs.
      const resolved = findExecutable(executable) ?? executable;
      const { status, stdout, stderr } = await runProgram(resolved, [...args, '-c', BRIDGE], {
        stdin: JSON.stringify({ protocol: 'laya-bridge/1', state, questions, model: target.model ?? null }),
        timeoutSeconds: timeout,
        env: { ...allowedEnvironment([...bridgeEnvironment, ...environment]), USE_TF: '0' },
      });
      if (status === null) {
        throw new ProviderError('provider laya timed out', {
          kind: 'timeout', target, retryable: true, mutated: false,
          usage: {}, cost: unreportedCost(), status: null, detail: stderr.trim(),
        });
      }
      const response = parseJson(stdout);
      if (status !== 0) {
        const error = object(response?.error) ? response.error : null;
        const kind = typeof error?.kind === 'string' ? error.kind : 'provider-failure';
        const message = typeof error?.message === 'string' && error.message.trim() !== ''
          ? `provider laya failed: ${error.message}`
          : stderr.trim() !== '' ? `provider laya failed: ${stderr.trim().split('\n').pop()}` : 'provider laya failed';
        throw new ProviderError(message, {
          kind, target,
          retryable: error && own(error, 'retryable') ? Boolean(error.retryable) : retryableKinds.includes(kind),
          mutated: false, usage: {}, cost: unreportedCost(), status,
          detail: stderr.trim() !== '' ? stderr.trim() : message,
        });
      }
      if (!response || !own(response, 'output')) {
        throw new ProviderError('provider laya returned invalid structured output', {
          kind: 'invalid-output', target, retryable: true, mutated: false,
          usage: {}, cost: unreportedCost(), status, detail: stdout.slice(0, 500),
        });
      }
      return {
        output: response.output,
        target: target.model ? target : { ...target, model: typeof response.model === 'string' ? response.model : null },
        model: typeof response.model === 'string' ? response.model : target.model ?? null,
        usage: object(response.usage) ? response.usage : {},
        cost: { mode: 'self-hosted', usd: 0 },
        requestId: null,
        exitStatus: status,
        changed: [],
        attempts: [],
      };
    },
  });
}
