import type { Analyzer } from '../../core/analyzer.js';
import { declarationHashes, evidence } from '../../core/graph.js';
import { fileKey } from '../../pipeline/cache.js';
import { featureOutcomes, type FileAnalysis } from '../facts.js';
import { IndexedSources } from '../indexed-sources.js';
import { PhpParser } from '../php/client.js';
import { PHP_PARSER_VERSION, PHP_SOURCE_PROFILE, PHP_STRUCTURE_VERSION } from '../php/version.js';

export const phpStructureAnalyzer: Analyzer = {
  name: 'php-structure', version: PHP_STRUCTURE_VERSION,
  async analyze(context) {
    const parser = new PhpParser(), sources = context.sources ?? new IndexedSources(context);
    try {
      for (const file of [...context.files.values()].sort((a, b) => a.path.localeCompare(b.path, 'en'))) {
        // Laravel keeps its established graph IDs and semantic pipeline. Its
        // wider structure/provider integration is a separate P10c subphase.
        if (file.language !== 'php' || !file.analyzable || file.application?.frameworks.includes('laravel')) continue;
        const fileEntity = context.graph.entities.get(file.id)!;
        const analysis: FileAnalysis = { version: 1, adapter: 'php-original-structure', adapterVersion: PHP_STRUCTURE_VERSION, parser: { name: 'php-parser', version: PHP_PARSER_VERSION }, features: featureOutcomes('unsupported', 'Original PHP structure only; indexed imports, scoped binding and framework semantics require separate services') };
        fileEntity.metadata.analysis = analysis;
        fileEntity.metadata.phpSourceProfile = PHP_SOURCE_PROFILE;
        try {
          const content = sources.readText(file.path);
          const compute = () => parser.parseSource(content);
          const facts = context.cache ? await context.cache.value('php-syntax-facts', file.path, { version: PHP_STRUCTURE_VERSION, file: fileKey(context, file.path), parser: analysis.parser, profile: PHP_SOURCE_PROFILE }, compute) : await compute();
          if (!facts.php) throw Error('PHP provider returned no original-source facts');
          const ids = new Map<string,string>(), occurrences = new Map<string,number>();
          for (const declaration of facts.declarations) {
            const identity = [file.application?.name ?? '', file.path, declaration.qualifiedName, declaration.kind, declaration.signature];
            const base = JSON.stringify(identity), ordinal = occurrences.get(base) ?? 0;
            occurrences.set(base, ordinal + 1);
            ids.set(declaration.key, context.graph.id('symbol', 'php-original', ...identity, ...ordinal ? [`declaration:${ordinal + 1}`] : []));
          }
          const details = new Map(facts.php.declarations.map(declaration => [declaration.key, declaration]));
          for (const declaration of facts.declarations) {
            context.graph.contain({ id: ids.get(declaration.key)!, type: declaration.entityType, name: declaration.name, path: file.path, language: 'php', parentId: declaration.parent ? ids.get(declaration.parent) ?? file.id : file.id, sourceRange: declaration.range, metrics: { loc: declaration.range.endLine - declaration.range.startLine + 1 }, metadata: { qualifiedName: declaration.qualifiedName, declarationKind: declaration.kind, role: declaration.kind, signature: declaration.signature, declarationForm: declaration.declarationForm, visibility: declaration.visibility, modifiers: declaration.modifiers, static: declaration.modifiers?.includes('static') ?? false, sourceConditions: declaration.sourceConditions ?? [], phpDeclaration: details.get(declaration.key), executionUnverified: true, ...declarationHashes(content.slice(declaration.start, declaration.end), declaration.nameEnd - declaration.start) }, evidence: [{ ...evidence('php', this.name, file.path, declaration.range.startLine, `Original PHP ${declaration.kind} source declaration; no autoloading, rendering or execution is inferred`), analyzerVersion: PHP_STRUCTURE_VERSION, endLine: declaration.range.endLine }] });
          }
          fileEntity.metadata.phpSyntax = facts.php;
          context.syntax ??= new Map(); context.syntax.set(file.path, { facts, declarations: ids });
          analysis.features.structure = { status: facts.issues.length ? 'partial' : 'supported', ...facts.issues.length ? { reason: `${facts.issues.length} source extraction finding(s); independently parsed declarations retained` } : {} };
          for (const issue of facts.issues) context.graph.diagnose({ analyzer: this.name, severity: 'warning', code: issue.code, file: file.path, entityId: file.id, line: issue.range?.startLine, reason: issue.reason });
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          analysis.features.structure = { status: 'failed', reason };
          context.graph.diagnose({ analyzer: this.name, severity: 'warning', code: 'php-structure-failed', file: file.path, entityId: file.id, reason });
        }
      }
    } finally { parser.close(); }
  },
};
