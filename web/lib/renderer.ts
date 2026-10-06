// Canvas 2D renderer for the isometric map. Stateless per frame: everything it
// draws comes from the visible set, the camera and a RenderState.
import type { NodeSummary } from '@engine/projection/dto';
import { ISO_X, ISO_Y, worldToScreen, type Camera, type Point, type Viewport } from './camera';
import type { LodConfig } from './lod';
import type { Scene, VisibleItem, VisibleSet } from './scene';
import { PaletteCache, paletteKey, type Theme } from './themes';
import type { StopTone } from './map-flow';
import { compactNumber, typeLabel } from './format';
import { NOT_MEASURED } from './coverage';

export interface EdgeOverlay { key: string; from: string; to: string; fromAncestors: string[]; toAncestors: string[]; type: string; count: number; emphasized?: boolean; change?: 'added' | 'removed' }
/**
 * The branch of a flow being played: its links with how far the pulse has
 * flowed along each (0 not yet, 1 all the way), and its stops — reached, at
 * the front (reached last), or still ahead.
 */
export interface FlowOverlay {
  links: { from: string; fromAncestors: string[]; to: string; toAncestors: string[]; fill: number; back: boolean }[];
  stops: { entityId: string; ancestors: string[]; state: 'reached' | 'front' | 'ahead' }[];
  /** The pulse streams while the flow plays. */
  moving: boolean;
}
/** A flow's stop labelled on screen next to its block (whatever the zoom), with its number. */
export interface CalloutOverlay { entityId: string; ancestors: string[]; number: number; label: string; tone: StopTone; current: boolean }
/** What a flow passes that is not an entity (middleware, a response, an effect, a gap), pinned to its block. */
export interface PinOverlay { key: string; ownerId: string; ownerAncestors: string[]; label: string; tone: 'ok' | 'warn' | 'error' | 'info' }
/** Coverage lens: files colored by category; closed areas badged with how much of them flows touch. */
export interface CoverageOverlay { files: Map<string, string>; areas: Map<string, Record<string, number>> }
export interface SourceOverlay { nodeId: string; start: number; lines: string[]; focus?: { startLine: number; endLine: number }; /** Lines where the symbol calls, renders or references an indexed entity. */ marks?: Set<number> }
export interface RenderState {
  selectedId?: string; hoveredId?: string;
  /** When set, nodes outside it (and outside their ancestors) are dimmed. */
  emphasis?: Set<string>;
  /** A flow is shown: what it touches (with the areas holding it) is drawn as usual, everything else dims. */
  lit?: Set<string>;
  edges: EdgeOverlay[];
  flow?: FlowOverlay;
  showDiagnostics: boolean;
  source?: SourceOverlay;
  /** Unresolved outgoing calls of the selection, drawn as dangling stubs. */
  unresolved?: { nodeId: string; count: number };
  /** Comparison view: draw change status; optionally fade what did not change. */
  comparison?: { dimUnchanged: boolean };
  /** Moving through history: blocks that appeared rise from the ground, changed ones flash. Start times by node ID. */
  motion?: MotionState;
  /** Blast radius of the selection or of a comparison. */
  impact?: ImpactOverlay;
  callouts?: CalloutOverlay[];
  pins?: PinOverlay[];
  coverage?: CoverageOverlay;
  time: number;
  reducedMotion: boolean;
}
export interface MotionState { appear: Map<string, number>; flash: Map<string, number> }
/**
 * Blast radius on the map: reached entities by hop count (seeds are 0), and
 * closed areas with how many affected entities they hold. With `dimOthers`,
 * everything unreached recedes.
 */
export interface ImpactOverlay { distances: Map<string, number>; areas: Map<string, { count: number; distance: number }>; depth: number; dimOthers: boolean }
interface Label { x: number; y: number; lines: { text: string; font: string; color: string }[]; priority: number; align: 'center' | 'above' }
const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';
/** Duration of a block rising into place, and of a change flash. */
export const RISE_MS = 520, FLASH_MS = 900;
/** Rounded corners and gradients are skipped below this on-screen size, where they would not show. */
const SOFT_PX = 16;

export class MapRenderer {
  private palettes: PaletteCache;
  private font = FONT;
  private dpr = 1;
  constructor(private theme: Theme) { this.palettes = new PaletteCache(theme); this.font = theme.style?.font ?? FONT; }
  setTheme(theme: Theme): void { this.theme = theme; this.palettes = new PaletteCache(theme); this.font = theme.style?.font ?? FONT; }

  render(ctx: CanvasRenderingContext2D, dpr: number, viewport: Viewport, camera: Camera, scene: Scene, set: VisibleSet, state: RenderState, lod: LodConfig): void {
    const theme = this.theme;
    this.dpr = dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.background(ctx, viewport);
    if (theme.style?.grid === 'dots') this.dotGrid(ctx, viewport, camera); else this.grid(ctx, viewport, camera);

    const emphasis = state.emphasis ? this.expandEmphasis(scene, state.emphasis) : undefined;
    const flowSet = state.lit;
    const labels: Label[] = [];
    const items = this.animate(set, state);
    const impactLit = state.impact ? this.impactLit(scene, state.impact) : undefined;
    const coverageOf = state.coverage ? this.coverageResolver(scene, state.coverage) : undefined;
    for (const item of items) {
      const dimmed = (flowSet && !flowSet.has(item.node.id)) || (!flowSet && emphasis && !emphasis.has(item.node.id));
      // In a comparison, blocks a change reaches stay lit instead of fading with the unchanged ones.
      const reached = impactLit?.has(item.node.id) && item.node.change?.status !== 'removed';
      const alpha = item.alpha * (dimmed ? (flowSet ? theme.flow.dimAlpha : theme.dimAlpha) : 1) * (state.comparison && !reached ? this.changeAlpha(item, state.comparison) : 1) * (state.impact?.dimOthers && !reached ? theme.dimAlpha : 1);
      if (alpha <= 0.01) continue;
      if (theme.style?.shadow && item.parent >= 0 && item.size > SOFT_PX) this.shadow(ctx, viewport, camera, item, alpha);
      const category = coverageOf?.(item.node);
      this.prism(ctx, viewport, camera, item, alpha, item.node.id === state.hoveredId, category ? `coverage:${category}` : undefined);
      if (state.coverage && !item.open && !category && state.coverage.areas.has(item.node.id)) this.coverageBadge(ctx, viewport, camera, item, alpha, state.coverage.areas.get(item.node.id)!);
      if (state.comparison) this.changeOverlay(ctx, viewport, camera, item, alpha, state);
      if (state.impact) this.impactOverlay(ctx, viewport, camera, item, alpha, state.impact);
      if (state.showDiagnostics && !item.open && item.node.diagnostics > 0 && item.size > 10) this.diagnosticMarker(ctx, viewport, camera, item, alpha);
      this.collectLabel(labels, viewport, camera, item, state, alpha, dimmed ?? false);
    }
    const selected = state.selectedId ? items[set.index.get(state.selectedId) ?? -1] : undefined;
    if (selected) this.outline(ctx, viewport, camera, selected, theme.selection, 2.5, true);
    else if (state.selectedId) {
      // Selected entity hidden at this LOD: ring its visible ancestor.
      const representative = scene.representative(state.selectedId, set);
      if (representative) this.outline(ctx, viewport, camera, representative, theme.selection, 1.5, false, [5, 4]);
    }
    const hovered = state.hoveredId ? items[set.index.get(state.hoveredId) ?? -1] : undefined;
    if (hovered && hovered !== selected) this.outline(ctx, viewport, camera, hovered, theme.hover, 1.5, false);
    if (state.source && selected && selected.node.id === state.source.nodeId && selected.size >= lod.sourcePx) this.sourceFace(ctx, viewport, camera, selected, state.source);
    this.edges(ctx, viewport, camera, set, state.edges);
    if (state.unresolved && state.unresolved.count > 0) this.unresolvedStub(ctx, viewport, camera, scene, set, state.unresolved);
    if (state.flow) this.flow(ctx, viewport, camera, set, state.flow, state);
    this.labels(ctx, labels);
    if (state.pins?.length) this.pins(ctx, viewport, camera, set, state.pins);
    if (state.callouts?.length) this.callouts(ctx, viewport, camera, set, state.callouts);
  }
  private expandEmphasis(scene: Scene, ids: Set<string>): Set<string> {
    // Keep ancestors lit so emphasized nodes are not drawn on dimmed platforms.
    const result = new Set<string>();
    for (const id of ids) {
      for (let node: NodeSummary | undefined = scene.nodes.get(id); node; node = node.spatialParentId ? scene.nodes.get(node.spatialParentId) : undefined) {
        if (result.has(node.id)) break;
        result.add(node.id);
      }
      result.add(id);
    }
    return result;
  }
  private background(ctx: CanvasRenderingContext2D, viewport: Viewport): void {
    const { width, height } = viewport;
    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, this.theme.background[0]); gradient.addColorStop(1, this.theme.background[1]);
    ctx.fillStyle = gradient; ctx.fillRect(0, 0, width, height);
    // Soft color fields fixed to the viewport, like light behind frosted glass.
    for (const glow of this.theme.style?.glows ?? []) {
      const x = glow.x * width, y = glow.y * height, r = glow.r * Math.max(width, height);
      const field = ctx.createRadialGradient(x, y, 0, x, y, r);
      field.addColorStop(0, glow.color); field.addColorStop(1, transparent(glow.color));
      ctx.fillStyle = field; ctx.fillRect(0, 0, width, height);
    }
  }
  /** Ground extent on screen, in world units, and a grid spacing (powers of 4) that adapts to zoom. */
  private groundExtent(viewport: Viewport, camera: Camera, minPx: number) {
    const spacing = 4 ** Math.ceil(Math.log(minPx / camera.scale) / Math.log(4));
    const corners = [[0, 0], [viewport.width, 0], [0, viewport.height], [viewport.width, viewport.height]].map(([sx, sy]) => {
      const px = (sx! - viewport.width / 2) / camera.scale + camera.x, py = (sy! - viewport.height / 2) / camera.scale + camera.y;
      const a = px / ISO_X, b = py / ISO_Y;
      return { x: (a + b) / 2, y: (b - a) / 2 };
    });
    return { spacing, minX: Math.min(...corners.map(c => c.x)), maxX: Math.max(...corners.map(c => c.x)), minY: Math.min(...corners.map(c => c.y)), maxY: Math.max(...corners.map(c => c.y)) };
  }
  /** Dots at the grid intersections, in one path. */
  private dotGrid(ctx: CanvasRenderingContext2D, viewport: Viewport, camera: Camera): void {
    const { spacing, minX, maxX, minY, maxY } = this.groundExtent(viewport, camera, 30);
    if ((maxX - minX) / spacing > 160 || (maxY - minY) / spacing > 160) return;
    ctx.fillStyle = this.theme.grid;
    ctx.beginPath();
    const size = 1.6;
    for (let x = Math.floor(minX / spacing) * spacing; x <= maxX; x += spacing) {
      for (let y = Math.floor(minY / spacing) * spacing; y <= maxY; y += spacing) {
        const p = worldToScreen(camera, viewport, x, y);
        if (p.x < -2 || p.y < -2 || p.x > viewport.width + 2 || p.y > viewport.height + 2) continue;
        ctx.rect(p.x - size / 2, p.y - size / 2, size, size);
      }
    }
    ctx.fill();
  }
  private grid(ctx: CanvasRenderingContext2D, viewport: Viewport, camera: Camera): void {
    // Ground grid with spacing that adapts to zoom (powers of 4 world units).
    const { spacing, minX, maxX, minY, maxY } = this.groundExtent(viewport, camera, 48);
    if ((maxX - minX) / spacing > 400 || (maxY - minY) / spacing > 400) return;
    ctx.strokeStyle = this.theme.grid; ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = Math.floor(minX / spacing) * spacing; x <= maxX; x += spacing) {
      const a = worldToScreen(camera, viewport, x, minY), b = worldToScreen(camera, viewport, x, maxY);
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
    }
    for (let y = Math.floor(minY / spacing) * spacing; y <= maxY; y += spacing) {
      const a = worldToScreen(camera, viewport, minX, y), b = worldToScreen(camera, viewport, maxX, y);
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
    }
    ctx.stroke();
  }
  private corners(viewport: Viewport, camera: Camera, item: VisibleItem, z: number): [Point, Point, Point, Point] {
    const { x, y, w, h } = item.node.rect;
    return [worldToScreen(camera, viewport, x, y, z), worldToScreen(camera, viewport, x + w, y, z), worldToScreen(camera, viewport, x + w, y + h, z), worldToScreen(camera, viewport, x, y + h, z)];
  }
  /**
   * Items as drawn this frame. A block that just appeared rises from the
   * ground (with a slight overshoot) and fades in; what stands on it rides
   * along, and children of a rising area follow in a cascade.
   */
  private animate(set: VisibleSet, state: RenderState): VisibleItem[] {
    const appear = state.motion?.appear;
    if (!appear?.size || state.reducedMotion) return set.items;
    const lift = new Float64Array(set.items.length);
    return set.items.map((item, index) => {
      const below = item.parent >= 0 ? lift[item.parent]! : 0;
      const start = appear.get(item.node.id);
      let rise = 1, fade = 1;
      if (start !== undefined && state.time - start < RISE_MS) {
        const t = (state.time - start) / RISE_MS;
        rise = t <= 0 ? 0 : easeOutBack(t);
        fade = Math.max(0, Math.min(1, t * 3));
      }
      const height = item.zTop - item.zBase;
      lift[index] = below + height * (rise - 1);
      if (below === 0 && rise === 1) return item;
      const zBase = item.zBase + below;
      return { ...item, zBase, zTop: zBase + height * Math.max(0, rise), alpha: item.alpha * fade };
    });
  }
  /** Corner radius in world units: proportional to the footprint, gentler for large areas, none when too small to see. */
  private radius(item: VisibleItem, camera: Camera): number {
    const rounding = this.theme.style?.rounding ?? 0;
    if (!rounding || item.size < SOFT_PX) return 0;
    const side = Math.min(item.node.rect.w, item.node.rect.h);
    const r = Math.min(side * rounding, 14 + side * 0.06);
    return r * camera.scale >= 1 ? r : 0;
  }
  /** Path of a footprint at elevation z (optionally grown and shifted on screen): a diamond, or a rounded one. */
  private footprint(ctx: CanvasRenderingContext2D, viewport: Viewport, camera: Camera, rect: { x: number; y: number; w: number; h: number }, z: number, r: number, grow = 0, dx = 0, dy = 0): void {
    ctx.beginPath();
    this.addFootprint(ctx, viewport, camera, rect, z, r, grow, dx, dy);
  }
  private addFootprint(ctx: CanvasRenderingContext2D, viewport: Viewport, camera: Camera, rect: { x: number; y: number; w: number; h: number }, z: number, r: number, grow = 0, dx = 0, dy = 0): void {
    const x = rect.x - grow, y = rect.y - grow, w = rect.w + grow * 2, h = rect.h + grow * 2;
    const k = camera.scale, d = this.dpr;
    const origin = worldToScreen(camera, viewport, x, y, z);
    // Path points are transformed when added, so the footprint can be drawn in its own plane and stroked/filled afterwards.
    ctx.setTransform(d * ISO_X * k, d * ISO_Y * k, -d * ISO_X * k, d * ISO_Y * k, d * (origin.x + dx), d * (origin.y + dy));
    if (r > 0) ctx.roundRect(0, 0, w, h, Math.min(r + grow, w / 2, h / 2));
    else ctx.rect(0, 0, w, h);
    ctx.setTransform(d, 0, 0, d, 0, 0);
  }
  private topPath(ctx: CanvasRenderingContext2D, viewport: Viewport, camera: Camera, item: VisibleItem, r: number): void {
    if (r > 0) this.footprint(ctx, viewport, camera, item.node.rect, item.zTop, r);
    else polygon(ctx, this.corners(viewport, camera, item, item.zTop));
  }
  /** Soft shadow cast forward onto the surface the block stands on, longer for taller blocks. */
  private shadow(ctx: CanvasRenderingContext2D, viewport: Viewport, camera: Camera, item: VisibleItem, alpha: number): void {
    const wallPx = (item.zTop - item.zBase) * camera.scale;
    if (wallPx < 1) return;
    const r = this.radius(item, camera);
    ctx.fillStyle = this.theme.style!.shadow!;
    for (const [reach, strength] of [[1, 0.55], [0.55, 0.45]] as const) {
      ctx.globalAlpha = alpha * strength;
      this.footprint(ctx, viewport, camera, item.node.rect, item.zBase, r, 0, wallPx * 0.55 * reach, Math.min(14, 1.5 + wallPx * 0.35) * reach);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
  private prism(ctx: CanvasRenderingContext2D, viewport: Viewport, camera: Camera, item: VisibleItem, alpha: number, hovered: boolean, paletteOverride?: string): void {
    const palette = this.palettes.get(paletteOverride ?? paletteKey(item.node), item.node.depth);
    const r = this.radius(item, camera);
    ctx.globalAlpha = alpha;
    const wallPx = (item.zTop - item.zBase) * camera.scale;
    if (wallPx >= 0.75 && item.size > 3) {
      if (r > 0) this.roundedWalls(ctx, viewport, camera, item, r, palette.left, palette.right);
      else {
        const top = this.corners(viewport, camera, item, item.zTop), bottom = this.corners(viewport, camera, item, item.zBase);
        ctx.fillStyle = palette.left; polygon(ctx, [top[3], top[2], bottom[2], bottom[3]]); ctx.fill();
        ctx.fillStyle = palette.right; polygon(ctx, [top[1], top[2], bottom[2], bottom[1]]); ctx.fill();
      }
    }
    ctx.fillStyle = hovered ? palette.hoverTop : palette.top;
    this.topPath(ctx, viewport, camera, item, r); ctx.fill();
    const sheen = this.theme.style?.sheen;
    if (sheen && item.size > 28) {
      // A soft highlight from the back corner, as on a rounded, slightly glossy surface.
      const { x, y, w, h } = item.node.rect;
      const back = worldToScreen(camera, viewport, x, y, item.zTop), front = worldToScreen(camera, viewport, x + w, y + h, item.zTop);
      const light = ctx.createLinearGradient(back.x, back.y, front.x, front.y);
      light.addColorStop(0, `rgba(255,255,255,${sheen})`); light.addColorStop(0.55, 'rgba(255,255,255,0)');
      ctx.fillStyle = light; ctx.fill();
    }
    if (item.size > 14) { ctx.strokeStyle = this.theme.outline; ctx.lineWidth = 1; ctx.stroke(); }
    if (item.node.kind === 'group' && item.size > 30) {
      // Projection districts get a dashed rim: they are spatial groupings, not entities.
      ctx.setLineDash([4, 4]); ctx.strokeStyle = this.theme.text.secondary; ctx.lineWidth = 1; this.topPath(ctx, viewport, camera, item, r); ctx.stroke(); ctx.setLineDash([]);
    }
    ctx.globalAlpha = 1;
  }
  /**
   * Walls of a rounded block. A vertically extruded convex footprint is the
   * union of its bottom outline and the band between its leftmost and
   * rightmost points; the two wall tones meet at the front corner, blended
   * across its curve.
   */
  private roundedWalls(ctx: CanvasRenderingContext2D, viewport: Viewport, camera: Camera, item: VisibleItem, r: number, left: string, right: string): void {
    const { x, y, w, h } = item.node.rect, s = r * Math.SQRT1_2;
    const leftAt = (z: number) => worldToScreen(camera, viewport, x + r - s, y + h - r + s, z), rightAt = (z: number) => worldToScreen(camera, viewport, x + w - r + s, y + r - s, z);
    const front = worldToScreen(camera, viewport, x + w - r + s, y + h - r + s, item.zTop);
    const a = leftAt(item.zTop), b = rightAt(item.zTop), c = rightAt(item.zBase), d = leftAt(item.zBase);
    this.footprint(ctx, viewport, camera, item.node.rect, item.zBase, r);
    ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.lineTo(c.x, c.y); ctx.lineTo(d.x, d.y); ctx.closePath();
    const edge = Math.max(1, r * camera.scale * ISO_X * Math.SQRT2 * 0.9);
    const shade = ctx.createLinearGradient(front.x - edge, 0, front.x + edge, 0);
    shade.addColorStop(0, left); shade.addColorStop(1, right);
    ctx.fillStyle = shade; ctx.fill();
  }
  /** Comparison fading: ghosts are translucent; with dimming on, blocks with nothing changed in or below them recede. */
  private changeAlpha(item: VisibleItem, comparison: NonNullable<RenderState['comparison']>): number {
    const change = item.node.change;
    if (change?.status === 'removed') return this.theme.change.ghostAlpha;
    if (!comparison.dimUnchanged || item.node.type === 'repository') return 1;
    return change || item.node.changes ? 1 : this.theme.change.unchangedAlpha;
  }
  private changeOverlay(ctx: CanvasRenderingContext2D, viewport: Viewport, camera: Camera, item: VisibleItem, alpha: number, state: RenderState): void {
    const node = item.node, colors = this.theme.change;
    const status = node.change?.status;
    if (item.size < 4) return;
    const r = this.radius(item, camera);
    // A change that just happened flashes, then settles into its status color.
    const start = state.reducedMotion ? undefined : state.motion?.flash.get(node.id);
    const boost = start === undefined ? 0 : Math.max(0, 1 - (state.time - start) / FLASH_MS) ** 2;
    if (status && status !== 'unchanged') {
      const color = colors[status];
      ctx.save();
      // Open containers keep their children readable: outline only.
      if (!item.open) { ctx.globalAlpha = Math.min(1, alpha * (status === 'removed' ? 0.35 : 0.42) * (1 + 1.3 * boost)); ctx.fillStyle = color; this.topPath(ctx, viewport, camera, item, r); ctx.fill(); }
      ctx.globalAlpha = Math.min(1, alpha * 1.6);
      ctx.strokeStyle = color; ctx.lineWidth = (item.open ? 2 : 1.6) + 2 * boost; ctx.lineJoin = 'round';
      if (status === 'removed') ctx.setLineDash([5, 4]);
      this.topPath(ctx, viewport, camera, item, r); ctx.stroke();
      if (boost > 0.02 && !item.open && status !== 'removed') {
        // A ripple spreading out from the changed block.
        ctx.setLineDash([]); ctx.globalAlpha = alpha * boost * 0.9; ctx.lineWidth = 1.5;
        this.footprint(ctx, viewport, camera, node.rect, item.zTop, r, (1 - boost) * 10 / camera.scale); ctx.stroke();
      }
      ctx.restore();
    } else if (node.change?.facets.length && item.size > 10) {
      // Only its relationships or findings changed: a dotted rim.
      ctx.save(); ctx.globalAlpha = alpha; ctx.strokeStyle = colors.modified; ctx.lineWidth = 1.2; ctx.setLineDash([1.5, 3]); this.topPath(ctx, viewport, camera, item, r); ctx.stroke(); ctx.restore();
    }
    const counts = node.changes;
    if (counts && !item.open && item.size > 34 && status !== 'removed') this.changeBadge(ctx, viewport, camera, item, counts, alpha);
  }
  /** Entities the blast radius reaches, plus their ancestors (computed once per overlay). */
  private impactLit(scene: Scene, impact: ImpactOverlay): Set<string> {
    if (this.impactCache?.key === impact) return this.impactCache.lit;
    const lit = new Set<string>([...impact.areas.keys()]);
    for (const id of impact.distances.keys()) {
      for (let node: NodeSummary | undefined = scene.nodes.get(id); node; node = node.spatialParentId ? scene.nodes.get(node.spatialParentId) : undefined) lit.add(node.id);
      lit.add(id);
    }
    this.impactCache = { key: impact, lit };
    return lit;
  }
  private impactCache?: { key: ImpactOverlay; lit: Set<string> };
  /** Origin ringed; reached blocks tinted by hop count with the count written on them; closed areas badged. */
  private impactOverlay(ctx: CanvasRenderingContext2D, viewport: Viewport, camera: Camera, item: VisibleItem, alpha: number, impact: ImpactOverlay): void {
    if (item.size < 4) return;
    const colors = impactColors(this.theme);
    const node = item.node, r = this.radius(item, camera);
    const distance = impact.distances.get(node.id);
    ctx.save();
    if (distance === 0) {
      ctx.globalAlpha = Math.min(1, alpha * 1.6); ctx.strokeStyle = colors.origin; ctx.lineWidth = item.open ? 2.4 : 2.2; ctx.lineJoin = 'round';
      this.topPath(ctx, viewport, camera, item, r); ctx.stroke();
    } else if (distance !== undefined) {
      const color = mixHex(colors.near, colors.far, impact.depth > 1 ? (distance - 1) / (impact.depth - 1) : 0);
      if (!item.open) { ctx.globalAlpha = Math.min(1, alpha * 0.5); ctx.fillStyle = color; this.topPath(ctx, viewport, camera, item, r); ctx.fill(); }
      ctx.globalAlpha = Math.min(1, alpha * 1.5); ctx.strokeStyle = color; ctx.lineWidth = 1.6; ctx.lineJoin = 'round';
      this.topPath(ctx, viewport, camera, item, r); ctx.stroke();
      if (!item.open && item.size > 18) {
        // The hop count, so distance never depends on color alone.
        const { x, y, w, h } = node.rect;
        const anchor = worldToScreen(camera, viewport, x + Math.min(w, h) * 0.12, y + Math.min(w, h) * 0.12, item.zTop);
        ctx.globalAlpha = Math.max(0.7, alpha); ctx.fillStyle = color;
        ctx.beginPath(); ctx.arc(anchor.x, anchor.y, 7, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = this.theme.dark ? '#0b1020' : '#ffffff'; ctx.font = `800 9px ${this.font}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(String(distance), anchor.x, anchor.y + 0.5);
      }
    }
    const area = impact.areas.get(node.id);
    if (area && !item.open && item.size > 34 && distance === undefined) {
      const { x, y, w, h } = node.rect;
      const anchor = worldToScreen(camera, viewport, x + w * 0.5, y + h - Math.min(h, w) * 0.1, item.zTop);
      const text = `◎ ${compactNumber(area.count)} affected · ${area.distance} hop${area.distance === 1 ? '' : 's'}`;
      ctx.globalAlpha = Math.max(0.65, alpha); ctx.font = `700 10px ${this.font}`; ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
      const width = ctx.measureText(text).width + 14;
      ctx.fillStyle = this.theme.dark ? 'rgba(8,12,26,0.82)' : 'rgba(255,253,248,0.92)';
      roundRect(ctx, anchor.x - width / 2, anchor.y - 8, width, 16, 8); ctx.fill();
      ctx.fillStyle = mixHex(colors.near, colors.far, impact.depth > 1 ? (area.distance - 1) / (impact.depth - 1) : 0); ctx.fillText(text, anchor.x, anchor.y + 0.5);
    }
    ctx.restore();
  }
  /** Changes hidden inside a closed area: one count per status. */
  private changeBadge(ctx: CanvasRenderingContext2D, viewport: Viewport, camera: Camera, item: VisibleItem, counts: NonNullable<NodeSummary['changes']>, alpha: number): void {
    const parts = ([['added', '+'], ['modified', '~'], ['moved', '→'], ['removed', '−']] as const).filter(([key]) => counts[key] > 0);
    if (!parts.length) return;
    const { x, y, w, h } = item.node.rect;
    const anchor = worldToScreen(camera, viewport, x + w * 0.5, y + Math.min(h, w) * 0.08, item.zTop);
    ctx.save();
    ctx.globalAlpha = Math.max(0.6, alpha);
    ctx.font = `700 10px ${this.font}`; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    const texts = parts.map(([key, glyph]) => ({ key, text: `${glyph}${compactNumber(counts[key])}` }));
    const widths = texts.map(part => ctx.measureText(part.text).width);
    const total = widths.reduce((sum, width) => sum + width, 0) + 8 * (texts.length - 1) + 12;
    let cursor = anchor.x - total / 2;
    ctx.fillStyle = this.theme.dark ? 'rgba(8,12,26,0.82)' : 'rgba(255,253,248,0.92)';
    roundRect(ctx, cursor, anchor.y - 8, total, 16, 8); ctx.fill();
    cursor += 6;
    texts.forEach((part, i) => { ctx.fillStyle = this.theme.change[part.key]; ctx.fillText(part.text, cursor, anchor.y + 0.5); cursor += widths[i]! + 8; });
    ctx.restore();
  }
  private outline(ctx: CanvasRenderingContext2D, viewport: Viewport, camera: Camera, item: VisibleItem, color: string, width: number, glow: boolean, dash?: number[]): void {
    ctx.save();
    if (glow) { ctx.shadowColor = color; ctx.shadowBlur = 14; }
    if (dash) ctx.setLineDash(dash);
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineJoin = 'round';
    this.topPath(ctx, viewport, camera, item, this.radius(item, camera)); ctx.stroke();
    ctx.restore();
  }
  private diagnosticMarker(ctx: CanvasRenderingContext2D, viewport: Viewport, camera: Camera, item: VisibleItem, alpha: number): void {
    const { x, y, w } = item.node.rect;
    const p = worldToScreen(camera, viewport, x + w * 0.82, y + Math.min(item.node.rect.h, w) * 0.18, item.zTop);
    const r = Math.min(7, 3 + item.size / 40);
    ctx.globalAlpha = Math.max(0.5, alpha);
    ctx.fillStyle = this.theme.diagnostic;
    ctx.beginPath(); ctx.moveTo(p.x, p.y - r); ctx.lineTo(p.x + r, p.y); ctx.lineTo(p.x, p.y + r); ctx.lineTo(p.x - r, p.y); ctx.closePath(); ctx.fill();
    if (item.size > 60) {
      ctx.font = `600 10px ${this.font}`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.lineWidth = 3; ctx.strokeStyle = this.theme.text.halo; ctx.strokeText(String(item.node.diagnostics), p.x + r + 2, p.y);
      ctx.fillStyle = this.theme.diagnostic; ctx.fillText(String(item.node.diagnostics), p.x + r + 2, p.y);
    }
    ctx.globalAlpha = 1;
  }
  private collectLabel(labels: Label[], viewport: Viewport, camera: Camera, item: VisibleItem, state: RenderState, alpha: number, dimmed: boolean): void {
    if (item.tier === 'hidden' || alpha < 0.25) return;
    const node = item.node, theme = this.theme;
    const important = node.id === state.selectedId || node.id === state.hoveredId;
    const color = dimmed ? theme.text.secondary : theme.text.primary;
    if (item.tier === 'district') {
      // The repository name is already in the header; its label would hide the first area.
      if (node.type === 'repository') return;
      const top = worldToScreen(camera, viewport, node.rect.x, node.rect.y, item.zTop);
      const size = node.type === 'application' ? 15 : node.type === 'repository' ? 13 : 11;
      const text = `${state.comparison ? changeGlyph(node) : ''}${node.type === 'repository' ? node.name : node.kind === 'group' ? `${node.name}` : node.type === 'directory' ? `${node.name}/` : node.name}`;
      labels.push({ x: top.x, y: top.y - 4, align: 'above', priority: 1e9 - node.depth * 1e6 + item.size, lines: [{ text, font: `${node.type === 'application' ? 700 : 600} ${size}px ${this.font}`, color: theme.text.district }] });
      return;
    }
    const { x, y, w, h } = node.rect;
    const center = worldToScreen(camera, viewport, x + w / 2, y + h / 2, item.zTop);
    const big = node.type === 'application';
    const nameSize = big ? Math.min(22, 13 + item.size / 60) : Math.min(14, 10 + item.size / 70);
    const lines: Label['lines'] = [{ text: `${state.comparison ? changeGlyph(node) : ''}${displayName(node)}`, font: `${big || important ? 700 : 600} ${nameSize.toFixed(1)}px ${this.font}`, color }];
    if (item.tier === 'summary' || item.tier === 'detail') {
      const summary = summaryLine(node);
      if (summary) lines.push({ text: summary, font: `500 ${Math.max(9.5, nameSize - 2.5).toFixed(1)}px ${this.font}`, color: theme.text.secondary });
    }
    if (item.tier === 'detail') {
      const detail = detailLine(node);
      if (detail) lines.push({ text: detail, font: `400 ${Math.max(9, nameSize - 3).toFixed(1)}px ${node.detail?.startsWith('(') ? MONO : this.font}`, color: theme.text.secondary });
    }
    labels.push({ x: center.x, y: center.y, align: 'center', priority: (important ? 2e9 : 0) + item.size, lines });
  }
  private labels(ctx: CanvasRenderingContext2D, labels: Label[]): void {
    labels.sort((a, b) => b.priority - a.priority);
    const placed: { x0: number; y0: number; x1: number; y1: number }[] = [];
    ctx.textBaseline = 'middle'; ctx.textAlign = 'center'; ctx.lineJoin = 'round';
    let count = 0;
    for (const label of labels) {
      if (count > 450) break;
      let width = 0, height = 0;
      const metrics = label.lines.map(line => { ctx.font = line.font; const w = Math.min(320, ctx.measureText(line.text).width); const h = parseFloat(/(\d+(?:\.\d+)?)px/.exec(line.font)![1]!) * 1.25; width = Math.max(width, w); height += h; return { w, h }; });
      const y0 = label.align === 'above' ? label.y - height : label.y - height / 2;
      const box = { x0: label.x - width / 2 - 3, y0: y0 - 2, x1: label.x + width / 2 + 3, y1: y0 + height + 2 };
      if (placed.some(other => box.x0 < other.x1 && box.x1 > other.x0 && box.y0 < other.y1 && box.y1 > other.y0)) continue;
      placed.push(box); count++;
      let cursor = y0;
      label.lines.forEach((line, i) => {
        const h = metrics[i]!.h;
        ctx.font = line.font;
        const text = fit(ctx, line.text, 320);
        ctx.lineWidth = 3.5; ctx.strokeStyle = this.theme.text.halo; ctx.strokeText(text, label.x, cursor + h / 2);
        ctx.fillStyle = line.color; ctx.fillText(text, label.x, cursor + h / 2);
        cursor += h;
      });
    }
  }
  private anchor(viewport: Viewport, camera: Camera, item: VisibleItem): Point {
    const { x, y, w, h } = item.node.rect;
    return worldToScreen(camera, viewport, x + w / 2, y + h / 2, item.zTop);
  }
  private resolve(set: VisibleSet, id: string, ancestors: string[]): { item: VisibleItem; hidden: boolean } | undefined {
    const direct = set.index.get(id);
    if (direct !== undefined) return { item: set.items[direct]!, hidden: false };
    for (let i = ancestors.length - 1; i >= 0; i--) {
      const index = set.index.get(ancestors[i]!);
      if (index !== undefined) return { item: set.items[index]!, hidden: true };
    }
    return undefined;
  }
  private edges(ctx: CanvasRenderingContext2D, viewport: Viewport, camera: Camera, set: VisibleSet, edges: EdgeOverlay[]): void {
    const drawn = new Map<string, { from: Point; to: Point; count: number; color: string; hidden: boolean; emphasized: boolean; change?: 'added' | 'removed' }>();
    for (const edge of edges) {
      const from = this.resolve(set, edge.from, edge.fromAncestors), to = this.resolve(set, edge.to, edge.toAncestors);
      if (!from || !to || from.item === to.item) continue;
      // Merge edges that collapse onto the same visible endpoints at this LOD.
      const key = `${from.item.node.id}>${to.item.node.id}>${edge.type}>${edge.change ?? ''}`;
      const existing = drawn.get(key);
      if (existing) { existing.count += edge.count; existing.emphasized ||= !!edge.emphasized; continue; }
      drawn.set(key, { from: this.anchor(viewport, camera, from.item), to: this.anchor(viewport, camera, to.item), count: edge.count, color: this.theme.relation[edge.type] ?? this.theme.fallbackRelation, hidden: from.hidden || to.hidden, emphasized: !!edge.emphasized, ...(edge.change ? { change: edge.change } : {}) });
    }
    for (const edge of drawn.values()) {
      const { from, to } = edge;
      const control = curveControl(from, to);
      ctx.save();
      if (this.theme.style?.rounding) ctx.lineCap = 'round';
      const width = Math.min(5, 1.4 + Math.log2(edge.count) * 0.8) + (edge.emphasized ? 1.2 : 0);
      if (edge.change === 'added') {
        // Added since the baseline: a halo in the added color under the typed edge.
        ctx.strokeStyle = this.theme.change.added; ctx.globalAlpha = 0.45; ctx.lineWidth = width + 5;
        ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.quadraticCurveTo(control.x, control.y, to.x, to.y); ctx.stroke();
      }
      ctx.strokeStyle = edge.change === 'removed' ? this.theme.change.removed : edge.color; ctx.globalAlpha = edge.change === 'removed' ? 0.75 : edge.emphasized ? 1 : 0.85;
      ctx.lineWidth = width;
      if (edge.hidden || edge.change === 'removed') ctx.setLineDash(edge.change === 'removed' ? [3, 5] : [6, 5]);
      ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.quadraticCurveTo(control.x, control.y, to.x, to.y); ctx.stroke();
      ctx.setLineDash([]);
      if (edge.change === 'removed') edge.color = this.theme.change.removed;
      // Arrowhead along the curve tangent at the target.
      const angle = Math.atan2(to.y - control.y, to.x - control.x), size = 7 + ctx.lineWidth;
      ctx.fillStyle = edge.color; ctx.beginPath();
      ctx.moveTo(to.x, to.y); ctx.lineTo(to.x - size * Math.cos(angle - 0.4), to.y - size * Math.sin(angle - 0.4)); ctx.lineTo(to.x - size * Math.cos(angle + 0.4), to.y - size * Math.sin(angle + 0.4)); ctx.closePath(); ctx.fill();
      ctx.beginPath(); ctx.arc(from.x, from.y, 3, 0, Math.PI * 2); ctx.fill();
      if (edge.count > 1) {
        const mid = { x: 0.25 * from.x + 0.5 * control.x + 0.25 * to.x, y: 0.25 * from.y + 0.5 * control.y + 0.25 * to.y };
        const text = compactNumber(edge.count);
        ctx.font = `700 10px ${this.font}`; const width = ctx.measureText(text).width + 10;
        ctx.fillStyle = edge.color; roundRect(ctx, mid.x - width / 2, mid.y - 8, width, 16, 8); ctx.fill();
        ctx.fillStyle = this.theme.dark ? '#0b1020' : '#ffffff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(text, mid.x, mid.y + 0.5);
      }
      ctx.restore();
    }
  }
  private unresolvedStub(ctx: CanvasRenderingContext2D, viewport: Viewport, camera: Camera, scene: Scene, set: VisibleSet, unresolved: { nodeId: string; count: number }): void {
    const node = scene.nodes.get(unresolved.nodeId);
    const target = node ? this.resolve(set, node.id, ancestorChain(scene, node)) : undefined;
    if (!target) return;
    const from = this.anchor(viewport, camera, target.item);
    const to = { x: from.x + 70, y: from.y - 62 };
    ctx.save();
    ctx.strokeStyle = this.theme.diagnostic; ctx.lineWidth = 1.6; ctx.setLineDash([3, 4]);
    ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.quadraticCurveTo(from.x + 10, to.y, to.x, to.y); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = this.theme.diagnostic; ctx.beginPath(); ctx.arc(to.x, to.y, 9, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = this.theme.dark ? '#0b1020' : '#fff'; ctx.font = `800 12px ${this.font}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('?', to.x, to.y + 0.5);
    ctx.font = `600 10.5px ${this.font}`; ctx.textAlign = 'left'; ctx.lineWidth = 3; ctx.strokeStyle = this.theme.text.halo;
    const text = `${unresolved.count} unresolved HTTP call${unresolved.count === 1 ? '' : 's'}`;
    ctx.strokeText(text, to.x + 13, to.y); ctx.fillStyle = this.theme.diagnostic; ctx.fillText(text, to.x + 13, to.y);
    ctx.restore();
  }
  /**
   * The branch being played: a faint track where the flow goes, and along the
   * part it has reached a glowing line with dashes streaming from source to
   * target, brightest at the front. Links joining the same visible blocks
   * (zoomed out) are drawn once. Stops are marked by state.
   */
  private flow(ctx: CanvasRenderingContext2D, viewport: Viewport, camera: Camera, set: VisibleSet, flow: FlowOverlay, state: RenderState): void {
    const color = this.theme.flow.step, bright = this.theme.flow.indicator;
    const moving = flow.moving && !state.reducedMotion;
    const links = new Map<string, { a: Point; b: Point; fill: number }>();
    for (const link of flow.links) {
      const from = this.resolve(set, link.from, link.fromAncestors), to = this.resolve(set, link.to, link.toAncestors);
      if (!from || !to || from.item === to.item) continue;
      const key = `${from.item.node.id}>${to.item.node.id}`;
      const existing = links.get(key);
      if (existing) { existing.fill = Math.max(existing.fill, link.fill); continue; }
      links.set(key, { a: this.anchor(viewport, camera, from.item), b: this.anchor(viewport, camera, to.item), fill: link.fill });
    }
    ctx.save();
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const { a, b, fill } of links.values()) {
      const c = curveControl(a, b);
      // The track.
      ctx.setLineDash([2, 6]); ctx.lineDashOffset = 0; ctx.strokeStyle = color; ctx.globalAlpha = fill > 0 ? 0.4 : 0.25; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.quadraticCurveTo(c.x, c.y, b.x, b.y); ctx.stroke();
      if (fill <= 0) continue;
      const points = sampleQuadratic(a, c, b, fill);
      // The flow: a soft glow, then dashes streaming toward the target.
      ctx.setLineDash([]); ctx.globalAlpha = 0.3; ctx.lineWidth = 9;
      polyline(ctx, points); ctx.stroke();
      ctx.globalAlpha = 1; ctx.lineWidth = 3; ctx.strokeStyle = color;
      polyline(ctx, points); ctx.stroke();
      ctx.setLineDash([9, 13]); ctx.lineDashOffset = moving ? -((state.time * 0.045) % 22) : 0; ctx.strokeStyle = bright; ctx.lineWidth = 2.2;
      polyline(ctx, points); ctx.stroke();
      ctx.setLineDash([]);
      if (fill < 1) {
        // The front: the newest stretch of the flow, brightening toward its edge.
        const tail = sampleQuadratic(a, c, b, fill, Math.max(0, fill - 0.18));
        const start = tail[0]!, end = tail.at(-1)!;
        const gradient = ctx.createLinearGradient(start.x, start.y, end.x, end.y);
        gradient.addColorStop(0, transparent(bright)); gradient.addColorStop(1, bright);
        ctx.strokeStyle = gradient; ctx.lineWidth = 5; ctx.shadowColor = color; ctx.shadowBlur = 14;
        polyline(ctx, tail); ctx.stroke();
        ctx.shadowBlur = 0;
      } else {
        // Arrived: an arrowhead along the curve's tangent at the target.
        const angle = Math.atan2(b.y - c.y, b.x - c.x), size = 9;
        ctx.fillStyle = color; ctx.beginPath();
        ctx.moveTo(b.x, b.y); ctx.lineTo(b.x - size * Math.cos(angle - 0.42), b.y - size * Math.sin(angle - 0.42)); ctx.lineTo(b.x - size * Math.cos(angle + 0.42), b.y - size * Math.sin(angle + 0.42)); ctx.closePath(); ctx.fill();
      }
    }
    // Stops: one mark per visible block, the most advanced state winning.
    const rank = { front: 0, reached: 1, ahead: 2 } as const;
    const marks = new Map<string, { at: Point; state: keyof typeof rank }>();
    for (const stop of [...flow.stops].sort((x, y) => rank[x.state] - rank[y.state])) {
      const at = this.resolve(set, stop.entityId, stop.ancestors);
      if (!at || marks.has(at.item.node.id)) continue;
      marks.set(at.item.node.id, { at: this.anchor(viewport, camera, at.item), state: stop.state });
    }
    for (const { at, state: mark } of [...marks.values()].reverse()) {
      if (mark === 'ahead') { ctx.globalAlpha = 0.7; ctx.strokeStyle = color; ctx.lineWidth = 1.6; ctx.fillStyle = this.theme.dark ? '#141a30' : '#ffffff'; ctx.beginPath(); ctx.arc(at.x, at.y, 4.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); continue; }
      if (mark === 'front' && !state.reducedMotion) {
        const pulse = (state.time % 1400) / 1400;
        ctx.globalAlpha = 1 - pulse; ctx.strokeStyle = color; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(at.x, at.y, 8 + pulse * 16, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.globalAlpha = 1; ctx.fillStyle = color; ctx.strokeStyle = bright; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(at.x, at.y, mark === 'front' ? 7 : 5.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
    ctx.restore();
  }
  /**
   * The coverage category a block is drawn in: files by their own; symbols by
   * their file's; routes, endpoints, commands and tasks are entry points;
   * areas keep their colors and get a badge instead.
   */
  private coverageResolver(scene: Scene, coverage: CoverageOverlay): (node: NodeSummary) => string | undefined {
    if (this.coverageCache?.key === coverage) return this.coverageCache.resolve;
    const cache = new Map<string, string | undefined>();
    const resolve = (node: NodeSummary): string | undefined => {
      if (cache.has(node.id)) return cache.get(node.id);
      let found: string | undefined;
      if (node.type === 'file') found = coverage.files.get(node.id);
      else if (['route', 'api_endpoint', 'command', 'scheduled_task'].includes(node.type)) found = 'entry';
      else if (node.kind === 'entity' && !['repository', 'application', 'directory', 'database_table'].includes(node.type)) {
        const parent = node.spatialParentId ? scene.nodes.get(node.spatialParentId) : undefined;
        found = parent ? resolve(parent) : undefined;
      }
      cache.set(node.id, found);
      return found;
    };
    this.coverageCache = { key: coverage, resolve };
    return resolve;
  }
  private coverageCache?: { key: CoverageOverlay; resolve: (node: NodeSummary) => string | undefined };
  /** A closed area: the share of its code files that flows touch (entry points included), as a small bar and a percentage. */
  private coverageBadge(ctx: CanvasRenderingContext2D, viewport: Viewport, camera: Camera, item: VisibleItem, alpha: number, counts: Record<string, number>): void {
    if (item.size < 34) return;
    const code = Object.entries(counts).filter(([key]) => !NOT_MEASURED.has(key)).reduce((sum, [, count]) => sum + count, 0);
    if (!code) return;
    const order = ['entry', 'flow', 'supporting', 'explained', 'test', 'config', 'outside', 'unreached'];
    const touched = (counts.entry ?? 0) + (counts.flow ?? 0);
    const { x, y, w, h } = item.node.rect;
    const anchor = worldToScreen(camera, viewport, x + w * 0.5, y + h - Math.min(h, w) * 0.12, item.zTop);
    const text = `${Math.round((touched / code) * 100)}% in flows`;
    ctx.save();
    ctx.globalAlpha = Math.max(0.75, alpha);
    ctx.font = `700 10px ${this.font}`; ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
    const width = Math.max(64, ctx.measureText(text).width + 14);
    ctx.fillStyle = this.theme.dark ? 'rgba(8,12,26,0.86)' : 'rgba(255,253,248,0.94)';
    roundRect(ctx, anchor.x - width / 2, anchor.y - 11, width, 22, 7); ctx.fill();
    let cursor = anchor.x - width / 2 + 5;
    for (const key of order) {
      const share = (counts[key] ?? 0) / code;
      if (!share) continue;
      ctx.fillStyle = this.palettes.get(`coverage:${key}`, 0).top;
      ctx.fillRect(cursor, anchor.y + 5, share * (width - 10), 3);
      cursor += share * (width - 10);
    }
    ctx.fillStyle = this.theme.text.primary; ctx.fillText(text, anchor.x, anchor.y - 2);
    ctx.restore();
  }
  private toneColor(tone: StopTone): string {
    const dark = this.theme.dark;
    const colors: Record<StopTone, [string, string]> = { client: ['#f472f6', '#c026d3'], call: ['#a78bfa', '#7c3aed'], route: ['#60a5fa', '#2563eb'], server: ['#34d399', '#059669'], data: ['#fbbf24', '#d97706'], response: ['#fb923c', '#ea580c'], return: ['#fb7cbe', '#db2777'], console: ['#22d3ee', '#0891b2'] };
    return colors[tone][dark ? 0 : 1];
  }
  /**
   * Stops of a flow labelled on screen, whatever the zoom: a numbered pill
   * beside each block (or the area holding it), placed where it does not
   * cover another, with a leader line to its block.
   */
  private callouts(ctx: CanvasRenderingContext2D, viewport: Viewport, camera: Camera, set: VisibleSet, callouts: CalloutOverlay[]): void {
    const placed: { x0: number; y0: number; x1: number; y1: number }[] = [];
    const resolved = callouts.map(callout => ({ callout, at: this.resolve(set, callout.entityId, callout.ancestors) })).filter(item => item.at);
    // The current stop first, so it always gets the best place.
    resolved.sort((a, b) => Number(b.callout.current) - Number(a.callout.current) || a.callout.number - b.callout.number);
    ctx.save();
    ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    for (const { callout, at } of resolved) {
      const anchor = this.anchor(viewport, camera, at!.item);
      const color = this.toneColor(callout.tone);
      ctx.font = `${callout.current ? 800 : 700} ${callout.current ? 12.5 : 11}px ${this.font}`;
      const text = fit(ctx, callout.label, callout.current ? 260 : 190);
      const h = callout.current ? 24 : 20, badge = h - 6;
      const w = ctx.measureText(text).width + badge + 16;
      const candidates = [[18, -h - 10], [18, 10], [-w - 18, -h - 10], [-w - 18, 10], [-w / 2, -h - 22], [-w / 2, 16]];
      let box: { x0: number; y0: number; x1: number; y1: number } | undefined;
      for (const [dx, dy] of candidates) {
        const candidate = { x0: anchor.x + dx!, y0: anchor.y + dy!, x1: anchor.x + dx! + w, y1: anchor.y + dy! + h };
        if (candidate.x0 < 2 || candidate.y0 < 2 || candidate.x1 > viewport.width - 2 || candidate.y1 > viewport.height - 2) continue;
        if (!placed.some(other => candidate.x0 < other.x1 && candidate.x1 > other.x0 && candidate.y0 < other.y1 && candidate.y1 > other.y0)) { box = candidate; break; }
      }
      // No free place: the current stop still shows (on top), the others only keep their number on the map.
      if (!box && !callout.current) continue;
      box ??= { x0: anchor.x + 18, y0: anchor.y - h - 10, x1: anchor.x + 18 + w, y1: anchor.y - 10 };
      placed.push(box);
      const near = { x: Math.max(box.x0, Math.min(anchor.x, box.x1)), y: Math.max(box.y0, Math.min(anchor.y, box.y1)) };
      ctx.globalAlpha = callout.current ? 1 : 0.92;
      ctx.strokeStyle = color; ctx.lineWidth = callout.current ? 2 : 1.4;
      ctx.beginPath(); ctx.moveTo(anchor.x, anchor.y); ctx.lineTo(near.x, near.y); ctx.stroke();
      if (callout.current) { ctx.shadowColor = color; ctx.shadowBlur = 16; }
      ctx.fillStyle = this.theme.dark ? 'rgba(10,14,30,0.94)' : 'rgba(255,255,255,0.97)';
      roundRect(ctx, box.x0, box.y0, w, h, h / 2); ctx.fill();
      ctx.shadowBlur = 0;
      ctx.lineWidth = callout.current ? 2 : 1.2; ctx.stroke();
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(box.x0 + 3 + badge / 2, box.y0 + h / 2, badge / 2, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = this.theme.dark ? '#0b1020' : '#ffffff'; ctx.textAlign = 'center';
      ctx.font = `800 ${callout.current ? 10.5 : 9.5}px ${this.font}`;
      ctx.fillText(String(callout.number), box.x0 + 3 + badge / 2, box.y0 + h / 2 + 0.5);
      ctx.textAlign = 'left'; ctx.fillStyle = this.theme.text.primary;
      ctx.font = `${callout.current ? 800 : 700} ${callout.current ? 12.5 : 11}px ${this.font}`;
      ctx.fillText(text, box.x0 + badge + 9, box.y0 + h / 2 + 0.5);
    }
    ctx.restore();
  }
  /** Pins stacked under their block: what the flow does there that is not an entity. */
  private pins(ctx: CanvasRenderingContext2D, viewport: Viewport, camera: Camera, set: VisibleSet, pins: PinOverlay[]): void {
    const tones = { ok: this.theme.dark ? '#4ade80' : '#15803d', warn: this.theme.dark ? '#fbbf24' : '#b45309', error: this.theme.dark ? '#f87171' : '#b91c1c', info: this.theme.text.secondary };
    const stacks = new Map<string, number>();
    ctx.save();
    ctx.font = `600 10px ${this.font}`; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    for (const pin of pins) {
      const at = this.resolve(set, pin.ownerId, pin.ownerAncestors);
      if (!at) continue;
      const anchor = this.anchor(viewport, camera, at.item);
      const index = stacks.get(at.item.node.id) ?? 0;
      stacks.set(at.item.node.id, index + 1);
      if (index >= 5) continue;
      const text = fit(ctx, index === 4 ? `+ more` : pin.label, 180);
      const w = ctx.measureText(text).width + 12, x = anchor.x - w / 2, y = anchor.y + 14 + index * 17;
      ctx.globalAlpha = 0.95;
      ctx.fillStyle = this.theme.dark ? 'rgba(10,14,30,0.9)' : 'rgba(255,255,255,0.95)';
      roundRect(ctx, x, y, w, 15, 7.5); ctx.fill();
      ctx.strokeStyle = tones[pin.tone]; ctx.lineWidth = 1; ctx.stroke();
      ctx.fillStyle = tones[pin.tone]; ctx.fillText(text, x + 6, y + 8);
    }
    ctx.restore();
  }
  private sourceFace(ctx: CanvasRenderingContext2D, viewport: Viewport, camera: Camera, item: VisibleItem, source: SourceOverlay): void {
    // Street-level detail: source lines drawn onto the top face in its own plane.
    const { x, y, w, h } = item.node.rect;
    const origin = worldToScreen(camera, viewport, x, y, item.zTop);
    const k = camera.scale;
    // Lines are sized in screen pixels (13–22px) and clipped to the face, starting at the symbol.
    const first = Math.max(0, (source.focus?.startLine ?? source.start) - source.start);
    const lines = source.lines.slice(first);
    const lineHeight = Math.min(22 / k, Math.max(13 / k, h / (lines.length + 1)));
    if (lineHeight * k < 12) return;
    ctx.save();
    ctx.transform(ISO_X * k, ISO_Y * k, -ISO_X * k, ISO_Y * k, origin.x, origin.y);
    ctx.beginPath(); ctx.rect(0, 0, w, h); ctx.clip();
    ctx.fillStyle = this.theme.dark ? 'rgba(6,10,22,0.82)' : 'rgba(255,253,248,0.88)'; ctx.fillRect(0, 0, w, h);
    ctx.font = `${(lineHeight * 0.78).toFixed(3)}px ${MONO}`; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    lines.forEach((text, i) => {
      const line = source.start + first + i, top = lineHeight * (i + 1);
      if (top > h) return;
      const highlighted = source.focus && line >= source.focus.startLine && line <= source.focus.endLine;
      if (highlighted) { ctx.fillStyle = this.theme.dark ? 'rgba(255,209,102,0.16)' : 'rgba(217,72,15,0.12)'; ctx.fillRect(0, top - lineHeight / 2, w, lineHeight); }
      ctx.fillStyle = this.theme.text.secondary; ctx.fillText(String(line).padStart(4), lineHeight * 0.4, top);
      if (source.marks?.has(line)) {
        // A call site: the same mark as the source panel's gutter.
        const cx = lineHeight * 3.05, r = lineHeight * 0.2;
        ctx.fillStyle = this.theme.relation.calls ?? this.theme.fallbackRelation;
        ctx.beginPath(); ctx.moveTo(cx, top - r); ctx.lineTo(cx + r, top); ctx.lineTo(cx, top + r); ctx.lineTo(cx - r, top); ctx.closePath(); ctx.fill();
      }
      ctx.fillStyle = this.theme.text.primary; ctx.fillText(text.replace(/\t/g, '  '), lineHeight * 3.4, top);
    });
    ctx.restore();
  }
}
/** The control point of the arc drawn between two blocks (relationships and flows share it). */
function curveControl(from: Point, to: Point): Point {
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  return { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 - Math.min(220, distance * 0.35 + 20) };
}
/** Points along a quadratic curve from `start` to `end` (0..1). */
function sampleQuadratic(a: Point, c: Point, b: Point, end: number, start = 0, segments = 28): Point[] {
  const points: Point[] = [];
  const count = Math.max(2, Math.ceil(segments * (end - start)));
  for (let i = 0; i <= count; i++) {
    const t = start + ((end - start) * i) / count;
    points.push({ x: (1 - t) ** 2 * a.x + 2 * (1 - t) * t * c.x + t * t * b.x, y: (1 - t) ** 2 * a.y + 2 * (1 - t) * t * c.y + t * t * b.y });
  }
  return points;
}
function polyline(ctx: CanvasRenderingContext2D, points: Point[]): void {
  ctx.beginPath(); ctx.moveTo(points[0]!.x, points[0]!.y);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i]!.x, points[i]!.y);
}
function ancestorChain(scene: Scene, node: NodeSummary): string[] {
  const chain: string[] = [];
  for (let current = node.spatialParentId ? scene.nodes.get(node.spatialParentId) : undefined; current; current = current.spatialParentId ? scene.nodes.get(current.spatialParentId) : undefined) chain.unshift(current.id);
  return chain;
}
/** Overshoots slightly before settling, like something springing into place. */
function easeOutBack(t: number): number { const c = 1.4; return 1 + (c + 1) * (t - 1) ** 3 + c * (t - 1) ** 2; }
/** The same color fully transparent, so gradients fade without shifting hue. */
function transparent(color: string): string {
  const rgba = /^rgba?\(([^,]+),([^,]+),([^,)]+)/.exec(color.replace(/\s+/g, ''));
  if (rgba) return `rgba(${rgba[1]},${rgba[2]},${rgba[3]},0)`;
  const hex = /^#([0-9a-f]{6})$/i.exec(color);
  if (hex) { const n = parseInt(hex[1]!, 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},0)`; }
  return 'rgba(0,0,0,0)';
}
function polygon(ctx: CanvasRenderingContext2D, points: Point[]): void {
  ctx.beginPath(); ctx.moveTo(points[0]!.x, points[0]!.y);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i]!.x, points[i]!.y);
  ctx.closePath();
}
function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
function fit(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text;
  let low = 0, high = text.length;
  while (low < high) { const mid = (low + high + 1) >> 1; if (ctx.measureText(`${text.slice(0, mid)}…`).width <= max) low = mid; else high = mid - 1; }
  return `${text.slice(0, low)}…`;
}
/** Impact colors: the theme's, or defaults that read on light and dark backgrounds. */
export function impactColors(theme: Theme): { origin: string; near: string; far: string } {
  return theme.impact ?? (theme.dark ? { origin: '#38bdf8', near: '#f87171', far: '#fbbf24' } : { origin: '#0369a1', near: '#dc2626', far: '#d97706' });
}
/** Linear mix of two #rrggbb colors. */
export function mixHex(a: string, b: string, t: number): string {
  const parse = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  const x = parse(a), y = parse(b), k = Math.max(0, Math.min(1, t));
  return `#${x.map((value, i) => Math.round(value + (y[i]! - value) * k).toString(16).padStart(2, '0')).join('')}`;
}
/** Status glyph so changes read without relying on color alone. */
export function changeGlyph(node: Pick<NodeSummary, 'change'>): string {
  switch (node.change?.status) {
    case 'added': return '+ ';
    case 'removed': return '− ';
    case 'modified': return '~ ';
    case 'moved': return '→ ';
    default: return '';
  }
}
export function displayName(node: Pick<NodeSummary, 'type' | 'name' | 'kind'>): string {
  return node.type === 'directory' ? `${node.name}/` : node.name;
}
/** One-line summary for closed nodes at intermediate zoom. Missing metrics are omitted, never zero. */
export function summaryLine(node: NodeSummary): string | undefined {
  const s = node.stats;
  switch (node.type) {
    case 'application': case 'repository': case 'directory': case 'group': {
      const parts: string[] = [];
      if (s.files) parts.push(`${compactNumber(s.files)} file${s.files === 1 ? '' : 's'}`);
      if (s.endpoints && (node.type !== 'directory')) parts.push(`${compactNumber(s.endpoints)} route${s.endpoints === 1 ? '' : 's'}`);
      if (!s.files && !s.endpoints && s.symbols) parts.push(`${compactNumber(s.symbols)} symbols`);
      if (node.id.startsWith('projection:database:')) parts.push(`${compactNumber(s.descendants)} table${s.descendants === 1 ? '' : 's'}`);
      return parts.join(' · ') || undefined;
    }
    case 'file': return [node.language, node.loc !== undefined ? `${compactNumber(node.loc)} lines` : undefined].filter(Boolean).join(' · ') || 'not analyzed';
    case 'api_endpoint': case 'route': return node.detail ?? typeLabel(node.type);
    default: return typeLabel(node.type, node.role);
  }
}
export function detailLine(node: NodeSummary): string | undefined {
  const s = node.stats;
  switch (node.type) {
    case 'application': case 'repository': case 'directory': case 'group': {
      const parts: string[] = [];
      if (s.measuredLoc) parts.push(`${compactNumber(s.measuredLoc)} measured lines`);
      if (s.symbols && node.type !== 'group') parts.push(`${compactNumber(s.symbols)} symbols`);
      if (node.diagnostics) parts.push(`${node.diagnostics} unresolved`);
      if (node.id.startsWith('projection:database:')) parts.push(`${compactNumber(s.descendants)} table${s.descendants === 1 ? '' : 's'} declared by migrations`);
      return parts.join(' · ') || node.detail;
    }
    case 'file': return node.stats.symbols ? `${node.stats.symbols} symbol${node.stats.symbols === 1 ? '' : 's'}${node.diagnostics ? ` · ${node.diagnostics} unresolved` : ''}` : node.diagnostics ? `${node.diagnostics} unresolved` : undefined;
    case 'api_endpoint': case 'route': return node.path ? `${node.path.split('/').slice(-2).join('/')}${node.sourceRange ? `:${node.sourceRange.startLine}` : ''}` : undefined;
    default: return node.detail ?? (node.sourceRange ? `lines ${node.sourceRange.startLine}–${node.sourceRange.endLine}` : undefined);
  }
}
