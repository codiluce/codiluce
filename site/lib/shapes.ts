// Archetype shapes for the site: a copy of web/lib/shapes.ts (the site is a
// separate package), drawn with the Codiluce Dusk palette. Keep the two in
// step when the shapes change.
export type Archetype = 'entry' | 'routes' | 'middleware' | 'controller' | 'service' | 'helper' | 'command' | 'schedule' | 'job'
  | 'model' | 'table' | 'page' | 'layout' | 'component' | 'hook' | 'style' | 'config' | 'test';
export interface Hsl { h: number; s: number; l: number }
export const ISO_X = Math.cos(Math.PI / 6), ISO_Y = 0.5;

/** Blocks smaller than this on screen stay plain; up to SHAPE_PX they get an icon on the roof; past it they grow into their shape. */
export const ICON_PX = 18, SHAPE_PX = 46, SHAPE_GROW_PX = 34;
/** Shape height as a share of the footprint's shorter side (before the size of the file is taken into account). */
const HEIGHT: Record<Archetype, number> = {
  entry: 0.85, routes: 0.62, middleware: 0.62, controller: 0.62, service: 0.66, helper: 0.5, command: 0.72, schedule: 0.88, job: 0.52,
  model: 0.6, table: 0.58, page: 0.8, layout: 0.66, component: 0.5, hook: 0.86, style: 0.42, config: 0.5, test: 0.66,
};
export function shapeHeight(kind: Archetype, side: number, loc: number | undefined): number {
  const size = loc === undefined ? 0.75 : Math.min(1.15, 0.7 + Math.log2(1 + loc / 40) * 0.12);
  return side * HEIGHT[kind] * size;
}
export const ARCHETYPE_LABELS: Record<Archetype, { name: string; shape: string }> = {
  entry: { name: 'Entry point', shape: 'lighthouse' }, routes: { name: 'Routes', shape: 'gate' }, middleware: { name: 'Middleware', shape: 'checkpoint' },
  controller: { name: 'Controller', shape: 'rail turntable' }, service: { name: 'Service', shape: 'workshop' }, helper: { name: 'Helper', shape: 'tool shed' },
  command: { name: 'Command', shape: 'terminal kiosk' }, schedule: { name: 'Scheduled task', shape: 'clock tower' }, job: { name: 'Job or listener', shape: 'conveyor belt' },
  model: { name: 'Model', shape: 'stacked records' }, table: { name: 'Database table', shape: 'storage drums' }, page: { name: 'Page', shape: 'browser billboard' },
  layout: { name: 'Layout', shape: 'open frame' }, component: { name: 'Component', shape: 'building block' }, hook: { name: 'Hook or store', shape: 'crane' },
  style: { name: 'Style sheet', shape: "painter's palette" }, config: { name: 'Configuration', shape: 'control desk' }, test: { name: 'Test', shape: 'lab bench with test tubes' },
};

export interface ShapeTheme { dark: boolean; ws: [number, number]; outline: string; accent: Hsl; ink: Hsl; glass: Hsl; entry: Hsl; face: Hsl }
/** Codiluce Dusk, as in the app. */
export const DUSK: ShapeTheme = {
  dark: true, ws: [0.5, 0.72], outline: 'rgba(245,245,243,0.13)', accent: { h: 39, s: 100, l: 64 },
  ink: { h: 240, s: 5, l: 9 }, glass: { h: 215, s: 18, l: 58 }, entry: { h: 38, s: 40, l: 34 }, face: { h: 40, s: 12, l: 86 },
};
export const DUSK_FILE: Hsl = { h: 240, s: 3, l: 34 };
export const DUSK_PLATE: Hsl = { h: 240, s: 4, l: 13 };

/** Screen placement: point = (ox, oy) + projection × s (CSS pixels). */
export interface ShapeView { ctx: CanvasRenderingContext2D; s: number; ox: number; oy: number; T: ShapeTheme }
export interface ShapeInput { x: number; y: number; z: number; w: number; d: number; H: number; c: Hsl; t: number; hot: number; seed: number }

type V3 = [number, number, number];
type Face = { o: V3; u: V3; v: V3 };
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const css = (c: Hsl, f = 1, dl = 0, a = 1) => `hsla(${c.h} ${c.s}% ${clamp(c.l * f + dl, 2, 98).toFixed(1)}% / ${a})`;
const P = (v: ShapeView, x: number, y: number, z: number): [number, number] => [v.ox + (x - y) * ISO_X * v.s, v.oy + ((x + y) * ISO_Y - z) * v.s];
/** Wall tone for a face normal, blending the theme's top, left and right shades. */
function shade(T: ShapeTheme, n: V3): number {
  const nx = Math.max(0, n[0]), ny = Math.max(0, n[1]), nz = Math.max(0, n[2]), sum = nx + ny + nz || 1;
  return (nz + ny * T.ws[0] + nx * T.ws[1]) / sum;
}
function path(v: ShapeView, pts: V3[]): void {
  const c = v.ctx; c.beginPath();
  pts.forEach((p, i) => { const q = P(v, p[0], p[1], p[2]); if (i) c.lineTo(q[0], q[1]); else c.moveTo(q[0], q[1]); });
  c.closePath();
}
/** `bare`: no edges (one of many facets of a curved side). */
interface FaceOptions { both?: boolean; dl?: number; a?: number; top?: string; end?: string; bare?: boolean }
/** A planar face; hidden when it turns away from the viewer, who looks along -(1,1,1). */
function face(v: ShapeView, pts: V3[], n: V3, col: Hsl | string, o: FaceOptions = {}): void {
  if (!o.both && n[0] + n[1] + n[2] <= 1e-6) return;
  path(v, pts);
  v.ctx.fillStyle = typeof col === 'string' ? col : css(col, shade(v.T, n), o.dl ?? 0, o.a ?? 1);
  v.ctx.fill();
  // Edges only where they show: faces a few pixels across.
  const a = pts[0]!, b = pts[2]!;
  if (!o.bare && v.s * (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2])) > 14) { v.ctx.strokeStyle = v.T.outline; v.ctx.lineWidth = 0.75; v.ctx.stroke(); }
}
function box(v: ShapeView, x: number, y: number, z: number, w: number, d: number, h: number, col: Hsl | string, o: FaceOptions = {}): void {
  if (w <= 0 || d <= 0 || h <= 0) return;
  face(v, [[x, y + d, z], [x + w, y + d, z], [x + w, y + d, z + h], [x, y + d, z + h]], [0, 1, 0], col, o);
  face(v, [[x + w, y, z], [x + w, y + d, z], [x + w, y + d, z + h], [x + w, y, z + h]], [1, 0, 0], col, o);
  face(v, [[x, y, z + h], [x + w, y, z + h], [x + w, y + d, z + h], [x, y + d, z + h]], [0, 0, 1], o.top ?? col, o);
}
const boxR = (v: ShapeView, r: [number, number, number, number], z: number, h: number, col: Hsl | string, o?: FaceOptions) => box(v, r[0], r[1], z, r[2], r[3], h, col, o);
/** A box of length L and width w turned by `angle` about its center (a turntable's bridge). Its visible sides never overlap, so any order will do. */
function obox(v: ShapeView, cx: number, cy: number, z: number, L: number, w: number, h: number, angle: number, col: Hsl | string, o: FaceOptions = {}): void {
  const ax = Math.cos(angle), ay = Math.sin(angle), at = (p: number, q: number, zz: number): V3 => [cx + ax * L / 2 * p - ay * w / 2 * q, cy + ay * L / 2 * p + ax * w / 2 * q, zz];
  for (const p of [-1, 1]) face(v, [at(p, -1, z), at(p, 1, z), at(p, 1, z + h), at(p, -1, z + h)], [ax * p, ay * p, 0], col, o);
  for (const q of [-1, 1]) face(v, [at(-1, q, z), at(1, q, z), at(1, q, z + h), at(-1, q, z + h)], [-ay * q, ax * q, 0], col, o);
  face(v, [at(-1, -1, z + h), at(1, -1, z + h), at(1, 1, z + h), at(-1, 1, z + h)], [0, 0, 1], o.top ?? col, o);
}
/** Pitched roof, ridge along x or y; the visible gable end is the pediment. */
function gable(v: ShapeView, x: number, y: number, z: number, w: number, d: number, h: number, axis: 'x' | 'y', col: Hsl, o: FaceOptions = {}): void {
  const end = o.end ?? col;
  if (axis === 'x') {
    face(v, [[x, y, z], [x + w, y, z], [x + w, y + d / 2, z + h], [x, y + d / 2, z + h]], [0, -h, d / 2], col, o);
    face(v, [[x, y + d / 2, z + h], [x + w, y + d / 2, z + h], [x + w, y + d, z], [x, y + d, z]], [0, h, d / 2], col, o);
    face(v, [[x + w, y, z], [x + w, y + d, z], [x + w, y + d / 2, z + h]], [1, 0, 0], end, o);
  } else {
    face(v, [[x, y, z], [x, y + d, z], [x + w / 2, y + d, z + h], [x + w / 2, y, z + h]], [-h, 0, w / 2], col, o);
    face(v, [[x + w / 2, y, z + h], [x + w / 2, y + d, z + h], [x + w, y + d, z], [x + w, y, z]], [h, 0, w / 2], col, o);
    face(v, [[x, y + d, z], [x + w, y + d, z], [x + w / 2, y + d, z + h]], [0, 1, 0], end, o);
  }
}
function hip(v: ShapeView, x: number, y: number, z: number, w: number, d: number, h: number, col: Hsl, o: FaceOptions = {}): void {
  const a: V3 = [x + w / 2, y + d / 2, z + h];
  face(v, [[x, y, z], [x + w, y, z], a], [0, -h, d / 2], col, o);
  face(v, [[x, y + d, z], [x, y, z], a], [-h, 0, w / 2], col, o);
  face(v, [[x + w, y + d, z], [x, y + d, z], a], [0, h, d / 2], col, o);
  face(v, [[x + w, y, z], [x + w, y + d, z], a], [h, 0, w / 2], col, o);
}
/** Factory roof: teeth along x with glazing on their steep side. */
function saw(v: ShapeView, x: number, y: number, z: number, w: number, d: number, h: number, n: number, col: Hsl, glass: string): void {
  const tw = w / n;
  for (let i = 0; i < n; i++) {
    const x0 = x + i * tw, x1 = x0 + tw;
    face(v, [[x0, y, z], [x0, y + d, z], [x1, y + d, z + h], [x1, y, z + h]], [-h, 0, tw], col);
    face(v, [[x0, y + d, z], [x1, y + d, z], [x1, y + d, z + h]], [0, 1, 0], col);
    face(v, [[x1, y, z], [x1, y + d, z], [x1, y + d, z + h], [x1, y, z + h]], [1, 0, 0], glass);
  }
}
function cyl(v: ShapeView, cx: number, cy: number, z: number, r: number, h: number, col: Hsl, o: FaceOptions = {}): void {
  const c = v.ctx, T = v.T, top = P(v, cx, cy, z + h), bot = P(v, cx, cy, z);
  const rx = r * Math.SQRT2 * ISO_X * v.s, ry = r * Math.SQRT2 * ISO_Y * v.s;
  if (rx < 0.4) return;
  const g = c.createLinearGradient(top[0] - rx, 0, top[0] + rx, 0);
  const a = o.a ?? 1;
  g.addColorStop(0, css(col, T.ws[0], o.dl ?? 0, a)); g.addColorStop(1, css(col, T.ws[1], o.dl ?? 0, a));
  c.beginPath(); c.moveTo(top[0] - rx, top[1]); c.lineTo(bot[0] - rx, bot[1]);
  c.ellipse(bot[0], bot[1], rx, ry, 0, Math.PI, 0, true); c.lineTo(top[0] + rx, top[1]); c.closePath();
  c.fillStyle = g; c.fill();
  const outlined = rx > 3; if (outlined) { c.strokeStyle = T.outline; c.lineWidth = 0.75; c.stroke(); }
  c.beginPath(); c.ellipse(top[0], top[1], rx, ry, 0, 0, Math.PI * 2);
  c.fillStyle = o.top ?? css(col, 1, o.dl ?? 0, a); c.fill(); if (outlined) c.stroke();
}
/** A cylinder narrowing (or widening) from radius r0 at the bottom to r1 at the top: a flask's body. */
function cone(v: ShapeView, cx: number, cy: number, z: number, r0: number, r1: number, h: number, col: Hsl, o: FaceOptions = {}): void {
  const c = v.ctx, T = v.T, top = P(v, cx, cy, z + h), bot = P(v, cx, cy, z), k = Math.SQRT2 * v.s;
  const rx0 = r0 * k * ISO_X, ry0 = r0 * k * ISO_Y, rx1 = r1 * k * ISO_X, ry1 = r1 * k * ISO_Y, a = o.a ?? 1;
  if (rx0 < 0.4) return;
  const g = c.createLinearGradient(bot[0] - rx0, 0, bot[0] + rx0, 0);
  g.addColorStop(0, css(col, T.ws[0], o.dl ?? 0, a)); g.addColorStop(1, css(col, T.ws[1], o.dl ?? 0, a));
  c.beginPath(); c.moveTo(top[0] - rx1, top[1]); c.lineTo(bot[0] - rx0, bot[1]);
  c.ellipse(bot[0], bot[1], rx0, ry0, 0, Math.PI, 0, true); c.lineTo(top[0] + rx1, top[1]); c.closePath();
  c.fillStyle = g; c.fill();
  const outlined = rx0 > 3; if (outlined) { c.strokeStyle = T.outline; c.lineWidth = 0.75; c.stroke(); }
  c.beginPath(); c.ellipse(top[0], top[1], rx1, ry1, 0, 0, Math.PI * 2);
  c.fillStyle = o.top ?? css(col, 1, o.dl ?? 0, a); c.fill(); if (outlined) c.stroke();
}
/** A ball (a head, a glove, a bubble), lit from the top left. A sphere of radius r projects to a circle of r·√1.5. */
function ball(v: ShapeView, x: number, y: number, z: number, r: number, col: Hsl, a = 1): void {
  const p = P(v, x, y, z), R = r * 1.2247 * v.s, c = v.ctx;
  if (R < 0.5) return;
  const g = c.createRadialGradient(p[0] - R * 0.35, p[1] - R * 0.4, R * 0.1, p[0], p[1], R);
  g.addColorStop(0, css(col, 1, v.T.dark ? 10 : 6, a)); g.addColorStop(1, css(col, v.T.ws[0], 0, a));
  c.beginPath(); c.arc(p[0], p[1], R, 0, Math.PI * 2); c.fillStyle = g; c.fill();
}
function disc(v: ShapeView, cx: number, cy: number, z: number, r: number, fill: string): void {
  const p = P(v, cx, cy, z), c = v.ctx;
  c.beginPath(); c.ellipse(p[0], p[1], r * Math.SQRT2 * ISO_X * v.s, r * Math.SQRT2 * ISO_Y * v.s, 0, 0, Math.PI * 2); c.fillStyle = fill; c.fill();
}
/** Front half of a ring around a cylinder (bands on drums and towers). */
function band(v: ShapeView, cx: number, cy: number, z: number, r: number, color: string, width: number): void {
  const c = v.ctx, p = P(v, cx, cy, z);
  c.beginPath(); c.ellipse(p[0], p[1], r * Math.SQRT2 * ISO_X * v.s, r * Math.SQRT2 * ISO_Y * v.s, 0, 0, Math.PI);
  c.strokeStyle = color; c.lineWidth = width; c.stroke();
}
/** Face frames of a box: point = o + u·a + v·b with a, b in 0..1. */
const frames = (x: number, y: number, z: number, w: number, d: number, h: number): { L: Face; R: Face; T: Face } => ({
  L: { o: [x, y + d, z], u: [w, 0, 0], v: [0, 0, h] },
  R: { o: [x + w, y, z], u: [0, d, 0], v: [0, 0, h] },
  T: { o: [x, y, z + h], u: [w, 0, 0], v: [0, d, 0] },
});
const fpt = (F: Face, a: number, b: number): V3 => [F.o[0] + F.u[0] * a + F.v[0] * b, F.o[1] + F.u[1] * a + F.v[1] * b, F.o[2] + F.u[2] * a + F.v[2] * b];
function decal(v: ShapeView, F: Face, a0: number, b0: number, a1: number, b1: number, fill: string): void { path(v, [fpt(F, a0, b0), fpt(F, a1, b0), fpt(F, a1, b1), fpt(F, a0, b1)]); v.ctx.fillStyle = fill; v.ctx.fill(); }
function decalPoly(v: ShapeView, F: Face, pts: [number, number][], fill: string): void { path(v, pts.map(p => fpt(F, p[0], p[1]))); v.ctx.fillStyle = fill; v.ctx.fill(); }
const len = (u: V3) => Math.hypot(u[0], u[1], u[2]) || 1;
/** A circle of world radius R on a face, around (a, b). */
function decalCircle(v: ShapeView, F: Face, a: number, b: number, R: number, fill: string): void {
  const ru = R / len(F.u), rv = R / len(F.v), pts: [number, number][] = [];
  for (let i = 0; i < 24; i++) { const t = (i / 24) * Math.PI * 2; pts.push([a + Math.cos(t) * ru, b + Math.sin(t) * rv]); }
  decalPoly(v, F, pts, fill);
}
function line3(v: ShapeView, a: V3, b: V3, color: string, width: number): void {
  const p = P(v, ...a), q = P(v, ...b), c = v.ctx;
  c.beginPath(); c.moveTo(p[0], p[1]); c.lineTo(q[0], q[1]); c.strokeStyle = color; c.lineWidth = width; c.lineCap = 'round'; c.stroke();
}
function glow(v: ShapeView, x: number, y: number, z: number, r: number, color: Hsl, alpha: number): void {
  const p = P(v, x, y, z), R = r * v.s, c = v.ctx;
  if (R < 1 || alpha <= 0) return;
  const g = c.createRadialGradient(p[0], p[1], 0, p[0], p[1], R);
  g.addColorStop(0, css(color, 1, 0, alpha)); g.addColorStop(1, css(color, 1, 0, 0));
  c.fillStyle = g; c.beginPath(); c.arc(p[0], p[1], R, 0, Math.PI * 2); c.fill();
}
const hash = (n: number) => { const s = Math.sin(n * 127.1) * 43758.5453; return s - Math.floor(s); };
export function seedOf(id: string): number { let h = 0; for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0; return h % 9973; }

interface K extends ShapeInput { v: ShapeView; T: ShapeTheme; X: number; Y: number; W: number; D: number; Z: number; m: number; u: number }
const lit = (k: K, a = 1) => css(k.T.accent, 1, 0, a);
const ink = (k: K, a = 1) => css(k.T.ink, 1, 0, a);
const glassL = (k: K, a = 0.95) => css(k.T.glass, k.T.ws[0], 0, a), glassR = (k: K, a = 0.95) => css(k.T.glass, k.T.ws[1], 0, a);
const on = (k: K) => k.hot > 0.05;
/** Paint and liquid colors: the few details that keep hues of their own, whatever the lens. */
const paint = (T: ShapeTheme, hue: number): Hsl => ({ h: hue, s: T.dark ? 55 : 62, l: T.dark ? 56 : 56 });
/** Rects along the longer side of the footprint, so one shape serves strips in either direction. */
function axis(k: K) {
  const alongX = k.w >= k.d, L = alongX ? k.W : k.D, S = alongX ? k.D : k.W;
  return { L, S, R: (a0: number, b0: number, la: number, lb: number): [number, number, number, number] => alongX ? [k.X + a0, k.Y + b0, la, lb] : [k.X + b0, k.Y + a0, lb, la] };
}
/** The plot under a shape, so the footprint the layout gave still reads. */
const lot = (k: K) => box(k.v, k.x, k.y, k.z, k.w, k.d, k.u * 0.3, k.c, { dl: k.T.dark ? -4 : -5 });

const DRAW: Record<Archetype, (k: K) => void> = {
  entry(k) {
    const { v, c, T, H } = k, cx = k.X + k.W / 2, cy = k.Y + k.D / 2, r = k.m * 0.2, z1 = k.Z + H * 0.12, th = H * 0.66;
    lot(k);
    box(v, cx - k.m * 0.36, cy - k.m * 0.36, k.Z, k.m * 0.72, k.m * 0.72, H * 0.12, c);
    cyl(v, cx, cy, z1, r, th, c);
    for (const f of [0.3, 0.62]) band(v, cx, cy, z1 + th * f, r, lit(k, 0.9), Math.max(1, r * v.s * 0.3));
    cyl(v, cx, cy, z1 + th, r * 0.72, H * 0.13, T.accent, { dl: T.dark ? 0 : 8 });
    cyl(v, cx, cy, z1 + th + H * 0.13, r * 0.95, H * 0.05, T.ink);
    glow(v, cx, cy, z1 + th + H * 0.07, k.m * 0.9, T.accent, 0.22 + 0.4 * k.hot * (0.75 + 0.25 * Math.sin(k.t * 2.4)));
  },
  routes(k) {
    const { v, c, T, H } = k, pw = k.W * 0.16, py = k.Y + k.D * 0.34, pd = k.D * 0.32, ph = H * 0.7;
    lot(k);
    decal(v, frames(k.x, k.y, k.z, k.w, k.d, k.u * 0.3).T, 0.42, 0, 0.58, 1, lit(k, 0.2 + 0.4 * k.hot));
    box(v, k.X + k.W * 0.1, py, k.Z, pw, pd, ph, c);
    box(v, k.X + k.W * 0.1, py + pd * 0.3, k.Z + ph * 0.7, k.W * 0.8, pd * 0.4, H * 0.06, c);
    box(v, k.X + k.W * 0.74, py, k.Z, pw, pd, ph, c);
    box(v, k.X + k.W * 0.02, py - pd * 0.15, k.Z + ph, k.W * 0.96, pd * 1.3, H * 0.13, T.entry, { dl: on(k) ? 10 : 0 });
  },
  middleware(k) {
    const { v, c, T, H } = k, bw = k.W * 0.38, bd = k.D * 0.42, bh = H * 0.58;
    lot(k);
    box(v, k.X, k.Y, k.Z, bw, bd, bh, c);
    const f = frames(k.X, k.Y, k.Z, bw, bd, bh);
    decal(v, f.R, 0.2, 0.45, 0.8, 0.82, on(k) ? lit(k) : glassR(k));
    decal(v, f.L, 0.25, 0.45, 0.75, 0.82, glassL(k));
    box(v, k.X - k.W * 0.03, k.Y - k.D * 0.03, k.Z + bh, bw + k.W * 0.06, bd + k.D * 0.06, H * 0.06, c, { dl: T.dark ? -5 : -8 });
    const s = k.m * 0.1, px = k.X + k.W * 0.06, py = k.Y + k.D * 0.72;
    box(v, px, py, k.Z, s, s, H * 0.4, c);
    const raise = Math.PI * 0.42 * k.hot * (0.5 + 0.5 * Math.sin(k.t * 1.6)), ox = px + s / 2, oy = py + s, oz = k.Z + H * 0.36, L = k.W * 0.88, tz = k.m * 0.08, n = 6;
    const at = (q: number, w: number): V3 => [ox + L * q * Math.cos(raise) - Math.sin(raise) * w, oy, oz + L * q * Math.sin(raise) + Math.cos(raise) * w];
    for (let i = 0; i < n; i++) face(v, [at(i / n, 0), at((i + 1) / n, 0), at((i + 1) / n, tz), at(i / n, tz)], [0, 1, 0], i % 2 ? css(c, 1, T.dark ? 40 : 0) : lit(k), { both: true });
  },
  controller(k) {
    // A railway turntable at a junction: tracks leave in four directions and the bridge turns to the one a request takes; a signal box and a signal beside it.
    const { v, c, T, H } = k, m = k.m, cx = k.X + k.W / 2, cy = k.Y + k.D / 2, r = m * 0.34, g = m * 0.075;
    lot(k);
    const ground = frames(k.x, k.y, k.z, k.w, k.d, k.u * 0.3).T;
    const plot = (x0: number, y0: number, x1: number, y1: number, fill: string) => decal(v, ground, (x0 - k.x) / k.w, (y0 - k.y) / k.d, (x1 - k.x) / k.w, (y1 - k.y) / k.d, fill);
    // The bridge holds, then turns a quarter, while a flow passes; at rest it lines up with one pair of tracks.
    const phase = k.t * 0.45, ease = clamp((phase % 1 - 0.55) / 0.45, 0, 1), turn = on(k) ? Math.floor(phase) + ease * ease * (3 - 2 * ease) : k.seed % 2;
    const angle = turn * Math.PI / 2, aligned = on(k) && (ease === 0 || ease === 1), alongX = Math.round(turn) % 2 === 0;
    const sleeper = css(c, 1, T.dark ? -14 : -16), tw = m * 0.022, step = m * 0.07;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const rail = css(aligned && (dx !== 0) === alongX ? T.accent : T.ink, 1, 0, aligned && (dx !== 0) === alongX ? 0.95 : 0.7);
      const from = r * 0.98, to = dx ? (dx > 0 ? k.x + k.w - cx : cx - k.x) : (dy > 0 ? k.y + k.d - cy : cy - k.y);
      for (let s = from + step / 2; s < to - step / 3; s += step) {
        const px = cx + (dx || dy) * s * (dx ? 1 : 0), py = cy + (dx || dy) * s * (dy ? 1 : 0), half = g * 1.45, w2 = tw * 1.2;
        if (dx) plot(px - w2, py - half, px + w2, py + half, sleeper); else plot(px - half, py - w2, px + half, py + w2, sleeper);
      }
      for (const side of [-1, 1]) {
        const a = cx + side * g * (dx ? 0 : 1), b = cy + side * g * (dy ? 0 : 1);
        if (dx) plot(Math.min(cx + dx * from, cx + dx * to), b - tw / 2, Math.max(cx + dx * from, cx + dx * to), b + tw / 2, rail);
        else plot(a - tw / 2, Math.min(cy + dy * from, cy + dy * to), a + tw / 2, Math.max(cy + dy * from, cy + dy * to), rail);
      }
    }
    // The signal box at the back corner: glazed all round under a hipped roof, lit while it dispatches.
    const sb = m * 0.24, sh = H * 0.56, box0 = frames(k.X, k.Y, k.Z, sb, sb, sh);
    box(v, k.X, k.Y, k.Z, sb, sb, sh, c, { dl: T.dark ? 4 : -4 });
    for (const [F, glass] of [[box0.L, glassL], [box0.R, glassR]] as const) decal(v, F, 0.12, 0.55, 0.88, 0.85, on(k) ? lit(k, 0.85) : glass(k));
    hip(v, k.X - sb * 0.08, k.Y - sb * 0.08, k.Z + sh, sb * 1.16, sb * 1.16, H * 0.3, c, { dl: T.dark ? -6 : -12 });
    // A signal on the right corner: red at rest, green (and shining) while the way is set.
    const mx = k.X + k.W - m * 0.1, my = k.Y + m * 0.04, ms = m * 0.035, mh = H * 0.5, hw = m * 0.08, hh = H * 0.22;
    box(v, mx, my, k.Z, ms, ms, mh, T.ink, { dl: T.dark ? 10 : 8 });
    const hx = mx - (hw - ms) / 2, head = frames(hx, my, k.Z + mh, hw, ms * 1.6, hh).L;
    box(v, hx, my, k.Z + mh, hw, ms * 1.6, hh, T.ink, { dl: T.dark ? 6 : 4 });
    for (const [b, color, set] of [[0.72, { h: 2, s: 70, l: 52 }, !aligned], [0.3, { h: 142, s: 68, l: 50 }, aligned]] as const) {
      decalCircle(v, head, 0.5, b, Math.min(hw, hh / 2) * 0.32, css(color, 1, set ? 0 : (T.dark ? -30 : -12), set ? (aligned ? 1 : 0.8) : 0.5));
      if (set && aligned) glow(v, ...fpt(head, 0.5, b), m * 0.12, color, 0.45);
    }
    // The pit's rim, its floor, and the bridge with its rails and the operator's hut at one end.
    const rim = H * 0.1, zb = k.Z + rim;
    cyl(v, cx, cy, k.Z, r, rim, c, { dl: T.dark ? -8 : -14, top: css(c, 1, T.dark ? -2 : -6) });
    disc(v, cx, cy, zb, r * 0.84, css(c, 1, T.dark ? -14 : -20));
    for (const f of [0.5]) band(v, cx, cy, k.Z + rim * f, r, ink(k, 0.3), Math.max(1, rim * v.s * 0.2));
    const bl = r * 1.86, bw = g * 3, bh = H * 0.1, ax = Math.cos(angle), ay = Math.sin(angle);
    obox(v, cx, cy, zb - bh * 0.4, bl, bw, bh, angle, c, { dl: T.dark ? 12 : 4 });
    for (const side of [-1, 1]) {
      const ox = -ay * g * side, oy = ax * g * side, z = zb + bh * 0.6;
      line3(v, [cx - ax * bl / 2 + ox, cy - ay * bl / 2 + oy, z], [cx + ax * bl / 2 + ox, cy + ay * bl / 2 + oy, z], css(on(k) ? T.accent : T.ink, 1, 0, 0.8), Math.max(1, tw * v.s));
    }
    const hut = bl * 0.36;
    obox(v, cx + ax * bl * 0.3, cy + ay * bl * 0.3, zb + bh * 0.6, hut * 0.62, bw * 0.92, H * 0.24, angle, c, { dl: T.dark ? 20 : -8 });
    disc(v, cx, cy, zb + bh * 0.6 + 0.01, g * 0.7, css(T.ink, 1, T.dark ? 10 : 20));
  },
  service(k) {
    const { v, c, T, H } = k, hh = H * 0.5, rh = H * 0.24;
    lot(k);
    box(v, k.X, k.Y, k.Z, k.W, k.D, hh, c);
    const f = frames(k.X, k.Y, k.Z, k.W, k.D, hh);
    decal(v, f.L, 0.42, 0, 0.62, 0.62, on(k) ? lit(k, 0.6 + 0.4 * k.hot) : ink(k, 0.8));
    decal(v, f.L, 0.1, 0.4, 0.3, 0.75, glassL(k)); decal(v, f.L, 0.72, 0.4, 0.9, 0.75, glassL(k));
    saw(v, k.X, k.Y, k.Z + hh, k.W, k.D, rh, clamp(Math.round(k.W / (k.m * 0.3)), 2, 6), c, on(k) ? lit(k, 0.85) : glassR(k));
    const chx = k.X + k.W * 0.14, chy = k.Y + k.D * 0.2, chr = k.m * 0.08, from = k.Z + hh + rh * 0.4, top = k.Z + H * 0.98;
    cyl(v, chx, chy, from, chr, top - from, c, { dl: T.dark ? -4 : -10 });
    if (!on(k)) return;
    for (let i = 0; i < 4; i++) {
      const ph = (k.t * 0.3 + i / 4) % 1, p = P(v, chx + ph * k.m * 0.25, chy - ph * k.m * 0.1, top + ph * H * 0.6);
      v.ctx.beginPath(); v.ctx.arc(p[0], p[1], chr * v.s * (0.8 + ph * 1.8), 0, Math.PI * 2);
      v.ctx.fillStyle = T.dark ? `rgba(245,245,243,${0.22 * (1 - ph) * k.hot})` : `rgba(17,17,19,${0.14 * (1 - ph) * k.hot})`; v.ctx.fill();
    }
  },
  helper(k) {
    const { v, c, T, H } = k, sw = k.W * 0.6, sd = k.D * 0.62, sh = H * 0.42;
    lot(k);
    box(v, k.X, k.Y, k.Z, sw, sd, sh, c);
    decal(v, frames(k.X, k.Y, k.Z, sw, sd, sh).L, 0.38, 0, 0.62, 0.72, on(k) ? lit(k) : ink(k, 0.75));
    const ax = sw >= sd ? 'x' : 'y';
    gable(v, k.X - sw * 0.04, k.Y - sd * 0.04, k.Z + sh, sw * 1.08, sd * 1.08, Math.min(H * 0.4, (ax === 'x' ? sd : sw) * 0.45), ax, c, { dl: T.dark ? -6 : -10 });
    const s = k.m * 0.24, o = { dl: T.dark ? 6 : -6 };
    box(v, k.X + k.W - s * 2.15, k.Y + k.D - s, k.Z, s, s, s * 0.9, c, o);
    box(v, k.X + k.W - s, k.Y + k.D - s, k.Z, s, s, s * 0.9, c, o);
    box(v, k.X + k.W - s * 1.6, k.Y + k.D - s * 0.95, k.Z + s * 0.9, s * 0.9, s * 0.9, s * 0.8, c, o);
  },
  command(k) {
    const { v, c, T, H } = k, kw = k.W * 0.72, kd = k.D * 0.58, kh = H * 0.78, kx = k.X + (k.W - kw) / 2, ky = k.Y + k.D * 0.1;
    lot(k);
    box(v, kx, ky, k.Z, kw, kd, kh, c);
    const f = frames(kx, ky, k.Z, kw, kd, kh);
    decal(v, f.L, 0.1, 0.32, 0.9, 0.9, ink(k, 0.95));
    decal(v, f.L, 0.16, 0.76, 0.22, 0.82, lit(k, 0.9)); decal(v, f.L, 0.26, 0.77, 0.7, 0.81, lit(k, 0.55));
    decal(v, f.L, 0.16, 0.64, 0.6, 0.68, lit(k, 0.35)); decal(v, f.L, 0.16, 0.54, 0.48, 0.58, lit(k, 0.35));
    if (!on(k) || Math.floor(k.t * 2) % 2 === 0) decal(v, f.L, 0.16, 0.4, 0.23, 0.47, lit(k));
    box(v, kx + kw * 0.1, ky + kd, k.Z + kh * 0.36, kw * 0.8, k.D * 0.2, kh * 0.05, c, { dl: T.dark ? 5 : -5 });
    const ax = kx + kw * 0.75, ay = ky + kd * 0.3;
    line3(v, [ax, ay, k.Z + kh], [ax, ay, k.Z + H * 0.98], ink(k, 0.8), Math.max(1, v.s * k.u * 0.08));
    glow(v, ax, ay, k.Z + H * 0.98, k.m * 0.18, T.accent, 0.35 + 0.5 * k.hot);
  },
  schedule(k) {
    const { v, c, T, H } = k, s = k.m * 0.56, tx = k.X + (k.W - s) / 2, ty = k.Y + (k.D - s) / 2, th = H * 0.72;
    lot(k);
    box(v, tx - s * 0.12, ty - s * 0.12, k.Z, s * 1.24, s * 1.24, H * 0.06, c, { dl: T.dark ? -3 : -5 });
    box(v, tx, ty, k.Z, s, s, th, c);
    const f = frames(tx, ty, k.Z, s, s, th), R = s * 0.3, bz = 0.8, minute = k.hot ? k.t * 0.9 : k.seed, hour = minute / 12 + 1.3;
    for (const F of [f.L, f.R]) {
      decalCircle(v, F, 0.5, bz, R, css(T.face));
      for (const [a, length] of [[minute, R * 0.82], [hour, R * 0.52]] as const) {
        line3(v, fpt(F, 0.5, bz), fpt(F, 0.5 + Math.cos(a) * length / len(F.u), bz + Math.sin(a) * length / len(F.v)), ink(k, 0.9), Math.max(1, v.s * k.u * 0.09));
      }
    }
    hip(v, tx - s * 0.06, ty - s * 0.06, k.Z + th, s * 1.12, s * 1.12, Math.min(s * 0.62, H * 0.28), c, { dl: T.dark ? -4 : -10 });
  },
  job(k) {
    const { v, c, T, H } = k, a = axis(k), L = a.L, S = a.S, bz = k.Z + H * 0.24, bh = H * 0.12;
    lot(k);
    boxR(v, a.R(0, S * 0.18, L * 0.13, S * 0.64), k.Z, H * 0.62, c);
    for (const at of [0.2, 0.75]) boxR(v, a.R(L * at, S * 0.36, k.m * 0.06, S * 0.28), k.Z, H * 0.24, c, { dl: T.dark ? -6 : -10 });
    boxR(v, a.R(L * 0.1, S * 0.3, L * 0.8, S * 0.4), bz, bh, T.ink, { top: css(T.ink, 1, T.dark ? 8 : 12) });
    const n = 3, cs = Math.min(S * 0.32, L * 0.14), run = L * 0.74 - cs, phase = k.hot ? k.t * 0.25 : hash(k.seed);
    const crates = [...Array(n)].map((_, i) => (phase + i / n) % 1).sort((p1, p2) => p1 - p2);
    for (const p of crates) boxR(v, a.R(L * 0.13 + p * run, S * 0.5 - cs / 2, cs, cs), bz + bh, cs * 0.85, c, { dl: T.dark ? 12 : -8 });
    boxR(v, a.R(L * 0.87, S * 0.18, L * 0.13, S * 0.64), k.Z, H * 0.62, c);
  },
  model(k) {
    const { v, c, T, H } = k, n = 4, total = H * 0.92, gap = total * 0.09, sh = (total - gap * (n - 1)) / n;
    lot(k);
    box(v, k.X + k.W * 0.3, k.Y + k.D * 0.3, k.Z, k.W * 0.4, k.D * 0.4, total, c, { dl: T.dark ? -10 : -18 });
    let top: Face | undefined;
    for (let i = 0; i < n; i++) {
      const off = (i % 2 ? 1 : -1) * k.m * 0.025, x = k.X + k.W * 0.03 + off, y = k.Y + k.D * 0.03 - off, z = k.Z + i * (sh + gap);
      box(v, x, y, z, k.W * 0.94, k.D * 0.94, sh, c, { dl: on(k) && i === n - 1 ? (T.dark ? 10 : -6) : 0 });
      top = frames(x, y, z, k.W * 0.94, k.D * 0.94, sh).T;
    }
    decal(v, top!, 0.08, 0.12, 0.2, 0.88, on(k) ? lit(k) : ink(k, 0.45));
  },
  table(k) {
    const { v, c, T, H } = k, a = axis(k), n = clamp(Math.round(a.L / a.S), 1, 4), cell = a.L / n, r = Math.min(cell, a.S) * 0.42, h = H * 0.95;
    lot(k);
    for (let i = 0; i < n; i++) {
      const [x, y] = a.R(cell * (i + 0.5), a.S / 2, 0, 0);
      cyl(v, x, y, k.Z, r, h, c, { dl: on(k) ? (T.dark ? 8 : -5) : 0 });
      for (const f of [0.34, 0.67]) band(v, x, y, k.Z + h * f, r, ink(k, 0.45), Math.max(1, v.s * k.u * 0.12));
      disc(v, x, y, k.Z + h, r * 0.55, on(k) ? lit(k, 0.85) : css(c, 1, T.dark ? -7 : -9));
    }
  },
  page(k) {
    // A billboard showing a browser window, its address bar first, behind a start line: where a visit begins.
    const { v, c, T, H } = k, m = k.m, a = axis(k), alongX = k.w >= k.d;
    lot(k);
    const ground = frames(k.x, k.y, k.z, k.w, k.d, k.u * 0.3).T;
    const flat = (a0: number, b0: number, a1: number, b1: number, fill: string) => alongX ? decal(v, ground, a0, b0, a1, b1, fill) : decal(v, ground, b0, a0, b1, a1, fill);
    // The start line: a checkered strip across the front of the plot.
    const cells = clamp(Math.round(a.L / (m * 0.085)), 6, 16);
    for (let i = 0; i < cells; i++) for (let j = 0; j < 2; j++) flat(0.06 + 0.88 * i / cells, 0.74 + j * 0.07, 0.06 + 0.88 * (i + 1) / cells, 0.81 + j * 0.07, (i + j) % 2 ? css(T.face, 1, T.dark ? -6 : 0, 0.92) : ink(k, 0.85));
    // Posts, then the board: thin across the plot, so its broad face is the one turned to the viewer.
    const t = a.S * 0.1, b0 = a.S * 0.24, bz = k.Z + H * 0.18, bh = H * 0.8, post = m * 0.06;
    for (const at of [0.18, 0.82]) boxR(v, a.R(a.L * at - post / 2, b0 + t / 2 - post / 2, post, post), k.Z, bz - k.Z, c, { dl: T.dark ? -6 : -12 });
    const [bx, by, bw, bd] = a.R(0, b0, a.L, t);
    box(v, bx, by, bz, bw, bd, bh, c);
    const f = frames(bx, by, bz, bw, bd, bh), F = alongX ? f.L : f.R;
    // The right face runs from right to left on screen: flip it so the window reads the same way on either.
    const at = (u: number) => alongX ? u : 1 - u;
    const pane = (a0: number, b0: number, a1: number, b1: number, fill: string) => decal(v, F, Math.min(at(a0), at(a1)), b0, Math.max(at(a0), at(a1)), b1, fill);
    const page = css(T.face, 1, T.dark ? -8 : 0), bar = css(c, 0.82, T.dark ? -4 : -10);
    pane(0.04, 0.06, 0.96, 0.8, page);
    pane(0.04, 0.8, 0.96, 0.95, bar);
    [2, 42, 142].forEach((hue, i) => decalCircle(v, F, at(0.075 + i * 0.045), 0.875, Math.min(bw + bd, bh) * 0.022, css(paint(T, hue))));
    pane(0.22, 0.835, 0.93, 0.915, css(T.face, 1, T.dark ? -2 : 0));
    // The address: a slash, and a loading bar that runs while a flow passes.
    decalPoly(v, F, [[at(0.245), 0.85], [at(0.26), 0.85], [at(0.28), 0.9], [at(0.265), 0.9]], ink(k, 0.8));
    for (const [x0, x1] of [[0.3, 0.46], [0.48, 0.58]] as const) pane(x0, 0.866, x1, 0.884, ink(k, 0.35));
    if (on(k)) pane(0.22, 0.835, 0.22 + 0.71 * ((k.t * 0.6) % 1), 0.85, lit(k));
    pane(0.08, 0.46, 0.56, 0.74, on(k) ? lit(k, 0.75) : css(paint(T, 205), 1, T.dark ? -6 : 12));
    for (const [y, x1] of [[0.66, 0.92], [0.58, 0.84], [0.5, 0.88]] as const) pane(0.62, y, x1, y + 0.04, ink(k, 0.4));
    for (const x0 of [0.08, 0.38, 0.68]) pane(x0, 0.12, x0 + 0.24, 0.38, glassL(k, 0.7));
    if (on(k) && Math.floor(k.t * 1.5) % 2 === 0) decalPoly(v, F, [[at(0.44), 0.62], [at(0.44), 0.44], [at(0.48), 0.5], [at(0.53), 0.47]], ink(k, 0.95));
  },
  layout(k) {
    const { v, c, T, H } = k, p = k.m * 0.08, fh = H * 0.06, zt = k.Z + fh, ph = H * 0.82, o = { dl: T.dark ? 8 : -2 };
    lot(k);
    box(v, k.X, k.Y, k.Z, k.W, k.D, fh, c, { dl: T.dark ? 3 : -3 });
    face(v, [[k.X, k.Y, zt], [k.X + k.W, k.Y, zt], [k.X + k.W, k.Y, zt + ph], [k.X, k.Y, zt + ph]], [0, 1, 0], glassL(k, on(k) ? 0.6 : 0.35), { both: true });
    face(v, [[k.X, k.Y, zt], [k.X, k.Y + k.D, zt], [k.X, k.Y + k.D, zt + ph], [k.X, k.Y, zt + ph]], [1, 0, 0], glassR(k, 0.25), { both: true });
    box(v, k.X, k.Y, zt, p, p, ph, c, o);
    box(v, k.X, k.Y, zt + ph, k.W, p, p, c, o); box(v, k.X, k.Y, zt + ph, p, k.D, p, c, o);
    box(v, k.X + p, k.Y + p, zt + ph * 0.74, k.W - p, k.D * 0.3, ph * 0.06, c, { dl: on(k) ? (T.dark ? 14 : -8) : 0 });
    box(v, k.X + k.W - p, k.Y, zt, p, p, ph, c, o); box(v, k.X, k.Y + k.D - p, zt, p, p, ph, c, o);
    box(v, k.X + k.W - p, k.Y + k.D - p, zt, p, p, ph, c, o);
    box(v, k.X, k.Y + k.D - p, zt + ph, k.W, p, p, c, o); box(v, k.X + k.W - p, k.Y, zt + ph, p, k.D, p, c, o);
  },
  component(k) {
    const { v, c, T, H } = k, i0 = Math.min(k.w, k.d) * 0.05, X = k.x + i0, Y = k.y + i0, W = k.w - i0 * 2, D = k.d - i0 * 2, m = Math.min(W, D), bh = H * 0.78;
    box(v, X, Y, k.z, W, D, bh, c, { dl: on(k) ? (T.dark ? 8 : -5) : 0 });
    const nx = clamp(Math.round(W / (m * 0.45)), 1, 4), ny = clamp(Math.round(D / (m * 0.45)), 1, 4), r = Math.min(W / nx, D / ny) * 0.27, sh = Math.min(H * 0.22, Math.max(H * 0.14, r * 0.55));
    for (let s = 0; s <= nx + ny - 2; s++) for (let i = 0; i < nx; i++) {
      const j = s - i; if (j < 0 || j >= ny) continue;
      cyl(v, X + W * (i + 0.5) / nx, Y + D * (j + 0.5) / ny, k.z + bh, r, sh, c, { dl: T.dark ? 4 : -2 });
    }
  },
  hook(k) {
    const { v, c, T, H } = k, cw = H * 0.22, ms = k.m * 0.1, mx = k.X + k.W * 0.12, my = k.Y + k.D * 0.12;
    lot(k);
    box(v, k.X, k.Y, k.Z, k.W * 0.36, k.D * 0.36, cw, c, { dl: T.dark ? -6 : -12 });
    box(v, mx, my, k.Z + cw, ms, ms, H * 0.96 - cw, c);
    const jz = k.Z + H * 0.88, js = ms * 0.7, jy = my + ms * 0.15;
    box(v, k.X - k.W * 0.02, jy, jz, k.W * 0.98, js, js, c, { dl: T.dark ? 6 : 0 });
    const hx = k.X + k.W * 0.82, hz = k.Z + H * 0.34 + (on(k) ? Math.sin(k.t * 1.4) * H * 0.06 : 0) + k.hot * H * 0.14, hs = k.m * 0.13;
    line3(v, [hx + hs / 2, jy + js / 2, jz], [hx + hs / 2, jy + js / 2, hz + hs], ink(k, 0.85), Math.max(1, v.s * k.u * 0.07));
    box(v, hx, jy + js / 2 - hs / 2, hz, hs, hs, hs, on(k) ? T.accent : T.ink, { dl: T.dark && !on(k) ? 14 : 0 });
  },
  style(k) {
    // A painter's palette lying flat: dabs of paint round its rim, a thumb hole by the notch, a stroke of mixed paint and the brush that made it.
    const { v, c, T, H } = k, m = k.m, cx = k.X + k.W / 2, cy = k.Y + k.D / 2, rx = k.W * 0.47, ry = k.D * 0.45, th = H * 0.16, zt = k.Z + th;
    lot(k);
    // The outline: an oval with a notch for the thumb on the front-left (+y), slightly uneven like a cut board.
    const notch = Math.PI / 2 + 0.25, n = 44, outline: [number, number][] = [];
    for (let i = 0; i < n; i++) {
      const q = (i / n) * Math.PI * 2, dq = Math.atan2(Math.sin(q - notch), Math.cos(q - notch));
      const R = 1 - 0.3 * Math.exp(-((dq / 0.32) ** 2)) + 0.03 * Math.sin(3 * q + k.seed);
      outline.push([cx + rx * R * Math.cos(q), cy + ry * R * Math.sin(q)]);
    }
    for (let i = 0; i < n; i++) {
      const [x0, y0] = outline[i]!, [x1, y1] = outline[(i + 1) % n]!;
      face(v, [[x0, y0, k.Z], [x1, y1, k.Z], [x1, y1, zt], [x0, y0, zt]], [y1 - y0, x0 - x1, 0], c, { dl: T.dark ? 4 : -6, bare: true });
    }
    path(v, outline.map(([x, y]) => [x, y, zt] as V3));
    v.ctx.fillStyle = css(c, 1, T.dark ? 8 : 4); v.ctx.fill();
    if (v.s * m > 60) { v.ctx.strokeStyle = T.outline; v.ctx.lineWidth = 0.75; v.ctx.stroke(); }
    const spot = (q: number, R: number): [number, number] => [cx + rx * R * Math.cos(q), cy + ry * R * Math.sin(q)];
    const ring = (x: number, y: number, rr: number, z: number): V3[] => [...Array(20)].map((_, i) => [x + Math.cos(i / 20 * Math.PI * 2) * rr, y + Math.sin(i / 20 * Math.PI * 2) * rr, z]);
    const [hx, hy] = spot(notch + 0.62, 0.56);
    path(v, ring(hx, hy, m * 0.075, zt)); v.ctx.fillStyle = css(c, 1, T.dark ? -12 : -14); v.ctx.fill();
    // A stroke of mixed paint across the middle; while a flow passes it is painted again, the brush following its tip.
    const reach = on(k) ? 0.1 + 0.9 * ((k.t * 0.45) % 1) : 1;
    const stroke = (f: number): V3 => [cx - rx * 0.42 + rx * 0.7 * f, cy + ry * 0.2 - ry * 0.62 * f + Math.sin(f * Math.PI * 1.8) * ry * 0.1, zt];
    const mix = css(on(k) ? T.accent : paint(T, [300, 205, 145, 25][k.seed % 4]!), 1, 0, 0.9);
    v.ctx.beginPath(); for (let i = 0; i <= 24; i++) { const p = P(v, ...stroke(reach * i / 24)); if (i) v.ctx.lineTo(p[0], p[1]); else v.ctx.moveTo(p[0], p[1]); }
    v.ctx.strokeStyle = mix; v.ctx.lineWidth = Math.max(1.5, m * 0.075 * v.s); v.ctx.lineCap = 'round'; v.ctx.lineJoin = 'round'; v.ctx.stroke();
    // Dabs round the rim, away from the notch, drawn back to front.
    const hues = [2, 42, 142, 205, 270, 320], first = k.seed % hues.length, count = 4 + (k.seed >> 3) % 3;
    const dabs = [...Array(count)].map((_, i) => { const [x, y] = spot(notch + Math.PI + (i - (count - 1) / 2) * 0.48, 0.72); return { x, y, hue: hues[(first + i) % hues.length]! }; }).sort((p1, p2) => p1.x + p1.y - (p2.x + p2.y));
    for (const dab of dabs) ball(v, dab.x, dab.y, zt + m * 0.025, m * 0.062, paint(T, dab.hue));
    // The brush: its tip at the end of the stroke, its handle raised over the rim on the right.
    const tip = stroke(reach), lift = H * 0.86, hand: V3 = [tip[0] + m * 0.2, tip[1] - m * 0.3, zt + lift];
    const along = (f: number): V3 => [tip[0] + (hand[0] - tip[0]) * f, tip[1] + (hand[1] - tip[1]) * f, tip[2] + (hand[2] - tip[2]) * f];
    line3(v, along(0.3), hand, css({ h: 32, s: 38, l: T.dark ? 58 : 60 }), Math.max(1.2, m * 0.04 * v.s));
    line3(v, along(0.18), along(0.32), css(T.glass, 1, T.dark ? 18 : -10), Math.max(1.4, m * 0.05 * v.s));
    line3(v, [tip[0], tip[1], tip[2] + m * 0.01], along(0.19), mix, Math.max(1.6, m * 0.06 * v.s));
  },
  config(k) {
    const { v, c, T, H } = k, bh = H * 0.72;
    lot(k);
    box(v, k.X, k.Y, k.Z, k.W, k.D, bh, c);
    const f = frames(k.X, k.Y, k.Z, k.W, k.D, bh), n = clamp(Math.round(k.W / (k.m * 0.24)), 2, 5), ks = k.m * 0.12;
    for (const b of [0.3, 0.5, 0.7]) decal(v, f.L, 0.08, b, 0.92, b + 0.06, ink(k, 0.35));
    for (let i = 0; i < n; i++) decal(v, f.T, (i + 0.5) / n - 0.025, 0.12, (i + 0.5) / n + 0.025, 0.88, ink(k, 0.55));
    for (let i = 0; i < n; i++) {
      const p = 0.15 + 0.7 * ((hash(k.seed + i * 3) + (on(k) ? 0.1 * Math.sin(k.t * 3 + i) + 0.1 : 0)) % 1);
      box(v, k.X + k.W * (i + 0.5) / n - ks / 2, k.Y + k.D * (0.12 + p * 0.76) - ks / 2, k.Z + bh, ks, ks, H * 0.16, c, { dl: T.dark ? 14 : -10 });
    }
  },
  test(k) {
    // A lab bench: drawers below, a rack of test tubes with colored liquids along the back, a flask in front.
    const { v, c, T, H } = k, m = k.m, bh = H * 0.32, top = H * 0.04;
    lot(k);
    box(v, k.X, k.Y, k.Z, k.W, k.D, bh, c);
    const f = frames(k.X, k.Y, k.Z, k.W, k.D, bh);
    for (const [a0, a1] of [[0.08, 0.46], [0.54, 0.92]] as const) {
      decal(v, f.L, a0, 0.2, a1, 0.8, css(c, T.ws[0], T.dark ? -6 : -8));
      decal(v, f.L, (a0 + a1) / 2 - 0.05, 0.58, (a0 + a1) / 2 + 0.05, 0.66, ink(k, 0.6));
    }
    box(v, k.X - m * 0.02, k.Y - m * 0.02, k.Z + bh, k.W + m * 0.04, k.D + m * 0.04, top, c, { dl: T.dark ? 10 : -6 });
    const zt = k.Z + bh + top, n = clamp(Math.round(k.W / (m * 0.2)), 3, 5), rx = k.X + k.W * 0.08, rw = k.W * 0.56, ry = k.Y + k.D * 0.2, rd = m * 0.14, rh = H * 0.08;
    box(v, rx, ry, zt, rw, rd, rh, T.ink, { dl: T.dark ? 16 : 34 });
    for (let i = 0; i < n; i++) {
      const tx = rx + rw * (i + 0.5) / n, ty = ry + rd / 2, tr = Math.min(m * 0.055, rw / n * 0.34), th = H * 0.5, level = 0.35 + 0.35 * hash(k.seed + i);
      cyl(v, tx, ty, zt + rh, tr * 0.8, th * level, on(k) ? T.accent : paint(T, [150, 205, 320, 45, 270][i % 5]!));
      cyl(v, tx, ty, zt + rh, tr, th, T.glass, { a: 0.32, top: css(T.glass, 1, 12, 0.3) });
    }
    const fx = k.X + k.W * 0.78, fy = k.Y + k.D * 0.68, r0 = m * 0.16, r1 = m * 0.05, fh = H * 0.32, neck = H * 0.13, liquid = on(k) ? T.accent : paint(T, 150);
    cone(v, fx, fy, zt, r0, r0 + (r1 - r0) * 0.45, fh * 0.45, liquid);
    cone(v, fx, fy, zt, r0, r1, fh, T.glass, { a: 0.3, top: css(T.glass, 1, 12, 0.25) });
    cyl(v, fx, fy, zt + fh, r1, neck, T.glass, { a: 0.3, top: css(T.glass, 1, 12, 0.3) });
    if (on(k)) for (let i = 0; i < 3; i++) {
      const ph = (k.t * 0.6 + i / 3) % 1;
      ball(v, fx + Math.sin(ph * 6 + i) * r1 * 0.6, fy, zt + fh + neck + ph * H * 0.22, m * 0.022 * (1 - ph * 0.4), liquid, 0.9 * (1 - ph));
    }
  },
};

/**
 * One block as the map draws a file by default (building shapes off): a box in its color, its kind's icon on the roof,
 * warmed and glowing when `hot` (lit by a flow, an explanation or a change).
 */
export function drawBlock(v: ShapeView, kind: Archetype, input: ShapeInput): void {
  const { x, y, z, w, d, H, c, hot } = input;
  const color = hot > 0.02 ? mixHsl(c, v.T.accent, Math.min(0.8, hot * 0.7)) : c;
  box(v, x, y, z, w, d, H, color);
  drawIcon(v, kind, x, y, z + H, w, d, color, 1, 0.62);
  if (hot > 0.05) glow(v, x + w / 2, y + d / 2, z + H, Math.min(w, d) * 0.8, v.T.accent, 0.16 * hot);
}
/** Draw one block as its archetype's shape, within its footprint and height. */
export function drawShape(v: ShapeView, kind: Archetype, input: ShapeInput): void {
  const m0 = Math.min(input.w, input.d), i = m0 * 0.08, u = m0 / 8;
  DRAW[kind]({ ...input, v, T: v.T, X: input.x + i, Y: input.y + i, W: input.w - 2 * i, D: input.d - 2 * i, Z: input.z + u * 0.3, m: m0 - 2 * i, u });
}

type Op = ['r', number, number, number, number] | ['c' | 'h', number, number, number] | ['p', [number, number][]];
/** Roof icons for blocks too small for their shape: flat marks in the top face's own coordinates (0..1). */
const ICONS: Record<Archetype, Op[]> = {
  entry: [['c', .5, .5, .3], ['h', .5, .5, .15], ['c', .5, .5, .07]],
  routes: [['r', .15, .22, .85, .34], ['r', .22, .34, .34, .82], ['r', .66, .34, .78, .82]],
  middleware: [['r', .08, .44, .3, .58], ['r', .39, .44, .61, .58], ['r', .7, .44, .92, .58], ['r', .08, .3, .16, .72]],
  controller: [['r', .44, .02, .56, .98], ['r', .02, .44, .98, .56], ['c', .5, .5, .3], ['h', .5, .5, .22], ['r', .24, .44, .76, .56]],
  service: [['p', [[.15, .82], [.15, .45], [.38, .62], [.38, .45], [.61, .62], [.61, .45], [.85, .62], [.85, .82]]]],
  helper: [['r', .16, .16, .56, .56], ['r', .62, .62, .84, .84]],
  command: [['p', [[.18, .25], [.48, .45], [.18, .65], [.18, .54], [.33, .45], [.18, .36]]], ['r', .52, .6, .82, .7]],
  schedule: [['c', .5, .5, .32], ['h', .5, .5, .24], ['r', .47, .26, .53, .52], ['r', .47, .47, .7, .53]],
  job: [['r', .1, .4, .3, .6], ['r', .4, .4, .6, .6], ['r', .7, .4, .9, .6]],
  model: [['r', .18, .2, .82, .32], ['r', .18, .44, .82, .56], ['r', .18, .68, .82, .8]],
  table: [['c', .5, .5, .32], ['h', .5, .5, .2], ['c', .5, .5, .1]],
  page: [['r', .1, .12, .9, .3], ['r', .1, .3, .15, .88], ['r', .85, .3, .9, .88], ['r', .1, .83, .9, .88], ['r', .22, .4, .52, .64], ['r', .58, .42, .78, .48], ['r', .58, .54, .74, .6]],
  layout: [['r', .15, .15, .85, .27], ['r', .15, .15, .27, .85], ['r', .73, .15, .85, .85], ['r', .15, .73, .85, .85]],
  component: [['c', .3, .3, .13], ['c', .7, .3, .13], ['c', .3, .7, .13], ['c', .7, .7, .13]],
  hook: [['r', .55, .15, .65, .72], ['p', [[.3, .6], [.4, .6], [.4, .75], [.55, .75], [.55, .62], [.65, .62], [.65, .86], [.3, .86]]]],
  style: [['c', .5, .5, .4], ['h', .36, .66, .1], ['h', .32, .38, .08], ['h', .54, .26, .08], ['h', .72, .44, .08], ['h', .64, .66, .07]],
  config: [['r', .22, .15, .28, .85], ['r', .47, .15, .53, .85], ['r', .72, .15, .78, .85], ['r', .16, .55, .34, .67], ['r', .41, .25, .59, .37], ['r', .66, .62, .84, .74]],
  test: [['r', .26, .12, .42, .68], ['c', .34, .68, .08], ['r', .58, .22, .74, .7], ['c', .66, .7, .08]],
};
const ACCENT_ICONS = new Set<Archetype>(['entry', 'routes']);
/** The archetype's icon on a block's top face (x, y, w, d at elevation z), in a square of `share` of the shorter side at the given corner. */
export function drawIcon(v: ShapeView, kind: Archetype, x: number, y: number, z: number, w: number, d: number, c: Hsl, alpha = 1, share = 1, corner: 'center' | 'front-left' = 'center'): void {
  const side = Math.min(w, d) * share, ox = corner === 'center' ? x + (w - side) / 2 : x + Math.min(w, d) * 0.06, oy = corner === 'center' ? y + (d - side) / 2 : y + d - side - Math.min(w, d) * 0.06;
  const F: Face = { o: [ox, oy, z], u: [side, 0, 0], v: [0, side, 0] };
  const T = v.T, col = ACCENT_ICONS.has(kind) ? css(T.accent, 1, 0, 0.9 * alpha) : css(T.ink, 1, 0, (T.dark ? 0.7 : 0.55) * alpha), hole = css(c, 1);
  for (const op of ICONS[kind]) {
    if (op[0] === 'r') decal(v, F, op[1], op[2], op[3], op[4], col);
    else if (op[0] === 'p') decalPoly(v, F, op[1], col);
    else decalCircle(v, F, op[1], op[2], op[3] * side, op[0] === 'h' ? hole : col);
  }
}
export function hexToHsl(hex: string): Hsl | undefined {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return undefined;
  const full = m[1]!.length === 3 ? [...m[1]!].map(ch => ch + ch).join('') : m[1]!;
  const [r, g, b] = [0, 2, 4].map(i => parseInt(full.slice(i, i + 2), 16) / 255) as [number, number, number];
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, delta = max - min;
  if (!delta) return { h: 0, s: 0, l: l * 100 };
  const s = delta / (1 - Math.abs(2 * l - 1));
  const h = max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  return { h: Math.round(((h * 60) + 360) % 360), s: s * 100, l: l * 100 };
}
/** Mix of two colors in HSL, along the shorter way round the hue circle. */
export function mixHsl(a: Hsl, b: Hsl, t: number): Hsl {
  const dh = ((b.h - a.h + 540) % 360) - 180;
  return { h: (a.h + dh * t + 360) % 360, s: a.s + (b.s - a.s) * t, l: a.l + (b.l - a.l) * t };
}
