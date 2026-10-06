// The split map of History: an overview of the whole repository and one view
// on each place where the compared code changed (projection/regions.ts), five
// places to a page. The coordinator ties the views together: while the split
// map is shown it is the store's navigator (a selection flies the view holding
// it), and it gives the overview the frame of every view.
import type { ChangeRegion, ChangeRegionsResult, NodeSummary, RegionLevel } from '@engine/projection/dto';
import { changeRegions, REGION_PAGE } from '../../src/projection/regions';
import { projectedBounds, type Bounds, type Point } from './camera';
import type { MapController } from './controller';
import type { Evolution } from './evolution';
import type { FrameOverlay } from './renderer';
import { nodeHeight, type Scene } from './scene';
import type { AtlasStore, MapNavigator } from './store';

export { REGION_PAGE };
/**
 * Grid for this many views besides the overview: the overview comes first and
 * spans `span` cells along the short side, so 1–5 views fill the grid
 * (1: side by side; 2: overview beside two stacked views; 3: 2×2; 4: overview
 * beside a 2×2; 5: 3×2). A portrait stage turns the grid on its side.
 */
export function splitGrid(views: number, portrait = false): { columns: number; rows: number; overview: { gridRow?: string; gridColumn?: string } } {
  const [columns, rows, span] = views <= 0 ? [1, 1, 1] : views === 1 ? [2, 1, 1] : views === 2 ? [2, 2, 2] : views === 3 ? [2, 2, 1] : views === 4 ? [3, 2, 2] : [3, 2, 1];
  if (portrait) return { columns: rows, rows: columns, overview: span > 1 ? { gridColumn: `span ${span}` } : {} };
  return { columns, rows, overview: span > 1 ? { gridRow: `span ${span}` } : {} };
}
/** The spatial ancestors of a scene node, root first. */
function ancestorsOf(scene: Scene, id: string): NodeSummary[] {
  const chain: NodeSummary[] = [];
  for (let node = scene.nodes.get(scene.nodes.get(id)?.spatialParentId ?? ''); node; node = node.spatialParentId ? scene.nodes.get(node.spatialParentId) : undefined) chain.unshift(node);
  return chain;
}
/** The places of a time-lapse frame (a complete scene), grouped as the server groups a settled comparison. */
export function sceneRegions(scene: Scene, level: RegionLevel): ChangeRegionsResult {
  const changed: string[] = [];
  for (const node of scene.nodes.values()) if (node.change && node.change.status !== 'unchanged') changed.push(node.id);
  const picks = changeRegions(changed, id => scene.nodes.get(id), { level });
  return { level: picks.level, changed: picks.changed, truncated: picks.truncated, regions: picks.regions.map(pick => ({ node: scene.nodes.get(pick.id)!, ancestors: ancestorsOf(scene, pick.id), counts: pick.counts, total: pick.total, frame: pick.box })) };
}
/**
 * The places of the time-lapse frames from `from` to `to` together: while it
 * plays, the views wait where the next frames change things, which then
 * flash in them. Nodes are found in the last frame's scene.
 */
export function timelapseRegions(evolution: Evolution, from: number, to: number, level: RegionLevel): ChangeRegionsResult {
  const end = Math.max(0, Math.min(evolution.length - 1, to));
  const scene = evolution.scene(end), changes = evolution.changesBetween(from, end);
  const lookup = (id: string) => { const node = scene.nodes.get(id), status = changes.get(id); return node && { ...node, change: status ? { status } : undefined }; };
  const picks = changeRegions(changes.keys(), lookup, { level });
  return { level: picks.level, changed: picks.changed, truncated: picks.truncated, regions: picks.regions.map(pick => ({ node: scene.nodes.get(pick.id)!, ancestors: ancestorsOf(scene, pick.id), counts: pick.counts, total: pick.total, frame: pick.box })) };
}
export interface SplitState { page: number; active: number; /** Changes when the places do. */ revision: number }

export class SplitCoordinator implements MapNavigator {
  private regions: ChangeRegion[] = [];
  private readonly byId = new Map<string, number>();
  private readonly views = new Map<number, MapController>();
  private overview?: MapController;
  private state: SplitState = { page: 0, active: 0, revision: 0 };
  private readonly listeners = new Set<() => void>();
  /** A flight waiting for its view to mount (it was on another page). */
  private pending?: { index: number; node: NodeSummary; mode?: 'focus' | 'enter' };
  private forcedCache?: { revision: number; areas: Set<string> };
  constructor(private readonly store: AtlasStore) {}
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  getState = (): SplitState => this.state;
  private update(patch: Partial<SplitState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
    this.overview?.request();
  }
  /** While the split map is shown, selections and fits go through it. */
  attach(): void {
    const store = this.store;
    store.navigator = this;
    store.visibility = id => !!this.overview?.has(id) || [...this.views.values()].some(view => view.has(id));
    store.openContainers = () => [...new Set([...[...this.views.values()].flatMap(view => view.openContainers()), ...(this.overview?.openContainers() ?? [])])];
  }
  detach(): void {
    const store = this.store;
    if (store.navigator !== this) return;
    store.navigator = undefined; store.visibility = undefined; store.openContainers = undefined;
  }
  get count(): number { return this.regions.length; }
  get pages(): number { return Math.max(1, Math.ceil(this.regions.length / REGION_PAGE)); }
  region(index: number): ChangeRegion | undefined { return this.regions[index]; }
  setRegions(regions: ChangeRegion[]): void {
    const same = regions.length === this.regions.length && regions.every((region, index) => region.node.id === this.regions[index]!.node.id);
    this.regions = regions;
    if (same) { this.overview?.request(); return; }
    this.byId.clear();
    regions.forEach((region, index) => this.byId.set(region.node.id, index));
    const page = Math.min(this.state.page, this.pages - 1);
    const active = Math.floor(this.state.active / REGION_PAGE) === page && this.state.active < regions.length ? this.state.active : page * REGION_PAGE;
    this.update({ page, active, revision: this.state.revision + 1 });
  }
  setPage(page: number): void {
    const next = Math.max(0, Math.min(this.pages - 1, page));
    if (next !== this.state.page) this.update({ page: next, active: next * REGION_PAGE });
  }
  /** The view in use: its frame glows on the overview, and fits and zooms go to it. */
  activate(index: number): void {
    if (index < 0 || index >= this.regions.length || index === this.state.active) return;
    this.update({ active: index, page: Math.floor(index / REGION_PAGE) });
  }
  register(index: number, view: MapController): void {
    this.views.set(index, view);
    if (this.pending?.index === index) { const { node, mode } = this.pending; this.pending = undefined; view.flyTo(node, mode ? { mode } : {}); }
    this.overview?.request();
  }
  unregister(index: number, view: MapController): void { if (this.views.get(index) === view) this.views.delete(index); this.overview?.request(); }
  setOverview(view: MapController | undefined): void { this.overview = view; }
  /** How many times closer than the overview a view at this camera scale is (rounded; undefined before the overview is drawn). */
  zoomOf(scale: number): number | undefined { const overview = this.overview?.scale(); return overview ? Math.max(1, Math.round(scale / overview)) : undefined; }
  /** A view's camera moved: its frame on the overview follows. */
  moved(): void { this.overview?.request(); }
  private scene(): Scene { return this.store.previewScene ?? this.store.scene; }
  private placeBounds(region: ChangeRegion): Bounds {
    const scene = this.scene(), node = region.node;
    const z = scene.nodes.has(node.id) ? scene.zBase(node.id) : 0;
    return projectedBounds(region.frame, z, z + nodeHeight(node));
  }
  /** Every place on the overview: what its view shows when it is on this page, else the place itself. */
  frames(): FrameOverlay[] {
    const { page, active } = this.state;
    return this.regions.map((region, index) => {
      const shown = Math.floor(index / REGION_PAGE) === page;
      const view = shown ? this.views.get(index) : undefined;
      return { key: region.node.id, number: index + 1, bounds: view ? view.visiblePlane() : this.placeBounds(region), active: index === active, shown };
    });
  }
  /** The overview opens the areas holding each place, so the places themselves are drawn on it. */
  forced(): Set<string> {
    if (this.forcedCache?.revision !== this.state.revision) {
      const areas = new Set<string>();
      for (const region of this.regions) for (const ancestor of region.ancestors) if (ancestor.spatialParentId) areas.add(ancestor.id);
      this.forcedCache = { revision: this.state.revision, areas };
    }
    return this.forcedCache.areas;
  }
  /** A click on the overview inside frames goes to the smallest of them (true), otherwise it selects as usual. */
  hitFrame(point: Point): boolean {
    let best: { index: number; area: number } | undefined;
    this.frames().forEach((frame, index) => {
      const { minX, minY, maxX, maxY } = frame.bounds;
      if (point.x < minX || point.x > maxX || point.y < minY || point.y > maxY) return;
      const area = (maxX - minX) * (maxY - minY);
      if (!best || area < best.area) best = { index, area };
    });
    if (!best) return false;
    this.activate(best.index);
    return true;
  }
  /** The place holding a node (through its spatial ancestors), if any. */
  regionOf(node: NodeSummary): number | undefined {
    const scene = this.scene();
    for (let current: NodeSummary | undefined = node; current; current = current.spatialParentId ? scene.nodes.get(current.spatialParentId) : undefined) {
      const index = this.byId.get(current.id);
      if (index !== undefined) return index;
    }
    return undefined;
  }
  // MapNavigator: the view of the place holding the node flies (else the view in use).
  flyTo(node: NodeSummary, options: { mode?: 'focus' | 'enter' } = {}): void {
    const index = this.regionOf(node) ?? this.state.active;
    this.activate(index);
    const view = this.views.get(index);
    if (view) view.flyTo(node, options);
    else this.pending = { index, node, ...(options.mode ? { mode: options.mode } : {}) };
  }
  fitNodes(nodes: NodeSummary[]): void { (this.views.get(this.state.active) ?? this.overview)?.fitNodes(nodes); }
  /** Every view back to its place, and the overview to the whole repository. */
  fitAll(): void { for (const view of this.views.values()) view.goHome(); this.overview?.goHome(); }
  zoomBy(factor: number): void { (this.views.get(this.state.active) ?? this.overview)?.zoomBy(factor); }
}
