// Diagrams: six components built from real elements (not scaled SVG), so their
// text stays real size at phone width and follows the theme tokens. Nothing a
// diagram shows is typed here — values, option names, clauses and gate bars are
// read out of a captured run or a README code block, and a reader that cannot
// find what it expects throws, so a stale diagram fails the build.
//
// Colour is meaning: green assign/allow, amber escalate/page/ask, red hold/deny,
// and the accent outline marks the one step that calls a model.

export const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const ACTIONS = new Set(['assign', 'allow', 'escalate', 'page', 'ask', 'hold', 'deny']);
export const isAction = (a) => ACTIONS.has(a);
export const tag = (action) => `<span class="tag tag--${isAction(action) ? action : 'model'}">${esc(action)}</span>`;

// ---------- reading source code ----------

const stripComments = (code) => code.replace(/^\s*\/\/.*$/gm, '');

// Index of the bracket that closes the one at `open`, skipping strings.
function closeOf(src, open) {
  const pairs = { '(': ')', '[': ']', '{': '}' };
  let depth = 0, quote = null;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue; }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (c in pairs) depth++;
    else if (')]}'.includes(c) && --depth === 0) return i;
  }
  throw new Error(`unbalanced ${src[open]} in source`);
}

// "a, f(b, c), 'd,e'" -> ['a', "f(b, c)", "'d,e'"]
function splitTop(src) {
  const parts = [];
  let depth = 0, quote = null, cur = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quote) { cur += c; if (c === '\\') cur += src[++i] ?? ''; else if (c === quote) quote = null; continue; }
    if (c === "'" || c === '"' || c === '`') { quote = c; cur += c; continue; }
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    if (c === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

const calls = (code, name) => {
  const out = [];
  const re = new RegExp(`(?<![\\w.])${name}\\(`, 'g');
  let m;
  while ((m = re.exec(code))) {
    const open = m.index + m[0].length - 1;
    out.push(splitTop(code.slice(open + 1, closeOf(code, open))));
  }
  return out;
};

const unquote = (s) => {
  const m = /^(['"`])([\s\S]*)\1$/.exec(s.trim());
  return m ? m[2].replace(/\\(['"`\\])/g, '$1') : s.trim();
};
const oneLine = (s) => s.replace(/\s+/g, ' ').trim();

// { action, target, reason } from `escalate('human-triage', { reason: '…' })`.
function readDecision(src) {
  const m = /^(\w+)\(\s*(['"`])((?:\\.|(?!\2).)*)\2/.exec(src.trim());
  if (!m) throw new Error(`cannot read decision: ${src}`);
  const reason = /reason:\s*(['"`])((?:\\.|(?!\1).)*)\1/.exec(src);
  return { action: m[1], target: m[3], reason: reason ? reason[2] : null };
}

// Questions, gates, clauses and `otherwise` of a policy file.
export function readPolicy(source) {
  const code = stripComments(source);
  const questions = [];
  for (const m of code.matchAll(/const (\w+) = (choice|score|noul)\(/g)) {
    const open = m.index + m[0].length - 1;
    const args = splitTop(code.slice(open + 1, closeOf(code, open)));
    const q = { variable: m[1], kind: m[2], id: unquote(args[0]), options: [], levels: [] };
    if (m[2] === 'choice' && args[2]?.startsWith('{')) q.options = splitTop(args[2].slice(1, -1)).map((e) => unquote(e.split(':')[0]));
    if (m[2] === 'score' && args[2]?.startsWith('[')) q.levels = splitTop(args[2].slice(1, -1)).map(unquote);
    questions.push(q);
  }
  const byVar = Object.fromEntries(questions.map((q) => [q.variable, q]));
  const gates = calls(code, 'gate').filter((a) => a.length >= 3 && byVar[a[0]]).map(([q, bar, decision]) => ({
    question: byVar[q].id, bar: Number(bar), ...readDecision(decision),
  }));
  const clauses = calls(code, 'rule').filter((a) => a.length >= 2).map(([when, decision]) => ({
    when: oneLine(when), gloss: gloss(oneLine(when), byVar), ...readDecision(decision),
  }));
  const otherwise = /otherwise:\s*(\w+\([^)]*\))/.exec(code);
  return { questions, byVar, gates, clauses, otherwise: otherwise ? readDecision(otherwise[1]) : null };
}

// A plain-English reading of a clause's condition, or null when it is not one
// of the shapes this understands.
function gloss(when, byVar) {
  const call = /^(\w+)\(([\s\S]*)\)$/.exec(when);
  if (call && (call[1] === 'all' || call[1] === 'any')) {
    const parts = splitTop(call[2]).map((p) => gloss(p, byVar));
    return parts.every(Boolean) ? parts.join(call[1] === 'all' ? ' and ' : ' or ') : null;
  }
  const m = /^(\w+)\.(yes|no|is|mostLikely)\(([\s\S]*)\)$/.exec(when);
  if (!m || !byVar[m[1]]) return null;
  const [, v, method, arg] = m;
  const id = byVar[v].id;
  if (method === 'yes') return `${id} is yes (${arg} or more)`;
  if (method === 'no') return `${id} is no (${arg} or more)`;
  return `${id} is “${unquote(arg)}”`;
}

// The answers one named case hands `decide`, per question id.
export function readAnswers(source, caseName, questions) {
  const at = source.indexOf(`'${caseName}': {`);
  if (at < 0) throw new Error(`no case '${caseName}' in the decide source`);
  const open = source.indexOf('{', at);
  const body = source.slice(open + 1, closeOf(source, open));
  const out = {};
  for (const q of questions) {
    const key = new RegExp(`(?:'${q.id.replace(/[?]/g, '\\?')}'|\\b${q.id}\\b):\\s*\\{`).exec(body);
    if (!key) throw new Error(`case '${caseName}' has no answer for '${q.id}'`);
    const o = key.index + key[0].length - 1;
    const lit = body.slice(o, closeOf(body, o) + 1);
    const num = (name) => { const m = new RegExp(`\\b${name}:\\s*(-?[\\d.]+)`).exec(lit); return m ? Number(m[1]) : null; };
    const probs = /probabilities:\s*\{([^}]*)\}/.exec(lit);
    out[q.id] = {
      choice: /choice:\s*'([^']*)'/.exec(lit)?.[1] ?? null, noul: num('noul'), score: num('score'), confidence: num('confidence'),
      probabilities: probs ? [...probs[1].matchAll(/(\d+):\s*([\d.]+)/g)].map((m) => Number(m[2])) : null,
    };
  }
  return out;
}

// ---------- reading a captured explainDecision run ----------

// -> [{ name, action, target, reason, rule, clause, source, readings: [...] }]
export function parseExplain(text) {
  const cases = [];
  let cur = null;
  for (const line of text.split('\n')) {
    let m;
    if ((m = /^# (.+)$/.exec(line))) { cur = { name: m[1], readings: [] }; cases.push(cur); continue; }
    if ((m = /^(\w+)(?: ([^\s/]\S*))?(?: {2}\/\/ (.*))?$/.exec(line)) && isAction(m[1])) {
      if (!cur || cur.action) { cur = { name: null, readings: [] }; cases.push(cur); }
      Object.assign(cur, { action: m[1], target: m[2] ?? null, reason: m[3] ?? null });
      continue;
    }
    if (!cur?.action) continue;
    if ((m = /^ {2}(\w+)(?: (\d+))?(?:, (.*))?$/.exec(line)) && m[1] !== 'because') { Object.assign(cur, { rule: m[1], clause: m[2] === undefined ? null : Number(m[2]), source: m[3] ?? null }); continue; }
    if ((m = /^ {4}(\S+) = (\S+)(?: {3}confidence (\S+))?(?: {3}\((.*)\))?$/.exec(line))) {
      cur.readings.push({ question: m[1], value: m[2], confidence: m[3] === undefined ? null : Number(m[3]), detail: m[4] ?? null });
    }
  }
  if (!cases.length || cases.some((c) => !c.action || !c.rule)) throw new Error('explain output did not parse: ' + text.slice(0, 120));
  return cases;
}

const num = (n) => String(n);

// ---------- flow: ordered boxes joined by labelled arrows ----------

export function flow(steps, links, { model = null } = {}) {
  const cells = steps.map((s, i) => {
    const step = `<div class="flow-step${model === i ? ' flow-step--model' : ''}">
<span class="flow-n">${i + 1}</span>
<strong class="flow-title">${esc(s.title)}</strong>
<span class="flow-api">${s.api}</span>
<div class="flow-data">${s.data}</div>
</div>`;
    return i < links.length ? `${step}\n<div class="flow-link" aria-hidden="true"><span>${esc(links[i])}</span></div>` : step;
  });
  return `<div class="flow${steps.length === 3 ? ' flow--3' : ''}">${cells.join('\n')}</div>`;
}

// The ticket, the model's readings, the rule that fired, the action — one real run.
export function decisionFlow({ ticket, run, policy }) {
  const [d] = parseExplain(run);
  const answered = /^answered by (.+)$/m.exec(run)?.[1];
  if (!answered) throw new Error('decision-flow: the run does not say who answered');
  const clause = d.rule === 'route' ? policy.clauses[d.clause] : null;
  const readings = d.readings.map((r) => `<p><span class="q">${esc(r.question)}</span> <span class="n">${esc(r.value)}</span>${r.confidence !== null ? `<br><span class="dim">confidence ${esc(num(r.confidence))}</span>` : ''}</p>`).join('');
  return `<figure class="diagram" aria-label="One ticket through the policy: a ticket arrives, the model answers, the policy decides, and your code acts on the action.">
${flow([
    { title: 'A ticket arrives', api: 'your app', data: `<p class="flow-quote">“${esc(ticket)}”</p>` },
    { title: 'The model answers', api: '<code>evaluateWithProvider</code>', data: `${readings}<p class="dim">by ${esc(answered)}</p>` },
    { title: 'Your policy decides', api: '<code>policy.decide()</code>', data: `<p><span class="q">${esc(d.rule)} ${esc(num(d.clause))} fired</span></p>${clause?.gloss ? `<p>${esc(clause.gloss)}</p>` : ''}` },
    { title: 'Your code acts', api: 'your handler', data: `<p>${tag(d.action)} <span class="q">${esc(d.target ?? '')}</span></p>${d.reason ? `<p>${esc(d.reason)}</p>` : ''}` },
  ], ['text', 'answers', 'action'], { model: 1 })}
<figcaption>${esc('One real ticket, sent once to the hosted model — the full run is under “Every decision says why”. ')}<b>The outlined step is the only one that calls a model.</b> Everything else is plain code you can read.</figcaption>
</figure>`;
}

// One lifecycle, three routes, read out of the API table.
export function lifecycle({ api }) {
  const route = (needle) => {
    const row = api.find(([r]) => r.includes(needle));
    if (!row) throw new Error(`lifecycle: no route containing ${needle} in the API table`);
    return row[0];
  };
  return `<figure class="diagram" aria-label="The hosted lifecycle: a deployment is published and never changes, promote with an expected version is the only thing that moves production, and replay decides recent traces again against a candidate.">
${flow([
    { title: 'Deploy', api: `<code>${esc(route('/deployments'))}</code>`, data: '<p>Publish a policy. The first deployment becomes production; later ones wait as previews. None can be edited.</p>' },
    { title: 'Promote', api: `<code>${esc(route('/promote'))}</code>`, data: '<p><span class="q">expect</span> names the version you believe production is, so two promotions cannot both win. A rollback is a promotion back.</p>' },
    { title: 'Replay', api: `<code>${esc(route('/replay-diff'))}</code>`, data: '<p>Production’s recent traces are decided again against a candidate. A promote can refuse when too many would change.</p>' },
  ], ['artifact', 'diff first'])}
<figcaption><b>Promote is the only thing that moves production.</b> A deployment is a frozen artifact; nothing it did is undone by a rollback.</figcaption>
</figure>`;
}

// ---------- answers: one ticket, three kinds of answer ----------

const bar = (label, value, top) => `<div class="bar${top ? ' bar--top' : ''}"><span class="bar-label${top ? ' bar-label--top' : ''}">${esc(label)}</span><span class="bar-track"><i class="bar-fill" style="width:${Math.round(value * 100)}%"></i></span><span class="bar-val">${esc(num(value))}</span></div>`;

export function answerShapes({ policy, answers, kinds }) {
  const order = ['noul', 'choice', 'score'];
  const cards = [...policy.questions].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind)).map((q) => {
    const a = answers[q.id];
    const row = kinds.find((r) => r.kind === q.kind);
    if (!row) throw new Error(`answer-shapes: the kinds table has no row for ${q.kind}`);
    let vis;
    if (q.kind === 'noul') vis = `<div class="bars">${bar('yes', a.noul, true)}${bar('no', Math.round((1 - a.noul) * 100) / 100, false)}</div>`;
    else if (q.kind === 'choice') {
      vis = `<div class="pills">${q.options.map((o) => `<span class="pill${o === a.choice ? ' pill--top' : ''}">${esc(o)}</span>`).join('')}</div><div class="bars">${bar('confidence', a.confidence, true)}</div>`;
    } else vis = `<div class="bars">${q.levels.map((l, i) => bar(l, a.probabilities[i], a.probabilities[i] === Math.max(...a.probabilities))).join('')}</div>`;
    return `<div class="answer">
<div class="answer-head"><code>${esc(q.kind)}</code><span>${esc(q.id)}</span></div>
<p class="answer-use">${row.use}</p>
<div class="answer-vis">${vis}</div>
<code class="answer-shape">${esc(row.answer)}</code>
</div>`;
  });
  return `<figure class="diagram" aria-label="One angry refund request answered three ways: a probability for a yes or no question, one option with a confidence for a choice, and a probability for each level of a score.">
<div class="answers">${cards.join('\n')}</div>
<figcaption>The same ticket, answered three ways. <b>The bars are what the model returns;</b> your rules read them with <code>yes()</code>, <code>is()</code> and <code>mostLikely()</code>.</figcaption>
</figure>`;
}

// ---------- meter: a confidence axis with a gate bar ----------

export function gateMeter({ cases, pass, fail }) {
  const find = (name) => {
    const c = cases.find((x) => x.name === name);
    if (!c) throw new Error(`gate-meter: no case '${name}' in the run`);
    return c;
  };
  const ok = find(pass), low = find(fail);
  const barText = low.readings.map((r) => /needed confidence >= ([\d.]+)/.exec(r.detail ?? '')?.[1]).find(Boolean);
  if (!barText) throw new Error('gate-meter: the gated case does not print its bar');
  const bar_ = Number(barText);
  const conf = (c) => c.readings.find((r) => r.confidence !== null)?.confidence;
  const pct = (v) => `${Math.round(v * 1000) / 10}%`;
  const row = (kind, c) => `<li><span class="pin pin--${kind}"></span><span class="v">${esc(num(conf(c)))}</span><span class="to">${esc(c.name)} →</span> ${tag(c.action)} <span class="t">${esc(c.target ?? '')}</span></li>`;
  return `<figure class="diagram" aria-label="A confidence axis from 0 to 1 with the gate bar at ${esc(barText)}. An answer at ${esc(num(conf(low)))} is below the bar and escalates; an answer at ${esc(num(conf(ok)))} clears it and is routed by the rules.">
<div class="meter">
<div class="meter-track" aria-hidden="true">
<span class="meter-zone meter-zone--low" style="width:${pct(bar_)}"></span>
<span class="meter-zone meter-zone--high" style="width:${pct(1 - bar_)}"></span>
</div>
<div class="meter-pins">
<span class="meter-bar" style="left:${pct(bar_)}"><b>gate ${esc(barText)}</b></span>
<span class="meter-pin meter-pin--low" style="left:${pct(conf(low))}"></span>
<span class="meter-pin meter-pin--high" style="left:${pct(conf(ok))}"></span>
</div>
<div class="meter-scale"><span>0</span><span>0.5</span><span>1</span></div>
<div class="meter-key"><span class="key key--low">below the bar, a person decides</span><span class="key key--high">at or above it, the rules decide</span></div>
<ul class="meter-legend">${row('low', low)}${row('high', ok)}</ul>
</div>
<figcaption>The model’s confidence in its answer, on a 0 to 1 axis. <b>The gate bar splits it in two.</b> Both readings come from the run below.</figcaption>
</figure>`;
}

// ---------- ladder: checked from the top, first match wins ----------

const rung = ({ n, when, gloss: g, then, end = false, miss = 'no match' }) => `<li class="rung${end ? ' rung--end' : ''}" data-miss="${esc(miss)}">
<span class="rung-n">${esc(n)}</span>
<span class="rung-when">${when}${g ? `<small>${g}</small>` : ''}</span>
<span class="rung-then">${then}</span>
</li>`;

const thenOf = (d) => `<span class="arrow" aria-hidden="true">→</span>${tag(d.action)}${d.target ? ` <span>${esc(d.target)}</span>` : ''}`;

export function ruleLadder({ policy }) {
  const gates = policy.gates.map((g, i) => rung({ n: i + 1, when: `<code>${esc(g.question)}</code> confidence below ${esc(num(g.bar))}`, gloss: g.reason ? esc(g.reason) : '', then: thenOf(g), miss: 'clears the bar' }));
  const rules = policy.clauses.map((c, i) => rung({ n: i + 1, when: esc(c.when), gloss: c.gloss ? esc(c.gloss) : '', then: thenOf(c), miss: 'no match' }));
  // Whether every option of one choice question has a rule, or there is an otherwise.
  let end = null;
  if (policy.otherwise) end = { when: 'otherwise', then: thenOf(policy.otherwise), gloss: 'Nothing above matched.' };
  else {
    const covered = policy.questions.find((x) => x.kind === 'choice' && x.options.length && x.options.every((o) => policy.clauses.some((c) => c.when.includes(`${x.variable}.is('${o}')`))));
    if (covered) end = { when: `every <code>${esc(covered.id)}</code> option has a rule`, then: '<span class="arrow">✓</span><span>nothing falls through</span>', gloss: esc(covered.options.join(', ')) };
  }
  return `<figure class="diagram" aria-label="How the ticket router decides: gates are checked first and escalate when confidence is too low, then the rules are tried from the top and the first match decides.">
<p class="ladder-head">Gates — checked first</p>
<ol class="ladder">${gates.join('\n')}</ol>
<p class="ladder-head">Rules — top to bottom, the first match decides</p>
<ol class="ladder">${rules.join('\n')}${end ? rung({ n: '·', end: true, miss: 'no match', ...end }) : ''}</ol>
<figcaption>Read straight from <code>support.js</code>. <b>Clause order is policy:</b> move a rule up and it wins first, and the change shows in a diff.</figcaption>
</figure>`;
}

// The tool gate's checks, in the order the gate runs them.
export function toolLadder({ options, questions }) {
  const list = (names) => names.map((n) => `<code>${esc(n)}</code>`).join(', ');
  const rungs = [
    rung({ n: 1, when: `on the deny list: ${list(options.deny)}`, gloss: 'Matches the tool’s name. No model is called.', then: `<span class="arrow" aria-hidden="true">→</span>${tag('deny')}`, miss: 'not listed' }),
    rung({ n: 2, when: `on the allow list: ${list(options.allow)}`, gloss: 'Matches the tool’s name. No model is called.', then: `<span class="arrow" aria-hidden="true">→</span>${tag('allow')}`, miss: 'not listed' }),
    rung({ n: 3, when: `the model answers ${list(questions)}`, gloss: 'Arguments are redacted first; the policy’s rules turn the answers into a verdict.', then: `<span class="arrow" aria-hidden="true">→</span>${tag('allow')}${tag('ask')}${tag('deny')}`, miss: 'not listed' }),
    rung({ n: 4, when: 'anything errors, or the policy cannot decide', gloss: 'A call is never let through on an error.', then: `<span class="arrow" aria-hidden="true">→</span>${tag('ask')} <span>or</span> ${tag('deny')}`, end: true, miss: 'error' }),
  ];
  return `<figure class="diagram" aria-label="The order the tool gate decides a call: the deny list, then the allow list, then the model and the policy; an error never allows.">
<ol class="ladder">${rungs.join('\n')}</ol>
<figcaption><b>The gate fails closed.</b> Both lists run before any model is called, and every verdict is allow, ask or deny.</figcaption>
</figure>`;
}

// ---------- doors: one policy, many ways in ----------

export function doors({ items }) {
  return `<figure class="diagram" aria-label="One policy can be called from code, a shell, an HTTP server, an MCP server, or an agent hook.">
<div class="doors">
<div class="doors-src"><strong>One policy</strong><code>definePolicy({ … })</code><code>policy.toJSON()</code></div>
<ul class="doors-list">${items.map((d) => `<li class="door"><strong>${esc(d.label)}</strong><code>${esc(d.call)}</code><span>${d.text}</span></li>`).join('\n')}</ul>
</div>
<figcaption>Five doors, one decision. <b>The same policy answers the same way through each.</b></figcaption>
</figure>`;
}
