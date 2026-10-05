import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { stringify } from 'yaml';
import { indexRepository } from '../src/pipeline/index.js';
import { GraphStore } from '../src/storage/sqlite.js';
import { createInspectionServer } from '../src/api/server.js';
import { ProjectionService } from '../src/projection/service.js';
import { ProjectionIndex, ROUTE_SUBGROUP_THRESHOLD, type EntityRow } from '../src/projection/hierarchy.js';
import { layoutHierarchy, pack, type LayoutNode, type Rect } from '../src/projection/layout.js';
import { readIndexedSource, SourceError, SOURCE_MAX_LINES } from '../src/projection/source.js';
import type { SoftwareGraph } from '../src/core/graph.js';
import { guardsAt, hintOf, phrase } from '../src/projection/conditions.js';

const fixture = fileURLToPath(new URL('./fixtures/repository', import.meta.url));
const temporary: string[] = [];
let root: string, state: string, graph: SoftwareGraph, store: GraphStore;
async function createFixture(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'atlas-projection-')); temporary.push(directory);
  await cp(fixture, directory, { recursive: true });
  await mkdir(path.join(directory, '.archipelago'));
  await writeFile(path.join(directory, '.archipelago/config.yml'), stringify({ repository: { name: 'fixture' }, applications: [{ name: 'frontend', path: 'frontend', type: 'nextjs' }, { name: 'backend', path: 'backend', type: 'laravel', apiOrigins: ['https://api.fixture.test'], apiOriginEnv: ['NEXT_PUBLIC_API_URL'] }] }));
  return directory;
}
function symbolId(qualifiedName: string): string {
  const found = graph.entities.find(entity => entity.metadata.qualifiedName === qualifiedName);
  assert.ok(found, `Expected symbol ${qualifiedName}`);
  return found.id;
}
function entityId(name: string, type?: string): string {
  const found = graph.entities.find(entity => entity.name === name && (!type || entity.type === type));
  assert.ok(found, `Expected ${type ?? 'entity'} ${name}`);
  return found.id;
}
before(async () => {
  root = await createFixture();
  state = await mkdtemp(path.join(tmpdir(), 'atlas-state-')); temporary.push(state);
  graph = await indexRepository(root);
  store = new GraphStore(':memory:'); store.save(graph);
});
after(async () => { store.close(); for (const folder of temporary) await rm(folder, { recursive: true, force: true }); });

// --- Layout ---------------------------------------------------------------
function tree(spec: Record<string, string[]>, weights: Record<string, number> = {}): Map<string, LayoutNode> {
  const nodes = new Map<string, LayoutNode>();
  const all = new Set([...Object.keys(spec), ...Object.values(spec).flat()]);
  for (const id of all) nodes.set(id, { id, children: spec[id] ?? [], weight: weights[id], padding: 4 });
  return nodes;
}
function overlaps(a: Rect, b: Rect): boolean { return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h; }
function inside(child: Rect, parent: Rect): boolean { return child.x >= parent.x && child.y >= parent.y && child.x + child.w <= parent.x + parent.w && child.y + child.h <= parent.y + parent.h; }

test('layout is deterministic, nested and non-overlapping, independent of input map order', () => {
  const spec = { root: ['a', 'b', 'c'], a: ['a1', 'a2', 'a3'], b: ['b1'], c: [] };
  const weights = { a1: 120, a2: 9, a3: 400, b1: 33, c: 70 };
  const first = layoutHierarchy(tree(spec, weights), 'root');
  const reversed = new Map([...tree(spec, weights)].reverse());
  const second = layoutHierarchy(reversed, 'root');
  assert.deepEqual([...first.rects].sort(), [...second.rects].sort());
  for (const [parent, children] of Object.entries(spec)) {
    for (const child of children) assert.ok(inside(first.rects.get(child)!, first.rects.get(parent)!), `${child} inside ${parent}`);
    for (let i = 0; i < children.length; i++) for (let j = i + 1; j < children.length; j++) assert.ok(!overlaps(first.rects.get(children[i]!)!, first.rects.get(children[j]!)!), `${children[i]} vs ${children[j]}`);
  }
  for (const rect of first.rects.values()) for (const value of Object.values(rect)) assert.ok(Number.isInteger(value), 'integer world coordinates');
});
test('persisted slots keep existing siblings in place when a child is appended or removed', () => {
  const base = { root: ['dir'], dir: Array.from({ length: 12 }, (_, i) => `f${i}`) };
  const weights = Object.fromEntries(base.dir.map((id, i) => [id, 10 + (i % 4) * 40]));
  const initial = layoutHierarchy(tree(base, weights), 'root');
  // Appending one small file: every existing file keeps its exact position.
  const added = layoutHierarchy(tree({ ...base, dir: [...base.dir, 'new'] }, { ...weights, new: 10 }), 'root', initial.state);
  for (const id of base.dir) assert.deepEqual(added.rects.get(id), initial.rects.get(id), `${id} moved after insertion`);
  // Removing one file leaves a hole; survivors keep their positions.
  const removed = layoutHierarchy(tree({ ...base, dir: base.dir.filter(id => id !== 'f3') }, weights), 'root', initial.state);
  assert.equal(removed.holes, 1);
  for (const id of base.dir.filter(item => item !== 'f3')) assert.deepEqual(removed.rects.get(id), initial.rects.get(id), `${id} moved after removal`);
  // A re-added file reclaims its old slot.
  const restored = layoutHierarchy(tree(base, weights), 'root', removed.state);
  assert.deepEqual(restored.rects.get('f3'), initial.rects.get('f3'));
  // Re-running with the produced state is idempotent.
  assert.deepEqual([...layoutHierarchy(tree(base, weights), 'root', initial.state).rects], [...initial.rects]);
});
test('holes are compacted once they dominate a container', () => {
  const base = { root: ['dir'], dir: ['a', 'b', 'c', 'd'] };
  const initial = layoutHierarchy(tree(base, { a: 50, b: 50, c: 50, d: 50 }), 'root');
  const result = layoutHierarchy(tree({ root: ['dir'], dir: ['d'] }, { d: 50 }), 'root', initial.state);
  assert.equal(result.holes, 0);
  assert.deepEqual(result.state.containers.dir!.map(slot => slot[0]), ['d']);
});
test('packing places large siblings side by side instead of wasting a column', () => {
  const packing = pack([{ w: 400, h: 500 }, { w: 400, h: 380 }, { w: 60, h: 60 }, { w: 40, h: 40 }], 4);
  const used = 400 * 500 + 400 * 380 + 60 * 60 + 40 * 40;
  assert.ok(packing.width * packing.height < used * 1.5, `packing too sparse: ${packing.width}x${packing.height}`);
});

// --- Projection -----------------------------------------------------------
test('routes and endpoints get a projection district without changing canonical containment', () => {
  const projection = new ProjectionService(store);
  const endpoint = entityId('POST /auth/login', 'api_endpoint');
  const located = projection.locate(endpoint);
  const backend = entityId('backend', 'application');
  assert.equal(located.node.canonicalParentId, backend, 'canonical parent stays the application');
  assert.equal(located.canonicalAncestors.at(-1)!.id, backend);
  // The backend has enough endpoints for its district to split by first path segment.
  const district = located.spatialAncestors.find(item => item.id === `projection:routes:${backend}`)!;
  assert.equal(district.kind, 'group');
  assert.equal(located.spatialAncestors.at(-1)!.id, `projection:routes:${backend}:/auth`);
  assert.ok(district.explanation?.includes('containment is unchanged'));
  assert.ok(!graph.entities.some(entity => entity.id === district.id), 'district is not an entity');
  assert.ok(projection.search('Routes', {}).items.every(item => item.kind === 'entity'), 'search only returns indexed entities');
  // Child rects lie within parents along the whole spatial chain.
  const chain = [...located.spatialAncestors, located.node];
  for (let i = 1; i < chain.length; i++) assert.ok(inside(chain[i]!.rect, chain[i - 1]!.rect));
});
test('large route districts split by first path segment', () => {
  const rows: EntityRow[] = [{ id: 'r', type: 'repository', name: 'r' }, { id: 'app', type: 'application', name: 'app', parentId: 'r' }];
  for (let i = 0; i <= ROUTE_SUBGROUP_THRESHOLD; i++) rows.push({ id: `e${i}`, type: 'api_endpoint', name: `GET /${i % 2 ? 'users' : 'auth'}/${i}`, routePath: `/${i % 2 ? 'users' : 'auth'}/${i}`, parentId: 'app' });
  const index = new ProjectionIndex('run', rows, [], []);
  assert.deepEqual(index.node('projection:routes:app')!.children, ['projection:routes:app:/auth', 'projection:routes:app:/users']);
  assert.equal(index.node('e1')!.canonicalParentId, 'app');
});
test('same graph produces identical coordinates across service instances; layout state is persisted', async () => {
  const a = new ProjectionService(store, { stateDirectory: state });
  const metaA = a.meta();
  assert.equal(metaA.layout.persisted, true);
  const persisted = JSON.parse(await readFile(path.join(state, 'layout.json'), 'utf8'));
  assert.equal(persisted.repositoryId, graph.run.repositoryId);
  const b = new ProjectionService(store, { stateDirectory: state });
  const c = new ProjectionService(store);
  for (const id of graph.entities.map(entity => entity.id)) {
    const rect = a.locate(id).node.rect;
    assert.deepEqual(b.locate(id).node.rect, rect);
    assert.deepEqual(c.locate(id).node.rect, rect);
  }
});
test('children pages respect limit/offset/hasMore and keep stable slot order', () => {
  const projection = new ProjectionService(store);
  const rootId = graph.run.repositoryId;
  const all = projection.children(rootId, { limit: 500 });
  const first = projection.children(rootId, { limit: 1 });
  const second = projection.children(rootId, { limit: 1, offset: 1 });
  assert.equal(first.hasMore, all.total > 1);
  assert.deepEqual([first.items[0]!.id, second.items[0]!.id], all.items.slice(0, 2).map(item => item.id));
  assert.throws(() => projection.children(rootId, { limit: 501 }), /limit/);
});
test('search reveals deeply nested symbols with ancestry, ranked by exact name and qualified name', () => {
  const projection = new ProjectionService(store);
  const result = projection.search('AuthController::login', {});
  const top = result.items[0]!;
  assert.equal(top.qualifiedName, 'App\\Http\\Controllers\\AuthController::login');
  assert.ok(top.breadcrumb.includes('AuthController.php'));
  const located = projection.locate(top.id);
  assert.deepEqual(located.canonicalAncestors.map(item => item.type), ['repository', 'application', 'directory', 'directory', 'directory', 'file', 'controller']);
  assert.equal(projection.search('LoginForm', { type: 'component' }).items[0]!.name, 'LoginForm');
  assert.ok(projection.search('loginform', {}).typeCounts.some(item => item.type === 'file'));
  const words = projection.search('LoginForm.tsx login', {}).items[0]!;
  assert.deepEqual([words.type, words.name, words.path], ['function', 'login', 'frontend/src/components/LoginForm.tsx']);
});
test('relations expose direction, type counts and endpoint ancestry; aggregates group by visible ancestor', () => {
  const projection = new ProjectionService(store);
  const endpoint = entityId('POST /auth/login', 'api_endpoint');
  const relations = projection.relations(endpoint, {});
  const handles = relations.items.find(item => item.type === 'handles')!;
  assert.equal(handles.direction, 'outgoing');
  assert.equal(handles.other.qualifiedName, 'App\\Http\\Controllers\\AuthController::login');
  assert.deepEqual(handles.otherAncestors, projection.locate(handles.other.id).spatialAncestors.map(node => node.id));
  const incoming = relations.items.find(item => item.type === 'requests')!;
  assert.equal(incoming.direction, 'incoming');
  assert.ok(!relations.items.some(item => item.type === 'contains'), 'containment is hierarchy, not a listed relationship');
  // Frontend application: the only crossing edges are real requests to the backend.
  const frontend = projection.aggregate(entityId('frontend', 'application'), {});
  const crossing = frontend.groups.filter(group => group.anchor.id === entityId('backend', 'application'));
  assert.ok(crossing.length > 0 && crossing.every(group => group.type === 'requests' && group.direction === 'outgoing'));
  const total = crossing.reduce((sum, group) => sum + group.count, 0);
  assert.equal(total, graph.relations.filter(edge => edge.type === 'requests' && graph.entities.find(e => e.id === edge.to)!.metadata.framework === 'laravel' && graph.entities.find(e => e.id === edge.from)!.path?.startsWith('frontend/')).length);
  const edges = projection.aggregateEdges(entityId('frontend', 'application'), { anchor: crossing[0]!.anchor.id, type: 'requests', direction: 'outgoing' });
  assert.equal(edges.total, crossing[0]!.count);
  assert.ok(edges.items.every(item => item.inside.path?.startsWith('frontend/')));
});
test('diagnostics are attached to entities and visible from containing areas', () => {
  const projection = new ProjectionService(store);
  const dynamic = entityId('dynamicUrl');
  // A relative template URL resolves to a pattern, but nothing proves it crosses to Laravel.
  const own = projection.diagnostics(dynamic, {});
  assert.ok(own.items.some(item => item.code === 'unverified-relative-api-boundary'), 'dynamicUrl finding');
  const frontend = projection.diagnostics(entityId('frontend', 'application'), { limit: 500 });
  assert.ok(frontend.items.some(item => item.entityId === dynamic), 'finding visible from the application');
  assert.ok(frontend.codes.some(code => code.code === 'unresolved-http-call'), 'unresolved-http-call code');
});
test('between() only reports relationships that exist', () => {
  const projection = new ProjectionService(store);
  const endpoint = entityId('POST /auth/login', 'api_endpoint');
  const handler = graph.entities.find(entity => entity.metadata.qualifiedName === 'App\\Http\\Controllers\\AuthController::login')!.id;
  assert.deepEqual(projection.between(endpoint, handler).items.map(item => item.type), ['handles']);
  assert.deepEqual(projection.between(handler, entityId('LoginForm', 'component')).items, []);
});

// --- Source ---------------------------------------------------------------
test('source resolves entity, relation evidence and diagnostic identities with focus ranges', async () => {
  const handler = graph.entities.find(entity => entity.metadata.qualifiedName === 'App\\Http\\Controllers\\AuthController::login')!;
  const symbol = await readIndexedSource(store, root, 1024 * 1024, { entity: handler.id });
  assert.equal(symbol.file.path, 'backend/app/Http/Controllers/AuthController.php');
  assert.deepEqual([symbol.focus!.startLine, symbol.focus!.endLine], [handler.sourceRange!.startLine, handler.sourceRange!.endLine]);
  assert.equal(symbol.changedSinceIndex, false);
  assert.ok(symbol.lines[handler.sourceRange!.startLine - symbol.start]!.includes('function login'));
  const handles = graph.relations.find(edge => edge.type === 'handles' && edge.to === handler.id && edge.from === entityId('POST /auth/login', 'api_endpoint'))!;
  const index = handles.evidence.findIndex(fact => fact.file === 'backend/routes/api.php' && fact.line === 6);
  assert.ok(index >= 0);
  const evidence = await readIndexedSource(store, root, 1024 * 1024, { relation: handles.id, evidence: index });
  assert.deepEqual([evidence.focus!.kind, evidence.focus!.startLine], ['evidence', 6]);
  assert.ok(evidence.lines[6 - evidence.start]!.includes("Route::post('login'"));
  const diagnostic = graph.diagnostics.find(item => item.code === 'unresolved-http-call' && item.file)!;
  const finding = await readIndexedSource(store, root, 1024 * 1024, { diagnostic: diagnostic.id });
  assert.equal(finding.file.path, diagnostic.file);
  assert.equal(finding.focus!.startLine, diagnostic.line);
});
test('source rejects paths, unindexed targets, directories, bad ranges, symlink swaps and reports changes', async () => {
  const read = (request: Parameters<typeof readIndexedSource>[3], base = root) => readIndexedSource(store, base, 1024 * 1024, request);
  const rejects = async (request: Parameters<typeof readIndexedSource>[3], status: number, base = root) => {
    await assert.rejects(read(request, base), (error: unknown) => error instanceof SourceError && error.status === status, JSON.stringify(request));
  };
  await rejects({}, 400);
  await rejects({ entity: '../../etc/passwd' }, 404);
  await rejects({ entity: entityId('frontend', 'application') }, 422);
  await rejects({ entity: entityId('LoginForm', 'component'), start: 5, end: 2 }, 400);
  await rejects({ entity: entityId('LoginForm', 'component'), start: 0, end: 2 }, 400);
  await rejects({ relation: graph.relations[0]!.id }, 400);
  const bounded = await read({ entity: entityId('LoginForm.tsx', 'file'), start: 1, end: 1_000_000 });
  assert.ok(bounded.end - bounded.start + 1 <= SOURCE_MAX_LINES);
  // Work on a private copy so the shared fixture stays pristine.
  const copy = await createFixture();
  const file = 'frontend/src/components/LoginForm.tsx';
  await writeFile(path.join(copy, file), `${await readFile(path.join(copy, file), 'utf8')}\n// edited after indexing\n`);
  const changed = await read({ entity: entityId('LoginForm.tsx', 'file') }, copy);
  assert.equal(changed.changedSinceIndex, true);
  assert.ok(changed.notices.some(notice => notice.includes('changed since it was indexed')));
  const outside = await mkdtemp(path.join(tmpdir(), 'atlas-outside-')); temporary.push(outside);
  await writeFile(path.join(outside, 'secret.ts'), 'export const secret = 1;');
  await unlink(path.join(copy, file));
  await symlink(path.join(outside, 'secret.ts'), path.join(copy, file));
  await rejects({ entity: entityId('LoginForm.tsx', 'file') }, 403, copy);
  await unlink(path.join(copy, file));
  await rejects({ entity: entityId('LoginForm.tsx', 'file') }, 410, copy);
});
test('HTTP API serves projection and source routes read-only, without exposing filesystem paths', async () => {
  const server = createInspectionServer(store, { root, stateDirectory: state });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const meta = await fetch(`${base}/api/projection`).then(response => response.json());
    assert.equal(meta.root.id, graph.run.repositoryId);
    assert.equal(meta.coverage.databaseTables, 3);
    const endpoint = entityId('POST /auth/login', 'api_endpoint');
    const source = await fetch(`${base}/api/source?entity=${encodeURIComponent(endpoint)}`).then(response => response.json());
    assert.equal(source.file.path, 'backend/routes/api.php');
    assert.equal((await fetch(`${base}/api/source?file=/etc/passwd`)).status, 400);
    assert.equal((await fetch(`${base}/api/source?entity=${encodeURIComponent('/etc/passwd')}`)).status, 404);
    assert.equal((await fetch(`${base}/api/projection/children/missing`)).status, 404);
    assert.equal((await fetch(`${base}/api/projection/search?q=`)).status, 400);
    assert.equal((await fetch(`${base}/api/projection`, { method: 'POST' })).status, 405);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
test('static UI serving stays inside the build directory', async () => {
  const ui = await mkdtemp(path.join(tmpdir(), 'atlas-ui-')); temporary.push(ui);
  await writeFile(path.join(ui, 'index.html'), '<!doctype html><title>ui</title>');
  const server = createInspectionServer(store, { uiDirectory: ui });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const index = await fetch(`${base}/`);
    assert.equal(index.status, 200);
    assert.match(index.headers.get('content-type') ?? '', /text\/html/);
    assert.equal((await fetch(`${base}/..%2f..%2fetc%2fpasswd`)).status, 404);
    assert.equal((await fetch(`${base}/%2e%2e/%2e%2e/etc/passwd`)).status, 404);
    assert.equal((await fetch(`${base}/api/summary`)).status, 200, 'API still answers when a UI is configured');
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

// --- Blast radius, steps and paths ---------------------------------------------
test('impact walks dependents across the stack, hop by hop, with the chain that reaches each', () => {
  const projection = new ProjectionService(store);
  const impact = projection.impact(symbolId('App\\Services\\AuthService::authenticate'), { depth: 8, limit: 100 });
  assert.equal(impact.origin.kind, 'entity');
  const distance = (name: string, type: string) => impact.distances[entityId(name, type)];
  assert.equal(impact.distances[symbolId('App\\Http\\Controllers\\AuthController::login')], 1);
  assert.equal(distance('POST /auth/login', 'api_endpoint'), 2, 'endpoint handled by the caller');
  assert.equal(distance('signIn', 'method'), 3, 'frontend method requesting the endpoint');
  assert.equal(distance('handleSave', 'function'), 4);
  assert.equal(distance('/account', 'route'), 6);
  const page = impact.items.items.find(item => item.name === '/account')!;
  assert.deepEqual(page.chain.map(hop => hop.type), ['calls', 'handles', 'requests', 'calls', 'renders', 'routes_to']);
  assert.equal(page.chain[0]!.to.id, symbolId('App\\Services\\AuthService::authenticate'));
  assert.equal(impact.byDistance.reduce((sum, count) => sum + count, 0), impact.total);
  assert.deepEqual(impact.highlights.applications.map(app => app.name).sort(), ['backend', 'frontend']);
  assert.equal(impact.areas[entityId('frontend', 'application')]!.distance, 3);
  assert.ok(impact.unknowns.unresolvedHttpCalls > 0, 'unresolved HTTP calls might also reach the endpoints');
  // Depth bounds the walk; items are ordered by distance and filterable.
  assert.ok(Object.values(projection.impact(symbolId('App\\Services\\AuthService::authenticate'), { depth: 2 }).distances).every(value => value <= 2));
  assert.ok(projection.impact(symbolId('App\\Services\\AuthService::authenticate'), { depth: 8, type: 'route' }).items.items.every(item => item.type === 'route'));
  assert.throws(() => projection.impact(entityId('signIn'), { depth: 11 }), /depth/);
  assert.equal(projection.impact(symbolId('App\\Services\\AuthService::authenticate'), { types: ['imports'] }).total, 0, 'relation types restrict the walk');
});
test('impact of a container seeds what it contains; name-only matches are reported as possible callers', () => {
  const projection = new ProjectionService(store);
  const service = projection.impact(symbolId('App\\Services\\AuthService'), {});
  assert.ok(service.seeds >= 2, 'the class and its methods');
  assert.ok(service.distances[symbolId('App\\Http\\Controllers\\ProfileController::show')] !== undefined, 'callers of a method of the class');
  const record = projection.impact(symbolId('App\\Services\\AuditLog::record'), {});
  assert.equal(record.total, 0);
  assert.deepEqual(record.unknowns.possibleCallers, [{ name: 'record', sites: 1, entities: 1 }]);
  // Symbols do not climb to their file's importers.
  const signIn = projection.impact(entityId('signIn'), { depth: 3 });
  assert.ok(!Object.keys(signIn.distances).some(id => graph.entities.find(entity => entity.id === id)!.type === 'file'));
});
test('steps draw what happens from a page: triggers, actions, endpoints, handlers and effects with conditions', async () => {
  const projection = new ProjectionService(store, { root });
  const steps = await projection.steps(entityId('/account', 'route'), { maxFileBytes: 1 << 20 });
  const step = (name: string) => steps.steps.find(item => item.node?.name === name)!;
  assert.equal(steps.steps[0]!.kind, 'anchor');
  assert.equal(step('handleSave').kind, 'trigger');
  assert.equal(step('signIn').kind, 'action');
  assert.equal(step('POST /auth/login').kind, 'endpoint');
  assert.equal(step('POST /auth/login').app, 'backend');
  assert.equal(steps.steps.find(item => item.kind === 'handler' && item.node?.qualifiedName === 'App\\Http\\Controllers\\ProfileController::show')!.app, 'backend');
  assert.ok(!steps.steps.some(item => item.node?.name === 'getInstance'), 'plumbing is folded, not a step');
  const link = (from: string, to: string) => steps.links.find(item => item.from === step(from).id && item.to === step(to).id)!;
  const save = steps.links.find(item => item.to === step('handleSave').id)!;
  assert.equal(save.event, 'onClick');
  assert.deepEqual(save.via.map(item => item.name), ['AccountPage', 'AccountPanel']);
  assert.deepEqual(link('handleSave', 'signIn').when.map(guard => guard.phrase), ['when email'], 'early return read from source');
  // Effects are steps, with the conditions at their own site.
  const effects = steps.steps.filter(item => item.kind === 'effect').map(item => `${item.effect!.category}:${item.effect!.operation}:${item.effect!.status ?? ''}:${item.effect!.when.map(guard => guard.phrase).join('&')}`);
  for (const expected of ['navigation:push::when email', 'storage:write::when response.ok', 'response:abort:404:when $id < 1', 'response:json:200:unless $id < 1', 'database:read::']) assert.ok(effects.includes(expected), expected);
  assert.ok(!steps.steps.some(item => item.effect?.category === 'network'), 'linked requests are endpoints, not network effects');
  // Every link endpoint is a step; every hop is an indexed relation.
  const ids = new Set(steps.steps.map(item => item.id));
  assert.ok(steps.links.every(item => ids.has(item.from) && ids.has(item.to)));
  assert.ok(steps.links.flatMap(item => item.hops).every(hop => graph.relations.some(relation => relation.id === hop.relationId)));
});
test('steps are not capped, and stop at navigation to another page', async () => {
  const projection = new ProjectionService(store, { root });
  const result = await projection.steps(entityId('GET /admin', 'api_endpoint'), { maxFileBytes: 1 << 20 });
  assert.ok(!('truncated' in result) && result.notices.every(notice => !/capped/.test(notice)));
  // A link to another page is a step of its own; that page's steps are another journey.
  const about = result.steps.find(step => step.node?.name === 'GET /about')!;
  assert.equal(about.navigation, true);
  assert.equal(result.links.filter(link => link.from === about.id).length, 0, 'not followed');
  assert.ok(!result.steps.some(step => step.node?.path?.endsWith('pages/about.tsx')), 'the other page is not drawn');
  // Folded entities say where they are, so a client can keep their areas lit.
  const account = await projection.steps(entityId('/account', 'route'), { maxFileBytes: 1 << 20 });
  const folded = account.links.flatMap(link => link.via);
  assert.ok(folded.some(item => item.name === 'AccountPanel') && folded.every(item => item.ancestors.length > 0));
  // What a step leads to: closest first (fewest folded hops), then by file and line.
  const byId = new Map(result.steps.map(step => [step.id, step]));
  for (const parent of result.steps) {
    const keys = result.links.filter(link => link.from === parent.id).map(link => {
      const step = byId.get(link.to)!;
      const path = step.effect ? step.effect.ownerPath ?? '' : step.node?.path ?? '', line = step.effect ? step.effect.line : step.node?.sourceRange?.startLine ?? 0;
      return [link.via.length, path, line] as const;
    });
    const sorted = [...keys].sort((x, y) => x[0] - y[0] || (x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0) || x[2] - y[2]);
    assert.deepEqual(keys, sorted, `order of what ${parent.node?.name ?? parent.id} leads to`);
  }
});
test('tables sit in a Database district; their blast radius reaches code, endpoints, pages and dependent tables', () => {
  const projection = new ProjectionService(store);
  const users = entityId('users', 'database_table'), backend = entityId('backend', 'application');
  const located = projection.locate(users);
  assert.equal(located.node.canonicalParentId, backend, 'canonical parent stays the application');
  const district = located.spatialAncestors.at(-1)!;
  assert.deepEqual([district.id, district.kind, district.name], [`projection:database:${backend}`, 'group', 'Database']);
  assert.match(district.explanation!, /declared by the migrations/);
  assert.ok(inside(located.node.rect, district.rect));
  const impact = projection.impact(users, { depth: 8, limit: 200 });
  const distance = (id: string) => impact.distances[id];
  assert.equal(distance(symbolId('App\\Services\\AuthService::authenticate')), 1, 'reads users');
  assert.equal(distance(symbolId('App\\Models\\User')), 1, 'maps to users');
  assert.equal(distance(entityId('profiles', 'database_table')), 1, 'foreign key to users');
  assert.equal(distance(symbolId('App\\Services\\AuthService::profileOf')), 2, 'reads profiles, which references users');
  assert.equal(distance(entityId('POST /auth/login', 'api_endpoint')), 3);
  assert.ok(distance(entityId('/account', 'route'))! > 3, 'reaches the frontend page');
  const page = impact.items.items.find(item => item.name === '/account')!;
  assert.equal(page.chain[0]!.type, 'reads');
});
test('conditions are read from source: if/else, ternaries, &&, early exits, switch and catch', () => {
  const ts = `function f(a: number, user?: { ok: boolean }) {
  if (!user) return;
  if (a > 1) {
    save();
  } else {
    a > 5 ? one() : two();
  }
  user.ok && three();
  switch (a) { case 2: four(); break; default: five(); }
  try { six(); } catch (e) { seven(); }
}`;
  const at = (line: number) => guardsAt(`ts-${line}`, 'f.ts', 'typescript', ts, line, { startLine: 1, endLine: 11 }).map(phrase);
  assert.deepEqual(at(4), ['when user', 'when a > 1']);
  assert.deepEqual(at(6), ['when user', 'unless a > 1', 'unless a > 5']);
  assert.deepEqual(at(8), ['when user', 'when user.ok']);
  assert.deepEqual(at(9).slice(-1), ['when a matches no case']);
  assert.deepEqual(at(10).slice(-1), ['when an error was thrown']);
  const php = `<?php
class C {
  public function show($id) {
    if ($id < 1) {
      abort(404);
    }
    return $ok ? response()->json([], 200) : null;
  }
}`;
  assert.deepEqual(guardsAt('php-5', 'c.php', 'php', php, 5, { startLine: 3, endLine: 8 }).map(phrase), ['when $id < 1']);
  // Several branches on one line: the hint names the call the site is about.
  assert.deepEqual(guardsAt('php-7', 'c.php', 'php', php, 7, { startLine: 3, endLine: 8 }, 'response').map(phrase), ['unless $id < 1', 'when $ok']);
  assert.deepEqual(guardsAt('ts-6h', 'f.ts', 'typescript', ts, 6, { startLine: 1, endLine: 11 }, 'one').map(phrase), ['when user', 'unless a > 1', 'when a > 5']);
  assert.equal(hintOf('localStorage.setItem(\'session\')'), 'setItem');
  assert.equal(hintOf('$user->update($data)'), 'update');
  assert.equal(hintOf('abort(404);'), 'abort');
  assert.deepEqual(guardsAt('bad', 'x.ts', 'typescript', 'export const = (', 1), []);
});
// --- Request flows ----------------------------------------------------------------
test('a request flow follows one request from the page to the tables and back to the client', async () => {
  const projection = new ProjectionService(store, { root });
  const flow = await projection.requestFlow(entityId('POST /auth/login', 'api_endpoint'), { maxFileBytes: 1 << 20 });
  assert.deepEqual(flow.lanes, ['client', 'call', 'route', 'gate', 'controller', 'service', 'data', 'response', 'return']);
  const node = (kind: string, label: string) => { const found = flow.nodes.find(item => item.kind === kind && item.label === label); assert.ok(found, `Expected ${kind} ${label}`); return found; };
  const edge = (from: { id: string }, to: { id: string }) => { const found = flow.edges.find(item => item.from === from.id && item.to === to.id); assert.ok(found, `Expected ${from.id} → ${to.id}`); return found; };
  const page = node('page', '/account'), trigger = node('trigger', 'handleSave'), caller = node('caller', 'AccountService.signIn');
  const endpoint = node('endpoint', 'POST /auth/login'), middleware = node('middleware', 'api'), handler = node('handler', 'AuthController::login');
  const service = node('method', 'AuthService::authenticate'), model = node('model', 'User'), table = node('table', 'users');
  // Client: the page, the event binding (plumbing folded), the call.
  const binding = edge(page, trigger);
  assert.equal(binding.label, 'onClick · AccountPanel');
  assert.deepEqual(binding.via.map(item => item.name), ['AccountPage', 'AccountPanel']);
  edge(trigger, caller);
  assert.equal(edge(caller, endpoint).kind, 'requests');
  // Server: middleware, the controller, a service, the model and its table, the response.
  edge(endpoint, middleware); edge(middleware, handler); edge(handler, service);
  assert.equal(edge(service, model).kind, 'reads');
  edge(model, table);
  assert.equal(service.lane, 'service'); assert.equal(model.lane, 'data');
  const ok = node('response', '200 return');
  edge(handler, ok);
  // Back on the client, in source order after the request, with the conditions read from source.
  const receiver = flow.nodes.find(item => item.kind === 'receive' && item.node?.id === caller.node!.id)!;
  edge(ok, receiver);
  const stored = edge(receiver, node('continuation', 'storage · write'));
  assert.deepEqual(stored.when.map(guard => guard.phrase), ['when response.ok']);
  const navigated = edge(receiver, node('continuation', 'navigation · push'));
  assert.equal(navigated.label, 'in handleSave');
  // A caller nothing indexed calls is a gap, not a silent omission; the flow is then partial.
  const orphan = flow.nodes.find(item => item.gap?.reason === 'no-trigger')!;
  assert.match(orphan.gap!.text, /signInJson/);
  assert.equal(flow.status, 'partial');
  assert.deepEqual(flow.stages, { client: true, call: true, handler: true, data: true, response: true, returns: true });
  // Every link is made of indexed relationships, and every link joins drawn nodes.
  const ids = new Set(flow.nodes.map(item => item.id));
  assert.ok(flow.edges.every(item => ids.has(item.from) && ids.has(item.to)));
  assert.ok(flow.edges.flatMap(item => item.hops).every(hop => graph.relations.some(relation => relation.id === hop.relationId)));
});
test('request flows draw validation, guarded responses, and what the index could not resolve as gaps', async () => {
  const projection = new ProjectionService(store, { root });
  const update = await projection.requestFlow(entityId('PUT /profiles/{id}', 'api_endpoint'), { maxFileBytes: 1 << 20 });
  const find = (flow: typeof update, test: (item: typeof update.nodes[number]) => boolean) => flow.nodes.find(test)!;
  const validation = find(update, item => item.kind === 'validation');
  assert.equal(validation.label, 'UpdateProfileRequest');
  assert.equal(validation.lane, 'gate');
  const invalid = find(update, item => item.status === 422);
  assert.equal(update.edges.find(item => item.from === validation.id && item.to === invalid.id)!.label, 'when invalid');
  assert.deepEqual(update.responses, [302, 404, 422]);
  assert.ok(find(update, item => item.kind === 'table' && item.label === 'audit'));
  const helper = find(update, item => item.label === 'ProfileController::audit');
  assert.deepEqual([helper.lane, helper.depth], ['controller', 1], 'a helper of the controller stays in its lane, one column deeper');
  const unresolved = find(update, item => item.gap?.reason === 'unresolved-calls');
  assert.equal(unresolved.label, '? record()');
  assert.ok(update.edges.some(item => item.from === helper.id && item.to === unresolved.id && item.kind === 'gap'));
  const show = await projection.requestFlow(entityId('GET /profiles/{id}', 'api_endpoint'), { maxFileBytes: 1 << 20 });
  const respond = (status: number) => show.edges.find(item => item.to === find(show, node => node.status === status).id)!;
  assert.deepEqual(respond(404).when.map(guard => guard.phrase), ['when $id < 1']);
  assert.deepEqual(respond(200).when.map(guard => guard.phrase), ['unless $id < 1']);
  // A closure route: the handler is a gap, and nothing indexed calls it.
  const home = await projection.requestFlow(graph.entities.find(entity => entity.type === 'api_endpoint' && entity.name === 'GET /')!.id, { maxFileBytes: 1 << 20 });
  assert.equal(home.status, 'headless');
  assert.deepEqual(home.nodes.flatMap(item => item.gap ? [item.gap.reason] : []).sort(), ['no-caller', 'no-handler']);
});
test('request flows are listed per endpoint with their completeness, unmatched requests apart, and by entity', async () => {
  const projection = new ProjectionService(store, { root });
  const list = projection.requestFlows();
  const names = list.items.map(item => item.name);
  assert.ok(names.includes('GET /users/{id}') && !names.includes('HEAD /users/{id}'), 'a HEAD route that mirrors a GET route is listed once');
  assert.equal(Object.values(list.counts).reduce((sum, count) => sum + count, 0), list.items.length);
  const login = list.items.find(item => item.name === 'POST /auth/login')!;
  assert.deepEqual([login.app, login.group, login.handler, login.callers, login.responses], ['backend', '/auth', 'AuthController::login', 3, [200]]);
  const kinds = list.items.map(item => item.kind);
  assert.ok(kinds.indexOf('unmatched') > kinds.lastIndexOf('endpoint'), 'unmatched requests come last');
  const missing = list.items.find(item => item.kind === 'unmatched' && item.caller === 'AccountService.missing')!;
  assert.equal(missing.status, 'unmatched');
  const flow = await projection.requestFlow(missing.id, { maxFileBytes: 1 << 20 });
  assert.match(flow.nodes.find(item => item.gap?.reason === 'unmatched')!.gap!.text, /0 eligible endpoints/);
  // Flows that draw an entity.
  const through = projection.requestFlows({ entity: symbolId('App\\Services\\AuthService::authenticate') });
  assert.deepEqual(through.items.map(item => item.name).sort(), ['GET /duplicate', 'GET /profiles/{id}', 'POST /auth/login', 'POST /session/login']);
  await assert.rejects(projection.requestFlow(symbolId('App\\Services\\AuthService::authenticate'), { maxFileBytes: 1 << 20 }), /No request flow starts/);
});
test('impact, steps, flows and coverage are served over HTTP with validation', async () => {
  const server = createInspectionServer(store, { root });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const impact = await fetch(`${base}/api/projection/impact/${encodeURIComponent(symbolId('App\\Services\\AuthService::authenticate'))}?depth=6&limit=5`).then(response => response.json());
    assert.equal(impact.items.items.length, 5);
    assert.ok(impact.total > 5 && impact.items.hasMore);
    assert.equal((await fetch(`${base}/api/projection/impact/${encodeURIComponent(entityId('signIn'))}?types=bogus`)).status, 400);
    const steps = await fetch(`${base}/api/projection/steps/${encodeURIComponent(entityId('/account', 'route'))}`).then(response => response.json());
    assert.ok(steps.steps.length > 5 && steps.links.length > 5);
    const catalog = await fetch(`${base}/api/projection/flows?kind=command`).then(response => response.json());
    assert.ok(catalog.items.length > 0 && catalog.items.every((item: { kind: string }) => item.kind === 'command'));
    assert.equal((await fetch(`${base}/api/projection/flows?kind=bogus`)).status, 400);
    const coverage = await fetch(`${base}/api/projection/coverage`).then(response => response.json());
    assert.ok(coverage.codeFiles > 0 && Object.keys(coverage.files).length > 0);
    assert.equal((await fetch(`${base}/api/projection/path?from=x&to=y`)).status, 404, 'path finding is gone');
    assert.equal((await fetch(`${base}/api/projection/steps/missing`)).status, 404);
    const flows = await fetch(`${base}/api/projection/request-flows`).then(response => response.json());
    assert.ok(flows.items.length > 5 && flows.counts.partial > 0);
    const flow = await fetch(`${base}/api/projection/request-flows/${encodeURIComponent(entityId('POST /auth/login'))}`).then(response => response.json());
    assert.ok(flow.nodes.length > 10 && flow.edges.length > 10);
    assert.equal((await fetch(`${base}/api/projection/request-flows/missing`)).status, 404);
    assert.equal((await fetch(`${base}/api/projection/request-flows?entity=missing`)).status, 404);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

// --- Flow catalog and coverage ------------------------------------------------------
test('the flow catalog lists every entry point with the entities it touches', () => {
  const projection = new ProjectionService(store, { root });
  const list = projection.flows();
  const byEntry = (name: string, type: string) => { const found = list.items.find(item => item.entry.name === name && item.entry.type === type); assert.ok(found, `Expected a flow from ${type} ${name}`); return found; };
  // Pages: Next.js routes (drawn as Steps), and endpoints serving an Inertia page (drawn as lanes).
  const account = byEntry('/account', 'route');
  assert.deepEqual([account.kind, account.detail], ['page', 'steps']);
  const admin = byEntry('GET /admin', 'api_endpoint');
  assert.deepEqual([admin.kind, admin.detail], ['page', 'lanes']);
  assert.equal(byEntry('POST /auth/login', 'api_endpoint').kind, 'request');
  assert.equal(byEntry('reports:send', 'command').kind, 'command');
  const schedule = byEntry('reports:send --daily', 'scheduled_task');
  assert.deepEqual([schedule.kind, schedule.cadence, schedule.group], ['schedule', 'daily at 02:00', 'scheduler']);
  assert.equal(list.counts.page, list.items.filter(item => item.kind === 'page').length);
  assert.ok(list.items.every(item => item.entities >= 1 && item.files >= 0));
  // A page journey reaches what the page sets in motion, down to the tables, but not the pages it links to.
  const through = (entity: string) => projection.flows({ entity }).items.map(item => item.id);
  assert.ok(through(entityId('users', 'database_table')).includes(account.id));
  assert.ok(!through(entityId('About', 'component')).includes(admin.id), 'navigating to /about is another journey');
  assert.ok(through(entityId('About', 'component')).includes(byEntry('GET /about', 'api_endpoint').id));
  // A command run by the scheduler, and by a controller: its flow shows both, and the scheduled task's flow reaches the command's tables.
  assert.ok(through(entityId('reports:prune', 'command')).includes(schedule.id), 'the daily report runs reports:prune by name');
  const flow = projection.flows({ kind: 'command' });
  assert.ok(flow.items.every(item => item.kind === 'command'));
  assert.equal(flow.counts.schedule, list.counts.schedule);
  assert.throws(() => projection.flows({ kind: 'nope' }), /kind must be/);
});
test('a command flow shows what runs it, and a scheduled task what it runs', async () => {
  const projection = new ProjectionService(store, { root });
  const send = await projection.requestFlow(entityId('reports:send', 'command'), { maxFileBytes: 1 << 20 });
  assert.equal(send.kind, 'command');
  assert.ok(send.nodes.some(item => item.kind === 'schedule' && item.label === 'daily at 02:00'));
  assert.ok(send.nodes.some(item => item.kind === 'caller' && item.label === 'AdminController::rebuild'));
  assert.ok(send.nodes.some(item => item.kind === 'handler' && item.label === 'SendReports::handle'));
  assert.ok(send.edges.some(item => item.kind === 'invokes'));
  const prune = await projection.requestFlow(entityId('reports:prune', 'command'), { maxFileBytes: 1 << 20 });
  assert.ok(prune.nodes.some(item => item.kind === 'caller' && item.label === 'SendReports::handle'));
  const inspire = await projection.requestFlow(entityId('inspire', 'command'), { maxFileBytes: 1 << 20 });
  assert.ok(inspire.nodes.some(item => item.kind === 'entry' && item.label === 'php artisan inspire'), 'a command nothing runs is run by hand');
  assert.ok(inspire.nodes.some(item => item.gap?.reason === 'no-handler'), 'a closure command is a gap');
  const job = await projection.requestFlow(entityId('RebuildIndex', 'scheduled_task'), { maxFileBytes: 1 << 20 });
  assert.ok(job.nodes.some(item => item.kind === 'handler' && item.label === 'RebuildIndex::handle'));
  assert.ok(job.nodes.some(item => item.kind === 'table' && item.label === 'users'));
  // The page an Inertia response renders is drawn back on the client.
  const admin = await projection.requestFlow(entityId('GET /admin', 'api_endpoint'), { maxFileBytes: 1 << 20 });
  const page = admin.nodes.find(item => item.kind === 'page' && item.lane === 'return')!;
  assert.equal(page.label, 'Dashboard');
  assert.ok(admin.edges.some(item => item.kind === 'renders' && item.to === page.id));
  // A visit made by an Inertia page enters through the endpoint serving it.
  const rebuild = await projection.requestFlow(entityId('POST /admin/rebuild', 'api_endpoint'), { maxFileBytes: 1 << 20 });
  assert.ok(rebuild.nodes.some(item => item.kind === 'page' && item.lane === 'client' && item.label === 'GET /admin'));
});
test('coverage classifies every file by the flows touching it, and says why', () => {
  const projection = new ProjectionService(store, { root });
  const coverage = projection.coverage();
  const fileId = (path: string) => { const found = graph.entities.find(item => item.type === 'file' && item.path === path); assert.ok(found, `Expected file ${path}`); return found.id; };
  const category = (path: string) => coverage.files[fileId(path)]!.category;
  assert.equal(category('backend/app/Services/AuthService.php'), 'flow');
  assert.ok(coverage.files[fileId('backend/app/Services/AuthService.php')]!.flows >= 1);
  assert.equal(category('backend/app/Console/Commands/SendReports.php'), 'entry');
  assert.equal(category('backend/routes/console.php'), 'entry');
  assert.equal(category('backend/bootstrap/app.php'), 'config');
  assert.equal(category('frontend/src/components/LoginForm.module.scss'), 'asset');
  // Imported by code in flows without being in one itself: supporting.
  assert.equal(category('backend/app/Http/Controllers/Controller.php'), 'supporting');
  const detail = projection.coverageOf(fileId('backend/app/Http/Controllers/Controller.php'));
  assert.match(detail.reason!, /imported or extended by/);
  // Areas roll up their code files; the repository holds them all.
  const rootId = graph.entities.find(item => item.type === 'repository')!.id;
  const total = Object.values(coverage.areas[rootId]!).reduce((sum, count) => sum + count, 0);
  assert.equal(total, Object.keys(coverage.files).length);
  assert.equal(coverage.codeFiles, Object.values(coverage.files).filter(item => item.category !== 'asset').length);
  // Coverage of an area lists the flows through anything inside it.
  const services = projection.coverageOf(graph.entities.find(item => item.type === 'directory' && item.path === 'backend/app/Services')!.id);
  assert.ok(services.totalFlows >= 1 && services.counts!.flow >= 1);
});
test('a file lists its symbols\' relationships across its boundary, with the symbol inside', () => {
  const projection = new ProjectionService(store, { root });
  const file = graph.entities.find(item => item.type === 'file' && item.path === 'backend/app/Console/Commands/PruneReports.php')!;
  assert.equal(projection.relations(file.id, {}).total, 0, 'a PHP file has no relationships of its own');
  const contained = projection.relations(file.id, { scope: 'contained' });
  const write = contained.items.find(item => item.type === 'writes')!;
  assert.equal(write.other.name, 'audit');
  assert.equal(write.inside?.name, 'handle');
  assert.ok(contained.items.some(item => item.type === 'handles' && item.direction === 'incoming' && item.other.name === 'reports:prune' && item.inside?.name === 'handle'));
  assert.ok(!contained.items.some(item => item.other.id === file.id || item.type === 'contains'));
  assert.throws(() => projection.relations(file.id, { scope: 'everything' }), /scope must be contained/);
});
