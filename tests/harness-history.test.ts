import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { harnessTranscriptSource, importHarnessTranscript, importSessionExport } from '../src/harnesses/history.js';
import { ConversationService } from '../src/conversations/service.js';
import { latestPublicUpdate } from '../src/conversations/live.js';
import { HARNESS_IDS, sessionKey, type HarnessId } from '../src/harnesses/registry.js';

let directory: string, root: string, state: string;
before(async () => { directory = await mkdtemp(path.join(tmpdir(), 'codiluce-harness-history-')); root = path.join(directory, 'repo'); state = path.join(directory, 'state'); await mkdir(path.join(root, 'src'), { recursive: true }); await mkdir(state); await writeFile(path.join(root, 'src/a.ts'), 'export const a = 1;'); });
after(async () => { await rm(directory, { recursive: true, force: true }); });
const at = '2026-10-17T10:00:00.000Z';
const jsonl = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join('\n') + '\n';

test('Pi tree imports only the selected branch, excludes private blocks, and preserves tool failure', async () => {
  const file = path.join(directory, 'pi.jsonl');
  await writeFile(file, jsonl([
    { type: 'session', version: 3, id: 'pi-branch', cwd: root },
    { type: 'message', id: 'root', parentId: null, timestamp: at, message: { role: 'user', content: 'Inspect the branch.' } },
    { type: 'message', id: 'abandoned', parentId: 'root', timestamp: at, message: { role: 'assistant', content: [{ type: 'text', text: 'Abandoned answer.' }] } },
    { type: 'message', id: 'chosen', parentId: 'root', timestamp: at, message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'PRIVATE' }, { type: 'text', text: 'Current branch.' }, { type: 'toolCall', id: 'read', name: 'read', arguments: { path: 'src/a.ts' } }] } },
    { type: 'message', id: 'result', parentId: 'chosen', timestamp: at, message: { role: 'toolResult', toolCallId: 'read', isError: true, content: [{ type: 'text', text: 'Read failed.' }] } },
  ]));
  const source = (await harnessTranscriptSource(root, file, 'pi'))!; assert.ok(source);
  const conversation = await importHarnessTranscript(root, source);
  assert.equal(conversation.messages.some(message => /PRIVATE|Abandoned/.test(message.text)), false);
  assert.equal(conversation.messages.find(message => message.role === 'assistant')!.text, 'Current branch.');
  assert.deepEqual(conversation.paths.map(item => [item.path, item.status]), [['src/a.ts', 'failed']]);
  assert.equal((await latestPublicUpdate(source))!.text, 'Current branch.');
  await writeFile(file, jsonl([{ type: 'session', version: 3, id: 'foreign', cwd: directory }]));
  assert.equal(await harnessTranscriptSource(root, file, 'pi'), undefined);
});

test('Copilot and Gemini native formats retain visible messages and actual tool paths', async () => {
  const copilot = path.join(directory, 'events.jsonl');
  await writeFile(copilot, jsonl([
    { type: 'session.start', data: { sessionId: 'copilot', context: { cwd: root } }, id: 'start', timestamp: at },
    { type: 'user.message', data: { content: 'Trace a file.' }, id: 'user', timestamp: at },
    { type: 'assistant.reasoning', data: { content: 'PRIVATE' }, id: 'private', timestamp: at },
    { type: 'tool.execution_start', data: { toolCallId: 'read', toolName: 'view_file', arguments: { path: 'src/a.ts' } }, id: 'tool', timestamp: at },
    { type: 'tool.execution_complete', data: { toolCallId: 'read', success: true, result: { content: 'A file.' } }, id: 'result', timestamp: at },
    { type: 'assistant.message', data: { content: 'This is the file.' }, id: 'assistant', timestamp: at },
  ]));
  const source = (await harnessTranscriptSource(root, copilot, 'github-copilot'))!;
  const conversation = await importHarnessTranscript(root, source);
  assert.equal(conversation.messages.length, 3); assert.equal(conversation.paths[0]!.status, 'completed');
  assert.equal((await latestPublicUpdate(source))!.text, 'This is the file.');
  const hash = createHash('sha256').update(root).digest('hex'), chats = path.join(directory, hash, 'chats'); await mkdir(chats, { recursive: true });
  const gemini = path.join(chats, 'session-gemini.json');
  await writeFile(gemini, JSON.stringify({ sessionId: 'gemini', projectHash: hash, messages: [
    { id: 'user', type: 'user', timestamp: at, content: 'Explain the file.' },
    { id: 'assistant', type: 'gemini', timestamp: at, thoughts: [{ text: 'PRIVATE' }], content: [{ text: 'Answer.' }, { text: 'PRIVATE', thought: true }], toolCalls: [{ id: 'read', name: 'read_file', args: { file_path: 'src/a.ts' }, status: 'success', result: [{ text: 'A file.' }] }] },
  ] }));
  const geminiSource = (await harnessTranscriptSource(root, gemini, 'gemini-cli'))!;
  assert.ok(geminiSource); const imported = await importHarnessTranscript(root, geminiSource);
  assert.equal(imported.messages.some(message => message.text.includes('PRIVATE')), false); assert.equal(imported.paths[0]!.path, 'src/a.ts');
  assert.equal((await latestPublicUpdate(geminiSource))!.text, 'Answer.');
});

test('portable exports serve all twelve harnesses and reject wrong identities and repository escapes', async () => {
  for (const provider of HARNESS_IDS) {
    const file = path.join(directory, `${provider}-export.json`);
    await writeFile(file, JSON.stringify({ schemaVersion: 1, provider, sessionId: 'export:session', cwd: root, messages: [
      { id: 'system', role: 'system', text: 'PRIVATE system' },
      { id: 'user', role: 'user', text: `Explain with ${provider}.`, at },
      { id: 'thought', role: 'assistant', channel: 'analysis', text: 'PRIVATE reasoning' },
      { role: 'tool', callId: 'read', tool: 'read_file', input: { path: 'src/a.ts' }, text: 'A file.', status: 'completed', at },
      { id: 'assistant', role: 'assistant', text: 'Public answer.', at },
    ] }));
    const imported = await importSessionExport(provider, root, state, file);
    assert.equal(imported.id, sessionKey(provider, 'export:session')); assert.equal(imported.messages, 3);
    assert.doesNotMatch(await readFile(imported.path, 'utf8'), /PRIVATE/);
  }
  const service = new ConversationService({ root, stateDirectory: state, codexHome: path.join(directory, 'empty-codex'), claudeHome: path.join(directory, 'empty-claude'), harnessHomes: Object.fromEntries(HARNESS_IDS.map(id => [id, path.join(directory, `empty-${id}`)])) });
  try { const result = await service.sync(); assert.equal(result.errors.length, 0); assert.equal(service.store.list({ limit: 100 }).items.length, 12); assert.equal(service.store.read(sessionKey('pi', 'export:session'))!.paths[0]!.path, 'src/a.ts'); }
  finally { service.close(); }
  const bad = path.join(directory, 'bad.json'); await writeFile(bad, JSON.stringify({ schemaVersion: 1, provider: 'pi', sessionId: 'escape', cwd: directory, messages: [] }));
  await assert.rejects(importSessionExport('pi', root, state, bad), /Expected a version/);
});

test('OpenCode native export imports explicit session metadata and tool parts without reasoning', async () => {
  const file = path.join(directory, 'opencode-export.json');
  await writeFile(file, JSON.stringify({ info: { id: 'oc', directory: root, title: 'Native export' }, messages: [{ info: { id: 'user', role: 'user' }, parts: [{ type: 'text', text: 'Inspect.' }] }, { info: { id: 'assistant', role: 'assistant' }, parts: [{ type: 'reasoning', text: 'PRIVATE' }, { type: 'text', text: 'Public answer.' }, { type: 'tool', tool: 'read', callID: 'one', state: { status: 'completed', input: { filePath: 'src/a.ts' }, output: 'A file.' } }] }] }));
  const result = await importSessionExport('opencode', root, state, file);
  assert.equal(result.id, 'opencode:oc'); assert.doesNotMatch(await readFile(result.path, 'utf8'), /PRIVATE/);
});
