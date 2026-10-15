import type { ActivitySnapshot } from '@engine/activity/model';
// Framework-agnostic application state. React panels subscribe through
// useSyncExternalStore; the canvas controller subscribes directly. Each
// concern owns an AbortController so rapid navigation cancels stale requests.
//
// History: the store owns which snapshot is viewed (and which baseline it is
// compared with). Changing the view swaps in a new scene that is prefetched
// for the containers currently open, so the camera and the user's place on
// the map are kept; a view epoch drops responses that belong to an old view.
import type { MapVisibilityAction } from '@engine/projection/dto';
import type { Entity, Relation } from '@engine/core/graph';
import type { AggregateEdgesPage, AggregateGroup, AggregateResult, CatalogKind, ChangeRegionsResult, ChangesPage, RegionLevel, CoverageDetail, CoverageResult, DiagnosticsPage, EntityChangeDetail, EntityHistoryResponse, FlowList, FlowSummary, ImpactItem, ImpactResult, LocateResult, NodeSummary, ProjectionMeta, Rect, RelationItem, RequestFlow, SourceDiffResponse, SourceRequest, SourceResponse, StepsResult, TimelineEntry, TimelineResponse, ViewKey } from '@engine/projection/dto';
import type { AnnotationsOverview, AuthorshipResult, AuthorshipWindowKey, EntityAnnotation, EntityAuthorship, EntityPulls, FamiliesResult, FeaturesResult, FileListResult, FlowStatus, ImpactGroupBy, PersonAuthorship, PullDetail, PullsResult } from '@engine/projection/dto';
import type { CatalogTab } from './catalog';
import { fromRequestFlow, fromSteps, type MapFlow } from './map-flow';
import { isAbort, type AtlasApi } from './api';
import type { Level } from './lod';
import { Scene } from './scene';
import { Evolution } from './evolution';
import { DEFAULT_THEME } from './themes';
import type { AskEvent, ExplanationDetail, ExplanationList, ExplanationsSetup, ResolvedLink } from '@engine/explanations/model';
import type { EntityExplanations } from '@engine/explanations/service';
// A relative import: the store also runs under Node (web/tests), where the @engine alias is for types only.
import { chatQuestion, type PromptTarget } from '../../src/explanations/prompts';
import type { ExplanationsApi } from './explanations';

export const CHILD_PAGE = 500;
/** Entry points whose flow is drawn in lanes (requests, commands, scheduled tasks); other code that runs is drawn in layers. */
export const LANES_TYPES = new Set(['api_endpoint', 'command', 'scheduled_task']);
/** Children beyond this many per container are not fetched; the inspector says so. */
export const CHILD_CAP = 3000;
/** Lines of code read at a time in the Code tool (the server's bound). */
export const CODE_WINDOW = 400;
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
  /** Who changed it (the Git history), in the people window; `stamp` is the view and window of `data`. */
  authorship?: { status: Status; stamp?: string; data?: EntityAuthorship; error?: string };
  /** The explanations about it, linking it, or linking an area holding it. */
  explained?: { status: Status; data?: EntityExplanations; error?: string };
  /** The open pull requests changing it, and the latest merged in the people window. */
  pulls?: { status: Status; stamp?: string; data?: EntityPulls; error?: string };
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
/** The origin of a blast radius that is the uncommitted changes of the live index, not an entity. */
export const WORKING_CHANGES = 'working';
/** The prefix of a blast radius origin that is a pull request (`pull-request:<id>`), not an entity. */
export const PULL_ORIGIN = 'pull-request:';
/**
 * Blast radius of an entity (`forId`), or of the uncommitted changes
 * (`WORKING_CHANGES`). It stays on its origin while the selection moves; the
 * map colors it while `open`. `group` lists it by application, feature or folder.
 */
export interface ImpactState {
  open: boolean; status: Status; forId?: string;
  /** The view (snapshot|baseline) the data was computed for. */
  viewStamp?: string;
  depth: number; filter: { type?: string; distance?: number; groupKey?: string };
  group?: ImpactGroupBy;
  data?: ImpactResult; items: ImpactItem[]; error?: string;
}
/** What the middle of the screen shows: the map, or a tool with the map as a small overview in a corner. */
export type CenterView = 'map' | 'flow' | 'impact' | 'files';
/** A view of the flow open in the middle: the map, its lanes (or layers), its outline. */
export type FlowPane = 'map' | 'diagram' | 'outline';
/**
 * A flow open in the middle: one subject (a request, command, task, page or
 * any code that runs) on the map, as a diagram (`lanes`: in lanes, left to
 * right; otherwise in layers) and as an outline of steps, side by side.
 * `pane` gives one of them the whole middle.
 */
export interface FlowViewState { id: string; title: string; subtitle?: string; kind?: CatalogKind; lanes: boolean; pane?: FlowPane }
/** How a flow shares the middle: the outline's share of the width beside the map, the lanes' share of the height below both. */
export interface FlowSplit { side: number; bottom: number }
export const FLOW_SPLIT: FlowSplit = { side: 0.3, bottom: 0.42 };
/** How links are drawn on the map: arcs over the blocks, or rails along the floor, at right angles. */
export type Connections = 'arcs' | 'rails';
/** What a list of files is of: a feature, a data family, a coverage category or a person (the highlight on the map). */
export interface FileSubject { kind: 'feature' | 'family' | 'coverage' | 'person' | 'pull'; key: string }
export interface FilesState extends FileSubject { status: Status; stamp: string; data?: FileListResult; error?: string }
/**
 * The Code panel beside the inspector: the source of the selection (a file
 * whole, a symbol in its file with its lines marked), read in windows that
 * grow as you scroll; an area (a folder, an application, a district) lists
 * what it holds instead. It follows the selection while it is open. `stamp`
 * is the view and entity `data` was read for.
 */
export interface CodeState {
  forId?: string; node?: NodeSummary;
  status: Status; stamp?: string; data?: SourceResponse; error?: string;
  /** Reading further up or down the file. */
  more?: 'earlier' | 'later';
  /** The symbols of the file shown (two levels: a class and its members), for the outline. */
  outline?: { fileId: string; stamp: string; status: Status; items: (NodeSummary & { level: number })[] };
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
  /** Flow list groups the user opened (true) or closed (false); the others follow the list's default. */
  open: Record<string, boolean>;
}
/** Which files the flows touch, drawn as a lens over the map. */
export interface CoverageState { show: boolean; status: Status; viewStamp?: string; data?: CoverageResult; error?: string }
/** Data families drawn over the map: files colored by the tables they use; `focus` lights one family and dims the rest. */
export interface FamiliesState { show: boolean; status: Status; viewStamp?: string; data?: FamiliesResult; error?: string; focus?: string }
/** The key under which areas count code files that use no table (`focus` can light them too). */
export const NO_FAMILY = 'none';
/**
 * The product's features (the model's domains) in the Features panel: `focus`
 * lights one feature's files and dims the rest; `open` holds the expanded
 * branches of the tree (a feature, or its `key:flows` / `key:folders` lists).
 */
export interface FeaturesState { status: Status; viewStamp?: string; data?: FeaturesResult; error?: string; focus?: string; open: Record<string, boolean>; reveal?: number }
/**
 * Who changed which code (the Git history), in a window of time kept in the
 * preferences. The People panel lists them; `show` colors files by the person
 * who changed each most; `focus` lights one person's files and dims the rest,
 * with what they changed in `person`. `stamp` is the view and window of `data`.
 */
export interface PeopleState {
  window: AuthorshipWindowKey;
  show: boolean;
  status: Status; stamp?: string; data?: AuthorshipResult; error?: string;
  focus?: string;
  person?: { key: string; status: Status; stamp?: string; data?: PersonAuthorship; error?: string };
  /** People rows (and their `key:folders` / `key:commits` lists) expanded in the panel. */
  open: Record<string, boolean>;
  /** Incremented to ask the shell to show the People panel. */
  reveal?: number;
}
/**
 * Pull requests in the people window: merged into the branch up to the commit
 * shown, open now (pull requests and branches), closed. The Pull requests
 * panel lists one `tab` of them (`query` filters); `focus` lights the files
 * one changes and dims the rest, with what it changes in `pull`. `stamp` is
 * the view and window of `data`.
 */
export interface PullsState {
  status: Status; stamp?: string; data?: PullsResult; error?: string;
  tab: 'open' | 'merged' | 'closed';
  query: string;
  /** The provider is being asked again. */
  refreshing?: boolean;
  focus?: string;
  pull?: { id: string; status: Status; stamp?: string; data?: PullDetail; error?: string };
  /** Rows (and their `id:folders` / `id:commits` / `id:outside` lists) expanded in the panel. */
  open: Record<string, boolean>;
  /** Incremented to ask the shell to show the Pull requests panel. */
  reveal?: number;
}
/**
 * The flow open in the middle, on the map: everything it touches stays lit,
 * the rest dims, and its links stream from where they start to where they
 * lead. `branch` shows one branch on its own (an index into `flow.branches`);
 * every branch shows when it is unset.
 */
export interface TourState {
  key: string; id: string; detail: 'lanes' | 'steps';
  status: Status; error?: string; viewStamp: string;
  flow?: MapFlow;
  branch?: number;
}
/** A link in the composer: the code a question is about. */
export interface ContextChip { href: string; label: string }
/**
 * Explanations (text from language models whose links name code) in their
 * column: the list, the one open (its footprint lit on the map while `lens`),
 * the link the pointer is on, and the chat composing or streaming an answer.
 */
export interface ExplainState {
  open: boolean;
  list: { status: Status; data?: ExplanationList; error?: string };
  setup?: ExplanationsSetup;
  detail?: { id: string; status: Status; data?: ExplanationDetail; error?: string };
  lens: boolean;
  hover?: ResolvedLink;
  draft: { text: string; context: ContextChip[]; model?: string };
  asking?: { status: 'streaming' | 'error'; explanationId?: string; refresh?: boolean; question: string; context: ContextChip[]; text: string; tools: string[]; model?: string; note?: string; error?: string };
  /** Explanations an agent saved while the column was closed. */
  unseen: string[];
  /** Incremented to ask the shell to show the column. */
  reveal?: number;
}
export interface ViewState { level: Level; focus: { id: string; name: string; type: string }[]; zoom: number; visible: { id: string; name: string; type: string }[]; truncated: boolean }
export interface AtlasState {
  mapVisibility: { open: boolean; busy: boolean; error?: string; notice?: string; undo?: MapVisibilityAction };
  mapMenu?: { node: NodeSummary; x: number; y: number };
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
  /** Settings: the theme menu offers every theme, not only Dusk and Dawn. */
  moreThemes: boolean;
  /** Draw blocks as their archetype's shape (a controller a turntable, a table drums…) instead of plain boxes. */
  shapes: boolean;
  /** Draw blocks a little inside their places, with streets between them. */
  streets: boolean;
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
  families: FamiliesState;
  features: FeaturesState;
  people: PeopleState;
  pulls: PullsState;
  center: CenterView;
  flowView?: FlowViewState;
  flowSplit: FlowSplit;
  connections: Connections;
  files?: FilesState;
  code?: CodeState;
  agents: { connected: boolean; show: boolean; now: number; focus?: string; snapshot?: ActivitySnapshot };
  explain: ExplainState;
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
  /** Explanations and the chat (absent: the column stays empty). */
  explanations?: ExplanationsApi;
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
  private explainTimer?: ReturnType<typeof setInterval>;
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

  /** The address the page opened with: read once, as another store (React's development double mount) may rewrite it first. */
  private openingHash?: string;
  constructor(readonly api: AtlasApi, private readonly options: StoreOptions = {}) {
    this.openingHash = options.location?.hash;
    let prefs: { themeId?: string; moreThemes?: boolean; shapes?: boolean; streets?: boolean; showDiagnostics?: boolean; dimUnchanged?: boolean; split?: boolean; regionLevel?: RegionLevel; peopleWindow?: AuthorshipWindowKey; explainLens?: boolean; chatModel?: string; flowSplit?: FlowSplit; connections?: Connections } = {};
    try { prefs = JSON.parse(options.storage?.getItem('codiluce:prefs') ?? '{}'); } catch { /* defaults */ }
    this.state = {
      status: 'loading', view: { level: 'Applications', focus: [], zoom: 1, visible: [], truncated: false },
      relations: EMPTY_RELATIONS, aggregate: { status: 'idle' }, diagnostics: { status: 'idle' },
      history: { entries: [], index: -1 }, showDiagnostics: prefs.showDiagnostics ?? true, themeId: prefs.themeId ?? DEFAULT_THEME, moreThemes: prefs.moreThemes ?? false, shapes: prefs.shapes ?? true, streets: prefs.streets ?? true,
      staleIndex: false, sceneRevision: 0, mapVisibility: { open: false, busy: false },
      impact: { open: false, status: 'idle', depth: 4, filter: {}, items: [] }, commitImpact: { status: 'idle', show: false }, requests: {}, catalog: { status: 'idle', kind: 'all', query: '', open: {} }, coverage: { show: false, status: 'idle' }, annotations: { status: 'idle' }, families: { show: false, status: 'idle' }, features: { status: 'idle', open: {} },
      people: { window: prefs.peopleWindow ?? 'all', show: false, status: 'idle', open: {} }, pulls: { status: 'idle', tab: 'open', query: '', open: {} }, center: 'map',
      agents: { connected: false, show: true, now: Date.now() },
      explain: { open: false, list: { status: 'idle' }, lens: prefs.explainLens ?? true, draft: { text: '', context: [], ...(prefs.chatModel ? { model: prefs.chatModel } : {}) }, unseen: [] },
      flowSplit: clampSplit(prefs.flowSplit ?? FLOW_SPLIT), connections: prefs.connections === 'rails' ? 'rails' : 'arcs',
      timeline: { open: false, status: 'idle', compare: true, pinned: false, dimUnchanged: prefs.dimUnchanged ?? true, switching: false, changes: EMPTY_CHANGES, evolution: { status: 'idle' }, playing: false, speed: 1, follow: true, split: prefs.split ?? true, regionLevel: prefs.regionLevel ?? 'auto', regions: { status: 'idle' } },
    };
  }
  setActivity(patch: Partial<AtlasState['agents']>): void { this.set({ agents: { ...this.state.agents, ...patch } }); }
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
    try { this.options.storage?.setItem('codiluce:prefs', JSON.stringify({ themeId: this.state.themeId, moreThemes: this.state.moreThemes, shapes: this.state.shapes, streets: this.state.streets, flowSplit: this.state.flowSplit, connections: this.state.connections, showDiagnostics: this.state.showDiagnostics, dimUnchanged: this.state.timeline.dimUnchanged, split: this.state.timeline.split, regionLevel: this.state.timeline.regionLevel, peopleWindow: this.state.people.window, explainLens: this.state.explain.lens, ...(this.state.explain.draft.model ? { chatModel: this.state.explain.draft.model } : {}) })); } catch { /* preferences are optional */ }
  }
  dispose(): void { this.disposed = true; for (const controller of this.aborts.values()) controller.abort(); if (this.pollTimer) clearInterval(this.pollTimer); if (this.explainTimer) clearInterval(this.explainTimer); if (this.timelineTimer) clearTimeout(this.timelineTimer); }

  async init(): Promise<void> {
    this.set({ status: 'loading', error: undefined });
    const epoch = this.epoch;
    try {
      this.api.setView(this.viewKey());
      const meta = await this.api.meta();
      void this.loadAnnotations();
      // History was opened while the live map loaded: that view transition owns the scene and meta now.
      if (epoch !== this.epoch) { this.set({ status: 'ready' }); return; }
      this.scene.reset(meta.root);
      this.set({ meta, status: 'ready', staleIndex: false });
      await this.loadChildren([meta.root.id]);
      const hash = this.openingHash ?? this.options.location?.hash ?? '';
      this.openingHash = undefined;
      const param = (name: string) => { const value = new RegExp(`(?:^#|&)${name}=([^&]+)`).exec(hash)?.[1]; return value ? decodeURIComponent(value) : undefined; };
      const deepLink = param('id'), at = param('at'), vs = param('vs');
      if ((at || vs) && meta.history.available) await this.openTimeline({ at, vs, select: deepLink });
      else if (deepLink) await this.select(deepLink, { fly: true });
      const impactDepth = Number(param('impact')), impactOf = param('impactOf') ?? (this.state.selection ? deepLink : undefined);
      if (impactOf && Number.isInteger(impactDepth) && impactDepth >= 1 && impactDepth <= 10) void this.showImpact(impactOf, impactDepth);
      if (param('code')) this.openCode();
      const explain = param('explain');
      if (explain) void this.openExplanations(explain === 'list' ? {} : { id: explain });
      else void this.loadExplanations();
    } catch (error) {
      this.set({ status: 'error', error: error instanceof Error ? error.message : String(error) });
    }
  }
  /** Detect a newer analysis run without disturbing the current map. */
  startPolling(intervalMs = 30_000): void {
    if (this.explainTimer) clearInterval(this.explainTimer);
    // An agent may save an explanation at any time: the list is checked more often than the index.
    if (this.options.explanations) this.explainTimer = setInterval(() => void this.pollExplanations(), 6_000);
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = setInterval(async () => {
      try {
        const meta = await this.api.meta();
        if (this.state.meta && meta.run.id !== this.state.meta.run.id) this.set({ staleIndex: true });
        else if (!this.state.mapVisibility.busy && meta.mapVisibility?.revision !== this.state.meta?.mapVisibility?.revision) {
          this.set(state => ({ mapVisibility: { ...state.mapVisibility, busy: true, undo: undefined, notice: undefined } }));
          try { await this.refreshMapLayout(); }
          finally { this.set(state => ({ mapVisibility: { ...state.mapVisibility, busy: false } })); }
        }
      } catch { /* server may be restarting */ }
    }, intervalMs);
  }
  async reload(): Promise<void> {
    const selected = this.state.selection?.id;
    this.api.clear(); this.childLoads.clear(); this.clearMapEvolution();
    this.set({ selection: undefined, relations: EMPTY_RELATIONS, aggregate: { status: 'idle' }, diagnostics: { status: 'idle' }, evidence: undefined, source: undefined });
    await this.init();
    if (selected && !this.state.selection) await this.select(selected, { fly: false, recordHistory: false }).catch(() => undefined);
    // A new run is a new view: who changed it, and the pull requests on it, are read again.
    if (this.state.people.status !== 'idle') void this.loadPeople();
    if (this.state.people.focus) void this.loadPerson(this.state.people.focus);
    if (this.state.pulls.status !== 'idle') void this.loadPulls();
    if (this.state.pulls.focus) void this.loadPull(this.state.pulls.focus);
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
    try {
      const located = await this.api.locate(id, signal);
      if (signal.aborted) return;
      this.place(located, epoch);
      this.set(state => state.selection?.id === id ? { selection: { ...state.selection, node: located.node, locate: located } } : {});
      this.followCode();
      if (options.fly !== false && !located.node.hidden) this.navigator?.flyTo(located.node, { mode: options.mode ?? (isContainer(located.node) ? 'enter' : 'focus') });
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
        this.loadSelectionAuthorship(id, signal),
        this.loadSelectionExplanations(id, signal),
        this.loadSelectionPulls(id, signal),
      ]);
    } catch (error) {
      if (isAbort(error)) return;
      this.set(state => state.selection?.id === id ? { selection: { ...state.selection, entityStatus: 'error', error: error instanceof Error ? error.message : String(error) } } : {});
    }
  }
  clearSelection(): void {
    this.aborts.get('selection')?.abort();
    this.set({ selection: undefined, relations: EMPTY_RELATIONS, aggregate: { status: 'idle' }, diagnostics: { status: 'idle' }, evidence: undefined });
    this.writeHash(undefined);
  }
  /** `#id=…&at=…&vs=…`: the selection and, in history mode, the viewed and baseline commits. */
  private writeHash(id = this.state.selection?.id): void {
    const timeline = this.state.timeline;
    const parts: string[] = [];
    if (id) parts.push(`id=${encodeURIComponent(id)}`);
    const impact = this.state.impact;
    if (impact.open && impact.forId) { parts.push(`impact=${impact.depth}`); if (impact.forId !== id) parts.push(`impactOf=${encodeURIComponent(impact.forId)}`); }
    if (this.state.code) parts.push('code=1');
    const explain = this.state.explain;
    if (explain.open) parts.push(`explain=${encodeURIComponent(explain.detail?.id ?? 'list')}`);
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
  /** Settings: offer every theme in the theme menu (otherwise Dusk and Dawn, and the theme in use). */
  setMoreThemes(moreThemes: boolean): void { this.set({ moreThemes }); this.savePrefs(); }
  setShapes(shapes: boolean): void { this.set({ shapes }); this.savePrefs(); }
  setStreets(streets: boolean): void { this.set({ streets }); this.savePrefs(); }

  // Map visibility -----------------------------------------------------------
  openMapMenu(node: NodeSummary, x: number, y: number): void { this.set({ mapMenu: { node, x, y } }); }
  closeMapMenu(): void { this.set({ mapMenu: undefined }); }
  showHiddenPaths(open: boolean): void { this.set(state => ({ mapMenu: undefined, mapVisibility: { ...state.mapVisibility, open } })); }
  dismissMapNotice(): void { this.set(state => ({ mapVisibility: { ...state.mapVisibility, notice: undefined, undo: undefined, error: undefined } })); }
  async changeMapVisibility(action: MapVisibilityAction, notice = 'Map visibility updated.', recordUndo = true): Promise<void> {
    if (this.state.mapVisibility.busy) return;
    const previous = this.state.meta?.mapVisibility;
    this.set(state => ({ mapMenu: undefined, mapVisibility: { ...state.mapVisibility, busy: true, error: undefined } }));
    try {
      const result = await this.api.updateMapVisibility(action);
      this.set(state => ({ meta: state.meta && { ...state.meta, mapVisibility: result }, mapVisibility: { ...state.mapVisibility, notice, undo: recordUndo && previous ? { action: 'set-local', hidden: previous.hidden, revealed: previous.revealed, disabledShared: previous.disabledShared } : undefined }, timeline: { ...state.timeline, evolution: { status: 'idle' }, regions: { status: 'idle' } } }));
      await this.refreshMapLayout();
    } catch (error) { this.set(state => ({ mapVisibility: { ...state.mapVisibility, error: error instanceof Error ? error.message : String(error) } })); }
    finally { this.set(state => ({ mapVisibility: { ...state.mapVisibility, busy: false } })); }
  }
  private clearMapEvolution(): void {
    this.pause(false); this.clearPreview(); this.aborts.get('evolution')?.abort();
    this.evolution = undefined; this.evolutionLoad = undefined; this.evolutionKey = '';
    this.setTimeline({ evolution: { status: 'idle' }, regions: { status: 'idle' } });
  }
  private async refreshMapLayout(): Promise<void> {
    this.api.clear(); this.clearMapEvolution();
    await this.applyView();
    if (this.state.timeline.error) throw new Error(`Map preferences saved, but the map could not reload: ${this.state.timeline.error}`);
    this.navigator?.fitAll();
    if (this.state.timeline.open) void this.loadEvolution();
  }
  hideFromMap(node: NodeSummary): Promise<void> {
    if (!node.path || !['directory', 'file', 'application'].includes(node.type) || node.path === '.') return Promise.resolve();
    return this.changeMapVisibility({ action: 'hide', path: node.path }, `${node.path} hidden from the map.`);
  }
  async revealOnMap(node: NodeSummary): Promise<void> {
    if (!node.path || this.state.mapVisibility.busy) return;
    await this.changeMapVisibility({ action: 'reveal', path: node.path }, `${node.path} revealed on the map.`);
    if (!this.state.mapVisibility.error) await this.select(node.id, { fly: true });
  }
  async undoMapVisibility(): Promise<void> { const action = this.state.mapVisibility.undo; if (action) await this.changeMapVisibility(action, 'Map visibility restored.', false); }
  /** Draw the links on the map as arcs over the blocks or as rails along the floor. */
  setConnections(connections: Connections): void { this.set({ connections }); this.savePrefs(); }

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
      const signal = this.abortable('evolution');
      try {
        for (;;) {
          const response = await this.api.evolution(signal);
          if (signal.aborted || this.disposed) return false;
          if (response.status === 'ready') {
            this.evolution = new Evolution(response); this.evolutionKey = key;
            this.setTimeline({ evolution: { status: 'ready' } });
            return true;
          }
          this.setTimeline({ evolution: { status: 'loading', progress: response.progress } });
          await new Promise(resolve => setTimeout(resolve, 400));
        }
      } catch (error) {
        if (!isAbort(error) && !this.disposed) this.setTimeline({ evolution: { status: 'error', error: error instanceof Error ? error.message : String(error) } });
        return false;
      } finally { if (!signal.aborted) this.evolutionLoad = undefined; }
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
      if (this.state.features.status !== 'idle') void this.loadFeatures();
      if (this.state.people.status !== 'idle') void this.loadPeople();
      if (this.state.people.focus) void this.loadPerson(this.state.people.focus);
      if (this.state.pulls.status !== 'idle') void this.loadPulls();
      if (this.state.pulls.focus) void this.loadPull(this.state.pulls.focus);
      if (this.state.requests.open) void this.loadRequestFlow(this.state.requests.open.id);
      if (this.state.steps) void this.loadSteps(this.state.steps.anchor);
      if (this.state.impact.open && this.state.impact.forId) void this.loadImpact(this.state.impact.forId);
      if (this.state.files) void this.loadFiles();
    } catch (error) {
      if (isAbort(error) || epoch !== this.epoch) return;
      this.setTimeline({ switching: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  // Blast radius and steps ----------------------------------------------------
  /** Identity of the current view, to tell whether loaded results still belong to it. */
  viewStamp(): string { const meta = this.state.meta; return `${meta?.snapshot.id ?? ''}|${meta?.comparison?.baseline.id ?? ''}|${meta?.mapVisibility?.revision ?? ''}`; }
  // The middle of the screen ---------------------------------------------------
  /** Bring the map, or an open tool, to the middle (the map then shows as an overview in a corner). */
  setCenter(view: CenterView): void {
    const state = this.state;
    if (view !== 'map' && !(view === 'flow' ? state.flowView : view === 'impact' ? state.impact.open : state.files)) return;
    if (state.center !== view) this.set({ center: view });
  }
  /** A tool closed: the map comes back to the middle if the tool was there. */
  private leaveCenter(view: CenterView): Partial<AtlasState> { return this.state.center === view ? { center: 'map' } : {}; }
  /** Show what depends on an entity (the selection by default) or on the uncommitted changes (`WORKING_CHANGES`) in the middle; it stays on that origin. */
  async showImpact(id = this.state.selection?.id, depth = this.state.impact.depth): Promise<void> {
    if (!id) return;
    this.set(state => ({ center: 'impact', impact: { ...state.impact, open: true, forId: id, depth, filter: {}, ...(state.impact.forId !== id || state.impact.depth !== depth ? { data: undefined, items: [] } : {}) } }));
    this.writeHash();
    await this.loadImpact(id);
  }
  /** What the uncommitted changes of the live index affect. */
  showWorkingImpact(): Promise<void> { return this.showImpact(WORKING_CHANGES); }
  /** Open the Impact tool on nothing yet: it offers the selection and the uncommitted changes. */
  openImpactTool(): void {
    if (this.state.impact.open) { this.setCenter('impact'); return; }
    this.set(state => ({ center: 'impact', impact: { ...state.impact, open: true, status: 'idle', forId: undefined, data: undefined, items: [], filter: {}, error: undefined } }));
  }
  hideImpact(): void {
    this.aborts.get('impact')?.abort();
    this.set(state => ({ ...this.leaveCenter('impact'), impact: { ...state.impact, open: false, status: 'idle', forId: undefined, data: undefined, items: [], error: undefined } }));
    this.writeHash();
  }
  /** List the blast radius by application, feature or folder (undefined: by hops). */
  async setImpactGroup(group: ImpactGroupBy | undefined): Promise<void> {
    this.set(state => ({ impact: { ...state.impact, group, filter: { ...state.impact.filter, groupKey: undefined } } }));
    if (this.state.impact.forId) await this.loadImpact(this.state.impact.forId);
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
      const options = { depth: current.depth, ...current.filter, ...(current.group ? { group: current.group } : {}), offset: append ? current.items.length : 0, limit: 100 };
      const data = await this.api.impact(id === WORKING_CHANGES ? { working: true } : id.startsWith(PULL_ORIGIN) ? { pull: id.slice(PULL_ORIGIN.length), window: this.peopleWindow() } : id, options, signal);
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
  /** Open "what happens from here" for an entity (the selection by default): the flow view in the middle. */
  async openSteps(id = this.state.selection?.id, options: { pane?: FlowPane | null } = {}): Promise<void> {
    if (!id || id.startsWith('projection:')) return;
    const node = this.scene.nodes.get(id) ?? (this.state.selection?.id === id ? this.state.selection.node : undefined);
    await this.openFlowView({ id, title: node?.name ?? 'What happens from here', lanes: LANES_TYPES.has(node?.type ?? '') }, options);
  }
  private async loadSteps(id: string): Promise<void> {
    const signal = this.abortable('steps');
    const viewStamp = this.viewStamp();
    this.set({ steps: { anchor: id, status: 'loading', viewStamp } });
    try {
      const data = await this.api.steps(id, signal);
      if (signal.aborted) return;
      for (const step of data.steps) if (step.node) this.scene.upsert(step.node);
      this.set(state => state.steps?.anchor === id ? { steps: { ...state.steps, status: 'ready', data }, sceneRevision: state.sceneRevision + 1 } : {});
      void this.showFlowOnMap();
    } catch (error) { if (!isAbort(error)) this.set(state => state.steps?.anchor === id ? { steps: { ...state.steps, status: 'error', error: error instanceof Error ? error.message : String(error) } } : {}); }
  }
  /**
   * Open a flow in the middle: on the map, in lanes (a request, command or
   * task) or in layers (anything else that runs), and as an outline of its
   * steps, side by side. A flow already open keeps the view that has the whole
   * middle, unless `pane` says which (`null`: all of them side by side).
   */
  async openFlowView(entry: { id: string; title: string; subtitle?: string; kind?: CatalogKind; lanes: boolean }, options: { pane?: FlowPane | null } = {}): Promise<void> {
    const current = this.state.flowView;
    if (current?.id !== entry.id) {
      for (const key of ['steps', 'request-flow', 'tour']) this.aborts.get(key)?.abort();
      this.tourSource = undefined;
      this.set(state => ({ steps: undefined, requests: state.requests.open?.id === entry.id ? state.requests : {}, tour: undefined }));
    }
    const pane = options.pane === undefined ? current?.pane : options.pane ?? undefined;
    this.set({ center: 'flow', flowView: { id: entry.id, title: entry.title, ...(entry.subtitle ? { subtitle: entry.subtitle } : {}), ...(entry.kind ? { kind: entry.kind } : {}), lanes: entry.lanes, ...(pane ? { pane } : {}) } });
    const view = this.state.flowView!, stamp = this.viewStamp();
    const open = this.state.requests.open, steps = this.state.steps;
    await Promise.all([
      view.lanes && (open?.id !== view.id || open.status === 'error' || open.viewStamp !== stamp) ? this.loadRequestFlow(view.id) : undefined,
      steps?.anchor !== view.id || steps.status === 'error' || steps.viewStamp !== stamp ? this.loadSteps(view.id) : undefined,
    ]);
    await this.showFlowOnMap();
  }
  /** Give one view of the open flow the whole middle (undefined: they share it again). */
  setFlowPane(pane: FlowPane | undefined): void {
    const view = this.state.flowView;
    if (!view || view.pane === pane) return;
    this.set({ center: 'flow', flowView: { id: view.id, title: view.title, ...(view.subtitle ? { subtitle: view.subtitle } : {}), ...(view.kind ? { kind: view.kind } : {}), lanes: view.lanes, ...(pane ? { pane } : {}) } });
  }
  /** Resize the views of an open flow (shares of the middle, kept in the preferences). */
  setFlowSplit(split: Partial<FlowSplit>): void { this.set(state => ({ flowSplit: clampSplit({ ...state.flowSplit, ...split }) })); this.savePrefs(); }
  closeFlowView(): void {
    for (const key of ['steps', 'request-flow', 'tour']) this.aborts.get(key)?.abort();
    this.tourSource = undefined;
    this.set({ ...this.leaveCenter('flow'), flowView: undefined, steps: undefined, requests: {}, tour: undefined });
  }
  /** Highlight one step (and its links) on the map. */
  focusStep(id: string | undefined): void { this.set(state => state.steps ? { steps: { ...state.steps, focus: id } } : {}); }
  /** Select an entity of the open flow and fly the map to it; the map comes back beside the flow if another view had the whole middle. */
  showInFlowMap(id: string): void {
    const pane = this.state.flowView?.pane;
    if (pane && pane !== 'map') this.setFlowPane(undefined);
    void this.select(id, { fly: true });
  }

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
  /** Filter the Flows list; the groups follow the filter again (open while filtering). */
  setCatalogQuery(query: string): void { this.setCatalog({ query, open: {} }); }
  setCatalogFilter(filter: FlowStatus | undefined): void { this.setCatalog(catalog => ({ filter: catalog.filter === filter ? undefined : filter })); }
  /** Open a flow of the catalog in the middle. */
  openCatalogFlow(item: FlowSummary, options: { pane?: FlowPane | null } = {}): Promise<void> {
    const entry = flowEntry(item);
    return this.openFlowView({ id: entry.id, title: entry.title, ...(entry.subtitle ? { subtitle: entry.subtitle } : {}), kind: entry.kind, lanes: entry.detail === 'lanes' }, options);
  }

  private setTour(patch: Partial<TourState> | ((tour: TourState) => Partial<TourState>)): void {
    this.set(state => state.tour ? { tour: { ...state.tour, ...(typeof patch === 'function' ? patch(state.tour) : patch) } } : {});
  }
  /** What the flow on the map was made from (its lanes or its steps), so the same data is not placed twice. */
  private tourSource?: object;
  /**
   * The open flow on the map, made from its lanes (a request, command or task)
   * or its steps (anything else). Its stops, pin owners and the areas holding
   * them are placed in the scene, so the map can open them.
   */
  private async showFlowOnMap(): Promise<void> {
    const view = this.state.flowView;
    if (!view) return;
    const stamp = this.viewStamp(), open = this.state.requests.open, steps = this.state.steps;
    const lanes = view.lanes && open?.id === view.id && open.status === 'ready' && open.viewStamp === stamp ? open.data : undefined;
    const layers = !view.lanes && steps?.anchor === view.id && steps.status === 'ready' && steps.viewStamp === stamp ? steps.data : undefined;
    const source = lanes ?? layers;
    if (!source || source === this.tourSource) return;
    this.tourSource = source;
    const key = `${view.lanes ? 'lanes' : 'steps'}:${view.id}`;
    const before = this.state.tour?.key === key ? this.state.tour : undefined;
    const signal = this.abortable('tour');
    this.set({ tour: { key, id: view.id, detail: view.lanes ? 'lanes' : 'steps', status: 'loading', viewStamp: stamp, ...(before?.flow ? { flow: before.flow } : {}), ...(before?.branch !== undefined ? { branch: before.branch } : {}) } });
    try {
      const flow = lanes ? fromRequestFlow(lanes) : fromSteps(layers!);
      await this.placeFlow(flow, signal);
      if (signal.aborted) return;
      this.set(state => state.tour?.key === key ? { tour: { ...state.tour, status: 'ready', viewStamp: stamp, flow, branch: state.tour.branch !== undefined && state.tour.branch < flow.branches.length ? state.tour.branch : undefined }, sceneRevision: state.sceneRevision + 1 } : {});
      // A new flow is framed; the same one reloaded (another snapshot) keeps the camera.
      if (!before) this.fitTour();
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
  /** Show one branch of the flow on the map on its own (undefined: every branch); its choice is selected and the map frames it. */
  setTourBranch(index: number | undefined): void {
    const tour = this.state.tour;
    if (!tour?.flow) return;
    if (tour.branch !== index) this.setTour({ branch: index });
    const branch = index === undefined ? undefined : tour.flow.branches[index];
    const head = branch ? tour.flow.stops[branch.head] : undefined;
    if (head?.node) void this.select(head.entityId, { fly: false, recordHistory: false });
    this.fitTour();
  }
  /** Frame the flow on the map (the branch shown, or all of it). */
  fitTour(): void {
    const tour = this.state.tour, flow = tour?.flow;
    if (!flow) return;
    const branch = tour.branch === undefined ? undefined : flow.branches[tour.branch];
    const stops = branch ? branch.waves.flat().map(index => flow.stops[index]!) : flow.stops;
    this.navigator?.fitNodes(stops.flatMap(stop => stop.node ? [stop.node] : []));
  }
  /** Load a request flow's lanes; its entities are placed in the scene. */
  private async loadRequestFlow(id: string): Promise<void> {
    const signal = this.abortable('request-flow');
    const viewStamp = this.viewStamp();
    this.set(state => ({ requests: { open: { id, status: 'loading', viewStamp, ...(state.requests.open?.id === id && state.requests.open.focus ? { focus: state.requests.open.focus } : {}) } } }));
    try {
      const data = await this.api.requestFlow(id, signal);
      if (signal.aborted) return;
      for (const node of data.nodes) if (node.node) this.scene.upsert(node.node);
      this.set(state => state.requests.open?.id === id ? { requests: { open: { ...state.requests.open, status: 'ready', data, viewStamp } } } : {});
      this.bumpScene();
      void this.showFlowOnMap();
    } catch (error) { if (!isAbort(error)) this.set(state => state.requests.open?.id === id ? { requests: { open: { ...state.requests.open, status: 'error', error: error instanceof Error ? error.message : String(error) } } } : {}); }
  }
  focusRequestNode(id: string | undefined): void { this.set(state => state.requests.open ? { requests: { open: { ...state.requests.open, focus: id } } } : {}); }
  /** Show or hide the coverage lens: files colored by whether flows touch them. */
  async toggleCoverage(show = !this.state.coverage.show): Promise<void> {
    // Coverage and data families both color files: one at a time.
    this.set(state => ({ coverage: { ...state.coverage, show }, ...(show && state.families.show ? { families: { ...state.families, show: false, focus: undefined } } : {}), ...(show && state.people.show ? { people: { ...state.people, show: false } } : {}) }));
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
    this.set(state => ({ families: { ...state.families, show, ...(show ? {} : { focus: undefined }) }, ...(show && state.coverage.show ? { coverage: { ...state.coverage, show: false } } : {}), ...(show && state.people.show ? { people: { ...state.people, show: false } } : {}) }));
    if (show && (this.state.families.status !== 'ready' || this.state.families.viewStamp !== this.viewStamp())) await this.loadFamilies();
  }
  /** Families of the current view, loaded when they are not yet (the inspector reads them without coloring the map). */
  async ensureFamilies(): Promise<void> {
    const families = this.state.families;
    if (families.status === 'loading' || (families.status === 'ready' && families.viewStamp === this.viewStamp())) return;
    await this.loadFamilies();
  }
  async loadFamilies(): Promise<void> {
    const signal = this.abortable('families');
    const viewStamp = this.viewStamp();
    this.set(state => ({ families: { ...state.families, status: 'loading', error: undefined } }));
    try {
      const data = await this.api.families(signal);
      if (signal.aborted) return;
      // A family that no longer exists in this view is no longer lit.
      this.set(state => ({ families: { ...state.families, status: 'ready', data, viewStamp, ...(state.families.focus && state.families.focus !== NO_FAMILY && !data.families.some(family => family.key === state.families.focus) ? { focus: undefined } : {}) } }));
    } catch (error) { if (!isAbort(error)) this.set(state => ({ families: { ...state.families, status: 'error', error: error instanceof Error ? error.message : String(error) } })); }
  }
  /** Light one family on the map (again: none); the colors are shown if they were not. A lit feature lets go. */
  focusFamily(key: string | undefined): void {
    this.set(state => ({ families: { ...state.families, focus: key === undefined || state.families.focus === key ? undefined : key }, ...(key ? { features: { ...state.features, focus: undefined }, people: { ...state.people, focus: undefined, person: undefined }, pulls: { ...state.pulls, focus: undefined, pull: undefined } } : {}) }));
    if (key && !this.state.families.show) void this.toggleFamilies(true);
    this.followHighlight('family', this.state.families.focus);
  }

  // Features ---------------------------------------------------------------------
  /** Features of the current view, loaded when they are not yet. */
  async ensureFeatures(): Promise<void> {
    const features = this.state.features;
    if (features.status === 'loading' || (features.status === 'ready' && features.viewStamp === this.viewStamp())) return;
    await this.loadFeatures();
  }
  async loadFeatures(): Promise<void> {
    const signal = this.abortable('features');
    const viewStamp = this.viewStamp();
    this.set(state => ({ features: { ...state.features, status: 'loading', error: undefined } }));
    try {
      const data = await this.api.features(signal);
      if (signal.aborted) return;
      this.set(state => ({ features: { ...state.features, status: 'ready', data, viewStamp, ...(state.features.focus && !data.features.some(feature => feature.key === state.features.focus) ? { focus: undefined } : {}) } }));
    } catch (error) { if (!isAbort(error)) this.set(state => ({ features: { ...state.features, status: 'error', error: error instanceof Error ? error.message : String(error) } })); }
  }
  /**
   * Light one feature's files on the map and dim the rest (again: none); its
   * branch of the tree opens and, with `fit`, the camera frames its folders.
   * A lit family lets go: one focus at a time.
   */
  async focusFeature(key: string | undefined, options: { fit?: boolean } = {}): Promise<void> {
    const focus = key === undefined || this.state.features.focus === key ? undefined : key;
    this.set(state => ({ features: { ...state.features, focus, ...(focus ? { open: { ...state.features.open, [focus]: true } } : {}) }, ...(focus ? { families: { ...state.families, focus: undefined }, people: { ...state.people, focus: undefined, person: undefined }, pulls: { ...state.pulls, focus: undefined, pull: undefined } } : {}) }));
    if (!focus) return;
    this.followHighlight('feature', focus);
    await this.ensureFeatures();
    const feature = this.state.features.data?.features.find(item => item.key === focus);
    if (!options.fit || !feature?.folders.length) return;
    try {
      const { items } = await this.api.nodes(feature.folders.slice(0, 60).map(folder => folder.id));
      if (this.state.features.focus === focus && items.length) this.navigator?.fitNodes(items);
    } catch { /* framing is optional */ }
  }
  /** Open the Features panel (on one feature, lit on the map). */
  async revealFeature(key?: string): Promise<void> {
    this.set(state => ({ features: { ...state.features, reveal: (state.features.reveal ?? 0) + 1 } }));
    if (key && this.state.features.focus !== key) await this.focusFeature(key, { fit: true });
  }
  /** Expand or collapse a branch of the Features tree (`open` undefined: toggle). */
  setFeatureOpen(branch: string, open?: boolean): void {
    this.set(state => ({ features: { ...state.features, open: { ...state.features.open, [branch]: open ?? !state.features.open[branch] } } }));
  }
  // People (who changed which code) --------------------------------------------------
  /** The window the figures use: a comparison's range only while comparing (otherwise all of the history). */
  peopleWindow(): AuthorshipWindowKey { const window = this.state.people.window; return window === 'range' && !this.state.meta?.comparison ? 'all' : window; }
  /** Identity of the view and window, to tell whether loaded authorship still belongs to them. */
  peopleStamp(): string { return `${this.viewStamp()}|${this.peopleWindow()}`; }
  /** The people of the current view and window, loaded when they are not yet. */
  async ensurePeople(): Promise<void> {
    const people = this.state.people;
    if (people.status === 'loading' || (people.status === 'ready' && people.stamp === this.peopleStamp())) return;
    await this.loadPeople();
  }
  async loadPeople(): Promise<void> {
    const signal = this.abortable('people');
    const stamp = this.peopleStamp();
    this.set(state => ({ people: { ...state.people, status: 'loading', error: undefined } }));
    try {
      const data = await this.api.authorship(this.peopleWindow(), signal);
      if (signal.aborted) return;
      this.set(state => ({ people: { ...state.people, status: 'ready', data, stamp } }));
    } catch (error) { if (!isAbort(error)) this.set(state => ({ people: { ...state.people, status: 'error', error: error instanceof Error ? error.message : String(error) } })); }
  }
  private async loadPerson(key: string): Promise<void> {
    const signal = this.abortable('person');
    const stamp = this.peopleStamp();
    // What was loaded for another window stays on screen until the new figures arrive.
    this.set(state => ({ people: { ...state.people, person: { ...(state.people.person?.key === key ? state.people.person : { key }), status: 'loading', error: undefined } } }));
    try {
      const data = await this.api.personAuthorship(key, this.peopleWindow(), signal);
      if (signal.aborted) return;
      this.set(state => state.people.focus === key ? { people: { ...state.people, person: { key, status: 'ready', stamp, data } } } : {});
    } catch (error) { if (!isAbort(error)) this.set(state => state.people.focus === key ? { people: { ...state.people, person: { key, status: 'error', stamp, error: error instanceof Error ? error.message : String(error) } } } : {}); }
  }
  private async loadSelectionAuthorship(id: string, signal: AbortSignal): Promise<void> {
    const stamp = this.peopleStamp();
    this.set(state => state.selection?.id === id ? { selection: { ...state.selection, authorship: { ...state.selection.authorship, status: 'loading', error: undefined } } } : {});
    try {
      const data = await this.api.entityAuthorship(id, this.peopleWindow(), signal);
      this.set(state => state.selection?.id === id ? { selection: { ...state.selection, authorship: { status: 'ready', stamp, data } } } : {});
    } catch (error) { if (!isAbort(error)) this.set(state => state.selection?.id === id ? { selection: { ...state.selection, authorship: { status: 'error', error: error instanceof Error ? error.message : String(error) } } } : {}); }
  }
  /** Color files by the person who changed each most (coverage and data families let go: one coloring at a time). */
  async togglePeopleColors(show = !this.state.people.show): Promise<void> {
    this.set(state => ({ people: { ...state.people, show }, ...(show && state.coverage.show ? { coverage: { ...state.coverage, show: false } } : {}), ...(show && state.families.show ? { families: { ...state.families, show: false, focus: undefined } } : {}) }));
    if (show) await this.ensurePeople();
  }
  /**
   * Light the files one person changed in the window and dim the rest (again:
   * none); with `fit`, the camera frames the folders holding them. A lit
   * feature or family lets go: one focus at a time.
   */
  async focusPerson(key: string | undefined, options: { fit?: boolean } = {}): Promise<void> {
    const focus = key === undefined || this.state.people.focus === key ? undefined : key;
    this.set(state => ({ people: { ...state.people, focus, ...(focus ? { open: { ...state.people.open, [focus]: true } } : { person: undefined }) }, ...(focus ? { families: { ...state.families, focus: undefined }, features: { ...state.features, focus: undefined }, pulls: { ...state.pulls, focus: undefined, pull: undefined } } : {}) }));
    if (!focus) { this.aborts.get('person')?.abort(); return; }
    this.followHighlight('person', focus);
    await this.loadPerson(focus);
    const folders = this.state.people.person?.key === focus ? this.state.people.person.data?.folders : undefined;
    if (!options.fit || !folders?.length) return;
    try {
      const { items } = await this.api.nodes(folders.slice(0, 60).map(folder => folder.id));
      if (this.state.people.focus === focus && items.length) this.navigator?.fitNodes(items);
    } catch { /* framing is optional */ }
  }
  /** Open the People panel (on one person, lit on the map). */
  async revealPeople(key?: string): Promise<void> {
    this.set(state => ({ people: { ...state.people, reveal: (state.people.reveal ?? 0) + 1 } }));
    if (key && this.state.people.focus !== key) await this.focusPerson(key, { fit: true });
  }
  /** Change the window of every authorship figure: the panel, the colors, the person lit and the selection. */
  async setPeopleWindow(window: AuthorshipWindowKey): Promise<void> {
    if (window === this.state.people.window) return;
    this.set(state => ({ people: { ...state.people, window } }));
    this.savePrefs();
    const { people, selection } = this.state;
    await Promise.all([
      people.status !== 'idle' ? this.loadPeople() : undefined,
      people.focus ? this.loadPerson(people.focus) : undefined,
      selection?.authorship ? this.loadSelectionAuthorship(selection.id, this.aborts.get('selection')?.signal ?? new AbortController().signal) : undefined,
      this.state.pulls.status !== 'idle' ? this.loadPulls() : undefined,
      this.state.pulls.focus ? this.loadPull(this.state.pulls.focus) : undefined,
      selection?.pulls ? this.loadSelectionPulls(selection.id, this.aborts.get('selection')?.signal ?? new AbortController().signal) : undefined,
      this.state.files?.kind === 'person' || this.state.files?.kind === 'pull' ? this.loadFiles() : undefined,
    ]);
  }
  /** Expand or collapse a row of the People panel (`open` undefined: toggle). */
  setPeopleOpen(branch: string, open?: boolean): void {
    this.set(state => ({ people: { ...state.people, open: { ...state.people.open, [branch]: open ?? !state.people.open[branch] } } }));
  }
  /** Show a commit's changes in History: its snapshot compared with the commit before. */
  async showCommit(snapshot: string): Promise<void> {
    if (!this.state.timeline.open) await this.openTimeline();
    if (!this.state.timeline.compare) await this.setCompare(true);
    await this.setTarget(snapshot);
  }
  // Pull requests -------------------------------------------------------------------
  /** The pull requests of the current view and window, loaded when they are not yet. */
  async ensurePulls(): Promise<void> {
    const pulls = this.state.pulls;
    if (pulls.status === 'loading' || (pulls.status === 'ready' && pulls.stamp === this.peopleStamp())) return;
    await this.loadPulls();
  }
  /** Load the pull requests (`refresh`: ask the provider again). Merged ones are filtered by the panel's query on the server. */
  async loadPulls(options: { refresh?: boolean } = {}): Promise<void> {
    const signal = this.abortable('pulls');
    const stamp = this.peopleStamp(), query = this.state.pulls.query;
    this.set(state => ({ pulls: { ...state.pulls, status: 'loading', error: undefined, ...(options.refresh ? { refreshing: true } : {}) } }));
    try {
      const data = await this.api.pulls(this.peopleWindow(), { ...(query ? { query } : {}), ...(options.refresh ? { refresh: true } : {}) }, signal);
      if (signal.aborted) return;
      this.set(state => ({ pulls: { ...state.pulls, status: 'ready', data, stamp, refreshing: false } }));
    } catch (error) { if (!isAbort(error)) this.set(state => ({ pulls: { ...state.pulls, status: 'error', refreshing: false, error: error instanceof Error ? error.message : String(error) } })); }
  }
  /** Filter the pull requests by number, words of the title, branch or author. */
  setPullsQuery(query: string): void {
    if (query === this.state.pulls.query) return;
    this.set(state => ({ pulls: { ...state.pulls, query } }));
    void this.loadPulls();
  }
  setPullsTab(tab: PullsState['tab']): void { this.set(state => ({ pulls: { ...state.pulls, tab } })); }
  /** Expand or collapse a row of the Pull requests panel (`open` undefined: toggle). */
  setPullsOpen(branch: string, open?: boolean): void {
    this.set(state => ({ pulls: { ...state.pulls, open: { ...state.pulls.open, [branch]: open ?? !state.pulls.open[branch] } } }));
  }
  private async loadPull(id: string): Promise<void> {
    const signal = this.abortable('pull');
    const stamp = this.peopleStamp();
    this.set(state => ({ pulls: { ...state.pulls, pull: { ...(state.pulls.pull?.id === id ? state.pulls.pull : { id }), status: 'loading', error: undefined } } }));
    try {
      const data = await this.api.pull(id, this.peopleWindow(), signal);
      if (signal.aborted) return;
      this.set(state => state.pulls.focus === id ? { pulls: { ...state.pulls, pull: { id, status: 'ready', stamp, data } } } : {});
    } catch (error) { if (!isAbort(error)) this.set(state => state.pulls.focus === id ? { pulls: { ...state.pulls, pull: { id, status: 'error', stamp, error: error instanceof Error ? error.message : String(error) } } } : {}); }
  }
  private async loadSelectionPulls(id: string, signal: AbortSignal): Promise<void> {
    const stamp = this.peopleStamp();
    this.set(state => state.selection?.id === id ? { selection: { ...state.selection, pulls: { ...state.selection.pulls, status: 'loading', error: undefined } } } : {});
    try {
      const data = await this.api.entityPulls(id, this.peopleWindow(), signal);
      this.set(state => state.selection?.id === id ? { selection: { ...state.selection, pulls: { status: 'ready', stamp, data } } } : {});
    } catch (error) { if (!isAbort(error)) this.set(state => state.selection?.id === id ? { selection: { ...state.selection, pulls: { status: 'error', error: error instanceof Error ? error.message : String(error) } } } : {}); }
  }
  /**
   * Light the files a pull request changes and dim the rest (again: none);
   * with `fit`, the camera frames the folders holding them. A lit person,
   * feature or family lets go: one focus at a time.
   */
  async focusPull(id: string | undefined, options: { fit?: boolean } = {}): Promise<void> {
    const focus = id === undefined || this.state.pulls.focus === id ? undefined : id;
    this.set(state => ({ pulls: { ...state.pulls, focus, ...(focus ? { open: { ...state.pulls.open, [focus]: true } } : { pull: undefined }) }, ...(focus ? { families: { ...state.families, focus: undefined }, features: { ...state.features, focus: undefined }, people: { ...state.people, focus: undefined, person: undefined } } : {}) }));
    if (!focus) { this.aborts.get('pull')?.abort(); return; }
    this.followHighlight('pull', focus);
    await this.loadPull(focus);
    const folders = this.state.pulls.pull?.id === focus ? this.state.pulls.pull.data?.folders : undefined;
    if (!options.fit || !folders?.length) return;
    try {
      const { items } = await this.api.nodes(folders.slice(0, 60).map(folder => folder.id));
      if (this.state.pulls.focus === focus && items.length) this.navigator?.fitNodes(items);
    } catch { /* framing is optional */ }
  }
  /** Open the Pull requests panel (on one, lit on the map, on the list that holds it). */
  async revealPulls(id?: string): Promise<void> {
    this.set(state => ({ pulls: { ...state.pulls, reveal: (state.pulls.reveal ?? 0) + 1 } }));
    if (!id) return;
    await this.ensurePulls();
    const data = this.state.pulls.data;
    const tab = data?.open.some(item => item.id === id) ? 'open' : data?.closed.some(item => item.id === id) ? 'closed' : 'merged';
    this.set(state => ({ pulls: { ...state.pulls, tab } }));
    if (this.state.pulls.focus !== id) await this.focusPull(id, { fit: true });
  }
  /** What depends on the code a pull request changes, in the middle. */
  showPullImpact(id: string): Promise<void> { return this.showImpact(`${PULL_ORIGIN}${id}`); }
  // Lists of what is lit -------------------------------------------------------------
  /**
   * List the files a highlight lights, in the middle: a feature, a data family,
   * a coverage category or a person. The highlight is turned on if it was not,
   * so the overview map shows the same files.
   */
  async openFiles(subject: FileSubject): Promise<void> {
    const { kind, key } = subject;
    this.set({ center: 'files', files: { kind, key, status: 'loading', stamp: this.filesStamp(subject) } });
    if (kind === 'feature' && this.state.features.focus !== key) void this.focusFeature(key);
    if (kind === 'family' && this.state.families.focus !== key) this.focusFamily(key);
    if (kind === 'person' && this.state.people.focus !== key) void this.focusPerson(key);
    if (kind === 'pull' && this.state.pulls.focus !== key) void this.focusPull(key);
    if (kind === 'coverage' && !this.state.coverage.show) void this.toggleCoverage(true);
    await this.loadFiles();
  }
  closeFiles(): void { this.aborts.get('files')?.abort(); this.set({ ...this.leaveCenter('files'), files: undefined }); }
  /** The view (and, for a person, the window) a list of files belongs to. */
  private filesStamp(subject: FileSubject): string { return `${subject.kind}:${subject.key}|${subject.kind === 'person' || subject.kind === 'pull' ? this.peopleStamp() : this.viewStamp()}`; }
  async loadFiles(): Promise<void> {
    const files = this.state.files;
    if (!files) return;
    const subject = { kind: files.kind, key: files.key }, stamp = this.filesStamp(subject);
    const signal = this.abortable('files');
    this.set(state => state.files ? { files: { ...state.files, status: 'loading', stamp, error: undefined } } : {});
    try {
      const data = await this.api.files(files.kind === 'person' || files.kind === 'pull' ? { [files.kind]: files.key, window: this.peopleWindow() } : { [files.kind]: files.key }, signal);
      if (signal.aborted) return;
      this.set(state => state.files?.stamp === stamp ? { files: { ...state.files, status: 'ready', data } } : {});
    } catch (error) { if (!isAbort(error)) this.set(state => state.files?.stamp === stamp ? { files: { ...state.files, status: 'error', error: error instanceof Error ? error.message : String(error) } } : {}); }
  }
  /** A highlight of the same kind as the open list moved to another key: the list follows it. */
  private followHighlight(kind: FileSubject['kind'], key: string | undefined): void {
    const files = this.state.files;
    if (!files || files.kind !== kind || !key || files.key === key) return;
    this.set({ files: { kind, key, status: 'loading', stamp: this.filesStamp({ kind, key }) } });
    void this.loadFiles();
  }
  // The code of the selection ---------------------------------------------------
  /** Open the Code panel beside the inspector: it shows the selection's code. */
  openCode(): void {
    if (!this.state.code) { this.set({ code: { status: 'idle' } }); this.writeHash(); }
    this.followCode();
  }
  closeCode(): void {
    for (const key of ['code', 'code-more', 'code-outline']) this.aborts.get(key)?.abort();
    this.set({ code: undefined });
    this.writeHash();
  }
  /** Read the selection's code if the tool shows something else (another entity, or another view of history). */
  private followCode(): void {
    const { code, selection } = this.state;
    if (!code || !selection) return;
    if (code.stamp === `${this.viewStamp()}|${selection.id}` && code.status !== 'error') return;
    const node = selection.node ?? this.scene.nodes.get(selection.id);
    if (node) void this.loadCode(selection.id, node);
  }
  private async loadCode(id: string, node: NodeSummary): Promise<void> {
    const stamp = `${this.viewStamp()}|${id}`;
    this.aborts.get('code-more')?.abort();
    // An area has no single source: the tool lists what it holds (its children, from the scene).
    if (isContainer(node) || !node.path) {
      this.aborts.get('code')?.abort();
      this.set(state => state.code ? { code: { ...state.code, forId: id, node, stamp, status: 'ready', data: undefined, error: undefined, more: undefined } } : {});
      void this.loadChildren([id]);
      return;
    }
    const range = node.type !== 'file' ? node.sourceRange : undefined;
    // Another symbol of the file already read: mark its lines without reading the file again.
    const shown = this.state.code?.data;
    if (shown && shown.file.path === node.path && this.state.code?.stamp?.startsWith(`${this.viewStamp()}|`) && !shown.changedSinceIndex && (range ? range.startLine >= shown.start && range.endLine <= shown.end : shown.start === 1)) {
      this.aborts.get('code')?.abort();
      const { focus: _focus, ...rest } = shown;
      const data: SourceResponse = range ? { ...rest, focus: { startLine: range.startLine, endLine: range.endLine, kind: 'symbol', label: `${node.type} ${node.name}` } } : rest;
      this.set(state => state.code ? { code: { ...state.code, forId: id, node, stamp, status: 'ready', data, error: undefined, more: undefined } } : {});
      return;
    }
    const signal = this.abortable('code');
    // The window starts at the top of the file unless the symbol starts far down; reading on loads the rest.
    const start = !range || range.startLine <= CODE_WINDOW - 100 ? 1 : range.startLine - 40;
    // The same file stays on screen while the next symbol in it loads.
    this.set(state => state.code ? { code: { ...state.code, forId: id, node, stamp, status: 'loading', error: undefined, more: undefined, ...(state.code.data?.file.path === node.path ? {} : { data: undefined }) } } : {});
    try {
      const data = await this.api.source({ entity: id, start, end: start + CODE_WINDOW - 1 }, signal);
      if (signal.aborted) return;
      this.set(state => state.code?.stamp === stamp ? { code: { ...state.code, status: 'ready', data } } : {});
      void this.loadOutline(data.file.id);
    } catch (error) { if (!isAbort(error)) this.set(state => state.code?.stamp === stamp ? { code: { ...state.code, status: 'error', error: error instanceof Error ? error.message : String(error) } } : {}); }
  }
  /** Read the lines just above or below those shown, keeping what is shown. */
  async codeMore(direction: 'earlier' | 'later'): Promise<void> {
    const code = this.state.code, data = code?.data;
    if (!code?.forId || !data || code.more || code.status !== 'ready') return;
    const start = direction === 'earlier' ? Math.max(1, data.start - CODE_WINDOW) : data.end + 1;
    const end = direction === 'earlier' ? data.start - 1 : Math.min(data.totalLines, data.end + CODE_WINDOW);
    if (end < start) return;
    const stamp = code.stamp, signal = this.abortable('code-more');
    this.set(state => state.code ? { code: { ...state.code, more: direction } } : {});
    try {
      const next = await this.api.source({ entity: code.forId, start, end }, signal);
      if (signal.aborted) return;
      this.set(state => {
        const shown = state.code, current = shown?.data;
        if (!shown || shown.stamp !== stamp || !current) return {};
        // The file changed on disk meanwhile: start again from what was read last.
        const merged = next.currentHash !== current.currentHash ? next
          : direction === 'earlier' ? { ...current, start: next.start, lines: [...next.lines.slice(0, current.start - next.start), ...current.lines], truncated: current.truncated || next.truncated }
          : { ...current, end: next.end, lines: [...current.lines, ...next.lines], truncated: current.truncated || next.truncated };
        return { code: { ...shown, data: merged, more: undefined } };
      });
    } catch (error) { if (!isAbort(error)) this.set(state => state.code && state.code.stamp === stamp ? { code: { ...state.code, more: undefined, error: error instanceof Error ? error.message : String(error) } } : {}); }
  }
  /** The symbols of a file for the outline: its children, and theirs (a class's members), bounded. */
  private async loadOutline(fileId: string): Promise<void> {
    const stamp = this.viewStamp(), outline = this.state.code?.outline;
    if (outline?.fileId === fileId && outline.stamp === stamp && outline.status !== 'error') return;
    const signal = this.abortable('code-outline');
    this.set(state => state.code ? { code: { ...state.code, outline: { fileId, stamp, status: 'loading', items: [] } } } : {});
    try {
      const top = (await this.api.children(fileId, 0, 200, signal)).items;
      const nested = await Promise.all(top.map((item, index) => item.childCount > 0 && item.kind === 'entity' && index < 24 ? this.api.children(item.id, 0, 200, signal).then(page => page.items) : Promise.resolve([])));
      if (signal.aborted) return;
      const byLine = (a: NodeSummary, b: NodeSummary) => (a.sourceRange?.startLine ?? 0) - (b.sourceRange?.startLine ?? 0) || (a.name < b.name ? -1 : 1);
      const items = top.map((item, index) => ({ item, members: nested[index]! })).sort((a, b) => byLine(a.item, b.item))
        .flatMap(({ item, members }) => [{ ...item, level: 0 }, ...[...members].sort(byLine).map(member => ({ ...member, level: 1 }))]);
      this.set(state => state.code?.outline?.fileId === fileId ? { code: { ...state.code, outline: { fileId, stamp, status: 'ready', items } } } : {});
    } catch (error) { if (!isAbort(error)) this.set(state => state.code?.outline?.fileId === fileId ? { code: { ...state.code, outline: { ...state.code.outline, status: 'error' } } } : {}); }
  }
  /** Expand or collapse groups of the Flows list (`open` undefined: toggle). */
  // Explanations ------------------------------------------------------------------
  private setExplain(patch: Partial<ExplainState> | ((explain: ExplainState) => Partial<ExplainState>)): void {
    this.set(state => ({ explain: { ...state.explain, ...(typeof patch === 'function' ? patch(state.explain) : patch) } }));
  }
  /** Show the column (and an explanation in it). */
  async openExplanations(options: { id?: string } = {}): Promise<void> {
    this.setExplain(explain => ({ open: true, unseen: [], reveal: (explain.reveal ?? 0) + 1 }));
    this.writeHash();
    await Promise.all([this.loadExplanations(), this.loadExplanationSetup(), options.id ? this.openExplanation(options.id) : Promise.resolve()]);
  }
  closeExplanations(): void { this.setExplain({ open: false, hover: undefined }); this.writeHash(); }
  toggleExplanations(): void { if (this.state.explain.open) this.closeExplanations(); else void this.openExplanations(); }
  async loadExplanations(): Promise<void> {
    const api = this.options.explanations;
    if (!api) return;
    if (!this.state.explain.list.data) this.setExplain(explain => ({ list: { ...explain.list, status: 'loading' } }));
    try {
      const data = await api.list();
      this.setExplain({ list: { status: 'ready', data } });
      // The selection was made before the list arrived: what explains it can be read now.
      const selection = this.state.selection;
      if (selection && !selection.explained && data.items.length) void this.loadSelectionExplanations(selection.id, this.aborts.get('selection')?.signal ?? new AbortController().signal);
    }
    catch (error) { this.setExplain(explain => ({ list: { ...explain.list, status: 'error', error: error instanceof Error ? error.message : String(error) } })); }
  }
  async loadExplanationSetup(): Promise<void> {
    const api = this.options.explanations;
    if (!api) return;
    try { const setup = await api.setup(); this.setExplain(explain => ({ setup, draft: { ...explain.draft, model: explain.draft.model && setup.models.some(model => model.id === explain.draft.model && model.available) ? explain.draft.model : setup.models.find(model => model.default)?.id } })); }
    catch { /* the column says what it can */ }
  }
  /** New or changed explanations (an agent may have saved one): the list follows, and the open one is read again. */
  private async pollExplanations(): Promise<void> {
    const api = this.options.explanations;
    if (!api || this.disposed || this.state.explain.asking?.status === 'streaming') return;
    try {
      const data = await api.list();
      const previous = this.state.explain.list.data;
      if (previous?.version === data.version) return;
      const known = new Set(previous?.items.map(item => item.id) ?? []);
      const arrived = previous ? data.items.filter(item => !known.has(item.id) && item.source === 'agent').map(item => item.id) : [];
      this.setExplain(explain => ({ list: { status: 'ready', data }, ...(arrived.length && !explain.open ? { unseen: [...new Set([...explain.unseen, ...arrived])] } : {}) }));
      const open = this.state.explain.detail;
      const changed = open && data.items.find(item => item.id === open.id);
      if (open && changed && changed.updatedAt !== open.data?.updatedAt) void this.openExplanation(open.id, { quiet: true });
      // An agent saved one while the column shows the list: open it.
      if (arrived.length === 1 && this.state.explain.open && !this.state.explain.detail) void this.openExplanation(arrived[0]!);
      const selection = this.state.selection;
      if (selection) void this.loadSelectionExplanations(selection.id, this.aborts.get('selection')?.signal ?? new AbortController().signal);
    } catch { /* the server may be restarting */ }
  }
  async openExplanation(id: string, options: { quiet?: boolean } = {}): Promise<void> {
    const api = this.options.explanations;
    if (!api) return;
    const signal = this.abortable('explanation');
    if (!options.quiet) this.setExplain(explain => ({ open: true, hover: undefined, detail: { id, status: 'loading', ...(explain.detail?.id === id ? { data: explain.detail.data } : {}) } }));
    this.writeHash();
    try {
      const data = await api.detail(id, signal);
      this.setExplain(explain => explain.detail?.id === id || !explain.detail ? { detail: { id, status: 'ready', data } } : {});
      this.writeHash();
    } catch (error) {
      if (isAbort(error)) return;
      this.setExplain(explain => explain.detail?.id === id ? { detail: { id, status: 'error', error: error instanceof Error ? error.message : String(error) } } : {});
    }
  }
  closeExplanation(): void { this.aborts.get('explanation')?.abort(); this.setExplain({ detail: undefined, hover: undefined }); this.writeHash(); }
  /** A link the pointer is on (undefined: none): what it names lights on the map. */
  hoverLink(link: ResolvedLink | undefined): void {
    if (link?.href === this.state.explain.hover?.href && link?.id === this.state.explain.hover?.id) return;
    this.setExplain({ hover: link && (link.id || link.members?.length) ? link : undefined });
  }
  setExplanationLens(lens: boolean): void { this.setExplain({ lens }); this.savePrefs(); }
  /** Open what a link names: select it and read its code, its flow, its commit, its feature. */
  async followLink(link: ResolvedLink): Promise<void> {
    this.setExplain({ hover: undefined });
    if (link.kind === 'commit' || link.kind === 'pr') {
      if (link.snapshot) await this.showCommit(link.snapshot);
      else await this.openTimeline({ ...(link.sha ? { at: link.sha.slice(0, 12) } : {}) });
      return;
    }
    if (link.kind === 'feature' && link.feature) { await this.revealFeature(link.feature); return; }
    if (!link.id) return;
    if (link.kind === 'flow') {
      await this.select(link.id, { fly: true });
      if (link.detail === 'lanes') await this.openFlowView({ id: link.id, title: link.label ?? link.name ?? link.id, lanes: true }, { pane: 'diagram' });
      else await this.openSteps(link.id, { pane: 'diagram' });
      return;
    }
    this.setCenter('map');
    await this.select(link.id, { fly: true });
    const node = this.state.selection?.node;
    if (node && !isContainer(node) && node.type !== 'database_table') this.openCode();
  }
  setDraft(patch: Partial<ExplainState['draft']>): void { this.setExplain(explain => ({ draft: { ...explain.draft, ...patch } })); if (patch.model) this.savePrefs(); }
  addContext(chip: ContextChip, options: { reveal?: boolean } = {}): void {
    this.setExplain(explain => ({ draft: { ...explain.draft, context: explain.draft.context.some(item => item.href === chip.href) ? explain.draft.context : [...explain.draft.context, chip] } }));
    if (options.reveal) void this.openExplanations({ ...(this.state.explain.detail ? { id: this.state.explain.detail.id } : {}) });
  }
  removeContext(href: string): void { this.setExplain(explain => ({ draft: { ...explain.draft, context: explain.draft.context.filter(item => item.href !== href) } })); }
  /** Start a new question about something (the inspector, a flow, a commit): the composer gets the question and the code it is about. */
  async askAbout(target: PromptTarget, label?: string): Promise<void> {
    const chip = target.ref ? { href: target.kind === 'commit' ? `commit:${target.ref}` : target.kind === 'pr' ? `pr:${target.ref}` : target.ref, label: label ?? target.label ?? target.ref } : undefined;
    this.setExplain(explain => ({ detail: undefined, hover: undefined, draft: { ...explain.draft, text: chatQuestion(target, { plain: true }), context: chip ? [chip] : [] } }));
    await this.openExplanations();
  }
  /** Ask the chat: the draft (with its context) as a new explanation, or as a follow-up to the one open. */
  async ask(options: { refresh?: boolean } = {}): Promise<void> {
    const api = this.options.explanations;
    const explain = this.state.explain;
    if (!api || explain.asking?.status === 'streaming') return;
    const question = options.refresh ? '' : explain.draft.text.trim();
    if (!question && !options.refresh) return;
    const explanationId = explain.detail?.data?.id;
    if (options.refresh && !explanationId) return;
    const context = options.refresh ? [] : explain.draft.context;
    const signal = this.abortable('ask');
    this.setExplain({ asking: { status: 'streaming', ...(explanationId ? { explanationId } : {}), ...(options.refresh ? { refresh: true } : {}), question, context, text: '', tools: [], ...(explain.draft.model ? { model: explain.draft.model } : {}) }, ...(options.refresh ? {} : { draft: { ...explain.draft, text: '', context: [] } }) });
    const update = (patch: Partial<NonNullable<ExplainState['asking']>> | ((asking: NonNullable<ExplainState['asking']>) => Partial<NonNullable<ExplainState['asking']>>)) => this.setExplain(state => state.asking ? { asking: { ...state.asking, ...(typeof patch === 'function' ? patch(state.asking) : patch) } } : {});
    let saved: ExplanationDetail | undefined;
    try {
      await api.ask({ question, ...(explanationId ? { explanationId } : {}), ...(options.refresh ? { refresh: true } : {}), ...(explain.draft.model ? { model: explain.draft.model } : {}), context: context.map(item => item.href) }, (event: AskEvent) => {
        if (event.type === 'start') update({ model: event.model });
        else if (event.type === 'tool') update(asking => ({ tools: [...asking.tools, event.detail] }));
        else if (event.type === 'text') update(asking => ({ text: asking.text + event.delta }));
        else if (event.type === 'retry') update({ text: '', note: event.reason });
        else if (event.type === 'error') update({ status: 'error', error: event.message });
        else if (event.type === 'done') saved = event.explanation;
      }, signal);
      if (saved) {
        const detail = saved;
        this.setExplain({ asking: undefined, detail: { id: detail.id, status: 'ready', data: detail } });
        this.writeHash();
        void this.loadExplanations();
        const selection = this.state.selection;
        if (selection) void this.loadSelectionExplanations(selection.id, signal);
      } else if (this.state.explain.asking?.status === 'streaming') update({ status: 'error', error: 'The answer stopped before it was saved' });
    } catch (error) {
      if (isAbort(error)) { this.setExplain({ asking: undefined }); return; }
      update({ status: 'error', error: error instanceof Error ? error.message : String(error) });
    }
  }
  stopAsking(): void { this.aborts.get('ask')?.abort(); this.setExplain(explain => ({ asking: undefined, draft: explain.asking && !explain.asking.refresh ? { ...explain.draft, text: explain.draft.text || explain.asking.question, context: explain.draft.context.length ? explain.draft.context : explain.asking.context } : explain.draft })); }
  dismissAskError(): void { this.setExplain(explain => ({ asking: undefined, draft: explain.asking && !explain.asking.refresh && !explain.draft.text ? { ...explain.draft, text: explain.asking.question, context: explain.asking.context } : explain.draft })); }
  async deleteExplanation(id: string): Promise<void> {
    const api = this.options.explanations;
    if (!api) return;
    await api.remove(id);
    if (this.state.explain.detail?.id === id) this.closeExplanation();
    await this.loadExplanations();
  }
  async renameExplanation(id: string, title: string): Promise<void> {
    const api = this.options.explanations;
    if (!api || !title.trim()) return;
    await api.rename(id, title.trim());
    await Promise.all([this.loadExplanations(), this.state.explain.detail?.id === id ? this.openExplanation(id, { quiet: true }) : Promise.resolve()]);
  }
  private async loadSelectionExplanations(id: string, signal: AbortSignal): Promise<void> {
    const api = this.options.explanations;
    if (!api || !this.state.explain.list.data?.items.length) { this.set(state => state.selection?.id === id && state.selection.explained ? { selection: { ...state.selection, explained: undefined } } : {}); return; }
    try {
      const data = await api.forEntity(id, signal);
      this.set(state => state.selection?.id === id ? { selection: { ...state.selection, explained: { status: 'ready', data } } } : {});
    } catch (error) { if (!isAbort(error)) this.set(state => state.selection?.id === id ? { selection: { ...state.selection, explained: { status: 'error', error: error instanceof Error ? error.message : String(error) } } } : {}); }
  }
  setFlowGroupsOpen(keys: string[], open: boolean): void {
    this.set(state => ({ catalog: { ...state.catalog, open: { ...state.catalog.open, ...Object.fromEntries(keys.map(key => [key, open])) } } }));
  }
}
/** How a catalog flow is opened (in lanes, or by its steps), and its title. */
export function flowEntry(item: FlowSummary): { id: string; detail: 'lanes' | 'steps'; title: string; subtitle?: string; kind: CatalogKind } {
  const technical = item.kind === 'command' || item.kind === 'schedule' || item.detail === 'steps' ? item.name : `${item.method ?? ''} ${item.path ?? item.name}`.trim();
  const context = item.kind === 'schedule' ? item.cadence : item.kind === 'command' ? (item.handler ? `runs ${item.handler}` : undefined) : item.detail === 'steps' ? 'page' : item.handler ? `handled by ${item.handler}` : undefined;
  // A title the models gave reads first; the technical name stays beside it.
  const subtitle = item.title ? [technical, context].filter(Boolean).join(' · ') : context;
  return { id: item.id, detail: item.detail, title: item.title ?? technical, ...(subtitle ? { subtitle } : {}), kind: item.kind };
}
/** Shares of the middle that leave every view of a flow usable. */
export function clampSplit(split: FlowSplit): FlowSplit {
  const clamp = (value: number, min: number, max: number, fallback: number) => Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
  return { side: clamp(split.side, 0.16, 0.6, FLOW_SPLIT.side), bottom: clamp(split.bottom, 0.16, 0.76, FLOW_SPLIT.bottom) };
}
