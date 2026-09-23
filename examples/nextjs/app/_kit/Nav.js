'use client';
import { usePathname } from 'next/navigation';
import { nav } from './site.js';

const Link = ({ n, path }) => (
  <a href={n.href} aria-current={n.href === path ? 'page' : undefined} {...(n.external ? { target: '_blank', rel: 'noopener' } : {})}>
    {n.label}{n.external && <> <span className="ext">↗</span></>}
  </a>
);

// Text links collapse into a disclosure under 720px; the icon links never do.
export default function Nav() {
  const path = usePathname();
  return (
    <>
      <nav className="site-nav" aria-label="Site">{nav.map(n => <Link key={n.href} n={n} path={path} />)}</nav>
      <details className="nav-more">
        <summary>Menu</summary>
        <div className="menu">{nav.map(n => <Link key={n.href} n={n} path={path} />)}</div>
      </details>
    </>
  );
}
