import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { messageText, object, type TranscriptSource } from './import.js';
import { isSessionSetup } from './presentation.js';
import type { SessionUpdate } from './model.js';
import { harnessPublicTail } from '../harnesses/history.js';
import path from 'node:path';

/** A bounded tail keeps live updates cheap even for transcripts hundreds of MB long. */
export async function latestPublicUpdate(source: TranscriptSource): Promise<SessionUpdate | undefined> {
  const handle = await open(source.file, 'r');
  try {
    const size = (await handle.stat()).size, start = Math.max(0, size - 512 * 1024);
    const buffer = Buffer.alloc(size - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n');
    if (start) lines.shift(); // Never parse a partial first event.
    let latest: SessionUpdate | undefined;
    if (!['codex', 'claude-code'].includes(source.provider) || path.basename(path.dirname(source.file)) === 'agent-exports') {
      for (const item of harnessPublicTail(source.provider, lines.join('\n'))) {
        if (item.role === 'user') latest = undefined;
        else if (item.content.trim()) latest = { id: createHash('sha256').update(`${item.at ?? ''}:${item.content}`).digest('hex').slice(0, 24), text: item.content.slice(0, 4000), ...(item.at ? { at: item.at } : {}) };
      }
      return latest;
    }
    for (const line of lines) {
      let row: Record<string, unknown>; try { row = object(JSON.parse(line)); } catch { continue; }
      let role: string | undefined, content = '';
      if (source.provider === 'codex') {
        const item = object(row.payload);
        if (row.type === 'response_item' && item.type === 'message' && (!item.channel || ['commentary', 'final'].includes(String(item.channel)))) { role = String(item.role); content = messageText(item.content); }
        if (row.type === 'event_msg' && ['user_message', 'agent_message'].includes(String(item.type))) { role = item.type === 'user_message' ? 'user' : 'assistant'; content = typeof item.message === 'string' ? item.message : ''; }
      } else if (['user', 'assistant'].includes(String(row.type)) && row.isMeta !== true) { role = String(row.type); content = messageText(object(row.message).content); }
      if (!content.trim()) continue;
      // A new request must not keep showing an answer from the preceding turn.
      if (role === 'user' && !isSessionSetup({ role: 'user', text: content }, source.provider)) latest = undefined;
      if (role !== 'assistant') continue;
      const at = typeof row.timestamp === 'string' ? row.timestamp : undefined;
      latest = { id: createHash('sha256').update(`${at ?? ''}:${content}`).digest('hex').slice(0, 24), text: content.slice(0, 4000), ...(at ? { at } : {}) };
    }
    return latest;
  } finally { await handle.close(); }
}
