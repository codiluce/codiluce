import type { Metadata } from 'next';
import Link from 'next/link';
import { RELEASES, npmReleaseHref, releaseDate, releaseId } from '../../lib/releases';

const description = 'What’s new in Codiluce: release notes for every npm version, with publication dates, features, improvements and fixes.';

export const metadata: Metadata = {
  title: 'Releases',
  description,
  alternates: { canonical: '/releases/' },
  openGraph: {
    title: 'Releases · Codiluce', description, url: '/releases/',
    images: [{ url: '/social-preview.png', width: 1280, height: 640, alt: 'Codiluce — Bring your code to light' }],
  },
  twitter: { card: 'summary_large_image', title: 'Releases · Codiluce', description },
};

export default function ReleasesPage() {
  return (
    <div className="container releases-page">
      <header className="releases-intro">
        <p className="eyebrow">The changelog</p>
        <h1>Releases</h1>
        <p className="section-lede">A project in motion. Every npm release, and what it brings to your map.</p>
        <p className="releases-scope">Dates are npm publication dates. Features on main that have not shipped yet appear in the docs as “Next release”.</p>
        <div className="releases-actions">
          <Link href="/docs/" className="button primary">Get started</Link>
          <a href={npmReleaseHref(RELEASES[0]!.version)} className="button ghost" target="_blank" rel="noreferrer">Latest on npm ↗</a>
        </div>
      </header>

      <nav className="release-jumps" aria-label="Jump to a release">
        {RELEASES.map(release => <a href={`#${releaseId(release.version)}`} key={release.version}>v{release.version}</a>)}
      </nav>

      <div className="release-timeline">
        {RELEASES.map((release, index) => (
          <article className="release-entry" id={releaseId(release.version)} key={release.version} aria-labelledby={`${releaseId(release.version)}-title`}>
            <div className="release-stamp">
              <a href={`#${releaseId(release.version)}`} className="release-version" aria-label={`Link to version ${release.version}`}>v{release.version}</a>
              <time dateTime={release.publishedAt}>{releaseDate(release.publishedAt)}</time>
              {index === 0 && <span className="release-tag">Latest release</span>}
              {release.prerelease && <span className="release-tag prerelease">Pre-release</span>}
            </div>
            <div className="release-notes">
              <h2 id={`${releaseId(release.version)}-title`}>{release.title}</h2>
              <p className="release-summary">{release.summary}</p>
              {release.changes.map(group => (
                <section className="release-change" key={group.title} aria-label={group.title}>
                  <h3>{group.title}</h3>
                  <ul>{group.items.map(item => <li key={item}>{item}</li>)}</ul>
                </section>
              ))}
              <div className="release-links">
                <a href={npmReleaseHref(release.version)} target="_blank" rel="noreferrer">View on npm ↗</a>
                {release.source && <a href={release.source.href} target="_blank" rel="noreferrer">{release.source.label} ↗</a>}
              </div>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
