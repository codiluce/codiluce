// Request flows in the visualizer: the lane layout, the spine traced on the
// map, list grouping, and the store's actions against the real projection
// service over the indexed fixture repository.
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
import type { RequestFlowSummary } from '../../src/projection/dto.js';
import { memoryFlowPersistence } from '../lib/flows';
import { flowSpine, groupRequestFlows, layoutRequestFlow, spineEntities, statusClass } from '../lib/request-flows';
import { AtlasStore } from '../lib/store';
import { RecordingNavigator, ServiceApi } from './service-api';

const fixture = fileURLToPath(new URL('../../tests/fixtures/repository', import.meta.url));
let root: string, graph: SoftwareGraph, store: GraphStore, projection: ProjectionService;
before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'atlas-request-flows-'));
  await cp(fixture, root, { recursive: true });
  await mkdir(path.join(root, '.archipelago'));
  await writeFile(path.join(root, '.archipelago/config.yml'), stringify({ repository: { name: 'fixture' }, applications: [{ name: 'frontend', path: 'frontend', type: 'nextjs' }, { name: 'backend', path: 'backend', type: 'laravel', apiOrigins: ['https://api.fixture.test'], apiOriginEnv: ['NEXT_PUBLIC_API_URL'] }] }));
  graph = await indexRepository(root);
  store = new GraphStore(':memory:'); store.save(graph);
  projection = new ProjectionService(store, { root });
});
after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
const id = (name: string, type?: string) => graph.entities.find(entity => entity.name === name && (!type || entity.type === type))!.id;
async function ready() {
  const atlas = new AtlasStore(new ServiceApi(store, projection), { flowPersistence: () => memoryFlowPersistence(), location: { hash: '', replace: () => undefined } });
  atlas.navigator = new RecordingNavigator();
  await atlas.init();
  return atlas;
}

test('the lane layout puts lanes in request order, deeper calls one column right, and never overlaps', () => {
  const lanes = ['client', 'route', 'controller', 'service', 'data'];
  const nodes = [
    { id: 'page', lane: 'client', depth: 0 }, { id: 'ep', lane: 'route', depth: 0 }, { id: 'handler', lane: 'controller', depth: 0 },
    { id: 's1', lane: 'service', depth: 0 }, { id: 's2', lane: 'service', depth: 1 }, { id: 's3', lane: 'service', depth: 0 }, { id: 'table', lane: 'data', depth: 1 },
  ];
  const edges = [{ id: 'a', from: 'page', to: 'ep' }, { id: 'b', from: 'ep', to: 'handler' }, { id: 'c', from: 'handler', to: 's1' }, { id: 'd', from: 's1', to: 's2' }, { id: 'e', from: 'handler', to: 's3' }, { id: 'f', from: 's2', to: 'table' }, { id: 'g', from: 's3', to: 'handler' }, { id: 'h', from: 'ep', to: 's2' }];
  const layout = layoutRequestFlow(lanes, nodes, edges);
  const at = (key: string) => layout.nodes.find(item => item.id === key)!;
  assert.deepEqual(layout.lanes.map(band => band.lane), lanes, 'every lane with nodes gets a band, in order');
  assert.equal(layout.columns, 6, 'the service lane has two sub-columns; empty sub-columns are not drawn');
  assert.ok(at('page').x < at('ep').x && at('ep').x < at('handler').x && at('handler').x < at('s1').x && at('s1').x < at('s2').x && at('s2').x < at('table').x);
  assert.equal(at('s1').x, at('s3').x);
  for (const a of layout.nodes) for (const b of layout.nodes) if (a !== b) assert.ok(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y, `${a.id} and ${b.id} overlap`);
  assert.equal(at('page').y, at('ep').y, 'a chain stays on one line');
  assert.ok(layout.edges.find(edge => edge.id === 'g')!.back, 'a call back to an earlier column loops around');
  assert.equal(layout.edges.find(edge => edge.id === 'f')!.span, 1, 'the data lane\'s unused first sub-column takes no room');
  assert.equal(layout.edges.find(edge => edge.id === 'h')!.span, 3);
  assert.deepEqual(layoutRequestFlow(lanes, nodes, edges), layout, 'deterministic');
});
test('flows are grouped by application and path segment, filtered by text and completeness', () => {
  const item = (name: string, app: string, group: string, status: RequestFlowSummary['status'], handler?: string): RequestFlowSummary => ({ id: name, kind: status === 'unmatched' ? 'unmatched' : 'endpoint', name, method: name.split(' ')[0]!, path: name.split(' ')[1]!, app, group, status, stages: { client: false, call: false, handler: false, data: false, response: false, returns: false }, gaps: 0, callers: 0, tables: 0, responses: [], ...(handler ? { handler } : {}) });
  const items = [item('GET /a/1', 'api', '/a', 'complete', 'A::one'), item('POST /a/2', 'api', '/a', 'partial', 'A::two'), item('GET /b', 'api', '/b', 'headless'), item('GET /x', 'web', 'unmatched', 'unmatched')];
  assert.deepEqual(groupRequestFlows(items).map(group => [group.app, group.group, group.items.length]), [['api', '/a', 2], ['api', '/b', 1], ['web', 'unmatched', 1]]);
  assert.deepEqual(groupRequestFlows(items, 'a::two').flatMap(group => group.items.map(entry => entry.name)), ['POST /a/2'], 'matches handlers, case-insensitively');
  assert.deepEqual(groupRequestFlows(items, '', 'headless').flatMap(group => group.items.map(entry => entry.name)), ['GET /b']);
  assert.deepEqual([200, 302, 404, 503, undefined].map(statusClass), ['ok', 'redirect', 'client', 'server', 'unknown']);
});
test('the spine runs from the page to the deepest table, through the folded plumbing', async () => {
  const flow = await projection.requestFlow(id('POST /auth/login', 'api_endpoint'), { maxFileBytes: 1 << 20 });
  const byId = new Map(flow.nodes.map(node => [node.id, node]));
  assert.deepEqual(flowSpine(flow).map(nodeId => byId.get(nodeId)!.label), ['/account', 'handleSave', 'AccountService.signIn', 'POST /auth/login', 'api', 'AuthController::login', 'AuthService::authenticate', 'User', 'users']);
  const entities = spineEntities(flow).map(entityId => graph.entities.find(entity => entity.id === entityId)!.name);
  assert.deepEqual(entities.slice(0, 7), ['/account', 'AccountPage', 'AccountPanel', 'handleSave', 'signIn', 'POST /auth/login', 'login'], 'folded components are part of the saved path, and the middleware is not an entity');
});
test('the store lists flows, opens an endpoint\'s flow from the inspector, and lists those through an entity', async () => {
  const atlas = await ready();
  await atlas.loadRequestFlows();
  let requests = atlas.getState().requests;
  assert.equal(requests.status, 'ready');
  assert.ok(requests.data!.items.length > 10);
  atlas.setRequestFilter('headless');
  assert.equal(atlas.getState().requests.filter, 'headless');
  atlas.setRequestFilter('headless');
  assert.equal(atlas.getState().requests.filter, undefined, 'choosing the same filter again clears it');
  // An endpoint opens its own flow in the theater, and asks the shell to show the panel.
  const login = graph.entities.find(entity => entity.name === 'POST /auth/login')!;
  await atlas.showRequestFlows({ id: login.id, name: login.name, type: login.type });
  requests = atlas.getState().requests;
  assert.equal(requests.reveal, 1);
  assert.equal(requests.open?.status, 'ready');
  assert.equal(requests.open?.mode, 'theater');
  assert.ok(requests.open!.data!.nodes.every(node => !node.node || atlas.scene.nodes.has(node.node.id)), 'drawn entities are placed in the scene for the map');
  atlas.focusRequestNode(requests.open!.data!.nodes[0]!.id);
  assert.equal(atlas.getState().requests.open?.focus, requests.open!.data!.nodes[0]!.id);
  atlas.setRequestFlowMode('map');
  assert.equal(atlas.getState().requests.open?.mode, 'map');
  // Saved as a flow: a draft along the spine.
  atlas.draftFromRequestFlow();
  const draft = atlas.getState().flows.draft!;
  assert.equal(draft.name, 'POST /auth/login');
  assert.equal(draft.entityIds[0], id('/account', 'route'));
  assert.equal(draft.entityIds.at(-1), graph.entities.find(entity => entity.type === 'database_table' && entity.name === 'users')!.id);
  atlas.closeRequestFlow();
  assert.equal(atlas.getState().requests.open, undefined);
  // Another entity: the flows that pass through it.
  const users = graph.entities.find(entity => entity.type === 'database_table' && entity.name === 'users')!;
  await atlas.showRequestFlows({ id: users.id, name: users.name, type: users.type });
  requests = atlas.getState().requests;
  assert.deepEqual(requests.entity, { id: users.id, name: 'users' });
  assert.ok(requests.data!.items.some(item => item.name === 'PUT /profiles/{id}'));
  assert.ok(requests.data!.items.every(item => item.kind === 'endpoint'));
  await atlas.loadRequestFlows(null);
  assert.equal(atlas.getState().requests.entity, undefined);
  assert.ok(atlas.getState().requests.data!.items.some(item => item.kind === 'unmatched'));
});
