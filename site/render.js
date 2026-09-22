// Renderer: parses the source docs, resolves references, emits HTML, the head
// metadata and the sibling artefacts. No copy lives here (icons and markup do).
import { readFileSync } from 'node:fs';
import { css } from './styles.js';
import { sections as contentSections, asides, boundaries, start, links, nav, footerColumns, credit, meta, origin, repo, cloudRepo, copyrightYear, agentsMistakes, agentsGateNote } from './content.js';
import { esc, tag, isAction, readPolicy, readAnswers, parseExplain, decisionFlow, lifecycle, answerShapes, gateMeter, ruleLadder, toolLadder, doors } from './diagrams.js';

export const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
export const year = copyrightYear;

// One rule for every absolute URL: the origin, a trailing slash on the home
// page, and clean paths (no .html) for everything else.
export const url = (path) => (path === '/' ? origin + '/' : origin + path.replace(/\.html$/, ''));

// ---------- doc parsing ----------

// Every fenced block: its language, its `file=` attribute, its body.
export function readBlocks(md) {
  const out = [];
  const re = /^```([\w-]*)([^\n]*)\n([\s\S]*?)^```[ \t]*$/gm;
  let m;
  while ((m = re.exec(md))) out.push({ lang: m[1], file: /(?:^|\s)file=(\S+)/.exec(m[2])?.[1] ?? null, body: m[3].replace(/\n$/, '') });
  return out;
}

export const fences = (md) => readBlocks(md).map((b) => b.body);

// A captured run: `$ command  # comment` then the output.
const capture = (body) => {
  const [first, ...rest] = body.split('\n');
  const [command, comment = ''] = first.slice(2).split('  #');
  const c = comment.trim();
  return { command, comment: c, live: c.startsWith('live'), output: rest.join('\n'), body };
};

export function makeResolver(md) {
  const blocks = readBlocks(md);
  const one = (hits, what) => {
    if (hits.length !== 1) throw new Error(`${what}: expected 1 block, found ${hits.length}`);
    return hits[0];
  };
  // terminal(cmd) matches a `$ command` block whose command contains cmd.
  const terminal = (cmd) => one(blocks.filter((b) => b.body.startsWith('$ ') && capture(b.body).command.includes(cmd)), `terminal(${cmd})`).body;
  const snippet = (marker) => one(blocks.filter((b) => b.body.includes(marker)), `snippet(${marker})`).body;
  const file = (name) => one(blocks.filter((b) => b.file === name), `file(${name})`);
  return { terminal, snippet, file, run: (cmd) => capture(terminal(cmd)) };
}

// A figure is read out of a block by regex, never retyped.
export function figure(block, re) {
  const m = re.exec(block);
  if (!m) throw new Error(`figure ${re} not found in block`);
  return m[1] ?? m[0];
}

const section = (md, heading) => {
  const at = md.search(new RegExp(`^## ${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  if (at < 0) throw new Error(`README has no section '${heading}'`);
  return md.slice(at).split(/^## /m)[1].split('\n').slice(1).join('\n');
};

// The first table under a README heading -> { head, rows } of raw cells.
export function readmeTable(md, heading) {
  const lines = section(md, heading).split('\n').filter((l) => l.startsWith('|'));
  const cells = (l) => l.split('|').slice(1, -1).map((c) => c.trim());
  if (lines.length < 3) throw new Error(`section '${heading}' has no table`);
  return { head: cells(lines[0]), rows: lines.slice(2).map(cells) };
}

// The bullets under a heading: `- **Label** — text` -> { label, call, text }.
export function readmeList(md, heading) {
  const items = [...section(md, heading).matchAll(/^- \*\*(.+?)\*\* — (.+)$/gm)].map((m) => {
    const call = /^`([^`]+)`/.exec(m[2])?.[1];
    if (!call) throw new Error(`list item '${m[1]}' does not start with a call`);
    const rest = m[2].replace(/^`[^`]+`[,;:\s]*/, '');
    return { label: m[1], call, text: inlineMd(rest.charAt(0).toUpperCase() + rest.slice(1)) };
  });
  if (items.length < 3) throw new Error(`section '${heading}' has only ${items.length} bullets`);
  return items;
}

// Parse the README's module bullets: - **`jevlang/x`** — description
export function modulesTable(readme) {
  const sec = readme.split(/^## Everything else in the box$/m)[1]?.split(/^## /m)[0] ?? '';
  const rows = [];
  for (const m of sec.matchAll(/^- \*\*([^*]*?)\*\* — ([\s\S]*?)(?=\n- |\n\n)/gm)) rows.push([m[1].replace(/`/g, ''), m[2].replace(/\n\s+/g, ' ').trim()]);
  if (rows.length < 6) throw new Error(`modulesTable: only ${rows.length} rows`);
  return rows;
}

// Parse the jevcloud README API table.
export function cloudApiTable(cloudReadme) {
  const sec = cloudReadme.split(/^## The API$/m)[1]?.split(/^## /m)[0] ?? '';
  const rows = [];
  for (const m of sec.matchAll(/^\| `([^`]+)` \| (.+) \|$/gm)) rows.push([m[1], m[2]]);
  if (rows.length < 8) throw new Error(`cloudApiTable: only ${rows.length} rows`);
  return rows;
}

// ---------- inline markdown ----------

export function inlineMd(text) {
  let s = esc(text).replace(/\(REPO/g, `(${repo}`).replace(/\(CLOUDREPO/g, `(${cloudRepo}`);
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, h) => `<a href="${h}">${t}</a>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`);
  return s;
}

// Minimal markdown for the reference page (README subset).
export function markdownHtml(md) {
  const out = [];
  const lines = md.split('\n');
  let i = 0, inCode = false, lang = '', codeBuf = [], list = null, item = null, table = null, para = [];
  const flushPara = () => { if (para.length) { out.push(`<p>${inlineMd(para.join(' '))}</p>`); para = []; } };
  const flushItem = () => { if (item !== null) { out.push(`<li>${inlineMd(item)}</li>`); item = null; } };
  const flushList = () => { flushItem(); if (list) { out.push(`</${list}>`); list = null; } };
  const flushTable = () => {
    if (table) {
      const [head, ...rows] = table;
      out.push('<div class="tablewrap"><table><thead><tr>' + head.map((c) => `<th>${inlineMd(c)}</th>`).join('') + '</tr></thead><tbody>'
        + rows.map((r) => '<tr>' + r.map((c, i) => `<td${head.length > 2 ? ` data-label="${esc(head[i])}"` : ''}>${inlineMd(c)}</td>`).join('') + '</tr>').join('') + '</tbody></table></div>');
      table = null;
    }
  };
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('```')) {
      flushPara(); flushList(); flushTable();
      if (!inCode) { inCode = true; codeBuf = []; lang = line.slice(3).split(' ')[0]; } else {
        inCode = false;
        const code = codeBuf.join('\n');
        out.push(`<pre><code>${code.startsWith('$ ') ? outputHtml(code) : highlightCode(code, lang)}</code></pre>`);
      }
      i++; continue;
    }
    if (inCode) { codeBuf.push(line); i++; continue; }
    if (!line.trim()) { flushPara(); flushList(); flushTable(); i++; continue; }
    if (/^\|/.test(line)) {
      flushPara(); flushList();
      const cells = line.split('|').slice(1, -1).map((c) => c.trim());
      if (/^\|[-| :]+\|$/.test(line)) { /* separator */ }
      else if (!table) table = [cells];
      else table.push(cells);
      i++; continue;
    }
    flushTable();
    const h = line.match(/^(#{1,4}) (.+)$/);
    if (h) { flushPara(); flushList(); out.push(`<h${h[1].length} id="${slug(h[2])}">${inlineMd(h[2])}</h${h[1].length}>`); i++; continue; }
    const li = line.match(/^[-*] (.+)$/);
    if (li) {
      flushPara();
      if (list !== 'ul') { flushList(); out.push('<ul>'); list = 'ul'; }
      flushItem(); item = li[1]; i++; continue;
    }
    // A wrapped bullet: an indented line continues the item above it.
    if (list && item !== null && /^\s{2,}\S/.test(line)) { item += ' ' + line.trim(); i++; continue; }
    flushList();
    para.push(line.trim());
    i++;
  }
  flushPara(); flushList(); flushTable();
  return out.join('\n');
}

export const slug = (s) => s.toLowerCase().replace(/[^\w]+/g, '-').replace(/^-|-$/g, '');

// ---------- icons ----------

const glyph = (d) => `<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`;
const brand = (d) => `<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="${d}"/></svg>`;

const icons = {
  book: () => glyph('M4 19.5A2.5 2.5 0 0 1 6.5 17H20M4 19.5A2.5 2.5 0 0 1 6.5 22H20V2H6.5A2.5 2.5 0 0 0 4 4.5v15z'),
  copy: () => glyph('M20 9h-9a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2zM5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1'),
  chevron: () => glyph('M6 9l6 6 6-6'),
  github: () => brand('M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12'),
  x: () => brand('M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z'),
  linkedin: () => brand('M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z'),
  discord: () => brand('M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z'),
  sun: () => glyph('M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42'),
  moon: () => glyph('M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z'),
  monitor: () => glyph('M4 3h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM8 21h8M12 17v4'),
};

export function icon(name) {
  const f = icons[name];
  if (!f) throw new Error(`unknown icon: ${name}`);
  return f();
}

// The mark follows the theme: a raised tile with the glyph in ink. The favicon
// below is a data URI, which cannot read the page's tokens, so it stays dark.
export const productMark = `<svg aria-hidden="true" width="44" height="44" viewBox="0 0 48 48"><rect class="mark-tile" x=".5" y=".5" width="47" height="47" rx="11"/><path class="mark-glyph" d="M30 12v16.5c0 4.5-3 7.5-7.5 7.5S15 33 15 29.5" fill="none" stroke-width="3.4" stroke-linecap="round"/></svg>`;

export const favicon = `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" rx="11" fill="#1c1c1c"/><path d="M30 12v16.5c0 4.5-3 7.5-7.5 7.5S15 33 15 29.5" fill="none" stroke="#f7f7f7" stroke-width="3.4" stroke-linecap="round"/></svg>`)}`;

// ---------- script ----------

// The one script: it resolves the stored theme before first paint (it sits in
// <head>), cycles system, dark, light on the toggle, and copies text. With it
// removed the page is dark, follows the OS through the media query, and only
// the copy buttons (which exist only when this runs) go away.
export const bootScript = `<script>
(function(){
var K='jevlang-theme',r=document.documentElement,mq=matchMedia('(prefers-color-scheme: dark)');
function saved(){try{var s=localStorage.getItem(K);return s==='dark'||s==='light'?s:'system'}catch(e){return'system'}}
function set(p){r.dataset.pref=p;r.dataset.theme=p==='system'?(mq.matches?'dark':'light'):p;var b=document.getElementById('theme-toggle');if(b)b.setAttribute('aria-label','Theme: '+p+'. Click to change')}
set(saved());r.dataset.js='';
document.addEventListener('DOMContentLoaded',function(){set(r.dataset.pref)});
mq.addEventListener('change',function(){if(r.dataset.pref==='system')set('system')});
document.addEventListener('click',function(e){
var t=e.target.closest('#theme-toggle');
if(t){var n={system:'dark',dark:'light',light:'system'}[r.dataset.pref];try{n==='system'?localStorage.removeItem(K):localStorage.setItem(K,n)}catch(x){}set(n);return}
var c=e.target.closest('[data-copy],[data-copy-code],[data-copy-markdown]');
if(!c||!navigator.clipboard)return;
var f=c.hasAttribute('data-copy-markdown')?fetch('/index.md').then(function(x){return x.text()}):Promise.resolve(c.hasAttribute('data-copy')?c.dataset.copy:c.closest('figure').querySelector('.frame-body').textContent);
f.then(function(v){return navigator.clipboard.writeText(v)}).then(function(){c.dataset.done='';setTimeout(function(){delete c.dataset.done},1400)})
});
})();
</script>`;

// ---------- head ----------

export function head({ title, description, canonical }) {
  return `<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(canonical)}">
<meta name="theme-color" content="#1f1f1f" media="(prefers-color-scheme: dark)">
<meta name="theme-color" content="#fcfcfc" media="(prefers-color-scheme: light)">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${esc(meta.name)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:image" content="${origin}/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:type" content="image/png">
<meta property="og:image:alt" content="${esc(meta.name)} — ${esc(meta.h1)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${origin}/og.png">
<link rel="icon" href="${favicon}">
<script type="application/ld+json">${JSON.stringify(jsonLd())}</script>
${bootScript}
<style>${css}</style>
</head>`;
}

function jsonLd() {
  return {
    '@context': 'https://schema.org', '@type': 'SoftwareApplication',
    name: meta.name, description: meta.description, url: url('/'),
    applicationCategory: 'DeveloperApplication', softwareVersion: version,
    offers: { '@type': 'Offer', price: '0' }, license: 'https://opensource.org/licenses/MIT',
  };
}

// ---------- header / footer ----------

const resolveHref = (h) => (h === 'repo' ? repo : h);
const iconLink = (l) => `<a class="icon-link" href="${esc(resolveHref(l.href))}" aria-label="${esc(l.label)}">${icon(l.icon)}</a>`;

export function header(active) {
  const navLinks = nav.map((n) => `<a href="${esc(n.href)}"${n.external ? ' target="_blank" rel="noopener"' : ''}${n.href === active ? ' aria-current="page"' : ''}>${esc(n.label)}${n.external ? ' <span class="ext">↗</span>' : ''}</a>`).join('');
  const iconsRight = links.filter((l) => l.where.includes('header')).map(iconLink).join('');
  return `<a class="skip" href="#main">Skip to content</a>
<header class="site-head"><div class="shell">
<a class="brand" href="/"><span class="brand-mark">${productMark}</span><span class="brand-word">${esc(meta.name)}</span></a>
<nav class="site-nav" aria-label="Site">${navLinks}</nav>
<div class="head-icons">${iconsRight}<span class="head-div" aria-hidden="true"></span>
<button id="theme-toggle" class="theme-toggle" type="button" aria-label="Theme: system. Click to change"><span class="i i-system">${icon('monitor')}</span><span class="i i-dark">${icon('moon')}</span><span class="i i-light">${icon('sun')}</span></button>
</div>
</div></header>`;
}

export function footer() {
  const cols = footerColumns.map((c) => `<div class="foot-col"><h3>${esc(c.title)}</h3>${c.links.map((l) => `<a href="${esc(resolveHref(l.href))}"${l.external ? ' target="_blank" rel="noopener"' : ''}>${esc(l.label)}${l.external ? ' <span class="ext">↗</span>' : ''}</a>`).join('')}</div>`).join('');
  const iconRow = links.filter((l) => l.where.includes('footer')).map(iconLink).join('');
  return `<footer class="site-foot"><div class="shell">
<p class="credit">${esc(credit)}</p>
<div class="foot-cols">${cols}</div>
<div class="foot-icons">${iconRow}</div>
<p class="copyright">© ${year} linesofcode</p>
</div></footer>`;
}

// ---------- syntax colour (deterministic) ----------

const TS_KEYWORDS = new Set(['import', 'from', 'export', 'const', 'let', 'return', 'if', 'else', 'new', 'true', 'false', 'null', 'undefined', 'function', 'await', 'async', 'of', 'in', 'for', 'while', 'type', 'interface', 'try', 'catch']);

export function highlightTs(src) {
  let out = '';
  const push = (cls, text) => { out += cls ? `<span class="tk-${cls}">${esc(text)}</span>` : esc(text); };
  let i = 0;
  while (i < src.length) {
    const rest = src.slice(i);
    let m;
    if ((m = rest.match(/^\/\/[^\n]*/))) push('cmt', m[0]);
    else if ((m = rest.match(/^'(?:[^'\\\n]|\\.)*'?|^"(?:[^"\\\n]|\\.)*"?|^`(?:[^`\\]|\\.)*`?/))) push('str', m[0]);
    else if ((m = rest.match(/^\d[\d.]*/))) push('num', m[0]);
    else if ((m = rest.match(/^[A-Za-z_$][\w$]*/))) {
      const w = m[0];
      if (TS_KEYWORDS.has(w)) push('kw', w);
      else if (/^\s*[(<]/.test(src.slice(i + w.length))) push('fn', w);
      else push(null, w);
    } else { push(null, src[i]); i++; continue; }
    i += m[0].length;
  }
  return out;
}

export function highlightJson(src) {
  return src.replace(/("(?:[^"\\\n]|\\.)*")(\s*:)?|\b(true|false|null)\b|(-?\d[\d.]*)|([\s\S])/g, (all, str, colon, kw, num, other) => {
    if (str) return colon ? `<span class="tk-key">${esc(str)}</span>${colon}` : `<span class="tk-str">${esc(str)}</span>`;
    if (kw) return `<span class="tk-kw">${kw}</span>`;
    if (num) return `<span class="tk-num">${num}</span>`;
    return esc(other);
  });
}

export function highlightCode(code, lang) {
  if (['js', 'mjs', 'ts', 'typescript', 'javascript'].includes(lang)) return highlightTs(code);
  if (lang === 'json') return highlightJson(code);
  return esc(code);
}

// Captured output, coloured by meaning: the action an explain run names, the
// fix line under an error, the keys of a JSON answer.
export function outputHtml(text) {
  let afterError = false;
  return text.split('\n').map((line) => {
    let m;
    if (line.startsWith('$ ')) { afterError = false; return `<span class="cmd">${esc(line)}</span>`; }
    if (/^# /.test(line)) { afterError = false; return `<span class="tk-cmt">${esc(line)}</span>`; }
    if ((m = /^(\w+)( [^\s/]\S*)?( {2}\/\/ .*)?$/.exec(line)) && isAction(m[1])) {
      return `<span class="act-${m[1]}">${m[1]}</span>${m[2] ? `<span class="tk-ink">${esc(m[2])}</span>` : ''}${m[3] ? `<span class="tk-cmt">${esc(m[3])}</span>` : ''}`;
    }
    if (/^ {2}(route|gate) \d+/.test(line) || /^ {2}because$/.test(line)) return `<span class="tk-dim">${esc(line)}</span>`;
    if ((m = /^( {4})(\S+) = (\S+)(.*)$/.exec(line))) return `${m[1]}<span class="tk-ink">${esc(m[2])}</span> = ${/^-?[\d.]+$/.test(m[3]) ? `<span class="tk-num">${esc(m[3])}</span>` : `<span class="tk-ink">${esc(m[3])}</span>`}<span class="tk-dim">${esc(m[4])}</span>`;
    if ((m = /^(\$\.[^:]*:)(.*)$/.exec(line))) { afterError = true; return `<span class="tk-dim">${esc(m[1])}</span>${esc(m[2])}`; }
    if (afterError && /^ {2}\S/.test(line)) return `<span class="tk-fix">${esc(line)}</span>`;
    if (/^answered by /.test(line)) return `<span class="tk-dim">${esc(line)}</span>`;
    if (line.startsWith('{')) return jsonLine(line);
    return esc(line);
  }).join('\n');
}

function jsonLine(raw) {
  let s = esc(raw);
  const Q = '&quot;';
  s = s.replace(new RegExp(`${Q}(action|permissionDecision)${Q}:${Q}(\\w+)${Q}`, 'g'), (_, k, a) => `<span class="tk-key">${Q}${k}${Q}</span>:<span class="act-${a}">${Q}${a}${Q}</span>`);
  s = s.replace(new RegExp(`(?<!class=)${Q}([\\w?]+)${Q}:`, 'g'), `<span class="tk-key">${Q}$1${Q}</span>:`);
  s = s.replace(/:(-?\d+\.?\d*)([,}\]])/g, ':<span class="tk-num">$1</span>$2');
  return s;
}

// ---------- frames ----------

const dots = '<span class="dots" aria-hidden="true"><span class="dot"></span><span class="dot"></span><span class="dot"></span></span>';
const copyCode = (label) => `<button class="copy-btn" type="button" data-copy-code aria-label="Copy ${esc(label)}">${icon('copy')}<span class="lbl">Copy</span><span class="lbl-done">Copied</span></button>`;
const copyText = (text, label) => `<button class="copy-btn" type="button" data-copy="${esc(text)}" aria-label="Copy ${esc(label)}">${icon('copy')}<span class="lbl">Copy</span><span class="lbl-done">Copied</span></button>`;

function codeFrame({ name, code, lang }) {
  return `<figure class="frame">
<div class="frame-bar">${dots}<span class="name">${esc(name)}</span>${copyCode(name)}</div>
<pre class="frame-body"><code>${highlightCode(code, lang)}</code></pre>
</figure>`;
}

const noteHtml = (cap) => {
  if (!cap.comment) return '';
  const text = cap.live ? `<b>live run</b> · ${esc(cap.comment.replace(/^live:\s*/, ''))}` : esc(cap.comment);
  return `<figcaption class="frame-note">${text}</figcaption>`;
};

function commandFrame(command) {
  return `<figure class="frame cmdline"><div class="frame-bar frame-bar--cmd"><span class="name"><b>$</b> ${esc(command)}</span>${copyText(command, 'command')}</div></figure>`;
}

function runFrame(cap) {
  return `<figure class="frame">
<div class="frame-bar frame-bar--cmd"><span class="name"><b>$</b> ${esc(cap.command)}</span>${copyText(cap.command, 'command')}<span class="chip chip--captured">captured output</span></div>
<pre class="frame-body frame-body--out">${outputHtml(cap.output)}</pre>
${noteHtml(cap)}
</figure>`;
}

// The run under the same frame, with a note beside each part of the output.
function annotatedFrame(cap) {
  const lines = cap.output.split('\n');
  const answered = lines.at(-1);
  if (!/^answered by /.test(answered)) throw new Error('annotated run: the last line must say who answered');
  const [d] = parseExplain(lines.slice(0, -1).join('\n'));
  if (lines[1].trim() !== `${d.rule} ${d.clause}, ${d.source}`) throw new Error('annotated run: line 2 is not the rule line');
  const rows = [
    { code: lines[0], note: '<b>The action</b>, and the reason the policy gave for it.' },
    { code: lines[1], note: `<b>The rule that fired:</b> ${esc(d.rule)} ${esc(String(d.clause))}, a line of your policy, so every decision traces back to code.` },
    { code: lines.slice(2, -1).join('\n'), note: '<b>What the model answered</b> for each question that rule read, with its confidence.' },
    { code: answered, note: '<b>Who answered:</b> the provider and model that sent the answers back.' },
  ];
  return `<figure class="frame annotated">
<div class="frame-bar frame-bar--cmd"><span class="name"><b>$</b> ${esc(cap.command)}</span>${copyText(cap.command, 'command')}<span class="chip chip--captured">captured output</span></div>
<div class="frame-body">${rows.map((r) => `<div class="ann-row"><pre class="ann-code">${outputHtml(r.code)}</pre><p class="ann-note">${r.note}</p></div>`).join('\n')}</div>
${noteHtml(cap)}
</figure>`;
}

function stepsHtml(steps, r) {
  const frames = (s) => {
    const out = [];
    if (s.cmd) out.push(commandFrame(s.cmd));
    if (s.file) { const b = r.file(s.file); out.push(codeFrame({ name: s.file, code: b.body, lang: b.lang })); }
    if (s.run) out.push(runFrame(r.run(s.run)));
    for (const cmd of s.runs ?? []) out.push(runFrame(r.run(cmd)));
    return out.join('\n');
  };
  return `<ol class="steps">${steps.map((s, i) => `<li class="step"><span class="step-n" aria-hidden="true">${i + 1}</span><div class="step-body"><p class="step-title">${s.title}</p>\n${frames(s)}</div></li>`).join('\n')}</ol>`;
}

// Wider tables label each cell, so a phone can stack them as cards.
const table = (head, rows, cell = inlineMd) => `<div class="tablewrap"><table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((c, i) => `<td${head.length > 2 ? ` data-label="${esc(head[i])}"` : ''}>${i === 0 && head.length === 2 ? inlineMd('`' + c + '`') : cell(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;

function figuresRow(figs) {
  if (!figs?.length) return '';
  return `<div class="figures">${figs.map((f) => `<div class="figure"><b>${esc(f.value)}</b><span>${esc(f.label)}</span></div>`).join('')}</div>`;
}

// ---------- landing page ----------

export function renderDemo(d, ctx) {
  const { r, readme, cloudReadme } = ctx;
  switch (d.type) {
    case 'source': { const b = r.file(d.file); return codeFrame({ name: d.file, code: b.body, lang: b.lang }); }
    case 'run': return runFrame(r.run(d.run));
    case 'annotated': return annotatedFrame(r.run(d.run));
    case 'steps': return stepsHtml(d.steps, r);
    case 'table': { const t = readmeTable(readme, d.table); return table(t.head, t.rows); }
    case 'modules': return `${d.title ? `<p class="table-title">${esc(d.title)}</p>` : ''}${table(['Export', 'What it carries'], modulesTable(readme))}`;
    case 'cloud-api': return `<p class="table-title">The API</p>${table(['Route', 'What it does'], cloudApiTable(cloudReadme))}`;
    case 'diagram': return diagramHtml(d, ctx);
    default: throw new Error(`unknown demo type ${d.type}`);
  }
}

function diagramHtml(d, { r, readme, cloudReadme }) {
  const policy = () => readPolicy(r.file(d.policy).body);
  switch (d.name) {
    case 'decision-flow': return decisionFlow({ ticket: unescapeJs(figure(r.file(d.ticket.file).body, d.ticket.from)), run: r.run(d.run).output, policy: policy() });
    case 'answer-shapes': {
      const p = policy();
      const t = readmeTable(readme, d.table);
      const kinds = t.rows.map((row) => ({ kind: row[0].replace(/`/g, ''), use: inlineMd(row[1]), answer: row[2].replace(/^`|`$/g, '') }));
      return answerShapes({ policy: p, answers: readAnswers(r.file(d.decide).body, d.case, p.questions), kinds });
    }
    case 'gate-meter': return gateMeter({ cases: parseExplain(r.run(d.run).output), pass: d.pass, fail: d.fail });
    case 'rule-ladder': return ruleLadder({ policy: policy() });
    case 'tool-ladder': return toolLadder({ options: JSON.parse(r.file(d.options).body), questions: policy().questions.map((q) => q.id) });
    case 'doors': return doors({ items: readmeList(readme, d.list).map((x) => ({ label: x.label, call: x.call, text: x.text })) });
    case 'lifecycle': return lifecycle({ api: cloudApiTable(cloudReadme) });
    default: throw new Error(`unknown diagram: ${d.name}`);
  }
}

const unescapeJs = (s) => s.replace(/\\(["'\\])/g, '$1');

// `{name}` in a boundary item is a figure from a captured run.
const fill = (text, figs, r) => text.replace(/\{(\w+)\}/g, (_, k) => {
  const f = figs?.[k];
  if (!f) throw new Error(`boundary item uses {${k}} but names no figure for it`);
  return figure(r.run(f.run).output, f.from);
});

export function renderLanding({ readme, cloudReadme }) {
  const r = makeResolver(readme);
  const ctx = { r, readme, cloudReadme };

  const sectionHtml = contentSections.map((s, i) => {
    const demos = s.demos.map((d) => `<div class="demo">${renderDemo(d, ctx)}</div>`).join('\n');
    const aside = asides.filter((a) => a.before === s.id).map((a) => `<div class="aside"><div class="shell"><p>${inlineMd(a.text)}</p></div></div>`).join('\n');
    return `${aside}<section id="${s.id}" class="section${i % 2 === 0 ? ' section--band' : ''}" aria-labelledby="${s.id}-h">
<div class="shell">
<h2 id="${s.id}-h">${esc(s.h2)}</h2>
<p class="expl">${inlineMd(s.p)}${s.doc ? ` <a href="/reference#${slug(s.doc)}">Read the section.</a>` : ''}</p>
${demos}
</div>
</section>`;
  }).join('\n');

  const boundaryHtml = `<section id="boundaries" class="section" aria-labelledby="boundaries-h">
<div class="shell">
<h2 id="boundaries-h">${esc(boundaries.h2)}</h2>
<p class="expl">${inlineMd(boundaries.intro)}</p>
<div class="boundaries">
${boundaries.columns.map((c) => `<div class="boundary"><h3>${esc(c.title)} <span>${c.items.length}</span></h3><ul>${c.items.map((i) => `<li>${inlineMd(fill(i, c.figures, r))}</li>`).join('')}</ul></div>`).join('')}
</div>
</div>
</section>`;

  const verify = r.run(start.verify.run);
  const startHtml = `<section id="start" class="section section--band" aria-labelledby="start-h">
<div class="shell">
<h2 id="start-h">${esc(start.h2)}</h2>
<p class="expl">${inlineMd(start.p)}</p>
<div class="panels">
<div><p class="panel-title">Install</p>${start.install.map((c) => `<div class="demo">${commandFrame(c)}</div>`).join('')}</div>
<div><p class="panel-title">Verify</p>${figuresRow(start.verify.figures.map((f) => ({ label: f.label, value: figure(verify.output, f.from) })))}${runFrame(verify)}</div>
</div>
</div>
</section>`;

  const actions = `<div class="actions">
<span class="control control--chip"><code>${esc(meta.install)}</code><button class="copy-btn" type="button" data-copy="${esc(meta.install)}" aria-label="Copy install command">${icon('copy')}</button></span>
<details class="control">
<summary>${icon('chevron')} For agents</summary>
<div class="menu"><div class="menu-items">
<a href="/llms.txt">llms.txt</a>
<a href="/AGENTS.md">AGENTS.md</a>
<button type="button" data-copy-markdown aria-label="Copy page as Markdown"><span class="lbl">Copy page as Markdown</span><span class="lbl-done">Copied</span></button>
</div></div>
</details>
<a class="control control--solid" href="/reference">${icon('book')} Documentation</a>
</div>`;

  const hero = `<section class="hero" aria-labelledby="top"><div class="shell">
<span class="mark">${productMark}</span>
<h1 id="top">${esc(meta.h1)}</h1>
<p class="lede">${inlineMd(meta.lede)}</p>
${actions}
<p class="muted">Currently v${esc(version)}</p>
</div></section>`;

  return `<!doctype html>
<html lang="en">
${head({ title: `${meta.name} — ${meta.tagline}`, description: meta.description, canonical: url('/') })}
<body id="landing">
${header('/')}
<main id="main">
${hero}
${sectionHtml}
${boundaryHtml}
${startHtml}
</main>
${footer()}
</body>
</html>`;
}

// ---------- reference page ----------

export function renderReference({ readme }) {
  const html = markdownHtml(readme);
  const toc = [...readme.matchAll(/^## (.+)$/gm)].map((m) => `<a href="#${slug(m[1])}">${esc(m[1])}</a>`).join('');
  return `<!doctype html>
<html lang="en">
${head({ title: `${meta.name} — reference`, description: `The full ${meta.name} README: policies, gates, dispatch, providers, MCP, serving, and the verification evidence.`, canonical: url('/reference') })}
<body id="reference">
${header('/reference')}
<main id="main"><div class="shell ref-layout">
<nav class="ref-toc" aria-label="Contents"><p class="toc-title">Contents</p>${toc}</nav>
<article class="ref-doc">
${html}
</article>
</div></main>
${footer()}
</body>
</html>`;
}

// ---------- sibling artefacts ----------

const inlinePlain = (t) => t
  .replace(/\(REPO/g, `(${repo}`)
  .replace(/\(CLOUDREPO/g, `(${cloudRepo}`)
  .replace(/`([^`]+)`/g, '$1')
  .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');

const mdTable = (head, rows) => [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map((row) => `| ${row.join(' | ')} |`)].join('\n');
const fenceMd = (lang, body) => ['```' + lang, body, '```', ''].join('\n');

// One demo as Markdown, for llms.txt and index.md. Diagrams are pictures of
// what the frames beside them already say, so they add nothing here.
function demoMarkdown(d, ctx) {
  const { r, readme, cloudReadme } = ctx;
  const source = (name) => { const b = r.file(name); return `**${name}**\n\n${fenceMd(b.lang, b.body)}`; };
  const run = (cmd) => { const c = r.run(cmd); return fenceMd('sh', `$ ${c.command}${c.output ? '\n' + c.output : ''}`); };
  switch (d.type) {
    case 'source': return source(d.file);
    case 'run': case 'annotated': return run(d.run);
    case 'steps': return d.steps.map((s) => [s.title.replace(/<[^>]+>/g, ''), s.cmd ? fenceMd('sh', `$ ${s.cmd}`) : '', s.file ? source(s.file) : '', s.run ? run(s.run) : '', ...(s.runs ?? []).map(run)].filter(Boolean).join('\n\n')).join('\n\n');
    case 'table': { const t = readmeTable(readme, d.table); return mdTable(t.head, t.rows) + '\n'; }
    case 'modules': return mdTable(['Export', 'What it carries'], modulesTable(readme).map(([a, b]) => [`\`${a}\``, inlinePlain(b)])) + '\n';
    case 'cloud-api': return mdTable(['Route', 'What it does'], cloudApiTable(cloudReadme).map(([a, b]) => [`\`${a}\``, inlinePlain(b)])) + '\n';
    default: return '';
  }
}

const capabilityMarkdown = (s, ctx) => [`## ${s.h2}`, '', inlinePlain(s.p), '', ...s.demos.map((d) => demoMarkdown(d, ctx)).filter(Boolean).flatMap((x) => [x, ''])].join('\n');

const boundariesMarkdown = (r) => [`## ${boundaries.h2}`, '', inlinePlain(boundaries.intro), '', ...boundaries.columns.flatMap((c) => [`**${c.title}**`, '', ...c.items.map((i) => `- ${inlinePlain(fill(i, c.figures, r))}`), ''])].join('\n');

export function llmsText({ readme, cloudReadme }) {
  const r = makeResolver(readme);
  const ctx = { r, readme, cloudReadme };
  return [
    `# ${meta.name}`, '',
    `> ${meta.description}`, '',
    `${inlinePlain(meta.lede)} Install with \`${meta.install}\`. Currently v${version}, ${meta.license} licensed.`, '',
    ...contentSections.flatMap((s) => [capabilityMarkdown(s, ctx)]),
    boundariesMarkdown(r),
    '## Links', '',
    `- Reference: ${url('/reference')}`,
    `- Agent guide: ${url('/AGENTS.md')}`,
    `- This page as Markdown: ${url('/index.md')}`,
    `- Repository: ${repo}`, '',
  ].join('\n');
}

export function agentsMd({ readme }) {
  const r = makeResolver(readme);
  const hello = r.file('policy.js');
  return `# AGENTS.md — using ${meta.name} from an agent

Install: \`${meta.install}\`. Node 22+, no runtime dependencies. Deciding, validating
and replaying work offline; only \`evaluateWithProvider\` and \`jev gate hook\`
(for calls on neither list) reach a model.

Minimal working policy — save it as \`policy.js\` and run \`node policy.js\`
(this exact file is re-run by the test suite):

${fenceMd('js', hello.body)}
Every question needs an answer: \`noul\` answers are \`{ noul: 0.97 }\`, \`choice\` answers
\`{ choice: 'billing', confidence: 0.94 }\`, \`score\` answers a level with its \`probabilities\`.

## Options that matter

| Option | Effect |
| --- | --- |
| \`questions\` | declared \`noul\` / \`choice\` / \`score\` questions; answers are validated against them |
| \`gates\` | \`gate(question, bar, escalate(...))\` — below the bar, escalate instead of guessing |
| \`route.clauses\` | ordered rules; the first match wins, so clause order is policy |
| \`route.otherwise\` | the no-match action; a route with a hole is refused |
| \`state\` | what the decision may see, mapped from the input, redacted and capped |

## Three mistakes that break it

${agentsMistakes.map((m) => `- ${inlinePlain(m)}`).join('\n')}

Guarding tool calls: ${inlinePlain(agentsGateNote)}

Full reference: ${url('/reference')}. Repo: ${repo}.
`;
}

export function pageMarkdown({ readme, cloudReadme }) {
  const r = makeResolver(readme);
  const ctx = { r, readme, cloudReadme };
  return [
    `# ${meta.name} — ${meta.h1}`, '',
    inlinePlain(meta.lede), '',
    `Install: \`${meta.install}\` · Currently v${version}`, '',
    ...contentSections.flatMap((s) => [capabilityMarkdown(s, ctx)]),
    boundariesMarkdown(r),
    `## ${start.h2}`, '', inlinePlain(start.p), '', fenceMd('sh', start.install.map((c) => `$ ${c}`).join('\n')),
  ].join('\n');
}

export function sitemap() {
  const urls = [url('/'), url('/reference')].map((u) => `  <url><loc>${u}</loc></url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;
}

export function robots() {
  return `User-agent: *
Allow: /

Sitemap: ${url('/sitemap.xml')}
`;
}

export { esc, tag };
