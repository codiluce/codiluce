import assert from 'node:assert/strict';
import { test } from 'node:test';
import { flowStorageKey, localFlowPersistence, moveItem, removeAt, resolveSteps, upsertFlow, validateFlowName, type StoredFlow } from '../lib/flows';
import { initialPlayback, nextPlayable, playback, type PlaybackState } from '../lib/playback';
import { highlightLines, splitHighlighted } from '../lib/highlight';

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return { getItem: key => data.get(key) ?? null, setItem: (key, value) => void data.set(key, value), removeItem: key => void data.delete(key), clear: () => data.clear(), key: index => [...data.keys()][index] ?? null, get length() { return data.size; } };
}
let counter = 0;
const newId = () => `flow-${++counter}`;

test('flows persist ordered entity IDs only, scoped to the repository identity', () => {
  const storage = memoryStorage();
  const repoA = localFlowPersistence(storage, 'repository:a'), repoB = localFlowPersistence(storage, 'repository:b');
  const flows = upsertFlow([], { name: 'Login', entityIds: ['symbol:1', 'endpoint:2', 'symbol:3'] }, '2026-10-01T00:00:00Z', newId);
  // Even if a caller sneaks graph objects onto a step, only the ID is written.
  (flows[0]!.steps[0] as unknown as Record<string, unknown>).copiedEntity = { name: 'login', metadata: { huge: true } };
  repoA.save(flows);
  const raw = JSON.parse(storage.getItem(flowStorageKey('repository:a'))!);
  assert.deepEqual(raw[0].steps, [{ entityId: 'symbol:1' }, { entityId: 'endpoint:2' }, { entityId: 'symbol:3' }]);
  assert.equal(raw[0].type, 'declared');
  assert.deepEqual(repoA.load().map(flow => flow.name), ['Login']);
  assert.deepEqual(repoB.load(), [], 'another repository sees nothing');
  storage.setItem(flowStorageKey('repository:b'), '{not json');
  assert.deepEqual(repoB.load(), [], 'malformed storage is ignored');
  storage.setItem(flowStorageKey('repository:b'), JSON.stringify([{ id: 'x', name: 'bad', type: 'observed', steps: [] }, { id: 'y', name: 'ok', type: 'declared', steps: [{ entityId: 'e' }] }]));
  assert.deepEqual(repoB.load().map(flow => flow.id), ['y'], 'only declared flows with valid steps load');
  assert.throws(() => localFlowPersistence(undefined, 'r').save(flows), /unavailable/);
});
test('flow editing keeps order, validates names and updates in place', () => {
  assert.deepEqual(moveItem(['a', 'b', 'c'], 0, 2), ['b', 'c', 'a']);
  assert.deepEqual(moveItem(['a', 'b', 'c'], 2, 0), ['c', 'a', 'b']);
  assert.deepEqual(moveItem(['a', 'b'], 0, 5), ['a', 'b']);
  assert.deepEqual(removeAt(['a', 'b', 'c'], 1), ['a', 'c']);
  let flows: StoredFlow[] = upsertFlow([], { name: 'First', entityIds: ['a', 'b'] }, 't0', newId);
  assert.equal(validateFlowName('  ', flows), 'Give the flow a name');
  assert.equal(validateFlowName('first', flows), 'A flow with this name already exists');
  assert.equal(validateFlowName('first', flows, flows[0]!.id), undefined, 'renaming itself is fine');
  flows = upsertFlow(flows, { id: flows[0]!.id, name: 'First (edited)', entityIds: ['b', 'a', 'c'] }, 't1', newId);
  assert.equal(flows.length, 1);
  assert.deepEqual(flows[0]!.steps.map(step => step.entityId), ['b', 'a', 'c']);
  assert.equal(flows[0]!.updatedAt, 't1');
  assert.throws(() => upsertFlow(flows, { name: 'Empty', entityIds: [] }, 't2', newId), /at least one step/);
});
test('steps missing after reindexing are marked and skipped by playback', () => {
  const resolved = resolveSteps({ steps: [{ entityId: 'a' }, { entityId: 'gone' }, { entityId: 'c' }] }, new Set(['a', 'c']));
  assert.deepEqual(resolved.map(step => step.missing), [false, true, false]);
  let state = initialPlayback(resolved.map(step => step.missing));
  assert.deepEqual(state.playable, [0, 2]);
  state = playback(state, { type: 'play' });
  state = playback(state, { type: 'tick', elapsedMs: 1000, stepMs: 1000 });
  assert.equal(state.index, 2, 'missing step 1 skipped');
});
test('playback plays, pauses, advances with time, finishes, restarts and seeks', () => {
  let state: PlaybackState = initialPlayback([false, false, false]);
  assert.equal(state.status, 'idle');
  state = playback(state, { type: 'tick', elapsedMs: 5000, stepMs: 1000 });
  assert.equal(state.index, 0, 'idle playback ignores time');
  state = playback(state, { type: 'play' });
  state = playback(state, { type: 'tick', elapsedMs: 400, stepMs: 1000 });
  assert.deepEqual([state.index, state.progress], [0, 0.4]);
  assert.equal(nextPlayable(state), 1);
  state = playback(state, { type: 'pause' });
  assert.equal(playback(state, { type: 'tick', elapsedMs: 5000, stepMs: 1000 }), state, 'paused playback does not move');
  state = playback(playback(state, { type: 'play' }), { type: 'tick', elapsedMs: 1700, stepMs: 1000 });
  assert.equal(state.index, 2);
  state = playback(state, { type: 'tick', elapsedMs: 1000, stepMs: 1000 });
  assert.equal(state.status, 'finished');
  assert.equal(state.index, 2);
  state = playback(state, { type: 'play' });
  assert.deepEqual([state.status, state.index], ['playing', 0], 'play after finishing replays from the start');
  state = playback(state, { type: 'next' });
  state = playback(state, { type: 'previous' });
  assert.equal(state.index, 0);
  state = playback(state, { type: 'seek', index: 2 });
  assert.equal(state.index, 2);
  state = playback(state, { type: 'restart' });
  assert.deepEqual([state.status, state.index, state.progress], ['playing', 0, 0]);
  assert.equal(playback(initialPlayback([true, true]), { type: 'play' }).status, 'idle', 'nothing playable');
});
test('syntax highlighting escapes HTML and keeps one balanced fragment per source line', () => {
  const lines = ['/* a comment that', '   spans lines <b>not html</b> */', 'const x = "<script>";'];
  const html = highlightLines(lines, 'typescript');
  assert.equal(html.length, 3);
  for (const line of html) {
    assert.equal((line.match(/<span/g) ?? []).length, (line.match(/<\/span>/g) ?? []).length, line);
    assert.ok(!line.includes('<b>') && !line.includes('<script>'));
  }
  assert.ok(html[1]!.includes('hljs-comment'), 'multi-line comment continues on the next line');
  assert.deepEqual(splitHighlighted('<span class="a">x\ny</span>'), ['<span class="a">x</span>', '<span class="a">y</span>']);
  assert.deepEqual(highlightLines(['<?php echo 1;'], 'unknown-language'), ['&lt;?php echo 1;']);
});
