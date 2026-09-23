// The OG cards: one per page, 1200x630. Each shows what JevLang does on a real
// case — the model's readings, the rule that fired, the action — beside the
// page's title. shoot-card.js screenshots every card into site/out.
import { esc } from './diagrams.js';

// tone: ok (assign), warn (escalate/page), bad (hold) — the site's decision colours.
export const cards = [
  {
    file: 'og.png', kicker: 'Policy engine for LLM decisions',
    title: 'The model answers.<br>Your code decides.',
    lede: 'Declared, typechecked policies. Every decision explained, replayable and audited.',
    receipt: {
      name: 'support-routing', input: '“I was charged twice this month”',
      readings: [['department', 'billing', '0.94'], ['refund?', 'yes', '0.81']],
      rule: 'rule · department is billing ∧ refund?', action: 'assign', target: 'billing-refunds', tone: 'ok',
    },
  },
  {
    file: 'og-reference.png', kicker: 'Reference',
    title: 'Everything in<br>the box.',
    lede: 'Questions, gates, routes, dispatch, providers, MCP, serving — the full README.',
    receipt: {
      name: 'hello', input: '“WIN a FREE cruise, click now”',
      readings: [['spam?', 'yes', '0.97']],
      rule: 'rule · spam? ≥ 0.9', action: 'hold', target: 'almost certainly spam', tone: 'bad',
    },
  },
  {
    file: 'og-examples-maintenance.png', kicker: 'Example · Tenant hotline',
    title: 'Wake the<br>right person.',
    lede: 'A gas smell at 3am pages on-call. A drip at noon waits for today’s plumber.',
    receipt: {
      name: 'maintenance', input: '“smells like gas in the hall” · 03:00',
      readings: [['issue', 'other', '0.40'], ['danger?', 'yes', '0.35']],
      rule: 'gate · danger? ≥ 0.3', action: 'page', target: 'emergency-oncall', tone: 'warn',
    },
  },
  {
    file: 'og-examples-reservation.png', kicker: 'Example · SMS host',
    title: 'Allergies reach<br>the kitchen.',
    lede: 'Party size and free seats come from the booking system. The model reads intent.',
    receipt: {
      name: 'sms-host', input: '“Table for 4 Sat 7pm? My son carries an EpiPen”',
      readings: [['intent', 'book', '0.95'], ['severe-allergy?', 'yes', '0.96']],
      rule: 'rule · book ∧ severe-allergy?', action: 'assign', target: 'confirm-and-alert-kitchen', tone: 'ok',
    },
  },
  {
    file: 'og-examples-doorstep.png', kicker: 'Example · Courier app',
    title: 'The driver never<br>learns the rules.',
    lede: 'Parcel value and weather come from dispatch. The model only reads the door.',
    receipt: {
      name: 'doorstep-dispatch', input: '“Big dog loose in the yard, nobody answering”',
      readings: [['situation', 'nobody-home', '0.93'], ['unsafe?', 'yes', '0.91']],
      rule: 'rule · unsafe? ≥ 0.5', action: 'assign', target: 'reattempt-tomorrow', tone: 'ok',
    },
  },
];

const receiptHtml = r => `<figure class="receipt">
<figcaption><span class="dots"><i></i><i></i><i></i></span><b>decision</b> · ${esc(r.name)}</figcaption>
<div class="step"><span class="lab">input</span><p class="input">${esc(r.input)}</p></div>
<div class="step"><span class="lab lab--model">model answers</span>${r.readings.map(([q, a, c]) => `<p class="reading"><span class="q">${esc(q)}</span><span class="a">${esc(a)}</span><span class="c">${esc(c)}</span></p>`).join('')}</div>
<div class="step"><span class="lab">policy</span><p class="rule">${esc(r.rule)}</p></div>
<p class="action tone-${r.tone}"><span>${esc(r.action)}</span>${esc(r.target)}</p>
</figure>`;

export function cardHtml(card) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><style>
:root{--paper:oklch(12.5% 0 0);--band:oklch(15.5% 0 0);--raise:oklch(18.5% 0 0);--ink:oklch(98.5% 0 0);--body:oklch(78% 0 0);--soft:oklch(63% 0 0);
--line:oklch(100% 0 0/.11);--accent:oklch(70% .16 250);--add:oklch(72% .17 150);--del:oklch(68% .19 20);--warn:oklch(78% .15 85);
--sans:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;--mono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,monospace}
*{box-sizing:border-box;margin:0}
body{width:1200px;height:630px;overflow:hidden;background:var(--paper);color:var(--body);font-family:var(--sans);
background-image:radial-gradient(circle at 1px 1px,oklch(100% 0 0/.07) 1px,transparent 0);background-size:28px 28px;
display:grid;grid-template-columns:minmax(0,1fr) 470px;gap:56px;padding:64px 72px 60px}
.left{display:flex;flex-direction:column;min-width:0}
.word{font:700 30px/1 var(--sans);letter-spacing:-.02em;color:var(--ink)}
.word i{font-style:normal;color:var(--accent)}
.kicker{margin-top:56px;font:600 17px/1 var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--soft)}
h1{margin-top:20px;font-size:62px;line-height:1.02;letter-spacing:-.045em;font-weight:750;color:var(--ink)}
.lede{margin-top:26px;font-size:23px;line-height:1.45;color:var(--body);max-width:30ch}
.foot{margin-top:auto;display:flex;gap:14px;align-items:center;font:500 18px/1 var(--mono);color:var(--soft)}
.foot b{color:var(--ink);font-weight:600}
.foot .pill{border:1px solid var(--line);background:var(--raise);border-radius:9px;padding:10px 14px;color:var(--ink)}
.receipt{align-self:center;background:var(--band);border:1px solid var(--line);border-radius:16px;overflow:hidden;box-shadow:0 30px 70px -30px oklch(0% 0 0/.8)}
figcaption{display:flex;align-items:center;gap:12px;padding:15px 20px;border-bottom:1px solid var(--line);font:500 16px/1 var(--mono);color:var(--soft)}
figcaption b{color:var(--ink);font-weight:600}
.dots{display:flex;gap:6px}.dots i{width:11px;height:11px;border-radius:50%;background:oklch(100% 0 0/.14)}
.step{padding:16px 20px 4px}
.lab{display:inline-block;font:600 12px/1 var(--mono);letter-spacing:.1em;text-transform:uppercase;color:var(--soft);margin-bottom:10px}
.lab--model{color:var(--accent)}
.input{font-size:18px;line-height:1.4;color:var(--ink)}
.reading{display:grid;grid-template-columns:1fr auto 52px;gap:12px;align-items:baseline;font:500 17px/1.9 var(--mono)}
.reading .q{color:var(--body)}.reading .a{color:var(--ink)}.reading .c{color:var(--accent);text-align:right}
.rule{font:500 16px/1.4 var(--mono);color:var(--body)}
.action{margin:14px 20px 20px;display:flex;align-items:center;gap:12px;padding:14px 16px;border-radius:10px;font:600 18px/1.2 var(--mono);color:var(--ink);border:1px solid var(--line)}
.action span{font-size:13px;letter-spacing:.08em;text-transform:uppercase;padding:6px 9px;border-radius:6px}
.tone-ok{background:color-mix(in oklab,var(--add) 12%,var(--band));border-color:color-mix(in oklab,var(--add) 35%,transparent)}.tone-ok span{background:var(--add);color:var(--paper)}
.tone-warn{background:color-mix(in oklab,var(--warn) 12%,var(--band));border-color:color-mix(in oklab,var(--warn) 35%,transparent)}.tone-warn span{background:var(--warn);color:var(--paper)}
.tone-bad{background:color-mix(in oklab,var(--del) 12%,var(--band));border-color:color-mix(in oklab,var(--del) 35%,transparent)}.tone-bad span{background:var(--del);color:var(--paper)}
</style></head>
<body>
<div class="left">
<p class="word">jevlang<i>.</i></p>
<p class="kicker">${esc(card.kicker)}</p>
<h1>${card.title}</h1>
<p class="lede">${esc(card.lede)}</p>
<p class="foot"><b>jevlang.sh</b><span class="pill">bun add jevlang</span></p>
</div>
${receiptHtml(card.receipt)}
</body></html>`;
}
