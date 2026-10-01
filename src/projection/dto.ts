// Wire types for projection and source endpoints. Type-only: shared with the
// web client without pulling server code into the browser bundle.
import type { AnalysisRun, Diagnostic, SourceRange } from '../core/graph.js';
import type { Rect } from './layout.js';

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
}
export interface Page<T> { items: T[]; limit: number; offset: number; total: number; hasMore: boolean }
export interface ProjectionMeta {
  run: AnalysisRun;
  root: NodeSummary;
  layout: { version: number; persisted: boolean; holes: number; bounds?: Rect };
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
}
export type RelationsPage = Page<RelationItem> & { typeCounts: { type: string; direction: string; count: number }[] };
export interface AggregateGroup { anchor: NodeSummary; anchorAncestors: string[]; type: string; direction: string; count: number }
export interface AggregateResult { internal: { type: string; count: number }[]; groups: AggregateGroup[]; totalCrossing: number; truncated: boolean }
export type AggregateEdgesPage = Page<RelationItem & { inside: NodeSummary }>;
export type DiagnosticItem = Omit<Diagnostic, 'resolution' | 'severity'> & { severity: string; nodeId: string; nodeName: string };
export type DiagnosticsPage = Page<DiagnosticItem> & { codes: { code: string; severity: string; count: number }[] };
export interface SourceRequest { entity?: string; relation?: string; diagnostic?: string; evidence?: number; start?: number; end?: number }
export interface SourceResponse {
  file: { id: string; path: string; language?: string };
  totalLines: number; start: number; end: number; lines: string[];
  focus?: { startLine: number; endLine: number; kind: 'symbol' | 'evidence' | 'diagnostic' | 'file'; label: string };
  indexedHash?: string; currentHash: string; changedSinceIndex: boolean; truncated: boolean; notices: string[];
}
