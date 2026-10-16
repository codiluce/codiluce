import assert from 'node:assert/strict';
import { test } from 'node:test';
import { layoutDiagram, type DiagramNode } from '../lib/diagram-layout';

const box = (id: string, group = 'src', extra: Partial<DiagramNode> = {}): DiagramNode => ({ id, group, w: 200, h: 50, ...extra });

test('diagram layout: columns follow the arrows from the start, a cycle is broken, and the same input gives the same picture', () => {
  const nodes = [box('client'), box('analyzer'), box('pipeline', 'pipeline'), box('grammars')];
  const edges = [
    { id: 'a', from: 'pipeline', to: 'analyzer', directed: true },
    { id: 'b', from: 'analyzer', to: 'client', directed: true },
    { id: 'c', from: 'client', to: 'grammars', directed: true },
    { id: 'd', from: 'grammars', to: 'analyzer', directed: true },
  ];
  const layout = layoutDiagram(nodes, edges, { start: 'pipeline' });
  const column = Object.fromEntries(layout.nodes.map(node => [node.id, node.column]));
  assert.deepEqual(column, { pipeline: 0, analyzer: 1, client: 2, grammars: 3 });
  assert.deepEqual(layoutDiagram(nodes, edges, { start: 'pipeline' }), layout);
  const back = layout.edges.find(edge => edge.id === 'd')!;
  assert.equal(back.angle, Math.PI, 'the arrow against the columns enters from the right');
  assert.equal(layout.edges.find(edge => edge.id === 'a')!.angle, 0);
});

test('diagram layout: groups are bands that never overlap, ports place arrow ends inside a box, undirected boxes join their partner', () => {
  const nodes = [box('a', 'one'), box('b', 'two', { h: 120, ports: { 'b#run': 70 } }), box('c', 'one'), box('d', 'two')];
  const layout = layoutDiagram(nodes, [
    { id: 'x', from: 'a', to: 'b#run', directed: true },
    { id: 'y', from: 'b#run', to: 'c', directed: true },
    { id: 'z', from: 'd', to: 'c', directed: false },
  ]);
  const [one, two] = layout.bands;
  assert.ok(one && two);
  assert.ok(one.y + one.h <= two.y || two.y + two.h <= one.y, 'bands are disjoint');
  for (const node of layout.nodes) {
    const band = layout.bands.find(item => item.group === node.group)!;
    assert.ok(node.x >= band.x && node.x + node.w <= band.x + band.w && node.y >= band.y && node.y + node.h <= band.y + band.h, `${node.id} sits in its band`);
  }
  const b = layout.nodes.find(node => node.id === 'b')!;
  assert.equal(layout.edges.find(edge => edge.id === 'x')!.end.y, b.y + 70, 'the arrow ends on the port');
  assert.equal(layout.nodes.find(node => node.id === 'd')!.column, layout.nodes.find(node => node.id === 'c')!.column);
  assert.ok(layout.width > 0 && layout.height > 0);
});

test('diagram layout: fixed columns (impact distances) are kept', () => {
  const layout = layoutDiagram([box('origin', '', { column: 0 }), box('near', '', { column: 1 }), box('far', '', { column: 3 })], [{ id: 'e', from: 'far', to: 'origin', directed: true }]);
  assert.deepEqual(layout.nodes.map(node => [node.id, node.column]), [['origin', 0], ['near', 1], ['far', 2]]);
});

test('diagram layout: top to bottom, layers become rows and bands become columns', () => {
  const nodes = [box('a', 'one'), box('b', 'one'), box('c', 'two')];
  const layout = layoutDiagram(nodes, [{ id: 'x', from: 'a', to: 'b', directed: true }, { id: 'y', from: 'b', to: 'c', directed: true }], { direction: 'down' });
  const at = Object.fromEntries(layout.nodes.map(node => [node.id, node]));
  assert.ok(at.b!.y > at.a!.y + at.a!.h && at.c!.y > at.b!.y + at.b!.h, 'each layer below the last');
  const [one, two] = layout.bands;
  assert.ok(one!.x + one!.w <= two!.x, 'bands side by side');
  const edge = layout.edges.find(item => item.id === 'x')!;
  assert.equal(edge.end.y, at.b!.y, 'the arrow enters from the top');
  assert.ok(Math.abs(edge.angle - Math.PI / 2) < 1e-9, 'pointing down');
  for (const node of layout.nodes) assert.ok(node.x >= 0 && node.y >= 0 && node.x + node.w <= layout.width && node.y + node.h <= layout.height);
});
