// Layout for code diagrams: boxes in layers along their directed arrows (left
// to right, or top to bottom when that fits the frame better), each folder (or
// any group) a band across the layers, so group frames never overlap. Pure and
// deterministic: the same boxes and arrows give the same picture. Layers come
// from the longest path over the arrows (cycles broken where a depth-first
// walk from the start meets them), unless a box fixes its own (Impact: its
// distance); within a band, boxes are ordered by the mean place of the boxes
// leading to them, which keeps arrows short. Arrows may end on a port of a
// box (a symbol inside its file's box), on the side facing the other end.

export interface DiagramNode {
  id: string;
  /** The band it sits in (a folder); `''` is a band too. */
  group: string;
  w: number; h: number;
  /** A fixed layer (otherwise from the arrows). */
  column?: number;
  /** Ports by ID (what is inside the box): their vertical offset from the box's top. */
  ports?: Record<string, number>;
}
export interface DiagramEdge {
  id: string;
  /** A node ID, or a port ID of a node. */
  from: string; to: string;
  /** Undirected edges never decide layers. */
  directed: boolean;
  /** The label's size, when it has one: labels are kept from overlapping. */
  label?: { w: number; h: number };
}
export type DiagramDirection = 'right' | 'down';
export interface DiagramLayoutOptions {
  /** The node in the first layer. */
  start?: string;
  /** Layers left to right (default), or top to bottom. */
  direction?: DiagramDirection;
  /** Space between layers (where arrow labels go), between boxes of a layer, between bands. */
  gapLayer?: number; gapCross?: number; bandGap?: number; bandHeader?: number; margin?: number;
}
export interface PlacedNode { id: string; x: number; y: number; w: number; h: number; column: number; group: string }
export interface PlacedBand { group: string; x: number; y: number; w: number; h: number }
export interface PlacedDiagramEdge {
  id: string; from: string; to: string; directed: boolean;
  /** SVG path, from the start to the end. */
  path: string;
  /** Where its label goes (the middle of the curve). */
  label: { x: number; y: number };
  /** The end's direction, for the arrowhead (radians). */
  angle: number;
  end: { x: number; y: number };
}
export interface DiagramLayout { direction: DiagramDirection; nodes: PlacedNode[]; bands: PlacedBand[]; edges: PlacedDiagramEdge[]; width: number; height: number }

const DEFAULTS = { right: { gapLayer: 150, gapCross: 22 }, down: { gapLayer: 92, gapCross: 28 }, bandGap: 26, bandHeader: 26, margin: 28 };
const BAND_PAD = 14;
type Point = { x: number; y: number };

export function layoutDiagram(nodes: DiagramNode[], edges: DiagramEdge[], options: DiagramLayoutOptions = {}): DiagramLayout {
  const direction = options.direction ?? 'right', right = direction === 'right';
  const gapLayer = options.gapLayer ?? DEFAULTS[direction].gapLayer, gapCross = options.gapCross ?? DEFAULTS[direction].gapCross;
  const bandGap = options.bandGap ?? DEFAULTS.bandGap, bandHeader = options.bandHeader ?? DEFAULTS.bandHeader, margin = options.margin ?? DEFAULTS.margin;
  const byId = new Map(nodes.map(node => [node.id, node]));
  // A port belongs to its node.
  const owner = new Map<string, string>();
  for (const node of nodes) { owner.set(node.id, node.id); for (const port of Object.keys(node.ports ?? {})) if (!owner.has(port)) owner.set(port, node.id); }
  const ends = edges.flatMap(edge => {
    const from = owner.get(edge.from), to = owner.get(edge.to);
    return from && to ? [{ edge, from, to }] : [];
  });
  const directed = ends.filter(item => item.edge.directed && item.from !== item.to);
  const layer = layersOf(nodes, directed.map(item => ({ from: item.from, to: item.to })), options.start, byId);
  // A box joined only by undirected edges stands in the layer of what it is joined to.
  for (const node of nodes) {
    if (node.column !== undefined || node.id === options.start || directed.some(item => item.from === node.id || item.to === node.id)) continue;
    const other = ends.find(item => !item.edge.directed && item.from !== item.to && (item.from === node.id || item.to === node.id));
    if (other) layer.set(node.id, layer.get(other.from === node.id ? other.to : other.from)!);
  }

  // Bands: one per group, in the order of their first layer, then of first appearance.
  const groups: string[] = [];
  for (const node of nodes) if (!groups.includes(node.group)) groups.push(node.group);
  const firstLayer = (group: string) => Math.min(...nodes.filter(node => node.group === group).map(node => layer.get(node.id)!));
  groups.sort((a, b) => firstLayer(a) - firstLayer(b) || groups.indexOf(a) - groups.indexOf(b));

  // Order within a band and layer: input order, then three sweeps by the mean place of what leads to each.
  const layers = sortedValues(layer);
  const cells = new Map<string, string[]>();
  const cellKey = (group: string, at: number) => `${group}\u0000${at}`;
  for (const node of nodes) { const key = cellKey(node.group, layer.get(node.id)!); cells.set(key, [...cells.get(key) ?? [], node.id]); }
  const predecessors = new Map<string, string[]>();
  for (const { from, to } of ends) {
    if (from === to) continue;
    const [a, b] = layer.get(from)! <= layer.get(to)! ? [from, to] : [to, from];
    if (layer.get(a)! < layer.get(b)!) predecessors.set(b, [...predecessors.get(b) ?? [], a]);
  }
  const rank = new Map<string, number>();
  const assign = () => { let index = 0; for (const group of groups) for (const at of layers) for (const id of cells.get(cellKey(group, at)) ?? []) rank.set(id, index++); };
  assign();
  for (let sweep = 0; sweep < 3; sweep++) {
    for (const [key, ids] of cells) {
      const score = (id: string) => { const from = predecessors.get(id) ?? []; return from.length ? from.reduce((sum, item) => sum + rank.get(item)!, 0) / from.length : rank.get(id)!; };
      cells.set(key, ids.map((id, index) => ({ id, score: score(id), index })).sort((a, b) => a.score - b.score || a.index - b.index).map(item => item.id));
    }
    assign();
  }

  // Along the layers: each as deep as its deepest box. Across: each band as wide as its widest stack.
  const mainOf = (node: DiagramNode) => right ? node.w : node.h, crossOf = (node: DiagramNode) => right ? node.h : node.w;
  const depth = new Map(layers.map(at => [at, Math.max(...nodes.filter(node => layer.get(node.id) === at).map(mainOf))]));
  const mainStart = margin + (right ? 0 : bandHeader);
  const mainAt = new Map<number, number>();
  let main = mainStart;
  for (const at of layers) { mainAt.set(at, main); main += depth.get(at)! + gapLayer; }
  const placed: PlacedNode[] = [];
  const bands: PlacedBand[] = [];
  let cross = margin;
  for (const group of groups) {
    const stacks = layers.map(at => (cells.get(cellKey(group, at)) ?? []).map(id => byId.get(id)!));
    const stackSize = (stack: DiagramNode[]) => stack.reduce((sum, node) => sum + crossOf(node), 0) + Math.max(0, stack.length - 1) * gapCross;
    const inner = Math.max(...stacks.map(stackSize));
    const top = cross + (right ? bandHeader : BAND_PAD);
    stacks.forEach((stack, index) => {
      // Each stack centred in its band, so a lone box lines up with the middle of a bigger neighbour.
      let at = top + (inner - stackSize(stack)) / 2;
      const layerIndex = layers[index]!;
      for (const node of stack) {
        const along = mainAt.get(layerIndex)! + (depth.get(layerIndex)! - mainOf(node)) / 2;
        placed.push({ id: node.id, x: Math.round(right ? along : at), y: Math.round(right ? at : along), w: node.w, h: node.h, column: layerIndex, group });
        at += crossOf(node) + gapCross;
      }
    });
    const members = placed.filter(node => node.group === group);
    if (right) {
      const left = Math.min(...members.map(node => node.x)) - BAND_PAD, end = Math.max(...members.map(node => node.x + node.w)) + BAND_PAD;
      bands.push({ group, x: left, y: cross, w: end - left, h: inner + bandHeader + 12 });
      cross += inner + bandHeader + 12 + bandGap;
    } else {
      const upper = Math.min(...members.map(node => node.y)) - bandHeader, lower = Math.max(...members.map(node => node.y + node.h)) + BAND_PAD;
      bands.push({ group, x: cross, y: upper, w: inner + BAND_PAD * 2, h: lower - upper });
      cross += inner + BAND_PAD * 2 + bandGap;
    }
  }

  const at = new Map(placed.map(node => [node.id, node]));
  const center = (node: PlacedNode): Point => ({ x: node.x + node.w / 2, y: node.y + node.h / 2 });
  /** Where an edge leaves or enters a box: a port on the side facing `toward`, or the box's side along the layers. */
  const fan = new Map<string, number>();
  const nudge = (key: string) => { const count = fan.get(key) ?? 0; fan.set(key, count + 1); return count === 0 ? 0 : (count % 2 ? 1 : -1) * Math.ceil(count / 2) * 7; };
  const side = (id: string, node: PlacedNode, kind: 'out' | 'in' | 'right', toward: PlacedNode): { point: Point; tangent: Point } => {
    const offset = id !== node.id ? byId.get(node.id)!.ports?.[id] : undefined;
    const sideways = right || offset !== undefined || kind === 'right';
    if (sideways) {
      // Leaving toward a later layer (or arriving from one): the right side.
      const later = kind === 'out' ? layer.get(toward.id)! >= layer.get(node.id)! : layer.get(toward.id)! > layer.get(node.id)!;
      const facingRight = kind === 'right' || (right ? later : center(toward).x >= center(node).x);
      const y = offset !== undefined ? node.y + offset : node.y + node.h / 2 + nudge(`${node.id}:${facingRight ? 'r' : 'l'}`);
      // The tangent points out of the box, where the curve's control point goes.
      return { point: { x: facingRight ? node.x + node.w : node.x, y }, tangent: { x: facingRight ? 1 : -1, y: 0 } };
    }
    const below = kind === 'out' ? layer.get(toward.id)! >= layer.get(node.id)! : layer.get(toward.id)! > layer.get(node.id)!;
    const x = node.x + node.w / 2 + nudge(`${node.id}:${below ? 'b' : 't'}`);
    const y = below ? node.y + node.h : node.y;
    return { point: { x, y }, tangent: { x: 0, y: below ? 1 : -1 } };
  };
  const fanOut = new Map<string, number>(), fanIn = new Map<string, number>();
  for (const { from, to } of ends) { fanOut.set(from, (fanOut.get(from) ?? 0) + 1); fanIn.set(to, (fanIn.get(to) ?? 0) + 1); }
  const placedEdges: PlacedDiagramEdge[] = ends.map(({ edge, from, to }) => {
    const a = at.get(from)!, b = at.get(to)!;
    if (from === to || layer.get(from) === layer.get(to)) {
      // Within one box or one layer: a loop out of the right sides.
      const start = side(edge.from, a, 'right', b), end = side(edge.to, b, 'right', a);
      const out = Math.max(start.point.x, end.point.x) + 40;
      const path = `M${start.point.x},${start.point.y} C${out},${start.point.y} ${out},${end.point.y} ${end.point.x},${end.point.y}`;
      return finish(edge, path, { x: out - 6, y: (start.point.y + end.point.y) / 2 }, end.point, Math.PI);
    }
    const start = side(edge.from, a, 'out', b), end = side(edge.to, b, 'in', a);
    const span = Math.hypot(end.point.x - start.point.x, end.point.y - start.point.y);
    const d = Math.max(36, Math.min(160, span / 2.2));
    const c1 = { x: start.point.x + start.tangent.x * d, y: start.point.y + start.tangent.y * d };
    // The end's tangent points the way the arrow arrives; the last control point sits behind it.
    const c2 = { x: end.point.x + end.tangent.x * d, y: end.point.y + end.tangent.y * d };
    const path = `M${start.point.x},${start.point.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${end.point.x},${end.point.y}`;
    // Arrows fanning out of one box are labelled near where they arrive (fanning in: near where they leave), where they are apart.
    const t = fanOut.get(from)! > 1 ? 0.74 : fanIn.get(to)! > 1 ? 0.26 : 0.5;
    const label = bezierAt(start.point, c1, c2, end.point, t);
    // A label stays in the gap between the two layers, clear of both boxes.
    const size = edge.label ?? { w: 0, h: 0 };
    const [near, far] = layer.get(from)! < layer.get(to)! ? [a, b] : [b, a];
    if (right) label.x = clampOrMiddle(label.x, near.x + near.w + size.w / 2 + 4, far.x - size.w / 2 - 4);
    else label.y = clampOrMiddle(label.y, near.y + near.h + size.h / 2 + 2, far.y - size.h / 2 - 2);
    return finish(edge, path, label, end.point, Math.atan2(-end.tangent.y || 0, -end.tangent.x || 0));
  });
  separateLabels(placedEdges, edges, right);
  const xs = [...placed.flatMap(node => [node.x, node.x + node.w]), ...bands.flatMap(band => [band.x, band.x + band.w]), ...placedEdges.flatMap(edge => [edge.label.x - 70, edge.label.x + 70])];
  const ys = [...placed.flatMap(node => [node.y, node.y + node.h]), ...bands.flatMap(band => [band.y, band.y + band.h]), ...placedEdges.flatMap(edge => [edge.label.y - 24, edge.label.y + 24])];
  // Everything shifted so the picture starts at the margin.
  const dx = margin - Math.min(...xs), dy = margin - Math.min(...ys);
  const shift = (point: Point) => ({ x: point.x + dx, y: point.y + dy });
  return {
    direction,
    nodes: placed.map(node => ({ ...node, x: node.x + dx, y: node.y + dy })),
    bands: bands.map(band => ({ ...band, x: band.x + dx, y: band.y + dy })),
    edges: placedEdges.map(edge => ({ ...edge, path: translatePath(edge.path, dx, dy), label: shift(edge.label), end: shift(edge.end) })),
    width: Math.max(...xs) + dx + margin, height: Math.max(...ys) + dy + margin,
  };
}

function finish(edge: DiagramEdge, path: string, label: Point, end: Point, angle: number): PlacedDiagramEdge {
  return { id: edge.id, from: edge.from, to: edge.to, directed: edge.directed, path, label: { x: Math.round(label.x), y: Math.round(label.y) }, end, angle };
}
function clampOrMiddle(value: number, low: number, high: number): number { return low > high ? (low + high) / 2 : Math.min(high, Math.max(low, value)); }
function bezierAt(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const u = 1 - t;
  return { x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x, y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y };
}
/** Labels that overlap are pushed apart across the layers (down the page when layers run right), a few passes. */
function separateLabels(placed: PlacedDiagramEdge[], edges: DiagramEdge[], right: boolean): void {
  const size = new Map(edges.map(edge => [edge.id, edge.label]));
  const items = placed.flatMap(edge => { const box = size.get(edge.id); return box ? [{ edge, w: box.w, h: box.h }] : []; });
  for (let pass = 0; pass < 6; pass++) {
    let moved = false;
    items.sort((a, b) => right ? a.edge.label.y - b.edge.label.y || a.edge.label.x - b.edge.label.x : a.edge.label.x - b.edge.label.x || a.edge.label.y - b.edge.label.y);
    for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
      const a = items[i]!, b = items[j]!;
      const overlapX = (a.w + b.w) / 2 + 4 - Math.abs(a.edge.label.x - b.edge.label.x), overlapY = (a.h + b.h) / 2 + 4 - Math.abs(a.edge.label.y - b.edge.label.y);
      if (overlapX <= 0 || overlapY <= 0) continue;
      moved = true;
      // Split the difference: each moves half the overlap, away from the other.
      if (right) { const push = overlapY / 2, sign = b.edge.label.y >= a.edge.label.y ? 1 : -1; a.edge.label.y -= sign * push; b.edge.label.y += sign * push; }
      else { const push = overlapX / 2, sign = b.edge.label.x >= a.edge.label.x ? 1 : -1; a.edge.label.x -= sign * push; b.edge.label.x += sign * push; }
    }
    if (!moved) break;
  }
  for (const item of items) item.edge.label = { x: Math.round(item.edge.label.x), y: Math.round(item.edge.label.y) };
}
function translatePath(path: string, dx: number, dy: number): string {
  let index = 0;
  return path.replace(/-?\d+(?:\.\d+)?/g, value => String(Math.round((Number(value) + (index++ % 2 ? dy : dx)) * 10) / 10));
}
function sortedValues(map: Map<string, number>): number[] { return [...new Set(map.values())].sort((a, b) => a - b); }

/** Layers by the longest path over directed edges; the start is layer 0, and a cycle is broken where a walk from it meets it. */
function layersOf(nodes: DiagramNode[], edges: { from: string; to: string }[], start: string | undefined, byId: Map<string, DiagramNode>): Map<string, number> {
  const layer = new Map<string, number>();
  if (nodes.every(node => node.column !== undefined)) { for (const node of nodes) layer.set(node.id, node.column!); return normalize(layer); }
  const out = new Map<string, string[]>();
  for (const edge of edges) if (edge.to !== start) out.set(edge.from, [...out.get(edge.from) ?? [], edge.to]);
  // Drop the edges that close a cycle, walking from the start first, then in the given order.
  const state = new Map<string, 1 | 2>();
  const kept: { from: string; to: string }[] = [];
  const walk = (id: string) => {
    state.set(id, 1);
    for (const next of out.get(id) ?? []) {
      if (state.get(next) === 1) continue;
      kept.push({ from: id, to: next });
      if (!state.has(next)) walk(next);
    }
    state.set(id, 2);
  };
  if (start && byId.has(start)) walk(start);
  for (const node of nodes) if (!state.has(node.id)) walk(node.id);
  const incoming = new Map<string, string[]>();
  for (const edge of kept) incoming.set(edge.to, [...incoming.get(edge.to) ?? [], edge.from]);
  const depth = (id: string, seen = new Set<string>()): number => {
    if (layer.has(id)) return layer.get(id)!;
    const node = byId.get(id);
    if (node?.column !== undefined) { layer.set(id, node.column); return node.column; }
    if (seen.has(id)) return 0;
    seen.add(id);
    const value = Math.max(0, ...(incoming.get(id) ?? []).map(from => depth(from, seen) + 1));
    layer.set(id, value);
    return value;
  };
  for (const node of nodes) depth(node.id);
  // A source with nothing before it moves next to what it leads to, so its arrows stay short.
  const outgoing = new Map<string, string[]>();
  for (const edge of kept) outgoing.set(edge.from, [...outgoing.get(edge.from) ?? [], edge.to]);
  for (const node of nodes) {
    if (node.id === start || node.column !== undefined || incoming.get(node.id)?.length) continue;
    const next = outgoing.get(node.id);
    if (next?.length) layer.set(node.id, Math.max(0, Math.min(...next.map(id => layer.get(id)!)) - 1));
  }
  return normalize(layer);
}
function normalize(layer: Map<string, number>): Map<string, number> {
  const order = sortedValues(layer);
  const rank = new Map(order.map((value, index) => [value, index]));
  return new Map([...layer].map(([id, value]) => [id, rank.get(value)!]));
}
