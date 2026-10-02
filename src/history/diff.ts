// Architectural diff between two snapshots. Entities are compared through
// lineage, so a renamed file or a re-signatured method reads as one entity
// that moved or changed, not as a removal plus an addition. The comparison
// space is the *union*: target entities, plus removed baseline entities kept
// as ghosts under their (mapped) parents.
import { computeLineage, type Lineage, type LineageReason } from './lineage.js';
import type { SnapshotData, SnapshotDiagnostic, SnapshotEntity, SnapshotRelation } from './snapshot.js';

export type ChangeStatus = 'added' | 'removed' | 'modified' | 'moved' | 'unchanged';
/**
 * source: own source text; definition: other described facts (exports,
 * inheritance, HTTP calls, route data…); signature; type; size: line count
 * where no source hash exists; renamed (name or path) / reparented: moved; relations /
 * diagnostics: connections or findings changed, the entity itself may not.
 */
export type ChangeFacet = 'source' | 'definition' | 'signature' | 'type' | 'size' | 'renamed' | 'reparented' | 'relations' | 'diagnostics';
export interface EntityChange { status: ChangeStatus; facets: ChangeFacet[]; previousId?: string; lineage?: LineageReason }
export interface InterfaceChange { id: string; type: string; name: string; status: ChangeStatus; previousName?: string }
export interface DiffSummary {
  entities: { added: number; removed: number; modified: number; moved: number };
  byType: { type: string; added: number; removed: number; modified: number; moved: number }[];
  relations: { added: number; removed: number; byType: { type: string; added: number; removed: number }[] };
  diagnostics: { added: number; removed: number; byCode: { code: string; severity: string; added: number; removed: number }[] };
  files: { added: number; removed: number; modified: number; moved: number; locBefore: number; locAfter: number };
  /** Routes and endpoints that appeared, disappeared, changed or moved (at most 300). */
  interfaces: InterfaceChange[];
  applications: { id: string; name: string; status: ChangeStatus; previousName?: string }[];
  lineage: { mapped: number; byReason: Record<string, number> };
}
export interface SnapshotDiff {
  lineage: Lineage;
  /** By union ID. Entities with no change at all are absent. */
  changes: Map<string, EntityChange>;
  /** Removed baseline entities, parented into the union ID space. */
  ghosts: SnapshotEntity[];
  /** Target relations absent from the baseline, and baseline relations (endpoints in union IDs) absent from the target. */
  addedRelations: SnapshotRelation[]; removedRelations: SnapshotRelation[];
  addedDiagnostics: SnapshotDiagnostic[]; removedDiagnostics: SnapshotDiagnostic[];
  summary: DiffSummary;
  /** Baseline ID → union ID. */
  toUnion(id: string): string;
}
const STATUS_KEYS = ['added', 'removed', 'modified', 'moved'] as const;

export function computeDiff(baseline: SnapshotData, target: SnapshotData, renames: Map<string, string> = new Map()): SnapshotDiff {
  const lineage = computeLineage(baseline.entities, target.entities, renames);
  const beforeById = new Map(baseline.entities.map(entity => [entity.id, entity]));
  const afterById = new Map(target.entities.map(entity => [entity.id, entity]));
  const toUnion = (id: string) => afterById.has(id) ? id : lineage.forward.get(id) ?? id;
  const changes = new Map<string, EntityChange>();
  for (const after of target.entities) {
    const previousId = beforeById.has(after.id) ? after.id : lineage.backward.get(after.id);
    if (!previousId) { changes.set(after.id, { status: 'added', facets: [] }); continue; }
    const before = beforeById.get(previousId)!;
    const facets: ChangeFacet[] = [];
    // A missing hash on one side (unread file, or an index from an older analyzer) is only a change for files.
    if (before.content !== undefined && after.content !== undefined ? before.content !== after.content : (before.content === undefined) !== (after.content === undefined) && after.type === 'file') facets.push('source');
    if (before.type !== after.type) facets.push('type');
    const renamed = before.name !== after.name;
    const signature = (before.signature ?? '') !== (after.signature ?? '');
    if (signature) facets.push('signature');
    if (before.shape !== after.shape && !renamed && !signature && before.type === after.type) facets.push('definition');
    if (!facets.includes('source') && (before.content === undefined || after.content === undefined) && before.loc !== after.loc) facets.push('size');
    if (renamed || (before.path !== after.path && (before.type === 'application' || before.type === 'directory' || before.type === 'file'))) facets.push('renamed');
    if ((before.parentId ? toUnion(before.parentId) : undefined) !== after.parentId) facets.push('reparented');
    const status: ChangeStatus = facets.includes('renamed') || facets.includes('reparented') ? 'moved' : facets.length ? 'modified' : 'unchanged';
    const mapped = previousId !== after.id;
    if (status !== 'unchanged' || mapped) changes.set(after.id, { status, facets, ...(mapped ? { previousId, lineage: lineage.reasons.get(after.id)! } : {}) });
  }
  const ghosts: SnapshotEntity[] = [];
  for (const before of baseline.entities) {
    if (afterById.has(before.id) || lineage.forward.has(before.id)) continue;
    const { parentId, ...rest } = before;
    ghosts.push({ ...rest, ...(parentId ? { parentId: toUnion(parentId) } : {}) });
    changes.set(before.id, { status: 'removed', facets: [] });
  }
  const touch = (id: string, facet: ChangeFacet) => {
    const change = changes.get(id);
    if (!change) changes.set(id, { status: 'unchanged', facets: [facet] });
    else if (change.status !== 'added' && change.status !== 'removed' && !change.facets.includes(facet)) change.facets.push(facet);
  };
  // Relations: (from, to, type) is a relation's identity (no discriminators are used).
  const key = (relation: SnapshotRelation) => `${relation.from}\u0000${relation.to}\u0000${relation.type}`;
  const mappedBaseline = baseline.relations.map(relation => ({ ...relation, from: toUnion(relation.from), to: toUnion(relation.to) }));
  const baselineKeys = new Set(mappedBaseline.map(key)), targetKeys = new Set(target.relations.map(key));
  const addedRelations = target.relations.filter(relation => !baselineKeys.has(key(relation)));
  const removedRelations = mappedBaseline.filter(relation => !targetKeys.has(key(relation)));
  for (const relation of [...addedRelations, ...removedRelations]) { touch(relation.from, 'relations'); touch(relation.to, 'relations'); }
  // Diagnostics: compared without line numbers (an edit above a finding is not a new finding).
  const fileIds = new Map<string, string>();
  for (const entity of [...ghosts, ...target.entities]) if (entity.type === 'file' && entity.path) fileIds.set(entity.path, entity.id);
  const diagnosticKey = (item: SnapshotDiagnostic, file: string | undefined, entity: string | undefined) => `${item.code}\u0000${item.severity}\u0000${entity ?? ''}\u0000${file ?? ''}\u0000${item.reason}`;
  const counts = new Map<string, SnapshotDiagnostic[]>();
  for (const item of baseline.diagnostics) {
    const k = diagnosticKey(item, item.file ? renames.get(item.file) ?? item.file : undefined, item.entityId ? toUnion(item.entityId) : undefined);
    const list = counts.get(k) ?? []; list.push(item); counts.set(k, list);
  }
  const addedDiagnostics: SnapshotDiagnostic[] = [];
  for (const item of target.diagnostics) {
    const list = counts.get(diagnosticKey(item, item.file, item.entityId));
    if (list?.length) list.pop(); else addedDiagnostics.push(item);
  }
  const removedDiagnostics = [...counts.values()].flat().map(item => ({ ...item, ...(item.entityId ? { entityId: toUnion(item.entityId) } : {}) }));
  for (const item of [...addedDiagnostics, ...removedDiagnostics]) {
    const owner = item.entityId ?? (item.file ? fileIds.get(item.file) ?? fileIds.get(renames.get(item.file) ?? '') : undefined);
    if (owner) touch(owner, 'diagnostics');
  }
  return { lineage, changes, ghosts, addedRelations, removedRelations, addedDiagnostics, removedDiagnostics, toUnion, summary: summarize(baseline, target, changes, ghosts, lineage, addedRelations, removedRelations, addedDiagnostics, removedDiagnostics) };
}

function summarize(baseline: SnapshotData, target: SnapshotData, changes: Map<string, EntityChange>, ghosts: SnapshotEntity[], lineage: Lineage, addedRelations: SnapshotRelation[], removedRelations: SnapshotRelation[], addedDiagnostics: SnapshotDiagnostic[], removedDiagnostics: SnapshotDiagnostic[]): DiffSummary {
  const union = new Map<string, SnapshotEntity>([...ghosts, ...target.entities].map(entity => [entity.id, entity]));
  const beforeById = new Map(baseline.entities.map(entity => [entity.id, entity]));
  const entities = { added: 0, removed: 0, modified: 0, moved: 0 };
  const byType = new Map<string, DiffSummary['byType'][number]>();
  const files = { added: 0, removed: 0, modified: 0, moved: 0, locBefore: 0, locAfter: 0 };
  const interfaces: InterfaceChange[] = [];
  const applications: DiffSummary['applications'] = [];
  for (const [id, change] of changes) {
    if (change.status === 'unchanged') continue;
    const entity = union.get(id)!;
    entities[change.status]++;
    const row = byType.get(entity.type) ?? { type: entity.type, added: 0, removed: 0, modified: 0, moved: 0 };
    row[change.status]++; byType.set(entity.type, row);
    if (entity.type === 'file') files[change.status]++;
    const previousName = change.previousId ? beforeById.get(change.previousId)?.name : undefined;
    const renamed = previousName !== undefined && previousName !== entity.name ? { previousName } : {};
    if ((entity.type === 'route' || entity.type === 'api_endpoint') && interfaces.length < 300) interfaces.push({ id, type: entity.type, name: entity.name, status: change.status, ...renamed });
    if (entity.type === 'application') applications.push({ id, name: entity.name, status: change.status, ...renamed });
  }
  for (const entity of baseline.entities) if (entity.type === 'file') files.locBefore += entity.loc ?? 0;
  for (const entity of target.entities) if (entity.type === 'file') files.locAfter += entity.loc ?? 0;
  const relationTypes = new Map<string, { type: string; added: number; removed: number }>();
  for (const [list, field] of [[addedRelations, 'added'], [removedRelations, 'removed']] as const) for (const relation of list) { const row = relationTypes.get(relation.type) ?? { type: relation.type, added: 0, removed: 0 }; row[field]++; relationTypes.set(relation.type, row); }
  const codes = new Map<string, { code: string; severity: string; added: number; removed: number }>();
  for (const [list, field] of [[addedDiagnostics, 'added'], [removedDiagnostics, 'removed']] as const) for (const item of list) { const k = `${item.severity}\u0000${item.code}`; const row = codes.get(k) ?? { code: item.code, severity: item.severity, added: 0, removed: 0 }; row[field]++; codes.set(k, row); }
  const byReason: Record<string, number> = {};
  for (const reason of lineage.reasons.values()) byReason[reason] = (byReason[reason] ?? 0) + 1;
  const total = (row: { added: number; removed: number; modified?: number; moved?: number }) => row.added + row.removed + (row.modified ?? 0) + (row.moved ?? 0);
  const order: Record<string, number> = { added: 0, removed: 1, moved: 2, modified: 3 };
  return {
    entities,
    byType: [...byType.values()].sort((a, b) => total(b) - total(a) || (a.type < b.type ? -1 : 1)),
    relations: { added: addedRelations.length, removed: removedRelations.length, byType: [...relationTypes.values()].sort((a, b) => total(b) - total(a) || (a.type < b.type ? -1 : 1)) },
    diagnostics: { added: addedDiagnostics.length, removed: removedDiagnostics.length, byCode: [...codes.values()].sort((a, b) => total(b) - total(a) || (a.code < b.code ? -1 : 1)) },
    files,
    interfaces: interfaces.sort((a, b) => order[a.status]! - order[b.status]! || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    applications,
    lineage: { mapped: lineage.forward.size, byReason },
  };
}
export { STATUS_KEYS };
