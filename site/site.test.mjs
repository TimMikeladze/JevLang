// Site tests: references resolve, figures match, pages self-contained and
// current, metadata honest, artefacts present. Run: node --test site/site.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { sections, boundaries, start, links, meta } from './content.mjs';
import { makeResolver, figure, renderLanding, renderReference, modulesTable, cloudApiTable, version } from './render.mjs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const readme = read('../README.md');
const cloudReadme = read('../docs/cloud-api.md');
const index = read('./out/index.html');
const reference = read('./out/reference.html');

// 1 + 2. every reference resolves to exactly one block; every figure matches.
test('references resolve and figures match', () => {
  const r = makeResolver(readme);
  for (const s of sections) for (const d of s.demos) {
    if (d.ref?.kind === 'terminal') {
      const block = r.terminal(d.ref.cmd);
      for (const f of d.figures ?? []) figure(block, f.from);
    }
    if (d.ref?.kind === 'snippet') r.snippet(d.ref.marker);
  }
  const verify = r.terminal(start.panels[1].ref.cmd);
  for (const f of start.panels[1].figures) figure(verify, f.from);
  assert.ok(figure(verify, /pass (\d+)/) === '97');
});

// 3. self-contained pages; theme machinery present.
test('pages are self-contained', () => {
  for (const page of [index, reference]) {
    assert.doesNotMatch(page, /<(?:link[^>]*rel="(?:stylesheet|preload|icon)"|script|img)[^>]+(?:src|href)="https?:/);
    const scripts = [...page.matchAll(/<script[^>]*src=/g)];
    assert.equal(scripts.length, 0);
    const inline = [...page.matchAll(/<script(?:\s[^>]*)?>[\s\S]*?<\/script>/g)];
    const nonLd = inline.filter((m) => !m[0].includes('application/ld+json'));
    assert.equal(nonLd.length, 1, 'exactly one non-JSON-LD script');
    assert.ok(nonLd[0][0].length < 2500, 'boot script under size cap');
    assert.match(page, /:root\[data-theme="?light"?\]/);
    assert.match(page, /prefers-color-scheme:\s*light/);
    assert.match(page, /color-scheme:\s*dark/);
    assert.match(page, /jevlang-theme/);
  }
  assert.match(index, /id="theme-toggle"[^>]*aria-label="Theme: system\. Click to change"/);
});

// contrast: OKLCH -> sRGB -> WCAG ratio
function oklchToRgb(L, C, h) {
  const hr = (h * Math.PI) / 180;
  const a = C * Math.cos(hr), b = C * Math.sin(hr);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
  const lin = [
    +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ].map((c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055));
  return lin.map((c) => Math.min(1, Math.max(0, c)));
}
const lum = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const ratio = (fg, bg) => { const [a, c] = [lum(fg), lum(bg)].sort((x, y) => y - x); return (a + 0.05) / (c + 0.05); };
const gray = (L) => oklchToRgb(L / 100, 0, 0);

test('body and soft contrast >= 4.5 in both schemes', () => {
  for (const [paper, body, soft] of [[12.5, 78, 62], [99, 27, 30]]) {
    assert.ok(ratio(gray(body), gray(paper)) >= 4.5, `body on ${paper}%`);
    assert.ok(ratio(gray(soft), gray(paper)) >= 4.5, `soft on ${paper}%`);
  }
});

// 4. markup in the source doc is escaped, never executed.
test('source markup escaped', () => {
  assert.ok(reference.includes('&lt;this repo&gt;'));
  assert.ok(!reference.includes('<this repo>'));
});

// 5. committed HTML equals a fresh render.
test('committed HTML is current', () => {
  assert.equal(index, renderLanding({ readme, cloudReadme }));
  assert.equal(reference, renderReference({ readme }));
});

// 6. every source section reaches the reference page; anchors land.
test('reference completeness and anchors', () => {
  for (const h2 of readme.matchAll(/^## (.+)$/gm)) {
    const slug = h2[1].toLowerCase().replace(/[^\w]+/g, '-').replace(/^-|-$/g, '');
    assert.ok(reference.includes(`id="${slug}"`), `missing section ${slug}`);
  }
  for (const s of sections) if (s.doc) {
    const slug = s.doc.toLowerCase().replace(/[^\w]+/g, '-').replace(/^-|-$/g, '');
    assert.ok(index.includes(`/reference#${slug}`) && reference.includes(`id="${slug}"`), `anchor ${slug}`);
  }
});

// 7. head metadata.
test('head metadata', () => {
  const head = index.split('</head>')[0];
  const title = head.match(/<title>([^<]+)<\/title>/)[1];
  assert.equal(title, 'JevLang — a policy engine for prompt-sized decisions');
  const desc = head.match(/name="description" content="([^"]+)"/)[1];
  assert.ok(desc.length <= 160 && desc.endsWith('.'));
  assert.match(head, /rel="canonical" href="https:\/\/jevlang\.sh\/"/);
  assert.ok(!head.includes('index.html'));
  for (const p of ['og:title', 'og:description', 'og:url', 'og:type', 'og:site_name']) assert.ok(head.includes(p));
  for (const p of ['og:image:width', 'og:image:height', 'og:image:type', 'og:image:alt']) assert.ok(head.includes(p));
  assert.ok(head.includes('twitter:card'));
  const ld = JSON.parse(head.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
  assert.equal(ld.name, 'JevLang');
  assert.equal(ld.softwareVersion, version);
  assert.equal(ld.applicationCategory, 'DeveloperApplication');
});

// 8. capability sections well-formed.
test('capability sections', () => {
  for (const s of sections) {
    const sec = index.split(`<section id="${s.id}"`)[1]?.split('</section>')[0];
    assert.ok(sec, s.id);
    assert.ok(sec.includes('<h2'));
    const expl = sec.match(/<p class="expl">([\s\S]*?)<\/p>/)[1].replace(/ <a href="\/reference#[^>]*>[^<]*<\/a>$/, '');
    const sentences = expl.replace(/<[^>]+>/g, '').split(/(?<=\.)\s/).filter(Boolean).length;
    assert.ok(sentences >= 1 && sentences <= 3, `${s.id}: ${sentences} sentences`);
    assert.ok(expl.includes('<code>'), `${s.id}: no inline code`);
  }
});

// 9. artefacts exist; sitemap paths resolve to produced files.
test('artefacts and sitemap', () => {
  for (const f of ['llms.txt', 'AGENTS.md', 'sitemap.xml', 'robots.txt', 'index.md']) {
    assert.ok(existsSync(new URL(`./out/${f}`, import.meta.url)), f);
  }
  const sm = read('./out/sitemap.xml');
  for (const loc of sm.matchAll(/<loc>([^<]+)<\/loc>/g)) {
    const path = new URL(loc[1]).pathname.replace(/\/$/, '');
    const file = path === '' ? 'index.html' : path.replace(/^\//, '') + '.html';
    assert.ok(existsSync(new URL(`./out/${file}`, import.meta.url)), `${loc[1]} -> ${file}`);
  }
  assert.match(read('./out/robots.txt'), /Sitemap: https:\/\/jevlang\.sh\/sitemap\.xml/);
});

// 10. og.png exists and really is 1200x630.
test('og.png dimensions', () => {
  const png = readFileSync(new URL('./out/og.png', import.meta.url));
  assert.equal(png.readUInt32BE(16), 1200);
  assert.equal(png.readUInt32BE(20), 630);
});

// 11. links appear as the model says.
test('link table honoured', () => {
  const headerPart = index.split('</header>')[0];
  const iconLabels = [...headerPart.matchAll(/aria-label="([^"]+)"[^>]*>/g)].map((m) => m[1]).filter((l) => links.some((x) => x.label === l));
  assert.deepEqual(iconLabels, ['JevLang on GitHub', 'linesofcode on X', 'Tim Mikeladze on LinkedIn']);
  const footerPart = index.split('<footer')[1];
  const footerIcons = [...footerPart.matchAll(/aria-label="([^"]+)"/g)].map((m) => m[1]).filter((l) => links.some((x) => x.label === l));
  assert.deepEqual(footerIcons, ['JevLang on GitHub', 'linesofcode on X', 'Tim Mikeladze on LinkedIn', 'linesofcode on Discord']);
  assert.ok(headerPart.includes('href="https://github.com/TimMikeladze/JevLang"'));
  assert.ok(index.includes('href="https://x.com/linesofcode"'));
  assert.ok(index.includes('href="https://www.linkedin.com/in/tim-mikeladze"'));
  assert.ok(index.includes('href="https://discord.com/users/linesofcode"'));
});

// extra: enumeration tables populated from the docs.
test('tables read from docs', () => {
  assert.ok(modulesTable(readme).length >= 8);
  assert.ok(cloudApiTable(cloudReadme).length >= 8);
});

// extra: diagrams render inside their sections, with values read from runs.
test('diagrams render with captured values', () => {
  const r = makeResolver(readme);
  for (const s of sections) for (const d of s.demos) {
    if (d.type !== 'diagram') continue;
    const sec = index.split(`<section id="${s.id}"`)[1].split('</section>')[0];
    assert.ok(sec.includes('<figure class="diagram'), `${s.id}: ${d.name} missing`);
    if (d.ref?.kind === 'terminal') {
      const block = r.terminal(d.ref.cmd);
      for (const re of Object.values(d.data ?? {})) figure(block, re);
    }
  }
  const routed = r.terminal('node examples/ticket-router.mjs');
  const bar = figure(routed, /needed confidence >= ([\d.]+)/);
  assert.ok(index.includes(`gate(department, ${bar}, escalate('`));
  const gated = r.terminal('node examples/tool-gate.mjs');
  assert.ok(index.includes(`effect=destructive @ ${figure(gated, /effect=\w+ @ ([\d.]+)/)}`));
});

// extra: syntax highlighting is applied and stays escaped.
test('code frames highlighted and escaped', () => {
  assert.ok(index.includes('class="tk-kw"'));
  assert.ok(index.includes('class="tk-str"'));
  assert.ok(index.includes('class="tk-key"'));
  assert.ok(index.includes('class="act-assign"') || index.includes('class="act-escalate"'));
  assert.ok(!index.includes('<pre class="frame-body"><import'));
});

// extra: the vendored cloud API table matches the sibling repo when present.
test('vendored cloud API table in sync', () => {
  let sibling;
  try { sibling = read('../../jevcloud/README.md'); } catch { return; } // not cloned: skip
  assert.deepEqual(cloudApiTable(cloudReadme), cloudApiTable(sibling));
});
