// Request flows in the visualizer: filtering and grouping the list, laying a
// flow out in lanes (one band per layer a request passes, left to right), and
// the spine a flow is traced along on the map. Pure: the same flow gives the
// same picture.
import type { FlowLane, FlowStatus, RequestFlow, RequestFlowEdge, RequestFlowSummary } from '@engine/projection/dto';

export const LANE_TEXT: Record<FlowLane, string> = { client: 'Client', call: 'HTTP call', route: 'Route', gate: 'Middleware', controller: 'Controller', service: 'Services', data: 'Models & data', response: 'Response', return: 'Back on the client' };
export const STATUS_TEXT: Record<FlowStatus, string> = { complete: 'Complete', partial: 'Partial', headless: 'No caller', unmatched: 'Unmatched' };
export const STATUS_HINT: Record<FlowStatus, string> = {
  complete: 'From a page or event to a response, with nothing unresolved along the way',
  partial: 'Some links are known; the gaps say what the index could not see',
  headless: 'Endpoints that no indexed code requests (forms, webhooks, other apps, unresolved URLs)',
  unmatched: 'Requests made by indexed code that no indexed endpoint answers',
};
/** Stages shown as pips, in request order. */
export const STAGES = [['client', 'Client'], ['call', 'Call'], ['handler', 'Handler'], ['data', 'Data'], ['response', 'Response'], ['returns', 'Back']] as const;

export function matchesQuery(item: RequestFlowSummary, query: string): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const text = [item.name, item.handler ?? '', item.caller ?? '', item.app ?? ''].join('\u0000').toLowerCase();
  return words.every(word => text.includes(word));
}
export interface RequestFlowGroup { key: string; app?: string; group: string; items: RequestFlowSummary[] }
/** Groups by application and first path segment, keeping the server's order. */
export function groupRequestFlows(items: RequestFlowSummary[], query = '', status?: FlowStatus): RequestFlowGroup[] {
  const groups = new Map<string, RequestFlowGroup>();
  for (const item of items) {
    if ((status && item.status !== status) || !matchesQuery(item, query)) continue;
    const key = `${item.app ?? ''}\u0000${item.group}`;
    let group = groups.get(key);
    if (!group) { group = { key, ...(item.app ? { app: item.app } : {}), group: item.group, items: [] }; groups.set(key, group); }
    group.items.push(item);
  }
  return [...groups.values()];
}
/** `2xx` → ok, `3xx` → redirect, `4xx` → client, `5xx` → server. */
export function statusClass(status: number | undefined): 'ok' | 'redirect' | 'client' | 'server' | 'unknown' {
  if (status === undefined) return 'unknown';
  return status >= 500 ? 'server' : status >= 400 ? 'client' : status >= 300 ? 'redirect' : 'ok';
}

// Layout ---------------------------------------------------------------------
export const FLOW_BOX = { w: 162, h: 58, gapY: 14, laneGap: 46, subGap: 20, margin: 18, header: 52 };
export interface FlowLayoutNode { id: string; lane: string; depth: number }
export interface FlowLayoutEdge { id: string; from: string; to: string }
export interface PlacedFlowNode { id: string; lane: string; column: number; x: number; y: number; w: number; h: number }
export interface PlacedFlowEdge {
  id: string; from: string; to: string; path: string;
  /** Column the edge leaves from, and how many columns it crosses (for the animation's timing). */
  column: number; span: number;
  /** The edge goes to the same or an earlier column. */
  back: boolean;
  label: { x: number; y: number };
  /** Horizontal room between the two boxes, for a label. */
  room: number;
}
export interface LaneBand { lane: string; x: number; w: number; first: number; last: number }
export interface RequestFlowLayout { nodes: PlacedFlowNode[]; edges: PlacedFlowEdge[]; lanes: LaneBand[]; columns: number; width: number; height: number }

/**
 * Lanes become bands of columns (a lane's deeper sub-columns to the right),
 * in the given order. Inside a column, nodes settle near the mean height of
 * their neighbours (alternating sweeps from the left and from the right),
 * then are pushed apart so they never overlap.
 */
export function layoutRequestFlow(lanes: string[], nodes: FlowLayoutNode[], edges: FlowLayoutEdge[], box = FLOW_BOX): RequestFlowLayout {
  const columnOf = new Map<string, number>();
  const columnX: number[] = [];
  const bands: LaneBand[] = [];
  let x = box.margin, column = 0;
  for (const lane of lanes) {
    const depths = [...new Set(nodes.filter(node => node.lane === lane).map(node => node.depth))].sort((a, b) => a - b);
    if (!depths.length) continue;
    const first = column, start = x;
    depths.forEach((depth, index) => { if (index) x += box.subGap; columnOf.set(`${lane}:${depth}`, column); columnX[column] = x; x += box.w; column++; });
    bands.push({ lane, x: start, w: x - start, first, last: column - 1 });
    x += box.laneGap;
  }
  const width = Math.max(box.margin * 2, x - box.laneGap + box.margin);
  const col = new Map<string, number>();
  for (const node of nodes) { const value = columnOf.get(`${node.lane}:${node.depth}`); if (value !== undefined) col.set(node.id, value); }
  const columns: string[][] = Array.from({ length: column }, () => []);
  for (const node of nodes) if (col.has(node.id)) columns[col.get(node.id)!]!.push(node.id);
  const parents = new Map<string, string[]>(), children = new Map<string, string[]>();
  for (const edge of edges) {
    if (!col.has(edge.from) || !col.has(edge.to) || edge.from === edge.to || col.get(edge.from)! >= col.get(edge.to)!) continue;
    parents.set(edge.to, [...parents.get(edge.to) ?? [], edge.from]);
    children.set(edge.from, [...children.get(edge.from) ?? [], edge.to]);
  }
  const pitch = box.h + box.gapY;
  const y = new Map<string, number>();
  columns.forEach(ids => ids.forEach((id, index) => y.set(id, index * pitch)));
  const settle = (ids: string[], neighbours: Map<string, string[]>) => {
    if (!ids.length) return;
    const desired = new Map(ids.map(id => { const list = neighbours.get(id) ?? []; return [id, list.length ? list.reduce((sum, other) => sum + y.get(other)!, 0) / list.length : y.get(id)!]; }));
    const order = ids.map((id, index) => ({ id, index })).sort((a, b) => desired.get(a.id)! - desired.get(b.id)! || a.index - b.index).map(item => item.id);
    const placed: number[] = [];
    let cursor = -Infinity;
    for (const id of order) { const value = Math.max(desired.get(id)!, cursor); placed.push(value); cursor = value + pitch; }
    const shift = order.reduce((sum, id, index) => sum + desired.get(id)! - placed[index]!, 0) / order.length;
    order.forEach((id, index) => y.set(id, placed[index]! + shift));
    ids.splice(0, ids.length, ...order);
  };
  for (let pass = 0; pass < 6; pass++) {
    if (pass % 2 === 0) for (const ids of columns) settle(ids, parents);
    else for (const ids of [...columns].reverse()) settle(ids, children);
  }
  const top = Math.min(0, ...y.values());
  const placed = new Map<string, PlacedFlowNode>();
  for (const node of nodes) {
    if (!col.has(node.id)) continue;
    const c = col.get(node.id)!;
    placed.set(node.id, { id: node.id, lane: node.lane, column: c, x: columnX[c]!, y: Math.round(y.get(node.id)! - top + box.header + box.margin), w: box.w, h: box.h });
  }
  const bottom = Math.max(box.header + box.margin + box.h, ...[...placed.values()].map(item => item.y + item.h));
  const placedEdges: PlacedFlowEdge[] = [];
  for (const edge of edges) {
    const a = placed.get(edge.from), b = placed.get(edge.to);
    if (!a || !b) continue;
    if (b.column > a.column) {
      const x1 = a.x + a.w, y1 = a.y + a.h / 2, x2 = b.x, y2 = b.y + b.h / 2, dx = Math.max(26, (x2 - x1) / 2);
      placedEdges.push({ ...edge, path: `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`, column: a.column, span: b.column - a.column, back: false, label: { x: (x1 + x2) / 2, y: (y1 + y2) / 2 }, room: x2 - x1 });
    } else {
      // Same or earlier column: loop out to the right of the source and back in from the right.
      const x1 = a.x + a.w, y1 = a.y + a.h / 2, x2 = b.x + b.w, y2 = b.y + b.h / 2, out = Math.max(x1, x2) + 34;
      placedEdges.push({ ...edge, path: `M${x1},${y1} C${out},${y1} ${out},${y2} ${x2},${y2}`, column: a.column, span: 1, back: true, label: { x: out - 4, y: (y1 + y2) / 2 }, room: 0 });
    }
  }
  return { nodes: [...placed.values()], edges: placedEdges, lanes: bands, columns: column, width: Math.round(width), height: Math.round(bottom + box.margin) };
}

/**
 * Scale that shows the whole flow when it stays readable; otherwise fit the
 * width (scrolling down), and never below `min` (scrolling both ways).
 */
export function fitScale(layout: Pick<RequestFlowLayout, 'width' | 'height'>, view: { w: number; h: number }, min = 0.55, max = 1.15): number {
  if (!view.w || !view.h) return 1;
  const across = view.w / layout.width, whole = Math.min(across, view.h / layout.height);
  return Math.max(min, Math.min(max, whole >= 0.72 ? whole : Math.min(across, 0.9)));
}

// Spine ----------------------------------------------------------------------
const SPINE_SKIP = new Set(['gap', 'returns', 'then', 'responds']);
/**
 * The longest forward chain through the flow (a page to the deepest model or
 * table), as flow node IDs: what the map traces, step by step.
 */
export function flowSpine(flow: Pick<RequestFlow, 'nodes' | 'edges' | 'lanes'>): string[] {
  const order = new Map(flow.lanes.map((lane, index) => [lane, index]));
  const byId = new Map(flow.nodes.map(node => [node.id, node]));
  const rank = (id: string) => { const node = byId.get(id)!; return (order.get(node.lane) ?? 0) * 10 + node.depth; };
  const next = new Map<string, string[]>();
  const incoming = new Set<string>();
  for (const edge of flow.edges) {
    if (SPINE_SKIP.has(edge.kind) || !byId.has(edge.from) || !byId.has(edge.to) || rank(edge.to) <= rank(edge.from)) continue;
    next.set(edge.from, [...next.get(edge.from) ?? [], edge.to]);
    incoming.add(edge.to);
  }
  const memo = new Map<string, number>();
  const length = (id: string): number => {
    if (memo.has(id)) return memo.get(id)!;
    memo.set(id, 0);
    const value = 1 + Math.max(0, ...(next.get(id) ?? []).map(length));
    memo.set(id, value);
    return value;
  };
  const starts = flow.nodes.filter(node => !incoming.has(node.id) && node.kind !== 'gap' && next.has(node.id));
  if (!starts.length) return flow.nodes.slice(0, 1).map(node => node.id);
  let current = starts.reduce((best, node) => length(node.id) > length(best.id) ? node : best).id;
  const spine = [current];
  while (next.get(current)?.length) {
    current = next.get(current)!.reduce((best, id) => length(id) > length(best) ? id : best);
    spine.push(current);
  }
  return spine;
}
/** The entities along the spine, with the entities folded into its links: consecutive ones are joined by indexed relationships where the flow has them. */
export function spineEntities(flow: Pick<RequestFlow, 'nodes' | 'edges' | 'lanes'>, spine = flowSpine(flow)): string[] {
  const byId = new Map(flow.nodes.map(node => [node.id, node]));
  const edges = new Map<string, RequestFlowEdge>(flow.edges.map(edge => [`${edge.from}>${edge.to}`, edge]));
  const ids: string[] = [];
  const push = (id: string | undefined) => { if (id && ids.at(-1) !== id) ids.push(id); };
  spine.forEach((id, index) => {
    const edge = index ? edges.get(`${spine[index - 1]}>${id}`) : undefined;
    if (edge?.hops.length) for (const hop of edge.hops) { push(hop.from); push(hop.to); }
    push(byId.get(id)?.node?.id);
  });
  return ids;
}
