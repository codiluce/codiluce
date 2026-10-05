// Flows on the map. Every flow (a request's lanes, a page's Steps) becomes
// the same picture: *stops* (the entities it passes), *edges* between them
// (indexed relationships), *pins* for what is not an entity (middleware,
// validation, responses, effects, gaps) attached to the block they belong to,
// and *members*: every entity the flow touches, folded ones included.
//
// A flow is played by *branches*, not as one list: each choice it offers (an
// event a page binds, an action it runs on load, a caller of an endpoint)
// is a branch, played from where the flow starts along real edges only, in
// *waves*: the stops one edge further are reached together, so siblings show
// as alternatives at the same moment, and the way back (a response returning
// to its caller) comes last. Pure.
import type { FoldedEntity, FlowLane, NodeSummary, RequestFlow, StepsResult } from '@engine/projection/dto';
import type { PlaybackState } from './playback';

export type StopTone = 'client' | 'call' | 'route' | 'server' | 'data' | 'response' | 'return' | 'console';
export interface MapStop {
  key: string; entityId: string; ancestors: string[]; label: string; detail?: string;
  /** The flow node's kind (page, trigger, caller, endpoint, handler, method, model, table…). */
  kind: string; tone: StopTone; node?: NodeSummary;
}
export type PinKind = 'middleware' | 'validation' | 'response' | 'effect' | 'gap' | 'continuation' | 'entry';
export interface MapPin {
  key: string; ownerId: string; ownerAncestors: string[]; label: string; detail?: string; kind: PinKind; tone: 'ok' | 'warn' | 'error' | 'info';
  /** The stop whose arrival shows the pin (its owner, or the step that leads to it). */
  after: string;
}
export interface MapEdge {
  key: string; from: string; fromAncestors: string[]; to: string; toAncestors: string[]; type: string;
  /** The event that fires it (onClick…), when it binds a handler. */
  event?: string;
  /** Entities folded into it, in order. */
  via?: { name: string; type: string }[];
  /** The way back (a response to its caller): played after the way there. */
  back?: boolean;
}
/** An entity the flow touches, with its spatial ancestors (root first). */
export interface MapMember { id: string; ancestors: string[] }
export interface MapBranch {
  key: string;
  /** Index of the stop the branch is about (the choice it plays). */
  head: number;
  label: string; event?: string;
  /** Where the choice is made (the component binding it, or its file): the list groups by it. */
  group: string;
  /** Stop indices by wave: wave 0 is where it starts; one edge further is the next wave. */
  waves: number[][];
  /** Edges (indices into `edges`) with the wave each one flows in. */
  links: { edge: number; wave: number }[];
}
export interface MapFlow { key: string; title: string; subtitle?: string; stops: MapStop[]; edges: MapEdge[]; pins: MapPin[]; members: MapMember[]; branches: MapBranch[] }

const LANE_ORDER: FlowLane[] = ['client', 'call', 'route', 'gate', 'controller', 'service', 'data', 'response', 'return'];
const LANE_TONE: Record<FlowLane, StopTone> = { client: 'client', call: 'call', route: 'route', gate: 'route', controller: 'server', service: 'server', data: 'data', response: 'response', return: 'return' };
const PIN_ICON: Record<PinKind, string> = { middleware: '◈', validation: '✓', response: '↩', effect: '✦', gap: '?', continuation: '➜', entry: '▸' };
export function statusTone(status: number | undefined): MapPin['tone'] { return status === undefined ? 'info' : status >= 500 ? 'error' : status >= 400 ? 'warn' : status >= 300 ? 'info' : 'ok'; }

/** A request's lanes on the map: entities by lane (the order a request passes them), the rest as pins. */
export function fromRequestFlow(flow: RequestFlow): MapFlow {
  const byId = new Map(flow.nodes.map(node => [node.id, node]));
  const stops: MapStop[] = [];
  const seen = new Set<string>();
  const ordered = flow.nodes.map((node, index) => ({ node, index })).sort((a, b) => LANE_ORDER.indexOf(a.node.lane) - LANE_ORDER.indexOf(b.node.lane) || a.node.depth - b.node.depth || a.index - b.index);
  for (const { node } of ordered) {
    if (!node.node || seen.has(node.node.id)) continue;
    seen.add(node.node.id);
    const tone: StopTone = node.kind === 'command' || node.kind === 'schedule' ? 'console' : LANE_TONE[node.lane];
    stops.push({ key: node.id, entityId: node.node.id, ancestors: node.ancestors, label: node.label, ...(node.detail ? { detail: node.detail } : {}), kind: node.kind, tone, node: node.node });
  }
  // Where a node is drawn: its entity, or the owner of its effect.
  const anchor = (id: string): { id: string; ancestors: string[] } | undefined => {
    const node = byId.get(id);
    if (node?.node) return { id: node.node.id, ancestors: node.ancestors };
    if (node?.effect) return { id: node.effect.owner, ancestors: node.ancestors.slice(0, -1) };
    return undefined;
  };
  const pins: MapPin[] = [];
  for (const node of flow.nodes) {
    if (node.node) continue;
    let owner = anchor(node.id);
    // Middleware, gaps and manual entries have no owner of their own: pin them to the entity they link to.
    if (!owner) for (const edge of flow.edges) { const other = edge.from === node.id ? edge.to : edge.to === node.id ? edge.from : undefined; const found = other ? anchor(other) : undefined; if (found) { owner = found; break; } }
    if (!owner) continue;
    const kind: PinKind = node.kind === 'middleware' ? 'middleware' : node.kind === 'validation' ? 'validation' : node.kind === 'response' ? 'response' : node.kind === 'gap' ? 'gap' : node.kind === 'continuation' ? 'continuation' : node.kind === 'entry' ? 'entry' : 'effect';
    const tone: MapPin['tone'] = kind === 'response' || kind === 'validation' ? statusTone(node.status ?? (kind === 'validation' ? 422 : undefined)) : kind === 'gap' ? 'warn' : 'info';
    pins.push({ key: node.id, ownerId: owner.id, ownerAncestors: owner.ancestors, label: `${PIN_ICON[kind]} ${node.label}`, ...(node.gap?.text ?? node.detail ? { detail: node.gap?.text ?? node.detail } : {}), kind, tone, after: owner.id });
  }
  // Nodes that are not entities and have no owner (middleware) pass the flow on: an edge into
  // one continues to where its own edges lead, so the endpoint links to its handler.
  const outgoing = new Map<string, RequestFlow['edges']>();
  for (const edge of flow.edges) outgoing.set(edge.from, [...outgoing.get(edge.from) ?? [], edge]);
  const onward = (id: string, seen = new Set<string>()): { id: string; ancestors: string[] }[] => {
    const found = anchor(id);
    if (found) return [found];
    if (seen.has(id) || byId.get(id)?.kind === 'gap') return [];
    seen.add(id);
    return (outgoing.get(id) ?? []).filter(edge => edge.kind !== 'returns' && edge.kind !== 'then').flatMap(edge => onward(edge.to, seen));
  };
  const edges: MapEdge[] = [];
  const edgeKeys = new Set<string>();
  for (const edge of flow.edges) {
    const from = anchor(edge.from);
    if (!from) continue;
    for (const to of onward(edge.to)) {
      if (from.id === to.id || edgeKeys.has(`${from.id}>${to.id}`)) continue;
      edgeKeys.add(`${from.id}>${to.id}`);
      const back = edge.kind === 'returns' || edge.kind === 'then';
      edges.push({ key: `${edge.id}>${to.id}`, from: from.id, fromAncestors: from.ancestors, to: to.id, toAncestors: to.ancestors, type: edge.hops.at(-1)?.type ?? (back ? 'requests' : edge.kind === 'invokes' ? 'invokes' : 'calls'), ...(edge.kind === 'triggers' && edge.label ? { event: edge.label } : {}), ...(edge.via.length ? { via: edge.via.map(item => ({ name: item.name, type: item.type })) } : {}), ...(back ? { back } : {}) });
    }
  }
  const members = membersOf([
    ...flow.nodes.flatMap(node => node.node ? [{ id: node.node.id, ancestors: node.ancestors }] : node.effect ? [{ id: node.effect.owner, ancestors: node.ancestors.slice(0, -1) }] : []),
    ...flow.edges.flatMap(edge => edge.via),
  ]);
  const map = { key: `lanes:${flow.id}`, title: flow.kind === 'command' || flow.kind === 'schedule' ? flow.name : `${flow.method} ${flow.path}`, subtitle: flow.handler ? `${flow.kind === 'unmatched' ? 'from' : 'handled by'} ${flow.handler}` : flow.caller ? `from ${flow.caller}` : undefined, stops, edges, pins, members };
  return { ...map, branches: branchesOf(map) };
}

/** A page's (or any entity's) Steps on the map: steps in layer order, effects as pins on their owners. */
export function fromSteps(result: StepsResult): MapFlow {
  const stops: MapStop[] = [];
  const toneOf = (kind: string, node: NodeSummary): StopTone => kind === 'endpoint' ? 'route' : kind === 'handler' ? 'server' : node.type === 'database_table' ? 'data' : node.type === 'command' || node.type === 'scheduled_task' ? 'console' : node.language === 'php' ? 'server' : 'client';
  const ordered = [...result.steps].sort((a, b) => a.layer - b.layer);
  for (const step of ordered) if (step.node) stops.push({ key: step.id, entityId: step.node.id, ancestors: step.ancestors, label: step.node.name, detail: step.kind, kind: step.kind, tone: toneOf(step.kind, step.node), node: step.node });
  const byId = new Map(result.steps.map(step => [step.id, step]));
  // An effect shows when the step leading to it is reached.
  const leadsTo = new Map<string, string>();
  for (const link of result.links) { const from = byId.get(link.from); if (from?.node && !leadsTo.has(link.to)) leadsTo.set(link.to, from.node.id); }
  const pins: MapPin[] = result.steps.flatMap(step => {
    if (!step.effect) return [];
    const effect = step.effect;
    const kind: PinKind = effect.category === 'response' ? 'response' : 'effect';
    return [{ key: step.id, ownerId: effect.owner, ownerAncestors: step.ancestors.slice(0, -1), label: `${PIN_ICON[kind]} ${effect.status !== undefined ? `${effect.status} ` : ''}${effect.category === 'response' ? effect.operation : `${effect.category} · ${effect.operation}`}`, detail: effect.detail, kind, tone: kind === 'response' ? statusTone(effect.status) : 'info', after: leadsTo.get(step.id) ?? effect.owner }];
  });
  const edges: MapEdge[] = [];
  for (const link of result.links) {
    const from = byId.get(link.from), to = byId.get(link.to);
    if (!from?.node || !to?.node || from.node.id === to.node.id) continue;
    edges.push({ key: link.id, from: from.node.id, fromAncestors: from.ancestors, to: to.node.id, toAncestors: to.ancestors, type: link.hops.at(-1)?.type ?? 'calls', ...(link.event ? { event: link.event } : {}), ...(link.via.length ? { via: link.via.map(item => ({ name: item.name, type: item.type })) } : {}), ...(link.back ? { back: true } : {}) });
  }
  const members = membersOf([
    ...result.steps.flatMap(step => step.node ? [{ id: step.node.id, ancestors: step.ancestors }] : step.effect ? [{ id: step.effect.owner, ancestors: step.ancestors.slice(0, -1) }] : []),
    ...result.links.flatMap(link => link.via),
  ]);
  const map = { key: `steps:${result.anchor.id}`, title: result.anchor.name, subtitle: 'what happens from here', stops, edges, pins, members };
  return { ...map, branches: branchesOf(map) };
}
function membersOf(items: (MapMember | FoldedEntity)[]): MapMember[] {
  const byId = new Map<string, MapMember>();
  for (const item of items) if (!byId.has(item.id)) byId.set(item.id, { id: item.id, ancestors: item.ancestors });
  return [...byId.values()];
}

// Branches ---------------------------------------------------------------------
/**
 * The choices a flow offers, each played from where the flow starts. With one
 * starting stop (a page, an endpoint's only caller), every stop it leads to
 * directly is a branch; with several (an endpoint called from many places),
 * each start is a branch. Waves follow forward edges breadth-first; edges
 * marked as the way back flow in a last wave of their own.
 */
export function branchesOf(flow: Pick<MapFlow, 'stops' | 'edges'>): MapBranch[] {
  const indexOf = new Map(flow.stops.map((stop, index) => [stop.entityId, index]));
  const forward = new Map<number, { to: number; edge: number }[]>();
  const incoming = new Set<number>();
  flow.edges.forEach((edge, i) => {
    const from = indexOf.get(edge.from), to = indexOf.get(edge.to);
    if (from === undefined || to === undefined || from === to || edge.back) return;
    forward.set(from, [...forward.get(from) ?? [], { to, edge: i }]);
    incoming.add(to);
  });
  const roots = flow.stops.map((_, index) => index).filter(index => !incoming.has(index));
  if (!flow.stops.length) return [];
  const starts: { head: number; root?: { stop: number; edge: number } }[] = [];
  if (roots.length > 1) for (const root of roots) starts.push({ head: root });
  else {
    const root = roots[0] ?? 0;
    const children = forward.get(root) ?? [];
    const seen = new Set<number>();
    for (const child of children) if (!seen.has(child.to)) { seen.add(child.to); starts.push({ head: child.to, root: { stop: root, edge: child.edge } }); }
    if (!starts.length) starts.push({ head: root });
  }
  return starts.map(start => {
    const depth = new Map<number, number>();
    const waves: number[][] = [];
    const links: { edge: number; wave: number }[] = [];
    const place = (stop: number, wave: number) => { depth.set(stop, wave); (waves[wave] ??= []).push(stop); };
    if (start.root) { place(start.root.stop, 0); place(start.head, 1); links.push({ edge: start.root.edge, wave: 0 }); }
    else place(start.head, 0);
    const queue = [start.head];
    while (queue.length) {
      const stop = queue.shift()!;
      const wave = depth.get(stop)!;
      for (const next of forward.get(stop) ?? []) {
        if (!depth.has(next.to)) { place(next.to, wave + 1); queue.push(next.to); }
        links.push({ edge: next.edge, wave });
      }
    }
    // The way back, after the way there.
    const last = waves.length;
    flow.edges.forEach((edge, i) => {
      const from = indexOf.get(edge.from), to = indexOf.get(edge.to);
      if (edge.back && from !== undefined && to !== undefined && from !== to && depth.has(from) && depth.has(to)) links.push({ edge: i, wave: last });
    });
    const head = flow.stops[start.head]!;
    const lead = start.root ? flow.edges[start.root.edge] : undefined;
    const component = [...lead?.via ?? []].reverse().find(item => item.type === 'component')?.name;
    const file = head.node?.path?.split('/').at(-1);
    return {
      key: `${start.root ? `${flow.stops[start.root.stop]!.key}>` : ''}${head.key}`, head: start.head, label: head.label,
      ...(lead?.event ? { event: lead.event } : {}),
      // A choice is grouped by the component binding it; a start (a caller of an endpoint) by its file, pages together.
      group: start.root ? component ?? (flow.stops[start.root.stop]!.node?.path === head.node?.path ? flow.stops[start.root.stop]!.label : file ?? head.label) : head.kind === 'page' ? 'pages' : file ?? head.label,
      waves, links,
    };
  });
}
/** How long a branch plays: one wave per edge step, and a last one to stay on the result. */
export const WAVE_MS = 1100;
export function branchWaves(branch: MapBranch): number { return Math.max(0, ...branch.links.map(link => link.wave + 1)); }
export function branchDuration(branch: MapBranch | undefined): number { return WAVE_MS * ((branch ? branchWaves(branch) : 0) + 1); }
/**
 * Where the flow is in a branch, in waves: `position` (0 → the start, n → every
 * edge has flowed) and `front`, the wave whose stops were reached last. Before
 * playing and after the end, the whole branch shows.
 */
export function branchPosition(branch: MapBranch, playback: Pick<PlaybackState, 'status' | 'progress'>): { position: number; front: number } {
  const waves = branchWaves(branch);
  const position = playback.status === 'playing' || playback.status === 'paused' ? Math.min(waves, playback.progress * (waves + 1)) : waves;
  return { position, front: Math.min(branch.waves.length - 1, Math.floor(position)) };
}
/** Branches grouped where their choice is made, in first-seen order. */
export function groupBranches(branches: MapBranch[]): { label: string; items: { branch: MapBranch; index: number }[] }[] {
  const groups = new Map<string, { label: string; items: { branch: MapBranch; index: number }[] }>();
  branches.forEach((branch, index) => { const group = groups.get(branch.group) ?? { label: branch.group, items: [] }; group.items.push({ branch, index }); groups.set(branch.group, group); });
  return [...groups.values()];
}

/** Every area holding a stop of the branch (or a pin shown with it): opened on the map while it plays. */
export function flowAreas(flow: MapFlow, branch?: MapBranch): Set<string> {
  const areas = new Set<string>();
  const stops = branch ? branch.waves.flat().map(index => flow.stops[index]!) : flow.stops;
  const reached = new Set(stops.map(stop => stop.entityId));
  for (const stop of stops) for (const id of stop.ancestors) areas.add(id);
  for (const pin of flow.pins) if (reached.has(pin.after)) for (const id of pin.ownerAncestors) areas.add(id);
  return areas;
}
/** What stays lit while a flow is shown: every entity it touches and the areas holding them. */
export function flowLit(flow: MapFlow): Set<string> {
  const lit = new Set<string>();
  for (const member of flow.members) { lit.add(member.id); for (const id of member.ancestors) lit.add(id); }
  for (const stop of flow.stops) { lit.add(stop.entityId); for (const id of stop.ancestors) lit.add(id); }
  return lit;
}
