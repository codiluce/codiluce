import assert from 'node:assert/strict';
import { test } from 'node:test';
import { facing, railRoute, streetRoute, streetsOf, type Rail, type RailRect, type RailWorld } from '../lib/rails';

/** A small map: `blocks` by ID with their parent; floors are stacked 5 units per level. */
function world(blocks: Record<string, { rect: RailRect; parent?: string }>): RailWorld {
  const depth = (id: string): number => { const parent = blocks[id]?.parent; return parent ? depth(parent) + 1 : 0; };
  return {
    rect: id => blocks[id]?.rect,
    parent: id => blocks[id]?.parent,
    children: id => Object.keys(blocks).filter(key => blocks[key]!.parent === id),
    top: id => (depth(id) + 1) * 5,
  };
}
const inside = (point: { x: number; y: number }, rect: RailRect) => point.x > rect.x + 1e-6 && point.x < rect.x + rect.w - 1e-6 && point.y > rect.y + 1e-6 && point.y < rect.y + rect.h - 1e-6;
/** Whether a straight, axis-aligned segment passes through a block's interior. */
function crosses(a: { x: number; y: number }, b: { x: number; y: number }, rect: RailRect): boolean {
  if (Math.abs(a.y - b.y) < 1e-9) return a.y > rect.y + 1e-6 && a.y < rect.y + rect.h - 1e-6 && Math.max(a.x, b.x) > rect.x + 1e-6 && Math.min(a.x, b.x) < rect.x + rect.w - 1e-6;
  return a.x > rect.x + 1e-6 && a.x < rect.x + rect.w - 1e-6 && Math.max(a.y, b.y) > rect.y + 1e-6 && Math.min(a.y, b.y) < rect.y + rect.h - 1e-6;
}
function assertOrthogonal(rail: Rail): void {
  for (let i = 1; i < rail.points.length; i++) {
    const a = rail.points[i - 1]!, b = rail.points[i]!;
    const moved = [Math.abs(a.x - b.x) > 1e-9, Math.abs(a.y - b.y) > 1e-9, Math.abs(a.z - b.z) > 1e-9].filter(Boolean).length;
    assert.equal(moved, 1, `segment ${i} moves along one axis: ${JSON.stringify([a, b])}`);
  }
  assert.equal(rail.hosts.length, rail.points.length - 1);
}

test('a block is left through the side facing where the rail goes', () => {
  const rect = { x: 0, y: 0, w: 10, h: 40 };
  assert.equal(facing(rect, { x: 30, y: 20 }), 0);
  assert.equal(facing(rect, { x: -30, y: 20 }), 1);
  assert.equal(facing(rect, { x: 12, y: 80 }), 2, 'measured against the block\'s size: a tall block is left from its end');
  assert.equal(facing(rect, { x: 5, y: -10 }), 3);
});
test('streets are read from the layout: the padding along the edge and half the gap between blocks', () => {
  const streets = streetsOf({ x: 0, y: 0, w: 100, h: 100 }, [{ x: 10, y: 10, w: 30, h: 30 }, { x: 45, y: 10, w: 30, h: 30 }]);
  assert.deepEqual([streets.margin, streets.band], [2.5, 5]);
  assert.deepEqual(streets.inner, { x: 10, y: 10, w: 65, h: 30 });
});
test('a street route turns at right angles and goes round the blocks in its way', () => {
  const bounds = { x: 0, y: 0, w: 100, h: 60 };
  const wall = { x: 40, y: 0.5, w: 20, h: 45 };
  const route = streetRoute(bounds, [wall], { x: 20, y: 20 }, { x: 80, y: 20 }, { margin: 2, band: 4 })!;
  assert.ok(route.length >= 4, 'it has to turn to get round');
  for (let i = 1; i < route.length; i++) {
    const a = route[i - 1]!, b = route[i]!;
    assert.ok(Math.abs(a.x - b.x) < 1e-9 || Math.abs(a.y - b.y) < 1e-9, 'axis-aligned');
    assert.ok(!crosses(a, b, wall), 'never through the block');
  }
  assert.ok(route.some(point => point.y > wall.y + wall.h), 'round the open end');
  assert.equal(streetRoute(bounds, [{ x: 40, y: 0, w: 20, h: 60 }], { x: 20, y: 20 }, { x: 80, y: 20 }, { margin: 2, band: 4 }), undefined, 'no street leads through a wall across the floor');
});
test('a rail between blocks in different areas climbs out of one, runs on the shared floor and climbs into the other', () => {
  const map = world({
    root: { rect: { x: 0, y: 0, w: 200, h: 120 } },
    a: { rect: { x: 10, y: 10, w: 80, h: 100 }, parent: 'root' },
    b: { rect: { x: 110, y: 10, w: 80, h: 100 }, parent: 'root' },
    a1: { rect: { x: 15, y: 15, w: 30, h: 30 }, parent: 'a' },
    a2: { rect: { x: 50, y: 15, w: 30, h: 30 }, parent: 'a' },
    b1: { rect: { x: 115, y: 70, w: 30, h: 30 }, parent: 'b' },
  });
  const rail = railRoute(map, 'a1', 'b1')!;
  assert.ok(rail, 'a route exists');
  assertOrthogonal(rail);
  const floors = rail.points.map(point => point.z).filter((z, i, all) => i === 0 || z !== all[i - 1]);
  assert.deepEqual(floors, [10, 5, 10], 'on a\'s floor, down to the root\'s, up onto b\'s');
  for (let i = 1; i < rail.points.length; i++) {
    const a = rail.points[i - 1]!, b = rail.points[i]!;
    for (const id of ['a2'] as const) assert.ok(!crosses(a, b, map.rect(id)!), `never across ${id}`);
    if (a.z === 5 && b.z === 5) for (const id of ['a', 'b']) assert.ok(!crosses(a, b, map.rect(id)!), `the root's floor keeps outside ${id}`);
  }
  assert.ok(!inside(rail.points[0]!, map.rect('a1')!) && !inside(rail.points.at(-1)!, map.rect('b1')!), 'ends on the blocks\' sides');
  // Down the walls: the east wall of a faces the viewer (drawn with a), the west wall of b does not (drawn with the root's floor).
  const drops = rail.points.slice(1).flatMap((point, i) => Math.abs(point.z - rail.points[i]!.z) > 1e-9 ? [rail.hosts[i]] : []);
  assert.deepEqual(drops, ['a', 'root']);
  // An area and a block inside it: from the area's outer street, on the side nearest the block, to the block.
  const nested = railRoute(map, 'a', 'a1')!;
  assertOrthogonal(nested);
  const area = map.rect('a')!, start = nested.points[0]!, end = nested.points.at(-1)!;
  assert.ok(start.x - area.x <= 5 + 1e-9 || start.y - area.y <= 5 + 1e-9, 'starts in the outer street on the near side (west or north)');
  assert.ok(nested.points.every(point => point.z === 10), 'on a\'s floor');
  assert.ok(!inside(end, map.rect('a1')!) && Math.min(Math.abs(end.x - 15), Math.abs(end.x - 45), Math.abs(end.y - 15), Math.abs(end.y - 45)) < 1e-9, 'ends on a side of a1');
  assert.deepEqual(railRoute(map, 'a1', 'a')!.points, [...nested.points].reverse(), 'the other way round, reversed');
});
