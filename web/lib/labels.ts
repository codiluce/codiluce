// Labels that never overlap. Each label goes where it fits: inside what it
// names when there is room, otherwise beside it, then further out with a
// leader line, trying eight directions at growing distances. A spot is taken
// only when it is free of the labels already placed, of their leader lines,
// of the panels over the map and of everything else being labeled, and when
// its own leader crosses no label; what it covers of the map only costs. Labels that find no
// spot near what they name are stacked in a column at the side of the view,
// in the order of what they name from top to bottom, each with its leader.
// What does not fit there either is left out (and counted). A label keeps the
// spot it had while that spot stays free, so labels do not jump as others
// appear. Pure geometry: the map and the tools draw what it decides.

export interface Box { x0: number; y0: number; x1: number; y1: number }
export interface LabelAsk {
  key: string;
  /** What the label names, on screen. */
  target: Box;
  w: number; h: number;
  /** May sit inside the target when it fits there. */
  inside?: boolean;
}
export interface Placed {
  key: string; box: Box;
  /** From the target's edge to the label's, when the label is not touching what it names. */
  leader?: { from: { x: number; y: number }; to: { x: number; y: number } };
  inside: boolean;
}
export interface PlaceOptions {
  /** Where labels may go (the view, less its margins). */
  bounds: Box;
  /** Never covered: panels over the map, labels drawn before. */
  avoid?: readonly Box[];
  /** Covered at a cost: blocks, lines. */
  soft?: readonly Box[];
  /** Slots chosen on the previous frame, by key (kept while free); updated in place. */
  memory?: Map<string, string>;
  /** Distances tried from the target (CSS px). */
  distances?: readonly number[];
  /** Preferred directions first (default: right, left, above, below, then the diagonals). */
  directions?: readonly Direction[];
  /** Stack what finds no spot in a column at the side (default true). */
  columns?: boolean;
  /** Space kept between labels. */
  gap?: number;
  /** Labels never cover another ask's target (default true). */
  clearTargets?: boolean;
}
export type Direction = 'e' | 'w' | 'n' | 's' | 'ne' | 'se' | 'nw' | 'sw';
const DIRECTIONS: Direction[] = ['e', 'w', 'n', 's', 'ne', 'se', 'nw', 'sw'];
const DISTANCES = [3, 16, 34, 58, 92, 136];

export function overlaps(a: Box, b: Box, gap = 0): boolean { return a.x0 < b.x1 + gap && a.x1 > b.x0 - gap && a.y0 < b.y1 + gap && a.y1 > b.y0 - gap; }
function area(a: Box, b: Box): number { return Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0)); }
function within(box: Box, bounds: Box): boolean { return box.x0 >= bounds.x0 && box.y0 >= bounds.y0 && box.x1 <= bounds.x1 && box.y1 <= bounds.y1; }
/** Whether a segment crosses a box (Liang–Barsky clipping). */
export function crosses(a: { x: number; y: number }, b: { x: number; y: number }, box: Box): boolean {
  let t0 = 0, t1 = 1;
  const dx = b.x - a.x, dy = b.y - a.y;
  for (const [p, q] of [[-dx, a.x - box.x0], [dx, box.x1 - a.x], [-dy, a.y - box.y0], [dy, box.y1 - a.y]] as const) {
    if (p === 0) { if (q < 0) return false; continue; }
    const r = q / p;
    if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; } else { if (r < t0) return false; if (r < t1) t1 = r; }
  }
  return t0 < t1;
}

/** Where a label in `direction` at `distance` from the target goes. */
function slotBox(target: Box, w: number, h: number, direction: Direction, distance: number): Box {
  const cx = (target.x0 + target.x1) / 2, cy = (target.y0 + target.y1) / 2;
  const diagonal = distance * 0.72;
  let x0: number, y0: number;
  switch (direction) {
    case 'e': x0 = target.x1 + distance; y0 = cy - h / 2; break;
    case 'w': x0 = target.x0 - distance - w; y0 = cy - h / 2; break;
    case 'n': x0 = cx - w / 2; y0 = target.y0 - distance - h; break;
    case 's': x0 = cx - w / 2; y0 = target.y1 + distance; break;
    case 'ne': x0 = target.x1 + diagonal; y0 = target.y0 - diagonal - h; break;
    case 'se': x0 = target.x1 + diagonal; y0 = target.y1 + diagonal; break;
    case 'nw': x0 = target.x0 - diagonal - w; y0 = target.y0 - diagonal - h; break;
    default: x0 = target.x0 - diagonal - w; y0 = target.y1 + diagonal; break;
  }
  return { x0, y0, x1: x0 + w, y1: y0 + h };
}
/** The nearest point of a box to a point. */
function nearest(box: Box, x: number, y: number): { x: number; y: number } { return { x: Math.max(box.x0, Math.min(box.x1, x)), y: Math.max(box.y0, Math.min(box.y1, y)) }; }
/** A leader from the target to the label, unless they touch. */
function leaderOf(target: Box, box: Box): Placed['leader'] {
  const at = nearest(box, (target.x0 + target.x1) / 2, (target.y0 + target.y1) / 2);
  const from = nearest(target, at.x, at.y);
  return Math.hypot(at.x - from.x, at.y - from.y) > 5 ? { from, to: at } : undefined;
}

/** Places labels in order (the first are placed first and keep the best spots). */
export function placeLabels(asks: readonly LabelAsk[], options: PlaceOptions): { placed: Placed[]; left: LabelAsk[] } {
  const gap = options.gap ?? 3;
  const bounds = options.bounds, avoid = options.avoid ?? [], soft = options.soft ?? [];
  const distances = options.distances ?? DISTANCES, directions = options.directions ?? DIRECTIONS;
  const placed: Placed[] = [];
  const left: LabelAsk[] = [];
  const targets = options.clearTargets === false ? [] : asks.map(ask => ({ key: ask.key, box: ask.target }));
  const free = (box: Box) => within(box, bounds) && !placed.some(other => overlaps(box, other.box, gap)) && !avoid.some(other => overlaps(box, other));
  /** Free, off every leader and every other target, and reached by a leader that crosses no label. */
  const clear = (key: string, box: Box, leader: Placed['leader']) => free(box)
    && !placed.some(other => other.leader && crosses(other.leader.from, other.leader.to, box))
    && !targets.some(other => other.key !== key && overlaps(box, other.box))
    && !(leader && placed.some(other => crosses(leader.from, leader.to, other.box)));
  const seen = new Set<string>();
  for (const ask of asks) {
    seen.add(ask.key);
    const target = ask.target;
    const fits = ask.inside && target.x1 - target.x0 >= ask.w + 4 && target.y1 - target.y0 >= ask.h + 4;
    const candidates: { slot: string; box: Box; cost: number }[] = [];
    if (fits) {
      const cx = (target.x0 + target.x1) / 2, cy = (target.y0 + target.y1) / 2;
      candidates.push({ slot: 'in', box: { x0: cx - ask.w / 2, y0: cy - ask.h / 2, x1: cx + ask.w / 2, y1: cy + ask.h / 2 }, cost: 0 });
    }
    distances.forEach((distance, ring) => directions.forEach((direction, turn) => {
      const box = slotBox(target, ask.w, ask.h, direction, distance);
      candidates.push({ slot: `${direction}${ring}`, box, cost: 1 + ring * 4 + turn * 0.35 });
    }));
    const remembered = options.memory?.get(ask.key);
    let best: { slot: string; box: Box; cost: number } | undefined;
    for (const candidate of candidates) {
      if (!clear(ask.key, candidate.box, candidate.slot === 'in' ? undefined : leaderOf(target, candidate.box))) continue;
      // Covering the map costs a little (more for what a tool is about); a remembered slot costs nothing extra to keep.
      let cost = candidate.cost;
      const size = ask.w * ask.h;
      for (const other of soft) if (other !== target) cost += 2.5 * area(candidate.box, other) / size;
      if (candidate.slot === remembered) cost -= 6;
      if (!best || cost < best.cost) best = { ...candidate, cost };
    }
    if (!best) { left.push(ask); continue; }
    options.memory?.set(ask.key, best.slot);
    placed.push({ key: ask.key, box: best.box, inside: best.slot === 'in', ...(best.slot === 'in' ? {} : { leader: leaderOf(target, best.box) }) });
  }
  if (options.columns === false || !left.length) { forget(options.memory, seen); return { placed, left }; }
  // A column on each side; each label goes to the side nearer what it names, stacked top to bottom.
  const rest: LabelAsk[] = [];
  const middle = (bounds.x0 + bounds.x1) / 2;
  for (const side of ['w', 'e'] as const) {
    const mine = left.filter(ask => ((ask.target.x0 + ask.target.x1) / 2 < middle) === (side === 'w')).sort((a, b) => a.target.y0 + a.target.y1 - (b.target.y0 + b.target.y1));
    let cursor = bounds.y0;
    for (const ask of mine) {
      const want = Math.max(cursor, (ask.target.y0 + ask.target.y1) / 2 - ask.h / 2);
      const x0 = side === 'w' ? bounds.x0 : bounds.x1 - ask.w;
      let box: Box | undefined;
      // Slide down past what is in the way.
      for (let y = want; y + ask.h <= bounds.y1; y += 4) {
        const candidate = { x0, y0: y, x1: x0 + ask.w, y1: y + ask.h };
        if (free(candidate) && !overlaps(candidate, ask.target)) { box = candidate; break; }
      }
      if (!box) { rest.push(ask); continue; }
      cursor = box.y1 + gap;
      options.memory?.delete(ask.key);
      placed.push({ key: ask.key, box, inside: false, leader: leaderOf(ask.target, box) });
    }
  }
  forget(options.memory, seen);
  return { placed, left: rest };
}
/** Drop remembered slots of labels no longer asked for. */
function forget(memory: Map<string, string> | undefined, seen: Set<string>): void {
  if (memory) for (const key of memory.keys()) if (!seen.has(key)) memory.delete(key);
}
