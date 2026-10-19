// Icons for the Explain templates, drawn the way the map draws code: a plate
// for an area, blocks for files, the template's subject lit in the accent color,
// dashed arcs for flows, and a sign above (a shield, a bug, a lens…). SVG in
// the theme's colors (custom properties), so every theme tints them.
import type { CSSProperties, ReactNode } from 'react';
import { ISO_X, ISO_Y } from '../lib/camera';

/** Grid units to pixels, and where the plate's back corner sits in the 64 × 64 view box. */
const S = 3.6, OX = 32, OY = 27;
type Tone = 'plate' | 'code' | 'hot' | 'lit' | 'area' | 'ghost' | 'dead' | 'crate' | 'test';

function at(x: number, y: number, z = 0): [number, number] { return [OX + (x - y) * ISO_X * S, OY + ((x + y) * ISO_Y - z) * S]; }
function points(list: [number, number, number][]): string { return list.map(([x, y, z]) => at(x, y, z).map(value => value.toFixed(2)).join(',')).join(' '); }

/** A block (or a plate): its two visible sides, then its top. */
function Box({ x, y, w, d, h, z = 0, tone = 'code' }: { x: number; y: number; w: number; d: number; h: number; z?: number; tone?: Tone }) {
  const top = z + h;
  const marks: ReactNode[] = [];
  if (tone === 'crate') {
    // Tape across the top and down both sides: a package.
    marks.push(<polyline key="a" className="ti-tape" points={points([[x + w / 2, y + d, z], [x + w / 2, y + d, top], [x + w / 2, y, top]])} />);
    marks.push(<polyline key="b" className="ti-tape" points={points([[x + w, y + d / 2, z], [x + w, y + d / 2, top], [x, y + d / 2, top]])} />);
  }
  if (tone === 'test') {
    // The map's test hatch, on both sides.
    for (let i = 1; i < 4; i++) {
      const f = i / 4;
      marks.push(<line key={`l${i}`} className="ti-hatch" x1={at(x + w * f, y + d, z)[0]} y1={at(x + w * f, y + d, z)[1]} x2={at(x + w * Math.min(1, f + 0.35), y + d, Math.min(top, z + h * 0.9))[0]} y2={at(x + w * Math.min(1, f + 0.35), y + d, Math.min(top, z + h * 0.9))[1]} />);
      marks.push(<line key={`r${i}`} className="ti-hatch" x1={at(x + w, y + d * f, z)[0]} y1={at(x + w, y + d * f, z)[1]} x2={at(x + w, y + d * Math.max(0, f - 0.35), Math.min(top, z + h * 0.9))[0]} y2={at(x + w, y + d * Math.max(0, f - 0.35), Math.min(top, z + h * 0.9))[1]} />);
    }
  }
  return (
    <g className={`ti-${tone}`}>
      <polygon className="ti-l" points={points([[x, y + d, z], [x + w, y + d, z], [x + w, y + d, top], [x, y + d, top]])} />
      <polygon className="ti-r" points={points([[x + w, y, z], [x + w, y + d, z], [x + w, y + d, top], [x + w, y, top]])} />
      <polygon className="ti-t" points={points([[x, y, top], [x + w, y, top], [x + w, y + d, top], [x, y + d, top]])} />
      {marks}
    </g>
  );
}
/** The ground: an area of 8 × 8 (or part of one), its top at height 0. */
function Plate({ x = 0, y = 0, w = 8, d = 8 }: { x?: number; y?: number; w?: number; d?: number }) { return <Box x={x} y={y} w={w} d={d} h={0.8} z={-0.8} tone="plate" />; }
/** An outline on the ground (a lot, a ripple). */
function Lot({ x, y, w, d, z = 0, className = 'ti-lot', style }: { x: number; y: number; w: number; d: number; z?: number; className?: string; style?: CSSProperties }) {
  return <polygon className={className} style={style} points={points([[x, y, z], [x + w, y, z], [x + w, y + d, z], [x, y + d, z]])} />;
}
/** The middle of a block's top. */
function topOf(x: number, y: number, w: number, d: number, h: number, z = 0): [number, number] { return at(x + w / 2, y + d / 2, z + h); }
/** A flow: dashed arcs from stop to stop, a dot at each. */
function Flow({ stops, lift = 6, dots = true, className = 'ti-flow' }: { stops: [number, number][]; lift?: number; dots?: boolean; className?: string }) {
  const d = stops.map(([px, py], index) => {
    if (!index) return `M${px.toFixed(2)} ${py.toFixed(2)}`;
    const [qx, qy] = stops[index - 1]!;
    return `Q${((px + qx) / 2).toFixed(2)} ${(Math.min(py, qy) - lift).toFixed(2)} ${px.toFixed(2)} ${py.toFixed(2)}`;
  }).join(' ');
  return <g><path className={className} d={d} />{dots && stops.map(([px, py], index) => <circle key={index} className="ti-dot" cx={px} cy={py} r={index === stops.length - 1 ? 2 : 1.5} />)}</g>;
}
function Line({ from, to }: { from: [number, number]; to: [number, number] }) { return <g><line className="ti-link" x1={from[0]} y1={from[1]} x2={to[0]} y2={to[1]} /><circle className="ti-dot" cx={to[0]} cy={to[1]} r={1.4} /></g>; }
/** A cylinder: a table. */
function Table({ x, y, r, h }: { x: number; y: number; r: number; h: number }) {
  const [cx, bottom] = at(x, y, 0), top = at(x, y, h)[1], rx = r * Math.SQRT2 * ISO_X * S, ry = r * Math.SQRT2 * ISO_Y * S, mid = (top + bottom) / 2;
  return (
    <g className="ti-hot">
      <path className="ti-l" d={`M${cx - rx} ${top} L${cx - rx} ${bottom} A${rx} ${ry} 0 0 0 ${cx + rx} ${bottom} L${cx + rx} ${top} Z`} />
      <path className="ti-band" d={`M${cx - rx} ${mid} A${rx} ${ry} 0 0 0 ${cx + rx} ${mid}`} />
      <ellipse className="ti-t" cx={cx} cy={top} rx={rx} ry={ry} />
    </g>
  );
}

// Signs, drawn flat above the scene, centered on (x, y).
function Shield({ x, y }: { x: number; y: number }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <path className="ti-sign-hot" d="M0 -9.5 L8 -6.6 V-0.5 C8 4.8 4.4 8.2 0 10 C-4.4 8.2 -8 4.8 -8 -0.5 V-6.6 Z" />
      <circle className="ti-ink" cx="0" cy="-1.6" r="2.1" />
      <path className="ti-ink" d="M-1.1 -0.4 H1.1 L1.8 4.4 H-1.8 Z" />
    </g>
  );
}
function Bug({ x, y }: { x: number; y: number }) {
  return (
    <g transform={`translate(${x} ${y}) rotate(-18) scale(1.15)`}>
      {[-2.6, 0.4, 3.2].map(ly => <path key={ly} className="ti-leg" d={`M-6.4 ${ly - 1.6} L-3 ${ly} M6.4 ${ly - 1.6} L3 ${ly}`} />)}
      <path className="ti-leg" d="M-1.2 -6.6 L-3 -9 M1.2 -6.6 L3 -9" />
      <circle className="ti-sign-hot" cx="0" cy="-5.2" r="2.4" />
      <ellipse className="ti-sign-hot" cx="0" cy="1" rx="4.3" ry="5.4" />
      <path className="ti-ink-line" d="M0 -3.6 V6" />
    </g>
  );
}
function Check({ x, y }: { x: number; y: number }) {
  return <g transform={`translate(${x} ${y})`}><circle className="ti-sign-hot" r="6.2" /><path className="ti-ink-line thick" d="M-3 0.2 L-0.8 2.5 L3.2 -2.2" /></g>;
}
function Lens({ x, y, r = 8 }: { x: number; y: number; r?: number }) {
  const k = r * 0.72;
  return <g><line className="ti-handle" x1={x + k} y1={y + k} x2={x + k + 6} y2={y + k + 6} /><circle className="ti-lens" cx={x} cy={y} r={r} /></g>;
}
function Flag({ x, y }: { x: number; y: number }) {
  return <g><line className="ti-pole" x1={x} y1={y} x2={x} y2={y - 14} /><path className="ti-sign-hot" d={`M${x} ${y - 14} L${x + 9} ${y - 11} L${x} ${y - 7.6} Z`} /><circle className="ti-dot" cx={x} cy={y} r={1.4} /></g>;
}
function Clock({ x, y }: { x: number; y: number }) {
  return <g transform={`translate(${x} ${y})`}><circle className="ti-dial" r="7" /><path className="ti-hand" d="M0 0 V-4.6 M0 0 L3.4 2" /><circle className="ti-dot" r="1.1" /></g>;
}
function Gauge({ x, y }: { x: number; y: number }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <path className="ti-dial" d="M-8 2 A8 8 0 0 1 8 2 Z" />
      <path className="ti-hot-arc" d="M3.6 -5.1 A6.2 6.2 0 0 1 6.2 1.4" />
      <path className="ti-hand" d="M0 1.6 L5 -3.8" />
      <circle className="ti-dot" cx="0" cy="1.6" r="1.4" />
    </g>
  );
}
function Warning({ x, y }: { x: number; y: number }) {
  return <g transform={`translate(${x} ${y})`}><path className="ti-sign-hot" d="M0 -7.4 L7.4 5.4 H-7.4 Z" /><path className="ti-ink-line thick" d="M0 -2.6 V1" /><circle className="ti-ink" cx="0" cy="3.3" r="0.95" /></g>;
}
function Target({ x, y }: { x: number; y: number }) {
  return <g transform={`translate(${x} ${y})`}><circle className="ti-ring" r="6.4" /><path className="ti-ring" d="M0 -9.4 V-4.4 M0 4.4 V9.4 M-9.4 0 H-4.4 M4.4 0 H9.4" /></g>;
}
function Cross({ x, y }: { x: number; y: number }) {
  return <g transform={`translate(${x} ${y})`}><circle className="ti-sign-hot" r="4.8" /><path className="ti-ink-line thick" d="M-2 -2 L2 2 M2 -2 L-2 2" /></g>;
}
function Arrow({ x, y, length }: { x: number; y: number; length: number }) {
  return <g><line className="ti-arrow" x1={x} y1={y} x2={x} y2={y + length} /><path className="ti-arrow-head" d={`M${x - 2.6} ${y + length - 3} L${x} ${y + length} L${x + 2.6} ${y + length - 3}`} /></g>;
}

/** Each template's scene, back to front. */
const SCENES: Record<string, () => ReactNode> = {
  codebase: () => <>
    <Plate w={8} d={3.4} />
    <Box x={0.6} y={0.6} w={2} d={2.2} h={3} /><Box x={3.2} y={0.6} w={1.8} d={2.2} h={5} /><Box x={5.6} y={0.6} w={1.8} d={2.2} h={2.2} />
    <Plate y={4.6} w={8} d={3.4} />
    <Box x={0.6} y={5.2} w={2.2} d={2.2} h={2.4} /><Box x={3.4} y={5.2} w={1.6} d={2.2} h={4} /><Box x={5.6} y={5.2} w={1.8} d={2.2} h={1.6} />
    <Flow stops={[topOf(3.2, 0.6, 1.8, 2.2, 5), topOf(3.4, 5.2, 1.6, 2.2, 4)]} lift={7} />
  </>,
  onboarding: () => <>
    <Plate />
    <Box x={0.6} y={0.6} w={2.2} d={2.2} h={4} /><Box x={3.4} y={0.6} w={1.8} d={2.2} h={2.4} /><Box x={0.6} y={3.4} w={2} d={1.8} h={2} />
    <Box x={5.8} y={0.6} w={1.6} d={1.8} h={3} /><Box x={0.6} y={5.8} w={2.2} d={1.6} h={1.4} />
    <Box x={3.5} y={3.5} w={4.1} d={4.1} h={0.3} tone="area" />
    <Box x={4} y={4} w={1.6} d={1.6} h={2.6} z={0.3} tone="hot" /><Box x={6} y={4.1} w={1.2} d={1.3} h={1.6} z={0.3} tone="hot" /><Box x={4.1} y={6} w={1.3} d={1.2} h={1.2} z={0.3} tone="hot" />
    <Flag {...xy(topOf(4, 4, 1.6, 1.6, 2.6, 0.3))} />
  </>,
  path: () => <>
    <Plate />
    <Box x={0.7} y={0.7} w={4.6} d={4.6} h={0.3} tone="area" />
    <Box x={1.1} y={1.1} w={1.7} d={1.7} h={3.6} z={0.3} tone="hot" /><Box x={3.2} y={1.2} w={1.6} d={1.5} h={2.2} z={0.3} tone="hot" />
    <Box x={1.2} y={3.2} w={1.5} d={1.6} h={1.6} z={0.3} tone="hot" /><Box x={3.2} y={3.2} w={1.6} d={1.6} h={2.8} z={0.3} tone="hot" />
    <Box x={5.9} y={0.8} w={1.5} d={2.2} h={2.4} /><Box x={0.8} y={5.9} w={2.2} d={1.5} h={1.8} /><Box x={5.9} y={5.6} w={1.5} d={1.8} h={3.2} />
  </>,
  feature: () => <>
    <Plate />
    <Box x={1} y={1} w={2} d={2} h={3.6} tone="lit" /><Box x={4.4} y={1.2} w={1.6} d={1.8} h={2.6} tone="lit" /><Box x={0.8} y={5.4} w={1.8} d={1.8} h={2} tone="lit" />
    <Box x={3.2} y={3.6} w={1.4} d={1.4} h={1.4} /><Box x={5.4} y={4.8} w={1.8} d={2} h={3} tone="lit" />
    <Flow stops={[topOf(0.8, 5.4, 1.8, 1.8, 2), topOf(1, 1, 2, 2, 3.6), topOf(4.4, 1.2, 1.6, 1.8, 2.6), topOf(5.4, 4.8, 1.8, 2, 3)]} lift={6} />
  </>,
  where: () => <>
    <Plate />
    <Box x={0.8} y={0.8} w={1.8} d={1.8} h={3} /><Box x={3.4} y={0.8} w={1.6} d={1.6} h={2} /><Box x={0.8} y={3.6} w={1.6} d={1.8} h={1.6} />
    <Box x={5.8} y={0.8} w={1.4} d={2} h={3.6} /><Box x={0.8} y={6} w={1.8} d={1.4} h={2.4} />
    <Box x={3.4} y={3.4} w={1.8} d={1.8} h={2.8} tone="hot" /><Box x={5.8} y={3.6} w={1.4} d={1.4} h={1.6} tone="hot" /><Box x={5.8} y={5.8} w={1.6} d={1.6} h={1.4} />
    <Lens {...xy(topOf(3.4, 3.4, 1.8, 1.8, 2.8), 0, 1)} r={8.6} />
  </>,
  data: () => <>
    <Plate />
    <Box x={0.8} y={0.8} w={2} d={1.8} h={3.4} /><Box x={4.6} y={0.8} w={2.2} d={1.8} h={2.4} /><Box x={0.8} y={4.4} w={1.8} d={2} h={2} />
    <Flow stops={[topOf(0.8, 0.8, 2, 1.8, 3.4), at(5.2, 5.2, 3.2)]} lift={4} dots={false} />
    <Flow stops={[topOf(4.6, 0.8, 2.2, 1.8, 2.4), at(5.2, 5.2, 3.2)]} lift={3} dots={false} />
    <Flow stops={[at(5.2, 5.2, 3.2), topOf(0.8, 4.4, 1.8, 2, 2)]} lift={3} dots={false} />
    <Table x={5.2} y={5.2} r={1.7} h={3.2} />
  </>,
  dependencies: () => <>
    <Plate />
    <Box x={0.7} y={0.7} w={1.8} d={1.8} h={2.6} /><Box x={5.5} y={0.7} w={1.8} d={1.8} h={3.4} /><Box x={0.7} y={5.5} w={1.8} d={1.8} h={2} />
    <Box x={3.1} y={3.1} w={1.8} d={1.8} h={3.8} tone="hot" /><Box x={5.5} y={5.5} w={1.8} d={1.8} h={1.6} />
    {[[0.7, 0.7, 2.6], [5.5, 0.7, 3.4], [0.7, 5.5, 2], [5.5, 5.5, 1.6]].map(([x, y, h]) => <Line key={`${x}-${y}`} from={topOf(3.1, 3.1, 1.8, 1.8, 3.8)} to={topOf(x!, y!, 1.8, 1.8, h!)} />)}
  </>,
  packages: () => <>
    <Plate />
    <Box x={0.8} y={0.8} w={2} d={2} h={3.2} /><Box x={3.2} y={0.8} w={1.6} d={2} h={2} /><Box x={0.8} y={3.2} w={2} d={1.6} h={1.6} />
    <Box x={5.4} y={2.8} w={2} d={2} h={2} tone="crate" /><Box x={2.8} y={5.4} w={2} d={2} h={2} tone="crate" />
    <Box x={5.4} y={5.4} w={2} d={2} h={2} tone="crate" /><Box x={5.6} y={5.6} w={1.6} d={1.6} h={1.6} z={2} tone="crate" />
  </>,
  architecture: () => <>
    <Box x={1} y={1} w={6} d={6} h={0.6} z={0} tone="plate" />
    <Box x={1} y={1} w={6} d={6} h={0.6} z={2.7} tone="area" />
    <Box x={1} y={1} w={6} d={6} h={0.6} z={5.4} tone="plate" />
    <Box x={1.6} y={1.6} w={1.6} d={1.6} h={1.6} z={6} /><Box x={4.4} y={1.6} w={2} d={1.4} h={1} z={6} /><Box x={1.6} y={4.4} w={1.4} d={2} h={1.2} z={6} />
    <Box x={4.2} y={4.2} w={1.6} d={1.6} h={0.9} z={6} tone="hot" />
    <Arrow {...xy(at(7, 7, 5.2))} length={8.2} />
  </>,
  connection: () => <>
    <Plate w={3.4} d={8} />
    <Box x={0.7} y={0.8} w={2} d={2} h={2.4} /><Box x={0.7} y={5} w={2} d={2.2} h={3.6} tone="hot" />
    <Plate x={4.6} w={3.4} d={8} />
    <Box x={5.2} y={0.8} w={2.2} d={2} h={3.4} tone="hot" /><Box x={5.4} y={5} w={1.8} d={2} h={2} />
    <Flow stops={[topOf(0.7, 5, 2, 2.2, 3.6), topOf(5.2, 0.8, 2.2, 2, 3.4)]} lift={12} />
  </>,
  impact: () => <>
    <Plate />
    {[3, 2, 1].map((offset, index) => <Lot key={offset} x={3.2 - offset} y={3.2 - offset} w={1.6 + offset * 2} d={1.6 + offset * 2} className="ti-ripple" style={{ opacity: 0.3 + index * 0.25 }} />)}
    <Box x={0.6} y={0.6} w={1.6} d={1.6} h={2.6} /><Box x={5.8} y={0.6} w={1.6} d={1.6} h={1.8} tone="lit" /><Box x={0.6} y={5.8} w={1.6} d={1.6} h={2.2} />
    <Box x={3.2} y={3.2} w={1.6} d={1.6} h={4.2} tone="hot" /><Box x={5.9} y={5.9} w={1.4} d={1.4} h={1.2} tone="lit" />
  </>,
  change: () => <>
    <Plate />
    <Lot x={3.5} y={3.5} w={2.2} d={2.2} />
    <Box x={0.8} y={0.8} w={2} d={2} h={3} /><Box x={3.6} y={0.8} w={1.6} d={2} h={2} /><Box x={0.8} y={3.6} w={2} d={1.6} h={1.8} />
    <Box x={5.8} y={0.8} w={1.4} d={1.6} h={2.6} /><Box x={0.8} y={5.8} w={1.8} d={1.4} h={2.4} /><Box x={5.8} y={5.6} w={1.6} d={1.6} h={1.4} />
    <Arrow {...xy(at(4.6, 4.6, 3.6))} length={10.4} />
    <Box x={3.6} y={3.6} w={2} d={2} h={2.4} z={3.8} tone="ghost" />
  </>,
  history: () => <>
    <Plate />
    <Box x={0.8} y={0.8} w={1.8} d={1.8} h={2.4} /><Box x={3.4} y={0.8} w={1.8} d={1.8} h={1.6} /><Box x={0.8} y={3.4} w={1.8} d={1.8} h={2} />
    <Box x={5.6} y={1} w={1.6} d={1.6} h={2.8} /><Box x={1} y={5.6} w={1.6} d={1.6} h={1.2} />
    <Box x={3.3} y={3.3} w={1.9} d={1.9} h={4.4} tone="ghost" />
    <Box x={3.3} y={3.3} w={1.9} d={1.9} h={2.6} tone="hot" /><Box x={5.6} y={5.6} w={1.6} d={1.6} h={1.8} />
    <Clock x={45} y={17} />
  </>,
  tests: () => <>
    <Plate />
    <Box x={0.8} y={0.8} w={2} d={2} h={3} /><Box x={5.4} y={0.8} w={1.8} d={1.8} h={2} /><Box x={0.8} y={5.4} w={1.8} d={1.8} h={1.6} />
    <Box x={3.2} y={3.2} w={2} d={2} h={3.4} tone="hot" /><Box x={5.4} y={5.2} w={1.8} d={2} h={2.2} tone="test" />
    <Line from={topOf(5.4, 5.2, 1.8, 2, 2.2)} to={topOf(3.2, 3.2, 2, 2, 3.4)} />
    <Check {...xy(topOf(3.2, 3.2, 2, 2, 3.4), 0, -9)} />
  </>,
  security: () => <>
    <Plate />
    <Box x={0.8} y={0.8} w={1.8} d={1.8} h={2.6} /><Box x={5.6} y={0.8} w={1.6} d={1.8} h={1.8} /><Box x={0.8} y={5.6} w={1.8} d={1.6} h={2.2} />
    <Box x={3.1} y={3.1} w={2} d={2} h={3} tone="hot" /><Box x={5.8} y={5.8} w={1.4} d={1.4} h={1.2} />
    <Shield {...xy(topOf(3.1, 3.1, 2, 2, 3), 0, -10)} />
  </>,
  bugs: () => <>
    <Plate />
    <Box x={0.8} y={0.8} w={2} d={2} h={3.2} /><Box x={3.6} y={0.8} w={1.6} d={1.8} h={2} /><Box x={0.8} y={3.6} w={1.8} d={1.8} h={1.8} />
    <Box x={5.8} y={0.8} w={1.4} d={1.6} h={2.6} /><Box x={0.8} y={6} w={1.6} d={1.2} h={1.4} />
    <Box x={3.3} y={3.3} w={2.2} d={2.2} h={2.2} tone="lit" /><Box x={5.8} y={5.8} w={1.4} d={1.4} h={1.6} />
    <Bug {...xy(topOf(3.3, 3.3, 2.2, 2.2, 2.2), 0, -4)} />
  </>,
  debug: () => <>
    <Plate />
    <Box x={0.8} y={0.8} w={1.8} d={1.8} h={2.2} /><Box x={3.6} y={0.8} w={1.6} d={1.6} h={3} /><Box x={5.6} y={0.8} w={1.8} d={1.8} h={3.6} tone="hot" />
    <Box x={0.8} y={3.6} w={1.6} d={1.8} h={1.6} /><Box x={3.4} y={3.4} w={1.6} d={1.6} h={2.4} tone="lit" /><Box x={5.8} y={4} w={1.4} d={1.6} h={2} />
    <Flow stops={[at(1.6, 6.6, 0.4), topOf(3.4, 3.4, 1.6, 1.6, 2.4), topOf(5.6, 0.8, 1.8, 1.8, 3.6)]} lift={5} />
    <Warning {...xy(at(1.6, 6.6, 0), 0, -4)} />
    <Target {...xy(topOf(5.6, 0.8, 1.8, 1.8, 3.6))} />
  </>,
  unused: () => <>
    <Plate />
    <Box x={0.8} y={0.8} w={2} d={2} h={3} /><Box x={4.4} y={0.9} w={1.8} d={1.8} h={2.4} /><Box x={0.9} y={4.4} w={1.8} d={1.8} h={1.8} />
    <Flow stops={[topOf(0.9, 4.4, 1.8, 1.8, 1.8), topOf(0.8, 0.8, 2, 2, 3), topOf(4.4, 0.9, 1.8, 1.8, 2.4)]} lift={5} className="ti-flow muted" />
    <Box x={4.6} y={4.6} w={2.2} d={2.2} h={2.6} tone="dead" />
    <Cross {...xy(topOf(4.6, 4.6, 2.2, 2.2, 2.6), 0, -2)} />
  </>,
  performance: () => <>
    <Plate />
    <Box x={0.9} y={0.9} w={1.8} d={1.8} h={2.6} /><Box x={4.4} y={1} w={2} d={2} h={4.6} tone="hot" />
    <Box x={0.8} y={5.2} w={1.8} d={1.8} h={1.8} /><Box x={5.4} y={5.2} w={1.8} d={1.8} h={2.2} />
    <Flow stops={[topOf(0.8, 5.2, 1.8, 1.8, 1.8), topOf(4.4, 1, 2, 2, 4.6), topOf(5.4, 5.2, 1.8, 1.8, 2.2)]} lift={6} />
    <Gauge x={44} y={10} />
  </>,
};
function xy([x, y]: [number, number], dx = 0, dy = 0): { x: number; y: number } { return { x: x + dx, y: y + dy }; }

/** A template's icon (a plain district for one without a scene). */
export function TemplateIcon({ id, size = 48, className = '' }: { id: string; size?: number; className?: string }) {
  const scene = SCENES[id] ?? SCENES.codebase!;
  return <svg className={`ticon ${className}`} viewBox="0 0 64 64" width={size} height={size} aria-hidden="true" focusable="false">{scene()}</svg>;
}

/** A small mark for the Templates button: one block, in the text color. */
export function TemplatesGlyph() {
  return (
    <svg className="templates-glyph" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <path d="M8 1.6 14 5 8 8.4 2 5Z" />
      <path d="M2 5.9v5.3l5.4 3.1V9.3Z" opacity="0.62" />
      <path d="M14 5.9v5.3l-5.4 3.1V9.3Z" opacity="0.36" />
    </svg>
  );
}
