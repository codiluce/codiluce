import assert from 'node:assert/strict';
import { after, afterEach, before, test, type TestContext } from 'node:test';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { indexRepository } from '../src/pipeline/index.js';
import type { SoftwareGraph } from '../src/core/graph.js';
import { GraphStore } from '../src/storage/sqlite.js';
import { ProjectionService } from '../src/projection/service.js';
import { ProjectionIndex } from '../src/projection/hierarchy.js';
import { MapVisibility } from '../src/projection/map-visibility.js';
import { emptyRegistry, extendRegistry } from '../src/projection/layout.js';
import { HistoryStore } from '../src/history/store.js';
import { createInspectionServer, INDEX_REQUEST_HEADER } from '../src/api/server.js';

let root: string, graph: SoftwareGraph;
before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'codiluce-map-'));
  await cp(fileURLToPath(new URL('./fixtures/repository', import.meta.url)), root, { recursive: true });
  await mkdir(path.join(root, '.codiluce'));
  await mkdir(path.join(root, 'docs'));
  for (let i = 0; i < 16; i++) await writeFile(path.join(root, `docs/report-${i}.md`), '# Report\n' + 'Some documentation.\n'.repeat(1000));
  graph = await indexRepository(root);
});
after(async () => { await rm(root, { recursive: true, force: true }); });
afterEach(async () => { await rm(path.join(root, '.codiluceignore'), { force: true }); });
async function setup(t: TestContext) {
  const stateDirectory = await mkdtemp(path.join(root, '.codiluce/map-test-'));
  const store = new GraphStore(':memory:'); store.save(graph); t.after(() => store.close());
  const projection = new ProjectionService(store, { root, stateDirectory });
  return { store, projection, stateDirectory };
}
const entity = (relative: string, type = 'file') => graph.entities.find(row => row.path === relative && row.type === type)!;
const area = (projection: ProjectionService, view = {}) => { const rect = projection.meta(view).root.rect; return rect.w * rect.h; };

test('hiding reclaims space, keeps source and analysis, survives restart, and restores without holes', async t => {
  const { projection, store, stateDirectory } = await setup(t);
  const before = area(projection), file = entity('docs/report-0.md'), docs = entity('docs', 'directory');
  const counts = store.summary();
  projection.updateMapVisibility({ action: 'hide', path: 'docs' });
  assert.ok(area(projection) < before * 0.8, 'hidden docs stop reserving map space');
  assert.equal(projection.locate(docs.id).node.hidden, true);
  assert.equal(projection.locate(file.id).node.hidden, true);
  assert.ok(!projection.children(projection.meta().root.id, { limit: 500 }).items.some(node => node.id === docs.id));
  assert.equal(projection.search('report-0.md', {}).items[0]!.hidden, true);
  assert.match((await projection.source({ entity: file.id }, 1024 * 1024)).lines[0]!, /Report/);
  assert.deepEqual(store.summary(), counts, 'the canonical graph is untouched');
  const reopened = new ProjectionService(store, { root, stateDirectory });
  assert.equal(reopened.locate(file.id).node.hidden, true);
  assert.equal(area(reopened), area(projection));
  reopened.updateMapVisibility({ action: 'restore', path: 'docs' });
  assert.equal(reopened.locate(file.id).node.hidden, undefined);
  assert.equal(area(reopened), before);
  assert.equal(reopened.meta().layout.holes, 0);
  assert.deepEqual(JSON.parse(await readFile(path.join(stateDirectory, 'map-visibility.json'), 'utf8')).hidden, []);
});

test('Git-style shared rules reload without indexing, support exceptions, and restore through local overrides', async t => {
  const { projection } = await setup(t);
  const target = entity('docs/report-0.md'), other = entity('docs/report-1.md');
  const before = area(projection);
  await writeFile(path.join(root, '.codiluceignore'), '# Keep docs out of the map\n/docs/**\n!/docs/report-0.md\n');
  assert.equal(projection.locate(target.id).node.hidden, undefined);
  assert.equal(projection.locate(other.id).node.hidden, true);
  assert.ok(area(projection) < before);
  projection.updateMapVisibility({ action: 'disable-rule', pattern: '/docs/**' });
  assert.equal(projection.locate(other.id).node.hidden, undefined);
  assert.match(await readFile(path.join(root, '.codiluceignore'), 'utf8'), /\/docs\/\*\*/, 'shared file is not modified');
  projection.updateMapVisibility({ action: 'enable-rule', pattern: '/docs/**' });
  projection.updateMapVisibility({ action: 'reveal', path: 'docs/report-1.md' });
  assert.equal(projection.locate(other.id).node.hidden, undefined);
  const docs = projection.locate(entity('docs', 'directory').id).node;
  assert.equal(docs.childCount, 2, 'only the shared and local exceptions occupy the folder');
  projection.updateMapVisibility({ action: 'reveal', path: 'docs' });
  projection.updateMapVisibility({ action: 'hide', path: 'docs/report-2.md' });
  assert.equal(projection.locate(entity('docs/report-2.md').id).node.hidden, true);
  assert.equal(projection.locate(entity('docs/report-3.md').id).node.hidden, undefined, 'hiding a child preserves the revealed parent');
  projection.updateMapVisibility({ action: 'restore-all' });
  assert.equal(projection.locate(entity('docs/report-2.md').id).node.hidden, undefined);
});

test('hiding a source file preserves connections and revealing it retains only the needed ancestors', async t => {
  const { projection } = await setup(t);
  const file = entity('backend/app/Services/AuthService.php');
  const symbol = graph.entities.find(row => row.path === file.path && row.type === 'method')!;
  const relations = projection.relations(symbol.id, {}).items;
  assert.ok(relations.length);
  projection.updateMapVisibility({ action: 'hide', path: 'backend/app' });
  assert.equal(projection.locate(symbol.id).node.hidden, true);
  assert.deepEqual(projection.relations(symbol.id, {}).items.map(row => row.id), relations.map(row => row.id));
  projection.updateMapVisibility({ action: 'reveal', path: file.path! });
  assert.equal(projection.locate(symbol.id).node.hidden, undefined);
  assert.ok(projection.locate(symbol.id).spatialAncestors.every(row => !row.hidden));
  assert.equal(projection.locate(entity('backend/app/Http/Controllers/AuthController.php').id).node.hidden, true);
});

test('area roof counts omit hidden shapes while canonical file counts stay intact', async t => {
  const { projection } = await setup(t);
  const before = projection.meta().root;
  const total = (node: typeof before) => node.archetypeCounts?.reduce((sum, item) => sum + item.count, 0) ?? 0;
  projection.updateMapVisibility({ action: 'hide', path: 'backend' });
  const after = projection.meta().root;
  assert.ok(total(after) < total(before));
  assert.equal(after.stats.files, before.stats.files);
});

test('a shared directory rule also hides entities without source paths and their synthetic districts', async t => {
  const { stateDirectory } = await setup(t);
  await writeFile(path.join(root, '.codiluceignore'), '/app/\n');
  const rows = [{ id: 'r', type: 'repository', name: 'repo' }, { id: 'a', type: 'application', name: 'app', path: 'app', parentId: 'r' }, { id: 'e', type: 'api_endpoint', name: 'GET /hello', parentId: 'a' }];
  const index = new ProjectionIndex('run', rows, [], []);
  const visibility = new MapVisibility({ root, stateDirectory }, () => graph.run.repositoryId);
  assert.deepEqual([...visibility.layout(index).keys()], ['r']);
  const registry = emptyRegistry(); extendRegistry(registry, index.layoutNodes(), index.rootId);
  assert.deepEqual(visibility.registry(registry, rows).slots.r, []);
});

test('history slots, comparison ghosts and time-lapse frames reclaim hidden paths consistently', async t => {
  const { store, stateDirectory } = await setup(t);
  const history = new HistoryStore(':memory:'); t.after(() => history.close());
  const registry = emptyRegistry();
  const records = ['a', 'b'].map((letter, i) => {
    const sha = letter.repeat(40), date = `2026-01-0${i + 1}T00:00:00Z`;
    history.saveCommits([{ sha, tree: sha, parents: i ? ['a'.repeat(40)] : [], authorName: 'Test', authorEmail: 'test@example.test', authoredAt: date, committedAt: date, subject: letter, body: '' }]);
    const snapshot = structuredClone(graph); snapshot.run = { ...snapshot.run, id: `snapshot:${letter}`, commitSha: sha, dirty: false };
    if (i) {
      const removed = new Set(snapshot.entities.filter(row => row.path === 'docs' || row.path?.startsWith('docs/')).map(row => row.id));
      snapshot.entities = snapshot.entities.filter(row => !removed.has(row.id));
      snapshot.relations = snapshot.relations.filter(row => !removed.has(row.from) && !removed.has(row.to));
    }
    const record = history.saveSnapshot(snapshot, 'test');
    const index = new ProjectionIndex(record.id, history.entities(record.seq), [], []);
    extendRegistry(registry, index.layoutNodes(), index.rootId);
    return record;
  });
  history.saveLayoutRegistry(records.map(row => row.id), registry);
  const projection = new ProjectionService(store, { root, stateDirectory, history: () => history });
  const view = { snapshot: records[1]!.id, compareTo: records[0]!.id };
  const before = area(projection, view);
  projection.updateMapVisibility({ action: 'hide', path: 'docs' });
  assert.ok(area(projection, view) < before * 0.8);
  assert.equal(projection.locate(entity('docs/report-0.md').id, view).node.hidden, true);
  const frames = await projection.awaitEvolution(records.map(row => row.id));
  assert.equal(frames.status, 'ready');
  if (frames.status !== 'ready') return;
  assert.ok(!frames.nodes.some(node => node.path === 'docs' || node.path?.startsWith('docs/')));
  assert.equal(frames.frames[0]!.set.find(row => frames.nodes[row[0]!]!.type === 'repository')![4]! * frames.frames[0]!.set.find(row => frames.nodes[row[0]!]!.type === 'repository')![5]!, area(projection, { snapshot: records[0]!.id }));
  assert.equal(history.layoutRegistry()!.state.slots[graph.run.repositoryId]!.length, registry.slots[graph.run.repositoryId]!.length, 'persisted history registry is unchanged');
});

test('HTTP mutations are bounded, reject invalid paths and require the same-origin request header', async t => {
  const { store, stateDirectory } = await setup(t);
  const server = createInspectionServer(store, { root, stateDirectory });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/projection/map-visibility`;
  const post = (body: unknown, header = true) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(header ? { [INDEX_REQUEST_HEADER]: 'map-visibility' } : {}) }, body: JSON.stringify(body) });
  assert.equal((await post({ action: 'hide', path: 'docs' }, false)).status, 400);
  for (const relative of ['../docs', '/docs', '.', 'foo/../docs', 'docs\\nested', '']) assert.equal((await post({ action: 'hide', path: relative })).status, 400);
  assert.equal((await post({ action: 'unknown' })).status, 400);
  assert.equal((await post({ action: 'hide', path: 'docs' })).status, 200);
  assert.deepEqual((await (await fetch(url)).json()).hidden, ['docs']);
  assert.equal((await post({ action: 'restore', path: 'docs' })).status, 200);
  assert.equal((await post({ action: 'hide', path: 'x'.repeat(70000) })).status, 413);
});

test('read-only servers refuse map mutations and disable editing controls', async t => {
  const { store, stateDirectory } = await setup(t);
  const server = createInspectionServer(store, { root, stateDirectory, readOnly: true });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/projection/map-visibility`;
  assert.equal((await (await fetch(url)).json()).writable, false);
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', [INDEX_REQUEST_HEADER]: 'map-visibility' }, body: JSON.stringify({ action: 'hide', path: 'docs' }) });
  assert.equal(response.status, 403);
  assert.deepEqual((await (await fetch(url)).json()).hidden, []);
});
