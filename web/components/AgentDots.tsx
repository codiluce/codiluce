import type { CSSProperties } from 'react';

/** Six positions, four lit dots following each other clockwise. */
export function AgentDots() {
  return <span className="agent-dots" aria-hidden="true">{[0, 1, 5, 2, 4, 3].map((step, index) => <i key={index} style={{ '--dot-step': step } as CSSProperties} />)}</span>;
}
