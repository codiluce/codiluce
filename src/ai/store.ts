// Annotations: `<state>/annotations.db`, apart from the graph cache. Model
// output never changes indexed facts; it is stored beside them, keyed by what
// it describes (`kind` + `target`: an entity ID, a flow's entry ID, a commit
// SHA, `repository`…) and by the input it was made from (`content_key`: a
// digest of the request), so an unchanged input is never paid for twice and a
// changed one is described again. Each annotation records the model, the
// prompt version and its ASD-STE100 score; runs record tokens and cost.
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import type { Usage } from './openai.js';

export const ANNOTATIONS_DATABASE = 'annotations.db';
const SCHEMA_VERSION = 1;
const DDL = `
CREATE TABLE annotations (
  kind TEXT NOT NULL, target TEXT NOT NULL, content_key TEXT NOT NULL, prompt_version TEXT NOT NULL,
  model TEXT NOT NULL, value TEXT NOT NULL, ste REAL, created_at TEXT NOT NULL,
  PRIMARY KEY (kind, target)
) STRICT, WITHOUT ROWID;
CREATE TABLE runs (
  id TEXT PRIMARY KEY, started_at TEXT NOT NULL, finished_at TEXT, tasks TEXT NOT NULL,
  requests INTEGER NOT NULL, input INTEGER NOT NULL, cached INTEGER NOT NULL, output INTEGER NOT NULL, reasoning INTEGER NOT NULL,
  cost REAL NOT NULL, estimate REAL, status TEXT NOT NULL
) STRICT;
PRAGMA user_version = ${SCHEMA_VERSION};
`;
export interface Annotation<T = unknown> { kind: string; target: string; contentKey: string; promptVersion: string; model: string; value: T; ste?: number; createdAt: string }
export interface RunRecord { id: string; startedAt: string; finishedAt?: string; tasks: string[]; requests: number; usage: Usage; cost: number; estimate?: number; status: string }

export class AnnotationStore {
  readonly db: DatabaseSync;
  private empty = false;
  constructor(file: string, readonly readOnly = false) {
    this.db = new DatabaseSync(file, { readOnly });
    try {
      this.db.exec('PRAGMA busy_timeout = 5000;');
      if (file !== ':memory:' && !readOnly) this.db.exec('PRAGMA journal_mode = WAL;');
      const version = Number(this.db.prepare('PRAGMA user_version').get()!.user_version);
      if (version === 0 && !readOnly) this.db.exec(DDL);
      else if (version === 0) this.empty = true;
      else if (version !== SCHEMA_VERSION) throw new Error(`Unsupported annotations schema version ${version}; expected ${SCHEMA_VERSION}`);
    } catch (error) { this.db.close(); throw error; }
  }
  close(): void { this.db.close(); }
  private decode<T>(row: Record<string, unknown>): Annotation<T> {
    return { kind: String(row.kind), target: String(row.target), contentKey: String(row.content_key), promptVersion: String(row.prompt_version), model: String(row.model), value: JSON.parse(String(row.value)) as T, ...(row.ste !== null && row.ste !== undefined ? { ste: Number(row.ste) } : {}), createdAt: String(row.created_at) };
  }
  get<T>(kind: string, target: string): Annotation<T> | undefined {
    if (this.empty) return undefined;
    const row = this.db.prepare('SELECT * FROM annotations WHERE kind=? AND target=?').get(kind, target);
    return row ? this.decode<T>(row) : undefined;
  }
  list<T>(kind: string): Annotation<T>[] {
    if (this.empty) return [];
    return this.db.prepare('SELECT * FROM annotations WHERE kind=? ORDER BY target').all(kind).map(row => this.decode<T>(row));
  }
  /** Annotations of a kind by target, for lookups. */
  map<T>(kind: string): Map<string, Annotation<T>> { return new Map(this.list<T>(kind).map(item => [item.target, item])); }
  /** Whether this exact input was already described with this prompt version. */
  fresh(kind: string, target: string, contentKey: string, promptVersion: string): boolean {
    const existing = this.get(kind, target);
    return !!existing && existing.contentKey === contentKey && existing.promptVersion === promptVersion;
  }
  put(items: Omit<Annotation, 'createdAt'>[], now = new Date().toISOString()): void {
    if (this.readOnly) throw new Error('The annotation store is read-only');
    const insert = this.db.prepare('INSERT INTO annotations (kind, target, content_key, prompt_version, model, value, ste, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(kind, target) DO UPDATE SET content_key=excluded.content_key, prompt_version=excluded.prompt_version, model=excluded.model, value=excluded.value, ste=excluded.ste, created_at=excluded.created_at');
    this.db.exec('BEGIN');
    try { for (const item of items) insert.run(item.kind, item.target, item.contentKey, item.promptVersion, item.model, JSON.stringify(item.value), item.ste ?? null, now); this.db.exec('COMMIT'); }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  /** Remove a kind's annotations whose targets no longer exist (e.g. deleted files). */
  prune(kind: string, keep: Set<string>): number {
    if (this.readOnly || this.empty) return 0;
    const stale = this.list(kind).filter(item => !keep.has(item.target)).map(item => item.target);
    const remove = this.db.prepare('DELETE FROM annotations WHERE kind=? AND target=?');
    for (const target of stale) remove.run(kind, target);
    return stale.length;
  }
  counts(): Record<string, { count: number; ste: number }> {
    if (this.empty) return {};
    return Object.fromEntries(this.db.prepare('SELECT kind, count(*) AS count, avg(ste) AS ste FROM annotations GROUP BY kind').all().map(row => [String(row.kind), { count: Number(row.count), ste: Number(row.ste ?? 1) }]));
  }
  saveRun(run: RunRecord): void {
    if (this.readOnly) return;
    this.db.prepare('INSERT INTO runs (id, started_at, finished_at, tasks, requests, input, cached, output, reasoning, cost, estimate, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET finished_at=excluded.finished_at, requests=excluded.requests, input=excluded.input, cached=excluded.cached, output=excluded.output, reasoning=excluded.reasoning, cost=excluded.cost, status=excluded.status')
      .run(run.id, run.startedAt, run.finishedAt ?? null, JSON.stringify(run.tasks), run.requests, run.usage.input, run.usage.cached, run.usage.output, run.usage.reasoning, run.cost, run.estimate ?? null, run.status);
  }
  runs(): RunRecord[] {
    if (this.empty) return [];
    return this.db.prepare('SELECT * FROM runs ORDER BY started_at DESC').all().map(row => ({ id: String(row.id), startedAt: String(row.started_at), ...(row.finished_at ? { finishedAt: String(row.finished_at) } : {}), tasks: JSON.parse(String(row.tasks)) as string[], requests: Number(row.requests), usage: { input: Number(row.input), cached: Number(row.cached), output: Number(row.output), reasoning: Number(row.reasoning) }, cost: Number(row.cost), ...(row.estimate !== null ? { estimate: Number(row.estimate) } : {}), status: String(row.status) }));
  }
}
/** Opens `<state>/annotations.db` read-only once it exists (it may be created while the server runs). */
export class AnnotationAccess {
  private store?: AnnotationStore;
  private checkedAt = 0;
  constructor(readonly stateDirectory?: string, private readonly exists: (file: string) => boolean = () => false) {}
  get = (): AnnotationStore | undefined => {
    if (this.store || !this.stateDirectory) return this.store;
    if (Date.now() - this.checkedAt < 3000) return undefined;
    this.checkedAt = Date.now();
    const file = path.join(this.stateDirectory, ANNOTATIONS_DATABASE);
    if (!this.exists(file)) return undefined;
    try { this.store = new AnnotationStore(file, true); } catch { /* being created */ }
    return this.store;
  };
  close(): void { this.store?.close(); this.store = undefined; }
}
