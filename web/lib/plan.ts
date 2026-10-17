// The map seen from straight above. The isometric view (tilt 0) turns 45°,
// unsquashes and lowers its blocks into a plan (tilt 1), so the switch can be
// animated and everything stays where the reader learned it. Areas are drawn
// as nested frames, files as flat blocks with their names; arrows run along
// the streets (the rail router), with their labels placed where they cover
// least. Used by the Focus tool, in the map's projection (the map itself is
// drawn by renderer.ts, in plan or isometric; its pills label the agents on it).
import type { NodeSummary, Rect } from '@engine/projection/dto';
import { fromScreen, toScreen, type Bounds, type Camera, type Point, type Viewport } from './camera';
import { placeLabels } from './labels';
import { railRoute, type RailWorld } from './rails';
import { nodeHeight, streetInset, type Scene } from './scene';
import { PaletteCache, paletteKey, type Theme } from './themes';

export type Project = (x: number, y: number, z?: number) => Point;
const SX0 = Math.cos(Math.PI / 6) * Math.SQRT2, SY0 = 0.5 * Math.SQRT2;
/** The projection from isometric (0) to plan (1); at 0 it equals `project` in camera.ts. */
export function projector(tilt: number): Project {
  const angle = (Math.PI / 4) * (1 - tilt), c = Math.cos(angle), s = Math.sin(angle);
  const sx = SX0 + (1 - SX0) * tilt, sy = SY0 + (1 - SY0) * tilt, hz = 1 - tilt;
  return (x, y, z = 0) => { const rx = c * x - s * y, ry = s * x + c * y; return { x: sx * rx, y: sy * ry - z * hz }; };
}
/** Projected bounds of rects from the ground to `top`. */
export function boundsOf(rects: Rect[], project: Project, top = 0): Bounds {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of rects) for (const [x, y] of [[r.x, r.y], [r.x + r.w, r.y], [r.x, r.y + r.h], [r.x + r.w, r.y + r.h]] as const) for (const z of [0, top]) {
    const p = project(x, y, z);
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY };
}

/** A screen-space box (labels, panels, blocks). */
export interface Box { x0: number; y0: number; x1: number; y1: number }
export function overlap(a: Box, b: Box): number { return Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0)); }

/** Colors for what the plan draws on top of the map (pills, callouts), from the theme. */
export interface Ink {
  font: string; dark: boolean;
  pill: string; pillText: string; pillBorder: string; halo: string;
  /** What a tool is about (its files, their callouts). */
  accent: string; accentText: string; accentSub: string; tint: string;
  legend: string; legendText: string;
}
export const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
export function inkFor(theme: Theme): Ink {
  const font = theme.style?.font ?? FONT;
  return theme.dark
    ? { font, dark: true, pill: 'rgba(9,11,20,0.92)', pillText: '#f4f1ea', pillBorder: 'rgba(255,255,255,0.25)', halo: 'rgba(8,10,18,0.78)', accent: '#ffd68c', accentText: '#fff7e6', accentSub: '#e6c58c', tint: 'hsl(36 52% 44%)', legend: 'rgba(9,11,20,0.9)', legendText: '#ece8df' }
    : { font, dark: false, pill: 'rgba(255,255,255,0.95)', pillText: '#1d1a26', pillBorder: 'rgba(20,24,40,0.25)', halo: 'rgba(255,255,255,0.85)', accent: '#b8730a', accentText: '#2f2210', accentSub: '#7a5a22', tint: 'hsl(38 78% 72%)', legend: 'rgba(255,255,255,0.94)', legendText: '#25212f' };
}
/** A rounded label: dark on dark themes, light on light ones. */
export function pill(ctx: CanvasRenderingContext2D, ink: Ink, text: string, x: number, y: number, options: { color?: string; size?: number; alpha?: number; align?: 'center' | 'left' } = {}): Box {
  const size = options.size ?? 11;
  ctx.save();
  ctx.globalAlpha = options.alpha ?? 1;
  ctx.font = `700 ${size}px ${ink.font}`;
  const w = ctx.measureText(text).width + size * 1.1, h = size + 9;
  const x0 = options.align === 'left' ? x : x - w / 2;
  ctx.fillStyle = ink.pill; ctx.strokeStyle = options.color ?? ink.pillBorder; ctx.lineWidth = 1.4;
  ctx.beginPath(); ctx.roundRect(x0, y - h / 2, w, h, h / 2); ctx.fill(); ctx.stroke();
  ctx.fillStyle = ink.pillText; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, x0 + w / 2, y + 0.5);
  ctx.restore();
  return { x0, y0: y - h / 2, x1: x0 + w, y1: y + h / 2 };
}

// What to draw ---------------------------------------------------------------------

/**
 * A hierarchy to draw: the map's scene (blocks already inside their places
 * when streets are on), or a frame of nodes (a focus layout, a morph).
 */
export interface PlanTree {
  rootId?: string;
  node(id: string): NodeSummary | undefined;
  /** Children in painter's order; undefined when none are known. */
  children(id: string): readonly string[] | undefined;
  /** Whether every child is known (a scene loads them lazily). */
  complete(id: string): boolean;
  /** The rect as drawn. */
  rect(node: NodeSummary): Rect;
  /** A frame's opacity per node (morphs). */
  alpha?(id: string): number;
}
export function sceneTree(scene: Scene): PlanTree {
  return {
    rootId: scene.rootId,
    node: id => scene.nodes.get(id),
    children: id => (scene.children.get(id)?.ids.length ? scene.orderedChildren(id) : undefined),
    complete: id => !!scene.children.get(id)?.complete,
    rect: node => node.rect,
  };
}
/** What is drawn at one moment of a morph: nodes (parents first, rects as placed) with an opacity each. */
export interface Frame { nodes: NodeSummary[]; alpha: Map<string, number> }
export function frameTree(frame: Frame): PlanTree {
  const byId = new Map(frame.nodes.map(node => [node.id, node]));
  const kids = new Map<string, string[]>();
  let rootId: string | undefined;
  for (const node of frame.nodes) {
    if (!node.spatialParentId || !byId.has(node.spatialParentId)) { rootId ??= node.id; continue; }
    const list = kids.get(node.spatialParentId) ?? [];
    list.push(node.id); kids.set(node.spatialParentId, list);
  }
  for (const list of kids.values()) list.sort((a, b) => { const p = byId.get(a)!.rect, q = byId.get(b)!.rect; return p.x + p.y - (q.x + q.y); });
  return {
    rootId, node: id => byId.get(id), children: id => kids.get(id), complete: () => true,
    rect: node => { const inset = streetInset(node); const r = node.rect; return { x: r.x + inset, y: r.y + inset, w: Math.max(1, r.w - inset * 2), h: Math.max(1, r.h - inset * 2) }; },
    alpha: id => frame.alpha.get(id) ?? 1,
  };
}

export interface Drawn { node: NodeSummary; rect: Rect; zBase: number; zTop: number; alpha: number; open: boolean; depth: number }
export interface PlanOptions {
  tilt: number;
  /** Areas opened whatever their size on screen. */
  force?: ReadonlySet<string>;
  /** Areas open from this size on screen (CSS px). */
  openPx?: number;
  /** Per-node fill (change colors, tints). */
  tint?: (node: NodeSummary) => string | undefined;
  /** Per-node height factor (grow from the ground, sink into it). */
  grow?: (node: NodeSummary) => number;
  /** Per-node size factor around its center (what grows in the plan, where heights do not show). */
  scale?: (node: NodeSummary) => number;
  /** Per-node outline. */
  ring?: (node: NodeSummary) => { color: string; width: number; dash?: number[] } | undefined;
  /** A prefix for names (+ ~ −). */
  glyph?: (node: NodeSummary) => string;
  /** What stays at full strength: the rest recedes (areas less than blocks). */
  keep?: ReadonlySet<string>;
  /** Which closed blocks get a name (default: all that fit). Open areas are always named. */
  labelFor?: (node: NodeSummary) => boolean;
  labels?: boolean;
  /** Collects the screen boxes of the names drawn (arrow labels keep off them). */
  collect?: Box[];
  /** Open areas whose children are not all loaded yet. */
  pending?: (id: string) => void;
}
export interface PlanResult { drawn: Map<string, Drawn>; order: Drawn[]; signature: number }

/** Draws a tree from a camera; returns what was drawn (with heights) for arrows, labels and characters. */
export function drawPlan(ctx: CanvasRenderingContext2D, theme: Theme, palettes: PaletteCache, viewport: Viewport, camera: Camera, tree: PlanTree, options: PlanOptions): PlanResult {
  const project = projector(options.tilt);
  const screen = (x: number, y: number, z = 0) => toScreen(camera, viewport, project(x, y, z));
  const drawn = new Map<string, Drawn>();
  const order: Drawn[] = [];
  let signature = 0;
  const root = tree.rootId ? tree.node(tree.rootId) : undefined;
  if (!root) return { drawn, order, signature };
  const openPx = options.openPx ?? 210;
  const view = { x0: -60, y0: -60, x1: viewport.width + 60, y1: viewport.height + 60 };
  const onScreen = (rect: Rect, zTop: number): boolean => {
    const pts = [screen(rect.x, rect.y, zTop), screen(rect.x + rect.w, rect.y, zTop), screen(rect.x + rect.w, rect.y + rect.h, 0), screen(rect.x, rect.y + rect.h, 0)];
    const box = { x0: Math.min(...pts.map(p => p.x)), y0: Math.min(...pts.map(p => p.y)), x1: Math.max(...pts.map(p => p.x)), y1: Math.max(...pts.map(p => p.y)) };
    return box.x1 >= view.x0 && box.x0 <= view.x1 && box.y1 >= view.y0 && box.y0 <= view.y1;
  };
  const visit = (node: NodeSummary, zBase: number, alpha: number, depth: number) => {
    let rect = tree.rect(node);
    const k = options.scale?.(node);
    if (k !== undefined && k !== 1) rect = { x: rect.x + rect.w * (1 - k) / 2, y: rect.y + rect.h * (1 - k) / 2, w: Math.max(0.5, rect.w * k), h: Math.max(0.5, rect.h * k) };
    const a = alpha * (tree.alpha?.(node.id) ?? 1);
    const height = nodeHeight(node) * (options.grow?.(node) ?? 1);
    if (!onScreen(rect, zBase + height) && depth > 0) return;
    const list = tree.children(node.id);
    const size = Math.sqrt(rect.w * rect.h) * camera.scale;
    const wants = node.childCount > 0 && (!!options.force?.has(node.id) || size >= openPx);
    if (wants && !tree.complete(node.id)) options.pending?.(node.id);
    const open = wants && !!list?.length;
    const item: Drawn = { node, rect, zBase, zTop: zBase + height, alpha: a, open, depth };
    drawn.set(node.id, item); order.push(item);
    if (open) {
      signature = (signature * 31 + hashId(node.id)) | 0;
      if (a > 0.01) for (const child of list!) { const next = tree.node(child); if (next) visit(next, zBase + height, a, depth + 1); }
    }
  };
  visit(root, 0, 1, 0);
  const tilt = options.tilt;
  for (const item of order) {
    if (item.alpha <= 0.01) continue;
    const { rect, node } = item;
    const tile = node.id.startsWith(TILE);
    const palette = palettes.get(tile ? 'directory' : paletteKey(node), item.depth);
    const tint = options.tint?.(node);
    // Areas stay readable as nested frames; other blocks recede further.
    const dim = options.keep && !options.keep.has(node.id) ? (item.open ? 0.6 : 0.28) : 1;
    ctx.save();
    ctx.globalAlpha = item.alpha * dim * (tile ? 0.75 : 1);
    const t = item.zTop, b = item.zBase;
    if (tilt < 0.999) {
      // Walls facing the viewer: +y (left on screen) and +x (right).
      poly(ctx, [screen(rect.x, rect.y + rect.h, t), screen(rect.x + rect.w, rect.y + rect.h, t), screen(rect.x + rect.w, rect.y + rect.h, b), screen(rect.x, rect.y + rect.h, b)], tint ? shade(tint, 0.72) : palette.left);
      poly(ctx, [screen(rect.x + rect.w, rect.y, t), screen(rect.x + rect.w, rect.y + rect.h, t), screen(rect.x + rect.w, rect.y + rect.h, b), screen(rect.x + rect.w, rect.y, b)], tint ? shade(tint, 0.55) : palette.right);
    }
    const top = [screen(rect.x, rect.y, t), screen(rect.x + rect.w, rect.y, t), screen(rect.x + rect.w, rect.y + rect.h, t), screen(rect.x, rect.y + rect.h, t)];
    poly(ctx, top, tint ?? palette.top, item.open ? (theme.dark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.12)') : (theme.dark ? 'rgba(0,0,0,0.35)' : 'rgba(0,0,0,0.18)'));
    if (tile) { ctx.setLineDash([4, 3]); ctx.strokeStyle = theme.dark ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.3)'; ctx.lineWidth = 1; outline(ctx, top); ctx.stroke(); ctx.setLineDash([]); }
    const ring = options.ring?.(node);
    if (ring) { ctx.globalAlpha = item.alpha; ctx.strokeStyle = ring.color; ctx.lineWidth = ring.width; ctx.setLineDash(ring.dash ?? []); ctx.shadowColor = ring.color; ctx.shadowBlur = 10; outline(ctx, top); ctx.stroke(); }
    ctx.restore();
  }
  if (options.labels !== false) names(ctx, theme, order, screen, camera, tilt, options);
  return { drawn, order, signature };
}
function hashId(id: string): number { let h = 0; for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0; return h; }
/** IDs of the `+N` tiles a focus layout folds siblings into. */
export const TILE = 'tile:';

function names(ctx: CanvasRenderingContext2D, theme: Theme, order: Drawn[], screen: (x: number, y: number, z?: number) => Point, camera: Camera, tilt: number, options: PlanOptions) {
  const boxes: Box[] = options.collect ?? [];
  const font = theme.style?.font ?? FONT;
  const free = (x0: number, y0: number, x1: number, y1: number) => !boxes.some(b => x0 < b.x1 && x1 > b.x0 && y0 < b.y1 && y1 > b.y0);
  ctx.save();
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  // Blocks first (what the reader came for), then the areas.
  const sorted = order.filter(item => item.alpha > 0.15).sort((a, b) => Number(a.open) - Number(b.open) || b.rect.w * b.rect.h - a.rect.w * a.rect.h);
  for (const item of sorted) {
    const { rect, node } = item;
    const side = Math.min(rect.w, rect.h) * camera.scale;
    const dim = options.keep && !options.keep.has(node.id);
    if (item.open) {
      if (node.type === 'repository') continue;
      const at = tilt > 0.5 ? screen(rect.x + 6 / camera.scale, rect.y + 2 / camera.scale, item.zTop) : screen(rect.x, rect.y, item.zTop);
      ctx.font = `800 ${tilt > 0.5 ? 11 : 10.5}px ${font}`;
      const text = `${node.name}${node.type === 'directory' ? '/' : ''}`;
      const w = ctx.measureText(text).width;
      const x0 = tilt > 0.5 ? at.x : at.x - w / 2, y = tilt > 0.5 ? at.y + 9 : at.y - 8;
      if (!free(x0, y - 7, x0 + w, y + 7)) continue;
      boxes.push({ x0, y0: y - 7, x1: x0 + w, y1: y + 7 });
      ctx.globalAlpha = item.alpha * (dim ? 0.45 : 0.92); ctx.fillStyle = theme.text.district; ctx.textAlign = 'left';
      ctx.fillText(text, x0, y);
      continue;
    }
    if (side < 26) continue;
    if (options.labelFor && !options.labelFor(node)) continue;
    const center = screen(rect.x + rect.w / 2, rect.y + rect.h / 2, item.zTop);
    const tile = node.id.startsWith(TILE);
    // A name shrinks to fit its block (down to 8.5 px); the kind goes under it when there is room.
    const room = (tilt > 0.5 ? rect.w : Math.max(rect.w, rect.h) * 1.2) * camera.scale - 6;
    let size = tile ? 10.5 : Math.min(13, 9 + side / 30);
    const text = `${options.glyph?.(node) ?? ''}${node.name}`;
    ctx.font = `${tile ? 700 : 800} ${size}px ${font}`;
    let w = ctx.measureText(text).width;
    if (w > room && !tile) { size = Math.max(8.5, size * room / w); ctx.font = `800 ${size}px ${font}`; w = ctx.measureText(text).width; }
    const kind = tile ? node.detail : node.archetype?.kind ?? (node.type === 'file' ? undefined : node.type);
    const sub = kind && side > size * 3.4 ? kind : undefined;
    const h = sub ? size * 2.2 : size * 1.3;
    if (!free(center.x - w / 2 - 3, center.y - h / 2, center.x + w / 2 + 3, center.y + h / 2)) continue;
    boxes.push({ x0: center.x - w / 2 - 3, y0: center.y - h / 2, x1: center.x + w / 2 + 3, y1: center.y + h / 2 });
    ctx.globalAlpha = item.alpha * (dim ? 0.38 : 1); ctx.textAlign = 'center';
    ctx.lineWidth = 3; ctx.strokeStyle = theme.text.halo; ctx.fillStyle = tile ? theme.text.secondary : theme.text.primary;
    const y = sub ? center.y - size * 0.45 : center.y;
    ctx.strokeText(text, center.x, y); ctx.fillText(text, center.x, y);
    if (sub) { ctx.font = `600 ${size * 0.78}px ${font}`; ctx.fillStyle = theme.text.secondary; ctx.strokeText(sub, center.x, y + size * 1.05); ctx.fillText(sub, center.x, y + size * 1.05); }
  }
  ctx.restore();
}
function poly(ctx: CanvasRenderingContext2D, points: Point[], fill: string, stroke?: string) {
  outline(ctx, points);
  ctx.fillStyle = fill; ctx.fill();
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.stroke(); }
}
function outline(ctx: CanvasRenderingContext2D, points: Point[]) { ctx.beginPath(); points.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.closePath(); }
function shade(color: string, k: number): string {
  const match = /hsl\(([\d.]+)[ ,]+([\d.]+)%[ ,]+([\d.]+)%\)/.exec(color);
  return match ? `hsl(${match[1]} ${match[2]}% ${(Number(match[3]) * k).toFixed(1)}%)` : color;
}

/** The screen box of a drawn block's top. */
export function screenBox(item: Drawn, camera: Camera, viewport: Viewport, tilt: number): Box {
  const project = projector(tilt), r = item.rect;
  const pts = [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]].map(([x, y]) => toScreen(camera, viewport, project(x!, y!, item.zTop)));
  return { x0: Math.min(...pts.map(q => q.x)), y0: Math.min(...pts.map(q => q.y)), x1: Math.max(...pts.map(q => q.x)), y1: Math.max(...pts.map(q => q.y)) };
}
/** Screen boxes of the closed blocks drawn (labels may sit on them, streets are better). */
export function blockBoxes(drawn: Iterable<Drawn>, camera: Camera, viewport: Viewport, tilt: number): Box[] {
  const out: Box[] = [];
  for (const item of drawn) if (!item.open && item.alpha >= 0.3 && !item.node.id.startsWith(TILE)) out.push(screenBox(item, camera, viewport, tilt));
  return out;
}
/** The innermost block under a screen point: its top, as drawn at this tilt. */
export function hitPlan(order: Drawn[], camera: Camera, viewport: Viewport, x: number, y: number, tilt = 1): Drawn | undefined {
  const p = fromScreen(camera, viewport, { x, y });
  const project = projector(tilt);
  for (let i = order.length - 1; i >= 0; i--) {
    const item = order[i]!, r = item.rect;
    if (item.alpha < 0.2 || item.node.id.startsWith(TILE) || item.node.type === 'repository') continue;
    if (tilt >= 0.999) { if (p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h) return item; continue; }
    const top = [project(r.x, r.y, item.zTop), project(r.x + r.w, r.y, item.zTop), project(r.x + r.w, r.y + r.h, item.zTop), project(r.x, r.y + r.h, item.zTop)];
    if (inside(top, p)) return item;
  }
  return undefined;
}
/** Whether a point is inside a convex polygon. */
function inside(points: Point[], p: Point): boolean {
  let sign = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!, b = points[(i + 1) % points.length]!;
    const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    if (cross === 0) continue;
    if (sign === 0) sign = Math.sign(cross); else if (Math.sign(cross) !== sign) return false;
  }
  return true;
}
/** Where something stands on a drawn block (its top's center), or on its nearest drawn ancestor. */
export function anchorOn(drawn: Map<string, Drawn>, ids: readonly string[]): Drawn | undefined {
  for (const id of ids) { const item = drawn.get(id); if (item) return item; }
  return undefined;
}

// Arrows ---------------------------------------------------------------------------------

export interface Arrow { from: string; to: string; label?: string; directed?: boolean; color?: string; dash?: number[]; chip?: string; width?: number; type?: string }
export interface RoutedArrow extends Arrow { points: { x: number; y: number; z: number }[]; routed: boolean }
/** Routes along the streets of what was drawn (the map's rail router), straight when it finds no way. */
export function routeArrows(drawn: Map<string, Drawn>, arrows: Arrow[], resolve: (id: string) => string | undefined = id => (drawn.has(id) ? id : undefined)): RoutedArrow[] {
  const kids = new Map<string, string[]>();
  for (const item of drawn.values()) { const parent = item.node.spatialParentId; if (parent && drawn.get(parent)?.open) { const list = kids.get(parent) ?? []; list.push(item.node.id); kids.set(parent, list); } }
  const world: RailWorld = {
    rect: id => drawn.get(id)?.rect,
    parent: id => { const parent = drawn.get(id)?.node.spatialParentId; return parent && drawn.has(parent) ? parent : undefined; },
    children: id => kids.get(id) ?? [],
    top: id => drawn.get(id)?.zTop ?? 0,
  };
  return arrows.flatMap((arrow): RoutedArrow[] => {
    const fromId = resolve(arrow.from), toId = resolve(arrow.to);
    const a = fromId ? drawn.get(fromId) : undefined, b = toId ? drawn.get(toId) : undefined;
    if (!a || !b || a === b) return [];
    let rail;
    try { rail = railRoute(world, a.node.id, b.node.id); } catch { rail = undefined; }
    if (rail?.points.length) return [{ ...arrow, points: rail.points, routed: true }];
    const ca = { x: a.rect.x + a.rect.w / 2, y: a.rect.y + a.rect.h / 2, z: a.zTop }, cb = { x: b.rect.x + b.rect.w / 2, y: b.rect.y + b.rect.h / 2, z: b.zTop };
    return [{ ...arrow, points: [ca, cb], routed: false }];
  });
}
/**
 * Where arrow labels go. `placed`: the cheapest of several spots along the
 * route (on the line, or beside it), scored against names, blocks, arrow
 * ends, other arrows and labels already placed; a label with no good spot
 * becomes a numbered badge, its text in a legend. `numbered`: badges only.
 * `line`: in the middle of the longest run.
 */
export type LabelMode = 'line' | 'placed' | 'numbered';
export interface ArrowLabelOptions {
  mode?: LabelMode;
  /** Hard obstacles: names drawn, panels. */
  avoid?: Box[];
  /** Soft obstacles: blocks. */
  blocks?: Box[];
  /** Top-left corner of the legend of numbered labels (screen px). */
  legend?: Point;
}
interface Pending { points: Point[]; lengths: number[]; text: string; color: string; total: number }

/** Draws routed arrows (progress 0..1 draws them in), then their labels; returns the label boxes. */
export function drawArrows(ctx: CanvasRenderingContext2D, ink: Ink, theme: Theme, viewport: Viewport, camera: Camera, tilt: number, arrows: RoutedArrow[], progress = 1, time = 0, labelOptions: ArrowLabelOptions = {}, moving = true): Box[] {
  const project = projector(tilt);
  const pending: Pending[] = [];
  for (const arrow of arrows) {
    const points = arrow.points.map(p => toScreen(camera, viewport, project(p.x, p.y, p.z)));
    const lengths = [0];
    for (let i = 1; i < points.length; i++) lengths.push(lengths[i - 1]! + Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y));
    const total = lengths.at(-1)!;
    if (total < 2) continue;
    const upto = total * progress;
    const color = arrow.color ?? theme.flow.step;
    const text = arrow.chip ? (arrow.label ? `${arrow.label} · ${arrow.chip}` : arrow.chip) : arrow.label ?? '';
    if (text && progress > 0.9) pending.push({ points, lengths, text, color, total });
    if (arrow.width === 0) continue; // labels only: another renderer draws the line
    ctx.save();
    ctx.strokeStyle = color; ctx.lineWidth = arrow.width ?? 2.2; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.setLineDash(arrow.dash ?? (arrow.routed ? [] : [5, 4]));
    ctx.shadowColor = color; ctx.shadowBlur = 6;
    ctx.beginPath(); ctx.moveTo(points[0]!.x, points[0]!.y);
    let end = points[0]!, angle = 0;
    for (let i = 1; i < points.length; i++) {
      if (lengths[i]! <= upto) { ctx.lineTo(points[i]!.x, points[i]!.y); end = points[i]!; angle = Math.atan2(points[i]!.y - points[i - 1]!.y, points[i]!.x - points[i - 1]!.x); continue; }
      const k = (upto - lengths[i - 1]!) / Math.max(1e-6, lengths[i]! - lengths[i - 1]!);
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
    // A pulse travels along it: the direction is carried by motion, not by the layout.
    if (progress >= 1 && moving) {
      const at = ((time / 1600) % 1) * total;
      const i = Math.max(1, lengths.findIndex(l => l >= at));
      const k = (at - lengths[i - 1]!) / Math.max(1e-6, lengths[i]! - lengths[i - 1]!);
      const p = { x: points[i - 1]!.x + (points[i]!.x - points[i - 1]!.x) * k, y: points[i - 1]!.y + (points[i]!.y - points[i - 1]!.y) * k };
      ctx.fillStyle = ink.dark ? '#fff6dc' : '#ffffff'; ctx.shadowColor = color; ctx.shadowBlur = 10; ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }
  return (labelOptions.mode ?? 'placed') === 'line' ? lineLabels(ctx, ink, pending) : placedLabels(ctx, ink, viewport, pending, labelOptions);
}
function lineLabels(ctx: CanvasRenderingContext2D, ink: Ink, pending: Pending[]): Box[] {
  const placed: Box[] = [];
  ctx.save(); ctx.font = `700 10.5px ${ink.font}`; ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
  for (const label of pending) {
    let best = 1, run = 0;
    for (let i = 1; i < label.points.length; i++) { const l = label.lengths[i]! - label.lengths[i - 1]!; if (l > run) { run = l; best = i; } }
    const a = label.points[best - 1]!, b = label.points[best]!, x = (a.x + b.x) / 2;
    const w = ctx.measureText(label.text).width + 12, h = 18;
    let y = (a.y + b.y) / 2;
    const taken = () => placed.some(p => x - w / 2 < p.x1 && x + w / 2 > p.x0 && y - h / 2 < p.y1 && y + h / 2 > p.y0);
    for (let tries = 0; tries < 8 && taken(); tries++) y += (tries % 2 ? -1 : 1) * h * Math.ceil((tries + 1) / 2);
    // Never over another label: one with no room left is not drawn.
    if (taken()) continue;
    placed.push({ x0: x - w / 2, y0: y - h / 2, x1: x + w / 2, y1: y + h / 2 });
    labelPill(ctx, ink, label.text, x, y, w, h, label.color);
  }
  ctx.restore();
  return placed;
}
function labelPill(ctx: CanvasRenderingContext2D, ink: Ink, text: string, x: number, y: number, w: number, h: number, color: string) {
  ctx.fillStyle = ink.pill; ctx.strokeStyle = color; ctx.lineWidth = 1.2;
  ctx.beginPath(); ctx.roundRect(x - w / 2, y - h / 2, w, h, h / 2); ctx.fill(); ctx.stroke();
  ctx.fillStyle = ink.pillText; ctx.fillText(text, x, y + 0.5);
}
/** Scored placement along each route, numbered badges as the fallback. */
function placedLabels(ctx: CanvasRenderingContext2D, ink: Ink, viewport: Viewport, pending: Pending[], options: ArrowLabelOptions): Box[] {
  const numbered = options.mode === 'numbered';
  const weighted: { box: Box; weight: number; owner?: number }[] = [
    ...(options.avoid ?? []).map(box => ({ box, weight: 5 })),
    ...(options.blocks ?? []).map(box => ({ box, weight: 0.7 })),
  ];
  // Arrow ends (where it leaves, the arrowhead) and every run of every arrow, as thin boxes.
  pending.forEach((label, owner) => {
    for (const p of [label.points[0]!, label.points.at(-1)!]) weighted.push({ box: { x0: p.x - 9, y0: p.y - 9, x1: p.x + 9, y1: p.y + 9 }, weight: 4 });
    for (let i = 1; i < label.points.length; i++) {
      const a = label.points[i - 1]!, b = label.points[i]!;
      weighted.push({ box: { x0: Math.min(a.x, b.x) - 2, y0: Math.min(a.y, b.y) - 2, x1: Math.max(a.x, b.x) + 2, y1: Math.max(a.y, b.y) + 2 }, weight: 0.8, owner });
    }
  });
  const placed: Box[] = [];
  const legend: { n: number; text: string; color: string }[] = [];
  ctx.save(); ctx.font = `700 10.5px ${ink.font}`; ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
  // Short routes first: they have the fewest spots.
  const order = pending.map((_, i) => i).sort((a, b) => pending[a]!.total - pending[b]!.total);
  for (const i of order) {
    const label = pending[i]!;
    // A spot over another label or a hard obstacle (a name, a panel) is never taken.
    const hard = options.avoid ?? [];
    const spot = (w: number, h: number) => {
      let best: { x: number; y: number; cost: number } | undefined;
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
            if (placed.some(other => overlap(box, other) > 0) || hard.some(other => overlap(box, other) > 0)) continue;
            const area = w * h;
            let cost = shiftCost + 0.2 * along;
            if (box.x0 < 4 || box.y0 < 4 || box.x1 > viewport.width - 4 || box.y1 > viewport.height - 4) cost += 3;
            for (const item of weighted) if (item.owner !== i) cost += item.weight * overlap(box, item.box) / area;
            for (const other of placed) cost += 10 * overlap(box, other) / area;
            if (!best || cost < best.cost) best = { x, y, cost };
          }
        }
      }
      return best;
    };
    const w = ctx.measureText(label.text).width + 12, h = 18;
    const full = numbered ? undefined : spot(w, h);
    if (full && full.cost < 0.75) {
      placed.push({ x0: full.x - w / 2, y0: full.y - h / 2, x1: full.x + w / 2, y1: full.y + h / 2 });
      labelPill(ctx, ink, label.text, full.x, full.y, w, h, label.color);
      continue;
    }
    // No good spot (or numbers asked for): a badge on the line, the text in the legend.
    const n = legend.length + 1;
    const badge = spot(18, 18);
    if (!badge) continue;
    placed.push({ x0: badge.x - 9, y0: badge.y - 9, x1: badge.x + 9, y1: badge.y + 9 });
    ctx.fillStyle = label.color; ctx.beginPath(); ctx.arc(badge.x, badge.y, 9, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#0b0d16'; ctx.font = `900 10.5px ${ink.font}`; ctx.fillText(String(n), badge.x, badge.y + 0.5); ctx.font = `700 10.5px ${ink.font}`;
    legend.push({ n, text: label.text, color: label.color });
  }
  if (legend.length) {
    ctx.textAlign = 'left';
    const width = Math.max(...legend.map(item => ctx.measureText(item.text).width)) + 46, height = legend.length * 20 + 14;
    const at = options.legend ?? { x: 14, y: viewport.height - 20 - height };
    ctx.fillStyle = ink.legend; ctx.strokeStyle = ink.pillBorder; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.roundRect(at.x, at.y, width, height, 10); ctx.fill(); ctx.stroke();
    legend.forEach((item, k) => {
      const y = at.y + 17 + k * 20;
      ctx.fillStyle = item.color; ctx.beginPath(); ctx.arc(at.x + 18, y, 8, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#0b0d16'; ctx.textAlign = 'center'; ctx.font = `900 10px ${ink.font}`; ctx.fillText(String(item.n), at.x + 18, y + 0.5);
      ctx.fillStyle = ink.legendText; ctx.textAlign = 'left'; ctx.font = `700 11px ${ink.font}`; ctx.fillText(item.text, at.x + 33, y + 0.5);
    });
  }
  ctx.restore();
  return placed;
}

// Callouts --------------------------------------------------------------------------------

/** A block a tool is about: named inside when it fits, otherwise by a callout (a marker, a leader, a label). */
export interface CalloutItem { id: string; box: Box; name: string; sub: string; container: boolean; color?: string }
/**
 * Labels for blocks too small to read: big blocks keep their names inside,
 * the rest get a label placed where it covers least (8 directions × 3
 * distances), with a leader line, and a pulsing ring when the block is tiny.
 * Returns the boxes placed.
 */
export function drawCallouts(ctx: CanvasRenderingContext2D, ink: Ink, viewport: Viewport, items: CalloutItem[], avoid: Box[], routes: Point[][], time: number, moving = true): Box[] {
  const blocks = items.map(item => item.box);
  const lines: Box[] = routes.flatMap(points => points.slice(1).map((b, i) => { const a = points[i]!; return { x0: Math.min(a.x, b.x) - 2, y0: Math.min(a.y, b.y) - 2, x1: Math.max(a.x, b.x) + 2, y1: Math.max(a.y, b.y) + 2 }; }));
  ctx.save(); ctx.textBaseline = 'middle';
  const shown = items.filter(item => !(item.box.x1 < 0 || item.box.y1 < 0 || item.box.x0 > viewport.width || item.box.y0 > viewport.height));
  // The biggest first: they have the most room around them.
  const sorted = [...shown].sort((a, b) => (b.box.x1 - b.box.x0) * (b.box.y1 - b.box.y0) - (a.box.x1 - a.box.x0) * (a.box.y1 - a.box.y0));
  const sized = sorted.map(item => {
    ctx.font = `800 12px ${ink.font}`;
    const w1 = ctx.measureText(item.name).width;
    ctx.font = `600 10px ${ink.font}`;
    const w2 = item.sub ? ctx.measureText(item.sub).width : 0;
    return { item, w: Math.max(w1, w2) + 16, h: item.sub ? 32 : 20 };
  });
  let memory = memories.get(ctx);
  if (!memory) { memory = new Map(); memories.set(ctx, memory); }
  // Inside a block that holds it; otherwise beside it, then further out with a leader, then in a column at the side; never over another label, an arrow or a panel.
  const { placed } = placeLabels(sized.map(({ item, w, h }) => ({ key: item.id, target: item.box, w, h, inside: !item.container })), {
    bounds: { x0: 4, y0: 4, x1: viewport.width - 4, y1: viewport.height - 4 }, avoid: [...avoid, ...lines], soft: blocks, memory, distances: [6, 22, 44, 76, 116],
  });
  const byId = new Map(sized.map(entry => [entry.item.id, entry]));
  for (const spot of placed) {
    const { item, w, h } = byId.get(spot.key)!;
    const { box } = item;
    const color = item.color ?? ink.accent;
    const x = (spot.box.x0 + spot.box.x1) / 2, y = (spot.box.y0 + spot.box.y1) / 2;
    if (spot.inside) { callout(ctx, ink, item, x, y, w, h, false, color); continue; }
    const bw = box.x1 - box.x0, bh = box.y1 - box.y0, mx = (box.x0 + box.x1) / 2, my = (box.y0 + box.y1) / 2;
    const r = Math.max(9, Math.max(bw, bh) / 2 + 3);
    const tiny = Math.max(bw, bh) < 14;
    ctx.strokeStyle = color; ctx.lineWidth = 1.6;
    if (tiny) {
      ctx.beginPath(); ctx.arc(mx, my, r, 0, Math.PI * 2); ctx.stroke();
      if (moving) { const pulse = (time % 1400) / 1400; ctx.globalAlpha = 1 - pulse; ctx.beginPath(); ctx.arc(mx, my, r + pulse * 12, 0, Math.PI * 2); ctx.stroke(); ctx.globalAlpha = 1; }
    }
    if (spot.leader) {
      const { from, to } = spot.leader;
      const angle = Math.atan2(to.y - my, to.x - mx);
      const sx = tiny ? mx + Math.cos(angle) * r : from.x, sy = tiny ? my + Math.sin(angle) * r : from.y;
      ctx.globalAlpha = 0.85; ctx.lineWidth = 1.3;
      ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(to.x, to.y); ctx.stroke();
      ctx.globalAlpha = 1; ctx.fillStyle = color; ctx.beginPath(); ctx.arc(sx, sy, 2.2, 0, Math.PI * 2); ctx.fill();
    }
    callout(ctx, ink, item, x, y, w, h, true, color);
  }
  ctx.restore();
  return placed.map(spot => spot.box);
}
/** Where each canvas's callouts went on the previous frame (they keep their places while free). */
const memories = new WeakMap<CanvasRenderingContext2D, Map<string, string>>();
function callout(ctx: CanvasRenderingContext2D, ink: Ink, item: { name: string; sub: string }, x: number, y: number, w: number, h: number, framed: boolean, color: string) {
  ctx.textAlign = 'center';
  if (framed) {
    ctx.fillStyle = ink.pill; ctx.strokeStyle = color; ctx.lineWidth = 1.3;
    ctx.beginPath(); ctx.roundRect(x - w / 2, y - h / 2, w, h, 8); ctx.fill(); ctx.stroke();
  }
  const nameY = item.sub ? y - 6.5 : y + 0.5;
  ctx.font = `800 12px ${ink.font}`; ctx.lineWidth = 3; ctx.lineJoin = 'round'; ctx.strokeStyle = ink.halo; ctx.fillStyle = framed ? ink.pillText : ink.accentText;
  if (!framed) ctx.strokeText(item.name, x, nameY);
  ctx.fillText(item.name, x, nameY);
  if (item.sub) {
    ctx.font = `600 10px ${ink.font}`; ctx.fillStyle = ink.accentSub;
    if (!framed) ctx.strokeText(item.sub, x, y + 8);
    ctx.fillText(item.sub, x, y + 8);
  }
}
/** Where a block sits, for its callout: `in file.ts` for a symbol, the last folders of its path otherwise. */
export function whereOf(node: NodeSummary, file?: NodeSummary): string {
  if (file) return `in ${file.name}`;
  const folders = (node.path ?? '').split('/').slice(0, -1).filter(Boolean);
  return folders.length > 2 ? `…/${folders.slice(-2).join('/')}/` : folders.length ? `${folders.join('/')}/` : '';
}
