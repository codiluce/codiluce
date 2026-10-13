// Portable ordinary compiled qualification of the Boot Gradle source contract.
// Target plugins, applications and dependencies never execute.
import assert from 'node:assert/strict';
import { after, test as registerTest } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const sourceRoot = new URL(process.argv[2]);
assert.equal(sourceRoot.protocol, 'file:');
assert.ok(sourceRoot.pathname.endsWith('/'));
const completedCases = [];
function test(name, execute) { return registerTest(name, async () => { await execute(); completedCases.push(name); }); }
const { indexRepository } = await import(new URL('pipeline/index.js', sourceRoot));
const { resolveConfig } = await import(new URL('core/config.js', sourceRoot));
const { AnalysisCache } = await import(new URL('pipeline/cache.js', sourceRoot));
const { canonicalJson } = await import(new URL('history/fingerprint.js', sourceRoot));
const roots = [];
after(async () => { await Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))); });
const plugin = 'plugins { id("java"); id("org.springframework.boot") version "4.0.8"; id("io.spring.dependency-management") version "1.1.7" }';
const mvc = `// 😀 original\r\npackage demo;\r\nimport org.springframework.web.bind.annotation.RestController;\r\nimport org.springframework.web.bind.annotation.GetMapping;\r\n@RestController public class Api {\r\n @GetMapping("/boot") public String read(){return Service.read();}\r\n}\r\n`;
const flux = `package demo;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Bean;
import org.springframework.web.reactive.function.server.RouterFunction;
import org.springframework.web.reactive.function.server.RouterFunctions;
import org.springframework.web.reactive.function.server.ServerResponse;
import org.springframework.web.reactive.function.server.ServerRequest;
import reactor.core.publisher.Mono;
@Configuration(proxyBeanMethods=false) public class Router {
 @Bean public RouterFunction<ServerResponse> routes(){return RouterFunctions.route().GET("/flux",this::hello).build();}
 private Mono<ServerResponse> hello(ServerRequest request){return ServerResponse.ok().bodyValue("Hello");}
}`;
async function put(root, file, text) { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), text); }
async function repository(build, kotlinDsl = false, source = mvc) {
    const root = await mkdtemp(path.join(tmpdir(), 'codiluce-boot-gradle-'));
    roots.push(root);
    await put(root, 'build.gradle' + (kotlinDsl ? '.kts' : ''), build);
    await put(root, 'src/main/java/demo/' + (source === flux ? 'Router' : 'Api') + '.java', source);
    await put(root, 'src/main/java/demo/Service.java', 'package demo; public class Service { public static String read(){return "ok";} }');
    return root;
}
async function index(root, stack = 'mvc', cache, revision) {
    return indexRepository(root, { config: await resolveConfig(root, { repository: { name: 'boot-gradle' }, applications: [{ name: 'server', path: '.', jvm: { buildSystem: 'gradle', spring: { stack, componentScan: ['demo'] } } }] }), cache, revision });
}
const project = (graph) => graph.entities.find(entity => entity.type === 'repository').metadata.jvmProjects[0];
const routes = (graph) => graph.entities.filter(entity => entity.type === 'api_endpoint');
const whole = (graph) => { const copy = structuredClone(graph); copy.run.id = ''; copy.run.analyzedAt = ''; return canonicalJson(copy); };
const boot = (artifact) => `dependencies { implementation("org.springframework.boot:spring-boot-starter-${artifact}") }`;
test('Pinned Boot Gradle defaults bind original Java MVC imports, handler, leaf and source BOM evidence in both DSLs', async () => {
    for (const kotlinDsl of [false, true]) {
        const root = await repository('// 😀 original\r\n' + plugin + '\r\n' + boot('webmvc'), kotlinDsl), graph = await index(root), model = project(graph);
        assert.deepEqual(model.gaps, []);
        assert.equal(model.bootBom?.frameworkVersion, '7.0.9');
        assert.equal(model.bootBom?.externalResolutionVerified, false);
        const starter = model.dependencies.find(dep => dep.coordinate === 'org.springframework.boot:spring-boot-starter-webmvc:4.0.8');
        assert.equal(starter.declaredCoordinate, 'org.springframework.boot:spring-boot-starter-webmvc');
        assert.equal(model.dependencies.find(dep => dep.coordinate === 'org.springframework:spring-webmvc:7.0.9')?.derivedFrom, starter.coordinate);
        assert.ok(starter.proof.some(fact => fact.line === 2 && fact.analyzerVersion === '6' && fact.explanation?.includes('never resolve or execute')));
        assert.equal(routes(graph).length, 1);
        const route = routes(graph)[0];
        assert.equal(route.metadata.constraintsUnresolved, false, JSON.stringify(graph.diagnostics));
        const handler = graph.entities.find(entity => entity.name === 'read' && entity.path?.endsWith('Api.java'));
        const leaf = graph.entities.find(entity => entity.name === 'read' && entity.path?.endsWith('Service.java'));
        assert.ok(graph.relations.some(edge => edge.type === 'handles' && edge.from === route.id && edge.to === handler.id));
        assert.ok(graph.relations.some(edge => edge.type === 'calls' && edge.from === handler.id && edge.to === leaf.id));
        assert.equal(handler.sourceRange?.startLine, 6);
        assert.equal(route.sourceRange?.startLine, 6);
    }
});
test('Published Boot WebFlux starter chain selects original functional handlers while WebClient alone cannot activate a server profile', async () => {
    const root = await repository(plugin + '\ndependencies { implementation("org.springframework.boot:spring-boot-starter-webflux"); implementation("org.springframework.boot:spring-boot-starter-webclient") }', false, flux);
    const graph = await index(root, 'webflux');
    assert.deepEqual(project(graph).gaps, []);
    assert.equal(routes(graph).length, 1);
    assert.equal(routes(graph)[0].metadata.constraintsUnresolved, false, JSON.stringify(graph.diagnostics));
    assert.ok(graph.relations.some(edge => edge.type === 'handles' && edge.from === routes(graph)[0].id && graph.entities.find(entity => entity.id === edge.to)?.name === 'hello'));
    await put(root, 'build.gradle', plugin + '\n' + boot('webclient'));
    const clientOnly = await index(root, 'webflux');
    assert.ok(!project(clientOnly).dependencies.some(dep => dep.coordinate?.startsWith('org.springframework:spring-webflux:')));
    assert.ok(routes(clientOnly).every(route => route.metadata.constraintsUnresolved));
});
test('Boot or management plugins never supply JVM source roots or replace missing BOM ownership', async () => {
    for (const build of [plugin.replace('id("java"); ', '') + '\n' + boot('webmvc'), plugin.replace('; id("io.spring.dependency-management") version "1.1.7"', '') + '\n' + boot('webmvc')]) {
        const graph = await index(await repository(build));
        assert.ok(project(graph).roots.length === 0 || project(graph).dependencies.some(dep => dep.reason));
        assert.equal(routes(graph).length, 0);
    }
});
test('Unknown versions, duplicate plugin declarations, custom BOM/source statements and mismatched starter versions remain binding gaps', async () => {
    for (const build of [
        plugin.replace('4.0.8', '4.0.9'), plugin.replace('1.1.7', '1.1.8'),
        plugin.replace('id("java");', 'id("java"); id("org.springframework.boot") version "4.0.8";'),
        plugin + '\ndependencyManagement { imports { mavenBom("other:bom:1.0") } }',
        plugin + '\nextra["spring-framework.version"] = "6.2.19"',
        plugin + '\nif (enabled) { sourceSets { main { java.srcDirs("other") } } }',
    ]) {
        const graph = await index(await repository(build + '\n' + boot('webmvc')));
        assert.ok(project(graph).gaps.length);
        assert.equal(routes(graph).length, 0);
    }
    const mismatch = await index(await repository(plugin + '\ndependencies { implementation("org.springframework.boot:spring-boot-starter-webmvc:4.0.1") }'));
    assert.ok(project(mismatch).gaps.some(gap => gap.includes('starter version')));
    assert.equal(routes(mismatch).length, 0);
    const propertiesRoot = await repository(plugin + '\n' + boot('webmvc'));
    await put(propertiesRoot, 'gradle.properties', 'spring-framework.version=6.2.19\n');
    const properties = await index(propertiesRoot);
    assert.ok(project(properties).gaps.some(gap => gap.includes('Gradle properties'))); assert.equal(routes(properties).length, 0);
});
test('Unlisted managed coordinates and explicit competing Spring versions do not inherit fabricated Boot selections', async () => {
    const unknown = await index(await repository(plugin + '\n' + boot('webmvc') + '\ndependencies { implementation("other:library") }'));
    assert.equal(project(unknown).dependencies.find(dep => dep.coordinate === 'other:library')?.managedBy, undefined);
    assert.equal(routes(unknown).length, 0);
    const competing = await index(await repository(plugin + '\n' + boot('webmvc') + '\ndependencies { implementation("org.springframework:spring-webmvc:6.2.19") }'));
    assert.equal(project(competing).dependencies.find(dep => dep.coordinate === 'org.springframework:spring-webmvc:6.2.19')?.declaredCoordinate, undefined);
    assert.equal(routes(competing).length, 0);
});
test('Boot/BOM changes invalidate warm bindings and retain complete cold/warm/revision graph equality', async () => {
    const root = await repository(plugin + '\n' + boot('webmvc')), state = await mkdtemp(path.join(tmpdir(), 'codiluce-boot-cache-'));
    roots.push(state);
    const cache = new AnalysisCache(state), cold = await index(root, 'mvc', cache), warm = await index(root, 'mvc', cache);
    assert.equal(whole(warm), whole(cold));
    await put(root, 'build.gradle', plugin.replace('4.0.8', '4.0.9') + '\n' + boot('webmvc'));
    const denied = await index(root, 'mvc', cache);
    assert.equal(routes(denied).length, 0);
    await put(root, 'build.gradle', plugin + '\n' + boot('webmvc'));
    const restored = await index(root, 'mvc', cache), revision = await index(root, 'mvc', new AnalysisCache(state), 'boot-revision'), fresh = await index(root, 'mvc', undefined, 'boot-revision');
    assert.equal(whole(restored), whole(cold));
    assert.equal(whole(revision), whole(fresh));
});
after(async () => { const result = { schema: 1, passed: completedCases.length === 6, sourceRoot: sourceRoot.href, caseCount: 6, completedCases, targetExecution: false, typescriptSourceLoader: false, normalization: ['run.id', 'run.analyzedAt'], scope: 'Pinned Boot 4.0.8/management 1.1.7 Java Gradle/default BOM source contract; original MVC/WebFlux handlers, retained WebClient and opaque model boundaries, source-only artifacts/proof, complete cache and same-revision graph replay.' }; if (process.argv[3])
    await writeFile(process.argv[3], JSON.stringify(result, null, 2) + '\n'); console.log(JSON.stringify(result)); });
