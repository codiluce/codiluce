'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { DOCS_NAV, GITHUB_URL, ISSUES_URL } from '../lib/site';
import { GitHubIcon } from './SiteChrome';

const normalize = (path: string) => (path.endsWith('/') ? path : `${path}/`);

export function DocsNav() {
  const pathname = normalize(usePathname() ?? '/docs/');
  return (
    <nav className="docs-nav" aria-label="Documentation">
      <p className="docs-nav-title">Documentation</p>
      <ul>
        {DOCS_NAV.map(item => (
          <li key={item.href}>
            <Link href={item.href} aria-current={pathname === item.href ? 'page' : undefined}>{item.title}</Link>
          </li>
        ))}
      </ul>
      <div className="docs-nav-extra">
        <a href={GITHUB_URL} target="_blank" rel="noreferrer"><GitHubIcon />Source on GitHub</a>
        <a href={ISSUES_URL} target="_blank" rel="noreferrer">Report an issue ↗</a>
      </div>
    </nav>
  );
}

/** Previous and next page links, in the order of the navigation. */
export function DocsPager({ current }: { current: string }) {
  const index = DOCS_NAV.findIndex(item => item.href === current);
  const previous = index > 0 ? DOCS_NAV[index - 1] : undefined;
  const next = index >= 0 && index < DOCS_NAV.length - 1 ? DOCS_NAV[index + 1] : undefined;
  return (
    <nav className="docs-pager" aria-label="Pages">
      {previous ? <Link href={previous.href}><span>Previous</span><strong>{previous.title}</strong></Link> : null}
      {next ? <Link href={next.href} className="next"><span>Next</span><strong>{next.title}</strong></Link> : null}
    </nav>
  );
}
