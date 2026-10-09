import ts from 'typescript';
import path from 'node:path';
import { declarationHashes, evidence, type Entity } from '../../core/graph.js';
import { fileAnalysis } from '../facts.js';
import { sourceMapped } from '../embedded/index.js';
import { SourceText } from '../source-map.js';
import { runtimeReference } from '../languages/typescript-runtime.js';
import type { RoutingContract } from '../routes/contracts.js';
import { nodeSite, sourceRange, type TypeScriptFrameworkPack, type TypeScriptPackScope, type TypeScriptPackFile } from './typescript-pack.js';
import { TypeScriptStatic, propertyName } from './typescript-static.js';
import { unwrap, valueDeclaration } from './typescript-binding.js';
import { nuxtApi, nuxtName, nuxtKebab } from './nuxt-conventions.js';
import type { NuxtConfig } from './nuxt-config.js';
import { nuxtPath } from './nuxt-path.js';
import { vueTemplateSites } from './vue-template.js';

type Callable = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration;
interface Bound { fn: Callable; frame: TypeScriptPackFile }
export const nuxtPack: TypeScriptFrameworkPack = {
  id: 'nuxt', version: '1.0.0', includeEmbedded: true,
  applies: scope => !!scope.inputs?.some(file => scope.services.nuxt.has(scope.context.projects!.nodeOwner(file.path).id)),
  declare(scope): void {
    const reader = new TypeScriptStatic(scope, 'nuxt', ['h3', 'nuxt', 'nuxt/app', 'nuxt/config']);
    for (const config of scope.services.nuxt.values()) if (config.valid && scope.inputs?.some(file => scope.context.projects!.nodeOwner(file.path).id === config.project.id)) new NuxtRoutes(scope, reader, config).run();
    nuxtHttp(scope, reader);
  },
};
class NuxtRoutes {
  constructor(private readonly scope: TypeScriptPackScope, private readonly reader: TypeScriptStatic, private readonly config: NuxtConfig) {}
  private gap(file: string, reason: string, code = 'nuxt-route-gap'): void { this.scope.context.graph.diagnose({ analyzer: 'nuxt', severity: 'warning', code, file, line: 1, entityId: this.scope.context.files.get(file)?.id, reason }); }
  private stamp(file: string): void { const input = this.scope.context.files.get(file), entity = input && this.scope.context.graph.entities.get(input.id); if (!entity) return; entity.metadata.frameworkPacks = [...new Set([...(entity.metadata.frameworkPacks as string[] | undefined ?? []), 'nuxt'])]; const analysis = fileAnalysis(entity.metadata.analysis); if (analysis && analysis.features.framework.status !== 'failed') analysis.features.framework = { status: 'partial', reason: 'Nuxt 3/4 indexed filesystem conventions; runtime modules, layers and generated exports remain constrained' }; }
  private component(file: string): Entity | undefined { const input = this.scope.context.files.get(file), id = input && this.scope.context.graph.entities.get(input.id)?.metadata.component, value = typeof id === 'string' && this.scope.context.graph.entities.get(id); return value && ['vue-3', 'vue-3-common'].includes(String(value.metadata.profile)) ? value : undefined; }
  run(): void { this.pages(); this.servers(); }
  private builtins(file: string, name: string): { line: number; tag: string }[] {
    const input = this.scope.context.files.get(file), text = input && this.scope.context.sources?.readFile(input.absolutePath); if (!text) return [];
    const facts = this.scope.context.embedded?.facts.get(file), result: { line: number; tag: string }[] = [], source = new SourceText(text);
    for (const template of facts?.templates ?? []) for (const site of vueTemplateSites(text, template.start, template.end)) if (site.kind === 'component' && [name, name.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase()].includes(site.name!) && !site.locals.includes(site.name!)) {
      // An explicit setup binding overrides the built-in template component.
      const frames = this.scope.files.filter(frame => frame.file.path === file && frame.file.embedded?.role === 'setup');
      const blocked = frames.some(frame => frame.source.statements.some(statement => sourceMapped(this.scope.context, frame.source.fileName, statement.getStart(frame.source), statement.end) && (ts.isImportDeclaration(statement) && !!statement.importClause && [statement.importClause.name?.text, ...(statement.importClause.namedBindings && ts.isNamedImports(statement.importClause.namedBindings) ? statement.importClause.namedBindings.elements.map(item => item.name.text) : [])].includes(name) || ts.isVariableStatement(statement) && statement.declarationList.declarations.some(item => item.name.getText() === name) || ts.isFunctionDeclaration(statement) && statement.name?.text === name)));
      if (!blocked) result.push({ line: source.position(site.start).line, tag: text.slice(site.start, site.end) });
    }
    return result;
  }
  private meta(file: string, constraints: string[]): Map<string, ts.Expression | ts.MethodDeclaration> {
    const result = new Map<string, ts.Expression | ts.MethodDeclaration>(); let calls = 0;
    for (const frame of this.scope.files.filter(frame => frame.file.path === file && frame.file.embedded?.role === 'setup')) for (const statement of frame.source.statements) if (ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression) && ts.isIdentifier(statement.expression.expression) && statement.expression.expression.text === 'definePageMeta') {
      if (!nuxtApi(this.scope, frame, statement.expression.expression, 'definePageMeta', [])) { constraints.push('Unqualified/shadowed page macro requires a compiler registration summary'); continue; }
      calls++; const fields = statement.expression.arguments.length === 1 && this.reader.object(statement.expression.arguments[0], frame.state.checker);
      if (!fields) constraints.push('Dynamic definePageMeta registration'); else for (const [key, value] of fields) result.set(key, value);
    }
    if (calls > 1) constraints.push('Multiple definePageMeta calls');
    for (const key of ['middleware', 'validate', 'alias', 'redirect', 'pageTransition', 'layoutTransition', 'name', 'key']) if (result.has(key)) constraints.push(`Page meta ${key} requires a runtime/navigation summary`);
    return result;
  }
  private pages(): void {
    if (!this.config.pages) return;
    const { context } = this.scope, graph = context.graph, files = (this.scope.inputs ?? []).filter(file => file.language === 'vue' && file.path.startsWith(`${this.config.pages}/`) && context.projects!.nodeOwner(file.path).id === this.config.project.id);
    const appCandidates = ['app.vue', 'App.vue'].map(name => path.posix.join(this.config.src, name)).filter(file => context.files.has(file));
    const appRoot = appCandidates.length === 1 ? appCandidates[0] : undefined, shared = [...this.config.conditions];
    if (appCandidates.length > 1) shared.push('Conflicting app.vue/App.vue roots');
    if (appRoot && !this.builtins(appRoot, 'NuxtPage').length) shared.push('Custom app root has no proven NuxtPage outlet');
    const layoutOutlets = appRoot ? this.builtins(appRoot, 'NuxtLayout') : [{ line: 1, tag: '<NuxtLayout>' }];
    const layouts = new Map<string, string[]>();
    for (const file of this.scope.inputs ?? []) if (file.language === 'vue' && file.path.startsWith(`${this.config.layouts}/`) && context.projects!.nodeOwner(file.path).id === this.config.project.id) { const name = nuxtKebab(nuxtName(file.path.slice(this.config.layouts.length + 1))); layouts.set(name, [...layouts.get(name) ?? [], file.path]); }
    const patterns = new Map(files.map(file => [file.path, nuxtPath(file.path.slice(String(this.config.pages).length + 1), this.config.base)]));
    const collision = new Map<string, number>(); for (const pattern of patterns.values()) if (pattern) collision.set(pattern.original, (collision.get(pattern.original) ?? 0) + 1);
    for (const file of files) {
      let pattern = patterns.get(file.path); const component = this.component(file.path), app = file.application && context.applicationIds.get(file.application.name); if (!pattern || !component || !app) continue;
      const conditions = [...shared]; if (pattern.status === 'partial') conditions.push(pattern.reason!);
      const samePath = files.filter(other => patterns.get(other.path)?.original === pattern!.original);
      if (collision.get(pattern.original)! > 1 && !samePath.every(other => other.path === file.path || path.posix.basename(other.path) === 'index.vue' && `${path.posix.dirname(other.path)}.vue` === file.path && this.builtins(file.path, 'NuxtPage').length || path.posix.basename(file.path) === 'index.vue' && `${path.posix.dirname(file.path)}.vue` === other.path && this.builtins(other.path, 'NuxtPage').length)) conditions.push('Duplicate filesystem page URL; view precedence remains unknown');
      const ancestorFiles: string[] = []; let directory = path.posix.dirname(file.path);
      while (directory.startsWith(`${this.config.pages}/`)) { const parent = `${directory}.vue`; if (context.files.has(parent)) ancestorFiles.unshift(parent); directory = path.posix.dirname(directory); }
      const layoutTargets: { file: string; role: string; line: number }[] = [], mergedMeta = new Map<string, ts.Expression | ts.MethodDeclaration>();
      for (const ancestor of [...ancestorFiles, file.path]) { for (const [key, value] of this.meta(ancestor, conditions)) mergedMeta.set(key, value); if (ancestor !== file.path) { const outlets = this.builtins(ancestor, 'NuxtPage'); if (!outlets.length) conditions.push(`Nested page parent ${ancestor} has no proven NuxtPage outlet`); else layoutTargets.push({ file: ancestor, role: 'parent-view', line: outlets[0]!.line }); } }
      const pathMeta = mergedMeta.get('path');
      if (pathMeta && !ts.isMethodDeclaration(pathMeta)) { const frame = this.scope.files.find(item => item.source.fileName === pathMeta.getSourceFile().fileName), value = frame && this.reader.string(pathMeta, frame.state.checker); if (value?.startsWith('/') && !/[:*?#[\]\\]/.test(value)) pattern = nuxtPath(`${value.slice(1) || 'index'}.vue`, this.config.base)!; else conditions.push('Dynamic/custom Vue Router page path remains constrained'); }
      let layout: string | false = 'default'; const layoutMeta = mergedMeta.get('layout');
      if (layoutMeta && !ts.isMethodDeclaration(layoutMeta)) { const frame = this.scope.files.find(item => item.source.fileName === layoutMeta.getSourceFile().fileName), value = frame && this.reader.resolve(layoutMeta, frame.state.checker); if (value?.kind === ts.SyntaxKind.FalseKeyword) layout = false; else if (value && ts.isStringLiteralLike(value)) layout = value.text; else { layout = false; conditions.push('Dynamic page layout selection'); } }
      if (layoutOutlets.length > 1) { layout = false; conditions.push('Multiple NuxtLayout outlets require a render-context summary'); }
      else if (layoutOutlets[0]) {
        const tag = layoutOutlets[0].tag;
        if (/\b(?:v-bind:name|:name)\s*=/.test(tag)) { layout = false; conditions.push('Dynamic root NuxtLayout name overrides page meta'); }
        else { const name = /\bname\s*=\s*(["'])(.*?)\1/.exec(tag); if (name) layout = name[2]!; }
      }
      if (layout && layoutOutlets.length) {
        const candidates = layouts.get(layout) ?? [];
        if (candidates.length === 1) { const target = candidates[0]!; if (!this.component(target) || !this.builtins(target, 'slot').some(slot => !/\bname\s*=/.test(slot.tag) || /\bname\s*=\s*(["'])default\1/.test(slot.tag))) conditions.push(`Layout ${target} has no qualified default slot`); layoutTargets.unshift({ file: target, role: 'layout', line: 1 }); } else if (candidates.length > 1 || layout !== 'default') conditions.push(`Layout ${layout} has ${candidates.length} indexed convention candidates`);
      }
      if (appRoot) layoutTargets.unshift({ file: appRoot, role: 'app-root', line: this.builtins(appRoot, 'NuxtPage')[0]?.line ?? 1 });
      this.stamp(file.path);
      const fact = evidence('framework', 'nuxt', file.path, component.sourceRange?.startLine ?? 1, `Nuxt ${this.config.profile} indexed page convention; app base ${this.config.base || '/'}`);
      const page = graph.contain({ id: graph.id('nuxt-page', this.config.project.id, file.path), type: 'route', name: pattern.original, path: file.path, language: 'vue', parentId: app, sourceRange: component.sourceRange, metadata: { framework: 'nuxt', profile: this.config.profile, registration: 'filesystem', routePath: pattern.original, routePattern: pattern, operationKind: 'page', delivery: this.config.ssr ? 'universal' : 'browser', executionContext: this.config.ssr ? 'unknown' : 'browser', constraintsUnresolved: conditions.length > 0, conditions }, evidence: [fact] });
      graph.relate(page.id, component.id, 'routes_to', [fact], { role: 'view' });
      for (const [order, target] of layoutTargets.entries()) { const value = this.component(target.file); if (value) graph.relate(page.id, value.id, 'routes_to', [fact, evidence('framework', 'nuxt', target.file, target.line, `Original Nuxt ${target.role} convention/outlet`)], { role: 'layout', nuxtRole: target.role, order }); }
      if (conditions.length) this.gap(file.path, [...new Set(conditions)].join('; '));
    }
  }
  private defaultExport(frame: TypeScriptPackFile): ts.Node | undefined {
    const symbol = frame.state.checker.getSymbolAtLocation(frame.source); let item = symbol && frame.state.checker.getExportsOfModule(symbol).find(item => item.name === 'default');
    if (!item || !runtimeReference(frame.source, frame.state.checker, 'default')) return undefined;
    if (item.flags & ts.SymbolFlags.Alias) item = frame.state.checker.getAliasedSymbol(item);
    const value = item.valueDeclaration ?? item.declarations?.[0]; return value && ts.isVariableDeclaration(value) ? value.name : value;
  }
  private callable(value: ts.Node | undefined, frame: TypeScriptPackFile, seen = new Set<string>()): Bound | undefined {
    if (!value || seen.size > 20) return undefined; let node = value;
    if (ts.isExportAssignment(node)) node = node.expression;
    if (!ts.isFunctionLike(node)) {
      node = unwrap(node as ts.Expression); if (!runtimeReference(node as ts.Expression, frame.state.checker)) return undefined;
      const declaration = valueDeclaration(node as ts.Expression, frame.state.checker);
      if (declaration) { const site = nodeSite(declaration); if (seen.has(site) || this.reader.writes.has(site)) return undefined; seen.add(site); if (ts.isFunctionDeclaration(declaration)) node = declaration; else if (ts.isExportAssignment(declaration)) node = declaration.expression; else if (ts.isVariableDeclaration(declaration) && declaration.initializer && declaration.parent.flags & ts.NodeFlags.Const) node = unwrap(declaration.initializer); else return undefined; }
    }
    const owner = this.scope.files.find(item => item.source.fileName === node.getSourceFile().fileName); if (!owner) return undefined;
    if (ts.isCallExpression(node) && node.arguments.length === 1 && ['defineEventHandler', 'eventHandler'].some(name => nuxtApi(this.scope, owner, node.expression, name, ['h3']))) return this.callable(node.arguments[0], owner, seen);
    if (!ts.isFunctionDeclaration(node) && !ts.isFunctionExpression(node) && !ts.isArrowFunction(node) && !ts.isMethodDeclaration(node)) return node === value ? undefined : this.callable(node, owner, seen);
    if (!node.body || this.reader.writes.has(nodeSite(node))) return undefined;
    const site = nodeSite(node); let fn: Callable | undefined; const visit = (item: ts.Node): void => { if (nodeSite(item) === site && (ts.isFunctionDeclaration(item) || ts.isArrowFunction(item) || ts.isFunctionExpression(item) || ts.isMethodDeclaration(item))) fn = item; else if (!fn) ts.forEachChild(item, visit); }; visit(owner.source);
    return fn ? { fn, frame: owner } : undefined;
  }
  private handler(bound: Bound, name: string): Entity {
    const { fn, frame } = bound, graph = this.scope.context.graph;
    let identity = 'default'; for (let parent: ts.Node | undefined = fn.parent; parent && !ts.isSourceFile(parent); parent = parent.parent) if (ts.isVariableDeclaration(parent)) { identity = parent.name.getText(); break; }
    const entity = this.scope.services.declarations.get(fn) ?? graph.contain({ id: graph.id('nuxt-handler', frame.file.path, identity, fn.getText().replace(/\s+/g, ' ')), type: 'function', name, path: frame.file.path, language: frame.file.language, parentId: frame.owners.get(frame.source)?.id ?? frame.file.id, sourceRange: sourceRange(fn), metadata: { role: 'handler', qualifiedName: identity, ...declarationHashes(fn.getText(), 0) }, evidence: [this.reader.fact(fn, 'Original Nuxt/Nitro default handler callable')] });
    if (frame.file.path.startsWith(`${this.config.server}/`)) entity.metadata.executionContext = 'server';
    frame.owners.set(fn, entity); this.scope.services.declarations.set(fn, entity); return entity;
  }
  private servers(): void {
    if (!this.config.serverProfile) { this.gap(this.config.project.manifest ?? path.posix.join(this.config.project.root, 'package.json'), 'Server routes remain outside the selected Nitro 2/H3 1 profile', 'nuxt-server-profile-gap'); return; }
    const { context } = this.scope, conditions = [...this.config.conditions], middleware: string[] = [];
    const inputs = (this.scope.inputs ?? []).filter(file => context.projects!.nodeOwner(file.path).id === this.config.project.id && /\.[cm]?[jt]sx?$/.test(file.path) && !/\.d\.[cm]?[jt]s$/.test(file.path)), frames = new Map(this.scope.files.filter(frame => !frame.file.embedded).map(frame => [frame.file.path, frame]));
    for (const file of inputs.filter(file => file.path.startsWith(`${this.config.server}/middleware/`)).sort((a, b) => a.path.localeCompare(b.path))) { const frame = frames.get(file.path), bound = frame && this.callable(this.defaultExport(frame), frame); if (bound) middleware.push(this.handler(bound, 'middleware').id); conditions.push(`Server middleware ${file.path} can terminate/rewrite dispatch`); this.stamp(file.path); this.gap(file.path, 'Indexed server middleware order is retained; unavailable handlers/runtime policy remain constrained', 'nuxt-middleware-gap'); }
    const records = inputs.flatMap(file => {
      const api = file.path.startsWith(`${this.config.server}/api/`), routes = file.path.startsWith(`${this.config.server}/routes/`); if (!api && !routes) return [];
      const relative = file.path.slice(`${this.config.server}/${api ? 'api' : 'routes'}/`.length), pattern = nuxtPath(relative, `${this.config.base}${api ? '/api' : ''}`, true); if (!pattern) return [];
      const suffix = relative.replace(/\.[cm]?[jt]sx?$/, '').match(/(?:\.(connect|delete|get|head|options|patch|post|put|trace))?(?:\.(dev|prod|prerender))?$/)!;
      return [{ file, frame: frames.get(file.path), pattern, method: suffix[1]?.toUpperCase() ?? 'ALL', env: suffix[2] }];
    });
    for (const record of records) {
      const { file, frame, pattern, method, env } = record, constraints = [...conditions]; this.stamp(file.path);
      if (pattern.status === 'partial') constraints.push(pattern.reason!); if (env) constraints.push(`Environment-qualified ${env} handler; deployment environment is unknown`);
      const peers = records.filter(item => item.pattern.original === pattern.original && item.method === method); if (peers.length > 1) constraints.push('Duplicate method/path convention; dispatch precedence remains unresolved');
      const bound = frame && this.callable(this.defaultExport(frame), frame);
      const fact = evidence('framework', 'nuxt', file.path, 1, 'Nitro 2 filesystem route registered through Nuxt; H3 1 method semantics (no implicit GET-for-HEAD fallback)');
      const app = file.application && context.applicationIds.get(file.application.name); if (!app) continue;
      if (!bound) { constraints.push('Unresolved/type-only/mutable/lazy default handler'); this.gap(file.path, constraints.join('; '), 'nuxt-handler-gap'); }
      const target = bound && this.handler(bound, method), proof = bound && this.reader.fact(bound.fn, `Original ${method} server handler; registration at ${file.path}`);
      const routing: RoutingContract = { version: 1, pattern, methods: method === 'ALL' ? '*' : [method], ...(method === 'ALL' ? { excludedMethods: [...new Set(records.filter(item => item.pattern.original === pattern.original && item.method !== 'ALL' && !item.env).map(item => item.method))] } : {}), executionContext: 'server', registration: { file: file.path, line: 1, receiver: 'Nuxt/Nitro filesystem' }, mounts: [], middleware, conditions: constraints };
      const entity = context.graph.contain({ id: context.graph.id('nuxt-endpoint', this.config.project.id, file.path), type: 'api_endpoint', name: `${method} ${pattern.original}`, path: file.path, language: file.language, parentId: app, sourceRange: bound ? sourceRange(bound.fn) : { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 }, metadata: { framework: 'nuxt', profile: this.config.profile, serverProfile: this.config.serverProfile, registration: 'filesystem', routePath: pattern.original, method, operationKind: 'endpoint', executionContext: 'server', routing, constraintsUnresolved: constraints.length > 0 }, evidence: [fact, ...proof ? [proof] : []] });
      if (target && proof) context.graph.relate(entity.id, target.id, 'handles', [fact, proof], { role: 'handler', executionContext: 'server' });
      for (const [order, id] of middleware.entries()) context.graph.relate(entity.id, id, 'references', [fact], { role: 'middleware', order, executionContext: 'server' });
      if (constraints.length) this.gap(file.path, [...new Set(constraints)].join('; '));
    }
  }
}

function nuxtHttp(scope: TypeScriptPackScope, reader: TypeScriptStatic): void {
  for (const frame of scope.files) {
    const config = scope.services.nuxt.get(frame.runtime.project.id); if (!config?.valid) continue;
    const visit = (node: ts.Node): void => {
      if (!ts.isSourceFile(node) && !sourceMapped(scope.context, frame.source.fileName, node.getStart(frame.source), node.end)) return;
      if (ts.isCallExpression(node) && ['$fetch', 'useFetch', 'useLazyFetch'].some(name => nuxtApi(scope, frame, node.expression, name, ['nuxt/app', '#app']))) {
        const fields = node.arguments[1] && reader.object(node.arguments[1], frame.state.checker);
        const allowed = ['method', 'body', 'headers', 'credentials', 'signal', 'retry', 'retryDelay', 'retryStatusCodes', 'timeout', 'query', 'params', 'server', 'lazy', 'immediate', 'key', 'default', 'transform', 'pick', 'watch', 'deep', 'dedupe', 'getCachedData'];
        const composable = ['useFetch', 'useLazyFetch'].some(name => nuxtApi(scope, frame, node.expression, name, ['nuxt/app', '#app']));
        const reason = config.conditions.length ? 'Nuxt configuration/plugins can override the default fetch transport' : composable && frame.file.path.startsWith(`${config.server}/`) ? 'A Vue fetch composable in a Nitro handler requires a Nuxt application-context summary' : node.arguments.length > 2 || node.arguments.some(ts.isSpreadElement) || node.arguments[1] && (!fields || [...fields.keys()].some(key => !allowed.includes(key))) ? 'Custom/dynamic Nuxt fetch options require a transport summary' : undefined;
        frame.adoptHttp({ node, client: 'fetch', url: node.arguments[0], options: node.arguments[1], transport: 'nuxt-fetch', nuxtBase: config.base, via: 'Nuxt fetch', ...(reason ? { blocked: reason } : {}) }); reader.stamp(node, 'nuxt');
      }
      ts.forEachChild(node, visit);
    }; visit(frame.source);
  }
}
