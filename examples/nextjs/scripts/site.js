// The jevlang.sh landing page, reference and agent files are built by
// site/build.js into site/out. This app serves them: they are copied into
// public/, and next.config.mjs rewrites / and /reference to the two pages.
// It also renders the site's shared chrome (header with the Examples
// dropdown, footer, theme script, styles) to app/_kit/chrome.json, which
// app/layout.js wraps every example in. Runs before `next dev` and `next build`.
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const out = new URL('../../../site/out/', import.meta.url);
const pub = new URL('../public/', import.meta.url);

const build = spawnSync(process.execPath, ['site/build.js'], { cwd: root, stdio: 'inherit' });
if (build.status !== 0) process.exit(build.status ?? 1);
rmSync(pub, { recursive: true, force: true });
mkdirSync(pub, { recursive: true });
cpSync(out, pub, { recursive: true });
console.log('site copied to public/');

const { header, footer, bootScript } = await import(new URL('../../../site/render.js', import.meta.url));
const { chromeCss } = await import(new URL('../../../site/styles.js', import.meta.url));
writeFileSync(new URL('../app/_kit/chrome.json', import.meta.url), JSON.stringify({
  // Every page of this app is an example, so the Examples item is current.
  header: header('/examples'),
  footer: footer(),
  css: chromeCss,
  boot: bootScript.replace(/^<script>|<\/script>$/g, ''),
}));
console.log('site chrome written to app/_kit/chrome.json');
