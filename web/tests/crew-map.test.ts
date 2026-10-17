import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ActivityEvent, ActivitySnapshot } from '@engine/activity/model';
import type { ConversationReplay } from '@engine/conversations/model';
import type { NodeSummary } from '@engine/projection/dto';
import { setFlat, worldToScreen } from '../lib/camera';
import { CrewOnMap } from '../lib/crew-map';
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

test('a finished session plays again alone on the map, and the live cast comes back after it', () => {
  setFlat(true);
  const scene = new Scene();
  scene.setStreets(false);
  scene.reset(node('repo', 'repository', undefined, { x: 0, y: 0, w: 400, h: 300 }, 2));
  scene.addChildren('repo', [node('repo/a.ts', 'file', 'repo', { x: 40, y: 40, w: 100, h: 100 }), node('repo/b.ts', 'file', 'repo', { x: 240, y: 40, w: 100, h: 100 })], 2, false);
  const ended: number[] = [];
  const crew = new CrewOnMap(() => scene, () => {}, token => ended.push(token));
  const replay: ConversationReplay = { id: 'codex:old', provider: 'codex', sessionId: 'old', title: 'Old work', truncated: false, steps: [
    { role: 'user', at: '2026-10-17T10:00:00Z', paths: [] },
    { role: 'tool', at: '2026-10-17T10:00:05Z', tool: 'Read', callId: 'r1', status: 'completed', paths: [{ path: 'repo/a.ts', scope: 'file', action: 'read', id: 'repo/a.ts', ancestors: ['repo'] }] },
    { role: 'assistant', at: '2026-10-17T10:00:09Z', paths: [] },
  ] };
  const camera = { x: 200, y: 150, scale: 2 }, viewport = { width: 800, height: 600 };
  const set = scene.visible(camera, viewport, { ...DEFAULT_LOD, openPx: 1 });
  crew.sync(undefined, { token: 1, data: replay });
  assert.ok(crew.replaying);
  let seen = false;
  for (let time = 16; time < 12_000; time += 16) { crew.frame(viewport, camera, set, time, true); seen ||= crew.places()['codex:old']?.includes('repo/a.ts') ?? false; }
  assert.ok(seen, 'its character stood on the file it read');
  assert.equal(crew.replaying, false);
  assert.deepEqual(ended, [1]);
  setFlat(false);
});
