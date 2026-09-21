// Build: reads the docs, resolves references, writes site/out deterministically.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { renderLanding, renderReference, llmsText, agentsMd, pageMarkdown, sitemap, robots } from './render.mjs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const readme = read('../README.md');
const cloudReadme = read('../../jevcloud/README.md');

const outDir = new URL('./out/', import.meta.url);
mkdirSync(outDir, { recursive: true });

const files = {
  'index.html': renderLanding({ readme, cloudReadme }),
  'reference.html': renderReference({ readme }),
  'index.md': pageMarkdown(),
  'llms.txt': llmsText({ readme }),
  'AGENTS.md': agentsMd({ readme }),
  'sitemap.xml': sitemap(),
  'robots.txt': robots(),
};

for (const [name, content] of Object.entries(files)) {
  writeFileSync(new URL(name, outDir), content);
}
console.log(`wrote ${Object.keys(files).length} files to site/out`);
