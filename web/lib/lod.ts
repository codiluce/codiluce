// Semantic zoom rules. Visibility is decided per node from its on-screen size,
// so only containers that are large enough are opened (and their children
// fetched); everything else stays a single summarized block.
import type { NodeSummary, Rect } from '@engine/projection/dto';

export interface LodConfig {
  /** Container opens (children drawn and loaded) at this on-screen size in CSS px. */
  openPx: number;
  /** Children fade in between openPx and openPx * (1 + fadeRange). */
  fadeRange: number;
  /** Minimum on-screen size for any label. */
  labelPx: number;
  /** On-screen size where closed nodes show summary/detail lines. */
  summaryPx: number;
  detailPx: number;
  /** On-screen size where the selected symbol/file shows its source. */
  sourcePx: number;
  /** Upper bound on drawn primitives per frame; deeper containers stay closed beyond it. */
  budget: number;
}
export const DEFAULT_LOD: LodConfig = { openPx: 210, fadeRange: 0.45, labelPx: 30, summaryPx: 90, detailPx: 150, sourcePx: 560, budget: 7000 };
/** The map as a small overview in a corner (a tool in the middle): areas open early, names only, no source. */
export const CORNER_LOD: LodConfig = { ...DEFAULT_LOD, openPx: 70, labelPx: 46, summaryPx: 1e9, detailPx: 1e9, sourcePx: 1e9, budget: 2500 };

export function screenSize(rect: Rect, scale: number): number { return Math.sqrt(rect.w * rect.h) * scale; }
export function shouldOpen(node: Pick<NodeSummary, 'childCount' | 'rect'>, scale: number, config: LodConfig = DEFAULT_LOD): boolean {
  return node.childCount > 0 && screenSize(node.rect, scale) >= config.openPx;
}
/** 0..1 opacity for children of an open container (fade in just past the threshold). */
export function openProgress(node: Pick<NodeSummary, 'rect'>, scale: number, config: LodConfig = DEFAULT_LOD): number {
  const size = screenSize(node.rect, scale);
  return Math.min(1, Math.max(0, (size - config.openPx) / (config.openPx * config.fadeRange)));
}
export type LabelTier = 'hidden' | 'name' | 'summary' | 'detail' | 'district';
/** What a node's label shows. Open containers show a compact district label instead of a summary. */
export function labelTier(node: Pick<NodeSummary, 'rect' | 'childCount'>, scale: number, open: boolean, config: LodConfig = DEFAULT_LOD): LabelTier {
  const size = screenSize(node.rect, scale);
  if (open) return 'district';
  if (size < config.labelPx) return 'hidden';
  if (size < config.summaryPx) return 'name';
  if (size < config.detailPx) return 'summary';
  return 'detail';
}
export const LEVELS = ['Applications', 'Directories & modules', 'Files', 'Symbols', 'Source'] as const;
export type Level = (typeof LEVELS)[number];
export function levelOfType(type: string): number {
  if (type === 'repository' || type === 'application') return 0;
  if (type === 'directory' || type === 'group') return 1;
  if (type === 'file') return 2;
  return 3;
}
/**
 * Abstraction level named after what the innermost open container at the
 * viewport center is showing: the level covering most area among its visible children.
 */
export function abstractionLevel(visibleChildren: { type: string; area: number }[], sourceVisible: boolean): Level {
  if (sourceVisible) return 'Source';
  if (!visibleChildren.length) return 'Applications';
  const counts = [0, 0, 0, 0];
  for (const child of visibleChildren) counts[levelOfType(child.type)]! += child.area;
  let best = 0;
  for (let level = 1; level < counts.length; level++) if (counts[level]! > counts[best]!) best = level;
  return LEVELS[best]!;
}
