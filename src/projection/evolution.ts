// Time-lapse of a branch's history on the timeline layout. Each frame is one
// indexed commit, encoded as a change to the frame before it: which nodes
// appear or disappear, where they are, and what changed in that commit.
//
// Frames are built with the same hierarchy (ProjectionIndex) and placement
// (placeOnTimeline) as the history views, so a frame coincides with the
// settled view of its snapshot compared with the previous commit: removed
// entities stay for one frame as ghosts in their places. Commits are visited
// in timeline order through membership deltas, so an entity is loaded once
// per version, and commits that change no layout input reuse the previous
// rectangles. The work yields to the event loop between slices so a server
// stays responsive while it runs.
import type { SnapshotEntity } from '../history/snapshot.js';
import type { HistoryStore, SnapshotRecord } from '../history/store.js';
import type { EvolutionFrame, EvolutionNode } from './dto.js';
import { INTERFACE_TYPES, ProjectionIndex, type ProjectionNode } from './hierarchy.js';
import { leafSide, placeOnTimeline, type TimelineLayout, type TimelineRegistry } from './layout.js';

export const EVOLUTION_STATUS = { added: 1, modified: 2, moved: 3, removed: 4 } as const;
export interface EvolutionData { nodes: EvolutionNode[]; frames: EvolutionFrame[] }
/** Progress of a running computation; set `cancelled` to stop it. */
export interface EvolutionJob { cancelled: boolean; progress: number }
/** The timeline layout for a hierarchy rooted at `rootId`. */
export type TimelinePlacement = (rootId: string) => { registry: TimelineRegistry; layout: TimelineLayout } | undefined;

const DETAIL_TYPES = new Set(['application', 'route', 'api_endpoint']);
const PATH_TYPES = new Set(['application', 'directory', 'file']);
const SLICE_MS = 12;

/** Everything about an entity that the layout reads; when none of it changes, neither do the rectangles. */
function layoutInputs(entity: SnapshotEntity): string {
  const span = entity.sourceRange ? entity.sourceRange.endLine - entity.sourceRange.startLine + 1 : undefined;
  const grouping = INTERFACE_TYPES.has(entity.type) ? `${entity.name}\u0000${entity.routePath ?? ''}` : '';
  return `${entity.type}\u0000${entity.parentId ?? ''}\u0000${grouping}\u0000${leafSide(entity.loc ?? span)}`;
}
/**
 * Status of an entity present in both commits (possibly under a new identity), by the same facets as the
 * snapshot diff: `parentOf` maps the earlier parent to its identity now. 0: unchanged.
 */
export function evolutionChange(before: SnapshotEntity, after: SnapshotEntity, parentOf: (id: string | undefined) => string | undefined = id => id): number {
  if (parentOf(before.parentId) !== after.parentId || before.name !== after.name || (before.path !== after.path && PATH_TYPES.has(after.type))) return EVOLUTION_STATUS.moved;
  const source = before.content !== undefined && after.content !== undefined ? before.content !== after.content : (before.content === undefined) !== (after.content === undefined) && after.type === 'file';
  if (source || before.type !== after.type || (before.signature ?? '') !== (after.signature ?? '') || before.shape !== after.shape) return EVOLUTION_STATUS.modified;
  if ((before.content === undefined || after.content === undefined) && before.loc !== after.loc) return EVOLUTION_STATUS.modified;
  return 0;
}

/** Frames for `snapshots` (timeline order, oldest first). Undefined when cancelled. */
export async function computeEvolution(history: HistoryStore, snapshots: SnapshotRecord[], placement: TimelinePlacement, job: EvolutionJob = { cancelled: false, progress: 0 }): Promise<EvolutionData | undefined> {
  const versions = history.entityVersions();
  const nodes: EvolutionNode[] = [], indexOf = new Map<string, number>();
  const register = (node: ProjectionNode): number => {
    let index = indexOf.get(node.id);
    if (index === undefined) {
      index = nodes.length; indexOf.set(node.id, index);
      nodes.push({ id: node.id, kind: node.kind, type: node.type, name: node.name, ...(DETAIL_TYPES.has(node.type) && node.detail ? { detail: node.detail } : {}), ...(node.language ? { language: node.language } : {}), ...(node.path && PATH_TYPES.has(node.type) ? { path: node.path } : {}) });
    }
    return index;
  };
  const frames: EvolutionFrame[] = [];
  const present = new Map<string, SnapshotEntity>();
  let placed = new Map<number, number[]>();
  let previousSeq = 0, hadGhosts = false, slice = performance.now();
  let timeline: ReturnType<TimelinePlacement>;
  for (const [position, snapshot] of snapshots.entries()) {
    if (job.cancelled) return undefined;
    const delta = history.entityDelta(snapshot.seq, previousSeq);
    // Versions this commit replaced or dropped, by entity, then the versions it brought.
    const before = new Map<string, SnapshotEntity>();
    for (const vid of delta.removed) { const entity = versions.get(vid); if (entity && present.get(entity.id) === entity) { present.delete(entity.id); before.set(entity.id, entity); } }
    const touched = new Set(before.keys());
    for (const vid of delta.added) { const entity = versions.get(vid); if (entity) { present.set(entity.id, entity); touched.add(entity.id); } }
    timeline ??= placement([...present.values()].find(entity => entity.type === 'repository' && !entity.parentId)?.id ?? '');
    if (!timeline) throw new Error(`No timeline layout for snapshot ${snapshot.id}`);
    const { registry, layout } = timeline;
    const slot = (id: string) => registry.alias[id] ?? id;
    // A new identity in the slot of one that vanished is that entity, renamed or moved (the layout registry followed its lineage).
    const vanished = new Map<string, string>();
    for (const id of before.keys()) if (!present.has(id)) vanished.set(slot(id), id);
    const statuses = new Map<string, number>(), successor = new Map<string, string>(), predecessor = new Map<string, string>();
    for (const id of touched) {
      if (!present.has(id) || before.has(id)) continue;
      const old = vanished.get(slot(id));
      if (old !== undefined && !successor.has(old)) { successor.set(old, id); predecessor.set(id, old); }
    }
    const parentOf = (id: string | undefined) => id === undefined ? undefined : successor.get(id) ?? id;
    let structural = hadGhosts || position === 0;
    for (const id of touched) {
      const after = present.get(id), prior = before.get(id) ?? before.get(predecessor.get(id) ?? '');
      if (after && prior) {
        const status = evolutionChange(prior, after, parentOf);
        if (status) statuses.set(id, status);
        if (prior.id !== id || layoutInputs(prior) !== layoutInputs(after)) structural = true;
      } else {
        structural = true;
        if (after) statuses.set(id, EVOLUTION_STATUS.added);
      }
    }
    // Removed entities stay one frame as ghosts, under their parent (or where the parent moved to).
    const ghosts: SnapshotEntity[] = [];
    if (position > 0) for (const [id, entity] of before) {
      if (present.has(id) || successor.has(id)) continue;
      let parentId = entity.parentId;
      if (parentId !== undefined && !present.has(parentId) && (!before.has(parentId) || successor.has(parentId))) parentId = successor.get(parentId);
      if (entity.parentId !== undefined && parentId === undefined) continue;
      ghosts.push({ ...entity, ...(parentId !== undefined ? { parentId } : {}) });
      statuses.set(id, EVOLUTION_STATUS.removed);
    }
    let next: Map<number, number[]>;
    if (structural) {
      const index = new ProjectionIndex(snapshot.id, [...present.values(), ...ghosts], [], []);
      const { rects } = placeOnTimeline(index.layoutNodes(), index.rootId, registry, layout);
      next = new Map();
      for (const node of index.nodes.values()) {
        const rect = rects.get(node.id);
        if (!rect) continue;
        const parent = node.spatialParentId !== undefined ? indexOf.get(node.spatialParentId) ?? -1 : -1;
        next.set(register(node), [parent, rect.x, rect.y, rect.w, rect.h, node.loc ?? -1]);
      }
    } else {
      // Same places and sizes: only measured lines (block heights) can differ.
      next = new Map(placed);
      for (const id of touched) {
        const index = indexOf.get(id), entry = index !== undefined ? next.get(index) : undefined;
        const loc = present.get(id)?.loc ?? -1;
        if (entry && entry[5] !== loc) next.set(index!, [...entry.slice(0, 5), loc]);
      }
    }
    const set: number[][] = [];
    for (const [index, entry] of next) { const previous = placed.get(index); if (!previous || previous.some((value, i) => value !== entry[i])) set.push([index, ...entry]); }
    const drop = [...placed.keys()].filter(index => !next.has(index));
    const changes = position === 0 ? [] : [...statuses].flatMap(([id, status]) => { const index = indexOf.get(id); return index !== undefined && next.has(index) ? [[index, status]] : []; });
    frames.push({ snapshot: snapshot.id, set, drop, changes });
    placed = next; previousSeq = snapshot.seq; hadGhosts = ghosts.length > 0;
    job.progress = (position + 1) / snapshots.length;
    if (performance.now() - slice > SLICE_MS) { await new Promise(resolve => setImmediate(resolve)); slice = performance.now(); }
  }
  return { nodes, frames };
}
