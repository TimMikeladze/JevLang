import { jsonCopy, freeze, requireAt, own, object, text, probability, finite, keysOnly } from './common.js';
import { checkExpression, literal, optionWire } from './expressions.js';
import { redactorNames } from './state.js';

const mapAt = (x, path) => requireAt(object(x), path, 'expected a map');
const listAt = (x, path) => requireAt(Array.isArray(x), path, 'expected an array');
const nonempty = (x, path) => requireAt(text(x), path, 'expected a non-empty string');
const reserved = new Set(['hold', 'confirm', 'computed']);

export function validatePolicy(input) {
  const p = jsonCopy(input);
  keysOnly(p, ['format', 'name', 'version', 'owner', 'questions', 'state', 'stateOptions', 'thresholds', 'profiles', 'signals', 'gates', 'route', 'prechecks', 'flags', 'actions', 'provider', 'model', 'effort', 'extraBody'], '$');
  requireAt(p.format === 1, '$.format', `unsupported policy format '${p.format}'`, 'Migrate to portable policy format 1.');
  nonempty(p.name, '$.name');
  for (const key of ['questions', 'state', 'thresholds', 'profiles', 'signals', 'actions']) {
    p[key] ??= {}; mapAt(p[key], `$.${key}`);
  }
  for (const key of ['gates', 'prechecks', 'flags']) { p[key] ??= []; listAt(p[key], `$.${key}`); }
  for (const key of ['version', 'owner', 'provider', 'model', 'effort']) if (own(p, key)) nonempty(p[key], `$.${key}`);
  const warnings = [];
  p.stateOptions ??= {};
  keysOnly(p.stateOptions, ['redact', 'maxChars', 'tokenLimit'], '$.stateOptions');
  if (own(p.stateOptions, 'redact')) requireAt(Array.isArray(p.stateOptions.redact) && p.stateOptions.redact.every(x => redactorNames.includes(x)), '$.stateOptions.redact', 'unknown redactor');
  for (const k of ['maxChars', 'tokenLimit']) if (own(p.stateOptions, k)) requireAt(p.stateOptions[k] === null || Number.isInteger(p.stateOptions[k]) && p.stateOptions[k] > 0, `$.stateOptions.${k}`, 'limit must be a positive integer or null');
  for (const [id, s] of Object.entries(p.state)) {
    nonempty(id, '$.state');
    keysOnly(s, ['path', 'default', 'local', 'maxChars', 'redact', 'unredacted'], `$.state.${id}`);
    if (own(s, 'path')) requireAt(Array.isArray(s.path) && s.path.every(k => typeof k === 'string' || Number.isInteger(k)), `$.state.${id}.path`, 'path must be an array of field names or indexes');
    if (own(s, 'local')) requireAt(typeof s.local === 'boolean', `$.state.${id}.local`, 'local must be boolean');
    if (own(s, 'maxChars')) requireAt(Number.isInteger(s.maxChars) && s.maxChars > 0 && !s.local, `$.state.${id}.maxChars`, 'maxChars must be a positive integer on a non-local field');
    if (own(s, 'unredacted')) requireAt(text(s.unredacted) && !s.local, `$.state.${id}.unredacted`, 'unredacted requires an audit reason on a non-local field');
    if (own(s, 'redact')) requireAt(Array.isArray(s.redact) && s.redact.every(x => redactorNames.includes(x)), `$.state.${id}.redact`, 'unknown redactor');
  }
  requireAt(!Object.keys(p.state).length || Object.values(p.state).some(s => !s.local), '$.state', 'all fields are local; no model state remains', 'Declare at least one non-local field.');
  if (own(p, 'extraBody')) {
    mapAt(p.extraBody, '$.extraBody');
    const keys = Object.keys(p.extraBody);
    requireAt(keys.length > 0, '$.extraBody', 'an extra request body needs at least one field');
    for (const k of keys) requireAt(!['state', 'model', 'questions'].includes(k), `$.extraBody.${k}`, `extraBody cannot set '${k}'`, 'Set the model and state through the policy, not the raw body.');
    warnings.push({ path: '$.extraBody', message: `extraBody adds request fields the API docs do not describe: ${keys.join(', ')}` });
  }
  for (const [id, q] of Object.entries(p.questions)) {
    nonempty(id, '$.questions');
    requireAt(['choice', 'score', 'noul', 'noul-each', 'score-each', 'raw'].includes(q.type), `$.questions.${id}.type`, 'unknown question type');
    if (q.type === 'raw') {
      // A raw question is sent exactly as written and nothing about it is checked.
      keysOnly(q, ['type', 'wire'], `$.questions.${id}`);
      requireAt(object(q.wire) && text(q.wire.type), `$.questions.${id}.wire`, 'a raw question is a JSON object with a non-empty string "type"', 'Write {type: "noul", instructions: "..."} as the wire question.');
      warnings.push({ path: `$.questions.${id}`, message: `raw question '${id}' bypasses every check; its answer is only readable with rawAnswer('${id}')` });
      continue;
    }
    keysOnly(q, ['type', 'instructions', 'criteria', 'ungated', 'optionsFrom', 'over', 'itemKey', 'names', 'levelNames'], `$.questions.${id}`);
    requireAt(own(q, 'instructions') && (q.instructions === null || object(q.instructions) || Array.isArray(q.instructions) || text(q.instructions)), `$.questions.${id}.instructions`, 'instructions must be non-empty text, JSON object, array or null');
    if (own(q, 'ungated')) nonempty(q.ungated, `$.questions.${id}.ungated`);
    if (q.type === 'choice') {
      mapAt(q.criteria, `$.questions.${id}.criteria`);
      const n = Object.keys(q.criteria).length;
      Object.keys(q.criteria).forEach(k => nonempty(k, `$.questions.${id}.criteria`));
      requireAt(n <= 255 && (n >= 2 || q.optionsFrom), `$.questions.${id}.criteria`, 'choice requires 2 to 255 options', 'Declare at least two options, or supply runtime options.');
      if (n > 240) warnings.push({ path: `$.questions.${id}.criteria`, message: `choice '${id}' has ${n} options; the docs report reliable behavior up to roughly 240` });
    } else if (q.type.startsWith('score')) {
      requireAt(Array.isArray(q.criteria) && q.criteria.length >= 2 && q.criteria.length <= 10, `$.questions.${id}.criteria`, 'score requires 2 to 10 ordered levels');
      requireAt(new Set(q.criteria.map(x => JSON.stringify(x))).size === q.criteria.length, `$.questions.${id}.criteria`, 'duplicate score levels');
    } else if (own(q, 'criteria')) keysOnly(q.criteria, ['true', 'false'], `$.questions.${id}.criteria`);
    if (own(q, 'names')) {
      // A code name is how the policy refers to an option; the key is what it sends.
      const path = `$.questions.${id}.names`;
      mapAt(q.names, path);
      requireAt(q.type === 'choice', path, 'only a choice has option code names');
      const wires = Object.values(q.names);
      requireAt(new Set(wires).size === wires.length, path, 'two code names send the same wire key');
      for (const [name, wire] of Object.entries(q.names)) {
        nonempty(name, path);
        requireAt(typeof wire === 'string' && own(q.criteria, wire), `${path}.${name}`, `code name '${name}' names no declared option`, `Declare the option, or use one of: ${Object.keys(q.criteria).join(', ')}.`);
        requireAt(name === wire || !own(q.criteria, name), `${path}.${name}`, `code name '${name}' is also another option's wire key`, 'Rename the option so a reference means one thing.');
      }
    }
    if (own(q, 'levelNames')) {
      const path = `$.questions.${id}.levelNames`;
      requireAt(q.type.startsWith('score') && Array.isArray(q.levelNames) && q.levelNames.length === q.criteria.length, path, 'levelNames declares one name or null per score level');
      const named = q.levelNames.filter(x => x !== null);
      named.forEach(x => nonempty(x, path));
      requireAt(new Set(named).size === named.length, path, 'duplicate level name');
      for (const [i, name] of q.levelNames.entries()) {
        const clash = q.criteria.findIndex(x => x === name);
        requireAt(name === null || clash < 0 || clash === i, `${path}[${i}]`, `level name '${name}' is also another level's text`, 'Rename the level so a reference means one thing.');
      }
    }
    for (const key of ['optionsFrom', 'over']) if (own(q, key)) {
      requireAt(typeof q[key] === 'string' && own(p.state, q[key]) && !p.state[q[key]].local, `$.questions.${id}.${key}`, 'runtime questions need a declared non-local state field');
      requireAt(key === 'over' ? q.type.endsWith('-each') : q.type === 'choice', `$.questions.${id}.${key}`, 'field is not supported on this question type');
    }
    requireAt(!q.type.endsWith('-each') || own(q, 'over'), `$.questions.${id}.over`, 'family needs its inventory field');
    if (own(q, 'itemKey')) requireAt(q.type.endsWith('-each') && text(q.itemKey), `$.questions.${id}.itemKey`, 'itemKey is a non-empty name for a family item');
    checkPaths(q.instructions, p, `$.questions.${id}.instructions`, object(q.instructions) ? Object.keys(q.instructions) : []);
  }
  for (const [name, value] of Object.entries(p.thresholds)) requireAt(text(name) && probability(value), `$.thresholds.${name}`, 'threshold must be between 0 and 1');
  for (const [name, x] of Object.entries(p.signals)) checkExpression(x, p, `$.signals.${name}`, { stack: [name] });
  for (const [name, action] of Object.entries(p.actions)) checkActionSchema(name, action, p);
  const baseGates = new Set(), gateKeys = new Set();
  for (const [i, gate] of p.gates.entries()) {
    const path = `$.gates[${i}]`;
    keysOnly(gate, ['question', 'threshold', 'option', 'by', 'onRead', 'low', 'high', 'decision'], path);
    requireAt(own(p.questions, gate.question), `${path}.question`, `unknown question '${gate.question}'`);
    const q = p.questions[gate.question];
    if (own(gate, 'onRead')) requireAt(typeof gate.onRead === 'boolean', `${path}.onRead`, 'onRead must be boolean');
    const band = own(gate, 'low') || own(gate, 'high');
    const key = band ? `${gate.question}/band` : `${gate.question}${own(gate, 'option') ? `/${gate.option}` : ''}`;
    requireAt(!gateKeys.has(key), path, `duplicate gate '${key}'`); gateKeys.add(key);
    if (band) {
      requireAt(q.type === 'noul' && probability(gate.low) && probability(gate.high) && gate.low < gate.high, path, 'review band needs a noul and 0 <= low < high <= 1');
      requireAt(!own(gate, 'threshold') && !own(gate, 'option') && !own(gate, 'by'), path, 'band cannot also have a threshold, option or metric');
    } else {
      requireAt(['choice', 'score'].includes(q.type), path, 'confidence gates require choice or score', 'Use a review band for noul.');
      requireAt(probability(gate.threshold), `${path}.threshold`, 'gate threshold must be between 0 and 1');
      requireAt(!own(gate, 'by') || ['confidence', 'topProb', 'margin'].includes(gate.by), `${path}.by`, 'unknown gate metric');
      if (own(gate, 'option')) requireAt(q.type === 'choice' && own(q.criteria, gate.option), `${path}.option`, 'gate option must be a declared static choice option');
      else baseGates.add(gate.question);
    }
    checkDecision(gate.decision, p, `${path}.decision`);
  }
  for (const [i, gate] of p.gates.entries()) if (own(gate, 'option')) {
    const base = p.gates.find(g => g.question === gate.question && !own(g, 'option') && !own(g, 'low'));
    requireAt(!base || (base.by ?? 'confidence') !== (gate.by ?? 'confidence') || gate.threshold >= base.threshold, `$.gates[${i}]`, 'option gate is below its base gate', 'Make the option gate at least as strict as the base gate.');
  }
  const overrideKeys = new Set(Object.keys(p.thresholds));
  for (const g of p.gates) {
    if (own(g, 'low')) { overrideKeys.add(`${g.question}/lo`); overrideKeys.add(`${g.question}/hi`); }
    else overrideKeys.add(`${g.question}${own(g, 'option') ? `/${g.option}` : ''}`);
  }
  for (const [name, profile] of Object.entries(p.profiles)) {
    mapAt(profile, `$.profiles.${name}`);
    for (const [key, value] of Object.entries(profile)) requireAt(overrideKeys.has(key) && probability(value), `$.profiles.${name}.${key}`, 'override must name a threshold or gate and be between 0 and 1');
  }
  function gated(reads, path) {
    for (const id of reads.reads) {
      const q = p.questions[id];
      requireAt(!['choice', 'score'].includes(q.type) || q.ungated || baseGates.has(id) || reads.confidences.has(id), path,
        `'${id}' decides a clause without a confidence gate`, 'Add a base gate, read confidence in this clause, or declare an ungated audit reason.');
    }
  }
  keysOnly(p.route, ['mode', 'clauses', 'otherwise', 'precedence'], '$.route');
  p.route.mode ??= 'first';
  requireAt(['first', 'all', 'collect'].includes(p.route.mode), '$.route.mode', 'route mode must be first, all or collect');
  listAt(p.route.clauses, '$.route.clauses');
  requireAt(p.route.clauses.length > 0 || own(p.route, 'otherwise'), '$.route', 'route has no decisions');
  if (p.route.mode === 'collect') requireAt(Array.isArray(p.route.precedence) && p.route.precedence.length > 0 && p.route.precedence.every(text) && new Set(p.route.precedence).size === p.route.precedence.length, '$.route.precedence', 'collect requires a unique non-empty target precedence list');
  else requireAt(!own(p.route, 'precedence'), '$.route.precedence', 'precedence is only legal with collect');
  let unconditional = false;
  for (const [i, clause] of p.route.clauses.entries()) {
    const path = `$.route.clauses[${i}]`;
    keysOnly(clause, ['when', 'decision', 'source'], path);
    if (unconditional && p.route.mode === 'first') warnings.push({ path, message: 'unreachable clause after unconditional clause' });
    const refs = checkExpression(clause.when, p, `${path}.when`);
    const actionRefs = checkDecision(clause.decision, p, `${path}.decision`);
    actionRefs.reads.forEach(q => refs.reads.add(q)); actionRefs.confidences.forEach(q => refs.confidences.add(q));
    gated(refs, path);
    unconditional ||= clause.when.op === 'literal' && clause.when.args[0] === true;
  }
  if (own(p.route, 'otherwise')) gated(checkDecision(p.route.otherwise, p, '$.route.otherwise'), '$.route.otherwise');
  requireAt(own(p.route, 'otherwise') || unconditional || exhaustive(p), '$.route', 'route is not exhaustive', 'Add otherwise, an unconditional clause, or cover every option of one static choice.');
  for (const [i, clause] of p.prechecks.entries()) {
    const path = `$.prechecks[${i}]`; keysOnly(clause, ['when', 'decision', 'source'], path);
    checkExpression(clause.when, p, `${path}.when`, { noAnswers: true });
    checkDecision(clause.decision, p, `${path}.decision`, { noAnswers: true });
  }
  for (const [i, flag] of p.flags.entries()) {
    const path = `$.flags[${i}]`; keysOnly(flag, ['when', 'flag'], path);
    nonempty(flag.flag, `${path}.flag`); gated(checkExpression(flag.when, p, `${path}.when`), path);
  }
  return { policy: freeze(p), warnings: freeze(warnings), overrideKeys: freeze([...overrideKeys]) };
}

function checkPaths(v, p, path, localKeys) {
  if (typeof v === 'string') for (const match of v.matchAll(/`([^`]+)`/g)) {
    const root = match[1].split(/[.\[]/)[0];
    // A policy with no declared state accepts a raw state value, as #lang jev does.
    requireAt(!Object.keys(p.state).length || own(p.state, root) || localKeys.includes(root), path, `backtick path '${match[1]}' has no declared root`, 'Declare the state field or use a key from this question object.');
  }
  else if (Array.isArray(v)) v.forEach(x => checkPaths(x, p, path, localKeys));
  else if (object(v)) Object.values(v).forEach(x => checkPaths(x, p, path, localKeys));
}

function exhaustive(p) {
  const covered = new Map();
  function visit(x) {
    if (x.op === 'is') { const set = covered.get(x.args[0]) ?? new Set(); set.add(optionWire(p.questions[x.args[0]], x.args[1])); covered.set(x.args[0], set); }
    if (x.op === 'or') x.args.forEach(visit);
  }
  p.route.clauses.forEach(c => visit(c.when));
  return [...covered].some(([id, set]) => !p.questions[id].optionsFrom && Object.keys(p.questions[id].criteria).every(k => set.has(k)));
}

export function checkParameterType(t, p, path) {
  keysOnly(t, ['type', 'optional', 'min', 'max', 'values', 'of', 'field'], path);
  requireAt(['string', 'number', 'boolean', 'json', 'one-of', 'list-of', 'member-of'].includes(t.type), path, `unknown parameter type '${t.type}'`);
  if (own(t, 'optional')) requireAt(typeof t.optional === 'boolean', path, 'optional must be boolean');
  if (own(t, 'min') || own(t, 'max')) requireAt(t.type === 'number' && (!own(t, 'min') || finite(t.min)) && (!own(t, 'max') || finite(t.max)) && (t.min ?? -Infinity) <= (t.max ?? Infinity), path, 'range must be ordered finite numbers on a number parameter');
  if (t.type === 'one-of') requireAt(Array.isArray(t.values) && t.values.length > 0 && t.values.every(text) && new Set(t.values).size === t.values.length, path, 'one-of needs unique non-empty string values');
  if (t.type === 'list-of') checkParameterType(t.of, p, `${path}.of`);
  if (t.type === 'member-of') requireAt(typeof t.field === 'string' && own(p.state, t.field), path, 'member-of needs a declared fact field');
  for (const [key, kind] of [['values', 'one-of'], ['of', 'list-of'], ['field', 'member-of']]) requireAt(!own(t, key) || t.type === kind, path, `${key} is only legal on ${kind}`);
}
function checkActionSchema(name, a, p) {
  const path = `$.actions.${name}`; nonempty(name, path);
  requireAt(!reserved.has(name), path, 'reserved action name');
  keysOnly(a, ['params', 'doc', 'confirm', 'minConfidence', 'cooldown', 'allow', 'timeout', 'undo'], path);
  mapAt(a.params, `${path}.params`);
  for (const [k, t] of Object.entries(a.params)) { nonempty(k, `${path}.params`); checkParameterType(t, p, `${path}.params.${k}`); }
  if (own(a, 'confirm')) requireAt(typeof a.confirm === 'boolean', path, 'confirm must be boolean');
  if (own(a, 'minConfidence')) requireAt(probability(a.minConfidence), path, 'minConfidence must be between 0 and 1');
  for (const k of ['timeout', 'cooldown']) if (own(a, k)) requireAt(finite(a[k]) && a[k] > 0, `${path}.${k}`, `${k} must be positive seconds`);
  if (own(a, 'allow')) requireAt(Array.isArray(a.allow) && a.allow.length > 0 && a.allow.every(text), `${path}.allow`, 'allow needs a non-empty principal list');
  if (own(a, 'undo')) {
    requireAt(object(a.undo) && a.undo.action === 'act' && own(p.actions, a.undo.target), `${path}.undo`, 'undo must invoke a declared action');
    requireAt(!p.actions[a.undo.target].confirm, `${path}.undo`, 'undo cannot require confirmation');
    checkDecision(a.undo, p, `${path}.undo`, { variables: new Set(Object.keys(a.params)), undo: true });
  }
}

export function parameterOK(t, v, facts) {
  switch (t.type) {
    case 'string': return typeof v === 'string';
    case 'number': return finite(v) && v >= (t.min ?? -Infinity) && v <= (t.max ?? Infinity);
    case 'boolean': return typeof v === 'boolean';
    case 'json': return true;
    case 'one-of': return t.values.includes(v);
    case 'list-of': return Array.isArray(v) && v.every(x => parameterOK(t.of, x, facts));
    case 'member-of': return facts === undefined || (Array.isArray(facts?.[t.field]) && facts[t.field].some(x => itemIdentity(x) === itemIdentity(v)));
    default: return false;
  }
}
export const itemIdentity = v => String(object(v) ? (v.id ?? v.key ?? v.name ?? JSON.stringify(v)) : v);

export function checkDecision(d, p, path, options = {}) {
  requireAt(object(d), path, 'expected a decision');
  const shapes = {
    assign: ['target'], page: ['target'], escalate: ['target'], next: ['target'], hold: [],
    act: ['target', 'params'], confirm: ['proposed'], schedule: ['seconds', 'proposed'],
    clarify: ['question', 'about'], plan: ['steps'], planFor: ['variable', 'items', 'decision'],
    branch: ['when', 'then', 'otherwise'],
  };
  requireAt(own(shapes, d.action), path, `unknown decision '${d.action}'`);
  // hold parks the case for a person, so a target given to it is a mistake worth
  // naming.
  requireAt(d.action !== 'hold' || !own(d, 'target'), `${path}.target`, 'hold takes no target; it parks the case for a person to pick up',
    "For a named destination use assign('target') or escalate('target').");
  keysOnly(d, ['action', 'reason', 'data', 'show', ...shapes[d.action]], path);
  const refs = { reads: new Set(), confidences: new Set() };
  const merge = r => { r.reads.forEach(q => refs.reads.add(q)); r.confidences.forEach(q => refs.confidences.add(q)); };
  const expr = (x, at, informational = false) => {
    const r = checkExpression(x, p, at, options); if (!informational) merge(r);
  };
  if (own(d, 'reason')) expr(d.reason, `${path}.reason`, true);
  if (own(d, 'data')) expr(d.data, `${path}.data`, true);
  if (own(d, 'show')) {
    requireAt(Array.isArray(d.show) && d.show.every(q => own(p.questions, q)), `${path}.show`, 'evidence must name declared questions');
    requireAt(!options.noAnswers || !d.show.length, `${path}.show`, 'prechecks cannot show model answers');
  }
  if (shapes[d.action].includes('target')) { nonempty(d.target, `${path}.target`); requireAt(!reserved.has(d.target), `${path}.target`, 'reserved target name'); }
  switch (d.action) {
    case 'act': {
      requireAt(own(p.actions, d.target), `${path}.target`, `undeclared action '${d.target}'`, 'Declare the action and its parameters.');
      const a = p.actions[d.target];
      requireAt(!a.confirm || options.confirmed, path, `'${d.target}' requires confirmation`, 'Wrap it in confirm().');
      mapAt(d.params, `${path}.params`);
      for (const [k, x] of Object.entries(d.params)) {
        requireAt(own(a.params, k), `${path}.params.${k}`, `unknown parameter '${k}'`);
        expr(x, `${path}.params.${k}`);
        if (options.undo) requireAt(['literal', 'variable'].includes(x.op), `${path}.params.${k}`, 'undo may use only literals or this action\'s parameters');
        if (x.op === 'literal') requireAt(parameterOK(a.params[k], x.args[0]), `${path}.params.${k}`, `parameter must satisfy ${a.params[k].type}`, 'Use a value within the declared type and range.');
      }
      for (const [k, t] of Object.entries(a.params)) requireAt(t.optional || own(d.params, k), `${path}.params`, `missing required parameter '${k}'`);
      break;
    }
    case 'confirm': merge(checkDecision(d.proposed, p, `${path}.proposed`, { ...options, confirmed: true })); break;
    case 'schedule':
      expr(d.seconds, `${path}.seconds`);
      if (d.seconds.op === 'literal') requireAt(finite(d.seconds.args[0]) && d.seconds.args[0] > 0, `${path}.seconds`, 'schedule delay must be positive seconds');
      merge(checkDecision(d.proposed, p, `${path}.proposed`, options)); break;
    case 'clarify':
      expr(d.question, `${path}.question`);
      if (own(d, 'about')) requireAt(own(p.questions, d.about), `${path}.about`, 'clarify about must name a question');
      break;
    case 'plan': listAt(d.steps, `${path}.steps`); d.steps.forEach((x, i) => merge(checkDecision(x, p, `${path}.steps[${i}]`, options))); break;
    case 'planFor':
      nonempty(d.variable, `${path}.variable`); expr(d.items, `${path}.items`);
      merge(checkDecision(d.decision, p, `${path}.decision`, { ...options, variables: new Set([...(options.variables ?? []), d.variable]) })); break;
    case 'branch': expr(d.when, `${path}.when`); merge(checkDecision(d.then, p, `${path}.then`, options)); merge(checkDecision(d.otherwise, p, `${path}.otherwise`, options)); break;
  }
  return refs;
}
