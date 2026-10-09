import type { AnalysisContext, ScannedFile } from '../../core/analyzer.js';
import { evidence, type Evidence } from '../../core/graph.js';
import type { CsharpDeclarationFact, CsharpImportFact, CsharpSyntaxFacts, DeclarationFact } from '../facts.js';
import { DotnetProjects, type DotnetProject } from './dotnet-projects.js';
export const CSHARP_RESOLVER_VERSION = '1';
export interface CsharpSymbol {
    id: string;
    file: ScannedFile;
    project: DotnetProject;
    syntax: CsharpDeclarationFact;
    declaration: DeclarationFact;
    proof: Evidence[];
}
export type CsharpResolution = {
    status: 'resolved';
    symbols: CsharpSymbol[];
    proof: Evidence[];
    namespace?: string;
    conditions: string[];
} | {
    status: 'external';
    dependency: string;
    proof: Evidence[];
    conditions: string[];
} | {
    status: 'unsupported' | 'excluded' | 'unresolved';
    reason: string;
} | {
    status: 'ambiguous';
    candidates: string[];
    reason: string;
};
export type CsharpEnvironment = {
    status: 'resolved';
    origin: ScannedFile;
    syntax: CsharpSyntaxFacts;
    project: DotnetProject;
    projects: DotnetProject[];
    symbols: CsharpSymbol[];
    proof: Evidence[];
} | {
    status: 'unsupported' | 'excluded';
    reason: string;
};
/** An indexed source import service, not an MSBuild/compiler invocation. */
export class CsharpResolver {
    readonly projects: DotnetProjects;
    readonly symbols: CsharpSymbol[] = [];
    private readonly environments = new Map<string, CsharpEnvironment>();
    constructor(readonly context: AnalysisContext) {
        this.projects = new DotnetProjects(context);
        // A linked source keeps one original graph identity and a symbol in each
        // owning compilation. Ownership ambiguity is resolved at the consumer.
        for (const project of this.projects.projects)
            for (const path of project.sources) {
                const file = context.files.get(path), parsed = context.syntax?.get(path), facts = parsed?.facts.csharp;
                if (!file || !facts?.complete)
                    continue;
                const declarations = new Map(parsed!.facts.declarations.map(fact => [fact.key, fact]));
                for (const fact of facts.declarations) {
                    const id = parsed!.declarations.get(fact.key), declaration = declarations.get(fact.key);
                    if (!id || !declaration)
                        continue;
                    this.symbols.push({ id, file, project, syntax: fact, declaration, proof: [...project.proof, { ...evidence('syntax', 'csharp-resolver', path, declaration.range.startLine, 'Original C# declaration fragment'), analyzerVersion: CSHARP_RESOLVER_VERSION, endLine: declaration.range.endLine }] });
                }
            }
    }
    facts(file: string): CsharpSyntaxFacts | undefined { return this.context.syntax?.get(file)?.facts.csharp; }
    environment(file: string): CsharpEnvironment { let environment = this.environments.get(file); if (!environment) {
        environment = this.prepare(file);
        this.environments.set(file, environment);
    } return environment; }
    private prepare(file: string): CsharpEnvironment {
        const origin = this.context.files.get(file), syntax = this.facts(file), selection = this.projects.selection(file);
        if (!origin || !syntax?.complete)
            return { status: 'unsupported', reason: 'Complete original C# compilation-unit syntax is unavailable' };
        if (!selection.project || selection.reason)
            return { status: selection.candidates.length ? 'unsupported' : 'excluded', reason: selection.reason ?? 'C# compilation unavailable' };
        const classpath = this.projects.classpath(selection.project);
        if (classpath.gaps.length)
            return { status: 'unsupported', reason: classpath.gaps.join('; ') };
        for (const project of classpath.projects)
            for (const source of project.sources) {
                const file = this.context.files.get(source), facts = this.facts(source);
                if (!file?.analyzable)
                    return { status: 'excluded', reason: 'Visible Compile source is excluded/unavailable: ' + source };
                if (!facts?.complete || facts.gaps.length)
                    return { status: 'unsupported', reason: 'Visible C# source has unavailable syntax or an unreviewed lexical boundary: ' + source + '; ' + (facts?.gaps.join('; ') ?? 'syntax unavailable') };
            }
        const visible = new Set(classpath.projects.map(project => project.id));
        return { status: 'resolved', origin, syntax, project: selection.project, projects: classpath.projects, symbols: this.symbols.filter(symbol => visible.has(symbol.project.id)), proof: classpath.projects.flatMap(project => project.proof) };
    }
    accessible(symbol: CsharpSymbol, environment: Extract<CsharpEnvironment, {
        status: 'resolved';
    }>): boolean { let current: CsharpSymbol | undefined = symbol; const seen = new Set<string>(); while (current) {
        if (seen.has(current.id))
            return false;
        seen.add(current.id);
        const visibility = current.syntax.visibility;
        if (current.syntax.fileLocal && current.file.path !== environment.origin.path)
            return false;
        if (visibility !== 'public' && !((visibility === 'internal' || visibility === 'protected internal') && current.project.id === environment.project.id))
            return false;
        if (!current.syntax.parent)
            return true;
        const parent: string = current.syntax.parent, currentFile: string = current.file.path, currentProject: string = current.project.id;
        current = this.symbols.find(candidate => candidate.file.path === currentFile && candidate.project.id === currentProject && candidate.syntax.key === parent);
        if (!current)
            return false;
    } return false; }
    globalImports(file: string): {
        file: string;
        fact: CsharpImportFact;
        proof: Evidence[];
    }[] { const selection = this.projects.selection(file); if (!selection.project)
        return []; return [...selection.project.using, ...selection.project.sources.flatMap(source => (this.facts(source)?.imports ?? []).filter(fact => fact.global).map(fact => ({ file: source, fact, proof: [{ ...evidence('syntax', 'csharp-resolver', source, fact.range.startLine, 'Original global using in the same compilation'), analyzerVersion: CSHARP_RESOLVER_VERSION, endLine: fact.range.endLine }] })))]; }
    resolve(file: string, fact: CsharpImportFact): CsharpResolution {
        const environment = this.environment(file);
        if (environment.status !== 'resolved')
            return environment;
        if (!/^(?:global::)?[\p{L}_][\p{L}\p{N}_]*(?:\.[\p{L}_][\p{L}\p{N}_]*)*$/u.test(fact.specifier))
            return { status: 'unsupported', reason: 'Generic/type-expression/extern-alias using requires a reviewed C# binding profile' };
        const absolute = fact.specifier.startsWith('global::'), specifier = fact.specifier.replace(/^global::/, ''), prefixes: string[] = [];
        if (!absolute) {
            let namespace = fact.namespace;
            while (namespace) {
                prefixes.push(namespace + '.');
                namespace = namespace.includes('.') ? namespace.slice(0, namespace.lastIndexOf('.')) : '';
            }
        }
        prefixes.push('');
        const namespaces = new Map<string, Evidence[]>();
        for (const project of environment.projects)
            for (const source of project.sources) {
                const syntax = this.facts(source)!;
                for (const entry of syntax.namespaces) {
                    let namespace = entry.name;
                    while (namespace) {
                        const proof = namespaces.get(namespace) ?? [];
                        proof.push({ ...evidence('syntax', 'csharp-resolver', source, entry.range.startLine, 'Original namespace declaration ' + entry.name), analyzerVersion: CSHARP_RESOLVER_VERSION, endLine: entry.range.endLine });
                        namespaces.set(namespace, proof);
                        namespace = namespace.includes('.') ? namespace.slice(0, namespace.lastIndexOf('.')) : '';
                    }
                }
            }
        // Source namespaces are case-sensitive; a using cannot chain through a
        // sibling using alias. Alias/member reference binding is the next phase.
        const conditions = ['Indexed original source compilation; binary/SDK-generated exports are not compiler-validated', 'Partial declarations retain distinct original fragments; no arbitrary fragment selection'];
        for (const prefix of prefixes) {
            const target = prefix + specifier, types = environment.symbols.filter(symbol => symbol.syntax.type && symbol.syntax.qualifiedName === target && symbol.syntax.arity === 0 && this.accessible(symbol, environment)), namespaceProof = namespaces.get(target);
            if (types.length && namespaceProof)
                return { status: 'ambiguous', candidates: types.map(symbol => symbol.id), reason: 'Source name denotes competing namespace and type declarations: ' + target };
            if (fact.kind === 'namespace' && types.length)
                return { status: 'unresolved', reason: 'Namespace using names a source type: ' + target };
            if (namespaceProof) {
                if (fact.kind === 'static')
                    return { status: 'unresolved', reason: 'Static using must name a type, not a namespace: ' + target };
                const symbols = environment.symbols.filter(symbol => symbol.syntax.type && !symbol.syntax.parent && symbol.syntax.namespace === target && this.accessible(symbol, environment));
                return { status: 'resolved', symbols, namespace: target, proof: [...environment.proof, ...namespaceProof, ...symbols.flatMap(symbol => symbol.proof)], conditions };
            }
            if (types.length) {
                if (types.length !== 1)
                    return { status: 'ambiguous', candidates: [...new Set(types.map(symbol => symbol.id))], reason: 'Several original type/partial fragments compete; logical partial binding remains unreviewed: ' + target };
                const type = types[0]!;
                const symbols = fact.kind === 'static' ? [type, ...environment.symbols.filter(symbol => symbol.file.path === type.file.path && symbol.project.id === type.project.id && symbol.syntax.parent === type.syntax.key && (symbol.syntax.type || symbol.syntax.static) && this.accessible(symbol, environment))] : types;
                return { status: 'resolved', symbols, proof: [...environment.proof, ...symbols.flatMap(symbol => symbol.proof)], conditions };
            }
            const head = prefix + specifier.split('.')[0]!;
            if (specifier.includes('.') && (namespaces.has(head) || environment.symbols.some(symbol => symbol.syntax.type && symbol.syntax.qualifiedName === head)))
                return { status: 'unresolved', reason: 'A nearer source namespace/type hides outer using lookup: ' + head };
            // An inaccessible source name must not fall through to an external
            // package or an outer namespace with the same spelling.
            if (environment.symbols.some(symbol => symbol.syntax.type && symbol.syntax.qualifiedName === target))
                return { status: 'unresolved', reason: 'Source using target is inaccessible, file-local or requires generic type arguments: ' + target };
        }
        return { status: 'external', dependency: specifier, proof: environment.proof, conditions: [...conditions, 'No matching indexed original namespace/type; binary reference identity is not inferred'] };
    }
}
