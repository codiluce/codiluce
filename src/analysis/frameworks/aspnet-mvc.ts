import type { AnalysisContext } from '../../core/analyzer.js';
import { evidence, type Evidence } from '../../core/graph.js';
import type { CsharpAttribute, CsharpExpression } from '../facts.js';
import type { CsharpDefinition, CsharpSymbols } from '../languages/csharp-symbols.js';
import type { CsharpType } from '../languages/csharp-types.js';
import type { DotnetProject } from '../resolution/dotnet-projects.js';
import { compileAspNetMvcPath, type AspNetMvcPattern } from '../routes/aspnet-patterns.js';
import { ASPNET_VERSION } from './aspnet-profile.js';
const MVC = 'Microsoft.AspNetCore.Mvc.', AUTH = 'Microsoft.AspNetCore.Authorization.';
const http: Record<string, string> = { HttpGet: 'GET', HttpPost: 'POST', HttpPut: 'PUT', HttpDelete: 'DELETE', HttpPatch: 'PATCH', HttpHead: 'HEAD', HttpOptions: 'OPTIONS' };
const nativeAttributes = new Set([...Object.keys(http), 'AcceptVerbs', 'Route', 'Area', 'ActionName', 'NonAction', 'Controller', 'NonController', 'ApiController', 'ApiExplorerSettings', 'Produces', 'ProducesResponseType', 'ProducesDefaultResponseType', 'ResponseCache', 'Consumes', 'ServiceFilter', 'TypeFilter', 'FromRoute', 'FromQuery', 'FromBody', 'FromHeader', 'FromServices', 'FromForm', 'Bind', 'BindRequired', 'BindNever', 'ValidateNever', 'IgnoreAntiforgeryToken', 'ValidateAntiForgeryToken', 'AutoValidateAntiforgeryToken'].map(name => MVC + name + 'Attribute').concat([AUTH + 'AuthorizeAttribute', AUTH + 'AllowAnonymousAttribute']));
export const mvcFrameworkTypes = [MVC + 'Controller', MVC + 'ControllerBase', MVC + 'IActionResult', MVC + 'ActionResult', MVC + 'MvcOptions', MVC + 'Filters.ActionExecutingContext', MVC + 'Filters.ActionExecutedContext', MVC + 'Filters.ActionExecutionDelegate', ...nativeAttributes];
interface Attribute {
    name: string;
    fact: CsharpAttribute;
    definition: CsharpDefinition;
    proof: Evidence[];
    values: (string | number | boolean | null | undefined)[];
    named: Map<string, string | number | boolean | null | undefined>;
}
interface Selector {
    path?: string;
    methods: string[] | '*';
    order?: number;
    name?: string;
    proof: Evidence[];
    gaps: string[];
}
export interface MvcAction {
    controller: CsharpType;
    handler: CsharpDefinition;
    controllerName: string;
    actionName: string;
    area: string | null;
    path?: string;
    methods: string[] | '*';
    order: number;
    name?: string;
    pattern: AspNetMvcPattern;
    authorization: string[];
    anonymous: boolean;
    filters: string[];
    gaps: string[];
    dispatchGaps: string[];
    proof: Evidence[];
}
export interface MvcModel {
    actions: MvcAction[];
    gaps: string[];
    proof: Evidence[];
}
const union = (a: string[] | '*', b: string[] | '*'): string[] | '*' => a === '*' ? b : b === '*' ? a : [...new Set([...a, ...b])];
/** Original MVC application-model inputs. Discovery, attribute inheritance and
 * effective methods are bounded source operations, never target reflection. */
export class AspNetMvc {
    private operations = 0;
    constructor(readonly context: AnalysisContext, readonly symbols: CsharpSymbols) { }
    private proof(definition: CsharpDefinition, site: CsharpAttribute | CsharpDefinition['fact'], reason: string): Evidence[] { return [{ ...evidence('framework', 'aspnet', definition.unit.file.path, site.range.startLine, reason), endLine: site.range.endLine, analyzerVersion: ASPNET_VERSION }]; }
    private definitions(type: CsharpType) { return type.parts.flatMap(part => { const d = this.symbols.definition(part.file.path, part.syntax.key); return d ? [{ ...d, symbol: part }] : []; }); }
    private attrs(definitions: CsharpDefinition[], gaps: string[]): Attribute[] {
        return definitions.flatMap(definition => definition.fact.attributes.map(fact => this.attribute(definition, fact, gaps)).filter((value): value is Attribute => !!value));
    }
    private attribute(definition: CsharpDefinition, fact: CsharpAttribute, gaps: string[]): Attribute | undefined {
        const value = this.symbols.attribute(definition.unit.file.path, definition.fact.scope, fact);
        const names = value.kind === 'external' ? value.names.filter(name => nativeAttributes.has(name)) : [];
        if (names.length !== 1) {
            gaps.push('Custom, shadowed or unresolved MVC attribute: ' + fact.type);
            return;
        }
        const name = names[0]!, constants = fact.args.map(arg => this.symbols.constant(definition.unit.file.path, definition.fact.scope, arg.value)), values = constants.map(v => v.status === 'resolved' ? v.value : undefined);
        if (fact.args.some(arg => arg.modifier))
            gaps.push('Ref argument in MVC attribute');
        return { name, fact, definition, values: values.filter((_, i) => !fact.args[i]?.name), named: new Map(fact.args.flatMap((arg, i) => arg.name ? [[arg.name, values[i]] as const] : [])), proof: [...value.proof, ...constants.flatMap(v => v.proof), ...this.proof(definition, fact, 'Original native MVC attribute ' + name)] };
    }
    private isRoute(attribute: Attribute) { return attribute.name === MVC + 'RouteAttribute' || attribute.name === MVC + 'AcceptVerbsAttribute' || Object.keys(http).some(name => attribute.name === MVC + name + 'Attribute'); }
    private effective(levels: Attribute[][]): Attribute[] {
        const routes = levels.find(level => level.some(a => this.isRoute(a)))?.filter(a => this.isRoute(a)) ?? [], result = [...routes], single = new Set<string>();
        for (const level of levels)
            for (const a of level) {
                if (this.isRoute(a))
                    continue;
                // Native Authorize permits multiple inherited instances. Other
                // reviewed single-use attributes prefer the most derived level.
                if (a.name === AUTH + 'AuthorizeAttribute' || !single.has(a.name)) {
                    result.push(a);
                    single.add(a.name);
                }
            }
        return result;
    }
    private hierarchy(type: CsharpType, gaps: string[], seen = new Set<string>()): CsharpType[] {
        if (++this.operations > 100000 || seen.has(type.id) || seen.size > 32) {
            gaps.push('MVC source inheritance budget/cycle');
            return [type];
        }
        seen.add(type.id);
        const bases = this.definitions(type).flatMap(d => (d.symbol?.syntax.bases ?? []).map(name => ({ d, name }))), source = new Map<string, CsharpType>();
        for (const { d, name } of bases) {
            const value = this.symbols.canonicalType(d.unit.file.path, d.fact.scope, name, d.fact);
            if (value.kind === 'type' && ['class', 'record-class'].includes(value.type.kind))
                source.set(value.type.id, value.type);
            else if (value.kind === 'external' && value.names.filter(name => [MVC + 'Controller', MVC + 'ControllerBase', 'System.Object', 'System.IDisposable'].includes(name)).length === 1) {
                if (value.names[0] === 'System.IDisposable')
                    gaps.push('Source IDisposable/controller filter implementation requires reviewed interface mapping');
            }
            else
                gaps.push('Unreviewed MVC base/interface can change discovery, actions or filters: ' + name);
        }
        if (source.size > 1)
            gaps.push('Competing MVC source base classes');
        return [type, ...source.size === 1 ? this.hierarchy([...source.values()][0]!, gaps, seen) : []];
    }
    private signature(d: CsharpDefinition, gaps: string[]): string {
        const params = d.fact.parameters.map(p => {
            if (p.modifiers.length || !p.type) {
                gaps.push('Unreviewed MVC action signature/ref binding');
                return p.type ?? '?';
            }
            const value = this.symbols.canonicalType(d.unit.file.path, d.fact.scope, p.type, d.fact);
            if (value.kind === 'primitive')
                return value.name;
            if (value.kind === 'type')
                return value.type.id;
            if (value.kind === 'external') {
                const native = value.names.filter(name => mvcFrameworkTypes.includes(name));
                if (native.length === 1)
                    return native[0];
                if (value.names.length === 1)
                    return value.names[0];
            }
            gaps.push('Unreviewed inherited MVC method signature: ' + p.type);
            return p.type;
        });
        return JSON.stringify([d.fact.name, d.fact.typeParameters.length, params]);
    }
    private controllerHook(d: CsharpDefinition): boolean {
        const expected: Record<string, string[]> = { OnActionExecuting: [MVC + 'Filters.ActionExecutingContext'], OnActionExecuted: [MVC + 'Filters.ActionExecutedContext'], OnActionExecutionAsync: [MVC + 'Filters.ActionExecutingContext', MVC + 'Filters.ActionExecutionDelegate'] };
        const parameters = expected[d.fact.name];
        return !!parameters && d.fact.modifiers.includes('override') && d.fact.parameters.length === parameters.length && d.fact.parameters.every((p, index) => {
            const value = p.type && this.symbols.canonicalType(d.unit.file.path, d.fact.scope, p.type, d.fact);
            return value && value.kind === 'external' && value.names.includes(parameters[index]!);
        });
    }
    private methods(levels: CsharpType[], gaps: string[], nativeBase = false): {
        definition: CsharpDefinition;
        attributes: Attribute[];
    }[] {
        const methods = new Map<string, {
            definition: CsharpDefinition;
            levels: Attribute[][];
            declarations: CsharpDefinition[];
        }>(), hidden = new Set<string>();
        for (const type of levels) {
            const seenLevel = new Set<string>();
            for (const member of this.symbols.resolver.types.members(type)) {
                const d = this.symbols.definition(member.file.path, member.syntax.key);
                if (!d || d.fact.kind !== 'method')
                    continue;
                const definition = { ...d, symbol: member }, key = this.signature(definition, gaps), attributes = this.attrs([definition], gaps), selected = methods.get(key);
                if (seenLevel.has(key))
                    gaps.push('Competing original MVC method/partial implementation');
                seenLevel.add(key);
                if (selected) {
                    if (selected.definition.fact.modifiers.includes('override') && !hidden.has(key)) {
                        selected.levels.push(attributes);
                        selected.declarations.push(definition);
                    }
                    continue;
                }
                // Reflection selects the most derived declaration. Private and
                // static members cannot be action bodies; unreviewed hiding
                // signatures retain a gap instead of borrowing a base action.
                methods.set(key, { definition, levels: [attributes], declarations: [definition] });
                if (definition.fact.modifiers.includes('new'))
                    hidden.add(key);
            }
        }
        return [...methods.values()].filter(v => {
            // Native Controller helpers and filter hooks carry inherited
            // NonAction. An original source virtual base definition takes
            // precedence; framework overrides cannot invent an action.
            if (nativeBase && v.definition.fact.modifiers.includes('override') && v.declarations.at(-1)!.fact.modifiers.includes('override')) {
                const hooks = ['OnActionExecuting', 'OnActionExecuted', 'OnActionExecutionAsync'];
                if (!hooks.includes(v.definition.fact.name))
                    gaps.push('Framework override/NonAction signature requires reviewed native inheritance');
                return false;
            }
            return true;
        }).map(v => {
            // Native MethodInfo.GetBaseDefinition jumps to the original
            // declaration when the selected override declares no route attrs.
            const inherited = this.effective(v.levels).filter(a => !this.isRoute(a));
            const routes = (v.levels[0]!.some(a => this.isRoute(a)) ? v.levels[0] : v.levels.at(-1))!.filter(a => this.isRoute(a));
            return { definition: v.definition, attributes: [...routes, ...inherited] };
        }).filter(({ definition: d, attributes }) => d.symbol?.syntax.visibility === 'public' && !d.fact.modifiers.some(m => ['static', 'abstract'].includes(m)) && !d.fact.typeParameters.length && !attributes.some(a => a.name === MVC + 'NonActionAttribute') && !(d.fact.modifiers.includes('override') && ['Equals', 'GetHashCode', 'ToString'].includes(d.fact.name)));
    }
    private selectors(attributes: Attribute[]): Selector[] {
        const routes = attributes.filter(a => this.isRoute(a)), providers = routes.map(a => {
            const short = a.name.slice(MVC.length).replace(/Attribute$/, ''), gaps: string[] = [];
            let path: string | undefined, methods: string[] | '*' = http[short] ? [http[short]!] : short === 'AcceptVerbs' ? a.values.every(v => typeof v === 'string') && a.values.length ? a.values as string[] : '*' : '*';
            if (short === 'AcceptVerbs') {
                const route = a.named.get('Route');
                if (typeof route === 'string')
                    path = route;
                else if (a.named.has('Route') && route !== null) {
                    path = '/{**unresolved}';
                    gaps.push('Opaque AcceptVerbs Route');
                }
                if (methods === '*')
                    gaps.push('Unreviewed AcceptVerbs method list');
            }
            else if (a.values.length) {
                if (a.values.length === 1 && typeof a.values[0] === 'string')
                    path = a.values[0];
                else {
                    path = '/{**unresolved}';
                    gaps.push('Opaque MVC attribute template/overload');
                }
            }
            else if (short === 'Route') {
                path = '/{**unresolved}';
                gaps.push('Missing MVC Route template');
            }
            let order: number | undefined, name: string | undefined;
            for (const [key, value] of a.named) {
                if (key === 'Order' && typeof value === 'number' && Number.isInteger(value) && value >= -2147483648 && value <= 2147483647)
                    order = value;
                else if (key === 'Name' && typeof value === 'string')
                    name = value;
                else if (key === 'Name' && value === null || key === 'Route' && short === 'AcceptVerbs')
                    continue;
                else
                    gaps.push('Unreviewed MVC routing attribute property: ' + key);
            }
            if (methods !== '*') {
                if (methods.some(method => !method || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(method)))
                    gaps.push('Invalid MVC HTTP method');
                methods = [...new Set(methods.map(m => m.toUpperCase()))];
            }
            return { attribute: a, path, methods, order, name, proof: a.proof, gaps, silent: path === undefined && order === undefined && name === undefined && !gaps.length };
        });
        const defining = providers.filter(p => !p.silent), silent = providers.filter(p => p.silent), result: Selector[] = [];
        for (const p of defining) {
            const others = p.methods === '*' ? silent : [];
            result.push({ ...p, methods: others.reduce((value, other) => union(value, other.methods), p.methods), proof: [...p.proof, ...others.flatMap(v => v.proof)] });
        }
        if (!defining.length || silent.length && defining.every(p => p.methods !== '*'))
            result.push({ methods: silent.reduce<string[] | '*'>((value, p) => union(value, p.methods), '*'), proof: silent.flatMap(p => p.proof), gaps: silent.flatMap(p => p.gaps) });
        return result;
    }
    private token(template: string, values: Record<string, string | null>, gaps: string[]): string {
        let result = '';
        for (let i = 0; i < template.length;) {
            if (template.startsWith('[[', i)) {
                result += '[';
                i += 2;
                continue;
            }
            if (template.startsWith(']]', i)) {
                result += ']';
                i += 2;
                continue;
            }
            if (template[i] === '[') {
                const end = template.indexOf(']', i + 1), key = template.slice(i + 1, end).toLowerCase();
                if (end < 0 || !Object.hasOwn(values, key)) {
                    gaps.push('Invalid/unknown MVC route token');
                    return '/{**unresolved}';
                }
                result += values[key] ?? '';
                i = end + 1;
                continue;
            }
            if (template[i] === ']')
                gaps.push('Unescaped MVC closing token bracket');
            result += template[i++];
        }
        return result;
    }
    model(project: DotnetProject, major: 8 | 9 | 10, suppressAsync = true): MvcModel {
        this.operations = 0;
        const actions: MvcAction[] = [], gaps: string[] = [], proof: Evidence[] = [];
        const classpath = this.symbols.resolver.projects.classpath(project), available = new Set(classpath.projects.map(p => p.id)), types = [...this.symbols.resolver.types.types.values()].filter(t => available.has(t.project));
        for (const file of classpath.projects.flatMap(p => p.sources))
            for (const fact of this.symbols.facts(file)?.attributes ?? []) {
                const value = this.symbols.attribute(file, fact.scope, fact);
                if (!(value.kind === 'external' && value.names.length === 1 && (value.names[0] === MVC + 'ApiControllerAttribute' || /^System\.Reflection\.Assembly(?:Title|Description|Company|Product|Copyright|Trademark|Version|FileVersion|InformationalVersion|Configuration|Culture)Attribute$/.test(value.names[0]!))))
                    gaps.push('Unreviewed assembly attribute can customize MVC application parts/metadata: ' + fact.type);
            }
        const allAreas = new Set<string>();
        for (const type of types) {
            if (!['class', 'record-class'].includes(type.kind) || type.parent || type.arity || type.visibility !== 'public' || type.modifiers.some(m => ['abstract', 'static'].includes(m)))
                continue;
            const localGaps = [...type.gaps], levels = this.hierarchy(type, localGaps), levelAttrs = levels.map(level => this.attrs(this.definitions(level), localGaps)), attributes = this.effective(levelAttrs), short = type.name.split('.').at(-1)!;
            const nativeBase = levels.some(level => this.definitions(level).some(d => (d.symbol?.syntax.bases ?? []).some(name => { const value = this.symbols.canonicalType(d.unit.file.path, d.fact.scope, name, d.fact); return value.kind === 'external' && value.names.filter(name => [MVC + 'Controller', MVC + 'ControllerBase'].includes(name)).length === 1; })));
            if (attributes.some(a => a.name === MVC + 'NonControllerAttribute') || !/Controller$/i.test(short) && !attributes.some(a => a.name === MVC + 'ControllerAttribute') && !nativeBase)
                continue;
            if (type.kind === 'record-class' || this.definitions(type).some(d => d.fact.parameters.length))
                localGaps.push('Record/primary/generated controller members and activation require a reviewed profile');
            // Native Controller/ControllerBase carry [Controller]. Short original
            // base imports must resolve to those exact framework identities.
            const controllerName = short.replace(/Controller$/i, ''), areaAttr = attributes.find(a => a.name === MVC + 'AreaAttribute'), area = areaAttr?.values[0];
            if (areaAttr && (areaAttr.values.length !== 1 || typeof area !== 'string'))
                localGaps.push('Opaque MVC Area route value');
            const constructors = this.symbols.resolver.types.members(type).filter(m => m.declaration.kind === 'constructor');
            if (constructors.length && constructors.some(m => m.syntax.visibility !== 'public' || this.symbols.definition(m.file.path, m.syntax.key)?.fact.parameters.length || this.symbols.definition(m.file.path, m.syntax.key)?.fact.gaps.length))
                localGaps.push('Custom/DI MVC controller activation requires reviewed services');
            if (type.project !== project.id)
                localGaps.push('Referenced controller assembly application-part activation is unreviewed');
            const assemblyApi = project.sources.some(file => (this.symbols.facts(file)?.attributes ?? []).some(fact => this.symbols.attribute(file, fact.scope, fact).kind === 'external' && (this.symbols.attribute(file, fact.scope, fact) as {
                names: string[];
            }).names.includes(MVC + 'ApiControllerAttribute')));
            const api = assemblyApi || attributes.some(a => a.name === MVC + 'ApiControllerAttribute');
            const controllerSelectors = this.selectors(attributes), routed = controllerSelectors.filter(s => s.path !== undefined), nonrouteMethods = attributes.filter(a => !this.isRoute(a));
            const hooks = nativeBase ? levels.flatMap(level => this.symbols.resolver.types.members(level)).flatMap(member => { const d = this.symbols.definition(member.file.path, member.syntax.key); return d && this.controllerHook(d) ? [d] : []; }) : [];
            for (const { definition, attributes: methodAttrs } of this.methods(levels, localGaps, nativeBase)) {
                const actionAttr = methodAttrs.find(a => a.name === MVC + 'ActionNameAttribute'), name = actionAttr?.values[0], methodGaps: string[] = [];
                if (actionAttr && (actionAttr.values.length !== 1 || typeof name !== 'string'))
                    methodGaps.push('Opaque MVC ActionName');
                const actionName = typeof name === 'string' ? name : suppressAsync ? definition.fact.name.replace(/Async$/, '') : definition.fact.name;
                if (definition.fact.gaps.length || !definition.fact.hasBody)
                    methodGaps.push('Original MVC action body/signature is unavailable or unreviewed');
                if (definition.fact.parameters.some(p => p.attributes?.length))
                    methodGaps.push('MVC parameter attributes/model binding require a reviewed profile');
                const actionArea = methodAttrs.find(a => a.name === MVC + 'AreaAttribute')?.values[0] ?? area;
                if (typeof actionArea === 'string' && !/^[\x00-\x7f]*$/.test(actionArea))
                    localGaps.push('Unicode MVC area required values need a reviewed ordinal case profile');
                const requiredValues = { controller: controllerName, action: actionName, area: typeof actionArea === 'string' ? actionArea : null };
                if (requiredValues.area)
                    allAreas.add(requiredValues.area);
                const combinedAttrs = [...attributes, ...methodAttrs], authorization = combinedAttrs.filter(a => a.name === AUTH + 'AuthorizeAttribute').map(a => typeof a.named.get('Policy') === 'string' ? a.named.get('Policy') as string : '<default>'), anonymous = combinedAttrs.some(a => a.name === AUTH + 'AllowAnonymousAttribute'), filters: string[] = hooks.map(d => d.id);
                if (hooks.length)
                    methodGaps.push('Original MVC controller filter override continuation/short circuit is unreviewed');
                for (const a of combinedAttrs) {
                    if ([MVC + 'ConsumesAttribute', MVC + 'ServiceFilterAttribute', MVC + 'TypeFilterAttribute', MVC + 'ValidateAntiForgeryTokenAttribute', MVC + 'AutoValidateAntiforgeryTokenAttribute', MVC + 'IgnoreAntiforgeryTokenAttribute', MVC + 'ResponseCacheAttribute'].includes(a.name))
                        methodGaps.push('MVC filter/content/action constraint continuation is unreviewed: ' + a.name);
                    if (a.name === MVC + 'ServiceFilterAttribute' || a.name === MVC + 'TypeFilterAttribute')
                        for (const arg of a.fact.args) {
                            if (arg.value.kind === 'typeof') {
                                const v = this.symbols.canonicalType(a.definition.unit.file.path, a.definition.fact.scope, arg.value.type, arg.value);
                                if (v.kind === 'type')
                                    filters.push(...v.type.parts.map(p => p.id));
                            }
                        }
                }
                if (definition.fact.parameters.some(p => p.modifiers.length || !['string', 'int', 'long', 'bool', 'float', 'double', 'decimal', 'char', 'short', 'byte', 'sbyte', 'ushort', 'uint', 'ulong'].includes(p.type ?? '')))
                    methodGaps.push('MVC custom/service/model binding requires a reviewed profile');
                const returnType = definition.fact.returnType ?? '', returnValue = this.symbols.canonicalType(definition.unit.file.path, definition.fact.scope, returnType, definition.fact);
                if (returnValue.kind !== 'primitive' && !(returnValue.kind === 'external' && returnValue.names.length === 1 && [MVC + 'IActionResult', MVC + 'ActionResult', 'System.Threading.Tasks.Task'].includes(returnValue.names[0]!)))
                    methodGaps.push('MVC custom/generic result metadata requires a reviewed profile');
                for (const action of this.selectors(methodAttrs)) {
                    const absolute = action.path?.startsWith('/') || action.path?.startsWith('~/'), prefixes = absolute ? [undefined] : routed.length ? routed : [undefined];
                    for (const prefix of prefixes) {
                        const path = action.path !== undefined || prefix?.path !== undefined ? this.token(absolute ? action.path! : [prefix?.path, action.path].filter(v => v !== undefined && v !== '').map(v => v!.replace(/^~?\//, '').replace(/\/$/, '')).join('/'), requiredValues, methodGaps) : undefined;
                        if (api && path === undefined)
                            gaps.push('ApiController contains an action without attribute routing');
                        if (path === undefined && combinedAttrs.some(a => a.name === MVC + 'ApiExplorerSettingsAttribute' && a.named.get('IgnoreApi') !== true))
                            gaps.push('Visible MVC ApiExplorerSettings action requires attribute routing');
                        const selectorGaps = [...action.gaps, ...prefix?.gaps ?? []], pattern: AspNetMvcPattern = { kind: 'attribute', requiredValues };
                        if (path !== undefined && !compileAspNetMvcPath(path, major, pattern))
                            gaps.push('MVC reserved route values/constraints invalidate attribute endpoint construction');
                        const routeName = action.name ?? (!action.path ? prefix?.name : undefined);
                        actions.push({ controller: type, handler: definition, controllerName, actionName, area: requiredValues.area, path, methods: union(action.methods, prefix?.methods ?? '*'), order: action.order ?? prefix?.order ?? 0, ...routeName !== undefined ? { name: this.token(routeName, requiredValues, methodGaps) } : {}, pattern, authorization, anonymous, filters, gaps: [...methodGaps], dispatchGaps: [...selectorGaps, ...methodGaps.filter(gap => /content\/action constraint|result metadata|route token|closing token/.test(gap))], proof: [...type.proof, ...definition.symbol?.proof ?? [], ...attributes.flatMap(a => a.proof), ...methodAttrs.flatMap(a => a.proof), ...action.proof, ...prefix?.proof ?? [], ...nonrouteMethods.flatMap(a => a.proof), ...definition.fact.parameters.flatMap(p => (p.attributes ?? []).flatMap(a => this.proof(definition, a, 'Original MVC parameter binding attribute')))] });
                    }
                }
            }
            gaps.push(...localGaps);
            proof.push(...type.proof);
        }
        const byMethod = new Map<string, Set<boolean>>();
        for (const action of actions) {
            const key = action.controller.id + ':' + action.handler.id, states = byMethod.get(key) ?? new Set();
            states.add(action.path !== undefined);
            byMethod.set(key, states);
        }
        if ([...byMethod.values()].some(states => states.size > 1))
            gaps.push('MVC action mixes attribute and conventional routing selectors');
        // MVC normalizes every action's route-value keys. An area action makes
        // non-area actions require null area, preventing area-route leakage.
        if (!allAreas.size)
            for (const action of actions)
                delete action.pattern.requiredValues.area;
        const named = new Map<string, string>();
        for (const action of actions)
            if (action.name !== undefined && action.path !== undefined) {
                const key = action.name.toLowerCase(), previous = named.get(key);
                if (previous !== undefined && previous.toLowerCase() !== action.path.toLowerCase())
                    gaps.push('MVC routes sharing a name have different templates');
                named.set(key, action.path);
            }
        return { actions, gaps: [...new Set(gaps)], proof };
    }
}
