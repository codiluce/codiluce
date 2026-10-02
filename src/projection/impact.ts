// Blast radius: what depends on an entity, hop by hop, over indexed relations.
//
// Every relation reads "from depends on to" (a caller on its callee, an
// endpoint on its handler, a page on its component, a requester on the
// endpoint it reaches), so dependents are the `from` side of incoming
// relations. Symbols follow symbol-level relations only (calls, renders,
// references, handles, routes_to, requests, extends, implements); files follow
// file-level ones (imports, re-exports). Containment is never climbed: a
// change to one method does not make every importer of its file a dependent.
// Seeding a container seeds everything inside it. The walk is bounded by
// depth and node count; what it cannot see (unresolved calls and HTTP
// requests) is reported separately, so the result reads as a lower bound.
import type { ProjectionIndex, ProjectionNode } from './hierarchy.js';

export const SYMBOL_IMPACT_TYPES = ['calls', 'renders', 'references', 'handles', 'routes_to', 'requests', 'extends', 'implements'] as const;
export const FILE_IMPACT_TYPES = ['imports', 'exports'] as const;
export const DEFAULT_IMPACT_DEPTH = 4, MAX_IMPACT_DEPTH = 10, MAX_IMPACT_NODES = 5000, MAX_IMPACT_SEEDS = 3000;
export interface ImpactComputation {
  seeds: string[];
  /** Entity → hops from the nearest seed (seeds are 0). */
  distance: Map<string, number>;
  /** Entity → index (in the index's relations) of the relation it was first reached through. */
  via: Map<string, number>;
  truncated: boolean; seedsTruncated: boolean;
}
export interface ImpactOptions { depth: number; types?: ReadonlySet<string>; includeRemoved?: boolean }

/** Seeds for an entity: itself and, for containers, the entities inside it. */
export function seedsOf(index: ProjectionIndex, node: ProjectionNode): { seeds: string[]; truncated: boolean } {
  const seeds: string[] = [];
  const visit = (current: ProjectionNode): void => {
    if (seeds.length >= MAX_IMPACT_SEEDS) return;
    if (current.kind === 'entity' && current.change?.status !== 'removed') seeds.push(current.id);
    for (const child of current.children) visit(index.node(child)!);
  };
  visit(node);
  return { seeds, truncated: seeds.length >= MAX_IMPACT_SEEDS };
}

export function computeImpact(index: ProjectionIndex, seeds: string[], options: ImpactOptions): ImpactComputation {
  const depth = Math.max(1, Math.min(MAX_IMPACT_DEPTH, options.depth));
  const distance = new Map<string, number>(), via = new Map<string, number>();
  let frontier: string[] = [];
  for (const seed of seeds) if (!distance.has(seed)) { distance.set(seed, 0); frontier.push(seed); }
  let truncated = false;
  for (let level = 1; level <= depth && frontier.length && !truncated; level++) {
    const next: string[] = [];
    for (const id of frontier) {
      const node = index.node(id);
      if (!node) continue;
      const allowed: readonly string[] = node.type === 'file' ? FILE_IMPACT_TYPES : SYMBOL_IMPACT_TYPES;
      for (const relationIndex of index.adjacency.get(id) ?? []) {
        const relation = index.relations[relationIndex]!;
        if (relation.to !== id || relation.from === id || !allowed.includes(relation.type) || (options.types && !options.types.has(relation.type))) continue;
        if (relation.change === 'removed' && !options.includeRemoved) continue;
        if (distance.has(relation.from)) continue;
        if (distance.size >= MAX_IMPACT_NODES) { truncated = true; break; }
        distance.set(relation.from, level); via.set(relation.from, relationIndex); next.push(relation.from);
      }
      if (truncated) break;
    }
    // Stable order keeps results identical across runs.
    frontier = next.sort();
  }
  return { seeds, distance, via, truncated, seedsTruncated: seeds.length >= MAX_IMPACT_SEEDS };
}
/** Hops from a seed to `id`, origin first, as relation indices. */
export function impactPath(result: ImpactComputation, index: ProjectionIndex, id: string): number[] {
  const path: number[] = [];
  for (let current = id; result.via.has(current) && path.length < MAX_IMPACT_DEPTH + 1;) {
    const relationIndex = result.via.get(current)!;
    path.unshift(relationIndex);
    current = index.relations[relationIndex]!.to;
  }
  return path;
}
