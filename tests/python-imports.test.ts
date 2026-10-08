import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { filesystemAnalyzer } from '../src/analyzers/filesystem.js';
import { PythonResolver, type PythonModuleOutcome } from '../src/analysis/resolution/python.js';
import { resolveConfig, type ApplicationInput } from '../src/core/config.js';
import { GraphBuilder } from '../src/core/graph.js';
import type { AnalysisContext } from '../src/core/analyzer.js';
import { indexRepository } from '../src/pipeline/index.js';
import { StructureParser } from '../src/analysis/tree-sitter/client.js';
import { AnalysisCache } from '../src/pipeline/cache.js';
import { fileAnalysis } from '../src/analysis/facts.js';
import { canonicalJson } from '../src/history/fingerprint.js';

const temporary: string[] = [];
after(async () => { await Promise.all(temporary.map(root => rm(root, { recursive: true, force: true }))); });
async function repository(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'codiluce-python-')); temporary.push(root);
  for (const [file, content] of Object.entries(files)) { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), content); }
  return root;
}
async function context(root: string, applications: ApplicationInput[] = [{ name: 'api', path: '.', ecosystems: ['python'] }], ignore: string[] = []): Promise<AnalysisContext> {
  const config = await resolveConfig(root, { repository: { name: 'fixture' }, applications, ignore });
  const graph = new GraphBuilder(config.repository.name);
  const result: AnalysisContext = { root, config, graph, repositoryId: graph.id('repository'), files: new Map(), applicationIds: new Map(), http: [] };
  await filesystemAnalyzer.analyze(result); return result;
}
function paths(outcome: PythonModuleOutcome): string[] {
  assert.equal(outcome.status, 'resolved', JSON.stringify(outcome));
  return outcome.status === 'resolved' ? outcome.modules.map(module => module.file?.path ?? module.directory) : [];
}

test('Python resolves flat packages, initializers and relative levels without distribution-name guessing', async () => {
  const root = await repository({
    'pyproject.toml': '[project]\nname="distribution_not_import_name"\nversion="1.0.0"',
    'service/__init__.py': '', 'service/main.py': '', 'service/child/__init__.py': '', 'service/child/routes.py': '', 'service/util.py': '', 'launch.py': '',
  });
  const resolver = new PythonResolver(await context(root));
  assert.deepEqual(paths(resolver.resolve('service/child/routes.py', '..util')), ['service/util.py']);
  assert.deepEqual(paths(resolver.resolve('service/child/routes.py', '.')), ['service/child/__init__.py']);
  assert.deepEqual(paths(resolver.resolve('service/__init__.py', '.util')), ['service/util.py']);
  assert.deepEqual(paths(resolver.resolve('launch.py', 'service.child.routes')), ['service/child/routes.py']);
  const imported = resolver.resolve('launch.py', 'service.child.routes');
  assert.deepEqual(imported.status === 'resolved' ? imported.parents.map(module => module.file?.path) : [], ['service/__init__.py', 'service/child/__init__.py']);
  assert.equal(resolver.resolve('launch.py', '.service').status, 'unresolved');
  assert.equal(resolver.resolve('service/child/routes.py', '...util').status, 'unresolved');
  assert.equal(resolver.resolve('launch.py', 'distribution_not_import_name').status, 'external');
  assert.equal(resolver.resolve('launch.py', 'fastapi').status, 'external');
});

test('Python src and literal packaging roots give relative imports their package context', async () => {
  for (const [manifest, text, folder] of [
    ['pyproject.toml', '[tool.setuptools.package-dir]\n""="library"', 'library'],
    ['pyproject.toml', '[tool.setuptools.packages.find]\nwhere=["library"]', 'library'],
    ['pyproject.toml', '[tool.poetry]\npackages=[{include="service",from="library"}]', 'library'],
    ['pyproject.toml', '[tool.hatch.build.targets.wheel]\npackages=["library/service"]', 'library'],
    ['setup.cfg', '[options]\npackage_dir =\n    = library\n[options.packages.find]\nwhere = library\n', 'library'],
    ['requirements.txt', 'fastapi==0.115.0', 'src'],
  ]) {
    const root = await repository({ [manifest!]: text!, [`${folder}/service/__init__.py`]: '', [`${folder}/service/main.py`]: '', [`${folder}/service/util.py`]: '', 'launch.py': '' });
    const resolver = new PythonResolver(await context(root));
    assert.deepEqual(paths(resolver.resolve(`${folder}/service/main.py`, '.util')), [`${folder}/service/util.py`], manifest);
    const absolute = resolver.resolve('launch.py', 'service.main');
    assert.equal(absolute.status, 'resolved', `${manifest}: ${text}; ${JSON.stringify(resolver.describe())}`);
    assert.deepEqual(paths(absolute), [`${folder}/service/main.py`], manifest);
    assert.equal(resolver.modulesFor(`${folder}/service/main.py`).length, 1, manifest);
  }
});

test('Python namespace portions merge, but a regular package or module fixes its child search path', async () => {
  const root = await repository({
    'a/company/one.py': '', 'b/company/two.py': '', 'launch.py': '',
    'a/blocked/__init__.py': '', 'a/blocked/one.py': '', 'b/blocked/two.py': '',
    'a/plain.py': '', 'b/plain/two.py': '', 'a/priority.py': '', 'a/priority/__init__.py': '', 'a/priority/one.py': '',
  });
  const resolver = new PythonResolver(await context(root, [{ name: 'api', path: '.', ecosystems: ['python'], sourceRoots: { python: ['a', 'b', '.'] } }]));
  assert.deepEqual(paths(resolver.resolve('launch.py', 'company')).sort(), ['a/company', 'b/company']);
  assert.deepEqual(paths(resolver.resolve('launch.py', 'company.two')), ['b/company/two.py']);
  assert.deepEqual(paths(resolver.resolve('launch.py', 'blocked.one')), ['a/blocked/one.py']);
  assert.equal(resolver.resolve('launch.py', 'blocked.two').status, 'unresolved');
  assert.equal(resolver.resolve('launch.py', 'plain.two').status, 'unresolved');
  assert.deepEqual(paths(resolver.resolve('launch.py', 'priority')), ['a/priority/__init__.py']);
  assert.deepEqual(paths(resolver.resolve('launch.py', 'priority.one')), ['a/priority/one.py']);
});

test('Python duplicate roots and overlapping configured package contexts remain ambiguous', async () => {
  const root = await repository({ 'a/service/__init__.py': '', 'a/service/run.py': '', 'b/service/__init__.py': '', 'b/service/run.py': '', 'launch.py': '' });
  const resolver = new PythonResolver(await context(root, [{ name: 'api', path: '.', ecosystems: ['python'], sourceRoots: { python: ['a', 'b', '.'] } }]));
  assert.equal(resolver.resolve('launch.py', 'service.run').status, 'ambiguous');
  assert.equal(resolver.resolve('a/service/run.py', '.').status, 'ambiguous');
  const anchored = new PythonResolver(await context(root, [{ name: 'api', path: '.', ecosystems: ['python'], sourceRoots: { python: ['a', 'b'] } }]));
  assert.deepEqual(paths(anchored.resolve('a/service/run.py', '.')), ['a/service/__init__.py']);
  assert.deepEqual(paths(anchored.resolve('b/service/run.py', '.')), ['b/service/__init__.py']);
});

test('Python project ownership isolates nested applications; configured shared roots are explicit', async () => {
  const root = await repository({ 'api/main.py': '', 'api/pyproject.toml': '[project]\nname="api"', 'worker/pyproject.toml': '[project]\nname="worker"', 'worker/jobs.py': '', 'shared/util.py': '' });
  const apps: ApplicationInput[] = [{ name: 'api', path: 'api', ecosystems: ['python'] }, { name: 'worker', path: 'worker', ecosystems: ['python'] }];
  const resolver = new PythonResolver(await context(root, apps));
  assert.equal(resolver.owner('api/main.py')?.root, 'api');
  assert.equal(resolver.resolve('api/main.py', 'worker.jobs').status, 'external');
  assert.equal(resolver.resolve('api/main.py', 'util').status, 'external');
  const shared = new PythonResolver(await context(root, [{ ...apps[0]!, sourceRoots: { python: ['.', '../shared'] } }, apps[1]!]));
  assert.deepEqual(paths(shared.resolve('api/main.py', 'util')), ['shared/util.py']);
});

test('Python resolution uses indexed inputs only and keeps stub-only modules out of runtime imports', async () => {
  const root = await repository({ 'main.py': '', 'hidden/secret.py': '', '.venv/installed/fake.py': '', 'types.pyi': 'def run() -> None: ...', 'large.py': 'x'.repeat(200), 'opaque/__init__.py': 'x'.repeat(200), 'opaque/child.py': '' });
  await symlink(path.join(root, 'main.py'), path.join(root, 'link.py'));
  const state = await context(root, undefined, ['hidden/**']);
  state.config.maxFileBytes = 128;
  const limited = { ...state, graph: new GraphBuilder('limits'), files: new Map() };
  await filesystemAnalyzer.analyze(limited);
  const resolver = new PythonResolver(limited);
  for (const name of ['hidden.secret', 'installed.fake', 'link', 'types']) assert.equal(resolver.resolve('main.py', name).status, 'external', name);
  assert.equal(resolver.resolve('main.py', 'large').status, 'excluded', 'a known unavailable local module cannot prove an external package');
  assert.equal(resolver.resolve('main.py', '../outside').status, 'unsupported');
  assert.equal(resolver.resolve('main.py', 'opaque.child').status, 'excluded');
});

test('Python source-root configuration rejects absolute, invalid and escaping paths', async () => {
  const root = await repository({ 'main.py': '' });
  for (const sourceRoot of ['/tmp', '../../outside', 'C:/outside', 'bad\\root', 'bad\0root']) await assert.rejects(resolveConfig(root, { applications: [{ name: 'api', path: '.', sourceRoots: { python: [sourceRoot] } }] }), /sourceRoots|outside repository/);
});

test('Python grammar imports preserve aliases, branches, owners and original Unicode/CRLF ranges', async () => {
  const source = '# é😀\r\nimport os, service.util as u\r\nfrom . import (one as first, two)\r\nfrom ..pkg import *\r\nclass Service:\r\n    def run(self, TC):\r\n        if TC:\r\n            from service import util\r\n        else:\r\n            import fallback\r\n';
  const parser = new StructureParser();
  try {
    const parsed = await parser.parse('python', source), imports = parsed.python!.imports;
    assert.equal(parsed.issues.length, 0);
    assert.deepEqual(imports.map(fact => [fact.kind, fact.specifier, fact.bindings]), [
      ['import', 'os', [{ imported: 'os', local: 'os' }]], ['import', 'service.util', [{ imported: 'service.util', local: 'u' }]],
      ['from', '.', [{ imported: 'one', local: 'first' }, { imported: 'two', local: 'two' }]], ['from', '..pkg', [{ imported: '*', local: '*' }]],
      ['from', 'service', [{ imported: 'util', local: 'util' }]], ['import', 'fallback', [{ imported: 'fallback', local: 'fallback' }]],
    ]);
    const method = parsed.declarations.find(declaration => declaration.name === 'run')!;
    assert.equal(imports[4]!.scope, method.key);
    assert.deepEqual(imports[4]!.guards, [{ expression: 'TC', branch: true, scope: method.key }]);
    assert.deepEqual(imports[5]!.guards, [{ expression: 'TC', branch: false, scope: method.key }]);
    assert.ok(parsed.python!.writes.some(write => write.name === 'TC' && write.kind === 'parameter' && write.scope === method.key));
    assert.equal(imports[0]!.start, source.indexOf('import os'));
    assert.deepEqual(imports[0]!.range, { startLine: 2, startColumn: 1, endLine: 2, endColumn: 'import os, service.util as u'.length + 1 });
  } finally { parser.close(); }
});

test('Python graph import outcomes include package parents, scoped aliases, namespace members and visible gaps', async () => {
  const root = await repository({
    'service/__init__.py': '', 'service/util.py': 'def run():\n    return 1\n', 'namespace/tool.py': '',
    'main.py': 'import service.util as u\nfrom namespace import tool\nfrom service import util as helper\nfrom service.util import *\ndef deferred():\n    from service.util import run as invoke\n',
  });
  const state = await context(root), graph = await indexRepository(root, { config: state.config });
  const main = graph.entities.find(entity => entity.path === 'main.py' && entity.type === 'file')!;
  const targets = graph.relations.filter(relation => relation.type === 'imports' && relation.from === main.id).map(relation => graph.entities.find(entity => entity.id === relation.to)?.path);
  assert.ok(targets.includes('service/__init__.py'));
  assert.ok(targets.includes('service/util.py'));
  assert.ok(targets.includes('namespace'));
  assert.ok(targets.includes('namespace/tool.py'));
  const outcomes = main.metadata.importOutcomes as { specifier: string; bindings: unknown[]; scopeId?: string; deferred?: boolean; outcome: { status: string } }[];
  assert.deepEqual(outcomes.find(item => item.specifier === 'service.util')?.bindings, [{ imported: 'service.util', local: 'u' }]);
  const deferred = graph.entities.find(entity => entity.name === 'deferred' && entity.type === 'function')!;
  assert.ok(outcomes.some(item => item.scopeId === deferred.id && item.deferred));
  assert.ok(graph.diagnostics.some(diagnostic => diagnostic.code === 'python-wildcard-import'));
  assert.equal(fileAnalysis(main.metadata.analysis)?.features.imports.status, 'partial');
  assert.equal(fileAnalysis(main.metadata.analysis)?.features.references.status, 'partial');
  assert.equal(graph.relations.some(relation => relation.type === 'calls'), false);
});

test('Python TYPE_CHECKING provenance respects aliases, branches, parameters, reassignment and local shadow packages', async () => {
  const source = 'from typing import TYPE_CHECKING as TC\nimport typing as t\nif TC:\n    import type_one\nelse:\n    import runtime_one\nif not (t.TYPE_CHECKING):\n    import runtime_two\nelse:\n    import type_two\ndef inherited():\n    if TC:\n        import type_nested\ndef masked(TC):\n    if TC:\n        import runtime_masked\n';
  const root = await repository({ 'main.py': source });
  const graph = await indexRepository(root, { config: (await context(root)).config });
  const flags = (graph.entities.find(entity => entity.path === 'main.py' && entity.type === 'file')!.metadata.importOutcomes as { specifier: string; typeOnly?: boolean }[]).filter(item => item.typeOnly).map(item => item.specifier);
  assert.deepEqual(flags, ['type_one', 'type_two', 'type_nested']);
  for (const extra of ['TC = True\n', 't.TYPE_CHECKING = True\n']) {
    await writeFile(path.join(root, 'main.py'), source + extra);
    const changed = await indexRepository(root, { config: (await context(root)).config });
    const names = (changed.entities.find(entity => entity.path === 'main.py' && entity.type === 'file')!.metadata.importOutcomes as { specifier: string; typeOnly?: boolean }[]).filter(item => item.typeOnly).map(item => item.specifier);
    assert.deepEqual(names, extra.startsWith('TC') ? ['type_two'] : ['type_one', 'type_nested']);
  }
  await writeFile(path.join(root, 'main.py'), source);
  await writeFile(path.join(root, 'typing.py'), 'TYPE_CHECKING = True');
  const local = await indexRepository(root, { config: (await context(root)).config });
  assert.equal((local.entities.find(entity => entity.path === 'main.py' && entity.type === 'file')!.metadata.importOutcomes as { typeOnly?: boolean }[]).some(item => item.typeOnly), false);
});

test('Python package attributes, re-exports and dynamic initializers prevent guessed child-module imports', async () => {
  for (const initializer of ['util = 1', 'def util():\n    return 1\n', 'from other import value as util', 'def __getattr__(name):\n    return 1\n', 'exec("util = 1")']) {
    const root = await repository({ 'main.py': 'from service import util\n', 'service/__init__.py': initializer, 'service/util.py': '' });
    const graph = await indexRepository(root, { config: (await context(root)).config });
    const main = graph.entities.find(entity => entity.path === 'main.py' && entity.type === 'file')!, util = graph.entities.find(entity => entity.path === 'service/util.py' && entity.type === 'file')!;
    assert.equal(graph.relations.some(relation => relation.type === 'imports' && relation.from === main.id && relation.to === util.id), false, initializer);
  }
});

test('Python cold, warm and materialized-revision imports agree and source-root edits invalidate outcomes', async () => {
  const root = await repository({ 'pyproject.toml': '[tool.setuptools.package-dir]\n""="one"', 'main.py': 'import service.util\n', 'one/service/__init__.py': '', 'one/service/util.py': '', 'two/service/__init__.py': '', 'two/service/util.py': '' });
  const config = (await context(root)).config, cache = new AnalysisCache(path.join(root, '.codiluce/cache'));
  const first = await indexRepository(root, { config, cache }), warm = await indexRepository(root, { config, cache }), revision = await indexRepository(root, { config, revision: 'abc123' });
  for (const other of [warm, revision]) { assert.equal(canonicalJson(first.entities), canonicalJson(other.entities)); assert.equal(canonicalJson(first.relations), canonicalJson(other.relations)); }
  assert.ok(cache.events.some(event => event.analyzer === 'python-imports' && event.hit));
  await writeFile(path.join(root, 'pyproject.toml'), '[tool.setuptools.package-dir]\n""="two"');
  const changed = await indexRepository(root, { config, cache }), cold = await indexRepository(root, { config });
  assert.equal(cache.events.filter(event => event.analyzer === 'python-imports').at(-1)?.hit, false);
  assert.equal(canonicalJson(changed.entities), canonicalJson(cold.entities)); assert.equal(canonicalJson(changed.relations), canonicalJson(cold.relations));
  const main = changed.entities.find(entity => entity.path === 'main.py' && entity.type === 'file')!;
  assert.deepEqual(changed.relations.filter(relation => relation.type === 'imports' && relation.from === main.id).map(relation => changed.entities.find(entity => entity.id === relation.to)?.path).sort(), ['two/service/__init__.py', 'two/service/util.py']);
});

test('Python explicit root failures remain unsupported rather than falling back to a lookalike package', async () => {
  for (const manifest of ['[tool.setuptools.package-dir]\n""="../outside"', '[tool.setuptools.package-dir]\nservice="library/service"', 'invalid [ toml']) {
    const root = await repository({ 'pyproject.toml': manifest, 'main.py': '', 'service.py': '' });
    const state = await context(root), resolver = new PythonResolver(state);
    assert.equal(resolver.resolve('main.py', 'service').status, 'unsupported');
    assert.ok([...state.graph.diagnostics.values()].some(diagnostic => /python.*(?:root|map|config)/.test(diagnostic.code)));
  }
});

test('Python dynamic imports and proven search-path mutations produce gaps without reading runtime dependencies', async () => {
  for (const mutation of ['s.path.append("../outside")', 's . path . append("../outside")', 's.path = ["../outside"]', 's.path[0] = "../outside"', 'from sys import path as p\np.insert(0, "../outside")', 'from sys import path as p\np[0] = "../outside"', 'from sys import path as p\np += ["../outside"]', 's.modules["local"] = fake']) {
    const root = await repository({ 'main.py': `import sys as s\n${mutation}\nimport local\n`, 'local.py': '', 'sys.py': 'def fake():\n    return 1\n' });
    const graph = await indexRepository(root, { config: (await context(root)).config });
    const main = graph.entities.find(entity => entity.path === 'main.py' && entity.type === 'file')!;
    assert.equal(graph.relations.some(relation => relation.type === 'imports' && relation.from === main.id), false, mutation);
    assert.ok(graph.diagnostics.some(diagnostic => diagnostic.code === 'python-runtime-import-path'), mutation);
    assert.equal((main.metadata.importOutcomes as { specifier: string; outcome: { status: string } }[]).find(item => item.specifier === 'local')!.outcome.status, 'unsupported');
  }
  const root = await repository({ 'main.py': 'import importlib as il\nfrom importlib import import_module as load\nil.import_module(name)\nload("local")\n__import__(name)\nimport sys\nsys.path.copy()\nimport local\n', 'local.py': '' });
  const graph = await indexRepository(root, { config: (await context(root)).config });
  assert.equal(graph.diagnostics.filter(diagnostic => diagnostic.code === 'python-dynamic-import').length, 3);
  assert.equal(graph.diagnostics.some(diagnostic => diagnostic.code === 'python-runtime-import-path'), false);
  assert.ok(graph.relations.some(relation => relation.type === 'imports' && graph.entities.find(entity => entity.id === relation.to)?.path === 'local.py'));
  await writeFile(path.join(root, 'main.py'), 'import importlib.util\nimportlib.import_module(name)\n');
  const head = await indexRepository(root, { config: (await context(root)).config });
  assert.equal(head.diagnostics.filter(diagnostic => diagnostic.code === 'python-dynamic-import').length, 1);
});

test('Python path lookalikes and shadowed dynamic helpers do not impersonate standard modules', async () => {
  const root = await repository({ 'main.py': 'class Thing:\n    def append(self, value):\n        return value\nimport importlib as il\ndef __import__(name):\n    return name\nil.import_module(name)\n__import__(name)\n', 'importlib.py': 'def import_module(name):\n    return name\n' });
  const graph = await indexRepository(root, { config: (await context(root)).config });
  assert.equal(graph.diagnostics.some(diagnostic => ['python-dynamic-import', 'python-runtime-import-path'].includes(diagnostic.code)), false);
});

test('Python comprehension/lambda locals and class scopes do not create false import provenance', async () => {
  const root = await repository({ 'main.py': 'from typing import TYPE_CHECKING as TC\nimport importlib as il\nitems = [TC for TC in range(3)]\nif TC:\n    import type_only\nvalues = [il.import_module(name) for il in values]\nfn = lambda il: il.import_module(name)\nclass Holder:\n    from local import TC\n    if TC:\n        import runtime_class\n    def method(self):\n        if TC:\n            import type_method\n', 'local.py': 'TC = True\n' });
  const graph = await indexRepository(root, { config: (await context(root)).config });
  const flags = (graph.entities.find(entity => entity.path === 'main.py' && entity.type === 'file')!.metadata.importOutcomes as { specifier: string; typeOnly?: boolean }[]).filter(item => item.typeOnly).map(item => item.specifier);
  assert.deepEqual(flags, ['type_only', 'type_method']);
  assert.equal(graph.diagnostics.some(diagnostic => diagnostic.code === 'python-dynamic-import'), false);
});

test('Python executable packaging config needs a static source-root override', async () => {
  const root = await repository({ 'setup.py': 'raise RuntimeError("must not execute")\n', 'main.py': 'import local\n', 'local.py': '' });
  const state = await context(root), resolver = new PythonResolver(state);
  assert.equal(resolver.resolve('main.py', 'local').status, 'unsupported');
  assert.ok([...state.graph.diagnostics.values()].some(diagnostic => diagnostic.code === 'python-executable-project-config'));
  const configured = new PythonResolver(await context(root, [{ name: 'api', path: '.', sourceRoots: { python: ['.'] } }]));
  assert.deepEqual(paths(configured.resolve('main.py', 'local')), ['local.py']);
});

test('Python parent package path mutation prevents a fabricated child import', async () => {
  const root = await repository({ 'main.py': 'import service.util\n', 'service/__init__.py': '__path__ = calculate_paths()\n', 'service/util.py': '' });
  const graph = await indexRepository(root, { config: (await context(root)).config });
  const main = graph.entities.find(entity => entity.path === 'main.py' && entity.type === 'file')!;
  assert.equal(graph.relations.some(relation => relation.type === 'imports' && relation.from === main.id), false);
  assert.ok(graph.diagnostics.some(diagnostic => diagnostic.code === 'python-import-unsupported' && diagnostic.file === 'main.py'));
});
