import { createHash } from 'node:crypto';

export const SCHEMA_VERSION = 1;
export const ANALYZER_VERSION = '0.1.0';
export type EntityType = 'repository' | 'application' | 'domain' | 'directory' | 'file' | 'component' | 'class' | 'function' | 'method' | 'route' | 'api_endpoint' | 'controller' | 'model' | 'database_table' | 'external_service' | 'test' | 'user_flow';
export type RelationType = 'contains' | 'imports' | 'exports' | 'calls' | 'renders' | 'routes_to' | 'handles' | 'requests' | 'reads' | 'writes' | 'queries' | 'maps_to' | 'extends' | 'implements' | 'observed_call' | 'part_of_flow' | 'changed_with';
export interface SourceRange { startLine: number; endLine: number; startColumn?: number; endColumn?: number }
export interface Evidence {
  source: 'filesystem' | 'typescript' | 'php' | 'framework' | 'git' | 'runtime' | 'heuristic' | 'ai';
  confidence: number;
  analyzer: string;
  analyzerVersion: string;
  file?: string;
  line?: number;
  endLine?: number;
  commit?: string;
  explanation?: string;
}
export interface Metrics { loc?: number; complexity?: number; churn?: number; authors?: number; commits?: number; lastChangedAt?: string; lastCommit?: string }
export interface Entity {
  id: string; type: EntityType; name: string; path?: string; language?: string; parentId?: string;
  sourceRange?: SourceRange; metadata: Record<string, unknown>; metrics?: Metrics; evidence: Evidence[];
}
export interface Relation { id: string; from: string; to: string; type: RelationType; metadata?: Record<string, unknown>; evidence: Evidence[] }
export interface Diagnostic {
  id: string; analyzer: string; severity: 'info' | 'warning' | 'error'; code: string;
  resolution: 'unresolved'; reason: string; file?: string; line?: number; entityId?: string;
}
export interface FlowStep { entityId: string; relationId?: string; timestamp?: string; durationMs?: number; traceId?: string }
export interface Flow { id: string; name: string; type: 'declared' | 'static' | 'observed'; steps: FlowStep[] }
export interface Annotation { id: string; entityId: string; source: 'jev' | 'openai' | 'anthropic' | 'manual'; kind: 'summary' | 'domain' | 'role' | 'architecture_layer'; value: unknown; confidence?: number }
export interface AnalysisRun {
  id: string; repositoryId: string; repositoryName: string; commitSha?: string; dirty?: boolean;
  analyzedAt: string; configDigest: string; schemaVersion: number; analyzerVersions: Record<string, string>;
}
export interface SoftwareGraph { schemaVersion: number; run: AnalysisRun; entities: Entity[]; relations: Relation[]; diagnostics: Diagnostic[] }
export function stableId(kind: string, ...parts: string[]): string {
  return `${kind}:${createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 24)}`;
}
export function evidence(source: Evidence['source'], analyzer: string, file?: string, line?: number, explanation?: string): Evidence {
  return { source, analyzer, analyzerVersion: ANALYZER_VERSION, confidence: 1, ...(file ? { file } : {}), ...(line ? { line } : {}), ...(explanation ? { explanation } : {}) };
}
function mergeEvidence(a: Evidence[], b: Evidence[]): Evidence[] {
  return [...new Map([...a, ...b].map(item => [JSON.stringify(item), item])).values()];
}
export class GraphBuilder {
  readonly entities = new Map<string, Entity>();
  readonly relations = new Map<string, Relation>();
  readonly diagnostics = new Map<string, Diagnostic>();
  constructor(readonly namespace: string) {}
  id(kind: string, ...parts: string[]): string { return stableId(kind, this.namespace, ...parts); }
  addEntity(entity: Entity): Entity {
    const previous = this.entities.get(entity.id);
    if (previous) throw new Error(`Duplicate entity identity: ${entity.name} (${entity.id})`);
    this.entities.set(entity.id, entity);
    return entity;
  }
  relate(from: string, to: string, type: RelationType, facts: Evidence[], metadata?: Record<string, unknown>, discriminator = ''): Relation {
    const id = this.id('relation', from, to, type, discriminator);
    const previous = this.relations.get(id);
    if (previous) { previous.evidence = mergeEvidence(previous.evidence, facts); return previous; }
    const relation = { id, from, to, type, evidence: facts, ...(metadata ? { metadata } : {}) };
    this.relations.set(id, relation);
    return relation;
  }
  contain(entity: Entity): Entity {
    this.addEntity(entity);
    if (entity.parentId) this.relate(entity.parentId, entity.id, 'contains', entity.evidence);
    return entity;
  }
  diagnose(diagnostic: Omit<Diagnostic, 'id' | 'resolution'>): void {
    const id = this.id('diagnostic', JSON.stringify(diagnostic));
    this.diagnostics.set(id, { id, resolution: 'unresolved', ...diagnostic });
  }
  finish(run: AnalysisRun): SoftwareGraph {
    const graph = { schemaVersion: SCHEMA_VERSION, run, entities: [...this.entities.values()].sort(byId), relations: [...this.relations.values()].sort(byId), diagnostics: [...this.diagnostics.values()].sort(byId) };
    validateGraph(graph);
    return graph;
  }
}
function byId(a: { id: string }, b: { id: string }): number { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; }
export function validateGraph(graph: SoftwareGraph): void {
  const entities = new Map(graph.entities.map(entity => [entity.id, entity]));
  if (entities.size !== graph.entities.length) throw new Error('Duplicate entity IDs');
  if (entities.get(graph.run.repositoryId)?.type !== 'repository') throw new Error('Missing repository root');
  if (new Set(graph.relations.map(relation => relation.id)).size !== graph.relations.length) throw new Error('Duplicate relation IDs');
  const checkEvidence = (facts: Evidence[]) => {
    if (!facts.length) throw new Error('Missing evidence');
    for (const fact of facts) {
      if (!Number.isFinite(fact.confidence) || fact.confidence < 0 || fact.confidence > 1 || !fact.analyzer || !fact.analyzerVersion) throw new Error('Invalid evidence');
      if (fact.file && (fact.file.startsWith('/') || fact.file.split('/').includes('..'))) throw new Error('Evidence path must be repository-relative');
    }
  };
  const checked = new Set<string>();
  for (const entity of graph.entities) {
    checkEvidence(entity.evidence);
    if (entity.path && (entity.path.startsWith('/') || entity.path.split('/').includes('..'))) throw new Error('Entity path must be repository-relative');
    const visited = new Set<string>();
    let current: Entity | undefined = entity;
    while (current && !checked.has(current.id)) {
      if (visited.has(current.id)) throw new Error('Containment cycle');
      visited.add(current.id);
      if (current.parentId && !entities.has(current.parentId)) throw new Error('Missing parent');
      current = current.parentId ? entities.get(current.parentId) : undefined;
    }
    for (const id of visited) checked.add(id);
  }
  const containment = new Set<string>();
  for (const relation of graph.relations) {
    checkEvidence(relation.evidence);
    if (!entities.has(relation.from) || !entities.has(relation.to)) throw new Error('Dangling relation');
    if (relation.type === 'contains') {
      if (entities.get(relation.to)?.parentId !== relation.from) throw new Error('Inconsistent containment');
      containment.add(relation.to);
    }
  }
  for (const entity of graph.entities) if (entity.parentId && !containment.has(entity.id)) throw new Error('Missing containment relation');
  for (const diagnostic of graph.diagnostics) if (diagnostic.entityId && !entities.has(diagnostic.entityId)) throw new Error('Dangling diagnostic');
}
