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
const parent = '<parent><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-parent</artifactId><version>4.0.8</version><relativePath/></parent>';
const dependency = '<dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-webmvc</artifactId></dependency>';
const plugin = '<plugin><groupId>org.springframework.boot</groupId><artifactId>spring-boot-maven-plugin</artifactId></plugin>';
const pom = (extra = '', selectedParent = parent, deps = dependency, selectedPlugin = plugin) => `<project><modelVersion>4.0.0</modelVersion>${selectedParent}<groupId>demo</groupId><artifactId>app</artifactId><version>1</version><dependencies>${deps}</dependencies><build><plugins>${selectedPlugin}</plugins></build>${extra}</project>`;
const java = {
    'src/main/java/demo/Api.java': '// 😀 original\r\npackage demo;\r\nimport org.springframework.web.bind.annotation.RestController;\r\nimport org.springframework.web.bind.annotation.GetMapping;\r\n@RestController public class Api {\r\n @GetMapping("/maven-boot") public String read(){return Service.read();}\r\n}\r\n',
    'src/main/java/demo/Service.java': 'package demo; public class Service { public static String read(){return "ok";} }',
};
async function put(root: string, file: string, text: string) { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), text); }
async function repository(files: Record<string, string>) { const root = await mkdtemp(path.join(tmpdir(), 'codiluce-boot-maven-')); roots.push(root); for (const [file, text] of Object.entries(files)) await put(root, file, text); return root; }
async function index(root: string, cache?: AnalysisCache, revision?: string, appPath = '.', stack: 'mvc' | 'webflux' = 'mvc') {
    return indexRepository(root, { config: await resolveConfig(root, { repository: { name: 'boot-maven' }, applications: [{ name: 'server', path: appPath, jvm: { buildSystem: 'maven', spring: { stack, componentScan: ['demo'] } } }] }), cache, revision });
}
const projects = (graph: SoftwareGraph) => graph.entities.find(entity => entity.type === 'repository')!.metadata.jvmProjects as JvmProject[];
const routes = (graph: SoftwareGraph) => graph.entities.filter(entity => entity.type === 'api_endpoint');
const whole = (graph: SoftwareGraph) => { const copy = structuredClone(graph); copy.run.id = ''; copy.run.analyzedAt = ''; return canonicalJson(copy); };

test('Pinned explicit external Boot Maven parent retains original Java handler/leaf, managed spelling and compiler evidence', async () => {
    const root = await repository({ 'pom.xml': '// invalid XML prefix' });
    await put(root, 'pom.xml', '<?xml version="1.0"?>\r\n<!-- 😀 original -->\r\n' + pom('<properties><java.version>17</java.version></properties>'));
    for (const [file, text] of Object.entries(java)) await put(root, file, text);
    const graph = await index(root), model = projects(graph)[0]!;
    assert.deepEqual(model.gaps, []); assert.equal(model.bootBom?.frameworkVersion, '7.0.9'); assert.equal(model.bootBom?.externalResolutionVerified, false);
    assert.equal(model.bootMavenParent?.compilerParameters, true); assert.equal(model.bootMavenParent?.sourceEncoding, 'UTF-8');
    const selected = model.dependencies.find(dep => dep.coordinate === 'org.springframework.boot:spring-boot-starter-webmvc:4.0.8')!;
    assert.equal(selected.declaredCoordinate, 'org.springframework.boot:spring-boot-starter-webmvc');
    assert.ok(selected.proof.some(fact => fact.file === 'pom.xml' && fact.line === 3 && fact.analyzerVersion === '6' && fact.explanation?.includes('never resolve or execute')));
    assert.equal(routes(graph).length, 1); const route = routes(graph)[0]!; assert.equal(route.metadata.constraintsUnresolved, false, JSON.stringify(graph.diagnostics));
    const handler = graph.entities.find(entity => entity.path?.endsWith('Api.java') && entity.name === 'read')!, leaf = graph.entities.find(entity => entity.path?.endsWith('Service.java') && entity.name === 'read')!;
    assert.ok(graph.relations.some(edge => edge.type === 'handles' && edge.from === route.id && edge.to === handler.id));
    assert.ok(graph.relations.some(edge => edge.type === 'calls' && edge.from === handler.id && edge.to === leaf.id)); assert.equal(handler.sourceRange?.startLine, 6);
});

test('Boot Maven WebFlux starter retains original functional handlers while WebClient alone supplies no server module', async () => {
    const source = `package demo;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Bean;
import org.springframework.web.reactive.function.server.RouterFunction;
import org.springframework.web.reactive.function.server.RouterFunctions;
import org.springframework.web.reactive.function.server.ServerResponse;
import org.springframework.web.reactive.function.server.ServerRequest;
import reactor.core.publisher.Mono;
@Configuration(proxyBeanMethods=false) public class Router {
 @Bean public RouterFunction<ServerResponse> routes(){return RouterFunctions.route().GET("/maven-flux",this::hello).build();}
 private Mono<ServerResponse> hello(ServerRequest request){return ServerResponse.ok().bodyValue("Hello");}
}`;
    const root = await repository({ 'pom.xml': pom('', parent, dependency.replace('webmvc', 'webflux')), 'src/main/java/demo/Router.java': source });
    const graph = await index(root, undefined, undefined, '.', 'webflux');
    assert.deepEqual(projects(graph)[0]!.gaps, []); assert.equal(routes(graph).length, 1); assert.equal(routes(graph)[0]!.metadata.constraintsUnresolved, false);
    assert.ok(graph.relations.some(edge => edge.type === 'handles' && edge.from === routes(graph)[0]!.id && graph.entities.find(entity => entity.id === edge.to)?.name === 'hello'));
    await put(root, 'pom.xml', pom('', parent, dependency.replace('webmvc', 'webclient')));
    const clientOnly = await index(root, undefined, undefined, '.', 'webflux');
    assert.ok(!projects(clientOnly)[0]!.dependencies.some(dep => dep.coordinate?.startsWith('org.springframework:spring-webflux:')));
    assert.ok(routes(clientOnly).every(route => route.metadata.constraintsUnresolved));
});

test('Boot parent coordinate inheritance and literal Java property interpolation preserve standard Maven values', async () => {
    const root = await repository({ 'pom.xml': pom('<properties><selected.java>21</selected.java><java.version>${selected.java}</java.version></properties>').replace('<groupId>demo</groupId>', '').replace('<version>1</version>', ''), ...java });
    const graph = await index(root), model = projects(graph)[0]!;
    assert.equal(model.coordinate, 'org.springframework.boot:app:4.0.8'); assert.equal(model.properties['java.version'], '${selected.java}'); assert.deepEqual(model.gaps, []); assert.equal(routes(graph).length, 1);
});

test('A local Maven parent can inherit the pinned Boot contract without losing source/root ownership', async () => {
    const outer = pom('<packaging>pom</packaging><modules><module>app</module></modules><properties><java.version>21</java.version></properties>', parent, '', '').replace('<artifactId>app</artifactId>', '<artifactId>root</artifactId>');
    const localParent = '<parent><groupId>demo</groupId><artifactId>root</artifactId><version>1</version></parent>';
    const child = pom('', localParent).replace('<groupId>demo</groupId><artifactId>app</artifactId><version>1</version>', '<artifactId>app</artifactId>');
    const root = await repository({ 'pom.xml': outer, 'app/pom.xml': child, ...Object.fromEntries(Object.entries(java).map(([file, text]) => ['app/' + file, text])) });
    const graph = await index(root, undefined, undefined, 'app'), model = projects(graph).find(project => project.root === 'app')!;
    assert.deepEqual(model.gaps, []); assert.equal(model.coordinate, 'demo:app:1'); assert.equal(model.properties['java.version'], '21'); assert.equal(routes(graph).length, 1);
});

test('Absent, conflicting, custom or unreviewed Maven parent selection never falls through to a Boot guess', async () => {
    for (const selectedParent of [parent.replace('<relativePath/>', ''), parent.replace('<relativePath/>', '<relativePath>../other.xml</relativePath>'), parent.replace('4.0.8', '4.0.9'), parent.replace('4.0.8', '${boot.version}'), parent.replace('</parent>', '<version>4.0.8</version></parent>')]) {
        const root = await repository({ 'pom.xml': pom('', selectedParent), ...java }), graph = await index(root);
        assert.ok(projects(graph)[0]!.gaps.length); assert.equal(routes(graph).length, 0);
    }
});

test('Published BOM/compiler/resource overrides, custom Boot plugins and Maven command files stay explicit boundaries', async () => {
    for (const extra of ['<properties><spring-framework.version>6.2.19</spring-framework.version></properties>', '<properties><reactor-bom.version>2020.0.0</reactor-bom.version></properties>', '<properties><maven.compiler.release>8</maven.compiler.release></properties>', '<properties><java.version>8</java.version></properties>', '<properties><java.version>17<unsupported/></java.version></properties>', '<properties><project.build.sourceEncoding>UTF-16</project.build.sourceEncoding></properties>']) {
        const graph = await index(await repository({ 'pom.xml': pom(extra), ...java })); assert.ok(projects(graph)[0]!.gaps.length); assert.equal(routes(graph).length, 0);
    }
    for (const addition of ['<configuration><profiles>prod</profiles></configuration>', '<executions/>', '<extensions>true</extensions>', '<version>${missing}</version>', '<version>4.0.9</version>']) {
        const graph = await index(await repository({ 'pom.xml': pom('', parent, dependency, plugin.replace('</plugin>', addition + '</plugin>')), ...java })); assert.ok(projects(graph)[0]!.gaps.length); assert.equal(routes(graph).length, 0);
    }
    for (const selectedPlugin of ['<plugin><artifactId>maven-compiler-plugin</artifactId><version>other</version></plugin>', '<plugin><artifactId>maven-resources-plugin</artifactId><configuration><encoding>UTF-16</encoding></configuration></plugin>']) {
        const graph = await index(await repository({ 'pom.xml': pom('', parent, dependency, selectedPlugin), ...java })); assert.ok(projects(graph)[0]!.gaps.length); assert.equal(routes(graph).length, 0);
    }
    const root = await repository({ 'pom.xml': pom(), '.mvn/maven.config': '-Dspring-framework.version=6.2.19\n', ...java }); const graph = await index(root);
    assert.ok(projects(graph)[0]!.gaps.some(gap => gap.includes('command/JVM'))); assert.equal(routes(graph).length, 0);
});

test('Managed transitive conflicts, exclusions and unlisted versionless coordinates cannot invent a complete Boot classpath', async () => {
    const override = '<dependencyManagement><dependencies><dependency><groupId>org.springframework</groupId><artifactId>spring-webmvc</artifactId><version>6.2.19</version></dependency></dependencies></dependencyManagement>';
    const excluded = dependency.replace('</dependency>', '<exclusions><exclusion><groupId>org.springframework</groupId><artifactId>spring-webmvc</artifactId></exclusion></exclusions></dependency>');
    const unknown = dependency + '<dependency><groupId>other</groupId><artifactId>library</artifactId></dependency>';
    for (const [extra, deps] of [[override, dependency], ['', excluded], ['', unknown]]) { const graph = await index(await repository({ 'pom.xml': pom(extra, parent, deps), ...java })); assert.equal(routes(graph).length, 0); }
});

test('Explicit unresolved Maven dependency versions cannot fall back to reviewed managed defaults', async () => {
    for (const version of ['${missing}', '']) {
        const selected = dependency.replace('</dependency>', `<version>${version}</version></dependency>`);
        const graph = await index(await repository({ 'pom.xml': pom('', parent, selected), ...java })), model = projects(graph)[0]!;
        assert.equal(model.dependencies[0]?.coordinate, undefined); assert.equal(model.dependencies[0]?.managedBy, undefined); assert.ok(model.dependencies[0]?.reason); assert.equal(routes(graph).length, 0);
    }
});

test('Maven parent/BOM source changes invalidate caches and retain complete same-mode cold/warm/revision graphs', async () => {
    const root = await repository({ 'pom.xml': pom(), ...java }), state = await mkdtemp(path.join(tmpdir(), 'codiluce-maven-boot-cache-')); roots.push(state);
    const cache = new AnalysisCache(state), cold = await index(root, cache), warm = await index(root, cache); assert.equal(whole(cold), whole(warm));
    await put(root, 'pom.xml', pom('', parent.replace('4.0.8', '4.0.9'))); assert.equal(routes(await index(root, cache)).length, 0);
    await put(root, 'pom.xml', pom()); assert.equal(whole(await index(root, cache)), whole(cold));
    const revision = await index(root, new AnalysisCache(state), 'maven-boot-revision'), fresh = await index(root, undefined, 'maven-boot-revision'); assert.equal(whole(revision), whole(fresh));
});
