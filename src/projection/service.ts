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
import type { EntityHistoryRow, HistoryStore, SnapshotRecord } from '../history/store.js';
import type { EvolutionResponse } from './dto.js';
import { computeEvolution, type EvolutionJob } from './evolution.js';
import { lineDiff } from '../history/textdiff.js';
import { pagination, type GraphStore } from '../storage/sqlite.js';
import type { Entity, Relation } from '../core/graph.js';
import { extendRegistry, LAYOUT_VERSION, TIMELINE_LAYOUT_VERSION, layoutHierarchy, placeOnTimeline, timelineLayout, type LayoutResult, type LayoutState, type Rect, type TimelineLayout, type TimelineRegistry } from './layout.js';
import { ProjectionIndex, type EntityRow, type ProjectionNode, type RelationRow } from './hierarchy.js';
import { dataFamilies, NO_FAMILY, type FamilyAssignment } from './families.js';
import { readSnapshotFile, readSnapshotSource, snapshotRef, SourceError, splitLines, type SourceRequest, type SourceResponse } from './source.js';
import type { AggregateResult, ChangeRegionsResult, ChangesPage, CoverageDetail, CoverageExport, CoverageExportSymbol, CoverageResult, DiagnosticItem, DiagnosticsPage, EntityChangeDetail, EntityHistoryResponse, EntitySide, FamiliesResult, FeaturesResult, FlowList, FlowSummary, ImpactHop, ImpactItem, ImpactResult, LocateResult, NodeChange, NodeSummary, Page, ProjectionMeta, RelationItem, RelationsPage, RequestFlow, RequestFlowEdge, RequestFlowList, RequestFlowNode, RequestFlowSummary, SearchPage, SourceDiffResponse, SourceDiffSide, Step, StepGuard, StepHop, StepLink, StepsResult, ViewKey } from './dto.js';
import { computeImpact, DEFAULT_IMPACT_DEPTH, FILE_IMPACT_TYPES, impactPath, MAX_IMPACT_SEEDS, seedsOf, SYMBOL_IMPACT_TYPES, type ImpactComputation } from './impact.js';
import { walkSteps } from './steps.js';
import { changeRegions, isRegionLevel } from './regions.js';
import { commandFlow, displayName, endpointFlow, FLOW_LANES, scheduleFlow, unmatchedFlow, type FlowContext, type RawFlow } from './request-flows.js';
import { CATALOG_KINDS, computeCoverage, fileResolver, forwardSlice, pageEndpoints, type CatalogKind, type CoverageComputation } from './catalog.js';
import type { AnnotationStore } from '../ai/store.js';
import { assignDomains, PLATFORM, type DomainAssignment, type DomainRule } from '../ai/domains.js';
import type { AnnotationsOverview, EntityAnnotation, TimelineResponse } from './dto.js';
import { guardsAt, hintOf, phrase } from './conditions.js';
import { SYMBOL_TYPES } from './hierarchy.js';
import { AuthorLogs } from '../history/authors.js';
import { authorshipResult, computeAuthorship, entityAuthorship, isAuthorshipWindow, personAuthorship, type AuthorshipComputation } from './authorship.js';
import type { AuthorshipResult, AuthorshipWindowKey, EntityAuthorship, PersonAuthorship } from './dto.js';
export type { NodeSummary, Page, RelationItem, ViewKey } from './dto.js';
/** Relations that do not make their target used: structure and re-export bookkeeping. */
const UNUSED_IGNORED = new Set(['contains', 'exports']);
const EXPORT_SYMBOLS = new Set(['function', 'method', 'component']);
const REACHED = new Set(['entry', 'flow', 'supporting']);
/** Methods Laravel and PHP libraries call by name. */
const FRAMEWORK_HOOK = /^(boot|booted|register|handle|rules|authorize|messages|attributes|prepareForValidation|passedValidation|withValidator|up|down|casts|toArray|toResponse|envelope|content|attachments|headers|build|via|toMail|toDatabase|toBroadcast|broadcastOn|broadcastWith|definition|configure|run|render|report|failed|middleware|schedule|commands|scope[A-Z]\w*|get\w+Attribute|set\w+Attribute)$/;
export class NotFoundError extends Error {}
interface View {
  key: string;
  target: SnapshotSource; baseline?: SnapshotSource;
  targetData: SnapshotData; baselineData?: SnapshotData;
  index: ProjectionIndex; rects: Map<string, Rect>;
  persisted: boolean; holes: number; layoutSource: 'timeline' | 'persisted' | 'fresh';
  diff?: SnapshotDiff;
  addedDiagnostics: Set<string>;
  /** Lazily loaded: unresolved call sites by called name. */
  unresolvedNames?: Map<string, { sites: number; entities: Set<string> }>;
  /** Recent impact computations of this view. */
  impacts?: Map<string, ImpactComputation>;
  /** Request flows built so far (undefined: the ID anchors none), and the listing once computed. */
  requestFlows?: Map<string, RawFlow | undefined>;
  requestFlowList?: { summary: RequestFlowSummary; members: Set<string> }[];
  /** Every flow by entry point with its slice, the flows per entity, and file coverage (lazily). */
  catalog?: { flows: { summary: FlowSummary; members: Set<string> }[]; byEntity: Map<string, number[]>; coverage?: CoverageComputation };
  /** Endpoints serving a page (lazily): Steps stop at navigation to them. */
  pages?: Set<string>;
  /** Data families (lazily). */
  families?: FamilyAssignment;
  /** Authorship by window (lazily). */
  authorship?: Map<string, AuthorshipComputation>;
}
/** Languages whose files count as code (files of other languages are placed, not counted). */
const CODE_LANGUAGES = new Set(['typescript', 'javascript', 'php', 'vue', 'svelte']);
const HTTP_FINDINGS = new Set(['unresolved-http-call', 'unresolved-http-url', 'unmatched-http-call', 'ambiguous-http-match', 'constrained-http-match', 'unverified-relative-api-boundary']);
const IMPACT_TYPE_ORDER: Record<string, number> = { route: 0, api_endpoint: 1, component: 2, controller: 3, model: 4, class: 4, function: 5, method: 6, database_table: 7, file: 8 };
const OWN_CHANGE = new Set(['source', 'definition', 'signature', 'type', 'size']);
const SEVERITY_ORDER: Record<string, number> = { error: 0, warning: 1, info: 2 };
const STATUS_ORDER: Record<string, number> = { added: 0, removed: 1, moved: 2, modified: 3, unchanged: 4 };
const TYPE_ORDER: Record<string, number> = { application: 0, directory: 1, file: 2, route: 3, api_endpoint: 3 };
const VIEW_CACHE = 8, DATA_CACHE = 10;
const METHOD_ORDER: Record<string, number> = { GET: 0, HEAD: 1, POST: 2, PUT: 3, PATCH: 4, DELETE: 5, OPTIONS: 6 };
export interface ProjectionOptions {
  stateDirectory?: string;
  /** Repository root: Git rename detection for comparisons, and source reading. */
  root?: string;
  /** Read-only history store, when one exists. */
  history?: () => HistoryStore | undefined;
  /** Read-only language-model annotations (`annotate`), when they exist. */
  annotations?: () => AnnotationStore | undefined;
}

export class ProjectionService {
  private readonly views = new Map<string, View>();
  private readonly data = new Map<string, SnapshotData>();
  private readonly renames = new Map<string, Map<string, string>>();
  private timeline?: { stamp: string; registry: TimelineRegistry; snapshots: Set<string>; layouts: Map<string, { registry: TimelineRegistry; layout: TimelineLayout }> };
  private evolutionRun?: { key: string; job: EvolutionJob; done: Promise<void>; result?: EvolutionResponse; error?: string };
  private readonly authorLogs: AuthorLogs;
  constructor(private readonly store: GraphStore, private readonly options: ProjectionOptions = {}) { this.authorLogs = new AuthorLogs(options.root, options.stateDirectory); }

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
    let result: LayoutResult, persisted = false, layoutSource: View['layoutSource'] = 'fresh';
    const timeline = historical ? this.timelineFor(baseline ? [target, baseline] : [target], index.rootId) : undefined;
    if (timeline) { result = placeOnTimeline(index.layoutNodes(), index.rootId, timeline.registry, timeline.layout); layoutSource = 'timeline'; }
    else if (target.info.kind === 'working_tree' && !baseline) ({ result, persisted, layoutSource } = this.liveLayout(index, target, 'layout.json'));
    else result = layoutHierarchy(index.layoutNodes(), index.rootId);
    const built: View = { key, target, ...(baseline ? { baseline } : {}), targetData, ...(baselineData ? { baselineData } : {}), index, rects: result.rects, persisted, holes: result.holes, layoutSource, ...(diff ? { diff } : {}), addedDiagnostics };
    return this.cacheView(built);
  }
  private cacheView(view: View): View {
    this.views.set(view.key, view);
    if (this.views.size > VIEW_CACHE) this.views.delete(this.views.keys().next().value!);
    return view;
  }
  /** Lay out a live map, carrying its slots forward in a state file (when there is a state directory). */
  private liveLayout(index: ProjectionIndex, target: SnapshotSource, name: string): { result: LayoutResult; persisted: boolean; layoutSource: View['layoutSource'] } {
    if (!this.options.stateDirectory || target.info.kind !== 'working_tree') return { result: layoutHierarchy(index.layoutNodes(), index.rootId), persisted: false, layoutSource: 'fresh' };
    const file = path.join(this.options.stateDirectory, name);
    const run = target.info.run;
    let previous: LayoutState | undefined;
    try { const parsed = JSON.parse(readFileSync(file, 'utf8')) as LayoutState & { repositoryId?: string }; if (parsed.version === LAYOUT_VERSION && parsed.repositoryId === run.repositoryId) previous = parsed; } catch { /* first layout or unreadable state: start fresh */ }
    const result = layoutHierarchy(index.layoutNodes(), index.rootId, previous);
    try {
      const temporary = `${file}.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify({ ...result.state, repositoryId: run.repositoryId, runId: run.id }));
      renameSync(temporary, file);
      return { result, persisted: true, layoutSource: 'persisted' };
    } catch { /* read-only state directory: layout is still deterministic for this graph */ }
    return { result, persisted: false, layoutSource: 'fresh' };
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

  // Annotations and features --------------------------------------------------------
  private domainCache?: { key: string; assignment: DomainAssignment };
  /** Domains of the live index from the model's rules (cached until the rules or the index change). */
  private domains(): DomainAssignment | undefined {
    const annotations = this.options.annotations?.();
    const rules = annotations?.get<{ domains: DomainRule[] }>('domains', 'repository');
    if (!rules?.value.domains?.length) return undefined;
    const base = this.load({});
    const key = `${base.key}|${rules.createdAt}`;
    if (this.domainCache?.key !== key) this.domainCache = { key, assignment: assignDomains(base.index, rules.value.domains) };
    return this.domainCache.assignment;
  }
  // Authorship (history/authors.ts, projection/authorship.ts) ---------------------------
  /**
   * Who changed the view's files, in a window of the history up to the
   * commit the view shows (the live index: the commit it was indexed at).
   * Undefined with the reason when there is no Git history to read.
   */
  private async authorshipOf(current: View, window: string | undefined): Promise<AuthorshipComputation | { reason: string }> {
    const key: AuthorshipWindowKey = window === undefined || window === '' ? 'all' : isAuthorshipWindow(window) ? window : (() => { throw new Error('window must be all, 365d, 90d, 30d or range'); })();
    const cached = current.authorship?.get(key);
    if (cached) return cached;
    const anchor = current.target.info.commitSha;
    if (!this.authorLogs.available) return { reason: 'The server does not know where the repository is, so it cannot read its Git history.' };
    if (!anchor) return { reason: 'This index has no Git commit: the repository is not a Git repository, or nothing was committed yet.' };
    const baseline = key === 'range' ? current.baseline?.info.commitSha : undefined;
    if (key === 'range' && !baseline) throw new Error('The range window needs a comparison with a commit');
    let history;
    try { history = await this.authorLogs.containing(anchor, { persist: current.target.info.kind === 'working_tree' }); }
    catch (error) { return { reason: `The Git history could not be read: ${error instanceof Error ? error.message : String(error)}` }; }
    const folded = history.fold(anchor);
    if (!folded) return { reason: `Commit ${anchor.slice(0, 12)} is not in the Git history read.` };
    const computed = computeAuthorship(history, folded, current.index, { window: key, ...(baseline ? { baseline } : {}) });
    (current.authorship ??= new Map()).set(key, computed);
    return computed;
  }
  /** Commit → its history snapshot, when indexed. */
  private snapshotLookup(): (sha: string) => string | undefined {
    const snapshots = this.options.history?.()?.snapshotsByCommit();
    return sha => snapshots?.get(sha)?.id;
  }
  /** People of a view: who changed it in the window, the person who changed each file most, and the files of each area by that person. */
  async authorship(view?: ViewKey, options: { window?: string } = {}): Promise<AuthorshipResult> {
    const current = this.load(view);
    const computed = await this.authorshipOf(current, options.window);
    const dirty = current.target.info.kind === 'working_tree' && !!current.target.info.dirty;
    if ('reason' in computed) return { available: false, reason: computed.reason, truncated: false, dirty, people: [], of: {}, areas: {}, unchanged: 0 };
    return authorshipResult(computed, current.index, dirty);
  }
  /** One person in a view: the files they changed in the window, the areas and folders holding them, and their commits. */
  async personAuthorship(key: string, view?: ViewKey, options: { window?: string } = {}): Promise<PersonAuthorship> {
    const current = this.load(view);
    const computed = await this.authorshipOf(current, options.window);
    if ('reason' in computed) throw new NotFoundError(computed.reason);
    const result = personAuthorship(computed, current.index, key, this.snapshotLookup());
    if (!result) throw new NotFoundError(`No commits by ${key} in this window`);
    return result;
  }
  /** Who changed an entity (a file; a symbol's or an entry point's file; every file in an area) in the window, and its latest commits. */
  async entityAuthorship(id: string, view?: ViewKey, options: { window?: string } = {}): Promise<EntityAuthorship> {
    const current = this.load(view);
    const node = this.require(current, id);
    const computed = await this.authorshipOf(current, options.window);
    if ('reason' in computed) return { id, available: false, reason: computed.reason, scope: node.type === 'file' ? 'file' : 'area', files: 0, changedFiles: 0, commits: 0, lines: 0, people: [], recent: [] };
    return entityAuthorship(computed, current.index, node, this.snapshotLookup());
  }
  // Data families (projection/families.ts) ---------------------------
  /** Data families of a view's index. */
  private familyAssignment(current: View): FamilyAssignment {
    return current.families ??= dataFamilies(current.index);
  }
  /** Data families of a view: each family, the family of every file and entry point, and the families inside each area. */
  families(view?: ViewKey): FamiliesResult {
    const current = this.load(view);
    const assignment = this.familyAssignment(current);
    const index = current.index;
    const of: Record<string, string> = {}, areas: Record<string, Record<string, number>> = {};
    let without = 0;
    for (const node of index.nodes.values()) {
      if (node.kind !== 'entity' || node.change?.status === 'removed') continue;
      const key = assignment.of.get(node.id);
      if (node.type !== 'file') { if (key) of[node.id] = key; continue; }
      // Areas count code files without a family too (as `none`), so shares are of all their code.
      if (!key && !CODE_LANGUAGES.has(node.language ?? '')) continue;
      if (key) of[node.id] = key; else without++;
      for (const ancestor of index.spatialAncestors(node)) { const counts = areas[ancestor.id] ??= {}; counts[key ?? NO_FAMILY] = (counts[key ?? NO_FAMILY] ?? 0) + 1; }
    }
    return { families: assignment.families, of, inferred: [...assignment.inferred].filter(id => of[id]), without, areas };
  }
  /**
   * Features of a view: the model's domains, largest first (shared code last),
   * each with the folders holding its code; the feature of every file and entry
   * point (symbols take their file's), and the code files per feature in each
   * area. Domains are assigned on the live index; entity IDs are stable, so a
   * history view keeps the features of what still exists.
   */
  features(view?: ViewKey): FeaturesResult {
    const assignment = this.domains();
    if (!assignment) return { features: [], of: {}, areas: {} };
    const current = this.load(view);
    const index = current.index;
    const of: Record<string, string> = {}, areas: Record<string, Record<string, number>> = {};
    const files = new Map<string, number>(), folders = new Map<string, Map<string, number>>();
    for (const node of index.nodes.values()) {
      if (node.kind !== 'entity' || SYMBOL_TYPES.has(node.type) || node.change?.status === 'removed') continue;
      const key = assignment.of.get(node.id);
      if (!key) continue;
      of[node.id] = key;
      if (node.type !== 'file' || !CODE_LANGUAGES.has(node.language ?? '')) continue;
      files.set(key, (files.get(key) ?? 0) + 1);
      for (const ancestor of index.spatialAncestors(node)) { const counts = areas[ancestor.id] ??= {}; counts[key] = (counts[key] ?? 0) + 1; }
      const folder = node.canonicalParentId;
      if (folder) { const list = folders.get(key) ?? new Map<string, number>(); list.set(folder, (list.get(folder) ?? 0) + 1); folders.set(key, list); }
    }
    const features = assignment.domains.filter(domain => files.get(domain.key)).map(domain => ({
      key: domain.key, name: domain.name, summary: domain.summary, files: files.get(domain.key)!, color: domain.color,
      folders: [...folders.get(domain.key) ?? []].map(([id, count]) => ({ id, path: index.node(id)?.path ?? index.node(id)?.name ?? id, files: count })).sort((a, b) => b.files - a.files || (a.path < b.path ? -1 : 1)),
    }));
    features.sort((a, b) => Number(a.key === PLATFORM) - Number(b.key === PLATFORM) || b.files - a.files || (a.name < b.name ? -1 : 1));
    return { features, of, areas };
  }
  /** What the models said about the repository: its overview and domains, how much was described, and the cost. */
  annotationsOverview(): AnnotationsOverview {
    const annotations = this.options.annotations?.();
    if (!annotations) return { available: false, domains: [], counts: {}, models: [] };
    const overview = annotations.get<{ summary: string; applications: { name: string; summary: string }[]; start: string[] }>('overview', 'repository')?.value;
    const runs = annotations.runs();
    const counts = annotations.counts();
    const models = [...new Set(annotations.db.prepare('SELECT DISTINCT model FROM annotations').all().map(row => String(row.model)))];
    const assignment = this.domains();
    return {
      available: Object.keys(counts).length > 0, ...(overview ? { overview } : {}),
      domains: assignment ? assignment.domains.filter(domain => domain.files > 0) : [],
      counts, models, ...(runs.length ? { cost: { last: runs[0]!.cost, total: runs.reduce((sum, run) => sum + run.cost, 0) } } : {}),
    };
  }
  /** The description of an entity (files, folders and applications; others by their file), and its domain. */
  entityAnnotation(id: string, view?: ViewKey): EntityAnnotation {
    const current = this.load(view);
    const node = this.require(current, id);
    const annotations = this.options.annotations?.();
    const result: EntityAnnotation = { id };
    if (!annotations) return result;
    const kind = node.type === 'file' ? 'file' : node.type === 'directory' || node.type === 'application' ? 'folder' : node.type === 'repository' ? 'overview' : undefined;
    const stored = kind ? annotations.get<{ summary?: string; role?: string; hash?: string }>(kind, kind === 'overview' ? 'repository' : id) : undefined;
    if (stored) Object.assign(result, { summary: stored.value.summary ?? '', ...(stored.value.role ? { role: stored.value.role } : {}), model: stored.model, createdAt: stored.createdAt, ...(stored.ste !== undefined ? { ste: stored.ste } : {}) });
    // The file changed since it was described: the description may be out of date.
    if (stored?.value.hash && node.type === 'file') { const hash = current.target.entity(id)?.metadata.contentHash; if (typeof hash === 'string' && hash !== stored.value.hash) result.outdated = true; }
    const assignment = this.domains();
    const key = assignment?.of.get(id);
    const domain = key ? assignment!.domains.find(item => item.key === key) : undefined;
    if (domain) result.domain = { key: domain.key, name: domain.name, inferred: assignment!.inferred.has(id) };
    return result;
  }
  /** Commit explanations and history chapters on the timeline, when described. */
  annotateTimeline(timeline: TimelineResponse): TimelineResponse {
    const annotations = this.options.annotations?.();
    if (!annotations) return timeline;
    const notes = annotations.map<{ intent: string; title: string; summary: string; areas: string[] }>('commit');
    const chapters = annotations.get<{ chapters: TimelineResponse['chapters'] }>('chapters', 'repository')?.value.chapters;
    return { ...timeline, entries: timeline.entries.map(entry => { const note = notes.get(entry.sha)?.value; return note ? { ...entry, note } : entry; }), ...(chapters?.length ? { chapters } : {}) };
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
  /**
   * Relationships of an entity. `scope: 'contained'` (files) adds those of its
   * symbols that cross the file's boundary, each with the symbol inside.
   */
  relations(id: string, options: { direction?: string; type?: string; limit?: number; offset?: number; view?: ViewKey; scope?: string }): RelationsPage {
    const current = this.load(options.view);
    const node = this.require(current, id);
    const { limit, offset } = pagination(options);
    const direction = options.direction ?? 'both';
    if (!['incoming', 'outgoing', 'both'].includes(direction)) throw new Error('direction must be incoming, outgoing or both');
    if (options.scope !== undefined && options.scope !== 'contained') throw new Error('scope must be contained');
    const index = current.index;
    const contained = options.scope === 'contained' && node.kind === 'entity' && node.type !== 'repository' && node.type !== 'application' ? [...index.nodes.values()].filter(item => item.id !== node.id && index.contains(node, item)) : [];
    const inside = new Set([node.id, ...contained.map(item => item.id)]);
    const seen = new Set<number>();
    const all = [node, ...contained].flatMap(owner => (index.adjacency.get(owner.id) ?? []).flatMap(relationIndex => {
      const relation = index.relations[relationIndex]!;
      const fromInside = inside.has(relation.from), toInside = inside.has(relation.to);
      // Relations between two symbols of the file are internal to it.
      if (seen.has(relationIndex) || (owner !== node && fromInside && toInside)) return [];
      seen.add(relationIndex);
      const dir: RelationItem['direction'] = relation.from === relation.to || (fromInside && toInside) ? 'self' : fromInside ? 'outgoing' : 'incoming';
      const insideId = dir === 'incoming' ? relation.to : relation.from;
      return [{ index: relationIndex, relation, direction: dir, otherId: dir === 'incoming' ? relation.from : relation.to, ...(insideId !== node.id ? { insideId } : {}) }];
    }));
    const counts = new Map<string, number>();
    for (const item of all) { const key = `${item.relation.type}\u0000${item.direction}`; counts.set(key, (counts.get(key) ?? 0) + 1); }
    const filtered = all.filter(item => (direction === 'both' || item.direction === direction || item.direction === 'self') && (!options.type || item.relation.type === options.type));
    const rank = { outgoing: 0, self: 1, incoming: 2 };
    filtered.sort((a, b) => rank[a.direction] - rank[b.direction] || (a.relation.type < b.relation.type ? -1 : a.relation.type > b.relation.type ? 1 : 0) || compareNames(current, a.otherId, b.otherId) || (a.relation.id < b.relation.id ? -1 : 1));
    const page = filtered.slice(offset, offset + limit);
    const lookup = new Map(page.map(item => [item.index, item]));
    return {
      items: this.relationItems(current, page.map(item => item.index), relationIndex => lookup.get(relationIndex)!).map((item, i) => { const insideId = page[i]!.insideId; return insideId ? { ...item, inside: this.summary(current, index.node(insideId)!) } : item; }),
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

  // Impact and steps ---------------------------------------------------------------
  /** Blast radius of an entity (or everything inside a container): what depends on it, hop by hop. */
  impact(id: string, options: { depth?: number; types?: string[]; type?: string; distance?: number; limit?: number; offset?: number; view?: ViewKey }): ImpactResult {
    const current = this.load(options.view);
    const node = this.require(current, id);
    const depth = impactDepth(options.depth);
    const types = impactTypes(options.types);
    const key = `entity:${id}:${depth}:${[...types].sort().join(',')}`;
    const computation = this.cachedImpact(current, key, () => { const { seeds } = seedsOf(current.index, node); return computeImpact(current.index, seeds, { depth, types }); });
    return this.impactResult(current, computation, { kind: 'entity', node: this.summary(current, node) }, depth, types, options);
  }
  /** Blast radius of a comparison: what depends on the entities the target changed or removed since the baseline. */
  commitImpact(view: ViewKey, options: { depth?: number; types?: string[]; type?: string; distance?: number; limit?: number; offset?: number }): ImpactResult {
    const current = this.comparison(view);
    const depth = impactDepth(options.depth);
    const types = impactTypes(options.types);
    const byStatus: Record<string, number> = {};
    const key = `comparison:${depth}:${[...types].sort().join(',')}`;
    const computation = this.cachedImpact(current, key, () => {
      const changed: ProjectionNode[] = [];
      for (const [changedId, change] of current.diff.changes) {
        if (change.status === 'added' || change.status === 'unchanged') continue;
        if (change.status !== 'removed' && !change.facets.some(facet => OWN_CHANGE.has(facet))) continue;
        const changedNode = current.index.node(changedId);
        if (!changedNode || changedNode.kind !== 'entity' || !(SYMBOL_TYPES.has(changedNode.type) || ['file', 'route', 'api_endpoint'].includes(changedNode.type))) continue;
        changed.push(changedNode);
      }
      // A changed file seeds its importers only when no symbol inside it changed (a module-level change).
      const symbolFiles = new Set(changed.filter(item => item.type !== 'file').map(item => item.path));
      const seeds = changed.filter(item => item.type !== 'file' || !symbolFiles.has(item.path)).map(item => item.id).sort().slice(0, MAX_IMPACT_SEEDS);
      return computeImpact(current.index, seeds, { depth, types, includeRemoved: true });
    });
    for (const seed of computation.seeds) { const status = current.index.node(seed)?.change?.status ?? 'modified'; byStatus[status] = (byStatus[status] ?? 0) + 1; }
    return this.impactResult(current, computation, { kind: 'comparison', byStatus }, depth, types, options);
  }
  private cachedImpact(current: View, key: string, compute: () => ImpactComputation): ImpactComputation {
    current.impacts ??= new Map();
    let result = current.impacts.get(key);
    if (!result) { result = compute(); current.impacts.set(key, result); if (current.impacts.size > 8) current.impacts.delete(current.impacts.keys().next().value!); }
    return result;
  }
  private impactResult(current: View, computation: ImpactComputation, origin: ImpactResult['origin'], depth: number, types: Set<string>, options: { type?: string; distance?: number; limit?: number; offset?: number }): ImpactResult {
    const { limit, offset } = pagination(options);
    const index = current.index;
    const affected: ProjectionNode[] = [];
    const byDistance = Array.from({ length: depth + 1 }, () => 0);
    const byType = new Map<string, number>();
    const areas: Record<string, { count: number; distance: number }> = {};
    const applications = new Map<string, number>();
    let endpoints = 0, routes = 0;
    for (const [id, distance] of computation.distance) {
      if (distance === 0) continue;
      const node = index.node(id);
      if (!node) continue;
      affected.push(node);
      byDistance[distance]!++;
      byType.set(node.type, (byType.get(node.type) ?? 0) + 1);
      if (node.type === 'api_endpoint') endpoints++;
      if (node.type === 'route') routes++;
      for (const ancestor of index.spatialAncestors(node)) {
        const area = areas[ancestor.id] ??= { count: 0, distance };
        area.count++; area.distance = Math.min(area.distance, distance);
        if (ancestor.type === 'application') applications.set(ancestor.id, (applications.get(ancestor.id) ?? 0) + 1);
      }
    }
    const filtered = affected.filter(node => (!options.type || node.type === options.type) && (!options.distance || computation.distance.get(node.id) === options.distance));
    filtered.sort((a, b) => computation.distance.get(a.id)! - computation.distance.get(b.id)! || (IMPACT_TYPE_ORDER[a.type] ?? 8) - (IMPACT_TYPE_ORDER[b.type] ?? 8) || compareNames(current, a.id, b.id) || (a.id < b.id ? -1 : 1));
    const hop = (relationIndex: number): ImpactHop => {
      const relation = index.relations[relationIndex]!, from = index.node(relation.from)!, to = index.node(relation.to)!;
      return { relationId: relation.id, type: relation.type, from: { id: from.id, name: from.name, type: from.type }, to: { id: to.id, name: to.name, type: to.type } };
    };
    const items: ImpactItem[] = filtered.slice(offset, offset + limit).map(node => ({ ...this.summary(current, node), distance: computation.distance.get(node.id)!, breadcrumb: index.canonicalAncestors(node).slice(1).map(item => item.name).join(' › '), chain: impactPath(computation, index, node.id).map(hop) }));
    // What the radius cannot see.
    const reachesEndpoint = [...computation.distance.keys()].some(id => index.node(id)?.type === 'api_endpoint');
    const unresolvedHttpCalls = reachesEndpoint ? index.diagnostics.filter(item => HTTP_FINDINGS.has(item.code)).length : 0;
    const names = new Set(computation.seeds.slice(0, 200).map(id => index.node(id)).filter(node => node && ['function', 'method', 'component'].includes(node.type) && node.name.length > 2).map(node => node!.name));
    const possibleCallers: ImpactResult['unknowns']['possibleCallers'] = [];
    if (names.size) {
      const unresolved = this.unresolvedNames(current);
      const seedSet = new Set(computation.seeds);
      for (const name of names) { const entry = unresolved.get(name); if (!entry) continue; const entities = [...entry.entities].filter(entity => !seedSet.has(entity)); if (entities.length) possibleCallers.push({ name, sites: entry.sites, entities: entities.length }); }
      possibleCallers.sort((a, b) => b.sites - a.sites || (a.name < b.name ? -1 : 1));
    }
    return {
      origin, depth, types: [...types].sort(), seeds: computation.seeds.length, seedsTruncated: computation.seedsTruncated,
      total: affected.length, byDistance, byType: [...byType].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count || (a.type < b.type ? -1 : 1)),
      distances: Object.fromEntries(computation.distance), areas,
      items: { items, limit, offset, total: filtered.length, hasMore: offset + limit < filtered.length },
      truncated: computation.truncated,
      highlights: { endpoints, routes, applications: [...applications].map(([id, count]) => ({ id, name: index.node(id)!.name, count })).sort((a, b) => b.count - a.count) },
      unknowns: { unresolvedHttpCalls, possibleCallers: possibleCallers.slice(0, 10) },
    };
  }
  private unresolvedNames(current: View): Map<string, { sites: number; entities: Set<string> }> {
    if (!current.unresolvedNames) {
      const names = new Map<string, { sites: number; entities: Set<string> }>();
      for (const row of current.target.unresolvedCallNames()) { const entry = names.get(row.name) ?? { sites: 0, entities: new Set<string>() }; entry.sites += row.count; entry.entities.add(row.entityId); names.set(row.name, entry); }
      current.unresolvedNames = names;
    }
    return current.unresolvedNames;
  }
  /** What happens from an entity: typed steps, folded links, effects, and the conditions read from source. */
  async steps(id: string, options: { view?: ViewKey; maxFileBytes: number }): Promise<StepsResult> {
    const current = this.load(options.view);
    const anchor = this.require(current, id);
    if (anchor.kind !== 'entity') throw new Error('Steps start from an entity');
    const source = current.target;
    current.pages ??= pageEndpoints(current.index);
    const walk = walkSteps({ index: current.index, relationMetadata: ids => source.relationMetadata(ids), entity: entityId => source.entity(entityId), pages: current.pages }, id);
    const ancestorsOf = (nodeId: string) => { const node = current.index.node(nodeId); return node ? current.index.spatialAncestors(node).map(item => item.id) : []; };
    const guards = this.guardReader(current, options.maxFileBytes);
    const appOf = (node: ProjectionNode) => appName(current, node);
    const relationIds = [...new Set(walk.links.flatMap(link => link.chain.map(i => current.index.relations[i]!.id)))];
    const metadata = relationIds.length ? source.relationMetadata(relationIds) : new Map<string, Record<string, unknown>>();
    const firstLine = (relationId: string, type: string): number | undefined => {
      const lines = metadata.get(relationId)?.lines;
      if (Array.isArray(lines) && typeof lines[0] === 'number') return lines[0];
      if (type === 'requests') return source.relation(relationId)?.evidence[0]?.line;
      return undefined;
    };
    const steps: Step[] = await Promise.all(walk.steps.map(async step => {
      if (step.effect) {
        const owner = current.index.node(step.effect.owner);
        return { id: step.id, kind: step.kind, layer: step.layer, ancestors: owner ? [...current.index.spatialAncestors(owner).map(item => item.id), owner.id] : [], effect: { ...step.effect, ownerName: owner?.name ?? step.effect.owner, ...(owner?.path ? { ownerPath: owner.path } : {}), when: await guards(step.effect.owner, step.effect.line, hintOf(step.effect.detail)) }, ...(owner && appOf(owner) ? { app: appOf(owner) } : {}) };
      }
      const node = current.index.node(step.entityId!)!;
      return { id: step.id, kind: step.kind, layer: step.layer, ancestors: current.index.spatialAncestors(node).map(item => item.id), node: this.summary(current, node), ...(appOf(node) ? { app: appOf(node) } : {}), ...(step.navigation ? { navigation: true } : {}) };
    }));
    const links: StepLink[] = await Promise.all(walk.links.map(async link => {
      const hops: StepHop[] = await Promise.all(link.chain.map(async relationIndex => {
        const relation = current.index.relations[relationIndex]!;
        const line = relation.type === 'handles' || relation.type === 'routes_to' ? undefined : firstLine(relation.id, relation.type);
        const from = current.index.node(relation.from);
        const sites = Number(metadata.get(relation.id)?.sites ?? 1);
        const target = current.index.node(relation.to);
        const hint = relation.type === 'requests' ? undefined : target?.type === 'class' || target?.type === 'model' ? target.name : target?.name.replace(/^.*(::|\.)/, '');
        return { relationId: relation.id, type: relation.type, from: relation.from, to: relation.to, ...(from?.path ? { file: from.path } : {}), ...(line ? { line } : {}), sites, when: line ? await guards(relation.from, line, hint) : [] };
      }));
      return {
        id: `${link.from}>${link.to}`, from: link.from, to: link.to,
        via: link.via.map(viaId => { const node = current.index.node(viaId)!; return { id: node.id, name: node.name, type: node.type, ancestors: ancestorsOf(node.id) }; }),
        hops, ...(link.event ? { event: link.event } : {}), back: link.back,
        // A step's own effect: the conditions at the effect's site.
        when: hops[0]?.when ?? (link.via.length ? [] : steps.find(step => step.id === link.to)?.effect?.when ?? []),
      };
    }));
    const notices: string[] = [];
    if (walk.unresolvedCallSites) notices.push(`${walk.unresolvedCallSites} call site${walk.unresolvedCallSites === 1 ? '' : 's'} along this picture could not be resolved (callbacks, props, untyped values); what they reach is not drawn.`);
    if (!walk.links.length) notices.push('Nothing indexed happens from here: no calls, renders, handlers, requests or effects were resolved.');
    return { anchor: this.summary(current, anchor), steps, links, notices };
  }
  /** The conditions a site runs under, read from the viewed snapshot's source (files read once per reader). */
  private guardReader(current: View, maxFileBytes: number): (ownerId: string, line: number | undefined, hint?: string) => Promise<StepGuard[]> {
    const source = current.target;
    const files = new Map<string, Promise<string | undefined>>();
    const content = (relative: string) => {
      if (!files.has(relative)) files.set(relative, readSnapshotFile(source, relative, maxFileBytes).then(file => file.buffer.toString('utf8'), () => undefined));
      return files.get(relative)!;
    };
    return async (ownerId, line, hint) => {
      const owner = current.index.node(ownerId);
      if (!owner?.path || !line) return [];
      const text = await content(owner.path);
      if (text === undefined) return [];
      const range = owner.type !== 'file' && owner.sourceRange ? { startLine: owner.sourceRange.startLine, endLine: owner.sourceRange.endLine } : undefined;
      return guardsAt(`${source.info.id}:${owner.path}`, owner.path, owner.language, text, line, range, hint).map(guard => ({ ...guard, phrase: phrase(guard) }));
    };
  }

  // Request flows -------------------------------------------------------------------
  private flowContext(current: View): FlowContext {
    const source = current.target;
    const findings = new Map<string, { code: string; reason: string; line?: number }[]>();
    for (const item of current.index.diagnostics) if (item.entityId && HTTP_FINDINGS.has(item.code)) findings.set(item.entityId, [...findings.get(item.entityId) ?? [], { code: item.code, reason: item.reason, ...(item.line !== undefined ? { line: item.line } : {}) }]);
    return { index: current.index, relationMetadata: ids => source.relationMetadata(ids), entity: id => source.entity(id), findings: id => findings.get(id) ?? [] };
  }
  /** The flow anchored at an endpoint, or at an entity making requests no endpoint answers (cached per view). */
  private rawFlow(current: View, id: string, context?: FlowContext): RawFlow | undefined {
    current.requestFlows ??= new Map();
    if (!current.requestFlows.has(id)) {
      const node = current.index.node(id);
      const using = context ?? this.flowContext(current);
      current.requestFlows.set(id, !node || node.kind !== 'entity' ? undefined : node.type === 'api_endpoint' ? endpointFlow(using, id) : node.type === 'command' ? commandFlow(using, id) : node.type === 'scheduled_task' ? scheduleFlow(using, id) : unmatchedFlow(using, id));
    }
    return current.requestFlows.get(id);
  }
  private flowSummary(current: View, flow: RawFlow): RequestFlowSummary {
    const anchor = current.index.node(flow.anchor)!;
    const segment = flow.kind === 'unmatched' ? 'unmatched' : `/${flow.path.split('/').filter(Boolean)[0] ?? ''}`;
    const app = appName(current, anchor);
    return { id: flow.id, kind: flow.kind, name: flow.name, method: flow.method, path: flow.path, ...(app ? { app } : {}), group: segment, status: flow.status, stages: flow.stages, gaps: flow.gaps, callers: flow.callers, tables: flow.tables, responses: flow.responses, ...(flow.handler ? { handler: flow.handler } : {}), ...(flow.caller ? { caller: flow.caller } : {}) };
  }
  /**
   * Every request flow of the view: one per endpoint (a HEAD route that
   * mirrors a GET route is listed once), and one per entity whose requests no
   * endpoint answers. `entity` keeps the flows that draw that entity.
   */
  requestFlows(options: { view?: ViewKey; entity?: string } = {}): RequestFlowList {
    const current = this.load(options.view);
    if (options.entity) this.require(current, options.entity);
    if (!current.requestFlowList) {
      const context = this.flowContext(current);
      const endpoints = [...current.index.nodes.values()].filter(node => node.type === 'api_endpoint' && node.change?.status !== 'removed');
      const gets = new Set(endpoints.filter(node => node.name.startsWith('GET ')).map(node => `${node.canonicalParentId}|${node.name.slice(4)}`));
      const flows: RawFlow[] = [];
      for (const endpoint of endpoints) {
        if (endpoint.name.startsWith('HEAD ') && gets.has(`${endpoint.canonicalParentId}|${endpoint.name.slice(5)}`)) continue;
        const flow = this.rawFlow(current, endpoint.id, context);
        if (flow) flows.push(flow);
      }
      const unmatched = [...new Set(current.index.diagnostics.flatMap(item => item.entityId && HTTP_FINDINGS.has(item.code) && current.index.node(item.entityId)?.change?.status !== 'removed' ? [item.entityId] : []))];
      for (const id of unmatched) { const flow = this.rawFlow(current, id, context); if (flow) flows.push(flow); }
      const order = (flow: RawFlow) => `${flow.kind === 'unmatched' ? 1 : 0}\u0000${appName(current, current.index.node(flow.anchor)!) ?? ''}\u0000${flow.path.toLowerCase()}\u0000${METHOD_ORDER[flow.method] ?? 9}\u0000${flow.id}`;
      flows.sort((a, b) => order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0);
      current.requestFlowList = flows.map(flow => ({ summary: this.flowSummary(current, flow), members: new Set(flow.members) }));
    }
    const items = current.requestFlowList.filter(item => !options.entity || item.members.has(options.entity)).map(item => item.summary);
    const counts: RequestFlowList['counts'] = { complete: 0, partial: 0, headless: 0, unmatched: 0 };
    for (const item of items) counts[item.status]++;
    return { items, counts, ...(options.entity ? { entity: options.entity } : {}) };
  }
  /** One request flow, with entity summaries, folded entities, relationship hops and the conditions read from source. */
  async requestFlow(id: string, options: { view?: ViewKey; maxFileBytes: number }): Promise<RequestFlow> {
    const current = this.load(options.view);
    const anchor = this.require(current, id);
    const flow = this.rawFlow(current, id);
    if (!flow) throw new NotFoundError(`No request flow starts at ${anchor.name}: it is not an endpoint and makes no unmatched request`);
    const guards = this.guardReader(current, options.maxFileBytes);
    const ancestorsOf = (nodeId: string) => { const node = current.index.node(nodeId); return node ? current.index.spatialAncestors(node).map(item => item.id) : []; };
    const nodes: RequestFlowNode[] = flow.nodes.map(item => {
      const node = item.entityId ? current.index.node(item.entityId) : undefined;
      const owner = item.effect ? current.index.node(item.effect.owner) : undefined;
      return {
        id: item.id, lane: item.lane, kind: item.kind, depth: item.depth, label: item.label, ...(item.detail ? { detail: item.detail } : {}),
        ...(node ? { node: this.summary(current, node) } : {}),
        ancestors: node ? ancestorsOf(node.id) : owner ? [...ancestorsOf(owner.id), owner.id] : [],
        ...(item.effect ? { effect: { ...item.effect, ownerName: owner ? displayName(owner) : item.effect.owner, ...(owner?.path ? { ownerPath: owner.path } : {}) } } : {}),
        ...(item.status !== undefined ? { status: item.status } : {}), ...(item.event ? { event: item.event } : {}), ...(item.gap ? { gap: item.gap } : {}),
      };
    });
    const edges: RequestFlowEdge[] = await Promise.all(flow.edges.map(async edge => ({
      id: edge.id, from: edge.from, to: edge.to, kind: edge.kind, ...(edge.label ? { label: edge.label } : {}),
      hops: edge.chain.map(index => { const relation = current.index.relations[index]!; return { relationId: relation.id, type: relation.type, from: relation.from, to: relation.to }; }),
      via: edge.via.map(viaId => { const node = current.index.node(viaId)!; return { id: node.id, name: displayName(node), type: node.type, ancestors: ancestorsOf(node.id) }; }),
      when: edge.site ? await guards(edge.site.owner, edge.site.line, edge.site.hint === undefined ? undefined : hintOf(edge.site.hint) ?? edge.site.hint) : [],
    })));
    return { ...this.flowSummary(current, flow), anchor: this.summary(current, anchor), lanes: FLOW_LANES.filter(lane => nodes.some(node => node.lane === lane)), nodes, edges, notices: flow.notices };
  }

  // Flow catalog and coverage ------------------------------------------------------------
  /** Every flow by entry point, with the entities it touches (built once per view). */
  private catalog(current: View): NonNullable<View['catalog']> {
    if (current.catalog) return current.catalog;
    const index = current.index;
    const context = this.flowContext(current);
    const pages = current.pages ??= pageEndpoints(index);
    const fileOf = fileResolver(index);
    const present = (node: ProjectionNode) => node.kind === 'entity' && node.change?.status !== 'removed';
    const all = [...index.nodes.values()].filter(present);
    const gets = new Set(all.filter(node => node.type === 'api_endpoint' && node.name.startsWith('GET ')).map(node => `${node.canonicalParentId}|${node.name.slice(4)}`));
    const entries: { id: string; kind: CatalogKind }[] = [];
    for (const node of all) {
      if (node.type === 'route') entries.push({ id: node.id, kind: 'page' });
      else if (node.type === 'api_endpoint' && !(node.name.startsWith('HEAD ') && gets.has(`${node.canonicalParentId}|${node.name.slice(5)}`))) entries.push({ id: node.id, kind: pages.has(node.id) ? 'page' : 'request' });
      else if (node.type === 'command') entries.push({ id: node.id, kind: 'command' });
      else if (node.type === 'scheduled_task') entries.push({ id: node.id, kind: 'schedule' });
    }
    for (const id of new Set(index.diagnostics.flatMap(item => item.entityId && HTTP_FINDINGS.has(item.code) && index.node(item.entityId) && present(index.node(item.entityId)!) ? [item.entityId] : []))) entries.push({ id, kind: 'unmatched' });
    const flows: NonNullable<View['catalog']>['flows'] = [];
    for (const entry of entries) {
      const node = index.node(entry.id)!;
      const raw = node.type === 'route' ? undefined : this.rawFlow(current, entry.id, context);
      if (node.type !== 'route' && !raw) continue;
      const slice = entry.kind === 'unmatched' ? { members: new Set<string>(), truncated: false } : forwardSlice(index, entry.id, pages);
      const members = new Set([...slice.members, ...raw?.members ?? [], entry.id]);
      const files = new Set([...members].map(fileOf).filter((file): file is string => !!file));
      const app = appName(current, node);
      const base = { id: entry.id, kind: entry.kind, entry: { id: node.id, type: node.type, name: node.name }, ...(app ? { app } : {}), entities: members.size, files: files.size, ...(slice.truncated ? { truncated: true } : {}) };
      let summary: FlowSummary;
      if (!raw) summary = { ...base, name: node.name, path: node.name, group: `/${node.name.split('/').filter(Boolean)[0] ?? ''}`, detail: 'steps' };
      else {
        const request = this.flowSummary(current, raw);
        const group = entry.kind === 'command' ? (node.name.includes(':') ? `${node.name.split(':')[0]}:` : 'commands') : entry.kind === 'schedule' ? 'scheduler' : request.group;
        summary = { ...base, name: request.name, group, method: request.method, path: request.path, detail: 'lanes', status: request.status, stages: request.stages, gaps: request.gaps, tables: request.tables, responses: request.responses, callers: request.callers, ...(request.handler ? { handler: request.handler } : {}), ...(entry.kind === 'schedule' ? { cadence: request.path } : {}) };
      }
      flows.push({ summary, members });
    }
    const order = (item: FlowSummary) => [String(CATALOG_KINDS.indexOf(item.kind)), item.app ?? '', item.group.toLowerCase(), (item.path ?? item.name).toLowerCase(), String(METHOD_ORDER[item.method ?? ''] ?? 9), item.id].join('\u0000');
    flows.sort((a, b) => order(a.summary) < order(b.summary) ? -1 : order(a.summary) > order(b.summary) ? 1 : 0);
    const byEntity = new Map<string, number[]>();
    flows.forEach((flow, flowIndex) => { for (const id of flow.members) { const list = byEntity.get(id) ?? []; list.push(flowIndex); byEntity.set(id, list); } });
    // Titles the models gave the flows.
    const titles = this.options.annotations?.()?.map<{ title: string; goal: string; actor: string }>('flow');
    if (titles?.size) for (const flow of flows) { const note = titles.get(flow.summary.id)?.value; if (note) flow.summary = { ...flow.summary, title: note.title, goal: note.goal, actor: note.actor }; }
    current.catalog = { flows, byEntity };
    return current.catalog;
  }
  /** Flows touching an entity, or anything inside an area or file (indices into the catalog). */
  private flowsThrough(current: View, node: ProjectionNode): number[] {
    const catalog = this.catalog(current);
    if (node.type === 'repository') return catalog.flows.map((_, i) => i);
    const found = new Set<number>(catalog.byEntity.get(node.id) ?? []);
    const area = node.kind === 'group' || ['application', 'directory', 'file', 'class', 'controller', 'component', 'model'].includes(node.type);
    if (area) for (const [id, flows] of catalog.byEntity) { const member = current.index.node(id); if (member && current.index.contains(node, member)) for (const flow of flows) found.add(flow); }
    return [...found].sort((a, b) => a - b);
  }
  /** Every flow of the view by entry point: pages, requests, commands, scheduled tasks and unmatched requests. */
  flows(options: { view?: ViewKey; entity?: string; kind?: string } = {}): FlowList {
    const current = this.load(options.view);
    if (options.kind && !CATALOG_KINDS.includes(options.kind as CatalogKind)) throw new Error(`kind must be one of ${CATALOG_KINDS.join(', ')}`);
    const catalog = this.catalog(current);
    const indices = options.entity ? this.flowsThrough(current, this.require(current, options.entity)) : catalog.flows.map((_, i) => i);
    const counts = Object.fromEntries(CATALOG_KINDS.map(kind => [kind, 0])) as FlowList['counts'];
    const items: FlowSummary[] = [];
    // A flow belongs to the feature where it starts (its entry point's).
    const domains = this.domains();
    for (const i of indices) {
      const summary = catalog.flows[i]!.summary;
      counts[summary.kind]++;
      if (options.kind && summary.kind !== options.kind) continue;
      const feature = domains?.of.get(summary.entry.id);
      items.push(feature ? { ...summary, feature } : summary);
    }
    return { items, counts, ...(options.entity ? { entity: options.entity } : {}) };
  }
  private coverageOfView(current: View): CoverageComputation {
    const catalog = this.catalog(current);
    if (!catalog.coverage) {
      const dynamicCommandRuns = current.index.diagnostics.filter(item => item.code === 'unresolved-artisan-call' && /not a literal/.test(item.reason)).length;
      catalog.coverage = computeCoverage({ index: current.index, flows: catalog.flows.map(flow => ({ name: flow.summary.name, members: flow.members })), entries: catalog.flows.filter(flow => flow.summary.kind !== 'unmatched').map(flow => flow.summary.id), unresolvedNames: this.unresolvedNames(current), dynamicCommandRuns });
    }
    return catalog.coverage;
  }
  /** Which files the flows touch: a category per file, rolled up per area. */
  coverage(view?: ViewKey): CoverageResult {
    const current = this.load(view);
    const computed = this.coverageOfView(current);
    return {
      totals: computed.totals, codeFiles: computed.codeFiles, flows: this.catalog(current).flows.length,
      files: Object.fromEntries([...computed.files].map(([id, item]) => [id, { category: item.category, flows: item.flows }])),
      areas: Object.fromEntries(computed.areas),
    };
  }
  /**
   * Code no flow is proven to use, as one document to review: files not
   * reached (or reached only by an unresolved name), with their symbols, and
   * the symbols of reached files that nothing indexed points at.
   */
  coverageExport(view?: ViewKey): CoverageExport {
    const current = this.load(view);
    const { index } = current;
    const computed = this.coverageOfView(current);
    const catalog = this.catalog(current);
    const unresolved = this.unresolvedNames(current);
    const fileOf = fileResolver(index);
    const used = new Set<string>();
    for (const relation of index.relations) if (relation.change !== 'removed' && !UNUSED_IGNORED.has(relation.type) && relation.from !== relation.to) used.add(relation.to);
    const symbolsByFile = new Map<string, ProjectionNode[]>();
    for (const node of index.nodes.values()) {
      if (node.kind !== 'entity' || !EXPORT_SYMBOLS.has(node.type) || node.change?.status === 'removed') continue;
      const file = fileOf(node.id);
      if (file) symbolsByFile.set(file, [...symbolsByFile.get(file) ?? [], node]);
    }
    const describe = (node: ProjectionNode): CoverageExportSymbol => {
      const sites = node.name.length > 2 ? unresolved.get(node.name)?.sites : undefined;
      const note = node.language === 'php' && node.type === 'method' && FRAMEWORK_HOOK.test(node.name) ? 'A name the framework calls by convention (lifecycle, validation, mail, Eloquent scope or accessor)'
        : node.language === 'php' && node.type === 'method' && /(^|\/)app\/Models\//.test(node.path ?? '') ? 'A model method: possibly an Eloquent relationship loaded by name (with(\'…\'), ->relation)' : undefined;
      return { name: node.name, type: node.type, ...(node.qualifiedName && node.qualifiedName !== node.name ? { qualifiedName: node.qualifiedName } : {}), ...(node.sourceRange ? { startLine: node.sourceRange.startLine, endLine: node.sourceRange.endLine } : {}), ...(sites ? { possiblyCalledByName: sites } : {}), ...(note ? { note } : {}) };
    };
    const byLine = (a: ProjectionNode, b: ProjectionNode) => (a.sourceRange?.startLine ?? 0) - (b.sourceRange?.startLine ?? 0);
    const files: CoverageExport['files'] = [];
    const symbols: CoverageExport['symbols'] = [];
    for (const [id, coverage] of computed.files) {
      const file = index.node(id)!;
      const own = (symbolsByFile.get(id) ?? []).sort(byLine);
      if (coverage.category === 'unreached' || coverage.category === 'explained') {
        files.push({ path: file.path ?? file.name, category: coverage.category, reason: coverage.reason, ...(file.language ? { language: file.language } : {}), ...(file.loc ? { loc: file.loc } : {}), symbols: own.map(describe) });
      } else if (REACHED.has(coverage.category)) {
        // Symbols nothing points at, inside files flows do reach; a symbol inside an unused one is listed through its parent.
        const unused = own.filter(node => !used.has(node.id) && !catalog.byEntity.has(node.id) && !node.name.startsWith('__') && node.name !== 'default');
        const unusedIds = new Set(unused.map(node => node.id));
        for (const node of unused) if (!node.canonicalParentId || !unusedIds.has(node.canonicalParentId)) symbols.push({ path: file.path ?? file.name, fileCategory: coverage.category, ...describe(node) });
      }
    }
    files.sort((a, b) => a.path.localeCompare(b.path));
    symbols.sort((a, b) => a.path.localeCompare(b.path) || (a.startLine ?? 0) - (b.startLine ?? 0));
    return {
      repository: index.node(index.rootId)?.name ?? '', generatedAt: new Date().toISOString(), ...(view?.snapshot ? { snapshot: view.snapshot } : {}),
      about: [
        'Static analysis by Codiluce: flows start at entry points (pages, routes, endpoints, console commands, scheduled tasks) and follow resolved calls, renders, requests and references.',
        '"files" lists code files no flow reaches (category "unreached") or reaches only possibly, through a call by a name the analyzers could not resolve ("explained"); "reason" says why.',
        '"symbols" lists functions, methods and components inside files flows do reach that nothing indexed calls, renders, routes to or references.',
        'These are candidates, not proof of dead code. The analyzers do not see: code run by framework convention (type-hinted form requests, Eloquent relationships and scopes, class names passed as strings or ::class to a container or package, Blade views by name, bundler entry points in vite/webpack config, traits, event listeners, observers, policies), dynamic dispatch (callbacks, props, $this->$method, call_user_func), reflection, code used only by tests, and code used by other repositories or published packages.',
        '"possiblyCalledByName" counts unresolved call sites using the same name; "note" flags framework conventions. Check usages in the source (search for the name, the file name and the class name) before removing anything.',
      ],
      totals: computed.totals, codeFiles: computed.codeFiles, flows: catalog.flows.length, files, symbols,
    };
  }
  /** Why an entity is (or is not) part of flows, and the flows touching it. */
  coverageOf(id: string, view?: ViewKey): CoverageDetail {
    const current = this.load(view);
    const node = this.require(current, id);
    const computed = this.coverageOfView(current);
    const file = node.type === 'file' ? computed.files.get(node.id) : undefined;
    const indices = this.flowsThrough(current, node);
    const catalog = this.catalog(current);
    return {
      id, ...(file ? { category: file.category, reason: file.reason } : {}),
      ...(computed.areas.has(node.id) ? { counts: computed.areas.get(node.id) } : {}),
      flows: indices.slice(0, 50).map(i => catalog.flows[i]!.summary), totalFlows: indices.length,
    };
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
  /** Where a comparison's changes are, as places for the split map to frame (projection/regions.ts). */
  regions(view: ViewKey, options: { level?: string }): ChangeRegionsResult {
    const current = this.comparison(view);
    if (options.level !== undefined && !isRegionLevel(options.level)) throw new Error('level must be auto, application, directory or file');
    const lookup = (id: string) => { const node = current.index.node(id); return node && { id, kind: node.kind, type: node.type, rect: current.rects.get(id)!, childCount: node.children.length, ...(node.spatialParentId ? { spatialParentId: node.spatialParentId } : {}), ...(node.change ? { change: node.change } : {}) }; };
    const picks = changeRegions(current.diff.changes.keys(), lookup, { level: options.level ?? 'auto' });
    return {
      level: picks.level, changed: picks.changed, truncated: picks.truncated,
      regions: picks.regions.map(pick => { const node = current.index.node(pick.id)!; return { node: this.summary(current, node), ancestors: current.index.spatialAncestors(node).map(ancestor => this.summary(current, ancestor)), counts: pick.counts, total: pick.total, frame: pick.box }; }),
    };
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
  /**
   * The time-lapse of `snapshots` (timeline order): computed in the background
   * on the first request, then kept until the timeline layout or the list
   * changes. Snapshots the timeline layout does not cover yet are left out.
   */
  evolution(snapshots: string[]): EvolutionResponse {
    const history = this.options.history?.();
    const base = this.timelineBase();
    if (!history || !base) throw new NotFoundError('No timeline layout: run history index');
    const covered = snapshots.filter(id => this.timeline!.snapshots.has(id));
    const key = `${base.stamp}|${covered.join(',')}`;
    let entry = this.evolutionRun;
    if (entry?.key !== key) {
      if (entry) entry.job.cancelled = true;
      const records = covered.map(id => history.snapshot(id)).filter((record): record is SnapshotRecord => !!record);
      const job: EvolutionJob = { cancelled: false, progress: 0 };
      const run: NonNullable<typeof entry> = { key, job, done: Promise.resolve() };
      run.done = computeEvolution(history, records, rootId => this.timelineFor([], rootId), job)
        .then(data => { if (data) run.result = { status: 'ready', stamp: base.stamp, ...data }; })
        .catch(error => { run.error = error instanceof Error ? error.message : String(error); });
      this.evolutionRun = entry = run;
    }
    if (entry.error) throw new Error(entry.error);
    return entry.result ?? { status: 'computing', progress: entry.job.progress };
  }
  /** The time-lapse once computed (for callers that can wait, such as tests). */
  async awaitEvolution(snapshots: string[]): Promise<EvolutionResponse> {
    this.evolution(snapshots);
    await this.evolutionRun!.done;
    return this.evolution(snapshots);
  }
}
function nodeChange(change: EntityChange, current: { name: string; path?: string }, previous: { name: string; path?: string } | undefined): NodeChange {
  return {
    status: change.status, facets: change.facets,
    ...(change.previousId ? { previousId: change.previousId, ...(change.lineage ? { lineage: change.lineage } : {}) } : {}),
    ...(previous && previous.name !== current.name ? { previousName: previous.name } : {}), ...(previous?.path && previous.path !== current.path ? { previousPath: previous.path } : {}),
  };
}
function impactDepth(depth: number | undefined): number {
  const value = depth ?? DEFAULT_IMPACT_DEPTH;
  if (!Number.isSafeInteger(value) || value < 1 || value > 10) throw new Error('depth must be 1..10');
  return value;
}
function impactTypes(types: string[] | undefined): Set<string> {
  const all: string[] = [...SYMBOL_IMPACT_TYPES, ...FILE_IMPACT_TYPES];
  if (!types?.length) return new Set(all);
  for (const type of types) if (!all.includes(type)) throw new Error(`Unknown impact relation type ${type}`);
  return new Set(types);
}
function bounded(value: unknown): unknown {
  const text = JSON.stringify(value);
  return text && text.length > 4000 ? `${text.slice(0, 4000)}…` : value;
}
function appName(current: View, node: ProjectionNode): string | undefined {
  return current.index.canonicalAncestors(node).find(item => item.type === 'application')?.name;
}
function compareNames(current: View, a: string, b: string): number {
  const x = current.index.node(a)!.name, y = current.index.node(b)!.name;
  return x < y ? -1 : x > y ? 1 : 0;
}
