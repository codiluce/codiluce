// Owns the canvas: input, camera animation, render scheduling and lazy child
// loading. React never renders map primitives; it only mounts this controller.
import type { NodeSummary, SourceResponse } from '@engine/projection/dto';
import { easeInOut, fitBounds, panBy, projectedBounds, worldToScreen, zoomAround, zoomPath, type Camera, type Viewport, type ZoomLimits } from './camera';
import { DEFAULT_LOD, abstractionLevel, screenSize, type LodConfig } from './lod';
import { MapRenderer, type EdgeOverlay, type RenderState } from './renderer';
import { nodeHeight, type VisibleSet } from './scene';
import { isContainer, type AtlasState, type AtlasStore, type MapNavigator } from './store';
import { themeById } from './themes';

const STEP_MS = 1800;
interface Animation { at(t: number): Camera; start: number; duration: number }
export interface DebugHandle { screenPositionOf(id: string): { x: number; y: number } | undefined; camera(): Camera; visibleIds(): string[]; rectOf(id: string): { x: number; y: number; w: number; h: number } | undefined }

export class MapController implements MapNavigator {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly renderer: MapRenderer;
  private readonly lod: LodConfig = DEFAULT_LOD;
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

  constructor(private readonly canvas: HTMLCanvasElement, private readonly store: AtlasStore) {
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas 2D is unavailable in this browser');
    this.ctx = ctx;
    this.renderer = new MapRenderer(themeById(store.getState().themeId));
    this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    store.navigator = this;
    store.visibility = id => this.set.index.has(id);
    store.openContainers = () => this.set.items.filter(item => item.open).map(item => item.node.id);
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
    listen('keydown', event => this.onKey(event));
    (window as unknown as { __ARCHIPELAGO__?: DebugHandle }).__ARCHIPELAGO__ = {
      screenPositionOf: id => { const index = this.set.index.get(id); if (index === undefined) return undefined; const item = this.set.items[index]!; const r = item.node.rect; const p = worldToScreen(this.camera, this.viewport, r.x + r.w / 2, r.y + r.h / 2, item.zTop); const box = canvas.getBoundingClientRect(); return { x: box.left + p.x, y: box.top + p.y }; },
      camera: () => ({ ...this.camera }),
      visibleIds: () => this.set.items.map(item => item.node.id),
      rectOf: id => this.store.scene.nodes.get(id)?.rect,
    };
    this.resize();
  }
  destroy(): void {
    cancelAnimationFrame(this.frame);
    if (this.reportTimer) clearTimeout(this.reportTimer);
    for (const dispose of this.cleanup) dispose();
    if (this.store.navigator === this) { this.store.navigator = undefined; this.store.visibility = undefined; this.store.openContainers = undefined; }
  }
  private get motionReduced(): boolean { return this.reducedMotion.matches; }
  private resize(): void {
    const box = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(3, window.devicePixelRatio || 1);
    const width = Math.max(1, Math.round(box.width)), height = Math.max(1, Math.round(box.height));
    // Keep the camera center fixed so panel resizing never moves the map.
    this.viewport = { width, height };
    this.canvas.width = Math.round(width * this.dpr); this.canvas.height = Math.round(height * this.dpr);
    this.setKey = '';
    if (this.autoFit && this.fitted) { const bounds = this.rootBounds(); if (bounds) { this.updateLimits(); this.camera = fitBounds(bounds, this.viewport, 32, this.limits); } }
    this.request();
  }
  private rootBounds() {
    const root = this.store.scene.rootId ? this.store.scene.nodes.get(this.store.scene.rootId) : undefined;
    return root ? projectedBounds(root.rect, 0, 40) : undefined;
  }
  private updateLimits(): void {
    const bounds = this.rootBounds();
    if (!bounds) return;
    const fit = fitBounds(bounds, this.viewport, 24, { min: 1e-6, max: 1e6 });
    this.limits = { min: fit.scale * 0.4, max: 120 };
  }
  request(): void {
    if (!this.frame) this.frame = requestAnimationFrame(time => this.tick(time));
  }
  // MapNavigator --------------------------------------------------------------
  fitAll(): void {
    const bounds = this.rootBounds();
    if (bounds) this.animateTo(fitBounds(bounds, this.viewport, 32, this.limits));
  }
  fitNodes(nodes: NodeSummary[]): void {
    if (!nodes.length) return;
    const bounds = nodes.map(node => { const z = this.store.scene.nodes.has(node.id) ? this.store.scene.zBase(node.id) : 0; return projectedBounds(node.rect, z, z + nodeHeight(node)); })
      .reduce((a, b) => ({ minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY), maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY) }));
    this.animateTo(fitBounds(bounds, this.viewport, 72, this.limits));
  }
  zoomBy(factor: number): void { this.animateTo(zoomAround(this.camera, this.viewport, this.viewport.width / 2, this.viewport.height / 2, factor, this.limits), 260); }
  flyTo(node: NodeSummary, options: { mode?: 'focus' | 'enter' } = {}): void {
    const zBase = this.store.scene.nodes.has(node.id) ? this.store.scene.zBase(node.id) : 0;
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
    if (this.motionReduced || !this.fitted) { this.camera = target; this.animation = undefined; this.fitted = true; this.request(); return; }
    const path = zoomPath(this.camera, target, this.viewport);
    const duration = fixedDuration ?? Math.min(1700, 450 + path.length * 260);
    this.animation = { at: path.at, start: performance.now(), duration };
    this.request();
  }
  // Frame -----------------------------------------------------------------------
  private tick(time: number): void {
    this.frame = 0;
    const state = this.store.getState();
    const elapsed = this.lastFrame ? Math.min(100, time - this.lastFrame) : 16;
    this.lastFrame = time;
    if (!this.fitted && this.store.scene.rootId) { const bounds = this.rootBounds()!; this.updateLimits(); this.camera = fitBounds(bounds, this.viewport, 32, this.limits); this.fitted = true; }
    else this.updateLimits();
    if (this.animation) {
      const t = Math.min(1, (time - this.animation.start) / this.animation.duration);
      this.camera = this.animation.at(easeInOut(t));
      if (t >= 1) this.animation = undefined;
    }
    if (state.themeId !== this.themeId) { this.themeId = state.themeId; this.renderer.setTheme(themeById(state.themeId)); }
    if (state.flows.playback.status === 'playing') this.store.playbackAction({ type: 'tick', elapsedMs: elapsed, stepMs: STEP_MS });
    const key = `${this.camera.x}|${this.camera.y}|${this.camera.scale}|${this.viewport.width}|${this.viewport.height}|${this.store.scene.revision}`;
    if (key !== this.setKey) {
      this.set = this.store.scene.visible(this.camera, this.viewport, this.lod);
      this.setKey = key;
      if (this.set.pending.length) void this.store.loadChildren(this.set.pending);
    }
    const render = this.renderState(state, time);
    this.renderer.render(this.ctx, this.dpr, this.viewport, this.camera, this.store.scene, this.set, render, this.lod);
    this.scheduleReport(time);
    const flowActive = !!state.flows.resolved && state.flows.playback.status === 'playing';
    if (this.animation || flowActive) this.request();
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
    const selectedAncestors = selection?.locate?.spatialAncestors.map(node => node.id) ?? [];
    const edges: EdgeOverlay[] = [];
    let emphasis: Set<string> | undefined;
    if (selection?.node && !isContainer(selection.node) && state.relations.forId === selection.id && state.relations.items.length) {
      emphasis = new Set([selection.id]);
      for (const item of state.relations.items) {
        if (state.relations.type && item.type !== state.relations.type) continue;
        emphasis.add(item.other.id);
        const incoming = item.direction === 'incoming';
        edges.push({ key: item.id, type: item.type, count: 1, from: incoming ? item.other.id : selection.id, fromAncestors: incoming ? item.otherAncestors : selectedAncestors, to: incoming ? selection.id : item.other.id, toAncestors: incoming ? selectedAncestors : item.otherAncestors, emphasized: state.evidence?.relationId === item.id, ...(item.change ? { change: item.change } : {}) });
      }
    } else if (selection?.node && isContainer(selection.node) && state.aggregate.forId === selection.id && state.aggregate.data?.groups.length) {
      emphasis = new Set([selection.id]);
      const drill = state.aggregate.drill;
      for (const group of state.aggregate.data.groups) {
        if (state.relations.type && group.type !== state.relations.type) continue;
        emphasis.add(group.anchor.id);
        const outgoing = group.direction === 'outgoing';
        edges.push({ key: `${group.direction}:${group.type}:${group.anchor.id}`, type: group.type, count: group.count, from: outgoing ? selection.id : group.anchor.id, fromAncestors: outgoing ? selectedAncestors : group.anchorAncestors, to: outgoing ? group.anchor.id : selection.id, toAncestors: outgoing ? group.anchorAncestors : selectedAncestors, emphasized: drill?.group === group });
      }
    }
    const resolved = state.flows.resolved;
    const flow = resolved && resolved.status === 'ready' ? {
      steps: resolved.steps.map(step => ({ entityId: step.entityId, ancestors: step.ancestors, missing: step.missing })),
      links: resolved.links.map(items => ({ relationType: items[0]?.type })),
      current: state.flows.playback.index, progress: state.flows.playback.progress, active: true,
    } : undefined;
    const unresolvedCount = selection && !isContainer(selection.node ?? { type: 'file', kind: 'entity' }) && selection.node?.type !== 'file' ? state.diagnostics.data?.codes.find(code => code.code === 'unresolved-http-call')?.count ?? 0 : 0;
    return {
      selectedId: selection?.id, hoveredId: state.hover?.id, emphasis, edges, flow,
      showDiagnostics: state.showDiagnostics, source: this.sourceFace(state), time, reducedMotion: this.motionReduced,
      ...(state.meta?.comparison ? { comparison: { dimUnchanged: state.timeline.dimUnchanged } } : {}),
      ...(unresolvedCount && selection ? { unresolved: { nodeId: selection.id, count: unresolvedCount } } : {}),
    };
  }
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
    return { nodeId: selection.id, start: cached.start, lines: cached.lines, ...(cached.focus ? { focus: cached.focus } : {}) };
  }
  private report(state: AtlasState): void {
    const focus = this.set.focus;
    const chain: { id: string; name: string; type: string }[] = [];
    for (let node = focus?.node; node; node = node.spatialParentId ? this.store.scene.nodes.get(node.spatialParentId) : undefined) chain.unshift({ id: node.id, name: node.name, type: node.type });
    const focusIndex = focus ? this.set.index.get(focus.node.id)! : -1;
    const children = this.set.items.filter(item => item.parent === focusIndex && focusIndex >= 0).map(item => ({ type: item.node.type, area: item.node.rect.w * item.node.rect.h }));
    const selectedIndex = state.selection ? this.set.index.get(state.selection.id) : undefined;
    const sourceVisible = selectedIndex !== undefined && this.set.items[selectedIndex]!.size >= this.lod.sourcePx && !isContainer(this.set.items[selectedIndex]!.node);
    const visible = this.set.items.filter(item => item.tier !== 'hidden' && item.alpha > 0.5 && item.node.kind === 'entity' && item.node.type !== 'repository')
      .sort((a, b) => b.size - a.size).slice(0, 40).map(item => ({ id: item.node.id, name: item.node.name, type: item.node.type }));
    this.store.setView({ level: abstractionLevel(focus ? children : [], sourceVisible), focus: chain, zoom: Math.round(this.camera.scale * 1000) / 1000, visible, truncated: this.set.truncated });
  }
  // Input -------------------------------------------------------------------------
  private local(event: { clientX: number; clientY: number }) { const box = this.canvas.getBoundingClientRect(); return { x: event.clientX - box.left, y: event.clientY - box.top }; }
  private onWheel(event: WheelEvent): void {
    event.preventDefault();
    this.autoFit = false;
    const point = this.local(event);
    const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
    const factor = Math.exp(-delta * (event.ctrlKey ? 0.01 : 0.0018));
    this.animation = undefined;
    this.camera = zoomAround(this.camera, this.viewport, point.x, point.y, factor, this.limits);
    this.request();
  }
  private onPointerDown(event: PointerEvent): void {
    this.canvas.focus({ preventScroll: true });
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
      } else if (this.drag) {
        if (Math.hypot(point.x - this.drag.x, point.y - this.drag.y) > 4) this.drag.moved = true;
        if (this.drag.moved) { this.camera = panBy(this.camera, point.x - previous.x, point.y - previous.y); this.canvas.style.cursor = 'grabbing'; }
      }
      this.request();
      return;
    }
    this.hoverPoint = point;
    const hit = this.store.scene.hitTest(this.set, this.camera, this.viewport, point.x, point.y);
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
    const hit = this.store.scene.hitTest(this.set, this.camera, this.viewport, point.x, point.y);
    if (!hit || hit.node.type === 'repository') { if (!this.store.getState().flows.draft) this.store.clearSelection(); return; }
    if (this.store.getState().flows.draft && hit.node.kind === 'entity') this.store.addDraftStep(hit.node.id);
    void this.store.select(hit.node.id, { fly: false });
  }
  private onDoubleClick(event: MouseEvent): void {
    const point = this.local(event);
    const hit = this.store.scene.hitTest(this.set, this.camera, this.viewport, point.x, point.y);
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
    event.preventDefault();
    this.animation = undefined;
    this.autoFit = false;
    action();
    this.request();
  }
}
