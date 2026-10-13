import assert from 'node:assert/strict';
import { after, test as registerTest } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { indexRepository } from '../src/pipeline/index.js';
import { resolveConfig } from '../src/core/config.js';
import { AnalysisCache } from '../src/pipeline/cache.js';
import { canonicalJson } from '../src/history/fingerprint.js';
import { bootManagedCoordinate, bootStarterFrameworkModule, bootSourceBom } from '../src/analysis/resolution/jvm-spring-boot.js';
import { bootMavenPropertyGap } from '../src/analysis/resolution/jvm-spring-boot-maven.js';
import type { SoftwareGraph } from '../src/core/graph.js';
import type { JvmProject } from '../src/analysis/resolution/jvm-projects.js';

const roots: string[] = [];
const completedCases: string[] = [];
function test(name: string, execute: () => Promise<void>) { return registerTest(name, async () => { await execute(); completedCases.push(name); }); }
after(async () => { if (completedCases.length === 12) for (const root of roots) await rm(root, { recursive: true, force: true }); else console.error('Retained Boot 3.5 fixtures:', roots); });
const gradle = 'plugins { id("java"); id("org.springframework.boot") version "3.5.16"; id("io.spring.dependency-management") version "1.1.7" }';
const parent = '<parent><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-parent</artifactId><version>3.5.16</version><relativePath/></parent>';
const dependency = (artifact: string, version?: string) => `<dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-${artifact}</artifactId>${version ? `<version>${version}</version>` : ''}</dependency>`;
const pom = (artifact = 'web', extra = '', selectedParent = parent) => `<project><modelVersion>4.0.0</modelVersion>${selectedParent}<groupId>original</groupId><artifactId>service</artifactId><version>1</version><dependencies>${dependency(artifact)}</dependencies>${extra}</project>`;
const mvc = '// é😀 original\r\npackage demo;\r\nimport org.springframework.web.bind.annotation.RestController;\r\nimport org.springframework.web.bind.annotation.GetMapping;\r\n@RestController public class Api {\r\n @GetMapping("/legacy") public String read(){return Service.read();}\r\n}\r\n';
const flux = `package demo;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Bean;
import org.springframework.web.reactive.function.server.RouterFunctions;
import org.springframework.web.reactive.function.server.RouterFunction;
import org.springframework.web.reactive.function.server.ServerResponse;
import org.springframework.web.reactive.function.server.ServerRequest;
import reactor.core.publisher.Mono;
@Configuration(proxyBeanMethods=false) public final class Router {
 @Bean public RouterFunction<ServerResponse> routes(){return RouterFunctions.route().GET("/legacy-flux",this::hello).build();}
 private Mono<ServerResponse> hello(ServerRequest request){Service.read();return Mono.empty();}
}`;
async function put(root: string, file: string, text: string) { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), text); }
async function repository(kind: 'maven' | 'gradle', build: string, source = mvc, kotlinDsl = false) {
    const root = await mkdtemp(path.join(tmpdir(), 'codiluce-boot35-')); roots.push(root);
    await put(root, kind === 'maven' ? 'pom.xml' : 'build.gradle' + (kotlinDsl ? '.kts' : ''), build);
    await put(root, `src/main/java/demo/${source === flux ? 'Router' : 'Api'}.java`, source);
    await put(root, 'src/main/java/demo/Service.java', 'package demo; public class Service {public static String read(){return "ok";}}');
    return root;
}
let observation = 0;
async function index(root: string, kind: 'maven' | 'gradle', stack: 'mvc' | 'webflux' = 'mvc', cache?: AnalysisCache, revision?: string) {
    const graph = await indexRepository(root, { config: await resolveConfig(root, { repository: { name: 'boot35-source' }, applications: [{ name: 'server', path: '.', jvm: { buildSystem: kind, spring: { stack, componentScan: ['demo'] } } }] }), cache, revision });
    if (process.env.CODILUCE_BOOT35_GRAPH_EVIDENCE) { const folder = process.env.CODILUCE_BOOT35_GRAPH_EVIDENCE; await mkdir(folder, { recursive: true }); await writeFile(path.join(folder, `${process.pid}-${++observation}.json`), JSON.stringify({ root, kind, stack, revision, graph }, null, 2) + '\n', { flag: 'wx' }); }
    return graph;
}
const project = (graph: SoftwareGraph) => (graph.entities.find(e => e.type === 'repository')!.metadata.jvmProjects as JvmProject[]).find(model => model.root === '.')!;
const routes = (graph: SoftwareGraph) => graph.entities.filter(e => e.type === 'api_endpoint');
const confirmed = (graph: SoftwareGraph) => routes(graph).filter(e => !e.metadata.constraintsUnresolved);
const whole = (graph: SoftwareGraph) => { const copy = structuredClone(graph); copy.run.id = ''; copy.run.analyzedAt = ''; return canonicalJson(copy); };
const boot = (artifact = 'web') => `dependencies { implementation("org.springframework.boot:spring-boot-starter-${artifact}"); testImplementation("org.springframework.boot:spring-boot-starter-test") }`;

test('Boot 3.5.16 Gradle in both DSLs binds original MVC handler and leaf using the legacy web starter', async () => {
    for (const kotlinDsl of [false, true]) {
        const graph = await index(await repository('gradle', gradle + '\n' + boot(), mvc, kotlinDsl), 'gradle'), model = project(graph);
        assert.deepEqual(model.gaps, []); assert.equal(model.bootBom?.frameworkVersion, '6.2.19'); assert.equal(model.bootBom?.coordinate, 'org.springframework.boot:spring-boot-dependencies:3.5.16');
        const starter = model.dependencies.find(d => d.coordinate === 'org.springframework.boot:spring-boot-starter-web:3.5.16')!;
        assert.equal(starter.declaredCoordinate, 'org.springframework.boot:spring-boot-starter-web');
        assert.ok(starter.proof.some(p => p.analyzerVersion === '8' && p.line === 1));
        assert.equal(confirmed(graph)[0]?.name, 'GET|HEAD /legacy');
        const handler = graph.entities.find(e => e.path?.endsWith('/Api.java') && e.name === 'read')!, leaf = graph.entities.find(e => e.path?.endsWith('/Service.java') && e.name === 'read')!;
        assert.equal(handler.sourceRange?.startLine, 6); assert.ok(graph.relations.some(r => r.type === 'handles' && r.to === handler.id)); assert.ok(graph.relations.some(r => r.type === 'calls' && r.from === handler.id && r.to === leaf.id));
        assert.equal(model.bootBom?.externalResolutionVerified, false);
    }
});
test('Boot 3.5.16 Maven parent selects its own BOM, compiler defaults and matching plugin version', async () => {
    const extra = `<properties><java.version>21</java.version></properties><build><plugins><plugin><groupId>org.springframework.boot</groupId><artifactId>spring-boot-maven-plugin</artifactId><version>3.5.16</version></plugin></plugins></build>`;
    const root = await repository('maven', pom('web', extra)), graph = await index(root, 'maven'), model = project(graph);
    assert.deepEqual(model.gaps, []); assert.equal(model.bootMavenParent?.coordinate, 'org.springframework.boot:spring-boot-starter-parent:3.5.16'); assert.equal(model.bootMavenParent?.compilerParameters, true);
    assert.equal(model.properties['java.version'], '21'); assert.equal(model.properties['project.build.sourceEncoding'], 'UTF-8'); assert.equal(model.bootBom?.frameworkVersion, '6.2.19'); assert.equal(confirmed(graph).length, 1);
    await put(root, 'pom.xml', pom('web', extra.replace('<version>3.5.16</version>', '<version>4.0.8</version>')));
    assert.equal(confirmed(await index(root, 'maven')).length, 0);
});
test('Boot 3.5.16 Maven and Gradle WebFlux starters retain original private functional handlers', async () => {
    for (const kind of ['maven', 'gradle'] as const) {
        const graph = await index(await repository(kind, kind === 'maven' ? pom('webflux') : gradle + '\n' + boot('webflux'), flux), kind, 'webflux');
        assert.deepEqual(project(graph).gaps, []); assert.equal(confirmed(graph)[0]?.name, 'GET /legacy-flux');
        const handler = graph.entities.find(e => e.name === 'hello')!, factory = graph.entities.find(e => e.name === 'routes')!;
        assert.ok(graph.relations.some(r => r.type === 'handles' && r.to === handler.id)); assert.ok(!graph.relations.some(r => r.type === 'calls' && r.from === factory.id && r.to === handler.id)); assert.equal(handler.sourceRange?.startLine, 11);
    }
});
test('A literal local Maven parent preserves inherited Boot 3.5 source ownership and Java defaults', async () => {
    const root = await repository('maven', '<project><modelVersion>4.0.0</modelVersion><parent><groupId>original</groupId><artifactId>parent</artifactId><version>1</version><relativePath>base/pom.xml</relativePath></parent><artifactId>service</artifactId><dependencies>' + dependency('web') + '</dependencies></project>');
    await put(root, 'base/pom.xml', `<project><modelVersion>4.0.0</modelVersion>${parent}<groupId>original</groupId><artifactId>parent</artifactId><version>1</version><packaging>pom</packaging><properties><java.version>21</java.version></properties></project>`);
    const graph = await index(root, 'maven'); assert.equal(project(graph).coordinate, 'original:service:1'); assert.equal(project(graph).properties['java.version'], '21'); assert.equal(confirmed(graph)[0]?.name, 'GET|HEAD /legacy');
});
test('Boot 3.5 and 4 starter names stay separate and source lookalikes never acquire a framework module', async () => {
    for (const artifact of ['webmvc', 'webclient', 'webmvc-test', 'webflux-test']) for (const kind of ['maven', 'gradle'] as const) {
        const graph = await index(await repository(kind, kind === 'maven' ? pom(artifact) : gradle + '\n' + boot(artifact)), kind);
        assert.equal(confirmed(graph).length, 0); assert.ok(!project(graph).dependencies.some(d => d.derivedFrom?.includes('starter-' + artifact)));
    }
    assert.equal(bootManagedCoordinate('org.springframework.boot:spring-boot-starter-web', '4.0.8'), undefined);
    for (const coordinate of ['spring-boot-starter-test', 'other:spring-boot-starter-test', 'constructor', '__proto__']) assert.equal(bootManagedCoordinate(coordinate, '3.5.16'), undefined);
    assert.equal(bootStarterFrameworkModule('org.springframework.boot:spring-boot-starter-webmvc:3.5.16', '3.5.16'), undefined);
});
test('Unknown Boot versions, lookalike parents and enabled local lookup cannot select the pinned Maven contract', async () => {
    for (const selected of [parent.replace('3.5.16', '3.5.15'), parent.replace('3.5.16', '3.5.16-SNAPSHOT'), parent.replace('org.springframework.boot', 'example'), parent.replace('<relativePath/>', ''), parent.replace('<relativePath/>', '<relativePath>../absent.xml</relativePath>')]) {
        const graph = await index(await repository('maven', pom('web', '', selected)), 'maven'); assert.equal(project(graph).bootMavenParent, undefined); assert.equal(confirmed(graph).length, 0);
    }
    for (const version of ['3.5.15', '3.5.17', '__proto__', 'constructor']) assert.equal(bootSourceBom(version), undefined);
});
test('Every published Boot 3.5 BOM override is constrained in its own version profile', async () => {
    const fixture = JSON.parse(await readFile(new URL('./fixtures/spring-boot35-published-contract.json', import.meta.url), 'utf8'));
    assert.equal(fixture.bomProperties.length, 191);
    for (const name of fixture.bomProperties) assert.match(bootMavenPropertyGap(name, 'original', '3.5.16') ?? '', /overrides the reviewed Boot BOM/, name);
    for (const name of fixture.propertiesOnlyInBoot35) {
        assert.equal(bootMavenPropertyGap(name, 'original', '4.0.8'), undefined);
        const graph = await index(await repository('maven', pom('web', `<properties><${name}>original</${name}></properties>`)), 'maven'); assert.equal(confirmed(graph).length, 0); assert.ok(project(graph).gaps.some(g => g.includes(name)));
    }
    for (const name of fixture.propertiesOnlyInBoot4) assert.equal(bootMavenPropertyGap(name, 'original', '3.5.16'), undefined);
});
test('Boot 3.5 compiler, dependency and plugin overrides retain explicit Maven gaps', async () => {
    for (const extra of ['<properties><java.version>16</java.version></properties>', '<properties><maven.compiler.parameters>false</maven.compiler.parameters></properties>', '<properties><project.build.sourceEncoding>ISO-8859-1</project.build.sourceEncoding></properties>', '<dependencyManagement><dependencies><dependency><groupId>org.springframework</groupId><artifactId>spring-webmvc</artifactId><version>7.0.9</version></dependency></dependencies></dependencyManagement>', '<build><plugins><plugin><groupId>org.springframework.boot</groupId><artifactId>spring-boot-maven-plugin</artifactId><configuration><mainClass>demo.Api</mainClass></configuration></plugin></plugins></build>']) {
        const graph = await index(await repository('maven', pom('web', extra)), 'maven'); assert.ok(project(graph).gaps.length); assert.equal(confirmed(graph).length, 0);
    }
});
test('Boot 3.5 Gradle requires applied reviewed plugins, Java roots and matching starter versions', async () => {
    for (const build of [gradle.replace('3.5.16', '3.5.15'), gradle.replace('id("java"); ', ''), gradle.replace('version "1.1.7"', 'version "1.1.8"'), gradle.replace('version "3.5.16";', 'version "3.5.16" apply false;'), gradle + '\nextra["spring-framework.version"] = "7.0.9"']) {
        const graph = await index(await repository('gradle', build + '\n' + boot()), 'gradle'); assert.equal(confirmed(graph).length, 0);
    }
    const graph = await index(await repository('gradle', gradle + '\ndependencies {implementation("org.springframework.boot:spring-boot-starter-web:4.0.8")}'), 'gradle'); assert.ok(project(graph).gaps.some(g => g.includes('starter version'))); assert.equal(confirmed(graph).length, 0);
});
test('Reviewed Kotlin JVM selection aligns Boot 3.5 managed Kotlin libraries to the original plugin version', async () => {
    const plugins = gradle.replace('id("java");', 'id("org.jetbrains.kotlin.jvm") version "2.2.21"; id("org.jetbrains.kotlin.plugin.spring") version "2.2.21";');
    const root = await repository('gradle', plugins + '\ndependencies {implementation("org.springframework.boot:spring-boot-starter-web"); implementation("org.jetbrains.kotlin:kotlin-reflect"); testImplementation("org.jetbrains.kotlin:kotlin-test-junit5")}', mvc, true);
    await put(root, 'src/main/kotlin/demo/KotlinApi.kt', 'package demo\nimport org.springframework.web.bind.annotation.RestController\nimport org.springframework.web.bind.annotation.GetMapping\n@RestController\nclass KotlinApi {\n @GetMapping("/kboot")\n fun original() = "ok"\n}\n');
    const graph = await index(root, 'gradle'), model = project(graph); assert.deepEqual(model.gaps, []);
    assert.equal(model.kotlinCompiler?.version, '2.2.21'); assert.equal(model.kotlinCompiler?.javaParameters, true); assert.ok(confirmed(graph).some(r => r.name === 'GET|HEAD /kboot'));
    for (const name of ['kotlin-reflect', 'kotlin-test-junit5']) assert.ok(model.dependencies.some(d => d.coordinate === 'org.jetbrains.kotlin:' + name + ':2.2.21'));
    assert.equal(bootManagedCoordinate('org.jetbrains.kotlin:kotlin-reflect', '3.5.16'), 'org.jetbrains.kotlin:kotlin-reflect:1.9.25');
});
test('The Boot 3.5 BOM default never implies a reviewed Kotlin compiler or supplies missing binary source', async () => {
    const plugins = gradle.replace('id("java");', 'id("org.jetbrains.kotlin.jvm") version "1.9.25"; id("org.jetbrains.kotlin.plugin.spring") version "1.9.25";');
    const graph = await index(await repository('gradle', plugins + '\n' + boot(), mvc, true), 'gradle'); assert.equal(project(graph).kotlinCompiler, undefined); assert.ok(project(graph).gaps.some(g => /Kotlin/.test(g))); assert.equal(confirmed(graph).length, 0);
});
test('Boot family edits invalidate cached models and preserve full cold/warm/revision graphs and original handlers', async () => {
    for (const kind of ['maven', 'gradle'] as const) {
        const root = await repository(kind, kind === 'maven' ? pom() : gradle + '\n' + boot()), state = await mkdtemp(path.join(tmpdir(), 'codiluce-boot35-cache-')); roots.push(state);
        const cache = new AnalysisCache(state), cold = await index(root, kind, 'mvc', cache), warm = await index(root, kind, 'mvc', cache); assert.equal(whole(cold), whole(warm));
        const previous = cold.entities.filter(e => e.path?.endsWith('.java')).map(e => ({ id: e.id, name: e.name, path: e.path, range: e.sourceRange }));
        await put(root, kind === 'maven' ? 'pom.xml' : 'build.gradle', kind === 'maven' ? pom('webmvc', '', parent.replace('3.5.16', '4.0.8')) : gradle.replace('3.5.16', '4.0.8') + '\n' + boot('webmvc'));
        const changed = await index(root, kind, 'mvc', cache), fresh = await index(root, kind); assert.equal(whole(changed), whole(fresh)); assert.equal(project(changed).bootBom?.frameworkVersion, '7.0.9'); assert.equal(confirmed(changed).length, 1);
        assert.deepEqual(changed.entities.filter(e => e.path?.endsWith('.java')).map(e => ({ id: e.id, name: e.name, path: e.path, range: e.sourceRange })), previous);
        const revision = 'f'.repeat(40); assert.equal(whole(await index(root, kind, 'mvc', cache, revision)), whole(await index(root, kind, 'mvc', undefined, revision)));
    }
});
