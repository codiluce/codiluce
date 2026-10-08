// Versioned graph snapshots. Entities, relations and diagnostics are stored
// once per distinct content (content-addressed versions); a snapshot is the
// set of versions it contains (membership rows), so unchanged objects are
// shared by every snapshot instead of copied per commit.
//
// A snapshot is one analysis run of one commit. The same commit can be
// analyzed again under another configuration or analyzer version: `identity`
// digests those inputs, and (commit, identity) is unique.
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { AnalysisRun, Diagnostic, Entity, Relation, SoftwareGraph, SourceRange } from '../core/graph.js';
import { validateGraph } from '../core/graph.js';
import type { TimelineRegistry } from '../projection/layout.js';
import type { CommitInfo } from './git.js';
import { contentKey, shapeHash, storageHash } from './fingerprint.js';
import type { SnapshotDiagnostic, SnapshotEntity, SnapshotRelation } from './snapshot.js';
import { fileAnalysis } from '../analysis/facts.js';

export const HISTORY_SCHEMA_VERSION = 1;
const DDL = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE commits (
  sha TEXT PRIMARY KEY, tree TEXT NOT NULL, parents TEXT NOT NULL, author_name TEXT NOT NULL, author_email TEXT NOT NULL,
  authored_at TEXT NOT NULL, committed_at TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL
) STRICT;
CREATE TABLE timelines (ref TEXT PRIMARY KEY, head TEXT NOT NULL, first_parent INTEGER NOT NULL, commits TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT;
CREATE TABLE snapshots (
  seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, commit_sha TEXT NOT NULL REFERENCES commits(sha),
  identity TEXT NOT NULL, analyzed_at TEXT NOT NULL, run TEXT NOT NULL, stats TEXT NOT NULL,
  UNIQUE(commit_sha, identity)
) STRICT;
CREATE TABLE entity_versions (
  vid INTEGER PRIMARY KEY, hash TEXT NOT NULL UNIQUE, entity_id TEXT NOT NULL,
  type TEXT NOT NULL, name TEXT NOT NULL, path TEXT, language TEXT, parent_id TEXT, source_range TEXT, loc INTEGER,
  qualified_name TEXT, signature TEXT, route_path TEXT, method TEXT, framework TEXT, role TEXT, skipped TEXT,
  content_key TEXT, body_hash TEXT, shape_hash TEXT NOT NULL, data TEXT NOT NULL
) STRICT;
CREATE INDEX entity_versions_entity ON entity_versions(entity_id);
CREATE INDEX entity_versions_file ON entity_versions(path) WHERE type = 'file';
CREATE TABLE relation_versions (
  vid INTEGER PRIMARY KEY, hash TEXT NOT NULL UNIQUE, relation_id TEXT NOT NULL,
  from_id TEXT NOT NULL, to_id TEXT NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL
) STRICT;
CREATE INDEX relation_versions_relation ON relation_versions(relation_id);
CREATE TABLE diagnostic_versions (vid INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, data TEXT NOT NULL) STRICT;
CREATE TABLE snapshot_entities (snapshot INTEGER NOT NULL, version INTEGER NOT NULL, PRIMARY KEY(snapshot, version)) STRICT, WITHOUT ROWID;
CREATE INDEX snapshot_entities_version ON snapshot_entities(version);
CREATE TABLE snapshot_relations (snapshot INTEGER NOT NULL, version INTEGER NOT NULL, PRIMARY KEY(snapshot, version)) STRICT, WITHOUT ROWID;
CREATE TABLE snapshot_diagnostics (snapshot INTEGER NOT NULL, version INTEGER NOT NULL, PRIMARY KEY(snapshot, version)) STRICT, WITHOUT ROWID;
CREATE TABLE pull_requests (
  provider TEXT NOT NULL, number INTEGER NOT NULL, title TEXT NOT NULL, url TEXT, author TEXT, merged_at TEXT,
  merge_commit_sha TEXT, head_ref TEXT, PRIMARY KEY(provider, number)
) STRICT;
CREATE INDEX pull_requests_commit ON pull_requests(merge_commit_sha);
CREATE TABLE layout_registry (id INTEGER PRIMARY KEY CHECK(id = 1), snapshots TEXT NOT NULL, state TEXT NOT NULL) STRICT;
PRAGMA user_version = ${HISTORY_SCHEMA_VERSION};
`;
export interface SnapshotStats {
  entities: number; relations: number; diagnostics: number; errors: number;
  files: number; symbols: number; endpoints: number; loc: number;
  /** Versions this snapshot added to the store (the rest were shared). */
  newVersions: number;
  applications: string[];
  /** Whether the configured applications existed at this commit, lived elsewhere (substituted), or were autodetected. */
  applicationSource?: string;
  /** Configured application name → its path at this commit, when it differs. */
  substitutedApplications?: Record<string, string>;
  missingApplications?: string[];
  durationMs?: number;
}
export interface SnapshotRecord { seq: number; id: string; commitSha: string; identity: string; analyzedAt: string; run: AnalysisRun; stats: SnapshotStats }
export interface PullRequestRecord { provider: string; number: number; title: string; url?: string; author?: string; mergedAt?: string; mergeCommitSha?: string; headRef?: string }
export interface EntityHistoryRow { snapshotId: string; commitSha: string; name: string; path?: string; parentId?: string; content?: string; shape: string }
type Row = Record<string, unknown>;
const SYMBOLS = new Set(['class', 'controller', 'component', 'function', 'method', 'model', 'test']);

export class HistoryStore {
  readonly db: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();
  constructor(readonly file: string, readonly readOnly = false) {
    this.db = new DatabaseSync(file, { readOnly });
    try {
      this.db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 10000;');
      const version = this.db.prepare('PRAGMA user_version').get()!.user_version;
      if (version === 0 && !readOnly) {
        this.db.exec('PRAGMA journal_mode = WAL');
        this.db.exec('BEGIN IMMEDIATE');
        try { this.db.exec(DDL); this.db.exec('COMMIT'); } catch (error) { this.db.exec('ROLLBACK'); throw error; }
      } else if (version !== HISTORY_SCHEMA_VERSION) throw new Error(`Unsupported history schema version ${version}; expected ${HISTORY_SCHEMA_VERSION}`);
      if (!readOnly) this.db.exec('PRAGMA synchronous = NORMAL');
    } catch (error) { this.db.close(); throw error; }
  }
  close(): void { this.db.close(); }
  private sql(text: string): StatementSync {
    let statement = this.statements.get(text);
    if (!statement) { statement = this.db.prepare(text); this.statements.set(text, statement); }
    return statement;
  }
  private writable(): void { if (this.readOnly) throw new Error('History store is read-only'); }
  meta(key: string): string | undefined { const row = this.sql('SELECT value FROM meta WHERE key=?').get(key); return row ? String(row.value) : undefined; }
  setMeta(key: string, value: string): void { this.writable(); this.sql('INSERT INTO meta VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value); }
  /** A history store holds one repository; refuse to mix identities. */
  claimRepository(repositoryId: string): void {
    const existing = this.meta('repository_id');
    if (existing && existing !== repositoryId) throw new Error('History store belongs to a different repository; use a separate state directory');
    if (!existing) this.setMeta('repository_id', repositoryId);
  }

  // Commits and timelines ---------------------------------------------------------
  saveCommits(commits: CommitInfo[]): void {
    this.writable();
    const insert = this.sql('INSERT OR IGNORE INTO commits VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    this.transaction(() => { for (const c of commits) insert.run(c.sha, c.tree, JSON.stringify(c.parents), c.authorName, c.authorEmail, c.authoredAt, c.committedAt, c.subject, c.body); });
  }
  commit(sha: string): CommitInfo | undefined {
    const row = this.sql('SELECT * FROM commits WHERE sha=?').get(sha);
    return row ? decodeCommit(row) : undefined;
  }
  commits(shas: string[]): Map<string, CommitInfo> {
    const result = new Map<string, CommitInfo>();
    for (let i = 0; i < shas.length; i += 500) {
      const chunk = shas.slice(i, i + 500);
      for (const row of this.db.prepare(`SELECT * FROM commits WHERE sha IN (${chunk.map(() => '?').join(',')})`).all(...chunk)) result.set(String(row.sha), decodeCommit(row));
    }
    return result;
  }
  saveTimeline(ref: string, head: string, shas: string[], firstParent = true): void {
    this.writable();
    this.sql('INSERT INTO timelines VALUES (?, ?, ?, ?, ?) ON CONFLICT(ref) DO UPDATE SET head=excluded.head, first_parent=excluded.first_parent, commits=excluded.commits, updated_at=excluded.updated_at').run(ref, head, Number(firstParent), JSON.stringify(shas), new Date().toISOString());
    this.setMeta('default_ref', ref);
  }
  timeline(ref: string): { ref: string; head: string; commits: string[] } | undefined {
    const row = this.sql('SELECT * FROM timelines WHERE ref=?').get(ref);
    return row ? { ref, head: String(row.head), commits: JSON.parse(String(row.commits)) as string[] } : undefined;
  }

  // Snapshots ---------------------------------------------------------------------
  hasSnapshot(commitSha: string, identity: string): boolean { return !!this.sql('SELECT 1 FROM snapshots WHERE commit_sha=? AND identity=?').get(commitSha, identity); }
  saveSnapshot(graph: SoftwareGraph, identity: string, extra: { durationMs?: number; applicationSource?: string; substitutedApplications?: Record<string, string>; missingApplications?: string[] } = {}): SnapshotRecord {
    this.writable();
    validateGraph(graph);
    const run = graph.run;
    if (!run.commitSha || !this.commit(run.commitSha)) throw new Error('Snapshot commit must be recorded first');
    this.claimRepository(run.repositoryId);
    const findEntity = this.sql('SELECT vid FROM entity_versions WHERE hash=?');
    const insertEntity = this.sql('INSERT INTO entity_versions (hash, entity_id, type, name, path, language, parent_id, source_range, loc, qualified_name, signature, route_path, method, framework, role, skipped, content_key, body_hash, shape_hash, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const findRelation = this.sql('SELECT vid FROM relation_versions WHERE hash=?');
    const insertRelation = this.sql('INSERT INTO relation_versions (hash, relation_id, from_id, to_id, type, data) VALUES (?, ?, ?, ?, ?, ?)');
    const findDiagnostic = this.sql('SELECT vid FROM diagnostic_versions WHERE id=?');
    const insertDiagnostic = this.sql('INSERT INTO diagnostic_versions (id, data) VALUES (?, ?)');
    const member = (table: string) => this.sql(`INSERT OR IGNORE INTO ${table} VALUES (?, ?)`);
    let newVersions = 0;
    const versionOf = (find: StatementSync, key: string, insert: () => void): number => {
      const row = find.get(key);
      if (row) return Number(row.vid);
      insert(); newVersions++;
      return Number(find.get(key)!.vid);
    };
    const meta = (entity: Entity, key: string) => { const value = entity.metadata[key]; return typeof value === 'string' ? value : null; };
    let files = 0, symbols = 0, endpoints = 0, loc = 0;
    return this.transaction(() => {
      const result = this.sql('INSERT INTO snapshots (id, commit_sha, identity, analyzed_at, run, stats) VALUES (?, ?, ?, ?, ?, ?) RETURNING seq').get(run.id, run.commitSha!, identity, run.analyzedAt, JSON.stringify(run), '{}')!;
      const seq = Number(result.seq);
      const entityMember = member('snapshot_entities'), relationMember = member('snapshot_relations'), diagnosticMember = member('snapshot_diagnostics');
      for (const entity of graph.entities) {
        const hash = storageHash(entity);
        const vid = versionOf(findEntity, hash, () => insertEntity.run(hash, entity.id, entity.type, entity.name, entity.path ?? null, entity.language ?? null, entity.parentId ?? null, entity.sourceRange ? JSON.stringify(entity.sourceRange) : null, entity.metrics?.loc ?? null, meta(entity, 'qualifiedName'), meta(entity, 'signature'), meta(entity, 'routePath'), meta(entity, 'method'), meta(entity, 'framework'), meta(entity, 'role'), meta(entity, 'analysisSkipped'), contentKey(entity) ?? null, meta(entity, 'bodyHash'), shapeHash(entity), JSON.stringify(entity)));
        entityMember.run(seq, vid);
        if (entity.type === 'file') { files++; loc += entity.metrics?.loc ?? 0; }
        else if (SYMBOLS.has(entity.type)) symbols++;
        else if (entity.type === 'route' || entity.type === 'api_endpoint') endpoints++;
      }
      for (const relation of graph.relations) {
        const hash = storageHash(relation);
        relationMember.run(seq, versionOf(findRelation, hash, () => insertRelation.run(hash, relation.id, relation.from, relation.to, relation.type, JSON.stringify(relation))));
      }
      for (const diagnostic of graph.diagnostics) diagnosticMember.run(seq, versionOf(findDiagnostic, diagnostic.id, () => insertDiagnostic.run(diagnostic.id, JSON.stringify(diagnostic))));
      const applications = graph.entities.filter(entity => entity.type === 'application').map(entity => entity.name).sort();
      const stats: SnapshotStats = { entities: graph.entities.length, relations: graph.relations.length, diagnostics: graph.diagnostics.length, errors: graph.diagnostics.filter(item => item.severity === 'error').length, files, symbols, endpoints, loc, newVersions, applications, ...(extra.applicationSource ? { applicationSource: extra.applicationSource } : {}), ...(extra.substitutedApplications && Object.keys(extra.substitutedApplications).length ? { substitutedApplications: extra.substitutedApplications } : {}), ...(extra.missingApplications?.length ? { missingApplications: extra.missingApplications } : {}), ...(extra.durationMs !== undefined ? { durationMs: Math.round(extra.durationMs) } : {}) };
      this.sql('UPDATE snapshots SET stats=? WHERE seq=?').run(JSON.stringify(stats), seq);
      return { seq, id: run.id, commitSha: run.commitSha!, identity, analyzedAt: run.analyzedAt, run, stats };
    });
  }
  snapshots(): SnapshotRecord[] { return this.sql('SELECT * FROM snapshots ORDER BY seq').all().map(decodeSnapshot); }
  /** One snapshot per commit: the one matching `identity` when present, otherwise the most recent analysis. */
  snapshotsByCommit(identity?: string): Map<string, SnapshotRecord> {
    const chosen = new Map<string, SnapshotRecord>();
    for (const snapshot of this.snapshots()) {
      const previous = chosen.get(snapshot.commitSha);
      const better = !previous || (previous.identity !== identity && (snapshot.identity === identity || snapshot.analyzedAt > previous.analyzedAt));
      if (better) chosen.set(snapshot.commitSha, snapshot);
    }
    return chosen;
  }
  snapshot(id: string): SnapshotRecord | undefined { const row = this.sql('SELECT * FROM snapshots WHERE id=?').get(id); return row ? decodeSnapshot(row) : undefined; }
  deleteSnapshots(ids: string[]): void {
    this.writable();
    this.transaction(() => {
      for (const id of ids) {
        const row = this.sql('SELECT seq FROM snapshots WHERE id=?').get(id);
        if (!row) continue;
        for (const table of ['snapshot_entities', 'snapshot_relations', 'snapshot_diagnostics']) this.sql(`DELETE FROM ${table} WHERE snapshot=?`).run(row.seq as number);
        this.sql('DELETE FROM snapshots WHERE seq=?').run(row.seq as number);
      }
      // Drop versions no snapshot references any more.
      this.db.exec('DELETE FROM entity_versions WHERE vid NOT IN (SELECT version FROM snapshot_entities)');
      this.db.exec('DELETE FROM relation_versions WHERE vid NOT IN (SELECT version FROM snapshot_relations)');
      this.db.exec('DELETE FROM diagnostic_versions WHERE vid NOT IN (SELECT version FROM snapshot_diagnostics)');
    });
  }

  // Snapshot contents ------------------------------------------------------------
  entities(seq: number): SnapshotEntity[] {
    return this.sql(`SELECT ${ENTITY_COLUMNS} FROM snapshot_entities m JOIN entity_versions v ON v.vid=m.version WHERE m.snapshot=? ORDER BY v.entity_id`).all(seq).map(decodeEntity);
  }
  /** Every stored entity version by version ID, for walking a timeline through membership deltas. */
  entityVersions(): Map<number, SnapshotEntity> {
    const result = new Map<number, SnapshotEntity>();
    for (const row of this.sql(`SELECT v.vid, ${ENTITY_COLUMNS} FROM entity_versions v`).all()) result.set(Number(row.vid), decodeEntity(row));
    return result;
  }
  /** Entity versions in snapshot `seq` but not in `previous`, and the reverse (`previous` 0: every version of `seq`). */
  entityDelta(seq: number, previous: number): { added: number[]; removed: number[] } {
    const only = this.sql('SELECT version FROM snapshot_entities WHERE snapshot=? EXCEPT SELECT version FROM snapshot_entities WHERE snapshot=?');
    return { added: only.all(seq, previous).map(row => Number(row.version)), removed: previous ? only.all(previous, seq).map(row => Number(row.version)) : [] };
  }
  unresolvedCallNames(seq: number): { entityId: string; name: string; count: number }[] {
    return this.sql("SELECT v.entity_id AS entity, j.key AS name, j.value AS count FROM snapshot_entities m JOIN entity_versions v ON v.vid=m.version, json_each(v.data, '$.metadata.callSites.unresolvedNames') j WHERE m.snapshot=?").all(seq).map(row => ({ entityId: String(row.entity), name: String(row.name), count: Number(row.count) }));
  }
  relations(seq: number): SnapshotRelation[] {
    return this.sql('SELECT r.relation_id, r.from_id, r.to_id, r.type FROM snapshot_relations m JOIN relation_versions r ON r.vid=m.version WHERE m.snapshot=? ORDER BY r.relation_id').all(seq)
      .map(row => ({ id: String(row.relation_id), from: String(row.from_id), to: String(row.to_id), type: String(row.type) }));
  }
  diagnostics(seq: number): SnapshotDiagnostic[] {
    return this.sql('SELECT d.data FROM snapshot_diagnostics m JOIN diagnostic_versions d ON d.vid=m.version WHERE m.snapshot=? ORDER BY d.id').all(seq).map(row => {
      const item = JSON.parse(String(row.data)) as Diagnostic;
      return { id: item.id, analyzer: item.analyzer, severity: item.severity, code: item.code, reason: item.reason, ...(item.file ? { file: item.file } : {}), ...(item.line ? { line: item.line } : {}), ...(item.entityId ? { entityId: item.entityId } : {}) };
    });
  }
  entity(seq: number, id: string): Entity | undefined {
    const row = this.sql('SELECT v.data FROM entity_versions v JOIN snapshot_entities m ON m.version=v.vid AND m.snapshot=? WHERE v.entity_id=?').get(seq, id);
    return row ? JSON.parse(String(row.data)) as Entity : undefined;
  }
  fileByPath(seq: number, relative: string): Entity | undefined {
    const row = this.sql("SELECT v.data FROM entity_versions v JOIN snapshot_entities m ON m.version=v.vid AND m.snapshot=? WHERE v.type='file' AND v.path=?").get(seq, relative);
    return row ? JSON.parse(String(row.data)) as Entity : undefined;
  }
  relation(seq: number, id: string): Relation | undefined {
    const row = this.sql('SELECT r.data FROM relation_versions r JOIN snapshot_relations m ON m.version=r.vid AND m.snapshot=? WHERE r.relation_id=?').get(seq, id);
    return row ? JSON.parse(String(row.data)) as Relation : undefined;
  }
  diagnostic(seq: number, id: string): Diagnostic | undefined {
    const row = this.sql('SELECT d.data FROM diagnostic_versions d JOIN snapshot_diagnostics m ON m.version=d.vid AND m.snapshot=? WHERE d.id=?').get(seq, id);
    return row ? JSON.parse(String(row.data)) as Diagnostic : undefined;
  }
  /** Every stored version of an entity, with the snapshots containing it. */
  entityHistory(entityId: string): EntityHistoryRow[] {
    return this.sql(`SELECT s.id, s.commit_sha, v.name, v.path, v.parent_id, v.content_key, v.shape_hash FROM entity_versions v
      JOIN snapshot_entities m ON m.version=v.vid JOIN snapshots s ON s.seq=m.snapshot WHERE v.entity_id=?`).all(entityId)
      .map(row => ({ snapshotId: String(row.id), commitSha: String(row.commit_sha), name: String(row.name), ...(row.path ? { path: String(row.path) } : {}), ...(row.parent_id ? { parentId: String(row.parent_id) } : {}), ...(row.content_key ? { content: String(row.content_key) } : {}), shape: String(row.shape_hash) }));
  }

  // Layout registry --------------------------------------------------------------
  layoutRegistry(): { snapshots: string[]; state: TimelineRegistry } | undefined {
    const row = this.sql('SELECT snapshots, state FROM layout_registry WHERE id=1').get();
    return row ? { snapshots: JSON.parse(String(row.snapshots)) as string[], state: JSON.parse(String(row.state)) as TimelineRegistry } : undefined;
  }
  saveLayoutRegistry(snapshots: string[], state: TimelineRegistry): void {
    this.writable();
    this.sql('INSERT INTO layout_registry VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET snapshots=excluded.snapshots, state=excluded.state').run(JSON.stringify(snapshots), JSON.stringify(state));
  }

  // Pull requests ----------------------------------------------------------------
  savePullRequests(items: PullRequestRecord[]): void {
    this.writable();
    const insert = this.sql('INSERT INTO pull_requests VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(provider, number) DO UPDATE SET title=excluded.title, url=excluded.url, author=excluded.author, merged_at=excluded.merged_at, merge_commit_sha=excluded.merge_commit_sha, head_ref=excluded.head_ref');
    this.transaction(() => { for (const pr of items) insert.run(pr.provider, pr.number, pr.title, pr.url ?? null, pr.author ?? null, pr.mergedAt ?? null, pr.mergeCommitSha ?? null, pr.headRef ?? null); });
  }
  pullRequests(): PullRequestRecord[] {
    return this.sql('SELECT * FROM pull_requests WHERE merge_commit_sha IS NOT NULL ORDER BY provider, number').all().map(row => ({ provider: String(row.provider), number: Number(row.number), title: String(row.title), ...(row.url ? { url: String(row.url) } : {}), ...(row.author ? { author: String(row.author) } : {}), ...(row.merged_at ? { mergedAt: String(row.merged_at) } : {}), ...(row.merge_commit_sha ? { mergeCommitSha: String(row.merge_commit_sha) } : {}), ...(row.head_ref ? { headRef: String(row.head_ref) } : {}) }));
  }

  status(): Record<string, unknown> {
    const count = (table: string) => Number(this.db.prepare(`SELECT count(*) AS count FROM ${table}`).get()!.count);
    const pages = Number(this.db.prepare('PRAGMA page_count').get()!.page_count) * Number(this.db.prepare('PRAGMA page_size').get()!.page_size);
    return { snapshots: count('snapshots'), commits: count('commits'), versions: { entities: count('entity_versions'), relations: count('relation_versions'), diagnostics: count('diagnostic_versions') }, memberships: { entities: count('snapshot_entities'), relations: count('snapshot_relations'), diagnostics: count('snapshot_diagnostics') }, pullRequests: count('pull_requests'), bytes: pages };
  }
  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = work(); this.db.exec('COMMIT'); return result; } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}
const ENTITY_COLUMNS = "v.entity_id, v.type, v.name, v.path, v.language, v.parent_id, v.source_range, v.loc, v.qualified_name, v.signature, v.route_path, v.method, v.framework, v.role, v.skipped, v.content_key, v.body_hash, v.shape_hash, json_extract(v.data, '$.metadata.analysis') AS analysis";
function decodeEntity(row: Row): SnapshotEntity {
  const analysis = row.analysis ? fileAnalysis(JSON.parse(String(row.analysis))) : undefined;
  return {
    id: String(row.entity_id), type: String(row.type), name: String(row.name),
    ...(row.path ? { path: String(row.path) } : {}), ...(row.language ? { language: String(row.language) } : {}),
    ...(row.parent_id ? { parentId: String(row.parent_id) } : {}), ...(row.source_range ? { sourceRange: JSON.parse(String(row.source_range)) as SourceRange } : {}),
    ...(typeof row.loc === 'number' ? { loc: row.loc } : {}), ...(row.qualified_name ? { qualifiedName: String(row.qualified_name) } : {}),
    ...(typeof row.signature === 'string' ? { signature: row.signature } : {}), ...(row.route_path ? { routePath: String(row.route_path) } : {}),
    ...(row.method ? { method: String(row.method) } : {}), ...(row.framework ? { framework: String(row.framework) } : {}),
    ...(row.role ? { role: String(row.role) } : {}), ...(row.skipped ? { analysisSkipped: String(row.skipped) } : {}),
    ...(analysis ? { analysis } : {}),
    ...(row.content_key ? { content: String(row.content_key) } : {}), ...(row.body_hash ? { body: String(row.body_hash) } : {}), shape: String(row.shape_hash),
  };
}
function decodeCommit(row: Row): CommitInfo {
  return { sha: String(row.sha), tree: String(row.tree), parents: JSON.parse(String(row.parents)) as string[], authorName: String(row.author_name), authorEmail: String(row.author_email), authoredAt: String(row.authored_at), committedAt: String(row.committed_at), subject: String(row.subject), body: String(row.body) };
}
function decodeSnapshot(row: Row): SnapshotRecord {
  return { seq: Number(row.seq), id: String(row.id), commitSha: String(row.commit_sha), identity: String(row.identity), analyzedAt: String(row.analyzed_at), run: JSON.parse(String(row.run)) as AnalysisRun, stats: JSON.parse(String(row.stats)) as SnapshotStats };
}
