import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { importTranscript, transcriptSource } from '../src/conversations/import.js';
import { nestedCalls, toolPaths } from '../src/conversations/paths.js';
import { ConversationStore } from '../src/conversations/store.js';
import { ConversationService } from '../src/conversations/service.js';
import { handleConversationRoute, isConversationPath } from '../src/conversations/routes.js';
import { McpSession } from '../src/explanations/mcp.js';
import { isSessionSetup } from '../src/conversations/presentation.js';
import { latestPublicUpdate } from '../src/conversations/live.js';
import type { ConversationReplay } from '../src/conversations/model.js';

let directory: string, root: string, codex: string, claude: string, state: string;
const at = '2026-10-15T10:00:00.000Z';
const jsonl = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
const item = (payload: unknown) => ({ type: 'response_item', timestamp: at, payload });
before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'codiluce-conversations-'));
  root = path.join(directory, 'repo'); state = path.join(directory, 'state'); codex = path.join(directory, 'codex'); claude = path.join(directory, 'claude');
  await mkdir(path.join(root, 'src'), { recursive: true }); await mkdir(path.join(codex, 'sessions'), { recursive: true }); await mkdir(path.join(claude, 'projects', 'repo'), { recursive: true });
  await writeFile(path.join(root, 'src/a.ts'), 'export const a = 1;'); await symlink(directory, path.join(root, 'escape'));
  await writeFile(path.join(codex, 'sessions', 'codex-one.jsonl'), jsonl([
    { type: 'session_meta', timestamp: at, payload: { id: 'codex-one', cwd: root } },
    item({ type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'private instructions' }] }),
    { type: 'event_msg', payload: { type: 'user_message', message: 'How should we persist sessions?' } },
    item({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'How should we persist sessions?' }] }),
    item({ type: 'function_call', name: 'exec_command', call_id: 'read', arguments: JSON.stringify({ cmd: 'cat src/a.ts' }) }),
    item({ type: 'function_call_output', call_id: 'read', output: JSON.stringify({ exit_code: 0, output: 'file' }) }),
    item({ type: 'custom_tool_call', name: 'apply_patch', call_id: 'add', input: '*** Begin Patch\n*** Add File: src/new.ts\n+new\n*** End Patch' }),
    item({ type: 'custom_tool_call_output', call_id: 'add', output: 'Success.' }),
    item({ type: 'function_call', name: 'Read', call_id: 'failed', arguments: JSON.stringify({ path: 'src/missing.ts' }) }),
    item({ type: 'function_call_output', call_id: 'failed', output: 'Error: no file' }),
    item({ type: 'custom_tool_call', name: 'exec', call_id: 'wrapper', input: 'text(await tools.exec_command({cmd:"cat src/a.ts"}));' }),
    item({ type: 'custom_tool_call_output', call_id: 'wrapper', output: '{"exit_code":0}' }),
    item({ type: 'reasoning', summary: [{ text: 'hidden reasoning' }] }),
    item({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Use Markdown for readable records.' }] }),
  ]));
  await writeFile(path.join(claude, 'projects', 'repo', 'claude-one.jsonl'), jsonl([
    { type: 'mode', sessionId: 'claude-one' },
    { type: 'user', uuid: 'user-1', sessionId: 'claude-one', cwd: root, timestamp: at, message: { content: 'Keep the rationale visible.' } },
    { type: 'assistant', uuid: 'assistant-1', cwd: root, timestamp: at, message: { content: [{ type: 'text', text: 'I will add the session record.' }, { type: 'tool_use', id: 'write', name: 'Write', input: { file_path: path.join(root, 'src/session.md'), content: '# Session' } }] } },
    { type: 'user', uuid: 'result-1', cwd: root, timestamp: at, toolUseResult: { type: 'create' }, message: { content: [{ type: 'tool_result', tool_use_id: 'write', content: 'File created successfully at: src/session.md' }] } },
    { type: 'ai-title', aiTitle: 'Readable project sessions', sessionId: 'claude-one' },
  ]));
});
after(async () => { await rm(directory, { recursive: true, force: true }); });

test('imports Codex messages once, correlates results, preserves failure and nested uncertainty', async () => {
  const source = (await transcriptSource(root, path.join(codex, 'sessions/codex-one.jsonl'), 'codex'))!;
  const conversation = await importTranscript(root, source);
  assert.equal(conversation.id, 'codex:codex-one');
  assert.equal(conversation.messages.filter(message => message.role === 'user').length, 1);
  assert.equal(conversation.messages.some(message => /private instructions|hidden reasoning/.test(message.text)), false);
  assert.deepEqual(conversation.paths.map(target => [target.path, target.action, target.status]), [
    ['src/a.ts', 'read', 'completed'], ['src/new.ts', 'added', 'completed'], ['src/missing.ts', 'read', 'failed'], ['src/a.ts', 'read', 'unknown'],
  ]);
  const moved = path.join(directory, 'archive.jsonl'); await writeFile(moved, await readFile(source.file));
  assert.deepEqual((await importTranscript(root, { ...source, file: moved })).messages.map(message => message.id), conversation.messages.map(message => message.id), 'source references survive archive moves');
});

test('imports Claude titles and distinguishes created files from edits', async () => {
  const source = (await transcriptSource(root, path.join(claude, 'projects/repo/claude-one.jsonl'), 'claude-code'))!;
  const conversation = await importTranscript(root, source);
  assert.equal(conversation.title, 'Readable project sessions');
  assert.equal(conversation.messages.length, 3);
  assert.deepEqual(conversation.paths.map(item => [item.path, item.action, item.status]), [['src/session.md', 'added', 'completed']]);
});

test('tool associations exclude prose, scripts, variables, repository escapes and symlinks', () => {
  const patch = '*** Begin Patch\n*** Add File: src/x.ts\n*** Update File: ../secret\n*** Update File: escape/secret\n*** End Patch';
  assert.deepEqual(toolPaths(root, root, 'apply_patch', patch).map(target => target.path), ['src/x.ts']);
  assert.deepEqual(toolPaths(root, root, 'Bash', { command: 'python write_files.py' }), []);
  assert.deepEqual(toolPaths(root, root, 'exec', 'await tools.exec_command({cmd: command});'), []);
  const calls = nestedCalls('const example = "tools.read_file({path: \'src/fake.ts\'})"; // tools.read_file({path:"src/fake2.ts"})\nawait tools.read_file({path:"src/a.ts"});');
  assert.equal(calls.length, 1); assert.equal(calls[0]!.name, 'read_file'); assert.equal((calls[0]!.input as { path: string }).path, 'src/a.ts');
  assert.deepEqual(toolPaths(root, root, 'Bash', { command: 'cat src/a.ts && head -n 2 src/b.ts' }).map(target => target.path), ['src/a.ts', 'src/b.ts']);
});

test('older Codex event messages retain their place beside canonical assistant messages, and long human text is preserved', async () => {
  const file = path.join(directory, 'older-codex.jsonl'), long = 'A'.repeat(120_000);
  await writeFile(file, jsonl([
    { type: 'session_meta', payload: { id: 'older', cwd: root } },
    { type: 'event_msg', payload: { type: 'user_message', message: long } },
    item({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'A response.' }] }),
    item({ type: 'function_call', call_id: 'large-result', name: 'Read', arguments: JSON.stringify({ path: 'src/a.ts' }) }),
    item({ type: 'function_call_output', call_id: 'large-result', output: long }),
  ]));
  const source = (await transcriptSource(root, file, 'codex'))!;
  const conversation = await importTranscript(root, source);
  assert.deepEqual(conversation.messages.map(message => message.role), ['user', 'assistant', 'tool']);
  assert.equal(conversation.messages[0]!.text, long);
  assert.equal(conversation.messages[0]!.truncated, undefined);
  assert.equal(conversation.messages[2]!.text.length, 100_000);
  assert.equal(conversation.messages[2]!.truncated, true);
});

test('persistent import is incremental, searches messages and folder descendants, and paginates source messages', async () => {
  const service = new ConversationService({ root, stateDirectory: state, codexHome: codex, claudeHome: claude });
  try {
    assert.equal((await service.sync()).imported, 2);
    if (process.platform !== 'win32') assert.equal((await stat(path.join(state, 'conversations.db'))).mode & 0o077, 0, 'transcripts are not readable by other local users');
    assert.equal((await service.sync()).unchanged, 2);
    assert.equal(service.store.list({ query: 'persist sessions' }).total, 1);
    assert.equal(service.store.list({ path: 'src/', action: 'added' }).total, 2);
    assert.equal(service.store.list({ path: 'srcx/' }).total, 0);
    assert.equal(service.store.list({ provider: 'claude-code' }).total, 1);
    assert.equal(service.store.list({ query: '%' }).total, 0, 'wildcards are literal');
    const page = service.store.read('codex:codex-one', { limit: 2, query: 'Markdown' })!;
    assert.equal(page.messages.length, 2); assert.equal(page.matches.length, 1);
    const jump = service.store.read('codex:codex-one', { limit: 2, messageId: page.matches[0] })!;
    assert.ok(jump.messages.some(message => message.id === page.matches[0]));
    assert.throws(() => service.store.read('codex:codex-one', { offset: NaN }));
    assert.throws(() => service.store.read('codex:codex-one', { messageId: 'invented' }));
    const original = service.store.get('codex:codex-one')!;
    service.store.save({ ...original, updatedAt: '2026-10-15T11:00:00.000Z', messages: [...original.messages, { id: 'latest', role: 'assistant', text: 'A more recent turn.' }] }, 'active-copy', '1');
    service.store.save(original, 'older-archive', '1');
    assert.equal(service.store.get(original.id)!.messages.at(-1)!.id, 'latest', 'older copies do not overwrite newer history');
  } finally { service.close(); }
  const reopened = new ConversationStore(state, true); try { assert.equal(reopened.list().total, 2); } finally { reopened.close(); }
  const other = path.join(directory, 'other.jsonl'); await writeFile(other, jsonl([{ type: 'session_meta', payload: { cwd: directory, id: 'outside' } }]));
  assert.equal(await transcriptSource(root, other, 'codex'), undefined);
});

test('live imports only refresh explicitly observed provider sessions, including newly discovered transcripts', async () => {
  const service = new ConversationService({ root, stateDirectory: path.join(directory, 'live'), codexHome: codex, claudeHome: claude });
  try {
    assert.equal((await service.sync([])).imported, 0);
    assert.equal((await service.sync([{ provider: 'codex', sessionId: 'codex-one' }])).imported, 1);
    assert.equal(service.store.list().total, 1);
    assert.equal(service.store.summary('claude-code:claude-one'), undefined, 'live refresh does not import unrelated sessions');
    const file = path.join(codex, 'sessions/rollout-live-only.jsonl');
    await writeFile(file, jsonl([{ type: 'session_meta', timestamp: at, payload: { id: 'live-only', cwd: root } }, item({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'A newly observed conversation.' }] })]));
    assert.equal((await service.sync([{ provider: 'codex', sessionId: 'live-only' }])).imported, 1);
    assert.equal(service.store.summary('codex:live-only')?.messages, 1);
    await writeFile(file, (await readFile(file, 'utf8')) + jsonl([item({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'A live answer.' }] })]));
    await service.sync([{ provider: 'codex', sessionId: 'live-only' }]);
    assert.equal(service.store.get('codex:live-only')?.messages.at(-1)?.text, 'A live answer.');
    await rm(file);
    await Promise.all([service.sync([{ provider: 'codex', sessionId: 'codex-one' }]), service.sync()]);
    assert.ok(service.store.summary('claude-code:claude-one'), 'a concurrent manual import still includes other sessions');
  } finally { service.close(); }
});

test('session setup detection hides only Codex injected preambles and preserves ordinary discussion of AGENTS.md', () => {
  const setup = { role: 'user' as const, text: `# AGENTS.md instructions for ${root}\n\n<INSTRUCTIONS>\nProject rules.\n</INSTRUCTIONS>\n<environment_context>cwd=${root}</environment_context>` };
  assert.equal(isSessionSetup(setup, 'codex'), true);
  assert.equal(isSessionSetup(setup, 'claude-code'), false);
  assert.equal(isSessionSetup({ ...setup, role: 'assistant' }, 'codex'), false);
  assert.equal(isSessionSetup({ role: 'user', text: 'Please explain the instructions in AGENTS.md.' }, 'codex'), false);
  assert.equal(isSessionSetup({ ...setup, text: setup.text + '\nNow implement login.' }, 'codex'), false, 'a real request after setup is preserved');
});

test('live updates use bounded public text, replace earlier responses, and clear on a new user request', async () => {
  const file = path.join(directory, 'bounded-live.jsonl');
  const source = { file, provider: 'codex' as const, sessionId: 'bounded', cwd: root };
  const rows = [
    { type: 'session_meta', payload: { id: 'bounded', cwd: root } },
    { type: 'response_item', payload: { type: 'reasoning', summary: [{ text: 'private'.repeat(100000) }] } },
    item({ type: 'message', role: 'assistant', channel: 'commentary', content: [{ type: 'output_text', text: 'Checking the session filters.' }] }),
    item({ type: 'message', role: 'assistant', channel: 'analysis', content: [{ type: 'output_text', text: 'Private internal text.' }] }),
  ];
  await writeFile(file, jsonl(rows));
  assert.equal((await latestPublicUpdate(source))?.text, 'Checking the session filters.');
  rows.push(item({ type: 'message', role: 'assistant', channel: 'final', content: [{ type: 'output_text', text: 'The filters are ready.' }] }));
  await writeFile(file, jsonl(rows) + '{"partial":');
  assert.equal((await latestPublicUpdate(source))?.text, 'The filters are ready.');
  rows.push(item({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Now check the map.' }] }));
  await writeFile(file, jsonl(rows));
  assert.equal(await latestPublicUpdate(source), undefined, 'an earlier response is not shown as current work on a new request');
  const claudeSource = { ...source, provider: 'claude-code' as const };
  await writeFile(file, jsonl([{ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'Private reasoning.' }, { type: 'text', text: 'Checking the map files.' }] } }]));
  assert.equal((await latestPublicUpdate(claudeSource))?.text, 'Checking the map files.');
});

test('live session discovery reads only observed project identities and does not require a full import', async () => {
  const service = new ConversationService({ root, stateDirectory: path.join(directory, 'live-metadata'), codexHome: codex, claudeHome: claude });
  try {
    const items = await service.live([{ provider: 'codex', sessionId: 'codex-one' }, { provider: 'codex', sessionId: 'codex-one' }, { provider: 'claude-code', sessionId: 'claude-one' }]);
    assert.equal(items.length, 2);
    assert.equal(items[0]?.update?.text, 'Use Markdown for readable records.');
    assert.equal(items[1]?.update?.text, 'I will add the session record.');
    assert.equal(service.store.list().total, 0, 'live status does not copy entire transcripts into the archive');
    assert.deepEqual(await service.live([]), []);
    assert.equal((await service.live([{ provider: 'codex', sessionId: 'unobserved-missing' }]))[0]?.update, undefined);
  } finally { service.close(); }
});

test('MCP exposes read-only session history before an architecture index exists', async () => {
  const session = new McpSession({ root, stateDirectory: path.join(directory, 'mcp'), version: 'test' });
  const receive = async (method: string, params: Record<string, unknown>) => await session.receive(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })) as { result: { tools?: { name: string; annotations: { readOnlyHint: boolean } }[]; isError?: boolean; content?: { text: string }[] }; error?: { code: number; message: string } };
  try {
    await receive('initialize', { clientInfo: { name: 'codex' } });
    const tools = (await receive('tools/list', {})).result.tools!;
    assert.deepEqual(tools.map(tool => tool.name), ['overview', 'search_conversations', 'read_conversation']);
    assert.ok(tools.every(tool => tool.annotations.readOnlyHint));
    const result = (await receive('tools/call', { name: 'search_conversations', arguments: {} })).result;
    assert.equal(result.isError, false);
    assert.equal(JSON.parse(result.content![0]!.text).total, 0);
    const removed = await receive('tools/call', { name: 'create_decision', arguments: {} });
    assert.equal(removed.error?.code, -32602);
    assert.match(removed.error!.message, /Unknown tool/);
    assert.equal(session.activity.work, undefined);
  } finally { session.close(); }
});

test('HTTP session routes require write headers, reject writes in read-only mode, and expose source history', async () => {
  assert.equal(isConversationPath('/api/decisions'), false);
  assert.equal(isConversationPath('/api/decisions/old-record'), false);
  const conversations = new ConversationService({ root, stateDirectory: state, codexHome: codex, claudeHome: claude });
  let readOnly = false;
  const server = createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); void handleConversationRoute({ conversations, readOnly, resolve: target => ({ ...target, id: `map:${target.path}`, exact: true }) }, req, res, new URL(req.url!, 'http://localhost')); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    assert.equal((await fetch(`${base}/api/conversations/sync`, { method: 'POST' })).status, 400);
    assert.equal((await fetch(`${base}/api/conversations/sync`, { method: 'POST', headers: { 'X-Codiluce-Request': 'journal' } })).status, 200);
    const page = await (await fetch(`${base}/api/conversations?path=src&action=added`)).json() as { total: number }; assert.equal(page.total, 2);
    const initial = await fetch(`${base}/api/conversations`), etag = initial.headers.get('ETag')!;
    assert.ok(etag); assert.equal((await initial.json() as { scope: string }).scope, conversations.scope);
    assert.equal((await fetch(`${base}/api/conversations`, { headers: { 'If-None-Match': etag } })).status, 304);
    const saved = conversations.store.read('codex:codex-one')!;
    conversations.store.save({ ...saved, title: 'Updated locally' }, 'etag-local', '1');
    const updated = await fetch(`${base}/api/conversations`, { headers: { 'If-None-Match': etag } });
    assert.equal(updated.status, 200); const updatedTag = updated.headers.get('ETag')!;
    const external = new ConversationStore(state);
    try { external.save({ ...saved, title: 'Updated through another process' }, 'etag-external', '2'); } finally { external.close(); }
    const fromMcp = await fetch(`${base}/api/conversations`, { headers: { 'If-None-Match': updatedTag } });
    assert.equal(fromMcp.status, 200);
    assert.equal((await fromMcp.json() as { items: { title: string }[] }).items.some(item => item.title === 'Updated through another process'), true);
    const detail = await (await fetch(`${base}/api/conversations/codex%3Acodex-one?limit=2`)).json() as { messages: unknown[]; totalMessages: number }; assert.equal(detail.messages.length, 2); assert.ok(detail.totalMessages > 2);
    // A replay: every step in order, each call's paths placed on the current map.
    const replay = await (await fetch(`${base}/api/conversations/codex%3Acodex-one/replay`)).json() as ConversationReplay;
    assert.equal(replay.steps.length, saved.totalMessages);
    const call = replay.steps.find(step => step.paths.length)!;
    assert.equal(call.role, 'tool'); assert.equal(call.paths[0]!.id, `map:${call.paths[0]!.path}`); assert.ok(call.paths[0]!.action);
    assert.equal((await fetch(`${base}/api/conversations/codex%3Amissing/replay`)).status, 404);
    readOnly = true;
    assert.equal((await fetch(`${base}/api/conversations`, { headers: { 'If-None-Match': fromMcp.headers.get('ETag')! } })).status, 200, 'capability changes also invalidate the cached page');
    assert.equal((await fetch(`${base}/api/conversations/codex%3Acodex-one/replay`)).status, 200, 'replays are read-only');
    assert.equal((await fetch(`${base}/api/conversations/sync`, { method: 'POST', headers: { 'X-Codiluce-Request': 'journal' } })).status, 403);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); conversations.close(); }
});
