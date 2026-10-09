import { normalizeFetchMethod } from '../routes/http-method.js';
import ts from 'typescript';
import path from 'node:path';
import { matchesGlob } from '../../core/config.js';
import type { ScannedFile } from '../../core/analyzer.js';
import { declarationHashes, evidence, type Entity, type Evidence } from '../../core/graph.js';
import { SiteCollector } from '../../analyzers/references.js';
import { fileAnalysis } from '../facts.js';
import { SourceText } from '../source-map.js';
import { sourceMapped } from '../embedded/index.js';
import { runtimeReference } from '../languages/typescript-runtime.js';
import { TypeScriptStatic, profile } from './typescript-static.js';
import { valueDeclaration } from './typescript-binding.js';
import { nodeSite, type TypeScriptFrameworkPack, type TypeScriptPackFile, type TypeScriptPackScope } from './typescript-pack.js';
import { astroRoutes, astroInvocations } from './astro-routes.js';
import type { AstroConfig } from './astro-config.js';

type Js = { type: string; start: number; end: number; [key: string]: unknown };
type Bound = { node: ts.Expression; frame: TypeScriptPackFile };
const js = (value: unknown): Js | undefined => value && typeof value === 'object' && typeof (value as Js).type === 'string' && typeof (value as Js).start === 'number' ? value as Js : undefined;
const children = (node: Js): Js[] => Object.entries(node).filter(([key]) => !['loc', 'start', 'end', 'type', 'parent', 'typeAnnotation', 'typeArguments', 'typeParameters', 'returnType'].includes(key)).flatMap(([, value]) => Array.isArray(value) ? value.flatMap(item => js(item) ?? []) : js(value) ? [js(value)!] : []);
const nameOf = (node: Js | undefined): string | undefined => !node ? undefined : ['Identifier', 'JSXIdentifier'].includes(node.type) ? String(node.name) : ['MemberExpression', 'JSXMemberExpression'].includes(node.type) && !node.computed ? nameOf(js(node.object)) && nameOf(js(node.property)) ? `${nameOf(js(node.object))}.${nameOf(js(node.property))}` : undefined : node.type === 'ChainExpression' ? nameOf(js(node.expression)) : undefined;
function names(value: unknown): string[] { const node = js(value); if (!node) return []; if (node.type === 'Identifier') return [String(node.name)]; if (node.type === 'RestElement') return names(node.argument); if (node.type === 'AssignmentPattern') return names(node.left); if (node.type === 'ObjectPattern') return (node.properties as unknown[]).flatMap(item => names(js(item)?.value ?? js(item)?.argument)); if (node.type === 'ArrayPattern') return (node.elements as unknown[]).flatMap(names); return []; }

export const astroPack: TypeScriptFrameworkPack = {
  id: 'astro', version: '1.0.2:parser-0.5.1', includeEmbedded: true,
  applies: scope => !!scope.inputs?.some(file => file.language === 'astro') || scope.files.some(frame => frame.runtime.project.dependencies.astro !== undefined),
  async declare(scope) {
    const reader = new TypeScriptStatic(scope, 'astro', ['astro/config', 'astro:middleware']);
    const files = scope.inputs?.filter(file => file.language === 'astro') ?? [];
    if (files.length) {
      const { parse } = await import('@astrojs/compiler-rs');
      for (const file of files) new AstroComponent(scope, reader, file, parse).run();
    }
    astroRoutes(scope, reader);
  },
  finish: astroInvocations,
};

class AstroComponent {
  private readonly bindings = new Map<string, Bound>();
  private readonly sites = new SiteCollector();
  private readonly occurrences = new Map<string, number>();
  private text = ''; private source!: SourceText; private component!: Entity; private steps = 0;
  private config?: AstroConfig;
  constructor(private readonly scope: TypeScriptPackScope, private readonly reader: TypeScriptStatic, private readonly file: ScannedFile, private readonly parse: typeof import('@astrojs/compiler-rs').parse) {}
  private fact(start: number, end: number, reason: string): Evidence { const range = this.source.range(start, end); return { ...evidence('framework', 'astro', this.file.path, range.startLine, reason), endLine: range.endLine }; }
  private gap(start: number, reason: string, code = 'astro-template-gap'): void { this.scope.context.graph.diagnose({ analyzer: 'astro', severity: 'warning', code, file: this.file.path, line: this.source.position(start).line, entityId: this.file.id, reason }); }
  run(): void {
    const { context } = this.scope, file = context.graph.entities.get(this.file.id)!, facts = context.embedded?.facts.get(this.file.path), analysis = fileAnalysis(file.metadata.analysis);
    if (typeof file.metadata.component !== 'string' || !facts) return;
    this.text = context.sources?.readFile(this.file.absolutePath) ?? ''; this.source = new SourceText(this.text); this.component = context.graph.entities.get(file.metadata.component)!;
    const project = context.projects?.nodeOwner(this.file.path), version = project?.dependencies.astro;
    this.config = project && this.scope.services.astro.get(project.id);
    if (version && (![5, 6, 7].some(major => profile(version, major)) || !this.config)) { this.gap(0, 'The declared dependency does not qualify an external Astro 5/6/7 profile', 'astro-version-profile'); if (analysis) analysis.features.framework = { status: 'unsupported', reason: 'Unqualified Astro version/package' }; return; }
    if (facts.issues.some(issue => issue.fatal) || facts.regions.some(region => region.role === 'frontmatter' && !region.supported)) { if (analysis) analysis.features.framework = { status: 'failed', reason: 'Malformed/unavailable Astro frontmatter' }; return; }
    let root: Js | undefined;
    try {
      // Unprocessed browser script bodies belong to a separate unsupported
      // profile. Mask them at equal UTF-16 length so they cannot invalidate
      // otherwise valid server/frontmatter and template source.
      let parseText = this.text;
      for (const region of facts.regions) if (region.role === 'client' && !region.supported) parseText = parseText.slice(0, region.start) + parseText.slice(region.start, region.end).replace(/[^\r\n\u2028\u2029]/g, ' ') + parseText.slice(region.end);
      const parsed = this.parse(parseText);
      for (const diagnostic of parsed.diagnostics) this.gap(diagnostic.labels?.[0]?.start ?? 0, diagnostic.text, 'astro-parse-error');
      if (parsed.diagnostics.some(item => item.severity === 'error')) { if (analysis) analysis.features.framework = { status: 'failed', reason: 'Official Astro parser rejected the original component' }; return; }
      root = js(parsed.ast);
    } catch (error) { this.gap(0, String(error), 'astro-parse-error'); if (analysis) analysis.features.framework = { status: 'failed', reason: 'Astro parser failed' }; return; }
    if (!root || root.end !== this.text.length) { this.gap(0, 'Parser offsets do not map to the original UTF-16 source', 'astro-source-map-gap'); return; }
    if (!version) this.gap(0, 'No declared Astro version; common component syntax is analyzed without filesystem route qualification', 'astro-version-profile');
    file.metadata.frameworkPacks = [...new Set([...(file.metadata.frameworkPacks as string[] | undefined ?? []), 'astro'])];
    file.metadata.frameworkParser = { name: '@astrojs/compiler-rs', version: '0.5.1' };
    this.component.metadata.profile = this.config?.profile ?? 'astro-common'; this.component.metadata.executionContext = 'server'; this.component.metadata.astroParsed = true;
    if (analysis) { analysis.features.framework = { status: 'partial', reason: 'Astro 5/6/7 static components, qualified renderer islands and filesystem routing; dynamic integrations retain gaps' }; analysis.features.references = { status: 'partial', reason: 'Original scripts and lexically scoped template bindings' }; analysis.features.effects = { status: 'partial', reason: 'Original script effects and bounded server template fetch calls' }; }
    for (const frame of this.scope.files.filter(frame => frame.file.path === this.file.path)) {
      if (frame.file.embedded?.role === 'frontmatter') { this.topLevel(frame); const owner = frame.owners.get(frame.source); if (owner) context.graph.relate(this.component.id, owner.id, 'calls', [this.fact(frame.file.embedded.start, frame.file.embedded.end, 'Astro server rendering evaluates its frontmatter')], { role: 'frontmatter', executionContext: 'server' }); }
      else if (frame.file.embedded?.role === 'client') { const owner = frame.owners.get(frame.source); if (owner) { owner.metadata.astroInvocation = true; owner.metadata.registeredTarget = owner.id; owner.metadata.registrationFile = this.file.path; owner.metadata.directive = 'processed-script'; context.graph.relate(this.component.id, owner.id, 'references', [this.fact(frame.file.embedded.start, frame.file.embedded.end, 'Processed browser script belongs to this original Astro component')], { role: 'client-script', executionContext: 'browser' }); } }
    }
    for (const node of root.body as unknown[]) { const value = js(node); if (value) this.visit(value, new Set(), 0); }
    if (this.steps > 30000) this.gap(0, 'Astro template exceeded its 30,000-node traversal budget', 'astro-template-budget');
    this.sites.flush(context.graph);
  }
  private topLevel(frame: TypeScriptPackFile): void {
    const add = (name: ts.BindingName): void => { if (ts.isIdentifier(name)) this.bindings.set(name.text, { node: name, frame }); else for (const item of name.elements) if (ts.isBindingElement(item)) add(item.name); };
    for (const statement of frame.source.statements) {
      if (!sourceMapped(this.scope.context, frame.source.fileName, statement.getStart(frame.source), statement.end)) continue;
      if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) add(declaration.name);
      else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) add(statement.name);
      else if (ts.isImportDeclaration(statement) && statement.importClause && !statement.importClause.isTypeOnly) {
        const clause = statement.importClause; if (clause.name) add(clause.name);
        if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) add(clause.namedBindings.name);
        else if (clause.namedBindings) for (const item of clause.namedBindings.elements) if (!item.isTypeOnly) add(item.name);
      }
    }
  }
  private binding(name: string, locals: Set<string>): Bound | undefined {
    const [base, ...members] = name.split('.'); if (!base || locals.has(base)) return undefined;
    let bound = this.bindings.get(base);
    const declaration = bound && valueDeclaration(bound.node, bound.frame.state.checker);
    if (declaration && this.reader.writes.has(nodeSite(declaration))) return undefined;
    for (const member of members) {
      if (!bound || !runtimeReference(bound.node, bound.frame.state.checker, member)) return undefined;
      const checker = bound.frame.state.checker;
      let symbol = checker.getSymbolAtLocation(bound.node); if (symbol?.flags && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
      let target = symbol?.flags && symbol.flags & ts.SymbolFlags.Module ? checker.getExportsOfModule(symbol).find(item => item.name === member) : checker.getTypeAtLocation(bound.node).getProperty(member);
      if (target?.flags && target.flags & ts.SymbolFlags.Alias) target = checker.getAliasedSymbol(target);
      const declaration = target?.valueDeclaration ?? target?.declarations?.[0];
      if (declaration && (ts.isVariableDeclaration(declaration) || ts.isFunctionDeclaration(declaration) || ts.isClassDeclaration(declaration)) && declaration.name && ts.isIdentifier(declaration.name)) bound = { ...bound, node: declaration.name };
      else if (declaration && ts.isExportAssignment(declaration)) bound = { ...bound, node: declaration.expression };
      else return undefined;
    }
    return bound;
  }
  private reference(node: Js, locals: Set<string>, call = false): boolean {
    const name = nameOf(node), bound = name && this.binding(name, locals), target = bound && this.reader.target(bound.node, bound.frame.state.checker);
    if (!target) return false;
    this.sites.add({ from: this.component.id, to: target.id, type: call ? 'calls' : 'references', form: call ? 'call' : 'value', evidence: this.fact(node.start, node.end, `Astro server template ${call ? 'invokes' : 'references'} its indexed binding`) }); return true;
  }
  private element(node: Js, locals: Set<string>, depth: number): void {
    const opening = js(node.openingElement)!, tag = js(opening.name), name = nameOf(tag), attributes = (opening.attributes as unknown[]).map(js).filter((node): node is Js => !!node);
    const directives = attributes.filter(attribute => nameOf(js(attribute.name))?.startsWith('client:'));
    if (name && (/^[A-Z]/.test(name) || name.includes('.'))) {
      const bound = this.binding(name, locals), target = bound && this.reader.target(bound.node, bound.frame.state.checker);
      if (target?.type === 'component') {
        const renderer = this.renderer(target), filters = renderer ? this.config?.rendererFilters[renderer] : undefined, relative = target.path && path.posix.relative(this.config?.project.root ?? '.', target.path);
        const included = !!relative && (!filters?.include || filters.include.some(glob => matchesGlob(relative, glob))) && !filters?.exclude?.some(glob => matchesGlob(relative, glob));
        const qualified = target.language === 'astro' || renderer && this.config?.valid && this.config.renderers.includes(renderer) && included;
        if (qualified) {
          if (!directives.some(attribute => nameOf(js(attribute.name)) === 'client:only')) this.scope.context.graph.relate(this.component.id, target.id, 'renders', [this.fact(opening.start, opening.end, `Astro server template renders indexed ${name}, preserving its original ${target.language} component identity`)], { executionContext: 'server' });
          if (directives.length) this.island(opening, name, target, renderer, directives, bound!);
        } else { this.reference(tag!, locals); this.gap(opening.start, `Component ${name} requires a statically declared renderer integration`, 'astro-renderer-gap'); }
      } else if (!locals.has(name.split('.')[0]!)) this.gap(opening.start, `Dynamic/unbound component ${name} is unresolved`);
    } else if (directives.length) this.gap(opening.start, 'Client hydration directives require an imported UI framework component', 'astro-hydration-gap');
    for (const attribute of attributes) {
      const key = nameOf(js(attribute.name));
      if (key === 'server:defer') this.gap(attribute.start, 'Server islands require an adapter/injected-route summary', 'astro-server-island-gap');
      if (key === 'set:html') this.gap(attribute.start, 'Injected HTML cannot prove additional component identities');
      if (key && /^on/i.test(key) && !/^[A-Z]/.test(name ?? '')) this.gap(attribute.start, 'Astro native event attributes are serialized HTML; browser callbacks require client script proof', 'astro-native-event-gap');
      if (!key?.startsWith('client:')) for (const value of children(attribute).filter(child => child !== js(attribute.name))) this.visit(value, locals, depth + 1);
    }
    if (['script', 'style'].includes(name ?? '') || attributes.some(attribute => nameOf(js(attribute.name)) === 'is:raw' || ['set:html', 'set:text'].includes(nameOf(js(attribute.name)) ?? ''))) return;
    for (const child of node.children as unknown[]) { const value = js(child); if (value) this.visit(value, locals, depth + 1); }
  }
  private renderer(target: Entity): string | undefined {
    if (target.language === 'vue' || target.language === 'svelte') return target.language;
    if (!['typescript', 'javascript'].includes(target.language ?? '') || !target.path) return undefined;
    const text = this.scope.context.sources?.readFile(path.resolve(this.scope.context.root, target.path)) ?? '';
    const pragma = /(?:\/\*|\*)\s*@jsxImportSource\s+([^\s*]+)/.exec(text)?.[1];
    const importSource = pragma ?? this.scope.services.projectFor(target.path)?.program().getCompilerOptions().jsxImportSource ?? 'react';
    return importSource === 'react' ? 'react' : undefined;
  }
  private island(opening: Js, name: string, target: Entity, renderer: string | undefined, directives: Js[], bound: Bound): void {
    const directive = nameOf(js(directives[0]!.name))!;
    const value = js(directives[0]!.value), literal = value?.type === 'JSXExpressionContainer' ? js(value.expression) : value;
    const declaration = bound.frame.state.checker.getSymbolAtLocation(this.bindings.get(name.split('.')[0]!)!.node)?.declarations?.[0];
    const imported = declaration && [ts.isImportSpecifier, ts.isImportClause, ts.isNamespaceImport].some(test => test(declaration));
    if (!renderer || directives.length !== 1 || !['client:load', 'client:idle', 'client:visible', 'client:media', 'client:only'].includes(directive) || !imported || (directive === 'client:only' && literal?.value !== renderer) || (directive === 'client:media' && typeof literal?.value !== 'string')) { this.gap(opening.start, 'Unsupported/dynamic/multiple hydration directives or non-imported UI component', 'astro-hydration-gap'); return; }
    const key = `${name}:${directive}:${this.text.slice(opening.start, opening.end)}`, ordinal = this.occurrences.get(key) ?? 0; this.occurrences.set(key, ordinal + 1);
    const graph = this.scope.context.graph, fact = this.fact(opening.start, opening.end, `Astro ${directive} supplies browser invocation context to the original ${renderer} component`);
    const island = graph.contain({ id: graph.id('astro-island', this.file.path, key, String(ordinal)), type: 'function', name: `${name} ${directive}`, path: this.file.path, language: 'astro', parentId: this.component.id, sourceRange: this.source.range(opening.start, opening.end), metadata: { framework: 'astro', role: 'hydrated-island', astroInvocation: true, registeredTarget: target.id, executionContext: 'browser', registrationFile: this.file.path, renderer, directive, ssr: directive !== 'client:only', qualifiedName: `island.${name}.${ordinal}`, ...declarationHashes(this.text.slice(opening.start, opening.end), 0) }, evidence: [fact] });
    graph.relate(this.component.id, island.id, 'references', [fact], { role: 'hydrated-island' }); graph.relate(island.id, target.id, 'renders', [fact], { executionContext: 'browser' });
  }
  private visit(node: Js, locals: Set<string>, depth: number): void {
    if (++this.steps > 30000 || depth > 64) { this.gap(0, 'Astro template exceeded its depth/site traversal budget', 'astro-template-budget'); return; }
    if (['AstroComment', 'JSXText', 'AstroScript', 'AstroStyle', 'Literal', 'JSXEmptyExpression'].includes(node.type)) return;
    if (node.type === 'JSXElement') { this.element(node, locals, depth); return; }
    if (['ArrowFunctionExpression', 'FunctionExpression', 'FunctionDeclaration'].includes(node.type)) { this.gap(node.start, 'Deferred template callback has no proven invocation summary'); return; }
    if (['BlockStatement', 'CatchClause', 'ForStatement', 'ForOfStatement', 'ForInStatement'].includes(node.type)) {
      const next = new Set(locals), collect = (value: Js): void => { if (value.type === 'VariableDeclarator') for (const name of names(value.id)) next.add(name); else if (['FunctionDeclaration', 'ClassDeclaration'].includes(value.type)) for (const name of names(value.id)) next.add(name); else if (!['ArrowFunctionExpression', 'FunctionExpression'].includes(value.type)) for (const child of children(value)) collect(child); };
      for (const child of children(node)) collect(child); for (const name of names(node.param)) next.add(name); for (const child of children(node)) this.visit(child, next, depth + 1); return;
    }
    if (node.type === 'CallExpression') {
      const callee = js(node.callee), receiver = callee?.type === 'MemberExpression' ? js(callee.object) : undefined, name = nameOf(callee), bound = receiver && nameOf(receiver) && this.binding(nameOf(receiver)!, locals);
      const array = receiver?.type === 'ArrayExpression' || bound && ts.isArrayLiteralExpression(this.reader.resolve(bound.node, bound.frame.state.checker) ?? bound.node);
      const immediate = array && ['map', 'flatMap', 'filter', 'forEach', 'some', 'every', 'find'].includes(String(js(callee?.property)?.name));
      if (callee && ['ArrowFunctionExpression', 'FunctionExpression'].includes(callee.type)) { const scoped = new Set(locals); for (const name of (callee.params as unknown[]).flatMap(names)) scoped.add(name); for (const name of names(callee.id)) scoped.add(name); const body = js(callee.body); if (body) this.visit(body, scoped, depth + 1); }
      if (callee && !this.reference(callee, locals, true) && !this.http(node, locals) && !immediate && name && !locals.has(name.split('.')[0]!)) this.gap(callee.start, `Template call ${name} has no qualified invocation binding`);
      for (const argument of node.arguments as unknown[]) {
        const value = js(argument); if (!value) continue;
        if (immediate && ['ArrowFunctionExpression', 'FunctionExpression'].includes(value.type)) { const scoped = new Set(locals); for (const name of (value.params as unknown[]).flatMap(names)) scoped.add(name); for (const name of names(value.id)) scoped.add(name); const body = js(value.body); if (body) this.visit(body, scoped, depth + 1); }
        else this.visit(value, locals, depth + 1);
      }
      return;
    }
    if (nameOf(node)) { this.reference(node, locals); return; }
    for (const child of children(node)) this.visit(child, locals, depth + 1);
  }
  private http(node: Js, locals: Set<string>): boolean {
    if (nameOf(js(node.callee)) !== 'fetch' || locals.has('fetch') || this.bindings.has('fetch')) return false;
    const args = node.arguments as unknown[], url = js(args[0]), options = js(args[1]); let method: string | undefined = 'GET';
    if (options) {
      if (options.type !== 'ObjectExpression') method = undefined;
      else for (const item of options.properties as unknown[]) { const property = js(item), key = js(property?.key), value = js(property?.value); if (!property || property.type !== 'Property' || property.computed) { method = undefined; break; } if (key?.name === 'method' || key?.value === 'method') method = normalizeFetchMethod(value?.value); }
    }
    if (!method || url?.type !== 'Literal' || typeof url.value !== 'string') { this.gap(node.start, 'Dynamic template fetch URL/method requires a value summary', 'astro-http-gap'); return true; }
    const fact = this.fact(node.start, node.end, 'Astro server template fetch call'), effect = this.sites.effect(this.component.id, { category: 'network', operation: method, detail: url.value, line: fact.line!, via: 'fetch' });
    this.scope.context.http.push({ callerId: this.component.id, fileId: this.file.id, method, url: url.value, expression: this.text.slice(node.start, node.end), evidence: fact, effect }); return true;
  }
}
