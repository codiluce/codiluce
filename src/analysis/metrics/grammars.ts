// Grammars and queries for code health metrics, in process.
//
// Python and Go use the verified grammars of the structural catalog
// (grammars/manifest.json). TypeScript, TSX, JavaScript and PHP have their own
// analyzers, so their grammars are listed apart in grammars/metrics.json:
// measuring them never changes the structural catalog's version, its fact
// caches or history identities.
import { readFileSync } from 'node:fs';
import { Language, Parser, Query } from 'web-tree-sitter';
import { GRAMMAR_ROOT, grammarCatalog, hashText, verifiedGrammar, type GrammarSpec } from '../tree-sitter/grammars.js';
import { measure, METRICS_VERSION, type FileMetrics } from './measure.js';

export type MetricsDialect = 'typescript' | 'tsx' | 'javascript' | 'php' | 'python' | 'go';
const DIALECTS: MetricsDialect[] = ['typescript', 'tsx', 'javascript', 'php', 'python', 'go'];
/** Query file per dialect: TSX uses the TypeScript query (its grammar is a superset). */
const QUERY: Record<MetricsDialect, string> = { typescript: 'typescript', tsx: 'typescript', javascript: 'javascript', php: 'php', python: 'python', go: 'go' };

let metricsManifestError: string | undefined;
let metricsGrammars: GrammarSpec[] = [];
try {
  const parsed = JSON.parse(readFileSync(new URL('metrics.json', GRAMMAR_ROOT), 'utf8')) as { format: number; grammars: GrammarSpec[] };
  if (parsed.format !== 1 || !Array.isArray(parsed.grammars) || !parsed.grammars.every(grammar => grammar && typeof grammar.language === 'string' && typeof grammar.file === 'string' && typeof grammar.sha256 === 'string' && Number.isInteger(grammar.abi))) throw new Error('Unsupported metrics grammar manifest format');
  metricsGrammars = parsed.grammars;
} catch (error) { metricsManifestError = `Metrics grammars unavailable: ${error instanceof Error ? error.message : String(error)}`; }
const metricsCatalog = new Map(metricsGrammars.map(grammar => [grammar.language, grammar]));

/** The dialect measuring a file of a Codiluce language, if any. */
export function metricsDialect(language: string | undefined, file: string): MetricsDialect | undefined {
  if (language === 'typescript') return /\.tsx$/i.test(file) ? 'tsx' : 'typescript';
  if (language === 'javascript' || language === 'php' || language === 'python' || language === 'go') return language;
  return undefined;
}

export function metricsQueryText(dialect: MetricsDialect): string {
  return readFileSync(new URL(`queries/${QUERY[dialect]}/metrics.scm`, GRAMMAR_ROOT), 'utf8');
}
function grammarSpec(dialect: MetricsDialect): GrammarSpec {
  const spec = metricsCatalog.get(dialect) ?? grammarCatalog.get(dialect);
  if (!spec) throw new Error(metricsManifestError ?? `No grammar for ${dialect} metrics`);
  return spec;
}
/**
 * What a dialect's measurements depend on besides the source: the engine's
 * rules, the grammar and the query. A file measured under the same
 * fingerprint measures the same.
 */
export function metricsFingerprint(dialect: MetricsDialect): string {
  try { return hashText(`${METRICS_VERSION}\0${grammarSpec(dialect).sha256}\0${metricsQueryText(dialect)}`).slice(0, 16); }
  catch { return `${METRICS_VERSION}:${dialect}:unavailable`; }
}

export interface MetricsMeasurer { measure(dialect: MetricsDialect, content: string): FileMetrics; close(): void }

/** A measurer with every dialect loaded. Close it to free the WASM parsers and queries. */
export async function createMeasurer(): Promise<MetricsMeasurer> {
  await Parser.init();
  const loaded = new Map<MetricsDialect, { parser: Parser; query: Query }>(), failures = new Map<MetricsDialect, string>();
  // Language.load is asynchronous, measuring is not: load every grammar up front.
  // A missing or altered grammar fails only its own dialect.
  await Promise.all(DIALECTS.map(async dialect => {
    try {
      const spec = grammarSpec(dialect), language = await Language.load(verifiedGrammar(spec));
      if (language.abiVersion !== spec.abi) throw new Error(`Grammar ABI mismatch: ${dialect}`);
      const query = new Query(language, metricsQueryText(dialect)), parser = new Parser();
      parser.setLanguage(language);
      loaded.set(dialect, { parser, query });
    } catch (error) { failures.set(dialect, error instanceof Error ? error.message : String(error)); }
  }));
  return {
    measure(dialect, content) {
      const entry = loaded.get(dialect);
      if (!entry) throw new Error(failures.get(dialect) ?? `No ${dialect} metrics grammar`);
      entry.parser.reset();
      // Go's final statement needs a terminal newline; lines still map to the original input.
      const tree = entry.parser.parse(dialect === 'go' && !content.endsWith('\n') ? `${content}\n` : content);
      if (!tree) throw new Error(`Parser returned no tree for ${dialect}`);
      try { return measure(tree.rootNode, entry.query); } finally { tree.delete(); }
    },
    close() { for (const { parser, query } of loaded.values()) { query.delete(); parser.delete(); } loaded.clear(); },
  };
}
