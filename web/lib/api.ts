// Browser client for the read-only API. Responses are cached per analysis run
// (immutable for that run); in-flight requests can be aborted by callers and
// aborted requests are never cached.
import type { Entity, Relation } from '@engine/core/graph';
import type { AggregateEdgesPage, AggregateResult, DiagnosticsPage, LocateResult, NodeSummary, Page, ProjectionMeta, RelationItem, RelationsPage, SearchPage, SourceRequest, SourceResponse } from '@engine/projection/dto';

export class ApiError extends Error { constructor(readonly status: number, message: string) { super(message); } }
export function isAbort(error: unknown): boolean { return error instanceof DOMException && error.name === 'AbortError' || (error instanceof Error && error.name === 'AbortError'); }
type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface AtlasApi {
  meta(signal?: AbortSignal): Promise<ProjectionMeta>;
  children(id: string, offset: number, limit: number, signal?: AbortSignal): Promise<Page<NodeSummary>>;
  nodes(ids: string[], signal?: AbortSignal): Promise<{ items: NodeSummary[]; missing: string[] }>;
  locate(id: string, signal?: AbortSignal): Promise<LocateResult>;
  search(query: string, type: string | undefined, signal?: AbortSignal): Promise<SearchPage>;
  relations(id: string, options: { type?: string; direction?: string; offset?: number; limit?: number }, signal?: AbortSignal): Promise<RelationsPage>;
  aggregate(id: string, signal?: AbortSignal): Promise<AggregateResult>;
  aggregateEdges(id: string, options: { anchor: string; type: string; direction: string; offset?: number; limit?: number }, signal?: AbortSignal): Promise<AggregateEdgesPage>;
  diagnostics(id: string, options: { offset?: number; limit?: number }, signal?: AbortSignal): Promise<DiagnosticsPage>;
  between(a: string, b: string, signal?: AbortSignal): Promise<{ items: RelationItem[] }>;
  entity(id: string, signal?: AbortSignal): Promise<Entity>;
  relation(id: string, signal?: AbortSignal): Promise<Relation>;
  source(request: SourceRequest, signal?: AbortSignal): Promise<SourceResponse>;
  clear(): void;
}
const MAX_CACHE = 800;

export class HttpAtlasApi implements AtlasApi {
  private readonly cache = new Map<string, unknown>();
  constructor(private readonly base = '', private readonly fetcher: Fetch = (input, init) => fetch(input, init)) {}
  clear(): void { this.cache.clear(); }
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
  meta(signal?: AbortSignal) { return this.get<ProjectionMeta>('/api/projection', signal, false); }
  children(id: string, offset: number, limit: number, signal?: AbortSignal) { return this.get<Page<NodeSummary>>(`/api/projection/children/${encodeURIComponent(id)}?offset=${offset}&limit=${limit}`, signal); }
  nodes(ids: string[], signal?: AbortSignal) { return this.get<{ items: NodeSummary[]; missing: string[] }>(`/api/projection/nodes?ids=${ids.map(encodeURIComponent).join(',')}`, signal); }
  locate(id: string, signal?: AbortSignal) { return this.get<LocateResult>(`/api/projection/locate/${encodeURIComponent(id)}`, signal); }
  search(query: string, type: string | undefined, signal?: AbortSignal) { return this.get<SearchPage>(`/api/projection/search?q=${encodeURIComponent(query)}&limit=40${type ? `&type=${encodeURIComponent(type)}` : ''}`, signal); }
  relations(id: string, options: { type?: string; direction?: string; offset?: number; limit?: number }, signal?: AbortSignal) {
    const params = new URLSearchParams({ offset: String(options.offset ?? 0), limit: String(options.limit ?? 100) });
    if (options.type) params.set('type', options.type);
    if (options.direction) params.set('direction', options.direction);
    return this.get<RelationsPage>(`/api/projection/relations/${encodeURIComponent(id)}?${params}`, signal);
  }
  aggregate(id: string, signal?: AbortSignal) { return this.get<AggregateResult>(`/api/projection/aggregate/${encodeURIComponent(id)}`, signal); }
  aggregateEdges(id: string, options: { anchor: string; type: string; direction: string; offset?: number; limit?: number }, signal?: AbortSignal) {
    const params = new URLSearchParams({ anchor: options.anchor, type: options.type, direction: options.direction, offset: String(options.offset ?? 0), limit: String(options.limit ?? 50) });
    return this.get<AggregateEdgesPage>(`/api/projection/aggregate/${encodeURIComponent(id)}/edges?${params}`, signal);
  }
  diagnostics(id: string, options: { offset?: number; limit?: number }, signal?: AbortSignal) { return this.get<DiagnosticsPage>(`/api/projection/diagnostics/${encodeURIComponent(id)}?offset=${options.offset ?? 0}&limit=${options.limit ?? 50}`, signal); }
  between(a: string, b: string, signal?: AbortSignal) { return this.get<{ items: RelationItem[] }>(`/api/projection/between?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`, signal); }
  entity(id: string, signal?: AbortSignal) { return this.get<Entity>(`/api/entities/${encodeURIComponent(id)}`, signal); }
  relation(id: string, signal?: AbortSignal) { return this.get<Relation>(`/api/relations/${encodeURIComponent(id)}`, signal); }
  source(request: SourceRequest, signal?: AbortSignal) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(request)) if (value !== undefined) params.set(key, String(value));
    // Source is read live from the working tree; never cached so change detection stays honest.
    return this.get<SourceResponse>(`/api/source?${params}`, signal, false);
  }
}
