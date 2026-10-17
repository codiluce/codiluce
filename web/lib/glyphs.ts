// Small flat marks for the kinds of block that matter when reading a flow,
// drawn beside a block's name in the name's own color, so color stays free
// for the lenses. They replace the building shapes where those are not drawn
// (shapes off, or the 2D plan). Strokes on a 12-unit square, scaled to the
// label's text.
import type { Archetype } from '@engine/projection/dto';

export type Glyph = 'page' | 'endpoint' | 'data' | 'job' | 'test';
/** Blocks show their glyph from this on-screen size (CSS px). */
export const GLYPH_PX = 60;
const GLYPHS: Partial<Record<Archetype, Glyph>> = { page: 'page', layout: 'page', routes: 'endpoint', controller: 'endpoint', model: 'data', table: 'data', job: 'job', schedule: 'job', test: 'test' };

export function glyphOf(kind: Archetype | undefined): Glyph | undefined { return kind ? GLYPHS[kind] : undefined; }

/** Draw a glyph centred on (cx, cy), `size` px wide, with a halo like the label's text. */
export function drawGlyph(ctx: CanvasRenderingContext2D, glyph: Glyph, cx: number, cy: number, size: number, color: string, halo: string): void {
  const s = size / 12;
  ctx.save();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.beginPath(); trace(ctx, glyph, cx, cy, s);
  ctx.lineWidth = Math.max(1.2, 1.3 * s) + 3; ctx.strokeStyle = halo; ctx.stroke();
  ctx.lineWidth = Math.max(1.2, 1.3 * s); ctx.strokeStyle = color; ctx.stroke();
  ctx.restore();
}

function trace(ctx: CanvasRenderingContext2D, glyph: Glyph, cx: number, cy: number, s: number): void {
  const p = (x: number, y: number) => [cx + x * s, cy + y * s] as const;
  const line = (...points: [number, number][]) => points.forEach(([x, y], i) => i ? ctx.lineTo(...p(x, y)) : ctx.moveTo(...p(x, y)));
  switch (glyph) {
    case 'page':
      // A browser window: frame and title bar.
      line([-5.5, -4.5], [5.5, -4.5], [5.5, 4.5], [-5.5, 4.5], [-5.5, -4.5]);
      line([-5.5, -1.8], [5.5, -1.8]);
      break;
    case 'endpoint':
      // A request going in: an arrow into a bracket.
      line([-5.5, 0], [1, 0]); line([-1.8, -2.8], [1, 0], [-1.8, 2.8]);
      line([2.8, -5], [5.2, -5], [5.2, 5], [2.8, 5]);
      break;
    case 'data':
      // A database cylinder.
      ctx.moveTo(...p(4.8, -3.4)); ctx.ellipse(cx, cy - 3.4 * s, 4.8 * s, 1.7 * s, 0, 0, Math.PI * 2);
      line([-4.8, -3.4], [-4.8, 3.4]); line([4.8, -3.4], [4.8, 3.4]);
      ctx.moveTo(...p(4.8, 0)); ctx.ellipse(cx, cy, 4.8 * s, 1.7 * s, 0, 0, Math.PI);
      ctx.moveTo(...p(4.8, 3.4)); ctx.ellipse(cx, cy + 3.4 * s, 4.8 * s, 1.7 * s, 0, 0, Math.PI);
      break;
    case 'job':
      // A clock: it runs on its own time.
      ctx.moveTo(...p(5.2, 0)); ctx.arc(cx, cy, 5.2 * s, 0, Math.PI * 2);
      line([0, -3.2], [0, 0], [2.4, 1.4]);
      break;
    case 'test':
      // A lab flask.
      line([-2.4, -5.2], [2.4, -5.2]);
      line([-1.3, -5.2], [-1.3, -1.6], [-5, 4.8], [5, 4.8], [1.3, -1.6], [1.3, -5.2]);
      line([-3.3, 1.8], [3.3, 1.8]);
      break;
  }
}
