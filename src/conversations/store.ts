import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { mkdirSync, existsSync, openSync, closeSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Conversation, ConversationDetail, ConversationPage, ConversationQuery, ConversationSummary } from './model.js';

/** Independent of the rebuildable architecture database. */
export class ConversationStore {
  private database?: DatabaseSync;
  private readonly instance = randomBytes(8).toString('hex');
  private writes = 0;
  constructor(private readonly stateDirectory: string, private readonly readOnly = false) {}
  private open(write = false): DatabaseSync | undefined {
    if (this.database) return this.database;
    const file = path.join(this.stateDirectory, 'conversations.db');
    if (!existsSync(file) && !write) return undefined;
    if (write && this.readOnly) throw new Error('Conversation history is read-only');
    if (write) mkdirSync(this.stateDirectory, { recursive: true });
    if (write && !existsSync(file)) {
      // Transcript archives are private to the local user, including their WAL files.
      try { closeSync(openSync(file, 'wx', 0o600)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
    const db = new DatabaseSync(file, { readOnly: this.readOnly });
    db.exec('PRAGMA busy_timeout=5000');
    if (Number(db.prepare('PRAGMA user_version').get()!.user_version) > 1) { db.close(); throw new Error('Conversation history was created by a newer Codiluce version'); }
    if (!this.readOnly) db.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY, provider TEXT NOT NULL, title TEXT NOT NULL, updated_at TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages(conversation_id TEXT NOT NULL, id TEXT NOT NULL, position INTEGER NOT NULL, text TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(conversation_id,id));
      CREATE TABLE IF NOT EXISTS paths(conversation_id TEXT NOT NULL, path TEXT NOT NULL, action TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS paths_lookup ON paths(path, action, conversation_id);
      CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation_id, position);
      CREATE TABLE IF NOT EXISTS imports(file TEXT PRIMARY KEY, stamp TEXT NOT NULL);
      PRAGMA user_version=1;
    `);
    return this.database = db;
  }
  close(): void { this.database?.close(); this.database = undefined; }
  /** Own writes plus SQLite's cross-connection version also catch imports made over MCP. */
  revision(): string { return `${this.instance}:${this.writes}:${this.open()?.prepare('PRAGMA data_version').get()?.data_version ?? 0}`; }
  summary(id: string): ConversationSummary | undefined {
    const row = this.open()?.prepare('SELECT data FROM conversations WHERE id=?').get(id);
    return row ? JSON.parse(String(row.data)) as ConversationSummary : undefined;
  }
  stamp(file: string): string | undefined { return this.open()?.prepare('SELECT stamp FROM imports WHERE file=?').get(file)?.stamp as string | undefined; }
  save(conversation: Conversation, file: string, stamp: string): void {
    if (this.readOnly) throw new Error('Conversation history is read-only');
    const db = this.open(true)!;
    const { messages, paths, ...metadata } = conversation;
    const summary: ConversationSummary = { ...metadata, messages: messages.length, paths: new Set(paths.map(item => item.path)).size };
    db.exec('BEGIN IMMEDIATE');
    try {
      const previousRow = db.prepare('SELECT data FROM conversations WHERE id=?').get(conversation.id);
      const previous = previousRow ? JSON.parse(String(previousRow.data)) as ConversationSummary : undefined;
      const newer = previous?.updatedAt && summary.updatedAt && Date.parse(previous.updatedAt) > Date.parse(summary.updatedAt);
      const longer = previous && previous.updatedAt === summary.updatedAt && previous.messages > summary.messages;
      if (newer || longer) {
        // An older archived copy must not overwrite a more complete active session.
        db.prepare('INSERT INTO imports VALUES(?,?) ON CONFLICT(file) DO UPDATE SET stamp=excluded.stamp').run(file, stamp);
        db.exec('COMMIT'); return;
      }
      db.prepare('INSERT INTO conversations VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET provider=excluded.provider,title=excluded.title,updated_at=excluded.updated_at,data=excluded.data').run(conversation.id, conversation.provider, conversation.title, conversation.updatedAt ?? '', JSON.stringify(summary));
      db.prepare('DELETE FROM messages WHERE conversation_id=?').run(conversation.id);
      db.prepare('DELETE FROM paths WHERE conversation_id=?').run(conversation.id);
      const message = db.prepare('INSERT INTO messages VALUES(?,?,?,?,?)');
      messages.forEach((item, position) => message.run(conversation.id, item.id, position, item.text, JSON.stringify(item)));
      const target = db.prepare('INSERT INTO paths VALUES(?,?,?,?)');
      for (const item of paths) target.run(conversation.id, item.path, item.action, JSON.stringify(item));
      db.prepare('INSERT INTO imports VALUES(?,?) ON CONFLICT(file) DO UPDATE SET stamp=excluded.stamp').run(file, stamp);
      db.exec('COMMIT');
      this.writes++;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  list(query: ConversationQuery = {}): ConversationPage {
    const limit = Math.max(1, Math.min(100, Math.floor(query.limit ?? 30))), offset = Math.max(0, Math.floor(query.offset ?? 0));
    if (!Number.isFinite(limit) || !Number.isFinite(offset)) throw new Error('Invalid pagination');
    const empty: ConversationPage = { items: [], total: 0, limit, offset };
    const db = this.open(); if (!db) return empty;
    const clauses: string[] = [], values: SQLInputValue[] = [];
    const like = (value: string) => `%${value.replace(/[\\%_]/g, '\\$&')}%`;
    if ((query.query?.length ?? 0) > 500) throw new Error('Search must be at most 500 characters');
    for (const word of query.query?.trim().split(/\s+/).filter(Boolean) ?? []) {
      clauses.push("(c.title LIKE ? ESCAPE '\\' OR EXISTS(SELECT 1 FROM messages m WHERE m.conversation_id=c.id AND m.text LIKE ? ESCAPE '\\'))"); values.push(like(word), like(word));
    }
    if (query.provider) { clauses.push('c.provider=?'); values.push(query.provider); }
    if (query.path || query.action) {
      const targets = ['p.conversation_id=c.id'];
      if (query.path && query.path !== '.' && query.path !== './') { const folder = query.path.replace(/^\.\//, '').replace(/\/$/, ''); targets.push("(p.path=? OR p.path LIKE ? ESCAPE '\\')"); values.push(folder, `${folder.replace(/[\\%_]/g, '\\$&')}/%`); }
      if (query.action) { targets.push('p.action=?'); values.push(query.action); }
      clauses.push(`EXISTS(SELECT 1 FROM paths p WHERE ${targets.join(' AND ')})`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const total = Number(db.prepare(`SELECT count(*) AS total FROM conversations c ${where}`).get(...values)!.total);
    const items = db.prepare(`SELECT c.data FROM conversations c ${where} ORDER BY c.updated_at DESC,c.id LIMIT ? OFFSET ?`).all(...values, limit, offset).map(row => JSON.parse(String(row.data)) as ConversationSummary);
    if (query.query?.trim()) {
      const words = query.query.trim().split(/\s+/).filter(Boolean);
      const match = db.prepare(`SELECT text FROM messages WHERE conversation_id=? AND (${words.map(() => "text LIKE ? ESCAPE '\\'").join(' OR ')}) ORDER BY position LIMIT 1`);
      for (const item of items) {
        const row = match.get(item.id, ...words.map(like)); if (!row) continue;
        const content = String(row.text).replace(/\s+/g, ' '), lower = content.toLowerCase();
        const found = Math.min(...words.map(word => lower.indexOf(word.toLowerCase())).filter(position => position >= 0)), start = Math.max(0, found - 60);
        item.excerpt = `${start ? '…' : ''}${content.slice(start, start + 220)}`;
      }
    }
    return { items, total, limit, offset };
  }
  get(id: string): Conversation | undefined {
    const db = this.open(), row = db?.prepare('SELECT data FROM conversations WHERE id=?').get(id); if (!row || !db) return undefined;
    const summary = JSON.parse(String(row.data)) as ConversationSummary;
    return { ...summary, messages: db.prepare('SELECT data FROM messages WHERE conversation_id=? ORDER BY position').all(id).map(row => JSON.parse(String(row.data))), paths: db.prepare('SELECT data FROM paths WHERE conversation_id=?').all(id).map(row => JSON.parse(String(row.data))) };
  }
  read(id: string, options: { offset?: number; limit?: number; messageId?: string; query?: string } = {}): ConversationDetail | undefined {
    const db = this.open(), row = db?.prepare('SELECT data FROM conversations WHERE id=?').get(id); if (!row || !db) return undefined;
    const summary = JSON.parse(String(row.data)) as ConversationSummary;
    let offset = options.offset ?? 0; const limit = options.limit ?? 60;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid pagination');
    let matches: string[] = [];
    if (options.query?.trim()) {
      if (options.query.length > 500) throw new Error('Search must be at most 500 characters');
      const words = options.query.trim().split(/\s+/).filter(Boolean), clauses = words.map(() => "text LIKE ? ESCAPE '\\'");
      const rows = db.prepare(`SELECT id,position FROM messages WHERE conversation_id=? AND (${clauses.join(' OR ')}) ORDER BY position LIMIT 1000`).all(id, ...words.map(word => `%${word.replace(/[\\%_]/g, '\\$&')}%`));
      matches = rows.map(row => String(row.id));
      if (options.offset === undefined && !options.messageId && rows[0]) offset = Math.floor(Number(rows[0].position) / limit) * limit;
    }
    if (options.messageId) {
      const target = db.prepare('SELECT position FROM messages WHERE conversation_id=? AND id=?').get(id, options.messageId);
      if (!target) throw new Error('This source message is no longer available in the imported transcript');
      offset = Math.floor(Number(target.position) / limit) * limit;
    }
    const messages = db.prepare('SELECT data FROM messages WHERE conversation_id=? ORDER BY position LIMIT ? OFFSET ?').all(id, limit, offset).map(row => JSON.parse(String(row.data)));
    const ids = messages.map(message => message.id as string);
    const paths = ids.length ? db.prepare(`SELECT data FROM paths WHERE conversation_id=? AND json_extract(data,'$.messageId') IN (${ids.map(() => '?').join(',')})`).all(id, ...ids).map(row => JSON.parse(String(row.data))) : [];
    const footprint = db.prepare("SELECT data,count(*) AS count FROM paths WHERE conversation_id=? GROUP BY path,action,json_extract(data,'$.scope'),json_extract(data,'$.status') ORDER BY path,action").all(id).map(row => ({ ...JSON.parse(String(row.data)), count: Number(row.count) }));
    return { ...summary, messages, paths, footprint, totalMessages: summary.messages, offset, limit, matches };
  }
}
