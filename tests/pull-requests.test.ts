// Pull requests: merged ones read from a scripted Git history (a squash
// merge, a GitHub merge commit, a merged branch, a pull of a branch's remote
// copy that is none, direct commits that are none), branches not merged yet
// (one squash-merged branch left behind is not open work), the provider's
// open, merged and closed pull requests through a fake GitHub API, what each
// changes on the map, what changes a selection, their blast radius, the routes.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { stringify } from 'yaml';
import { indexRepository } from '../src/pipeline/index.js';
import { GraphStore } from '../src/storage/sqlite.js';
import { ProjectionService } from '../src/projection/service.js';
import { mergedBranch } from '../src/projection/pulls.js';
import { diffChanges, PullSources } from '../src/history/pull-sources.js';
import { createInspectionServer } from '../src/api/server.js';

const fixture = fileURLToPath(new URL('./fixtures/repository', import.meta.url));
const ACCOUNT = 'frontend/src/components/AccountPanel.tsx', LOGIN = 'frontend/src/components/LoginForm.tsx', SERVICE = 'backend/app/Services/AuthService.php', AUDIT = 'backend/app/Services/AuditLog.php', PACKAGE = 'frontend/package.json', NEW_SERVICE = 'backend/app/Services/NewService.php';
let root: string, state: string, store: GraphStore, projection: ProjectionService;
const commits: Record<string, string> = {};

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'atlas-pulls-'));
  state = await mkdtemp(path.join(tmpdir(), 'atlas-pulls-state-'));
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
  const BEN = 'Ben Jones <12345+benj@users.noreply.github.com>';
  git(['init', '-q', '-b', 'main']);
  git(['add', '-A']); git(['commit', '-q', '-m', 'Initial import']); commits.A = head();
  // A squash merge: GitHub's subject convention.
  await append(SERVICE, '// audited\n');
  git(['commit', '-q', '-am', 'Audit the service (#7)'], BEN, '2026-01-10T10:00:00Z'); commits.B = head();
  // A GitHub merge commit: the title is in the body.
  git(['checkout', '-q', '-b', 'feature-login']);
  await append(LOGIN, '// clearer\n');
  git(['commit', '-q', '-am', 'Clearer labels'], 'Ana Lopez <ana@example.test>', '2026-02-01T10:00:00Z'); commits.C1 = head();
  await append(LOGIN, '// and errors\n');
  git(['commit', '-q', '-am', 'Show errors', '-m', 'Co-authored-by: Claude <noreply@anthropic.com>'], 'Ana Lopez <ana@example.test>', '2026-02-02T10:00:00Z'); commits.C2 = head();
  git(['checkout', '-q', 'main']);
  await append(PACKAGE, '\n');
  git(['commit', '-q', '-am', 'Tidy the package'], 'Ana Lopez <ana@example.test>', '2026-02-03T10:00:00Z'); commits.D = head();
  git(['merge', '-q', '--no-ff', 'feature-login', '-m', 'Merge pull request #8 from octo/feature-login', '-m', 'Make the login form clearer'], 'Ben Jones <ben@work.test>', '2026-02-05T10:00:00Z'); commits.M1 = head();
  // A merged branch naming no pull request.
  git(['checkout', '-q', '-b', 'topic']);
  await append(AUDIT, '// topic\n');
  git(['commit', '-q', '-am', 'Audit more'], BEN, '2026-03-01T10:00:00Z'); commits.T1 = head();
  git(['checkout', '-q', 'main']);
  git(['merge', '-q', '--no-ff', 'topic', '-m', "Merge branch 'topic'"], 'Ana Lopez <ana@example.test>', '2026-03-02T10:00:00Z'); commits.M2 = head();
  // A pull of the branch's remote copy: no pull request.
  git(['checkout', '-q', '-b', 'remote-main']);
  await append(AUDIT, '// pushed elsewhere\n');
  git(['commit', '-q', '-am', 'Pushed from another machine'], BEN, '2026-03-03T10:00:00Z'); commits.R1 = head();
  git(['checkout', '-q', 'main']);
  await append(SERVICE, '// local\n');
  git(['commit', '-q', '-am', 'Local change'], 'Ana Lopez <ana@example.test>', '2026-03-04T10:00:00Z'); commits.E = head();
  git(['merge', '-q', '--no-ff', 'remote-main', '-m', "Merge branch 'main' of github.com:octo/fixture"], 'Ana Lopez <ana@example.test>', '2026-03-05T10:00:00Z'); commits.M3 = head();
  // A GitHub merge commit with no body: its subject names it.
  git(['checkout', '-q', '-b', 'no-body']);
  await append(ACCOUNT, '// tidy\n');
  git(['commit', '-q', '-am', 'Tidy the account panel'], 'Ana Lopez <ana@example.test>', '2026-03-05T11:00:00Z'); commits.N1 = head();
  git(['checkout', '-q', 'main']);
  git(['merge', '-q', '--no-ff', 'no-body', '-m', 'Merge pull request #10 from octo/no-body'], 'Ana Lopez <ana@example.test>', '2026-03-05T12:00:00Z'); commits.M4 = head();
  git(['branch', '-q', '-D', 'remote-main', 'topic', 'feature-login', 'no-body']);
  // A branch squash-merged by hand: its content is in main, its commit is not.
  git(['checkout', '-q', '-b', 'old-fix']);
  await append(PACKAGE, '// fixed\n');
  git(['commit', '-q', '-am', 'Fix the package'], BEN, '2026-03-06T10:00:00Z'); commits.O1 = head();
  git(['checkout', '-q', 'main']);
  await append(PACKAGE, '// fixed\n');
  git(['commit', '-q', '-am', 'Fix the package (#9)'], BEN, '2026-03-07T10:00:00Z'); commits.S9 = head();
  await append(SERVICE, '// tidy\n');
  git(['commit', '-q', '-am', 'Tidy the service'], 'Ana Lopez <ana@example.test>', '2026-03-10T10:00:00Z'); commits.F = head();
  // Open work: a branch with a remote-tracking copy, adding a file.
  git(['checkout', '-q', '-b', 'wip']);
  await append(SERVICE, '// wip\n');
  await writeFile(path.join(root, NEW_SERVICE), '<?php\nclass NewService {}\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'Start the new service'], BEN, '2026-03-12T10:00:00Z'); commits.W1 = head();
  git(['update-ref', 'refs/remotes/origin/wip', commits.W1!]);
  git(['checkout', '-q', 'main']);
  git(['update-ref', 'refs/remotes/origin/main', commits.F!]);
  await rm(path.join(root, NEW_SERVICE), { force: true });
  store = new GraphStore(':memory:');
  store.save(await indexRepository(root));
  projection = new ProjectionService(store, { root, stateDirectory: state });
});
after(async () => { store?.close(); await rm(root, { recursive: true, force: true }); await rm(state, { recursive: true, force: true }); });
const fileId = (filePath: string) => store.entities({ path: filePath, type: 'file' }).items[0]!.id;

test('merged pull requests come from the first-parent line: squash and merge conventions, merged branches, no pulls of a remote copy', async () => {
  assert.deepEqual(mergedBranch("Merge branch 'main' of github.com:o/r", 'main'), undefined);
  assert.deepEqual(mergedBranch("Merge branch 'master' of github.com:o/r", 'main'), undefined, 'a renamed default branch pulled from its remote');
  assert.deepEqual(mergedBranch("Merge remote-tracking branch 'origin/main'", 'main'), undefined);
  assert.deepEqual(mergedBranch("Merge branch 'feature/x' into main", 'main'), { name: 'feature/x', title: 'feature/x' });
  assert.deepEqual(mergedBranch("Merge remote-tracking branch 'origin/fix'", 'main'), { name: 'fix', title: 'fix' });
  const result = await projection.pulls(undefined, { window: 'all' });
  assert.equal(result.available, true);
  assert.equal(result.provider.status, 'off');
  assert.equal(result.base?.ref, 'main');
  assert.deepEqual(result.merged.map(pull => [pull.id, pull.source, pull.title]), [
    ['pr-9', 'squash-message', 'Fix the package'],
    ['pr-10', 'merge-message', 'Merge pull request #10 from octo/no-body'],
    [`merge-${commits.M2!.slice(0, 12)}`, 'merge', 'topic'],
    ['pr-8', 'merge-message', 'Make the login form clearer'],
    ['pr-7', 'squash-message', 'Audit the service'],
  ], 'newest first; direct commits and the pull of a remote copy are not pull requests');
  assert.equal(result.mergedTotal, 5);
  const pr8 = result.merged.find(pull => pull.id === 'pr-8')!;
  assert.equal(pr8.commit, commits.M1);
  assert.equal(pr8.headRef, 'octo/feature-login');
  assert.equal(pr8.commits, 2, 'the commits of the branch it merged');
  assert.deepEqual([pr8.files, pr8.added, pr8.deleted, pr8.inView], [1, 2, 0, 1]);
  assert.equal(pr8.author?.name, 'Ana Lopez', 'the author of its commits, not who merged it');
  const pr7 = result.merged.find(pull => pull.id === 'pr-7')!;
  assert.deepEqual([pr7.files, pr7.commits, pr7.author?.name], [1, 1, 'Ben Jones']);
  // Searching: by number, title words, branch or author.
  assert.deepEqual((await projection.pulls(undefined, { query: '#8' })).merged.map(pull => pull.id), ['pr-8']);
  assert.deepEqual((await projection.pulls(undefined, { query: 'ben audit' })).merged.map(pull => pull.id), ['pr-7']);
  assert.deepEqual((await projection.pulls(undefined, { query: 'ben' })).merged.map(pull => pull.id), ['pr-9', `merge-${commits.M2!.slice(0, 12)}`, 'pr-7']);
});

test('windows: by when they were merged, up to the commit shown', async () => {
  // 30 days up to F (Mar 10): #9, #10, the topic merge (Mar 2), not #8 (Feb 5).
  const recent = await projection.pulls(undefined, { window: '30d' });
  assert.deepEqual(recent.merged.map(pull => pull.id), ['pr-9', 'pr-10', `merge-${commits.M2!.slice(0, 12)}`]);
  assert.equal(recent.window?.key, '30d');
});

test('open work: branches not merged, one entry per head, a squash-merged branch left out', async () => {
  const result = await projection.pulls(undefined, {});
  assert.deepEqual(result.open.map(pull => [pull.id, pull.source, pull.state]), [['branch:wip', 'branch', 'open']], 'old-fix is in main by content; origin/main is the base');
  const wip = result.open[0]!;
  assert.equal(wip.commit, commits.W1);
  assert.deepEqual([wip.files, wip.inView, wip.commits, wip.author?.name, wip.baseRef], [2, 1, 1, 'Ben Jones', 'main']);
  const detail = await projection.pull('branch:wip');
  assert.deepEqual(Object.keys(detail.files), [fileId(SERVICE)]);
  assert.equal(detail.files[fileId(SERVICE)]!.status, 'modified');
  assert.deepEqual(detail.outside, [{ path: NEW_SERVICE, added: 2, deleted: 0, status: 'added' }], 'a file it adds is not on the map yet');
  assert.equal(detail.outsideTotal, 1);
  assert.deepEqual(detail.shas, [commits.W1!.slice(0, 12)]);
});

test('one pull request on the map: files, areas, folders, entry points, commits and people', async () => {
  const detail = await projection.pull('pr-8');
  assert.deepEqual(Object.keys(detail.files), [fileId(LOGIN)]);
  assert.deepEqual(detail.files[fileId(LOGIN)], { added: 2, deleted: 0 });
  const rootId = store.entities({ type: 'repository' }).items[0]!.id;
  assert.equal(detail.areas[rootId], 1);
  assert.deepEqual(detail.folders.map(folder => [folder.path, folder.files, folder.lines]), [['frontend/src/components', 1, 2]]);
  assert.deepEqual(detail.commits.map(commit => commit.sha), [commits.C2, commits.C1]);
  assert.deepEqual(detail.people.map(person => [person.name, person.kind, person.commits]), [['Ana Lopez', 'human', 2], ['Claude', 'agent', 1]]);
  assert.equal(detail.outsideTotal, 0);
  await assert.rejects(projection.pull('pr-404'), /Unknown pull request/);
  const files = await projection.fileList(undefined, { pull: 'pr-8' });
  assert.equal(files.title, '#8 Make the login form clearer');
  assert.deepEqual(files.files.map(file => file.path), [LOGIN]);
});

test('a selection: the open work changing it and the latest merged', async () => {
  const service = await projection.entityPulls(fileId(SERVICE));
  assert.equal(service.scope, 'file');
  assert.deepEqual(service.open.map(pull => [pull.id, pull.here.files, pull.here.added]), [['branch:wip', 1, 1]]);
  assert.deepEqual(service.merged.map(pull => pull.id), ['pr-7']);
  const login = await projection.entityPulls(fileId(LOGIN));
  assert.deepEqual(login.open, []);
  assert.deepEqual(login.merged.map(pull => pull.id), ['pr-8']);
  const backend = store.entities({ type: 'application' }).items.find(item => item.name === 'backend')!.id;
  const area = await projection.entityPulls(backend);
  assert.equal(area.scope, 'area');
  assert.deepEqual(area.merged.map(pull => pull.id), [`merge-${commits.M2!.slice(0, 12)}`, 'pr-7']);
});

test('the blast radius of a pull request starts from the code of its files on the map', async () => {
  const impact = await projection.pullImpact('pr-8', undefined, {});
  assert.equal(impact.origin.kind, 'pull');
  assert.deepEqual(impact.origin.kind === 'pull' ? [impact.origin.id, impact.origin.files, impact.origin.missing, impact.origin.state] : [], ['pr-8', 1, 0, 'merged']);
  assert.ok(impact.seeds > 0);
  const open = await projection.pullImpact('branch:wip', undefined, {});
  assert.deepEqual(open.origin.kind === 'pull' ? [open.origin.files, open.origin.missing] : [], [1, 1]);
});

test('the net change of a commit range: status, renames, lines', async () => {
  const changes = await diffChanges(root, commits.F!, commits.W1!);
  assert.deepEqual(changes.map(change => [change.path, change.status, change.added, change.deleted]), [[SERVICE, 'modified', 1, 0], [NEW_SERVICE, 'added', 2, 0]]);
});

test('the provider: open, merged and closed pull requests, files of one whose commits are not here', async () => {
  execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:octo/fixture.git'], { cwd: root });
  const requested: string[] = [];
  const pull = (number: number, extra: Record<string, unknown>) => ({ number, title: `Pull ${number}`, html_url: `https://github.com/octo/fixture/pull/${number}`, user: { login: 'benj' }, state: 'open', draft: false, created_at: '2026-03-11T10:00:00Z', updated_at: '2026-03-12T10:00:00Z', closed_at: null, merged_at: null, merge_commit_sha: null, base: { ref: 'main' }, ...extra });
  const fetcher = async (url: string) => {
    requested.push(url);
    const json = url.includes('/pulls/13/files') ? [{ filename: LOGIN, status: 'modified', additions: 3, deletions: 1 }, { filename: 'frontend/src/new.ts', status: 'added', additions: 5, deletions: 0 }]
      : url.includes('state=open') ? [pull(12, { head: { ref: 'wip', sha: commits.W1 } }), pull(13, { title: 'From a fork', draft: true, updated_at: '2026-03-13T10:00:00Z', user: { login: 'someone' }, head: { ref: 'patch-1', sha: 'a'.repeat(40) } })]
      : url.includes('state=closed') ? [pull(8, { title: 'Make the login form clearer (GitHub)', state: 'closed', closed_at: '2026-02-05T10:00:00Z', merged_at: '2026-02-05T10:00:00Z', merge_commit_sha: commits.M1, head: { ref: 'feature-login', sha: commits.C2 } }), pull(11, { title: 'Abandoned', state: 'closed', closed_at: '2026-03-01T10:00:00Z', head: { ref: 'gone', sha: 'b'.repeat(40) } })]
      : [];
    return { ok: true, status: 200, json: async () => json };
  };
  const service = new ProjectionService(store, { root, stateDirectory: state, pullSources: new PullSources(root, { provider: 'github', token: 't', fetcher }) });
  const result = await service.pulls(undefined, {});
  assert.deepEqual(result.provider, { name: 'github', status: 'ok', token: true, repository: 'octo/fixture', fetchedAt: result.provider.fetchedAt });
  assert.deepEqual(result.open.map(item => [item.id, item.source, item.draft ?? false]), [['pr-13', 'github', true], ['pr-12', 'github', false]], 'the wip branch is pull request #12');
  const twelve = result.open.find(item => item.id === 'pr-12')!;
  assert.deepEqual([twelve.files, twelve.commits, twelve.author?.name, twelve.author?.login], [2, 1, 'Ben Jones', 'benj'], 'its commits are here: read from Git; the login is matched to the person by their no-reply address');
  const thirteen = result.open.find(item => item.id === 'pr-13')!;
  assert.deepEqual([thirteen.files, thirteen.inView, thirteen.commits, thirteen.author?.name], [2, 1, 0, 'someone'], 'its files were asked for (a token is set)');
  assert.ok(requested.some(url => url.endsWith('/repos/octo/fixture/pulls/13/files?per_page=100&page=1')));
  assert.ok(!requested.some(url => url.includes('/pulls/12/files')), 'never asked: its head commit is here');
  const pr8 = result.merged.find(item => item.id === 'pr-8')!;
  assert.deepEqual([pr8.source, pr8.title, pr8.url, pr8.author?.login], ['github', 'Make the login form clearer (GitHub)', 'https://github.com/octo/fixture/pull/8', 'benj'], 'the provider record wins over the message');
  assert.deepEqual(result.closed.map(item => [item.id, item.state, item.files]), [['pr-11', 'closed', undefined]], 'files unknown until selected');
  const detail = await service.pull('pr-13');
  assert.deepEqual(Object.keys(detail.files), [fileId(LOGIN)]);
  assert.deepEqual(detail.outside.map(file => [file.path, file.status]), [['frontend/src/new.ts', 'added']]);
  // A closed pull request: the provider is asked for its files when selected, and says it cannot.
  const closed = await service.pull('pr-11');
  assert.equal(closed.unknownReason, undefined, 'the fake API answers with no files');
  assert.deepEqual(closed.files, {});
  // A provider that fails to list a pull request's files is not asked again at once.
  let asked = 0;
  const failing = new PullSources(root, { provider: 'github', token: 't', fetcher: async url => { if (url.includes('/files')) { asked++; return { ok: false, status: 502, json: async () => ({}) }; } return fetcher(url); } });
  const flaky = new ProjectionService(store, { root, stateDirectory: state, pullSources: failing });
  await flaky.pulls(undefined, {});
  await flaky.pulls(undefined, {});
  assert.equal(asked, 1, 'the open pull request whose commits are not here was asked for once');
  assert.match((await flaky.pull('pr-13')).unknownReason ?? '', /GitHub did not list its files: GitHub API responded 502/);
  assert.equal(asked, 1);
  // Without a provider record, the same commits are read from the messages again.
  assert.equal((await projection.pulls(undefined, {})).merged.find(item => item.id === 'pr-8')!.source, 'merge-message');
});

test('routes: list, one pull request, a selection, its blast radius, its files', async () => {
  const server = createInspectionServer(store, { root, stateDirectory: state });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const get = async (url: string) => { const response = await fetch(`http://127.0.0.1:${port}${url}`); return { status: response.status, body: await response.json() as Record<string, unknown> }; };
  try {
    const list = await get('/api/pulls?window=all');
    assert.equal(list.status, 200);
    assert.equal((list.body.merged as unknown[]).length, 5);
    assert.equal((await get('/api/pulls/item/pr-8')).status, 200);
    assert.equal((await get(`/api/pulls/item/${encodeURIComponent('branch:wip')}`)).status, 200);
    assert.equal((await get('/api/pulls/item/pr-404')).status, 404);
    assert.equal((await get(`/api/pulls/entity/${encodeURIComponent(fileId(SERVICE))}`)).status, 200);
    const impact = await get('/api/projection/impact-pull?pull=pr-8&depth=2');
    assert.equal(impact.status, 200);
    assert.equal((impact.body.origin as { kind: string }).kind, 'pull');
    assert.equal((await get('/api/projection/impact-pull')).status, 400);
    const files = await get('/api/projection/files?pull=pr-8');
    assert.deepEqual((files.body.files as { path: string }[]).map(file => file.path), [LOGIN]);
  } finally { server.close(); }
});
