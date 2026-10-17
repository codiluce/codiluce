import { createReadStream } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { AgentProvider } from '../activity/model.js';
import { repositoryPath } from '../activity/normalize.js';
import { conversationId, type CallStatus, type Conversation, type ConversationMessage } from './model.js';
import { toolPaths } from './paths.js';
import { harnessTranscriptSource, importHarnessTranscript } from '../harnesses/history.js';
import { harnessLabel, sessionKey } from '../harnesses/registry.js';

export const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): string => typeof value === 'string' ? value : '';
export const messageText = (content: unknown): string => typeof content === 'string' ? content : Array.isArray(content) ? content.map(block => {
  const item = object(block); return ['text', 'input_text', 'output_text'].includes(text(item.type)) ? text(item.text) : '';
}).filter(Boolean).join('\n') : '';
export interface TranscriptSource { file: string; provider: AgentProvider; sessionId: string; cwd: string; title?: string }

/** Only enumerate provider-owned stores; symlinks and arbitrary paths from clients aren't followed. */
export async function transcriptFiles(directory: string, depth = 0): Promise<string[]> {
  if (depth > 5) return [];
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(file);
    else if (entry.isDirectory()) files.push(...await transcriptFiles(file, depth + 1));
  }
  return files;
}

export async function transcriptSource(root: string, file: string, provider: AgentProvider): Promise<TranscriptSource | undefined> {
  if (!['codex', 'claude-code'].includes(provider) || path.basename(path.dirname(file)) === 'agent-exports') return harnessTranscriptSource(root, file, provider);
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(256 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    for (const line of buffer.subarray(0, bytesRead).toString('utf8').split('\n').slice(0, 80)) {
      let row: Record<string, unknown>; try { row = object(JSON.parse(line)); } catch { continue; }
      const meta = provider === 'codex' ? row.type === 'session_meta' ? object(row.payload) : {} : row;
      const cwd = text(meta.cwd), sessionId = text(meta.session_id ?? meta.sessionId ?? meta.id);
      if (!cwd || !sessionId) continue;
      if (!path.isAbsolute(cwd) || repositoryPath(root, root, cwd) === undefined) return undefined;
      // Claude sidechains share their parent's sessionId; keep them separate.
      const agent = /^(agent-[\w-]+)\.jsonl$/.exec(path.basename(file))?.[1];
      return { file, provider, sessionId: provider === 'claude-code' && agent ? `${sessionId}:${agent}` : sessionId, cwd, title: text(meta.title ?? meta.name) || undefined };
    }
    return undefined;
  } finally { await handle.close(); }
}

function outputStatus(value: unknown, failed = false): CallStatus {
  if (failed) return 'failed';
  const result = object(value);
  if (result.isError === true || result.is_error === true || typeof result.exit_code === 'number' && result.exit_code !== 0) return 'failed';
  if (result.session_id && result.exit_code === undefined) return 'unknown';
  if (typeof value === 'string') {
    try { return outputStatus(JSON.parse(value)); } catch { /* Human-readable tool outputs. */ }
    if (/Script running with cell ID|Process running with session ID/.test(value)) return 'unknown';
    const exit = /(?:Process exited with code|exit_code["']?\s*:)\s*(-?\d+)/i.exec(value);
    if (exit && Number(exit[1]) !== 0 || /^Error:|^Error executing|"isError"\s*:\s*true/.test(value)) return 'failed';
  }
  return 'completed';
}

/** Stream original JSONL. System instructions and reasoning are intentionally excluded. */
export async function importTranscript(root: string, source: TranscriptSource): Promise<Conversation> {
  if (!['codex', 'claude-code'].includes(source.provider) || path.basename(path.dirname(source.file)) === 'agent-exports') return importHarnessTranscript(root, source);
  const conversation: Conversation = { id: conversationId(source.provider, source.sessionId), provider: source.provider, sessionId: source.sessionId, title: source.title ?? '', cwd: source.cwd, excerpt: '', messages: [], paths: [] };
  const calls = new Map<string, { message: ConversationMessage; wrapper: boolean }>();
  const seen = new Set<string>();
  const positions = new Map<string, number>();
  const fallback: ConversationMessage[] = [];
  let cwd = source.cwd, lineNumber = 0, customTitle = '';
  const stream = createReadStream(source.file);
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  const append = (message: ConversationMessage) => {
    if (seen.has(message.id)) return; seen.add(message.id);
    if (!positions.has(message.id)) positions.set(message.id, lineNumber);
    if (message.role === 'tool' && message.text.length > 100_000) { message.truncated = true; message.text = message.text.slice(0, 100_000); }
    conversation.messages.push(message);
  };
  const call = (id: string, name: string, input: unknown, messageId: string, at?: string) => {
    if (!id || calls.has(id)) return;
    const wrapper = /(?:^|\.)exec$/.test(name);
    const message: ConversationMessage = { id: messageId, role: 'tool', text: '', tool: name, callId: id, at, status: 'unknown' };
    calls.set(id, { message, wrapper }); append(message);
    for (const target of toolPaths(root, cwd, name, input)) conversation.paths.push({ ...target, messageId, callId: id, status: 'unknown' });
  };
  const output = (id: string, value: unknown, failed = false, created = false) => {
    const found = calls.get(id); if (!found) return;
    const status = outputStatus(value, failed);
    found.message.status = status;
    const rendered = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
    found.message.text = rendered.slice(0, 100_000);
    if (rendered.length > 100_000) found.message.truncated = true;
    for (const target of conversation.paths.filter(item => item.callId === id)) {
      // A successful orchestration wrapper does not prove each nested call succeeded.
      target.status = found.wrapper ? 'unknown' : status;
      if (created && target.action === 'edited') target.action = 'added';
    }
  };
  try {
    for await (const line of lines) {
      lineNumber++;
      if (line.length > 8 * 1024 * 1024) throw new Error('A transcript event exceeds the 8 MB import limit');
      let row: Record<string, unknown>;
      try { row = object(JSON.parse(line)); } catch { continue; } // Includes a live file's unfinished last line.
      const at = text(row.timestamp) || undefined;
      const id = text(row.uuid) || createHash('sha256').update(`${source.provider}:${source.sessionId}:${row.ordinal ?? lineNumber}`).digest('hex').slice(0, 24);
      if (at && !Number.isNaN(Date.parse(at))) { conversation.startedAt ??= at; if (!conversation.updatedAt || at > conversation.updatedAt) conversation.updatedAt = at; }
      if (source.provider === 'codex') {
        const item = object(row.payload);
        if (row.type === 'turn_context' && typeof item.cwd === 'string') cwd = path.resolve(item.cwd);
        if (row.type === 'event_msg' && ['user_message', 'agent_message'].includes(text(item.type))) { fallback.push({ id, role: item.type === 'user_message' ? 'user' : 'assistant', text: text(item.message), at }); positions.set(id, lineNumber); }
        if (row.type !== 'response_item') continue;
        if (item.type === 'message' && ['user', 'assistant'].includes(text(item.role)) && (!item.channel || ['commentary', 'final'].includes(text(item.channel)))) {
          const content = messageText(item.content); if (content) append({ id: text(item.id) || id, role: item.role as 'user' | 'assistant', text: content, at });
        } else if (item.type === 'function_call' || item.type === 'custom_tool_call') {
          let input: unknown = item.input ?? item.arguments;
          if (typeof input === 'string') { try { input = JSON.parse(input); } catch { /* Freeform calls. */ } }
          call(text(item.call_id ?? item.id), text(item.name), input, text(item.id) || id, at);
        } else if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') output(text(item.call_id), item.output);
      } else {
        if (typeof row.cwd === 'string') cwd = path.resolve(row.cwd);
        if (row.type === 'custom-title') customTitle = text(row.customTitle ?? row.title);
        if (row.type === 'ai-title' || row.type === 'custom-title') conversation.title = customTitle || text(row.title ?? row.aiTitle) || conversation.title;
        if (!['user', 'assistant'].includes(text(row.type))) continue;
        const message = object(row.message);
        const content = messageText(message.content);
        if (content && row.isMeta !== true) append({ id, role: row.type as 'user' | 'assistant', text: content, at });
        if (Array.isArray(message.content)) for (const [index, block] of message.content.entries()) {
          const item = object(block);
          if (item.type === 'tool_use') call(text(item.id), text(item.name), item.input, `${id}:tool:${index}`, at);
          if (item.type === 'tool_result') {
            const result = object(row.toolUseResult);
            const rendered = messageText(item.content);
            output(text(item.tool_use_id), rendered, item.is_error === true, result.type === 'create' || /^File created successfully at:/.test(rendered));
          }
        }
      }
      if (conversation.messages.length > 100_000) throw new Error('A transcript exceeds the 100,000 message import limit');
    }
  } finally { lines.close(); stream.destroy(); }
  for (const role of ['user', 'assistant'] as const) if (!conversation.messages.some(message => message.role === role)) for (const message of fallback.filter(message => message.role === role)) append(message);
  conversation.messages.sort((a, b) => (positions.get(a.id) ?? 0) - (positions.get(b.id) ?? 0));
  const first = conversation.messages.find(message => message.role === 'user' && !/^# AGENTS\.md instructions|^<environment_context>|^<INSTRUCTIONS>/.test(message.text))?.text ?? '';
  conversation.title ||= first.replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 140) || `${harnessLabel(source.provider)} · ${source.sessionId.slice(0, 12)}`;
  conversation.excerpt = first.replace(/\s+/g, ' ').slice(0, 220);
  return conversation;
}
