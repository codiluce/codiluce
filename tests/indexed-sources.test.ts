import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { IndexedSources } from '../src/analysis/indexed-sources.js';
import { indexRepository } from '../src/pipeline/index.js';
import { AnalysisCache } from '../src/pipeline/cache.js';
import { resolveConfig } from '../src/core/config.js';
import { GraphBuilder } from '../src/core/graph.js';
import type { AnalysisContext } from '../src/core/analyzer.js';
import { filesystemAnalyzer } from '../src/analyzers/filesystem.js';
import { canonicalJson } from '../src/history/fingerprint.js';
import { fileAnalysis } from '../src/analysis/facts.js';

const temporary: string[] = [];
after(async () => { await Promise.all(temporary.map(root => rm(root, { recursive: true, force: true }))); });
async function repository(files: Record<string, string>): Promise<string> {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'codiluce-indexed-')); temporary.push(temporaryRoot);
  const root = path.join(temporaryRoot, 'repository'); await mkdir(root);
  for (const [file, text] of Object.entries(files)) { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), text); }
  return root;
}
async function config(root: string, ignore: string[] = []) {
  return resolveConfig(root, { repository: { name: 'fixture' }, applications: [{ name: 'app', path: '.', ecosystems: ['node'] }], ignore });
}

test('indexed source lookups cannot see excluded, external, symlinked or oversized files', async () => {
  const root = await repository({ 'source/main.ts': 'export function run() {}', 'hidden/secret.ts': 'secret', 'large.ts': 'x'.repeat(1025) });
  await writeFile(path.join(root, '../outside.ts'), 'outside');
  await symlink(path.join(root, 'source/main.ts'), path.join(root, 'link.ts'));
  const settings = { ...await config(root, ['hidden/**']), maxFileBytes: 1024 };
  const graph = new GraphBuilder(settings.repository.name);
  const context: AnalysisContext = { root, config: settings, graph, repositoryId: graph.id('repository'), files: new Map(), applicationIds: new Map(), http: [] };
  await filesystemAnalyzer.analyze(context);
  const sources = new IndexedSources(context);
  for (const file of ['hidden/secret.ts', '../outside.ts', 'link.ts', 'large.ts', 'missing.ts']) {
    assert.equal(sources.fileExists(path.resolve(root, file)), false, file);
    assert.equal(sources.readFile(path.resolve(root, file)), undefined, file);
    assert.throws(() => sources.readText(file), /not an indexed readable file/, file);
  }
  assert.equal(sources.directoryExists(path.join(root, 'hidden')), false);
  assert.equal(sources.directoryExists(path.dirname(root)), false);
  assert.equal(sources.directoryExists(path.join(root, 'source')), true);
  assert.equal(sources.readText('source/main.ts'), 'export function run() {}');
  await writeFile(path.join(root, 'source/main.ts'), 'export function changed() {}');
  const changed = new IndexedSources(context);
  assert.throws(() => changed.readText('source/main.ts'), /changed after the scan/);
  assert.equal(changed.readFile(path.join(root, 'source/main.ts')), undefined);
  assert.match(changed.failures.get('source/main.ts')!, /changed after the scan/);
});

test('TypeScript file imports and symbol binding agree when an excluded source shadows an indexed module', async () => {
  const root = await repository({
    'source/main.ts': 'import { allowed } from "./shadow"; import { fake } from "poison"; export function run() { return allowed(); }\n',
    'source/shadow.ts': 'export function excluded() {}\n',
    'source/shadow.js': 'export function allowed() { return 1; }\n',
  });
  const settings = await config(root, ['source/shadow.ts']);
  const cache = new AnalysisCache(path.join(root, '.codiluce/cache'));
  const first = await indexRepository(root, { config: settings, cache });
  const entry = first.entities.find(entity => entity.path === 'source/main.ts' && entity.type === 'file')!;
  const target = first.entities.find(entity => entity.path === 'source/shadow.js' && entity.type === 'file')!;
  assert.ok(first.relations.some(relation => relation.type === 'imports' && relation.from === entry.id && relation.to === target.id));
  const run = first.entities.find(entity => entity.name === 'run' && entity.type === 'function')!;
  const allowed = first.entities.find(entity => entity.name === 'allowed' && entity.type === 'function')!;
  assert.ok(first.relations.some(relation => relation.type === 'calls' && relation.from === run.id && relation.to === allowed.id));
  await mkdir(path.join(root, 'node_modules/poison'), { recursive: true });
  await writeFile(path.join(root, 'node_modules/poison/package.json'), '{"name":"poison","types":"index.d.ts"}');
  await writeFile(path.join(root, 'node_modules/poison/index.d.ts'), 'export declare function fake(): void;');
  await writeFile(path.join(root, 'source/shadow.ts'), 'export function allowed() { throw new Error("excluded poison"); }');
  const warm = await indexRepository(root, { config: settings, cache });
  const cold = await indexRepository(root, { config: settings });
  assert.equal(canonicalJson(first.entities), canonicalJson(warm.entities));
  assert.equal(canonicalJson(warm.entities), canonicalJson(cold.entities));
  assert.equal(canonicalJson(first.relations), canonicalJson(cold.relations));
  assert.ok(cache.events.some(event => event.analyzer === 'typescript-nextjs' && event.hit));
});

test('tsconfig inheritance stays inside the indexed inventory', async () => {
  for (const inherited of ['./hidden/tsconfig.json', '../outside.json']) {
    const root = await repository({
      'tsconfig.json': JSON.stringify({ extends: inherited }),
      'hidden/tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '..', paths: { alias: ['source/real.ts'] } } }),
      'source/main.ts': 'import { real } from "alias"; export function run() { return real(); }\n',
      'source/real.ts': 'export function real() { return 1; }\n',
    });
    await writeFile(path.join(root, '../outside.json'), JSON.stringify({ compilerOptions: { baseUrl: root, paths: { alias: ['source/real.ts'] } } }));
    const graph = await indexRepository(root, { config: await config(root, ['hidden/**']) });
    assert.ok(graph.diagnostics.some(diagnostic => diagnostic.code === 'tsconfig-error' && diagnostic.file === 'tsconfig.json'), inherited);
    assert.equal(graph.relations.some(relation => relation.type === 'imports' || relation.type === 'calls'), false, inherited);
  }
});

test('shared package manifest edits invalidate cached TypeScript import outcomes', async () => {
  const root = await repository({
    'app/source/main.ts': 'import { value } from "../../shared"; export function run() { return value(); }\n',
    'shared/package.json': '{"main":"one.ts"}',
    'shared/one.ts': 'export function value() { return 1; }',
    'shared/two.ts': 'export function value() { return 2; }',
  });
  const settings = await resolveConfig(root, { repository: { name: 'fixture' }, applications: [{ name: 'app', path: 'app', ecosystems: ['node'] }] });
  const cache = new AnalysisCache(path.join(root, '.codiluce/cache'));
  const first = await indexRepository(root, { config: settings, cache });
  const target = (graph: typeof first) => graph.relations.filter(relation => relation.type === 'imports').map(relation => graph.entities.find(entity => entity.id === relation.to)?.path);
  assert.deepEqual(target(first), ['shared/one.ts']);
  await writeFile(path.join(root, 'shared/package.json'), '{"main":"two.ts"}');
  const changed = await indexRepository(root, { config: settings, cache });
  assert.deepEqual(target(changed), ['shared/two.ts']);
  assert.equal(cache.events.filter(event => event.analyzer === 'typescript-nextjs').at(-1)?.hit, false);
  const cold = await indexRepository(root, { config: settings });
  assert.equal(canonicalJson(changed.entities), canonicalJson(cold.entities));
  assert.equal(canonicalJson(changed.relations), canonicalJson(cold.relations));
});

test('capability outcomes distinguish parsed, failed, type-input, skipped and unsupported files', async () => {
  const root = await repository({
    'main.ts': 'export function run() { return 1; }',
    'bad.ts': 'export function broken( {',
    'types.d.ts': 'export declare function run(): number;',
    'types.d.mts': 'export declare function run(): number;',
    'types.d.cts': 'export declare function run(): number;',
    'large.py': 'x'.repeat(129),
    'example.swift': 'func run() {}',
    'example.php': '<?php function run() {}',
  });
  const graph = await indexRepository(root, { config: { ...await config(root), maxFileBytes: 128 } });
  const analysis = (file: string) => fileAnalysis(graph.entities.find(entity => entity.path === file && entity.type === 'file')?.metadata.analysis)!;
  assert.equal(analysis('main.ts').features.structure.status, 'supported');
  assert.equal(analysis('main.ts').features.references.status, 'partial');
  assert.equal(analysis('main.ts').features.framework.status, 'unsupported');
  assert.equal(analysis('bad.ts').features.structure.status, 'failed');
  assert.equal(analysis('bad.ts').features.references.status, 'failed');
  for (const file of ['types.d.ts', 'types.d.mts', 'types.d.cts']) {
    assert.equal(analysis(file).features.structure.status, 'disabled');
    assert.equal(graph.entities.some(entity => entity.path === file && entity.type !== 'file'), false);
  }
  assert.equal(analysis('large.py').features.structure.status, 'disabled');
  assert.equal(analysis('example.swift').features.structure.status, 'unsupported');
  assert.equal(analysis('example.php').features.structure.status, 'disabled');
});
