// Store-level integration: the real AtlasStore driven against the real
// projection service over the indexed fixture repository (no browser).
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';
import { indexRepository } from '../../src/pipeline/index.js';
import { GraphStore } from '../../src/storage/sqlite.js';
import { ProjectionService } from '../../src/projection/service.js';
import type { SoftwareGraph } from '../../src/core/graph.js';
import { arrangeParam, AtlasStore } from '../lib/store';
import { RecordingNavigator, ServiceApi as BaseServiceApi } from './service-api';

const fixture = fileURLToPath(new URL('../../tests/fixtures/repository', import.meta.url));
let root: string, graph: SoftwareGraph, store: GraphStore, projection: ProjectionService;
before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'atlas-web-'));
  await cp(fixture, root, { recursive: true });
  await mkdir(path.join(root, '.codiluce'));
  await writeFile(path.join(root, '.codiluce/config.yml'), stringify({ repository: { name: 'fixture' }, applications: [{ name: 'frontend', path: 'frontend', type: 'nextjs' }, { name: 'backend', path: 'backend', type: 'laravel', apiOrigins: ['https://api.fixture.test'], apiOriginEnv: ['NEXT_PUBLIC_API_URL'] }] }));
  graph = await indexRepository(root);
  store = new GraphStore(':memory:'); store.save(graph);
  projection = new ProjectionService(store, { root });
});
after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
class ServiceApi extends BaseServiceApi { constructor() { super(store, projection); } }

const id = (name: string, type?: string) => graph.entities.find(entity => entity.name === name && (!type || entity.type === type))!.id;
async function ready(api = new ServiceApi()) {
  const atlas = new AtlasStore(api);
  const navigator = new RecordingNavigator();
  atlas.navigator = navigator;
  await atlas.init();
  return { atlas, api, navigator };
}

test('init loads only the projection root and its first level, not the whole graph', async () => {
  const { atlas, api } = await ready();
  assert.equal(atlas.getState().status, 'ready');
  // Besides the root's children, only the small annotations overview (empty when none were written).
  assert.deepEqual(api.calls.sort(), ['annotations:', `children:${graph.run.repositoryId}`, 'meta:'].sort());
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
test('arranging folders and data families: view parameters, saved choices, one file coloring at a time', async () => {
  assert.equal(arrangeParam({ mode: 'off', folders: {} }), undefined);
  assert.equal(arrangeParam({ mode: 'auto', folders: { b: 'none', a: 'auto', c: 'name' } }), 'auto;b=none;c=name', 'choices equal to the mode are dropped, folders sorted');
  const saved = new Map<string, string>();
  const storage = { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => void saved.set(key, value) };
  const atlas = new AtlasStore(new ServiceApi(), { storage });
  atlas.navigator = new RecordingNavigator();
  await atlas.init();
  const controllers = id('Controllers', 'directory');
  await atlas.setArrangeMode('auto');
  assert.deepEqual(atlas.viewKey(), { arrange: 'auto' });
  await atlas.setFolderArrangement(controllers, 'name');
  assert.deepEqual(atlas.viewKey(), { arrange: `auto;${controllers}=name` });
  assert.equal(atlas.getState().selection?.id, controllers, 'the folder is shown after its choice');
  await atlas.setFolderArrangement(controllers, 'auto');
  assert.deepEqual(atlas.getState().arrange.folders, {}, 'back to the default: nothing to remember');
  assert.equal(JSON.parse(saved.get('codiluce:prefs')!).arrange.mode, 'auto', 'the arrangement is a preference');
  await atlas.setLens('data');
  assert.deepEqual(atlas.viewKey(), { lens: 'data' });
  assert.equal(atlas.getState().meta!.layout.bounds !== undefined, true);
  await atlas.toggleCoverage(true);
  await atlas.toggleFamilies(true);
  assert.equal(atlas.getState().coverage.show, false, 'families replace coverage');
  assert.ok(atlas.getState().families.data!.families.length > 0);
  const users = atlas.getState().families.data!.of[id('users', 'database_table')]!;
  atlas.focusFamily(users);
  assert.equal(atlas.getState().families.focus, users);
  atlas.focusFamily(users);
  assert.equal(atlas.getState().families.focus, undefined, 'selecting the family again lets it go');
  await atlas.toggleCoverage(true);
  assert.equal(atlas.getState().families.show, false, 'coverage replaces families');
  // A returning user keeps the arrangement.
  const again = new AtlasStore(new ServiceApi(), { storage });
  assert.equal(again.getState().arrange.mode, 'auto');
});
