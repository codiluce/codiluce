import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ActivityEvent, AgentSession } from '@engine/activity/model';
import type { NodeSummary } from '@engine/projection/dto';
import { changeLine, planBeat } from '../lib/beat';
import { project, projectedBounds, setFlat, worldToScreen } from '../lib/camera';
import { Cast, crewEvent, REPLAY_MS, sessionReplay, YARD, yardFor } from '../lib/crew';
import { focusLayout, morph, sceneHierarchy } from '../lib/focus-layout';
import { mergeArrows, selectionSet } from '../lib/focus-set';
import { placeLabels, overlaps, type LabelAsk } from '../lib/labels';
import { projector, TILE } from '../lib/plan';
import { Scene } from '../lib/scene';
import { AtlasStore, DEFAULT_VIEWS } from '../lib/store';
import { DEFAULT_LOD as DEFAULT_LOD_FOR_TEST } from '../lib/lod';
import type { AtlasApi } from '../lib/api';

const close = (a: number, b: number, epsilon = 1e-6) => assert.ok(Math.abs(a - b) < epsilon, `${a} ≉ ${b}`);
const stats = { files: 1, symbols: 0, endpoints: 0, measuredLoc: 0, unmeasuredFiles: 0, descendants: 0 };
function node(id: string, type: string, parent: string | undefined, rect: NodeSummary['rect'], extra: Partial<NodeSummary> = {}): NodeSummary {
  return { id, kind: 'entity', type, name: id.split('/').pop()!, path: id, depth: 0, rect, childCount: 0, diagnostics: 0, stats, ...(parent ? { spatialParentId: parent } : {}), ...extra };
}
/** repo / src / (a / deep / x.ts, b.ts, c.ts, d.ts) and repo / web / y.ts. */
function scene(changes: Record<string, 'added' | 'modified' | 'removed'> = {}): Scene {
  const all = [
    node('repo', 'repository', undefined, { x: 0, y: 0, w: 1000, h: 800 }, { childCount: 2 }),
    node('src', 'directory', 'repo', { x: 20, y: 20, w: 500, h: 700 }, { childCount: 4 }),
    node('web', 'directory', 'repo', { x: 560, y: 20, w: 400, h: 400 }, { childCount: 1 }),
    node('src/a', 'directory', 'src', { x: 40, y: 40, w: 200, h: 200 }, { childCount: 1 }),
    node('src/a/deep', 'directory', 'src/a', { x: 50, y: 50, w: 120, h: 120 }, { childCount: 1 }),
    node('src/a/deep/x.ts', 'file', 'src/a/deep', { x: 60, y: 60, w: 30, h: 30 }),
    node('src/b.ts', 'file', 'src', { x: 260, y: 40, w: 90, h: 90 }),
    node('src/c.ts', 'file', 'src', { x: 260, y: 160, w: 60, h: 60 }),
    node('src/d.ts', 'file', 'src', { x: 360, y: 160, w: 60, h: 60 }),
    node('web/y.ts', 'file', 'web', { x: 600, y: 60, w: 100, h: 100 }),
  ].map(item => (changes[item.id] ? { ...item, change: { status: changes[item.id]!, facets: [] } } : item));
  const result = new Scene();
  result.reset(all[0]!);
  for (const parent of ['repo', 'src', 'web', 'src/a', 'src/a/deep']) {
    const kids = all.filter(item => item.spatialParentId === parent);
    result.addChildren(parent, kids, kids.length, false);
  }
  return result;
}

test('the plan projection turns the isometric view into a view from above', () => {
  setFlat(false);
  const iso = projector(0), plan = projector(1);
  for (const [x, y, z] of [[0, 0, 0], [120, 40, 0], [-30, 250, 12]] as const) {
    const expected = project(x, y, z), got = iso(x, y, z);
    close(got.x, expected.x); close(got.y, expected.y);
    // From above, x and y are the ground's and heights do not show.
    const top = plan(x, y, z);
    close(top.x, x); close(top.y, y);
  }
});

test('the focus layout keeps the set and its areas, folds the rest into +N tiles and merges single-child chains', () => {
  const hierarchy = sceneHierarchy(scene())!;
  const focus = focusLayout(hierarchy, ['src/a/deep/x.ts', 'web/y.ts', 'src/b.ts'])!;
  const ids = new Set(focus.nodes.map(item => item.id));
  for (const id of ['repo', 'src', 'web', 'src/a', 'src/a/deep/x.ts', 'web/y.ts', 'src/b.ts']) assert.ok(ids.has(id), id);
  // a/deep is one area named after both.
  assert.ok(!ids.has('src/a/deep'));
  assert.equal(focus.nodes.find(item => item.id === 'src/a')!.name, 'a/deep');
  assert.deepEqual(focus.merged.get('src/a'), ['src/a/deep']);
  // c.ts and d.ts are folded into one tile of src/.
  assert.equal(focus.tiles.get(`${TILE}src`), 2);
  assert.ok(!ids.has('src/c.ts'));
  // Everything sits inside its parent.
  for (const item of focus.nodes) {
    const parent = item.spatialParentId ? focus.rects.get(item.spatialParentId) : undefined;
    if (!parent) continue;
    const r = focus.rects.get(item.id)!;
    assert.ok(r.x >= parent.x - 1e-6 && r.y >= parent.y - 1e-6 && r.x + r.w <= parent.x + parent.w + 1e-6 && r.y + r.h <= parent.y + parent.h + 1e-6, item.id);
  }
  assert.equal(focusLayout(hierarchy, ['missing']), undefined);
  // Halfway, shared blocks slide between their two places.
  const from = { nodes: [hierarchy.node('repo')!, hierarchy.node('web/y.ts')!], alpha: new Map<string, number>() };
  const half = morph(from, { nodes: focus.nodes, alpha: new Map() }, 0.5).nodes.find(item => item.id === 'web/y.ts')!;
  const start = hierarchy.node('web/y.ts')!.rect, end = focus.rects.get('web/y.ts')!;
  assert.ok(half.rect.x !== start.x || start.x === end.x);
});

test('a selection set lists what it is connected to, the most connected first, with arrows by pair and type', () => {
  const own = node('src/b.ts', 'file', 'src', { x: 0, y: 0, w: 10, h: 10 });
  const other = (id: string) => node(id, 'file', 'src', { x: 0, y: 0, w: 10, h: 10 });
  const set = selectionSet(own, ['repo', 'src'], [
    { id: '1', type: 'calls', direction: 'outgoing', other: other('src/c.ts'), otherAncestors: ['repo', 'src'] },
    { id: '2', type: 'calls', direction: 'outgoing', other: other('src/c.ts'), otherAncestors: ['repo', 'src'] },
    { id: '3', type: 'imports', direction: 'incoming', other: other('web/y.ts'), otherAncestors: ['repo', 'web'] },
  ]);
  assert.deepEqual(set.ids, ['src/b.ts', 'src/c.ts', 'web/y.ts']);
  assert.deepEqual(set.arrows.map(arrow => [arrow.from, arrow.to, arrow.types]), [['src/b.ts', 'src/c.ts', { calls: 2 }], ['web/y.ts', 'src/b.ts', { imports: 1 }]]);
  assert.deepEqual(new Set(set.areas), new Set(['repo', 'src', 'web']));
  assert.deepEqual(mergeArrows([{ from: 'a', to: 'a', type: 'calls' }]), []);
});

test('a commit beat lands removals, then additions, then changes, and says what it does in one line', () => {
  const plan = planBeat(scene({ 'src/b.ts': 'modified', 'src/c.ts': 'added', 'web/y.ts': 'removed', 'src/d.ts': 'modified' }), { t0: 1000, lines: new Map([['src/d.ts', { added: 40, removed: 2 }], ['src/b.ts', { added: 1, removed: 1 }]]) });
  assert.deepEqual(plan.files.map(file => [file.id, file.status]), [['web/y.ts', 'removed'], ['src/c.ts', 'added'], ['src/d.ts', 'modified'], ['src/b.ts', 'modified']]);
  assert.ok(plan.files.every((file, i) => i === 0 || file.at > plan.files[i - 1]!.at));
  assert.equal(plan.files[0]!.at, 1000);
  assert.deepEqual(plan.counts, { added: 1, modified: 2, removed: 1, moved: 0 });
  assert.ok(plan.end > plan.files.at(-1)!.at);
  assert.equal(changeLine(plan), 'adds c.ts; removes y.ts; changes d.ts (+40 −2) and 1 more file');
});

const sessions: AgentSession[] = [{ actor: 'claude-code:s1', provider: 'claude-code', sessionId: 's1', status: 'running', lastSeen: 0, label: 'PreToolUse', title: 'Fix the map' }];
function event(id: string, at: number, extra: Partial<ActivityEvent>): ActivityEvent {
  return { id, at, provider: 'claude-code', actor: 'claude-code:s1', sessionId: 's1', kind: 'status', phase: 'status', label: 'Stop', paths: [], ...extra };
}
test('observations become what the characters do: a prompt is thinking, a plan tool planning, a web tool the web', () => {
  assert.equal(crewEvent(event('1', 0, { label: 'UserPromptSubmit', status: 'running' }), 0, sessions)?.kind, 'think');
  assert.equal(crewEvent(event('2', 0, { kind: 'command', phase: 'started', label: 'TodoWrite', tool: 'TodoWrite' }), 0, sessions)?.kind, 'plan');
  assert.equal(crewEvent(event('3', 0, { kind: 'command', phase: 'started', label: 'WebSearch', tool: 'WebSearch' }), 0, sessions)?.kind, 'web');
  assert.equal(crewEvent(event('4', 0, { kind: 'command', phase: 'started', label: 'Bash', tool: 'Bash', status: 'waiting' }), 0, sessions)?.status, 'waiting');
  // A read whose file is not on the map shows nothing.
  assert.equal(crewEvent(event('5', 0, { kind: 'read', phase: 'started', label: 'Read file', paths: [{ path: 'outside.txt', scope: 'file' }] }), 0, sessions), undefined);
  const read = crewEvent(event('6', 0, { kind: 'read', phase: 'started', label: 'Read file', paths: [{ path: 'src/b.ts', scope: 'file', id: 'src/b.ts', ancestors: ['repo', 'src'] }] }), 10, sessions)!;
  assert.deepEqual([read.kind, read.targets, read.title, read.t], ['read', ['src/b.ts'], 'Fix the map', 10]);
});

test('a saved session replays as the cast: prompts think, calls hop to their files, and the turn ends writing the reply', () => {
  const at = (s: number) => new Date(Date.UTC(2026, 9, 17, 10, 0, s)).toISOString();
  const file = (path: string, action: 'read' | 'edited' = 'read') => ({ path, scope: 'file' as const, action, id: path, ancestors: ['repo'] });
  const played = sessionReplay({ id: 'claude-code:s1', provider: 'claude-code', sessionId: 's1', title: 'Fix the map', truncated: false, steps: [
    { role: 'user', at: at(0), paths: [] },
    { role: 'assistant', at: at(2), paths: [] },
    { role: 'tool', at: at(3), tool: 'Read', callId: 'a', status: 'completed', paths: [file('src/b.ts')] },
    { role: 'tool', at: at(3), tool: 'Read', callId: 'b', status: 'completed', paths: [file('src/c.ts')] },
    { role: 'tool', at: at(9), tool: 'Edit', callId: 'c', status: 'failed', paths: [file('src/c.ts', 'edited')] },
    { role: 'tool', at: at(12), tool: 'Bash', callId: 'd', status: 'completed', paths: [] },
    { role: 'assistant', at: at(20), paths: [] },
  ] }, 1000);
  // The note between tool calls is not a reply; the last message is.
  assert.deepEqual(played.filter(ev => ev.phase !== 'completed' && ev.phase !== 'failed').map(ev => ev.kind), ['think', 'read', 'read', 'edit', 'command', 'reply', 'status']);
  assert.ok(played.every((ev, i) => i === 0 || ev.t >= played[i - 1]!.t));
  // Calls made together stay open together (the character splits), until the next step.
  const [b, c] = played.filter(ev => ev.kind === 'read' && ev.phase === 'started');
  const bEnd = played.find(ev => ev.id === `${b!.id}:end`)!, editStart = played.find(ev => ev.kind === 'edit' && ev.phase === 'started')!;
  assert.ok(c!.t < bEnd.t && bEnd.t < editStart.t);
  assert.equal(played.find(ev => ev.id === `${editStart.id}:end`)!.phase, 'failed');
  assert.equal(played.at(-1)!.status, 'finished');
  // A long session plays at most REPLAY_MS.
  const long = sessionReplay({ id: 'codex:x', provider: 'codex', sessionId: 'x', title: '', truncated: false, steps: Array.from({ length: 2000 }, (_, i) => ({ role: 'tool' as const, at: at(i * 30), tool: 'Read', callId: String(i), paths: [file('src/b.ts')] })) }, 0);
  assert.ok(long.at(-1)!.t <= REPLAY_MS + 2000, String(long.at(-1)!.t));
});

test('files worked on at the same time split the character: a copy goes to each, and comes back when its call ends', () => {
  const map = scene();
  const root = map.nodes.get('repo')!.rect;
  const cast = new Cast(id => map.nodes.get(id)?.rect, () => root, () => 'red', false);
  const read = (id: string, t: number, tool: string, path: string) => crewEvent(event(id, t, { kind: 'read', phase: 'started', label: 'Read file', toolId: tool, status: 'running', paths: [{ path, scope: 'file', id: path }] }), t, sessions)!;
  const done = (id: string, t: number, tool: string) => crewEvent(event(id, t, { kind: 'read', phase: 'completed', label: 'Read file', toolId: tool, status: 'running' }), t, sessions)!;
  cast.push([read('1', 100, 'a', 'src/b.ts'), read('2', 120, 'b', 'src/c.ts'), read('3', 140, 'c', 'web/y.ts'), done('4', 400, 'b')]);
  cast.advance(150);
  const actor = cast.actors.get('claude-code:s1')!;
  assert.equal(actor.target, 'src/b.ts', 'the character stays on its first file');
  assert.deepEqual(actor.clones.map(clone => clone.target), ['src/c.ts', 'web/y.ts']);
  cast.advance(500);
  // The copy on c.ts ended (after a short dwell, so it is seen); the one on y.ts still works.
  assert.ok(actor.clones.find(clone => clone.target === 'src/c.ts')!.end! >= 120 + 1000);
  assert.equal(actor.clones.find(clone => clone.target === 'web/y.ts')!.end, undefined);
  // One call after the other is a hop, not a split.
  cast.push([done('5', 600, 'a'), done('6', 600, 'c'), read('7', 700, 'd', 'src/d.ts')]);
  cast.advance(700);
  assert.equal(actor.target, 'src/d.ts');
});

test('a harness that reports only completed calls still sends its character to the file', () => {
  const map = scene();
  const root = map.nodes.get('repo')!.rect;
  const cast = new Cast(id => map.nodes.get(id)?.rect, () => root, () => 'red', false);
  const completed = (id: string, t: number, tool: string, path: string) => crewEvent(event(id, t, { kind: 'read', phase: 'completed', label: 'Read file', toolId: tool, status: 'running', paths: [{ path, scope: 'file', id: path }] }), t, sessions)!;
  cast.push([completed('1', 100, 'a', 'src/b.ts'), completed('2', 900, 'b', 'web/y.ts')]);
  cast.advance(150);
  const actor = cast.actors.get('claude-code:s1')!;
  assert.deepEqual([actor.target, actor.pose], ['src/b.ts', 'read']);
  cast.advance(950);
  assert.equal(actor.target, 'web/y.ts');
  assert.equal(actor.clones.length, 0, 'calls reported one after the other do not split it');
});

test('the cast hops to the files it reads and steps outside, beside the nearest edge, for what is about no file', () => {
  const map = scene();
  const root = map.nodes.get('repo')!.rect;
  const cast = new Cast(id => map.nodes.get(id)?.rect, () => root, () => 'red', false);
  const sessionsNow = sessions;
  const at = (id: string, t: number, extra: Partial<ActivityEvent>) => crewEvent(event(id, t, extra), t, sessionsNow)!;
  cast.push([
    at('1', 100, { kind: 'read', phase: 'started', label: 'Read file', toolId: 'r', paths: [{ path: 'web/y.ts', scope: 'file', id: 'web/y.ts' }] }),
    at('2', 200, { kind: 'read', phase: 'completed', label: 'Read file', toolId: 'r', paths: [] }),
    at('3', 300, { label: 'UserPromptSubmit', status: 'running' }),
    at('4', 400, { kind: 'command', phase: 'started', label: 'Run command', toolId: 'c' }),
    at('5', 2000, { status: 'finished', label: 'SessionEnd' }),
  ]);
  cast.advance(150);
  const actor = cast.actors.get('claude-code:s1')!;
  assert.equal(actor.target, 'web/y.ts');
  assert.equal(actor.pose, 'read');
  cast.advance(350);
  assert.equal(actor.target, `${YARD}claude-code:s1`);
  assert.equal(actor.pose, 'think');
  // web/y.ts is nearest the top edge: the mat is above the map.
  const yard = cast.yards.get(actor.target!)!;
  assert.deepEqual(yard, yardFor(root, map.nodes.get('web/y.ts')!.rect, actor.slot));
  assert.ok(yard.y < root.y);
  cast.advance(500);
  assert.equal(actor.pose, 'command');
  cast.advance(2100);
  assert.equal(actor.pose, 'wave');
  cast.advance(10_000);
  assert.equal(cast.actors.size, 0);
});

test('an agent with no observed file starts outside and appears when the map finishes loading', () => {
  const map = scene();
  let root: NodeSummary['rect'] | undefined;
  const cast = new Cast(id => map.nodes.get(id)?.rect, () => root, () => 'red', true);
  cast.push([crewEvent(event('command', 100, { kind: 'command', phase: 'started', toolId: 'c', status: 'running' }), 100, sessions)!]);
  cast.advance(100);
  const actor = cast.actors.get('claude-code:s1')!;
  assert.equal(actor.target, undefined);
  root = map.nodes.get('repo')!.rect;
  cast.advance(200);
  assert.equal(actor.target, `${YARD}claude-code:s1`);
  const mat = cast.rectOf(actor.target!)!;
  assert.ok(mat.x > root.x + root.w || mat.x + mat.w < root.x || mat.y > root.y + root.h || mat.y + mat.h < root.y);
  assert.equal(actor.lastFile, undefined, 'no file activity is invented');
  assert.equal(actor.pose, 'command');
  cast.push([crewEvent(event('read', 300, { kind: 'read', phase: 'started', paths: [{ path: 'src/b.ts', scope: 'file', id: 'src/b.ts' }] }), 300, sessions)!]);
  cast.advance(300);
  assert.deepEqual([actor.target, actor.pose, actor.lastFile], ['src/b.ts', 'read', 'src/b.ts']);
});

test('the map projection is a saved preference, 3D by default, and every map draws in it', async () => {
  // Preferences and the middle need no API calls.
  const api = {} as AtlasApi;
  const saved = new Map<string, string>();
  const storage = { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => void saved.set(key, value) };
  const store = new AtlasStore(api, { storage });
  assert.deepEqual(store.getState().views, DEFAULT_VIEWS);
  assert.equal(DEFAULT_VIEWS.map, 'iso');
  close(project(10, 0).y, 5);
  store.setViews({ map: 'plan', focus: 'gather', labels: 'numbered' });
  // In plan, the projection is the ground seen from above: elevation does not show.
  assert.deepEqual(project(10, 20, 5), { x: 10, y: 20 });
  assert.deepEqual(projectedBounds({ x: 1, y: 2, w: 3, h: 4 }, 0, 9), { minX: 1, minY: 2, maxX: 4, maxY: 6 });
  const again = new AtlasStore(api, { storage });
  assert.deepEqual(again.getState().views, { map: 'plan', focus: 'gather', labels: 'numbered' });
  // Unknown values fall back to the defaults.
  saved.set('codiluce:prefs', JSON.stringify({ views: { map: 'lift', focus: 'gather' } }));
  assert.deepEqual(new AtlasStore(api, { storage }).getState().views, { ...DEFAULT_VIEWS, focus: 'gather' });
  // The tools open in the middle and give it back to the map when closed.
  store.openFocus({ kind: 'selection', id: 'x', title: 'x' });
  assert.equal(store.getState().center, 'focus');
  store.setCenter('map'); store.setCenter('focus');
  assert.equal(store.getState().center, 'focus');
  store.closeFocus();
  assert.equal(store.getState().center, 'map');
  setFlat(false);
});

test('agents are on the map by default, beside Agents too, and being turned off is remembered', () => {
  const saved = new Map<string, string>();
  const storage = { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => void saved.set(key, value) };
  const store = new AtlasStore({} as AtlasApi, { storage });
  assert.deepEqual([store.getState().center, store.getState().agents.show], ['map', true]);
  store.openJournal('conversations');
  store.showAgents();
  assert.deepEqual([store.getState().center, store.getState().agents.show], ['map', true]);
  store.showAgentsOnMap(false);
  const again = new AtlasStore({} as AtlasApi, { storage });
  assert.equal(again.getState().agents.show, false);
  // Replaying a session shows them again, with the map in the middle; it ends by its token.
  const data = { id: 'codex:x', provider: 'codex' as const, sessionId: 'x', title: 'X', truncated: false, steps: [] };
  again.replaySession('codex:x', data);
  assert.deepEqual([again.getState().agents.show, again.getState().agents.replay?.token, again.getState().center], [true, 1, 'map']);
  again.stopReplay(2);
  assert.equal(again.getState().agents.replay?.token, 1, 'an earlier replay ending does not stop a newer one');
  again.stopReplay(1);
  assert.equal(again.getState().agents.replay, undefined);
  again.hoverSession('codex:x');
  assert.equal(again.getState().agents.hover, 'codex:x');
  again.showAgentsOnMap(true);
  assert.equal(new AtlasStore({} as AtlasApi, { storage }).getState().agents.show, true);
});

test('in plan, the map hits the innermost block under the pointer', () => {
  setFlat(true);
  const scene = new Scene();
  scene.setStreets(false);
  scene.reset(node('repo', 'repository', undefined, { x: 0, y: 0, w: 100, h: 100 }, { childCount: 1 }));
  scene.addChildren('repo', [node('repo/a.ts', 'file', 'repo', { x: 10, y: 10, w: 20, h: 20 })], 1, false);
  const camera = { x: 50, y: 50, scale: 4 }, viewport = { width: 400, height: 400 };
  const set = scene.visible(camera, viewport, { ...DEFAULT_LOD_FOR_TEST, openPx: 1 });
  const at = worldToScreen(camera, viewport, 20, 20, 99);
  assert.equal(scene.hitTest(set, camera, viewport, at.x, at.y)?.node.id, 'repo/a.ts');
  const outside = worldToScreen(camera, viewport, 60, 60);
  assert.equal(scene.hitTest(set, camera, viewport, outside.x, outside.y)?.node.id, 'repo');
  setFlat(false);
});

test('labels never overlap: beside what they name, further out with a leader, or in a column at the side', () => {
  const bounds = { x0: 0, y0: 0, x1: 400, y1: 300 };
  // Twelve files in one tight cluster, each label wider than the cluster.
  const asks: LabelAsk[] = Array.from({ length: 12 }, (_, i) => ({ key: `f${i}`, target: { x0: 190 + (i % 4) * 5, y0: 140 + Math.floor(i / 4) * 5, x1: 194 + (i % 4) * 5, y1: 144 + Math.floor(i / 4) * 5 }, w: 120, h: 20 }));
  const panel = { x0: 300, y0: 0, x1: 400, y1: 60 };
  const memory = new Map<string, string>();
  const { placed, left } = placeLabels(asks, { bounds, avoid: [panel], memory });
  assert.equal(placed.length + left.length, 12);
  assert.ok(placed.length >= 10, `only ${placed.length} placed`);
  for (const [i, a] of placed.entries()) {
    assert.ok(!overlaps(a.box, panel), `${a.key} covers the panel`);
    assert.ok(a.box.x0 >= 0 && a.box.y0 >= 0 && a.box.x1 <= 400 && a.box.y1 <= 300, `${a.key} leaves the view`);
    for (const b of placed.slice(i + 1)) assert.ok(!overlaps(a.box, b.box), `${a.key} overlaps ${b.key}`);
  }
  // Labels away from what they name have a leader to it.
  assert.ok(placed.filter(item => item.leader).length >= 8);
  // The same asks again: every label keeps its place.
  const again = placeLabels(asks, { bounds, avoid: [panel], memory });
  assert.deepEqual(again.placed.map(item => item.box), placed.map(item => item.box));
  // A label fits inside a big target.
  const inside = placeLabels([{ key: 'big', target: { x0: 10, y0: 10, x1: 200, y1: 100 }, w: 60, h: 18, inside: true }], { bounds });
  assert.equal(inside.placed[0]!.inside, true);
});
