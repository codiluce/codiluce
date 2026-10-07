/**
 * The Codiluce symbol (Eclipse): a disc cut by a horizontal band of light. It fills with the
 * current color; themes can tint the halves apart (`.eclipse-upper`, `.eclipse-lower`).
 */
export function EclipseMark({ className = 'brand-mark' }: { className?: string }) {
  return (
    <svg className={className} viewBox="19 19 62 62" aria-hidden="true" focusable="false">
      <path className="eclipse-upper" d="M19.1455 47A31 31 0 0 1 80.8545 47Z" />
      <path className="eclipse-lower" d="M80.8545 53A31 31 0 0 1 19.1455 53Z" />
    </svg>
  );
}
