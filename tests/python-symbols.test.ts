import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { indexRepository } from '../src/pipeline/index.js';
import { resolveConfig } from '../src/core/config.js';
import { canonicalJson } from '../src/history/fingerprint.js';
import { AnalysisCache } from '../src/pipeline/cache.js';
import type { SoftwareGraph } from '../src/core/graph.js';

const temporary: string[] = [];
after(async () => { await Promise.all(temporary.map(root => rm(root, { recursive: true, force: true }))); });
async function repository(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'codiluce-python-symbols-')); temporary.push(root);
  for (const [file, content] of Object.entries(files)) { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), content); }
  return root;
}
async function index(root: string, cache?: AnalysisCache, revision?: string) {
  const config = await resolveConfig(root, { repository: { name: 'python-symbols' }, applications: [{ name: 'api', path: '.', ecosystems: ['python'] }] });
  return indexRepository(root, { config, cache, revision });
}
function calls(graph: SoftwareGraph) { const entities = new Map(graph.entities.map(item => [item.id, item])); return graph.relations.filter(item => item.type === 'calls').map(item => `${entities.get(item.from)!.metadata.qualifiedName ?? entities.get(item.from)!.path}->${entities.get(item.to)!.metadata.qualifiedName}`).sort(); }
const stored = (graph: SoftwareGraph) => canonicalJson({ entities: graph.entities, relations: graph.relations, diagnostics: graph.diagnostics.filter(item => !['git-metrics', 'indexer'].includes(item.analyzer) && item.code !== 'git-ignore-unavailable') });

test('Python binds exact imported members, module heads, local aliases and transitive package re-exports', async () => {
  const root = await repository({
    'service/__init__.py': 'from .barrel import exported\n',
    'service/barrel.py': 'from .helpers import leaf as exported\n',
    'service/helpers.py': 'def leaf():\n    return 1\n',
    'main.py': 'import service.helpers\nimport service.helpers as mod\nfrom service import exported as handler\nalias = handler\ndef run():\n    alias()\n    mod.leaf()\n    service.helpers.leaf()\n',
  });
  const graph = await index(root);
  assert.deepEqual(calls(graph), ['run->leaf']);
  const run = graph.entities.find(item => item.name === 'run')!;
  assert.deepEqual(run.metadata.callSites, { resolved: 3, external: 0, unresolved: 0 });
  assert.ok(graph.relations.some(item => item.type === 'references' && item.from === run.id && graph.entities.find(entity => entity.id === item.to)?.name === 'leaf'));
});

test('Python lexical shadowing and whole-function locals prevent invented global calls', async () => {
  const root = await repository({ 'main.py': 'def leaf():\n    return 1\ndef outer():\n    def nested():\n        return leaf()\n    return nested()\ndef parameter(leaf):\n    return leaf()\ndef reassigned():\n    leaf()\n    leaf = other\ndef conditional():\n    if flag:\n        from helper import leaf\n    return leaf()\n', 'helper.py': 'def leaf():\n    return 2\n' });
  const graph = await index(root);
  assert.deepEqual(calls(graph), ['outer->outer.nested', 'outer.nested->leaf']);
  for (const name of ['parameter', 'reassigned', 'conditional']) assert.equal((graph.entities.find(item => item.name === name)!.metadata.callSites as any).unresolved, 1);
});

test('Python class scope, static methods and base references preserve exact owners without instance inference', async () => {
  const root = await repository({ 'main.py': 'def leaf():\n    return 1\nclass Base:\n    @staticmethod\n    def static():\n        return leaf()\n    def method(self):\n        return self.static()\nclass Child(Base):\n    pass\ndef run():\n    Base.static()\n    Child.static()\n    obj = Base()\n    obj.method()\n' });
  const graph = await index(root);
  assert.deepEqual(calls(graph), ['Base.static->leaf', 'run->Base', 'run->Base.static']);
  assert.ok(graph.relations.some(item => item.type === 'extends' && graph.entities.find(entity => entity.id === item.from)?.name === 'Child' && graph.entities.find(entity => entity.id === item.to)?.name === 'Base'));
});

test('Python bounded literal __all__ expands wildcard re-exports; dynamic, colliding and cyclic exports stay unresolved', async () => {
  const root = await repository({
    'helpers.py': 'def leaf():\n    return 1\n__all__ = ["leaf"]\n',
    'barrel.py': 'from helpers import *\n__all__ = ("leaf",)\n',
    'main.py': 'from barrel import *\ndef run():\n    return leaf()\n',
    'a.py': 'from b import loop\n', 'b.py': 'from a import loop\n', 'cycle.py': 'from a import loop\ndef run_cycle():\n    return loop()\n',
  });
  const graph = await index(root);
  assert.deepEqual(calls(graph), ['run->leaf']);
  await writeFile(path.join(root, 'helpers.py'), 'def leaf():\n    return 1\n__all__ = ["leaf"]\n__all__.append(other)\n');
  assert.deepEqual(calls(await index(root)), []);
});

test('Python custom decorators, dynamic namespaces, TYPE_CHECKING and class monkey patches block calls', async () => {
  const root = await repository({ 'helper.py': 'def leaf():\n    return 1\n', 'main.py': 'from typing import TYPE_CHECKING\nif TYPE_CHECKING:\n    from helper import leaf\n@custom\ndef wrapped():\n    return 1\nclass C:\n    def method(self):\n        return 1\nC.method = other\ndef run():\n    leaf()\n    wrapped()\n    C.method()\ndef dynamic():\n    exec(code)\n    wrapped()\n' });
  assert.deepEqual(calls(await index(root)), []);
});

test('Python repeated package-head imports share a head binding, and unknown wildcard exports cannot impersonate builtins', async () => {
  const root = await repository({ 'pkg/__init__.py': '', 'pkg/one.py': 'def one():\n    return 1\n', 'pkg/two.py': 'def two():\n    return 2\n', 'bad.py': '__all__ = ["print"]\n', 'main.py': 'import pkg.one\nimport pkg.two\nfrom bad import *\ndef run():\n    pkg.one.one()\n    pkg.two.two()\n    print()\n' });
  const graph = await index(root); assert.deepEqual(calls(graph), ['run->one', 'run->two']);
  assert.equal((graph.entities.find(item => item.name === 'run')!.metadata.callSites as any).unresolved, 1);
});

test('Python module/class mutations through aliases invalidate affected exported calls', async () => {
  const root = await repository({ 'helper.py': 'def leaf():\n    return 1\nclass C:\n    @staticmethod\n    def method():\n        return 1\n', 'main.py': 'import helper as h\nfrom helper import C\nalias = C\nh.leaf = other\nalias.method = other\ndef run():\n    h.leaf()\n    C.method()\n' });
  const graph = await index(root); assert.deepEqual(calls(graph), []); assert.equal((graph.entities.find(item => item.name === 'run')!.metadata.callSites as any).unresolved, 2);
});

test('Python bindings and scoped coverage replay on warm and revision indexes; re-export edits invalidate consumers', async () => {
  const root = await repository({ 'helper.py': 'def one():\n    return 1\ndef two():\n    return 2\n', 'barrel.py': 'from helper import one as leaf\n', 'main.py': 'from barrel import leaf\ndef run():\n    return leaf()\n' });
  const cache = new AnalysisCache(path.join(root, '.cache'));
  const cold = await index(root, cache), warm = await index(root, cache), revision = await index(root, undefined, 'fixture-revision');
  assert.equal(stored(warm), stored(cold)); assert.equal(stored(revision), stored(cold));
  assert.ok(cache.events.some(event => event.analyzer === 'python-imports' && event.hit));
  await writeFile(path.join(root, 'barrel.py'), 'from helper import two as leaf\n');
  const edited = await index(root, cache); assert.deepEqual(calls(edited), ['run->two']); assert.equal(stored(edited), stored(await index(root)));
});
