import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { NodeSummary } from '@engine/projection/dto';
import { fitBounds, fromScreen, panBy, project, projectedBounds, screenToWorld, toScreen, unproject, visibleBounds, worldToScreen, zoomAround, zoomPath, type Camera } from '../lib/camera';
import { DEFAULT_LOD, abstractionLevel, labelTier, openProgress, screenSize, shouldOpen } from '../lib/lod';
import { Scene, hitPrism, nodeHeight } from '../lib/scene';

const viewport = { width: 1000, height: 600 };
const close = (a: number, b: number, epsilon = 1e-6) => assert.ok(Math.abs(a - b) < epsilon, `${a} ≉ ${b}`);
const stats = { files: 0, symbols: 0, endpoints: 0, measuredLoc: 0, unmeasuredFiles: 0, descendants: 0 };
function node(id: string, rect: NodeSummary['rect'], extra: Partial<NodeSummary> = {}): NodeSummary {
  return { id, kind: 'entity', type: 'directory', name: id, depth: 0, rect, childCount: 0, diagnostics: 0, stats, ...extra };
}

test('isometric projection and screen transforms are exact inverses', () => {
  const camera: Camera = { x: 123.4, y: -56.7, scale: 2.5 };
  for (const [x, y, z] of [[0, 0, 0], [100, 40, 0], [-30, 250, 12], [5000, 7000, 33]] as const) {
    const plane = project(x, y, z);
    const back = unproject(plane.x, plane.y, z);
    close(back.x, x); close(back.y, y);
    const screen = worldToScreen(camera, viewport, x, y, z);
    const world = screenToWorld(camera, viewport, screen.x, screen.y, z);
    close(world.x, x); close(world.y, y);
  }
  const s = toScreen(camera, viewport, { x: 10, y: 20 });
  const p = fromScreen(camera, viewport, s);
  close(p.x, 10); close(p.y, 20);
  // The camera center is the middle of the viewport.
  const center = toScreen(camera, viewport, { x: camera.x, y: camera.y });
  close(center.x, 500); close(center.y, 300);
});
test('zooming keeps the point under the cursor fixed, panning moves by screen pixels, limits clamp', () => {
  const camera: Camera = { x: 0, y: 0, scale: 1 };
  const limits = { min: 0.1, max: 10 };
  const anchorBefore = fromScreen(camera, viewport, { x: 800, y: 100 });
  const zoomed = zoomAround(camera, viewport, 800, 100, 3, limits);
  const anchorAfter = fromScreen(zoomed, viewport, { x: 800, y: 100 });
  close(anchorBefore.x, anchorAfter.x); close(anchorBefore.y, anchorAfter.y);
  assert.equal(zoomAround(camera, viewport, 0, 0, 1000, limits).scale, 10);
  const panned = panBy(camera, 50, -20);
  const moved = toScreen(panned, viewport, { x: 0, y: 0 });
  close(moved.x, 550); close(moved.y, 280);
});
test('fitting a box shows all of it; visible bounds match the viewport', () => {
  const bounds = projectedBounds({ x: 0, y: 0, w: 4000, h: 2500 }, 0, 20);
  const camera = fitBounds(bounds, viewport, 30, { min: 1e-6, max: 100 });
  const view = visibleBounds(camera, viewport);
  assert.ok(view.minX <= bounds.minX && view.maxX >= bounds.maxX && view.minY <= bounds.minY && view.maxY >= bounds.maxY);
  close(Math.min((viewport.width - 60) / (bounds.maxX - bounds.minX), (viewport.height - 60) / (bounds.maxY - bounds.minY)), camera.scale);
});
test('smooth zoom path starts and ends at the requested cameras and zooms out on long jumps', () => {
  const from: Camera = { x: 0, y: 0, scale: 4 }, to: Camera = { x: 5000, y: 3000, scale: 4 };
  const path = zoomPath(from, to, viewport);
  const start = path.at(0), end = path.at(1), middle = path.at(0.5);
  close(start.x, 0); close(start.scale, 4); close(end.x, 5000); close(end.y, 3000); close(end.scale, 4);
  assert.ok(middle.scale < 1, 'long pans zoom out to keep context');
  const zoomOnly = zoomPath(from, { ...from, scale: 16 }, viewport);
  close(zoomOnly.at(1).scale, 16);
});
test('LOD: containers open by on-screen size, labels change content by tier, not just scale', () => {
  const area = node('area', { x: 0, y: 0, w: 100, h: 100 }, { childCount: 3 });
  assert.equal(screenSize(area.rect, 1), 100);
  assert.equal(shouldOpen(area, DEFAULT_LOD.openPx / 100 - 0.01), false);
  assert.equal(shouldOpen(area, DEFAULT_LOD.openPx / 100 + 0.01), true);
  assert.equal(shouldOpen({ ...area, childCount: 0 }, 100), false, 'leaves never open');
  assert.equal(openProgress(area, DEFAULT_LOD.openPx / 100), 0);
  assert.equal(openProgress(area, 100), 1);
  const tiers = [0.1, 0.5, 1.2, 2].map(scale => labelTier(area, scale, false));
  assert.deepEqual(tiers, ['hidden', 'name', 'summary', 'detail']);
  assert.equal(labelTier(area, 5, true), 'district');
  assert.equal(abstractionLevel([{ type: 'application', area: 900 }, { type: 'file', area: 50 }, { type: 'file', area: 50 }], false), 'Applications');
  assert.equal(abstractionLevel([{ type: 'file', area: 300 }, { type: 'directory', area: 100 }], false), 'Files');
  assert.equal(abstractionLevel([{ type: 'method', area: 10 }], false), 'Symbols');
  assert.equal(abstractionLevel([], true), 'Source');
});
function buildScene(order: 'forward' | 'reverse' = 'forward'): Scene {
  const scene = new Scene();
  scene.reset(node('root', { x: 0, y: 0, w: 1000, h: 1000 }, { type: 'repository', childCount: 2 }));
  const children = [
    node('left', { x: 10, y: 10, w: 480, h: 980 }, { spatialParentId: 'root', childCount: 2, depth: 1 }),
    node('right', { x: 510, y: 10, w: 480, h: 980 }, { spatialParentId: 'root', childCount: 0, depth: 1 }),
  ];
  const grandchildren = [
    node('deep-a', { x: 20, y: 20, w: 200, h: 200 }, { spatialParentId: 'left', depth: 2, type: 'file' }),
    node('deep-b', { x: 240, y: 20, w: 200, h: 200 }, { spatialParentId: 'left', depth: 2, type: 'file', loc: 120 }),
  ];
  if (order === 'forward') { scene.addChildren('root', children, 2, false); scene.addChildren('left', grandchildren, 2, false); }
  else { scene.addChildren('left', [...grandchildren].reverse(), 2, false); scene.addChildren('root', [...children].reverse(), 2, false); }
  return scene;
}
test('visibility culls off-screen areas, opens only large containers, and reports unloaded ones', () => {
  const scene = buildScene();
  const far = fitBounds(projectedBounds({ x: 0, y: 0, w: 1000, h: 1000 }, 0, 20), viewport, 0, { min: 1e-6, max: 1e3 });
  const overview = scene.visible(far, viewport);
  assert.ok(overview.index.has('left') && overview.index.has('right'));
  // Zoom onto a file inside the left area: the right area is culled; left opens to show it.
  const deep = scene.nodes.get('deep-a')!;
  const close = fitBounds(projectedBounds(deep.rect, 12, 20), viewport, 0, { min: 1e-6, max: 1e3 });
  const zoomed = scene.visible(close, viewport);
  assert.ok(!zoomed.index.has('right'), 'off-screen sibling culled');
  assert.ok(zoomed.index.has('deep-a'));
  assert.equal(zoomed.items[zoomed.index.get('left')!]!.open, true);
  assert.equal(zoomed.focus?.node.id, 'left', 'innermost open container at the viewport center');
  // A large container whose children are not loaded is pending, not opened.
  scene.nodes.set('right', { ...scene.nodes.get('right')!, childCount: 5 });
  const rightCam = fitBounds(projectedBounds(scene.nodes.get('right')!.rect, 6, 12), viewport, 0, { min: 1e-6, max: 1e3 });
  const pending = scene.visible(rightCam, viewport);
  assert.ok(pending.pending.includes('right'));
  assert.equal(pending.items[pending.index.get('right')!]!.open, false);
});
test('render budget keeps deeper containers closed', () => {
  const scene = buildScene();
  const left = scene.nodes.get('left')!;
  const camera = fitBounds(projectedBounds(left.rect, 6, 12), viewport, 0, { min: 1e-6, max: 1e3 });
  const unlimited = scene.visible(camera, viewport);
  assert.ok(unlimited.index.has('deep-a') && !unlimited.truncated);
  const limited = scene.visible(camera, viewport, { ...DEFAULT_LOD, budget: 1 });
  assert.equal(limited.truncated, true);
  assert.ok(!limited.index.has('deep-a'));
});
test('data loading order does not change the visible set or positions', () => {
  const a = buildScene('forward'), b = buildScene('reverse');
  const camera = fitBounds(projectedBounds({ x: 0, y: 0, w: 1000, h: 1000 }, 0, 20), viewport, 0, { min: 1e-6, max: 1e3 });
  const zoom = { ...camera, scale: camera.scale * 2.2 };
  const va = a.visible(zoom, viewport), vb = b.visible(zoom, viewport);
  assert.deepEqual(va.items.map(item => [item.node.id, item.zBase, item.node.rect]), vb.items.map(item => [item.node.id, item.zBase, item.node.rect]));
});
test('hit testing returns the frontmost primitive, including visible walls; representative finds visible ancestors', () => {
  const scene = buildScene();
  const left = scene.nodes.get('left')!;
  const camera = fitBounds(projectedBounds(left.rect, 6, 12), viewport, 0, { min: 1e-6, max: 1e3 });
  const zoomed = { ...camera, scale: camera.scale * 1.5 };
  const set = scene.visible(zoomed, viewport);
  const deepB = scene.nodes.get('deep-b')!;
  const zTop = scene.zBase('deep-b') + nodeHeight(deepB);
  const center = worldToScreen(zoomed, viewport, deepB.rect.x + 100, deepB.rect.y + 100, zTop);
  assert.equal(scene.hitTest(set, zoomed, viewport, center.x, center.y)?.node.id, 'deep-b', 'child wins over its parent');
  // Point on the front (+y) wall of a block: below the top face's front edge.
  assert.ok(hitPrism({ x: 0, y: 0, w: 10, h: 10 }, 0, 5, { x: -2, y: 8 }));
  assert.ok(!hitPrism({ x: 0, y: 0, w: 10, h: 10 }, 0, 5, { x: -8, y: 8 }));
  const overview = scene.visible(fitBounds(projectedBounds({ x: 0, y: 0, w: 1000, h: 1000 }, 0, 20), viewport, 0, { min: 1e-6, max: 1e3 }), viewport);
  scene.upsert(node('hidden-leaf', { x: 30, y: 30, w: 5, h: 5 }, { spatialParentId: 'deep-a', depth: 3 }));
  assert.equal(scene.representative('hidden-leaf', overview)?.node.id, overview.index.has('deep-a') ? 'deep-a' : 'left');
});
