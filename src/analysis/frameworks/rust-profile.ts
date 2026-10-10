import { subset } from 'semver';
import type { Evidence } from '../../core/graph.js';
import { evidence } from '../../core/graph.js';
import type { RustScope, RustResolver, RustResolution } from '../resolution/rust.js';
import { cargoRequirement, type RustCompilation } from '../resolution/rust-projects.js';
import { rustAttributes, rustCfg, rustEmptyTokenTree, rustSplit, rustString } from '../languages/rust-cfg.js';
import type { RustRouteDialect } from '../routes/rust-patterns.js';
import type { RustScopeFact } from '../facts.js';
import { warpPathSyntax } from './warp-syntax.js';
import { RustLockfiles } from '../resolution/rust-lock.js';
import {rustStandardNamespaceMacro} from '../resolution/rust-runtime-namespace.js';
export const RUST_ROUTER_VERSION = '13';
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
    kind: 'runtime' | 'route' | 'launch' | 'instrument' | 'test';
    framework: 'actix-web' | 'tokio' | 'rocket' | 'tracing';
    path?: string;
    methods?: string[];
    rank?: number;
    format?: string;
    data?: string;
    proof: Evidence[];
}
const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'CONNECT', 'TRACE'];
const rocketMacroNames = new Set(['get', 'put', 'post', 'delete', 'head', 'patch', 'options', 'route', 'routes', 'launch', 'main', 'FromForm', 'FromFormField']);
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
    const original = base.path(scope, path, absolute, new Set(), 'macro');
    if (original.status !== 'unresolved' || path.length !== 1 || absolute)
        return original;
    const candidates: RustResolution[] = [];
    for (let current: RustScope | undefined = scope; current; current = current.parent) {
        for (const site of current.imports) {
            if (site.fact.kind !== 'extern' || site.active !== true || site.scope.file.path === scope.file.path && site.fact.end > at)
                continue;
            const attrs = site.fact.attributes.map(attr => attr.replace(/^#!?\[/, '').replace(/\]$/, '').trim());
            const result = base.resolve(site), profile = rustWebProfile(scope, result);
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
    const instrument = rustWebInstrument(base,scope,attribute,at);
    if(instrument)return instrument;
    const profile = rustWebProfile(scope, rustWebMacroResolution(base, scope, match[1]!.split('::').filter(Boolean), at, match[1]!.startsWith('::')));
    // The base resolver deliberately retains unknown attributes. Only those gaps
    // are ignored while identifying this exact native macro; all other gaps stay.
    if (!profile || profile.conditions.some(gap => !gap.startsWith('Unreviewed Rust attribute')) || !profile.macros)
        return;
    const name = profile.path.join('::'), args = rustSplit(match[2] ?? '');
    if (!args)
        return;
    if(profile.framework==='tokio'&&name==='test'&&!args.length&&scope.compilation.environment.test===false){
        const syntax=base.syntax(scope.file.path),item=syntax?.items.find(item=>item.start===at),definition=item&&syntax?.semantic?.definitions.find(definition=>definition.key===item.key);
        const dep=scope.compilation.dependencies.get((rustWebMacroResolution(base,scope,match[1]!.split('::').filter(Boolean),at,match[1]!.startsWith('::')) as Extract<RustResolution,{status:'external'}>).crate),locks=new RustLockfiles(base);
        if(!dep||dep.active!==true||dep.compilation||dep.gaps.length||dep.dependency.name.replaceAll('-','_')!=='tokio'||dep.dependency.scope==='build'||!syntax?.complete||!syntax.semantic?.complete||!item||item.kind!=='function'||!definition?.async||!definition.body||definition.parameters.length||definition.generics||definition.gaps.length||definition.returnType||item.attributes.length!==1)return;
        const standard=base.path(scope,['core'],true,new Set(),'type');
        if(standard.status!=='external'||standard.dependency!=='rust-standard-library'||standard.crate!=='core'||standard.path.length||standard.conditions.some(gap=>!gap.startsWith('Unreviewed Rust attribute')))return;
        const provider=locks.select(scope.compilation.target.package,dep.dependency,'tokio-macros'),runtime=locks.select(scope.compilation.target.package,dep.dependency);
        if(provider?.package.version!=='2.7.0'||runtime?.package.version!=='1.53.1')return;
        const source=base.projects.sources.readFile(scope.file.path),original=item.attributes[0]!,start=source?.lastIndexOf(original,item.start);
        if(source===undefined||start===undefined||start<scope.fact.start||start<0)return;
        const line=source.slice(0,start).split('\n').length;
        return {kind:'test',framework:'tokio',proof:[...profile.proof,...standard.proof,...provider.proof,...runtime.proof,{...evidence('framework','rust-routers',scope.file.path,line,`Original tokio-macros 2.7.0 test on ${item.name}: native standard test function excluded under recorded test=false; no test body executes`),analyzerVersion:RUST_ROUTER_VERSION,endLine:line+original.split('\n').length-1}]};
    }
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
/** Framework projection of a recorded native instrument wrapper. The general
 * Rust analyzer still treats its generated signature/body as opaque. */
function rustWebInstrument(base:RustResolver,scope:RustScope,attribute:string,at:number):RustWebAttribute|undefined {
    const text=attribute.replace(/^#!?\[/,'').replace(/\]$/,'').trim(),match=/^([\w:]+)(?:\s*\(\s*\))?$/.exec(text);
    if(!match)return;
    const identity=rustWebMacroResolution(base,scope,match[1]!.split('::').filter(Boolean),at,match[1]!.startsWith('::'));
    const allowed=(conditions:string[])=>conditions.every(gap=>gap.startsWith('Unreviewed Rust attribute'));
    if(identity.status!=='external'||!['tracing','tracing-attributes'].includes(identity.dependency)||identity.path.join('::')!=='instrument'||!allowed(identity.conditions))return;
    const syntax=base.syntax(scope.file.path),item=syntax?.items.find(item=>item.start===at),definition=item&&syntax?.semantic?.definitions.find(definition=>definition.key===item.key),source=base.projects.sources.readFile(scope.file.path);
    if(!syntax?.complete||!syntax.semantic?.complete||!item||item.kind!=='function'||!definition?.body||definition.generics||definition.parameters.length||definition.gaps.length||source===undefined)return;
    const body=syntax.scopes.find(candidate=>candidate.key===definition.body);
    if(!body||/\b(?:const|unsafe|extern)\b/.test(source.slice(item.start,body.start)))return;
    const effective=(value:string,depth=0):string[]=>{
        if(depth>32)return [value];
        const selected=/^cfg_attr\s*\(([\s\S]*)\)$/.exec(value.replace(/^#!?\[/,'').replace(/\]$/,'').trim()),args=selected&&rustSplit(selected[1]!);
        return args&&args.length>=2&&rustCfg(args[0]!,scope.compilation.environment)===true?args.slice(1).flatMap(value=>effective(value,depth+1)):[value];
    };
    const original=item.attributes.flatMap(value=>effective(value)),selected=original.filter(value=>value.replace(/^#!?\[/,'').replace(/\]$/,'').trim()===text);
    if(selected.length!==1)return;
    const remaining=rustAttributes(original.filter(value=>!selected.includes(value)),scope.compilation.environment);
    if(remaining.active!==true||remaining.namespaceGaps.length)return;
    const entry=scope.compilation.dependencies.get(identity.crate),dep=entry?.dependency;
    if(!entry||!dep||entry.active!==true||entry.compilation||entry.gaps.length||dep.scope==='build')return;
    const features=[...dep.features,...scope.compilation.dependencyFeatures.get(dep.name)??[]];
    if(dep.package==='tracing'&&!dep.defaultFeatures&&!features.includes('attributes')&&!features.includes('tracing-attributes'))return;
    const locks=new RustLockfiles(base),provider=locks.select(scope.compilation.target.package,dep,dep.package==='tracing'?'tracing-attributes':undefined);
    if(!provider||provider.package.version!=='0.1.31')return;
    const runtime=base.path(scope,['tracing'],true,new Set(),'type'),runtimeEntry=runtime.status==='external'&&scope.compilation.dependencies.get(runtime.crate);
    if(runtime.status!=='external'||runtime.dependency!=='tracing'||runtime.crate!=='tracing'||runtime.path.length||!allowed(runtime.conditions)||!runtimeEntry||runtimeEntry.active!==true||runtimeEntry.compilation||runtimeEntry.gaps.length||runtimeEntry.dependency.scope==='build')return;
    const native=locks.select(scope.compilation.target.package,runtimeEntry.dependency);
    if(!native||native.package.version!=='0.1.44')return;
    const originalAttribute=item.attributes.find(value=>effective(value).some(value=>selected.includes(value))),start=originalAttribute?source.lastIndexOf(originalAttribute,item.start):undefined;
    if(start===undefined||start<scope.fact.start||start<0)return;
    const line=source.slice(0,start).split('\n').length;
    return {kind:'instrument',framework:'tracing',proof:[...identity.proof,...runtime.proof,...provider.proof,...native.proof,{...evidence('framework','rust-routers',scope.file.path,line,`Original tracing-attributes 0.1.31 instrument on ${item.name}: native parameter-free source helper projection; generated tracing behavior remains unreviewed`),analyzerVersion:RUST_ROUTER_VERSION,endLine:line+originalAttribute!.split('\n').length-1}]};
}
/** Framework-only resolver: exact recognized attribute sites preserve original
 * functions/bodies as reviewed framework syntax, without proc-macro expansion.
 * The general Rust resolver and its conservative call outcomes stay separate. */
export function rustWebAttributeReader(base: RustResolver,recordProof?:(scope:RustScope,proof:Evidence[])=>void) {
    const scopes = new Map(base.scopes.map(scope => [JSON.stringify([scope.compilation.id, scope.file.path, scope.fact.key]), scope]));
    return (attributes: string[], compilation: RustCompilation, file: string, key: string, originalAt?:number) => {
        const scope = scopes.get(JSON.stringify([compilation.id, file, key]));
        const filter = (attribute: string, depth = 0): string[] => {
            if (!scope || depth > 32)
                return [attribute];
            const text = attribute.replace(/^#!?\[/, '').replace(/\]$/, '').trim(), selected = /^cfg_attr\s*\(([\s\S]*)\)$/.exec(text);
            if (/^macro_use(?:\s*\([\s\S]*\))?$/.test(text)) {
                const site = scope.imports.find(site => site.fact.kind === 'extern' && site.fact.attributes.includes(attribute));
                if (site) {
                    const result = base.resolve(site), profile = rustWebProfile(scope, result);
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
            const candidates=base.syntax(file)?.items.filter(item=>item.attributes.includes(attribute))??[];
            const at=originalAt??(candidates.length===1?candidates[0]!.start:undefined);
            const reviewed=rustWebAttribute(base,scope,attribute,at);
            if(reviewed?.kind==='test')recordProof?.(scope,reviewed.proof);
            return reviewed?.kind==='test'?['#[cfg(test)]']:reviewed?[]:[attribute];
        };
        return rustAttributes(attributes.flatMap(attribute => filter(attribute)), compilation.environment);
    };
}
/** A single literal log 0.4 message is a reviewed item-neutral syntax contract.
 * Format operands, custom logger/target clauses and every other macro retain
 * their original expansion gap. This never expands or executes a macro. */
export class RustWebMacros {
    private readonly proofs = new Map<string, Evidence[]>();
    private readonly exclusions = new Map<string, Evidence[]>();
    constructor(private readonly base: RustResolver) { }
    formatting(scope:RustScope,macro:Parameters<typeof rustStandardNamespaceMacro>[2]):Evidence[]|undefined {
        return rustStandardNamespaceMacro(this.base,scope,macro);
    }
    private key(compilation: RustCompilation, file: string, scope: string) { return JSON.stringify([compilation.id, file, scope]); }
    recordExclusion=(scope:RustScope,proof:Evidence[]):void=>{
        const key=this.key(scope.compilation,scope.file.path,scope.fact.key);
        this.exclusions.set(key,[...new Map([...(this.exclusions.get(key)??[]),...proof].map(fact=>[JSON.stringify(fact),fact])).values()]);
    };
    /** Literal include_str input is item-neutral. Contents, availability,
     * returned bytes and compiler validity are deliberately not inspected. */
    includedText(scope:RustScope,macro:{path:string[];absolute:boolean;tokens:string}):Evidence[]|undefined {
        const args=rustSplit(macro.tokens.slice(1,-1));if(args?.length!==1||rustString(args[0]!)===undefined)return;
        const allowed=(conditions:string[])=>conditions.every(gap=>gap==='Rust macro invocation can supply generated/scoped items; expansion is unavailable'||gap.startsWith('Unreviewed Rust attribute'));
        const result=this.base.path(scope,macro.path,macro.absolute,new Set(),'expression');
        if(result.status==='external'&&result.dependency==='rust-standard-library'&&result.crate==='std'&&result.path.join('::')==='include_str'&&allowed(result.conditions))return result.proof;
        if(result.status!=='unresolved'||macro.absolute||macro.path.length!==1||macro.path[0]!=='include_str')return;
        for(let current:RustScope|undefined=scope;current;current=current.parent){
            if(current.attributes.noPrelude||current.attributes.noStd||current.attributes.noCore||current.items.some(item=>item.active!==false&&item.name==='include_str')||current.imports.some(site=>site.active!==false&&(!site.fact.glob&&(site.fact.alias??site.fact.segments.at(-1))==='include_str'||site.fact.attributes.some(value=>/^#!?\[\s*macro_use\b/.test(value)))))return;
            for(const site of current.imports.filter(site=>site.active!==false&&site.fact.glob)){const imported=this.base.resolve(site);if(imported.status!=='resolved'||!allowed(imported.conditions))return;}
        }
        const standard=this.base.path(scope,['std'],false,new Set(),'expression');
        if(standard.status==='external'&&standard.dependency==='rust-standard-library'&&standard.crate==='std'&&allowed(standard.conditions))return standard.proof;
    }
    /** Only standard diagnostic syntax with no user formatting dispatch. The
     * one operand form is provisional: registration evaluation must prove the
     * original binding is a native Tokio listener before it can qualify. */
    diagnostic(scope: RustScope, macro: { path: string[]; absolute: boolean; tokens: string }): { receiver?: string; proof: Evidence[] } | undefined {
        const result = this.base.path(scope, macro.path, macro.absolute, new Set(), 'expression');
        let proof: Evidence[];
        if (result.status === 'external' && result.dependency === 'rust-standard-library' && result.crate === 'std' && ['println', 'eprintln'].includes(result.path.join('::')) && !result.conditions.length)
            proof = result.proof;
        else if (result.status === 'unresolved' && !macro.absolute && macro.path.length === 1 && ['println', 'eprintln'].includes(macro.path[0]!)) {
            // Prelude macros have no fabricated general resolver symbol. Every
            // competing source/import/extern binding and disabled prelude wins.
            for (let current: RustScope | undefined = scope; current; current = current.parent) {
                if (current.attributes.noPrelude || current.attributes.noStd || current.attributes.noCore || current.imports.some(site => site.active !== false && site.fact.attributes.some(attribute => /^#!?\[\s*macro_use\b/.test(attribute))))
                    return;
                if (current.items.some(item => item.name === macro.path[0] && item.active !== false) || current.imports.some(site => site.active !== false && !site.fact.glob && (site.fact.alias ?? site.fact.segments.at(-1)) === macro.path[0])) return;
                for (const site of current.imports.filter(site => site.active !== false && site.fact.glob)) {
                    const imported = this.base.resolve(site);
                    if (imported.status !== 'resolved' || imported.conditions.length) return;
                }
            }
            const standard = this.base.path(scope, ['std'], false, new Set(), 'expression');
            if (standard.status !== 'external' || standard.dependency !== 'rust-standard-library' || standard.crate !== 'std' || standard.conditions.length)
                return;
            proof = standard.proof;
        }
        else
            return;
        const args = rustSplit(macro.tokens.slice(1, -1));
        if (rustEmptyTokenTree(macro.tokens)) return { proof };
        const literal = args?.[0] && rustString(args[0]);
        if (literal === undefined || !args)
            return;
        if (args.length === 1 && !/[{}]/.test(literal))
            return { proof };
        const receiver = args.length === 2 && /^([A-Za-z_][A-Za-z_0-9]*)\s*\.\s*local_addr\s*\(\s*\)\s*\.\s*unwrap\s*\(\s*\)$/.exec(args[1]!);
        if (receiver && /^[^{}]*\{\}[^{}]*$/.test(literal))
            return { receiver: receiver[1], proof };
        return;
    }
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
            const included=this.includedText(scope,macro);
            if(included){proof.push(...included,{...evidence('framework','rust-routers',file,macro.range.startLine,'Original standard include_str with one literal filename: item-neutral namespace only; no included file is read or expanded'),analyzerVersion:RUST_ROUTER_VERSION,endLine:macro.range.endLine});continue;}
            const diagnostic = this.diagnostic(scope, macro);
            if (diagnostic) {
                proof.push(...diagnostic.proof, { ...evidence('framework', 'rust-routers', file, macro.range.startLine, diagnostic.receiver ? 'Original standard diagnostic syntax; native listener operand identity requires registration evaluation' : rustEmptyTokenTree(macro.tokens) ? 'Original empty standard print diagnostic; reviewed item-neutral syntax without expansion' : 'Original standard literal diagnostic with no formatting operands; reviewed item-neutral syntax without expansion'), endLine: macro.range.endLine, analyzerVersion: RUST_ROUTER_VERSION });
                continue;
            }
            const formatting=this.formatting(scope,macro);
            if(formatting){proof.push(...formatting,{...evidence('framework','rust-routers',file,macro.range.startLine,'Original standard formatting syntax is namespace-neutral; formatter dispatch, side effects and runtime registration reachability remain unreviewed'),analyzerVersion:RUST_ROUTER_VERSION,endLine:macro.range.endLine});continue;}
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
            result.push(...this.proofs.get(this.key(current.compilation, current.file.path, current.fact.key)) ?? [],...this.exclusions.get(this.key(current.compilation,current.file.path,current.fact.key))??[]);
        return result;
    }
}
