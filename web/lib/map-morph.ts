// Between the map and a diagram drawn over it: where each block is on screen
// (a box rises from there, and sinks back), and which loaded nodes frame a set
// of entities on the map. A block too small to draw at this level of detail
// stands for its nearest drawn ancestor.
import type { NodeSummary } from '@engine/projection/dto';
import type { MapNavigator } from './store';

export interface ScreenRect { x: number; y: number; w: number; h: number }
/** An entity a diagram box shows: its ID on the map and the areas around it (outermost first). */
export interface MorphItem { key: string; id?: string; ancestors?: string[] }

/** Each item's block on screen, in client pixels; items not on the map are left out (they fade in instead). */
export function originsOnMap(navigator: MapNavigator | undefined, items: MorphItem[]): Map<string, ScreenRect> {
  const origins = new Map<string, ScreenRect>();
  if (!navigator?.screenRect) return origins;
  for (const item of items) {
    if (!item.id) continue;
    const rect = navigator.screenRect(item.id, item.ancestors ?? []);
    // A block smaller than a pixel (or off the canvas) is no place to rise from.
    if (rect && rect.w >= 1 && rect.h >= 1 && Number.isFinite(rect.x) && Number.isFinite(rect.y)) origins.set(item.key, { x: rect.x, y: rect.y, w: rect.w, h: rect.h });
  }
  return origins;
}

/** The loaded nodes that frame these entities on the map: each one, or its nearest loaded ancestor. */
export function framingNodes(nodes: ReadonlyMap<string, NodeSummary>, items: MorphItem[]): NodeSummary[] {
  const result = new Map<string, NodeSummary>();
  for (const item of items) {
    const chain = [...item.id ? [item.id] : [], ...[...item.ancestors ?? []].reverse()];
    for (const id of chain) {
      const node = nodes.get(id);
      if (node && node.type !== 'repository') { result.set(node.id, node); break; }
    }
  }
  return [...result.values()];
}

/** Whether the reader asked for less motion. */
export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}
