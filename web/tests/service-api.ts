// AtlasApi backed by the server-side services (no HTTP), with optional
// per-call delays and a call log. Shared by the store-level tests.
import type { AuthorshipWindowKey, CatalogKind, NodeSummary, RegionLevel, SourceRequest, ViewKey } from '@engine/projection/dto';
import type { GraphStore } from '../../src/storage/sqlite.js';
import type { ProjectionService } from '../../src/projection/service.js';
import type { HistoryService } from '../../src/history/service.js';
import { ApiError, type AtlasApi, type ImpactOptions } from '../lib/api';
import type { MapNavigator } from '../lib/store';

export class ServiceApi implements AtlasApi {
  calls: string[] = [];
  delays = new Map<string, number>();
  view: ViewKey = {};
  constructor(private readonly store: GraphStore, private readonly projection: ProjectionService, private readonly options: { maxFileBytes?: number; history?: HistoryService } = {}) {}
  private async run<T>(name: string, key: string, signal: AbortSignal | undefined, work: () => T | Promise<T>): Promise<T> {
    this.calls.push(`${name}:${key}`);
    const delay = this.delays.get(key) ?? 0;
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    try { await this.projection.prepare(this.view); return await work(); } catch (error) { throw new ApiError(404, error instanceof Error ? error.message : String(error)); }
  }
  setView(view: ViewKey) { this.view = { ...view }; }
  meta(signal?: AbortSignal) { return this.run('meta', '', signal, () => this.projection.meta(this.view)); }
  children(id: string, offset: number, limit: number, signal?: AbortSignal) { return this.run('children', id, signal, () => this.projection.children(id, { offset, limit, view: this.view })); }
  nodes(ids: string[], signal?: AbortSignal) { return this.run('nodes', ids.join(','), signal, () => this.projection.nodes(ids, this.view)); }
  locate(id: string, signal?: AbortSignal) { return this.run('locate', id, signal, () => this.projection.locate(id, this.view)); }
  resolve(id: string, from?: string, signal?: AbortSignal) { return this.run('resolve', id, signal, async () => { if (from) await this.projection.prepare({ ...(this.view.snapshot ? { snapshot: this.view.snapshot } : {}), compareTo: from }); return this.projection.resolve(id, this.view, from); }); }
  search(query: string, type: string | undefined, signal?: AbortSignal) { return this.run('search', query, signal, () => this.projection.search(query, { type, view: this.view })); }
  relations(id: string, options: { type?: string; direction?: string; offset?: number; limit?: number; scope?: 'contained' }, signal?: AbortSignal) { return this.run('relations', id, signal, () => this.projection.relations(id, { ...options, view: this.view })); }
  aggregate(id: string, signal?: AbortSignal) { return this.run('aggregate', id, signal, () => this.projection.aggregate(id, { view: this.view })); }
  aggregateEdges(id: string, options: { anchor: string; type: string; direction: string; offset?: number; limit?: number }, signal?: AbortSignal) { return this.run('edges', id, signal, () => this.projection.aggregateEdges(id, { ...options, view: this.view })); }
  diagnostics(id: string, options: { offset?: number; limit?: number }, signal?: AbortSignal) { return this.run('diagnostics', id, signal, () => this.projection.diagnostics(id, { ...options, view: this.view })); }
  between(a: string, b: string, signal?: AbortSignal) { return this.run('between', `${a}>${b}`, signal, () => this.projection.between(a, b, this.view)); }
  entity(id: string, signal?: AbortSignal) { return this.run('entity', id, signal, () => { const entity = this.view.snapshot || this.view.compareTo ? this.projection.entity(id, this.view) : this.store.entity(id); if (!entity) throw new Error('Entity not found'); return entity; }); }
  relation(id: string, signal?: AbortSignal) { return this.run('relation', id, signal, () => { const relation = this.view.snapshot || this.view.compareTo ? this.projection.relation(id, this.view) : this.store.relation(id); if (!relation) throw new Error('Relation not found'); return relation; }); }
  source(request: SourceRequest, signal?: AbortSignal) { return this.run('source', JSON.stringify(request), signal, () => this.projection.source(request, this.options.maxFileBytes ?? 1024 * 1024, this.view)); }
  timeline(signal?: AbortSignal) { return this.run('timeline', '', signal, () => { if (!this.options.history) throw new Error('No history'); return this.options.history.timeline(); }); }
  changes(options: { status?: string; type?: string; offset?: number; limit?: number }, signal?: AbortSignal) { return this.run('changes', options.status ?? '', signal, () => this.projection.changes(this.view, options)); }
  change(id: string, signal?: AbortSignal) { return this.run('change', id, signal, () => this.projection.change(id, this.view)); }
  regions(level: RegionLevel, signal?: AbortSignal) { return this.run('regions', level, signal, () => this.projection.regions(this.view, { level })); }
  entityHistory(id: string, signal?: AbortSignal) {
    return this.run('entityHistory', id, signal, async () => {
      const history = this.options.history;
      if (!history) throw new Error('No history');
      const listed = await history.commits(await history.defaultRef());
      return this.projection.entityHistory(id, listed?.commits.map(commit => commit.sha) ?? [], await history.currentIdentity());
    });
  }
  sourceDiff(entity: string, options: { ignoreWhitespace?: boolean }, signal?: AbortSignal) { return this.run('sourceDiff', entity, signal, () => this.projection.sourceDiff(entity, this.options.maxFileBytes ?? 1024 * 1024, this.view, options)); }
  requestIndex(sha: string) { return this.run('requestIndex', sha, undefined, () => { if (!this.options.history) throw new Error('No history'); return this.options.history.request(sha); }); }
  /** Waits for the time-lapse instead of reporting progress. */
  evolution(signal?: AbortSignal) {
    return this.run('evolution', '', signal, async () => {
      if (!this.options.history) throw new Error('No history');
      const timeline = await this.options.history.timeline();
      return this.projection.awaitEvolution(timeline.entries.flatMap(entry => entry.snapshot ? [entry.snapshot.id] : []));
    });
  }
  impact(id: string | { comparison: true }, options: ImpactOptions, signal?: AbortSignal) {
    return this.run('impact', typeof id === 'string' ? id : 'comparison', signal, () => typeof id === 'string' ? this.projection.impact(id, { ...options, view: this.view }) : this.projection.commitImpact(this.view, options));
  }
  steps(id: string, signal?: AbortSignal) { return this.run('steps', id, signal, () => this.projection.steps(id, { view: this.view, maxFileBytes: this.options.maxFileBytes ?? 1024 * 1024 })); }
  requestFlows(entity?: string, signal?: AbortSignal) { return this.run('requestFlows', entity ?? '', signal, () => this.projection.requestFlows({ view: this.view, entity })); }
  requestFlow(id: string, signal?: AbortSignal) { return this.run('requestFlow', id, signal, () => this.projection.requestFlow(id, { view: this.view, maxFileBytes: this.options.maxFileBytes ?? 1024 * 1024 })); }
  catalog(options: { entity?: string; kind?: CatalogKind }, signal?: AbortSignal) { return this.run('catalog', `${options.kind ?? ''}|${options.entity ?? ''}`, signal, () => this.projection.flows({ ...options, view: this.view })); }
  coverage(signal?: AbortSignal) { return this.run('coverage', '', signal, () => this.projection.coverage(this.view)); }
  coverageOf(id: string, signal?: AbortSignal) { return this.run('coverageOf', id, signal, () => this.projection.coverageOf(id, this.view)); }
  coverageExport(signal?: AbortSignal) { return this.run('coverageExport', '', signal, () => this.projection.coverageExport(this.view)); }
  annotations(signal?: AbortSignal) { return this.run('annotations', '', signal, () => this.projection.annotationsOverview()); }
  entityAnnotation(id: string, signal?: AbortSignal) { return this.run('entityAnnotation', id, signal, () => this.projection.entityAnnotation(id, this.view)); }
  families(signal?: AbortSignal) { return this.run('families', '', signal, () => this.projection.families(this.view)); }
  features(signal?: AbortSignal) { return this.run('features', '', signal, () => this.projection.features(this.view)); }
  authorship(window: AuthorshipWindowKey, signal?: AbortSignal) { return this.run('authorship', window, signal, () => this.projection.authorship(this.view, { window })); }
  personAuthorship(key: string, window: AuthorshipWindowKey, signal?: AbortSignal) { return this.run('personAuthorship', `${key}|${window}`, signal, () => this.projection.personAuthorship(key, this.view, { window })); }
  entityAuthorship(id: string, window: AuthorshipWindowKey, signal?: AbortSignal) { return this.run('entityAuthorship', `${id}|${window}`, signal, () => this.projection.entityAuthorship(id, this.view, { window })); }
  clear() {}
}
export class RecordingNavigator implements MapNavigator {
  flights: { id: string; mode?: string }[] = [];
  flyTo(node: NodeSummary, options?: { mode?: 'focus' | 'enter' }) { this.flights.push({ id: node.id, mode: options?.mode }); }
  fits: string[][] = [];
  fitNodes(nodes: NodeSummary[]) { this.fits.push(nodes.map(node => node.id)); }
  fitAll() {}
  zoomBy() {}
}
