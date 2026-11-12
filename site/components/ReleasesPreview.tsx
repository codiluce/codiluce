import Link from 'next/link';
import { RELEASES, releaseDate, releaseHref } from '../lib/releases';

export function ReleasesPreview() {
  return (
    <section className="section releases-section" id="releases" aria-labelledby="releases-title">
      <div className="container">
        <div className="releases-heading">
          <div>
            <p className="eyebrow">Releases</p>
            <h2 id="releases-title" className="section-title">Built in the open. Shipped on npm.</h2>
            <p className="section-lede">Follow the changes, one release at a time.</p>
          </div>
          <Link href="/releases/" className="text-link">All releases →</Link>
        </div>
        <div className="release-cards">
          {RELEASES.filter(release => !release.prerelease).slice(0, 3).map((release, index) => (
            <Link href={releaseHref(release.version)} className="release-card" key={release.version}>
              <div className="release-card-meta">
                <span className="release-version">v{release.version}</span>
                {index === 0 && <span className="release-tag">Latest</span>}
              </div>
              <time dateTime={release.publishedAt}>{releaseDate(release.publishedAt)}</time>
              <h3>{release.title}</h3>
              <p>{release.summary}</p>
              <span className="text-link">Read release notes <span aria-hidden="true">→</span></span>
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}
