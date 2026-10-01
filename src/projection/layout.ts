// Deterministic hierarchical rectangle layout. Pure: no SQLite, no rendering.
//
// Sizes are computed bottom-up from bucketed weights, then children are packed
// in *slot order* with a skyline packer. Slot order comes from persisted state
// when available, so that coordinates only move locally when children are
// added (appended to the end of their container) or removed (left as holes).
// New slots are seeded largest-first for dense packing, or in the caller's
// default order where it carries meaning (symbols in source order). World units
// are integers so repeated runs produce bit-identical coordinates.

export const LAYOUT_VERSION = 2;

export interface Rect { x: number; y: number; w: number; h: number }
export interface LayoutNode {
  id: string;
  /** Spatial children in default (first-layout) order. */
  children: string[];
  /** Size weight for leaves and the minimum footprint for containers (e.g. lines). Undefined = minimal footprint. */
  weight?: number;
  /** Inner padding and gap scale; larger for coarse areas. */
  padding: number;
  /** Keep default order for new slots (e.g. symbols in source order) instead of largest-first. */
  preserveOrder?: boolean;
}
/** Persisted slot order: per container, [childId, w, h, removed?]. Removed slots are holes that keep later siblings in place. */
export type SlotEntry = [id: string, w: number, h: number] | [id: string, w: number, h: number, removed: 1];
export interface LayoutState { version: number; containers: Record<string, SlotEntry[]> }
export interface LayoutResult { rects: Map<string, Rect>; state: LayoutState; holes: number }

/** Containers whose holes exceed this fraction of slot area are compacted (holes dropped, order kept). */
export const HOLE_COMPACTION_RATIO = 0.3;
/** Above this many children the O(n²) skyline packer falls back to linear shelf packing. */
export const SKYLINE_LIMIT = 400;
/** Geometric step between candidate row widths, and the number of steps tried. */
const CANDIDATE_STEP = 1.1;
const CANDIDATE_COUNT = 12;

/** Leaf footprint side: area roughly proportional to weight, bucketed by powers of two so small edits do not move the map. */
export function leafSide(weight: number | undefined): number {
  const bucket = Math.min(16, Math.max(0, Math.floor(Math.log2(Math.max(1, weight ?? 1)))));
  return Math.round(8 * Math.SQRT2 ** bucket);
}
/** Round a target width up to a geometric step so container widths change only when content grows substantially. */
export function quantizeWidth(value: number, step = CANDIDATE_STEP): number {
  if (value <= 8) return 8;
  return Math.ceil(8 * step ** Math.ceil(Math.log(value / 8) / Math.log(step) - 1e-9));
}
interface Box { w: number; h: number }
export interface Packing { positions: { x: number; y: number }[]; width: number; height: number }
/** Area-based score with a penalty for elongated containers. Lower is better. */
function score(width: number, height: number): number {
  const aspect = Math.max(width, height) / Math.max(1, Math.min(width, height));
  return width * height * (1 + 0.3 * (aspect - 1));
}
/** Pack boxes in the given order. Deterministic: lowest position wins, ties go left; the best-scoring candidate width wins. */
export function pack(items: Box[], gap: number): Packing {
  if (!items.length) return { positions: [], width: 0, height: 0 };
  let area = 0, maxWidth = 0;
  for (const item of items) { area += (item.w + gap) * (item.h + gap); maxWidth = Math.max(maxWidth, item.w + gap); }
  // Candidate row widths: geometric steps from below sqrt(area), plus exact side-by-side
  // fits of the largest items so big areas can sit next to each other.
  const candidates = new Set<number>();
  let width = Math.max(maxWidth, quantizeWidth(Math.sqrt(area) * 0.75));
  for (let i = 0; i < CANDIDATE_COUNT; i++) { candidates.add(width); width = Math.max(width + 1, quantizeWidth(width * CANDIDATE_STEP)); }
  const widest = [...items].map(item => item.w + gap).sort((a, b) => b - a);
  for (let n = 2, sum = widest[0]!; n <= Math.min(4, widest.length); n++) { sum += widest[n - 1]!; if (sum <= Math.sqrt(area) * 3) candidates.add(sum); }
  let best: Packing | undefined, bestScore = Infinity;
  for (const candidate of [...candidates].sort((a, b) => a - b)) {
    const positions = items.length > SKYLINE_LIMIT ? shelf(items, gap, candidate) : skyline(items, gap, candidate);
    let height = 0;
    for (let i = 0; i < items.length; i++) height = Math.max(height, positions[i]!.y + items[i]!.h);
    const value = score(candidate - gap, height);
    if (value < bestScore) { bestScore = value; best = { positions, width: candidate - gap, height }; }
  }
  return best!;
}
function shelf(items: Box[], gap: number, width: number): { x: number; y: number }[] {
  const positions: { x: number; y: number }[] = [];
  let x = 0, y = 0, row = 0;
  for (const item of items) {
    if (x > 0 && x + item.w + gap > width) { x = 0; y += row; row = 0; }
    positions.push({ x, y });
    x += item.w + gap; row = Math.max(row, item.h + gap);
  }
  return positions;
}
function skyline(items: Box[], gap: number, width: number): { x: number; y: number }[] {
  // Segments partition [0, width) and record the occupied height above each span.
  let segments: { x: number; y: number; w: number }[] = [{ x: 0, y: 0, w: width }];
  const positions: { x: number; y: number }[] = [];
  for (const item of items) {
    const w = item.w + gap, h = item.h + gap;
    let bestX = 0, bestY = Infinity;
    for (let i = 0; i < segments.length; i++) {
      const x = segments[i]!.x;
      if (x + w > width) break;
      let y = 0;
      for (let j = i; j < segments.length && segments[j]!.x < x + w; j++) y = Math.max(y, segments[j]!.y);
      if (y < bestY) { bestY = y; bestX = x; }
    }
    positions.push({ x: bestX, y: bestY });
    const next: { x: number; y: number; w: number }[] = [];
    for (const segment of segments) {
      const end = segment.x + segment.w;
      if (end <= bestX || segment.x >= bestX + w) { next.push(segment); continue; }
      if (segment.x < bestX) next.push({ x: segment.x, y: segment.y, w: bestX - segment.x });
      if (end > bestX + w) next.push({ x: bestX + w, y: segment.y, w: end - bestX - w });
    }
    next.push({ x: bestX, y: bestY + h, w });
    next.sort((a, b) => a.x - b.x);
    // Merge equal-height neighbours to keep the skyline short.
    segments = [];
    for (const segment of next) {
      const last = segments.at(-1);
      if (last && last.y === segment.y && last.x + last.w === segment.x) last.w += segment.w;
      else segments.push({ ...segment });
    }
  }
  return positions;
}
/**
 * Lay out a hierarchy. `nodes` must contain every node reachable from `rootId`.
 * `previous` is the persisted slot state from an earlier layout of the same workspace.
 */
export function layoutHierarchy(nodes: Map<string, LayoutNode>, rootId: string, previous?: LayoutState): LayoutResult {
  const prior = previous?.version === LAYOUT_VERSION ? previous.containers : {};
  const sizes = new Map<string, Box>();
  const local = new Map<string, { x: number; y: number }>();
  const containers: Record<string, SlotEntry[]> = {};
  let holes = 0;
  // Iterative post-order: children sizes are known before their container.
  const order: string[] = [];
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop()!;
    order.push(id);
    const node = nodes.get(id);
    if (!node) throw new Error(`Layout node missing: ${id}`);
    for (const child of node.children) stack.push(child);
  }
  for (let index = order.length - 1; index >= 0; index--) {
    const node = nodes.get(order[index]!)!;
    const minimum = leafSide(node.weight);
    if (!node.children.length) { sizes.set(node.id, { w: minimum, h: minimum }); continue; }
    const present = new Set(node.children);
    const slots: { id: string; w: number; h: number; removed: boolean }[] = [];
    const seen = new Set<string>();
    for (const entry of prior[node.id] ?? []) {
      const [id, w, h] = entry;
      if (seen.has(id)) continue;
      seen.add(id);
      if (present.has(id)) slots.push({ id, ...sizes.get(id)!, removed: false });
      else slots.push({ id, w, h, removed: true });
    }
    // New slots are appended: largest first (dense packing), or in default order when it carries meaning.
    const fresh = node.children.filter(id => !seen.has(id));
    if (!node.preserveOrder) {
      const position = new Map(node.children.map((id, i) => [id, i]));
      fresh.sort((a, b) => { const x = sizes.get(a)!, y = sizes.get(b)!; return y.w * y.h - x.w * x.h || position.get(a)! - position.get(b)!; });
    }
    for (const id of fresh) slots.push({ id, ...sizes.get(id)!, removed: false });
    let holeArea = 0, totalArea = 0;
    for (const slot of slots) { const area = slot.w * slot.h; totalArea += area; if (slot.removed) holeArea += area; }
    const kept = holeArea > totalArea * HOLE_COMPACTION_RATIO ? slots.filter(slot => !slot.removed) : slots;
    const gap = Math.max(2, Math.round(node.padding / 2));
    const packing = pack(kept, gap);
    kept.forEach((slot, i) => { if (!slot.removed) local.set(slot.id, packing.positions[i]!); else holes++; });
    containers[node.id] = kept.map(slot => slot.removed ? [slot.id, slot.w, slot.h, 1] : [slot.id, slot.w, slot.h]);
    sizes.set(node.id, { w: Math.max(minimum, packing.width + node.padding * 2), h: Math.max(minimum, packing.height + node.padding * 2) });
  }
  const rects = new Map<string, Rect>();
  const root = sizes.get(rootId)!;
  rects.set(rootId, { x: 0, y: 0, w: root.w, h: root.h });
  for (const id of order) {
    const node = nodes.get(id)!, rect = rects.get(id)!;
    for (const child of node.children) {
      const position = local.get(child)!, size = sizes.get(child)!;
      rects.set(child, { x: rect.x + node.padding + position.x, y: rect.y + node.padding + position.y, w: size.w, h: size.h });
    }
  }
  return { rects, state: { version: LAYOUT_VERSION, containers }, holes };
}
