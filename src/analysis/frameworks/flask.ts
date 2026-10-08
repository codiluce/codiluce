import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { subset, validRange } from 'semver';
import type { AnalysisContext } from '../../core/analyzer.js';
import { evidence, type Evidence, type SourceRange } from '../../core/graph.js';
import { fileAnalysis, type PythonArgument, type PythonExpression } from '../facts.js';
import { IndexedSources } from '../indexed-sources.js';
import { PythonSymbols, type PythonBound } from '../languages/python-symbols.js';
import { bindPythonArguments } from '../languages/python-arguments.js';
import { compileWerkzeugPath, composeRoutePath, type RoutingContract } from '../routes/contracts.js';

export const FLASK_VERSION = '1.0.0';
interface Site { file: string; start: number; range: SourceRange }
interface Environment { file: string; scope?: string; application?: string; instance: string; parameters: Map<string, Value>; conditions: string[]; stack: string[] }
interface View { kind: 'view'; name?: string; handler?: string; dispatch?: Map<string, string>; methods?: string[] | '*'; conditions: string[] }
interface Entry { site: Site; path: string; methods: string[] | '*'; view?: View; endpoint?: string; conditions: string[]; mounts: RoutingContract['mounts']; strict: boolean; automaticOptions: boolean; explicitAuto: boolean; unresolvedPath: boolean; resource?: boolean }
interface Include { child: Receiver; prefix: string; name: string; site: Site; conditions: string[] }
interface Hook { handler: string; role: string; site: Site; blueprint?: string }
interface Receiver { kind: 'receiver'; type: 'app' | 'blueprint'; id: string; name: string; site: Site; prefix: string; conditions: string[]; entries: Entry[]; includes: Include[]; views: Map<string, View>; hooks: Hook[]; exposed: boolean; applications: Set<string>; entrypoints: Map<string, string>; sealed: boolean; autoOptions: boolean | undefined; names: Set<string>; profile: 'flask-3.1' | 'unknown' }
type Value = Receiver | View | PythonBound | string | number | boolean | null | Value[] | undefined;
const receiver = (value: Value): value is Receiver => !!value && typeof value === 'object' && !Array.isArray(value) && value.kind === 'receiver';
const view = (value: Value): value is View => !!value && typeof value === 'object' && !Array.isArray(value) && value.kind === 'view';
const symbol = (value: Value): value is Extract<PythonBound, { kind: 'symbol' }> => !!value && typeof value === 'object' && !Array.isArray(value) && value.kind === 'symbol';
const verbs = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace']);
const hooks = new Set(['before_request', 'after_request', 'teardown_request', 'before_app_request', 'after_app_request', 'teardown_app_request', 'errorhandler', 'app_errorhandler']);

/** Bounded, indexed registration interpreter. It never imports Python, runs
 * target code or discovers factories by executing naming conventions. */
export class FlaskRegistrations {
  private readonly receivers: Receiver[] = [];
  private readonly modules = new Map<string, 'running' | 'done'>();
  private readonly values = new Map<string, Value>();
  private readonly active = new Set<string>();
  private readonly ordinals = new Map<string, number>();
  private readonly profiles = new Map<string, Receiver['profile']>();
  private readonly mountReceivers = new Map<string, Receiver>();
  private steps = 0;
  constructor(private readonly context: AnalysisContext, private readonly symbols: PythonSymbols) {}
  private fact(site: Site, explanation: string): Evidence { return { ...evidence('framework', 'flask', site.file, site.range.startLine, explanation), analyzerVersion: FLASK_VERSION }; }
  private issue(site: Site, code: string, reason: string): void { this.context.graph.diagnose({ analyzer: 'flask', severity: 'warning', code: `flask-${code}`, file: site.file, line: site.range.startLine, entityId: this.context.files.get(site.file)?.id, reason }); }
  private key(env: Environment, start: number): string { return JSON.stringify([env.file, env.scope ?? '', env.scope ? env.instance : 'module', start]); }
  private ordinal(key: string): number { const value = this.ordinals.get(key) ?? 0; this.ordinals.set(key, value + 1); return value; }
  private argument(args: PythonArgument[], name: string, index?: number): PythonExpression | undefined { return args.find(arg => arg.name === name)?.value ?? (index === undefined ? undefined : args.filter(arg => !arg.name && !arg.spread)[index]?.value); }
  private read(args: PythonArgument[], name: string, env: Environment, site: Site, index?: number): Value { const value = this.argument(args, name, index); return value ? this.evaluate(value, env, site) : undefined; }
  private options(args: PythonArgument[], names: string[], allowed?: string[], positional?: number): string[] { return [...(args.some(arg => arg.spread) ? ['Expanded registration arguments are unresolved'] : []), ...names.filter(name => !!this.argument(args, name)).map(name => `Custom ${name} requires a separate registration profile`), ...(allowed ? args.filter(arg => arg.name && !allowed.includes(arg.name)).map(arg => `Unsupported registration keyword ${arg.name}`) : []), ...(positional !== undefined && args.filter(arg => !arg.name && !arg.spread).length > positional ? ['Too many positional registration arguments'] : [])]; }
  private environment(file: string): Environment { return { file, application: this.context.files.get(file)?.application?.name, instance: file, parameters: new Map(), conditions: [], stack: [] }; }
  private profile(file: string): Receiver['profile'] {
    const root = this.symbols.resolver.owner(file)?.root ?? '.', cached = this.profiles.get(root); if (cached) return cached;
    const sources = this.context.sources ?? new IndexedSources(this.context), declarations: string[] = [];
    for (const input of this.context.files.values()) {
      if (!input.analyzable || path.posix.dirname(input.path) !== root) continue;
      try {
        if (/(?:^|\/)pyproject\.toml$/.test(input.path)) {
          const value = parseToml(sources.readText(input.path)) as any;
          declarations.push(...(Array.isArray(value.project?.dependencies) ? value.project.dependencies.filter((item: unknown): item is string => typeof item === 'string') : []));
          const poetry = value.tool?.poetry?.dependencies?.flask;
          if (typeof poetry === 'string') declarations.push(`flask${/^[~^<>=]/.test(poetry) ? poetry : `==${poetry}`}`);
        } else if (/(?:^|\/)requirements[\w.-]*\.txt$/.test(input.path)) declarations.push(...sources.readText(input.path).split(/\r?\n/));
      } catch { /* Invalid manifests cannot select a reviewed version. */ }
    }
    const ranges = declarations.map(item => /^\s*flask(?:\[[\w, -]+\])?\s*([^#]*)/i.exec(item)).filter(Boolean).map(match => /[!*@;]|~=/.test(match![1]!) ? undefined : validRange(match![1]!.trim().replace(/==/g, '').replace(/,/g, ' ')));
    const result = ranges.length && ranges.every(range => !!range && subset(range, '>=3.1.0 <3.2.0')) ? 'flask-3.1' : 'unknown';
    this.profiles.set(root, result); return result;
  }
  private module(file: string): void {
    if (this.modules.has(file)) return;
    this.modules.set(file, 'running'); this.execute(this.environment(file)); this.modules.set(file, 'done');
  }
  run(): void {
    if (![...this.context.syntax?.values() ?? []].some(parsed => parsed.facts.python?.imports.some(item => item.specifier === 'flask' || item.specifier.startsWith('flask.'))) && !this.context.config.applications.some(app => app.entrypoints?.flask?.length)) return;
    for (const file of [...this.context.files.values()].sort((a, b) => a.path.localeCompare(b.path, 'en'))) if (file.language === 'python' && file.path.endsWith('.py') && file.analyzable && !/(?:^|\/)(?:tests?|fixtures|__fixtures__|testdata)(?:\/|$)/.test(file.path)) this.module(file.path);
    for (const item of this.receivers) { for (const application of item.applications) if (this.context.config.applications.find(app => app.name === application)?.entrypoints?.flask?.length) item.applications.delete(application); item.exposed = item.applications.size > 0; }
    for (const app of this.context.config.applications) for (const entrypoint of app.entrypoints?.flask ?? []) this.entrypoint(app.name, entrypoint);
    for (const item of this.receivers) {
      const entity = this.context.graph.entities.get(this.context.files.get(item.site.file)!.id)!, analysis = fileAnalysis(entity.metadata.analysis);
      (entity.metadata.frameworkPacks as string[] | undefined) ??= [];
      if (!(entity.metadata.frameworkPacks as string[]).includes('flask')) (entity.metadata.frameworkPacks as string[]).push('flask');
      if (analysis) analysis.features.framework = { status: 'partial', reason: 'Proven static Flask/Blueprint registrations, nested/reused blueprint prefixes, indexed handlers and bounded invoked/configured factories; dynamic setup remains constrained' };
      (entity.metadata.registrations as unknown[] | undefined) ??= [];
      (entity.metadata.registrations as unknown[]).push({ version: 1, framework: 'flask', receiver: item.id, kind: item.type, profile: item.profile, exposed: item.exposed, applications: [...item.applications].sort(), prefix: item.prefix, sealed: item.sealed, routes: item.entries.map(entry => ({ path: entry.path, methods: entry.methods, endpoint: entry.endpoint, line: entry.site.range.startLine, conditions: entry.conditions })) });
      if (item.type === 'app' && item.exposed) for (const application of [...item.applications].sort()) this.emit(item, application);
    }
  }
  private entrypoint(application: string, specification: string): void {
    const candidates = [...this.context.files.values()].filter(file => file.language === 'python' && file.analyzable && file.application?.name === application), app = this.context.config.applications.find(app => app.name === application);
    const importer = candidates.find(file => this.symbols.resolver.owner(file.path)?.root === app?.path) ?? candidates[0];
    if (!importer) return;
    const [moduleName, attribute = 'create_app'] = specification.split(':'), selected = this.symbols.resolver.resolve(importer.path, moduleName!);
    const site: Site = { file: importer.path, start: Infinity, range: { startLine: 1, endLine: 1 } };
    if (selected.status !== 'resolved' || selected.modules.length !== 1 || !selected.modules[0]!.file) { this.issue(site, 'entrypoint-unresolved', `Configured entrypoint ${specification} is not one indexed Python module`); return; }
    const file = selected.modules[0]!.file!.path; this.module(file);
    const expression = attribute!.split('.').reduce<PythonExpression | undefined>((object, name) => object ? { kind: 'member', object, name } : { kind: 'name', name }, undefined)!;
    const env = { ...this.environment(file), application }, localSite = { ...site, file }, value = this.evaluate(expression, env, localSite);
    const result = symbol(value) && value.declaration.kind === 'function' ? this.evaluate({ kind: 'call', callee: expression, args: [] }, { ...env, instance: `entrypoint:${application}:${specification}` }, localSite) : value;
    if (receiver(result) && result.type === 'app') { result.exposed = true; result.applications.add(application); result.entrypoints.set(application, specification); }
    else this.issue(localSite, 'entrypoint-unresolved', `Configured entrypoint ${specification} did not select one bounded Flask application`);
  }
  private execute(env: Environment): Value {
    const facts = this.symbols.facts(env.file), syntax = facts?.python;
    if (!syntax || facts!.truncated || facts!.issues.length) return undefined;
    const events = [
      ...syntax.assignments.filter(item => item.scope === env.scope).map(item => ({ start: item.start, kind: 'assignment' as const, item })),
      ...facts!.declarations.filter(item => item.parent === env.scope).map(item => ({ start: item.start, kind: 'definition' as const, item })),
      ...syntax.calls.filter(item => item.scope === env.scope && item.standalone).map(item => ({ start: item.start, kind: 'call' as const, item })),
      ...syntax.returns.filter(item => item.scope === env.scope).map(item => ({ start: item.start, kind: 'return' as const, item })),
      ...syntax.writes.filter(item => item.scope === env.scope && (item.name.includes('.') || item.kind === 'mutation')).map(item => ({ start: item.start, kind: 'write' as const, item })),
    ].sort((a, b) => a.start - b.start);
    for (const event of events) {
      if (++this.steps > 30_000) { if (this.steps === 30_001) this.issue({ file: env.file, start: event.start, range: { startLine: 1, endLine: 1 } }, 'registration-limit', 'Static registration exceeded 30,000 steps'); return undefined; }
      const site: Site = { file: env.file, start: event.start, range: 'range' in event.item ? event.item.range : { startLine: 'line' in event.item ? event.item.line : 1, endLine: 'line' in event.item ? event.item.line : 1 } };
      if (event.kind === 'assignment') {
        if (event.item.augmentation) continue;
        if (syntax.writes.filter(write => write.scope === env.scope && write.name === event.item.name).length !== 1 || event.item.conditions.length) continue;
        const value = this.evaluate(event.item.value, env, site); this.values.set(this.key(env, event.start), value);
        if (!env.scope && receiver(value) && value.type === 'app' && env.application) { value.exposed = true; value.applications.add(env.application); }
      } else if (event.kind === 'call') this.evaluate(event.item.expression, { ...env, conditions: [...env.conditions, ...event.item.conditions] }, site);
      else if (event.kind === 'return') {
        if (event.item.conditions.length || syntax.returns.filter(item => item.scope === env.scope).length !== 1) { this.issue(site, 'dynamic-factory', 'Factory has conditional or multiple return paths'); return undefined; }
        return this.evaluate(event.item.value, env, site);
      } else if (event.kind === 'write') {
        const names = event.item.name.split('.');
        for (let length = names.length; length > 0; length--) {
          const expression = names.slice(0, length).reduce<PythonExpression | undefined>((object, name) => object ? { kind: 'member', object, name } : { kind: 'name', name }, undefined)!;
          const value = this.evaluate(expression, env, site); if (receiver(value)) { this.mutate(value, expression, env, site); break; }
        }
      } else {
        const definition = syntax.definitions.find(item => item.key === event.item.key), handler = this.context.syntax!.get(env.file)!.declarations.get(event.item.key)!;
        let wrapped = false, preserving = !!definition?.decorators.length;
        for (const decorator of [...definition?.decorators ?? []].reverse()) {
          const callee = decorator.kind === 'call' ? decorator.callee : decorator;
          if (callee.kind === 'member') {
            const object = this.evaluate(callee.object, env, site), method = callee.name;
            if (receiver(object) && (verbs.has(method) || ['route', 'endpoint'].includes(method) || hooks.has(method))) {
              if (!this.setup(object, site)) continue;
              const local = { ...env, conditions: [...env.conditions, ...definition?.conditions ?? [], ...(wrapped ? ['Custom decorator changes the registered view'] : [])] }, target: View = this.viewAttributes({ kind: 'view', name: event.item.name, handler: wrapped ? undefined : handler, conditions: [] }, handler, site);
              if (hooks.has(method)) { if (!wrapped) object.hooks.push({ handler, role: method, site }); }
              else if (method === 'endpoint') {
                const name = decorator.kind === 'call' ? this.read(decorator.args, 'endpoint', env, site, 0) : undefined;
                if (typeof name === 'string') this.bindView(object, name, target, site); else object.conditions.push('Dynamic endpoint binding');
              } else this.register(object, method, decorator.kind === 'call' ? decorator.args : [], local, site, target);
              if (!wrapped) this.context.graph.entities.get(handler)!.metadata.framework = 'flask';
              continue;
            }
          }
          wrapped = true; preserving = false;
        }
        if (preserving) this.context.graph.entities.get(handler)!.metadata.pythonCallable = true;
      }
    }
    return undefined;
  }
  private mutate(object: Receiver, expression: PythonExpression, env: Environment, site: Site): void {
    let head = expression; while (head.kind === 'member') head = head.object;
    if (head.kind !== 'name') return;
    const name = head.name;
    if (this.symbols.facts(env.file)?.python?.writes.some(write => write.scope === env.scope && (write.name.startsWith(`${name}.`) || write.kind === 'mutation' && write.name === name))) {
      const condition = 'Receiver routing/configuration attributes are mutated';
      if (!object.conditions.includes(condition)) { object.conditions.push(condition); this.issue(site, 'receiver-mutation', condition); }
    }
  }
  private evaluate(expression: PythonExpression, env: Environment, site: Site): Value {
    if (++this.steps > 30_000) return undefined;
    if (expression.kind === 'literal') return expression.value;
    if (expression.kind === 'sequence') return expression.items.map(item => this.evaluate(item, env, site));
    if (expression.kind === 'name' && env.parameters.has(expression.name)) { const value = env.parameters.get(expression.name); if (receiver(value)) this.mutate(value, expression, env, site); return value; }
    if (expression.kind === 'name' || expression.kind === 'member') {
      const selected = this.symbols.resolve(env.file, expression, env.scope, site.start);
      if (selected.kind !== 'value') return selected;
      const local = selected.file === env.file && selected.assignment.scope === env.scope ? env : { ...this.environment(selected.file), scope: selected.assignment.scope, stack: env.stack }, key = this.key(local, selected.assignment.start);
      if (!local.scope && this.modules.get(selected.file) !== 'running') this.module(selected.file);
      if (this.values.has(key)) { const cached = this.values.get(key); if (receiver(cached)) this.mutate(cached, expression, env, site); return cached; }
      if (this.active.has(key)) return undefined;
      this.active.add(key); const result = this.evaluate(selected.assignment.value, local, { file: selected.file, start: selected.assignment.start, range: selected.assignment.range }); this.active.delete(key); this.values.set(key, result); return result;
    }
    if (expression.kind !== 'call') return undefined;
    const callable = this.symbols.resolve(env.file, expression.callee, env.scope, site.start);
    if (callable.kind === 'external' && ['flask.Flask', 'flask.app.Flask', 'flask.Blueprint', 'flask.blueprints.Blueprint'].includes(callable.name)) {
      const key = this.key(env, site.start), existing = this.values.get(key); if (receiver(existing)) return existing;
      const type = callable.name.endsWith('.Flask') ? 'app' : 'blueprint', prefixValue = this.read(expression.args, 'url_prefix', env, site, type === 'blueprint' ? 4 : undefined), prefix = typeof prefixValue === 'string' ? prefixValue : '', name = this.read(expression.args, 'name', env, site, 0);
      const parameters = type === 'app' ? ['import_name', 'static_url_path', 'static_folder', 'static_host', 'host_matching', 'subdomain_matching', 'template_folder', 'instance_path', 'instance_relative_config', 'root_path'] : ['name', 'import_name', 'static_folder', 'static_url_path', 'url_prefix', 'subdomain', 'url_defaults', 'root_path', 'cli_group'];
      const conditions = [...env.conditions, ...this.options(expression.args, ['subdomain', 'host_matching', 'subdomain_matching', 'static_host', 'url_defaults'], parameters, parameters.length)];
      if (!this.argument(expression.args, 'import_name', type === 'app' ? 0 : 1)) conditions.push('Application/blueprint import_name is missing');
      if (type === 'blueprint' && (typeof name !== 'string' || !name || name.includes('.'))) conditions.push('Blueprint name is dynamic or invalid');
      if (type === 'blueprint' && this.argument(expression.args, 'url_prefix', 4) && prefixValue !== null && (typeof prefixValue !== 'string' || prefix && !prefix.startsWith('/'))) conditions.push('Blueprint prefix is dynamic or invalid');
      const identity = JSON.stringify([env.file, env.scope ? env.instance : '', type]), profile = this.profile(site.file);
      if (profile === 'unknown') { conditions.push('Flask version does not select the reviewed 3.1 registration profile'); this.issue(site, 'version-profile', conditions.at(-1)!); }
      const result: Receiver = { kind: 'receiver', type, id: this.context.graph.id('router', 'flask', identity, String(this.ordinal(identity))), name: typeof name === 'string' ? name : type, site, prefix, conditions, entries: [], includes: [], views: new Map(), hooks: [], exposed: false, applications: new Set(), entrypoints: new Map(), sealed: false, autoOptions: true, names: new Set(), profile };
      this.staticResource(result, expression.args, env, site);
      this.receivers.push(result); this.values.set(key, result); return result;
    }
    if (expression.callee.kind === 'member') {
      const object = this.evaluate(expression.callee.object, env, site), method = expression.callee.name;
      if (method === 'as_view' && symbol(object)) return this.classView(object, expression.args, env, site);
      if (receiver(object)) {
        if (method === 'register_blueprint') this.include(object, expression.args, env, site);
        else if (method === 'add_url_rule') this.register(object, method, expression.args, env, site, this.asView(this.read(expression.args, 'view_func', env, site, 2), site));
        else if (hooks.has(method) || method === 'teardown_appcontext' || method === 'register_error_handler') { const target = this.asView(this.read(expression.args, 'f', env, site, method === 'register_error_handler' ? 1 : 0), site); if (target?.handler && this.setup(object, site)) object.hooks.push({ handler: target.handler, role: method, site }); }
        else if (!['run', 'test_client', 'test_request_context', 'app_context'].includes(method)) { object.conditions.push(`Unsupported receiver operation ${method}`); this.issue(site, 'runtime-registration', `Unsupported receiver operation ${method}`); }
        return undefined;
      }
      if (expression.callee.object.kind === 'member' && expression.callee.object.name === 'config') {
        const app = this.evaluate(expression.callee.object.object, env, site);
        if (receiver(app)) {
          if (method === 'from_mapping' && !expression.args.some(arg => !arg.name || arg.spread)) {
            const auto = this.argument(expression.args, 'PROVIDE_AUTOMATIC_OPTIONS'), value = auto ? this.evaluate(auto, env, site) : undefined;
            if (auto) { app.autoOptions = typeof value === 'boolean' ? value : undefined; if (typeof value !== 'boolean') app.conditions.push('Dynamic automatic OPTIONS configuration'); }
          } else { app.conditions.push('Opaque application configuration can change routing'); this.issue(site, 'dynamic-config', 'Application configuration is not executed'); }
          return undefined;
        }
      }
    }
    if (callable.kind === 'symbol' && callable.declaration.kind === 'function' && this.symbols.callable(callable)) {
      if (env.stack.includes(callable.id) || env.stack.length >= 12) { this.issue(site, 'factory-limit', 'Recursive or deep registration factory'); this.opaqueArguments(expression.args, env, site); return undefined; }
      const definition = this.symbols.facts(callable.file)?.python?.definitions.find(item => item.key === callable.declaration.key);
      const supplied = definition && bindPythonArguments(definition, expression.args);
      if (!definition || !supplied) { this.issue(site, 'factory-arguments', 'Factory arguments are missing, duplicate, expanded or incompatible with parameter kinds'); this.opaqueArguments(expression.args, env, site); return undefined; }
      const parameters = new Map<string, Value>();
      for (const parameter of definition.parameters) {
        const argument = supplied.get(parameter.name);
        parameters.set(parameter.name, argument ? this.evaluate(argument, env, site) : this.evaluate(parameter.default!, { ...env, file: callable.file, scope: callable.declaration.parent }, { ...site, file: callable.file, start: callable.declaration.start }));
      }
      const identity = JSON.stringify(['factory', env.instance, callable.id]);
      return this.execute({ file: callable.file, scope: callable.declaration.key, application: env.application, instance: `${env.instance}:${callable.id}:${this.ordinal(identity)}`, parameters, conditions: env.conditions, stack: [...env.stack, callable.id] });
    }
    this.opaqueArguments(expression.args, env, site);
    return undefined;
  }
  private opaqueArguments(args: PythonArgument[], env: Environment, site: Site): void {
    for (const arg of args) {
      const value = this.evaluate(arg.value, env, site);
      if (receiver(value)) { value.conditions.push('Receiver is passed to an unreviewed callable'); this.issue(site, 'opaque-registration-call', 'Receiver is passed to an unreviewed callable that may change routing'); }
    }
  }
  private viewAttributes(target: View, id: string, site: Site): View {
    const attributes = this.symbols.attributeWrites(id);
    if (!attributes.length) return target;
    target.conditions.push('View attributes are mutated'); this.issue(site, 'view-mutation', target.conditions.at(-1)!);
    if (attributes.some(name => ['methods', 'required_methods', 'provide_automatic_options'].includes(name))) target.methods = '*';
    if (attributes.includes('provide_automatic_options')) target.handler = undefined;
    return target;
  }
  private asView(value: Value, site: Site): View | undefined {
    if (view(value)) return value;
    if (!symbol(value) || !this.symbols.callable(value)) return undefined;
    return this.viewAttributes({ kind: 'view', name: value.declaration.name, handler: value.id, conditions: [] }, value.id, site);
  }
  private classView(value: Extract<PythonBound, { kind: 'symbol' }>, args: PythonArgument[], env: Environment, site: Site): View | undefined {
    const facts = this.symbols.facts(value.file), definition = facts?.python?.definitions.find(item => item.key === value.declaration.key);
    if (value.declaration.kind !== 'class' || !definition || definition.bases.length !== 1) return undefined;
    const base = this.symbols.resolve(value.file, definition.bases[0]!, value.declaration.parent, value.declaration.start);
    if (base.kind !== 'external' || !['flask.views.MethodView', 'flask.views.View'].includes(base.name)) return undefined;
    const name = this.read(args, 'name', env, site, 0), conditions = [...env.conditions];
    if (typeof name !== 'string') conditions.push('Dynamic class-view name');
    const mutated = this.symbols.attributeWrites(value.id).length > 0;
    if (definition.decorators.length || definition.conditions.length || args.some(arg => arg.spread) || mutated) conditions.push('Custom or mutated class-view construction');
    const members = facts!.declarations.filter(item => item.parent === value.declaration.key), assignments = facts!.python!.assignments.filter(item => item.scope === value.declaration.key), dispatch = new Map<string, string>();
    if (members.some(item => item.name === 'as_view') || assignments.some(item => item.name === 'as_view')) return { kind: 'view', name: typeof name === 'string' ? name : undefined, methods: '*', conditions: [...conditions, 'Class overrides framework as_view'] };
    for (const member of members) if (verbs.has(member.name) && ['function', 'method'].includes(member.kind)) {
      const id = this.context.syntax!.get(value.file)!.declarations.get(member.key)!;
      if (facts!.python!.writes.filter(write => write.scope === value.declaration.key && write.name === member.name).length === 1 && !facts!.python!.definitions.find(item => item.key === member.key)?.conditions.length && this.symbols.callable({ kind: 'symbol', file: value.file, declaration: member, id })) dispatch.set(member.name.toUpperCase(), id); else conditions.push(`Class-view ${member.name} is wrapped or overwritten`);
    }
    const attribute = (name: string): PythonExpression | undefined => assignments.filter(item => item.name === name).length === 1 ? assignments.find(item => item.name === name)!.value : undefined;
    const customAttributes = assignments.some(item => ['decorators', 'provide_automatic_options', 'required_methods'].includes(item.name)) || members.some(item => item.name === '__init__');
    if (customAttributes) { conditions.push('Custom class-view attributes or initialization'); dispatch.clear(); }
    const configured = attribute('methods'), methodsValue = configured ? this.evaluate(configured, { ...env, file: value.file, scope: value.declaration.key }, { ...site, file: value.file, start: Infinity }) : undefined;
    let methods: View['methods'] = configured ? this.methodSet(methodsValue) : base.name.endsWith('.MethodView') ? [...dispatch.keys()] : ['GET'];
    if (mutated || customAttributes || definition.decorators.length || definition.conditions.length) { methods = '*'; dispatch.clear(); }
    if (configured && methods === '*') conditions.push('Dynamic class-view method set');
    const override = members.find(item => item.name === 'dispatch_request'), generic = base.name.endsWith('.View') && !base.name.endsWith('.MethodView');
    if (override) {
      const id = this.context.syntax!.get(value.file)!.declarations.get(override.key)!;
      if (generic && !mutated && !customAttributes && !definition.decorators.length && !definition.conditions.length && this.symbols.callable({ kind: 'symbol', file: value.file, declaration: override, id })) return { kind: 'view', name: typeof name === 'string' ? name : undefined, handler: id, methods, conditions };
      conditions.push('Custom MethodView dispatch_request'); dispatch.clear();
    }
    if (!dispatch.size || generic) conditions.push('Class-view dispatch is unresolved');
    return { kind: 'view', name: typeof name === 'string' ? name : undefined, dispatch, methods, conditions };
  }
  private methodSet(value: Value): string[] | '*' { return Array.isArray(value) && value.length > 0 && value.every(item => typeof item === 'string' && /^[A-Za-z]+$/.test(item)) ? [...new Set((value as string[]).map(item => item.toUpperCase()))] : '*'; }
  private staticResource(object: Receiver, args: PythonArgument[], env: Environment, site: Site): void {
    const folderExpression = this.argument(args, 'static_folder', 2), folder = folderExpression ? this.evaluate(folderExpression, env, site) : object.type === 'app' ? 'static' : null;
    if (folder === null || folder === '') return;
    const urlExpression = this.argument(args, 'static_url_path', object.type === 'app' ? 1 : 3), url = urlExpression ? this.evaluate(urlExpression, env, site) : null;
    const prefix = typeof url === 'string' ? url : typeof folder === 'string' ? `/${path.posix.basename(folder.replace(/\/$/, ''))}` : undefined;
    const valid = typeof prefix === 'string' && prefix.startsWith('/') && !prefix.includes('\\'), conditions = ['Framework static-file response; filesystem/request execution is not simulated'];
    if (!valid || urlExpression && url !== null && typeof url !== 'string') conditions.push('Dynamic static-resource path');
    object.entries.push({ site, path: valid ? `${prefix!.replace(/\/$/, '')}/<path:filename>` : '/', methods: ['GET', 'HEAD'], endpoint: 'static', conditions, mounts: [], strict: true, automaticOptions: true, explicitAuto: false, unresolvedPath: !valid || !!urlExpression && url !== null && typeof url !== 'string', resource: true });
  }
  private setup(object: Receiver, site: Site): boolean {
    if (!object.sealed) return true;
    object.conditions.push('Blueprint setup changed after application registration'); this.issue(site, 'late-blueprint-setup', 'Flask rejects blueprint setup after its first application registration'); return false;
  }
  private bindView(object: Receiver, name: string, target: View, site: Site): void {
    const previous = object.views.get(name);
    if (previous && (previous.handler !== target.handler || previous.dispatch !== target.dispatch)) { object.conditions.push(`Endpoint ${name} is bound to multiple views`); this.issue(site, 'endpoint-collision', `Endpoint ${name} is bound to multiple views`); }
    else object.views.set(name, target);
  }
  private register(object: Receiver, method: string, args: PythonArgument[], env: Environment, site: Site, target?: View): void {
    if (!this.setup(object, site)) return;
    const allowed = ['rule', 'endpoint', 'methods', 'provide_automatic_options', 'strict_slashes', 'host', 'subdomain', 'defaults', 'redirect_to', 'alias', 'build_only', 'websocket', 'merge_slashes', ...(method === 'add_url_rule' ? ['view_func'] : [])];
    const pathValue = this.read(args, 'rule', env, site, 0), path = typeof pathValue === 'string' ? pathValue : '/', conditions = [...object.conditions, ...env.conditions, ...target?.conditions ?? [], ...this.options(args, ['host', 'subdomain', 'defaults', 'redirect_to', 'alias', 'build_only', 'websocket', 'merge_slashes'], allowed, method === 'add_url_rule' ? 4 : 1)];
    if (target && ['redirect_to', 'build_only', 'websocket'].some(name => !!this.argument(args, name))) target = { ...target, handler: undefined, dispatch: undefined };
    if (typeof pathValue !== 'string') { conditions.push('Dynamic route path'); this.issue(site, 'dynamic-path', 'Route rule is not a statically bound string'); }
    const endpointValue = this.read(args, 'endpoint', env, site, method === 'add_url_rule' ? 1 : undefined), endpoint = typeof endpointValue === 'string' ? endpointValue : target?.name;
    if (this.argument(args, 'endpoint', method === 'add_url_rule' ? 1 : undefined) && endpointValue !== null && typeof endpointValue !== 'string') conditions.push('Dynamic endpoint name');
    if (object.type === 'blueprint' && endpoint?.includes('.')) conditions.push('Blueprint endpoint contains an invalid dot');
    if (endpoint && target) this.bindView(object, endpoint, target, site);
    const supplied = this.argument(args, 'methods'), methodsValue = this.read(args, 'methods', env, site);
    let methods: string[] | '*' = verbs.has(method) ? [method.toUpperCase()] : supplied && methodsValue !== null ? this.methodSet(methodsValue) : target?.methods ?? (target && !target.handler && !target.dispatch?.size || method === 'add_url_rule' && !!this.argument(args, 'view_func', 2) && !target ? '*' : ['GET']);
    if (verbs.has(method) && supplied) conditions.push('Method shortcut cannot also supply methods');
    if (methods === '*') conditions.push('Dynamic HTTP method set');
    else if (methods.includes('GET') && !methods.includes('HEAD')) methods = [...methods, 'HEAD'];
    const autoExpression = this.argument(args, 'provide_automatic_options', method === 'add_url_rule' ? 3 : undefined), auto = autoExpression ? this.evaluate(autoExpression, env, site) : undefined;
    if (autoExpression && auto !== null && typeof auto !== 'boolean') conditions.push('Dynamic automatic OPTIONS setting');
    const automaticOptions = methods !== '*' && (auto === true ? methods.includes('OPTIONS') : auto === false ? false : !methods.includes('OPTIONS') && object.autoOptions !== false);
    if (automaticOptions && methods !== '*') methods = methods.filter(method => method !== 'OPTIONS');
    const strictExpression = this.argument(args, 'strict_slashes'), strict = strictExpression ? this.evaluate(strictExpression, env, site) : true;
    if (typeof strict !== 'boolean') conditions.push('Dynamic strict_slashes setting');
    object.entries.push({ site, path, methods, endpoint, view: target, conditions, mounts: [], strict: strict !== false, automaticOptions, explicitAuto: auto === true, unresolvedPath: typeof pathValue !== 'string' });
  }
  private include(object: Receiver, args: PythonArgument[], env: Environment, site: Site): void {
    if (!this.setup(object, site)) return;
    const child = this.read(args, 'blueprint', env, site, 0);
    if (!receiver(child) || child.type !== 'blueprint') { object.conditions.push('An included blueprint is unresolved'); this.issue(site, 'unresolved-blueprint', 'register_blueprint target is not a proven Blueprint'); return; }
    const suppliedPrefix = this.read(args, 'url_prefix', env, site), suppliedName = this.read(args, 'name', env, site), namePrefix = this.read(args, 'name_prefix', env, site), prefix = typeof suppliedPrefix === 'string' ? suppliedPrefix : child.prefix, name = `${typeof namePrefix === 'string' && namePrefix ? `${namePrefix}.` : ''}${typeof suppliedName === 'string' ? suppliedName : child.name}`;
    const conditions = [...env.conditions, ...this.options(args, ['subdomain', 'url_defaults'])];
    if (this.argument(args, 'url_prefix') && suppliedPrefix !== null && typeof suppliedPrefix !== 'string' || prefix && !prefix.startsWith('/')) conditions.push('Blueprint registration prefix is dynamic or invalid');
    if (this.argument(args, 'name') && (typeof suppliedName !== 'string' || !suppliedName || suppliedName.includes('.')) || this.argument(args, 'name_prefix') && typeof namePrefix !== 'string') conditions.push('Dynamic or invalid blueprint registration name');
    const include = { child, prefix, name, site, conditions };
    if (object.type === 'blueprint') object.includes.push(include); else this.materialize(object, include, '', '', [], [], new Set());
  }
  private materialize(root: Receiver, include: Include, parentPrefix: string, parentName: string, mounts: RoutingContract['mounts'], conditions: string[], seen: Set<string>): void {
    const child = include.child;
    if (seen.has(child.id) || seen.size >= 32) { root.conditions.push('Cyclic or deep blueprint registration'); this.issue(include.site, 'blueprint-cycle', 'Cyclic or deep blueprint registration'); return; }
    const name = parentName ? `${parentName}.${include.name}` : include.name, prefix = parentPrefix ? include.prefix ? composeRoutePath(parentPrefix, include.prefix) : parentPrefix : include.prefix;
    if (root.names.has(name)) { root.conditions.push(`Blueprint registration name ${name} is reused`); this.issue(include.site, 'blueprint-name-collision', `Blueprint registration name ${name} is reused`); return; }
    root.names.add(name); child.sealed = true;
    const mount = { id: this.context.graph.id('mount', root.id, child.id, name, prefix, String(root.entries.length), String(root.names.size)), file: include.site.file, line: include.site.range.startLine, prefix }, allMounts = [...mounts, mount], allConditions = [...conditions, ...include.conditions, ...child.conditions];
    this.mountReceivers.set(mount.id, child);
    for (const entry of child.entries) {
      const endpoint = entry.endpoint ? `${name}.${entry.endpoint}` : undefined, target = entry.view ?? (entry.endpoint ? child.views.get(entry.endpoint) : undefined);
      if (endpoint && target) this.bindView(root, endpoint, target, entry.site);
      root.entries.push({ ...entry, endpoint, view: target, path: prefix ? composeRoutePath(prefix, entry.path) : entry.path, mounts: [...allMounts, ...entry.mounts], conditions: [...allConditions, ...entry.conditions], automaticOptions: entry.automaticOptions && (entry.explicitAuto || root.autoOptions !== false) });
    }
    root.hooks.push(...child.hooks.map(hook => ({ ...hook, ...(!hook.role.includes('app_') ? { blueprint: child.id } : {}) })));
    for (const nested of child.includes) this.materialize(root, nested, prefix, name, allMounts, allConditions, new Set([...seen, child.id]));
  }
  private emit(root: Receiver, application: string): void {
    const parentId = this.context.applicationIds.get(application), entrypoint = root.entrypoints.get(application); if (!parentId) return;
    for (const [index, entry] of root.entries.entries()) {
      const target = entry.view ?? (entry.endpoint ? root.views.get(entry.endpoint) : undefined), constraints = [...root.conditions, ...entry.conditions, ...target?.conditions ?? []];
      for (const mount of entry.mounts) constraints.push(...this.mountReceivers.get(mount.id)?.conditions ?? []);
      if (!target?.handler && !target?.dispatch?.size) { constraints.push('Registered view is unresolved'); this.issue(entry.site, 'unresolved-handler', 'Route view is not one proven indexed callable or MethodView dispatch'); }
      const pattern = compileWerkzeugPath(entry.path, entry.strict);
      if (entry.unresolvedPath || constraints.some(item => /prefix is dynamic|prefix is dynamic or invalid/.test(item))) { pattern.status = 'partial'; pattern.reason = 'Dynamic registration path'; pattern.alternatives = []; }
      const groups: { methods: string[] | '*'; handler?: string; automatic?: boolean }[] = [];
      if (target?.dispatch && entry.methods !== '*') for (const method of entry.methods) groups.push({ methods: [method], handler: target.dispatch.get(method) ?? (method === 'HEAD' ? target.dispatch.get('GET') : undefined) });
      else if (entry.methods === '*' || entry.methods.length) groups.push({ methods: entry.methods, handler: target?.handler });
      if (entry.automaticOptions) groups.push({ methods: ['OPTIONS'], automatic: true });
      for (const group of groups) {
        const conditions = [...constraints, ...(!group.automatic && !group.handler ? ['Method dispatch is unresolved'] : [])], method = group.methods === '*' ? '*' : group.methods[0]!;
        const routing: RoutingContract = { version: 1, pattern, methods: group.methods, executionContext: 'server', registration: { file: entry.site.file, line: entry.site.range.startLine, receiver: root.id }, mounts: entry.mounts, middleware: [], conditions: [...new Set(conditions)] };
        const facts = [this.fact(root.site, entrypoint ? `Configured Flask entrypoint ${entrypoint}; proven application instance` : 'Proven Flask application instance'), this.fact(entry.site, group.automatic ? 'Framework automatic OPTIONS response' : 'Registered Flask view rule'), ...entry.mounts.map(mount => this.fact({ file: mount.file, start: 0, range: { startLine: mount.line, endLine: mount.line } }, `Blueprint registration ${mount.prefix}`))];
        const id = this.context.graph.id('endpoint', 'flask', parentId, root.id, entry.path, JSON.stringify(group.methods), group.handler ?? '', String(index), JSON.stringify(entry.mounts.map(mount => mount.id)));
        this.context.graph.contain({ id, type: 'api_endpoint', name: `${method} ${entry.path}`, path: entry.site.file, language: 'python', parentId, sourceRange: entry.site.range, metadata: { framework: 'flask', frameworkVersion: FLASK_VERSION, registrationProfile: root.profile, method, routePath: entry.path, endpointName: entry.endpoint, registration: 'registered', routing, ...(entrypoint ? { configuredEntrypoint: entrypoint } : {}), ...(entry.resource ? { frameworkResource: true } : {}), ...(conditions.length || pattern.status === 'partial' ? { constraintsUnresolved: true } : {}), ...(group.automatic ? { automaticResponse: true, statusCode: 200 } : {}) }, evidence: facts });
        if (group.handler) this.context.graph.relate(id, group.handler, 'handles', facts);
        for (const hook of root.hooks) if (!hook.blueprint || entry.mounts.some(mount => this.mountReceivers.get(mount.id)?.id === hook.blueprint)) this.context.graph.relate(id, hook.handler, 'references', [this.fact(hook.site, `Declared ${hook.role} hook; execution is not simulated`)], { framework: 'flask', role: hook.role });
      }
    }
  }
}
