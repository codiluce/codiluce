/** The Codiluce symbol: a disc cut by a horizontal band of light (same geometry as web/components/EclipseMark.tsx). */
export function EclipseMark({ className = 'eclipse-mark' }: { className?: string }) {
  return (
    <svg className={className} viewBox="19 19 62 62" aria-hidden="true" focusable="false">
      <path d="M19.1455 47A31 31 0 0 1 80.8545 47Z" fill="currentColor" />
      <path d="M80.8545 53A31 31 0 0 1 19.1455 53Z" fill="currentColor" />
    </svg>
  );
}

export function Logo() {
  return (
    <span className="logo">
      <EclipseMark />
      <span className="logo-word">codiluce</span>
    </span>
  );
}
