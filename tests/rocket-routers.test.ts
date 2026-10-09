import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { indexRepository } from '../src/pipeline/index.js';
import { resolveConfig, type RustConfig } from '../src/core/config.js';
import { AnalysisCache } from '../src/pipeline/cache.js';
import { canonicalJson } from '../src/history/fingerprint.js';
import { compileRocketPath, matchRocketPath, matchRocketQuery, rocketPathsCollide, reviewedRocketMount } from '../src/analysis/routes/rocket-patterns.js';
import { routingContract } from '../src/analysis/routes/contracts.js';
import { fileAnalysis } from '../src/analysis/facts.js';
import type { SoftwareGraph, Entity } from '../src/core/graph.js';
import { StructureParser } from '../src/analysis/tree-sitter/client.js';
const roots: string[] = [];
after(async () => { await Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))); });
async function put(root: string, file: string, text: string) { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), text); }
const selected: RustConfig = { features: [], defaultFeatures: false };
async function repo(source: string, dependencies = 'rocket="0.5.1"', files: Record<string, string> = {}) {
    const root = await mkdtemp(path.join(tmpdir(), 'codiluce-rocket-'));
    roots.push(root);
    for (const [file, text] of Object.entries({ 'Cargo.toml': '[package]\nname="api"\nversion="1.0.0"\nedition="2021"\n[dependencies]\n' + dependencies, 'src/main.rs': source, ...files }))
        await put(root, file, text);
    return root;
}
async function index(root: string, cache?: AnalysisCache, rust = selected, revision?: string) { return indexRepository(root, { config: await resolveConfig(root, { applications: [{ name: 'api', path: '.', apiOrigins: ['https://api.test'], rust }] }), cache, revision }); }
const endpoints = (graph: SoftwareGraph) => graph.entities.filter(entity => entity.type === 'api_endpoint' && entity.metadata.framework === 'rocket');
const contract = (entity: Entity) => routingContract(entity.metadata.routing)!;
const handler = (graph: SoftwareGraph, endpoint: Entity) => graph.entities.find(entity => graph.relations.some(relation => relation.type === 'handles' && relation.from === endpoint.id && relation.to === entity.id));
const requests = (graph: SoftwareGraph) => graph.relations.filter(relation => relation.type === 'requests').map(relation => graph.entities.find(entity => entity.id === relation.to)!);
const requestedHandler = (graph: SoftwareGraph, caller: string) => { const source = graph.entities.find(entity => entity.type === 'function' && entity.name === caller && entity.path === 'client.ts')!, relation = graph.relations.find(relation => relation.type === 'requests' && relation.from === source.id); return relation && handler(graph, graph.entities.find(entity => entity.id === relation.to)!)?.name; };
const shape = (graph: SoftwareGraph) => canonicalJson({ entities: graph.entities, relations: graph.relations, diagnostics: graph.diagnostics.filter(d => !['git-metrics', 'indexer'].includes(d.analyzer) && d.code !== 'git-ignore-unavailable') });
const launch = (handlers: string, list = 'handler', prefix = '/api') => `${handlers}#[rocket::launch]fn application()->_ {rocket::build().mount("${prefix}",rocket::routes![${list}])}`;
const original = 'fn leaf(){}#[rocket::get("/hello")]fn handler()->&\'static str{leaf();"hello"}';
test('Rocket native paths normalize empty segments and decode each request segment after splitting', () => {
    const pattern = compileRocketPath('/hello/<name>', { name: 'str' });
    assert.equal(pattern.status, 'exact');
    for (const input of ['/hello/name', '//hello///name/', '/hello/a%2Fb', '/hello/%EF%BF%BD'])
        assert.ok(matchRocketPath(pattern, input), input);
    assert.ok(!matchRocketPath(pattern, '/Hello/name'));
    assert.ok(!matchRocketPath(pattern, '/hello'));
    assert.ok(!matchRocketPath(pattern, '/hello/a/b'));
    assert.ok(matchRocketPath(compileRocketPath('/hello/мир'), '/hello/%D0%BC%D0%B8%D1%80'));
    assert.ok(!matchRocketPath(compileRocketPath('/hello/%20'), '/hello/%20'));
    assert.ok(matchRocketPath(compileRocketPath('/hello/+'), '/hello/+'));
});
test('Rocket trailing captures permit zero segments and malformed or duplicate syntax stays partial', () => {
    const pattern = compileRocketPath('/files/<_..>');
    for (const input of ['/files', '/files/', '/files/a/b', '/files///'])
        assert.ok(matchRocketPath(pattern, input));
    for (const input of ['/files/<tail..>/after', '/x/<a>/<a>', '/x/prefix<a>', 'relative', '/x#fragment'])
        assert.equal(compileRocketPath(input).status, 'partial');
    assert.equal(compileRocketPath('/<_>/<_>').status, 'exact');
    assert.ok(rocketPathsCollide(compileRocketPath('/a/<_>'), compileRocketPath('/<_>/b')));
});
test('Rocket default ranking uses native path/query colors and literal duplicate query fields', () => {
    const profiles = [['/static?x=1', -12], ['/static?x=1&<q>', -11], ['/static?<q>', -10], ['/static', -9], ['/a/<x>?x=1', -8], ['/a/<x>?x=1&<q>', -7], ['/a/<x>?<q>', -6], ['/a/<x>', -5], ['/<x>?x=1', -4], ['/<x>?x=1&<q>', -3], ['/<x>?<q>', -2], ['/<x>', -1]] as const;
    for (const [uri, rank] of profiles)
        assert.equal(compileRocketPath(uri).rocket!.defaultRank, rank, uri);
    const pattern = compileRocketPath('/x?q=ok&flag');
    assert.ok(matchRocketQuery(pattern, new URLSearchParams('q=no&q=ok&flag')));
    assert.ok(!matchRocketQuery(pattern, new URLSearchParams('q=no&flag')));
});
test('Rocket reviewed fixed-width integers and bool preserve FromStr bounds and holed requests', () => {
    const pattern = compileRocketPath('/number/<id>/<flag>', { id: 'u8', flag: 'bool' });
    for (const value of ['0', '+1', '0002', '255'])
        assert.ok(matchRocketPath(pattern, `/number/${value}/true`));
    for (const value of ['256', '-0', '-1', '1.2', '1e2', ' 1', '1%0A', '1%20'])
        assert.ok(!matchRocketPath(pattern, `/number/${value}/true`));
    assert.ok(!matchRocketPath(pattern, '/number/1/TRUE'));
    assert.ok(!matchRocketPath(pattern, '/number/{*}/true'));
    assert.ok(matchRocketPath(pattern, '/number/{*}/true', false));
});
test('Original Rocket launch, attributes, routes! and mounts retain handlers, Cargo and source leaf proof', async () => {
    const graph = await index(await repo(launch(original)));
    assert.equal(endpoints(graph).length, 1);
    const endpoint = endpoints(graph)[0]!;
    assert.equal(endpoint.name, 'GET|HEAD /api/hello');
    assert.ok(!endpoint.metadata.constraintsUnresolved);
    assert.equal(handler(graph, endpoint)?.name, 'handler');
    assert.ok(endpoint.evidence.some(fact => fact.file === 'Cargo.toml'));
    assert.ok(contract(endpoint).mounts.length);
    assert.ok(endpoint.evidence.some(fact => fact.explanation?.includes('launch attribute')));
    const calls = graph.relations.filter(relation => relation.type === 'calls' && relation.from === handler(graph, endpoint)!.id && relation.metadata?.adapter === 'rust-routers');
    assert.equal(calls.length, 1);
    assert.equal(graph.entities.find(entity => entity.id === calls[0]!.to)?.name, 'leaf');
    const source = graph.entities.find(entity => entity.type === 'file' && entity.path === 'src/main.rs')!;
    assert.ok(Array.isArray(source.metadata.frameworkPacks) && source.metadata.frameworkPacks.includes('rocket'));
    assert.equal(fileAnalysis(source.metadata.analysis)!.features.framework.status, 'partial');
});
test('Rocket bare macro_use and imported/renamed native macro identities bind original handlers', async () => {
    for (const source of ['#[macro_use]extern crate rocket;#[get("/hello")]fn handler()->&\'static str{"ok"}#[launch]fn application()->_ {rocket::build().mount("/api",routes![handler])}', 'use web::{get as route,routes as list,launch as entry};#[route("/hello")]fn handler()->&\'static str{"ok"}#[entry]fn application()->_ {web::build().mount("/api",list![handler])}']) {
        const graph = await index(await repo(source, source.includes('web::') ? 'web={package="rocket",version="0.5.1"}' : 'rocket="0.5.1"'));
        assert.equal(endpoints(graph).length, 1);
        assert.ok(!endpoints(graph)[0]!.metadata.constraintsUnresolved);
        assert.equal(handler(graph, endpoints(graph)[0]!)?.name, 'handler');
    }
});
test('Bare lookalike Rocket macros, local macros and unreviewed registry/version identities cannot certify routes', async () => {
    for (const [source, dependencies] of [
        [launch('fn handler()->&\'static str{"ok"}'), 'rocket="0.5.1"'],
        [launch(original), 'rocket=">=0.4,<0.6"'],
        [launch(original), 'rocket={package="other",version="0.5.1"}'],
        [launch(original, 'handler').replace('rocket::routes!', 'routes!'), 'rocket="0.5.1"'],
        [launch('macro_rules! routes{($x:ident)=>{[]}}' + original).replace('rocket::routes!', 'routes!'), 'rocket="0.5.1"'],
    ] as const) {
        const graph = await index(await repo(source, dependencies));
        assert.ok(endpoints(graph).every(endpoint => endpoint.metadata.constraintsUnresolved));
        assert.equal(requests(graph).length, 0);
    }
});
test('Unlaunched and unawaited Rocket builders cannot expose source routes', async () => {
    for (const main of ['fn main(){let app=rocket::build().mount("/api",rocket::routes![handler]);}', '#[rocket::main]async fn main(){let future=rocket::build().mount("/api",rocket::routes![handler]).launch();}'])
        assert.equal(endpoints(await index(await repo(original + main))).length, 0);
});
test('Rocket main, stored launch futures and explicit ignition success paths retain source reachability', async () => {
    for (const body of ['let app=rocket::build().mount("/api",rocket::routes![handler]);let future=app.launch();future.await.unwrap();', 'rocket::build().mount("/api",rocket::routes![handler]).ignite().await.unwrap().launch().await.unwrap();']) {
        const graph = await index(await repo(original + '#[rocket::main]async fn main(){' + body + '}'));
        assert.equal(endpoints(graph).length, 1);
        assert.ok(!endpoints(graph)[0]!.metadata.constraintsUnresolved);
    }
});
test('Source factories, original module route lists, multiple mount points and async launch preserve identities', async () => {
    const source = 'mod handlers;fn factory()->rocket::Rocket<rocket::Build>{rocket::build().mount("/first",rocket::routes![handlers::first])}#[rocket::launch]async fn application()->_ {factory().mount("/second",rocket::routes![handlers::first])}';
    const graph = await index(await repo(source, 'rocket="0.5.1"', { 'src/handlers.rs': '#[rocket::get("/hello")]pub fn first()->&\'static str{"ok"}' }));
    assert.deepEqual(endpoints(graph).map(endpoint => endpoint.metadata.routePath).sort(), ['/first/hello', '/second/hello']);
    assert.ok(endpoints(graph).every(endpoint => !endpoint.metadata.constraintsUnresolved));
    assert.equal(handler(graph, endpoints(graph)[0]!)?.id, handler(graph, endpoints(graph)[1]!)?.id);
});
test('Known generic route attributes retain literal HTTP methods and native rank metadata', async () => {
    const source = launch('#[rocket::route(POST,uri="/hello",rank=2)]fn handler()->&\'static str{"ok"}');
    const graph = await index(await repo(source));
    assert.equal(endpoints(graph)[0]!.name, 'POST /api/hello');
    assert.equal(contract(endpoints(graph)[0]!).rust!.rank, 2);
    assert.ok(!endpoints(graph)[0]!.metadata.constraintsUnresolved);
});
test('Native integer guards and manual ranks choose the first successful original source handler', async () => {
    const source = launch('#[rocket::get("/users/<id>",rank=1)]fn number(id:u8)->&\'static str{"number"}#[rocket::get("/users/<id>",rank=2)]fn text(id:&str)->&\'static str{"text"}', 'number,text');
    const graph = await index(await repo(source, 'rocket="0.5.1"', { 'client.ts': 'export function one(){fetch("https://api.test/api/users/42")}export function two(){fetch("https://api.test/api/users/256")}' }));
    assert.deepEqual([requestedHandler(graph, 'one'), requestedHandler(graph, 'two')], ['number', 'text']);
});
test('Native default ranks use unmounted wild paths and explicit HEAD takes precedence over GET fallback', async () => {
    const source = launch('#[rocket::get("/<_..>")]fn fallback()->&\'static str{"fallback"}#[rocket::get("/hello")]fn handler()->&\'static str{"get"}#[rocket::head("/hello",rank=20)]fn head()->&\'static str{"head"}', 'fallback,handler,head');
    const graph = await index(await repo(source, 'rocket="0.5.1"', { 'client.ts': 'export function get(){fetch("https://api.test/api/hello")}export function head(){fetch("https://api.test/api/hello",{method:"HEAD"})}' }));
    assert.equal(contract(endpoints(graph).find(endpoint => endpoint.metadata.routePath === '/api/<_..>')!).rust!.rank, -1);
    assert.deepEqual([requestedHandler(graph, 'get'), requestedHandler(graph, 'head')], ['handler', 'head']);
});
test('Static query predicates keep native any-duplicate matching and default query ranks', async () => {
    const source = launch('#[rocket::get("/hello?q=ok")]fn query()->&\'static str{"query"}#[rocket::get("/hello")]fn basic()->&\'static str{"basic"}', 'query,basic');
    const graph = await index(await repo(source, 'rocket="0.5.1"', { 'client.ts': 'export function one(){fetch("https://api.test/api/hello?q=no&q=ok")}export function two(){fetch("https://api.test/api/hello?q=no")}' }));
    assert.deepEqual([requestedHandler(graph, 'one'), requestedHandler(graph, 'two')], ['query', 'basic']);
});
test('Overlapping same-rank routes fail ignition independently of static queries and guard conversion', async () => {
    for (const handlers of ['#[rocket::get("/hello?x=1")]fn a()->&\'static str{"a"}#[rocket::get("/hello?x=2")]fn b()->&\'static str{"b"}', '#[rocket::get("/<x>")]fn a(x:u8)->&\'static str{"a"}#[rocket::get("/<x>")]fn b(x:&str)->&\'static str{"b"}']) {
        const graph = await index(await repo(launch(handlers, 'a,b')));
        assert.equal(endpoints(graph).length, 2);
        assert.ok(endpoints(graph).every(endpoint => contract(endpoint).conditions.some((condition: string) => condition.includes('fail ignition'))));
    }
});
test('Unknown guards and fairings cannot let a later ranked handler win a request', async () => {
    const source = launch('struct Key;#[rocket::get("/hello",rank=1)]fn secured(key:Key)->&\'static str{"yes"}#[rocket::get("/hello",rank=2)]fn handler()->&\'static str{"fallback"}', 'secured,handler');
    const graph = await index(await repo(source, 'rocket="0.5.1"', { 'client.ts': 'export function one(){fetch("https://api.test/api/hello")}' }));
    assert.equal(requests(graph).length, 0);
    assert.ok(endpoints(graph).find(endpoint => handler(graph, endpoint)?.name === 'secured')!.metadata.constraintsUnresolved);
    const fair = await index(await repo(launch(original).replace('rocket::build()', 'rocket::build().attach(custom())')));
    assert.ok(endpoints(fair).every(endpoint => endpoint.metadata.constraintsUnresolved));
});
test('Dynamic query/data/format and custom parameter traits remain original constrained candidates', async () => {
    for (const handler of ['#[rocket::get("/hello?<name>")]fn handler(name:String)->&\'static str{"ok"}', '#[rocket::post("/hello",data="<data>",format="json")]fn handler(data:String)->&\'static str{"ok"}', '#[rocket::get("/<path..>")]fn handler(path:std::path::PathBuf)->&\'static str{"ok"}', 'struct String;#[rocket::get("/<name>")]fn handler(name:String)->&\'static str{"ok"}']) {
        const graph = await index(await repo(launch(handler)));
        assert.equal(endpoints(graph).length, 1);
        assert.ok(endpoints(graph)[0]!.metadata.constraintsUnresolved);
    }
});
test('Conditional setup, invalid mount prefixes and native attributes preserve visible gaps', async () => {
    for (const source of [launch(original, 'handler', '/<prefix>'), launch(original).replace('rocket::build().mount', 'if flag(){rocket::build().mount').replace('])}', '])}else{rocket::build()}}'), launch(original.replace('"/hello"', '"/hello",unknown=true')), launch(original).replace('routes![handler]', 'routes![handler::<u8>]')]) {
        const graph = await index(await repo(source));
        assert.ok(endpoints(graph).every(endpoint => endpoint.metadata.constraintsUnresolved));
        assert.equal(requests(graph).length, 0);
    }
});
test('Competing launch/main items and malformed entry signatures cannot certify serving', async () => {
    for (const source of [launch(original) + 'fn main(){}', launch(original) + '#[rocket::launch]fn another()->_ {rocket::build()}', launch(original).replace('fn application()->_', 'fn application(arg:u8)->_'), launch(original).replace('#[rocket::launch]', '#[rocket::launch]#[rocket::main]')]) {
        const graph = await index(await repo(source));
        assert.ok(endpoints(graph).every(endpoint => endpoint.metadata.constraintsUnresolved));
    }
});
test('Original route/macro operand CRLF and emoji ranges remain exact and IDs survive preceding source shifts', async () => {
    const source = '// 😀 original\r\n#[rocket::get("/hello")]\r\nfn handler()->&\'static str{"ok"}\r\n#[rocket::launch]\r\nfn application()->_ {rocket::build().mount("/api",rocket::routes![handler])}\r\n', root = await repo(source), cold = await index(root);
    assert.equal(endpoints(cold)[0]!.sourceRange!.startLine, 3);
    assert.equal(handler(cold, endpoints(cold)[0]!)!.sourceRange!.startLine, 3);
    await put(root, 'src/main.rs', '\n' + source);
    const changed = await index(root);
    assert.equal(endpoints(changed)[0]!.id, endpoints(cold)[0]!.id);
    assert.equal(handler(changed, endpoints(changed)[0]!)!.id, handler(cold, endpoints(cold)[0]!)!.id);
    assert.equal(endpoints(changed)[0]!.sourceRange!.startLine, 4);
});
test('Rocket contract, source calls, requests and diagnostics replay through actual warm cache and revisions', async () => {
    const root = await repo(launch(original), 'rocket="0.5.1"', { 'client.ts': 'export function one(){fetch("https://api.test/api/hello")}' }), state = await mkdtemp(path.join(tmpdir(), 'codiluce-rocket-cache-'));
    roots.push(state);
    const cold = await index(root, new AnalysisCache(state)), cache = new AnalysisCache(state), warm = await index(root, cache), revision = await index(root, undefined, selected, 'a'.repeat(40));
    assert.equal(shape(cold), shape(warm));
    assert.equal(shape(cold), shape(revision));
    assert.ok(cache.events.some(event => event.analyzer === 'rust-routers' && event.hit));
    assert.equal(requests(cold).length, 1);
    await put(root, 'src/main.rs', launch(original.replace('/hello', '/changed')));
    const changed = await index(root, new AnalysisCache(state));
    assert.equal(endpoints(changed)[0]!.metadata.routePath, '/api/changed');
    assert.equal(requests(changed).length, 0);
});
test('Original literal routes! operands have exact Unicode/CRLF paths and ranges without macro expansion', async () => {
    const parser = new StructureParser();
    try {
        const source = '// 😀\r\nfn main(){let list=rocket::routes![ first, module :: r#type, \nпривет, ];}', facts = await parser.parse('rust', source), macro = facts.rust!.macros![0]!;
        assert.deepEqual(macro.operands!.map(operand => source.slice(operand.start, operand.end)), ['first', 'module :: r#type', 'привет']);
        assert.deepEqual(macro.operands!.map(operand => operand.segments), [['first'], ['module', 'type'], ['привет']]);
        assert.deepEqual(macro.operands!.map(operand => operand.range.startLine), [2, 2, 3]);
        assert.ok(facts.rust!.semantic!.bindings.some(binding => binding.value?.kind === 'macro'));
        assert.ok(facts.rust!.scopes.some(scope => scope.gaps.some(gap => gap.includes('expansion is unavailable'))), 'general Rust keeps macro gaps');
        for (const operands of ['r # type', 'first,,second', 'first::<u8>', 'first()', 'make!()', 'first;second'])
            assert.equal((await parser.parse('rust', `fn main(){rocket::routes![${operands}];}`)).rust!.macros![0]!.operands, undefined, operands);
    }
    finally {
        parser.close();
    }
});
test('Native guard contracts reject unsupported reference adjustment and foreign String bindings', async () => {
    for (const type of ['&u8', '&String', '&mut str', 'Custom', 'usize', 'f64']) {
        const graph = await index(await repo(launch(`struct Custom;#[rocket::get("/<id>")]fn handler(id:${type})->&'static str{"ok"}`)));
        assert.equal(endpoints(graph).length, 1);
        assert.ok(endpoints(graph)[0]!.metadata.constraintsUnresolved, type);
    }
    const graph = await index(await repo(launch('use other::String;#[rocket::get("/<id>")]fn handler(id:String)->&\'static str{"ok"}'), 'rocket="0.5.1"\nother="1.0"'));
    assert.ok(endpoints(graph)[0]!.metadata.constraintsUnresolved);
});
test('Original no_std/no_implicit_prelude contexts do not borrow String parameter guards', async () => {
    for (const attribute of ['#![no_std]', '#![no_implicit_prelude]']) {
        const graph = await index(await repo(attribute + launch('#[rocket::get("/<id>")]fn handler(id:String)->&\'static str{"ok"}')));
        assert.ok(endpoints(graph).every(endpoint => endpoint.metadata.constraintsUnresolved));
    }
});
test('Selected cfg_attr Rocket macros and closed feature selections preserve source registration', async () => {
    const source = '#[cfg_attr(feature="native",rocket::get("/hello"))]fn handler()->&\'static str{"ok"}#[cfg_attr(feature="native",rocket::launch)]fn application()->_ {rocket::build().mount("/api",rocket::routes![handler])}', root = await repo(source);
    await put(root, 'Cargo.toml', '[package]\nname="api"\nversion="1.0.0"\nedition="2021"\n[dependencies]\nrocket="0.5.1"\n[features]\nnative=[]\n');
    const graph = await index(root, undefined, { features: ['native'], defaultFeatures: false });
    assert.equal(endpoints(graph).length, 1);
    assert.ok(!endpoints(graph)[0]!.metadata.constraintsUnresolved);
    assert.equal(endpoints(await index(root)).length, 0);
});
test('Literal mount queries are cleared and mount normalization does not change unmounted default ranks', async () => {
    const graph = await index(await repo(launch('#[rocket::get("/<_..>")]fn handler()->&\'static str{"ok"}', 'handler', '//api///?ignored=1')));
    assert.equal(endpoints(graph)[0]!.metadata.routePath, '/api/<_..>');
    assert.equal(contract(endpoints(graph)[0]!).rust!.rank, -1);
    assert.ok(!endpoints(graph)[0]!.metadata.constraintsUnresolved);
});
test('Signed and 128-bit guard bounds remain exact beyond JavaScript safe integers', () => {
    for (const [type, accepted, rejected] of [['i8', '-128', '-129'], ['i8', '+127', '128'], ['u64', '18446744073709551615', '18446744073709551616'], ['i128', '170141183460469231731687303715884105727', '170141183460469231731687303715884105728']] as const) {
        const pattern = compileRocketPath('/<id>', { id: type });
        assert.ok(matchRocketPath(pattern, '/' + accepted));
        assert.ok(!matchRocketPath(pattern, '/' + rejected));
    }
});
test('Late unreviewed builder escapes constrain previously constructed Rocket serving snapshots', async () => {
    const source = original + '#[rocket::main]async fn main(){let app=rocket::build().mount("/api",rocket::routes![handler]);let future=app.launch();unknown(app);future.await.unwrap();}';
    const graph = await index(await repo(source));
    assert.equal(endpoints(graph).length, 1);
    assert.ok(endpoints(graph)[0]!.metadata.constraintsUnresolved);
});
test('Rocket feature/version/source edits and handler denial invalidate native cached registrations', async () => {
    const root = await repo('mod handlers;#[rocket::launch]fn application()->_ {rocket::build().mount("/api",rocket::routes![handlers::handler])}', 'rocket="0.5.1"', { 'src/handlers.rs': '#[rocket::get("/hello")]pub fn handler()->&\'static str{"ok"}' }), state = await mkdtemp(path.join(tmpdir(), 'codiluce-rocket-invalid-cache-'));
    roots.push(state);
    const cold = await index(root, new AnalysisCache(state));
    assert.ok(!endpoints(cold)[0]!.metadata.constraintsUnresolved);
    const denied = await indexRepository(root, { config: await resolveConfig(root, { applications: [{ name: 'api', path: '.', rust: selected }], ignore: ['src/handlers.rs'] }), cache: new AnalysisCache(state) });
    assert.ok(endpoints(denied).every(endpoint => endpoint.metadata.constraintsUnresolved));
    await put(root, 'Cargo.toml', '[package]\nname="api"\nversion="1.0.0"\nedition="2021"\n[dependencies]\nrocket="0.4.11"');
    const cache = new AnalysisCache(state), older = await index(root, cache);
    assert.equal(endpoints(older).length, 0);
    assert.ok(cache.events.some(event => event.analyzer === 'rust-routers' && !event.hit));
});
test('Native mount Origin parsing stays distinct from Unicode route parsing', async () => {
    for (const prefix of ['/мир', '/hello world', '/<prefix>', '/api#fragment', '/api?query=мир']) {
        assert.ok(!reviewedRocketMount(prefix));
        const graph = await index(await repo(launch(original, 'handler', prefix)));
        assert.ok(endpoints(graph).every(endpoint => endpoint.metadata.constraintsUnresolved));
    }
    for (const prefix of ['/api', '/api/%20', '//api///', '/api?flag=1&x=%20'])
        assert.ok(reviewedRocketMount(prefix));
    assert.ok(matchRocketPath(compileRocketPath('/hello world'), '/hello%20world'));
});
test('Selective macro_use names activate only exact exported names and invalid clauses retain gaps', async () => {
    const source = '#[macro_use(get,routes,launch)]extern crate rocket;#[get("/hello")]fn handler()->&\'static str{"ok"}#[launch]fn application()->_ {rocket::build().mount("/api",routes![handler])}';
    const positive = await index(await repo(source));
    assert.equal(endpoints(positive).length, 1);
    assert.ok(!endpoints(positive)[0]!.metadata.constraintsUnresolved);
    for (const clause of ['get(),routes,launch', 'get,get,routes,launch', 'unknown,get,routes,launch']) {
        const graph = await index(await repo(source.replace('get,routes,launch', clause)));
        assert.ok(endpoints(graph).every(endpoint => endpoint.metadata.constraintsUnresolved));
    }
});
test('Literal source lists preserve comments while expression-only macros cannot neutralize item scopes', async () => {
    const source = launch(original, '/* 😀 comment */handler, // original callback\n');
    const graph = await index(await repo(source));
    assert.equal(endpoints(graph).length, 1);
    assert.ok(!endpoints(graph)[0]!.metadata.constraintsUnresolved);
    for (const macro of ['rocket::routes![handler];', 'log::info!("literal");']) {
        const graph = await index(await repo(macro + launch(original), 'rocket="0.5.1"\nlog="0.4.34"'));
        assert.ok(endpoints(graph).every(endpoint => endpoint.metadata.constraintsUnresolved));
    }
});
test('Absolute native macro paths bypass source shadows and cannot borrow a relative use alias', async () => {
    const source = 'mod rocket{}#[::rocket::get("/hello")]fn handler()->&\'static str{"ok"}#[::rocket::launch]fn application()->_ {::rocket::build().mount("/api",::rocket::routes![handler])}', positive = await index(await repo(source));
    assert.equal(endpoints(positive).length, 1);
    assert.ok(!endpoints(positive)[0]!.metadata.constraintsUnresolved);
    const negative = await index(await repo('use rocket as web;' + launch(original).replace('rocket::routes!', '::web::routes!')));
    assert.ok(endpoints(negative).every(endpoint => endpoint.metadata.constraintsUnresolved));
});
