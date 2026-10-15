// Code health on the indexed graph. Each function's length, cyclomatic
// complexity, deepest nesting and parameters (the rules are in measure.ts) are
// stored on the symbol they measure; each file gets its lines holding code,
// how many functions it has and its worst ones (anonymous callbacks included,
// which are not symbols); the repository gets how the metrics spread per
// language, outside tests, so a function can be compared with its peers.
//
// It depends only on file contents, so a history snapshot measures a commit
// as the working tree would. With a cache, a file is measured again only when
// its content, grammar or query changed. Generated and minified files are not
// measured, and say why.
import { createHash } from 'node:crypto';
import type { Analyzer } from '../../core/analyzer.js';
import type { Entity, Metrics } from '../../core/graph.js';
import { fileKey } from '../../pipeline/cache.js';
import { IndexedSources } from '../indexed-sources.js';
import { generatedReason } from './generated.js';
import { createMeasurer, metricsDialect, metricsFingerprint, type MetricsDialect, type MetricsMeasurer } from './grammars.js';
import { HEALTH_METRICS, type FileHealth, type HealthFunction, type HealthMetric, type RepositoryHealth, type Spread } from './health.js';
import { METRICS_VERSION, type FileMetrics, type FunctionMetrics } from './measure.js';

export const CODE_HEALTH_VERSION = `${METRICS_VERSION}:1`;
/** Tests, test data and fixtures, by path: measured, but not part of the spread they are compared with. */
export const TEST_FILE = /(^|\/)(tests?|__tests__|__mocks__|e2e|cypress|spec|testdata|fixtures)\/|[._-](test|spec)\.[cm]?[jt]sx?$|_test\.(go|py)$|(^|\/)test_[^/]*\.py$|Test\.php$/i;
/** Symbols a measured function can be: those with code of their own. */
const SYMBOL_TYPES = new Set<Entity['type']>(['function', 'method', 'component', 'test']);
/** Worst functions kept per file, by complexity then length. */
const WORST_KEPT = 10;
type Measured = { skipped: string } | FileMetrics;

export const codeHealthAnalyzer: Analyzer = {
  name: 'code-health', version: CODE_HEALTH_VERSION,
  async analyze(context): Promise<void> {
    const { graph } = context;
    const files = [...context.files.values()].filter(file => file.analyzable && !file.embedded && metricsDialect(file.language, file.path)).sort((a, b) => a.path.localeCompare(b.path, 'en'));
    if (!files.length) return;
    const symbols = new Map<string, Entity[]>();
    for (const entity of graph.entities.values()) {
      if (!entity.path || !entity.sourceRange || !SYMBOL_TYPES.has(entity.type)) continue;
      const list = symbols.get(entity.path) ?? []; list.push(entity); symbols.set(entity.path, list);
    }
    // One cache entry: every file's measurement keyed by its content and fingerprint.
    const cacheParts = { analyzer: CODE_HEALTH_VERSION };
    const previous = new Map(context.cache?.kept<[string, Measured][]>('code-health', 'repository', cacheParts) ?? []);
    const kept = new Map<string, Measured>(), fingerprints = new Map<MetricsDialect, string>(), unavailable = new Map<MetricsDialect, string>();
    const spread = new Map<string, Record<HealthMetric, Map<number, number>> & { functions: number }>();
    const sources = new IndexedSources(context);
    let measurer: MetricsMeasurer | undefined, measuredFiles = 0, skippedFiles = 0;
    try {
      for (const file of files) {
        const dialect = metricsDialect(file.language, file.path)!;
        if (unavailable.has(dialect)) continue;
        if (!fingerprints.has(dialect)) fingerprints.set(dialect, metricsFingerprint(dialect));
        const key = createHash('sha256').update(`${fingerprints.get(dialect)}\0${fileKey(context, file.path).join('\0')}`).digest('hex').slice(0, 32);
        let measured = previous.get(key);
        if (!measured) {
          let content: string;
          try { content = sources.readText(file.path); }
          catch (error) {
            graph.diagnose({ analyzer: 'code-health', severity: 'info', code: 'code-health-unmeasured', file: file.path, entityId: file.id, reason: `Not measured: ${error instanceof Error ? error.message : String(error)}` });
            continue;
          } finally { sources.releaseText(file.path); }
          const skipped = generatedReason(file.path, content);
          if (skipped) measured = { skipped };
          else try { measured = (measurer ??= await createMeasurer()).measure(dialect, content); }
          catch (error) {
            // A grammar that cannot load fails its dialect once, not every file.
            const reason = error instanceof Error ? error.message : String(error);
            unavailable.set(dialect, reason);
            graph.diagnose({ analyzer: 'code-health', severity: 'warning', code: 'code-health-unavailable', reason: `No code health metrics for ${dialect} files: ${reason}` });
            continue;
          }
        }
        kept.set(key, measured);
        const fileEntity = graph.entities.get(file.id);
        if (!fileEntity) continue;
        if ('skipped' in measured) { skippedFiles++; fileEntity.metadata.health = { skipped: measured.skipped } satisfies FileHealth; continue; }
        measuredFiles++;
        const matched = matchSymbols(symbols.get(file.path) ?? [], measured.functions);
        const listed: HealthFunction[] = measured.functions.map(item => ({ name: item.name, startLine: item.startLine, endLine: item.endLine, codeLines: item.length, complexity: item.complexity, nesting: item.nesting, parameters: item.parameters }));
        measured.functions.forEach((item, index) => {
          for (const entity of matched.get(item) ?? []) {
            entity.metrics = { ...entity.metrics, codeLines: item.length, complexity: item.complexity, nesting: item.nesting, parameters: item.parameters } satisfies Metrics;
            listed[index]!.symbol ??= entity.id;
          }
        });
        const worst = [...listed].sort((a, b) => b.complexity - a.complexity || b.codeLines - a.codeLines || a.startLine - b.startLine).slice(0, WORST_KEPT);
        fileEntity.metrics = { ...fileEntity.metrics, codeLines: measured.lines, functions: listed.length, ...listed.length ? { maxComplexity: worst[0]!.complexity, maxNesting: Math.max(...listed.map(item => item.nesting)) } : {} } satisfies Metrics;
        fileEntity.metadata.health = { worst } satisfies FileHealth;
        if (TEST_FILE.test(file.path) || !listed.length) continue;
        const language = file.language!;
        let counts = spread.get(language);
        if (!counts) { counts = { functions: 0, codeLines: new Map(), complexity: new Map(), nesting: new Map(), parameters: new Map() }; spread.set(language, counts); }
        for (const item of listed) {
          counts.functions++;
          for (const metric of HEALTH_METRICS) counts[metric].set(item[metric], (counts[metric].get(item[metric]) ?? 0) + 1);
        }
      }
    } finally { measurer?.close(); }
    context.cache?.keep('code-health', 'repository', cacheParts, [...kept]);
    const repository = graph.entities.get(context.repositoryId);
    if (repository) repository.metadata.codeHealth = {
      version: CODE_HEALTH_VERSION, files: measuredFiles, skipped: skippedFiles,
      languages: Object.fromEntries([...spread].sort(([a], [b]) => a.localeCompare(b, 'en')).map(([language, counts]) => [language, {
        functions: counts.functions,
        ...Object.fromEntries(HEALTH_METRICS.map(metric => [metric, [...counts[metric]].sort((a, b) => a[0] - b[0])])) as Record<HealthMetric, Spread>,
      }])),
    } satisfies RepositoryHealth;
  },
};

/**
 * Which measured function each symbol is. Analyzers and the metrics query can
 * start a declaration at different lines (a decorator, `export`, a variable
 * holding an arrow function), but both end it at its last line: a symbol is
 * the function ending where it ends and starting within it, preferably with
 * its name, else the outermost. Failing that, the outermost function with its
 * name inside it (`const save = useCallback(() => …,\n [deps])` ends after
 * the function). Symbols with no match (closures folded into the function
 * around them, signatures without a body) get no metrics of their own.
 */
export function matchSymbols(entities: Entity[], functions: FunctionMetrics[]): Map<FunctionMetrics, Entity[]> {
  const byEnd = new Map<number, FunctionMetrics[]>();
  for (const item of functions) { const list = byEnd.get(item.endLine) ?? []; list.push(item); byEnd.set(item.endLine, list); }
  const matched = new Map<FunctionMetrics, Entity[]>();
  for (const entity of entities) {
    const range = entity.sourceRange!;
    const named = (item: FunctionMetrics) => item.name.split('.').at(-1) === entity.name;
    const ending = (byEnd.get(range.endLine) ?? []).filter(item => item.startLine >= range.startLine);
    const candidates = ending.some(named) ? ending.filter(named) : ending.length ? ending : functions.filter(item => named(item) && item.startLine >= range.startLine && item.endLine <= range.endLine);
    if (!candidates.length) continue;
    const best = candidates.reduce((outer, item) => item.startLine < outer.startLine ? item : outer);
    const list = matched.get(best) ?? []; list.push(entity); matched.set(best, list);
  }
  return matched;
}

