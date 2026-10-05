// Type-aware call, render and reference resolution for TypeScript/JavaScript.
//
// Runs after every file of an application has declared its symbols, against
// the application's program (ts-program.ts). An edge is emitted only when the
// checker resolves a site to a declaration that is an indexed entity:
//   calls       f(), obj.method(), Class.staticMethod(), X.getInstance().m(),
//               new Class() (form `new`), and methods of a value held in
//               useMemo(() => X.getInstance(), deps) (typed from the factory:
//               React's own types are not loaded)
//   renders     <Component /> whose tag resolves to an indexed component
//   references  a function passed as a value: onSubmit={handleSubmit}
//               (form `handler`, with the event prop), arr.map(renderRow)
//               (form `callback`), { onDone: finish } (form `value`)
// Every other call site is counted on its owner (`callSites`): external when
// it reaches lib globals or packages, unresolved when its target is dynamic
// (callback parameters, props, untyped values, interface dispatch).
// Effects — storage, navigation, responses — are recorded when the name they
// are matched on resolves to a lib global or to an import from the framework.
import ts from 'typescript';
import path from 'node:path';
import type { AnalysisContext, ScannedFile } from '../core/analyzer.js';
import { evidence, type EffectFact, type Entity, type Evidence } from '../core/graph.js';
import type { SiteCollector, SiteForm } from './references.js';

export interface TsApplicationState {
  program: ts.Program; checker: ts.TypeChecker;
  /** Declaration node → entity, for every analyzed file of the application. */
  declarations: Map<ts.Node, Entity>;
  sites: SiteCollector;
}
const CALLABLE = new Set(['function', 'method', 'component']);
const TARGETS = new Set(['function', 'method', 'component', 'class', 'controller']);
const NAVIGATION_MODULES = new Set(['next/navigation', 'next/router']);
function short(node: ts.Node, max = 60): string { const text = node.getText().replace(/\s+/g, ' '); return text.length > max ? `${text.slice(0, max - 1)}…` : text; }

export function resolveReferences(context: AnalysisContext, state: TsApplicationState, file: ScannedFile, source: ts.SourceFile, owners: Map<ts.Node, Entity>): void {
  const { checker, program, declarations, sites } = state;
  const fileEntity = context.graph.entities.get(file.id)!;
  const relativeOf = (sourceFile: ts.SourceFile) => path.relative(context.root, sourceFile.fileName).split(path.sep).join('/');
  const indexed = (node: ts.Node) => { const sf = node.getSourceFile(); return !program.isSourceFileDefaultLibrary(sf) && context.files.has(relativeOf(sf)); };
  const lineOf = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const fact = (node: ts.Node, explanation: string): Evidence => ({ ...evidence('typescript', 'typescript-nextjs', file.path, lineOf(node), explanation), endLine: source.getLineAndCharacterOfPosition(node.getEnd()).line + 1 });
  function owner(node: ts.Node): Entity {
    for (let parent = node.parent; parent; parent = parent.parent) { const entity = owners.get(parent); if (entity) return entity; }
    return fileEntity;
  }
  function aliased(symbol: ts.Symbol | undefined): ts.Symbol | undefined {
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) { try { return checker.getAliasedSymbol(symbol); } catch { return undefined; } }
    return symbol;
  }
  function entityOf(nodes: readonly ts.Node[] | undefined): Entity | undefined {
    for (const node of nodes ?? []) { const entity = declarations.get(node); if (entity) return entity; }
    return undefined;
  }
  function symbolEntity(node: ts.Node): Entity | undefined {
    try {
      const symbol = aliased(checker.getSymbolAtLocation(node));
      return entityOf(symbol?.declarations) ?? destructured(symbol);
    } catch { return undefined; }
  }
  /**
   * const { logout } = useAuth(): follow the destructured property into the
   * object the initializer returns (`return { logout }`) to the function it holds.
   */
  function destructured(symbol: ts.Symbol | undefined, depth = 0): Entity | undefined {
    const element = symbol?.declarations?.find(ts.isBindingElement);
    if (!element || depth > 3 || !ts.isObjectBindingPattern(element.parent)) return undefined;
    const holder = element.parent.parent;
    if (!ts.isVariableDeclaration(holder) || !holder.initializer) return undefined;
    const property = (element.propertyName ?? element.name).getText();
    const initializer = ts.isAwaitExpression(holder.initializer) ? holder.initializer.expression : holder.initializer;
    const member = checker.getTypeAtLocation(initializer).getProperty(property);
    for (const declaration of member?.declarations ?? []) {
      const direct = declarations.get(declaration);
      if (direct) return direct;
      if (ts.isShorthandPropertyAssignment(declaration)) { const value = aliased(checker.getShorthandAssignmentValueSymbol(declaration)); const found = entityOf(value?.declarations) ?? destructured(value, depth + 1); if (found) return found; }
      if (ts.isPropertyAssignment(declaration) && (ts.isIdentifier(declaration.initializer) || ts.isPropertyAccessExpression(declaration.initializer))) { const value = aliased(checker.getSymbolAtLocation(ts.isPropertyAccessExpression(declaration.initializer) ? declaration.initializer.name : declaration.initializer)); const found = entityOf(value?.declarations) ?? destructured(value, depth + 1); if (found) return found; }
      const fn = ts.isPropertyAssignment(declaration) ? declaration.initializer : undefined;
      if (fn && declarations.get(fn)) return declarations.get(fn);
    }
    return undefined;
  }
  /**
   * const service = useMemo(() => Service.getInstance(), []): React's types are
   * not in the program, so `service` is untyped; its methods are looked up on
   * the type of what the factory returns.
   */
  function memoized(access: ts.PropertyAccessExpression): Entity | undefined {
    if (!ts.isIdentifier(access.expression)) return undefined;
    let symbol: ts.Symbol | undefined;
    try { symbol = checker.getSymbolAtLocation(access.expression); } catch { return undefined; }
    const declaration = symbol?.valueDeclaration;
    const call = declaration && ts.isVariableDeclaration(declaration) && declaration.initializer && ts.isCallExpression(declaration.initializer) ? declaration.initializer : undefined;
    // useMemo(…) or React.useMemo(…), imported from react.
    const callee = call?.expression;
    const imported = callee && (ts.isIdentifier(callee) && callee.text === 'useMemo' ? callee : ts.isPropertyAccessExpression(callee) && callee.name.text === 'useMemo' && ts.isIdentifier(callee.expression) ? callee.expression : undefined);
    if (!call || !imported || importedFrom(imported) !== 'react') return undefined;
    const factory = call.arguments[0];
    if (!factory || !(ts.isArrowFunction(factory) || ts.isFunctionExpression(factory))) return undefined;
    const returned: ts.Expression[] = [];
    if (!ts.isBlock(factory.body)) returned.push(factory.body);
    else {
      const collect = (node: ts.Node): void => {
        if (ts.isReturnStatement(node) && node.expression) returned.push(node.expression);
        else if (!ts.isFunctionLike(node)) ts.forEachChild(node, collect);
      };
      ts.forEachChild(factory.body, collect);
    }
    for (const expression of returned) {
      try {
        const entity = entityOf(checker.getTypeAtLocation(expression).getProperty(access.name.text)?.declarations);
        if (entity) return entity;
      } catch { /* untyped */ }
    }
    return undefined;
  }
  /** The module an imported identifier comes from, when it is imported. */
  function importedFrom(identifier: ts.Identifier): string | undefined {
    let symbol: ts.Symbol | undefined;
    try { symbol = checker.getSymbolAtLocation(identifier); } catch { return undefined; }
    const declaration = symbol?.declarations?.[0];
    if (!declaration) return undefined;
    let node: ts.Node | undefined = declaration;
    while (node && !ts.isImportDeclaration(node)) node = node.parent;
    return node && ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : undefined;
  }
  function libGlobal(identifier: ts.Identifier, name: string): boolean {
    if (identifier.text !== name) return false;
    let symbol: ts.Symbol | undefined;
    try { symbol = checker.getSymbolAtLocation(identifier); } catch { return false; }
    return !!symbol?.declarations?.length && symbol.declarations.every(declaration => program.isSourceFileDefaultLibrary(declaration.getSourceFile()));
  }
  function rootOf(expression: ts.Expression): ts.Expression {
    let current = expression;
    for (;;) {
      if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current) || ts.isNonNullExpression(current) || ts.isParenthesizedExpression(current) || ts.isAsExpression(current)) current = current.expression;
      else if (ts.isCallExpression(current)) current = current.expression;
      else return current;
    }
  }
  /** Where a value with no indexed target comes from: lib/packages (external) or somewhere dynamic. */
  function origin(expression: ts.Expression, depth = 0): 'external' | 'unresolved' {
    const root = rootOf(expression);
    if (!ts.isIdentifier(root) || depth > 4) return 'unresolved';
    let symbol: ts.Symbol | undefined;
    try { symbol = checker.getSymbolAtLocation(root); } catch { return 'unresolved'; }
    if (!symbol) return 'external';
    if (symbol.flags & ts.SymbolFlags.Alias) {
      const target = aliased(symbol);
      if (!target?.declarations?.length) return 'external';
      symbol = target;
    }
    const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
    if (!declaration) return 'external';
    if (!indexed(declaration)) return 'external';
    let holder: ts.Node = declaration;
    while (ts.isBindingElement(holder) || ts.isObjectBindingPattern(holder) || ts.isArrayBindingPattern(holder)) holder = holder.parent;
    if (ts.isParameter(holder)) return parameterOrigin(holder);
    if (ts.isVariableDeclaration(holder) && holder.initializer) {
      const initializer = ts.isAwaitExpression(holder.initializer) ? holder.initializer.expression : holder.initializer;
      if (ts.isCallExpression(initializer) || ts.isPropertyAccessExpression(initializer) || ts.isIdentifier(initializer)) return origin(initializer, depth + 1);
    }
    return 'unresolved';
  }
  /** A package-typed parameter (e: React.FormEvent), or one of a callback handed to a package (test('…', ({ page }) => …)), comes from outside. */
  function parameterOrigin(parameter: ts.ParameterDeclaration): 'external' | 'unresolved' {
    const fromPackage = (identifier: ts.Identifier) => { let symbol: ts.Symbol | undefined; try { symbol = checker.getSymbolAtLocation(identifier); } catch { return false; } return !symbol || (!!(symbol.flags & ts.SymbolFlags.Alias) && !aliased(symbol)?.declarations?.length); };
    const type = parameter.type;
    if (type && ts.isTypeReferenceNode(type)) { let name: ts.EntityName = type.typeName; while (ts.isQualifiedName(name)) name = name.left; if (fromPackage(name)) return 'external'; }
    const fn = parameter.parent;
    const call = (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && fn.parent && ts.isCallExpression(fn.parent) ? fn.parent : undefined;
    if (call) { const root = rootOf(call.expression); if (ts.isIdentifier(root) && fromPackage(root)) return 'external'; }
    return 'unresolved';
  }
  function calleeName(callee: ts.Expression): string | undefined {
    if (ts.isIdentifier(callee)) return callee.text;
    if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
    return undefined;
  }
  /** An inline event handler (onClick={() => …}) the site is written in, below its owner. */
  function eventOf(node: ts.Node, stop: Entity): string | undefined {
    // X.getInstance().save(): the receiver call is plumbing, the outer call is what the handler does.
    if (ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node && ts.isCallExpression(node.parent.parent) && node.parent.parent.expression === node.parent) return undefined;
    for (let parent = node.parent; parent && owners.get(parent) !== stop; parent = parent.parent) {
      if (ts.isJsxAttribute(parent) && /^on[A-Z]/.test(parent.name.getText())) return parent.name.getText();
    }
    return undefined;
  }
  function tagOf(attribute: ts.JsxAttribute): string {
    const element = attribute.parent.parent;
    return ts.isJsxOpeningElement(element) || ts.isJsxSelfClosingElement(element) ? element.tagName.getText() : 'element';
  }
  function effect(from: Entity, node: ts.Node, value: Omit<EffectFact, 'line' | 'detail'> & { detail?: string }): void {
    sites.effect(from.id, { ...value, detail: value.detail ?? short(node, 80), line: lineOf(node) });
  }
  function status(init: ts.Expression | undefined, fallback: number): number {
    if (!init || !ts.isObjectLiteralExpression(init)) return fallback;
    for (const property of init.properties) if (ts.isPropertyAssignment(property) && property.name.getText() === 'status' && ts.isNumericLiteral(property.initializer)) return Number(property.initializer.text);
    return fallback;
  }
  /** Storage, navigation and response effects of a call, matched on resolved names. */
  function callEffect(from: Entity, call: ts.CallExpression): boolean {
    const callee = call.expression;
    const first = call.arguments[0];
    const literalArgument = first && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)) ? first.text : undefined;
    if (ts.isPropertyAccessExpression(callee)) {
      const method = callee.name.text, receiver = callee.expression;
      if (ts.isIdentifier(receiver) && (libGlobal(receiver, 'localStorage') || libGlobal(receiver, 'sessionStorage'))) {
        effect(from, call, { category: 'storage', operation: /^get|^key$/.test(method) ? 'read' : 'write', via: `${receiver.text} (DOM)`, ...(literalArgument ? { detail: `${receiver.text}.${method}('${literalArgument}')` } : {}) });
        return true;
      }
      if (ts.isPropertyAccessExpression(receiver) && ts.isIdentifier(receiver.expression) && libGlobal(receiver.expression, 'window') && receiver.name.text === 'location' && ['assign', 'replace', 'reload'].includes(method)) {
        effect(from, call, { category: 'navigation', operation: method, via: 'window.location (DOM)' });
        return true;
      }
      if (ts.isIdentifier(receiver) && libGlobal(receiver, 'Response') && ['json', 'redirect', 'error'].includes(method)) {
        effect(from, call, { category: 'response', operation: method, status: method === 'redirect' ? 302 : method === 'error' ? 500 : status(call.arguments[1], 200), via: 'Response (Fetch API)' });
        return true;
      }
      if (ts.isIdentifier(receiver) && receiver.text === 'NextResponse' && importedFrom(receiver) === 'next/server' && ['json', 'redirect', 'rewrite', 'next'].includes(method)) {
        effect(from, call, { category: 'response', operation: method, status: method === 'redirect' ? 307 : status(call.arguments[1], 200), via: 'NextResponse (next/server)' });
        return true;
      }
      // router.push('/x') where router = useRouter() from Next.
      if (ts.isIdentifier(receiver) && ['push', 'replace', 'back', 'forward', 'refresh', 'prefetch'].includes(method)) {
        let symbol: ts.Symbol | undefined;
        try { symbol = checker.getSymbolAtLocation(receiver); } catch { symbol = undefined; }
        const declaration = symbol?.valueDeclaration;
        const initializer = declaration && ts.isVariableDeclaration(declaration) ? declaration.initializer : undefined;
        if (initializer && ts.isCallExpression(initializer) && ts.isIdentifier(initializer.expression) && initializer.expression.text === 'useRouter' && NAVIGATION_MODULES.has(importedFrom(initializer.expression) ?? '')) {
          effect(from, call, { category: 'navigation', operation: method, via: `useRouter (${importedFrom(initializer.expression)})`, ...(literalArgument ? { detail: literalArgument } : {}) });
          return true;
        }
      }
    }
    if (ts.isIdentifier(callee) && ['redirect', 'permanentRedirect', 'notFound'].includes(callee.text) && importedFrom(callee) === 'next/navigation') {
      if (callee.text === 'notFound') effect(from, call, { category: 'response', operation: 'notFound', status: 404, via: 'notFound (next/navigation)' });
      else effect(from, call, { category: 'navigation', operation: callee.text, via: `${callee.text} (next/navigation)`, ...(literalArgument ? { detail: literalArgument } : {}) });
      return true;
    }
    return false;
  }
  function reference(from: Entity, value: ts.Expression, form: SiteForm, explanation: string, event?: string): void {
    if (!ts.isIdentifier(value) && !ts.isPropertyAccessExpression(value)) return;
    let target: Entity | undefined;
    if (ts.isShorthandPropertyAssignment(value.parent)) { try { target = entityOf(aliased(checker.getShorthandAssignmentValueSymbol(value.parent))?.declarations); } catch { target = undefined; } }
    else target = symbolEntity(ts.isPropertyAccessExpression(value) ? value.name : value);
    if (!target || target.id === from.id || !CALLABLE.has(target.type)) return;
    sites.add({ from: from.id, to: target.id, type: 'references', form, evidence: fact(value, explanation), ...(event ? { event } : {}) });
  }
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && node.expression.kind !== ts.SyntaxKind.ImportKeyword && node.expression.kind !== ts.SyntaxKind.SuperKeyword) {
      const from = owner(node);
      let target: Entity | undefined;
      let declaration: ts.Declaration | undefined;
      try { declaration = checker.getResolvedSignature(node)?.declaration as ts.Declaration | undefined; } catch { declaration = undefined; }
      target = declaration ? declarations.get(declaration) : undefined;
      if (!target) { const name = ts.isPropertyAccessExpression(node.expression) ? node.expression.name : node.expression; target = symbolEntity(name); }
      if (!target && ts.isPropertyAccessExpression(node.expression)) target = memoized(node.expression);
      const calleeText = short(node.expression);
      if (target && TARGETS.has(target.type)) {
        const event = eventOf(node, from);
        sites.add({ from: from.id, to: target.id, type: 'calls', form: 'call', evidence: fact(node, `Calls ${calleeText}(…)${event ? ` in an ${event} handler` : ''}`), ...(event ? { event } : {}) });
        sites.count(from.id, 'resolved');
      } else if (!callEffect(from, node)) {
        const outcome = declaration && !indexed(declaration) ? 'external' : origin(node.expression);
        sites.count(from.id, outcome, outcome === 'unresolved' ? calleeName(node.expression) : undefined);
      } else sites.count(from.id, 'external');
      for (const argument of node.arguments) reference(from, argument, 'callback', `Passes ${short(argument)} to ${calleeText}(…)`);
    } else if (ts.isNewExpression(node)) {
      const from = owner(node);
      const target = symbolEntity(node.expression);
      if (target && (target.type === 'class' || target.type === 'controller')) {
        sites.add({ from: from.id, to: target.id, type: 'calls', form: 'new', evidence: fact(node, `Constructs new ${short(node.expression)}(…)`) });
        sites.count(from.id, 'resolved');
      } else if (ts.isIdentifier(node.expression) && libGlobal(node.expression, 'Response')) {
        effect(from, node, { category: 'response', operation: 'new Response', status: status(node.arguments?.[1], 200), via: 'Response (Fetch API)' });
        sites.count(from.id, 'external');
      } else sites.count(from.id, origin(node.expression), undefined);
      for (const argument of node.arguments ?? []) reference(from, argument, 'callback', `Passes ${short(argument)} to new ${short(node.expression)}(…)`);
    } else if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const from = owner(node);
      const tag = node.tagName.getText();
      if (!/^[a-z]/.test(tag)) {
        const target = symbolEntity(ts.isPropertyAccessExpression(node.tagName) ? node.tagName.name : node.tagName);
        if (target && target.id !== from.id && (target.type === 'component' || target.type === 'function' || target.type === 'class')) sites.add({ from: from.id, to: target.id, type: 'renders', form: 'render', evidence: fact(node, `Renders <${tag}>`) });
      }
    } else if (ts.isJsxAttribute(node) && node.initializer && ts.isJsxExpression(node.initializer) && node.initializer.expression) {
      const attribute = node.name.getText();
      const handler = /^on[A-Z]/.test(attribute);
      reference(owner(node), node.initializer.expression, handler ? 'handler' : 'value', `Passes ${short(node.initializer.expression)} as ${attribute} of <${tagOf(node)}>`, handler ? attribute : undefined);
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(node.left) && node.left.name.text === 'href' && ts.isPropertyAccessExpression(node.left.expression) && node.left.expression.name.text === 'location' && ts.isIdentifier(node.left.expression.expression) && libGlobal(node.left.expression.expression, 'window')) {
      const value = node.right;
      effect(owner(node), node, { category: 'navigation', operation: 'assign', via: 'window.location (DOM)', ...(ts.isStringLiteral(value) ? { detail: value.text } : {}) });
    } else if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) {
      const parent = node.parent;
      const valuePosition = (ts.isPropertyAssignment(parent) && parent.initializer === node) || ts.isShorthandPropertyAssignment(parent) || ts.isArrayLiteralExpression(parent) || (ts.isVariableDeclaration(parent) && parent.initializer === node) || (ts.isReturnStatement(parent) && parent.expression === node) || (ts.isConditionalExpression(parent) && parent.condition !== node) || (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && parent.right === node);
      if (valuePosition) reference(owner(node), node, 'value', `References ${short(node)}`);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}
