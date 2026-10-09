import Link from 'next/link';
import { VERSION } from '../lib/site';
import { DETECTED, FRAMEWORKS, LANGUAGES, MORE_FRAMEWORKS, PUBLISHED, logoOf, type Stack } from '../lib/stacks';

/** A dot that says whether the npm release analyzes a stack (filled) or only main does (ring). */
export function StackStatus({ published }: { published: boolean }) {
  return (
    <span className={`stack-status${published ? ' published' : ''}`} title={published ? `In the npm release (v${VERSION})` : 'On main, in the next npm release'}>
      <span className="sr-only">{published ? `in the npm release, v${VERSION}` : 'on main, in the next npm release'}</span>
    </span>
  );
}

function Chip({ stack }: { stack: Stack }) {
  return (
    <li className="stack-chip">
      <img src={logoOf(stack)} alt="" width={18} height={18} loading="lazy" decoding="async" />
      {stack.name}
      <StackStatus published={PUBLISHED.has(stack.id)} />
    </li>
  );
}

/** The home page's stack section: featured frameworks as tiles, then languages, more frameworks and detected ones. */
export function Stacks() {
  return (
    <>
      <ul className="stack-grid">
        {FRAMEWORKS.map((stack, index) => (
          <li key={stack.id} className="stack-tile" style={{ ['--i' as string]: index }}>
            <Link href={`/docs/stacks/#${stack.id}`} className="stack-link">
              <img src={logoOf(stack)} alt="" width={36} height={36} loading="lazy" decoding="async" />
              <span className="stack-name">{stack.name}</span>
              <span className="stack-note">{stack.note}</span>
              <StackStatus published={PUBLISHED.has(stack.id)} />
            </Link>
          </li>
        ))}
      </ul>

      <div className="stack-rows">
        <div className="stack-row">
          <p className="stack-row-title">Languages</p>
          <ul className="stack-chips">{LANGUAGES.map(stack => <Chip key={stack.id} stack={stack} />)}</ul>
        </div>
        <div className="stack-row">
          <p className="stack-row-title">Also analyzed</p>
          <ul className="stack-chips">{MORE_FRAMEWORKS.map(stack => <Chip key={stack.id} stack={stack} />)}</ul>
        </div>
        <div className="stack-row">
          <p className="stack-row-title">Detected</p>
          <p className="stack-detected">
            {DETECTED.join(', ')}, and every other language: mapped with their files, lines and Git metrics.
          </p>
        </div>
      </div>

      <div className="stack-foot">
        <p className="stack-legend">
          <span><StackStatus published /> In the npm release, v{VERSION}</span>
          <span><StackStatus published={false} /> On main: run it from source, ships in the next release</span>
        </p>
        <Link href="/docs/stacks/" className="text-link">What each stack supports →</Link>
      </div>
    </>
  );
}
