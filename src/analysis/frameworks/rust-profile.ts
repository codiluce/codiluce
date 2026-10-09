import { subset } from 'semver';
import type { Evidence } from '../../core/graph.js';
import { evidence } from '../../core/graph.js';
import type { RustScope, RustResolver, RustResolution } from '../resolution/rust.js';
import { cargoRequirement, type RustCompilation } from '../resolution/rust-projects.js';
import { rustAttributes, rustCfg, rustSplit, rustString } from '../languages/rust-cfg.js';
import type { RustRouteDialect } from '../routes/rust-patterns.js';
import type { RustScopeFact } from '../facts.js';
import { warpPathSyntax } from './warp-syntax.js';
export const RUST_ROUTER_VERSION = '3';
export interface RustWebProfile {
    framework: 'axum' | 'actix-web' | 'tokio' | 'rocket' | 'warp';
    dialect?: RustRouteDialect;
    path: string[];
    proof: Evidence[];
    conditions: string[];
    macros: boolean;
    server?: boolean;
    generics?: string[];
}
/** Canonical external registry identity under original Cargo selections. A
 * lookalike local package, fork or requirement crossing native syntax families
 * cannot activate these contracts. No restored binaries are inspected. */
export function rustWebProfile(scope: RustScope, result: RustResolution): RustWebProfile | undefined {
    if (result.status !== 'external' || !['axum', 'actix-web', 'tokio', 'rocket', 'warp'].includes(result.dependency))
        return;
    const candidates = [...scope.compilation.dependencies.values()].filter(entry => entry.dependency.package === result.dependency && entry.dependency.name.replaceAll('-', '_') === result.crate);
    if (candidates.length !== 1)
        return;
    const entry = candidates[0]!, dep = entry.dependency, framework = dep.package as RustWebProfile['framework'];
    const conditions = [...result.conditions, ...entry.gaps, ...dep.gaps];
    if (dep.source !== 'registry' || dep.sourceId && dep.sourceId !== 'crates-io')
        conditions.push('Rust web contracts require the canonical crates.io registry package');
    if (entry.active !== true || dep.scope === 'build')
        conditions.push('Rust web dependency activation/runtime selection is unproven');
    const requirement = dep.version && cargoRequirement(dep.version);
    const within = (range: string) => !!requirement && subset(requirement, range);
    const dialect = framework === 'axum' ? within('>=0.7.0 <0.8.0') ? 'axum-0.7' : within('>=0.8.0 <0.9.0') ? 'axum-0.8' : undefined : framework === 'actix-web' && within('>=4.0.0 <5.0.0') ? 'actix-web-4' : framework === 'rocket' && within('>=0.5.0 <0.6.0') ? 'rocket-0.5' : framework === 'warp' ? within('>=0.3.0 <0.4.0') ? 'warp-0.3' : within('>=0.4.0 <0.5.0') ? 'warp-0.4' : undefined : undefined;
    if (framework === 'tokio' ? !within('>=1.0.0 <2.0.0') : !dialect)
        conditions.push('Rust web requirement crosses or lacks a reviewed native version family');
    const features = new Set([...dep.features, ...scope.compilation.dependencyFeatures.get(dep.name) ?? []]);
    const macros = framework === 'rocket' || framework === 'warp' || (framework === 'actix-web' ? dep.defaultFeatures || features.has('macros') : framework === 'tokio' ? (features.has('macros') || features.has('full')) && (features.has('rt') || features.has('rt-multi-thread') || features.has('full')) : false);
    return { framework, dialect, path: result.path, macros, ...framework === 'warp' ? { server: dialect === 'warp-0.3' || features.has('server') } : {}, conditions: [...new Set(conditions)], proof: [...result.proof, ...dep.proof, { ...evidence('framework', 'rust-routers', scope.compilation.target.package.manifest, 1, `Original registry ${dep.package} requirement ${dep.version ?? '(absent)'}; reviewed native ${dialect ?? framework + '-1'} contract, without executing dependency code`), analyzerVersion: RUST_ROUTER_VERSION }] };
}
export interface RustWebAttribute {
    kind: 'runtime' | 'route' | 'launch';
    framework: 'actix-web' | 'tokio' | 'rocket';
    path?: string;
    methods?: string[];
    rank?: number;
    format?: string;
    data?: string;
    proof: Evidence[];
}
const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'CONNECT', 'TRACE'];
const rocketMacroNames = new Set(['get', 'put', 'post', 'delete', 'head', 'patch', 'options', 'route', 'routes', 'launch', 'main']);
const warpMacroNames = new Set(['path']);
function macroUseNames(text: string, exported = rocketMacroNames): string[] | undefined {
    if (text === 'macro_use')
        return [...exported];
    const match = /^macro_use\s*\(([\s\S]*)\)$/.exec(text), names = match && rustSplit(match[1]!);
    return names?.length && names.every(name => exported.has(name)) && new Set(names).size === names.length ? names : undefined;
}
/** Exact original macro_use extern sites provide reviewed Rocket/Warp macros.
 * Local/source bindings and competing imports are never replaced. */
export function rustWebMacroResolution(base: RustResolver, scope: RustScope, path: string[], at = Infinity, absolute = false): RustResolution {
    const original = base.path(scope, path, absolute, new Set(), 'expression');
    if (original.status !== 'unresolved' || path.length !== 1 || absolute)
        return original;
    const candidates: RustResolution[] = [];
    for (let current: RustScope | undefined = scope; current; current = current.parent) {
        for (const site of current.imports) {
            if (site.fact.kind !== 'extern' || site.active !== true || site.scope.file.path === scope.file.path && site.fact.end > at)
                continue;
            const attrs = site.fact.attributes.map(attr => attr.replace(/^#!?\[/, '').replace(/\]$/, '').trim());
            const result = base.path(site.scope, [site.fact.alias ?? site.fact.segments[0]!], false, new Set(), 'expression'), profile = rustWebProfile(scope, result);
            const names = profile?.framework === 'rocket' && profile.dialect === 'rocket-0.5' ? rocketMacroNames : profile?.framework === 'warp' && profile.dialect?.startsWith('warp-') ? warpMacroNames : undefined;
            if (result.status === 'external' && names && attrs.some(attr => macroUseNames(attr,names)?.includes(path[0]!)) && profile!.conditions.every(gap => gap.startsWith('Unreviewed Rust attribute')))
                candidates.push({ ...result, path, proof: [...result.proof, { ...evidence('framework', 'rust-routers', site.scope.file.path, site.fact.range.startLine, `Original ${profile!.framework} macro_use extern declaration supplies this known macro name`), analyzerVersion: RUST_ROUTER_VERSION }] });
        }
    }
    return candidates.length === 1 ? candidates[0]! : candidates.length ? { status: 'ambiguous', candidates: candidates.map((_, i) => String(i)), reason: 'Competing original native macro_use imports' } : original;
}
export function rustWebAttribute(base: RustResolver, scope: RustScope, attribute: string, at = Infinity): RustWebAttribute | undefined {
    const text = attribute.replace(/^#!?\[/, '').replace(/\]$/, '').trim(), match = /^([\w:]+)(?:\s*\(([\s\S]*)\))?$/.exec(text);
    if (!match)
        return;
    const profile = rustWebProfile(scope, rustWebMacroResolution(base, scope, match[1]!.split('::').filter(Boolean), at, match[1]!.startsWith('::')));
    // The base resolver deliberately retains unknown attributes. Only those gaps
    // are ignored while identifying this exact native macro; all other gaps stay.
    if (!profile || profile.conditions.some(gap => !gap.startsWith('Unreviewed Rust attribute')) || !profile.macros)
        return;
    const name = profile.path.join('::'), args = rustSplit(match[2] ?? '');
    if (!args)
        return;
    if (profile.framework === 'rocket') {
        if (['main', 'launch'].includes(name) && !args.length)
            return { kind: name === 'launch' ? 'launch' : 'runtime', framework: 'rocket', proof: profile.proof };
        const generic = name === 'route', method = generic ? args[0] : name === name.toLowerCase() ? name.toUpperCase() : undefined;
        if (!method || !methods.includes(method) || !generic && ['CONNECT', 'TRACE'].includes(method))
            return;
        const first = generic ? /^uri\s*=\s*([\s\S]*)$/.exec(args[1] ?? '')?.[1] : args[0], path = first && rustString(first);
        if (path === undefined)
            return;
        const options: Pick<RustWebAttribute, 'rank' | 'format' | 'data'> = {}, seen = new Set<string>();
        for (const field of args.slice(generic ? 2 : 1)) {
            const selected = /^(rank|format|data)\s*=\s*([\s\S]*)$/.exec(field);
            if (!selected || seen.has(selected[1]!))
                return;
            seen.add(selected[1]!);
            if (selected[1] === 'rank') {
                const number = Number(selected[2]);
                if (!/^-?\d+$/.test(selected[2]!) || !Number.isSafeInteger(number) || number < -(2 ** 31) || number >= 2 ** 31)
                    return;
                options.rank = number;
            }
            else {
                const value = rustString(selected[2]!);
                if (value === undefined || !value.length)
                    return;
                if (selected[1] === 'format')
                    options.format = value;
                else {
                    if (!/^<[_\p{ID_Start}][_\p{ID_Continue}]*>$/u.test(value))
                        return;
                    options.data = value.slice(1, -1);
                }
            }
        }
        return { kind: 'route', framework: 'rocket', path, methods: [method], proof: profile.proof, ...options };
    }
    if (name === 'main' && ['tokio', 'actix-web'].includes(profile.framework)) {
        if (profile.framework === 'actix-web' && args.length || profile.framework === 'tokio' && args.some(arg => !/^(?:flavor\s*=\s*"(?:multi_thread|current_thread)"|worker_threads\s*=\s*[1-9]\d*)$/.test(arg)))
            return;
        const fields = args.map(arg => arg.split('=')[0]!.trim());
        if (new Set(fields).size !== fields.length || args.some(arg => /flavor\s*=\s*"current_thread"/.test(arg)) && fields.includes('worker_threads'))
            return;
        const dep = [...scope.compilation.dependencies.values()].find(entry => entry.dependency.name.replaceAll('-', '_') === (base.path(scope, match[1]!.split('::'), false, new Set(), 'expression') as Extract<RustResolution, {
            status: 'external';
        }>).crate)?.dependency;
        if (profile.framework === 'tokio' && !args.some(arg => /flavor\s*=\s*"current_thread"/.test(arg)) && dep && ![...dep.features, ...scope.compilation.dependencyFeatures.get(dep.name) ?? []].some(feature => ['rt-multi-thread', 'full'].includes(feature)))
            return;
        return { kind: 'runtime', framework: profile.framework as 'tokio' | 'actix-web', proof: profile.proof };
    }
    if (profile.framework !== 'actix-web' || args.length < 1)
        return;
    const path = rustString(args[0]!);
    if (path === undefined)
        return;
    if (name === name.toLowerCase() && methods.includes(name.toUpperCase()) && args.length === 1)
        return { kind: 'route', framework: 'actix-web', path, methods: [name.toUpperCase()], proof: profile.proof };
    if (name === 'route' && args.length > 1) {
        const selected = args.slice(1).map(arg => /^method\s*=\s*([\s\S]*)$/.exec(arg)).map(arg => arg && rustString(arg[1]!));
        if (selected.every((method): method is string => !!method && methods.includes(method)) && new Set(selected).size === selected.length)
            return { kind: 'route', framework: 'actix-web', path, methods: selected, proof: profile.proof };
    }
    return;
}
/** Framework-only resolver: exact recognized attribute sites preserve original
 * functions/bodies as reviewed framework syntax, without proc-macro expansion.
 * The general Rust resolver and its conservative call outcomes stay separate. */
export function rustWebAttributeReader(base: RustResolver) {
    const scopes = new Map(base.scopes.map(scope => [JSON.stringify([scope.compilation.id, scope.file.path, scope.fact.key]), scope]));
    return (attributes: string[], compilation: RustCompilation, file: string, key: string) => {
        const scope = scopes.get(JSON.stringify([compilation.id, file, key]));
        const filter = (attribute: string, depth = 0): string[] => {
            if (!scope || depth > 32)
                return [attribute];
            const text = attribute.replace(/^#!?\[/, '').replace(/\]$/, '').trim(), selected = /^cfg_attr\s*\(([\s\S]*)\)$/.exec(text);
            if (/^macro_use(?:\s*\([\s\S]*\))?$/.test(text)) {
                const site = scope.imports.find(site => site.fact.kind === 'extern' && site.fact.attributes.includes(attribute));
                if (site) {
                    const result = base.path(scope, [site.fact.alias ?? site.fact.segments[0]!], false, new Set(), 'expression'), profile = rustWebProfile(scope, result);
                    const names = profile?.framework === 'rocket' && profile.dialect === 'rocket-0.5' ? rocketMacroNames : profile?.framework === 'warp' && profile.dialect?.startsWith('warp-') ? warpMacroNames : undefined;
                    if (names && macroUseNames(text,names) && profile!.conditions.every(gap => gap.startsWith('Unreviewed Rust attribute')))
                        return [];
                }
            }
            if (selected) {
                const args = rustSplit(selected[1]!);
                if (args && args.length >= 2 && rustCfg(args[0]!, compilation.environment) === true)
                    return args.slice(1).flatMap(arg => filter(arg, depth + 1));
            }
            const at = base.syntax(file)?.items.find(item => item.attributes.includes(attribute))?.start;
            return rustWebAttribute(base, scope, attribute, at) ? [] : [attribute];
        };
        return rustAttributes(attributes.flatMap(attribute => filter(attribute)), compilation.environment);
    };
}
/** A single literal log 0.4 message is a reviewed item-neutral syntax contract.
 * Format operands, custom logger/target clauses and every other macro retain
 * their original expansion gap. This never expands or executes a macro. */
export class RustWebMacros {
    private readonly proofs = new Map<string, Evidence[]>();
    constructor(private readonly base: RustResolver) { }
    private key(compilation: RustCompilation, file: string, scope: string) { return JSON.stringify([compilation.id, file, scope]); }
    read = (fact: RustScopeFact, compilation: RustCompilation, file: string): string[] => {
        const gap = 'Rust macro invocation can supply generated/scoped items; expansion is unavailable';
        if (!fact.gaps.includes(gap))
            return fact.gaps;
        if (['file', 'module', 'impl', 'trait', 'enum'].includes(fact.kind))
            return fact.gaps;
        const scope = this.base.scopes.find(scope => scope.compilation.id === compilation.id && scope.file.path === file && scope.fact.key === fact.key), macros = this.base.syntax(file)?.macros?.filter(macro => macro.scope === fact.key);
        if (!scope || !macros?.length)
            return fact.gaps;
        const proof: Evidence[] = [];
        for (const macro of macros) {
            if (macro.tokens.length > 8192)
                return fact.gaps;
            const attrs = rustAttributes(macro.attributes, compilation.environment);
            if (attrs.active === false)
                continue;
            if (attrs.active !== true || attrs.gaps.length)
                return fact.gaps;
            const identity = rustWebMacroResolution(this.base, scope, macro.path, macro.start, macro.absolute), profile = rustWebProfile(scope, identity);
            if (profile?.framework === 'rocket' && profile.dialect === 'rocket-0.5' && profile.path.join('::') === 'routes' && macro.operands !== undefined && profile.conditions.every(condition => condition === gap || condition.startsWith('Unreviewed Rust attribute'))) {
                proof.push(...profile.proof, { ...evidence('framework', 'rust-routers', file, macro.range.startLine, 'Original Rocket routes! literal source path list; reviewed registration syntax without macro expansion'), endLine: macro.range.endLine, analyzerVersion: RUST_ROUTER_VERSION });
                continue;
            }
            if (profile?.framework === 'warp' && profile.dialect?.startsWith('warp-') && profile.path.join('::') === 'path' && warpPathSyntax(macro.tokens) && profile.conditions.every(condition => condition === gap || condition.startsWith('Unreviewed Rust attribute'))) {
                proof.push(...profile.proof, { ...evidence('framework', 'rust-routers', file, macro.range.startLine, 'Original Warp path! literal/type token trees; reviewed native filter syntax without macro expansion'), endLine: macro.range.endLine, analyzerVersion: RUST_ROUTER_VERSION });
                continue;
            }
            const literal = rustString(macro.tokens.slice(1, -1).trim().replace(/,$/, ''));
            if (literal === undefined || /[{}]/.test(literal))
                return fact.gaps;
            const result = this.base.path(scope, macro.path, false, new Set(), 'expression');
            if (result.status !== 'external' || result.dependency !== 'log' || !['info', 'debug', 'warn', 'error', 'trace'].includes(result.path.join('::')) || result.conditions.some(condition => condition !== gap && !condition.startsWith('Unreviewed Rust attribute')))
                return fact.gaps;
            const dependencies = [...compilation.dependencies.values()].filter(entry => entry.dependency.name === result.crate && entry.dependency.package === 'log');
            if (dependencies.length !== 1)
                return fact.gaps;
            const dep = dependencies[0]!, range = dep.dependency.version && cargoRequirement(dep.dependency.version);
            if (dep.active !== true || dep.gaps.length || dep.dependency.gaps.length || dep.dependency.source !== 'registry' || dep.dependency.sourceId !== 'crates-io' || !range || !subset(range, '>=0.4.0 <0.5.0'))
                return fact.gaps;
            proof.push(...result.proof, ...dep.dependency.proof, { ...evidence('framework', 'rust-routers', file, macro.range.startLine, 'Original literal log 0.4 message: reviewed item-neutral macro syntax without argument evaluation or expansion'), analyzerVersion: RUST_ROUTER_VERSION, endLine: macro.range.endLine });
        }
        this.proofs.set(this.key(compilation, file, fact.key), proof);
        return fact.gaps.filter(condition => condition !== gap);
    };
    proof(scope: RustScope): Evidence[] {
        const result: Evidence[] = [];
        for (let current: RustScope | undefined = scope; current; current = current.parent)
            result.push(...this.proofs.get(this.key(current.compilation, current.file.path, current.fact.key)) ?? []);
        return result;
    }
}
