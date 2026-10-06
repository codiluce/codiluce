// Coverage in the visualizer: how each category reads. Pure.
import type { CoverageCategory } from '@engine/projection/dto';

export const COVERAGE_TEXT: Record<CoverageCategory, string> = {
  entry: 'Entry point', flow: 'In flows', supporting: 'Supports flows', explained: 'Possibly reached', unreached: 'Not reached',
  test: 'Tests & tooling', config: 'Configuration', outside: 'Outside the apps', unanalyzed: 'Not analyzed', asset: 'Not code',
};
export const COVERAGE_HINT: Record<CoverageCategory, string> = {
  entry: 'Where flows start: pages, route files, commands and the scheduler',
  flow: 'Touched by at least one flow',
  supporting: 'Not in a flow, but imported, extended or declaring a table by code that is',
  explained: 'No flow is proven to reach it, but something might (an unresolved call of the same name, a command run by a computed name)',
  unreached: 'Nothing indexed reaches it: candidate dead code, or code reached in ways the analyzers do not see',
  test: 'Tests, seeders and factories', config: 'Configuration, bootstrapping and framework hooks', outside: 'Outside the configured applications',
  unanalyzed: 'Code in a language whose calls are not analyzed yet (Python, Go…, PHP outside Laravel): no flow can reach it (not measured)',
  asset: 'Styles, data and other non-code files (not measured)',
};
/** Legend order: what flows touch first, then what they do not. */
export const COVERAGE_ORDER: CoverageCategory[] = ['entry', 'flow', 'supporting', 'explained', 'unreached', 'test', 'config', 'outside', 'unanalyzed', 'asset'];
/** Not part of the share of code in flows: no flow can reach these files. */
export const NOT_MEASURED = new Set<string>(['unanalyzed', 'asset']);
