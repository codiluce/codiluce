// The places of a comparison (projection/regions.ts) over hand-made trees:
// what a split view frames, and how `auto` decides how close to look.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { changeRegions, REGION_PAGE, type RegionNode } from '../src/projection/regions.js';
import type { ChangeStatus } from '../src/projection/dto.js';

/** A tree from `path: [type, x, y, w, h, status?]`; parents are the path prefixes, the repository is `` (ID `repo`). */
function tree(spec: Record<string, [string, number, number, number, number, ChangeStatus?]>): { lookup: (id: string) => RegionNode | undefined; changed: string[] } {
  const nodes = new Map<string, RegionNode>();
  const children = new Map<string, number>();
  for (const [path, [type, x, y, w, h, status]] of Object.entries(spec)) {
    const id = path || 'repo';
    const parent = path === '' ? undefined : path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : 'repo';
    if (parent !== undefined) children.set(parent, (children.get(parent) ?? 0) + 1);
    nodes.set(id, { id, kind: type === 'group' ? 'group' : 'entity', type, rect: { x, y, w, h }, childCount: 0, ...(parent !== undefined ? { spatialParentId: parent } : {}), ...(status ? { change: { status } } : {}) });
  }
  for (const [id, count] of children) { const node = nodes.get(id); if (node) node.childCount = count; }
  return { lookup: id => nodes.get(id), changed: [...nodes.values()].filter(node => node.change).map(node => node.id) };
}
const ids = (result: ReturnType<typeof changeRegions>) => result.regions.map(region => region.id);
const base = {
  '': ['repository', 0, 0, 1000, 1000],
  web: ['application', 0, 0, 480, 1000],
  'web/src': ['directory', 0, 0, 480, 600],
  'web/src/Login.tsx': ['file', 0, 0, 40, 40],
  'web/src/Login.tsx/login': ['function', 2, 2, 10, 10],
  'web/src/Big.tsx': ['file', 100, 100, 300, 300],
  'web/docs': ['directory', 0, 700, 480, 300],
  api: ['application', 520, 0, 480, 1000],
  'api/app': ['directory', 520, 0, 480, 700],
  'api/app/Auth.php': ['file', 520, 0, 40, 40],
  'api/routes': ['group', 520, 800, 200, 200],
  'api/routes/r1': ['route', 520, 800, 10, 10],
  'api/routes/r2': ['route', 540, 800, 10, 10],
} as const satisfies Record<string, [string, number, number, number, number]>;
type Spec = Parameters<typeof tree>[0];
const withChanges = (changes: Record<string, ChangeStatus>): Spec => Object.fromEntries(Object.entries(base).map(([id, value]) => [id, changes[id] ? [...value, changes[id]] : [...value]])) as Spec;

test('a changed symbol is seen in its file; a single place is framed as closely as it can be', () => {
  const { lookup, changed } = tree(withChanges({ 'web/src/Login.tsx/login': 'modified' }));
  const result = changeRegions(changed, lookup);
  assert.deepEqual(ids(result), ['web/src/Login.tsx']);
  assert.deepEqual(result.regions[0]!.counts, { added: 0, removed: 0, modified: 1, moved: 0 });
  assert.equal(result.changed, 1);
});
test('auto never stops at the repository: changes in two applications give a place in each', () => {
  const { lookup, changed } = tree(withChanges({ 'web/src/Login.tsx': 'modified', 'web/src/Login.tsx/login': 'modified', 'api/app/Auth.php': 'modified', 'api/routes/r1': 'removed', 'api/routes/r2': 'added' }));
  const result = changeRegions(changed, lookup);
  // The routes are seen in their district, never alone; the files where they are.
  assert.deepEqual(ids(result).sort(), ['api/app/Auth.php', 'api/routes', 'web/src/Login.tsx']);
  assert.deepEqual(ids(result)[0], 'web/src/Login.tsx', 'most changes first, then by place');
  const routes = result.regions.find(region => region.id === 'api/routes')!;
  assert.deepEqual(routes.counts, { added: 1, removed: 1, modified: 0, moved: 0 });
});
test('an added folder is seen through the files added in it; an empty one is a place itself', () => {
  const spec = withChanges({ 'web/docs': 'added' });
  // Files filling the folder: one view frames them both.
  const filled = tree({ ...spec, 'web/docs/a.md': ['file', 0, 700, 240, 300, 'added'], 'web/docs/b.md': ['file', 240, 700, 240, 300, 'added'] });
  const one = changeRegions(filled.changed, filled.lookup);
  assert.deepEqual(ids(one), ['web/docs']);
  assert.deepEqual(one.regions[0]!.counts.added, 3, 'the folder and its two files');
  assert.deepEqual(ids(changeRegions(filled.changed, filled.lookup, { level: 'file' })).sort(), ['web/docs/a.md', 'web/docs/b.md']);
  // Small files far apart: with room on the page, each gets a closer view; the view frames the files, not the folder.
  const apart = tree({ ...spec, 'web/docs/a.md': ['file', 0, 700, 40, 40, 'added'], 'web/docs/b.md': ['file', 400, 900, 40, 40, 'added'] });
  assert.deepEqual(ids(changeRegions(apart.changed, apart.lookup)).sort(), ['web/docs/a.md', 'web/docs/b.md']);
  assert.deepEqual(changeRegions(apart.changed, apart.lookup, { level: 'directory' }).regions[0]!.box, { x: 0, y: 700, w: 440, h: 240 });
  const empty = tree(withChanges({ 'web/docs': 'added' }));
  assert.deepEqual(ids(changeRegions(empty.changed, empty.lookup)), ['web/docs']);
});
test('levels: one place per application, folder (never the repository) or file', () => {
  const { lookup, changed } = tree({ ...withChanges({ 'web/src/Login.tsx': 'modified', 'web/src/Big.tsx': 'modified', 'api/app/Auth.php': 'added' }), 'README.md': ['file', 0, 0, 5, 5, 'modified'] });
  assert.deepEqual(ids(changeRegions(changed, lookup, { level: 'application' })).sort(), ['README.md', 'api', 'web']);
  assert.deepEqual(ids(changeRegions(changed, lookup, { level: 'directory' })).sort(), ['README.md', 'api/app', 'web/src']);
  assert.deepEqual(ids(changeRegions(changed, lookup, { level: 'file' })).sort(), ['README.md', 'api/app/Auth.php', 'web/src/Big.tsx', 'web/src/Login.tsx']);
});
test('auto fills a page freely, and beyond it splits only places whose changes leave most of them untouched', () => {
  // Eight folders side by side, each with two changed files.
  const spec: Spec = { '': ['repository', 0, 0, 8000, 1000], app: ['application', 0, 0, 8000, 1000] };
  for (let i = 0; i < 8; i++) {
    spec[`app/d${i}`] = ['directory', i * 1000, 0, 1000, 1000];
    // Small files in the first four folders (loose: worth a view each); files filling the others.
    const size = i < 4 ? 50 : 480;
    spec[`app/d${i}/a`] = ['file', i * 1000, 0, size, size, 'modified'];
    spec[`app/d${i}/b`] = ['file', i * 1000 + 500, 500, size, size, 'modified'];
  }
  const { lookup, changed } = tree(spec);
  const result = changeRegions(changed, lookup);
  assert.equal(result.changed, 16);
  const places = ids(result);
  assert.ok(places.length > REGION_PAGE, 'more places than a page when they are far apart');
  for (let i = 0; i < 4; i++) assert.ok(places.includes(`app/d${i}/a`) && places.includes(`app/d${i}/b`), `loose folder d${i} is split into its files`);
  for (let i = 4; i < 8; i++) assert.ok(places.includes(`app/d${i}`), `filled folder d${i} stays one place`);
  // At most `max` places: the smallest are left out and counted.
  const capped = changeRegions(changed, lookup, { level: 'file', max: 5 });
  assert.equal(capped.regions.length, 5);
  assert.equal(capped.truncated, 11);
});
test('nothing changed, unchanged statuses and entities out of reach give no places', () => {
  const { lookup } = tree(withChanges({}));
  assert.deepEqual(changeRegions(['web/src/Login.tsx', 'missing'], lookup), { level: 'auto', regions: [], changed: 0, truncated: 0 });
  const spec = withChanges({ 'web/src/Login.tsx': 'unchanged' });
  const orphan = tree({ ...spec, 'lost/file.ts': ['file', 0, 0, 1, 1, 'added'] });
  // `lost` is not in the tree: its file cannot be placed.
  assert.equal(changeRegions(orphan.changed, orphan.lookup).changed, 0);
});
