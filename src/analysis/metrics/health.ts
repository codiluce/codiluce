// Code health as the graph stores it, shared by the analyzer and the UI.
export const HEALTH_METRICS = ['codeLines', 'complexity', 'nesting', 'parameters'] as const;
export type HealthMetric = typeof HEALTH_METRICS[number];
/** A function as its file lists it; `symbol` is the entity it measures, when it is one. */
export interface HealthFunction { name: string; startLine: number; endLine: number; codeLines: number; complexity: number; nesting: number; parameters: number; symbol?: string }
/** File metadata `health`: why it was not measured, or its worst functions (by complexity, then length). */
export type FileHealth = { skipped: string } | { worst: HealthFunction[] };
/** How one metric spreads: [value, functions with it], by value. */
export type Spread = [number, number][];
/** Repository metadata `codeHealth`: measured and skipped files, and per language how each metric spreads outside tests. */
export interface RepositoryHealth { version: string; files: number; skipped: number; languages: Record<string, { functions: number } & Record<HealthMetric, Spread>> }

/** The share of functions with a lower value: 0.97 means higher than 97% of them. */
export function spreadRank(spread: Spread, value: number): number {
  let below = 0, total = 0;
  for (const [item, count] of spread) { total += count; if (item < value) below += count; }
  return total ? below / total : 0;
}
