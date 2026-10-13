import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { indexRepository } from '../src/pipeline/index.js';
import { resolveConfig } from '../src/core/config.js';
import { AnalysisCache } from '../src/pipeline/cache.js';
import { canonicalJson } from '../src/history/fingerprint.js';
import type { SoftwareGraph } from '../src/core/graph.js';
import type { JvmProject } from '../src/analysis/resolution/jvm-projects.js';

const roots: string[] = [];
after(async () => { await Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))); });
const plugins = 'plugins { kotlin("jvm") version "2.2.21"; kotlin("plugin.spring") version "2.2.21"; id("org.springframework.boot") version "4.0.1"; id("io.spring.dependency-management") version "1.1.7" }';
const options = 'kotlin { compilerOptions { freeCompilerArgs.addAll("-Xjsr305=strict", "-Xannotation-default-target=param-property") } }';
const build = (extra = '', starter = 'webmvc') => plugins + '\njava { toolchain { languageVersion = JavaLanguageVersion.of(17) } }\n' + options + '\ndependencies { implementation("org.springframework.boot:spring-boot-starter-' + starter + '"); implementation("org.jetbrains.kotlin:kotlin-reflect") }\n' + extra;
const mvc = `// 😀 original\r\npackage demo\r\nimport org.springframework.web.bind.annotation.RestController\r\nimport org.springframework.web.bind.annotation.GetMapping\r\n@RestController class Api {\r\n @GetMapping("/kotlin") fun read(): String = leaf()\r\n}\r\nfun leaf(): String = "ok"\r\n`;
const flux = `package demo
import org.springframework.context.annotation.Configuration
import org.springframework.context.annotation.Bean
import org.springframework.web.reactive.function.server.RouterFunction
import org.springframework.web.reactive.function.server.ServerResponse
import org.springframework.web.reactive.function.server.ServerRequest
import org.springframework.web.reactive.function.server.router
import reactor.core.publisher.Mono
@Configuration class Routes {
 @Bean fun routes(): RouterFunction<ServerResponse> = router { GET("/kotlin-flux", ::hello) }
 private fun hello(request: ServerRequest): Mono<ServerResponse> = ServerResponse.ok().bodyValue("Hello")
}`;
async function put(root: string, name: string, text: string) { await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), text); }
async function repository(files: Record<string, string>) { const root = await mkdtemp(path.join(tmpdir(), 'codiluce-kotlin-compiler-')); roots.push(root); for (const [name, text] of Object.entries(files)) await put(root, name, text); return root; }
async function index(root: string, stack: 'mvc' | 'webflux' = 'mvc', cache?: AnalysisCache, revision?: string) {
    return indexRepository(root, { config: await resolveConfig(root, { repository: { name: 'kotlin-compiler' }, applications: [{ name: 'server', path: '.', jvm: { buildSystem: 'gradle', spring: { stack, componentScan: ['demo'] } } }] }), cache, revision });
}
const project = (graph: SoftwareGraph) => (graph.entities.find(entity => entity.type === 'repository')!.metadata.jvmProjects as JvmProject[])[0]!;
const endpoints = (graph: SoftwareGraph) => graph.entities.filter(entity => entity.type === 'api_endpoint');
const whole = (graph: SoftwareGraph) => { const copy = structuredClone(graph); copy.run.id = ''; copy.run.analyzedAt = ''; return canonicalJson(copy); };
const source = (graph: SoftwareGraph, name: string) => { const entity = graph.entities.find(entity => entity.name === name && ['function','method'].includes(entity.type)); assert.ok(entity, `Original callable ${name} must exist`); return entity; };
const calls = (graph: SoftwareGraph, from: string, to: string) => { const origin = source(graph, from), target = source(graph, to); return graph.relations.some(edge => edge.type === 'calls' && edge.from === origin.id && edge.to === target.id); };
const bound = (graph: SoftwareGraph) => { for (const entity of graph.entities.filter(entity => entity.type === 'file' && entity.language === 'kotlin' && entity.path?.startsWith('src/main/kotlin/'))) assert.equal((entity.metadata.analysis as any).features.references.status, 'partial', JSON.stringify(entity.metadata.analysis)); };

test('Pinned Boot/Kotlin source contracts retain original MVC handler, leaf and compiler/BOM proof', async () => {
    const root = await repository({ 'build.gradle.kts': build('\ndependencies { implementation("com.fasterxml.jackson.module:jackson-module-kotlin") }'), 'src/main/kotlin/demo/Api.kt': mvc });
    const graph = await index(root), model = project(graph);
    assert.deepEqual(model.gaps, []); assert.equal(model.bootBom?.frameworkVersion, '7.0.2'); assert.equal(model.kotlinCompiler?.version, '2.2.21');
    assert.equal(model.kotlinCompiler?.springAllOpen, true); assert.equal(model.kotlinCompiler?.annotationDefaultTarget, 'param-property'); assert.equal(model.kotlinCompiler?.javaParameters, true); assert.equal(model.kotlinCompiler?.externalResolutionVerified, false);
    assert.ok(model.dependencies.some(dep => dep.coordinate === 'com.fasterxml.jackson.module:jackson-module-kotlin:2.20.1' && dep.declaredCoordinate === 'com.fasterxml.jackson.module:jackson-module-kotlin'));
    assert.equal(endpoints(graph).length, 1); assert.equal(endpoints(graph)[0]!.metadata.constraintsUnresolved, false);
    assert.equal(source(graph, 'read').sourceRange?.startLine, 6); assert.ok(calls(graph, 'read', 'leaf'));
    assert.ok(model.kotlinCompiler?.proof.some(fact => fact.analyzerVersion === '7' && fact.line === 1 && fact.explanation?.includes('never executes')));
});

test('Spring all-open prevents implicit-final calls while exact allocations and explicit final/private members stay direct', async () => {
    const code = `package demo
import org.springframework.stereotype.Component
@Component class Service {
 fun read(): String = "ok"
 final fun fixed(): String = "fixed"
 private fun hidden(): String = "hidden"
 fun wrapper(): String = hidden()
}
fun injected(service: Service): String { service.read(); return service.fixed() }
fun allocated(): String = Service().read()
class Plain {
 fun plain(): String = "plain"
}
fun ordinary(value: Plain): String = value.plain()
`;
    const graph = await index(await repository({ 'build.gradle.kts': build(), 'src/main/kotlin/demo/Calls.kt': code }));
    bound(graph); assert.deepEqual(project(graph).gaps, []); assert.equal(calls(graph, 'injected', 'read'), false); assert.ok(calls(graph, 'injected', 'fixed')); assert.ok(calls(graph, 'wrapper', 'hidden')); assert.ok(calls(graph, 'allocated', 'read')); assert.ok(calls(graph, 'ordinary', 'plain'));
});

test('Source meta-annotations and Java/Kotlin ancestors supply compiler openness without fabricating declarations', async () => {
    const files = {
        'src/main/kotlin/demo/Calls.kt': `package demo
import org.springframework.stereotype.Component
@Component annotation class Managed
@Managed class Service {
 fun read(): String = "ok"
}
@Component open class Base
class Child: Base() {
 fun inherited(): String = "ok"
}
class JavaChild: JavaBase() {
 fun javaInherited(): String = "ok"
}
fun meta(value: Service): String = value.read()
fun inheritedCaller(value: Child): String = value.inherited()
fun javaCaller(value: JavaChild): String = value.javaInherited()
`,
        'src/main/java/demo/JavaBase.java': 'package demo; import org.springframework.stereotype.Component; @Component public class JavaBase {}',
    };
    const graph = await index(await repository({ 'build.gradle.kts': build(), ...files }));
    bound(graph); assert.deepEqual(project(graph).gaps, []); assert.equal(calls(graph, 'meta', 'read'), false); assert.equal(calls(graph, 'inheritedCaller', 'inherited'), false); assert.equal(calls(graph, 'javaCaller', 'javaInherited'), false);
    assert.ok(graph.entities.every(entity => !entity.metadata.compilerGenerated));
});

test('Local lookalike meta-annotations do not borrow the published Spring chain and unknown chains never prove finality', async () => {
    const code = `package demo
annotation class Local
@Local class Closed {
 fun closed(): String = "ok"
}
@Missing class Unknown {
 fun uncertain(): String = "ok"
}
fun closedCaller(value: Closed): String = value.closed()
fun unknownCaller(value: Unknown): String = value.uncertain()
`;
    const graph = await index(await repository({ 'build.gradle.kts': build(), 'src/main/kotlin/demo/Calls.kt': code }));
    bound(graph); assert.ok(calls(graph, 'closedCaller', 'closed')); assert.equal(calls(graph, 'unknownCaller', 'uncertain'), false);
});

test('Compiler-open properties cannot become invented exact initialized receivers', async () => {
    const code = `package demo
import org.springframework.stereotype.Component
class Leaf {
 fun leaf(): String = "ok"
}
@Component class Owner {
 val shared = Leaf()
 private val owned = Leaf()
 fun sharedCaller(): String = shared.leaf()
 fun ownedCaller(): String = owned.leaf()
}`;
    const graph = await index(await repository({ 'build.gradle.kts': build(), 'src/main/kotlin/demo/Calls.kt': code }));
    bound(graph); assert.equal(calls(graph, 'sharedCaller', 'leaf'), false); assert.ok(calls(graph, 'ownedCaller', 'leaf'));
});

test('A source lookalike of a published Spring meta-annotation uses its actual source chain', async () => {
    const root = await repository({ 'build.gradle.kts': build(),
        'src/main/kotlin/org/springframework/web/bind/annotation/RestController.kt': 'package org.springframework.web.bind.annotation\nannotation class RestController\n',
        'src/main/kotlin/demo/Calls.kt': 'package demo\nimport org.springframework.web.bind.annotation.RestController\n@RestController class Local {\n fun read(): String = "ok"\n}\nfun localCaller(value: Local): String = value.read()\n' });
    const graph = await index(root); bound(graph); assert.ok(calls(graph, 'localCaller', 'read')); assert.equal(endpoints(graph).length, 0);
});

test('Published all-open config permits the original proxy-enabled WebFlux factory with a private exact handler', async () => {
    const root = await repository({ 'build.gradle.kts': build('', 'webflux'), 'src/main/kotlin/demo/Routes.kt': flux });
    const graph = await index(root, 'webflux'); assert.deepEqual(project(graph).gaps, []); assert.equal(endpoints(graph).length, 1);
    assert.equal(endpoints(graph)[0]!.metadata.constraintsUnresolved, false, JSON.stringify(graph.diagnostics));
    assert.ok(graph.relations.some(edge => edge.type === 'handles' && edge.from === endpoints(graph)[0]!.id && edge.to === source(graph, 'hello').id));
    await put(root, 'build.gradle.kts', build('', 'webflux').replace('kotlin("plugin.spring") version "2.2.21";', ''));
    const closed = await index(root, 'webflux'); assert.equal(endpoints(closed).length, 1); assert.equal(endpoints(closed)[0]!.metadata.constraintsUnresolved, true);
});

test('Unknown annotation placement on original constructor/properties remains a visible source binding boundary', async () => {
    for (const declaration of ['class Data(@Unknown val value: String)', 'class Data {\n @Unknown val value = "x"\n}']) {
        const graph = await index(await repository({ 'build.gradle.kts': build(), 'src/main/kotlin/demo/Api.kt': mvc + '\n' + declaration }));
        assert.equal(endpoints(graph).length, 0); assert.ok(graph.entities.filter(entity => entity.type === 'file').some(entity => JSON.stringify(entity.metadata.importOutcomes).includes('annotation-target/metadata')));
    }
    const explicit = await index(await repository({ 'build.gradle.kts': build(), 'src/main/kotlin/demo/Api.kt': mvc + '\nclass Data(@field:Unknown val value: String)' }));
    assert.equal(endpoints(explicit).length, 1);
});

test('Unreviewed/duplicate Kotlin plugins, flags and Boot versions retain compiler/model gaps', async () => {
    for (const selected of [build().replaceAll('2.2.21', '2.2.22'), build().replace('4.0.1', '4.0.9'), build().replace('kotlin("jvm") version "2.2.21";', ''), build().replace('plugins {', 'plugins { kotlin("plugin.spring") version "2.2.21";'), build('\nkotlin { compilerOptions { freeCompilerArgs.add("-Xplugin=custom.jar") } }'), build('\nallOpen { annotation("custom.Open") }')]) {
        const graph = await index(await repository({ 'build.gradle.kts': selected, 'src/main/kotlin/demo/Api.kt': mvc })); assert.ok(project(graph).gaps.length); assert.equal(endpoints(graph).length, 0);
    }
});

test('Ordered literal argument replacement preserves original inputs and selects only final reviewed compiler effects', async () => {
    const selected = build('\nkotlin { compilerOptions { freeCompilerArgs.set(listOf("-java-parameters")) } }');
    const graph = await index(await repository({ 'build.gradle.kts': selected, 'src/main/kotlin/demo/Api.kt': mvc })), model = project(graph);
    assert.deepEqual(model.gaps, []); assert.equal(model.kotlinCompiler?.annotationDefaultTarget, undefined); assert.equal(model.compilerInputs?.kotlinArgumentUpdates.length, 2); assert.equal(model.kotlinCompiler?.effectiveArguments.length, 1);
    assert.equal(endpoints(graph).length, 1);
});

test('Kotlin compiler and Boot model edits invalidate bindings and preserve complete cold/warm/same-revision graphs', async () => {
    const root = await repository({ 'build.gradle.kts': build(), 'src/main/kotlin/demo/Api.kt': mvc }), state = await mkdtemp(path.join(tmpdir(), 'codiluce-kotlin-cache-')); roots.push(state);
    const cache = new AnalysisCache(state), cold = await index(root, 'mvc', cache), warm = await index(root, 'mvc', cache); assert.equal(whole(cold), whole(warm));
    await put(root, 'build.gradle.kts', build().replaceAll('2.2.21', '2.2.22')); assert.equal(endpoints(await index(root, 'mvc', cache)).length, 0);
    await put(root, 'build.gradle.kts', build()); assert.equal(whole(await index(root, 'mvc', cache)), whole(cold));
    assert.equal(whole(await index(root, 'mvc', new AnalysisCache(state), 'kotlin-compiler-revision')), whole(await index(root, 'mvc', undefined, 'kotlin-compiler-revision')));
});
