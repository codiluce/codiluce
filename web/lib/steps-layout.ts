// Layered layout for the Steps diagram. Pure: the same steps give the same
// picture. Layers come from the server (steps reached in one hop from the
// anchor are layer 1); within a layer, boxes are ordered by the mean position
// of the boxes leading to them (three sweeps from the server's order), which
// keeps lines short without a physics simulation. Links that point back to an
// earlier or the same layer are drawn around the boxes, not through them.
export interface StepNode { id: string; layer: number }
export interface StepEdge { id: string; from: string; to: string; back: boolean }
export interface PlacedBox { id: string; x: number; y: number; w: number; h: number; layer: number }
export interface PlacedEdge { id: string; from: string; to: string; back: boolean; path: string; label: { x: number; y: number } }
export interface StepsLayout { boxes: PlacedBox[]; edges: PlacedEdge[]; width: number; height: number }
export const STEP_BOX = { w: 212, h: 60, gapX: 20, gapY: 64, margin: 24 };

export function layoutSteps(nodes: StepNode[], edges: StepEdge[], box = STEP_BOX): StepsLayout {
  const layers = new Map<number, string[]>();
  for (const node of nodes) layers.set(node.layer, [...layers.get(node.layer) ?? [], node.id]);
  const order = [...layers.keys()].sort((a, b) => a - b);
  const layerOf = new Map(nodes.map(node => [node.id, node.layer]));
  const position = new Map<string, number>();
  const assign = () => { for (const layer of order) layers.get(layer)!.forEach((id, index) => position.set(id, index)); };
  assign();
  const parents = new Map<string, string[]>();
  for (const edge of edges) if (!edge.back && (layerOf.get(edge.from) ?? 0) < (layerOf.get(edge.to) ?? 0)) parents.set(edge.to, [...parents.get(edge.to) ?? [], edge.from]);
  for (let sweep = 0; sweep < 3; sweep++) {
    for (const layer of order.slice(1)) {
      const ids = layers.get(layer)!;
      const score = (id: string) => { const from = parents.get(id) ?? []; return from.length ? from.reduce((sum, parent) => sum + (position.get(parent) ?? 0), 0) / from.length : position.get(id)!; };
      const scored = ids.map((id, index) => ({ id, score: score(id), index }));
      scored.sort((a, b) => a.score - b.score || a.index - b.index);
      layers.set(layer, scored.map(item => item.id));
      assign();
    }
  }
  const widest = Math.max(1, ...order.map(layer => layers.get(layer)!.length));
  const width = box.margin * 2 + widest * box.w + (widest - 1) * box.gapX;
  const boxes: PlacedBox[] = [];
  order.forEach((layer, row) => {
    const ids = layers.get(layer)!;
    const rowWidth = ids.length * box.w + (ids.length - 1) * box.gapX;
    const start = (width - rowWidth) / 2;
    ids.forEach((id, index) => boxes.push({ id, layer, x: Math.round(start + index * (box.w + box.gapX)), y: box.margin + row * (box.h + box.gapY), w: box.w, h: box.h }));
  });
  const placed = new Map(boxes.map(item => [item.id, item]));
  const height = box.margin * 2 + order.length * box.h + Math.max(0, order.length - 1) * box.gapY;
  const placedEdges: PlacedEdge[] = [];
  for (const edge of edges) {
    const a = placed.get(edge.from), b = placed.get(edge.to);
    if (!a || !b) continue;
    if (b.y > a.y) {
      const x1 = a.x + a.w / 2, y1 = a.y + a.h, x2 = b.x + b.w / 2, y2 = b.y, dy = (y2 - y1) / 2;
      // The label sits just above the box it leads to, so labels of sibling links never collide.
      placedEdges.push({ ...edge, path: `M${x1},${y1} C${x1},${y1 + dy} ${x2},${y2 - dy} ${x2},${y2}`, label: { x: x2, y: y2 - 12 } });
    } else {
      // Back or sideways: leave the right side of the source, return into the right side of the target.
      const x1 = a.x + a.w, y1 = a.y + a.h / 2, x2 = b.x + b.w, y2 = b.y + b.h / 2, out = Math.max(x1, x2) + 28;
      placedEdges.push({ ...edge, path: `M${x1},${y1} C${out},${y1} ${out},${y2} ${x2},${y2}`, label: { x: out - 6, y: (y1 + y2) / 2 } });
    }
  }
  return { boxes, edges: placedEdges, width: Math.max(width, ...placedEdges.map(edge => edge.label.x + 40)), height };
}
