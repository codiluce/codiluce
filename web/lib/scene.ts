// Client-side cache of loaded projection nodes plus per-frame visibility.
// Coordinates come from the server layout; nothing here moves a node. Load
// order only decides what is available to draw, never where it is drawn.
import type { NodeSummary } from '@engine/projection/dto';
import { fromScreen, intersects, projectedBounds, unproject, visibleBounds, type Camera, type Viewport } from './camera';
import { DEFAULT_LOD, labelTier, openProgress, screenSize, shouldOpen, type LabelTier, type LodConfig } from './lod';

export interface ChildList { ids: string[]; total: number; loadedPages: number; complete: boolean; loading: boolean; error?: string }
export interface VisibleItem { node: NodeSummary; zBase: number; zTop: number; open: boolean; alpha: number; tier: LabelTier; size: number; parent: number }
export interface VisibleSet {
  items: VisibleItem[];
  index: Map<string, number>;
  /** Open containers whose children are not (fully) loaded, largest first. */
  pending: string[];
  /** Budget reached: some containers stayed closed. */
  truncated: boolean;
  /** Innermost open container under the viewport center. */
  focus?: VisibleItem;
}

/** Block height by type (world units). Geometry only: never shown as a metric. */
export function nodeHeight(node: Pick<NodeSummary, 'type' | 'rect' | 'loc'>): number {
  switch (node.type) {
    case 'repository': return 6;
    case 'application': return 14;
    case 'group': return 5;
    case 'directory': return 6;
    case 'file': {
      const side = Math.min(node.rect.w, node.rect.h);
      const height = node.loc === undefined ? 2 : 3 + 4 * Math.log2(1 + node.loc / 8);
      return Math.max(2, Math.min(side * 0.3, height));
    }
    case 'class': case 'controller': case 'model': case 'database_table': return 4;
    default: return 3;
  }
}
/** Revisions are global so a replacement scene never repeats a revision the map has already drawn. */
let revisions = 0;
/** Painter's order among siblings: back (small x+y) to front. */
function depthKey(node: NodeSummary): number { return node.rect.x + node.rect.y + (node.rect.w + node.rect.h) / 2; }

export class Scene {
  readonly nodes = new Map<string, NodeSummary>();
  readonly children = new Map<string, ChildList>();
  private readonly base = new Map<string, number>();
  private readonly ordered = new Map<string, string[]>();
  rootId?: string;
  revision = ++revisions;
  /** Time-lapse scenes: the frame they show (settled views have none). */
  frame?: number;

  reset(root: NodeSummary): void {
    this.nodes.clear(); this.children.clear(); this.base.clear(); this.ordered.clear();
    this.rootId = root.id; this.nodes.set(root.id, root); this.revision = ++revisions;
  }
  /** Add a known node (e.g. from search/locate) even before its parent's page is loaded. */
  upsert(node: NodeSummary): void {
    if (!this.nodes.has(node.id)) { this.nodes.set(node.id, node); this.revision = ++revisions; }
    const parent = node.spatialParentId;
    if (!parent || !this.nodes.has(parent)) return;
    const list = this.childList(parent);
    if (!list.ids.includes(node.id)) { list.ids.push(node.id); this.ordered.delete(parent); this.revision = ++revisions; }
  }
  childList(parentId: string): ChildList {
    let list = this.children.get(parentId);
    if (!list) { list = { ids: [], total: this.nodes.get(parentId)?.childCount ?? 0, loadedPages: 0, complete: false, loading: false }; this.children.set(parentId, list); }
    return list;
  }
  addChildren(parentId: string, items: NodeSummary[], total: number, hasMore: boolean): void {
    const list = this.childList(parentId);
    for (const item of items) {
      if (!this.nodes.has(item.id)) this.nodes.set(item.id, item);
      if (!list.ids.includes(item.id)) list.ids.push(item.id);
    }
    list.total = total; list.loadedPages++; list.complete = !hasMore; list.loading = false; delete list.error;
    this.ordered.delete(parentId); this.revision = ++revisions;
  }
  setLoading(parentId: string, loading: boolean, error?: string): void {
    const list = this.childList(parentId);
    list.loading = loading;
    if (error) list.error = error; else delete list.error;
    this.revision = ++revisions;
  }
  zBase(id: string): number {
    const cached = this.base.get(id);
    if (cached !== undefined) return cached;
    const node = this.nodes.get(id);
    const parent = node?.spatialParentId ? this.nodes.get(node.spatialParentId) : undefined;
    const value = parent ? this.zBase(parent.id) + nodeHeight(parent) : 0;
    this.base.set(id, value);
    return value;
  }
  orderedChildren(id: string): string[] {
    let order = this.ordered.get(id);
    if (!order) {
      order = [...(this.children.get(id)?.ids ?? [])].sort((a, b) => depthKey(this.nodes.get(a)!) - depthKey(this.nodes.get(b)!) || (a < b ? -1 : 1));
      this.ordered.set(id, order);
    }
    return order;
  }
  /** Nearest ancestor (or self) present in the visible set. */
  representative(id: string, set: VisibleSet): VisibleItem | undefined {
    for (let current = this.nodes.get(id); current; current = current.spatialParentId ? this.nodes.get(current.spatialParentId) : undefined) {
      const index = set.index.get(current.id);
      if (index !== undefined) return set.items[index];
    }
    return undefined;
  }
  /**
   * What to draw from this camera. `force` names areas to open whatever their
   * size on screen (the areas a flow on the map passes), so its stops are
   * drawn at any zoom; their children appear at once instead of fading in.
   */
  visible(camera: Camera, viewport: Viewport, lod: LodConfig = DEFAULT_LOD, force?: ReadonlySet<string>): VisibleSet {
    const set: VisibleSet = { items: [], index: new Map(), pending: [], truncated: false };
    if (!this.rootId) return set;
    const view = visibleBounds(camera, viewport, 80);
    const pending: { id: string; size: number }[] = [];
    const center = { x: camera.x, y: camera.y };
    const visit = (id: string, parent: number, inheritedAlpha: number): void => {
      const node = this.nodes.get(id)!;
      const zBase = this.zBase(id), zTop = zBase + nodeHeight(node);
      if (!intersects(projectedBounds(node.rect, zBase, zTop), view)) return;
      const size = screenSize(node.rect, camera.scale);
      const forced = !!force?.has(id) && node.childCount > 0;
      const wantsOpen = forced || shouldOpen(node, camera.scale, lod);
      const list = this.children.get(id);
      const open = wantsOpen && set.items.length < lod.budget && !!list?.ids.length;
      if (wantsOpen && set.items.length >= lod.budget) set.truncated = true;
      if (wantsOpen && (!list || (!list.complete && !list.loading && !list.error))) pending.push({ id, size });
      const index = set.items.length;
      const item: VisibleItem = { node, zBase, zTop, open, alpha: inheritedAlpha, tier: labelTier(node, camera.scale, open, lod), size, parent };
      set.items.push(item); set.index.set(id, index);
      if (!open) return;
      const ground = unproject(center.x, center.y, zTop);
      const r = node.rect;
      if (ground.x >= r.x && ground.x <= r.x + r.w && ground.y >= r.y && ground.y <= r.y + r.h) set.focus = item;
      const alpha = inheritedAlpha * (forced ? 1 : openProgress(node, camera.scale, lod));
      for (const child of this.orderedChildren(id)) visit(child, index, alpha);
    };
    visit(this.rootId, -1, 1);
    set.pending = pending.sort((a, b) => b.size - a.size).map(item => item.id);
    return set;
  }
  /** Frontmost item under a screen point, testing top faces and the visible walls. */
  hitTest(set: VisibleSet, camera: Camera, viewport: Viewport, sx: number, sy: number): VisibleItem | undefined {
    const plane = fromScreen(camera, viewport, { x: sx, y: sy });
    const ground = unproject(plane.x, plane.y, 0);
    for (let i = set.items.length - 1; i >= 0; i--) {
      const item = set.items[i]!;
      if (item.alpha < 0.2 && item.parent >= 0) continue;
      if (hitPrism(item.node.rect, item.zBase, item.zTop, ground)) return item;
    }
    return undefined;
  }
}
/**
 * A screen ray meets elevation z at ground (x0 + z, y0 + z) for this projection
 * (ISO_Y = 0.5). The prism is hit when some z in [zBase, zTop] lands in the rect.
 */
export function hitPrism(rect: { x: number; y: number; w: number; h: number }, zBase: number, zTop: number, ground: { x: number; y: number }): boolean {
  const low = Math.max(zBase, rect.x - ground.x, rect.y - ground.y);
  const high = Math.min(zTop, rect.x + rect.w - ground.x, rect.y + rect.h - ground.y);
  return low <= high;
}
