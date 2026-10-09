import path from 'node:path';
import type { AnalysisContext, ScannedFile } from '../../core/analyzer.js';
import { evidence, type Evidence } from '../../core/graph.js';
import type { RustImportFact, RustItemFact, RustScopeFact, RustSyntaxFacts } from '../facts.js';
import { rustAnd, rustAttributes, rustName, type RustAttributes, type RustTruth } from '../languages/rust-cfg.js';
import { RustProjects, rustPath, type RustCompilation } from './rust-projects.js';
export const RUST_RESOLVER_VERSION = '2';
export interface RustScope {
    id: string;
    fact: RustScopeFact;
    file: ScannedFile;
    compilation: RustCompilation;
    parent?: RustScope;
    module: RustScope;
    moduleParent?: RustScope;
    logicalPath: string[];
    directory: string;
    pathBase: string;
    active: RustTruth;
    gaps: string[];
    attributes: RustAttributes;
    items: RustSymbol[];
    imports: RustImportSite[];
}
export interface RustSymbol {
    id: string;
    name: string;
    namespaces: RustItemFact['namespaces'];
    scope: RustScope;
    originalScope?: RustScope;
    originalVisibility?: string;
    visibility: string;
    active: RustTruth;
    gaps: string[];
    proof: Evidence[];
    fact?: RustItemFact;
    module?: RustScope;
    external?: {
        dependency: string;
        name: string;
        path: string[];
    };
}
export interface RustImportSite {
    scope: RustScope;
    fact: RustImportFact;
    active: RustTruth;
    gaps: string[];
    index: number;
}
export interface RustModuleSite {
    scope: RustScope;
    fact: RustItemFact;
    active: RustTruth;
    result: RustResolution;
}
export type RustResolution = {
    status: 'resolved';
    symbols: RustSymbol[];
    proof: Evidence[];
    conditions: string[];
} | {
    status: 'external';
    dependency: string;
    crate: string;
    path: string[];
    proof: Evidence[];
    conditions: string[];
} | {
    status: 'ambiguous';
    candidates: string[];
    reason: string;
} | {
    status: 'excluded' | 'unsupported' | 'unresolved';
    reason: string;
};
const failure = (status: 'excluded' | 'unsupported' | 'unresolved', reason: string): RustResolution => ({ status, reason });
const unique = <T>(values: T[]) => [...new Set(values)];
/** Original Rust modules and names under distinct Cargo compilations. No source
 * outside the indexed tree, macro expansion or compiler/runtime binding runs. */
export class RustResolver {
    readonly projects: RustProjects;
    readonly scopes: RustScope[] = [];
    readonly imports: RustImportSite[] = [];
    readonly modules: RustModuleSite[] = [];
    readonly roots = new Map<string, RustScope>();
    readonly membership = new Map<string, RustScope[]>();
    private readonly loading = new Set<string>();
    private readonly resolved = new Map<string, RustResolution>();
    constructor(readonly context: AnalysisContext) {
        this.projects = new RustProjects(context);
        for (const compilation of this.projects.compilations)
            this.root(compilation);
    }
    syntax(file: string): RustSyntaxFacts | undefined { return this.context.syntax?.get(file)?.facts.rust; }
    private proof(file: string, line: number, text: string): Evidence[] { return [{ ...evidence('syntax', 'rust-imports', file, line, text), analyzerVersion: RUST_RESOLVER_VERSION }]; }
    private root(compilation: RustCompilation): RustScope | undefined {
        const known = this.roots.get(compilation.id);
        if (known)
            return known;
        const file = this.context.files.get(compilation.target.file), syntax = this.syntax(compilation.target.file);
        if (!file || !syntax) {
            compilation.gaps.push('Original Rust crate root is denied/unavailable/incomplete');
            return;
        }
        const result = this.load(compilation, file, syntax.scopes.find(s => s.kind === 'file')!, undefined, [], path.posix.dirname(file.path), compilation.selected, compilation.gaps, new Set());
        this.roots.set(compilation.id, result);
        return result;
    }
    private load(comp: RustCompilation, file: ScannedFile, fact: RustScopeFact, parent: RustScope | undefined, logicalPath: string[], directory: string, active: RustTruth, gaps: string[], seen: Set<string>, pathBase?: string): RustScope {
        const syntax = this.syntax(file.path)!, attrs = rustAttributes(fact.attributes, comp.environment), selected = rustAnd([active, attrs.active]);
        const scope: RustScope = { id: this.context.graph.id('rust-scope', comp.id, file.path, fact.key, logicalPath.join('::')), fact, file, compilation: comp, ...(parent ? { parent } : {}), module: undefined!, logicalPath, directory, pathBase: pathBase ?? (fact.kind === 'file' ? path.posix.dirname(file.path) : directory), active: selected, gaps: unique([...gaps, ...fact.gaps, ...attrs.gaps, ...!syntax.complete ? syntax.gaps : []]), attributes: attrs, items: [], imports: [] };
        scope.module = ['file', 'module'].includes(fact.kind) ? scope : parent!.module;
        if (['file', 'module'].includes(fact.kind) && parent)
            scope.moduleParent = parent.module;
        for (const item of syntax.items.filter(i => i.scope === fact.key)) {
            const attributes = rustAttributes(item.attributes, comp.environment);
            if (rustAnd([selected, attributes.active]) !== false)
                scope.gaps.push(...attributes.gaps.filter(gap => gap.startsWith('Unreviewed Rust attribute')));
        }
        scope.gaps = unique(scope.gaps);
        this.scopes.push(scope);
        this.membership.set(file.path, [...this.membership.get(file.path) ?? [], scope]);
        if (seen.size >= 512 || this.scopes.length >= 30000) {
            scope.gaps.push('Rust module/scope traversal budget exceeded');
            return scope;
        }
        for (const [index, import_] of syntax.imports.entries())
            if (import_.scope === fact.key) {
                const attributes = rustAttributes(import_.attributes, comp.environment), site: RustImportSite = { scope, fact: import_, active: rustAnd([selected, attributes.active]), gaps: unique([...scope.gaps, ...import_.gaps, ...attributes.gaps]), index };
                scope.imports.push(site);
                this.imports.push(site);
            }
        for (const item of syntax.items.filter(item => item.scope === fact.key)) {
            const attributes = rustAttributes(item.attributes, comp.environment), itemActive = rustAnd([selected, attributes.active]), id = this.context.syntax?.get(file.path)?.declarations.get(item.key);
            if (!id) {
                scope.gaps.push('Original Rust declaration identity is unavailable');
                continue;
            }
            const symbol: RustSymbol = { id, name: item.name, namespaces: item.namespaces, scope, visibility: item.visibility, active: itemActive, gaps: unique([...scope.gaps, ...attributes.gaps, ...item.gaps]), proof: this.proof(file.path, item.range.startLine, `Original Rust ${item.kind} ${item.name}`), fact: item };
            if (item.kind === 'macro' && !attributes.macroExport)
                symbol.gaps.push('Textual macro_rules scope/import/export behavior is not qualified');
            scope.items.push(symbol);
            if (item.kind === 'macro' && attributes.macroExport) {
                const rootScope = this.scopes.find(s => s.compilation.id === comp.id && s.logicalPath.length === 0 && s.fact.kind === 'file');
                if (rootScope && rootScope !== scope)
                    rootScope.items.push({ ...symbol, scope: rootScope, visibility: 'pub' });
                else
                    symbol.visibility = 'pub';
            }
            if (item.memberScope && itemActive !== false) {
                const child = syntax.scopes.find(s => s.key === item.memberScope)!;
                let childDirectory = item.kind === 'module' ? path.posix.join(scope.directory, item.name) : scope.directory;
                if (item.kind === 'module' && attributes.path !== undefined)
                    childDirectory = rustPath(scope.pathBase, attributes.path) ?? childDirectory;
                symbol.module = this.load(comp, file, child, scope, [...logicalPath, item.name], childDirectory, itemActive, symbol.gaps, seen, childDirectory);
            }
            else if (item.kind === 'module' && !item.memberScope) {
                const result = itemActive === false ? failure('excluded', 'Original Rust module is inactive under recorded cfg') : this.outlined(symbol, attributes, seen);
                this.modules.push({ scope, fact: item, active: itemActive, result });
                if (result.status === 'resolved' && result.symbols[0]?.module)
                    symbol.module = result.symbols[0].module;
                else if (result.status !== 'resolved')
                    symbol.gaps.push('reason' in result ? result.reason : 'Module resolution is unavailable');
            }
        }
        // Original lexical blocks remain separate from the surrounding module.
        for (const child of syntax.scopes.filter(child => child.parent === fact.key && !['file','module','enum'].includes(child.kind)))
            this.load(comp, file, child, scope, logicalPath, directory, selected, scope.gaps, seen, scope.pathBase);
        return scope;
    }
    private existence(file: string): 'indexed' | 'excluded' | 'missing' {
        if (this.context.files.get(file)?.analyzable)
            return 'indexed';
        if (this.context.fileInventory?.has(file) || this.context.files.has(file))
            return 'excluded';
        let directory = path.posix.dirname(file);
        while (directory !== '.') {
            if (this.context.directoryInventory?.has(directory) && !this.projects.sources.directoryExists(directory))
                return 'excluded';
            directory = path.posix.dirname(directory);
        }
        return 'missing';
    }
    private outlined(symbol: RustSymbol, attrs: RustAttributes, seen: Set<string>): RustResolution {
        const scope = symbol.scope, item = symbol.fact!, base = attrs.path !== undefined ? rustPath(scope.pathBase, attrs.path) : undefined;
        if (attrs.path !== undefined && !base)
            return failure('excluded', 'Original Rust module path escapes the repository or is nonportable');
        if (scope.fact.kind === 'block' && attrs.path === undefined)
            return failure('unsupported', 'An outlined block-local module requires an original path attribute');
        const choices = attrs.path !== undefined ? [base!] : [path.posix.join(scope.directory, item.name + '.rs'), path.posix.join(scope.directory, item.name, 'mod.rs')];
        const found = choices.filter(file => this.existence(file) !== 'missing');
        if (found.length > 1)
            return { status: 'ambiguous', candidates: found, reason: 'Both Rust module filename candidates are present or denied; no source may win' };
        if (!found.length)
            return failure('unresolved', 'Original mod declaration has no indexed source file');
        const selected = found[0]!, file = this.context.files.get(selected), syntax = this.syntax(selected);
        if (this.existence(selected) === 'excluded' || !file)
            return failure('excluded', 'Original Rust module source is pruned/unavailable/a symlink');
        if (!syntax?.complete)
            return failure('unsupported', 'Original Rust module syntax is unavailable/incomplete');
        const key = scope.compilation.id + ':' + selected;
        if (seen.has(key) || this.loading.has(key))
            return failure('unsupported', 'Cyclic Rust module file inclusion');
        const inherited = new Set(seen);
        inherited.add(scope.compilation.id + ':' + scope.file.path);
        this.loading.add(key);
        try {
            const root = syntax.scopes.find(s => s.kind === 'file')!, directory = path.posix.basename(selected) === 'mod.rs' ? path.posix.dirname(selected) : path.posix.join(path.posix.dirname(selected), path.posix.basename(selected, '.rs'));
            const child = this.load(scope.compilation, file, root, scope, [...scope.logicalPath, item.name], directory, symbol.active, symbol.gaps, inherited);
            child.moduleParent = scope.module;
            symbol.module = child;
            const proof = [...symbol.proof, ...this.proof(selected, 1, 'Original outlined Rust module source')];
            return { status: 'resolved', symbols: [symbol], proof, conditions: unique([...symbol.gaps, ...child.gaps, ...symbol.active === 'unknown' ? ['Unselected Rust module cfg'] : []]) };
        }
        finally {
            this.loading.delete(key);
        }
    }
    private ancestor(scope: RustScope, target: RustScope): boolean { for (let s: RustScope | undefined = scope; s; s = s.moduleParent)
        if (s.id === target.id)
            return true; return false; }
    private boundary(symbol: RustSymbol): RustScope | undefined {
        const scope = symbol.scope.module, visibility = symbol.visibility;
        if (visibility === 'pub')
            return;
        if (visibility === 'private' || visibility === 'pub(self)')
            return scope;
        if (visibility === 'pub(crate)')
            return this.roots.get(scope.compilation.id) ?? this.scopes.find(s => s.compilation.id === scope.compilation.id && !s.parent);
        if (visibility === 'pub(super)')
            return scope.moduleParent;
        const restricted = /^pub\(in(.+)\)$/.exec(visibility);
        if (!restricted)
            return scope;
        const parts=restricted[1]!.split('::').map(rustName),first=parts[0];
        if(scope.compilation.target.package.edition!=='2015'&&!['crate','self','super'].includes(first!))return;
        const target=first==='crate'||scope.compilation.target.package.edition==='2015'&&!['self','super'].includes(first!)?[]:[...scope.logicalPath];
        for(const [index,part]of parts.entries()){if(index===0&&['crate','self'].includes(part))continue;if(part==='super'){if(!target.length)return;target.pop();}else if(part==='crate'||part==='self')return;else target.push(part);}
        for(let ancestor:RustScope|undefined=scope;ancestor;ancestor=ancestor.moduleParent)if(JSON.stringify(ancestor.logicalPath)===JSON.stringify(target))return ancestor;
    }
    visible(symbol: RustSymbol, from: RustScope): boolean {
        if (symbol.active === false)
            return false;
        if (symbol.visibility === 'pub')
            return true;
        if (symbol.scope.compilation.id !== from.compilation.id)
            return false;
        const boundary = this.boundary(symbol);
        return !!boundary && this.ancestor(from.module, boundary);
    }
    private value(symbol: RustSymbol): RustResolution {
        if (symbol.external)
            return { status: 'external', dependency: symbol.external.dependency, crate: symbol.external.name, path: symbol.external.path, proof: symbol.proof, conditions: symbol.gaps };
        return { status: 'resolved', symbols: [symbol], proof: symbol.proof, conditions: unique([...symbol.gaps, ...symbol.active === 'unknown' ? ['Unselected Rust item cfg'] : []]) };
    }
    private combine(values: RustResolution[]): RustResolution {
        const bad = values.filter(v => v.status !== 'resolved' && v.status !== 'external');
        if (bad.length)
            return bad[0]!;
        const external = values.filter((v): v is Extract<RustResolution, {
            status: 'external';
        }> => v.status === 'external');
        if (external.length) {
            if (values.length !== 1)
                return { status: 'ambiguous', candidates: external.map(v => v.crate + '::' + v.path.join('::')), reason: 'Competing external/source Rust namespace bindings' };
            return external[0]!;
        }
        const resolved = values.filter((v): v is Extract<RustResolution, {
            status: 'resolved';
        }> => v.status === 'resolved'), symbols = unique(resolved.flatMap(v => v.symbols));
        for (let i = 0; i < symbols.length; i++)
            for (const other of symbols.slice(i + 1))
                if (symbols[i]!.id !== other.id && symbols[i]!.namespaces.some(ns => other.namespaces.includes(ns)))
                    return { status: 'ambiguous', candidates: symbols.map(s => s.id), reason: 'Competing Rust declarations in the same namespace' };
        if (!symbols.length)
            return failure('unresolved', 'Rust name has no accessible original binding');
        return { status: 'resolved', symbols, proof: resolved.flatMap(v => v.proof), conditions: unique(resolved.flatMap(v => v.conditions)) };
    }
    private importKey(site: RustImportSite): string { return site.scope.id + ':' + site.index; }
    resolve(site: RustImportSite, trail = new Set<string>()): RustResolution {
        if (site.active === false)
            return failure('excluded', 'Original Rust import is inactive under recorded cfg');
        const key = this.importKey(site), cached = this.resolved.get(key);
        if (cached && trail.size === 0)
            return cached;
        if (trail.has(key) || trail.size > 128)
            return failure('unsupported', 'Cyclic/budgeted Rust import or re-export lookup');
        const next = new Set(trail);
        next.add(key);
        const result = site.fact.kind === 'extern' ? site.fact.segments[0] === 'self' ? this.rootValue(site.scope) : this.external(site.scope, site.fact.segments[0]!, true) : this.path(site.scope, site.fact.segments, site.fact.absolute, next);
        let selected = result;
        if (site.fact.selfOnly && selected.status === 'resolved') {
            const symbols = selected.symbols.filter(s => s.namespaces.includes('type'));
            selected = symbols.length ? { ...selected, symbols } : failure('unsupported', 'Rust self imports require an original type namespace binding');
        }
        if (site.fact.glob) {
            if (selected.status === 'external')
                selected = { ...selected, conditions: unique([...selected.conditions, 'Binary Rust glob exports are unavailable']) };
            else if (selected.status === 'resolved')
                selected = this.glob(selected.symbols, site.scope, next);
        }
        if (selected.status === 'resolved' || selected.status === 'external')
            selected = { ...selected, proof: [...this.proof(site.scope.file.path, site.fact.range.startLine, `Original Rust ${site.fact.kind} ${site.fact.specifier}`), ...selected.proof], conditions: unique([...selected.conditions, ...site.gaps, ...site.active === 'unknown' ? ['Unselected Rust import cfg'] : [], ...selected.status === 'resolved' ? selected.symbols.flatMap(symbol => this.exportGaps(site, symbol)) : []]) };
        if (trail.size === 0)
            this.resolved.set(key, selected);
        return selected;
    }
    private exportGaps(site: RustImportSite, symbol: RustSymbol): string[] {
        const boundary = this.boundary(symbol), exportBoundary = this.boundary({ ...symbol, scope: site.scope, visibility: site.fact.visibility });
        return site.fact.visibility === 'pub' && symbol.visibility !== 'pub' || boundary && exportBoundary && !this.ancestor(exportBoundary, boundary) ? ['Rust re-export exceeds the original item visibility'] : [];
    }
    private binding(site: RustImportSite, result: RustResolution): RustSymbol[] {
        const fact = site.fact;
        if (fact.alias === '_')
            return [];
        if (result.status === 'external')
            return [{ id: this.context.graph.id('rust-external-binding', this.importKey(site)), name: fact.alias ?? fact.segments.at(-1)!, namespaces: ['type', 'value', 'macro'], scope: site.scope, visibility: fact.visibility, active: site.active, gaps: result.conditions, proof: result.proof, external: { dependency: result.dependency, name: result.crate, path: result.path } }];
        if (result.status !== 'resolved')
            return [];
        return result.symbols.map(symbol => {
            const gaps = unique([...result.conditions, ...this.exportGaps(site, symbol)]);
            return { ...symbol, name: fact.glob ? symbol.name : fact.alias ?? fact.segments.at(-1)!, originalScope: symbol.originalScope ?? symbol.scope, originalVisibility: symbol.originalVisibility ?? symbol.visibility, scope: site.scope, visibility: fact.visibility, active: rustAnd([symbol.active, site.active]), gaps, proof: result.proof };
        });
    }
    private lookup(scope: RustScope, name: string, from: RustScope, trail: Set<string>): RustResolution {
        const own = scope.items.filter(s => s.name === name && s.active !== false && this.visible(s, from));
        const explicit = scope.imports.filter(site => !site.fact.glob && site.fact.alias !== '_' && (site.fact.alias ?? site.fact.segments.at(-1)) === name && site.active !== false && !trail.has(this.importKey(site)));
        const groups = explicit.map(site => this.binding(site, this.resolve(site, trail)).filter(s => this.visible(s, from))), bindings = groups.flat();
        if (own.length || explicit.length) {
            if (groups.some((group, index) => groups.slice(index + 1).some(other => group.some(a => other.some(b => a.namespaces.some(ns => b.namespaces.includes(ns)))))))
                return { status: 'ambiguous', candidates: bindings.map(s => s.id), reason: 'Competing explicit Rust import bindings in the same namespace' };
            if (bindings.length || own.length)
                return this.combine([...own, ...bindings].map(s => this.value(s)));
            const result = explicit.length ? this.resolve(explicit[0]!, trail) : undefined;
            return result && result.status !== 'resolved' && result.status !== 'external' ? result : failure('unresolved', 'Rust name is inaccessible');
        }
        const values: RustResolution[] = [];
        for (const site of scope.imports.filter(site => site.fact.glob && site.active !== false && !trail.has(this.importKey(site)))) {
            const result = this.resolve(site, trail);
            if (result.status === 'external')
                values.push(failure('unsupported', 'External Rust glob may supply this name; original exports are unavailable'));
            else if (result.status === 'resolved')
                for (const symbol of this.binding(site, result).filter(s => s.name === name && this.visible(s, from)))
                    values.push(this.value(symbol));
            else if (result.status === 'unsupported')
                values.push(result);
        }
        return values.length ? this.combine(values) : failure('unresolved', `No original Rust binding for ${name}`);
    }
    private rootValue(scope: RustScope): RustResolution {
        const root = this.roots.get(scope.compilation.id) ?? this.scopes.find(s => s.compilation.id === scope.compilation.id && !s.parent);
        if (!root)
            return failure('unsupported', 'Original Rust crate root is unavailable');
        return this.value({ id: root.file.id, name: 'crate', namespaces: ['type'], scope: root, visibility: 'pub', active: root.active, gaps: root.gaps, proof: scope.compilation.proof, module: root });
    }
    private external(scope: RustScope, name: string, explicit = false, trail = new Set<string>()): RustResolution {
        const root = this.roots.get(scope.compilation.id) ?? this.scopes.find(s => s.compilation.id === scope.compilation.id && !s.parent), noPrelude = this.noPrelude(scope);
        if (!explicit && !noPrelude && scope.compilation.target.package.edition !== '2015') {
            const declared = root?.imports.filter(site => site.fact.kind === 'extern' && (site.fact.alias ?? site.fact.segments[0]) === name && site.active !== false) ?? [];
            if (declared.length)
                return this.combine(declared.map(site => this.resolve(site, trail)));
        }
        if (!explicit && noPrelude)
            return failure('unresolved', 'Original no_implicit_prelude disables the Rust extern prelude');
        const entry = scope.compilation.dependencies.get(name);
        if (entry) {
            if (entry.active === false)
                return failure('excluded', 'Original Cargo dependency is inactive');
            if (entry.gaps.length)
                return failure('unsupported', entry.gaps.join('; '));
            const conditions = unique([...scope.compilation.gaps, ...entry.active === 'unknown' ? ['Unselected Cargo dependency activation'] : []]);
            if (entry.compilation) {
                const root = this.root(entry.compilation);
                if (!root)
                    return failure('excluded', 'Original dependency library crate root is unavailable');
                const value = this.rootValue(root);
                return value.status === 'resolved' ? { ...value, proof: [...entry.dependency.proof, ...value.proof], conditions: unique([...value.conditions, ...conditions]) } : value;
            }
            return { status: 'external', dependency: entry.dependency.package, crate: name, path: [], proof: entry.dependency.proof, conditions };
        }
        const allowed = explicit ? ['std', 'core', 'alloc', 'proc_macro'].includes(name) : !noPrelude && (name === 'std' && !root?.attributes.noStd || name === 'core' && (scope.compilation.target.package.edition !== '2015' || root?.attributes.noStd));
        if (allowed && !root?.attributes.noCore)
            return { status: 'external', dependency: 'rust-standard-library', crate: name, path: [], proof: this.proof(scope.file.path, scope.fact.range.startLine, `Reviewed Rust ${name} ${explicit ? 'explicit extern crate' : 'extern/standard prelude'} identity; exports are not synthesized`), conditions: scope.compilation.gaps };
        return failure('unresolved', `No original Cargo/extern crate identity for ${name}`);
    }
    private noPrelude(scope: RustScope): boolean { for (let s: RustScope | undefined = scope; s; s = s.parent)
        if (s.attributes.noPrelude)
            return true; return false; }
    path(scope: RustScope, segments: string[], absolute = false, trail = new Set<string>(),mode:'import'|'expression'='import'): RustResolution {
        if (!segments.length)
            return failure('unresolved', 'Empty Rust path');
        if (segments.includes('Self') || segments.includes('$crate'))
            return failure('unsupported', 'Associated/generic/macro-hygienic Rust use path is unreviewed');
        let index = 0, result: RustResolution;
        const first = segments[0]!;
        if (absolute && scope.compilation.target.package.edition !== '2015')
            result = this.external(scope, first, false, trail), index++;
        else if (first === 'crate') {
            result = this.rootValue(scope);
            index++;
        }
        else if (first === 'self') {
            const module = scope.module;
            result = this.value({ id: module.file.id, name: 'self', namespaces: ['type'], scope: module, visibility: 'pub', active: module.active, gaps: module.gaps, proof: [], module });
            index++;
        }
        else if (first === 'super') {
            let module: RustScope | undefined = scope.module;
            while (segments[index] === 'super') {
                module = module?.moduleParent;
                index++;
            }
            if (!module)
                return failure('unresolved', 'Rust super path escapes its crate root');
            result = this.value({ id: module.file.id, name: 'super', namespaces: ['type'], scope: module, visibility: 'pub', active: module.active, gaps: module.gaps, proof: [], module });
        }
        else {
            const root = this.roots.get(scope.compilation.id) ?? this.scopes.find(s => s.compilation.id === scope.compilation.id && !s.parent);
            let current: RustScope | undefined = absolute || mode==='import'&&scope.compilation.target.package.edition === '2015' ? root : scope;
            result = failure('unresolved', `Rust path head ${first} is unavailable`);
            while (current) {
                result = this.lookup(current, first, scope, trail);
                if (result.status !== 'unresolved')
                    break;
                if (['file', 'module'].includes(current.fact.kind))
                    break;
                current = current.parent;
            }
            if (result.status === 'unresolved' && !this.noPrelude(scope) && (scope.compilation.target.package.edition !== '2015' || first === 'std' || first === 'core'))
                result = this.external(scope, first, false, trail);
            index++;
        }
        for (; index < segments.length; index++) {
            const name = segments[index]!;
            if (result.status === 'external') {
                result = { ...result, path: [...result.path, name] };
                continue;
            }
            if (result.status !== 'resolved')
                return result;
            const owners = result.symbols.filter(symbol => symbol.module);
            if (!owners.length)
                return failure('unsupported', 'Rust associated items cannot be imported; only modules/enum variants are qualified');
            const values = owners.map(owner => this.lookup(owner.module!, name, scope, trail)), next = this.combine(values);
            result = next.status === 'resolved' || next.status === 'external' ? { ...next, proof: [...result.proof, ...next.proof], conditions: unique([...result.conditions, ...next.conditions]) } : next;
        }
        return result;
    }
    private names(scope: RustScope, seen: Set<string>): string[] {
        if (seen.has(scope.id) || seen.size > 128)
            return [];
        const next = new Set(seen);
        next.add(scope.id);
        const names = scope.items.filter(item => item.active !== false).map(item => item.name);
        for (const site of scope.imports.filter(site => site.active !== false))
            if (!site.fact.glob && site.fact.alias !== '_')
                names.push(site.fact.alias ?? site.fact.segments.at(-1)!);
            else if (site.fact.glob) {
                const owner = this.path(site.scope, site.fact.segments, site.fact.absolute, new Set([this.importKey(site)]));
                if (owner.status === 'resolved')
                    for (const symbol of owner.symbols)
                        if (symbol.module)
                            names.push(...this.names(symbol.module, next));
            }
        return unique(names).sort();
    }
    private glob(owners: RustSymbol[], from: RustScope, trail: Set<string>): RustResolution {
        if (owners.some(owner => !owner.module))
            return failure('unsupported', 'Rust glob requires a module or enum');
        const values: RustResolution[] = [];
        for (const owner of owners)
            for (const name of this.names(owner.module!, new Set())) {
                const value = this.lookup(owner.module!, name, from, trail);
                if (value.status === 'resolved' || value.status === 'external')
                    values.push(value);
                else if (value.status !== 'unresolved')
                    return value;
            }
        // Empty original export sets are a valid source glob, without fabricated symbols.
        if (!values.length)
            return { status: 'resolved', symbols: [], proof: owners.flatMap(owner => owner.proof), conditions: unique(owners.flatMap(owner => owner.gaps)) };
        const symbols: RustSymbol[] = [], proof: Evidence[] = [], conditions: string[] = [];
        for (const value of values) {
            if (value.status === 'external')
                return failure('unsupported', 'Rust source glob includes unreviewed binary re-exports');
            if (value.status === 'resolved') {
                symbols.push(...value.symbols);
                proof.push(...value.proof);
                conditions.push(...value.conditions);
            }
        }
        return { status: 'resolved', symbols: unique(symbols), proof, conditions: unique([...conditions, ...owners.flatMap(owner => owner.gaps)]) };
    }
}
