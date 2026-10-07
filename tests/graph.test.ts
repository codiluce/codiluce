import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stringify } from 'yaml';
import { indexRepository } from '../src/pipeline/index.js';
import { GraphStore } from '../src/storage/sqlite.js';
import { createInspectionServer } from '../src/api/server.js';
import { applicationAt, loadConfig, matchesGlob } from '../src/core/config.js';
import { validateGraph, type SoftwareGraph, type Entity } from '../src/core/graph.js';
import { nextRoute } from '../src/analyzers/typescript.js';
import { shapeHash } from '../src/history/fingerprint.js';

const execute = promisify(execFile);
const fixture = fileURLToPath(new URL('./fixtures/repository', import.meta.url));
const temporary: string[] = [];
let root: string, graph: SoftwareGraph;
async function createFixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'atlas-fixture-')); temporary.push(root);
  await cp(fixture, root, { recursive: true });
  await mkdir(path.join(root, '.codiluce'));
  await writeFile(path.join(root, '.codiluce/config.yml'), stringify({ repository: { name: 'fixture' }, applications: [{ name: 'frontend', path: 'frontend', type: 'nextjs' }, { name: 'backend', path: 'backend', type: 'laravel', apiOrigins: ['https://api.fixture.test'], apiOriginEnv: ['NEXT_PUBLIC_API_URL'] }], ignore: ['**/custom-ignored/**'] }));
  return root;
}
/** `name` or `name:type` (e.g. `login:function`). */
function relation(from: string, to: string, type: string) {
  const pick = (spec: string) => { const [name, kind] = spec.split(':'); return entity(name!, kind); };
  return graph.relations.find(edge => edge.from === pick(from).id && edge.to === pick(to).id && edge.type === type);
}
function symbol(qualifiedName: string): Entity {
  const found = graph.entities.find(item => item.metadata.qualifiedName === qualifiedName);
  assert.ok(found, `Expected symbol ${qualifiedName}`); return found;
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
test('configuration autodetects apps, completes configured ones from manifests and rejects escaping/duplicate paths', async () => {
  const state = await mkdtemp(path.join(tmpdir(), 'atlas-state-')); temporary.push(state);
  const config = await loadConfig(root, state);
  assert.deepEqual(config.applications.map(item => item.frameworks[0]).sort(), ['laravel', 'nextjs']);
  // The earlier single `type` is one configured framework; manifests add theirs and the ecosystem.
  await writeFile(path.join(state, 'config.yml'), stringify({ applications: [{ name: 'web', path: 'frontend', type: 'nextjs' }] }));
  const [web] = (await loadConfig(root, state)).applications;
  assert.equal(web!.frameworks[0], 'nextjs'); assert.ok(web!.frameworks.includes('react')); assert.deepEqual(web!.ecosystems, ['node']);
  await writeFile(path.join(state, 'config.yml'), stringify({ applications: [{ name: 'escape', path: '../', type: 'nextjs' }] }));
  await assert.rejects(loadConfig(root, state), /outside repository/);
  await writeFile(path.join(state, 'config.yml'), stringify({ applications: [{ name: 'one', path: 'frontend', frameworks: ['nextjs'] }, { name: 'two', path: 'frontend/', frameworks: ['nextjs'] }] }));
  await assert.rejects(loadConfig(root, state), /must be unique/);
  await writeFile(path.join(state, 'config.yml'), stringify({ applications: [{ name: 'one', path: 'frontend', ecosystems: ['cobol'] }] }));
  await assert.rejects(loadConfig(root, state), /Invalid application configuration/);
  // Applications nest: a file belongs to the innermost one.
  await writeFile(path.join(state, 'config.yml'), stringify({ applications: [{ name: 'one', path: 'frontend', frameworks: ['nextjs'] }, { name: 'two', path: 'frontend/src/services' }] }));
  const nested = (await loadConfig(root, state)).applications;
  assert.equal(applicationAt(nested, 'frontend/src/services/client.ts')?.name, 'two');
  assert.equal(applicationAt(nested, 'frontend/src/app/layout.tsx')?.name, 'one');
  assert.equal(applicationAt(nested, 'backend/routes/web.php'), undefined);
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
  const store = new GraphStore(path.join(root, '.codiluce/codiluce.db'), true);
  try { assert.ok(store.diagnostics({ severity: 'error' }).items.some(item => item.code === 'typescript-parse-error')); } finally { store.close(); }
});

test('TypeScript calls, renders and handler references resolve through the type checker', () => {
  // A component rendering another, a handler bound as an event prop, a callback, and an inline handler calling a function.
  assert.ok(relation('AccountPage', 'AccountPanel', 'renders'));
  assert.ok(relation('AccountPanel', 'LoginForm', 'renders'));
  const handler = relation('AccountPanel', 'handleSave', 'references')!;
  assert.deepEqual([handler.metadata!.forms, handler.metadata!.events], [['handler'], ['onClick']]);
  assert.match(handler.evidence[0]!.explanation!, /Passes handleSave as onClick of <button>/);
  assert.deepEqual(relation('AccountPanel', 'renderRow', 'references')!.metadata!.forms, ['callback']);
  const inline = relation('LoginForm:component', 'login:function', 'calls')!;
  assert.deepEqual(inline.metadata!.events, ['onSubmit']);
  // Singleton: AccountService.getInstance().signIn() reaches the method through the declared return type.
  assert.ok(relation('handleSave', 'getInstance', 'calls'));
  assert.ok(relation('handleSave', 'signIn', 'calls'));
  assert.deepEqual(relation('getInstance', 'AccountService:class', 'calls')!.metadata!.forms, ['new']);
  assert.equal(relation('handleSave', 'signIn', 'calls')!.evidence[0]!.file, 'frontend/src/components/AccountPanel.tsx');
  // A service held in useMemo(() => AccountService.getInstance(), []): React's types are not loaded, so it is typed from the factory.
  assert.ok(relation('UserPage', 'profile', 'calls'), 'service.profile() through a memoized singleton');
  assert.deepEqual(entity('UserPage').metadata.callSites, { resolved: 2, external: 2, unresolved: 0 }, 'getInstance() and profile(); useMemo and useEffect are external');
  // Call-site coverage: package calls are external, a callback parameter is unresolved.
  assert.deepEqual(entity('AccountPanel').metadata.callSites, { resolved: 2, external: 2, unresolved: 0 });
  assert.deepEqual(entity('localFetch').metadata.callSites, { resolved: 0, external: 0, unresolved: 1, unresolvedNames: { fetch: 1 } });
});
test('HTTP URLs built from a proven base link to endpoints with every hop as evidence', () => {
  const signIn = relation('signIn', 'POST /auth/login', 'requests')!;
  assert.ok(signIn, 'this.API_BASE_URL → getUrlFromEnv() → configured origin or declared env var');
  assert.equal(signIn.metadata!.resolution, 'proven-base');
  const explanations = signIn.evidence.map(fact => fact.explanation ?? '');
  assert.ok(explanations.some(text => /this\.API_BASE_URL is assigned getUrlFromEnv\(\)\.toString\(\)/.test(text)));
  assert.ok(explanations.some(text => /process\.env\.NEXT_PUBLIC_API_URL is declared in the configuration \(apiOriginEnv\)/.test(text)));
  assert.ok(signIn.evidence.some(fact => fact.file === 'frontend/src/data/api.ts'));
  // A template hole fills a route parameter; the base is still proven.
  const profile = relation('profile', 'GET /profiles/{id}', 'requests')!;
  assert.equal(profile.metadata!.pattern, '/profiles/{*}');
  assert.ok(profile.evidence.some(fact => /dynamic path segment matched to route parameter/.test(fact.explanation ?? '')));
  // Same-origin: JavaScript served by the Laravel application calling its own routes.
  assert.equal(relation('loadProfile', 'GET /profiles/{id}', 'requests')!.metadata!.resolution, 'same-origin');
  // Failures keep a specific reason.
  const reason = (name: string, code: string) => graph.diagnostics.find(item => item.entityId === entity(name).id && item.code === code)?.reason;
  assert.match(reason('elsewhere', 'unresolved-http-call')!, /process\.env\.OTHER_SERVICE_URL is not declared as an application origin/);
  assert.match(reason('missing', 'unmatched-http-call')!, /GET \/nowhere\/at\/all on backend: 0 eligible endpoints/);
  assert.ok(!graph.relations.some(edge => edge.type === 'requests' && edge.from === entity('dynamicUrl').id), 'a relative template from Next still needs a proven boundary');
  // The caller's network effect records the endpoint it reaches.
  const network = (entity('signIn').metadata.effects as { category: string; endpoint?: string }[]).find(item => item.category === 'network')!;
  assert.equal(network.endpoint, entity('POST /auth/login').id);
});
test('PHP calls resolve through $this, promoted properties, new and inheritance; the rest is counted', () => {
  const login = symbol('App\\Http\\Controllers\\AuthController::login'), authenticate = symbol('App\\Services\\AuthService::authenticate');
  const show = symbol('App\\Http\\Controllers\\ProfileController::show'), update = symbol('App\\Http\\Controllers\\ProfileController::update'), audit = symbol('App\\Http\\Controllers\\ProfileController::audit');
  const has = (from: Entity, to: Entity, form: string) => graph.relations.some(edge => edge.from === from.id && edge.to === to.id && edge.type === 'calls' && (edge.metadata!.forms as string[]).includes(form));
  assert.ok(has(login, authenticate, 'call'), '(new AuthService())->authenticate()');
  assert.ok(has(login, symbol('App\\Services\\AuthService'), 'new'));
  assert.ok(has(show, authenticate, 'call'), '$this->auth->authenticate() through the promoted constructor property');
  assert.ok(has(update, audit, 'call'), '$this->audit()');
  // An undeclared property is unresolved; FormRequest::validated() is inherited from the framework.
  assert.deepEqual(audit.metadata.callSites, { resolved: 0, external: 0, unresolved: 1, unresolvedNames: { record: 1 } });
  assert.equal((update.metadata.callSites as { unresolved: number }).unresolved, 0);
});
test('effects are recorded from resolved names: database, responses, storage and navigation', () => {
  const effects = (item: Entity) => (item.metadata.effects as { category: string; operation: string; status?: number; target?: string }[]).map(fact => `${fact.category}:${fact.operation}${fact.status ? `:${fact.status}` : ''}`);
  assert.deepEqual(effects(symbol('App\\Services\\AuthService::authenticate')), ['database:read']);
  assert.equal((symbol('App\\Services\\AuthService::authenticate').metadata.effects as { target?: string }[])[0]!.target, symbol('App\\Models\\User').id);
  assert.deepEqual(effects(symbol('App\\Http\\Controllers\\ProfileController::show')), ['response:abort:404', 'response:json:200']);
  assert.deepEqual(effects(symbol('App\\Http\\Controllers\\ProfileController::update')), ['response:validation:422', 'database:read', 'response:not found:404', 'database:write', 'database:write', 'response:redirect:302']);
  assert.deepEqual(effects(symbol('App\\Http\\Controllers\\AuthController::user')), ['response:return:200']);
  assert.ok(effects(entity('signIn')).includes('storage:write'));
  assert.deepEqual(effects(entity('handleSave')), ['navigation:push']);
  assert.deepEqual(effects(entity('GET', 'function')), ['response:json:200']);
});
test('HTTP wrappers and axios instances resolve at their call sites, as requests of the callers', () => {
  const requests = (from: string, to: string) => relation(from, to, 'requests');
  const explanations = (edge: { evidence: { explanation?: string }[] }) => edge.evidence.map(fact => fact.explanation ?? '');
  // axios.create({ baseURL: process.env.NEXT_PUBLIC_API_URL }) in another module, then api.get(`/users/${id}`).
  const instance = requests('loadUser', 'GET /users/{id}')!;
  assert.equal(instance.metadata!.resolution, 'proven-base');
  assert.ok(explanations(instance).some(text => /axios instance api/.test(text)) && explanations(instance).some(text => /NEXT_PUBLIC_API_URL is declared/.test(text)));
  // postJson(url, body) sends fetch(url, { method: 'post' }): the caller's argument is the URL.
  const wrapped = requests('signInJson', 'POST /auth/login')!;
  assert.equal(wrapped.evidence[0]!.file, 'frontend/src/services/profileApi.ts');
  assert.match(wrapped.evidence[0]!.explanation!, /Calls postJson\(…\)/);
  assert.ok(wrapped.evidence.some(fact => fact.file === 'frontend/src/services/client.ts' && /in postJson\(\) is built from the function's parameters/.test(fact.explanation ?? '')));
  // The method comes from the init the caller passes ({ ...init } in the wrapper).
  assert.ok(requests('saveProfile', 'PUT /profiles/{id}'));
  // Nested wrappers: readProfile → getJson(path) → apiFetch(path) → fetch.
  const nested = requests('readProfile', 'GET /profiles/{id}')!;
  assert.ok(explanations(nested).some(text => /apiFetch\(path\) passes its arguments on/.test(text)));
  // Wrappers request nothing themselves; their network effect says it is made for their callers.
  for (const name of ['postJson', 'apiFetch', 'getJson']) assert.ok(!graph.relations.some(edge => edge.type === 'requests' && edge.from === entity(name).id), name);
  assert.equal((entity('postJson').metadata.effects as { wrapper?: boolean }[])[0]!.wrapper, true);
  const network = (entity('readProfile').metadata.effects as { via: string; endpoint?: string }[])[0]!;
  assert.deepEqual([network.via, network.endpoint], ['fetch (Fetch API) through getJson()', entity('GET /profiles/{id}').id]);
  const finding = (name: string, code: string) => graph.diagnostics.find(item => item.entityId === entity(name).id && item.code === code)?.reason;
  assert.match(finding('postJson', 'http-wrapper')!, /1 of 2 call sites resolved/);
  assert.match(finding('apiFetch', 'http-wrapper')!, /2 of 3 call sites resolved/);
  assert.match(finding('relay', 'unresolved-http-call')!, /built from a parameter of relay\(\), and no call site of relay\(\) was resolved/);
  assert.match(finding('choose', 'unresolved-http-call')!, /no call site of choose\(\) was resolved/);
  assert.match(finding('quarterlyReports', 'unresolved-http-call')!, /baseURL: process\.env\.REPORTS_URL is not declared/);
  const calls = graph.entities.find(item => item.path === 'frontend/src/services/profileApi.ts' && item.type === 'file')!.metadata.httpRequests as { resolution: string; wrapper?: string }[];
  assert.deepEqual(calls.filter(item => item.resolution === 'wrapper').map(item => item.wrapper).sort(), ['apiFetch', 'getJson', 'postJson']);
});
test('files carry Git metrics of committed history, following renames; history snapshots and non-Git trees have none', async () => {
  const repository = await createFixture();
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: repository };
  const git = (args: string[], author = 'Ana <ana@example.test>', date = '2026-01-01T10:00:00Z') => execute('git', ['-c', 'user.name=x', '-c', 'user.email=x@example.test', ...args], { cwd: repository, env: { ...env, GIT_AUTHOR_NAME: author.split(' <')[0], GIT_AUTHOR_EMAIL: author.split('<')[1]!.slice(0, -1), GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
  await git(['init', '-q', '-b', 'main']);
  await git(['add', '-A']); await git(['commit', '-q', '-m', 'initial']);
  const form = path.join(repository, 'frontend/src/components/LoginForm.tsx');
  await writeFile(form, `${await readFile(form, 'utf8')}// one\n`);
  await git(['commit', '-q', '-am', 'edit'], 'Ben <BEN@example.test>', '2026-01-02T10:00:00Z');
  await mkdir(path.join(repository, 'frontend/src/components/auth'));
  await git(['mv', 'frontend/src/components/LoginForm.tsx', 'frontend/src/components/auth/LoginForm.tsx']);
  await git(['commit', '-q', '-m', 'move'], 'Ben <ben@example.test>', '2026-01-03T10:00:00Z');
  const head = (await execute('git', ['rev-parse', 'HEAD'], { cwd: repository })).stdout.trim();
  const indexed = await indexRepository(repository);
  const moved = indexed.entities.find(item => item.type === 'file' && item.path === 'frontend/src/components/auth/LoginForm.tsx')!;
  assert.deepEqual(moved.metrics, { loc: 7, commits: 3, authors: 2, churn: 7, lastChangedAt: '2026-01-03T10:00:00+00:00', lastCommit: head }, 'the rename carries the older history; author e-mails are compared case-insensitively');
  const untouched = indexed.entities.find(item => item.type === 'file' && item.path === 'backend/routes/api.php')!;
  assert.equal(untouched.metrics!.commits, 1);
  assert.ok(indexed.run.analyzerVersions['git-metrics']);
  // A materialized commit tree (history) and a directory without Git get no metrics, never zeros.
  const plain = await indexRepository(repository, { revision: head });
  assert.ok(plain.entities.every(item => item.metrics?.commits === undefined));
  assert.ok(graph.entities.every(item => item.metrics?.commits === undefined));
  assert.ok(graph.diagnostics.some(item => item.code === 'git-metrics-unavailable'));
});
test('migrations declare tables, columns and foreign keys; models map to them; code reads and writes them', () => {
  const users = entity('users', 'database_table');
  assert.equal(users.parentId, entity('backend', 'application').id);
  assert.deepEqual((users.metadata.columns as { name: string }[]).map(column => column.name), ['id', 'email', 'admin', 'api_token', 'nickname'], 'created, altered, renamed and conditionally added columns');
  assert.deepEqual(users.metadata.migrations, ['backend/database/migrations/2026_01_01_create_users.php', 'backend/database/migrations/2026_01_03_update_users.php']);
  assert.equal(users.metadata.conditional, true);
  assert.equal(users.path, 'backend/database/migrations/2026_01_01_create_users.php');
  assert.ok(users.evidence.every(fact => fact.source === 'framework' && fact.file?.includes('/database/migrations/')));
  assert.match(users.evidence[0]!.explanation!, /not the live database/);
  assert.ok(!graph.entities.some(item => item.type === 'database_table' && item.name === 'legacy_sessions'), 'a table dropped by a later migration is gone');
  const profiles = entity('profiles', 'database_table');
  assert.deepEqual(profiles.metadata.foreignKeys, [{ column: 'user_id', table: 'users', references: 'id', onDelete: 'cascade' }]);
  const constrained = relation('profiles:database_table', 'users:database_table', 'foreign_key')!;
  assert.deepEqual(constrained.metadata!.columns, [{ column: 'user_id', references: 'id', onDelete: 'cascade' }]);
  assert.match(constrained.evidence[0]!.explanation!, /constrained\(\) convention/);
  assert.ok(relation('audit:database_table', 'users:database_table', 'foreign_key'), '->references()->on()');
  // Eloquent models become models and map to their tables: explicit $table first, then the naming convention.
  assert.equal(entity('User').type, 'model');
  const explicit = relation('User:model', 'users:database_table', 'maps_to')!;
  assert.deepEqual([explicit.metadata!.mapping, explicit.evidence[0]!.source, explicit.evidence[0]!.explanation], ['property', 'php', "protected $table = 'users'"]);
  const convention = relation('Profile:model', 'profiles:database_table', 'maps_to')!;
  assert.deepEqual([convention.metadata!.mapping, convention.evidence[0]!.source], ['convention', 'framework']);
  // Reads and writes through models, model instances and DB::table().
  const reads = (from: Entity, table: string) => graph.relations.find(edge => edge.from === from.id && edge.to === entity(table, 'database_table').id && edge.type === 'reads');
  const writes = (from: Entity, table: string) => graph.relations.find(edge => edge.from === from.id && edge.to === entity(table, 'database_table').id && edge.type === 'writes');
  assert.deepEqual(reads(symbol('App\\Services\\AuthService::authenticate'), 'users')!.metadata!.forms, ['eloquent']);
  assert.ok(reads(symbol('App\\Services\\AuthService::profileOf'), 'profiles'));
  const update = symbol('App\\Http\\Controllers\\ProfileController::update');
  assert.ok(reads(update, 'users') && writes(update, 'users'), 'findOrFail, then $user->update()');
  assert.deepEqual(writes(update, 'audit')!.metadata!.forms, ['query']);
  assert.match(writes(update, 'audit')!.evidence[0]!.explanation!, /through DB::table\('audit'\)/);
  assert.equal((symbol('App\\Services\\AuthService::authenticate').metadata.effects as { tableName?: string }[])[0]!.tableName, 'users');
  assert.ok(graph.diagnostics.some(item => item.code === 'dynamic-migration-table' && item.file === 'backend/database/migrations/2026_01_03_update_users.php'), 'a dynamic table name is reported, not guessed');
});
test('apiOriginEnv is validated, and derived metadata does not change an entity\'s shape', async () => {
  const state = await mkdtemp(path.join(tmpdir(), 'atlas-state-')); temporary.push(state);
  await writeFile(path.join(state, 'config.yml'), stringify({ applications: [{ name: 'backend', path: 'backend', type: 'laravel', apiOriginEnv: ['NOT VALID'] }] }));
  await assert.rejects(loadConfig(root, state), /apiOriginEnv must contain environment variable names/);
  await writeFile(path.join(state, 'config.yml'), stringify({ applications: [{ name: 'backend', path: 'backend', type: 'laravel', apiOriginEnv: ['API'] }, { name: 'frontend', path: 'frontend', type: 'nextjs', apiOriginEnv: ['API'] }] }));
  await assert.rejects(loadConfig(root, state), /declared for more than one application/);
  const target = entity('signIn');
  assert.equal(shapeHash({ ...target, metadata: { ...target.metadata, callSites: { resolved: 9, external: 0, unresolved: 0 }, effects: [] } }), shapeHash(target));
});

test('Artisan commands, the scheduler and the code running them by name are entry points with evidence', () => {
  const send = entity('reports:send', 'command'), prune = entity('reports:prune', 'command'), inspire = entity('inspire', 'command');
  assert.equal(send.parentId, entity('backend', 'application').id);
  assert.equal(send.metadata.signature, 'reports:send {--daily : Only the daily report}');
  assert.equal(send.metadata.description, 'Send the activity reports');
  assert.ok(graph.relations.some(edge => edge.from === send.id && edge.to === symbol('App\\Console\\Commands\\SendReports::handle').id && edge.type === 'handles'));
  assert.equal(inspire.metadata.handlerKind, 'closure');
  assert.equal(inspire.metadata.description, 'Display an inspiring quote');
  // The scheduler: cadence and modifiers, by command line, by class, and a job.
  const daily = entity('reports:send --daily', 'scheduled_task');
  assert.equal(daily.metadata.cadence, 'daily at 02:00');
  assert.deepEqual(daily.metadata.modifiers, ['withoutOverlapping']);
  assert.ok(graph.relations.some(edge => edge.from === daily.id && edge.to === send.id && edge.type === 'invokes'));
  const weekly = graph.entities.find(item => item.type === 'scheduled_task' && item.metadata.cadence === 'weekly')!;
  assert.ok(graph.relations.some(edge => edge.from === weekly.id && edge.to === prune.id && edge.type === 'invokes'));
  const job = entity('RebuildIndex', 'scheduled_task');
  assert.ok(graph.relations.some(edge => edge.from === job.id && edge.to === symbol('App\\Jobs\\RebuildIndex::handle').id && edge.type === 'invokes'));
  assert.ok(graph.diagnostics.some(item => item.code === 'unresolved-scheduled-task' && item.entityId === entity('reports:missing', 'scheduled_task').id));
  // Running commands by name, and dispatching a job.
  const invoked = (from: string, to: Entity) => graph.relations.find(edge => edge.from === symbol(from).id && edge.to === to.id && edge.type === 'invokes');
  assert.equal(invoked('App\\Console\\Commands\\SendReports::handle', prune)?.metadata?.forms?.toString(), 'artisan');
  assert.ok(invoked('App\\Http\\Controllers\\AdminController::rebuild', send));
  const dispatch = graph.relations.find(edge => edge.from === symbol('App\\Http\\Controllers\\AdminController::rebuild').id && edge.to === symbol('App\\Jobs\\RebuildIndex::handle').id && edge.type === 'calls');
  assert.deepEqual(dispatch?.metadata?.forms, ['dispatch']);
});

test('Inertia: the server renders page components by name, and their visits are requests', () => {
  const dashboard = graph.entities.find(item => item.type === 'component' && item.path === 'backend/resources/js/pages/admin/dashboard.tsx' && item.name === 'Dashboard')!;
  const index = symbol('App\\Http\\Controllers\\AdminController::index');
  const renders = graph.relations.find(edge => edge.from === index.id && edge.to === dashboard.id && edge.type === 'renders');
  assert.ok(renders);
  assert.equal(renders.metadata?.page, 'admin/dashboard');
  const effect = (index.metadata.effects as { operation: string; page?: string; target?: string; status?: number }[]).find(item => item.operation === 'inertia')!;
  assert.deepEqual([effect.page, effect.target, effect.status], ['admin/dashboard', dashboard.id, 200]);
  assert.ok(!(index.metadata.effects as { operation: string }[]).some(item => item.operation === 'return'), 'the render is the response, not a generic return value');
  // A route closure rendering a page.
  const about = graph.entities.find(item => item.type === 'component' && item.name === 'About')!;
  assert.ok(graph.relations.some(edge => edge.from === entity('GET /about', 'api_endpoint').id && edge.to === about.id && edge.type === 'renders'));
  assert.ok(graph.diagnostics.some(item => item.code === 'inertia-page-not-found' && item.entityId === symbol('App\\Http\\Controllers\\AdminController::missing').id));
  // Visits: the router, a useForm() form (assigned and destructured), and links.
  const rebuild = entity('POST /admin/rebuild', 'api_endpoint');
  for (const caller of ['rebuild', 'again', 'third']) {
    const from = graph.entities.find(item => item.name === caller && item.path === dashboard.path)!;
    const request = graph.relations.find(edge => edge.from === from.id && edge.to === rebuild.id && edge.type === 'requests');
    assert.ok(request, `${caller} requests POST /admin/rebuild`);
    assert.equal(request.metadata?.resolution, 'same-origin');
  }
  assert.ok(graph.relations.some(edge => edge.from === dashboard.id && edge.to === rebuild.id && edge.type === 'requests'), '<Link method="post"> is a request');
  assert.ok(graph.relations.some(edge => edge.from === dashboard.id && edge.to === entity('GET /about', 'api_endpoint').id && edge.type === 'requests'));
  // A link built from data is recorded, not reported.
  const file = graph.entities.find(item => item.path === dashboard.path && item.type === 'file')!;
  assert.ok((file.metadata.httpRequests as { client?: string; resolution: string }[]).some(item => item.client === 'Inertia Link' && item.resolution === 'unresolved'));
  assert.ok(!graph.diagnostics.some(item => item.file === dashboard.path && item.code === 'unresolved-http-call'));
});

test('Fortify: endpoints come from config/fortify.php features, views and action bindings', () => {
  const fortify = graph.entities.filter(item => item.type === 'api_endpoint' && item.metadata.package === 'laravel/fortify');
  const names = fortify.map(item => item.name);
  // Always registered, by enabled feature; disabled features (resetPasswords) declare nothing.
  for (const name of ['GET /login', 'POST /login', 'POST /logout', 'GET /register', 'POST /register', 'GET /user/confirm-password']) assert.ok(names.includes(name), `Expected ${name}`);
  assert.ok(!names.includes('POST /forgot-password') && !names.includes('GET /two-factor-challenge'));
  // A view closure renders its Inertia page; an action binding handles the endpoint.
  const register = fortify.find(item => item.name === 'GET /register')!;
  assert.equal(register.metadata.inertiaPage, 'auth/register');
  assert.equal(register.path, 'backend/app/Providers/FortifyServiceProvider.php');
  const page = graph.entities.find(item => item.type === 'component' && item.name === 'Register')!;
  assert.ok(graph.relations.some(edge => edge.from === register.id && edge.to === page.id && edge.type === 'renders'));
  const store = fortify.find(item => item.name === 'POST /register')!;
  assert.ok(graph.relations.some(edge => edge.from === store.id && edge.to === symbol('App\\Actions\\Fortify\\CreateNewUser::create').id && edge.type === 'handles'));
  assert.equal(fortify.find(item => item.name === 'GET /login')!.metadata.view, 'auth.login');
  assert.equal(fortify.find(item => item.name === 'POST /login')!.metadata.handlerKind, 'package');
});

test('an anonymous default-exported arrow is a component that importers render', () => {
  const layout = graph.entities.find(item => item.path === 'backend/resources/js/layouts/auth-layout.tsx' && item.type === 'component')!;
  assert.equal(layout.name, 'default');
  assert.equal(graph.entities.find(item => item.type === 'file' && item.path === layout.path)!.metadata.defaultExport, layout.id);
  const page = graph.entities.find(item => item.type === 'component' && item.name === 'Register')!;
  assert.ok(graph.relations.some(edge => edge.from === page.id && edge.to === layout.id && edge.type === 'renders'));
});
