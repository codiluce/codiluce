import ts from 'typescript';
import path from 'node:path';
import { subset, validRange } from 'semver';
import type { ApplicationConfig } from '../../core/config.js';
import { evidence, type Entity, type Evidence } from '../../core/graph.js';
import { compileExpressPath, composeRoutePath, type RoutingContract } from '../routes/contracts.js';
import { frameworkBinding, unwrap, valueDeclaration } from './typescript-binding.js';
import { nodeSite, sourceRange, type TypeScriptFrameworkPack, type TypeScriptPackScope, type TypeScriptPackFile } from './typescript-pack.js';
import { runtimeReference } from '../languages/typescript-runtime.js';

type ClassNode = ts.ClassDeclaration | ts.ClassExpression;
type Static = string | number | boolean | null | Static[] | { kind: 'object'; fields: Map<string, Static | undefined> } | { kind: 'class'; node: ClassNode } | { kind: 'enum'; member: string } | { kind: 'app'; app: Bootstrap } | undefined;
interface Decorator { name: string; call: ts.CallExpression; args: readonly ts.Expression[] }
interface Environment { checker: ts.TypeChecker; bindings: Map<string, Static>; instance: string; application?: ApplicationConfig; conditions: string[]; stack: string[]; proof: Evidence[] }
interface Bootstrap {
  id: string; node: ts.CallExpression; module: ClassNode; env: Environment;
  prefix: string; transport: 'express' | 'fastify' | 'unknown'; profile?: 4 | 5;
  conditions: string[]; proof: Evidence[]; versioning?: { type: string; prefix: string; defaultVersion: Static };
  globalRoles: { role: string; target: Entity }[];
}
interface ModuleRecord { node: ClassNode; frame: TypeScriptPackFile; decorator: Decorator; controllers: ClassNode[]; imports: ClassNode[]; routerRecords: Static[]; gaps: string[] }
const httpDecorators = new Set(['Get', 'Post', 'Put', 'Patch', 'Delete', 'Head', 'Options', 'All', 'Search']);
const roleDecorators: Record<string, string> = { UseGuards: 'guard', UsePipes: 'pipe', UseInterceptors: 'interceptor', UseFilters: 'filter' };
const classValue = (value: Static): value is { kind: 'class'; node: ClassNode } => !!value && typeof value === 'object' && !Array.isArray(value) && value.kind === 'class';
const objectValue = (value: Static): value is { kind: 'object'; fields: Map<string, Static | undefined> } => !!value && typeof value === 'object' && !Array.isArray(value) && value.kind === 'object';
const appValue = (value: Static): value is { kind: 'app'; app: Bootstrap } => !!value && typeof value === 'object' && !Array.isArray(value) && value.kind === 'app';
const enumValue = (value: Static): value is { kind: 'enum'; member: string } => !!value && typeof value === 'object' && !Array.isArray(value) && value.kind === 'enum';
const stringValues = (value: Static): string[] | undefined => typeof value === 'string' ? [value] : Array.isArray(value) && value.length > 0 && value.every(item => typeof item === 'string') ? [...new Set(value)] as string[] : undefined;

/** Imported decorators describe candidates; only an indexed module reachable
 * from a proven NestFactory.create invocation makes them public endpoints. */
export const nestPack: TypeScriptFrameworkPack = {
  id: 'nestjs', version: '1.0.0',
  applies: scope => scope.files.some(frame => frame.runtime.project.dependencies['@nestjs/core'] !== undefined || frame.file.application?.frameworks.includes('nestjs')),
  declare(scope): void { new NestRegistrations(scope).run(); },
};
class NestRegistrations {
  private readonly classes = new Map<string, { node: ClassNode; frame: TypeScriptPackFile; decorators: Decorator[] }>();
  private readonly modules = new Map<string, ModuleRecord>();
  private readonly bootstraps: Bootstrap[] = [];
  private readonly values = new Map<string, Static>();
  private readonly evaluating = new Set<string>();
  private readonly writes = new Set<string>();
  private readonly occurrences = new Map<string, number>();
  private readonly responses = new Set<string>();
  private readonly budgets = { endpoints: 0 };
  private steps = 0;
  constructor(private readonly scope: TypeScriptPackScope) {}
  private relative(node: ts.Node): string { return path.relative(this.scope.context.root, node.getSourceFile().fileName).split(path.sep).join('/'); }
  private fact(node: ts.Node, explanation: string): Evidence { return evidence('framework', 'nestjs', this.relative(node), sourceRange(node).startLine, explanation); }
  private diagnose(node: ts.Node, code: string, reason: string): void {
    const file = this.relative(node);
    this.scope.context.graph.diagnose({ analyzer: 'nestjs', severity: 'warning', code, file, line: sourceRange(node).startLine, entityId: this.scope.context.files.get(file)?.id, reason });
  }
  private ordinal(key: string): number { const count = this.occurrences.get(key) ?? 0; this.occurrences.set(key, count + 1); return count; }
  private env(frame: TypeScriptPackFile): Environment { return { checker: frame.state.checker, bindings: new Map(), instance: frame.file.path, application: frame.file.application, conditions: [], stack: [], proof: [] }; }
  private stamp(node: ts.Node): void {
    const file = this.scope.context.files.get(this.relative(node)), entity = file && this.scope.context.graph.entities.get(file.id);
    if (!entity) return;
    const packs = entity.metadata.frameworkPacks as string[] | undefined ?? [];
    if (!packs.includes('nestjs')) packs.push('nestjs'); entity.metadata.frameworkPacks = packs;
  }
  private summary(node: ts.Node, value: Record<string, unknown>): void {
    const file = this.scope.context.files.get(this.relative(node)), entity = file && this.scope.context.graph.entities.get(file.id);
    if (!entity) return;
    const records = entity.metadata.registrations as unknown[] | undefined ?? [];
    records.push({ version: 1, framework: 'nestjs', line: sourceRange(node).startLine, ...value }); entity.metadata.registrations = records;
  }
  private decorators(node: ts.Node, checker: ts.TypeChecker): Decorator[] {
    const result: Decorator[] = [];
    for (const decorator of ts.canHaveDecorators(node) ? ts.getDecorators(node) ?? [] : []) {
      if (!ts.isCallExpression(decorator.expression)) continue;
      const call = decorator.expression, binding = frameworkBinding(call.expression, checker, this.scope.services);
      if (binding?.module === '@nestjs/common') result.push({ name: binding.member, call, args: call.arguments });
    }
    return result;
  }
  private customDecorators(node: ts.Node, checker: ts.TypeChecker): string[] {
    const result: string[] = [];
    for (const decorator of ts.canHaveDecorators(node) ? ts.getDecorators(node) ?? [] : []) {
      const expression = ts.isCallExpression(decorator.expression) ? decorator.expression.expression : decorator.expression;
      const binding = frameworkBinding(expression, checker, this.scope.services);
      if (binding?.module === '@nestjs/common' || binding?.module === '@nestjs/swagger') continue;
      const name = expression.getText().slice(0, 100);
      result.push(`custom decorator: ${name}`);
      this.diagnose(decorator, 'nest-custom-decorator', `Decorator ${name} may alter registration or execution; composite decorator evaluation is outside this subset`);
    }
    return result;
  }
  run(): void {
    for (const frame of this.scope.files) {
      const visit = (node: ts.Node): void => {
        if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
          const decorators = this.decorators(node, frame.state.checker);
          this.classes.set(nodeSite(node), { node, frame, decorators });
          if (decorators.length) this.stamp(node);
        }
        if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment || ts.isPostfixUnaryExpression(node) || ts.isPrefixUnaryExpression(node) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator)) {
          const target = ts.isBinaryExpression(node) ? node.left : (node as ts.PrefixUnaryExpression | ts.PostfixUnaryExpression).operand;
          const declaration = valueDeclaration(target, frame.state.checker); if (declaration) this.writes.add(nodeSite(declaration));
        }
        ts.forEachChild(node, visit);
      }; visit(frame.source);
    }
    for (const { node, frame, decorators } of this.classes.values()) {
      const module = decorators.find(decorator => decorator.name === 'Module');
      if (module) this.modules.set(nodeSite(node), this.module(node, frame, module));
      const entity = this.scope.services.declarations.get(node);
      if (entity && decorators.some(decorator => decorator.name === 'Controller')) { entity.type = 'controller'; entity.metadata.framework = 'nestjs'; entity.metadata.executionContext = 'server'; this.summary(node, { kind: 'controller', receiver: entity.id, paths: stringValues(this.static(decorators.find(decorator => decorator.name === 'Controller')!.args[0], this.env(frame))) }); }
      if (entity && decorators.some(decorator => decorator.name === 'Injectable')) { entity.metadata.framework = 'nestjs'; entity.metadata.role = 'provider'; }
      this.dependencies(node, frame, decorators);
    }
    for (const frame of this.scope.files) for (const statement of frame.source.statements) this.statement(statement, this.env(frame));
    for (const bootstrap of this.bootstraps) this.emit(bootstrap);
  }
  private key(node: ts.Node, env: Environment): string {
    let parent = node.parent;
    while (parent && !ts.isSourceFile(parent) && !ts.isFunctionLike(parent)) parent = parent.parent;
    return `${nodeSite(node)}:${parent && ts.isFunctionLike(parent) ? env.instance : 'module'}`;
  }
  private static(expression: ts.Expression | undefined, env: Environment, depth = 0): Static {
    if (!expression || depth > 20 || ++this.steps > 15_000) return undefined;
    expression = unwrap(expression);
    if (ts.isVoidExpression(expression)) return this.static(expression.expression, env, depth + 1);
    if (ts.isStringLiteralLike(expression)) return expression.text;
    if (ts.isNumericLiteral(expression)) return Number(expression.text);
    if (expression.kind === ts.SyntaxKind.TrueKeyword || expression.kind === ts.SyntaxKind.FalseKeyword) return expression.kind === ts.SyntaxKind.TrueKeyword;
    if (expression.kind === ts.SyntaxKind.NullKeyword) return null;
    if (ts.isArrayLiteralExpression(expression)) {
      if (expression.elements.length > 128) return undefined;
      const result: Static[] = [];
      for (const item of expression.elements) {
        if (ts.isSpreadElement(item)) { const spread = this.static(item.expression, env, depth + 1); if (!Array.isArray(spread)) return undefined; result.push(...spread); }
        else result.push(this.static(item, env, depth + 1));
      }
      return result.length <= 128 ? result : undefined;
    }
    if (ts.isObjectLiteralExpression(expression)) {
      const fields = new Map<string, Static | undefined>();
      for (const property of expression.properties) {
        if (ts.isSpreadAssignment(property)) { const spread = this.static(property.expression, env, depth + 1); if (!objectValue(spread)) return undefined; for (const [key, value] of spread.fields) fields.set(key, value); }
        else if (ts.isPropertyAssignment(property)) fields.set(property.name.getText().replace(/^['"]|['"]$/g, ''), this.static(property.initializer, env, depth + 1));
        else if (ts.isShorthandPropertyAssignment(property)) fields.set(property.name.text, this.static(property.name, env, depth + 1));
        else return undefined;
      }
      return { kind: 'object', fields };
    }
    if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) { const left = this.static(expression.left, env, depth + 1), right = this.static(expression.right, env, depth + 1); return typeof left === 'string' && typeof right === 'string' ? left + right : undefined; }
    if (!runtimeReference(expression, env.checker)) return undefined;
    const binding = frameworkBinding(expression, env.checker, this.scope.services);
    if (binding?.module === '@nestjs/common' && binding.member === 'VERSION_NEUTRAL') return { kind: 'enum', member: 'VERSION_NEUTRAL' };
    if (ts.isPropertyAccessExpression(expression)) {
      const base = frameworkBinding(expression.expression, env.checker, this.scope.services);
      if (base?.module === '@nestjs/common' && ['VersioningType', 'RequestMethod'].includes(base.member)) return { kind: 'enum', member: expression.name.text };
      const receiver = this.static(expression.expression, env, depth + 1);
      if (objectValue(receiver)) return receiver.fields.get(expression.name.text);
    }
    const declaration = valueDeclaration(expression, env.checker);
    if (declaration) {
      const site = nodeSite(declaration);
      if (env.bindings.has(site)) return env.bindings.get(site);
      if (ts.isClassDeclaration(declaration) || ts.isClassExpression(declaration)) return this.classes.has(site) ? { kind: 'class', node: declaration } : undefined;
      if (ts.isVariableDeclaration(declaration) && !this.writes.has(site)) {
        const key = this.key(declaration, env); if (this.values.has(key)) return this.values.get(key); if (this.evaluating.has(key)) return undefined;
        this.evaluating.add(key); const value = this.static(declaration.initializer, env, depth + 1); this.evaluating.delete(key); this.values.set(key, value); return value;
      }
    }
    if (ts.isNewExpression(expression)) {
      const target = valueDeclaration(expression.expression, env.checker);
      if (target && (ts.isClassDeclaration(target) || ts.isClassExpression(target))) return { kind: 'class', node: target };
    }
    if (ts.isCallExpression(expression)) {
      if (binding?.module === '@nestjs/common' && binding.member === 'forwardRef') {
        const fn = expression.arguments[0];
        if (fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) return ts.isBlock(fn.body) ? this.returned(fn.body, env) : this.static(fn.body, env, depth + 1);
      }
      return this.call(expression, env);
    }
    return undefined;
  }
  private statement(node: ts.Statement, env: Environment): Static {
    if (++this.steps > 15_000) { if (this.steps === 15_001) this.diagnose(node, 'nest-registration-limit', 'Static registration traversal exceeded 15,000 steps'); return undefined; }
    if (ts.isVariableStatement(node)) { for (const declaration of node.declarationList.declarations) if (declaration.initializer) { const value = this.static(declaration.initializer, env); if (appValue(value) && this.writes.has(nodeSite(declaration))) value.app.conditions.push('reassigned bootstrap binding'); this.values.set(this.key(declaration, env), value); } }
    else if (ts.isExpressionStatement(node)) return this.static(node.expression, env);
    else if (ts.isReturnStatement(node)) return this.static(node.expression, env);
    else if (ts.isExportAssignment(node)) return this.static(node.expression, env);
    else if (ts.isBlock(node)) return this.returned(node, env);
    else if (ts.isIfStatement(node)) {
      const text = node.expression.getText().slice(0, 120);
      this.statement(node.thenStatement, { ...env, conditions: [...env.conditions, text] });
      if (node.elseStatement) this.statement(node.elseStatement, { ...env, conditions: [...env.conditions, `!(${text})`] });
    } else if (ts.isTryStatement(node)) { this.statement(node.tryBlock, { ...env, conditions: [...env.conditions, 'try-dependent bootstrap'] }); if (node.catchClause) this.statement(node.catchClause.block, { ...env, conditions: [...env.conditions, 'catch-dependent bootstrap'] }); if (node.finallyBlock) this.statement(node.finallyBlock, env); }
    return undefined;
  }
  private returned(block: ts.Block, env: Environment): Static { for (const statement of block.statements) { const value = this.statement(statement, env); if (ts.isReturnStatement(statement)) return value; } return undefined; }
  private call(call: ts.CallExpression, env: Environment): Static {
    const key = this.key(call, env); if (this.values.has(key)) return this.values.get(key);
    if (this.evaluating.has(key)) return undefined; this.evaluating.add(key);
    const result = this.callValue(call, env); this.evaluating.delete(key); this.values.set(key, result); return result;
  }
  private callValue(call: ts.CallExpression, env: Environment): Static {
    if (ts.isPropertyAccessExpression(call.expression)) {
      const access = call.expression, binding = frameworkBinding(access.expression, env.checker, this.scope.services);
      const factoryDeclaration = valueDeclaration(access.expression, env.checker);
      if (factoryDeclaration && this.writes.has(nodeSite(factoryDeclaration))) return undefined;
      if (binding?.module === '@nestjs/core' && binding.member === 'RouterModule' && access.name.text === 'register') {
        const records = this.static(call.arguments[0], env);
        if (!Array.isArray(records)) { this.diagnose(call, 'nest-dynamic-router-module', 'RouterModule.register routes must be a statically bound array'); return undefined; }
        return { kind: 'object', fields: new Map([['$routerRecords', records]]) };
      }
      if (binding?.module === '@nestjs/core' && binding.member === 'NestFactory' && access.name.text === 'create') {
        const module = this.static(call.arguments[0], env);
        if (!classValue(module) || !this.modules.has(nodeSite(module.node))) { this.diagnose(call, 'nest-unresolved-bootstrap-module', 'NestFactory.create does not bind to an indexed @Module class'); return undefined; }
        const adapter = call.arguments[1], adapterBinding = adapter && ts.isNewExpression(unwrap(adapter)) ? frameworkBinding((unwrap(adapter) as ts.NewExpression).expression, env.checker, this.scope.services) : undefined;
        const transport = adapterBinding?.module === '@nestjs/platform-fastify' && adapterBinding.member === 'FastifyAdapter' ? 'fastify' : adapterBinding?.module === '@nestjs/platform-express' && adapterBinding.member === 'ExpressAdapter' ? 'express' : adapter && ts.isNewExpression(unwrap(adapter)) ? 'unknown' : 'express';
        const project = this.scope.services.resolver.owner(call.getSourceFile().fileName), range = validRange(project.dependencies['@nestjs/core'] ?? '');
        const profile = range && subset(range, '>=11.0.0 <12.0.0') ? 5 : range && subset(range, '>=9.0.0 <11.0.0') ? 4 : undefined;
        const identity = `${env.application?.name ?? project.id}:${this.relative(call)}:${env.instance}:${module.node.name?.text ?? 'module'}`;
        const app: Bootstrap = { id: this.scope.context.graph.id('nest-bootstrap', identity, String(this.ordinal(identity))), node: call, module: module.node, env, prefix: '', transport, profile, conditions: [...env.conditions, ...(transport === 'unknown' ? ['unknown HTTP adapter'] : [])], proof: [...env.proof, this.fact(call, 'NestFactory.create bootstraps the bound indexed module')], globalRoles: [] };
        this.bootstraps.push(app); this.stamp(call); return { kind: 'app', app };
      }
      const receiver = this.static(access.expression, env);
      if (appValue(receiver)) {
        const app = receiver.app;
        if (access.name.text === 'setGlobalPrefix') {
          const prefix = this.static(call.arguments[0], env);
          if (typeof prefix === 'string') app.prefix = prefix; else { app.conditions.push('dynamic global prefix'); this.diagnose(call, 'nest-dynamic-prefix', 'Global prefix is not a statically bound string'); }
          if (call.arguments[1]) { app.conditions.push('global prefix exclusions'); this.diagnose(call, 'nest-prefix-exclusions', 'Global prefix exclusions require per-route exclusion evaluation'); }
          app.conditions.push(...env.conditions); app.proof.push(this.fact(call, 'Declared global route prefix'));
        } else if (access.name.text === 'enableVersioning') {
          const options = this.static(call.arguments[0], env), fields = objectValue(options) ? options.fields : undefined;
          const type = fields?.get('type') ?? { kind: 'enum', member: 'URI' }, prefix = fields?.get('prefix');
          if (call.arguments.length && !fields || !enumValue(type) || fields?.has('prefix') && prefix !== false && typeof prefix !== 'string') { app.conditions.push('dynamic versioning configuration'); this.diagnose(call, 'nest-dynamic-versioning', 'Versioning type/prefix must bind to a known enum and literal options'); }
          else app.versioning = { type: type.member, prefix: prefix === false ? '' : typeof prefix === 'string' ? prefix : 'v', defaultVersion: fields?.get('defaultVersion') };
          app.conditions.push(...env.conditions); app.proof.push(this.fact(call, 'Declared request versioning configuration'));
        } else if (/^useGlobal(Guards|Pipes|Interceptors|Filters)$/.test(access.name.text)) {
          const role = access.name.text.replace(/^useGlobal/, '').replace(/s$/, '').toLowerCase();
          for (const argument of call.arguments) { const value = this.static(argument, env), target = classValue(value) && this.scope.services.declarations.get(value.node); if (target) app.globalRoles.push({ role, target }); else this.diagnose(argument, 'nest-unresolved-framework-role', 'Global framework role does not bind to an indexed class'); }
        } else if (!['listen', 'init', 'enableCors', 'useLogger', 'flushLogs', 'close'].includes(access.name.text)) { app.conditions.push(`unsupported bootstrap operation: ${access.name.text}`); this.diagnose(call, 'nest-unsupported-bootstrap-operation', `Bootstrap operation ${access.name.text} is outside the static routing subset`); }
        return receiver;
      }
    }
    const target = unwrap(call.expression), declaration = valueDeclaration(target, env.checker);
    const fn = ts.isArrowFunction(target) || ts.isFunctionExpression(target) ? target : declaration && (ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration) ? declaration : ts.isVariableDeclaration(declaration) && declaration.initializer && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer)) ? declaration.initializer : undefined);
    if (!fn?.body || !this.scope.context.sources?.fileExists(fn.getSourceFile().fileName)) return undefined;
    const site = nodeSite(fn);
    if (env.stack.includes(site) || env.stack.length >= 8) { this.diagnose(call, 'nest-registration-limit', 'Recursive/deep bootstrap helpers exceed the depth-eight summary limit'); return undefined; }
    const bindings = new Map(env.bindings);
    fn.parameters.forEach((parameter, index) => bindings.set(nodeSite(parameter), this.static(call.arguments[index] ?? parameter.initializer, env)));
    const base = `${env.instance}:${this.relative(call)}:${call.expression.getText()}`;
    const child: Environment = { ...env, bindings, instance: `${base}:${this.ordinal(base)}`, stack: [...env.stack, site], proof: [...env.proof, this.fact(call, 'Invoked indexed bootstrap helper with statically bound arguments')] };
    return ts.isBlock(fn.body) ? this.returned(fn.body, child) : this.static(fn.body, child);
  }
  private module(node: ClassNode, frame: TypeScriptPackFile, decorator: Decorator): ModuleRecord {
    const env = this.env(frame), value = this.static(decorator.args[0], env), fields = objectValue(value) ? value.fields : undefined;
    const record: ModuleRecord = { node, frame, decorator, controllers: [], imports: [], routerRecords: [], gaps: [] };
    if (!fields) { record.gaps.push('dynamic module metadata'); this.diagnose(decorator.call, 'nest-dynamic-module', 'Module metadata is not a statically bound object'); return record; }
    for (const field of ['controllers', 'imports'] as const) {
      const value = fields.get(field); if (value === undefined && !fields.has(field)) continue;
      if (!Array.isArray(value)) { record.gaps.push(`dynamic module ${field}`); this.diagnose(decorator.call, 'nest-dynamic-module', `Module ${field} must be a statically bound array`); continue; }
      for (const item of value) if (classValue(item)) record[field].push(item.node); else if (field === 'imports' && objectValue(item) && item.fields.has('$routerRecords')) record.routerRecords.push(item.fields.get('$routerRecords')); else { record.gaps.push(`unresolved module ${field}`); this.diagnose(decorator.call, 'nest-unresolved-module-member', `A module ${field} member is dynamic, external or not an indexed class`); }
    }
    const owner = this.scope.services.declarations.get(node);
    this.summary(node, { kind: 'module', receiver: owner?.id, controllers: record.controllers.map(node => this.scope.services.declarations.get(node)?.id), imports: record.imports.map(node => this.scope.services.declarations.get(node)?.id), conditions: record.gaps });
    if (owner) for (const field of ['controllers', 'imports', 'providers'] as const) {
      const value = fields.get(field);
      for (const item of Array.isArray(value) ? value : []) if (classValue(item)) {
        const target = this.scope.services.declarations.get(item.node);
        if (target) this.scope.context.graph.relate(owner.id, target.id, 'references', [this.fact(decorator.call, `Declared module ${field} member`)], { framework: 'nestjs', role: field === 'providers' ? 'provider' : field === 'controllers' ? 'controller' : 'module' });
      }
    }
    return record;
  }
  private dependencies(node: ClassNode, frame: TypeScriptPackFile, decorators: Decorator[]): void {
    const owner = this.scope.services.declarations.get(node);
    if (!owner || !decorators.some(decorator => ['Controller', 'Injectable'].includes(decorator.name))) return;
    const constructor = node.members.find(ts.isConstructorDeclaration);
    for (const parameter of constructor?.parameters ?? []) {
      const inject = this.decorators(parameter, frame.state.checker).find(decorator => decorator.name === 'Inject');
      const expression = inject?.args[0] ?? (parameter.type && ts.isTypeReferenceNode(parameter.type) ? parameter.type.typeName : undefined);
      let target: Entity | undefined;
      if (expression) {
        if (ts.isExpression(expression)) { const value = this.static(expression, this.env(frame)); if (classValue(value)) target = this.scope.services.declarations.get(value.node); }
        else { const declaration = frame.state.checker.getSymbolAtLocation(expression); let symbol = declaration; if (symbol?.flags && symbol.flags & ts.SymbolFlags.Alias) symbol = frame.state.checker.getAliasedSymbol(symbol); const value = symbol?.valueDeclaration; if (value && (ts.isClassDeclaration(value) || ts.isClassExpression(value))) target = this.scope.services.declarations.get(value); }
      }
      if (target) this.scope.context.graph.relate(owner.id, target.id, 'references', [this.fact(parameter, 'Declared constructor injection dependency; this does not assert a method call')], { framework: 'nestjs', role: 'injection', parameter: parameter.name.getText() });
      else this.diagnose(parameter, 'nest-unresolved-injection', 'Constructor dependency has a dynamic token, external type or ambiguous indexed target');
    }
  }
  private roles(node: ts.Node, frame: TypeScriptPackFile): { role: string; target: Entity; fact: Evidence }[] {
    const result: { role: string; target: Entity; fact: Evidence }[] = [];
    for (const decorator of this.decorators(node, frame.state.checker)) {
      const role = roleDecorators[decorator.name]; if (!role) continue;
      for (const argument of decorator.args) {
        const value = this.static(argument, this.env(frame)), target = classValue(value) && this.scope.services.declarations.get(value.node);
        if (target) result.push({ role, target, fact: this.fact(decorator.call, `Declared ${role} class`) });
        else this.diagnose(argument, 'nest-unresolved-framework-role', `Declared ${role} does not bind to an indexed class`);
      }
    }
    return result;
  }
  private emit(app: Bootstrap): void {
    const application = app.env.application, parentId = application && this.scope.context.applicationIds.get(application.name);
    if (!parentId) { this.diagnose(app.node, 'nest-bootstrap-without-application', 'A bootstrap source outside a runtime application cannot establish an HTTP boundary'); return; }
    const reachable = new Map<string, ModuleRecord>();
    const visit = (node: ClassNode): void => {
      const site = nodeSite(node); if (reachable.has(site)) return;
      const record = this.modules.get(site);
      if (!record) { app.conditions.push('unresolved imported module'); this.diagnose(node, 'nest-unresolved-module', 'Imported module class has no proven @Module metadata'); return; }
      reachable.set(site, record); for (const child of record.imports) visit(child);
    }; visit(app.module);
    for (const module of reachable.values()) app.conditions.push(...module.gaps);
    const prefixes = new Map<string, { path: string; proof: Evidence[] }[]>();
    const mount = (records: Static, prefix: string, owner: ModuleRecord, depth: number): void => {
      if (!Array.isArray(records) || depth > 16) { this.diagnose(owner.decorator.call, 'nest-dynamic-router-module', 'Router module children must be a bounded static array'); owner.gaps.push('dynamic router module mounts'); return; }
      for (const record of records) {
        if (!objectValue(record)) { owner.gaps.push('dynamic router module record'); continue; }
        const path = record.fields.get('path'), module = record.fields.get('module');
        if (typeof path !== 'string' || module !== undefined && !classValue(module)) { this.diagnose(owner.decorator.call, 'nest-dynamic-router-module', 'Router module path/module must bind to a string and indexed class'); owner.gaps.push('dynamic router module record'); continue; }
        const joined = composeRoutePath(prefix, path).replace(/\/$/, '') || '/';
        if (classValue(module)) {
          const site = nodeSite(module.node);
          if (!reachable.has(site)) { this.diagnose(owner.decorator.call, 'nest-unregistered-router-module', 'Router mount names a module that is absent from the bootstrap module imports'); continue; }
          const list = prefixes.get(site) ?? []; list.push({ path: joined, proof: [this.fact(owner.decorator.call, `RouterModule.register mounts ${module.node.name?.text ?? 'module'} at ${joined}`)] }); prefixes.set(site, list);
        }
        if (record.fields.has('children')) mount(record.fields.get('children'), joined, owner, depth + 1);
      }
    };
    for (const module of reachable.values()) for (const records of module.routerRecords) mount(records, '', module, 0);
    for (const module of reachable.values()) for (const gap of module.gaps) if (!app.conditions.includes(gap)) app.conditions.push(gap);
    this.summary(app.node, { kind: 'bootstrap', receiver: app.id, module: this.scope.services.declarations.get(app.module)?.id, prefix: app.prefix, transport: app.transport, conditions: app.conditions });
    const controllers = new Map<string, { node: ClassNode; module: ModuleRecord }>();
    for (const module of reachable.values()) for (const node of module.controllers) controllers.set(`${nodeSite(module.node)}:${nodeSite(node)}`, { node, module });
    for (const { node, module } of controllers.values()) for (const prefix of prefixes.get(nodeSite(module.node)) ?? [{ path: '', proof: [] }]) this.controller(app, parentId, node, module, prefix);
  }
  private controller(app: Bootstrap, parentId: string, node: ClassNode, module: ModuleRecord, mount: { path: string; proof: Evidence[] }): void {
    const record = this.classes.get(nodeSite(node)); if (!record) return;
    const decorator = record.decorators.find(decorator => decorator.name === 'Controller');
    if (!decorator) { this.diagnose(node, 'nest-unresolved-controller', 'Registered controller has no imported @Controller decorator'); return; }
    const env = this.env(record.frame), value = decorator.args.length ? this.static(decorator.args[0], env) : '';
    const fields = objectValue(value) ? value.fields : undefined;
    const prefixes = stringValues(fields ? fields.has('path') ? fields.get('path') : '' : value);
    const controllerConditions = [...app.conditions, ...module.gaps];
    controllerConditions.push(...this.customDecorators(node, record.frame.state.checker));
    for (const member of node.members) if (ts.isMethodDeclaration(member)) controllerConditions.push(...this.customDecorators(member, record.frame.state.checker));
    if (!prefixes) { controllerConditions.push('dynamic controller prefix'); this.diagnose(decorator.call, 'nest-dynamic-prefix', 'Controller path is not a static string/array'); }
    if (fields?.has('host')) controllerConditions.push(`host: ${JSON.stringify(stringValues(fields.get('host')) ?? '(dynamic)')}`);
    const classRoles = this.roles(node, record.frame);
    for (const member of node.members) {
      if (!ts.isMethodDeclaration(member)) continue;
      const handler = this.scope.services.declarations.get(member); if (!handler) continue;
      const decorators = this.decorators(member, record.frame.state.checker), routes = decorators.filter(decorator => httpDecorators.has(decorator.name));
      if (!routes.length) continue;
      handler.metadata.framework = 'nestjs'; handler.metadata.executionContext = 'server'; handler.metadata.role = 'handler';
      const version = decorators.find(decorator => decorator.name === 'Version'), versionValue = version ? this.static(version.args[0], env) : fields?.get('version') ?? app.versioning?.defaultVersion;
      const versions: Static[] = Array.isArray(versionValue) ? versionValue : [versionValue];
      if (app.versioning && versionValue === undefined && !version && !fields?.has('version') && app.versioning.defaultVersion === undefined) { this.diagnose(member, 'nest-unversioned-route', 'Versioning is enabled without a route/controller/default version; this handler is not publicly matched'); continue; }
      const versionPaths: { path: string; conditions: string[] }[] = [];
      if (!app.versioning) versionPaths.push({ path: '', conditions: version ? ['version decorator without an enabled versioning profile'] : [] });
      else for (const value of versions) {
        if (enumValue(value) && value.member === 'VERSION_NEUTRAL') versionPaths.push({ path: '', conditions: [] });
        else if (app.versioning.type === 'URI' && typeof value === 'string') versionPaths.push({ path: `${app.versioning.prefix}${value}`, conditions: [] });
        else versionPaths.push({ path: '', conditions: [`${app.versioning.type.toLowerCase()} version: ${typeof value === 'string' ? value : '(unresolved)'}`] });
      }
      const methodRoles = [...classRoles, ...this.roles(member, record.frame)];
      for (const route of routes) {
        const paths = route.args.length ? stringValues(this.static(route.args[0], env)) : [''];
        if (!paths) this.diagnose(route.call, 'nest-dynamic-route', 'Handler path is not a statically bound string/array');
        for (const prefix of prefixes ?? ['(dynamic-controller)']) for (const child of paths ?? ['(dynamic-handler)']) for (const version of versionPaths) {
          if (++this.budgets.endpoints > 4096) { if (this.budgets.endpoints === 4097) this.diagnose(route.call, 'nest-registration-limit', 'Route combinations exceed the 4,096-endpoint component limit'); return; }
          const routePath = composeRoutePath(composeRoutePath(composeRoutePath(composeRoutePath(`/${app.prefix}`, version.path), mount.path), prefix), child).replace(/\/$/, '') || '/';
          const pattern = compileExpressPath(routePath, app.transport === 'express' ? app.profile : undefined, { caseSensitive: app.transport === 'fastify' });
          const conditions = [...controllerConditions, ...version.conditions, ...(!paths ? ['dynamic handler path'] : [])];
          if (!prefixes || !paths) { pattern.status = 'partial'; pattern.reason = 'Dynamic controller or handler path'; pattern.alternatives = []; }
          const methods = route.name === 'All' ? '*' : route.name === 'Get' && app.transport === 'express' ? ['GET', 'HEAD'] : [route.name.toUpperCase()];
          const file = this.relative(route.call), line = sourceRange(route.call).startLine;
          const routing: RoutingContract = { version: 1, pattern, methods, executionContext: 'server', registration: { file, line, receiver: app.id }, mounts: [], middleware: [], conditions };
          const facts = [...app.proof, ...mount.proof, this.fact(module.decorator.call, 'Controller registered in a bootstrap-reachable module'), this.fact(decorator.call, 'Imported controller decorator'), this.fact(route.call, 'Imported HTTP method decorator')];
          const endpointId = this.scope.context.graph.id('endpoint', applicationName(app), 'nestjs', app.id, this.scope.services.declarations.get(module.node)?.id ?? module.node.name?.text ?? 'module', handler.id, route.name, routePath, JSON.stringify(conditions));
          const endpoint = this.scope.context.graph.entities.get(endpointId) ?? this.scope.context.graph.contain({ id: endpointId, type: 'api_endpoint', name: `${methods === '*' ? '*' : methods[0]} ${routePath}`, path: file, sourceRange: sourceRange(member), parentId, metadata: { method: methods === '*' ? '*' : methods[0], routePath, framework: 'nestjs', registration: 'registered', transport: app.transport, routing, ...(conditions.length || pattern.status === 'partial' ? { constraintsUnresolved: true } : {}) }, evidence: facts });
          this.scope.context.graph.relate(endpoint.id, handler.id, 'handles', [...facts, ...handler.evidence]);
          for (const role of methodRoles) this.scope.context.graph.relate(endpoint.id, role.target.id, 'references', [role.fact], { framework: 'nestjs', role: role.role });
          for (const role of app.globalRoles) this.scope.context.graph.relate(endpoint.id, role.target.id, 'references', app.proof, { framework: 'nestjs', role: role.role, scope: 'global' });
          const response = decorators.find(decorator => decorator.name === 'HttpCode'), code = response && this.static(response.args[0], env);
          const nativeResponse = member.parameters.some(parameter => this.decorators(parameter, record.frame.state.checker).some(decorator => ['Res', 'Response', 'Next'].includes(decorator.name)));
          if (response && typeof code !== 'number') this.diagnose(response.call, 'nest-dynamic-response-status', 'HttpCode status is not a statically bound number');
          if (!nativeResponse && member.body && !this.responses.has(handler.id)) { record.frame.state.sites.effect(handler.id, { category: 'response', operation: 'return', detail: 'Nest standard handler response', ...(!response || typeof code === 'number' ? { status: typeof code === 'number' ? code : route.name === 'Post' ? 201 : 200 } : {}), line: sourceRange(member).startLine, via: 'Nest standard response convention' }); this.responses.add(handler.id); }
          this.stamp(member);
        }
      }
    }
  }
}
function applicationName(app: Bootstrap): string { return app.env.application?.name ?? app.id; }
