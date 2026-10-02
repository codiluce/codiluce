// Read-only projection queries for the visualizer. A *view* is one snapshot
// (the live working-tree index, or a stored commit snapshot), optionally
// compared with a baseline snapshot. Views are built from SQLite on first use
// and cached; a new analysis run or snapshot simply becomes a new view.
//
// Layout: the live view (no snapshot parameters) carries slots forward in
// layout.json, compact for today's tree. History views (any snapshot or
// comparison) use the timeline layout (projection/layout.ts): one union of
// every slot in history, so nothing moves while moving through commits, and
// comparison views keep removed entities in their places as ghosts.
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { computeDiff, type EntityChange, type SnapshotDiff } from '../history/diff.js';
import { canonicalJson, withoutPositions } from '../history/fingerprint.js';
import { renamedPaths } from '../history/git.js';
import { CommitSnapshot, WorkingTreeSnapshot, type SnapshotData, type SnapshotSource } from '../history/snapshot.js';
import type { EntityHistoryRow, HistoryStore } from '../history/store.js';
import { lineDiff } from '../history/textdiff.js';
import { pagination, type GraphStore } from '../storage/sqlite.js';
import type { Entity, Relation } from '../core/graph.js';
import { extendRegistry, LAYOUT_VERSION, TIMELINE_LAYOUT_VERSION, layoutHierarchy, placeOnTimeline, timelineLayout, type LayoutState, type Rect, type TimelineLayout, type TimelineRegistry } from './layout.js';
import { ProjectionIndex, type EntityRow, type ProjectionNode, type RelationRow } from './hierarchy.js';
import { readSnapshotFile, readSnapshotSource, snapshotRef, SourceError, splitLines, type SourceRequest, type SourceResponse } from './source.js';
import type { AggregateResult, ChangesPage, DiagnosticItem, DiagnosticsPage, EntityChangeDetail, EntityHistoryResponse, EntitySide, LocateResult, NodeChange, NodeSummary, Page, ProjectionMeta, RelationItem, RelationsPage, SearchPage, SourceDiffResponse, SourceDiffSide, ViewKey } from './dto.js';
export type { NodeSummary, Page, RelationItem, ViewKey } from './dto.js';
export class NotFoundError extends Error {}
interface View {
  key: string;
  target: SnapshotSource; baseline?: SnapshotSource;
  targetData: SnapshotData; baselineData?: SnapshotData;
  index: ProjectionIndex; rects: Map<string, Rect>;
  persisted: boolean; holes: number; layoutSource: 'timeline' | 'persisted' | 'fresh';
  diff?: SnapshotDiff;
  addedDiagnostics: Set<string>;
}
const SEVERITY_ORDER: Record<string, number> = { error: 0, warning: 1, info: 2 };
const STATUS_ORDER: Record<string, number> = { added: 0, removed: 1, moved: 2, modified: 3, unchanged: 4 };
const TYPE_ORDER: Record<string, number> = { application: 0, directory: 1, file: 2, route: 3, api_endpoint: 3 };
const VIEW_CACHE = 6, DATA_CACHE = 10;
export interface ProjectionOptions {
  stateDirectory?: string;
  /** Repository root: Git rename detection for comparisons, and source reading. */
  root?: string;
  /** Read-only history store, when one exists. */
  history?: () => HistoryStore | undefined;
}

export class ProjectionService {
  private readonly views = new Map<string, View>();
  private readonly data = new Map<string, SnapshotData>();
  private readonly renames = new Map<string, Map<string, string>>();
  private timeline?: { stamp: string; registry: TimelineRegistry; snapshots: Set<string>; layouts: Map<string, { registry: TimelineRegistry; layout: TimelineLayout }> };
  constructor(private readonly store: GraphStore, private readonly options: ProjectionOptions = {}) {}

  // Snapshots and views ---------------------------------------------------------------
  /** Undefined, `current` or the live run's ID: the working-tree index; otherwise a stored snapshot ID. */
  snapshotSource(id?: string): SnapshotSource {
    const run = this.store.currentRun();
    if (id === undefined || id === '' || id === 'current' || id === run?.id) {
      if (!run) throw new NotFoundError('No indexed graph; run index first');
      return new WorkingTreeSnapshot(this.store, this.options.root, run);
    }
    const history = this.options.history?.();
    const record = history?.snapshot(id);
    if (!history || !record) throw new NotFoundError(`Unknown snapshot ${id}`);
    return new CommitSnapshot(history, record, this.options.root);
  }
  private sources(view: ViewKey = {}): { target: SnapshotSource; baseline?: SnapshotSource } {
    const target = this.snapshotSource(view.snapshot);
    const baseline = view.compareTo ? this.snapshotSource(view.compareTo) : undefined;
    return { target, ...(baseline && baseline.info.id !== target.info.id ? { baseline } : {}) };
  }
  private renameKey(baseline: SnapshotSource, target: SnapshotSource): string | undefined {
    if (!baseline.info.commitSha || !target.info.commitSha) return undefined;
    return `${baseline.info.kind === 'working_tree' ? 'worktree' : baseline.info.commitSha}..${target.info.kind === 'working_tree' ? 'worktree' : target.info.commitSha}`;
  }
  /** Asynchronous inputs of a view (Git rename detection), fetched before it is built. HTTP requests always prepare. */
  async prepare(view: ViewKey = {}): Promise<void> {
    const { target, baseline } = this.sources(view);
    const key = baseline ? this.renameKey(baseline, target) : undefined;
    if (!baseline || !key || this.renames.has(key) || !this.options.root) return;
    let renames = new Map<string, string>();
    try {
      if (baseline.info.kind === 'working_tree') renames = new Map([...await renamedPaths(this.options.root, target.info.commitSha!)].map(([from, to]) => [to, from]));
      else renames = await renamedPaths(this.options.root, baseline.info.commitSha!, target.info.kind === 'working_tree' ? undefined : target.info.commitSha);
    } catch { /* no Git: lineage still uses names and fingerprints */ }
    this.renames.set(key, renames);
    if (this.renames.size > 32) this.renames.delete(this.renames.keys().next().value!);
  }
  private snapshotData(source: SnapshotSource): SnapshotData {
    const cached = this.data.get(source.info.id);
    if (cached) { this.data.delete(source.info.id); this.data.set(source.info.id, cached); return cached; }
    const loaded = source.load();
    this.data.set(source.info.id, loaded);
    if (this.data.size > DATA_CACHE) this.data.delete(this.data.keys().next().value!);
    return loaded;
  }
  /** The timeline registry as last saved by the history indexer (re-read when it changes). */
  private timelineBase(): { stamp: string; registry: TimelineRegistry } | undefined {
    const history = this.options.history?.();
    if (!history) return undefined;
    const row = history.db.prepare("SELECT json_array_length(snapshots) AS n, json_extract(snapshots, '$[#-1]') AS last, json_extract(state, '$.version') AS version FROM layout_registry WHERE id=1").get();
    if (!row || !Number(row.n) || row.version !== TIMELINE_LAYOUT_VERSION) return undefined;
    const stamp = `${row.n}:${row.last}`;
    if (this.timeline?.stamp !== stamp) {
      const saved = history.layoutRegistry()!;
      this.timeline = { stamp, registry: saved.state, snapshots: new Set(saved.snapshots), layouts: new Map() };
    }
    return this.timeline;
  }
  /** The union layout covering the registry plus any snapshot of this view it does not include yet (e.g. the live working tree). */
  private timelineFor(sources: SnapshotSource[], rootId: string): { registry: TimelineRegistry; layout: TimelineLayout } | undefined {
    const base = this.timelineBase();
    if (!base) return undefined;
    const timeline = this.timeline!;
    const extras = sources.filter(source => !timeline.snapshots.has(source.info.id));
    const key = extras.map(source => source.info.id).sort().join(',');
    let entry = timeline.layouts.get(key);
    if (!entry) {
      const registry = extras.length ? structuredClone(base.registry) : base.registry;
      for (const source of extras) { const own = new ProjectionIndex(source.info.id, this.snapshotData(source).entities, [], []); extendRegistry(registry, own.layoutNodes(), own.rootId); }
      entry = { registry, layout: timelineLayout(registry, rootId) };
      timeline.layouts.set(key, entry);
      if (timeline.layouts.size > 4) timeline.layouts.delete(timeline.layouts.keys().next().value!);
    }
    return entry;
  }
  private load(view: ViewKey = {}): View {
    const { target, baseline } = this.sources(view);
    // Any snapshot parameter selects the timeline layout (when history exists); none is the live, compact map.
    const historical = !!(view.snapshot || view.compareTo) && !!this.timelineBase();
    const key = `${target.info.id}|${baseline?.info.id ?? ''}|${historical ? this.timeline!.stamp : 'live'}`;
    const cached = this.views.get(key);
    if (cached) { this.views.delete(key); this.views.set(key, cached); return cached; }
    const targetData = this.snapshotData(target);
    let rows: EntityRow[] = targetData.entities, relations: RelationRow[] = targetData.relations;
    let diff: SnapshotDiff | undefined, baselineData: SnapshotData | undefined;
    const addedDiagnostics = new Set<string>();
    if (baseline) {
      baselineData = this.snapshotData(baseline);
      const renameKey = this.renameKey(baseline, target);
      diff = computeDiff(baselineData, targetData, (renameKey && this.renames.get(renameKey)) || new Map());
      const previous = new Map(baselineData.entities.map(entity => [entity.id, entity]));
      const attach = (row: EntityRow): EntityRow => {
        const change = diff!.changes.get(row.id);
        return change ? { ...row, change: nodeChange(change, row, change.status === 'added' || change.status === 'removed' ? undefined : previous.get(change.previousId ?? row.id)) } : row;
      };
      rows = [...targetData.entities.map(attach), ...diff.ghosts.map(attach)];
      const added = new Set(diff.addedRelations.map(relation => relation.id));
      relations = [...targetData.relations.map(relation => added.has(relation.id) ? { ...relation, change: 'added' as const } : relation), ...diff.removedRelations.map(relation => ({ ...relation, change: 'removed' as const }))];
      for (const item of diff.addedDiagnostics) addedDiagnostics.add(item.id);
    }
    const index = new ProjectionIndex(target.info.id, rows, relations, targetData.diagnostics, !!baseline);
    let result, persisted = false, layoutSource: View['layoutSource'] = 'fresh';
    const timeline = historical ? this.timelineFor(baseline ? [target, baseline] : [target], index.rootId) : undefined;
    if (timeline) { result = placeOnTimeline(index.layoutNodes(), index.rootId, timeline.registry, timeline.layout); layoutSource = 'timeline'; }
    else if (target.info.kind === 'working_tree' && !baseline && this.options.stateDirectory) {
      const file = path.join(this.options.stateDirectory, 'layout.json');
      const run = target.info.run;
      let previous: LayoutState | undefined;
      try { const parsed = JSON.parse(readFileSync(file, 'utf8')) as LayoutState & { repositoryId?: string }; if (parsed.version === LAYOUT_VERSION && parsed.repositoryId === run.repositoryId) previous = parsed; } catch { /* first layout or unreadable state: start fresh */ }
      result = layoutHierarchy(index.layoutNodes(), index.rootId, previous);
      try {
        const temporary = `${file}.${process.pid}.tmp`;
        writeFileSync(temporary, JSON.stringify({ ...result.state, repositoryId: run.repositoryId, runId: run.id }));
        renameSync(temporary, file); persisted = true; layoutSource = 'persisted';
      } catch { /* read-only state directory: layout is still deterministic for this graph */ }
    } else result = layoutHierarchy(index.layoutNodes(), index.rootId);
    const built: View = { key, target, ...(baseline ? { baseline } : {}), targetData, ...(baselineData ? { baselineData } : {}), index, rects: result.rects, persisted, holes: result.holes, layoutSource, ...(diff ? { diff } : {}), addedDiagnostics };
    this.views.set(key, built);
    if (this.views.size > VIEW_CACHE) this.views.delete(this.views.keys().next().value!);
    return built;
  }
  private summary(current: View, node: ProjectionNode): NodeSummary {
    return {
      id: node.id, kind: node.kind, type: node.type, name: node.name,
      ...(node.path ? { path: node.path } : {}), ...(node.language ? { language: node.language } : {}), ...(node.sourceRange ? { sourceRange: node.sourceRange } : {}),
      ...(node.canonicalParentId ? { canonicalParentId: node.canonicalParentId } : {}), ...(node.spatialParentId ? { spatialParentId: node.spatialParentId } : {}),
      depth: node.depth, rect: current.rects.get(node.id)!, childCount: node.children.length,
      ...(node.loc !== undefined ? { loc: node.loc } : {}), ...(node.detail ? { detail: node.detail } : {}), ...(node.qualifiedName ? { qualifiedName: node.qualifiedName } : {}),
      ...(node.role ? { role: node.role } : {}), ...(node.explanation ? { explanation: node.explanation } : {}),
      diagnostics: node.diagnostics, stats: node.stats,
      ...(node.change ? { change: node.change } : {}), ...(node.changes && (node.changes.added || node.changes.removed || node.changes.modified || node.changes.moved) ? { changes: node.changes } : {}),
    };
  }
  private require(current: View, id: string): ProjectionNode {
    const node = current.index.node(id);
    if (!node) throw new NotFoundError(`Unknown projection node ${id}`);
    return node;
  }

  // Queries -------------------------------------------------------------------------
  meta(view?: ViewKey): ProjectionMeta {
    const current = this.load(view);
    const root = current.index.node(current.index.rootId)!;
    const data = current.targetData;
    const tally = <T>(items: T[], key: (item: T) => string) => { const counts = new Map<string, number>(); for (const item of items) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1); return [...counts].sort((a, b) => a[0] < b[0] ? -1 : 1); };
    const history = this.options.history?.();
    const snapshots = history ? Number(history.db.prepare('SELECT count(*) AS count FROM snapshots').get()!.count) : 0;
    const relationTypes = tally(data.relations, item => item.type);
    const containment = data.entities.filter(entity => entity.parentId).length;
    return {
      run: current.target.info.run,
      snapshot: snapshotRef(current.target),
      ...(current.baseline && current.diff ? { comparison: { baseline: snapshotRef(current.baseline), summary: current.diff.summary, analyzerMismatch: JSON.stringify(current.baseline.info.run.analyzerVersions) !== JSON.stringify(current.target.info.run.analyzerVersions) } } : {}),
      history: { available: !!history, snapshots },
      root: this.summary(current, root),
      layout: { version: LAYOUT_VERSION, persisted: current.persisted, holes: current.holes, bounds: current.rects.get(root.id), source: current.layoutSource },
      entityTypes: tally(data.entities, item => item.type).map(([type, count]) => ({ type, count })),
      relationTypes: [...relationTypes, ...(containment ? [['contains', containment] as [string, number]] : [])].sort((a, b) => a[0] < b[0] ? -1 : 1).map(([type, count]) => ({ type, count })),
      diagnosticSeverities: tally(data.diagnostics, item => item.severity).map(([severity, count]) => ({ severity, count })),
      coverage: {
        databaseTables: data.entities.filter(entity => entity.type === 'database_table').length,
        resolvedHttpRequests: data.relations.filter(relation => relation.type === 'requests').length,
        unresolvedHttpCalls: data.diagnostics.filter(item => ['unresolved-http-call', 'unresolved-http-url', 'unmatched-http-call', 'ambiguous-http-match', 'constrained-http-match', 'unverified-relative-api-boundary'].includes(item.code)).length,
        calls: data.relations.filter(relation => relation.type === 'calls' || relation.type === 'renders').length,
        gitHistory: snapshots,
      },
    };
  }
  children(id: string, options: { limit?: number; offset?: number; view?: ViewKey }): Page<NodeSummary> {
    const current = this.load(options.view);
    const node = this.require(current, id);
    const { limit, offset } = pagination(options);
    const ids = node.children.slice(offset, offset + limit);
    return { items: ids.map(child => this.summary(current, current.index.node(child)!)), limit, offset, total: node.children.length, hasMore: offset + limit < node.children.length };
  }
  nodes(ids: string[], view?: ViewKey): { items: NodeSummary[]; missing: string[] } {
    if (ids.length > 200) throw new Error('At most 200 ids per request');
    const current = this.load(view);
    const items: NodeSummary[] = [], missing: string[] = [];
    for (const id of ids) { const node = current.index.node(id); if (node) items.push(this.summary(current, node)); else missing.push(id); }
    return { items, missing };
  }
  locate(id: string, view?: ViewKey): LocateResult {
    const current = this.load(view);
    const node = this.require(current, id);
    return {
      node: this.summary(current, node),
      spatialAncestors: current.index.spatialAncestors(node).map(item => this.summary(current, item)),
      canonicalAncestors: current.index.canonicalAncestors(node).map(item => ({ id: item.id, type: item.type, name: item.name })),
    };
  }
  /**
   * The ID an entity has in this view: itself, or where lineage carried it.
   * `from` names the snapshot the ID came from (e.g. the previously viewed
   * one): lineage from it to this view's snapshot bridges renames in either
   * direction of time. Call `prepare` for that pair first for Git renames.
   */
  resolve(id: string, view?: ViewKey, from?: string): { id: string; via?: 'lineage' } | undefined {
    const current = this.load(view);
    const present = (candidate: string | undefined) => !!candidate && !!current.index.node(candidate) && current.index.node(candidate)!.change?.status !== 'removed';
    if (current.index.node(id)) return { id };
    const mapped = current.diff?.lineage.forward.get(id);
    if (present(mapped)) return { id: mapped!, via: 'lineage' };
    if (from && from !== current.target.info.id) {
      const bridged = this.load({ ...(view?.snapshot ? { snapshot: view.snapshot } : {}), compareTo: from }).diff?.lineage.forward.get(id);
      if (present(bridged)) return { id: bridged!, via: 'lineage' };
    }
    return undefined;
  }
  search(query: string, options: { type?: string; limit?: number; offset?: number; view?: ViewKey }): SearchPage {
    const { limit, offset } = pagination({ limit: options.limit ?? 30, offset: options.offset });
    const text = query.trim().toLowerCase();
    if (!text) throw new Error('search query is required');
    if (text.length > 200) throw new Error('search must be at most 200 characters');
    const current = this.load(options.view);
    const tokens = text.split(/\s+/);
    const scored: { node: ProjectionNode; score: number }[] = [];
    const typeCounts = new Map<string, number>();
    for (const node of current.index.nodes.values()) {
      if (node.kind !== 'entity' || !tokens.every(token => node.search.includes(token))) continue;
      typeCounts.set(node.type, (typeCounts.get(node.type) ?? 0) + 1);
      if (options.type && node.type !== options.type) continue;
      const name = node.name.toLowerCase(), qualified = node.qualifiedName?.toLowerCase();
      // Multi-word queries (e.g. "LoginForm.tsx login") rank by the word that best matches the name.
      const rank = (term: string) => name === term ? 0 : qualified === term || qualified?.endsWith(`\\${term}`) || qualified?.endsWith(`::${term}`) || qualified?.endsWith(`.${term}`) ? 1 : name.startsWith(term) ? 2 : name.includes(term) ? 3 : qualified?.includes(term) ? 4 : 5;
      scored.push({ node, score: Math.min(rank(text), ...(tokens.length > 1 ? tokens.map(rank) : [])) });
    }
    scored.sort((a, b) => a.score - b.score || a.node.name.length - b.node.name.length || a.node.depth - b.node.depth || (a.node.name < b.node.name ? -1 : a.node.name > b.node.name ? 1 : a.node.id < b.node.id ? -1 : 1));
    const items = scored.slice(offset, offset + limit).map(({ node }) => ({ ...this.summary(current, node), breadcrumb: current.index.canonicalAncestors(node).slice(1).map(item => item.name).join(' › ') }));
    return { items, limit, offset, total: scored.length, hasMore: offset + limit < scored.length, typeCounts: [...typeCounts].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count || (a.type < b.type ? -1 : 1)) };
  }
  private relationItems(current: View, indices: number[], perspective: (index: number) => { direction: RelationItem['direction']; otherId: string }): RelationItem[] {
    const relations = indices.map(index => current.index.relations[index]!);
    const removed = relations.filter(relation => relation.change === 'removed').map(relation => relation.id);
    const present = relations.filter(relation => relation.change !== 'removed').map(relation => relation.id);
    const metadata = new Map([...current.target.relationMetadata(present), ...(current.baseline && removed.length ? current.baseline.relationMetadata(removed) : [])]);
    return indices.map(index => {
      const relation = current.index.relations[index]!;
      const { direction, otherId } = perspective(index);
      const other = current.index.node(otherId)!;
      return { id: relation.id, type: relation.type, direction, other: this.summary(current, other), otherAncestors: current.index.spatialAncestors(other).map(node => node.id), ...(metadata.has(relation.id) ? { metadata: metadata.get(relation.id) } : {}), ...(relation.change ? { change: relation.change } : {}) };
    });
  }
  relations(id: string, options: { direction?: string; type?: string; limit?: number; offset?: number; view?: ViewKey }): RelationsPage {
    const current = this.load(options.view);
    const node = this.require(current, id);
    const { limit, offset } = pagination(options);
    const direction = options.direction ?? 'both';
    if (!['incoming', 'outgoing', 'both'].includes(direction)) throw new Error('direction must be incoming, outgoing or both');
    const all = (current.index.adjacency.get(node.id) ?? []).map(index => {
      const relation = current.index.relations[index]!;
      const dir: RelationItem['direction'] = relation.from === relation.to ? 'self' : relation.from === node.id ? 'outgoing' : 'incoming';
      return { index, relation, direction: dir, otherId: dir === 'incoming' ? relation.from : relation.to };
    });
    const counts = new Map<string, number>();
    for (const item of all) { const key = `${item.relation.type}\u0000${item.direction}`; counts.set(key, (counts.get(key) ?? 0) + 1); }
    const filtered = all.filter(item => (direction === 'both' || item.direction === direction || item.direction === 'self') && (!options.type || item.relation.type === options.type));
    const rank = { outgoing: 0, self: 1, incoming: 2 };
    filtered.sort((a, b) => rank[a.direction] - rank[b.direction] || (a.relation.type < b.relation.type ? -1 : a.relation.type > b.relation.type ? 1 : 0) || compareNames(current, a.otherId, b.otherId) || (a.relation.id < b.relation.id ? -1 : 1));
    const page = filtered.slice(offset, offset + limit);
    const lookup = new Map(page.map(item => [item.index, item]));
    return {
      items: this.relationItems(current, page.map(item => item.index), index => lookup.get(index)!),
      limit, offset, total: filtered.length, hasMore: offset + limit < filtered.length,
      typeCounts: [...counts].map(([key, count]) => { const [type, dir] = key.split('\u0000'); return { type: type!, direction: dir!, count }; }).sort((a, b) => a.type < b.type ? -1 : a.type > b.type ? 1 : a.direction < b.direction ? -1 : 1),
    };
  }
  /** Classify every non-containment relation touching the subtree of `container`. */
  private crossing(current: View, container: ProjectionNode, filter: { type?: string; direction?: string }) {
    const index = current.index;
    const ancestors = new Set([container.id, ...index.spatialAncestors(container).map(node => node.id)]);
    const anchorOf = (id: string): string => {
      // The anchor is the outside endpoint's ancestor just below the lowest common ancestor with the container.
      let previous = id;
      for (let node = index.node(id); node; node = node.spatialParentId ? index.node(node.spatialParentId) : undefined) {
        if (ancestors.has(node.id)) return node.id === id ? id : previous;
        previous = node.id;
      }
      return previous;
    };
    const internal = new Map<string, number>();
    const crossing: { relationIndex: number; direction: 'outgoing' | 'incoming'; anchor: string; type: string; outside: string }[] = [];
    index.relations.forEach((relation, relationIndex) => {
      // Aggregates describe the viewed snapshot; removed relations are listed per entity instead.
      if (relation.change === 'removed') return;
      if (filter.type && relation.type !== filter.type) return;
      const fromInside = index.contains(container, index.node(relation.from)!), toInside = index.contains(container, index.node(relation.to)!);
      if (fromInside && toInside) { internal.set(relation.type, (internal.get(relation.type) ?? 0) + 1); return; }
      if (!fromInside && !toInside) return;
      const direction: 'outgoing' | 'incoming' = fromInside ? 'outgoing' : 'incoming';
      if (filter.direction && filter.direction !== 'both' && filter.direction !== direction) return;
      const outside = fromInside ? relation.to : relation.from;
      crossing.push({ relationIndex, direction, anchor: anchorOf(outside), type: relation.type, outside });
    });
    return { internal, crossing };
  }
  aggregate(id: string, options: { type?: string; direction?: string; view?: ViewKey }): AggregateResult {
    const current = this.load(options.view);
    const container = this.require(current, id);
    const { internal, crossing } = this.crossing(current, container, options);
    const groups = new Map<string, { anchor: string; type: string; direction: string; count: number }>();
    for (const item of crossing) {
      const key = `${item.direction}\u0000${item.type}\u0000${item.anchor}`;
      const group = groups.get(key) ?? { anchor: item.anchor, type: item.type, direction: item.direction, count: 0 };
      group.count++; groups.set(key, group);
    }
    const sorted = [...groups.values()].sort((a, b) => b.count - a.count || (a.direction < b.direction ? -1 : a.direction > b.direction ? 1 : 0) || (a.type < b.type ? -1 : a.type > b.type ? 1 : 0) || (a.anchor < b.anchor ? -1 : 1));
    return {
      internal: [...internal].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count || (a.type < b.type ? -1 : 1)),
      groups: sorted.slice(0, 200).map(group => { const anchor = current.index.node(group.anchor)!; return { ...group, anchor: this.summary(current, anchor), anchorAncestors: current.index.spatialAncestors(anchor).map(node => node.id) }; }),
      totalCrossing: crossing.length, truncated: sorted.length > 200,
    };
  }
  aggregateEdges(id: string, options: { anchor: string; type?: string; direction?: string; limit?: number; offset?: number; view?: ViewKey }): Page<RelationItem & { inside: NodeSummary }> {
    const current = this.load(options.view);
    const container = this.require(current, id);
    this.require(current, options.anchor);
    const { limit, offset } = pagination(options);
    const { crossing } = this.crossing(current, container, options);
    const matching = crossing.filter(item => item.anchor === options.anchor);
    matching.sort((a, b) => compareNames(current, a.outside, b.outside) || a.relationIndex - b.relationIndex);
    const page = matching.slice(offset, offset + limit);
    const lookup = new Map(page.map(item => [item.relationIndex, item]));
    const items = this.relationItems(current, page.map(item => item.relationIndex), index => ({ direction: lookup.get(index)!.direction, otherId: lookup.get(index)!.outside })).map((item, i) => {
      const relation = current.index.relations[page[i]!.relationIndex]!;
      return { ...item, inside: this.summary(current, current.index.node(item.direction === 'outgoing' ? relation.from : relation.to)!) };
    });
    return { items, limit, offset, total: matching.length, hasMore: offset + limit < matching.length };
  }
  diagnostics(id: string, options: { limit?: number; offset?: number; severity?: string; view?: ViewKey }): DiagnosticsPage {
    const current = this.load(options.view);
    const node = this.require(current, id);
    const { limit, offset } = pagination(options);
    const range = node.kind === 'entity' && node.type !== 'file' && node.path && node.sourceRange ? node.sourceRange : undefined;
    const matching = current.index.diagnostics.filter(item => {
      const owner = current.index.node(item.nodeId)!;
      if (current.index.contains(node, owner)) return true;
      // File-level findings that fall inside a symbol's indexed source range.
      return !!range && item.file === node.path && item.line !== undefined && item.line >= range.startLine && item.line <= range.endLine;
    });
    const codes = new Map<string, { code: string; severity: string; count: number }>();
    for (const item of matching) { const key = `${item.severity}\u0000${item.code}`; const entry = codes.get(key) ?? { code: item.code, severity: item.severity, count: 0 }; entry.count++; codes.set(key, entry); }
    const filtered = matching.filter(item => !options.severity || item.severity === options.severity);
    filtered.sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 3) - (SEVERITY_ORDER[b.severity] ?? 3) || (a.file ?? '').localeCompare(b.file ?? '', 'en') || (a.line ?? 0) - (b.line ?? 0) || (a.id < b.id ? -1 : 1));
    return {
      items: filtered.slice(offset, offset + limit).map(item => ({ ...item, nodeName: current.index.node(item.nodeId)!.name, ...(current.addedDiagnostics.has(item.id) ? { change: 'added' as const } : {}) })),
      limit, offset, total: filtered.length, hasMore: offset + limit < filtered.length,
      codes: [...codes.values()].sort((a, b) => b.count - a.count || (a.code < b.code ? -1 : 1)),
    };
  }
  between(a: string, b: string, view?: ViewKey): { items: RelationItem[] } {
    const current = this.load(view);
    this.require(current, a); this.require(current, b);
    const indices = (current.index.adjacency.get(a) ?? []).filter(index => { const relation = current.index.relations[index]!; return relation.change !== 'removed' && ((relation.from === a && relation.to === b) || (relation.from === b && relation.to === a)); });
    return { items: this.relationItems(current, indices, index => { const relation = current.index.relations[index]!; return relation.from === a ? { direction: 'outgoing', otherId: b } : { direction: 'incoming', otherId: b }; }) };
  }
  /** Full entity record as of the view (a removed entity reads from the baseline). */
  entity(id: string, view?: ViewKey): Entity | undefined {
    const { target, baseline } = this.sources(view);
    return target.entity(id) ?? baseline?.entity(id);
  }
  relation(id: string, view?: ViewKey): Relation | undefined {
    const { target, baseline } = this.sources(view);
    return target.relation(id) ?? baseline?.relation(id);
  }
  async source(request: SourceRequest, maxFileBytes: number, view?: ViewKey): Promise<SourceResponse> {
    const { target, baseline } = this.sources(view);
    if (request.side !== undefined && request.side !== 'baseline') throw new SourceError(400, 'side must be baseline');
    return readSnapshotSource(baseline ? request.side === 'baseline' ? [baseline] : [target, baseline] : [target], maxFileBytes, request);
  }

  // Comparison ----------------------------------------------------------------------
  private comparison(view?: ViewKey): View & { diff: SnapshotDiff; baseline: SnapshotSource; baselineData: SnapshotData } {
    if (!view?.compareTo) throw new Error('compareTo is required');
    const current = this.load(view);
    if (!current.diff) throw new Error('A snapshot cannot be compared with itself');
    return current as View & { diff: SnapshotDiff; baseline: SnapshotSource; baselineData: SnapshotData };
  }
  /** Changed entities of a comparison, grouped by status, then by structural level. */
  changes(view: ViewKey, options: { status?: string; type?: string; limit?: number; offset?: number }): ChangesPage {
    const current = this.comparison(view);
    const { limit, offset } = pagination(options);
    const statusCounts: Record<string, number> = {};
    const matching: ProjectionNode[] = [];
    for (const [id, change] of current.diff.changes) {
      if (change.status === 'unchanged') continue;
      const node = current.index.node(id);
      if (!node || node.kind !== 'entity' || node.type === 'repository') continue;
      if (options.type && node.type !== options.type) continue;
      statusCounts[change.status] = (statusCounts[change.status] ?? 0) + 1;
      if (!options.status || options.status === change.status) matching.push(node);
    }
    matching.sort((a, b) => STATUS_ORDER[a.change!.status]! - STATUS_ORDER[b.change!.status]! || (TYPE_ORDER[a.type] ?? 4) - (TYPE_ORDER[b.type] ?? 4) || (a.path ?? a.name).localeCompare(b.path ?? b.name, 'en') || (a.sourceRange?.startLine ?? 0) - (b.sourceRange?.startLine ?? 0) || (a.id < b.id ? -1 : 1));
    const items = matching.slice(offset, offset + limit).map(node => ({ ...this.summary(current, node), breadcrumb: current.index.canonicalAncestors(node).slice(1).map(item => item.name).join(' › ') }));
    return { items, limit, offset, total: matching.length, hasMore: offset + limit < matching.length, statusCounts };
  }
  /** The architectural diff of one entity: facts, parent, metrics, relationships, findings and evidence before and after. */
  change(id: string, view: ViewKey): EntityChangeDetail {
    const current = this.comparison(view);
    const node = this.require(current, id);
    if (node.kind !== 'entity') throw new Error('Projection districts have no change record');
    const change: NodeChange = node.change ?? { status: 'unchanged', facets: [] };
    const after = change.status === 'removed' ? undefined : current.target.entity(id);
    const beforeId = change.status === 'added' ? undefined : change.status === 'removed' ? id : change.previousId ?? id;
    const before = beforeId ? current.baseline.entity(beforeId) : undefined;
    const side = (source: SnapshotSource, entity: Entity | undefined): EntitySide | undefined => {
      if (!entity) return undefined;
      const parent = entity.parentId ? source.entity(entity.parentId) : undefined;
      const { evidence, ...rest } = entity;
      return { snapshot: snapshotRef(source), entity: rest, ...(parent ? { parent: { id: parent.id, type: parent.type, name: parent.name, ...(parent.path ? { path: parent.path } : {}) } } : {}), evidenceCount: evidence.length };
    };
    const metadata: EntityChangeDetail['metadata'] = [];
    if (before && after) {
      for (const key of [...new Set([...Object.keys(before.metadata), ...Object.keys(after.metadata)])].sort()) {
        if (key === 'bodyHash') continue;
        const a = before.metadata[key], b = after.metadata[key];
        if (canonicalJson(withoutPositions(a) ?? null) !== canonicalJson(withoutPositions(b) ?? null) || (key === 'contentHash' && a !== b)) metadata.push({ key, ...(a !== undefined ? { before: bounded(a) } : {}), ...(b !== undefined ? { after: bounded(b) } : {}) });
      }
    }
    const indices = (current.index.adjacency.get(id) ?? []).filter(index => current.index.relations[index]!.change);
    const items = this.relationItems(current, indices, index => { const relation = current.index.relations[index]!; return relation.from === id ? { direction: relation.from === relation.to ? 'self' : 'outgoing', otherId: relation.to } : { direction: 'incoming', otherId: relation.from }; });
    const diagnosticItem = (item: SnapshotData['diagnostics'][number]): DiagnosticItem => ({ ...item, nodeId: id, nodeName: node.name });
    const owns = (item: SnapshotData['diagnostics'][number]) => item.entityId === id || (node.type === 'file' && !!node.path && item.file === node.path && !item.entityId);
    const evidenceOf = (entity: Entity | undefined) => entity ? canonicalJson(entity.evidence.map(fact => withoutPositions(fact))) : '';
    const sourceSide = (entity: Entity | undefined) => !!entity?.path && !['directory', 'application', 'repository'].includes(entity.type) && (entity.type !== 'file' || (!!entity.language && !entity.metadata.analysisSkipped));
    return {
      id, change,
      ...(before ? { before: side(current.baseline, before) } : {}), ...(after ? { after: side(current.target, after) } : {}),
      metadata,
      metrics: { ...(before?.metrics?.loc !== undefined ? { before: before.metrics.loc } : {}), ...(after?.metrics?.loc !== undefined ? { after: after.metrics.loc } : {}) },
      relations: { added: items.filter(item => item.change === 'added'), removed: items.filter(item => item.change === 'removed') },
      diagnostics: { added: current.diff.addedDiagnostics.filter(owns).map(diagnosticItem), removed: current.diff.removedDiagnostics.filter(owns).map(diagnosticItem) },
      evidenceChanged: !!before && !!after && evidenceOf(before) !== evidenceOf(after),
      sourceDiff: sourceSide(before) || sourceSide(after),
    };
  }
  /** Line diff of an entity's own source between baseline and target (a symbol's range, or a whole file). */
  async sourceDiff(id: string, maxFileBytes: number, view: ViewKey, options: { context?: number; ignoreWhitespace?: boolean } = {}): Promise<SourceDiffResponse> {
    const current = this.comparison(view);
    const node = this.require(current, id);
    const change = node.change ?? { status: 'unchanged', facets: [] };
    const read = async (source: SnapshotSource, entityId: string | undefined) => {
      const entity = entityId ? source.entity(entityId) : undefined;
      if (!entity) return undefined;
      if (!entity.path || ['directory', 'application', 'repository'].includes(entity.type)) throw new SourceError(422, `A ${entity.type} has no single source file`);
      const { buffer } = await readSnapshotFile(source, entity.path, maxFileBytes);
      const all = splitLines(buffer.toString('utf8'));
      const range = entity.type !== 'file' && entity.sourceRange ? { startLine: entity.sourceRange.startLine, endLine: Math.min(all.length, entity.sourceRange.endLine) } : undefined;
      const lines = range ? all.slice(range.startLine - 1, range.endLine) : all;
      const side: SourceDiffSide = { snapshot: snapshotRef(source), entityId: entity.id, path: entity.path, ...(range ? { range } : {}), totalLines: all.length };
      return { side, lines, language: entity.language, start: range?.startLine ?? 1 };
    };
    const after = change.status === 'removed' ? undefined : await read(current.target, id);
    const before = change.status === 'added' ? undefined : await read(current.baseline, change.status === 'removed' ? id : change.previousId ?? id);
    if (!before && !after) throw new SourceError(404, 'Entity not found in either snapshot');
    const limit = (lines: string[]) => lines.map(line => line.length > 2000 ? `${line.slice(0, 2000)}…` : line);
    const result = lineDiff(limit(before?.lines ?? []), limit(after?.lines ?? []), { context: Math.max(0, Math.min(20, options.context ?? 3)), oldStart: before?.start ?? 1, newStart: after?.start ?? 1, ignoreWhitespace: !!options.ignoreWhitespace });
    const notices: string[] = [];
    if (result.tooLarge) notices.push('The two versions differ too much to diff line by line; open each version separately.');
    if (result.truncated) notices.push('The diff is bounded; later hunks are omitted.');
    return { ...(before ? { before: before.side } : {}), ...(after ? { after: after.side } : {}), ...((after ?? before)!.language ? { language: (after ?? before)!.language } : {}), ...result, notices };
  }
  /**
   * When an entity appeared, changed, moved or disappeared across the indexed
   * timeline (`timeline`: commit SHAs oldest first). Follows the ID only:
   * lineage across renames is shown by comparisons.
   */
  entityHistory(id: string, timeline: string[], identity?: string): EntityHistoryResponse {
    const history = this.options.history?.();
    if (!history) throw new NotFoundError('No history has been indexed');
    const chosen = history.snapshotsByCommit(identity);
    const versions = new Map(history.entityHistory(id).map(row => [row.snapshotId, row]));
    const points: EntityHistoryResponse['points'] = [];
    let previous: EntityHistoryRow | undefined, seen = false, indexed = 0, present = 0;
    for (const sha of timeline) {
      const snapshot = chosen.get(sha);
      if (!snapshot) continue;
      indexed++;
      const version = versions.get(snapshot.id);
      if (version) present++;
      if (version && !previous) points.push({ sha, snapshotId: snapshot.id, status: seen ? 'reintroduced' : 'introduced', name: version.name, ...(version.path ? { path: version.path } : {}) });
      else if (!version && previous) points.push({ sha, snapshotId: snapshot.id, status: 'removed', name: previous.name, ...(previous.path ? { path: previous.path } : {}) });
      else if (version && previous) {
        if (version.parentId !== previous.parentId || version.name !== previous.name || version.path !== previous.path) points.push({ sha, snapshotId: snapshot.id, status: 'moved', name: version.name, ...(version.path ? { path: version.path } : {}) });
        else if (version.content !== previous.content || version.shape !== previous.shape) points.push({ sha, snapshotId: snapshot.id, status: 'modified', name: version.name, ...(version.path ? { path: version.path } : {}) });
      }
      if (version) seen = true;
      previous = version;
    }
    return { id, points, indexedSnapshots: indexed, present };
  }
}
function nodeChange(change: EntityChange, current: { name: string; path?: string }, previous: { name: string; path?: string } | undefined): NodeChange {
  return {
    status: change.status, facets: change.facets,
    ...(change.previousId ? { previousId: change.previousId, ...(change.lineage ? { lineage: change.lineage } : {}) } : {}),
    ...(previous && previous.name !== current.name ? { previousName: previous.name } : {}), ...(previous?.path && previous.path !== current.path ? { previousPath: previous.path } : {}),
  };
}
function bounded(value: unknown): unknown {
  const text = JSON.stringify(value);
  return text && text.length > 4000 ? `${text.slice(0, 4000)}…` : value;
}
function compareNames(current: View, a: string, b: string): number {
  const x = current.index.node(a)!.name, y = current.index.node(b)!.name;
  return x < y ? -1 : x > y ? 1 : 0;
}
