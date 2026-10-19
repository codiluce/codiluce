import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AtlasApi } from '../lib/api';
import { glyphOf } from '../lib/glyphs';
import { DEFAULT_LOD } from '../lib/lod';
import { pointInView, receding } from '../lib/renderer';
import { AtlasStore, OPEN_PX_RANGE } from '../lib/store';

function storage() {
  const saved = new Map<string, string>();
  return { saved, storage: { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => void saved.set(key, value) } };
}

test('building shapes and findings on the map are off by default; turning them on is a saved choice', () => {
  // Preferences need no API calls.
  const { saved, storage: store } = storage();
  const fresh = new AtlasStore({} as AtlasApi, { storage: store }).getState();
  assert.deepEqual([fresh.shapes, fresh.showDiagnostics], [false, false]);
  // Earlier versions saved `shapes: true` and `showDiagnostics: true` with every preference, chosen or not: they stay off.
  saved.set('codiluce:prefs', JSON.stringify({ shapes: true, showDiagnostics: true, streets: true }));
  const atlas = new AtlasStore({} as AtlasApi, { storage: store });
  assert.deepEqual([atlas.getState().shapes, atlas.getState().showDiagnostics], [false, false]);
  atlas.setShapes(true); atlas.toggleDiagnostics();
  const again = new AtlasStore({} as AtlasApi, { storage: store }).getState();
  assert.deepEqual([again.shapes, again.showDiagnostics], [true, true]);
  atlas.setShapes(false); atlas.toggleDiagnostics();
  const off = new AtlasStore({} as AtlasApi, { storage: store }).getState();
  assert.deepEqual([off.shapes, off.showDiagnostics], [false, false]);
});

test('folders open from a saved size, kept within the slider; the default is not saved, so it can change', () => {
  const { saved, storage: store } = storage();
  const atlas = new AtlasStore({} as AtlasApi, { storage: store });
  assert.equal(atlas.getState().openPx, DEFAULT_LOD.openPx);
  atlas.setOpenPx(95);
  assert.equal(new AtlasStore({} as AtlasApi, { storage: store }).getState().openPx, 95);
  atlas.setOpenPx(5);
  assert.equal(atlas.getState().openPx, OPEN_PX_RANGE.min);
  atlas.setOpenPx(DEFAULT_LOD.openPx);
  assert.equal(JSON.parse(saved.get('codiluce:prefs')!).openPx, undefined);
  saved.set('codiluce:prefs', JSON.stringify({ openPx: 'wide' }));
  assert.equal(new AtlasStore({} as AtlasApi, { storage: store }).getState().openPx, DEFAULT_LOD.openPx);
});

test('kinds that matter in a flow get a glyph; tests, and folders of mostly tests, recede', () => {
  assert.deepEqual((['page', 'routes', 'controller', 'table', 'model', 'job', 'test', 'helper', 'component'] as const).map(glyphOf), ['page', 'endpoint', 'endpoint', 'data', 'data', 'job', 'test', undefined, undefined]);
  const stats = (files: number) => ({ files, symbols: 0, endpoints: 0, measuredLoc: 0, unmeasuredFiles: 0, descendants: files });
  assert.equal(receding({ archetype: { kind: 'test', basis: 'convention', reason: '' }, stats: stats(1) }), true);
  assert.equal(receding({ archetype: { kind: 'service', basis: 'convention', reason: '' }, stats: stats(1) }), false);
  assert.equal(receding({ archetypeCounts: [{ kind: 'test', count: 9 }], stats: stats(11) }), true);
  assert.equal(receding({ archetypeCounts: [{ kind: 'test', count: 3 }, { kind: 'component', count: 8 }], stats: stats(11) }), false);
});

test('dependencies on the map are off by default; turning them on is a saved choice', () => {
  const { storage: store } = storage();
  const atlas = new AtlasStore({} as AtlasApi, { storage: store });
  assert.equal(atlas.getState().dependencies.show, false);
  atlas.toggleDependencies();
  assert.equal(new AtlasStore({} as AtlasApi, { storage: store }).getState().dependencies.show, true);
  atlas.toggleDependencies(false);
  assert.equal(new AtlasStore({} as AtlasApi, { storage: store }).getState().dependencies.show, false);
});

test('words on a link go along its part in view', () => {
  const viewport = { width: 200, height: 100 };
  // All in view: the middle of the whole line, or nearer one end.
  assert.deepEqual(pointInView([{ x: 20, y: 50 }, { x: 120, y: 50 }, { x: 120, y: 90 }], viewport, 0.5, 0), { x: 90, y: 50 });
  assert.deepEqual(pointInView([{ x: 20, y: 50 }, { x: 120, y: 50 }, { x: 120, y: 90 }], viewport, 0.75, 0), { x: 120, y: 55 });
  // One end far off screen: the middle of what shows.
  assert.deepEqual(pointInView([{ x: 40, y: 50 }, { x: 1000, y: 50 }], viewport, 0.5, 0), { x: 120, y: 50 });
  // Nothing in view: no place for words.
  assert.equal(pointInView([{ x: -50, y: -50 }, { x: -10, y: -50 }], viewport, 0.5, 0), undefined);
});
