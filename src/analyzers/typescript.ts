import ts from 'typescript';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import type { Analyzer, AnalysisContext, ScannedFile } from '../core/analyzer.js';
import { ANALYZER_VERSION, declarationHashes, evidence, type Entity, type EntityType } from '../core/graph.js';
import { SiteCollector } from './references.js';
import { createApplicationProgram } from './ts-program.js';
import { resolveReferences, type TsApplicationState } from './ts-references.js';
import { UrlEvaluator } from './ts-url.js';
import { detectHttpSite, evaluateSite, expandWrappers, HTTP_METHODS, wrapperOf, type WrapperRoot } from './ts-http.js';
import { fileKey, pathSetKey } from '../pipeline/cache.js';

function literal(node: ts.Node | undefined): string | undefined { return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined; }
function modifier(node: ts.Node, kind: ts.SyntaxKind): boolean { return ts.canHaveModifiers(node) && !!ts.getModifiers(node)?.some(item => item.kind === kind); }
function hasJsx(node: ts.Node): boolean {
  let found = false;
  function visit(child: ts.Node): void {
    if (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child) || ts.isJsxFragment(child)) { found = true; return; }
    if (!found) ts.forEachChild(child, visit);
  }
  visit(node); return found;
}
function functionSignature(node: ts.SignatureDeclarationBase, source: ts.SourceFile): string {
  return `(${node.parameters.map(param => `${param.dotDotDotToken ? '...' : ''}${param.type?.getText(source).replace(/\s+/g, '') ?? 'unknown'}${param.questionToken || param.initializer ? '?' : ''}`).join(',')})`;
}
export function nextRoute(relative: string): { path: string; role: 'page' | 'layout' | 'route'; unsupported?: string } | undefined {
  const match = /^(?:src\/)?app\/(.*\/)?(page|layout|route)\.[cm]?[jt]sx?$/.exec(relative);
  if (!match) return undefined;
  const segments = (match[1] ?? '').split('/').filter(Boolean);
  const unsupported = segments.find(segment => /^\(\.{1,3}\)/.test(segment));
  const visible = segments.filter(segment => !segment.startsWith('@') && !/^\([^)]*\)$/.test(segment));
  const route = visible.map(segment => {
    const optional = /^\[\[\.\.\.(.+)\]\]$/.exec(segment);
    const catchAll = /^\[\.\.\.(.+)\]$/.exec(segment);
    const parameter = /^\[(.+)\]$/.exec(segment);
    return optional ? `:${optional[1]}*` : catchAll ? `:${catchAll[1]}+` : parameter ? `:${parameter[1]}` : segment;
  });
  return { path: `/${route.join('/')}`, role: match[2] as 'page' | 'layout' | 'route', ...(unsupported ? { unsupported } : {}) };
}
/** The function passed to useCallback (React), when the call is one. */
function memoizedCallback(call: ts.CallExpression): ts.ArrowFunction | ts.FunctionExpression | undefined {
  const callee = call.expression;
  const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
  const fn = call.arguments[0];
  return name === 'useCallback' && fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) ? fn : undefined;
}
export const typescriptAnalyzer: Analyzer = {
  name: 'typescript-nextjs', version: ANALYZER_VERSION,
  async analyze(context): Promise<void> {
    const optionsByApp = new Map<string, ts.CompilerOptions>();
    for (const app of context.config.applications) {
      const configFile = path.join(context.root, app.path, 'tsconfig.json');
      const read = ts.readConfigFile(configFile, ts.sys.readFile);
      let options: ts.CompilerOptions = { allowJs: true, jsx: ts.JsxEmit.ReactJSX, moduleResolution: ts.ModuleResolutionKind.Bundler, module: ts.ModuleKind.ESNext };
      if (!read.error) {
        const parsed = ts.parseJsonConfigFileContent(read.config, { ...ts.sys, readDirectory: () => [] }, path.dirname(configFile));
        options = { ...options, ...parsed.options };
        for (const error of parsed.errors.filter(error => error.code !== 18003 && error.code !== 18002)) context.graph.diagnose({ analyzer: 'typescript-nextjs', severity: 'error', code: 'tsconfig-error', file: path.relative(context.root, configFile), reason: ts.flattenDiagnosticMessageText(error.messageText, '\n') });
      } else if (ts.sys.fileExists(configFile)) context.graph.diagnose({ analyzer: 'typescript-nextjs', severity: 'error', code: 'tsconfig-error', file: path.relative(context.root, configFile), reason: ts.flattenDiagnosticMessageText(read.error.messageText, '\n') });
      optionsByApp.set(app.name, options);
    }
    // One program per application: every file declares its symbols first, then
    // calls, renders and references resolve across the whole application. An
    // application whose inputs did not change since the last index is replayed from the cache.
    for (const app of context.config.applications) {
      const files = [...context.files.values()].filter(file => file.analyzable && ['typescript', 'javascript'].includes(file.language ?? '') && file.application?.name === app.name);
      if (!files.length) continue;
      const run = () => analyzeApplication(context, files, optionsByApp.get(app.name)!, app.path);
      if (context.cache) await context.cache.unit(context, 'typescript-nextjs', app.name, { app, options: optionsByApp.get(app.name), files: files.map(file => fileKey(context, file.path)), paths: pathSetKey(context), config: context.config, applications: [...context.applicationIds], typescript: ts.version }, run);
      else await run();
    }
  },
};
async function analyzeApplication(context: AnalysisContext, files: ScannedFile[], options: ts.CompilerOptions, appPath: string): Promise<void> {
  const texts = new Map<string, string>();
  for (const file of files) texts.set(file.absolutePath, await readFile(file.absolutePath, 'utf8'));
  const program = createApplicationProgram(texts, options, path.join(context.root, appPath));
  const checker = program.getTypeChecker();
  const state: TsApplicationState = { program, checker, declarations: new Map(), sites: new SiteCollector() };
  const urls = new UrlEvaluator(checker, program, context);
  const analyzed: { file: ScannedFile; source: ts.SourceFile; symbols: Map<ts.Node, Entity> }[] = [];
  const wrappers: WrapperRoot[] = [];
  for (const file of files) {
    if (file.path.endsWith('.d.ts')) continue;
    const source = program.getSourceFile(file.absolutePath);
    if (!source) continue;
    const symbols = analyzeFile(context, file, options, source, state, urls, wrappers);
    if (symbols) analyzed.push({ file, source, symbols });
  }
  // HTTP wrappers resolve at their call sites, once every file has declared its symbols.
  expandWrappers({ context, checker, program, urls, sites: state.sites, sources: analyzed.map(item => item.source), declarations: state.declarations }, wrappers);
  for (const item of analyzed) resolveReferences(context, state, item.file, item.source, item.symbols);
  state.sites.flush(context.graph);
}
function analyzeFile(context: AnalysisContext, file: ScannedFile, options: ts.CompilerOptions, source: ts.SourceFile, state: TsApplicationState, urls: UrlEvaluator, wrappers: WrapperRoot[]): Map<ts.Node, Entity> | undefined {
  const { graph } = context;
  const app = file.application!;
  const parseDiagnostics = (source as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics;
  if (parseDiagnostics.length) {
    for (const error of parseDiagnostics) graph.diagnose({ analyzer: 'typescript-nextjs', severity: 'error', code: 'typescript-parse-error', file: file.path, line: source.getLineAndCharacterOfPosition(error.start ?? 0).line + 1, entityId: file.id, reason: ts.flattenDiagnosticMessageText(error.messageText, '\n') });
    return undefined;
  }
  const fileEntity = graph.entities.get(file.id)!;
  fileEntity.metadata.exports = [];
  fileEntity.metadata.externalImports = [];
  fileEntity.metadata.httpRequests = [];
  const symbols = new Map<ts.Node, Entity>();
  const exported = new Map<string, Entity>();
  const axiosNames = new Set<string>();
  const modulePath = path.relative(path.join(context.root, app.path), file.absolutePath).split(path.sep).join('/');
  function location(node: ts.Node) {
    const start = source.getLineAndCharacterOfPosition(node.getStart(source));
    const end = source.getLineAndCharacterOfPosition(node.getEnd());
    return { startLine: start.line + 1, startColumn: start.character + 1, endLine: end.line + 1, endColumn: end.character + 1 };
  }
  const facts = (node: ts.Node, explanation: string) => [{ ...evidence('typescript', 'typescript-nextjs', file.path, location(node).startLine, explanation), endLine: location(node).endLine }];
  function parentSymbol(node: ts.Node): Entity | undefined {
    let parent = node.parent;
    while (parent) { if (symbols.has(parent)) return symbols.get(parent); parent = parent.parent; }
    return undefined;
  }
  function importModule(node: ts.Node, specifier: string, relationType: 'imports' | 'exports'): void {
    const resolved = ts.resolveModuleName(specifier, file.absolutePath, options, ts.sys).resolvedModule;
    const relative = resolved ? path.relative(context.root, resolved.resolvedFileName).split(path.sep).join('/') : undefined;
    let target = relative ? context.files.get(relative) : undefined;
    let assetResolution = false;
    let isConfiguredAlias = false;
    const candidates: string[] = [];
    if (specifier.startsWith('.')) candidates.push(path.resolve(path.dirname(file.absolutePath), specifier));
    // Exact bundler asset imports (Sass, images, etc.) are not TS modules.
    // Resolve only existing indexed paths using explicit tsconfig path mappings.
    const pathsBase = options.baseUrl ?? (options as ts.CompilerOptions & { pathsBasePath?: string }).pathsBasePath ?? path.join(context.root, app.path);
    for (const [alias, substitutions] of Object.entries(options.paths ?? {})) {
      const star = alias.indexOf('*');
      const matches = star < 0 ? specifier === alias : specifier.startsWith(alias.slice(0, star)) && specifier.endsWith(alias.slice(star + 1));
      if (!matches) continue;
      isConfiguredAlias = true;
      const capture = star < 0 ? '' : specifier.slice(star, specifier.length - (alias.length - star - 1));
      for (const replacement of substitutions) candidates.push(path.resolve(pathsBase, replacement.replace('*', capture)));
    }
    if (!target && !/\.[cm]?[jt]sx?$/.test(specifier) && path.extname(specifier)) {
      for (const candidate of candidates) {
        const indexed = context.files.get(path.relative(context.root, candidate).split(path.sep).join('/'));
        if (indexed) { target = indexed; assetResolution = true; break; }
      }
    }
    if (target) graph.relate(file.id, target.id, relationType, [...facts(node, `${relationType} ${specifier}`), ...(assetResolution ? [evidence('filesystem', 'typescript-nextjs', target.path, undefined, 'Exact indexed asset path using relative/tsconfig mapping')] : [])], { specifier, resolver: assetResolution ? 'indexed-asset' : 'typescript' });
    else if (specifier.startsWith('.') || isConfiguredAlias || (resolved && !resolved.isExternalLibraryImport)) graph.diagnose({ analyzer: 'typescript-nextjs', severity: 'warning', code: 'unresolved-local-import', file: file.path, line: location(node).startLine, entityId: file.id, reason: `Cannot link indexed local module: ${specifier}` });
    else (fileEntity.metadata.externalImports as string[]).push(specifier);
  }
  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      importModule(node, node.moduleSpecifier.text, 'imports');
      if (node.moduleSpecifier.text === 'axios' && node.importClause?.name) axiosNames.add(node.importClause.name.text);
    }
    if (ts.isExportDeclaration(node)) {
      (fileEntity.metadata.exports as unknown[]).push({ expression: node.exportClause?.getText(source) ?? '*', source: literal(node.moduleSpecifier) });
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) importModule(node, node.moduleSpecifier.text, 'exports');
    }
    let name: string | undefined;
    let type: EntityType | undefined;
    let signature = '';
    let declaration: ts.Node = node;
    let nameNode: ts.Node | undefined;
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) { name = node.name?.text ?? (modifier(node, ts.SyntaxKind.DefaultKeyword) ? 'default' : undefined); type = 'class'; nameNode = node.name; }
    else if (ts.isFunctionDeclaration(node)) { name = node.name?.text ?? 'default'; signature = functionSignature(node, source); type = 'function'; nameNode = node.name; }
    else if (ts.isMethodDeclaration(node)) { name = node.name.getText(source); signature = functionSignature(node, source); type = 'method'; nameNode = node.name; }
    else if (ts.isVariableDeclaration(node) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) && ts.isIdentifier(node.name)) {
      name = node.name.text; signature = functionSignature(node.initializer, source); type = 'function'; nameNode = node.name;
      declaration = node.parent.parent;
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isCallExpression(node.initializer) && memoizedCallback(node.initializer)) {
      // const save = useCallback(async () => …, deps): the callback is the function.
      name = node.name.text; signature = functionSignature(memoizedCallback(node.initializer)!, source); type = 'function'; nameNode = node.name;
      declaration = node.parent.parent;
    } else if (ts.isPropertyDeclaration(node) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) && (ts.isIdentifier(node.name) || ts.isPrivateIdentifier(node.name))) {
      // Class fields holding functions (handleClick = () => …) are methods.
      name = node.name.text; signature = functionSignature(node.initializer, source); type = 'method'; nameNode = node.name;
    }
    if (name && type) {
      if (type === 'function' && /^[A-Z]/.test(name) && hasJsx(node)) type = 'component';
      const parent = parentSymbol(node);
      const qualified = `${parent?.metadata.qualifiedName ? `${parent.metadata.qualifiedName}.` : ''}${name}`;
      const id = graph.id('symbol', file.language!, app.name, modulePath, qualified, signature);
      if (graph.entities.has(id)) graph.diagnose({ analyzer: 'typescript-nextjs', severity: 'warning', code: 'duplicate-symbol', file: file.path, line: location(node).startLine, reason: `Duplicate/overloaded symbol identity ${qualified}${signature}` });
      else {
        const isExported = modifier(declaration, ts.SyntaxKind.ExportKeyword) || modifier(declaration, ts.SyntaxKind.DefaultKeyword);
        const isDefault = modifier(declaration, ts.SyntaxKind.DefaultKeyword);
        const entity = graph.contain({ id, type, name, path: file.path, language: file.language, parentId: parent?.id ?? file.id, sourceRange: location(node), metrics: { loc: location(node).endLine - location(node).startLine + 1 }, metadata: { qualifiedName: qualified, signature, exported: isExported, default: isDefault, ...(/^use[A-Z]/.test(name) ? { role: 'hook' } : {}), serverAction: /^(?:[\s{]*)(?:['"]use server['"])/.test(ts.isFunctionDeclaration(node) ? node.body?.getText(source) ?? '' : ''), ...declarationHashes(node.getText(source), nameNode ? nameNode.getEnd() - node.getStart(source) : 0) }, evidence: facts(node, 'AST symbol declaration') });
        symbols.set(node, entity);
        state.declarations.set(node, entity);
        if ((ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) && node.initializer) {
          const fn = ts.isCallExpression(node.initializer) ? memoizedCallback(node.initializer) : node.initializer;
          if (fn) { symbols.set(fn, entity); state.declarations.set(fn, entity); }
          if (fn !== node.initializer) { symbols.set(node.initializer, entity); state.declarations.set(node.initializer, entity); }
        }
        if (isExported) { exported.set(isDefault ? 'default' : name, entity); graph.relate(file.id, entity.id, 'exports', facts(node, 'Exported symbol')); }
      }
    }
    if (ts.isCallExpression(node)) {
      const site = detectHttpSite(node, state.checker, axiosNames);
      if (site) {
        const caller = parentSymbol(node) ?? fileEntity;
        const outcome = evaluateSite(urls, site);
        const fact = facts(node, site.client === 'fetch' ? 'fetch() HTTP call' : site.client === 'axios' ? 'Imported axios HTTP call' : `HTTP call on axios instance ${site.instance} (axios.create)`)[0]!;
        const expression = site.url?.getText(source) ?? '(missing URL)';
        const plain = 'reason' in outcome ? undefined : outcome.url;
        const proven = 'reason' in outcome ? undefined : outcome.resolved;
        const effect = state.sites.effect(caller.id, { category: 'network', operation: outcome.method ?? 'HTTP', detail: plain ?? proven?.display ?? (expression.length > 80 ? `${expression.slice(0, 79)}…` : expression), line: fact.line!, via: site.via });
        const entry: Record<string, unknown> = { callerId: caller.id, method: outcome.method, url: plain ?? proven?.display ?? literal(site.url), expression, line: fact.line, resolution: 'reason' in outcome ? 'unresolved' : plain !== undefined ? 'literal' : proven!.app ? 'proven-base' : 'template', ...(site.instance ? { instance: site.instance } : {}) };
        (fileEntity.metadata.httpRequests as unknown[]).push(entry);
        if ('reason' in outcome) {
          // The URL or method comes from the parameters of the function around the call: resolve it at its call sites.
          const wrapper = wrapperOf(node, outcome.parameters);
          if (wrapper) wrappers.push({ site, owner: caller, file, effect, fact, reason: outcome.reason, wrapper, entry });
          else graph.diagnose({ analyzer: 'typescript-nextjs', severity: 'warning', code: 'unresolved-http-call', file: file.path, line: fact.line, entityId: caller.id, reason: outcome.reason });
        } else context.http.push({ callerId: caller.id, fileId: file.id, method: outcome.method, ...(plain !== undefined ? { url: plain } : {}), expression, evidence: fact, effect, ...(proven ? { resolved: proven } : {}) });
      }
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0]) {
        const specifier = literal(node.arguments[0]);
        if (specifier !== undefined) importModule(node, specifier, 'imports');
        else graph.diagnose({ analyzer: 'typescript-nextjs', severity: 'warning', code: 'dynamic-import', file: file.path, line: location(node).startLine, entityId: file.id, reason: 'Dynamic import specifier' });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  fileEntity.metadata.serverModule = source.statements.some(statement => ts.isExpressionStatement(statement) && literal(statement.expression) === 'use server');
  // Named export lists and export-default identifiers bind only to symbols in this file.
  for (const statement of source.statements) {
    if (ts.isExportAssignment(statement) && ts.isIdentifier(statement.expression)) {
      const symbol = [...symbols.values()].find(entity => entity.name === statement.expression.getText(source) && entity.parentId === file.id);
      if (symbol) { exported.set('default', symbol); graph.relate(file.id, symbol.id, 'exports', facts(statement, 'Default export binding')); }
    }
    if (ts.isExportDeclaration(statement) && !statement.moduleSpecifier && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const item of statement.exportClause.elements) {
        const local = (item.propertyName ?? item.name).text;
        const symbol = [...symbols.values()].find(entity => entity.name === local && entity.parentId === file.id);
        if (symbol) { exported.set(item.name.text, symbol); graph.relate(file.id, symbol.id, 'exports', facts(item, 'Named export binding')); }
      }
    }
  }
  if (app.type !== 'nextjs') return symbols;
  const route = nextRoute(modulePath);
  if (!route) return symbols;
  fileEntity.metadata.nextjs = route;
  if (route.unsupported) { graph.diagnose({ analyzer: 'typescript-nextjs', severity: 'warning', code: 'unsupported-next-route', file: file.path, entityId: file.id, reason: `Intercepted route segment ${route.unsupported}` }); return symbols; }
  if (route.role === 'layout') return symbols;
  const routeFacts = [evidence('framework', 'typescript-nextjs', file.path, 1, `Next.js App Router ${route.role} convention`)];
  if (route.role === 'page') {
    const entity = graph.contain({ id: graph.id('route', app.name, route.path, modulePath), type: 'route', name: route.path, path: file.path, parentId: context.applicationIds.get(app.name)!, metadata: { routePath: route.path, framework: 'nextjs', registration: 'convention' }, evidence: routeFacts });
    graph.relate(entity.id, exported.get('default')?.id ?? file.id, 'routes_to', routeFacts);
  } else {
    for (const [method, handler] of exported) {
      if (!HTTP_METHODS.has(method)) continue;
      const entity = graph.contain({ id: graph.id('endpoint', app.name, method, route.path, modulePath), type: 'api_endpoint', name: `${method} ${route.path}`, path: file.path, parentId: context.applicationIds.get(app.name)!, metadata: { method, routePath: route.path, framework: 'nextjs', registration: 'convention' }, evidence: routeFacts });
      graph.relate(entity.id, handler.id, 'handles', [...routeFacts, ...handler.evidence]);
    }
  }
  return symbols;
}
