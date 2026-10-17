import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, writeFile } from 'node:fs/promises';
import { harness, isHarnessId, sessionKey, type HarnessId } from './registry.js';
import { userPath } from './setup.js';
import { repositoryPath } from '../activity/normalize.js';
import { toolPaths } from '../conversations/paths.js';
import { toolObservation } from './activity.js';
import type { TranscriptSource } from '../conversations/import.js';
import type { Conversation, ConversationMessage, CallStatus } from '../conversations/model.js';
import { ConversationStore } from '../conversations/store.js';

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): string => typeof value === 'string' ? value : '';
const visibleText = (value: unknown): string => typeof value === 'string' ? value : Array.isArray(value) ? value.map(item => { const block = object(item); return block.thought !== true && (['text', 'input_text', 'output_text'].includes(text(block.type)) || !block.type && typeof block.text === 'string') ? text(block.text) : ''; }).filter(Boolean).join('\n') : '';
const MAX_BYTES = 32 * 1024 * 1024;

async function safeRead(file: string): Promise<string> {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_BYTES) throw new Error('Session source must be a regular file of at most 32 MB');
  return readFile(file, 'utf8');
}
async function prefix(file: string): Promise<string> {
  const info = await lstat(file); if (!info.isFile() || info.isSymbolicLink()) return '';
  const handle = await open(file, 'r');
  try { const buffer = Buffer.alloc(256 * 1024); const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0); return buffer.subarray(0, bytesRead).toString('utf8'); }
  finally { await handle.close(); }
}
function jsonLines(content: string): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const line of content.split('\n')) {
    if (line.length > 8 * 1024 * 1024) throw new Error('Session event exceeds the 8 MB import limit');
    try { rows.push(object(JSON.parse(line))); } catch { /* A live final line may not be complete. */ }
    if (rows.length > 100_000) throw new Error('Session exceeds the 100,000 entry import limit');
  }
  return rows;
}
function scoped(root: string, cwd: unknown): cwd is string { return typeof cwd === 'string' && path.isAbsolute(cwd) && repositoryPath(root, root, cwd) !== undefined; }

/** Native metadata is checked before importing message content. */
export async function harnessTranscriptSource(root: string, file: string, provider: HarnessId): Promise<TranscriptSource | undefined> {
  const head = await prefix(file), rows = jsonLines(head).slice(0, 80);
  for (const row of rows) {
    if (row.schemaVersion === 1 && row.provider === provider && typeof row.sessionId === 'string' && scoped(root, row.cwd)) return { file, provider, sessionId: row.sessionId, cwd: row.cwd, title: text(row.title) || undefined };
    if (['pi', 'openclaw'].includes(provider) && row.type === 'session' && typeof row.id === 'string' && scoped(root, row.cwd)) return { file, provider, sessionId: row.id, cwd: row.cwd };
    if (provider === 'github-copilot' && row.type === 'session.start') {
      const meta = object(row.data), cwd = object(meta.context).cwd;
      if (scoped(root, cwd) && typeof meta.sessionId === 'string') return { file, provider, sessionId: meta.sessionId, cwd };
      return undefined;
    }
  }
  if (provider === 'gemini-cli') {
    const hash = createHash('sha256').update(root).digest('hex');
    // Only the directory belonging to this exact repository/worktree is scanned.
    if (path.basename(path.dirname(path.dirname(file))) !== hash) return undefined;
    const meta = rows.find(row => typeof row.sessionId === 'string' && row.projectHash === hash) ?? object((() => { try { return JSON.parse(head); } catch { return {}; } })());
    if (meta.projectHash === hash && typeof meta.sessionId === 'string') return { file, provider, sessionId: meta.sessionId, cwd: root, title: text(meta.summary) || undefined };
    // Older JSON files can exceed the metadata prefix. Inspect only a bounded full file.
    if (file.endsWith('.json')) {
      const data = object(JSON.parse(await safeRead(file)));
      if (data.projectHash === hash && typeof data.sessionId === 'string') return { file, provider, sessionId: data.sessionId, cwd: root, title: text(data.summary) || undefined };
    }
  }
  if (file.endsWith('.json') && path.basename(path.dirname(file)) === 'agent-exports') {
    const row = object(JSON.parse(await safeRead(file)));
    if (row.schemaVersion === 1 && row.provider === provider && typeof row.sessionId === 'string' && scoped(root, row.cwd)) return { file, provider, sessionId: row.sessionId, cwd: row.cwd, title: text(row.title) || undefined };
  }
  return undefined;
}

export async function sessionFiles(directory: string, depth = 0): Promise<string[]> {
  if (depth > 5) return [];
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []), files: string[] = [];
  for (const entry of entries) {
    if (files.length >= 5000) break;
    const file = path.join(directory, entry.name);
    if (entry.isFile() && /\.(jsonl|json)$/.test(entry.name)) files.push(file);
    else if (entry.isDirectory()) files.push(...await sessionFiles(file, depth + 1));
  }
  return files.slice(0, 5000);
}
export function historyDirectories(root: string, stateDirectory: string, homes: Partial<Record<HarnessId, string>> = {}): [HarnessId, string][] {
  const home = (id: HarnessId) => homes[id] ?? userPath(id, harness(id).home);
  return [
    ['pi', path.join(home('pi'), 'sessions')],
    ['openclaw', path.join(home('openclaw'), 'agents')],
    ['github-copilot', path.join(home('github-copilot'), 'session-state')],
    ['gemini-cli', path.join(home('gemini-cli'), 'tmp', createHash('sha256').update(root).digest('hex'), 'chats')],
  ];
}

function conversationBuilder(root: string, source: Pick<TranscriptSource, 'provider' | 'sessionId' | 'cwd' | 'title'>) {
  const conversation: Conversation = { id: sessionKey(source.provider, source.sessionId), provider: source.provider, sessionId: source.sessionId, cwd: source.cwd, title: source.title || '', excerpt: '', messages: [], paths: [] };
  const seen = new Set<string>(), calls = new Map<string, ConversationMessage>();
  const append = (message: ConversationMessage) => {
    if (seen.has(message.id)) return; seen.add(message.id);
    if (conversation.messages.length >= 100_000) throw new Error('Session exceeds the 100,000 message import limit');
    if (message.text.length > 100_000) { message.truncated = true; message.text = message.text.slice(0, 100_000); }
    conversation.messages.push(message);
    if (message.at && Number.isFinite(Date.parse(message.at))) { conversation.startedAt ??= message.at; conversation.updatedAt = message.at; }
  };
  const call = (id: string, name: string, input: unknown, at?: string) => {
    if (!id || calls.has(id)) return;
    const message: ConversationMessage = { id: `tool:${id}`, role: 'tool', text: '', tool: name, callId: id, status: 'unknown', at };
    calls.set(id, message); append(message);
    const mapped = toolObservation(name, input);
    for (const item of toolPaths(root, source.cwd, mapped.name, mapped.input)) conversation.paths.push({ ...item, callId: id, messageId: message.id, status: 'unknown' });
  };
  const result = (id: string, content: unknown, status: CallStatus) => {
    const message = calls.get(id); if (!message) return;
    const rendered = visibleText(content);
    message.text = rendered.slice(0, 100_000); message.truncated = rendered.length > 100_000 || undefined; message.status = status;
    for (const item of conversation.paths) if (item.callId === id) item.status = status;
  };
  const finish = () => {
    const first = conversation.messages.find(item => item.role === 'user')?.text ?? '';
    conversation.title ||= first.replace(/\s+/g, ' ').slice(0, 140) || `${harness(source.provider).label} · ${source.sessionId.slice(0, 12)}`;
    conversation.excerpt = first.replace(/\s+/g, ' ').slice(0, 220);
    return conversation;
  };
  return { append, call, result, finish };
}

export async function importHarnessTranscript(root: string, source: TranscriptSource): Promise<Conversation> {
  if (!scoped(root, source.cwd)) throw new Error('Session does not belong to this repository');
  const content = await safeRead(source.file), builder = conversationBuilder(root, source);
  let whole: Record<string, unknown> = {};
  try { whole = object(JSON.parse(content)); } catch { /* Native JSONL. */ }
  if (whole.schemaVersion === 1) {
    if (whole.provider !== source.provider || whole.sessionId !== source.sessionId || !scoped(root, whole.cwd) || !Array.isArray(whole.messages)) throw new Error('Invalid Codiluce session export');
    for (const [index, raw] of whole.messages.entries()) {
      const row = object(raw), role = text(row.role), at = text(row.at) || undefined;
      if (['user', 'assistant'].includes(role) && (!row.channel || ['commentary', 'final'].includes(text(row.channel)))) builder.append({ id: text(row.id) || `message:${index}`, role: role as 'user' | 'assistant', text: visibleText(row.text ?? row.content), at });
      if (role === 'tool' && typeof row.callId === 'string' && typeof row.tool === 'string') { builder.call(row.callId, row.tool, row.input, at); builder.result(row.callId, row.text ?? row.content, row.status === 'completed' ? 'completed' : row.status === 'failed' ? 'failed' : 'unknown'); }
    }
    return builder.finish();
  }
  let rows = jsonLines(content);
  if (['pi', 'openclaw'].includes(source.provider)) {
    const header = rows.find(row => row.type === 'session');
    if (!header || header.id !== source.sessionId || !scoped(root, header.cwd)) throw new Error('Session metadata changed or belongs to another repository');
    if (header?.version !== undefined && ![1, 2, 3].includes(Number(header.version))) throw new Error('Unsupported session tree version');
    const byId = new Map(rows.filter(row => typeof row.id === 'string' && row.type !== 'session').map(row => [text(row.id), row]));
    let leaf = rows.filter(row => typeof row.id === 'string' && row.type !== 'session').at(-1);
    const branch: Record<string, unknown>[] = [], visited = new Set<string>();
    while (leaf) {
      const id = text(leaf.id); if (visited.has(id)) throw new Error('Invalid cyclic session tree'); visited.add(id); branch.push(leaf);
      leaf = typeof leaf.parentId === 'string' ? byId.get(leaf.parentId) : undefined;
    }
    rows = branch.reverse();
    for (const row of rows) {
      if (row.type !== 'message') continue;
      const msg = object(row.message), role = text(msg.role), at = text(row.timestamp) || undefined;
      if (['user', 'assistant'].includes(role)) {
        const message = visibleText(msg.content); if (message) builder.append({ id: text(row.id), role: role as 'user' | 'assistant', text: message, at });
      }
      if (Array.isArray(msg.content)) for (const block of msg.content.map(object)) if (block.type === 'toolCall') builder.call(text(block.id), text(block.name), block.arguments, at);
      if (role === 'toolResult') builder.result(text(msg.toolCallId), msg.content, msg.isError === true ? 'failed' : 'completed');
    }
  } else if (source.provider === 'github-copilot') {
    const header = object(rows.find(row => row.type === 'session.start')?.data);
    if (header.sessionId !== source.sessionId || !scoped(root, object(header.context).cwd)) throw new Error('Session metadata changed or belongs to another repository');
    for (const row of rows) {
      const data = object(row.data), at = text(row.timestamp) || undefined, id = text(row.id);
      if (row.type === 'user.message' || row.type === 'assistant.message') builder.append({ id, role: row.type === 'user.message' ? 'user' : 'assistant', text: text(data.content), at });
      if (row.type === 'tool.execution_start') builder.call(text(data.toolCallId), text(data.toolName), data.arguments, at);
      if (row.type === 'tool.execution_complete') builder.result(text(data.toolCallId), object(data.result).content ?? object(data.result).textResultForLlm, data.success === false ? 'failed' : data.success === true ? 'completed' : 'unknown');
    }
  } else if (source.provider === 'gemini-cli') {
    if (Array.isArray(whole.messages)) rows = whole.messages.map(object);
    else {
      // Gemini JSONL can patch metadata or rewind the visible message sequence.
      const messages: Record<string, unknown>[] = [];
      for (const row of rows) {
        if (typeof row.$rewindTo === 'string') { const index = messages.findIndex(item => item.id === row.$rewindTo); if (index >= 0) messages.splice(index + 1); }
        else if (row.type) messages.push(row);
      }
      rows = messages;
    }
    for (const row of rows) {
      const at = text(row.timestamp) || undefined;
      if (row.type === 'user' || row.type === 'gemini') builder.append({ id: text(row.id), role: row.type === 'user' ? 'user' : 'assistant', text: visibleText(row.content), at });
      if (Array.isArray(row.toolCalls)) for (const item of row.toolCalls.map(object)) { const id = text(item.id); builder.call(id, text(item.name), item.args, at); builder.result(id, item.result, item.status === 'success' ? 'completed' : item.status === 'error' || item.status === 'cancelled' ? 'failed' : 'unknown'); }
    }
  } else throw new Error('Use a Codiluce session export for this harness');
  return builder.finish();
}

/** Explicit imports may accept native OpenCode exports; other products use the documented portable envelope. */
export async function importSessionExport(provider: HarnessId, root: string, stateDirectory: string, file: string): Promise<{ id: string; messages: number; path: string }> {
  const content = await safeRead(file);
  let data = object(JSON.parse(content));
  if (provider === 'opencode' && data.info && Array.isArray(data.messages)) {
    const info = object(data.info), cwd = object(info.directory).cwd ?? info.directory;
    if (!scoped(root, cwd)) throw new Error('OpenCode export belongs to another repository');
    const messages: unknown[] = [];
    for (const row of data.messages.map(object)) {
      const meta = object(row.info), parts = Array.isArray(row.parts) ? row.parts.map(object) : [], role = text(meta.role);
      const time = Number(object(meta.time).created), at = Number.isFinite(time) ? new Date(time).toISOString() : undefined;
      if (['user', 'assistant'].includes(role)) messages.push({ id: meta.id, role, text: parts.filter(part => part.type === 'text').map(part => text(part.text)).join('\n'), at });
      for (const part of parts) if (part.type === 'tool') { const state = object(part.state); messages.push({ role: 'tool', tool: part.tool, callId: part.callID, input: state.input, text: state.output, status: state.status === 'completed' ? 'completed' : state.status === 'error' ? 'failed' : 'unknown', at }); }
    }
    data = { schemaVersion: 1, provider, sessionId: info.id, cwd, title: info.title, messages };
  }
  if (data.schemaVersion !== 1 || data.provider !== provider || !isHarnessId(data.provider) || typeof data.sessionId !== 'string' || !data.sessionId || !scoped(root, data.cwd) || !Array.isArray(data.messages)) throw new Error('Expected a version 1 Codiluce session export with matching provider, sessionId, cwd and messages');
  const directory = path.join(stateDirectory, 'agent-exports'); await mkdir(directory, { recursive: true });
  const destination = path.join(directory, `${createHash('sha256').update(sessionKey(provider, data.sessionId)).digest('hex')}.json`);
  // Export only public messages and literal tool arguments needed for file associations.
  const input = path.join(directory, `.import-${randomUUID()}.json`);
  await writeFile(input, JSON.stringify(data), { mode: 0o600, flag: 'wx' });
  try {
    const source = { file: input, provider, sessionId: data.sessionId, cwd: data.cwd, title: text(data.title) || undefined };
    const conversation = await importHarnessTranscript(root, source);
    const publicExport = { schemaVersion: 1, provider, sessionId: data.sessionId, cwd: data.cwd, title: conversation.title, messages: data.messages.filter(raw => { const row = object(raw); return ['user', 'assistant', 'tool'].includes(text(row.role)) && (!row.channel || ['commentary', 'final'].includes(text(row.channel))); }).map(raw => {
      const row = object(raw), args = toolObservation(text(row.tool), row.input).input;
      const observedInput = Object.fromEntries(['file_path', 'path', 'paths', 'directory', 'workdir', 'pattern', 'query', 'command'].flatMap(key => args[key] !== undefined ? [[key, args[key]]] : []));
      return { id: row.id, role: row.role, text: visibleText(row.text ?? row.content), at: row.at, ...(row.role === 'tool' ? { callId: row.callId, tool: row.tool, input: observedInput, status: row.status } : {}) };
    }) };
    await writeFile(destination, JSON.stringify(publicExport) + '\n', { mode: 0o600 });
    const store = new ConversationStore(stateDirectory);
    try { store.save(conversation, destination, `${(await lstat(destination)).size}:${(await lstat(destination)).mtimeMs}`); } finally { store.close(); }
    return { id: conversation.id, messages: conversation.messages.length, path: destination };
  } finally { const { unlink } = await import('node:fs/promises'); await unlink(input).catch(() => undefined); }
}

/** Extract only visible messages from a bounded native transcript tail. */
export function harnessPublicTail(provider: HarnessId, content: string): { role: 'user' | 'assistant'; content: string; at?: string }[] {
  let whole: Record<string, unknown> = {}; try { whole = object(JSON.parse(content)); } catch { /* JSONL. */ }
  let rows = jsonLines(content);
  if (Array.isArray(whole.messages)) rows = whole.messages.map(object);
  if (['pi', 'openclaw'].includes(provider) && !whole.schemaVersion) {
    const byId = new Map(rows.filter(row => row.type !== 'session').map(row => [text(row.id), row]));
    let leaf = rows.filter(row => typeof row.id === 'string' && row.type !== 'session').at(-1);
    const branch = [], seen = new Set<string>();
    while (leaf && !seen.has(text(leaf.id))) { seen.add(text(leaf.id)); branch.push(leaf); leaf = byId.get(text(leaf.parentId)); }
    rows = branch.reverse();
  }
  return rows.flatMap(row => {
    let role = '', value: unknown;
    if (whole.schemaVersion === 1) { role = text(row.role); value = row.text ?? row.content; }
    else if (['pi', 'openclaw'].includes(provider) && row.type === 'message') { const message = object(row.message); role = text(message.role); value = message.content; }
    else if (provider === 'github-copilot') { role = row.type === 'user.message' ? 'user' : row.type === 'assistant.message' ? 'assistant' : ''; value = object(row.data).content; }
    else if (provider === 'gemini-cli') { role = row.type === 'user' ? 'user' : row.type === 'gemini' ? 'assistant' : ''; value = row.content; }
    if (!['user', 'assistant'].includes(role) || row.channel && !['commentary', 'final'].includes(text(row.channel))) return [];
    return [{ role: role as 'user' | 'assistant', content: visibleText(value), at: text(row.timestamp ?? row.at) || undefined }];
  });
}
