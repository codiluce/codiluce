// Request flows: what one HTTP request does, end to end, as far as the index
// can tell. Derived per endpoint, the one entity both sides of a request share:
//
//   client (a page, an event binding) → the HTTP call → the route → middleware
//   and validation → the controller → services → models, tables and other side
//   effects → the responses it can give → back on the client (what the caller
//   does once the response arrives, by source order).
//
// Inbound, the walk goes backwards from the endpoint: `requests` to the
// functions making the call, then incoming calls, references, renders and
// routes_to up to a page route (or the outermost caller). Server side, it goes
// forwards from the handler over calls, collecting effects and table access.
// What the index cannot see is drawn as a gap instead of being left out: call
// sites that were not resolved, an endpoint nothing indexed calls, a request no
// endpoint matches, a missing handler or response. A flow is therefore a lower
// bound of the real behaviour, and never evidence of execution. Pure: the same
// index gives the same flow.
//
// Inertia: a page component rendered by a handler (`renders` from the
// server) is entered through the endpoint that serves it, and an Inertia
// response draws the page it renders back on the client. Console entry points
// get the same picture without HTTP: a scheduled task or the code running a
// command by name, the command, its handler and what it reaches.
import type { EffectFact, Entity } from '../core/graph.js';
import type { ProjectionIndex, ProjectionNode, RelationRow } from './hierarchy.js';

/** Columns of a request flow, in the order a request passes them. */
export type FlowLane = 'client' | 'call' | 'route' | 'gate' | 'controller' | 'service' | 'data' | 'response' | 'return';
export const FLOW_LANES: FlowLane[] = ['client', 'call', 'route', 'gate', 'controller', 'service', 'data', 'response', 'return'];
export type FlowNodeKind = 'page' | 'entry' | 'trigger' | 'caller' | 'endpoint' | 'command' | 'schedule' | 'middleware' | 'validation' | 'handler' | 'method' | 'model' | 'table' | 'effect' | 'response' | 'receive' | 'continuation' | 'gap';
export type FlowEdgeKind = 'triggers' | 'calls' | 'requests' | 'invokes' | 'routes' | 'handles' | 'reads' | 'writes' | 'maps' | 'effect' | 'responds' | 'returns' | 'renders' | 'then' | 'gap';
export type FlowGapReason = 'no-trigger' | 'no-caller' | 'unmatched' | 'no-handler' | 'unresolved-calls' | 'no-response';
/** `unmatched`: a request no indexed endpoint answers. `headless`: an endpoint no indexed code calls (a command nothing schedules or runs: run by hand). */
export type FlowStatus = 'complete' | 'partial' | 'headless' | 'unmatched';
export interface FlowStages {
  /** A page or event binding leads to the HTTP call. */
  client: boolean;
  /** Indexed code makes the request. */
  call: boolean;
  handler: boolean;
  /** A model, table or other side effect is reached. */
  data: boolean;
  response: boolean;
  /** Something the caller does after the response arrives was found. */
  returns: boolean;
}
export interface FlowGap { reason: FlowGapReason; text: string; names?: string[]; count?: number }
export interface RawFlowNode {
  id: string; lane: FlowLane; kind: FlowNodeKind;
  /** Sub-column inside the lane (deeper calls in the same layer move right). */
  depth: number;
  label: string; detail?: string;
  entityId?: string;
  effect?: EffectFact & { owner: string };
  status?: number; event?: string;
  gap?: FlowGap;
}
export interface RawFlowEdge {
  id: string; from: string; to: string; kind: FlowEdgeKind; label?: string;
  /** Indexed relationships the edge stands for (relation indices), in order. */
  chain: number[];
  /** Entities folded into the edge, in order. */
  via: string[];
  /** The source site, for reading the conditions it runs under. */
  site?: { owner: string; line: number; hint?: string };
}
export interface RawFlow {
  id: string; kind: 'endpoint' | 'unmatched' | 'command' | 'schedule'; anchor: string;
  name: string; method: string; path: string;
  nodes: RawFlowNode[]; edges: RawFlowEdge[];
  stages: FlowStages; status: FlowStatus; gaps: number;
  callers: number; tables: number; responses: number[];
  handler?: string;
  /** Unmatched requests: the entity making them. */
  caller?: string;
  /** Every entity drawn, for "flows through this entity". */
  members: string[];
  truncated: boolean; notices: string[];
}
export interface FlowContext {
  index: ProjectionIndex;
  relationMetadata(ids: string[]): Map<string, Record<string, unknown>>;
  entity(id: string): Entity | undefined;
  /** HTTP findings (unmatched, ambiguous, unresolved requests) of an entity. */
  findings?(entityId: string): { code: string; reason: string; line?: number }[];
}
export const FLOW_LIMITS = { callers: 8, entries: 3, clientDepth: 8, clientVisits: 400, fanout: 14, serverDepth: 6, nodes: 56, hub: 40, laneDepth: 3, returns: 24 };
// `handles` reaches the endpoint serving an Inertia page from the handler that renders it.
const CLIENT_FOLLOW = new Set(['calls', 'references', 'renders', 'routes_to', 'handles']);
const ENTRY_TYPES = new Set(['route', 'api_endpoint']);
const SERVER_FOLLOW = new Set(['calls', 'references']);
const CALLABLE = new Set(['method', 'function']);
const LANE_ORDER = new Map(FLOW_LANES.map((lane, index) => [lane, index]));
/** A FormRequest type-hint: the framework validates before the handler body runs (the analyzer's phrasing). */
const BEFORE_HANDLER = / validates the request before /;

/** Short display name: `AuthController::login`, `AccountService.signIn`, a function's name. */
export function displayName(node: ProjectionNode): string {
  if (node.type !== 'method' || !node.qualifiedName) return node.name;
  return node.qualifiedName.split('\\').at(-1) ?? node.name;
}

class FlowBuilder {
  readonly nodes = new Map<string, RawFlowNode>();
  readonly edges: RawFlowEdge[] = [];
  private readonly edgeKeys = new Set<string>();
  truncated = false;
  readonly notices: string[] = [];
  constructor(private readonly limit: number) {}
  add(node: RawFlowNode): RawFlowNode | undefined {
    const existing = this.nodes.get(node.id);
    if (existing) return existing;
    if (this.nodes.size >= this.limit) { this.truncated = true; return undefined; }
    this.nodes.set(node.id, node);
    return node;
  }
  link(from: RawFlowNode | undefined, to: RawFlowNode | undefined, kind: FlowEdgeKind, extra: Partial<Pick<RawFlowEdge, 'label' | 'chain' | 'via' | 'site'>> = {}): void {
    if (!from || !to || from.id === to.id) return;
    const id = `${from.id}>${to.id}`;
    if (this.edgeKeys.has(id)) return;
    this.edgeKeys.add(id);
    this.edges.push({ id, from: from.id, to: to.id, kind, chain: extra.chain ?? [], via: extra.via ?? [], ...(extra.label ? { label: extra.label } : {}), ...(extra.site ? { site: extra.site } : {}) });
  }
}

/** Walks shared by the endpoint and unmatched-request flows; caches entity and relation lookups. */
class FlowWalker {
  private readonly entities = new Map<string, Entity | undefined>();
  private readonly metadata = new Map<string, Record<string, unknown>>();
  constructor(readonly context: FlowContext, readonly limits: typeof FLOW_LIMITS) {}
  get index(): ProjectionIndex { return this.context.index; }
  entity(id: string): Entity | undefined { if (!this.entities.has(id)) this.entities.set(id, this.context.entity(id)); return this.entities.get(id); }
  meta(relationIndex: number): Record<string, unknown> {
    const relation = this.index.relations[relationIndex]!;
    if (!this.metadata.has(relation.id)) {
      const found = this.context.relationMetadata([relation.id]);
      this.metadata.set(relation.id, found.get(relation.id) ?? {});
    }
    return this.metadata.get(relation.id)!;
  }
  effects(id: string): EffectFact[] { const value = this.entity(id)?.metadata.effects; return Array.isArray(value) ? value as EffectFact[] : []; }
  name(id: string): string { const node = this.index.node(id); return node ? displayName(node) : id; }
  private relations(id: string, test: (relation: RelationRow) => boolean): number[] {
    return (this.index.adjacency.get(id) ?? []).filter(i => { const relation = this.index.relations[i]!; return relation.change !== 'removed' && relation.from !== relation.to && test(relation); });
  }
  incoming(id: string, types: Set<string>): number[] { return this.relations(id, relation => relation.to === id && types.has(relation.type)); }
  outgoing(id: string, types: Set<string>): number[] { return this.relations(id, relation => relation.from === id && types.has(relation.type)); }
  callerCount(id: string): number { return this.relations(id, relation => relation.to === id && (relation.type === 'calls' || relation.type === 'references')).length; }
  firstLine(relationIndex: number): number | undefined { const lines = this.meta(relationIndex).lines; return Array.isArray(lines) && typeof lines[0] === 'number' ? lines[0] : undefined; }
  events(relationIndex: number): string[] {
    const relation = this.index.relations[relationIndex]!;
    if (relation.type !== 'calls' && relation.type !== 'references') return [];
    const meta = this.meta(relationIndex);
    const events = Array.isArray(meta.events) ? meta.events as string[] : [];
    const forms = Array.isArray(meta.forms) ? meta.forms as string[] : [];
    return events.length && (relation.type === 'calls' || forms.includes('handler')) ? events : [];
  }
  /** Order relation indices by the name of the entity at their other end, for stable pictures. */
  byName(indices: number[], end: 'from' | 'to'): number[] {
    return [...indices].sort((a, b) => { const x = this.name(this.index.relations[a]![end]), y = this.name(this.index.relations[b]![end]); return x < y ? -1 : x > y ? 1 : a - b; });
  }

  /**
   * How the client reaches a caller: chains from an entry (a page route, or
   * the outermost caller when no route is reached) down to the caller, each
   * as entities with the relation that leads into the next one.
   */
  entryChains(caller: string): { nodes: string[]; relations: number[] }[] {
    const previous = new Map<string, { next: string; relation: number } | undefined>([[caller, undefined]]);
    const routes: string[] = [], roots: string[] = [];
    let frontier = [caller], visits = 0, last = caller;
    for (let depth = 0; depth < this.limits.clientDepth && frontier.length && visits < this.limits.clientVisits; depth++) {
      const next: string[] = [];
      for (const id of frontier) {
        const incoming = this.byName(this.incoming(id, CLIENT_FOLLOW), 'from');
        if (!incoming.length && id !== caller) roots.push(id);
        for (const relationIndex of incoming.slice(0, this.limits.fanout)) {
          const from = this.index.relations[relationIndex]!.from;
          if (previous.has(from)) continue;
          previous.set(from, { next: id, relation: relationIndex });
          visits++; last = from;
          const fromNode = this.index.node(from);
          // A HEAD route mirrors its GET twin: the page is entered once.
          if (fromNode?.type === 'api_endpoint' && fromNode.name.startsWith('HEAD ')) continue;
          if (ENTRY_TYPES.has(fromNode?.type ?? '')) { routes.push(from); continue; }
          next.push(from);
        }
      }
      frontier = next;
    }
    const entries = routes.length ? routes : roots.length ? roots : last !== caller ? [last] : [];
    return entries.slice(0, this.limits.entries).map(entry => {
      const nodes = [entry], relations: number[] = [];
      for (let step = previous.get(entry); step; step = previous.get(step.next)) { relations.push(step.relation); nodes.push(step.next); }
      return { nodes, relations };
    });
  }

  /**
   * Client lane for one caller: entry → trigger → caller, with plumbing folded
   * into the links. Returns the chain used, for the continuation.
   */
  clientSide(builder: FlowBuilder, callerNode: RawFlowNode, caller: string): { nodes: string[]; relations: number[] } | undefined {
    const chains = this.entryChains(caller);
    if (!chains.length) {
      const gap = builder.add({ id: `gap:no-trigger:${caller}`, lane: 'client', kind: 'gap', depth: 0, label: 'No indexed caller', detail: `Nothing indexed calls ${this.name(caller)}`, gap: { reason: 'no-trigger', text: `Nothing in the indexed code calls ${this.name(caller)}: it may run from a callback, a prop, a framework hook or code outside the index.` } });
      builder.link(gap, callerNode, 'gap');
      return undefined;
    }
    for (const chain of chains) {
      const entry = chain.nodes[0]!;
      const entryNode = this.index.node(entry)!;
      const page = entryNode.type === 'route' || entryNode.type === 'api_endpoint';
      const start = builder.add({ id: `client:${entry}`, lane: 'client', kind: page ? 'page' : 'entry', depth: 0, entityId: entry, label: displayName(entryNode), ...(entryNode.type === 'route' ? { detail: 'page' } : entryNode.type === 'api_endpoint' ? { detail: 'serves the page (Inertia)' } : {}) });
      // The binding that fires the request: the event relation closest to the caller.
      let bound = -1;
      for (let i = chain.relations.length - 1; i >= 0; i--) if (this.events(chain.relations[i]!).length) { bound = i; break; }
      const target = bound >= 0 ? chain.nodes[bound + 1]! : undefined;
      const event = bound >= 0 ? this.events(chain.relations[bound]!)[0] : undefined;
      const host = bound >= 0 ? chain.nodes[bound]! : undefined;
      const eventLabel = event ? `${event}${host && host !== entry ? ` · ${this.name(host)}` : ''}` : undefined;
      if (target && target !== caller && bound >= 0) {
        const trigger = builder.add({ id: `client:${target}`, lane: 'client', kind: 'trigger', depth: 1, entityId: target, label: this.name(target), ...(event ? { event, detail: `on ${event}` } : {}) });
        builder.link(start, trigger, 'triggers', { label: eventLabel, chain: chain.relations.slice(0, bound + 1), via: chain.nodes.slice(1, bound + 1) });
        builder.link(trigger, callerNode, 'calls', { chain: chain.relations.slice(bound + 1), via: chain.nodes.slice(bound + 2, -1) });
      } else {
        builder.link(start, callerNode, bound >= 0 ? 'triggers' : 'calls', { label: eventLabel, chain: chain.relations, via: chain.nodes.slice(1, -1) });
      }
    }
    return chains[0];
  }

  /**
   * What the client does once the response is back: effects of the caller
   * after the request's line, then of each caller up the chain after its own
   * call (while the chain is made of calls). Source order only.
   */
  continuation(builder: FlowBuilder, receiver: RawFlowNode, caller: string, requestLine: number | undefined, chain: { nodes: string[]; relations: number[] } | undefined, isRequest: (effect: EffectFact) => boolean): boolean {
    let found = false;
    const after = (owner: string, line: number | undefined) => {
      if (line === undefined) return;
      for (const effect of this.effects(owner)) {
        if (effect.line <= line || isRequest(effect) || effect.category === 'network' && effect.wrapper) continue;
        const node = builder.add({ id: `then:${owner}:${effect.line}:${effect.category}:${effect.operation}`, lane: 'return', kind: 'continuation', depth: 1, label: `${effect.category} · ${effect.operation}`, detail: effect.detail, effect: { ...effect, owner } });
        builder.link(receiver, node, 'then', { ...(owner !== caller ? { label: `in ${this.name(owner)}` } : {}), site: { owner, line: effect.line, hint: effect.detail } });
        if (node) found = true;
      }
    };
    after(caller, requestLine);
    if (chain) {
      for (let i = chain.relations.length - 1; i >= 0; i--) {
        const relationIndex = chain.relations[i]!;
        if (this.index.relations[relationIndex]!.type !== 'calls' || this.events(relationIndex).length) break;
        after(chain.nodes[i]!, this.firstLine(relationIndex));
      }
    }
    return found;
  }

  /** Lane of a server-side callable: controllers (and the handler's own class), models, or services. */
  laneOf(id: string, handler: string): FlowLane {
    if (id === handler) return 'controller';
    const node = this.index.node(id), parent = node?.canonicalParentId ? this.index.node(node.canonicalParentId) : undefined;
    const handlerNode = this.index.node(handler);
    if (node?.type === 'model' || parent?.type === 'model') return 'data';
    if (parent?.type === 'controller' || (parent && parent.id === handlerNode?.canonicalParentId && parent.type !== 'file')) return 'controller';
    return 'service';
  }

  /** Server side from the handler: callables by lane, their effects, table access and unresolved call sites. */
  serverSide(builder: FlowBuilder, handler: string, handlerNode: RawFlowNode): { responses: RawFlowNode[]; data: boolean } {
    const responses: RawFlowNode[] = [];
    let data = false;
    const placed = new Map<string, RawFlowNode>([[handler, handlerNode]]);
    const linkedTables = new Set<string>();
    /** Models each callable reaches, to draw its tables behind them. */
    const modelsOf = new Map<string, Set<string>>();
    const mapsTo = (model: string, table: string) => this.outgoing(model, new Set(['maps_to'])).find(i => this.index.relations[i]!.to === table);
    const responseNode = (owner: string, effect: EffectFact) => {
      const node = builder.add({ id: `res:${owner}:${effect.line}:${effect.status ?? ''}:${effect.operation}`, lane: 'response', kind: 'response', depth: 0, label: `${effect.status ?? ''} ${effect.operation}`.trim(), detail: effect.detail, effect: { ...effect, owner }, ...(effect.status !== undefined ? { status: effect.status } : {}) });
      if (node && !responses.includes(node)) responses.push(node);
      return node;
    };
    const tableNode = (table: string) => { const node = this.index.node(table)!; return builder.add({ id: `data:${table}`, lane: 'data', kind: 'table', depth: 1, entityId: table, label: node.name, detail: 'table' }); };
    const queue: { id: string; steps: number }[] = [{ id: handler, steps: 0 }];
    while (queue.length) {
      const { id, steps } = queue.shift()!;
      const from = placed.get(id)!;
      // Effects of this callable.
      for (const effect of this.effects(id)) {
        const site = { owner: id, line: effect.line, hint: effect.detail };
        if (effect.category === 'response') {
          if (id === handler && effect.operation === 'validation' && BEFORE_HANDLER.test(effect.detail)) continue;
          const response = responseNode(id, effect);
          builder.link(from, response, 'responds', { site });
          // An Inertia response renders a page component on the client.
          const page = effect.operation === 'inertia' && effect.target && this.index.node(effect.target) ? this.index.node(effect.target)! : undefined;
          if (page) builder.link(response, builder.add({ id: `page:${page.id}`, lane: 'return', kind: 'page', depth: 0, entityId: page.id, label: displayName(page), detail: `page ${effect.page ?? ''}`.trim() }), 'renders', { chain: this.outgoing(id, new Set(['renders'])).filter(i => this.index.relations[i]!.to === page.id) });
        } else if (effect.category === 'database') {
          data = true;
          const table = effect.table && this.index.node(effect.table) ? effect.table : undefined;
          const model = effect.target && this.index.node(effect.target)?.type === 'model' ? effect.target : undefined;
          const kind: FlowEdgeKind = effect.operation === 'write' ? 'writes' : 'reads';
          if (model) {
            const modelNode = builder.add({ id: `data:${model}`, lane: 'data', kind: 'model', depth: 0, entityId: model, label: this.name(model), detail: 'model' });
            builder.link(from, modelNode, kind, { label: effect.operation, site });
            if (modelNode) modelsOf.set(id, new Set([...modelsOf.get(id) ?? [], model]));
            if (table) { const maps = mapsTo(model, table); builder.link(modelNode, tableNode(table), 'maps', { label: 'table', ...(maps !== undefined ? { chain: [maps] } : {}) }); linkedTables.add(`${id}>${table}`); }
          } else if (table) {
            builder.link(from, tableNode(table), kind, { label: effect.operation, site });
            linkedTables.add(`${id}>${table}`);
          } else builder.link(from, builder.add({ id: `fx:${id}:${effect.line}:database`, lane: 'data', kind: 'effect', depth: 0, label: `database · ${effect.operation}`, detail: effect.detail, effect: { ...effect, owner: id } }), 'effect', { site });
        } else if (!(effect.category === 'network' && effect.wrapper)) {
          data = true;
          builder.link(from, builder.add({ id: `fx:${id}:${effect.line}:${effect.category}:${effect.operation}`, lane: 'data', kind: 'effect', depth: 0, label: `${effect.category} · ${effect.operation}`, detail: effect.targetName ?? effect.detail, effect: { ...effect, owner: id } }), 'effect', { site });
        }
      }
      // Table access the effects did not already draw.
      for (const relationIndex of this.outgoing(id, new Set(['reads', 'writes']))) {
        const relation = this.index.relations[relationIndex]!;
        data = true;
        if (linkedTables.has(`${id}>${relation.to}`)) continue;
        linkedTables.add(`${id}>${relation.to}`);
        // A table behind a model this callable uses is drawn behind that model.
        const model = [...modelsOf.get(id) ?? []].find(item => mapsTo(item, relation.to) !== undefined);
        if (model) { builder.link(builder.nodes.get(`data:${model}`), tableNode(relation.to), 'maps', { label: 'table', chain: [mapsTo(model, relation.to)!] }); continue; }
        const line = this.firstLine(relationIndex);
        builder.link(from, tableNode(relation.to), relation.type === 'writes' ? 'writes' : 'reads', { label: relation.type === 'writes' ? 'write' : 'read', chain: [relationIndex], ...(line ? { site: { owner: id, line } } : {}) });
      }
      // What this callable calls that the index could not resolve.
      const sites = this.entity(id)?.metadata.callSites as { unresolved?: number; unresolvedNames?: Record<string, number> } | undefined;
      if (sites?.unresolved) {
        const names = Object.keys(sites.unresolvedNames ?? {}).sort().slice(0, 4);
        const lane: FlowLane = from.lane === 'controller' ? 'service' : from.lane;
        const gap = builder.add({ id: `gap:calls:${id}`, lane, kind: 'gap', depth: Math.min(this.limits.laneDepth - 1, from.lane === lane ? from.depth + 1 : 0), label: names.length ? `? ${names.map(name => `${name}()`).join(', ')}` : `? ${sites.unresolved} call${sites.unresolved === 1 ? '' : 's'}`, detail: `${sites.unresolved} unresolved call site${sites.unresolved === 1 ? '' : 's'}`, gap: { reason: 'unresolved-calls', names, count: sites.unresolved, text: `${sites.unresolved} call site${sites.unresolved === 1 ? '' : 's'} in ${this.name(id)} could not be resolved (dynamic receivers, untyped properties, callbacks); what ${sites.unresolved === 1 ? 'it reaches' : 'they reach'} is not drawn.` } });
        builder.link(from, gap, 'gap');
      }
      if (steps >= this.limits.serverDepth) { if (this.outgoing(id, SERVER_FOLLOW).length) builder.notices.push(`Calls deeper than ${this.limits.serverDepth} hops from the handler are not drawn (from ${this.name(id)}).`); continue; }
      if (id !== handler && this.callerCount(id) > this.limits.hub) { builder.notices.push(`${this.name(id)} is a widely used helper (more than ${this.limits.hub} callers); what it calls is not followed.`); continue; }
      for (const relationIndex of this.byName(this.outgoing(id, SERVER_FOLLOW), 'to').slice(0, this.limits.fanout)) {
        const target = this.index.relations[relationIndex]!.to;
        const node = this.index.node(target);
        if (!node || !CALLABLE.has(node.type)) continue;
        const line = this.firstLine(relationIndex);
        const site = line ? { owner: id, line, hint: node.name } : undefined;
        const existing = placed.get(target);
        if (existing) { builder.link(from, existing, 'calls', { chain: [relationIndex], ...(site ? { site } : {}) }); continue; }
        // Lanes only move forward along a call; deeper calls in a lane take the next sub-column.
        let lane = this.laneOf(target, handler);
        if (LANE_ORDER.get(lane)! < LANE_ORDER.get(from.lane)!) lane = from.lane;
        const depth = Math.min(this.limits.laneDepth - 1, lane === from.lane ? from.depth + 1 : 0);
        const added = builder.add({ id: `srv:${target}`, lane, kind: lane === 'data' ? 'model' : 'method', depth, entityId: target, label: displayName(node), ...(node.type === 'function' ? { detail: 'function' } : {}) });
        if (!added) continue;
        placed.set(target, added);
        builder.link(from, added, 'calls', { chain: [relationIndex], ...(site ? { site } : {}) });
        queue.push({ id: target, steps: steps + 1 });
      }
    }
    return { responses, data };
  }
}

function finish(builder: FlowBuilder, base: Pick<RawFlow, 'id' | 'kind' | 'anchor' | 'name' | 'method' | 'path' | 'handler' | 'caller'>, stages: FlowStages, callers: number): RawFlow {
  const nodes = [...builder.nodes.values()];
  const gaps = nodes.filter(node => node.kind === 'gap').length;
  const status: FlowStatus = base.kind === 'unmatched' ? 'unmatched' : !stages.call ? 'headless' : stages.client && stages.handler && stages.response && !gaps ? 'complete' : 'partial';
  const responses = [...new Set(nodes.flatMap(node => node.kind === 'response' && node.status !== undefined ? [node.status] : []))].sort((a, b) => a - b);
  if (builder.truncated) builder.notices.push('The flow reached its size limit; some steps are not drawn.');
  return {
    ...base, nodes, edges: builder.edges, stages, status, gaps, callers, responses,
    tables: nodes.filter(node => node.kind === 'table').length,
    members: [...new Set(nodes.flatMap(node => node.entityId ? [node.entityId] : []))],
    truncated: builder.truncated, notices: [...new Set(builder.notices)],
  };
}

/** The request flow of an endpoint: who calls it, what its handler does, and what goes back. */
export function endpointFlow(context: FlowContext, endpointId: string, limits = FLOW_LIMITS): RawFlow | undefined {
  const walker = new FlowWalker(context, limits);
  const index = context.index;
  const endpoint = index.node(endpointId);
  if (!endpoint || endpoint.type !== 'api_endpoint') return undefined;
  const entity = walker.entity(endpointId);
  const method = String(entity?.metadata.method ?? endpoint.name.split(' ')[0] ?? '');
  const path = String(entity?.metadata.routePath ?? endpoint.name.replace(/^[A-Z]+\s+/, ''));
  const builder = new FlowBuilder(limits.nodes);
  const endpointNode = builder.add({ id: `ep:${endpointId}`, lane: 'route', kind: 'endpoint', depth: 0, entityId: endpointId, label: endpoint.name, ...(endpoint.detail ? { detail: endpoint.detail } : {}) })!;

  // Server side: middleware, validation, the handler and what it reaches.
  let entry: RawFlowNode = endpointNode;
  const middleware = Array.isArray(entity?.metadata.middleware) ? (entity!.metadata.middleware as unknown[]).map(String).filter(Boolean) : [];
  if (middleware.length) {
    const node = builder.add({ id: `mw:${endpointId}`, lane: 'gate', kind: 'middleware', depth: 0, label: middleware.join(' · '), detail: `middleware (by name; ${middleware.length === 1 ? 'its class is' : 'their classes are'} not followed)` });
    builder.link(endpointNode, node, 'routes');
    if (node) entry = node;
  }
  const handles = walker.byName(walker.outgoing(endpointId, new Set(['handles'])), 'to');
  let responses: RawFlowNode[] = [], data = false, handlerName: string | undefined;
  for (const relationIndex of handles) {
    const handler = index.relations[relationIndex]!.to;
    const node = index.node(handler);
    if (!node) continue;
    handlerName ??= displayName(node);
    const handlerNode = builder.add({ id: `srv:${handler}`, lane: 'controller', kind: 'handler', depth: 0, entityId: handler, label: displayName(node), ...(node.detail ? { detail: node.detail } : {}) });
    if (!handlerNode) continue;
    let before = entry;
    for (const effect of walker.effects(handler)) {
      if (effect.category !== 'response' || effect.operation !== 'validation' || !BEFORE_HANDLER.test(effect.detail)) continue;
      const validation = builder.add({ id: `val:${handler}:${effect.line}`, lane: 'gate', kind: 'validation', depth: middleware.length ? 1 : 0, label: effect.via.split('\\').at(-1) ?? effect.via, detail: effect.detail, effect: { ...effect, owner: handler } });
      builder.link(before, validation, 'routes');
      const rejected = builder.add({ id: `res:${handler}:${effect.line}:${effect.status ?? ''}:validation`, lane: 'response', kind: 'response', depth: 0, label: `${effect.status ?? 422} invalid`, detail: effect.detail, effect: { ...effect, owner: handler }, status: effect.status ?? 422 });
      builder.link(validation, rejected, 'responds', { label: 'when invalid' });
      if (rejected) responses.push(rejected);
      if (validation) before = validation;
    }
    builder.link(before, handlerNode, 'handles', { chain: [relationIndex] });
    const reached = walker.serverSide(builder, handler, handlerNode);
    responses = [...responses, ...reached.responses.filter(item => !responses.includes(item))];
    data ||= reached.data;
  }
  if (!handles.length) {
    const closure = entity?.metadata.handlerKind === 'closure';
    const gap = builder.add({ id: `gap:no-handler:${endpointId}`, lane: 'controller', kind: 'gap', depth: 0, label: closure ? 'Closure handler' : 'No handler', detail: closure ? 'its body is not indexed as a symbol' : 'not resolved', gap: { reason: 'no-handler', text: closure ? 'The route runs a closure: its body is not indexed as a symbol, so what it does is not drawn.' : 'No handler was resolved for this endpoint (a controller or method the index could not find).' } });
    builder.link(entry, gap, 'gap');
    // A route closure rendering an Inertia page.
    for (const relationIndex of walker.outgoing(endpointId, new Set(['renders']))) {
      const page = index.node(index.relations[relationIndex]!.to);
      if (page) builder.link(gap, builder.add({ id: `page:${page.id}`, lane: 'return', kind: 'page', depth: 0, entityId: page.id, label: displayName(page), detail: 'Inertia page' }), 'renders', { chain: [relationIndex] });
    }
  } else if (!responses.length) {
    const gap = builder.add({ id: `gap:no-response:${endpointId}`, lane: 'response', kind: 'gap', depth: 0, label: 'Response not classified', gap: { reason: 'no-response', text: 'No response was classified: the handler\'s return value, a view or a framework default answers the request.' } });
    builder.link(builder.nodes.get(`srv:${index.relations[handles[0]!]!.to}`), gap, 'gap');
  }

  // Client side: who makes this request, what leads there, and what happens once it is answered.
  const requests = walker.byName(walker.incoming(endpointId, new Set(['requests'])), 'from');
  let client = false, returns = false, returned = 0;
  if (requests.length > limits.callers) builder.notices.push(`${requests.length} places request this endpoint; the first ${limits.callers} are drawn.`);
  for (const relationIndex of requests.slice(0, limits.callers)) {
    const caller = index.relations[relationIndex]!.from;
    const meta = walker.meta(relationIndex);
    const callerNode = builder.add({ id: `call:${caller}`, lane: 'call', kind: 'caller', depth: 0, entityId: caller, label: walker.name(caller), detail: `${String(meta.method ?? method)} ${String(meta.url ?? path)}` });
    if (!callerNode) continue;
    builder.link(callerNode, endpointNode, 'requests', { label: String(meta.method ?? method), chain: [relationIndex] });
    const chain = walker.clientSide(builder, callerNode, caller);
    if (chain) client = true;
    // Back on the client.
    const isRequest = (effect: EffectFact) => effect.category === 'network' && effect.endpoint === endpointId;
    const requestLine = walker.effects(caller).find(isRequest)?.line;
    const receiver = builder.add({ id: `ret:${caller}`, lane: 'return', kind: 'receive', depth: 0, entityId: caller, label: walker.name(caller), detail: 'receives the response' });
    if (!receiver) continue;
    for (const response of responses) if (returned++ < limits.returns) builder.link(response, receiver, 'returns');
    if (!responses.length) builder.link(builder.nodes.get(`gap:no-response:${endpointId}`) ?? builder.nodes.get(`gap:no-handler:${endpointId}`), receiver, 'returns');
    if (walker.continuation(builder, receiver, caller, requestLine, chain, isRequest)) returns = true;
  }
  if (!requests.length) {
    const gap = builder.add({ id: `gap:no-caller:${endpointId}`, lane: 'call', kind: 'gap', depth: 0, label: 'No indexed caller', detail: 'called from outside, or by an unresolved URL', gap: { reason: 'no-caller', text: 'No indexed code requests this endpoint: it is called from outside the indexed code (another app, a form post, a webhook), or through a URL the analyzer could not resolve.' } });
    builder.link(gap, endpointNode, 'gap');
  }
  return finish(builder, { id: endpointId, kind: 'endpoint', anchor: endpointId, name: endpoint.name, method, path, ...(handlerName ? { handler: handlerName } : {}) }, { client, call: requests.length > 0, handler: handles.length > 0, data, response: responses.length > 0, returns }, requests.length);
}

/** Network effects of an entity that no endpoint answers (wrappers excepted: their callers carry the request). */
export function unmatchedRequests(context: FlowContext, id: string): EffectFact[] {
  const value = context.entity(id)?.metadata.effects;
  return Array.isArray(value) ? (value as EffectFact[]).filter(effect => effect.category === 'network' && !effect.endpoint && !effect.wrapper) : [];
}

/** The flow of a request no indexed endpoint answers: how the client gets there, and why it ends. */
export function unmatchedFlow(context: FlowContext, callerId: string, limits = FLOW_LIMITS): RawFlow | undefined {
  const walker = new FlowWalker(context, limits);
  const caller = context.index.node(callerId);
  const effects = unmatchedRequests(context, callerId);
  if (!caller || caller.kind !== 'entity' || !effects.length) return undefined;
  const builder = new FlowBuilder(limits.nodes);
  const first = effects[0]!;
  const callerNode = builder.add({ id: `call:${callerId}`, lane: 'call', kind: 'caller', depth: 0, entityId: callerId, label: displayName(caller), detail: `${first.operation} ${first.detail}` })!;
  const chain = walker.clientSide(builder, callerNode, callerId);
  const findings = context.findings?.(callerId) ?? [];
  for (const effect of effects) {
    const finding = findings.find(item => item.line === effect.line) ?? (effects.length === 1 ? findings[0] : undefined);
    const gap = builder.add({ id: `gap:unmatched:${callerId}:${effect.line}`, lane: 'route', kind: 'gap', depth: 0, label: `${effect.operation} ${effect.detail}`, detail: finding?.code ?? 'no endpoint', effect: { ...effect, owner: callerId }, gap: { reason: 'unmatched', text: finding?.reason ?? 'No indexed endpoint answers this request: an external service, or a URL the analyzer could not resolve.' } });
    builder.link(callerNode, gap, 'requests', { label: effect.operation, site: { owner: callerId, line: effect.line, hint: effect.detail } });
  }
  return finish(builder, { id: callerId, kind: 'unmatched', anchor: callerId, name: `${first.operation} ${first.detail}`, method: first.operation, path: first.detail, caller: displayName(caller) }, { client: !!chain, call: true, handler: false, data: false, response: false, returns: false }, 1);
}

/**
 * A console command: what runs it (scheduled tasks, code running it by name,
 * or nothing: run by hand), the command, its handler and what that reaches.
 */
export function commandFlow(context: FlowContext, commandId: string, limits = FLOW_LIMITS): RawFlow | undefined {
  const walker = new FlowWalker(context, limits);
  const index = context.index;
  const command = index.node(commandId);
  if (!command || command.type !== 'command') return undefined;
  const entity = walker.entity(commandId);
  const builder = new FlowBuilder(limits.nodes);
  const commandNode = builder.add({ id: `cmd:${commandId}`, lane: 'route', kind: 'command', depth: 0, entityId: commandId, label: command.name, ...(entity?.metadata.description ? { detail: String(entity.metadata.description) } : {}) })!;
  // Who runs it.
  const invokers = walker.byName(walker.incoming(commandId, new Set(['invokes'])), 'from');
  let client = false;
  for (const relationIndex of invokers.slice(0, limits.callers)) {
    const from = index.relations[relationIndex]!.from, node = index.node(from)!;
    if (node.type === 'scheduled_task') {
      const task = walker.entity(from);
      const schedule = builder.add({ id: `sch:${from}`, lane: 'client', kind: 'schedule', depth: 0, entityId: from, label: String(task?.metadata.cadence ?? 'scheduled'), detail: `scheduler: ${node.name}` });
      builder.link(schedule, commandNode, 'invokes', { label: 'runs', chain: [relationIndex] });
      client = true;
      continue;
    }
    const callerNode = builder.add({ id: `call:${from}`, lane: 'call', kind: 'caller', depth: 0, entityId: from, label: walker.name(from), detail: `runs ${command.name} by name` });
    builder.link(callerNode, commandNode, 'invokes', { label: 'Artisan', chain: [relationIndex], ...(walker.firstLine(relationIndex) ? { site: { owner: from, line: walker.firstLine(relationIndex)!, hint: command.name } } : {}) });
    if (callerNode && walker.clientSide(builder, callerNode, from)) client = true;
  }
  if (invokers.length > limits.callers) builder.notices.push(`${invokers.length} places run this command; the first ${limits.callers} are drawn.`);
  if (!invokers.length) {
    const manual = builder.add({ id: `manual:${commandId}`, lane: 'client', kind: 'entry', depth: 0, label: `php artisan ${command.name}`, detail: 'run by hand: nothing indexed schedules or runs it' });
    builder.link(manual, commandNode, 'invokes', { label: 'runs' });
  }
  const handled = handlerSide(walker, builder, commandId, commandNode, entity?.metadata.handlerKind === 'closure');
  return finish(builder, { id: commandId, kind: 'command', anchor: commandId, name: command.name, method: 'ARTISAN', path: String(entity?.metadata.signature ?? command.name), ...(handled.name ? { handler: handled.name } : {}) }, { client, call: invokers.length > 0, handler: handled.found, data: handled.data, response: false, returns: false }, invokers.length);
}

/** A scheduled task: its cadence, the command or job it runs, and what that reaches. */
export function scheduleFlow(context: FlowContext, taskId: string, limits = FLOW_LIMITS): RawFlow | undefined {
  const walker = new FlowWalker(context, limits);
  const index = context.index;
  const task = index.node(taskId);
  if (!task || task.type !== 'scheduled_task') return undefined;
  const entity = walker.entity(taskId);
  const builder = new FlowBuilder(limits.nodes);
  const cadence = String(entity?.metadata.cadence ?? 'scheduled');
  const taskNode = builder.add({ id: `sch:${taskId}`, lane: 'client', kind: 'schedule', depth: 0, entityId: taskId, label: cadence, detail: `scheduler: ${task.name}` })!;
  let handled: { found: boolean; data: boolean; name?: string } = { found: false, data: false };
  const invokes = walker.outgoing(taskId, new Set(['invokes']));
  for (const relationIndex of invokes) {
    const target = index.relations[relationIndex]!.to, node = index.node(target)!;
    if (node.type === 'command') {
      const commandNode = builder.add({ id: `cmd:${target}`, lane: 'route', kind: 'command', depth: 0, entityId: target, label: node.name });
      builder.link(taskNode, commandNode, 'invokes', { label: 'runs', chain: [relationIndex] });
      if (commandNode) handled = handlerSide(walker, builder, target, commandNode, walker.entity(target)?.metadata.handlerKind === 'closure');
    } else {
      // A job: the scheduler runs its handler directly.
      const handlerNode = builder.add({ id: `srv:${target}`, lane: 'controller', kind: 'handler', depth: 0, entityId: target, label: displayName(node) });
      builder.link(taskNode, handlerNode, 'invokes', { label: 'runs', chain: [relationIndex] });
      if (handlerNode) handled = { found: true, data: walker.serverSide(builder, target, handlerNode).data, name: displayName(node) };
    }
  }
  if (!invokes.length) {
    const kind = String(entity?.metadata.schedule ?? '');
    const gap = builder.add({ id: `gap:no-handler:${taskId}`, lane: 'route', kind: 'gap', depth: 0, label: kind === 'call' ? 'Closure' : kind === 'exec' ? 'Shell command' : 'Not indexed', detail: String(entity?.metadata.target ?? ''), gap: { reason: 'no-handler', text: kind === 'call' ? 'The task runs a closure: its body is not indexed as a symbol.' : kind === 'exec' ? 'The task runs a shell command outside the indexed code.' : `The task runs ${String(entity?.metadata.target ?? 'something')}, which is not an indexed command or job.` } });
    builder.link(taskNode, gap, 'gap');
  }
  return finish(builder, { id: taskId, kind: 'schedule', anchor: taskId, name: task.name, method: 'SCHEDULE', path: cadence, ...(handled.name ? { handler: handled.name } : {}) }, { client: true, call: true, handler: handled.found, data: handled.data, response: false, returns: false }, 1);
}

/** The handler of a command (`handles`) and what it reaches; a closure command is a gap. */
function handlerSide(walker: FlowWalker, builder: FlowBuilder, commandId: string, commandNode: RawFlowNode, closure: boolean): { found: boolean; data: boolean; name?: string } {
  const index = walker.index;
  const handles = walker.outgoing(commandId, new Set(['handles']));
  let data = false, name: string | undefined;
  for (const relationIndex of handles) {
    const handler = index.relations[relationIndex]!.to, node = index.node(handler);
    if (!node) continue;
    name ??= displayName(node);
    const handlerNode = builder.add({ id: `srv:${handler}`, lane: 'controller', kind: 'handler', depth: 0, entityId: handler, label: displayName(node) });
    builder.link(commandNode, handlerNode, 'handles', { chain: [relationIndex] });
    if (handlerNode) data = walker.serverSide(builder, handler, handlerNode).data || data;
  }
  if (!handles.length) {
    const gap = builder.add({ id: `gap:no-handler:${commandId}`, lane: 'controller', kind: 'gap', depth: 0, label: closure ? 'Closure command' : 'No handler', gap: { reason: 'no-handler', text: closure ? 'The command runs a closure: its body is not indexed as a symbol, so what it does is not drawn.' : 'No handle() method was found for this command.' } });
    builder.link(commandNode, gap, 'gap');
  }
  return { found: handles.length > 0, data, ...(name ? { name } : {}) };
}
