import type { ActivityMark } from './activity';
// Canvas 2D renderer for the isometric map. Stateless per frame: everything it
// draws comes from the visible set, the camera and a RenderState.
import type { Archetype, NodeSummary } from '@engine/projection/dto';
import { ISO_X, ISO_Y, toScreen, worldToScreen, type Bounds, type Camera, type Point, type Viewport } from './camera';
import { openProgress, type LodConfig } from './lod';
import { nodeHeight, type Scene, type VisibleItem, type VisibleSet } from './scene';
import { RailCache, type Rail, type RailWorld } from './rails';
import { familyHashHue, PaletteCache, paletteKey, type Theme } from './themes';
import type { StopTone } from './map-flow';
import { compactNumber, typeLabel } from './format';
import { NOT_MEASURED } from './coverage';
import { drawIcon, drawShape, hexToHsl, ICON_PX, mixHsl, seedOf, shapeHeight, shapeTheme, type ShapeTheme, type ShapeView } from './shapes';
import type { Hsl } from './themes';

export interface EdgeOverlay { key: string; from: string; to: string; fromAncestors: string[]; toAncestors: string[]; type: string; count: number; emphasized?: boolean; change?: 'added' | 'removed' }
/**
 * A flow on the map (all of it, or one branch): its links, streaming from
 * where they start to where they lead (the way back in its own color), and
 * its stops, the ones where it starts ringed.
 */
export interface FlowOverlay {
  links: { from: string; fromAncestors: string[]; to: string; toAncestors: string[]; back: boolean }[];
  stops: { entityId: string; ancestors: string[]; start: boolean }[];
  /** The links stream (not with reduced motion). */
  moving: boolean;
}
/** A flow's stop labelled on screen next to its block (whatever the zoom), with its number. */
export interface CalloutOverlay { entityId: string; ancestors: string[]; number: number; label: string; tone: StopTone; current: boolean }
/** What a flow passes that is not an entity (middleware, a response, an effect, a gap), pinned to its block. */
export interface PinOverlay { key: string; ownerId: string; ownerAncestors: string[]; label: string; tone: 'ok' | 'warn' | 'error' | 'info' }
/** Coverage lens: files colored by category; closed areas badged with how much of them flows touch. */
export interface CoverageOverlay { files: Map<string, string>; areas: Map<string, Record<string, number>> }
/**
 * Data families: files, entry points and tables colored by family (code without
 * one in grey); closed areas badged with their main family. With `focus`, what
 * is outside that family recedes.
 */
export interface FamilyOverlay { of: Map<string, string>; areas: Map<string, Record<string, number>>; names: Map<string, string>; hues: Map<string, number>; focus?: string; /** What the `none` key means in badges (default: no tables). */ none?: string; /** A tag under an open area's front corner (a pull request's files not on the map yet, in the folder that will hold them). */ notes?: Map<string, string> }
/**
 * A measure (complexity, changes, hotspots): files by level, 1 to 4 (`none`:
 * no level), functions by their own when the lens measures them; closed areas
 * badged with how many files they hold at their highest level.
 */
export interface LevelOverlay { of: Map<string, string>; areas: Map<string, Record<string, number>>; /** Symbols without a level of their own: their file's (`inherit`), or 1 when their file has one (`simple`). */ symbols: 'inherit' | 'simple'; /** What a badge calls the files of a level (`3`: `complex`). */ words: Record<string, string> }
/** A feature in focus (the Features panel) has the same shape: its files and the areas holding them stay lit, closed areas say how many. */
/** Another view of the split map, drawn on the overview: the part of the plane it shows (so its size tells its zoom), numbered. */
export interface FrameOverlay { key: string; number: number; bounds: Bounds; /** The view in use. */ active: boolean; /** On the current page (the others are dashed). */ shown: boolean }
export interface SourceOverlay { nodeId: string; start: number; lines: string[]; focus?: { startLine: number; endLine: number }; /** Lines where the symbol calls, renders or references an indexed entity. */ marks?: Set<number> }
export interface RenderState {
  activity?: ActivityMark[];
  selectedId?: string; hoveredId?: string;
  /** When set, nodes outside it (and outside their ancestors) are dimmed. */
  emphasis?: Set<string>;
  /** With `emphasis`: nodes whose whole content stays lit too (the selection, what it is connected to). */
  within?: Set<string>;
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
  families?: FamilyOverlay;
  /** Files colored by a measure's level. */
  measure?: LevelOverlay;
  feature?: FamilyOverlay;
  /** Files colored by the person who changed each most (the `none` key: nobody in the window). */
  people?: FamilyOverlay;
  /** One person in focus: the files they changed and the areas holding them stay lit. */
  person?: FamilyOverlay;
  /** An explanation open (what it links), or the one link the pointer is on: lit, the rest recedes. Wins over a feature or person. */
  explanation?: FamilyOverlay;
  /** What a hovered explanation link names: outlined, or pointed at from the edge of the map when it is off screen. */
  pointer?: { id: string; ancestors: string[] };
  /** One pull request in focus: the files it changes and the areas holding them stay lit. */
  pull?: FamilyOverlay;
  frames?: FrameOverlay[];
  /** Archetype shapes and roof icons (default on). */
  shapes?: boolean;
  /** Links drawn as arcs over the blocks (the default) or as rails along the floors. */
  connections?: 'arcs' | 'rails';
  /** Blocks drawn inside their places: open areas' floors take a road's tone between them. */
  streets?: boolean;
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
interface Label { x: number; y: number; lines: { text: string; font: string; color: string }[]; priority: number; align: 'center' | 'above' | 'below' }
const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';
/** Duration of a block rising into place, and of a change flash. */
export const RISE_MS = 520, FLASH_MS = 900;
/** Rounded corners and gradients are skipped below this on-screen size, where they would not show. */
const SOFT_PX = 16;
/** How far what a focus does not reach recedes, as a share of the theme's dimming. */
const FOCUS_DIM = 0.35;
/** A flow's links stream at this speed (CSS pixels per millisecond), in dashes this long and this far apart. */
const STREAM_SPEED = 0.05, STREAM_DASH = [9, 13];
/** Time a frame may spend routing rails; the rest is routed on the next frames. */
const RAIL_BUDGET_MS = 10;
/** A relationship resolved to the blocks drawn at this level of detail (those meeting the same blocks merged). */
interface DrawnEdge { from: VisibleItem; to: VisibleItem; ends: [string, string]; count: number; color: string; hidden: boolean; emphasized: boolean; change?: 'added' | 'removed' }
/** A flow's link resolved to the blocks drawn. */
interface DrawnLink { from: VisibleItem; to: VisibleItem; ends: [string, string]; back: boolean }
/** A rail on screen: its points, length so far at each, and its runs (straight on, drawn with one block in the painter's order). */
interface RailStroke {
  points: Point[]; lengths: number[]; runs: { host: number; from: number; to: number }[];
  color: string; width: number; alpha: number; dash?: number[]; stream?: string; count?: number; halo?: string;
}
/** Rails of a frame: strokes, their runs by the block drawn before them, and what still goes as an arc. */
interface RailPlan { strokes: RailStroke[]; byHost: Map<number, { stroke: RailStroke; run: RailStroke['runs'][number] }[]>; edges: DrawnEdge[]; links: DrawnLink[] }
/** Closed areas at least this large on screen show what they hold on their roof; past these sizes, room for more kinds. */
const RESUME_PX = 64, RESUME_FADE_PX = 14, RESUME_KINDS: [number, number][] = [[100, 2], [150, 4], [Infinity, 6]];

export class MapRenderer {
  private palettes: PaletteCache;
  private font = FONT;
  private dpr = 1;
  private shapeTheme: ShapeTheme;
  private readonly rails = new RailCache();
  railsPending = false;
  constructor(private theme: Theme) { this.palettes = new PaletteCache(theme); this.font = theme.style?.font ?? FONT; this.shapeTheme = shapeTheme(theme); }
  setTheme(theme: Theme): void { this.theme = theme; this.palettes = new PaletteCache(theme); this.font = theme.style?.font ?? FONT; this.shapeTheme = shapeTheme(theme); this.sprites.clear(); }

  render(ctx: CanvasRenderingContext2D, dpr: number, viewport: Viewport, camera: Camera, scene: Scene, set: VisibleSet, state: RenderState, lod: LodConfig): void {
    const theme = this.theme;
    this.dpr = dpr; this.ctxRef = ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.background(ctx, viewport);
    if (theme.style?.grid === 'dots') this.dotGrid(ctx, viewport, camera); else if (theme.style?.grid !== 'none') this.grid(ctx, viewport, camera);

    const emphasis = state.emphasis ? this.expandEmphasis(scene, state.emphasis) : undefined;
    const flowSet = state.lit;
    const labels: Label[] = [];
    const items = this.animate(set, state);
    const impactLit = state.impact ? this.impactLit(scene, state.impact) : undefined;
    const coverageOf = state.coverage ? this.coverageResolver(scene, state.coverage) : undefined;
    const familyOf = state.families ? this.familyResolver(scene, state.families) : undefined;
    const familyLit = state.families?.focus ? this.familyLit(scene, state.families, familyOf!) : undefined;
    const peopleOf = state.people ? this.familyResolver(scene, state.people) : undefined;
    const levelOf = state.measure ? this.levelResolver(scene, state.measure) : undefined;
    const focusLit = state.explanation?.focus ? this.familyLit(scene, state.explanation, this.familyResolver(scene, state.explanation))
      : state.feature?.focus ? this.familyLit(scene, state.feature, this.familyResolver(scene, state.feature))
      : state.person?.focus ? this.familyLit(scene, state.person, this.familyResolver(scene, state.person)) : state.pull?.focus ? this.familyLit(scene, state.pull, this.familyResolver(scene, state.pull)) : familyLit;
    const hot = this.flowHeat(state.flow);
    // Items come parents first: one inside a subtree kept whole is lit through its parent.
    const inside = state.within && emphasis ? new Uint8Array(items.length) : undefined;
    // What the selection, a feature or a person does not reach recedes far, so what it does reach reads at a glance.
    const recede = theme.dimAlpha * FOCUS_DIM;
    const edges = this.resolveEdges(scene, set, state.edges);
    const links = state.flow ? this.resolveLinks(scene, set, state.flow) : [];
    this.railsPending = false;
    const rails = state.connections === 'rails' && (edges.length || links.length) ? this.planRails(viewport, camera, scene, set, edges, links, state) : undefined;
    const notes: [VisibleItem, number][] = [];
    for (const [index, item] of items.entries()) {
      if (inside) inside[index] = state.within!.has(item.node.id) || (item.parent >= 0 && inside[item.parent] === 1) ? 1 : 0;
      // A playing flow decides what stays lit; then the feature or family in focus (chosen on purpose, it wins over the selection); then what the selection reaches.
      const dimmed = flowSet ? !flowSet.has(item.node.id) : focusLit ? !focusLit(item.node) : !!emphasis && !emphasis.has(item.node.id) && !inside?.[index];
      // In a comparison, blocks a change reaches stay lit instead of fading with the unchanged ones.
      const reached = impactLit?.has(item.node.id) && item.node.change?.status !== 'removed';
      const alpha = item.alpha * (dimmed ? (flowSet ? theme.flow.dimAlpha : recede) : 1) * (state.comparison && !reached ? this.changeAlpha(item, state.comparison) : 1) * (state.impact?.dimOthers && !reached ? theme.dimAlpha : 1);
      if (alpha <= 0.01) { if (rails) this.railRuns(ctx, rails, index, state); continue; }
      if (theme.style?.shadow && item.parent >= 0 && item.size > SOFT_PX) this.shadow(ctx, viewport, camera, item, alpha);
      const category = coverageOf?.(item.node);
      const family = category ? undefined : familyOf?.(item.node);
      const person = category || family ? undefined : peopleOf?.(item.node);
      const level = category || family || person ? undefined : levelOf?.(item.node);
      const paletteOverride = category ? `coverage:${category}` : family ? `family:${this.familyHue(family, state.families!)}` : person ? `family:${this.familyHue(person, state.people!)}` : level ? `level:${level}` : undefined;
      if (item.shape !== undefined) this.shape(ctx, viewport, camera, item, alpha, item.node.id === state.hoveredId, paletteOverride, hot.get(item.node.id) ?? 0, this.shapeTint(item, state), state);
      else {
        this.prism(ctx, viewport, camera, item, alpha, item.node.id === state.hoveredId, paletteOverride, state.shapes !== false, !!state.streets && item.open);
        const resume = this.resumeShare(item, state, camera, lod);
        if (resume > 0) this.resume(ctx, viewport, camera, item, alpha * resume, paletteOverride);
      }
      if (state.coverage && !item.open && !category && state.coverage.areas.has(item.node.id)) this.coverageBadge(ctx, viewport, camera, item, alpha, state.coverage.areas.get(item.node.id)!);
      if (state.families && !item.open && !family && state.families.areas.has(item.node.id)) this.familyBadge(ctx, viewport, camera, item, alpha, state.families.areas.get(item.node.id)!, state.families);
      else if (state.explanation && !state.coverage && !item.open && item.node.type !== 'file' && state.explanation.areas.has(item.node.id)) this.familyBadge(ctx, viewport, camera, item, alpha, state.explanation.areas.get(item.node.id)!, state.explanation);
      else if (state.feature && !state.coverage && !item.open && state.feature.areas.has(item.node.id)) this.familyBadge(ctx, viewport, camera, item, alpha, state.feature.areas.get(item.node.id)!, state.feature);
      else if (state.person && !state.coverage && !item.open && state.person.areas.has(item.node.id)) this.familyBadge(ctx, viewport, camera, item, alpha, state.person.areas.get(item.node.id)!, state.person);
      else if (state.pull && !state.coverage && !item.open && state.pull.areas.has(item.node.id)) this.familyBadge(ctx, viewport, camera, item, alpha, state.pull.areas.get(item.node.id)!, state.pull);
      else if (state.people && !item.open && !person && state.people.areas.has(item.node.id)) this.familyBadge(ctx, viewport, camera, item, alpha, state.people.areas.get(item.node.id)!, state.people);
      else if (state.measure && !item.open && !level && state.measure.areas.has(item.node.id)) this.levelBadge(ctx, viewport, camera, item, alpha, state.measure.areas.get(item.node.id)!, state.measure);
      if (item.open && state.pull?.notes?.has(item.node.id)) notes.push([item, alpha]);
      if (state.comparison) this.changeOverlay(ctx, viewport, camera, item, alpha, state);
      if (state.impact) this.impactOverlay(ctx, viewport, camera, item, alpha, state.impact);
      if (state.showDiagnostics && !item.open && item.node.diagnostics > 0 && item.size > 10) this.diagnosticMarker(ctx, viewport, camera, item, alpha);
      if (rails) this.railRuns(ctx, rails, index, state);
      // Receded areas keep their names (in a quieter color) to stay oriented; receded blocks lose theirs.
      this.collectLabel(labels, viewport, camera, item, state, dimmed && !flowSet && item.tier === 'district' ? alpha / recede : alpha, dimmed ?? false, lod);
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
    if (rails) this.railTops(ctx, rails);
    this.edges(ctx, viewport, camera, rails ? rails.edges : edges);
    if (state.unresolved && state.unresolved.count > 0) this.unresolvedStub(ctx, viewport, camera, scene, set, state.unresolved);
    if (state.flow) { this.flowArcs(ctx, viewport, camera, rails ? rails.links : links, state); this.flowStops(ctx, viewport, camera, set, state.flow); }
    for (const [item, alpha] of notes) this.areaNote(ctx, viewport, camera, item, alpha, state.pull!);
    this.labels(ctx, labels);
    if (state.pins?.length) this.pins(ctx, viewport, camera, set, state.pins);
    if (state.callouts?.length) this.callouts(ctx, viewport, camera, set, state.callouts);
    if (state.frames?.length) this.frames(ctx, viewport, camera, state.frames);
    if (state.activity?.length) this.activityBadges(ctx, viewport, camera, scene, set, state.activity, state.reducedMotion);
    if (state.pointer) this.pointer(ctx, viewport, camera, scene, set, items, state.pointer);
  }
  /**
   * What a hovered explanation link names: outlined where it is drawn (its
   * nearest drawn area otherwise); off screen, an arrow at the edge of the map
   * points to it, so the camera never has to move while reading.
   */
  private activityBadges(ctx: CanvasRenderingContext2D, viewport: Viewport, camera: Camera, scene: Scene, set: VisibleSet, marks: ActivityMark[], reduced: boolean): void {
    const grouped = new Map<string, { item: VisibleItem; marks: ActivityMark[] }>();
    for (const mark of marks) {
      const item = set.items[set.index.get(mark.id) ?? -1] ?? scene.representative(mark.id, set) ?? [...mark.ancestors].reverse().map(id => set.items[set.index.get(id) ?? -1]).find(Boolean);
      if (!item) continue;
      const group = grouped.get(item.node.id) ?? { item, marks: [] };
      if (!group.marks.some(other => other.actor === mark.actor)) group.marks.push(mark);
      grouped.set(item.node.id, group);
    }
    for (const { item, marks: actors } of grouped.values()) {
      const first = actors[0]!;
      ctx.save();
      ctx.globalAlpha = Math.max(0.15, 1 - first.age / 30000);
      this.outline(ctx, viewport, camera, item, first.color, !reduced && first.age < 2000 ? 2.5 + Math.sin(first.age / 160) : 2, false, first.search ? [4, 4] : undefined);
      const point = worldToScreen(camera, viewport, item.node.rect.x + item.node.rect.w / 2, item.node.rect.y + item.node.rect.h / 2, item.zTop);
      let y = Math.max(12, Math.min(viewport.height - 24, point.y - 16));
      for (const mark of actors.slice(0, 4)) {
        ctx.globalAlpha = Math.max(0.2, 1 - mark.age / 30000);
        ctx.font = `600 10px ${this.theme.style?.font ?? 'sans-serif'}`;
        const label = mark.label, width = ctx.measureText(label).width + 14;
        const x = Math.max(4, Math.min(viewport.width - width - 4, point.x - width / 2));
        ctx.fillStyle = this.theme.background[0]; ctx.strokeStyle = mark.color; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.roundRect(x, y, width, 18, 5); ctx.fill(); ctx.stroke();
        ctx.fillStyle = this.theme.text.primary; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(label, x + width / 2, y + 9);
        y += 21;
      }
      ctx.restore();
    }
  }
  private pointer(ctx: CanvasRenderingContext2D, viewport: Viewport, camera: Camera, scene: Scene, set: VisibleSet, items: VisibleItem[], pointer: { id: string; ancestors: string[] }): void {
    const theme = this.theme;
    const drawn = items[set.index.get(pointer.id) ?? -1] ?? scene.representative(pointer.id, set) ?? [...pointer.ancestors].reverse().map(id => items[set.index.get(id) ?? -1]).find(Boolean);
    if (drawn) this.outline(ctx, viewport, camera, drawn, theme.hover, 2.5, false, drawn.node.id === pointer.id ? undefined : [5, 4]);
    const node = scene.nodes.get(pointer.id) ?? [...pointer.ancestors].reverse().map(id => scene.nodes.get(id)).find(Boolean);
    if (!node) return;
    const center = worldToScreen(camera, viewport, node.rect.x + node.rect.w / 2, node.rect.y + node.rect.h / 2, 0);
    const margin = 18;
    if (center.x >= margin && center.x <= viewport.width - margin && center.y >= margin && center.y <= viewport.height - margin) return;
    // Where the line from the middle of the map to the target leaves the viewport.
    const cx = viewport.width / 2, cy = viewport.height / 2, dx = center.x - cx, dy = center.y - cy;
    const t = Math.min(dx ? (dx > 0 ? viewport.width - margin - cx : margin - cx) / dx : Infinity, dy ? (dy > 0 ? viewport.height - margin - cy : margin - cy) / dy : Infinity);
    const x = cx + dx * t, y = cy + dy * t, angle = Math.atan2(dy, dx);
    ctx.save();
    ctx.translate(x, y); ctx.rotate(angle);
    ctx.fillStyle = theme.hover; ctx.shadowColor = theme.hover; ctx.shadowBlur = 10;
    ctx.beginPath(); ctx.moveTo(10, 0); ctx.lineTo(-8, -8); ctx.lineTo(-4, 0); ctx.lineTo(-8, 8); ctx.closePath(); ctx.fill();
    ctx.restore();
  }
  /** The other views' frames, numbered at their corner; the active one on top and glowing, those of other pages dashed and unnumbered. */
  private frames(ctx: CanvasRenderingContext2D, viewport: Viewport, camera: Camera, frames: FrameOverlay[]): void {
    const theme = this.theme;
    ctx.save();
    for (const frame of [...frames].sort((a, b) => Number(a.active) - Number(b.active) || Number(a.shown) - Number(b.shown))) {
      const a = toScreen(camera, viewport, { x: frame.bounds.minX, y: frame.bounds.minY }), b = toScreen(camera, viewport, { x: frame.bounds.maxX, y: frame.bounds.maxY });
      // A view zoomed in very far keeps a visible frame around its center.
      const w = Math.max(12, b.x - a.x), h = Math.max(9, b.y - a.y), x0 = (a.x + b.x - w) / 2, y0 = (a.y + b.y - h) / 2;
      const color = frame.active ? theme.selection : frame.shown ? theme.text.primary : theme.text.secondary;
      ctx.globalAlpha = frame.active ? 0.14 : frame.shown ? 0.08 : 0.04; ctx.fillStyle = color; ctx.fillRect(x0, y0, w, h);
      ctx.globalAlpha = frame.shown ? 0.95 : 0.65; ctx.strokeStyle = color; ctx.lineWidth = frame.active ? 2.2 : 1.4;
      if (!frame.shown) ctx.setLineDash([4, 4]);
      if (frame.active) { ctx.shadowColor = color; ctx.shadowBlur = 10; }
      ctx.strokeRect(x0, y0, w, h);
      ctx.shadowBlur = 0; ctx.setLineDash([]);
      if (!frame.shown) continue;
      const bx = Math.max(9, Math.min(viewport.width - 9, x0)), by = Math.max(9, Math.min(viewport.height - 9, y0));
      ctx.globalAlpha = 1; ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(bx, by, 8.5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = theme.dark ? '#0b1020' : '#ffffff'; ctx.font = `800 10px ${this.font}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(frame.number), bx, by + 0.5);
    }
    ctx.restore();
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
    if (item.shape !== undefined) {
      // A shape is ringed by its silhouette: the outline of its box from the ground to its top.
      const top = this.corners(viewport, camera, item, item.zTop), bottom = this.corners(viewport, camera, item, item.zBase);
      polygon(ctx, [top[0], top[1], bottom[1], bottom[2], bottom[3], top[3]]);
      return;
    }
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
  private prism(ctx: CanvasRenderingContext2D, viewport: Viewport, camera: Camera, item: VisibleItem, alpha: number, hovered: boolean, paletteOverride?: string, icons = false, road = false): void {
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
    ctx.fillStyle = hovered ? palette.hoverTop : road ? this.road(paletteOverride ?? paletteKey(item.node), item.node.depth) : palette.top;
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
    if (item.size > 14) { ctx.strokeStyle = this.theme.outline; ctx.lineWidth = this.theme.style?.outlineWidth ?? 1; ctx.stroke(); }
    if (item.node.kind === 'group' && item.size > 30) {
      // Projection districts get a dashed rim: they are spatial groupings, not entities.
      ctx.setLineDash([4, 4]); ctx.strokeStyle = this.theme.text.secondary; ctx.lineWidth = 1; this.topPath(ctx, viewport, camera, item, r); ctx.stroke(); ctx.setLineDash([]);
    }
    const archetype = item.node.archetype?.kind;
    if (icons && archetype && (item.open ? item.size > 160 : item.size >= ICON_PX)) {
      // Too small for its shape: the archetype's mark on the roof. An open file keeps it as a trim at its front corner.
      const { x, y, w, h } = item.node.rect, base = this.palettes.base(paletteOverride ?? paletteKey(item.node), item.node.depth);
      drawIcon(this.view(viewport, camera), archetype, x, y, item.zTop, w, h, hovered ? { ...base, l: base.l + (this.theme.dark ? 9 : -7) } : base, item.open ? 0.7 : 1, item.open ? Math.min(0.22, 60 / Math.max(1, item.size)) : 1, item.open ? 'front-left' : 'center');
    }
    ctx.globalAlpha = 1;
  }
  /** An open area's floor with streets on: a shade darker than its blocks' plots, like asphalt between them. */
  private road(key: string, depth: number): string {
    const base = this.palettes.base(key, depth);
    return `hsl(${base.h} ${base.s * 0.7}% ${(this.theme.dark ? base.l * 0.72 : base.l - 7).toFixed(1)}%)`;
  }
  private view(viewport: Viewport, camera: Camera): ShapeView {
    return { ctx: this.ctxRef!, s: camera.scale, ox: viewport.width / 2 - camera.x * camera.scale, oy: viewport.height / 2 - camera.y * camera.scale, T: this.shapeTheme };
  }
  private ctxRef?: CanvasRenderingContext2D;
  /** A closed block with an archetype, drawn as its shape: in its palette (or tinted by a comparison or blast radius), lit while a flow passes. */
  private shape(ctx: CanvasRenderingContext2D, viewport: Viewport, camera: Camera, item: VisibleItem, alpha: number, hovered: boolean, paletteOverride: string | undefined, hot: number, tint: Hsl | undefined, state: RenderState): void {
    const node = item.node;
    let color = this.palettes.base(paletteOverride ?? paletteKey(node), node.depth);
    if (tint) color = mixHsl(color, tint, 0.6);
    if (hovered) color = { ...color, l: color.l + (this.theme.dark ? 9 : -7) };
    const input = { x: node.rect.x, y: node.rect.y, z: item.zBase, w: node.rect.w, d: node.rect.h, H: item.zTop - item.zBase, c: color, t: state.reducedMotion ? 0 : state.time / 1000, hot, seed: seedOf(node.id) };
    this.composite(ctx, viewport, camera, item, alpha, v => drawShape(v, node.archetype!.kind, input));
  }
  /**
   * Draw a picture standing on an item. Faded, it is drawn whole on a layer
   * and faded as one, so its inner faces never show through each other.
   */
  private composite(ctx: CanvasRenderingContext2D, viewport: Viewport, camera: Camera, item: VisibleItem, alpha: number, draw: (v: ShapeView) => void): void {
    if (alpha >= 0.98) { draw(this.view(viewport, camera)); return; }
    const top = this.corners(viewport, camera, item, item.zTop), bottom = this.corners(viewport, camera, item, item.zBase), margin = 4 + item.size * 0.5;
    const x0 = Math.max(0, Math.floor(top[3].x - margin)), x1 = Math.min(viewport.width, Math.ceil(top[1].x + margin));
    const y0 = Math.max(0, Math.floor(top[0].y - margin)), y1 = Math.min(viewport.height, Math.ceil(bottom[2].y + 2));
    if (x1 <= x0 || y1 <= y0) return;
    const layer = this.layer(viewport), lctx = layer.getContext('2d')!, d = this.dpr;
    lctx.setTransform(d, 0, 0, d, 0, 0); lctx.clearRect(x0, y0, x1 - x0, y1 - y0);
    draw({ ...this.view(viewport, camera), ctx: lctx });
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = alpha;
    ctx.drawImage(layer, x0 * d, y0 * d, (x1 - x0) * d, (y1 - y0) * d, x0 * d, y0 * d, (x1 - x0) * d, (y1 - y0) * d);
    ctx.restore();
  }
  /**
   * How much of what an area holds its roof shows (0..1): closed areas from
   * RESUME_PX, fading out as an opening area's own blocks fade in. Lenses and
   * comparisons badge areas with their own summary instead.
   */
  private resumeShare(item: VisibleItem, state: RenderState, camera: Camera, lod: LodConfig): number {
    if (state.shapes === false || !item.node.archetypeCounts?.length || item.shape !== undefined) return 0;
    if (state.comparison || state.impact || state.coverage || state.families || state.feature || state.person || state.people || state.measure) return 0;
    if (item.open) return Math.max(0, 1 - openProgress(item.node, camera.scale, lod) * 2.5);
    return Math.min(1, Math.max(0, (item.size - RESUME_PX) / RESUME_FADE_PX));
  }
  /** An area's roof: the kinds of block it holds most, each as a small shape over its count. */
  private resume(ctx: CanvasRenderingContext2D, viewport: Viewport, camera: Camera, item: VisibleItem, alpha: number, paletteOverride: string | undefined): void {
    const node = item.node, counts = node.archetypeCounts!, { x, y, w, h } = node.rect, side = Math.min(w, h);
    const n = Math.min(counts.length, RESUME_KINDS.find(([px]) => item.size < px)![1]);
    const along = n <= 2 ? n : n <= 4 ? 2 : 3, across = Math.ceil(n / along), [cols, rows] = w >= h ? [along, across] : [across, along];
    const margin = side * 0.1, cw = (w - margin * 2) / cols, ch = (h - margin * 2) / rows, fs = Math.min(cw * 0.76, ch * 0.76, side * 0.46);
    const color = this.palettes.base(paletteOverride ?? 'file', node.depth + 1);
    const cells = counts.slice(0, n).map((entry, i) => ({ ...entry, cx: x + margin + cw * (i % cols + 0.5), cy: y + margin + ch * (Math.floor(i / cols) + 0.5) }));
    const behind = [...cells].sort((a, b) => a.cx + a.cy - (b.cx + b.cy));
    ctx.save();
    ctx.globalAlpha = alpha;
    for (const cell of behind) {
      const sprite = this.sprite(cell.kind, fs * camera.scale, color), back = worldToScreen(camera, viewport, cell.cx - fs / 2, cell.cy - fs / 2, item.zTop), k = fs * camera.scale / sprite.side;
      ctx.drawImage(sprite.canvas, back.x - sprite.ox * k, back.y - sprite.oy * k, sprite.width * k, sprite.height * k);
    }
    // The counts, under each shape's front corner.
    ctx.font = `700 ${Math.min(12, 9.5 + item.size / 120).toFixed(1)}px ${this.font}`; ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.lineJoin = 'round';
    ctx.lineWidth = 3; ctx.strokeStyle = this.theme.text.halo; ctx.fillStyle = this.theme.text.primary;
    for (const cell of cells) {
      const p = worldToScreen(camera, viewport, cell.cx + fs / 2, cell.cy + fs / 2, item.zTop), text = compactNumber(cell.count);
      ctx.strokeText(text, p.x, p.y + 1); ctx.fillText(text, p.x, p.y + 1);
    }
    ctx.restore();
  }
  /** Small static shapes (the kinds on areas' roofs) drawn once per kind, color and size, then copied: panning only blits them. */
  private sprites = new Map<string, { canvas: HTMLCanvasElement; side: number; ox: number; oy: number; width: number; height: number }>();
  private sprite(kind: Archetype, sidePx: number, color: Hsl) {
    // Sizes step by 8%, each drawn scaled by at most 4% either way.
    const step = Math.round(Math.log(Math.max(2, sidePx)) / Math.log(1.08)), side = 1.08 ** step;
    const key = `${kind}|${step}|${color.h}|${color.s}|${color.l}|${this.dpr}`;
    const known = this.sprites.get(key);
    if (known) return known;
    // Room above the shape for its glow (a lighthouse lamp shines past its top).
    const F = 8, s = side / F, H = shapeHeight(kind, F, undefined) * s, pad = 3, top = side * 0.8 + 4;
    const width = Math.ceil(side * 2 * ISO_X + pad * 2), height = Math.ceil(side + H + top + pad * 2), ox = pad + side * ISO_X, oy = pad + top + H;
    const canvas = document.createElement('canvas'), d = this.dpr;
    canvas.width = Math.ceil(width * d); canvas.height = Math.ceil(height * d);
    const sctx = canvas.getContext('2d')!;
    sctx.setTransform(d, 0, 0, d, 0, 0);
    drawShape({ ctx: sctx, s, ox, oy, T: this.shapeTheme }, kind, { x: 0, y: 0, z: 0, w: F, d: F, H: H / s, c: color, t: 0, hot: 0, seed: seedOf(kind) });
    const sprite = { canvas, side, ox, oy, width, height };
    if (this.sprites.size >= 400) for (const old of [...this.sprites.keys()].slice(0, 100)) this.sprites.delete(old);
    this.sprites.set(key, sprite);
    return sprite;
  }
  private layerCanvas?: HTMLCanvasElement;
  /** A scratch canvas the size of the map, for drawing a shape whole before fading it. */
  private layer(viewport: Viewport): HTMLCanvasElement {
    const canvas = this.layerCanvas ??= document.createElement('canvas');
    const w = Math.ceil(viewport.width * this.dpr), h = Math.ceil(viewport.height * this.dpr);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    return canvas;
  }
  /** Light the continuous flow and the closed blocks holding its stops. */
  private flowHeat(flow: FlowOverlay | undefined): Map<string, number> {
    const heat = new Map<string, number>();
    for (const stop of flow?.stops ?? []) {
      const value = stop.start ? 1 : 0.55;
      if (!value) continue;
      for (const id of [stop.entityId, ...stop.ancestors]) heat.set(id, Math.max(heat.get(id) ?? 0, value));
    }
    return heat;
  }
  /** A comparison's status color, or the blast radius's color by hop count: shapes take it as their own instead of a tinted roof. */
  private shapeTint(item: VisibleItem, state: RenderState): Hsl | undefined {
    const status = state.comparison ? item.node.change?.status : undefined;
    if (status && status !== 'unchanged') return hexToHsl(this.theme.change[status]);
    const distance = state.impact?.distances.get(item.node.id);
    if (distance === undefined || distance === 0 || !state.impact) return undefined;
    const colors = impactColors(this.theme);
    return hexToHsl(mixHex(colors.near, colors.far, state.impact.depth > 1 ? (distance - 1) / (state.impact.depth - 1) : 0));
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
      if (!item.open && item.shape === undefined) { ctx.globalAlpha = Math.min(1, alpha * (status === 'removed' ? 0.35 : 0.42) * (1 + 1.3 * boost)); ctx.fillStyle = color; this.topPath(ctx, viewport, camera, item, r); ctx.fill(); }
      ctx.globalAlpha = Math.min(1, alpha * 1.6);
      ctx.strokeStyle = color; ctx.lineWidth = (item.open ? 2 : 1.6) + 2 * boost; ctx.lineJoin = 'round';
      if (status === 'removed') ctx.setLineDash([5, 4]);
      this.topPath(ctx, viewport, camera, item, r); ctx.stroke();
      if (boost > 0.02 && !item.open && status !== 'removed') {
        // A ripple spreading out from the changed block.
        ctx.setLineDash([]); ctx.globalAlpha = alpha * boost * 0.9; ctx.lineWidth = 1.5;
        this.footprint(ctx, viewport, camera, node.rect, item.shape === undefined ? item.zTop : item.zBase, r, (1 - boost) * 10 / camera.scale); ctx.stroke();
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
      if (!item.open && item.shape === undefined) { ctx.globalAlpha = Math.min(1, alpha * 0.5); ctx.fillStyle = color; this.topPath(ctx, viewport, camera, item, r); ctx.fill(); }
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
  private collectLabel(labels: Label[], viewport: Viewport, camera: Camera, item: VisibleItem, state: RenderState, alpha: number, dimmed: boolean, lod: LodConfig): void {
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
      labels.push({ x: top.x, y: top.y - 4, align: 'above', priority: 1e9 - node.depth * 1e6 + item.size - (dimmed ? 5e5 : 0), lines: [{ text, font: `${node.type === 'application' ? 700 : 600} ${size}px ${this.font}`, color: dimmed ? theme.text.secondary : theme.text.district }] });
      return;
    }
    const { x, y, w, h } = node.rect;
    // Shapes, and areas showing what they hold, keep their label off the roof: under their front corner, like a street sign.
    const sign = item.shape !== undefined || this.resumeShare(item, state, camera, lod) > 0;
    const center = sign ? worldToScreen(camera, viewport, x + w, y + h, item.zBase) : worldToScreen(camera, viewport, x + w / 2, y + h / 2, item.zTop);
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
    labels.push({ x: center.x, y: center.y, align: sign ? 'below' : 'center', priority: (important ? 2e9 : 0) + item.size, lines });
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
      const y0 = label.align === 'above' ? label.y - height : label.align === 'below' ? label.y + 2 : label.y - height / 2;
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
  /**
   * Where a rail ends for an entity resolved to `at`: the entity itself (or
   * its deepest known area) when it is only out of view, inside an open area;
   * the block drawn for it when it is inside a closed one.
   */
  private railEnd(scene: Scene, at: { item: VisibleItem; hidden: boolean }, id: string, ancestors: string[]): string {
    if (!at.hidden || !at.item.open) return at.item.node.id;
    if (scene.nodes.has(id)) return id;
    for (let i = ancestors.length - 1; i >= 0; i--) if (scene.nodes.has(ancestors[i]!)) return ancestors[i]!;
    return at.item.node.id;
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
  /** Relationships resolved to the blocks drawn; those meeting the same blocks at this level of detail are merged. */
  private resolveEdges(scene: Scene, set: VisibleSet, edges: EdgeOverlay[]): DrawnEdge[] {
    const drawn = new Map<string, DrawnEdge>();
    for (const edge of edges) {
      const from = this.resolve(set, edge.from, edge.fromAncestors), to = this.resolve(set, edge.to, edge.toAncestors);
      if (!from || !to || from.item === to.item) continue;
      const key = `${from.item.node.id}>${to.item.node.id}>${edge.type}>${edge.change ?? ''}`;
      const existing = drawn.get(key);
      if (existing) { existing.count += edge.count; existing.emphasized ||= !!edge.emphasized; continue; }
      drawn.set(key, { from: from.item, to: to.item, ends: [this.railEnd(scene, from, edge.from, edge.fromAncestors), this.railEnd(scene, to, edge.to, edge.toAncestors)], count: edge.count, color: edge.change === 'removed' ? this.theme.change.removed : this.theme.relation[edge.type] ?? this.theme.fallbackRelation, hidden: from.hidden || to.hidden, emphasized: !!edge.emphasized, ...(edge.change ? { change: edge.change } : {}) });
    }
    return [...drawn.values()];
  }
  private edgeWidth(edge: DrawnEdge): number { return Math.min(5, 1.4 + Math.log2(edge.count) * 0.8) + (edge.emphasized ? 1.2 : 0); }
  /** Relationships as arcs over the blocks, from the top of one to the top of the other. */
  private edges(ctx: CanvasRenderingContext2D, viewport: Viewport, camera: Camera, edges: DrawnEdge[]): void {
    for (const edge of edges) {
      const from = this.anchor(viewport, camera, edge.from), to = this.anchor(viewport, camera, edge.to);
      const control = curveControl(from, to);
      ctx.save();
      if (this.theme.style?.rounding) ctx.lineCap = 'round';
      if (this.theme.style?.edgeGlow) { ctx.shadowColor = edge.color; ctx.shadowBlur = this.theme.style.edgeGlow; }
      const width = this.edgeWidth(edge);
      if (edge.change === 'added') {
        // Added since the baseline: a halo in the added color under the typed edge.
        ctx.strokeStyle = this.theme.change.added; ctx.globalAlpha = 0.45; ctx.lineWidth = width + 5;
        ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.quadraticCurveTo(control.x, control.y, to.x, to.y); ctx.stroke();
      }
      ctx.strokeStyle = edge.color; ctx.globalAlpha = edge.change === 'removed' ? 0.75 : edge.emphasized ? 1 : 0.85;
      ctx.lineWidth = width;
      if (edge.hidden || edge.change === 'removed') ctx.setLineDash(edge.change === 'removed' ? [3, 5] : [6, 5]);
      ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.quadraticCurveTo(control.x, control.y, to.x, to.y); ctx.stroke();
      ctx.setLineDash([]);
      this.arrowhead(ctx, to, Math.atan2(to.y - control.y, to.x - control.x), 7 + width, edge.color);
      ctx.beginPath(); ctx.arc(from.x, from.y, 3, 0, Math.PI * 2); ctx.fill();
      if (edge.count > 1) this.countBadge(ctx, { x: 0.25 * from.x + 0.5 * control.x + 0.25 * to.x, y: 0.25 * from.y + 0.5 * control.y + 0.25 * to.y }, edge.count, edge.color);
      ctx.restore();
    }
  }
  private arrowhead(ctx: CanvasRenderingContext2D, at: Point, angle: number, size: number, color: string): void {
    ctx.fillStyle = color; ctx.beginPath();
    ctx.moveTo(at.x, at.y); ctx.lineTo(at.x - size * Math.cos(angle - 0.4), at.y - size * Math.sin(angle - 0.4)); ctx.lineTo(at.x - size * Math.cos(angle + 0.4), at.y - size * Math.sin(angle + 0.4)); ctx.closePath(); ctx.fill();
  }
  private countBadge(ctx: CanvasRenderingContext2D, at: Point, count: number, color: string): void {
    const text = compactNumber(count);
    ctx.font = `700 10px ${this.font}`; const width = ctx.measureText(text).width + 10;
    ctx.globalAlpha = 1; ctx.setLineDash([]); ctx.fillStyle = color; roundRect(ctx, at.x - width / 2, at.y - 8, width, 16, 8); ctx.fill();
    ctx.fillStyle = this.theme.dark ? '#0b1020' : '#ffffff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(text, at.x, at.y + 0.5);
  }
  /** The scene as the rail router reads it. */
  private railWorld(scene: Scene): RailWorld {
    if (this.railWorldCache?.scene === scene) return this.railWorldCache.world;
    const world: RailWorld = {
      rect: id => scene.nodes.get(id)?.rect,
      parent: id => scene.nodes.get(id)?.spatialParentId,
      children: id => scene.children.get(id)?.ids ?? [],
      top: id => { const node = scene.nodes.get(id); return node ? scene.zBase(id) + nodeHeight(node) : 0; },
    };
    this.railWorldCache = { scene, world };
    return world;
  }
  private railWorldCache?: { scene: Scene; world: RailWorld };
  /**
   * Rails for the links of this frame, projected on screen, with each run
   * kept for the block it is drawn after (so the blocks in front hide it).
   * Links without a rail (one block holds the other, no street, or not routed
   * yet) stay arcs.
   */
  private planRails(viewport: Viewport, camera: Camera, scene: Scene, set: VisibleSet, edges: DrawnEdge[], links: DrawnLink[], state: RenderState): RailPlan {
    const world = this.railWorld(scene);
    const deadline = performance.now() + RAIL_BUDGET_MS;
    // A route stays valid while the areas holding its ends hold the same blocks.
    const stamp = (id: string) => { const parts: string[] = []; for (let area = scene.nodes.get(id)?.spatialParentId; area; area = scene.nodes.get(area)?.spatialParentId) parts.push(String(scene.children.get(area)?.ids.length ?? 0)); return parts.join('.'); };
    const plan: RailPlan = { strokes: [], byHost: new Map(), edges: [], links: [] };
    const route = ([from, to]: [string, string]): Rail | undefined => {
      const rail = this.rails.get(scene, world, from, to, `${stamp(from)}|${stamp(to)}`, deadline);
      if (rail === undefined) this.railsPending = true;
      return rail ?? undefined;
    };
    // A run on a floor out of view is drawn with the nearest area in view (it is off screen anyway).
    const drawnWith = (id: string): number | undefined => { for (let area: string | undefined = id; area; area = scene.nodes.get(area)?.spatialParentId) { const index = set.index.get(area); if (index !== undefined) return index; } return undefined; };
    const add = (rail: Rail, style: Omit<RailStroke, 'points' | 'lengths' | 'runs'>): boolean => {
      const hosts = rail.hosts.map(drawnWith);
      if (hosts.some(host => host === undefined)) return false;
      const points = rail.points.map(point => worldToScreen(camera, viewport, point.x, point.y, point.z));
      const lengths = [0];
      for (let i = 1; i < points.length; i++) lengths.push(lengths[i - 1]! + Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y));
      const runs: RailStroke['runs'] = [];
      hosts.forEach((host, i) => { const last = runs.at(-1); if (last && last.host === host) last.to = i + 1; else runs.push({ host: host!, from: i, to: i + 1 }); });
      const stroke: RailStroke = { ...style, points, lengths, runs };
      plan.strokes.push(stroke);
      for (const run of runs) { const list = plan.byHost.get(run.host) ?? []; list.push({ stroke, run }); plan.byHost.set(run.host, list); }
      return true;
    };
    for (const edge of edges) {
      const rail = route(edge.ends);
      if (!rail || !add(rail, { color: edge.color, width: this.edgeWidth(edge), alpha: edge.change === 'removed' ? 0.75 : edge.emphasized ? 1 : 0.9, ...(edge.hidden || edge.change === 'removed' ? { dash: edge.change === 'removed' ? [3, 5] : [6, 5] } : {}), ...(edge.count > 1 ? { count: edge.count } : {}), ...(edge.change === 'added' ? { halo: this.theme.change.added } : {}) })) plan.edges.push(edge);
    }
    for (const link of links) {
      const rail = route(link.ends);
      const color = link.back ? this.toneColor('return') : this.theme.flow.step;
      if (!rail || !add(rail, { color, width: 3, alpha: 0.95, stream: this.theme.flow.indicator })) plan.links.push(link);
    }
    return plan;
  }
  /** The runs of rails drawn with one block: on its floor, or down its wall. */
  private railRuns(ctx: CanvasRenderingContext2D, plan: RailPlan, host: number, state: RenderState): void {
    const runs = plan.byHost.get(host);
    if (!runs) return;
    ctx.save();
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const phase = streamPhase(state);
    for (const { stroke, run } of runs) {
      const points = stroke.points.slice(run.from, run.to + 1);
      // A dark casing under the rail keeps it apart from the floor it runs on.
      ctx.setLineDash([]); ctx.globalAlpha = 0.7; ctx.strokeStyle = this.theme.text.halo; ctx.lineWidth = stroke.width + 3;
      polyline(ctx, points); ctx.stroke();
      if (stroke.halo) { ctx.globalAlpha = 0.45; ctx.strokeStyle = stroke.halo; ctx.lineWidth = stroke.width + 5; polyline(ctx, points); ctx.stroke(); }
      ctx.globalAlpha = stroke.alpha; ctx.strokeStyle = stroke.color; ctx.lineWidth = stroke.width;
      if (stroke.dash) { ctx.setLineDash(stroke.dash); ctx.lineDashOffset = stroke.lengths[run.from]!; }
      polyline(ctx, points); ctx.stroke();
      if (stroke.stream) {
        // Dashes streaming toward the end, continuous from one run to the next.
        ctx.setLineDash(STREAM_DASH); ctx.lineDashOffset = phase + stroke.lengths[run.from]!; ctx.strokeStyle = stroke.stream; ctx.lineWidth = Math.max(1.6, stroke.width - 0.8); ctx.globalAlpha = 1;
        polyline(ctx, points); ctx.stroke();
      }
    }
    ctx.restore();
  }
  /** Over everything: where the rails go behind blocks (faint), their arrowheads, start dots and counts. */
  private railTops(ctx: CanvasRenderingContext2D, plan: RailPlan): void {
    ctx.save();
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const stroke of plan.strokes) {
      const { points } = stroke;
      ctx.globalAlpha = 0.22; ctx.strokeStyle = stroke.color; ctx.lineWidth = 1.4; ctx.setLineDash([2, 4]);
      polyline(ctx, points); ctx.stroke();
      ctx.setLineDash([]); ctx.globalAlpha = 1;
      const end = points.at(-1)!, before = points.at(-2)!, start = points[0]!;
      this.arrowhead(ctx, end, Math.atan2(end.y - before.y, end.x - before.x), 6 + stroke.width, stroke.color);
      ctx.beginPath(); ctx.arc(start.x, start.y, 2.6 + stroke.width * 0.3, 0, Math.PI * 2); ctx.fill();
      if (stroke.count) {
        const half = stroke.lengths.at(-1)! / 2;
        const i = Math.max(1, stroke.lengths.findIndex(length => length >= half));
        const a = points[i - 1]!, b = points[i]!, span = stroke.lengths[i]! - stroke.lengths[i - 1]!, t = span > 0 ? (half - stroke.lengths[i - 1]!) / span : 0;
        this.countBadge(ctx, { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, stroke.count, stroke.color);
      }
    }
    ctx.restore();
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
  /** A flow's links resolved to the blocks drawn; links meeting the same blocks at this level of detail are drawn once. */
  private resolveLinks(scene: Scene, set: VisibleSet, flow: FlowOverlay): DrawnLink[] {
    const links = new Map<string, DrawnLink>();
    for (const link of flow.links) {
      const from = this.resolve(set, link.from, link.fromAncestors), to = this.resolve(set, link.to, link.toAncestors);
      if (!from || !to || from.item === to.item) continue;
      const key = `${from.item.node.id}>${to.item.node.id}>${link.back ? 'back' : ''}`;
      if (!links.has(key)) links.set(key, { from: from.item, to: to.item, ends: [this.railEnd(scene, from, link.from, link.fromAncestors), this.railEnd(scene, to, link.to, link.toAncestors)], back: link.back });
    }
    return [...links.values()];
  }
  /**
   * A flow's links as arcs: a soft glow, the line, and dashes streaming from
   * where each link starts to where it leads, all the time. The way back (a
   * response to its caller) runs on a lower arc in its own color, so it never
   * covers the way there.
   */
  private flowArcs(ctx: CanvasRenderingContext2D, viewport: Viewport, camera: Camera, links: DrawnLink[], state: RenderState): void {
    const bright = this.theme.flow.indicator;
    const phase = streamPhase(state);
    ctx.save();
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const link of links) {
      const a = this.anchor(viewport, camera, link.from), b = this.anchor(viewport, camera, link.to);
      const c = curveControl(a, b, link.back ? 0.45 : 1);
      const color = link.back ? this.toneColor('return') : this.theme.flow.step;
      const path = () => { ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.quadraticCurveTo(c.x, c.y, b.x, b.y); };
      ctx.setLineDash([]); ctx.strokeStyle = color; ctx.globalAlpha = 0.2; ctx.lineWidth = 9; path(); ctx.stroke();
      ctx.globalAlpha = 0.9; ctx.lineWidth = 2.8; path(); ctx.stroke();
      ctx.setLineDash(STREAM_DASH); ctx.lineDashOffset = phase; ctx.strokeStyle = bright; ctx.globalAlpha = 1; ctx.lineWidth = 2;
      path(); ctx.stroke();
      ctx.setLineDash([]);
      this.arrowhead(ctx, b, Math.atan2(b.y - c.y, b.x - c.x), 10, color);
    }
    ctx.restore();
  }
  /** A flow's stops: a dot on each block it passes (one per block drawn), ringed where it starts. */
  private flowStops(ctx: CanvasRenderingContext2D, viewport: Viewport, camera: Camera, set: VisibleSet, flow: FlowOverlay): void {
    const color = this.theme.flow.step, bright = this.theme.flow.indicator;
    const marks = new Map<string, { at: Point; start: boolean }>();
    for (const stop of flow.stops) {
      const at = this.resolve(set, stop.entityId, stop.ancestors);
      if (!at) continue;
      const mark = marks.get(at.item.node.id);
      if (mark) { mark.start ||= stop.start; continue; }
      marks.set(at.item.node.id, { at: this.anchor(viewport, camera, at.item), start: stop.start });
    }
    ctx.save();
    for (const { at, start } of marks.values()) {
      if (start) {
        ctx.globalAlpha = 0.9; ctx.strokeStyle = color; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(at.x, at.y, 10.5, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.globalAlpha = 1; ctx.fillStyle = color; ctx.strokeStyle = bright; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(at.x, at.y, start ? 6.5 : 5.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
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
  /**
   * The family a block is drawn in: files, entry points and tables by their
   * own (`none` without one); symbols by their file's; areas keep their colors
   * and get a badge instead.
   */
  private familyResolver(scene: Scene, families: FamilyOverlay): (node: NodeSummary) => string | undefined {
    const cached = this.familyCache.get(families);
    if (cached) return cached;
    const cache = new Map<string, string | undefined>();
    const resolve = (node: NodeSummary): string | undefined => {
      if (cache.has(node.id)) return cache.get(node.id);
      let found: string | undefined;
      if (node.kind !== 'entity' || ['repository', 'application', 'directory'].includes(node.type)) found = undefined;
      else if (families.of.has(node.id)) found = families.of.get(node.id);
      else if (['file', 'route', 'api_endpoint', 'command', 'scheduled_task', 'database_table'].includes(node.type)) found = 'none';
      else { const parent = node.spatialParentId ? scene.nodes.get(node.spatialParentId) : undefined; found = parent ? resolve(parent) : undefined; }
      cache.set(node.id, found);
      return found;
    };
    this.familyCache.set(families, resolve);
    return resolve;
  }
  private familyCache = new WeakMap<FamilyOverlay, (node: NodeSummary) => string | undefined>();
  private familyHue(key: string, families: FamilyOverlay): string { return key === 'none' ? 'none' : String(families.hues.get(key) ?? familyHashHue(key)); }
  /** Whether a block stays lit while a family is in focus: its members, and the areas and districts holding them. */
  private familyLit(scene: Scene, families: FamilyOverlay, familyOf: (node: NodeSummary) => string | undefined): (node: NodeSummary) => boolean {
    // Districts load later than the areas counted by the server: recomputed as the scene grows.
    const cached = this.familyLitCache.get(families);
    if (cached && cached.scene === scene && cached.size === scene.nodes.size) return cached.lit;
    const focus = families.focus!;
    const areas = new Set<string>();
    for (const [id, counts] of families.areas) if (counts[focus]) areas.add(id);
    for (const [id, key] of families.of) {
      if (key !== focus) continue;
      for (let node = scene.nodes.get(id); node && !areas.has(node.id); node = node.spatialParentId ? scene.nodes.get(node.spatialParentId) : undefined) areas.add(node.id);
    }
    const lit = (node: NodeSummary) => areas.has(node.id) || familyOf(node) === focus;
    this.familyLitCache.set(families, { scene, size: scene.nodes.size, lit });
    return lit;
  }
  private familyLitCache = new WeakMap<FamilyOverlay, { scene: Scene; size: number; lit: (node: NodeSummary) => boolean }>();
  /** A closed area: its main family and its share of the area's code files (in focus: the family's files there), over a bar of every family. */
  private familyBadge(ctx: CanvasRenderingContext2D, viewport: Viewport, camera: Camera, item: VisibleItem, alpha: number, counts: Record<string, number>, families: FamilyOverlay): void {
    if (item.size < 34) return;
    const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
    const focus = families.focus;
    if (!total || (focus && !counts[focus])) return;
    const ranked = Object.entries(counts).filter(([key]) => key !== 'none').sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    const name = (key: string) => key === 'none' ? families.none ?? 'No tables' : families.names.get(key) ?? key;
    const text = focus ? `${name(focus)} · ${counts[focus]} file${counts[focus] === 1 ? '' : 's'}` : ranked[0] ? `${name(ranked[0][0])} ${Math.round((ranked[0][1] / total) * 100)}%` : name('none');
    const { x, y, w, h } = item.node.rect;
    const anchor = worldToScreen(camera, viewport, x + w * 0.5, y + h - Math.min(h, w) * 0.12, item.zTop);
    ctx.save();
    ctx.globalAlpha = Math.max(0.75, alpha);
    ctx.font = `700 10px ${this.font}`; ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
    const width = Math.max(64, ctx.measureText(text).width + 14);
    ctx.fillStyle = this.theme.dark ? 'rgba(8,12,26,0.86)' : 'rgba(255,253,248,0.94)';
    roundRect(ctx, anchor.x - width / 2, anchor.y - 11, width, 22, 7); ctx.fill();
    let cursor = anchor.x - width / 2 + 5;
    for (const [key, count] of [...ranked, ...(counts.none ? [['none', counts.none] as [string, number]] : [])]) {
      const share = count / total;
      ctx.fillStyle = this.palettes.get(`family:${this.familyHue(key, families)}`, 0).top;
      ctx.fillRect(cursor, anchor.y + 5, share * (width - 10), 3);
      cursor += share * (width - 10);
    }
    ctx.fillStyle = this.theme.text.primary; ctx.fillText(text, anchor.x, anchor.y - 2);
    ctx.restore();
  }
  /**
   * The level a block is drawn in: files and entry points by their own (`none`
   * without one); symbols by their own, else by their file's (or level 1 in a
   * file with a level, when the lens measures functions); areas get a badge.
   */
  private levelResolver(scene: Scene, measure: LevelOverlay): (node: NodeSummary) => string | undefined {
    const cached = this.levelCache.get(measure);
    if (cached) return cached;
    const cache = new Map<string, string | undefined>();
    const resolve = (node: NodeSummary): string | undefined => {
      if (cache.has(node.id)) return cache.get(node.id);
      let found: string | undefined;
      if (node.kind !== 'entity' || ['repository', 'application', 'directory'].includes(node.type)) found = undefined;
      else if (measure.of.has(node.id)) found = measure.of.get(node.id);
      else if (['file', 'route', 'api_endpoint', 'command', 'scheduled_task', 'database_table'].includes(node.type)) found = 'none';
      else {
        const parent = node.spatialParentId ? scene.nodes.get(node.spatialParentId) : undefined;
        const held = parent ? resolve(parent) : undefined;
        found = measure.symbols === 'simple' && held && held !== 'none' ? '1' : held;
      }
      cache.set(node.id, found);
      return found;
    };
    this.levelCache.set(measure, resolve);
    return resolve;
  }
  private levelCache = new WeakMap<LevelOverlay, (node: NodeSummary) => string | undefined>();
  /** A closed area: how many of its code files are at the highest level it holds (from 2), over a bar of every level. */
  private levelBadge(ctx: CanvasRenderingContext2D, viewport: Viewport, camera: Camera, item: VisibleItem, alpha: number, counts: Record<string, number>, measure: LevelOverlay): void {
    if (item.size < 34) return;
    const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
    const high = ['4', '3', '2'].find(key => counts[key]);
    if (!total || !high) return;
    const text = `${counts[high]} ${measure.words[high] ?? ''}`.trim();
    const { x, y, w, h } = item.node.rect;
    const anchor = worldToScreen(camera, viewport, x + w * 0.5, y + h - Math.min(h, w) * 0.12, item.zTop);
    ctx.save();
    ctx.globalAlpha = Math.max(0.75, alpha);
    ctx.font = `700 10px ${this.font}`; ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
    const width = Math.max(64, ctx.measureText(text).width + 14);
    ctx.fillStyle = this.theme.dark ? 'rgba(8,12,26,0.86)' : 'rgba(255,253,248,0.94)';
    roundRect(ctx, anchor.x - width / 2, anchor.y - 11, width, 22, 7); ctx.fill();
    let cursor = anchor.x - width / 2 + 5;
    for (const key of ['4', '3', '2', '1', 'none']) {
      if (!counts[key]) continue;
      const share = counts[key]! / total;
      ctx.fillStyle = this.palettes.get(`level:${key}`, 0).top;
      ctx.fillRect(cursor, anchor.y + 5, share * (width - 10), 3);
      cursor += share * (width - 10);
    }
    ctx.fillStyle = this.theme.text.primary; ctx.fillText(text, anchor.x, anchor.y - 2);
    ctx.restore();
  }
  /** An open area's note (files a pull request adds there, not on the map yet): a tag under its front corner, in the pull request's color. */
  private areaNote(ctx: CanvasRenderingContext2D, viewport: Viewport, camera: Camera, item: VisibleItem, alpha: number, families: FamilyOverlay): void {
    const text = families.notes!.get(item.node.id)!;
    const { x, y, w, h } = item.node.rect;
    const corner = worldToScreen(camera, viewport, x + w, y + h, item.zTop);
    ctx.save();
    ctx.globalAlpha = Math.max(0.75, alpha);
    ctx.font = `700 10px ${this.font}`; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    const width = ctx.measureText(text).width + 24, top = corner.y + 6;
    ctx.fillStyle = this.theme.dark ? 'rgba(8,12,26,0.86)' : 'rgba(255,253,248,0.94)';
    roundRect(ctx, corner.x - width / 2, top, width, 20, 7); ctx.fill();
    ctx.fillStyle = this.palettes.get(`family:${this.familyHue(families.focus!, families)}`, 0).top;
    ctx.beginPath(); ctx.arc(corner.x - width / 2 + 10, top + 10, 3.5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = this.theme.text.primary; ctx.fillText(text, corner.x - width / 2 + 18, top + 10);
    ctx.restore();
  }
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
/** Where the streaming dashes of a flow are: they move toward the end of each link while the flow streams. */
function streamPhase(state: RenderState): number {
  return state.reducedMotion || !state.flow?.moving ? 0 : -((state.time * STREAM_SPEED) % (STREAM_DASH[0]! + STREAM_DASH[1]!));
}
/** The control point of the arc drawn between two blocks (relationships and flows share it); `lift` lowers it (the way back). */
function curveControl(from: Point, to: Point, lift = 1): Point {
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  return { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 - Math.min(220, distance * 0.35 + 20) * lift };
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
