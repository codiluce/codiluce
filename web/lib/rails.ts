// Rails: links drawn along the floors of the map at right angles, the way
// streets run between blocks. A rail leaves its block from the side facing
// where it goes and keeps to the streets between the blocks standing on that
// floor (around them, never across them). To leave an area it runs to the
// area's edge and down its wall to the floor below, area after area, until it
// reaches the floor it shares with the other end; there it runs to the area
// holding that end and climbs in the same way. The outer street of a floor
// (along its edge, outside every block) is preferred to the inner ones.
// Pure: routes are in world units, independent of the camera.

export interface RailRect { x: number; y: number; w: number; h: number }
export interface RailPoint { x: number; y: number; z: number }
/**
 * A rail: points in world units and, for each segment (points i → i+1), the
 * block it is drawn with in the painter's order: the area whose floor it runs
 * on, or for a drop down a wall, the block itself when that wall faces the
 * viewer (otherwise the floor below, so the block hides it).
 */
export interface Rail { points: RailPoint[]; hosts: string[] }
/** What the router reads of the map: blocks by ID, their spatial parents and children, and floor heights. */
export interface RailWorld {
  rect(id: string): RailRect | undefined;
  parent(id: string): string | undefined;
  children(id: string): string[];
  /** Elevation of the block's top: the floor its children stand on. */
  top(id: string): number;
}
interface P { x: number; y: number }
/** Directions on the floor: east (+x), west (−x), south (+y), north (−y). */
type Dir = 0 | 1 | 2 | 3;
const STEP: Record<Dir, P> = { 0: { x: 1, y: 0 }, 1: { x: -1, y: 0 }, 2: { x: 0, y: 1 }, 3: { x: 0, y: -1 } };
const OPPOSITE: Record<Dir, Dir> = { 0: 1, 1: 0, 2: 3, 3: 2 };
/** The walls facing the viewer: east (x + w) and south (y + h). */
const FRONT = new Set<Dir>([0, 2]);
/** Street routing gives up past this many crossings on one floor (the rail then falls back to an arc). */
const GRID_LIMIT = 260_000;
/** The outer street costs this much per unit, the inner ones 1: rails go round the outside when it is not much longer. */
const OUTER_COST = 0.9;

/** The side of a block a straight line from its center toward `toward` leaves through. */
export function facing(rect: RailRect, toward: P): Dir {
  const dx = (toward.x - (rect.x + rect.w / 2)) / Math.max(rect.w, 1e-9), dy = (toward.y - (rect.y + rect.h / 2)) / Math.max(rect.h, 1e-9);
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 0 : 1;
  return dy >= 0 ? 2 : 3;
}
/** Whether a point lies past a side of a block (east of its east side, and so on). */
function beyond(rect: RailRect, side: Dir, point: P): boolean {
  switch (side) {
    case 0: return point.x >= rect.x + rect.w;
    case 1: return point.x <= rect.x;
    case 2: return point.y >= rect.y + rect.h;
    case 3: return point.y <= rect.y;
  }
}
/** A point on a side of a block: at `along` (clamped `inset` from the corners), or its middle. */
function onSide(rect: RailRect, side: Dir, along?: P, inset = 0): P {
  const clampX = (x: number) => Math.min(rect.x + rect.w - inset, Math.max(rect.x + inset, x));
  const clampY = (y: number) => Math.min(rect.y + rect.h - inset, Math.max(rect.y + inset, y));
  const midX = rect.x + rect.w / 2, midY = rect.y + rect.h / 2;
  const x = along && inset * 2 < rect.w ? clampX(along.x) : midX, y = along && inset * 2 < rect.h ? clampY(along.y) : midY;
  switch (side) {
    case 0: return { x: rect.x + rect.w, y };
    case 1: return { x: rect.x, y };
    case 2: return { x, y: rect.y + rect.h };
    case 3: return { x, y: rect.y };
  }
}
const away = (point: P, side: Dir, distance: number): P => ({ x: point.x + STEP[side].x * distance, y: point.y + STEP[side].y * distance });

/**
 * The streets of a floor: the padding between its edge and the blocks on it,
 * and the gap between those blocks (the layout packs them `max(2, padding/2)`
 * apart). `margin` is half a gap: a rail that far from a block runs down the
 * middle of the narrowest street; `band` is the middle of the outer street.
 */
export function streetsOf(rect: RailRect, blocks: RailRect[]): { margin: number; band: number; inner?: RailRect } {
  if (!blocks.length) return { margin: Math.max(0.5, Math.min(rect.w, rect.h) * 0.04), band: Math.min(rect.w, rect.h) * 0.08 };
  let padding = Infinity;
  const inner = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const block of blocks) {
    padding = Math.min(padding, block.x - rect.x, block.y - rect.y);
    inner.minX = Math.min(inner.minX, block.x); inner.minY = Math.min(inner.minY, block.y);
    inner.maxX = Math.max(inner.maxX, block.x + block.w); inner.maxY = Math.max(inner.maxY, block.y + block.h);
  }
  padding = Math.max(1, padding);
  const gap = Math.max(2, Math.round(padding / 2));
  return { margin: gap / 2, band: padding / 2, inner: { x: inner.minX, y: inner.minY, w: inner.maxX - inner.minX, h: inner.maxY - inner.minY } };
}

/**
 * The street route on one floor from `from` to `to`, at right angles, never
 * through a block: a shortest path over the lines `margin` around each block
 * (and the middle of the outer street), with a cost for each turn, the outer
 * street cheaper than the inner ones. `start` is the way the rail is already
 * heading, `end` the way it must arrive. Searches near the two ends first,
 * then wider. Undefined when no street leads there.
 */
export function streetRoute(bounds: RailRect, blocks: RailRect[], from: P, to: P, options: { margin: number; band: number; inner?: RailRect; start?: Dir; end?: Dir }): P[] | undefined {
  const span = Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y));
  let reach = Math.max(options.margin * 6, span * 0.35, options.band * 2);
  for (;;) {
    const area = {
      minX: Math.max(bounds.x, Math.min(from.x, to.x) - reach), maxX: Math.min(bounds.x + bounds.w, Math.max(from.x, to.x) + reach),
      minY: Math.max(bounds.y, Math.min(from.y, to.y) - reach), maxY: Math.min(bounds.y + bounds.h, Math.max(from.y, to.y) + reach),
    };
    const whole = area.minX <= bounds.x && area.minY <= bounds.y && area.maxX >= bounds.x + bounds.w && area.maxY >= bounds.y + bounds.h;
    const found = search(bounds, area, blocks, from, to, options);
    if (Array.isArray(found)) return found;
    if (whole || found === 'too large') return undefined;
    reach *= 2.5;
  }
}
/** One search inside `area`: the route, or why there is none. */
function search(bounds: RailRect, area: { minX: number; minY: number; maxX: number; maxY: number }, all: RailRect[], from: P, to: P, options: { margin: number; band: number; inner?: RailRect; start?: Dir; end?: Dir }): P[] | 'no street' | 'too large' {
  const m = options.margin, eps = 1e-6;
  const blocks = all.filter(block => block.x < area.maxX && block.x + block.w > area.minX && block.y < area.maxY && block.y + block.h > area.minY);
  const within = (value: number, min: number, max: number) => value >= min - eps && value <= max + eps;
  const lines = (values: number[], min: number, max: number) => [...new Set(values.filter(value => within(value, min, max)).map(value => Math.round(value * 1e4) / 1e4))].sort((a, b) => a - b);
  const xs = lines([from.x, to.x, bounds.x + options.band, bounds.x + bounds.w - options.band, ...blocks.flatMap(block => [block.x - m, block.x + block.w + m])], area.minX, area.maxX);
  const ys = lines([from.y, to.y, bounds.y + options.band, bounds.y + bounds.h - options.band, ...blocks.flatMap(block => [block.y - m, block.y + block.h + m])], area.minY, area.maxY);
  const nx = xs.length, ny = ys.length;
  if (nx * ny > GRID_LIMIT) return 'too large';
  const index = (values: number[], value: number) => { const rounded = Math.round(value * 1e4) / 1e4; let low = 0, high = values.length - 1; while (low < high) { const mid = (low + high) >> 1; if (values[mid]! < rounded) low = mid + 1; else high = mid; } return low; };
  const start = index(ys, from.y) * nx + index(xs, from.x), goal = index(ys, to.y) * nx + index(xs, to.x);
  if (start === goal) return [from, to];
  // Segments between neighbouring crossings that pass through a block are closed.
  const closedX = new Uint8Array(nx * ny), closedY = new Uint8Array(nx * ny);
  const first = (values: number[], value: number) => { let low = 0, high = values.length; while (low < high) { const mid = (low + high) >> 1; if (values[mid]! <= value) low = mid + 1; else high = mid; } return low; };
  for (const block of blocks) {
    // Rows strictly inside the block close the eastward segments overlapping it…
    for (let j = first(ys, block.y + eps); j < ny && ys[j]! < block.y + block.h - eps; j++) {
      for (let i = Math.max(0, first(xs, block.x + eps) - 1); i < nx - 1 && xs[i]! < block.x + block.w - eps; i++) if (xs[i + 1]! > block.x + eps) closedX[j * nx + i] = 1;
    }
    // …and columns strictly inside it the southward ones.
    for (let i = first(xs, block.x + eps); i < nx && xs[i]! < block.x + block.w - eps; i++) {
      for (let j = Math.max(0, first(ys, block.y + eps) - 1); j < ny - 1 && ys[j]! < block.y + block.h - eps; j++) if (ys[j + 1]! > block.y + eps) closedY[j * nx + i] = 1;
    }
  }
  const inner = options.inner;
  const outer = (ax: number, ay: number, bx: number, by: number) => !inner || Math.max(ax, bx) <= inner.x + eps || Math.min(ax, bx) >= inner.x + inner.w - eps || Math.max(ay, by) <= inner.y + eps || Math.min(ay, by) >= inner.y + inner.h - eps;
  // Turning costs more on long runs, so a rail does not weave between blocks to save a little.
  const turn = Math.max(m * 4, options.band * 1.5, (Math.abs(to.x - from.x) + Math.abs(to.y - from.y)) * 0.08);
  const total = nx * ny * 4;
  const cost = new Float64Array(total).fill(Infinity), back = new Int32Array(total).fill(-1), done = new Uint8Array(total);
  const heap = new Heap();
  const gx = xs[goal % nx]!, gy = ys[Math.floor(goal / nx)]!;
  const estimate = (node: number) => (Math.abs(xs[node % nx]! - gx) + Math.abs(ys[Math.floor(node / nx)]! - gy)) * OUTER_COST;
  for (const dir of options.start !== undefined ? [options.start] : [0, 1, 2, 3] as Dir[]) { const state = start * 4 + dir; cost[state] = 0; heap.push(state, estimate(start)); }
  let reached = -1;
  while (heap.size) {
    const state = heap.pop();
    if (done[state]) continue;
    done[state] = 1;
    const node = state >> 2, dir = (state & 3) as Dir;
    if (node === goal) { reached = state; break; }
    const i = node % nx, j = (node - i) / nx;
    for (const next of [0, 1, 2, 3] as Dir[]) {
      if (next === OPPOSITE[dir]) continue;
      let to: number;
      if (next === 0) { if (i >= nx - 1 || closedX[node]) continue; to = node + 1; }
      else if (next === 1) { if (i <= 0 || closedX[node - 1]) continue; to = node - 1; }
      else if (next === 2) { if (j >= ny - 1 || closedY[node]) continue; to = node + nx; }
      else { if (j <= 0 || closedY[node - nx]) continue; to = node - nx; }
      const ti = to % nx, tj = (to - ti) / nx;
      const length = Math.abs(xs[ti]! - xs[i]!) + Math.abs(ys[tj]! - ys[j]!);
      let step = length * (outer(xs[i]!, ys[j]!, xs[ti]!, ys[tj]!) ? OUTER_COST : 1) + (next === dir ? 0 : turn);
      if (to === goal && options.end !== undefined && next !== options.end) step += turn;
      const value = cost[state]! + step, target = to * 4 + next;
      if (value < cost[target]! - 1e-9) { cost[target] = value; back[target] = state; heap.push(target, value + estimate(to)); }
    }
  }
  if (reached < 0) return 'no street';
  const route: P[] = [];
  for (let state = reached; state >= 0; state = back[state]!) { const node = state >> 2; route.push({ x: xs[node % nx]!, y: ys[Math.floor(node / nx)]! }); }
  route.reverse();
  route[0] = from; route[route.length - 1] = to;
  return straighten(route);
}
/** Drop the crossings a rail goes straight through. */
function straighten(points: P[]): P[] {
  const result: P[] = [];
  for (const point of points) {
    const a = result.at(-2), b = result.at(-1);
    if (b && Math.abs(b.x - point.x) < 1e-9 && Math.abs(b.y - point.y) < 1e-9) continue;
    if (a && b && ((Math.abs(a.x - b.x) < 1e-9 && Math.abs(b.x - point.x) < 1e-9) || (Math.abs(a.y - b.y) < 1e-9 && Math.abs(b.y - point.y) < 1e-9))) result[result.length - 1] = point;
    else result.push(point);
  }
  return result;
}

/** One end of a rail, from its block out to the floor it shares with the other end: the points, their hosts, and the way it heads at the end. */
interface Climb { points: RailPoint[]; hosts: string[]; heading: Dir }
/**
 * The rail between two blocks. When one holds the other, the rail runs from
 * the inside of the outer one's edge nearest the inner one (or back to it).
 * Undefined when a block is unknown or no street leads from one to the other
 * (the caller then draws an arc).
 */
export function railRoute(world: RailWorld, fromId: string, toId: string): Rail | undefined {
  const chain = (id: string) => { const ids = [id]; for (let parent = world.parent(id); parent && ids.length < 64; parent = world.parent(parent)) ids.push(parent); return ids; };
  const up = chain(fromId), down = chain(toId);
  const shared = up.find(id => down.includes(id));
  if (!shared || fromId === toId) return undefined;
  if (shared === fromId || shared === toId) return nestedRail(world, shared === fromId ? down : up, shared, shared === fromId);
  const a = world.rect(fromId), b = world.rect(toId), floor = world.rect(shared);
  if (!a || !b || !floor) return undefined;
  const leave = climb(world, up.slice(0, up.indexOf(shared) + 1), { x: b.x + b.w / 2, y: b.y + b.h / 2 });
  const enter = climb(world, down.slice(0, down.indexOf(shared) + 1), { x: a.x + a.w / 2, y: a.y + a.h / 2 });
  if (!leave || !enter) return undefined;
  const z = world.top(shared);
  const blocks = world.children(shared).flatMap(id => { const rect = world.rect(id); return rect ? [rect] : []; });
  const start = leave.points.at(-1)!, end = enter.points.at(-1)!;
  const street = streetRoute(floor, blocks, start, end, { ...streetsOf(floor, blocks), start: leave.heading, end: OPPOSITE[enter.heading] });
  if (!street) return undefined;
  const points = [...leave.points, ...street.slice(1).map(point => ({ ...point, z })), ...[...enter.points].reverse().slice(1)];
  const hosts = [...leave.hosts, ...street.slice(1).map(() => shared), ...[...enter.hosts].reverse()];
  return simplify({ points, hosts });
}
/**
 * A rail between an area and a block inside it (`chain`: from the block up to
 * the area): from the middle of the area's outer street, on the side nearest
 * the block, to the block (`inward`), or the other way.
 */
function nestedRail(world: RailWorld, chain: string[], outer: string, inward: boolean): Rail | undefined {
  const area = world.rect(outer), inner = world.rect(chain[0]!);
  if (!area || !inner) return undefined;
  const center = { x: inner.x + inner.w / 2, y: inner.y + inner.h / 2 };
  const gaps: [Dir, number][] = [[0, area.x + area.w - center.x], [1, center.x - area.x], [2, area.y + area.h - center.y], [3, center.y - area.y]];
  const side = gaps.reduce((best, next) => next[1] < best[1] ? next : best)[0];
  const toward = away(onSide(area, side, center), side, 1);
  const out = climb(world, chain.slice(0, chain.indexOf(outer) + 1), toward);
  if (!out) return undefined;
  const blocks = world.children(outer).flatMap(id => { const rect = world.rect(id); return rect ? [rect] : []; });
  const streets = streetsOf(area, blocks);
  const edge = away(onSide(area, side, out.points.at(-1)!, streets.band), side, -streets.band);
  const street = streetRoute(area, blocks, out.points.at(-1)!, edge, { ...streets, start: out.heading });
  if (!street) return undefined;
  const z = world.top(outer);
  const points = [...out.points, ...street.slice(1).map(point => ({ ...point, z }))], hosts = [...out.hosts, ...street.slice(1).map(() => outer)];
  return simplify(inward ? { points: points.reverse(), hosts: hosts.reverse() } : { points, hosts });
}
/** From a block (`chain[0]`) out through every area holding it, down to the floor of the last one (`chain.at(-1)`). */
function climb(world: RailWorld, chain: string[], toward: P): Climb | undefined {
  const block = world.rect(chain[0]!), holder = chain[1]!;
  if (!block) return undefined;
  const side = facing(block, toward);
  const streets = (id: string) => { const rect = world.rect(id)!; const blocks = world.children(id).flatMap(child => { const r = world.rect(child); return r ? [r] : []; }); return { rect, blocks, ...streetsOf(rect, blocks) }; };
  let floor = streets(holder);
  const port = onSide(block, side);
  const points: RailPoint[] = [{ ...port, z: world.top(holder) }, { ...away(port, side, floor.margin), z: world.top(holder) }];
  const hosts = [holder];
  let heading = side;
  for (let i = 1; i < chain.length - 1; i++) {
    const area = chain[i]!, below = chain[i + 1]!;
    if (!world.rect(area) || !world.rect(below)) return undefined;
    // Out the way the rail already heads while the other end lies beyond that side, else through the side facing it;
    // straight ahead from where the rail is, so it leaves nested areas without a staircase of jogs.
    const exit = beyond(floor.rect, heading, toward) ? heading : facing(floor.rect, toward);
    const edge = onSide(floor.rect, exit, points.at(-1)!, floor.band);
    const route = streetRoute(floor.rect, floor.blocks, points.at(-1)!, edge, { margin: floor.margin, band: floor.band, ...(floor.inner ? { inner: floor.inner } : {}), start: heading, end: exit });
    if (!route) return undefined;
    const z = world.top(area), zBelow = world.top(below);
    for (const point of route.slice(1)) { points.push({ ...point, z }); hosts.push(area); }
    const next = streets(below);
    // Down the wall: drawn with the area when the wall faces the viewer, else with the floor below (the area hides it).
    points.push({ ...edge, z: zBelow }); hosts.push(FRONT.has(exit) ? area : below);
    points.push({ ...away(edge, exit, next.margin), z: zBelow }); hosts.push(below);
    floor = next; heading = exit;
  }
  return { points, hosts, heading };
}
/** Merge straight runs drawn with the same block. */
function simplify(rail: Rail): Rail {
  const points = [rail.points[0]!], hosts: string[] = [];
  for (let i = 1; i < rail.points.length; i++) {
    const point = rail.points[i]!, host = rail.hosts[i - 1]!;
    const a = points.at(-2), b = points.at(-1)!;
    if (Math.abs(b.x - point.x) < 1e-9 && Math.abs(b.y - point.y) < 1e-9 && Math.abs(b.z - point.z) < 1e-9) continue;
    const straight = a && hosts.at(-1) === host && Math.abs((b.x - a.x) * (point.y - b.y) - (b.y - a.y) * (point.x - b.x)) < 1e-9 && Math.abs(a.z - b.z) < 1e-9 && Math.abs(b.z - point.z) < 1e-9;
    if (straight) points[points.length - 1] = point;
    else { points.push(point); hosts.push(host); }
  }
  return { points, hosts };
}
/** Total length of a rail, in world units. */
export function railLength(rail: Rail): number {
  let length = 0;
  for (let i = 1; i < rail.points.length; i++) { const a = rail.points[i - 1]!, b = rail.points[i]!; length += Math.abs(b.x - a.x) + Math.abs(b.y - a.y) + Math.abs(b.z - a.z); }
  return length;
}

/** A binary min-heap of integer items by priority. */
class Heap {
  private items: number[] = [];
  private keys: number[] = [];
  get size(): number { return this.items.length; }
  push(item: number, key: number): void {
    const items = this.items, keys = this.keys;
    let i = items.length;
    items.push(item); keys.push(key);
    while (i > 0) { const parent = (i - 1) >> 1; if (keys[parent]! <= key) break; items[i] = items[parent]!; keys[i] = keys[parent]!; i = parent; }
    items[i] = item; keys[i] = key;
  }
  pop(): number {
    const items = this.items, keys = this.keys;
    const top = items[0]!;
    const item = items.pop()!, key = keys.pop()!;
    if (items.length) {
      let i = 0;
      for (;;) {
        const left = i * 2 + 1, right = left + 1;
        let smallest = i, smallestKey = key;
        if (left < items.length && keys[left]! < smallestKey) { smallest = left; smallestKey = keys[left]!; }
        if (right < items.length && keys[right]! < smallestKey) smallest = right;
        if (smallest === i) break;
        items[i] = items[smallest]!; keys[i] = keys[smallest]!; i = smallest;
      }
      items[i] = item; keys[i] = key;
    }
    return top;
  }
}

/**
 * Rails already routed, per scene: a route stays valid while the areas it
 * passes hold the same blocks (`stamp`). Routing stops at `deadline`
 * (performance.now() time); the rest waits for the next frame.
 */
export class RailCache {
  private readonly scenes = new WeakMap<object, Map<string, { stamp: string; rail: Rail | null }>>();
  /** The rail, `null` when there is none (one block holds the other, no street), `undefined` when it waits for the next frame. */
  get(scene: object, world: RailWorld, from: string, to: string, stamp: string, deadline: number): Rail | null | undefined {
    let routes = this.scenes.get(scene);
    if (!routes) { routes = new Map(); this.scenes.set(scene, routes); }
    const key = `${from}>${to}`, cached = routes.get(key);
    if (cached && cached.stamp === stamp) return cached.rail;
    if (performance.now() > deadline) return undefined;
    if (routes.size > 4000) routes.clear();
    const rail = railRoute(world, from, to) ?? null;
    routes.set(key, { stamp, rail });
    return rail;
  }
}
