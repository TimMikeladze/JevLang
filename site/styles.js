// The stylesheet. OKLCH tokens, dark first; the light set is applied by
// data-theme and, with no script, by the OS setting. Colour is meaning:
// green assign/allow, amber escalate/page/ask, red hold/deny, and the accent
// marks the model — the one step that leaves the machine. The chrome is grey.

const dark = `--paper:oklch(12.5% 0 0);--band:oklch(15.5% 0 0);--raise:oklch(18.5% 0 0);
--ink:oklch(98.5% 0 0);--body:oklch(78% 0 0);--soft:oklch(63% 0 0);
--line:oklch(100% 0 0/.11);--line-soft:oklch(100% 0 0/.06);
--accent:oklch(70% .16 250);--add:oklch(72% .17 150);--del:oklch(68% .19 20);--warn:oklch(78% .15 85);
--tk-kw:oklch(73% .13 250);--tk-str:oklch(74% .15 150);--tk-num:oklch(80% .13 85);--tk-fn:oklch(76% .13 300);--tk-cmt:oklch(62% 0 0)`;

const light = `--paper:oklch(99% 0 0);--band:oklch(97% 0 0);--raise:oklch(100% 0 0);
--ink:oklch(14.5% 0 0);--body:oklch(38% 0 0);--soft:oklch(48% 0 0);
--line:oklch(0% 0 0/.12);--line-soft:oklch(0% 0 0/.06);
--accent:oklch(52% .18 250);--add:oklch(48% .16 150);--del:oklch(50% .19 25);--warn:oklch(50% .13 80);
--tk-kw:oklch(50% .14 250);--tk-str:oklch(46% .15 150);--tk-num:oklch(50% .13 80);--tk-fn:oklch(50% .14 300);--tk-cmt:oklch(48% 0 0)`;

export const css = String.raw`:root{color-scheme:dark;${dark};
--sans:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
--mono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace}
:root[data-theme=light]{color-scheme:light;${light}}
@media (prefers-color-scheme:light){:root:not([data-theme=dark]):not([data-theme=light]){color-scheme:light;${light}}}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:var(--paper);color:var(--body);font:1rem/1.6 var(--sans);-webkit-text-size-adjust:100%}
.shell{width:min(1180px,calc(100% - 3rem));margin-inline:auto}
a{color:var(--ink);text-decoration:underline;text-underline-offset:.18em;text-decoration-color:var(--line)}
a:hover{text-decoration-color:var(--accent)}
code{font-family:var(--mono);font-size:.9em;color:var(--ink);background:var(--raise);padding:.1em .32em;border-radius:.28rem}
h1,h2,h3{color:var(--ink);font-weight:700}
h1{font-size:clamp(2.6rem,6vw,4.2rem);line-height:1.03;letter-spacing:-.04em;max-width:16ch;margin:1.4rem 0 1.3rem}
h2{font-size:clamp(1.35rem,2.4vw,1.7rem);line-height:1.2;font-weight:650;letter-spacing:-.02em;margin:0}
.lede{font-size:clamp(1.05rem,1.6vw,1.2rem);line-height:1.55;max-width:58ch;margin:0 0 1.8rem}
.muted{color:var(--soft);font-size:.875rem;margin:0}
.section{padding-block:clamp(3.5rem,7vw,6rem);scroll-margin-top:4.5rem}
.section--band{background:var(--band)}
.section h2+.expl{margin-top:.6rem}
.expl{max-width:68ch;margin:0}
.demo{margin-top:1rem}
.expl+.demo{margin-top:1.6rem}
.skip{position:absolute;left:-9999px}
.skip:focus{left:1rem;top:1rem;z-index:99;background:var(--raise);color:var(--ink);padding:.5rem .8rem;border-radius:.4rem}
:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
/* header */
.site-head{position:sticky;top:0;z-index:10;min-height:3.75rem;background:color-mix(in oklab,var(--paper) 82%,transparent);-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);border-bottom:1px solid var(--line)}
.site-head .shell{display:flex;align-items:center;gap:1.1rem;min-height:3.75rem}
.brand{display:inline-flex;align-items:center;gap:.55rem;font-weight:700;font-size:1.05rem;color:var(--ink);text-decoration:none}
.brand-mark{display:inline-flex;width:1.65rem;height:1.65rem;flex:none}
.brand-mark svg{width:100%;height:100%}
.brand-word{letter-spacing:-.01em}
.site-nav{display:flex;gap:1.3rem}
.site-nav a{position:relative;padding-block:.3rem;font-size:.875rem;color:var(--soft);text-decoration:none;transition:color .14s ease}
.site-nav a::after{content:"";position:absolute;left:0;right:0;bottom:0;height:2px;background:var(--accent);border-radius:1px;transform:scaleX(0);transition:transform .16s ease}
.site-nav a:hover,.site-nav a[aria-current=page]{color:var(--ink)}
.site-nav a:hover::after,.site-nav a[aria-current=page]::after{transform:scaleX(1)}
.head-icons{margin-left:auto;display:flex;align-items:center;gap:.75rem}
.icon-link{color:var(--soft);display:inline-flex;transition:color .14s ease}
.icon-link:hover{color:var(--ink)}
.head-div{width:1px;height:1.15rem;background:var(--line);flex:none}
.ext{font-size:.75em;opacity:.5}
/* theme toggle */
.theme-toggle{background:none;border:0;color:var(--soft);cursor:pointer;padding:.2rem;display:inline-flex;border-radius:.4rem;transition:color .14s ease}
.theme-toggle:hover{color:var(--ink)}
.theme-toggle .i{display:none;line-height:0}
:root[data-pref=dark] .theme-toggle .i-dark{display:inline-flex}
:root[data-pref=light] .theme-toggle .i-light{display:inline-flex}
:root[data-pref=system] .theme-toggle .i-system,:root:not([data-pref]) .theme-toggle .i-system{display:inline-flex}
/* hero */
.hero{padding-block:clamp(3.5rem,7vw,6rem) clamp(3rem,6vw,5rem)}
.hero .mark{display:inline-block;line-height:0}
.mark-tile{fill:var(--raise);stroke:var(--line)}
.mark-glyph{stroke:var(--ink)}
.actions{display:flex;flex-wrap:wrap;gap:.7rem;align-items:center;margin:0 0 1.1rem}
.control{display:inline-flex;align-items:center;gap:.5rem;padding:.62rem .85rem;border-radius:.6rem;border:1px solid var(--line);background:var(--raise);color:var(--ink);font:500 .9rem/1.15 var(--sans);text-decoration:none;transition:background .14s ease,border-color .14s ease;cursor:pointer}
.control:hover{border-color:var(--line);background:color-mix(in oklab,var(--raise) 80%,var(--ink) 4%)}
.control code{font:.88rem/1 var(--mono);background:none;padding:0}
.control--solid{background:var(--ink);color:var(--paper);border-color:transparent;font-weight:550}
.control--solid:hover{background:color-mix(in oklab,var(--ink) 88%,var(--paper))}
.control--chip{padding-block:.25rem;padding-right:.3rem;cursor:text}
.control--chip .copy-btn{padding:.3rem;margin-left:.2rem}
details.control{position:relative}
details.control summary{list-style:none;display:inline-flex;align-items:center;gap:.5rem;cursor:pointer}
details.control summary::-webkit-details-marker{display:none}
.menu{position:absolute;top:calc(100% + .5rem);left:0;background:var(--raise);border:1px solid var(--line);border-radius:.6rem;padding:.4rem;min-width:16rem;z-index:5}
.menu-items{display:grid;gap:.1rem}
.menu-items a,.menu-items button{display:flex;width:100%;text-align:left;padding:.45rem .6rem;border-radius:.4rem;color:var(--body);text-decoration:none;font:.875rem/1.4 var(--sans);background:none;border:0;cursor:pointer}
.menu-items a:hover,.menu-items button:hover{background:var(--band);color:var(--ink)}
/* copy buttons only exist with script */
.copy-btn{display:none;align-items:center;gap:.35rem;background:none;border:1px solid transparent;border-radius:.4rem;color:var(--soft);cursor:pointer;padding:.3rem .45rem;font:500 .72rem/1 var(--mono);transition:color .14s ease,border-color .14s ease}
html[data-js] .copy-btn{display:inline-flex}
.copy-btn:hover{color:var(--ink);border-color:var(--line)}
.copy-btn[data-done]{color:var(--add)}
.copy-btn .lbl-done,.menu-items .lbl-done{display:none}
[data-done] .lbl{display:none}
[data-done] .lbl-done{display:inline}
/* frames: code and captured output */
.frame{border:1px solid var(--line);border-radius:.7rem;overflow:hidden;background:var(--paper);margin:0}
.frame-bar{display:flex;align-items:center;gap:.75rem;background:var(--band);border-bottom:1px solid var(--line-soft);padding:.5rem .6rem .5rem .9rem;font:500 .8rem/1.5 var(--mono);color:var(--soft);min-height:2.6rem}
.section--band .frame-bar{background:var(--raise)}
.frame-bar .dots{display:flex;gap:6px;flex:none}
.dot{width:10px;height:10px;border-radius:50%}
.dot:nth-child(1){background:oklch(66% .19 25)}
.dot:nth-child(2){background:oklch(78% .15 85)}
.dot:nth-child(3){background:oklch(70% .17 150)}
.frame-bar .name{min-width:0;flex:1;overflow-wrap:anywhere}
.frame-bar .name b{color:var(--ink);font-weight:600}
.frame-bar .chip{flex:none;border:1px solid var(--line-soft);border-radius:.4rem;padding:.2rem .5rem;font-size:.68rem;text-transform:uppercase;letter-spacing:.06em}
.chip--captured{color:var(--add)}
.frame-body{margin:0;padding:1rem .9rem;font:.8rem/1.6 var(--mono);color:var(--body);overflow-x:auto;background:var(--paper);tab-size:2}
.frame-body--out{white-space:pre-wrap;overflow-wrap:anywhere}
.frame-body code{background:none;padding:0;font-size:inherit;color:inherit;border-radius:0}
.cmd{color:var(--ink);font-weight:600}
.frame-note{margin:0;padding:.55rem .9rem;border-top:1px solid var(--line-soft);background:var(--band);font:.75rem/1.5 var(--mono);color:var(--soft)}
.section--band .frame-note{background:var(--raise)}
.frame-note b{color:var(--ink);font-weight:500}
.tk-kw{color:var(--tk-kw)}.tk-str{color:var(--tk-str)}.tk-num{color:var(--tk-num)}.tk-fn{color:var(--tk-fn)}.tk-cmt{color:var(--tk-cmt);font-style:italic}
.tk-key{color:var(--accent)}.tk-dim{color:var(--soft)}.tk-fix{color:var(--add)}.tk-ink{color:var(--ink)}
.act-assign,.act-allow{color:var(--add);font-weight:600}
.act-escalate,.act-page,.act-ask{color:var(--warn);font-weight:600}
.act-hold,.act-deny{color:var(--del);font-weight:600}
.cmdline .frame-bar{border-bottom:0}
/* numbered steps */
.steps{list-style:none;margin:1.6rem 0 0;padding:0;display:grid;gap:2rem}
.step{display:grid;grid-template-columns:2rem minmax(0,1fr);gap:1rem}
.step-n{width:2rem;height:2rem;border:1px solid var(--line);border-radius:50%;display:grid;place-items:center;font:600 .8rem/1 var(--mono);color:var(--ink);background:var(--raise);margin-top:.05rem}
.step-title{margin:.25rem 0 .7rem;color:var(--ink);font-weight:600;line-height:1.4}
.step-title code{font-weight:500}
.step-body{min-width:0}
.step-body>.frame+.frame{margin-top:.8rem}
/* diagrams: real elements, so the text stays real size at any width */
.diagram{border:1px solid var(--line);border-radius:.7rem;background:var(--paper);padding:1.4rem 1.3rem 1.1rem;margin:0}
.diagram figcaption{margin-top:1.1rem;font:.75rem/1.55 var(--mono);color:var(--soft)}
.diagram figcaption b{color:var(--ink);font-weight:500}
.tag{display:inline-block;font:600 .72rem/1 var(--mono);padding:.28rem .5rem;border-radius:.35rem;border:1px solid transparent;letter-spacing:.02em;white-space:nowrap}
.tag--assign,.tag--allow{color:var(--add);background:color-mix(in oklab,var(--add) 13%,var(--paper));border-color:color-mix(in oklab,var(--add) 30%,transparent)}
.tag--escalate,.tag--page,.tag--ask{color:var(--warn);background:color-mix(in oklab,var(--warn) 13%,var(--paper));border-color:color-mix(in oklab,var(--warn) 32%,transparent)}
.tag--hold,.tag--deny{color:var(--del);background:color-mix(in oklab,var(--del) 13%,var(--paper));border-color:color-mix(in oklab,var(--del) 30%,transparent)}
.tag--model{color:var(--accent);background:color-mix(in oklab,var(--accent) 12%,var(--paper));border-color:color-mix(in oklab,var(--accent) 34%,transparent)}
/* flow: ordered boxes joined by labelled arrows */
.flow{display:grid;grid-template-columns:minmax(0,1fr) 4.4rem minmax(0,1fr) 4.4rem minmax(0,1fr) 4.4rem minmax(0,1fr);align-items:stretch}
.flow--3{grid-template-columns:minmax(0,1fr) 4.4rem minmax(0,1fr) 4.4rem minmax(0,1fr)}
.flow-step{display:flex;flex-direction:column;gap:.45rem;min-width:0;border:1px solid var(--line);border-radius:.6rem;background:var(--raise);padding:.9rem 1rem 1rem}
.flow-step--model{border-color:var(--accent)}
.flow-n{font:600 .68rem/1 var(--mono);color:var(--soft);letter-spacing:.08em;text-transform:uppercase}
.flow-title{color:var(--ink);font-weight:650;font-size:1rem;line-height:1.25}
.flow-api{font:.76rem/1.4 var(--mono);color:var(--soft);overflow-wrap:anywhere}
.flow-api code{background:none;padding:0;font-size:1em;color:var(--soft)}
.flow-data code,.rung code{background:var(--paper)}
.flow-data{margin-top:auto;padding-top:.75rem;border-top:1px dashed var(--line);font:.76rem/1.6 var(--mono);color:var(--body);overflow-wrap:anywhere}
.flow-data p{margin:0}
.flow-data .q{color:var(--ink)}
.flow-data .n{color:var(--accent)}
.flow-data .dim{color:var(--soft)}
.flow-quote{font:.8rem/1.5 var(--sans);font-style:italic;color:var(--body)}
.flow-link{position:relative;align-self:center;height:1.5px;background:color-mix(in oklab,var(--body) 42%,transparent);margin-inline:.2rem}
.flow-link::after{content:"";position:absolute;right:-1px;top:-4px;border:4.5px solid transparent;border-left:7px solid color-mix(in oklab,var(--body) 55%,transparent);border-right:0}
.flow-link span{position:absolute;left:0;right:0;bottom:.5rem;text-align:center;font:.68rem/1 var(--mono);color:var(--soft)}
/* answers: one ticket, three answers */
.answers{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:1rem}
.answer{border:1px solid var(--line);border-radius:.6rem;background:var(--raise);padding:1rem;display:flex;flex-direction:column;gap:.65rem;min-width:0}
.answer-head{display:flex;align-items:baseline;justify-content:space-between;gap:.6rem;flex-wrap:wrap}
.answer-head code{background:none;padding:0;font-weight:600;font-size:.95rem}
.answer-head span{font:.76rem/1.3 var(--mono);color:var(--soft);overflow-wrap:anywhere}
.answer-use{margin:0;font-size:.85rem;line-height:1.45;color:var(--body)}
.answer-vis{margin-bottom:auto;display:grid;gap:.8rem}
.bars{display:grid;gap:.5rem}
.bar{display:grid;grid-template-columns:minmax(0,1fr) 2.6rem;gap:.15rem .6rem;align-items:center}
.bar-label{grid-column:1/-1;font:.74rem/1.3 var(--mono);color:var(--body);overflow-wrap:anywhere}
.bar-label--top{color:var(--ink)}
.bar-track{height:.55rem;border-radius:99px;background:color-mix(in oklab,var(--body) 16%,transparent);overflow:hidden}
.bar-fill{display:block;height:100%;border-radius:99px;background:color-mix(in oklab,var(--body) 50%,transparent)}
.bar--top .bar-fill{background:var(--accent)}
.bar-val{font:.74rem/1 var(--mono);color:var(--body);text-align:right}
.bar--top .bar-val{color:var(--accent)}
.pills{display:flex;flex-wrap:wrap;gap:.4rem}
.pill{font:.74rem/1 var(--mono);padding:.32rem .55rem;border-radius:99px;border:1px solid var(--line);color:var(--soft)}
.pill--top{border-color:var(--accent);color:var(--accent)}
.answer-shape{display:block;margin-top:.2rem;padding:.55rem .65rem;border-radius:.4rem;background:var(--paper);border:1px solid var(--line-soft);font:.74rem/1.5 var(--mono);color:var(--ink);overflow-wrap:anywhere;white-space:normal}
/* meter: a confidence axis with a gate bar */
.meter{position:relative;padding-top:2.3rem}
.meter-track{position:relative;height:2.6rem;display:flex;border-radius:.4rem;overflow:hidden;border:1px solid var(--line)}
.meter-zone{display:block;height:100%}
.meter-zone--low{background:color-mix(in oklab,var(--warn) 14%,var(--paper))}
.meter-zone--high{background:color-mix(in oklab,var(--add) 14%,var(--paper))}
.meter-key{display:flex;flex-wrap:wrap;gap:.4rem 1.4rem;margin-top:.9rem;font:.74rem/1.3 var(--mono);color:var(--soft)}
.key::before{content:"";display:inline-block;width:.7rem;height:.7rem;border-radius:2px;margin-right:.45rem;vertical-align:-1px}
.key--low::before{background:var(--warn)}
.key--high::before{background:var(--add)}
.meter-pins{position:absolute;left:0;right:0;top:2.3rem;height:2.6rem;pointer-events:none}
.meter-bar{position:absolute;top:-.55rem;bottom:-.55rem;width:2px;background:var(--ink)}
.meter-bar b{position:absolute;bottom:100%;left:-3rem;width:calc(6rem + 2px);padding-bottom:.25rem;text-align:center;font:600 .74rem/1 var(--mono);color:var(--ink)}
.meter-pin{position:absolute;top:50%;width:14px;height:14px;margin:-7px 0 0 -7px;border-radius:50%;border:2px solid var(--paper)}
.meter-pin--low{background:var(--warn)}
.meter-pin--high{background:var(--add)}
.meter-scale{display:flex;justify-content:space-between;margin-top:.45rem;font:.7rem/1 var(--mono);color:var(--soft)}
.meter-legend{list-style:none;margin:1.3rem 0 0;padding:0;display:grid;gap:.7rem}
.meter-legend li{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem .7rem;font-size:.88rem;line-height:1.4}
.meter-legend .pin{width:12px;height:12px;border-radius:50%;flex:none}
.meter-legend .pin--low{background:var(--warn)}
.meter-legend .pin--high{background:var(--add)}
.meter-legend .v{font:600 .82rem/1 var(--mono);color:var(--ink)}
.meter-legend .to{color:var(--soft)}
.meter-legend .t{font:.82rem/1 var(--mono);color:var(--ink)}
/* ladder: checked from the top, first match wins */
.ladder{list-style:none;margin:0;padding:0}
.ladder-head{margin:0 0 .75rem;font:600 .72rem/1.3 var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--soft)}
.ladder+.ladder-head{margin-top:1.8rem}
.rung{position:relative;display:grid;grid-template-columns:1.9rem minmax(0,1fr) auto;gap:.3rem 1rem;align-items:center;padding:.75rem .9rem;border:1px solid var(--line);border-radius:.6rem;background:var(--raise)}
.rung+.rung{margin-top:1.55rem}
.rung+.rung::before{content:"";position:absolute;left:1.85rem;top:-1.55rem;height:1.55rem;border-left:1.5px solid color-mix(in oklab,var(--body) 42%,transparent)}
.rung+.rung::after{content:attr(data-miss);position:absolute;left:2.4rem;top:-1.55rem;line-height:1.55rem;font:.68rem/1.55rem var(--mono);color:var(--soft)}
.rung-n{width:1.9rem;height:1.9rem;border-radius:50%;display:grid;place-items:center;font:600 .74rem/1 var(--mono);color:var(--ink);background:var(--paper);border:1px solid var(--line)}
.rung-when{font:.8rem/1.5 var(--mono);color:var(--ink);overflow-wrap:anywhere;min-width:0}
.rung-when small{display:block;font:.72rem/1.4 var(--sans);color:var(--soft);margin-top:.15rem}
.rung-then{display:flex;align-items:center;gap:.55rem;font:.8rem/1.3 var(--mono);color:var(--ink);white-space:nowrap}
.rung-then .arrow{color:var(--soft)}
.rung--end{border-style:dashed;background:transparent}
.rung--end .rung-when{color:var(--body)}
.rung--end .rung-n{border-style:dashed;background:transparent;color:var(--soft)}
/* annotated output: a real captured frame with a note per line */
.annotated .frame-body{padding:0;white-space:normal}
.ann-row{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(0,1fr);border-top:1px solid var(--line-soft)}
.ann-row:first-child{border-top:0}
.ann-code{margin:0;padding:.8rem .9rem;font:.8rem/1.6 var(--mono);color:var(--body);white-space:pre-wrap;overflow-wrap:anywhere;min-width:0}
.ann-note{margin:0;padding:.8rem 1rem;border-left:1px solid var(--line-soft);font:.86rem/1.5 var(--sans);color:var(--body);min-width:0}
.ann-note b{color:var(--ink);font-weight:600}
/* doors: one policy, many ways in */
.doors{display:grid;grid-template-columns:minmax(11rem,15rem) minmax(0,1fr);gap:0 3rem;align-items:center}
.doors-src{border:1px solid var(--line);border-radius:.6rem;background:var(--raise);padding:1rem;display:grid;gap:.4rem;position:relative}
.doors-src strong{color:var(--ink);font-size:1rem}
.doors-src code{background:none;padding:0;font-size:.8rem;color:var(--soft)}
.doors-src::after{content:"";position:absolute;left:100%;top:50%;width:3rem;border-top:1.5px solid color-mix(in oklab,var(--body) 42%,transparent)}
.doors-list{list-style:none;margin:0;padding:0 0 0 1.6rem;border-left:1.5px solid color-mix(in oklab,var(--body) 42%,transparent);display:grid;gap:.8rem}
.door{position:relative;display:grid;grid-template-columns:minmax(0,11rem) minmax(0,1fr);gap:.2rem 1.2rem;align-items:baseline;padding:.75rem .9rem;border:1px solid var(--line);border-radius:.6rem;background:var(--raise)}
.door::before{content:"";position:absolute;left:-1.6rem;top:50%;width:1.6rem;border-top:1.5px solid color-mix(in oklab,var(--body) 42%,transparent)}
.door strong{color:var(--ink);font-size:.9rem}
.door code{background:none;padding:0;font-size:.8rem;overflow-wrap:anywhere}
.door span{grid-column:2;font-size:.82rem;line-height:1.45;color:var(--soft)}
/* tables */
.tablewrap{margin-top:1.6rem;overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:.9rem}
th{font:600 .72rem/1.4 var(--mono);text-transform:uppercase;letter-spacing:.08em;color:var(--soft);text-align:left;padding:.55rem .9rem .35rem}
td{padding:.55rem .9rem;border-top:1px solid var(--line-soft);color:var(--body);vertical-align:top}
td:first-child{font-family:var(--mono);font-size:.82rem;color:var(--ink);white-space:nowrap}
td code{font-size:.8rem}
.table-title{margin:2.4rem 0 0;font:600 .72rem/1.3 var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--soft)}
.table-title+.tablewrap{margin-top:.5rem}
/* boundaries */
.boundaries{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:var(--line-soft);border:1px solid var(--line-soft);border-radius:.7rem;overflow:hidden;margin-top:1.6rem}
.boundary{background:var(--paper);padding:1.4rem 1.3rem;border-top:3px solid transparent}
.boundary:nth-child(1){border-top-color:var(--add)}
.boundary:nth-child(2){border-top-color:var(--warn)}
.boundary:nth-child(3){border-top-color:var(--del)}
.boundary h3{display:flex;align-items:baseline;justify-content:space-between;font:600 .85rem/1.2 var(--sans);margin:0 0 .8rem}
.boundary:nth-child(1) h3{color:var(--add)}
.boundary:nth-child(2) h3{color:var(--warn)}
.boundary:nth-child(3) h3{color:var(--del)}
.boundary h3 span{font:500 .75rem/1 var(--mono);color:var(--soft)}
.boundary li{margin:.55rem 0;font-size:.9rem;line-height:1.5}
.boundary ul{margin:0;padding-left:1.1rem}
/* aside */
.aside{padding-block:1.4rem;border-top:1px solid var(--line-soft);border-bottom:1px solid var(--line-soft);background:var(--paper)}
.aside p{margin:0;max-width:68ch;font-size:.95rem}
/* start */
.panels{display:grid;grid-template-columns:1fr 1fr;gap:1.2rem;margin-top:1.6rem}
.panels>*{min-width:0}
.panels .demo:first-of-type{margin-top:0}
.panel-title{margin:0 0 .6rem;font:600 .72rem/1.3 var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--soft)}
.figures{display:flex;gap:2rem;flex-wrap:wrap;margin:0 0 .8rem}
.figure b{display:block;font:650 1.15rem/1.2 var(--mono);color:var(--accent)}
.figure span{font:.8rem/1.4 var(--mono);color:var(--soft)}
/* footer */
.site-foot{border-top:1px solid var(--line);padding-block:3rem 2rem}
.site-foot .credit{max-width:60ch;color:var(--soft);font-size:.9rem;margin:0 0 2rem}
.foot-cols{display:flex;gap:4rem;flex-wrap:wrap}
.foot-col h3{font:600 .85rem/1.3 var(--sans);margin:0 0 .6rem}
.foot-col a{display:block;font-size:.85rem;color:var(--soft);text-decoration:none;padding:.18rem 0;transition:color .14s ease}
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
.ref-doc h1{font-size:clamp(2rem,4vw,2.8rem);max-width:none}
.ref-doc h2{font-size:1.4rem;margin:2.4rem 0 .8rem;scroll-margin-top:4.5rem}
.ref-doc pre{background:var(--raise);border:1px solid var(--line-soft);border-radius:.6rem;padding:1rem;overflow-x:auto}
.ref-doc pre code{background:none;padding:0;font-size:.82rem;line-height:1.6}
.ref-doc table td:first-child{white-space:normal}
.ref-doc li{margin:.3rem 0}
@media (max-width:1000px){
.flow,.flow--3{grid-template-columns:minmax(0,1fr)}
.flow-link{width:1.5px;height:2.6rem;justify-self:center;margin:0}
.flow-link::after{right:auto;left:-4px;top:auto;bottom:-1px;border:4.5px solid transparent;border-top:7px solid color-mix(in oklab,var(--body) 55%,transparent);border-bottom:0}
.flow-link span{left:.9rem;right:auto;bottom:auto;top:50%;margin-top:-.4rem;text-align:left}
.answers{grid-template-columns:minmax(0,1fr)}
}
@media (max-width:900px){.ref-layout{grid-template-columns:minmax(0,1fr)}.ref-toc{position:static;max-height:none;border-bottom:1px solid var(--line-soft);padding-bottom:1rem}}
@media (max-width:720px){
.shell{width:calc(100% - 2rem)}
.frame-bar--cmd{flex-wrap:wrap;row-gap:.3rem}
.frame-bar--cmd .name{flex:1 1 100%}
.frame-bar--cmd .copy-btn{margin-left:auto}
.tablewrap table,.tablewrap tbody,.tablewrap tr,.tablewrap td{display:block;width:100%}
.tablewrap thead{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
.tablewrap tr{padding:.75rem 0;border-top:1px solid var(--line-soft)}
.tablewrap td{border:0;padding:.15rem 0;overflow-wrap:anywhere}
.tablewrap td:first-child{white-space:normal}
.tablewrap td[data-label]::before{content:attr(data-label);display:block;margin-top:.35rem;font:600 .66rem/1.4 var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--soft)}
.tablewrap td[data-label]:first-child::before{display:none}
.site-nav{display:none}
.panels,.boundaries{grid-template-columns:minmax(0,1fr)}
h1{font-size:2.6rem}
.frame{border-radius:0;border-left:0;border-right:0;margin-inline:-1rem}
.diagram{border-radius:0;border-left:0;border-right:0;margin-inline:-1rem;padding-inline:1rem}
.step{grid-template-columns:minmax(0,1fr)}
.step-n{display:none}
.doors{grid-template-columns:minmax(0,1fr);gap:1rem}
.doors-src::after{left:1.4rem;top:100%;width:0;height:1rem;border-top:0;border-left:1.5px solid color-mix(in oklab,var(--body) 42%,transparent)}
.doors-list{padding-left:1rem}
.door{grid-template-columns:minmax(0,1fr)}
.door::before{left:-1rem;width:1rem}
.door span{grid-column:1}
.ann-row{grid-template-columns:minmax(0,1fr)}
.ann-note{border-left:0;border-top:1px dashed var(--line-soft);padding-top:.6rem}
.rung{grid-template-columns:1.9rem minmax(0,1fr)}
.rung-then{grid-column:2}
}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important;scroll-behavior:auto}}`;
