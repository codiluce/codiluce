import { evidence, type Evidence } from '../../core/graph.js';
import type { RustItemFact } from '../facts.js';
import { rustCfg, rustSplit } from '../languages/rust-cfg.js';
import { RustDeriveNamespaces } from '../resolution/rust-derive-namespace.js';
import type { RustResolver, RustScope, RustNamespaceAttributes } from '../resolution/rust.js';
import { rustWebMacroResolution, rustWebProfile, RUST_ROUTER_VERSION } from './rust-profile.js';

/** Rocket 0.5's reviewed form derives use devise 0.4's anonymous const wrapper.
 * Their generated context/impls do not become containing-module declarations.
 * Original derived types and generated trait/guard behavior remain opaque. */
export function rustWebNamespaceReader(base: RustResolver) {
    const derives = new RustDeriveNamespaces(base);
    const scopes = new Map(base.scopes.map(scope => [JSON.stringify([scope.compilation.id, scope.file.path, scope.fact.key]), scope]));
    return (item: RustItemFact, current: RustScope): RustNamespaceAttributes | undefined => {
        const scope = scopes.get(JSON.stringify([current.compilation.id, current.file.path, current.fact.key]));
        if (!scope) return;
        if (!['struct', 'enum'].includes(item.kind) || !['file', 'module'].includes(current.fact.kind)) return derives.read(item,scope);
        const syntax = base.syntax(current.file.path), source = base.projects.sources.readFile(current.file.path);
        if (!syntax?.complete || !syntax.semantic?.complete || source === undefined || item.gaps.length) return derives.opaqueBuiltins(item,scope);
        // A macro in a quoted field type/helper expression could export crate
        // names from the generated const. Opaque input token trees stay gaps.
        const input = source.slice(item.start, item.end);
        if (input.length > 8192 || input.includes('!') || item.attributes.some(value=>value.includes('!'))) return derives.opaqueBuiltins(item,scope);
        const proof: Evidence[] = [], originalGaps: string[] = [], known = new Set<string>();
        let unqualifiedBuiltin = false, serde = false;
        const filter = (attribute: string, original: string, depth = 0): string[] => {
            if (depth > 32) return [attribute];
            const text = attribute.replace(/^#!?\[/, '').replace(/\]$/, '').trim();
            const conditional = /^cfg_attr\s*\(([\s\S]*)\)$/.exec(text);
            if (conditional) {
                const args = rustSplit(conditional[1]!);
                if (args && args.length >= 2 && rustCfg(args[0]!, scope.compilation.environment) === true)
                    return args.slice(1).flatMap(arg => filter(arg, original, depth + 1));
            }
            const derive = /^derive\s*\(([\s\S]*)\)$/.exec(text), names = derive && rustSplit(derive[1]!);
            if (!names?.length || names.length > 32) { if(names?.some(name=>derives.builtinSpelling(name)))unqualifiedBuiltin=true;return [attribute]; }
            const retained: string[] = [];
            for (const name of names) {
                const native = derives.macro(name,item,scope), nativeStart = source.lastIndexOf(original,item.start);
                if (native && !known.has(native.identity) && nativeStart >= scope.fact.start) {
                    known.add(native.identity); serde ||= native.identity.startsWith('serde::'); originalGaps.push(...native.originalGaps??[]);
                    const line = source.slice(0,nativeStart).split('\n').length;
                    proof.push(...native.proof,{...evidence('framework','rust-routers',scope.file.path,line,`Original ${native.identity} derive on ${item.name}: reviewed containing namespace only; generated implementations/traits/conversions remain unreviewed`),endLine:line+original.split('\n').length-1,analyzerVersion:RUST_ROUTER_VERSION});
                    continue;
                }
                unqualifiedBuiltin ||= derives.builtinSpelling(name);
                if (!/^(?:::)?[_\p{ID_Start}][_\p{ID_Continue}]*(?:::[_\p{ID_Start}][_\p{ID_Continue}]*)*$/u.test(name)) { retained.push(name); continue; }
                const identity = rustWebMacroResolution(base, scope, name.split('::').filter(Boolean), item.start, name.startsWith('::'));
                const profile = rustWebProfile(scope, identity), macro = profile?.path.join('::');
                if (!profile || profile.framework !== 'rocket' || profile.dialect !== 'rocket-0.5' || !profile.macros || profile.conditions.some(gap => !gap.startsWith('Unreviewed Rust attribute')) || macro !== (item.kind === 'struct' ? 'FromForm' : 'FromFormField') || known.has(macro)) { retained.push(name); continue; }
                // Form codegen delegates to rocket::async_trait. Keep a closed
                // canonical crate identity rather than borrowing another alias.
                const delegated = base.path(scope, ['rocket'], true, new Set(), 'type');
                if (identity.status !== 'external' || delegated.status !== 'external' || delegated.dependency !== 'rocket' || delegated.crate !== identity.crate || delegated.conditions.some(gap => !gap.startsWith('Unreviewed Rust attribute'))) { retained.push(name); continue; }
                const delegationProof = [...delegated.proof];
                if (macro === 'FromForm') {
                    const relative = base.path(scope, ['rocket'], false, new Set(), 'type');
                    if (relative.status !== 'external' || relative.dependency !== 'rocket' || relative.crate !== delegated.crate || relative.path.length || relative.conditions.some(gap => !gap.startsWith('Unreviewed Rust attribute'))) { retained.push(name); continue; }
                    delegationProof.push(...relative.proof);
                }
                const start = source.lastIndexOf(original, item.start);
                if (start < scope.fact.start) { retained.push(name); continue; }
                const line = source.slice(0, start).split('\n').length;
                known.add(macro);
                proof.push(...profile.proof, ...delegationProof, { ...evidence('framework', 'rust-routers', scope.file.path, line, `Original Rocket 0.5 ${macro} derive on ${item.name}: anonymous const contains generated context/impls; containing-module namespace only, generated traits/guards remain unreviewed`), endLine: line + original.split('\n').length - 1, analyzerVersion: RUST_ROUTER_VERSION });
            }
            return retained.length ? [`#[derive(${retained.join(',')})]`] : [];
        };
        let retained = item.attributes.flatMap(attribute => filter(attribute, attribute));
        if (serde) retained = retained.filter(value=>!/^serde\s*\(/.test(value.replace(/^#!?\[/,'').replace(/\]$/,'').trim()));
        return known.size || unqualifiedBuiltin ? { attributes: derives.attributes(retained,scope,unqualifiedBuiltin), proof, originalGaps:[...new Set(originalGaps)] } : undefined;
    };
}
