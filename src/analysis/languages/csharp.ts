import type { AnalysisContext, Analyzer } from '../../core/analyzer.js';
import { evidence } from '../../core/graph.js';
import { fileAnalysis } from '../facts.js';
import { CsharpResolver, CSHARP_RESOLVER_VERSION } from '../resolution/csharp.js';
import { DOTNET_PROJECT_VERSION } from '../resolution/dotnet-projects.js';
import { STRUCTURE_VERSION } from '../tree-sitter/analyzer.js';
import { fileKey } from '../../pipeline/cache.js';
export const CSHARP_IMPORT_VERSION = '1';
export const csharpAnalyzer: Analyzer = { name: 'csharp-imports', version: CSHARP_IMPORT_VERSION, async analyze(context: AnalysisContext) {
        const files = [...context.files.values()].filter(file => file.language === 'csharp' && file.analyzable).sort((a, b) => a.path.localeCompare(b.path, 'en'));
        if (!files.length)
            return;
        const resolver = context.csharp = new CsharpResolver(context), run = async () => {
            context.graph.entities.get(context.repositoryId)!.metadata.dotnetProjects = resolver.projects.describe();
            for (const file of files) {
                const entity = context.graph.entities.get(file.id)!, analysis = fileAnalysis(entity.metadata.analysis), syntax = resolver.facts(file.path);
                if (!analysis)
                    continue;
                if (!syntax) {
                    analysis.features.imports = { status: 'failed', reason: 'C# syntax facts are unavailable' };
                    continue;
                }
                const selection = resolver.projects.selection(file.path), environment = resolver.environment(file.path);
                entity.metadata.csharpCompilation = { project: selection.project?.id, candidates: selection.candidates, targetFramework: selection.project?.targetFramework, namespaces: syntax.namespaces.map(item => item.name), gaps: [...syntax.gaps, ...selection.project?.gaps ?? [], ...selection.project?.blockers ?? [], ...environment.status !== 'resolved' ? [environment.reason] : []] };
                entity.metadata.importResolver = { adapter: 'csharp', version: CSHARP_IMPORT_VERSION, project: selection.project?.id };
                const imports = [...syntax.imports.filter(fact => !fact.global).map(fact => ({ file: file.path, fact, proof: [] })), ...resolver.globalImports(file.path)], outcomes: unknown[] = [], external: string[] = [];
                for (const item of imports) {
                    const { fact } = item, result = resolver.resolve(file.path, fact), proof = [{ ...evidence(item.file.endsWith('.cs') ? 'syntax' : 'filesystem', 'csharp-imports', item.file, fact.range.startLine, item.file.endsWith('.cs') ? 'Original ' + fact.kind + ' using ' + fact.specifier : 'Original MSBuild Using item ' + fact.specifier), analyzerVersion: CSHARP_IMPORT_VERSION, endLine: fact.range.endLine }, ...item.proof, ...'proof' in result ? result.proof : []], metadata = { adapter: 'csharp', version: 1, specifier: fact.specifier, kind: fact.kind, local: fact.alias, global: fact.global, origin: item.file, range: fact.range, namespace: fact.namespace, scopeStart: fact.scopeStart, scopeEnd: fact.scopeEnd };
                    const outcome = result.status === 'resolved' ? { status: result.status, targets: [...new Set(result.symbols.map(symbol => symbol.file.id))].sort(), declarations: [...new Set(result.symbols.map(symbol => symbol.id))].sort(), namespace: result.namespace, proof, conditions: result.conditions } : result.status === 'external' ? { ...result, proof } : result;
                    outcomes.push({ ...metadata, outcome });
                    if (result.status === 'resolved')
                        for (const target of new Set(result.symbols.map(symbol => symbol.file.id)))
                            context.graph.relate(file.id, target, 'imports', proof, { ...metadata, declarations: result.symbols.filter(symbol => symbol.file.id === target).map(symbol => symbol.id) }, JSON.stringify([item.file, fact.kind, fact.specifier, fact.alias ?? '', fact.global, fact.namespace]));
                    else if (result.status === 'external')
                        external.push(fact.specifier);
                    else
                        context.graph.diagnose({ analyzer: 'csharp-imports', severity: 'warning', code: 'csharp-import-' + result.status, file: file.path, entityId: file.id, line: fact.range.startLine, reason: result.reason });
                }
                entity.metadata.importOutcomes = outcomes;
                entity.metadata.externalImports = [...new Set(external)].sort();
                analysis.features.imports = { status: selection.reason ? 'disabled' : 'partial', reason: selection.reason ?? 'Indexed MSBuild compile/project-reference data and original namespace/static/alias/global usings; compiler/binary/generated behavior retains gaps' };
                for (const reason of new Set([...syntax.gaps, ...selection.project?.gaps ?? [], ...selection.project?.blockers ?? []]))
                    context.graph.diagnose({ analyzer: 'csharp-imports', severity: 'warning', code: 'csharp-project-gap', file: file.path, entityId: file.id, reason });
            }
        };
        if (context.cache)
            await context.cache.unit(context, this.name, 'repository', { version: CSHARP_IMPORT_VERSION, resolver: CSHARP_RESOLVER_VERSION, projects: DOTNET_PROJECT_VERSION, syntax: STRUCTURE_VERSION, config: context.config, model: resolver.projects.describe(), availability: files.map(file => [file.path, resolver.facts(file.path)?.complete, context.graph.entities.get(file.id)?.metadata.analysis]), files: [...context.files.values()].map(file => fileKey(context, file.path)), paths: [...context.files.values()].map(file => [file.path, file.language, file.analyzable]), observed: [...context.fileInventory ?? []].sort(), directories: [...context.directoryInventory ?? []].sort() }, run);
        else
            await run();
    } };
