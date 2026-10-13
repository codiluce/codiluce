import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gradleTokens, readGradleBuild, readGradleSettings } from '../src/analysis/resolution/jvm-manifest.js';
import type { JvmProject } from '../src/analysis/resolution/jvm-projects.js';
import { indexRepository } from '../src/pipeline/index.js';
import { resolveConfig } from '../src/core/config.js';
import type { SoftwareGraph } from '../src/core/graph.js';
import { AnalysisCache } from '../src/pipeline/cache.js';
import { canonicalJson } from '../src/history/fingerprint.js';

const roots: string[] = [];
after(async () => { await Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))); });
async function put(root: string, file: string, text: string) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), text);
}
async function repository(files: Record<string, string>) {
    const root = await mkdtemp(path.join(tmpdir(), 'codiluce-gradle-inputs-')); roots.push(root);
    for (const [file, text] of Object.entries(files)) await put(root, file, text);
    return root;
}
const read = (source: string, kotlin = true) => {
    const tokens = gradleTokens(source); assert.ok(tokens, source);
    return readGradleBuild(tokens, kotlin);
};
const java = {
    'src/main/java/client/Use.java': '// 😀 original\r\npackage client;\r\nimport demo.Widget;\r\npublic class Use {}',
    'src/main/java/demo/Widget.java': 'package demo; public class Widget {}',
};
const kotlin = {
    'src/main/kotlin/client/Use.kt': '// 😀 original\r\npackage client\r\nimport kdemo.Widget\r\nclass Use',
    'src/main/kotlin/kdemo/Widget.kt': 'package kdemo\nclass Widget',
};
const toolchain = 'java { toolchain { languageVersion = JavaLanguageVersion.of(17) } }';
const options = 'kotlin { compilerOptions { freeCompilerArgs.addAll("-Xjsr305=strict", "-java-parameters") } }';
async function index(root: string, cache?: AnalysisCache, revision?: string) {
    return indexRepository(root, { config: await resolveConfig(root, { repository: { name: 'gradle-inputs' }, applications: [{ name: 'server', path: '.', jvm: { buildSystem: 'gradle' } }] }), cache, revision });
}
const projects = (graph: SoftwareGraph) => graph.entities.find(entity => entity.type === 'repository')!.metadata.jvmProjects as JvmProject[];
const statuses = (graph: SoftwareGraph, file: string) => (graph.entities.find(entity => entity.type === 'file' && entity.path === file)!.metadata.importOutcomes as { outcome: { status: string } }[]).map(item => item.outcome.status);
const whole = (graph: SoftwareGraph) => {
    const copy = structuredClone(graph); copy.run.id = ''; copy.run.analyzedAt = ''; return canonicalJson(copy);
};

test('Literal Java toolchain assignments and Property.set preserve their original offsets', () => {
    for (const dsl of [false, true]) for (const value of ['17', '"21"']) for (const assignment of ['languageVersion = JavaLanguageVersion.of(VALUE)', 'languageVersion.set(org.gradle.jvm.toolchain.JavaLanguageVersion.of(VALUE))']) {
        const source = 'plugins { id("java") }\r\n// 😀 original\r\njava { toolchain { ' + assignment.replace('VALUE', value) + '; } }';
        const model = read(source, dsl);
        assert.deepEqual(model.gaps, []);
        assert.deepEqual(model.compiler.javaToolchains, [{ languageVersion: Number(value.replaceAll('"', '')), start: source.indexOf('languageVersion') }]);
    }
});

test('Ordered Kotlin compiler argument operations retain set, append and original argument locations', () => {
    const source = 'plugins { kotlin("jvm") version "2.2.21" }\nkotlin { compilerOptions {\nfreeCompilerArgs.add("-java-parameters");\nfreeCompilerArgs.set(listOf("-Xjsr305=warn",));\nfreeCompilerArgs.addAll(listOf("-Xjsr305=strict", "-java-parameters"));\nfreeCompilerArgs.set(listOf())\n} }';
    const model = read(source);
    assert.deepEqual(model.gaps, []);
    assert.deepEqual(model.compiler.kotlinArgumentUpdates.map(item => [item.operation, item.arguments.map(arg => arg.value)]), [
        ['add', ['-java-parameters']], ['set', ['-Xjsr305=warn']], ['addAll', ['-Xjsr305=strict', '-java-parameters']], ['set', []],
    ]);
    for (const item of model.compiler.kotlinArgumentUpdates) {
        assert.ok(source.slice(item.start).startsWith('freeCompilerArgs.'));
        for (const arg of item.arguments) assert.ok(source.slice(arg.start).startsWith('"' + arg.value + '"'));
    }
    const groovy = read('plugins { id "org.jetbrains.kotlin.jvm" version "2.2.21" }; kotlin { compilerOptions { freeCompilerArgs.set(["-Xjsr305=ignore"]); freeCompilerArgs.addAll("-java-parameters") } }', false);
    assert.deepEqual(groovy.gaps, []);
    assert.deepEqual(groovy.compiler.kotlinArgumentUpdates.map(item => item.operation), ['set', 'addAll']);
});

test('Native literal test task selectors accept only the reviewed DSL and Test type', () => {
    const cases: [boolean, string][] = [
        [false, 'test'], [false, 'tasks.test'], [false, 'tasks.named("test")'], [false, 'tasks.withType(Test)'], [false, 'tasks.withType(org.gradle.api.tasks.testing.Test).configureEach'],
        [true, 'tasks.test'], [true, 'tasks.named<Test>("test")'], [true, 'tasks.named<org.gradle.api.tasks.testing.Test>("test")'],
        [true, 'tasks.withType<Test>'], [true, 'tasks.withType<Test>().configureEach'], [true, 'tasks.withType<org.gradle.api.tasks.testing.Test>().configureEach'],
    ];
    for (const [dsl, selector] of cases) {
        const source = 'plugins { id("java") }\n' + selector + ' { useJUnitPlatform(); }';
        const model = read(source, dsl); assert.deepEqual(model.gaps, [], selector);
        assert.deepEqual(model.compiler.testPlatforms, [{ selector, platform: 'junit-platform', start: source.indexOf(selector) }]);
    }
});

test('Backticked Kotlin java-library selects its own standard roots and API dependency contract', async () => {
    const root = await repository({ 'settings.gradle.kts': 'include(":lib")', 'build.gradle.kts': 'plugins { java }\ndependencies { implementation(project(":lib")) }',
        'lib/build.gradle.kts': 'plugins { `java-library` }\n' + toolchain,
        'src/main/java/client/Use.java': java['src/main/java/client/Use.java'], 'lib/src/main/java/demo/Widget.java': java['src/main/java/demo/Widget.java'] });
    const graph = await index(root);
    assert.deepEqual(statuses(graph, 'src/main/java/client/Use.java'), ['resolved']);
    assert.ok(projects(graph).every(project => !project.gaps.length));
    assert.equal(projects(graph).find(project => project.root === 'lib')?.compilerInputs?.javaToolchains[0]?.languageVersion, 17);
});

test('Groovy and Kotlin standard compiler blocks retain Java/Kotlin import identities, ranges and manifest evidence', async () => {
    for (const dsl of [false, true]) {
        const file = 'build.gradle' + (dsl ? '.kts' : '');
        const plugin = dsl ? 'plugins { kotlin("jvm") version "2.2.21" }' : 'plugins { id "org.jetbrains.kotlin.jvm" version "2.2.21" }';
        const root = await repository({ [file]: plugin, ...java, ...kotlin });
        const before = await index(root);
        await put(root, file, plugin + '\r\n// 😀 toolchain\r\n' + toolchain + '\r\n' + options + '\r\n' + (dsl ? 'tasks.withType<Test>' : 'test') + ' { useJUnitPlatform() }');
        const graph = await index(root), model = projects(graph)[0]!;
        assert.deepEqual(model.gaps, []);
        for (const source of ['src/main/java/client/Use.java', 'src/main/kotlin/client/Use.kt']) assert.deepEqual(statuses(graph, source), ['resolved']);
        for (const entity of before.entities.filter(entity => entity.language === 'java' || entity.language === 'kotlin')) {
            const after = graph.entities.find(candidate => candidate.id === entity.id)!;
            assert.equal(after.path, entity.path); assert.deepEqual(after.sourceRange, entity.sourceRange);
        }
        const inputs = model.compilerInputs!;
        assert.equal(inputs.javaToolchains[0]?.languageVersion, 17);
        assert.ok(inputs.javaToolchains[0]?.proof.some(fact => fact.file === file && fact.line === 3 && fact.analyzerVersion === '4' && fact.explanation?.includes('not resolved/executed')));
        assert.ok(inputs.kotlinArgumentUpdates[0]?.arguments.every(arg => arg.proof.some(fact => fact.file === file && fact.line === 4)));
        assert.ok(inputs.testPlatforms[0]?.proof.some(fact => fact.file === file && fact.line === 5));
        assert.ok(graph.relations.filter(edge => edge.type === 'imports').every(edge => edge.evidence.some(fact => fact.line === 3)));
    }
});

test('Complete unknown plugin declarations constrain bindings while retaining independent literal inputs', async () => {
    const build = 'plugins { id("org.springframework.boot") version "4.0.8"; id("io.spring.dependency-management") version "1.1.7"; kotlin("plugin.spring") version "2.2.21"; kotlin("jvm") version "2.2.21" }\n' + toolchain + '\n' + options + '\ntasks.withType<Test> { useJUnitPlatform() }';
    const graph = await index(await repository({ 'build.gradle.kts': build, ...java, ...kotlin }));
    const project = projects(graph)[0]!;
    for (const id of ['org.springframework.boot', 'io.spring.dependency-management', 'org.jetbrains.kotlin.plugin.spring']) assert.ok(project.gaps.some(gap => gap.includes(id)));
    assert.equal(project.compilerInputs?.javaToolchains[0]?.languageVersion, 17);
    assert.equal(project.compilerInputs?.testPlatforms.length, 1);
    assert.equal(project.compilerInputs?.kotlinArgumentUpdates.length, 1);
    assert.ok(project.roots.every(root => root.proof.some(fact => fact.explanation?.includes('prevent confirmed activation'))));
    assert.deepEqual(statuses(graph, 'src/main/kotlin/client/Use.kt'), ['unsupported']);
    assert.deepEqual(statuses(graph, 'src/main/java/client/Use.java'), ['unsupported']);
    assert.equal(graph.relations.filter(edge => edge.type === 'imports').length, 0);
    assert.equal(graph.entities.filter(entity => entity.type === 'api_endpoint').length, 0);
});

test('Toolchain/test settings alone never activate JVM source roots', async () => {
    const graph = await index(await repository({ 'build.gradle.kts': toolchain + '\ntasks.withType<Test> { useJUnitPlatform() }', ...java }));
    assert.equal(projects(graph)[0]?.roots.length, 0);
    assert.ok(projects(graph)[0]?.gaps.some(gap => gap.includes('No literal reviewed')));
    assert.equal(projects(graph)[0]?.compilerInputs?.javaToolchains.length, 1);
    assert.deepEqual(statuses(graph, 'src/main/java/client/Use.java'), ['unsupported']);
});

test('Annotation-default and unreviewed Kotlin compiler transformations remain binding gaps', async () => {
    for (const argument of ['-Xannotation-default-target=param-property', '-Xplugin=compiler.jar', '-Xcontext-parameters', '-Xno-param-assertions']) {
        const graph = await index(await repository({ 'build.gradle.kts': 'plugins { kotlin("jvm") version "2.2.21" }\nkotlin { compilerOptions { freeCompilerArgs.add("' + argument + '") } }', ...kotlin }));
        const project = projects(graph)[0]!;
        assert.ok(project.gaps.length, argument);
        assert.equal(project.compilerInputs?.kotlinArgumentUpdates[0]?.arguments[0]?.value, argument);
        assert.deepEqual(statuses(graph, 'src/main/kotlin/client/Use.kt'), ['unsupported']);
    }
});

test('Dynamic, custom and malformed Java toolchain statements never produce literal input facts', () => {
    for (const statement of [
        'languageVersion = providers.gradleProperty("jdk")', 'languageVersion = JavaLanguageVersion.of(jdk)',
        'languageVersion = JavaLanguageVersion.of(0)', 'languageVersion = JavaLanguageVersion.of(017)', 'languageVersion = JavaLanguageVersion.of(2147483648)',
        'languageVersion = JavaLanguageVersion.of(17); vendor = JvmVendorSpec.ADOPTIUM',
        'languageVersion; = JavaLanguageVersion.of(17)', 'languageVersion = "JavaLanguageVersion".of(17)',
    ]) {
        const model = read('plugins { java }\njava { toolchain { ' + statement + ' } }');
        assert.ok(model.gaps.length, statement); assert.deepEqual(model.compiler.javaToolchains, []);
    }
});

test('Malformed compiler operations, expressions and list elements never fabricate an argument update', () => {
    for (const statement of [
        'freeCompilerArgs.add(providers.gradleProperty("arg"))', 'freeCompilerArgs.add("-Xjsr305=strict", "-java-parameters")',
        'freeCompilerArgs.add(listOf("-java-parameters"))', 'freeCompilerArgs.set("-java-parameters")',
        'freeCompilerArgs.addAll(listOf("-Xjsr305=strict",,))', 'freeCompilerArgs.addAll(listOf("-Xjsr305=strict", other))',
        'freeCompilerArgs.addAll(listOf("-Xjsr305=strict" "-java-parameters"))', 'freeCompilerArgs;.add("-java-parameters")',
        'freeCompilerArgs = listOf("-java-parameters")', 'jvmTarget.set(JvmTarget.JVM_17)',
    ]) {
        const model = read('plugins { kotlin("jvm") version "2.2.21" }\nkotlin { compilerOptions { ' + statement + ' } }');
        assert.ok(model.gaps.length, statement); assert.deepEqual(model.compiler.kotlinArgumentUpdates, [], statement);
    }
});

test('Foreign task types, opaque selectors/options and wrong DSL syntax remain diagnostic-only', () => {
    for (const [dsl, statement] of [
        [true, 'tasks.withType<Other> { useJUnitPlatform() }'], [true, 'tasks.withType<Test { useJUnitPlatform() }'],
        [true, 'tasks.withType<Test>> { useJUnitPlatform() }'], [true, 'tasks.withType<Test>() { useJUnitPlatform() }'],
        [true, 'tasks.named("test") { useJUnitPlatform() }'], [true, 'test { useJUnitPlatform() }'],
        [true, 'tasks.withType(Test) { useJUnitPlatform() }'], [false, 'tasks.withType<Test> { useJUnitPlatform() }'],
        [true, 'tasks.withType<Test> { useJUnitPlatform { includeTags("slow") } }'],
        [true, 'tasks.withType<Test> { useJUnitPlatform(); dependsOn("generate") }'],
        [true, 'tasks.named<Test>(taskName) { useJUnitPlatform() }'],
    ] as [boolean, string][]) {
        const model = read('plugins { id("java") }\n' + statement, dsl);
        assert.ok(model.gaps.length, statement); assert.deepEqual(model.compiler.testPlatforms, [], statement);
    }
});

test('Escaped identifiers and incompatible literal string forms cannot bypass Gradle DSL review', () => {
    for (const [dsl, source] of [
        [false, 'plugins { `java-library` }'], [true, 'plugins { java-library }'], [true, 'plugins { `custom` }'],
        [true, 'plugins { java }; `java` { toolchain { languageVersion = JavaLanguageVersion.of(17) } }'],
        [true, "plugins { java }; java { toolchain { languageVersion = JavaLanguageVersion.of('17') } }"],
    ] as [boolean, string][]) assert.ok(read(source, dsl).gaps.length, source);
    for (const dsl of [false, true]) assert.ok(readGradleSettings(gradleTokens('`include`(":lib")')!, dsl).gaps.length);
    assert.equal(gradleTokens('plugins { `java-library }'), undefined);
});

test('Opaque control flow and plugin application flags cannot be skipped to extract later compiler contracts', () => {
    for (const prefix of ['plugins { id("java") apply false }', 'plugins { id("java") version versionFromHost }', 'if (enabled) { plugins { java } }', 'configureFromTarget()']) {
        const model = read(prefix + '\n' + toolchain);
        assert.ok(model.gaps.length); assert.deepEqual(model.compiler.javaToolchains, []);
    }
});

test('Compiler input edits invalidate JVM bindings and preserve full cold/warm/fresh/revision graph replay', async () => {
    const root = await repository({ 'build.gradle.kts': 'plugins { kotlin("jvm") version "2.2.21" }', ...java, ...kotlin }), state = await repository({});
    for (const statement of [toolchain + '\n' + options, toolchain.replace('(17)', '(21)') + '\n' + options,
        toolchain + '\nkotlin { compilerOptions { freeCompilerArgs.add("-Xannotation-default-target=param-property") } }', toolchain + '\n' + options]) {
        await put(root, 'build.gradle.kts', 'plugins { kotlin("jvm") version "2.2.21" }\n' + statement);
        const coldCache = new AnalysisCache(state), cold = await index(root, coldCache), warmCache = new AnalysisCache(state), warm = await index(root, warmCache);
        assert.ok(coldCache.events.some(event => event.analyzer === 'jvm-imports' && !event.hit));
        assert.ok(warmCache.events.some(event => event.analyzer === 'jvm-imports' && event.hit));
        assert.equal(whole(cold), whole(warm)); assert.equal(whole(cold), whole(await index(root)));
        assert.deepEqual(statuses(warm, 'src/main/kotlin/client/Use.kt'), [statement.includes('annotation-default-target') ? 'unsupported' : 'resolved']);
        const revision = await index(root, new AnalysisCache(state), 'b'.repeat(40));
        assert.equal(whole(revision), whole(await index(root, undefined, 'b'.repeat(40))));
    }
});
