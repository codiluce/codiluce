import type { AnalysisContext, Analyzer } from '../../core/analyzer.js';
import { evidence } from '../../core/graph.js';
import { fileAnalysis } from '../facts.js';
import { JvmResolver, JVM_RESOLVER_VERSION } from '../resolution/jvm.js';
import { JVM_PROJECT_VERSION } from '../resolution/jvm-projects.js';
import { STRUCTURE_VERSION } from '../tree-sitter/analyzer.js';
import { fileKey } from '../../pipeline/cache.js';
import { JvmSymbols, JVM_SYMBOL_VERSION } from './jvm-symbols.js';
import { SpringMvc } from '../frameworks/spring-mvc.js';
import { SPRING_VERSION } from '../frameworks/spring-profile.js';
export const JVM_IMPORT_VERSION = '2';
export const jvmAnalyzer: Analyzer = { name: 'jvm-imports', version: JVM_IMPORT_VERSION, async analyze(context: AnalysisContext) {
        const files = [...context.files.values()].filter(file => ['java', 'kotlin'].includes(file.language ?? '') && file.analyzable).sort((a, b) => a.path.localeCompare(b.path, 'en'));
        if (!files.length)
            return;
        const resolver = context.jvm = new JvmResolver(context), symbols = context.jvmSymbols = new JvmSymbols(context, resolver), run = async () => {
            context.graph.entities.get(context.repositoryId)!.metadata.jvmProjects = resolver.projects.describe();
            for (const file of files) {
                const entity = context.graph.entities.get(file.id)!, analysis = fileAnalysis(entity.metadata.analysis), syntax = resolver.facts(file.path);
                if (!analysis)
                    continue;
                if (!syntax) {
                    analysis.features.imports = { status: 'failed', reason: 'JVM syntax facts are unavailable' };
                    continue;
                }
                const selection = resolver.projects.selection(file.path);
                entity.metadata.jvmCompilation = { package: syntax.package, project: selection.project?.id, sourceSet: selection.set, selectedSourceSet: selection.project?.sourceSet, sourceRoots: selection.project?.roots, gaps: [...syntax.gaps, ...selection.project?.gaps ?? [], ...selection.reason ? [selection.reason] : []] };
                entity.metadata.importResolver = { adapter: 'jvm', version: JVM_IMPORT_VERSION, project: selection.project?.id };
                const outcomes: unknown[] = [], external: string[] = [];
                for (const fact of syntax.imports) {
                    const result = resolver.resolve(file.path, fact), proof = [{ ...evidence('syntax', 'jvm-imports', file.path, fact.range.startLine, `Original ${file.language} ${fact.kind} import ${fact.specifier}`), analyzerVersion: JVM_IMPORT_VERSION, endLine: fact.range.endLine }, ...'proof' in result ? result.proof : []], metadata = { adapter: 'jvm', version: 1, specifier: fact.specifier, kind: fact.kind, local: fact.alias ?? fact.specifier.split('.').at(-1), range: fact.range, conditions: 'conditions' in result ? result.conditions : [] };
                    const outcome = result.status === 'resolved' ? { status: result.status, targets: [...new Set(result.symbols.map(symbol => symbol.file.id))].sort(), declarations: result.symbols.map(symbol => symbol.id), proof, conditions: result.conditions } : result.status === 'external' ? { ...result, proof } : result;
                    outcomes.push({ ...metadata, outcome });
                    if (result.status === 'resolved')
                        for (const target of new Set(result.symbols.map(symbol => symbol.file.id)))
                            context.graph.relate(file.id, target, 'imports', proof, { ...metadata, declarations: result.symbols.filter(symbol => symbol.file.id === target).map(symbol => symbol.id) }, JSON.stringify([fact.kind, fact.specifier, fact.alias ?? '']));
                    else if (result.status === 'external')
                        external.push(fact.specifier);
                    else
                        context.graph.diagnose({ analyzer: 'jvm-imports', severity: 'warning', code: `jvm-import-${result.status}`, file: file.path, entityId: file.id, line: fact.range.startLine, reason: result.reason });
                }
                entity.metadata.importOutcomes = outcomes;
                entity.metadata.externalImports = [...new Set(external)].sort();
                analysis.features.imports = { status: selection.reason ? 'disabled' : 'partial', reason: selection.reason ?? 'Indexed Maven/Gradle/configured projects, selected source sets and local Java/Kotlin import declarations; binary classpaths, compiler interop and executable build models retain gaps' };
                for (const reason of new Set([...syntax.gaps, ...selection.project?.gaps ?? []]))
                    context.graph.diagnose({ analyzer: 'jvm-imports', severity: 'warning', code: 'jvm-project-gap', file: file.path, entityId: file.id, reason });
            }
            symbols.analyze(files);
            new SpringMvc(context,symbols).run(files);
        };
        if (context.cache)
            await context.cache.unit(context, this.name, 'repository', { version: JVM_IMPORT_VERSION, symbols: JVM_SYMBOL_VERSION, spring:SPRING_VERSION, syntax: STRUCTURE_VERSION, resolver: JVM_RESOLVER_VERSION, projects: JVM_PROJECT_VERSION, config: context.config, model: resolver.projects.describe(), availability: files.map(file => [file.path, resolver.facts(file.path)?.complete, context.graph.entities.get(file.id)?.metadata.analysis]), files: [...context.files.values()].filter(file => ['java', 'kotlin', 'xml', 'groovy', 'properties', 'toml','yaml'].includes(file.language ?? '')).map(file => fileKey(context, file.path)), paths: [...context.files.values()].map(file => [file.path, file.language, file.analyzable]), observed: [...context.fileInventory ?? []].sort(), directories: [...context.directoryInventory ?? []].sort() }, run);
        else
            await run();
    } };
