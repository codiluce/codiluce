import ts from 'typescript';
import path from 'node:path';
import type { Analyzer, AnalysisContext, ScannedFile } from '../core/analyzer.js';
import { hasFramework } from '../core/config.js';
import { ANALYZER_VERSION, declarationHashes, evidence, type Entity, type EntityType } from '../core/graph.js';
import { SiteCollector } from './references.js';
import { resolveReferences, type TsApplicationState } from './ts-references.js';
import { UrlEvaluator } from './ts-url.js';
import { detectHttpSite, detectInertiaElement, evaluateSite, expandWrappers, reportWrapper, wrapperRootsForProgram, shadowedBinding, HTTP_METHODS, wrapperOf, type HttpSite, type WrapperRoot, type WrapperStats } from './ts-http.js';
import { runtimeReference } from '../analysis/languages/typescript-runtime.js';
import { fileKey, pathSetKey } from '../pipeline/cache.js';
import { IndexedSources } from '../analysis/indexed-sources.js';
import { createTypeScriptServices, typescriptComponents, type TypeScriptProject, type TypeScriptServices } from '../analysis/languages/typescript-services.js';
import type { NodeProject } from '../analysis/project-model.js';
import type { ImportOutcome, ImportBinding } from '../analysis/facts.js';
import { typescriptFrameworkPacks } from '../analysis/frameworks/index.js';
import type { TypeScriptPackScope } from '../analysis/frameworks/typescript-pack.js';
import { EMBEDDED_VERSION, sourcePath, sourceAvailable, sourceMapped, embeddedOwner, embeddedOutcome } from '../analysis/embedded/index.js';

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
    const sources = context.sources ??= new IndexedSources(context);
    const resolutionFiles = [...context.files.values()].filter(file => /(?:^|\/)(?:package\.json|(?:ts|js)config[^/]*\.json)$/.test(file.path));
    for (const file of resolutionFiles) if (file.analyzable) sources.readFile(file.absolutePath);
    const services = createTypeScriptServices(context);
    for (const component of typescriptComponents(context, services)) {
      const files = component.flatMap(project => project.inputs);
      const inputsAvailable = files.map(file => sources.readFile(file.absolutePath) !== undefined).every(Boolean) && !sources.failures.size;
      const run = () => analyzeComponent(context, component, services);
      const resolutionInputs = [...new Set([...resolutionFiles.map(file => file.path), ...services.resolver.configInputs])].sort().map(file => fileKey(context, file));
      const unit = component.length === 1 ? component[0]!.project.name : `group:${component.map(runtime => runtime.project.root).sort().join(',')}`;
      if (context.cache && inputsAvailable) await context.cache.unit(context, 'typescript-nextjs', unit, { projects: component.map(runtime => runtime.project), options: component.map(runtime => services.resolver.options.get(runtime.project.id)), files: files.map(file => fileKey(context, file.path)), resolutionInputs, paths: pathSetKey(context), config: context.config, applications: [...context.applicationIds], typescript: ts.version, embedded: EMBEDDED_VERSION, packs: typescriptFrameworkPacks.map(pack => [pack.id, pack.version]) }, run);
      else await run();
    }
    for (const [file, reason] of sources.failures) context.graph.diagnose({ analyzer: 'typescript-nextjs', severity: 'warning', code: 'indexed-source-unavailable', file, entityId: context.files.get(file)?.id, reason });
  },
};
async function analyzeComponent(context: AnalysisContext, component: TypeScriptProject[], services: TypeScriptServices): Promise<void> {
  const sites = new SiteCollector();
  const prepared = component.map(runtime => {
    const program = runtime.program(), checker = program.getTypeChecker();
    const state: TsApplicationState = { program, checker, declarations: services.declarations, sites };
    const urls = new UrlEvaluator(checker, program, context), wrappers: WrapperRoot[] = [];
    const analyzed: { file: ScannedFile; source: ts.SourceFile; symbols: Map<ts.Node, Entity>; behavior: () => void }[] = [];
    const initialized = new Set<string>();
    for (const file of runtime.files) {
      const source = program.getSourceFile(file.absolutePath);
      if (!source || source.isDeclarationFile) continue;
      const result = analyzeFile(context, file, runtime.project, source, state, urls, wrappers, services, !initialized.has(file.id)); initialized.add(file.id);
      if (result) { runtime.rememberOwners(source, result.symbols); analyzed.push({ file, source, ...result }); }
    }
    return { runtime, program, checker, state, urls, wrappers, analyzed };
  });
  const scope: TypeScriptPackScope = { context, services, inputs: component.flatMap(runtime => runtime.inputs), files: prepared.flatMap(item => item.analyzed.map(file => ({ runtime: item.runtime, file: file.file, source: file.source, state: item.state, owners: file.symbols }))) };
  const backendScope = { ...scope, files: scope.files.filter(frame => !frame.file.embedded) };
  for (const pack of typescriptFrameworkPacks) {
    const packScope = pack.includeEmbedded ? scope : backendScope;
    if (pack.applies(packScope)) pack.declare(packScope);
  }
  for (const item of prepared) for (const file of item.analyzed) file.behavior();
  // Declare every owned file before linking references across compiler programs.
  const roots = prepared.flatMap(item => item.wrappers);
  const totals = new Map<WrapperRoot, WrapperStats>(roots.map(root => [root, { found: 0, resolved: 0, failed: 0 }]));
  for (const item of prepared) {
    const owned = new Set(item.analyzed.map(file => file.source.fileName));
    const rebased = wrapperRootsForProgram(roots, item.program, item.checker);
    const results = expandWrappers({ context, checker: item.checker, program: item.program, urls: item.urls, sites, sources: item.program.getSourceFiles().filter(source => !source.isDeclarationFile && sourceAvailable(context, source.fileName)), declarations: services.declarations, ownsCall: call => owned.has(call.getSourceFile().fileName), report: false, deferUncalled: component.length > 1 }, [...rebased.keys()]);
    for (const [root, stats] of results) {
      const total = totals.get(rebased.get(root)!)!; total.found += stats.found; total.resolved += stats.resolved; total.failed += stats.failed;
      if (stats.uncalled) (total.uncalled ??= []).push(...stats.uncalled);
    }
    for (const file of item.analyzed) resolveReferences(context, item.state, file.file, file.source, file.symbols);
  }
  for (const [root, stats] of totals) {
    if (!stats.resolved) for (const failure of stats.uncalled ?? []) { context.graph.diagnose({ analyzer: 'typescript-nextjs', severity: 'warning', code: 'unresolved-http-call', ...failure }); stats.failed++; }
    reportWrapper(context, root, stats);
  }
  sites.flush(context.graph);
  for (const pack of typescriptFrameworkPacks) {
    const packScope = pack.includeEmbedded ? scope : backendScope;
    if (pack.finish && pack.applies(packScope)) pack.finish(packScope);
  }
  linkNextWrappers(context, prepared.flatMap(item => item.analyzed.map(file => file.file)));
}
/** Next.js files that wrap or stand in for the pages below their directory. */
const NEXT_WRAPPERS = /^(?:src\/)?app\/(?:.*\/)?(layout|template|loading|error|not-found|global-error)\.[cm]?[jt]sx?$/;
/**
 * A page is rendered inside every layout and template above it, and replaced
 * by the nearest loading, error and not-found files while it loads or fails:
 * each page route `routes_to` them (the default export, else the file), so
 * what a layout renders belongs to the pages it wraps.
 */
function linkNextWrappers(context: AnalysisContext, files: ScannedFile[]): void {
  const { graph } = context;
  const wrappers: { directory: string; role: string; target: string; path: string }[] = [];
  for (const file of files) {
    const app = file.application;
    if (!hasFramework(app, 'nextjs')) continue;
    const modulePath = path.posix.relative(app.path === '.' ? '' : app.path, file.path);
    const match = NEXT_WRAPPERS.exec(modulePath);
    const entity = graph.entities.get(file.id);
    if (!match || !entity) continue;
    const target = typeof entity.metadata.defaultExport === 'string' && graph.entities.has(entity.metadata.defaultExport) ? entity.metadata.defaultExport : file.id;
    wrappers.push({ directory: path.posix.dirname(file.path), role: match[1]!, target, path: file.path });
  }
  if (!wrappers.length) return;
  const paths = new Set(files.map(file => file.path));
  for (const route of [...graph.entities.values()]) {
    if (route.type !== 'route' || route.metadata.framework !== 'nextjs' || !route.path || !paths.has(route.path)) continue;
    const directory = path.posix.dirname(route.path);
    for (const wrapper of wrappers) {
      if (directory !== wrapper.directory && !directory.startsWith(`${wrapper.directory}/`)) continue;
      graph.relate(route.id, wrapper.target, 'routes_to', [evidence('framework', 'typescript-nextjs', wrapper.path, 1, `Next.js App Router: the ${wrapper.role} of ${wrapper.directory} ${['layout', 'template'].includes(wrapper.role) ? 'wraps' : 'stands in for'} the page ${route.name}`)], { role: wrapper.role });
    }
  }
}
function analyzeFile(context: AnalysisContext, file: ScannedFile, project: NodeProject, source: ts.SourceFile, state: TsApplicationState, urls: UrlEvaluator, wrappers: WrapperRoot[], services: TypeScriptServices, initialize = true): { symbols: Map<ts.Node, Entity>; behavior: () => void } | undefined {
  const { graph } = context;
  const app = file.application;
  const options = services.resolver.options.get(project.id)!;
  const parseDiagnostics = (source as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics;
  if (parseDiagnostics.length) {
    embeddedOutcome(context, file, true);
    for (const error of parseDiagnostics) graph.diagnose({ analyzer: 'typescript-nextjs', severity: 'error', code: 'typescript-parse-error', file: file.path, line: source.getLineAndCharacterOfPosition(error.start ?? 0).line + 1, entityId: file.id, reason: ts.flattenDiagnosticMessageText(error.messageText, '\n') });
    return undefined;
  }
  embeddedOutcome(context, file, false);
  const fileEntity = graph.entities.get(file.id)!;
  if (initialize) { fileEntity.metadata.exports = []; fileEntity.metadata.externalImports = []; fileEntity.metadata.httpRequests = []; fileEntity.metadata.importOutcomes = []; }
  const symbols = new Map<ts.Node, Entity>();
  const exported = new Map<string, Entity>();
  const axiosNames = new Set<string>();
  const httpSites: HttpSite[] = [];
  const result = { symbols, behavior: () => { for (const site of httpSites) httpSite(site); } };
  const modulePath = path.posix.relative(app?.path ?? project.root, file.path), scriptOwner = embeddedOwner(context, file);
  if (scriptOwner) { symbols.set(source, scriptOwner); state.declarations.set(source, scriptOwner); }
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
    const moduleLiteral = ts.isImportDeclaration(node) || ts.isExportDeclaration(node) ? node.moduleSpecifier : ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) ? node.moduleReference.expression : ts.isCallExpression(node) ? node.arguments[0] : undefined;
    const mode = moduleLiteral && ts.isStringLiteralLike(moduleLiteral) ? ts.getModeForUsageLocation(source, moduleLiteral, options) : undefined;
    const resolved = services.resolver.resolve(specifier, file.absolutePath, mode).resolvedModule;
    const relative = resolved ? sourcePath(context, resolved.resolvedFileName) : undefined;
    let target = relative ? context.files.get(relative) : undefined;
    let assetResolution = false;
    let isConfiguredAlias = false;
    const candidates: string[] = [];
    if (specifier.startsWith('.')) candidates.push(path.resolve(path.dirname(file.absolutePath), specifier));
    // Exact bundler asset imports (Sass, images, etc.) are not TS modules.
    // Resolve only existing indexed paths using explicit tsconfig path mappings.
    const pathsBase = options.baseUrl ?? (options as ts.CompilerOptions & { pathsBasePath?: string }).pathsBasePath ?? path.join(context.root, project.root);
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
    const binding = services.resolver.binding(specifier, file.absolutePath);
    const workspace = target && binding?.status === 'resolved' && services.resolver.projects.nodeOwner(target.path) === binding.project ? binding : undefined;
    const proof = [...facts(node, `${relationType} ${specifier}`), ...(workspace?.proof ?? []), ...(assetResolution ? [evidence('filesystem', 'typescript-nextjs', target!.path, undefined, 'Exact indexed asset path using relative/tsconfig mapping')] : [])];
    let outcome: ImportOutcome;
    if (target) {
      graph.relate(file.id, target.id, relationType, proof, { specifier, resolver: assetResolution ? 'indexed-asset' : workspace ? 'workspace' : 'typescript' });
      outcome = { status: 'resolved', targets: [target.id], proof };
    } else if (binding?.status === 'ambiguous') outcome = { status: 'ambiguous', candidates: binding.candidates.map(project => project.id), reason: binding.reason };
    else if (binding && ['excluded', 'unsupported'].includes(binding.status)) outcome = { status: binding.status as 'excluded' | 'unsupported', reason: 'reason' in binding ? binding.reason : 'Unavailable local dependency' };
    else if (specifier.startsWith('.') || specifier.startsWith('#') || isConfiguredAlias || binding?.status === 'resolved' || (resolved && !resolved.isExternalLibraryImport)) outcome = { status: 'unresolved', reason: `Cannot link indexed local module: ${specifier}` };
    else { outcome = { status: 'external', dependency: specifier, proof }; (fileEntity.metadata.externalImports as string[]).push(specifier); }
    if (!['resolved', 'external'].includes(outcome.status)) graph.diagnose({ analyzer: 'typescript-nextjs', severity: 'warning', code: outcome.status === 'unresolved' ? 'unresolved-local-import' : `${outcome.status}-local-import`, file: file.path, line: location(node).startLine, entityId: file.id, reason: 'reason' in outcome ? outcome.reason : 'Unavailable local dependency' });
    const bindings: ImportBinding[] = [];
    if (ts.isImportDeclaration(node) && node.importClause) {
      const clause = node.importClause;
      if (clause.name) bindings.push({ imported: 'default', local: clause.name.text, ...(clause.isTypeOnly ? { typeOnly: true } : {}) });
      if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) bindings.push({ imported: '*', local: clause.namedBindings.name.text, ...(clause.isTypeOnly ? { typeOnly: true } : {}) });
      else if (clause.namedBindings) for (const item of clause.namedBindings.elements) bindings.push({ imported: (item.propertyName ?? item.name).text, local: item.name.text, ...(clause.isTypeOnly || item.isTypeOnly ? { typeOnly: true } : {}) });
    }
    if (ts.isImportEqualsDeclaration(node)) bindings.push({ imported: '*', local: node.name.text, ...(node.isTypeOnly ? { typeOnly: true } : {}) });
    (fileEntity.metadata.importOutcomes as unknown[]).push({ specifier, kind: ts.isCallExpression(node) ? node.expression.kind === ts.SyntaxKind.ImportKeyword ? 'dynamic' : 'require' : relationType, range: location(node), bindings, outcome });
  }
  function visit(node: ts.Node): void {
    if (!ts.isSourceFile(node) && !sourceMapped(context, source.fileName, node.getStart(source), node.end)) return;
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      importModule(node, node.moduleSpecifier.text, 'imports');
      if (node.moduleSpecifier.text === 'axios' && node.importClause?.name) axiosNames.add(node.importClause.name.text);
    }
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && node.moduleReference.expression && ts.isStringLiteralLike(node.moduleReference.expression)) importModule(node, node.moduleReference.expression.text, 'imports');
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
    } else if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && ts.isExportAssignment(node.parent) && !node.parent.isExportEquals) {
      // export default (props) => …: an anonymous default export, named like `export default function () {}`.
      name = 'default'; signature = functionSignature(node, source); type = 'function'; nameNode = undefined;
      declaration = node.parent;
    }
    if (name && type) {
      if (type === 'function' && (/^[A-Z]/.test(name) || name === 'default') && hasJsx(node)) type = 'component';
      const parent = parentSymbol(node);
      const qualified = `${parent?.metadata.qualifiedName ? `${parent.metadata.qualifiedName}.` : file.embedded ? `${file.embedded.key}.` : ''}${name}`;
      const id = graph.id('symbol', file.language!, app?.name ?? project.id, modulePath, qualified, signature);
      if (graph.entities.has(id)) graph.diagnose({ analyzer: 'typescript-nextjs', severity: 'warning', code: 'duplicate-symbol', file: file.path, line: location(node).startLine, reason: `Duplicate/overloaded symbol identity ${qualified}${signature}` });
      else {
        const isDefault = modifier(declaration, ts.SyntaxKind.DefaultKeyword) || ts.isExportAssignment(declaration);
        const isExported = modifier(declaration, ts.SyntaxKind.ExportKeyword) || isDefault;
        const entity = graph.contain({ id, type, name, path: file.path, language: file.language, parentId: parent?.id ?? scriptOwner?.id ?? file.id, sourceRange: location(node), metrics: { loc: location(node).endLine - location(node).startLine + 1 }, metadata: { qualifiedName: qualified, signature, exported: isExported, default: isDefault, ...(file.embedded ? { embeddedRegion: file.embedded.key, executionContext: file.embedded.executionContext } : {}), ...(/^use[A-Z]/.test(name) ? { role: 'hook' } : {}), serverAction: /^(?:[\s{]*)(?:['"]use server['"])/.test(ts.isFunctionDeclaration(node) ? node.body?.getText(source) ?? '' : ''), ...declarationHashes(node.getText(source), nameNode ? nameNode.getEnd() - node.getStart(source) : 0) }, evidence: facts(node, 'AST symbol declaration') });
        symbols.set(node, entity);
        state.declarations.set(node, entity);
        // An importer's `default` symbol is declared by the export assignment itself.
        if (ts.isExportAssignment(declaration)) state.declarations.set(declaration, entity);
        if ((ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) && node.initializer) {
          const fn = ts.isCallExpression(node.initializer) ? memoizedCallback(node.initializer) : node.initializer;
          if (fn) { symbols.set(fn, entity); state.declarations.set(fn, entity); }
          if (fn !== node.initializer) { symbols.set(node.initializer, entity); state.declarations.set(node.initializer, entity); }
        }
        if (isExported) { exported.set(isDefault ? 'default' : name, entity); graph.relate(file.id, entity.id, 'exports', facts(node, 'Exported symbol')); if (isDefault && !file.embedded) fileEntity.metadata.defaultExport = entity.id; }
      }
    }
    if (ts.isCallExpression(node)) {
      const site = runtimeReference(node.expression, state.checker) ? detectHttpSite(node, state.checker, axiosNames) : undefined;
      if (site) httpSites.push(site);
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0]) {
        const specifier = literal(node.arguments[0]);
        if (specifier !== undefined) importModule(node, specifier, 'imports');
        else graph.diagnose({ analyzer: 'typescript-nextjs', severity: 'warning', code: 'dynamic-import', file: file.path, line: location(node).startLine, entityId: file.id, reason: 'Dynamic import specifier' });
      }
      if (project.manifest && ts.isIdentifier(node.expression) && node.expression.text === 'require' && !state.checker.getSymbolAtLocation(node.expression)?.declarations?.length && !shadowedBinding(node, 'require') && node.arguments.length === 1) {
        const specifier = literal(node.arguments[0]);
        if (specifier !== undefined) importModule(node, specifier, 'imports');
        else graph.diagnose({ analyzer: 'typescript-nextjs', severity: 'warning', code: 'dynamic-import', file: file.path, line: location(node).startLine, entityId: file.id, reason: 'Dynamic CommonJS require specifier' });
      }
    }
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const site = detectInertiaElement(node, state.checker);
      if (site) httpSites.push(site);
    }
    ts.forEachChild(node, visit);
  }
  /** Record a request site on its caller and file; resolved ones go to the API matcher, the others are findings or wait for their wrapper's call sites. */
  function httpSite(site: HttpSite): void {
    const node = site.node;
    const caller = parentSymbol(node) ?? scriptOwner ?? fileEntity;
    const outcome = evaluateSite(urls, site);
    const fact = facts(node, site.client === 'fetch' ? 'fetch() HTTP call' : site.client === 'axios' ? 'Imported axios HTTP call' : site.client === 'inertia' ? `${site.via} visit` : `HTTP call on axios instance ${site.instance} (axios.create)`)[0]!;
    const expression = site.url?.getText(source) ?? '(missing URL)';
    const plain = 'reason' in outcome ? undefined : outcome.url;
    const proven = 'reason' in outcome ? undefined : outcome.resolved;
    const effect = state.sites.effect(caller.id, { category: 'network', operation: outcome.method ?? 'HTTP', detail: plain ?? proven?.display ?? (expression.length > 80 ? `${expression.slice(0, 79)}…` : expression), line: fact.line!, via: site.via });
    const entry: Record<string, unknown> = { callerId: caller.id, method: outcome.method, url: plain ?? proven?.display ?? literal(site.url), expression, line: fact.line, resolution: 'reason' in outcome ? 'unresolved' : plain !== undefined ? 'literal' : proven!.app ? 'proven-base' : 'template', ...(site.instance ? { instance: site.instance } : {}), ...(site.client === 'inertia' ? { client: site.via } : {}) };
    (fileEntity.metadata.httpRequests as unknown[]).push(entry);
    if ('reason' in outcome) {
      // Markup links with computed URLs are navigation: recorded, not reported.
      if (site.element) { entry.reason = outcome.reason; return; }
      // The URL or method comes from the parameters of the function around the call: resolve it at its call sites.
      const wrapper = wrapperOf(node, outcome.parameters);
      if (wrapper) wrappers.push({ site, owner: caller, file, effect, fact, reason: outcome.reason, wrapper, entry });
      else graph.diagnose({ analyzer: 'typescript-nextjs', severity: 'warning', code: 'unresolved-http-call', file: file.path, line: fact.line, entityId: caller.id, reason: outcome.reason });
    } else context.http.push({ callerId: caller.id, fileId: file.id, method: outcome.method, ...(plain !== undefined ? { url: plain } : {}), expression, evidence: fact, effect, ...(proven ? { resolved: proven } : {}) });
  }
  visit(source);
  fileEntity.metadata.serverModule = source.statements.some(statement => ts.isExpressionStatement(statement) && literal(statement.expression) === 'use server');
  if (source.statements.some(statement => ts.isExpressionStatement(statement) && literal(statement.expression) === 'use client')) fileEntity.metadata.executionContext = 'browser';
  // Named export lists and export-default identifiers bind only to symbols in this file.
  for (const statement of source.statements) {
    if (ts.isExportAssignment(statement) && ts.isIdentifier(statement.expression)) {
      const symbol = [...symbols.values()].find(entity => entity.name === statement.expression.getText(source) && entity.parentId === (scriptOwner?.id ?? file.id));
      if (symbol) { exported.set('default', symbol); if (!file.embedded) fileEntity.metadata.defaultExport = symbol.id; graph.relate(file.id, symbol.id, 'exports', facts(statement, 'Default export binding')); }
    }
    if (ts.isExportDeclaration(statement) && !statement.moduleSpecifier && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const item of statement.exportClause.elements) {
        const local = (item.propertyName ?? item.name).text;
        const symbol = [...symbols.values()].find(entity => entity.name === local && entity.parentId === (scriptOwner?.id ?? file.id));
        if (symbol) { exported.set(item.name.text, symbol); graph.relate(file.id, symbol.id, 'exports', facts(item, 'Named export binding')); }
      }
    }
  }
  if (file.embedded || !hasFramework(app, 'nextjs')) return result;
  const route = nextRoute(modulePath);
  if (!route) return result;
  fileEntity.metadata.nextjs = route;
  if (route.unsupported) { graph.diagnose({ analyzer: 'typescript-nextjs', severity: 'warning', code: 'unsupported-next-route', file: file.path, entityId: file.id, reason: `Intercepted route segment ${route.unsupported}` }); return result; }
  if (route.role === 'layout') return result;
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
  return result;
}
