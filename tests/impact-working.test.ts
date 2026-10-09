// The blast radius as the Impact view asks for it: of the uncommitted changes
// (the files Git reports, without an indexed HEAD), listed by application,
// feature or folder; and the files a highlight lights, as a list.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';
import { indexRepository } from '../src/pipeline/index.js';
import { GraphStore } from '../src/storage/sqlite.js';
import { ProjectionService } from '../src/projection/service.js';
import type { SoftwareGraph } from '../src/core/graph.js';

const fixture = fileURLToPath(new URL('./fixtures/repository', import.meta.url));
const SERVICE = 'backend/app/Services/AuthService.php';
let root: string, graph: SoftwareGraph, store: GraphStore, projection: ProjectionService;
const git = (args: string[]) => execFileSync('git', args, { cwd: root, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: root, GIT_AUTHOR_NAME: 'Ana', GIT_AUTHOR_EMAIL: 'ana@example.test', GIT_COMMITTER_NAME: 'Ana', GIT_COMMITTER_EMAIL: 'ana@example.test' }, encoding: 'utf8' });
before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'atlas-impact-'));
  await cp(fixture, root, { recursive: true });
  await mkdir(path.join(root, '.codiluce'));
  await writeFile(path.join(root, '.codiluce/config.yml'), stringify({ repository: { name: 'fixture' }, applications: [{ name: 'frontend', path: 'frontend', type: 'nextjs' }, { name: 'backend', path: 'backend', type: 'laravel', apiOrigins: ['https://api.fixture.test'], apiOriginEnv: ['NEXT_PUBLIC_API_URL'] }] }));
  await writeFile(path.join(root, '.gitignore'), '.codiluce/\n');
  git(['init', '-q', '-b', 'main']); git(['add', '-A']); git(['commit', '-q', '-m', 'Initial import']);
  // Uncommitted: a change to the auth service, and a new file nothing uses.
  await writeFile(path.join(root, SERVICE), `${await readFile(path.join(root, SERVICE), 'utf8')}\n// checked again\n`);
  await writeFile(path.join(root, 'backend/app/Services/Unused.php'), '<?php\nnamespace App\\Services;\nclass Unused {}\n');
  graph = await indexRepository(root);
  store = new GraphStore(':memory:'); store.save(graph);
  projection = new ProjectionService(store, { root });
});
after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
const id = (name: string, type?: string) => graph.entities.find(entity => entity.name === name && (!type || entity.type === type))!.id;

test('the uncommitted changes seed a blast radius from the files Git reports, when History has no HEAD', async () => {
  const result = await projection.workingImpact({ depth: 6, limit: 500 });
  assert.equal(result.origin.kind, 'working');
  if (result.origin.kind !== 'working') return;
  assert.equal(result.origin.method, 'files');
  assert.equal(result.origin.files, 2, 'the changed service and the new file');
  assert.equal(result.origin.missing, 0);
  assert.ok(result.seeds > 2, 'everything inside the changed files');
  assert.ok(result.items.items.some(item => item.name === 'signIn'), 'the frontend reaches the service through the login endpoint');
  assert.equal(result.distances[id('signIn')], 3);
  // Nothing changed: nothing to start from, and a reason.
  git(['stash', '-u', '-q']);
  try {
    const clean = await projection.workingImpact({});
    assert.equal(clean.total, 0);
    assert.equal(clean.origin.kind === 'working' && clean.origin.reason, 'Git reports no uncommitted changes.');
  } finally { git(['stash', 'pop', '-q']); }
});
test('a blast radius is grouped by application and folder, and a group lists only its own', () => {
  const authenticate = graph.entities.find(entity => entity.metadata.qualifiedName === 'App\\Services\\AuthService::authenticate')!.id;
  const byApp = projection.impact(authenticate, { depth: 6, group: 'app' });
  assert.deepEqual(new Set(byApp.groups!.map(group => group.name)), new Set(['frontend', 'backend']));
  assert.equal(byApp.groups!.reduce((sum, group) => sum + group.count, 0), byApp.total);
  const frontend = byApp.groups!.find(group => group.name === 'frontend')!;
  assert.equal(frontend.distance, 3, 'the nearest hop count in the group');
  const only = projection.impact(authenticate, { depth: 6, group: 'app', groupKey: frontend.key, limit: 500 });
  assert.equal(only.items.total, frontend.count);
  assert.ok(only.items.items.every(item => item.path?.startsWith('frontend/')));
  const byFolder = projection.impact(authenticate, { depth: 6, group: 'folder' });
  assert.ok(byFolder.groups!.some(group => group.name === 'frontend/src/components'));
  assert.equal(byFolder.groups!.reduce((sum, group) => sum + group.count, 0), byFolder.total);
  // Without described features, everything is in "No feature".
  assert.deepEqual(projection.impact(authenticate, { depth: 6, group: 'feature' }).groups!.map(group => group.key), ['none']);
  assert.equal(projection.impact(authenticate, { depth: 6 }).groups, undefined);
});
test('the files a coverage category lights are listed by path', async () => {
  const coverage = projection.coverage();
  const list = await projection.fileList(undefined, { coverage: 'flow' });
  assert.equal(list.files.length, coverage.totals.flow);
  assert.ok(list.files.some(file => file.path === SERVICE));
  assert.deepEqual(list.files.map(file => file.path), [...list.files.map(file => file.path)].sort());
  await assert.rejects(projection.fileList(undefined, {}), /required/);
  await assert.rejects(projection.fileList(undefined, { feature: 'billing' }), /Unknown feature/);
});
