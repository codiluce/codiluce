import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ActivityEvent, ActivitySnapshot } from '@engine/activity/model';
import type { ConversationReplay } from '@engine/conversations/model';
import type { NodeSummary } from '@engine/projection/dto';
import { setFlat, worldToScreen } from '../lib/camera';
import { CrewOnMap, type CrewFrame, type ReplayProgress } from '../lib/crew-map';
import { DEFAULT_LOD } from '../lib/lod';
import { Scene } from '../lib/scene';

const stats = { files: 1, symbols: 0, endpoints: 0, measuredLoc: 0, unmeasuredFiles: 0, descendants: 0 };
function node(id: string, type: string, parent: string | undefined, rect: NodeSummary['rect'], childCount = 0): NodeSummary {
  return { id, kind: 'entity', type, name: id.split('/').pop()!, path: id, depth: 0, rect, childCount, diagnostics: 0, stats, ...(parent ? { spatialParentId: parent } : {}) };
}

test('agents stand on the map itself: on the block of the file they read, their bodies kept free of labels', () => {
  setFlat(true);
  const scene = new Scene();
  scene.setStreets(false);
  scene.reset(node('repo', 'repository', undefined, { x: 0, y: 0, w: 400, h: 300 }, 2));
  scene.addChildren('repo', [node('repo/a.ts', 'file', 'repo', { x: 40, y: 40, w: 100, h: 100 }), node('repo/b.ts', 'file', 'repo', { x: 240, y: 40, w: 100, h: 100 })], 2, false);
  const now = Date.now();
  const read: ActivityEvent = { id: 'r1', at: now - 1000, provider: 'claude-code', actor: 'claude-code:s1', sessionId: 's1', kind: 'read', phase: 'started', label: 'Read', toolId: 'r', status: 'running', paths: [{ path: 'repo/b.ts', scope: 'file', id: 'repo/b.ts', ancestors: ['repo'] }] };
  const snapshot: ActivitySnapshot = { enabled: true, sessions: [{ actor: 'claude-code:s1', provider: 'claude-code', sessionId: 's1', status: 'running', lastSeen: now, label: 'Read', title: 'Fix the map' }], events: [read] };
  const loaded: string[] = [];
  const crew = new CrewOnMap(() => scene, ids => loaded.push(...ids));
  crew.sync(snapshot);
  assert.deepEqual(loaded, ['repo/b.ts'], 'the files they touch are made reachable on the map');
  const camera = { x: 200, y: 150, scale: 2 }, viewport = { width: 800, height: 600 };
  const set = scene.visible(camera, viewport, { ...DEFAULT_LOD, openPx: 1 });
  let frame;
  for (let time = 16; time < 2000; time += 16) frame = crew.frame(viewport, camera, set, time, true);
  assert.ok(crew.busy);
  assert.ok(frame, 'someone is on the map');
  // The body stands on b.ts, not a.ts: its feet at the middle of b.ts's block.
  const feet = worldToScreen(camera, viewport, 290, 90);
  const body = frame.reserved[0]!;
  assert.ok(body.x0 < feet.x && body.x1 > feet.x && Math.abs(body.y1 - 4 - feet.y) < 1, JSON.stringify({ body, feet }));
  assert.deepEqual(crew.places(), { 'claude-code:s1': ['repo/b.ts'] }, 'where it stands, for the Agents list');
  // Another session opened in Agents: this one is not shown.
  assert.equal(crew.frame(viewport, camera, set, 2016, true, { focus: 'codex:other' }), undefined);
  assert.ok(crew.frame(viewport, camera, set, 2032, true, { focus: 'claude-code:s1', dim: 'codex:other' }));
  setFlat(false);
});

test('agents wait in a queue at the right of the map, in the order their sessions started, each labeled with what it does', () => {
  setFlat(true);
  const scene = new Scene();
  scene.setStreets(false);
  scene.reset(node('repo', 'repository', undefined, { x: 0, y: 0, w: 400, h: 300 }, 2));
  scene.addChildren('repo', [node('repo/a.ts', 'file', 'repo', { x: 40, y: 40, w: 100, h: 100 }), node('repo/b.ts', 'file', 'repo', { x: 240, y: 40, w: 100, h: 100 })], 2, false);
  const now = Date.now();
  const sessions = ['s1', 's2', 's3', 's4', 's5'];
  const base = (session: string, i: number) => ({ id: `${session}-e`, at: now - 50_000 + i * 1000, provider: 'claude-code' as const, actor: `claude-code:${session}`, sessionId: session, paths: [] });
  const events: ActivityEvent[] = [
    { ...base('s1', 0), kind: 'status', phase: 'status', label: 'Stop', status: 'idle' },
    { ...base('s2', 1), kind: 'status', phase: 'status', label: 'UserPromptSubmit', status: 'running', lifecycle: 'turn-start' },
    { ...base('s3', 2), kind: 'read', phase: 'started', label: 'Read file', toolId: 'r', status: 'running', paths: [{ path: 'repo/b.ts', scope: 'file', id: 'repo/b.ts', ancestors: ['repo'] }] },
    { ...base('s4', 3), kind: 'status', phase: 'status', label: 'Stop', status: 'idle' },
    { ...base('s5', 4), kind: 'status', phase: 'status', label: 'Stop', status: 'idle' },
  ];
  const snapshot: ActivitySnapshot = { enabled: true, sessions: sessions.map(id => ({ actor: `claude-code:${id}`, provider: 'claude-code', sessionId: id, status: 'running', lastSeen: now, label: '' })), events };
  const crew = new CrewOnMap(() => scene, () => {});
  crew.sync(snapshot);
  const camera = { x: 200, y: 150, scale: 1 }, viewport = { width: 1600, height: 600 };
  const set = scene.visible(camera, viewport, { ...DEFAULT_LOD, openPx: 1 });
  let frame: CrewFrame | undefined;
  for (let time = 16; time < 4000; time += 16) frame = crew.frame(viewport, camera, set, time, true);
  assert.ok(frame);
  const label = (text: string) => frame.captions.find(caption => caption.text === text)!.box;
  assert.deepEqual(frame.captions.map(caption => caption.text).sort(), ['idle', 'idle', 'idle', 'reading b.ts', 'thinking']);
  // The one reading stands on b.ts, its label over its head; the others are in the queue, right of the map.
  const right = worldToScreen(camera, viewport, 400, 0).x, b = worldToScreen(camera, viewport, 290, 90);
  const reading = label('reading b.ts');
  assert.ok(Math.abs((reading.x0 + reading.x1) / 2 - b.x) < 1 && reading.y1 < b.y);
  const [first, second, fourth, fifth] = frame.reserved.slice(0, 5).filter((_, i) => i !== 2);
  assert.ok([first, second, fourth, fifth].every(box => box!.x0 > right), 'beside the map');
  // From the top down by start, the place of the one on the map kept; three to a column here, then a column to the right.
  assert.ok(first!.y0 < second!.y0);
  assert.ok(fourth!.x0 > first!.x0 + 100 && Math.abs(fourth!.y0 - first!.y0) < 1 && fifth!.y0 > fourth!.y0);
  assert.ok(label('thinking').x0 > second!.x1 - 4, 'a label beside a character in the queue');
  setFlat(false);
});

test('a finished session plays again alone on the map: it pauses, steps and changes speed, and the live cast comes back after it', () => {
  setFlat(true);
  const scene = new Scene();
  scene.setStreets(false);
  scene.reset(node('repo', 'repository', undefined, { x: 0, y: 0, w: 400, h: 300 }, 2));
  scene.addChildren('repo', [node('repo/a.ts', 'file', 'repo', { x: 40, y: 40, w: 100, h: 100 }), node('repo/b.ts', 'file', 'repo', { x: 240, y: 40, w: 100, h: 100 })], 2, false);
  const reports: ReplayProgress[] = [];
  const crew = new CrewOnMap(() => scene, () => {}, progress => reports.push(progress));
  const file = (path: string) => ({ path, scope: 'file' as const, action: 'read' as const, id: path, ancestors: ['repo'] });
  const replay: ConversationReplay = { id: 'codex:old', provider: 'codex', sessionId: 'old', title: 'Old work', truncated: false, steps: [
    { role: 'user', at: '2026-10-17T10:00:00Z', paths: [] },
    { role: 'tool', at: '2026-10-17T10:00:05Z', tool: 'Read', callId: 'r1', status: 'completed', paths: [file('repo/a.ts')] },
    { role: 'tool', at: '2026-10-17T10:00:07Z', tool: 'Read', callId: 'r2', status: 'completed', paths: [file('repo/b.ts')] },
    { role: 'assistant', at: '2026-10-17T10:00:09Z', paths: [] },
  ] };
  const camera = { x: 200, y: 150, scale: 2 }, viewport = { width: 800, height: 600 };
  const set = scene.visible(camera, viewport, { ...DEFAULT_LOD, openPx: 1 });
  let time = 16;
  const run = (ms: number) => { for (const until = time + ms; time < until; time += 16) crew.frame(viewport, camera, set, time, true); };
  const here = () => crew.places()['codex:old'] ?? [];
  const control = { token: 1, data: replay, playing: true, speed: 1 };
  crew.sync(undefined, control);
  assert.ok(crew.replaying);
  run(1000);
  assert.deepEqual(here(), ['repo/a.ts']);
  assert.deepEqual(reports.map(report => [report.step, report.total, report.text]).at(-1), [1, 5, 'Reading repo/a.ts']);
  // Paused, nothing moves.
  crew.sync(undefined, { ...control, playing: false });
  run(5000);
  assert.deepEqual(here(), ['repo/a.ts']);
  // A step forward, while paused: its hop plays, then it stays.
  crew.sync(undefined, { ...control, playing: false, seek: { step: 2, n: 1 } });
  run(2000);
  assert.deepEqual(here(), ['repo/b.ts']);
  assert.equal(reports.at(-1)!.text, 'Reading repo/b.ts');
  // And back.
  crew.sync(undefined, { ...control, playing: false, seek: { step: 1, n: 2 } });
  run(500);
  assert.deepEqual(here(), ['repo/a.ts']);
  // Played at 4×, it is over sooner: it stays on its last step, done, until it is closed.
  crew.sync(undefined, { ...control, playing: true, speed: 4, seek: { step: 1, n: 2 } });
  run(3000);
  assert.deepEqual([reports.at(-1)!.step, reports.at(-1)!.done], [4, true]);
  assert.ok(crew.replaying);
  crew.sync(undefined, undefined);
  assert.equal(crew.replaying, false);
  setFlat(false);
});
