import ts from 'typescript';
import { runtimeReference } from '../languages/typescript-runtime.js';
import { shadowedBinding } from '../../analyzers/ts-http.js';
import type { TypeScriptServices } from '../languages/typescript-services.js';

export function unwrap(expression: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression) || ts.isNonNullExpression(expression) || ts.isAwaitExpression(expression) || ts.isSatisfiesExpression(expression)) expression = expression.expression;
  return expression;
}
export function valueDeclaration(expression: ts.Expression, checker: ts.TypeChecker): ts.Declaration | undefined {
  let symbol = checker.getSymbolAtLocation(expression);
  // TS marks literal require bindings as aliases of a module. Retain their
  // actual binding/initializer so the static reader can inspect its exports.
  const local = symbol?.declarations?.find(declaration => ts.isVariableDeclaration(declaration) || ts.isBindingElement(declaration) || ts.isParameter(declaration));
  if (local) return local;
  if (symbol?.flags && symbol.flags & ts.SymbolFlags.Alias) { try { symbol = checker.getAliasedSymbol(symbol); } catch { return undefined; } }
  const shorthand = symbol?.valueDeclaration;
  if (shorthand && ts.isShorthandPropertyAssignment(shorthand)) symbol = checker.getShorthandAssignmentValueSymbol(shorthand);
  if (symbol?.flags && symbol.flags & ts.SymbolFlags.Alias) { try { symbol = checker.getAliasedSymbol(symbol); } catch { return undefined; } }
  return symbol?.valueDeclaration ?? symbol?.declarations?.[0];
}
export interface FrameworkBinding { module: string; member: string; declaration: ts.Node }
/** Resolve the import declaration before asking TS to flatten an external
 * alias (external package ASTs are intentionally absent). Local indexed
 * packages with the same name never stand in for the framework. */
export function frameworkBinding(expression: ts.Expression, checker: ts.TypeChecker, services: TypeScriptServices, depth = 0, seen = new Set<ts.Node>()): FrameworkBinding | undefined {
  expression = unwrap(expression);
  if (depth > 12 || seen.has(expression) || !runtimeReference(expression, checker)) return undefined;
  seen.add(expression);
  const external = (module: string, member: string, declaration: ts.Node): FrameworkBinding | undefined => {
    if (module.startsWith('.') || module.startsWith('#') || module.startsWith('/')) return undefined;
    const literal = ts.isImportDeclaration(declaration) ? declaration.moduleSpecifier : undefined;
    const source = declaration.getSourceFile();
    const options = services.resolver.options.get(services.resolver.owner(source.fileName).id)!;
    const mode = literal && ts.isStringLiteralLike(literal) ? ts.getModeForUsageLocation(source, literal, options) : undefined;
    const binding = services.resolver.binding(module, source.fileName);
    return (!binding || binding.status === 'external') && !services.resolver.resolve(module, source.fileName, mode).resolvedModule ? { module, member, declaration } : undefined;
  };
  const exportedBinding = (specifier: ts.Expression, member: string, hops = 0): FrameworkBinding | undefined => {
    if (hops > 12 || seen.has(specifier)) return undefined;
    seen.add(specifier);
    const module = checker.getSymbolAtLocation(specifier), source = module?.declarations?.find(ts.isSourceFile);
    if (!source) return undefined;
    for (const statement of source.statements) {
      if (member === 'default' && ts.isExportAssignment(statement)) return frameworkBinding(statement.expression, checker, services, depth + 1, seen);
      if (!ts.isExportDeclaration(statement) || statement.isTypeOnly) continue;
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        const item = statement.exportClause.elements.find(item => item.name.text === member && !item.isTypeOnly);
        if (!item) continue;
        if (statement.moduleSpecifier && ts.isStringLiteralLike(statement.moduleSpecifier)) {
          const name = (item.propertyName ?? item.name).text;
          return external(statement.moduleSpecifier.text, name, statement) ?? exportedBinding(statement.moduleSpecifier, name, hops + 1);
        }
        const target = checker.getExportSpecifierLocalTargetSymbol(item)?.declarations?.[0];
        if (target && ts.isImportSpecifier(target)) return frameworkBinding(target.name, checker, services, depth + 1, seen);
        if (target && ts.isVariableDeclaration(target) && target.initializer) return frameworkBinding(target.initializer, checker, services, depth + 1, seen);
      } else if (!statement.exportClause && statement.moduleSpecifier && ts.isStringLiteralLike(statement.moduleSpecifier)) {
        const binding = external(statement.moduleSpecifier.text, member, statement) ?? exportedBinding(statement.moduleSpecifier, member, hops + 1);
        if (binding) return binding;
      }
    }
    return undefined;
  };
  if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
    const member = ts.isPropertyAccessExpression(expression) ? expression.name.text : expression.argumentExpression && ts.isStringLiteralLike(expression.argumentExpression) ? expression.argumentExpression.text : undefined;
    const base = frameworkBinding(expression.expression, checker, services, depth + 1, seen);
    if (base && member && ['*', 'default'].includes(base.member)) return { ...base, member };
  }
  if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression) && expression.expression.text === 'require' && !checker.getSymbolAtLocation(expression.expression)?.declarations?.length && !shadowedBinding(expression, 'require')) {
    const argument = expression.arguments[0];
    if (expression.arguments.length === 1 && argument && ts.isStringLiteralLike(argument)) return external(argument.text, 'default', expression);
  }
  const symbol = checker.getSymbolAtLocation(expression);
  for (const declaration of symbol?.declarations ?? []) {
    let imported: ts.Node | undefined = declaration;
    while (imported && !ts.isImportDeclaration(imported) && !ts.isImportEqualsDeclaration(imported)) imported = imported.parent;
    if (imported && ts.isImportDeclaration(imported) && ts.isStringLiteralLike(imported.moduleSpecifier)) {
      const member = ts.isImportSpecifier(declaration) ? (declaration.propertyName ?? declaration.name).text : ts.isNamespaceImport(declaration) ? '*' : 'default';
      const binding = external(imported.moduleSpecifier.text, member, imported);
      if (binding) return binding;
      // Bound source-module exports, including aliases of external framework
      // imports, are read through the compiler's resolved module source.
      if (depth < 12) { const local = exportedBinding(imported.moduleSpecifier, member); if (local) return local; }
    }
    if (imported && ts.isImportEqualsDeclaration(imported) && ts.isExternalModuleReference(imported.moduleReference) && imported.moduleReference.expression && ts.isStringLiteralLike(imported.moduleReference.expression)) {
      const binding = external(imported.moduleReference.expression.text, 'default', imported);
      if (binding) return binding;
    }
    if (ts.isVariableDeclaration(declaration) && declaration.initializer) return frameworkBinding(declaration.initializer, checker, services, depth + 1, seen);
    if (ts.isBindingElement(declaration) && ts.isObjectBindingPattern(declaration.parent) && ts.isVariableDeclaration(declaration.parent.parent) && declaration.parent.parent.initializer) {
      const base = frameworkBinding(declaration.parent.parent.initializer, checker, services, depth + 1, seen);
      if (base && ts.isIdentifier(declaration.name)) return { ...base, member: declaration.propertyName?.getText() ?? declaration.name.text };
    }
  }
  const declaration = valueDeclaration(expression, checker);
  if (declaration && !seen.has(declaration)) {
    seen.add(declaration);
    if (ts.isVariableDeclaration(declaration) && declaration.initializer) return frameworkBinding(declaration.initializer, checker, services, depth + 1, seen);
    // A local re-export of an external binding can retain an export specifier.
    if (ts.isExportSpecifier(declaration)) {
      const exported = declaration.parent.parent;
      if (exported.moduleSpecifier && ts.isStringLiteralLike(exported.moduleSpecifier)) return external(exported.moduleSpecifier.text, (declaration.propertyName ?? declaration.name).text, exported);
    }
  }
  return undefined;
}
