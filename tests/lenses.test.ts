// Measure lenses: files by level of complexity, of changes in the people
// window, and of both (hotspots), on a scripted Git history; functions and
// the classes holding them; areas; a history snapshot; the HTTP route.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { stringify } from 'yaml';
import { createInspectionServer } from '../src/api/server.js';
import { HISTORY_DATABASE, indexHistory } from '../src/history/indexer.js';
import { HistoryAccess } from '../src/history/service.js';
import { HistoryStore } from '../src/history/store.js';
import { indexRepository } from '../src/pipeline/index.js';
import { complexityLevel, rankLevels, type MetricLensResult } from '../src/projection/lenses.js';
import { ProjectionService } from '../src/projection/service.js';
import { GraphStore } from '../src/storage/sqlite.js';

let root: string, state: string, store: GraphStore, projection: ProjectionService;
const commits: string[] = [];
/** A function deciding `count` times: complexity count + 1. */
const decide = (name: string, count: number) => `export function ${name}(value: number) {\n${Array.from({ length: count }, (_, index) => `  if (value === ${index}) return ${index};`).join('\n')}\n  return -1;\n}\n`;

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'codiluce-lenses-'));
  state = await mkdtemp(path.join(tmpdir(), 'codiluce-lenses-state-'));
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: root, GIT_AUTHOR_NAME: 'Ana', GIT_AUTHOR_EMAIL: 'ana@example.test', GIT_COMMITTER_NAME: 'Ana', GIT_COMMITTER_EMAIL: 'ana@example.test' };
  let day = 1;
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, env: { ...env, GIT_AUTHOR_DATE: `2026-01-${String(day).padStart(2, '0')}T10:00:00Z`, GIT_COMMITTER_DATE: `2026-01-${String(day).padStart(2, '0')}T10:00:00Z` }, encoding: 'utf8' }).trim();
  const write = async (file: string, content: string) => { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), content); };
  const commit = (message: string) => { git('add', '-A'); git('commit', '-q', '-m', message); commits.push(git('rev-parse', 'HEAD')); day++; };
  await write('.codiluce/config.yml', stringify({ repository: { name: 'lenses' }, applications: [{ name: 'app', path: '.' }] }));
  await write('src/hot.ts', decide('decide', 21));
  await write('src/mid.ts', `export class Router {\n  route(value: number) {\n${Array.from({ length: 11 }, (_, index) => `    if (value === ${index}) return ${index};`).join('\n')}\n    return -1;\n  }\n}\n`);
  await write('src/calm.ts', 'export function calm() {\n  return 1;\n}\n');
  for (const name of ['a', 'b', 'c']) await write(`src/more/${name}.ts`, `export const ${name} = 1;\n`);
  git('init', '-q', '-b', 'main');
  commit('Start');
  for (let edit = 1; edit <= 4; edit++) { await write('src/hot.ts', `${decide('decide', 21)}// edit ${edit}\n`); commit(`Edit hot ${edit}`); }
  await write('src/mid.ts', `// tuned\n${(await import('node:fs')).readFileSync(path.join(root, 'src/mid.ts'), 'utf8')}`); commit('Tune the router');
  store = new GraphStore(':memory:');
  store.save(await indexRepository(root));
  projection = new ProjectionService(store, { root, stateDirectory: state, history: new HistoryAccess(state).get });
});
after(async () => { store?.close(); await rm(root, { recursive: true, force: true }); await rm(state, { recursive: true, force: true }); });
const id = (name: string, type = 'file') => store.entities({ type }).items.find(entity => (type === 'file' ? entity.path : entity.name) === name)!.id;

test('levels: cyclomatic bands, and changes by the share of files below', () => {
  assert.deepEqual([1, 10, 11, 20, 21, 50, 51].map(complexityLevel), [1, 1, 2, 2, 3, 3, 4]);
  // Ten files changed once, six twice, three five times, one twenty times: half, 80% and 95% of the files are below.
  const counts = [...Array(10).fill(1), ...Array(6).fill(2), ...Array(3).fill(5), 20] as number[];
  const levels = rankLevels(new Map(counts.map((count, index) => [`f${index}`, count])));
  assert.deepEqual(counts.map((_, index) => levels.get(`f${index}`)), [...Array(10).fill(1), ...Array(6).fill(2), ...Array(3).fill(3), 4]);
  // With three files, two thirds are below the most changed: it is in the top half, not the top 20%.
  assert.deepEqual([...rankLevels(new Map([['a', 1], ['b', 2], ['c', 9]])).values()], [1, 1, 2]);
});

test('complexity colors files by their most complex function, and functions by their own', async () => {
  const result = await projection.metricLens(undefined, { lens: 'complexity' });
  assert.equal(result.available, true);
  assert.equal(result.symbols, 'simple');
  assert.equal(result.of[id('src/hot.ts')], 3, 'complexity 22');
  assert.equal(result.of[id('src/mid.ts')], 2, 'complexity 12');
  assert.equal(result.of[id('src/calm.ts')], 1);
  assert.equal(result.of[id('src/more/a.ts')], 1, 'no functions: simple');
  assert.equal(result.of[id('decide', 'function')], 3);
  assert.equal(result.of[id('route', 'method')], 2);
  assert.equal(result.of[id('Router', 'class')], 2, 'a class takes its most complex method');
  assert.equal(result.of[id('calm', 'function')], undefined, 'level 1 functions are left to the client');
  assert.deepEqual(result.levels.map(level => [level.level, level.files, level.min, level.max]), [[1, 4, 0, 1], [2, 1, 12, 12], [3, 1, 22, 22]]);
  assert.deepEqual(result.top.map(item => [item.path, item.level, item.complexity]), [['src/hot.ts', 3, 22], ['src/mid.ts', 2, 12]]);
  const area = result.areas[id('src', 'directory')]!;
  assert.deepEqual(area, { 1: 4, 2: 1, 3: 1 });
});

test('changes compare files changed in the window; hotspots need both', async () => {
  const changes = await projection.metricLens(undefined, { lens: 'changes', window: 'all' });
  assert.equal(changes.symbols, 'inherit');
  assert.equal(changes.window?.commits, 6);
  // Committed once: the four other files and the config; twice: the router; five times: hot.ts.
  assert.equal(changes.of[id('src/hot.ts')], 3);
  assert.equal(changes.of[id('src/mid.ts')], 2);
  assert.equal(changes.of[id('src/calm.ts')], 1);
  assert.deepEqual(changes.top.map(item => [item.path, item.commits]), [['src/hot.ts', 5], ['src/mid.ts', 2]]);
  const hotspots = await projection.metricLens(undefined, { lens: 'hotspots', window: 'all' });
  assert.equal(hotspots.of[id('src/hot.ts')], 3);
  assert.equal(hotspots.of[id('src/mid.ts')], 2);
  assert.equal(hotspots.of[id('src/calm.ts')], 1);
  assert.equal(hotspots.of[id('decide', 'function')], 3);
  await assert.rejects(projection.metricLens(undefined, { lens: 'coverage' }), /lens must be/);
});

test('a history snapshot is colored by what was measured at its commit', async () => {
  await indexHistory({ root, stateDirectory: state, ref: 'main', commits: [commits[0]!], jobs: 1 });
  const history = new HistoryStore(path.join(state, HISTORY_DATABASE), true);
  const snapshot = history.snapshotsByCommit().get(commits[0]!)!;
  const hot = history.fileByPath(snapshot.seq, 'src/hot.ts')!.id, mid = history.fileByPath(snapshot.seq, 'src/mid.ts')!.id;
  history.close();
  const result = await projection.metricLens({ snapshot: snapshot.id }, { lens: 'complexity' });
  assert.equal(result.available, true);
  assert.equal(result.of[hot], 3);
  assert.equal(result.of[mid], 2);
  assert.deepEqual(result.levels.map(level => [level.level, level.files]), [[1, 4], [2, 1], [3, 1]]);
  const changes = await projection.metricLens({ snapshot: snapshot.id }, { lens: 'changes' });
  assert.equal(changes.window?.commits, 1, 'the history up to that commit');
});

test('the lens route answers per view, and says why when there is nothing to color', async () => {
  const server = createInspectionServer(store, { root, stateDirectory: state });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const result = await (await fetch(`http://127.0.0.1:${port}/api/projection/lens?lens=hotspots&window=all`)).json() as MetricLensResult;
    assert.equal(result.of[id('src/hot.ts')], 3);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/projection/lens?lens=nope`)).status, 400);
  } finally { await new Promise(resolve => server.close(resolve)); }
  const bare = new GraphStore(':memory:');
  const plain = await mkdtemp(path.join(tmpdir(), 'codiluce-lenses-plain-'));
  try {
    await writeFile(path.join(plain, 'notes.rb'), 'def hello\n  1\nend\n');
    bare.save(await indexRepository(plain));
    const result = await new ProjectionService(bare, { root: plain }).metricLens(undefined, { lens: 'complexity' });
    assert.equal(result.available, false);
    assert.match(result.reason!, /language code health measures/);
    const changes = await new ProjectionService(bare, { root: plain }).metricLens(undefined, { lens: 'changes' });
    assert.match(changes.reason!, /no Git commit/);
  } finally { bare.close(); await rm(plain, { recursive: true, force: true }); }
});
