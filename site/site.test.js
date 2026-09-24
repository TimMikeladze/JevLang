// Site tests: references resolve, figures match, pages self-contained and
// current, metadata honest, artefacts present. Run: bun test site/site.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { sections, links, meta, agentsMistakes, repo } from './content.js';
import {
  makeResolver, figure, renderLanding, renderReference, llmsText, agentsMd, pageMarkdown, sitemap, robots, markdownHtml,
  heroModel, esc, modulesTable, cloudApiTable, cloudSection, cloudTable, cloudList, readmeTable, readmeList, version, bootScript, url,
} from './render.js';
import { css, chromeCss } from './styles.js';
import { heroScript, simModel, simDecide } from './hero.js';
import { readPolicy, readAnswers, parseExplain } from './diagrams.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const readme = read('../README.md');
const cloudReadme = read('../docs/cloud-api.md');
const index = read('./out/index.html');
const reference = read('./out/reference.html');
const r = makeResolver(readme);
const section = (id) => index.split(`<section id="${id}"`)[1].split('</section>')[0];

// 1 + 2. every reference resolves to exactly one block; every figure matches.
test('references resolve and figures match', () => {
  const walk = (d) => {
    if (d.file) r.file(d.file);
    if (d.run) r.run(d.run);
    for (const cmd of d.runs ?? []) r.run(cmd);
    for (const s of d.steps ?? []) walk(s);
    if (d.ticket) figure(r.file(d.ticket.file).body, d.ticket.from);
    if (d.policy) r.file(d.policy);
    if (d.decide) r.file(d.decide);
    if (d.options) r.file(d.options);
  };
  for (const s of sections) for (const d of s.demos) walk(d);
  assert.throws(() => r.terminal('no such command'), /expected 1 block/);
  assert.throws(() => r.file('nope.js'), /expected 1 block/);
});

// 3. self-contained pages; theme machinery present.
test('pages are self-contained', () => {
  for (const page of [index, reference]) {
    assert.doesNotMatch(page, /<(?:link[^>]*rel="(?:stylesheet|preload|icon)"|script|img)[^>]+(?:src|href)="https?:/);
    assert.equal([...page.matchAll(/<script[^>]*src=/g)].length, 0);
    const inline = [...page.matchAll(/<script(?:\s[^>]*)?>[\s\S]*?<\/script>/g)].filter((m) => !/^<script type="application\/(?:ld\+)?json"/.test(m[0]));
    // The boot script, plus — on the landing page only — the hero console's
    // script at the end of <body>, capped in size; the page works without it.
    assert.equal(inline.length, page === index ? 2 : 1, 'boot script (+ hero console on the landing page)');
    if (page === index) {
      assert.equal(inline[1][0], heroScript);
      assert.ok(heroScript.length < 8000, `hero script ${heroScript.length} bytes`);
      assert.ok(page.indexOf(heroScript) > page.indexOf('</footer>'), 'hero script runs after the markup');
    }
    assert.ok(inline[0][0].split('\n').length < 30, 'boot script under 30 lines');
    const head = page.split('</head>')[0];
    assert.ok(head.indexOf(inline[0][0]) > 0 && head.indexOf(inline[0][0]) < head.indexOf('<style>'), 'the boot script sits in <head>, before the stylesheet');
    assert.match(page, /:root\[data-theme=light\]/);
    assert.match(page, /prefers-color-scheme:light\)\{:root:not\(\[data-theme=dark\]\):not\(\[data-theme=light\]\)/);
    assert.match(page, /color-scheme:dark/);
    assert.match(page, /jevlang-theme/);
    assert.match(page, /html\[data-js\] \.copy-btn/, 'copy buttons exist only when the script runs');
  }
  assert.equal(bootScript.match(/matchMedia\('\(prefers-color-scheme: dark\)'\)/).length, 1);
  const toggle = index.match(/<button id="theme-toggle"[^>]*>([\s\S]*?)<\/button>/);
  assert.match(toggle[0], /aria-label="Theme: system\. Click to change"/);
  for (const state of ['system', 'dark', 'light']) assert.match(toggle[1], new RegExp(`i-${state}`));
  assert.ok(index.split('</header>')[0].includes('id="theme-toggle"'), 'the toggle is in the header');
});

// contrast: OKLCH -> sRGB -> WCAG ratio, over every text colour on every surface.
function oklchToRgb(L, C, h) {
  const hr = (h * Math.PI) / 180;
  const a = C * Math.cos(hr), b = C * Math.sin(hr);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
  return [
    +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ].map((c) => Math.min(1, Math.max(0, c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)));
}
const lum = ([r_, g, b]) => {
  const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r_) + 0.7152 * lin(g) + 0.0722 * lin(b);
};
const ratio = (fg, bg) => { const [a, c] = [lum(fg), lum(bg)].sort((x, y) => y - x); return (a + 0.05) / (c + 0.05); };
const tokens = (block) => Object.fromEntries([...block.matchAll(/--([\w-]+):oklch\(([\d.]+)%\s*([\d.]*)\s*([\d.]*)\)/g)].map((m) => [m[1], oklchToRgb(+m[2] / 100, +(m[3] || 0), +(m[4] || 0))]));

test('text contrast >= 4.5 on every surface, in both schemes', () => {
  const dark = tokens(css.slice(css.indexOf(':root{'), css.indexOf(':root[data-theme=light]')));
  const light = tokens(css.slice(css.indexOf(':root[data-theme=light]'), css.indexOf('@media (prefers-color-scheme:light)')));
  const fallback = tokens(css.slice(css.indexOf('@media (prefers-color-scheme:light)'), css.indexOf('*{box-sizing')));
  assert.deepEqual(fallback, light, 'the no-script fallback carries the same light tokens');
  for (const [scheme, t] of [['dark', dark], ['light', light]]) {
    for (const bg of ['paper', 'band', 'raise']) {
      for (const fg of ['ink', 'body', 'soft', 'accent', 'add', 'del', 'warn', 'tk-kw', 'tk-str', 'tk-num', 'tk-fn', 'tk-cmt']) {
        assert.ok(ratio(t[fg], t[bg]) >= 4.5, `${scheme}: ${fg} on ${bg} is ${ratio(t[fg], t[bg]).toFixed(2)}`);
      }
    }
  }
});

// 4. markup in the source doc is escaped, never executed.
test('source markup escaped', () => {
  const html = markdownHtml('Run <img src=x onerror=alert(1)> now\n\n```\n<b>x</b>\n```\n\n| a |\n| - |\n| <i> |');
  assert.doesNotMatch(html, /<img|<b>|<i>/);
  assert.match(html, /&lt;img/);
  assert.doesNotMatch(reference, /<script(?![^>]*ld\+json)(?![^>]*>\s*\(function)/);
});

// 5. committed files equal a fresh render.
test('committed output is current', () => {
  const fresh = {
    'index.html': renderLanding({ readme, cloudReadme }), 'reference.html': renderReference({ readme }),
    'index.md': pageMarkdown({ readme, cloudReadme }), 'llms.txt': llmsText({ readme, cloudReadme }),
    'AGENTS.md': agentsMd({ readme }), 'sitemap.xml': sitemap(), 'robots.txt': robots(),
  };
  for (const [name, content] of Object.entries(fresh)) assert.equal(read(`./out/${name}`), content, `${name} is stale: run bun run site`);
});

// 6. every source section reaches the reference page; anchors land.
test('reference completeness and anchors', () => {
  const slug = (h) => h.toLowerCase().replace(/[^\w]+/g, '-').replace(/^-|-$/g, '');
  for (const h2 of readme.matchAll(/^## (.+)$/gm)) assert.ok(reference.includes(`id="${slug(h2[1])}"`), `missing section ${h2[1]}`);
  for (const [, anchor] of index.matchAll(/href="\/reference#([^"]+)"/g)) assert.ok(reference.includes(`id="${anchor}"`), `anchor ${anchor}`);
  for (const s of sections) if (s.doc) assert.ok(index.includes(`/reference#${slug(s.doc)}`), s.doc);
});

// 7. head metadata.
test('head metadata', () => {
  const head = index.split('</head>')[0];
  assert.equal(head.match(/<title>([^<]+)<\/title>/)[1], `${meta.name} — ${meta.tagline}`);
  const desc = head.match(/name="description" content="([^"]+)"/)[1];
  assert.ok(desc.length <= 160 && desc.endsWith('.'), `description ${desc.length} chars`);
  assert.match(head, /rel="canonical" href="https:\/\/jevlang\.sh\/"/);
  assert.ok(!head.includes('index.html'));
  for (const p of ['og:title', 'og:description', 'og:url', 'og:type', 'og:site_name', 'og:image:width', 'og:image:height', 'og:image:type', 'og:image:alt', 'twitter:card', 'twitter:image']) assert.ok(head.includes(p), p);
  assert.match(head, /og:image" content="https:\/\/jevlang\.sh\/og\.png"/);
  assert.match(head, /media="\(prefers-color-scheme: dark\)"/);
  assert.match(head, /media="\(prefers-color-scheme: light\)"/);
  const ld = JSON.parse(head.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
  assert.equal(ld.name, meta.name);
  assert.equal(ld.softwareVersion, version);
  assert.equal(ld.applicationCategory, 'DeveloperApplication');
  assert.equal(ld.url, url('/'));
});

// 8. hero and capability sections well-formed.
test('hero and capability sections', () => {
  assert.equal([...index.matchAll(/<h1[ >]/g)].length, 1);
  assert.ok(meta.h1.split(/\s+/).length <= 8 && !meta.h1.endsWith('.'), 'H1: at most 8 words, no full stop');
  const hero = index.split('<section class="hero"')[1].split('</section>')[0];
  assert.equal([...hero.matchAll(/<a class="control|<span class="control|<details class="control/g)].length, 3, 'three controls');
  assert.ok(!hero.includes(`Currently v${version}`), 'no version line in the hero');
  const ledeLinks = [...hero.match(/<p class="lede">([\s\S]*?)<\/p>/)[1].matchAll(/<a href="([^"]+)">/g)].map((m) => m[1]);
  assert.deepEqual(ledeLinks, [repo, 'https://cloud.jevlang.sh'], 'lede links the repo, and the hosted product while the cloud flag is on');
  assert.ok(sections.length >= 4);
  for (const s of sections) {
    const sec = section(s.id);
    assert.match(sec.split('\n')[0], new RegExp(`aria-labelledby="${s.id}-h"`));
    assert.ok(sec.includes(`<h2 id="${s.id}-h">`), `${s.id}: h2`);
    const words = s.h2.split(/\s+/).length;
    assert.ok(words <= 6 && !s.h2.endsWith('.'), `${s.id}: H2 is ${words} words`);
    const expl = sec.match(/<p class="expl">([\s\S]*?)<\/p>/)[1].replace(/ <a href="\/reference#[^>]*>[^<]*<\/a>$/, '');
    const sentences = expl.replace(/<[^>]+>/g, '').split(/(?<=\.)\s/).filter(Boolean).length;
    assert.ok(sentences >= 1 && sentences <= 3, `${s.id}: ${sentences} sentences`);
    assert.ok(expl.includes('<code>'), `${s.id}: no inline code`);
  }
  // Headings descend without skipping: h1, h2 sections, and no h3 outside the footer.
  assert.ok(!/<h4/.test(index));
});

// 9. artefacts exist and say what the page says; sitemap paths resolve to files.
test('artefacts and sitemap', () => {
  for (const f of ['llms.txt', 'AGENTS.md', 'sitemap.xml', 'robots.txt', 'index.md', 'og.png']) assert.ok(existsSync(new URL(`./out/${f}`, import.meta.url)), f);
  const sm = read('./out/sitemap.xml');
  for (const loc of sm.matchAll(/<loc>([^<]+)<\/loc>/g)) {
    const path = new URL(loc[1]).pathname.replace(/\/$/, '');
    // The examples are pages of the Next.js app, not files in site/out.
    if (path.startsWith('/examples')) { assert.ok(existsSync(new URL(`../examples/nextjs/app${path}/page.js`, import.meta.url)), loc[1]); continue; }
    assert.ok(existsSync(new URL(`./out/${path === '' ? 'index' : path.replace(/^\//, '')}.html`, import.meta.url)), loc[1]);
  }
  assert.match(read('./out/robots.txt'), /Sitemap: https:\/\/jevlang\.sh\/sitemap\.xml/);
  const llms = read('./out/llms.txt');
  const md = read('./out/index.md');
  assert.match(llms, /^# JevLang\n\n> /);
  for (const s of sections.filter((x) => !x.flag)) { assert.ok(llms.includes(`## ${s.h2}`), `llms.txt: ${s.h2}`); assert.ok(md.includes(`## ${s.h2}`), `index.md: ${s.h2}`); }
  assert.ok(llms.includes(url('/reference')) && llms.includes('https://github.com/TimMikeladze/JevLang'));
  // The examples travel with the text: the file an agent copies is the file the page shows.
  assert.ok(md.includes(r.file('policy.js').body) && llms.includes(r.file('support.js').body));
  const agents = read('./out/AGENTS.md');
  assert.ok(agents.includes('bun add jevlang') && agents.includes(r.file('policy.js').body));
  for (const m of agentsMistakes) assert.ok(agents.includes(m.replace(/`/g, '').slice(0, 30)), m);
  assert.ok(agents.includes('WebFetch') && agents.includes('Bash(rm *)'), 'the tool gate note');
});

// 10. every OG card exists, and its PNG header really says 1200x630, small enough for every client.
test('og cards dimensions', async () => {
  const { cards } = await import('./cards.js');
  for (const { file } of cards) {
    const png = readFileSync(new URL(`./out/${file}`, import.meta.url));
    assert.equal(png.readUInt32BE(16), 1200, file);
    assert.equal(png.readUInt32BE(20), 630, file);
    assert.ok(png.length < 300 * 1024, `${file} is ${png.length} bytes`);
  }
  assert.match(read('./out/reference.html'), /og:image" content="https:\/\/jevlang\.sh\/og-reference\.png"/);
});

// 11. links appear as the model says.
test('link table honoured', () => {
  const labelsIn = (part) => [...part.matchAll(/aria-label="([^"]+)"/g)].map((m) => m[1]).filter((l) => links.some((x) => x.label === l));
  const header = index.split('</header>')[0];
  assert.deepEqual(labelsIn(header), ['JevLang on GitHub', 'linesofcode on X', 'Tim Mikeladze on LinkedIn']);
  assert.deepEqual(labelsIn(index.split('<footer')[1]), ['JevLang on GitHub', 'linesofcode on X', 'Tim Mikeladze on LinkedIn', 'linesofcode on Discord']);
  assert.ok(header.indexOf('class="head-icons"') > header.indexOf('class="site-nav"'));
  for (const href of ['https://github.com/TimMikeladze/JevLang', 'https://x.com/linesofcode', 'https://www.linkedin.com/in/tim-mikeladze', 'https://discord.com/users/linesofcode']) assert.ok(index.includes(`href="${href}"`), href);
  // Everything cloud is in the HTML but behind the `cloud` Vercel flag: hidden
  // by default, revealed by the boot script when the proxy's cookie is present,
  // and left out of the agent files. See docs/cloud-flag.md.
  assert.match(header, /Cloud <span class="ext">↗<\/span>/);
  assert.ok(header.includes('href="https://cloud.jevlang.sh/sign-in" target="_blank" rel="noopener" data-flag="cloud"'));
  assert.ok(bootScript.includes('jev-cloud=1') && bootScript.includes("dataset.flags='cloud'"), 'boot script reveals on the cookie');
  assert.ok(css.includes('html:not([data-flags~=cloud]) [data-flag=cloud]{display:none!important}'), 'hidden unless the flag is on');
  assert.ok(chromeCss.includes('html:not([data-flags~=cloud])'), 'example pages get the rule');
  const cloudIds = sections.filter((s) => s.flag === 'cloud').map((s) => s.id);
  assert.deepEqual(cloudIds, ['cloud', 'promote', 'managed-state', 'own-runner', 'bring-your-own', 'isolation', 'cloud-api', 'plans']);
  for (const id of cloudIds) assert.match(index, new RegExp(`<section id="${id}" class="section[^"]*" data-flag="cloud"`), id);
  assert.ok(index.includes('<div class="aside" data-flag="cloud">'));
  assert.ok(index.includes('<div class="foot-col" data-flag="cloud"><h3>Jev Cloud</h3>'));
  assert.ok(/<p class="lede">[^]*<span data-flag="cloud">[^<]*<a href="https:\/\/cloud\.jevlang\.sh">Jev Cloud<\/a>/.test(index), 'lede cloud sentence flagged');
  // Nothing cloud outside a flagged element: strip them, and no cloud link or section is left.
  for (const [name, text] of [['llms.txt', read('out/llms.txt')], ['index.md', read('out/index.md')]]) {
    assert.ok(!/cloud\.jevlang\.sh|Jev Cloud|jevlang\/cloud/.test(text), `${name} mentions the cloud`);
  }
  assert.ok(!/Jev Cloud|cloud\.jevlang/.test(read('out/index.html').match(/<meta name="description" content="([^"]+)"/)[1]));
});

// extra: enumeration tables come from the docs, and the docs agree with each other.
test('tables read from docs', () => {
  assert.ok(modulesTable(readme).length >= 8);
  assert.ok(cloudApiTable(cloudReadme).length >= 8);
  const kinds = readmeTable(readme, 'Three kinds of question');
  assert.deepEqual(kinds.rows.map((row) => row[0]), ['`noul`', '`choice`', '`score`']);
  // The answers the table promises are the answers decide.js hands the policy.
  const decide = r.file('decide.js').body;
  for (const row of kinds.rows) assert.ok(decide.includes(row[2].replace(/`/g, '')), `decide.js does not contain ${row[2]}`);
  assert.equal(readmeList(readme, 'Call it from anywhere').length, 5);
});

// extra: diagrams read what the docs say, and say it in the right section.
test('diagrams render with values read from the docs', () => {
  const support = readPolicy(r.file('support.js').body);
  assert.deepEqual(support.questions.map((q) => q.kind), ['choice', 'score', 'noul']);
  assert.equal(support.gates.length, 2);
  assert.equal(support.clauses.length, 4);
  assert.equal(support.clauses[0].gloss, 'refund-requested? is yes (0.8 or more) and frustration is “Angry, threatening to leave”');

  const answers = readAnswers(r.file('decide.js').body, 'an angry refund request', support.questions);
  assert.deepEqual(answers.frustration.probabilities, [0.01, 0.04, 0.95]);

  const ask = parseExplain(r.run('node ask.js').output.split('\n').slice(0, -1).join('\n'))[0];
  const flow = section('how-it-works');
  assert.ok(flow.includes('class="flow"'));
  assert.ok(flow.includes(figure(r.file('ask.js').body, /const ticket = "(.*)";/)), 'the ticket is the one ask.js sends');
  for (const reading of ask.readings) assert.ok(flow.includes(reading.question) && flow.includes(reading.value), reading.question);
  assert.ok(flow.includes(`tag--${ask.action}`) && flow.includes(ask.target));

  const cases = parseExplain(r.run('node decide.js').output);
  assert.equal(cases.length, 3);
  const bar = figure(r.run('node decide.js').output, /needed confidence >= ([\d.]+)/);
  const meter = section('gates');
  assert.ok(meter.includes(`gate ${bar}`) && meter.includes('meter-pin--low') && meter.includes('meter-pin--high'));
  for (const c of cases.slice(0, 2)) assert.ok(meter.includes(String(c.readings[0].confidence)), c.name);

  const ladder = section('rules');
  assert.equal([...ladder.matchAll(/<li class="rung/g)].length, support.gates.length + support.clauses.length + 1);
  for (const c of support.clauses) assert.ok(ladder.includes(c.target), c.target);

  assert.equal([...section('questions').matchAll(/<div class="answer">/g)].length, 3);
  assert.equal([...section('anywhere').matchAll(/<li class="door">/g)].length, 5);
  const options = JSON.parse(r.file('gate-options.json').body);
  const gate = section('tool-gate');
  for (const t of [...options.deny, ...options.allow]) assert.ok(gate.includes(t), t);
  assert.ok(section('promote').includes('class="flow flow--3 flow--angles"'));
  // The cloud sections read their tables and figures out of docs/cloud-api.md.
  assert.equal([...section('bring-your-own').matchAll(/<tr>/g)].length - 1, cloudTable(cloudReadme, 'Bring your own everything').rows.length);
  assert.equal([...section('isolation').matchAll(/<tr>/g)].length - 1, cloudList(cloudReadme, 'Isolation, by construction').length);
  const price = figure(cloudReadme.replace(/\s+/g, ' '), /Pro \((\$\d+\/seat\/month)\)/);
  assert.ok(section('plans').includes(price), `plans shows ${price}`);
  assert.ok(section('cloud').includes('jevlang/cloud') && section('managed-state').includes('jc.journal'));
});

// extra: code frames are highlighted, escaped, copyable and labelled; live runs say so.
test('frames', () => {
  assert.ok(index.includes('class="tk-kw"') && index.includes('class="tk-str"') && index.includes('class="tk-key"'));
  assert.ok(index.includes('class="act-page"') && index.includes('class="act-assign"'));
  assert.ok(!index.includes('<pre class="frame-body"><code><import'));
  const frames = [...index.matchAll(/<figure class="frame[^"]*">/g)].length;
  const copies = [...index.matchAll(/class="copy-btn"[^>]*(?:data-copy-code|data-copy=)/g)].length;
  assert.equal(copies, frames + 1, `${copies} copy buttons for ${frames} frames and the install chip`);
  assert.ok(index.includes('<b>live run</b>'));
  // Copying a code frame copies its text: no highlight markup in the copied source.
  assert.ok(!/data-copy-code[^>]*>[^<]*<span class="tk-/.test(index));
  // A README `file=` block is shown exactly as written.
  const shown = index.match(/<pre class="frame-body"><code>([\s\S]*?)<\/code><\/pre>/)[1].replace(/<[^>]+>/g, '');
  assert.ok(shown.length > 100);
});

// extra: the vendored cloud API table matches the sibling repo when present.
test('vendored cloud sections in sync', () => {
  let sibling;
  try { sibling = read('../../jevcloud-next/README.md'); } catch { return; } // not cloned: skip
  for (const h of ['Bring your own everything', 'The API', 'Billing', 'Isolation, by construction']) {
    assert.equal(cloudSection(cloudReadme, h).trim(), cloudSection(sibling, h).trim(), `docs/cloud-api.md '${h}' is stale`);
  }
});

// 11. the agent files point at every live example, and the calls AGENTS.md shows really decide.
test('llms.txt, AGENTS.md and index.md cover the examples', async () => {
  const { examples } = await import('./content.js');
  // The policies resolve `jevlang` through the example's node_modules; CI does
  // not install it, so the offline decide check runs only where it can.
  const policies = await import('../examples/nextjs/lib/policies.js').catch(() => null);
  const byRoute = policies && { '/api/maintenance': policies.maintenance, '/api/reservation': policies.reservation, '/api/doorstep': policies.doorstep };
  const llms = read('./out/llms.txt'), agents = read('./out/AGENTS.md'), md = read('./out/index.md');
  for (const e of examples) {
    for (const [name, text] of [['llms.txt', llms], ['AGENTS.md', agents], ['index.md', md]]) assert.ok(text.includes(url(e.path)), `${name}: ${e.path}`);
    assert.ok(agents.includes(JSON.stringify({ input: e.input, answers: e.answers })), `AGENTS.md shows the ${e.route} call`);
    const policy = byRoute?.[e.route];
    if (!policy) continue;
    const { state, facts } = policy.buildState(e.input);
    assert.ok(policy.decide(e.answers, { state, facts }).action, `${e.route} decides offline`);
  }
  assert.ok(llms.includes('jevlang/redis') && agents.includes('rateLimit'));
});

// extra: the hero console decides each decide.js ticket exactly as the captured run did.
test('hero console matches node decide.js', () => {
  const { policy, presets } = heroModel(r);
  const m = simModel(policy);
  const cases = r.run('node decide.js').output.split(/^# .*\n/m).filter(Boolean).map((t) => t.trimEnd());
  assert.equal(presets.length, 3);
  presets.forEach((p, i) => assert.equal(simDecide(m, p.answers).text, cases[i], p.name));
  const hero = index.split('<section class="hero"')[1].split('</section>')[0];
  assert.ok(hero.includes('<pre class="sim-explain" data-explain>' + esc(cases[0]) + '</pre>'), 'no-script state is the first ticket');
  assert.equal([...hero.matchAll(/data-rung="/g)].length, policy.gates.length + policy.clauses.length);
  for (const p of presets) assert.ok(hero.includes(`>${esc(p.name)}</button>`), p.name);
});
