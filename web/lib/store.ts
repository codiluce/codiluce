// Framework-agnostic application state. React panels subscribe through
// useSyncExternalStore; the canvas controller subscribes directly. Each
// concern owns an AbortController so rapid navigation cancels stale requests.
//
// History: the store owns which snapshot is viewed (and which baseline it is
// compared with). Changing the view swaps in a new scene that is prefetched
// for the containers currently open, so the camera and the user's place on
// the map are kept; a view epoch drops responses that belong to an old view.
import type { Entity, Relation } from '@engine/core/graph';
import type { AggregateEdgesPage, AggregateGroup, AggregateResult, CatalogKind, ChangeRegionsResult, ChangesPage, RegionLevel, CoverageDetail, CoverageResult, DiagnosticsPage, EntityChangeDetail, EntityHistoryResponse, FlowList, FlowSummary, ImpactItem, ImpactResult, LocateResult, NodeSummary, ProjectionMeta, Rect, RelationItem, RequestFlow, SourceDiffResponse, SourceRequest, SourceResponse, StepsResult, TimelineEntry, TimelineResponse, ViewKey } from '@engine/projection/dto';
import type { AnnotationsOverview, EntityAnnotation, FamiliesResult, FlowStatus } from '@engine/projection/dto';
import type { CatalogTab } from './catalog';
import { fromRequestFlow, fromSteps, type MapFlow } from './map-flow';
import { isAbort, type AtlasApi } from './api';
import type { Level } from './lod';
import { initialPlayback, playback, type PlaybackAction, type PlaybackState } from './playback';
import { Scene } from './scene';
import { Evolution } from './evolution';

export const CHILD_PAGE = 500;
/** Children beyond this many per container are not fetched; the inspector says so. */
export const CHILD_CAP = 3000;
type Status = 'idle' | 'loading' | 'ready' | 'error';
export interface SelectionState {
  id: string; node?: NodeSummary; locate?: LocateResult;
  entity?: Entity; entityStatus: Status; error?: string;
  /** Containing file details, used for file-level metadata about this symbol (e.g. HTTP calls). */
  file?: Entity;
  /** Comparison views: the entity's architectural diff. */
  change?: { status: Status; data?: EntityChangeDetail; error?: string };
  /** History available: when the entity appeared and changed on the timeline. */
  timeline?: { status: Status; data?: EntityHistoryResponse; error?: string };
  /** The flows touching it, and (files) why it is or is not part of a flow. */
  coverage?: { status: Status; data?: CoverageDetail; error?: string };
  /** What the language models said about it (`annotate`). */
  annotation?: { status: Status; data?: EntityAnnotation; error?: string };
}
export interface RelationsState { status: Status; forId?: string; items: RelationItem[]; typeCounts: { type: string; direction: string; count: number }[]; total: number; hasMore: boolean; type?: string; direction: 'both' | 'outgoing' | 'incoming'; error?: string }
export interface AggregateState { status: Status; forId?: string; data?: AggregateResult; error?: string; drill?: { group: AggregateGroup; status: Status; page?: AggregateEdgesPage; items: AggregateEdgesPage['items']; error?: string } }
export interface DiagnosticsState { status: Status; forId?: string; data?: DiagnosticsPage; error?: string }
export interface EvidenceState { relationId: string; context?: { from: string; to: string; type: string }; status: Status; relation?: Relation; error?: string }
export interface SourceState { request: SourceRequest; title: string; status: Status; data?: SourceResponse; error?: string }
export interface DiffState { entity: string; title: string; status: Status; data?: SourceDiffResponse; error?: string; ignoreWhitespace: boolean; layout: 'unified' | 'split' }
export interface TimelineState {
  open: boolean;
  status: Status; data?: TimelineResponse; error?: string;
  /** Viewed snapshot; undefined is the live working-tree index. */
  target?: string;
  /** Baseline snapshot when comparing. */
  baseline?: string;
  compare: boolean;
  /** Keep the baseline while the target moves, for non-adjacent comparisons. */
  pinned: boolean;
  dimUnchanged: boolean;
  /** A view change is loading; the previous map stays on screen meanwhile. */
  switching: boolean;
  /** Overview list of changed entities in the comparison. */
  changes: { status: Status; filter?: string; page?: ChangesPage; items: ChangesPage['items']; error?: string };
  notice?: string;
  /** Time-lapse frames for continuous scrubbing and playback (the server builds them in the background). */
  evolution: { status: Status; progress?: number; error?: string };
  /** Time-lapse frame on screen while scrubbing or playing, before the view settles on its commit. */
  preview?: number;
  playing: boolean;
  /** Playback speed multiplier. */
  speed: number;
  /** While playing, the camera drifts toward where the changes happen. */
  follow: boolean;
  /** Comparing: one view on each place where the code changed, around an overview of the whole map (otherwise one map). */
  split: boolean;
  /** How finely the split map groups the changes into places. */
  regionLevel: RegionLevel;
  /** The places of the settled comparison (time-lapse frames are grouped in the browser). */
  regions: { status: Status; viewStamp?: string; data?: ChangeRegionsResult; error?: string };
}
/** Blast radius of the selection. While `open`, it follows the selection. */
export interface ImpactState {
  open: boolean; status: Status; forId?: string;
  /** The view (snapshot|baseline) the data was computed for. */
  viewStamp?: string;
  depth: number; filter: { type?: string; distance?: number };
  data?: ImpactResult; items: ImpactItem[]; error?: string;
}
/** What the viewed comparison's changes reach (history). */
export interface CommitImpactState { status: Status; viewStamp?: string; data?: ImpactResult; error?: string; show: boolean }
/** "What happens from here": typed steps from an anchor entity. */
export interface StepsState { anchor: string; status: Status; viewStamp: string; data?: StepsResult; error?: string; focus?: string }
/** A request flow open in lanes (the theater over the map): the schematic of a flow shown on the map. */
export interface RequestFlowsState { open?: OpenRequestFlow }
export interface OpenRequestFlow {
  id: string; status: Status; viewStamp: string; data?: RequestFlow; error?: string;
  /** Focused node of the flow (its details are shown). */
  focus?: string;
  /** The request is animated along the lanes. */
  playing: boolean;
}
/** Every flow of the view by entry point (pages, requests, console, unmatched), as the Flows panel lists them. */
export interface CatalogState {
  status: Status; viewStamp?: string; data?: FlowList; error?: string;
  /** Which kind of flows the panel lists (`all` by default). */
  kind: CatalogTab;
  query: string;
  /** Only the HTTP flows with this completeness. */
  filter?: FlowStatus;
  /** Only the flows touching this entity (or anything inside it). */
  entity?: { id: string; name: string };
  /** Incremented to ask the shell to show the Flows panel. */
  reveal?: number;
}
/** Which files the flows touch, drawn as a lens over the map. */
export interface CoverageState { show: boolean; status: Status; viewStamp?: string; data?: CoverageResult; error?: string }
/** Data families drawn over the map: files colored by the tables they use; `focus` lights one family and dims the rest. */
export interface FamiliesState { show: boolean; status: Status; viewStamp?: string; data?: FamiliesResult; error?: string; focus?: string }
/** How a folder's files are grouped: as fits best, by name, by data family, or not. */
export type FolderChoice = 'auto' | 'name' | 'data' | 'none';
/** How the live folder map groups the files of large folders: `auto` groups each as fits it best; a folder's own choice overrides. */
export interface ArrangeState { mode: 'auto' | 'off'; folders: Record<string, FolderChoice> }
/** How the live map is arranged: by folder (the canonical tree), by data family, or by domain (the Features view). */
export type Lens = 'folders' | 'data' | 'domains';
/** The `arrange` view parameter: the mode, then each folder whose choice differs from it (sorted); undefined when nothing is grouped. */
export function arrangeParam(arrange: ArrangeState): string | undefined {
  const items = Object.entries(arrange.folders).filter(([, choice]) => choice !== (arrange.mode === 'auto' ? 'auto' : 'none')).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  if (arrange.mode === 'off' && !items.length) return undefined;
  return [arrange.mode, ...items.map(([id, choice]) => `${id}=${choice}`)].join(';');
}
/**
 * A flow shown on the map: everything it touches stays lit, the rest dims;
 * it plays branch by branch (`playback.index` is the branch), the pulse
 * flowing along the branch's edges wave by wave.
 */
export interface TourState {
  key: string; id: string; detail: 'lanes' | 'steps';
  title: string; subtitle?: string; kind?: CatalogKind;
  status: Status; error?: string; viewStamp: string;
  flow?: MapFlow; playback: PlaybackState;
  /** While playing, the camera frames each branch as it starts. */
  follow: boolean;
}
export interface ViewState { level: Level; focus: { id: string; name: string; type: string }[]; zoom: number; visible: { id: string; name: string; type: string }[]; truncated: boolean }
export interface AtlasState {
  status: 'loading' | 'ready' | 'error'; error?: string;
  meta?: ProjectionMeta;
  selection?: SelectionState;
  hover?: NodeSummary;
  view: ViewState;
  relations: RelationsState;
  aggregate: AggregateState;
  diagnostics: DiagnosticsState;
  evidence?: EvidenceState;
  source?: SourceState;
  diff?: DiffState;
  history: { entries: string[]; index: number };
  timeline: TimelineState;
  showDiagnostics: boolean;
  themeId: string;
  staleIndex: boolean;
  sceneRevision: number;
  impact: ImpactState;
  commitImpact: CommitImpactState;
  steps?: StepsState;
  requests: RequestFlowsState;
  catalog: CatalogState;
  coverage: CoverageState;
  tour?: TourState;
  /** The repository's overview, domains and model notes, when `annotate` has run. */
  annotations: { status: Status; data?: AnnotationsOverview; error?: string };
  lens: Lens;
  arrange: ArrangeState;
  families: FamiliesState;
}
export interface MapNavigator {
  flyTo(node: NodeSummary, options?: { mode?: 'focus' | 'enter' }): void;
  /** Fit several nodes (e.g. a selection and its related endpoints) into view. */
  fitNodes(nodes: NodeSummary[]): void;
  fitAll(): void;
  zoomBy(factor: number): void;
}
export interface StoreOptions {
  storage?: Pick<Storage, 'getItem' | 'setItem'> & Partial<Pick<Storage, 'removeItem'>>;
  location?: { hash: string; replace(hash: string): void };
}
const EMPTY_RELATIONS: RelationsState = { status: 'idle', items: [], typeCounts: [], total: 0, hasMore: false, direction: 'both' };
const EMPTY_CHANGES: TimelineState['changes'] = { status: 'idle', items: [] };
/** Short form used in URLs: a commit SHA prefix, or `live` for the working-tree index. */
export function snapshotToken(timeline: TimelineResponse | undefined, id: string | undefined): string | undefined {
  if (!id) return undefined;
  if (id === timeline?.workingTree?.id) return 'live';
  const entry = timeline?.entries.find(item => item.snapshot?.id === id);
  return entry ? entry.sha.slice(0, 12) : undefined;
}
export function snapshotFromToken(timeline: TimelineResponse | undefined, token: string | undefined): string | undefined {
  if (!token || !timeline || token === 'live') return undefined;
  return timeline.entries.find(item => item.sha.startsWith(token))?.snapshot?.id;
}
/** Position of a snapshot on the timeline (working tree after every commit). */
export function timelineIndex(timeline: TimelineResponse | undefined, id: string | undefined): number {
  if (!timeline) return -1;
  if (!id || id === timeline.workingTree?.id) return timeline.entries.length;
  return timeline.entries.findIndex(item => item.snapshot?.id === id);
}
/** The indexed snapshot before `id` on the timeline: the default comparison baseline. */
export function predecessor(timeline: TimelineResponse | undefined, id: string | undefined): string | undefined {
  if (!timeline) return undefined;
  if (!id || id === timeline.workingTree?.id) {
    // The working tree compares with its own HEAD commit when that is indexed.
    const head = timeline.entries.find(item => item.sha === timeline.workingTree?.commitSha)?.snapshot?.id;
    if (head) return head;
  }
  for (let index = timelineIndex(timeline, id) - 1; index >= 0; index--) { const snapshot = timeline.entries[index]?.snapshot; if (snapshot) return snapshot.id; }
  return undefined;
}
export function entryOf(timeline: TimelineResponse | undefined, id: string | undefined): TimelineEntry | undefined {
  return id ? timeline?.entries.find(item => item.snapshot?.id === id) : undefined;
}
/** Which snapshots a time-lapse covers: the indexed commits of the timeline, in order. */
function evolutionKey(timeline: TimelineResponse | undefined): string { return (timeline?.entries ?? []).flatMap(entry => entry.snapshot ? [entry.snapshot.id] : []).join(','); }
export function isContainer(node: Pick<NodeSummary, 'type' | 'kind'>): boolean {
  return node.kind === 'group' || ['repository', 'application', 'directory'].includes(node.type);
}

export class AtlasStore {
  private state: AtlasState;
  private readonly listeners = new Set<() => void>();
  private readonly aborts = new Map<string, AbortController>();
  private readonly childLoads = new Set<string>();
  private pollTimer?: ReturnType<typeof setInterval>;
  private timelineTimer?: ReturnType<typeof setTimeout>;
  /** Incremented on every view change; async work started under an older epoch is discarded. */
  private epoch = 0;
  scene = new Scene();
  /** Time-lapse of the indexed history, once loaded. */
  evolution?: Evolution;
  /** Drawn instead of `scene` while a time-lapse frame is on screen. */
  previewScene?: Scene;
  private evolutionLoad?: Promise<boolean>;
  /** Indexed snapshots the loaded time-lapse covers; a different list means it is outdated. */
  private evolutionKey = '';
  /** Fractional frame position while playing. */
  private playhead = 0;
  private disposed = false;
  navigator?: MapNavigator;
  /** Set by the map: whether a node is drawn at the current level of detail. */
  visibility?: (id: string) => boolean;
  /** Set by the map: containers currently open (top-down), to prefetch when the view changes. */
  openContainers?: () => string[];
  /** Where the single map starts when it next appears (a place of the split map opened on its own). */
  private pendingFocus?: { node: NodeSummary; frame?: Rect };

  constructor(readonly api: AtlasApi, private readonly options: StoreOptions = {}) {
    let prefs: { themeId?: string; showDiagnostics?: boolean; dimUnchanged?: boolean; split?: boolean; regionLevel?: RegionLevel; arrange?: ArrangeState } = {};
    try { prefs = JSON.parse(options.storage?.getItem('codiluce:prefs') ?? '{}'); } catch { /* defaults */ }
    this.state = {
      status: 'loading', view: { level: 'Applications', focus: [], zoom: 1, visible: [], truncated: false },
      relations: EMPTY_RELATIONS, aggregate: { status: 'idle' }, diagnostics: { status: 'idle' },
      history: { entries: [], index: -1 }, showDiagnostics: prefs.showDiagnostics ?? true, themeId: prefs.themeId ?? 'midnight',
      staleIndex: false, sceneRevision: 0,
      impact: { open: false, status: 'idle', depth: 4, filter: {}, items: [] }, commitImpact: { status: 'idle', show: false }, requests: {}, catalog: { status: 'idle', kind: 'all', query: '' }, coverage: { show: false, status: 'idle' }, annotations: { status: 'idle' }, lens: 'folders', families: { show: false, status: 'idle' },
      arrange: prefs.arrange?.mode === 'auto' || prefs.arrange?.mode === 'off' ? { mode: prefs.arrange.mode, folders: { ...prefs.arrange.folders } } : { mode: 'off', folders: {} },
      timeline: { open: false, status: 'idle', compare: true, pinned: false, dimUnchanged: prefs.dimUnchanged ?? true, switching: false, changes: EMPTY_CHANGES, evolution: { status: 'idle' }, playing: false, speed: 1, follow: true, split: prefs.split ?? true, regionLevel: prefs.regionLevel ?? 'auto', regions: { status: 'idle' } },
    };
  }
  getState = (): AtlasState => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  private set(patch: Partial<AtlasState> | ((state: AtlasState) => Partial<AtlasState>)): void {
    const next = typeof patch === 'function' ? patch(this.state) : patch;
    this.state = { ...this.state, ...next };
    for (const listener of this.listeners) listener();
  }
  private abortable(key: string): AbortSignal {
    this.aborts.get(key)?.abort();
    const controller = new AbortController();
    this.aborts.set(key, controller);
    return controller.signal;
  }
  private bumpScene(): void { this.set(state => ({ sceneRevision: state.sceneRevision + 1 })); }
  private savePrefs(): void {
    try { this.options.storage?.setItem('codiluce:prefs', JSON.stringify({ themeId: this.state.themeId, showDiagnostics: this.state.showDiagnostics, dimUnchanged: this.state.timeline.dimUnchanged, split: this.state.timeline.split, regionLevel: this.state.timeline.regionLevel, arrange: this.state.arrange })); } catch { /* preferences are optional */ }
  }
  dispose(): void { this.disposed = true; for (const controller of this.aborts.values()) controller.abort(); if (this.pollTimer) clearInterval(this.pollTimer); if (this.timelineTimer) clearTimeout(this.timelineTimer); }

  async init(): Promise<void> {
    this.set({ status: 'loading', error: undefined });
    const epoch = this.epoch;
    try {
      const lens = (/(?:^#|&)lens=(domains|data)(?:&|$)/.exec(this.options.location?.hash ?? '')?.[1] as Lens | undefined) ?? this.state.lens;
      if (lens !== this.state.lens) this.set({ lens });
      this.api.setView(this.viewKey());
      const meta = await this.api.meta();
      void this.loadAnnotations();
      // History was opened while the live map loaded: that view transition owns the scene and meta now.
      if (epoch !== this.epoch) { this.set({ status: 'ready' }); return; }
      this.scene.reset(meta.root);
      this.set({ meta, status: 'ready', staleIndex: false });
      await this.loadChildren([meta.root.id]);
      const hash = this.options.location?.hash ?? '';
      const param = (name: string) => { const value = new RegExp(`(?:^#|&)${name}=([^&]+)`).exec(hash)?.[1]; return value ? decodeURIComponent(value) : undefined; };
      const deepLink = param('id'), at = param('at'), vs = param('vs');
      if ((at || vs) && meta.history.available) await this.openTimeline({ at, vs, select: deepLink });
      else if (deepLink) await this.select(deepLink, { fly: true });
      const impactDepth = Number(param('impact'));
      if (deepLink && this.state.selection && Number.isInteger(impactDepth) && impactDepth >= 1 && impactDepth <= 10) void this.showImpact(this.state.selection.id, impactDepth);
    } catch (error) {
      this.set({ status: 'error', error: error instanceof Error ? error.message : String(error) });
    }
  }
  /** Detect a newer analysis run without disturbing the current map. */
  startPolling(intervalMs = 30_000): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = setInterval(async () => {
      try { const meta = await this.api.meta(); if (this.state.meta && meta.run.id !== this.state.meta.run.id) this.set({ staleIndex: true }); } catch { /* server may be restarting */ }
    }, intervalMs);
  }
  async reload(): Promise<void> {
    const selected = this.state.selection?.id;
    this.api.clear(); this.childLoads.clear();
    this.set({ selection: undefined, relations: EMPTY_RELATIONS, aggregate: { status: 'idle' }, diagnostics: { status: 'idle' }, evidence: undefined, source: undefined });
    await this.init();
    if (selected && !this.state.selection) await this.select(selected, { fly: false, recordHistory: false }).catch(() => undefined);
  }
  /** Fetch the next page of children for each container (bounded, de-duplicated). */
  async loadChildren(ids: string[]): Promise<void> {
    const scene = this.scene, epoch = this.epoch;
    await Promise.all(ids.slice(0, 6).map(async id => {
      const list = scene.childList(id);
      if (this.childLoads.has(id) || list.complete || list.loadedPages * CHILD_PAGE >= CHILD_CAP) return;
      this.childLoads.add(id);
      scene.setLoading(id, true);
      try {
        const page = await this.api.children(id, list.loadedPages * CHILD_PAGE, CHILD_PAGE);
        if (epoch !== this.epoch) return;
        scene.addChildren(id, page.items, page.total, page.hasMore && (list.loadedPages + 1) * CHILD_PAGE < CHILD_CAP);
      } catch (error) {
        if (epoch === this.epoch) scene.setLoading(id, false, error instanceof Error ? error.message : String(error));
      } finally { this.childLoads.delete(id); if (epoch === this.epoch) this.bumpScene(); }
    }));
  }
  /** Make an entity reachable in the scene by inserting its spatial ancestor chain. */
  private place(located: LocateResult, epoch = this.epoch): void {
    if (epoch !== this.epoch) return;
    for (const ancestor of located.spatialAncestors) this.scene.upsert(ancestor);
    this.scene.upsert(located.node);
    this.bumpScene();
  }
  async select(id: string, options: { fly?: boolean; recordHistory?: boolean; mode?: 'focus' | 'enter'; byPlayback?: boolean } = {}): Promise<void> {
    // Choosing something yourself pauses a flow that is playing: its next stop must not take the selection away.
    if (!options.byPlayback) this.pausePlayback();
    const signal = this.abortable('selection');
    const epoch = this.epoch;
    const known = this.scene.nodes.get(id);
    this.set(state => ({
      selection: { id, node: known, entityStatus: 'loading' },
      evidence: undefined,
      history: options.recordHistory === false || state.history.entries[state.history.index] === id ? state.history : { entries: [...state.history.entries.slice(0, state.history.index + 1), id].slice(-100), index: Math.min(state.history.index + 1, 99) },
    }));
    this.writeHash(id);
    if (this.state.impact.open) void this.loadImpact(id);
    try {
      const located = await this.api.locate(id, signal);
      if (signal.aborted) return;
      this.place(located, epoch);
      this.set(state => state.selection?.id === id ? { selection: { ...state.selection, node: located.node, locate: located } } : {});
      if (options.fly !== false) this.navigator?.flyTo(located.node, { mode: options.mode ?? (isContainer(located.node) ? 'enter' : 'focus') });
      void this.loadChildren(located.spatialAncestors.map(node => node.id).filter(nodeId => !this.scene.childList(nodeId).complete));
      const isEntity = located.node.kind === 'entity';
      const fileAncestor = [...located.canonicalAncestors].reverse().find(item => item.type === 'file');
      await Promise.all([
        isEntity ? this.api.entity(id, signal).then(entity => this.set(state => state.selection?.id === id ? { selection: { ...state.selection, entity, entityStatus: 'ready' } } : {})) : Promise.resolve(this.set(state => state.selection?.id === id ? { selection: { ...state.selection, entityStatus: 'ready' } } : {})),
        fileAncestor ? this.api.entity(fileAncestor.id, signal).then(file => this.set(state => state.selection?.id === id ? { selection: { ...state.selection, file } } : {})).catch(() => undefined) : Promise.resolve(),
        this.loadRelations(id, located.node),
        this.loadDiagnostics(id),
        isEntity && this.comparing ? this.loadChange(id, signal) : Promise.resolve(),
        isEntity && this.state.timeline.open && this.state.meta?.history.available ? this.loadEntityTimeline(id, signal) : Promise.resolve(),
        this.loadSelectionCoverage(id, signal),
        this.loadSelectionAnnotation(id, signal),
      ]);
    } catch (error) {
      if (isAbort(error)) return;
      this.set(state => state.selection?.id === id ? { selection: { ...state.selection, entityStatus: 'error', error: error instanceof Error ? error.message : String(error) } } : {});
    }
  }
  /** Pause the flow playing on the map. */
  private pausePlayback(): void {
    if (this.state.tour?.playback.status === 'playing') this.setTour(tour => ({ playback: { ...tour.playback, status: 'paused' } }));
  }
  clearSelection(): void {
    this.aborts.get('selection')?.abort();
    if (this.state.impact.open) this.hideImpact();
    this.set({ selection: undefined, relations: EMPTY_RELATIONS, aggregate: { status: 'idle' }, diagnostics: { status: 'idle' }, evidence: undefined });
    this.writeHash(undefined);
  }
  /** `#id=…&at=…&vs=…`: the selection and, in history mode, the viewed and baseline commits. */
  private writeHash(id = this.state.selection?.id): void {
    const timeline = this.state.timeline;
    const parts: string[] = [];
    if (id) parts.push(`id=${encodeURIComponent(id)}`);
    if (id && this.state.impact.open) parts.push(`impact=${this.state.impact.depth}`);
    if (this.state.lens !== 'folders') parts.push(`lens=${this.state.lens}`);
    if (timeline.open) {
      const at = snapshotToken(timeline.data, timeline.target) ?? 'live', vs = timeline.compare ? snapshotToken(timeline.data, timeline.baseline ?? timeline.data?.workingTree?.id) : undefined;
      parts.push(`at=${at}`);
      if (vs && timeline.baseline) parts.push(`vs=${vs}`);
    }
    this.options.location?.replace(parts.length ? `#${parts.join('&')}` : '#');
  }
  private get comparing(): boolean { return !!this.state.meta?.comparison; }
  private async loadChange(id: string, signal: AbortSignal): Promise<void> {
    this.set(state => state.selection?.id === id ? { selection: { ...state.selection, change: { status: 'loading' } } } : {});
    try {
      const data = await this.api.change(id, signal);
      this.set(state => state.selection?.id === id ? { selection: { ...state.selection, change: { status: 'ready', data } } } : {});
    } catch (error) { if (!isAbort(error)) this.set(state => state.selection?.id === id ? { selection: { ...state.selection, change: { status: 'error', error: error instanceof Error ? error.message : String(error) } } } : {}); }
  }
  private async loadSelectionAnnotation(id: string, signal: AbortSignal): Promise<void> {
    if (!this.state.annotations.data?.available) return;
    try {
      const data = await this.api.entityAnnotation(id, signal);
      this.set(state => state.selection?.id === id ? { selection: { ...state.selection, annotation: { status: 'ready', data } } } : {});
    } catch (error) { if (!isAbort(error)) this.set(state => state.selection?.id === id ? { selection: { ...state.selection, annotation: { status: 'error', error: error instanceof Error ? error.message : String(error) } } } : {}); }
  }
  /** What the language models said about the repository (absent until `annotate` runs). */
  async loadAnnotations(): Promise<void> {
    try {
      const data = await this.api.annotations();
      this.set({ annotations: { status: 'ready', data } });
      const selection = this.state.selection;
      if (data.available && selection && !selection.annotation) void this.loadSelectionAnnotation(selection.id, this.aborts.get('selection')?.signal ?? new AbortController().signal);
    } catch (error) { this.set({ annotations: { status: 'error', error: error instanceof Error ? error.message : String(error) } }); }
  }
  /** Arrange the live map by folder, by data family or by domain; the camera starts over on the new arrangement. */
  async setLens(lens: Lens): Promise<void> {
    if (lens === this.state.lens) return;
    this.set({ lens });
    if (this.state.timeline.open) { this.writeHash(); return; }
    // Domains and districts exist in one arrangement only: their selection does not carry over.
    const selected = this.state.selection?.id;
    if (selected && (selected.startsWith('lens:') || selected.startsWith('projection:'))) this.clearSelection();
    this.scene = new Scene();
    await this.applyView(this.state.selection?.id, false);
    this.navigator?.fitAll();
  }
  /** Group the files of every large folder as fits each (`auto`), or only those given a choice (`off`). */
  async setArrangeMode(mode: ArrangeState['mode']): Promise<void> {
    if (mode !== this.state.arrange.mode) await this.changeArrangement({ ...this.state.arrange, mode });
  }
  /** One folder's own grouping; the map then shows that folder. */
  async setFolderArrangement(id: string, choice: FolderChoice): Promise<void> {
    const folders = { ...this.state.arrange.folders };
    if (choice === (this.state.arrange.mode === 'auto' ? 'auto' : 'none')) delete folders[id]; else folders[id] = choice;
    await this.changeArrangement({ ...this.state.arrange, folders }, id);
  }
  private async changeArrangement(arrange: ArrangeState, folder?: string): Promise<void> {
    const before = arrangeParam(this.state.arrange);
    this.set({ arrange }); this.savePrefs();
    if (arrangeParam(arrange) === before || this.state.timeline.open || this.state.lens !== 'folders') return;
    // Groups exist in one arrangement only: their selection does not carry over.
    const selected = this.state.selection?.id;
    if (selected?.startsWith('projection:arrange:')) this.clearSelection();
    if (folder) { await this.applyView(folder, true); return; }
    this.scene = new Scene();
    await this.applyView(this.state.selection?.id, false);
    this.navigator?.fitAll();
  }
  private async loadSelectionCoverage(id: string, signal: AbortSignal): Promise<void> {
    this.set(state => state.selection?.id === id ? { selection: { ...state.selection, coverage: { status: 'loading' } } } : {});
    try {
      const data = await this.api.coverageOf(id, signal);
      this.set(state => state.selection?.id === id ? { selection: { ...state.selection, coverage: { status: 'ready', data } } } : {});
    } catch (error) { if (!isAbort(error)) this.set(state => state.selection?.id === id ? { selection: { ...state.selection, coverage: { status: 'error', error: error instanceof Error ? error.message : String(error) } } } : {}); }
  }
  private async loadEntityTimeline(id: string, signal: AbortSignal): Promise<void> {
    this.set(state => state.selection?.id === id ? { selection: { ...state.selection, timeline: { status: 'loading' } } } : {});
    try {
      const data = await this.api.entityHistory(id, signal);
      this.set(state => state.selection?.id === id ? { selection: { ...state.selection, timeline: { status: 'ready', data } } } : {});
    } catch (error) { if (!isAbort(error)) this.set(state => state.selection?.id === id ? { selection: { ...state.selection, timeline: { status: 'error', error: error instanceof Error ? error.message : String(error) } } } : {}); }
  }
  hover(node: NodeSummary | undefined): void { if (node?.id !== this.state.hover?.id) this.set({ hover: node }); }
  setView(view: ViewState): void {
    const current = this.state.view;
    if (current.level === view.level && current.zoom === view.zoom && current.truncated === view.truncated && current.focus.map(item => item.id).join() === view.focus.map(item => item.id).join() && current.visible.map(item => item.id).join() === view.visible.map(item => item.id).join()) return;
    this.set({ view });
  }
  async back(): Promise<void> {
    const { entries, index } = this.state.history;
    if (index <= 0) return;
    this.set({ history: { entries, index: index - 1 } });
    await this.select(entries[index - 1]!, { recordHistory: false });
  }
  async forward(): Promise<void> {
    const { entries, index } = this.state.history;
    if (index >= entries.length - 1) return;
    this.set({ history: { entries, index: index + 1 } });
    await this.select(entries[index + 1]!, { recordHistory: false });
  }
  private async loadRelations(id: string, node: NodeSummary, append = false): Promise<void> {
    const container = isContainer(node);
    if (container) {
      this.set({ aggregate: { status: 'loading', forId: id }, relations: { ...EMPTY_RELATIONS, forId: id } });
      try {
        const data = await this.api.aggregate(id, this.aborts.get('selection')?.signal);
        this.set(state => state.selection?.id === id ? { aggregate: { status: 'ready', forId: id, data } } : {});
      } catch (error) { if (!isAbort(error)) this.set({ aggregate: { status: 'error', forId: id, error: String(error instanceof Error ? error.message : error) } }); }
      return;
    }
    const current = this.state.relations.forId === id ? this.state.relations : { ...EMPTY_RELATIONS, forId: id };
    const signal = append ? this.abortable('relations-more') : this.aborts.get('selection')?.signal;
    this.set({ relations: { ...current, status: 'loading', forId: id, ...(append ? {} : { items: [] }) }, aggregate: { status: 'idle' } });
    try {
      // A file's relationships include those of its symbols across its boundary.
      const page = await this.api.relations(id, { type: current.type, direction: current.direction === 'both' ? undefined : current.direction, offset: append ? current.items.length : 0, limit: 100, ...(node.type === 'file' ? { scope: 'contained' as const } : {}) }, signal);
      this.set(state => state.selection?.id === id ? { relations: { ...state.relations, status: 'ready', forId: id, items: append ? [...state.relations.items, ...page.items] : page.items, typeCounts: page.typeCounts, total: page.total, hasMore: page.hasMore } } : {});
      if (!signal?.aborted) for (const item of page.items) { this.scene.upsert(item.other); if (item.inside) this.scene.upsert(item.inside); }
    } catch (error) { if (!isAbort(error)) this.set(state => ({ relations: { ...state.relations, status: 'error', error: String(error instanceof Error ? error.message : error) } })); }
  }
  setRelationFilter(filter: { type?: string | null; direction?: 'both' | 'outgoing' | 'incoming' }): void {
    const selection = this.state.selection;
    this.set(state => ({ relations: { ...state.relations, ...(filter.type !== undefined ? { type: filter.type ?? undefined } : {}), ...(filter.direction ? { direction: filter.direction } : {}) } }));
    if (selection?.node && !isContainer(selection.node)) void this.loadRelations(selection.id, selection.node);
  }
  loadMoreRelations(): void { const selection = this.state.selection; if (selection?.node) void this.loadRelations(selection.id, selection.node, true); }
  async drillAggregate(group: AggregateGroup | undefined, append = false): Promise<void> {
    const selection = this.state.selection;
    if (!selection || !group) { this.set(state => ({ aggregate: { ...state.aggregate, drill: undefined } })); return; }
    const signal = this.abortable('drill');
    const previous = append && this.state.aggregate.drill?.group === group ? this.state.aggregate.drill.items : [];
    this.set(state => ({ aggregate: { ...state.aggregate, drill: { group, status: 'loading', items: previous } } }));
    try {
      const page = await this.api.aggregateEdges(selection.id, { anchor: group.anchor.id, type: group.type, direction: group.direction, offset: previous.length, limit: 50 }, signal);
      for (const item of page.items) { this.scene.upsert(item.other); }
      this.set(state => state.aggregate.drill?.group === group ? { aggregate: { ...state.aggregate, drill: { group, status: 'ready', page, items: [...previous, ...page.items] } } } : {});
    } catch (error) { if (!isAbort(error)) this.set(state => ({ aggregate: { ...state.aggregate, drill: { group, status: 'error', items: previous, error: String(error instanceof Error ? error.message : error) } } })); }
  }
  private async loadDiagnostics(id: string): Promise<void> {
    this.set({ diagnostics: { status: 'loading', forId: id } });
    try {
      const data = await this.api.diagnostics(id, { limit: 50 }, this.aborts.get('selection')?.signal);
      this.set(state => state.selection?.id === id ? { diagnostics: { status: 'ready', forId: id, data } } : {});
    } catch (error) { if (!isAbort(error)) this.set({ diagnostics: { status: 'error', forId: id, error: String(error instanceof Error ? error.message : error) } }); }
  }
  async openEvidence(relationId: string, context?: EvidenceState['context']): Promise<void> {
    const signal = this.abortable('evidence');
    this.set({ evidence: { relationId, context, status: 'loading' } });
    try {
      const relation = await this.api.relation(relationId, signal);
      this.set(state => state.evidence?.relationId === relationId ? { evidence: { relationId, context, status: 'ready', relation } } : {});
    } catch (error) { if (!isAbort(error)) this.set({ evidence: { relationId, context, status: 'error', error: String(error instanceof Error ? error.message : error) } }); }
  }
  closeEvidence(): void { this.aborts.get('evidence')?.abort(); this.set({ evidence: undefined }); }
  async openSource(request: SourceRequest, title: string): Promise<void> {
    const signal = this.abortable('source');
    this.set({ diff: undefined, source: { request, title, status: 'loading', data: this.state.source?.data } });
    try {
      const data = await this.api.source(request, signal);
      this.set(state => state.source?.request === request ? { source: { request, title, status: 'ready', data } } : {});
    } catch (error) { if (!isAbort(error)) this.set(state => state.source?.request === request ? { source: { request, title, status: 'error', error: String(error instanceof Error ? error.message : error) } } : {}); }
  }
  /** Load another bounded window of the same source, keeping its focus. */
  async sourceWindow(start: number, end: number): Promise<void> {
    const source = this.state.source;
    if (!source) return;
    const { start: _s, end: _e, ...base } = source.request;
    await this.openSource({ ...base, start: Math.max(1, start), end: Math.max(start, end) }, source.title);
  }
  closeSource(): void { this.aborts.get('source')?.abort(); this.set({ source: undefined, diff: undefined }); }
  /** Line diff of an entity's own source between the baseline and the viewed snapshot. */
  async openDiff(entity: string, title: string, options: { ignoreWhitespace?: boolean; layout?: DiffState['layout'] } = {}): Promise<void> {
    const signal = this.abortable('source');
    const previous = this.state.diff;
    const ignoreWhitespace = options.ignoreWhitespace ?? previous?.ignoreWhitespace ?? false, layout = options.layout ?? previous?.layout ?? 'unified';
    this.set({ source: undefined, diff: { entity, title, status: 'loading', ignoreWhitespace, layout, ...(previous?.entity === entity ? { data: previous.data } : {}) } });
    try {
      const data = await this.api.sourceDiff(entity, { ignoreWhitespace }, signal);
      this.set(state => state.diff?.entity === entity ? { diff: { ...state.diff, status: 'ready', data } } : {});
    } catch (error) { if (!isAbort(error)) this.set(state => state.diff?.entity === entity ? { diff: { ...state.diff, status: 'error', error: String(error instanceof Error ? error.message : error) } } : {}); }
  }
  setDiffLayout(layout: DiffState['layout']): void { const diff = this.state.diff; if (diff) this.set({ diff: { ...diff, layout } }); }
  setDiffWhitespace(ignoreWhitespace: boolean): void { const diff = this.state.diff; if (diff) void this.openDiff(diff.entity, diff.title, { ignoreWhitespace }); }
  toggleDiagnostics(): void { this.set(state => ({ showDiagnostics: !state.showDiagnostics })); this.savePrefs(); }
  setTheme(themeId: string): void { this.set({ themeId }); this.savePrefs(); }

  // History -----------------------------------------------------------------
  private setTimeline(patch: Partial<TimelineState>): void { this.set(state => ({ timeline: { ...state.timeline, ...patch } })); }
  /** The snapshot/baseline pair every request reads. */
  viewKey(): ViewKey {
    const timeline = this.state.timeline;
    if (!timeline.open) {
      if (this.state.lens !== 'folders') return { lens: this.state.lens };
      const arrange = arrangeParam(this.state.arrange);
      return arrange ? { arrange } : {};
    }
    // The live index is named explicitly in history mode, so it is drawn on the timeline layout like every commit.
    const snapshot = timeline.target ?? timeline.data?.workingTree?.id;
    return { ...(snapshot ? { snapshot } : {}), ...(timeline.compare && timeline.baseline ? { compareTo: timeline.baseline } : {}) };
  }
  async refreshTimeline(): Promise<TimelineResponse | undefined> {
    try {
      const data = await this.api.timeline();
      this.setTimeline({ data, status: 'ready', error: undefined });
      if (this.evolution && evolutionKey(data) !== this.evolutionKey) {
        // Commits were indexed since: rebuild the time-lapse (the server recomputes it for the new list).
        this.evolution = undefined;
        this.setTimeline({ evolution: { status: 'idle' } });
        if (!this.state.timeline.playing) { this.clearPreview(); void this.loadEvolution(); }
      }
      return data;
    } catch (error) {
      if (!isAbort(error)) this.setTimeline({ status: 'error', error: error instanceof Error ? error.message : String(error) });
      return undefined;
    } finally { this.scheduleTimelinePoll(); }
  }
  /** Newly indexed snapshots appear on the timeline; poll faster while the server indexes on request. */
  private scheduleTimelinePoll(): void {
    if (this.timelineTimer) clearTimeout(this.timelineTimer);
    const timeline = this.state.timeline;
    if (!timeline.open || typeof setTimeout === 'undefined') return;
    const busy = !!timeline.data?.indexing.active || !!timeline.data?.indexing.queued.length;
    this.timelineTimer = setTimeout(() => void this.refreshTimeline(), busy ? 2500 : 30_000);
  }
  /** Open the timeline. Without a deep link the live index is compared with its predecessor (its HEAD commit when indexed). */
  async openTimeline(options: { at?: string; vs?: string; select?: string } = {}): Promise<void> {
    this.setTimeline({ open: true, status: 'loading', notice: undefined });
    const data = await this.refreshTimeline();
    if (!data) { if (options.select) await this.select(options.select, { fly: true }); return; }
    const target = snapshotFromToken(data, options.at);
    const compare = options.at ? !!options.vs : true;
    const baseline = compare ? (options.vs ? snapshotFromToken(data, options.vs) : undefined) ?? predecessor(data, target) : undefined;
    // A shared link names its baseline: keep it while stepping unless it is just the previous commit.
    this.setTimeline({ target, baseline, compare: compare && !!baseline, pinned: !!options.vs && !!baseline && baseline !== predecessor(data, target) });
    if (data.available) void this.loadEvolution();
    await this.applyView(options.select, !!options.select);
  }
  async closeTimeline(): Promise<void> {
    if (this.timelineTimer) clearTimeout(this.timelineTimer);
    this.setTimeline({ open: false, notice: undefined, changes: EMPTY_CHANGES, playing: false });
    this.clearPreview();
    await this.applyView();
  }
  /** View another snapshot (undefined: the live index). The baseline follows unless pinned. */
  async setTarget(id: string | undefined): Promise<void> {
    if (this.state.timeline.playing) this.setTimeline({ playing: false });
    const timeline = this.state.timeline;
    // The time-lapse frame of that commit shows at once (it compares with the previous commit, as this view will).
    const frame = timeline.compare && !timeline.pinned ? this.evolution?.frameOf(id) : undefined;
    if (frame !== undefined) this.previewFrame(frame);
    const baseline = timeline.pinned ? timeline.baseline : predecessor(timeline.data, id);
    this.setTimeline({ target: id, baseline: baseline !== id ? baseline : undefined, notice: undefined });
    await this.applyView();
  }
  /** Pin any snapshot as the baseline (non-adjacent comparison). */
  async setBaseline(id: string | undefined): Promise<void> {
    this.setTimeline({ baseline: id, compare: !!id, pinned: !!id, notice: undefined });
    await this.applyView();
  }
  async setCompare(compare: boolean): Promise<void> {
    const timeline = this.state.timeline;
    this.setTimeline({ compare, baseline: timeline.baseline ?? predecessor(timeline.data, timeline.target), notice: undefined });
    await this.applyView();
  }
  async setPinned(pinned: boolean): Promise<void> {
    this.setTimeline({ pinned });
    if (!pinned) { const timeline = this.state.timeline; const baseline = predecessor(timeline.data, timeline.target); if (baseline !== timeline.baseline) { this.setTimeline({ baseline }); await this.applyView(); } }
  }
  /** Move the viewed snapshot to the previous/next indexed commit (the live index is after the last commit). */
  async stepTarget(delta: -1 | 1): Promise<void> {
    const timeline = this.state.timeline, data = timeline.data;
    if (!data) return;
    // From the frame on screen when scrubbing or playing.
    const from = timeline.preview !== undefined && this.evolution ? this.evolution.snapshotAt(timeline.preview) : timeline.target;
    for (let index = timelineIndex(data, from) + delta; index >= 0 && index <= data.entries.length; index += delta) {
      if (index === data.entries.length) { if (data.workingTree) await this.setTarget(undefined); return; }
      const snapshot = data.entries[index]!.snapshot;
      if (snapshot) { await this.setTarget(snapshot.id); return; }
    }
  }
  toggleDimUnchanged(): void { this.setTimeline({ dimUnchanged: !this.state.timeline.dimUnchanged }); this.savePrefs(); }
  /** Compare in one map or split by place; `focus` is where the single map starts (a place opened on its own). */
  setSplit(split: boolean, focus?: { node: NodeSummary; frame?: Rect }): void {
    this.pendingFocus = split ? undefined : focus;
    this.setTimeline({ split }); this.savePrefs();
    if (split) void this.loadRegions();
  }
  setRegionLevel(regionLevel: RegionLevel): void {
    if (regionLevel === this.state.timeline.regionLevel) return;
    this.setTimeline({ regionLevel }); this.savePrefs();
    void this.loadRegions();
  }
  /** Where the single map should start, once. */
  takeFocus(): { node: NodeSummary; frame?: Rect } | undefined { const focus = this.pendingFocus; this.pendingFocus = undefined; return focus; }
  /** The places of the comparison for the split map; their areas are placed in the scene so the views can frame them. */
  async loadRegions(): Promise<void> {
    const timeline = this.state.timeline;
    if (!timeline.open || !timeline.split || !this.comparing) return;
    const viewStamp = `${this.viewStamp()}|${timeline.regionLevel}`;
    if (timeline.regions.viewStamp === viewStamp && timeline.regions.status !== 'error') return;
    const signal = this.abortable('regions');
    const scene = this.scene, epoch = this.epoch;
    // The places on screen stay until the new ones arrive.
    this.setTimeline({ regions: { ...timeline.regions, status: 'loading', viewStamp, error: undefined } });
    try {
      const data = await this.api.regions(timeline.regionLevel, signal);
      if (signal.aborted || epoch !== this.epoch) return;
      for (const region of data.regions) { for (const ancestor of region.ancestors) scene.upsert(ancestor); scene.upsert(region.node); }
      this.set(state => state.timeline.regions.viewStamp === viewStamp ? { sceneRevision: state.sceneRevision + 1, timeline: { ...state.timeline, regions: { status: 'ready', viewStamp, data } } } : {});
    } catch (error) { if (!isAbort(error)) this.set(state => state.timeline.regions.viewStamp === viewStamp ? { timeline: { ...state.timeline, regions: { ...state.timeline.regions, status: 'error', error: error instanceof Error ? error.message : String(error) } } } : {}); }
  }
  /** Ask the server to analyze a timeline commit that has no snapshot yet. */
  async indexCommit(sha: string): Promise<void> {
    try { await this.api.requestIndex(sha); this.setTimeline({ notice: undefined }); await this.refreshTimeline(); }
    catch (error) { this.setTimeline({ notice: error instanceof Error ? error.message : String(error) }); }
  }

  // Time-lapse ----------------------------------------------------------------
  /** Fetch the time-lapse frames; the server builds them on first request and reports progress meanwhile. */
  loadEvolution(): Promise<boolean> {
    if (this.evolution) return Promise.resolve(true);
    this.evolutionLoad ??= (async () => {
      const key = evolutionKey(this.state.timeline.data);
      this.setTimeline({ evolution: { status: 'loading', progress: 0 } });
      try {
        for (;;) {
          const response = await this.api.evolution();
          if (this.disposed) return false;
          if (response.status === 'ready') {
            this.evolution = new Evolution(response); this.evolutionKey = key;
            this.setTimeline({ evolution: { status: 'ready' } });
            return true;
          }
          this.setTimeline({ evolution: { status: 'loading', progress: response.progress } });
          await new Promise(resolve => setTimeout(resolve, 400));
        }
      } catch (error) {
        if (!this.disposed) this.setTimeline({ evolution: { status: 'error', error: error instanceof Error ? error.message : String(error) } });
        return false;
      } finally { this.evolutionLoad = undefined; }
    })();
    return this.evolutionLoad;
  }
  /** Put a time-lapse frame on screen at once. The settled view of its commit is loaded separately (`settle`). */
  previewFrame(frame: number): void {
    const evolution = this.evolution;
    if (!evolution || !evolution.length) return;
    const index = Math.max(0, Math.min(evolution.length - 1, Math.round(frame)));
    const ghosts = this.state.timeline.compare;
    if (this.state.timeline.preview === index && this.previewScene?.frame === index) return;
    this.previewScene = evolution.scene(index, { ghosts });
    this.set(state => ({ sceneRevision: state.sceneRevision + 1, timeline: { ...state.timeline, preview: index } }));
  }
  private clearPreview(): void {
    if (!this.previewScene && this.state.timeline.preview === undefined) return;
    this.previewScene = undefined;
    this.set(state => ({ sceneRevision: state.sceneRevision + 1, timeline: { ...state.timeline, preview: undefined } }));
  }
  /** Drop a view that is still loading: a frame on screen supersedes it. */
  private cancelView(): void {
    this.epoch++;
    this.aborts.get('view')?.abort();
    if (this.state.timeline.switching) this.setTimeline({ switching: false });
  }
  /** Scrub to a commit: shown at once when the time-lapse is loaded (true); otherwise the caller falls back to `setTarget` (false). */
  scrubTo(snapshot: string | undefined): boolean {
    const frame = this.evolution?.frameOf(snapshot);
    if (frame === undefined) return false;
    if (this.state.timeline.playing) this.pause(false);
    if (this.state.timeline.preview !== frame) this.cancelView();
    this.previewFrame(frame);
    return true;
  }
  /** Settle the view on the frame on screen: its commit, with full detail. */
  async settle(): Promise<void> {
    const preview = this.state.timeline.preview;
    if (preview === undefined || !this.evolution) return;
    await this.setTarget(this.evolution.snapshotAt(preview));
  }
  /** Play the history from the frame on screen (from the first commit when at the end). */
  async play(): Promise<void> {
    if (this.state.timeline.playing || !this.state.timeline.open) return;
    if (!await this.loadEvolution() || !this.state.timeline.open) return;
    const evolution = this.evolution!;
    let frame = this.state.timeline.preview ?? evolution.frameOf(this.state.timeline.target) ?? evolution.length - 1;
    if (frame >= evolution.length - 1) frame = 0;
    this.cancelView();
    this.playhead = frame;
    this.setTimeline({ playing: true });
    this.previewFrame(frame);
  }
  /** Stop playing; by default the view then settles on the frame on screen. */
  pause(settle = true): void {
    if (!this.state.timeline.playing) return;
    this.setTimeline({ playing: false });
    if (settle) void this.settle();
  }
  togglePlay(): void { if (this.state.timeline.playing) this.pause(); else void this.play(); }
  /** Frames per second: the whole history in about forty seconds at 1×, within readable bounds. */
  playbackRate(): number { return Math.max(2, Math.min(24, (this.evolution?.length ?? 0) / 40)) * this.state.timeline.speed; }
  /** Advance playback by elapsed wall-clock time (the map calls this every animation frame). */
  advancePlayback(elapsedMs: number): void {
    const evolution = this.evolution;
    if (!this.state.timeline.playing || !evolution) return;
    this.playhead += (elapsedMs / 1000) * this.playbackRate();
    if (this.playhead >= evolution.length) { this.previewFrame(evolution.length - 1); this.pause(); return; }
    const frame = Math.floor(this.playhead);
    if (frame !== this.state.timeline.preview) this.previewFrame(frame);
  }
  setSpeed(speed: number): void { this.setTimeline({ speed }); }
  setFollow(follow: boolean): void { if (follow !== this.state.timeline.follow) this.setTimeline({ follow }); }
  /** Changed entities of the comparison, for the overview list. */
  async loadChanges(filter = this.state.timeline.changes.filter, append = false): Promise<void> {
    if (!this.comparing) { this.setTimeline({ changes: EMPTY_CHANGES }); return; }
    const signal = this.abortable('changes');
    const current = this.state.timeline.changes;
    const previous = append && current.filter === filter ? current.items : [];
    this.setTimeline({ changes: { ...current, status: 'loading', filter, items: previous } });
    try {
      const page = await this.api.changes({ status: filter, offset: previous.length, limit: 100 }, signal);
      this.setTimeline({ changes: { status: 'ready', filter, page, items: [...previous, ...page.items] } });
    } catch (error) { if (!isAbort(error)) this.setTimeline({ changes: { ...this.state.timeline.changes, status: 'error', error: error instanceof Error ? error.message : String(error) } }); }
  }
  /**
   * Show the map for the current view. The new scene is filled with the
   * containers open on screen before it replaces the old one, so the camera
   * stays and areas do not blink closed; the selection is carried over
   * (through lineage when its ID changed) when it exists in the new view.
   */
  private async applyView(select = this.state.selection?.id, fly = false): Promise<void> {
    const epoch = ++this.epoch;
    const previousSnapshot = this.state.meta?.snapshot.id;
    for (const key of ['selection', 'relations-more', 'drill', 'evidence', 'flow', 'changes', 'regions']) this.aborts.get(key)?.abort();
    const signal = this.abortable('view');
    this.api.setView(this.viewKey());
    this.setTimeline({ switching: true, error: undefined });
    try {
      const meta = await this.api.meta(signal);
      if (epoch !== this.epoch) return;
      const scene = new Scene();
      scene.reset(meta.root);
      const load = async (id: string) => {
        try { const page = await this.api.children(id, 0, CHILD_PAGE, signal); scene.addChildren(id, page.items, page.total, page.hasMore && CHILD_PAGE < CHILD_CAP); }
        catch (error) { if (isAbort(error)) throw error; /* absent from this view */ }
      };
      await load(meta.root.id);
      const open = (this.openContainers?.() ?? []).filter(id => id !== meta.root.id).slice(0, 48);
      for (let i = 0; i < open.length; i += 8) await Promise.all(open.slice(i, i + 8).map(load));
      if (epoch !== this.epoch) return;
      this.scene = scene;
      this.childLoads.clear();
      // The settled view takes over from a time-lapse frame (unless playback is moving on).
      const settled = !this.state.timeline.playing;
      if (settled) this.previewScene = undefined;
      this.set(state => ({ meta, staleIndex: false, sceneRevision: state.sceneRevision + 1, relations: EMPTY_RELATIONS, aggregate: { status: 'idle' }, diagnostics: { status: 'idle' }, evidence: undefined, timeline: { ...state.timeline, switching: false, changes: EMPTY_CHANGES, ...(settled ? { preview: undefined } : {}) } }));
      this.writeHash(select);
      const { source, diff } = this.state;
      if (diff) { if (meta.comparison) void this.openDiff(diff.entity, diff.title); else this.set({ diff: undefined }); }
      else if (source) void this.openSource(source.request, source.title);
      if (meta.comparison) { void this.loadChanges(); void this.loadRegions(); }
      if (select) {
        const resolved = await this.api.resolve(select, previousSnapshot !== meta.snapshot.id ? previousSnapshot : undefined, signal);
        if (epoch !== this.epoch) return;
        if (resolved) await this.select(resolved.id, { fly, recordHistory: false });
        else { this.set({ selection: undefined }); this.setTimeline({ notice: 'The selected entity does not exist in this snapshot.' }); this.writeHash(undefined); }
      }
      if (this.state.catalog.status !== 'idle') void this.loadCatalog();
      if (this.state.coverage.show) void this.loadCoverage();
      if (this.state.families.show) void this.loadFamilies();
      if (this.state.requests.open) void this.openRequestFlow(this.state.requests.open.id);
      const tour = this.state.tour;
      if (tour) void this.openTour({ id: tour.id, detail: tour.detail, title: tour.title, ...(tour.subtitle ? { subtitle: tour.subtitle } : {}), ...(tour.kind ? { kind: tour.kind } : {}) }, { fit: false, play: false });
    } catch (error) {
      if (isAbort(error) || epoch !== this.epoch) return;
      this.setTimeline({ switching: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  // Blast radius and steps ----------------------------------------------------
  /** Identity of the current view, to tell whether loaded results still belong to it. */
  viewStamp(): string { const meta = this.state.meta; return `${meta?.snapshot.id ?? ''}|${meta?.comparison?.baseline.id ?? ''}|${this.state.timeline.open ? 'folders' : this.state.lens === 'folders' ? `folders:${arrangeParam(this.state.arrange) ?? ''}` : this.state.lens}`; }
  /** Show what depends on an entity (the selection by default); it then follows the selection. */
  async showImpact(id = this.state.selection?.id, depth = this.state.impact.depth): Promise<void> {
    if (!id) return;
    this.set(state => ({ impact: { ...state.impact, open: true, depth, filter: {}, ...(state.impact.forId !== id || state.impact.depth !== depth ? { data: undefined, items: [] } : {}) } }));
    this.writeHash();
    await this.loadImpact(id);
  }
  hideImpact(): void {
    this.aborts.get('impact')?.abort();
    this.set(state => ({ impact: { ...state.impact, open: false, status: 'idle', forId: undefined, data: undefined, items: [], error: undefined } }));
    this.writeHash();
  }
  async setImpactDepth(depth: number): Promise<void> {
    this.set(state => ({ impact: { ...state.impact, depth, data: undefined, items: [] } }));
    this.writeHash();
    if (this.state.impact.open && this.state.impact.forId) await this.loadImpact(this.state.impact.forId);
  }
  async setImpactFilter(filter: ImpactState['filter']): Promise<void> {
    this.set(state => ({ impact: { ...state.impact, filter } }));
    if (this.state.impact.forId) await this.loadImpact(this.state.impact.forId);
  }
  async loadImpact(id: string, append = false): Promise<void> {
    const signal = this.abortable('impact');
    const current = this.state.impact, viewStamp = this.viewStamp();
    this.set(state => ({ impact: { ...state.impact, status: 'loading', forId: id, viewStamp, ...(state.impact.forId !== id ? { data: undefined, items: [] } : {}) } }));
    try {
      const data = await this.api.impact(id, { depth: current.depth, ...current.filter, offset: append ? current.items.length : 0, limit: 100 }, signal);
      if (signal.aborted) return;
      for (const item of data.items.items) this.scene.upsert(item);
      this.set(state => state.impact.forId === id && state.impact.open ? { impact: { ...state.impact, status: 'ready', data, viewStamp, items: append ? [...state.impact.items, ...data.items.items] : data.items.items, error: undefined } } : {});
    } catch (error) { if (!isAbort(error)) this.set(state => ({ impact: { ...state.impact, status: 'error', error: error instanceof Error ? error.message : String(error) } })); }
  }
  loadMoreImpact(): void { const impact = this.state.impact; if (impact.forId && impact.data?.items.hasMore) void this.loadImpact(impact.forId, true); }
  /** What the viewed comparison's changes reach; loaded once per comparison. */
  async loadCommitImpact(): Promise<void> {
    const meta = this.state.meta, viewStamp = this.viewStamp();
    if (!meta?.comparison) { if (this.state.commitImpact.status !== 'idle') this.set(state => ({ commitImpact: { status: 'idle', show: state.commitImpact.show } })); return; }
    if (this.state.commitImpact.viewStamp === viewStamp && this.state.commitImpact.status !== 'error') return;
    const signal = this.abortable('commit-impact');
    this.set(state => ({ commitImpact: { status: 'loading', viewStamp, show: state.commitImpact.show } }));
    try {
      const data = await this.api.impact({ comparison: true }, { depth: this.state.impact.depth, limit: 50 }, signal);
      if (signal.aborted) return;
      this.set(state => state.commitImpact.viewStamp === viewStamp ? { commitImpact: { ...state.commitImpact, status: 'ready', data } } : {});
    } catch (error) { if (!isAbort(error)) this.set(state => ({ commitImpact: { ...state.commitImpact, status: 'error', error: error instanceof Error ? error.message : String(error) } })); }
  }
  toggleCommitImpact(): void { this.set(state => ({ commitImpact: { ...state.commitImpact, show: !state.commitImpact.show } })); }
  /** Open "what happens from here" for an entity (the selection by default). */
  async openSteps(id = this.state.selection?.id): Promise<void> {
    if (!id || id.startsWith('projection:')) return;
    const signal = this.abortable('steps');
    const viewStamp = this.viewStamp();
    this.set({ steps: { anchor: id, status: 'loading', viewStamp } });
    try {
      const data = await this.api.steps(id, signal);
      if (signal.aborted) return;
      for (const step of data.steps) if (step.node) this.scene.upsert(step.node);
      this.set(state => state.steps?.anchor === id ? { steps: { ...state.steps, status: 'ready', data }, sceneRevision: state.sceneRevision + 1 } : {});
    } catch (error) { if (!isAbort(error)) this.set(state => state.steps?.anchor === id ? { steps: { ...state.steps, status: 'error', error: error instanceof Error ? error.message : String(error) } } : {}); }
  }
  closeSteps(): void { this.aborts.get('steps')?.abort(); this.set({ steps: undefined }); }
  /** Highlight one step (and its links) on the map. */
  focusStep(id: string | undefined): void { this.set(state => state.steps ? { steps: { ...state.steps, focus: id } } : {}); }

  // Flows: the catalog, flows on the map, the lanes, coverage -------------------------
  private setCatalog(patch: Partial<CatalogState> | ((catalog: CatalogState) => Partial<CatalogState>)): void {
    this.set(state => ({ catalog: { ...state.catalog, ...(typeof patch === 'function' ? patch(state.catalog) : patch) } }));
  }
  /** List every flow of the view (`entity`: only those touching it; `null` lists them all again). */
  async loadCatalog(entity?: { id: string; name: string } | null): Promise<void> {
    if (entity !== undefined) this.setCatalog({ entity: entity ?? undefined });
    const filter = this.state.catalog.entity?.id;
    const signal = this.abortable('catalog');
    const viewStamp = this.viewStamp();
    this.setCatalog({ status: 'loading', error: undefined });
    try {
      const data = await this.api.catalog({ ...(filter ? { entity: filter } : {}) }, signal);
      if (signal.aborted) return;
      this.setCatalog(catalog => catalog.entity?.id === filter ? { status: 'ready', data, viewStamp } : {});
    } catch (error) { if (!isAbort(error)) this.setCatalog({ status: 'error', error: error instanceof Error ? error.message : String(error) }); }
  }
  /** Show the Flows panel, optionally filtered to one kind and to the flows through an entity. */
  async showFlows(options: { kind?: CatalogState['kind']; entity?: { id: string; name: string } | null } = {}): Promise<void> {
    this.setCatalog(catalog => ({ reveal: (catalog.reveal ?? 0) + 1, ...(options.kind ? { kind: options.kind } : {}) }));
    if (options.entity !== undefined || this.state.catalog.status === 'idle' || this.state.catalog.viewStamp !== this.viewStamp()) await this.loadCatalog(options.entity);
  }
  setCatalogKind(kind: CatalogState['kind']): void { this.setCatalog({ kind }); }
  setCatalogQuery(query: string): void { this.setCatalog({ query }); }
  setCatalogFilter(filter: FlowStatus | undefined): void { this.setCatalog(catalog => ({ filter: catalog.filter === filter ? undefined : filter })); }
  /** Open a flow of the catalog on the map. */
  openCatalogFlow(item: FlowSummary): Promise<void> { return this.openTour(tourEntry(item)); }

  private setTour(patch: Partial<TourState> | ((tour: TourState) => Partial<TourState>)): void {
    this.set(state => state.tour ? { tour: { ...state.tour, ...(typeof patch === 'function' ? patch(state.tour) : patch) } } : {});
  }
  /**
   * Show a flow on the map: a request's lanes (`lanes`, by endpoint, command,
   * task or unmatched caller) or a page's Steps (`steps`, by page route). Its
   * stops and their areas are placed in the scene, so the map can open them.
   */
  async openTour(entry: { id: string; detail: 'lanes' | 'steps'; title: string; subtitle?: string; kind?: CatalogKind }, options: { play?: boolean; fit?: boolean } = {}): Promise<void> {
    const signal = this.abortable('tour');
    const viewStamp = this.viewStamp();
    const key = `${entry.detail}:${entry.id}`;
    this.set(state => ({
      tour: { key, id: entry.id, detail: entry.detail, title: entry.title, ...(entry.subtitle ? { subtitle: entry.subtitle } : {}), ...(entry.kind ? { kind: entry.kind } : {}), status: 'loading', viewStamp, playback: initialPlayback(), follow: state.tour?.follow ?? true, ...(state.tour?.key === key && state.tour.flow ? { flow: state.tour.flow } : {}) },
      // The lanes of another flow give way to this one.
      ...(state.requests.open && state.requests.open.id !== entry.id ? { requests: { open: undefined } } : {}),
    }));
    try {
      const flow = entry.detail === 'lanes' ? fromRequestFlow(await this.api.requestFlow(entry.id, signal)) : fromSteps(await this.api.steps(entry.id, signal));
      if (signal.aborted) return;
      await this.placeFlow(flow, signal);
      if (signal.aborted) return;
      const playback = initialPlayback(flow.branches.map(() => false));
      this.set(state => state.tour?.key === key ? { tour: { ...state.tour, status: 'ready', viewStamp, flow, playback: options.play === false ? playback : { ...playback, status: 'playing' } }, sceneRevision: state.sceneRevision + 1 } : {});
      if (options.fit !== false) { if (this.state.tour?.follow && options.play !== false) this.followBranch(0); else this.fitTour(); }
    } catch (error) { if (!isAbort(error)) this.setTour(tour => tour.key === key ? { status: 'error', error: error instanceof Error ? error.message : String(error) } : {}); }
  }
  /** Insert a flow's stops, pin owners and their areas into the scene, outermost first. */
  private async placeFlow(flow: MapFlow, signal: AbortSignal): Promise<void> {
    const wanted = new Set<string>();
    for (const stop of flow.stops) { wanted.add(stop.entityId); for (const id of stop.ancestors) wanted.add(id); }
    for (const pin of flow.pins) { wanted.add(pin.ownerId); for (const id of pin.ownerAncestors) wanted.add(id); }
    const absent = [...wanted].filter(id => !this.scene.nodes.has(id));
    const found: NodeSummary[] = [];
    for (let i = 0; i < absent.length; i += 200) found.push(...(await this.api.nodes(absent.slice(i, i + 200), signal)).items);
    if (signal.aborted) return;
    found.sort((a, b) => a.depth - b.depth);
    for (const node of found) this.scene.upsert(node);
    for (const stop of flow.stops) if (stop.node) this.scene.upsert(stop.node);
    this.bumpScene();
  }
  closeTour(): void { this.aborts.get('tour')?.abort(); this.set({ tour: undefined }); }
  /** Move through the flow on the map branch by branch: play, pause, step, seek; a branch's choice is selected as it starts. */
  tourAction(action: PlaybackAction): void {
    const tour = this.state.tour;
    if (!tour?.flow) return;
    const after = playback(tour.playback, action);
    if (after === tour.playback) return;
    this.setTour({ playback: after });
    if (after.index === tour.playback.index && action.type !== 'restart' && action.type !== 'seek') return;
    const branch = tour.flow.branches[after.index];
    const head = branch ? tour.flow.stops[branch.head] : undefined;
    if (!head?.node) return;
    void this.select(head.entityId, { fly: false, recordHistory: false, byPlayback: true });
    if (tour.follow) this.followBranch(after.index);
  }
  /** Frame every stop of a branch, so its whole flow is seen. */
  private followBranch(index: number): void {
    const flow = this.state.tour?.flow;
    const branch = flow?.branches[index];
    const nodes = branch ? branch.waves.flat().flatMap(stop => flow!.stops[stop]?.node ? [flow!.stops[stop]!.node!] : []) : [];
    if (nodes.length) this.navigator?.fitNodes(nodes);
  }
  /** A stop of the flow, chosen in the bar: selected and flown to (playback pauses, as for any selection). */
  focusTourStop(index: number): void {
    const stop = this.state.tour?.flow?.stops[index];
    if (!stop?.node) return;
    this.navigator?.flyTo(stop.node);
    void this.select(stop.entityId, { fly: false });
  }
  /** Fit every stop of the flow on the map in view. */
  fitTour(): void { const flow = this.state.tour?.flow; if (flow) this.navigator?.fitNodes(flow.stops.flatMap(stop => stop.node ? [stop.node] : [])); }
  setTourFollow(follow: boolean): void { this.setTour({ follow }); }
  /** The lanes of a request flow (the theater over the map). Its entities are placed in the scene. */
  async openRequestFlow(id: string): Promise<void> {
    const signal = this.abortable('request-flow');
    const viewStamp = this.viewStamp();
    this.set(state => ({ requests: { open: { id, status: 'loading', viewStamp, playing: state.requests.open?.playing ?? true } } }));
    try {
      const data = await this.api.requestFlow(id, signal);
      if (signal.aborted) return;
      for (const node of data.nodes) if (node.node) this.scene.upsert(node.node);
      this.set(state => state.requests.open?.id === id ? { requests: { open: { ...state.requests.open, status: 'ready', data, viewStamp } } } : {});
      this.bumpScene();
    } catch (error) { if (!isAbort(error)) this.set(state => state.requests.open?.id === id ? { requests: { open: { ...state.requests.open, status: 'error', error: error instanceof Error ? error.message : String(error) } } } : {}); }
  }
  closeRequestFlow(): void { this.aborts.get('request-flow')?.abort(); this.set({ requests: {} }); }
  focusRequestNode(id: string | undefined): void { this.set(state => state.requests.open ? { requests: { open: { ...state.requests.open, focus: id } } } : {}); }
  toggleRequestFlowPlaying(): void { this.set(state => state.requests.open ? { requests: { open: { ...state.requests.open, playing: !state.requests.open.playing } } } : {}); }
  /** Leave the lanes for the same flow on the map. */
  traceRequestFlow(options: { play?: boolean } = {}): void {
    const open = this.state.requests.open;
    if (!open) return;
    const data = open.data;
    this.set({ requests: {} });
    void this.openTour({ id: open.id, detail: 'lanes', title: data ? (data.kind === 'command' || data.kind === 'schedule' ? data.name : `${data.method} ${data.path}`) : 'Request flow', ...(data?.handler ? { subtitle: `handled by ${data.handler}` } : {}) }, options);
  }
  /** Show or hide the coverage lens: files colored by whether flows touch them. */
  async toggleCoverage(show = !this.state.coverage.show): Promise<void> {
    // Coverage and data families both color files: one at a time.
    this.set(state => ({ coverage: { ...state.coverage, show }, ...(show && state.families.show ? { families: { ...state.families, show: false, focus: undefined } } : {}) }));
    if (show && (this.state.coverage.status !== 'ready' || this.state.coverage.viewStamp !== this.viewStamp())) await this.loadCoverage();
  }
  async loadCoverage(): Promise<void> {
    const signal = this.abortable('coverage');
    const viewStamp = this.viewStamp();
    this.set(state => ({ coverage: { ...state.coverage, status: 'loading', error: undefined } }));
    try {
      const data = await this.api.coverage(signal);
      if (signal.aborted) return;
      this.set(state => ({ coverage: { ...state.coverage, status: 'ready', data, viewStamp } }));
    } catch (error) { if (!isAbort(error)) this.set(state => ({ coverage: { ...state.coverage, status: 'error', error: error instanceof Error ? error.message : String(error) } })); }
  }
  /** Show or hide data families: files colored by the tables they use (or the code they use does). */
  async toggleFamilies(show = !this.state.families.show): Promise<void> {
    this.set(state => ({ families: { ...state.families, show, ...(show ? {} : { focus: undefined }) }, ...(show && state.coverage.show ? { coverage: { ...state.coverage, show: false } } : {}) }));
    if (show && (this.state.families.status !== 'ready' || this.state.families.viewStamp !== this.viewStamp())) await this.loadFamilies();
  }
  async loadFamilies(): Promise<void> {
    const signal = this.abortable('families');
    const viewStamp = this.viewStamp();
    this.set(state => ({ families: { ...state.families, status: 'loading', error: undefined } }));
    try {
      const data = await this.api.families(signal);
      if (signal.aborted) return;
      // A family that no longer exists in this view is no longer lit.
      this.set(state => ({ families: { ...state.families, status: 'ready', data, viewStamp, ...(state.families.focus && !data.families.some(family => family.key === state.families.focus) ? { focus: undefined } : {}) } }));
    } catch (error) { if (!isAbort(error)) this.set(state => ({ families: { ...state.families, status: 'error', error: error instanceof Error ? error.message : String(error) } })); }
  }
  /** Light one family on the map (again: none); the colors are shown if they were not. */
  focusFamily(key: string | undefined): void {
    this.set(state => ({ families: { ...state.families, focus: key === undefined || state.families.focus === key ? undefined : key } }));
    if (key && !this.state.families.show) void this.toggleFamilies(true);
  }
}
/** How a catalog flow is shown on the map, and its title. */
export function tourEntry(item: FlowSummary): { id: string; detail: 'lanes' | 'steps'; title: string; subtitle?: string; kind: CatalogKind } {
  const technical = item.kind === 'command' || item.kind === 'schedule' || item.detail === 'steps' ? item.name : `${item.method ?? ''} ${item.path ?? item.name}`.trim();
  const context = item.kind === 'schedule' ? item.cadence : item.kind === 'command' ? (item.handler ? `runs ${item.handler}` : undefined) : item.detail === 'steps' ? 'page' : item.handler ? `handled by ${item.handler}` : undefined;
  // A title the models gave reads first; the technical name stays beside it.
  const subtitle = item.title ? [technical, context].filter(Boolean).join(' · ') : context;
  return { id: item.id, detail: item.detail, title: item.title ?? technical, ...(subtitle ? { subtitle } : {}), kind: item.kind };
}
