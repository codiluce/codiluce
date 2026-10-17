import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';
import { indexRepository } from '../src/pipeline/index.js';
import { GraphStore } from '../src/storage/sqlite.js';
import { ProjectionService } from '../src/projection/service.js';
import { HistoryAccess, HistoryService } from '../src/history/service.js';
import { linksIn, parseLink, pathHref, schemeHref, hrefForNode } from '../src/explanations/links.js';
import { ExplanationStore, parseExplanation, serializeExplanation } from '../src/explanations/store.js';
import { ExplanationService, UnresolvedLinksError } from '../src/explanations/service.js';
import { codeTools, explanationTools, runTool, type ToolSpec } from '../src/explanations/tools.js';
import { McpSession } from '../src/explanations/mcp.js';
import { activityDirectory, readActivity, WORK_TIMEOUT_MS } from '../src/explanations/activity.js';
import { createInspectionServer } from '../src/api/server.js';
import { AnthropicChat, ChatService, anthropicCost, type ChatProvider, type ProviderRequest } from '../src/explanations/chat.js';
import { agentPrompt, chatQuestion, MCP_PROMPTS } from '../src/explanations/prompts.js';
import type { AskEvent, ExplanationRecord } from '../src/explanations/model.js';
import { composeTour, sceneProblems, scenesOf } from '../src/explanations/scenes.js';
import { FIXTURE_CONFIG } from './history-fixture.js';

const fixture = fileURLToPath(new URL('./fixtures/repository', import.meta.url));
let root: string, state: string, store: GraphStore, projection: ProjectionService, history: HistoryService, access: HistoryAccess, service: ExplanationService, first: string;
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test', GIT_CONFIG_NOSYSTEM: '1', HOME: root } }).trim();
const LOGIN_FORM = 'frontend/src/components/LoginForm.tsx';
async function reindex(): Promise<void> { store.save(await indexRepository(root, { stateDirectory: state })); }

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'codiluce-explain-'));
  state = path.join(root, '.state');
  await cp(fixture, root, { recursive: true });
  await mkdir(state);
  await writeFile(path.join(state, 'config.yml'), stringify(FIXTURE_CONFIG));
  git('init', '-q', '-b', 'main'); git('add', '-A'); git('commit', '-q', '-m', 'Initial import');
  first = git('rev-parse', 'HEAD');
  store = new GraphStore(':memory:');
  await reindex();
  access = new HistoryAccess(state);
  projection = new ProjectionService(store, { root, stateDirectory: state, history: access.get });
  history = new HistoryService({ root, stateDirectory: state, store, history: access });
  service = new ExplanationService({ stateDirectory: state, root, projection, history });
});
after(async () => { access.close(); store.close(); await rm(root, { recursive: true, force: true }); });

test('links: paths, symbols, lines, schemes and external links are told apart; code is not linked', () => {
  assert.deepEqual(parseLink('./app/Http/Kernel.php#L40-L62'), { kind: 'path', href: './app/Http/Kernel.php#L40-L62', target: 'app/Http/Kernel.php', lines: { start: 40, end: 62 } });
  assert.deepEqual(parseLink('app/Models/User.php#User.save'), { kind: 'path', href: 'app/Models/User.php#User.save', target: 'app/Models/User.php', symbol: 'User.save' });
  assert.deepEqual(parseLink('app/Http/'), { kind: 'path', href: 'app/Http/', target: 'app/Http', folder: true });
  assert.equal(parseLink('flow:POST%20/api/orders')!.target, 'POST /api/orders');
  assert.equal(parseLink('flow:POST /api/orders')!.target, 'POST /api/orders');
  assert.equal(parseLink('commit:ABC1234')!.target, 'abc1234');
  assert.equal(parseLink('pr:#42')!.target, '42');
  assert.equal(parseLink('https://example.com')!.kind, 'external');
  assert.equal(parseLink('vscode://file/x')!.kind, 'external');
  assert.equal(parseLink('#section'), undefined);
  const text = 'See [a](a.ts) and `[b](b.ts)`, ![img](i.png), [flow](flow:GET /x).\n```\n[c](c.ts)\n```';
  assert.deepEqual(linksIn(text).map(link => link.href), ['a.ts', 'flow:GET /x']);
  assert.equal(pathHref('dir with space/a.ts', { symbol: 'A.b' }), 'dir%20with%20space/a.ts#A.b');
  assert.equal(schemeHref('flow', 'POST /api/orders'), 'flow:POST%20/api/orders');
  assert.equal(hrefForNode({ type: 'method', name: 'login', path: 'x/Auth.php' }, { type: 'controller', name: 'Auth' }), 'x/Auth.php#Auth.login');
  assert.equal(hrefForNode({ type: 'directory', name: 'x', path: 'a/x' }), 'a/x/');
  assert.equal(hrefForNode({ type: 'api_endpoint', name: 'POST /auth/login', path: 'routes/api.php' }), 'flow:POST%20/auth/login');
});

test('store: an explanation round-trips through Markdown with front matter; a hand-written note is one answer', async () => {
  const record: ExplanationRecord = {
    id: '2026-10-14-login-ab12', title: 'How login: works', subject: { kind: 'flow', target: 'endpoint:1', ref: 'flow:POST /auth/login', label: 'POST /auth/login' },
    createdAt: '2026-10-14T08:00:00.000Z', updatedAt: '2026-10-14T09:00:00.000Z', commit: 'abc', dirty: false, source: 'agent', agent: 'claude-code', model: 'm', cost: 0.12,
    pins: { 'a.ts': 'h1', 'flow:POST%20/x': 'set:2' },
    turns: [{ role: 'question', text: 'How?', at: '2026-10-14T08:00:00.000Z' }, { role: 'answer', text: '## Login\nIt [posts](a.ts).', at: '2026-10-14T09:00:00.000Z', model: 'claude opus', cost: 0.12, commit: 'abc' }],
  };
  const parsed = parseExplanation(record.id, serializeExplanation(record), 'now');
  assert.deepEqual(parsed, record);
  const note = parseExplanation('note', '# Notes\nThe [form](a.ts) posts.\n', '2026-01-01T00:00:00.000Z');
  assert.equal(note.title, 'note');
  assert.equal(note.turns.length, 1);
  assert.equal(note.turns[0]!.role, 'answer');
  const directory = await mkdtemp(path.join(tmpdir(), 'codiluce-store-'));
  const explanations = new ExplanationStore(directory);
  explanations.save(record);
  await writeFile(path.join(directory, 'explanations', '../escape.md'), 'x');
  await writeFile(path.join(directory, 'explanations', 'Not An ID.md'), 'x');
  assert.deepEqual(explanations.list().map(item => item.id), [record.id]);
  assert.throws(() => explanations.file('../x'));
  await rm(directory, { recursive: true, force: true });
});

test('links resolve to entities on the map: files, folders with their files, Class.method, lines, tables, flows, suffixes', async () => {
  const links = await service.check([
    `[form](${LOGIN_FORM})`, '[controllers](backend/app/Http/Controllers/)', '[login](backend/app/Http/Controllers/AuthController.php#AuthController.login)',
    '[lines](backend/app/Http/Controllers/AuthController.php#L5)', '[users](table:users)', '[request](flow:POST%20/auth/login)', '[without method](flow:/auth/login)',
    '[short](app/Models/User.php)', '[nope](backend/nope.php)', '[no symbol](backend/app/Models/User.php#nothingHere)', '[feature](feature:billing)', `[commit](commit:${first.slice(0, 8)})`, '[pr](pr:99)',
  ].join(' '));
  const by = new Map(links.map(link => [link.href, link]));
  assert.equal(by.get(LOGIN_FORM)!.type, 'file');
  assert.ok(by.get(LOGIN_FORM)!.ancestors!.length >= 3);
  const folder = by.get('backend/app/Http/Controllers/')!;
  assert.equal(folder.type, 'directory');
  assert.ok(folder.members!.length >= 3, 'a folder lights its files');
  assert.equal(by.get('backend/app/Http/Controllers/AuthController.php#AuthController.login')!.type, 'method');
  assert.equal(by.get('backend/app/Http/Controllers/AuthController.php#L5')!.type, 'method', 'a line range lights the innermost symbol');
  assert.equal(by.get('table:users')!.type, 'database_table');
  assert.equal(by.get('flow:POST%20/auth/login')!.detail, 'lanes');
  assert.ok(by.get('flow:POST%20/auth/login')!.members!.length > 1);
  assert.equal(by.get('flow:/auth/login')!.id, by.get('flow:POST%20/auth/login')!.id, 'a route without its method names its one flow');
  assert.equal(by.get('app/Models/User.php')!.path, 'backend/app/Models/User.php');
  assert.match(by.get('app/Models/User.php')!.reason!, /full path/);
  assert.equal(by.get('backend/nope.php')!.status, 'missing');
  assert.match(by.get('backend/app/Models/User.php#nothingHere')!.reason!, /No symbol nothingHere/);
  assert.equal(by.get('feature:billing')!.status, 'missing');
  assert.equal(by.get(`commit:${first.slice(0, 8)}`)!.sha, first);
  assert.equal(by.get('pr:99')!.status, 'missing');
});

let explanationId = '';
test('publishing checks links, pins them to the commit, and staleness follows the code', async () => {
  const markdown = `## How login works\nThe [form](${LOGIN_FORM}) calls [the request](flow:POST%20/auth/login), answered by [login](backend/app/Http/Controllers/AuthController.php#AuthController.login) in [the controllers](backend/app/Http/Controllers/).`;
  await assert.rejects(service.publish({ markdown: `${markdown} [bad](no/such.ts)`, source: 'agent' }), (error: unknown) => error instanceof UnresolvedLinksError && error.links.length === 1);
  const saved = await service.publish({ markdown, question: 'How does login work?', subject: { kind: 'flow', ref: 'POST /auth/login' }, source: 'agent', agent: 'claude-code' });
  explanationId = saved.id;
  assert.equal(saved.title, 'How login works');
  assert.equal(saved.commit, first);
  assert.equal(saved.subject.kind, 'flow');
  assert.ok(saved.subject.target?.startsWith('endpoint:'));
  assert.equal(Object.keys(saved.pins).length, 4);
  assert.deepEqual(saved.stale, { changed: 0, missing: 0, linked: 4, moved: false, commitsSince: 0 });
  assert.ok(saved.footprint.ids.length >= 4);
  const file = await readFile(path.join(state, saved.file), 'utf8');
  assert.match(file, /<!-- codiluce:question at=/);
  assert.match(file, /agent: claude-code/);
  // Change the linked form and commit: the explanation says what changed and how far it is behind.
  await writeFile(path.join(root, LOGIN_FORM), `${await readFile(path.join(root, LOGIN_FORM), 'utf8')}\nexport const extra = 1;\n`);
  git('commit', '-q', '-am', 'Tune the login form (#7)');
  await reindex();
  const stale = (await service.detail(saved.id))!;
  assert.equal(stale.stale.changed, 2, 'the form and the flow through it');
  assert.equal(stale.stale.commitsSince, 1);
  assert.equal(stale.stale.moved, true);
  assert.deepEqual(stale.links.filter(link => link.status === 'changed').map(link => link.href).sort(), [LOGIN_FORM, 'flow:POST%20/auth/login'].sort());
  const list = await service.list();
  assert.equal(list.items[0]!.stale.changed, 2);
  // pr: links now resolve through the squash message.
  assert.equal((await service.check('[the PR](pr:7)'))[0]!.status, 'ok');
});

test('explanations of an entity: about it, linking it or code inside it, or linking a folder holding it', async () => {
  const context = projection.linkContext();
  const id = (pathName: string) => context.byPath.get(pathName)!;
  const file = await service.forEntity(id('backend/app/Http/Controllers/AuthController.php'));
  assert.equal(file.items[0]!.via, 'link', 'it links a symbol of the file');
  const sibling = await service.forEntity(id('backend/app/Http/Controllers/ProfileController.php'));
  assert.equal(sibling.items[0]!.via, 'area', 'it links the folder holding it');
  const backend = await service.forEntity(id('backend'));
  assert.equal(backend.items[0]!.via, 'link');
  const endpoint = (await service.check('[r](flow:POST%20/auth/login)'))[0]!.id!;
  assert.equal((await service.forEntity(endpoint)).items[0]!.via, 'subject');
  assert.equal((await service.forEntity(id('frontend/src/app'))).items.length, 0);
});

test('follow-ups append; a refresh replaces the answers and keeps the question', async () => {
  const appended = await service.publish({ id: explanationId, markdown: `The [form](${LOGIN_FORM}) now exports more.`, question: 'What changed?', source: 'chat', model: 'test', cost: 0.01 });
  assert.equal(appended.turns.length, 4);
  assert.equal(appended.stale.changed, 1, 'only the flow is still pinned to the old code');
  const replaced = await service.publish({ id: explanationId, mode: 'replace', question: 'How does login work?', markdown: `## How login works\nThe [form](${LOGIN_FORM}) calls [the request](flow:POST%20/auth/login).`, source: 'chat', cost: 0.02 });
  assert.deepEqual(replaced.turns.map(turn => turn.role), ['question', 'answer']);
  assert.equal(replaced.stale.changed, 0);
  assert.equal(replaced.source, 'agent', 'who started it is kept');
  assert.equal(replaced.cost, 0.03);
});

test('tools return links that resolve, and publishing through them reports unresolved links instead of saving', async () => {
  const tools = [...codeTools({ service, projection, history, root, maxFileBytes: 1 << 20 }), ...explanationTools({ service, projection, history, root, maxFileBytes: 1 << 20, agent: () => 'test-agent' })];
  const call = async (name: string, input: Record<string, unknown>) => { const result = await runTool(tools, name, input); assert.equal(result.isError, false, result.text); return JSON.parse(result.text) as Record<string, unknown>; };
  const overview = await call('overview', {});
  assert.equal((overview.applications as unknown[]).length, 2);
  const search = await call('search', { query: 'login' }) as { items: { link?: string }[] };
  const resolved = await service.check(search.items.filter(item => item.link).map(item => `[x](${item.link})`).join(' '));
  assert.ok(resolved.length > 3);
  assert.deepEqual(resolved.filter(link => link.status === 'missing'), [], 'every link a tool returns resolves');
  const entity = await call('entity', { link: LOGIN_FORM });
  assert.ok((entity.explainedIn as unknown[]).length >= 1);
  const flow = await call('flow', { flow: 'POST /auth/login' }) as { nodes: unknown[] };
  assert.ok(flow.nodes.length > 2);
  const page = await call('flow', { flow: '/login' }) as { steps: unknown[] };
  assert.ok(page.steps.length >= 1);
  const source = await runTool(tools, 'source', { link: 'backend/app/Http/Controllers/AuthController.php#AuthController.login' });
  assert.match(source.text, /AuthController\.php lines/);
  const missing = await runTool(tools, 'entity', { link: 'nowhere/at/all.ts' });
  assert.equal(missing.isError, true);
  assert.match(missing.text, /search/);
  const refused = await call('publish_explanation', { markdown: '[x](not/here.ts)' });
  assert.equal(refused.saved, false);
  const saved = await call('publish_explanation', { markdown: `## The form\n[form](${LOGIN_FORM})`, subject: { kind: 'entity', ref: LOGIN_FORM } });
  assert.ok(typeof saved.saved === 'string');
  assert.equal((await service.detail(String(saved.saved)))!.agent, 'test-agent');
  const commit = await call('commit', { commit: 'pr:7' }) as { files: { path: string }[] };
  assert.deepEqual(commit.files.map(item => item.path), [LOGIN_FORM]);
});

test('scenes: a tour is stored as markers before ## sections, read back the same, and checked before saving', () => {
  const scenes = [
    { title: 'Where it lives', view: 'map' as const, markdown: `The [form](${LOGIN_FORM}) -- on the map.`, captions: { [LOGIN_FORM]: 'the form' } },
    { title: 'How it talks', markdown: 'The form calls the controller.', arrows: [{ from: LOGIN_FORM, to: 'backend/app/Http/Controllers/AuthController.php', label: 'posts to' }] },
  ];
  const text = composeTour('An intro.', scenes);
  assert.match(text, /^An intro\.\n\n<!-- codiluce:scene \{"view":"map"/);
  for (const marker of text.split('\n').filter(line => line.startsWith('<!-- codiluce:scene'))) assert.doesNotMatch(marker.slice(4, -3), /--/, 'a marker never holds -- (it would end the comment)');
  const read = scenesOf(text);
  assert.equal(read.intro, 'An intro.');
  assert.deepEqual(read.scenes.map(scene => scene.title), ['Where it lives', 'How it talks']);
  assert.equal(read.scenes[0]!.view, 'map');
  assert.equal(read.scenes[0]!.captions![LOGIN_FORM], 'the form');
  assert.equal(read.scenes[1]!.arrows![0]!.label, 'posts to');
  assert.equal(read.scenes[1]!.markdown, 'The form calls the controller.');
  assert.deepEqual(scenesOf('Plain text, no scenes.').scenes, []);
  // The turn markers are untouched: a tour round-trips as one answer.
  const record = parseExplanation('x', serializeExplanation({ id: 'x', title: 'T', subject: { kind: 'question' }, createdAt: 'a', updatedAt: 'a', source: 'agent', pins: {}, turns: [{ role: 'answer', text, at: 'a' }] }), 'a');
  assert.equal(record.turns.length, 1);
  assert.equal(scenesOf(record.turns[0]!.text).scenes.length, 2);
  const problems = sceneProblems([
    { title: '', markdown: 'x' },
    { title: 'Flow', view: 'flow', markdown: 'x' },
    { title: 'Arrow', markdown: 'x', arrows: [{ from: LOGIN_FORM, to: 'commit:abcd', label: '' }] },
    { title: 'Crowded', markdown: Array.from({ length: 13 }, (_, index) => `[f${index}](f${index}.ts)`).join(' ') },
  ]);
  assert.equal(problems.length, 5, problems.join('\n'));
});

test('a tour publishes as scenes: boxes nest symbols in their file, group by folder, and arrows carry the index\'s evidence', async () => {
  const controller = 'backend/app/Http/Controllers/AuthController.php';
  await assert.rejects(service.publish({ source: 'agent', scenes: [{ title: 'Bad', markdown: 'x', arrows: [{ from: LOGIN_FORM, to: 'no/such.ts', label: 'calls' }] }] }), UnresolvedLinksError);
  const saved = await service.publish({
    source: 'agent', question: 'How does login reach the server?', markdown: 'Login, in two scenes.',
    scenes: [
      { title: 'Where it lives', view: 'map', markdown: `The [form](${LOGIN_FORM}) and [the controller](${controller}).` },
      { title: 'How it connects', markdown: `The [login](${controller}#AuthController.login) action answers [the request](flow:POST%20/auth/login).`, focus: [controller, `${controller}#AuthController.login`, LOGIN_FORM, 'backend/app/Services/AuthService.php'], start: LOGIN_FORM,
        arrows: [
          { from: LOGIN_FORM, to: `${controller}#AuthController.login`, label: 'posts the credentials to' },
          { from: controller, to: 'backend/app/Services/AuthService.php', label: 'asks' },
          { from: 'backend/app/Services/AuthService.php', to: LOGIN_FORM, label: 'shares a name with', undirected: true },
        ] },
    ],
  });
  assert.equal(saved.title, 'How does login reach the server?', 'the question names it when no title is given');
  const tour = saved.tour!;
  assert.equal(tour.intro, 'Login, in two scenes.');
  assert.equal(tour.scenes.length, 2);
  assert.equal(tour.scenes[0]!.view, 'map');
  assert.deepEqual(tour.scenes[0]!.boxes.map(box => box.link.path), [LOGIN_FORM, controller]);
  const second = tour.scenes[1]!;
  assert.equal(second.view, 'diagram');
  const login = second.boxes.find(box => box.link.type === 'method')!;
  const file = second.boxes.find(box => box.link.path === controller && box.link.type === 'file')!;
  assert.equal(login.parent, file.key, 'the method sits in its file box');
  assert.equal(file.group, 'backend/app/Http/Controllers');
  assert.equal(second.start, second.boxes.find(box => box.link.path === LOGIN_FORM)!.key);
  const asks = second.arrows.find(arrow => arrow.label === 'asks')!;
  assert.ok(asks.evidence.length >= 1, `the controller uses the service: ${JSON.stringify(asks.evidence)}`);
  assert.equal(second.arrows.find(arrow => arrow.undirected)!.evidence.length, 0, 'a conceptual arrow has no evidence, and is still drawn');
  assert.ok(saved.links.some(link => link.href === 'backend/app/Services/AuthService.php'), 'links outside the text are resolved and pinned');
  assert.ok(saved.pins['backend/app/Services/AuthService.php']);
  const listed = (await service.list()).items.find(item => item.id === saved.id)!;
  assert.equal(listed.scenes, 2);
  assert.equal(listed.excerpt.startsWith('Login, in two scenes.'), true);
  // A text follow-up keeps the tour of the answer that has one.
  const followed = await service.publish({ id: saved.id, markdown: 'And the form validates first.', source: 'agent' });
  assert.equal(followed.tour!.turn, 1);
  assert.equal(followed.tour!.scenes.length, 2);
});

test('MCP: initialize negotiates, lists tools with hints and prompts, and reports errors as JSON-RPC', async () => {
  // The MCP server reads the index from the state directory.
  const disk = new GraphStore(path.join(state, 'codiluce.db'));
  disk.save(await indexRepository(root, { stateDirectory: state })); disk.close();
  const session = new McpSession({ root, stateDirectory: state, version: '9.9.9' });
  try {
    const send = async (message: unknown) => session.receive(JSON.stringify(message)) as Promise<{ result?: Record<string, unknown>; error?: { code: number; message: string } } | undefined>;
    const init = await send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-code' } } });
    assert.equal(init!.result!.protocolVersion, '2025-06-18');
    assert.equal((await send({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } }))!.result!.protocolVersion, '2025-06-18');
    assert.equal(await send({ jsonrpc: '2.0', method: 'notifications/initialized' }), undefined);
    const tools = (await send({ jsonrpc: '2.0', id: 3, method: 'tools/list' }))!.result!.tools as { name: string; annotations: { readOnlyHint: boolean } }[];
    assert.ok(tools.find(tool => tool.name === 'search')!.annotations.readOnlyHint);
    assert.equal(tools.find(tool => tool.name === 'publish_explanation')!.annotations.readOnlyHint, false);
    const called = (await send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'search', arguments: { query: 'AuthController' } } }))!.result!;
    assert.equal(called.isError, false);
    assert.equal((await send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'nope' } }))!.error!.code, -32602);
    assert.equal((await send({ jsonrpc: '2.0', id: 6, method: 'unknown/method' }))!.error!.code, -32601);
    assert.equal((await session.receive('not json') as { error: { code: number } }).error.code, -32700);
    const prompts = (await send({ jsonrpc: '2.0', id: 7, method: 'prompts/list' }))!.result!.prompts as { name: string }[];
    assert.deepEqual(prompts.map(prompt => prompt.name), MCP_PROMPTS.map(prompt => prompt.name));
    assert.equal((await send({ jsonrpc: '2.0', id: 8, method: 'prompts/get', params: { name: 'explain-flow' } }))!.error!.code, -32602);
    const prompt = (await send({ jsonrpc: '2.0', id: 9, method: 'prompts/get', params: { name: 'explain-flow', arguments: { flow: 'POST /auth/login' } } }))!.result!;
    assert.match(JSON.stringify(prompt), /flow:POST \/auth\/login/);
  } finally { session.close(); }
});

test('activity: only explicit explanation requests start work; ordinary reads and session searches stay connected', async () => {
  const session = new McpSession({ root, stateDirectory: state, version: '9.9.9' });
  const send = async (message: unknown) => session.receive(JSON.stringify(message)) as Promise<{ result?: Record<string, unknown> } | undefined>;
  const call = async (id: number, name: string, args: Record<string, unknown>) => JSON.parse(((await send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }))!.result!.content as { text: string }[])[0]!.text) as Record<string, unknown>;
  const only = () => { const items = readActivity(state); assert.equal(items.length, 1); return items[0]!; };
  let saved: string | undefined;
  try {
    assert.deepEqual(readActivity(state), []);
    await send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-code' } } });
    assert.equal(only().state, 'connected');
    assert.equal(only().agent, 'claude-code');
    await call(20, 'overview', {});
    await call(21, 'search', { query: 'Login' });
    await send({ jsonrpc: '2.0', id: 22, method: 'tools/call', params: { name: 'source', arguments: { link: LOGIN_FORM } } });
    await call(23, 'search_conversations', { query: 'Markdown' });
    assert.equal(only().state, 'connected');
    assert.equal(only().work, undefined, 'ordinary MCP session reads are not explanations');
    // A prompt (a slash command) is work before the first tool call.
    await send({ jsonrpc: '2.0', id: 2, method: 'prompts/get', params: { name: 'explain-flow', arguments: { flow: 'POST /auth/login' } } });
    assert.equal(only().state, 'working');
    assert.deepEqual(only().work, { ...only().work!, title: 'Explain a flow: POST /auth/login', subject: { kind: 'flow', ref: 'flow:POST /auth/login' }, steps: [], count: 0 });
    // Each tool call is a step, recorded before the tool answers; start_explanation names the work and keeps them.
    await call(3, 'flow', { flow: 'flow:POST /auth/login' });
    assert.deepEqual(only().work!.steps.map(step => step.text), ['flow flow:POST /auth/login']);
    assert.deepEqual(await call(4, 'start_explanation', { title: 'How login works', question: 'How does login work?' }), { started: true, next: 'Read the code with the Codiluce tools, then save the answer with publish_explanation (as scenes, a tour, when it walks through several places or a process).' });
    assert.equal(only().work!.title, 'How login works');
    assert.equal(only().work!.question, 'How does login work?');
    assert.equal(only().work!.count, 1);
    // Publishing ends the work; the question and subject it was started with are saved with the answer.
    saved = String((await call(5, 'publish_explanation', { markdown: `## How login works\n[form](${LOGIN_FORM})` })).saved);
    assert.equal(only().state, 'connected');
    assert.equal(only().work, undefined);
    assert.equal(only().published!.id, saved);
    const detail = (await service.detail(saved))!;
    assert.equal(detail.turns[0]!.text, 'How does login work?');
    assert.equal(detail.subject.kind, 'flow');
    // Ordinary reads after publication do not restart explanation activity.
    await call(6, 'search', { query: 'Login' });
    assert.equal(only().state, 'connected');
    await call(7, 'start_explanation', { title: 'Explain recent changes', subject: { kind: 'commit' } });
    await call(8, 'search', { query: 'Login' });
    assert.equal(only().work!.count, 1);
    assert.equal(readActivity(state, Date.now() + WORK_TIMEOUT_MS + 1000)[0]!.state, 'connected');
    // serve reports it to the map.
    const server = createInspectionServer(store, { root, stateDirectory: state });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as { port: number };
      const body = await (await fetch(`http://127.0.0.1:${port}/api/explanations/activity`)).json() as { items: { agent: string; state: string; work: { steps: { text: string }[] } }[] };
      assert.deepEqual(body.items.map(item => [item.agent, item.state, item.work.steps[0]!.text]), [['claude-code', 'working', 'search Login']]);
    } finally { await new Promise(resolve => server.close(resolve)); }
  } finally { session.close(); if (saved) service.remove(saved); }
  // The session's file goes with it; one left by a process that ended is not shown.
  assert.deepEqual(readActivity(state), []);
  await writeFile(path.join(activityDirectory(state), '1-ended.json'), JSON.stringify({ session: '1-ended', pid: 99_999_999, connectedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
  assert.deepEqual(readActivity(state), []);
  await rm(path.join(activityDirectory(state), '1-ended.json'));
  const old = path.join(activityDirectory(state), 'legacy-read.json');
  await writeFile(old, JSON.stringify({ session: 'legacy-read', pid: process.pid, connectedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), work: { startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), steps: [{ text: 'overview' }], count: 1 } }));
  assert.equal(readActivity(state)[0]?.state, 'connected', 'legacy inferred reads do not light Explanations');
  await rm(old);
});

test('prompts name what to explain, how to start, and how to publish', () => {
  const prompt = agentPrompt({ kind: 'entity', ref: 'a/b.ts', label: 'b.ts', type: 'file' }, { setup: 'claude mcp add codiluce -- npx -y codiluce mcp' });
  assert.match(prompt, /Explain the file b\.ts \(a\/b\.ts\)/);
  assert.match(prompt, /publish_explanation/);
  assert.match(prompt, /claude mcp add/);
  assert.match(agentPrompt({ kind: 'refresh', id: 'x-1', label: 'Old' }), /`update_explanation` \(id "x-1", mode "replace"\)/);
  assert.equal(chatQuestion({ kind: 'flow', ref: 'flow:POST%20/x' }), 'Explain the flow [POST /x](flow:POST%20/x) step by step: who starts it, what each step does, what data it touches, and where it can fail.');
  assert.doesNotMatch(chatQuestion({ kind: 'entity', ref: 'a/b.ts', label: 'b.ts' }, { plain: true }), /\]\(/);
});

/** A provider that calls one tool, then answers with the given texts in turn (the review may ask for another). */
function scripted(answers: string[], seen: ProviderRequest[] = []): ChatProvider {
  return {
    async run(request) {
      seen.push(request);
      const { text } = await runTool(request.tools, 'search', { query: 'login' });
      request.emit({ type: 'tool', name: 'search', detail: `search login (${text.length} characters)` });
      request.budget.add(0.01);
      for (const answer of answers) {
        request.emit({ type: 'text', delta: answer });
        const correction = await request.review(answer);
        if (!correction) return { text: answer, model: 'fake-model' };
        request.budget.add(0.01);
      }
      return { text: answers.at(-1)!, model: 'fake-model' };
    },
  };
}
test('the chat answers with the tools, sends unresolved links back once, and saves the answer with its question', async () => {
  const seen: ProviderRequest[] = [];
  const chat = new ChatService({ service, tools: codeTools({ service, projection, history, root, maxFileBytes: 1 << 20 }), keyFiles: [], providers: { anthropic: scripted(['## Form\nSee [it](wrong/path.tsx).', `## Form\nSee [it](${LOGIN_FORM}).`], seen) } });
  assert.equal(chat.models().find(model => model.default)!.id, 'claude-opus-5-5');
  const events: AskEvent[] = [];
  const saved = await chat.ask({ question: 'What does the form do?', context: [LOGIN_FORM] }, event => events.push(event), new AbortController().signal);
  assert.deepEqual(events.map(event => event.type), ['start', 'tool', 'text', 'retry', 'text']);
  assert.match(seen[0]!.question, /The user attached:\n- frontend\/src\/components\/LoginForm\.tsx: file/);
  assert.equal(saved.subject.kind, 'entity', 'one attached file is the subject');
  assert.equal(saved.source, 'chat');
  assert.equal(saved.model, 'fake-model');
  assert.equal(saved.cost, 0.02);
  assert.deepEqual(saved.turns.map(turn => turn.role), ['question', 'answer']);
  assert.equal(saved.links[0]!.status, 'ok');
  // A follow-up carries the conversation; a refresh says what changed.
  await chat.ask({ question: 'And then?', explanationId: saved.id }, () => undefined, new AbortController().signal);
  assert.match(seen[1]!.question, /Earlier in this conversation:[\s\S]*What does the form do\?[\s\S]*And then\?$/);
  await chat.ask({ question: '', explanationId: saved.id, refresh: true }, () => undefined, new AbortController().signal);
  assert.match(seen[2]!.question, /This explanation was written at commit/);
  const refreshed = (await service.detail(saved.id))!;
  assert.deepEqual(refreshed.turns.map(turn => turn.role), ['question', 'answer']);
  assert.equal(refreshed.turns[0]!.text, 'What does the form do?');
  // No key for a model, and read-only servers, refuse clearly.
  await assert.rejects(chat.ask({ question: 'x', model: 'gpt-6.1-sol' }, () => undefined, new AbortController().signal), /OPENAI_API_KEY/);
  const readOnly = new ChatService({ service: new ExplanationService({ stateDirectory: state, root, projection, readOnly: true }), tools: [], keyFiles: [], providers: { anthropic: scripted(['x']) } });
  await assert.rejects(readOnly.ask({ question: 'x' }, () => undefined, new AbortController().signal), /read-only/);
});

/** A local stand-in for the Messages API: streams a tool call first, then an answer, as server-sent events. */
async function messagesServer(answer: string): Promise<{ server: Server; url: string; bodies: Record<string, unknown>[] }> {
  const bodies: Record<string, unknown>[] = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const parsed = JSON.parse(body) as Record<string, unknown>;
    bodies.push(parsed);
    const turn = bodies.length;
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const send = (type: string, data: Record<string, unknown>) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    send('message_start', { message: { id: `msg_${turn}`, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1000, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });
    if (turn === 1) {
      send('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'search', input: {} } });
      send('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '{"query":' } });
      send('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '"login"}' } });
      send('content_block_stop', { index: 0 });
      send('message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 20 } });
    } else {
      send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
      for (const part of [answer.slice(0, 10), answer.slice(10)]) send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: part } });
      send('content_block_stop', { index: 0 });
      send('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 50 } });
    }
    send('message_stop', {});
    response.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  return { server, url: `http://127.0.0.1:${address.port}`, bodies };
}
test('Claude through the SDK: streamed tool loop, fallbacks on, cached prefix, cost from usage', async () => {
  const answer = `## The form\nIt lives in [the form](${LOGIN_FORM}).`;
  const mock = await messagesServer(answer);
  const previous = process.env.ANTHROPIC_BASE_URL;
  process.env.ANTHROPIC_BASE_URL = mock.url;
  try {
    const tools: ToolSpec[] = codeTools({ service, projection, history, root, maxFileBytes: 1 << 20 });
    const chat = new ChatService({ service, tools, keyFiles: [], providers: { anthropic: new AnthropicChat('test-key') } });
    const events: AskEvent[] = [];
    const saved = await chat.ask({ question: 'Where is the form?' }, event => events.push(event), new AbortController().signal);
    assert.equal(mock.bodies.length, 2);
    const request = mock.bodies[0]!;
    assert.equal(request.model, 'claude-opus-5-5');
    assert.equal(request.fallbacks, 'default');
    assert.deepEqual(request.cache_control, { type: 'ephemeral' });
    assert.deepEqual(request.output_config, { effort: 'medium' });
    assert.equal(request.thinking, undefined);
    assert.ok((request.tools as { eager_input_streaming?: boolean }[]).every(tool => tool.eager_input_streaming));
    const second = mock.bodies[1]!.messages as { role: string; content: { type: string; tool_use_id?: string }[] | string }[];
    assert.equal(second[1]!.role, 'assistant');
    assert.equal((second[2]!.content as { type: string }[])[0]!.type, 'tool_result');
    assert.deepEqual(events.filter(event => event.type === 'tool').map(event => (event as { detail: string }).detail), ['search login']);
    assert.equal(events.filter(event => event.type === 'text').map(event => (event as { delta: string }).delta).join(''), answer);
    assert.equal(saved.turns.at(-1)!.text, answer);
    assert.ok(Math.abs(saved.cost! - 2 * anthropicCost('claude-opus-5-5', { input_tokens: 1000, output_tokens: 0 }) - anthropicCost('claude-opus-5-5', { input_tokens: 0, output_tokens: 70 })) < 1e-9);
  } finally {
    if (previous === undefined) delete process.env.ANTHROPIC_BASE_URL; else process.env.ANTHROPIC_BASE_URL = previous;
    mock.server.close();
  }
});
