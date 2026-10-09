// Flows in the visualizer: the lane layout, the one list of flows (kinds,
// completeness, groups), flows on the map, and the store's actions against the real
// projection service over the indexed fixture repository.
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
import type { FlowSummary, NodeSummary, RequestFlow, RequestFlowEdge, RequestFlowNode } from '../../src/projection/dto.js';
import { layoutRequestFlow, statusClass } from '../lib/request-flows';
import { groupCatalog, kindsOf, visibleCatalog } from '../lib/catalog';
import { branchDuration, branchesOf, branchPosition, flowAreas, flowLit, fromRequestFlow, fromSteps, groupBranches, WAVE_MS, type MapEdge, type MapStop } from '../lib/map-flow';
import { AtlasStore } from '../lib/store';
import { RecordingNavigator, ServiceApi } from './service-api';

const fixture = fileURLToPath(new URL('../../tests/fixtures/repository', import.meta.url));
let root: string, graph: SoftwareGraph, store: GraphStore, projection: ProjectionService;
before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'atlas-request-flows-'));
  await cp(fixture, root, { recursive: true });
  await mkdir(path.join(root, '.codiluce'));
  await writeFile(path.join(root, '.codiluce/config.yml'), stringify({ repository: { name: 'fixture' }, applications: [{ name: 'frontend', path: 'frontend', type: 'nextjs' }, { name: 'backend', path: 'backend', type: 'laravel', apiOrigins: ['https://api.fixture.test'], apiOriginEnv: ['NEXT_PUBLIC_API_URL'] }] }));
  graph = await indexRepository(root);
  store = new GraphStore(':memory:'); store.save(graph);
  projection = new ProjectionService(store, { root });
});
after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
const id = (name: string, type?: string) => graph.entities.find(entity => entity.name === name && (!type || entity.type === type))!.id;
async function ready() {
  const atlas = new AtlasStore(new ServiceApi(store, projection), { location: { hash: '', replace: () => undefined } });
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
test('catalog flows are grouped by application and group, filtered by text and completeness', () => {
  const item = (name: string, app: string, group: string, status: FlowSummary['status'], handler?: string): FlowSummary => ({ id: name, kind: status === 'unmatched' ? 'unmatched' : 'request', entry: { id: name, type: 'api_endpoint', name }, name, method: name.split(' ')[0]!, path: name.split(' ')[1]!, app, group, detail: 'lanes', status, entities: 1, files: 1, ...(handler ? { handler } : {}) });
  const items = [item('GET /a/1', 'api', '/a', 'complete', 'A::one'), item('POST /a/2', 'api', '/a', 'partial', 'A::two'), item('GET /b', 'api', '/b', 'headless'), item('GET /x', 'web', 'unmatched', 'unmatched')];
  assert.deepEqual(groupCatalog(items).map(group => [group.app, group.group, group.items.length]), [['api', '/a', 2], ['api', '/b', 1], ['web', 'unmatched', 1]]);
  assert.equal(groupCatalog(items).at(-1)!.label, 'Unmatched requests');
  assert.deepEqual(groupCatalog(items, 'a::two').flatMap(group => group.items.map(entry => entry.name)), ['POST /a/2'], 'matches handlers, case-insensitively');
  assert.deepEqual(groupCatalog(items, '', 'headless').flatMap(group => group.items.map(entry => entry.name)), ['GET /b']);
  assert.deepEqual(kindsOf('request'), ['request', 'unmatched'], 'the Requests filter includes requests no endpoint answers');
  assert.deepEqual(kindsOf('command'), ['schedule', 'command']);
  assert.deepEqual(kindsOf('all'), ['page', 'request', 'unmatched', 'command', 'schedule']);
  // One list: a page and the requests under its path share a group; console flows come after the areas.
  const page: FlowSummary = { id: 'page', kind: 'page', entry: { id: 'page', type: 'api_endpoint', name: 'GET /a' }, name: 'GET /a', path: '/a', app: 'api', group: '/a', detail: 'lanes', status: 'complete', entities: 1, files: 1 };
  const command: FlowSummary = { id: 'command', kind: 'command', entry: { id: 'command', type: 'command', name: 'reports:send' }, name: 'reports:send', app: 'api', group: 'reports:', detail: 'lanes', status: 'partial', entities: 1, files: 1 };
  const all = [command, page, ...items];
  const ids = (groups: ReturnType<typeof visibleCatalog>) => groups.flatMap(group => group.items.map(entry => entry.id));
  assert.deepEqual(visibleCatalog(all, { tab: 'all', query: '' }).map(group => [group.app, group.group, group.items.map(entry => entry.id)]), [['api', '/a', ['page', 'GET /a/1', 'POST /a/2']], ['api', '/b', ['GET /b']], ['api', 'reports:', ['command']], ['web', 'unmatched', ['GET /x']]]);
  assert.deepEqual(ids(visibleCatalog(all, { tab: 'page', query: '' })), ['page']);
  assert.deepEqual(ids(visibleCatalog(all, { tab: 'all', query: '', status: 'partial' })), ['POST /a/2'], 'completeness is about HTTP: console flows have none');
  assert.deepEqual(ids(visibleCatalog(all, { tab: 'command', query: '', status: 'partial' })), ['command'], 'a list without HTTP flows ignores the completeness filter');
  assert.deepEqual([200, 302, 404, 503, undefined].map(statusClass), ['ok', 'redirect', 'client', 'server', 'unknown']);
});
test('a flow on the map: stops in the order a request passes them, links between them, the rest pinned to its block', async () => {
  const flow = await projection.requestFlow(id('POST /auth/login', 'api_endpoint'), { maxFileBytes: 1 << 20 });
  const map = fromRequestFlow(flow);
  const labels = map.stops.map(stop => stop.label);
  const order = ['/account', 'handleSave', 'AccountService.signIn', 'POST /auth/login'].map(label => labels.indexOf(label));
  assert.ok(order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1]!)), `client, call, then route: ${labels.join(', ')}`);
  assert.equal(map.stops[0]!.tone, 'client');
  assert.ok(labels.indexOf('AuthController::login') < labels.indexOf('users'), 'the handler before the data');
  assert.equal(new Set(map.stops.map(stop => stop.entityId)).size, map.stops.length, 'an entity is one stop (the caller receiving the response is the same block)');
  const middleware = map.pins.find(pin => pin.kind === 'middleware')!;
  assert.equal(middleware.ownerId, id('POST /auth/login', 'api_endpoint'), 'middleware is pinned to its endpoint');
  assert.ok(map.pins.some(pin => pin.kind === 'response' && pin.tone === 'ok'));
  assert.ok(map.edges.every(edge => edge.from !== edge.to));
  // A branch per place it is made from (each choice on a page, a caller nothing indexed calls), grouped by where that is.
  assert.deepEqual(map.branches.map(branch => [branch.group, branch.label]), [['From /account', 'handleSave'], ['From /account', 'login'], ['From /login', 'login'], ['No indexed trigger', 'signInJson']]);
  const [fromAccount] = map.branches;
  const waveOf = (label: string) => fromAccount!.waves.findIndex(wave => wave.some(index => map.stops[index]!.label === label));
  assert.ok(waveOf('/account') === 0 && waveOf('handleSave') === 1 && waveOf('AuthController::login') === waveOf('POST /auth/login') + 1 && waveOf('users') > waveOf('AuthController::login'), 'from the choice on the page, through the middleware to the handler');
  assert.equal(waveOf('login'), -1, 'another choice on the same page is a branch of its own');
  assert.ok(fromAccount!.links.every(link => !map.edges[link.edge]!.back || link.wave === fromAccount!.waves.length), 'the way back flows after the way there');
  const areas = flowAreas(map, fromAccount);
  assert.ok(fromAccount!.waves.flat().every(index => map.stops[index]!.ancestors.every(ancestor => areas.has(ancestor))), 'every area holding a stop of the branch opens');
  // What stays lit: every entity the flow touches, folded ones included, and their areas.
  const lit = flowLit(map);
  assert.ok(map.stops.every(stop => lit.has(stop.entityId) && stop.ancestors.every(ancestor => lit.has(ancestor))));
  assert.ok(flow.edges.flatMap(edge => edge.via).every(item => lit.has(item.id)));
  // A page's Steps become a flow too: one branch per choice the page offers.
  const steps = fromSteps(await projection.steps(id('/account', 'route'), { maxFileBytes: 1 << 20 }));
  assert.equal(steps.stops[0]!.entityId, id('/account', 'route'));
  assert.ok(steps.branches.length > 1 && steps.branches.every(branch => branch.waves[0]![0] === 0), 'every branch starts at the page');
  const save = steps.branches.find(branch => steps.stops[branch.head]!.label === 'handleSave')!;
  assert.equal(save.event, 'onClick');
  assert.equal(save.group, 'AccountPanel', 'grouped by the component binding it');
  assert.ok(steps.members.some(member => member.id === id('AccountPanel', 'component')), 'folded components are members');
  assert.ok(steps.pins.length > 0, 'effects are pins');
});
test('a page on the map: opened directly first, then each control requesting it, from this page and from others', async () => {
  // An Inertia page is drawn where its component lives, apart from the endpoint serving it.
  const rebuild = fromRequestFlow(await projection.requestFlow(id('POST /admin/rebuild', 'api_endpoint'), { maxFileBytes: 1 << 20 }));
  assert.ok(!rebuild.stops.some(stop => stop.entityId === id('GET /admin', 'api_endpoint')), 'the page is not drawn on the endpoint serving it');
  assert.ok(rebuild.branches.every(branch => branch.group === 'From /admin' && rebuild.stops[branch.waves[0]![0]!]!.entityId === id('Dashboard', 'component')), 'every branch starts at the page component');
  assert.deepEqual(rebuild.branches.map(branch => [branch.event, branch.label]), [[undefined, 'Dashboard'], ['onClick', 'again'], ['onClick', 'rebuild'], ['onClick', 'third']], 'its own requests, then each control (the event bound in the page itself)');
  // A page nothing indexed visits: the visit, its page rendered once the server is done.
  const admin = fromRequestFlow(await projection.requestFlow(id('GET /admin', 'api_endpoint'), { maxFileBytes: 1 << 20 }));
  assert.deepEqual(admin.branches.map(branch => branch.group), ['Direct visit']);
  assert.deepEqual(admin.branches[0]!.waves.map(wave => wave.map(index => admin.stops[index]!.label)), [['GET /admin'], ['AdminController::index'], ['User'], ['users'], ['Dashboard']]);

  // A page requesting itself (filters, search, sorting) and visited from another page.
  const at = (key: string, type: string, name: string) => ({ id: key, kind: 'entity', type, name, depth: 0, rect: { x: 0, y: 0, w: 1, h: 1 }, childCount: 0 }) as unknown as NodeSummary;
  const endpoint = at('ep', 'api_endpoint', 'GET /words'), handler = at('index', 'method', 'WordController::index'), model = at('Word', 'model', 'Word'), table = at('words', 'database_table', 'words');
  const page = at('WordsIndex', 'component', 'WordsIndex'), search = at('handleSearch', 'function', 'handleSearch'), sort = at('handleSort', 'function', 'handleSort');
  const other = at('ep2', 'api_endpoint', 'GET /lists'), otherPage = at('ListsIndex', 'component', 'ListsIndex'), tab = at('handleTab', 'function', 'handleTab');
  const node = (key: string, lane: RequestFlowNode['lane'], kind: RequestFlowNode['kind'], summary?: NodeSummary, extra: Partial<RequestFlowNode> = {}): RequestFlowNode => ({ id: key, lane, kind, depth: 0, label: summary?.name ?? key, ancestors: ['area'], ...(summary ? { node: summary } : {}), ...extra });
  const edge = (from: string, to: string, kind: RequestFlowEdge['kind'], extra: Partial<RequestFlowEdge> = {}): RequestFlowEdge => ({ id: `${from}>${to}`, from, to, kind, hops: [], via: [], when: [], ...extra });
  const response = { category: 'response', operation: 'inertia', detail: '', line: 9, status: 200, owner: 'index', ownerName: 'WordController::index' } as unknown as RequestFlowNode['effect'];
  const flow = {
    id: 'ep', kind: 'endpoint', name: 'GET /words', method: 'GET', path: '/words', group: '/words', status: 'complete', gaps: 0, callers: 3, tables: 1, responses: [200], anchor: endpoint, lanes: [], notices: [],
    stages: { client: true, call: true, handler: true, data: true, response: true, returns: true },
    nodes: [
      node('ep:ep', 'route', 'endpoint', endpoint), node('mw', 'gate', 'middleware', undefined, { label: 'web' }), node('srv:index', 'controller', 'handler', handler),
      node('data:Word', 'data', 'model', model), node('data:words', 'data', 'table', table), node('res', 'response', 'response', undefined, { effect: response, status: 200 }),
      node('page:WordsIndex', 'return', 'page', page),
      node('client:ep', 'client', 'page', endpoint, { page: { node: page, ancestors: ['area'] } }), node('call:handleSearch', 'call', 'caller', search), node('call:handleSort', 'call', 'caller', sort),
      node('client:ep2', 'client', 'page', other, { page: { node: otherPage, ancestors: ['area'] } }), node('call:handleTab', 'call', 'caller', tab),
      node('ret:handleSearch', 'return', 'receive', search), node('ret:handleSort', 'return', 'receive', sort), node('ret:handleTab', 'return', 'receive', tab),
    ],
    edges: [
      edge('ep:ep', 'mw', 'routes'), edge('mw', 'srv:index', 'handles'), edge('srv:index', 'data:Word', 'reads'), edge('data:Word', 'data:words', 'maps'), edge('srv:index', 'res', 'responds'), edge('res', 'page:WordsIndex', 'renders'),
      edge('client:ep', 'call:handleSearch', 'triggers', { label: 'onClick · WordsIndex', via: [{ id: 'index', name: 'WordController::index', type: 'method', ancestors: [] }, { id: 'WordsIndex', name: 'WordsIndex', type: 'component', ancestors: [] }] }),
      edge('client:ep', 'call:handleSort', 'triggers', { label: 'onClick · WordsIndex' }), edge('client:ep2', 'call:handleTab', 'triggers', { label: 'onValueChange · ListsIndex' }),
      edge('call:handleSearch', 'ep:ep', 'requests'), edge('call:handleSort', 'ep:ep', 'requests'), edge('call:handleTab', 'ep:ep', 'requests'),
      edge('res', 'ret:handleSearch', 'returns'), edge('res', 'ret:handleSort', 'returns'), edge('res', 'ret:handleTab', 'returns'),
    ],
  } as RequestFlow;
  const map = fromRequestFlow(flow);
  assert.equal(new Set(map.stops.map(stop => stop.entityId)).size, map.stops.length);
  assert.equal(map.stops.filter(stop => stop.entityId === 'ep').length, 1, 'the endpoint is one stop, apart from the page');
  assert.equal(map.edges.find(item => item.to === 'handleSearch')!.via, undefined, 'what leads to the component is behind the page stop');
  assert.deepEqual(map.branches.map(branch => [branch.group, branch.event, branch.label]), [['Direct visit', undefined, 'GET /words'], ['From this page', 'onClick', 'handleSearch'], ['From this page', 'onClick', 'handleSort'], ['From /lists', 'onValueChange', 'handleTab']]);
  const waves = (index: number) => map.branches[index]!.waves.map(wave => wave.map(stop => map.stops[stop]!.label));
  const back = (index: number) => { const branch = map.branches[index]!; return branch.links.filter(link => link.wave >= branch.waves.length).map(link => map.edges[link.edge]!.to).sort(); };
  assert.deepEqual(waves(0), [['GET /words'], ['WordController::index'], ['Word'], ['words'], ['WordsIndex']], 'opening the page: the server, then the page it renders');
  assert.deepEqual(back(0), []);
  assert.deepEqual(waves(1), [['WordsIndex'], ['handleSearch'], ['GET /words'], ['WordController::index'], ['Word'], ['words']], 'one control: never the others on the page, never mixed with the server');
  assert.deepEqual(back(1), ['WordsIndex', 'handleSearch'], 'the page renders again and the caller has its answer, last');
  assert.deepEqual(waves(3), [['ListsIndex'], ['handleTab'], ['GET /words'], ['WordController::index'], ['Word'], ['words'], ['WordsIndex']], 'from another page: to the page rendered');
  assert.deepEqual(back(3), ['handleTab']);
  assert.deepEqual(groupBranches(map.branches).map(group => [group.label, group.title]), [['Direct visit', 'Opening the page: what the server does, then the page it renders'], ['From this page', 'Controls on this page that request it again'], ['From /lists', 'Made on the page /lists']]);
});
test('branches play from the start along real edges, in waves; siblings share a wave, the way back comes last', () => {
  const stop = (key: string): MapStop => ({ key, entityId: key, ancestors: ['area'], label: key, kind: 'method', tone: 'server' });
  const edge = (from: string, to: string, extra: Partial<MapEdge> = {}): MapEdge => ({ key: `${from}>${to}`, from, fromAncestors: ['area'], to, toAncestors: ['area'], type: 'calls', ...extra });
  // page → (onClick) save → {api, cache}; page → load → api; api → back to save.
  const stops = ['page', 'save', 'load', 'api', 'cache'].map(stop);
  const edges = [edge('page', 'save', { event: 'onClick', via: [{ name: 'Panel', type: 'component' }] }), edge('page', 'load'), edge('save', 'api'), edge('save', 'cache'), edge('load', 'api'), edge('api', 'save', { back: true })];
  const branches = branchesOf({ stops, edges });
  assert.deepEqual(branches.map(branch => [branch.label, branch.event, branch.group]), [['save', 'onClick', 'Panel'], ['load', undefined, 'page']]);
  const [save, load] = branches;
  const names = (waves: number[][]) => waves.map(wave => wave.map(index => stops[index]!.key));
  assert.deepEqual(names(save!.waves), [['page'], ['save'], ['api', 'cache']], 'siblings are reached at the same moment');
  assert.deepEqual(names(load!.waves), [['page'], ['load'], ['api']], 'only what the choice leads to');
  assert.deepEqual(save!.links.map(link => [edges[link.edge]!.key, link.wave]), [['page>save', 0], ['save>api', 1], ['save>cache', 1], ['api>save', 3]], 'the way back flows last');
  // Several starting stops (callers of one endpoint): each start is a branch.
  const callerStops = ['a', 'b', 'api'].map(stop);
  const callers = branchesOf({ stops: callerStops, edges: [edge('a', 'api'), edge('b', 'api')] });
  assert.deepEqual(callers.map(branch => branch.waves.map(wave => wave.map(index => callerStops[index]!.key))), [[['a'], ['api']], [['b'], ['api']]]);
  assert.equal(branchesOf({ stops: [{ ...stop('/x'), kind: 'page' }, { ...stop('/y'), kind: 'page' }, stop('api')], edges: [edge('/x', 'api'), edge('/y', 'api')] })[0]!.group, 'pages', 'pages calling an endpoint are grouped together');
  assert.deepEqual(groupBranches(branches).map(group => [group.label, group.items.map(item => item.index)]), [['Panel', [0]], ['page', [1]]]);
  // Timing: one wave per edge step plus a last one; before playing and at the end the whole branch shows.
  assert.equal(branchDuration(save), WAVE_MS * 5);
  assert.deepEqual(branchPosition(save!, { status: 'playing', progress: 0.3 }), { position: 1.5, front: 1 });
  assert.deepEqual(branchPosition(save!, { status: 'idle', progress: 0 }), { position: 4, front: 2 });
});
test('the store lists every flow, shows one on the map, steps through it, and lists those through an entity', async () => {
  const atlas = await ready();
  await atlas.showFlows();
  let catalog = atlas.getState().catalog;
  assert.equal(catalog.status, 'ready');
  assert.equal(catalog.reveal, 1, 'asks the shell to show the Flows panel');
  assert.equal(catalog.kind, 'all', 'one list of every kind of flow');
  assert.ok(catalog.data!.counts.page > 0 && catalog.data!.counts.request > 10 && catalog.data!.counts.command > 0);
  atlas.setCatalogFilter('headless');
  assert.equal(atlas.getState().catalog.filter, 'headless');
  atlas.setCatalogFilter('headless');
  assert.equal(atlas.getState().catalog.filter, undefined, 'choosing the same filter again clears it');
  // A request on the map: its stops are placed in the scene, the request plays.
  const login = catalog.data!.items.find(item => item.name === 'POST /auth/login')!;
  await atlas.openCatalogFlow(login);
  let tour = atlas.getState().tour!;
  assert.equal(tour.status, 'ready');
  assert.equal(tour.title, 'POST /auth/login');
  assert.equal(tour.playback.status, 'playing');
  assert.ok(tour.flow!.stops.every(stop => atlas.scene.nodes.has(stop.entityId)), 'stops are placed in the scene');
  assert.ok(tour.flow!.stops.every(stop => stop.ancestors.every(ancestor => atlas.scene.nodes.has(ancestor))), 'and the areas holding them');
  // Choosing something yourself pauses the flow, so its next stop does not take the selection away.
  await atlas.select(id('LoginForm', 'component'), { fly: false });
  assert.equal(atlas.getState().tour!.playback.status, 'paused');
  atlas.tourAction({ type: 'play' });
  assert.equal(atlas.getState().tour!.playback.status, 'playing');
  // Played branch by branch to the end.
  assert.equal(tour.flow!.branches.length, 4);
  atlas.tourAction({ type: 'tick', elapsedMs: 100_000, stepMs: 1000 });
  assert.equal(atlas.getState().tour!.playback.status, 'finished');
  // A stop chosen in the bar is selected.
  const table = tour.flow!.stops.findIndex(stop => stop.label === 'users');
  atlas.focusTourStop(table);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(atlas.getState().selection?.id, tour.flow!.stops[table]!.entityId);
  // The lanes of a flow in the middle, as an outline too, then the same flow on the map.
  await atlas.openRequestFlow(login.id);
  assert.equal(atlas.getState().center, 'flow');
  assert.equal(atlas.getState().requests.open?.status, 'ready');
  atlas.focusRequestNode(atlas.getState().requests.open!.data!.nodes[0]!.id);
  assert.ok(atlas.getState().requests.open?.focus);
  await atlas.setFlowLayout('outline');
  assert.equal(atlas.getState().steps?.anchor, login.id, 'the outline starts where the lanes do');
  assert.equal(atlas.getState().steps?.status, 'ready');
  await atlas.setFlowLayout('diagram');
  atlas.traceRequestFlow();
  assert.equal(atlas.getState().center, 'map', 'the map comes back to the middle');
  assert.equal(atlas.getState().flowView?.id, login.id, 'the lanes stay open, a tab away');
  assert.equal(atlas.getState().tour?.key, `lanes:${login.id}`);
  atlas.closeFlowView();
  assert.equal(atlas.getState().requests.open, undefined);
  atlas.closeTour();
  assert.equal(atlas.getState().tour, undefined);
  // The flows through an entity: requests and the page journeys reaching it.
  const users = graph.entities.find(entity => entity.type === 'database_table' && entity.name === 'users')!;
  await atlas.showFlows({ entity: { id: users.id, name: users.name } });
  catalog = atlas.getState().catalog;
  assert.deepEqual(catalog.entity, { id: users.id, name: 'users' });
  assert.ok(catalog.data!.items.some(item => item.name === 'PUT /profiles/{id}'));
  assert.ok(catalog.data!.items.some(item => item.kind === 'page' && item.name === '/account'));
  await atlas.loadCatalog(null);
  assert.equal(atlas.getState().catalog.entity, undefined);
  assert.ok(atlas.getState().catalog.data!.items.some(item => item.kind === 'unmatched'));
  // A page is shown through its Steps.
  const account = atlas.getState().catalog.data!.items.find(item => item.kind === 'page' && item.name === '/account')!;
  await atlas.openCatalogFlow(account);
  tour = atlas.getState().tour!;
  assert.equal(tour.detail, 'steps');
  assert.equal(tour.flow?.stops[0]?.entityId, account.id);
  // Branch by branch: the next one starts with its choice selected.
  atlas.tourAction({ type: 'pause' });
  atlas.tourAction({ type: 'next' });
  tour = atlas.getState().tour!;
  assert.equal(tour.playback.index, 1);
  assert.equal(atlas.getState().selection?.id, tour.flow!.stops[tour.flow!.branches[1]!.head]!.entityId, 'the choice the branch plays is selected');
  // The coverage lens.
  await atlas.toggleCoverage();
  const coverage = atlas.getState().coverage;
  assert.equal(coverage.show, true);
  assert.equal(coverage.status, 'ready');
  assert.ok(coverage.data!.codeFiles > 0);
  // Selecting a file says why it is (or is not) in a flow, and lists its relationships through its symbols.
  const service = graph.entities.find(entity => entity.type === 'file' && entity.path === 'backend/app/Services/AuthService.php')!;
  await atlas.select(service.id, { fly: false });
  const selection = atlas.getState().selection!;
  assert.equal(selection.coverage?.data?.category, 'flow');
  assert.ok(selection.coverage!.data!.totalFlows > 0);
  assert.ok(atlas.getState().relations.items.some(item => item.inside?.name === 'authenticate'));
});
