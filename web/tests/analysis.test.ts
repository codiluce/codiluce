// Store-level behavior of blast radius and Steps, against
// the real projection service over the indexed fixture repository.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';
import { indexRepository } from '../../src/pipeline/index.js';
import { GraphStore } from '../../src/storage/sqlite.js';
import { ProjectionService } from '../../src/projection/service.js';
import type { SoftwareGraph } from '../../src/core/graph.js';
import { layoutSteps } from '../lib/steps-layout';
import { mixHex } from '../lib/renderer';
import { AtlasStore } from '../lib/store';
import { RecordingNavigator, ServiceApi as BaseServiceApi } from './service-api';

const fixture = fileURLToPath(new URL('../../tests/fixtures/repository', import.meta.url));
let root: string, graph: SoftwareGraph, store: GraphStore, projection: ProjectionService;
before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'atlas-analysis-'));
  await cp(fixture, root, { recursive: true });
  await mkdir(path.join(root, '.archipelago'));
  await writeFile(path.join(root, '.archipelago/config.yml'), stringify({ repository: { name: 'fixture' }, applications: [{ name: 'frontend', path: 'frontend', type: 'nextjs' }, { name: 'backend', path: 'backend', type: 'laravel', apiOrigins: ['https://api.fixture.test'], apiOriginEnv: ['NEXT_PUBLIC_API_URL'] }] }));
  graph = await indexRepository(root);
  store = new GraphStore(':memory:'); store.save(graph);
  projection = new ProjectionService(store, { root });
});
after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
class ServiceApi extends BaseServiceApi { constructor() { super(store, projection); } }
const id = (name: string, type?: string) => graph.entities.find(entity => entity.name === name && (!type || entity.type === type))!.id;
const symbol = (qualifiedName: string) => graph.entities.find(entity => entity.metadata.qualifiedName === qualifiedName)!.id;
async function ready(hash = '') {
  const replaced: string[] = [];
  const atlas = new AtlasStore(new ServiceApi(), { location: { hash, replace: value => { replaced.push(value); } } });
  atlas.navigator = new RecordingNavigator();
  await atlas.init();
  return { atlas, replaced };
}

test('impact follows the selection, pages its items and writes the depth into the link', async () => {
  const { atlas, replaced } = await ready();
  const authenticate = symbol('App\\Services\\AuthService::authenticate');
  await atlas.select(authenticate, { fly: false });
  await atlas.showImpact(authenticate, 6);
  let impact = atlas.getState().impact;
  assert.equal(impact.status, 'ready');
  assert.equal(impact.forId, authenticate);
  assert.ok(impact.data!.distances[id('signIn')] === 3);
  assert.ok(impact.items.length > 0 && impact.items.every((item, i, all) => i === 0 || all[i - 1]!.distance <= item.distance));
  assert.match(replaced.at(-1)!, /impact=6/);
  // Filters reload the list, not the radius.
  await atlas.setImpactFilter({ type: 'route' });
  assert.ok(atlas.getState().impact.items.every(item => item.type === 'route'));
  // Selecting another entity moves the radius with it.
  await atlas.select(id('signIn'), { fly: false });
  await new Promise(resolve => setTimeout(resolve, 20));
  impact = atlas.getState().impact;
  assert.equal(impact.forId, id('signIn'));
  assert.equal(impact.data!.distances[id('signIn')], 0);
  atlas.clearSelection();
  assert.equal(atlas.getState().impact.open, false);
  assert.doesNotMatch(replaced.at(-1)!, /impact=/);
});
test('a deep link with impact= reopens the blast radius', async () => {
  const target = id('signIn');
  const { atlas } = await ready(`#id=${encodeURIComponent(target)}&impact=3`);
  await new Promise(resolve => setTimeout(resolve, 50));
  const impact = atlas.getState().impact;
  assert.equal(impact.open, true);
  assert.equal(impact.depth, 3);
  assert.equal(impact.forId, target);
});
test('steps open for an entity and carry ancestors for the map; focus highlights one step', async () => {
  const { atlas } = await ready();
  await atlas.openSteps(id('/account', 'route'));
  const steps = atlas.getState().steps!;
  assert.equal(steps.status, 'ready');
  const save = steps.data!.steps.find(step => step.node?.name === 'handleSave')!;
  assert.equal(save.kind, 'trigger');
  assert.ok(save.ancestors.length > 2, 'spatial ancestors to draw the step on the map');
  assert.ok(atlas.scene.nodes.has(save.node!.id), 'step entities are placed in the scene');
  atlas.focusStep(save.id);
  assert.equal(atlas.getState().steps!.focus, save.id);
  atlas.closeSteps();
  assert.equal(atlas.getState().steps, undefined);
});
test('steps diagram layout is layered, ordered by parents and non-overlapping', () => {
  const nodes = [{ id: 'a', layer: 0 }, { id: 'b', layer: 1 }, { id: 'c', layer: 1 }, { id: 'd', layer: 2 }, { id: 'e', layer: 2 }];
  const edges = [{ id: 'ab', from: 'a', to: 'b', back: false }, { id: 'ac', from: 'a', to: 'c', back: false }, { id: 'ce', from: 'c', to: 'e', back: false }, { id: 'bd', from: 'b', to: 'd', back: false }, { id: 'ea', from: 'e', to: 'a', back: true }];
  const layout = layoutSteps(nodes, edges);
  const box = (key: string) => layout.boxes.find(item => item.id === key)!;
  assert.ok(box('a').y < box('b').y && box('b').y < box('d').y);
  assert.ok(box('d').x < box('e').x, 'children keep their parents\' order');
  for (const x of layout.boxes) for (const y of layout.boxes) if (x !== y) assert.ok(x.x + x.w <= y.x || y.x + y.w <= x.x || x.y + x.h <= y.y || y.y + y.h <= x.y, `${x.id} and ${y.id} overlap`);
  assert.deepEqual(layoutSteps(nodes, edges), layout, 'deterministic');
  assert.ok(layout.edges.find(edge => edge.id === 'ea')!.back);
  assert.equal(mixHex('#000000', '#ffffff', 0.5), '#808080');
});
