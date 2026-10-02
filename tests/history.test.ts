// History: historical indexing into the versioned store, lineage and diffs,
// snapshot-aware projection and timeline layout, Git-blob source and source
// diffs, and the HTTP surface — against a scripted Git history.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { indexRepository } from '../src/pipeline/index.js';
import { GraphStore } from '../src/storage/sqlite.js';
import { createInspectionServer } from '../src/api/server.js';
import { ProjectionService } from '../src/projection/service.js';
import { emptyRegistry, extendRegistry, placeOnTimeline, timelineLayout, type LayoutNode, type Rect } from '../src/projection/layout.js';
import { HISTORY_DATABASE, historyConfig, historyIdentity, indexHistory, revisionConfig } from '../src/history/indexer.js';
import { HistoryStore, type SnapshotRecord } from '../src/history/store.js';
import { HistoryAccess, HistoryService } from '../src/history/service.js';
import { CommitSnapshot } from '../src/history/snapshot.js';
import { computeDiff } from '../src/history/diff.js';
import { directoryRenames } from '../src/history/lineage.js';
import { lineDiff } from '../src/history/textdiff.js';
import { readBlobAt, renamedPaths, TreeMirror } from '../src/history/git.js';
import { fetchGitHubPullRequests, githubRepository, pullRequestFromMessage } from '../src/history/pull-requests.js';
import { createHistoryFixture, type HistoryFixture } from './history-fixture.js';

let fixture: HistoryFixture, history: HistoryStore, store: GraphStore, projection: ProjectionService;
const snapshots: Record<string, SnapshotRecord> = {};
before(async () => {
  fixture = await createHistoryFixture();
  const result = await indexHistory({ root: fixture.root, stateDirectory: fixture.state, ref: 'main', jobs: 1 });
  assert.equal(result.indexed, 4);
  assert.equal(result.failed, 0);
  history = new HistoryStore(path.join(fixture.state, HISTORY_DATABASE), true);
  const byCommit = history.snapshotsByCommit();
  for (const [name, sha] of Object.entries(fixture.commits)) snapshots[name] = byCommit.get(sha)!;
  // The live working tree equals D, where the configured backend/ now lives at server/.
  store = new GraphStore(':memory:');
  store.save(await indexRepository(fixture.root, { config: (await revisionConfig(await historyConfig(fixture.root, fixture.state), fixture.root)).config }));
  const access = new HistoryAccess(fixture.state);
  projection = new ProjectionService(store, { root: fixture.root, stateDirectory: fixture.state, history: access.get });
});
after(async () => { history.close(); store.close(); await fixture.cleanup(); });

const view = (target: string, baseline?: string) => ({ snapshot: snapshots[target]!.id, ...(baseline ? { compareTo: snapshots[baseline]!.id } : {}) });
const entityIn = (snapshot: string, predicate: (row: ReturnType<HistoryStore['entities']>[number]) => boolean) => {
  const found = history.entities(snapshots[snapshot]!.seq).find(predicate);
  assert.ok(found, `entity in ${snapshot}`);
  return found;
};

// --- Indexing and storage ------------------------------------------------------------
test('history indexing is idempotent and content-addressed', async () => {
  const again = await indexHistory({ root: fixture.root, stateDirectory: fixture.state, ref: 'main', jobs: 1 });
  assert.deepEqual([again.indexed, again.skipped, again.snapshots], [0, 4, 4]);
  const status = history.status() as { versions: { entities: number }; memberships: { entities: number } };
  const perSnapshot = snapshots.A!.stats.entities;
  assert.ok(status.memberships.entities >= perSnapshot * 4);
  assert.ok(status.versions.entities < perSnapshot * 2, `unchanged entities are shared between snapshots (${status.versions.entities} versions)`);
  assert.equal(snapshots.B!.run.commitSha, fixture.commits.B);
  assert.equal(snapshots.B!.run.dirty, false);
  // Snapshot identity includes configuration: analyzing under a changed config is a new identity.
  const raw = await historyConfig(fixture.root, fixture.state);
  assert.notEqual(historyIdentity(raw), historyIdentity({ ...raw, ignore: ['**/notes/**'] }));
});
test('a moved application keeps its configured name (and its symbols) at older or newer paths', async () => {
  assert.deepEqual(snapshots.D!.stats.substitutedApplications, { backend: 'server' });
  assert.equal(snapshots.C!.stats.applicationSource, 'configured');
  const before = entityIn('C', row => row.qualifiedName === 'App\\Services\\AuthService');
  const after = entityIn('D', row => row.qualifiedName === 'App\\Services\\AuthService');
  assert.equal(after.id, before.id, 'PHP symbol identity survives the move');
  assert.equal(after.path, 'server/app/Services/AuthService.php');
  // Policy check on a scratch tree with nothing configured present: autodetection takes over.
  const { applications } = await revisionConfig({ ...await historyConfig(fixture.root, fixture.state), applications: [{ name: 'web', path: 'missing', type: 'nextjs' }, { name: 'api', path: 'gone', type: 'laravel' }] }, fixture.root);
  assert.equal(applications.source, 'substituted');
  assert.deepEqual(applications.substituted, { web: 'frontend', api: 'server' });
});
test('the tree mirror reproduces every commit exactly, including file/directory swaps', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'atlas-mirror-'));
  try {
    const mirror = new TreeMirror(fixture.root, path.join(directory, 'tree'));
    const list = async (root: string, prefix = ''): Promise<string[]> => (await Promise.all((await readdir(path.join(root, prefix), { withFileTypes: true })).map(entry => entry.isDirectory() ? list(root, `${prefix}${entry.name}/`) : Promise.resolve([`${prefix}${entry.name}`])))).flat();
    for (const sha of [fixture.commits.A, fixture.commits.C, fixture.commits.B, fixture.commits.D]) {
      await mirror.checkout(sha);
      const expected = execFileSync('git', ['ls-tree', '-r', '--name-only', sha], { cwd: fixture.root, encoding: 'utf8' }).trim().split('\n').sort();
      assert.deepEqual((await list(path.join(directory, 'tree'))).sort(), expected, `files at ${sha.slice(0, 7)}`);
      const blob = execFileSync('git', ['show', `${sha}:frontend/src/services/requests.ts`], { cwd: fixture.root });
      assert.ok(blob.equals(await readFile(path.join(directory, 'tree/frontend/src/services/requests.ts'))));
    }
    assert.ok((await stat(path.join(directory, 'tree/notes'))).isDirectory());
  } finally { await rm(directory, { recursive: true, force: true }); }
});

// --- Diff and lineage ----------------------------------------------------------------
test('content edits are modified, additions added; line shifts alone are not changes', async () => {
  const A = new CommitSnapshot(history, snapshots.A!, fixture.root).load(), B = new CommitSnapshot(history, snapshots.B!, fixture.root).load();
  const diff = computeDiff(A, B, await renamedPaths(fixture.root, fixture.commits.A, fixture.commits.B));
  const status = (predicate: (row: (typeof B.entities)[number]) => boolean) => { const entity = [...B.entities, ...diff.ghosts].find(predicate)!; return diff.changes.get(entity.id); };
  assert.deepEqual(status(row => row.name === 'login' && row.type === 'function')?.facets, ['source']);
  assert.equal(status(row => row.name === 'login' && row.type === 'function')?.status, 'modified');
  assert.equal(status(row => row.name === 'Signup')?.status, 'added');
  assert.equal(status(row => row.qualifiedName === 'App\\Services\\AuthService::authenticate')?.status, 'modified');
  // Functions after login() in requests.ts moved down a line: same shape and source, so unchanged.
  assert.equal(status(row => row.name === 'useAuth' && row.type === 'function'), undefined);
  assert.equal(status(row => row.name === 'LoginForm' && row.type === 'component'), undefined);
  assert.equal(status(row => row.type === 'directory' && row.path === 'notes')?.status, 'added');
  assert.equal(diff.ghosts.find(row => row.path === 'notes')?.type, 'file', 'the replaced file is a ghost');
});
test('renames, signature changes and removed routes are followed through lineage', async () => {
  const B = new CommitSnapshot(history, snapshots.B!, fixture.root).load(), C = new CommitSnapshot(history, snapshots.C!, fixture.root).load();
  const renames = await renamedPaths(fixture.root, fixture.commits.B, fixture.commits.C);
  assert.equal(renames.get('frontend/src/components/LoginForm.tsx'), 'frontend/src/components/auth/LoginForm.tsx');
  const diff = computeDiff(B, C, renames);
  const file = C.entities.find(row => row.path === 'frontend/src/components/auth/LoginForm.tsx' && row.type === 'file')!;
  assert.deepEqual({ status: diff.changes.get(file.id)?.status, lineage: diff.changes.get(file.id)?.lineage }, { status: 'moved', lineage: 'git-rename' });
  const component = C.entities.find(row => row.name === 'LoginForm' && row.type === 'component')!;
  const oldComponent = B.entities.find(row => row.name === 'LoginForm' && row.type === 'component')!;
  assert.notEqual(component.id, oldComponent.id, 'TypeScript symbol IDs include the module path');
  assert.equal(diff.lineage.forward.get(oldComponent.id), component.id);
  assert.equal(diff.changes.get(component.id)?.status, 'unchanged', 'it moved with its file and did not change');
  const user = C.entities.find(row => row.qualifiedName === 'App\\Http\\Controllers\\AuthController::user')!;
  assert.deepEqual([diff.changes.get(user.id)?.status, diff.changes.get(user.id)?.lineage, diff.changes.get(user.id)?.facets.includes('signature')], ['modified', 'qualified-name', true]);
  const ghost = diff.ghosts.find(row => row.type === 'api_endpoint' && row.name === 'GET /users/{id}');
  assert.ok(ghost, 'the removed endpoint is a ghost');
  assert.ok(diff.removedRelations.some(relation => relation.to === ghost.id && relation.type === 'requests'), 'its incoming request is removed');
  assert.ok(diff.addedDiagnostics.some(item => item.code === 'unmatched-http-call'), 'the call is now unmatched');
  assert.equal(diff.summary.interfaces.find(item => item.name === 'GET /users/{id}')?.status, 'removed');
});
test('commit impact: what depends on the entities a commit changed or removed', async () => {
  await projection.prepare(view('B', 'A'));
  const impact = projection.commitImpact(view('B', 'A'), { depth: 8, limit: 200 });
  assert.equal(impact.origin.kind, 'comparison');
  const id = (predicate: (row: ReturnType<HistoryStore['entities']>[number]) => boolean) => entityIn('B', predicate).id;
  // B edited login() and AuthService::authenticate: both seed the walk; their files do not, because symbols inside them changed.
  assert.equal(impact.distances[id(row => row.name === 'login' && row.type === 'function')], 0);
  assert.equal(impact.distances[id(row => row.qualifiedName === 'App\\Services\\AuthService::authenticate')], 0);
  assert.equal(impact.distances[id(row => row.path === 'frontend/src/components/LoginForm.tsx' && row.type === 'file')], undefined);
  assert.equal(impact.distances[id(row => row.name === 'LoginForm' && row.type === 'component')], 1);
  assert.equal(impact.distances[id(row => row.qualifiedName === 'App\\Http\\Controllers\\AuthController::login')], 1);
  assert.ok(impact.items.items.some(item => item.type === 'route' && item.name === '/login'));
  assert.ok(impact.highlights.endpoints > 0);
  assert.ok(!impact.items.items.some(item => item.name === 'Signup'), 'an added entity has no dependents yet');
  // The same over HTTP; a comparison is required.
  const server = createInspectionServer(store, { root: fixture.root, stateDirectory: fixture.state });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const served = await (await fetch(`${base}/api/history/impact?snapshot=${snapshots.B!.id}&compareTo=${snapshots.A!.id}&depth=8`)).json() as { total: number };
    assert.equal(served.total, impact.total);
    assert.equal((await fetch(`${base}/api/history/impact?snapshot=${snapshots.B!.id}`)).status, 400);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
test('moving an application directory reads as moves, not as a rewrite', async () => {
  const C = new CommitSnapshot(history, snapshots.C!, fixture.root).load(), D = new CommitSnapshot(history, snapshots.D!, fixture.root).load();
  const renames = await renamedPaths(fixture.root, fixture.commits.C, fixture.commits.D);
  assert.equal(directoryRenames(renames).get('backend/app/Http'), 'server/app/Http');
  const diff = computeDiff(C, D, renames);
  assert.equal(diff.summary.entities.removed, 0);
  assert.equal(diff.summary.entities.added, 0);
  assert.equal(diff.summary.applications.find(app => app.name === 'backend')?.status, 'moved');
  const service = D.entities.find(row => row.qualifiedName === 'App\\Services\\AuthService')!;
  assert.equal(diff.changes.get(service.id), undefined, 'symbols are untouched');
  assert.equal(diff.summary.relations.added + diff.summary.relations.removed, 0, 'relationships map through lineage');
});

// --- Projection views -----------------------------------------------------------------
test('comparison views place removed entities as ghosts and report change counts by area', async () => {
  await projection.prepare(view('C', 'B'));
  const meta = projection.meta(view('C', 'B'));
  assert.equal(meta.snapshot.commitSha, fixture.commits.C);
  assert.equal(meta.comparison?.baseline.commitSha, fixture.commits.B);
  assert.equal(meta.layout.source, 'timeline');
  const ghost = projection.search('users', { view: view('C', 'B'), type: 'api_endpoint' }).items.find(item => item.name === 'GET /users/{id}')!;
  assert.equal(ghost.change?.status, 'removed');
  const located = projection.locate(ghost.id, view('C', 'B'));
  assert.equal(located.spatialAncestors.at(-1)!.kind, 'group', 'still in its routes district');
  const backend = located.spatialAncestors.find(node => node.name === 'backend')!;
  assert.ok(backend.changes!.removed >= 1 && backend.changes!.modified >= 1);
  const detail = projection.change(ghost.id, view('C', 'B'));
  assert.equal(detail.before?.entity.name, 'GET /users/{id}');
  assert.equal(detail.after, undefined);
  const changes = projection.changes(view('C', 'B'), { status: 'moved' });
  assert.ok(changes.items.some(item => item.path === 'frontend/src/components/auth/LoginForm.tsx' && item.change?.previousPath === 'frontend/src/components/LoginForm.tsx'));
  // Snapshot views (no baseline) have no change data; the live view keeps the classic layout.
  assert.equal(projection.meta(view('C')).comparison, undefined);
  assert.equal(projection.meta().layout.source, 'persisted');
});
test('selections follow renames between views, in both directions of time', async () => {
  const oldComponent = entityIn('B', row => row.name === 'LoginForm' && row.type === 'component').id;
  const newComponent = entityIn('C', row => row.name === 'LoginForm' && row.type === 'component').id;
  await projection.prepare({ snapshot: snapshots.C!.id, compareTo: snapshots.B!.id });
  assert.deepEqual(projection.resolve(oldComponent, view('C'), snapshots.B!.id), { id: newComponent, via: 'lineage' });
  await projection.prepare({ snapshot: snapshots.B!.id, compareTo: snapshots.C!.id });
  assert.deepEqual(projection.resolve(newComponent, view('B'), snapshots.C!.id), { id: oldComponent, via: 'lineage' });
  assert.equal(projection.resolve('symbol:none', view('B')), undefined);
});
test('the timeline layout keeps every surviving entity in place and never overlaps', () => {
  const rects = (name: string) => (projection as unknown as { load(view: object): { rects: Map<string, Rect>; index: { nodes: Map<string, { children: string[] }> } } }).load(view(name));
  const names = ['A', 'B', 'C', 'D'];
  for (let i = 0; i < names.length; i++) {
    const current = rects(names[i]!);
    for (const [id, node] of current.index.nodes) {
      const parent = current.rects.get(id)!;
      const children = node.children.map(child => current.rects.get(child)!);
      for (const child of children) assert.ok(child.x >= parent.x && child.y >= parent.y && child.x + child.w <= parent.x + parent.w && child.y + child.h <= parent.y + parent.h, `contained in ${id}`);
      for (let a = 0; a < children.length; a++) for (let b = a + 1; b < children.length; b++) { const x = children[a]!, y = children[b]!; assert.ok(!(x.x < y.x + y.w && y.x < x.x + x.w && x.y < y.y + y.h && y.y < x.y + x.h), `siblings overlap in ${id} at ${names[i]}`); }
    }
    if (!i) continue;
    const previous = rects(names[i - 1]!);
    let shared = 0, kept = 0;
    for (const [id, rect] of current.rects) { const old = previous.rects.get(id); if (!old) continue; shared++; if (old.x === rect.x && old.y === rect.y) kept++; }
    assert.equal(kept, shared, `${names[i - 1]}→${names[i]}: every surviving entity keeps its place`);
  }
  // Renamed entities inherit their predecessor's slot.
  const before = rects('C').rects.get(entityIn('C', row => row.path === 'backend/app/Http/Controllers/AuthController.php' && row.type === 'file').id)!;
  const after = rects('D').rects.get(entityIn('D', row => row.path === 'server/app/Http/Controllers/AuthController.php' && row.type === 'file').id)!;
  assert.deepEqual([after.x, after.y], [before.x, before.y]);
});
test('timeline layout: reserved slots at largest size, aliases inherit slots', () => {
  const tree = (spec: Record<string, string[]>, weights: Record<string, number>) => { const nodes = new Map<string, LayoutNode>(); for (const id of new Set([...Object.keys(spec), ...Object.values(spec).flat()])) nodes.set(id, { id, children: spec[id] ?? [], weight: weights[id], padding: 4 }); return nodes; };
  const registry = emptyRegistry();
  const first = tree({ root: ['a', 'b'] }, { a: 10, b: 400 });
  const second = tree({ root: ['a', 'c'] }, { a: 900, c: 20 });
  extendRegistry(registry, first, 'root');
  registry.alias.c = 'b';
  extendRegistry(registry, second, 'root');
  const layout = timelineLayout(registry, 'root');
  const one = placeOnTimeline(first, 'root', registry, layout).rects, two = placeOnTimeline(second, 'root', registry, layout).rects;
  assert.deepEqual([one.get('a')!.x, one.get('a')!.y], [two.get('a')!.x, two.get('a')!.y], 'a keeps its slot while growing');
  assert.deepEqual([one.get('b')!.x, one.get('b')!.y], [two.get('c')!.x, two.get('c')!.y], 'c inherits b\'s slot');
  assert.ok(one.get('a')!.w < two.get('a')!.w, 'drawn at its size of the moment');
});
test('the time-lapse draws each commit where its comparison with the previous commit does, and names what changed', async () => {
  const ids = ['A', 'B', 'C', 'D'].map(name => snapshots[name]!.id);
  const fresh = new ProjectionService(store, { root: fixture.root, stateDirectory: fixture.state, history: new HistoryAccess(fixture.state).get });
  assert.equal(fresh.evolution(ids).status, 'computing', 'computed in the background');
  const evolution = await fresh.awaitEvolution(ids);
  assert.equal(evolution.status, 'ready');
  if (evolution.status !== 'ready') return;
  assert.deepEqual(evolution.frames.map(frame => frame.snapshot), ids);
  assert.deepEqual(evolution.frames[0]!.changes, [], 'the first commit has nothing to compare with');
  const placed = new Map<number, number[]>();
  const status = ['', 'added', 'modified', 'moved', 'removed'];
  const changedAt = (frame: number) => new Map(evolution.frames[frame]!.changes.map(([node, code]) => [evolution.nodes[node!]!.id, status[code!]]));
  for (const [i, frame] of evolution.frames.entries()) {
    for (const node of frame.drop) placed.delete(node);
    for (const [node, ...placement] of frame.set) placed.set(node!, placement);
    if (!i) continue;
    // Same nodes, same rectangles, same statuses as the settled comparison view of that commit.
    const settled = view(['A', 'B', 'C', 'D'][i]!, ['A', 'B', 'C', 'D'][i - 1]!);
    await fresh.prepare(settled);
    const expected = new Map<string, { rect: Rect; status?: string }>();
    const walk = (id: string) => { for (const item of fresh.children(id, { limit: 500, view: settled }).items) { expected.set(item.id, { rect: item.rect, ...(item.change && item.change.status !== 'unchanged' ? { status: item.change.status } : {}) }); walk(item.id); } };
    const meta = fresh.meta(settled);
    expected.set(meta.root.id, { rect: meta.root.rect });
    walk(meta.root.id);
    const frameNodes = new Map<string, Rect>([...placed].map(([node, entry]): [string, Rect] => [evolution.nodes[node]!.id, { x: entry[1]!, y: entry[2]!, w: entry[3]!, h: entry[4]! }]));
    assert.deepEqual([...frameNodes.keys()].sort(), [...expected.keys()].sort(), `frame ${i}: the nodes of the comparison`);
    for (const [id, rect] of frameNodes) assert.deepEqual(rect, expected.get(id)!.rect, `frame ${i}: ${id} in place`);
    const changes = changedAt(i);
    for (const [id, entry] of expected) if (evolution.nodes.find(node => node.id === id)?.kind === 'entity') assert.equal(changes.get(id), entry.status, `frame ${i}: status of ${id}`);
  }
  const named = (frame: number, name: string) => [...changedAt(frame)].filter(([id]) => evolution.nodes.find(node => node.id === id)!.name === name).map(([, code]) => code);
  assert.ok(named(1, 'Signup').includes('added'));
  assert.deepEqual(named(2, 'GET /users/{id}'), ['removed'], 'a removed endpoint is a ghost for one frame');
  assert.ok(!evolution.frames[3]!.set.some(([node]) => evolution.nodes[node!]!.name === 'GET /users/{id}') && evolution.frames[3]!.drop.some(node => evolution.nodes[node]!.name === 'GET /users/{id}'), '…and gone the frame after');
  // Over HTTP: progress first, then the frames, compressed when the client accepts it.
  const server = createInspectionServer(store, { root: fixture.root, stateDirectory: fixture.state });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const first = await fetch(`${base}/api/history/evolution`);
    assert.equal(first.status, 202);
    assert.equal(((await first.json()) as { status: string }).status, 'computing');
    let response = first;
    for (let attempt = 0; attempt < 200 && response.status === 202; attempt++) { await new Promise(resolve => setTimeout(resolve, 25)); response = await fetch(`${base}/api/history/evolution`, { headers: { 'Accept-Encoding': 'gzip' } }); }
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-encoding'), 'gzip');
    const served = await response.json() as { status: string; frames: unknown[] };
    assert.deepEqual([served.status, served.frames.length], ['ready', 4]);
  } finally { server.close(); }
});

// --- Source -----------------------------------------------------------------------------
test('historical source is read from the snapshot commit and diffs show the change', async () => {
  const login = entityIn('A', row => row.name === 'login' && row.type === 'function').id;
  const atA = await projection.source({ entity: login }, 1024 * 1024, view('A'));
  assert.equal(atA.snapshot?.commitSha, fixture.commits.A);
  assert.equal(atA.changedSinceIndex, false);
  assert.ok(atA.lines.some(line => line.includes('body: email })')));
  const atB = await projection.source({ entity: login }, 1024 * 1024, view('B'));
  assert.ok(atB.lines.some(line => line.includes('const body = email.trim();')));
  await projection.prepare(view('B', 'A'));
  const baseline = await projection.source({ entity: login, side: 'baseline' }, 1024 * 1024, view('B', 'A'));
  assert.equal(baseline.snapshot?.commitSha, fixture.commits.A, 'side=baseline reads the baseline version');
  const diff = await projection.sourceDiff(login, 1024 * 1024, view('B', 'A'));
  assert.deepEqual([diff.added, diff.removed], [2, 1]);
  assert.equal(diff.before?.range?.startLine, diff.after?.range?.startLine);
  assert.ok(diff.hunks[0]!.lines.some(line => line.kind === 'added' && line.text.includes('email.trim()')));
  // A removed endpoint's file is read from the baseline; a moved file diffs across its paths.
  await projection.prepare(view('C', 'B'));
  const moved = entityIn('C', row => row.path === 'frontend/src/components/auth/LoginForm.tsx' && row.type === 'file').id;
  const movedDiff = await projection.sourceDiff(moved, 1024 * 1024, view('C', 'B'));
  assert.deepEqual([movedDiff.before?.path, movedDiff.after?.path, movedDiff.identical], ['frontend/src/components/LoginForm.tsx', 'frontend/src/components/auth/LoginForm.tsx', true]);
  // Blobs are addressed by the snapshot's commit and an indexed path only.
  await assert.rejects(readBlobAt(fixture.root, fixture.commits.A, '../etc/passwd', 1024), /repository-relative/);
  await assert.rejects(readBlobAt(fixture.root, fixture.commits.A, 'frontend/src/services/requests.ts', 10), /maxFileBytes/);
  const content = (await readBlobAt(fixture.root, fixture.commits.A, 'frontend/src/services/requests.ts', 1024 * 1024)).content;
  assert.equal(createHash('sha256').update(content).digest('hex'), (await new CommitSnapshot(history, snapshots.A!, fixture.root).fileByPath('frontend/src/services/requests.ts'))!.metadata.contentHash);
});
test('line diff: minimal hunks, whitespace option, bounded size', () => {
  const before = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
  const after = ['a', 'B', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k'];
  const result = lineDiff(before, after, { context: 1 });
  assert.deepEqual([result.added, result.removed, result.hunks.length], [2, 1, 2]);
  assert.deepEqual(result.hunks[0]!.lines.map(line => `${line.kind[0]}${line.text}`), ['ca', 'rb', 'aB', 'cc']);
  assert.equal(lineDiff(['  x', 'y'], ['\tx', 'y'], { ignoreWhitespace: true }).identical, true);
  assert.equal(lineDiff(Array.from({ length: 5000 }, (_, i) => `a${i}`), Array.from({ length: 5000 }, (_, i) => `b${i}`), { maxEdits: 100 }).tooLarge, true);
  for (let round = 0; round < 200; round++) {
    const random = () => Array.from({ length: Math.floor(Math.random() * 25) }, () => 'xyz'[Math.floor(Math.random() * 3)]!);
    const a = random(), b = random();
    const diff = lineDiff(a, b, { context: 1000 });
    if (diff.identical) { assert.deepEqual(a, b); continue; }
    assert.deepEqual(diff.hunks.flatMap(hunk => hunk.lines.filter(line => line.kind !== 'added').map(line => line.text)), a);
    assert.deepEqual(diff.hunks.flatMap(hunk => hunk.lines.filter(line => line.kind !== 'removed').map(line => line.text)), b);
  }
});
test('entity history lists when an entity appeared, changed and moved', () => {
  const authenticate = entityIn('A', row => row.qualifiedName === 'App\\Services\\AuthService::authenticate').id;
  const result = projection.entityHistory(authenticate, Object.values(fixture.commits));
  assert.deepEqual(result.points.map(point => [point.status, point.sha]), [['introduced', fixture.commits.A], ['modified', fixture.commits.B], ['moved', fixture.commits.D]]);
  assert.equal(result.present, 4);
  const removed = entityIn('B', row => row.name === 'GET /users/{id}').id;
  assert.deepEqual(projection.entityHistory(removed, Object.values(fixture.commits)).points.map(point => point.status), ['introduced', 'removed']);
});

// --- HTTP and timeline ---------------------------------------------------------------------
test('timeline and snapshot routes over HTTP; indexing endpoint is opt-in and guarded', async () => {
  const server = createInspectionServer(store, { root: fixture.root, stateDirectory: fixture.state });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const timeline = await (await fetch(`${base}/api/history`)).json() as { available: boolean; ref: string; entries: { sha: string; snapshot?: { id: string; stale: boolean } }[]; workingTree?: { id: string }; indexing: { enabled: boolean } };
    assert.equal(timeline.available, true);
    assert.equal(timeline.ref, 'main');
    assert.deepEqual(timeline.entries.map(entry => entry.sha), Object.values(fixture.commits));
    assert.ok(timeline.entries.every(entry => entry.snapshot && !entry.snapshot.stale));
    assert.equal(timeline.workingTree?.id, store.currentRun()!.id);
    assert.equal(timeline.indexing.enabled, false);
    const meta = await (await fetch(`${base}/api/projection?snapshot=${snapshots.C!.id}&compareTo=${snapshots.B!.id}`)).json() as { comparison: { summary: { entities: { removed: number } } } };
    assert.ok(meta.comparison.summary.entities.removed > 0);
    const login = entityIn('A', row => row.name === 'login' && row.type === 'function').id;
    const entity = await (await fetch(`${base}/api/entities/${encodeURIComponent(login)}?snapshot=${snapshots.A!.id}`)).json() as { evidence: unknown[]; sourceRange: { startLine: number } };
    assert.ok(entity.evidence.length > 0);
    assert.equal((await fetch(`${base}/api/projection?snapshot=nope`)).status, 404);
    assert.equal((await fetch(`${base}/api/projection?snapshot=${encodeURIComponent('../x y')}`)).status, 400);
    const diff = await (await fetch(`${base}/api/source/diff?entity=${encodeURIComponent(login)}&snapshot=${snapshots.B!.id}&compareTo=${snapshots.A!.id}`)).json() as { added: number };
    assert.equal(diff.added, 2);
    const refused = await fetch(`${base}/api/history/index`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Archipelago-Request': 'index' }, body: JSON.stringify({ sha: fixture.commits.A }) });
    assert.equal(refused.status, 403);
    assert.equal((await fetch(`${base}/api/history/index`, { method: 'PUT' })).status, 405);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
test('on-demand indexing analyzes one timeline commit in a child process', async () => {
  const fresh = await mkdtemp(path.join(tmpdir(), 'atlas-ondemand-'));
  try {
    await import('node:fs/promises').then(fs => fs.copyFile(path.join(fixture.state, 'config.yml'), path.join(fresh, 'config.yml')));
    await indexHistory({ root: fixture.root, stateDirectory: fresh, ref: 'main', commits: [fixture.commits.D], jobs: 1 });
    const access = new HistoryAccess(fresh);
    const service = new HistoryService({ root: fixture.root, stateDirectory: fresh, store, history: access, indexing: true });
    await assert.rejects(service.request('f'.repeat(40)), /not on the timeline/);
    await service.request(fixture.commits.B);
    const deadline = Date.now() + 60_000;
    let timeline = await service.timeline();
    while (Date.now() < deadline && (timeline.indexing.active || timeline.indexing.queued.length)) { await new Promise(resolve => setTimeout(resolve, 200)); timeline = await service.timeline(); }
    assert.deepEqual(timeline.indexing.failed, []);
    assert.ok(timeline.entries.find(entry => entry.sha === fixture.commits.B)?.snapshot, 'B now has a snapshot');
    assert.equal(timeline.entries.find(entry => entry.sha === fixture.commits.A)?.snapshot, undefined);
    access.close();
  } finally { await rm(fresh, { recursive: true, force: true }); }
});
test('pull request markers: provider records, labeled message heuristics', async () => {
  assert.deepEqual(pullRequestFromMessage({ subject: 'Merge pull request #42 from octo/feature', body: 'Add feature', parents: ['a', 'b'] }), { number: 42, headRef: 'octo/feature', title: 'Add feature', source: 'merge-message' });
  assert.equal(pullRequestFromMessage({ subject: 'Merge pull request #42 from octo/feature', body: '', parents: ['a'] }), undefined, 'not a merge');
  assert.deepEqual(pullRequestFromMessage({ subject: 'Faster search (#17)', body: '', parents: ['a'] }), { number: 17, title: 'Faster search', source: 'squash-message' });
  assert.equal(pullRequestFromMessage({ subject: "Merge branch 'master' of github.com:o/r", body: '', parents: ['a', 'b'] }), undefined);
  assert.deepEqual(githubRepository('git@github.com:ojoven/etengabe.eus.git'), { owner: 'ojoven', repo: 'etengabe.eus' });
  assert.deepEqual(githubRepository('https://github.com/o/r'), { owner: 'o', repo: 'r' });
  assert.equal(githubRepository('git@gitlab.com:o/r.git'), undefined);
  execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:octo/fixture.git'], { cwd: fixture.root });
  const requested: string[] = [];
  const records = await fetchGitHubPullRequests(fixture.root, { token: 't', fetcher: async (url, init) => { requested.push(url); assert.equal(init.headers.Authorization, 'Bearer t'); return { ok: true, status: 200, json: async () => [{ number: 3, title: 'Edit login', html_url: 'https://github.com/octo/fixture/pull/3', user: { login: 'dev' }, merged_at: '2026-01-02T10:00:00Z', updated_at: '2026-01-02T10:00:00Z', merge_commit_sha: fixture.commits.B, head: { ref: 'login' } }, { number: 4, title: 'Closed unmerged', html_url: 'x', merged_at: null, updated_at: '2026-01-02T10:00:00Z', merge_commit_sha: null }] }; } });
  assert.equal(requested.length, 1);
  assert.match(requested[0]!, /^https:\/\/api\.github\.com\/repos\/octo\/fixture\/pulls\?state=closed/);
  assert.deepEqual(records.map(record => [record.number, record.mergeCommitSha]), [[3, fixture.commits.B]]);
});
