import type { AnalysisContext, ScannedFile } from '../../core/analyzer.js';
import { declarationHashes, evidence, type CallSites, type Evidence } from '../../core/graph.js';
import { fileAnalysis, type CsharpBindingFact, type CsharpDefinitionFact, type CsharpExpression, type CsharpImportFact, type CsharpScope, type CsharpSemanticFacts } from '../facts.js';
import { CsharpResolver, type CsharpEnvironment, type CsharpSymbol } from '../resolution/csharp.js';
import type { CsharpType } from './csharp-types.js';
export const CSHARP_SYMBOL_VERSION = '2';
const typeKinds = new Set(['class', 'interface', 'struct', 'enum', 'record', 'type']), callableKinds = new Set(['method', 'constructor', 'function', 'lambda', 'top-level']);
const primitives: Record<string, string> = { bool: 'System.Boolean', byte: 'System.Byte', sbyte: 'System.SByte', char: 'System.Char', decimal: 'System.Decimal', double: 'System.Double', float: 'System.Single', int: 'System.Int32', uint: 'System.UInt32', long: 'System.Int64', ulong: 'System.UInt64', short: 'System.Int16', ushort: 'System.UInt16', string: 'System.String', object: 'System.Object', void: 'System.Void' };
interface Unit {
    file: ScannedFile;
    facts: CsharpSemanticFacts;
    scopes: Map<string, CsharpScope>;
    definitions: Map<string, CsharpDefinition>;
    names: Map<string, Map<string, (CsharpDefinition | CsharpBindingFact)[]>>;
}
export interface CsharpDefinition {
    id: string;
    fact: CsharpDefinitionFact;
    unit: Unit;
    symbol?: CsharpSymbol;
}
export type CsharpValue = {
    kind: 'type' | 'instance';
    type: CsharpType;
    exact?: boolean;
    proof: Evidence[];
} | {
    kind: 'namespace';
    name: string;
    proof: Evidence[];
} | {
    kind: 'callable';
    definitions: CsharpDefinition[];
    direct: boolean;
    exact?: boolean;
    receiver?: 'type' | 'instance' | 'lexical';
    reason?: string;
    proof: Evidence[];
} | {
    kind: 'field';
    definition: CsharpDefinition;
    proof: Evidence[];
} | {
    kind: 'primitive';
    name: string;
    proof: Evidence[];
} | {
    kind: 'external';
    names: string[];
    proof: Evidence[];
} | {
    kind: 'unknown';
    reason: string;
    proof: Evidence[];
};
export type CsharpHandler = {
    status: 'resolved';
    definition: CsharpDefinition;
    proof: Evidence[];
    conditions: string[];
} | {
    status: 'unresolved';
    reason: string;
    proof: Evidence[];
};
const unknown = (reason: string, proof: Evidence[] = []): CsharpValue => ({ kind: 'unknown', reason, proof });
/** Original C# binding in selected source compilations. A source method is a
 * direct target only after lexical, visibility, signature and dispatch checks. */
export class CsharpSymbols {
    private readonly units = new Map<string, Unit>();
    private readonly byId = new Map<string, CsharpDefinition>();
    private readonly selectedParameters = new Map<string, (string | undefined)[]>();
    private readonly conflictingContracts = new Set<string>();
    private readonly frameworkTypes = new Map<string, {
        names: Set<string>;
        implicit: boolean;
        proof: Evidence[];
    }>();
    private operations = 0;
    private depth = 0;
    constructor(readonly context: AnalysisContext, readonly resolver: CsharpResolver) {
        for (const file of context.files.values()) {
            const parsed = context.syntax?.get(file.path), facts = parsed?.facts.csharp?.semantic;
            if (!facts?.complete)
                continue;
            const unit: Unit = { file, facts, scopes: new Map(facts.scopes.map(scope => [scope.key, scope])), definitions: new Map(), names: new Map() };
            this.units.set(file.path, unit);
            const ordinals = new Map<string, number>(), selection = resolver.projects.selection(file.path);
            for (const fact of facts.definitions) {
                const owner = this.owner(unit, fact.scope), ordinal = ordinals.get(owner) ?? 0, id = fact.kind === 'lambda' ? context.graph.id('symbol', 'csharp', file.path, owner, 'lambda', String(ordinal)) : fact.kind === 'top-level' ? context.graph.id('symbol', 'csharp', file.path, 'top-level') : parsed!.declarations.get(fact.key);
                if (!id)
                    continue;
                if (fact.kind === 'lambda')
                    ordinals.set(owner, ordinal + 1);
                const symbol = resolver.symbols.find(symbol => symbol.id === id && symbol.project.id === selection.project?.id), definition = { id, fact, unit, symbol };
                unit.definitions.set(fact.key, definition);
                this.byId.set(id, definition);
                if (!['lambda', 'top-level'].includes(fact.kind))
                    this.add(unit, fact.scope, fact.name, definition);
            }
            for (const binding of facts.bindings)
                this.add(unit, binding.scope, binding.name, binding);
        }
    }
    private add(unit: Unit, scope: string, name: string, entry: CsharpDefinition | CsharpBindingFact) { const names = unit.names.get(scope) ?? new Map(), items = names.get(name) ?? []; items.push(entry); names.set(name, items); unit.names.set(scope, names); }
    definition(file: string, key: string): CsharpDefinition | undefined { return this.units.get(file)?.definitions.get(key); }
    definitions(file: string): CsharpDefinition[] { return [...this.units.get(file)?.definitions.values() ?? []]; }
    facts(file: string): CsharpSemanticFacts | undefined { return this.units.get(file)?.facts; }
    private proof(unit: Unit, site: {
        range: CsharpExpression['range'];
    }, reason: string): Evidence[] { return [{ ...evidence('syntax', 'csharp-symbols', unit.file.path, site.range.startLine, reason), analyzerVersion: CSHARP_SYMBOL_VERSION, endLine: site.range.endLine }]; }
    private chain(unit: Unit, scope: string): CsharpScope[] {
        const result: CsharpScope[] = [], seen = new Set<string>();
        let current = unit.scopes.get(scope);
        while (current && !seen.has(current.key) && result.length < 128) {
            seen.add(current.key);
            result.push(current);
            current = current.parent ? unit.scopes.get(current.parent) : undefined;
        }
        return result;
    }
    private owner(unit: Unit, scope: string): string {
        for (const item of this.chain(unit, scope))
            if (item.owner)
                return unit.definitions.get(item.owner)?.id ?? this.context.syntax?.get(unit.file.path)?.declarations.get(item.owner) ?? unit.file.id;
        return unit.file.id;
    }
    private enclosingTypes(unit: Unit, scope: string): CsharpType[] { return this.chain(unit, scope).flatMap(item => { const definition = item.owner ? unit.definitions.get(item.owner) : undefined, type = definition?.symbol && definition.symbol.syntax.type ? this.resolver.types.type(definition.symbol) : undefined; return type ? [type] : []; }); }
    private staticScope(unit: Unit, scope: string): boolean {
        for (const item of this.chain(unit, scope)) {
            if (item.kind === 'initializer')
                return true;
            const definition = item.owner ? unit.definitions.get(item.owner) : undefined;
            if (definition?.fact.kind === 'lambda' && !definition.fact.modifiers.includes('static'))
                continue;
            if (definition && !typeKinds.has(definition.fact.kind))
                return definition.fact.modifiers.includes('static');
        }
        return false;
    }
    private scopeGap(unit: Unit, scope: string): string | undefined {
        return [...this.chain(unit, scope).flatMap(item => item.gaps), ...this.enclosingTypes(unit, scope).flatMap(type => type.gaps)][0];
    }
    private environment(unit: Unit): Extract<CsharpEnvironment, {
        status: 'resolved';
    }> | undefined { const environment = this.resolver.environment(unit.file.path); return environment.status === 'resolved' ? environment : undefined; }
    private access(symbol: CsharpSymbol, unit: Unit, scope: string): boolean {
        const environment = this.environment(unit);
        if (!environment)
            return false;
        const enclosing = new Set(this.enclosingTypes(unit, scope).map(type => type.id)), seen = new Set<string>();
        let current: CsharpSymbol | undefined = symbol;
        while (current) {
            const key = JSON.stringify([current.project.id, current.file.path, current.syntax.key]);
            if (seen.has(key))
                return false;
            seen.add(key);
            const type = this.resolver.types.type(current), visibility = current.syntax.type ? type?.visibility ?? current.syntax.visibility : current.syntax.visibility, owner = current.syntax.type ? type?.parent : type?.id;
            if (type?.gaps.length || current.syntax.fileLocal && current.file.path !== unit.file.path)
                return false;
            if (visibility === 'private' || visibility === 'protected' || visibility === 'private protected') {
                if (!owner || !enclosing.has(owner))
                    return false;
            }
            else if (visibility === 'internal' || visibility === 'protected internal') {
                if (current.project.id !== environment.project.id)
                    return false;
            }
            else if (visibility !== 'public')
                return false;
            current = this.resolver.types.parentSymbol(current);
        }
        return true;
    }
    private fromType(type: CsharpType, unit: Unit, scope: string, proof: Evidence[]): CsharpValue {
        if (type.gaps.length)
            return unknown(type.gaps.join('; '), proof);
        if (type.parts.some(part => !this.access(part, unit, scope)))
            return unknown('Original source type is inaccessible', proof);
        if (type.arity || type.parent && this.resolver.types.types.get(type.parent)?.arity)
            return unknown('Constructed generic types require a reviewed substitution profile', proof);
        return { kind: 'type', type, proof: [...proof, ...type.proof] };
    }
    private memberDefinitions(type: CsharpType, name: string): CsharpDefinition[] { return this.resolver.types.members(type, name).flatMap(symbol => { const definition = this.byId.get(symbol.id); return definition ? [{ ...definition, symbol }] : []; }); }
    private direct(definition: CsharpDefinition, exact = false): boolean {
        const fact = definition.fact;
        if (!fact.hasBody || fact.gaps.length || fact.typeParameters.length || fact.modifiers.some(modifier => ['abstract', 'extern', 'unsafe'].includes(modifier)))
            return false;
        if (['lambda', 'function', 'top-level'].includes(fact.kind))
            return true;
        const type = definition.symbol ? this.resolver.types.type(definition.symbol) : undefined;
        if (type?.gaps.length || type?.arity || type?.kind === 'interface' || type?.kind === 'type')
            return false;
        if (fact.kind === 'constructor')
            return !fact.modifiers.includes('static');
        if (fact.modifiers.some(modifier => ['virtual', 'override'].includes(modifier)))
            return exact || fact.modifiers.includes('sealed') || !!type?.modifiers.includes('sealed');
        return fact.kind === 'method';
    }
    private fromDefinitions(definitions: CsharpDefinition[], unit: Unit, scope: string, proof: Evidence[], mode: 'type' | 'instance' | 'lexical' = 'lexical', exact = false): CsharpValue {
        if (!definitions.length)
            return unknown('Original member declaration is unavailable', proof);
        if (definitions.some(definition => definition.symbol && !this.access(definition.symbol, unit, scope)))
            return unknown('Original C# member is inaccessible', proof);
        const methods = definitions.filter(definition => callableKinds.has(definition.fact.kind));
        if (methods.length === definitions.length) {
            if (methods.some(definition => definition.fact.attributes.some(attribute => /(?:^|\.)OverloadResolutionPriority(?:Attribute)?$/.test(attribute.type))))
                return unknown('Overload-resolution priority attributes require a reviewed compiler profile', proof);
            const direct = methods.every(definition => this.direct(definition, exact));
            return { kind: 'callable', definitions: methods, direct, exact, receiver: mode, ...direct ? {} : { reason: 'Virtual/interface/generic/abstract or bodyless method has no exact original dispatch' }, proof: [...proof, ...methods.flatMap(definition => definition.symbol?.proof ?? this.proof(definition.unit, definition.fact, 'Original local callable'))] };
        }
        const typeSymbols = definitions.filter(definition => definition.symbol?.syntax.type).map(definition => definition.symbol!);
        if (typeSymbols.length === definitions.length) {
            const groups = [...new Set(typeSymbols.map(symbol => this.resolver.types.type(symbol)))].filter((type): type is CsharpType => !!type);
            return groups.length === 1 ? this.fromType(groups[0]!, unit, scope, proof) : unknown('Competing original logical source types', proof);
        }
        if (definitions.length !== 1)
            return unknown('Competing original fields/properties or member kinds', proof);
        const definition = definitions[0]!;
        if (definition.fact.kind === 'property') {
            if (mode === 'type' && !definition.fact.modifiers.some(modifier => ['static', 'const'].includes(modifier)) || mode === 'instance' && definition.fact.modifiers.some(modifier => ['static', 'const'].includes(modifier)) || mode === 'lexical' && this.staticScope(unit, scope) && !definition.fact.modifiers.some(modifier => ['static', 'const'].includes(modifier)))
                return unknown('Field/property receiver is incompatible', proof);
            return { kind: 'field', definition, proof: [...proof, ...definition.symbol?.proof ?? []] };
        }
        return unknown('Unsupported original declaration kind', proof);
    }
    private receiverMatches(definition: CsharpDefinition, unit: Unit, scope: string, mode: 'type' | 'instance' | 'lexical' = 'lexical'): boolean {
        return definition.fact.kind !== 'method' || !(mode === 'type' && !definition.fact.modifiers.includes('static') || mode === 'instance' && definition.fact.modifiers.includes('static') || mode === 'lexical' && this.staticScope(unit, scope) && !definition.fact.modifiers.includes('static'));
    }
    private imports(unit: Unit, start: number): {
        file: string;
        fact: CsharpImportFact;
        proof: Evidence[];
    }[] { return [...(this.resolver.facts(unit.file.path)?.imports ?? []).filter(fact => !fact.global && fact.scopeStart <= start && start < fact.scopeEnd).map(fact => ({ file: unit.file.path, fact, proof: this.proof(unit, fact, 'Original scoped using directive') })), ...this.resolver.globalImports(unit.file.path)]; }
    private namespaceExists(environment: Extract<CsharpEnvironment, {
        status: 'resolved';
    }>, name: string): boolean { return environment.projects.some(project => project.sources.some(file => this.resolver.facts(file)?.namespaces.some(namespace => namespace.name === name || namespace.name.startsWith(name + '.')))); }
    private sourceName(unit: Unit, scope: string, qualified: string, proof: Evidence[], arity = 0): CsharpValue | undefined {
        const environment = this.environment(unit);
        if (!environment)
            return unknown('Selected C# compilation is unavailable', proof);
        const types = [...new Set(environment.symbols.filter(symbol => symbol.syntax.type && symbol.syntax.qualifiedName === qualified && symbol.syntax.arity === arity && (!symbol.syntax.fileLocal || symbol.file.path === unit.file.path)).map(symbol => this.resolver.types.type(symbol)))].filter((type): type is CsharpType => !!type), namespace = this.namespaceExists(environment, qualified);
        if (types.length > 1 || types.length && namespace)
            return unknown('Competing source namespace/type declarations: ' + qualified, proof);
        if (types.length)
            return this.fromType(types[0]!, unit, scope, proof);
        return namespace ? { kind: 'namespace', name: qualified, proof } : undefined;
    }
    private importedAlias(unit: Unit, scope: string, item: ReturnType<CsharpSymbols['imports']>[number]): CsharpValue {
        const result = this.resolver.resolve(unit.file.path, item.fact);
        if (result.status === 'resolved') {
            if (result.namespace)
                return { kind: 'namespace', name: result.namespace, proof: [...item.proof, ...result.proof] };
            const groups = [...new Set(result.symbols.filter(symbol => symbol.syntax.type).map(symbol => this.resolver.types.type(symbol)))].filter((type): type is CsharpType => !!type);
            return groups.length === 1 ? this.fromType(groups[0]!, unit, scope, [...item.proof, ...result.proof]) : unknown('Alias has competing original types', item.proof);
        }
        if (result.status === 'external')
            return { kind: 'external', names: [result.dependency], proof: [...item.proof, ...result.proof] };
        return unknown(result.reason, item.proof);
    }
    private simpleName(unit: Unit, scope: string, name: string, start: number, typeOnly = false, absolute = false): CsharpValue {
        const proof = this.proof(unit, { range: { startLine: unit.scopes.get(scope)?.range.startLine ?? 1, endLine: unit.scopes.get(scope)?.range.startLine ?? 1 } }, 'Scoped C# name ' + name), environment = this.environment(unit);
        if (!environment)
            return unknown('Selected original C# compilation is unavailable', proof);
        if (!absolute) {
            let staticLambda = false;
            for (const item of this.chain(unit, scope)) {
                const owner = item.owner ? unit.definitions.get(item.owner) : undefined;
                if (owner?.fact.typeParameters.includes(name))
                    return unknown('Generic type parameter masks outer bindings', proof);
                const entries = unit.names.get(item.key)?.get(name);
                if (entries?.length) {
                    const bindings = entries.filter((entry): entry is CsharpBindingFact => !('id' in entry));
                    if (bindings.length) {
                        if (typeOnly)
                            return unknown('Local value masks a type name', proof);
                        if (bindings.length !== 1)
                            return unknown('Competing lexical bindings', proof);
                        if (staticLambda)
                            return unknown('Static anonymous function cannot capture this binding', proof);
                        return this.binding(unit, scope, bindings[0]!, start);
                    }
                    const definitions = entries.filter((entry): entry is CsharpDefinition => 'id' in entry);
                    if (item.kind !== 'type') {
                        if (staticLambda && definitions.some(definition => !definition.fact.modifiers.includes('static')))
                            return unknown('Static anonymous function cannot capture an outer local function', proof);
                        return this.fromDefinitions(definitions, unit, scope, proof);
                    }
                }
                if (item.kind === 'type' && owner?.symbol) {
                    const type = this.resolver.types.type(owner.symbol);
                    if (type) {
                        const members = this.memberDefinitions(type, name);
                        if (members.length)
                            return this.fromDefinitions(members, unit, scope, proof);
                        if (type.parts.some(part => part.syntax.bases.length))
                            return unknown('Inherited member/type lookup is unreviewed', proof);
                    }
                }
                if (owner?.fact.kind === 'lambda' && owner.fact.modifiers.includes('static'))
                    staticLambda = true;
            }
        }
        const namespace = absolute ? '' : unit.scopes.get(scope)?.namespace ?? '', imports = absolute ? [] : this.imports(unit, start);
        let current = namespace;
        while (true) {
            const aliases = imports.filter(item => item.fact.kind === 'alias' && item.fact.alias === name && item.fact.namespace === current), source = this.sourceName(unit, scope, [current, name].filter(Boolean).join('.'), proof);
            if (aliases.length) {
                const distinct = new Set(aliases.map(item => JSON.stringify([item.fact.specifier, item.fact.namespace, item.fact.global])));
                if (distinct.size > 1 || source)
                    return unknown('Alias collides with an original declaration or competing directive', proof);
                return this.importedAlias(unit, scope, aliases[0]!);
            }
            if (source)
                return source;
            const candidates: CsharpValue[] = [], externalNamespaces: string[] = [];
            for (const item of imports.filter(item => item.fact.namespace === current && item.fact.kind !== 'alias')) {
                const result = this.resolver.resolve(unit.file.path, item.fact);
                if (result.status === 'resolved') {
                    if (item.fact.kind === 'namespace' && result.namespace) {
                        const imported = this.sourceName(unit, scope, result.namespace + '.' + name, [...item.proof, ...result.proof]);
                        if (imported)
                            candidates.push(imported);
                    }
                    else if (item.fact.kind === 'static' && !typeOnly) {
                        const members = result.symbols.filter(symbol => symbol.syntax.name === name && !symbol.syntax.type);
                        if (members.length)
                            candidates.push(this.fromDefinitions(members.flatMap(symbol => { const definition = this.byId.get(symbol.id); return definition ? [{ ...definition, symbol }] : []; }), unit, scope, [...item.proof, ...result.proof], 'type'));
                    }
                    else if (item.fact.kind === 'static') {
                        for (const symbol of result.symbols.filter(symbol => symbol.syntax.name === name && symbol.syntax.type && symbol.syntax.parent)) {
                            const type = this.resolver.types.type(symbol);
                            if (type)
                                candidates.push(this.fromType(type, unit, scope, [...item.proof, ...result.proof]));
                        }
                    }
                }
                else if (result.status === 'external' && item.fact.kind === 'namespace')
                    externalNamespaces.push(result.dependency);
                else if ('reason' in result)
                    return unknown('A visible using is constrained: ' + result.reason, item.proof);
            }
            if (candidates.length) {
                const types = candidates.filter((value): value is Extract<CsharpValue, {
                    type: CsharpType;
                }> => value.kind === 'type');
                if (types.length === candidates.length) {
                    const unique = [...new Map(types.map(value => [value.type.id, value])).values()];
                    return unique.length === 1 ? unique[0]! : unknown('Several namespace imports provide the same type name', proof);
                }
                if (candidates.every(value => value.kind === 'callable')) {
                    const definitions = candidates.flatMap(value => value.kind === 'callable' ? value.definitions : []);
                    return this.fromDefinitions([...new Map(definitions.map(definition => [definition.id, definition])).values()], unit, scope, candidates.flatMap(value => value.proof), 'type');
                }
                return candidates.length === 1 ? candidates[0]! : unknown('Competing imported members', proof);
            }
            if (!current) {
                if (externalNamespaces.length)
                    return { kind: 'external', names: [...new Set(externalNamespaces.map(namespace => namespace + '.' + name))], proof };
                break;
            }
            current = current.includes('.') ? current.slice(0, current.lastIndexOf('.')) : '';
        }
        return unknown('No original lexical/namespace/import binding for ' + name, proof);
    }
    private named(unit: Unit, scope: string, name: string, start: number, typeOnly = false): CsharpValue {
        const absolute = name.startsWith('global::'), clean = name.replace(/^global::/, ''), alias = /^([\p{L}_][\p{L}\p{N}_]*)::(.*)$/u.exec(clean);
        let current: CsharpValue, segments: string[];
        if (alias) {
            const visible = this.imports(unit, start).filter(item => item.fact.kind === 'alias' && item.fact.alias === alias[1]);
            let namespace = unit.scopes.get(scope)?.namespace ?? '', items: typeof visible = [];
            while (true) {
                items = visible.filter(item => item.fact.namespace === namespace);
                if (items.length || !namespace)
                    break;
                namespace = namespace.includes('.') ? namespace.slice(0, namespace.lastIndexOf('.')) : '';
            }
            if (new Set(items.map(item => item.fact.specifier)).size !== 1)
                return unknown('Namespace alias qualifier is unavailable/ambiguous');
            current = this.importedAlias(unit, scope, items[0]!);
            if (current.kind !== 'namespace' && current.kind !== 'external')
                return unknown('Alias qualification requires a namespace');
            segments = alias[2]!.split('.');
        }
        else {
            segments = clean.split('.');
            const head = segments.shift()!;
            current = this.simpleName(unit, scope, head, start, typeOnly, absolute);
        }
        for (const segment of segments)
            current = this.member(unit, scope, current, segment, typeOnly);
        return current;
    }
    private typeValue(unit: Unit, scope: string, name: string, site: {
        start: number;
        range: CsharpExpression['range'];
    }): CsharpValue {
        if (primitives[name])
            return { kind: 'primitive', name: primitives[name]!, proof: this.proof(unit, site, 'Reserved C# type alias ' + name) };
        if (name === 'dynamic' || !/^(?:global::)?[\p{L}_][\p{L}\p{N}_]*(?:(?:\.|::)[\p{L}_][\p{L}\p{N}_]*)*$/u.test(name))
            return unknown('Dynamic/nullable/generic/array/pointer type requires a reviewed type profile');
        let value = this.named(unit, scope, name, site.start, true);
        const profile = this.frameworkTypes.get(this.resolver.projects.selection(unit.file.path).project?.id ?? '');
        if (profile && value.kind === 'unknown' && value.reason.startsWith('No original lexical/namespace/import binding for ')) {
            const clean = name.replace(/^global::/, ''), head = clean.split('.')[0]!;
            const candidates = profile.names.has(clean) ? [clean] : profile.implicit && !clean.includes('.') ? [...profile.names].filter(type => type.endsWith('.' + clean)) : [];
            if (candidates.length === 1 && value.reason === 'No original lexical/namespace/import binding for ' + head)
                value = { kind: 'external', names: candidates, proof: [...value.proof, ...profile.proof] };
        }
        if (value.kind === 'external' && value.names.length === 1 && Object.values(primitives).includes(value.names[0]!))
            return { kind: 'primitive', name: value.names[0]!, proof: value.proof };
        return value;
    }
    private member(unit: Unit, scope: string, value: CsharpValue, name: string, typeOnly = false): CsharpValue {
        if (value.kind === 'namespace')
            return this.sourceName(unit, scope, value.name + '.' + name, value.proof) ?? { kind: 'external', names: [value.name + '.' + name], proof: value.proof };
        if (value.kind === 'external')
            return { kind: 'external', names: value.names.map(value => value + '.' + name), proof: value.proof };
        if (value.kind === 'field')
            return this.member(unit, scope, this.field(unit, scope, value.definition, value.proof), name, typeOnly);
        if (value.kind === 'type' || value.kind === 'instance') {
            const members = this.memberDefinitions(value.type, name);
            if (!members.length)
                return unknown(value.type.parts.some(part => part.syntax.bases.length) ? 'Inherited member/extension lookup is unreviewed' : 'Original type has no declared member ' + name, value.proof);
            return this.fromDefinitions(members, unit, scope, value.proof, value.kind === 'type' ? 'type' : 'instance', value.exact ?? false);
        }
        return value.kind === 'unknown' ? value : unknown('Receiver has no reviewed original member binding', value.proof);
    }
    private signature(value: CsharpValue): string | undefined { return value.kind === 'primitive' ? value.name : value.kind === 'type' || value.kind === 'instance' ? value.type.id : value.kind === 'external' && value.names.length === 1 ? 'external:' + value.names[0] : undefined; }
    private mutated(unit: Unit, binding: CsharpBindingFact): boolean { return unit.facts.writes.some(write => write.target.kind === 'name' && write.target.name === binding.name && this.chain(unit, write.scope).some(scope => scope.key === binding.scope)); }
    private binding(unit: Unit, scope: string, binding: CsharpBindingFact, start: number): CsharpValue {
        if (binding.kind !== 'parameter' && start <= binding.end)
            return unknown('Future/uninitialized local masks outer bindings');
        if (binding.kind === 'parameter') {
            const owner = this.chain(unit, binding.scope).find(scope => scope.owner)?.owner, definition = owner ? unit.definitions.get(owner) : undefined, index = definition?.fact.parameters.findIndex(parameter => parameter.name === binding.name) ?? -1, selected = definition ? this.selectedParameters.get(definition.id)?.[index] : undefined;
            if (definition && this.conflictingContracts.has(definition.id))
                return unknown('Callback has competing selected parameter contracts');
            const type = binding.type ?? selected;
            if (!type)
                return unknown('Untyped callback/parameter needs a selected signature');
            const value = this.typeValue(unit, binding.scope, type, binding);
            return value.kind === 'type' ? { ...value, kind: 'instance', exact: false } : value;
        }
        if (binding.type) {
            const value = this.typeValue(unit, binding.scope, binding.type, binding);
            if (value.kind === 'type')
                return { ...value, kind: 'instance', exact: false };
            if (value.kind === 'primitive' || value.kind === 'external')
                return value;
            return value;
        }
        if (this.mutated(unit, binding))
            return unknown('Mutable inferred local/closure has writes or ref/out escape');
        if (!binding.value)
            return unknown('Uninitialized or opaque local');
        return this.bind(unit, binding.scope, binding.value);
    }
    private field(unit: Unit, scope: string, definition: CsharpDefinition, proof: Evidence[]): CsharpValue {
        const fact = definition.fact;
        if (fact.gaps.length)
            return unknown(fact.gaps.join('; '), proof);
        const declared = fact.returnType ? this.typeValue(definition.unit, fact.scope, fact.returnType, fact) : unknown('Original field type unavailable', proof);
        const writes = [...this.units.values()].some(other => other.facts.writes.some(write => write.target.kind === 'name' && write.target.name === fact.name || write.target.kind === 'member' && write.target.name === fact.name));
        if (fact.value && (fact.modifiers.includes('const') || fact.modifiers.includes('readonly') && !writes)) {
            const inferred = this.bind(definition.unit, fact.scope, fact.value);
            if (this.signature(declared) && this.signature(declared) === this.signature(inferred))
                return { ...inferred, proof: [...proof, ...inferred.proof] };
        }
        if (declared.kind === 'type')
            return { ...declared, kind: 'instance', exact: false };
        if (declared.kind === 'primitive' || declared.kind === 'external')
            return declared;
        return unknown('Field/property value has no reviewed original type', proof);
    }
    private bind(unit: Unit, scope: string, expression: CsharpExpression): CsharpValue {
        if (++this.operations > 1000000 || ++this.depth > 32) {
            this.depth--;
            return unknown('C# binding operation/inference budget exceeded');
        }
        try {
            const proof = this.proof(unit, expression, 'Original C# expression');
            if (expression.kind === 'name') {
                if (expression.name === 'this') {
                    if (this.staticScope(unit, scope))
                        return unknown('this is unavailable in a static scope', proof);
                    const type = this.enclosingTypes(unit, scope)[0];
                    return type ? { kind: 'instance', type, exact: type.modifiers.includes('sealed'), proof } : unknown('Enclosing original type unavailable', proof);
                }
                if (expression.name === 'base')
                    return unknown('Base receiver lookup/dispatch is unreviewed', proof);
                return this.named(unit, scope, expression.name, expression.start);
            }
            if (expression.kind === 'literal')
                return { kind: 'primitive', name: expression.type === 'null' ? 'null' : primitives[expression.type] ?? expression.type, proof };
            if (expression.kind === 'member')
                return this.member(unit, scope, this.bind(unit, scope, expression.object), expression.name);
            if (expression.kind === 'lambda') {
                const definition = unit.definitions.get(expression.key);
                return definition ? { kind: 'callable', definitions: [definition], direct: true, proof } : unknown('Original lambda definition unavailable', proof);
            }
            if (expression.kind === 'new') {
                const value = this.typeValue(unit, scope, expression.type, expression);
                if (value.kind === 'type') {
                    if (value.type.modifiers.some(modifier => ['abstract', 'static'].includes(modifier)) || value.type.kind === 'interface')
                        return unknown('Original type cannot be instantiated', value.proof);
                    return { kind: 'instance', type: value.type, exact: true, proof: value.proof };
                }
                return value;
            }
            if (expression.kind === 'cast')
                return unknown('Cast and conversion admissibility requires a reviewed type profile', proof);
            if (expression.kind === 'call') {
                const call = this.call(unit, scope, expression);
                if (call.status !== 'resolved')
                    return call.status === 'external' ? { kind: 'external', names: call.names, proof: call.proof } : unknown(call.reason, call.proof);
                const definition = call.definition;
                if (!definition.fact.returnType)
                    return unknown('Callable return type is unrecorded', call.proof);
                const type = this.typeValue(definition.unit, definition.fact.scope, definition.fact.returnType, definition.fact);
                const proof = [...call.proof, ...this.proof(definition.unit, definition.fact, 'Original selected callable return signature'), ...type.proof];
                return type.kind === 'type' ? { ...type, kind: 'instance', exact: false, proof } : { ...type, proof };
            }
            if (expression.kind === 'unary') {
                const value = this.bind(unit, scope, expression.value);
                return value.kind === 'primitive' && (value.name === primitives.bool && expression.operator === '!' || value.name === primitives.int && ['+', '-', '~'].includes(expression.operator)) ? value : unknown('Unary operator/promotion is unreviewed', proof);
            }
            if (expression.kind === 'binary') {
                const left = this.bind(unit, scope, expression.left), right = this.bind(unit, scope, expression.right);
                if (left.kind === 'primitive' && right.kind === 'primitive' && left.name === right.name) {
                    if (['==', '!='].includes(expression.operator) && [primitives.int, primitives.bool, primitives.string].includes(left.name) || left.name === primitives.int && ['<', '<=', '>', '>='].includes(expression.operator))
                        return { kind: 'primitive', name: primitives.bool!, proof };
                    if (left.name === primitives.int && ['+', '-', '*', '/', '%', '&', '|', '^'].includes(expression.operator) || left.name === primitives.bool && ['&&', '||', '&', '|', '^'].includes(expression.operator) || left.name === primitives.string && expression.operator === '+')
                        return left;
                }
                return unknown('Operator/conversion binding requires a reviewed type profile', proof);
            }
            return unknown('Opaque or unsupported original expression', proof);
        }
        finally {
            this.depth--;
        }
    }
    lookup(file: string, scope: string, expression: CsharpExpression): CsharpValue {
        const unit = this.units.get(file), environment = this.resolver.environment(file);
        if (!unit || environment.status !== 'resolved')
            return unknown(environment.status === 'resolved' ? 'Original semantic syntax unavailable' : environment.reason);
        const gap = this.scopeGap(unit, scope);
        return gap ? unknown(gap) : this.bind(unit, scope, expression);
    }
    private match(unit: Unit, scope: string, definitions: CsharpDefinition[], args: CsharpExpression[], names?: (string | undefined)[]): CsharpDefinition | undefined {
        const signatures = args.map(expression => this.signature(this.bind(unit, scope, expression)));
        if (signatures.some(signature => signature === undefined))
            return;
        const matching = definitions.filter(definition => {
            const parameters = definition.fact.parameters;
            if (parameters.length !== args.length || parameters.some(parameter => parameter.default || parameter.modifiers.some(modifier => ['ref', 'out', 'in', 'params', 'this', 'scoped'].includes(modifier))) || definition.fact.typeParameters.length)
                return false;
            const order = names?.some(Boolean) ? names.map((name, index) => name ? parameters.findIndex(parameter => parameter.name === name) : index) : parameters.map((_, index) => index);
            if (order?.some(index => index < 0) || new Set(order).size !== parameters.length)
                return false;
            return signatures.every((signature, index) => { const parameter = parameters[order?.[index] ?? index]; return !!parameter?.type && this.signature(this.typeValue(definition.unit, definition.fact.scope, parameter.type, definition.fact)) === signature; });
        });
        return matching.length === 1 ? matching[0] : undefined;
    }
    private call(unit: Unit, scope: string, expression: CsharpExpression): {
        status: 'resolved';
        definition: CsharpDefinition;
        proof: Evidence[];
    } | {
        status: 'external';
        names: string[];
        proof: Evidence[];
    } | {
        status: 'unresolved';
        reason: string;
        proof: Evidence[];
    } {
        if (expression.kind !== 'call' && expression.kind !== 'new')
            return { status: 'unresolved', reason: 'Opaque call syntax', proof: this.proof(unit, expression, 'Unreviewed call') };
        if (expression.args.some(argument => argument.modifier))
            return { status: 'unresolved', reason: 'ref/out/in argument dispatch is unreviewed', proof: [] };
        let value = expression.kind === 'new' ? this.typeValue(unit, scope, expression.type, expression) : this.bind(unit, scope, expression.callee);
        if (value.kind === 'field')
            value = this.field(unit, scope, value.definition, value.proof);
        if (value.kind === 'external')
            return { status: 'external', names: value.names, proof: value.proof };
        if (value.kind === 'unknown')
            return { status: 'unresolved', reason: value.reason, proof: value.proof };
        if (expression.kind === 'new' && value.kind === 'type') {
            if (value.type.modifiers.some(modifier => ['abstract', 'static'].includes(modifier)) || value.type.kind === 'interface')
                return { status: 'unresolved', reason: 'Original type cannot be instantiated', proof: value.proof };
            if (expression.initializer)
                return { status: 'unresolved', reason: 'Object/collection initializer and accessor effects are unreviewed', proof: value.proof };
            const constructors = this.resolver.types.members(value.type).filter(symbol => symbol.declaration.kind === 'constructor').flatMap(symbol => { const definition = this.byId.get(symbol.id); return definition ? [{ ...definition, symbol }] : []; });
            value = this.fromDefinitions(constructors, unit, scope, value.proof, 'instance', true);
        }
        if (value.kind !== 'callable')
            return { status: 'unresolved', reason: 'Expression is not a reviewed original callable', proof: value.proof };
        const definition = this.match(unit, scope, value.definitions, expression.args.map(argument => argument.value), expression.args.map(argument => argument.name));
        if (!definition)
            return { status: 'unresolved', reason: 'No unique exact original signature; conversions/optional/params/generic/ambiguous overloads remain unreviewed', proof: value.proof };
        if (!this.receiverMatches(definition, unit, scope, value.receiver))
            return { status: 'unresolved', reason: 'Static/instance selected member does not match its original receiver', proof: value.proof };
        if (!this.direct(definition, value.exact))
            return { status: 'unresolved', reason: value.reason ?? 'Selected original dispatch is not direct', proof: value.proof };
        return { status: 'resolved', definition, proof: value.proof };
    }
    handler(file: string, scope: string, expression: CsharpExpression, expected?: {
        parameters?: string[];
        returnType?: string;
        allowUntyped?: boolean;
        allowOptional?: boolean;
        allowExtension?: boolean;
        definitionIds?: string[];
    }): CsharpHandler {
        let value = this.lookup(file, scope, expression);
        const unit = this.units.get(file);
        if (value.kind === 'field' && unit)
            value = this.field(unit, scope, value.definition, value.proof);
        if (value.kind !== 'callable')
            return { status: 'unresolved', reason: value.kind === 'unknown' ? value.reason : 'Expression is not an original source callable', proof: value.proof };
        const candidates = value.definitions.filter(definition => {
            if (expected?.definitionIds && !expected.definitionIds.includes(definition.id))
                return false;
            if (expected?.parameters) {
                if (definition.fact.parameters.length !== expected.parameters.length)
                    return false;
                for (let index = 0; index < expected.parameters.length; index++) {
                    const parameter = definition.fact.parameters[index]!;
                    if (!parameter.type) {
                        if (!expected.allowUntyped || definition.fact.kind !== 'lambda')
                            return false;
                        continue;
                    }
                    const actual = this.signature(this.typeValue(definition.unit, definition.fact.scope, parameter.type, definition.fact)), selected = this.signature(this.typeValue(unit!, scope, expected.parameters[index]!, expression));
                    if (!actual || actual !== selected)
                        return false;
                }
            }
            if (expected?.returnType && definition.fact.returnType) {
                const actual = this.signature(this.typeValue(definition.unit, definition.fact.scope, definition.fact.returnType, definition.fact)), selected = this.signature(this.typeValue(unit!, scope, expected.returnType, expression));
                if (!actual || actual !== selected)
                    return false;
            }
            return !definition.fact.parameters.some((parameter, index) => parameter.modifiers.some(modifier => !(expected?.allowExtension && index === 0 && modifier === 'this')) || parameter.default && !expected?.allowOptional);
        });
        if (candidates.length !== 1)
            return { status: 'unresolved', reason: 'Callback has no unique original selected signature', proof: value.proof };
        const definition = candidates[0]!;
        if (!this.receiverMatches(definition, unit!, scope, value.receiver))
            return { status: 'unresolved', reason: 'Static/instance selected callback does not match its original receiver', proof: value.proof };
        if (!this.direct(definition, value.exact))
            return { status: 'unresolved', reason: value.reason ?? 'Selected callback dispatch is not direct', proof: value.proof };
        if (expected?.parameters && definition.fact.kind === 'lambda') {
            const previous = this.selectedParameters.get(definition.id);
            if (previous && JSON.stringify(previous) !== JSON.stringify(expected.parameters))
                this.conflictingContracts.add(definition.id);
            this.selectedParameters.set(definition.id, expected.parameters);
        }
        if (this.conflictingContracts.has(definition.id))
            return { status: 'unresolved', reason: 'Callback has competing selected parameter contracts', proof: value.proof };
        if (expected?.returnType && definition.fact.kind === 'lambda' && definition.fact.modifiers.includes('async'))
            return { status: 'unresolved', reason: 'Async callback result wrapping needs a reviewed delegate/task profile', proof: value.proof };
        if (expected?.returnType && !definition.fact.returnType) {
            const selected = this.signature(this.typeValue(unit!, scope, expected.returnType, expression));
            const returns = definition.unit.facts.returns.filter(site => this.owner(definition.unit, site.scope) === definition.id);
            if (!selected || !returns.length || returns.some(site => this.signature(this.bind(definition.unit, site.scope, site.value)) !== selected))
                return { status: 'unresolved', reason: 'Callback return expressions do not prove the selected original signature', proof: value.proof };
        }
        return { status: 'resolved', definition, proof: [...value.proof, ...definition.symbol?.proof ?? this.proof(definition.unit, definition.fact, 'Original callback body')], conditions: ['Original selected callable; no generated delegate/closure declaration is fabricated'] };
    }
    /** Reviewed framework type identities remain external and compilation-scoped;
     * original declarations, aliases and shadows always take precedence. */
    registerFrameworkTypes(project: string, names: string[], implicit: boolean, proof: Evidence[]): void {
        this.frameworkTypes.set(project, { names: new Set(names), implicit, proof });
    }
    constant(file: string, scope: string, expression: CsharpExpression): {
        status: 'resolved';
        value: string | number | boolean | null;
        proof: Evidence[];
    } | {
        status: 'unresolved';
        reason: string;
        proof: Evidence[];
    } {
        const unit = this.units.get(file);
        if (!unit)
            return { status: 'unresolved', reason: 'Original C# syntax unavailable', proof: [] };
        let budget = 0;
        const evaluate = (file: string, scope: string, value: CsharpExpression): ReturnType<CsharpSymbols['constant']> => {
            const current = this.units.get(file);
            if (++budget > 128 || !current)
                return { status: 'unresolved', reason: 'Constant recursion/original syntax budget exceeded', proof: [] };
            if (value.kind === 'literal')
                return { status: 'resolved', value: value.value, proof: this.proof(current, value, 'Original literal constant') };
            if (value.kind === 'binary' && value.operator === '+') {
                const left = evaluate(file, scope, value.left), right = evaluate(file, scope, value.right);
                if (left.status === 'resolved' && right.status === 'resolved' && typeof left.value === 'string' && typeof right.value === 'string')
                    return { status: 'resolved', value: left.value + right.value, proof: [...left.proof, ...right.proof] };
            }
            if (value.kind === 'name') {
                for (const space of this.chain(current, scope)) {
                    const entries = current.names.get(space.key)?.get(value.name);
                    if (!entries?.length)
                        continue;
                    const binding = entries.length === 1 && !('id' in entries[0]!) ? entries[0] as CsharpBindingFact : undefined;
                    if (binding?.modifiers.includes('const') && binding.value && value.start > binding.end)
                        return evaluate(file, binding.scope, binding.value);
                    break;
                }
            }
            const bound = this.lookup(file, scope, value);
            if (bound.kind === 'field' && bound.definition.fact.modifiers.includes('const') && bound.definition.fact.value)
                return evaluate(bound.definition.unit.file.path, bound.definition.fact.scope, bound.definition.fact.value);
            return { status: 'unresolved', reason: 'Expression is not an immutable original C# literal/const', proof: bound.proof };
        };
        return evaluate(file, scope, expression);
    }
    analyze(files: ScannedFile[]): void {
        this.resolver.types.annotate();
        for (const file of files) {
            const unit = this.units.get(file.path), entity = this.context.graph.entities.get(file.id)!, analysis = fileAnalysis(entity.metadata.analysis), environment = this.resolver.environment(file.path);
            if (!analysis)
                continue;
            if (!unit || environment.status !== 'resolved') {
                analysis.features.references = { status: environment.status === 'resolved' ? 'failed' : 'disabled', reason: environment.status === 'resolved' ? 'Original C# semantic syntax unavailable' : environment.reason };
                continue;
            }
            this.operations = 0;
            for (const definition of unit.definitions.values())
                if (['lambda', 'top-level'].includes(definition.fact.kind) && !this.context.graph.entities.has(definition.id)) {
                    const owner = this.owner(unit, definition.fact.scope), source = this.context.sources?.readFile(file.path) ?? '', text = source.slice(definition.fact.start, definition.fact.end);
                    this.context.graph.contain({ id: definition.id, type: 'function', name: definition.fact.kind === 'lambda' ? '<lambda>' : '<top-level>', path: file.path, language: 'csharp', parentId: owner, sourceRange: definition.fact.range, metadata: { declarationKind: definition.fact.kind, role: definition.fact.kind, signature: definition.fact.kind === 'lambda' ? definition.fact.parameters.map(parameter => parameter.type ?? '?').join(',') : 'top-level statements', ...declarationHashes(text, 0) }, evidence: this.proof(unit, definition.fact, 'Original ' + definition.fact.kind + ' body') });
                }
            const references: unknown[] = [], calls: unknown[] = [], coverage = new Map<string, CallSites>(), ordinals = new Map<string, number>();
            for (const reference of unit.facts.references) {
                const gap = this.scopeGap(unit, reference.scope), value = gap ? unknown(gap) : reference.kind === 'type' ? this.typeValue(unit, reference.scope, reference.expression.kind === 'name' ? reference.expression.name : '', reference) : reference.kind === 'attribute' ? this.attributeType(unit, reference.scope, reference.expression) : this.bind(unit, reference.scope, reference.expression), owner = this.owner(unit, reference.scope), targets = value.kind === 'type' || value.kind === 'instance' ? value.type.parts.map(part => part.id) : value.kind === 'callable' ? value.definitions.map(definition => definition.id) : value.kind === 'field' ? [value.definition.id] : [];
                const outcome = targets.length ? { status: 'resolved', targets: [...new Set(targets)].sort(), proof: value.proof } : value.kind === 'external' ? { status: 'external', names: value.names, proof: value.proof } : value.kind === 'namespace' || value.kind === 'primitive' ? { status: 'resolved', targets: [], proof: value.proof } : { status: 'unresolved', reason: value.kind === 'unknown' ? value.reason : 'Unreviewed original reference', proof: value.proof };
                references.push({ scope: reference.scope, kind: reference.kind, range: reference.range, expression: reference.expression, ...outcome });
                for (const target of new Set(targets))
                    this.context.graph.relate(owner, target, 'references', [...this.proof(unit, reference, 'Original ' + reference.kind + ' reference'), ...value.proof], { adapter: 'csharp', version: 1, role: reference.kind, range: reference.range });
            }
            for (const call of unit.facts.calls) {
                const owner = this.owner(unit, call.scope), ordinal = ordinals.get(owner) ?? 0;
                ordinals.set(owner, ordinal + 1);
                const gap = this.scopeGap(unit, call.scope), result = gap ? { status: 'unresolved' as const, reason: gap, proof: [] } : this.call(unit, call.scope, call.expression), proof = [...this.proof(unit, call, 'Original C# call site'), ...result.proof], name = call.expression.kind === 'call' ? this.display(call.expression.callee) : call.expression.kind === 'new' ? 'new ' + call.expression.type : '<opaque>', stats = coverage.get(owner) ?? { resolved: 0, external: 0, unresolved: 0, unresolvedNames: {} };
                stats[result.status]++;
                if (result.status === 'unresolved')
                    stats.unresolvedNames![name] = (stats.unresolvedNames![name] ?? 0) + 1;
                coverage.set(owner, stats);
                calls.push({ scope: call.scope, range: call.range, expression: call.expression, name, status: result.status, ...result.status === 'resolved' ? { target: result.definition.id } : result.status === 'external' ? { names: result.names } : { reason: result.reason }, proof });
                if (result.status === 'resolved')
                    this.context.graph.relate(owner, result.definition.id, 'calls', proof, { adapter: 'csharp', version: 1, dispatch: 'direct', range: call.range }, String(ordinal));
            }
            for (const [owner, stats] of coverage) {
                const target = this.context.graph.entities.get(owner);
                if (target)
                    target.metadata.callSites = stats;
            }
            entity.metadata.csharpReferenceOutcomes = references;
            entity.metadata.csharpCallOutcomes = calls;
            analysis.features.references = { status: 'partial', reason: 'Original scoped namespaces/compatible partial types and exact source signatures; inherited/generic/dynamic/conversion/generated/accessor behavior retains gaps' };
            for (const gap of new Set([...unit.facts.gaps, ...unit.facts.scopes.flatMap(scope => scope.gaps), ...unit.facts.definitions.flatMap(definition => definition.gaps)]))
                this.context.graph.diagnose({ analyzer: 'csharp-symbols', severity: 'warning', code: 'csharp-binding-gap', file: file.path, entityId: file.id, reason: gap });
        }
    }
    owns(definition: CsharpDefinition, scope: string): boolean { return this.owner(definition.unit, scope) === definition.id; }
    canonicalType(file: string, scope: string, type: string, site: {
        start: number;
        range: CsharpExpression['range'];
    }): CsharpValue {
        const unit = this.units.get(file), environment = this.resolver.environment(file);
        if (!unit || environment.status !== 'resolved')
            return unknown(environment.status === 'resolved' ? 'Original semantic syntax unavailable' : environment.reason);
        const gap = this.scopeGap(unit, scope);
        return gap ? unknown(gap) : this.typeValue(unit, scope, type, site);
    }
    private attributeType(unit: Unit, scope: string, expression: CsharpExpression): CsharpValue {
        if (expression.kind !== 'name')
            return unknown('Opaque attribute type');
        const original = this.typeValue(unit, scope, expression.name, expression), suffix = this.typeValue(unit, scope, expression.name + 'Attribute', expression);
        const constrained = (value: CsharpValue) => value.kind === 'unknown' && !value.reason.startsWith('No original lexical/namespace/import binding');
        if (constrained(original) || constrained(suffix))
            return unknown('Attribute lookup has a constrained original short/suffixed binding');
        if (original.kind === 'type' && suffix.kind === 'type' && original.type.id !== suffix.type.id)
            return unknown('Attribute short and suffixed names compete');
        if (original.kind === 'type')
            return original;
        if (suffix.kind === 'type')
            return suffix;
        return original.kind === 'external' ? original : suffix;
    }
    private display(expression: CsharpExpression): string { return expression.kind === 'name' ? expression.name : expression.kind === 'member' ? this.display(expression.object) + '.' + expression.name : expression.kind === 'lambda' ? '<lambda>' : expression.kind; }
}
