// HTTP request sites in TypeScript/JavaScript, and the wrappers around them.
//
// A site is a `fetch(url, init)` of the Fetch API, a call on the default
// export of `axios` (`axios.get(url)`), or a call on an axios instance
// (`const api = axios.create({ baseURL })`, imported or local: `api.get(url)`,
// whose URL joins `baseURL` and the path as axios does). Its method and URL
// are evaluated by ts-url.ts.
//
// When a site cannot be resolved only because its URL or method comes from a
// parameter of the function around it — `postJson(url, body)`,
// `apiFetch(path, init)`, `get: (path) => api.get(path)` — that function is an
// HTTP wrapper. Every call site of the wrapper the type checker resolves is
// evaluated again with the parameters bound to its arguments, through nested
// wrappers too (`getJson(path) → apiFetch(path)`), and each call site that
// resolves becomes a request of its own caller, with the wrapper's site and
// every binding as evidence. Call sites that do not resolve are reported on
// their callers; a wrapper nobody calls stays unresolved.
//
// Inertia visits are requests too: `router.get/post/put/patch/delete(url)` and
// `router.visit(url, { method })` of `@inertiajs/*`, the same verbs on a form
// made by Inertia's `useForm()` (`form.post(url)`, or a destructured
// `post(url)`), and the `<Link href method>` and `<Form action method>`
// elements. A link whose URL cannot be proven (a menu built from data) is
// recorded on its file but is not a finding: it is navigation, not an API call.
import ts from 'typescript';
import path from 'node:path';
import type { AnalysisContext, HttpObservation, ScannedFile } from '../core/analyzer.js';
import { evidence, type EffectFact, type Entity, type Evidence } from '../core/graph.js';
import type { SiteCollector } from './references.js';
import { emptyScope, MISSING_ARGUMENT, type ResolvedUrl, type Scope, type Unresolved, type UrlEvaluator } from './ts-url.js';

export const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']);
const AXIOS_VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head']);
const INERTIA_MODULES = new Set(['@inertiajs/react', '@inertiajs/vue3', '@inertiajs/svelte', '@inertiajs/core', '@inertiajs/inertia', '@inertiajs/inertia-react']);
const INERTIA_VERBS = new Set(['get', 'post', 'put', 'patch', 'delete']);
/** Wrapper nesting followed from a site to its outermost caller, and call sites read per wrapper. */
const MAX_WRAPPER_DEPTH = 4, MAX_CALL_SITES = 300, MAX_PROOF = 12;

export interface HttpSite {
  /** The call (or, for Inertia's `<Link>` and `<Form>`, the JSX element) making the request. */
  node: ts.Node;
  client: 'fetch' | 'axios' | 'axios-instance' | 'inertia';
  /** axios and Inertia: the method named by the member called (`VISIT`: read from the options). */
  verb?: string;
  /** Inertia `<Link>` / `<Form>`: navigation; an unproven URL is not reported as a finding. */
  element?: boolean;
  url?: ts.Expression;
  /** fetch: the init object; axios: the request config. */
  options?: ts.Expression;
  /** axios instance: `baseURL` of its `axios.create` config, and the instance's name. */
  base?: ts.Expression; instance?: string;
  /** The site is known to be unresolvable before evaluating anything (a shadowed identifier, a dynamic config). */
  blocked?: string;
  /** What the request is matched on, for effects (`fetch (Fetch API)`, `axios`, `axios instance api`). */
  via: string;
}
export type SiteOutcome = { method: string; url?: string; resolved?: ResolvedUrl } | (Unresolved & { method?: string });

function literalText(node: ts.Node | undefined): string | undefined { return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined; }
function short(node: ts.Node, max = 60): string { const text = node.getText().replace(/\s+/g, ' '); return text.length > max ? `${text.slice(0, max - 1)}…` : text; }
function bindingHas(name: ts.BindingName, identifier: string): boolean {
  if (ts.isIdentifier(name)) return name.text === identifier;
  return name.elements.some(element => ts.isBindingElement(element) && bindingHas(element.name, identifier));
}
/** Whether `identifier` is bound by a local declaration between `node` and the module (other than an import of `allowedImport`). */
export function shadowedBinding(node: ts.Node, identifier: string, allowedImport?: string): boolean {
  let scope: ts.Node | undefined = node.parent;
  while (scope) {
    if (ts.isFunctionLike(scope) && scope.parameters.some(param => bindingHas(param.name, identifier))) return true;
    if (ts.isCatchClause(scope) && scope.variableDeclaration && bindingHas(scope.variableDeclaration.name, identifier)) return true;
    if ((ts.isForStatement(scope) || ts.isForOfStatement(scope) || ts.isForInStatement(scope)) && scope.initializer && ts.isVariableDeclarationList(scope.initializer) && scope.initializer.declarations.some(declaration => bindingHas(declaration.name, identifier))) return true;
    if (ts.isBlock(scope) || ts.isSourceFile(scope)) {
      let found = false;
      for (const statement of scope.statements) {
        if (ts.isFunctionDeclaration(statement) && statement.name?.text === identifier) found = true;
        if (ts.isVariableStatement(statement) && statement.declarationList.declarations.some(declaration => bindingHas(declaration.name, identifier))) found = true;
        if (ts.isImportDeclaration(statement) && literalText(statement.moduleSpecifier) !== allowedImport) {
          const clause = statement.importClause;
          if (clause?.name?.text === identifier) found = true;
          if (clause?.namedBindings && (ts.isNamespaceImport(clause.namedBindings) ? clause.namedBindings.name.text === identifier : clause.namedBindings.elements.some(element => element.name.text === identifier))) found = true;
        }
      }
      if (found) return true;
    }
    scope = scope.parent;
  }
  return false;
}
/** The module an identifier is imported from, through the checker (works for identifiers in any file). */
function importedFrom(checker: ts.TypeChecker, identifier: ts.Identifier): string | undefined {
  let symbol: ts.Symbol | undefined;
  try { symbol = checker.getSymbolAtLocation(identifier); } catch { return undefined; }
  let node: ts.Node | undefined = symbol?.declarations?.[0];
  while (node && !ts.isImportDeclaration(node)) node = node.parent;
  return node && ts.isImportDeclaration(node) ? literalText(node.moduleSpecifier) : undefined;
}
/** The module and exported name an identifier is imported as (`import { router as r } from '@inertiajs/react'` → router). */
function importedBinding(checker: ts.TypeChecker, identifier: ts.Identifier): { module: string; name: string } | undefined {
  let symbol: ts.Symbol | undefined;
  try { symbol = checker.getSymbolAtLocation(identifier); } catch { return undefined; }
  const declaration = symbol?.declarations?.[0];
  if (!declaration) return undefined;
  const name = ts.isImportSpecifier(declaration) ? (declaration.propertyName ?? declaration.name).text : ts.isImportClause(declaration) ? 'default' : undefined;
  let node: ts.Node | undefined = declaration;
  while (node && !ts.isImportDeclaration(node)) node = node.parent;
  const module = node && ts.isImportDeclaration(node) ? literalText(node.moduleSpecifier) : undefined;
  return name && module ? { module, name } : undefined;
}
function isInertiaImport(checker: ts.TypeChecker, identifier: ts.Identifier, ...names: string[]): boolean {
  const binding = importedBinding(checker, identifier);
  return !!binding && INERTIA_MODULES.has(binding.module) && names.includes(binding.name);
}
/** Whether an expression is a call of Inertia's `useForm()`. */
function isUseForm(checker: ts.TypeChecker, expression: ts.Expression | undefined): boolean {
  return !!expression && ts.isCallExpression(expression) && ts.isIdentifier(expression.expression) && isInertiaImport(checker, expression.expression, 'useForm');
}
/** Inertia visits made by a call: the router, a `useForm()` form, or one of its destructured methods. */
function inertiaSite(node: ts.CallExpression, checker: ts.TypeChecker): HttpSite | undefined {
  const callee = node.expression;
  const site = (verb: string, via: string, url: ts.Expression | undefined, options?: ts.Expression): HttpSite => ({ node, client: 'inertia', verb, via, ...(url ? { url } : {}), ...(options ? { options } : {}) });
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
    const member = callee.name.text, receiver = callee.expression;
    if (isInertiaImport(checker, receiver, 'router', 'Inertia')) {
      if (INERTIA_VERBS.has(member)) return site(member.toUpperCase(), 'Inertia router', node.arguments[0]);
      if (member === 'visit') return site('VISIT', 'Inertia router', node.arguments[0], node.arguments[1]);
      return undefined;
    }
    let symbol: ts.Symbol | undefined;
    try { symbol = checker.getSymbolAtLocation(receiver); } catch { symbol = undefined; }
    const declaration = symbol?.valueDeclaration;
    if (declaration && ts.isVariableDeclaration(declaration) && isUseForm(checker, declaration.initializer)) {
      if (INERTIA_VERBS.has(member)) return site(member.toUpperCase(), 'Inertia useForm', node.arguments[0]);
      if (member === 'submit') { const method = literalText(node.arguments[0]); return method ? site(method.toUpperCase(), 'Inertia useForm', node.arguments[1]) : { ...site('GET', 'Inertia useForm', node.arguments[1]), blocked: 'The method of form.submit() is not a literal' }; }
    }
    return undefined;
  }
  if (!ts.isIdentifier(callee)) return undefined;
  // const { post } = useForm(…); post(url)
  let symbol: ts.Symbol | undefined;
  try { symbol = checker.getSymbolAtLocation(callee); } catch { symbol = undefined; }
  const declaration = symbol?.valueDeclaration;
  if (!declaration || !ts.isBindingElement(declaration) || !ts.isObjectBindingPattern(declaration.parent) || !ts.isVariableDeclaration(declaration.parent.parent) || !isUseForm(checker, declaration.parent.parent.initializer)) return undefined;
  const member = (declaration.propertyName && ts.isIdentifier(declaration.propertyName) ? declaration.propertyName : ts.isIdentifier(declaration.name) ? declaration.name : undefined)?.text;
  return member && INERTIA_VERBS.has(member) ? site(member.toUpperCase(), 'Inertia useForm', node.arguments[0]) : undefined;
}
/** Inertia's `<Link href method>` and `<Form action method>`: visits made from markup. */
export function detectInertiaElement(node: ts.JsxOpeningLikeElement, checker: ts.TypeChecker): HttpSite | undefined {
  if (!ts.isIdentifier(node.tagName)) return undefined;
  const binding = importedBinding(checker, node.tagName);
  if (!binding || !INERTIA_MODULES.has(binding.module) || !['Link', 'Form', 'InertiaLink'].includes(binding.name)) return undefined;
  const isForm = binding.name === 'Form';
  const attribute = (key: string): ts.Expression | undefined | null => {
    for (const property of node.attributes.properties) {
      if (!ts.isJsxAttribute(property) || property.name.getText() !== key) continue;
      const value = property.initializer;
      if (!value) return null;
      return ts.isStringLiteral(value) ? value : ts.isJsxExpression(value) ? value.expression : null;
    }
    return undefined;
  };
  const url = attribute(isForm ? 'action' : 'href');
  const spread = node.attributes.properties.some(property => ts.isJsxSpreadAttribute(property));
  const via = isForm ? 'Inertia Form' : 'Inertia Link';
  if (!url) return spread ? { node, client: 'inertia', element: true, verb: 'GET', via, blocked: `The ${isForm ? 'action' : 'href'} of this ${via} comes from spread attributes` } : undefined;
  const methodValue = attribute('method');
  const method = methodValue === undefined ? 'GET' : methodValue && literalText(methodValue)?.toUpperCase();
  const site: HttpSite = { node, client: 'inertia', element: true, verb: method ?? 'GET', via, url };
  return method && HTTP_METHODS.has(method) ? site : { ...site, blocked: `The method of this ${via} is not a literal HTTP method` };
}
/** `const api = axios.create(config?)` that an expression refers to (possibly imported from another module). */
function axiosInstance(checker: ts.TypeChecker, expression: ts.Expression): { declaration: ts.VariableDeclaration; config?: ts.Expression } | undefined {
  if (!ts.isIdentifier(expression) && !ts.isPropertyAccessExpression(expression)) return undefined;
  let symbol: ts.Symbol | undefined;
  try {
    symbol = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(expression) ? expression.name : expression);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  } catch { return undefined; }
  const declaration = symbol?.valueDeclaration;
  if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer || !(declaration.parent.flags & ts.NodeFlags.Const)) return undefined;
  const create = declaration.initializer;
  if (!ts.isCallExpression(create) || !ts.isPropertyAccessExpression(create.expression) || create.expression.name.text !== 'create' || !ts.isIdentifier(create.expression.expression)) return undefined;
  if (importedFrom(checker, create.expression.expression) !== 'axios') return undefined;
  return { declaration, ...(create.arguments[0] ? { config: create.arguments[0] } : {}) };
}
function propertyName(name: ts.PropertyName | undefined): string | undefined {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  return literalText(name);
}

/** Recognize an HTTP request site. `axiosNames` are this file's default imports of `axios`. */
export function detectHttpSite(node: ts.CallExpression, checker: ts.TypeChecker, axiosNames: ReadonlySet<string>): HttpSite | undefined {
  const callee = node.expression;
  const inertia = (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) || ts.isIdentifier(callee) ? inertiaSite(node, checker) : undefined;
  if (inertia) return inertia;
  if (ts.isIdentifier(callee) && callee.text === 'fetch') {
    return { node, client: 'fetch', ...(node.arguments[0] ? { url: node.arguments[0] } : {}), ...(node.arguments[1] ? { options: node.arguments[1] } : {}), via: 'fetch (Fetch API)', ...(shadowedBinding(node, 'fetch') ? { blocked: 'fetch identifier has a local binding; cannot prove browser/global fetch' } : {}) };
  }
  if (!ts.isPropertyAccessExpression(callee)) return undefined;
  const member = callee.name.text, receiver = callee.expression;
  const optionIndex = ['get', 'delete', 'head', 'options'].includes(member) ? 1 : 2;
  if (ts.isIdentifier(receiver) && axiosNames.has(receiver.text)) {
    // axios.create(), axios.isAxiosError()…: not requests. axios.request(config) is one, but not resolved.
    if (!AXIOS_VERBS.has(member) && member !== 'request') return undefined;
    const blocked = shadowedBinding(node, receiver.text, 'axios') ? 'axios identifier is shadowed by a local binding' : !AXIOS_VERBS.has(member) ? 'Unsupported axios call form' : undefined;
    return { node, client: 'axios', verb: member.toUpperCase(), ...(node.arguments[0] ? { url: node.arguments[0] } : {}), ...(node.arguments[optionIndex] ? { options: node.arguments[optionIndex] } : {}), via: 'axios', ...(blocked ? { blocked } : {}) };
  }
  if (!AXIOS_VERBS.has(member) && member !== 'request') return undefined;
  const instance = axiosInstance(checker, receiver);
  if (!instance) return undefined;
  const name = instance.declaration.name.getText();
  const site: HttpSite = { node, client: 'axios-instance', verb: member.toUpperCase(), ...(node.arguments[0] ? { url: node.arguments[0] } : {}), ...(node.arguments[optionIndex] ? { options: node.arguments[optionIndex] } : {}), instance: name, via: `axios instance ${name}` };
  if (member === 'request') return { ...site, blocked: `${name}.request(config) is not resolved` };
  const config = instance.config;
  if (config) {
    if (!ts.isObjectLiteralExpression(config)) return { ...site, blocked: `The config of axios.create() for ${name} is not an object literal` };
    for (const property of config.properties) {
      if (ts.isSpreadAssignment(property) || (property.name && ts.isComputedPropertyName(property.name))) return { ...site, blocked: `The config of axios.create() for ${name} has a spread or computed property` };
      if (propertyName(property.name) === 'baseURL') {
        if (!ts.isPropertyAssignment(property)) return { ...site, blocked: `The baseURL of ${name} is not a plain property` };
        site.base = property.initializer;
      }
    }
  }
  return site;
}

/** Evaluate a site's method and URL in a scope (empty for the site itself; bound parameters at a wrapper's call site). */
export function evaluateSite(urls: UrlEvaluator, site: HttpSite, scope: Scope = emptyScope()): SiteOutcome {
  if (site.blocked) return { reason: site.blocked, parameters: [] };
  let method: string;
  if (site.client === 'fetch' || site.verb === 'VISIT') {
    // fetch init and Inertia visit options name the method the same way.
    const read = readOptions(urls, site.options, scope, 'fetch');
    if ('reason' in read) return read;
    method = read.method ?? 'GET';
  } else if (site.client === 'inertia') method = site.verb!;
  else {
    method = site.verb!;
    const read = readOptions(urls, site.options, scope, 'axios');
    if ('reason' in read) return { ...read, method };
  }
  if (!site.url) return { reason: 'The request has no URL argument', parameters: [], method };
  // A plain literal of the site itself is matched as written (api-matcher); anything else is evaluated.
  const plain = literalText(site.url);
  if (plain !== undefined && scope.bindings.size === 0 && site.client !== 'axios-instance') return { method, url: plain };
  const resolved = site.client === 'axios-instance' ? urls.resolveJoined(site.base, site.url, scope) : urls.resolve(site.url, scope);
  return 'url' in resolved ? { method, resolved: resolved.url } : { ...resolved, method };
}
/**
 * The method an options object sets (fetch init: `method`; axios config:
 * none of `url`, `baseURL`, `method` may be overridden). Spreads of bound
 * values (a wrapper's `init` argument) are read in order, later keys winning.
 */
function readOptions(urls: UrlEvaluator, options: ts.Expression | undefined, scope: Scope, client: 'fetch' | 'axios'): { method?: string } | Unresolved {
  if (!options) return {};
  const object = objectOf(urls, options, scope, 0);
  if (object === 'absent') return {};
  if ('reason' in object) return object;
  let method: string | undefined;
  for (const property of object.node.properties) {
    if (ts.isSpreadAssignment(property)) {
      const inner = objectOf(urls, property.expression, object.scope, 1);
      if (inner === 'absent') continue;
      if ('reason' in inner) return { reason: 'HTTP options contain a spread/computed property', parameters: inner.parameters };
      const read = readOptions(urls, inner.node, inner.scope, client);
      if ('reason' in read) return read;
      if (read.method) method = read.method;
      continue;
    }
    if (property.name && ts.isComputedPropertyName(property.name)) return { reason: 'HTTP options contain a spread/computed property', parameters: [] };
    const key = propertyName(property.name);
    if (client === 'axios' && key && ['baseURL', 'url', 'method'].includes(key)) return { reason: 'Axios config overrides require further resolution', parameters: [] };
    if (client === 'fetch' && key === 'method') {
      const value = ts.isPropertyAssignment(property) ? property.initializer : ts.isShorthandPropertyAssignment(property) ? property.name : undefined;
      const read = value ? urls.stringValue(value, object.scope) : { reason: 'Dynamic/unsupported HTTP method', parameters: [] };
      if ('reason' in read) return { reason: 'Dynamic/unsupported HTTP method', parameters: read.parameters };
      method = read.value.toUpperCase();
      if (!HTTP_METHODS.has(method)) return { reason: 'Dynamic/unsupported HTTP method', parameters: [] };
    }
  }
  return { ...(method ? { method } : {}) };
}
function objectOf(urls: UrlEvaluator, expression: ts.Expression, scope: Scope, depth: number): { node: ts.ObjectLiteralExpression; scope: Scope } | Unresolved | 'absent' {
  if (expression === MISSING_ARGUMENT) return 'absent';
  if (ts.isObjectLiteralExpression(expression)) return { node: expression, scope };
  if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression)) return objectOf(urls, expression.expression, scope, depth);
  if (ts.isIdentifier(expression) && expression.text === 'undefined') return 'absent';
  const bound = depth < 4 ? urls.boundValue(expression, scope) : undefined;
  if (bound) return objectOf(urls, bound.expression, bound.scope, depth + 1);
  const parameter = parameterOf(urls, expression);
  return { reason: 'Dynamic HTTP options', parameters: parameter ? [parameter] : [] };
}
function parameterOf(urls: UrlEvaluator, expression: ts.Expression): ts.ParameterDeclaration | undefined {
  if (!ts.isIdentifier(expression)) return undefined;
  const value = urls.stringValue(expression);
  return 'parameters' in value ? value.parameters[0] : undefined;
}

/** A queued wrapper site: the HTTP site, its owner, and what it is waiting for. */
export interface WrapperRoot {
  site: HttpSite; owner: Entity; file: ScannedFile; effect: EffectFact; fact: Evidence; reason: string;
  /** The function whose parameters the URL (or method) depends on. */
  wrapper: ts.SignatureDeclaration;
  /** The httpRequests entry of the owner's file, updated with the outcome. */
  entry: Record<string, unknown>;
}
/** The function-like declaration that owns every parameter, when it contains `node` and has a body. */
export function wrapperOf(node: ts.Node, parameters: ts.ParameterDeclaration[]): ts.SignatureDeclaration | undefined {
  if (!parameters.length) return undefined;
  const owner = parameters[0]!.parent;
  if (!parameters.every(parameter => parameter.parent === owner)) return undefined;
  if (!(ts.isFunctionDeclaration(owner) || ts.isMethodDeclaration(owner) || ts.isArrowFunction(owner) || ts.isFunctionExpression(owner)) || !owner.body) return undefined;
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) if (current === owner) return owner;
  return undefined;
}
/** The names a function is called by: its own, or the variable, property or class field holding it. */
function callNames(declaration: ts.SignatureDeclaration): string[] {
  if ((ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration)) && declaration.name) return [declaration.name.getText()];
  let holder: ts.Node = declaration.parent;
  // const save = useCallback(async () => …, deps)
  if (ts.isCallExpression(holder)) holder = holder.parent;
  if (ts.isVariableDeclaration(holder) && ts.isIdentifier(holder.name)) return [holder.name.text];
  if ((ts.isPropertyAssignment(holder) || ts.isPropertyDeclaration(holder)) && propertyName(holder.name)) return [propertyName(holder.name)!];
  return [];
}
function displayName(declaration: ts.SignatureDeclaration): string { return callNames(declaration)[0] ?? 'an anonymous function'; }

export interface WrapperContext {
  context: AnalysisContext; checker: ts.TypeChecker; program: ts.Program; urls: UrlEvaluator; sites: SiteCollector;
  /** Analyzed source files of the application. */
  sources: ts.SourceFile[];
  /** Declaration node → entity (owners of call sites). */
  declarations: Map<ts.Node, Entity>;
}
/**
 * Resolve queued wrapper sites at the call sites of their wrappers, through
 * nested wrappers. Emits observations, effects, file metadata and diagnostics.
 */
export function expandWrappers(input: WrapperContext, roots: WrapperRoot[]): void {
  if (!roots.length) return;
  const { context, checker, urls, sites } = input;
  const { graph } = context;
  const relative = (fileName: string) => path.relative(context.root, fileName).split(path.sep).join('/');
  // Calls by callee name, collected once.
  const callsByName = new Map<string, ts.CallExpression[]>();
  for (const source of input.sources) {
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
        if (name) { const list = callsByName.get(name) ?? []; list.push(node); callsByName.set(name, list); }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  const callSites = new Map<ts.SignatureDeclaration, ts.CallExpression[]>();
  const callsOf = (declaration: ts.SignatureDeclaration): ts.CallExpression[] => {
    let found = callSites.get(declaration);
    if (!found) {
      found = [];
      for (const name of callNames(declaration)) for (const call of callsByName.get(name) ?? []) {
        let target: ts.Declaration | undefined;
        try { target = checker.getResolvedSignature(call)?.declaration as ts.Declaration | undefined; } catch { target = undefined; }
        if (target === declaration) found.push(call);
      }
      callSites.set(declaration, found);
    }
    return found;
  };
  const ownerOf = (node: ts.Node): Entity | undefined => {
    for (let parent = node.parent; parent; parent = parent.parent) { const entity = input.declarations.get(parent); if (entity) return entity; }
    const file = context.files.get(relative(node.getSourceFile().fileName));
    return file ? graph.entities.get(file.id) : undefined;
  };
  const lineOf = (node: ts.Node) => node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1;
  const fact = (node: ts.Node, explanation: string): Evidence => ({ ...evidence('typescript', 'typescript-nextjs', relative(node.getSourceFile().fileName), lineOf(node), explanation), endLine: node.getSourceFile().getLineAndCharacterOfPosition(node.getEnd()).line + 1 });
  const diagnoseAt = (call: ts.CallExpression, caller: Entity | undefined, reason: string) => graph.diagnose({ analyzer: 'typescript-nextjs', severity: 'warning', code: 'unresolved-http-call', file: relative(call.getSourceFile().fileName), line: lineOf(call), ...(caller ? { entityId: caller.id } : {}), reason });
  const metadataOf = (call: ts.CallExpression) => {
    const file = context.files.get(relative(call.getSourceFile().fileName));
    const entity = file ? graph.entities.get(file.id) : undefined;
    return entity && Array.isArray(entity.metadata.httpRequests) ? { file: file!, list: entity.metadata.httpRequests as unknown[] } : undefined;
  };

  for (const root of roots) {
    const name = displayName(root.wrapper);
    const siteFact: Evidence = { ...root.fact, explanation: `${root.site.via} in ${name}() is built from the function's parameters` };
    let resolved = 0, failed = 0, found = 0;
    const work: { frames: ts.CallExpression[]; wrapper: ts.SignatureDeclaration }[] = [{ frames: [], wrapper: root.wrapper }];
    while (work.length) {
      const item = work.shift()!;
      const calls = callsOf(item.wrapper).slice(0, MAX_CALL_SITES);
      if (item.frames.length) {
        // A nested wrapper nobody calls: its own call (the outermost frame) stays unresolved.
        if (!calls.length) { const outer = item.frames.at(-1)!; diagnoseAt(outer, ownerOf(outer), `Through ${name}(): the request is built from a parameter of ${displayName(item.wrapper)}(), and no call site of ${displayName(item.wrapper)}() was resolved`); failed++; continue; }
      } else found = calls.length;
      for (const call of calls) {
        const frames = [...item.frames, call];
        let scope = emptyScope();
        for (let index = frames.length - 1; index >= 0; index--) {
          const frame = frames[index]!;
          const declaration = index === 0 ? root.wrapper : wrapperFrame(frames, index);
          scope = urls.bind(declaration, frame, scope);
        }
        const outcome = evaluateSite(urls, root.site, scope);
        const caller = ownerOf(call);
        if ('reason' in outcome) {
          const nested = wrapperOf(call, outcome.parameters);
          const seen = new Set<ts.Node>([root.wrapper, ...frames.map((_, index) => index === 0 ? root.wrapper : wrapperFrame(frames, index))]);
          if (nested && frames.length < MAX_WRAPPER_DEPTH && !seen.has(nested)) { work.push({ frames, wrapper: nested }); continue; }
          diagnoseAt(call, caller, `Through ${name}(): ${outcome.reason}`);
          failed++;
          continue;
        }
        if (!caller) continue;
        resolved++;
        const callee = displayName(frames.length > 1 ? wrapperFrame(frames, frames.length - 1) : root.wrapper);
        const outerCall = frames.at(-1)!;
        const callFact = fact(outerCall, `Calls ${callee}(…), which sends ${root.site.client === 'fetch' ? 'fetch()' : root.site.client === 'inertia' ? 'an Inertia visit' : 'an axios request'} with what it is given`);
        const frameFacts = frames.slice(0, -1).reverse().map(frame => fact(frame, `${short(frame)} passes its arguments on`));
        const display = outcome.resolved?.display ?? outcome.url ?? short(root.site.url ?? outerCall);
        const effect = sites.effect(caller.id, { category: 'network', operation: outcome.method, detail: display, line: callFact.line!, via: `${root.site.via} through ${callee}()` });
        const proof = dedupe([siteFact, ...frameFacts, ...(outcome.resolved?.proof ?? [])]).slice(0, MAX_PROOF);
        const resolvedUrl: ResolvedUrl | undefined = outcome.resolved ? { ...outcome.resolved, proof } : undefined;
        const file = context.files.get(relative(outerCall.getSourceFile().fileName));
        if (!file) continue;
        const observation: HttpObservation = { callerId: caller.id, fileId: file.id, method: outcome.method, expression: short(outerCall, 120), evidence: callFact, effect, ...(resolvedUrl ? { resolved: resolvedUrl } : outcome.url !== undefined ? { url: outcome.url } : {}) };
        context.http.push(observation);
        metadataOf(outerCall)?.list.push({ callerId: caller.id, method: outcome.method, url: display, expression: short(outerCall, 120), line: callFact.line, resolution: 'wrapper', wrapper: callee });
      }
    }
    root.entry.resolution = 'wrapper';
    root.entry.callSites = { resolved, unresolved: failed };
    if (resolved) {
      root.effect.wrapper = true;
      graph.diagnose({ analyzer: 'typescript-nextjs', severity: 'info', code: 'http-wrapper', file: root.file.path, line: root.fact.line, entityId: root.owner.id, reason: `${name}() is an HTTP wrapper (${root.site.via} built from its parameters); ${resolved} of ${resolved + failed} call sites resolved, each as a request of its caller` });
    } else if (!found) {
      root.entry.resolution = 'unresolved';
      graph.diagnose({ analyzer: 'typescript-nextjs', severity: 'warning', code: 'unresolved-http-call', file: root.file.path, line: root.fact.line, entityId: root.owner.id, reason: `${root.reason}; no call site of ${name}() was resolved` });
    } else graph.diagnose({ analyzer: 'typescript-nextjs', severity: 'info', code: 'http-wrapper', file: root.file.path, line: root.fact.line, entityId: root.owner.id, reason: `${name}() is an HTTP wrapper (${root.site.via} built from its parameters); none of its ${found} call sites could be resolved (each is reported on its caller)` });
  }
  /** The declaration called by frame `index` (> 0): the function around the previous frame's call. */
  function wrapperFrame(frames: ts.CallExpression[], index: number): ts.SignatureDeclaration {
    let target: ts.Declaration | undefined;
    try { target = checker.getResolvedSignature(frames[index]!)?.declaration as ts.Declaration | undefined; } catch { target = undefined; }
    return target as ts.SignatureDeclaration;
  }
}
function dedupe(facts: Evidence[]): Evidence[] { return [...new Map(facts.map(fact => [JSON.stringify(fact), fact])).values()]; }
