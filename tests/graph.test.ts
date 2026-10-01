import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stringify } from 'yaml';
import { indexRepository } from '../src/pipeline/index.js';
import { GraphStore } from '../src/storage/sqlite.js';
import { createInspectionServer } from '../src/api/server.js';
import { loadConfig, matchesGlob } from '../src/core/config.js';
import { validateGraph, type SoftwareGraph, type Entity } from '../src/core/graph.js';
import { nextRoute } from '../src/analyzers/typescript.js';

const execute = promisify(execFile);
const fixture = fileURLToPath(new URL('./fixtures/repository', import.meta.url));
const temporary: string[] = [];
let root: string, graph: SoftwareGraph;
async function createFixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'atlas-fixture-')); temporary.push(root);
  await cp(fixture, root, { recursive: true });
  await mkdir(path.join(root, '.archipelago'));
  await writeFile(path.join(root, '.archipelago/config.yml'), stringify({ repository: { name: 'fixture' }, applications: [{ name: 'frontend', path: 'frontend', type: 'nextjs' }, { name: 'backend', path: 'backend', type: 'laravel', apiOrigins: ['https://api.fixture.test'] }], ignore: ['**/custom-ignored/**'] }));
  return root;
}
function entity(name: string, type?: string): Entity {
  const found = graph.entities.find(entity => entity.name === name && (!type || entity.type === type));
  assert.ok(found, `Expected ${type ?? 'entity'} ${name}`); return found;
}
before(async () => { root = await createFixture(); graph = await indexRepository(root); });
after(async () => { for (const folder of temporary) await rm(folder, { recursive: true, force: true }); });

test('indexes an evidenced frontend HTTP → Laravel endpoint → controller method chain', () => {
  const caller = entity('login', 'function');
  const endpoint = entity('POST /auth/login', 'api_endpoint');
  const handler = graph.entities.find(entity => entity.metadata.qualifiedName === 'App\\Http\\Controllers\\AuthController::login')!;
  assert.ok(handler);
  const request = graph.relations.find(edge => edge.from === caller.id && edge.to === endpoint.id && edge.type === 'requests');
  assert.ok(request);
  assert.equal(request.evidence[0]!.file, 'frontend/src/components/LoginForm.tsx');
  assert.equal(request.evidence[0]!.line, 2);
  assert.equal(request.evidence[0]!.source, 'typescript');
  const handles = graph.relations.find(edge => edge.from === endpoint.id && edge.to === handler.id && edge.type === 'handles');
  assert.ok(handles);
  assert.ok(handles.evidence.some(fact => fact.file === 'backend/bootstrap/app.php'));
  assert.ok(handles.evidence.some(fact => fact.file === 'backend/routes/api.php' && fact.line === 6));
  assert.ok(handles.evidence.some(fact => fact.source === 'php'));
  assert.equal(endpoint.metadata.routeName, 'auth.login');
  assert.deepEqual(endpoint.metadata.middleware, ['api']);
  assert.equal(handler.metadata.signature, '(string)');
  assert.ok(graph.entities.every(item => item.evidence.length));
  assert.ok(graph.relations.every(item => item.evidence.length));
});
test('extracts Next pages, route groups, dynamic routes, local imports, exports and JSX components', () => {
  entity('/users/:id', 'route'); entity('/login', 'route'); entity('LoginForm', 'component'); entity('UserPage', 'component');
  const page = graph.entities.find(item => item.type === 'file' && item.path === 'frontend/src/app/login/page.tsx')!;
  const form = graph.entities.find(item => item.type === 'file' && item.path === 'frontend/src/components/LoginForm.tsx')!;
  assert.ok(graph.relations.some(edge => edge.from === page.id && edge.to === form.id && edge.type === 'imports'));
  const stylesheet = graph.entities.find(item => item.path === 'frontend/src/components/LoginForm.module.scss')!;
  assert.ok(graph.relations.some(edge => edge.from === page.id && edge.to === stylesheet.id && edge.type === 'imports' && edge.evidence.some(fact => fact.source === 'filesystem')));
  assert.ok(graph.relations.some(edge => edge.type === 'routes_to' && edge.to === entity('LoginPage', 'component').id));
  assert.ok(graph.relations.some(edge => edge.type === 'handles' && edge.from === entity('GET /api/ping', 'api_endpoint').id));
  assert.ok(graph.relations.some(edge => edge.type === 'requests' && edge.from === entity('ping', 'function').id));
  assert.equal(entity('useAuth').metadata.role, 'hook');
  const barrel = graph.entities.find(item => item.path === 'frontend/src/components/index.ts')!;
  assert.ok(graph.relations.some(edge => edge.from === barrel.id && edge.to === form.id && edge.type === 'exports'));
  assert.ok(!graph.diagnostics.some(item => item.severity === 'error'), JSON.stringify(graph.diagnostics));
});
test('resolves nested Laravel groups, included routes, controller groups and GET/HEAD methods', () => {
  entity('GET /settings/user', 'api_endpoint'); entity('HEAD /settings/user', 'api_endpoint'); entity('POST /session/login', 'api_endpoint');
  assert.ok(graph.relations.some(edge => edge.type === 'extends' && edge.from === entity('AuthController').id && edge.to === entity('Controller').id));
  assert.ok(!graph.entities.some(entity => entity.name.includes('invented') || entity.name.includes('conditional')));
  assert.ok(graph.diagnostics.some(item => item.code === 'dynamic-route-prefix'));
  assert.ok(graph.diagnostics.some(item => item.code === 'conditional-route-registration'));
  assert.ok(graph.diagnostics.some(item => item.code === 'unsupported-route-registration'));
});
test('HTTP matching rejects dynamic URLs, options, shadowed calls, foreign origins, ambiguity and constraints', () => {
  assert.ok(graph.relations.some(edge => edge.type === 'requests' && edge.from === entity('getUser').id && edge.to === entity('GET /users/{id}').id));
  for (const name of ['dynamicUrl', 'dynamicOptions', 'constrained', 'ambiguous', 'external', 'relativeBackend', 'localFetch', 'spreadOptions', 'shadowedAxios', 'destructuredFetch']) assert.ok(!graph.relations.some(edge => edge.type === 'requests' && edge.from === entity(name).id), name);
  for (const code of ['unresolved-http-call', 'ambiguous-http-match', 'constrained-http-match', 'unmatched-http-call', 'unverified-relative-api-boundary']) assert.ok(graph.diagnostics.some(item => item.code === code), code);
});
test('stable entity and relation identities survive repeated indexing and checkout relocation', async () => {
  const repeated = await indexRepository(root);
  const otherRoot = await createFixture();
  const relocated = await indexRepository(otherRoot);
  assert.deepEqual(repeated.entities, graph.entities);
  assert.deepEqual(repeated.relations, graph.relations);
  assert.deepEqual(relocated.entities, graph.entities);
  assert.deepEqual(relocated.relations, graph.relations);
});
test('scanner prunes dependencies/custom ignores/secrets, records LOC, skips binary/oversized content', async () => {
  const root = await createFixture();
  for (const directory of ['frontend/node_modules/x', 'backend/vendor/x', 'backend/storage', 'frontend/custom-ignored']) { await mkdir(path.join(root, directory), { recursive: true }); await writeFile(path.join(root, directory, 'ignored.ts'), 'export const ignored = 1;'); }
  await writeFile(path.join(root, '.env'), 'SECRET=do-not-index');
  await writeFile(path.join(root, 'frontend/src/binary.ts'), Buffer.from([0, 1, 2]));
  await writeFile(path.join(root, 'frontend/src/oversized.ts'), ' '.repeat(1024 * 1024 + 1));
  const graph = await indexRepository(root);
  assert.ok(!graph.entities.some(item => item.name === 'ignored.ts' || item.name === '.env'));
  assert.equal(graph.entities.find(item => item.path === 'frontend/src/components/LoginForm.tsx' && item.type === 'file')!.metrics!.loc, 6);
  assert.equal(graph.entities.find(item => item.name === 'binary.ts')!.metadata.analysisSkipped, 'Binary content');
  assert.ok(graph.diagnostics.filter(item => item.code === 'file-content-skipped').length === 2);
});
test('parse failures remain explicit and do not emit partial fabricated routes or symbols', async () => {
  const root = await createFixture();
  await writeFile(path.join(root, 'frontend/src/broken.ts'), 'export function broken( {');
  await writeFile(path.join(root, 'backend/routes/api.php'), '<?php Route::post(');
  const graph = await indexRepository(root);
  assert.ok(graph.diagnostics.some(item => item.code === 'typescript-parse-error' && item.severity === 'error'));
  assert.ok(graph.diagnostics.some(item => item.code === 'php-parse-error' && item.severity === 'error'));
  assert.ok(!graph.entities.some(item => item.name === 'POST /auth/login'));
  assert.ok(!graph.entities.some(item => item.name === 'broken'));
});
test('SQLite stores normalized evidence, metrics, run headers and bounds lists', () => {
  const store = new GraphStore(':memory:');
  try {
    store.save(graph);
    assert.deepEqual(store.currentRun(), graph.run);
    assert.deepEqual(store.entity(entity('LoginForm', 'component').id), entity('LoginForm', 'component'));
    const request = graph.relations.find(edge => edge.type === 'requests')!;
    assert.deepEqual(store.relation(request.id), request);
    assert.equal(store.entities({ limit: 2 }).items.length, 2);
    assert.equal(store.entities({ limit: 2 }).hasMore, true);
    assert.ok(store.entities({ search: '/auth/login' }).items.length > 0);
    assert.ok(store.entities({ parentId: entity('AuthController').id }).items.every(item => item.type === 'method'));
    assert.throws(() => store.entities({ limit: 501 }), /limit/);
    assert.throws(() => store.entities({ search: 'a'.repeat(201) }), /search/);
    assert.equal(store.entities({ search: "%' OR 1=1" }).items.length, 0);
  } finally { store.close(); }
});
test('SQLite replacement rolls back on an actual write failure and rejects invalid graphs', () => {
  const store = new GraphStore(':memory:');
  try {
    store.save(graph);
    const before = store.summary();
    assert.throws(() => store.save(graph), /UNIQUE/); // duplicate run header fails after clearing current graph
    assert.deepEqual(store.summary(), before);
    const invalid = structuredClone(graph); invalid.relations[0]!.to = 'missing';
    assert.throws(() => store.save(invalid), /Dangling/);
    assert.deepEqual(store.summary(), before);
  } finally { store.close(); }
});
test('validation rejects containment cycles and missing evidence', () => {
  const invalid = structuredClone(graph);
  invalid.entities[0]!.parentId = invalid.entities[0]!.id;
  assert.throws(() => validateGraph(invalid), /cycle/);
  const missing = structuredClone(graph); missing.relations[0]!.evidence = [];
  assert.throws(() => validateGraph(missing), /evidence/);
});
test('API serves bounded search, hierarchy, dependencies and evidence; rejects mutations', async () => {
  const store = new GraphStore(':memory:'); store.save(graph);
  const server = createInspectionServer(store);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const search = await fetch(`${base}/api/entities?search=LoginForm&limit=1`).then(response => response.json());
    assert.equal(search.items.length, 1);
    const id = entity('AuthController').id;
    const children = await fetch(`${base}/api/entities/${id}/children`).then(response => response.json());
    assert.equal(children.items.length, 2);
    const relation = graph.relations.find(edge => edge.type === 'requests')!;
    const details = await fetch(`${base}/api/relations/${relation.id}`).then(response => response.json());
    assert.ok(details.evidence.length > 1);
    assert.equal((await fetch(`${base}/api/entities?limit=999`)).status, 400);
    assert.equal((await fetch(`${base}/api/entities/missing`)).status, 404);
    assert.equal((await fetch(`${base}/api`, { method: 'POST' })).status, 405);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); store.close(); }
});
test('configuration autodetects apps and rejects escaping/overlapping paths', async () => {
  const state = await mkdtemp(path.join(tmpdir(), 'atlas-state-')); temporary.push(state);
  const config = await loadConfig(root, state);
  assert.deepEqual(config.applications.map(item => item.type).sort(), ['laravel', 'nextjs']);
  await writeFile(path.join(state, 'config.yml'), stringify({ applications: [{ name: 'escape', path: '../', type: 'nextjs' }] }));
  await assert.rejects(loadConfig(root, state), /outside repository/);
  await writeFile(path.join(state, 'config.yml'), stringify({ applications: [{ name: 'one', path: 'frontend', type: 'nextjs' }, { name: 'two', path: 'frontend/src', type: 'nextjs' }] }));
  await assert.rejects(loadConfig(root, state), /Overlapping/);
  await writeFile(path.join(state, 'config.yml'), 'ignore: not-a-list');
  await assert.rejects(loadConfig(root, state), /ignore must be a list/);
});
test('route translation and ignore globs support root/nested paths and catch-all scopes', () => {
  assert.equal(nextRoute('src/app/(site)/users/[id]/page.tsx')!.path, '/users/:id');
  assert.equal(nextRoute('app/@modal/[[...slug]]/page.tsx')!.path, '/:slug*');
  assert.equal(nextRoute('app/[...slug]/page.tsx')!.path, '/:slug+');
  assert.ok(nextRoute('app/(.)login/page.tsx')!.unsupported);
  assert.ok(matchesGlob('node_modules', '**/node_modules/**'));
  assert.ok(matchesGlob('frontend/node_modules/a/file.ts', '**/node_modules/**'));
  assert.ok(!matchesGlob('frontend/src/vendor-name.ts', '**/vendor/**'));
});
test('CLI persists parse diagnostics and exits with analyzer error status', async () => {
  const root = await createFixture();
  await writeFile(path.join(root, 'frontend/src/broken.ts'), 'const broken = (');
  const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  await assert.rejects(execute(process.execPath, ['--experimental-sqlite', '--import', 'tsx', cli, 'index', '--repo', root]), (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && error.code === 2);
  const store = new GraphStore(path.join(root, '.archipelago/archipelago.db'), true);
  try { assert.ok(store.diagnostics({ severity: 'error' }).items.some(item => item.code === 'typescript-parse-error')); } finally { store.close(); }
});
