// A bounded, persistent cache of analyzer work, so that indexing again only
// re-analyzes what changed.
//
// The unit of caching is one analyzer over one application (TypeScript: one
// program per application; Laravel: its PHP), because call resolution and
// route registration are whole-application facts: a file's relations cannot
// be reused without the rest of its application. A unit's key digests every
// input the analyzer reads: the application's file paths and content hashes,
// the repository's indexed path set (imports and route includes resolve
// against it), the configuration, compiler options and analyzer versions.
//
// A miss runs the analyzer and records exactly what it did to the graph:
// entities, relations and diagnostics it added, evidence it merged, metadata
// and metrics keys it set on entities that already existed (file entities),
// and the HTTP observations it left for the API matcher (with the effect each
// one updates, by position). A hit replays that record; nothing is replayed
// unless it applies cleanly. Entries are gzip JSON files in the cache
// directory, at most `perUnit` per unit and `maxBytes` in total; the oldest
// go first. Deleting the directory is always safe.
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { AnalysisContext, HttpObservation } from '../core/analyzer.js';
import { ANALYZER_VERSION, SCHEMA_VERSION, type Diagnostic, type EffectFact, type Entity, type Evidence, type Relation } from '../core/graph.js';
import { canonicalJson } from '../history/fingerprint.js';

const CACHE_FORMAT = 1;
export interface CacheEvent { analyzer: string; unit: string; hit: boolean; ms: number }
interface Patch { id: string; type?: string; metadata?: Record<string, unknown>; removed?: string[]; metrics?: Record<string, unknown>; removedMetrics?: string[] }
type StoredObservation = Omit<HttpObservation, 'effect'> & { effect?: number };
interface Record_ {
  format: number; analyzer: string; unit: string; key: string;
  entities: Entity[]; patches: Patch[]; relations: Relation[]; merged: { id: string; evidence: Evidence[] }[];
  diagnostics: Diagnostic[]; http: StoredObservation[];
}
export interface CacheLimits { perUnit: number; maxBytes: number }

export class AnalysisCache {
  readonly events: CacheEvent[] = [];
  constructor(readonly directory: string, readonly limits: CacheLimits = { perUnit: 2, maxBytes: 256 * 1024 * 1024 }, private readonly onEvent?: (event: CacheEvent) => void) {}
  private file(analyzer: string, unit: string, key: string): string { return path.join(this.directory, `${analyzer}.${unitName(unit)}.${key}.json.gz`); }
  private event(event: CacheEvent): void { this.events.push(event); this.onEvent?.(event); }
  static key(parts: unknown): string { return createHash('sha256').update(canonicalJson({ format: CACHE_FORMAT, schema: SCHEMA_VERSION, analyzer: ANALYZER_VERSION, parts })).digest('hex').slice(0, 32); }

  /** Run `work` for one unit of an analyzer, or replay what it did the last time its inputs were the same. */
  async unit(context: AnalysisContext, analyzer: string, unit: string, parts: unknown, work: () => Promise<void>): Promise<void> {
    const started = Date.now();
    const key = AnalysisCache.key(parts);
    const stored = this.read<Record_>(analyzer, unit, key);
    if (stored && stored.format === CACHE_FORMAT && replay(context, stored)) { this.event({ analyzer, unit, hit: true, ms: Date.now() - started }); return; }
    const record = await capture(context, work);
    this.write(analyzer, unit, key, { format: CACHE_FORMAT, analyzer, unit, key, ...record });
    this.event({ analyzer, unit, hit: false, ms: Date.now() - started });
  }
  /** A plain JSON value computed from inputs (e.g. Git metrics for one HEAD). */
  async value<T>(analyzer: string, unit: string, parts: unknown, compute: () => Promise<T>): Promise<T> {
    const started = Date.now();
    const key = AnalysisCache.key(parts);
    const stored = this.read<{ format: number; value: T }>(analyzer, unit, key);
    if (stored && stored.format === CACHE_FORMAT) { this.event({ analyzer, unit, hit: true, ms: Date.now() - started }); return stored.value; }
    const value = await compute();
    this.write(analyzer, unit, key, { format: CACHE_FORMAT, value });
    this.event({ analyzer, unit, hit: false, ms: Date.now() - started });
    return value;
  }
  private read<T>(analyzer: string, unit: string, key: string): T | undefined {
    try { return JSON.parse(gunzipSync(readFileSync(this.file(analyzer, unit, key))).toString('utf8')) as T; } catch { return undefined; }
  }
  private write(analyzer: string, unit: string, key: string, value: unknown): void {
    try {
      mkdirSync(this.directory, { recursive: true });
      const file = this.file(analyzer, unit, key), temporary = `${file}.${process.pid}.tmp`;
      writeFileSync(temporary, gzipSync(JSON.stringify(value)));
      renameSync(temporary, file);
      this.prune(analyzer, unit, file);
    } catch { /* the cache is an optimization: a read-only or full disk only costs time */ }
  }
  /** Keep the newest `perUnit` entries of this unit, then the newest entries overall within `maxBytes`. */
  prune(analyzer?: string, unit?: string, keep?: string): void {
    let entries: { file: string; name: string; size: number; time: number }[];
    try { entries = readdirSync(this.directory).filter(name => name.endsWith('.json.gz')).map(name => { const file = path.join(this.directory, name); const info = statSync(file); return { file, name, size: info.size, time: info.mtimeMs }; }); } catch { return; }
    entries.sort((a, b) => b.time - a.time || (a.file === keep ? -1 : b.file === keep ? 1 : 0));
    const remove = new Set<string>();
    if (analyzer && unit) {
      const prefix = `${analyzer}.${unitName(unit)}.`;
      entries.filter(entry => entry.name.startsWith(prefix)).slice(this.limits.perUnit).forEach(entry => { if (entry.file !== keep) remove.add(entry.file); });
    }
    let total = 0;
    for (const entry of entries) { if (remove.has(entry.file)) continue; total += entry.size; if (total > this.limits.maxBytes && entry.file !== keep) remove.add(entry.file); }
    for (const file of remove) { try { unlinkSync(file); } catch { /* already gone */ } }
  }
}
function unitName(unit: string): string { return `${unit.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40)}-${createHash('sha256').update(unit).digest('hex').slice(0, 8)}`; }

/** Run `work` and record what it changed in the graph and the analysis context. */
async function capture(context: AnalysisContext, work: () => Promise<void>): Promise<Omit<Record_, 'format' | 'analyzer' | 'unit' | 'key'>> {
  const { graph } = context;
  const entities = new Set(graph.entities.keys());
  const shapes = new Map<string, { type: string; metadata: Map<string, string>; metrics: Map<string, string> }>();
  const keyed = (value: Record<string, unknown> | undefined) => new Map(Object.entries(value ?? {}).map(([key, item]) => [key, JSON.stringify(item)]));
  for (const entity of graph.entities.values()) shapes.set(entity.id, { type: entity.type, metadata: keyed(entity.metadata), metrics: keyed(entity.metrics as Record<string, unknown> | undefined) });
  const relations = new Map([...graph.relations.values()].map(relation => [relation.id, relation.evidence.length]));
  const diagnostics = new Set(graph.diagnostics.keys());
  const httpStart = context.http.length;
  await work();
  const patches: Patch[] = [];
  for (const [id, before] of shapes) {
    const entity = graph.entities.get(id);
    if (!entity) continue;
    const patch: Patch = { id };
    if (entity.type !== before.type) patch.type = entity.type;
    const changed = (now: Record<string, unknown> | undefined, then: Map<string, string>) => {
      const set: Record<string, unknown> = {}, removed: string[] = [];
      for (const [key, item] of Object.entries(now ?? {})) if (then.get(key) !== JSON.stringify(item)) set[key] = item;
      for (const key of then.keys()) if (!now || !(key in now)) removed.push(key);
      return { set, removed };
    };
    const metadata = changed(entity.metadata, before.metadata), metrics = changed(entity.metrics as Record<string, unknown> | undefined, before.metrics);
    if (Object.keys(metadata.set).length) patch.metadata = metadata.set;
    if (metadata.removed.length) patch.removed = metadata.removed;
    if (Object.keys(metrics.set).length) patch.metrics = metrics.set;
    if (metrics.removed.length) patch.removedMetrics = metrics.removed;
    if (Object.keys(patch).length > 1) patches.push(patch);
  }
  const http = context.http.slice(httpStart).map(observation => {
    const { effect, ...rest } = observation;
    const effects = graph.entities.get(observation.callerId)?.metadata.effects;
    const index = effect && Array.isArray(effects) ? (effects as EffectFact[]).indexOf(effect) : -1;
    return { ...rest, ...(index >= 0 ? { effect: index } : {}) } as StoredObservation;
  });
  // A deep copy now: the API matcher later updates effects in place, and replay must start from the analyzer's own output.
  return structuredClone({
    entities: [...graph.entities.values()].filter(entity => !entities.has(entity.id)),
    patches,
    relations: [...graph.relations.values()].filter(relation => !relations.has(relation.id)),
    merged: [...graph.relations.values()].filter(relation => relations.has(relation.id) && relation.evidence.length !== relations.get(relation.id)).map(relation => ({ id: relation.id, evidence: relation.evidence.slice(relations.get(relation.id)) })),
    diagnostics: [...graph.diagnostics.values()].filter(diagnostic => !diagnostics.has(diagnostic.id)),
    http,
  });
}
/** Apply a record; returns false (changing nothing) when it does not fit the graph as it is. */
function replay(context: AnalysisContext, record: Record_): boolean {
  const { graph } = context;
  if (record.entities.some(entity => graph.entities.has(entity.id)) || record.relations.some(relation => graph.relations.has(relation.id))) return false;
  if (record.patches.some(patch => !graph.entities.has(patch.id)) || record.merged.some(item => !graph.relations.has(item.id))) return false;
  const added = new Set(record.entities.map(entity => entity.id));
  const exists = (id: string) => graph.entities.has(id) || added.has(id);
  if (record.entities.some(entity => entity.parentId && !exists(entity.parentId)) || record.relations.some(relation => !exists(relation.from) || !exists(relation.to))) return false;
  for (const entity of record.entities) graph.entities.set(entity.id, entity);
  for (const patch of record.patches) {
    const entity = graph.entities.get(patch.id)!;
    if (patch.type) entity.type = patch.type as Entity['type'];
    if (patch.metadata || patch.removed) {
      const metadata = { ...entity.metadata, ...patch.metadata };
      for (const key of patch.removed ?? []) delete metadata[key];
      entity.metadata = metadata;
    }
    if (patch.metrics || patch.removedMetrics) {
      const metrics: Record<string, unknown> = { ...entity.metrics, ...patch.metrics };
      for (const key of patch.removedMetrics ?? []) delete metrics[key];
      entity.metrics = metrics as Entity['metrics'];
      if (!Object.keys(metrics).length) delete entity.metrics;
    }
  }
  for (const relation of record.relations) graph.relations.set(relation.id, relation);
  for (const item of record.merged) { const relation = graph.relations.get(item.id)!; relation.evidence = [...relation.evidence, ...item.evidence]; }
  for (const diagnostic of record.diagnostics) graph.diagnostics.set(diagnostic.id, diagnostic);
  for (const stored of record.http) {
    const { effect, ...observation } = stored;
    const effects = graph.entities.get(observation.callerId)?.metadata.effects;
    const fact = effect !== undefined && Array.isArray(effects) ? (effects as EffectFact[])[effect] : undefined;
    context.http.push({ ...observation, ...(fact ? { effect: fact } : {}) });
  }
  return true;
}

/** Identity of one indexed file for cache keys: path, content (hash or size) and how it was read. */
export function fileKey(context: AnalysisContext, relative: string): [string, string, string] {
  const file = context.files.get(relative)!;
  const metadata = context.graph.entities.get(file.id)?.metadata ?? {};
  return [relative, String(metadata.contentHash ?? `bytes:${metadata.bytes ?? ''}`), `${file.analyzable ? 1 : 0}${file.language ?? ''}${file.application?.name ?? ''}`];
}
/** Digest of every indexed path (imports and route includes resolve against it). */
export function pathSetKey(context: AnalysisContext): string {
  return createHash('sha256').update([...context.files.keys()].sort().join('\0')).digest('hex');
}
