// Grammars and queries for code health metrics, in process.
//
// Python and Go use the verified grammars shipped in grammars/. TypeScript,
// TSX, JavaScript and PHP have their own analyzers elsewhere, so their
// grammars are not in the manifest yet: they load from the pinned
// @vscode/tree-sitter-wasm development bundle until they are added to it.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Language, Parser, Query } from 'web-tree-sitter';
import { GRAMMAR_ROOT, grammarCatalog, verifiedGrammar } from '../tree-sitter/grammars.js';
import { measure, type FileMetrics } from './measure.js';

export type MetricsDialect = 'typescript' | 'tsx' | 'javascript' | 'php' | 'python' | 'go';
/** Query file per dialect: TSX uses the TypeScript query (its grammar is a superset). */
const QUERY: Record<MetricsDialect, string> = { typescript: 'typescript', tsx: 'typescript', javascript: 'javascript', php: 'php', python: 'python', go: 'go' };
const BUNDLED: Partial<Record<MetricsDialect, string>> = { typescript: 'tree-sitter-typescript.wasm', tsx: 'tree-sitter-tsx.wasm', javascript: 'tree-sitter-javascript.wasm', php: 'tree-sitter-php.wasm' };

/** The dialect measuring a file of a Codiluce language, if any. */
export function metricsDialect(language: string | undefined, file: string): MetricsDialect | undefined {
  if (language === 'typescript') return /\.tsx$/i.test(file) ? 'tsx' : 'typescript';
  if (language === 'javascript' || language === 'php' || language === 'python' || language === 'go') return language;
  return undefined;
}

export function metricsQueryText(dialect: MetricsDialect): string {
  return readFileSync(new URL(`queries/${QUERY[dialect]}/metrics.scm`, GRAMMAR_ROOT), 'utf8');
}

function grammarBytes(dialect: MetricsDialect): Uint8Array {
  const spec = grammarCatalog.get(dialect);
  if (spec) return verifiedGrammar(spec);
  const bundle = path.dirname(createRequire(import.meta.url).resolve('@vscode/tree-sitter-wasm/package.json'));
  return readFileSync(path.join(bundle, 'wasm', BUNDLED[dialect]!));
}

export interface MetricsMeasurer { measure(dialect: MetricsDialect, content: string): FileMetrics; close(): void }

/** A measurer loading each dialect once. Close it to free the WASM parsers and queries. */
export async function createMeasurer(): Promise<MetricsMeasurer> {
  await Parser.init();
  const loaded = new Map<MetricsDialect, { parser: Parser; query: Query }>();
  const languages = await Promise.all((Object.keys(QUERY) as MetricsDialect[]).map(async dialect => [dialect, await Language.load(grammarBytes(dialect))] as const));
  for (const [dialect, language] of languages) {
    const parser = new Parser(); parser.setLanguage(language);
    loaded.set(dialect, { parser, query: new Query(language, metricsQueryText(dialect)) });
  }
  return {
    measure(dialect, content) {
      const { parser, query } = loaded.get(dialect)!;
      parser.reset();
      // Go's final statement needs a terminal newline; lines still map to the original input.
      const tree = parser.parse(dialect === 'go' && !content.endsWith('\n') ? `${content}\n` : content);
      if (!tree) throw new Error(`Parser returned no tree for ${dialect}`);
      try { return measure(tree.rootNode, query); } finally { tree.delete(); }
    },
    close() { for (const { parser, query } of loaded.values()) { query.delete(); parser.delete(); } loaded.clear(); },
  };
}
