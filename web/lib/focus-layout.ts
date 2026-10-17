// The focus layout: only what a tool shows (its *interest set*) and the areas
// holding it, packed again by the map's own packer in the map's reading
// order, so things far apart on the map end up close together at a size that
// reads. The siblings outside the set fold into one `+N` tile per area, and
// single-child chains of folders merge into one area. Going from the map to
// it is a morph in world units: shared blocks slide, the rest fade.
// Pure (no DOM): the Focus and Commit beat tools use it, tests run it.
import type { NodeSummary, Rect } from '@engine/projection/dto';
// Relative: this module also runs under Node (web/tests), where @engine is for types only.
import { layoutHierarchy, type LayoutNode } from '../../src/projection/layout';
import { Scene, type VisibleSet } from './scene';
import { TILE, type Frame } from './plan';

/** What the layout reads of the map: nodes as the server placed them, and children. */
export interface Hierarchy { rootId: string; node(id: string): NodeSummary | undefined; children(id: string): readonly string[] }
export function sceneHierarchy(scene: Scene): Hierarchy | undefined {
  if (!scene.rootId) return undefined;
  return { rootId: scene.rootId, node: id => scene.placedNode(id) ?? scene.nodes.get(id), children: id => scene.children.get(id)?.ids ?? [] };
}
export function ancestorsOf(hierarchy: Pick<Hierarchy, 'node'>, id: string): string[] {
  const out: string[] = [];
  for (let current = hierarchy.node(id)?.spatialParentId; current; current = hierarchy.node(current)?.spatialParentId) out.unshift(current);
  return out;
}
export function isContainer(node: Pick<NodeSummary, 'type'>): boolean { return node.type === 'repository' || node.type === 'application' || node.type === 'directory' || node.type === 'group'; }

export interface FocusOptions {
  /** Siblings outside the set: one `+N` tile per area, or dropped. */
  fold?: 'tile' | 'drop';
  /** Clamp of a kept file's side (world units), and of a kept symbol's. */
  fileSide?: [number, number];
  symbolSide?: [number, number];
}
export interface Focus {
  /** Nodes of the layout, parents first: real nodes (renamed when merged) and `+N` tiles. */
  nodes: NodeSummary[];
  rects: Map<string, Rect>;
  /** Merged chains: the head → the folders merged into it. */
  merged: Map<string, string[]>;
  /** Tiles: ID → how many things they stand for. */
  tiles: Map<string, number>;
  interest: Set<string>;
  bounds: Rect;
}
/** Paddings by type: wider than the map's, since arrows and labels need streets. */
const PADDING: Record<string, number> = { repository: 30, application: 26, directory: 24, group: 24, file: 8 };
/** The leaf weight whose footprint (`leafSide`) is closest to `side`. */
function weightFor(side: number): number { return 2 ** Math.max(0, Math.min(16, Math.round(2 * Math.log2(Math.max(8, side) / 8)))); }

/**
 * Only the cut, packed by the map's packer: the interest set and its
 * ancestors (open), the other children of each open area folded into a `+N`
 * tile (or dropped), single-child chains of folders merged, files at their
 * real size, clamped. Placed around the middle of where the set is on the map.
 */
export function focusLayout(hierarchy: Hierarchy, interestIds: readonly string[], options: FocusOptions = {}): Focus | undefined {
  const fileSide = options.fileSide ?? [56, 120], symbolSide = options.symbolSide ?? [34, 64], fold = options.fold ?? 'tile';
  const interest = new Set(interestIds.filter(id => hierarchy.node(id)));
  if (!interest.size) return undefined;
  const node = (id: string) => hierarchy.node(id)!;
  const keep = new Set<string>();
  for (const id of interest) { keep.add(id); for (const ancestor of ancestorsOf(hierarchy, id)) keep.add(ancestor); }
  keep.add(hierarchy.rootId);
  const reading = (ids: string[]) => [...ids].sort((a, b) => { const x = node(a).rect, y = node(b).rect; return (x.y + x.x * 0.35) - (y.y + y.x * 0.35); });
  const children = new Map<string, string[]>();
  const tiles = new Map<string, number>();
  for (const id of keep) {
    const all = hierarchy.children(id).filter(child => hierarchy.node(child));
    const kept = all.filter(child => keep.has(child));
    if (!kept.length && interest.has(id)) continue; // a leaf of the set: a file, or an area shown closed
    children.set(id, reading(kept));
    const others = all.filter(child => !keep.has(child));
    // Children not loaded count too: the area's own total.
    const unloaded = Math.max(0, node(id).childCount - all.length);
    if ((others.length || unloaded) && fold === 'tile') {
      const own = node(id);
      const count = own.type === 'file' ? others.length + unloaded : others.reduce((sum, child) => { const other = node(child); return sum + (other.type === 'file' ? 1 : Math.max(1, other.stats?.files ?? 1)); }, 0) + unloaded;
      const tile = `${TILE}${id}`;
      tiles.set(tile, count);
      children.get(id)!.push(tile);
    }
  }
  // Merge single-child chains of folders.
  const merged = new Map<string, string[]>();
  const names = new Map<string, string>();
  const parentOf = new Map<string, string>();
  const walk = (id: string) => {
    let list = children.get(id);
    if (!list) return;
    const own = node(id);
    if (own.type === 'directory' || own.type === 'group') {
      while (list.length === 1 && !list[0]!.startsWith(TILE)) {
        const only = node(list[0]!);
        if (!(only.type === 'directory' || only.type === 'group') || !children.has(only.id) || interest.has(only.id)) break;
        merged.set(id, [...merged.get(id) ?? [], only.id]);
        names.set(id, `${names.get(id) ?? own.name}/${only.name}`);
        list = children.get(only.id)!;
        children.set(id, list);
        children.delete(only.id);
      }
    }
    for (const child of list) { parentOf.set(child, id); walk(child); }
  };
  walk(hierarchy.rootId);
  const layout = new Map<string, LayoutNode>();
  const add = (id: string) => {
    if (id.startsWith(TILE)) {
      const count = tiles.get(id)!;
      layout.set(id, { id, children: [], weight: weightFor(Math.min(64, 30 + 7 * Math.log2(1 + count))), padding: 3 });
      return;
    }
    const own = node(id);
    const list = children.get(id);
    if (list) { layout.set(id, { id, children: list, padding: PADDING[own.type] ?? 8, preserveOrder: true }); list.forEach(add); return; }
    const symbol = !isContainer(own) && own.type !== 'file';
    const [min, max] = symbol ? symbolSide : fileSide;
    const real = Math.sqrt(own.rect.w * own.rect.h);
    layout.set(id, { id, children: [], weight: weightFor(Math.max(min, Math.min(max, real))), padding: 3 });
  };
  add(hierarchy.rootId);
  const result = layoutHierarchy(layout, hierarchy.rootId, undefined, { compact: true });
  const real = rectBounds([...interest].map(id => node(id).rect));
  const own = result.rects.get(hierarchy.rootId)!;
  const dx = real.x + real.w / 2 - own.w / 2, dy = real.y + real.h / 2 - own.h / 2;
  const rects = new Map<string, Rect>();
  for (const [id, rect] of result.rects) rects.set(id, { x: rect.x + dx, y: rect.y + dy, w: rect.w, h: rect.h });
  const nodes: NodeSummary[] = [];
  const emit = (id: string) => {
    const rect = rects.get(id)!;
    if (id.startsWith(TILE)) {
      const count = tiles.get(id)!, owner = node(id.slice(TILE.length));
      nodes.push({ id, kind: 'group', type: 'group', name: `+${count} ${owner.type === 'file' ? 'symbols' : `file${count === 1 ? '' : 's'}`}`, detail: 'not in this view', depth: 0, rect, childCount: 0, diagnostics: 0, ...(parentOf.get(id) ? { spatialParentId: parentOf.get(id) } : {}), stats: { files: count, symbols: 0, endpoints: 0, measuredLoc: 0, unmeasuredFiles: 0, descendants: 0 } });
      return;
    }
    const base = node(id);
    const list = children.get(id);
    const parent = parentOf.get(id);
    const { archetypeCounts: _counts, spatialParentId: _parent, ...rest } = base;
    nodes.push({ ...rest, name: names.get(id) ?? base.name, rect, ...(parent ? { spatialParentId: parent } : {}), childCount: list ? list.length : base.type === 'file' ? 0 : base.childCount });
    list?.forEach(emit);
  };
  emit(hierarchy.rootId);
  return { nodes, rects, merged, tiles, interest, bounds: rects.get(hierarchy.rootId)! };
}
export function rectBounds(rects: Rect[]): Rect {
  if (!rects.length) return { x: 0, y: 0, w: 0, h: 0 };
  const minX = Math.min(...rects.map(r => r.x)), minY = Math.min(...rects.map(r => r.y));
  const maxX = Math.max(...rects.map(r => r.x + r.w)), maxY = Math.max(...rects.map(r => r.y + r.h));
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

// Frames and their morph ------------------------------------------------------------------

export const clamp01 = (t: number) => Math.max(0, Math.min(1, t));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
export function lerpRect(a: Rect, b: Rect, t: number): Rect { return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), w: lerp(a.w, b.w, t), h: lerp(a.h, b.h, t) }; }
/** Every node of a hierarchy, parents first, as the server placed them. */
export function mapFrame(hierarchy: Hierarchy): Frame {
  const nodes: NodeSummary[] = [];
  const queue = [hierarchy.rootId];
  for (let i = 0; i < queue.length; i++) {
    const own = hierarchy.node(queue[i]!);
    if (!own) continue;
    nodes.push(own);
    for (const child of hierarchy.children(own.id)) queue.push(child);
  }
  return { nodes, alpha: new Map() };
}
export function focusFrame(focus: Focus): Frame { return { nodes: focus.nodes, alpha: new Map() }; }
/**
 * Between two frames: shared nodes slide (rect interpolated, the target's
 * parent and name), nodes only in `a` fade out early where they were, nodes
 * only in `b` fade in late where they go.
 */
export function morph(a: Frame, b: Frame, t: number): Frame {
  const inA = new Map(a.nodes.map(node => [node.id, node]));
  const inB = new Set(b.nodes.map(node => node.id));
  const out: NodeSummary[] = [], alpha = new Map<string, number>();
  const leave = 1 - clamp01(t / 0.35), arrive = clamp01((t - 0.55) / 0.45), slide = ease(clamp01((t - 0.1) / 0.85));
  for (const node of b.nodes) {
    const from = inA.get(node.id);
    if (from) { out.push({ ...node, rect: lerpRect(from.rect, node.rect, slide) }); alpha.set(node.id, lerp(a.alpha.get(node.id) ?? 1, b.alpha.get(node.id) ?? 1, slide)); }
    else { out.push(node); alpha.set(node.id, arrive * (b.alpha.get(node.id) ?? 1)); }
  }
  for (const node of a.nodes) {
    if (inB.has(node.id)) continue;
    out.push(node); alpha.set(node.id, leave * (a.alpha.get(node.id) ?? 1));
  }
  return { nodes: out, alpha };
}
/** A scene for the map's renderer from a frame's nodes (any order: built breadth first from the root). */
export function sceneOf(nodes: NodeSummary[], rootId: string, streets = true): Scene {
  const scene = new Scene();
  scene.setStreets(streets);
  const root = nodes.find(node => node.id === rootId) ?? nodes[0];
  if (!root) return scene;
  scene.reset(root);
  const kids = new Map<string, NodeSummary[]>();
  for (const node of nodes) {
    if (node.id === root.id || !node.spatialParentId) continue;
    const list = kids.get(node.spatialParentId) ?? [];
    list.push(node); kids.set(node.spatialParentId, list);
  }
  const queue = [root.id];
  for (let i = 0; i < queue.length; i++) {
    const list = kids.get(queue[i]!);
    if (!list) continue;
    scene.addChildren(queue[i]!, list, list.length, false);
    for (const child of list) queue.push(child.id);
  }
  return scene;
}
/** Every area of a frame (to open them whatever their size on screen). */
export function containersOf(nodes: NodeSummary[]): Set<string> {
  const parents = new Set<string>();
  for (const node of nodes) if (node.spatialParentId) parents.add(node.spatialParentId);
  return parents;
}
/** The renderer's visible set with a frame's opacities applied (a node fades with its subtree). */
export function applyAlpha(set: VisibleSet, frame: Frame): void {
  const own = new Float64Array(set.items.length);
  set.items.forEach((item, index) => {
    const a = frame.alpha.get(item.node.id) ?? 1;
    own[index] = (item.parent >= 0 ? own[item.parent]! : 1) * a;
    item.alpha *= own[index]!;
  });
}
