// Real-browser verification: serves site/out on a free port, measures the layout
// defects the design produces, cycles the theme, exercises the copy buttons,
// and screenshots the page (into site/shots, which is git-ignored).
//
//   bun site/verify.js
//
// Playwright comes from the sibling ../jevcloud checkout (a devDependency there).
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { createRequire } from 'node:module';
import { sections } from './content.js';

const require = createRequire(new URL('../../jevcloud/package.json', import.meta.url));
const { chromium } = require('playwright');

const root = new URL('./out/', import.meta.url).pathname;
const shots = new URL('./shots/', import.meta.url).pathname;
mkdirSync(shots, { recursive: true });

const types = { '.html': 'text/html', '.md': 'text/markdown', '.txt': 'text/plain', '.xml': 'application/xml', '.png': 'image/png' };
const server = createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/') p = '/index.html';
  if (!extname(p)) p += '.html';
  const file = normalize(join(root, p));
  if (!file.startsWith(root) || !existsSync(file)) { res.writeHead(404); res.end('nope'); return; }
  res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r)); // port 0: a free one, never one that is taken
const base = `http://127.0.0.1:${server.address().port}`;
console.log('serving on', base);

const browser = await chromium.launch();
const report = {};
const problems = [];
const expect = (ok, what) => { if (!ok) problems.push(what); return ok; };

// ---- desktop: layout defects, theme, copy ----
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark', permissions: ['clipboard-read', 'clipboard-write'] });
const page = await ctx.newPage();
const failed = [];
page.on('requestfailed', (r) => failed.push(r.url()));
page.on('pageerror', (e) => failed.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') failed.push(m.text()); });
await page.goto(base + '/');
await page.waitForTimeout(200);

report.h1 = await page.evaluate(() => {
  const h = document.querySelector('h1');
  const lines = Math.round(h.getBoundingClientRect().height / parseFloat(getComputedStyle(h).lineHeight));
  return { lines, fontSize: getComputedStyle(h).fontSize, letterSpacing: getComputedStyle(h).letterSpacing };
});
expect(report.h1.lines >= 2 && report.h1.lines <= 3, `h1 wraps onto ${report.h1.lines} lines`);

report.prose = await page.evaluate(() => [...document.querySelectorAll('.expl')].map((p) => Math.round(p.getBoundingClientRect().width / parseFloat(getComputedStyle(p).fontSize) / 0.5)).reduce((a, b) => Math.max(a, b), 0));
report.widths = await page.evaluate(() => ({
  shell: Math.round(document.querySelector('.shell').getBoundingClientRect().width),
  proseMax: Math.max(...[...document.querySelectorAll('.expl')].map((p) => Math.round(p.getBoundingClientRect().width))),
  demoMin: Math.min(...[...document.querySelectorAll('.section .demo > .frame, .section .demo > .diagram')].filter((f) => f.getClientRects().length > 0).map((f) => Math.round(f.getBoundingClientRect().width))),
}));
expect(report.widths.proseMax < report.widths.shell * 0.75, 'prose is capped narrower than the shell');
expect(report.widths.demoMin >= report.widths.shell - 2, 'demos run the full shell width');

report.frame = await page.evaluate(() => {
  const bar = getComputedStyle(document.querySelector('.frame-bar')).backgroundColor;
  const body = getComputedStyle(document.querySelector('.frame-body')).backgroundColor;
  return { bar, body, differ: bar !== body };
});
report.actions = await page.evaluate(() => {
  const kids = [...document.querySelector('.actions').children].map((c) => c.getBoundingClientRect());
  const mid = kids.map((k) => k.top + k.height / 2);
  return { controls: kids.length, oneRow: Math.max(...mid) - Math.min(...mid) < 2, widths: kids.map((k) => Math.round(k.width)), heights: kids.map((k) => Math.round(k.height)) };
});
expect(report.actions.controls === 3 && report.actions.oneRow, 'the action row is three controls on one row');
report.icons = await page.evaluate(() => [...document.querySelectorAll('.head-icons svg')].map((s) => getComputedStyle(s).fill));
expect(report.icons.every((f) => f !== 'rgb(0, 0, 0)'), 'no header icon renders black');
report.script = await page.evaluate(() => ({ js: document.documentElement.hasAttribute('data-js'), pref: document.documentElement.dataset.pref, theme: document.documentElement.dataset.theme }));

// theme: system -> dark -> light -> system; tokens flip; the choice persists under one key
const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
const state = () => page.evaluate(() => ({ pref: document.documentElement.dataset.pref, theme: document.documentElement.dataset.theme, label: document.getElementById('theme-toggle').getAttribute('aria-label'), stored: localStorage.getItem('jevlang-theme'), headBg: getComputedStyle(document.querySelector('.site-head')).backgroundColor }));
report.theme = { system: { ...(await state()), bg: await bg() } };
await page.click('#theme-toggle'); report.theme.dark = { ...(await state()), bg: await bg() };
await page.click('#theme-toggle'); await page.waitForTimeout(300); report.theme.light = { ...(await state()), bg: await bg() };
await (await page.$('.hero')).screenshot({ path: shots + 'hero-light.png' });
await (await page.$('.site-head')).screenshot({ path: shots + 'header-light.png' });
expect(report.theme.dark.bg !== report.theme.light.bg && report.theme.light.stored === 'light', 'the theme flips and persists');
await page.reload(); await page.waitForTimeout(150);
report.theme.afterReload = await state();
expect(report.theme.afterReload.pref === 'light' && report.theme.afterReload.theme === 'light', 'the stored theme survives a reload');
await page.click('#theme-toggle'); report.theme.backToSystem = { ...(await state()), bg: await bg() };
expect(report.theme.backToSystem.pref === 'system' && report.theme.backToSystem.stored === null, 'the third click returns to system');
await page.emulateMedia({ colorScheme: 'light' }); await page.waitForTimeout(100);
report.theme.osLight = { ...(await state()), bg: await bg() };
expect(report.theme.osLight.theme === 'light' && report.theme.osLight.bg === report.theme.light.bg, 'system mode follows the OS live');
await page.emulateMedia({ colorScheme: 'dark' }); await page.waitForTimeout(100);

// copy buttons copy the source as shown, and the command
const policyBody = readFileSync(new URL('../README.md', import.meta.url), 'utf8').match(/```js file=policy\.js\n([\s\S]*?)```/)[1];
await page.click('#quick-start .frame:has(.name:text-is("policy.js")) [data-copy-code]');
await page.waitForTimeout(150);
report.copy = { code: (await page.evaluate(() => navigator.clipboard.readText())).trimEnd() === policyBody.trimEnd(), feedback: await page.evaluate(() => !!document.querySelector('#quick-start [data-done]')) };
await page.click('.actions .copy-btn');
report.copy.install = await page.evaluate(() => navigator.clipboard.readText());
expect(report.copy.code && report.copy.install === 'bun add jevlang', 'copy buttons copy the shown text');

// the agent menu opens and the markdown it copies is served
await page.click('.actions details summary');
report.menu = await page.evaluate(() => [...document.querySelectorAll('.menu-items > *')].map((e) => e.textContent.trim().replace(/\s+/g, ' ').slice(0, 30)));
await (await page.$('.actions')).screenshot({ path: shots + 'menu-open.png' });
await page.click('.actions details summary');
const md = await page.request.get(base + '/index.md');
report.markdown = { status: md.status(), bytes: (await md.text()).length };
const og = await page.request.get(base + '/og.png');
report.og = { status: og.status(), type: og.headers()['content-type'] };
expect(md.status() === 200 && og.status() === 200 && report.og.type === 'image/png', 'index.md and og.png are served');

// every section id the model names exists and is reachable by anchor
report.anchors = [];
for (const id of sections.filter((s) => !s.flag).map((s) => s.id)) {  // flagged ones are hidden while the flag is off
  const found = await page.evaluate((i) => !!document.getElementById(i), id);
  report.anchors.push([id, found]);
  expect(found, `#${id} exists`);
}

// screenshots: header, hero, action row, first demo at 2x; sections; footer
await page.evaluate(() => window.scrollTo(0, 0));
const hi = await ctx.newPage();
await hi.close();
const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2, colorScheme: 'dark' });
const p2 = await ctx2.newPage();
await p2.goto(base + '/'); await p2.waitForTimeout(200);
await (await p2.$('.site-head')).screenshot({ path: shots + 'header-2x.png' });
await (await p2.$('.actions')).screenshot({ path: shots + 'actions-2x.png' });
const first = await p2.$('#how-it-works .diagram'); await first.scrollIntoViewIfNeeded();
await first.screenshot({ path: shots + 'first-demo-2x.png' });
await ctx2.close();

await page.evaluate(() => window.scrollTo(0, 0));
await (await page.$('.hero')).screenshot({ path: shots + 'hero-dark.png' });
for (const id of sections.filter((s) => !s.flag).map((s) => s.id)) {  // flagged ones are hidden while the flag is off
  const el = await page.$(`#${id}`);
  await el.scrollIntoViewIfNeeded(); await page.waitForTimeout(60);
  await el.screenshot({ path: `${shots}section-${id}.png` });
}
const foot = await page.$('.site-foot'); await foot.scrollIntoViewIfNeeded(); await foot.screenshot({ path: shots + 'footer.png' });
await page.goto(base + '/reference'); await page.waitForTimeout(150);
await page.screenshot({ path: shots + 'reference-top.png' });
report.pageErrors = failed;
expect(failed.length === 0, `console/page/network errors: ${failed.join('; ')}`);

// ---- no script: dark by default, the OS setting honoured, copy buttons absent ----
for (const scheme of ['dark', 'light']) {
  const c = await browser.newContext({ viewport: { width: 1280, height: 900 }, javaScriptEnabled: false, colorScheme: scheme });
  const p = await c.newPage(); await p.goto(base + '/');
  const r = await p.evaluate(() => ({ bg: getComputedStyle(document.body).backgroundColor, copyDisplay: getComputedStyle(document.querySelector('.copy-btn')).display }));
  report[`noScript_${scheme}`] = r;
  expect(r.copyDisplay === 'none', `no script: copy buttons hidden (${scheme})`);
  await c.close();
}
expect(report.noScript_dark.bg !== report.noScript_light.bg, 'no script: the OS theme still switches the page');

// ---- phone: no horizontal overflow on either page ----
const mob = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const m = await mob.newPage();
report.mobile = {};
for (const path of ['/', '/reference']) {
  await m.goto(base + path); await m.waitForTimeout(150);
  const o = await m.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: innerWidth }));
  report.mobile[path] = o;
  expect(o.scrollWidth === o.innerWidth, `${path} overflows at 390px (${o.scrollWidth})`);
}
await m.goto(base + '/'); await m.waitForTimeout(150);
report.mobile.header = await m.evaluate(() => ({ icons: [...document.querySelectorAll('.head-icons a')].length, iconsVisible: document.querySelector('.head-icons').getBoundingClientRect().right <= 390, nav: getComputedStyle(document.querySelector('.site-nav')).display, toggle: !!document.getElementById('theme-toggle').offsetWidth }));
report.mobile.h1 = await m.evaluate(() => ({ size: getComputedStyle(document.querySelector('h1')).fontSize, fits: document.querySelector('h1').getBoundingClientRect().right <= 390 }));
expect(report.mobile.header.iconsVisible && report.mobile.header.toggle && report.mobile.header.nav === 'none', 'phone header: icons and toggle stay, text links collapse');
await m.screenshot({ path: shots + 'mobile-hero.png' });
await m.screenshot({ path: shots + 'mobile-full.png', fullPage: true });
await mob.close();

await browser.close();
server.close();
console.log(JSON.stringify(report, null, 1));
if (problems.length) { console.error('\nPROBLEMS:\n- ' + problems.join('\n- ')); process.exitCode = 1; } else console.log('\nall checks passed');
