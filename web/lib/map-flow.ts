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
import type { FoldedEntity, FlowLane, NodeSummary, RequestFlow, RequestFlowNode, StepsResult } from '@engine/projection/dto';
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
  /** Where the choice is made (the component binding it, or its file; for a request, where it comes from): the list groups by it. */
  group: string;
  /** What the group means, when its name does not say it (default: chosen in the group). */
  groupTitle?: string;
  /** Stop indices by wave: wave 0 is where it starts; one edge further is the next wave. */
  waves: number[][];
  /** Edges (indices into `edges`) with the wave each one flows in. */
  links: { edge: number; wave: number }[];
}
export interface MapFlow { key: string; title: string; subtitle?: string; stops: MapStop[]; edges: MapEdge[]; pins: MapPin[]; members: MapMember[]; branches: MapBranch[] }

const LANE_ORDER: FlowLane[] = ['client', 'call', 'route', 'gate', 'controller', 'service', 'data', 'response', 'return'];
const LANE_TONE: Record<FlowLane, StopTone> = { client: 'client', call: 'call', route: 'route', gate: 'route', controller: 'server', service: 'server', data: 'data', response: 'response', return: 'return' };
const PIN_ICON: Record<PinKind, string> = { middleware: '◈', validation: '✓', response: '↩', effect: '✦', gap: '?', continuation: '➜', entry: '▸' };
/** Lanes of the client side of a request: a stop only these stand for is a page, an entry, a trigger or a caller. */
const CLIENT_LANES = new Set<FlowLane>(['client', 'call', 'return']);
/** Groups of a request's branches: where it comes from. */
interface Origin { label: string; title: string }
const DIRECT: Origin = { label: 'Direct visit', title: 'Opening the page: what the server does, then the page it renders' };
const THIS_PAGE: Origin = { label: 'From this page', title: 'Controls on this page that request it again' };
const SCHEDULER: Origin = { label: 'Scheduler', title: 'Run by the scheduler' };
const NO_TRIGGER: Origin = { label: 'No indexed trigger', title: 'Nothing indexed calls these: what fires them (a callback, a prop, code outside the index) is not known' };
export function statusTone(status: number | undefined): MapPin['tone'] { return status === undefined ? 'info' : status >= 500 ? 'error' : status >= 400 ? 'warn' : status >= 300 ? 'info' : 'ok'; }

/** A request's lanes on the map: entities by lane (the order a request passes them), the rest as pins. */
export function fromRequestFlow(flow: RequestFlow): MapFlow {
  const byId = new Map(flow.nodes.map(node => [node.id, node]));
  // Where a node is drawn: its entity. An Inertia page is drawn where its component lives on the
  // client, apart from the endpoint serving it (for a page requesting itself, this very endpoint).
  const placeOf = (node: RequestFlowNode): { id: string; ancestors: string[]; node: NodeSummary } | undefined =>
    node.page ? { id: node.page.node.id, ancestors: node.page.ancestors, node: node.page.node } : node.node ? { id: node.node.id, ancestors: node.ancestors, node: node.node } : undefined;
  const stops: MapStop[] = [];
  const stopOf = new Map<string, number>();
  const shape: RequestShape = { client: new Set(), rendered: new Set(), origin: new Map(), page: false };
  const lanes: Set<FlowLane>[] = [];
  const ordered = flow.nodes.map((node, index) => ({ node, index })).sort((a, b) => LANE_ORDER.indexOf(a.node.lane) - LANE_ORDER.indexOf(b.node.lane) || a.node.depth - b.node.depth || a.index - b.index);
  for (const { node } of ordered) {
    const place = placeOf(node);
    if (!place) continue;
    let index = stopOf.get(place.id);
    if (index === undefined) {
      index = stops.length;
      stopOf.set(place.id, index);
      lanes.push(new Set());
      const tone: StopTone = node.kind === 'command' || node.kind === 'schedule' ? 'console' : LANE_TONE[node.lane];
      const detail = node.page ? `page ${node.label}` : node.detail;
      stops.push({ key: node.id, entityId: place.id, ancestors: place.ancestors, label: node.page ? place.node.name : node.label, ...(detail ? { detail } : {}), kind: node.kind, tone, node: place.node });
    }
    lanes[index]!.add(node.lane);
    if (node.lane === 'return' && node.kind === 'page') shape.rendered.add(index);
    const origin = node.lane !== 'client' ? undefined
      : node.kind === 'page' ? node.node?.id === flow.anchor.id ? THIS_PAGE : { label: `From ${node.label.replace(/^GET\s+/, '')}`, title: `Made on the page ${node.label.replace(/^GET\s+/, '')}` }
      : node.kind === 'entry' ? { label: `From ${node.label}`, title: `Made from ${node.label}, which no indexed page reaches` }
      : node.kind === 'schedule' ? SCHEDULER : undefined;
    if (origin && !shape.origin.has(index)) shape.origin.set(index, origin);
  }
  // The client side of the request: stops only pages, entries, triggers and callers stand for.
  lanes.forEach((set, index) => { if ([...set].every(lane => CLIENT_LANES.has(lane)) && (set.has('client') || set.has('call'))) shape.client.add(index); });
  shape.anchor = stopOf.get(flow.anchor.id);
  shape.page = flow.kind === 'endpoint' && flow.method === 'GET' && shape.rendered.size > 0;
  // Where a node is drawn, or the owner of its effect.
  const anchor = (id: string): { id: string; ancestors: string[] } | undefined => {
    const node = byId.get(id);
    const place = node ? placeOf(node) : undefined;
    if (place) return { id: place.id, ancestors: place.ancestors };
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
  // Nodes that are not entities and have no owner (middleware, a route's closure) pass the flow on: an
  // edge into one continues to where its own edges lead, so the endpoint links to its handler.
  const outgoing = new Map<string, RequestFlow['edges']>();
  for (const edge of flow.edges) outgoing.set(edge.from, [...outgoing.get(edge.from) ?? [], edge]);
  const onward = (id: string, seen = new Set<string>()): { id: string; ancestors: string[] }[] => {
    const found = anchor(id);
    if (found) return [found];
    const node = byId.get(id);
    if (seen.has(id) || node?.kind === 'gap' && node.gap?.reason !== 'no-handler') return [];
    seen.add(id);
    return (outgoing.get(id) ?? []).filter(edge => edge.kind !== 'returns' && edge.kind !== 'then').flatMap(edge => onward(edge.to, seen));
  };
  const edges: MapEdge[] = [];
  const edgeKeys = new Set<string>();
  for (const edge of flow.edges) {
    const from = anchor(edge.from);
    if (!from) continue;
    // From a page drawn at its component: what is folded up to the component is behind the stop.
    const page = byId.get(edge.from)?.page?.node;
    const via = page ? edge.via.slice(edge.via.findIndex(item => item.id === page.id) + 1) : edge.via;
    const event = edge.kind === 'triggers' && edge.label ? page && edge.label.endsWith(` · ${page.name}`) ? edge.label.slice(0, -` · ${page.name}`.length) : edge.label : undefined;
    for (const to of onward(edge.to)) {
      if (from.id === to.id || edgeKeys.has(`${from.id}>${to.id}`)) continue;
      edgeKeys.add(`${from.id}>${to.id}`);
      const back = edge.kind === 'returns' || edge.kind === 'then';
      edges.push({ key: `${edge.id}>${to.id}`, from: from.id, fromAncestors: from.ancestors, to: to.id, toAncestors: to.ancestors, type: edge.hops.at(-1)?.type ?? (back ? 'requests' : edge.kind === 'invokes' ? 'invokes' : 'calls'), ...(event ? { event } : {}), ...(via.length ? { via: via.map(item => ({ name: item.name, type: item.type })) } : {}), ...(back ? { back } : {}) });
    }
  }
  const members = membersOf([
    ...flow.nodes.flatMap(node => [...node.node ? [{ id: node.node.id, ancestors: node.ancestors }] : node.effect ? [{ id: node.effect.owner, ancestors: node.ancestors.slice(0, -1) }] : [], ...node.page ? [{ id: node.page.node.id, ancestors: node.page.ancestors }] : []]),
    ...flow.edges.flatMap(edge => edge.via),
  ]);
  const map = { key: `lanes:${flow.id}`, title: flow.kind === 'command' || flow.kind === 'schedule' ? flow.name : `${flow.method} ${flow.path}`, subtitle: flow.handler ? `${flow.kind === 'unmatched' ? 'from' : 'handled by'} ${flow.handler}` : flow.caller ? `from ${flow.caller}` : undefined, stops, edges, pins, members };
  return { ...map, branches: requestBranches(map, shape) };
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
/** What the branches of a request know of its stops. */
interface RequestShape {
  /** The stop of the endpoint or command the flow is about. */
  anchor?: number;
  /** Stops on the client side: pages, entries, triggers, callers and schedules. */
  client: Set<number>;
  /** Pages a response renders. */
  rendered: Set<number>;
  /** Where a request made from a page or entry stop comes from. */
  origin: Map<number, Origin>;
  /** The endpoint serves a page: opening it directly is a branch of its own, played first. */
  page: boolean;
}
/**
 * The branches of a request: opening the page directly (for a page; or the
 * request alone when nothing indexed makes it), then one per place it is made
 * from — a caller and the choice leading to it (a control on a page, work on
 * load) — grouped by where that is: this page, another page, the scheduler.
 * A branch plays its own choice on the client and nothing else the page
 * offers, then the request through the server; the page a response renders
 * comes once the server is done, the way back to the caller last.
 */
function requestBranches(flow: Pick<MapFlow, 'stops' | 'edges'>, shape: RequestShape): MapBranch[] {
  const indexOf = new Map(flow.stops.map((stop, index) => [stop.entityId, index]));
  type Arc = { from: number; to: number; edge: number; back: boolean };
  const arcs: Arc[] = [];
  flow.edges.forEach((edge, i) => {
    const from = indexOf.get(edge.from), to = indexOf.get(edge.to);
    if (from === undefined || to === undefined || from === to) return;
    // The way back: a response to its caller, or the page it renders on the client.
    arcs.push({ from, to, edge: i, back: !!edge.back || shape.rendered.has(to) && !shape.client.has(from) });
  });
  const forward = new Map<number, Arc[]>(), backward = new Map<number, Arc[]>();
  for (const arc of arcs) if (!arc.back) { forward.set(arc.from, [...forward.get(arc.from) ?? [], arc]); backward.set(arc.to, [...backward.get(arc.to) ?? [], arc]); }
  const server = (stop: number) => !shape.client.has(stop);
  const play = (head: number, root: Arc | undefined, follow: (from: number, to: number) => boolean, back: (to: number) => boolean): Pick<MapBranch, 'waves' | 'links'> => {
    const depth = new Map<number, number>();
    const waves: number[][] = [];
    const links: MapBranch['links'] = [];
    const place = (stop: number, wave: number) => { depth.set(stop, wave); (waves[wave] ??= []).push(stop); };
    if (root) { place(root.from, 0); place(head, 1); links.push({ edge: root.edge, wave: 0 }); }
    else place(head, 0);
    const queue = [head];
    while (queue.length) {
      const stop = queue.shift()!;
      const wave = depth.get(stop)!;
      for (const arc of forward.get(stop) ?? []) {
        if (!follow(stop, arc.to)) continue;
        if (!depth.has(arc.to)) { place(arc.to, wave + 1); queue.push(arc.to); }
        links.push({ edge: arc.edge, wave });
      }
    }
    // The page the response renders, once the server is done; then the way back.
    const rendering = arcs.filter(arc => arc.back && depth.has(arc.from) && !depth.has(arc.to) && shape.rendered.has(arc.to));
    const done = waves.length;
    for (const arc of rendering) { if (!depth.has(arc.to)) place(arc.to, done); links.push({ edge: arc.edge, wave: done - 1 }); }
    const last = waves.length;
    for (const arc of arcs) if (arc.back && !rendering.includes(arc) && depth.has(arc.from) && depth.has(arc.to) && back(arc.to)) links.push({ edge: arc.edge, wave: last });
    return { waves, links };
  };
  const found: { branch: MapBranch; rank: number; order: number[] }[] = [];
  // Where the client hands over to the server: callers, schedules (for a request no endpoint answers, its caller).
  const handoffs = flow.stops.map((_, index) => index).filter(stop => shape.client.has(stop) && (forward.get(stop) ?? []).some(arc => server(arc.to)));
  if (!handoffs.length && shape.anchor !== undefined && shape.client.has(shape.anchor)) handoffs.push(shape.anchor);
  const anchor = shape.anchor;
  if (anchor !== undefined && server(anchor) && (shape.page || !handoffs.length)) {
    const origin = shape.page ? DIRECT : { label: flow.stops[anchor]!.label, title: 'The request on its own' };
    found.push({ branch: { key: flow.stops[anchor]!.key, head: anchor, label: flow.stops[anchor]!.label, group: origin.label, groupTitle: origin.title, ...play(anchor, undefined, (_, to) => server(to), () => false) }, rank: 0, order: [anchor] });
  }
  for (const handoff of handoffs) {
    // What leads to this caller on the client: pages, entries, triggers.
    const leads = new Set([handoff]);
    const queue = [handoff];
    while (queue.length) for (const arc of backward.get(queue.shift()!) ?? []) if (shape.client.has(arc.from) && !leads.has(arc.from)) { leads.add(arc.from); queue.push(arc.from); }
    const roots = [...leads].filter(stop => !(backward.get(stop) ?? []).some(arc => leads.has(arc.from))).sort((a, b) => a - b);
    for (const root of roots.length ? roots : [handoff]) {
      // Each choice the start offers towards this caller is a branch.
      const choices: (Arc | undefined)[] = root === handoff ? [undefined] : (forward.get(root) ?? []).filter(arc => leads.has(arc.to));
      for (const choice of choices) {
        const head = choice?.to ?? handoff;
        const path = new Set([head]);
        const next = [head];
        while (next.length) for (const arc of forward.get(next.shift()!) ?? []) if (leads.has(arc.to) && !path.has(arc.to)) { path.add(arc.to); next.push(arc.to); }
        // On the client, only the way from the choice to the caller; from the caller on, the server.
        const follow = (from: number, to: number) => path.has(from) && from !== handoff ? path.has(to) : server(to);
        const origin = shape.origin.get(root) ?? (flow.stops[root]!.kind === 'schedule' ? SCHEDULER : NO_TRIGGER);
        const event = choice ? flow.edges[choice.edge]!.event : undefined;
        found.push({
          branch: { key: [root, head, handoff].map(stop => flow.stops[stop]!.key).join('>'), head, label: flow.stops[head]!.label, ...(event ? { event } : {}), group: origin.label, groupTitle: origin.title, ...play(head, choice, follow, to => path.has(to) || shape.rendered.has(to)) },
          rank: origin === THIS_PAGE ? 1 : origin === NO_TRIGGER ? 3 : 2, order: [root, head, handoff],
        });
      }
    }
  }
  if (!found.length) return branchesOf(flow);
  const compare = (a: number[], b: number[]) => { for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? -1) !== (b[i] ?? -1)) return (a[i] ?? -1) - (b[i] ?? -1); return 0; };
  return found.sort((a, b) => a.rank - b.rank || compare(a.order, b.order)).map(item => item.branch);
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
export function groupBranches(branches: MapBranch[]): { label: string; title: string; items: { branch: MapBranch; index: number }[] }[] {
  const groups = new Map<string, { label: string; title: string; items: { branch: MapBranch; index: number }[] }>();
  branches.forEach((branch, index) => { const group = groups.get(branch.group) ?? { label: branch.group, title: branch.groupTitle ?? `Chosen in ${branch.group}`, items: [] }; group.items.push({ branch, index }); groups.set(branch.group, group); });
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
