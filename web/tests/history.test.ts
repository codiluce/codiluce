// Store-level history: the real AtlasStore driven against the real projection
// and history services over a scripted Git history (no browser).
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import path from 'node:path';
import { indexRepository } from '../../src/pipeline/index.js';
import { GraphStore } from '../../src/storage/sqlite.js';
import { ProjectionService } from '../../src/projection/service.js';
import { HISTORY_DATABASE, historyConfig, indexHistory, revisionConfig } from '../../src/history/indexer.js';
import { HistoryAccess, HistoryService } from '../../src/history/service.js';
import { HistoryStore } from '../../src/history/store.js';
import { createHistoryFixture, type HistoryFixture } from '../../tests/history-fixture.js';
import { AtlasStore, predecessor } from '../lib/store';
import { RecordingNavigator, ServiceApi } from './service-api';

let fixture: HistoryFixture, store: GraphStore, projection: ProjectionService, service: HistoryService, history: HistoryStore, access: HistoryAccess;
before(async () => {
  fixture = await createHistoryFixture();
  await indexHistory({ root: fixture.root, stateDirectory: fixture.state, ref: 'main', jobs: 1 });
  store = new GraphStore(':memory:');
  store.save(await indexRepository(fixture.root, { config: (await revisionConfig(await historyConfig(fixture.root, fixture.state), fixture.root)).config }));
  access = new HistoryAccess(fixture.state);
  projection = new ProjectionService(store, { root: fixture.root, stateDirectory: fixture.state, history: access.get });
  service = new HistoryService({ root: fixture.root, stateDirectory: fixture.state, store, history: access });
  history = new HistoryStore(path.join(fixture.state, HISTORY_DATABASE), true);
});
const stores: AtlasStore[] = [];
after(async () => { for (const atlas of stores) atlas.dispose(); history.close(); access.close(); store.close(); await fixture.cleanup(); });
/** Background loads (the overview's change list) settle shortly after a view switch. */
async function until(predicate: () => boolean, timeout = 5000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('condition not reached'); await new Promise(resolve => setTimeout(resolve, 10)); }
}

const snapshotOf = (commit: keyof HistoryFixture['commits']) => history.snapshotsByCommit().get(fixture.commits[commit])!;
const entityAt = (commit: keyof HistoryFixture['commits'], predicate: (row: ReturnType<HistoryStore['entities']>[number]) => boolean) => history.entities(snapshotOf(commit).seq).find(predicate)!.id;
async function ready(hash = '') {
  const location = { hash, replace(next: string) { this.hash = next; } };
  const api = new ServiceApi(store, projection, { history: service });
  const atlas = new AtlasStore(api, { location });
  atlas.navigator = new RecordingNavigator();
  stores.push(atlas);
  await atlas.init();
  return { atlas, api, location };
}

test('opening history compares the live index with its HEAD commit on the timeline layout', async () => {
  const { atlas, location } = await ready();
  assert.equal(atlas.getState().meta?.history.available, true);
  await atlas.openTimeline();
  const { timeline, meta } = atlas.getState();
  assert.equal(timeline.status, 'ready');
  assert.equal(timeline.data?.entries.length, 4);
  assert.equal(timeline.target, undefined, 'the live index is the default target');
  assert.equal(timeline.baseline, snapshotOf('D').id, 'compared with HEAD');
  assert.equal(meta?.snapshot.kind, 'working_tree');
  assert.equal(meta?.layout.source, 'timeline');
  assert.deepEqual(meta?.comparison?.summary.entities, { added: 0, removed: 0, modified: 0, moved: 0 }, 'the clean working tree equals HEAD');
  assert.match(location.hash, new RegExp(`at=live&vs=${fixture.commits.D.slice(0, 12)}`));
  await atlas.closeTimeline();
  assert.equal(atlas.getState().meta?.layout.source, 'persisted', 'closing returns to the live map');
  assert.equal(location.hash, '#');
});
test('stepping through commits swaps the scene, follows the baseline and carries the selection through renames', async () => {
  const { atlas } = await ready();
  await atlas.openTimeline();
  await atlas.setTarget(snapshotOf('C').id);
  let state = atlas.getState();
  assert.equal(state.timeline.baseline, snapshotOf('B').id, 'baseline follows the previous commit');
  assert.equal(state.meta?.snapshot.commitSha, fixture.commits.C);
  await until(() => atlas.getState().timeline.changes.status === 'ready');
  state = atlas.getState();
  assert.ok(state.timeline.changes.items.some(item => item.name === 'GET /users/{id}' && item.change?.status === 'removed'), 'overview lists the removed endpoint');
  const ghost = state.timeline.changes.items.find(item => item.name === 'GET /users/{id}')!;
  await atlas.select(ghost.id);
  state = atlas.getState();
  assert.equal(state.selection?.change?.status, 'ready');
  assert.equal(state.selection?.change?.data?.change.status, 'removed');
  assert.equal(state.selection?.entity?.name, 'GET /users/{id}', 'a ghost reads its facts from the baseline');
  // The moved LoginForm component: selected at C, still selected at B under its older identity.
  const atC = entityAt('C', row => row.name === 'LoginForm' && row.type === 'component'), atB = entityAt('B', row => row.name === 'LoginForm' && row.type === 'component');
  await atlas.select(atC);
  assert.equal(atlas.getState().selection?.change?.data?.change.lineage, 'qualified-name');
  await atlas.stepTarget(-1);
  state = atlas.getState();
  assert.equal(state.timeline.target, snapshotOf('B').id);
  assert.equal(state.selection?.id, atB, 'selection followed lineage backwards');
  assert.equal(state.timeline.notice, undefined);
  // The scene is the new view's: every node's rect is from the B view.
  assert.equal(atlas.scene.nodes.get(state.meta!.root.id)?.rect.w, state.meta!.root.rect.w);
});
test('a pinned baseline stays while the target moves; source diffs and entity history load', async () => {
  const { atlas } = await ready();
  await atlas.openTimeline();
  await atlas.setTarget(snapshotOf('B').id);
  await atlas.setBaseline(snapshotOf('A').id);
  assert.equal(atlas.getState().timeline.pinned, true);
  await atlas.stepTarget(1);
  await atlas.stepTarget(1);
  let state = atlas.getState();
  assert.deepEqual([state.timeline.target, state.timeline.baseline], [snapshotOf('D').id, snapshotOf('A').id], 'A → D across three commits');
  assert.ok(state.meta!.comparison!.summary.entities.moved > 0);
  await atlas.setPinned(false);
  assert.equal(atlas.getState().timeline.baseline, snapshotOf('C').id, 'unpinning returns to the previous commit');
  await atlas.setTarget(snapshotOf('B').id);
  const login = entityAt('B', row => row.name === 'login' && row.type === 'function');
  await atlas.select(login);
  await atlas.openDiff(login, 'login');
  state = atlas.getState();
  assert.equal(state.diff?.status, 'ready');
  assert.deepEqual([state.diff?.data?.added, state.diff?.data?.removed], [2, 1]);
  assert.equal(state.selection?.timeline?.status, 'ready');
  assert.deepEqual(state.selection?.timeline?.data?.points.map(point => point.status), ['introduced', 'modified', 'removed'], 'the TypeScript identity ends where the file moved');
  atlas.setDiffLayout('split');
  assert.equal(atlas.getState().diff?.layout, 'split');
});
test('deep links open the named commits (pinned when not adjacent) and the selection', async () => {
  const hash = `#id=${encodeURIComponent(entityAt('C', row => row.name === 'Signup'))}&at=${fixture.commits.C.slice(0, 12)}&vs=${fixture.commits.A.slice(0, 12)}`;
  const { atlas } = await ready(hash);
  const state = atlas.getState();
  assert.deepEqual([state.timeline.open, state.timeline.target, state.timeline.baseline, state.timeline.pinned], [true, snapshotOf('C').id, snapshotOf('A').id, true]);
  assert.equal(state.selection?.node?.change?.status, 'added', 'Signup was added between A and C');
  assert.equal(predecessor(state.timeline.data, snapshotOf('C').id), snapshotOf('B').id);
});
test('rapid scrubbing keeps only the last view', async () => {
  const { atlas, api } = await ready();
  await atlas.openTimeline();
  api.delays.set('', 30);
  const pending = [atlas.setTarget(snapshotOf('A').id), atlas.setTarget(snapshotOf('B').id), atlas.setTarget(snapshotOf('C').id)];
  await Promise.all(pending);
  const state = atlas.getState();
  assert.equal(state.timeline.switching, false);
  assert.equal(state.meta?.snapshot.commitSha, fixture.commits.C);
  assert.equal(atlas.scene.rootId, state.meta?.root.id);
  for (const node of atlas.scene.nodes.values()) assert.ok(node.change === undefined || state.meta?.comparison, 'no nodes from an older view');
});
test('the time-lapse shows commits at once while scrubbing and playing, then settles on the real view', async () => {
  const { atlas, api } = await ready();
  await atlas.openTimeline();
  await until(() => atlas.getState().timeline.evolution.status === 'ready');
  assert.equal(atlas.evolution?.length, 4);
  // Scrubbing puts the frame on screen without asking the server for a view.
  const before = api.calls.length;
  assert.equal(atlas.scrubTo(snapshotOf('B').id), true);
  assert.deepEqual([atlas.getState().timeline.preview, atlas.previewScene?.frame], [1, 1]);
  assert.ok(!api.calls.slice(before).some(call => call.startsWith('meta') || call.startsWith('children')), 'no view requests while scrubbing');
  assert.ok([...atlas.previewScene!.nodes.values()].some(node => node.name === 'Signup' && node.change?.status === 'added'));
  const framed = new Map([...atlas.previewScene!.nodes].map(([id, node]) => [id, node.rect]));
  // Releasing settles on that commit: the real scene replaces the frame, every block where it was.
  await atlas.settle();
  let state = atlas.getState();
  assert.deepEqual([state.timeline.preview, atlas.previewScene, state.timeline.target], [undefined, undefined, snapshotOf('B').id]);
  for (const [id, node] of atlas.scene.nodes) assert.deepEqual(node.rect, framed.get(id), `${id} did not move`);
  // Playing advances by elapsed time and settles on the last commit.
  atlas.scrubTo(snapshotOf('A').id);
  await atlas.play();
  assert.deepEqual([atlas.getState().timeline.playing, atlas.getState().timeline.preview], [true, 0]);
  atlas.advancePlayback(1000 / atlas.playbackRate() + 1);
  assert.equal(atlas.getState().timeline.preview, 1);
  atlas.advancePlayback(60_000);
  await until(() => atlas.getState().timeline.preview === undefined && atlas.getState().meta?.snapshot.commitSha === fixture.commits.D);
  state = atlas.getState();
  assert.equal(state.timeline.playing, false);
  assert.equal(state.timeline.target, snapshotOf('D').id);
});
