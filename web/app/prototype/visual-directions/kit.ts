// PROTOTYPE (throwaway) — shared kit for the three prototypes of
// docs/design/visual-directions.md: data, scenes for the real renderer, the
// focus layout, frames and their morph, a canvas loop with camera controls.
import type { NodeSummary, Rect } from '@engine/projection/dto';
import { layoutHierarchy, type LayoutNode } from '../../../../src/projection/layout';
import { Scene, nodeHeight, type VisibleSet } from '../../../lib/scene';
import { MapRenderer, type RenderState } from '../../../lib/renderer';
import { fitBounds, panBy, projectedBounds, zoomAround, type Bounds, type Camera, type Viewport } from '../../../lib/camera';
import { DEFAULT_THEME, themeById } from '../../../lib/themes';
import { useEffect, useRef } from 'react';

export type N = NodeSummary;
export const theme = themeById(DEFAULT_THEME);
export const LIMITS = { min: 0.015, max: 24 };

const cache = new Map<string, Promise<unknown>>();
export function loadJson<T>(name: string): Promise<T> {
  if (!cache.has(name)) cache.set(name, fetch(`/prototype/visual-directions/${name}.json`).then(response => response.json()));
  return cache.get(name) as Promise<T>;
}

// The map ------------------------------------------------------------------------

export class MapIndex {
  readonly byId = new Map<string, N>();
  readonly kids = new Map<string, string[]>();
  readonly byPath = new Map<string, N>();
  readonly dirs = new Map<string, N>();
  readonly root: N;
  constructor(readonly nodes: N[]) {
    this.root = nodes[0]!;
    for (const node of nodes) {
      this.byId.set(node.id, node);
      if (node.type === 'file' && node.path) this.byPath.set(node.path, node);
      if ((node.type === 'directory' || node.type === 'application') && node.path) this.dirs.set(node.path.replace(/\/$/, ''), node);
    }
    for (const node of nodes) {
      const parent = node.spatialParentId;
      if (!parent || !this.byId.has(parent)) continue;
      const list = this.kids.get(parent) ?? [];
      list.push(node.id); this.kids.set(parent, list);
    }
  }
  ancestors(id: string): string[] {
    const out: string[] = [];
    for (let current = this.byId.get(id)?.spatialParentId; current; current = this.byId.get(current)?.spatialParentId) out.unshift(current);
    return out;
  }
  /** A link as explanations write them: `path`, `path#Symbol`, `dir/`. */
  resolve(link: string): N | undefined {
    if (link.endsWith('/')) return this.dirs.get(link.slice(0, -1));
    const [path, symbol] = link.split('#');
    const file = this.byPath.get(path!) ?? this.dirs.get(path!);
    if (!file || !symbol) return file;
    return (this.kids.get(file.id) ?? []).map(id => this.byId.get(id)!).find(node => node.name === symbol || node.qualifiedName === symbol);
  }
  isContainer(node: N): boolean { return node.type === 'repository' || node.type === 'application' || node.type === 'directory' || node.type === 'group'; }
}

/** A scene for the real renderer from nodes listed parents first (any order is fine: built breadth first). */
export function sceneOf(nodes: N[], rootId?: string): Scene {
  const scene = new Scene();
  const root = rootId ? nodes.find(node => node.id === rootId)! : nodes[0]!;
  scene.reset(root);
  const kids = new Map<string, N[]>();
  for (const node of nodes) {
    if (node.id === root.id || !node.spatialParentId) continue;
    const list = kids.get(node.spatialParentId) ?? [];
    list.push(node); kids.set(node.spatialParentId, list);
  }
  const queue = [root.id];
  while (queue.length) {
    const id = queue.shift()!;
    const list = kids.get(id);
    if (!list) continue;
    scene.addChildren(id, list, list.length, false);
    for (const child of list) queue.push(child.id);
  }
  return scene;
}

export function makeRenderer(transparent = false): MapRenderer {
  const renderer = new MapRenderer(theme);
  if (transparent) {
    const hack = renderer as unknown as Record<string, unknown>;
    hack.background = () => undefined; hack.grid = () => undefined; hack.dotGrid = () => undefined;
  }
  return renderer;
}
export function renderState(time: number, extra: Partial<RenderState> = {}): RenderState {
  return { edges: [], showDiagnostics: false, time, reducedMotion: false, shapes: true, streets: true, connections: 'rails', ...extra };
}

// Geometry -----------------------------------------------------------------------

export const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
export const clamp01 = (t: number) => Math.max(0, Math.min(1, t));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export function lerpRect(a: Rect, b: Rect, t: number): Rect { return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), w: lerp(a.w, b.w, t), h: lerp(a.h, b.h, t) }; }
export function lerpCamera(a: Camera, b: Camera, t: number): Camera {
  return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), scale: Math.exp(lerp(Math.log(a.scale), Math.log(b.scale), t)) };
}
export function unionBounds(list: Bounds[]): Bounds {
  return list.reduce((a, b) => ({ minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY), maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY) }));
}
/** Iso-plane bounds of rects (ground to a little above). */
export function isoBounds(rects: Rect[], top = 30): Bounds { return unionBounds(rects.map(rect => projectedBounds(rect, 0, top))); }
export function fitIso(rects: Rect[], viewport: Viewport, padding = 70, limits = LIMITS): Camera { return fitInStage(isoBounds(rects), viewport, padding, limits); }
/** Panels cover the left (and sometimes right) edge: fit into what is left of the stage. */
export const STAGE = { left: 370, right: 0, top: 0 };
export function fitInStage(bounds: Bounds, viewport: Viewport, padding = 70, limits = LIMITS): Camera {
  const free: Viewport = { width: Math.max(200, viewport.width - STAGE.left - STAGE.right), height: viewport.height - 70 - STAGE.top };
  const camera = fitBounds(bounds, free, padding, limits);
  // Shift so the content sits in the middle of the free area.
  return { scale: camera.scale, x: camera.x - (STAGE.left - STAGE.right) / 2 / camera.scale, y: camera.y + (35 - STAGE.top / 2) / camera.scale };
}
export function rectBounds(rects: Rect[]): Rect {
  const minX = Math.min(...rects.map(r => r.x)), minY = Math.min(...rects.map(r => r.y));
  const maxX = Math.max(...rects.map(r => r.x + r.w)), maxY = Math.max(...rects.map(r => r.y + r.h));
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

// The focus layout -----------------------------------------------------------------

export interface FocusOptions {
  /** Siblings outside the interest set: one `+N` tile per area, or dropped. */
  fold: 'tile' | 'drop';
  /** Clamp of a kept file's side (world units), and of a kept symbol's. */
  fileSide?: [number, number];
  symbolSide?: [number, number];
  /** Paddings by type (bigger than the map's: arrows and labels need streets). */
  padding?: Record<string, number>;
}
export interface Focus {
  /** Nodes of the focus layout, parents first: real nodes (renamed when merged) and `+N` tiles. */
  nodes: N[];
  rects: Map<string, Rect>;
  /** Merged chains: head → the folders merged into it. */
  merged: Map<string, string[]>;
  /** Tiles: id → how many things they stand for. */
  tiles: Map<string, number>;
  interest: Set<string>;
  bounds: Rect;
}
const FOCUS_PADDING: Record<string, number> = { repository: 30, application: 26, directory: 24, group: 24, file: 8 };
/** The leaf weight whose footprint (`leafSide`) is closest to `side`. */
function weightFor(side: number): number { return 2 ** Math.max(0, Math.min(16, Math.round(2 * Math.log2(Math.max(8, side) / 8)))); }
function readingOrder(index: MapIndex, ids: string[]): string[] {
  return [...ids].sort((a, b) => { const x = index.byId.get(a)!.rect, y = index.byId.get(b)!.rect; return (x.y + x.x * 0.35) - (y.y + y.x * 0.35); });
}

/**
 * Only the cut, packed by the map's own packer: the interest set and its
 * ancestors (open), each open area's other children folded into a `+N` tile
 * (or dropped), single-child chains merged, files at their real size clamped.
 * Placed around the middle of where the interest set is on the map.
 */
export function focusLayout(index: MapIndex, interestIds: string[], options: FocusOptions): Focus {
  const fileSide = options.fileSide ?? [56, 120], symbolSide = options.symbolSide ?? [34, 64];
  const padding = { ...FOCUS_PADDING, ...options.padding };
  const interest = new Set(interestIds.filter(id => index.byId.has(id)));
  const keep = new Set<string>();
  for (const id of interest) { keep.add(id); for (const ancestor of index.ancestors(id)) keep.add(ancestor); }
  // Kept children per kept node (reading order), and what is folded.
  const children = new Map<string, string[]>();
  const tiles = new Map<string, number>();
  for (const id of keep) {
    const node = index.byId.get(id)!;
    const all = index.kids.get(id) ?? [];
    const kept = all.filter(child => keep.has(child));
    if (!kept.length && interest.has(id)) continue; // a leaf of the set (a file, or a folder shown closed)
    children.set(id, readingOrder(index, kept));
    const others = all.filter(child => !keep.has(child));
    if (others.length && options.fold === 'tile') {
      const count = node.type === 'file' ? others.length : others.reduce((sum, child) => { const other = index.byId.get(child)!; return sum + (other.type === 'file' ? 1 : Math.max(1, other.stats?.files ?? 1)); }, 0);
      const tile = `tile:${id}`;
      tiles.set(tile, count);
      children.get(id)!.push(tile);
    }
  }
  // Merge single-child chains of folders.
  const merged = new Map<string, string[]>();
  const names = new Map<string, string>();
  const parentOf = new Map<string, string>();
  const root = index.root.id;
  const walk = (id: string) => {
    let list = children.get(id);
    if (!list) return;
    const node = index.byId.get(id)!;
    if (node.type === 'directory' || node.type === 'group') {
      while (list.length === 1 && !list[0]!.startsWith('tile:')) {
        const only: N = index.byId.get(list[0]!)!;
        if (!(only.type === 'directory' || only.type === 'group') || !children.has(only.id) || interest.has(only.id)) break;
        merged.set(id, [...merged.get(id) ?? [], only.id]);
        names.set(id, `${names.get(id) ?? node.name}/${only.name}`);
        list = children.get(only.id)!;
        children.set(id, list);
        children.delete(only.id);
      }
    }
    for (const child of list) { parentOf.set(child, id); walk(child); }
  };
  walk(root);
  // Layout nodes.
  const layout = new Map<string, LayoutNode>();
  const add = (id: string) => {
    if (id.startsWith('tile:')) {
      const count = tiles.get(id)!;
      layout.set(id, { id, children: [], weight: weightFor(Math.min(64, 30 + 7 * Math.log2(1 + count))), padding: 3 });
      return;
    }
    const node = index.byId.get(id)!;
    const list = children.get(id);
    if (list) { layout.set(id, { id, children: list, padding: padding[node.type] ?? 8, preserveOrder: true }); list.forEach(add); return; }
    const isSymbol = !index.isContainer(node) && node.type !== 'file';
    const [min, max] = isSymbol ? symbolSide : fileSide;
    const real = Math.sqrt(node.rect.w * node.rect.h);
    layout.set(id, { id, children: [], weight: weightFor(Math.max(min, Math.min(max, real))), padding: 3 });
  };
  add(root);
  const result = layoutHierarchy(layout, root, undefined, { compact: true });
  // Around the middle of the interest set on the map.
  const real = rectBounds([...interest].map(id => index.byId.get(id)!.rect));
  const own = result.rects.get(root)!;
  const dx = real.x + real.w / 2 - own.w / 2, dy = real.y + real.h / 2 - own.h / 2;
  const rects = new Map<string, Rect>();
  for (const [id, rect] of result.rects) rects.set(id, { x: rect.x + dx, y: rect.y + dy, w: rect.w, h: rect.h });
  const nodes: N[] = [];
  const emit = (id: string) => {
    const rect = rects.get(id)!;
    if (id.startsWith('tile:')) {
      const count = tiles.get(id)!, owner = index.byId.get(id.slice(5))!;
      nodes.push({ id, kind: 'group', type: 'group', name: `+${count} ${owner.type === 'file' ? 'symbols' : `file${count === 1 ? '' : 's'}`}`, detail: 'not in this view', depth: 0, rect, childCount: 0, diagnostics: 0, spatialParentId: parentOf.get(id), stats: { files: count, symbols: 0, endpoints: 0, measuredLoc: 0, unmeasuredFiles: 0, descendants: 0 } } as N);
      return;
    }
    const node = index.byId.get(id)!;
    const list = children.get(id);
    nodes.push({ ...node, archetypeCounts: undefined, name: names.get(id) ?? node.name, rect, spatialParentId: parentOf.get(id), childCount: list ? list.length : node.type === 'file' ? 0 : node.childCount });
    list?.forEach(emit);
  };
  emit(root);
  return { nodes, rects, merged, tiles, interest, bounds: rects.get(root)! };
}

// Frames and their morph --------------------------------------------------------------

/** What is drawn at one moment: nodes (parents first) with an opacity each. */
export interface Frame { nodes: N[]; alpha: Map<string, number> }
export function mapFrame(index: MapIndex): Frame { return { nodes: index.nodes, alpha: new Map() }; }
export function focusFrame(focus: Focus): Frame { return { nodes: focus.nodes, alpha: new Map() }; }
/**
 * Between two frames: shared nodes slide (rect interpolated, the target's
 * parent and name), nodes only in `a` fade out early where they were, nodes
 * only in `b` fade in late where they go.
 */
export function morph(a: Frame, b: Frame, t: number): Frame {
  const inB = new Map(b.nodes.map(node => [node.id, node]));
  const inA = new Map(a.nodes.map(node => [node.id, node]));
  const out: N[] = [], alpha = new Map<string, number>();
  const leave = 1 - clamp01(t / 0.35), arrive = clamp01((t - 0.55) / 0.45), slide = ease(clamp01((t - 0.1) / 0.85));
  for (const node of b.nodes) {
    const from = inA.get(node.id);
    if (from) { out.push({ ...node, rect: lerpRect(from.rect, node.rect, slide) }); alpha.set(node.id, lerp(a.alpha.get(node.id) ?? 1, b.alpha.get(node.id) ?? 1, slide)); }
    else { out.push(node); alpha.set(node.id, arrive * (b.alpha.get(node.id) ?? 1)); }
  }
  for (const node of a.nodes) {
    if (inB.has(node.id)) continue;
    // Parent: where it is in `a`, unless that parent left too (then the nearest that stays).
    out.push(node); alpha.set(node.id, leave * (a.alpha.get(node.id) ?? 1));
  }
  return { nodes: out, alpha };
}

/** The real renderer's visible set with frame opacities applied (a node fades with its subtree). */
export function applyAlpha(set: VisibleSet, frame: Frame): void {
  const own = new Float64Array(set.items.length);
  set.items.forEach((item, index) => {
    const a = frame.alpha.get(item.node.id) ?? 1;
    own[index] = (item.parent >= 0 ? own[item.parent]! : 1) * a;
    item.alpha *= own[index]!;
  });
}

// Canvas loop and camera ------------------------------------------------------------------

export interface CanvasApi { ctx: CanvasRenderingContext2D; viewport: Viewport; dpr: number; time: number }
/** A full-size canvas redrawn every animation frame, with wheel zoom and drag pan on `camera`. */
export function useCanvas(draw: (api: CanvasApi) => void, camera?: { current: Camera }, onUserCamera?: () => void) {
  const ref = useRef<HTMLCanvasElement>(null);
  const drawRef = useRef(draw);
  drawRef.current = draw;
  // A ref, not an effect dependency: an inline callback changes every render, and
  // re-running the effect resized (cleared) the canvas on every render (flicker).
  const userRef = useRef(onUserCamera);
  userRef.current = onUserCamera;
  useEffect(() => {
    const canvas = ref.current!;
    const ctx = canvas.getContext('2d')!;
    let raf = 0, viewport: Viewport = { width: 1, height: 1 }, dpr = 1;
    const resize = () => {
      dpr = window.devicePixelRatio || 1;
      const box = canvas.getBoundingClientRect();
      viewport = { width: box.width, height: box.height };
      const width = Math.round(box.width * dpr), height = Math.round(box.height * dpr);
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
    };
    resize();
    const observer = new ResizeObserver(resize); observer.observe(canvas);
    const loop = (time: number) => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawRef.current({ ctx, viewport, dpr, time });
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    let drag: { x: number; y: number } | undefined;
    const down = (event: PointerEvent) => { if (!camera) return; drag = { x: event.clientX, y: event.clientY }; canvas.setPointerCapture(event.pointerId); };
    const move = (event: PointerEvent) => {
      if (!drag || !camera) return;
      camera.current = panBy(camera.current, event.clientX - drag.x, event.clientY - drag.y);
      drag = { x: event.clientX, y: event.clientY }; userRef.current?.();
    };
    const up = () => { drag = undefined; };
    const wheel = (event: WheelEvent) => {
      if (!camera) return;
      event.preventDefault();
      const box = canvas.getBoundingClientRect();
      camera.current = zoomAround(camera.current, viewport, event.clientX - box.left, event.clientY - box.top, Math.exp(-event.deltaY * 0.0015), LIMITS);
      userRef.current?.();
    };
    canvas.addEventListener('pointerdown', down); canvas.addEventListener('pointermove', move); canvas.addEventListener('pointerup', up);
    canvas.addEventListener('wheel', wheel, { passive: false });
    return () => { cancelAnimationFrame(raf); observer.disconnect(); canvas.removeEventListener('pointerdown', down); canvas.removeEventListener('pointermove', move); canvas.removeEventListener('pointerup', up); canvas.removeEventListener('wheel', wheel); };
  }, [camera]);
  return ref;
}

/** Every container of a frame (to open whatever their size on screen). */
export function containersOf(nodes: N[]): Set<string> {
  const parents = new Set<string>();
  for (const node of nodes) if (node.spatialParentId) parents.add(node.spatialParentId);
  return parents;
}
export { nodeHeight };

// Small drawing helpers ------------------------------------------------------------------

export const FONT = 'Nunito Variable, system-ui, sans-serif';
export function pill(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, options: { color?: string; fill?: string; text?: string; size?: number; alpha?: number; align?: 'center' | 'left' } = {}): { w: number; h: number } {
  const size = options.size ?? 11;
  ctx.save();
  ctx.globalAlpha = options.alpha ?? 1;
  ctx.font = `700 ${size}px ${FONT}`;
  const w = ctx.measureText(text).width + size * 1.1, h = size + 9;
  const x0 = options.align === 'left' ? x : x - w / 2;
  ctx.fillStyle = options.fill ?? 'rgba(10,12,22,0.86)'; ctx.strokeStyle = options.color ?? 'rgba(255,255,255,0.25)'; ctx.lineWidth = 1.4;
  ctx.beginPath(); ctx.roundRect(x0, y - h / 2, w, h, h / 2); ctx.fill(); ctx.stroke();
  ctx.fillStyle = options.text ?? '#f4f1ea'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, x0 + w / 2, y + 0.5);
  ctx.restore();
  return { w, h };
}
