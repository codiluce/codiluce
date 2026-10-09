import ts from 'typescript';
import path from 'node:path';
import type { Entity } from '../../core/graph.js';
import type { TypeScriptPackScope, TypeScriptPackFile } from './typescript-pack.js';
import { sourceMapped } from '../embedded/index.js';
import { runtimeReference } from '../languages/typescript-runtime.js';
import { shadowedBinding } from '../../analyzers/ts-http.js';
import { frameworkBinding, unwrap } from './typescript-binding.js';
import type { NuxtConfig } from './nuxt-config.js';
import { fileAnalysis } from '../facts.js';

const words = (name: string): string[] => name.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').replace(/([a-z\d])([A-Z])/g, '$1 $2').split(/[\s/_.-]+/).filter(Boolean);
export const nuxtKebab = (name: string): string => words(name).join('-').toLowerCase();
export function nuxtName(relative: string, pathPrefix = true, prefix = ''): string {
  const basename = path.posix.basename(relative, '.vue'), file = words(basename.toLowerCase() === 'index' ? pathPrefix ? '' : path.posix.basename(path.posix.dirname(relative)) : basename);
  const parts = [...words(prefix), ...pathPrefix ? words(path.posix.dirname(relative).replace(/^\.$/, '').split('/').filter(part => !/^\(.+\)$/.test(part)).join('/')) : []];
  for (let i = parts.length - 1; i >= 0; i--) { const suffix = parts.slice(i).join('/').toLowerCase(), content = file.join('/').toLowerCase(); if (content === suffix || content.startsWith(`${suffix}/`) || parts[i]?.toLowerCase() === content && parts[i + 1] === parts[i]) parts.length = i; }
  return [...parts, ...file].map(part => part[0]!.toUpperCase() + part.slice(1)).join('');
}
const catalogs = new WeakMap<TypeScriptPackScope, Map<string, Map<string, Entity[]>>>();
export function nuxtComponents(scope: TypeScriptPackScope, config: NuxtConfig): Map<string, Entity[]> {
  let projects = catalogs.get(scope); if (!projects) { projects = new Map(); catalogs.set(scope, projects); }
  let catalog = projects.get(config.project.id); if (catalog) return catalog;
  catalog = new Map(); projects.set(config.project.id, catalog);
  if (!config.valid || !config.autoComponents) return catalog;
  const dirs = [...config.components].sort((a, b) => b.path.length - a.path.length), seen = new Set<string>(), modes = new Set<string>();
  for (const dir of dirs) for (const file of [...scope.context.files.values()].sort((a, b) => a.path.localeCompare(b.path))) {
    if (seen.has(file.path) || file.language !== 'vue' || !file.path.startsWith(`${dir.path}/`) || scope.context.projects!.nodeOwner(file.path).id !== config.project.id) continue; seen.add(file.path);
    let relative = file.path.slice(dir.path.length + 1); if (relative.split('/').some(part => part.startsWith('-'))) continue;
    if (/\.(?:client|server|island)(?:\.global)?\.vue$/.test(relative) || relative.startsWith('islands/')) { const name = nuxtName(relative.replace(/^islands\//, '').replace(/\.(?:client|server|island)(?:\.global)?\.vue$/, '.vue'), dir.pathPrefix, dir.prefix); modes.add(name); modes.add(nuxtKebab(name)); scope.context.graph.diagnose({ analyzer: 'nuxt', severity: 'warning', code: 'nuxt-component-mode-gap', file: file.path, reason: 'Client/server component pairs and islands require execution-mode and precedence summaries' }); continue; }
    // Nuxt scans its conventional global/islands directories separately.
    if (dir.path === path.posix.join(config.src, 'components') && relative.startsWith('global/')) relative = relative.slice('global/'.length);
    relative = relative.replace(/\.global\.vue$/, '.vue');
    const name = nuxtName(relative, dir.pathPrefix, dir.prefix), facts = scope.context.embedded?.facts.get(file.path), id = scope.context.graph.entities.get(file.id)?.metadata.component;
    if (!name || typeof id !== 'string' || !facts || facts.issues.some(issue => issue.fatal || issue.code === 'unsupported-template') || facts.regions.some(region => !region.supported) || fileAnalysis(scope.context.graph.entities.get(file.id)?.metadata.analysis)?.features.structure.status === 'failed') continue;
    const component = scope.context.graph.entities.get(id)!; for (const key of [name, nuxtKebab(name)]) catalog.set(key, [...catalog.get(key) ?? [], component]);
  }
  for (const name of modes) catalog.delete(name);
  for (const [name, values] of catalog) if (/^[A-Z]/.test(name) && values.length > 1) scope.context.graph.diagnose({ analyzer: 'nuxt', severity: 'warning', code: 'nuxt-component-collision', file: values[0]?.path, reason: `Component ${name} has ${values.length} indexed convention candidates; no precedence is guessed` });
  return catalog;
}
export function nuxtComponent(scope: TypeScriptPackScope, file: string, name: string): Entity | undefined {
  const config = scope.services.nuxt.get(scope.context.projects!.nodeOwner(file).id); if (!config) return undefined;
  const catalog = nuxtComponents(scope, config); let candidates = catalog.get(name);
  if (!candidates && /^Lazy[A-Z]/.test(name)) candidates = catalog.get(name.slice(4));
  if (!candidates && name.startsWith('lazy-')) candidates = catalog.get(name.slice(5));
  return candidates?.length === 1 ? candidates[0] : undefined;
}
/** These globals exist only in the qualified project and lose qualification
 * when lexical bindings, type-only imports or indexed global writes shadow them. */
const globalWrites = new WeakMap<TypeScriptPackScope, Map<string, Set<string>>>();
const changes = new WeakMap<TypeScriptPackScope, Map<TypeScriptPackFile, { direct: Set<string>; receiver: Set<string>; escaped: Set<string>; aliases: Map<string, string> }>>();
function changed(scope: TypeScriptPackScope, frame: TypeScriptPackFile, expression: ts.Expression, namespace = false): boolean {
  while (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) expression = expression.expression;
  if (!ts.isIdentifier(expression)) return true;
  const declaration = frame.state.checker.getSymbolAtLocation(expression)?.valueDeclaration;
  if (declaration && ts.isVariableDeclaration(declaration) && !(declaration.parent.flags & ts.NodeFlags.Const)) return true;
  let frames = changes.get(scope); if (!frames) { frames = new Map(); changes.set(scope, frames); } let info = frames.get(frame);
  if (!info) {
    info = { direct: new Set(), receiver: new Set(), escaped: new Set(), aliases: new Map() }; frames.set(frame, info);
    const root = (node: ts.Expression): string | undefined => { node = unwrap(node); while (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) node = node.expression; return ts.isIdentifier(node) ? node.text : undefined; };
    const visit = (node: ts.Node): void => {
      if (!ts.isSourceFile(node) && !sourceMapped(scope.context, frame.source.fileName, node.getStart(frame.source), node.end)) return;
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) { const value = root(node.initializer); if (value) info!.aliases.set(node.name.text, value); }
      let target: ts.Expression | undefined;
      if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) target = node.left;
      if (ts.isPostfixUnaryExpression(node) || ts.isPrefixUnaryExpression(node) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator)) target = node.operand;
      if (target) { const name = root(target); if (name) (ts.isIdentifier(target) ? info!.direct : info!.receiver).add(name); }
      if (ts.isCallExpression(node)) for (const argument of node.arguments) { const name = root(argument); if (name) info!.escaped.add(name); }
      ts.forEachChild(node, visit);
    }; visit(frame.source);
  }
  const canonical = (name: string): string => { const seen = new Set<string>(); while (info!.aliases.has(name) && !seen.has(name) && seen.size < 20) { seen.add(name); name = info!.aliases.get(name)!; } return name; }, original = expression.text, sameReceiver = (name: string): boolean => canonical(name) === canonical(original);
  return info.direct.has(original) || [...info.receiver].some(sameReceiver) || namespace && [...info.escaped].some(sameReceiver);
}
const autoCollisions = new WeakMap<TypeScriptPackScope, Map<string, Set<string>>>();
function collisions(scope: TypeScriptPackScope, config: NuxtConfig, server: boolean): Set<string> {
  let projects = autoCollisions.get(scope); if (!projects) { projects = new Map(); autoCollisions.set(scope, projects); } const key = `${config.project.id}:${server}`;
  let names = projects.get(key); if (names) return names; names = new Set(); projects.set(key, names);
  const prefixes = server ? [`${config.server}/utils/`] : [`${config.src}/composables/`, `${config.src}/utils/`]; let count = 0;
  const bindingNames = (name: ts.BindingName): void => { if (ts.isIdentifier(name)) names!.add(name.text); else for (const element of name.elements) if (ts.isBindingElement(element)) bindingNames(element.name); };
  for (const file of scope.context.files.values()) if (prefixes.some(prefix => file.path.startsWith(prefix)) && /\.[cm]?[jt]sx?$/.test(file.path)) {
    if (++count > 512) { names.add('*'); break; }
    const text = scope.context.sources?.readFile(file.absolutePath) ?? '', source = ts.createSourceFile(file.path, text, ts.ScriptTarget.Latest, true);
    if ((source as ts.SourceFile & { parseDiagnostics: ts.Diagnostic[] }).parseDiagnostics.length) { names.add('*'); continue; }
    for (const statement of source.statements) {
      if (ts.isExportDeclaration(statement) && !statement.isTypeOnly) { if (!statement.exportClause || ts.isNamespaceExport(statement.exportClause)) names.add('*'); else for (const item of statement.exportClause.elements) if (!item.isTypeOnly) names.add(item.name.text); }
      if (ts.isExportAssignment(statement) || ts.canHaveModifiers(statement) && ts.getModifiers(statement)?.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword)) { const pascal = nuxtName(path.posix.basename(file.path).replace(/\.[cm]?[jt]sx?$/, '.vue')); if (pascal) names.add(pascal[0]!.toLowerCase() + pascal.slice(1)); }
      if (ts.canHaveModifiers(statement) && ts.getModifiers(statement)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) { if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) bindingNames(declaration.name); else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) names.add(statement.name.text); }
    }
  }
  return names;
}
export function nuxtGlobal(scope: TypeScriptPackScope, frame: TypeScriptPackFile, expression: ts.Expression, name: string, auto = true): boolean {
  expression = unwrap(expression); const config = scope.services.nuxt.get(frame.runtime.project.id);
  if (!config?.valid || auto && (!config.autoImports || frame.file.path.startsWith(`${config.server}/`) && !config.serverAutoImports) || !ts.isIdentifier(expression) || expression.text !== name || frame.state.checker.getSymbolAtLocation(expression)?.declarations?.length || shadowedBinding(expression, name)) return false;
  if (auto && (frame.file.path.startsWith(`${config.server}/`) ? !['defineEventHandler', 'eventHandler'].includes(name) : !['useFetch', 'useLazyFetch'].includes(name))) return false;
  if (auto) {
    const names = collisions(scope, config, frame.file.path.startsWith(`${config.server}/`));
    // Unimport can choose project exports over preset APIs. Keep this collision
    // boundary explicit instead of inventing generated auto-import declarations.
    if (names.has(name) || names.has('*')) { scope.context.graph.diagnose({ analyzer: 'nuxt', severity: 'warning', code: 'nuxt-auto-import-gap', file: frame.file.path, reason: `Indexed auto-import exports can override preset ${name}; generated binding precedence is unresolved` }); return false; }
  }
  let projects = globalWrites.get(scope); if (!projects) { projects = new Map(); globalWrites.set(scope, projects); }
  let writes = projects.get(frame.runtime.project.id);
  if (!writes) {
    writes = new Set(); projects.set(frame.runtime.project.id, writes);
    for (const owner of scope.files.filter(item => item.runtime.project.id === frame.runtime.project.id)) {
      const visit = (node: ts.Node): void => {
        if (!ts.isSourceFile(node) && !sourceMapped(scope.context, owner.source.fileName, node.getStart(owner.source), node.end)) return;
        let target: ts.Node | undefined;
        if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) target = node.left;
        if (ts.isPostfixUnaryExpression(node) || ts.isPrefixUnaryExpression(node) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator)) target = node.operand;
        if (target && ts.isIdentifier(target) && !owner.state.checker.getSymbolAtLocation(target)?.declarations?.length) writes!.add(target.text);
        if (target && (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) && ts.isIdentifier(target.expression) && ['globalThis', 'window', 'global'].includes(target.expression.text)) { const property = ts.isPropertyAccessExpression(target) ? target.name.text : ts.isStringLiteralLike(target.argumentExpression) ? target.argumentExpression.text : undefined; if (property) writes!.add(property); else writes!.add('*'); }
        ts.forEachChild(node, visit);
      }; visit(owner.source);
    }
  }
  return !writes.has(name) && !writes.has('*');
}
export function nuxtApi(scope: TypeScriptPackScope, frame: TypeScriptPackFile, expression: ts.Expression, name: string, modules: string[]): boolean {
  if (changed(scope, frame, expression, ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression))) return false;
  const checker = frame.state.checker, binding = frameworkBinding(expression, checker, scope.services);
  if (binding && modules.includes(binding.module) && binding.member === name && !['$fetch', 'definePageMeta'].includes(name)) {
    const origin = scope.files.find(item => item.source.fileName === binding.declaration.getSourceFile().fileName);
    if (origin && ts.isImportDeclaration(binding.declaration)) {
      const bindings = binding.declaration.importClause?.namedBindings;
      const local = bindings && ts.isNamespaceImport(bindings) ? bindings.name : bindings && ts.isNamedImports(bindings) ? bindings.elements.find(item => (item.propertyName ?? item.name).text === name)?.name : undefined;
      if (local && changed(scope, origin, local, !!bindings && ts.isNamespaceImport(bindings))) return false;
    }
    return true;
  }
  if (ts.isIdentifier(expression) && runtimeReference(expression, checker)) {
    const declaration = checker.getSymbolAtLocation(expression)?.declarations?.find(ts.isImportSpecifier), imported = declaration?.parent.parent.parent;
    const config = scope.services.nuxt.get(frame.runtime.project.id), server = !!config && frame.file.path.startsWith(`${config.server}/`), provided = server ? ['defineEventHandler', 'eventHandler'] : ['useFetch', 'useLazyFetch', 'definePageMeta'];
    const overrides = config && collisions(scope, config, server);
    if (declaration && imported && ts.isImportDeclaration(imported) && ts.isStringLiteralLike(imported.moduleSpecifier) && (imported.moduleSpecifier.text === '#imports' || modules.includes(imported.moduleSpecifier.text) && imported.moduleSpecifier.text.startsWith('#')) && (declaration.propertyName ?? declaration.name).text === name && config?.valid && config.aliasesQualified && provided.includes(name) && !overrides?.has(name) && !overrides?.has('*') && !scope.services.resolver.resolve(imported.moduleSpecifier.text, frame.source.fileName).resolvedModule && !scope.services.resolver.assetCandidates(imported.moduleSpecifier.text, frame.source.fileName).length) return true;
  }
  return nuxtGlobal(scope, frame, expression, name, !['$fetch', 'definePageMeta'].includes(name));
}
export function nuxtImportedComponent(scope: TypeScriptPackScope, frame: TypeScriptPackFile, node: ts.Expression): Entity | undefined {
  if (!runtimeReference(node, frame.state.checker) || changed(scope, frame, node)) return undefined;
  const declaration = frame.state.checker.getSymbolAtLocation(node)?.declarations?.find(ts.isImportSpecifier), imported = declaration?.parent.parent.parent;
  return declaration && imported && ts.isImportDeclaration(imported) && ts.isStringLiteralLike(imported.moduleSpecifier) && imported.moduleSpecifier.text === '#components' && !scope.services.resolver.resolve('#components', frame.source.fileName).resolvedModule && !scope.services.resolver.assetCandidates('#components', frame.source.fileName).length ? nuxtComponent(scope, frame.file.path, (declaration.propertyName ?? declaration.name).text) : undefined;
}
