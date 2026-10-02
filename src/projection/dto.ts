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
export interface ViewKey { snapshot?: string; compareTo?: string }
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
}
export interface TimelineResponse {
  available: boolean; reason?: string;
  ref?: string; head?: string; firstParent: boolean;
  /** Oldest first. */
  entries: TimelineEntry[];
  workingTree?: SnapshotRef & { stats: { entities: number } };
  indexing: { enabled: boolean; active?: string; queued: string[]; failed: { sha: string; error: string }[] };
}
export interface EntityHistoryPoint { sha: string; snapshotId: string; status: 'introduced' | 'modified' | 'moved' | 'removed' | 'reintroduced'; name: string; path?: string }
export interface EntityHistoryResponse { id: string; points: EntityHistoryPoint[]; indexedSnapshots: number; present: number }
