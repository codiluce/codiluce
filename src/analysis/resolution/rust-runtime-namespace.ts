import { subset } from 'semver';
import type { AnalysisContext } from '../../core/analyzer.js';
import { evidence, type Evidence } from '../../core/graph.js';
import type { RustItemFact, RustSyntaxFacts } from '../facts.js';
import { rustAttributes, rustCfg, rustEmptyTokenTree, rustSplit, rustString } from '../languages/rust-cfg.js';
import { cargoRequirement } from './rust-projects.js';
import { RustDeriveNamespaces } from './rust-derive-namespace.js';
import { RustResolver, RUST_RESOLVER_VERSION, type RustScope, type RustNamespaceAttributes } from './rust.js';

const key = (scope: RustScope, item: RustItemFact) => JSON.stringify([scope.compilation.id, scope.file.path, scope.fact.key, item.key]);
const generationGap = (condition: string) => condition.startsWith('Unreviewed Rust attribute');
type Macro = NonNullable<RustSyntaxFacts['macros']>[number];

/** Standard formatting syntax can have runtime effects while still supplying
 * no crate exports. Arguments containing macros/attributes/items stay opaque. */
function standardNamespaceMacro(base: RustResolver, scope: RustScope, macro: Macro): Evidence[] | undefined {
    if (macro.tokens.length > 8192) return;
    const names = ['println', 'eprintln', 'format'], result = base.path(scope, macro.path, macro.absolute, new Set(), 'expression');
    const allowed = (condition: string) => generationGap(condition) || condition === 'Rust macro invocation can supply generated/scoped items; expansion is unavailable';
    let proof: Evidence[], name: string;
    if (result.status === 'external' && result.dependency === 'rust-standard-library' && result.crate === 'std' && names.includes(result.path.join('::')) && result.conditions.every(allowed)) { proof = result.proof; name = result.path[0]!; }
    else if (result.status === 'unresolved' && !macro.absolute && macro.path.length === 1 && names.includes(macro.path[0]!)) {
        for (let current: RustScope | undefined = scope; current; current = current.parent) {
            if (current.attributes.noPrelude || current.attributes.noStd || current.attributes.noCore || current.imports.some(site => site.active !== false && site.fact.attributes.some(attribute => /^#!?\[\s*macro_use\b/.test(attribute)))) return;
            if (current.items.some(item => item.name === macro.path[0] && item.active !== false) || current.imports.some(site => site.active !== false && !site.fact.glob && (site.fact.alias ?? site.fact.segments.at(-1)) === macro.path[0])) return;
            for (const site of current.imports.filter(site => site.active !== false && site.fact.glob)) {
                const imported = base.resolve(site);
                if (imported.status !== 'resolved' || imported.conditions.some(condition => !allowed(condition))) return;
            }
        }
        const standard = base.path(scope, ['std'], false, new Set(), 'expression');
        if (standard.status !== 'external' || standard.dependency !== 'rust-standard-library' || standard.crate !== 'std' || standard.conditions.some(condition => !allowed(condition))) return;
        proof = standard.proof; name = macro.path[0]!;
    } else return;
    const args = rustSplit(macro.tokens.slice(1, -1));
    if (rustEmptyTokenTree(macro.tokens) && name !== 'format')
        return [...proof, { ...evidence('syntax', 'rust-imports', scope.file.path, macro.range.startLine, 'Original empty standard print macro: namespace only; newline output and runtime I/O remain unreviewed'), analyzerVersion: RUST_RESOLVER_VERSION, endLine: macro.range.endLine }];
    if (!args?.length || args.length > 128 || rustString(args[0]!) === undefined) return;
    for (const argument of args.slice(1)) {
        if (rustString(argument) !== undefined) continue;
        if (!/^[\p{ID_Continue}\s:.()\[\]+\-*/%&|^<>=,?]+$/u.test(argument) || /\b(?:fn|mod|struct|enum|union|trait|impl|macro_rules|extern|use|let|const|static)\b/.test(argument)) return;
    }
    return [...proof, { ...evidence('syntax', 'rust-imports', scope.file.path, macro.range.startLine, 'Original standard formatting macro with bounded item/attribute/macro-free operands: namespace only; formatting and runtime effects remain unreviewed'), analyzerVersion: RUST_RESOLVER_VERSION, endLine: macro.range.endLine }];
}

/** Canonical runtime macros can preserve the containing module's namespace
 * without preserving an async signature or qualifying the generated body. */
function runtime(base: RustResolver, scope: RustScope, attribute: string): { framework: string; proof: Evidence[] } | undefined {
    const text = attribute.replace(/^#!?\[/, '').replace(/\]$/, '').trim(), match = /^([\w:]+)(?:\s*\(([\s\S]*)\))?$/.exec(text);
    if (!match) return;
    const result = base.path(scope, match[1]!.split('::').filter(Boolean), match[1]!.startsWith('::'), new Set(), 'expression');
    if (result.status !== 'external' || result.path.join('::') !== 'main' || result.conditions.some(condition => !generationGap(condition))) return;
    const entry = scope.compilation.dependencies.get(result.crate), dep = entry?.dependency;
    if (!entry || !dep || entry.active !== true || entry.compilation || entry.gaps.length || dep.gaps.length || dep.scope === 'build' || dep.source !== 'registry' || dep.sourceId !== 'crates-io' || dep.package !== result.dependency) return;
    const selected = dep.version && cargoRequirement(dep.version), family = dep.package === 'tokio' ? '>=1.0.0 <2.0.0' : dep.package === 'actix-web' ? '>=4.0.0 <5.0.0' : dep.package === 'rocket' ? '>=0.5.0 <0.6.0' : undefined;
    if (!selected || !family || !subset(selected, family)) return;
    const args = rustSplit(match[2] ?? ''), features = new Set([...dep.features, ...scope.compilation.dependencyFeatures.get(dep.name) ?? []]);
    if (!args) return;
    if (dep.package === 'tokio') {
        if (!(features.has('macros') || features.has('full')) || !['rt', 'rt-multi-thread', 'full'].some(feature => features.has(feature))) return;
        if (args.some(arg => !/^(?:flavor\s*=\s*"(?:multi_thread|current_thread)"|worker_threads\s*=\s*[1-9]\d*)$/.test(arg))) return;
        const names = args.map(arg => arg.split('=')[0]!.trim()), current = args.some(arg => /flavor\s*=\s*"current_thread"/.test(arg));
        if (new Set(names).size !== names.length || current && names.includes('worker_threads') || !current && !['rt-multi-thread', 'full'].some(feature => features.has(feature))) return;
        if (args.some(arg => arg.startsWith('worker_threads') && (!Number.isSafeInteger(Number(arg.split('=')[1])) || Number(arg.split('=')[1]) > 0xffffffff))) return;
    } else if (args.length) return;
    if (dep.package === 'actix-web') {
        if (!dep.defaultFeatures && !features.has('macros')) return;
        // actix-web emits another attribute at this absolute path. A renamed-
        // only or shadowed crate must not lend that macro an identity.
        const delegated = base.path(scope, ['actix_web'], true, new Set(), 'expression');
        if (delegated.status !== 'external' || delegated.dependency !== 'actix-web' || delegated.crate !== result.crate || delegated.conditions.some(condition => !generationGap(condition))) return;
    }
    return { framework: dep.package, proof: [...result.proof, ...dep.proof] };
}

function review(base: RustResolver, scope: RustScope, item: RustItemFact): RustNamespaceAttributes | undefined {
    if (item.kind !== 'function' || !['file', 'module'].includes(scope.fact.kind)) return;
    const syntax = base.syntax(scope.file.path), definition = syntax?.semantic?.definitions.find(fact => fact.key === item.key);
    if (!syntax?.complete || !syntax.semantic?.complete || !definition?.async || !definition.body || definition.gaps.length) return;
    const body = syntax.scopes.find(fact => fact.key === definition.body), inner = body && rustAttributes(body.attributes.filter(attribute => !item.attributes.includes(attribute)), scope.compilation.environment);
    // Tokio and syn-based wrappers can lift these attributes onto the function.
    if (!inner || inner.active !== true || inner.namespaceGaps.length || inner.path !== undefined || inner.noStd || inner.noCore || inner.noPrelude || inner.macroExport) return;
    const retained: string[] = [], proofs: Evidence[] = [], known: string[] = [];
    const source = base.projects.sources.readFile(scope.file.path) ?? '';
    const filter = (attribute: string, original: string, depth = 0): string[] => {
        if (depth > 32) return [attribute];
        const text = attribute.replace(/^#!?\[/, '').replace(/\]$/, '').trim(), conditional = /^cfg_attr\s*\(([\s\S]*)\)$/.exec(text);
        if (conditional) {
            const args = rustSplit(conditional[1]!);
            if (args && args.length >= 2 && rustCfg(args[0]!, scope.compilation.environment) === true)
                return args.slice(1).flatMap(arg => filter(arg, original, depth + 1));
        }
        const selected = runtime(base, scope, attribute);
        if (!selected || selected.framework === 'rocket' && definition.parameters.length || item.name === 'main' && definition.parameters.length) return [attribute];
        const start = source.lastIndexOf(original, item.start);
        if (start < scope.fact.start || start < 0) return [attribute];
        const line = source.slice(0, start).split('\n').length;
        known.push(selected.framework);
        proofs.push(...selected.proof, { ...evidence('syntax', 'rust-imports', scope.file.path, line, `Original ${selected.framework} main attribute on ${item.name}: reviewed containing-module namespace only; generated function signature/body remain unreviewed`), analyzerVersion: RUST_RESOLVER_VERSION, endLine: line + original.split('\n').length - 1 });
        return [];
    };
    for (const attribute of item.attributes) retained.push(...filter(attribute, attribute));
    // Composed wrappers can change one another's input and error output.
    if (known.length !== 1) return;
    return { attributes: rustAttributes(retained, scope.compilation.environment), proof: proofs };
}

/** A macro in a different original block can export names at the crate root.
 * Review the selected compilation's inputs, rather than trusting one body. */
function namespaceInputs(base: RustResolver, compilation: string, reviews: Map<string, RustNamespaceAttributes>): Evidence[] | undefined {
    const proof: Evidence[] = [];
    if (base.modules.some(site => site.scope.compilation.id === compilation && site.active !== false && (site.active !== true || site.result.status !== 'resolved'))) return;
    for (const scope of base.scopes.filter(scope => scope.compilation.id === compilation && scope.active !== false)) {
        const syntax = base.syntax(scope.file.path);
        if (scope.active !== true || !syntax?.complete || !syntax.semantic?.complete) return;
        const owner = scope.fact.owner && syntax.items.find(item => item.key === scope.fact.owner);
        const attrs = rustAttributes(scope.fact.attributes.filter(attribute => !owner || !owner.attributes.includes(attribute)), scope.compilation.environment);
        if (attrs.namespaceGaps.length) return;
        for (const item of syntax.items.filter(item => item.scope === scope.fact.key)) {
            const selected = reviews.get(key(scope, item))?.attributes ?? rustAttributes(item.attributes, scope.compilation.environment);
            if (selected.active !== false && (selected.namespaceGaps.length || item.kind === 'module' && selected.gaps.length)) return;
        }
        for (const site of scope.imports) {
            const selected = rustAttributes(site.fact.attributes, scope.compilation.environment);
            if (selected.active !== false && selected.namespaceGaps.length) return;
        }
        for (const macro of syntax.macros?.filter(macro => macro.scope === scope.fact.key) ?? []) {
            const selected = rustAttributes(macro.attributes, scope.compilation.environment);
            if (selected.active === false) continue;
            if (selected.active !== true || selected.gaps.length) return;
            const native = standardNamespaceMacro(base, scope, macro);
            if (!native) return;
            proof.push(...native);
        }
    }
    return proof;
}

/** Discover identities conservatively first, then replay only pre-reviewed
 * namespace facts. No binary, macro, compiler or target code executes. */
export function sourceRustResolver(context: AnalysisContext): RustResolver {
    const base = new RustResolver(context), derives = new RustDeriveNamespaces(base), reviews = new Map<string, RustNamespaceAttributes>(), deriveReviews = new Map<string, RustNamespaceAttributes>();
    for (const scope of base.scopes)
        for (const item of base.syntax(scope.file.path)?.items.filter(item => item.scope === scope.fact.key && item.attributes.length) ?? []) {
            const selected = review(base, scope, item);
            if (selected) reviews.set(key(scope, item), selected);
            const derive = derives.read(item,scope);
            if (derive) deriveReviews.set(key(scope,item),derive);
        }
    const allReviews = new Map([...reviews,...deriveReviews]);
    const inputs = new Map<string, Evidence[] | undefined>();
    for (const [id, selected] of reviews) {
        const compilation = JSON.parse(id)[0] as string;
        if (!inputs.has(compilation)) inputs.set(compilation, namespaceInputs(base, compilation, allReviews));
        const proof = inputs.get(compilation);
        if (proof) selected.proof.push(...proof);
        else reviews.delete(id);
    }
    return reviews.size || deriveReviews.size ? new RustResolver(context, undefined, undefined, (item, scope) => deriveReviews.get(key(scope,item)) ?? reviews.get(key(scope, item))) : base;
}
