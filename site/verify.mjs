// Visual verification: serves site/out on a free port, screenshots the page at
// desktop and 390px, checks overflow, cycles the theme, shoots the OG card.
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../jevcloud/package.json', import.meta.url));
const { chromium } = require('playwright');

const root = new URL('./out/', import.meta.url).pathname;
mkdirSync(new URL('./shots/', import.meta.url).pathname, { recursive: true });

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
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;
console.log('serving on', base);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.goto(base + '/');
await page.waitForTimeout(150);

const shot = (name) => page.screenshot({ path: `site/shots/${name}.png` });
const clipEl = async (sel) => { const b = await (await page.$(sel)).boundingBox(); return { clip: b }; };

// full page (long) — captureBeyondViewport
await page.screenshot({ path: 'site/shots/full-landing.png', fullPage: true });
void shot;
// header, action row, first demo at 2x scale
const page2 = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
await page2.goto(base + '/');
await page2.waitForTimeout(150);
await (await page2.$('.site-head')).screenshot({ path: 'site/shots/header-2x.png' });
await (await page2.$('.actions')).screenshot({ path: 'site/shots/actions-2x.png' });
{
  const el = await page2.$('#write-the-policy');
  await el.scrollIntoViewIfNeeded();
  await page2.waitForTimeout(100);
  const b = await el.boundingBox();
  await page2.screenshot({ path: 'site/shots/first-demo-2x.png', clip: b });
}
await page2.close();

// sections + footer at 1x
for (const id of ['write-the-policy', 'uncertainty-escalates', 'guard-an-agents-tools', 'everything-else-in-the-box', 'same-engine-hosted', 'boundaries', 'start']) {
  const el = await page.$(`#${id}`);
  await el.scrollIntoViewIfNeeded();
  await page.waitForTimeout(80);
  const b = await el.boundingBox();
  await page.screenshot({ path: `site/shots/section-${id}.png`, clip: b });
}
{
  const el = await page.$('.site-foot');
  await el.scrollIntoViewIfNeeded();
  await page.waitForTimeout(80);
  await el.screenshot({ path: 'site/shots/footer.png' });
}

// dark then light hero
{
  const el = await page.$('.hero');
  await el.scrollIntoViewIfNeeded();
  await el.screenshot({ path: 'site/shots/hero-dark.png' });
  await page.click('#theme-toggle'); // system -> dark
  await page.click('#theme-toggle'); // dark -> light
  await page.waitForTimeout(150);
  await el.screenshot({ path: 'site/shots/hero-light.png' });
  await (await page.$('.site-head')).screenshot({ path: 'site/shots/header-light.png' });
}
const themeNow = await page.evaluate(() => document.documentElement.dataset.theme);
console.log('theme after two clicks:', themeNow);

// reference page
await page.goto(base + '/reference');
await page.waitForTimeout(150);
await page.screenshot({ path: 'site/shots/reference-top.png' });

// mobile 390x844: overflow check
const mob = await browser.newPage({ viewport: { width: 390, height: 844 } });
await mob.goto(base + '/');
await mob.waitForTimeout(150);
const overflow = await mob.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
console.log('390px scrollWidth/innerWidth:', overflow.sw, overflow.iw, overflow.sw <= overflow.iw ? 'OK' : 'HORIZONTAL OVERFLOW');
await mob.screenshot({ path: 'site/shots/mobile-hero.png' });
await mob.screenshot({ path: 'site/shots/mobile-full.png', fullPage: true });
await mob.goto(base + '/reference');
await mob.waitForTimeout(150);
const overflowRef = await mob.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
console.log('reference 390px:', overflowRef.sw, overflowRef.iw, overflowRef.sw <= overflowRef.iw ? 'OK' : 'HORIZONTAL OVERFLOW');
await mob.close();

// og card at feed size check happens on the png itself; report bytes
await browser.close();
server.close();
console.log('done');
