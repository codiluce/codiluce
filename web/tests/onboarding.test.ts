// The onboarding tour in the store: offered once, started by the address,
// walked with Next only or by doing what a stop invites, Back, the closing
// card and its chapters, and everything put back as it was when it ends.
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
import { ONBOARDING_KEY, readSaved, tourParam, withoutTourParam, writeSaved, type TourKey } from '../lib/onboarding';
import { AtlasStore, type SavedCamera } from '../lib/store';
import { RecordingNavigator, ServiceApi as BaseServiceApi } from './service-api';

const fixture = fileURLToPath(new URL('../../tests/fixtures/repository', import.meta.url));
let root: string, graph: SoftwareGraph, store: GraphStore, projection: ProjectionService;
before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'atlas-onboarding-web-'));
  await cp(fixture, root, { recursive: true });
  await mkdir(path.join(root, '.codiluce'));
  await writeFile(path.join(root, '.codiluce/config.yml'), stringify({ repository: { name: 'fixture' }, applications: [{ name: 'frontend', path: 'frontend', type: 'nextjs' }, { name: 'backend', path: 'backend', type: 'laravel', apiOrigins: ['https://api.fixture.test'], apiOriginEnv: ['NEXT_PUBLIC_API_URL'] }] }));
  graph = await indexRepository(root);
  store = new GraphStore(':memory:'); store.save(graph);
  projection = new ProjectionService(store, { root, stateDirectory: path.join(root, '.codiluce') });
});
after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
class ServiceApi extends BaseServiceApi { constructor() { super(store, projection); } }
/** A navigator that also keeps a camera, as the map does. */
class CameraNavigator extends RecordingNavigator {
  camera: SavedCamera = { camera: { x: 1, y: 2, scale: 0.5 }, flat: false };
  restored: SavedCamera[] = [];
  cameraState() { return this.camera; }
  restoreCamera(saved: SavedCamera) { this.restored.push(saved); }
}
function memory(initial: Record<string, string> = {}) {
  const saved = new Map(Object.entries(initial));
  return { saved, getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => void saved.set(key, value) };
}
async function ready(options: { storage?: ReturnType<typeof memory>; tour?: TourKey } = {}) {
  const atlas = new AtlasStore(new ServiceApi(), { ...(options.storage ? { storage: options.storage } : {}), ...(options.tour ? { tour: options.tour } : {}) });
  const navigator = new CameraNavigator();
  atlas.navigator = navigator;
  await atlas.init();
  await atlas.loadOnboarding();
  return { atlas, navigator };
}
const id = (name: string, type?: string) => graph.entities.find(entity => entity.name === name && (!type || entity.type === type))!.id;
const until = async (check: () => boolean) => { for (let i = 0; i < 200 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 5)); assert.ok(check(), 'condition never held'); };
const current = (atlas: AtlasStore) => { const run = atlas.getState().onboarding.run; return run ? `${atlas.onboardingStops()[run.stop]?.key ?? 'closing'}:${run.beat}` : 'off'; };

test('a first visit offers the tour once; answering the welcome card is remembered', async () => {
  const storage = memory();
  const { atlas } = await ready({ storage });
  assert.equal(atlas.getState().onboarding.welcome, true);
  // The welcome card's counts.
  assert.equal(atlas.getState().onboarding.thread.data?.counts.files, 48);
  atlas.dismissWelcome();
  assert.equal(atlas.getState().onboarding.welcome, false);
  assert.deepEqual(JSON.parse(storage.saved.get(ONBOARDING_KEY)!), { seen: 1, chapters: [] });
  const again = await ready({ storage });
  assert.equal(again.atlas.getState().onboarding.welcome, false);
  // Without storage it is offered every time, and nothing breaks.
  assert.equal((await ready()).atlas.getState().onboarding.welcome, true);
});

test('Next alone walks the core tour on the thread, and the end puts everything back', async () => {
  const storage = memory({ [ONBOARDING_KEY]: '{"seen":1}' });
  const { atlas, navigator } = await ready({ storage });
  const login = id('LoginForm.tsx', 'file');
  await atlas.select(login, { fly: false });
  const history = atlas.getState().history;
  await atlas.startOnboarding();
  const thread = atlas.getState().onboarding.thread.data!;
  const file = thread.thread.file!, folder = thread.thread.folder!, flow = thread.thread.flow!;
  assert.equal(current(atlas), 'map:invite');
  await atlas.onboardingNext();
  assert.equal(current(atlas), 'map:show');
  assert.equal(atlas.getState().selection?.id, folder.id);
  await atlas.onboardingNext();
  assert.equal(current(atlas), 'search:invite');
  await atlas.onboardingNext();
  assert.equal(atlas.getState().searchRequest?.text, file.name);
  // The code stop selects the file first, then Next opens its code.
  await atlas.onboardingNext();
  assert.equal(current(atlas), 'code:invite');
  assert.equal(atlas.getState().selection?.id, file.id);
  await atlas.onboardingNext();
  assert.ok(atlas.getState().code);
  await atlas.onboardingNext();
  assert.equal(current(atlas), 'flows:invite');
  await atlas.onboardingNext();
  assert.deepEqual([atlas.getState().panels.left, atlas.getState().panels.tab], [true, 'flows']);
  assert.equal(atlas.getState().catalog.entity?.id, file.id);
  assert.equal(atlas.getState().flowView?.id, flow.id);
  assert.equal(atlas.getState().center, 'flow');
  await atlas.onboardingNext();
  await atlas.onboardingNext();
  assert.equal(atlas.getState().center, 'impact');
  assert.equal(atlas.getState().impact.forId, file.id);
  // No Git history here: the History stop says why, and has one beat.
  await atlas.onboardingNext();
  const stop = atlas.onboardingStops()[atlas.getState().onboarding.run!.stop]!;
  assert.equal(stop.key, 'history');
  assert.match(atlas.onboardingMissing(stop)!, /Git commits/);
  await atlas.onboardingNext();
  assert.equal(current(atlas), 'closing:invite');
  await atlas.onboardingNext();
  assert.equal(current(atlas), 'off');
  // As before: the file selected, nothing else open, Back and Forward untouched, the camera where it was.
  const state = atlas.getState();
  assert.equal(state.selection?.id, login);
  assert.deepEqual(state.history, history);
  assert.equal(state.code, undefined);
  assert.equal(state.flowView, undefined);
  assert.equal(state.impact.open, false);
  assert.equal(state.center, 'map');
  assert.deepEqual(state.panels, { left: false, tab: 'flows', inspector: true, settings: false });
  assert.equal(state.searchRequest?.text, '');
  assert.deepEqual(navigator.restored, [navigator.camera]);
});

test('doing what a stop invites moves on, unless it was already done when the stop began; Back applies a stop again', async () => {
  const { atlas } = await ready({ storage: memory({ [ONBOARDING_KEY]: '{"seen":1}' }) });
  await atlas.startOnboarding();
  // Search: focusing the box is what the invite asks.
  await atlas.onboardingNext(); await atlas.onboardingNext();
  assert.equal(current(atlas), 'search:invite');
  atlas.onboardingCheck('search');
  await until(() => current(atlas) === 'search:show');
  // Code: opening it by hand runs the stop's show.
  await atlas.onboardingNext();
  assert.equal(current(atlas), 'code:invite');
  atlas.openCode();
  atlas.onboardingCheck();
  await until(() => current(atlas) === 'code:show');
  // Back to the code's invite: Code is open already, so nothing moves on by itself.
  await atlas.onboardingBack();
  assert.equal(current(atlas), 'code:invite');
  atlas.onboardingCheck();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(current(atlas), 'code:invite');
  // Wandering off (another selection): Back and Next select the thread's file again.
  await atlas.select(id('LoginForm.tsx', 'file'), { fly: false, recordHistory: false });
  await atlas.onboardingBack();
  assert.equal(current(atlas), 'search:show');
  await atlas.onboardingNext();
  assert.equal(atlas.getState().selection?.id, atlas.getState().onboarding.thread.data!.thread.file!.id);
  await atlas.exitOnboarding();
  assert.equal(atlas.getState().selection, undefined);
  assert.equal(atlas.getState().code, undefined);
});

test('the address starts the tour or a chapter; chapters taken are remembered', async () => {
  const storage = memory();
  const { atlas } = await ready({ storage, tour: 'color' });
  await until(() => !atlas.getState().onboarding.run?.busy);
  assert.equal(atlas.getState().onboarding.welcome, false);
  assert.equal(current(atlas), 'color:invite');
  await atlas.onboardingNext();
  assert.equal(atlas.colorMode(), 'complexity');
  // The second stop colors the map as it begins (no history here: by flow coverage).
  await atlas.onboardingNext();
  assert.equal(current(atlas), 'color-more:invite');
  assert.equal(atlas.colorMode(), 'coverage');
  await atlas.onboardingNext();
  assert.equal(current(atlas), 'closing:invite');
  assert.deepEqual(atlas.getState().onboarding.chapters, ['color']);
  assert.deepEqual(readSaved(storage), { seen: true, chapters: ['color'] });
  // Another chapter from the closing card, then the end: the map's colors come back.
  await atlas.startOnboarding('settings');
  await atlas.onboardingNext();
  assert.equal(atlas.getState().panels.settings, true);
  await atlas.exitOnboarding();
  assert.equal(atlas.colorMode(), 'type');
  assert.equal(atlas.getState().panels.settings, false);
});

test('a chapter without what it shows is one card that says how to turn it on', async () => {
  const { atlas } = await ready({ storage: memory({ [ONBOARDING_KEY]: '{"seen":1}' }) });
  await atlas.startOnboarding('features');
  const stop = atlas.onboardingStops()[0]!;
  assert.match(atlas.onboardingMissing(stop)!, /codiluce annotate --estimate/);
  await atlas.onboardingNext();
  assert.equal(current(atlas), 'closing:invite');
  await atlas.startOnboarding('people');
  assert.equal(atlas.onboardingStops().length, 1);
  assert.match(atlas.onboardingMissing(atlas.onboardingStops()[0]!)!, /Git history/);
  await atlas.exitOnboarding();
});

test('the address names a tour with ?tour; saved state survives storage that throws or holds nonsense', () => {
  assert.equal(tourParam('?tour'), 'core');
  assert.equal(tourParam('?tour='), 'core');
  assert.equal(tourParam('?tour=people&x=1'), 'people');
  assert.equal(tourParam('?tour=nope'), undefined);
  assert.equal(tourParam('?x=1'), undefined);
  assert.equal(withoutTourParam('?tour=people&x=1'), '?x=1');
  assert.equal(withoutTourParam('?tour'), '');
  const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
  assert.deepEqual(readSaved(broken), { seen: false, chapters: [] });
  writeSaved(broken, { seen: true, chapters: [] });
  assert.deepEqual(readSaved(memory({ [ONBOARDING_KEY]: '{"seen":1,"chapters":["people","bogus"]}' })), { seen: true, chapters: ['people'] });
  assert.deepEqual(readSaved(memory({ [ONBOARDING_KEY]: 'not json' })), { seen: false, chapters: [] });
});
