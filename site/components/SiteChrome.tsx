import Link from 'next/link';
import { GITHUB_URL, ISSUES_URL, NPM_URL, VERSION } from '../lib/site';
import { EclipseMark, Logo } from './EclipseMark';

export function GitHubIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="icon">
      <path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

export function SiteHeader() {
  return (
    <header className="site-header">
      <div className="container header-inner">
        <Link href="/" className="brand" aria-label="Codiluce home"><Logo /></Link>
        <nav className="header-nav" aria-label="Main">
          <Link href="/docs/">Docs</Link>
          <Link href="/#roadmap" className="hide-sm">Roadmap</Link>
          <Link href="/#contribute" className="hide-sm">Contribute</Link>
          <a href={GITHUB_URL} className="header-github" target="_blank" rel="noreferrer">
            <GitHubIcon /><span className="hide-xs">GitHub</span>
          </a>
        </nav>
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="container footer-inner">
        <div className="footer-brand">
          <EclipseMark />
          <div>
            <p className="footer-name">codiluce</p>
            <p className="footer-tag">Bring your code to light</p>
          </div>
        </div>
        <nav className="footer-links" aria-label="Footer">
          <div>
            <p>Project</p>
            <a href={GITHUB_URL} target="_blank" rel="noreferrer">GitHub</a>
            <a href={ISSUES_URL} target="_blank" rel="noreferrer">Issues</a>
            <a href={NPM_URL} target="_blank" rel="noreferrer">npm</a>
          </div>
          <div>
            <p>Docs</p>
            <Link href="/docs/">Getting started</Link>
            <Link href="/docs/map/">Using the map</Link>
            <Link href="/docs/cli/">CLI & API</Link>
          </div>
          <div>
            <p>More</p>
            <Link href="/#status">Status</Link>
            <Link href="/#roadmap">Roadmap</Link>
            <Link href="/#contribute">Contribute</Link>
          </div>
        </nav>
      </div>
      <div className="container footer-legal">
        <span>v{VERSION} · MIT License</span>
        <span>Runs locally. Your code is read, never executed.</span>
      </div>
    </footer>
  );
}
