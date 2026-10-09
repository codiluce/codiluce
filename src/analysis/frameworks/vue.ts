import { normalizeFetchMethod } from '../routes/http-method.js';
import ts from 'typescript';
import path from 'node:path';
import type { ScannedFile } from '../../core/analyzer.js';
import { declarationHashes, evidence, type Entity, type Evidence, type EffectFact } from '../../core/graph.js';
import { fileAnalysis } from '../facts.js';
import { SourceText } from '../source-map.js';
import { sourceMapped } from '../embedded/index.js';
import { browserInvocations } from './browser-invocations.js';
import { runtimeReference } from '../languages/typescript-runtime.js';
import { SiteCollector } from '../../analyzers/references.js';
import { frameworkBinding, unwrap } from './typescript-binding.js';
import { sourceRange, type TypeScriptFrameworkPack, type TypeScriptPackScope, type TypeScriptPackFile } from './typescript-pack.js';
import { VueStatic, profile, propertyName } from './vue-static.js';
import { vueTemplateSites, type VueTemplateSite } from './vue-template.js';
import { vueRouters } from './vue-router.js';
import { nuxtComponent, nuxtImportedComponent, nuxtGlobal } from './nuxt-conventions.js';
import { nuxtFetchPath } from '../../analyzers/ts-http.js';

type Bound = { node: ts.Expression | ts.MethodDeclaration; frame: TypeScriptPackFile };
export const vuePack: TypeScriptFrameworkPack = {
  id: 'vue', version: '1.0.2', includeEmbedded: true,
  applies: scope => !!scope.inputs?.some(file => file.language === 'vue') || scope.files.some(frame => frame.runtime.project.dependencies['vue-router'] !== undefined),
  declare(scope): void {
    const reader = new VueStatic(scope);
    for (const file of scope.inputs ?? []) if (file.language === 'vue') new VueComponent(scope, reader, file).run();
    vueRouters(scope, reader);
  },
  finish(scope): void {
    browserInvocations(scope, 'vue', 'vueTemplateEvent');
  },
};

class VueComponent {
  private readonly frames: TypeScriptPackFile[];
  private readonly bindings = new Map<string, Bound>();
  private readonly components = new Map<string, Bound>();
  private readonly blockedComponents = new Set<string>();
  private readonly occurrences = new Map<string, number>();
  private readonly sites = new SiteCollector();
  private text = ''; private source!: SourceText; private component!: Entity;
  constructor(private readonly scope: TypeScriptPackScope, private readonly reader: VueStatic, private readonly file: ScannedFile) { this.frames = scope.files.filter(frame => frame.file.path === file.path); }
  private fact(start: number, end: number, reason: string): Evidence { const range = this.source.range(start, end); return { ...evidence('framework', 'vue', this.file.path, range.startLine, reason), endLine: range.endLine }; }
  private gap(start: number, reason: string, code = 'vue-template-gap'): void { this.scope.context.graph.diagnose({ analyzer: 'vue', severity: 'warning', code, file: this.file.path, line: this.source.position(start).line, entityId: this.file.id, reason }); }
  run(): void {
    const { context } = this.scope, fileEntity = context.graph.entities.get(this.file.id)!, facts = context.embedded?.facts.get(this.file.path);
    const component = fileEntity.metadata.component;
    if (typeof component !== 'string' || !facts) return;
    this.component = context.graph.entities.get(component)!;
    this.text = context.sources?.readFile(this.file.absolutePath) ?? ''; this.source = new SourceText(this.text);
    const project = context.projects?.nodeOwner(this.file.path), dependency = project?.dependencies.vue ?? (project && this.scope.services.nuxt.get(project.id)?.valid ? '^3.0.0' : undefined);
    const analysis = fileAnalysis(fileEntity.metadata.analysis);
    if (dependency && !profile(dependency, 3)) {
      if (analysis) analysis.features.framework = { status: 'unsupported', reason: 'Vue dependency is outside the qualified Vue 3 profile' };
      this.gap(0, `Vue dependency ${dependency} is outside the qualified Vue 3 profile`, 'vue-version-profile'); return;
    }
    if (facts.issues.some(issue => issue.fatal || issue.code === 'unsupported-template') || analysis?.features.structure.status === 'failed') {
      if (analysis) analysis.features.framework = { status: facts.issues.some(issue => issue.fatal) || analysis.features.structure.status === 'failed' ? 'failed' : 'unsupported', reason: 'Malformed or unsupported component/template input prevents Vue qualification' }; return;
    }
    const nuxtConfig = project && this.scope.services.nuxt.get(project.id);
    if (nuxtConfig?.valid && (/\.(?:server|island)(?:\.global)?\.vue$/.test(this.file.path) || this.file.path.startsWith(`${nuxtConfig.src === '.' ? '' : `${nuxtConfig.src}/`}components/islands/`))) {
      this.component.metadata.executionContext = 'server';
      if (analysis) analysis.features.framework = { status: 'unsupported', reason: 'Nuxt server components/islands require a separate render/hydration boundary; browser callbacks are not inferred' };
      this.gap(0, 'Nuxt server component/island mode requires a separate render boundary', 'nuxt-component-mode-gap'); return;
    }
    if (!dependency) this.gap(0, 'No declared Vue version; only the bounded Vue 3 SFC syntax subset is analyzed', 'vue-version-profile');
    if (facts.regions.some(region => !region.supported)) { if (analysis) analysis.features.framework = { status: 'unsupported', reason: 'Unavailable script bindings prevent Vue qualification' }; this.gap(0, 'Unavailable script bindings prevent template qualification'); return; }
    fileEntity.metadata.frameworkPacks = [...new Set([...(fileEntity.metadata.frameworkPacks as string[] | undefined ?? []), 'vue'])];
    this.component.metadata.profile = dependency ? 'vue-3' : 'vue-3-common';
    if (analysis) analysis.features.framework = { status: 'partial', reason: 'Vue 3 static local components, Options/setup bindings and bounded template callbacks; dynamic/global/compiler-plugin behavior is outside this profile' };
    if (analysis) analysis.features.references = { status: 'partial', reason: 'Vue script and bounded local template component/callback bindings' };
    for (const frame of [...this.frames].sort((a, b) => Number(a.file.embedded?.role === 'setup') - Number(b.file.embedded?.role === 'setup'))) {
      for (const statement of frame.source.statements) if (ts.isImportDeclaration(statement) && statement.importClause && sourceMapped(context, frame.source.fileName, statement.getStart(frame.source), statement.end)) {
        const clause = statement.importClause; if (clause.name) this.blockedComponents.add(clause.name.text);
        if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) this.blockedComponents.add(clause.namedBindings.name.text);
        else if (clause.namedBindings) for (const item of clause.namedBindings.elements) this.blockedComponents.add(item.name.text);
      }
      if (frame.file.embedded?.role === 'setup') {
        if (frame.source.statements.some(statement => sourceMapped(context, frame.source.fileName, statement.getStart(frame.source), statement.end) && setupRuntimeExport(statement))) {
          if (analysis) analysis.features.framework = { status: 'failed', reason: 'Runtime exports inside script setup are invalid Vue SFC syntax' };
          this.gap(frame.file.embedded.start, 'Runtime exports inside script setup are invalid Vue SFC syntax'); return;
        }
        this.topLevel(frame);
        for (const statement of frame.source.statements) if (ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression) && ts.isIdentifier(statement.expression.expression) && statement.expression.expression.text === 'defineOptions' && !frame.state.checker.getSymbolAtLocation(statement.expression.expression)?.declarations?.length) this.gap(statement.getStart(), 'defineOptions compiler macro behavior is outside this static profile');
      } else if (frame.file.embedded?.role === 'module') this.options(frame);
    }
    for (const template of facts.templates) for (const site of vueTemplateSites(this.text, template.start, template.end)) this.site(site);
    this.sites.flush(context.graph);
  }
  private topLevel(frame: TypeScriptPackFile): void {
    const add = (name: ts.BindingName): void => { if (ts.isIdentifier(name)) this.bindings.set(name.text, { node: name, frame }); else for (const item of name.elements) if (ts.isBindingElement(item)) add(item.name); };
    for (const statement of frame.source.statements) {
      if (!sourceMapped(this.scope.context, frame.source.fileName, statement.getStart(frame.source), statement.end)) continue;
      if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) add(declaration.name);
      else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) this.bindings.set(statement.name.text, { node: statement.name, frame });
      else if (ts.isImportDeclaration(statement) && statement.importClause && !statement.importClause.isTypeOnly) {
        const clause = statement.importClause; if (clause.name) this.bindings.set(clause.name.text, { node: clause.name, frame });
        if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) this.bindings.set(clause.namedBindings.name.text, { node: clause.namedBindings.name, frame });
        else if (clause.namedBindings) for (const item of clause.namedBindings.elements) if (!item.isTypeOnly) this.bindings.set(item.name.text, { node: item.name, frame });
      }
    }
    for (const [name, binding] of this.bindings) this.components.set(name, binding);
  }
  private options(frame: TypeScriptPackFile): void {
    const exported = frame.source.statements.find(ts.isExportAssignment); if (!exported) return;
    let node = this.reader.resolve(exported.expression, frame.state.checker);
    if (node && ts.isCallExpression(node)) {
      if (!this.reader.api(node.expression, frame.state.checker, 'vue', 'defineComponent') || node.arguments.length !== 1) { this.gap(node.getStart(), 'Component option factory is outside the static defineComponent profile'); return; }
      node = node.arguments[0];
    }
    const fields = this.reader.object(node, frame.state.checker); if (!fields) { this.gap(exported.getStart(), 'Default component options are not a static object'); return; }
    const register = (value: ts.Expression | ts.MethodDeclaration | undefined, target: Map<string, Bound>) => {
      if (!value || ts.isMethodDeclaration(value)) return;
      const values = this.reader.object(value, frame.state.checker); if (!values) { this.gap(value.getStart(), 'Dynamic component option bindings are unresolved'); return; }
      for (const [name, node] of values) { target.set(name, { node, frame }); this.declareProperty(node, name, frame); }
    };
    register(fields.get('components'), this.components);
    register(fields.get('methods'), this.bindings);
    const setup = fields.get('setup');
    const fn = setup && (ts.isMethodDeclaration(setup) ? setup : this.reader.resolve(setup, frame.state.checker));
    if (fn && (ts.isMethodDeclaration(fn) || ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) {
      const returns: ts.Expression[] = [];
      if (fn.body && !ts.isBlock(fn.body)) returns.push(fn.body);
      else if (fn.body) {
        const visit = (node: ts.Node): void => { if (ts.isReturnStatement(node) && node.expression) returns.push(node.expression); else if (!ts.isFunctionLike(node)) ts.forEachChild(node, visit); };
        ts.forEachChild(fn.body, visit);
      }
      if (returns.length !== 1) this.gap(fn.getStart(), 'Branch-dependent setup return bindings are unresolved');
      else { register(returns[0], this.bindings); register(returns[0], this.components); }
    } else if (setup) this.gap(setup.getStart(), 'Imported/dynamic setup functions require a separate binding summary');
  }
  private declareProperty(node: ts.Expression | ts.MethodDeclaration, name: string, frame: TypeScriptPackFile): void {
    if (!(ts.isArrowFunction(node) || ts.isFunctionExpression(node)) || this.scope.services.declarations.get(node)) return;
    const graph = this.scope.context.graph, entity = graph.contain({ id: graph.id('vue-option', this.file.path, name, String(this.occurrences.get(`option:${name}`) ?? 0)), type: 'method', name, path: this.file.path, language: 'vue', parentId: this.component.id, sourceRange: sourceRange(node), metadata: { framework: 'vue', role: 'method', executionContext: 'unknown', embeddedRegion: frame.file.embedded?.key, qualifiedName: `options.${name}`, ...declarationHashes(node.getText(), 0) }, evidence: [this.reader.fact(node, 'Static Vue option callback')] });
    this.occurrences.set(`option:${name}`, (this.occurrences.get(`option:${name}`) ?? 0) + 1);
    frame.owners.set(node, entity); this.scope.services.declarations.set(node, entity);
  }
  private binding(name: string, components: boolean, locals: readonly string[]): Bound | undefined {
    const [base, ...members] = name.split('.'); if (!base || locals.includes(base)) return undefined;
    const values = components ? this.components : this.bindings;
    let binding = values.get(base) ?? (components ? [...values].find(([key]) => key.replace(/([a-z\d])([A-Z])/g, '$1-$2').toLowerCase() === base)?.[1] : undefined);
    for (const member of members) {
      if (!binding || ts.isMethodDeclaration(binding.node)) return undefined;
      const checker = binding.frame.state.checker;
      if (!runtimeReference(binding.node, checker, member)) return undefined;
      let symbol = checker.getSymbolAtLocation(binding.node);
      if (symbol?.flags && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
      const property = symbol?.flags && symbol.flags & ts.SymbolFlags.Module ? checker.getExportsOfModule(symbol).find(item => item.name === member) : checker.getTypeAtLocation(binding.node).getProperty(member);
      let target = property; if (target?.flags && target.flags & ts.SymbolFlags.Alias) target = checker.getAliasedSymbol(target);
      const declaration = target?.valueDeclaration ?? target?.declarations?.[0];
      if (declaration && (ts.isVariableDeclaration(declaration) || ts.isFunctionDeclaration(declaration) || ts.isClassDeclaration(declaration)) && declaration.name && ts.isIdentifier(declaration.name)) binding = { ...binding, node: declaration.name };
      else if (declaration && ts.isExportAssignment(declaration)) binding = { ...binding, node: declaration.expression };
      else if (declaration && ts.isPropertyAssignment(declaration)) binding = { ...binding, node: declaration.initializer };
      else if (declaration && ts.isMethodDeclaration(declaration)) binding = { ...binding, node: declaration };
      else return undefined;
    }
    return binding;
  }
  private site(site: VueTemplateSite): void {
    if (site.kind === 'gap') { this.gap(site.start, site.reason!); return; }
    const graph = this.scope.context.graph;
    if (site.kind === 'component') {
      if (nativeTags.has(site.name!) || ['slot', 'component'].includes(site.name!)) return;
      const bound = this.binding(site.name!, true, site.locals), target = bound && !ts.isMethodDeclaration(bound.node) && (this.reader.component(bound.node, bound.frame.state.checker) ?? nuxtImportedComponent(this.scope, bound.frame, bound.node));
      const shadow = site.locals.includes(site.name!.split('.')[0]!) || this.blockedComponents.has(site.name!) || this.blockedComponents.has(site.name!.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase()).replace(/^./, letter => letter.toUpperCase()));
      const selfName = path.posix.basename(this.file.path, '.vue'), self = !bound && !shadow && [selfName, selfName.replace(/([a-z\d])([A-Z])/g, '$1-$2').toLowerCase()].includes(site.name!) ? this.component : undefined;
      const convention = !bound && !shadow && !self ? nuxtComponent(this.scope, this.file.path, site.name!) : undefined;
      const rendered = target || self || convention;
      const nuxt = this.scope.services.nuxt.get(this.scope.context.projects!.nodeOwner(this.file.path).id), importedConvention = bound && !ts.isMethodDeclaration(bound.node) && nuxtImportedComponent(this.scope, bound.frame, bound.node);
      if (rendered) {
        const fact = this.fact(site.start, site.end, convention || importedConvention ? `Nuxt indexed component convention for <${site.name}>; original component ${String(rendered.path)}` : `Vue template renders <${site.name}> through a bound component`);
        if (convention || importedConvention) { fact.analyzer = 'nuxt'; const entity = graph.entities.get(this.file.id)!; entity.metadata.frameworkPacks = [...new Set([...(entity.metadata.frameworkPacks as string[] | undefined ?? []), 'nuxt'])]; }
        this.sites.add({ from: this.component.id, to: rendered.id, type: 'renders', form: 'render', evidence: fact });
      } else if (/^[A-Z]|-/.test(site.name!) && !vueBuiltins.has(site.name!) && !(nuxt?.valid && !bound && !shadow && nuxtBuiltins.has(site.name!))) this.gap(site.start, `Component <${site.name}> has no qualified local runtime binding`);
      return;
    }
    const value = this.text.slice(site.start, site.end);
    if (/&(?:#\w+|\w+);/.test(value)) { this.gap(site.start, 'HTML-encoded template expressions need a decoded source map'); return; }
    const parsed = ts.createSourceFile('template.ts', value, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    if ((parsed as ts.SourceFile & { parseDiagnostics: ts.Diagnostic[] }).parseDiagnostics.length) { this.gap(site.start, 'Template expression is outside the parsed JavaScript expression subset'); return; }
    let owner = this.component;
    if (site.kind === 'event') {
      const identity = `${site.name}:${value.replace(/\s+/g, ' ').trim()}`, ordinal = this.occurrences.get(identity) ?? 0; this.occurrences.set(identity, ordinal + 1);
      owner = graph.contain({ id: graph.id('vue-event', this.file.path, identity, String(ordinal)), type: 'function', name: `${site.name} event`, path: this.file.path, language: 'vue', parentId: this.component.id, sourceRange: this.source.range(site.start, site.end), metadata: { role: 'handler', framework: 'vue', vueTemplateEvent: true, event: site.name, executionContext: 'browser', qualifiedName: `template.${site.name}.${ordinal}`, ...declarationHashes(value, 0) }, evidence: [this.fact(site.start, site.end, `Vue ${site.name} template callback`)] });
      this.sites.add({ from: this.component.id, to: owner.id, type: 'references', form: 'handler', event: site.name, evidence: owner.evidence[0]! });
    }
    const nameOf = (node: ts.Expression): string | undefined => ts.isIdentifier(node) ? node.text : ts.isPropertyAccessExpression(node) ? nameOf(node.expression) && `${nameOf(node.expression)}.${node.name.text}` : ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) ? nameOf(node.expression) && `${nameOf(node.expression)}.${node.argumentExpression.text}` : undefined;
    const bind = (node: ts.Expression, locals: string[]) => { const name = nameOf(unwrap(node)); return name ? this.binding(name, false, locals) : undefined; };
    const reference = (node: ts.Expression, locals: string[], call: boolean): boolean => {
      const bound = bind(node, locals), target = bound && this.reader.target(bound.node, bound.frame.state.checker);
      if (!target) return false;
      const start = site.start + node.getStart(parsed), end = site.start + node.end;
      this.sites.add({ from: owner.id, to: target.id, type: call ? 'calls' : 'references', form: call ? 'call' : site.kind === 'event' ? 'handler' : 'value', evidence: this.fact(start, end, call ? 'Vue template invokes the bound callable' : 'Vue template references the bound callable'), ...(site.kind === 'event' ? { event: site.name } : {}) });
      return true;
    };
    const visit = (node: ts.Node, locals: string[]): void => {
      if (ts.isFunctionLike(node)) {
        if (!(ts.isExpressionStatement(node.parent) && site.kind === 'event')) { this.gap(site.start + node.getStart(parsed), 'Nested/deferred template callbacks require an invocation summary'); return; }
        const inner = [...locals]; for (const parameter of node.parameters) { if (ts.isIdentifier(parameter.name)) inner.push(parameter.name.text); else { this.gap(site.start + node.getStart(parsed), 'Destructured inline callback scope is outside this subset'); return; } }
        if ('body' in node && node.body) visit(node.body as ts.Node, inner); return;
      }
      if (ts.isBlock(node)) {
        const inner = [...locals]; const collect = (child: ts.Node): void => { if (ts.isVariableDeclaration(child) && ts.isIdentifier(child.name) || ts.isFunctionDeclaration(child) && child.name) inner.push(child.name!.getText()); else if (!ts.isFunctionLike(child)) ts.forEachChild(child, collect); }; ts.forEachChild(node, collect);
        ts.forEachChild(node, child => visit(child, inner)); return;
      }
      if (ts.isCallExpression(node)) {
        const httpBinding = bind(node.expression, locals) ?? (ts.isPropertyAccessExpression(node.expression) ? bind(node.expression.expression, locals) : undefined);
        if (!reference(node.expression, locals, true) && !this.http(node, site, owner, parsed, httpBinding)) {
          const bound = bind(node.expression, locals), external = bound && !ts.isMethodDeclaration(bound.node) && frameworkBinding(bound.node, bound.frame.state.checker, this.scope.services);
          if (!external) this.gap(site.start + node.getStart(parsed), `Template call ${node.expression.getText(parsed)} has no qualified callable binding`);
        }
        for (const argument of node.arguments) visit(argument, locals); return;
      }
      if (ts.isExpressionStatement(node) && site.kind === 'event' && nameOf(node.expression) && !reference(node.expression, locals, true)) this.gap(site.start + node.getStart(parsed), 'Template handler has no qualified callable binding');
      ts.forEachChild(node, child => visit(child, locals));
    };
    visit(parsed, [...site.locals, '$event']);
  }
  private http(call: ts.CallExpression, site: VueTemplateSite, owner: Entity, parsed: ts.SourceFile, bound: Bound | undefined): boolean {
    const callee = call.expression, name = callee.getText(parsed);
    const config = this.scope.services.nuxt.get(this.scope.context.projects!.nodeOwner(this.file.path).id), globalFrames = this.frames.length ? this.frames : this.scope.files.filter(frame => frame.runtime.project.id === config?.project.id), nuxt = !!config?.valid && !config.conditions.length && !bound && !site.locals.includes('$fetch') && !this.bindings.has('$fetch') && !this.blockedComponents.has('$fetch') && ts.isIdentifier(callee) && callee.text === '$fetch' && globalFrames.every(frame => nuxtGlobal(this.scope, frame, callee, '$fetch', false));
    const resolved = bound && !ts.isMethodDeclaration(bound.node) ? this.reader.resolve(bound.node, bound.frame.state.checker) : undefined;
    const fetchSymbol = resolved && bound ? bound.frame.state.checker.getSymbolAtLocation(resolved) : undefined;
    const globalFetch = !!fetchSymbol?.declarations?.length && fetchSymbol.declarations.every(declaration => bound!.frame.state.program.isSourceFileDefaultLibrary(declaration.getSourceFile())) && (ts.isIdentifier(resolved!) && resolved!.text === 'fetch' || ts.isPropertyAccessExpression(resolved!) && resolved!.name.text === 'fetch');
    let method: string | undefined = globalFetch || nuxt ? 'GET' : undefined;
    const axios = bound && !ts.isMethodDeclaration(bound.node) ? frameworkBinding(bound.node, bound.frame.state.checker, this.scope.services) : undefined;
    const axiosMethod = axios?.member === 'default' && ts.isPropertyAccessExpression(callee) ? callee.name.text : axios?.member;
    if (axios?.module === 'axios' && axiosMethod && ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'].includes(axiosMethod)) method = axiosMethod.toUpperCase();
    if (!method) return false;
    const url = call.arguments[0], options = call.arguments[1];
    if ((globalFetch || nuxt) && options) {
      if (!ts.isObjectLiteralExpression(options) || options.properties.some(property => !ts.isPropertyAssignment(property) || !propertyName(property.name))) method = undefined;
      else for (const property of options.properties) if (ts.isPropertyAssignment(property)) { if (propertyName(property.name) === 'method') method = ts.isStringLiteralLike(property.initializer) ? normalizeFetchMethod(nuxt ? property.initializer.text.toUpperCase() : property.initializer.text) : undefined; else if (nuxt && !['body', 'headers', 'credentials', 'query', 'params', 'retry', 'timeout'].includes(propertyName(property.name)!)) method = undefined; }
    }
    const start = site.start + call.getStart(parsed), end = site.start + call.end;
    if (!method || !url || !ts.isStringLiteralLike(url) || call.arguments.some(ts.isSpreadElement)) { this.gap(start, 'Template HTTP call requires a literal URL and method', 'vue-template-http-gap'); return true; }
    const fact = this.fact(start, end, `${name} HTTP call in Vue template ${site.kind}`), effect: EffectFact = { category: 'network', operation: method, detail: url.text, line: fact.line!, via: name };
    (owner.metadata.effects as EffectFact[] | undefined ?? (owner.metadata.effects = []) as EffectFact[]).push(effect);
    this.scope.context.http.push({ callerId: owner.id, fileId: this.file.id, method, url: nuxt ? nuxtFetchPath(url.text, config!.base) : url.text, ...(nuxt ? { transport: 'nuxt-fetch' as const } : {}), expression: url.getText(parsed), evidence: fact, effect });
    const file = this.scope.context.graph.entities.get(this.file.id)!;
    (file.metadata.httpRequests as unknown[] | undefined ?? (file.metadata.httpRequests = []) as unknown[]).push({ callerId: owner.id, method, url: url.text, expression: url.getText(parsed), line: fact.line, resolution: 'literal' });
    return true;
  }
}
function setupRuntimeExport(statement: ts.Statement): boolean {
  if (ts.isExportAssignment(statement)) return true;
  if (ts.isExportDeclaration(statement)) return !statement.isTypeOnly || !statement.exportClause;
  if (ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement)) return false;
  return ts.canHaveModifiers(statement) && !!ts.getModifiers(statement)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword);
}
const vueBuiltins = new Set(['RouterView', 'RouterLink', 'router-view', 'router-link', 'Transition', 'TransitionGroup', 'KeepAlive', 'Teleport', 'Suspense']);
const nuxtBuiltins = new Set(['NuxtPage', 'NuxtLayout', 'NuxtLink', 'NuxtLoadingIndicator', 'NuxtErrorBoundary', 'ClientOnly', 'DevOnly', 'nuxt-page', 'nuxt-layout', 'nuxt-link', 'nuxt-loading-indicator', 'nuxt-error-boundary', 'client-only', 'dev-only']);
// Vue's default HTML/SVG/MathML parser profile. Uppercase imported names keep
// their component meaning; a binding named `input` cannot replace <input>.
const nativeTags = new Set(('html,body,base,head,link,meta,style,title,address,article,aside,footer,header,h1,h2,h3,h4,h5,h6,hgroup,nav,section,div,dd,dl,dt,figcaption,figure,picture,hr,img,li,main,ol,p,pre,ul,a,b,abbr,bdi,bdo,br,cite,code,data,dfn,em,i,kbd,mark,q,rp,rt,ruby,s,samp,small,span,strong,sub,sup,time,u,var,wbr,area,audio,map,track,video,embed,object,param,source,canvas,script,noscript,del,ins,caption,col,colgroup,table,thead,tbody,td,th,tr,button,datalist,fieldset,form,input,label,legend,meter,optgroup,option,output,progress,select,textarea,details,dialog,menu,summary,template,blockquote,iframe,tfoot,svg,animate,animateMotion,animateTransform,circle,clipPath,color-profile,defs,desc,ellipse,feBlend,feColorMatrix,feComponentTransfer,feComposite,feConvolveMatrix,feDiffuseLighting,feDisplacementMap,feDistantLight,feDropShadow,feFlood,feFuncA,feFuncB,feFuncG,feFuncR,feGaussianBlur,feImage,feMerge,feMergeNode,feMorphology,feOffset,fePointLight,feSpecularLighting,feSpotLight,feTile,feTurbulence,filter,foreignObject,g,hatch,hatchpath,image,line,linearGradient,marker,mask,mesh,meshgradient,meshpatch,meshrow,metadata,mpath,path,pattern,polygon,polyline,radialGradient,rect,set,solidcolor,stop,switch,symbol,text,textPath,tspan,unknown,use,view,math,maction,maligngroup,malignmark,menclose,merror,mfenced,mfrac,mglyph,mi,mlabeledtr,mlongdiv,mmultiscripts,mn,mo,mover,mpadded,mphantom,mroot,mrow,ms,mscarries,mscarry,msgroup,msline,mspace,msqrt,msrow,mstack,mstyle,msub,msubsup,msup,mtable,mtd,mtext,mtr,munder,munderover,semantics,annotation,annotation-xml').split(','));
