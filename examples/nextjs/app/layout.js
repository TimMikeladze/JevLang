import './globals.css';
// The chrome is the jevlang.sh site's own: the same header (with the Examples
// dropdown), footer, theme script and styles the landing page renders,
// written by scripts/site.js.
import chrome from './_kit/chrome.json';

export const metadata = {
  metadataBase: new URL('https://jevlang.sh'),
  title: 'JevLang examples — policy-backed API routes on Next.js',
  description: 'Three Next.js API routes, each decided by a JevLang policy: a tenant hotline, a restaurant SMS host and a courier app, logged to Upstash Redis and rate limited.',
  icons: { icon: `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" rx="11" fill="#1c1c1c"/><path d="M30 12v16.5c0 4.5-3 7.5-7.5 7.5S15 33 15 29.5" fill="none" stroke="#f7f7f7" stroke-width="3.4" stroke-linecap="round"/></svg>')}` },
};
export const viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: dark)', color: '#1f1f1f' },
    { media: '(prefers-color-scheme: light)', color: '#fcfcfc' },
  ],
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <style dangerouslySetInnerHTML={{ __html: chrome.css }} />
        <script dangerouslySetInnerHTML={{ __html: chrome.boot }} />
      </head>
      <body>
        <div style={{ display: 'contents' }} dangerouslySetInnerHTML={{ __html: chrome.header }} />
        <main id="main">{children}</main>
        <div style={{ display: 'contents' }} dangerouslySetInnerHTML={{ __html: chrome.footer }} />
      </body>
    </html>
  );
}
