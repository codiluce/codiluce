// A snapshot is one indexed state of the repository: either the live
// working-tree index (archipelago.db) or a stored commit snapshot
// (history.db). Projection, diff and source code read both through this
// interface, so every view works the same way at any point in history.
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { AnalysisRun, Diagnostic, Entity, Relation, SourceRange } from '../core/graph.js';
import { repoPath } from '../core/config.js';
import type { DiagnosticRow, EntityRow, RelationRow } from '../projection/hierarchy.js';
import type { GraphStore } from '../storage/sqlite.js';
import { contentKey, shapeHash } from './fingerprint.js';
import { readBlobAt } from './git.js';
import type { HistoryStore, SnapshotRecord } from './store.js';

export interface SnapshotEntity extends EntityRow {
  /** Semantic identity without positions (see fingerprint.ts). */
  shape: string;
  /** Source text identity (content hash, or size for unread files). */
  content?: string;
  /** Whitespace-normalized declaration text after the name; follows renames. */
  body?: string;
}
export type SnapshotRelation = RelationRow;
export type SnapshotDiagnostic = DiagnosticRow;
export interface SnapshotData { entities: SnapshotEntity[]; relations: SnapshotRelation[]; diagnostics: SnapshotDiagnostic[] }
export interface SnapshotInfo {
  id: string; kind: 'working_tree' | 'commit';
  run: AnalysisRun; commitSha?: string; dirty?: boolean;
}
export class SnapshotFileError extends Error { constructor(readonly status: number, message: string) { super(message); } }
export interface SnapshotSource {
  readonly info: SnapshotInfo;
  load(): SnapshotData;
  entity(id: string): Entity | undefined;
  relation(id: string): Relation | undefined;
  diagnostic(id: string): Diagnostic | undefined;
  fileByPath(relative: string): Entity | undefined;
  relationMetadata(ids: string[]): Map<string, Record<string, unknown>>;
  /** Call sites the analyzers could not resolve, by the name they call (`callSites.unresolvedNames`). */
  unresolvedCallNames(): { entityId: string; name: string; count: number }[];
  /** Content of an indexed file as of this snapshot, bounded by size. */
  readFile(relative: string, maxBytes: number): Promise<Buffer>;
}

/** The live working-tree index. */
export class WorkingTreeSnapshot implements SnapshotSource {
  readonly info: SnapshotInfo;
  constructor(private readonly store: GraphStore, private readonly root: string | undefined, run: AnalysisRun) {
    this.info = { id: run.id, kind: 'working_tree', run, ...(run.commitSha ? { commitSha: run.commitSha } : {}), ...(run.dirty !== undefined ? { dirty: run.dirty } : {}) };
  }
  load(): SnapshotData {
    const db = this.store.db;
    const entities: SnapshotEntity[] = db.prepare('SELECT e.id, e.type, e.name, e.path, e.language, e.parent_id, e.source_range, e.metadata, metric.data AS metrics FROM entities e LEFT JOIN metrics metric ON metric.entity_id=e.id ORDER BY e.id').all().map(row => {
      const metadata = JSON.parse(String(row.metadata)) as Record<string, unknown>;
      const loc = row.metrics ? (JSON.parse(String(row.metrics)) as { loc?: number }).loc : undefined;
      const text = (key: string) => typeof metadata[key] === 'string' ? metadata[key] as string : undefined;
      const entity = { type: String(row.type), name: String(row.name), ...(row.language ? { language: String(row.language) } : {}), metadata };
      const content = contentKey(entity);
      return {
        id: String(row.id), type: entity.type, name: entity.name,
        ...(row.path ? { path: String(row.path) } : {}), ...(row.language ? { language: String(row.language) } : {}),
        ...(row.parent_id ? { parentId: String(row.parent_id) } : {}), ...(row.source_range ? { sourceRange: JSON.parse(String(row.source_range)) as SourceRange } : {}),
        ...(typeof loc === 'number' ? { loc } : {}), ...(text('qualifiedName') ? { qualifiedName: text('qualifiedName') } : {}),
        ...(text('signature') !== undefined ? { signature: text('signature') } : {}), ...(text('routePath') ? { routePath: text('routePath') } : {}),
        ...(text('method') ? { method: text('method') } : {}), ...(text('framework') ? { framework: text('framework') } : {}),
        ...(text('role') ? { role: text('role') } : {}), ...(text('analysisSkipped') ? { analysisSkipped: text('analysisSkipped') } : {}),
        ...(content ? { content } : {}), ...(text('bodyHash') ? { body: text('bodyHash') } : {}), shape: shapeHash(entity as Pick<Entity, 'type' | 'name' | 'language' | 'metadata'>),
      };
    });
    const relations = db.prepare("SELECT id, from_id, to_id, type FROM relations WHERE type != 'contains' ORDER BY id").all().map(row => ({ id: String(row.id), from: String(row.from_id), to: String(row.to_id), type: String(row.type) }));
    const diagnostics = db.prepare('SELECT * FROM diagnostics ORDER BY id').all().map(row => ({ id: String(row.id), analyzer: String(row.analyzer), severity: String(row.severity), code: String(row.code), reason: String(row.reason), ...(row.file ? { file: String(row.file) } : {}), ...(row.line ? { line: Number(row.line) } : {}), ...(row.entity_id ? { entityId: String(row.entity_id) } : {}) }));
    return { entities, relations, diagnostics };
  }
  entity(id: string): Entity | undefined { return this.store.entity(id); }
  relation(id: string): Relation | undefined { return this.store.relation(id); }
  diagnostic(id: string): Diagnostic | undefined {
    const row = this.store.db.prepare('SELECT * FROM diagnostics WHERE id=?').get(id);
    return row ? { id: String(row.id), analyzer: String(row.analyzer), severity: row.severity as Diagnostic['severity'], code: String(row.code), resolution: 'unresolved', reason: String(row.reason), ...(row.file ? { file: String(row.file) } : {}), ...(row.line ? { line: Number(row.line) } : {}), ...(row.entity_id ? { entityId: String(row.entity_id) } : {}) } : undefined;
  }
  fileByPath(relative: string): Entity | undefined {
    const row = this.store.db.prepare("SELECT id FROM entities WHERE type='file' AND path=?").get(relative);
    return row ? this.store.entity(String(row.id)) : undefined;
  }
  relationMetadata(ids: string[]): Map<string, Record<string, unknown>> {
    const result = new Map<string, Record<string, unknown>>();
    if (!ids.length) return result;
    for (const row of this.store.db.prepare(`SELECT id, metadata FROM relations WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids)) if (row.metadata) result.set(String(row.id), JSON.parse(String(row.metadata)));
    return result;
  }
  unresolvedCallNames(): { entityId: string; name: string; count: number }[] {
    return this.store.db.prepare("SELECT e.id AS entity, j.key AS name, j.value AS count FROM entities e, json_each(e.metadata, '$.callSites.unresolvedNames') j").all().map(row => ({ entityId: String(row.entity), name: String(row.name), count: Number(row.count) }));
  }
  /** Lexical containment, then no symlink anywhere between root and file. */
  async readFile(relative: string, maxBytes: number): Promise<Buffer> {
    if (!this.root) throw new SnapshotFileError(503, 'Source viewing requires the server to be started with a repository root');
    if (path.isAbsolute(relative) || relative.split('/').includes('..') || relative.includes('\0')) throw new SnapshotFileError(403, 'Indexed path is not repository-relative');
    let absolute: string;
    try { absolute = repoPath(this.root, relative); } catch { throw new SnapshotFileError(403, 'Path escapes the repository'); }
    let resolved: string;
    try { resolved = await realpath(absolute); } catch { throw new SnapshotFileError(410, 'File no longer exists in the working tree; reindex to refresh'); }
    const realRoot = await realpath(this.root);
    if (resolved !== path.join(realRoot, ...relative.split('/'))) throw new SnapshotFileError(403, 'Refusing to follow a symlink or escaped path');
    const info = await lstat(resolved);
    if (!info.isFile()) throw new SnapshotFileError(403, 'Not a regular file');
    if (info.size > maxBytes) throw new SnapshotFileError(413, 'File exceeds the configured maxFileBytes');
    return readFile(resolved);
  }
}

/** A stored commit snapshot; file content comes from that commit's Git blobs. */
export class CommitSnapshot implements SnapshotSource {
  readonly info: SnapshotInfo;
  constructor(private readonly history: HistoryStore, readonly record: SnapshotRecord, private readonly root: string | undefined) {
    this.info = { id: record.id, kind: 'commit', run: record.run, commitSha: record.commitSha, dirty: false };
  }
  load(): SnapshotData { return { entities: this.history.entities(this.record.seq), relations: this.history.relations(this.record.seq).filter(item => item.type !== 'contains'), diagnostics: this.history.diagnostics(this.record.seq) }; }
  entity(id: string): Entity | undefined { return this.history.entity(this.record.seq, id); }
  relation(id: string): Relation | undefined { return this.history.relation(this.record.seq, id); }
  diagnostic(id: string): Diagnostic | undefined { return this.history.diagnostic(this.record.seq, id); }
  fileByPath(relative: string): Entity | undefined { return this.history.fileByPath(this.record.seq, relative); }
  relationMetadata(ids: string[]): Map<string, Record<string, unknown>> {
    const result = new Map<string, Record<string, unknown>>();
    for (const id of ids) { const relation = this.relation(id); if (relation?.metadata) result.set(id, relation.metadata); }
    return result;
  }
  unresolvedCallNames(): { entityId: string; name: string; count: number }[] { return this.history.unresolvedCallNames(this.record.seq); }
  async readFile(relative: string, maxBytes: number): Promise<Buffer> {
    if (!this.root) throw new SnapshotFileError(503, 'Historical source requires the server to be started with a repository root');
    // The commit comes from the snapshot record and the path from its indexed file entity; neither is caller-supplied.
    try { return (await readBlobAt(this.root, this.record.commitSha, relative, maxBytes)).content; }
    catch (error) { throw new SnapshotFileError(/maxFileBytes/.test(String(error)) ? 413 : 410, `Cannot read ${relative} at ${this.record.commitSha.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`); }
  }
}
