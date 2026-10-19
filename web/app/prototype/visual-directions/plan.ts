// PROTOTYPE (throwaway) — a small renderer whose projection runs from the
// map's isometric view (tilt 0) to a plan seen from straight above (tilt 1):
// it turns 45°, unsquashes and lowers the blocks. The app's renderer is
// isometric only; this draws plain blocks, frames, labels and rails.
import type { Rect } from '@engine/projection/dto';
import { toScreen, type Camera, type Viewport, type Bounds } from '../../../lib/camera';
import { PaletteCache, paletteKey } from '../../../lib/themes';
import { streetInset } from '../../../lib/scene';
import { railRoute, type RailWorld } from '../../../lib/rails';
import { FONT, nodeHeight, theme, type Frame, type N } from './kit';

export type Project = (x: number, y: number, z?: number) => { x: number; y: number };
const SX0 = Math.cos(Math.PI / 6) * Math.SQRT2, SY0 = 0.5 * Math.SQRT2;
export function projector(tilt: number): Project {
  const angle = (Math.PI / 4) * (1 - tilt), c = Math.cos(angle), s = Math.sin(angle);
  const sx = SX0 + (1 - SX0) * tilt, sy = SY0 + (1 - SY0) * tilt, hz = 1 - tilt;
  return (x, y, z = 0) => { const rx = c * x - s * y, ry = s * x + c * y; return { x: sx * rx, y: sy * ry - z * hz }; };
}
export function boundsOf(rects: Rect[], project: Project, top = 0): Bounds {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of rects) for (const [x, y] of [[r.x, r.y], [r.x + r.w, r.y], [r.x, r.y + r.h], [r.x + r.w, r.y + r.h]] as const) for (const z of [0, top]) {
    const p = project(x, y, z);
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY };
}

const palettes = new PaletteCache(theme);
export interface Drawn { node: N; rect: Rect; zBase: number; zTop: number; alpha: number; open: boolean; depth: number }
export interface DrawOptions {
  tilt: number;
  /** Containers opened whatever their size on screen. */
  force?: Set<string>;
  /** Per-node fill override (change colors, tints). */
  tint?: (node: N) => string | undefined;
  /** Per-node height factor (grow from / sink into the ground). */
  grow?: (node: N) => number;
  /** Per-node outline (glow) color. */
  ring?: (node: N) => { color: string; width: number; dash?: number[] } | undefined;
  labels?: boolean;
  /** A glyph prefix for labels (+ ~ −). */
  glyph?: (node: N) => string;
  /** Screen offset (the lifted layer). */
  offset?: { x: number; y: number };
  dimOthers?: Set<string>;
  /** Which closed blocks get a name (default: all that fit). Open areas are always named. */
  labelFor?: (node: N) => boolean;
  /** Collects the screen boxes of the labels drawn (for arrow labels to keep off). */
  collect?: Box[];
}
export interface Box { x0: number; y0: number; x1: number; y1: number }

/** Draw a frame; returns what was drawn (with heights) for arrows, labels and characters. */
export function drawFrame(ctx: CanvasRenderingContext2D, viewport: Viewport, camera: Camera, frame: Frame, options: DrawOptions): Map<string, Drawn> {
  const project = projector(options.tilt);
  const off = options.offset ?? { x: 0, y: 0 };
  const screen = (x: number, y: number, z = 0) => { const p = toScreen(camera, viewport, project(x, y, z)); return { x: p.x + off.x, y: p.y + off.y }; };
  const kids = new Map<string, N[]>();
  const byId = new Map(frame.nodes.map(node => [node.id, node]));
  let root: N | undefined;
  for (const node of frame.nodes) {
    if (!node.spatialParentId || !byId.has(node.spatialParentId)) { root ??= node; continue; }
    const list = kids.get(node.spatialParentId) ?? []; list.push(node); kids.set(node.spatialParentId, list);
  }
  const drawn = new Map<string, Drawn>();
  if (!root) return drawn;
  const order: Drawn[] = [];
  const visit = (node: N, zBase: number, alpha: number, depth: number) => {
    const inset = streetInset(node);
    const rect = { x: node.rect.x + inset, y: node.rect.y + inset, w: Math.max(1, node.rect.w - inset * 2), h: Math.max(1, node.rect.h - inset * 2) };
    const a = alpha * (frame.alpha.get(node.id) ?? 1);
    const list = kids.get(node.id);
    const size = Math.sqrt(rect.w * rect.h) * camera.scale;
    const open = !!list?.length && (!!options.force?.has(node.id) || size >= 210);
    const height = nodeHeight(node) * (options.grow?.(node) ?? 1);
    const item: Drawn = { node, rect, zBase, zTop: zBase + height, alpha: a, open, depth };
    drawn.set(node.id, item); order.push(item);
    if (open && a > 0.01) for (const child of [...list!].sort((p, q) => (p.rect.x + p.rect.y) - (q.rect.x + q.rect.y))) visit(child, zBase + height, a, depth + 1);
  };
  visit(root, 0, 1, 0);
  const tilt = options.tilt;
  for (const item of order) {
    if (item.alpha <= 0.01) continue;
    const { rect, node } = item;
    const key = node.id.startsWith('tile:') ? 'directory' : paletteKey(node);
    const palette = palettes.get(key, item.depth);
    const tint = options.tint?.(node);
    // Areas stay readable as nested frames; other blocks recede.
    const dim = options.dimOthers && !options.dimOthers.has(node.id) ? (item.open ? 0.6 : 0.28) : 1;
    ctx.save();
    ctx.globalAlpha = item.alpha * dim * (node.id.startsWith('tile:') ? 0.75 : 1);
    const c = (x: number, y: number, z: number) => screen(x, y, z);
    const t = item.zTop, b = item.zBase;
    if (tilt < 0.999) {
      // Walls facing the viewer: +y (left on screen) and +x (right).
      poly(ctx, [c(rect.x, rect.y + rect.h, t), c(rect.x + rect.w, rect.y + rect.h, t), c(rect.x + rect.w, rect.y + rect.h, b), c(rect.x, rect.y + rect.h, b)], tint ? shade(tint, 0.72) : palette.left);
      poly(ctx, [c(rect.x + rect.w, rect.y, t), c(rect.x + rect.w, rect.y + rect.h, t), c(rect.x + rect.w, rect.y + rect.h, b), c(rect.x + rect.w, rect.y, b)], tint ? shade(tint, 0.55) : palette.right);
    }
    const top = [c(rect.x, rect.y, t), c(rect.x + rect.w, rect.y, t), c(rect.x + rect.w, rect.y + rect.h, t), c(rect.x, rect.y + rect.h, t)];
    poly(ctx, top, tint ?? palette.top, item.open ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.35)');
    if (node.id.startsWith('tile:')) { ctx.setLineDash([4, 3]); ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 1; ctx.beginPath(); top.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.closePath(); ctx.stroke(); ctx.setLineDash([]); }
    const ring = options.ring?.(node);
    if (ring) { ctx.strokeStyle = ring.color; ctx.lineWidth = ring.width; ctx.setLineDash(ring.dash ?? []); ctx.shadowColor = ring.color; ctx.shadowBlur = 10; ctx.beginPath(); top.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.closePath(); ctx.stroke(); }
    ctx.restore();
  }
  if (options.labels !== false) labels(ctx, order, screen, camera, tilt, options);
  return drawn;
}

function labels(ctx: CanvasRenderingContext2D, order: Drawn[], screen: (x: number, y: number, z?: number) => { x: number; y: number }, camera: Camera, tilt: number, options: DrawOptions) {
  const boxes: Box[] = options.collect ?? [];
  const free = (x0: number, y0: number, x1: number, y1: number) => !boxes.some(b => x0 < b.x1 && x1 > b.x0 && y0 < b.y1 && y1 > b.y0);
  ctx.save();
  ctx.textBaseline = 'middle';
  // Leaves first (what the reader came for), then the areas.
  const sorted = [...order].filter(item => item.alpha > 0.15).sort((a, b) => Number(a.open) - Number(b.open) || b.rect.w * b.rect.h - a.rect.w * a.rect.h);
  for (const item of sorted) {
    const { rect, node } = item;
    const side = Math.min(rect.w, rect.h) * camera.scale;
    const glyph = options.glyph?.(node) ?? '';
    const dim = options.dimOthers && !options.dimOthers.has(node.id);
    if (item.open) {
      const at = tilt > 0.5 ? screen(rect.x + 6 / camera.scale, rect.y + 2 / camera.scale, item.zTop) : screen(rect.x, rect.y, item.zTop);
      ctx.font = `800 ${tilt > 0.5 ? 11 : 10.5}px ${FONT}`;
      const text = `${node.name}${node.type === 'repository' || node.type === 'application' || node.kind === 'group' ? '' : '/'}`;
      const w = ctx.measureText(text).width;
      const x0 = tilt > 0.5 ? at.x : at.x - w / 2, y = tilt > 0.5 ? at.y + 9 : at.y - 8;
      if (!free(x0, y - 7, x0 + w, y + 7)) continue;
      boxes.push({ x0, y0: y - 7, x1: x0 + w, y1: y + 7 });
      ctx.globalAlpha = item.alpha * (dim ? 0.4 : 0.9); ctx.fillStyle = theme.text.district; ctx.textAlign = 'left';
      ctx.fillText(text, x0, y);
      continue;
    }
    if (side < 26) continue;
    if (options.labelFor && !options.labelFor(node)) continue;
    const center = screen(rect.x + rect.w / 2, rect.y + rect.h / 2, item.zTop);
    const tile = node.id.startsWith('tile:');
    // Shrink a name to its block (down to 8.5 px); the kind line only when there is room for it.
    const room = (tilt > 0.5 ? rect.w : Math.max(rect.w, rect.h) * 1.2) * camera.scale - 6;
    let size = tile ? 10.5 : Math.min(13, 9 + side / 30);
    const text = `${glyph}${node.name}`;
    ctx.font = `${tile ? 700 : 800} ${size}px ${FONT}`;
    let w = ctx.measureText(text).width;
    if (w > room && !tile) { size = Math.max(8.5, size * room / w); ctx.font = `800 ${size}px ${FONT}`; w = ctx.measureText(text).width; }
    const kind = tile ? node.detail : node.archetype?.kind ?? (node.type === 'file' ? undefined : node.type);
    const sub = kind && side > size * 3.4 ? kind : undefined;
    const h = sub ? size * 2.2 : size * 1.3;
    if (!free(center.x - w / 2 - 3, center.y - h / 2, center.x + w / 2 + 3, center.y + h / 2)) continue;
    boxes.push({ x0: center.x - w / 2 - 3, y0: center.y - h / 2, x1: center.x + w / 2 + 3, y1: center.y + h / 2 });
    ctx.globalAlpha = item.alpha * (dim ? 0.35 : 1); ctx.textAlign = 'center';
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(8,10,18,0.75)'; ctx.fillStyle = tile ? theme.text.secondary : theme.text.primary;
    const y = sub ? center.y - size * 0.45 : center.y;
    ctx.strokeText(text, center.x, y); ctx.fillText(text, center.x, y);
    if (sub) { ctx.font = `600 ${size * 0.78}px ${FONT}`; ctx.fillStyle = theme.text.secondary; ctx.strokeText(sub, center.x, y + size * 1.05); ctx.fillText(sub, center.x, y + size * 1.05); }
  }
  ctx.restore();
}

function poly(ctx: CanvasRenderingContext2D, points: { x: number; y: number }[], fill: string, stroke?: string) {
  ctx.beginPath(); points.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.closePath();
  ctx.fillStyle = fill; ctx.fill();
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.stroke(); }
}
function shade(color: string, k: number): string {
  const match = /hsl\(([\d.]+)[ ,]+([\d.]+)%[ ,]+([\d.]+)%\)/.exec(color);
  if (match) return `hsl(${match[1]} ${match[2]}% ${(Number(match[3]) * k).toFixed(1)}%)`;
  return color;
}

// Arrows ---------------------------------------------------------------------------------

export interface Arrow { from: string; to: string; label?: string; directed?: boolean; color?: string; dash?: number[]; chip?: string; width?: number; type?: string }
export interface RoutedArrow extends Arrow { points: { x: number; y: number; z: number }[]; routed: boolean }
/** Route arrows along the streets of what was drawn (the app's rail router), straight when it finds no way. */
export function routeArrows(drawn: Map<string, Drawn>, arrows: Arrow[]): RoutedArrow[] {
  const kids = new Map<string, string[]>();
  for (const item of drawn.values()) { const parent = item.node.spatialParentId; if (parent && drawn.has(parent)) { const list = kids.get(parent) ?? []; list.push(item.node.id); kids.set(parent, list); } }
  const world: RailWorld = {
    rect: id => drawn.get(id)?.rect,
    parent: id => { const parent = drawn.get(id)?.node.spatialParentId; return parent && drawn.has(parent) ? parent : undefined; },
    children: id => kids.get(id) ?? [],
    top: id => drawn.get(id)?.zTop ?? 0,
  };
  return arrows.flatMap((arrow): RoutedArrow[] => {
    const a = drawn.get(arrow.from), b = drawn.get(arrow.to);
    if (!a || !b) return [];
    let rail;
    try { rail = railRoute(world, arrow.from, arrow.to); } catch { rail = undefined; }
    if (rail?.points.length) return [{ ...arrow, points: rail.points, routed: true }];
    const ca = { x: a.rect.x + a.rect.w / 2, y: a.rect.y + a.rect.h / 2, z: a.zTop }, cb = { x: b.rect.x + b.rect.w / 2, y: b.rect.y + b.rect.h / 2, z: b.zTop };
    return [{ ...arrow, points: [ca, cb], routed: false }];
  });
}
/**
 * Where arrow labels go. `line`: in the middle of the longest run, nudged apart
 * (the first prototype). `placed`: the cheapest of several spots along the
 * route (on the line, or beside it), scored against names, blocks, arrow ends,
 * other arrows and labels already placed; a label with no good spot becomes a
 * numbered badge with the text in a legend. `numbered`: badges only.
 */
export type LabelMode = 'line' | 'placed' | 'numbered';
export interface ArrowLabelOptions {
  mode?: LabelMode;
  /** Hard obstacles: names drawn, panels. */
  avoid?: Box[];
  /** Soft obstacles: blocks (labels may sit on them, streets are better). */
  blocks?: Box[];
  /** Top-left corner of the legend (numbered labels), screen px. */
  legend?: { x: number; y: number };
}
interface P { x: number; y: number }
interface Pending { points: P[]; lengths: number[]; text: string; color: string; total: number }

/** Draw routed arrows (progress 0..1 draws them in), then their labels. Returns the label boxes. */
export function drawArrows(ctx: CanvasRenderingContext2D, viewport: Viewport, camera: Camera, tilt: number, arrows: RoutedArrow[], progress = 1, offset = { x: 0, y: 0 }, time = 0, labelOptions: ArrowLabelOptions = {}): Box[] {
  const project = projector(tilt);
  const pending: Pending[] = [];
  for (const arrow of arrows) {
    const points = arrow.points.map(p => { const s = toScreen(camera, viewport, project(p.x, p.y, p.z)); return { x: s.x + offset.x, y: s.y + offset.y }; });
    const lengths = [0];
    for (let i = 1; i < points.length; i++) lengths.push(lengths[i - 1]! + Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y));
    const total = lengths.at(-1)!;
    if (total < 2) continue;
    const upto = total * progress;
    const color = arrow.color ?? theme.flow.step;
    const text = arrow.chip ? (arrow.label ? `${arrow.label} · ${arrow.chip}` : arrow.chip) : arrow.label ?? '';
    if (text && progress > 0.9) pending.push({ points, lengths, text, color, total });
    if (arrow.width === 0) continue; // labels only (another renderer draws the line)
    ctx.save();
    ctx.strokeStyle = color; ctx.lineWidth = arrow.width ?? 2.2; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.setLineDash(arrow.dash ?? (arrow.routed ? [] : [5, 4]));
    ctx.shadowColor = color; ctx.shadowBlur = 6;
    ctx.beginPath(); ctx.moveTo(points[0]!.x, points[0]!.y);
    let end = points[0]!, angle = 0;
    for (let i = 1; i < points.length; i++) {
      if (lengths[i]! <= upto) { ctx.lineTo(points[i]!.x, points[i]!.y); end = points[i]!; angle = Math.atan2(points[i]!.y - points[i - 1]!.y, points[i]!.x - points[i - 1]!.x); continue; }
      const k = (upto - lengths[i - 1]!) / (lengths[i]! - lengths[i - 1]!);
      end = { x: points[i - 1]!.x + (points[i]!.x - points[i - 1]!.x) * k, y: points[i - 1]!.y + (points[i]!.y - points[i - 1]!.y) * k };
      angle = Math.atan2(points[i]!.y - points[i - 1]!.y, points[i]!.x - points[i - 1]!.x);
      ctx.lineTo(end.x, end.y); break;
    }
    ctx.stroke(); ctx.setLineDash([]); ctx.shadowBlur = 0;
    if (arrow.directed !== false && progress > 0.98) {
      const size = 9;
      ctx.fillStyle = color; ctx.beginPath(); ctx.moveTo(end.x, end.y);
      ctx.lineTo(end.x - size * Math.cos(angle - 0.42), end.y - size * Math.sin(angle - 0.42)); ctx.lineTo(end.x - size * Math.cos(angle + 0.42), end.y - size * Math.sin(angle + 0.42)); ctx.closePath(); ctx.fill();
    }
    // A pulse travels along it (direction carried by motion, not by layout).
    if (progress >= 1) {
      const at = ((time / 1600) % 1) * total;
      const i = Math.max(1, lengths.findIndex(l => l >= at));
      const k = (at - lengths[i - 1]!) / Math.max(1e-6, lengths[i]! - lengths[i - 1]!);
      const p = { x: points[i - 1]!.x + (points[i]!.x - points[i - 1]!.x) * k, y: points[i - 1]!.y + (points[i]!.y - points[i - 1]!.y) * k };
      ctx.fillStyle = '#fff6dc'; ctx.shadowColor = color; ctx.shadowBlur = 10; ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }
  return (labelOptions.mode ?? 'placed') === 'line' ? lineLabels(ctx, pending) : placedLabels(ctx, viewport, pending, labelOptions);
}

/** The first prototype: the middle of the longest run, pushed apart vertically when two collide. */
function lineLabels(ctx: CanvasRenderingContext2D, pending: Pending[]): Box[] {
  const placed: Box[] = [];
  ctx.save(); ctx.font = `700 10.5px ${FONT}`; ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
  for (const label of pending) {
    let best = 1, run = 0;
    for (let i = 1; i < label.points.length; i++) { const l = label.lengths[i]! - label.lengths[i - 1]!; if (l > run) { run = l; best = i; } }
    const a = label.points[best - 1]!, b = label.points[best]!, x = (a.x + b.x) / 2;
    const w = ctx.measureText(label.text).width + 12, h = 18;
    let y = (a.y + b.y) / 2;
    for (let tries = 0; tries < 8 && placed.some(p => x - w / 2 < p.x1 && x + w / 2 > p.x0 && y - h / 2 < p.y1 && y + h / 2 > p.y0); tries++) y += (tries % 2 ? -1 : 1) * h * Math.ceil((tries + 1) / 2);
    placed.push({ x0: x - w / 2, y0: y - h / 2, x1: x + w / 2, y1: y + h / 2 });
    labelPill(ctx, label.text, x, y, w, h, label.color);
  }
  ctx.restore();
  return placed;
}

function overlap(a: Box, b: Box): number { return Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0)); }
function labelPill(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, w: number, h: number, color: string) {
  ctx.fillStyle = 'rgba(9,11,20,0.92)'; ctx.strokeStyle = color; ctx.lineWidth = 1.2;
  ctx.beginPath(); ctx.roundRect(x - w / 2, y - h / 2, w, h, h / 2); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#f4f1ea'; ctx.fillText(text, x, y + 0.5);
}

/** Scored placement along each route, numbered badges as the fallback. */
function placedLabels(ctx: CanvasRenderingContext2D, viewport: Viewport, pending: Pending[], options: ArrowLabelOptions): Box[] {
  const numbered = options.mode === 'numbered';
  const weighted: { box: Box; weight: number; owner?: number }[] = [
    ...(options.avoid ?? []).map(box => ({ box, weight: 5 })),
    ...(options.blocks ?? []).map(box => ({ box, weight: 0.7 })),
  ];
  // Arrow ends (the arrowhead and where it leaves) and every run of every arrow, as thin boxes.
  pending.forEach((label, owner) => {
    for (const p of [label.points[0]!, label.points.at(-1)!]) weighted.push({ box: { x0: p.x - 9, y0: p.y - 9, x1: p.x + 9, y1: p.y + 9 }, weight: 4 });
    for (let i = 1; i < label.points.length; i++) {
      const a = label.points[i - 1]!, b = label.points[i]!;
      weighted.push({ box: { x0: Math.min(a.x, b.x) - 2, y0: Math.min(a.y, b.y) - 2, x1: Math.max(a.x, b.x) + 2, y1: Math.max(a.y, b.y) + 2 }, weight: 0.8, owner });
    }
  });
  const placed: Box[] = [];
  const legend: { n: number; text: string; color: string }[] = [];
  ctx.save(); ctx.font = `700 10.5px ${FONT}`; ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
  // Short routes first: they have the fewest spots.
  const order = pending.map((label, i) => i).sort((a, b) => pending[a]!.total - pending[b]!.total);
  for (const i of order) {
    const label = pending[i]!;
    const spot = (w: number, h: number) => {
      let best: { x: number; y: number; cost: number; onLine: boolean } | undefined;
      for (let s = 1; s < label.points.length; s++) {
        const a = label.points[s - 1]!, b = label.points[s]!, run = label.lengths[s]! - label.lengths[s - 1]!;
        if (run < 8) continue;
        const flat = Math.abs(b.x - a.x) >= Math.abs(b.y - a.y);
        for (const t of [0.5, 0.3, 0.7, 0.15, 0.85]) {
          const px = a.x + (b.x - a.x) * t, py = a.y + (b.y - a.y) * t;
          const along = Math.abs((label.lengths[s - 1]! + run * t) / label.total - 0.5);
          const shifts: [number, number, number][] = flat ? [[0, 0, 0], [0, -(h / 2 + 4), 0.06], [0, h / 2 + 4, 0.06]] : [[0, 0, 0], [-(w / 2 + 5), 0, 0.06], [w / 2 + 5, 0, 0.06]];
          for (const [dx, dy, shiftCost] of shifts) {
            const x = px + dx, y = py + dy;
            const box = { x0: x - w / 2, y0: y - h / 2, x1: x + w / 2, y1: y + h / 2 };
            const area = w * h;
            let cost = shiftCost + 0.2 * along;
            if (box.x0 < 4 || box.y0 < 4 || box.x1 > viewport.width - 4 || box.y1 > viewport.height - 4) cost += 3;
            for (const item of weighted) if (item.owner !== i) cost += item.weight * overlap(box, item.box) / area;
            for (const other of placed) cost += 10 * overlap(box, other) / area;
            if (!best || cost < best.cost) best = { x, y, cost, onLine: dx === 0 && dy === 0 };
          }
        }
      }
      return best;
    };
    const w = ctx.measureText(label.text).width + 12, h = 18;
    const full = numbered ? undefined : spot(w, h);
    if (full && full.cost < 0.75) {
      placed.push({ x0: full.x - w / 2, y0: full.y - h / 2, x1: full.x + w / 2, y1: full.y + h / 2 });
      labelPill(ctx, label.text, full.x, full.y, w, h, label.color);
      continue;
    }
    // No good spot (or numbers asked for): a badge on the line, the text in the legend.
    const n = legend.length + 1;
    const badge = spot(18, 18);
    if (!badge) continue;
    placed.push({ x0: badge.x - 9, y0: badge.y - 9, x1: badge.x + 9, y1: badge.y + 9 });
    ctx.fillStyle = label.color; ctx.beginPath(); ctx.arc(badge.x, badge.y, 9, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#0b0d16'; ctx.font = `900 10.5px ${FONT}`; ctx.fillText(String(n), badge.x, badge.y + 0.5); ctx.font = `700 10.5px ${FONT}`;
    legend.push({ n, text: label.text, color: label.color });
  }
  if (legend.length) {
    // The legend: bottom left, above the switcher.
    ctx.textAlign = 'left';
    const width = Math.max(...legend.map(item => ctx.measureText(item.text).width)) + 46, height = legend.length * 20 + 14;
    const at = options.legend ?? { x: 14, y: viewport.height - 84 - height };
    ctx.fillStyle = 'rgba(9,11,20,0.9)'; ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.roundRect(at.x, at.y, width, height, 10); ctx.fill(); ctx.stroke();
    legend.forEach((item, k) => {
      const y = at.y + 17 + k * 20;
      ctx.fillStyle = item.color; ctx.beginPath(); ctx.arc(at.x + 18, y, 8, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#0b0d16'; ctx.textAlign = 'center'; ctx.font = `900 10px ${FONT}`; ctx.fillText(String(item.n), at.x + 18, y + 0.5);
      ctx.fillStyle = '#ece8df'; ctx.textAlign = 'left'; ctx.font = `700 11px ${FONT}`; ctx.fillText(item.text, at.x + 33, y + 0.5);
    });
  }
  ctx.restore();
  return placed;
}

/** Screen boxes of the closed blocks drawn (soft obstacles for labels). */
export function blockBoxes(drawn: Map<string, Drawn>, camera: Camera, viewport: Viewport, tilt: number): Box[] {
  const project = projector(tilt);
  const out: Box[] = [];
  for (const item of drawn.values()) {
    if (item.open || item.alpha < 0.3 || item.node.id.startsWith('tile:')) continue;
    const r = item.rect;
    const pts = [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]].map(([x, y]) => toScreen(camera, viewport, project(x!, y!, item.zTop)));
    out.push({ x0: Math.min(...pts.map(p => p.x)), y0: Math.min(...pts.map(p => p.y)), x1: Math.max(...pts.map(p => p.x)), y1: Math.max(...pts.map(p => p.y)) });
  }
  return out;
}
