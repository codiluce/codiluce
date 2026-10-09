import type { AnalysisContext, Analyzer } from '../../core/analyzer.js';
import { evidence } from '../../core/graph.js';
import { fileAnalysis } from '../facts.js';
import { RustResolver, RUST_RESOLVER_VERSION, type RustResolution } from '../resolution/rust.js';
import { RUST_PROJECT_VERSION } from '../resolution/rust-projects.js';
import { STRUCTURE_VERSION } from '../tree-sitter/analyzer.js';
import { fileKey } from '../../pipeline/cache.js';
export const RUST_IMPORT_VERSION = '1';
export const rustAnalyzer: Analyzer = { name: 'rust-imports', version: RUST_IMPORT_VERSION, async analyze(context: AnalysisContext) {
        const files = [...context.files.values()].filter(file => file.language === 'rust' && file.analyzable).sort((a, b) => a.path.localeCompare(b.path, 'en'));
        if (!files.length)
            return;
        const resolver = context.rust = new RustResolver(context), run = async () => {
            const repository = context.graph.entities.get(context.repositoryId)!;
            repository.metadata.rustProjects = resolver.projects.describe();
            repository.metadata.rustCompilations = resolver.projects.describeCompilations();
            repository.metadata.rustManifestOutcomes = resolver.projects.describeManifests();
            for (const manifest of resolver.projects.describeManifests())
                for (const reason of manifest.gaps)
                    context.graph.diagnose({ analyzer: 'rust-imports', severity: 'warning', code: 'rust-manifest-gap', file: manifest.file, reason });
            for (const file of files) {
                const entity = context.graph.entities.get(file.id)!, analysis = fileAnalysis(entity.metadata.analysis);
                if (!analysis)
                    continue;
                const scopes = resolver.membership.get(file.path) ?? [], outcomes: unknown[] = [], external: string[] = [];
                const record = (result: RustResolution, metadata: Record<string, unknown>, proof: ReturnType<typeof evidence>[]) => {
                    const conditions = 'conditions' in result ? result.conditions : [], qualified = result.status === 'resolved' && conditions.length ? { status: 'unsupported' as const, reason: conditions.join('; '), candidates: result.symbols.map(symbol => symbol.id), conditions } : result;
                    const targets = result.status === 'resolved' ? [...new Set(result.symbols.map(symbol => context.graph.entities.get(symbol.id)?.type === 'file' ? symbol.id : context.files.get(context.graph.entities.get(symbol.id)?.path ?? '')?.id).filter((id): id is string => !!id))].sort() : [];
                    const declarations = result.status === 'resolved' ? result.symbols.filter(symbol => context.graph.entities.get(symbol.id)?.type !== 'file').map(symbol => symbol.id) : [];
                    const outcome = qualified.status === 'resolved' ? { status: 'resolved', targets, declarations, proof, conditions } : qualified;
                    outcomes.push({ ...metadata, outcome });
                    if (qualified.status === 'resolved')
                        for (const target of targets)
                            context.graph.relate(file.id, target, 'imports', proof, { ...metadata, declarations: declarations.filter(id => context.graph.entities.get(id)?.path === context.graph.entities.get(target)?.path) }, JSON.stringify([metadata.compilation, metadata.scope, metadata.start, metadata.specifier, metadata.alias ?? '']));
                    else if (qualified.status === 'external') {
                        external.push(qualified.crate + '::' + qualified.path.join('::'));
                    }
                    else
                        context.graph.diagnose({ analyzer: 'rust-imports', severity: qualified.status === 'excluded' ? 'info' : 'warning', code: `rust-import-${qualified.status}`, file: file.path, entityId: file.id, line: (metadata.range as {
                                startLine: number;
                            })?.startLine, reason: qualified.reason });
                };
                for (const site of resolver.imports.filter(site => site.scope.file.path === file.path).sort((a, b) => a.fact.start - b.fact.start || a.scope.compilation.id.localeCompare(b.scope.compilation.id, 'en') || a.index - b.index)) {
                    const result = resolver.resolve(site), proof = [{ ...evidence('syntax', 'rust-imports', file.path, site.fact.range.startLine, `Original scoped Rust ${site.fact.kind}`), analyzerVersion: RUST_IMPORT_VERSION }, ...'proof' in result ? result.proof : []];
                    record(result, { adapter: 'rust', version: 1, compilation: site.scope.compilation.id, crate: site.scope.compilation.target.id, scope: site.scope.id, module: site.scope.logicalPath.join('::'), specifier: site.fact.specifier, kind: site.fact.kind, alias: site.fact.alias, glob: site.fact.glob, selfOnly: site.fact.selfOnly, visibility: site.fact.visibility, start: site.fact.start, range: site.fact.range }, proof);
                }
                for (const site of resolver.modules.filter(site => site.scope.file.path === file.path)) {
                    const result = site.result, child = result.status === 'resolved' ? result.symbols[0]?.module : undefined, proof = [...site.scope.compilation.proof, ...'proof' in result ? result.proof : []];
                    const target = child?.file.id;
                    const metadata = { adapter: 'rust', version: 1, compilation: site.scope.compilation.id, crate: site.scope.compilation.target.id, scope: site.scope.id, module: site.scope.logicalPath.join('::'), specifier: site.fact.name, kind: 'module', visibility: site.fact.visibility, start: site.fact.start, range: site.fact.range };
                    const originalDeclaration = result.status === 'resolved' ? result.symbols[0]?.id : undefined;
                    record(target && result.status === 'resolved' ? { ...result, symbols: result.symbols.map(symbol => ({ ...symbol, id: target })) } : result, { ...metadata, declaration: originalDeclaration }, proof);
                }
                entity.metadata.importOutcomes = outcomes;
                entity.metadata.externalImports = [...new Set(external)].sort();
                entity.metadata.importResolver = { adapter: 'rust', version: RUST_IMPORT_VERSION };
                entity.metadata.rustCompilationContexts = [...new Map(scopes.map(scope => [scope.compilation.id, { id: scope.compilation.id, crate: scope.compilation.target.id, package: scope.compilation.target.package.id, invocation: scope.compilation.invocation, edition: scope.compilation.target.package.edition, modules: scopes.filter(s => s.compilation.id === scope.compilation.id && ['file', 'module'].includes(s.fact.kind)).map(s => ({ path: s.logicalPath.join('::'), active: s.active, gaps: s.gaps })), gaps: scope.compilation.gaps }])).values()];
                analysis.features.imports = !resolver.syntax(file.path) ? { status: 'failed', reason: 'Original Rust syntax facts are unavailable' } : !scopes.length ? { status: 'disabled', reason: 'Source is outside every selected original Cargo module/target graph' } : { status: 'partial', reason: 'Original Cargo crate/module/target and scoped use/import/re-export bindings; binary exports, generated items, compiler/hygiene and unselected cfg retain gaps' };
                for (const reason of new Set(scopes.flatMap(scope => scope.gaps)))
                    context.graph.diagnose({ analyzer: 'rust-imports', severity: 'warning', code: 'rust-compilation-gap', file: file.path, entityId: file.id, reason });
            }
        };
        if (context.cache)
            await context.cache.unit(context, this.name, 'repository', { version: RUST_IMPORT_VERSION, resolver: RUST_RESOLVER_VERSION, projects: RUST_PROJECT_VERSION, syntax: STRUCTURE_VERSION, config: context.config, models: resolver.projects.describe(), compilations: resolver.projects.describeCompilations(), files: [...context.files.values()].filter(file => ['rust', 'toml'].includes(file.language ?? '') || /(?:^|\/)\.cargo\/config$/.test(file.path)).map(file => fileKey(context, file.path)), paths: [...context.files.values()].map(file => [file.path, file.language, file.analyzable]), observed: [...context.fileInventory ?? []].sort(), directories: [...context.directoryInventory ?? []].sort() }, run);
        else
            await run();
    } };
