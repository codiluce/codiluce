// Static evaluation of HTTP request URLs built from a proven base.
//
// `fetch(`${this.API_BASE_URL}auth/login`)` is resolvable when every value the
// base can take is proven: a literal origin configured in `apiOrigins`, or an
// environment variable declared for an application in `apiOriginEnv`. The
// evaluator follows the expression through templates, concatenation, `const`
// bindings, class properties (every assignment in the class), local functions
// (every return, with arguments bound to parameters), `new URL(…)`,
// `.toString()`, `String(…)`, `||` / `??` and conditionals. Each hop is recorded
// as evidence. Dynamic values become holes; a hole may stand for a whole path
// segment (it then only matches a route parameter) or sit after `?`. Anything
// else — a parameter nobody binds, an unconfigured origin, a hole inside a
// segment, alternatives that disagree — fails with a reason, never a guess.
import ts from 'typescript';
import path from 'node:path';
import type { AnalysisContext } from '../core/analyzer.js';
import { evidence, type Evidence } from '../core/graph.js';

type Part = { kind: 'text'; value: string } | { kind: 'hole'; text: string } | { kind: 'origin'; app: string; label: string };
interface Alternative { parts: Part[]; proof: Evidence[] }
type Result = { ok: true; alternatives: Alternative[] } | { ok: false; reason: string };
interface Binding { expression: ts.Expression; scope: Scope }
interface Scope { bindings: Map<ts.Symbol, Binding>; depth: number; active: Set<ts.Node> }
export interface ResolvedUrl {
  /** Target application when the origin is proven; absent for a same-origin relative path. */
  app?: string;
  relative: boolean;
  /** Path with `{*}` for each hole that stands for a whole segment. */
  pattern: string;
  holes: number;
  proof: Evidence[];
  display: string;
}
const MAX_ALTERNATIVES = 8, MAX_DEPTH = 8, MAX_PROOF = 10;
const ok = (alternatives: Alternative[]): Result => ({ ok: true, alternatives });
const fail = (reason: string): Result => ({ ok: false, reason });
const text = (value: string): Alternative => ({ parts: [{ kind: 'text', value }], proof: [] });
function short(node: ts.Node): string { const value = node.getText().replace(/\s+/g, ' '); return value.length > 80 ? `${value.slice(0, 77)}…` : value; }

export class UrlEvaluator {
  private readonly envOwners = new Map<string, string>();
  private readonly originOwners = new Map<string, string>();
  constructor(private readonly checker: ts.TypeChecker, private readonly program: ts.Program, private readonly context: AnalysisContext) {
    for (const app of context.config.applications) {
      for (const name of app.apiOriginEnv ?? []) this.envOwners.set(name, app.name);
      for (const origin of app.apiOrigins ?? []) this.originOwners.set(origin, app.name);
    }
  }
  private relative(node: ts.Node): string { return path.relative(this.context.root, node.getSourceFile().fileName).split(path.sep).join('/'); }
  private fact(node: ts.Node, explanation: string): Evidence {
    const source = node.getSourceFile();
    const start = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, end = source.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
    return { ...evidence('typescript', 'typescript-nextjs', this.relative(node), start, explanation), endLine: end };
  }
  private indexed(node: ts.Node): boolean {
    const source = node.getSourceFile();
    return !this.program.isSourceFileDefaultLibrary(source) && this.context.files.has(this.relative(node));
  }
  /** Resolve a request URL expression; `undefined` reason when it is a plain literal (handled by the literal matcher). */
  resolve(expression: ts.Expression): { url: ResolvedUrl } | { reason: string } {
    const result = this.evaluate(expression, { bindings: new Map(), depth: 0, active: new Set() });
    if (!result.ok) return { reason: result.reason };
    const resolved: ResolvedUrl[] = [];
    for (const alternative of result.alternatives) {
      const one = this.normalize(alternative);
      if ('reason' in one) return one;
      resolved.push(one.url);
    }
    const first = resolved[0]!;
    if (resolved.some(item => item.app !== first.app || item.relative !== first.relative || item.pattern !== first.pattern)) return { reason: `The URL can take values that reach different targets (${[...new Set(resolved.map(item => `${item.app ?? 'same origin'} ${item.pattern}`))].join(' | ')})` };
    const proof = dedupe(resolved.flatMap(item => item.proof)).slice(0, MAX_PROOF);
    return { url: { ...first, proof } };
  }
  private normalize(alternative: Alternative): { url: ResolvedUrl } | { reason: string } {
    const parts: Part[] = [];
    for (const part of alternative.parts) {
      const last = parts.at(-1);
      if (part.kind === 'text' && last?.kind === 'text') parts[parts.length - 1] = { kind: 'text', value: last.value + part.value };
      else if (part.kind !== 'text' || part.value) parts.push(part);
    }
    let app: string | undefined, relative = false, rest: Part[];
    const head = parts[0];
    if (!head) return { reason: 'Empty URL' };
    if (head.kind === 'origin') { app = head.app; rest = parts.slice(1); }
    else if (head.kind === 'hole') return { reason: `The URL starts with a value that cannot be resolved: ${head.text}` };
    else if (/^https?:\/\//i.test(head.value)) {
      const match = /^(https?:\/\/[^/?#]*)(.*)$/is.exec(head.value)!;
      if (match[2] === '' && parts.length > 1) return { reason: 'The URL host may continue in a dynamic value' };
      let origin: string;
      try { origin = new URL(match[1]!).origin; } catch { return { reason: `Invalid URL origin ${match[1]}` }; }
      const owner = this.originOwners.get(origin);
      if (!owner) return { reason: `The URL can be ${origin}, which is not a configured apiOrigin of any application` };
      app = owner;
      rest = [{ kind: 'text', value: match[2]! }, ...parts.slice(1)];
    } else if (head.value.startsWith('/') && !head.value.startsWith('//')) { relative = true; rest = parts; }
    else return { reason: `The URL starts with a relative path without a leading slash (${head.value.slice(0, 40)})` };
    // Cut the query string and fragment: holes there do not affect routing.
    const pathParts: Part[] = [];
    for (const part of rest) {
      if (part.kind === 'text') { const cut = part.value.search(/[?#]/); if (cut >= 0) { pathParts.push({ kind: 'text', value: part.value.slice(0, cut) }); break; } }
      if (part.kind === 'origin') return { reason: 'An application origin appears in the middle of the URL' };
      pathParts.push(part);
    }
    const segments: string[] = [];
    let current: Part[] = [], holes = 0;
    const flush = (): string | undefined => {
      if (!current.length) return undefined;
      if (current.length === 1 && current[0]!.kind === 'hole') { holes++; segments.push('{*}'); }
      else if (current.every(part => part.kind === 'text')) segments.push(current.map(part => (part as { value: string }).value).join(''));
      else return `A path segment mixes text and a dynamic value (${current.map(part => part.kind === 'text' ? part.value : `\${${part.kind === 'hole' ? part.text : ''}}`).join('')})`;
      current = []; return undefined;
    };
    for (const part of pathParts) {
      if (part.kind === 'hole') { current.push(part); continue; }
      const pieces = (part as { value: string }).value.split('/');
      pieces.forEach((piece, index) => {
        if (index > 0) { const problem = flush(); if (problem) throw new Error(problem); }
        if (piece) current.push({ kind: 'text', value: piece });
      });
    }
    try { const problem = flush(); if (problem) return { reason: problem }; } catch (error) { return { reason: (error as Error).message }; }
    // A hole is assumed to fill exactly one segment; a path made only of holes could be anything.
    if (holes && !segments.some(segment => segment !== '{*}')) return { reason: 'The URL path is entirely dynamic' };
    const pattern = `/${segments.filter(Boolean).join('/')}`;
    const display = parts.map(part => part.kind === 'text' ? part.value : part.kind === 'origin' ? `\${${part.label}}` : `\${${part.text}}`).join('');
    return { url: { ...(app ? { app } : {}), relative, pattern, holes, proof: alternative.proof, display } };
  }
  /** A sub-expression that may be dynamic: unknown values become a hole instead of failing. */
  private evaluateOrHole(expression: ts.Expression, scope: Scope): Result {
    const result = this.evaluate(expression, scope);
    return result.ok ? result : ok([{ parts: [{ kind: 'hole', text: short(expression) }], proof: [] }]);
  }
  private evaluate(node: ts.Expression, scope: Scope): Result {
    if (scope.depth > MAX_DEPTH) return fail('The URL is built through too many steps');
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return ok([text(node.text)]);
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node) || ts.isTypeAssertionExpression(node)) return this.evaluate(node.expression, scope);
    if (ts.isTemplateExpression(node)) {
      let result: Alternative[] = [text(node.head.text)];
      for (const [index, span] of node.templateSpans.entries()) {
        // A value opening the URL must be proven: a hole there could never be matched anyway, and its own reason is clearer.
        const value = index === 0 && !node.head.text ? this.evaluate(span.expression, scope) : this.evaluateOrHole(span.expression, scope);
        if (!value.ok) return value;
        const joined = product(result, value.alternatives);
        if (!joined) return fail('The URL can take too many values');
        result = joined.map(item => ({ parts: [...item.parts, { kind: 'text', value: span.literal.text }], proof: item.proof }));
      }
      return ok(result);
    }
    if (ts.isBinaryExpression(node)) {
      const operator = node.operatorToken.kind;
      if (operator === ts.SyntaxKind.PlusToken) {
        const left = this.evaluate(node.left, scope), right = this.evaluateOrHole(node.right, scope);
        if (!left.ok) return left; if (!right.ok) return right;
        const joined = product(left.alternatives, right.alternatives);
        return joined ? ok(joined) : fail('The URL can take too many values');
      }
      if (operator === ts.SyntaxKind.BarBarToken || operator === ts.SyntaxKind.QuestionQuestionToken) return this.union([node.left, node.right], scope);
      return fail(`Unsupported URL operator ${node.operatorToken.getText()}`);
    }
    if (ts.isConditionalExpression(node)) return this.union([node.whenTrue, node.whenFalse], scope);
    if (ts.isIdentifier(node)) return this.identifier(node, scope);
    if (ts.isPropertyAccessExpression(node)) return this.property(node, scope);
    if (ts.isCallExpression(node)) return this.call(node, scope);
    if (ts.isNewExpression(node)) {
      if (ts.isIdentifier(node.expression) && node.expression.text === 'URL' && this.isLibGlobal(node.expression)) {
        if (node.arguments?.length !== 1) return fail('new URL(path, base) is not resolved');
        // The URL parser gives an origin-only string a trailing slash.
        const value = this.evaluate(node.arguments[0]!, { ...scope, depth: scope.depth + 1 });
        return value.ok ? ok(value.alternatives.map(item => item.parts.length === 1 && item.parts[0]!.kind === 'text' && /^https?:\/\/[^/?#]+$/i.test(item.parts[0]!.value) ? { ...item, parts: [{ kind: 'text', value: `${item.parts[0]!.value}/` }] } : item)) : value;
      }
      return fail(`Unsupported URL construction ${short(node)}`);
    }
    return fail(`Dynamic URL value ${short(node)}`);
  }
  private union(nodes: ts.Expression[], scope: Scope): Result {
    const alternatives: Alternative[] = [];
    for (const item of nodes) {
      const value = this.evaluate(item, scope);
      if (!value.ok) return value;
      alternatives.push(...value.alternatives);
    }
    return alternatives.length > MAX_ALTERNATIVES ? fail('The URL can take too many values') : ok(alternatives);
  }
  private isLibGlobal(identifier: ts.Identifier): boolean {
    const symbol = this.checker.getSymbolAtLocation(identifier);
    return !!symbol?.declarations?.length && symbol.declarations.every(declaration => this.program.isSourceFileDefaultLibrary(declaration.getSourceFile()));
  }
  private symbolOf(node: ts.Node): ts.Symbol | undefined {
    let symbol = this.checker.getSymbolAtLocation(node);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) { try { symbol = this.checker.getAliasedSymbol(symbol); } catch { return undefined; } }
    return symbol;
  }
  private withProof(result: Result, fact: Evidence): Result {
    return result.ok ? ok(result.alternatives.map(item => ({ parts: item.parts, proof: [fact, ...item.proof] }))) : result;
  }
  private identifier(node: ts.Identifier, scope: Scope): Result {
    const symbol = this.symbolOf(node);
    if (!symbol) return fail(`${node.text} cannot be resolved`);
    const bound = scope.bindings.get(symbol);
    if (bound) return this.evaluate(bound.expression, { ...bound.scope, depth: scope.depth + 1 });
    const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
    if (!declaration) return fail(`${node.text} has no declaration`);
    if (ts.isParameter(declaration)) return fail(`The URL comes from parameter ${node.text}`);
    if (ts.isVariableDeclaration(declaration) && declaration.initializer && this.indexed(declaration)) {
      const list = declaration.parent;
      if (!ts.isVariableDeclarationList(list) || !(list.flags & ts.NodeFlags.Const)) return fail(`${node.text} is not a const binding`);
      if (scope.active.has(declaration)) return fail(`${node.text} refers to itself`);
      const inner = { ...scope, depth: scope.depth + 1, active: new Set([...scope.active, declaration]) };
      return this.withProof(this.evaluate(declaration.initializer, inner), this.fact(declaration, `${node.text} = ${short(declaration.initializer)}`));
    }
    return fail(`${node.text} is not a resolvable constant`);
  }
  private property(node: ts.PropertyAccessExpression, scope: Scope): Result {
    // process.env.NAME — `process` must not be a local binding.
    if (ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'process' && node.expression.name.text === 'env') {
      const local = this.checker.getSymbolAtLocation(node.expression.expression);
      if (local?.declarations?.some(declaration => this.indexed(declaration))) return fail('process is shadowed by a local binding');
      const name = node.name.text, owner = this.envOwners.get(name);
      if (!owner) return fail(`process.env.${name} is not declared as an application origin (apiOriginEnv)`);
      return ok([{ parts: [{ kind: 'origin', app: owner, label: `process.env.${name}` }], proof: [{ ...evidence('framework', 'typescript-nextjs', undefined, undefined, `process.env.${name} is declared in the configuration (apiOriginEnv) as the origin of ${owner}; this is a configured assumption`) }, this.fact(node, `Reads process.env.${name}`)] }]);
    }
    if (node.name.text === 'href') return this.evaluate(node.expression, { ...scope, depth: scope.depth + 1 });
    const symbol = this.symbolOf(node.name);
    const declarations = symbol?.declarations?.filter(declaration => this.indexed(declaration)) ?? [];
    if (!symbol || !declarations.length) return fail(`${short(node)} cannot be resolved to indexed code`);
    // Object literal property of a const object.
    const assignment = declarations.find(ts.isPropertyAssignment);
    if (assignment && declarations.length === 1) {
      const literal = assignment.parent, holder = literal.parent;
      if (!ts.isVariableDeclaration(holder) || !(holder.parent.flags & ts.NodeFlags.Const)) return fail(`${short(node)} is a property of a mutable object`);
      return this.withProof(this.evaluate(assignment.initializer, { ...scope, depth: scope.depth + 1 }), this.fact(assignment, `${short(node)} = ${short(assignment.initializer)}`));
    }
    // Class property: every value assigned to it in its class.
    const member = declarations.find(declaration => ts.isPropertyDeclaration(declaration) || ts.isParameter(declaration));
    const owner = member?.parent && (ts.isClassLike(member.parent) ? member.parent : ts.isConstructorDeclaration(member.parent) ? member.parent.parent : undefined);
    if (!member || !owner) return fail(`${short(node)} is not a resolvable property`);
    if (ts.isParameter(member)) return fail(`${short(node)} is set from a constructor parameter`);
    const values: { value: ts.Expression; site: ts.Node }[] = [];
    if (ts.isPropertyDeclaration(member) && member.initializer) values.push({ value: member.initializer, site: member });
    const visit = (child: ts.Node): void => {
      if (ts.isBinaryExpression(child) && child.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(child.left) && child.left.expression.kind === ts.SyntaxKind.ThisKeyword && child.left.name.text === node.name.text) values.push({ value: child.right, site: child });
      ts.forEachChild(child, visit);
    };
    ts.forEachChild(owner, visit);
    if (!values.length) return fail(`${short(node)} is never assigned in its class`);
    if (scope.active.has(member)) return fail(`${short(node)} refers to itself`);
    const inner = { ...scope, depth: scope.depth + 1, active: new Set([...scope.active, member]) };
    const alternatives: Alternative[] = [];
    for (const { value, site } of values) {
      const result = this.withProof(this.evaluate(value, { ...inner, bindings: new Map() }), this.fact(site, `${short(node)} is assigned ${short(value)}`));
      if (!result.ok) return result;
      alternatives.push(...result.alternatives);
    }
    return alternatives.length > MAX_ALTERNATIVES ? fail('The URL can take too many values') : ok(alternatives);
  }
  private call(node: ts.CallExpression, scope: Scope): Result {
    const callee = node.expression;
    if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'toString' && node.arguments.length === 0) return this.evaluate(callee.expression, { ...scope, depth: scope.depth + 1 });
    if (ts.isIdentifier(callee) && callee.text === 'String' && node.arguments.length === 1 && this.isLibGlobal(callee)) return this.evaluate(node.arguments[0]!, { ...scope, depth: scope.depth + 1 });
    const declaration = this.checker.getResolvedSignature(node)?.declaration;
    if (!declaration || !this.indexed(declaration) || !(ts.isFunctionDeclaration(declaration) || ts.isArrowFunction(declaration) || ts.isFunctionExpression(declaration) || ts.isMethodDeclaration(declaration)) || !declaration.body) return fail(`The URL comes from ${short(node)}, which cannot be followed`);
    if (scope.active.has(declaration)) return fail(`${short(node)} is recursive`);
    const bindings = new Map<ts.Symbol, Binding>();
    declaration.parameters.forEach((parameter, index) => {
      const argument = node.arguments[index];
      const symbol = ts.isIdentifier(parameter.name) ? this.checker.getSymbolAtLocation(parameter.name) : undefined;
      const value = argument ?? parameter.initializer;
      if (symbol && value) bindings.set(symbol, { expression: value, scope: argument ? scope : { bindings: new Map(), depth: scope.depth + 1, active: scope.active } });
    });
    const inner: Scope = { bindings, depth: scope.depth + 1, active: new Set([...scope.active, declaration]) };
    const name = ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration) ? declaration.name?.getText() ?? 'function' : short(callee);
    if (!ts.isBlock(declaration.body)) return this.withProof(this.evaluate(declaration.body, inner), this.fact(declaration, `${name}() returns ${short(declaration.body)}`));
    const returns: ts.ReturnStatement[] = [];
    const visit = (child: ts.Node): void => {
      if (ts.isReturnStatement(child)) returns.push(child);
      if (!ts.isFunctionLike(child)) ts.forEachChild(child, visit);
    };
    ts.forEachChild(declaration.body, visit);
    if (!returns.length || returns.some(item => !item.expression)) return fail(`${name}() does not return a URL on every path`);
    const alternatives: Alternative[] = [];
    for (const statement of returns) {
      const result = this.withProof(this.evaluate(statement.expression!, inner), this.fact(statement, `${name}() returns ${short(statement.expression!)}`));
      if (!result.ok) return result;
      alternatives.push(...result.alternatives);
    }
    return alternatives.length > MAX_ALTERNATIVES ? fail('The URL can take too many values') : ok(alternatives);
  }
}
function product(left: Alternative[], right: Alternative[]): Alternative[] | undefined {
  if (left.length * right.length > MAX_ALTERNATIVES) return undefined;
  return left.flatMap(a => right.map(b => ({ parts: [...a.parts, ...b.parts], proof: [...a.proof, ...b.proof] })));
}
function dedupe(facts: Evidence[]): Evidence[] { return [...new Map(facts.map(fact => [JSON.stringify(fact), fact])).values()]; }
