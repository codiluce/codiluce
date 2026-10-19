// The onboarding tour's thread: the flow and the file it follows, with and
// without Git history, and the counts of the welcome card.
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
import { pickFile, threadFlow, type ThreadFlow } from '../src/projection/onboarding.js';
import type { FlowSummary } from '../src/projection/dto.js';

const fixture = fileURLToPath(new URL('./fixtures/repository', import.meta.url));
const roots: string[] = [];
async function indexed(withGit: (root: string) => Promise<void> = async () => {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'atlas-onboarding-'));
  roots.push(root);
  await cp(fixture, root, { recursive: true });
  await mkdir(path.join(root, '.codiluce'));
  await writeFile(path.join(root, '.codiluce/config.yml'), stringify({ repository: { name: 'fixture' }, applications: [{ name: 'frontend', path: 'frontend', type: 'nextjs' }, { name: 'backend', path: 'backend', type: 'laravel', apiOrigins: ['https://api.fixture.test'], apiOriginEnv: ['NEXT_PUBLIC_API_URL'] }] }));
  await withGit(root);
  const store = new GraphStore(':memory:');
  store.save(await indexRepository(root));
  const projection = new ProjectionService(store, { root, stateDirectory: path.join(root, '.codiluce') });
  await projection.prepare({});
  return { root, store, projection };
}
after(async () => { for (const root of roots) await rm(root, { recursive: true, force: true }); });

let plain: Awaited<ReturnType<typeof indexed>>;
before(async () => { plain = await indexed(); });

test('without history the thread follows the most complete flow and its handler', async () => {
  const result = await plain.projection.onboarding({});
  assert.equal(result.repository, 'fixture');
  assert.equal(result.counts.files, 48);
  assert.equal(result.counts.commits, undefined);
  assert.ok(result.counts.flows > 0);
  assert.deepEqual(result.available, { history: false, historyReason: 'History is not served for this repository', people: false, peopleReason: result.available.peopleReason, features: 0 });
  // The most complete request flow that reaches a table, by files touched; then the file its endpoint hands the work to.
  assert.equal(result.thread.flow?.name, 'POST /admin/rebuild');
  assert.equal(result.thread.flow?.status, 'complete');
  assert.equal(result.thread.file?.path, 'backend/app/Http/Controllers/AdminController.php');
  assert.ok(result.thread.file!.dependents >= 1);
  assert.equal(result.thread.folder?.name, 'backend');
  assert.ok(result.thread.impact!.total > 0 && result.thread.impact!.hops > 0);
  assert.equal(result.thread.history, undefined);
  // The timeline the History service reports says why there is no history.
  const timeline = { available: false, reason: 'No readable Git history', firstParent: true, entries: [], indexing: { enabled: false, queued: [], failed: [] } };
  assert.equal((await plain.projection.onboarding({}, timeline)).available.historyReason, 'No readable Git history');
});

test('with history the thread prefers a file of the flow that changed', async () => {
  const links = plain.projection.linkContext({});
  const flow = links.flows.find(item => item.summary.name === 'POST /admin/rebuild')!;
  // A file of the flow other than the handler, changed twice after the first commit.
  const other = [...new Set([...flow.members].map(id => links.fileOf(id)).filter(Boolean))].map(id => links.index.node(id!)!.path!).sort().find(file => !file.endsWith('AdminController.php') && file.endsWith('.php'))!;
  const { projection } = await indexed(async root => {
    const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: root, GIT_AUTHOR_NAME: 'Ana Lopez', GIT_AUTHOR_EMAIL: 'ana@example.test', GIT_COMMITTER_NAME: 'Ana Lopez', GIT_COMMITTER_EMAIL: 'ana@example.test' };
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, env, encoding: 'utf8' });
    git('init', '-q', '-b', 'main'); git('add', '-A'); git('commit', '-q', '-m', 'Initial import');
    for (const note of ['first', 'second']) { await writeFile(path.join(root, other), `${await readFile(path.join(root, other), 'utf8')}// ${note}\n`); git('commit', '-q', '-am', `Touch ${note}`); }
  });
  const timeline = { available: true, firstParent: true, entries: [{}, {}, {}], indexing: { enabled: false, queued: [], failed: [] } } as unknown as Parameters<typeof projection.onboarding>[1];
  const result = await projection.onboarding({}, timeline);
  assert.equal(result.counts.commits, 3);
  assert.equal(result.available.history, true);
  assert.equal(result.available.people, true);
  assert.equal(result.thread.flow?.name, 'POST /admin/rebuild');
  // The handler changed only once: the file that changed since is followed instead.
  assert.equal(result.thread.file?.path, other);
  assert.equal(result.thread.history?.commits, 3);
  assert.deepEqual(result.thread.history?.recent.map(commit => commit.subject), ['Touch second', 'Touch first', 'Initial import']);
  assert.deepEqual(result.thread.history?.people.map(person => person.name), ['Ana Lopez']);
});

const summary = (name: string, patch: Partial<FlowSummary>): ThreadFlow => ({ summary: { id: name, kind: 'request', entry: { id: name, type: 'api_endpoint', name }, name, group: '', detail: 'lanes', entities: 10, files: 5, ...patch }, members: new Set() });
test('the flow ranks by completeness, then files (capped) with a bonus for tables, then name', () => {
  assert.equal(threadFlow([summary('b', { status: 'partial', files: 40 }), summary('a', { status: 'complete', files: 4 })])?.summary.name, 'a');
  // Reaching a table is worth ten files.
  assert.equal(threadFlow([summary('b', { status: 'complete', files: 12 }), summary('a', { status: 'complete', files: 8, tables: 1 })])?.summary.name, 'a');
  assert.equal(threadFlow([summary('b', { status: 'complete', files: 25 }), summary('a', { status: 'complete', files: 8, tables: 1 })])?.summary.name, 'b');
  // Past the cap, more files are not better: the name decides.
  assert.equal(threadFlow([summary('b', { status: 'complete', files: 80 }), summary('a', { status: 'complete', files: 31 })])?.summary.name, 'a');
  // Too small, unmatched, or tests: not a thread.
  assert.equal(threadFlow([summary('a', { files: 2 }), summary('b', { kind: 'unmatched', files: 9 }), summary('c', { scope: 'test', files: 9 })]), undefined);
  // No flow in lanes: the page with the most files.
  assert.equal(threadFlow([summary('a', { detail: 'steps', kind: 'page', files: 4 }), summary('b', { detail: 'steps', kind: 'page', files: 6 })])?.summary.name, 'b');
  assert.equal(threadFlow([summary('a', { detail: 'steps', kind: 'page', files: 9 }), summary('b', { status: 'headless', files: 3 })])?.summary.name, 'b');
});

test('the file is the first candidate with history, else the first', () => {
  assert.equal(pickFile([{ id: 'a', commits: 1 }, { id: 'b', commits: 2 }]), 'b');
  assert.equal(pickFile([{ id: 'a' }, { id: 'b' }]), 'a');
  assert.equal(pickFile([]), undefined);
});
