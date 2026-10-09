import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { indexRepository } from '../src/pipeline/index.js';
import { resolveConfig, type RustConfig } from '../src/core/config.js';
import { AnalysisCache } from '../src/pipeline/cache.js';
import { canonicalJson } from '../src/history/fingerprint.js';
import { compileRustPath, matchRustPath, actixPath } from '../src/analysis/routes/rust-patterns.js';
import type { SoftwareGraph, Entity } from '../src/core/graph.js';
const roots: string[] = [];
after(async () => { await Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))); });
async function put(root: string, file: string, text: string) { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), text); }
const axum = 'axum="0.8.9"\ntokio={version="1.53.2",features=["full"]}';
const actix = 'actix-web="4.15.0"';
async function repo(source: string, dependencies = axum, files: Record<string, string> = {}) {
    const root = await mkdtemp(path.join(tmpdir(), 'codiluce-rust-routers-'));
    roots.push(root);
    for (const [file, text] of Object.entries({ 'Cargo.toml': '[package]\nname="api"\nversion="1.0.0"\nedition="2021"\n[dependencies]\n' + dependencies, 'src/main.rs': source, ...files }))
        await put(root, file, text);
    return root;
}
const selected: RustConfig = { features: [], defaultFeatures: false };
async function index(root: string, cache?: AnalysisCache, rust = selected, revision?: string) { return indexRepository(root, { config: await resolveConfig(root, { applications: [{ name: 'api', path: '.', apiOrigins: ['https://api.test'], rust }] }), cache, revision }); }
const endpoints = (g: SoftwareGraph) => g.entities.filter(entity => entity.type === 'api_endpoint' && entity.language === 'rust');
const declared = (g: SoftwareGraph) => endpoints(g).filter(entity => entity.metadata.registration === 'explicit');
const handler = (g: SoftwareGraph, endpoint: Entity) => g.entities.find(entity => g.relations.some(relation => relation.type === 'handles' && relation.from === endpoint.id && relation.to === entity.id));
const route = (g: SoftwareGraph, url: string) => declared(g).find(entity => entity.metadata.routePath === url)!;
const requests = (g: SoftwareGraph) => g.relations.filter(relation => relation.type === 'requests').map(relation => g.entities.find(entity => entity.id === relation.to)!);
const shape = (g: SoftwareGraph) => canonicalJson({ entities: g.entities, relations: g.relations, diagnostics: g.diagnostics.filter(d => !['git-metrics', 'indexer'].includes(d.analyzer) && d.code !== 'git-ignore-unavailable') });
const serve = (routes: string) => `use axum::{Router,routing::{get,post,head}};async fn handler(){}#[tokio::main]async fn main(){let app=${routes};let listener=tokio::net::TcpListener::bind("127.0.0.1:3000").await.unwrap();axum::serve(listener,app).await.unwrap();}`;
const app = (routes: string) => `use actix_web::{web,App,HttpServer};async fn handler(){}#[actix_web::main]async fn main(){HttpServer::new(||${routes}).bind("127.0.0.1:3000").unwrap().run().await.unwrap();}`;
test('Axum version-specific captures are raw, strict and terminal wildcards are nonempty', () => {
    for (const [dialect, path] of [['axum-0.7', '/users/:id'], ['axum-0.8', '/users/{id}']] as const) {
        const p = compileRustPath(path, dialect);
        assert.equal(p.status, 'exact');
        assert.ok(matchRustPath(p, '/users/a%2Fb'));
        assert.ok(!matchRustPath(p, '/Users/a'));
        assert.ok(!matchRustPath(p, '/users/a/'));
        assert.ok(!matchRustPath(p, '/users/'));
    }
    const p = compileRustPath('/files/{*tail}', 'axum-0.8');
    assert.ok(matchRustPath(p, '/files/a/b'));
    assert.ok(!matchRustPath(p, '/files/'));
    assert.equal(compileRustPath('/users/:id', 'axum-0.8').status, 'partial');
    assert.equal(compileRustPath('/users/:id', 'axum-0.8', true).status, 'exact');
    assert.ok(!matchRustPath(compileRustPath('/users/:id', 'axum-0.8', true), '/users/a'));
});
test('Actix implicit slash, embedded captures, reviewed constraints and protected percent bytes', () => {
    assert.ok(matchRustPath(compileRustPath('foo-{id:[0-9]+}.json', 'actix-web-4'), '/foo-42.json'));
    assert.ok(!matchRustPath(compileRustPath('/foo-{id:[0-9]+}.json', 'actix-web-4'), '/foo-abc.json'));
    assert.ok(matchRustPath(compileRustPath('/{id:[^/]+}', 'actix-web-4'), '/abc'));
    assert.ok(!matchRustPath(compileRustPath('/{id}', 'actix-web-4'), '/{literal}'));
    assert.equal(compileRustPath('/{id:(a+)+}', 'actix-web-4').status, 'partial');
    assert.equal(actixPath('/a%20%25%2F%2b%FE%zz'), '/a %25%2F%2b�%zz');
    assert.ok(matchRustPath(compileRustPath('/a b', 'actix-web-4'), '/a%20b'));
    assert.ok(!matchRustPath(compileRustPath('/a b', 'axum-0.8'), '/a%20b'));
});
test('Native original Axum served registrations bind source handlers and retain Cargo/serving proof', async () => {
    const g = await index(await repo(serve('Router::new().route("/users/{id}",get(handler))')));
    const endpoint = route(g, '/users/{id}');
    assert.ok(endpoint, JSON.stringify(g.diagnostics.filter(d => d.analyzer === 'rust-routers')));
    assert.equal(endpoint.metadata.constraintsUnresolved, undefined);
    assert.equal(handler(g, endpoint)?.name, 'handler');
    assert.ok(endpoint.evidence.some(fact => fact.file === 'Cargo.toml'));
    assert.ok(endpoint.evidence.some(fact => fact.explanation?.includes('serving future')));
    assert.deepEqual((endpoint.metadata.routing as any).methods, ['GET', 'HEAD']);
});
test('Actix App.route factory binds an original async handler with resource-level method guards', async () => {
    const g = await index(await repo(app('App::new().route("/users/{id}",web::get().to(handler))'), actix));
    const endpoint = route(g, '/users/{id}');
    assert.ok(endpoint);
    assert.equal(endpoint.metadata.constraintsUnresolved, undefined);
    assert.equal(handler(g, endpoint)?.name, 'handler');
    assert.deepEqual((endpoint.metadata.routing as any).rust.resourceMethods, ['GET']);
    assert.equal(endpoints(g).filter(e => e.metadata.role === 'not-found').length, 1);
});
test('Unserved Axum and unawaited construction cannot expose endpoints', async () => {
    for (const source of ['use axum::{Router,routing::get};async fn handler(){}fn main(){let app=Router::new().route("/x",get(handler));}', serve('Router::new().route("/x",get(handler))').replace('axum::serve(listener,app).await.unwrap();', 'let future=axum::serve(listener,app);')])
        assert.equal(endpoints(await index(await repo(source))).length, 0);
});
test('Stored Axum serving futures and success-path try expressions preserve awaited exposure', async () => {
    const source = serve('Router::new().route("/x",get(handler))').replace('axum::serve(listener,app).await.unwrap();', 'let future=axum::serve(listener,app);future.await?;');
    const g = await index(await repo(source));
    assert.equal(route(g, '/x').metadata.constraintsUnresolved, undefined);
});
test('Axum aliases, source factory summaries, merges and nests retain original mounted callbacks', async () => {
    const source = serve('factory().nest("/api",Router::new().route("/",get(handler))).merge(Router::new().route("/other",post(handler)))').replace('async fn handler(){}', 'async fn handler(){}fn factory()->Router{let cb=handler;Router::new().route("/factory",get(cb))}');
    const g = await index(await repo(source));
    assert.deepEqual(declared(g).map(e => e.metadata.routePath).sort(), ['/api', '/factory', '/other']);
    assert.ok(declared(g).every(e => !e.metadata.constraintsUnresolved && handler(g, e)?.name === 'handler'));
    assert.equal((route(g, '/api').metadata.routing as any).mounts.length, 1);
});
test('Named source route helpers accept an original callback parameter', async () => {
    const source = serve('register(Router::new(),method_factory)').replace('async fn handler(){}', 'async fn handler(){}fn method_factory()->axum::routing::MethodRouter{get(handler)}fn register(app:Router,cb:fn()->axum::routing::MethodRouter)->Router{app.route("/x",cb())}');
    const g = await index(await repo(source));
    assert.equal(handler(g, route(g, '/x'))?.name, 'handler');
    assert.ok(!route(g, '/x').metadata.constraintsUnresolved);
});
test('Original closures retain their Rust owner rather than becoming synthetic handlers', async () => {
    const g = await index(await repo(serve('Router::new().route("/x",get(||async{}))')));
    const endpoint = route(g, '/x'), callback = handler(g, endpoint)!;
    assert.equal(callback.metadata.declarationKind, 'closure');
    assert.equal(g.entities.find(e => e.id === callback.parentId)?.name, 'main');
    assert.ok(callback.sourceRange);
    assert.ok(!endpoint.metadata.constraintsUnresolved);
});
test('Canonical renamed framework imports activate while local lookalikes and crossing versions cannot win', async () => {
    const renamed = serve('Router::new().route("/x",get(handler))').replaceAll('axum', 'http');
    assert.ok(!route(await index(await repo(renamed, axum.replace('axum="0.8.9"', 'http={package="axum",version="0.8.9"}'))), '/x').metadata.constraintsUnresolved);
    const crossing = await index(await repo(serve('Router::new().route("/x",get(handler))'), axum.replace('0.8.9', '>=0.7, <0.9')));
    assert.ok(declared(crossing).every(e => e.metadata.constraintsUnresolved));
    assert.ok(crossing.diagnostics.some(d => d.analyzer === 'rust-routers'));
    const local = await index(await repo(serve('Router::new().route("/x",get(handler))'), axum.replace('axum="0.8.9"', 'axum={path="fake"}'), { 'fake/Cargo.toml': '[package]\nname="axum"\nversion="0.8.9"\nedition="2021"', 'fake/src/lib.rs': 'pub struct Router;impl Router{pub fn new()->Self{Router}pub fn route(self,path:&str,cb:fn())->Self{self}}pub mod routing{pub fn get(cb:fn())->fn(){cb}}' }));
    assert.equal(endpoints(local).length, 0);
});
test('Legacy Axum syntax stays selected by the original Cargo version', async () => {
    const g = await index(await repo(serve('Router::new().route("/users/:id",get(handler))'), axum.replace('0.8.9', '0.7.9')));
    assert.ok(!route(g, '/users/:id').metadata.constraintsUnresolved);
    assert.equal((route(g, '/users/:id').metadata.routing as any).pattern.dialect, 'axum-0.7');
});
test('Axum modern legacy-check opt-out produces literal colon paths', async () => {
    const g = await index(await repo(serve('Router::new().without_v07_checks().route("/:literal",get(handler))')));
    assert.ok(!route(g, '/:literal').metadata.constraintsUnresolved);
    assert.ok(matchRustPath((route(g, '/:literal').metadata.routing as any).pattern, '/:literal'));
    assert.ok(!matchRustPath((route(g, '/:literal').metadata.routing as any).pattern, '/other'));
});
test('Axum duplicate methods and consuming builder reuse remain constrained', async () => {
    const duplicate = await index(await repo(serve('Router::new().route("/x",get(handler)).route("/x",get(handler))')));
    assert.ok(declared(duplicate).every(e => e.metadata.constraintsUnresolved));
    const reuse = serve('original.route("/x",get(handler))').replace('let app=', 'let original=Router::new();let discarded=original.route("/discarded",get(handler));let app=');
    const g = await index(await repo(reuse));
    assert.ok(route(g, '/x').metadata.constraintsUnresolved);
});
test('Axum unknown registration escapes after serve construction constrain the stored snapshot', async () => {
    const source = serve('Router::new().route("/x",get(handler))').replace('axum::serve(listener,app).await.unwrap();', 'let future=axum::serve(listener,app.clone());opaque(app);future.await;');
    assert.ok(route(await index(await repo(source)), '/x').metadata.constraintsUnresolved);
});
test('Actix nested scopes, resources and invoked source ServiceConfig callbacks compose paths', async () => {
    const source = app('App::new().configure(configure)').replace('async fn handler(){}', 'async fn handler(){}fn configure(cfg:&mut web::ServiceConfig){cfg.service(web::scope("/api").service(web::resource("/users/{id:[0-9]+}").route(web::get().to(handler)).route(web::post().to(handler))));}');
    const g = await index(await repo(source, actix));
    const routes = declared(g).filter(e => e.metadata.routePath === '/api/users/{id:[0-9]+}');
    assert.equal(routes.length, 2);
    assert.ok(routes.every(e => handler(g, e)?.name === 'handler' && !e.metadata.constraintsUnresolved));
    assert.equal((routes[0]!.metadata.routing as any).mounts.length, 2);
});
test('Actix original HTTP attribute service macros bind their original source handler', async () => {
    const source = app('App::new().service(handler)').replace('async fn handler(){}', '#[actix_web::get("/decorated")]async fn handler(){}');
    const g = await index(await repo(source, actix));
    assert.equal(handler(g, route(g, '/decorated'))?.name, 'handler');
    assert.ok(!route(g, '/decorated').metadata.constraintsUnresolved);
    assert.ok((route(g, '/decorated').metadata.routing as any).rust.resourceMethods.includes('GET'));
});
test('Renamed Actix route attributes resolve through original macro imports', async () => {
    const source = app('App::new().service(handler)').replace('async fn handler(){}', 'use actix_web::post as endpoint;#[endpoint("/decorated")]async fn handler(){}');
    const g = await index(await repo(source, actix));
    assert.ok(!route(g, '/decorated').metadata.constraintsUnresolved);
});
test('Macro-disabled, bare lookalike and unreviewed argument attributes never produce a source winner', async () => {
    for (const [attribute, dependency] of [['#[actix_web::get("/x")]', 'actix-web={version="4.15.0",default-features=false}'], ['#[get("/x")]', actix], ['#[actix_web::get("/x",guard="custom")]', actix]] as const) {
        const g = await index(await repo(app('App::new().service(handler)').replace('async fn handler(){}', attribute + 'async fn handler(){}'), dependency));
        assert.ok(declared(g).every(e => e.metadata.constraintsUnresolved));
        assert.equal(g.relations.filter(r => r.type === 'handles').length, 0);
    }
});
test('Actix route-decorated service factories are unavailable as ordinary to callbacks', async () => {
    const g = await index(await repo(app('App::new().route("/x",web::get().to(handler))').replace('async fn handler(){}', '#[actix_web::get("/decorated")]async fn handler(){}'), actix));
    assert.ok(route(g, '/x').metadata.constraintsUnresolved);
    assert.equal(handler(g, route(g, '/x')), undefined);
});
test('Opaque layers record their source order and prevent a confirmed request match', async () => {
    const g = await index(await repo(serve('Router::new().route("/before",get(handler)).layer(opaque()).route("/after",get(handler))')));
    assert.ok(route(g, '/before').metadata.constraintsUnresolved);
    assert.ok(!route(g, '/after').metadata.constraintsUnresolved);
});
test('Source/cfg selection and conditional registrations retain visible boundaries', async () => {
    const source = serve('Router::new().route("/x",get(handler))').replace('let app=', '#[cfg(feature="web")]let app=');
    const root = await repo(source, axum + '\n[features]\nweb=[]');
    assert.equal(declared(await index(root)).length, 0);
    assert.equal(declared(await index(root, undefined, { features: ['web'], defaultFeatures: false })).length, 1);
    const conditional = serve('Router::new()').replace('let listener=', 'let app=if choice{app.route("/maybe",get(handler))}else{app};let listener=');
    const g = await index(await repo(conditional));
    assert.ok(declared(g).every(e => e.metadata.constraintsUnresolved));
});
test('Axum chooses literal paths before methods; method misses cannot reach a lower wildcard or path fallback', async () => {
    const source = serve('Router::new().route("/users/special",post(handler)).route("/users/{id}",get(other)).fallback(fallback)').replace('async fn handler(){}', 'async fn handler(){}async fn other(){}async fn fallback(){}');
    const g = await index(await repo(source, axum, { 'client.ts': 'export async function load(){await fetch("https://api.test/users/special");await fetch("https://api.test/users/value");await fetch("https://api.test/missing");}' }));
    const targets = requests(g);
    assert.equal(targets.length, 3);
    assert.equal(targets.find(e => e.metadata.role === 'method-not-allowed')?.metadata.routePath, '/users/special');
    assert.ok(targets.some(e => handler(g, e)?.name === 'other'));
    assert.ok(targets.some(e => handler(g, e)?.name === 'fallback'));
    assert.ok(!targets.some(e => handler(g, e)?.name === 'handler'));
});
test('Explicit Axum HEAD overrides GET fallback and separate verbs at the same path merge', async () => {
    const source = serve('Router::new().route("/x",get(handler)).route("/x",head(other)).route("/x",post(other))').replace('async fn handler(){}', 'async fn handler(){}async fn other(){}');
    const g = await index(await repo(source, axum, { 'client.ts': 'export async function load(){await fetch("https://api.test/x",{method:"HEAD"});await fetch("https://api.test/x");await fetch("https://api.test/x",{method:"POST"});}' }));
    assert.equal(requests(g).length, 3);
    assert.deepEqual(requests(g).map(e => handler(g, e)?.name).sort(), ['handler', 'other', 'other']);
    assert.ok(declared(g).every(e => !e.metadata.constraintsUnresolved));
});
test('Axum method-router and method-not-allowed fallbacks use original handlers at the selected path', async () => {
    const source = serve('Router::new().route("/x",get(handler).fallback(other)).route("/y",get(handler)).method_not_allowed_fallback(other)').replace('async fn handler(){}', 'async fn handler(){}async fn other(){}');
    const g = await index(await repo(source, axum, { 'client.ts': 'export async function load(){await fetch("https://api.test/x",{method:"PUT"});await fetch("https://api.test/y",{method:"PATCH"});}' }));
    assert.equal(requests(g).length, 2);
    assert.ok(requests(g).every(e => handler(g, e)?.name === 'other'));
});
test('Actix first resource method miss blocks a later GET resource and uses implicit 405', async () => {
    const source = app('App::new().service(web::resource("/x").route(web::post().to(handler))).service(web::resource("/x").route(web::get().to(other)))').replace('async fn handler(){}', 'async fn handler(){}async fn other(){}');
    const g = await index(await repo(source, actix, { 'client.ts': 'export async function load(){await fetch("https://api.test/x");}' }));
    assert.equal(requests(g).length, 1);
    assert.equal(requests(g)[0]!.metadata.status, 405);
    assert.equal(handler(g, requests(g)[0]!), undefined);
});
test('Actix App.route methods guard resources and let a later matching method run', async () => {
    const source = app('App::new().route("/x",web::post().to(handler)).route("/x",web::get().to(other))').replace('async fn handler(){}', 'async fn handler(){}async fn other(){}');
    const g = await index(await repo(source, actix, { 'client.ts': 'export async function load(){await fetch("https://api.test/x");await fetch("https://api.test/x",{method:"HEAD"});}' }));
    assert.equal(requests(g).length, 2);
    assert.ok(requests(g).some(e => handler(g, e)?.name === 'other'));
    assert.ok(requests(g).some(e => e.metadata.status === 404));
});
test('First Actix scope captures its prefix even without a matching child route', async () => {
    const source = app('App::new().service(web::scope("/api").route("/only",web::get().to(handler))).route("/api/other",web::get().to(other))').replace('async fn handler(){}', 'async fn handler(){}async fn other(){}');
    const g = await index(await repo(source, actix, { 'client.ts': 'export async function load(){await fetch("https://api.test/api/other");await fetch("https://api.test/api/only");}' }));
    assert.equal(requests(g).length, 2);
    assert.ok(requests(g).some(e => e.metadata.status === 404));
    assert.ok(requests(g).some(e => handler(g, e)?.name === 'handler'));
    assert.ok(!requests(g).some(e => handler(g, e)?.name === 'other'));
});
test('Actix custom resource/default handlers preserve route order and selected resource boundaries', async () => {
    const source = app('App::new().service(web::resource("/x").route(web::route().to(handler)).route(web::get().to(other)).default_service(web::to(other))).default_service(web::to(fallback))').replace('async fn handler(){}', 'async fn handler(){}async fn other(){}async fn fallback(){}');
    const g = await index(await repo(source, actix, { 'client.ts': 'export async function load(){await fetch("https://api.test/x");await fetch("https://api.test/missing");}' }));
    assert.deepEqual(requests(g).map(e => handler(g, e)?.name).sort(), ['fallback', 'handler']);
});
test('Unknown earlier Actix guards remain competitors and cannot grant a later route a confirmed match', async () => {
    const source = app('App::new().service(web::resource("/x").guard(custom()).route(web::get().to(handler))).route("/x",web::get().to(other))').replace('async fn handler(){}', 'async fn handler(){}async fn other(){}');
    const g = await index(await repo(source, actix, { 'client.ts': 'export async function load(){await fetch("https://api.test/x");}' }));
    assert.equal(requests(g).length, 0);
    assert.ok(g.diagnostics.some(d => d.code === 'ambiguous-http-match'));
});
test('Rust contracts, original callbacks and requests replay exactly through warm cache and revision indexing', async () => {
    const root = await repo(serve('Router::new().route("/x",get(handler))'), axum, { 'client.ts': 'export async function load(){await fetch("https://api.test/x");}' }), state = await mkdtemp(path.join(tmpdir(), 'codiluce-rust-router-cache-'));
    roots.push(state);
    const cold = await index(root, new AnalysisCache(state)), cache = new AnalysisCache(state), warm = await index(root, cache), revision = await index(root, undefined, selected, 'original-source-revision');
    assert.equal(shape(cold), shape(warm));
    assert.equal(shape(cold), shape(revision));
    assert.ok(cache.events.some(event => event.analyzer === 'rust-routers' && event.hit));
    assert.equal(requests(warm).length, 1);
    await put(root, 'src/main.rs', serve('Router::new().route("/changed",get(handler))'));
    const changedCache = new AnalysisCache(state), changed = await index(root, changedCache);
    assert.ok(changedCache.events.some(event => event.analyzer === 'rust-routers' && !event.hit));
    assert.equal(route(changed, '/changed').metadata.routePath, '/changed');
    assert.equal(requests(changed).filter(e => e.metadata.registration === 'explicit').length, 0);
});
test('Original source registration IDs survive whitespace and CRLF/emoji ranges remain exact', async () => {
    const root = await repo('// 😀\r\n' + serve('Router::new().route("/x",get(handler))'));
    const before = await index(root), first = route(before, '/x');
    assert.equal(first.sourceRange?.startLine, 2);
    await put(root, 'src/main.rs', '// 😀\r\n\r\n' + serve('Router::new().route("/x",get(handler))'));
    const second = route(await index(root), '/x');
    assert.equal(first.id, second.id);
    assert.equal(second.sourceRange?.startLine, 3);
    assert.equal(handler(before, first)?.name, 'handler');
});
test('Native route handlers retain direct original leaf call edges under reviewed attribute contexts', async () => {
    for (const [source, dependencies, url] of [[serve('Router::new().route("/x",get(handler))').replace('async fn handler(){}', 'fn leaf(){}async fn handler(){leaf();}'), axum, '/x'], [app('App::new().service(handler)').replace('async fn handler(){}', 'fn leaf(){}#[actix_web::get("/decorated")]async fn handler(){leaf();}'), actix, '/decorated']] as const) {
        const g = await index(await repo(source, dependencies)), callback = handler(g, route(g, url))!;
        assert.ok(g.relations.some(relation => relation.type === 'calls' && relation.from === callback.id && g.entities.find(entity => entity.id === relation.to)?.name === 'leaf' && relation.metadata?.adapter === 'rust-routers'));
    }
});
test('Axum nested fallback handlers override parent defaults at native root and nonempty tails', async () => {
    const source = serve('Router::new().nest("/api",Router::new().route("/known",get(handler)).fallback(child)).fallback(parent)').replace('async fn handler(){}', 'async fn handler(){}async fn child(){}async fn parent(){}');
    const g = await index(await repo(source, axum, { 'client.ts': 'export async function root(){await fetch("https://api.test/api");}export async function tail(){await fetch("https://api.test/api/missing");}export async function trailing(){await fetch("https://api.test/api/");}export async function outside(){await fetch("https://api.test/outside");}' }));
    assert.equal(requests(g).length, 4);
    assert.deepEqual(requests(g).map(e => handler(g, e)?.name).sort(), ['child', 'child', 'parent', 'parent']);
});
test('Actix scopes inherit App defaults and explicit scope defaults override them', async () => {
    const source = app('App::new().service(web::scope("/a").route("/known",web::get().to(handler))).service(web::scope("/b").default_service(web::to(child))).default_service(web::to(parent))').replace('async fn handler(){}', 'async fn handler(){}async fn child(){}async fn parent(){}');
    const g = await index(await repo(source, actix, { 'client.ts': 'export async function load(){await fetch("https://api.test/a/missing");await fetch("https://api.test/b/missing");}' }));
    assert.deepEqual(requests(g).map(e => handler(g, e)?.name).sort(), ['child', 'parent']);
});
test('Actix capture scopes retain native prefix guards and trailing-slash boundaries', async () => {
    const source = app('App::new().service(web::scope("/api/{tenant}").route("/known",web::get().to(handler))).service(web::scope("/strict/").default_service(web::to(child))).default_service(web::to(parent))').replace('async fn handler(){}', 'async fn handler(){}async fn child(){}async fn parent(){}');
    const g = await index(await repo(source, actix, { 'client.ts': 'export async function load(){await fetch("https://api.test/api/acme/missing");await fetch("https://api.test/strict/");await fetch("https://api.test/strict");}' }));
    assert.equal(requests(g).length, 3);
    assert.deepEqual(requests(g).map(e => handler(g, e)?.name).sort(), ['child', 'parent', 'parent']);
});
test('Original handler files, method ordinals and helpers keep their IDs after preceding whitespace', async () => {
    const original = serve('factory()').replace('async fn handler(){}', 'mod routes;use routes::factory;async fn handler(){}'), files = { 'src/routes.rs': 'use axum::{Router,routing::get};use crate::handler;pub fn factory()->Router{Router::new().route("/x",get(handler))}' };
    const root = await repo(original, axum, files), first = route(await index(root), '/x');
    await put(root, 'src/main.rs', '\n\n' + original);
    await put(root, 'src/routes.rs', '// 😀\r\n' + files['src/routes.rs']);
    const second = route(await index(root), '/x');
    assert.equal(first.id, second.id);
    assert.equal(second.path, 'src/routes.rs');
    assert.equal(second.sourceRange?.startLine, 2);
});
test('Handler source denial, Cargo version and selected bin changes invalidate framework replay', async () => {
    const source = serve('Router::new().route("/x",get(handlers::handler))').replace('async fn handler(){}', 'mod handlers;'), root = await repo(source, axum, { 'src/handlers.rs': 'pub async fn handler(){}', 'src/bin/admin.rs': serve('Router::new().route("/admin",get(handler))') }), state = await mkdtemp(path.join(tmpdir(), 'codiluce-rust-router-inputs-'));
    roots.push(state);
    const profile = { ...selected, target: { kind: 'bin' as const, name: 'api' } };
    const first = await index(root, new AnalysisCache(state), profile);
    assert.ok(route(first, '/x'));
    assert.ok(!declared(first).some(e => e.metadata.routePath === '/admin'));
    const cache = new AnalysisCache(state), admin = await index(root, cache, { ...selected, target: { kind: 'bin', name: 'admin' } });
    assert.ok(route(admin, '/admin'));
    assert.ok(cache.events.some(event => event.analyzer === 'rust-routers' && !event.hit));
    const denied = await indexRepository(root, { config: await resolveConfig(root, { applications: [{ name: 'api', path: '.', rust: profile }], ignore: ['src/handlers.rs'] }), cache: new AnalysisCache(state) });
    assert.equal(handler(denied, route(denied, '/x')), undefined);
    assert.ok(route(denied, '/x').metadata.constraintsUnresolved);
    await put(root, 'Cargo.toml', '[package]\nname="api"\nversion="1.0.0"\nedition="2021"\n[dependencies]\n' + axum.replace('0.8.9', '0.7.9'));
    const versionCache = new AnalysisCache(state), version = await index(root, versionCache, profile);
    assert.equal((route(version, '/x').metadata.routing as any).pattern.dialect, 'axum-0.7');
    assert.ok(versionCache.events.some(event => event.analyzer === 'rust-routers' && !event.hit));
});
test('Selected cfg_attr native service macros preserve declaration and serving proof', async () => {
    const source = app('App::new().service(handler)').replace('async fn handler(){}', '#[cfg_attr(feature="web", actix_web::get("/x"))]async fn handler(){}'), root = await repo(source, actix + '\n[features]\nweb=[]');
    assert.ok(!route(await index(root, undefined, { features: ['web'], defaultFeatures: false }), '/x').metadata.constraintsUnresolved);
    assert.equal(declared(await index(root)).length, 0);
});
test('Runtime attribute feature selection and opaque macro bodies preserve uncertainty', async () => {
    const source = serve('Router::new().route("/x",get(handler))');
    const disabled = await index(await repo(source, axum.replace('features=["full"]', 'features=["net","rt"]')));
    assert.ok(declared(disabled).every(e => e.metadata.constraintsUnresolved));
    const macro = await index(await repo(source.replace('let app=', 'custom!();let app=')));
    assert.ok(route(macro, '/x').metadata.constraintsUnresolved);
    assert.equal(handler(macro, route(macro, '/x')), undefined);
});
test('Actix literal constraints avoid target regex execution and Unicode digit semantics stay explicit', () => {
    assert.equal(compileRustPath('/{id:\\d+}', 'actix-web-4').status, 'partial');
    assert.ok(matchRustPath(compileRustPath('/{tail:.*}', 'actix-web-4'), '/a%0Db'));
    assert.ok(!matchRustPath(compileRustPath('/{tail:.*}', 'actix-web-4'), '/a%0Ab'));
    assert.equal(compileRustPath('/' + 'a'.repeat(5000), 'axum-0.8').status, 'partial');
});
test('Literal canonical log messages and Actix default Logger preserve native routing with original proof', async () => {
    const source = app('App::new().wrap(actix_web::middleware::Logger::default()).route("/x",web::get().to(handler))').replace('HttpServer::new', 'log::info!("starting server");HttpServer::new'), g = await index(await repo(source, actix + '\nlog="0.4.34"'));
    assert.ok(!route(g, '/x').metadata.constraintsUnresolved);
    assert.ok(route(g, '/x').evidence.some(fact => fact.explanation?.includes('literal log 0.4')));
    assert.ok(route(g, '/x').evidence.some(fact => fact.explanation?.includes('routing-neutral')));
});
test('Log format operands, custom clauses, lookalikes and NormalizePath middleware retain native gaps', async () => {
    for (const message of ['log::info!("{}",opaque());', 'log::info!(target:"custom","message");', 'lookalike::info!("message");']) {
        const source = app('App::new().route("/x",web::get().to(handler))').replace('HttpServer::new', message + 'HttpServer::new'), g = await index(await repo(source, actix + '\nlog="0.4.34"'));
        assert.ok(declared(g).every(endpoint => endpoint.metadata.constraintsUnresolved));
        assert.ok(g.diagnostics.some(diagnostic => diagnostic.reason.includes('macro invocation')));
    }
    const g = await index(await repo(app('App::new().wrap(actix_web::middleware::NormalizePath::default()).route("/x",web::get().to(handler))'), actix));
    assert.ok(route(g, '/x').metadata.constraintsUnresolved);
});
test('Empty Actix resource paths match the scope itself and keep an explicit slash separate', async () => {
    const source = app('App::new().service(web::scope("/api").service(web::resource("").route(web::get().to(handler))).service(web::resource("/").route(web::get().to(other))))').replace('async fn handler(){}', 'async fn handler(){}async fn other(){}'), g = await index(await repo(source, actix, { 'client.ts': 'export async function root(){await fetch("https://api.test/api");}export async function slash(){await fetch("https://api.test/api/");}' }));
    assert.deepEqual(requests(g).map(endpoint => handler(g, endpoint)?.name).sort(), ['handler', 'other']);
});
test('Wide Rust backend defaults cannot compete with a local frontend API without a recorded boundary', async () => {
    const root = await repo(serve('Router::new()'), axum, { 'web/package.json': '{"dependencies":{"next":"^16.3.0"}}', 'web/app/api/local/route.ts': 'export async function GET(){return Response.json({ok:true})}', 'web/client.ts': 'export async function local(){await fetch("/api/local");}' }), g = await indexRepository(root, { config: await resolveConfig(root, { applications: [{ name: 'api', path: '.', rust: selected }, { name: 'web', path: 'web', frameworks: ['nextjs'] }] }) });
    assert.equal(requests(g).length, 1);
    assert.equal(requests(g)[0]!.metadata.framework, 'nextjs');
});
test('Competing native attributes, invalid runtime options and uppercase lookalike route macros cannot qualify', async () => {
    for (const attr of ['#[tokio::main(flavor="current_thread",worker_threads=2)]', '#[tokio::main(flavor="current_thread",flavor="multi_thread")]']) {
        const g = await index(await repo(serve('Router::new().route("/x",get(handler))').replace('#[tokio::main]', attr)));
        assert.ok(declared(g).every(endpoint => endpoint.metadata.constraintsUnresolved));
    }
    for (const attr of ['#[actix_web::Get("/x")]', '#[actix_web::get("/x")]#[actix_web::post("/y")]']) {
        const g = await index(await repo(app('App::new().service(handler)').replace('async fn handler(){}', attr + 'async fn handler(){}'), actix));
        assert.ok(declared(g).every(endpoint => endpoint.metadata.constraintsUnresolved));
    }
});
test('Explicit generic framework operands keep native Handler instantiation uncertainty', async () => {
    const g = await index(await repo(serve('Router::new().route("/x",get::<Opaque,_>(handler))')));
    assert.ok(route(g, '/x').metadata.constraintsUnresolved);
    assert.ok((route(g, '/x').metadata.constraints as string[]).some(condition => condition.includes('instantiation')));
});
test('Unreviewed multi-capture segments cannot enter a backtracking regex and holed Actix paths retain brace restrictions', () => {
    assert.equal(compileRustPath('/{a}-{b}-{c}-{d}', 'actix-web-4').status, 'partial');
    assert.ok(!matchRustPath(compileRustPath('/{first}/{second}', 'actix-web-4'), '/{*}/{literal}'));
});
