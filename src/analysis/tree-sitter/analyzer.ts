import type { AnalysisContext, Analyzer, ScannedFile } from '../../core/analyzer.js';
import { ANALYZER_VERSION, declarationHashes, evidence } from '../../core/graph.js';
import type { DeclarationFact, FileAnalysis, StructureFacts } from '../facts.js';
import { featureOutcomes } from '../facts.js';
import { AnalysisRegistry } from '../registry.js';
import { GRAMMAR_CATALOG_VERSION, STRUCTURAL_LANGUAGES, grammarCatalog, grammarManifest, grammarManifestError, hashText, queryText, verifiedGrammar } from './grammars.js';
import { StructureParser } from './client.js';
import { fileKey } from '../../pipeline/cache.js';
import { IndexedSources } from '../indexed-sources.js';

export const STRUCTURE_VERSION = `${ANALYZER_VERSION}:${GRAMMAR_CATALOG_VERSION}:11`;
export const analysisRegistry = new AnalysisRegistry();
analysisRegistry.registerLanguage({ id: 'typescript', version: ANALYZER_VERSION, languages: ['typescript', 'javascript'], features: { structure: 'supported', imports: 'partial', references: 'partial', effects: 'partial', guards: 'supported' } });
analysisRegistry.registerLanguage({ id: 'php', version: ANALYZER_VERSION, languages: ['php'], features: { structure: 'partial', imports: 'partial', references: 'partial', effects: 'partial', guards: 'supported' } });
for (const language of STRUCTURAL_LANGUAGES) analysisRegistry.registerLanguage({ id: `syntax-${language}`, version: STRUCTURE_VERSION, languages: [language], features: { structure: 'supported', ...(language === 'python' ? { imports: 'partial' } : {}) } });

export const structureAnalyzer: Analyzer = {
  name: 'tree-sitter-structure', version: STRUCTURE_VERSION,
  async analyze(context): Promise<void> {
    const parser = new StructureParser();
    const sources = context.sources ?? new IndexedSources(context);
    const integrity = new Map<string, string | undefined>();
    try {
      for (const file of [...context.files.values()].sort((a, b) => a.path.localeCompare(b.path, 'en'))) {
        const grammar = grammarCatalog.get(file.language ?? '');
        if (!(STRUCTURAL_LANGUAGES as readonly string[]).includes(file.language ?? '') || !file.analyzable) continue;
        const fileEntity = context.graph.entities.get(file.id)!;
        const analysis: FileAnalysis = {
          version: 1, adapter: `syntax-${file.language}`, adapterVersion: STRUCTURE_VERSION,
          features: featureOutcomes('unsupported', 'This language adapter currently extracts declarations only'),
        };
        fileEntity.metadata.analysis = analysis;
        try {
          if (grammarManifestError) throw new Error(grammarManifestError);
          if (!grammar) throw new Error(`Grammar missing from catalog: ${file.language}`);
          analysis.parser = { name: 'tree-sitter', version: grammarManifest.runtime.version, grammar: grammar.sourceRevision, grammarHash: grammar.sha256, queryHash: hashText(queryText(grammar.language)), abi: grammar.abi };
          // Check assets even on a warm fact-cache hit. One missing grammar
          // affects its own files, while other adapters remain usable.
          if (!integrity.has(grammar.language)) {
            try { verifiedGrammar(grammar); integrity.set(grammar.language, undefined); }
            catch (error) { integrity.set(grammar.language, error instanceof Error ? error.message : String(error)); }
          }
          if (integrity.get(grammar.language)) throw new Error(integrity.get(grammar.language));
          const content = sources.readText(file.path);
          const compute = () => parser.parse(grammar.language, content);
          const facts = context.cache ? await context.cache.value('syntax-facts', file.path, { version: STRUCTURE_VERSION, file: fileKey(context, file.path), parser: analysis.parser }, compute) : await compute();
          const declarations = declare(context, file, content, facts);
          if (facts.python) { context.syntax ??= new Map(); context.syntax.set(file.path, { facts, declarations }); }
          analysis.features.structure = { status: facts.issues.length ? 'partial' : 'supported', ...(facts.issues.length ? { reason: `${facts.issues.length} syntax or extraction finding(s); valid declarations retained` } : {}) };
          for (const issue of facts.issues) context.graph.diagnose({ analyzer: 'tree-sitter-structure', severity: 'warning', code: issue.code, file: file.path, entityId: file.id, ...(issue.range ? { line: issue.range.startLine } : {}), reason: issue.reason });
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          analysis.features.structure = { status: 'failed', reason };
          context.graph.diagnose({ analyzer: 'tree-sitter-structure', severity: 'warning', code: 'syntax-analysis-failed', file: file.path, entityId: file.id, reason });
        }
      }
    } finally { parser.close(); }
  },
};

function declare(context: AnalysisContext, file: ScannedFile, content: string, facts: StructureFacts): Map<string, string> {
  const { graph } = context;
  const ids = new Map<string, string>(), occurrences = new Map<string, number>();
  for (const declaration of facts.declarations) {
    const identity = [file.language!, file.application?.name ?? '', file.path, declaration.qualifiedName, declaration.kind, declaration.signature];
    const base = JSON.stringify(identity), ordinal = occurrences.get(base) ?? 0;
    occurrences.set(base, ordinal + 1);
    ids.set(declaration.key, graph.id('symbol', ...identity, ...(ordinal ? [`declaration:${ordinal + 1}`] : [])));
  }
  for (const declaration of facts.declarations) {
    const fact = { ...evidence('syntax', 'tree-sitter-structure', file.path, declaration.range.startLine, `${file.language} ${declaration.kind} declaration`), analyzerVersion: STRUCTURE_VERSION, endLine: declaration.range.endLine };
    graph.contain({
      id: ids.get(declaration.key)!, type: declaration.entityType, name: declaration.name, path: file.path, language: file.language,
      parentId: declaration.parent ? ids.get(declaration.parent) ?? file.id : file.id,
      sourceRange: declaration.range, metrics: { loc: declaration.range.endLine - declaration.range.startLine + 1 },
      metadata: declarationMetadata(declaration, content), evidence: [fact],
    });
  }
  return ids;
}
function declarationMetadata(declaration: DeclarationFact, content: string): Record<string, unknown> {
  return {
    qualifiedName: declaration.qualifiedName, declarationKind: declaration.kind, role: declaration.kind,
    signature: declaration.signature,
    ...(declaration.visibility ? { visibility: declaration.visibility } : {}),
    ...(declaration.exported !== undefined ? { exported: declaration.exported } : {}),
    ...(declaration.modifiers ? { modifiers: declaration.modifiers } : {}),
    ...(declaration.annotations ? { annotations: declaration.annotations } : {}),
    ...declarationHashes(content.slice(declaration.start, declaration.end), declaration.nameEnd - declaration.start),
  };
}
