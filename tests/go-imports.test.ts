import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { indexRepository } from '../src/pipeline/index.js';
import { resolveConfig, detectApplications, type GoBuildConfig } from '../src/core/config.js';
import type { SoftwareGraph } from '../src/core/graph.js';
import { fileAnalysis } from '../src/analysis/facts.js';
import { StructureParser } from '../src/analysis/tree-sitter/client.js';
import { selectGoFile } from '../src/analysis/languages/go-build.js';
import { goString } from '../src/analysis/tree-sitter/go-imports.js';
import { parseGoManifest } from '../src/analysis/resolution/go-manifest.js';
import { AnalysisCache } from '../src/pipeline/cache.js';
import { canonicalJson } from '../src/history/fingerprint.js';

const temporary: string[] = [];
after(async () => { await Promise.all(temporary.map(root => rm(root, { recursive: true, force: true }))); });
const mod = 'module example.com/app\ngo 1.25\n';
async function repository(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'codiluce-go-')); temporary.push(root);
  for (const [file, text] of Object.entries({ 'go.mod': mod, ...files })) { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), text); } return root;
}
async function index(root: string, go?: GoBuildConfig, cache?: AnalysisCache, revision?: string, ignore: string[] = [], maxFileBytes?: number) {
  return indexRepository(root, { config: await resolveConfig(root, { repository: { name: 'go' }, applications: [{ name: 'app', path: '.', ecosystems: ['go'], ...(go ? { go } : {}) }], ignore, ...(maxFileBytes ? { maxFileBytes } : {}) }), cache, revision });
}
const file = (graph: SoftwareGraph, name: string) => graph.entities.find(item => item.type === 'file' && item.path === name)!;
const imports = (graph: SoftwareGraph, name: string) => file(graph, name).metadata.importOutcomes as { kind: string; local?: string; range: { startLine: number }; conditions: string[]; outcome: any }[];
const stored = (graph: SoftwareGraph) => canonicalJson({ entities: graph.entities, relations: graph.relations, diagnostics: graph.diagnostics.filter(item => !['indexer', 'git-metrics'].includes(item.analyzer) && item.code !== 'git-ignore-unavailable') });

test('Go raw/interpreted import strings preserve Unicode byte escapes and reject invalid encodings', async () => {
  assert.equal(goString('"example.com/\\x61pp"'), 'example.com/app'); assert.equal(goString('"\\303\\251"'), 'é'); assert.equal(goString('`a\rb`'), 'ab');
  for (const text of ['"\\xFF"', '"\\uD800"', '"\\U00110000"', '"\\400"', '"\\q"', '"line\nbreak"', '"unterminated']) assert.equal(goString(text), undefined, text);
  const eofParser = new StructureParser(); try { const text = 'package app\ntype H struct{}', facts = await eofParser.parse('go', text); assert.equal(facts.go?.complete, true); assert.equal(facts.issues.length, 0); assert.equal(facts.declarations[0]!.end, text.length); assert.equal(facts.declarations[0]!.range.endLine, 2); assert.equal(facts.declarations[0]!.range.endColumn, 16); } finally { eofParser.close(); }
  const parser = new StructureParser(); try { const facts = await parser.parse('go', '// 😀 original\r\npackage app\r\nimport (\r\n renamed "example.com/\\x61pp/lib"\r\n . `example.com/app/lib`\r\n _ "net/http"\r\n)\r\nfunc F(){/* import "fake" */}\r\n'); assert.equal(facts.go?.package?.name, 'app'); assert.deepEqual(facts.go?.imports.map(item => [item.kind, item.local, item.specifier, item.range.startLine]), [['named', 'renamed', 'example.com/app/lib', 4], ['dot', '.', 'example.com/app/lib', 5], ['blank', '_', 'net/http', 6]]); assert.equal(facts.go?.complete, true); } finally { parser.close(); }
});

test('Go packages span files and use declared package names rather than version/directory basenames', async () => {
  const root = await repository({ 'main.go': 'package app\nimport (\n "example.com/app/pkg/v2"\n r "example.com/app/pkg/v2"\n . "example.com/app/pkg/v2"\n _ "example.com/app/pkg/v2"\n)\n', 'pkg/v2/a.go': 'package routes_test\nfunc First(){}', 'pkg/v2/b.go': 'package routes_test\ntype Handler struct{}\nfunc (h Handler) Serve(){}' });
  const graph = await index(root), entries = imports(graph, 'main.go'); assert.equal(entries.length, 4); assert.deepEqual(entries.map(item => item.local), ['routes_test', 'r', '.', '_']); assert.ok(entries.every(item => item.outcome.status === 'resolved' && item.outcome.targets.length === 2)); assert.equal(graph.relations.filter(item => item.type === 'imports' && item.from === file(graph, 'main.go').id).length, 8); assert.equal(fileAnalysis(file(graph, 'main.go').metadata.analysis)?.features.references.status, 'unsupported');
});

test('Unrelated nested modules stay external until a workspace use or declared local replacement selects them', async () => {
  const root = await repository({ 'main.go': 'package app\nimport "example.com/lib"', 'go.mod': mod + 'require example.com/lib v1.0.0\n', 'lib/go.mod': 'module example.com/lib\ngo 1.25\n', 'lib/lib.go': 'package renamed\nfunc Handle(){}' });
  const graph = await index(root); assert.equal(imports(graph, 'main.go')[0]!.outcome.status, 'external'); assert.equal(imports(graph, 'main.go')[0]!.local, undefined); assert.equal(graph.relations.some(item => item.type === 'imports' && item.from === file(graph, 'main.go').id), false); assert.notEqual((file(graph, 'main.go').metadata.importResolver as any).project, (file(graph, 'lib/lib.go').metadata.importResolver as any).project);
});

test('Selected workspace members bind deeply nested quoted paths and application detection discovers them', async () => {
  const root = await repository({ 'main.go': 'package app\nimport "example.com/lib/v2"', 'go.work': 'go 1.25\nuse (\n .\n "./packages/deep/lib space"\n)\n', 'packages/deep/lib space/go.mod': 'module example.com/lib/v2\ngo 1.25\nrequire github.com/go-chi/chi/v5 v5.2.1\n', 'packages/deep/lib space/lib.go': 'package custom\nfunc Handle(){}' });
  const graph = await index(root); assert.equal(imports(graph, 'main.go')[0]!.outcome.status, 'resolved'); assert.equal(imports(graph, 'main.go')[0]!.local, 'custom'); assert.equal((file(graph, 'main.go').metadata.goBuild as any).workspace, 'go.work'); assert.ok((await detectApplications(root)).some(app => app.path === 'packages/deep/lib space' && app.frameworks.includes('chi')));
  assert.equal(imports(await index(root, { workspace: false }), 'main.go')[0]!.outcome.status, 'unresolved'); assert.equal(imports(await index(root, { workspace: 'missing.work' }), 'main.go')[0]!.outcome.status, 'excluded');
});

test('Workspace membership cannot pull in an unlisted module and duplicate module providers are ambiguous', async () => {
  const root = await repository({ 'main.go': 'package app\nimport "example.com/lib"', 'go.work': 'go 1.25\nuse (\n .\n ./one\n ./two\n)\n', 'one/go.mod': 'module example.com/lib\n', 'one/lib.go': 'package lib\n', 'two/go.mod': 'module example.com/lib\n', 'two/lib.go': 'package lib\n', 'unlisted/go.mod': 'module example.com/unlisted\n', 'unlisted/lib.go': 'package unlisted\nimport "example.com/lib"' });
  const graph = await index(root); assert.equal(imports(graph, 'main.go')[0]!.outcome.status, 'ambiguous'); assert.equal(imports(graph, 'unlisted/lib.go')[0]!.outcome.status, 'unsupported');
});

test('Missing or escaping workspace members constrain the invocation without reading their contents', async () => {
  for (const member of ['./missing', '../outside', '/outside']) { const root = await repository({ 'main.go': 'package app\nimport "example.com/lib"', 'go.work': `go 1.25\nuse (\n .\n ${member}\n)\n` }); const graph = await index(root); assert.equal(imports(graph, 'main.go')[0]!.outcome.status, 'excluded'); assert.ok(graph.diagnostics.some(item => item.code === 'go-project-gap')); }
});

test('Overlapping selected modules and unindexed external providers cannot choose an import namespace by prefix length', async () => {
  const root = await repository({ 'main.go': 'package app\nimport "example.com/parent/child"', 'go.work': 'go 1.25\nuse (\n .\n ./parent\n ./child\n)\n', 'parent/go.mod': 'module example.com/parent\n', 'parent/child/a.go': 'package one\n', 'child/go.mod': 'module example.com/parent/child\n', 'child/a.go': 'package two\n' });
  assert.equal(imports(await index(root), 'main.go')[0]!.outcome.status, 'ambiguous');
  await writeFile(path.join(root, 'go.mod'), mod + 'require (\n example.com/parent v1.0.0\n example.com/parent/child v1.0.0\n)\n'); const external = imports(await index(root, { workspace: false }), 'main.go')[0]!; assert.equal(external.outcome.status, 'external'); assert.ok(external.conditions.some(reason => reason.includes('Multiple unindexed')));
});

test('Declared wildcard local replacements bind indexed packages and require an eligible dependency', async () => {
  const root = await repository({ 'go.mod': mod + 'require example.com/lib v1.0.0\nreplace example.com/lib => ./lib\n', 'main.go': 'package app\nimport "example.com/lib/handlers"', 'lib/go.mod': 'module example.com/lib\n', 'lib/handlers/a.go': 'package endpoints\nfunc Handle(){}' });
  const graph = await index(root); assert.equal(imports(graph, 'main.go')[0]!.outcome.status, 'resolved'); assert.equal(imports(graph, 'main.go')[0]!.local, 'endpoints'); assert.ok(imports(graph, 'main.go')[0]!.outcome.proof.some((fact: any) => fact.file === 'go.mod' && fact.explanation.includes('replacement')));
  await writeFile(path.join(root, 'go.mod'), mod + 'replace example.com/lib => ./lib\n'); assert.equal(imports(await index(root), 'main.go')[0]!.outcome.status, 'unresolved');
});

test('Version-specific and remote replacements record their unresolved selection/API qualification', async () => {
  const root = await repository({ 'go.mod': mod + 'require example.com/lib v1.0.0\nreplace example.com/lib v1.0.0 => ./lib\n', 'main.go': 'package app\nimport "example.com/lib"', 'lib/go.mod': 'module example.com/lib\n', 'lib/lib.go': 'package lib\n' });
  const specific = imports(await index(root), 'main.go')[0]!; assert.equal(specific.outcome.status, 'resolved'); assert.ok(specific.conditions.some(reason => reason.includes('Version-specific')));
  await writeFile(path.join(root, 'go.mod'), mod + 'require example.com/lib v1.0.0\nreplace example.com/lib => example.com/fork v1.2.0\n'); const remote = imports(await index(root), 'main.go')[0]!; assert.equal(remote.outcome.status, 'external'); assert.equal(remote.outcome.dependency, 'example.com/fork'); assert.equal(remote.outcome.declaredVersion, 'v1.2.0'); assert.ok(remote.conditions.some(reason => reason.includes('Remote module')));
});

test('Conflicting main-module replacements are ambiguous until an explicit workspace override selects a target', async () => {
  const root = await repository({ 'go.mod': mod + 'require example.com/lib v1.0.0\nreplace example.com/lib => ./lib-one\n', 'main.go': 'package app\nimport "example.com/lib"', 'go.work': 'go 1.25\nuse (\n .\n ./other\n)\n', 'other/go.mod': 'module example.com/other\nrequire example.com/lib v1.0.0\nreplace example.com/lib => ../lib-two\n', 'other/a.go': 'package other\n', 'lib-one/go.mod': 'module example.com/lib\n', 'lib-one/a.go': 'package first\n', 'lib-two/go.mod': 'module example.com/lib\n', 'lib-two/a.go': 'package second\n' });
  assert.equal(imports(await index(root), 'main.go')[0]!.outcome.status, 'ambiguous'); await writeFile(path.join(root, 'go.work'), 'go 1.25\nuse (\n .\n ./other\n)\nreplace example.com/lib => ./lib-two\n'); assert.equal(imports(await index(root), 'main.go')[0]!.local, 'second');
});

test('Missing, absolute, escaping and module-mismatched local replacements never become external framework proof', async () => {
  for (const target of ['./missing', '../outside', '/outside', './impostor']) { const root = await repository({ 'go.mod': mod + `require example.com/lib v1.0.0\nreplace example.com/lib => ${target}\n`, 'main.go': 'package app\nimport "example.com/lib"', 'impostor/go.mod': 'module example.com/impostor\n', 'impostor/a.go': 'package lib\n' }); const outcome = imports(await index(root), 'main.go')[0]!.outcome; assert.ok(['excluded', 'unsupported'].includes(outcome.status), target); }
});

test('Go internal packages enforce importer path boundaries across selected modules', async () => {
  const root = await repository({ 'main.go': 'package app\nimport "example.com/app/internal/auth"', 'internal/auth/auth.go': 'package auth\n', 'go.work': 'go 1.25\nuse (\n .\n ./other\n)\n', 'other/go.mod': 'module example.com/other\n', 'other/main.go': 'package other\nimport "example.com/app/internal/auth"' });
  const graph = await index(root); assert.equal(imports(graph, 'main.go')[0]!.outcome.status, 'resolved'); assert.equal(imports(graph, 'other/main.go')[0]!.outcome.status, 'unsupported');
});

test('Canonical standard-library imports resist local module names and record external names/versions separately', async () => {
  const root = await repository({ 'go.mod': 'module net\nrequire github.com/gin-gonic/gin v1.10.0\n', 'main.go': 'package app\nimport (\n "net/http"\n "math/rand/v2"\n "github.com/gin-gonic/gin"\n)', 'http/local.go': 'package impostor\n' });
  const graph = await index(root), values = imports(graph, 'main.go'); assert.equal(values[0]!.outcome.standardLibrary, true); assert.equal(values[0]!.local, 'http'); assert.equal(values[1]!.local, 'rand'); assert.equal(values[2]!.outcome.declaredVersion, 'v1.10.0'); assert.equal(values[2]!.local, undefined); assert.equal(graph.relations.some(item => item.type === 'imports' && item.to === file(graph, 'http/local.go').id), false);
});

test('Unknown filename/build inputs retain conditional package files; a recorded target selects a single package', async () => {
  const root = await repository({ 'main.go': 'package app\nimport "example.com/app/platform"', 'platform/base.go': 'package platform\n', 'platform/x_linux.go': 'package platform\n', 'platform/x_windows.go': 'package platform\n' });
  const unknown = imports(await index(root), 'main.go')[0]!; assert.equal(unknown.outcome.targets.length, 3); assert.ok(unknown.conditions.some(reason => reason.includes('Unknown build')));
  const selected = imports(await index(root, { goos: 'linux', goarch: 'amd64', tags: [] }), 'main.go')[0]!; assert.equal(selected.outcome.targets.length, 2); assert.deepEqual(selected.conditions, []);
  await writeFile(path.join(root, 'platform/x_windows.go'), 'package other\n'); assert.equal(imports(await index(root), 'main.go')[0]!.outcome.status, 'ambiguous'); assert.equal(imports(await index(root, { goos: 'linux' }), 'main.go')[0]!.outcome.status, 'resolved');
});

test('Modern and legacy build predicates honor OS aliases, architecture, negation, version and explicit custom tags', async () => {
  const parser = new StructureParser(); try {
    const text = '//go:build linux && arm64 && !debug && go1.22\n// +build linux,arm64,!debug,go1.22\n\npackage app\n', facts = (await parser.parse('go', text)).go!;
    assert.equal(selectGoFile('target_linux_arm64.go', facts, text, { goos: 'android', goarch: 'arm64', tags: [], toolchainVersion: '1.25.0' }).status, 'active');
    for (const input of [{ goos: 'windows' }, { goos: 'linux', goarch: 'amd64' }, { goos: 'linux', goarch: 'arm64', tags: ['debug'] }, { goos: 'linux', goarch: 'arm64', toolchainVersion: '1.21' }]) assert.equal(selectGoFile('target_linux_arm64.go', facts, text, input).status, 'inactive');
    assert.equal(selectGoFile('target_linux_arm64.go', facts, text, { goos: 'linux', goarch: 'arm64' }).status, 'conditional');
    const legacy = '// +build darwin,arm64 solaris\n\npackage app\n', old = (await parser.parse('go', legacy)).go!; assert.equal(selectGoFile('target.go', old, legacy, { goos: 'ios', goarch: 'arm64' }).status, 'active'); assert.equal(selectGoFile('target.go', old, legacy, { goos: 'illumos' }).status, 'active');
  } finally { parser.close(); }
});

test('Malformed, misplaced, duplicate and inconsistent build predicates preserve qualification gaps', async () => {
  const parser = new StructureParser(); try { for (const text of ['//go:build linux &&\n\npackage app\n', '//go:build linux\npackage app\n', '//go:build linux\n//go:build darwin\n\npackage app\n', '//go:build linux\n// +build windows\n\npackage app\n', 'package app\n//go:build linux\n']) { const facts = (await parser.parse('go', text)).go!; assert.equal(selectGoFile('target.go', facts, text, { goos: 'linux' }).status, 'invalid', text); } } finally { parser.close(); }
});

test('cgo source units depend on recorded cgo availability and never execute generated C bindings', async () => {
  const root = await repository({ 'a.go': 'package app\nimport "C"\n', 'b.go': 'package app\nimport "net/http"\n' });
  const unknown = await index(root); assert.equal((file(unknown, 'a.go').metadata.goBuild as any).status, 'conditional'); assert.equal(imports(unknown, 'a.go')[0]!.outcome.status, 'unsupported');
  assert.equal(fileAnalysis(file(await index(root, { cgoEnabled: false }), 'a.go').metadata.analysis)?.features.imports.status, 'disabled'); assert.equal((file(await index(root, { cgoEnabled: true }), 'a.go').metadata.goBuild as any).status, 'active');
});

test('Test compilation scopes stay disabled by default and external tests can import their augmented package', async () => {
  const root = await repository({ 'api.go': 'package api\nfunc Serve(){}', 'api_test.go': 'package api\nfunc TestServe(){}', 'external_test.go': 'package api_test\nimport "example.com/app"', '_ignored.go': 'package api\nimport "missing"' });
  const first = await index(root); assert.equal((file(first, 'api_test.go').metadata.goBuild as any).status, 'inactive'); assert.equal(imports(first, 'external_test.go').length, 0); assert.equal((file(first, '_ignored.go').metadata.goBuild as any).status, 'inactive');
  const tests = await index(root, { includeTests: true }); assert.equal(imports(tests, 'external_test.go')[0]!.outcome.status, 'resolved'); assert.equal(imports(tests, 'external_test.go')[0]!.outcome.targets.length, 2); assert.notEqual((file(tests, 'api.go').metadata.goPackage as any).package.key, (file(tests, 'external_test.go').metadata.goPackage as any).package.key);
});

test('Command/self imports, unavailable source and pruned/symlinked module boundaries remain unqualified', async () => {
  const root = await repository({ 'a.go': 'package app\nimport (\n "example.com/app"\n "example.com/app/cmd"\n "example.com/app/nested"\n "example.com/app/large"\n)', 'cmd/a.go': 'package main\nfunc main(){}', 'nested/go.mod': 'module example.com/nested\n', 'nested/a.go': 'package nested\n', 'large/a.go': 'package large\n' + '//long\n'.repeat(40) });
  const graph = await index(root, undefined, undefined, undefined, ['nested/go.mod'], 200); const statuses = imports(graph, 'a.go').map(item => item.outcome.status); assert.deepEqual(statuses, ['unsupported', 'unsupported', 'excluded', 'excluded']); assert.equal(fileAnalysis(file(graph, 'nested/a.go').metadata.analysis)?.features.imports.status, 'partial');
  await symlink(path.join(root, 'go.mod'), path.join(root, 'nested/go.work')); const symlinked = await index(root); assert.ok((file(symlinked, 'nested/a.go').metadata.goBuild as any).invocationConditions.some((reason: string) => reason.includes('workspace')));
});

test('Observed vendor roots block dependency/replacement guesses while leaving own-module imports usable', async () => {
  const root = await repository({ 'go.mod': mod + 'require example.com/lib v1.0.0\nreplace example.com/lib => ./lib\n', 'main.go': 'package app\nimport (\n "example.com/lib"\n "example.com/app/own"\n)', 'lib/go.mod': 'module example.com/lib\n', 'lib/a.go': 'package lib\n', 'own/a.go': 'package own\n', 'vendor/example.com/lib/a.go': 'package impostor\n' });
  const values = imports(await index(root), 'main.go'); assert.equal(values[0]!.outcome.status, 'unsupported'); assert.equal(values[1]!.outcome.status, 'resolved');
});

test('Malformed/opaque manifests and excluded requirements cannot invent dependency versions or execute target commands', async () => {
  for (const manifest of ['module example.com/app\nmodule example.com/other\n', mod + 'require example.com/lib v1.0.0\nexclude example.com/lib v1.0.0\n', mod + 'require (\nexample.com/lib v1.0.0\n', mod + 'generate touch EXECUTED\n']) { const root = await repository({ 'go.mod': manifest, 'a.go': 'package app\nimport "example.com/lib"' }); const graph = await index(root); assert.equal(imports(graph, 'a.go')[0]!.outcome.status, 'unsupported'); assert.equal(graph.entities.some(item => item.path === 'EXECUTED'), false); }
  assert.equal(parseGoManifest('module example.com/app\nrequire example.com/api/v10 v10.2.0\n', 'module').valid, true); assert.equal(parseGoManifest('module example.com/app\nrequire example.com/api/v2 v3.0.0\n', 'module').valid, false);
});

test('Go build settings validate explicit inputs without silently accepting host/environment alternatives', async () => {
  const root = await repository({ 'a.go': 'package app\n' }); for (const go of [{ tags: 'debug' }, { GOOS: 'linux' }, { cgoEnabled: 'yes' }, { workspace: '../outside.work' }, { compiler: 'custom' }]) await assert.rejects(resolveConfig(root, { applications: [{ name: 'app', path: '.', go: go as any }] }), /Go build|outside repository/);
});

test('Go cold/warm/revision graphs agree and module, workspace, source and build edits invalidate their consumers', async () => {
  const root = await repository({ 'main.go': 'package app\nimport "example.com/lib"', 'go.mod': mod + 'require example.com/lib v1.0.0\nreplace example.com/lib => ./lib\n', 'lib/go.mod': 'module example.com/lib\n', 'lib/a.go': 'package lib\nfunc Handle(){}' }), cache = new AnalysisCache(path.join(root, '.cache'));
  const cold = await index(root, undefined, cache); assert.equal(stored(await index(root, undefined, cache)), stored(cold)); assert.equal(stored(await index(root, undefined, cache, 'revision')), stored(cold)); const relation = cold.relations.find(item => item.type === 'imports')!.id;
  await writeFile(path.join(root, 'main.go'), '\n// source line moves\npackage app\nimport "example.com/lib"'); const moved = await index(root, undefined, cache); assert.equal(moved.relations.find(item => item.type === 'imports')!.id, relation); assert.equal(stored(moved), stored(await index(root)));
  await writeFile(path.join(root, 'lib/a.go'), 'package changed\nfunc Handle(){}'); const changed = await index(root, undefined, cache); assert.equal(imports(changed, 'main.go')[0]!.local, 'changed'); assert.equal(stored(changed), stored(await index(root)));
  await writeFile(path.join(root, 'go.mod'), mod + 'require example.com/lib v1.0.0\n'); assert.equal(stored(await index(root, undefined, cache)), stored(await index(root)));
  await writeFile(path.join(root, 'go.work'), 'go 1.25\nuse (\n .\n ./lib\n)\n'); assert.equal(stored(await index(root, undefined, cache)), stored(await index(root)));
  await writeFile(path.join(root, 'lib/platform_windows.go'), 'package changed\n'); const build = { goos: 'linux', goarch: 'amd64', tags: [] }; assert.equal(stored(await index(root, build, cache)), stored(await index(root, build)));
});
