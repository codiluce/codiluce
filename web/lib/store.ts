// Framework-agnostic application state. React panels subscribe through
// useSyncExternalStore; the canvas controller subscribes directly. Each
// concern owns an AbortController so rapid navigation cancels stale requests.
//
// History: the store owns which snapshot is viewed (and which baseline it is
// compared with). Changing the view swaps in a new scene that is prefetched
// for the containers currently open, so the camera and the user's place on
// the map are kept; a view epoch drops responses that belong to an old view.
import type { Entity, Relation } from '@engine/core/graph';
import type { AggregateEdgesPage, AggregateGroup, AggregateResult, ChangesPage, DiagnosticsPage, EntityChangeDetail, EntityHistoryResponse, ImpactItem, ImpactResult, LocateResult, NodeSummary, ProjectionMeta, RelationItem, SourceDiffResponse, SourceRequest, SourceResponse, StepsResult, TimelineEntry, TimelineResponse, ViewKey } from '@engine/projection/dto';
import { isAbort, type AtlasApi, type FlowsList } from './api';
import { draftFlow, FlowConflict, flowStorageKey, localFlowPersistence, moveItem, readLocalFlows, removeAt, removeFlow, replaceFlow, serverFlowPersistence, validateFlowName, type FlowPersistence, type StoredFlow } from './flows';
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
}
export interface FlowDraft {
  id?: string; name: string; entityIds: string[]; error?: string;
  /** `static`: the steps are a path found over indexed relationships (until edited). */
  type?: 'declared' | 'static';
  /** Building from a path: its two ends, and the search state. */
  path?: { from?: string; to?: string; status: Status; notice?: string };
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
export interface ResolvedFlow { flowId: string; steps: { entityId: string; node?: NodeSummary; ancestors: string[]; missing: boolean }[]; links: RelationItem[][]; status: Status; error?: string }
export interface FlowsState {
  flows: StoredFlow[]; draft?: FlowDraft; activeId?: string; resolved?: ResolvedFlow; playback: PlaybackState; storageError?: string;
  /** Where flows are kept: the server's flow store, or this browser only. */
  storage?: 'server' | 'browser';
  /** False when flows can be shown but not changed (a read-only server). */
  writable: boolean;
  /** What happened to where flows are kept (moved from this browser to the server, server read-only…). */
  notice?: string;
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
  flows: FlowsState;
  staleIndex: boolean;
  sceneRevision: number;
  impact: ImpactState;
  commitImpact: CommitImpactState;
  steps?: StepsState;
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
  now?: () => string;
  newId?: () => string;
  flowPersistence?: (repositoryId: string) => FlowPersistence;
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
  private persistence?: FlowPersistence;
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

  constructor(readonly api: AtlasApi, private readonly options: StoreOptions = {}) {
    let prefs: { themeId?: string; showDiagnostics?: boolean; dimUnchanged?: boolean } = {};
    try { prefs = JSON.parse(options.storage?.getItem('archipelago:prefs') ?? '{}'); } catch { /* defaults */ }
    this.state = {
      status: 'loading', view: { level: 'Applications', focus: [], zoom: 1, visible: [], truncated: false },
      relations: EMPTY_RELATIONS, aggregate: { status: 'idle' }, diagnostics: { status: 'idle' },
      history: { entries: [], index: -1 }, showDiagnostics: prefs.showDiagnostics ?? true, themeId: prefs.themeId ?? 'midnight',
      flows: { flows: [], playback: initialPlayback(), writable: true }, staleIndex: false, sceneRevision: 0,
      impact: { open: false, status: 'idle', depth: 4, filter: {}, items: [] }, commitImpact: { status: 'idle', show: false },
      timeline: { open: false, status: 'idle', compare: true, pinned: false, dimUnchanged: prefs.dimUnchanged ?? true, switching: false, changes: EMPTY_CHANGES, evolution: { status: 'idle' }, playing: false, speed: 1, follow: true },
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
    try { this.options.storage?.setItem('archipelago:prefs', JSON.stringify({ themeId: this.state.themeId, showDiagnostics: this.state.showDiagnostics, dimUnchanged: this.state.timeline.dimUnchanged })); } catch { /* preferences are optional */ }
  }
  dispose(): void { this.disposed = true; for (const controller of this.aborts.values()) controller.abort(); if (this.pollTimer) clearInterval(this.pollTimer); if (this.timelineTimer) clearTimeout(this.timelineTimer); }

  async init(): Promise<void> {
    this.set({ status: 'loading', error: undefined });
    const epoch = this.epoch;
    try {
      const meta = await this.api.meta();
      const opened = await this.openFlows(meta.run.repositoryId);
      this.persistence = opened.persistence;
      const flows: Partial<FlowsState> = { flows: opened.flows, storage: opened.persistence.kind, writable: opened.persistence.writable, notice: opened.notice, storageError: opened.error };
      // History was opened while the live map loaded: that view transition owns the scene and meta now.
      if (epoch !== this.epoch) { this.set(state => ({ status: 'ready', flows: { ...state.flows, ...flows } })); return; }
      this.scene.reset(meta.root);
      this.set({ meta, status: 'ready', staleIndex: false, flows: { ...this.state.flows, ...flows } });
      await this.loadChildren([meta.root.id]);
      const hash = this.options.location?.hash ?? '';
      const param = (name: string) => { const value = new RegExp(`(?:^#|&)${name}=([^&]+)`).exec(hash)?.[1]; return value ? decodeURIComponent(value) : undefined; };
      const deepLink = param('id'), at = param('at'), vs = param('vs');
      if ((at || vs) && meta.history.available) await this.openTimeline({ at, vs, select: deepLink });
      else if (deepLink) await this.select(deepLink, { fly: true });
      const impactDepth = Number(param('impact'));
      if (deepLink && this.state.selection && Number.isInteger(impactDepth) && impactDepth >= 1 && impactDepth <= 10) void this.showImpact(this.state.selection.id, impactDepth);
      if (this.state.flows.activeId) await this.activateFlow(this.state.flows.activeId);
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
  async select(id: string, options: { fly?: boolean; recordHistory?: boolean; mode?: 'focus' | 'enter' } = {}): Promise<void> {
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
      ]);
    } catch (error) {
      if (isAbort(error)) return;
      this.set(state => state.selection?.id === id ? { selection: { ...state.selection, entityStatus: 'error', error: error instanceof Error ? error.message : String(error) } } : {});
    }
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
      const page = await this.api.relations(id, { type: current.type, direction: current.direction === 'both' ? undefined : current.direction, offset: append ? current.items.length : 0, limit: 100 }, signal);
      this.set(state => state.selection?.id === id ? { relations: { ...state.relations, status: 'ready', forId: id, items: append ? [...state.relations.items, ...page.items] : page.items, typeCounts: page.typeCounts, total: page.total, hasMore: page.hasMore } } : {});
      if (!signal?.aborted) for (const item of page.items) this.scene.upsert(item.other);
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
    if (!timeline.open) return {};
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
    for (const key of ['selection', 'relations-more', 'drill', 'evidence', 'flow', 'changes']) this.aborts.get(key)?.abort();
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
      if (meta.comparison) void this.loadChanges();
      if (select) {
        const resolved = await this.api.resolve(select, previousSnapshot !== meta.snapshot.id ? previousSnapshot : undefined, signal);
        if (epoch !== this.epoch) return;
        if (resolved) await this.select(resolved.id, { fly, recordHistory: false });
        else { this.set({ selection: undefined }); this.setTimeline({ notice: 'The selected entity does not exist in this snapshot.' }); this.writeHash(undefined); }
      }
      if (this.state.flows.activeId) await this.activateFlow(this.state.flows.activeId);
    } catch (error) {
      if (isAbort(error) || epoch !== this.epoch) return;
      this.setTimeline({ switching: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  // Flows ------------------------------------------------------------------
  private setFlows(patch: Partial<FlowsState>): void { this.set(state => ({ flows: { ...state.flows, ...patch } })); }
  /**
   * Where flows are kept: the server's flow store when it accepts them (flows
   * an earlier version kept in this browser move there once), otherwise this
   * browser. A read-only server's flows are shown, not changed.
   */
  private async openFlows(repositoryId: string): Promise<{ persistence: FlowPersistence; flows: StoredFlow[]; notice?: string; error?: string }> {
    const load = async (persistence: FlowPersistence, notice?: string) => {
      try { return { persistence, flows: await persistence.list(), ...(notice ? { notice } : {}) }; }
      catch (error) { return { persistence, flows: [], error: error instanceof Error ? error.message : String(error) }; }
    };
    if (this.options.flowPersistence) return load(this.options.flowPersistence(repositoryId));
    const local = localFlowPersistence(this.options.storage, repositoryId);
    let remote: FlowsList;
    try { remote = await this.api.flows(); }
    catch { return load(local, 'This server does not store flows: they are saved in this browser only.'); }
    if (!remote.writable) {
      if (remote.flows.length) return { persistence: serverFlowPersistence(this.api, false), flows: remote.flows, notice: 'This server is read-only: its flows can be shown and played, not changed.' };
      return load(local, 'This server is read-only: flows are saved in this browser only.');
    }
    const server = serverFlowPersistence(this.api, true);
    const pending = readLocalFlows(this.options.storage, repositoryId);
    if (!pending.length) return { persistence: server, flows: remote.flows };
    try {
      const result = await this.api.importFlows(pending);
      const failed = result.skipped.filter(item => item.reason !== 'already stored');
      // Flows the server could not take stay in this browser's storage.
      if (!failed.length) { try { if (this.options.storage?.removeItem) this.options.storage.removeItem(flowStorageKey(repositoryId)); else this.options.storage?.setItem(flowStorageKey(repositoryId), '[]'); } catch { /* nothing left to clear */ } }
      const moved = result.imported.length;
      return load(server, `${moved ? `${moved} flow${moved === 1 ? '' : 's'} saved in this browser moved to the server.` : ''}${failed.length ? ` ${failed.length} could not be moved (${failed.map(item => `${item.name ?? item.id}: ${item.reason}`).join('; ')}) and stay in this browser's storage.` : ''}`.trim() || undefined);
    } catch (error) {
      return { persistence: server, flows: remote.flows, notice: `Flows saved in this browser could not be moved to the server (${error instanceof Error ? error.message : String(error)}); they stay in this browser's storage.` };
    }
  }
  /** Re-read stored flows (another tab or person may have changed them). */
  async refreshFlows(): Promise<void> {
    if (!this.persistence) return;
    try { this.setFlows({ flows: await this.persistence.list(), storageError: undefined }); }
    catch (error) { this.setFlows({ storageError: error instanceof Error ? error.message : String(error) }); }
  }
  startDraft(): void { this.setFlows({ draft: { name: '', entityIds: [] } }); }
  editFlow(id: string): void { const flow = this.state.flows.flows.find(item => item.id === id); if (flow) this.setFlows({ draft: { id, name: flow.name, entityIds: flow.steps.map(step => step.entityId), type: flow.type } }); }
  cancelDraft(): void { this.setFlows({ draft: undefined }); }
  setDraftName(name: string): void { const draft = this.state.flows.draft; if (draft) this.setFlows({ draft: { ...draft, name, error: undefined } }); }
  addDraftStep(entityId: string): void {
    const draft = this.state.flows.draft;
    if (!draft || entityId.startsWith('projection:')) return;
    this.setFlows({ draft: { ...draft, entityIds: [...draft.entityIds, entityId], error: undefined, type: 'declared' } });
  }
  moveDraftStep(from: number, to: number): void { const draft = this.state.flows.draft; if (draft) this.setFlows({ draft: { ...draft, entityIds: moveItem(draft.entityIds, from, to), type: 'declared' } }); }
  removeDraftStep(index: number): void { const draft = this.state.flows.draft; if (draft) this.setFlows({ draft: { ...draft, entityIds: removeAt(draft.entityIds, index), type: 'declared' } }); }
  /** Set one end of a path to build the draft from (the current selection by default). */
  setPathEnd(end: 'from' | 'to', id = this.state.selection?.id): void {
    const draft = this.state.flows.draft;
    if (!draft || !id || id.startsWith('projection:')) return;
    this.setFlows({ draft: { ...draft, path: { status: 'idle', ...draft.path, [end]: id, notice: undefined } } });
  }
  /** Fill the draft with the shortest path of indexed relationships between the two ends (a static flow). */
  async draftPath(): Promise<void> {
    const draft = this.state.flows.draft;
    const from = draft?.path?.from, to = draft?.path?.to;
    if (!draft || !from || !to) return;
    const signal = this.abortable('path');
    this.setFlows({ draft: { ...draft, path: { ...draft.path!, status: 'loading', notice: undefined } } });
    try {
      const result = await this.api.path(from, to, signal);
      const current = this.state.flows.draft;
      if (signal.aborted || !current) return;
      if (!result.found) { this.setFlows({ draft: { ...current, path: { ...current.path!, status: 'ready', notice: 'No chain of indexed relationships connects these two entities, in either direction.' } } }); return; }
      for (const node of result.nodes) this.scene.upsert(node);
      const first = result.nodes[0]!, last = result.nodes.at(-1)!;
      this.setFlows({ draft: { ...current, entityIds: result.nodes.map(node => node.id), type: 'static', name: current.name || `${first.name} → ${last.name}`.slice(0, 80), error: undefined, path: { ...current.path!, status: 'ready', notice: result.reversed ? 'Only the opposite direction is connected, so the path runs from the end you picked to the start.' : undefined } } });
    } catch (error) { if (!isAbort(error)) { const current = this.state.flows.draft; if (current) this.setFlows({ draft: { ...current, path: { ...current.path!, status: 'error', notice: error instanceof Error ? error.message : String(error) } } }); } }
  }
  async saveDraft(): Promise<boolean> {
    const draft = this.state.flows.draft;
    if (!draft || !this.persistence) return false;
    const error = validateFlowName(draft.name, this.state.flows.flows, draft.id) ?? (draft.entityIds.length < 2 ? 'Add at least two steps' : undefined);
    if (error) { this.setFlows({ draft: { ...draft, error } }); return false; }
    const { flow, isNew } = draftFlow(this.state.flows.flows, draft, this.options.now?.() ?? new Date().toISOString(), this.options.newId ?? (() => crypto.randomUUID()));
    try {
      const saved = await this.persistence.save(flow, isNew);
      this.setFlows({ flows: replaceFlow(this.state.flows.flows, saved), draft: undefined, storageError: undefined });
      await this.activateFlow(saved.id);
      return true;
    } catch (failure) {
      if (failure instanceof FlowConflict) {
        // Show what is stored now; saving again replaces it with this draft (or stores it anew if it was deleted).
        const flows = await this.persistence.list().catch(() => this.state.flows.flows);
        const current = this.state.flows.draft;
        this.setFlows({ flows, ...(current ? { draft: { ...current, ...(failure.current ? {} : { id: undefined }), error: failure.current ? 'This flow was changed elsewhere since you opened it; the stored version is now in the list. Save again to replace it with yours.' : 'This flow was deleted elsewhere. Save again to store yours as a new flow.' } } : {}) });
      } else this.setFlows({ storageError: failure instanceof Error ? failure.message : String(failure) });
      return false;
    }
  }
  async deleteFlow(id: string): Promise<void> {
    if (this.state.flows.activeId === id) this.deactivateFlow();
    try { await this.persistence?.remove(id); this.setFlows({ flows: removeFlow(this.state.flows.flows, id), storageError: undefined }); }
    catch (error) { this.setFlows({ storageError: error instanceof Error ? error.message : String(error) }); }
  }
  async activateFlow(id: string): Promise<void> {
    const flow = this.state.flows.flows.find(item => item.id === id);
    if (!flow) return;
    const signal = this.abortable('flow');
    const ids = flow.steps.map(step => step.entityId);
    this.setFlows({ activeId: id, resolved: { flowId: id, steps: ids.map(entityId => ({ entityId, ancestors: [], missing: false })), links: [], status: 'loading' }, playback: initialPlayback() });
    try {
      const unique = [...new Set(ids)];
      const { items } = await this.api.nodes(unique, signal);
      const byId = new Map(items.map(item => [item.id, item]));
      const located = await Promise.all(items.map(item => this.api.locate(item.id, signal)));
      const ancestors = new Map(located.map(item => [item.node.id, item.spatialAncestors.map(node => node.id)]));
      for (const item of located) this.place(item);
      // A link is shown as a graph relationship only when one actually connects the two steps.
      const links = await Promise.all(ids.slice(0, -1).map((a, i) => byId.has(a) && byId.has(ids[i + 1]!) ? this.api.between(a, ids[i + 1]!, signal).then(result => result.items) : Promise.resolve([] as RelationItem[])));
      if (signal.aborted) return;
      const steps = ids.map(entityId => ({ entityId, node: byId.get(entityId), ancestors: ancestors.get(entityId) ?? [], missing: !byId.has(entityId) }));
      this.setFlows({ resolved: { flowId: id, steps, links, status: 'ready' }, playback: initialPlayback(steps.map(step => step.missing)) });
      const first = steps.find(step => step.node);
      if (first?.node) this.navigator?.flyTo(first.node);
    } catch (error) {
      if (!isAbort(error)) this.setFlows({ resolved: { flowId: id, steps: [], links: [], status: 'error', error: error instanceof Error ? error.message : String(error) } });
    }
  }
  deactivateFlow(): void { this.aborts.get('flow')?.abort(); this.setFlows({ activeId: undefined, resolved: undefined, playback: initialPlayback() }); }
  playbackAction(action: PlaybackAction): void {
    const before = this.state.flows.playback;
    const after = playback(before, action);
    if (after === before) return;
    this.setFlows({ playback: after });
    if (after.index !== before.index || (action.type === 'restart')) {
      const step = this.state.flows.resolved?.steps[after.index];
      if (step?.node && action.type !== 'tick') void this.select(step.entityId, { fly: true, recordHistory: false });
      else if (step?.node) { this.navigator?.flyTo(step.node); void this.select(step.entityId, { fly: false, recordHistory: false }); }
    }
  }

  // Blast radius and steps ----------------------------------------------------
  /** Identity of the current view, to tell whether loaded results still belong to it. */
  viewStamp(): string { const meta = this.state.meta; return `${meta?.snapshot.id ?? ''}|${meta?.comparison?.baseline.id ?? ''}`; }
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
}
