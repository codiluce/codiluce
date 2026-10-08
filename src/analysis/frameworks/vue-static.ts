import ts from 'typescript';
import { subset, validRange } from 'semver';
import { evidence, type Entity, type Evidence } from '../../core/graph.js';
import { sourcePath, sourceMapped } from '../embedded/index.js';
import { runtimeReference } from '../languages/typescript-runtime.js';
import { frameworkBinding, unwrap, valueDeclaration } from './typescript-binding.js';
import { nodeSite, sourceRange, type TypeScriptPackScope } from './typescript-pack.js';

export const propertyName = (name: ts.PropertyName): string | undefined => ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name) ? name.text : undefined;
export function profile(specifier: string | undefined, major: number): boolean {
  const range = specifier && validRange(specifier);
  return !!range && subset(range, `>=${major}.0.0 <${major + 1}.0.0`);
}
/** Read indexed constants; never run component factories, build plugins or
 * application configuration. Mutation invalidates the complete receiver. */
export class VueStatic {
  readonly writes = new Set<string>();
  private steps = 0;
  constructor(readonly scope: TypeScriptPackScope) {
    for (const frame of scope.files) {
      const mark = (expression: ts.Expression, seen = new Set<string>()): void => {
        let root = expression;
        while (ts.isPropertyAccessExpression(root) || ts.isElementAccessExpression(root)) root = root.expression;
        const declaration = valueDeclaration(root, frame.state.checker);
        if (declaration) {
          const key = nodeSite(declaration); if (seen.has(key)) return; seen.add(key); this.writes.add(key);
          if (ts.isVariableDeclaration(declaration) && declaration.initializer && (ts.isIdentifier(unwrap(declaration.initializer)) || ts.isPropertyAccessExpression(unwrap(declaration.initializer)) || ts.isElementAccessExpression(unwrap(declaration.initializer)))) mark(unwrap(declaration.initializer), seen);
          if (ts.isExportAssignment(declaration)) mark(declaration.expression, seen);
        }
      };
      const visit = (node: ts.Node): void => {
        if (!ts.isSourceFile(node) && !sourceMapped(scope.context, frame.source.fileName, node.getStart(frame.source), node.end)) return;
        if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) mark(node.left);
        if (ts.isPostfixUnaryExpression(node) || ts.isPrefixUnaryExpression(node) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator)) mark(node.operand);
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ['push', 'pop', 'splice', 'shift', 'unshift', 'sort', 'reverse', 'fill', 'copyWithin'].includes(node.expression.name.text)) mark(node.expression.expression);
        if (ts.isCallExpression(node)) {
          const binding = frameworkBinding(node.expression, frame.state.checker, scope.services);
          if (!binding || !['vue', 'vue-router'].includes(binding.module)) for (const argument of node.arguments) {
            const declaration = valueDeclaration(argument, frame.state.checker);
            let value = declaration && ts.isVariableDeclaration(declaration) ? declaration.initializer : declaration && ts.isExportAssignment(declaration) ? declaration.expression : undefined;
            const visited = new Set<string>();
            while (value && ts.isIdentifier(unwrap(value))) {
              const target = valueDeclaration(unwrap(value), frame.state.checker), key = target && nodeSite(target);
              if (!key || visited.has(key)) { value = undefined; break; } visited.add(key);
              value = target && ts.isVariableDeclaration(target) ? target.initializer : target && ts.isExportAssignment(target) ? target.expression : undefined;
            }
            if (value && (ts.isObjectLiteralExpression(unwrap(value)) || ts.isArrayLiteralExpression(unwrap(value)))) mark(argument);
          }
        }
        ts.forEachChild(node, visit);
      }; visit(frame.source);
    }
  }
  path(node: ts.Node): string { return sourcePath(this.scope.context, node.getSourceFile().fileName); }
  fact(node: ts.Node, reason: string): Evidence { return { ...evidence('framework', 'vue', this.path(node), sourceRange(node).startLine, reason), endLine: sourceRange(node).endLine }; }
  gap(node: ts.Node, code: string, reason: string): void {
    const file = this.path(node);
    this.scope.context.graph.diagnose({ analyzer: 'vue', severity: 'warning', code, file, line: sourceRange(node).startLine, entityId: this.scope.context.files.get(file)?.id, reason });
  }
  stamp(node: ts.Node, pack = 'vue'): void {
    const file = this.scope.context.files.get(this.path(node)), entity = file && this.scope.context.graph.entities.get(file.id);
    if (!entity) return;
    const packs = entity.metadata.frameworkPacks as string[] | undefined ?? [];
    if (!packs.includes(pack)) packs.push(pack); entity.metadata.frameworkPacks = packs;
  }
  resolve(expression: ts.Expression | undefined, checker: ts.TypeChecker, seen = new Set<string>(), depth = 0): ts.Expression | undefined {
    if (!expression || depth > 20 || ++this.steps > 30_000) return undefined;
    expression = unwrap(expression);
    if (!runtimeReference(expression, checker)) return undefined;
    if (ts.isIdentifier(expression) || ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
      const declaration = valueDeclaration(expression, checker);
      if (declaration) {
        const key = nodeSite(declaration);
        if (this.writes.has(key) || seen.has(key)) return undefined;
        seen.add(key);
        if (ts.isVariableDeclaration(declaration)) {
          if (!(ts.isVariableDeclarationList(declaration.parent) && declaration.parent.flags & ts.NodeFlags.Const)) return undefined;
          return this.resolve(declaration.initializer, checker, seen, depth + 1);
        }
        if (ts.isExportAssignment(declaration)) return this.resolve(declaration.expression, checker, seen, depth + 1);
        if (ts.isPropertyAssignment(declaration)) return this.resolve(declaration.initializer, checker, seen, depth + 1);
        if (ts.isShorthandPropertyAssignment(declaration)) {
          const symbol = checker.getShorthandAssignmentValueSymbol(declaration), value = symbol?.valueDeclaration;
          if (value && ts.isVariableDeclaration(value)) return this.resolve(value.initializer, checker, seen, depth + 1);
        }
      }
    }
    return expression;
  }
  object(expression: ts.Expression | undefined, checker: ts.TypeChecker, depth = 0): Map<string, ts.Expression | ts.MethodDeclaration> | undefined {
    const node = this.resolve(expression, checker);
    if (!node || !ts.isObjectLiteralExpression(node) || depth > 12 || node.properties.length > 128) return undefined;
    const fields = new Map<string, ts.Expression | ts.MethodDeclaration>();
    for (const property of node.properties) {
      if (ts.isSpreadAssignment(property)) {
        const spread = this.object(property.expression, checker, depth + 1); if (!spread) return undefined;
        for (const [name, value] of spread) fields.set(name, value);
      } else {
        const name = property.name && propertyName(property.name); if (!name) return undefined;
        if (ts.isPropertyAssignment(property)) fields.set(name, property.initializer);
        else if (ts.isShorthandPropertyAssignment(property)) fields.set(name, property.name);
        else if (ts.isMethodDeclaration(property)) fields.set(name, property);
        else return undefined;
      }
    }
    return fields;
  }
  array(expression: ts.Expression | undefined, checker: ts.TypeChecker, depth = 0): ts.Expression[] | undefined {
    const node = this.resolve(expression, checker);
    if (!node || !ts.isArrayLiteralExpression(node) || depth > 12 || node.elements.length > 128) return undefined;
    const values: ts.Expression[] = [];
    for (const element of node.elements) {
      if (ts.isSpreadElement(element)) { const spread = this.array(element.expression, checker, depth + 1); if (!spread) return undefined; values.push(...spread); }
      else if (!ts.isOmittedExpression(element)) values.push(element);
      else return undefined;
    }
    return values.length <= 128 ? values : undefined;
  }
  string(expression: ts.Expression | undefined, checker: ts.TypeChecker): string | undefined {
    const node = this.resolve(expression, checker); return node && ts.isStringLiteralLike(node) ? node.text : undefined;
  }
  api(expression: ts.Expression, checker: ts.TypeChecker, module: string, member: string): boolean {
    const binding = frameworkBinding(expression, checker, this.scope.services); return binding?.module === module && binding.member === member;
  }
  target(expression: ts.Expression | ts.MethodDeclaration | undefined, checker: ts.TypeChecker, depth = 0, seen = new Set<string>()): Entity | undefined {
    if (!expression || depth > 20) return undefined;
    const direct = this.scope.services.declarations.get(expression); if (direct) return direct;
    if (ts.isMethodDeclaration(expression)) return undefined;
    expression = unwrap(expression);
    if (!runtimeReference(expression, checker)) return undefined;
    const declaration = valueDeclaration(expression, checker);
    if (declaration) {
      const site = nodeSite(declaration); if (seen.has(site) || this.writes.has(site)) return undefined; seen.add(site);
      // The default facade represents this exact original component, not a
      // callable emitted by a compiler or a named module helper.
      const input = this.scope.context.embedded?.input(declaration.getSourceFile().fileName);
      if (input?.facade && ts.isVariableDeclaration(declaration) && declaration.name.getText() === '__codiluce_component') {
        const id = this.scope.context.graph.entities.get(input.file.id)?.metadata.component;
        return typeof id === 'string' ? this.scope.context.graph.entities.get(id) : undefined;
      }
      const mapped = this.scope.services.declarations.get(declaration); if (mapped) return mapped;
      if (ts.isVariableDeclaration(declaration) || ts.isPropertyAssignment(declaration)) return this.target(declaration.initializer, checker, depth + 1, seen);
      if (ts.isExportAssignment(declaration)) return this.target(declaration.expression, checker, depth + 1, seen);
      if (ts.isShorthandPropertyAssignment(declaration)) {
        const value = checker.getShorthandAssignmentValueSymbol(declaration)?.valueDeclaration;
        if (value) return this.scope.services.declarations.get(value) ?? (ts.isVariableDeclaration(value) ? this.target(value.initializer, checker, depth + 1, seen) : undefined);
      }
    }
    return undefined;
  }
  component(expression: ts.Expression | undefined, checker: ts.TypeChecker): Entity | undefined {
    const target = this.target(expression, checker); return target?.type === 'component' && target.language === 'vue' ? target : undefined;
  }
}
