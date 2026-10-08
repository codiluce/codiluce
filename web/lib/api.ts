// Browser client for the read-only API. Responses are cached per analysis run
// and view (immutable for that snapshot/baseline pair); in-flight requests can
// be aborted by callers and aborted requests are never cached.
import type { Entity, Relation } from '@engine/core/graph';
import type { EvolutionResponse } from '@engine/projection/dto';
import type { AnnotationsOverview, EntityAnnotation } from '@engine/projection/dto';
import type { AggregateEdgesPage, AggregateResult, CatalogKind, ChangeRegionsResult, ChangesPage, RegionLevel, CoverageDetail, CoverageExport, CoverageResult, DiagnosticsPage, EntityChangeDetail, EntityHistoryResponse, FamiliesResult, FlowList, ImpactResult, LocateResult, NodeSummary, Page, ProjectionMeta, RelationItem, RelationsPage, RequestFlow, RequestFlowList, SearchPage, SourceDiffResponse, SourceRequest, SourceResponse, StepsResult, TimelineResponse, ViewKey } from '@engine/projection/dto';

export class ApiError extends Error { constructor(readonly status: number, message: string, readonly body?: unknown) { super(message); } }
export function isAbort(error: unknown): boolean { return error instanceof DOMException && error.name === 'AbortError' || (error instanceof Error && error.name === 'AbortError'); }
type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface AtlasApi {
  /** The snapshot (and baseline) that every projection request reads. */
  setView(view: ViewKey): void;
  meta(signal?: AbortSignal): Promise<ProjectionMeta>;
  children(id: string, offset: number, limit: number, signal?: AbortSignal): Promise<Page<NodeSummary>>;
  nodes(ids: string[], signal?: AbortSignal): Promise<{ items: NodeSummary[]; missing: string[] }>;
  locate(id: string, signal?: AbortSignal): Promise<LocateResult>;
  /** The ID an entity has in the current view (lineage may have carried it to another ID). */
  resolve(id: string, from?: string, signal?: AbortSignal): Promise<{ id: string; via?: 'lineage' } | undefined>;
  search(query: string, type: string | undefined, signal?: AbortSignal): Promise<SearchPage>;
  /** `scope: 'contained'` (files): also the relationships of its symbols across the file's boundary. */
  relations(id: string, options: { type?: string; direction?: string; offset?: number; limit?: number; scope?: 'contained' }, signal?: AbortSignal): Promise<RelationsPage>;
  aggregate(id: string, signal?: AbortSignal): Promise<AggregateResult>;
  aggregateEdges(id: string, options: { anchor: string; type: string; direction: string; offset?: number; limit?: number }, signal?: AbortSignal): Promise<AggregateEdgesPage>;
  diagnostics(id: string, options: { offset?: number; limit?: number }, signal?: AbortSignal): Promise<DiagnosticsPage>;
  between(a: string, b: string, signal?: AbortSignal): Promise<{ items: RelationItem[] }>;
  entity(id: string, signal?: AbortSignal): Promise<Entity>;
  relation(id: string, signal?: AbortSignal): Promise<Relation>;
  source(request: SourceRequest, signal?: AbortSignal): Promise<SourceResponse>;
  timeline(signal?: AbortSignal): Promise<TimelineResponse>;
  changes(options: { status?: string; type?: string; offset?: number; limit?: number }, signal?: AbortSignal): Promise<ChangesPage>;
  change(id: string, signal?: AbortSignal): Promise<EntityChangeDetail>;
  /** Where the comparison's changes are, grouped into places for the split map. */
  regions(level: RegionLevel, signal?: AbortSignal): Promise<ChangeRegionsResult>;
  entityHistory(id: string, signal?: AbortSignal): Promise<EntityHistoryResponse>;
  /** The history time-lapse (status `computing` with progress until the server has built it). */
  evolution(signal?: AbortSignal): Promise<EvolutionResponse>;
  sourceDiff(entity: string, options: { ignoreWhitespace?: boolean }, signal?: AbortSignal): Promise<SourceDiffResponse>;
  requestIndex(sha: string): Promise<{ queued: boolean; position: number }>;
  /** Blast radius of an entity; `comparison` asks for what the viewed comparison's changes reach. */
  impact(id: string | { comparison: true }, options: ImpactOptions, signal?: AbortSignal): Promise<ImpactResult>;
  steps(id: string, signal?: AbortSignal): Promise<StepsResult>;
  /** Request flows of the view (`entity`: only those that draw it). */
  requestFlows(entity?: string, signal?: AbortSignal): Promise<RequestFlowList>;
  /** One request flow: an endpoint's, or an entity's unmatched requests. */
  requestFlow(id: string, signal?: AbortSignal): Promise<RequestFlow>;
  /** Every flow by entry point (`entity`: those touching it; `kind`: one kind). */
  catalog(options: { entity?: string; kind?: CatalogKind }, signal?: AbortSignal): Promise<FlowList>;
  /** Which files the flows touch, per file and per area. */
  coverage(signal?: AbortSignal): Promise<CoverageResult>;
  /** Why an entity is (or is not) part of flows, and the flows touching it. */
  coverageOf(id: string, signal?: AbortSignal): Promise<CoverageDetail>;
  /** Code no flow is proven to use (files, and unused symbols of reached files), to review. */
  coverageExport(signal?: AbortSignal): Promise<CoverageExport>;
  /** What the language models said about the repository (overview, domains, counts, cost). */
  annotations(signal?: AbortSignal): Promise<AnnotationsOverview>;
  /** An entity's description and domain. */
  entityAnnotation(id: string, signal?: AbortSignal): Promise<EntityAnnotation>;
  /** Data families: tables joined by foreign keys, and the code using them (per file and per area). */
  families(signal?: AbortSignal): Promise<FamiliesResult>;
  clear(): void;
}
export interface ImpactOptions { depth?: number; type?: string; distance?: number; offset?: number; limit?: number }
const MAX_CACHE = 800;

export class HttpAtlasApi implements AtlasApi {
  private readonly cache = new Map<string, unknown>();
  private view: ViewKey = {};
  constructor(private readonly base = '', private readonly fetcher: Fetch = (input, init) => fetch(input, init)) {}
  clear(): void { this.cache.clear(); }
  setView(view: ViewKey): void { this.view = { ...view }; }
  /** Query string with the current view appended. */
  private q(params: Record<string, string | number | undefined> = {}): string {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) if (value !== undefined) search.set(key, String(value));
    if (this.view.snapshot) search.set('snapshot', this.view.snapshot);
    if (this.view.compareTo) search.set('compareTo', this.view.compareTo);
    if (this.view.lens) search.set('lens', this.view.lens);
    const text = search.toString();
    return text ? `?${text}` : '';
  }
  private async get<T>(path: string, signal?: AbortSignal, cache = true): Promise<T> {
    if (cache && this.cache.has(path)) {
      const value = this.cache.get(path) as T;
      this.cache.delete(path); this.cache.set(path, value);
      return value;
    }
    const response = await this.fetcher(`${this.base}${path}`, { signal, headers: { Accept: 'application/json' } });
    let body: unknown;
    try { body = await response.json(); } catch { throw new ApiError(response.status, `Unexpected response (${response.status})`); }
    if (!response.ok) throw new ApiError(response.status, (body as { error?: string })?.error ?? `Request failed (${response.status})`);
    if (cache) {
      this.cache.set(path, body);
      if (this.cache.size > MAX_CACHE) this.cache.delete(this.cache.keys().next().value!);
    }
    return body as T;
  }
  meta(signal?: AbortSignal) { return this.get<ProjectionMeta>(`/api/projection${this.q()}`, signal, false); }
  children(id: string, offset: number, limit: number, signal?: AbortSignal) { return this.get<Page<NodeSummary>>(`/api/projection/children/${encodeURIComponent(id)}${this.q({ offset, limit })}`, signal); }
  nodes(ids: string[], signal?: AbortSignal) { return this.get<{ items: NodeSummary[]; missing: string[] }>(`/api/projection/nodes${this.q({ ids: ids.join(',') })}`, signal); }
  locate(id: string, signal?: AbortSignal) { return this.get<LocateResult>(`/api/projection/locate/${encodeURIComponent(id)}${this.q()}`, signal); }
  async resolve(id: string, from?: string, signal?: AbortSignal) {
    try { return await this.get<{ id: string; via?: 'lineage' }>(`/api/projection/resolve/${encodeURIComponent(id)}${this.q({ from })}`, signal); }
    catch (error) { if (error instanceof ApiError && error.status === 404) return undefined; throw error; }
  }
  search(query: string, type: string | undefined, signal?: AbortSignal) { return this.get<SearchPage>(`/api/projection/search${this.q({ q: query, limit: 40, type })}`, signal); }
  relations(id: string, options: { type?: string; direction?: string; offset?: number; limit?: number; scope?: 'contained' }, signal?: AbortSignal) {
    return this.get<RelationsPage>(`/api/projection/relations/${encodeURIComponent(id)}${this.q({ offset: options.offset ?? 0, limit: options.limit ?? 100, type: options.type, direction: options.direction, scope: options.scope })}`, signal);
  }
  aggregate(id: string, signal?: AbortSignal) { return this.get<AggregateResult>(`/api/projection/aggregate/${encodeURIComponent(id)}${this.q()}`, signal); }
  aggregateEdges(id: string, options: { anchor: string; type: string; direction: string; offset?: number; limit?: number }, signal?: AbortSignal) {
    return this.get<AggregateEdgesPage>(`/api/projection/aggregate/${encodeURIComponent(id)}/edges${this.q({ anchor: options.anchor, type: options.type, direction: options.direction, offset: options.offset ?? 0, limit: options.limit ?? 50 })}`, signal);
  }
  diagnostics(id: string, options: { offset?: number; limit?: number }, signal?: AbortSignal) { return this.get<DiagnosticsPage>(`/api/projection/diagnostics/${encodeURIComponent(id)}${this.q({ offset: options.offset ?? 0, limit: options.limit ?? 50 })}`, signal); }
  between(a: string, b: string, signal?: AbortSignal) { return this.get<{ items: RelationItem[] }>(`/api/projection/between${this.q({ a, b })}`, signal); }
  entity(id: string, signal?: AbortSignal) { return this.get<Entity>(`/api/entities/${encodeURIComponent(id)}${this.q()}`, signal); }
  relation(id: string, signal?: AbortSignal) { return this.get<Relation>(`/api/relations/${encodeURIComponent(id)}${this.q()}`, signal); }
  source(request: SourceRequest, signal?: AbortSignal) {
    // Live source is read from the working tree: never cached so change detection stays honest.
    return this.get<SourceResponse>(`/api/source${this.q({ ...request })}`, signal, false);
  }
  timeline(signal?: AbortSignal) { return this.get<TimelineResponse>('/api/history', signal, false); }
  changes(options: { status?: string; type?: string; offset?: number; limit?: number }, signal?: AbortSignal) { return this.get<ChangesPage>(`/api/history/changes${this.q({ status: options.status, type: options.type, offset: options.offset ?? 0, limit: options.limit ?? 100 })}`, signal); }
  regions(level: RegionLevel, signal?: AbortSignal) { return this.get<ChangeRegionsResult>(`/api/history/regions${this.q({ level })}`, signal); }
  change(id: string, signal?: AbortSignal) { return this.get<EntityChangeDetail>(`/api/history/change/${encodeURIComponent(id)}${this.q()}`, signal); }
  entityHistory(id: string, signal?: AbortSignal) { return this.get<EntityHistoryResponse>(`/api/history/entity/${encodeURIComponent(id)}`, signal, false); }
  evolution(signal?: AbortSignal) { return this.get<EvolutionResponse>('/api/history/evolution', signal, false); }
  sourceDiff(entity: string, options: { ignoreWhitespace?: boolean }, signal?: AbortSignal) { return this.get<SourceDiffResponse>(`/api/source/diff${this.q({ entity, whitespace: options.ignoreWhitespace ? 'ignore' : undefined })}`, signal); }
  impact(id: string | { comparison: true }, options: ImpactOptions, signal?: AbortSignal) {
    const params = { depth: options.depth, type: options.type, distance: options.distance, offset: options.offset ?? 0, limit: options.limit ?? 100 };
    return this.get<ImpactResult>(typeof id === 'string' ? `/api/projection/impact/${encodeURIComponent(id)}${this.q(params)}` : `/api/history/impact${this.q(params)}`, signal);
  }
  steps(id: string, signal?: AbortSignal) { return this.get<StepsResult>(`/api/projection/steps/${encodeURIComponent(id)}${this.q()}`, signal); }
  requestFlows(entity?: string, signal?: AbortSignal) { return this.get<RequestFlowList>(`/api/projection/request-flows${this.q({ entity })}`, signal); }
  requestFlow(id: string, signal?: AbortSignal) { return this.get<RequestFlow>(`/api/projection/request-flows/${encodeURIComponent(id)}${this.q()}`, signal); }
  catalog(options: { entity?: string; kind?: CatalogKind }, signal?: AbortSignal) { return this.get<FlowList>(`/api/projection/flows${this.q({ entity: options.entity, kind: options.kind })}`, signal); }
  coverage(signal?: AbortSignal) { return this.get<CoverageResult>(`/api/projection/coverage${this.q()}`, signal); }
  coverageOf(id: string, signal?: AbortSignal) { return this.get<CoverageDetail>(`/api/projection/coverage/${encodeURIComponent(id)}${this.q()}`, signal); }
  coverageExport(signal?: AbortSignal) { return this.get<CoverageExport>(`/api/projection/coverage/export${this.q()}`, signal); }
  annotations(signal?: AbortSignal) { return this.get<AnnotationsOverview>('/api/annotations', signal, false); }
  entityAnnotation(id: string, signal?: AbortSignal) { return this.get<EntityAnnotation>(`/api/annotations/entity/${encodeURIComponent(id)}${this.q()}`, signal); }
  families(signal?: AbortSignal) { return this.get<FamiliesResult>(`/api/projection/families${this.q()}`, signal); }
  async requestIndex(sha: string) {
    const response = await this.fetcher(`${this.base}/api/history/index`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Codiluce-Request': 'index' }, body: JSON.stringify({ sha }) });
    const body = await response.json().catch(() => ({})) as { error?: string; queued?: boolean; position?: number };
    if (!response.ok) throw new ApiError(response.status, body.error ?? `Request failed (${response.status})`);
    return body as { queued: boolean; position: number };
  }
}
