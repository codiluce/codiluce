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
// `via`, in order. Nothing is capped: every step reachable from the anchor is
// drawn, each once. The one boundary is navigation: a request to another
// page's endpoint is a step, but that page's own steps are another journey.
import type { EffectFact, Entity } from '../core/graph.js';
import type { ProjectionIndex, ProjectionNode, RelationRow } from './hierarchy.js';

export type StepKind = 'anchor' | 'route' | 'endpoint' | 'handler' | 'trigger' | 'action' | 'effect';
export interface WalkStep {
  id: string; kind: StepKind; layer: number; entityId?: string; effect?: EffectFact & { owner: string };
  /** An endpoint serving another page, reached by a request: a step, not followed. */
  navigation?: boolean;
}
export interface WalkLink { from: string; to: string; via: string[]; chain: number[]; event?: string; back: boolean }
export interface Walk { steps: WalkStep[]; links: WalkLink[]; unresolvedCallSites: number; explored: number }
export interface WalkContext {
  index: ProjectionIndex;
  relationMetadata(ids: string[]): Map<string, Record<string, unknown>>;
  entity(id: string): Entity | undefined;
  /** Endpoints serving a page (`pageEndpoints`): reaching one by a request is navigation. */
  pages?: ReadonlySet<string>;
}
export const STEP_FOLLOW = new Set(['routes_to', 'renders', 'calls', 'references', 'requests', 'handles']);
const KIND_ORDER: Record<StepKind, number> = { anchor: 0, route: 1, trigger: 2, action: 3, endpoint: 4, handler: 5, effect: 6 };

export function walkSteps(context: WalkContext, anchor: string): Walk {
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
  // Where a step's code is: its file and line (an effect: its owner's file, the effect's line).
  const placeOf = (item: { target: string; effect?: EffectFact & { owner: string } }): { path: string; line: number } => {
    const node = index.node(item.effect ? item.effect.owner : item.target);
    return { path: node?.path ?? '', line: item.effect?.line ?? node?.sourceRange?.startLine ?? 0 };
  };
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
  let unresolvedCallSites = 0, explored = 0;
  const counted = new Set<string>();
  const countUnresolved = (id: string) => { if (counted.has(id)) return; counted.add(id); const sites = entityOf(id)?.metadata.callSites as { unresolved?: number } | undefined; unresolvedCallSites += sites?.unresolved ?? 0; };
  const root = index.node(anchor);
  if (!root) return { steps: [], links: [], unresolvedCallSites: 0, explored: 0 };
  steps.set(anchor, { id: anchor, kind: 'anchor', layer: 0, entityId: anchor });
  const queue: string[] = [anchor];
  while (queue.length) {
    const step = steps.get(queue.shift()!)!;
    const owner = step.entityId!;
    countUnresolved(owner);
    // Reachable steps through folded nodes, shortest fold first.
    type Found = { target: string; kind: StepKind; via: string[]; chain: number[]; event?: string; effect?: EffectFact & { owner: string } };
    const found = new Map<string, Found>();
    for (const [i, effect] of effectsOf(owner).entries()) found.set(`effect:${owner}:${i}`, { target: `effect:${owner}:${i}`, kind: 'effect', via: [], chain: [], effect: { ...effect, owner } });
    const seen = new Set<string>([owner]);
    let frontier: { node: string; via: string[]; chain: number[] }[] = [{ node: owner, via: [], chain: [] }];
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
          const via = [...current.via, target.id];
          for (const [i, effect] of effectsOf(target.id).entries()) { const key = `effect:${target.id}:${i}`; if (!found.has(key)) found.set(key, { target: key, kind: 'effect', via, chain, effect: { ...effect, owner: target.id } }); }
          next.push({ node: target.id, via, chain });
        }
      }
      frontier = next;
    }
    // Closest first (fewest folded hops), then by component and source position.
    const sorted = [...found.values()].sort((a, b) => a.via.length - b.via.length || compareText(placeOf(a).path, placeOf(b).path) || placeOf(a).line - placeOf(b).line || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || (a.target < b.target ? -1 : 1));
    for (const item of sorted) {
      const existing = steps.get(item.target);
      if (!existing) {
        const navigation = item.kind === 'endpoint' && !!context.pages?.has(item.target) && index.relations[item.chain.at(-1)!]?.type === 'requests';
        steps.set(item.target, { id: item.target, kind: item.kind, layer: step.layer + 1, ...(item.effect ? { effect: item.effect } : { entityId: item.target }), ...(navigation ? { navigation } : {}) });
        if (item.kind !== 'effect' && !navigation) queue.push(item.target);
      }
      links.push({ from: step.id, to: item.target, via: item.via, chain: item.chain, ...(item.event ? { event: item.event } : {}), back: !!existing && existing.layer <= step.layer });
    }
  }
  return { steps: [...steps.values()], links, unresolvedCallSites, explored };
}
function compareText(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
