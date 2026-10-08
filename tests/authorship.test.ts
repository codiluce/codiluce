// Authorship: who changed which code, read from a scripted Git history with
// several people, a co-author trailer, an agent, a bot on a merged branch and
// a rename; people merged by address and full name; windows; the per-file,
// per-area, per-person and per-entity figures; the HTTP routes.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { stringify } from 'yaml';
import { indexRepository } from '../src/pipeline/index.js';
import { GraphStore } from '../src/storage/sqlite.js';
import { ProjectionService } from '../src/projection/service.js';
import { ProjectionIndex } from '../src/projection/hierarchy.js';
import { computeAuthorship } from '../src/projection/authorship.js';
import { AuthorHistory, kindOf, readAuthorLog, resolvePeople } from '../src/history/authors.js';
import { createInspectionServer } from '../src/api/server.js';

const fixture = fileURLToPath(new URL('./fixtures/repository', import.meta.url));
const LOGIN = 'frontend/src/components/auth/LoginForm.tsx', OLD_LOGIN = 'frontend/src/components/LoginForm.tsx', SERVICE = 'backend/app/Services/AuthService.php', PACKAGE = 'frontend/package.json';
let root: string, state: string, store: GraphStore, projection: ProjectionService;
const commits: Record<string, string> = {};

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'atlas-authors-'));
  state = await mkdtemp(path.join(tmpdir(), 'atlas-authors-state-'));
  await cp(fixture, root, { recursive: true });
  await mkdir(path.join(root, '.codiluce'));
  await writeFile(path.join(root, '.codiluce/config.yml'), stringify({ repository: { name: 'fixture' }, applications: [{ name: 'frontend', path: 'frontend', type: 'nextjs' }, { name: 'backend', path: 'backend', type: 'laravel' }] }));
  const base = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: root, GIT_COMMITTER_NAME: 'Committer', GIT_COMMITTER_EMAIL: 'committer@example.test' };
  const git = (args: string[], author = 'Ana Lopez <ana@example.test>', date = '2025-01-01T10:00:00Z') => {
    const [name, email] = [author.split(' <')[0]!, author.split('<')[1]!.slice(0, -1)];
    return execFileSync('git', args, { cwd: root, env: { ...base, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }, encoding: 'utf8' }).trim();
  };
  const head = () => git(['rev-parse', 'HEAD']);
  const append = async (file: string, text: string) => writeFile(path.join(root, file), `${await readFile(path.join(root, file), 'utf8')}${text}`);
  git(['init', '-q', '-b', 'main']);
  git(['add', '-A']); git(['commit', '-q', '-m', 'Initial import']); commits.A = head();
  await append(OLD_LOGIN, '// checked\n'); await append(SERVICE, '// audited\n');
  git(['commit', '-q', '-am', 'Check the login'], 'Ben Jones <ben@work.test>', '2025-06-01T10:00:00Z'); commits.B = head();
  await append(SERVICE, '// again\n// and again\n');
  // The same person from another address; Ana from an upper-case one.
  git(['commit', '-q', '-am', 'Audit again'], 'Ben  Jones <ben@home.test>', '2026-01-10T10:00:00Z'); commits.C = head();
  await mkdir(path.join(root, 'frontend/src/components/auth'));
  git(['mv', OLD_LOGIN, LOGIN]);
  await append(LOGIN, '// moved\n');
  await writeFile(path.join(root, 'frontend/src/components/index.ts'), (await readFile(path.join(root, 'frontend/src/components/index.ts'), 'utf8')).replace("'./LoginForm'", "'./auth/LoginForm'"));
  git(['commit', '-q', '-am', 'Move the login form', '-m', 'Co-authored-by: Claude <noreply@anthropic.com>'], 'Ana Lopez <ANA@example.test>', '2026-03-01T10:00:00Z'); commits.D = head();
  git(['checkout', '-q', '-b', 'deps']);
  await append(PACKAGE, '\n');
  git(['commit', '-q', '-am', 'Bump dependencies'], 'dependabot[bot] <49699333+dependabot[bot]@users.noreply.github.com>', '2026-03-05T10:00:00Z'); commits.E = head();
  git(['checkout', '-q', 'main']);
  git(['merge', '-q', '--no-ff', 'deps', '-m', 'Merge dependencies'], 'Ana Lopez <ana@example.test>', '2026-03-06T10:00:00Z'); commits.M = head();
  await append(SERVICE, '// by aider\n');
  git(['commit', '-q', '-am', 'Tidy the service'], 'Ana Lopez (aider) <ana@example.test>', '2026-03-10T10:00:00Z'); commits.F = head();
  store = new GraphStore(':memory:');
  store.save(await indexRepository(root));
  projection = new ProjectionService(store, { root, stateDirectory: state });
});
after(async () => { store?.close(); await rm(root, { recursive: true, force: true }); await rm(state, { recursive: true, force: true }); });
const fileId = (filePath: string) => store.entities({ path: filePath, type: 'file' }).items[0]!.id;

test('people are told apart by kind and merged by address and full name', async () => {
  assert.equal(kindOf({ name: 'Claude', email: 'noreply@anthropic.com' }), 'agent');
  assert.equal(kindOf({ name: 'Copilot', email: '198982749+Copilot@users.noreply.github.com' }), 'agent');
  assert.equal(kindOf({ name: 'Ana Lopez (aider)', email: 'ana@example.test' }), 'agent');
  assert.equal(kindOf({ name: 'renovate[bot]', email: '29139614+renovate[bot]@users.noreply.github.com' }), 'bot');
  assert.equal(kindOf({ name: 'Ana Lopez', email: 'ana@example.test' }), 'human');
  const log = await readAuthorLog(root, commits.F!);
  assert.equal(log.commits.length, 7, 'every commit, the merge included (for ancestry)');
  assert.deepEqual(log.commits.map(commit => commit.sha), [commits.F, commits.M, commits.E, commits.D, commits.C, commits.B, commits.A], 'newest first, children before parents');
  assert.equal(log.truncated, false);
  const history = new AuthorHistory(log);
  const people = new Map(history.people.map(person => [person.name, person]));
  assert.deepEqual([...people.keys()].sort(), ['Ana Lopez', 'Ana Lopez (aider)', 'Ben Jones', 'Claude', 'dependabot[bot]']);
  assert.deepEqual(people.get('Ana Lopez')!.emails, ['ANA@example.test', 'ana@example.test'], 'addresses compare without case');
  assert.deepEqual(people.get('Ben Jones')!.emails, ['ben@home.test', 'ben@work.test'], 'a full name joins two addresses');
  assert.equal(people.get('Ana Lopez (aider)')!.kind, 'agent', 'an agent committing under a human address stays apart from the human');
  assert.equal(people.get('Claude')!.kind, 'agent');
  assert.equal(people.get('dependabot[bot]')!.kind, 'bot');
  assert.deepEqual(['Ana Lopez', 'Ben Jones', 'Claude', 'dependabot[bot]', 'Ana Lopez (aider)'].map(name => people.get(name)!.order), [0, 1, 2, 3, 4], 'ordered by first commit');
  // Keys do not depend on which name is shown, and two one-word names never merge.
  const again = resolvePeople([{ name: 'Ana', email: 'a@x.test' }, { name: 'Ana', email: 'b@x.test' }]);
  assert.equal(again.people.length, 2);
});

test('the history is folded onto a commit: renames followed, merges left out', async () => {
  const history = new AuthorHistory(await readAuthorLog(root, commits.F!));
  const folded = history.fold(commits.F!)!;
  assert.deepEqual(folded.commits.map(commit => commit.sha), [commits.F, commits.E, commits.D, commits.C, commits.B, commits.A]);
  const checked = folded.commits.find(commit => commit.sha === commits.B)!;
  assert.ok(checked.changes.some(change => change.path === LOGIN), 'a change made before the rename counts for the file under its current path');
  assert.ok(!folded.commits.some(commit => commit.changes.some(change => change.path === OLD_LOGIN)));
  // Seen from before the rename, the file keeps its path of the time.
  const before = history.fold(commits.C!)!;
  assert.deepEqual(before.commits.map(commit => commit.sha), [commits.C, commits.B, commits.A]);
  assert.ok(before.commits.find(commit => commit.sha === commits.B)!.changes.some(change => change.path === OLD_LOGIN));
  assert.equal(before.until, '2026-01-10T10:00:00+00:00');
});

test('a view says who changed each file most, per area, in a window ending at its commit', async () => {
  const all = await projection.authorship(undefined, { window: 'all' });
  assert.equal(all.available, true);
  assert.equal(all.window!.anchor, commits.F);
  assert.equal(all.window!.commits, 6);
  assert.deepEqual(all.people.map(person => [person.name, person.commits, person.coauthored]), [['Ana Lopez', 2, 0], ['Ben Jones', 2, 0], ['Claude', 1, 1], ['Ana Lopez (aider)', 1, 0], ['dependabot[bot]', 1, 0]]);
  const ana = all.people.find(person => person.name === 'Ana Lopez')!, ben = all.people.find(person => person.name === 'Ben Jones')!;
  assert.equal(all.of[fileId(LOGIN)], ana.key, 'Ana wrote most of the login form (initial import and the move)');
  assert.equal(all.of[fileId(SERVICE)], ana.key);
  assert.equal(all.unchanged, 0, 'every file was in the initial import');
  const rootId = store.entities({ type: 'repository' }).items[0]!.id;
  const files = Number(store.db.prepare("SELECT count(*) AS count FROM entities WHERE type = 'file'").get()!.count);
  assert.equal(Object.values(all.areas[rootId]!).reduce((sum, count) => sum + count, 0), files, 'every file of the view is counted in the root area');
  // 90 days up to F (Mar 10, 2026): C, D, E and F.
  const recent = await projection.authorship(undefined, { window: '90d' });
  assert.equal(recent.window!.since, '2025-12-10T10:00:00.000Z');
  assert.equal(recent.window!.commits, 4);
  assert.equal(recent.people.find(person => person.key === ben.key)!.commits, 1, 'Ben\'s earlier commit is outside the window');
  assert.equal(recent.of[fileId(SERVICE)], ben.key, 'in the window, the service was changed most by Ben (two lines; aider one)');
  assert.equal(recent.of[fileId('backend/routes/api.php')], undefined, 'a file nobody changed in the window has nobody');
  assert.ok(recent.unchanged > 0);
  assert.equal(recent.areas[rootId]!.none, recent.unchanged);
  await assert.rejects(projection.authorship(undefined, { window: 'range' }), /comparison/);
  await assert.rejects(projection.authorship(undefined, { window: 'week' }), /window must be/);
  // The live index's history is kept in the state directory for the next start.
  assert.ok((await stat(path.join(state, 'authors.json'))).size > 0);
  const restarted = new ProjectionService(store, { root: '/nonexistent', stateDirectory: state });
  assert.equal((await restarted.authorship()).people.length, 5, 'read back from the state directory, without Git');
});

test('an entity: its people with their part and its latest commits; a symbol stands for its file, an area for its files', async () => {
  const people = new Map((await projection.authorship()).people.map(person => [person.name, person.key]));
  const login = await projection.entityAuthorship(fileId(LOGIN));
  assert.equal(login.scope, 'file');
  assert.equal(login.commits, 3, 'the import, Ben\'s check before the move, and the move');
  assert.deepEqual(login.recent.map(commit => commit.sha), [commits.D, commits.B, commits.A]);
  assert.deepEqual(login.recent[0]!.people, [people.get('Ana Lopez'), people.get('Claude')], 'author first, then co-authors');
  const claude = login.people.find(person => person.name === 'Claude')!;
  assert.equal(claude.commits, 1);
  assert.ok(claude.share > 0 && claude.share < 1);
  assert.ok(login.people.reduce((sum, person) => sum + person.share, 0) > 1, 'co-authors share commits, so parts can add up to more than all');
  const symbol = store.entities({ path: LOGIN, limit: 100 }).items.find(item => item.type !== 'file')!;
  const viaFile = await projection.entityAuthorship(symbol.id);
  assert.equal(viaFile.scope, 'symbol');
  assert.equal(viaFile.file?.path, LOGIN);
  assert.equal(viaFile.commits, 3);
  const backend = store.entities({ type: 'application' }).items.find(item => item.name === 'backend')!;
  const area = await projection.entityAuthorship(backend.id, undefined, { window: '90d' });
  assert.equal(area.scope, 'area');
  assert.equal(area.changedFiles, 1);
  assert.deepEqual(area.people.map(person => person.name), ['Ben Jones', 'Ana Lopez (aider)']);
  assert.ok(area.files > 1);
});

test('a person: the files they changed, the areas and folders holding them, their commits', async () => {
  const claude = (await projection.authorship()).people.find(person => person.name === 'Claude')!;
  const detail = await projection.personAuthorship(claude.key);
  assert.deepEqual(Object.keys(detail.files).sort(), [fileId(LOGIN), fileId('frontend/src/components/index.ts')].sort());
  assert.deepEqual(detail.commits.map(commit => commit.sha), [commits.D]);
  assert.deepEqual(detail.shas, [commits.D!.slice(0, 12)]);
  assert.deepEqual(detail.folders.map(folder => folder.path).sort(), ['frontend/src/components', 'frontend/src/components/auth']);
  const frontend = store.entities({ type: 'application' }).items.find(item => item.name === 'frontend')!;
  assert.equal(detail.areas[frontend.id], 2);
  const ben = (await projection.authorship()).people.find(person => person.name === 'Ben Jones')!;
  await assert.rejects(projection.personAuthorship(ben.key, undefined, { window: '30d' }), /No commits/, 'Ben did not commit in the 30 days before F');
});

test('the range window keeps the commits a baseline did not have', async () => {
  const history = new AuthorHistory(await readAuthorLog(root, commits.F!));
  const index = new ProjectionIndex('run', [
    { id: 'repo', type: 'repository', name: 'fixture' },
    { id: 'login', type: 'file', name: 'LoginForm.tsx', path: LOGIN, parentId: 'repo' },
    { id: 'service', type: 'file', name: 'AuthService.php', path: SERVICE, parentId: 'repo' },
    { id: 'package', type: 'file', name: 'package.json', path: PACKAGE, parentId: 'repo' },
  ], [], []);
  const range = computeAuthorship(history, history.fold(commits.F!)!, index, { window: 'range', baseline: commits.C! });
  assert.deepEqual(range.commits.map(commit => commit.sha), [commits.F, commits.E, commits.D], 'the branch commit merged after C counts; C and older do not');
  assert.equal(range.window.baseline, commits.C);
  assert.deepEqual([...range.files.keys()].sort(), ['login', 'package', 'service']);
});

test('without Git history, authorship says why; the HTTP routes answer', async () => {
  const plain = new ProjectionService(store, {});
  const none = await plain.authorship();
  assert.equal(none.available, false);
  assert.match(none.reason!, /does not know where the repository is/);
  assert.equal((await plain.entityAuthorship(fileId(LOGIN))).available, false);
  const server = createInspectionServer(store, { root, stateDirectory: state });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const result = await (await fetch(`${base}/api/authorship?window=90d`)).json() as { window: { key: string }; people: { key: string }[] };
    assert.equal(result.window.key, '90d');
    const person = await fetch(`${base}/api/authorship/person/${result.people[0]!.key}?window=90d`);
    assert.equal(person.status, 200);
    const entity = await (await fetch(`${base}/api/authorship/entity/${encodeURIComponent(fileId(LOGIN))}`)).json() as { commits: number };
    assert.equal(entity.commits, 3);
    assert.equal((await fetch(`${base}/api/authorship?window=week`)).status, 400);
    assert.equal((await fetch(`${base}/api/authorship/person/nobody`)).status, 404);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
