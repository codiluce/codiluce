import path from 'node:path';
import type { AnalysisContext, ScannedFile } from '../../core/analyzer.js';
import { evidence, type Evidence } from '../../core/graph.js';
import type { DeclarationFact, JvmDeclarationFact, JvmImportFact, JvmSyntaxFacts } from '../facts.js';
import { JvmProjects, type JvmProject } from './jvm-projects.js';
export const JVM_RESOLVER_VERSION = '1';
export interface JvmSymbol {
    id: string;
    file: ScannedFile;
    project: JvmProject;
    syntax: JvmDeclarationFact;
    declaration: DeclarationFact;
    package: string;
    proof: Evidence[];
}
export type JvmResolution = {
    status: 'resolved';
    symbols: JvmSymbol[];
    proof: Evidence[];
    conditions: string[];
} | {
    status: 'external';
    dependency: string;
    proof: Evidence[];
    conditions: string[];
} | {
    status: 'ambiguous';
    candidates: string[];
    reason: string;
} | {
    status: 'unsupported' | 'excluded' | 'unresolved';
    reason: string;
};
const types = new Set(['class', 'interface', 'enum', 'record', 'annotation', 'object', 'typealias']);
export class JvmResolver {
    readonly projects: JvmProjects;
    readonly symbols: JvmSymbol[] = [];
    constructor(readonly context: AnalysisContext) {
        this.projects = new JvmProjects(context);
        for (const file of context.files.values()) {
            const parsed = context.syntax?.get(file.path), syntax = parsed?.facts.jvm, selected = this.projects.selection(file.path);
            if (!syntax?.complete || !selected.project || selected.reason)
                continue;
            const declarationsByKey = new Map(parsed!.facts.declarations.map(item => [item.key, item]));
            for (const fact of syntax.declarations) {
                const id = parsed!.declarations.get(fact.key), declaration = declarationsByKey.get(fact.key);
                if (!id || !declaration)
                    continue;
                this.symbols.push({ id, file, project: selected.project, syntax: fact, declaration, package: syntax.package, proof: [...selected.proof, { ...evidence('syntax', 'jvm-resolver', file.path, declaration.range.startLine, 'Original indexed JVM declaration'), analyzerVersion: JVM_RESOLVER_VERSION }] });
            }
        }
    }
    facts(file: string): JvmSyntaxFacts | undefined { return this.context.syntax?.get(file)?.facts.jvm; }
    private accessible(symbol: JvmSymbol, origin: ScannedFile, project: JvmProject, pkg: string): boolean {
        const access = (item: JvmSymbol) => item.syntax.visibility === 'public' || item.syntax.visibility === 'internal' && item.project.id === project.id || item.syntax.visibility === 'package' && item.package === pkg || item.syntax.visibility === 'private' && item.file.language === 'kotlin' && !item.syntax.parent && item.file.path === origin.path;
        if (!access(symbol))
            return false;
        let item = symbol;
        const seen = new Set<string>();
        while (item.syntax.parent) {
            if (seen.has(item.id))
                return false;
            seen.add(item.id);
            const parent = this.symbols.find(candidate => candidate.file.path === item.file.path && candidate.syntax.key === item.syntax.parent);
            if (!parent || !access(parent))
                return false;
            item = parent;
        }
        return true;
    }
    resolve(file: string, fact: JvmImportFact): JvmResolution {
        const origin = this.context.files.get(file), syntax = this.facts(file), selection = this.projects.selection(file);
        if (!origin || !syntax?.complete)
            return { status: 'unsupported', reason: 'Complete original JVM compilation-unit syntax is required' };
        if (selection.reason || !selection.project)
            return { status: selection.set === 'test' ? 'excluded' : 'unsupported', reason: selection.reason ?? 'JVM project is unavailable' };
        const classpath = this.projects.classpath(selection.project), projects = new Set(classpath.projects.map(project => project.id));
        if (classpath.gaps.length)
            return { status: 'unsupported', reason: classpath.gaps.join('; ') };
        if (syntax.gaps.length)
            return { status: 'unsupported', reason: syntax.gaps.join('; ') };
        // An unindexed/broken source in a visible source root can hide a competing
        // export. Do not use arbitrary disk/JAR lookup to fill the gap.
        const sourceVisible = (name: string) => { const owner = this.projects.owner(name), language = name.endsWith('.java') ? 'java' : name.endsWith('.kt') ? 'kotlin' : undefined; return owner && projects.has(owner.id) && owner.roots.some(root => root.language === language && (root.path === '.' || name === root.path || name.startsWith(root.path + '/')) && (root.set === 'main' || owner.id === selection.project!.id && selection.project!.sourceSet === 'test')); };
        for (const name of this.context.fileInventory ?? [])
            if (!this.context.files.has(name) && sourceVisible(name))
                return { status: 'excluded', reason: `Observed excluded JVM source may hide a competing declaration: ${name}` };
        const indexedDirectories = new Set(['.']);
        for (const name of this.context.files.keys()) {
            let directory = path.posix.dirname(name);
            while (!indexedDirectories.has(directory)) {
                indexedDirectories.add(directory);
                directory = path.posix.dirname(directory);
            }
        }
        for (const directory of this.context.directoryInventory ?? [])
            if (!indexedDirectories.has(directory) && classpath.projects.some(project => this.projects.owner(directory)?.id === project.id && project.roots.some(root => (root.path === '.' || directory === root.path || directory.startsWith(root.path + '/')) && (root.set === 'main' || project.id === selection.project!.id && selection.project!.sourceSet === 'test'))))
                return { status: 'excluded', reason: `Visible JVM source root crosses an unindexed directory/symlink boundary: ${directory}` };
        for (const candidate of this.context.files.values())
            if (sourceVisible(candidate.path)) {
                const chosen = this.projects.selection(candidate.path);
                if (chosen.project && projects.has(chosen.project.id) && !chosen.reason && (!candidate.analyzable || !this.facts(candidate.path)?.complete || this.facts(candidate.path)?.gaps.length || this.facts(candidate.path)?.module))
                    return { status: 'unsupported', reason: `Visible JVM source has unavailable syntax or an unreviewed compilation/lexical boundary: ${candidate.path}` };
            }
        const visible = this.symbols.filter(symbol => sourceVisible(symbol.file.path) && symbol.syntax.importable);
        if (origin.language === 'kotlin' && fact.kind === 'star' && visible.some(symbol => symbol.declaration.kind === 'object' && symbol.syntax.qualifiedName === fact.specifier))
            return { status: 'unresolved', reason: 'Kotlin object members cannot be imported with a star import' };
        const qualified = fact.specifier, wildcard = fact.kind === 'star' || fact.kind === 'static-star', isStatic = fact.kind.startsWith('static');
        if (wildcard && visible.some(symbol => symbol.file.language === 'java' && symbol.syntax.qualifiedName === qualified && types.has(symbol.declaration.kind) && /\b(?:extends|implements)\b/.test(symbol.declaration.signature)))
            return { status: 'unsupported', reason: 'Inherited JVM on-demand import members require a reviewed type/ancestor binding profile' };
        let possible: JvmSymbol[];
        if (wildcard) {
            possible = visible.filter(symbol => {
                if (isStatic)
                    return symbol.syntax.static && symbol.syntax.qualifiedName.slice(0, symbol.syntax.qualifiedName.lastIndexOf('.')) === qualified;
                if (origin.language === 'java')
                    return types.has(symbol.declaration.kind) && ((!symbol.syntax.parent && symbol.package === qualified) || symbol.syntax.parent && symbol.syntax.qualifiedName.slice(0, symbol.syntax.qualifiedName.lastIndexOf('.')) === qualified);
                return !symbol.syntax.parent && symbol.package === qualified || symbol.syntax.parent && this.symbols.some(parent => parent.file.path === symbol.file.path && parent.syntax.key === symbol.syntax.parent && types.has(parent.declaration.kind) && parent.syntax.qualifiedName === qualified) && types.has(symbol.declaration.kind);
            });
        }
        else
            possible = visible.filter(symbol => symbol.syntax.qualifiedName === qualified && (!isStatic || symbol.syntax.static) && (!(origin.language === 'java' && !isStatic) || types.has(symbol.declaration.kind) && symbol.declaration.kind !== 'typealias'));
        const targets = possible.filter(symbol => this.accessible(symbol, origin, selection.project!, syntax.package));
        if (possible.length && !targets.length)
            return { status: 'unresolved', reason: 'Original JVM declaration is not accessible from this compilation unit/module' };
        const groups = new Map<string, JvmSymbol[]>();
        for (const symbol of targets) {
            const key = symbol.syntax.qualifiedName, list = groups.get(key) ?? [];
            list.push(symbol);
            groups.set(key, list);
        }
        for (const list of groups.values()) {
            const type = list.some(symbol => types.has(symbol.declaration.kind)), files = new Set(list.map(symbol => symbol.file.path));
            if (list.length > 1 && (type || files.size > 1))
                return { status: 'ambiguous', candidates: list.map(symbol => symbol.id).sort(), reason: 'Competing visible JVM declarations; no classpath winner is assumed' };
        }
        const local = fact.alias ?? qualified.split('.').at(-1)!;
        if (!wildcard) {
            const competing = syntax.imports.filter(imported => imported !== fact && !['star', 'static-star'].includes(imported.kind) && (imported.alias ?? imported.specifier.split('.').at(-1)) === local && imported.specifier !== qualified);
            if (competing.length)
                return { status: 'ambiguous', candidates: targets.map(symbol => symbol.id), reason: 'Competing explicit JVM import bindings' };
            if (syntax.declarations.some(declaration => !declaration.parent && declaration.name === local && declaration.qualifiedName !== qualified))
                return { status: 'ambiguous', candidates: targets.map(symbol => symbol.id), reason: 'Top-level source declaration competes with the imported simple name' };
        }
        const proof = [...selection.proof, ...classpath.proof, ...targets.flatMap(symbol => symbol.proof)], conditions = ['Indexed source/classpath contract; binary dependencies, compiler-generated declarations and runtime classloading are not executed'];
        if (targets.length)
            return { status: 'resolved', symbols: targets.sort((a, b) => a.id.localeCompare(b.id)), proof, conditions };
        // Local source packages do not prove an absent member is an external export.
        const localPackage = visible.some(symbol => qualified === symbol.package || qualified.startsWith(symbol.package + '.') && !!symbol.package);
        if (localPackage)
            return { status: 'unresolved', reason: 'No accessible original declaration matches this local JVM import' };
        return { status: 'external', dependency: qualified, proof, conditions: [...conditions, 'External import spelling is retained; no binary/package identity is certified'] };
    }
}
