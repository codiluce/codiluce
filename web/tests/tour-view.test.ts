import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AtlasApi } from '../lib/api';
import { placeLabels } from '../lib/labels';
import { AtlasStore } from '../lib/store';

test('a tour shows its diagram scenes on the map by default; as diagrams is a saved choice', () => {
  // Preferences need no API calls.
  const saved = new Map<string, string>();
  const storage = { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => void saved.set(key, value) };
  const store = new AtlasStore({} as AtlasApi, { storage });
  assert.equal(store.getState().tourView, 'map');
  store.setTourView('diagram');
  assert.equal(new AtlasStore({} as AtlasApi, { storage }).getState().tourView, 'diagram');
  store.setTourView('map');
  assert.equal(new AtlasStore({} as AtlasApi, { storage }).getState().tourView, 'map');
  // Unknown values fall back to the map.
  saved.set('codiluce:prefs', JSON.stringify({ tourView: 'lift' }));
  assert.equal(new AtlasStore({} as AtlasApi, { storage }).getState().tourView, 'map');
});

test('words on links sit on the link when free, and step aside for a label already there', () => {
  const bounds = { x0: 0, y0: 0, x1: 400, y1: 300 };
  // A word's target is its own size around the link's middle: placed right there when nothing is in the way.
  const word = { key: 'asks', target: { x0: 167, y0: 137, x1: 233, y1: 163 }, w: 60, h: 20, inside: true };
  assert.equal(placeLabels([word], { bounds, columns: false, clearTargets: false }).placed[0]!.inside, true);
  // A numbered label already on the link's middle: the word goes beside it (the map draws a leader to it), without covering it.
  const callout = { x0: 170, y0: 140, x1: 260, y1: 160 };
  const { placed } = placeLabels([word], { bounds, avoid: [callout], columns: false, clearTargets: false });
  assert.equal(placed.length, 1);
  const box = placed[0]!.box;
  assert.ok(box.x1 <= callout.x0 || box.x0 >= callout.x1 || box.y1 <= callout.y0 || box.y0 >= callout.y1, 'the word covers the label');
  assert.equal(placed[0]!.inside, false);
});
