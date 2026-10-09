import { subset } from 'semver';
import type { Evidence } from '../../core/graph.js';
import { evidence } from '../../core/graph.js';
import type { RustScope, RustResolver, RustResolution } from '../resolution/rust.js';
import { cargoRequirement, type RustCompilation } from '../resolution/rust-projects.js';
import { rustAttributes, rustCfg, rustSplit, rustString } from '../languages/rust-cfg.js';
import type { RustRouteDialect } from '../routes/rust-patterns.js';
import type { RustScopeFact } from '../facts.js';
export const RUST_ROUTER_VERSION = '1';
export interface RustWebProfile {
    framework: 'axum' | 'actix-web' | 'tokio';
    dialect?: RustRouteDialect;
    path: string[];
    proof: Evidence[];
    conditions: string[];
    macros: boolean;
}
/** Canonical external registry identity under original Cargo selections. A
 * lookalike local package, fork or requirement crossing native syntax families
 * cannot activate these contracts. No restored binaries are inspected. */
export function rustWebProfile(scope: RustScope, result: RustResolution): RustWebProfile | undefined {
    if (result.status !== 'external' || !['axum', 'actix-web', 'tokio'].includes(result.dependency))
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
    const dialect = framework === 'axum' ? within('>=0.7.0 <0.8.0') ? 'axum-0.7' : within('>=0.8.0 <0.9.0') ? 'axum-0.8' : undefined : framework === 'actix-web' && within('>=4.0.0 <5.0.0') ? 'actix-web-4' : undefined;
    if (framework === 'tokio' ? !within('>=1.0.0 <2.0.0') : !dialect)
        conditions.push('Rust web requirement crosses or lacks a reviewed native version family');
    const features = new Set([...dep.features, ...scope.compilation.dependencyFeatures.get(dep.name) ?? []]);
    const macros = framework === 'actix-web' ? dep.defaultFeatures || features.has('macros') : framework === 'tokio' ? (features.has('macros') || features.has('full')) && (features.has('rt') || features.has('rt-multi-thread') || features.has('full')) : false;
    return { framework, dialect, path: result.path, macros, conditions: [...new Set(conditions)], proof: [...result.proof, ...dep.proof, { ...evidence('framework', 'rust-routers', scope.compilation.target.package.manifest, 1, `Original registry ${dep.package} requirement ${dep.version ?? '(absent)'}; reviewed native ${dialect ?? framework + '-1'} contract, without executing dependency code`), analyzerVersion: RUST_ROUTER_VERSION }] };
}
export interface RustWebAttribute {
    kind: 'runtime' | 'route';
    framework: 'actix-web' | 'tokio';
    path?: string;
    methods?: string[];
    proof: Evidence[];
}
const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'CONNECT', 'TRACE'];
export function rustWebAttribute(base: RustResolver, scope: RustScope, attribute: string): RustWebAttribute | undefined {
    const text = attribute.replace(/^#!?\[/, '').replace(/\]$/, '').trim(), match = /^([\w:]+)(?:\s*\(([\s\S]*)\))?$/.exec(text);
    if (!match)
        return;
    const profile = rustWebProfile(scope, base.path(scope, match[1]!.split('::'), false, new Set(), 'expression'));
    // The base resolver deliberately retains unknown attributes. Only those gaps
    // are ignored while identifying this exact native macro; all other gaps stay.
    if (!profile || profile.conditions.some(gap => !gap.startsWith('Unreviewed Rust attribute')) || !profile.macros)
        return;
    const name = profile.path.join('::'), args = rustSplit(match[2] ?? '');
    if (!args)
        return;
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
            if (selected) {
                const args = rustSplit(selected[1]!);
                if (args && args.length >= 2 && rustCfg(args[0]!, compilation.environment) === true)
                    return args.slice(1).flatMap(arg => filter(arg, depth + 1));
            }
            return rustWebAttribute(base, scope, attribute) ? [] : [attribute];
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
