// Store-level integration: the real AtlasStore driven against the real
// projection service over the indexed fixture repository (no browser).
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';
import type { NodeSummary, SourceRequest } from '@engine/projection/dto';
import { indexRepository } from '../../src/pipeline/index.js';
import { GraphStore } from '../../src/storage/sqlite.js';
import { ProjectionService } from '../../src/projection/service.js';
import { readIndexedSource } from '../../src/projection/source.js';
import type { SoftwareGraph } from '../../src/core/graph.js';
import { ApiError, type AtlasApi } from '../lib/api';
import { memoryFlowPersistence } from '../lib/flows';
import { AtlasStore, type MapNavigator } from '../lib/store';

const fixture = fileURLToPath(new URL('../../tests/fixtures/repository', import.meta.url));
let root: string, graph: SoftwareGraph, store: GraphStore, projection: ProjectionService;
before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'atlas-web-'));
  await cp(fixture, root, { recursive: true });
  await mkdir(path.join(root, '.archipelago'));
  await writeFile(path.join(root, '.archipelago/config.yml'), stringify({ repository: { name: 'fixture' }, applications: [{ name: 'frontend', path: 'frontend', type: 'nextjs' }, { name: 'backend', path: 'backend', type: 'laravel', apiOrigins: ['https://api.fixture.test'] }] }));
  graph = await indexRepository(root);
  store = new GraphStore(':memory:'); store.save(graph);
  projection = new ProjectionService(store);
});
after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });

/** AtlasApi backed by the server-side services, with optional per-call delays and a call log. */
class ServiceApi implements AtlasApi {
  calls: string[] = [];
  delays = new Map<string, number>();
  private async run<T>(name: string, key: string, signal: AbortSignal | undefined, work: () => T | Promise<T>): Promise<T> {
    this.calls.push(`${name}:${key}`);
    const delay = this.delays.get(key) ?? 0;
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    try { return await work(); } catch (error) { throw new ApiError(404, error instanceof Error ? error.message : String(error)); }
  }
  meta() { return this.run('meta', '', undefined, () => projection.meta()); }
  children(id: string, offset: number, limit: number, signal?: AbortSignal) { return this.run('children', id, signal, () => projection.children(id, { offset, limit })); }
  nodes(ids: string[], signal?: AbortSignal) { return this.run('nodes', ids.join(','), signal, () => projection.nodes(ids)); }
  locate(id: string, signal?: AbortSignal) { return this.run('locate', id, signal, () => projection.locate(id)); }
  search(query: string, type: string | undefined, signal?: AbortSignal) { return this.run('search', query, signal, () => projection.search(query, { type })); }
  relations(id: string, options: { type?: string; direction?: string; offset?: number; limit?: number }, signal?: AbortSignal) { return this.run('relations', id, signal, () => projection.relations(id, options)); }
  aggregate(id: string, signal?: AbortSignal) { return this.run('aggregate', id, signal, () => projection.aggregate(id, {})); }
  aggregateEdges(id: string, options: { anchor: string; type: string; direction: string; offset?: number; limit?: number }, signal?: AbortSignal) { return this.run('edges', id, signal, () => projection.aggregateEdges(id, options)); }
  diagnostics(id: string, options: { offset?: number; limit?: number }, signal?: AbortSignal) { return this.run('diagnostics', id, signal, () => projection.diagnostics(id, options)); }
  between(a: string, b: string, signal?: AbortSignal) { return this.run('between', `${a}>${b}`, signal, () => projection.between(a, b)); }
  entity(id: string, signal?: AbortSignal) { return this.run('entity', id, signal, () => { const entity = store.entity(id); if (!entity) throw new Error('Entity not found'); return entity; }); }
  relation(id: string, signal?: AbortSignal) { return this.run('relation', id, signal, () => { const relation = store.relation(id); if (!relation) throw new Error('Relation not found'); return relation; }); }
  source(request: SourceRequest, signal?: AbortSignal) { return this.run('source', JSON.stringify(request), signal, () => readIndexedSource(store, root, 1024 * 1024, request)); }
  clear() {}
}
class RecordingNavigator implements MapNavigator {
  flights: { id: string; mode?: string }[] = [];
  flyTo(node: NodeSummary, options?: { mode?: 'focus' | 'enter' }) { this.flights.push({ id: node.id, mode: options?.mode }); }
  fitNodes() {}
  fitAll() {}
  zoomBy() {}
}
const id = (name: string, type?: string) => graph.entities.find(entity => entity.name === name && (!type || entity.type === type))!.id;
async function ready(api = new ServiceApi()) {
  const atlas = new AtlasStore(api, { flowPersistence: () => memoryFlowPersistence(), now: () => '2026-10-01T00:00:00Z', newId: () => 'flow-1' });
  const navigator = new RecordingNavigator();
  atlas.navigator = navigator;
  await atlas.init();
  return { atlas, api, navigator };
}

test('init loads only the projection root and its first level, not the whole graph', async () => {
  const { atlas, api } = await ready();
  assert.equal(atlas.getState().status, 'ready');
  assert.deepEqual(api.calls, ['meta:', `children:${graph.run.repositoryId}`]);
  assert.ok(atlas.scene.nodes.size < graph.entities.length / 3);
});
test('selecting a deeply nested search result loads its ancestors, reveals it and records history', async () => {
  const { atlas, api, navigator } = await ready();
  const [result] = projection.search('AuthController::login', {}).items;
  await atlas.select(result!.id, { fly: true });
  const state = atlas.getState();
  assert.equal(state.selection?.id, result!.id);
  assert.deepEqual(state.selection?.locate?.canonicalAncestors.map(item => item.name), ['fixture', 'backend', 'app', 'Http', 'Controllers', 'AuthController.php', 'AuthController']);
  // Every spatial ancestor is reachable in the scene and had its children requested.
  for (const ancestor of state.selection!.locate!.spatialAncestors) {
    assert.ok(atlas.scene.nodes.has(ancestor.id));
    assert.ok(atlas.scene.childList(ancestor.id).ids.length > 0, `${ancestor.name} has loaded children`);
  }
  assert.ok(atlas.scene.childList(state.selection!.locate!.spatialAncestors.at(-1)!.id).ids.includes(result!.id));
  assert.deepEqual(navigator.flights.at(-1), { id: result!.id, mode: 'focus' });
  assert.equal(state.selection?.entity?.metadata.qualifiedName, 'App\\Http\\Controllers\\AuthController::login');
  assert.ok(state.relations.items.some(item => item.type === 'handles' && item.direction === 'incoming'));
  assert.ok(api.calls.includes(`entity:${result!.id}`));
  // History: select another entity, go back and forward.
  await atlas.select(id('LoginForm', 'component'));
  await atlas.back();
  assert.equal(atlas.getState().selection?.id, result!.id);
  await atlas.forward();
  assert.equal(atlas.getState().selection?.id, id('LoginForm', 'component'));
});
test('rapid navigation cancels stale selection work', async () => {
  const api = new ServiceApi();
  const { atlas } = await ready(api);
  const slow = id('AuthService', 'class'), fast = id('LoginForm', 'component');
  api.delays.set(slow, 40);
  const first = atlas.select(slow);
  const second = atlas.select(fast);
  await Promise.all([first, second]);
  const state = atlas.getState();
  assert.equal(state.selection?.id, fast);
  assert.equal(state.selection?.entity?.id, fast);
  assert.ok(state.relations.forId === fast || state.relations.forId === undefined);
});
test('relationship evidence opens the supporting source line', async () => {
  const { atlas } = await ready();
  const endpoint = id('POST /auth/login', 'api_endpoint');
  await atlas.select(endpoint);
  const handles = atlas.getState().relations.items.find(item => item.type === 'handles')!;
  assert.equal(handles.direction, 'outgoing');
  await atlas.openEvidence(handles.id);
  const evidence = atlas.getState().evidence!;
  assert.equal(evidence.status, 'ready');
  const index = evidence.relation!.evidence.findIndex(fact => fact.file === 'backend/routes/api.php' && fact.line === 6);
  await atlas.openSource({ relation: handles.id, evidence: index }, 'route');
  const source = atlas.getState().source!;
  assert.equal(source.status, 'ready');
  assert.equal(source.data!.focus!.startLine, 6);
  assert.ok(source.data!.lines[6 - source.data!.start]!.includes("Route::post('login'"));
  // Read further keeps the same evidence focus.
  await atlas.sourceWindow(1, 3);
  assert.deepEqual([atlas.getState().source!.data!.start, atlas.getState().source!.data!.focus!.startLine], [1, 6]);
});
test('containers show aggregated boundary edges that drill down to individual relationships', async () => {
  const { atlas } = await ready();
  await atlas.select(id('frontend', 'application'));
  const aggregate = atlas.getState().aggregate;
  assert.equal(aggregate.status, 'ready');
  const toBackend = aggregate.data!.groups.find(group => group.anchor.name === 'backend')!;
  assert.equal(toBackend.type, 'requests');
  await atlas.drillAggregate(toBackend);
  const drill = atlas.getState().aggregate.drill!;
  assert.equal(drill.items.length, toBackend.count);
  assert.ok(drill.items.every(item => item.type === 'requests' && item.inside.path?.startsWith('frontend/')));
});
test('flows save entity IDs, show graph links only where relationships exist, and play', async () => {
  const { atlas } = await ready();
  const caller = id('login', 'function'), endpoint = id('POST /auth/login', 'api_endpoint');
  const handler = graph.entities.find(entity => entity.metadata.qualifiedName === 'App\\Http\\Controllers\\AuthController::login')!.id;
  const unrelated = id('UserPage', 'component');
  atlas.startDraft();
  atlas.addDraftStep(caller); atlas.addDraftStep(unrelated); atlas.addDraftStep(endpoint); atlas.addDraftStep(handler);
  atlas.moveDraftStep(1, 3);
  atlas.setDraftName('Login chain');
  assert.equal(await atlas.saveDraft(), true);
  const { flows } = atlas.getState();
  assert.deepEqual(flows.flows[0]!.steps.map(step => step.entityId), [caller, endpoint, handler, unrelated]);
  const links = flows.resolved!.links.map(items => items.map(item => item.type));
  assert.deepEqual(links, [['requests'], ['handles'], []], 'declared order without a relationship stays unlinked');
  atlas.playbackAction({ type: 'play' });
  atlas.playbackAction({ type: 'tick', elapsedMs: 2500, stepMs: 1000 });
  assert.equal(atlas.getState().flows.playback.index, 2);
});
test('flows survive reindexing with missing steps flagged', async () => {
  const persistence = memoryFlowPersistence([{ id: 'old', name: 'Old', type: 'declared', createdAt: 't', updatedAt: 't', steps: [{ entityId: id('LoginForm', 'component') }, { entityId: 'symbol:removed-by-reindex' }, { entityId: id('UserPage', 'component') }] }]);
  const atlas = new AtlasStore(new ServiceApi(), { flowPersistence: () => persistence });
  await atlas.init();
  await atlas.activateFlow('old');
  const resolved = atlas.getState().flows.resolved!;
  assert.deepEqual(resolved.steps.map(step => step.missing), [false, true, false]);
  assert.deepEqual(atlas.getState().flows.playback.playable, [0, 2]);
});
