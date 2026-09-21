// Layout audit: the defect checks from the spec, asserted in a real browser
// (this session's model cannot view screenshots, so we measure instead).
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../jevcloud/package.json', import.meta.url));
const { chromium } = require('playwright');

const root = new URL('./out/', import.meta.url).pathname;
const types = { '.html': 'text/html', '.png': 'image/png', '.txt': 'text/plain', '.xml': 'application/xml', '.md': 'text/markdown' };
const server = createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/') p = '/index.html';
  if (!extname(p)) p += '.html';
  const file = normalize(join(root, p));
  createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.goto(base + '/');

const report = {};
report.h1Lines = await page.evaluate(() => {
  const r = document.querySelector('h1').getClientRects().length;
  return { wraps: r, width: Math.round(document.querySelector('h1').getBoundingClientRect().width), maxWidth: Math.round(parseFloat(getComputedStyle(document.querySelector('h1')).maxWidth)) };
});
report.proseCap = await page.evaluate(() => {
  const p = document.querySelector('.expl');
  const ch = parseFloat(getComputedStyle(p).fontSize);
  return Math.round(p.getBoundingClientRect().width / ch);
});
report.widest = await page.evaluate(() => {
  const frames = document.querySelector('.frame').getBoundingClientRect().width;
  const shell = document.querySelector('.shell').getBoundingClientRect().width;
  return { frame: Math.round(frames), shell: Math.round(shell) };
});
report.frameBarVsBody = await page.evaluate(() => {
  const bar = getComputedStyle(document.querySelector('.frame-bar')).backgroundColor;
  const body = getComputedStyle(document.querySelector('.frame-body')).backgroundColor;
  return { bar, body, barDarker: bar !== body };
});
report.actionRow = await page.evaluate(() => {
  const row = document.querySelector('.actions').getBoundingClientRect();
  const kids = [...document.querySelector('.actions').children].map((c) => ({ w: Math.round(c.getBoundingClientRect().width), h: Math.round(c.getBoundingClientRect().height) }));
  const heights = new Set(kids.map((k) => k.h));
  return { oneRow: heights.size === 1 && kids[0].h < 60, kids, rowW: Math.round(row.width) };
});
report.brandMarkInk = await page.evaluate(() => {
  const svg = document.querySelector('.hero .mark svg rect');
  return getComputedStyle(svg).fill;
});
report.iconFills = await page.evaluate(() => [...document.querySelectorAll('.head-icons svg')].map((s) => getComputedStyle(s).fill));
report.heroAboveFold = await page.evaluate(() => Math.round(document.querySelector('.hero').getBoundingClientRect().height));
report.firstSectionTop = await page.evaluate(() => Math.round(document.querySelector('#write-the-policy').getBoundingClientRect().top + window.scrollY));

// theme flip
const darkPaper = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
await page.click('#theme-toggle');
const d2 = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
await page.click('#theme-toggle');
const lightPaper = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
const headerBg = await page.evaluate(() => getComputedStyle(document.querySelector('.site-head')).backgroundColor);
report.theme = { darkPaper, mid: d2, lightPaper, headerOnLight: headerBg, flips: darkPaper !== lightPaper };

// og.png served
const og = await page.request.get(base + '/og.png');
report.og = { status: og.status(), type: og.headers()['content-type'] };

// mobile: header icons visible, nav collapsed
const mob = await browser.newPage({ viewport: { width: 390, height: 844 } });
await mob.goto(base + '/');
report.mobileIcons = await mob.evaluate(() => {
  const icons = document.querySelector('.head-icons');
  const r = icons.getBoundingClientRect();
  const nav = getComputedStyle(document.querySelector('.site-nav')).display;
  return { visible: r.width > 100 && r.right <= 390, navDisplay: nav, toggleVisible: !!document.getElementById('theme-toggle').offsetWidth };
});
report.mobileH1 = await mob.evaluate(() => {
  const h = document.querySelector('h1');
  return { size: getComputedStyle(h).fontSize, wraps: h.getClientRects().length, fits: h.getBoundingClientRect().right <= 391 };
});

await browser.close();
server.close();
console.log(JSON.stringify(report, null, 1));
