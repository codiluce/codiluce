import path from 'node:path';
import type { AnalysisContext } from '../../core/analyzer.js';
import { evidence, type Evidence, type SourceRange } from '../../core/graph.js';
import { fileAnalysis, type GoBindingFact, type GoDefinitionFact, type GoExpression, type GoSemanticFacts } from '../facts.js';
import { GoSymbols, type GoBoundValue } from '../languages/go-symbols.js';
import { CHI_MODULE, GIN_MODULE, goApi } from '../languages/go-api.js';
import { composeRoutePath, type RoutingContract } from '../routes/contracts.js';
import { compileChiPath, compileGinPath, compileGoMux, goPatternsOverlap, goRouteSubset } from '../routes/go-patterns.js';
import { goMuxProfile } from './go-profile.js';

export const GO_ROUTER_VERSION = '1.0.0';
type Framework = 'net-http' | 'chi' | 'gin';
interface Site { file: string; start: number; range: SourceRange }
interface Environment { origin: string; application?: string; runtime: string; file: string; scope: string; instance: string; frames: Map<string, string>; parameters: Map<string, Value>; stack: string[]; conditions: string[] }
interface Callback { kind: 'callback'; bound: Extract<GoBoundValue, { kind: 'function' }>; environment: Environment }
interface Handler { kind: 'handler'; callback?: Callback; router?: Receiver; strip?: string; conditions: string[]; proof: Evidence[] }
interface Server { kind: 'server'; handler?: Value; conditions: string[] }
interface Entry { site: Site; path: string; methods: string[] | '*'; host?: string; callback?: Callback; child?: Receiver; strip?: string; mode?: 'chi' | 'preserve'; middleware: string[]; conditions: string[]; proof: Evidence[]; order: number; profile: boolean; redirect?: boolean; excluded?: string[]; dynamicPath?: boolean }
interface Receiver { kind: 'receiver'; framework: Framework; id: string; site: Site; runtime: string; application?: string; base: string; root: Receiver; entries: Entry[]; middleware: string[]; conditions: string[]; proof: Evidence[]; frozen: boolean; modern: boolean; exposed: boolean; applications: Set<string>; head: boolean }
type Value = GoBoundValue | Callback | Handler | Server | Receiver | string | number | boolean | null | Value[] | undefined;
const is = <K extends 'receiver' | 'callback' | 'handler' | 'server'>(value: Value, kind: K): value is Extract<Value, { kind: K }> => !!value && typeof value === 'object' && !Array.isArray(value) && value.kind === kind;
const bound = (value: Value): value is GoBoundValue => !!value && typeof value === 'object' && !Array.isArray(value) && ['function', 'type', 'instance', 'namespace', 'external', 'builtin', 'builtin-type', 'unknown'].includes(value.kind);
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'CONNECT', 'TRACE'];
const unique = (values: string[]) => [...new Set(values)];

/** A bounded registration summary interpreter over indexed syntax. It visits
 * invoked helpers/factories and original closures, never runs Go or imports it. */
export class GoRegistrations {
  private readonly receivers: Receiver[] = [];
  private readonly values = new Map<string, Value>();
  private readonly active = new Set<string>();
  private readonly modules = new Set<string>();
  private readonly ordinals = new Map<string, number>();
  private readonly defaults = new Map<string, Receiver>();
  private readonly stopped = new Set<string>();
  private readonly runtimeConditions = new Map<string, string[]>();
  private steps = 0;
  constructor(private readonly context: AnalysisContext, private readonly symbols: GoSymbols) {}
  private fact(site: Site, reason: string): Evidence { return { ...evidence('framework', 'go-routers', site.file, site.range.startLine, reason), analyzerVersion: GO_ROUTER_VERSION, endLine: site.range.endLine }; }
  private issue(site: Site, reason: string, code = 'registration-gap'): void { this.context.graph.diagnose({ analyzer: 'go-routers', severity: 'warning', code: `go-${code}`, file: site.file, line: site.range.startLine, entityId: this.context.files.get(site.file)?.id, reason }); }
  private ordinal(key: string): number { const value = this.ordinals.get(key) ?? 0; this.ordinals.set(key, value + 1); return value; }
  private local(env: Environment, file: string, scope: string): Environment { return { ...env, file, scope }; }
  private scopeOwner(facts: GoSemanticFacts, scope: string): string | undefined { let current = facts.scopes.find(item => item.key === scope); while (current) { if (current.owner) return current.owner; current = facts.scopes.find(item => item.key === current?.parent); } return undefined; }
  private conditions(env: Environment, scope: string): string[] {
    const facts = this.symbols.unitFacts(env.file, env.origin); let current = facts?.scopes.find(item => item.key === scope), result = [...env.conditions];
    while (current) { if (current.conditional) result.push(`Conditional Go ${current.conditional}`); if (current.kind === 'function') break; current = facts?.scopes.find(item => item.key === current?.parent); } return unique(result);
  }
  private bindingKey(env: Environment, file: string, fact: GoBindingFact): string {
    const owner = this.scopeOwner(this.symbols.unitFacts(file, env.origin)!, fact.scope), frame = owner ? env.frames.get(`${file}:${owner}`) ?? env.instance : env.runtime;
    return JSON.stringify([frame, file, fact.scope, fact.name, fact.start]);
  }
  private touch(site: Site, framework: Framework): void {
    const entity = this.context.graph.entities.get(this.context.files.get(site.file)!.id)!, analysis = fileAnalysis(entity.metadata.analysis);
    entity.metadata.frameworkPacks = unique([...Array.isArray(entity.metadata.frameworkPacks) ? entity.metadata.frameworkPacks as string[] : [], framework]);
    if (analysis) analysis.features.framework = { status: 'partial', reason: 'Proven Go core router namespaces, reachable registrations, original callbacks, mounts and bounded invoked helpers/factories; dynamic setup and unreviewed options retain conditions' };
  }
  private receiver(framework: Framework, env: Environment, site: Site, conditions: string[] = [], proof: Evidence[] = []): Receiver {
    const owner = this.scopeOwner(this.symbols.unitFacts(env.file, env.origin)!, env.scope) ?? 'package', identity = JSON.stringify([framework, env.runtime, env.instance, env.file, this.symbols.declarationId(env.file, owner) ?? owner]);
    const mux = goMuxProfile(this.symbols.resolver, env.origin), item = { kind: 'receiver' as const, framework, id: this.context.graph.id('router', identity, String(this.ordinal(identity))), site, runtime: env.runtime, application: env.application, base: '', root: undefined as unknown as Receiver, entries: [], middleware: [], conditions: unique([...conditions, ...this.conditions(env, env.scope), ...(framework === 'net-http' ? mux.conditions : [])]), proof: [...proof, this.fact(site, framework === 'net-http' ? mux.reason : `Qualified ${framework} constructor`)], frozen: false, modern: mux.modern, exposed: false, applications: new Set<string>(), head: false };
    item.root = item; this.receivers.push(item); this.touch(site, framework); return item;
  }
  private defaultMux(env: Environment, site: Site): Receiver { let mux = this.defaults.get(env.runtime); if (!mux) { mux = this.receiver('net-http', env, site); this.defaults.set(env.runtime, mux); } return mux; }
  run(): void {
    const files = [...this.context.files.values()].filter(file => file.language === 'go' && file.analyzable).sort((a, b) => a.path.localeCompare(b.path, 'en'));
    for (const file of files) for (const fact of this.context.syntax?.get(file.path)?.facts.go?.imports ?? []) {
      const outcome = this.symbols.resolver.resolve(file.path, fact.specifier), profile = goApi(outcome, fact.specifier);
      if (profile && !profile.reviewed) { this.touch({ file: file.path, ...fact }, profile.kind); this.issue({ file: file.path, ...fact }, profile.conditions.join('; '), 'router-version-profile'); }
    }
    for (const file of files) {
      if (this.context.syntax?.get(file.path)?.facts.go?.package?.name !== 'main' || file.path.endsWith('_test.go')) continue;
      const facts = this.symbols.unitFacts(file.path), main = facts?.definitions.find(def => def.kind === 'function' && def.name === 'main'); if (!facts || !main?.bodyScope) continue;
      const id = this.symbols.declarationId(file.path, main.key)!, env: Environment = { origin: file.path, application: file.application?.name, runtime: id, file: file.path, scope: main.bodyScope, instance: id, frames: new Map([[`${file.path}:${main.key}`, id]]), parameters: new Map(), stack: [id], conditions: [] };
      this.module(file.path, env); this.execute(env);
    }
    for (const item of this.receivers) if (item.root === item) { item.conditions.push(...this.runtimeConditions.get(item.runtime) ?? []); this.validate(item); }
    for (const item of this.receivers) {
      const file = this.context.graph.entities.get(this.context.files.get(item.site.file)!.id)!;
      (file.metadata.registrations as unknown[] | undefined) ??= [];
      (file.metadata.registrations as unknown[]).push({ framework: item.framework, receiver: item.id, exposed: item.root.exposed, path: item.base, conditions: item.conditions, routes: item.entries.length });
      if (item.root !== item || !item.exposed) continue;
      for (const application of item.applications) this.emit(item, application, [], [], [], new Set());
    }
  }
  private module(file: string, env: Environment): void {
    const outcome = this.symbols.resolver.packageFor(file, env.origin); if (outcome.status !== 'resolved') return;
    const key = `${env.runtime}:${outcome.package.key}`; if (this.modules.has(key)) return; this.modules.add(key);
    for (const unit of outcome.package.files) for (const imported of this.context.syntax?.get(unit.path)?.facts.go?.imports ?? []) {
      const target = this.symbols.resolver.resolve(unit.path, imported.specifier, env.origin); if (target.status === 'resolved') this.module(target.package.files[0]!.path, env);
    }
    for (const unit of outcome.package.files) {
      const facts = this.symbols.unitFacts(unit.path, env.origin), scope = facts?.scopes.find(item => item.kind === 'file')?.key; if (scope) this.execute({ ...env, file: unit.path, scope, instance: env.runtime });
    }
    const initializers = outcome.package.files.flatMap(unit => this.symbols.unitFacts(unit.path, env.origin)?.definitions.filter(def => def.name === 'init' && def.kind === 'function').map(def => ({ file: unit.path, def })) ?? []);
    const conditions = initializers.length > 1 && this.symbols.resolver.config(env.origin).compiler !== 'gc' ? ['Multiple Go init functions require recorded compiler/source ordering'] : [];
    for (const { file: source, def } of initializers) if (def.bodyScope) this.execute({ ...env, file: source, scope: def.bodyScope, conditions: [...env.conditions, ...conditions], frames: new Map(env.frames).set(`${source}:${def.key}`, env.runtime) });
  }
  private execute(env: Environment): Value {
    const facts = this.symbols.unitFacts(env.file, env.origin); if (!facts) return undefined;
    const owner = this.scopeOwner(facts, env.scope), scopes = new Set(facts.scopes.filter(scope => this.scopeOwner(facts, scope.key) === owner).map(scope => scope.key));
    const events = [...facts.bindings.filter(item => scopes.has(item.scope) && item.value).map(item => ({ kind: 'binding' as const, start: item.start, item })), ...facts.calls.filter(item => scopes.has(item.scope)).map(item => ({ kind: 'call' as const, start: item.start, item })), ...facts.writes.filter(item => scopes.has(item.scope)).map(item => ({ kind: 'write' as const, start: item.start, item })), ...facts.returns.filter(item => scopes.has(item.scope)).map(item => ({ kind: 'return' as const, start: item.start, item }))].sort((a, b) => a.start - b.start || a.kind.localeCompare(b.kind));
    for (const event of events) {
      if (this.stopped.has(env.runtime)) return undefined;
      if (++this.steps > 30_000) { this.issue({ file: env.file, ...event.item }, 'Go registration summary step budget exceeded', 'router-budget'); return undefined; }
      const local = { ...this.local(env, env.file, event.item.scope), conditions: this.conditions(env, event.item.scope) };
      if (event.kind === 'binding') this.values.set(this.bindingKey(local, env.file, event.item), event.item.tuple ? undefined : this.evaluate(event.item.value!, local));
      else if (event.kind === 'call') {
        if (event.item.timing === 'deferred') local.conditions.push('Deferred registration/serving order is not simulated');
        else if (event.item.timing === 'goroutine') local.conditions.push('Concurrent registration/serving order is not proven');
        this.evaluate(event.item.expression, local);
      } else if (event.kind === 'return') {
        if (local.conditions.length !== env.conditions.length) { for (const value of event.item.values) { const result = this.evaluate(value, local); if (is(result, 'receiver')) result.conditions.push(...local.conditions); } continue; }
        return event.item.values.length === 1 ? this.evaluate(event.item.values[0]!, local) : undefined;
      } else if (event.item.target.kind === 'member') {
        const object = this.evaluate(event.item.target.object, local), value = event.item.value ? this.evaluate(event.item.value, local) : undefined;
        const target = this.symbols.resolveExpression(local.file, event.item.target, local.scope, local.origin);
        if (target.kind === 'external' && target.specifier === 'net/http' && target.members.join('.') === 'DefaultServeMux') {
          if (is(value, 'receiver') && value.framework === 'net-http' && event.item.kind === 'assignment') { value.conditions.push(...local.conditions); this.defaults.set(env.runtime, value); }
          else this.defaultMux(local, { file: env.file, ...event.item }).conditions.push('Mutated DefaultServeMux identity is unresolved');
        } else if (is(object, 'server') && event.item.target.name === 'Handler' && event.item.kind === 'assignment') { object.handler = value; object.conditions.push(...local.conditions); }
        else if (is(object, 'receiver')) {
          if (object.framework === 'gin' && ['UseRawPath', 'RemoveExtraSlash', 'RedirectFixedPath', 'RedirectTrailingSlash', 'UnescapePathValues', 'HandleMethodNotAllowed'].includes(event.item.target.name) && typeof value === 'boolean' && value === ['RedirectTrailingSlash', 'UnescapePathValues'].includes(event.item.target.name)) continue;
          object.root.conditions.push(`Router routing/configuration field ${event.item.target.name} is mutated`);
        }
      }
    } return undefined;
  }
  private evaluate(expression: GoExpression, env: Environment, depth = 0): Value {
    if (depth > 64 || ++this.steps > 30_000) return undefined;
    if (expression.kind === 'literal') return expression.value;
    if (expression.kind === 'binary' && expression.operator === '+') { const left = this.evaluate(expression.left, env, depth + 1), right = this.evaluate(expression.right, env, depth + 1); return typeof left === 'string' && typeof right === 'string' ? left + right : undefined; }
    if (expression.kind === 'unary' && expression.operator === '&') return this.evaluate(expression.object, env, depth + 1);
    if (expression.kind === 'name' || expression.kind === 'member') {
      const binding = this.symbols.sourceBinding(env.file, expression, env.scope, env.origin);
      if (binding) {
        const parameter = env.parameters.get(`${binding.file}:${binding.fact.scope}:${binding.fact.name}`);
        if (parameter !== undefined) { if (binding.mutable) { if (is(parameter, 'receiver')) parameter.root.conditions.push('Helper parameter reassigns/exposes its router identity'); else return undefined; } return parameter; }
        const key = this.bindingKey(env, binding.file, binding.fact);
        if (!this.values.has(key) && binding.fact.value && !this.active.has(key)) {
          this.active.add(key); const local = this.local(env, binding.file, binding.fact.scope), value = this.evaluate(binding.fact.value, local, depth + 1); this.values.set(key, value); this.active.delete(key);
        }
        const value = this.values.get(key);
        if (binding.mutable) { if (is(value, 'receiver')) value.root.conditions.push('Reassigned/address-exposed router binding cannot prove receiver identity'); else return undefined; }
        return value;
      }
    }
    if (expression.kind === 'composite') {
      const type = this.symbols.resolveExpression(env.file, expression.type, env.scope, env.origin);
      if (type.kind === 'external' && type.specifier === 'net/http' && type.members.join('.') === 'ServeMux') return this.cached(expression, env, () => this.receiver('net-http', env, { file: env.file, ...expression }, [], type.proof));
      if (type.kind === 'external' && type.specifier === 'net/http' && type.members.join('.') === 'Server') return this.cached(expression, env, () => ({ kind: 'server', handler: expression.items?.find(item => item.key === 'Handler') ? this.evaluate(expression.items.find(item => item.key === 'Handler')!.value, env, depth + 1) : undefined, conditions: expression.items?.some(item => !item.key) ? ['Positional Server construction is not reviewed'] : [] }));
      if (expression.type.kind === 'unknown' && /^\[\]string$/.test(expression.type.text.replace(/\s+/g, ''))) return expression.items?.map(item => this.evaluate(item.value, env, depth + 1));
    }
    if (expression.kind === 'call') return this.cached(expression, env, () => this.call(expression, env));
    const value = this.symbols.resolveExpression(env.file, expression, env.scope, env.origin);
    if (value.kind === 'function') return { kind: 'callback', bound: value, environment: env };
    if (value.kind === 'external' && value.specifier === 'net/http' && value.members.join('.') === 'DefaultServeMux') { const mux = this.defaultMux(env, { file: env.file, ...expression }); mux.proof.push(...value.proof); return mux; }
    return value;
  }
  private cached(expression: GoExpression, env: Environment, compute: () => Value): Value {
    const key = JSON.stringify([env.runtime, env.instance, env.file, expression.start, expression.range.endLine, expression.range.endColumn, expression.kind]); if (this.values.has(key)) return this.values.get(key);
    if (this.active.has(key)) return undefined; this.active.add(key); const value = compute(); this.active.delete(key); this.values.set(key, value); return value;
  }
  private call(expression: GoExpression & { kind: 'call' }, env: Environment): Value {
    const site = { file: env.file, ...expression }, callee = this.evaluate(expression.callee, env), args = expression.args.map(arg => this.evaluate(arg, env));
    if (bound(callee) && (callee.kind === 'builtin' && callee.name === 'panic' || callee.kind === 'external' && (callee.specifier === 'os' && callee.members.join('.') === 'Exit' || callee.specifier === 'log' && ['Fatal', 'Fatalf', 'Fatalln'].includes(callee.members.join('.'))))) {
      const conditions = this.conditions(env, env.scope);
      if (!conditions.length) this.stopped.add(env.runtime);
      this.runtimeConditions.set(env.runtime, [...this.runtimeConditions.get(env.runtime) ?? [], 'Reachable program termination can prevent router serving']);
      return undefined;
    }
    if (bound(callee) && callee.kind === 'external') {
      const api = callee.members.join('.');
      if (callee.specifier === 'net/http') {
        if (api === 'NewServeMux') return this.receiver('net-http', env, site, expression.args.length ? ['Unsupported ServeMux constructor arguments'] : [], callee.proof);
        if (api === 'Handle' || api === 'HandleFunc') { const mux = this.defaultMux(env, site); mux.proof.push(...callee.proof); this.register(mux, api, args, expression.args, env, site); return undefined; }
        if (['ListenAndServe', 'ListenAndServeTLS', 'Serve', 'ServeTLS'].includes(api)) { this.expose(args[api === 'ListenAndServeTLS' ? 3 : api === 'ServeTLS' ? 3 : 1] ?? null, env, site); return undefined; }
        if (api === 'HandlerFunc') return this.handler(args[0], expression.args[0], env, true);
        if (api === 'StripPrefix') { const handler = this.handler(args[1], expression.args[1], env, false); return typeof args[0] === 'string' ? { ...handler, strip: args[0] } : { ...handler, conditions: [...handler.conditions, 'Dynamic StripPrefix'] }; }
        if (['TimeoutHandler', 'MaxBytesHandler', 'AllowQuerySemicolons'].includes(api)) return this.handler(args[0], expression.args[0], env, false);
        if (['FileServer', 'FileServerFS', 'NotFoundHandler', 'RedirectHandler'].includes(api)) return { kind: 'handler', conditions: ['Framework-provided resource/response has no indexed handler callback'], proof: [this.fact(site, `net/http ${api} resource/response`)] };
      }
      const outcome = this.symbols.resolver.resolve(env.file, callee.specifier, env.origin), profile = goApi(outcome, callee.specifier);
      if (profile?.reviewed && (callee.specifier === GIN_MODULE && ['Logger', 'Recovery'].includes(api) || callee.specifier === `${CHI_MODULE}/middleware` && ['Timeout', 'Heartbeat', 'Compress', 'Throttle', 'ThrottleBacklog', 'AllowContentType', 'SetHeader'].includes(api))) return callee;
      if (profile && [CHI_MODULE, GIN_MODULE].includes(callee.specifier)) {
        if (profile.kind === 'chi' && ['NewRouter', 'NewMux'].includes(api) || profile.kind === 'gin' && ['New', 'Default'].includes(api)) return this.receiver(profile.kind, env, site, [...profile.conditions, ...(args.length ? ['Constructor options require a reviewed routing profile'] : [])], callee.proof);
        if (profile.kind === 'gin' && ['WrapH', 'WrapF'].includes(api)) return this.handler(args[0], expression.args[0], env, api === 'WrapF');
      }
      this.escape(args, site, `Unreviewed external call ${callee.specifier}.${api}`); return undefined;
    }
    if (expression.callee.kind === 'member') {
      const object = this.evaluate(expression.callee.object, env), method = expression.callee.name;
      if (is(object, 'receiver')) return this.operation(object, method, args, expression.args, env, site);
      if (is(object, 'server') && ['ListenAndServe', 'ListenAndServeTLS', 'Serve', 'ServeTLS'].includes(method)) { const local = { ...env, conditions: [...env.conditions, ...object.conditions] }; this.expose(object.handler ?? null, local, site); return undefined; }
    }
    if (bound(callee) && callee.kind === 'builtin' && callee.name === 'new' && args[0] && bound(args[0]) && args[0].kind === 'external' && args[0].specifier === 'net/http') {
      if (args[0].members.join('.') === 'ServeMux') return this.receiver('net-http', env, site, [], args[0].proof);
      if (args[0].members.join('.') === 'Server') return { kind: 'server', conditions: [] };
    }
    if (is(callee, 'callback')) return this.invoke(callee, args, env, site);
    this.escape(args, site, 'Unresolved helper call can mutate or mount a router'); return undefined;
  }
  private invoke(callback: Callback, args: Value[], env: Environment, site: Site): Value {
    const def = callback.bound.definition, fact = def.fact;
    if (!fact.bodyScope || env.stack.includes(callback.bound.id) || env.stack.length > 32) { this.escape(args, site, 'Recursive/bodyless helper cannot prove registrations'); return undefined; }
    if (fact.parameters.some(parameter => parameter.variadic) || args.length !== fact.parameters.length) { this.escape(args, site, 'Expanded or mismatched helper arguments are unresolved'); return undefined; }
    const identity = JSON.stringify([env.instance, callback.bound.id]), instance = this.context.graph.id('go-invocation', identity, String(this.ordinal(identity))), parameters = new Map(callback.environment.parameters), frames = new Map(callback.environment.frames);
    for (const [index, parameter] of fact.parameters.entries()) if (parameter.name) parameters.set(`${def.unit.file.path}:${fact.bodyScope}:${parameter.name}`, args[index]);
    frames.set(`${def.unit.file.path}:${fact.key}`, instance);
    this.module(def.unit.file.path, env);
    return this.execute({ ...env, file: def.unit.file.path, scope: fact.bodyScope, instance, frames, parameters, stack: [...env.stack, callback.bound.id] });
  }
  private escape(args: Value[], site: Site, reason: string): void {
    for (const value of args) if (is(value, 'receiver')) { value.root.conditions.push(reason); this.issue(site, reason); } else if (is(value, 'handler') && value.router) { value.router.root.conditions.push(reason); this.issue(site, reason); }
  }
  private signature(callback: Callback, framework: Framework): string[] {
    const def = callback.bound.definition, params = def.fact.parameters, expected = framework === 'gin' ? 1 : 2;
    if (callback.bound.methodExpression || params.length !== expected || def.fact.results.length || params.some(parameter => parameter.variadic)) return ['Callback signature does not match the reviewed handler function type'];
    const token = (expression: GoExpression): string | undefined => {
      if (expression.kind === 'unary' && expression.operator === '*') { const inner = token(expression.object); return inner ? `*${inner}` : undefined; }
      const value = this.symbols.resolveExpression(def.unit.file.path, expression, def.fact.bodyScope ?? def.fact.scope, def.unit.pkg.origin);
      return value.kind === 'external' ? `${value.specifier}.${value.members.join('.')}` : undefined;
    };
    const names = params.map(parameter => token(parameter.type));
    return (framework === 'gin' ? names[0] === `*${GIN_MODULE}.Context` : names[0] === 'net/http.ResponseWriter' && names[1] === '*net/http.Request') ? [] : ['Handler parameter aliases/types require additional type qualification'];
  }
  private handler(value: Value, expression: GoExpression | undefined, env: Environment, functionValue: boolean, framework: Framework = 'net-http'): Handler {
    if (is(value, 'handler')) return value;
    if (is(value, 'receiver')) return { kind: 'handler', router: value, conditions: [], proof: [] };
    if (is(value, 'callback') && functionValue) return { kind: 'handler', callback: value, conditions: this.signature(value, framework), proof: value.bound.proof };
    if (bound(value) && value.kind === 'instance' && expression && !functionValue) {
      const method: GoExpression = { ...expression, kind: 'member', object: expression, name: 'ServeHTTP' }, selected = this.symbols.resolveExpression(env.file, method, env.scope, env.origin);
      if (selected.kind === 'function') { const callback: Callback = { kind: 'callback', bound: selected, environment: env }; return { kind: 'handler', callback, conditions: this.signature(callback, 'net-http'), proof: selected.proof }; }
    }
    return { kind: 'handler', conditions: ['Handler callback or concrete ServeHTTP implementation is unresolved'], proof: [] };
  }
  private middleware(receiver: Receiver, args: Value[], site: Site, global = false): string[] {
    const references: string[] = [];
    for (const value of args) {
      if (is(value, 'callback')) {
        references.push(value.bound.id);
        if (receiver.framework === 'chi') {
          const def = value.bound.definition, facts = this.symbols.unitFacts(def.unit.file.path, def.unit.pkg.origin);
          if (facts?.writes.some(write => write.start >= def.fact.start && write.range.endLine <= def.fact.range.endLine && write.target.kind === 'member' && ['Path', 'RawPath', 'RoutePath', 'Method', 'RouteMethod'].includes(write.target.name))) receiver.root.conditions.push('Indexed middleware mutates request routing fields');
        }
      }
      else if (bound(value) && value.kind === 'external') {
        if (receiver.framework === 'chi' && value.specifier === `${CHI_MODULE}/middleware` && value.members.join('.') === 'GetHead') { if (global && receiver === receiver.root) receiver.root.head = true; }
        else if (value.specifier === `${CHI_MODULE}/middleware` && ['StripSlashes', 'RedirectSlashes', 'CleanPath', 'PathRewrite', 'URLFormat', 'PageRoute', 'RouteHeaders', 'RouteMethods'].includes(value.members.join('.'))) receiver.root.conditions.push('Middleware modifies path/method routing semantics');
        else if (receiver.framework === 'chi' && !(value.specifier === `${CHI_MODULE}/middleware` && ['RequestID', 'Logger', 'Recoverer', 'RealIP', 'NoCache', 'Timeout', 'Heartbeat', 'Compress', 'Throttle', 'ThrottleBacklog', 'AllowContentType', 'SetHeader'].includes(value.members.join('.')))) receiver.root.conditions.push('External middleware routing behavior requires a reviewed summary');
      } else if (value !== undefined) receiver.conditions.push('Middleware list is dynamic or expanded');
      else receiver.conditions.push('Middleware factory/identity requires a reviewed summary');
    } if (args.length && receiver.framework === 'chi' && !receiver.root.frozen) receiver.root.frozen = false;
    return references;
  }
  private operation(receiver: Receiver, method: string, args: Value[], raw: GoExpression[], env: Environment, site: Site): Value {
    const root = receiver.root;
    if (['Run', 'RunTLS', 'RunUnix', 'RunFd', 'RunListener', 'RunQUIC'].includes(method) && receiver.framework === 'gin' && receiver === root) { this.expose(receiver, env, site); return undefined; }
    if (method === 'Use') {
      if (receiver.framework === 'chi' && receiver === root && root.frozen) root.conditions.push('Chi Use after routing begins panics');
      receiver.middleware.push(...this.middleware(receiver, args, site, true)); return receiver;
    }
    if (receiver.framework === 'gin' && method === 'Group') {
      const group = { ...receiver, base: typeof args[0] === 'string' ? this.ginJoin(receiver.base, args[0]) : receiver.base, middleware: [...receiver.middleware], conditions: unique([...receiver.conditions, ...this.conditions(env, env.scope), ...typeof args[0] === 'string' ? [] : ['Dynamic Gin group prefix']]), applications: new Set<string>() };
      group.middleware.push(...this.middleware(group, args.slice(1), site)); return group;
    }
    if (receiver.framework === 'chi' && ['With', 'Group'].includes(method)) {
      root.frozen = true; const group = { ...receiver, middleware: [...receiver.middleware], conditions: unique([...receiver.conditions, ...this.conditions(env, env.scope)]), applications: new Set<string>() };
      if (method === 'With') group.middleware.push(...this.middleware(group, args, site));
      if (method === 'Group') { if (is(args[0], 'callback')) this.invoke(args[0], [group], env, site); else root.conditions.push('Group callback is unresolved'); } return group;
    }
    if (receiver.framework === 'chi' && method === 'Route') {
      const child = this.receiver('chi', env, site, typeof args[0] === 'string' ? [] : ['Dynamic Chi Route prefix'], root.proof);
      if (is(args[1], 'callback')) this.invoke(args[1], [child], env, site); else child.conditions.push('Route callback is unresolved');
      this.mount(receiver, typeof args[0] === 'string' ? args[0] : '/', child, undefined, 'chi', env, site); return child;
    }
    if (receiver.framework === 'chi' && method === 'Mount') {
      const handler = this.handler(args[1], raw[1], env, false);
      if (handler.router) this.mount(receiver, typeof args[0] === 'string' ? args[0] : '/', handler.router, handler.strip, 'chi', env, site);
      else if (typeof args[0] === 'string') {
        const prefix = args[0];
        for (const route of prefix.endsWith('/') ? [`${prefix}*`] : [prefix, `${prefix}/`, `${prefix}/*`]) this.register(receiver, 'Handle', [route, handler], raw, env, site);
      } else this.register(receiver, 'Handle', [undefined, handler], raw, env, site);
      return undefined;
    }
    if (receiver.framework === 'net-http' ? ['Handle', 'HandleFunc'].includes(method) : receiver.framework === 'chi' ? ['Handle', 'HandleFunc', 'Method', 'MethodFunc', 'Get', 'Post', 'Put', 'Patch', 'Delete', 'Head', 'Options', 'Connect', 'Trace'].includes(method) : ['Handle', 'Any', 'Match', ...METHODS].includes(method)) { this.register(receiver, method, args, raw, env, site); return receiver.framework === 'gin' ? receiver : undefined; }
    if (receiver.framework === 'chi' && ['NotFound', 'MethodNotAllowed'].includes(method)) { root.conditions.push(`Custom Chi ${method} dispatch requires a response profile`); return undefined; }
    if (receiver.framework === 'gin' && ['NoRoute', 'NoMethod', 'With'].includes(method)) { root.conditions.push(`Custom Gin ${method} dispatch/options require a response profile`); return receiver; }
    if (['Routes', 'Middlewares', 'Match', 'Find', 'BasePath', 'ServeHTTP'].includes(method)) return undefined;
    root.conditions.push(`Unreviewed router operation ${method}`); this.issue(site, `Unreviewed ${receiver.framework} router operation ${method}`); return undefined;
  }
  private ginJoin(base: string, child: string): string { const pathValue = path.posix.join(base || '/', child).replace(/\/$/, '') || '/'; return child.endsWith('/') && pathValue !== '/' ? `${pathValue}/` : pathValue; }
  private register(receiver: Receiver, method: string, args: Value[], raw: GoExpression[], env: Environment, site: Site): void {
    const root = receiver.root, conditions = [...receiver.conditions, ...this.conditions(env, env.scope)], framework = receiver.framework;
    let value = args[0], methods: string[] | '*' = '*', callbacks = args.slice(1), source = raw.slice(1), host: string | undefined;
    if (['Method', 'MethodFunc'].includes(method) || framework === 'gin' && method === 'Handle') { methods = typeof args[0] === 'string' ? [args[0]] : '*'; value = args[1]; callbacks = args.slice(2); source = raw.slice(2); if (typeof args[0] !== 'string') conditions.push('Dynamic HTTP method'); }
    else if (framework === 'gin' && method === 'Match') { methods = Array.isArray(args[0]) && args[0].every(value => typeof value === 'string') ? args[0] as string[] : '*'; value = args[1]; callbacks = args.slice(2); source = raw.slice(2); if (!Array.isArray(methods)) conditions.push('Dynamic method list'); }
    else if (framework === 'gin' && method === 'Any') methods = METHODS;
    else if (!['Handle', 'HandleFunc'].includes(method)) methods = [method.toUpperCase()];
    if (framework === 'chi' && methods === '*' && !conditions.includes('Dynamic HTTP method')) methods = [...METHODS];
    let route = typeof value === 'string' ? value : '/'; if (typeof value !== 'string') conditions.push('Dynamic route pattern');
    if (framework === 'net-http') { const parsed = compileGoMux(route, receiver.modern); route = parsed.path; methods = parsed.methods; host = parsed.host; if (parsed.invalid) root.conditions.push('Invalid ServeMux pattern panics during registration'); }
    if (framework === 'gin') { route = this.ginJoin(receiver.base, route); if (Array.isArray(methods) && methods.some(value => !/^[A-Z]+$/.test(value))) root.conditions.push('Invalid Gin HTTP method panics during registration'); }
    else if (framework === 'chi' && Array.isArray(methods) && methods.some(value => !METHODS.includes(value))) conditions.push('Custom Chi method requires proven RegisterMethod initialization');
    const func = framework === 'gin' || /Func$/.test(method) || !['Handle', 'Method'].includes(method);
    if (callbacks.at(-1) === null && framework !== 'gin') root.conditions.push('Nil handler panics during registration');
    const handler = this.handler(callbacks.at(-1), source.at(-1), env, func, framework);
    conditions.push(...handler.conditions); if (callbacks.length !== 1 && framework !== 'gin') conditions.push('Invalid registration argument count');
    const middleware = [...receiver.middleware, ...framework === 'gin' ? this.middleware(receiver, callbacks.slice(0, -1), site) : []];
    if (handler.router) { this.mount(receiver, route, handler.router, handler.strip, 'preserve', env, site, methods, host, middleware, conditions); return; }
    root.entries.push({ site, path: route, methods, host, callback: handler.callback, middleware, conditions: unique(conditions), proof: [...handler.proof, this.fact(site, `Qualified ${framework}.${method} registration`)], order: root.entries.length, profile: receiver.modern, dynamicPath: typeof value !== 'string' || conditions.some(reason => reason.includes('Dynamic Gin group prefix')) }); root.frozen = true; this.touch(site, framework);
  }
  private mount(receiver: Receiver, prefix: string, child: Receiver, strip: string | undefined, mode: 'chi' | 'preserve', env: Environment, site: Site, methods: string[] | '*' = '*', host?: string, middleware = receiver.middleware, conditions: string[] = []): void {
    const root = receiver.root;
    if (mode === 'chi' && (child.root === root || root.entries.some(entry => entry.child && entry.path.replace(/\/$/, '') === prefix.replace(/\/$/, '')))) root.conditions.push('Duplicate/self Chi mount panics during registration');
    root.entries.push({ site, path: prefix, methods, host, child, strip, mode, middleware: [...middleware], conditions: unique([...conditions, ...receiver.conditions, ...this.conditions(env, env.scope)]), proof: [this.fact(site, `${receiver.framework} ${mode} mount ${prefix}${strip ? `; StripPrefix ${strip}` : ''}`)], order: root.entries.length, profile: receiver.modern }); root.frozen = true; this.touch(site, receiver.framework);
  }
  private expose(value: Value, env: Environment, site: Site): void {
    const handler = value === null ? { kind: 'handler' as const, router: this.defaultMux(env, site), conditions: [], proof: [] } : this.handler(value, undefined, env, false);
    if (handler.router && env.application) { handler.router.root.exposed = true; handler.router.root.applications.add(env.application); handler.router.root.conditions.push(...handler.conditions, ...this.conditions(env, env.scope)); }
    else if (handler.callback && env.application) { const root = this.receiver('net-http', env, site); root.exposed = true; root.applications.add(env.application); root.entries.push({ site, path: '/', methods: '*', callback: handler.callback, middleware: [], conditions: handler.conditions, proof: handler.proof, order: 0, profile: root.modern }); }
    else this.issue(site, 'Serving handler/application boundary is unresolved');
  }
  private contract(root: Receiver, entry: Entry): RoutingContract {
    let pattern = root.framework === 'net-http' ? compileGoMux(entry.path, root.modern).pattern : root.framework === 'chi' ? compileChiPath(entry.path) : compileGinPath(entry.path);
    if (entry.dynamicPath) pattern = { ...pattern, status: 'partial', reason: 'Dynamic Go registration path/prefix', prefix: '/', alternatives: [] };
    return { version: 1, pattern, methods: entry.methods, ...(entry.host ? { host: entry.host } : {}), ...(entry.excluded?.length ? { excludedMethods: entry.excluded } : {}), executionContext: 'server', registration: { file: entry.site.file, line: entry.site.range.startLine, receiver: root.id }, mounts: [], middleware: entry.middleware, conditions: unique([...root.conditions, ...entry.conditions, ...(pattern.status === 'partial' ? [pattern.reason ?? 'Unreviewed routing pattern'] : [])]), dispatch: { dialect: root.framework === 'net-http' ? 'go-servemux' : root.framework, root: root.id, order: entry.order } };
  }
  private entries(root: Receiver): Entry[] {
    if (root.framework !== 'net-http') return root.entries;
    const redirects: Entry[] = [];
    for (const entry of root.entries) {
      const pattern = this.contract(root, entry).pattern;
      if (pattern.status !== 'exact' || !pattern.original.endsWith('/') && pattern.alternatives[0]?.at(-1)?.kind !== 'rest') continue;
      const prefix = pattern.original.endsWith('/') ? pattern.original.slice(0, -1) : entry.path.slice(0, entry.path.lastIndexOf('/')); if (!prefix) continue;
      const target = this.contract(root, { ...entry, path: prefix }), excluded: string[] = [];
      for (const exact of root.entries) {
        const candidate = this.contract(root, exact);
        if (candidate.pattern.alternatives[0]?.at(-1)?.kind !== 'rest' && goRouteSubset({ ...target, methods: '*' }, { ...candidate, methods: '*' })) {
          if (candidate.methods === '*') excluded.push('*'); else excluded.push(...candidate.methods);
        }
      }
      if (excluded.includes('*')) continue;
      const methods = entry.methods === '*' ? '*' : entry.methods.filter(method => !excluded.includes(method)); if (Array.isArray(methods) && !methods.length) continue;
      redirects.push({ ...entry, path: prefix, methods, excluded: entry.methods === '*' ? excluded : [], child: undefined, callback: undefined, redirect: true, proof: [...entry.proof, this.fact(entry.site, 'ServeMux subtree-root slash redirect has no user callback')] });
    }
    return [...root.entries, ...redirects];
  }
  private validate(root: Receiver): void {
    const entries = root.entries;
    for (let i = 0; i < entries.length; i++) for (let j = i + 1; j < entries.length; j++) {
      const a = this.contract(root, entries[i]!), b = this.contract(root, entries[j]!);
      if (a.host && b.host && a.host !== b.host || a.methods !== '*' && b.methods !== '*' && !a.methods.some(method => b.methods.includes(method))) continue;
      if (root.framework === 'gin' && this.ginConflict(a, b)) root.conditions.push('Duplicate/conflicting Gin routes panic before serving');
      if (!goPatternsOverlap(a.pattern, b.pattern)) continue;
      const equivalent = goRouteSubset(a, b) && goRouteSubset(b, a), samePath = goRouteSubset({ ...a, methods: '*' }, { ...b, methods: '*' }) && goRouteSubset({ ...b, methods: '*' }, { ...a, methods: '*' });
      if (root.framework === 'net-http' && (equivalent || root.modern && !(a.host !== b.host && (a.host || b.host)) && !goRouteSubset(a, b) && !goRouteSubset(b, a))) root.conditions.push('Conflicting ServeMux registrations panic before serving');
      if (root.framework === 'gin' && (equivalent || this.ginConflict(a, b))) root.conditions.push('Duplicate/conflicting Gin routes panic before serving');
      if (root.framework === 'chi' && samePath && a.pattern.status === 'exact' && b.pattern.status === 'exact') { const prior = entries[i]!, later = entries[j]!; if (later.methods === '*') prior.methods = []; else if (Array.isArray(prior.methods)) prior.methods = prior.methods.filter(method => !later.methods.includes(method)); else prior.conditions.push('Chi ALL overwrite exclusions require a method profile'); }
    }
  }
  private ginConflict(a: RoutingContract, b: RoutingContract): boolean {
    const left = a.pattern.alternatives[0], right = b.pattern.alternatives[0]; if (!left || !right) return false;
    for (let index = 0; index < Math.min(left.length, right.length); index++) {
      const x = left[index]!, y = right[index]!;
      if (x.kind === 'rest' || y.kind === 'rest') return true;
      const xp = x.parts.find(part => part.kind === 'parameter'), yp = y.parts.find(part => part.kind === 'parameter');
      if (xp && yp && x.parts.filter(part => part.kind === 'literal').map(part => part.value).join('') !== y.parts.filter(part => part.kind === 'literal').map(part => part.value).join('')) return false;
      if (xp && yp && JSON.stringify(x.parts) !== JSON.stringify(y.parts)) return true;
      if (JSON.stringify(x.parts) !== JSON.stringify(y.parts) && !(xp && yp)) return false;
    } return false;
  }
  private emit(root: Receiver, application: string, mounts: RoutingContract['mounts'], inherited: string[], middleware: string[], stack: Set<Receiver>, rewrite = '', guards: RoutingContract[] = [], headFallback = false): void {
    if (stack.has(root) || stack.size > 32) { this.issue(root.site, 'Router mount recursion/depth is unresolved'); return; } const next = new Set(stack).add(root);
    for (const entry of this.entries(root)) {
      if (Array.isArray(entry.methods) && !entry.methods.length) continue;
      if (entry.child) {
        const consumes = entry.mode === 'chi' && entry.child.framework === 'chi', prefix = consumes ? entry.path : entry.strip ?? '', full = prefix ? composeRoutePath(rewrite, prefix) : rewrite;
        const guard = this.contract(root, entry), parentPath = rewrite ? composeRoutePath(rewrite, entry.path) : entry.path;
        if (entry.mode === 'chi') {
          guard.pattern = compileChiPath(`${parentPath.replace(/\/$/, '')}/*`);
          if (!entry.path.endsWith('/')) { guard.pattern.alternatives.push(...compileChiPath(parentPath).alternatives); guard.pattern.original = parentPath; }
        } else guard.pattern = compileGoMux(parentPath, root.modern).pattern;
        if (entry.strip) {
          if (!/^\/[A-Za-z0-9_/.-]+$/.test(entry.strip) || entry.strip.endsWith('/')) guard.conditions.push('Escaped/trailing-slash StripPrefix requires URL.Path and RawPath proof');
          guard.rawPrefix = rewrite ? composeRoutePath(rewrite, entry.strip) : entry.strip;
        }
        const mount = { id: this.context.graph.id('mount', root.id, entry.child.id, entry.path, String(entry.order)), file: entry.site.file, line: entry.site.range.startLine, prefix: entry.path };
        this.emit(entry.child.root, application, [...mounts, mount], [...inherited, ...guard.conditions, ...(consumes && entry.strip ? ['StripPrefix combined with Chi routing context requires a separate rewrite profile'] : [])], [...middleware, ...entry.middleware], next, full, [...guards, guard], headFallback || root.head); continue;
      }
      const routes = rewrite && root.framework === 'chi' && entry.path === '/' && guards.at(-1)?.dispatch?.dialect === 'chi' ? [rewrite, composeRoutePath(rewrite, entry.path)] : [rewrite ? composeRoutePath(rewrite, entry.path) : entry.path];
      for (const route of routes) {
        const contract = this.contract(root, entry);
        contract.pattern = root.framework === 'net-http' ? compileGoMux(route, root.modern).pattern : root.framework === 'chi' ? compileChiPath(route) : compileGinPath(route);
        contract.mounts = mounts; contract.middleware = unique([...middleware, ...entry.middleware]); contract.conditions = unique([...inherited, ...contract.conditions]);
        if (entry.dynamicPath || contract.conditions.some(reason => /Dynamic (?:Chi Route prefix|Gin group prefix|StripPrefix)|middleware.*(?:routing fields|routing semantics)/i.test(reason))) {
          contract.pattern = { ...contract.pattern, status: 'partial', reason: 'Dynamic Go path registration/rewrite', prefix: '/', alternatives: [] };
          if (contract.conditions.some(reason => /middleware.*(?:routing fields|routing semantics)/i.test(reason))) contract.methods = '*';
        }
        if (guards.length) contract.guards = guards;
        if ((root.head || headFallback) && Array.isArray(contract.methods) && contract.methods.includes('GET') && !contract.methods.includes('HEAD')) { contract.methods = [...contract.methods, 'HEAD']; contract.fallbackMethods = ['HEAD']; }
        const method = contract.methods === '*' ? 'ALL' : contract.methods.join('|'), parentId = this.context.applicationIds.get(application); if (!parentId) continue;
        const id = this.context.graph.id('endpoint', 'go', application, root.framework, root.id, route, method, entry.host ?? '', ...mounts.map(mount => mount.id));
        const facts = [this.fact(entry.site, `${root.framework} ${method} ${route}`), ...root.proof, ...entry.proof, ...mounts.map(mount => evidence('framework', 'go-routers', mount.file, mount.line, `Router mount ${mount.prefix}`))];
        if (this.context.graph.entities.has(id)) continue;
        this.context.graph.contain({ id, type: 'api_endpoint', name: `${method} ${route}`, path: entry.site.file, language: 'go', parentId, sourceRange: entry.site.range, metadata: { framework: root.framework, registration: 'explicit', method, routePath: route, routing: contract, executionContext: 'server', ...(entry.redirect ? { role: 'redirect', status: 301 } : {}), ...(contract.conditions.length ? { constraintsUnresolved: true, constraints: contract.conditions } : {}) }, evidence: facts });
        this.context.graph.relate(this.context.files.get(entry.site.file)!.id, id, 'routes_to', facts, { framework: root.framework, role: 'registration' });
        if (entry.callback) this.context.graph.relate(id, entry.callback.bound.id, 'handles', [...facts, ...entry.callback.bound.proof], { framework: root.framework, role: 'handler' });
        for (const target of contract.middleware) this.context.graph.relate(id, target, 'references', facts, { framework: root.framework, role: 'middleware' });
        for (const condition of contract.conditions) this.issue(entry.site, condition);
      }
    }
  }
}
