// The small repository the landing page's map demo draws: two applications, each file a block marked with its kind,
// as the map draws them by default (building shapes are a setting).
// Positions are in map units, laid out by hand like the map's folder layout, with streets between the lots.
import { DUSK, DUSK_FILE, DUSK_PLATE, drawBlock, ISO_X, ISO_Y, seedOf, shapeHeight, type Archetype, type Hsl, type ShapeView } from './shapes';

export interface Lot { id: string; kind: Archetype; name: string; path: string; x: number; y: number; w: number; d: number; loc: number }
export interface Plate { x: number; y: number; w: number; d: number; label: string }
export interface Rect { x: number; y: number; w: number; d: number }

export const PLATES: Plate[] = [{ x: 0, y: 0, w: 36, d: 33, label: 'api' }, { x: 38, y: 0, w: 24, d: 28, label: 'web' }];

const lot = (id: string, kind: Archetype, name: string, path: string, x: number, y: number, w: number, d: number, loc: number): Lot => ({ id, kind, name, path, x, y, w, d, loc });
export const LOTS: Lot[] = [
  lot('index', 'entry', 'index.php', 'public/index.php', 1, 1, 5, 6, 40),
  lot('routes', 'routes', 'api.php', 'routes/api.php', 7, 1, 8, 6, 260),
  lot('auth-mw', 'middleware', 'Authenticate', 'app/Http/Middleware/Authenticate.php', 16, 1, 6, 6, 60),
  lot('config', 'config', 'auth.php', 'config/auth.php', 23, 1, 5, 6, 120),
  lot('console', 'schedule', 'console.php', 'routes/console.php', 29, 1, 6, 6, 60),
  lot('auth-ctrl', 'controller', 'AuthController', 'app/Http/Controllers/AuthController.php', 1, 8, 11, 9, 420),
  lot('pw-ctrl', 'controller', 'PasswordController', 'app/Http/Controllers/PasswordController.php', 13, 8, 10, 9, 300),
  lot('auth-svc', 'service', 'AuthService', 'app/Services/AuthService.php', 24, 8, 11, 9, 380),
  lot('user', 'model', 'User', 'app/Models/User.php', 1, 18, 8, 7, 200),
  lot('reset-svc', 'service', 'ResetService', 'app/Services/ResetService.php', 10, 18, 10, 7, 240),
  lot('mail-job', 'job', 'SendResetLink', 'app/Jobs/SendResetLink.php', 21, 18, 7, 5, 90),
  lot('import', 'command', 'ImportOrders', 'app/Console/ImportOrders.php', 29, 18, 6, 7, 120),
  lot('users', 'table', 'users', 'table users', 1, 26, 8, 4, 70),
  lot('resets', 'table', 'password_resets', 'table password_resets', 10, 26, 8, 4, 40),
  lot('orders', 'table', 'orders', 'table orders', 19, 26, 7, 4, 60),
  lot('token', 'helper', 'TokenHelper', 'app/Support/TokenHelper.php', 27, 25, 8, 7, 140),
  lot('layout', 'layout', 'AppLayout', 'web/layouts/AppLayout.tsx', 39, 1, 11, 8, 80),
  lot('login', 'page', '/login', 'web/pages/login.tsx', 51, 1, 10, 8, 200),
  lot('reset', 'page', '/reset-password', 'web/pages/reset-password.tsx', 39, 10, 7, 8, 140),
  lot('login-form', 'component', 'LoginForm', 'web/components/LoginForm.tsx', 47, 10, 7, 8, 260),
  lot('reset-form', 'component', 'ResetForm', 'web/components/ResetForm.tsx', 55, 10, 6, 8, 90),
  lot('session', 'hook', 'useSession', 'web/hooks/useSession.ts', 39, 19, 8, 7, 90),
  lot('css', 'style', 'app.css', 'web/styles/app.css', 48, 19, 6, 5, 200),
  lot('test', 'test', 'login.test.ts', 'web/tests/login.test.ts', 55, 19, 6, 7, 260),
];
export const LOT = Object.fromEntries(LOTS.map(item => [item.id, item])) as Record<string, Lot>;
/** The controllers' folder, outlined when an agent searches it. */
export const CONTROLLERS: Rect = { x: 0.6, y: 7.6, w: 22.8, d: 9.8 };

/** Lots are drawn this far inside their place, so streets run between them as on the map. */
const STREET = 0.5;
export const PLATE_H = 0.9;
/** Blocks are lower than the buildings they replace (the map's shapes are off by default). */
export const lotHeight = (item: Lot) => shapeHeight(item.kind, Math.min(item.w, item.d) - STREET * 2, item.loc) * 0.55;
const ORDER = [...LOTS].sort((a, b) => (a.x + a.y + a.w / 2 + a.d / 2) - (b.x + b.y + b.w / 2 + b.d / 2));

export interface Projection { s: number; ox: number; oy: number }
/** Fit the district into a w × h canvas, leaving room above for the tallest shapes and the badges. */
export function fit(w: number, h: number, pad = 10): Projection {
  const minX = -33 * ISO_X, maxX = 62 * ISO_X, minY = -9, maxY = (62 + 28) * ISO_Y + 1;
  const s = Math.min((w - pad * 2) / (maxX - minX), (h - pad * 2) / (maxY - minY));
  return { s, ox: w / 2 - (minX + maxX) / 2 * s, oy: h / 2 - (minY + maxY) / 2 * s };
}
export const project = (p: Projection, x: number, y: number, z: number): [number, number] => [p.ox + (x - y) * ISO_X * p.s, p.oy + ((x + y) * ISO_Y - z) * p.s];
/** Where a lot's badge or label sits: above the middle of its roof. */
export const roof = (p: Projection, item: Lot, rise = 1): [number, number] => project(p, item.x + item.w / 2, item.y + item.d / 2, PLATE_H + lotHeight(item) * rise);
export const hsl = (c: Hsl, a = 1) => `hsla(${c.h} ${c.s}% ${c.l}% / ${a})`;

/** How the scene wants each lot drawn. `grow` scales the height (a file being added rises, a removed one sinks). */
export interface LotStyle { hidden?: boolean; color?: Hsl; hot?: number; grow?: number }

function plate(ctx: CanvasRenderingContext2D, p: Projection, r: Plate, rise: number) {
  const at = (x: number, y: number, z: number) => project(p, x, y, z * rise);
  const quad = (pts: [number, number][], fill: string) => { ctx.beginPath(); pts.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); ctx.closePath(); ctx.fillStyle = fill; ctx.fill(); };
  const tone = (f: number) => hsl({ ...DUSK_PLATE, l: DUSK_PLATE.l * f });
  quad([at(r.x, r.y + r.d, 0), at(r.x + r.w, r.y + r.d, 0), at(r.x + r.w, r.y + r.d, PLATE_H), at(r.x, r.y + r.d, PLATE_H)], tone(DUSK.ws[0]));
  quad([at(r.x + r.w, r.y, 0), at(r.x + r.w, r.y + r.d, 0), at(r.x + r.w, r.y + r.d, PLATE_H), at(r.x + r.w, r.y, PLATE_H)], tone(DUSK.ws[1]));
  quad([at(r.x, r.y, PLATE_H), at(r.x + r.w, r.y, PLATE_H), at(r.x + r.w, r.y + r.d, PLATE_H), at(r.x, r.y + r.d, PLATE_H)], tone(1));
  ctx.strokeStyle = DUSK.outline; ctx.lineWidth = 1; ctx.stroke();
}

/** The plates and every lot, back to front; `rise` scales every height (it sinks to the ground on the way to the plan). */
export function drawDistrict(ctx: CanvasRenderingContext2D, p: Projection, t: number, style: (item: Lot) => LotStyle, rise = 1) {
  for (const r of PLATES) plate(ctx, p, r, rise);
  const v: ShapeView = { ctx, s: p.s, ox: p.ox, oy: p.oy, T: DUSK };
  for (const item of ORDER) {
    const look = style(item);
    if (look.hidden) continue;
    const grow = look.grow ?? 1;
    if (grow <= 0.02) continue;
    drawBlock(v, item.kind, {
      x: item.x + STREET, y: item.y + STREET, z: PLATE_H * rise, w: item.w - STREET * 2, d: item.d - STREET * 2,
      H: lotHeight(item) * grow * rise, c: look.color ?? DUSK_FILE, t, hot: look.hot ?? 0, seed: seedOf(item.id),
    });
  }
  ctx.font = '500 10.5px "Geist Mono Variable", "Geist Mono", ui-monospace, monospace'; ctx.fillStyle = '#6b6b72';
  if (rise > 0.5) for (const r of PLATES) { const [lx, ly] = project(p, r.x, r.y + r.d, PLATE_H); ctx.fillText(r.label, lx + 6, ly + 15); }
}

/** The 2D plan: the district seen from above, as the map's plan projection draws it. */
export interface Plan { s: number; ox: number; oy: number }
export function planFit(w: number, h: number, pad = 28): Plan {
  const width = 62, depth = 33, s = Math.min((w - pad * 2) / width, (h - pad * 2) / depth);
  return { s, ox: (w - width * s) / 2, oy: (h - depth * s) / 2 };
}
/**
 * The canvas transform (as for `setTransform`) that lays the isometric ground (z = 0) onto the plan. Mixed with the
 * identity while the heights sink, it turns the 3D map into the 2D plan in place.
 */
export function isoToPlan(p: Projection, q: Plan): [number, number, number, number, number, number] {
  const det = 2 * p.s * p.s * ISO_X * ISO_Y, k = (q.s * p.s) / det;
  const a = k * ISO_Y, c = k * ISO_X, b = -k * ISO_Y, d = k * ISO_X;
  return [a, b, c, d, q.ox - (a * p.ox + c * p.oy), q.oy - (b * p.ox + d * p.oy)];
}
/** The district from above: plates, then each lot as a flat tile with its name where it fits (low on the `occupied` one, under the agent standing there). */
export function drawPlan(ctx: CanvasRenderingContext2D, q: Plan, alpha: number, names: number, occupied?: string) {
  ctx.save(); ctx.globalAlpha = alpha;
  for (const r of PLATES) {
    ctx.fillStyle = hsl(DUSK_PLATE); ctx.strokeStyle = DUSK.outline; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.roundRect(q.ox + r.x * q.s, q.oy + r.y * q.s, r.w * q.s, r.d * q.s, 4); ctx.fill(); ctx.stroke();
  }
  for (const item of LOTS) {
    const x = q.ox + (item.x + STREET) * q.s, y = q.oy + (item.y + STREET) * q.s, w = (item.w - STREET * 2) * q.s, d = (item.d - STREET * 2) * q.s;
    ctx.fillStyle = hsl({ ...DUSK_FILE, l: DUSK_FILE.l - 4 }); ctx.strokeStyle = 'rgba(245,245,243,0.2)';
    ctx.beginPath(); ctx.roundRect(x, y, w, d, 3); ctx.fill(); ctx.stroke();
  }
  ctx.font = '500 10.5px "Geist Mono Variable", "Geist Mono", ui-monospace, monospace'; ctx.fillStyle = '#6b6b72';
  for (const r of PLATES) ctx.fillText(r.label, q.ox + r.x * q.s + 6, q.oy + (r.y + r.d) * q.s + 15);
  ctx.restore();
  if (names <= 0) return;
  for (const item of LOTS) {
    const w = (item.w - STREET * 2) * q.s;
    if (w < item.name.length * 5.6) continue;
    const y = item.id === occupied ? (item.y + item.d - STREET) * q.s - 9 : (item.y + item.d / 2) * q.s;
    label(ctx, item.name, q.ox + (item.x + item.w / 2) * q.s, q.oy + y, names * alpha);
  }
}

/** A lot's footprint on its plate, as a closed path (for outlines). */
export function footprint(ctx: CanvasRenderingContext2D, p: Projection, r: Rect, inset = STREET * 0.6) {
  const pts = [project(p, r.x + inset, r.y + inset, PLATE_H), project(p, r.x + r.w - inset, r.y + inset, PLATE_H), project(p, r.x + r.w - inset, r.y + r.d - inset, PLATE_H), project(p, r.x + inset, r.y + r.d - inset, PLATE_H)];
  ctx.beginPath(); pts.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); ctx.closePath();
}

/** A file name on the map: bold, with a dark halo, as the map labels files. */
export function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, alpha = 1, color = '#f5f5f3') {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = '600 11px "Geist Variable", "Geist", ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(10,10,11,0.92)'; ctx.lineWidth = 3.5; ctx.strokeText(text, x, y);
  ctx.fillStyle = color; ctx.fillText(text, x, y);
  ctx.restore();
}

/** A rounded pill above a lot: an agent's action, in its color. */
export function pill(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string, alpha = 1) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = '600 10px "Geist Variable", "Geist", ui-sans-serif, system-ui, sans-serif';
  const width = ctx.measureText(text).width + 14;
  ctx.fillStyle = '#0a0a0b'; ctx.strokeStyle = color; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.roundRect(x - width / 2, y - 9, width, 18, 5); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#f5f5f3'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(text, x, y + 0.5);
  ctx.restore();
}

export { DUSK, DUSK_FILE };
