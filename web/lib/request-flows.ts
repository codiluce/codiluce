// Request flows in the visualizer: laying a flow out in lanes (one band per
// layer a request passes, left to right). Pure: the same flow gives the same
// picture.
import type { FlowLane, FlowStatus } from '@engine/projection/dto';

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
