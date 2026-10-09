import type { AnalysisContext, ScannedFile, Analyzer } from '../../core/analyzer.js';
import { declarationHashes, evidence, type Evidence, type CallSites } from '../../core/graph.js';
import { fileAnalysis, type RustDefinitionFact, type RustSemanticFacts, type RustExpression, type RustTypeFact, type RustBindingFact, type RustSite, type RustImplFact } from '../facts.js';
import { RustResolver, type RustScope, type RustSymbol, type RustResolution, RUST_RESOLVER_VERSION } from '../resolution/rust.js';
import { rustAttributes, rustAnd } from './rust-cfg.js';
import { STRUCTURE_VERSION } from '../tree-sitter/analyzer.js';
import { fileKey } from '../../pipeline/cache.js';
export const RUST_SYMBOL_VERSION = '1';
interface Unit {
    file: ScannedFile;
    facts: RustSemanticFacts;
    definitions: Map<string, RustDefinition>;
    bindings: Map<string, RustBindingFact[]>;
}
export interface RustDefinition {
    id: string;
    fact: RustDefinitionFact;
    unit: Unit;
}
export type RustValue = ({
    kind: 'callable';
    definitions: {
        definition: RustDefinition;
        scope: RustScope;
    }[];
} | {
    kind: 'type' | 'instance';
    symbol: RustSymbol;
    references: ('shared' | 'mutable')[];
} | {
    kind: 'source';
    definition: RustDefinition;
    scope: RustScope;
} | {
    kind: 'future';
    definition?: RustDefinition;
    result?: RustValue;
} | {
    kind: 'tuple';
    values: RustValue[];
} | {
    kind: 'external';
    name: string;
    dependency: string;
} | {
    kind: 'unknown';
    reason: string;
}) & {
    proof: Evidence[];
    conditions: string[];
};
export interface RustFrame {
    parameters?: Map<string, RustValue>;
    owner?: string;
}
export type RustHandler = {
    status: 'resolved';
    definition: RustDefinition;
    scope: RustScope;
    proof: Evidence[];
    conditions: string[];
} | {
    status: 'unresolved';
    reason: string;
    proof: Evidence[];
};
const unknown = (reason: string, proof: Evidence[] = [], conditions: string[] = []): RustValue => ({ kind: 'unknown', reason, proof, conditions });
const unique = <T>(values: T[]) => [...new Set(values)];
const typeKinds = new Set(['struct', 'union', 'enum', 'trait', 'type']);
/** Bounded original source binding under a selected crate compilation. Returned
 * values stay internal; graph outcomes contain original IDs and plain proof. */
export class RustSymbols {
    private readonly units = new Map<string, Unit>();
    private readonly methodTypes = new Map<string, RustValue>();
    private operations = 0;
    private readonly members = new Map<string, RustDefinition[]>();
    private readonly scopes = new Map<string, RustScope>();
    private readonly traitImpls: {
        unit: Unit;
        impl: RustImplFact;
    }[] = [];
    constructor(readonly context: AnalysisContext, readonly resolver: RustResolver) {
        for (const scope of resolver.scopes)
            this.scopes.set(scope.file.path + '\0' + scope.fact.key + '\0' + scope.compilation.id, scope);
        for (const file of context.files.values()) {
            const parsed = context.syntax?.get(file.path), facts = parsed?.facts.rust?.semantic;
            if (!facts)
                continue;
            const unit: Unit = { file, facts, definitions: new Map(), bindings: new Map() }, ordinals = new Map<string, number>();
            this.units.set(file.path, unit);
            for (const binding of facts.bindings) {
                const key = binding.scope + '\0' + binding.name;
                unit.bindings.set(key, [...unit.bindings.get(key) ?? [], binding]);
            }
            this.traitImpls.push(...facts.impls.filter(impl => impl.trait).map(impl => ({ unit, impl })));
            for (const fact of facts.definitions) {
                const lexicalOwner = this.ownerKey(file.path, fact.scope), parent = unit.definitions.get(lexicalOwner ?? '')?.id ?? parsed!.declarations.get(lexicalOwner ?? '') ?? file.id;
                const ordinal = ordinals.get(parent + fact.kind) ?? 0, isAnonymous = ['closure', 'async'].includes(fact.kind), id = isAnonymous ? context.graph.id('symbol', 'rust', file.application?.name ?? '', file.path, parent, fact.kind, String(ordinal)) : parsed!.declarations.get(fact.key);
                if (!id)
                    continue;
                if (isAnonymous)
                    ordinals.set(parent + fact.kind, ordinal + 1);
                const definition = { id, fact, unit };
                unit.definitions.set(fact.key, definition);
                this.members.set(fact.name, [...this.members.get(fact.name) ?? [], definition]);
            }
        }
    }
    facts(file: string) { return this.units.get(file)?.facts; }
    definitions(file: string) { return [...this.units.get(file)?.definitions.values() ?? []]; }
    private ownerKey(file: string, key: string): string | undefined {
        const facts = this.resolver.syntax(file);
        let scope = facts?.scopes.find(s => s.key === key);
        for (let i = 0; scope && i < 128; i++, scope = scope.parent ? facts?.scopes.find(s => s.key === scope!.parent) : undefined)
            if (scope.owner)
                return scope.owner;
    }
    owner(scope: RustScope): string { return this.units.get(scope.file.path)?.definitions.get(this.ownerKey(scope.file.path, scope.fact.key) ?? '')?.id ?? scope.file.id; }
    definition(file: string, key: string) { return this.units.get(file)?.definitions.get(key); }
    private scope(file: string, key: string, compilation: string) { return this.scopes.get(file + '\0' + key + '\0' + compilation); }
    private chain(scope: RustScope): RustScope[] {
        const result: RustScope[] = [];
        for (let s: RustScope | undefined = scope; s && result.length < 128; s = s.parent)
            result.push(s);
        return result;
    }
    private proof(file: string, site: RustSite, reason: string): Evidence[] { return [{ ...evidence('syntax', 'rust-symbols', file, site.range.startLine, reason), analyzerVersion: RUST_SYMBOL_VERSION, endLine: site.range.endLine }]; }
    private attributes(scope: RustScope, attributes: string[]) { const attrs = this.resolver.attributes(attributes, scope.compilation, scope.file.path, scope.fact.key); return { active: rustAnd([scope.active, attrs.active]), gaps: unique([...scope.gaps, ...attrs.gaps]) }; }
    private definitionScope(def: RustDefinition, from: RustScope): RustScope | undefined { return this.scope(def.unit.file.path, def.fact.scope, from.compilation.id); }
    private sourceSymbol(def: RustDefinition, scope: RustScope): RustSymbol {
        const attrs = this.attributes(scope, def.fact.attributes);
        return { id: def.id, name: def.fact.name, namespaces: typeKinds.has(def.fact.kind) ? ['type'] : ['value'], scope, visibility: def.fact.visibility, active: attrs.active, gaps: unique([...attrs.gaps, ...def.fact.gaps, ...!def.unit.facts.complete ? ['Incomplete original Rust semantic syntax'] : []]), proof: this.proof(def.unit.file.path, def.fact, `Original Rust ${def.fact.kind} ${def.fact.name}`) };
    }
    private fromResolution(result: RustResolution, scope: RustScope, typeOnly = false, trail = new Set<string>()): RustValue {
        if (result.status === 'external')
            return { kind: 'external', name: result.crate + (result.path.length ? '::' + result.path.join('::') : ''), dependency: result.dependency, proof: result.proof, conditions: result.conditions };
        if (result.status !== 'resolved')
            return unknown(result.reason, [], result.status === 'unresolved' ? [] : ['Original Rust name resolution is ' + result.status]);
        const candidates = result.symbols.filter(s => s.namespaces.includes(typeOnly ? 'type' : 'value'));
        if (!candidates.length && result.symbols.length === 1 && result.symbols[0]?.namespaces.includes('type'))
            candidates.push(result.symbols[0]);
        if (candidates.length !== 1)
            return unknown('Rust reference has no unique original namespace binding', result.proof, result.conditions);
        const alias = candidates[0]!, symbol = { ...alias, scope: alias.originalScope ?? alias.scope, visibility: alias.originalVisibility ?? alias.visibility }, definition = this.definitions(symbol.scope.file.path).find(d => d.id === symbol.id), proof = result.proof, conditions = result.conditions;
        if (symbol.module && !definition)
            return unknown('Rust module namespace is not a runtime operand', proof, conditions);
        if (!definition)
            return unknown('Original Rust definition is unavailable', proof, conditions);
        if (!definition.unit.facts.complete)
            return unknown('Incomplete original Rust target semantic syntax', proof, [...conditions, 'Incomplete original Rust target semantic syntax']);
        if (typeKinds.has(definition.fact.kind)) {
            if (definition.fact.generics)
                return unknown('Unselected generic original Rust type', proof, conditions);
            if (definition.fact.kind === 'type') {
                const key = symbol.scope.compilation.id + ':alias:' + definition.id;
                if (trail.has(key) || definition.fact.generics)
                    return unknown('Cyclic/generic Rust type alias is unreviewed', proof, conditions);
                const next = new Set(trail);
                next.add(key);
                const value = this.typeValue(symbol.scope, definition.fact.returnType, next);
                return { ...value, proof: [...proof, ...value.proof], conditions: unique([...conditions, ...value.conditions]) };
            }
            return { kind: 'type', symbol, references: [], proof, conditions };
        }
        if (definition.fact.kind === 'function')
            return { kind: 'callable', definitions: [{ definition, scope: symbol.scope }], proof, conditions: unique([...conditions, ...definition.fact.generics ? ['Generic Rust callable instantiation is unreviewed'] : []]) };
        if (['constant', 'static'].includes(definition.fact.kind)) {
            const key = symbol.scope.compilation.id + ':constant:' + definition.id;
            if (trail.has(key) || definition.fact.gaps.length)
                return unknown('Cyclic/mutable Rust constant/static operand', proof, conditions);
            const next = new Set(trail);
            next.add(key);
            if (definition.fact.value) {
                const value = this.value(symbol.scope, definition.fact.value, undefined, next);
                return { ...value, proof: [...proof, ...value.proof], conditions: unique([...conditions, ...value.conditions]) };
            }
        }
        return { kind: 'source', definition, scope: symbol.scope, proof, conditions };
    }
    private isGeneric(scope: RustScope, name: string, at: number): boolean {
        const facts = this.facts(scope.file.path);
        return !!facts?.definitions.some(d => d.start <= at && d.end >= at && d.typeParameters?.includes(name)) || !!facts?.impls.some(d => d.start <= at && d.end >= at && d.typeParameters?.includes(name));
    }
    typeValue(scope: RustScope, type: RustTypeFact | undefined, trail = new Set<string>()): RustValue {
        if (!type)
            return unknown('No original Rust type annotation');
        if (type.kind === 'reference') {
            const value = this.typeValue(scope, type.inner, trail);
            return value.kind === 'type' || value.kind === 'instance' ? { ...value, references: [type.mutable ? 'mutable' : 'shared', ...value.references] } : value;
        }
        if (type.kind === 'function')
            return unknown('Function-pointer type has no original source operand');
        if (type.kind !== 'path' || !type.segments?.length || type.generics)
            return unknown('Generic/opaque Rust type inference is unavailable');
        if (type.segments[0] === 'Self') {
            const owner = this.enclosingDefinition(scope), impl = owner?.fact.impl && owner.unit.facts.impls.find(i => i.key === owner.fact.impl);
            if (!impl || impl.trait || impl.generics)
                return unknown('Trait/generic/unbound Rust Self type');
            const parent = this.scope(scope.file.path, impl.parent, scope.compilation.id);
            return parent ? this.typeValue(parent, impl.type, trail) : unknown('Original impl scope is unavailable');
        }
        if (type.segments.length === 1 && this.isGeneric(scope, type.segments[0]!, type.start))
            return unknown('Unselected original Rust type parameter');
        if (type.segments.length === 1 && ['bool', 'char', 'str', 'i8', 'i16', 'i32', 'i64', 'i128', 'isize', 'u8', 'u16', 'u32', 'u64', 'u128', 'usize', 'f32', 'f64'].includes(type.segments[0]!))
            return { kind: 'external', name: 'rust-primitive::' + type.segments[0], dependency: 'rust-language', proof: this.proof(scope.file.path, type, 'Native Rust primitive type'), conditions: [] };
        return this.fromResolution(this.resolver.path(scope, type.segments, type.absolute ?? false, new Set(), 'expression'), scope, true, trail);
    }
    private enclosingDefinition(scope: RustScope): RustDefinition | undefined {
        for (const s of this.chain(scope)) {
            const definition = s.fact.owner && this.definition(s.file.path, s.fact.owner);
            if (definition && definition.fact.kind !== 'closure' && definition.fact.kind !== 'async')
                return definition;
        }
        return;
    }
    private binding(scope: RustScope, name: string, at: number): {
        binding: RustBindingFact;
        scope: RustScope;
        captured: boolean;
    } | undefined {
        let crossedFunction = false;
        for (const s of this.chain(scope)) {
            const bindings = this.units.get(s.file.path)?.bindings.get(s.fact.key + '\0' + name)?.filter(b => b.activation <= at && rustAttributes(b.attributes, s.compilation.environment).active !== false).sort((a, b) => b.activation - a.activation || b.start - a.start) ?? [];
            if (bindings.length)
                return { binding: bindings[0]!, scope: s, captured: crossedFunction };
            if (s.fact.owner) {
                const definition = this.definition(s.file.path, s.fact.owner);
                if (definition && !['closure', 'async'].includes(definition.fact.kind))
                    crossedFunction = true;
            }
            if (['file', 'module'].includes(s.fact.kind))
                break;
        }
        return;
    }
    private bindingValue(scope: RustScope, name: string, at: number, frame: RustFrame | undefined, trail: Set<string>): RustValue | undefined {
        const bound = this.binding(scope, name, at);
        if (!bound)
            return;
        const { binding, scope: declared, captured } = bound, key = declared.id + ':' + binding.start + ':' + name, proof = this.proof(declared.file.path, binding, `Original Rust ${binding.kind} binding ${name}`), attrs = this.attributes(declared, binding.attributes);
        if (captured)
            return unknown('Named Rust function/impl items cannot capture outer locals', proof);
        if (attrs.active !== true || attrs.gaps.length || binding.gaps.length)
            return unknown(attrs.active === false ? 'Inactive Rust local binding' : 'Conditional/opaque original Rust binding', proof, unique([...attrs.gaps, ...binding.gaps]));
        if (trail.has(key))
            return unknown('Cyclic original Rust local alias', proof);
        const next = new Set(trail);
        next.add(key);
        const writes = this.facts(declared.file.path)?.writes.filter(w => w.start >= binding.activation && w.target.kind === 'path' && w.target.segments.length === 1 && w.target.segments[0] === name && this.binding(this.scope(declared.file.path, w.scope, declared.compilation.id) ?? declared, name, w.start)?.binding === binding) ?? [];
        if (binding.kind === 'parameter' && (binding.mutable || writes.length))
            return unknown('Mutable Rust parameter requires flow inference', proof);
        if (binding.kind === 'parameter' && frame?.owner === this.ownerKey(declared.file.path, declared.fact.key) && frame?.parameters?.has(name) && !binding.mutable)
            return frame.parameters.get(name)!;
        if (name === 'self' && binding.kind === 'parameter') {
            const definition = this.enclosingDefinition(declared), receiver = definition?.fact.parameters.find(p => p.name === 'self'), impl = definition?.fact.impl && definition.unit.facts.impls.find(i => i.key === definition.fact.impl), parent = impl && this.scope(declared.file.path, impl.parent, declared.compilation.id);
            if (!impl || impl.trait || impl.generics || !parent || !receiver || !receiver.receiver || receiver.receiver === 'opaque')
                return unknown('Unreviewed Rust self/trait receiver', proof);
            const value = this.typeValue(parent, impl.type, next);
            return value.kind === 'type' ? { ...value, kind: 'instance', references: receiver.receiver === 'value' ? [] : [receiver.receiver === 'mutable' ? 'mutable' : 'shared'], proof: [...proof, ...value.proof] } : value;
        }
        const annotation = binding.type && this.typeValue(declared, binding.type, next);
        if (annotation?.kind === 'type')
            return { ...annotation, kind: 'instance', proof: [...proof, ...annotation.proof] };
        if (binding.mutable || writes.length)
            return unknown('Mutable/reassigned/escaped Rust operand has no fixed callback', proof);
        if (binding.value) {
            const value = this.value(declared, binding.value, frame, next);
            return value.kind === 'type' ? { ...value, kind: 'instance', proof: [...proof, ...value.proof] } : { ...value, proof: [...proof, ...value.proof] };
        }
        return unknown('Original Rust parameter/local operand requires caller/type inference', proof);
    }
    private implType(scope: RustScope, impl: RustImplFact): RustValue {
        const key = scope.compilation.id + ':' + scope.file.path + ':' + impl.key, known = this.methodTypes.get(key);
        if (known)
            return known;
        const parent = this.scope(scope.file.path, impl.parent, scope.compilation.id), value = parent ? this.typeValue(parent, impl.type) : unknown('Original Rust impl parent is unavailable');
        this.methodTypes.set(key, value);
        return value;
    }
    private member(value: Extract<RustValue, {
        kind: 'type' | 'instance';
    }>, name: string, from: RustScope, method: boolean): RustValue {
        const compiler = value.symbol.scope.compilation.id, candidates: {
            definition: RustDefinition;
            scope: RustScope;
            impl?: RustImplFact;
        }[] = [], traits: RustImplFact[] = [];
        if (method && value.kind === 'instance')
            for (const { unit, impl } of this.traitImpls) {
                if (++this.operations > 500000)
                    return unknown('Rust semantic lookup budget exceeded');
                for (const scope of (this.resolver.membership.get(unit.file.path) ?? []).filter(s => s.fact.key === impl.scope && s.compilation.invocation === from.compilation.invocation && s.active !== false)) {
                    const target = this.implType(scope, impl);
                    if (target.kind === 'unknown' || target.kind === 'type' && target.symbol.id === value.symbol.id && target.symbol.scope.compilation.id === compiler)
                        traits.push(impl);
                }
            }
        for (const definition of this.members.get(name) ?? []) {
            if (++this.operations > 500000)
                return unknown('Rust semantic lookup budget exceeded');
            const unit = definition.unit;
            if (method) {
                const impl = definition.fact.impl && unit.facts.impls.find(i => i.key === definition.fact.impl);
                if (!impl)
                    continue;
                const scope = this.scope(unit.file.path, impl.scope, compiler);
                if (!scope || scope.active === false)
                    continue;
                const target = this.implType(scope, impl);
                if (impl.trait && target.kind === 'unknown') {
                    traits.push(impl);
                    continue;
                }
                if (target.kind !== 'type' || target.symbol.id !== value.symbol.id)
                    continue;
                if (impl.trait) {
                    traits.push(impl);
                    continue;
                }
                candidates.push({ definition, scope, impl });
            }
            else if (definition.fact.kind === 'field' && definition.fact.parent) {
                const owner = unit.definitions.get(definition.fact.parent), scope = this.scope(unit.file.path, definition.fact.scope, compiler);
                if (owner?.id === value.symbol.id && scope)
                    candidates.push({ definition, scope });
            }
        }
        const visible = candidates.filter(c => this.resolver.visible(this.sourceSymbol(c.definition, c.scope), from));
        if (visible.length !== 1)
            return unknown(visible.length ? 'Competing original Rust impl/member declarations' : 'No accessible original Rust ' + (method ? 'inherent method' : 'field') + ' ' + name, value.proof);
        const selected = visible[0]!, symbol = this.sourceSymbol(selected.definition, selected.scope), conditions = unique([...value.conditions, ...symbol.gaps, ...symbol.active === 'unknown' ? ['Unselected original Rust impl/member cfg'] : [], ...selected.impl?.generics ? ['Generic Rust inherent impl selection is unreviewed'] : [], ...selected.definition.fact.generics ? ['Generic Rust callable instantiation is unreviewed'] : []]);
        if (method) {
            const receiver = selected.definition.fact.parameters.find(p => p.name === 'self')?.receiver;
            if (value.kind === 'instance') {
                if (!receiver || receiver === 'opaque')
                    return unknown('Rust dot calls require a reviewed original receiver', value.proof, conditions);
                const expected = receiver === 'value' ? [] : [receiver], exact = JSON.stringify(expected) === JSON.stringify(value.references);
                const preludeCompetitor = ['clone', 'clone_from', 'into', 'try_into', 'to_owned', 'to_string', 'borrow', 'borrow_mut', 'as_ref', 'as_mut', 'drop', 'eq', 'ne', 'cmp', 'partial_cmp', 'lt', 'le', 'gt', 'ge', 'into_iter', 'into_future', 'poll'].includes(name), externalTraits = this.chain(from).some(s => s.imports.some(i => this.resolver.resolve(i).status === 'external'));
                if (!exact && (traits.length || preludeCompetitor || externalTraits))
                    return unknown('Rust autoref/deref or trait precedence can change the method target', value.proof, conditions);
                if (value.references.length > 1 || value.references.length === 1 && !exact)
                    return unknown('Unreviewed Rust receiver dereference/coercion search', value.proof, conditions);
            }
            return { kind: 'callable', definitions: [{ definition: selected.definition, scope: selected.scope }], proof: [...value.proof, ...symbol.proof], conditions };
        }
        return { kind: 'source', definition: selected.definition, scope: selected.scope, proof: [...value.proof, ...symbol.proof], conditions };
    }
    value(scope: RustScope, expression: RustExpression, frame?: RustFrame, trail = new Set<string>()): RustValue {
        if (++this.operations > 500000 || trail.size > 128)
            return unknown('Rust semantic lookup budget exceeded');
        if (this.facts(scope.file.path)?.complete !== true)
            return unknown('Incomplete original Rust semantic syntax', [], ['Incomplete original Rust semantic syntax']);
        const gap = scope.active !== true ? scope.active === false ? 'Inactive original Rust scope' : 'Unselected original Rust scope' : scope.gaps[0];
        if (gap)
            return unknown(gap, [], scope.gaps);
        switch (expression.kind) {
            case 'path': {
                if (expression.qualified || !expression.segments.length)
                    return unknown('Trait-qualified Rust dispatch is unreviewed');
                const parts = expression.segments, head = parts[0]!;
                if (!expression.absolute && parts.length === 1) {
                    if (head === 'Self')
                        return this.typeValue(scope, { ...expression, kind: 'path', text: 'Self', generics: !!expression.generics?.length });
                    const bound = this.bindingValue(scope, head, expression.start, frame, trail);
                    if (bound)
                        return bound;
                }
                if (!expression.absolute && parts.length > 1 && this.binding(scope, head, expression.start))
                    return unknown('Rust local operands cannot supply associated path namespaces');
                const direct = this.fromResolution(this.resolver.path(scope, parts, expression.absolute, new Set(), 'expression'), scope, false, trail);
                if (direct.kind !== 'unknown')
                    return direct;
                for (let count = parts.length - 1; count > 0; count--) {
                    const owner = this.typeValue(scope, { ...expression, kind: 'path', text: parts.slice(0, count).join('::'), segments: parts.slice(0, count), generics: !!expression.generics?.length });
                    if (owner.kind === 'type' && parts.length - count === 1)
                        return this.member(owner, parts.at(-1)!, scope, true);
                }
                return direct;
            }
            case 'closure': {
                const definition = this.definition(scope.file.path, expression.key);
                return definition ? { kind: 'callable', definitions: [{ definition, scope }], proof: this.proof(scope.file.path, expression, 'Original Rust closure operand'), conditions: [] } : unknown('Original Rust closure identity is unavailable');
            }
            case 'async': {
                const definition = this.definition(scope.file.path, expression.key);
                return { kind: 'future', definition, proof: this.proof(scope.file.path, expression, 'Original Rust deferred async block'), conditions: [] };
            }
            case 'reference': {
                const value = this.value(scope, expression.value, frame, trail);
                if (value.kind === 'type' || value.kind === 'instance')
                    return { ...value, kind: 'instance', references: [expression.mutable ? 'mutable' : 'shared', ...value.references] };
                return expression.mutable ? unknown('Mutable Rust callable borrow is unreviewed', value.proof) : value;
            }
            case 'deref': {
                const value = this.value(scope, expression.value, frame, trail);
                if ((value.kind === 'type' || value.kind === 'instance') && value.references.length)
                    return { ...value, references: value.references.slice(1) };
                return value.kind === 'callable' ? value : unknown('Rust dereference/trait dispatch is unreviewed', value.proof);
            }
            case 'paren': return this.value(scope, expression.value, frame, trail);
            case 'await': {
                const value = this.value(scope, expression.value, frame, trail);
                return value.kind === 'future' && value.result ? value.result : unknown('Original Rust future result/polling inference is unavailable', value.proof);
            }
            case 'cast': return expression.type.kind === 'function' ? this.value(scope, expression.value, frame, trail) : unknown('Rust cast/coercion target is unreviewed');
            case 'struct': {
                const value = this.typeValue(scope, expression.type, trail);
                return value.kind === 'type' ? { ...value, kind: 'instance' } : value;
            }
            case 'field': {
                const receiver = this.value(scope, expression.value, frame, trail);
                return receiver.kind === 'instance' ? this.member(receiver, expression.name, scope, false) : receiver.kind === 'external' ? { ...receiver, name: receiver.name + '.' + expression.name } : unknown('Rust field receiver/type inference is unavailable', receiver.proof);
            }
            case 'tuple': return { kind: 'tuple', values: expression.values.map(value => this.value(scope, value, frame, trail)), proof: [], conditions: [] };
            case 'call': {
                const target = this.callee(scope, expression, frame, trail);
                if (target.kind === 'type')
                    return { ...target, kind: 'instance' };
                if (target.kind !== 'callable' || target.definitions.length !== 1)
                    return unknown('Original Rust call result is unavailable', target.proof, target.conditions);
                const selected = target.definitions[0]!;
                if (target.conditions.length)
                    return unknown(target.conditions.join('; '), target.proof, target.conditions);
                const key = selected.scope.compilation.id + ':return:' + selected.definition.id;
                if (trail.has(key))
                    return unknown('Recursive Rust return summary is unreviewed', target.proof);
                const next = new Set(trail);
                next.add(key);
                const arguments_ = expression.args.map(arg => this.value(scope, arg, frame, trail));
                if (expression.callee.kind === 'field')
                    arguments_.unshift(this.value(scope, expression.callee.value, frame, trail));
                const result = this.returnValue(selected.definition, selected.scope, arguments_, next);
                return selected.definition.fact.async ? { kind: 'future', definition: selected.definition, result, proof: target.proof, conditions: target.conditions } : result;
            }
            case 'block': return unknown('Rust block result inference is unavailable');
            default: return unknown('Original Rust operand requires compiler/runtime inference');
        }
    }
    callee(scope: RustScope, expression: RustExpression & {
        kind: 'call';
    }, frame?: RustFrame, trail = new Set<string>()): RustValue {
        if (expression.callee.kind === 'field') {
            const receiver = this.value(scope, expression.callee.value, frame, trail);
            return receiver.kind === 'instance' ? this.checkedCall(this.member(receiver, expression.callee.name, scope, true), expression, true) : receiver.kind === 'external' ? { ...receiver, name: receiver.name + '.' + expression.callee.name } : unknown('Rust method receiver/type inference is unavailable', receiver.proof, receiver.conditions);
        }
        return this.checkedCall(this.value(scope, expression.callee, frame, trail), expression, false);
    }
    private checkedCall(value: RustValue, expression: RustExpression & {
        kind: 'call';
    }, dot: boolean): RustValue {
        if (value.kind !== 'callable' || value.definitions.length !== 1)
            return value;
        const definition = value.definitions[0]!.definition, parameters = definition.fact.parameters;
        if (expression.args.length !== parameters.length - (dot ? 1 : 0))
            return unknown('Original Rust call argument/receiver count does not match the source declaration', value.proof);
        if (definition.fact.generics)
            return { ...value, conditions: unique([...value.conditions, 'Generic Rust callable instantiation is unreviewed']) };
        return value;
    }
    private returnValue(def: RustDefinition, scope: RustScope, args: RustValue[], trail: Set<string>): RustValue {
        const body = def.fact.body && this.scope(def.unit.file.path, def.fact.body, scope.compilation.id);
        if (!body)
            return unknown('Original Rust function body is unavailable');
        const annotation = def.fact.returnType && this.typeValue(body, def.fact.returnType, trail);
        if (annotation?.kind === 'type')
            return { ...annotation, kind: 'instance' };
        const parameters = new Map<string, RustValue>();
        for (const [index, p] of def.fact.parameters.entries())
            if (p.name && args[index])
                parameters.set(p.name, args[index]!);
        const returns = def.unit.facts.returns.filter(r => r.owner === def.fact.key);
        if (returns.length !== 1 || returns[0]!.conditional)
            return unknown('Conditional/multiple Rust return summary is unreviewed');
        const selected = returns[0]!, selectedScope = this.scope(def.unit.file.path, selected.scope, scope.compilation.id);
        return selectedScope ? this.value(selectedScope, selected.value, { parameters, owner: def.fact.key }, trail) : unknown('Original Rust return scope is unavailable');
    }
    handler(scope: RustScope, expression: RustExpression, frame?: RustFrame): RustHandler {
        // Handler lookup is a separate bounded request. A cold index must have
        // the same allowance as a service reconstructed after cached replay.
        this.operations = 0;
        const value = this.value(scope, expression, frame);
        if (value.kind !== 'callable' || value.definitions.length !== 1 || value.conditions.length)
            return { status: 'unresolved', reason: value.kind === 'unknown' ? value.reason : value.conditions.join('; ') || 'No unique original Rust callable', proof: value.proof };
        const target = value.definitions[0]!;
        return target.definition.fact.body ? { status: 'resolved', definition: target.definition, scope: target.scope, proof: value.proof, conditions: [] } : { status: 'unresolved', reason: 'Original Rust callable has no source body', proof: value.proof };
    }
    declareAnonymous(): void {
        for (const unit of this.units.values())
            for (const definition of unit.definitions.values())
                if (['closure', 'async'].includes(definition.fact.kind)) {
                    const fact = definition.fact, parent = this.ownerKey(unit.file.path, fact.scope), parentId = parent ? unit.definitions.get(parent)?.id ?? this.context.syntax?.get(unit.file.path)?.declarations.get(parent) ?? unit.file.id : unit.file.id;
                    if (!this.context.graph.entities.has(definition.id)) {
                        const content = this.resolver.projects.sources.readFile(unit.file.path) ?? '', proof = this.proof(unit.file.path, fact, `Original Rust ${fact.kind} declaration`);
                        this.context.graph.contain({ id: definition.id, type: 'function', name: fact.name, path: unit.file.path, language: 'rust', parentId, sourceRange: fact.range, metrics: { loc: fact.range.endLine - fact.range.startLine + 1 }, metadata: { declarationKind: fact.kind, role: fact.kind, signature: fact.kind, async: fact.async, deferred: fact.kind === 'async' || fact.async, ...declarationHashes(content.slice(fact.start, fact.end), 0) }, evidence: proof });
                    }
                }
    }
    analyze(): void {
        this.declareAnonymous();
        this.operations = 0;
        let remaining = 200000;
        const coverage = new Map<string, Map<string, {
            status: string;
            name: string;
            target?: string;
        }[]>>();
        for (const unit of this.units.values()) {
            const fileEntity = this.context.graph.entities.get(unit.file.id)!, analysis = fileAnalysis(fileEntity.metadata.analysis), contexts = this.resolver.membership.get(unit.file.path) ?? [], calls: unknown[] = [], references: unknown[] = [];
            const countsByScope = new Map<string, number>();
            for (const scope of contexts)
                countsByScope.set(scope.fact.key, (countsByScope.get(scope.fact.key) ?? 0) + 1);
            const estimated = [...unit.facts.calls, ...unit.facts.references].reduce((n, s) => n + (countsByScope.get(s.scope) ?? 0), 0);
            if (estimated > remaining) {
                fileEntity.metadata.rustCallOutcomes = [];
                fileEntity.metadata.rustReferenceOutcomes = [];
                if (analysis)
                    analysis.features.references = { status: 'failed', reason: 'Rust compilation-scoped semantic outcome budget exceeded' };
                this.context.graph.diagnose({ analyzer: 'rust-symbols', severity: 'warning', code: 'rust-semantic-budget', file: unit.file.path, entityId: unit.file.id, reason: 'Rust compilation-scoped semantic outcome budget exceeded' });
                continue;
            }
            remaining -= estimated;
            for (const [kind, sites] of [['call', unit.facts.calls], ['reference', unit.facts.references]] as const)
                for (const site of sites)
                    for (const scope of contexts.filter(s => s.fact.key === site.scope)) {
                        const attrs = this.attributes(scope, site.attributes), expression = site.expression, value = !unit.facts.complete ? unknown('Incomplete original Rust semantic syntax', [], ['Incomplete original Rust semantic syntax']) : kind === 'call' ? this.callee(scope, expression as RustExpression & {
                            kind: 'call';
                        }) : (site as RustSemanticFacts['references'][number]).kind === 'type' && expression.kind === 'path' ? this.typeValue(scope, { ...expression, kind: 'path', text: expression.segments.join('::'), generics: !!expression.generics?.length }) : this.value(scope, expression);
                        const targets = value.kind === 'callable' ? value.definitions.map(d => d.definition.id) : value.kind === 'type' || value.kind === 'instance' ? [value.symbol.id] : value.kind === 'source' ? [value.definition.id] : value.kind === 'future' && value.definition ? [value.definition.id] : [], conditions = unique([...attrs.gaps, ...value.conditions]), status = attrs.active === false ? 'excluded' : attrs.active !== true || conditions.length ? 'unsupported' : value.kind === 'external' ? 'external' : targets.length === 1 && (kind === 'reference' || value.kind === 'callable') ? 'resolved' : 'unresolved';
                        const owner = this.owner(scope), proof = [...this.proof(unit.file.path, site, `Original Rust ${kind} operand`), ...scope.compilation.proof, ...value.proof], metadata = { adapter: 'rust', version: RUST_SYMBOL_VERSION, compilation: scope.compilation.id, crate: scope.compilation.target.id, invocation: scope.compilation.invocation, scope: scope.id, owner, start: site.start, range: site.range, status, ...status === 'resolved' ? { target: targets[0] } : {}, ...value.kind === 'external' ? { external: value.name } : {}, ...status !== 'resolved' ? { reason: conditions.length ? conditions.join('; ') : value.kind === 'unknown' ? value.reason : 'No unique original Rust callable/reference' } : {}, conditions, proof };
                        if (kind === 'call') {
                            const call = site as RustSemanticFacts['calls'][number], target = value.kind === 'callable' ? value.definitions[0]?.definition : undefined;
                            Object.assign(metadata, { name: expression.kind === 'call' ? this.describe(expression.callee) : '', execution: target?.fact.async ? call.awaited ? 'awaited' : 'future-construction' : 'direct', awaited: call.awaited });
                            calls.push(metadata);
                            const sites = coverage.get(owner) ?? new Map(), key = unit.file.path + ':' + site.start, rows = sites.get(key) ?? [];
                            rows.push({ status, name: this.describe(expression), ...status === 'resolved' ? { target: targets[0] } : {} });
                            sites.set(key, rows);
                            coverage.set(owner, sites);
                        }
                        else
                            references.push({ ...metadata, kind: (site as RustSemanticFacts['references'][number]).kind });
                        if (status === 'resolved')
                            this.context.graph.relate(owner, targets[0]!, kind === 'call' ? 'calls' : 'references', proof, { ...metadata, dispatch: kind === 'call' ? 'direct' : undefined }, JSON.stringify([scope.compilation.id, scope.id, site.start, kind]));
                        else if (status !== 'external' && status !== 'excluded')
                            this.context.graph.diagnose({ analyzer: 'rust-symbols', severity: 'warning', code: `rust-${kind}-${status}`, file: unit.file.path, entityId: owner, line: site.range.startLine, reason: String((metadata as {
                                    reason?: string;
                                }).reason ?? 'Rust operand is unreviewed') });
                    }
            fileEntity.metadata.rustCallOutcomes = calls;
            fileEntity.metadata.rustReferenceOutcomes = references;
            if (analysis)
                analysis.features.references = !unit.facts.complete ? { status: 'failed', reason: 'Original Rust semantic syntax is incomplete' } : !contexts.length ? { status: 'disabled', reason: 'Source is outside the selected Cargo compilation/module graph' } : { status: 'partial', reason: 'Compilation-scoped original references, immutable aliases, source closures and direct functions/inherent methods; generic/trait/autoref/borrow/compiler/generated dispatch remains bounded' };
        }
        for (const [owner, sites] of coverage) {
            const counts: CallSites = { resolved: 0, external: 0, unresolved: 0, unresolvedNames: {} };
            for (const rows of sites.values()) {
                const active = rows.filter(r => r.status !== 'excluded');
                if (!active.length)
                    continue;
                if (active.every(r => r.status === 'resolved') && new Set(active.map(r => r.target)).size === 1)
                    counts.resolved++;
                else if (active.every(r => r.status === 'external'))
                    counts.external++;
                else {
                    counts.unresolved++;
                    const name = active[0]!.name;
                    counts.unresolvedNames![name] = (counts.unresolvedNames![name] ?? 0) + 1;
                }
            }
            const entity = this.context.graph.entities.get(owner);
            if (entity)
                entity.metadata.callSites = counts;
        }
    }
    private describe(expression: RustExpression): string { return expression.kind === 'path' ? (expression.absolute ? '::' : '') + expression.segments.join('::') : expression.kind === 'field' ? this.describe(expression.value) + '.' + expression.name : expression.kind === 'call' ? this.describe(expression.callee) : expression.kind === 'closure' ? '<closure>' : expression.kind; }
}
export const rustSymbolsAnalyzer: Analyzer = { name: 'rust-symbols', version: RUST_SYMBOL_VERSION, async analyze(context) {
        if (![...context.files.values()].some(file => file.language === 'rust' && file.analyzable))
            return;
        for (const file of context.files.values())
            if (file.language === 'rust' && file.analyzable && !context.syntax?.get(file.path)?.facts.rust?.semantic) {
                const analysis = fileAnalysis(context.graph.entities.get(file.id)?.metadata.analysis);
                if (analysis)
                    analysis.features.references = { status: 'failed', reason: 'Original Rust semantic syntax is unavailable' };
            }
        const resolver = context.rust ??= new RustResolver(context), symbols = context.rustSymbols = new RustSymbols(context, resolver), run = async () => symbols.analyze();
        const key = { version: RUST_SYMBOL_VERSION, resolver: RUST_RESOLVER_VERSION, syntax: STRUCTURE_VERSION, config: context.config, projects: resolver.projects.describe(), compilations: resolver.projects.describeCompilations(), files: [...context.files.values()].filter(f => f.language === 'rust' || f.language === 'toml').map(f => [fileKey(context, f.path), !!context.syntax?.get(f.path)?.facts.rust?.semantic?.complete]), inventory: [...context.fileInventory ?? []].sort(), directories: [...context.directoryInventory ?? []].sort() };
        if (context.cache)
            await context.cache.unit(context, 'rust-symbols', 'repository', key, run);
        else
            await run();
    } };
