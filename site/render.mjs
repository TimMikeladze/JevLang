// Renderer: parses the source docs, resolves references, emits HTML, CSS, head
// metadata and the sibling artefacts. No copy lives here (icons and markup do).
import { readFileSync } from 'node:fs';
import { sections as contentSections, asides, boundaries, start, links, nav, footerColumns, credit, meta, origin, repo, cloudRepo, agentsMistakes } from './content.mjs';

export const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
export const year = new Date().getFullYear();

export const url = (path) => (path === '/' ? origin + '/' : origin + path.replace(/\.html$/, ''));

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ---------- doc parsing ----------

export function fences(md) {
  const out = [];
  const re = /^```[\w-]*\n([\s\S]*?)^```\s*$/gm;
  let m;
  while ((m = re.exec(md))) out.push(m[1].replace(/\n$/, ''));
  return out;
}

export function makeResolver(md) {
  const blocks = fences(md);
  const terminal = (cmd) => {
    const hits = blocks.filter((b) => {
      const line = b.split('\n')[0];
      if (!line.startsWith('$ ')) return false;
      const rest = line.slice(2).split('  #')[0];
      return rest === cmd || rest.startsWith(cmd + ' ');
    });
    if (hits.length !== 1) throw new Error(`terminal(${cmd}): expected 1 block, found ${hits.length}`);
    return hits[0];
  };
  const snippet = (marker) => {
    const hits = blocks.filter((b) => b.includes(marker));
    if (hits.length !== 1) throw new Error(`snippet(${marker}): expected 1 block, found ${hits.length}`);
    return hits[0];
  };
  return { terminal, snippet };
}

export function figure(block, re) {
  const m = re.exec(block);
  if (!m) throw new Error(`figure ${re} not found in block`);
  return m[1] ?? m[0];
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

const linkTargets = { REPO: repo, CLOUDREPO: cloudRepo };
export function inlineMd(text) {
  let s = esc(text);
  for (const [k, v] of Object.entries(linkTargets)) s = s.split(`(${k})`).join(`(${v})`);
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
  let i = 0, inCode = false, codeBuf = [], list = null, table = null, para = [];
  const flushPara = () => { if (para.length) { out.push(`<p>${inlineMd(para.join(' '))}</p>`); para = []; } };
  const flushList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  const flushTable = () => {
    if (table) {
      const [head, ...rows] = table;
      out.push('<table><thead><tr>' + head.map((c) => `<th>${inlineMd(c)}</th>`).join('') + '</tr></thead><tbody>'
        + rows.map((r) => '<tr>' + r.map((c) => `<td>${inlineMd(c)}</td>`).join('') + '</tr>').join('') + '</tbody></table>');
      table = null;
    }
  };
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('```')) {
      flushPara(); flushList(); flushTable();
      if (!inCode) { inCode = true; codeBuf = []; } else { inCode = false; out.push(`<pre><code>${esc(codeBuf.join('\n'))}</code></pre>`); }
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
      out.push(`<li>${inlineMd(li[1])}</li>`); i++; continue;
    }
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
const brand = (d, extra = '') => `<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="currentColor">${extra}<path d="${d}"/></svg>`;

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

export const productMark = `<svg aria-hidden="true" width="44" height="44" viewBox="0 0 48 48"><rect width="48" height="48" rx="11" fill="oklch(18.5% 0 0)"/><path d="M30 12v16.5c0 4.5-3 7.5-7.5 7.5S15 33 15 29.5" fill="none" stroke="oklch(98.5% 0 0)" stroke-width="3.4" stroke-linecap="round"/></svg>`;

export const favicon = `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" rx="11" fill="#1c1c1c"/><path d="M30 12v16.5c0 4.5-3 7.5-7.5 7.5S15 33 15 29.5" fill="none" stroke="#f7f7f7" stroke-width="3.4" stroke-linecap="round"/></svg>`)}`;

// ---------- CSS ----------

export const css = String.raw`:root{color-scheme:dark;
--paper:oklch(12.5% 0 0);--band:oklch(15.5% 0 0);--raise:oklch(18.5% 0 0);
--ink:oklch(98.5% 0 0);--body:oklch(78% 0 0);--soft:oklch(62% 0 0);
--line:oklch(100% 0 0/.11);--line-soft:oklch(100% 0 0/.06);
--accent:oklch(70% .16 250);--add:oklch(72% .17 150);--del:oklch(68% .19 20);--warn:oklch(78% .15 85);
--sans:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
--mono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace}
:root[data-theme=light]{color-scheme:light;
--paper:oklch(99% 0 0);--band:oklch(97% 0 0);--raise:oklch(100% 0 0);
--ink:oklch(14.5% 0 0);--body:oklch(27% 0 0);--soft:oklch(30% 0 0);
--line:oklch(0% 0 0/.12);--line-soft:oklch(0% 0 0/.06);
--accent:oklch(52% .18 250);--add:oklch(50% .16 150);--del:oklch(50% .19 25);--warn:oklch(55% .13 80)}
@media (prefers-color-scheme:light){:root:not([data-theme=dark]):not([data-theme=light]){color-scheme:light;
--paper:oklch(99% 0 0);--band:oklch(97% 0 0);--raise:oklch(100% 0 0);
--ink:oklch(14.5% 0 0);--body:oklch(27% 0 0);--soft:oklch(30% 0 0);
--line:oklch(0% 0 0/.12);--line-soft:oklch(0% 0 0/.06);
--accent:oklch(52% .18 250);--add:oklch(50% .16 150);--del:oklch(50% .19 25);--warn:oklch(55% .13 80)}}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:var(--paper);color:var(--body);font:1rem/1.6 var(--sans)}
.shell{width:min(1180px,calc(100% - 3rem));margin-inline:auto}
a{color:var(--ink);text-decoration:underline;text-underline-offset:.18em;text-decoration-color:var(--line)}
a:hover{text-decoration-color:var(--accent)}
code{font-family:var(--mono);font-size:.9em;color:var(--ink);background:var(--raise);padding:.1em .32em;border-radius:.28rem}
h1,h2,h3{color:var(--ink);font-weight:700}
h1{font-size:clamp(2.6rem,6vw,4.2rem);line-height:1.03;letter-spacing:-.04em;max-width:16ch;margin:1.1rem 0 1.2rem}
h2{font-size:clamp(1.35rem,2.4vw,1.7rem);line-height:1.2;font-weight:650;letter-spacing:-.02em;margin:0}
.lede{font-size:clamp(1.05rem,1.6vw,1.2rem);line-height:1.55;max-width:58ch;margin:0 0 1.6rem}
.muted{color:var(--soft);font-size:.875rem}
.section{padding-block:clamp(3.5rem,7vw,6rem);scroll-margin-top:4.5rem}
.section--band{background:var(--band)}
.section h2+.expl{margin-top:.6rem}
.expl{max-width:68ch;margin:0}
.demo{margin-top:1.6rem}
.skip{position:absolute;left:-9999px}
.skip:focus{left:1rem;top:1rem;z-index:99;background:var(--raise);color:var(--ink);padding:.5rem .8rem;border-radius:.4rem}
:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
/* header */
.site-head{position:sticky;top:0;z-index:10;min-height:3.75rem;background:color-mix(in oklab,var(--paper) 82%,transparent);backdrop-filter:blur(12px);border-bottom:1px solid var(--line)}
.site-head .shell{display:flex;align-items:center;gap:1rem;min-height:3.75rem}
.brand{font-weight:700;font-size:1.05rem;color:var(--ink);text-decoration:none}
.site-nav{display:flex;gap:1.1rem}
.site-nav a{font-size:.875rem;color:var(--soft);text-decoration:none}
.site-nav a:hover,.site-nav a[aria-current=page]{color:var(--ink)}
.head-icons{margin-left:auto;display:flex;align-items:center;gap:.75rem}
.icon-link{color:var(--soft);display:inline-flex}
.icon-link:hover{color:var(--ink)}
.ext{font-size:.75em;opacity:.5}
/* hero */
.hero{padding-block:clamp(3.5rem,7vw,6rem) 0}
.hero .mark{display:inline-block}
.actions{display:flex;flex-wrap:wrap;gap:.7rem;align-items:center;margin:0 0 1rem}
.control{display:inline-flex;align-items:center;gap:.5rem;padding:.62rem .85rem;border-radius:.6rem;border:1px solid var(--line);background:var(--raise);color:var(--ink);font:500 .9rem/1.15 var(--sans);text-decoration:none;transition:background .14s ease,border-color .14s ease;cursor:pointer}
.control:hover{border-color:var(--line);background:color-mix(in oklab,var(--raise) 80%,var(--ink) 4%)}
.control code{font:.88rem/1 var(--mono);background:none;padding:0}
.control--solid{background:var(--ink);color:var(--paper);border-color:transparent;font-weight:550}
.control--solid:hover{background:color-mix(in oklab,var(--ink) 88%,var(--paper))}
details.control{position:relative}
details.control summary{list-style:none;display:inline-flex;align-items:center;gap:.5rem;cursor:pointer}
details.control summary::-webkit-details-marker{display:none}
details.menu{position:absolute;top:calc(100% + .5rem);left:0;background:var(--raise);border:1px solid var(--line);border-radius:.6rem;padding:.4rem;display:grid;gap:.1rem;min-width:16rem;z-index:5}
details.menu a,details.menu button{display:flex;width:100%;text-align:left;padding:.45rem .6rem;border-radius:.4rem;color:var(--body);text-decoration:none;font-size:.875rem;background:none;border:0;cursor:pointer}
details.menu a:hover,details.menu button:hover{background:var(--band);color:var(--ink)}
/* theme toggle */
.theme-toggle{background:none;border:0;color:var(--soft);cursor:pointer;padding:.2rem;display:inline-flex;border-radius:.4rem}
.theme-toggle:hover{color:var(--ink)}
/* demo frames */
.frame{border:1px solid var(--line);border-radius:.7rem;overflow:hidden;background:var(--paper);margin-inline:0}
.frame--stacked+.frame--stacked{margin-top:1rem}
.frame-bar{display:flex;align-items:center;gap:.75rem;background:var(--band);border-bottom:1px solid var(--line-soft);padding:.55rem .9rem;font:500 .8rem/1 var(--mono);color:var(--soft)}
.frame-bar .dots{display:flex;gap:6px}
.dot{width:10px;height:10px;border-radius:50%;background:var(--line)}
.frame-bar .chip{margin-left:auto;border:1px solid var(--line-soft);border-radius:.4rem;padding:.2rem .5rem;font-size:.68rem;text-transform:uppercase;letter-spacing:.06em}
.frame-body{margin:0;padding:1rem .9rem;font:.8rem/1.6 var(--mono);color:var(--body);overflow-x:auto;background:var(--paper);white-space:pre-wrap;word-break:break-word}
.frame-body .cmd{color:var(--ink);font-weight:600}
.demo+.demo{margin-top:1rem}
/* figures */
.figures{display:flex;gap:2rem;flex-wrap:wrap;margin:0 0 .8rem}
.figure b{display:block;font:650 .9rem/1.2 var(--sans);color:var(--ink)}
.figure span{font:.8rem/1.4 var(--mono);color:var(--soft)}
/* tables */
.tablewrap{margin-top:1.6rem;overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:.9rem}
th{font:600 .72rem/1.4 var(--mono);text-transform:uppercase;letter-spacing:.08em;color:var(--soft);text-align:left;padding:.55rem .9rem .35rem}
td{padding:.55rem .9rem;border-top:1px solid var(--line-soft);color:var(--body);vertical-align:top}
td:first-child{font-family:var(--mono);font-size:.82rem;color:var(--ink);white-space:nowrap}
/* boundaries */
.boundaries{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:var(--line-soft);border:1px solid var(--line-soft);border-radius:.7rem;overflow:hidden;margin-top:1.6rem}
.boundary{background:var(--paper);padding:1.4rem 1.3rem}
.boundary h3{font:600 .85rem/1.2 var(--sans);margin:0 0 .8rem;color:var(--ink)}
.boundary li{margin:.5rem 0;font-size:.9rem;line-height:1.5}
.boundary ul{margin:0;padding-left:1.1rem}
/* aside */
.aside{padding-block:1.4rem;border-top:1px solid var(--line-soft);border-bottom:1px solid var(--line-soft);background:var(--paper)}
.aside p{margin:0;max-width:68ch;font-size:.95rem}
/* start */
.panels{display:grid;grid-template-columns:1fr 1fr;gap:1.2rem;margin-top:1.6rem}
.panels>*{min-width:0}
.panels .frame{height:100%}
/* footer */
.site-foot{border-top:1px solid var(--line);padding-block:3rem 2rem;margin-top:clamp(3.5rem,7vw,6rem)}
.site-foot .credit{max-width:60ch;color:var(--soft);font-size:.9rem;margin:0 0 2rem}
.foot-cols{display:flex;gap:4rem;flex-wrap:wrap}
.foot-col h3{font:600 .85rem/1.3 var(--sans);margin:0 0 .6rem}
.foot-col a{display:block;font-size:.85rem;color:var(--soft);text-decoration:none;padding:.18rem 0}
.foot-col a:hover{color:var(--ink)}
.foot-icons{display:flex;gap:.9rem;margin:2rem 0 0}
.copyright{margin-top:2.2rem;font-size:.8rem;color:var(--soft)}
/* reference page */
.ref-layout{display:grid;grid-template-columns:230px minmax(0,1fr);gap:3rem;padding-block:clamp(2.5rem,5vw,4rem)}
.ref-layout>*{min-width:0}
.ref-toc{position:sticky;top:4.5rem;align-self:start;max-height:calc(100vh - 6rem);overflow:auto}
.ref-toc a{display:block;font-size:.8rem;color:var(--soft);text-decoration:none;padding:.22rem 0}
.ref-toc a:hover{color:var(--ink)}
.ref-toc .toc-title{font:600 .72rem/1.4 var(--mono);text-transform:uppercase;letter-spacing:.08em;color:var(--soft);margin:0 0 .6rem}
.ref-doc{max-width:76ch}
.ref-doc h1{font-size:clamp(2rem,4vw,2.8rem)}
.ref-doc h2{font-size:1.4rem;margin:2.4rem 0 .8rem;scroll-margin-top:4.5rem}
.ref-doc pre{background:var(--raise);border:1px solid var(--line-soft);border-radius:.6rem;padding:1rem;overflow-x:auto}
.ref-doc pre code{background:none;padding:0;font-size:.82rem;line-height:1.6}
.ref-doc table td:first-child{white-space:normal}
.ref-doc li{margin:.3rem 0}
@media (max-width:900px){.ref-layout{grid-template-columns:1fr}.ref-toc{position:static;max-height:none;border-bottom:1px solid var(--line-soft);padding-bottom:1rem}}
@media (max-width:720px){
.site-nav{display:none}
.panels{grid-template-columns:1fr}
.boundaries{grid-template-columns:1fr}
h1{font-size:2.6rem}
.frame{border-radius:0;border-left:0;border-right:0}
}
@media (prefers-reduced-motion:reduce){*{transition:none!important;scroll-behavior:auto}}`;

// ---------- script ----------

export const bootScript = `<script>
(function(){
var KEY='jevlang-theme',root=document.documentElement,mq=matchMedia('(prefers-color-scheme: dark)');
function apply(t){root.dataset.theme=t;var b=document.getElementById('theme-toggle');if(b){b.setAttribute('aria-label','Theme: '+t+'. Click to change');b.innerHTML=b.dataset.icon[Object({system:0,dark:1,light:2})[t]];}}
var stored=null;try{stored=localStorage.getItem(KEY)}catch(e){}
apply(stored&&['dark','light'].includes(stored)?stored:'system');
mq.addEventListener('change',function(){if(!localStorage.getItem(KEY))apply('system')});
document.addEventListener('click',function(e){
var t=e.target.closest('#theme-toggle');if(t){var cur=root.dataset.theme;var next={system:'dark',dark:'light',light:'system'}[cur];try{localStorage.setItem(KEY,next)}catch(_){}apply(next);return;}
var c=e.target.closest('[data-copy]');if(c&&navigator.clipboard){navigator.clipboard.writeText(c.dataset.copy).then(function(){var s=c.querySelector('.copy-state');if(s){s.textContent=' copied'}setTimeout(function(){if(s)s.textContent=''},1200)});return;}
var m=e.target.closest('[data-copy-markdown]');if(m&&navigator.clipboard){fetch('/index.md').then(function(r){return r.text()}).then(function(t){navigator.clipboard.writeText(t);m.textContent='Copied';setTimeout(function(){m.textContent='Copy page as Markdown'},1200);});}
});
})();
</script>`;

// ---------- head ----------

export function head({ title, description, canonical, activeNav, bodyId }) {
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

const iconLink = (l) => `<a class="icon-link" href="${esc(resolveHref(l.href))}" aria-label="${esc(l.label)}">${icon(l.icon)}</a>`;

function resolveHref(h) { return h === 'repo' ? repo : h; }

export function header(active) {
  const navLinks = nav.map((n) => `<a href="${esc(n.href)}"${n.external ? ' class="ext"' : ''}${n.href === active ? ' aria-current="page"' : ''}>${esc(n.label)}${n.external ? ' <span class="ext">↗</span>' : ''}</a>`).join('');
  const iconsRight = links.filter((l) => l.where.includes('header')).map(iconLink).join('');
  return `<a class="skip" href="#main">Skip to content</a>
<header class="site-head"><div class="shell">
<a class="brand" href="/">JevLang</a>
<nav class="site-nav" aria-label="Site">${navLinks}</nav>
<div class="head-icons">${iconsRight}
<button id="theme-toggle" class="theme-toggle" aria-label="Theme: system. Click to change" data-icon='["${'monitor'}","${'moon'}","${'sun'}"]'>${icon('monitor')}</button>
</div>
</div></header>`;
}

export function footer() {
  const cols = footerColumns.map((c) => `<div class="foot-col"><h3>${esc(c.title)}</h3>${c.links.map((l) => `<a href="${esc(resolveHref(l.href))}">${esc(l.label)}${l.external ? ' <span class="ext">↗</span>' : ''}</a>`).join('')}</div>`).join('');
  const iconRow = links.filter((l) => l.where.includes('footer')).map(iconLink).join('');
  return `<footer class="site-foot"><div class="shell">
<p class="credit">${esc(credit)}</p>
<div class="foot-cols">${cols}</div>
<div class="foot-icons">${iconRow}</div>
<p class="copyright">© ${year} linesofcode</p>
</div></footer>`;
}

// ---------- demo renderers ----------

function codeFrame(label, text) {
  return `<figure class="frame frame--stacked demo">
<div class="frame-bar"><span class="dots"><span class="dot"></span><span class="dot"></span><span class="dot"></span></span><span>${esc(label)}</span><span class="chip">source</span></div>
<pre class="frame-body">${esc(text)}</pre>
</figure>`;
}

function terminalFrame(cmd, text) {
  const body = esc(text).split('\n').map((l) => l.startsWith('$ ') ? `<span class="cmd">${l}</span>` : l).join('\n');
  return `<figure class="frame frame--stacked demo">
<div class="frame-bar"><span>$ ${esc(cmd)}</span><span class="chip">captured output</span></div>
<pre class="frame-body">${body}</pre>
</figure>`;
}

function figuresRow(figs) {
  if (!figs?.length) return '';
  return `<div class="figures">${figs.map((f) => `<div class="figure"><b>${esc(f.value)}</b><span>${esc(f.label)}</span></div>`).join('')}</div>`;
}

function moduleTable(rows) {
  return `<div class="tablewrap"><table><thead><tr><th>Export</th><th>What it carries</th></tr></thead><tbody>${rows.map(([a, b]) => `<tr><td>${inlineMd('`' + a + '`')}</td><td>${inlineMd(b)}</td></tr>`).join('')}</tbody></table></div>`;
}

function cloudTable(rows) {
  return `<div class="tablewrap"><table><thead><tr><th>Route</th><th>What it does</th></tr></thead><tbody>${rows.map(([a, b]) => `<tr><td>${inlineMd('`' + a + '`')}</td><td>${inlineMd(b)}</td></tr>`).join('')}</tbody></table></div>`;
}

// ---------- landing page ----------

export function renderLanding({ readme, cloudReadme }) {
  const resolve = makeResolver(readme);
  const modules = modulesTable(readme);
  const cloudApi = cloudApiTable(cloudReadme);

  const sectionHtml = contentSections.map((s) => {
    const demos = s.demos.map((d) => {
      if (d.type === 'code') return codeFrame(d.label, resolve.snippet(d.ref.marker));
      if (d.type === 'terminal') {
        const block = resolve.terminal(d.ref.cmd);
        const figs = d.figures?.map((f) => ({ label: f.label, value: figure(block, f.from) }));
        return figuresRow(figs) + terminalFrame(d.ref.cmd, block);
      }
      if (d.type === 'modules') return moduleTable(modules);
      if (d.type === 'cloud-api') return cloudTable(cloudApi);
      throw new Error(`unknown demo type ${d.type}`);
    }).join('\n');
    const more = s.more ? `<p class="expl" style="margin-top:.6rem">${inlineMd(s.more)}</p>` : '';
    return `<section id="${s.id}" class="section section--band" aria-labelledby="${s.id}-h">
<div class="shell">
<h2 id="${s.id}-h">${esc(s.h2)}</h2>
<p class="expl">${inlineMd(s.p)}${s.doc ? ` <a href="/reference#${slug(s.doc)}">Read the section.</a>` : ''}</p>
${more}
${demos}
</div>
</section>`;
  }).join('\n');

  const asideHtml = asides.map((a) => `<div class="aside"><div class="shell"><p>${inlineMd(a.text)}${a.href ? ` <a href="${esc(a.href)}">${esc(a.label)} <span class="ext">↗</span></a>` : ''}</p></div></div>`).join('\n');

  // splices asides before their section
  let body = sectionHtml;
  for (const a of asides) {
    body = body.replace(`<section id="${a.before}"`, `${asideHtml}<section id="${a.before}"`);
  }

  const boundaryHtml = `<section id="boundaries" class="section" aria-labelledby="boundaries-h">
<div class="shell">
<h2 id="boundaries-h">${esc(boundaries.h2)}</h2>
<p class="expl">What is proven, what is a judgement, and what is not here yet — the same honesty the engine ships with.</p>
<div class="boundaries">
${boundaries.columns.map((c) => `<div class="boundary"><h3>${esc(c.title)}</h3><ul>${c.items.map((i) => `<li>${inlineMd(i)}</li>`).join('')}</ul></div>`).join('')}
</div>
</div>
</section>`;

  const startHtml = `<section id="start" class="section section--band" aria-labelledby="start-h">
<div class="shell">
<h2 id="start-h">${esc(start.h2)}</h2>
<p class="expl">Two panels: install, then verify. The right one is a real run from this checkout.</p>
<div class="panels">
<div>
${figuresRow(start.panels[1].figures.map((f) => ({ label: f.label, value: figure(resolve.terminal(start.panels[1].ref.cmd), f.from) })))}
${codeFrame('shell', '$ ' + start.panels[0].command)}
${terminalFrame(start.panels[1].ref.cmd, resolve.terminal(start.panels[1].ref.cmd))}
</div>
</div>
</div>
</section>`;

  const actions = `<div class="actions">
<button class="control" data-copy="${esc(meta.install)}" aria-label="Copy install command">${icon('copy')} <code>${esc(meta.install)}</code> <span class="copy-state" aria-live="polite"></span></button>
<details class="control">
<summary>${icon('chevron')} For agents</summary>
<div class="menu">
<a href="/llms.txt">llms.txt</a>
<a href="/AGENTS.md">AGENTS.md</a>
<button data-copy-markdown aria-label="Copy page as Markdown">Copy page as Markdown</button>
</div>
</details>
<a class="control control--solid" href="/reference">${icon('book')} Documentation</a>
</div>`;

  const hero = `<section class="hero"><div class="shell">
<span class="mark">${productMark}</span>
<h1>${esc(meta.h1)}</h1>
<p class="lede">${inlineMd(meta.lede)}</p>
${actions}
<p class="muted">Currently v${esc(version)} · MIT license · nothing published to npm yet, install from the repo</p>
</div></section>`;

  return `<!doctype html>
<html lang="en">
${head({ title: `${meta.name} — ${meta.tagline}`, description: meta.description, canonical: url('/') })}
<body id="landing">
${header('/')}
<main id="main">
${hero}
${body}
${boundaryHtml}
${startHtml}
</main>
${footer()}
${bootScript}
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
${bootScript}
</body>
</html>`;
}

// ---------- sibling artefacts ----------

export function llmsText({ readme }) {
  const resolve = makeResolver(readme);
  const parts = [`# ${meta.name}`, '', meta.description, '', `Repo: ${repo}`, `Reference: ${url('/reference')}`, ''];
  for (const s of contentSections) {
    parts.push(`## ${s.h2}`, '', inlinePlain(s.p), '');
    for (const d of s.demos) {
      if (d.type === 'code') parts.push('```', resolve.snippet(d.ref.marker), '```', '');
      if (d.type === 'terminal') parts.push('```sh', resolve.terminal(d.ref.cmd), '```', '');
    }
  }
  parts.push(`## ${boundaries.h2}`, '');
  for (const c of boundaries.columns) parts.push(`${c.title}:`, ...c.items.map((i) => `- ${inlinePlain(i)}`), '');
  return parts.join('\n');
}

const inlinePlain = (t) => t
  .replace(/\((?:REPO|CLOUDREPO)\)/g, (m) => `(${m === '(REPO)' ? repo : cloudRepo})`)
  .replace(/`([^`]+)`/g, '$1')
  .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');

export function agentsMd({ readme }) {
  const resolve = makeResolver(readme);
  const snippetHello = resolve.snippet("const spam = noul('spam?'");
  return `# AGENTS.md — using ${meta.name} from an agent

Install: \`npm install github:TimMikeladze/JevLang\` (nothing on npm yet). Node 22+,
no runtime dependencies. Pure decisions, validation and replay work offline.

Minimal working policy (from the README, verified by the captured runs there):

\`\`\`typescript
${snippetHello}
\`\`\`

Decide with \`policy.decide({ 'spam?': { noul: 0.97 } })\` — every question needs an
answer; \`choice\` answers carry \`{ choice, confidence }\`, \`noul\` answers \`{ noul }\`.

## Options that matter

| Option | Effect |
| --- | --- |
| \`questions\` | declared \`noul\` / \`choice\` / \`score\` questions; answers are validated against them |
| \`gates\` | \`gate(question, bar, escalate(...))\` — below the bar, escalate instead of guessing |
| \`route.clauses\` | ordered rules; first match wins, clause order is policy |
| \`route.otherwise\` | the no-match action; a route with a hole is refused |
| \`state\` / \`stateOptions\` | what the decision may see, redacted and capped |

## Three mistakes that break it

${agentsMistakes.map((m) => `- ${m}`).join('\n')}

Full reference: ${url('/reference')}. Repo: ${repo}.
`;
}

export function pageMarkdown() {
  const parts = [`# ${meta.name} — ${meta.h1}`, '', inlinePlain(meta.lede), '', `Install: \`${meta.install}\` · Currently v${version}`, ''];
  for (const s of contentSections) parts.push(`## ${s.h2}`, '', inlinePlain(s.p), '');
  parts.push(`## ${boundaries.h2}`, '');
  for (const c of boundaries.columns) parts.push(`**${c.title}**`, ...c.items.map((i) => `- ${inlinePlain(i)}`), '');
  parts.push(`## ${start.h2}`, '', `\`\`\`sh\n$ ${start.panels[0].command}\n\`\`\``, '');
  return parts.join('\n');
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
