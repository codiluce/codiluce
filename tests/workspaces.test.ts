import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { indexRepository } from '../src/pipeline/index.js';
import { detectApplications, resolveConfig } from '../src/core/config.js';
import { AnalysisCache } from '../src/pipeline/cache.js';
import { canonicalJson } from '../src/history/fingerprint.js';
import type { SoftwareGraph } from '../src/core/graph.js';
import { nodeWorkspacePatterns } from '../src/core/workspaces.js';
import { GraphBuilder } from '../src/core/graph.js';
import type { AnalysisContext } from '../src/core/analyzer.js';
import { filesystemAnalyzer } from '../src/analyzers/filesystem.js';
import { projectAnalyzer } from '../src/analysis/project-model.js';
import { typescriptAnalyzer } from '../src/analyzers/typescript.js';
import ts from 'typescript';

const temporary: string[] = [];
after(async () => { await Promise.all(temporary.map(root => rm(root, { recursive: true, force: true }))); });
async function repository(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'codiluce-workspace-')); temporary.push(root);
  for (const [file, text] of Object.entries(files)) { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), text); }
  return root;
}
const json = JSON.stringify;
const entity = (graph: SoftwareGraph, name: string, file?: string) => graph.entities.find(entity => !['application', 'directory', 'repository'].includes(entity.type) && entity.name === name && (!file || entity.path === file))!;
function calls(graph: SoftwareGraph, from: string, to: string, fromFile?: string, toFile?: string): boolean {
  return graph.relations.some(relation => relation.type === 'calls' && relation.from === entity(graph, from, fromFile)?.id && relation.to === entity(graph, to, toFile)?.id);
}
const stored = (graph: SoftwareGraph) => canonicalJson({ entities: graph.entities, relations: graph.relations, diagnostics: graph.diagnostics });

test('declared npm/Yarn/pnpm members extend application discovery without crossing ignores or symlinks', async () => {
  const manifests: Record<string, string>[] = [
    { 'package.json': json({ workspaces: ['deep/**', '!deep/excluded/**'] }) },
    { 'package.json': json({ workspaces: { packages: ['deep/**', '!deep/excluded/**'] } }) },
    { 'pnpm-workspace.yaml': "packages:\n - deep/**\n - '!deep/excluded/**'\n" },
  ];
  for (const manifest of manifests) {
    const root = await repository({ ...manifest, 'deep/one/two/three/package.json': json({ dependencies: { express: '*' } }), 'deep/excluded/member/package.json': json({ dependencies: { next: '*' } }), 'deep/hidden/package.json': json({ dependencies: { next: '*' } }), 'deep/real/package.json': json({ dependencies: { next: '*' } }), 'deep/tests/package.json': json({ dependencies: { next: '*' } }) });
    await symlink(path.join(root, 'deep/real'), path.join(root, 'deep/link'));
    const apps = await detectApplications(root, 'fixture', ['deep/hidden/**']);
    assert.ok(apps.some(app => app.path === 'deep/one/two/three'));
    assert.ok(apps.some(app => app.path === 'deep/real'));
    assert.equal(apps.some(app => ['deep/excluded/member', 'deep/hidden', 'deep/tests', 'deep/link'].includes(app.path)), false);
  }
  assert.equal(nodeWorkspacePatterns('package.json', json({ workspaces: ['apps/{a,b}', '/outside', '../outside', 'apps/*'] })).issues.length, 2);
});

test('workspace package exports, import aliases, barrel exports and producer tsconfig bind to physical declarations', async () => {
  const root = await repository({
    'package.json': json({ private: true, workspaces: ['apps/*', 'packages/*'] }),
    'apps/web/package.json': json({ name: 'web', dependencies: { '@fixture/shared': 'workspace:*', express: '*' } }),
    'apps/web/tsconfig.json': json({ compilerOptions: { baseUrl: '.', paths: { internal: ['wrong.ts'] } } }),
    'apps/web/main.ts': 'import { shared as alias } from "@fixture/shared/subpath"; export function run() { return alias(); }',
    'apps/web/wrong.ts': 'export function leaf() { return "wrong"; }',
    'packages/shared/package.json': json({ name: '@fixture/shared', version: '1.0.0', exports: { './subpath': './barrel.ts' } }),
    'packages/shared/tsconfig.json': json({ compilerOptions: { baseUrl: '.', paths: { internal: ['leaf.ts'] } } }),
    'packages/shared/barrel.ts': 'export { shared } from "./source";',
    'packages/shared/source.ts': 'import { leaf } from "internal"; export function shared() { return leaf(); }',
    'packages/shared/leaf.ts': 'export function leaf() { return "correct"; }',
  });
  const config = await resolveConfig(root, { repository: { name: 'fixture' }, applications: [{ name: 'web', path: 'apps/web', type: 'express' }] });
  const graph = await indexRepository(root, { config });
  assert.ok(calls(graph, 'run', 'shared'), canonicalJson({ diagnostics: graph.diagnostics, calls: graph.relations.filter(relation => relation.type === 'calls').map(relation => [graph.entities.find(entity => entity.id === relation.from)?.name, graph.entities.find(entity => entity.id === relation.to)?.name]) }));
  assert.ok(calls(graph, 'shared', 'leaf', undefined, 'packages/shared/leaf.ts'));
  assert.equal(calls(graph, 'shared', 'leaf', undefined, 'apps/web/wrong.ts'), false);
  const main = entity(graph, 'main.ts', 'apps/web/main.ts');
  const relation = graph.relations.find(relation => relation.type === 'imports' && relation.from === main.id)!;
  assert.equal(graph.entities.find(entity => entity.id === relation.to)?.path, 'packages/shared/barrel.ts');
  assert.equal(relation.metadata?.resolver, 'workspace');
  assert.ok(relation.evidence.some(fact => fact.file === 'apps/web/package.json'));
  assert.equal((main.metadata.importOutcomes as { bindings: { imported: string; local: string }[]; outcome: { status: string } }[])[0]?.outcome.status, 'resolved');
  assert.deepEqual((main.metadata.importOutcomes as { bindings: unknown[] }[])[0]?.bindings, [{ imported: 'shared', local: 'alias' }]);
  assert.equal(entity(graph, 'shared').language, 'typescript');
  assert.ok(graph.entities.filter(entity => entity.type === 'application').every(app => app.path !== 'packages/shared'), 'packages are compilation boundaries without being runtime applications');
});

test('NodeNext package export conditions follow the importing source format', async () => {
  const root = await repository({
    'package.json': json({ workspaces: ['app', 'shared'] }),
    'app/package.json': json({ name: 'app', dependencies: { shared: 'workspace:*' } }),
    'app/tsconfig.json': json({ compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext' } }),
    'app/importer.mts': 'import { entry } from "shared"; export function esm() { return entry(); }',
    'app/importer.cts': 'import { entry } from "shared"; export function cjs() { return entry(); }',
    'shared/package.json': json({ name: 'shared', exports: { import: './esm.mts', require: './cjs.cts' } }),
    'shared/esm.mts': 'export function entry() { return "esm"; }',
    'shared/cjs.cts': 'export function entry() { return "cjs"; }',
  });
  const graph = await indexRepository(root);
  assert.ok(calls(graph, 'esm', 'entry', undefined, 'shared/esm.mts'));
  assert.ok(calls(graph, 'cjs', 'entry', undefined, 'shared/cjs.cts'));
  assert.equal(calls(graph, 'esm', 'entry', undefined, 'shared/cjs.cts'), false);
});

test('duplicate package names and separate project globals never create a name-only binding', async () => {
  const root = await repository({
    'package.json': json({ workspaces: ['app', 'packages/*', 'other'] }),
    'app/package.json': json({ name: 'app', dependencies: { shared: 'workspace:*' } }),
    'app/main.ts': 'import { shared } from "shared"; export function run() { return shared(); }',
    'app/global.ts': 'function caller() { return same(); }',
    'packages/one/package.json': json({ name: 'shared', version: '1.0.0', main: 'main.ts' }),
    'packages/one/main.ts': 'export function shared() {}',
    'packages/two/package.json': json({ name: 'shared', version: '1.0.0', main: 'main.ts' }),
    'packages/two/main.ts': 'export function shared() {}',
    'other/package.json': json({ name: 'other' }),
    'other/global.ts': 'function same() {}',
  });
  const graph = await indexRepository(root);
  assert.ok(graph.diagnostics.some(diagnostic => diagnostic.code === 'ambiguous-local-import' && diagnostic.file === 'app/main.ts'));
  assert.equal(graph.relations.some(relation => relation.type === 'calls'), false);
});

test('shared source edits invalidate the connected consumer cache and preserve unrelated project hits', async () => {
  const root = await repository({
    'package.json': json({ workspaces: ['app', 'shared', 'other'] }),
    'app/package.json': json({ name: 'app', dependencies: { shared: 'workspace:*' } }),
    'app/main.ts': 'import { shared } from "shared"; export function run() { return shared(1); }',
    'shared/package.json': json({ name: 'shared', main: 'source.ts' }),
    'shared/source.ts': 'export function shared(value: number) { return value; }',
    'other/package.json': json({ name: 'other' }),
    'other/main.ts': 'export function unrelated() {}',
  });
  const config = await resolveConfig(root, { repository: { name: 'fixture' } });
  const cache = new AnalysisCache(path.join(root, '.codiluce/cache'));
  const first = await indexRepository(root, { config, cache });
  const warm = await indexRepository(root, { config, cache });
  assert.equal(stored(warm), stored(first));
  assert.ok(cache.events.slice(-2).every(event => event.hit));
  await writeFile(path.join(root, 'shared/source.ts'), 'export function shared(value: string) { return value.trim(); }');
  const changed = await indexRepository(root, { config, cache });
  assert.ok(cache.events.slice(-2).some(event => event.unit === 'other' && event.hit));
  assert.ok(cache.events.slice(-2).some(event => event.unit.startsWith('group:') && !event.hit));
  assert.ok(calls(changed, 'run', 'shared'));
  assert.notEqual(entity(first, 'shared').id, entity(changed, 'shared').id);
  assert.equal(stored(changed), stored(await indexRepository(root, { config })));
  const revision = await indexRepository(root, { config, revision: '0'.repeat(40) });
  assert.equal(canonicalJson(changed.entities), canonicalJson(revision.entities), 'revision analysis has the same entities');
  assert.equal(canonicalJson(changed.relations), canonicalJson(revision.relations), 'revision analysis has the same relations');
});

test('type-only imports and intermediate re-exports cannot become runtime calls, renders or HTTP wrappers', async () => {
  const root = await repository({
    'package.json': json({ name: 'fixture' }),
    'values.tsx': 'export function work() {} export class Service { method() {} } export function Component() { return <span/>; } export function send(url: string) { return fetch(url); }',
    'barrel.ts': 'export type { work, Service, Component, send } from "./values";',
    'star.ts': 'export type * from "./values";',
    'chain.ts': 'export { work as middle } from "./barrel";',
    'namespace.ts': 'export * as Types from "./barrel"; export type * as OnlyTypes from "./values";',
    'main.tsx': [
      'import type { work as a } from "./values";',
      'import { type work as b } from "./values";',
      'import type * as Types from "./values";',
      'import { work as c, Service, Component, send } from "./barrel";',
      'import { work as d } from "./star";',
      'import * as Barrel from "./barrel";',
      'import { middle } from "./chain";',
      'import Common = require("./barrel");',
      'import { Types as Indirect, OnlyTypes } from "./namespace";',
      'import { work as actual } from "./values";',
      'const alias = c;',
      'const instance = new Service();',
      'export function invalid() { a(); b(); c(); d(); Types.work(); Barrel.work(); Common.work(); Indirect.work(); OnlyTypes.work(); instance.method(); middle(); alias(); new Service(); send("https://api.test/type-only"); return <Component/>; }',
      'export function valid() { actual(); }',
    ].join('\n'),
  });
  const graph = await indexRepository(root);
  const invalid = entity(graph, 'invalid');
  assert.equal(graph.relations.some(relation => relation.from === invalid.id && ['calls', 'references', 'renders'].includes(relation.type)), false);
  assert.equal((invalid.metadata.effects as unknown[] | undefined)?.length ?? 0, 0);
  assert.ok(calls(graph, 'valid', 'work'));
  assert.equal(graph.diagnostics.some(diagnostic => diagnostic.code === 'http-wrapper' && diagnostic.file === 'values.tsx'), false);
  assert.ok((entity(graph, 'main.tsx').metadata.importOutcomes as { bindings: { typeOnly?: boolean }[] }[]).some(item => item.bindings.some(binding => binding.typeOnly)));
});

test('aliased and nested HTTP wrappers in shared packages are emitted once per owned consumer call', async () => {
  const root = await repository({
    'package.json': json({ workspaces: ['apps/*', 'packages/*'] }),
    'apps/web/package.json': json({ name: 'web', dependencies: { client: 'workspace:*' } }),
    'apps/web/main.ts': 'import { nested as send } from "client"; export function run() { return send("https://api.test/one"); }',
    'apps/second/package.json': json({ name: 'second', dependencies: { client: 'workspace:*' } }),
    'apps/second/main.ts': 'import { nested } from "client"; export function other() { return nested("https://api.test/two"); }',
    'packages/client/package.json': json({ name: 'client', exports: './barrel.ts' }),
    'packages/client/barrel.ts': 'export { nested } from "./nested";',
    'packages/client/nested.ts': 'import { request as alias } from "./request"; export function nested(url: string) { return alias(url); }',
    'packages/client/request.ts': 'export function request(url: string) { return fetch(url); }',
  });
  const config = await resolveConfig(root, { repository: { name: 'fixture' }, applications: [{ name: 'web', path: 'apps/web', ecosystems: ['node'] }, { name: 'second', path: 'apps/second', ecosystems: ['node'], apiOrigins: ['https://api.test'] }] });
  const cache = new AnalysisCache(path.join(root, '.codiluce/cache'));
  const graph = await indexRepository(root, { config, cache });
  for (const [name, url] of [['run', 'https://api.test/one'], ['other', 'https://api.test/two']]) {
    const effects = entity(graph, name!).metadata.effects as { category: string; detail: string }[];
    assert.equal(effects?.filter(effect => effect.category === 'network' && effect.detail === url).length, 1, canonicalJson({ owner: entity(graph, name!), diagnostics: graph.diagnostics }));
  }
  const requestFile = entity(graph, 'request.ts');
  assert.deepEqual((requestFile.metadata.httpRequests as { callSites: unknown }[])[0]?.callSites, { resolved: 2, unresolved: 0 });
  assert.equal(graph.diagnostics.filter(diagnostic => diagnostic.code === 'http-wrapper' && diagnostic.file === 'packages/client/request.ts').length, 1);
  assert.equal(graph.diagnostics.some(diagnostic => diagnostic.code === 'unresolved-http-call'), false);
  assert.equal(stored(await indexRepository(root, { config, cache })), stored(graph));
  assert.equal(stored(await indexRepository(root, { config })), stored(graph));
});

test('self references, package import maps and declared file/link packages resolve within the index', async () => {
  for (const protocol of ['file', 'link']) {
    const root = await repository({
      'package.json': json({ name: 'app', type: 'module', imports: { '#internal': './source.ts' }, exports: './source.ts', dependencies: { local: `${protocol}:./nested/local` } }),
      'main.ts': 'import { source } from "#internal"; import { source as self } from "app"; import { local } from "local"; export function run() { source(); self(); local(); }',
      'source.ts': 'export function source() {}',
      'nested/local/package.json': json({ name: 'local', exports: './source.ts' }),
      'nested/local/source.ts': 'export function local() {}',
    });
    const config = await resolveConfig(root, { repository: { name: 'fixture' }, applications: [{ name: 'app', path: '.', type: 'nextjs' }] });
    const graph = await indexRepository(root, { config });
    assert.ok(calls(graph, 'run', 'source'), protocol);
    assert.ok(calls(graph, 'run', 'local'), protocol);
    const projects = entity(graph, 'main.ts').metadata.project;
    assert.notEqual(projects, entity(graph, 'nested/local/source.ts'.split('/').at(-1)!, 'nested/local/source.ts').metadata.project, 'local dependency creates a compilation boundary inside an application');
  }
});

test('declared semver mismatches and denied dependency paths cannot bind to local packages', async () => {
  const root = await repository({
    'package.json': json({ workspaces: ['app', 'shared'] }),
    'app/package.json': json({ name: 'app', dependencies: { shared: '^2.0.0', absent: 'workspace:*', escaped: 'file:../../outside', absolute: 'file:/shared', missing: 'workspace:^3.0.0' } }),
    'app/main.ts': 'import { shared } from "shared"; import { absent } from "absent"; import { escaped } from "escaped"; import { absolute } from "absolute"; export function run() { shared(); absent(); escaped(); absolute(); }',
    'shared/package.json': json({ name: 'shared', version: '1.0.0', main: 'source.ts' }),
    'shared/source.ts': 'export function shared() {}',
  });
  const graph = await indexRepository(root);
  assert.equal(graph.relations.some(relation => relation.type === 'calls'), false);
  const outcomes = entity(graph, 'main.ts').metadata.importOutcomes as { specifier: string; outcome: { status: string } }[];
  assert.deepEqual(outcomes.map(item => [item.specifier, item.outcome.status]), [['shared', 'external'], ['absent', 'excluded'], ['escaped', 'excluded'], ['absolute', 'excluded']]);
});

test('CommonJS import-equals and literal require use the indexed local package resolver', async () => {
  const root = await repository({
    'package.json': json({ workspaces: ['app', 'shared'] }),
    'app/package.json': json({ name: 'app', dependencies: { shared: 'workspace:*' } }),
    'app/tsconfig.json': json({ compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext' } }),
    'app/main.cts': 'import api = require("shared"); export function run() { return api.shared(); }',
    'app/main.cjs': 'const api = require("shared"); exports.runJs = function runJs() { return api.shared(); };',
    'app/shadow.ts': 'function require(name: string) { return {}; } export function local() { require("shared"); }',
    'shared/package.json': json({ name: 'shared', exports: { require: './source.cts', import: './wrong.mts' } }),
    'shared/source.cts': 'export function shared() {}',
    'shared/wrong.mts': 'export function wrong() {}',
  });
  const graph = await indexRepository(root);
  assert.ok(calls(graph, 'run', 'shared'));
  assert.ok(graph.relations.some(relation => relation.type === 'imports' && relation.from === entity(graph, 'main.cjs').id && relation.to === entity(graph, 'source.cts').id));
  assert.equal(graph.relations.some(relation => relation.type === 'imports' && relation.from === entity(graph, 'shadow.ts').id), false);
});

test('workspace tsconfig inheritance and arbitrary config filenames participate in cache invalidation', async () => {
  const root = await repository({
    'package.json': json({ workspaces: ['app', 'configs'] }),
    'app/package.json': json({ name: 'app', devDependencies: { configs: 'workspace:*' } }),
    'app/tsconfig.json': json({ extends: 'configs/base.json' }),
    'app/main.ts': 'import { chosen } from "chosen"; export function run() { return chosen(); }',
    'app/one.ts': 'export function chosen() { return 1; }',
    'app/two.ts': 'export function chosen() { return 2; }',
    'configs/package.json': json({ name: 'configs' }),
    'configs/base.json': json({ compilerOptions: { baseUrl: '../app', paths: { chosen: ['one.ts'] } } }),
  });
  const cache = new AnalysisCache(path.join(root, '.codiluce/cache'));
  const config = await resolveConfig(root, { repository: { name: 'fixture' } });
  const first = await indexRepository(root, { config, cache });
  assert.ok(calls(first, 'run', 'chosen', undefined, 'app/one.ts'));
  assert.equal(first.diagnostics.some(diagnostic => diagnostic.code === 'tsconfig-error'), false);
  await writeFile(path.join(root, 'configs/base.json'), json({ compilerOptions: { baseUrl: '../app', paths: { chosen: ['two.ts'] } } }));
  const changed = await indexRepository(root, { config, cache });
  assert.ok(calls(changed, 'run', 'chosen', undefined, 'app/two.ts'));
  assert.ok(cache.events.some(event => !event.hit));
  assert.equal(stored(changed), stored(await indexRepository(root, { config })));
});

test('semantic services recover exact declaration owners from a graph cache hit', async () => {
  const root = await repository({
    'package.json': json({ workspaces: ['app', 'shared'] }),
    'app/package.json': json({ name: 'app', dependencies: { shared: 'workspace:*' } }),
    'app/main.ts': 'import { action } from "shared"; export function run() { return action(); }',
    'shared/package.json': json({ name: 'shared', main: 'source.ts' }),
    'shared/source.ts': 'export const action = () => 1; export class Client { method = () => action(); }',
  });
  const config = await resolveConfig(root, { repository: { name: 'fixture' }, applications: [{ name: 'app', path: 'app', ecosystems: ['node'] }] }), cache = new AnalysisCache(path.join(root, '.codiluce/cache'));
  const analyze = async () => {
    const graph = new GraphBuilder('fixture');
    const context: AnalysisContext = { root, config, graph, repositoryId: graph.id('repository'), files: new Map(), applicationIds: new Map(), http: [], cache };
    for (const analyzer of [filesystemAnalyzer, projectAnalyzer, typescriptAnalyzer]) await analyzer.analyze(context);
    return context;
  };
  await analyze(); const replay = await analyze();
  assert.equal(cache.events.at(-1)?.hit, true);
  const services = replay.typescript!, shared = services.projectFor('shared/source.ts')!;
  const source = shared.program().getSourceFile(path.join(root, 'shared/source.ts'))!;
  const owners = shared.owners(source);
  assert.ok([...owners.keys()].some(ts.isArrowFunction));
  const consumer = services.projectFor('app/main.ts')!, program = consumer.program();
  const importedSource = program.getSourceFile(path.join(root, 'shared/source.ts'))!;
  let action: ts.ArrowFunction | undefined;
  const visit = (node: ts.Node): void => { if (ts.isVariableDeclaration(node) && node.name.getText() === 'action' && node.initializer && ts.isArrowFunction(node.initializer)) action = node.initializer; ts.forEachChild(node, visit); };
  visit(importedSource);
  assert.ok(action);
  assert.equal(services.declarations.get(action!)?.name, 'action', 'separate compiler AST instances bind by exact source site');
  services.releasePrograms();
  assert.equal(services.declarations.size, 0);
  assert.ok(services.projectFor('shared/source.ts'), 'project ownership does not require a live compiler');
  const rebuilt = shared.program().getSourceFile(path.join(root, 'shared/source.ts'))!;
  assert.ok([...shared.owners(rebuilt).values()].some(entity => entity.name === 'action'), 'released services reconstruct declaration owners from the graph');
});
