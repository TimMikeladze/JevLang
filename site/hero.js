// The hero's decision console: the README's support.js policy, run in the
// browser. The model's answers are controls; the gates and rules light up as
// they are checked, and the output is printed in explainDecision's format.
//
// Everything it shows is read from the docs: questions, gates and clauses from
// the `support.js` block, the presets from `decide.js`. `simDecide` is the one
// evaluator — the server renders the first preset with it, the page's script
// is its source text, and the site test checks every preset against the
// captured `node decide.js` run, line for line.
import { esc, tag, isAction } from './diagrams.js';

// A clause's `when` as a tree the evaluator can walk. Only the forms support.js
// uses are understood; anything else fails the build rather than guessing.
export function whenTree(src, byVar) {
  src = src.trim();
  let m;
  if ((m = /^all\(([\s\S]*)\)$/.exec(src))) return { all: splitArgs(m[1]).map((s) => whenTree(s, byVar)) };
  if ((m = /^(\w+)\.yes\(([\d.]+)\)$/.exec(src))) return { yes: q(m[1]), t: Number(m[2]) };
  if ((m = /^(\w+)\.is\('([^']+)'\)$/.exec(src))) return { is: q(m[1]), o: m[2] };
  if ((m = /^(\w+)\.mostLikely\('([^']+)'\)$/.exec(src))) {
    const level = byVar[m[1]].levels.indexOf(m[2]);
    if (level < 0) throw new Error(`hero: ${m[2]} is not a level of ${m[1]}`);
    return { likely: q(m[1]), l: level };
  }
  throw new Error(`hero: cannot evaluate clause ${src}`);
  function q(v) { if (!byVar[v]) throw new Error(`hero: unknown question ${v}`); return byVar[v].id; }
}

function splitArgs(s) {
  const out = []; let depth = 0, cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  return [...out, cur].map((x) => x.trim()).filter(Boolean);
}

// The model the console runs on: plain JSON, embedded in the page.
export function simModel(policy) {
  return {
    questions: policy.questions.map((x) => ({ id: x.id, kind: x.kind, options: x.options, levels: x.levels })),
    gates: policy.gates.map((g) => ({ q: policy.byVar[g.question].id, bar: g.bar, action: g.action, target: g.target, reason: g.reason })),
    clauses: policy.clauses.map((c) => ({ when: whenTree(c.when, policy.byVar), gloss: c.gloss, action: c.action, target: c.target, reason: c.reason })),
  };
}

// The evaluator. Self-contained on purpose: its source text is the page script.
export function simDecide(m, a) {
  const n = (x) => String(Math.round(x * 100) / 100);
  const conf = (id) => (a[id].confidence ?? 1);
  const best = (id) => { const p = a[id].probabilities; return p ? p.indexOf(Math.max(...p)) : a[id].score; };
  const reading = (id, detail) => {
    const x = a[id], kind = m.questions.find((q) => q.id === id).kind;
    const v = kind === 'choice' ? x.choice : kind === 'score' ? x.score : n(x.noul);
    return `    ${id} = ${v}${kind === 'noul' ? '' : `   confidence ${n(x.confidence)}`}${detail ? `   (${detail})` : ''}`;
  };
  const test = (w, reads) => {
    if (w.all) return w.all.every((x) => test(x, reads));
    if (w.yes) { reads.push([w.yes]); return a[w.yes].noul >= w.t; }
    if (w.is) { reads.push([w.is]); return a[w.is].choice === w.o; }
    if (w.likely) {
      const p = a[w.likely].probabilities;
      reads.push([w.likely, p ? `most likely: ${best(w.likely)} (p=${n(p[best(w.likely)])})` : null]);
      return best(w.likely) === w.l;
    }
    return false;
  };
  const route = () => {
    for (let i = 0; i < m.clauses.length; i++) {
      const reads = [];
      if (test(m.clauses[i].when, reads)) return { i, reads, ...m.clauses[i] };
    }
    return null;
  };
  const head = (d) => `${d.action} ${d.target}${d.reason ? `  // ${d.reason}` : ''}`;
  const r = route();
  for (let i = 0; i < m.gates.length; i++) {
    const g = m.gates[i];
    if (conf(g.q) < g.bar) {
      const detail = `needed confidence >= ${g.bar.toFixed(2)}${r ? `; otherwise: ${r.action} ${r.target}` : ''}`;
      return { rule: 'gate', clause: i, action: g.action, target: g.target,
        text: [head(g), `  gate ${i}, $.gates[${i}]`, '  because', reading(g.q, detail)].join('\n') };
    }
  }
  if (!r) return { rule: 'none', clause: -1, action: 'hold', target: 'no rule matched', text: 'no rule matched' };
  return { rule: 'route', clause: r.i, action: r.action, target: r.target,
    text: [head(r), `  route ${r.i}, $.route.clauses[${r.i}]`, '  because', ...r.reads.map(([id, d]) => reading(id, d))].join('\n') };
}

// The page's wiring: presets, controls, and what lights up. Runs only with
// script; without it the console is the first preset, fully rendered.
function simWire(m, presets, root) {
  let a = JSON.parse(JSON.stringify(presets[0].answers));
  const $ = (s) => [...root.querySelectorAll(s)];
  const pct = (x) => `${Math.round(x * 100)}%`;
  const draw = () => {
    const d = simDecide(m, a);
    for (const q of m.questions) {
      const x = a[q.id];
      $(`[data-pick="${q.id}"]`).forEach((b) => b.setAttribute('aria-pressed', String(q.kind === 'choice' ? b.value === x.choice : Number(b.value) === x.score)));
      $(`input[data-q="${q.id}"]`).forEach((i) => { i.value = String(q.kind === 'noul' ? x.noul : x.confidence); i.style.setProperty('--v', pct(i.value)); });
      $(`[data-out="${q.id}"]`).forEach((o) => { o.textContent = (q.kind === 'noul' ? x.noul : x.confidence).toFixed(2); });
    }
    $('[data-rung]').forEach((li) => {
      const [kind, i] = li.dataset.rung.split(':');
      const hit = d.rule === kind && d.clause === Number(i);
      const passed = kind === 'gate' ? d.rule !== 'gate' || Number(i) < d.clause : d.rule === 'route' && Number(i) < d.clause;
      li.dataset.state = hit ? 'fired' : passed ? 'passed' : 'idle';
    });
    const res = root.querySelector('[data-result]');
    res.innerHTML = `<span class="tag tag--${d.action}">${d.action}</span><code>${d.target}</code>`;
    root.querySelector('[data-explain]').textContent = d.text;
  };
  root.addEventListener('click', (e) => {
    const p = e.target.closest('[data-preset]');
    if (p) { a = JSON.parse(JSON.stringify(presets[Number(p.dataset.preset)].answers)); $('[data-preset]').forEach((b) => b.setAttribute('aria-pressed', String(b === p))); return draw(); }
    const b = e.target.closest('[data-pick]');
    if (!b) return;
    const x = a[b.dataset.pick];
    if (b.dataset.kind === 'choice') x.choice = b.value;
    else { x.score = Number(b.value); x.probabilities = null; }
    $('[data-preset]').forEach((t) => t.setAttribute('aria-pressed', 'false'));
    draw();
  });
  root.addEventListener('input', (e) => {
    const i = e.target.closest('input[data-q]');
    if (!i) return;
    const x = a[i.dataset.q];
    if (i.dataset.field === 'noul') x.noul = Number(i.value); else { x.confidence = Number(i.value); x.probabilities = null; }
    $('[data-preset]').forEach((t) => t.setAttribute('aria-pressed', 'false'));
    draw();
  });
  root.dataset.live = '';
  draw();
}

// The console's markup, drawn in the state of the first preset.
export function heroConsole({ policy, presets }) {
  const m = simModel(policy);
  const a = presets[0].answers;
  const d = simDecide(m, a);
  const gateFor = (id) => m.gates.find((g) => g.q === id);
  const thresholds = (id) => {
    const bars = [];
    const g = gateFor(id);
    if (g) bars.push({ at: g.bar, label: `gate ${g.bar.toFixed(2)}` });
    const walk = (w) => { if (w.all) w.all.forEach(walk); if (w.yes === id) bars.push({ at: w.t, label: `rule ${w.t.toFixed(2)}` }); };
    m.clauses.forEach((c) => walk(c.when));
    return bars.map((b) => `<i class="sim-bar" style="left:${Math.round(b.at * 100)}%" title="${esc(b.label)}"><span>${esc(b.label)}</span></i>`).join('');
  };
  const slider = (id, field, value) => `<div class="sim-slide"><div class="sim-track">
<input type="range" min="0" max="1" step="0.01" value="${value}" data-q="${esc(id)}" data-field="${field}" style="--v:${Math.round(value * 100)}%" aria-label="${esc(id)} ${field === 'noul' ? 'probability of yes' : 'confidence'}">${thresholds(id)}</div>
<output data-out="${esc(id)}">${value.toFixed(2)}</output></div>`;
  const row = (q) => {
    const x = a[q.id];
    let pick = '';
    if (q.kind === 'choice') pick = q.options.map((o) => `<button type="button" class="sim-pill" data-pick="${esc(q.id)}" data-kind="choice" value="${esc(o)}" aria-pressed="${o === x.choice}">${esc(o)}</button>`).join('');
    if (q.kind === 'score') pick = q.levels.map((l, i) => `<button type="button" class="sim-pill" data-pick="${esc(q.id)}" data-kind="score" value="${i}" aria-pressed="${i === x.score}" title="${esc(l)}">${esc(l.split(/[ ,]/)[0].toLowerCase())}</button>`).join('');
    return `<li class="sim-q"><div class="sim-q-head"><code class="sim-kind">${esc(q.kind)}</code><span class="sim-id">${esc(q.id)}</span></div>
${pick ? `<div class="sim-pills" role="group" aria-label="${esc(q.id)}">${pick}</div>` : ''}
${slider(q.id, q.kind === 'noul' ? 'noul' : 'confidence', q.kind === 'noul' ? x.noul : x.confidence)}</li>`;
  };
  const rungState = (kind, i) => (d.rule === kind && d.clause === i ? 'fired' : (kind === 'gate' ? d.rule !== 'gate' || i < d.clause : d.rule === 'route' && i < d.clause) ? 'passed' : 'idle');
  const rungs = [
    ...m.gates.map((g, i) => `<li class="sim-rung" data-rung="gate:${i}" data-state="${rungState('gate', i)}"><span class="sim-rung-k">gate</span><span class="sim-rung-w">${esc(g.q)} below ${g.bar.toFixed(2)}</span>${tag(g.action)}<code>${esc(g.target)}</code></li>`),
    ...m.clauses.map((c, i) => `<li class="sim-rung" data-rung="route:${i}" data-state="${rungState('route', i)}"><span class="sim-rung-k">rule ${i}</span><span class="sim-rung-w">${esc(c.gloss)}</span>${tag(c.action)}<code>${esc(c.target)}</code></li>`),
  ].join('\n');
  if (!isAction(d.action)) throw new Error(`hero: ${d.action} is not an action`);
  return `<figure class="sim" aria-label="A live console for the support.js policy: pick a ticket, change what the model answered, and watch the gates and rules decide.">
<div class="frame-bar"><span class="dots" aria-hidden="true"><span class="dot"></span><span class="dot"></span><span class="dot"></span></span><span class="name">support.js <b>·</b> policy.decide()</span><span class="chip sim-chip">runs in your browser</span></div>
<div class="sim-body">
<div class="sim-presets" role="group" aria-label="Tickets from decide.js">${presets.map((p, i) => `<button type="button" class="sim-preset" data-preset="${i}" aria-pressed="${i === 0}">${esc(p.name)}</button>`).join('')}</div>
<div class="sim-cols">
<div class="sim-col"><p class="sim-step"><span>1</span> The model answers</p><ul class="sim-qs">${m.questions.map(row).join('\n')}</ul></div>
<div class="sim-col"><p class="sim-step"><span>2</span> Your policy decides</p><ol class="sim-rungs">${rungs}</ol></div>
</div>
<div class="sim-out"><div class="sim-result" data-result>${tag(d.action)}<code>${esc(d.target)}</code></div><pre class="sim-explain" data-explain>${esc(d.text)}</pre></div>
</div>
<script type="application/json" id="sim-data">${JSON.stringify({ m, presets }).replace(/</g, '\\u003c')}</script>
</figure>`;
}

// The one extra script: the evaluator and the wiring, as their own source.
export const heroScript = `<script>
${simDecide.toString()}
${simWire.toString()}
(function(){var s=document.getElementById('sim-data');if(!s)return;var d=JSON.parse(s.textContent);simWire(d.m,d.presets,s.closest('.sim'));})();
</script>`;
