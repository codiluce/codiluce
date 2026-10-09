import { normalizeFetchMethod } from '../routes/http-method.js';
import ts from 'typescript';
import type { AST } from 'svelte/compiler';
import type { ScannedFile } from '../../core/analyzer.js';
import { declarationHashes, evidence, type Entity, type Evidence } from '../../core/graph.js';
import { fileAnalysis } from '../facts.js';
import { SourceText } from '../source-map.js';
import { sourceMapped } from '../embedded/index.js';
import { runtimeReference } from '../languages/typescript-runtime.js';
import { SiteCollector } from '../../analyzers/references.js';
import { frameworkBinding } from './typescript-binding.js';
import { sourceRange, type TypeScriptFrameworkPack, type TypeScriptPackScope, type TypeScriptPackFile } from './typescript-pack.js';
import { TypeScriptStatic, profile } from './typescript-static.js';
import { browserInvocations } from './browser-invocations.js';
import { svelteKit } from './sveltekit.js';
import { kitInvocations } from './sveltekit-invocations.js';

type Bound = { node: ts.Expression; frame: TypeScriptPackFile };
type Js = { type: string; start: number; end: number; [key: string]: unknown };
type Locals = Map<string, Entity | undefined>;
const js = (value: unknown): Js | undefined => value && typeof value === 'object' && typeof (value as Js).type === 'string' && typeof (value as Js).start === 'number' ? value as Js : undefined;
const names = (value: unknown): string[] => {
  const node = js(value); if (!node) return [];
  if (node.type === 'Identifier') return [String(node.name)];
  if (node.type === 'RestElement') return names(node.argument);
  if (node.type === 'AssignmentPattern') return names(node.left);
  if (node.type === 'ObjectPattern' || node.type === 'ObjectExpression') return (node.properties as unknown[]).flatMap(item => names(js(item)?.value ?? js(item)?.argument));
  if (node.type === 'ArrayPattern' || node.type === 'ArrayExpression') return (node.elements as unknown[]).flatMap(names);
  return [];
};
const nameOf = (node: Js | undefined): string | undefined => !node ? undefined : node.type === 'Identifier' ? String(node.name) : node.type === 'MemberExpression' ? nameOf(js(node.object)) && (node.computed ? js(node.property)?.type === 'Literal' && typeof js(node.property)?.value === 'string' ? `${nameOf(js(node.object))}.${js(node.property)!.value}` : undefined : `${nameOf(js(node.object))}.${js(node.property)?.name}`) : node.type === 'ChainExpression' ? nameOf(js(node.expression)) : undefined;

export const sveltePack: TypeScriptFrameworkPack = {
  id: 'svelte-sveltekit', version: '1.0.2:parser-5.57.2', includeEmbedded: true,
  applies: scope => !!scope.inputs?.some(file => file.language === 'svelte') || scope.files.some(frame => frame.runtime.project.dependencies['@sveltejs/kit'] !== undefined),
  async declare(scope) {
    const reader = new TypeScriptStatic(scope, 'svelte', ['svelte', '@sveltejs/kit', '@sveltejs/kit/vite']);
    const files = scope.inputs?.filter(file => file.language === 'svelte') ?? [];
    if (files.length) {
      const { parse } = await import('svelte/compiler');
      for (const file of files) new SvelteComponent(scope, reader, file, parse).run();
    }
    svelteKit(scope, reader);
  },
  finish(scope) { browserInvocations(scope, 'svelte', 'svelteBrowserCallback'); kitInvocations(scope); },
};

class SvelteComponent {
  private readonly frames: TypeScriptPackFile[];
  private readonly bindings = new Map<string, Bound>();
  private readonly sites = new SiteCollector();
  private readonly occurrences = new Map<string, number>();
  private source!: SourceText; private text = ''; private component!: Entity;
  private major: 4 | 5 = 5; private steps = 0;
  constructor(private readonly scope: TypeScriptPackScope, private readonly reader: TypeScriptStatic, private readonly file: ScannedFile, private readonly parse: typeof import('svelte/compiler').parse) { this.frames = scope.files.filter(frame => frame.file.path === file.path); }
  private fact(start: number, end: number, reason: string): Evidence { const range = this.source.range(start, end); return { ...evidence('framework', 'svelte', this.file.path, range.startLine, reason), endLine: range.endLine }; }
  private gap(start: number, reason: string, code = 'svelte-template-gap'): void { this.scope.context.graph.diagnose({ analyzer: 'svelte', severity: 'warning', code, file: this.file.path, line: this.source.position(start).line, entityId: this.file.id, reason }); }
  run(): void {
    const { context } = this.scope, file = context.graph.entities.get(this.file.id)!, facts = context.embedded?.facts.get(this.file.path), analysis = fileAnalysis(file.metadata.analysis);
    if (typeof file.metadata.component !== 'string' || !facts) return;
    this.component = context.graph.entities.get(file.metadata.component)!;
    this.text = context.sources?.readFile(this.file.absolutePath) ?? ''; this.source = new SourceText(this.text);
    const version = context.projects?.nodeOwner(this.file.path).dependencies.svelte;
    if (version && !profile(version, 4) && !profile(version, 5)) { if (analysis) analysis.features.framework = { status: 'unsupported', reason: 'Svelte dependency is outside the qualified 4/5 syntax profiles' }; this.gap(0, `Svelte ${version} is outside the qualified 4/5 profiles`, 'svelte-version-profile'); return; }
    this.major = profile(version, 4) ? 4 : 5;
    if (facts.issues.some(issue => issue.fatal) || analysis?.features.structure.status === 'failed' || facts.regions.some(region => !region.supported)) { if (analysis) analysis.features.framework = { status: 'failed', reason: 'Malformed/unavailable script input prevents Svelte qualification' }; return; }
    let root: AST.Root;
    try { root = this.parse(this.text, { modern: true, filename: this.file.path }); }
    catch (error) {
      const failure = error as { message?: string; position?: number[]; start?: { character?: number } };
      this.gap(failure.position?.[0] ?? failure.start?.character ?? 0, failure.message ?? String(error), 'svelte-parse-error');
      if (analysis) analysis.features.framework = { status: 'failed', reason: 'Official Svelte parser rejected the original component' }; return;
    }
    const syntax = eventSyntax(root.fragment);
    if (syntax.legacy !== undefined && syntax.modern !== undefined) { this.gap(syntax.legacy, 'Svelte rejects mixing on: directives and event attributes in one component', 'svelte-event-syntax'); if (analysis) analysis.features.framework = { status: 'failed', reason: 'Mixed legacy/modern event syntax is invalid Svelte input' }; return; }
    if (!version) this.gap(0, 'No declared Svelte version; only the bounded Svelte 5 common syntax subset is analyzed', 'svelte-version-profile');
    file.metadata.frameworkPacks = [...new Set([...(file.metadata.frameworkPacks as string[] | undefined ?? []), 'svelte'])];
    file.metadata.frameworkParser = { name: 'svelte/compiler', version: '5.57.2' };
    this.component.metadata.profile = `svelte-${this.major}`;
    if (analysis) { analysis.features.framework = { status: 'partial', reason: 'Svelte 4/5 parsed local components, scoped snippets and static callbacks; dynamic props/stores/plugins retain gaps' }; analysis.features.references = { status: 'partial', reason: 'Original script and scoped template component/callback bindings' }; analysis.features.effects = { status: 'partial', reason: 'Script effects and bounded literal template HTTP callbacks' }; }
    for (const frame of [...this.frames].sort((a, b) => Number(a.file.embedded?.role === 'instance') - Number(b.file.embedded?.role === 'instance'))) this.topLevel(frame);
    for (const frame of this.frames) {
      const owner = frame.owners.get(frame.source);
      if (owner) this.sites.add({ from: this.component.id, to: owner.id, type: 'references', form: 'callback', evidence: this.fact(frame.file.embedded!.start, frame.file.embedded!.end, 'Component evaluates its original script initialization scope') });
      this.scriptCallbacks(frame);
    }
    this.fragment(root.fragment, new Map(), this.component);
    if (this.steps > 30000) this.gap(0, 'Svelte template expression traversal exceeded its 30,000-node budget', 'svelte-template-budget');
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
  }
  private binding(name: string, locals: Locals): Bound | undefined {
    const [base, ...members] = name.split('.'); if (!base || locals.has(base)) return undefined;
    let bound = this.bindings.get(base);
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
  private callback(start: number, end: number, name: string, parent: Entity, browser = true, registration = true): Entity {
    const value = this.text.slice(start, end), key = `${name}:${value.replace(/\s+/g, ' ').trim()}`, ordinal = this.occurrences.get(key) ?? 0; this.occurrences.set(key, ordinal + 1);
    const graph = this.scope.context.graph;
    const event = name.endsWith(' event') ? name.slice(0, -6) : name;
    const entity = graph.contain({ id: graph.id('svelte-callback', this.file.path, key, String(ordinal)), type: 'function', name, path: this.file.path, language: 'svelte', parentId: parent.id, sourceRange: this.source.range(start, end), metadata: { framework: 'svelte', role: 'handler', event, svelteBrowserCallback: browser, executionContext: browser ? 'browser' : 'unknown', qualifiedName: `template.${name}.${ordinal}`, ...declarationHashes(value, 0) }, evidence: [this.fact(start, end, `Original Svelte ${name} callback`)] });
    if (registration) this.sites.add({ from: parent.id, to: entity.id, type: 'references', form: 'handler', event, evidence: entity.evidence[0]! }); return entity;
  }
  private scriptCallbacks(frame: TypeScriptPackFile): void {
    const visit = (node: ts.Node): void => {
      if (!ts.isSourceFile(node) && !sourceMapped(this.scope.context, frame.source.fileName, node.getStart(frame.source), node.end)) return;
      if (ts.isCallExpression(node)) {
        const binding = frameworkBinding(node.expression, frame.state.checker, this.scope.services), name = node.expression.getText(frame.source);
        const rune = /^\$effect(?:\.pre)?$/.test(name) || name === '$derived.by';
        const root = ts.isPropertyAccessExpression(node.expression) ? node.expression.expression : node.expression;
        const builtin = rune && ts.isIdentifier(root) && !frame.state.checker.getSymbolAtLocation(root)?.declarations?.length;
        const lifecycle = binding?.module === 'svelte' && ['onMount', 'onDestroy', 'beforeUpdate', 'afterUpdate'].includes(binding.member);
        if (builtin || lifecycle) {
          if (builtin && this.major !== 5) { this.gap(node.getStart(), 'Runes require the Svelte 5 profile'); return; }
          const callback = node.arguments[0], browser = builtin ? name !== '$derived.by' : binding!.member !== 'onDestroy';
          let caller: Entity | undefined;
          for (let parent = node.parent; parent && !caller; parent = parent.parent) caller = frame.owners.get(parent);
          caller ??= this.component;
          if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
            const entity = this.scope.services.declarations.get(callback) ?? this.callback(callback.getStart(), callback.end, builtin ? name : binding!.member, caller, browser);
            entity.metadata.executionContext = browser ? 'browser' : 'unknown'; entity.metadata.svelteBrowserCallback = browser; entity.metadata.embeddedRegion = frame.file.embedded?.key;
            frame.owners.set(callback, entity); this.scope.services.declarations.set(callback, entity);
            this.sites.add({ from: caller.id, to: entity.id, type: 'references', form: 'callback', evidence: this.reader.fact(node, 'Proven Svelte lifecycle/compiler callback registration') });
          } else if (callback) {
            const entity = this.callback(callback.getStart(), callback.end, builtin ? name : binding!.member, caller, browser), target = this.reader.target(callback, frame.state.checker);
            if (target) this.sites.add({ from: entity.id, to: target.id, type: 'calls', form: 'call', evidence: this.reader.fact(callback, 'Proven Svelte lifecycle invokes the bound callback') });
            else this.gap(callback.getStart(), 'Dynamic lifecycle callback is unresolved');
          }
        }
      }
      if (ts.isLabeledStatement(node) && node.label.text === '$' && ts.isSourceFile(node.parent)) {
        const entity = this.callback(node.getStart(), node.end, '$: reactive statement', this.component, false);
        entity.metadata.embeddedRegion = frame.file.embedded?.key; frame.owners.set(node, entity); this.scope.services.declarations.set(node, entity);
      }
      ts.forEachChild(node, visit);
    }; visit(frame.source);
  }
  private fragment(fragment: AST.Fragment | null | undefined, inherited: Locals, owner: Entity, depth = 0): void {
    if (!fragment) return;
    if (depth > 64 || this.steps > 30000) { this.gap(0, 'Svelte template traversal exceeded its depth/site budget', 'svelte-template-budget'); return; }
    const locals = new Map(inherited);
    for (const node of fragment.nodes) {
      if (node.type === 'SnippetBlock') {
        if (this.major !== 5) { this.gap(node.start, 'Snippets require the Svelte 5 profile'); locals.set(node.expression.name, undefined); continue; }
        const name = node.expression.name, entity = this.callback(node.start, node.end, `${name} snippet`, owner, false, false);
        entity.metadata.role = 'snippet'; locals.set(name, entity);
      } else if (node.type === 'ConstTag' || node.type === 'DeclarationTag') for (const declaration of node.declaration.declarations) for (const name of names(declaration.id)) locals.set(name, undefined);
    }
    const scoped = (patterns: unknown[], extra?: string) => { const next = new Map(locals); for (const name of patterns.flatMap(names)) next.set(name, undefined); if (extra) next.set(extra, undefined); return next; };
    for (const node of fragment.nodes) {
      this.steps++;
      if (node.type === 'EachBlock') { this.expression(js(node.expression), locals, owner); this.expression(js(node.key), scoped([node.context], node.index), owner); this.fragment(node.body, scoped([node.context], node.index), owner, depth + 1); this.fragment(node.fallback, locals, owner, depth + 1); }
      else if (node.type === 'AwaitBlock') { this.expression(js(node.expression), locals, owner); this.fragment(node.pending, locals, owner, depth + 1); this.fragment(node.then, scoped([node.value]), owner, depth + 1); this.fragment(node.catch, scoped([node.error]), owner, depth + 1); }
      else if (node.type === 'IfBlock') { this.expression(js(node.test), locals, owner); this.fragment(node.consequent, locals, owner, depth + 1); this.fragment(node.alternate, locals, owner, depth + 1); }
      else if (node.type === 'KeyBlock') { this.expression(js(node.expression), locals, owner); this.fragment(node.fragment, locals, owner, depth + 1); }
      else if (node.type === 'SnippetBlock') { const target = locals.get(node.expression.name); if (target) this.fragment(node.body, scoped(node.parameters), target, depth + 1); }
      else if (node.type === 'ConstTag' || node.type === 'DeclarationTag') for (const declaration of node.declaration.declarations) this.expression(js(declaration.init), locals, owner);
      else if (node.type === 'RenderTag' || node.type === 'ExpressionTag' || node.type === 'HtmlTag') this.expression(js(node.expression), locals, owner);
      else if ('fragment' in node) {
        if (node.type === 'Component' || node.type === 'SvelteComponent' || node.type === 'SvelteSelf') {
          const name = node.type === 'SvelteComponent' ? nameOf(js(node.expression)) : node.name, binding = name ? this.binding(name, locals) : undefined, target = node.type === 'SvelteSelf' ? this.component : binding && this.reader.target(binding.node, binding.frame.state.checker);
          if (target?.type === 'component' && target.language === 'svelte') this.sites.add({ from: owner.id, to: target.id, type: 'renders', form: 'render', evidence: this.fact(node.start, node.end, `Svelte template renders ${name ?? 'self'} through an indexed component binding`) });
          else this.gap(node.start, `Dynamic/unbound Svelte component ${name ?? 'expression'} is unresolved`);
        }
        const inner = new Map(locals);
        for (const attribute of node.attributes) {
          if (attribute.type === 'LetDirective') { for (const name of attribute.expression ? names(attribute.expression) : [attribute.name]) inner.set(name, undefined); continue; }
          if (attribute.type === 'OnDirective') {
            if (attribute.expression) { const value = js(attribute.expression)!; if (!callbackExpression(value)) { this.gap(value.start, 'Event handler value is evaluated during rendering; its returned callback is unresolved'); this.expression(value, locals, owner); continue; } const callback = this.callback(value.start, value.end, `${attribute.name} event`, owner, node.type !== 'Component' && node.type !== 'SvelteComponent'); callback.metadata.event = attribute.name; callback.metadata.modifiers = attribute.modifiers; this.expression(value, locals, callback, true); }
            else this.gap(attribute.start, 'Forwarded component events require an emitter/consumer summary');
          } else if (attribute.type === 'Attribute') {
            const values = attribute.value === true ? [] : Array.isArray(attribute.value) ? attribute.value : [attribute.value];
            for (const value of values) if (value.type === 'ExpressionTag') {
              if (/^on[a-z]/.test(attribute.name) && values.length === 1) {
                if (this.major !== 5) { this.gap(attribute.start, 'Event attributes require the Svelte 5 profile'); continue; }
                const expression = js(value.expression)!; if (!callbackExpression(expression)) { this.gap(expression.start, 'Event handler value is evaluated during rendering; its returned callback is unresolved'); this.expression(expression, locals, owner); continue; } const callback = this.callback(expression.start, expression.end, `${attribute.name.slice(2)} event`, owner, node.type !== 'Component' && node.type !== 'SvelteComponent'); callback.metadata.event = attribute.name.slice(2); this.expression(expression, locals, callback, true);
              } else this.expression(js(value.expression), locals, owner);
            }
          } else if (attribute.type === 'AttachTag') this.gap(attribute.start, 'Attachment invocation semantics are outside the callback profile');
          else if ('expression' in attribute) this.expression(js(attribute.expression), locals, owner);
        }
        this.fragment(node.fragment, inner, owner, depth + 1);
      }
    }
  }
  private expression(root: Js | undefined, inherited: Locals, owner: Entity, handler = false): void {
    if (!root) return;
    const reference = (node: Js, locals: Locals, call: boolean): boolean => {
      const name = nameOf(node); if (!name) return false;
      const local = locals.get(name), bound = this.binding(name, locals), target = local ?? (bound && this.reader.target(bound.node, bound.frame.state.checker));
      if (!target) return false;
      this.sites.add({ from: owner.id, to: target.id, type: call ? 'calls' : 'references', form: call ? 'call' : 'value', evidence: this.fact(node.start, node.end, `Svelte template ${call ? 'invokes' : 'references'} the bound callable`) }); return true;
    };
    const visit = (node: Js, locals: Locals, depth: number): void => {
      if (++this.steps > 30000 || depth > 64) return;
      if (['ArrowFunctionExpression', 'FunctionExpression', 'FunctionDeclaration'].includes(node.type)) {
        if (node !== root || !handler) { this.gap(node.start, 'Deferred template callback requires an invocation summary'); return; }
        const next = new Map(locals); for (const name of (node.params as unknown[]).flatMap(names)) next.set(name, undefined); if (js(node.id)?.name) next.set(String(js(node.id)!.name), undefined);
        const body = js(node.body); if (body) visit(body, next, depth + 1); return;
      }
      if (node.type === 'BlockStatement' || node.type === 'CatchClause' || node.type === 'ForStatement' || node.type === 'ForOfStatement' || node.type === 'ForInStatement') {
        const next = new Map(locals);
        const collect = (value: Js): void => { if (value.type === 'VariableDeclarator') for (const name of names(value.id)) next.set(name, undefined); else if (value.type === 'FunctionDeclaration' || value.type === 'ClassDeclaration') for (const name of names(value.id)) next.set(name, undefined); else if (!['ArrowFunctionExpression', 'FunctionExpression'].includes(value.type)) for (const child of children(value)) collect(child); };
        for (const child of children(node)) collect(child); for (const name of names(node.param)) next.set(name, undefined);
        for (const child of children(node)) visit(child, next, depth + 1); return;
      }
      if (node.type === 'CallExpression') {
        const callee = js(node.callee);
        const rune = nameOf(callee);
        if (this.major === 5 && (rune === '$derived' || rune === '$derived.by') && !locals.has('$derived') && !this.bindings.has('$derived')) {
          const args = node.arguments as unknown[];
          if (rune === '$derived.by' && js(args[0])) { const callback = js(args[0])!, calculation = this.callback(callback.start, callback.end, '$derived.by calculation', owner, false); this.expression(callback, locals, calculation, true); }
          else for (const argument of args) { const child = js(argument); if (child) visit(child, locals, depth + 1); }
          return;
        }
        if (callee && !reference(callee, locals, true) && !this.http(node, locals, owner)) { const name = nameOf(callee); if (name && !locals.has(name.split('.')[0]!)) this.gap(callee.start, `Template call ${name} has no qualified callable binding`); }
        for (const argument of node.arguments as unknown[]) { const child = js(argument); if (child) visit(child, locals, depth + 1); } return;
      }
      if (node === root && nameOf(node)) { if (!reference(node, locals, handler) && handler && !locals.has(nameOf(node)!.split('.')[0]!)) this.gap(node.start, 'Dynamic/unbound event handler is unresolved'); return; }
      for (const child of children(node)) visit(child, locals, depth + 1);
    };
    visit(root, new Map(inherited), 0);
  }
  private http(node: Js, locals: Locals, owner: Entity): boolean {
    const callee = js(node.callee), name = nameOf(callee); if (!name) return false;
    const base = name.split('.')[0]!; if (locals.has(base)) return false;
    const bound = this.bindings.get(base), resolved = bound && this.reader.resolve(bound.node, bound.frame.state.checker);
    const symbol = resolved && bound?.frame.state.checker.getSymbolAtLocation(resolved);
    const fetchAlias = !!symbol?.declarations?.length && symbol.declarations.every(declaration => bound!.frame.state.program.isSourceFileDefaultLibrary(declaration.getSourceFile())) && ts.isIdentifier(resolved!) && resolved!.text === 'fetch';
    const globalFetch = name === 'fetch' && !bound || fetchAlias && name === base;
    const axios = bound && frameworkBinding(bound.node, bound.frame.state.checker, this.scope.services), member = axios?.member === 'default' ? name.split('.')[1] : axios?.member;
    let method = globalFetch ? 'GET' : axios?.module === 'axios' && member && ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'].includes(member) ? member.toUpperCase() : undefined;
    if (!method) return false;
    const args = node.arguments as unknown[], url = js(args[0]), options = js(args[1]);
    if (globalFetch && options) {
      if (options.type !== 'ObjectExpression') { this.gap(options.start, 'Dynamic fetch options prevent method qualification'); return true; }
      for (const item of options.properties as unknown[]) {
        const property = js(item), key = js(property?.key), value = js(property?.value);
        if (!property || property.type !== 'Property' || property.computed) { method = undefined; break; }
        if (key?.name === 'method' || key?.value === 'method') method = normalizeFetchMethod(value?.value);
      }
    }
    if (!method || url?.type !== 'Literal' || typeof url.value !== 'string') { this.gap(node.start, 'Dynamic template HTTP URL/method requires a value summary', 'svelte-http-gap'); return true; }
    const fact = this.fact(node.start, node.end, 'Svelte template HTTP call'), effect = this.sites.effect(owner.id, { category: 'network', operation: method, detail: url.value, line: fact.line!, via: globalFetch ? 'fetch' : 'axios' });
    this.scope.context.http.push({ callerId: owner.id, fileId: this.file.id, method, url: url.value, expression: this.text.slice(node.start, node.end), evidence: fact, effect }); return true;
  }
}
function children(node: Js): Js[] { return Object.entries(node).filter(([key]) => !['loc', 'start', 'end', 'type', 'parent'].includes(key)).flatMap(([, value]) => Array.isArray(value) ? value.flatMap(item => js(item) ?? []) : js(value) ? [js(value)!] : []); }
function callbackExpression(node: Js): boolean { return ['Identifier', 'MemberExpression', 'ArrowFunctionExpression', 'FunctionExpression'].includes(node.type) || node.type === 'ChainExpression' && !!nameOf(node); }
function eventSyntax(fragment: AST.Fragment): { legacy?: number; modern?: number } {
  const result: { legacy?: number; modern?: number } = {}; let steps = 0;
  const visit = (value: unknown, depth: number): void => { if (!value || typeof value !== 'object' || depth > 64 || ++steps > 30000) return; const node = value as Record<string, unknown>;
    if (node.type === 'OnDirective') result.legacy = Number(node.start);
    if (node.type === 'Attribute' && typeof node.name === 'string' && /^on[a-z]/.test(node.name) && node.value !== true) result.modern = Number(node.start);
    for (const [key, child] of Object.entries(node)) if (!['loc', 'name_loc', 'expression'].includes(key)) { if (Array.isArray(child)) for (const item of child) visit(item, depth + 1); else if (child && typeof child === 'object') visit(child, depth + 1); }
  }; visit(fragment, 0); return result;
}
