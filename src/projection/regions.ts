// Where a comparison's changes are, as a few places to look at: the split map
// of History frames one view on each. Shared by the server (settled views) and
// the browser (time-lapse frames), so both group changes the same way.
//
// Every changed entity is anchored at the *unit* holding it: a file (its
// symbols are seen in it) or an area (an application, a directory, a district
// of routes, tables or commands). A place is an area or a unit, and its view
// frames the units changed in it (`box`), not all of it. `auto` starts from the
// smallest area holding every change and splits a place into the places below
// it while that brings the views closer: freely while they fit on one page,
// and beyond that only when its changed units would be too small to read in
// one view. The fixed levels give one place per changed application, folder
// or file.
import type { ChangeCounts, ChangeStatus, Rect, RegionLevel } from './dto.js';

/** What the grouping reads of a node: the server's projection nodes and the browser's scene nodes both have it. */
export interface RegionNode { id: string; kind: 'entity' | 'group'; type: string; rect: Rect; childCount: number; spatialParentId?: string; change?: { status: ChangeStatus } }
/** `box`: the ground-plane rectangle around the units changed in the place, which its view frames. */
export interface RegionPick { id: string; counts: ChangeCounts; total: number; box: Rect }
export interface RegionPicks { level: RegionLevel; regions: RegionPick[]; changed: number; truncated: number }
export const REGION_LEVELS: readonly RegionLevel[] = ['auto', 'application', 'directory', 'file'];
/** Views of the split map per page (the overview takes the sixth place). */
export const REGION_PAGE = 5;
/** At most this many places are listed; the others are counted as left out. Places come most changes first, so the first page holds the main ones. */
export const REGION_MAX = 30;
/** `auto` beyond the first page splits a place when its typical changed unit spans less than this share of the view (a name no longer reads). */
const READABLE_SHARE = 0.1;
/** Within the first page, a split must bring the views this much closer (by area): neighbours share a view. */
const PAGE_GAIN = 1.5;
const AREA_TYPES = new Set(['repository', 'application', 'directory']);
export function isRegionLevel(value: unknown): value is RegionLevel { return REGION_LEVELS.includes(value as RegionLevel); }
function isArea(node: RegionNode): boolean { return node.kind === 'group' || AREA_TYPES.has(node.type); }
function isUnit(node: RegionNode): boolean { return node.type === 'file' || isArea(node); }
function area(node: RegionNode): number { return Math.max(1e-9, node.rect.w * node.rect.h); }
interface Branch { node: RegionNode; kids: Set<string>; counts: ChangeCounts; total: number; box?: Rect; sizes: number[] }
function union(a: Rect | undefined, b: Rect): Rect {
  if (!a) return { ...b };
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

export function changeRegions(changed: Iterable<string>, lookup: (id: string) => RegionNode | undefined, options: { level?: RegionLevel; max?: number } = {}): RegionPicks {
  const level = options.level ?? 'auto', max = Math.max(1, options.max ?? REGION_MAX);
  // The tree of changes: the unit of every changed entity and its spatial ancestors, with counts.
  const tree = new Map<string, Branch>();
  const anchored: { unit: string; entity: RegionNode }[] = [];
  let rootId: string | undefined, total = 0;
  for (const id of changed) {
    const entity = lookup(id), status = entity?.change?.status;
    if (!entity || !status || status === 'unchanged' || entity.kind !== 'entity' || entity.type === 'repository') continue;
    let unit: RegionNode | undefined = entity;
    while (unit && !isUnit(unit)) unit = unit.spatialParentId ? lookup(unit.spatialParentId) : undefined;
    if (!unit) continue;
    const chain: RegionNode[] = [];
    for (let node: RegionNode | undefined = unit; node; node = node.spatialParentId ? lookup(node.spatialParentId) : undefined) chain.push(node);
    // A chain that does not reach the root (a node not loaded) cannot be placed.
    if (chain.at(-1)!.spatialParentId) continue;
    total++;
    rootId = chain.at(-1)!.id;
    chain.forEach((node, index) => {
      let branch = tree.get(node.id);
      if (!branch) tree.set(node.id, branch = { node, kids: new Set(), counts: { added: 0, removed: 0, modified: 0, moved: 0 }, total: 0, sizes: [] });
      branch.counts[status]++; branch.total++;
      if (index > 0) branch.kids.add(chain[index - 1]!.id);
    });
    anchored.push({ unit: unit.id, entity });
  }
  if (!rootId) return { level, regions: [], changed: 0, truncated: 0 };
  // An area that changed itself (added, moved…) is seen through the changes inside it when there are some.
  const anchors = new Set(anchored.filter(({ unit, entity }) => !(entity.id === unit && isArea(entity) && tree.get(unit)!.kids.size)).map(item => item.unit));
  // What each place's view frames, and how large its changed units are.
  for (const unit of anchors) {
    const rect = tree.get(unit)!.node.rect, size = Math.sqrt(area(tree.get(unit)!.node));
    for (let branch = tree.get(unit); branch; branch = branch.node.spatialParentId ? tree.get(branch.node.spatialParentId) : undefined) { branch.box = union(branch.box, rect); branch.sizes.push(size); }
  }
  const chainOf = (id: string): string[] => { const chain: string[] = []; for (let node = tree.get(id)?.node; node; node = node.spatialParentId ? tree.get(node.spatialParentId)?.node : undefined) chain.unshift(node.id); return chain; };
  let picked: string[];
  if (level === 'auto') picked = autoRegions(tree, rootId, anchors, max);
  else {
    const places = new Set<string>();
    for (const unit of anchors) {
      const chain = chainOf(unit);
      if (level === 'file') places.add(unit);
      // A file directly in the repository is its own place: the repository is what the overview shows.
      else if (level === 'directory') { const parent = chain.at(-2); places.add(isArea(tree.get(unit)!.node) || !parent || parent === rootId ? unit : parent); }
      else places.add(chain.find(id => tree.get(id)!.node.type === 'application') ?? chain[1] ?? unit);
    }
    picked = [...places];
  }
  const ordered = picked.map(id => tree.get(id)!).sort((a, b) => b.total - a.total || a.node.rect.y + a.node.rect.x - (b.node.rect.y + b.node.rect.x) || (a.node.id < b.node.id ? -1 : 1));
  return { level, regions: ordered.slice(0, max).map(branch => ({ id: branch.node.id, counts: branch.counts, total: branch.total, box: branch.box ?? branch.node.rect })), changed: total, truncated: Math.max(0, ordered.length - max) };
}
/**
 * Greedy splitting from the smallest area holding every change: places whose
 * changed units would not read in one view first, the ones with most changes
 * first, then the loosest (the most room around its changes in its view);
 * each is replaced by the places below it, narrowed to where its changes are.
 */
function autoRegions(tree: Map<string, Branch>, rootId: string, anchors: Set<string>, max: number): string[] {
  const narrow = (id: string): string => {
    let branch = tree.get(id)!;
    while (!anchors.has(branch.node.id) && branch.kids.size === 1) branch = tree.get([...branch.kids][0]!)!;
    return branch.node.id;
  };
  const boxArea = (id: string): number => { const box = tree.get(id)!.box!; return Math.max(1e-9, box.w * box.h); };
  const parts = (id: string): string[] => [...tree.get(id)!.kids].map(narrow);
  const looseness = (id: string): number => boxArea(id) / parts(id).reduce((sum, part) => sum + boxArea(part), 0);
  const readable = (id: string): boolean => {
    const { box, sizes } = tree.get(id)!;
    const median = [...sizes].sort((a, b) => a - b)[Math.floor(sizes.length / 2)]!;
    return median / Math.max(box!.w, box!.h) >= READABLE_SHARE;
  };
  const splittable = (id: string): boolean => !anchors.has(id) && tree.get(id)!.kids.size >= 2;
  const regions = [narrow(rootId)];
  const kept = new Set<string>();
  for (;;) {
    const candidates = regions.filter(id => splittable(id) && !kept.has(id)).map(id => ({ id, loose: looseness(id), readable: readable(id) }))
      .sort((a, b) => Number(a.readable) - Number(b.readable) || (a.readable ? b.loose - a.loose : tree.get(b.id)!.total - tree.get(a.id)!.total));
    const best = candidates[0];
    if (!best) break;
    const next = regions.length - 1 + tree.get(best.id)!.kids.size;
    // The whole repository is what the overview shows: always look closer (the smallest places beyond `max` are left out).
    // Within a page, a closer look is worth a view; beyond it, only reading what changed is.
    const root = best.id === rootId;
    const worth = root || (next <= REGION_PAGE ? best.loose >= PAGE_GAIN || !best.readable : !best.readable);
    if ((next > max && !root) || !worth) { kept.add(best.id); continue; }
    regions.splice(regions.indexOf(best.id), 1, ...parts(best.id));
  }
  return regions;
}
