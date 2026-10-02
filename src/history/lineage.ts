// Lineage between two snapshots: which baseline entity became which target
// entity when its canonical ID changed. Canonical IDs stay strict (a renamed
// file is a new file entity); lineage is a separate, explained mapping used
// only to compare snapshots.
//
// Evidence, strongest first:
// 1. Git rename detection for files.
// 2. Directory renames implied by those file renames (path-prefix votes).
// 3. Symbols: same type and qualified name under the mapped parent (signature
//    change, file moved), or the same name-independent body fingerprint
//    (renamed symbol). Across parents, only with a unique, body-confirmed match.
// 4. Anything else with the same type and name under the mapped parent
//    (routes and endpoints of a renamed application, re-created files);
//    equal-sized groups of same-named siblings are paired in source order.
import type { SnapshotEntity } from './snapshot.js';

export type LineageReason = 'git-rename' | 'directory-rename' | 'qualified-name' | 'body' | 'name';
export interface Lineage {
  /** Baseline ID → target ID, only for entities whose ID changed. */
  forward: Map<string, string>;
  /** Target ID → baseline ID. */
  backward: Map<string, string>;
  /** Keyed by target ID. */
  reasons: Map<string, LineageReason>;
}
const SYMBOLS = new Set(['class', 'controller', 'component', 'function', 'method', 'model', 'test']);
const PATHED = new Set(['directory', 'application']);

export function emptyLineage(): Lineage { return { forward: new Map(), backward: new Map(), reasons: new Map() }; }
/** Directory correspondences implied by renamed files that keep a common path suffix. */
export function directoryRenames(renames: Map<string, string>): Map<string, string> {
  const votes = new Map<string, Map<string, number>>();
  for (const [from, to] of renames) {
    const a = from.split('/'), b = to.split('/');
    let shared = 0;
    while (shared < Math.min(a.length, b.length) - 1 && a[a.length - 1 - shared] === b[b.length - 1 - shared]) shared++;
    if (shared === 0) continue;
    for (let t = 1; t <= shared; t++) {
      const oldDir = a.slice(0, a.length - t).join('/'), newDir = b.slice(0, b.length - t).join('/');
      if (!oldDir || !newDir || oldDir === newDir) continue;
      const tally = votes.get(oldDir) ?? new Map<string, number>();
      tally.set(newDir, (tally.get(newDir) ?? 0) + 1); votes.set(oldDir, tally);
    }
  }
  const result = new Map<string, string>();
  for (const [oldDir, tally] of votes) {
    let best: string | undefined, bestVotes = 0, total = 0;
    for (const [newDir, count] of tally) { total += count; if (count > bestVotes || (count === bestVotes && best !== undefined && newDir < best)) { best = newDir; bestVotes = count; } }
    if (best && bestVotes * 2 > total) result.set(oldDir, best);
  }
  return result;
}

export function computeLineage(before: SnapshotEntity[], after: SnapshotEntity[], renames: Map<string, string> = new Map()): Lineage {
  const lineage = emptyLineage();
  const beforeById = new Map(before.map(entity => [entity.id, entity]));
  const afterById = new Map(after.map(entity => [entity.id, entity]));
  const added = new Map(after.filter(entity => !beforeById.has(entity.id)).map(entity => [entity.id, entity]));
  const removed = before.filter(entity => !afterById.has(entity.id));
  if (!added.size || !removed.length) return lineage;
  const link = (from: SnapshotEntity, to: SnapshotEntity, reason: LineageReason) => {
    lineage.forward.set(from.id, to.id); lineage.backward.set(to.id, from.id); lineage.reasons.set(to.id, reason);
    added.delete(to.id);
  };
  const mapped = (id: string | undefined) => id === undefined ? undefined : afterById.has(id) ? id : lineage.forward.get(id);
  const addedByPath = new Map<string, SnapshotEntity>();
  for (const entity of added.values()) if (entity.path && (entity.type === 'file' || PATHED.has(entity.type))) addedByPath.set(`${entity.type === 'file' ? 'file' : 'dir'}:${entity.path}`, entity);
  // 1–2. Paths.
  for (const entity of removed) {
    if (entity.type !== 'file' || !entity.path) continue;
    const target = renames.has(entity.path) ? addedByPath.get(`file:${renames.get(entity.path)}`) : undefined;
    if (target && added.has(target.id)) link(entity, target, 'git-rename');
  }
  const directories = directoryRenames(renames);
  for (const entity of removed) {
    if (!PATHED.has(entity.type) || !entity.path || lineage.forward.has(entity.id)) continue;
    const target = directories.has(entity.path) ? addedByPath.get(`dir:${directories.get(entity.path)}`) : undefined;
    if (target && added.has(target.id)) link(entity, target, 'directory-rename');
  }
  // 3–4. Parents before children, so a child can be matched under its mapped parent.
  const depth = new Map<string, number>();
  const depthOf = (entity: SnapshotEntity): number => {
    const known = depth.get(entity.id);
    if (known !== undefined) return known;
    const parent = entity.parentId ? beforeById.get(entity.parentId) : undefined;
    const value = parent ? depthOf(parent) + 1 : 0;
    depth.set(entity.id, value);
    return value;
  };
  const index = (key: (entity: SnapshotEntity) => string | undefined) => {
    const map = new Map<string, SnapshotEntity[]>();
    for (const entity of added.values()) { const k = key(entity); if (k) { const list = map.get(k) ?? []; list.push(entity); map.set(k, list); } }
    return map;
  };
  const qualifiedKey = (entity: SnapshotEntity) => SYMBOLS.has(entity.type) && entity.qualifiedName ? `${entity.type}|${entity.language ?? ''}|${entity.qualifiedName}` : undefined;
  const bodyKey = (entity: SnapshotEntity) => SYMBOLS.has(entity.type) && entity.body ? `${entity.type}|${entity.body}` : undefined;
  const nameKey = (entity: SnapshotEntity, parent: string | undefined) => `${entity.type}|${entity.name}|${parent ?? ''}`;
  const byQualified = index(qualifiedKey), byBody = index(bodyKey), byName = index(entity => nameKey(entity, entity.parentId));
  const removedBodies = new Map<string, number>();
  for (const entity of removed) { const key = bodyKey(entity); if (key) removedBodies.set(key, (removedBodies.get(key) ?? 0) + 1); }
  const available = (list: SnapshotEntity[] | undefined) => (list ?? []).filter(entity => added.has(entity.id));
  for (const entity of [...removed].sort((a, b) => depthOf(a) - depthOf(b) || (a.id < b.id ? -1 : 1))) {
    if (lineage.forward.has(entity.id)) continue;
    const parent = mapped(entity.parentId);
    const sameParent = (list: SnapshotEntity[]) => list.filter(candidate => candidate.parentId === parent);
    let target: SnapshotEntity | undefined, reason: LineageReason | undefined;
    const qualified = available(byQualified.get(qualifiedKey(entity) ?? ''));
    if (qualified.length) {
      const local = sameParent(qualified);
      if (local.length === 1) { target = local[0]; reason = 'qualified-name'; }
      else if (!local.length && qualified.length === 1) {
        // Moved to another parent: PHP names are namespace-qualified (unique);
        // TS names are module-local, so they also need the same body.
        const candidate = qualified[0]!;
        if (entity.language === 'php' || (entity.body && candidate.body === entity.body)) { target = candidate; reason = 'qualified-name'; }
      }
    }
    if (!target) {
      const key = bodyKey(entity);
      const bodies = available(byBody.get(key ?? ''));
      const local = sameParent(bodies);
      if (local.length === 1) { target = local[0]; reason = 'body'; }
      else if (key && bodies.length === 1 && removedBodies.get(key) === 1) { target = bodies[0]; reason = 'body'; }
    }
    if (!target && parent !== undefined) {
      const named = available(byName.get(nameKey(entity, parent)));
      if (named.length === 1) { target = named[0]; reason = 'name'; }
      else if (named.length > 1) {
        const peers = removed.filter(other => !lineage.forward.has(other.id) && other.type === entity.type && other.name === entity.name && mapped(other.parentId) === parent);
        if (peers.length === named.length) {
          const order = (a: SnapshotEntity, b: SnapshotEntity) => (a.sourceRange?.startLine ?? 0) - (b.sourceRange?.startLine ?? 0) || (a.id < b.id ? -1 : 1);
          const targets = [...named].sort(order);
          peers.sort(order).forEach((peer, i) => link(peer, targets[i]!, 'name'));
          continue;
        }
      }
    }
    if (target && reason) link(entity, target, reason);
  }
  return lineage;
}
