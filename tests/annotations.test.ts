// Language-model annotations with a fake model: requests built from the index,
// answers stored by what they describe, unchanged inputs never sent again, the
// budget respected, ASD-STE100 scored, domains applied to the index, and the
// projection serving all of it (flow titles, summaries, the Features view,
// commit notes).
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';
import { indexRepository } from '../src/pipeline/index.js';
import { GraphStore } from '../src/storage/sqlite.js';
import { ProjectionService } from '../src/projection/service.js';
import { AnnotationStore } from '../src/ai/store.js';
import { loadAnnotationInput, TASKS, type AnnotationInput } from '../src/ai/tasks.js';
import { estimate, pilot, runTasks } from '../src/ai/runner.js';
import { steScore, meanSte } from '../src/ai/ste.js';
import { assignDomains } from '../src/ai/domains.js';
import { costOf } from '../src/ai/pricing.js';
import type { StructuredModel, StructuredRequest } from '../src/ai/openai.js';
import type { SoftwareGraph } from '../src/core/graph.js';
import type { TimelineResponse } from '../src/projection/dto.js';

const fixture = fileURLToPath(new URL('./fixtures/repository', import.meta.url));
let root: string, graph: SoftwareGraph, store: GraphStore, annotations: AnnotationStore, projection: ProjectionService, input: AnnotationInput;
before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'atlas-annotations-'));
  await cp(fixture, root, { recursive: true });
  await mkdir(path.join(root, '.codiluce'));
  await writeFile(path.join(root, '.codiluce/config.yml'), stringify({ repository: { name: 'fixture' }, applications: [{ name: 'frontend', path: 'frontend', type: 'nextjs' }, { name: 'backend', path: 'backend', type: 'laravel', apiOrigins: ['https://api.fixture.test'], apiOriginEnv: ['NEXT_PUBLIC_API_URL'] }] }));
  graph = await indexRepository(root);
  store = new GraphStore(':memory:'); store.save(graph);
  annotations = new AnnotationStore(':memory:');
  projection = new ProjectionService(store, { root, annotations: () => annotations });
  input = await loadAnnotationInput(store, projection, annotations, root);
});
after(async () => { annotations.close(); store.close(); await rm(root, { recursive: true, force: true }); });

/** Answers every key of a batched request with a short STE description; records what it was asked. */
class FakeModel implements StructuredModel {
  requests: StructuredRequest[] = [];
  async structured<T>(request: StructuredRequest) {
    this.requests.push(request);
    const keys = [...request.input.matchAll(/^\[([a-z]\d+)\]/gm)].map(match => match[1]!);
    let value: unknown;
    if (request.schemaName === 'file_summaries') value = { files: keys.map(key => ({ key, summary: `The file ${key} reads the users table and sends the response.`, role: 'service' })) };
    else if (request.schemaName === 'folder_summaries') value = { folders: keys.map(key => ({ key, summary: 'The folder holds the code of this part of the application.' })) };
    else if (request.schemaName === 'flow_titles') value = { flows: keys.map(key => ({ key, title: `Do the task ${key}`, goal: 'The user sends the form and the server saves the data.', actor: 'user' })) };
    else if (request.schemaName === 'domains') value = { domains: [{ key: 'accounts', name: 'Accounts', summary: 'People sign in and change their profile.', include: ['frontend/src/components', 'backend/app/Http/Controllers/AuthController.php', 'backend/app/Services'] }, { key: 'admin', name: 'Admin', summary: 'Admins rebuild the reports.', include: ['backend/resources/js/pages/admin', 'backend/app/Console'] }] };
    else if (request.schemaName === 'overview') value = { summary: 'The product lets people sign in and manage a profile.', applications: [{ name: 'backend', summary: 'The backend serves the API.' }], start: ['Read AuthController first.'] };
    else value = {};
    return { value: value as T, usage: { input: 1000, cached: 0, output: 100 + keys.length * 50, reasoning: 20 }, model: request.use.model, ms: 1 };
  }
}

test('ASD-STE100: short active sentences pass; passive voice, -ing forms, long sentences and unapproved words are flagged', () => {
  assert.equal(steScore('The service reads the users table. It sends the response.').score, 1);
  const passive = steScore('The table is read by the service.');
  assert.ok(passive.issues.some(issue => issue.startsWith('passive voice')));
  assert.ok(steScore('The command is syncing the news.').issues.some(issue => issue.startsWith('-ing form')));
  assert.ok(steScore('The class utilizes the cache.').issues.some(issue => issue.startsWith('unapproved word')));
  const long = steScore('The controller reads the request and then it validates the data and then it saves the user and then it sends an email to the person and returns the page.');
  assert.ok(long.issues.some(issue => issue.includes('words in a sentence')));
  // Names from the code are technical names, not -ing words.
  assert.equal(steScore('The SyncingService calls getSettings() and writes to news_loading_log.').score, 1);
  assert.ok(meanSte(['The service reads the table.', 'The table is read.']) < 1);
});

test('requests are built from the index, answers stored by target, and unchanged inputs never sent again', async () => {
  const model = new FakeModel();
  const files = await TASKS.files.collect(input);
  const auth = files.find(item => item.label === 'backend/app/Services/AuthService.php')!;
  assert.match(auth.text, /reads tables .*users/);
  assert.match(auth.text, /source excerpt:/);
  const result = await runTasks(input, model, ['files', 'flows'], { budget: 5, concurrency: 2 });
  assert.equal(result.failed, 0);
  assert.equal(result.stored.files, files.length);
  assert.ok(result.stored.flows! > 0);
  assert.ok(result.ste.files! >= 0.8, 'the fake answers follow the rules');
  const stored = annotations.get<{ summary: string; role: string; hash?: string }>('file', auth.target)!;
  assert.equal(stored.value.role, 'service');
  assert.ok(stored.value.hash, 'the file hash is kept to tell when the description is out of date');
  assert.equal(stored.model, 'gpt-6-luna');
  assert.ok(Math.abs(result.cost - costOf('gpt-6-luna', result.usage)) < 1e-9);
  // A second run has nothing to send.
  const again = new FakeModel();
  const second = await runTasks(input, again, ['files', 'flows'], { budget: 5 });
  assert.equal(again.requests.length, 0);
  assert.equal(second.requests, 0);
  assert.equal(annotations.runs()[0]!.status, 'finished');
});

test('estimates price every pending request; a pilot measures tokens per item; the budget stops a run', async () => {
  const planned = await estimate(input, ['files', 'folders', 'domains', 'overview'], { force: true });
  const files = planned.tasks.find(task => task.task === 'files')!;
  assert.equal(files.model, 'gpt-6-luna');
  assert.ok(files.requests >= 1 && files.input > 0 && files.cost > 0);
  assert.equal(planned.tasks.find(task => task.task === 'domains')!.model, 'gpt-6.1-sol');
  assert.ok(planned.total > 0);
  const model = new FakeModel();
  const measured = await pilot(input, model, ['files', 'flows'], { force: true });
  assert.equal(model.requests.length, 2, 'one request per small task');
  assert.ok(measured.measured.files!.outputPerItem > 0);
  const remeasured = await estimate(input, ['files'], { force: true, measured: measured.measured });
  assert.equal(remeasured.tasks[0]!.measured, true);
  const stopped = await runTasks(input, new FakeModel(), ['files'], { budget: 0, force: true });
  assert.match(stopped.stopped ?? '', /budget/);
  assert.equal(stopped.requests, 0);
});

test('domains: the longest matching path wins, connected files infer theirs, the rest is platform; entities follow their code', async () => {
  await runTasks(input, new FakeModel(), ['folders', 'domains', 'overview'], { budget: 5, force: true });
  const index = (projection as unknown as { load(view: object): { index: import('../src/projection/hierarchy.js').ProjectionIndex } }).load({}).index;
  const rules = annotations.get<{ domains: { key: string; name: string; summary: string; include: string[] }[] }>('domains', 'repository')!.value.domains;
  const assignment = assignDomains(index, rules);
  const fileId = (file: string) => graph.entities.find(item => item.type === 'file' && item.path === file)!.id;
  assert.equal(assignment.of.get(fileId('backend/app/Services/AuthService.php')), 'accounts');
  assert.equal(assignment.of.get(fileId('backend/app/Console/Commands/SendReports.php')), 'admin');
  assert.equal(assignment.of.get(fileId('backend/app/Http/Controllers/AuthController.php')), 'accounts', 'a file path is a rule too');
  assert.ok(assignment.domains.some(domain => domain.key === 'platform'), 'shared code has a home');
  const login = graph.entities.find(item => item.name === 'POST /auth/login')!;
  assert.equal(assignment.of.get(login.id), 'accounts', 'an endpoint follows its handler');
  const reports = graph.entities.find(item => item.type === 'command' && item.name === 'reports:send')!;
  assert.equal(assignment.of.get(reports.id), 'admin');
  const inferred = [...assignment.inferred].filter(id => assignment.of.get(id) !== 'platform');
  assert.ok(inferred.every(id => graph.entities.some(item => item.id === id && item.type === 'file')));
});

test('the projection serves flow titles, summaries, the overview, the Features view and commit notes', async () => {
  const fresh = new ProjectionService(store, { root, annotations: () => annotations });
  const flows = fresh.flows().items;
  assert.ok(flows.some(item => item.title?.startsWith('Do the task') && item.actor === 'user'));
  const overview = fresh.annotationsOverview();
  assert.equal(overview.available, true);
  assert.equal(overview.overview?.summary, 'The product lets people sign in and manage a profile.');
  assert.ok(overview.domains.some(domain => domain.name === 'Accounts' && domain.files > 0));
  const service = graph.entities.find(item => item.type === 'file' && item.path === 'backend/app/Services/AuthService.php')!;
  const note = fresh.entityAnnotation(service.id);
  assert.match(note.summary ?? '', /reads the users table/);
  assert.deepEqual(note.domain, { key: 'accounts', name: 'Accounts', inferred: false });
  assert.ok(!note.outdated);
  // The Features view: repository → domain → folder → file; symbols stay in their files.
  const lens = fresh.locate(service.id, { lens: 'domains' });
  assert.deepEqual(lens.spatialAncestors.map(item => item.name), ['fixture', 'Accounts', 'backend/app/Services']);
  assert.equal(lens.spatialAncestors[1]!.kind, 'group');
  assert.ok(fresh.children(lens.spatialAncestors[1]!.id, { view: { lens: 'domains' } }).items.length > 0);
  const method = graph.entities.find(item => item.metadata.qualifiedName === 'App\\Services\\AuthService::authenticate')!;
  assert.ok(fresh.locate(method.id, { lens: 'domains' }).spatialAncestors.some(item => item.id === service.id), 'symbols stay in their files');
  const login = graph.entities.find(item => item.name === 'POST /auth/login')!;
  assert.ok(fresh.locate(login.id, { lens: 'domains' }).spatialAncestors.some(item => item.name === 'Accounts'), 'endpoints sit in their domain');
  assert.ok(fresh.search('AuthService', { view: { lens: 'domains' } }).items.length > 0);
  // Commit notes and chapters join the timeline.
  annotations.put([{ kind: 'commit', target: 'abc123', contentKey: 'k', promptVersion: 'commits-1', model: 'gpt-6-luna', value: { intent: 'feature', title: 'Add login', summary: 'The commit adds the login form.', areas: ['frontend'] } }, { kind: 'chapters', target: 'repository', contentKey: 'k', promptVersion: 'chapters-1', model: 'gpt-6.1-sol', value: { chapters: [{ title: 'First steps', summary: 'The team starts the app.', from: 'abc123', to: 'abc123', areas: [] }] } }]);
  const timeline: TimelineResponse = { available: true, firstParent: true, entries: [{ sha: 'abc123', parents: [], authorName: 'A', authoredAt: '2026-01-01', committedAt: '2026-01-01', subject: 'wip', merge: false }], indexing: { enabled: false, queued: [], failed: [] } };
  const annotated = fresh.annotateTimeline(timeline);
  assert.equal(annotated.entries[0]!.note?.title, 'Add login');
  assert.equal(annotated.chapters?.[0]?.title, 'First steps');
  // Without annotations, nothing changes.
  const plain = new ProjectionService(store, { root });
  assert.equal(plain.annotationsOverview().available, false);
  assert.equal(plain.annotateTimeline(timeline), timeline);
  assert.equal(plain.locate(service.id, { lens: 'domains' }).spatialAncestors.at(-1)!.type, 'directory', 'no domains: the folder view');
});
