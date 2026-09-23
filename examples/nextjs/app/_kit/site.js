// One authored link list drives the header and the footer, as on jevlang.sh.
export const repo = 'https://github.com/TimMikeladze/JevLang';
export const exampleSource = `${repo}/tree/main/examples/nextjs`;

export const nav = [
  { label: 'Home', href: '/' },
  { label: 'Reference', href: '/reference' },
  { label: 'Examples', href: '/examples' },
  { label: 'Tenant hotline', href: '/examples/maintenance' },
  { label: 'SMS host', href: '/examples/reservation' },
  { label: 'Courier app', href: '/examples/doorstep' },
];

export const iconLinks = [
  { label: 'JevLang on GitHub', href: repo, icon: 'github', where: ['header', 'footer'] },
  { label: 'linesofcode on X', href: 'https://x.com/linesofcode', icon: 'x', where: ['header', 'footer'] },
  { label: 'Tim Mikeladze on LinkedIn', href: 'https://www.linkedin.com/in/tim-mikeladze', icon: 'linkedin', where: ['header', 'footer'] },
  { label: 'linesofcode on Discord', href: 'https://discord.com/users/linesofcode', icon: 'discord', where: ['footer'] },
];

export const footerColumns = [
  { title: 'Examples', links: [
    { label: 'Overview', href: '/examples' },
    { label: 'Tenant hotline', href: '/examples/maintenance' },
    { label: 'SMS host', href: '/examples/reservation' },
    { label: 'Courier app', href: '/examples/doorstep' },
  ] },
  { title: 'JevLang', links: [
    { label: 'Home', href: '/' },
    { label: 'Reference', href: '/reference' },
    { label: 'Example source', href: exampleSource, external: true },
  ] },
  { title: 'Community', links: [
    { label: 'X', href: 'https://x.com/linesofcode', external: true },
    { label: 'GitHub', href: repo, external: true },
    { label: 'LinkedIn', href: 'https://www.linkedin.com/in/tim-mikeladze', external: true },
    { label: 'Discord', href: 'https://discord.com/users/linesofcode', external: true },
  ] },
];

// Same key as jevlang.sh, so a visitor's theme carries over. Runs in <head>
// before paint: resolves the stored preference, cycles system → dark → light
// on the toggle, and follows the OS live in system mode.
export const themeBoot = `(function(){
var K='jevlang-theme',r=document.documentElement,mq=matchMedia('(prefers-color-scheme: dark)');
function saved(){try{var s=localStorage.getItem(K);return s==='dark'||s==='light'?s:'system'}catch(e){return'system'}}
function set(p){r.dataset.pref=p;r.dataset.theme=p==='system'?(mq.matches?'dark':'light'):p;var b=document.getElementById('theme-toggle');if(b)b.setAttribute('aria-label','Theme: '+p+'. Click to change')}
set(saved());
document.addEventListener('DOMContentLoaded',function(){set(r.dataset.pref)});
mq.addEventListener('change',function(){if(r.dataset.pref==='system')set('system')});
document.addEventListener('click',function(e){if(!e.target.closest('#theme-toggle'))return;var n={system:'dark',dark:'light',light:'system'}[r.dataset.pref];try{n==='system'?localStorage.removeItem(K):localStorage.setItem(K,n)}catch(x){}set(n)});
})();`;
