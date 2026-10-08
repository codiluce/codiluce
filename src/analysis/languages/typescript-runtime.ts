import ts from 'typescript';

/** The type checker deliberately resolves type-only aliases. Runtime edges
 * need an additional import/export check, including intermediate barrels. */
export function runtimeReference(expression: ts.Node, checker: ts.TypeChecker): boolean {
  const seen = new Set<string>();
  const importOf = (node: ts.Node): ts.ImportDeclaration | undefined => {
    for (let current: ts.Node | undefined = node; current; current = current.parent) if (ts.isImportDeclaration(current)) return current;
    return undefined;
  };
  const moduleSource = (specifier: ts.Expression | undefined): ts.SourceFile | undefined => {
    if (!specifier) return undefined;
    const symbol = checker.getSymbolAtLocation(specifier);
    return symbol?.declarations?.find(ts.isSourceFile);
  };
  const symbolValue = (symbol: ts.Symbol | undefined): boolean => {
    if (!symbol) return true;
    for (const declaration of symbol.declarations ?? []) {
      if (ts.isImportEqualsDeclaration(declaration) && declaration.isTypeOnly) return false;
      if (ts.isNamespaceExport(declaration) && declaration.parent.isTypeOnly) return false;
      if (ts.isImportSpecifier(declaration) || ts.isImportClause(declaration) || ts.isNamespaceImport(declaration)) {
        const imported = importOf(declaration);
        if (imported?.importClause?.isTypeOnly || ts.isImportSpecifier(declaration) && declaration.isTypeOnly) return false;
        if (ts.isNamespaceImport(declaration)) return true;
        const source = moduleSource(imported?.moduleSpecifier);
        if (source) return exportedValue(source, ts.isImportSpecifier(declaration) ? (declaration.propertyName ?? declaration.name).text : 'default');
      }
      if (ts.isExportSpecifier(declaration)) {
        const exported = declaration.parent.parent;
        if (declaration.isTypeOnly || exported.isTypeOnly) return false;
        const source = moduleSource(exported.moduleSpecifier);
        if (source) return exportedValue(source, (declaration.propertyName ?? declaration.name).text);
        return symbolValue(checker.getExportSpecifierLocalTargetSymbol(declaration));
      }
      if (ts.isVariableDeclaration(declaration) && declaration.initializer && (ts.isIdentifier(declaration.initializer) || ts.isPropertyAccessExpression(declaration.initializer) || ts.isCallExpression(declaration.initializer) || ts.isNewExpression(declaration.initializer))) {
        const key = `variable:${declaration.getSourceFile().fileName}:${declaration.pos}`;
        if (seen.has(key)) return true;
        seen.add(key);
        return referenceValue(ts.isCallExpression(declaration.initializer) || ts.isNewExpression(declaration.initializer) ? declaration.initializer.expression : declaration.initializer);
      }
    }
    return !(symbol.declarations?.length && symbol.declarations.every(declaration => ts.isInterfaceDeclaration(declaration) || ts.isTypeAliasDeclaration(declaration)));
  };
  const exportedValue = (source: ts.SourceFile, name: string): boolean => {
    const key = `export:${source.fileName}:${name}`;
    if (seen.has(key)) return true;
    seen.add(key);
    for (const statement of source.statements) {
      if (name === 'default' && ts.isExportAssignment(statement)) return referenceValue(statement.expression);
      if (!ts.isExportDeclaration(statement) || !statement.exportClause || !ts.isNamedExports(statement.exportClause)) continue;
      const item = statement.exportClause.elements.find(item => item.name.text === name);
      if (!item) continue;
      if (statement.isTypeOnly || item.isTypeOnly) return false;
      const target = moduleSource(statement.moduleSpecifier);
      return target ? exportedValue(target, (item.propertyName ?? item.name).text) : symbolValue(checker.getExportSpecifierLocalTargetSymbol(item));
    }
    const module = checker.getSymbolAtLocation(source);
    const symbol = module && checker.getExportsOfModule(module).find(symbol => symbol.name === name);
    // Star re-exports have no local alias declaration: inspect their source
    // before allowing the checker to flatten them to the original declaration.
    let typeOnlyStar = false;
    for (const statement of source.statements) if (ts.isExportDeclaration(statement) && !statement.exportClause) {
      const target = moduleSource(statement.moduleSpecifier), targetModule = target && checker.getSymbolAtLocation(target);
      if (!target || !targetModule || !checker.getExportsOfModule(targetModule).some(symbol => symbol.name === name)) continue;
      if (statement.isTypeOnly) typeOnlyStar = true;
      else if (exportedValue(target, name)) return true;
      else typeOnlyStar = true;
    }
    if (typeOnlyStar && !symbol?.declarations?.some(declaration => declaration.getSourceFile() === source && !ts.isExportDeclaration(declaration))) return false;
    return symbolValue(symbol);
  };
  const namespaceSeen = new Set<ts.Symbol>();
  const namespaceSource = (symbol: ts.Symbol | undefined): ts.SourceFile | undefined => {
    if (!symbol || namespaceSeen.has(symbol)) return undefined;
    namespaceSeen.add(symbol);
    for (const declaration of symbol.declarations ?? []) {
      if (ts.isNamespaceImport(declaration)) return moduleSource(importOf(declaration)?.moduleSpecifier);
      if (ts.isImportEqualsDeclaration(declaration) && ts.isExternalModuleReference(declaration.moduleReference)) return moduleSource(declaration.moduleReference.expression);
      if (ts.isNamespaceExport(declaration)) return moduleSource(declaration.parent.moduleSpecifier);
      if (ts.isSourceFile(declaration)) return declaration;
      if (ts.isImportSpecifier(declaration)) {
        const source = moduleSource(importOf(declaration)?.moduleSpecifier), module = source && checker.getSymbolAtLocation(source);
        return namespaceSource(module && checker.getExportsOfModule(module).find(symbol => symbol.name === (declaration.propertyName ?? declaration.name).text));
      }
      if (ts.isExportSpecifier(declaration)) {
        const source = moduleSource(declaration.parent.parent.moduleSpecifier), module = source && checker.getSymbolAtLocation(source);
        return source ? namespaceSource(module && checker.getExportsOfModule(module).find(symbol => symbol.name === (declaration.propertyName ?? declaration.name).text)) : namespaceSource(checker.getExportSpecifierLocalTargetSymbol(declaration));
      }
      if (ts.isVariableDeclaration(declaration) && declaration.initializer && ts.isIdentifier(declaration.initializer)) return namespaceSource(checker.getSymbolAtLocation(declaration.initializer));
    }
    return undefined;
  };
  const referenceValue = (node: ts.Node): boolean => {
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node)) return referenceValue(node.expression);
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      if (!referenceValue(node.expression)) return false;
      const member = ts.isPropertyAccessExpression(node) ? node.name.text : node.argumentExpression && ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression.text : undefined;
      if (member && ts.isIdentifier(node.expression)) {
        const source = namespaceSource(checker.getSymbolAtLocation(node.expression));
        if (source && !exportedValue(source, member)) return false;
      }
      return true;
    }
    return ts.isIdentifier(node) ? symbolValue(checker.getSymbolAtLocation(node)) : true;
  };
  try { return referenceValue(expression); } catch { return false; }
}
