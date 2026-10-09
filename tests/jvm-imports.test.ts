import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { indexRepository } from '../src/pipeline/index.js';
import { resolveConfig, type ApplicationInput } from '../src/core/config.js';
import { AnalysisCache } from '../src/pipeline/cache.js';
import { canonicalJson } from '../src/history/fingerprint.js';
import type { SoftwareGraph } from '../src/core/graph.js';
import { grammarCatalog } from '../src/analysis/tree-sitter/grammars.js';
import { readPomXml, gradleTokens } from '../src/analysis/resolution/jvm-manifest.js';
const roots: string[] = [];
after(async () => { await Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))); });
async function put(root: string, file: string, text: string) { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), text); }
async function repository(files: Record<string, string>) {
    const root = await mkdtemp(path.join(tmpdir(), 'codiluce-jvm-'));
    roots.push(root);
    for (const [file, text] of Object.entries(files))
        await put(root, file, text);
    return root;
}
async function index(root: string, applications?: ApplicationInput[], cache?: AnalysisCache, revision?: string, ignore?: string[]) { return indexRepository(root, { config: await resolveConfig(root, { repository: { name: 'jvm-fixture' }, applications, ignore }), cache, revision }); }
const unit = (graph: SoftwareGraph, name: string) => graph.entities.find(entity => entity.type === 'file' && entity.path === name)!;
const imports = (graph: SoftwareGraph, name: string) => unit(graph, name).metadata.importOutcomes as {
    specifier: string;
    kind: string;
    local: string;
    range: {
        startLine: number;
    };
    outcome: {
        status: string;
        targets?: string[];
        declarations?: string[];
        reason?: string;
    };
}[];
const statuses = (graph: SoftwareGraph, name: string) => imports(graph, name).map(item => item.outcome.status);
const shape = (graph: SoftwareGraph) => canonicalJson({ entities: graph.entities, relations: graph.relations, diagnostics: graph.diagnostics.filter(item => !['git-metrics', 'indexer'].includes(item.analyzer) && item.code !== 'git-ignore-unavailable') });
const pom = (name: string, extra = '') => `<project><modelVersion>4.0.0</modelVersion><groupId>demo</groupId><artifactId>${name}</artifactId><version>1.0</version>${extra}</project>`;
const dep = (name: string, scope = '', extra = '') => `<dependency><groupId>demo</groupId><artifactId>${name}</artifactId><version>1.0</version>${scope ? `<scope>${scope}</scope>` : ''}${extra}</dependency>`;
const configured: ApplicationInput = { name: 'jvm', path: '.', ecosystems: ['jvm'], sourceRoots: { java: ['java'], kotlin: ['kotlin'] }, jvm: { dependencies: [] } };
test('Maven XML and Gradle literal readers reject opaque/entity/malformed inputs without execution', () => {
    assert.ok(readPomXml('<?xml version="1.0"?><project xmlns="http://maven.apache.org/POM/4.0.0"><artifactId>x&amp;y</artifactId><!-- comment --></project>'));
    for (const text of ['<!DOCTYPE project SYSTEM "file:///tmp/x"><project/>', '<project>&evil;</project>', '<project><a></project>', '<project/><project/>', '<project><!-- broken', '<project><a x=no/></project>'])
        assert.equal(readPomXml(text), undefined, text);
    assert.ok(readPomXml('<project><?m2e ignore?><artifactId><![CDATA[x&y]]></artifactId></project>'));
    assert.ok(gradleTokens('plugins { id("java") }; // comment\ndependencies { implementation(project(":lib")) }'));
    for (const text of ['plugins { id("java")', 'include("${target}")', 'include("x\\n")', '/* bad', 'include("""raw""")'])
        assert.equal(gradleTokens(text), undefined, text);
});
test('Configured Java imports bind nested types and static overload sets with original proof', async () => {
    const root = await repository({ 'java/demo/Outer.java': 'package demo; public class Outer { public static class Inner {} public static int VALUE=1; public static void run(){} public static void run(int x){} private static void hidden(){} public void instance(){} }', 'java/client/Use.java': '// 😀 original\r\npackage client;\r\nimport demo.Outer;\r\nimport demo.Outer.Inner;\r\nimport static demo.Outer.VALUE;\r\nimport static demo.Outer.run;\r\nimport static demo.Outer.*;\r\nimport static demo.Outer.hidden;\r\nimport static demo.Outer.instance;\r\nimport java.util.List;\r\npublic class Use {}' }), graph = await index(root, [configured]);
    assert.deepEqual(statuses(graph, 'java/client/Use.java'), ['resolved', 'resolved', 'resolved', 'resolved', 'resolved', 'unresolved', 'unresolved', 'external']);
    const overload = imports(graph, 'java/client/Use.java')[3]!;
    assert.equal(overload.outcome.declarations?.length, 2);
    assert.equal(overload.range.startLine, 6);
    const edge = graph.relations.find(edge => edge.type === 'imports' && edge.metadata?.specifier === 'demo.Outer.run')!;
    assert.equal(graph.entities.find(entity => entity.id === edge.to)?.path, 'java/demo/Outer.java');
    assert.ok(edge.evidence.some(item => item.file === 'java/client/Use.java' && item.line === 6));
    assert.ok(edge.evidence.some(item => item.file === 'java/demo/Outer.java' && item.line === 1));
    assert.equal((unit(graph, 'java/client/Use.java').metadata.analysis as any).features.references.status, 'partial');
    assert.equal(graph.relations.filter(edge => edge.type === 'calls').length, 0);
});
test('Kotlin aliases, top-level functions/properties/typealiases and Java interop use original declarations', async () => {
    const root = await repository({ 'kotlin/demo/Tools.kt': 'package demo\npublic class Thing\ninternal class Internal\nprivate class Private\ntypealias Alias = Thing\nval VALUE = 1\nfun run() {}\nobject Registry {\n fun load() {}\n}\n', 'java/demo/Outer.java': 'package demo; public class Outer { public static class Inner {} public static void run() {} }', 'kotlin/client/Use.kt': 'package client\nimport demo.Thing as Imported\nimport demo.Alias\nimport demo.VALUE\nimport demo.run\nimport demo.Internal\nimport demo.Private\nimport demo.Outer.Inner\nimport demo.Outer.run as javaRun\nimport demo.Registry.load\nimport demo.*\nclass Use\n' }), graph = await index(root, [configured]);
    assert.deepEqual(statuses(graph, 'kotlin/client/Use.kt'), ['resolved', 'resolved', 'resolved', 'resolved', 'resolved', 'unresolved', 'resolved', 'resolved', 'resolved', 'resolved'], JSON.stringify(graph.diagnostics));
    assert.equal(imports(graph, 'kotlin/client/Use.kt')[0]?.local, 'Imported');
    const names = imports(graph, 'kotlin/client/Use.kt').flatMap(item => item.outcome.declarations ?? []).map(id => graph.entities.find(entity => entity.id === id)?.name);
    for (const name of ['Thing', 'Alias', 'VALUE', 'run', 'Internal', 'Inner', 'load'])
        assert.ok(names.includes(name), name);
});
test('Maven reactors expose only selected dependency projects, never siblings or coordinate lookalikes', async () => {
    const root = await repository({ 'pom.xml': pom('root', '<packaging>pom</packaging><modules><module>app</module><module>lib</module><module>other</module></modules>'), 'app/pom.xml': pom('app', `<dependencies>${dep('lib')}</dependencies>`), 'lib/pom.xml': pom('lib'), 'other/pom.xml': pom('other'), 'outside/pom.xml': pom('lib'), 'app/src/main/java/client/Use.java': 'package client; import demo.Widget; import hidden.Other; public class Use {}', 'lib/src/main/java/demo/Widget.java': 'package demo; public class Widget {}', 'other/src/main/java/hidden/Other.java': 'package hidden; public class Other {}', 'outside/src/main/java/demo/Widget.java': 'package demo; public class Widget {}' }), graph = await index(root);
    assert.deepEqual(statuses(graph, 'app/src/main/java/client/Use.java'), ['resolved', 'external']);
    const outcome = imports(graph, 'app/src/main/java/client/Use.java')[0]!.outcome;
    assert.equal(graph.entities.find(entity => entity.id === outcome.targets?.[0])?.path, 'lib/src/main/java/demo/Widget.java');
});
test('Maven parents, property interpolation, dependency management and selected profiles preserve source roots', async () => {
    const parent = '<parent><groupId>demo</groupId><artifactId>root</artifactId><version>1.0</version></parent>';
    const root = await repository({ 'pom.xml': pom('root', `<packaging>pom</packaging><properties><lib.version>1.0</lib.version></properties><dependencyManagement><dependencies><dependency><groupId>demo</groupId><artifactId>lib</artifactId><version>${'${lib.version}'}</version></dependency></dependencies></dependencyManagement><modules><module>app</module><module>lib</module></modules>`), 'app/pom.xml': `<project><modelVersion>4.0.0</modelVersion>${parent}<artifactId>app</artifactId><profiles><profile><id>local</id><dependencies><dependency><groupId>demo</groupId><artifactId>lib</artifactId></dependency></dependencies></profile></profiles><build><sourceDirectory>sources</sourceDirectory></build></project>`, 'lib/pom.xml': pom('lib'), 'app/sources/client/Use.java': 'package client; import demo.Widget; public class Use {}', 'lib/src/main/java/demo/Widget.java': 'package demo; public class Widget {}' });
    const uncertain = await index(root);
    assert.deepEqual(statuses(uncertain, 'app/sources/client/Use.java'), ['unsupported']);
    const graph = await index(root, [{ name: 'app', path: 'app', jvm: { profiles: ['local'] } }]);
    assert.deepEqual(statuses(graph, 'app/sources/client/Use.java'), ['resolved'], JSON.stringify(graph.diagnostics));
});
test('Maven source-set and dependency scopes separate main/test and runtime-only paths', async () => {
    const root = await repository({ 'pom.xml': pom('root', '<packaging>pom</packaging><modules><module>a</module><module>b</module><module>c</module></modules>'), 'a/pom.xml': pom('a', `<dependencies>${dep('b', 'test')}${dep('c', 'runtime')}</dependencies>`), 'b/pom.xml': pom('b'), 'c/pom.xml': pom('c'), 'a/src/main/java/client/Main.java': 'package client; import demo.TestOnly; import demo.RuntimeOnly; public class Main {}', 'a/src/test/java/client/Test.java': 'package client; import demo.TestOnly; import demo.RuntimeOnly; import client.Main; public class Test {}', 'b/src/main/java/demo/TestOnly.java': 'package demo; public class TestOnly {}', 'c/src/main/java/demo/RuntimeOnly.java': 'package demo; public class RuntimeOnly {}' });
    const main = await index(root);
    assert.deepEqual(statuses(main, 'a/src/main/java/client/Main.java'), ['external', 'external']);
    assert.deepEqual(statuses(main, 'a/src/test/java/client/Test.java'), ['excluded', 'excluded', 'excluded']);
    const tests = await index(root, [{ name: 'a', path: 'a', jvm: { sourceSet: 'test' } }]);
    assert.deepEqual(statuses(tests, 'a/src/test/java/client/Test.java'), ['resolved', 'unresolved', 'resolved'], JSON.stringify(tests.diagnostics));
});
test('Gradle Groovy and Kotlin DSL settings/projectDir remaps preserve api versus implementation dependencies', async () => {
    for (const kts of [false, true]) {
        const ext = kts ? '.kts' : '', root = await repository({ ['settings.gradle' + ext]: kts ? 'rootProject.name="shop"\ninclude(":app", ":lib", ":deep", ":hidden")\nproject(":lib").projectDir = file("modules/library")' : 'rootProject.name = "shop"\ninclude ":app", ":lib", ":deep", ":hidden"\nproject(":lib").projectDir = file("modules/library")', ['build.gradle' + ext]: 'plugins { id("java") }', ['app/build.gradle' + ext]: 'plugins { id("java") }\ndependencies { implementation(project(":lib")) }', ['modules/library/build.gradle' + ext]: 'plugins { id("java-library") }\ndependencies { api(project(":deep")); implementation(project(":hidden")) }', ['deep/build.gradle' + ext]: 'plugins { id("java") }', ['hidden/build.gradle' + ext]: 'plugins { id("java") }', 'app/src/main/java/client/Use.java': 'package client; import demo.Widget; import api.Deep; import secret.Hidden; public class Use {}', 'modules/library/src/main/java/demo/Widget.java': 'package demo; public class Widget {}', 'deep/src/main/java/api/Deep.java': 'package api; public class Deep {}', 'hidden/src/main/java/secret/Hidden.java': 'package secret; public class Hidden {}' });
        const graph = await index(root);
        assert.deepEqual(statuses(graph, 'app/src/main/java/client/Use.java'), ['resolved', 'resolved', 'external'], JSON.stringify(graph.diagnostics));
    }
});
test('Java package-private and nested owners plus Kotlin module-internal visibility constrain bindings', async () => {
    const root = await repository({ 'pom.xml': pom('root', '<packaging>pom</packaging><modules><module>a</module><module>b</module></modules>'), 'a/pom.xml': pom('a', `<dependencies>${dep('b')}</dependencies>`), 'b/pom.xml': pom('b'), 'a/src/main/java/client/Use.java': 'package client; import demo.Hidden; import demo.Hidden.Nested; public class Use {}', 'a/src/main/java/demo/Local.java': 'package demo; import demo.Hidden; public class Local {}', 'b/src/main/java/demo/Hidden.java': 'package demo; class Hidden { public static class Nested {} }', 'b/src/main/kotlin/demo/Internal.kt': 'package demo\ninternal class Internal\n', 'a/src/main/kotlin/client/Use.kt': 'package client\nimport demo.Internal\nclass Use\n' });
    const graph = await index(root, [{ name: 'a', path: 'a', sourceRoots: { kotlin: ['src/main/kotlin'] } }, { name: 'b', path: 'b', sourceRoots: { kotlin: ['src/main/kotlin'] } }]);
    assert.deepEqual(statuses(graph, 'a/src/main/java/client/Use.java'), ['unresolved', 'unresolved']);
    assert.deepEqual(statuses(graph, 'a/src/main/java/demo/Local.java'), ['resolved']);
    assert.deepEqual(statuses(graph, 'a/src/main/kotlin/client/Use.kt'), ['unresolved']);
});
test('Duplicate types and conflicting aliases remain ambiguous while wildcard imports retain export sets', async () => {
    const root = await repository({ 'java/demo/One.java': 'package demo; public class Same {}', 'java/demo/Two.java': 'package demo; public class Same {}', 'java/other/Thing.java': 'package other; public class Thing {}', 'java/client/Use.java': 'package client; import demo.Same; import demo.*; public class Use {}', 'kotlin/client/Use.kt': 'package client\nimport demo.Same as X\nimport other.Thing as X\nclass Use\n' }), graph = await index(root, [configured]);
    assert.deepEqual(statuses(graph, 'java/client/Use.java'), ['ambiguous', 'ambiguous']);
    assert.deepEqual(statuses(graph, 'kotlin/client/Use.kt'), ['ambiguous', 'ambiguous']);
    assert.equal(graph.relations.filter(edge => edge.type === 'imports').length, 0);
});
test('Denied, symlinked, broken, unselected and JPMS inputs cannot certify an import', async () => {
    const root = await repository({ 'pom.xml': pom('app'), 'src/main/java/client/Use.java': 'package client; import demo.Widget; public class Use {}', 'src/main/java/demo/Widget.java': 'package demo; public class Widget {}' });
    const denied = await index(root, undefined, undefined, undefined, ['src/main/java/demo/Widget.java']);
    assert.equal(imports(denied, 'src/main/java/client/Use.java')[0]?.outcome.status, 'excluded');
    await put(root, 'src/main/java/demo/Widget.java', 'package demo; public class Widget {');
    const broken = await index(root);
    assert.equal(imports(broken, 'src/main/java/client/Use.java')[0]?.outcome.status, 'unsupported');
    await put(root, 'src/main/java/demo/Widget.java', 'package demo; public class Widget {}');
    await put(root, 'src/main/java/module-info.java', 'module app { exports demo; }');
    const module = await index(root);
    assert.equal(imports(module, 'src/main/java/client/Use.java')[0]?.outcome.status, 'unsupported');
    const link = await repository({ 'pom.xml': pom('app'), 'src/main/java/client/Use.java': 'package client; import demo.Widget; public class Use {}', 'original.java': 'package demo; public class Widget {}' });
    await mkdir(path.join(link, 'src/main/java/demo'), { recursive: true });
    await symlink('../../../original.java', path.join(link, 'src/main/java/demo/Widget.java'));
    assert.equal(imports(await index(link), 'src/main/java/client/Use.java')[0]?.outcome.status, 'excluded');
});
test('Opaque Maven/Gradle profile, plugin and DSL mutations retain diagnostics and no invented imports', async () => {
    for (const manifest of [pom('app', '<parent><groupId>external</groupId><artifactId>parent</artifactId><version>1</version><relativePath/></parent>'), pom('app', '<build><plugins><plugin><artifactId>build-helper-maven-plugin</artifactId></plugin></plugins></build>'), '<!DOCTYPE project><project/>']) {
        const root = await repository({ 'pom.xml': manifest, 'src/main/java/client/Use.java': 'package client; import demo.Widget; public class Use {}', 'src/main/java/demo/Widget.java': 'package demo; public class Widget {}' }), graph = await index(root);
        assert.deepEqual(statuses(graph, 'src/main/java/client/Use.java'), ['unsupported']);
    }
    for (const script of ['plugins { id("java") }; if (enabled) { dependencies { implementation(project(":lib")) } }', 'plugins { id("java") }; sourceSets { main { java.srcDir("other") } }', 'plugins { alias(libs.plugins.java) }']) {
        const root = await repository({ 'build.gradle.kts': script, 'src/main/java/client/Use.java': 'package client; import demo.Widget; public class Use {}', 'src/main/java/demo/Widget.java': 'package demo; public class Widget {}' }), graph = await index(root);
        assert.deepEqual(statuses(graph, 'src/main/java/client/Use.java'), ['unsupported']);
    }
});
test('JVM cache/revision equality invalidates shared manifests, sources, scopes and configured roots', async () => {
    const root = await repository({ 'pom.xml': pom('root', '<packaging>pom</packaging><modules><module>a</module><module>b</module></modules>'), 'a/pom.xml': pom('a', `<dependencies>${dep('b')}</dependencies>`), 'b/pom.xml': pom('b'), 'a/src/main/java/client/Use.java': '// 😀\r\npackage client;\r\nimport demo.Widget;\r\npublic class Use {}', 'b/src/main/java/demo/Widget.java': 'package demo; public class Widget {}' }), state = await repository({});
    async function replay() { const cold = await index(root, undefined, undefined, 'pinned'), warm = await index(root, undefined, new AnalysisCache(state)); assert.equal(shape(cold), shape(warm)); return warm; }
    let graph = await replay();
    assert.deepEqual(statuses(graph, 'a/src/main/java/client/Use.java'), ['resolved']);
    assert.equal(imports(graph, 'a/src/main/java/client/Use.java')[0]?.range.startLine, 3);
    await put(root, 'b/src/main/java/demo/Widget.java', 'package demo; class Widget {}');
    graph = await replay();
    assert.deepEqual(statuses(graph, 'a/src/main/java/client/Use.java'), ['unresolved']);
    await put(root, 'a/pom.xml', pom('a', `<dependencies>${dep('b', 'runtime')}</dependencies>`));
    graph = await replay();
    assert.deepEqual(statuses(graph, 'a/src/main/java/client/Use.java'), ['external']);
});
test('JVM explicit input validation rejects malformed selections and outside paths', async () => {
    const root = await repository({ 'java/Use.java': 'class Use {}' });
    for (const jvm of [{ sourceSet: 'all' }, { profiles: 'test' }, { profiles: ['x', 'x'] }, { dependencies: ['../../outside'] }, { dependencies: ['/tmp'] }, { dependencies: ['C:\\tmp'] }, { dependencies: ['$runtime'] }, { dependencies: ['x'.repeat(2049)] }, { unknown: true }])
        await assert.rejects(resolveConfig(root, { applications: [{ ...configured, jvm: jvm as any }] }));
});
test('Maven child properties re-evaluate inherited dependency management and source directories', async () => {
    const parent = '<parent><groupId>demo</groupId><artifactId>root</artifactId><version>1.0</version></parent>';
    const root = await repository({ 'pom.xml': pom('root', '<packaging>pom</packaging><properties><lib.version>1.0</lib.version><source.path>old</source.path></properties><dependencyManagement><dependencies><dependency><groupId>demo</groupId><artifactId>lib</artifactId><version>${lib.version}</version></dependency></dependencies></dependencyManagement><build><sourceDirectory>${source.path}</sourceDirectory></build><modules><module>app</module><module>lib</module></modules>'), 'app/pom.xml': `<project><modelVersion>4.0.0</modelVersion>${parent}<artifactId>app</artifactId><properties><lib.version>2.0</lib.version><source.path>sources</source.path></properties><dependencies><dependency><groupId>demo</groupId><artifactId>lib</artifactId></dependency></dependencies></project>`, 'lib/pom.xml': pom('lib').replace('<version>1.0</version>', '<version>2.0</version>'), 'app/sources/client/Use.java': 'package client; import demo.Widget; public class Use {}', 'lib/src/main/java/demo/Widget.java': 'package demo; public class Widget {}' });
    const graph = await index(root);
    assert.deepEqual(statuses(graph, 'app/sources/client/Use.java'), ['resolved']);
    const edge = graph.relations.find(edge => edge.type === 'imports')!;
    assert.ok(edge.evidence.some(item => item.file === 'pom.xml'));
    assert.ok(edge.evidence.some(item => item.file === 'app/pom.xml'));
});
test('Maven compile classpaths honor transitive optional, provided and literal exclusions', async () => {
    const root = await repository({ 'pom.xml': pom('root', '<packaging>pom</packaging><modules><module>a</module><module>b</module><module>c</module><module>d</module><module>e</module></modules>'), 'a/pom.xml': pom('a', `<dependencies>${dep('b', '', '<exclusions><exclusion><groupId>demo</groupId><artifactId>c</artifactId></exclusion></exclusions>')}</dependencies>`), 'b/pom.xml': pom('b', `<dependencies>${dep('c')}${dep('d', '', '<optional>true</optional>')}${dep('e', 'provided')}</dependencies>`), 'c/pom.xml': pom('c'), 'd/pom.xml': pom('d'), 'e/pom.xml': pom('e'), 'a/src/main/java/client/Use.java': 'package client; import b.B; import c.C; import d.D; import e.E; public class Use {}', 'b/src/main/java/b/B.java': 'package b; public class B {}', 'c/src/main/java/c/C.java': 'package c; public class C {}', 'd/src/main/java/d/D.java': 'package d; public class D {}', 'e/src/main/java/e/E.java': 'package e; public class E {}' });
    assert.deepEqual(statuses(await index(root), 'a/src/main/java/client/Use.java'), ['resolved', 'external', 'external', 'external']);
});
test('Maven BOMs, custom plugin groups, compiler settings, duplicate XML attributes and model versions retain gaps', async () => {
    const extras = ['<dependencyManagement><dependencies><dependency><groupId>vendor</groupId><artifactId>bom</artifactId><version>1</version><type>pom</type><scope>import</scope></dependency></dependencies></dependencyManagement>', '<build><plugins><plugin><groupId>custom</groupId><artifactId>maven-compiler-plugin</artifactId></plugin></plugins></build>', '<build><plugins><plugin><artifactId>maven-compiler-plugin</artifactId><configuration><compilerArgs><arg>-processor</arg></compilerArgs></configuration></plugin></plugins></build>'];
    for (const manifest of [...extras.map(extra => pom('app', extra)), pom('app').replace('4.0.0', '5.0.0'), pom('app').replace('<project>', '<project x="1" x="2">'), pom('app').replace('<project>', '<project xmlns="urn:lookalike">')]) {
        const root = await repository({ 'pom.xml': manifest, 'src/main/java/client/Use.java': 'package client; import demo.Widget; public class Use {}', 'src/main/java/demo/Widget.java': 'package demo; public class Widget {}' });
        assert.deepEqual(statuses(await index(root), 'src/main/java/client/Use.java'), ['unsupported']);
    }
});
test('Gradle arbitrary words, plugin flags, dependency customization and shared build effects cannot certify imports', async () => {
    for (const [settings, script] of [['include(":app")\nmutateProjects()', 'plugins { id("java") }'], ['include(":app")', 'plugins { id("java") }\nsubprojects { sourceSets { main { java.srcDir("hidden") } } }'], ['include(":app")', 'plugins { id("java") apply false }'], ['include(":app")', 'val text = "java"'], ['include(":app")', 'plugins { id("java") }\ndependencies { implementation("x:y:1") { exclude(group="x") } }'], ['include(":app")', 'plugins { id("java"); id("custom.plugin") }']]) {
        const root = await repository({ 'settings.gradle.kts': settings!, 'build.gradle.kts': script!, 'app/build.gradle.kts': 'plugins { id("java") }', 'app/src/main/java/client/Use.java': 'package client; import demo.Widget; public class Use {}', 'app/src/main/java/demo/Widget.java': 'package demo; public class Widget {}' });
        assert.deepEqual(statuses(await index(root), 'app/src/main/java/client/Use.java'), ['unsupported']);
    }
});
test('Gradle Java-only plugins do not select Kotlin roots; literal Kotlin JVM plugins do', async () => {
    const root = await repository({ 'build.gradle.kts': 'plugins { java }\nrepositories { mavenCentral() }', 'src/main/java/client/Use.java': 'package client; import demo.Widget; public class Use {}', 'src/main/kotlin/demo/Widget.kt': 'package demo\nclass Widget\n' });
    assert.deepEqual(statuses(await index(root), 'src/main/java/client/Use.java'), ['external']);
    await put(root, 'build.gradle.kts', 'plugins { kotlin("jvm") version "2.2.0" }\nrepositories { mavenCentral() }');
    assert.deepEqual(statuses(await index(root), 'src/main/java/client/Use.java'), ['resolved']);
});
test('Dependency projects never expose their selected test sources as production artifacts', async () => {
    const root = await repository({ 'pom.xml': pom('root', '<packaging>pom</packaging><modules><module>a</module><module>b</module></modules>'), 'a/pom.xml': pom('a', `<dependencies>${dep('b')}</dependencies>`), 'b/pom.xml': pom('b'), 'a/src/main/java/client/Use.java': 'package client; import demo.TestOnly; public class Use {}', 'b/src/test/java/demo/TestOnly.java': 'package demo; public class TestOnly {}' });
    assert.deepEqual(statuses(await index(root, [{ name: 'b', path: 'b', jvm: { sourceSet: 'test' } }]), 'a/src/main/java/client/Use.java'), ['external']);
});
test('Excluded competitors and pruned directories block even an otherwise positive local declaration', async () => {
    const files = { 'pom.xml': pom('app'), 'src/main/java/client/Use.java': 'package client; import demo.Widget; public class Use {}', 'src/main/java/demo/Widget.java': 'package demo; public class Widget {}', 'src/main/java/competitor/Widget.java': 'package demo; public class Widget {}' };
    const root = await repository(files);
    assert.deepEqual(statuses(await index(root, undefined, undefined, undefined, ['src/main/java/competitor/Widget.java']), 'src/main/java/client/Use.java'), ['excluded']);
    assert.deepEqual(statuses(await index(root, undefined, undefined, undefined, ['src/main/java/competitor']), 'src/main/java/client/Use.java'), ['excluded']);
});
test('Kotlin object star imports and private member imports retain access constraints', async () => {
    const root = await repository({ 'kotlin/demo/Tools.kt': 'package demo\nobject Tools {\n private fun hidden() {}\n fun run() {}\n class Nested\n}\n', 'kotlin/client/Use.kt': 'package client\nimport demo.Tools.*\nimport demo.Tools.hidden\nimport demo.Tools.run\nclass Use\n' });
    assert.deepEqual(statuses(await index(root, [configured]), 'kotlin/client/Use.kt'), ['unresolved', 'unresolved', 'resolved']);
});
test('Java import and declaration IDs survive source line shifts while ranges update', async () => {
    const root = await repository({ 'java/demo/Widget.java': 'package demo; public class Widget {}', 'java/client/Use.java': 'package client;\nimport demo.Widget;\npublic class Use {}' }), before = await index(root, [configured]);
    await put(root, 'java/client/Use.java', '// 😀 new line\r\npackage client;\r\nimport demo.Widget;\r\npublic class Use {}');
    const after = await index(root, [configured]);
    assert.deepEqual(before.relations.filter(edge => edge.type === 'imports').map(edge => edge.id), after.relations.filter(edge => edge.type === 'imports').map(edge => edge.id));
    assert.deepEqual(imports(before, 'java/client/Use.java')[0]?.outcome.declarations, imports(after, 'java/client/Use.java')[0]?.outcome.declarations);
    assert.equal(imports(after, 'java/client/Use.java')[0]?.range.startLine, 3);
});
test('Warm JVM import caches cannot replay bindings when a required grammar becomes unavailable', async () => {
    const root = await repository({ 'java/demo/Widget.java': 'package demo; public class Widget {}', 'java/client/Use.java': 'package client; import demo.Widget; public class Use {}' }), state = await repository({});
    assert.deepEqual(statuses(await index(root, [configured], new AnalysisCache(state)), 'java/client/Use.java'), ['resolved']);
    const grammar = grammarCatalog.get('java')!;
    try {
        grammarCatalog.delete('java');
        const graph = await index(root, [configured], new AnalysisCache(state));
        assert.equal(graph.relations.filter(edge => edge.type === 'imports').length, 0);
        assert.equal((unit(graph, 'java/client/Use.java').metadata.analysis as any).features.imports.status, 'failed');
    }
    finally {
        grammarCatalog.set('java', grammar);
    }
    assert.deepEqual(statuses(await index(root, [configured], new AnalysisCache(state)), 'java/client/Use.java'), ['resolved']);
});
test('Competing build systems and Gradle settings constrain every selected workspace project', async () => {
    const root = await repository({ 'pom.xml': pom('app'), 'build.gradle.kts': 'plugins { java }', 'src/main/java/client/Use.java': 'package client; import demo.Widget; public class Use {}', 'src/main/java/demo/Widget.java': 'package demo; public class Widget {}' });
    assert.deepEqual(statuses(await index(root), 'src/main/java/client/Use.java'), ['unsupported']);
    const workspace = await repository({ 'settings.gradle': 'include ":app"', 'settings.gradle.kts': 'include(":other")', 'app/build.gradle': 'plugins { id "java" }', 'app/src/main/java/client/Use.java': 'package client; import demo.Widget; public class Use {}', 'app/src/main/java/demo/Widget.java': 'package demo; public class Widget {}' });
    assert.deepEqual(statuses(await index(workspace), 'app/src/main/java/client/Use.java'), ['unsupported']);
});
test('Truncated Java declaration budgets cannot certify a partial import export set', async () => {
    const source = 'package demo; public class Large {' + Array.from({ length: 21000 }, (_, i) => `public static void member${i}(){}`).join('') + '}';
    const root = await repository({ 'java/demo/Large.java': source, 'java/client/Use.java': 'package client; import static demo.Large.*; public class Use {}' }), graph = await index(root, [configured]);
    assert.ok(graph.diagnostics.some(item => item.file === 'java/demo/Large.java' && item.code === 'syntax-budget-exceeded'));
    assert.deepEqual(statuses(graph, 'java/client/Use.java'), ['unsupported']);
    assert.equal(graph.relations.filter(edge => edge.type === 'imports').length, 0);
});
test('Duplicate and custom-merged Maven compiler/source model fields cannot silently select a fallback', async () => {
    for (const extra of ['<build><sourceDirectory>other</sourceDirectory><sourceDirectory>src/main/java</sourceDirectory></build>', '<build combine.self="override"><sourceDirectory>src/main/java</sourceDirectory></build>', '<build><plugins><plugin><artifactId>maven-compiler-plugin</artifactId><extensions>true</extensions></plugin></plugins></build>']) {
        const root = await repository({ 'pom.xml': pom('app', extra), 'src/main/java/client/Use.java': 'package client; import demo.Widget; public class Use {}', 'src/main/java/demo/Widget.java': 'package demo; public class Widget {}' });
        assert.deepEqual(statuses(await index(root), 'src/main/java/client/Use.java'), ['unsupported']);
    }
});
test('Gradle plugin shorthand respects the Kotlin versus Groovy DSL boundary', async () => {
    for (const [name, script] of [['build.gradle', 'plugins { java }'], ['build.gradle.kts', 'plugins { java-library }'], ['build.gradle.kts', "plugins { id('java') }"], ['build.gradle.kts', 'plugins { id "java" }']]) {
        const root = await repository({ [name!]: script!, 'src/main/java/client/Use.java': 'package client; import demo.Widget; public class Use {}', 'src/main/java/demo/Widget.java': 'package demo; public class Widget {}' });
        assert.deepEqual(statuses(await index(root), 'src/main/java/client/Use.java'), ['unsupported']);
    }
});
test('Kotlin escaped identifiers preserve significant spaces and original declaration names', async () => {
    const root = await repository({ 'kotlin/demo/Names.kt': 'package demo\nfun `with space`() {}\nfun withspace() {}\n', 'kotlin/client/Use.kt': 'package client\nimport demo.`with space` as spaced\nimport demo.withspace as plain\nclass Use\n' }), graph = await index(root, [configured]), outcomes = imports(graph, 'kotlin/client/Use.kt');
    assert.deepEqual(statuses(graph, 'kotlin/client/Use.kt'), ['resolved', 'resolved']);
    assert.equal(graph.entities.find(entity => entity.id === outcomes[0]?.outcome.declarations?.[0])?.name, '`with space`');
    assert.equal(graph.entities.find(entity => entity.id === outcomes[1]?.outcome.declarations?.[0])?.name, 'withspace');
});
test('Java enum constants and implicit interface fields/types retain original static import targets', async () => {
    const root = await repository({ 'java/demo/State.java': 'package demo; public enum State { READY, DONE }', 'java/demo/Contract.java': 'package demo; public interface Contract { int VALUE=1; class Nested {} }', 'java/client/Use.java': 'package client; import static demo.State.READY; import static demo.State.*; import static demo.Contract.VALUE; import static demo.Contract.Nested; public class Use {}' }), graph = await index(root, [configured]);
    assert.deepEqual(statuses(graph, 'java/client/Use.java'), ['resolved', 'resolved', 'resolved', 'resolved']);
    assert.equal(imports(graph, 'java/client/Use.java')[1]?.outcome.declarations?.length, 2);
    assert.equal(graph.entities.find(entity => entity.id === imports(graph, 'java/client/Use.java')[0]?.outcome.declarations?.[0])?.name, 'READY');
});
test('Visible lexical and inheritance boundaries constrain JVM import certification', async () => {
    const root = await repository({ 'java/demo/Widget.java': 'package demo; public class Widget {}', 'java/demo/Hidden.java': '// \\u000apackage demo; public class Widget {}', 'java/client/Use.java': 'package client; import demo.Widget; public class Use {}' });
    assert.deepEqual(statuses(await index(root, [configured]), 'java/client/Use.java'), ['unsupported']);
    const anonymous = await repository({ 'java/demo/Outer.java': 'package demo; public class Outer { public Object value=new Object(){ public class Nested {} }; }', 'java/client/Use.java': 'package client; import demo.Outer.value.Nested; public class Use {}' });
    assert.deepEqual(statuses(await index(anonymous, [configured]), 'java/client/Use.java'), ['unresolved']);
    const inherited = await repository({ 'java/demo/Base.java': 'package demo; public class Base { public static int PARENT=1; }', 'java/demo/Child.java': 'package demo; public class Child extends Base { public static int OWN=1; }', 'java/client/Use.java': 'package client; import static demo.Child.*; import static demo.Child.OWN; public class Use {}' });
    assert.deepEqual(statuses(await index(inherited, [configured]), 'java/client/Use.java'), ['unsupported', 'resolved']);
});
