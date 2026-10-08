import ts from 'typescript';
import path from 'node:path';
import { declarationHashes, evidence, type Entity, type EffectFact } from '../../core/graph.js';
import { fileAnalysis } from '../facts.js';
import { runtimeReference } from '../languages/typescript-runtime.js';
import { requestExecutionContext } from '../routes/boundaries.js';
import type { RoutingContract } from '../routes/contracts.js';
import { HTTP_METHODS } from '../../analyzers/ts-http.js';
import { nodeSite, sourceRange, type TypeScriptPackScope, type TypeScriptPackFile } from './typescript-pack.js';
import { unwrap, valueDeclaration } from './typescript-binding.js';
import { TypeScriptStatic } from './typescript-static.js';
import { astroPath } from './astro-path.js';
import type { AstroConfig } from './astro-config.js';

type Callable = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration;
type Export = ts.Expression | Callable;
interface Bound { fn: Callable; frame: TypeScriptPackFile }

export function astroRoutes(scope: TypeScriptPackScope, reader: TypeScriptStatic): void {
  for (const runtime of scope.services.projects) {
    const config = scope.services.astro.get(runtime.project.id);
    if (config?.valid && scope.inputs?.some(file => runtime.inputs.some(input => input.path === file.path))) new AstroRoutes(scope, reader, config).run();
  }
}
class AstroRoutes {
  constructor(private readonly scope: TypeScriptPackScope, private readonly reader: TypeScriptStatic, private readonly config: AstroConfig) {}
  private gap(file: string, reason: string, code = 'astro-route-gap'): void { this.scope.context.graph.diagnose({ analyzer: 'astro', severity: 'warning', code, file, line: 1, entityId: this.scope.context.files.get(file)?.id, reason }); }
  run(): void {
    const { context } = this.scope, prefix = `${this.config.src}/pages/`, conditions = [...this.config.conditions], middleware = this.middleware(conditions);
    const files = (this.scope.inputs ?? []).filter(file => file.path.startsWith(prefix) && context.projects?.nodeOwner(file.path).id === this.config.project.id);
    const collisions = new Map<string, number>();
    for (const file of files) { const pattern = astroPath(file.path.slice(prefix.length), this.config.base, this.config.trailingSlash); if (pattern) collisions.set(pattern.original, (collisions.get(pattern.original) ?? 0) + 1); }
    for (const file of files) {
      if (!/\.(?:astro|mdx?|[jt]s)$/.test(file.path)) continue;
      const pattern = astroPath(file.path.slice(prefix.length), this.config.base, this.config.trailingSlash); if (!pattern) continue;
      if (/\.mdx?$/.test(file.path)) { this.gap(file.path, 'Markdown/MDX frontmatter/layouts require a separate indexed content profile', 'astro-content-route-gap'); continue; }
      const frame = this.scope.files.find(frame => frame.file.path === file.path && (file.language !== 'astro' || frame.file.embedded?.role === 'frontmatter'));
      const exports = frame ? this.exports(frame) : new Map<string, Export>(), constraints = [...conditions];
      if (collisions.get(pattern.original)! > 1) constraints.push('Duplicate filesystem page/endpoint URL; dispatch precedence is unresolved');
      if (pattern.status === 'partial') constraints.push(pattern.reason!);
      let prerender: boolean | 'unknown' = this.config.output === 'static';
      const value = exports.get('prerender');
      if (value && frame) {
        const declaration = !ts.isFunctionLike(value) && valueDeclaration(value as ts.Expression, frame.state.checker);
        const initializer = declaration && ts.isVariableDeclaration(declaration) && declaration.getSourceFile().fileName === frame.source.fileName && declaration.initializer;
        const statement = declaration && ts.isVariableDeclaration(declaration) && declaration.parent.parent;
        const start = statement && statement.getStart(frame.source), lineStart = typeof start === 'number' ? Math.max(frame.source.text.lastIndexOf('\n', start - 1), frame.source.text.lastIndexOf('\r', start - 1)) + 1 : 0;
        const exportedLiteral = statement && ts.isVariableStatement(statement) && typeof start === 'number' && !frame.source.text.slice(lineStart, start).trim() && /^\s*export\s+const\s+prerender\s*=\s*(true|false);?/.test(statement.getText(frame.source));
        if (exportedLiteral && initializer && [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(initializer.kind)) prerender = initializer.kind === ts.SyntaxKind.TrueKeyword;
        else { prerender = 'unknown'; constraints.push('Dynamic prerender export prevents delivery-mode qualification'); }
      }
      if (prerender === false && !this.config.adapter) constraints.push('On-demand output requires a qualified adapter; deployment is unresolved');
      const staticPaths = frame && this.callable(exports.get('getStaticPaths'), frame), dynamic = pattern.alternatives.some(parts => parts.some(segment => segment.kind === 'rest' || segment.parts.some(part => part.kind === 'parameter')));
      if (prerender === true && dynamic && !staticPaths) constraints.push('Dynamic prerendered route requires an indexed getStaticPaths callable');
      if (prerender === false && exports.has('getStaticPaths')) constraints.push('getStaticPaths is ignored for on-demand output');
      if (prerender === 'unknown') { this.gap(file.path, constraints.join('; ')); continue; }
      const metadata = { framework: 'astro', profile: this.config.profile, registration: 'filesystem', routePath: pattern.original, routePattern: pattern, prerender, delivery: prerender ? 'static' : 'server', concretePaths: dynamic && prerender ? 'unknown' : 'filename', constraintsUnresolved: constraints.length > 0, adapter: this.config.adapter, middleware };
      const fact = evidence('framework', 'astro', file.path, 1, prerender ? 'Astro filesystem build-time output; no runtime API is inferred' : 'Astro filesystem on-demand route'), app = file.application && context.applicationIds.get(file.application.name);
      if (!app) { this.gap(file.path, 'Astro route has no application ownership'); continue; }
      this.stamp(file.path);
      if (file.language === 'astro') {
        const id = context.graph.entities.get(file.id)?.metadata.component, component = typeof id === 'string' && context.graph.entities.get(id);
        if (!component || !component.metadata.astroParsed) { this.gap(file.path, 'Unavailable/malformed Astro component cannot qualify a page'); continue; }
        const page = context.graph.contain({ id: context.graph.id('astro-page', this.config.project.id, file.path), type: 'route', name: pattern.original, path: file.path, language: 'astro', parentId: app, sourceRange: component.sourceRange, metadata: { ...metadata, operationKind: 'page' }, evidence: [fact] });
        context.graph.relate(page.id, component.id, 'routes_to', [fact], { role: 'page', executionContext: 'server', delivery: metadata.delivery });
        if (staticPaths) context.graph.relate(page.id, this.handler(staticPaths, 'getStaticPaths').id, 'references', [this.reader.fact(staticPaths.fn, 'Astro build-time path generator; concrete returned URLs are not evaluated')], { role: 'static-path-generator' });
        this.roles(page, middleware, fact);
      } else if (frame) {
        const registered = new Map<string, Bound>();
        for (const name of exports.keys()) if (/^[A-Z]+$/.test(name) && name !== 'ALL' && !HTTP_METHODS.has(name)) { constraints.push(`Custom ${name} HTTP method requires a separate transport profile`); this.gap(file.path, `Custom ${name} endpoint export remains outside the seven-method transport profile`, 'astro-method-gap'); }
        for (const name of [...HTTP_METHODS, 'ALL']) if (exports.has(name)) { const fn = this.callable(exports.get(name), frame); if (fn) registered.set(name, fn); else { constraints.push(`Unresolved ${name} handler export`); this.gap(file.path, `Unresolved/mutable ${name} endpoint export`, 'astro-handler-gap'); } }
        if (!registered.size) { this.gap(file.path, 'Filesystem endpoint has no indexed callable HTTP export', 'astro-handler-gap'); continue; }
        const publish = (method: string, bound: Bound, methods: string[] | '*' = [method], excludedMethods?: string[]): void => {
          const target = this.handler(bound, method), proof = this.reader.fact(bound.fn, prerender ? 'Original Astro build-time GET handler' : `Original Astro ${method} handler; registration is in ${file.path}`);
          const routing: RoutingContract = { version: 1, pattern, methods, ...(excludedMethods ? { excludedMethods } : {}), executionContext: 'server', registration: { file: file.path, line: 1, receiver: 'Astro filesystem' }, mounts: [], middleware, conditions: constraints };
          const entity = context.graph.contain({ id: context.graph.id('astro-endpoint', this.config.project.id, file.path, method), type: prerender ? 'route' : 'api_endpoint', name: `${method} ${pattern.original}`, path: file.path, language: file.language, parentId: app, sourceRange: sourceRange(bound.fn), metadata: { ...metadata, constraintsUnresolved: constraints.length > 0, method, operationKind: prerender ? 'static-endpoint' : 'endpoint', executionContext: 'server', ...(prerender ? {} : { routing }) }, evidence: [fact, proof] });
          context.graph.relate(entity.id, target.id, 'routes_to', [fact, proof], { role: prerender ? 'build-handler' : 'handler', delivery: metadata.delivery }); this.roles(entity, middleware, fact);
          if (prerender && staticPaths) context.graph.relate(entity.id, this.handler(staticPaths, 'getStaticPaths').id, 'references', [this.reader.fact(staticPaths.fn, 'Build-time generator; concrete output URLs remain unknown')], { role: 'static-path-generator' });
        };
        if (prerender) { const get = registered.get('GET') ?? (!exports.has('GET') ? registered.get('ALL') : undefined); if (get) publish('GET', get); else this.gap(file.path, 'Prerendered endpoints require GET/ALL; other methods are not runtime APIs'); }
        else {
          for (const [method, bound] of registered) if (method !== 'ALL') publish(method, bound);
          // Astro selects ALL before its implicit GET-for-HEAD fallback.
          if (!exports.has('HEAD') && !exports.has('ALL') && registered.has('GET')) publish('HEAD', registered.get('GET')!);
          const all = registered.get('ALL'); if (all) publish('ALL', all, '*', [...exports.keys()].filter(method => method !== 'ALL' && /^[A-Z]+$/.test(method)));
        }
      }
      if (constraints.length) this.gap(file.path, [...new Set(constraints)].join('; '));
    }
  }
  private stamp(file: string): void { const input = this.scope.context.files.get(file), entity = input && this.scope.context.graph.entities.get(input.id); if (!entity) return; entity.metadata.frameworkPacks = [...new Set([...(entity.metadata.frameworkPacks as string[] | undefined ?? []), 'astro'])]; const analysis = fileAnalysis(entity.metadata.analysis); if (analysis && analysis.features.framework.status !== 'failed') analysis.features.framework = { status: 'partial', reason: 'Astro static filesystem registrations and original handlers; generated paths/config integrations remain constrained' }; }
  private exports(frame: TypeScriptPackFile): Map<string, Export> {
    const checker = frame.state.checker, symbol = checker.getSymbolAtLocation(frame.source), result = new Map<string, Export>(); if (!symbol) return result;
    for (let item of checker.getExportsOfModule(symbol)) {
      const name = item.name; if (!runtimeReference(frame.source, checker, name)) continue;
      if (item.flags & ts.SymbolFlags.Alias) item = checker.getAliasedSymbol(item);
      const value = item.valueDeclaration ?? item.declarations?.[0];
      if (value && ts.isVariableDeclaration(value) && value.initializer && ts.isIdentifier(value.name) && runtimeReference(value.name, checker)) result.set(name, value.name);
      else if (value && ts.isFunctionDeclaration(value) && value.body) result.set(name, value);
    }
    return result;
  }
  private callable(value: Export | undefined, frame: TypeScriptPackFile, seen = new Set<string>()): Bound | undefined {
    if (!value || seen.size > 20) return undefined;
    let node: ts.Node = value;
    if (!ts.isFunctionLike(node)) {
      node = unwrap(value as ts.Expression); if (!runtimeReference(node as ts.Expression, frame.state.checker)) return undefined;
      const declaration = valueDeclaration(node as ts.Expression, frame.state.checker);
      if (declaration) {
        const site = nodeSite(declaration); if (seen.has(site) || this.reader.writes.has(site)) return undefined; seen.add(site);
        if (ts.isFunctionDeclaration(declaration)) node = declaration;
        else if (ts.isVariableDeclaration(declaration) && declaration.initializer && ts.isVariableDeclarationList(declaration.parent) && declaration.parent.flags & ts.NodeFlags.Const) node = unwrap(declaration.initializer);
        else return undefined;
      }
    }
    if (ts.isCallExpression(node) && this.reader.api(node.expression, frame.state.checker, 'astro:middleware', 'defineMiddleware') && node.arguments.length === 1) return this.callable(node.arguments[0], frame, seen);
    if (!ts.isFunctionDeclaration(node) && !ts.isArrowFunction(node) && !ts.isFunctionExpression(node) && !ts.isMethodDeclaration(node)) return node === value ? undefined : this.callable(node as ts.Expression, frame, seen);
    if (!node.body || this.reader.writes.has(nodeSite(node))) return undefined;
    const owner = this.scope.files.find(candidate => candidate.source.fileName === node.getSourceFile().fileName);
    if (!owner) return undefined;
    const site = nodeSite(node); let original: Callable | undefined;
    const visit = (candidate: ts.Node): void => { if (nodeSite(candidate) === site && (ts.isFunctionDeclaration(candidate) || ts.isFunctionExpression(candidate) || ts.isArrowFunction(candidate) || ts.isMethodDeclaration(candidate))) original = candidate; else if (!original) ts.forEachChild(candidate, visit); }; visit(owner.source);
    return original ? { fn: original, frame: owner } : undefined;
  }
  private handler(bound: Bound, name: string): Entity {
    const { fn, frame } = bound, graph = this.scope.context.graph, existing = this.scope.services.declarations.get(fn);
    const entity = existing ?? graph.contain({ id: graph.id('astro-handler', frame.file.path, name, fn.getText().replace(/\s+/g, ' ')), type: 'function', name, path: frame.file.path, language: frame.file.language, parentId: frame.owners.get(frame.source)?.id ?? frame.file.id, sourceRange: sourceRange(fn), metadata: { role: 'handler', qualifiedName: name, ...declarationHashes(fn.getText(), 0) }, evidence: [this.reader.fact(fn, 'Original registered Astro callable')] });
    if (frame.file.path.startsWith(`${this.config.src}/pages/`) || path.posix.dirname(frame.file.path) === this.config.src && /^middleware\.[jt]s$/.test(path.posix.basename(frame.file.path))) entity.metadata.executionContext = 'server';
    // Registration supplies server context without changing a shared callable's
    // declaration context. Its original effects remain source-backed.
    const site = nodeSite(fn), visit = (node: ts.Node): void => { if (nodeSite(node) === site) { frame.owners.set(node, entity); this.scope.services.declarations.set(node, entity); } else ts.forEachChild(node, visit); }; visit(frame.source); this.scope.services.declarations.set(fn, entity);
    return entity;
  }
  private middleware(conditions: string[]): string[] {
    const files = this.scope.files.filter(frame => !frame.file.embedded && frame.runtime.project.id === this.config.project.id && /^middleware\.[jt]s$/.test(path.posix.basename(frame.file.path)) && path.posix.dirname(frame.file.path) === this.config.src);
    if (files.length > 1) conditions.push('Multiple Astro middleware entries');
    const handlers: string[] = [];
    for (const frame of files) {
      this.stamp(frame.file.path); const root = this.exports(frame).get('onRequest'); if (!root) continue;
      const read = (value: Export, depth = 0): void => {
        if (depth > 12 || handlers.length >= 128) { conditions.push('Middleware sequence budget exceeded'); return; }
        const node = !ts.isFunctionLike(value) && this.reader.resolve(value as ts.Expression, frame.state.checker);
        if (node && ts.isCallExpression(node) && this.reader.api(node.expression, frame.state.checker, 'astro:middleware', 'sequence')) { for (const argument of node.arguments) read(argument, depth + 1); return; }
        const bound = this.callable(value, frame);
        if (bound) handlers.push(this.handler(bound, 'onRequest').id); else conditions.push('Dynamic/unqualified onRequest middleware');
      }; read(root);
      conditions.push(`Middleware dispatch/rewrites in ${frame.file.path} require a control-flow summary`); this.gap(frame.file.path, 'Statically registered middleware order is retained; runtime policy/rewrites remain constrained', 'astro-middleware-gap');
    }
    return handlers;
  }
  private roles(entity: Entity, middleware: string[], fact: ReturnType<typeof evidence>): void { for (const [index, id] of middleware.entries()) this.scope.context.graph.relate(entity.id, id, 'references', [fact], { role: 'middleware', order: index, executionContext: 'server', delivery: entity.metadata.delivery }); }
}

/** Hydration is a separate browser invocation. Traversal includes original UI
 * initialization and browser callbacks, excluding explicit server declarations.
 * SSR-only renders never acquire the host application's browser origin. */
export function astroInvocations(scope: TypeScriptPackScope): void {
  const { context } = scope, observations = [...context.http], outgoing = new Map<string, string[]>();
  for (const relation of context.graph.relations.values()) {
    const target = context.graph.entities.get(relation.to);
    if (relation.type === 'calls' || relation.type === 'renders' || relation.type === 'references' && target && (target.metadata.role === 'script' || target.metadata.svelteBrowserCallback || target.metadata.vueTemplateEvent)) outgoing.set(relation.from, [...outgoing.get(relation.from) ?? [], relation.to]);
  }
  for (const entity of context.graph.entities.values()) {
    if (!entity.metadata.astroInvocation || !scope.inputs?.some(file => file.path === entity.metadata.registrationFile)) continue;
    const pending = [String(entity.metadata.registeredTarget)], seen = new Set<string>();
    while (pending.length && seen.size < 128) {
      const target = pending.shift()!; if (seen.has(target)) continue; seen.add(target);
      if (requestExecutionContext(context, { callerId: target, fileId: '', expression: '', evidence: entity.evidence[0]! }) === 'server') continue;
      for (const observation of observations) if (observation.callerId === target && target !== entity.id && (observation.resolved?.relative || observation.url?.startsWith('/') && !observation.url.startsWith('//'))) {
        const effect: EffectFact | undefined = observation.effect && { ...observation.effect };
        if (effect) { const effects = entity.metadata.effects as EffectFact[] | undefined ?? []; if (effects.length < 40) effects.push(effect); entity.metadata.effects = effects; }
        const file = context.files.get(String(entity.metadata.registrationFile));
        if (file) context.http.push({ ...observation, transport: undefined, callerId: entity.id, fileId: file.id, effect, evidence: { ...observation.evidence, explanation: `${observation.evidence.explanation}; browser invocation is supplied by Astro ${entity.metadata.directive} at ${entity.path}:${entity.sourceRange?.startLine}` } });
      }
      pending.push(...outgoing.get(target) ?? []);
    }
    if (pending.length) context.graph.diagnose({ analyzer: 'astro', severity: 'warning', code: 'astro-island-call-budget', file: entity.path, entityId: entity.id, reason: 'Hydrated island exceeded its 128-callable budget' });
  }
}
