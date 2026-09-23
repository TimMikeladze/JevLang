// Screenshots: every OG card in cards.js at exactly 1200x630, into site/out.
// Uses Playwright from the sibling jevcloud checkout (devDependency there).
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { cards, cardHtml } from './cards.js';

const require = createRequire(new URL('../../jevcloud/package.json', import.meta.url));
const { chromium } = require('playwright');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
for (const card of cards) {
  await page.setContent(cardHtml(card));
  await page.waitForTimeout(100);
  const png = await page.screenshot({ type: 'png' });
  writeFileSync(new URL(`./out/${card.file}`, import.meta.url), png);
  console.log(`${card.file} ${png.length} bytes`);
}
await browser.close();
