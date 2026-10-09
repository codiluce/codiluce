import type { AnalysisContext, Analyzer } from '../../core/analyzer.js';
import { evidence, type Evidence, type SourceRange } from '../../core/graph.js';
import { fileAnalysis, type RustBindingFact, type RustExpression, type RustSite } from '../facts.js';
import { RustSymbols, type RustDefinition } from '../languages/rust-symbols.js';
import { rustAnd, rustCfg, rustSplit } from '../languages/rust-cfg.js';
import { RustResolver, type RustScope } from '../resolution/rust.js';
import { compileRustPath, type RustRouteDialect, type RustEndpointData } from '../routes/rust-patterns.js';
import type { RoutingContract, RoutePattern } from '../routes/contracts.js';
import { compileRocketPath, rocketPathsCollide, reviewedRocketMount } from '../routes/rocket-patterns.js';
import { STRUCTURE_VERSION } from '../tree-sitter/analyzer.js';
import { fileKey } from '../../pipeline/cache.js';
import { rustWebProfile, rustWebAttribute, rustWebAttributeReader, rustWebMacroResolution, RustWebMacros, RUST_ROUTER_VERSION, type RustWebProfile, type RustWebAttribute } from './rust-profile.js';
type Framework = 'axum' | 'actix-web' | 'rocket';
type Methods = string[] | '*';
interface Site extends RustSite {
    file: string;
}
interface Environment {
    scope: RustScope;
    origin: RustScope;
    runtime: string;
    frame: string;
    owner: string;
    locals: Map<string, Value>;
    stack: string[];
    conditions: string[];
    proof: Evidence[];
}
interface Callback {
    kind: 'callback';
    definition: RustDefinition;
    scope: RustScope;
    environment: Environment;
    proof: Evidence[];
    conditions: string[];
    attribute?: RustWebAttribute;
}
interface Native {
    kind: 'native';
    profile: RustWebProfile;
}
interface Route {
    site: Site;
    methods: Methods;
    callback?: Callback;
    conditions: string[];
    proof: Evidence[];
    middleware: string[];
    fallback?: boolean;
    headFallback?: boolean;
}
interface MethodRouter {
    kind: 'method';
    framework: Framework;
    dialect: RustRouteDialect;
    routes: Route[];
    conditions: string[];
    proof: Evidence[];
    consumed?: boolean;
}
interface Entry {
    site: Site;
    path: string;
    routes: Route[];
    child?: Router;
    methods: Methods;
    conditions: string[];
    proof: Evidence[];
    mounts: RoutingContract['mounts'];
    middleware: string[];
    pathFallback?: boolean;
}
interface Router {
    kind: 'router';
    framework: Framework;
    dialect: RustRouteDialect;
    mode: 'router' | 'app' | 'scope' | 'resource' | 'config';
    id: string;
    site: Site;
    entries: Entry[];
    paths: string[];
    routes: Route[];
    methods: Methods;
    fallback?: Route;
    conditions: string[];
    proof: Evidence[];
    middleware: string[];
    legacy: boolean;
    rocketIgnited?: boolean;
    consumed?: boolean;
}
interface Server {
    kind: 'server';
    router?: Router;
    environment: Environment;
    bound: boolean;
    running: boolean;
    proof: Evidence[];
    conditions: string[];
}
interface Future {
    kind: 'future';
    server?: Server;
    result?: Value;
    environment?: Environment;
}
interface Listener {
    kind: 'listener';
    proof: Evidence[];
}
interface Guard {
    kind: 'guard';
    methods: Methods;
    conditions: string[];
    proof: Evidence[];
}
interface Middleware {
    kind: 'middleware';
    targets: string[];
    conditions: string[];
    proof: Evidence[];
}
type Value = Native | Callback | Router | MethodRouter | Server | Future | Listener | Guard | Middleware | string | number | boolean | null | Value[] | undefined;
const is = <K extends 'native' | 'callback' | 'router' | 'method' | 'server' | 'future' | 'listener' | 'guard' | 'middleware'>(value: Value, kind: K): value is Extract<Value, {
    kind: K;
}> => !!value && typeof value === 'object' && !Array.isArray(value) && value.kind === kind;
const unique = <T>(values: T[]) => [...new Set(values)];
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'CONNECT', 'TRACE'];
const intersect = (a: Methods, b: Methods): Methods => a === '*' ? b : b === '*' ? a : a.filter(method => b.includes(method));
const union = (a: Methods, b: Methods): Methods => a === '*' || b === '*' ? '*' : unique([...a, ...b]);
const siteOf = (env: Environment, site: RustSite): Site => ({ ...site, file: env.scope.file.path });
const cloneRoute = (route: Route): Route => ({ ...route, conditions: [...route.conditions], proof: [...route.proof], middleware: [...route.middleware] });
const join = (prefix: string, path: string, dialect: RustRouteDialect) => !prefix ? path : dialect.startsWith('axum') ? prefix.endsWith('/') ? prefix + path.replace(/^\/+/, '') : path === '/' ? prefix : prefix + path : prefix + path;
/** Bounded source registration summaries, reached from selected original bin
 * main bodies. Native constructors/serving contracts visit source helpers and
 * closures; no target Rust, macro expansion, dependency or toolchain runs. */
export class RustRegistrations {
    private readonly values = new Map<string, Value>();
    private readonly ordinals = new Map<string, number>();
    private readonly runtimeGaps = new Map<string, string[]>();
    private readonly builders: {
        router: Router;
        env: Environment;
    }[] = [];
    private readonly exposed = new Set<string>();
    private readonly pending: {
        server: Server;
        env: Environment;
        site: Site;
    }[] = [];
    private readonly handlerCalls = new Set<string>();
    private readonly scopeIndex: Map<string, RustScope>;
    private steps = 0;
    constructor(private readonly context: AnalysisContext, private readonly base: RustResolver, private readonly symbols: RustSymbols, private readonly macros: RustWebMacros) {
        this.scopeIndex = new Map(symbols.resolver.scopes.map(scope => [JSON.stringify([scope.compilation.id, scope.file.path, scope.fact.key]), scope]));
    }
    private fact(site: Site, reason: string): Evidence { return { ...evidence('framework', 'rust-routers', site.file, site.range.startLine, reason), endLine: site.range.endLine, analyzerVersion: RUST_ROUTER_VERSION }; }
    private gap(env: Environment, site: Site, reason: string): void {
        this.runtimeGaps.set(env.runtime, unique([...this.runtimeGaps.get(env.runtime) ?? [], reason]));
        this.context.graph.diagnose({ analyzer: 'rust-routers', severity: 'warning', code: 'rust-registration-gap', file: site.file, line: site.range.startLine, entityId: this.symbols.owner(env.scope), reason });
    }
    private scope(file: string, key: string, from: RustScope): RustScope | undefined { return this.scopeIndex.get(JSON.stringify([from.compilation.id, file, key])); }
    private ordinal(key: string): number { const count = this.ordinals.get(key) ?? 0; this.ordinals.set(key, count + 1); return count; }
    private conditions(env: Environment, scope: RustScope): string[] {
        const conditions = [...env.conditions, ...scope.gaps, ...scope.active !== true ? ['Unselected Rust registration cfg'] : []];
        for (let current: RustScope | undefined = scope; current; current = current.parent) {
            if (current.fact.kind === 'control')
                conditions.push('Conditional/iterated Rust registration order is unproven');
            if (current.fact.owner)
                break;
        }
        return unique(conditions);
    }
    private binding(scope: RustScope, name: string, at: number): RustBindingFact | undefined {
        let barrier = false;
        for (let current: RustScope | undefined = scope; current; current = current.parent) {
            const candidates = this.symbols.facts(current.file.path)?.bindings.filter(binding => binding.scope === current!.fact.key && binding.name === name && binding.activation <= at && this.symbols.resolver.attributes(binding.attributes, current!.compilation, current!.file.path, current!.fact.key).active !== false).sort((a, b) => b.activation - a.activation || b.start - a.start) ?? [];
            if (candidates.length)
                return barrier ? undefined : candidates[0];
            if (current.fact.owner) {
                const definition = this.symbols.definition(current.file.path, current.fact.owner);
                if (definition && !['closure', 'async'].includes(definition.fact.kind))
                    barrier = true;
            }
        }
        return;
    }
    private bindingKey(file: string, binding: RustBindingFact): string { return JSON.stringify([file, binding.scope, binding.name, binding.start]); }
    private reviewedAttributes(definition: RustDefinition, scope: RustScope): RustWebAttribute[] {
        const baseScope = this.base.scopes.find(s => s.compilation.id === scope.compilation.id && s.file.path === definition.unit.file.path && s.fact.key === definition.fact.scope);
        if (!baseScope)
            return [];
        const expand = (attribute: string, depth = 0): string[] => {
            if (depth > 32)
                return [attribute];
            const text = attribute.replace(/^#!?\[/, '').replace(/\]$/, '').trim(), match = /^cfg_attr\s*\(([\s\S]*)\)$/.exec(text);
            if (match) {
                const args = rustSplit(match[1]!);
                if (args && args.length >= 2 && rustCfg(args[0]!, scope.compilation.environment) === true)
                    return args.slice(1).flatMap(arg => expand(arg, depth + 1));
            }
            return [attribute];
        };
        return definition.fact.attributes.flatMap(attribute => expand(attribute)).map(attribute => rustWebAttribute(this.base, baseScope, attribute, definition.fact.start)).filter((attribute): attribute is RustWebAttribute => !!attribute);
    }
    private callback(env: Environment, expression: RustExpression): Callback | undefined {
        const result = this.symbols.handler(env.scope, expression);
        if (result.status !== 'resolved')
            return;
        const attributes = this.reviewedAttributes(result.definition, result.scope).filter(attribute => attribute.kind === 'route');
        return { kind: 'callback', definition: result.definition, scope: result.scope, environment: env, proof: result.proof, conditions: unique([...result.conditions, ...attributes.length > 1 ? ['Competing Rust route attributes require an explicit multi-route contract'] : []]), attribute: attributes[0] };
    }
    private route(env: Environment, site: Site, methods: Methods, value: Value): Route {
        const callback = is(value, 'callback') && !value.attribute ? value : undefined;
        return { site, methods, callback, proof: [this.fact(site, 'Original native Rust handler registration'), ...callback?.proof ?? []], conditions: unique([...this.conditions(env, env.scope), ...callback?.conditions ?? [], ...!callback ? ['Original Rust handler is unresolved or a macro service factory'] : [], ...callback?.definition.fact.generics ? ['Generic Rust Handler instantiation is unreviewed'] : [], ...callback && !callback.definition.fact.async && callback.definition.fact.kind !== 'closure' ? ['Rust handler return Future contract is unreviewed'] : []]), middleware: [] };
    }
    private makeRouter(env: Environment, site: Site, profile: RustWebProfile, mode: Router['mode'], paths: string[] = []): Router {
        const framework = profile.framework as Framework, identity = JSON.stringify([env.runtime, env.frame, env.owner, site.file, framework, mode]), id = this.context.graph.id('router', 'rust', identity, String(this.ordinal(identity)));
        const router: Router = { kind: 'router', framework, dialect: profile.dialect!, mode, id, site, entries: [], paths, routes: [], methods: '*', conditions: unique([...this.conditions(env, env.scope), ...profile.conditions]), proof: [...env.proof, ...this.macros.proof(env.scope), ...profile.proof, this.fact(site, `Qualified original ${framework} ${mode} constructor`)], middleware: [], legacy: false };
        this.builders.push({ router, env });
        this.touch(site, framework);
        return router;
    }
    private touch(site: Site, framework: Framework): void {
        const file = this.context.graph.entities.get(this.context.files.get(site.file)!.id)!, analysis = fileAnalysis(file.metadata.analysis);
        file.metadata.frameworkPacks = unique([...Array.isArray(file.metadata.frameworkPacks) ? file.metadata.frameworkPacks as string[] : [], framework]);
        if (analysis)
            analysis.features.framework = { status: 'partial', reason: 'Original Cargo profiles, reachable Axum/Actix/Rocket constructors, serving contracts, source helpers/closures and native route contracts; dynamic setup and opaque middleware remain gaps' };
    }
    run(): void {
        for (const root of this.symbols.resolver.roots.values()) {
            if (root.compilation.target.kind !== 'bin' || root.compilation.selected === false)
                continue;
            const definitions = this.symbols.definitions(root.file.path).filter(def => def.fact.kind === 'function' && def.fact.scope === root.fact.key), mainFunction = definitions.find(def => def.fact.name === 'main'), launches = definitions.filter(def => this.reviewedAttributes(def, root).some(attribute => attribute.kind === 'launch'));
            for (const main of [...launches, ...mainFunction ? [mainFunction] : []]) {
                if (!main.fact.body)
                    continue;
                const body = this.scope(root.file.path, main.fact.body, root);
                if (!body)
                    continue;
                const runtime = this.context.graph.id('rust-runtime', root.compilation.invocation, root.compilation.target.id, main.id), attributes = this.reviewedAttributes(main, root), runtimeAttribute = attributes.find(attribute => attribute.kind === 'runtime'), launch = attributes.find(attribute => attribute.kind === 'launch');
                const env: Environment = { scope: body, origin: root, runtime, frame: runtime, owner: main.id, locals: new Map(), stack: [main.id], conditions: unique([...body.gaps, ...body.active !== true ? ['Unselected Rust main cfg'] : [], ...main.fact.async && !runtimeAttribute ? ['Async Rust main lacks a reviewed runtime attribute'] : [], ...runtimeAttribute && !main.fact.async ? ['Native runtime attribute requires an original async main'] : [], ...main.fact.generics || main.fact.parameters.length ? ['Generic/parameterized Rust main is outside the native entry contract'] : [], ...attributes.filter(attribute => attribute.kind === 'runtime').length > 1 ? ['Competing Rust runtime attributes'] : []]), proof: [...root.compilation.proof, ...runtimeAttribute?.proof ?? [], this.fact(siteOf({ scope: root } as Environment, main.fact), 'Original selected Rust bin main entry')] };
                if (launch) {
                    env.conditions = unique([...env.conditions.filter(condition => condition !== 'Async Rust main lacks a reviewed runtime attribute'), ...launches.length !== 1 || !!mainFunction || attributes.filter(attribute => attribute.kind === 'runtime' || attribute.kind === 'launch').length > 1 ? ['Competing Rocket launch/main entrypoints would generate conflicting main items'] : []]);
                    env.proof.push(...launch.proof, this.fact(siteOf(env, main.fact), 'Original Rocket launch attribute invokes this source factory and awaits native launch without expanding the macro'));
                }
                const result = this.execute(env);
                if (launch) {
                    if (is(result, 'router') && result.framework === 'rocket')
                        this.expose({ kind: 'server', router: result, environment: env, bound: true, running: true, conditions: env.conditions, proof: env.proof }, env, siteOf(env, main.fact));
                    else
                        this.gap(env, siteOf(env, main.fact), 'Original Rocket launch factory has no reviewed returned Rocket builder');
                }
            }
        }
        for (const serving of this.pending)
            this.emitServer(serving.server, serving.env, serving.site);
        for (const { router, env } of this.builders) {
            const file = this.context.graph.entities.get(this.context.files.get(router.site.file)!.id)!;
            (file.metadata.rustRegistrations as unknown[] | undefined) ??= [];
            (file.metadata.rustRegistrations as unknown[]).push({ framework: router.framework, receiver: router.id, compilation: env.scope.compilation.id, invocation: env.scope.compilation.invocation, exposed: this.exposed.has(router.id), mode: router.mode, conditions: router.conditions });
        }
    }
    private execute(env: Environment): Value {
        const facts = this.symbols.facts(env.scope.file.path);
        if (!facts?.complete) {
            this.gap(env, siteOf(env, env.scope.fact), 'Original Rust registration syntax is incomplete');
            return;
        }
        const scopeKeys = new Set(this.symbols.resolver.membership.get(env.scope.file.path)?.filter(scope => scope.compilation.id === env.scope.compilation.id && this.symbols.owner(scope) === env.owner).map(scope => scope.fact.key));
        const events = [...facts.bindings.filter(binding => binding.kind !== 'parameter' && scopeKeys.has(binding.scope) && binding.value).map(item => ({ kind: 'binding' as const, start: item.start, item })), ...facts.statements.filter(item => scopeKeys.has(item.scope)).map(item => ({ kind: 'statement' as const, start: item.start, item })), ...facts.calls.filter(item => scopeKeys.has(item.scope)).map(item => ({ kind: 'call' as const, start: item.start, item })), ...facts.writes.filter(item => scopeKeys.has(item.scope) && item.kind === 'assignment').map(item => ({ kind: 'write' as const, start: item.start, item })), ...facts.returns.filter(item => item.owner === this.symbols.definition(env.scope.file.path, env.scope.fact.owner ?? '')?.fact.key).map(item => ({ kind: 'return' as const, start: item.start, item }))].sort((a, b) => a.start - b.start || a.kind.localeCompare(b.kind));
        for (const event of events) {
            if (++this.steps > 50000) {
                this.gap(env, siteOf(env, event.item), 'Rust registration summary budget exceeded');
                return;
            }
            const scope = this.scope(env.scope.file.path, event.item.scope, env.scope);
            if (!scope || scope.active === false)
                continue;
            const attributes = 'attributes' in event.item ? this.symbols.resolver.attributes(event.item.attributes, scope.compilation, scope.file.path, scope.fact.key) : undefined;
            if (attributes?.active === false)
                continue;
            const local = { ...env, scope, conditions: unique([...this.conditions(env, scope), ...attributes?.gaps ?? [], ...attributes?.active === 'unknown' ? ['Unselected Rust registration attributes'] : []]) };
            if (event.kind === 'binding')
                env.locals.set(this.bindingKey(scope.file.path, event.item), this.evaluate(event.item.value!, local));
            else if (event.kind === 'write') {
                const target = event.item.target, binding = target.kind === 'path' && target.segments.length === 1 ? this.binding(scope, target.segments[0]!, event.item.start) : undefined;
                if (binding && event.item.value && binding.mutable && !local.conditions.length)
                    env.locals.set(this.bindingKey(scope.file.path, binding), this.evaluate(event.item.value, local));
                else
                    this.gap(local, siteOf(local, event.item), 'Opaque/conditional Rust registration assignment');
            }
            else if (event.kind === 'return') {
                const value = this.evaluate(event.item.value, local);
                if (!event.item.conditional)
                    return value;
                this.gap(local, siteOf(local, event.item), 'Conditional Rust helper return is unreviewed');
            }
            else
                this.evaluate(event.item.expression, local);
        }
        return;
    }
    private invoke(callback: Callback, args: Value[], env: Environment, site: Site): Value {
        const def = callback.definition;
        if (callback.attribute || !def.fact.body || def.fact.generics || def.fact.parameters.length !== args.length || env.stack.includes(def.id) || env.stack.length >= 24) {
            this.gap(env, site, 'Original Rust helper/factory invocation is generic, cyclic, incomplete or has competing arguments');
            return;
        }
        const scope = this.scope(def.unit.file.path, def.fact.body, callback.scope);
        if (!scope || scope.active !== true || scope.gaps.length) {
            this.gap(env, site, 'Original Rust helper/factory scope is inactive or unreviewed');
            return;
        }
        const frameKey = JSON.stringify([env.frame, def.id, site.file]), frame = this.context.graph.id('rust-frame', frameKey, String(this.ordinal(frameKey))), locals = ['closure', 'async'].includes(def.fact.kind) ? new Map(callback.environment.locals) : new Map<string, Value>();
        for (const [i, param] of def.fact.parameters.entries()) {
            const binding = this.symbols.facts(def.unit.file.path)?.bindings.find(binding => binding.kind === 'parameter' && binding.scope === def.fact.body && binding.name === param.name);
            if (!binding || param.mutable) {
                this.gap(env, site, 'Destructured/mutable Rust helper parameters are unreviewed');
                return;
            }
            locals.set(this.bindingKey(def.unit.file.path, binding), args[i]);
        }
        const child: Environment = { ...env, scope, frame, locals, owner: def.id, stack: [...env.stack, def.id], conditions: unique([...env.conditions, ...callback.conditions]), proof: [...env.proof, ...callback.proof, this.fact(site, 'Original source helper/factory invocation')] };
        return def.fact.async ? { kind: 'future', environment: child } : this.execute(child);
    }
    private evaluate(expression: RustExpression, env: Environment): Value {
        if (++this.steps > 50000) {
            if (!this.runtimeGaps.get(env.runtime)?.includes('Rust registration summary budget exceeded'))
                this.gap(env, siteOf(env, expression), 'Rust registration summary budget exceeded');
            return;
        }
        const key = JSON.stringify([env.runtime, env.frame, env.scope.file.path, expression.start, expression.end, expression.kind]);
        if (this.values.has(key))
            return this.values.get(key);
        // Insert a recursion sentinel before evaluating nested original operands.
        this.values.set(key, undefined);
        const value = this.evaluateValue(expression, env);
        this.values.set(key, value);
        return value;
    }
    private evaluateValue(expression: RustExpression, env: Environment): Value {
        const site = siteOf(env, expression);
        if (expression.kind === 'literal')
            return expression.value;
        if (expression.kind === 'macro') {
            const profile = rustWebProfile(env.scope, rustWebMacroResolution(this.symbols.resolver, env.scope, expression.path, expression.start, expression.absolute));
            if (profile?.framework === 'rocket' && profile.dialect === 'rocket-0.5' && profile.path.join('::') === 'routes' && expression.operands !== undefined && !profile.conditions.length)
                return expression.operands.map(operand => this.callback(env, operand));
            return;
        }
        if (['paren', 'try', 'deref', 'reference', 'cast'].includes(expression.kind))
            return this.evaluate((expression as RustExpression & {
                value: RustExpression;
            }).value, env);
        if (expression.kind === 'tuple' || expression.kind === 'array')
            return expression.values.map(value => this.evaluate(value, env));
        if (expression.kind === 'await') {
            const value = this.evaluate(expression.value, env);
            if (is(value, 'future')) {
                if (value.server) {
                    this.expose(value.server, env, site);
                    return;
                }
                return value.environment ? this.execute(value.environment) : value.result;
            }
            return;
        }
        if (expression.kind === 'path') {
            if (expression.segments.length === 1) {
                const binding = this.binding(env.scope, expression.segments[0]!, expression.start);
                if (binding) {
                    const value = env.locals.get(this.bindingKey(env.scope.file.path, binding));
                    return binding.mutable && is(value, 'callback') ? undefined : value;
                }
            }
            const resolution = this.symbols.resolver.path(env.scope, expression.segments, expression.absolute, new Set(), 'expression'), profile = rustWebProfile(env.scope, resolution);
            if (profile) {
                if (expression.generics?.length)
                    profile.conditions.push('Explicit generic Rust web operands require native type/trait instantiation proof');
                if (profile.framework === 'axum' && /^routing::MethodFilter::(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|CONNECT|TRACE)$/.test(profile.path.join('::')))
                    return { kind: 'guard', methods: [profile.path.at(-1)!], conditions: profile.conditions, proof: profile.proof };
                return { kind: 'native', profile };
            }
            return this.callback(env, expression);
        }
        if (expression.kind === 'closure' || expression.kind === 'async')
            return this.callback(env, expression);
        if (expression.kind === 'call') {
            const args = expression.args.map(arg => this.evaluate(arg, env));
            if (expression.callee.kind === 'field') {
                const receiver = this.evaluate(expression.callee.value, env), name = expression.callee.name;
                if (['unwrap', 'expect'].includes(name) && (is(receiver, 'server') || is(receiver, 'listener') || is(receiver, 'future') || is(receiver, 'router') && receiver.framework === 'rocket' && receiver.rocketIgnited))
                    return receiver;
                return this.method(receiver, name, args, env, site, expression);
            }
            const callee = this.evaluate(expression.callee, env);
            if (is(callee, 'native'))
                return this.native(callee.profile, args, env, site, expression);
            if (is(callee, 'callback'))
                return this.invoke(callee, args, env, site);
            if (args.some(arg => is(arg, 'router') || is(arg, 'method') || is(arg, 'server')))
                this.gap(env, site, 'Original Rust builder escapes into an unreviewed call');
        }
        return;
    }
    private native(profile: RustWebProfile, args: Value[], env: Environment, site: Site, expression: RustExpression & {
        kind: 'call';
    }): Value {
        const name = profile.path.join('::'), local = { ...env, conditions: unique([...env.conditions, ...profile.conditions]), proof: [...env.proof, ...profile.proof] };
        if (profile.framework === 'rocket' && name === 'build' && args.length === 0 && profile.dialect)
            return this.makeRouter(local, site, profile, 'router');
        if (profile.framework !== 'tokio' && !profile.dialect) {
            this.gap(env, site, profile.conditions.join('; ') || 'Unreviewed Rust web version family');
            return;
        }
        if (profile.framework === 'tokio' && name === 'net::TcpListener::bind' && args.length === 1) {
            const dep = [...env.scope.compilation.dependencies.values()].find(entry => entry.dependency.package === 'tokio')?.dependency;
            if (dep && [...dep.features, ...env.scope.compilation.dependencyFeatures.get(dep.name) ?? []].some(feature => ['net', 'full'].includes(feature)))
                return { kind: 'future', result: { kind: 'listener', proof: [...profile.proof, this.fact(site, 'Original Tokio listener bind future, success path')] } };
            return;
        }
        if (profile.framework === 'axum') {
            if (name === 'Router::new' && args.length === 0)
                return this.makeRouter(local, site, profile, 'router');
            if (name === 'routing::MethodRouter::new' && args.length === 0)
                return { kind: 'method', framework: 'axum', dialect: profile.dialect!, routes: [], conditions: profile.conditions, proof: profile.proof };
            const verb = /^routing::(get|post|put|patch|delete|head|options|connect|trace|any)$/.exec(name);
            if (verb && args.length === 1)
                return { kind: 'method', framework: 'axum', dialect: profile.dialect!, routes: [this.route(local, site, verb[1] === 'any' ? '*' : [verb[1]!.toUpperCase()], args[0])], conditions: profile.conditions, proof: profile.proof };
            if (name === 'routing::on' && args.length === 2 && is(args[0], 'guard'))
                return { kind: 'method', framework: 'axum', dialect: profile.dialect!, routes: [this.route(local, site, args[0].methods, args[1])], conditions: unique([...profile.conditions, ...args[0].conditions]), proof: [...profile.proof, ...args[0].proof] };
            if (/^routing::MethodFilter::(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|CONNECT|TRACE)$/.test(name))
                return { kind: 'guard', methods: [profile.path.at(-1)!], conditions: profile.conditions, proof: profile.proof };
            if (name === 'serve' && args.length === 2 && is(args[1], 'router')) {
                return { kind: 'future', server: { kind: 'server', router: args[1], environment: local, bound: is(args[0], 'listener'), running: true, proof: [...profile.proof, ...is(args[0], 'listener') ? args[0].proof : [], this.fact(site, 'Original Axum serve future construction; awaited exposure is recorded separately')], conditions: unique([...profile.conditions, ...args[1].conditions, ...!is(args[0], 'listener') ? ['Original Axum listener identity is unreviewed'] : []]) } };
            }
            if (name === 'middleware::from_fn' && args.length === 1 && is(args[0], 'callback'))
                return { kind: 'middleware', targets: [args[0].definition.id], conditions: ['Source middleware may change routing/short-circuit; request selection is unproven'], proof: [...profile.proof, ...args[0].proof] };
        }
        if (profile.framework === 'actix-web') {
            if (name === 'middleware::Logger::default' && args.length === 0)
                return { kind: 'middleware', targets: [], conditions: profile.conditions, proof: [...profile.proof, this.fact(site, 'Original Actix 4 default Logger has a reviewed routing-neutral middleware contract')] };
            if (name === 'App::new' && args.length === 0)
                return this.makeRouter(local, site, profile, 'app');
            if (['web::scope', 'web::resource'].includes(name) && args.length === 1) {
                const paths = typeof args[0] === 'string' ? [args[0]] : Array.isArray(args[0]) && args[0].every(path => typeof path === 'string') ? args[0] as string[] : [];
                const router = this.makeRouter(local, site, profile, name === 'web::scope' ? 'scope' : 'resource', paths);
                if (!paths.length)
                    router.conditions.push('Dynamic original Actix resource/scope paths');
                return router;
            }
            if (name === 'HttpServer::new' && args.length === 1 && is(args[0], 'callback')) {
                const router = this.invoke(args[0], [], local, site);
                return { kind: 'server', router: is(router, 'router') && router.mode === 'app' ? router : undefined, environment: local, bound: false, running: false, proof: [...profile.proof, this.fact(site, 'Original Actix server factory invokes source App closure')], conditions: unique([...profile.conditions, ...is(router, 'router') ? router.conditions : ['Actix source App factory is unresolved']]) };
            }
            const verb = /^web::(get|post|put|patch|delete|head|options|connect|trace|route)$/.exec(name);
            if (verb && args.length === 0)
                return { kind: 'method', framework: 'actix-web', dialect: 'actix-web-4', routes: [{ site, methods: verb[1] === 'route' ? '*' : [verb[1]!.toUpperCase()], conditions: profile.conditions, proof: profile.proof, middleware: [] }], conditions: profile.conditions, proof: profile.proof };
            if (name === 'web::to' && args.length === 1)
                return { kind: 'method', framework: 'actix-web', dialect: 'actix-web-4', routes: [this.route(local, site, '*', args[0])], conditions: profile.conditions, proof: profile.proof };
            const guard = /^guard::(Get|Post|Put|Patch|Delete|Head|Options|Connect|Trace)$/.exec(name);
            if (guard && args.length === 0)
                return { kind: 'guard', methods: [guard[1]!.toUpperCase()], conditions: profile.conditions, proof: profile.proof };
        }
        // Native namespace alone cannot qualify an unreviewed builder/service API.
        if (args.some(arg => is(arg, 'router') || is(arg, 'method') || is(arg, 'server')))
            this.gap(env, site, `Unreviewed native ${profile.framework} ${name} builder escape`);
        return;
    }
    private copy(router: Router, env: Environment, site: Site, clone = false): Router {
        if (router.consumed && !clone)
            this.gap(env, site, 'Original Rust consuming builder is reused after move');
        if (!clone)
            router.consumed = true;
        const next: Router = { ...router, consumed: false, entries: router.entries.map(entry => ({ ...entry, routes: entry.routes.map(cloneRoute), conditions: [...entry.conditions], middleware: [...entry.middleware] })), routes: router.routes.map(cloneRoute), conditions: unique([...router.conditions, ...this.conditions(env, env.scope), ...router.consumed && clone ? ['Cloned Rust builder was already consumed'] : []]), proof: [...router.proof, this.fact(site, clone ? 'Original explicit builder clone' : 'Original consuming builder step')], middleware: [...router.middleware] };
        return next;
    }
    private method(value: Value, name: string, args: Value[], env: Environment, site: Site, expression: RustExpression & {
        kind: 'call';
    }): Value {
        if (is(value, 'future')) {
            if (name === 'with_graceful_shutdown' && args.length === 1)
                return value;
            return;
        }
        if (is(value, 'server')) {
            if (['bind', 'listen'].includes(name) && args.length === 1) {
                value.bound = true;
                value.proof.push(this.fact(site, `Original Actix ${name} success path`));
                return value;
            }
            if (['workers', 'worker_max_blocking_threads', 'backlog', 'keep_alive', 'client_request_timeout', 'client_disconnect_timeout', 'shutdown_timeout', 'disable_signals', 'system_exit'].includes(name)) {
                value.proof.push(this.fact(site, `Recorded Actix server ${name} builder`));
                return value;
            }
            if (name === 'run' && args.length === 0) {
                value.running = true;
                return { kind: 'future', server: value };
            }
            this.gap(env, site, `Unreviewed Rust server ${name} builder`);
            return;
        }
        if (is(value, 'method')) {
            if (value.consumed)
                this.gap(env, site, 'Original Rust method router is reused after move');
            value.consumed = true;
            const result: MethodRouter = { ...value, consumed: false, routes: value.routes.map(cloneRoute), conditions: unique([...value.conditions, ...this.conditions(env, env.scope)]) };
            if (value.framework === 'axum' && METHODS.includes(name.toUpperCase()) && args.length === 1) {
                result.routes.push(this.route(env, site, [name.toUpperCase()], args[0]));
                return result;
            }
            if (name === 'to' && value.framework === 'actix-web' && args.length === 1) {
                result.routes = result.routes.map(route => ({ ...this.route(env, site, route.methods, args[0]), conditions: unique([...route.conditions, ...this.route(env, site, route.methods, args[0]).conditions]), proof: [...route.proof, ...this.route(env, site, route.methods, args[0]).proof] }));
                return result;
            }
            if (name === 'method' && value.framework === 'actix-web' && args.length === 1) {
                const arg = expression.args[0];
                const resolution = arg?.kind === 'path' ? this.symbols.resolver.path(env.scope, arg.segments, arg.absolute, new Set(), 'expression') : undefined;
                if (resolution?.status === 'external' && resolution.dependency === 'actix-web' && /^http::Method::(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|CONNECT|TRACE)$/.test(resolution.path.join('::')))
                    result.routes = result.routes.map(route => ({ ...route, methods: intersect(route.methods, [resolution.path.at(-1)!]) }));
                else
                    result.conditions.push('Unreviewed Actix method operand');
                return result;
            }
            if (name === 'guard' && args.length === 1) {
                const guard = args[0];
                if (is(guard, 'guard'))
                    result.routes = result.routes.map(route => ({ ...route, methods: intersect(route.methods, guard.methods), conditions: unique([...route.conditions, ...guard.conditions]), proof: [...route.proof, ...guard.proof] }));
                else
                    result.conditions.push('Unreviewed Actix route guard');
                return result;
            }
            if (name === 'fallback' && value.framework === 'axum' && args.length === 1) {
                result.routes = result.routes.filter(route => !route.fallback);
                result.routes.push({ ...this.route(env, site, '*', args[0]), fallback: true });
                return result;
            }
            if (name === 'merge' && value.framework === 'axum' && args.length === 1 && is(args[0], 'method') && args[0].framework === 'axum') {
                result.routes.push(...args[0].routes.map(cloneRoute));
                result.conditions.push(...args[0].conditions);
                args[0].consumed = true;
                return result;
            }
            if (['layer', 'route_layer'].includes(name) && args.length === 1) {
                this.applyLayer(result.routes, args[0], site, result.conditions);
                return result;
            }
            if (name === 'with_state' && value.framework === 'axum' && args.length === 1)
                return result;
            result.conditions.push(`Unreviewed Rust method builder ${name}`);
            return result;
        }
        if (!is(value, 'router'))
            return;
        if (value.mode === 'config')
            return this.configureMethod(value, name, args, env, site);
        if (name === 'clone' && args.length === 0 && value.framework === 'axum')
            return this.copy(value, env, site, true);
        const result = this.copy(value, env, site);
        if (value.framework === 'rocket') {
            if (name === 'mount' && args.length === 2) {
                const original = typeof args[0] === 'string' ? args[0] : '/', prefix = original.split('?')[0]!, base = compileRocketPath(prefix), validBase = typeof args[0] === 'string' && reviewedRocketMount(original) && base.status === 'exact' && base.rocket!.segments.every(segment => 'literal' in segment), list = Array.isArray(args[1]) ? args[1] : undefined;
                if (!list) {
                    result.conditions.push('Original Rocket mount has no reviewed routes! source list');
                    return result;
                }
                const mount = { id: this.context.graph.id('mount', result.id, prefix, String(result.entries.length)), file: site.file, line: site.range.startLine, prefix };
                for (const item of list) {
                    if (!is(item, 'callback') || item.attribute?.framework !== 'rocket' || item.attribute.kind !== 'route') {
                        result.conditions.push('Original Rocket routes! member is not a reviewed original route function');
                        continue;
                    }
                    const attribute = item.attribute, path = '/' + (prefix + '/' + attribute.path!.split('?')[0]).split('/').filter(Boolean).join('/') + (attribute.path!.includes('?') ? '?' + attribute.path!.split('?')[1] : ''), registration: Route = { site: siteOf({ ...env, scope: item.scope }, item.definition.fact), methods: attribute.methods!, callback: item, conditions: unique([...item.conditions, ...attribute.format ? ['Rocket format guard requires native Accept/Content-Type proof'] : [], ...attribute.data ? ['Rocket body/data guard requires native FromData proof'] : [], ...!validBase ? ['Unreviewed Rocket mount origin/prefix'] : []]), proof: [...item.proof, ...attribute.proof, this.fact(site, 'Original Rocket mount and routes! member')], middleware: [] };
                    result.entries.push({ site, path, routes: [registration], methods: '*', conditions: [], proof: result.proof, mounts: [mount], middleware: [] });
                }
                return result;
            }
            if (name === 'manage' && args.length === 1)
                return result;
            if (name === 'ignite' && args.length === 0)
                return { kind: 'future', result: { ...result, rocketIgnited: true } };
            if (name === 'launch' && args.length === 0)
                return { kind: 'future', server: { kind: 'server', router: result, environment: env, bound: true, running: true, conditions: result.conditions, proof: [...result.proof, this.fact(site, 'Original Rocket launch future, native configured bind contract')] } };
            result.conditions.push(`Unreviewed Rocket builder ${name} may affect launch/dispatch`);
            return result;
        }
        if (['into_make_service', 'into_make_service_with_connect_info'].includes(name) && value.framework === 'axum' && args.length === 0)
            return result;
        if (name === 'without_v07_checks' && value.dialect === 'axum-0.8' && args.length === 0) {
            result.legacy = true;
            return result;
        }
        if (name === 'route' && value.framework === 'axum' && args.length === 2) {
            const path = typeof args[0] === 'string' ? args[0] : '/', method = is(args[1], 'method') && args[1].framework === 'axum' ? args[1] : undefined;
            result.entries.push({ site, path, routes: method?.routes.map(cloneRoute) ?? [this.route(env, site, '*', undefined)], methods: '*', conditions: unique([...method?.conditions ?? [], ...typeof args[0] !== 'string' ? ['Dynamic original Axum route path'] : []]), proof: [...method?.proof ?? []], mounts: [], middleware: [] });
            if (method)
                method.consumed = true;
            return result;
        }
        if (name === 'nest' && value.framework === 'axum' && args.length === 2 && is(args[1], 'router') && args[1].framework === 'axum') {
            const prefix = typeof args[0] === 'string' ? args[0] : '/', child = args[1];
            const mount = { id: this.context.graph.id('mount', result.id, child.id, prefix, String(result.entries.length)), file: site.file, line: site.range.startLine, prefix };
            for (const entry of child.entries)
                result.entries.push({ ...entry, path: join(prefix, entry.path, value.dialect), mounts: [mount, ...entry.mounts], conditions: unique([...entry.conditions, ...child.conditions, ...typeof args[0] !== 'string' || prefix === '/' || /\*/.test(prefix) ? ['Unreviewed Axum nest prefix'] : []]), middleware: [...entry.middleware] });
            if (child.fallback)
                result.entries.push({ site, path: prefix, routes: [cloneRoute(child.fallback)], methods: '*', conditions: unique([...child.conditions, ...child.fallback.conditions]), proof: child.proof, mounts: [mount], middleware: [], pathFallback: true });
            child.consumed = true;
            return result;
        }
        if (name === 'merge' && value.framework === 'axum' && args.length === 1 && is(args[0], 'router') && args[0].framework === 'axum') {
            const other = args[0];
            result.entries.push(...other.entries.map(entry => ({ ...entry, routes: entry.routes.map(cloneRoute) })));
            result.conditions.push(...other.conditions);
            if (result.fallback && other.fallback)
                result.conditions.push('Axum merge has two explicit fallbacks and would panic');
            else
                result.fallback ??= other.fallback;
            other.consumed = true;
            return result;
        }
        if (name === 'fallback' && value.framework === 'axum' && args.length === 1) {
            result.fallback = this.route(env, site, '*', args[0]);
            return result;
        }
        if (name === 'reset_fallback' && value.framework === 'axum' && args.length === 0) {
            result.fallback = undefined;
            return result;
        }
        if (name === 'method_not_allowed_fallback' && value.framework === 'axum' && args.length === 1) {
            for (const entry of result.entries)
                if (!entry.routes.some(route => route.fallback))
                    entry.routes.push({ ...this.route(env, site, '*', args[0]), fallback: true });
            return result;
        }
        if (['layer', 'route_layer', 'wrap', 'wrap_fn'].includes(name) && args.length === 1) {
            if (name === 'route_layer' && !result.entries.length)
                result.conditions.push('Empty Axum route_layer would panic');
            for (const entry of result.entries)
                this.applyLayer(entry.routes, args[0], site, entry.conditions);
            if (result.routes.length)
                this.applyLayer(result.routes, args[0], site, result.conditions);
            if (name === 'layer' && result.fallback)
                this.applyLayer([result.fallback], args[0], site, result.conditions);
            if (value.framework === 'actix-web') {
                const targets = is(args[0], 'middleware') ? args[0].targets : is(args[0], 'callback') ? [args[0].definition.id] : [];
                result.middleware.push(...targets);
                result.conditions.push(...is(args[0], 'middleware') ? args[0].conditions : ['Opaque Actix middleware can alter routing or short-circuit']);
                if (is(args[0], 'middleware'))
                    result.proof.push(...args[0].proof);
            }
            return result;
        }
        if (name === 'with_state' && value.framework === 'axum' && args.length === 1)
            return result;
        if (['app_data', 'data'].includes(name) && value.framework === 'actix-web' && args.length === 1)
            return result;
        if (value.framework === 'actix-web') {
            if (name === 'route' && args.length === 1 && value.mode === 'resource' && is(args[0], 'method')) {
                const method = args[0];
                result.routes.push(...method.routes.map(route => ({ ...cloneRoute(route), conditions: unique([...route.conditions, ...method.conditions]) })));
                method.consumed = true;
                return result;
            }
            if (name === 'to' && args.length === 1 && value.mode === 'resource') {
                result.routes.push(this.route(env, site, '*', args[0]));
                return result;
            }
            if (name === 'guard' && args.length === 1) {
                if (is(args[0], 'guard')) {
                    result.methods = intersect(result.methods, args[0].methods);
                    result.conditions.push(...args[0].conditions);
                }
                else
                    result.conditions.push('Opaque Actix resource/scope guard');
                return result;
            }
            if (name === 'default_service' && args.length === 1) {
                if (is(args[0], 'method') && args[0].routes.length === 1)
                    result.fallback = { ...cloneRoute(args[0].routes[0]!), conditions: unique([...args[0].routes[0]!.conditions, ...args[0].conditions]) };
                else
                    result.conditions.push('Opaque Actix default service');
                return result;
            }
            if (name === 'configure' && args.length === 1 && is(args[0], 'callback')) {
                const config: Router = { ...result, mode: 'config', consumed: false, entries: [], routes: [], conditions: [] };
                this.invoke(args[0], [config], env, site);
                result.entries.push(...config.entries);
                result.conditions.push(...config.conditions);
                return result;
            }
            if (name === 'service' && args.length === 1) {
                this.addService(result, args[0], env, site);
                return result;
            }
            if (name === 'route' && args.length === 2 && is(args[1], 'method')) {
                this.addActixRoute(result, args[0], args[1], env, site);
                return result;
            }
            if (name === 'name' && value.mode === 'resource' && args.length === 1 && typeof args[0] === 'string')
                return result;
        }
        result.conditions.push(`Unreviewed ${value.framework} ${value.mode} builder ${name}`);
        return result;
    }
    private configureMethod(config: Router, name: string, args: Value[], env: Environment, site: Site): Value {
        if (name === 'service' && args.length === 1)
            this.addService(config, args[0], env, site);
        else if (name === 'route' && args.length === 2 && is(args[1], 'method'))
            this.addActixRoute(config, args[0], args[1], env, site);
        else if (name === 'configure' && args.length === 1 && is(args[0], 'callback'))
            this.invoke(args[0], [config], env, site);
        else if (['app_data', 'data'].includes(name) && args.length === 1)
            return config;
        else
            config.conditions.push(`Unreviewed Actix ServiceConfig ${name}`);
        return config;
    }
    private addActixRoute(router: Router, path: Value, method: MethodRouter, env: Environment, site: Site): void {
        const routes = method.routes.map(cloneRoute), methods = routes.reduce<Methods>((result, route) => union(result, route.methods), []);
        router.entries.push({ site, path: typeof path === 'string' ? path : '/', routes: routes.map(route => ({ ...route, methods: '*' })), methods, conditions: unique([...method.conditions, ...typeof path !== 'string' ? ['Dynamic original Actix App.route path'] : []]), proof: method.proof, mounts: [], middleware: [] });
        method.consumed = true;
    }
    private addService(router: Router, value: Value, env: Environment, site: Site): void {
        if (Array.isArray(value)) {
            for (const child of value)
                this.addService(router, child, env, site);
            return;
        }
        if (is(value, 'callback') && value.attribute?.kind === 'route') {
            const native = { ...value, attribute: undefined }, route = this.route(env, site, value.attribute.methods!, native), resource: Router = { kind: 'router' as const, framework: 'actix-web' as const, dialect: 'actix-web-4' as const, mode: 'resource' as const, id: this.context.graph.id('router', 'rust-attribute', env.runtime, value.definition.id, String(router.entries.length)), site: siteOf({ ...env, scope: value.scope }, value.definition.fact), entries: [], paths: [value.attribute.path!], routes: [{ ...route, methods: '*', proof: [...route.proof, ...value.attribute.proof] }], methods: value.attribute.methods!, conditions: value.conditions, proof: [...value.proof, ...value.attribute.proof], middleware: [], legacy: false };
            router.entries.push({ site, path: value.attribute.path!, routes: [], child: resource, methods: '*', conditions: [], proof: resource.proof, mounts: [], middleware: [] });
            return;
        }
        if (is(value, 'router') && value.framework === 'actix-web' && ['scope', 'resource'].includes(value.mode)) {
            for (const path of value.paths.length ? value.paths : ['/'])
                router.entries.push({ site, path, routes: [], child: value, methods: '*', conditions: [], proof: value.proof, mounts: [], middleware: [] });
            value.consumed = true;
            return;
        }
        router.conditions.push('Original Actix HttpServiceFactory is unresolved or opaque');
    }
    private applyLayer(routes: Route[], value: Value, site: Site, conditions: string[]): void {
        const targets = is(value, 'middleware') ? value.targets : is(value, 'callback') ? [value.definition.id] : [], gaps = is(value, 'middleware') ? value.conditions : ['Opaque layer/middleware can affect native route selection'];
        if (!routes.length)
            conditions.push(...gaps);
        for (const route of routes) {
            route.middleware.push(...targets);
            route.conditions.push(...gaps);
            route.proof.push(this.fact(site, 'Original layer order applies to routes present at this builder step'), ...is(value, 'middleware') ? value.proof : []);
        }
    }
    private expose(server: Server, env: Environment, site: Site): void {
        this.pending.push({ server, env, site });
    }
    private emitServer(server: Server, env: Environment, site: Site): void {
        const router = server.router;
        if (!router || !server.running)
            return;
        this.exposed.add(router.id);
        const root = this.context.graph.id('rust-dispatch', env.runtime, router.id, site.file, String(this.ordinal(env.runtime + router.id))), conditions = unique([...server.conditions, ...router.conditions, ...this.conditions(env, env.scope), ...this.runtimeGaps.get(env.runtime) ?? [], ...!server.bound ? ['Original native server has no reviewed bind/listener'] : []]);
        const proof = [...server.environment.proof, ...server.proof, this.fact(site, 'Original native Rust serving future is awaited on the selected source entry path')];
        if (router.framework === 'rocket')
            this.emitRocket(router, env, root, conditions, proof);
        else if (router.framework === 'axum')
            this.emitAxum(router, env, root, conditions, proof);
        else
            this.emitActix(router, env, root, conditions, proof, '', [], [], [], '*', new Set());
    }
    private emitRocket(router: Router, env: Environment, root: string, conditions: string[], proof: Evidence[]): void {
        const records = router.entries.flatMap(entry => entry.routes.map(route => {
            const callback = route.callback!, attribute = callback.attribute!, guards: Record<string, string> = {}, original = compileRocketPath(attribute.path!), names = original.rocket?.segments.filter(segment => 'name' in segment).map(segment => (segment as {
                name: string;
            }).name) ?? [], query = original.rocket?.queryParameters.map(parameter => parameter.name) ?? [], parameters = callback.definition.fact.parameters;
            const gaps: string[] = [];
            for (const parameter of parameters) {
                if (!parameter.name || !names.includes(parameter.name) || query.includes(parameter.name)) {
                    gaps.push('Rocket request/query/body guard requires native source/type proof');
                    continue;
                }
                const type = parameter.type, inner = type?.kind === 'reference' ? type.inner : type, text = inner?.text.replace(/\s+/g, '');
                const resolution = inner?.kind === 'path' ? this.symbols.resolver.path(callback.scope, inner.segments ?? [], !!inner.absolute, new Set(), 'expression') : undefined;
                const builtin = resolution?.status === 'unresolved', ancestry: RustScope[] = [];
                for (let current: RustScope | undefined = callback.scope; current; current = current.parent)
                    ancestry.push(current);
                if (builtin && text && (text === 'str' && type?.kind === 'reference' && !type.mutable || type?.kind === 'path' && /^(?:[iu](?:8|16|32|64|128)|bool)$/.test(text)))
                    guards[parameter.name] = text;
                else if (type?.kind === 'path' && text === 'String' && builtin && !ancestry.some(scope => scope.attributes.noPrelude || scope.attributes.noStd || scope.attributes.noCore) || type?.kind === 'path' && resolution?.status === 'external' && resolution.dependency === 'rust-standard-library' && resolution.path.join('::') === 'string::String')
                    guards[parameter.name] = 'str';
                else
                    gaps.push('Rocket parameter FromParam/FromSegments implementation is unreviewed');
                if (original.rocket?.segments.some(segment => 'name' in segment && segment.name === parameter.name && segment.rest))
                    gaps.push('Rocket trailing parameter FromSegments implementation is unreviewed');
            }
            for (const name of names.filter(name => name !== '_'))
                if (!parameters.some(parameter => parameter.name === name))
                    gaps.push('Original Rocket route capture has no named source parameter');
            if (query.some(name => name !== '_') || attribute.data)
                gaps.push('Rocket query/body conversion remains a native guard condition');
            if (callback.definition.fact.generics)
                gaps.push('Generic Rocket route signature is unreviewed');
            const pattern = compileRocketPath(entry.path, guards), rank = attribute.rank ?? original.rocket?.defaultRank ?? 0;
            return { entry, route: { ...route, conditions: unique([...route.conditions, ...gaps]) }, pattern, rank, attribute };
        }));
        if (records.length > 512)
            conditions.push('Rocket collision/registration analysis exceeds 512 routes');
        else
            for (let i = 0; i < records.length; i++)
                for (let j = i + 1; j < records.length; j++) {
                    const a = records[i]!, b = records[j]!;
                    if (a.rank === b.rank && a.attribute.methods!.some(method => b.attribute.methods!.includes(method)) && rocketPathsCollide(a.pattern, b.pattern))
                        conditions.push('Rocket same-rank overlapping routes would fail ignition');
                }
        for (const [order, { entry, route, pattern, rank, attribute }] of records.entries()) {
            const methods = route.methods === '*' ? '*' : route.methods.includes('GET') ? unique([...route.methods, 'HEAD']) : route.methods;
            this.emit(router, env, root, pattern, { ...route, methods }, entry, unique(conditions), proof, { resource: this.context.graph.id('rocket-resource', root, String(order)), resourceOrder: order, routeOrder: order, rank, ...attribute.format ? { format: attribute.format } : {}, ...attribute.data ? { data: attribute.data } : {}, ...attribute.methods!.includes('GET') ? { headFallback: true } : {} });
        }
    }
    private wildcard(path: string, dialect: RustRouteDialect): RoutePattern {
        const base = compileRustPath(path || '/', dialect, true), prefix = path === '/' ? '' : path;
        return { ...base, rust: { sources: base.rust?.sources.map(source => source.slice(0, -1) + (prefix.endsWith('/') || !prefix ? '[\\s\\S]*$' : '(?:/[\\s\\S]*)?$')) ?? [], prefixDefault: true }, alternatives: base.alternatives.map(segments => [...segments, { kind: 'rest' as const, name: '__fallback', minimum: 0 as const }]) };
    }
    private emitAxum(router: Router, env: Environment, root: string, conditions: string[], proof: Evidence[]): void {
        const paths = new Map<string, Entry[]>();
        for (const entry of router.entries.filter(entry => !entry.pathFallback))
            paths.set(entry.path, [...paths.get(entry.path) ?? [], entry]);
        const shape = new Map<string, string>();
        for (const [path, entries] of paths) {
            const pattern = compileRustPath(path, router.dialect, router.legacy), key = JSON.stringify(pattern.alternatives.map(segments => segments.map(segment => segment.kind === 'rest' ? ['rest'] : segment.parts.map(part => part.kind === 'literal' ? part : ['capture']))));
            const competing = shape.get(key);
            if (competing && competing !== path)
                conditions.push('Axum paths collide after capture-name normalization');
            else
                shape.set(key, path);
            const routes = entries.flatMap(entry => entry.routes.map(route => ({ ...cloneRoute(route), conditions: unique([...route.conditions, ...entry.conditions]), proof: [...entry.proof, ...route.proof], middleware: unique([...entry.middleware, ...route.middleware]) }))), explicit = routes.filter(route => !route.fallback && route.methods !== '*'), claimed = new Set<string>();
            for (const route of explicit)
                for (const method of route.methods) {
                    if (claimed.has(method))
                        conditions.push(`Duplicate Axum ${method} path registration would panic`);
                    claimed.add(method);
                }
            if (routes.filter(route => route.fallback || route.methods === '*').length > 1)
                conditions.push('Competing Axum method-router fallbacks would panic');
            const resource = this.context.graph.id('rust-resource', root, path), resourceOrder = [...paths.keys()].indexOf(path), hasHead = claimed.has('HEAD');
            let covered: Methods = [];
            for (const [order, route] of routes.entries()) {
                const fallback = route.fallback || route.methods === '*';
                let methods: Methods = route.methods;
                if (!fallback && Array.isArray(methods) && methods.includes('GET') && !hasHead)
                    methods = unique([...methods, 'HEAD']);
                if (!fallback)
                    covered = union(covered, methods);
                this.emit(router, env, root, pattern, { ...route, methods }, entries[0]!, conditions, proof, { resource, resourceOrder, routeOrder: order, ...fallback ? { fallback: 'method' as const } : {}, ...!hasHead && route.methods !== '*' && route.methods.includes('GET') ? { headFallback: true } : {} }, fallback ? Array.from(claimed).concat(!hasHead && claimed.has('GET') ? ['HEAD'] : []) : undefined);
            }
            if (!routes.some(route => route.fallback || route.methods === '*'))
                this.emit(router, env, root, pattern, { site: entries[0]!.site, methods: '*', conditions: [], proof: [], middleware: [] }, entries[0]!, conditions, proof, { resource, resourceOrder, routeOrder: routes.length, fallback: 'method' }, covered === '*' ? METHODS : covered, 405);
        }
        for (const [order, entry] of router.entries.entries())
            if (entry.pathFallback) {
                const base = compileRustPath(entry.path, router.dialect, router.legacy), pattern = { ...base, rust: { sources: base.rust?.sources.map(source => source.slice(0, -1) + (entry.path.endsWith('/') ? '[\\s\\S]*$' : '(?:/[\\s\\S]+)?$')) ?? [], prefixDefault: true }, alternatives: base.alternatives.map(segments => [...segments, { kind: 'rest' as const, name: '__fallback', minimum: 0 as const }]) };
                this.emit(router, env, root, pattern, entry.routes[0]!, entry, conditions, proof, { resource: root + '-nested-fallback-' + order, resourceOrder: order, routeOrder: 0, fallback: 'path' });
            }
        const fallback = router.fallback ?? { site: router.site, methods: '*' as const, conditions: [], proof: [], middleware: [] };
        this.emit(router, env, root, this.wildcard('/', router.dialect), fallback, { site: fallback.site, path: '/', routes: [], methods: '*', conditions: [], proof: [], mounts: [], middleware: [] }, conditions, proof, { resource: root + '-fallback', resourceOrder: Number.MAX_SAFE_INTEGER, routeOrder: 0, fallback: 'path' }, undefined, router.fallback ? undefined : 404);
    }
    private emitActix(router: Router, env: Environment, root: string, conditions: string[], proof: Evidence[], prefix: string, lineage: NonNullable<RustEndpointData['lineage']>, mounts: RoutingContract['mounts'], middleware: string[], resourceMethods: Methods, seen: Set<Router>, inheritedDefault?: Route): void {
        if (seen.has(router) || seen.size > 32) {
            this.gap(env, router.site, 'Actix scope/resource composition is cyclic or exceeds the depth budget');
            return;
        }
        const next = new Set(seen).add(router), currentConditions = unique([...conditions, ...router.conditions]), currentProof = [...proof, ...router.proof], currentMiddleware = unique([...middleware, ...router.middleware]), guard = intersect(resourceMethods, router.methods);
        for (const [order, entry] of router.entries.entries()) {
            const relative = entry.path === '' && prefix ? '' : entry.path.startsWith('/') ? entry.path : '/' + entry.path;
            const path = join(prefix, relative, router.dialect), resource = this.context.graph.id('rust-resource', root, router.id, path, String(order)), childLineage = [...lineage, { id: resource, order }], guards = intersect(guard, entry.methods);
            if (entry.child) {
                const mount = { id: this.context.graph.id('mount', root, resource), file: entry.site.file, line: entry.site.range.startLine, prefix: entry.path };
                if (entry.child.mode === 'resource')
                    this.emitResource(entry.child, env, root, path, childLineage, guards, [...mounts, mount], unique([...currentConditions, ...entry.conditions]), [...currentProof, ...entry.proof], currentMiddleware);
                else
                    this.emitActix(entry.child, env, root, unique([...currentConditions, ...entry.conditions]), [...currentProof, ...entry.proof], path, childLineage, [...mounts, mount], currentMiddleware, guards, next, router.fallback ?? inheritedDefault);
            }
            else {
                const resourceRouter: Router = { ...router, mode: 'resource', paths: [path], routes: entry.routes, methods: guards, conditions: entry.conditions, middleware: entry.middleware, fallback: undefined };
                this.emitResource(resourceRouter, env, root, path, childLineage, guards, mounts, currentConditions, [...currentProof, ...entry.proof], currentMiddleware);
            }
        }
        const fallback = router.fallback ?? inheritedDefault ?? { site: router.site, methods: '*' as const, conditions: [], proof: [], middleware: [] }, resource = root + '-default-' + router.id + prefix, routeLineage = [...lineage, { id: resource, order: Number.MAX_SAFE_INTEGER }];
        this.emit(router, env, root, this.wildcard(prefix || '/', 'actix-web-4'), fallback, { site: fallback.site, path: prefix || '/', routes: [], methods: guard, conditions: [], proof: [], mounts, middleware: currentMiddleware }, currentConditions, currentProof, { resource, resourceOrder: Number.MAX_SAFE_INTEGER, routeOrder: 0, lineage: routeLineage, resourceMethods: guard, fallback: 'path' }, undefined, router.fallback || inheritedDefault ? undefined : 404);
    }
    private emitResource(router: Router, env: Environment, root: string, path: string, lineage: NonNullable<RustEndpointData['lineage']>, resourceMethods: Methods, mounts: RoutingContract['mounts'], conditions: string[], proof: Evidence[], middleware: string[]): void {
        const resource = lineage.at(-1)!.id, guard = intersect(resourceMethods, router.methods), pattern = compileRustPath(path, 'actix-web-4'), entry: Entry = { site: router.site, path, routes: [], methods: guard, conditions: router.conditions, proof: router.proof, mounts, middleware: unique([...middleware, ...router.middleware]) };
        let covered: Methods = [];
        for (const [order, route] of router.routes.entries()) {
            covered = union(covered, route.methods);
            this.emit(router, env, root, pattern, { ...route, methods: intersect(guard, route.methods) }, entry, conditions, proof, { resource, resourceOrder: lineage.at(-1)!.order, routeOrder: order, lineage, resourceMethods: guard });
        }
        const fallback = router.fallback ?? { site: router.site, methods: guard, conditions: [], proof: [], middleware: [] };
        this.emit(router, env, root, pattern, { ...fallback, methods: guard }, entry, conditions, proof, { resource, resourceOrder: lineage.at(-1)!.order, routeOrder: router.routes.length, lineage, resourceMethods: guard, fallback: 'resource' }, covered === '*' ? METHODS : covered, router.fallback ? undefined : 405);
    }
    private emit(router: Router, env: Environment, root: string, pattern: RoutePattern, route: Route, entry: Entry, conditions: string[], proof: Evidence[], rust: RustEndpointData, excludedMethods?: string[], status?: number): void {
        if (Array.isArray(route.methods) && !route.methods.length)
            return;
        const application = env.origin.file.application?.name, parentId = application && this.context.applicationIds.get(application);
        if (!parentId)
            return;
        const constraints = unique([...conditions, ...entry.conditions, ...route.conditions, ...this.runtimeGaps.get(env.runtime) ?? [], ...pattern.status === 'partial' ? [pattern.reason ?? 'Unreviewed Rust native route syntax'] : []]), method = route.methods === '*' ? 'ALL' : route.methods.join('|'), id = this.context.graph.id('endpoint', 'rust', root, rust.resource, String(rust.routeOrder), method, pattern.original), facts = [...proof, ...entry.proof, ...route.proof, this.fact(route.site, `Original ${router.framework} ${method} ${pattern.original} under selected Cargo source context`)];
        const contract: RoutingContract = { version: 1, pattern, methods: route.methods, ...excludedMethods?.length ? { excludedMethods: unique(excludedMethods) } : {}, executionContext: 'server', registration: { file: route.site.file, line: route.site.range.startLine, receiver: router.id }, mounts: entry.mounts, middleware: unique([...entry.middleware, ...route.middleware]), conditions: constraints, dispatch: { dialect: router.framework, root, order: rust.routeOrder }, rust };
        this.context.graph.contain({ id, type: 'api_endpoint', name: `${method} ${pattern.original}`, path: route.site.file, language: 'rust', parentId, sourceRange: route.site.range, metadata: { framework: router.framework, registration: status ? 'implicit' : 'explicit', method, routePath: pattern.original, routing: contract, executionContext: 'server', compilation: env.origin.compilation.id, crate: env.origin.compilation.target.id, invocation: env.origin.compilation.invocation, qualification: 'bounded-native-source-contract', ...status ? { status, role: status === 405 ? 'method-not-allowed' : 'not-found' } : {}, ...constraints.length ? { constraintsUnresolved: true, constraints } : {} }, evidence: facts });
        this.context.graph.relate(this.context.files.get(route.site.file)!.id, id, 'routes_to', facts, { framework: router.framework, role: 'registration', compilation: env.scope.compilation.id });
        if (route.callback) {
            this.context.graph.relate(id, route.callback.definition.id, 'handles', [...facts, ...route.callback.proof], { framework: router.framework, role: 'handler', compilation: env.scope.compilation.id });
            this.sourceHandlerCalls(route.callback, facts);
        }
        for (const target of contract.middleware)
            this.context.graph.relate(id, target, 'references', facts, { framework: router.framework, role: 'middleware' });
    }
    private sourceHandlerCalls(callback: Callback, proof: Evidence[]): void {
        const definition = callback.definition, key = JSON.stringify([callback.scope.compilation.id, definition.id]);
        if (this.handlerCalls.has(key))
            return;
        this.handlerCalls.add(key);
        if (!definition.unit.facts.complete)
            return;
        for (const call of definition.unit.facts.calls) {
            const scope = this.scope(definition.unit.file.path, call.scope, callback.scope);
            if (!scope || this.symbols.owner(scope) !== definition.id)
                continue;
            const selected = this.symbols.callee(scope, call.expression);
            if (selected.kind !== 'callable' || selected.conditions.length || selected.definitions.length !== 1)
                continue;
            const target = selected.definitions[0]!;
            if (this.reviewedAttributes(target.definition, target.scope).some(attribute => attribute.kind === 'route'))
                continue;
            this.context.graph.relate(definition.id, target.definition.id, 'calls', [...proof, ...selected.proof, this.fact(siteOf({ ...callback.environment, scope }, call), 'Original handler source call under a reviewed native framework attribute context')], { adapter: 'rust-routers', version: RUST_ROUTER_VERSION, dispatch: 'direct', compilation: scope.compilation.id, crate: scope.compilation.target.id, invocation: scope.compilation.invocation, start: call.start, range: call.range, owner: definition.id, target: target.definition.id, execution: target.definition.fact.async ? call.awaited ? 'awaited' : 'future-construction' : 'direct' }, JSON.stringify([scope.compilation.id, scope.id, call.start, 'framework-handler']));
        }
    }
}
export const rustRoutersAnalyzer: Analyzer = { name: 'rust-routers', version: RUST_ROUTER_VERSION, async analyze(context) {
        if (!context.rust || !context.rustSymbols)
            return;
        const base = context.rust, macros = new RustWebMacros(base), resolver = new RustResolver(context, rustWebAttributeReader(base), macros.read), symbols = new RustSymbols(context, resolver);
        const run = async () => { new RustRegistrations(context, base, symbols, macros).run(); };
        const key = { version: RUST_ROUTER_VERSION, structure: STRUCTURE_VERSION, config: context.config, compilations: resolver.projects.describeCompilations(), projects: resolver.projects.describe(), files: [...context.files.values()].filter(file => file.language === 'rust' || file.language === 'toml').map(file => [fileKey(context, file.path), context.syntax?.get(file.path)?.facts.rust?.semantic?.complete ?? false]), inventory: [...context.fileInventory ?? []].sort(), directories: [...context.directoryInventory ?? []].sort() };
        if (context.cache)
            await context.cache.unit(context, 'rust-routers', 'repository', key, run);
        else
            await run();
    } };
