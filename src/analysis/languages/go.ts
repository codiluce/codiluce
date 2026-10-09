import type { AnalysisContext, Analyzer, ScannedFile } from '../../core/analyzer.js';
import { ANALYZER_VERSION, evidence } from '../../core/graph.js';
import { fileKey } from '../../pipeline/cache.js';
import { fileAnalysis } from '../facts.js';
import { GoResolver, GO_RESOLVER_VERSION, type GoResolution } from '../resolution/go.js';
import { STRUCTURE_VERSION } from '../tree-sitter/analyzer.js';
import { GO_BUILD_VERSION } from './go-build.js';

export const GO_IMPORT_VERSION = `${ANALYZER_VERSION}:go-imports:1`;
export const goAnalyzer: Analyzer = {
  name: 'go-imports', version: GO_IMPORT_VERSION,
  async analyze(context): Promise<void> {
    const files = [...context.files.values()].filter(file => file.language === 'go' && file.analyzable).sort((a, b) => a.path.localeCompare(b.path, 'en')); if (!files.length) return;
    const resolver = context.go = new GoResolver(context), repository = context.graph.entities.get(context.repositoryId)!;
    repository.metadata.projects = [...Array.isArray(repository.metadata.projects) ? repository.metadata.projects : [], ...resolver.describe()];
    const run = async () => { for (const file of files) analyzeFile(context, resolver, file); };
    if (context.cache) await context.cache.unit(context, this.name, 'repository', {
      version: GO_IMPORT_VERSION, syntax: STRUCTURE_VERSION, resolver: GO_RESOLVER_VERSION, build: GO_BUILD_VERSION, config: context.config, projects: resolver.describe(),
      files: [...context.files.values()].filter(file => file.language === 'go' || /(?:^|\/)(?:go\.mod|go\.work)$/.test(file.path)).sort((a, b) => a.path.localeCompare(b.path, 'en')).map(file => fileKey(context, file.path)),
      vendorRoots: [...context.directoryInventory ?? []].filter(dir => /(?:^|\/)vendor$/.test(dir)).sort(), manifests: [...context.goManifestInventory ?? []].sort(), syntaxAvailability: files.map(file => [file.path, context.syntax?.get(file.path)?.facts.go?.complete]),
    }, run); else await run();
  },
};
function serialize(outcome: GoResolution): Record<string, unknown> {
  if (outcome.status === 'resolved') return { status: outcome.status, targets: outcome.package.files.map(file => file.id), package: { key: outcome.package.key, name: outcome.package.name, directory: outcome.package.directory, project: outcome.package.module.id }, proof: outcome.proof, conditions: [...new Set(outcome.conditions)] };
  if (outcome.status === 'external') return { status: outcome.status, dependency: outcome.module, ...(outcome.version ? { declaredVersion: outcome.version } : {}), standardLibrary: outcome.standardLibrary, proof: outcome.proof, conditions: [...new Set(outcome.conditions)] };
  return outcome;
}
function analyzeFile(context: AnalysisContext, resolver: GoResolver, file: ScannedFile): void {
  const entity = context.graph.entities.get(file.id)!, analysis = fileAnalysis(entity.metadata.analysis), parsed = context.syntax?.get(file.path), facts = parsed?.facts.go; if (!analysis) return;
  if (!facts) { analysis.features.imports = { status: 'failed', reason: 'Go syntax facts are unavailable' }; return; }
  const selection = resolver.selection(file.path), environment = resolver.environment(file.path), module = resolver.owner(file.path), ownPackage = resolver.packageFor(file.path);
  entity.metadata.importResolver = { adapter: 'go', version: GO_IMPORT_VERSION, project: module?.id };
  entity.metadata.goBuild = { ...selection, inputs: resolver.config(file.path), workspace: environment.workspace?.file ?? false, invocationConditions: [...environment.conditions, ...(environment.error ? [environment.error.reason] : [])] };
  entity.metadata.goPackage = serialize(ownPackage);
  entity.metadata.importOutcomes = []; entity.metadata.externalImports = [];
  if (selection.status === 'inactive') { analysis.features.imports = { status: 'disabled', reason: 'Inactive under the recorded filename, test and build inputs' }; return; }
  const entries: unknown[] = [], external: string[] = [];
  for (const fact of facts.imports) {
    const outcome = resolver.resolve(file.path, fact.specifier), proof = [{ ...evidence('syntax', 'go-imports', file.path, fact.range.startLine, `Go ${fact.kind} package import ${fact.specifier}`), analyzerVersion: GO_IMPORT_VERSION, endLine: fact.range.endLine }, ...('proof' in outcome ? outcome.proof : [])];
    const conditions = [...selection.conditions, ...(selection.status === 'invalid' ? ['Invalid compilation unit cannot prove a runtime namespace'] : []), ...('conditions' in outcome ? outcome.conditions : [])];
    // Unknown external package names are left for an evidence-backed framework
    // profile. Directory basenames do not invent their default namespace.
    const name = outcome.status === 'resolved' ? outcome.package.name : outcome.status === 'external' && outcome.standardLibrary ? fact.specifier.split('/').filter(part => !/^v\d+$/.test(part)).at(-1) : undefined;
    const local = fact.kind === 'default' ? name : fact.local, metadata = { adapter: 'go', version: 1, specifier: fact.specifier, kind: fact.kind, ...(local ? { local } : {}), range: fact.range, conditions: [...new Set(conditions)], sideEffect: fact.kind === 'blank', dotImport: fact.kind === 'dot' };
    entries.push({ ...metadata, outcome: { ...serialize(outcome), ...('proof' in outcome ? { proof } : {}) } });
    if (outcome.status === 'resolved') for (const target of outcome.package.files) context.graph.relate(file.id, target.id, 'imports', proof, metadata, JSON.stringify([fact.specifier, fact.kind, local ?? '']));
    else if (outcome.status === 'external') external.push(fact.specifier);
    else context.graph.diagnose({ analyzer: 'go-imports', severity: 'warning', code: `go-import-${outcome.status}`, file: file.path, line: fact.range.startLine, entityId: file.id, reason: outcome.reason });
  }
  entity.metadata.importOutcomes = entries; entity.metadata.externalImports = [...new Set(external)].sort();
  for (const reason of selection.conditions) context.graph.diagnose({ analyzer: 'go-imports', severity: 'warning', code: 'go-build-gap', file: file.path, entityId: file.id, reason });
  if (environment.error) context.graph.diagnose({ analyzer: 'go-imports', severity: 'warning', code: 'go-project-gap', file: file.path, entityId: file.id, reason: environment.error.reason });
  analysis.features.imports = { status: 'partial', reason: 'Indexed module/workspace packages, literal replacements, alias/dot/blank imports and recorded build/test inputs; symbol binding, transitive version selection, vendor/GOPATH and generated sources need later profiles' };
}
