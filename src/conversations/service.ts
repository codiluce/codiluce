import os from 'node:os';
import path from 'node:path';
import { stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { transcriptFiles, transcriptSource, importTranscript } from './import.js';
import { ConversationStore } from './store.js';
import type { ImportResult } from './model.js';
import type { AgentProvider } from '../activity/model.js';
import type { LiveSession, SessionUpdate } from './model.js';
import { latestPublicUpdate } from './live.js';
import { createHash } from 'node:crypto';

export interface ConversationOptions { root: string; stateDirectory: string; readOnly?: boolean; codexHome?: string; claudeHome?: string }
export class ConversationService {
  readonly store: ConversationStore;
  readonly scope: string;
  private pending?: Promise<ImportResult>;
  private importingAll = false;
  private closed = false;
  private liveFiles?: { at: number; files: [AgentProvider, string][] };
  private liveCache = new Map<string, { stamp: string; update?: SessionUpdate }>();
  constructor(readonly options: ConversationOptions) {
    this.store = new ConversationStore(options.stateDirectory, options.readOnly);
    this.scope = createHash('sha256').update(JSON.stringify([path.resolve(options.root), path.resolve(options.stateDirectory)])).digest('hex').slice(0, 24);
  }
  close(): void { this.closed = true; this.store.close(); this.liveCache.clear(); }
  async live(sessions: { provider: AgentProvider; sessionId: string }[]): Promise<LiveSession[]> {
    if (this.closed || !sessions.length) return [];
    const codex = this.options.codexHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
    const claude = this.options.claudeHome ?? process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
    if (!this.liveFiles || Date.now() - this.liveFiles.at > 5000) {
      const files: [AgentProvider, string][] = [];
      for (const [provider, directory] of [['codex', path.join(codex, 'sessions')], ['claude-code', path.join(claude, 'projects')]] as const) for (const file of await transcriptFiles(directory)) files.push([provider, file]);
      this.liveFiles = { at: Date.now(), files };
    }
    const result: LiveSession[] = [];
    for (const session of sessions.slice(0, 100)) {
      const id = `${session.provider}:${session.sessionId}`;
      if (result.some(item => item.id === id)) continue;
      const candidates = this.liveFiles.files.filter(([provider, file]) => provider === session.provider && (path.basename(file) === `${session.sessionId}.jsonl` || path.basename(file).endsWith(`-${session.sessionId}.jsonl`)));
      let update: SessionUpdate | undefined;
      for (const [, file] of candidates) {
        try {
          const info = await stat(file), stamp = `${info.size}:${info.mtimeMs}`;
          let cached = this.liveCache.get(file);
          if (cached?.stamp !== stamp) {
            const source = await transcriptSource(this.options.root, file, session.provider);
            if (!source || source.sessionId !== session.sessionId) continue;
            cached = { stamp, update: await latestPublicUpdate(source) }; this.liveCache.set(file, cached);
          }
          if (cached.update && (!update || (cached.update.at ?? '') >= (update.at ?? ''))) update = cached.update;
        } catch { /* A session may rotate or replace its transcript while it is running. */ }
      }
      result.push({ id, provider: session.provider, sessionId: session.sessionId, ...(update ? { update } : {}) });
    }
    while (this.liveCache.size > 100) this.liveCache.delete(this.liveCache.keys().next().value!);
    return result;
  }
  sync(sessions?: { provider: AgentProvider; sessionId: string }[]): Promise<ImportResult> {
    if (this.options.readOnly) return Promise.reject(new Error('Conversation history is read-only'));
    if (this.closed) return Promise.reject(new Error('Conversation history is closed'));
    if (this.pending) {
      // A manual full import must not be satisfied by an in-flight live-only refresh.
      if (!sessions && !this.importingAll) return this.pending.then(() => this.sync());
      return this.pending;
    }
    this.importingAll = sessions === undefined;
    return this.pending = this.import(sessions).finally(() => { this.pending = undefined; });
  }
  private async import(sessions?: { provider: AgentProvider; sessionId: string }[]): Promise<ImportResult> {
    const result: ImportResult = { imported: 0, unchanged: 0, skipped: 0, errors: [] };
    if (sessions && !sessions.length) return result;
    const codex = this.options.codexHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
    const claude = this.options.claudeHome ?? process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
    const titles = new Map<string, string>();
    const index = path.join(codex, 'session_index.jsonl');
    if ((await stat(index).catch(() => undefined))?.isFile()) {
      const lines = createInterface({ input: createReadStream(index), crlfDelay: Infinity });
      try { for await (const line of lines) { try { const row = JSON.parse(line); if (typeof row.id === 'string' && typeof row.thread_name === 'string') titles.set(row.id, row.thread_name.slice(0, 200)); } catch { /* Partial index line. */ } } } finally { lines.close(); }
    }
    const sources = [['codex', path.join(codex, 'sessions')], ['codex', path.join(codex, 'archived_sessions')], ['claude-code', path.join(claude, 'projects')]] as const;
    for (const [provider, directory] of sources) for (const file of await transcriptFiles(directory)) {
      // Live refresh only reads transcripts named for sessions observed by this server.
      // Other project history is imported through the explicit refresh action.
      if (sessions && !sessions.some(session => session.provider === provider && (path.basename(file) === `${session.sessionId}.jsonl` || path.basename(file).endsWith(`-${session.sessionId}.jsonl`)))) continue;
      try {
        const info = await stat(file); const titleKey = provider === 'codex' ? /([a-f\d-]{36})\.jsonl$/.exec(file)?.[1] : undefined;
        const title = titleKey ? titles.get(titleKey) : undefined;
        const stamp = `${info.size}:${info.mtimeMs}:${title ?? ''}`;
        if (this.store.stamp(file) === stamp) { result.unchanged++; continue; }
        const source = await transcriptSource(this.options.root, file, provider);
        if (!source) { result.skipped++; continue; }
        source.title = title ?? source.title;
        const conversation = await importTranscript(this.options.root, source);
        if (this.closed) return result;
        this.store.save(conversation, file, stamp); result.imported++;
      } catch (error) {
        // Report project filenames only; unrelated account history is never exposed.
        if (result.errors.length < 20) result.errors.push(`${provider} ${path.basename(file)}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return result;
  }
}
