import ts from 'typescript';
import { type Entity } from '../../core/graph.js';
import { sourcePath, sourceMapped } from '../embedded/index.js';
import { nodeSite, sourceRange, type TypeScriptPackScope, type TypeScriptPackFile } from './typescript-pack.js';
import { VueStatic, profile } from './vue-static.js';

interface InstalledRouter { call: ts.CallExpression; app: ts.CallExpression; install: ts.CallExpression; frame: TypeScriptPackFile; identity: string; dynamic?: boolean }
interface RecordRoute { entity: Entity; node: ts.Expression; checker: ts.TypeChecker; redirect?: ts.Expression }
function topLevel(node: ts.Node): boolean {
  for (let parent = node.parent; parent && !ts.isSourceFile(parent); parent = parent.parent) if (ts.isFunctionLike(parent) || ts.isIfStatement(parent) || ts.isSwitchStatement(parent) || ts.isConditionalExpression(parent) || ts.isForStatement(parent) || ts.isForOfStatement(parent) || ts.isForInStatement(parent) || ts.isWhileStatement(parent) || ts.isDoStatement(parent) || ts.isTryStatement(parent) || ts.isBinaryExpression(parent) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(parent.operatorToken.kind)) return false;
  return true;
}
/** Only a proven Vue app installing a proven createRouter makes route records
 * flow roots. Uninstalled arrays and spelling-only lookalikes stay private. */
export function vueRouters(scope: TypeScriptPackScope, reader: VueStatic): void {
  const installations = new Map<string, InstalledRouter>(), candidates = new Map<string, ts.CallExpression>(), dynamic = new Set<string>();
  const appOf = (expression: ts.Expression, frame: TypeScriptPackFile, depth = 0): ts.CallExpression | undefined => {
    if (depth > 16) return undefined;
    const node = reader.resolve(expression, frame.state.checker);
    if (!node || !ts.isCallExpression(node)) return undefined;
    if (reader.api(node.expression, frame.state.checker, 'vue', 'createApp') || reader.api(node.expression, frame.state.checker, 'vue', 'createSSRApp')) return node;
    if (ts.isPropertyAccessExpression(node.expression) && ['use', 'mount', 'component', 'provide'].includes(node.expression.name.text)) return appOf(node.expression.expression, frame, depth + 1);
    return undefined;
  };
  for (const frame of scope.files) {
    const visit = (node: ts.Node): void => {
      if (!ts.isSourceFile(node) && !sourceMapped(scope.context, frame.source.fileName, node.getStart(frame.source), node.end)) return;
      if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier) && /^(?:vue-router\/(?:auto|auto-routes|experimental)(?:\/|$)|unplugin-vue-router(?:\/|$))/.test(node.moduleSpecifier.text)) reader.gap(node, 'vue-router-generated-route-gap', 'Generated file-based routes and data loaders require a separate static convention profile');
      if (ts.isCallExpression(node)) {
        if (reader.api(node.expression, frame.state.checker, 'vue-router', 'createRouter')) { candidates.set(nodeSite(node), node); if (!topLevel(node)) reader.gap(node, 'vue-router-dynamic-registration', 'Router factories/conditional registrations require an invocation summary'); }
        if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'use' && node.arguments.length === 1 && topLevel(node)) {
          const app = appOf(node.expression.expression, frame), router = reader.resolve(node.arguments[0], frame.state.checker);
          if (app && topLevel(app) && router && ts.isCallExpression(router) && reader.api(router.expression, frame.state.checker, 'vue-router', 'createRouter') && topLevel(router)) installations.set(`${nodeSite(app)}:${nodeSite(router)}`, { call: router, app, install: node, frame, identity: '' });
        }
        if (ts.isPropertyAccessExpression(node.expression) && ['addRoute', 'removeRoute'].includes(node.expression.name.text)) {
          const router = reader.resolve(node.expression.expression, frame.state.checker);
          if (router && ts.isCallExpression(router) && reader.api(router.expression, frame.state.checker, 'vue-router', 'createRouter')) { dynamic.add(nodeSite(router)); reader.gap(node, 'vue-router-dynamic-registration', 'Runtime addRoute/removeRoute calls are outside the route-record profile'); }
        }
      }
      ts.forEachChild(node, visit);
    }; visit(frame.source);
  }
  for (const [site, candidate] of candidates) if (![...installations.values()].some(item => nodeSite(item.call) === site)) reader.gap(candidate, 'vue-router-uninstalled', 'No proven top-level Vue app installation for this router');
  const ordinals = new Map<string, number>(), apps = new Map<string, string>();
  for (const installation of installations.values()) {
    const site = nodeSite(installation.app), base = `${reader.path(installation.app)}:${installation.app.getText().replace(/\s+/g, ' ')}`;
    if (!apps.has(site)) { const ordinal = ordinals.get(base) ?? 0; ordinals.set(base, ordinal + 1); apps.set(site, `${base}:${ordinal}`); }
    installation.identity = apps.get(site)!; installation.dynamic = dynamic.has(nodeSite(installation.call)); new RouterRecords(scope, reader, installation).run();
  }
}
class RouterRecords {
  private readonly routes: RecordRoute[] = [];
  private readonly occurrences = new Map<string, number>();
  private steps = 0; private base = ''; private baseUnknown = false; private root?: Entity; private profile = 'vue-router-4';
  constructor(private readonly scope: TypeScriptPackScope, private readonly reader: VueStatic, private readonly installation: InstalledRouter) {}
  private fields(node: ts.Expression): Map<string, ts.Expression> | undefined {
    const fields = this.reader.object(node, this.installation.frame.state.checker);
    if (!fields || [...fields.values()].some(ts.isMethodDeclaration)) return undefined;
    return fields as Map<string, ts.Expression>;
  }
  run(): void {
    const { call, frame, app } = this.installation, checker = frame.state.checker;
    const project = this.scope.context.projects!.nodeOwner(this.reader.path(call)), dependency = project.dependencies['vue-router'];
    if (this.installation.dynamic) return;
    if (profile(dependency, 5)) this.profile = 'vue-router-5';
    else if (!profile(dependency, 4)) { this.reader.gap(call, 'vue-router-version-profile', `Vue Router dependency ${dependency ?? '(undeclared)'} is outside the qualified Vue Router 4/5 manual route-record profiles`); return; }
    const appDependency = this.scope.context.projects!.nodeOwner(this.reader.path(app)).dependencies.vue;
    if (!profile(appDependency, 3)) { this.reader.gap(app, 'vue-version-profile', 'Router installation requires a qualified Vue 3 application'); return; }
    const config = call.arguments.length === 1 && call.arguments[0] && this.fields(call.arguments[0]);
    if (!config || !config.has('routes') || !config.has('history')) { this.reader.gap(call, 'vue-router-config-gap', 'Router configuration requires indexed static routes and history'); return; }
    const history = this.reader.resolve(config.get('history'), checker);
    if (!history || !ts.isCallExpression(history) || !['createWebHistory', 'createWebHashHistory', 'createMemoryHistory'].some(name => this.reader.api(history.expression, checker, 'vue-router', name))) { this.reader.gap(call, 'vue-router-history-gap', 'Custom/dynamic history is outside the router profile'); return; }
    if (history.arguments.length) {
      const base = this.reader.string(history.arguments[0], checker);
      if (base === undefined || !base.startsWith('/') || base.includes('?') || base.includes('#')) { this.reader.gap(history, 'vue-router-history-gap', 'History base is unresolved; logical route paths remain available'); this.baseUnknown = true; }
      else this.base = base === '/' ? '' : base.replace(/\/$/, '');
    }
    this.root = this.reader.component(app.arguments[0], checker);
    this.reader.stamp(call, 'vue-router'); this.reader.stamp(this.installation.install, 'vue-router');
    const records = this.reader.array(config.get('routes'), checker);
    if (!records) { this.reader.gap(call, 'vue-router-record-gap', 'Route array is dynamic, mutated or outside the indexed source'); return; }
    if (!this.uniqueNames(records)) return;
    for (const record of records) this.record(record, '', []);
    for (const route of this.routes) if (route.redirect) this.redirect(route);
    const file = this.scope.context.files.get(this.reader.path(call)), entity = file && this.scope.context.graph.entities.get(file.id);
    if (entity) {
      const summaries = entity.metadata.registrations as unknown[] | undefined ?? [];
      summaries.push({ version: 1, framework: 'vue-router', profile: this.profile, line: sourceRange(call).startLine, installedAt: this.reader.path(this.installation.install), history: history.expression.getText(), ...(this.baseUnknown ? { baseUnresolved: true } : { base: this.base }), routes: this.routes.map(route => route.entity.id) }); entity.metadata.registrations = summaries;
    }
  }
  private uniqueNames(records: ts.Expression[]): boolean {
    const names = new Set<string>(); let steps = 0;
    const visit = (records: ts.Expression[], depth: number): boolean => {
      if (depth > 16 || (steps += records.length) > 512) { this.reader.gap(this.installation.call, 'vue-router-record-budget', 'Route-name validation exceeded its depth/record budget'); return false; }
      for (const record of records) {
        const fields = this.fields(record); if (!fields) continue;
        const name = this.reader.string(fields.get('name'), this.installation.frame.state.checker);
        if (name !== undefined) {
          if (names.has(name)) { this.reader.gap(record, 'vue-router-name-collision', `Duplicate route name ${name} replaces an earlier matcher; conflicting records require a separate registration profile`); return false; } names.add(name);
        }
        const children = this.reader.array(fields.get('children'), this.installation.frame.state.checker);
        if (children && !visit(children, depth + 1)) return false;
      }
      return true;
    };
    return visit(records, 0);
  }
  private record(node: ts.Expression, prefix: string, layouts: { target: Entity; view: string }[], depth = 0): void {
    const { frame, app, call } = this.installation, checker = frame.state.checker, graph = this.scope.context.graph;
    if (depth > 16 || ++this.steps > 512) { this.reader.gap(node, 'vue-router-record-budget', 'Nested route expansion exceeded its depth/record budget'); return; }
    const fields = this.fields(node), raw = fields && this.reader.string(fields.get('path'), checker);
    if (!fields || raw === undefined || (!prefix && !raw.startsWith('/'))) { this.reader.gap(node, 'vue-router-record-gap', 'Route record needs a static path and object fields'); return; }
    const aliases = fields.get('alias'), paths = [raw];
    if (aliases) {
      const alias = this.reader.string(aliases, checker), values = alias === undefined ? this.reader.array(aliases, checker)?.map(value => this.reader.string(value, checker)) : [alias];
      if (!values || values.some(value => value === undefined)) this.reader.gap(aliases, 'vue-router-alias-gap', 'Dynamic aliases remain unresolved');
      else paths.push(...values as string[]);
    }
    const targets: { target: Entity; view: string }[] = [];
    if (paths.length > 32) this.reader.gap(aliases ?? node, 'vue-router-alias-budget', 'Path alias expansion exceeded its 32-path budget');
    const component = fields.get('component'), views = fields.get('components');
    if (component && views) { this.reader.gap(node, 'vue-router-component-gap', 'A record declares both component and named components'); return; }
    if (component) { const target = this.component(component); if (target) targets.push({ target, view: 'default' }); }
    if (views) {
      const named = this.fields(views);
      if (!named) this.reader.gap(views, 'vue-router-component-gap', 'Named views are not a static object');
      else for (const [view, expression] of named) { const target = this.component(expression); if (target) targets.push({ target, view }); }
    }
    const name = this.reader.string(fields.get('name'), checker), redirect = fields.get('redirect');
    if (fields.has('beforeEnter')) this.reader.gap(fields.get('beforeEnter')!, 'vue-router-guard-gap', 'Navigation guard behavior is outside the route-record profile');
    for (const path of [...new Set(paths)].slice(0, 32)) {
      if (!prefix && !path.startsWith('/')) { this.reader.gap(node, 'vue-router-record-gap', 'Root aliases must be absolute'); continue; }
      const routePath = path.startsWith('/') ? path : path === '' ? prefix : `${prefix.replace(/\/$/, '')}/${path}`;
      const identity = `${this.installation.identity}:${this.reader.path(node)}:${routePath}:${name ?? ''}`;
      const ordinal = this.occurrences.get(identity) ?? 0; this.occurrences.set(identity, ordinal + 1);
      const application = frame.file.application, parentId = application ? this.scope.context.applicationIds.get(application.name)! : this.scope.context.files.get(this.reader.path(call))!.id;
      const route = graph.contain({ id: graph.id('route', 'vue-router', frame.runtime.project.id, this.reader.path(call), identity, String(ordinal)), type: 'route', name: routePath, path: this.reader.path(node), language: 'vue', parentId, sourceRange: sourceRange(node), metadata: { framework: 'vue-router', profile: this.profile, registration: 'explicit', routePath, ...(name ? { routeName: name } : {}), ...(path !== raw ? { aliasOf: raw } : {}), ...(this.baseUnknown ? { historyBaseUnresolved: true, constraintsUnresolved: true } : { historyBase: this.base, publicPath: `${this.base}${routePath}` }), executionContext: 'browser', installed: true }, evidence: [this.reader.fact(node, 'Static route record installed on a proven Vue application'), this.reader.fact(this.installation.install, 'Vue app.use installs this exact router')] });
      this.routes.push({ entity: route, node, checker, ...(redirect ? { redirect } : {}) });
      if (!redirect) {
        const layoutTargets = this.root ? [{ target: this.root, view: 'app' }, ...layouts] : layouts;
        for (const item of [...layoutTargets, ...targets]) graph.relate(route.id, item.target.id, 'routes_to', [this.reader.fact(node, `Vue Router ${targets.includes(item) ? 'view' : 'layout'} ${item.view}`)], { role: targets.includes(item) ? 'view' : 'layout', view: item.view }, item.view);
      }
      const children = fields.get('children');
      if (children) {
        const nested = this.reader.array(children, checker);
        if (!nested) this.reader.gap(children, 'vue-router-record-gap', 'Nested route records are dynamic or mutated');
        else for (const child of nested) this.record(child, routePath, [...layouts, ...targets], depth + 1);
      }
    }
  }
  private component(expression: ts.Expression): Entity | undefined {
    const checker = this.installation.frame.state.checker, direct = this.reader.component(expression, checker); if (direct) return direct;
    const resolved = this.reader.resolve(expression, checker);
    let body: ts.Expression | undefined;
    if (resolved && (ts.isArrowFunction(resolved) || ts.isFunctionExpression(resolved)) && !resolved.parameters.length) {
      if (ts.isBlock(resolved.body)) {
        if (resolved.body.statements.length === 1 && ts.isReturnStatement(resolved.body.statements[0]!)) body = resolved.body.statements[0]!.expression;
      } else body = resolved.body;
      body = body && this.reader.resolve(body, checker);
    }
    if (body && ts.isCallExpression(body) && body.expression.kind === ts.SyntaxKind.ImportKeyword && body.arguments.length === 1 && ts.isStringLiteralLike(body.arguments[0]!)) {
      const module = this.scope.services.resolver.resolve(body.arguments[0]!.text, body.getSourceFile().fileName).resolvedModule;
      const file = module && this.scope.context.files.get(sourcePath(this.scope.context, module.resolvedFileName));
      const id = file && this.scope.context.graph.entities.get(file.id)?.metadata.component;
      const target = typeof id === 'string' ? this.scope.context.graph.entities.get(id) : undefined;
      if (target?.type === 'component' && target.language === 'vue') return target;
    }
    this.reader.gap(expression, 'vue-router-component-gap', 'Route component is not a bound SFC or a literal import loader'); return undefined;
  }
  private redirect(route: RecordRoute): void {
    const expression = route.redirect!, checker = route.checker, path = this.reader.string(expression, checker), fields = path === undefined && this.fields(expression);
    const name = fields && this.reader.string(fields.get('name'), checker), explicitPath = path ?? (fields && this.reader.string(fields.get('path'), checker));
    const targetPath = explicitPath && (explicitPath.startsWith('/') ? explicitPath : `${String(route.entity.metadata.routePath).replace(/\/[^/]*$/, '')}/${explicitPath}`);
    const candidates = this.routes.filter(candidate => !candidate.entity.metadata.aliasOf && (name ? candidate.entity.metadata.routeName === name : targetPath ? candidate.entity.metadata.routePath === targetPath : false));
    if (candidates.length !== 1) { this.reader.gap(expression, 'vue-router-redirect-gap', 'Redirect has no unique indexed static route target'); return; }
    this.scope.context.graph.relate(route.entity.id, candidates[0]!.entity.id, 'routes_to', [this.reader.fact(expression, 'Vue Router literal redirect target')], { role: 'redirect' });
  }
}
