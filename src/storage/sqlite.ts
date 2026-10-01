import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { SCHEMA_VERSION, validateGraph, type SoftwareGraph, type Entity, type Relation, type Evidence, type AnalysisRun, type Diagnostic } from '../core/graph.js';

const DDL = `
CREATE TABLE analysis_runs (
  id TEXT PRIMARY KEY, repository_id TEXT NOT NULL, repository_name TEXT NOT NULL,
  commit_sha TEXT, dirty INTEGER, analyzed_at TEXT NOT NULL, config_digest TEXT NOT NULL,
  schema_version INTEGER NOT NULL, analyzer_versions TEXT NOT NULL, data TEXT NOT NULL
) STRICT;
CREATE TABLE repository_snapshots (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES analysis_runs(id), repository_id TEXT NOT NULL,
  commit_sha TEXT, kind TEXT NOT NULL CHECK(kind='working_tree'), is_current INTEGER NOT NULL CHECK(is_current IN (0,1))
) STRICT;
CREATE UNIQUE INDEX current_snapshot ON repository_snapshots(is_current) WHERE is_current=1;
CREATE TABLE entities (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, name TEXT NOT NULL, path TEXT, language TEXT,
  parent_id TEXT REFERENCES entities(id) DEFERRABLE INITIALLY DEFERRED, source_range TEXT, metadata TEXT NOT NULL
) STRICT;
CREATE INDEX entities_parent ON entities(parent_id);
CREATE INDEX entities_type ON entities(type);
CREATE INDEX entities_path ON entities(path);
CREATE INDEX entities_name ON entities(name);
CREATE TABLE relations (
  id TEXT PRIMARY KEY, from_id TEXT NOT NULL REFERENCES entities(id), to_id TEXT NOT NULL REFERENCES entities(id),
  type TEXT NOT NULL, metadata TEXT
) STRICT;
CREATE INDEX relations_from ON relations(from_id, type);
CREATE INDEX relations_to ON relations(to_id, type);
CREATE INDEX relations_type ON relations(type);
CREATE TABLE evidence (
  id INTEGER PRIMARY KEY, entity_id TEXT REFERENCES entities(id), relation_id TEXT REFERENCES relations(id),
  data TEXT NOT NULL, CHECK((entity_id IS NULL) != (relation_id IS NULL))
) STRICT;
CREATE INDEX evidence_entity ON evidence(entity_id);
CREATE INDEX evidence_relation ON evidence(relation_id);
CREATE TABLE metrics (entity_id TEXT PRIMARY KEY REFERENCES entities(id), data TEXT NOT NULL) STRICT;
CREATE TABLE diagnostics (
  id TEXT PRIMARY KEY, analyzer TEXT NOT NULL, severity TEXT NOT NULL, code TEXT NOT NULL,
  file TEXT, line INTEGER, entity_id TEXT REFERENCES entities(id), resolution TEXT NOT NULL, reason TEXT NOT NULL
) STRICT;
CREATE INDEX diagnostics_severity ON diagnostics(severity);
PRAGMA user_version = ${SCHEMA_VERSION};
`;
type Row = Record<string, unknown>;
export interface PageOptions { limit?: number; offset?: number }
export interface EntityQuery extends PageOptions { search?: string; type?: string; parentId?: string; path?: string }
export interface RelationQuery extends PageOptions { entityId?: string; direction?: 'incoming' | 'outgoing' | 'both'; type?: string }
export function pagination(options: PageOptions): { limit: number; offset: number } {
  const limit = options.limit ?? 100, offset = options.offset ?? 0;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500 || !Number.isSafeInteger(offset) || offset < 0 || offset > 10_000_000) throw new Error('limit must be 1..500; offset must be 0..10000000');
  return { limit, offset };
}
export class GraphStore {
  readonly db: DatabaseSync;
  constructor(file: string, readonly readOnly = false) {
    this.db = new DatabaseSync(file, { readOnly });
    try {
      this.db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
      const version = this.db.prepare('PRAGMA user_version').get()!.user_version;
      if (version === 0 && !readOnly) {
        this.db.exec('BEGIN IMMEDIATE');
        try { this.db.exec(DDL); this.db.exec('COMMIT'); } catch (error) { this.db.exec('ROLLBACK'); throw error; }
      } else if (version !== SCHEMA_VERSION) throw new Error(`Unsupported SQLite schema version ${version}; expected ${SCHEMA_VERSION}`);
    } catch (error) { this.db.close(); throw error; }
  }
  close(): void { this.db.close(); }
  save(graph: SoftwareGraph): void {
    if (this.readOnly) throw new Error('Store is read-only');
    if (graph.schemaVersion !== SCHEMA_VERSION || graph.run.schemaVersion !== SCHEMA_VERSION) throw new Error('Graph schema version mismatch');
    validateGraph(graph);
    const existing = this.db.prepare('SELECT repository_id FROM repository_snapshots WHERE is_current=1').get();
    if (existing && existing.repository_id !== graph.run.repositoryId) throw new Error('Cache belongs to a different repository; use a separate state directory');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec('DELETE FROM diagnostics; DELETE FROM evidence; DELETE FROM metrics; DELETE FROM relations; DELETE FROM entities; UPDATE repository_snapshots SET is_current=0;');
      const run = graph.run;
      this.db.prepare('INSERT INTO analysis_runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(run.id, run.repositoryId, run.repositoryName, run.commitSha ?? null, run.dirty === undefined ? null : Number(run.dirty), run.analyzedAt, run.configDigest, run.schemaVersion, JSON.stringify(run.analyzerVersions), JSON.stringify(run));
      this.db.prepare('INSERT INTO repository_snapshots VALUES (?, ?, ?, ?, ?, 1)').run(run.id, run.id, run.repositoryId, run.commitSha ?? null, 'working_tree');
      const entityStatement = this.db.prepare('INSERT INTO entities VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      const evidenceStatement = this.db.prepare('INSERT INTO evidence (entity_id, relation_id, data) VALUES (?, ?, ?)');
      const metricStatement = this.db.prepare('INSERT INTO metrics VALUES (?, ?)');
      for (const entity of graph.entities) {
        entityStatement.run(entity.id, entity.type, entity.name, entity.path ?? null, entity.language ?? null, entity.parentId ?? null, entity.sourceRange ? JSON.stringify(entity.sourceRange) : null, JSON.stringify(entity.metadata));
        for (const fact of entity.evidence) evidenceStatement.run(entity.id, null, JSON.stringify(fact));
        if (entity.metrics) metricStatement.run(entity.id, JSON.stringify(entity.metrics));
      }
      const relationStatement = this.db.prepare('INSERT INTO relations VALUES (?, ?, ?, ?, ?)');
      for (const relation of graph.relations) {
        relationStatement.run(relation.id, relation.from, relation.to, relation.type, relation.metadata ? JSON.stringify(relation.metadata) : null);
        for (const fact of relation.evidence) evidenceStatement.run(null, relation.id, JSON.stringify(fact));
      }
      const diagnosticStatement = this.db.prepare('INSERT INTO diagnostics VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
      for (const diagnostic of graph.diagnostics) diagnosticStatement.run(diagnostic.id, diagnostic.analyzer, diagnostic.severity, diagnostic.code, diagnostic.file ?? null, diagnostic.line ?? null, diagnostic.entityId ?? null, diagnostic.resolution, diagnostic.reason);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  currentRun(): AnalysisRun | undefined {
    const row = this.db.prepare('SELECT r.data FROM analysis_runs r JOIN repository_snapshots s ON s.run_id=r.id WHERE s.is_current=1').get();
    return row ? JSON.parse(String(row.data)) as AnalysisRun : undefined;
  }
  summary(): Record<string, unknown> {
    const count = (table: string) => this.db.prepare(`SELECT count(*) AS count FROM ${table}`).get()!.count;
    return { run: this.currentRun(), counts: { entities: count('entities'), relations: count('relations'), evidence: count('evidence'), diagnostics: count('diagnostics') }, entityTypes: this.db.prepare('SELECT type, count(*) AS count FROM entities GROUP BY type ORDER BY type').all(), relationTypes: this.db.prepare('SELECT type, count(*) AS count FROM relations GROUP BY type ORDER BY type').all(), diagnosticCodes: this.db.prepare('SELECT severity, code, count(*) AS count FROM diagnostics GROUP BY severity, code ORDER BY severity, code').all() };
  }
  private decodeEntity(row: Row, includeEvidence = false): Entity {
    const entity: Entity = { id: String(row.id), type: row.type as Entity['type'], name: String(row.name), ...(row.path ? { path: String(row.path) } : {}), ...(row.language ? { language: String(row.language) } : {}), ...(row.parent_id ? { parentId: String(row.parent_id) } : {}), ...(row.source_range ? { sourceRange: JSON.parse(String(row.source_range)) } : {}), metadata: JSON.parse(String(row.metadata)), ...(row.metrics ? { metrics: JSON.parse(String(row.metrics)) } : {}), evidence: [] };
    if (includeEvidence) entity.evidence = this.db.prepare('SELECT data FROM evidence WHERE entity_id=? ORDER BY id').all(entity.id).map(item => JSON.parse(String(item.data)) as Evidence);
    return entity;
  }
  entity(id: string): Entity | undefined {
    const row = this.db.prepare('SELECT e.*, m.data AS metrics FROM entities e LEFT JOIN metrics m ON m.entity_id=e.id WHERE e.id=?').get(id);
    return row ? this.decodeEntity(row, true) : undefined;
  }
  entities(options: EntityQuery = {}): { items: Omit<Entity, 'evidence' | 'metadata'>[]; limit: number; offset: number; hasMore: boolean } {
    const { limit, offset } = pagination(options);
    const clauses: string[] = [], values: SQLInputValue[] = [];
    if (options.search !== undefined) {
      if (options.search.length > 200) throw new Error('search must be at most 200 characters');
      clauses.push("(e.name LIKE ? ESCAPE '\\' OR e.path LIKE ? ESCAPE '\\')");
      const search = `%${options.search.replace(/[\\%_]/g, '\\$&')}%`; values.push(search, search);
    }
    if (options.type) { clauses.push('e.type=?'); values.push(options.type); }
    if (options.path) { clauses.push('e.path=?'); values.push(options.path); }
    if (options.parentId !== undefined) { clauses.push('e.parent_id=?'); values.push(options.parentId); }
    const rows = this.db.prepare(`SELECT e.id,e.type,e.name,e.path,e.language,e.parent_id,e.source_range,'{}' AS metadata,m.data AS metrics FROM entities e LEFT JOIN metrics m ON m.entity_id=e.id ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY e.id LIMIT ? OFFSET ?`).all(...values, limit + 1, offset);
    const items = rows.slice(0, limit).map(row => { const { evidence: _evidence, metadata: _metadata, ...entity } = this.decodeEntity(row); return entity; });
    return { items, limit, offset, hasMore: rows.length > limit };
  }
  relations(options: RelationQuery = {}): { items: Omit<Relation, 'evidence'>[]; limit: number; offset: number; hasMore: boolean } {
    const { limit, offset } = pagination(options);
    const clauses: string[] = [], values: SQLInputValue[] = [];
    if (options.entityId) {
      if (options.direction === 'incoming') { clauses.push('to_id=?'); values.push(options.entityId); }
      else if (options.direction === 'outgoing') { clauses.push('from_id=?'); values.push(options.entityId); }
      else { clauses.push('(from_id=? OR to_id=?)'); values.push(options.entityId, options.entityId); }
    }
    if (options.type) { clauses.push('type=?'); values.push(options.type); }
    const rows = this.db.prepare(`SELECT * FROM relations ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY id LIMIT ? OFFSET ?`).all(...values, limit + 1, offset);
    const items: Omit<Relation, 'evidence'>[] = rows.slice(0, limit).map(row => ({ id: String(row.id), from: String(row.from_id), to: String(row.to_id), type: row.type as Relation['type'], ...(row.metadata ? { metadata: JSON.parse(String(row.metadata)) } : {}) }));
    // Relationship lists intentionally omit evidence payloads; fetch one by ID.
    return { items, limit, offset, hasMore: rows.length > limit };
  }
  relation(id: string): Relation | undefined {
    const row = this.db.prepare('SELECT * FROM relations WHERE id=?').get(id);
    if (!row) return undefined;
    return { id: String(row.id), from: String(row.from_id), to: String(row.to_id), type: row.type as Relation['type'], ...(row.metadata ? { metadata: JSON.parse(String(row.metadata)) } : {}), evidence: this.db.prepare('SELECT data FROM evidence WHERE relation_id=? ORDER BY id').all(id).map(item => JSON.parse(String(item.data)) as Evidence) };
  }
  diagnostics(options: PageOptions & { severity?: string; code?: string } = {}): { items: Diagnostic[]; limit: number; offset: number; hasMore: boolean } {
    const { limit, offset } = pagination(options);
    const clauses: string[] = [], values: SQLInputValue[] = [];
    if (options.severity) { clauses.push('severity=?'); values.push(options.severity); }
    if (options.code) { clauses.push('code=?'); values.push(options.code); }
    const rows = this.db.prepare(`SELECT * FROM diagnostics ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY id LIMIT ? OFFSET ?`).all(...values, limit + 1, offset);
    return { items: rows.slice(0, limit).map(row => ({ id: String(row.id), analyzer: String(row.analyzer), severity: row.severity as Diagnostic['severity'], code: String(row.code), resolution: 'unresolved', reason: String(row.reason), ...(row.file ? { file: String(row.file) } : {}), ...(row.line ? { line: Number(row.line) } : {}), ...(row.entity_id ? { entityId: String(row.entity_id) } : {}) })), limit, offset, hasMore: rows.length > limit };
  }
}
