// "What happens from here": a forward walk from an anchor (a page, an
// endpoint, a component or any function) drawn as typed steps.
//
// The walk follows routes_to, renders, calls, references, requests and
// handles. A node becomes a step when it is the anchor, a page route, an
// endpoint, the handler an endpoint runs, a trigger (a function bound to an
// event: onClick={save}, or called from an inline handler), or an action (it
// has effects — database, response, storage, navigation… — or makes HTTP
// requests). Effects are steps of their own. Everything in between (hooks,
// helpers, components, services without effects) is folded into the link as
// `via`, in order. The picture is finite because it is anchored and capped:
// layers, steps, fan-out per step, folded hops per link, and hubs (widely
// called helpers) are dead ends. Each cap is reported on the step it fired at.
import type { EffectFact, Entity } from '../core/graph.js';
import type { ProjectionIndex, ProjectionNode, RelationRow } from './hierarchy.js';

export type StepKind = 'anchor' | 'route' | 'endpoint' | 'handler' | 'trigger' | 'action' | 'effect';
export interface StepCap { reason: 'fanout' | 'layers' | 'steps' | 'hub'; hidden: number; detail?: string }
export interface WalkStep { id: string; kind: StepKind; layer: number; entityId?: string; effect?: EffectFact & { owner: string }; caps: StepCap[] }
export interface WalkLink { from: string; to: string; via: string[]; chain: number[]; event?: string; back: boolean }
export interface Walk { steps: WalkStep[]; links: WalkLink[]; truncated: boolean; unresolvedCallSites: number; explored: number }
export interface WalkContext {
  index: ProjectionIndex;
  relationMetadata(ids: string[]): Map<string, Record<string, unknown>>;
  entity(id: string): Entity | undefined;
}
export const STEP_FOLLOW = new Set(['routes_to', 'renders', 'calls', 'references', 'requests', 'handles']);
export const STEP_LIMITS = { layers: 8, steps: 60, fanout: 14, fold: 6, hub: 40 };
const KIND_ORDER: Record<StepKind, number> = { anchor: 0, route: 1, trigger: 2, action: 3, endpoint: 4, handler: 5, effect: 6 };

export function walkSteps(context: WalkContext, anchor: string, limits = STEP_LIMITS): Walk {
  const { index } = context;
  const entities = new Map<string, Entity | undefined>();
  const entityOf = (id: string) => { if (!entities.has(id)) entities.set(id, context.entity(id)); return entities.get(id); };
  const metadata = new Map<string, Record<string, unknown>>();
  const metaOf = (relation: RelationRow) => {
    if (!metadata.has(relation.id)) for (const [id, value] of context.relationMetadata([relation.id])) metadata.set(id, value);
    return metadata.get(relation.id) ?? {};
  };
  const effectsOf = (id: string): EffectFact[] => {
    const value = entityOf(id)?.metadata.effects;
    // A linked request is drawn as its endpoint; a wrapper's request belongs to its callers.
    return Array.isArray(value) ? (value as EffectFact[]).filter(effect => !(effect.category === 'network' && (effect.endpoint || effect.wrapper))) : [];
  };
  const outgoing = (id: string) => (index.adjacency.get(id) ?? []).filter(i => { const relation = index.relations[i]!; return relation.from === id && relation.to !== id && STEP_FOLLOW.has(relation.type) && relation.change !== 'removed'; });
  const incomingCount = (id: string) => (index.adjacency.get(id) ?? []).filter(i => { const relation = index.relations[i]!; return relation.to === id && relation.from !== id && (relation.type === 'calls' || relation.type === 'references'); }).length;
  const isAction = (id: string) => effectsOf(id).length > 0 || outgoing(id).some(i => index.relations[i]!.type === 'requests');
  const classify = (relation: RelationRow, target: ProjectionNode): { kind: StepKind; event?: string } | undefined => {
    if (target.type === 'route') return { kind: 'route' };
    if (target.type === 'api_endpoint') return { kind: 'endpoint' };
    if (relation.type === 'handles') return { kind: 'handler' };
    if (relation.type === 'references' || relation.type === 'calls') {
      const meta = metaOf(relation);
      const events = Array.isArray(meta.events) ? meta.events as string[] : [];
      const forms = Array.isArray(meta.forms) ? meta.forms as string[] : [];
      if (events.length && (relation.type === 'calls' || forms.includes('handler'))) return { kind: 'trigger', event: events[0] };
    }
    return isAction(target.id) ? { kind: 'action' } : undefined;
  };

  const steps = new Map<string, WalkStep>();
  const links: WalkLink[] = [];
  let truncated = false, unresolvedCallSites = 0, explored = 0;
  const counted = new Set<string>();
  const countUnresolved = (id: string) => { if (counted.has(id)) return; counted.add(id); const sites = entityOf(id)?.metadata.callSites as { unresolved?: number } | undefined; unresolvedCallSites += sites?.unresolved ?? 0; };
  const root = index.node(anchor);
  if (!root) return { steps: [], links: [], truncated: false, unresolvedCallSites: 0, explored: 0 };
  steps.set(anchor, { id: anchor, kind: 'anchor', layer: 0, entityId: anchor, caps: [] });
  const queue: string[] = [anchor];
  while (queue.length) {
    const step = steps.get(queue.shift()!)!;
    const owner = step.entityId!;
    countUnresolved(owner);
    if (step.layer >= limits.layers) { const hidden = outgoing(owner).length + effectsOf(owner).length; if (hidden) { step.caps.push({ reason: 'layers', hidden }); truncated = true; } continue; }
    // Reachable steps through folded nodes, shortest fold first.
    type Found = { target: string; kind: StepKind; via: string[]; chain: number[]; event?: string; effect?: EffectFact & { owner: string } };
    const found = new Map<string, Found>();
    for (const [i, effect] of effectsOf(owner).entries()) found.set(`effect:${owner}:${i}`, { target: `effect:${owner}:${i}`, kind: 'effect', via: [], chain: [], effect: { ...effect, owner } });
    const seen = new Set<string>([owner]);
    let frontier: { node: string; via: string[]; chain: number[] }[] = [{ node: owner, via: [], chain: [] }];
    let hubs = 0;
    while (frontier.length) {
      const next: typeof frontier = [];
      for (const current of frontier) {
        for (const relationIndex of outgoing(current.node)) {
          const relation = index.relations[relationIndex]!;
          const target = index.node(relation.to);
          if (!target || target.id === owner || current.via.includes(target.id)) continue;
          explored++;
          const kind = classify(relation, target);
          const chain = [...current.chain, relationIndex];
          if (kind) { if (!found.has(target.id)) found.set(target.id, { target: target.id, kind: kind.kind, via: current.via, chain, ...(kind.event ? { event: kind.event } : {}) }); continue; }
          if (seen.has(target.id)) continue;
          seen.add(target.id);
          countUnresolved(target.id);
          if (current.via.length >= limits.fold) continue;
          if (incomingCount(target.id) > limits.hub) { hubs++; continue; }
          const via = [...current.via, target.id];
          for (const [i, effect] of effectsOf(target.id).entries()) { const key = `effect:${target.id}:${i}`; if (!found.has(key)) found.set(key, { target: key, kind: 'effect', via, chain, effect: { ...effect, owner: target.id } }); }
          next.push({ node: target.id, via, chain });
        }
      }
      frontier = next;
    }
    if (hubs) step.caps.push({ reason: 'hub', hidden: hubs, detail: `widely used helpers (more than ${limits.hub} callers) are not followed` });
    const sorted = [...found.values()].sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.via.length - b.via.length || (a.effect?.line ?? 0) - (b.effect?.line ?? 0) || (a.target < b.target ? -1 : 1));
    if (sorted.length > limits.fanout) { step.caps.push({ reason: 'fanout', hidden: sorted.length - limits.fanout }); truncated = true; }
    for (const item of sorted.slice(0, limits.fanout)) {
      const existing = steps.get(item.target);
      if (!existing) {
        if (steps.size >= limits.steps) { const cap = step.caps.find(entry => entry.reason === 'steps'); if (cap) cap.hidden++; else step.caps.push({ reason: 'steps', hidden: 1 }); truncated = true; continue; }
        steps.set(item.target, { id: item.target, kind: item.kind, layer: step.layer + 1, caps: [], ...(item.effect ? { effect: item.effect } : { entityId: item.target }) });
        if (item.kind !== 'effect') queue.push(item.target);
      }
      links.push({ from: step.id, to: item.target, via: item.via, chain: item.chain, ...(item.event ? { event: item.event } : {}), back: !!existing && existing.layer <= step.layer });
    }
  }
  return { steps: [...steps.values()], links, truncated, unresolvedCallSites, explored };
}

/** Shortest forward path over step relations (plus imports, inheritance and table access), as relation indices. */
export function shortestPath(index: ProjectionIndex, from: string, to: string, maxDepth = 12): number[] | undefined {
  if (from === to) return [];
  const follow = new Set([...STEP_FOLLOW, 'imports', 'exports', 'extends', 'implements', 'reads', 'writes', 'maps_to']);
  const previous = new Map<string, number>([[from, -1]]);
  let frontier = [from];
  for (let depth = 0; depth < maxDepth && frontier.length && previous.size < 50_000; depth++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const relationIndex of index.adjacency.get(id) ?? []) {
        const relation = index.relations[relationIndex]!;
        if (relation.from !== id || relation.change === 'removed' || !follow.has(relation.type) || previous.has(relation.to)) continue;
        previous.set(relation.to, relationIndex);
        if (relation.to === to) {
          const path: number[] = [];
          for (let current = to; previous.get(current)! >= 0; current = index.relations[previous.get(current)!]!.from) path.unshift(previous.get(current)!);
          return path;
        }
        next.push(relation.to);
      }
    }
    frontier = next.sort();
  }
  return undefined;
}
