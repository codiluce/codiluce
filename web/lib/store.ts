// Framework-agnostic application state. React panels subscribe through
// useSyncExternalStore; the canvas controller subscribes directly. Each
// concern owns an AbortController so rapid navigation cancels stale requests.
import type { Entity, Relation } from '@engine/core/graph';
import type { AggregateEdgesPage, AggregateGroup, AggregateResult, DiagnosticsPage, LocateResult, NodeSummary, ProjectionMeta, RelationItem, SourceRequest, SourceResponse } from '@engine/projection/dto';
import { isAbort, type AtlasApi } from './api';
import { localFlowPersistence, moveItem, removeAt, removeFlow, upsertFlow, validateFlowName, type FlowPersistence, type StoredFlow } from './flows';
import type { Level } from './lod';
import { initialPlayback, playback, type PlaybackAction, type PlaybackState } from './playback';
import { Scene } from './scene';

export const CHILD_PAGE = 500;
/** Children beyond this many per container are not fetched; the inspector says so. */
export const CHILD_CAP = 3000;
type Status = 'idle' | 'loading' | 'ready' | 'error';
export interface SelectionState {
  id: string; node?: NodeSummary; locate?: LocateResult;
  entity?: Entity; entityStatus: Status; error?: string;
  /** Containing file details, used for file-level metadata about this symbol (e.g. HTTP calls). */
  file?: Entity;
}
export interface RelationsState { status: Status; forId?: string; items: RelationItem[]; typeCounts: { type: string; direction: string; count: number }[]; total: number; hasMore: boolean; type?: string; direction: 'both' | 'outgoing' | 'incoming'; error?: string }
export interface AggregateState { status: Status; forId?: string; data?: AggregateResult; error?: string; drill?: { group: AggregateGroup; status: Status; page?: AggregateEdgesPage; items: AggregateEdgesPage['items']; error?: string } }
export interface DiagnosticsState { status: Status; forId?: string; data?: DiagnosticsPage; error?: string }
export interface EvidenceState { relationId: string; context?: { from: string; to: string; type: string }; status: Status; relation?: Relation; error?: string }
export interface SourceState { request: SourceRequest; title: string; status: Status; data?: SourceResponse; error?: string }
export interface FlowDraft { id?: string; name: string; entityIds: string[]; error?: string }
export interface ResolvedFlow { flowId: string; steps: { entityId: string; node?: NodeSummary; ancestors: string[]; missing: boolean }[]; links: RelationItem[][]; status: Status; error?: string }
export interface FlowsState { flows: StoredFlow[]; draft?: FlowDraft; activeId?: string; resolved?: ResolvedFlow; playback: PlaybackState; storageError?: string }
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
  history: { entries: string[]; index: number };
  showDiagnostics: boolean;
  themeId: string;
  flows: FlowsState;
  staleIndex: boolean;
  sceneRevision: number;
}
export interface MapNavigator {
  flyTo(node: NodeSummary, options?: { mode?: 'focus' | 'enter' }): void;
  /** Fit several nodes (e.g. a selection and its related endpoints) into view. */
  fitNodes(nodes: NodeSummary[]): void;
  fitAll(): void;
  zoomBy(factor: number): void;
}
export interface StoreOptions {
  storage?: Pick<Storage, 'getItem' | 'setItem'>;
  now?: () => string;
  newId?: () => string;
  flowPersistence?: (repositoryId: string) => FlowPersistence;
  location?: { hash: string; replace(hash: string): void };
}
const EMPTY_RELATIONS: RelationsState = { status: 'idle', items: [], typeCounts: [], total: 0, hasMore: false, direction: 'both' };
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
  readonly scene = new Scene();
  navigator?: MapNavigator;
  /** Set by the map: whether a node is drawn at the current level of detail. */
  visibility?: (id: string) => boolean;

  constructor(readonly api: AtlasApi, private readonly options: StoreOptions = {}) {
    let prefs: { themeId?: string; showDiagnostics?: boolean } = {};
    try { prefs = JSON.parse(options.storage?.getItem('archipelago:prefs') ?? '{}'); } catch { /* defaults */ }
    this.state = {
      status: 'loading', view: { level: 'Applications', focus: [], zoom: 1, visible: [], truncated: false },
      relations: EMPTY_RELATIONS, aggregate: { status: 'idle' }, diagnostics: { status: 'idle' },
      history: { entries: [], index: -1 }, showDiagnostics: prefs.showDiagnostics ?? true, themeId: prefs.themeId ?? 'midnight',
      flows: { flows: [], playback: initialPlayback() }, staleIndex: false, sceneRevision: 0,
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
    try { this.options.storage?.setItem('archipelago:prefs', JSON.stringify({ themeId: this.state.themeId, showDiagnostics: this.state.showDiagnostics })); } catch { /* preferences are optional */ }
  }
  dispose(): void { for (const controller of this.aborts.values()) controller.abort(); if (this.pollTimer) clearInterval(this.pollTimer); }

  async init(): Promise<void> {
    this.set({ status: 'loading', error: undefined });
    try {
      const meta = await this.api.meta();
      this.scene.reset(meta.root);
      this.persistence = (this.options.flowPersistence ?? (id => localFlowPersistence(this.options.storage, id)))(meta.run.repositoryId);
      this.set({ meta, status: 'ready', staleIndex: false, flows: { ...this.state.flows, flows: this.persistence.load() } });
      await this.loadChildren([meta.root.id]);
      const deepLink = /(?:^#|&)id=([^&]+)/.exec(this.options.location?.hash ?? '')?.[1];
      if (deepLink) await this.select(decodeURIComponent(deepLink), { fly: true });
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
    await Promise.all(ids.slice(0, 6).map(async id => {
      const list = this.scene.childList(id);
      if (this.childLoads.has(id) || list.complete || list.loadedPages * CHILD_PAGE >= CHILD_CAP) return;
      this.childLoads.add(id);
      this.scene.setLoading(id, true);
      try {
        const page = await this.api.children(id, list.loadedPages * CHILD_PAGE, CHILD_PAGE);
        this.scene.addChildren(id, page.items, page.total, page.hasMore && (list.loadedPages + 1) * CHILD_PAGE < CHILD_CAP);
      } catch (error) {
        this.scene.setLoading(id, false, error instanceof Error ? error.message : String(error));
      } finally { this.childLoads.delete(id); this.bumpScene(); }
    }));
  }
  /** Make an entity reachable in the scene by inserting its spatial ancestor chain. */
  private place(located: LocateResult): void {
    for (const ancestor of located.spatialAncestors) this.scene.upsert(ancestor);
    this.scene.upsert(located.node);
    this.bumpScene();
  }
  async select(id: string, options: { fly?: boolean; recordHistory?: boolean; mode?: 'focus' | 'enter' } = {}): Promise<void> {
    const signal = this.abortable('selection');
    const known = this.scene.nodes.get(id);
    this.set(state => ({
      selection: { id, node: known, entityStatus: 'loading' },
      evidence: undefined,
      history: options.recordHistory === false || state.history.entries[state.history.index] === id ? state.history : { entries: [...state.history.entries.slice(0, state.history.index + 1), id].slice(-100), index: Math.min(state.history.index + 1, 99) },
    }));
    this.options.location?.replace(`#id=${encodeURIComponent(id)}`);
    try {
      const located = await this.api.locate(id, signal);
      if (signal.aborted) return;
      this.place(located);
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
      ]);
    } catch (error) {
      if (isAbort(error)) return;
      this.set(state => state.selection?.id === id ? { selection: { ...state.selection, entityStatus: 'error', error: error instanceof Error ? error.message : String(error) } } : {});
    }
  }
  clearSelection(): void {
    this.aborts.get('selection')?.abort();
    this.set({ selection: undefined, relations: EMPTY_RELATIONS, aggregate: { status: 'idle' }, diagnostics: { status: 'idle' }, evidence: undefined });
    this.options.location?.replace('#');
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
      for (const item of page.items) this.scene.upsert(item.other);
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
    this.set({ source: { request, title, status: 'loading', data: this.state.source?.data } });
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
  closeSource(): void { this.aborts.get('source')?.abort(); this.set({ source: undefined }); }
  toggleDiagnostics(): void { this.set(state => ({ showDiagnostics: !state.showDiagnostics })); this.savePrefs(); }
  setTheme(themeId: string): void { this.set({ themeId }); this.savePrefs(); }

  // Flows ------------------------------------------------------------------
  private setFlows(patch: Partial<FlowsState>): void { this.set(state => ({ flows: { ...state.flows, ...patch } })); }
  private persist(flows: StoredFlow[]): boolean {
    try { this.persistence?.save(flows); this.setFlows({ flows, storageError: undefined }); return true; }
    catch (error) { this.setFlows({ storageError: error instanceof Error ? error.message : String(error) }); return false; }
  }
  startDraft(): void { this.setFlows({ draft: { name: '', entityIds: [] } }); }
  editFlow(id: string): void { const flow = this.state.flows.flows.find(item => item.id === id); if (flow) this.setFlows({ draft: { id, name: flow.name, entityIds: flow.steps.map(step => step.entityId) } }); }
  cancelDraft(): void { this.setFlows({ draft: undefined }); }
  setDraftName(name: string): void { const draft = this.state.flows.draft; if (draft) this.setFlows({ draft: { ...draft, name, error: undefined } }); }
  addDraftStep(entityId: string): void {
    const draft = this.state.flows.draft;
    if (!draft || entityId.startsWith('projection:')) return;
    this.setFlows({ draft: { ...draft, entityIds: [...draft.entityIds, entityId], error: undefined } });
  }
  moveDraftStep(from: number, to: number): void { const draft = this.state.flows.draft; if (draft) this.setFlows({ draft: { ...draft, entityIds: moveItem(draft.entityIds, from, to) } }); }
  removeDraftStep(index: number): void { const draft = this.state.flows.draft; if (draft) this.setFlows({ draft: { ...draft, entityIds: removeAt(draft.entityIds, index) } }); }
  async saveDraft(): Promise<boolean> {
    const draft = this.state.flows.draft;
    if (!draft) return false;
    const error = validateFlowName(draft.name, this.state.flows.flows, draft.id) ?? (draft.entityIds.length < 2 ? 'Add at least two steps' : undefined);
    if (error) { this.setFlows({ draft: { ...draft, error } }); return false; }
    const flows = upsertFlow(this.state.flows.flows, draft, this.options.now?.() ?? new Date().toISOString(), this.options.newId ?? (() => crypto.randomUUID()));
    if (!this.persist(flows)) return false;
    const saved = draft.id ?? flows.at(-1)!.id;
    this.setFlows({ draft: undefined });
    await this.activateFlow(saved);
    return true;
  }
  deleteFlow(id: string): void {
    if (this.state.flows.activeId === id) this.deactivateFlow();
    this.persist(removeFlow(this.state.flows.flows, id));
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
}
