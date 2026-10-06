// Wire types for projection and source endpoints. Type-only: shared with the
// web client without pulling server code into the browser bundle.
import type { AnalysisRun, Diagnostic, Entity, SourceRange } from '../core/graph.js';
import type { ChangeFacet, ChangeStatus, DiffSummary } from '../history/diff.js';
import type { LineageReason } from '../history/lineage.js';
import type { PullRequestRef } from '../history/pull-requests.js';
import type { SnapshotStats } from '../history/store.js';
import type { DiffLine, Hunk } from '../history/textdiff.js';
import type { Rect } from './layout.js';

export type { ChangeFacet, ChangeStatus, DiffLine, DiffSummary, Hunk, LineageReason, PullRequestRef, SnapshotStats };
/** Which snapshot a request reads, and optionally which baseline it is compared to. Absent = live working-tree index. */
/** Which snapshot (and baseline) a request reads; `lens: 'domains'` draws the live index by domain instead of by folder. */
export interface ViewKey { snapshot?: string; compareTo?: string; lens?: 'domains' }
export interface SnapshotRef { id: string; kind: 'working_tree' | 'commit'; commitSha?: string; dirty?: boolean; analyzedAt: string }
export interface NodeChange {
  status: ChangeStatus; facets: ChangeFacet[];
  /** Baseline identity when lineage mapped a changed canonical ID. */
  previousId?: string; lineage?: LineageReason; previousName?: string; previousPath?: string;
}
export interface ChangeCounts { added: number; removed: number; modified: number; moved: number }

export type { Rect } from './layout.js';
export interface NodeStats { files: number; symbols: number; endpoints: number; measuredLoc: number; unmeasuredFiles: number; descendants: number }
export interface NodeSummary {
  id: string;
  /** `group` nodes are projection-only districts, never graph entities. */
  kind: 'entity' | 'group';
  type: string; name: string;
  path?: string; language?: string; sourceRange?: SourceRange;
  canonicalParentId?: string; spatialParentId?: string;
  depth: number; rect: Rect; childCount: number;
  /** Own LOC metric, absent when not measured. */
  loc?: number;
  detail?: string; qualifiedName?: string; role?: string; explanation?: string;
  /** Unresolved findings attached within this node's spatial subtree. */
  diagnostics: number;
  stats: NodeStats;
  /** Comparison views: this node versus the baseline (absent when identical). */
  change?: NodeChange;
  /** Comparison views: changed entities inside this node. */
  changes?: ChangeCounts;
}
export interface Page<T> { items: T[]; limit: number; offset: number; total: number; hasMore: boolean }
export interface ProjectionMeta {
  run: AnalysisRun;
  snapshot: SnapshotRef;
  /** Present when the view compares against a baseline snapshot. */
  comparison?: { baseline: SnapshotRef; summary: DiffSummary; /** The two snapshots were produced by different analyzer versions. */ analyzerMismatch: boolean };
  history: { available: boolean; snapshots: number };
  root: NodeSummary;
  /** `timeline`: the union layout of all history (fixed places across commits); `persisted`: layout.json carried between runs of the live map. */
  layout: { version: number; persisted: boolean; holes: number; bounds?: Rect; source: 'timeline' | 'persisted' | 'fresh' };
  entityTypes: { type: string; count: number }[];
  relationTypes: { type: string; count: number }[];
  diagnosticSeverities: { severity: string; count: number }[];
  coverage: { databaseTables: number; resolvedHttpRequests: number; unresolvedHttpCalls: number; calls: number; gitHistory: number };
}
export interface LocateResult { node: NodeSummary; spatialAncestors: NodeSummary[]; canonicalAncestors: { id: string; type: string; name: string }[] }
export type SearchPage = Page<NodeSummary & { breadcrumb: string }> & { typeCounts: { type: string; count: number }[] };
export interface RelationItem {
  id: string; type: string; direction: 'outgoing' | 'incoming' | 'self'; other: NodeSummary;
  /** A file's relationships through its symbols (`scope=contained`): the symbol inside the file at this end. */
  inside?: NodeSummary;
  /** Spatial ancestors of `other`, root first: lets clients draw to the nearest visible ancestor. */
  otherAncestors: string[];
  metadata?: Record<string, unknown>;
  /** Comparison views: relation absent from the baseline, or only present there. */
  change?: 'added' | 'removed';
}
export type RelationsPage = Page<RelationItem> & { typeCounts: { type: string; direction: string; count: number }[] };
export interface AggregateGroup { anchor: NodeSummary; anchorAncestors: string[]; type: string; direction: string; count: number }
export interface AggregateResult { internal: { type: string; count: number }[]; groups: AggregateGroup[]; totalCrossing: number; truncated: boolean }
export type AggregateEdgesPage = Page<RelationItem & { inside: NodeSummary }>;
export type DiagnosticItem = Omit<Diagnostic, 'resolution' | 'severity'> & { severity: string; nodeId: string; nodeName: string; change?: 'added' };
export type DiagnosticsPage = Page<DiagnosticItem> & { codes: { code: string; severity: string; count: number }[] };
export interface SourceRequest {
  entity?: string; relation?: string; diagnostic?: string; evidence?: number; start?: number; end?: number;
  /** Comparison views: read the baseline's version first (default: the viewed snapshot, falling back to the baseline for removed entities). */
  side?: 'baseline';
}
export interface SourceResponse {
  file: { id: string; path: string; language?: string };
  /** The snapshot the content was read from (Git blob for commits, working tree otherwise). */
  snapshot?: SnapshotRef;
  totalLines: number; start: number; end: number; lines: string[];
  focus?: { startLine: number; endLine: number; kind: 'symbol' | 'evidence' | 'diagnostic' | 'file'; label: string };
  indexedHash?: string; currentHash: string; changedSinceIndex: boolean; truncated: boolean; notices: string[];
}

// History -------------------------------------------------------------------
export interface ChangesPage extends Page<NodeSummary & { breadcrumb: string }> { statusCounts: Record<string, number> }
export interface EntitySide { snapshot: SnapshotRef; entity: Omit<Entity, 'evidence'>; parent?: { id: string; type: string; name: string; path?: string }; evidenceCount: number }
export interface EntityChangeDetail {
  id: string; change: NodeChange;
  before?: EntitySide; after?: EntitySide;
  /** Described facts that differ (positions ignored). */
  metadata: { key: string; before?: unknown; after?: unknown }[];
  metrics: { before?: number; after?: number };
  relations: { added: RelationItem[]; removed: RelationItem[] };
  diagnostics: { added: DiagnosticItem[]; removed: DiagnosticItem[] };
  evidenceChanged: boolean;
  /** Whether a source diff can be shown (an analyzable file or a symbol on at least one side). */
  sourceDiff: boolean;
}
export interface SourceDiffSide { snapshot: SnapshotRef; entityId: string; path: string; range?: { startLine: number; endLine: number }; totalLines: number }
export interface SourceDiffResponse {
  before?: SourceDiffSide; after?: SourceDiffSide; language?: string;
  hunks: Hunk[]; added: number; removed: number;
  identical: boolean; tooLarge: boolean; truncated: boolean; notices: string[];
}
export interface TimelineEntry {
  sha: string; parents: string[]; authorName: string; authoredAt: string; committedAt: string; subject: string;
  merge: boolean; pullRequest?: PullRequestRef;
  snapshot?: { id: string; stale: boolean; stats: SnapshotStats };
  /** Language-model explanation of the commit (`annotate`), from its message and indexed changes. */
  note?: CommitNote;
}
export interface CommitNote { intent: string; title: string; summary: string; areas: string[] }
/** A run of consecutive commits with one theme (`annotate`). */
export interface HistoryChapter { title: string; summary: string; from: string; to: string; areas: string[] }
export interface TimelineResponse {
  available: boolean; reason?: string;
  ref?: string; head?: string; firstParent: boolean;
  /** Oldest first. */
  entries: TimelineEntry[];
  workingTree?: SnapshotRef & { stats: { entities: number } };
  indexing: { enabled: boolean; active?: string; queued: string[]; failed: { sha: string; error: string }[] };
  chapters?: HistoryChapter[];
}
export interface EntityHistoryPoint { sha: string; snapshotId: string; status: 'introduced' | 'modified' | 'moved' | 'removed' | 'reintroduced'; name: string; path?: string }
export interface EntityHistoryResponse { id: string; points: EntityHistoryPoint[]; indexedSnapshots: number; present: number }
/** A node of the time-lapse: everything that exists in some frame. */
export interface EvolutionNode { id: string; kind: 'entity' | 'group'; type: string; name: string; detail?: string; language?: string; path?: string }
/**
 * One indexed commit of the time-lapse, as a change to the frame before it (the first: to an empty map).
 * `set`: nodes that appear, or whose parent, rectangle or measured lines changed: [node, parent (-1: none), x, y, w, h, loc (-1: not measured)].
 * `drop`: nodes no longer drawn. `changes`: entities changed since the previous frame: [node, 1 added | 2 modified | 3 moved | 4 removed (a ghost for one frame)].
 */
export interface EvolutionFrame { snapshot: string; set: number[][]; drop: number[]; changes: number[][] }
/** The history as frames on the timeline layout, computed in the background on first request. */
export type EvolutionResponse = { status: 'computing'; progress: number } | { status: 'ready'; stamp: string; nodes: EvolutionNode[]; frames: EvolutionFrame[] };

// Impact ----------------------------------------------------------------------
export interface ImpactHop { relationId: string; type: string; from: { id: string; name: string; type: string }; to: { id: string; name: string; type: string } }
/** An affected entity: hops from the origin, and the chain of relations that reaches it (origin first). */
export type ImpactItem = NodeSummary & { distance: number; breadcrumb: string; chain: ImpactHop[] };
export interface ImpactResult {
  origin: { kind: 'entity'; node: NodeSummary } | { kind: 'comparison'; byStatus: Record<string, number> };
  depth: number; types: string[];
  /** Entities the walk starts from (the origin and everything inside it, or a comparison's changed entities). */
  seeds: number; seedsTruncated: boolean;
  /** Affected entities, excluding seeds. */
  total: number;
  /** Index = hops from the origin (0 unused). */
  byDistance: number[];
  byType: { type: string; count: number }[];
  /** Every reached entity → hops (seeds are 0). */
  distances: Record<string, number>;
  /** Spatial containers holding affected entities: how many, and the nearest hop count. */
  areas: Record<string, { count: number; distance: number }>;
  items: Page<ImpactItem>;
  truncated: boolean;
  highlights: { endpoints: number; routes: number; applications: { id: string; name: string; count: number }[] };
  /** What the radius cannot see; the result is a lower bound. */
  unknowns: { unresolvedHttpCalls: number; possibleCallers: { name: string; sites: number; entities: number }[] };
}

// Steps -------------------------------------------------------------------------
export type { StepKind } from './steps.js';
export interface StepGuard { text: string; negated: boolean; form: string; line: number; phrase: string }
export interface Step {
  id: string; kind: import('./steps.js').StepKind; layer: number;
  node?: NodeSummary;
  effect?: import('../core/graph.js').EffectFact & { owner: string; ownerName: string; ownerPath?: string; when: StepGuard[] };
  /** Application the step belongs to. */
  app?: string;
  /** Spatial ancestors of the step's entity (of the effect's owner), root first: lets clients draw to the nearest visible ancestor. */
  ancestors: string[];
  /** An endpoint serving another page, reached by a request: navigation, not followed. */
  navigation?: boolean;
}
/** An entity folded into a link, with its spatial ancestors (root first). */
export interface FoldedEntity { id: string; name: string; type: string; ancestors: string[] }
export interface StepHop { relationId: string; type: string; from: string; to: string; file?: string; line?: number; sites: number; when: StepGuard[] }
export interface StepLink {
  id: string; from: string; to: string;
  /** Folded entities between the two steps, in order. */
  via: FoldedEntity[];
  hops: StepHop[];
  /** The event prop that binds the target (onClick, onSubmit…). */
  event?: string;
  /** Conditions in the source step's own code under which the link happens. */
  when: StepGuard[];
  /** The target was already drawn at the same or an earlier layer. */
  back: boolean;
}
export interface StepsResult { anchor: NodeSummary; steps: Step[]; links: StepLink[]; notices: string[] }

// Request flows -------------------------------------------------------------------
export type { FlowEdgeKind, FlowGap, FlowGapReason, FlowLane, FlowNodeKind, FlowStages, FlowStatus } from './request-flows.js';
export interface RequestFlowNode {
  id: string; lane: import('./request-flows.js').FlowLane; kind: import('./request-flows.js').FlowNodeKind;
  /** Sub-column inside the lane. */
  depth: number;
  label: string; detail?: string;
  /** The entity the node stands for (absent on effects, responses, middleware and gaps). */
  node?: NodeSummary;
  /** Spatial ancestors of the node's entity (of an effect's owner), root first. */
  ancestors: string[];
  effect?: import('../core/graph.js').EffectFact & { owner: string; ownerName: string; ownerPath?: string };
  status?: number; event?: string;
  gap?: import('./request-flows.js').FlowGap;
}
export interface RequestFlowEdge {
  id: string; from: string; to: string; kind: import('./request-flows.js').FlowEdgeKind; label?: string;
  /** Indexed relationships the edge stands for, in order (Why?). */
  hops: { relationId: string; type: string; from: string; to: string }[];
  /** Entities folded into the edge, in order. */
  via: FoldedEntity[];
  /** Conditions at the source site under which the edge happens. */
  when: StepGuard[];
}
export interface RequestFlowSummary {
  /** The endpoint's ID, or the calling entity's ID for an unmatched request. */
  id: string; kind: 'endpoint' | 'unmatched' | 'command' | 'schedule';
  name: string; method: string; path: string;
  /** Application of the endpoint (of the caller for an unmatched request). */
  app?: string;
  /** List grouping: the first path segment, or `unmatched`. */
  group: string;
  status: import('./request-flows.js').FlowStatus; stages: import('./request-flows.js').FlowStages;
  gaps: number; callers: number; tables: number; responses: number[];
  handler?: string;
  /** Unmatched requests: the entity making them. */
  caller?: string;
}
export interface RequestFlow extends RequestFlowSummary {
  anchor: NodeSummary;
  /** Lanes that hold at least one node, in request order. */
  lanes: import('./request-flows.js').FlowLane[];
  nodes: RequestFlowNode[]; edges: RequestFlowEdge[];
  notices: string[];
}
export interface RequestFlowList {
  items: RequestFlowSummary[];
  counts: Record<import('./request-flows.js').FlowStatus, number>;
  /** `entity` filter: the flows that draw this entity. */
  entity?: string;
}

// Flow catalog and coverage -------------------------------------------------------
export type { CatalogKind, CoverageCategory, CoverageCounts } from './catalog.js';
/** One flow of the catalog: where it starts and what it touches. */
export interface FlowSummary {
  /** The entry entity's ID (the endpoint, page route, command, task, or the entity making unmatched requests). */
  id: string; kind: import('./catalog.js').CatalogKind;
  entry: { id: string; type: string; name: string };
  name: string; app?: string;
  /** List grouping: first path segment, command namespace, `scheduler` or `unmatched`. */
  group: string;
  method?: string; path?: string;
  /** How the detail is drawn: lanes (`/request-flows/:id`) or the Steps picture of a page (`/steps/:id`). */
  detail: 'lanes' | 'steps';
  /** Lanes flows: completeness and what was found. */
  status?: import('./request-flows.js').FlowStatus; stages?: import('./request-flows.js').FlowStages;
  gaps?: number; tables?: number; responses?: number[]; handler?: string; callers?: number;
  /** Scheduled tasks: when they run. */
  cadence?: string;
  /** Size of the slice: entities and distinct files it touches. */
  entities: number; files: number;
  truncated?: boolean;
  /** Language-model annotation (`annotate`): what the flow lets someone do, and who starts it. */
  title?: string; goal?: string; actor?: string;
}
export interface FlowList {
  items: FlowSummary[];
  counts: Record<import('./catalog.js').CatalogKind, number>;
  /** `entity` filter: the flows touching this entity (or anything inside it). */
  entity?: string;
}
/** File coverage by flows, per file (code and assets) and rolled up per area. */
export interface CoverageResult {
  totals: import('./catalog.js').CoverageCounts;
  /** Code files measured (assets and code whose calls are not analyzed excluded). */
  codeFiles: number;
  flows: number;
  /** Per file: category and the number of flows touching it. */
  files: Record<string, { category: import('./catalog.js').CoverageCategory; flows: number }>;
  /** Per area (spatial ancestors of files): counts by category. */
  areas: Record<string, import('./catalog.js').CoverageCounts>;
}
/** Code no flow is proven to use, for review (by a person or a language model): files, and unused symbols in files flows do reach. */
export interface CoverageExport {
  repository: string; generatedAt: string; snapshot?: string;
  /** How to read the lists, and what the analyzers cannot see. */
  about: string[];
  totals: import('./catalog.js').CoverageCounts; codeFiles: number; flows: number;
  /** Not reached, and possibly reached by a name the analyzers could not resolve ("explained"). */
  files: { path: string; category: 'unreached' | 'explained'; reason: string; language?: string; loc?: number; symbols: CoverageExportSymbol[] }[];
  /** Functions, methods and components in reached files that nothing indexed calls, renders, routes to or references. */
  symbols: (CoverageExportSymbol & { path: string; fileCategory: import('./catalog.js').CoverageCategory })[];
}
export interface CoverageExportSymbol {
  name: string; type: string; qualifiedName?: string; startLine?: number; endLine?: number;
  /** Unresolved call sites anywhere that call this name: it may be used after all. */
  possiblyCalledByName?: number;
  note?: string;
}
export interface CoverageDetail {
  id: string;
  /** Files: their category and why. Areas: counts below them. */
  category?: import('./catalog.js').CoverageCategory; reason?: string;
  counts?: import('./catalog.js').CoverageCounts;
  /** Flows touching the entity (or anything inside it), first 50. */
  flows: FlowSummary[]; totalFlows: number;
}

// Annotations (language models) ----------------------------------------------------
/** A domain: a feature or area of the product, and the number of code files serving it. */
export interface DomainSummary { key: string; name: string; summary: string; files: number; color: number }
export interface AnnotationsOverview {
  available: boolean;
  overview?: { summary: string; applications: { name: string; summary: string }[]; start: string[] };
  domains: DomainSummary[];
  /** Annotations per kind, with their mean ASD-STE100 score (0..1). */
  counts: Record<string, { count: number; ste: number }>;
  models: string[];
  /** Spend of the latest run, and of every run. */
  cost?: { last: number; total: number };
}
export interface EntityAnnotation {
  id: string; summary?: string; role?: string;
  domain?: { key: string; name: string; inferred: boolean };
  model?: string; ste?: number; createdAt?: string;
  /** The description was made from another version of this code. */
  outdated?: boolean;
}

