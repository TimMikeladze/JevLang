import './globals.css';
import { Icon, Mark } from './_kit/icons.js';
import Nav from './_kit/Nav.js';
import { iconLinks, footerColumns, themeBoot } from './_kit/site.js';

export const metadata = {
  title: 'JevLang on Next.js — policy-backed API routes',
  description: 'Three Next.js API routes, each decided by a JevLang policy: a tenant hotline, a restaurant SMS host and a courier app, logged to Upstash Redis and rate limited.',
  icons: { icon: `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" rx="11" fill="#1c1c1c"/><path d="M30 12v16.5c0 4.5-3 7.5-7.5 7.5S15 33 15 29.5" fill="none" stroke="#f7f7f7" stroke-width="3.4" stroke-linecap="round"/></svg>')}` },
};
export const viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: dark)', color: '#1f1f1f' },
    { media: '(prefers-color-scheme: light)', color: '#fcfcfc' },
  ],
};

const IconLink = ({ l }) => (
  <a className="icon-link" href={l.href} target="_blank" rel="noopener"><Icon name={l.icon} /><span className="sr">{l.label}</span></a>
);

export default function RootLayout({ children }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBoot }} />
      </head>
      <body>
        <a className="skip" href="#main">Skip to content</a>
        <header className="site-head">
          <div className="shell shell--wide">
            <a className="brand" href="/"><Mark size={26} /><span>JevLang</span></a>
            <Nav />
            <div className="head-icons">
              {iconLinks.filter(l => l.where.includes('header')).map(l => <IconLink key={l.icon} l={l} />)}
              <span className="head-div" aria-hidden="true" />
              <button id="theme-toggle" className="theme-toggle" type="button" aria-label="Theme: system. Click to change">
                <span className="i i-system"><Icon name="monitor" /></span>
                <span className="i i-dark"><Icon name="moon" /></span>
                <span className="i i-light"><Icon name="sun" /></span>
              </button>
            </div>
          </div>
        </header>
        <main id="main">{children}</main>
        <footer className="site-foot">
          <div className="shell shell--wide">
            <p className="credit">Built by <a href="https://x.com/linesofcode">linesofcode</a>, who also made JevLang — a policy engine for decisions that used to live inside a prompt.</p>
            <div className="foot-cols">
              {footerColumns.map(c => (
                <div key={c.title} className="foot-col">
                  <h3>{c.title}</h3>
                  {c.links.map(l => (
                    <a key={l.label} href={l.href} {...(l.external ? { target: '_blank', rel: 'noopener' } : {})}>
                      {l.label}{l.external && <> <span className="ext">↗</span></>}
                    </a>
                  ))}
                </div>
              ))}
            </div>
            <div className="foot-icons">{iconLinks.filter(l => l.where.includes('footer')).map(l => <IconLink key={l.icon} l={l} />)}</div>
            <p className="copyright">© {new Date().getFullYear()} linesofcode</p>
          </div>
        </footer>
      </body>
    </html>
  );
}
