// Requests that depend on earlier answers.
//
// Some decisions take more than one call: shortlist the likely skills, then ask
// again with only those as options; pick a department, then ask that
// department's questions. Each call is a stage, and a stage hands off by
// deciding next('stage').
//
// The run stops at the first decision that is not a next. It refuses to loop:
// reaching a stage twice is an error, and so is needing more than maxRequests
// stages, since each stage is one billed call.
import { requireAt, object, finite } from './common.js';
import { settings as client } from './client-usage.js';

// The input a stage gets when its entry has no builder: the previous input with
// the previous decision under `previous`. A non-object input is wrapped.
export const defaultNextInput = (previous, decision) =>
  object(previous) ? { ...previous, previous: decision } : { input: previous, previous: decision };

const stageParts = (stages, name) => {
  const entry = stages[name];
  const pair = Array.isArray(entry);
  const evaluate = pair ? entry[0] : entry;
  const build = pair ? entry[1] ?? defaultNextInput : defaultNextInput;
  requireAt(typeof evaluate === 'function', `stages.${name}`, 'a stage is an evaluate function, or [evaluate, builder]');
  requireAt(typeof build === 'function', `stages.${name}`, 'a stage builder takes (previousInput, decision)');
  return { evaluate, build };
};
const addUsage = (acc, usage) => ({
  input_tokens: acc.input_tokens + (finite(usage?.input_tokens) ? usage.input_tokens : 0),
  output_tokens: acc.output_tokens + (finite(usage?.output_tokens) ? usage.output_tokens : 0),
});

export async function runPipeline(stages, input, { start, maxRequests = 4 } = {}) {
  requireAt(object(stages) && Object.keys(stages).length > 0, 'stages', 'a pipeline is a map of stage name to evaluate');
  requireAt(Number.isInteger(maxRequests) && maxRequests > 0, 'maxRequests', 'maxRequests must be a positive integer');
  const known = Object.keys(stages).sort();
  const checkStage = (name, from) => requireAt(Object.hasOwn(stages, name), 'stages',
    `${from} names stage '${name}', which the pipeline does not have`, `Stages: ${known.join(' -> ')}.`);
  checkStage(start, 'start');
  let stage = start, current = input, steps = [], usage = { input_tokens: 0, output_tokens: 0 };
  for (;;) {
    const path = steps.map(([name]) => name);
    requireAt(steps.length < maxRequests, 'pipeline',
      `the pipeline ran ${steps.length} stages without a final decision: ${[...path, stage].join(' -> ')}`,
      `Each stage is one request, and maxRequests is ${maxRequests}; raise it if this path is expected.`);
    const { evaluate } = stageParts(stages, stage);
    // Every call the stage makes reports here, and still reaches any outer sink,
    // so a batch counting tokens still sees them.
    const outer = client.onUsage;
    let spent = usage;
    client.onUsage = u => { spent = addUsage(spent, u); outer?.(u); };
    let decision;
    try { decision = await evaluate(current); } finally { client.onUsage = outer; }
    requireAt(object(decision) && typeof decision.action === 'string', 'pipeline', `stage '${stage}' did not return a decision`);
    const staged = { ...decision, stage };
    steps = [...steps, [stage, staged]];
    usage = spent;
    if (staged.action !== 'next') return { decision: staged, steps, usage };
    const to = staged.target;
    checkStage(to, `stage '${stage}'`);
    requireAt(to !== stage && !path.includes(to), 'pipeline',
      `the pipeline reached stage '${to}' twice: ${[...path, stage, to].join(' -> ')}`,
      'Stages form a chain without loops; to ask the same questions again, name a separate stage.');
    const next = stageParts(stages, to);
    current = next.build(current, staged);
    stage = to;
  }
}
export const pipelineToJson = result => ({
  decision: result.decision,
  steps: result.steps.map(([stage, decision]) => ({ stage, decision })),
  usage: result.usage,
});

// The k most probable options of a choice answer, most probable first, as the
// keys sent on the wire, ready to put in the next stage's state. Ties go to the
// key that sorts first, so the result is stable.
export function topOptions(answer, k) {
  requireAt(Number.isInteger(k) && k >= 0, 'k', 'topOptions takes a count of at least 0');
  requireAt(object(answer) && object(answer.probabilities), 'answer', 'topOptions needs a choice answer with probabilities', undefined, 'response');
  return Object.entries(answer.probabilities)
    .sort(([ka, va], [kb, vb]) => vb - va || (ka < kb ? -1 : ka > kb ? 1 : 0))
    .slice(0, k)
    .map(([key]) => key);
}
