// Portable ordinary compiled qualification; target Kotlin/Gradle/plugins never execute.
import assert from 'node:assert/strict';
import { after, test as registerTest } from 'node:test';
const completedCases = [];
function test(name, execute) { return registerTest(name, async () => { await execute(); completedCases.push(name); }); }
const sourceRoot = new URL(process.argv[2]);
assert.equal(sourceRoot.protocol, 'file:');
assert.ok(sourceRoot.pathname.endsWith('/'));
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const { indexRepository } = await import(new URL('pipeline/index.js', sourceRoot));
const { resolveConfig } = await import(new URL('core/config.js', sourceRoot));
const { AnalysisCache } = await import(new URL('pipeline/cache.js', sourceRoot));
const { canonicalJson } = await import(new URL('history/fingerprint.js', sourceRoot));
const roots = [];
after(async () => { await Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))); });
async function put(root, name, text) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), text);
}
async function repository(text) {
    const root = await mkdtemp(path.join(tmpdir(), 'codiluce-kotlin-webflux-invoke-'));
    roots.push(root);
    await put(root, 'kotlin/demo/Routes.kt', text);
    return root;
}
const header = `package demo
import org.springframework.context.annotation.Configuration
import org.springframework.context.annotation.Bean
import org.springframework.web.reactive.function.server.router
import org.springframework.web.reactive.function.server.coRouter
import org.springframework.web.reactive.function.server.ServerRequest
import org.springframework.web.reactive.function.server.ServerResponse
import org.springframework.web.reactive.function.server.RequestPredicate
import org.springframework.web.reactive.function.server.RequestPredicates
import org.springframework.http.MediaType
import reactor.core.publisher.Mono
`;
const source = (body, extra = '', mode = 'router') => `${header}
@Configuration(proxyBeanMethods=false)
class Routes {
 @Bean fun routes() = ${mode} {
${body}
 }
 private fun show(request: ServerRequest): Mono<ServerResponse> = response()
 private suspend fun suspending(request: ServerRequest): ServerResponse = reply()
}
${extra}`;
async function index(root, version = '7.0.2', cache, revision) {
    const config = await resolveConfig(root, { repository: { name: 'Kotlin WebFlux original invoke' }, applications: [
            { name: 'server', path: '.', sourceRoots: { kotlin: ['kotlin'] }, jvm: { dependencies: [], spring: { stack: 'webflux', version, componentScan: ['demo'] } } },
        ] });
    return indexRepository(root, { config, cache, revision });
}
const endpoints = (graph) => graph.entities.filter(entity => entity.type === 'api_endpoint' && entity.metadata.framework === 'spring-webflux');
const whole = (graph) => { const copy = structuredClone(graph); copy.run.id = ''; copy.run.analyzedAt = ''; return canonicalJson(copy); };
const handler = (graph, route = endpoints(graph)[0]) => graph.entities.find(entity => entity.id === route.metadata.handler);
test('Explicit Kotlin predicate and string invoke retain reactive original handlers under reviewed Spring versions', async () => {
    const text = source('  GET("/member").invoke(::show)\n  "/string".invoke { response() }');
    const root = await repository(text);
    for (const version of ['6.2.19', '7.0.2', '7.0.9']) {
        const graph = await index(root, version), routes = endpoints(graph);
        assert.deepEqual(routes.map(route => route.name), ['GET /member', 'ANY /string']);
        assert.ok(routes.every(route => route.metadata.constraintsUnresolved === false));
        assert.equal(handler(graph, routes[0])?.name, 'show');
        assert.equal(handler(graph, routes[1])?.metadata.declarationKind, 'lambda');
        for (const route of routes) {
            assert.ok(route.evidence.some(proof => proof.explanation === 'Original Kotlin WebFlux explicit predicate/path invocation'));
            assert.ok(graph.relations.some(edge => edge.type === 'handles' && edge.from === route.id && edge.to === route.metadata.handler));
            assert.equal(graph.relations.some(edge => edge.type === 'calls' && edge.from === route.metadata.factory && edge.to === route.metadata.handler), false);
            assert.equal(route.sourceRange?.startLine, text.split('\n').findIndex(line => line.includes(route.metadata.routePath)) + 1);
        }
    }
});
test('Explicit coRouter invocation selects suspend handlers and preserves original path/query conjunction', async () => {
    const root = await repository(source('  (GET("/co") and RequestPredicates.queryParam("q", "x")).invoke(::suspending)\n  "/coroutine".invoke { reply() }', '', 'coRouter'));
    const graph = await index(root), routes = endpoints(graph);
    assert.deepEqual(routes.map(route => route.name), ['GET /co', 'ANY /coroutine']);
    assert.ok(routes.every(route => route.metadata.constraintsUnresolved === false));
    assert.equal(handler(graph, routes[0])?.name, 'suspending');
    assert.deepEqual(routes[0].metadata.routing.queries, [{ name: 'q', value: 'x' }]);
    assert.equal(handler(graph, routes[1])?.metadata.declarationKind, 'lambda');
});
test('Original accept/GET explicit invocation preserves concrete routing with injection and virtual dispatch gaps', async () => {
    const root = await repository(`${header}
@Configuration(proxyBeanMethods=false)
class Routes {
 @Bean fun routes(greetingHandler: GreetingHandler) = router {
  (accept(MediaType.APPLICATION_JSON) and GET("/hello")).invoke(greetingHandler::hello)
 }
}
open class GreetingHandler {
 open fun hello(request: ServerRequest): Mono<ServerResponse> = response()
}`);
    const graph = await index(root), routes = endpoints(graph);
    assert.deepEqual(routes.map(route => route.name), ['GET /hello']);
    assert.equal(routes[0].metadata.constraintsUnresolved, true);
    const conditions = routes[0].metadata.routing.conditions;
    assert.ok(conditions.some(reason => reason.includes('injected')));
    assert.ok(conditions.some(reason => reason.includes('Virtual/interface')));
    assert.ok(conditions.some(reason => reason.includes('predicate accept')));
    assert.equal(handler(graph), undefined);
    assert.equal(graph.relations.some(edge => edge.type === 'handles' && edge.from === routes[0].id), false);
    assert.ok(!conditions.some(reason => /Standalone|empty WebFlux/.test(reason)));
});
test('Unchanged local predicate/path aliases preserve invoke identity while changed values remain opaque', async () => {
    const root = await repository(source('  val selected: RequestPredicate = GET("/alias")\n  val originalPath: String = "/path"\n  selected.invoke(::show)\n  originalPath.invoke(::show)'));
    const graph = await index(root);
    assert.deepEqual(endpoints(graph).map(route => route.name), ['GET /alias', 'ANY /path']);
    assert.ok(endpoints(graph).every(route => !route.metadata.constraintsUnresolved && handler(graph, route)?.name === 'show'));
    await put(root, 'kotlin/demo/Routes.kt', source('  var selected = GET("/before")\n  selected = GET("/after")\n  selected.invoke(::show)'));
    const changed = await index(root);
    assert.ok(endpoints(changed).every(route => route.metadata.constraintsUnresolved));
    assert.ok(endpoints(changed).every(route => !route.metadata.handler));
});
test('Custom invoke receivers and shadowing extensions never borrow the WebFlux registration contract', async () => {
    const cases = [
        source('  custom.invoke(::show)', 'class Custom {\n fun invoke(f: (ServerRequest) -> Mono<ServerResponse>) { }\n}\nval custom = Custom()'),
        source('  GET("/shadow").invoke(::show)', 'fun RequestPredicate.invoke(f: (ServerRequest) -> Mono<ServerResponse>) { }'),
        source('  GET("/shadow").invoke(::show)', 'fun GET(path: String): RequestPredicate = custom()'),
        source('  (GET("/shadow") and custom()).invoke(::show)'),
    ];
    for (const text of cases) {
        const graph = await index(await repository(text));
        assert.ok(endpoints(graph).every(route => route.metadata.constraintsUnresolved));
        assert.ok(endpoints(graph).every(route => !route.metadata.handler));
        assert.equal(graph.relations.some(edge => edge.type === 'handles'), false);
    }
});
test('Explicit invocation retains safe-call and argument boundaries while accepting the published f parameter', async () => {
    const root = await repository(source('  GET("/named").invoke(f = ::show)'));
    const graph = await index(root);
    assert.deepEqual(endpoints(graph).map(route => route.name), ['GET /named']);
    assert.equal(endpoints(graph)[0].metadata.constraintsUnresolved, false);
    for (const body of ['  GET("/safe")?.invoke(::show)', '  GET("/wrong").invoke(handler = ::show)', '  GET("/many").invoke(::show, ::show)']) {
        await put(root, 'kotlin/demo/Routes.kt', source(body));
        const rejected = await index(root);
        assert.ok(endpoints(rejected).every(route => route.metadata.constraintsUnresolved));
        assert.ok(endpoints(rejected).every(route => !route.metadata.handler));
    }
});
test('Explicit invocation edits retain full cold/warm/same-revision graphs and original callable identities', async () => {
    const root = await repository(source('  GET("/before").invoke(::show)'));
    const folder = path.join(root, '.codiluce/cache'), cache = new AnalysisCache(folder);
    const fresh = await index(root), cold = await index(root, '7.0.2', cache), warm = await index(root, '7.0.2', new AnalysisCache(folder));
    assert.equal(whole(cold), whole(fresh));
    assert.equal(whole(warm), whole(cold));
    const revision = 'c'.repeat(40);
    assert.equal(whole(await index(root, '7.0.2', cache, revision)), whole(await index(root, '7.0.2', undefined, revision)));
    const original = handler(cold);
    assert.equal(original.name, 'show');
    const text = await readFile(path.join(root, 'kotlin/demo/Routes.kt'), 'utf8');
    await put(root, 'kotlin/demo/Routes.kt', text.replace('/before', '/after'));
    const changed = await index(root, '7.0.2', cache);
    assert.equal(endpoints(changed)[0].name, 'GET /after');
    assert.equal(handler(changed)?.id, original.id);
    assert.equal(whole(changed), whole(await index(root)));
});
after(async () => { const result = { schema: 1, passed: completedCases.length === 7, caseCount: 7, completedCases, sourceRoot: sourceRoot.href, typescriptSourceLoader: false, targetExecution: false, normalization: ['run.id', 'run.analyzedAt'], scope: 'Published Spring 6.2.19/7.0.2/7.0.9 Kotlin RequestPredicate/String invoke source contracts: reactive and coroutine original handlers, exact predicates/path/query/ranges, immutable aliases, custom/shadowed/safe/argument boundaries and complete cache/revision graphs.' }; if (process.argv[3])
    await writeFile(process.argv[3], JSON.stringify(result, null, 2) + '\n'); console.log(JSON.stringify(result)); });
