// AtlasApi backed by the server-side services (no HTTP), with optional
// per-call delays and a call log. Shared by the store-level tests.
import type { NodeSummary, SourceRequest, ViewKey } from '@engine/projection/dto';
import type { GraphStore } from '../../src/storage/sqlite.js';
import type { ProjectionService } from '../../src/projection/service.js';
import type { HistoryService } from '../../src/history/service.js';
import { FlowError, type FlowStore } from '../../src/storage/flows.js';
import type { StoredFlow } from '../../src/core/flows.js';
import { ApiError, type AtlasApi, type ImpactOptions, type StoredFlowInput } from '../lib/api';
import type { MapNavigator } from '../lib/store';

export class ServiceApi implements AtlasApi {
  calls: string[] = [];
  delays = new Map<string, number>();
  view: ViewKey = {};
  constructor(private readonly store: GraphStore, private readonly projection: ProjectionService, private readonly options: { maxFileBytes?: number; history?: HistoryService; flows?: FlowStore; flowsWritable?: boolean } = {}) {}
  /** Flow writes report the server's status (409 with the stored flow on a stale revision). */
  private async flowWrite<T>(name: string, work: (flows: FlowStore, repositoryId: string) => T): Promise<T> {
    this.calls.push(`${name}:`);
    const flows = this.options.flows;
    if (!flows || this.options.flowsWritable === false) throw new ApiError(403, 'Flows are read-only on this server');
    try { return work(flows, this.store.currentRun()!.repositoryId); }
    catch (error) { if (error instanceof FlowError) throw new ApiError(error.status, error.message, error.flow ? { flow: error.flow } : undefined); throw error; }
  }
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
  relations(id: string, options: { type?: string; direction?: string; offset?: number; limit?: number }, signal?: AbortSignal) { return this.run('relations', id, signal, () => this.projection.relations(id, { ...options, view: this.view })); }
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
  path(from: string, to: string, signal?: AbortSignal) { return this.run('path', `${from}>${to}`, signal, () => this.projection.path(from, to, this.view)); }
  flows(signal?: AbortSignal) {
    return this.run('flows', '', signal, () => {
      if (!this.options.flows) throw new Error('This server stores no flows');
      return { storage: 'server' as const, writable: this.options.flowsWritable !== false, flows: this.options.flows.list(this.store.currentRun()!.repositoryId) };
    });
  }
  createFlow(flow: StoredFlowInput) { return this.flowWrite<StoredFlow>('createFlow', (flows, repository) => flows.create(repository, flow)); }
  updateFlow(id: string, flow: StoredFlowInput & { revision?: number }) { return this.flowWrite<StoredFlow>('updateFlow', (flows, repository) => flows.update(repository, id, flow, flow.revision)); }
  async deleteFlow(id: string) { await this.flowWrite('deleteFlow', (flows, repository) => { if (!flows.remove(repository, id)) throw new FlowError(404, 'Unknown flow'); }); }
  importFlows(list: StoredFlow[]) { return this.flowWrite('importFlows', (flows, repository) => flows.import(repository, list)); }
  clear() {}
}
export class RecordingNavigator implements MapNavigator {
  flights: { id: string; mode?: string }[] = [];
  flyTo(node: NodeSummary, options?: { mode?: 'focus' | 'enter' }) { this.flights.push({ id: node.id, mode: options?.mode }); }
  fitNodes() {}
  fitAll() {}
  zoomBy() {}
}
