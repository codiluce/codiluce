// Measure lenses in the visualizer: what each lens and level is called. Pure.
import type { LensLevel, MetricLens, MetricLensResult } from '@engine/projection/dto';

export interface LensText {
  label: string;
  /** What the lens colors, in the Color by menu. */
  hint: string;
  /** What decides a file's level, under the legend's title. */
  basis: string;
  /** Each level's name in the legend. */
  levels: Record<LensLevel, string>;
  /** What an area badge calls the files of a level. */
  words: Record<string, string>;
  /** Files without a level. */
  none: string;
}
export const LENS_TEXT: Record<MetricLens, LensText> = {
  complexity: {
    label: 'Complexity', hint: 'Each file by its most complex function; functions by their own',
    basis: 'Files by their most complex function (cyclomatic complexity: 1 plus each if, loop, case, catch, ternary, && and ||). Zoom in for functions.',
    levels: { 1: 'Simple', 2: 'Moderate', 3: 'Complex', 4: 'Very complex' },
    words: { 2: 'moderate', 3: 'complex', 4: 'very complex' },
    none: 'Not measured',
  },
  changes: {
    label: 'Changes', hint: 'How many commits changed each file, in the people window',
    basis: 'Files by how many commits changed them, compared with the other files changed in the window.',
    levels: { 1: 'Bottom half', 2: 'Top half', 3: 'Top 20%', 4: 'Top 5%' },
    words: { 2: 'changed more', 3: 'often changed', 4: 'most changed' },
    none: 'Not changed in the window',
  },
  hotspots: {
    label: 'Hotspots', hint: 'Files changed often and complex: where better code pays back first',
    basis: 'A file is as hot as the lower of its two levels: how often it changed (top 5%, 20%, half) and how complex it is.',
    levels: { 1: 'Calm', 2: 'Warm', 3: 'Hot', 4: 'Hottest' },
    words: { 2: 'warm', 3: 'hot', 4: 'hottest' },
    none: 'Not measured, or not changed in the window',
  },
};
/** What decided a level, in the legend: the complexity band, or the range of commits. */
export function levelRange(lens: MetricLens, level: MetricLensResult['levels'][number]): string {
  if (lens === 'changes') return level.min === level.max ? commits(level.min) : `${level.min}–${commits(level.max)}`;
  if (lens === 'hotspots') return ({ 1: 'the rest', 2: 'top half, complexity over 10', 3: 'top 20%, over 20', 4: 'top 5%, over 50' } as const)[level.level];
  return ({ 1: 'up to 10', 2: '11 to 20', 3: '21 to 50', 4: 'over 50' } as const)[level.level];
}
function commits(count: number): string { return `${count} commit${count === 1 ? '' : 's'}`; }
