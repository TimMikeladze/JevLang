// Screenshots: the OG card at exactly 1200x630, saved as site/out/og.png.
// Uses Playwright from the sibling jevcloud checkout (devDependency there).
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';

const require = createRequire(new URL('../../jevcloud/package.json', import.meta.url));
const { chromium } = require('playwright');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
await page.goto(new URL('./card.html', import.meta.url).toString());
await page.waitForTimeout(200);
const png = await page.screenshot({ type: 'png' });
writeFileSync(new URL('./out/og.png', import.meta.url), png);
console.log(`og.png ${png.length} bytes`);
await browser.close();
