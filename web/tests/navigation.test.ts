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
import { AtlasStore, NO_FAMILY } from '../lib/store';
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
test('the code panel follows the selection: a symbol in its file, the file whole, an area as a list', async () => {
  const { atlas, api } = await ready();
  const until = async (check: () => boolean) => { for (let i = 0; i < 400 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 5)); assert.ok(check()); };
  const [login] = projection.search('AuthController::login', {}).items;
  await atlas.select(login!.id, { fly: false });
  atlas.openCode();
  assert.equal(atlas.getState().center, 'map', 'a panel beside the inspector: the map stays in the middle');
  await until(() => atlas.getState().code?.status === 'ready' && atlas.getState().code?.outline?.status === 'ready');
  let code = atlas.getState().code!;
  assert.equal(code.data!.file.path, 'backend/app/Http/Controllers/AuthController.php');
  assert.equal(code.data!.start, 1, 'a short file is read from its top');
  assert.equal(code.data!.end, code.data!.totalLines);
  assert.deepEqual([code.data!.focus?.kind, code.data!.focus?.startLine], ['symbol', login!.sourceRange!.startLine]);
  assert.deepEqual(code.outline!.items.map(item => [item.name, item.level]), [['AuthController', 0], ['login', 1], ['user', 1]]);
  // Another symbol of the same file, then the file itself: marked without reading the file again.
  const reads = () => api.calls.filter(call => call.startsWith('source:')).length;
  const before = reads();
  assert.ok(before > 0);
  await atlas.select(code.outline!.items.find(item => item.name === 'user')!.id, { fly: false });
  code = atlas.getState().code!;
  assert.equal(code.data!.focus?.label, 'method user');
  await atlas.select(code.data!.file.id, { fly: false });
  assert.equal(atlas.getState().code!.data!.focus, undefined);
  assert.equal(reads(), before);
  // An area lists what it holds instead.
  await atlas.select(id('Controllers', 'directory'), { fly: false });
  code = atlas.getState().code!;
  assert.equal(code.node?.type, 'directory');
  assert.equal(code.data, undefined);
  await until(() => atlas.scene.childList(id('Controllers', 'directory')).complete);
  // A tool in the middle does not stop it following.
  void atlas.openImpactTool();
  await atlas.select(login!.id, { fly: false });
  await until(() => atlas.getState().code?.forId === login!.id && atlas.getState().code?.status === 'ready');
  atlas.closeCode();
  assert.equal(atlas.getState().center, 'impact');
  assert.equal(atlas.getState().code, undefined);
  // Closed, it reads nothing.
  const closed = reads();
  await atlas.select(id('AuthController.php', 'file'), { fly: false });
  assert.equal(reads(), closed);
});
test('data families: loaded for the inspector without coloring the map, lit one at a time, one file coloring at a time', async () => {
  const { atlas } = await ready();
  await atlas.ensureFamilies();
  const families = atlas.getState().families;
  assert.equal(families.status, 'ready');
  assert.equal(families.show, false, 'the inspector reads families without coloring the map');
  const users = families.data!.of[id('users', 'database_table')]!;
  assert.ok(families.data!.areas[id('Models', 'directory')]![users]! > 0, 'a folder counts its files per family');
  const loaded = families.data;
  await atlas.ensureFamilies();
  assert.equal(atlas.getState().families.data, loaded, 'loaded once per view');
  atlas.focusFamily(NO_FAMILY);
  assert.equal(atlas.getState().families.focus, NO_FAMILY, 'code without tables can be lit too');
  assert.equal(atlas.getState().families.show, true, 'lighting a family colors the map');
  await atlas.loadFamilies();
  assert.equal(atlas.getState().families.focus, NO_FAMILY, 'it stays lit when the families load again');
  await atlas.toggleCoverage(true);
  await atlas.toggleFamilies(true);
  assert.equal(atlas.getState().coverage.show, false, 'families replace coverage');
  atlas.focusFamily(users);
  assert.equal(atlas.getState().families.focus, users);
  atlas.focusFamily(users);
  assert.equal(atlas.getState().families.focus, undefined, 'selecting the family again lets it go');
  await atlas.toggleCoverage(true);
  assert.equal(atlas.getState().families.show, false, 'coverage replaces families');
});
test('color by: one coloring of the files at a time; a measure is loaded once per view and says why it has nothing', async () => {
  const { atlas } = await ready();
  assert.equal(atlas.colorMode(), 'type');
  await atlas.colorBy('complexity');
  const lens = atlas.getState().lens;
  assert.equal(atlas.colorMode(), 'complexity');
  assert.equal(lens.status, 'ready');
  assert.equal(lens.data?.available, true);
  assert.equal(lens.stamp, atlas.lensStamp());
  assert.ok(Object.keys(lens.data!.of).includes(id('AuthController.php', 'file')), 'the PHP files are measured');
  await atlas.colorBy('complexity');
  assert.equal(atlas.getState().lens.data, lens.data, 'loaded once per view');
  await atlas.colorBy('coverage');
  assert.equal(atlas.colorMode(), 'coverage');
  assert.equal(atlas.getState().lens.show, undefined, 'coverage replaces the measure');
  await atlas.colorBy('changes');
  assert.equal(atlas.getState().coverage.show, false, 'and the other way round');
  assert.equal(atlas.getState().lens.data?.available, false, 'without Git history there are no changes to count');
  assert.match(atlas.getState().lens.data!.reason!, /Git/);
  await atlas.togglePeopleColors(true);
  assert.equal(atlas.colorMode(), 'people', 'people replace the measure');
  await atlas.colorBy('type');
  const state = atlas.getState();
  assert.deepEqual([state.coverage.show, state.families.show, state.people.show, state.lens.show], [false, false, false, undefined]);
});
test('features: lit one at a time (a lit family lets go), framed on the map, the tree remembers its open branches', async () => {
  const api = new ServiceApi();
  const controllers = id('Controllers', 'directory'), auth = id('AuthController.php', 'file');
  api.features = async () => ({ features: [{ key: 'accounts', name: 'Accounts', summary: 'People sign in.', files: 1, color: 0, folders: [{ id: controllers, path: 'backend/app/Http/Controllers', files: 1 }] }], of: { [auth]: 'accounts' }, areas: { [controllers]: { accounts: 1 } } });
  const { atlas, navigator } = await ready(api);
  atlas.focusFamily(NO_FAMILY);
  await atlas.focusFeature('accounts', { fit: true });
  const features = atlas.getState().features;
  assert.equal(features.focus, 'accounts');
  assert.equal(features.status, 'ready', 'focusing loads the features');
  assert.equal(atlas.getState().families.focus, undefined, 'a lit feature lets the lit family go');
  assert.equal(features.open.accounts, true, 'its branch opens');
  assert.deepEqual(navigator.fits.at(-1), [controllers], 'the camera frames its folders');
  atlas.focusFamily(NO_FAMILY);
  assert.equal(atlas.getState().features.focus, undefined, 'and the other way round');
  const reveal = atlas.getState().features.reveal ?? 0;
  await atlas.revealFeature('accounts');
  assert.equal(atlas.getState().features.reveal, reveal + 1, 'the shell is asked to show the panel');
  assert.equal(atlas.getState().features.focus, 'accounts');
  await atlas.focusFeature('accounts');
  assert.equal(atlas.getState().features.focus, undefined, 'selecting it again shows every file');
  atlas.setFeatureOpen('accounts:flows');
  atlas.setFeatureOpen('accounts', false);
  assert.deepEqual(atlas.getState().features.open, { accounts: false, 'accounts:flows': true });
  atlas.setFlowGroupsOpen(['a', 'b'], false);
  assert.deepEqual(atlas.getState().catalog.open, { a: false, b: false });
  atlas.setCatalogQuery('login');
  assert.deepEqual(atlas.getState().catalog.open, {}, 'a new filter opens the groups again');
});
