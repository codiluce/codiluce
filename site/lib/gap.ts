/**
 * The comprehension-gap illustration, shared by the home page (components/ComprehensionGap.tsx) and the README
 * graphics (scripts/readme-graphics.ts). Curves are in unit space: x is time (0 → 1), y is volume (0 → 1).
 * An illustration of the trend, not measured data.
 */
export const GAP_MILESTONES = [
  { x: 0.17, label: 'Autocomplete' },
  { x: 0.57, label: 'Coding agents' },
  { x: 0.81, label: 'Agents in parallel' },
] as const;

const clamp = (value: number) => Math.min(1, Math.max(0, value));
const grow = (x: number, k: number) => (Math.exp(k * x) - 1) / (Math.exp(k) - 1);
const smooth = (from: number, to: number, x: number) => {
  const t = clamp((x - from) / (to - from));
  return t * t * (3 - 2 * t);
};

/** Code written: flat for years, then exponential once agents arrive. */
export const agentOutput = (x: number) => 0.05 + 0.95 * grow(x, 5);
/** What the team understands of it: barely moves. */
export const humanComprehension = (x: number) => 0.05 + 0.08 * x * x;
/** What the team understands with Codiluce: it follows the output instead of falling behind. */
export const withCodiluce = (x: number) => humanComprehension(x) + 0.55 * (agentOutput(x) - humanComprehension(x)) * smooth(0.3, 0.75, x);
/** Comprehension while the Codiluce switch moves from off (0) to on (1). */
export const comprehension = (x: number, on: number) => humanComprehension(x) + on * (withCodiluce(x) - humanComprehension(x));

/** Faint alternative trajectories behind the main curves, each fading out at `end`. */
export const GAP_GHOSTS = [
  { kind: 'agent', end: 0.88, f: (x: number) => 0.05 + 0.86 * grow(x, 3.6) },
  { kind: 'agent', end: 0.97, f: (x: number) => 0.05 + 0.8 * grow(x, 6.6) },
  { kind: 'agent', end: 0.62, f: (x: number) => 0.06 + 0.05 * x + 0.3 * grow(x, 4) },
  { kind: 'human', end: 0.74, f: (x: number) => 0.045 + 0.05 * x },
  { kind: 'human', end: 0.9, f: (x: number) => 0.058 + 0.02 * x + 0.05 * x * x * x },
] as const;

/** Unit space to a box of `width` × `height` px, leaving room under the curves for the axis and milestones. */
export function gapScale(width: number, height: number) {
  // Narrow charts stagger their milestones on two rows.
  const axis = height - (width < 600 ? 74 : 46);
  const base = axis - 12;
  const top = 14;
  const right = width - 6;
  return { axis, base, top, right, x: (x: number) => x * right, y: (y: number) => base - y * (base - top) };
}

export type GapScale = ReturnType<typeof gapScale>;

/** An SVG path for `f` from `from` to `to`. */
export function gapLine(f: (x: number) => number, from: number, to: number, scale: GapScale, steps = 140): string {
  if (to <= from) return '';
  let d = '';
  for (let i = 0; i <= steps; i++) {
    const x = from + ((to - from) * i) / steps;
    d += `${i ? 'L' : 'M'}${scale.x(x).toFixed(1)} ${scale.y(f(x)).toFixed(1)}`;
  }
  return d;
}

/** The area between `lower` and `upper` from 0 to `to`. */
export function gapArea(lower: (x: number) => number, upper: (x: number) => number, to: number, scale: GapScale, steps = 140): string {
  if (to <= 0) return '';
  const back = gapLine(lower, 0, to, scale, steps).slice(1).split('L').reverse().join('L');
  return `${gapLine(upper, 0, to, scale, steps)}L${back}Z`;
}
