import ts from 'typescript';
import path from 'node:path';
import { subset, validRange } from 'semver';
import { evidence, type Entity, type Evidence } from '../../core/graph.js';
import type { ApplicationConfig } from '../../core/config.js';
import { compileExpressPath, composeRoutePath, type RouterOptions, type RoutingContract } from '../routes/contracts.js';
import { declareInlineHandler, nodeSite, sourceRange, type TypeScriptFrameworkPack, type TypeScriptPackScope } from './typescript-pack.js';
import { shadowedBinding } from '../../analyzers/ts-http.js';
import { frameworkBinding, unwrap, valueDeclaration } from './typescript-binding.js';

interface Router {
  kind: 'app' | 'router'; id: string; origin: ts.Node; app?: ApplicationConfig; major?: 4 | 5;
  options: RouterOptions; optionUnknown?: boolean; conditions: string[]; proof: Evidence[]; registrations: Registration[]; mounts: Mount[]; middleware: Entity[];
}
interface Builder { kind: 'builder'; router: Router; paths: string[]; node: ts.Node }
interface Registration { id: string; node: ts.CallExpression; paths: string[]; methods: string[] | '*'; handlers: Entity[]; conditions: string[]; middleware: Entity[]; proof: Evidence[]; opaque?: string }
interface Mount { id: string; child: Router; prefixes: string[]; node: ts.CallExpression; conditions: string[]; middleware: Entity[] }
type Value = Router | Builder | string | string[] | undefined;
interface Environment { checker: ts.TypeChecker; program: ts.Program; instance: string; parameters: Map<string, Value>; conditions: string[]; app?: ApplicationConfig; stack: string[]; proof: Evidence[] }
const verbs = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'connect', 'trace', 'all']);
const routerValue = (value: Value): value is Router => !!value && typeof value === 'object' && !Array.isArray(value) && (value.kind === 'app' || value.kind === 'router');
const builderValue = (value: Value): value is Builder => !!value && typeof value === 'object' && !Array.isArray(value) && value.kind === 'builder';

/** A bounded static registration interpreter. It follows indexed declarations
 * and proven framework imports; it never executes JS or loads dependencies. */
export const expressPack: TypeScriptFrameworkPack = {
  id: 'express', version: '1.0.0',
  applies: scope => scope.files.some(frame => frame.runtime.project.dependencies.express !== undefined || frame.file.application?.frameworks.includes('express')),
  declare(scope): void { new ExpressRegistrations(scope).run(); },
};
class ExpressRegistrations {
  private readonly routers: Router[] = [];
  private readonly values = new Map<string, Value>();
  private readonly evaluating = new Set<string>();
  private readonly occurrences = new Map<string, number>();
  private readonly writes = new Set<string>();
  private readonly mutatedReceivers = new Set<string>();
  private steps = 0; private calls = 0;
  constructor(private readonly scope: TypeScriptPackScope) {
    for (const frame of scope.files) {
      const visit = (node: ts.Node): void => {
        const target = ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment ? node.left : (ts.isPostfixUnaryExpression(node) || ts.isPrefixUnaryExpression(node)) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator) ? node.operand : undefined;
        if (target && ts.isIdentifier(target)) { const declaration = valueDeclaration(target, frame.state.checker); if (declaration) this.writes.add(nodeSite(declaration)); }
        if (target && (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target))) { const declaration = valueDeclaration(target.expression, frame.state.checker); if (declaration) this.mutatedReceivers.add(nodeSite(declaration)); }
        ts.forEachChild(node, visit);
      }; visit(frame.source);
    }
  }
  private relative(node: ts.Node): string { return path.relative(this.scope.context.root, node.getSourceFile().fileName).split(path.sep).join('/'); }
  private fact(node: ts.Node, explanation: string): Evidence { return evidence('framework', 'express', this.relative(node), sourceRange(node).startLine, explanation); }
  private diagnose(node: ts.Node, code: string, reason: string): void {
    const file = this.relative(node);
    this.scope.context.graph.diagnose({ analyzer: 'express', severity: 'warning', code, file, line: sourceRange(node).startLine, entityId: this.scope.context.files.get(file)?.id, reason });
  }
  private ordinal(key: string): number { const count = this.occurrences.get(key) ?? 0; this.occurrences.set(key, count + 1); return count; }
  private key(node: ts.Node, env: Environment): string {
    let parent = node.parent;
    while (parent && !ts.isSourceFile(parent) && !ts.isFunctionLike(parent)) parent = parent.parent;
    return `${nodeSite(node)}:${parent && ts.isFunctionLike(parent) ? env.instance : 'module'}`;
  }
  run(): void {
    for (const frame of this.scope.files) {
      const env: Environment = { checker: frame.state.checker, program: frame.state.program, instance: frame.file.path, parameters: new Map(), conditions: [], app: frame.file.application, stack: [], proof: [] };
      for (const statement of frame.source.statements) this.statement(statement, env);
    }
    for (const router of this.routers) {
      const file = this.scope.context.files.get(this.relative(router.origin));
      if (file) {
        const entity = this.scope.context.graph.entities.get(file.id)!;
        (entity.metadata.frameworkPacks as string[] | undefined) ??= [];
        if (!(entity.metadata.frameworkPacks as string[]).includes('express')) (entity.metadata.frameworkPacks as string[]).push('express');
        (entity.metadata.registrations as unknown[] | undefined) ??= [];
        (entity.metadata.registrations as unknown[]).push({ version: 1, framework: 'express', receiver: router.id, kind: router.kind, profile: router.major ? `express-${router.major}` : 'express-common', routes: router.registrations.map(route => ({ id: route.id, methods: route.methods, paths: route.paths, handlers: route.handlers.map(handler => handler.id), conditions: route.conditions, line: sourceRange(route.node).startLine })), mounts: router.mounts.map(mount => ({ receiver: mount.child.id, prefixes: mount.prefixes, line: sourceRange(mount.node).startLine })) });
      }
      if (router.kind === 'app' && router.app) this.emit(router, router, '', [], router.conditions, [], new Set());
    }
  }
  private statement(statement: ts.Statement, env: Environment): Value {
    if (++this.steps > 12_000) { if (this.steps === 12_001) this.diagnose(statement, 'express-registration-limit', 'Static registration traversal exceeded 12,000 steps'); return undefined; }
    if (ts.isVariableStatement(statement)) { for (const declaration of statement.declarationList.declarations) if (declaration.initializer) this.variable(declaration, env); }
    else if (ts.isExpressionStatement(statement)) return this.evaluate(statement.expression, env);
    else if (ts.isReturnStatement(statement)) return statement.expression ? this.evaluate(statement.expression, env) : undefined;
    else if (ts.isExportAssignment(statement)) return this.evaluate(statement.expression, env);
    else if (ts.isBlock(statement)) {
      for (const child of statement.statements) { const result = this.statement(child, env); if (ts.isReturnStatement(child)) return result; }
    } else if (ts.isIfStatement(statement)) {
      const condition = statement.expression.getText().slice(0, 120), conditional = { ...env, conditions: [...env.conditions, condition] };
      this.statement(statement.thenStatement, conditional);
      if (statement.elseStatement) this.statement(statement.elseStatement, { ...env, conditions: [...env.conditions, `!(${condition})`] });
    } else if (ts.isForStatement(statement) || ts.isForOfStatement(statement) || ts.isForInStatement(statement) || ts.isWhileStatement(statement) || ts.isDoStatement(statement)) {
      this.diagnose(statement, 'express-dynamic-registration', 'Loop-dependent registration is represented as constrained, without runtime iteration');
      this.statement(statement.statement, { ...env, conditions: [...env.conditions, 'loop-dependent registration'] });
    } else if (ts.isTryStatement(statement)) {
      this.statement(statement.tryBlock, { ...env, conditions: [...env.conditions, 'try-dependent registration'] });
      if (statement.catchClause) this.statement(statement.catchClause.block, { ...env, conditions: [...env.conditions, 'catch-dependent registration'] });
      if (statement.finallyBlock) this.statement(statement.finallyBlock, env);
    }
    return undefined;
  }
  private variable(declaration: ts.VariableDeclaration, env: Environment): Value {
    const key = this.key(declaration, env);
    if (this.values.has(key)) return this.values.get(key);
    if (this.writes.has(nodeSite(declaration)) || this.mutatedReceivers.has(nodeSite(declaration)) || this.evaluating.has(key)) return undefined;
    this.evaluating.add(key);
    const value = declaration.initializer ? this.evaluate(declaration.initializer, env) : undefined;
    this.evaluating.delete(key); this.values.set(key, value); return value;
  }
  private evaluate(expression: ts.Expression, env: Environment): Value {
    if (++this.steps > 12_000) return undefined;
    expression = unwrap(expression);
    if (ts.isStringLiteralLike(expression)) return expression.text;
    if (ts.isArrayLiteralExpression(expression)) {
      const values = expression.elements.map(item => this.evaluate(item, env));
      return values.length <= 32 && values.every(value => typeof value === 'string') ? values as string[] : undefined;
    }
    if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = this.evaluate(expression.left, env), right = this.evaluate(expression.right, env);
      return typeof left === 'string' && typeof right === 'string' ? left + right : undefined;
    }
    if (ts.isIdentifier(expression) || ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
      const commonjs = this.commonjsTarget(expression, env);
      if (commonjs) return this.evaluate(commonjs, env);
      const declaration = valueDeclaration(expression, env.checker);
      if (!declaration) return undefined;
      if (env.parameters.has(nodeSite(declaration))) return env.parameters.get(nodeSite(declaration));
      if (ts.isVariableDeclaration(declaration)) return this.variable(declaration, env);
      if (ts.isExportAssignment(declaration)) return this.evaluate(declaration.expression, env);
      return undefined;
    }
    if (!ts.isCallExpression(expression)) return undefined;
    const key = this.key(expression, env);
    if (this.values.has(key)) return this.values.get(key);
    if (this.evaluating.has(key) || ++this.calls > 600) { if (this.calls === 601) this.diagnose(expression, 'express-registration-limit', 'Static registration traversal exceeded 600 call sites'); return undefined; }
    this.evaluating.add(key);
    const value = this.call(expression, env);
    this.evaluating.delete(key); this.values.set(key, value); return value;
  }
  private call(call: ts.CallExpression, env: Environment): Value {
    let root = unwrap(call.expression);
    while (ts.isPropertyAccessExpression(root) || ts.isElementAccessExpression(root)) root = unwrap(root.expression);
    const rootDeclaration = valueDeclaration(root, env.checker);
    if (rootDeclaration && this.writes.has(nodeSite(rootDeclaration))) return undefined;
    const binding = frameworkBinding(call.expression, env.checker, this.scope.services);
    if (binding?.module === 'express' && ['default', 'Router'].includes(binding.member)) {
      const project = this.scope.services.resolver.owner(call.getSourceFile().fileName), range = validRange(project.dependencies.express ?? '');
      const profile = range && subset(range, '>=4.0.0 <5.0.0') ? 4 : range && subset(range, '>=5.0.0 <6.0.0') ? 5 : undefined;
      let label = 'anonymous';
      for (let parent: ts.Node | undefined = call.parent; parent && !ts.isSourceFile(parent); parent = parent.parent) {
        if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) { label = parent.name.text; break; }
        if (ts.isFunctionDeclaration(parent)) { label = parent.name?.text ?? 'factory'; break; }
      }
      const base = `${this.relative(call)}:${env.instance}:${label}`;
      const router: Router = { kind: binding.member === 'Router' ? 'router' : 'app', id: this.scope.context.graph.id('express-router', base, String(this.ordinal(base))), origin: call, app: env.app, major: profile, options: {}, conditions: [...env.conditions], proof: [...env.proof], registrations: [], mounts: [], middleware: [] };
      const options = call.arguments[0];
      if (binding.member === 'Router' && options && ts.isObjectLiteralExpression(options)) for (const property of options.properties) if (ts.isPropertyAssignment(property) && ['caseSensitive', 'strict'].includes(property.name.getText())) {
        if (property.initializer.kind === ts.SyntaxKind.TrueKeyword || property.initializer.kind === ts.SyntaxKind.FalseKeyword) router.options[property.name.getText() as keyof RouterOptions] = property.initializer.kind === ts.SyntaxKind.TrueKeyword;
        else { router.optionUnknown = true; this.diagnose(property, 'express-dynamic-router-option', 'Router matching options must be literal booleans'); }
      }
      if (options && !ts.isObjectLiteralExpression(options) && binding.member === 'Router') { router.optionUnknown = true; this.diagnose(options, 'express-dynamic-router-option', 'Router options are not a literal object'); }
      this.routers.push(router); return router;
    }
    const access = call.expression;
    if (ts.isPropertyAccessExpression(access) || ts.isElementAccessExpression(access)) {
      const method = ts.isPropertyAccessExpression(access) ? access.name.text : access.argumentExpression && ts.isStringLiteralLike(access.argumentExpression) ? access.argumentExpression.text : undefined;
      const receiver = this.evaluate(access.expression, env);
      if (routerValue(receiver) || builderValue(receiver)) {
        const router = routerValue(receiver) ? receiver : receiver.router;
        if (method === 'route' && routerValue(receiver)) { const paths = this.paths(call.arguments[0], env); if (paths) return { kind: 'builder', router, paths, node: call }; this.diagnose(call, 'express-dynamic-route', 'route() path is not a bounded literal string/array'); return undefined; }
        if (method === 'use' && routerValue(receiver)) { this.mount(router, call, env); return router; }
        if (method && verbs.has(method)) {
          if (router.kind === 'app' && method === 'get' && call.arguments.length === 1 && !builderValue(receiver)) return undefined; // app.get(setting)
          const paths = builderValue(receiver) ? receiver.paths : this.paths(call.arguments[0], env);
          const handlers = this.handlers(builderValue(receiver) ? [...call.arguments] : [...call.arguments].slice(1), call, router, method, paths ?? [], env);
          if (!handlers.length) { this.diagnose(call, 'express-unresolved-handler', 'No indexed handler can be bound for this registration'); }
          const opaque = paths ? undefined : call.arguments[0]?.getText() ?? '(missing path)';
          if (opaque) this.diagnose(call, 'express-dynamic-route', `Route path is opaque: ${opaque}`);
          const base = `${router.id}:${method}:${JSON.stringify(paths ?? opaque)}`;
          router.registrations.push({ id: this.scope.context.graph.id('express-registration', base, String(this.ordinal(base))), node: call, paths: paths ?? [opaque!], methods: method === 'all' ? '*' : method === 'get' ? ['GET', 'HEAD'] : [method.toUpperCase()], handlers, conditions: [...env.conditions], middleware: [...router.middleware], proof: [...env.proof], ...(opaque ? { opaque } : {}) });
          return receiver;
        }
        if (method === 'set' && router.kind === 'app') {
          const setting = call.arguments[0] ? this.evaluate(call.arguments[0], env) : undefined, value = call.arguments[1];
          if (setting === 'case sensitive routing' || setting === 'strict routing') {
            if (value && [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(value.kind)) router.options[setting === 'strict routing' ? 'strict' : 'caseSensitive'] = value.kind === ts.SyntaxKind.TrueKeyword;
            else { router.optionUnknown = true; this.diagnose(call, 'express-dynamic-router-option', 'Application matching options must be literal booleans'); }
          }
          return router;
        }
        if (method === 'listen') return router;
      }
    }
    const target = this.commonjsTarget(call.expression, env) ?? call.expression;
    const declaration = valueDeclaration(target, env.checker);
    const required = this.commonjsTarget(call, env);
    if (required) return this.evaluate(required, env);
    const fn = ts.isArrowFunction(target) || ts.isFunctionExpression(target) ? target : declaration && (ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration) ? declaration : ts.isVariableDeclaration(declaration) && declaration.initializer && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer)) ? declaration.initializer : undefined);
    if (!fn?.body || !this.scope.context.sources?.fileExists(fn.getSourceFile().fileName)) return undefined;
    const site = nodeSite(fn);
    if (env.stack.length >= 8 || env.stack.includes(site)) { this.diagnose(call, 'express-registration-limit', 'Recursive or deep registration helper exceeds the depth-eight summary limit'); return undefined; }
    const parameters = new Map(env.parameters);
    for (let i = 0; i < fn.parameters.length; i++) { const parameter = fn.parameters[i]!; parameters.set(nodeSite(parameter), call.arguments[i] ? this.evaluate(call.arguments[i]!, env) : parameter.initializer ? this.evaluate(parameter.initializer, env) : undefined); }
    const base = `${this.relative(call)}:${env.instance}:${call.expression.getText()}`;
    const child = { ...env, parameters, instance: `${base}:${this.ordinal(base)}`, stack: [...env.stack, site], proof: [...env.proof, this.fact(call, 'Static registration helper/factory invocation with bound arguments')] };
    return ts.isBlock(fn.body) ? this.statement(fn.body, child) : this.evaluate(fn.body, child);
  }
  private paths(node: ts.Expression | undefined, env: Environment): string[] | undefined {
    if (!node) return undefined;
    const value = this.evaluate(node, env);
    return typeof value === 'string' ? [value] : Array.isArray(value) && value.length ? [...new Set(value)] : undefined;
  }
  private handlers(nodes: ts.Expression[], call: ts.CallExpression, router: Router, method: string, paths: string[], env: Environment): Entity[] {
    const handlers: Entity[] = [];
    const visit = (expression: ts.Expression): void => {
      expression = unwrap(expression);
      if (ts.isArrayLiteralExpression(expression)) { for (const child of expression.elements) if (!ts.isSpreadElement(child)) visit(child); else this.diagnose(child, 'express-unresolved-handler', 'Spread handler arrays require a static expansion'); return; }
      let entity: Entity | undefined;
      if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) {
        const identity = `${router.id}:${method}:${JSON.stringify(paths)}:${handlers.length}`, ordinal = this.ordinal(`handler:${identity}`);
        entity = declareInlineHandler(this.scope, expression, 'express', `${identity}:${ordinal}`, `${method.toUpperCase()} ${paths.join(' | ') || '(dynamic path)'} handler ${handlers.length + 1}`);
      } else {
        const target = this.commonjsTarget(expression, env) ?? expression;
        const declaration = valueDeclaration(target, env.checker);
        entity = declaration ? this.scope.services.declarations.get(declaration) : undefined;
        if (!entity && (ts.isArrowFunction(target) || ts.isFunctionExpression(target))) entity = this.scope.services.declarations.get(target);
        if (!entity && declaration && ts.isVariableDeclaration(declaration) && declaration.initializer && ts.isArrayLiteralExpression(declaration.initializer)) { for (const item of declaration.initializer.elements) if (!ts.isSpreadElement(item)) visit(item); return; }
      }
      if (entity && ['function', 'method', 'component'].includes(entity.type)) { entity.metadata.executionContext = 'server'; handlers.push(entity); }
      else this.diagnose(expression, 'express-unresolved-handler', 'Handler expression does not resolve to an indexed callable declaration');
    };
    for (const node of nodes) visit(node); return handlers;
  }
  private handlerDeclaration(node: ts.Expression, env: Environment): Entity | true | undefined {
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return true;
    const declaration = valueDeclaration(node, env.checker);
    return declaration ? this.scope.services.declarations.get(declaration) : undefined;
  }
  /** Follow literal CommonJS exports through the indexed resolver. */
  private commonjsTarget(expression: ts.Expression, env: Environment, member = 'default', depth = 0, seen = new Set<string>()): ts.Expression | undefined {
    expression = unwrap(expression);
    if (depth > 10 || seen.has(nodeSite(expression))) return undefined;
    seen.add(nodeSite(expression));
    if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
      const name = ts.isPropertyAccessExpression(expression) ? expression.name.text : expression.argumentExpression && ts.isStringLiteralLike(expression.argumentExpression) ? expression.argumentExpression.text : undefined;
      return name ? this.commonjsTarget(expression.expression, env, name, depth + 1, seen) : undefined;
    }
    if (ts.isIdentifier(expression)) {
      const declaration = valueDeclaration(expression, env.checker);
      if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer && !this.writes.has(nodeSite(declaration))) return this.commonjsTarget(declaration.initializer, env, member, depth + 1, seen);
      if (declaration && ts.isBindingElement(declaration) && ts.isObjectBindingPattern(declaration.parent) && ts.isVariableDeclaration(declaration.parent.parent) && declaration.parent.parent.initializer) return this.commonjsTarget(declaration.parent.parent.initializer, env, declaration.propertyName?.getText() ?? declaration.name.getText(), depth + 1, seen);
    }
    if (!ts.isCallExpression(expression) || !ts.isIdentifier(expression.expression) || expression.expression.text !== 'require' || shadowedBinding(expression, 'require') || env.checker.getSymbolAtLocation(expression.expression)?.declarations?.length) return undefined;
    const argument = expression.arguments[0];
    if (expression.arguments.length !== 1 || !argument || !ts.isStringLiteralLike(argument)) return undefined;
    const target = this.scope.services.resolver.resolve(argument.text, expression.getSourceFile().fileName).resolvedModule;
    const source = target && env.program.getSourceFile(target.resolvedFileName);
    if (!source || !this.scope.context.sources?.fileExists(source.fileName)) return undefined;
    const assignments: ts.Expression[] = [];
    for (const statement of source.statements) {
      if (!ts.isExpressionStatement(statement) || !ts.isBinaryExpression(statement.expression) || statement.expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken) continue;
      const left = statement.expression.left;
      if (!ts.isPropertyAccessExpression(left)) continue;
      const receiver = left.expression;
      const exportedMember = ts.isIdentifier(receiver) && receiver.text === 'exports' && !shadowedBinding(left, 'exports') ? left.name.text : ts.isPropertyAccessExpression(receiver) && ts.isIdentifier(receiver.expression) && receiver.expression.text === 'module' && receiver.name.text === 'exports' && !shadowedBinding(left, 'module') ? left.name.text : ts.isIdentifier(receiver) && receiver.text === 'module' && left.name.text === 'exports' && !shadowedBinding(left, 'module') ? 'default' : undefined;
      if (exportedMember === member) assignments.push(statement.expression.right);
      if (exportedMember === 'default' && member !== 'default' && ts.isObjectLiteralExpression(statement.expression.right)) for (const property of statement.expression.right.properties) {
        if (ts.isPropertyAssignment(property) && property.name.getText().replace(/^['"]|['"]$/g, '') === member) assignments.push(property.initializer);
        if (ts.isShorthandPropertyAssignment(property) && property.name.text === member) assignments.push(property.name);
      }
    }
    if (assignments.length > 1) { this.diagnose(expression, 'express-ambiguous-export', 'Multiple CommonJS export assignments cannot prove one runtime value'); return undefined; }
    return assignments[0];
  }
  private mount(router: Router, call: ts.CallExpression, env: Environment): void {
    let start = 0, prefixes = ['/'];
    const paths = this.paths(call.arguments[0], env);
    if (paths) { prefixes = paths; start = 1; }
    else if (call.arguments[0] && !(routerValue(this.evaluate(call.arguments[0], env)) || this.handlerDeclaration(call.arguments[0], env))) {
      this.diagnose(call, 'express-dynamic-mount', 'A dynamic mount prefix cannot prove public route paths'); return;
    }
    const middleware: Entity[] = [];
    const visit = (node: ts.Expression): void => {
      if (ts.isArrayLiteralExpression(node)) { for (const child of node.elements) if (!ts.isSpreadElement(child)) visit(child); return; }
      const value = this.evaluate(node, env);
      if (routerValue(value)) router.mounts.push({ id: this.scope.context.graph.id('express-mount', router.id, value.id, JSON.stringify(prefixes), String(this.ordinal(`mount:${router.id}:${value.id}:${JSON.stringify(prefixes)}`))), child: value, prefixes, node: call, conditions: [...env.conditions], middleware: [...router.middleware, ...middleware] });
      else middleware.push(...this.handlers([node], call, router, 'use', prefixes, env));
    };
    for (const node of [...call.arguments].slice(start)) visit(node);
    if (prefixes.length === 1 && prefixes[0] === '/') router.middleware.push(...middleware);
    else if (middleware.length) this.diagnose(call, 'express-path-middleware', 'Path-scoped middleware is retained as a registration gap; ordering and next() control flow are not interpreted');
  }
  private emit(root: Router, router: Router, prefix: string, mounts: RoutingContract['mounts'], conditions: string[], middleware: Entity[], visiting: Set<string>): void {
    if (visiting.has(router.id) || mounts.length > 16) { this.diagnose(router.origin, 'express-mount-cycle', 'Cyclic/deep router mounts do not prove a public route'); return; }
    const parentId = this.scope.context.applicationIds.get(root.app!.name); if (!parentId) return;
    const next = new Set(visiting).add(router.id), graph = this.scope.context.graph;
    for (const registration of router.registrations) for (const childPath of registration.paths) {
      const routePath = composeRoutePath(prefix, childPath), pattern = compileExpressPath(routePath, router.major, router.options);
      if (router.optionUnknown || root.options.caseSensitive !== router.options.caseSensitive && !!(root.options.caseSensitive || router.options.caseSensitive) || root.options.strict !== router.options.strict && !!(root.options.strict || router.options.strict)) { pattern.status = 'partial'; pattern.reason = 'Dynamic or differing root/mounted-router matching options require a per-mount matcher'; pattern.alternatives = []; }
      if (registration.opaque) { pattern.status = 'partial'; pattern.reason = `Opaque route expression: ${registration.opaque}`; pattern.alternatives = []; }
      const constrained = [...conditions, ...registration.conditions], file = this.relative(registration.node), line = sourceRange(registration.node).startLine;
      const routing: RoutingContract = { version: 1, pattern, methods: registration.methods, executionContext: 'server', registration: { file, line, receiver: router.id }, mounts, middleware: [...middleware, ...registration.middleware].map(handler => handler.id), conditions: constrained };
      const method = registration.methods === '*' ? '*' : registration.methods[0]!;
      const facts = [this.fact(root.origin, 'Proven Express application construction'), ...root.proof, ...registration.proof, ...mounts.map(mount => evidence('framework', 'express', mount.file, mount.line, `Router mounted at ${mount.prefix}`)), this.fact(registration.node, 'HTTP route registration on a proven Express app/router')];
      const endpoint = graph.contain({ id: graph.id('endpoint', root.app!.name, 'express', root.id, registration.id, routePath, JSON.stringify(mounts.map(mount => [mount.id, mount.prefix]))), type: 'api_endpoint', name: `${method} ${routePath}`, parentId, path: file, sourceRange: sourceRange(registration.node), metadata: { method, routePath, framework: 'express', registration: 'registered', routing, ...(pattern.status === 'partial' || constrained.length ? { constraintsUnresolved: true } : {}) }, evidence: facts });
      registration.handlers.forEach((handler, index) => graph.relate(endpoint.id, handler.id, 'handles', [...facts, ...handler.evidence], { role: index === registration.handlers.length - 1 ? 'handler' : 'middleware', order: index }));
      for (const [index, handler] of [...middleware, ...registration.middleware].entries()) graph.relate(endpoint.id, handler.id, 'references', facts, { role: 'middleware', order: index });
      if (pattern.status === 'partial') this.diagnose(registration.node, 'express-route-constraints', pattern.reason!);
    }
    for (const mount of router.mounts) for (const child of mount.prefixes) this.emit(root, mount.child, composeRoutePath(prefix, child), [...mounts, { id: mount.id, file: this.relative(mount.node), line: sourceRange(mount.node).startLine, prefix: child }], [...conditions, ...mount.conditions, ...mount.child.conditions], [...middleware, ...mount.middleware], next);
  }
}
