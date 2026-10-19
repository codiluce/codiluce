// Owns a canvas: input, camera animation, render scheduling and lazy child
// loading. React never renders map primitives; it only mounts controllers.
// The single map has one (`main`); the split map of History has an `overview`
// of the whole repository and a `region` controller per place that changed,
// all drawing the same scene from their own camera.
import type { NodeSummary, Rect, SourceResponse } from '@engine/projection/dto';
import type { ResolvedScene } from '@engine/explanations/model';
import { easeInOut, fitBounds, fromScreen, ISO_X, ISO_Y, isFlat, panBy, projectedBounds, toScreen, visibleBounds, worldToScreen, zoomAround, zoomPath, type Bounds, type Camera, type Point, type Viewport, type ZoomLimits } from './camera';
import { fileOf, planBeat, type BeatPlan } from './beat';
import type { Box } from './labels';
import { CrewOnMap } from './crew-map';
import { ensureNodes } from './focus-set';
import { CORNER_LOD, DEFAULT_LOD, abstractionLevel, screenSize, type LodConfig } from './lod';
import { FLASH_MS, MapRenderer, RISE_MS, type BeatLabel, type BeatOverlay, type CalloutOverlay, type CoverageOverlay, type EdgeOverlay, type FamilyOverlay, type FlowOverlay, type FrameOverlay, type LevelOverlay, type MotionState, type RenderState } from './renderer';
import { flowAreas, flowDepths, flowLit, type MapFlow } from './map-flow';
import { nodeHeight, type Scene, type VisibleSet } from './scene';
import { DEPENDENCIES_DRAWN, isContainer, shownDependencies, type AtlasState, type AtlasStore, type MapNavigator, type ViewState } from './store';
import { familyHues, featureHues, personHue, personHues, pullHue, themeById } from './themes';
import { LENS_TEXT } from './lenses';
import { dependencyLabel } from './format';

/** A flow labels at most this many stops (the first ones), and shows at most this many pins. */
const CALLOUT_MAX = 18, PIN_MAX = 40;
/** Words go on the arrows of this many dependencies (the most connected, and the one pointed at in the list): more would hide the map. */
const DEPENDENCY_WORDS = 24;
/** While only a flow's links stream, the map is drawn at most this often (milliseconds between frames). */
const STREAM_FRAME_MS = 32;
/** Delay between a rising area and its contents, so new districts build up level by level. */
const CASCADE_MS = 70;
/** While following playback, the camera frames the changes of this recent window… */
const FOLLOW_WINDOW_MS = 1600;
/** …approaching them with this time constant, never closer than this fraction of the whole map. */
const FOLLOW_EASE_MS = 700, FOLLOW_MIN_SPAN = 0.22;
/** A commit's beat starts this long after it is on screen (the camera flies to its changes meanwhile). */
const BEAT_DELAY_MS = 450;
/** Up to this many changed files, the areas holding them open whatever the zoom, so each file is drawn. */
const BEAT_OPEN_MAX = 80;
/** Between frames while the agents on the map stand still (their idle poses change every 480 ms). */
const CREW_IDLE_MS = 160;
/** Panels over the map that labels keep clear of. */
const PANELS = ':scope > .map-controls, :scope > .status-bar, :scope > .legend, :scope > .coverage-legend, :scope > .feature-legend, :scope > .banner, :scope > .switching, :scope > .replay-bar';
/** Panels of the middle that float over the map from outside it. */
const OVER_MAP = '.tour-bar, .tour-flow-card';
interface Animation { at(t: number): Camera; start: number; duration: number }
/** The selection's dependencies as the map draws them: rails with their words, what stays lit, whose names show, the areas opened. */
interface DependencyOverlay { key: string; edges: EdgeOverlay[]; emphasis: Set<string>; within: Set<string>; named: Set<string>; force: Set<string> }
export interface DebugHandle { screenPositionOf(id: string): { x: number; y: number } | undefined; camera(): Camera; visibleIds(): string[]; rectOf(id: string): { x: number; y: number; w: number; h: number } | undefined }
export interface MapControllerOptions {
  /**
   * `main`: the single map (the store's navigator and view status). `overview`:
   * the split map's whole repository. `region`: a view of the split map. Main
   * and overview run the time-lapse clock: one is mounted at a time.
   */
  role?: 'main' | 'overview' | 'region';
  lod?: LodConfig;
  /** What fitting shows (`frame`: a part of the node, by default all of it): the whole repository by default. A node without children is framed with its surroundings. */
  home?: () => { node: NodeSummary; frame?: Rect } | undefined;
  /** More to draw: areas opened whatever their size, frames of other views; `key` changes when they do. */
  extra?: () => { key: string; force?: ReadonlySet<string>; frames?: FrameOverlay[] };
  /** The camera or the viewport changed. */
  onCamera?: () => void;
  /** Level and focus at the center (throttled); the main map reports to the store. */
  onReport?: (view: ViewState) => void;
  /** The user pressed on this map. */
  onActivate?: () => void;
  /** A click on the map, as a point of the projection plane: true when it was handled (a frame of the overview). */
  onClick?: (point: Point) => boolean;
}

export class MapController implements MapNavigator {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly renderer: MapRenderer;
  private readonly lodConfig: LodConfig;
  /** Level of detail: the map's own (folders open from Settings › Map's size, unless given one), or the corner overview's while a tool is in the middle. */
  private get lod(): LodConfig {
    if (this.small) return CORNER_LOD;
    const openPx = this.options.lod ? this.lodConfig.openPx : this.store.getState().openPx;
    if (openPx === this.lodConfig.openPx) return this.lodConfig;
    if (this.tuned?.openPx !== openPx) this.tuned = { ...this.lodConfig, openPx };
    return this.tuned;
  }
  private tuned?: LodConfig;
  private readonly role: NonNullable<MapControllerOptions['role']>;
  private lastCamera = '';
  private camera: Camera = { x: 0, y: 0, scale: 0.05 };
  private viewport: Viewport = { width: 1, height: 1 };
  private dpr = 1;
  private limits: ZoomLimits = { min: 0.001, max: 120 };
  private set: VisibleSet = { items: [], index: new Map(), pending: [], truncated: false };
  private setKey = '';
  private animation?: Animation;
  private frame = 0;
  private lastFrame = 0;
  private lastReport = 0;
  private fitted = false;
  /** Until the user moves the camera, keep the whole repository fitted as the viewport settles. */
  private autoFit = true;
  private themeId = '';
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private drag?: { x: number; y: number; moved: boolean; pinch?: number };
  private hoverPoint?: { x: number; y: number };
  private readonly faceSource = new Map<string, SourceResponse | 'loading' | 'error'>();
  private readonly cleanup: (() => void)[] = [];
  private readonly reducedMotion: MediaQueryList;
  /** Rise and flash start times; `motionUntil` is when the last of them ends. */
  private readonly motion: MotionState = { appear: new Map(), flash: new Map() };
  private motionUntil = 0;
  private drawnScene?: Scene;
  /** Where recent time-lapse frames changed something, for the follow camera. */
  private recentChanges: { bounds: Bounds; at: number }[] = [];
  /**
   * While a tool is in the middle, the main map is a small overview of the
   * whole repository: the camera it had is kept, and the last move asked of it
   * (a flight, a fit) waits until the map is back.
   */
  private overview?: { camera: Camera; autoFit: boolean; pending?: () => void };
  /** The last fit asked of the map, made again when the map is resized, until the user moves the camera. */
  private refit?: () => void;
  /** Something besides a flow's streaming changed since the last frame drawn. */
  private dirty = true;
  /** The projection the camera is in (camera.ts `isFlat`): switching converts the camera. */
  private flat = isFlat();
  /** The commit told on the map now. */
  private beat?: { key: string; plan: BeatPlan; frame: Scene; at: Map<string, number>; force?: Set<string>; labels?: { lines: object | undefined; files: BeatLabel[] } };
  private lastDraw = 0;

  constructor(private readonly canvas: HTMLCanvasElement, private readonly store: AtlasStore, private readonly options: MapControllerOptions = {}) {
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas 2D is unavailable in this browser');
    this.ctx = ctx;
    this.role = options.role ?? 'main';
    this.lodConfig = options.lod ?? DEFAULT_LOD;
    this.renderer = new MapRenderer(themeById(store.getState().themeId));
    this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (this.role === 'main') {
      store.navigator = this;
      store.visibility = id => this.has(id);
      store.openContainers = () => this.openContainers();
    }
    const resize = new ResizeObserver(() => this.resize());
    resize.observe(canvas);
    this.cleanup.push(() => resize.disconnect());
    this.cleanup.push(store.subscribe(() => this.request()));
    const listen = <K extends keyof HTMLElementEventMap>(type: K, handler: (event: HTMLElementEventMap[K]) => void, options?: AddEventListenerOptions) => {
      canvas.addEventListener(type, handler as EventListener, options);
      this.cleanup.push(() => canvas.removeEventListener(type, handler as EventListener, options));
    };
    listen('wheel', event => this.onWheel(event), { passive: false });
    listen('pointerdown', event => this.onPointerDown(event));
    listen('pointermove', event => this.onPointerMove(event));
    listen('pointerup', event => this.onPointerUp(event));
    listen('pointercancel', event => { this.pointers.delete(event.pointerId); this.drag = undefined; });
    listen('pointerleave', () => { this.hoverPoint = undefined; this.store.hover(undefined); });
    listen('dblclick', event => this.onDoubleClick(event));
    listen('contextmenu', event => {
      const point = this.local(event);
      let node = this.scene.hitTest(this.set, this.camera, this.viewport, point.x, point.y)?.node;
      while (node && !['directory', 'file', 'application', 'repository'].includes(node.type)) node = node.spatialParentId ? this.scene.nodes.get(node.spatialParentId) : undefined;
      if (!node?.path || node.path === '.' || node.type === 'repository') return;
      event.preventDefault(); this.store.openMapMenu(node, event.clientX, event.clientY);
    });
    listen('focus', () => this.options.onActivate?.());
    listen('keydown', event => this.onKey(event));
    // Tests read the map that runs the clocks: the single map, or the split map's overview.
    if (this.role !== 'region') (window as unknown as { __CODILUCE__?: DebugHandle }).__CODILUCE__ = this.debug = {
      screenPositionOf: id => { const index = this.set.index.get(id); if (index === undefined) return undefined; const item = this.set.items[index]!; const r = item.node.rect; const p = worldToScreen(this.camera, this.viewport, r.x + r.w / 2, r.y + r.h / 2, item.zTop); const box = canvas.getBoundingClientRect(); return { x: box.left + p.x, y: box.top + p.y }; },
      camera: () => ({ ...this.camera }),
      visibleIds: () => this.set.items.map(item => item.node.id),
      rectOf: id => this.scene.nodes.get(id)?.rect,
    };
    this.resize();
  }
  private debug?: DebugHandle;
  destroy(): void {
    cancelAnimationFrame(this.frame);
    if (this.reportTimer) clearTimeout(this.reportTimer);
    if (this.crewTimer) clearTimeout(this.crewTimer);
    for (const dispose of this.cleanup) dispose();
    if (this.store.navigator === this) { this.store.navigator = undefined; this.store.visibility = undefined; this.store.openContainers = undefined; }
    const global = window as unknown as { __CODILUCE__?: DebugHandle };
    if (this.debug && global.__CODILUCE__ === this.debug) delete global.__CODILUCE__;
  }
  /** Whether a node is drawn at this map's level of detail. */
  has(id: string): boolean { return this.set.index.has(id); }
  /** Containers open on this map (top-down). */
  openContainers(): string[] { return this.set.items.filter(item => item.open).map(item => item.node.id); }
  /**
   * Where a node's block is drawn, in client pixels: its own, or the nearest
   * drawn ancestor's when it is too small to draw at this level of detail.
   * Undefined when neither is on the map. Where a diagram's boxes rise from.
   */
  screenRect(id: string, ancestors: string[] = []): { x: number; y: number; w: number; h: number; own: boolean } | undefined {
    let index = this.set.index.get(id), own = true;
    for (let at = ancestors.length - 1; index === undefined && at >= 0; at--) { index = this.set.index.get(ancestors[at]!); own = false; }
    if (index === undefined) return undefined;
    const item = this.set.items[index]!;
    const bounds = projectedBounds(item.node.rect, item.zBase, item.zTop);
    const a = toScreen(this.camera, this.viewport, { x: bounds.minX, y: bounds.minY }), b = toScreen(this.camera, this.viewport, { x: bounds.maxX, y: bounds.maxY });
    const box = this.canvas.getBoundingClientRect();
    return { x: box.left + a.x, y: box.top + a.y, w: b.x - a.x, h: b.y - a.y, own };
  }
  /** CSS pixels per plane unit. */
  scale(): number { return this.camera.scale; }
  /** The part of the projection plane on screen. */
  visiblePlane(): Bounds { return visibleBounds(this.camera, this.viewport); }
  /** Back to what this map frames (its place, or the whole repository). */
  goHome(animate = true): void {
    const target = this.homeCamera();
    if (!target) return;
    this.autoFit = true;
    if (animate && this.fitted) { this.animateTo(target); this.autoFit = true; }
    else { this.camera = target; this.animation = undefined; this.fitted = true; this.request(); }
  }
  private get motionReduced(): boolean { return this.reducedMotion.matches; }
  /** What is on screen: a time-lapse frame while scrubbing or playing, otherwise the settled view. */
  private get scene(): Scene { return this.store.previewScene ?? this.store.scene; }
  private resize(): void {
    const box = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(3, window.devicePixelRatio || 1);
    const width = Math.max(1, Math.round(box.width)), height = Math.max(1, Math.round(box.height));
    // Keep the camera center fixed so panel resizing never moves the map.
    this.viewport = { width, height };
    this.canvas.width = Math.round(width * this.dpr); this.canvas.height = Math.round(height * this.dpr);
    this.setKey = '';
    if (this.small) {
      this.overview ??= { camera: this.camera, autoFit: this.autoFit };
      this.updateLimits(); const target = this.homeCamera(); if (target) { this.camera = target; this.animation = undefined; }
    } else if (this.overview) {
      const { camera, autoFit, pending } = this.overview;
      this.overview = undefined;
      this.camera = camera; this.autoFit = autoFit; this.animation = undefined; this.updateLimits();
      pending?.();
    } else if (this.autoFit && this.fitted) { this.updateLimits(); const target = this.homeCamera(); if (target) this.camera = target; }
    else if (this.refit && this.fitted) { this.updateLimits(); this.refit(); }
    this.request();
  }
  /**
   * The main map is not in the middle: an overview in a corner (a tool is in
   * the middle), or hidden (another view of a flow has the whole middle).
   */
  private get small(): boolean { return this.role === 'main' && !mapInMiddle(this.store.getState()); }
  /** Whether a camera move must wait for the map to be back in the middle (it is kept as the one to make then). */
  private deferred(move: () => void): boolean {
    // Also while the map grows back (the middle changed, the canvas is not resized yet).
    if (!this.small && !this.overview) return false;
    (this.overview ??= { camera: this.camera, autoFit: this.autoFit }).pending = move;
    return true;
  }
  private rootBounds() {
    const root = this.scene.rootId ? this.scene.nodes.get(this.scene.rootId) : undefined;
    return root ? projectedBounds(root.rect, 0, 40) : undefined;
  }
  /** The camera framing this map's home: its place (a leaf with room around it), else the whole repository. */
  private homeCamera(focus = this.options.home?.()): Camera | undefined {
    if (!focus) {
      const bounds = this.rootBounds();
      if (!bounds) return undefined;
      // While agents are on the map, room at its right for their queue.
      const room = Math.min(this.crewRoom, this.viewport.width * 0.4), camera = fitBounds(bounds, { ...this.viewport, width: Math.max(1, this.viewport.width - room) }, this.role === 'main' ? 32 : 14, this.limits);
      return room ? { ...camera, x: camera.x + room / 2 / camera.scale } : camera;
    }
    const { node } = focus, rect = focus.frame ?? node.rect;
    const z = this.scene.nodes.has(node.id) ? this.scene.zBase(node.id) : 0;
    // A frame inside the node: what stands on it rises above the node's top.
    const camera = fitBounds(projectedBounds(rect, z, z + nodeHeight(node) + (focus.frame ? 12 : 0)), this.viewport, 22, this.limits);
    if (node.childCount > 0) return camera;
    return { ...camera, scale: Math.max(this.limits.min, Math.min(camera.scale, (0.42 * Math.min(this.viewport.width, this.viewport.height)) / Math.sqrt(rect.w * rect.h))) };
  }
  private updateLimits(): void {
    const bounds = this.rootBounds();
    if (!bounds) return;
    const fit = fitBounds(bounds, this.viewport, 24, { min: 1e-6, max: 1e6 });
    this.limits = { min: fit.scale * 0.4, max: 120 };
  }
  /** Draw again on the next frame; `changed` false when only a flow's streaming moves. */
  request(changed = true): void {
    if (changed) this.dirty = true;
    if (!this.frame) this.frame = requestAnimationFrame(time => this.tick(time));
  }
  // MapNavigator --------------------------------------------------------------
  fitAll(): void {
    const target = this.homeCamera();
    if (target) this.animateTo(target);
  }
  fitNodes(nodes: NodeSummary[]): void {
    if (!nodes.length || this.deferred(() => this.fitNodes(nodes))) return;
    const bounds = this.boundsOf(nodes);
    this.animateTo(fitBounds(bounds, this.viewport, this.fitPadding(), this.limits));
    // Resizing the map (a split of the middle moving) frames the same nodes again.
    this.refit = () => { this.camera = fitBounds(bounds, this.viewport, this.fitPadding(), this.limits); this.animation = undefined; };
  }
  reveal(nodes: NodeSummary[]): void {
    if (!nodes.length || this.deferred(() => this.reveal(nodes))) return;
    const bounds = this.boundsOf(nodes), padding = this.fitPadding();
    // Where the camera is going, when it is on its way (flying to the selection).
    const camera = this.animation?.at(1) ?? this.camera, view = visibleBounds(camera, this.viewport, -padding);
    if (bounds.minX >= view.minX && bounds.maxX <= view.maxX && bounds.minY >= view.minY && bounds.maxY <= view.maxY) return;
    const target = fitBounds(bounds, this.viewport, padding, this.limits);
    this.animateTo({ ...target, scale: Math.min(target.scale, camera.scale) });
  }
  private boundsOf(nodes: NodeSummary[]): Bounds {
    return nodes.map(node => { const z = this.scene.nodes.has(node.id) ? this.scene.zBase(node.id) : 0; return projectedBounds(node.rect, z, z + nodeHeight(node)); })
      .reduce(union);
  }
  private fitPadding(): number { return Math.min(72, Math.max(24, Math.min(this.viewport.width, this.viewport.height) * 0.12)); }
  zoomBy(factor: number): void { if (this.deferred(() => this.zoomBy(factor))) return; this.animateTo(zoomAround(this.camera, this.viewport, this.viewport.width / 2, this.viewport.height / 2, factor, this.limits), 260); }
  flyTo(node: NodeSummary, options: { mode?: 'focus' | 'enter' } = {}): void {
    if (this.deferred(() => this.flyTo(node, options))) return;
    const zBase = this.scene.nodes.has(node.id) ? this.scene.zBase(node.id) : 0;
    const bounds = projectedBounds(node.rect, zBase, zBase + nodeHeight(node));
    let target = fitBounds(bounds, this.viewport, 48, this.limits);
    if ((options.mode ?? 'focus') === 'focus') {
      // Leaves: keep surrounding context visible instead of filling the screen.
      const desired = Math.max(this.lod.detailPx * 0.9, Math.min(this.viewport.width, this.viewport.height) * 0.16);
      target = { ...target, scale: Math.min(target.scale, Math.max(this.limits.min, desired / Math.sqrt(node.rect.w * node.rect.h))) };
    }
    this.animateTo(target);
  }
  private animateTo(target: Camera, fixedDuration?: number): void {
    if (this.fitted) this.autoFit = false;
    this.refit = undefined;
    if (this.motionReduced || !this.fitted) { this.camera = target; this.animation = undefined; this.fitted = true; this.request(); return; }
    const path = zoomPath(this.camera, target, this.viewport);
    const duration = fixedDuration ?? Math.min(1700, 450 + path.length * 260);
    this.animation = { at: path.at, start: performance.now(), duration };
    this.request();
  }
  // Frame -----------------------------------------------------------------------
  private tick(time: number): void {
    this.frame = 0;
    // Only the streaming of a flow moves: no need to draw every frame.
    if (!this.dirty && !this.animation && time >= this.motionUntil && !this.store.getState().timeline.playing && time - this.lastDraw < STREAM_FRAME_MS) { this.request(false); return; }
    this.dirty = false; this.lastDraw = time;
    const elapsed = this.lastFrame ? Math.min(100, time - this.lastFrame) : 16;
    this.lastFrame = time;
    const clock = this.role !== 'region';
    if (clock && this.store.getState().timeline.playing) this.store.advancePlayback(elapsed);
    const state = this.store.getState();
    const scene = this.scene;
    if (isFlat() !== this.flat) this.projectionChanged();
    if (scene !== this.drawnScene) { this.sceneChanged(this.drawnScene, scene, time, state); this.drawnScene = scene; }
    this.updateBeat(state, time);
    if (this.role === 'main' && state.timeline.playing && state.timeline.follow) this.follow(time, elapsed);
    if (!this.fitted && this.scene.rootId) {
      this.updateLimits();
      // A place of the split map opened on its own starts there.
      const focus = this.role === 'main' ? this.store.takeFocus() : undefined;
      if (focus) this.autoFit = false;
      this.camera = this.homeCamera(focus) ?? this.camera; this.fitted = true;
    } else this.updateLimits();
    if (this.animation) {
      const t = Math.min(1, (time - this.animation.start) / this.animation.duration);
      this.camera = this.animation.at(easeInOut(t));
      if (t >= 1) this.animation = undefined;
    }
    if (state.themeId !== this.themeId) {
      this.themeId = state.themeId;
      const theme = themeById(state.themeId);
      this.renderer.setTheme(theme);
      // Labels use the theme's font: draw again once it has loaded.
      if (theme.style?.font && typeof document !== 'undefined') document.fonts?.load(`600 12px ${theme.style.font}`).then(() => this.request(), () => undefined);
    }
    const shown = this.shownFlow(this.store.getState());
    const extra = this.options.extra?.();
    const flowAreas = shown && !this.store.previewScene ? this.areasOf(shown.flow, shown.branch) : undefined;
    // The selection's dependencies end on their files: the areas holding them open whatever the zoom.
    const dependencies = shown || this.store.previewScene ? undefined : this.dependencyOverlay(state);
    const opened = [flowAreas, dependencies?.force, extra?.force, this.beat?.force].filter((areas): areas is ReadonlySet<string> => !!areas?.size);
    const force = opened.length > 1 ? new Set(opened.flatMap(areas => [...areas])) : opened[0];
    // Shapes are buildings: in plan, blocks stay flat.
    this.scene.shapes = state.shapes && !this.flat; this.scene.setStreets(state.streets);
    const key = `${state.shapes ? 'S' : 'P'}|${this.flat ? 'plan' : 'iso'}|${this.camera.x}|${this.camera.y}|${this.camera.scale}|${this.viewport.width}|${this.viewport.height}|${this.scene.revision}|${shown ? `${shown.flow.key}#${shown.branch ?? 'all'}` : ''}|${extra?.key ?? ''}|${this.beat?.force ? this.beat.key : ''}|${dependencies?.key ?? ''}|${this.lod.openPx}`;
    if (key !== this.setKey) {
      this.set = this.scene.visible(this.camera, this.viewport, this.lod, force);
      this.setKey = key;
      if (this.set.pending.length) void this.store.loadChildren(this.set.pending);
    }
    const render = this.renderState(state, time);
    if (extra?.frames) render.frames = extra.frames;
    // The agents at work, on the map: they take their places first (the map's labels give way), their names last.
    const crew = this.crewFrame(state, time);
    if (crew) render.reserved = crew.reserved;
    if (render.beat || render.callouts?.length || render.edges.some(edge => edge.label)) render.keepClear = this.panels();
    this.renderer.render(this.ctx, this.dpr, this.viewport, this.camera, this.scene, this.set, render, this.lod);
    crew?.draw(this.ctx);
    const moved = `${this.camera.x}|${this.camera.y}|${this.camera.scale}|${this.viewport.width}|${this.viewport.height}`;
    if (moved !== this.lastCamera) { this.lastCamera = moved; this.options.onCamera?.(); }
    this.scheduleReport(time);
    if (this.animation || state.timeline.playing || time < this.motionUntil || this.renderer.railsPending) this.request();
    // Flows stream (not with reduced motion); the agents on the map move (every frame) or breathe (a few frames a second).
    else if ((shown && !this.motionReduced && !this.store.previewScene) || crew?.moving) this.request(false);
    else if (crew && !this.crewTimer) this.crewTimer = setTimeout(() => { this.crewTimer = undefined; this.request(false); }, CREW_IDLE_MS);
    if (!this.animation && time >= this.motionUntil && (this.motion.appear.size || this.motion.flash.size)) { this.motion.appear.clear(); this.motion.flash.clear(); }
  }
  /**
   * Agents on the map (Agents › Show agents on the map): the main map, in the
   * middle, on the live index (activity belongs to the working tree, not to a
   * commit in History). A session opened in Agents keeps only its characters;
   * the pointer on a session in the list dims the others.
   */
  private crewFrame(state: AtlasState, time: number) {
    if (this.role !== 'main' || this.small || !state.agents.show || state.meta?.snapshot.kind === 'commit' || this.store.previewScene) { if (this.role === 'main') { this.publishPlaces({}); this.makeRoom(0); } return undefined; }
    this.crew ??= new CrewOnMap(() => this.store.scene, (ids, areas) => void ensureNodes(this.store, ids, areas).catch(() => undefined), progress => queueMicrotask(() => this.store.replayProgress(progress)));
    this.crew.sync(state.agents.snapshot, state.agents.replay);
    const opened = state.journal.open.includes('conversations') ? state.journal.conversationId : undefined;
    const frame = this.crew.frame(this.viewport, this.camera, this.set, time, this.motionReduced, { ...(opened ? { focus: opened } : {}), ...(state.agents.hover ? { dim: state.agents.hover } : {}) });
    this.publishPlaces(this.crew.places());
    this.makeRoom(this.crew.room(this.viewport));
    return frame;
  }
  /** The agents' queue wants this much room at the map's right: a map still at its fitted home moves over for it. */
  private makeRoom(room: number): void {
    if (room === this.crewRoom) return;
    this.crewRoom = room;
    if (this.autoFit && this.fitted && !this.animation) queueMicrotask(() => { if (this.autoFit && !this.animation) this.goHome(); });
  }
  private crewRoom = 0;
  /** Where the characters stand, for the Agents list (only when it changes). */
  private publishPlaces(places: Record<string, string[]>): void {
    const key = JSON.stringify(places);
    if (key !== this.crewPlaces) { this.crewPlaces = key; queueMicrotask(() => this.store.setActivity({ places })); }
  }
  private crew?: CrewOnMap;
  private crewPlaces = '{}';
  private crewTimer?: ReturnType<typeof setTimeout>;
  /** The projection changed (2D plan ⇄ isometric): the same place stays in the middle, at about the same size. */
  private projectionChanged(): void {
    const flat = isFlat();
    const center = this.camera;
    // Ground point under the middle in the old projection, then where it is in the new one.
    const ground = flat ? { x: (center.x / ISO_X + center.y / ISO_Y) / 2, y: (center.y / ISO_Y - center.x / ISO_X) / 2 } : { x: center.x, y: center.y };
    const plane = flat ? ground : { x: (ground.x - ground.y) * ISO_X, y: (ground.x + ground.y) * ISO_Y };
    this.flat = flat; this.animation = undefined; this.setKey = '';
    this.camera = { ...this.camera, ...plane };
    this.updateLimits();
    if (this.autoFit || !this.fitted) { const target = this.homeCamera(); if (target) this.camera = target; }
    else this.camera = { ...this.camera, scale: Math.max(this.limits.min, Math.min(this.limits.max, this.camera.scale)) };
    if (this.overview) this.overview.camera = this.camera;
    this.dirty = true;
  }
  /**
   * The commit on screen in History, told on the map: its changed files land
   * one after another (removals, moves, additions, then changes, the biggest
   * first), each labeled, after the camera has flown to them (while following).
   * Not while playing: the time-lapse moves on too fast to read.
   */
  private updateBeat(state: AtlasState, time: number): void {
    const timeline = state.timeline, evolution = this.store.evolution;
    const commit = timeline.mode === 'git' ? timeline.gitTarget : timeline.target;
    const frameIndex = this.role === 'main' && timeline.open && !timeline.playing && commit && evolution ? evolution.frameOf(commit) : undefined;
    if (frameIndex === undefined) { this.beat = undefined; return; }
    // The frame of that commit: what changed there, as the History time-lapse places it.
    const key = `${timeline.mode}|${commit}|${evolution!.stamp}`;
    if (this.beat?.key === key) return;
    const preview = this.store.previewScene;
    const frame = preview?.frame === frameIndex ? preview : evolution!.scene(frameIndex, { ghosts: true });
    const plan = planBeat(frame, { t0: time + (this.motionReduced ? 0 : BEAT_DELAY_MS) });
    const at = new Map<string, number>();
    for (const file of plan.files) {
      at.set(file.id, file.at);
      // The areas holding it change when it lands (a new folder appears just before its first file).
      for (let node = frame.nodes.get(file.id); node?.spatialParentId; node = frame.nodes.get(node.spatialParentId)) {
        const parent = frame.nodes.get(node.spatialParentId);
        if (!parent?.change || parent.change.status === 'unchanged') continue;
        at.set(parent.id, Math.min(at.get(parent.id) ?? Infinity, file.at - 120));
      }
    }
    // Symbols change with their file.
    for (const node of frame.nodes.values()) {
      if (at.has(node.id) || !node.change || node.change.status === 'unchanged') continue;
      const file = fileOf(frame, node.id);
      const landing = file ? at.get(file) : undefined;
      if (landing !== undefined) at.set(node.id, landing);
    }
    let force: Set<string> | undefined;
    if (plan.files.length && plan.files.length <= BEAT_OPEN_MAX) {
      force = new Set();
      for (const file of plan.files) for (let node = frame.nodes.get(file.id); node?.spatialParentId; node = frame.nodes.get(node.spatialParentId)) force.add(node.spatialParentId);
    }
    this.beat = { key, plan, frame, at, ...(force ? { force } : {}) };
    if (this.motionReduced) return;
    // Rises and flashes when each lands, not all at once.
    for (const [id, landing] of at) {
      const status = frame.nodes.get(id)?.change?.status;
      if (status === 'added') this.motion.appear.set(id, landing); else this.motion.appear.delete(id);
      this.motion.flash.set(id, landing);
    }
    this.motionUntil = Math.max(this.motionUntil, plan.end + FLASH_MS);
    if (timeline.follow) this.frameBeat(frame, plan);
  }
  /** Fly to a beat's changes, with some of the map around them. */
  private frameBeat(frame: Scene, plan: BeatPlan): void {
    const root = this.rootBounds();
    const boxes = plan.files.flatMap(file => { const node = this.scene.nodes.get(file.id) ?? frame.nodes.get(file.id); if (!node) return []; const z = this.scene.nodes.has(node.id) ? this.scene.zBase(node.id) : 0; return [projectedBounds(node.rect, z, z + nodeHeight(node))]; });
    if (!boxes.length || !root || this.deferred(() => this.frameBeat(frame, plan))) return;
    const bounds = boxes.reduce(union);
    const grow = (min: number, max: number, span: number) => { const missing = Math.max(0, span - (max - min)) / 2; return [min - missing, max + missing] as const; };
    const [minX, maxX] = grow(bounds.minX, bounds.maxX, (root.maxX - root.minX) * FOLLOW_MIN_SPAN), [minY, maxY] = grow(bounds.minY, bounds.maxY, (root.maxY - root.minY) * FOLLOW_MIN_SPAN);
    const target = fitBounds({ minX, maxX, minY, maxY }, this.viewport, Math.min(110, Math.max(40, Math.min(this.viewport.width, this.viewport.height) * 0.16)), this.limits);
    this.animateTo(target, 650);
  }
  /** The beat as the renderer draws it; labels carry the lines Git reports per file once they arrive. */
  private beatOverlay(state: AtlasState): BeatOverlay {
    const beat = this.beat!;
    const changes = state.timeline.mode === 'git' && state.timeline.gitChanges?.data && state.timeline.gitChanges.data.sha === state.timeline.gitTarget ? state.timeline.gitChanges.data : undefined;
    if (!beat.labels || beat.labels.lines !== changes) {
      const lines = new Map(changes?.files.map(file => [file.path, { added: file.added, removed: file.deleted }]) ?? []);
      beat.labels = {
        lines: changes,
        files: beat.plan.files.map(file => {
          const ancestors: string[] = [];
          for (let node = beat.frame.nodes.get(file.id); node?.spatialParentId; node = beat.frame.nodes.get(node.spatialParentId)) ancestors.unshift(node.spatialParentId);
          const counted = lines.get(file.path);
          return { id: file.id, ancestors, status: file.status, name: file.name, at: file.at, ...(counted ? { lines: counted } : file.lines.added + file.lines.removed ? { lines: file.lines } : {}) };
        }),
      };
    }
    return { at: beat.at, files: beat.labels.files };
  }
  /** The panels over this map (its own, and a tour's bar), in canvas pixels. */
  private panels(): Box[] {
    const stage = this.canvas.parentElement;
    if (!stage) return [];
    const box = this.canvas.getBoundingClientRect();
    return [...stage.querySelectorAll<HTMLElement>(PANELS), ...document.querySelectorAll<HTMLElement>(OVER_MAP)].flatMap(element => {
      const rect = element.getBoundingClientRect();
      return rect.width && rect.height ? [{ x0: rect.left - box.left - 4, y0: rect.top - box.top - 4, x1: rect.right - box.left + 4, y1: rect.bottom - box.top + 4 }] : [];
    });
  }
  private reportTimer?: ReturnType<typeof setTimeout>;
  /** Throttled status reporting (level, focus chain, visible items) to the store. */
  private scheduleReport(time: number): void {
    if (this.animation) return;
    if (time - this.lastReport > 160) { this.lastReport = time; this.report(this.store.getState()); return; }
    if (this.reportTimer) return;
    this.reportTimer = setTimeout(() => { this.reportTimer = undefined; this.lastReport = performance.now(); this.report(this.store.getState()); }, 170);
  }
  private renderState(state: AtlasState, time: number): RenderState {
    const selection = state.selection;
    // The selection's connections show only with Dependencies on: as rails to the files at their other ends.
    const dependencies = this.dependencyOverlay(state);
    const edges = dependencies?.edges ?? [], emphasis = dependencies?.emphasis, within = dependencies?.within;
    const unresolvedCount = dependencies && selection && !isContainer(selection.node ?? { type: 'file', kind: 'entity' }) && selection.node?.type !== 'file' ? state.diagnostics.data?.codes.find(code => code.code === 'unresolved-http-call')?.count ?? 0 : 0;
    const render: RenderState = {
      selectedId: selection?.id, hoveredId: state.hover?.id ?? (dependencies ? state.dependencies.hover : undefined), emphasis, within, edges,
      showDiagnostics: state.showDiagnostics, source: this.sourceFace(state), time, reducedMotion: this.motionReduced, shapes: state.shapes, streets: state.streets, connections: state.connections,
      ...(state.meta?.comparison ? { comparison: { dimUnchanged: state.timeline.dimUnchanged } } : {}),
      ...(unresolvedCount && selection ? { unresolved: { nodeId: selection.id, count: unresolvedCount } } : {}),
      ...this.analysisOverlays(state, time),
      motion: this.motion,
      // A time-lapse frame compares with the previous commit; overlays loaded for the settled view wait until it is back.
      ...(this.store.previewScene ? { edges: [], emphasis: undefined, within: undefined, lit: undefined, flow: undefined, callouts: undefined, pins: undefined, coverage: undefined, families: undefined, measure: undefined, feature: undefined, people: undefined, person: undefined, pull: undefined, explanation: undefined, pointer: undefined, unresolved: undefined, impact: undefined, comparison: state.timeline.compare || state.timeline.mode === 'git' ? { dimUnchanged: state.timeline.dimUnchanged } : undefined } : {}),
      ...(this.beat && !this.small ? { beat: this.beatOverlay(state) } : {}),
    };
    // Dependencies are drawn as a diagram on the map: rails along the floors, their ends named, the one pointed at in the list in front.
    if (dependencies && render.edges === dependencies.edges && edges.length) {
      render.connections = 'rails'; render.named = dependencies.named;
      if (state.dependencies.hover) render.spotlight = true;
    }
    return render;
  }
  /**
   * Dependencies on the map (the Dependencies button): one rail per
   * dependency between the selection and the file at its other end, labeled
   * with what it does, the most connected first. What they reach stays lit
   * (the rest recedes), their ends are named, and the areas holding the
   * selection and those files open whatever the zoom, so the rails end on them.
   */
  private dependencyOverlay(state: AtlasState): DependencyOverlay | undefined {
    const dependencies = state.dependencies, selection = state.selection;
    // With a tool in the middle, the overview in the corner shows what that tool lights instead.
    const data = dependencies.show && !this.small && selection && dependencies.forId === selection.id ? dependencies.data : undefined;
    if (!data || !selection) return undefined;
    const cached = this.dependencyCache;
    if (cached && cached.data === data && cached.locate === selection.locate && cached.type === dependencies.type && cached.direction === dependencies.direction && cached.hover === dependencies.hover) return cached.overlay;
    const ancestors = selection.locate?.spatialAncestors.map(node => node.id) ?? [];
    const shown = shownDependencies(dependencies).slice(0, DEPENDENCIES_DRAWN);
    const emphasis = new Set([selection.id]), within = new Set([selection.id]), named = new Set<string>(), force = new Set(ancestors);
    const edges = shown.map((item, index): EdgeOverlay => {
      emphasis.add(item.end.id); within.add(item.end.id); named.add(item.end.id);
      for (const id of item.endAncestors) { emphasis.add(id); force.add(id); }
      const types = dependencies.type ? item.types.filter(entry => entry.type === dependencies.type) : item.types;
      const outgoing = item.direction === 'outgoing';
      return {
        key: `dependency:${item.direction}:${item.end.id}`, type: types[0]!.type, count: types.reduce((sum, entry) => sum + entry.count, 0),
        from: outgoing ? selection.id : item.end.id, fromAncestors: outgoing ? ancestors : item.endAncestors,
        to: outgoing ? item.end.id : selection.id, toAncestors: outgoing ? item.endAncestors : ancestors,
        emphasized: dependencies.hover === item.end.id, far: { side: outgoing ? 'to' : 'from', name: item.end.name },
        ...(index < DEPENDENCY_WORDS || dependencies.hover === item.end.id ? { label: dependencyLabel(types, item.direction) } : {}),
      };
    });
    const overlay = { key: `${selection.id}|${dependencies.type ?? ''}|${dependencies.direction}|${shown.length}`, edges, emphasis, within, named, force };
    this.dependencyCache = { data, locate: selection.locate, type: dependencies.type, direction: dependencies.direction, hover: dependencies.hover, overlay };
    return overlay;
  }
  private dependencyCache?: { data: object; locate?: object; type?: string; direction: string; hover?: string; overlay: DependencyOverlay };
  /**
   * Blast radius (of the selection, or of a comparison's changes) and the
   * Steps picture. An open Steps panel lights its entities and draws its links
   * in place of the selection's relationships.
   */
  private analysisOverlays(state: AtlasState, time: number): Partial<RenderState> {
    const result: Partial<RenderState> = {};
    const stamp = this.store.viewStamp();
    // With a tool in the middle, the overview shows what that tool lights, and nothing else.
    const tool = this.role === 'main' ? state.center : 'map';
    const impact = tool !== 'map' && tool !== 'impact' ? undefined : state.impact.open && state.impact.data && state.impact.viewStamp === stamp ? state.impact.data
      : state.commitImpact.show && state.commitImpact.data && state.commitImpact.viewStamp === stamp ? state.commitImpact.data : undefined;
    if (impact) {
      if (this.impactCache?.data !== impact) this.impactCache = { data: impact, overlay: { distances: new Map(Object.entries(impact.distances)), areas: new Map(Object.entries(impact.areas)), depth: impact.depth, dimOthers: !state.meta?.comparison } };
      result.impact = this.impactCache.overlay;
    }
    const steps = (tool === 'map' || tool === 'flow') && state.steps?.status === 'ready' && state.steps.viewStamp === stamp ? state.steps.data : undefined;
    // A flow in lanes in the middle: the overview lights what it passes.
    const lanes = tool === 'flow' && state.flowView?.lanes && state.requests.open?.id === state.flowView.id && state.requests.open.viewStamp === stamp ? state.requests.open.data : undefined;
    if (lanes && !steps) {
      const emphasis = new Set<string>();
      for (const node of lanes.nodes) { for (const id of node.ancestors) emphasis.add(id); if (node.node) emphasis.add(node.node.id); }
      result.emphasis = emphasis;
      result.within = undefined;
      result.edges = [];
    }
    if (steps) {
      const byId = new Map(steps.steps.map(step => [step.id, step]));
      const emphasis = new Set<string>();
      for (const step of steps.steps) { for (const id of step.ancestors) emphasis.add(id); if (step.node) emphasis.add(step.node.id); }
      const focus = state.steps!.focus;
      const edges: EdgeOverlay[] = [];
      for (const link of steps.links) {
        const from = byId.get(link.from), to = byId.get(link.to);
        if (!from?.node || !to) continue;
        const target = to.node?.id ?? to.ancestors.at(-1);
        if (!target) continue;
        edges.push({ key: link.id, type: to.effect ? 'effect' : link.hops.at(-1)?.type ?? 'calls', count: 1, from: from.node.id, fromAncestors: from.ancestors, to: target, toAncestors: to.node ? to.ancestors : to.ancestors.slice(0, -1), emphasized: !!focus && (link.from === focus || link.to === focus) });
      }
      result.emphasis = emphasis;
      result.within = undefined;
      result.edges = edges;
    }
    const shown = this.shownFlow(state);
    if (shown) Object.assign(result, this.mapFlowOverlay(shown));
    // Too small for the labels of a flow's stops.
    if (this.small) { result.callouts = undefined; result.pins = undefined; }
    // Explanations: the link under the pointer lights what it names; otherwise the open explanation lights everything it links.
    const explain = state.explain;
    const scene = tool === 'tour' ? sceneOnStage(state) : undefined;
    // A tour's scene lights its code. On the map (a map scene, or a diagram scene while tours stay on the map) its
    // code is numbered with the scene's captions, where it is, and the scene's arrows run between it with their words.
    if (scene && !explain.hover) {
      const onMap = scene.view === 'map' || (scene.view === 'diagram' && state.tourView !== 'diagram');
      if (this.sceneCache?.scene !== scene || this.sceneCache.onMap !== onMap) {
        const shown = scene.boxes.filter(box => box.link.status !== 'missing');
        const byKey = new Map(shown.map(box => [box.key, box]));
        this.sceneCache = {
          scene, onMap, overlay: linkOverlay([...shown.map(box => box.link), ...scene.flow && scene.flow.status !== 'missing' ? [scene.flow] : []], scene.title),
          callouts: onMap ? shown.flatMap((box, index) => box.link.id ? [{ entityId: box.link.id, ancestors: box.link.ancestors ?? [], number: index + 1, label: box.caption ?? box.link.label ?? box.link.name ?? box.link.href, tone: 'call' as const, current: false }] : []) : undefined,
          edges: onMap ? scene.arrows.flatMap((arrow, index): EdgeOverlay[] => {
            const from = byKey.get(arrow.fromKey)?.link, to = byKey.get(arrow.toKey)?.link;
            if (!from?.id || !to?.id) return [];
            return [{ key: `scene:${index}`, from: from.id, fromAncestors: from.ancestors ?? [], to: to.id, toAncestors: to.ancestors ?? [], type: arrow.evidence[0]?.type ?? 'scene', count: 1, emphasized: true, ...(arrow.label ? { label: arrow.label } : {}), ...(arrow.undirected ? { directed: false } : {}) }];
          }) : [],
        };
      }
      result.explanation = this.sceneCache.overlay;
      result.edges = this.sceneCache.edges;
      result.callouts = this.sceneCache.callouts;
      result.pins = undefined;
    }
    if (explain.hover) {
      const link = explain.hover;
      if (this.explainHoverCache?.link !== link) this.explainHoverCache = { link, overlay: linkOverlay([link], link.label ?? link.name ?? link.href) };
      result.explanation = this.explainHoverCache.overlay;
      // While reading, the link is what matters: the selection's connections step aside.
      result.edges = [];
      if (link.id) result.pointer = { id: link.id, ancestors: link.ancestors ?? [] };
    } else if (!scene && explain.open && explain.lens && explain.detail?.data && explain.detail.data.footprint.ids.length) {
      const detail = explain.detail.data;
      if (this.explainCache?.detail !== detail) this.explainCache = { detail, overlay: { of: new Map(detail.footprint.ids.map(id => [id, EXPLAINED])), areas: new Map(Object.entries(detail.footprint.areas).map(([id, count]) => [id, { [EXPLAINED]: count }])), names: new Map([[EXPLAINED, 'Linked']]), hues: new Map([[EXPLAINED, EXPLAINED_HUE]]), focus: EXPLAINED } };
      result.explanation = this.explainCache.overlay;
    }
    if (tool !== 'map' && tool !== 'files') return result;
    const coverage = state.coverage.show && state.coverage.data && state.coverage.viewStamp === stamp ? state.coverage.data : undefined;
    if (coverage) {
      if (this.coverageCache?.data !== coverage) this.coverageCache = { data: coverage, overlay: { files: new Map(Object.entries(coverage.files).map(([id, item]) => [id, item.category])), areas: new Map(Object.entries(coverage.areas)) } };
      result.coverage = this.coverageCache.overlay;
    }
    const families = state.families.show && state.families.data && state.families.viewStamp === stamp ? state.families.data : undefined;
    if (families) {
      const focus = state.families.focus;
      if (this.familyCache?.data !== families || this.familyCache.focus !== focus) this.familyCache = { data: families, focus, overlay: { of: new Map(Object.entries(families.of)), areas: new Map(Object.entries(families.areas)), names: new Map(families.families.map(family => [family.key, family.name])), hues: familyHues(families.families.map(family => family.key)), ...(focus ? { focus } : {}) } };
      result.families = this.familyCache.overlay;
    }
    const features = state.features.focus && state.features.data && state.features.viewStamp === stamp ? state.features.data : undefined;
    if (features) {
      const focus = state.features.focus!;
      if (this.featureCache?.data !== features || this.featureCache.focus !== focus) this.featureCache = { data: features, focus, overlay: { of: new Map(Object.entries(features.of)), areas: new Map(Object.entries(features.areas)), names: new Map(features.features.map(feature => [feature.key, feature.name])), hues: featureHues(features.features.map(feature => feature.key)), focus } };
      result.feature = this.featureCache.overlay;
    }
    // People: files colored by who changed each most; one person in focus lights what they changed.
    const peopleStamp = this.store.peopleStamp();
    const people = state.people.show && state.people.data?.available && state.people.stamp === peopleStamp ? state.people.data : undefined;
    if (people) {
      if (this.peopleCache?.data !== people) this.peopleCache = { data: people, overlay: { of: new Map(Object.entries(people.of)), areas: new Map(Object.entries(people.areas)), names: new Map(people.people.map(person => [person.key, person.name])), hues: personHues(people.people), none: 'Not changed' } };
      result.people = this.peopleCache.overlay;
    }
    // A measure: files (and functions) by level.
    const measure = state.lens.show && state.lens.data?.available && state.lens.data.lens === state.lens.show && state.lens.stamp === this.store.lensStamp() ? state.lens.data : undefined;
    if (measure) {
      if (this.measureCache?.data !== measure) this.measureCache = { data: measure, overlay: { of: new Map(Object.entries(measure.of).map(([id, level]) => [id, String(level)])), areas: new Map(Object.entries(measure.areas)), symbols: measure.symbols, words: LENS_TEXT[measure.lens].words } };
      result.measure = this.measureCache.overlay;
    }
    const person = state.people.focus && state.people.person?.key === state.people.focus && state.people.person.stamp === peopleStamp ? state.people.person.data : undefined;
    if (person) {
      if (this.personCache?.data !== person) {
        const key = person.person.key;
        this.personCache = { data: person, overlay: { of: new Map([...Object.keys(person.files), ...person.entries].map(id => [id, key])), areas: new Map(Object.entries(person.areas).map(([id, count]) => [id, { [key]: count }])), names: new Map([[key, person.person.name]]), hues: new Map([[key, personHue(person.person.order)]]), focus: key, none: 'Not changed' } };
      }
      result.person = this.personCache.overlay;
    }
    // One pull request in focus lights the files it changes.
    const pull = state.pulls.focus && state.pulls.pull?.id === state.pulls.focus && state.pulls.pull.stamp === peopleStamp ? state.pulls.pull.data : undefined;
    if (pull) {
      if (this.pullCache?.data !== pull) {
        const key = pull.pull.id;
        // Folders that will hold files it adds say so under their name while open.
        const notes = new Map(pull.folders.flatMap(folder => folder.newFiles ? [[folder.id, `+${folder.newFiles} new${folder.newFolders?.length ? ` · ${folder.newFolders.slice(0, 2).map(name => `${name}/`).join(', ')}${folder.newFolders.length > 2 ? '…' : ''}` : ''}`] as const] : []));
        this.pullCache = { data: pull, overlay: { of: new Map([...Object.keys(pull.files), ...pull.entries].map(id => [id, key])), areas: new Map(Object.entries(pull.areas).map(([id, count]) => [id, { [key]: count }])), names: new Map([[key, pull.pull.number !== undefined ? `#${pull.pull.number}` : pull.pull.title]]), hues: new Map([[key, pullHue(pull.pull.state)]]), focus: key, none: 'Not changed', ...(notes.size ? { notes } : {}) } };
      }
      result.pull = this.pullCache.overlay;
    }
    return result;
  }
  private explainCache?: { detail: object; overlay: FamilyOverlay };
  private sceneCache?: { scene: ResolvedScene; onMap: boolean; overlay: FamilyOverlay; callouts?: CalloutOverlay[]; edges: EdgeOverlay[] };
  private explainHoverCache?: { link: object; overlay: FamilyOverlay };
  private pullCache?: { data: object; overlay: FamilyOverlay };
  private peopleCache?: { data: object; overlay: FamilyOverlay };
  private measureCache?: { data: object; overlay: LevelOverlay };
  private personCache?: { data: object; overlay: FamilyOverlay };
  private coverageCache?: { data: object; overlay: CoverageOverlay };
  private familyCache?: { data: object; focus?: string; overlay: FamilyOverlay };
  private featureCache?: { data: object; focus: string; overlay: FamilyOverlay };
  /** The flow open in the middle, when this map shows it (the main map, beside the flow's other views or alone). */
  private shownFlow(state: AtlasState): { flow: MapFlow; branch?: number } | undefined {
    const tour = state.tour;
    if (this.role !== 'main' || state.center !== 'flow' || state.flowView?.id !== tour?.id || !mapInMiddle(state)) return undefined;
    return tour?.flow && tour.viewStamp === this.store.viewStamp() ? { flow: tour.flow, ...(tour.branch !== undefined ? { branch: tour.branch } : {}) } : undefined;
  }
  /** The areas the branch shown passes (all of the flow without one): opened whatever the zoom. */
  private areasOf(flow: MapFlow, branch: number | undefined): Set<string> {
    if (this.areasCache?.flow !== flow || this.areasCache.branch !== branch) this.areasCache = { flow, branch, areas: flowAreas(flow, branch === undefined ? undefined : flow.branches[branch]) };
    return this.areasCache.areas;
  }
  private areasCache?: { flow: MapFlow; branch: number | undefined; areas: Set<string> };
  private litCache?: { flow: MapFlow; lit: Set<string>; depths: Map<number, number> };
  /**
   * A flow on the map: everything it touches stays lit and the rest dims. Its
   * links (all of them, or the branch shown) stream from where they start to
   * where they lead; its stops are marked and numbered by how far they are
   * from the start, and the pins of those stops show.
   */
  private mapFlowOverlay(shown: { flow: MapFlow; branch?: number }): Partial<RenderState> {
    const { flow } = shown;
    if (this.litCache?.flow !== flow) this.litCache = { flow, lit: flowLit(flow), depths: flowDepths(flow) };
    const result: Partial<RenderState> = { lit: this.litCache.lit, edges: [], emphasis: undefined, within: undefined };
    const branch = shown.branch === undefined ? undefined : flow.branches[shown.branch];
    const depthOf = new Map<number, number>();
    if (branch) branch.waves.forEach((wave, depth) => { for (const stop of wave) if (!depthOf.has(stop)) depthOf.set(stop, depth); });
    else for (const [stop, depth] of this.litCache.depths) depthOf.set(stop, depth);
    const links = branch ? branch.links.map(link => flow.edges[link.edge]!) : flow.edges;
    const overlay: FlowOverlay = {
      links: links.map(edge => ({ from: edge.from, fromAncestors: edge.fromAncestors, to: edge.to, toAncestors: edge.toAncestors, back: !!edge.back })),
      stops: (branch ? [...depthOf.keys()] : flow.stops.map((_, index) => index)).map(stop => ({ entityId: flow.stops[stop]!.entityId, ancestors: flow.stops[stop]!.ancestors, start: depthOf.get(stop) === 0 })),
      moving: !this.motionReduced,
    };
    const callouts: CalloutOverlay[] = [...depthOf].sort((a, b) => a[1] - b[1] || a[0] - b[0]).slice(0, CALLOUT_MAX)
      .map(([stop, depth]) => ({ entityId: flow.stops[stop]!.entityId, ancestors: flow.stops[stop]!.ancestors, number: depth + 1, label: flow.stops[stop]!.label, tone: flow.stops[stop]!.tone, current: branch ? stop === branch.head : depth === 0 }));
    const shownStops = new Set([...depthOf.keys()].map(stop => flow.stops[stop]!.entityId));
    const pins = flow.pins.filter(pin => !branch || shownStops.has(pin.after) && (!branch.pinKeys || branch.pinKeys.includes(pin.key))).slice(0, PIN_MAX);
    return { ...result, flow: overlay, callouts, pins };
  }
  private impactCache?: { data: object; overlay: NonNullable<RenderState['impact']> };
  /** Lines where the selection calls, renders or references something (from its loaded outgoing relationships). */
  private callMarks(state: AtlasState): Set<number> {
    if (this.marksCache?.relations === state.relations) return this.marksCache.marks;
    const marks = new Set<number>();
    if (state.relations.forId === state.selection?.id) for (const item of state.relations.items) {
      if (item.direction !== 'outgoing' || !['calls', 'renders', 'references'].includes(item.type) || !Array.isArray(item.metadata?.lines)) continue;
      for (const line of item.metadata.lines as number[]) marks.add(line);
    }
    this.marksCache = { relations: state.relations, marks };
    return marks;
  }
  private marksCache?: { relations: object; marks: Set<number> };
  /** Deepest LOD: lazily fetch source for the selected symbol/file once it is very large on screen. */
  private sourceFace(state: AtlasState): RenderState['source'] {
    const selection = state.selection;
    const index = selection ? this.set.index.get(selection.id) : undefined;
    if (!selection || index === undefined) return undefined;
    const item = this.set.items[index]!;
    if (item.size < this.lod.sourcePx || item.open || isContainer(item.node) || !item.node.path) return undefined;
    // Content differs per snapshot: cache per view.
    const key = `${state.meta?.snapshot.id ?? ''}|${state.meta?.comparison?.baseline.id ?? ''}|${selection.id}`;
    const cached = this.faceSource.get(key);
    if (!cached) {
      this.faceSource.set(key, 'loading');
      this.store.api.source({ entity: selection.id }).then(data => { this.faceSource.set(key, data); this.request(); }).catch(() => this.faceSource.set(key, 'error'));
      return undefined;
    }
    if (typeof cached === 'string') return undefined;
    const marks = this.callMarks(state);
    return { nodeId: selection.id, start: cached.start, lines: cached.lines, ...(cached.focus ? { focus: cached.focus } : {}), ...(marks.size ? { marks } : {}) };
  }
  /**
   * Another scene is on screen. Blocks that were not there before (and whose
   * area was fully loaded, so this is not lazy loading) rise into place, the
   * contents of a new area following it; changed blocks flash. While playing,
   * the changes also steer the follow camera.
   */
  private sceneChanged(previous: Scene | undefined, next: Scene, time: number, state: AtlasState): void {
    if (!previous?.rootId || this.motionReduced) return;
    const appearing = new Map<string, number>();
    for (const node of next.nodes.values()) {
      if (previous.nodes.has(node.id) || !node.spatialParentId) continue;
      const parentStart = appearing.get(node.spatialParentId);
      if (parentStart !== undefined) appearing.set(node.id, parentStart + CASCADE_MS);
      else if (previous.nodes.has(node.spatialParentId) && previous.children.get(node.spatialParentId)?.complete) appearing.set(node.id, time);
    }
    for (const [id, start] of appearing) { this.motion.appear.set(id, start); this.motionUntil = Math.max(this.motionUntil, start + RISE_MS); }
    const timeMoved = next.frame !== undefined && next.frame !== previous.frame;
    const changed: Bounds[] = [];
    for (const node of next.nodes.values()) {
      const status = node.change?.status;
      if (!status || status === 'unchanged' || node.type === 'repository') continue;
      if (!timeMoved && previous.nodes.get(node.id)?.change?.status === status) continue;
      this.motion.flash.set(node.id, time);
      if (state.timeline.playing && node.kind === 'entity') { const z = next.zBase(node.id); changed.push(projectedBounds(node.rect, z, z + nodeHeight(node))); }
    }
    if (this.motion.flash.size) this.motionUntil = Math.max(this.motionUntil, time + FLASH_MS);
    if (changed.length) this.recentChanges.push({ bounds: changed.reduce(union), at: time });
  }
  /** Ease the camera toward where recent frames changed something, keeping at least a part of the map around it in view. */
  private follow(time: number, elapsed: number): void {
    this.recentChanges = this.recentChanges.filter(entry => time - entry.at < FOLLOW_WINDOW_MS);
    const root = this.rootBounds();
    if (!this.recentChanges.length || !root) return;
    const bounds = this.recentChanges.map(entry => entry.bounds).reduce(union);
    const grow = (min: number, max: number, span: number) => { const missing = Math.max(0, span - (max - min)) / 2; return [min - missing, max + missing] as const; };
    const [minX, maxX] = grow(bounds.minX, bounds.maxX, (root.maxX - root.minX) * FOLLOW_MIN_SPAN), [minY, maxY] = grow(bounds.minY, bounds.maxY, (root.maxY - root.minY) * FOLLOW_MIN_SPAN);
    const target = fitBounds({ minX, maxX, minY, maxY }, this.viewport, 80, this.limits);
    const k = 1 - Math.exp(-elapsed / FOLLOW_EASE_MS);
    this.animation = undefined; this.autoFit = false;
    this.camera = { x: this.camera.x + (target.x - this.camera.x) * k, y: this.camera.y + (target.y - this.camera.y) * k, scale: Math.exp(Math.log(this.camera.scale) + (Math.log(target.scale) - Math.log(this.camera.scale)) * k) };
  }
  /** The user took the camera: stop following playback, and keep the camera where it is when the map is resized. */
  private takeCamera(): void { this.refit = undefined; if (this.store.getState().timeline.follow && this.store.getState().timeline.playing) this.store.setFollow(false); }
  private report(state: AtlasState): void {
    const focus = this.set.focus;
    const chain: { id: string; name: string; type: string }[] = [];
    for (let node = focus?.node; node; node = node.spatialParentId ? this.scene.nodes.get(node.spatialParentId) : undefined) chain.unshift({ id: node.id, name: node.name, type: node.type });
    const focusIndex = focus ? this.set.index.get(focus.node.id)! : -1;
    const children = this.set.items.filter(item => item.parent === focusIndex && focusIndex >= 0).map(item => ({ type: item.node.type, area: item.node.rect.w * item.node.rect.h }));
    const selectedIndex = state.selection ? this.set.index.get(state.selection.id) : undefined;
    const sourceVisible = selectedIndex !== undefined && this.set.items[selectedIndex]!.size >= this.lod.sourcePx && !isContainer(this.set.items[selectedIndex]!.node);
    const visible = this.set.items.filter(item => item.tier !== 'hidden' && item.alpha > 0.5 && item.node.kind === 'entity' && item.node.type !== 'repository')
      .sort((a, b) => b.size - a.size).slice(0, 40).map(item => ({ id: item.node.id, name: item.node.name, type: item.node.type }));
    const view: ViewState = { level: abstractionLevel(focus ? children : [], sourceVisible), focus: chain, zoom: Math.round(this.camera.scale * 1000) / 1000, visible, truncated: this.set.truncated };
    if (this.options.onReport) this.options.onReport(view);
    else if (this.role === 'main') this.store.setView(view);
  }
  // Input -------------------------------------------------------------------------
  private local(event: { clientX: number; clientY: number }) { const box = this.canvas.getBoundingClientRect(); return { x: event.clientX - box.left, y: event.clientY - box.top }; }
  private onWheel(event: WheelEvent): void {
    event.preventDefault();
    this.autoFit = false;
    this.takeCamera();
    const point = this.local(event);
    const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
    const factor = Math.exp(-delta * (event.ctrlKey ? 0.01 : 0.0018));
    this.animation = undefined;
    this.camera = zoomAround(this.camera, this.viewport, point.x, point.y, factor, this.limits);
    this.request();
  }
  private onPointerDown(event: PointerEvent): void {
    if (event.button !== 0) return;
    this.store.closeMapMenu();
    this.canvas.focus({ preventScroll: true });
    this.options.onActivate?.();
    this.canvas.setPointerCapture(event.pointerId);
    const point = this.local(event);
    this.pointers.set(event.pointerId, point);
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.drag = { x: point.x, y: point.y, moved: true, pinch: Math.hypot(a!.x - b!.x, a!.y - b!.y) };
    } else this.drag = { x: point.x, y: point.y, moved: false };
    this.animation = undefined;
    this.autoFit = false;
  }
  private onPointerMove(event: PointerEvent): void {
    const point = this.local(event);
    if (this.pointers.has(event.pointerId)) {
      const previous = this.pointers.get(event.pointerId)!;
      this.pointers.set(event.pointerId, point);
      if (this.pointers.size === 2 && this.drag?.pinch) {
        const [a, b] = [...this.pointers.values()];
        const distance = Math.hypot(a!.x - b!.x, a!.y - b!.y);
        this.camera = zoomAround(this.camera, this.viewport, (a!.x + b!.x) / 2, (a!.y + b!.y) / 2, distance / this.drag.pinch, this.limits);
        this.drag.pinch = distance;
        this.takeCamera();
      } else if (this.drag) {
        if (Math.hypot(point.x - this.drag.x, point.y - this.drag.y) > 4) this.drag.moved = true;
        if (this.drag.moved) { this.camera = panBy(this.camera, point.x - previous.x, point.y - previous.y); this.canvas.style.cursor = 'grabbing'; this.takeCamera(); }
      }
      this.request();
      return;
    }
    this.hoverPoint = point;
    const hit = this.scene.hitTest(this.set, this.camera, this.viewport, point.x, point.y);
    const node = hit && hit.node.type !== 'repository' ? hit.node : undefined;
    this.canvas.style.cursor = node ? 'pointer' : 'grab';
    this.store.hover(node);
  }
  private onPointerUp(event: PointerEvent): void {
    const point = this.local(event);
    const drag = this.drag;
    this.pointers.delete(event.pointerId);
    if (this.pointers.size === 0) this.drag = undefined;
    this.canvas.style.cursor = 'grab';
    if (!drag || drag.moved || event.button !== 0) return;
    if (this.options.onClick?.(fromScreen(this.camera, this.viewport, point))) return;
    const hit = this.scene.hitTest(this.set, this.camera, this.viewport, point.x, point.y);
    if (!hit || hit.node.type === 'repository') { this.store.clearSelection(); return; }
    void this.store.select(hit.node.id, { fly: false });
  }
  private onDoubleClick(event: MouseEvent): void {
    const point = this.local(event);
    const hit = this.scene.hitTest(this.set, this.camera, this.viewport, point.x, point.y);
    if (!hit) return;
    const enter = hit.node.childCount > 0;
    this.flyTo(hit.node, { mode: enter ? 'enter' : 'focus' });
    if (enter) {
      // Zoom just past the open threshold so the container's children appear.
      const target = fitBounds(projectedBounds(hit.node.rect, hit.zBase, hit.zTop), this.viewport, 40, this.limits);
      if (screenSize(hit.node.rect, target.scale) < this.lod.openPx * 1.6) this.animateTo({ ...target, scale: Math.min(this.limits.max, (this.lod.openPx * 1.6) / Math.sqrt(hit.node.rect.w * hit.node.rect.h)) });
    }
  }
  private onKey(event: KeyboardEvent): void {
    const step = 80;
    const actions: Record<string, () => void> = {
      ArrowLeft: () => { this.camera = panBy(this.camera, step, 0); }, ArrowRight: () => { this.camera = panBy(this.camera, -step, 0); },
      ArrowUp: () => { this.camera = panBy(this.camera, 0, step); }, ArrowDown: () => { this.camera = panBy(this.camera, 0, -step); },
      '+': () => this.zoomBy(1.5), '=': () => this.zoomBy(1.5), '-': () => this.zoomBy(1 / 1.5), _: () => this.zoomBy(1 / 1.5),
      f: () => this.fitAll(), F: () => this.fitAll(),
      Enter: () => { const node = this.store.getState().selection?.node; if (node) this.flyTo(node, { mode: node.childCount > 0 ? 'enter' : 'focus' }); },
      Escape: () => this.store.clearSelection(),
      Backspace: () => { void this.store.back(); },
    };
    const action = actions[event.key];
    if (!action || event.metaKey || event.ctrlKey || event.altKey) return;
    // During a tour, ← and → step through its scenes (the stage listens), not the camera.
    if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && this.store.getState().center === 'tour') return;
    event.preventDefault();
    this.animation = undefined;
    this.autoFit = false;
    this.takeCamera();
    action();
    this.request();
  }
}
/** Whether the map is in the middle: the Map tab, or a flow with its map beside its other views (or alone). */
/** The scene of the open explanation's tour on stage, if one is. */
export function sceneOnStage(state: Pick<AtlasState, 'center' | 'explain'>): ResolvedScene | undefined {
  const tour = state.explain.tour, data = state.explain.detail?.data;
  return state.center === 'tour' && tour && data?.id === tour.id ? data.tour?.scenes[tour.scene] : undefined;
}
export function mapInMiddle(state: Pick<AtlasState, 'center' | 'flowView'>): boolean {
  return state.center === 'map' || state.center === 'tour' || (state.center === 'flow' && !!state.flowView && (!state.flowView.pane || state.flowView.pane === 'map'));
}
function union(a: Bounds, b: Bounds): Bounds { return { minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY), maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY) }; }
/** The key explanation overlays light under, and the hue of their badges. */
const EXPLAINED = 'explained';
const EXPLAINED_HUE = 196;
/** What explanation links light: their entities (a folder's files, a flow's stops) and the areas holding them. */
function linkOverlay(links: { id?: string; members?: string[]; ancestors?: string[] }[], name: string): FamilyOverlay {
  const of = new Map<string, string>(), areas = new Map<string, Record<string, number>>();
  for (const link of links) {
    for (const id of [...(link.id ? [link.id] : []), ...link.members ?? []]) of.set(id, EXPLAINED);
    for (const id of link.ancestors ?? []) areas.set(id, { [EXPLAINED]: (areas.get(id)?.[EXPLAINED] ?? 0) + 1 });
    if (link.id && link.members?.length) areas.set(link.id, { [EXPLAINED]: link.members.length });
  }
  return { of, areas, names: new Map([[EXPLAINED, name]]), hues: new Map([[EXPLAINED, EXPLAINED_HUE]]), focus: EXPLAINED };
}
