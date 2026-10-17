import Link from 'next/link';
import { DETECTED, FRAMEWORKS, LANGUAGES, MORE_FRAMEWORKS, logoOf, type Stack } from '../lib/stacks';

function Chip({ stack }: { stack: Stack }) {
  return (
    <li className="stack-chip">
      <img src={logoOf(stack)} alt="" width={18} height={18} loading="lazy" decoding="async" />
      {stack.name}
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
        <Link href="/docs/stacks/" className="text-link">What each stack supports →</Link>
      </div>
    </>
  );
}
