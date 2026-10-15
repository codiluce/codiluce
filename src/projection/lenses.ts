// Lenses that color the map by a measure, in four levels: complexity (code
// health: a file by its most complex function, a function by its own), how
// often files changed in the people window, and hotspots (both). Pure.
//
// Complexity uses the usual cyclomatic bands, the same in every repository:
// up to 10 simple, 11 to 20 moderate, 21 to 50 complex, over 50 very complex.
// Changes are relative to the repository: a file's level is the share of the
// changed files with fewer commits (half, 80% and 95%), so the many files
// changed once or twice stay low. A hotspot is as hot as the lower of its two
// levels: often changed and complex, the code where improving pays first.
import { CODE_LANGUAGES } from '../core/languages.js';
import { definingFile, ENTRY_TYPES } from './authorship.js';
import type { AuthorshipWindow } from './dto.js';
import type { ProjectionIndex, ProjectionNode } from './hierarchy.js';
import { SYMBOL_TYPES } from './hierarchy.js';

export type MetricLens = 'complexity' | 'changes' | 'hotspots';
export const METRIC_LENSES: MetricLens[] = ['complexity', 'changes', 'hotspots'];
export function isMetricLens(value: unknown): value is MetricLens { return typeof value === 'string' && (METRIC_LENSES as string[]).includes(value); }
/** 1 (low) to 4 (highest). */
export type LensLevel = 1 | 2 | 3 | 4;
/** What code health stored on an entity: a function's complexity, a file's most complex function and how many it has. */
export interface MeasuredValues { complexity?: number; maxComplexity?: number; functions?: number }
export interface MetricLensResult {
  lens: MetricLens;
  available: boolean;
  /** Why there is nothing to color (not measured, no Git history…). */
  reason?: string;
  /** Changes and hotspots: the commits counted. */
  window?: AuthorshipWindow;
  /** Files (and, for changes, entry points by their file) with a level; symbols too when theirs is above 1. */
  of: Record<string, LensLevel>;
  /** Symbols without an entry: their file's level (`inherit`), or level 1 when their file has one (`simple`). */
  symbols: 'inherit' | 'simple';
  /** Per area: its code files by level, those without one as `none`. */
  areas: Record<string, Record<string, number>>;
  /** Each level present: how many files, and the range of what decided it (the most complex function's complexity, or commits). */
  levels: { level: LensLevel; files: number; min: number; max: number }[];
  /** Code files without a level: not measured, or not changed in the window. */
  without: number;
  /** The files at the highest levels, most first. */
  top: { id: string; path: string; level: LensLevel; complexity?: number; commits?: number }[];
}
const TOP = 8;

export function complexityLevel(complexity: number): LensLevel { return complexity > 50 ? 4 : complexity > 20 ? 3 : complexity > 10 ? 2 : 1; }
/** Each value's level by the share of values below it: under half 1, then 2, 3 from 80%, 4 from 95%. */
export function rankLevels(values: Map<string, number>): Map<string, LensLevel> {
  const sorted = [...values.values()].sort((a, b) => a - b);
  const below = (value: number) => { let low = 0, high = sorted.length; while (low < high) { const middle = (low + high) >> 1; if (sorted[middle]! < value) low = middle + 1; else high = middle; } return low / sorted.length; };
  const levels = new Map<string, LensLevel>();
  for (const [id, value] of values) { const share = below(value); levels.set(id, share >= 0.95 ? 4 : share >= 0.8 ? 3 : share >= 0.5 ? 2 : 1); }
  return levels;
}

export function metricLens(index: ProjectionIndex, lens: MetricLens, input: { measured?: Map<string, MeasuredValues>; changes?: Map<string, number>; window?: AuthorshipWindow }): MetricLensResult {
  const files = [...index.nodes.values()].filter(node => node.kind === 'entity' && node.type === 'file' && node.change?.status !== 'removed');
  const measured = input.measured ?? new Map<string, MeasuredValues>();
  // A measured file has a function count; one without functions is simple.
  const complexityOf = (id: string): number | undefined => { const values = measured.get(id); return values?.maxComplexity ?? (values?.functions !== undefined ? 0 : undefined); };
  const changeLevels = lens === 'complexity' ? new Map<string, LensLevel>() : rankLevels(new Map(files.flatMap(node => { const commits = input.changes?.get(node.id); return commits ? [[node.id, commits] as [string, number]] : []; })));
  const levelOf = (node: ProjectionNode): LensLevel | undefined => {
    const complexity = complexityOf(node.id);
    if (lens === 'changes') return changeLevels.get(node.id);
    if (complexity === undefined) return undefined;
    if (lens === 'complexity') return complexityLevel(complexity);
    const changed = changeLevels.get(node.id);
    return changed === undefined ? undefined : Math.min(changed, complexityLevel(complexity)) as LensLevel;
  };
  const of: Record<string, LensLevel> = {}, areas: Record<string, Record<string, number>> = {};
  const ranges = new Map<LensLevel, { files: number; min: number; max: number }>();
  const top: MetricLensResult['top'] = [];
  let without = 0;
  for (const node of files) {
    const level = levelOf(node);
    const code = CODE_LANGUAGES.has(node.language ?? '');
    if (level === undefined) { if (!code) continue; without++; }
    else {
      of[node.id] = level;
      const complexity = complexityOf(node.id), commits = input.changes?.get(node.id);
      // What decided the level: hotspots show the complexity, which the bands name.
      const value = lens === 'changes' ? commits! : complexity!;
      const range = ranges.get(level);
      if (range) { range.files++; range.min = Math.min(range.min, value); range.max = Math.max(range.max, value); } else ranges.set(level, { files: 1, min: value, max: value });
      top.push({ id: node.id, path: node.path ?? node.name, level, ...(complexity !== undefined && lens !== 'changes' ? { complexity } : {}), ...(commits !== undefined && lens !== 'complexity' ? { commits } : {}) });
      if (!code) continue;
    }
    for (const ancestor of index.spatialAncestors(node)) { const counts = areas[ancestor.id] ??= {}; const key = level === undefined ? 'none' : String(level); counts[key] = (counts[key] ?? 0) + 1; }
  }
  if (lens === 'changes') {
    // Entry points shown outside files take the level of the file defining them.
    for (const node of index.nodes.values()) {
      if (node.kind !== 'entity' || !ENTRY_TYPES.has(node.type) || node.change?.status === 'removed') continue;
      const file = definingFile(index, node);
      if (file && of[file]) of[node.id] = of[file]!;
    }
  } else {
    // Functions above level 1 by their own complexity (in a hotspot, capped by their file's changes); a class by its most complex.
    const holds = (item: ProjectionNode, node: ProjectionNode) => item.kind === 'entity' && SYMBOL_TYPES.has(item.type) && item.path === node.path && measured.get(item.id)?.complexity === undefined;
    for (const [id, values] of measured) {
      if (values.complexity === undefined) continue;
      const node = index.node(id);
      const file = node?.path ? index.fileByPath.get(node.path) : undefined;
      if (!node || !file || node.change?.status === 'removed' || of[file] === undefined) continue;
      const own = complexityLevel(values.complexity);
      const level = (lens === 'hotspots' ? Math.min(own, changeLevels.get(file) ?? 1) : own) as LensLevel;
      if (level < 2) continue;
      for (const holder of [...index.spatialAncestors(node).filter(item => holds(item, node)), node]) {
        if ((of[holder.id] ?? 1) < level) of[holder.id] = level;
      }
    }
  }
  const byLevel = (a: { level: LensLevel; complexity?: number; commits?: number; path: string }, b: typeof a) => b.level - a.level || (lens === 'changes' ? (b.commits ?? 0) - (a.commits ?? 0) : (b.complexity ?? 0) * (b.commits ?? 1) - (a.complexity ?? 0) * (a.commits ?? 1)) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return {
    lens, available: true, ...(input.window ? { window: input.window } : {}), of, symbols: lens === 'changes' ? 'inherit' : 'simple', areas,
    levels: [...ranges].sort((a, b) => a[0] - b[0]).map(([level, range]) => ({ level, ...range })), without,
    top: top.filter(item => item.level > 1).sort(byLevel).slice(0, TOP),
  };
}
/** A lens with nothing to color, and why. */
export function unavailableLens(lens: MetricLens, reason: string): MetricLensResult {
  return { lens, available: false, reason, of: {}, symbols: lens === 'changes' ? 'inherit' : 'simple', areas: {}, levels: [], without: 0, top: [] };
}
