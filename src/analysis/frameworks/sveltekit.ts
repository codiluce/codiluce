import ts from 'typescript';
import path from 'node:path';
import type { Entity } from '../../core/graph.js';
import { declarationHashes, evidence } from '../../core/graph.js';
import { fileAnalysis } from '../facts.js';
import { sourcePath } from '../embedded/index.js';
import { runtimeReference } from '../languages/typescript-runtime.js';
import type { RoutingContract } from '../routes/contracts.js';
import { HTTP_METHODS } from '../../analyzers/ts-http.js';
import { nodeSite, sourceRange, type TypeScriptPackScope, type TypeScriptPackFile } from './typescript-pack.js';
import { unwrap, valueDeclaration } from './typescript-binding.js';
import { TypeScriptStatic, propertyName, profile } from './typescript-static.js';
import type { KitConfig } from './sveltekit-config.js';
import { kitPath, type KitPath } from './sveltekit-path.js';

type Callable = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration;
interface Module { frame: TypeScriptPackFile; directory: string; role: 'page' | 'layout' | 'server'; server: boolean; reset?: string; exports: Map<string, ts.Expression | Callable> }
interface View { file: string; directory: string; role: 'page' | 'layout'; reset?: string; component: Entity }

export function svelteKit(scope: TypeScriptPackScope, reader: TypeScriptStatic): void {
  for (const runtime of scope.services.projects) {
    const config = scope.services.sveltekit.get(runtime.project.id);
    if (!config?.valid || !config.routes || !scope.inputs?.some(file => runtime.inputs.some(input => input.path === file.path))) continue;
    if (!profile(runtime.project.dependencies.svelte, config.profile === 'sveltekit-3' ? 5 : 4) && !profile(runtime.project.dependencies.svelte, 5)) { scope.context.graph.diagnose({ analyzer: 'sveltekit', severity: 'warning', code: 'sveltekit-version-profile', file: runtime.project.manifest, reason: 'Kit routing requires a declared compatible Svelte dependency (v2: 4/5; v3: 5)' }); continue; }
    new KitRoutes(scope, reader, config).run();
  }
}
class KitRoutes {
  private readonly modules: Module[] = [];
  private readonly views: View[] = [];
  private readonly callableContexts = new Map<string, Set<string>>();
  private readonly eventFetch = new Map<string, { frame: TypeScriptPackFile; fn: Callable }>();
  constructor(private readonly scope: TypeScriptPackScope, private readonly reader: TypeScriptStatic, private readonly config: KitConfig) {}
  private gap(file: string, reason: string, code = 'sveltekit-route-gap', line = 1): void { this.scope.context.graph.diagnose({ analyzer: 'sveltekit', severity: 'warning', code, file, line, entityId: this.scope.context.files.get(file)?.id, reason }); }
  run(): void {
    const { context } = this.scope, prefix = `${this.config.routes}/`;
    for (const frame of this.scope.files) {
      if (frame.runtime.project.id !== this.config.project.id || frame.file.embedded || !frame.file.path.startsWith(prefix)) continue;
      const match = /^\+(page|layout)(\.server)?\.[jt]s$|^\+(server)\.[jt]s$/.exec(path.posix.basename(frame.file.path)); if (!match) continue;
      const role = (match[1] ?? match[3]) as Module['role'], server = role === 'server' || !!match[2];
      this.modules.push({ frame, directory: path.posix.relative(this.config.routes!, path.posix.dirname(frame.file.path)), role, server, exports: this.exports(frame) });
      this.stamp(frame.file.path); if (server) context.graph.entities.get(frame.file.id)!.metadata.executionContext = 'server';
    }
    for (const file of this.scope.inputs ?? []) {
      if (!file.path.startsWith(prefix) || context.projects?.nodeOwner(file.path).id !== this.config.project.id) continue;
      const match = /^\+(page|layout)(?:@([^/]*))?\.svelte$/.exec(path.posix.basename(file.path));
      const id = context.graph.entities.get(file.id)?.metadata.component, component = typeof id === 'string' && context.graph.entities.get(id);
      if (match && component) this.views.push({ file: file.path, directory: path.posix.relative(this.config.routes!, path.posix.dirname(file.path)), role: match[1] as View['role'], reset: match[2], component });
      else if (/^\+(?:page|layout|server)/.test(path.posix.basename(file.path)) && !this.modules.some(module => module.frame.file.path === file.path)) this.gap(file.path, 'Unavailable/unsupported Kit convention source is retained without inventing a handler');
    }
    const hooks = [...new Set(this.config.hooks)], global = [...this.config.conditions];
    for (const file of hooks) {
      this.stamp(file);
      const text = context.sources?.readFile(path.resolve(context.root, file));
      if (text === undefined) { global.push(`Unavailable hook ${file}`); continue; }
      const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
      if (source.statements.some(statement => ts.isExportDeclaration(statement) || ts.canHaveModifiers(statement) && ts.getModifiers(statement)?.some(item => item.kind === ts.SyntaxKind.ExportKeyword))) { global.push(`Hook dispatch/effects in ${file} require a hook summary`); this.gap(file, 'Hooks are recorded; reroute/handle/runtime dispatch requires a separate summary', 'sveltekit-hook-gap'); }
    }
    const collisions = new Map<string, number>();
    for (const directory of new Set([...this.views.filter(view => view.role === 'page').map(view => view.directory), ...this.modules.filter(module => module.role !== 'layout').map(module => module.directory)])) {
      const route = kitPath(directory, this.config.base ?? ''), signature = JSON.stringify(route.pattern.alternatives.map(parts => parts.map(part => part.kind === 'rest' ? { kind: 'rest' } : { kind: 'segment', parts: part.parts.map(value => value.kind === 'literal' ? value : { kind: 'parameter' }) })));
      if (route.pattern.status === 'exact') collisions.set(signature, (collisions.get(signature) ?? 0) + 1);
    }
    for (const directory of new Set([...this.views.filter(view => view.role === 'page').map(view => view.directory), ...this.modules.filter(module => module.role !== 'layout').map(module => module.directory)])) {
      const route = kitPath(directory, this.config.base ?? ''), conditions = [...global];
      if (this.config.base === undefined) conditions.push('Public base path unresolved');
      if (route.pattern.status === 'partial') conditions.push(route.pattern.reason!);
      const signature = JSON.stringify(route.pattern.alternatives.map(parts => parts.map(part => part.kind === 'rest' ? { kind: 'rest' } : { kind: 'segment', parts: part.parts.map(value => value.kind === 'literal' ? value : { kind: 'parameter' }) })));
      if ((collisions.get(signature) ?? 0) > 1) conditions.push('Multiple filesystem route IDs have the same public pattern');
      for (const matcher of route.matchers) { conditions.push(`Parameter matcher ${matcher} is not executed`); const source = [...context.files.values()].find(file => this.config.profile === 'sveltekit-2' ? file.path === `${this.config.params}/${matcher}.js` || file.path === `${this.config.params}/${matcher}.ts` : file.path === this.config.params || file.path === `${this.config.params}.js` || file.path === `${this.config.params}.ts`); this.gap(source?.path ?? this.config.project.manifest!, `Parameter matcher ${matcher} constrains ${route.path}; no runtime matcher is executed`, 'sveltekit-matcher-gap'); }
      const modules = this.modules.filter(module => module.directory === directory), pages = this.views.filter(view => view.directory === directory && view.role === 'page');
      const duplicated = modules.some(module => modules.filter(other => other.role === module.role && other.server === module.server).length > 1) || pages.length > 1;
      if (duplicated) conditions.push('Duplicate Kit convention modules');
      for (const module of modules) {
        const allowed = module.role === 'server' ? [...HTTP_METHODS, 'QUERY', 'fallback', 'prerender', 'trailingSlash', 'config', 'entries'] : ['load', 'ssr', 'csr', 'prerender', 'trailingSlash', 'config', 'entries', ...(module.role === 'page' && module.server ? ['actions'] : [])];
        for (const name of module.exports.keys()) if (!allowed.includes(name) && !name.startsWith('_')) { conditions.push(`Invalid ${module.role} export ${name}`); this.gap(module.frame.file.path, `Kit ${module.role} export ${name} is invalid; private helpers must use a leading underscore`, 'sveltekit-export-gap'); }
      }
      const pageModules = modules.filter(module => module.role === 'page'), servers = modules.filter(module => module.role === 'server');
      const layout = pages[0] ? this.layouts(pages[0], conditions) : { views: [], directories: new Set<string>() };
      const options = this.pageOptions(directory, pageModules, conditions, true, layout.directories);
      for (const page of pages) {
        const graph = context.graph, file = context.files.get(page.file)!, app = file.application, parentId = app && context.applicationIds.get(app.name);
        if (!parentId) { this.gap(page.file, 'Kit page has no runtime application ownership'); continue; }
        const fact = evidence('framework', 'sveltekit', page.file, 1, 'SvelteKit filesystem page registration');
        const entity = graph.contain({ id: graph.id('sveltekit-page', this.config.project.id, directory), type: 'route', name: route.path, path: page.file, language: 'svelte', parentId, sourceRange: page.component.sourceRange, metadata: { framework: 'sveltekit', profile: this.config.profile, routePath: route.path, routeId: `/${directory}`, registration: 'filesystem', groups: route.groups, parameterMatchers: route.matchers, options, executionContext: options.ssr === false ? 'browser' : options.csr === false ? 'server' : 'unknown', constraintsUnresolved: conditions.length > 0, conditions, hooks }, evidence: [fact] });
        graph.relate(entity.id, page.component.id, 'routes_to', [fact], { role: 'page' }); this.stamp(page.file);
        const directories = new Set([directory, ...layout.directories]);
        for (const ancestor of layout.views) graph.relate(entity.id, ancestor.component.id, 'routes_to', [evidence('framework', 'sveltekit', ancestor.file, 1, 'Ancestor SvelteKit layout wraps this page')], { role: 'layout' });
        for (const module of this.modules) if (directories.has(module.directory) && (module.role === 'layout' || module.role === 'page' && module.directory === directory)) {
          const load = this.callable(module.exports.get('load'), module.frame);
          if (load) { const execution = module.server ? 'server' : options.ssr === false ? 'browser' : options.csr === false ? 'server' : 'unknown', target = this.registeredTarget(module, this.handler(load.fn, load.frame, 'load', execution), 'load', execution); graph.relate(entity.id, target.id, 'routes_to', [this.reader.fact(load.fn, 'SvelteKit registered page/layout load')], { role: module.server ? 'server-load' : 'universal-load' }); this.eventFetch.set(nodeSite(load.fn), load); }
          else if (module.exports.has('load')) this.gap(module.frame.file.path, 'Dynamic load export cannot be bound to an indexed callable');
        }
      }
      for (const module of servers) {
        if (module.exports.has('QUERY')) this.gap(module.frame.file.path, 'QUERY handlers require the newer HTTP method profile; retained as an unsupported registration', 'sveltekit-method-gap');
        const methods = [...module.exports.keys()].filter(name => HTTP_METHODS.has(name)), serverConditions = [...conditions], serverOptions = this.pageOptions('', [module], serverConditions, false);
        for (const method of methods) {
          const handler = this.callable(module.exports.get(method), module.frame); if (!handler) { this.gap(module.frame.file.path, `Dynamic ${method} handler is unresolved`); continue; }
          const target = this.handler(handler.fn, handler.frame, method, 'server'), constraints = [...serverConditions];
          if (pages.length && ['GET', 'POST', 'HEAD'].includes(method)) constraints.push('Page/+server content negotiation depends on the Accept header');
          if (serverOptions.prerender === true && !['GET', 'HEAD', 'OPTIONS'].includes(method)) constraints.push('Prerendered route has a mutating handler');
          this.endpoint(module, route, method, target, handler.fn, constraints, undefined, method === 'GET' && !methods.includes('HEAD') ? ['GET', 'HEAD'] : [method]); this.eventFetch.set(nodeSite(handler.fn), handler);
        }
        if (module.exports.has('fallback')) {
          const handler = this.callable(module.exports.get('fallback'), module.frame);
          if (handler) { const target = this.handler(handler.fn, handler.frame, 'fallback', 'server'); this.endpoint(module, route, '*', target, handler.fn, conditions, undefined, '*', [...methods, ...(methods.includes('GET') ? ['HEAD'] : [])]); this.eventFetch.set(nodeSite(handler.fn), handler); }
          else this.gap(module.frame.file.path, 'Dynamic fallback handler is unresolved');
        }
      }
      for (const module of pageModules.filter(module => module.server && module.exports.has('actions'))) {
        const value = module.exports.get('actions'), fields = value && !ts.isFunctionLike(value) ? this.reader.object(value as ts.Expression, module.frame.state.checker) : undefined;
        if (!fields) { this.gap(module.frame.file.path, 'Actions require an indexed immutable static object', 'sveltekit-action-gap'); continue; }
        if (fields.has('default') && fields.size > 1) { this.gap(module.frame.file.path, 'Default and named SvelteKit actions cannot coexist', 'sveltekit-action-gap'); continue; }
        for (const [name, value] of fields) {
          if (!/^[A-Za-z_]\w*$/.test(name)) { this.gap(module.frame.file.path, `Unsupported action name ${name}`, 'sveltekit-action-gap'); continue; }
          const handler = this.callable(value, module.frame); if (!handler) { this.gap(module.frame.file.path, `Dynamic action ${name} is unresolved`, 'sveltekit-action-gap'); continue; }
          const target = this.handler(handler.fn, handler.frame, `${name} action`, 'server'), constraints = [...conditions];
          if (handler.frame.file.application?.name === module.frame.file.application?.name) target.metadata.serverAction = true;
          if (!pages.length) constraints.push('Actions without an indexed +page component are not qualified');
          if (options.prerender === true) constraints.push('SvelteKit actions cannot be prerendered');
          if (servers.some(server => server.exports.has('POST'))) constraints.push('Page action/+server POST content negotiation is unresolved');
          this.endpoint(module, route, 'POST', target, handler.fn, constraints, name); this.eventFetch.set(nodeSite(handler.fn), handler);
        }
      }
      if (conditions.length) this.gap(pages[0]?.file ?? modules[0]!.frame.file.path, conditions.join('; '));
    }
    for (const registered of this.eventFetch.values()) this.fetches(registered.fn, registered.frame);
  }
  private stamp(file: string): void {
    const input = this.scope.context.files.get(file), entity = input && this.scope.context.graph.entities.get(input.id); if (!entity) return;
    entity.metadata.frameworkPacks = [...new Set([...(entity.metadata.frameworkPacks as string[] | undefined ?? []), 'sveltekit'])];
    const analysis = fileAnalysis(entity.metadata.analysis); if (analysis && analysis.features.framework.status !== 'failed') analysis.features.framework = { status: 'partial', reason: 'SvelteKit 2/3 static filesystem registrations; dynamic config/hooks/matchers are diagnosed' };
  }
  private exports(frame: TypeScriptPackFile): Map<string, ts.Expression | Callable> {
    const checker = frame.state.checker, symbol = checker.getSymbolAtLocation(frame.source), result = new Map<string, ts.Expression | Callable>();
    if (!symbol) return result;
    for (let item of checker.getExportsOfModule(symbol)) {
      const name = item.name, declaration = item.valueDeclaration ?? item.declarations?.[0];
      if (!runtimeReference(frame.source, checker, name)) continue;
      if (declaration && ts.isExportSpecifier(declaration) && (declaration.isTypeOnly || (ts.isExportDeclaration(declaration.parent.parent) && declaration.parent.parent.isTypeOnly))) continue;
      if (item.flags & ts.SymbolFlags.Alias) item = checker.getAliasedSymbol(item);
      const value = item.valueDeclaration ?? item.declarations?.[0];
      if (value && ts.isVariableDeclaration(value) && value.initializer && ts.isIdentifier(value.name) && runtimeReference(value.name, checker)) result.set(name, value.name);
      else if (value && ts.isFunctionDeclaration(value) && value.body) result.set(name, value);
    }
    return result;
  }
  private callable(value: ts.Expression | Callable | undefined, frame: TypeScriptPackFile, seen = new Set<string>()): { fn: Callable; frame: TypeScriptPackFile } | undefined {
    if (!value || seen.size > 20) return undefined;
    let node: ts.Node = value;
    if (!ts.isFunctionLike(node)) {
      node = unwrap(value as ts.Expression); if (!runtimeReference(node as ts.Expression, frame.state.checker)) return undefined;
      const declaration = valueDeclaration(node as ts.Expression, frame.state.checker);
      if (declaration) { const site = nodeSite(declaration); if (seen.has(site) || this.reader.writes.has(site)) return undefined; seen.add(site);
        if (ts.isFunctionDeclaration(declaration)) node = declaration;
        else if (ts.isVariableDeclaration(declaration) && declaration.initializer && ts.isVariableDeclarationList(declaration.parent) && declaration.parent.flags & ts.NodeFlags.Const) node = declaration.initializer;
        else if (ts.isPropertyAssignment(declaration)) node = declaration.initializer;
        else return undefined;
      }
    }
    if (!ts.isFunctionDeclaration(node) && !ts.isArrowFunction(node) && !ts.isFunctionExpression(node) && !ts.isMethodDeclaration(node)) return node === value ? undefined : this.callable(node as ts.Expression, frame, seen);
    const file = sourcePath(this.scope.context, node.getSourceFile().fileName), owner = this.scope.files.find(candidate => candidate.file.path === file && !candidate.file.embedded);
    if (!owner || !node.body || this.reader.writes.has(nodeSite(node))) return undefined;
    const site = nodeSite(node); let original: Callable | undefined;
    const visit = (candidate: ts.Node): void => { if (nodeSite(candidate) === site && (ts.isFunctionDeclaration(candidate) || ts.isFunctionExpression(candidate) || ts.isArrowFunction(candidate) || ts.isMethodDeclaration(candidate))) original = candidate; else if (!original) ts.forEachChild(candidate, visit); }; visit(owner.source);
    return original ? { fn: original, frame: owner } : undefined;
  }
  private handler(fn: Callable, frame: TypeScriptPackFile, name: string, execution: string): Entity {
    const graph = this.scope.context.graph, existing = this.scope.services.declarations.get(fn);
    const entity = existing ?? graph.contain({ id: graph.id('sveltekit-handler', this.config.project.id, frame.file.path, name, fn.getText().replace(/\s+/g, ' ')), type: 'function', name, path: frame.file.path, language: frame.file.language, parentId: frame.file.id, sourceRange: sourceRange(fn), metadata: { role: 'handler', qualifiedName: name, ...declarationHashes(fn.getText(), 0) }, evidence: [this.reader.fact(fn, 'Original registered SvelteKit callback')] });
    const contexts = this.callableContexts.get(entity.id) ?? new Set<string>(); contexts.add(execution); this.callableContexts.set(entity.id, contexts);
    entity.metadata.framework = 'sveltekit'; if (frame.file.application?.name === this.config.project.application?.name) entity.metadata.executionContext = contexts.size === 1 ? execution : 'unknown';
    const site = nodeSite(fn), visit = (node: ts.Node): void => { if (nodeSite(node) === site) { frame.owners.set(node, entity); this.scope.services.declarations.set(node, entity); } else ts.forEachChild(node, visit); }; visit(frame.source);
    this.scope.services.declarations.set(fn, entity); return entity;
  }
  private registeredTarget(module: Module, target: Entity, name: string, execution: string): Entity {
    const { context } = this.scope, application = module.frame.file.application;
    if (!application || context.files.get(target.path ?? '')?.application?.name === application.name) return target;
    const invocation = context.graph.contain({ id: context.graph.id('sveltekit-invocation', application.name, module.frame.file.path, name, target.id), type: 'function', name: `${name} invocation`, path: target.path, language: target.language, parentId: module.frame.file.id, sourceRange: target.sourceRange, metadata: { framework: 'sveltekit', role: 'handler', svelteKitInvocation: true, registeredTarget: target.id, executionApplication: application.name, executionContext: execution, registrationFile: module.frame.file.path, qualifiedName: `${application.name}.${name}.invocation` }, evidence: [evidence('framework', 'sveltekit', module.frame.file.path, 1, 'This Kit registration supplies application/execution context to the original imported callable'), ...target.evidence] });
    context.graph.relate(invocation.id, target.id, 'calls', invocation.evidence, { role: 'framework-invocation' }); return invocation;
  }
  private endpoint(module: Module, route: KitPath, method: string, target: Entity, fn: Callable, conditions: string[], action?: string, methods: string[] | '*' = [method], excludedMethods?: string[]): void {
    const { context } = this.scope, app = module.frame.file.application, parentId = app && context.applicationIds.get(app.name); if (!parentId) { this.gap(module.frame.file.path, 'Kit handler has no runtime application ownership'); return; }
    const range = sourceRange(fn), fact = this.reader.fact(fn, action ? `SvelteKit POST form action ${action}; selected on the page URL` : `SvelteKit exported ${method} HTTP handler`);
    const routing: RoutingContract = { version: 1, pattern: route.pattern, methods, ...(excludedMethods ? { excludedMethods } : {}), executionContext: 'server', registration: { file: module.frame.file.path, line: range.startLine, receiver: 'SvelteKit filesystem' }, mounts: [], middleware: [], conditions, ...(action ? { action: { name: action } } : {}) };
    const entity = context.graph.contain({ id: context.graph.id('sveltekit-endpoint', this.config.project.id, module.directory, method, action ?? ''), type: 'api_endpoint', name: `${method} ${route.path}${action && action !== 'default' ? `?/${action}` : ''}`, path: module.frame.file.path, language: module.frame.file.language, parentId, sourceRange: range, metadata: { framework: 'sveltekit', profile: this.config.profile, method, routePath: route.path, routeId: `/${module.directory}`, registration: 'filesystem', routing, groups: route.groups, parameterMatchers: route.matchers, executionContext: 'server', constraintsUnresolved: conditions.length > 0 || route.pattern.status === 'partial', ...(action ? { operationKind: 'form-action', actionName: action } : {}) }, evidence: [fact] });
    const registered = this.registeredTarget(module, target, action ? `${action} action` : method, 'server');
    context.graph.relate(entity.id, registered.id, 'routes_to', [fact], { role: action ? 'form-action' : 'handler' });
  }
  private ancestor(parent: string, child: string): boolean { return !parent || parent === child || child.startsWith(`${parent}/`); }
  private layouts(page: View, conditions: string[]): { views: View[]; directories: Set<string> } {
    let directory = page.directory;
    const candidates = new Set([...this.views.filter(view => view.role === 'layout').map(view => view.directory), ...this.modules.filter(module => module.role === 'layout').map(module => module.directory)]), directories = new Set<string>(), result: View[] = [];
    const pending = [...candidates].filter(value => this.ancestor(value, directory)).sort((a, b) => b.length - a.length);
    const jump = (target: string): string | undefined => target === '' ? '' : directory.split('/').map((_, i, parts) => parts.slice(0, i + 1).join('/')).reverse().find(value => path.posix.basename(value) === target);
    if (page.reset !== undefined) { const target = jump(page.reset); if (target === undefined) { conditions.push('Unresolved +page layout reset'); return { views: [], directories }; } directory = target; }
    for (const candidate of pending) {
      if (!this.ancestor(candidate, directory)) continue; directories.add(candidate);
      const views = this.views.filter(view => view.role === 'layout' && view.directory === candidate); result.push(...views);
      if (views.length > 1) conditions.push('Duplicate Kit layout components');
      const reset = views[0]?.reset;
      if (reset !== undefined) { directory = candidate; const target = jump(reset); if (target === undefined || target === directory && target !== '') { conditions.push('Unresolved/cyclic +layout reset'); break; } directory = target!; }
    }
    return { views: result, directories };
  }
  private pageOptions(directory: string, pages: Module[], conditions: string[], inherit = true, directories?: Set<string>): Record<string, unknown> {
    const options: Record<string, unknown> = {};
    const precedence = (a: Module, b: Module) => this.config.profile === 'sveltekit-3' ? Number(b.server) - Number(a.server) : Number(a.server) - Number(b.server);
    const ancestors = inherit ? this.modules.filter(module => module.role === 'layout' && this.ancestor(module.directory, directory) && (!directories || directories.has(module.directory))).sort((a, b) => a.directory.length - b.directory.length || precedence(a, b)) : [];
    for (const module of [...ancestors, ...pages.sort(precedence)]) for (const key of ['ssr', 'csr', 'prerender', 'trailingSlash']) {
      const value = module.exports.get(key); if (!value || ts.isFunctionLike(value)) continue;
      const literal = this.reader.resolve(value as ts.Expression, module.frame.state.checker);
      if (literal?.kind === ts.SyntaxKind.TrueKeyword) options[key] = true; else if (literal?.kind === ts.SyntaxKind.FalseKeyword) options[key] = false; else if (literal && ts.isStringLiteralLike(literal) && (key === 'prerender' && literal.text === 'auto' || key === 'trailingSlash' && ['always', 'never', 'ignore'].includes(literal.text))) options[key] = literal.text; else { options[key] = 'unknown'; conditions.push(`Dynamic ${key} option`); }
    }
    if (options.ssr === false && options.csr === false) conditions.push('Both SSR and CSR disabled'); return options;
  }
  private fetches(fn: Callable, frame: TypeScriptPackFile): void {
    const parameter = fn.parameters[0]; if (!parameter) return;
    const checker = frame.state.checker, fetchBindings = new Set<string>(), eventBindings = new Set<string>();
    if (ts.isIdentifier(parameter.name)) eventBindings.add(nodeSite(parameter));
    else if (ts.isObjectBindingPattern(parameter.name)) for (const element of parameter.name.elements) if (!element.dotDotDotToken && (element.propertyName ? propertyName(element.propertyName) : ts.isIdentifier(element.name) ? element.name.text : undefined) === 'fetch' && ts.isIdentifier(element.name) && !element.initializer) fetchBindings.add(nodeSite(element));
    const mutated = new Set<string>();
    const writes = (node: ts.Node): void => { if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) { const declaration = valueDeclaration(node.left, checker); if (declaration) mutated.add(nodeSite(declaration)); if (ts.isPropertyAccessExpression(node.left)) { const root = valueDeclaration(node.left.expression, checker); if (root) mutated.add(nodeSite(root)); } } ts.forEachChild(node, writes); }; if (fn.body) writes(fn.body);
    const kind = (expression: ts.Expression, seen = new Set<string>()): 'fetch' | 'event' | undefined => {
      expression = unwrap(expression); const declaration = valueDeclaration(expression, checker), site = declaration && nodeSite(declaration);
      if (site && (seen.has(site) || mutated.has(site) || this.reader.writes.has(site))) return undefined;
      if (site && fetchBindings.has(site)) return 'fetch'; if (site && eventBindings.has(site)) return 'event';
      if (site) seen.add(site);
      if (ts.isPropertyAccessExpression(expression) && expression.name.text === 'fetch' && kind(expression.expression, seen) === 'event') return 'fetch';
      if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer && ts.isVariableDeclarationList(declaration.parent) && declaration.parent.flags & ts.NodeFlags.Const) return kind(declaration.initializer, seen);
      if (declaration && ts.isBindingElement(declaration) && ts.isObjectBindingPattern(declaration.parent) && (declaration.propertyName ? propertyName(declaration.propertyName) : ts.isIdentifier(declaration.name) ? declaration.name.text : undefined) === 'fetch' && ts.isVariableDeclaration(declaration.parent.parent) && declaration.parent.parent.initializer && kind(declaration.parent.parent.initializer, seen) === 'event') return 'fetch';
      return undefined;
    };
    const escapes = (node: ts.Node): void => { if (ts.isCallExpression(node) && node.arguments.some(argument => kind(argument) === 'event')) for (const site of eventBindings) mutated.add(site); ts.forEachChild(node, escapes); }; if (fn.body) escapes(fn.body);
    const visit = (node: ts.Node): void => { if (ts.isCallExpression(node) && kind(node.expression) === 'fetch') frame.adoptHttp({ node, client: 'fetch', url: node.arguments[0], options: node.arguments[1], via: 'SvelteKit RequestEvent.fetch', transport: 'sveltekit-fetch' }); ts.forEachChild(node, visit); }; if (fn.body) visit(fn.body);
  }
}
