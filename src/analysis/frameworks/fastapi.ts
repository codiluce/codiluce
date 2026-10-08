import type { AnalysisContext } from '../../core/analyzer.js';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { subset, validRange } from 'semver';
import { IndexedSources } from '../indexed-sources.js';
import { evidence, type Entity, type Evidence, type SourceRange } from '../../core/graph.js';
import { fileAnalysis, type PythonArgument, type PythonExpression } from '../facts.js';
import { PythonSymbols, type PythonBound } from '../languages/python-symbols.js';
import { bindPythonArguments } from '../languages/python-arguments.js';
import { compileStarlettePath, composeRoutePath, type RoutingContract } from '../routes/contracts.js';

export const FASTAPI_VERSION = '1.0.1';
interface Site { file: string; start: number; range: SourceRange }
interface Environment { file: string; scope?: string; instance: string; parameters: Map<string, Value>; conditions: string[]; stack: string[] }
interface Receiver { kind: 'receiver'; type: 'app' | 'router'; id: string; site: Site; prefix: string; profile: 'snapshot' | 'live' | 'unknown'; conditions: string[]; dependencies: string[]; entries: Entry[]; exposed: boolean }
interface Entry { site: Site; path: string; methods: string[] | '*'; handler?: string; dependencies: string[]; conditions: string[]; mounts: RoutingContract['mounts']; status?: number; mount?: Receiver; include?: Receiver }
type Value = Receiver | PythonBound | string | number | boolean | null | Value[] | undefined;
const receiver = (value: Value): value is Receiver => !!value && typeof value === 'object' && !Array.isArray(value) && value.kind === 'receiver';
const bound = (value: Value): value is PythonBound => !!value && typeof value === 'object' && !Array.isArray(value) && value.kind !== 'receiver';
const verbs = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace']);

/** Static registration only: follows proven indexed values and invoked factories,
 * never imports/runs Python. Includes copy the child's registrations at that site. */
export class FastAPIRegistrations {
  private readonly receivers: Receiver[] = [];
  private readonly moduleStates = new Map<string, 'running' | 'done'>();
  private readonly values = new Map<string, Value>();
  private readonly active = new Set<string>();
  private readonly ordinals = new Map<string, number>();
  private readonly profiles = new Map<string, Receiver['profile']>();
  private steps = 0;
  constructor(private readonly context: AnalysisContext, private readonly symbols: PythonSymbols) {}
  /** These two minor profiles are reviewed against tagged routing.py sources.
   * Unknown/broad PEP-440 ranges cannot select copy versus live inclusion. */
  private profile(file: string): Receiver['profile'] {
    const root = this.symbols.resolver.owner(file)?.root ?? '.', cached = this.profiles.get(root); if (cached) return cached;
    const sources = this.context.sources ?? new IndexedSources(this.context), dependencies: string[] = [];
    for (const input of this.context.files.values()) {
      if (!input.analyzable || path.posix.dirname(input.path) !== root) continue;
      try {
        if (input.path.endsWith('/pyproject.toml') || input.path === 'pyproject.toml') {
          const value = parseToml(sources.readText(input.path)) as any;
          dependencies.push(...(Array.isArray(value.project?.dependencies) ? value.project.dependencies.filter((item: unknown): item is string => typeof item === 'string') : []));
          const poetry = value.tool?.poetry?.dependencies?.fastapi;
          if (typeof poetry === 'string') dependencies.push(`fastapi${poetry.startsWith('^') || poetry.startsWith('~') ? poetry : `==${poetry}`}`);
        } else if (/(?:^|\/)requirements[\w.-]*\.txt$/.test(input.path)) dependencies.push(...sources.readText(input.path).split(/\r?\n/));
      } catch { /* A failed manifest cannot prove a version profile. */ }
    }
    const declarations = dependencies.map(item => /^\s*fastapi(?:\[[\w, -]+\])?\s*([^;#]*)/i.exec(item)).filter(Boolean);
    const ranges = declarations.map(match => {
      const requirement = match![1]!.trim();
      if (/\s(?:--|@)|[!*~]/.test(requirement) && !requirement.startsWith('~') || requirement.includes('~=')) return undefined;
      return validRange(requirement.replace(/==/g, '').replace(/,/g, ' '));
    });
    const profile: Receiver['profile'] = ranges.length && ranges.every(range => !!range && subset(range, '>=0.115.0 <0.116.0')) ? 'snapshot' : ranges.length && ranges.every(range => !!range && subset(range, '>=0.141.1 <0.142.0')) ? 'live' : 'unknown';
    this.profiles.set(root, profile); return profile;
  }
  private fact(site: Site, explanation: string): Evidence { return { ...evidence('framework', 'fastapi', site.file, site.range.startLine, explanation), analyzerVersion: FASTAPI_VERSION }; }
  private issue(site: Site, code: string, reason: string): void { this.context.graph.diagnose({ analyzer: 'fastapi', severity: 'warning', code, file: site.file, line: site.range.startLine, entityId: this.context.files.get(site.file)?.id, reason }); }
  private key(env: Environment, start: number): string { return JSON.stringify([env.file, env.scope ?? '', env.scope ? env.instance : 'module', start]); }
  private argument(args: PythonArgument[], name: string, index?: number): PythonExpression | undefined { return args.find(arg => arg.name === name)?.value ?? (index === undefined ? undefined : args.filter(arg => !arg.name && !arg.spread)[index]?.value); }
  private read(args: PythonArgument[], name: string, env: Environment, site: Site, index?: number): Value { const item = this.argument(args, name, index); return item ? this.evaluate(item, env, site) : undefined; }
  private options(args: PythonArgument[], names: string[], site: Site): string[] {
    const conditions: string[] = [];
    if (args.some(arg => arg.spread)) conditions.push('Expanded registration arguments are unresolved');
    for (const name of names) if (this.argument(args, name)) conditions.push(`Custom ${name} is outside the static registration profile`);
    if (conditions.length) this.issue(site, 'fastapi-registration-options', conditions.join('; ')); return conditions;
  }
  private module(file: string): void {
    if (this.moduleStates.has(file)) return;
    this.moduleStates.set(file, 'running');
    this.execute({ file, instance: file, parameters: new Map(), conditions: [], stack: [] });
    this.moduleStates.set(file, 'done');
  }
  private mutations(value: Receiver, expression: PythonExpression, env: Environment, site: Site): void {
    let head = expression;
    while (head.kind === 'member') head = head.object;
    if (head.kind !== 'name') return;
    const name = head.name;
    if (this.symbols.facts(env.file)?.python?.writes.some(write => write.name.startsWith(`${name}.`) || write.kind === 'mutation' && write.name === name)) {
      const condition = 'Receiver attributes/routes/dependency overrides are mutated';
      if (!value.conditions.includes(condition)) { value.conditions.push(condition); this.issue(site, 'fastapi-receiver-mutation', condition); }
    }
  }
  run(): void {
    if (![...this.context.syntax?.values() ?? []].some(parsed => parsed.facts.python?.imports.some(item => item.specifier === 'fastapi' || item.specifier.startsWith('fastapi.')))) return;
    for (const file of [...this.context.files.values()].sort((a, b) => a.path.localeCompare(b.path, 'en'))) {
      if (file.language === 'python' && file.path.endsWith('.py') && file.analyzable && !/(?:^|\/)(?:tests?|fixtures|__fixtures__|testdata)(?:\/|$)/.test(file.path)) this.module(file.path);
    }
    const mounted = new Set(this.receivers.flatMap(item => item.entries.filter(entry => entry.mount).map(entry => entry.mount!.id)));
    for (const item of this.receivers) {
      const file = this.context.files.get(item.site.file)!, entity = this.context.graph.entities.get(file.id)!;
      const analysis = fileAnalysis(entity.metadata.analysis);
      (entity.metadata.frameworkPacks as string[] | undefined) ??= [];
      if (!(entity.metadata.frameworkPacks as string[]).includes('fastapi')) (entity.metadata.frameworkPacks as string[]).push('fastapi');
      if (analysis) analysis.features.framework = { status: 'partial', reason: 'Proven static FastAPI/APIRouter instances, decorators, includes, direct handlers, dependencies and bounded invoked factories; dynamic registration remains constrained' };
      (entity.metadata.registrations as unknown[] | undefined) ??= [];
      (entity.metadata.registrations as unknown[]).push({ version: 1, framework: 'fastapi', receiver: item.id, kind: item.type, profile: item.profile, exposed: item.exposed, prefix: item.prefix, routes: item.entries.map(entry => ({ path: entry.path, methods: entry.methods, handler: entry.handler, ...(entry.include ? { includedRouter: entry.include.id } : {}), line: entry.site.range.startLine, conditions: entry.conditions })) });
      if (item.type === 'app' && item.exposed && !mounted.has(item.id)) this.emit(item, item, '', [], [], new Set());
    }
  }
  private execute(env: Environment): Value {
    const facts = this.symbols.facts(env.file), syntax = facts?.python;
    if (!syntax || facts!.truncated || facts!.issues.length) return undefined;
    const events = [
      ...syntax.assignments.filter(item => item.scope === env.scope).map(item => ({ start: item.start, kind: 'assignment' as const, item })),
      ...facts!.declarations.filter(item => item.parent === env.scope).map(item => ({ start: item.start, kind: 'definition' as const, item })),
      ...syntax.calls.filter(item => item.scope === env.scope && item.standalone).map(item => ({ start: item.start, kind: 'call' as const, item })),
      ...syntax.returns.filter(item => item.scope === env.scope).map(item => ({ start: item.start, kind: 'return' as const, item })),
    ].sort((a, b) => a.start - b.start);
    for (const event of events) {
      if (++this.steps > 30_000) { if (this.steps === 30_001) this.issue({ file: env.file, start: event.start, range: { startLine: 1, endLine: 1 } }, 'fastapi-registration-limit', 'Static registration exceeded 30,000 steps'); return undefined; }
      const site: Site = { file: env.file, start: event.start, range: 'range' in event.item ? event.item.range : { startLine: 1, endLine: 1 } };
      if (event.kind === 'assignment') {
        if (event.item.augmentation) continue;
        const writes = syntax.writes.filter(write => write.scope === env.scope && write.name === event.item.name);
        if (writes.length !== 1 || event.item.conditions.length) continue;
        const value = this.evaluate(event.item.value, env, site);
        this.values.set(this.key(env, event.start), value);
        if (!env.scope && receiver(value) && value.type === 'app') value.exposed = true;
      } else if (event.kind === 'call') this.evaluate(event.item.expression, { ...env, conditions: [...env.conditions, ...event.item.conditions] }, site);
      else if (event.kind === 'return') {
        if (event.item.conditions.length || syntax.returns.filter(item => item.scope === env.scope).length !== 1) { this.issue(site, 'fastapi-dynamic-factory', 'Factory has conditional or multiple return paths'); return undefined; }
        return this.evaluate(event.item.value, env, site);
      } else {
        const definition = syntax.definitions.find(item => item.key === event.item.key);
        const handler = this.context.syntax!.get(env.file)!.declarations.get(event.item.key)!;
        const conditions = [...env.conditions, ...definition?.conditions ?? []];
        const decorators = definition?.decorators ?? [];
        // Decorators apply from bottom to top. A custom wrapper below a route
        // changes its registered callable, so preserve a gap rather than linking it.
        let wrapped = false, allRoutes = decorators.length > 0;
        for (const decorator of [...decorators].reverse()) {
          if (decorator.kind === 'call' && decorator.callee.kind === 'member') {
            const object = this.evaluate(decorator.callee.object, env, site);
            if (receiver(object) && (verbs.has(decorator.callee.name) || decorator.callee.name === 'api_route')) {
              this.register(object, decorator.callee.name, decorator.args, { ...env, conditions: [...conditions, ...(wrapped ? ['Custom decorator changes the registered handler'] : [])] }, site, wrapped ? undefined : handler);
              if (!wrapped) this.context.graph.entities.get(handler)!.metadata.framework = 'fastapi';
              continue;
            }
          }
          wrapped = true; allRoutes = false;
        }
        if (allRoutes) this.context.graph.entities.get(handler)!.metadata.pythonCallable = true;
      }
    }
    return undefined;
  }
  private evaluate(expression: PythonExpression, env: Environment, site: Site): Value {
    if (++this.steps > 30_000) return undefined;
    if (expression.kind === 'literal') return expression.value;
    if (expression.kind === 'sequence') return expression.items.map(item => this.evaluate(item, env, site));
    if (expression.kind === 'name' && env.parameters.has(expression.name)) return env.parameters.get(expression.name);
    if (expression.kind === 'name' || expression.kind === 'member') {
      const value = this.symbols.resolve(env.file, expression, env.scope, site.start);
      if (value.kind !== 'value') {
        if (expression.kind === 'member' && expression.name === 'router') { const object = this.evaluate(expression.object, env, site); if (receiver(object) && object.type === 'app') return object; }
        return value;
      }
      const local = value.file === env.file && value.assignment.scope === env.scope ? env : { file: value.file, scope: value.assignment.scope, instance: value.file, parameters: new Map(), conditions: [], stack: env.stack };
      const key = this.key(local, value.assignment.start);
      if (this.values.has(key)) { const cached = this.values.get(key); if (receiver(cached)) this.mutations(cached, expression, env, site); return cached; }
      if (!local.scope && this.moduleStates.get(value.file) !== 'running') this.module(value.file);
      if (this.values.has(key)) return this.values.get(key);
      if (this.active.has(key)) return undefined;
      this.active.add(key); const result = this.evaluate(value.assignment.value, local, { file: value.file, start: value.assignment.start, range: value.assignment.range }); this.active.delete(key); this.values.set(key, result); return result;
    }
    if (expression.kind !== 'call') return undefined;
    const callable = this.symbols.resolve(env.file, expression.callee, env.scope, site.start);
    if (callable.kind === 'external' && ['fastapi.FastAPI', 'fastapi.applications.FastAPI', 'fastapi.APIRouter', 'fastapi.routing.APIRouter'].includes(callable.name)) {
      const key = this.key(env, site.start);
      const existing = this.values.get(key); if (receiver(existing)) return existing;
      const type = callable.name.endsWith('.FastAPI') ? 'app' : 'router';
      const prefixValue = type === 'router' ? this.read(expression.args, 'prefix', env, site) : undefined, prefix = typeof prefixValue === 'string' ? prefixValue : '';
      const conditions = [...env.conditions, ...this.options(expression.args, ['routes', 'route_class', 'default', 'dependency_overrides_provider'], site)];
      if (type === 'router' && this.argument(expression.args, 'prefix') && typeof prefixValue !== 'string' || prefix && (!prefix.startsWith('/') || prefix.endsWith('/'))) conditions.push('Router prefix is dynamic or invalid');
      const rootPath = this.read(expression.args, 'root_path', env, site);
      if (rootPath) conditions.push('External proxy root_path requires an explicit deployment profile');
      const dependencies = this.dependencies(this.argument(expression.args, 'dependencies'), env, site, conditions, new Set(), true);
      const ordinalKey = JSON.stringify([env.file, env.scope ? env.instance : '', type]), ordinal = this.ordinals.get(ordinalKey) ?? 0; this.ordinals.set(ordinalKey, ordinal + 1);
      const value: Receiver = { kind: 'receiver', type, profile: this.profile(site.file), id: this.context.graph.id('router', 'fastapi', ordinalKey, String(ordinal)), site, prefix, conditions, dependencies, entries: [], exposed: false };
      this.receivers.push(value); this.values.set(key, value); return value;
    }
    if (expression.callee.kind === 'member') {
      const object = this.evaluate(expression.callee.object, env, site), method = expression.callee.name;
      if (receiver(object)) {
        if (method === 'include_router') {
          const child = this.read(expression.args, 'router', env, site, 0), prefixValue = this.read(expression.args, 'prefix', env, site);
          const conditions = [...env.conditions, ...this.options(expression.args, ['route_class_override'], site)];
          if (!receiver(child) || child.type !== 'router') { this.issue(site, 'fastapi-unresolved-router', 'include_router target is not a proven APIRouter'); object.conditions.push('An included router is unresolved'); return undefined; }
          if (this.argument(expression.args, 'prefix') && typeof prefixValue !== 'string') conditions.push('Include prefix is dynamic');
          const prefix = typeof prefixValue === 'string' ? prefixValue : '';
          if (prefix && (!prefix.startsWith('/') || prefix.endsWith('/'))) conditions.push('Include prefix is invalid');
          const dependencies = this.dependencies(this.argument(expression.args, 'dependencies'), env, site, conditions, new Set(), true);
          const mount = { id: this.context.graph.id('mount', object.id, child.id, prefix, String(object.entries.length)), file: site.file, line: site.range.startLine, prefix };
          if (object.profile === 'unknown') { conditions.push('FastAPI version does not select inclusion semantics'); this.issue(site, 'fastapi-version-profile', 'include_router needs a reviewed FastAPI 0.115.x snapshot or 0.141.1+ within 0.141.x live profile'); }
          if (object.profile === 'snapshot') for (const entry of [...child.entries]) {
            if (entry.mount) continue; // 0.115 does not copy Starlette Mount routes.
            object.entries.push({ ...entry, path: prefix ? composeRoutePath(prefix, entry.path) : entry.path, dependencies: [...object.dependencies, ...dependencies, ...entry.dependencies], conditions: [...object.conditions, ...conditions, ...entry.conditions], mounts: [mount, ...entry.mounts] });
          }
          else object.entries.push({ site, path: prefix, methods: '*', dependencies: [...object.dependencies, ...dependencies], conditions: [...object.conditions, ...conditions], mounts: [mount], include: child });
        } else if (method === 'mount') {
          const child = this.read(expression.args, 'app', env, site, 1), path = this.read(expression.args, 'path', env, site, 0);
          if (receiver(child) && child.type === 'app') object.entries.push({ site, path: typeof path === 'string' ? path : '/', methods: '*', dependencies: [], conditions: [...env.conditions, ...(typeof path !== 'string' ? ['Dynamic subapplication mount path'] : [])], mounts: [], mount: child });
          else { this.issue(site, 'fastapi-unresolved-mount', 'Mounted ASGI target is not a proven FastAPI app'); object.conditions.push('Unknown mounted ASGI target competes with HTTP registrations'); }
        } else if (method === 'add_api_route') {
          const target = this.argument(expression.args, 'endpoint', 1), handler = target ? this.symbols.resolve(env.file, target, env.scope, site.start) : undefined;
          this.register(object, 'api_route', expression.args, env, site, handler?.kind === 'symbol' && this.symbols.callable(handler) ? handler.id : undefined);
        } else if (method === 'add_middleware') {
          const middleware = this.argument(expression.args, 'middleware_class', 0), value = middleware ? this.symbols.resolve(env.file, middleware, env.scope, site.start) : undefined;
          if (value?.kind === 'symbol') this.context.graph.relate(this.context.files.get(site.file)!.id, value.id, 'references', [this.fact(site, 'Declared application middleware')], { framework: 'fastapi', role: 'middleware' });
          this.issue(site, 'fastapi-middleware-execution', 'Middleware is declared; its request/response execution is not simulated');
        } else { this.issue(site, 'fastapi-runtime-registration', `Unsupported receiver operation ${method}`); object.conditions.push(`Runtime receiver operation ${method}`); }
        return undefined;
      }
    }
    if (callable.kind === 'symbol' && callable.declaration.kind === 'function' && this.symbols.callable(callable)) {
      if (env.stack.includes(callable.id) || env.stack.length >= 12) { this.issue(site, 'fastapi-factory-limit', 'Recursive or deep registration factory'); return undefined; }
      const definition = this.symbols.facts(callable.file)?.python?.definitions.find(item => item.key === callable.declaration.key);
      const supplied = definition && bindPythonArguments(definition, expression.args);
      if (!definition || !supplied) { this.issue(site, 'fastapi-factory-arguments', 'Factory arguments are missing, duplicate, expanded or incompatible with parameter kinds'); return undefined; }
      const parameters = new Map<string, Value>();
      for (const parameter of definition.parameters) {
        const argument = supplied.get(parameter.name);
        parameters.set(parameter.name, argument ? this.evaluate(argument, env, site) : parameter.default ? this.evaluate(parameter.default, { ...env, file: callable.file, scope: callable.declaration.parent }, { ...site, file: callable.file, start: callable.declaration.start }) : undefined);
      }
      const instanceKey = JSON.stringify(['factory', env.instance, callable.id]), ordinal = this.ordinals.get(instanceKey) ?? 0;
      this.ordinals.set(instanceKey, ordinal + 1);
      return this.execute({ file: callable.file, scope: callable.declaration.key, instance: `${env.instance}:${callable.id}:${ordinal}`, parameters, conditions: env.conditions, stack: [...env.stack, callable.id] });
    }
    return undefined;
  }
  private dependencies(expression: PythonExpression | undefined, env: Environment, site: Site, conditions: string[], seen = new Set<string>(), configuration = false): string[] {
    if (!expression) return [];
    if (++this.steps > 30_000 || seen.size >= 64) { conditions.push('Dependency expansion budget exceeded'); return []; }
    if (expression.kind === 'literal' && expression.value === null) return [];
    if (expression.kind === 'sequence') return expression.items.flatMap(item => this.dependencies(item, env, site, conditions, seen, configuration));
    if (expression.kind === 'subscript') {
      const annotation = this.symbols.resolve(env.file, expression.object, env.scope, site.start);
      if (annotation.kind === 'external' && ['typing.Annotated', 'typing_extensions.Annotated'].includes(annotation.name)) return expression.items.slice(1).flatMap(item => this.dependencies(item, env, site, conditions, seen));
      if (configuration) conditions.push('Dynamic dependency subscript');
      return [];
    }
    if (expression.kind === 'name') {
      const value = this.symbols.resolve(env.file, expression, env.scope, site.start);
      if (value.kind === 'value') {
        const key = JSON.stringify(['dependency-value', value.file, value.assignment.scope, value.assignment.name]);
        if (seen.has(key)) { conditions.push('Cyclic dependency value'); return []; }
        return this.dependencies(value.assignment.value, { ...env, file: value.file, scope: value.assignment.scope }, { file: value.file, start: value.assignment.start, range: value.assignment.range }, conditions, new Set([...seen, key]), configuration);
      }
      if (configuration) { conditions.push('Dependency configuration is unresolved'); this.issue(site, 'fastapi-unresolved-dependency', 'Dependency list is not statically bound'); }
    }
    if (expression.kind === 'call') {
      const helper = this.symbols.resolve(env.file, expression.callee, env.scope, site.start);
      if (helper.kind === 'external' && ['fastapi.Depends', 'fastapi.Security', 'fastapi.params.Depends', 'fastapi.params.Security'].includes(helper.name)) {
        const target = this.argument(expression.args, 'dependency', 0), value = target ? this.symbols.resolve(env.file, target, env.scope, site.start) : undefined;
        if (value?.kind === 'symbol' && this.symbols.callable(value)) {
          if (seen.has(value.id) || seen.size >= 32) return [value.id];
          seen.add(value.id); const definition = this.symbols.facts(value.file)?.python?.definitions.find(item => item.key === value.declaration.key);
          return [value.id, ...(definition?.parameters.flatMap(parameter => this.dependencies(parameter.default, { ...env, file: value.file, scope: value.declaration.parent }, { ...site, file: value.file, start: value.declaration.start }, conditions, seen)) ?? [])];
        }
        conditions.push('Dependency callable is unresolved'); this.issue(site, 'fastapi-unresolved-dependency', 'Depends/Security target is not one proven indexed callable');
      } else if (configuration) { conditions.push('Dynamic dependency configuration'); this.issue(site, 'fastapi-dynamic-dependency', 'Dependency configuration uses an unsupported call'); }
    }
    else if (expression.kind === 'unknown' && configuration) { conditions.push('Opaque dependency configuration'); this.issue(site, 'fastapi-dynamic-dependency', 'Dependency expression is outside the supported syntax subset'); }
    return [];
  }
  private register(object: Receiver, method: string, args: PythonArgument[], env: Environment, site: Site, handler?: string): void {
    const pathValue = this.read(args, 'path', env, site, 0), conditions = [...object.conditions, ...env.conditions, ...this.options(args, ['route_class_override', 'callbacks', 'openapi_extra'], site)];
    const path = typeof pathValue === 'string' ? pathValue : '/';
    if (typeof pathValue !== 'string') { conditions.push('Dynamic route path'); this.issue(site, 'fastapi-dynamic-path', 'Route path is not a statically bound string'); }
    let methods: string[] | '*' = [method.toUpperCase()];
    if (method === 'api_route') {
      const supplied = this.argument(args, 'methods'), values = this.read(args, 'methods', env, site);
      methods = !supplied || values === null ? ['GET'] : Array.isArray(values) && values.length && values.every(value => typeof value === 'string' && /^[A-Za-z]+$/.test(value)) ? [...new Set((values as string[]).map(value => value.toUpperCase()))].sort() : '*';
      if (methods === '*') conditions.push('Dynamic HTTP method set');
    }
    if (!handler) { conditions.push('Registered handler is unresolved'); this.issue(site, 'fastapi-unresolved-handler', 'Route handler is not one proven indexed declaration'); }
    const dependencies = [...object.dependencies, ...this.dependencies(this.argument(args, 'dependencies'), env, site, conditions, new Set(), true)];
    if (handler) {
      const entity = this.context.graph.entities.get(handler)!, parsed = this.context.syntax!.get(entity.path!)!, key = [...parsed.declarations].find(([, id]) => id === handler)?.[0];
      const declaration = parsed.facts.declarations.find(item => item.key === key), definition = parsed.facts.python?.definitions.find(item => item.key === key);
      if (declaration) for (const parameter of definition?.parameters ?? []) {
        const scope = declaration.parent, source = { file: entity.path!, start: declaration.start, range: declaration.range }, local = { ...env, file: entity.path!, scope };
        dependencies.push(...this.dependencies(parameter.default, local, source, conditions));
        // Annotated[T, Depends(f)] stores the helper in its syntax expression;
        // annotations are scanned only for proven Depends/Security calls.
        dependencies.push(...this.dependencies(parameter.annotation, local, source, conditions));
      }
    }
    const status = this.read(args, 'status_code', env, site);
    if (this.argument(args, 'status_code') && (typeof status !== 'number' || status < 100 || status > 599)) conditions.push('Dynamic response status');
    object.entries.push({ site, path: object.prefix ? composeRoutePath(object.prefix, path) : path, methods, handler, dependencies: [...new Set(dependencies)], conditions, mounts: [], status: typeof status === 'number' && status >= 100 && status <= 599 ? status : undefined });
  }
  private emit(root: Receiver, object: Receiver, prefix: string, mounts: RoutingContract['mounts'], conditions: string[], seen: Set<string>, inheritedDependencies: string[] = [], mountedApplication?: string): void {
    if (seen.has(object.id) || seen.size > 32) return;
    const next = new Set([...seen, object.id]);
    const application = this.context.files.get(root.site.file)?.application, parentId = application && this.context.applicationIds.get(application.name);
    if (!parentId) return;
    for (const [index, entry] of object.entries.entries()) {
      if (entry.include) {
        this.emit(root, entry.include, entry.path ? prefix ? composeRoutePath(prefix, entry.path) : entry.path : prefix, [...mounts, ...entry.mounts], [...conditions, ...entry.conditions, ...entry.include.conditions], next, [...inheritedDependencies, ...entry.dependencies], mountedApplication); continue;
      }
      if (entry.mount) {
        const mount = { id: this.context.graph.id('mount', object.id, entry.mount.id, entry.path, String(index)), file: entry.site.file, line: entry.site.range.startLine, prefix: entry.path };
        this.emit(root, entry.mount, prefix ? composeRoutePath(prefix, entry.path) : entry.path, [...mounts, mount], [...conditions, ...entry.conditions], next, [], entry.mount.id); continue;
      }
      const routePath = prefix ? composeRoutePath(prefix, entry.path) : entry.path, pattern = compileStarlettePath(routePath);
      const constraints = [...root.conditions, ...conditions, ...entry.conditions];
      if (constraints.some(item => /Dynamic route path|prefix is dynamic|mount path/.test(item))) { pattern.status = 'partial'; pattern.reason = 'Dynamic registration path'; pattern.alternatives = []; }
      const routing: RoutingContract = { version: 1, pattern, methods: entry.methods, executionContext: 'server', registration: { file: entry.site.file, line: entry.site.range.startLine, receiver: root.id }, mounts: [...mounts, ...entry.mounts], middleware: [], conditions: [...new Set(constraints)] };
      const facts = [this.fact(root.site, 'Proven FastAPI application instance'), this.fact(entry.site, 'Registered path operation'), ...routing.mounts.map(mount => evidence('framework', 'fastapi', mount.file, mount.line, `Router/subapplication registration ${mount.prefix}`))];
      const id = this.context.graph.id('endpoint', 'fastapi', parentId, root.id, object.id, routePath, JSON.stringify(entry.methods), entry.handler ?? '', String(index), JSON.stringify(routing.mounts.map(mount => mount.id)));
      const endpoint: Entity = this.context.graph.contain({ id, type: 'api_endpoint', name: `${entry.methods === '*' ? '*' : entry.methods[0]} ${routePath}`, path: entry.site.file, language: 'python', parentId, sourceRange: entry.site.range, metadata: { framework: 'fastapi', frameworkVersion: FASTAPI_VERSION, inclusionProfile: root.profile, method: entry.methods === '*' ? '*' : entry.methods[0], routePath, registration: 'registered', routing, ...(constraints.length || pattern.status === 'partial' ? { constraintsUnresolved: true } : {}), ...(mountedApplication ? { mountedApplication } : {}), ...(entry.status ? { statusCode: entry.status } : {}) }, evidence: facts });
      if (entry.handler) this.context.graph.relate(endpoint.id, entry.handler, 'handles', facts);
      for (const dependency of new Set([...inheritedDependencies, ...entry.dependencies])) {
        this.context.graph.relate(endpoint.id, dependency, 'references', facts, { framework: 'fastapi', role: 'dependency' });
        if (entry.handler) this.context.graph.relate(entry.handler, dependency, 'references', facts, { framework: 'fastapi', role: 'dependency' }, 'fastapi:dependency');
      }
    }
  }
}
