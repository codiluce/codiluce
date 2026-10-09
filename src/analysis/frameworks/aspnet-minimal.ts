import type { AnalysisContext, ScannedFile } from '../../core/analyzer.js';
import type { ApplicationConfig } from '../../core/config.js';
import { evidence, type Evidence } from '../../core/graph.js';
import { fileAnalysis, type CsharpExpression, type CsharpStatement, type CsharpBindingFact } from '../facts.js';
import type { CsharpSymbols, CsharpDefinition } from '../languages/csharp-symbols.js';
import type { DotnetProject } from '../resolution/dotnet-projects.js';
import { compileAspNetPath, compileAspNetMvcPath, validAspNetHost, type AspNetEndpointData, type AspNetMvcPattern } from '../routes/aspnet-patterns.js';
import type { RoutingContract } from '../routes/contracts.js';
import { aspNetProfile, ASPNET_VERSION, type AspNetProfile } from './aspnet-profile.js';
import { AspNetMvc, mvcFrameworkTypes, type MvcAction } from './aspnet-mvc.js';
const BUILDER = 'Microsoft.AspNetCore.Builder.', HTTP = 'Microsoft.AspNetCore.Http.', ROUTING = 'Microsoft.AspNetCore.Routing.';
const knownTypes = new Set([BUILDER + 'WebApplication', BUILDER + 'WebApplicationBuilder', ROUTING + 'RouteGroupBuilder', ROUTING + 'IEndpointRouteBuilder', BUILDER + 'IApplicationBuilder', HTTP + 'HttpContext', HTTP + 'IResult', HTTP + 'EndpointFilterInvocationContext', HTTP + 'EndpointFilterDelegate', 'System.Threading.Tasks.Task', 'System.Threading.Tasks.ValueTask']);
const implicitNamespaces = [BUILDER.slice(0, -1), ROUTING.slice(0, -1), HTTP.slice(0, -1), 'Microsoft.AspNetCore.Hosting', 'Microsoft.Extensions.DependencyInjection', 'Microsoft.Extensions.Hosting', 'System.Threading.Tasks'];
const verbs: Record<string, string> = { MapGet: 'GET', MapPost: 'POST', MapPut: 'PUT', MapDelete: 'DELETE', MapPatch: 'PATCH' };
interface Origin {
    file: string;
    scope: string;
    expression: CsharpExpression;
}
interface Conventions {
    order?: number;
    hosts?: string[];
    name?: string;
    authorization: string[];
    anonymous: boolean;
    filters: string[];
    gaps: string[];
    dispatchGaps: string[];
    proof: Evidence[];
}
const conventions = (): Conventions => ({ authorization: [], anonymous: false, filters: [], gaps: [], dispatchGaps: [], proof: [] });
interface Group {
    id: string;
    prefix: string;
    parent?: Group;
    proof: Evidence[];
    conventions: Conventions;
}
interface Root {
    id: string;
    project: DotnetProject;
    app: ApplicationConfig;
    profile: AspNetProfile;
    origin: Origin;
    group: Group;
    served: boolean;
    started: boolean;
    gaps: string[];
    dispatchGaps: string[];
    routes: Registration[];
    proof: Evidence[];
    mvc: MvcServices;
    mvcSources: Map<string, MvcSource>;
    mvcOrder: number;
}
interface MvcServices {
    installed: boolean;
    suppressAsync: boolean;
    gaps: string[];
    proof: Evidence[];
}
interface MvcSource {
    conventions: Conventions;
    actions: MvcAction[];
    origin: Origin;
    attributes: Registration[];
}
const mvcServices = (): MvcServices => ({ installed: false, suppressAsync: true, gaps: [], proof: [] });
interface Registration {
    id: string;
    root: Root;
    group: Group;
    origin: Origin;
    path: string;
    methods: string[] | '*';
    handler?: CsharpDefinition;
    conventions: Conventions;
    gaps: string[];
    dispatchGaps: string[];
    proof: Evidence[];
    conditional: boolean;
    mvc?: {
        action: MvcAction;
        pattern: AspNetMvcPattern;
        routeName?: string;
    };
    inheritedConventions?: Conventions[];
    registrationOrigin?: Origin;
    nativeOrder?: number;
    pack?: 'aspnet-mvc';
}
type Value = {
    kind: 'builder';
    id: string;
    gaps: string[];
    proof: Evidence[];
    mvc: MvcServices;
    built?: boolean;
} | {
    kind: 'services' | 'mvc-builder';
    builder: Extract<Value, {
        kind: 'builder';
    }>;
    proof: Evidence[];
} | {
    kind: 'router';
    root: Root;
    group: Group;
    proof: Evidence[];
} | {
    kind: 'endpoint';
    routes: Registration[];
    proof: Evidence[];
    records?: Conventions[];
} | {
    kind: 'constant';
    value: string | number | boolean | null | (string | number | boolean | null)[];
    proof: Evidence[];
} | {
    kind: 'source';
    origin: Origin;
    proof: Evidence[];
} | {
    kind: 'unknown';
    reason: string;
    proof: Evidence[];
};
interface State {
    definition: CsharpDefinition;
    project: DotnetProject;
    app: ApplicationConfig;
    profile: AspNetProfile;
    values: Map<string, Value>;
    roots: Root[];
    chain: string[];
    gaps: string[];
    conditional: boolean;
    depth: number;
    stack: Set<string>;
    stop: boolean;
}
const unknown = (reason: string, proof: Evidence[] = []): Value => ({ kind: 'unknown', reason, proof });
/** Serving-reachable original minimal hosting statements and bounded source
 * helpers. Target startup, middleware, dependencies and compilation never run. */
export class AspNetMinimal {
    private operations = 0;
    private readonly identities = new Map<string, number>();
    private readonly seenFiles = new Set<string>();
    constructor(readonly context: AnalysisContext, readonly symbols: CsharpSymbols) { }
    private proof(origin: Origin, reason: string): Evidence[] { return [{ ...evidence('framework', 'aspnet', origin.file, origin.expression.range.startLine, reason), analyzerVersion: ASPNET_VERSION, endLine: origin.expression.range.endLine }]; }
    private unit(file: string) { return this.symbols.definitions(file)[0]?.unit; }
    private chain(file: string, scope: string) {
        const unit = this.unit(file), result: NonNullable<ReturnType<AspNetMinimal['unit']>>['facts']['scopes'] = [], seen = new Set<string>();
        let current = unit?.scopes.get(scope);
        while (current && !seen.has(current.key) && result.length < 128) {
            result.push(current);
            seen.add(current.key);
            current = current.parent ? unit?.scopes.get(current.parent) : undefined;
        }
        return result;
    }
    private origin(definition: CsharpDefinition, scope: string, expression: CsharpExpression): Origin { return { file: definition.unit.file.path, scope, expression }; }
    private siteKey(origin: Origin, state: State): string {
        const calls = this.symbols.facts(origin.file)?.calls.filter(call => this.symbols.owns(state.definition, call.scope) && this.display(call.expression) === this.display(origin.expression)) ?? [], ordinal = calls.findIndex(call => call.expression.start === origin.expression.start && call.expression.end === origin.expression.end);
        return JSON.stringify([state.definition.id, origin.file, this.display(origin.expression), ordinal]);
    }
    private display(expression: CsharpExpression): string { return expression.kind === 'name' ? expression.name : expression.kind === 'member' ? this.display(expression.object) + '.' + expression.name : expression.kind === 'call' ? this.display(expression.callee) : expression.kind === 'new' ? 'new ' + expression.type : expression.kind; }
    private canonical(origin: Origin, profile: AspNetProfile, typeOnly = false): string | undefined {
        const expression = origin.expression, value = typeOnly && expression.kind === 'name' ? this.symbols.canonicalType(origin.file, origin.scope, expression.name, expression) : this.symbols.lookup(origin.file, origin.scope, expression);
        if (value.kind === 'external') {
            const candidates = value.names.filter(name => knownTypes.has(name));
            if (candidates.length === 1)
                return candidates[0];
        }
        if (value.kind !== 'unknown' || !value.reason.startsWith('No original lexical/namespace/import binding'))
            return;
        const name = expression.kind === 'name' ? expression.name : expression.kind === 'member' ? this.display(expression) : undefined;
        if (!name)
            return;
        const clean = name.replace(/^global::/, '');
        if (knownTypes.has(clean))
            return clean;
        if (profile.implicitUsings && this.symbols.resolver.projects.selection(origin.file).project?.sdk === 'Microsoft.NET.Sdk.Web' && ['true', 'enable'].includes(this.symbols.resolver.projects.selection(origin.file).project?.properties.implicitusings?.toLowerCase() ?? '') && !name.includes('.') && !name.includes('::')) {
            const candidates = implicitNamespaces.map(namespace => namespace + '.' + name).filter(value => knownTypes.has(value));
            if (candidates.length === 1)
                return candidates[0];
        }
    }
    private binding(origin: Origin): CsharpBindingFact | undefined {
        const unit = this.unit(origin.file);
        if (origin.expression.kind !== 'name' || !unit)
            return;
        for (const scope of this.chain(origin.file, origin.scope)) {
            const entries = unit.names.get(scope.key)?.get(origin.expression.name);
            if (entries?.length)
                return entries.length === 1 && !('id' in entries[0]!) ? entries[0] as CsharpBindingFact : undefined;
        }
    }
    private mutated(origin: Origin, binding: CsharpBindingFact): boolean { return this.symbols.facts(origin.file)!.writes.some(write => (write.target.kind === 'name' && write.target.name === binding.name || write.target.kind === 'unknown' && write.target.text.replace(/\s+/g, '').startsWith(binding.name + '[')) && this.chain(origin.file, write.scope).some(scope => scope.key === binding.scope)); }
    private rootGap(state: State, reason: string, dispatch = false) {
        for (const root of state.roots) {
            root.gaps.push(reason);
            if (dispatch)
                root.dispatchGaps.push(reason);
        }
        state.gaps.push(reason);
    }
    private value(origin: Origin, state: State): Value {
        if (++this.operations > 200000 || state.depth > 48)
            return unknown('ASP.NET registration interpretation budget exceeded');
        const expression = origin.expression, proof = this.proof(origin, 'Original minimal API expression');
        state = { ...state, depth: state.depth + 1 };
        if (expression.kind === 'literal')
            return { kind: 'constant', value: expression.value, proof };
        if (expression.kind === 'array') {
            if (expression.type && !['string[]', 'System.String[]', 'global::System.String[]'].includes(expression.type))
                return unknown('Method/host list has an unreviewed declared array element type', proof);
            const items = expression.values.map(value => this.value({ ...origin, expression: value }, state));
            if (items.every(value => value.kind === 'constant' && !Array.isArray(value.value)))
                return { kind: 'constant', value: items.map(value => (value as Extract<Value, {
                        kind: 'constant';
                    }>).value) as (string | number | boolean | null)[], proof: items.flatMap(value => value.proof) };
            return unknown('Method/host list contains dynamic/spread values', proof);
        }
        if (expression.kind === 'name') {
            const binding = this.binding(origin);
            if (binding) {
                if (binding.kind !== 'parameter' && expression.start <= binding.end)
                    return unknown('Future local shadows the minimal hosting identity', proof);
                const scoped = state.values.get(`${origin.file}:${binding.scope}:${binding.name}`);
                if (scoped) {
                    if (this.mutated(origin, binding)) {
                        this.rootGap(state, 'Minimal hosting value has writes or ref/out escape', true);
                        return unknown('Mutable minimal hosting identity', proof);
                    }
                    const bound = this.symbols.lookup(origin.file, origin.scope, expression);
                    if (bound.kind === 'unknown' && /Static anonymous function|competing|Future/.test(bound.reason))
                        return unknown(bound.reason, proof);
                    return scoped;
                }
            }
            const constant = this.symbols.constant(origin.file, origin.scope, expression);
            if (constant.status === 'resolved')
                return { kind: 'constant', value: constant.value, proof: constant.proof };
            return { kind: 'source', origin, proof };
        }
        if (expression.kind === 'binary' || expression.kind === 'unary') {
            const constant = this.symbols.constant(origin.file, origin.scope, expression);
            if (constant.status === 'resolved')
                return { kind: 'constant', value: constant.value, proof: constant.proof };
            if (expression.kind === 'binary' && expression.operator === '+') {
                const left = this.value({ ...origin, expression: expression.left }, state), right = this.value({ ...origin, expression: expression.right }, state);
                if (left.kind === 'constant' && right.kind === 'constant' && typeof left.value === 'string' && typeof right.value === 'string')
                    return { kind: 'constant', value: left.value + right.value, proof: [...left.proof, ...right.proof] };
            }
            if (expression.kind === 'unary' && expression.operator === '-') {
                const value = this.value({ ...origin, expression: expression.value }, state);
                if (value.kind === 'constant' && typeof value.value === 'number')
                    return { ...value, value: -value.value };
            }
            return unknown('Opaque minimal routing constant/operator', proof);
        }
        if (expression.kind === 'call')
            return this.call(origin, state);
        if (expression.kind === 'member') {
            if (expression.name === 'Services') {
                const object = this.value({ ...origin, expression: expression.object }, state);
                if (object.kind === 'builder')
                    return { kind: 'services', builder: object, proof: [...object.proof, ...proof] };
            }
            const constant = this.symbols.constant(origin.file, origin.scope, expression);
            if (constant.status === 'resolved')
                return { kind: 'constant', value: constant.value, proof: constant.proof };
        }
        return { kind: 'source', origin, proof };
    }
    private strings(value: Value): string[] | undefined { return value.kind === 'constant' && typeof value.value === 'string' ? [value.value] : value.kind === 'constant' && Array.isArray(value.value) && value.value.every(item => typeof item === 'string') ? value.value as string[] : undefined; }
    private scalar(value: Value): string | undefined { return value.kind === 'constant' && typeof value.value === 'string' ? value.value : undefined; }
    private stable(kind: string, ...parts: string[]): string { const base = JSON.stringify([kind, ...parts]), ordinal = this.identities.get(base) ?? 0; this.identities.set(base, ordinal + 1); return this.context.graph.id(kind, ...parts, String(ordinal)); }
    private ownerType(definition: CsharpDefinition): string | undefined {
        if (!definition.fact.parent)
            return;
        const owner = this.symbols.definition(definition.unit.file.path, definition.fact.parent);
        return owner?.symbol?.syntax.qualifiedName;
    }
    private extensions(origin: Origin, state: State, name: string): CsharpDefinition[] {
        const environment = this.symbols.resolver.environment(origin.file);
        if (environment.status !== 'resolved')
            return [];
        const imports = [...(this.symbols.resolver.facts(origin.file)?.imports ?? []).filter(fact => !fact.global && fact.scopeStart <= origin.expression.start && origin.expression.start < fact.scopeEnd), ...this.symbols.resolver.globalImports(origin.file).map(item => item.fact)], namespace = this.unit(origin.file)?.scopes.get(origin.scope)?.namespace ?? '';
        const visible = new Set([namespace]);
        let ancestor = namespace;
        while (ancestor) {
            ancestor = ancestor.includes('.') ? ancestor.slice(0, ancestor.lastIndexOf('.')) : '';
            visible.add(ancestor);
        }
        for (const fact of imports) {
            const result = this.symbols.resolver.resolve(origin.file, fact);
            if (fact.kind === 'namespace' && result.status === 'resolved' && result.namespace)
                visible.add(result.namespace);
        }
        return environment.symbols.filter(symbol => symbol.syntax.name === name && symbol.declaration.kind === 'method' && visible.has(symbol.syntax.namespace)).flatMap(symbol => { const definition = this.symbols.definition(symbol.file.path, symbol.syntax.key); return definition?.fact.modifiers.includes('static') && definition.fact.parameters[0]?.modifiers.includes('this') ? [{ ...definition, symbol }] : []; });
    }
    private helper(origin: Origin, state: State, callee: CsharpExpression, args: CsharpExpression[], receiver?: Value): Value | undefined {
        const bound = this.symbols.lookup(origin.file, origin.scope, callee), extension = receiver && callee.kind === 'member' ? this.extensions(origin, state, callee.name) : [], definitions = extension.length ? extension : bound.kind === 'callable' ? bound.definitions : [];
        if (!definitions.length)
            return;
        const values = [...receiver ? [receiver] : [], ...args.map(expression => this.value({ ...origin, expression }, state))];
        const candidates = definitions.filter(definition => definition.fact.parameters.length === values.length && !definition.fact.typeParameters.length && definition.fact.parameters.every((parameter, index) => {
            const value = values[index]!;
            if (parameter.default || parameter.modifiers.some(modifier => modifier !== 'this' || index !== 0))
                return false;
            if (value.kind === 'router') {
                const type = parameter.type && this.canonical({ file: definition.unit.file.path, scope: definition.fact.scope, expression: { ...definition.fact, kind: 'name', name: parameter.type } }, state.profile, true);
                return type === ROUTING + 'IEndpointRouteBuilder' || type === ROUTING + 'RouteGroupBuilder' && value.group.parent !== undefined || type === BUILDER + 'WebApplication' && !value.group.parent;
            }
            if (value.kind === 'constant') {
                return parameter.type === 'string' && typeof value.value === 'string' || parameter.type === 'int' && typeof value.value === 'number' && Number.isInteger(value.value) && value.value >= -2147483648 && value.value <= 2147483647;
            }
            return false;
        }));
        if (candidates.length !== 1) {
            this.rootGap(state, 'Original source registration helper has no unique reviewed exact signature', true);
            return unknown('Opaque/overloaded source registration helper');
        }
        const definition = candidates[0]!, selected = extension.length ? { ...callee, kind: 'name' as const, name: 'global::' + definition.symbol!.syntax.qualifiedName } : callee;
        const callable = this.symbols.handler(origin.file, origin.scope, selected, { definitionIds: [definition.id], allowExtension: true });
        if (callable.status !== 'resolved' || definition.fact.modifiers.includes('async') || state.stack.has(definition.id) || !definition.fact.bodyScope || !definition.fact.statements) {
            this.rootGap(state, callable.status === 'unresolved' ? callable.reason : 'Recursive/async/bodyless registration helper', true);
            return unknown('Unreviewed source registration helper');
        }
        const next: State = { ...state, definition, values: new Map(state.values), chain: [...state.chain, this.siteKey(origin, state)], stack: new Set([...state.stack, definition.id]), depth: state.depth + 1, stop: false };
        definition.fact.parameters.forEach((parameter, index) => next.values.set(`${definition.unit.file.path}:${definition.fact.bodyScope}:${parameter.name}`, values[index]!));
        this.seenFiles.add(definition.unit.file.path);
        this.context.graph.relate(state.definition.id, definition.id, 'calls', [...this.proof(origin, 'Original invoked registration helper'), ...callable.proof], { adapter: 'aspnet', version: ASPNET_VERSION, dispatch: 'direct-registration-helper' }, JSON.stringify(next.chain));
        const result = this.statements(definition.fact.statements, next);
        if (result?.kind === 'router' || result?.kind === 'builder') {
            const declared = definition.fact.returnType && this.canonical({ file: definition.unit.file.path, scope: definition.fact.scope, expression: { ...definition.fact, kind: 'name', name: definition.fact.returnType } }, state.profile, true);
            if (![BUILDER + 'WebApplication', BUILDER + 'WebApplicationBuilder', ROUTING + 'RouteGroupBuilder', ROUTING + 'IEndpointRouteBuilder'].includes(declared ?? '')) {
                this.rootGap(state, 'Registration factory return type cannot borrow a hosting identity', true);
                return unknown('Unreviewed registration factory return type');
            }
        }
        return result ?? unknown('Registration helper has no reviewed return value');
    }
    private callback(origin: Origin, state: State): {
        definition?: CsharpDefinition;
        proof: Evidence[];
        gaps: string[];
    } {
        const value = this.value(origin, state);
        if (value.kind !== 'source')
            return { proof: value.proof, gaps: ['Minimal delegate argument is not an original source callable'] };
        const selectedOrigin = value.origin, expression = selectedOrigin.expression;
        let selected = this.symbols.handler(selectedOrigin.file, selectedOrigin.scope, expression, { allowOptional: true });
        if (expression.kind === 'lambda') {
            const definition = this.symbols.definition(selectedOrigin.file, expression.key);
            if (definition?.fact.parameters.length === 1 && !definition.fact.parameters[0]?.type) {
                // A single implicit parameter is contextual RequestDelegate/HttpContext,
                // never inferred from a route parameter name or a guessed natural delegate.
                const returned = definition.unit.facts.returns.filter(site => this.symbols.owns(definition, site.scope));
                if (definition.fact.modifiers.includes('async') && !returned.length)
                    selected = this.symbols.handler(selectedOrigin.file, selectedOrigin.scope, expression, { parameters: [HTTP + 'HttpContext'], allowUntyped: true });
                else
                    return { proof: selected.proof, gaps: ['Implicit RequestDelegate result requires a reviewed Task signature'] };
            }
        }
        if (selected.status !== 'resolved')
            return { proof: selected.proof, gaps: [selected.reason] };
        if (selected.definition.fact.kind === 'lambda' && selected.definition.fact.parameters.some(parameter => !parameter.type) && selected.definition.fact.parameters.length !== 1)
            return { proof: selected.proof, gaps: ['Implicit RequestDelegate result requires a reviewed Task signature'] };
        const capturedSites = [...selected.definition.unit.facts.references, ...selected.definition.unit.facts.calls.flatMap(site => site.expression.kind === 'call' && site.expression.callee.kind === 'member' ? [{ ...site, expression: site.expression.callee.object }] : [])];
        const capturedRouting = capturedSites.some(site => this.symbols.owns(selected.definition, site.scope) && site.expression.kind === 'name' && this.value({ file: selected.definition.unit.file.path, scope: site.scope, expression: site.expression }, state).kind === 'router');
        if (capturedRouting)
            return { definition: selected.definition, proof: selected.proof, gaps: ['Deferred delegate captures a hosting identity; registration/continuation is unreviewed'] };
        const scalarTypes = new Set(['string', 'int', 'long', 'bool', 'float', 'double', 'decimal', 'char', 'short', 'byte', 'sbyte', 'ushort', 'uint', 'ulong']);
        const parameterGap = selected.definition.fact.parameters.some(parameter => parameter.type && !scalarTypes.has(parameter.type) && this.canonical({ file: selected.definition.unit.file.path, scope: selected.definition.fact.scope, expression: { ...selected.definition.fact, kind: 'name', name: parameter.type } }, state.profile, true) !== HTTP + 'HttpContext');
        if (parameterGap)
            return { definition: selected.definition, proof: selected.proof, gaps: ['Custom/service/model parameter binding and metadata require a reviewed profile'] };
        if (selected.definition.fact.parameters.some(parameter => parameter.default && this.symbols.constant(selected.definition.unit.file.path, selected.definition.fact.scope, parameter.default).status !== 'resolved'))
            return { definition: selected.definition, proof: selected.proof, gaps: ['Opaque optional parameter default metadata'] };
        const primitiveReturn = (type: string) => type === 'void' || scalarTypes.has(type) || this.symbols.canonicalType(selected.definition.unit.file.path, selected.definition.fact.scope, type, selected.definition.fact).kind === 'primitive';
        const returnType = selected.definition.fact.returnType;
        if (returnType && !primitiveReturn(returnType) && !['System.Threading.Tasks.Task', 'System.Threading.Tasks.ValueTask', 'Microsoft.AspNetCore.Http.IResult'].includes(this.canonical({ file: selected.definition.unit.file.path, scope: selected.definition.fact.scope, expression: { ...selected.definition.fact, kind: 'name', name: returnType } }, state.profile, true) ?? ''))
            return { definition: selected.definition, proof: selected.proof, gaps: ['Custom/generic result metadata requires a reviewed endpoint profile'] };
        if (!returnType && selected.definition.unit.facts.returns.some(site => this.symbols.owns(selected.definition, site.scope) && this.symbols.lookup(selected.definition.unit.file.path, site.scope, site.value).kind !== 'primitive'))
            return { definition: selected.definition, proof: selected.proof, gaps: ['Delegate result type/metadata requires a reviewed endpoint profile'] };
        if (selected.definition.fact.attributes.length)
            return { definition: selected.definition, proof: selected.proof, gaps: ['Minimal handler attributes/metadata require a reviewed registration/binding profile'] };
        return { definition: selected.definition, proof: selected.proof, gaps: [] };
    }
    private convention(target: Extract<Value, {
        kind: 'router' | 'endpoint';
    }>, origin: Origin, state: State, name: string, args: CsharpExpression[]): Value {
        const records = target.kind === 'router' ? [target.group.conventions] : target.records ?? target.routes.map(route => route.conventions), values = args.map(expression => this.value({ ...origin, expression }, state)), strings = values.flatMap(value => this.strings(value) ?? []);
        for (const record of records) {
            record.proof.push(...this.proof(origin, 'Original endpoint/group ' + name + ' convention'));
            if (name === 'WithOrder') {
                const value = values[0];
                if (values.length === 1 && value?.kind === 'constant' && typeof value.value === 'number' && Number.isInteger(value.value) && value.value >= -2147483648 && value.value <= 2147483647)
                    record.order = value.value;
                else
                    record.dispatchGaps.push('Opaque endpoint order');
            }
            else if (name === 'RequireHost') {
                if (values.length && values.every(value => !!this.strings(value)) && strings.every(validAspNetHost))
                    record.hosts = strings;
                else
                    record.dispatchGaps.push('Opaque/IPv6/unreviewed host requirement');
            }
            else if (name === 'RequireAuthorization') {
                if (!values.length)
                    record.authorization.push('<default>');
                else if (values.every(value => !!this.strings(value)))
                    record.authorization.push(...strings);
                else
                    record.gaps.push('Opaque authorization policy metadata');
            }
            else if (name === 'AllowAnonymous' && !args.length)
                record.anonymous = true;
            else if (name === 'WithName') {
                if (values.length === 1 && strings.length === 1)
                    record.name = strings[0];
                else
                    record.gaps.push('Opaque endpoint name');
            }
            else if (name === 'WithTags' || name === 'WithDisplayName' || name === 'WithGroupName') {
                if (!values.every(value => !!this.strings(value)))
                    record.gaps.push('Opaque informational endpoint metadata');
            }
            else if (name === 'AddEndpointFilter' || name === 'AddEndpointFilterFactory' || name.startsWith('AddEndpointFilter<')) {
                const filter = args[0] && this.callback({ ...origin, expression: args[0] }, state);
                if (filter?.definition)
                    record.filters.push(filter.definition.id);
                record.gaps.push('Endpoint filter continuation/short circuit is unresolved');
            }
            else {
                record.gaps.push('Custom/unreviewed endpoint convention: ' + name);
                record.dispatchGaps.push('Custom endpoint metadata/conventions can alter routing');
            }
        }
        return target;
    }
    private call(origin: Origin, state: State): Value {
        const expression = origin.expression;
        if (expression.kind !== 'call')
            return unknown('Opaque call');
        const callee = expression.callee, args = expression.args.map(argument => argument.value), proof = this.proof(origin, 'Original minimal API call');
        if (expression.args.some(argument => argument.modifier || argument.name && !(callee.kind === 'member' && ['MapControllerRoute', 'MapAreaControllerRoute'].includes(callee.name)))) {
            this.rootGap(state, 'Named/ref arguments in startup need a reviewed invocation summary', true);
            return unknown('Unreviewed startup arguments', proof);
        }
        if (callee.kind === 'member') {
            const factory = this.canonical({ ...origin, expression: callee.object }, state.profile);
            if (factory === BUILDER + 'WebApplication' && ['CreateBuilder', 'CreateSlimBuilder', 'Create'].includes(callee.name)) {
                const argv = args.length === 0 || args.length === 1 && args[0]?.kind === 'name' && args[0].name === 'args' && (state.definition.fact.kind === 'top-level' && !this.binding({ ...origin, expression: args[0] }) || state.definition.fact.name === 'Main' && state.definition.fact.parameters.some(parameter => parameter.name === 'args' && parameter.type === 'string[]'));
                const gaps = [...state.gaps, ...argv ? [] : ['WebApplication factory has opaque options/arguments']], id = this.context.graph.id('aspnet-allocation', state.project.id, ...state.chain, this.siteKey(origin, state));
                if (callee.name !== 'Create')
                    return { kind: 'builder', id, gaps, mvc: mvcServices(), proof: [...state.profile.proof, ...proof] };
                return this.newRoot(id, origin, state, gaps, proof);
            }
            const receiver = this.value({ ...origin, expression: callee.object }, state);
            if (receiver.kind === 'builder' && callee.name === 'Build' && !args.length) {
                if (receiver.built)
                    receiver.gaps.push('Hosting builder is built more than once');
                receiver.built = true;
                return this.newRoot(receiver.id, origin, state, receiver.gaps, receiver.proof, receiver.mvc);
            }
            if (receiver.kind === 'services' || receiver.kind === 'mvc-builder') {
                const mvc = receiver.builder.mvc;
                if (receiver.builder.built)
                    this.rootGap(state, 'Service collection changes after Build are unreviewed/invalid', true);
                if (receiver.kind === 'services' && ['AddControllers', 'AddControllersWithViews', 'AddMvc', 'AddMvcCore'].includes(callee.name) && !this.extensions(origin, state, callee.name).length) {
                    mvc.installed = true;
                    mvc.proof.push(...proof);
                    if (state.conditional)
                        mvc.gaps.push('Conditional MVC service registration');
                    if (callee.name === 'AddMvcCore')
                        mvc.gaps.push('AddMvcCore needs explicit controller/action/binding service composition');
                    if (args.length)
                        this.mvcOptions(origin, state, args, mvc);
                    return { kind: 'mvc-builder', builder: receiver.builder, proof: [...receiver.proof, ...proof] };
                }
                mvc.gaps.push('Unreviewed MVC/service/application-part configuration: ' + callee.name);
                receiver.builder.gaps.push('Unreviewed service registration can customize routing or activation');
                return receiver;
            }
            if (receiver.kind === 'router' || receiver.kind === 'endpoint') {
                const extensions = this.extensions(origin, state, callee.name);
                if (extensions.length)
                    return this.helper(origin, state, callee, args, receiver) ?? unknown('Unreviewed competing source extension');
                if (receiver.kind === 'endpoint')
                    return this.convention(receiver, origin, state, callee.name, args);
                const root = receiver.root;
                if (['MapControllers', 'MapControllerRoute', 'MapDefaultControllerRoute', 'MapAreaControllerRoute'].includes(callee.name))
                    return this.mvcRegistration(receiver, origin, state, callee.name);
                if (callee.name === 'MapGroup') {
                    const prefix = args.length === 1 ? this.value({ ...origin, expression: args[0]! }, state) : unknown('Invalid MapGroup arguments'), text = this.scalar(prefix);
                    const group: Group = { id: this.stable('aspnet-group', root.id, receiver.group.id, ...state.chain, this.siteKey(origin, state)), prefix: text ?? '/{**unresolved}', parent: receiver.group, proof: [...receiver.proof, ...prefix.proof, ...proof], conventions: conventions() };
                    if (text === undefined)
                        group.conventions.dispatchGaps.push('Opaque group prefix');
                    if (state.conditional)
                        group.conventions.dispatchGaps.push('Conditional group allocation');
                    return { kind: 'router', root, group, proof: group.proof };
                }
                if (verbs[callee.name] || ['MapMethods', 'Map'].includes(callee.name) && args.length >= 2) {
                    const path = args[0] ? this.value({ ...origin, expression: args[0] }, state) : unknown('Missing route pattern'), text = this.scalar(path), methodValue = callee.name === 'MapMethods' && args[1] ? this.value({ ...origin, expression: args[1] }, state) : undefined, rawMethods = methodValue ? this.strings(methodValue) : undefined;
                    const validMethods = methodValue?.kind === 'constant' && Array.isArray(methodValue.value) && rawMethods?.every(method => !!method && /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(method));
                    const methods: string[] | '*' = verbs[callee.name] ? [verbs[callee.name]!] : callee.name === 'Map' ? '*' : validMethods && rawMethods!.length ? [...new Set(rawMethods!.map(method => method.toUpperCase()))] : '*';
                    const callback = args[callee.name === 'MapMethods' ? 2 : 1], selected = callback ? this.callback({ ...origin, expression: callback }, state) : { proof: [], gaps: ['Missing original handler'] }, local = text ?? '/{**unresolved}', expected = callee.name === 'MapMethods' ? 3 : 2;
                    const dispatchGaps = [...text === undefined ? ['Opaque route pattern'] : [], ...callee.name === 'MapMethods' && !validMethods ? ['Opaque/invalid HTTP method metadata'] : [], ...args.length !== expected ? ['Unreviewed registration overload'] : [], ...root.started ? ['Endpoint registration occurs after host startup'] : []];
                    const route: Registration = { id: this.stable('endpoint', root.id, state.definition.id, ...state.chain, receiver.group.id, local, methods === '*' ? '*' : methods.join('|')), root, group: receiver.group, origin, path: local, methods, handler: selected.definition, conventions: conventions(), gaps: [...state.gaps, ...selected.gaps], dispatchGaps, proof: [...receiver.proof, ...path.proof, ...methodValue?.proof ?? [], ...proof, ...selected.proof], conditional: state.conditional };
                    root.routes.push(route);
                    return { kind: 'endpoint', routes: [route], proof: route.proof };
                }
                if (['Run', 'RunAsync', 'Start', 'StartAsync'].includes(callee.name) && !receiver.group.parent) {
                    const address = args[0] ? this.scalar(this.value({ ...origin, expression: args[0] }, state)) : undefined;
                    if (args.length > 1 || args.length === 1 && (address === undefined || ['Start', 'StartAsync'].includes(callee.name))) {
                        root.gaps.push('Run delegate/custom host startup is not a reviewed serving overload');
                        return unknown('Opaque/terminal middleware Run overload');
                    }
                    root.served = true;
                    root.started = true;
                    root.proof.push(...proof);
                    if (state.conditional)
                        root.dispatchGaps.push('Host startup is conditional');
                    return { kind: 'source', origin, proof };
                }
                if (['UseRouting', 'UseEndpoints'].includes(callee.name)) {
                    if (callee.name === 'UseEndpoints')
                        root.dispatchGaps.push('UseEndpoints callback registration is outside the reviewed minimal hosting subset');
                    return receiver;
                }
                if (callee.name.startsWith('Use') || callee.name === 'Run') {
                    if (['UseAuthentication', 'UseAuthorization'].includes(callee.name) && !args.length) {
                        root.proof.push(...proof);
                        return receiver;
                    }
                    root.gaps.push('Middleware/rewriting/short circuit continuation is unreviewed: ' + callee.name);
                    if (['UsePathBase', 'UseRewriter', 'UseWhen', 'UseStaticFiles', 'UseDefaultFiles', 'UseCors', 'Use'].includes(callee.name))
                        root.dispatchGaps.push('Middleware can alter routing/endpoint availability');
                    return receiver;
                }
                if (['WithOrder', 'RequireHost', 'RequireAuthorization', 'AllowAnonymous', 'WithName', 'WithTags', 'WithDisplayName', 'WithGroupName', 'WithMetadata', 'AddEndpointFilter', 'AddEndpointFilterFactory'].includes(callee.name) || callee.name.startsWith('AddEndpointFilter<'))
                    return this.convention(receiver, origin, state, callee.name, args);
                const helper = this.helper(origin, state, callee, args, receiver);
                if (helper)
                    return helper;
                const registration: Registration = { id: this.stable('endpoint', root.id, ...state.chain, this.siteKey(origin, state)), root, group: receiver.group, origin, path: '/{**unresolved}', methods: '*', conventions: conventions(), gaps: ['Unknown router extension can register or alter endpoints: ' + callee.name], dispatchGaps: ['Unknown router extension'], proof: [...receiver.proof, ...proof], conditional: state.conditional };
                root.routes.push(registration);
                return { kind: 'endpoint', routes: [registration], proof: registration.proof };
            }
            if (receiver.kind === 'builder') {
                receiver.gaps.push('Custom builder configuration needs a reviewed routing/deployment summary');
                return unknown('Custom WebApplicationBuilder API', proof);
            }
        }
        const helper = this.helper(origin, state, callee, args);
        if (helper)
            return helper;
        for (const argument of args) {
            const value = this.value({ ...origin, expression: argument }, state);
            if (value.kind === 'source' && value.origin.expression.kind === 'lambda') {
                const callback = this.callback(value.origin, state);
                if (callback.gaps.some(reason => reason.includes('captures a hosting identity')))
                    this.rootGap(state, 'Hosting identity escapes through a deferred callback', true);
            }
            if (value.kind === 'router' || value.kind === 'builder' || value.kind === 'constant' && Array.isArray(value.value))
                this.rootGap(state, 'Hosting identity escapes to an opaque source/external call', true);
        }
        // Unrecognized builder Services/Configuration calls can install matcher
        // policies or change startup. Retain them as deployment gaps.
        if (callee.kind === 'member') {
            const receiver = this.value({ ...origin, expression: callee.object }, state);
            const source = receiver.kind === 'source' ? this.display(receiver.origin.expression) : this.display(callee.object);
            if (source.includes('.Services') || source.includes('.Configuration'))
                this.rootGap(state, 'Unreviewed service/configuration registration may customize routing or endpoint activation', true);
        }
        return { kind: 'source', origin, proof };
    }
    private mvcOptions(origin: Origin, state: State, args: CsharpExpression[], mvc: MvcServices): void {
        const expression = args[0], definition = expression?.kind === 'lambda' ? this.symbols.definition(origin.file, expression.key) : undefined;
        if (args.length !== 1 || !definition || definition.fact.parameters.length !== 1 || definition.fact.parameters[0]?.type || !definition.fact.statements?.length || definition.fact.statements.some(s => !['expression', 'return'].includes(s.kind)) || definition.unit.facts.calls.some(c => this.symbols.owns(definition, c.scope))) {
            mvc.gaps.push('Opaque MVC options/application-model configuration');
            return;
        }
        const writes = definition.unit.facts.writes.filter(w => this.symbols.owns(definition, w.scope)), parameter = definition.fact.parameters[0]!.name;
        if (writes.length !== definition.fact.statements.length || writes.some(w => w.operator !== '=' || w.target.kind !== 'member' || w.target.object.kind !== 'name' || w.target.object.name !== parameter || w.target.name !== 'SuppressAsyncSuffixInActionNames' || w.value?.kind !== 'literal' || typeof w.value.value !== 'boolean')) {
            mvc.gaps.push('Unreviewed MVC options can alter routing/discovery');
            return;
        }
        mvc.suppressAsync = (writes.at(-1)!.value as Extract<CsharpExpression, {
            kind: 'literal';
        }>).value as boolean;
        mvc.proof.push(...this.proof({ ...origin, expression: expression! }, 'Original literal SuppressAsyncSuffixInActionNames option'));
    }
    private mvcDictionary(origin: Origin, state: State, expression: CsharpExpression | undefined, proof: Evidence[], seen = new Set<string>()): Record<string, string | number | boolean | null> | undefined {
        if (!expression || expression.kind === 'literal' && expression.value === null)
            return {};
        if (expression.kind === 'name') {
            const binding = this.binding({ ...origin, expression }), key = binding && origin.file + ':' + binding.scope + ':' + binding.name;
            if (!binding?.value || !key || seen.has(key) || seen.size > 32 || this.mutated({ ...origin, expression }, binding) || expression.start <= binding.end)
                return;
            seen.add(key);
            return this.mvcDictionary({ ...origin, scope: binding.scope }, state, binding.value, proof, seen);
        }
        if (expression.kind !== 'object')
            return;
        proof.push(...this.proof({ ...origin, expression }, 'Original literal MVC route-value object'));
        const result: Record<string, string | number | boolean | null> = Object.create(null);
        for (const property of expression.properties) {
            const key = property.name.toLowerCase(), value = this.value({ ...origin, expression: property.value }, state);
            if (Object.hasOwn(result, key) || value.kind !== 'constant' || Array.isArray(value.value))
                return;
            proof.push(...value.proof);
            result[key] = value.value;
        }
        return result;
    }
    private mvcRegistration(receiver: Extract<Value, {
        kind: 'router';
    }>, origin: Origin, state: State, name: string): Value {
        const root = receiver.root, call = origin.expression as Extract<CsharpExpression, {
            kind: 'call';
        }>, proof = this.proof(origin, 'Original MVC endpoint datasource registration ' + name);
        let source = root.mvcSources.get(receiver.group.id);
        const create = (action: MvcAction, path: string, pattern: AspNetMvcPattern, order: number, routeName: string | undefined, record: Conventions, localGaps: string[]): Registration => {
            const route: Registration = { id: this.stable('endpoint', root.id, receiver.group.id, 'mvc', action.controller.id, action.handler.id, path, action.methods === '*' ? '*' : action.methods.join('|')), root, group: receiver.group, origin: { file: action.handler.unit.file.path, scope: action.handler.fact.scope, expression: { ...action.handler.fact, kind: 'name', name: action.handler.fact.name } }, registrationOrigin: origin, path, methods: action.methods, handler: action.handler, conventions: record, inheritedConventions: [source!.conventions], gaps: [...state.gaps, ...action.gaps, ...localGaps], dispatchGaps: [...action.dispatchGaps, ...root.started ? ['MVC registration occurs after host startup'] : []], proof: [...receiver.proof, ...root.mvc.proof, ...proof, ...action.proof], conditional: state.conditional, mvc: { action, pattern, ...routeName !== undefined ? { routeName } : {} } };
            route.nativeOrder = order;
            root.routes.push(route);
            return route;
        };
        if (!source) {
            const model = new AspNetMvc(this.context, this.symbols).model(root.project, root.profile.major ?? 8, root.mvc.suppressAsync);
            source = { conventions: conventions(), actions: model.actions, origin, attributes: [] };
            root.mvcSources.set(receiver.group.id, source);
            const gaps = [...root.mvc.gaps, ...model.gaps, ...root.mvc.installed ? [] : ['MapControllers/controller routes require original MVC service registration before Build']];
            root.gaps.push(...gaps);
            root.dispatchGaps.push(...gaps);
            for (const action of source.actions)
                if (action.path !== undefined) {
                    const record = conventions();
                    record.authorization = [...action.authorization];
                    record.anonymous = action.anonymous;
                    record.filters = [...action.filters];
                    source.attributes.push(create(action, action.path, action.pattern, action.order, action.name, record, []));
                }
            if (gaps.length) {
                root.routes.push({ id: this.stable('endpoint', root.id, receiver.group.id, 'mvc-unresolved'), root, group: receiver.group, origin, path: '/{**unresolved}', methods: '*', conventions: conventions(), gaps, dispatchGaps: ['Unreviewed MVC model/discovery may supply competing endpoints'], proof: [...proof, ...model.proof], conditional: state.conditional, pack: 'aspnet-mvc' });
            }
        }
        if (name === 'MapControllers') {
            if (call.args.length)
                source.conventions.dispatchGaps.push('Unreviewed MapControllers overload');
            source.conventions.proof.push(...proof);
            if (state.conditional)
                source.conventions.dispatchGaps.push('Conditional MVC datasource registration');
            return { kind: 'endpoint', routes: source.attributes, records: [source.conventions], proof };
        }
        const parameters = name === 'MapAreaControllerRoute' ? ['name', 'areaName', 'pattern', 'defaults', 'constraints', 'dataTokens'] : ['name', 'pattern', 'defaults', 'constraints', 'dataTokens'], bound = new Map<string, CsharpExpression>(), gaps: string[] = [];
        if (name === 'MapDefaultControllerRoute') {
            if (call.args.length)
                gaps.push('Unreviewed MapDefaultControllerRoute overload');
        }
        else
            call.args.forEach((arg, index) => {
                const key = arg.name ?? parameters[index];
                if (!key || !parameters.includes(key) || bound.has(key))
                    gaps.push('Unreviewed named/positional MVC route arguments');
                else
                    bound.set(key, arg.value);
            });
        const patternValue = bound.get('pattern') ? this.value({ ...origin, expression: bound.get('pattern')! }, state) : undefined, nameValue = bound.get('name') ? this.value({ ...origin, expression: bound.get('name')! }, state) : undefined;
        const patternText = name === 'MapDefaultControllerRoute' ? '{controller=Home}/{action=Index}/{id?}' : patternValue ? this.scalar(patternValue) : undefined;
        const routeName = name === 'MapDefaultControllerRoute' ? 'default' : nameValue ? this.scalar(nameValue) : undefined;
        if (patternText === undefined || routeName === undefined)
            gaps.push('Opaque/missing MVC conventional route pattern or name');
        const valueProof: Evidence[] = [...patternValue?.proof ?? [], ...nameValue?.proof ?? []], defaults = this.mvcDictionary(origin, state, bound.get('defaults'), valueProof), constraints = this.mvcDictionary(origin, state, bound.get('constraints'), valueProof), dataTokens = this.mvcDictionary(origin, state, bound.get('dataTokens'), valueProof);
        if (!defaults || !constraints || !dataTokens)
            gaps.push('Opaque MVC route defaults/constraints/data tokens');
        if (name === 'MapAreaControllerRoute') {
            const area = bound.get('areaName') && this.scalar(this.value({ ...origin, expression: bound.get('areaName')! }, state));
            if (area === undefined || !area)
                gaps.push('Opaque/empty MVC area name');
            else if (defaults) {
                if (!/^[\x00-\x7f]*$/.test(area))
                    gaps.push('Unicode MVC area constraint needs a reviewed ordinal case profile');
                defaults.area = defaults.area ?? area;
                if (constraints && constraints.area !== undefined && constraints.area !== null)
                    gaps.push('Custom MapAreaControllerRoute area constraint');
                else if (constraints)
                    constraints.area = area;
            }
        }
        const order = ++root.mvcOrder, record = conventions(), routes: Registration[] = [];
        record.dispatchGaps.push(...gaps);
        record.proof.push(...proof, ...valueProof);
        for (const action of source.actions)
            if (action.path === undefined) {
                // MapAreaControllerRoute installs StringRouteConstraint on area;
                // select it as a required-value filter, never as CLR regex.
                if (name === 'MapAreaControllerRoute' && typeof constraints?.area === 'string' && constraints.area.toLowerCase() !== action.area?.toLowerCase() && !gaps.length)
                    continue;
                const actualConstraints = { ...constraints };
                if (name === 'MapAreaControllerRoute')
                    delete actualConstraints.area;
                const pattern: AspNetMvcPattern = { kind: 'conventional', requiredValues: action.pattern.requiredValues, defaults: defaults ?? {}, constraints: actualConstraints };
                const compiled = patternText !== undefined ? compileAspNetMvcPath(patternText, root.profile.major ?? 8, pattern) : undefined;
                if (compiled?.reason?.includes('MVC explicit defaults conflict')) {
                    root.gaps.push(compiled.reason);
                    root.dispatchGaps.push(compiled.reason);
                }
                if (patternText !== undefined && !compiled)
                    continue;
                const route = create(action, patternText ?? '/{**unresolved}', pattern, order, routeName, record, gaps);
                routes.push(route);
                route.inheritedConventions = [source.conventions, { ...conventions(), authorization: action.authorization, anonymous: action.anonymous, filters: action.filters }];
            }
        if (gaps.length) {
            root.dispatchGaps.push(...gaps);
            root.routes.push({ id: this.stable('endpoint', root.id, 'mvc-route-gap', this.siteKey(origin, state)), root, group: receiver.group, origin, path: '/{**unresolved}', methods: '*', conventions: record, gaps, dispatchGaps: gaps, proof, conditional: state.conditional, pack: 'aspnet-mvc' });
        }
        return { kind: 'endpoint', routes, records: [record], proof };
    }
    private newRoot(id: string, origin: Origin, state: State, gaps: string[], proof: Evidence[], services: MvcServices = mvcServices()): Value {
        const group: Group = { id, prefix: '', proof, conventions: conventions() }, root: Root = { id, project: state.project, app: state.app, profile: state.profile, origin, group, served: false, started: false, gaps: [...gaps], dispatchGaps: [], routes: [], proof: [...proof], mvc: { ...services, gaps: [...services.gaps], proof: [...services.proof] }, mvcSources: new Map(), mvcOrder: 0 };
        state.roots.push(root);
        return { kind: 'router', root, group, proof: [...proof, ...this.proof(origin, 'Original WebApplication allocation')] };
    }
    private statements(statements: CsharpStatement[], state: State): Value | undefined {
        for (const statement of statements) {
            if (state.stop)
                break;
            if (++this.operations > 200000) {
                this.rootGap(state, 'ASP.NET startup interpretation budget exceeded', true);
                break;
            }
            const file = state.definition.unit.file.path;
            if (statement.kind === 'block') {
                const value = this.statements(statement.body ?? [], state);
                if (value)
                    return value;
                continue;
            }
            if (statement.kind === 'variable') {
                for (const start of statement.bindings ?? []) {
                    const binding = state.definition.unit.facts.bindings.find(binding => binding.start === start && binding.kind === 'local');
                    if (!binding)
                        continue;
                    const value = binding.value ? this.value({ file, scope: binding.scope, expression: binding.value }, state) : unknown('Uninitialized local');
                    state.values.set(`${file}:${binding.scope}:${binding.name}`, value);
                    if (binding.type && value.kind === 'source')
                        state.values.set(`${file}:${binding.scope}:${binding.name}`, unknown('Declared delegate conversion is outside the reviewed natural delegate profile'));
                    if (binding.type && value.kind === 'constant') {
                        const valid = typeof value.value === 'string' ? ['string', 'System.String', 'global::System.String'].includes(binding.type) : Array.isArray(value.value) ? ['string[]', 'System.String[]', 'global::System.String[]'].includes(binding.type) : typeof value.value === 'number' ? ['int', 'long'].includes(binding.type) : typeof value.value === 'boolean' ? binding.type === 'bool' : false;
                        if (!valid)
                            state.values.set(`${file}:${binding.scope}:${binding.name}`, unknown('Declared constant/local type cannot borrow a routing argument'));
                    }
                    if (binding.type && value.kind === 'router') {
                        const declared = this.canonical({ file, scope: binding.scope, expression: { ...binding, kind: 'name', name: binding.type } }, state.profile, true);
                        if (![BUILDER + 'WebApplication', ROUTING + 'RouteGroupBuilder', ROUTING + 'IEndpointRouteBuilder'].includes(declared ?? ''))
                            state.values.set(`${file}:${binding.scope}:${binding.name}`, unknown('Declared local type cannot borrow a hosting identity'));
                    }
                }
                continue;
            }
            if (statement.kind === 'expression' || statement.kind === 'return') {
                const origin = statement.value ? { file, scope: statement.scope, expression: statement.value } : undefined, value = origin ? this.value(origin, state) : undefined;
                if (statement.kind === 'return') {
                    state.stop = true;
                    return value;
                }
                if (origin?.expression.kind === 'call' && origin.expression.callee.kind === 'member' && ['Run', 'RunAsync'].includes(origin.expression.callee.name) && (origin.expression.callee.name === 'Run' || statement.awaited))
                    state.stop = state.roots.some(root => root.served);
                continue;
            }
            if (statement.kind === 'control') {
                if (statement.control === 'if_statement' && statement.value?.kind === 'literal' && typeof statement.value.value === 'boolean') {
                    const value = this.statements(statement.branches?.[statement.value.value ? 0 : 1] ?? [], state);
                    if (value)
                        return value;
                    continue;
                }
                const condition = statement.value && this.value({ file, scope: statement.scope, expression: statement.value }, state);
                if (condition?.kind === 'constant' && typeof condition.value === 'boolean' && statement.control === 'if_statement') {
                    const value = this.statements(statement.branches?.[condition.value ? 0 : 1] ?? [], state);
                    if (value)
                        return value;
                    continue;
                }
                this.rootGap(state, 'Conditional startup control/loop continuation requires a reviewed summary', true);
                for (const branch of statement.branches ?? [])
                    this.statements(branch, { ...state, values: new Map(state.values), gaps: [...state.gaps, 'Conditional/loop/deferred startup registration'], conditional: true, stop: false });
                if (state.roots.some(root => root.started))
                    this.rootGap(state, 'Startup continuation after conditional serving is unreviewed', true);
                continue;
            }
            this.rootGap(state, 'Opaque startup statement/control transfer can alter registration or serving', true);
        }
    }
    private materialize(root: Root) {
        const inherited = (group: Group): Group[] => {
            const result: Group[] = [];
            let current: Group | undefined = group;
            while (current && result.length < 64) {
                result.unshift(current);
                current = current.parent;
            }
            return result;
        };
        const nameCounts = new Map<string, number>();
        for (const route of root.routes) {
            const records = [...inherited(route.group).map(group => group.conventions), ...route.inheritedConventions ?? [], route.conventions], name = records.filter(record => record.name !== undefined).at(-1)?.name;
            if (name)
                nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
        }
        for (const route of root.routes.slice(0, 20000)) {
            const groups = inherited(route.group), records = [...groups.map(group => group.conventions), ...route.inheritedConventions ?? [], route.conventions], prefix = groups.map(group => group.prefix).filter(Boolean).map(value => value.replace(/^~?\//, '').replace(/\/$/, '')).filter(Boolean).join('/'), local = route.path.replace(/^~?\//, '').replace(/\/$/, ''), path = root.profile.pathBase + '/' + [prefix, local].filter(Boolean).join('/'), pattern = route.mvc ? compileAspNetMvcPath(path, root.profile.major ?? 8, route.mvc.pattern) ?? { ...compileAspNetPath(path, root.profile.major ?? 8), status: 'partial' as const, reason: 'MVC required values invalidate endpoint construction' } : compileAspNetPath(path, root.profile.major ?? 8);
            const gaps = [...root.profile.gaps, ...root.gaps, ...route.gaps, ...records.flatMap(record => record.gaps)], dispatchGaps = [...root.dispatchGaps, ...route.dispatchGaps, ...records.flatMap(record => record.dispatchGaps), ...pattern.status === 'partial' ? [pattern.reason!] : [], ...root.served ? [] : ['No original serving call reaches this WebApplication'], ...route.conditional ? ['Conditional endpoint registration'] : []];
            const authorization = records.flatMap(record => record.authorization), anonymous = records.some(record => record.anonymous), filters = records.flatMap(record => record.filters), name = records.filter(record => record.name !== undefined).at(-1)?.name;
            if (authorization.length && !anonymous)
                gaps.push('Authorization continuation/user policy outcome is unresolved');
            if (name && (nameCounts.get(name) ?? 0) > 1)
                gaps.push('Duplicate endpoint names can invalidate endpoint/link registration');
            const conditions = [...new Set([...gaps, ...dispatchGaps])], data: AspNetEndpointData = { order: records.filter(record => record.order !== undefined).at(-1)?.order ?? route.nativeOrder ?? 0, hosts: records.filter(record => record.hosts !== undefined).at(-1)?.hosts, registrationKnown: root.served && !route.conditional && !root.profile.gaps.length && !root.dispatchGaps.length, dispatchKnown: !dispatchGaps.length, authorization, anonymous, filters, ...name ? { name } : {} };
            const proof = [...root.profile.proof, ...root.proof, ...route.proof, ...records.flatMap(record => record.proof)], contract: RoutingContract = { version: 1, pattern, methods: route.methods, executionContext: 'server', registration: { file: (route.registrationOrigin ?? route.origin).file, line: (route.registrationOrigin ?? route.origin).expression.range.startLine, receiver: root.id }, mounts: groups.filter(group => group.parent).map(group => ({ id: group.id, file: route.origin.file, line: group.proof.find(fact => fact.line)?.line ?? route.origin.expression.range.startLine, prefix: group.prefix })), middleware: filters, conditions, dispatch: { dialect: 'aspnet', root: root.id, order: data.order ?? 0 }, aspnet: data };
            this.context.graph.contain({ id: route.id, type: 'api_endpoint', name: `${route.methods === '*' ? 'ANY' : route.methods.join('|')} ${path}`, path: route.origin.file, language: 'csharp', parentId: this.context.applicationIds.get(root.app.name), sourceRange: route.origin.expression.range, metadata: { framework: 'aspnetcore', frameworkPack: route.mvc ? 'aspnet-mvc' : route.pack ?? 'aspnet-minimal', packVersion: ASPNET_VERSION, frameworkVersion: root.profile.version ?? `${root.profile.major ?? 'unknown'}.0`, routePath: path, method: route.methods === '*' ? 'ANY' : route.methods.length === 1 ? route.methods[0] : 'ANY', routing: contract, executionContext: 'server', registration: conditions.length ? 'candidate' : 'selected', constraintsUnresolved: conditions.length > 0, handler: route.handler?.id, aspnetRoot: root.id, ...route.mvc ? { mvc: { controller: route.mvc.action.controller.id, controllerName: route.mvc.action.controllerName, actionName: route.mvc.action.actionName, area: route.mvc.action.area, routing: route.mvc.pattern.kind, routeName: route.mvc.routeName } } : {} }, evidence: proof });
            if (route.handler)
                this.context.graph.relate(route.id, route.handler.id, 'handles', proof, { framework: 'aspnetcore', version: ASPNET_VERSION, conditions });
            for (const filter of filters)
                this.context.graph.relate(route.id, filter, 'references', proof, { framework: 'aspnetcore', role: route.mvc ? 'mvc-filter' : 'endpoint-filter', conditions });
            for (const reason of conditions)
                this.context.graph.diagnose({ analyzer: 'aspnet', severity: 'warning', code: 'aspnet-registration-gap', file: route.origin.file, line: route.origin.expression.range.startLine, entityId: route.id, reason });
            this.seenFiles.add(route.origin.file);
        }
    }
    analyze(files: ScannedFile[]): void {
        const profiles: unknown[] = [];
        for (const app of this.context.config.applications) {
            const selected = files.filter(file => file.application?.name === app.name), definitions = selected.flatMap(file => this.symbols.definitions(file.path));
            if (!definitions.length)
                continue;
            const projects = this.symbols.resolver.projects.projects.filter(project => project.sources.some(source => selected.some(file => file.path === source)));
            for (const project of projects) {
                if (project.sdk !== 'Microsoft.NET.Sdk.Web' && !app.dotnet?.aspnet && !project.dependencies.some(dependency => dependency.name === 'Microsoft.AspNetCore.App'))
                    continue;
                this.operations = 0;
                const profile = aspNetProfile(this.context, project, app), compiled = definitions.filter(definition => this.symbols.resolver.projects.selection(definition.unit.file.path).project?.id === project.id), entries = app.entrypoints?.aspnet ?? [], top = compiled.filter(definition => definition.fact.kind === 'top-level'), mains = compiled.filter(definition => definition.fact.kind === 'method' && definition.fact.name === 'Main' && definition.fact.modifiers.includes('static') && (!project.properties.startupobject || definition.symbol?.syntax.qualifiedName === project.properties.startupobject + '.Main'));
                const roots = entries.length ? compiled.filter(definition => ['method', 'function', 'top-level'].includes(definition.fact.kind) && (entries.includes(definition.symbol?.syntax.qualifiedName ?? '') || definition.fact.name === 'Main' && entries.includes(this.ownerType(definition) ?? ''))) : top.length ? top : mains;
                if (roots.length !== 1)
                    profile.gaps.push('ASP.NET hosting requires one selected original top-level/Main entrypoint');
                if (!profile.gaps.length)
                    this.symbols.registerFrameworkTypes(project.id, [...knownTypes, ...mvcFrameworkTypes], profile.implicitUsings ? [...knownTypes] : [], profile.proof);
                if (!entries.length && mains.some(definition => definition.fact.kind === 'method' && !['void', 'int', 'Task', 'System.Threading.Tasks.Task', 'global::System.Threading.Tasks.Task', 'Task<int>', 'System.Threading.Tasks.Task<int>', 'global::System.Threading.Tasks.Task<int>'].includes(definition.fact.returnType ?? '') || definition.fact.modifiers.includes('async') && ['void', 'int'].includes(definition.fact.returnType ?? '')))
                    profile.gaps.push('Original Main return signature is outside reviewed entrypoint selection');
                if (project.properties.outputtype?.toLowerCase() === 'library' && !entries.length)
                    profile.gaps.push('Original project selects library output without a recorded hosting entrypoint');
                const allocated: Root[] = [];
                for (const definition of roots) {
                    const environment = this.symbols.resolver.environment(definition.unit.file.path);
                    if (environment.status !== 'resolved') {
                        profile.gaps.push(environment.reason);
                        continue;
                    }
                    if (!definition.fact.statements || definition.fact.gaps.length || definition.fact.typeParameters.length || definition.fact.kind !== 'top-level' && (definition.fact.parameters.length > 1 || definition.fact.parameters.some(parameter => parameter.type !== 'string[]' || parameter.modifiers.length)))
                        profile.gaps.push('Original entrypoint signature/body is outside reviewed minimal hosting');
                    const state: State = { definition, project, app, profile, values: new Map(), roots: allocated, chain: [definition.id], gaps: [], conditional: false, depth: 0, stack: new Set([definition.id]), stop: false };
                    this.seenFiles.add(definition.unit.file.path);
                    this.statements(definition.fact.statements ?? [], state);
                }
                // Lambda contracts are prepared before C# body extraction/cache capture.
                profiles.push({ application: app.name, project: project.id, major: profile.major, version: profile.version, pathBase: profile.pathBase, implicitUsings: profile.implicitUsings, entries: roots.map(root => root.id), roots: allocated.map(root => ({ id: root.id, served: root.served, gaps: [...root.gaps, ...root.dispatchGaps] })), gaps: profile.gaps, proof: profile.proof });
                for (const root of allocated)
                    this.materialize(root);
                for (const reason of new Set(profile.gaps))
                    this.context.graph.diagnose({ analyzer: 'aspnet', severity: 'warning', code: 'aspnet-profile-gap', file: project.id, reason });
            }
        }
        if (profiles.length)
            this.context.graph.entities.get(this.context.repositoryId)!.metadata.aspNetProfiles = profiles;
        for (const path of this.seenFiles) {
            const file = this.context.files.get(path), analysis = file && fileAnalysis(this.context.graph.entities.get(file.id)?.metadata.analysis);
            if (analysis)
                analysis.features.framework = { status: 'partial', reason: 'Serving-reachable original minimal hosting, groups/source helpers/delegates and bounded ASP.NET 8–10 routing; MVC attributes/conventional routes and original actions; middleware, custom metadata and runtime configuration retain gaps' };
        }
    }
}
