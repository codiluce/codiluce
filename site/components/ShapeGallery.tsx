'use client';
import { useEffect, useRef, useState } from 'react';
import { ARCHETYPE_LABELS, DUSK, DUSK_FILE, DUSK_PLATE, drawShape, ISO_X, ISO_Y, seedOf, shapeHeight, type Archetype, type Hsl } from '../lib/shapes';

/** A small two-application district, laid out by hand: [kind, x, y, w, d, lines of code]. */
const LOTS: [Archetype, number, number, number, number, number][] = [
  ['entry', 1, 1, 6, 6, 40], ['routes', 8, 1, 8, 6, 260], ['middleware', 17, 1, 6, 6, 60], ['schedule', 24, 1, 7, 6, 60],
  ['controller', 1, 8, 14, 9, 420], ['service', 16, 8, 15, 9, 380],
  ['model', 1, 18, 9, 8, 200], ['job', 11, 18, 10, 5, 90], ['command', 22, 18, 9, 8, 120],
  ['table', 1, 27, 9, 4, 70], ['helper', 11, 24, 10, 7, 140], ['config', 22, 27, 9, 4, 120],
  ['layout', 35, 1, 12, 9, 80], ['page', 48, 1, 11, 9, 200], ['page', 35, 11, 7, 8, 140], ['component', 43, 11, 8, 8, 260],
  ['component', 52, 11, 7, 8, 90], ['hook', 35, 20, 8, 7, 90], ['style', 44, 20, 7, 5, 200], ['test', 52, 20, 7, 7, 260],
];
const PLATES = [{ x: 0, y: 0, w: 32, d: 32, label: 'backend' }, { x: 34, y: 0, w: 26, d: 28, label: 'frontend' }];
/** One request, from the page to the table: indexes into LOTS. */
const FLOW = [13, 17, 1, 2, 4, 5, 6, 9];
const KINDS = Object.keys(ARCHETYPE_LABELS) as Archetype[];
const STOP_MS = 900, HOLD_MS = 2600;

const P = (s: number, ox: number, oy: number, x: number, y: number, z: number) => [ox + (x - y) * ISO_X * s, oy + ((x + y) * ISO_Y - z) * s] as const;
const css = (c: Hsl, a = 1) => `hsla(${c.h} ${c.s}% ${c.l}% / ${a})`;

function plate(ctx: CanvasRenderingContext2D, s: number, ox: number, oy: number, r: { x: number; y: number; w: number; d: number }, h: number, c: Hsl) {
  const at = (x: number, y: number, z: number) => P(s, ox, oy, x, y, z);
  const quad = (pts: (readonly [number, number])[], fill: string) => { ctx.beginPath(); pts.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); ctx.closePath(); ctx.fillStyle = fill; ctx.fill(); };
  const l = (f: number) => css({ ...c, l: c.l * f });
  quad([at(r.x, r.y + r.d, 0), at(r.x + r.w, r.y + r.d, 0), at(r.x + r.w, r.y + r.d, h), at(r.x, r.y + r.d, h)], l(DUSK.ws[0]));
  quad([at(r.x + r.w, r.y, 0), at(r.x + r.w, r.y + r.d, 0), at(r.x + r.w, r.y + r.d, h), at(r.x + r.w, r.y, h)], l(DUSK.ws[1]));
  quad([at(r.x, r.y, h), at(r.x + r.w, r.y, h), at(r.x + r.w, r.y + r.d, h), at(r.x, r.y + r.d, h)], l(1));
  ctx.strokeStyle = DUSK.outline; ctx.lineWidth = 1; ctx.stroke();
}

/** The landing page's demo of building shapes: a district whose request lights up stop by stop, and the legend of every shape. */
export function ShapeGallery() {
  const ref = useRef<HTMLCanvasElement>(null);
  const [focus, setFocus] = useState<Archetype | undefined>();
  const focusRef = useRef<Archetype | undefined>(undefined);
  focusRef.current = focus;
  useEffect(() => {
    const canvas = ref.current, ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let frame = 0, visible = true, start = performance.now();
    const order = LOTS.map((_, i) => i).sort((a, b) => (LOTS[a]![1] + LOTS[a]![2] + LOTS[a]![3] / 2 + LOTS[a]![4] / 2) - (LOTS[b]![1] + LOTS[b]![2] + LOTS[b]![3] / 2 + LOTS[b]![4] / 2));
    const draw = (now: number) => {
      const dpr = Math.min(2, window.devicePixelRatio || 1), w = canvas.clientWidth, h = canvas.clientHeight;
      if (canvas.width !== Math.round(w * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
      // Fit the district (its corners, and the tallest shapes at the back) with a small margin.
      const minX = -32 * ISO_X, maxX = 60 * ISO_X, minY = -9, maxY = (60 + 28) * ISO_Y + 1;
      const s = Math.min((w - 16) / (maxX - minX), (h - 16) / (maxY - minY)), ox = w / 2 - (minX + maxX) / 2 * s, oy = h / 2 - (minY + maxY) / 2 * s;
      const elapsed = still ? Infinity : now - start, cycle = FLOW.length * STOP_MS + HOLD_MS, local = still ? cycle : elapsed % cycle;
      const progress = Math.min(FLOW.length - 1, local / STOP_MS), t = still ? 0 : elapsed / 1000, focused = focusRef.current;
      for (const p of PLATES) plate(ctx, s, ox, oy, p, 0.9, DUSK_PLATE);
      const v = { ctx, s, ox, oy, T: DUSK };
      for (const i of order) {
        const [kind, x, y, lw, ld, loc] = LOTS[i]!, stop = FLOW.indexOf(i);
        const flowHot = focused ? 0 : stop >= 0 && stop <= progress + 0.02 ? Math.max(0.45, 1 - (progress - stop) * 0.9) : 0;
        drawShape(v, kind, { x, y, z: 0.9, w: lw, d: ld, H: shapeHeight(kind, Math.min(lw, ld), loc), c: focused && focused !== kind ? { ...DUSK_FILE, l: 22 } : DUSK_FILE, t, hot: focused === kind ? 1 : flowHot, seed: seedOf(`${kind}${i}`) });
      }
      if (!focused) {
        // The request's links, filled as far as the pulse has gone.
        const anchor = (i: number) => { const [kind, x, y, lw, ld, loc] = LOTS[i]!; return P(s, ox, oy, x + lw / 2, y + ld / 2, 0.9 + shapeHeight(kind, Math.min(lw, ld), loc) * 0.95); };
        for (let k = 0; k < FLOW.length - 1; k++) {
          const a = anchor(FLOW[k]!), b = anchor(FLOW[k + 1]!), lift = Math.min(70, Math.hypot(b[0] - a[0], b[1] - a[1]) * 0.3), m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2 - lift];
          const point = (u: number) => [(1 - u) ** 2 * a[0] + 2 * (1 - u) * u * m[0]! + u * u * b[0], (1 - u) ** 2 * a[1] + 2 * (1 - u) * u * m[1]! + u * u * b[1]];
          ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.quadraticCurveTo(m[0]!, m[1]!, b[0], b[1]); ctx.setLineDash([3, 4]); ctx.strokeStyle = css(DUSK.accent, 0.28); ctx.lineWidth = 1.2; ctx.stroke(); ctx.setLineDash([]);
          const fill = Math.max(0, Math.min(1, progress - k)); if (!fill) continue;
          ctx.beginPath(); ctx.moveTo(a[0], a[1]); for (let q = 1; q <= 24; q++) { const [px, py] = point(fill * q / 24); ctx.lineTo(px!, py!); }
          ctx.shadowColor = css(DUSK.accent); ctx.shadowBlur = 8; ctx.strokeStyle = css(DUSK.accent); ctx.lineWidth = 2; ctx.stroke(); ctx.shadowBlur = 0;
        }
      }
      ctx.font = '500 11px "Geist Mono Variable", "Geist Mono", ui-monospace, monospace'; ctx.fillStyle = '#7d7d84';
      for (const p of PLATES) { const [lx, ly] = P(s, ox, oy, p.x, p.y + p.d, 0.9); ctx.fillText(p.label, lx + 6, ly + 16); }
      if (visible && !still) frame = requestAnimationFrame(draw);
    };
    const observer = new IntersectionObserver(([entry]) => { visible = !!entry?.isIntersecting; cancelAnimationFrame(frame); if (visible || still) frame = requestAnimationFrame(draw); });
    observer.observe(canvas);
    const redraw = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(draw); };
    window.addEventListener('resize', redraw);
    canvas.addEventListener('codiluce:redraw', redraw);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); window.removeEventListener('resize', redraw); canvas.removeEventListener('codiluce:redraw', redraw); };
  }, []);
  // A still page draws once: draw again when the legend focus changes.
  useEffect(() => { ref.current?.dispatchEvent(new Event('codiluce:redraw')); }, [focus]);
  return (
    <div className="shape-gallery">
      <div className="shot-frame shape-stage">
        <canvas ref={ref} role="img" aria-label="An isometric district of two applications, each file drawn as the shape of its kind: a gate for routes, a traffic cop for a controller, a workshop for a service, drums for a table, towers for pages. A request lights them up one after another." />
      </div>
      <ul className="shape-legend" aria-label="Building shapes">
        {KINDS.map(kind => (
          <li key={kind}>
            <button type="button" aria-pressed={focus === kind} onMouseEnter={() => setFocus(kind)} onMouseLeave={() => setFocus(undefined)} onFocus={() => setFocus(kind)} onBlur={() => setFocus(undefined)} onClick={() => setFocus(focus === kind ? undefined : kind)}>
              <b>{ARCHETYPE_LABELS[kind].name}</b><span>{ARCHETYPE_LABELS[kind].shape}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
