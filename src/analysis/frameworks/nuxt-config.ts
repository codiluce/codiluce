import ts from 'typescript';
import path from 'node:path';
import { subset } from 'semver';
import type { AnalysisContext } from '../../core/analyzer.js';
import type { IndexedSources } from '../indexed-sources.js';
import type { NodeProject } from '../project-model.js';
import { profile, propertyName } from './typescript-static.js';
import { unwrap } from './typescript-binding.js';

export interface NuxtComponentDir { path: string; pathPrefix: boolean; prefix: string }
export interface NuxtConfig {
  project: NodeProject; profile: 'nuxt-3' | 'nuxt-4'; src: string; server: string; pages: string | false; layouts: string;
  base: string; ssr: boolean; aliases: Record<string, string[]>; components: NuxtComponentDir[];
  inputs: string[]; conditions: string[]; valid: boolean; autoComponents: boolean; autoImports: boolean;
  serverAutoImports: boolean;
  aliasesQualified: boolean;
  serverProfile: 'nitro-2-h3-1' | undefined;
}
/** Syntax only: no target configuration, imported factory, layer or module is run. */
class NuxtConfigReader {
  readonly constants = new Map<string, ts.Expression>();
  readonly names = new Set<string>();
  readonly writes = new Set<string>();
  constructor(readonly source: ts.SourceFile, private readonly external: (module: string) => boolean) {
    const name = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node) || ts.isImportSpecifier(node) || ts.isNamespaceImport(node) || ts.isImportClause(node) || ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) if (node.name && ts.isIdentifier(node.name)) this.names.add(node.name.text);
      ts.forEachChild(node, name);
    }; name(source);
    for (const statement of source.statements) if (ts.isVariableStatement(statement) && statement.declarationList.flags & ts.NodeFlags.Const) for (const declaration of statement.declarationList.declarations) if (ts.isIdentifier(declaration.name) && declaration.initializer) this.constants.set(declaration.name.text, declaration.initializer);
    const mark = (node: ts.Expression, seen = new Set<string>()): void => { node = unwrap(node); while (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) node = node.expression; if (!ts.isIdentifier(node) || seen.has(node.text)) return; seen.add(node.text); this.writes.add(node.text); const value = this.constants.get(node.text); if (value) mark(value, seen); };
    const visit = (node: ts.Node): void => {
      if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) mark(node.left);
      if (ts.isPostfixUnaryExpression(node) || ts.isPrefixUnaryExpression(node) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator)) mark(node.operand);
      if (ts.isCallExpression(node) && !this.define(node.expression)) { if (ts.isPropertyAccessExpression(node.expression)) mark(node.expression.expression); for (const argument of node.arguments) mark(argument); }
      ts.forEachChild(node, visit);
    }; visit(source);
  }
  define(node: ts.Expression): boolean {
    node = unwrap(node);
    if (ts.isIdentifier(node) && node.text === 'defineNuxtConfig' && !this.names.has(node.text) && !this.writes.has(node.text)) return true;
    const name = ts.isIdentifier(node) ? node.text : ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) ? node.expression.text : undefined;
    if (!name || this.writes.has(name)) return false;
    for (const statement of this.source.statements) if (ts.isImportDeclaration(statement) && ts.isStringLiteralLike(statement.moduleSpecifier) && ['nuxt/config', 'nuxt'].includes(statement.moduleSpecifier.text) && this.external(statement.moduleSpecifier.text)) {
      const clause = statement.importClause; if (!clause || clause.isTypeOnly) continue;
      if (clause.namedBindings && ts.isNamedImports(clause.namedBindings) && ts.isIdentifier(node) && clause.namedBindings.elements.some(item => !item.isTypeOnly && item.name.text === name && (item.propertyName ?? item.name).text === 'defineNuxtConfig')) return true;
      if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings) && clause.namedBindings.name.text === name && ts.isPropertyAccessExpression(node) && node.name.text === 'defineNuxtConfig') return true;
    }
    return false;
  }
  read(node: ts.Expression | undefined, seen = new Set<string>()): ts.Expression | undefined { if (!node || seen.size > 20) return undefined; node = unwrap(node); if (ts.isIdentifier(node)) { if (seen.has(node.text) || this.writes.has(node.text)) return undefined; seen.add(node.text); return this.read(this.constants.get(node.text), seen); } return node; }
  string(node: ts.Expression | undefined): string | undefined { node = this.read(node); return node && ts.isStringLiteralLike(node) ? node.text : undefined; }
  object(node: ts.Expression | undefined, depth = 0): Map<string, ts.Expression> | undefined {
    node = this.read(node); if (!node || !ts.isObjectLiteralExpression(node) || depth > 12 || node.properties.length > 128) return undefined;
    const fields = new Map<string, ts.Expression>();
    for (const property of node.properties) if (ts.isSpreadAssignment(property)) { const spread = this.object(property.expression, depth + 1); if (!spread) return undefined; for (const [key, value] of spread) fields.set(key, value); } else if (ts.isPropertyAssignment(property) && propertyName(property.name)) fields.set(propertyName(property.name)!, property.initializer); else if (ts.isShorthandPropertyAssignment(property)) fields.set(property.name.text, property.name); else return undefined;
    return fields;
  }
  array(node: ts.Expression | undefined, depth = 0): ts.Expression[] | undefined { node = this.read(node); if (!node || !ts.isArrayLiteralExpression(node) || depth > 12 || node.elements.length > 128) return undefined; const result: ts.Expression[] = []; for (const item of node.elements) if (ts.isSpreadElement(item)) { const spread = this.array(item.expression, depth + 1); if (!spread) return undefined; result.push(...spread); } else if (!ts.isOmittedExpression(item)) result.push(item); else return undefined; return result.length <= 128 ? result : undefined; }
}

export function nuxtConfiguration(context: AnalysisContext, project: NodeProject, sources: IndexedSources): NuxtConfig | undefined {
  const version = project.dependencies.nuxt; if (!version) return undefined;
  const external = (module: string): boolean => context.projects?.packageBinding(project, module.startsWith('@') ? module.split('/').slice(0, 2).join('/') : module.split('/')[0]!).status === 'external';
  const diagnose = (reason: string, file = project.manifest, code = 'nuxt-config-gap'): void => context.graph.diagnose({ analyzer: 'nuxt', severity: 'warning', code, file, reason });
  const major = ([3, 4] as const).find(major => profile(version, major));
  if (!major || !external('nuxt') || !subset(version, major === 3 ? '>=3.21.11 <4.0.0' : '>=4.6.0 <5.0.0')) { diagnose(`Nuxt ${version} does not select a reviewed external Nuxt 3.21.11+/4.6+ profile; older/broader version ranges need separate convention/runtime qualification`, project.manifest, 'nuxt-version-profile'); return undefined; }
  const files = [...context.files.values()].filter(file => context.projects!.nodeOwner(file.path).id === project.id);
  const appFiles = files.some(file => file.path.startsWith(`${path.posix.join(project.root, 'app')}/`) && !/^(?:spa-loading-template\.html|router\.options)/.test(file.path.slice(path.posix.join(project.root, 'app').length + 1)));
  const result: NuxtConfig = { project, profile: `nuxt-${major}`, src: major === 4 && appFiles ? path.posix.join(project.root, 'app') : project.root, server: '', pages: '', layouts: '', base: '', ssr: true, aliases: {}, components: [], inputs: [], conditions: [], valid: true, autoComponents: true, autoImports: true, serverAutoImports: true, aliasesQualified: true, serverProfile: 'nitro-2-h3-1' };
  const gap = (reason: string, file?: string, fatal = false): void => { result.conditions.push(reason); if (fatal) result.valid = false; diagnose(reason, file); };
  const resolve = (from: string, value: string | undefined): string | undefined => { if (!value || value.includes('\\') || path.isAbsolute(value)) return undefined; const relative = path.relative(context.root, path.resolve(context.root, from, value)).split(path.sep).join('/') || '.'; return relative === '..' || relative.startsWith('../') ? undefined : relative; };
  const configs = files.filter(file => path.posix.dirname(file.path) === project.root && /^nuxt\.config\.[cm]?[jt]s$/.test(path.posix.basename(file.path)));
  if (configs.length > 1) gap('Multiple Nuxt configuration inputs prevent an unambiguous profile', configs[0]?.path, true);
  let fields = new Map<string, ts.Expression>(), reader: NuxtConfigReader | undefined, configFile: string | undefined, compatibility = major;
  for (const file of configs) {
    result.inputs.push(file.path); configFile = file.path; const text = sources.readFile(file.absolutePath);
    if (text === undefined) { gap('Unavailable Nuxt configuration', file.path, true); continue; }
    const source = ts.createSourceFile(file.absolutePath, text, ts.ScriptTarget.Latest, true); reader = new NuxtConfigReader(source, external);
    if ((source as ts.SourceFile & { parseDiagnostics: ts.Diagnostic[] }).parseDiagnostics.length) { gap('Malformed Nuxt configuration', file.path, true); continue; }
    const exported = source.statements.find(ts.isExportAssignment); let root = exported && !exported.isExportEquals ? reader.read(exported.expression) : undefined;
    if (root && ts.isCallExpression(root) && reader.define(root.expression) && root.arguments.length === 1) root = root.arguments[0];
    const object = reader.object(root); if (!object) { gap('Dynamic/unproven Nuxt configuration prevents default convention guesses', file.path, true); continue; } fields = object;
    for (const key of ['rootDir', 'extends', 'theme', '$env', '$development', '$production', '$test']) if (fields.has(key)) gap(`Nuxt ${key} can override conventions and requires a separate static configuration profile`, file.path, true);
    if (fields.has('future')) { const future = reader.object(fields.get('future')), value = reader.read(future?.get('compatibilityVersion')); if (value && ts.isNumericLiteral(value) && ['3', '4'].includes(value.text)) compatibility = Number(value.text) as 3 | 4; else gap('Unknown Nuxt compatibilityVersion', file.path, true); }
    if (fields.has('srcDir')) { const src = resolve(project.root, reader.string(fields.get('srcDir'))); if (!src) gap('Dynamic/outside-index Nuxt source directory', file.path, true); else result.src = src; }
    else result.src = compatibility === 4 && appFiles ? path.posix.join(project.root, 'app') : project.root;
  }
  result.server = path.posix.join(compatibility === 4 ? project.root : result.src, 'server'); result.pages = path.posix.join(result.src, 'pages'); result.layouts = path.posix.join(result.src, 'layouts');
  result.components = [{ path: path.posix.join(result.src, 'components'), prefix: '', pathPrefix: true }];
  if (reader) {
    const dirs = fields.has('dir') ? reader.object(fields.get('dir')) : new Map<string, ts.Expression>();
    if (!dirs) gap('Dynamic Nuxt directory configuration', configFile, true);
    else for (const key of ['pages', 'layouts'] as const) if (dirs.has(key)) { const dir = resolve(result.src, reader.string(dirs.get(key))); if (dir) result[key] = dir; else gap(`Dynamic/outside-index ${key} directory`, configFile, true); }
    if (fields.has('serverDir')) { const dir = resolve(project.root, reader.string(fields.get('serverDir'))); if (dir) result.server = dir; else gap('Dynamic/outside-index server directory', configFile, true); }
    if (fields.has('pages')) { const value = reader.read(fields.get('pages')); if (value?.kind === ts.SyntaxKind.FalseKeyword) result.pages = false; else if (value?.kind !== ts.SyntaxKind.TrueKeyword) gap('Dynamic/version-specific pages options', configFile, true); }
    if (fields.has('ssr')) { const value = reader.read(fields.get('ssr')); if (value && [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(value.kind)) result.ssr = value.kind === ts.SyntaxKind.TrueKeyword; else gap('Dynamic SSR option', configFile); }
    if (fields.has('app')) { const app = reader.object(fields.get('app')); if (!app) gap('Dynamic Nuxt app options', configFile, true); else if (app.has('baseURL')) { const base = reader.string(app.get('baseURL')); if (base?.startsWith('/') && !/[?#\\]/.test(base) && !base.includes('//') && !base.split('/').some(part => part === '.' || part === '..')) result.base = base.replace(/\/$/, ''); else gap('Dynamic/invalid Nuxt app baseURL', configFile, true); } }
    if (fields.has('imports')) { const imports = reader.object(fields.get('imports')), auto = reader.read(imports?.get('autoImport')); if (!imports || [...imports.keys()].some(key => key !== 'autoImport') || auto && ![ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(auto.kind)) { result.autoImports = false; gap('Custom/dynamic auto-import configuration', configFile); } else if (auto?.kind === ts.SyntaxKind.FalseKeyword) result.autoImports = false; }
    if (fields.has('components')) {
      const value = reader.read(fields.get('components')); result.components = [];
      if (value?.kind === ts.SyntaxKind.FalseKeyword) result.autoComponents = false;
      else if (value?.kind === ts.SyntaxKind.TrueKeyword) result.components = [{ path: path.posix.join(result.src, 'components'), prefix: '', pathPrefix: true }];
      else {
        const options = reader.object(value), values = reader.array(options?.get('dirs') ?? value) ?? (options?.has('path') ? [value!] : undefined);
        if (!values || options && !options.has('path') && [...options.keys()].some(key => key !== 'dirs')) { result.autoComponents = false; gap('Unqualified component directory configuration', configFile); }
        else for (const item of values) {
          const object = reader.object(item), literal = reader.string(item) ?? reader.string(object?.get('path'));
          const from = literal && /^(?:~~|@@)\//.test(literal) ? project.root : result.src, mapped = literal?.replace(/^(?:~~|@@|~|@)\//, './'), dir = resolve(from, mapped), prefix = object?.has('prefix') ? reader.string(object.get('prefix')) : '', pathPrefix = reader.read(object?.get('pathPrefix'));
          if (!dir || prefix === undefined || object && [...object.keys()].some(key => !['path', 'prefix', 'pathPrefix', 'global'].includes(key)) || pathPrefix && ![ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(pathPrefix.kind)) { result.autoComponents = false; gap('Dynamic/custom component scan policy', configFile); }
          else result.components.push({ path: dir, prefix, pathPrefix: pathPrefix?.kind !== ts.SyntaxKind.FalseKeyword });
        }
      }
    }
    if (fields.has('alias')) { const aliases = reader.object(fields.get('alias')); if (!aliases) gap('Dynamic aliases prevent compiler binding qualification', configFile, true); else for (const [key, value] of aliases) { const target = resolve(project.root, reader.string(value)); if (!target || key.includes('*')) gap('Dynamic/outside-index alias', configFile, true); else { result.aliases[key] = [path.resolve(context.root, target)]; result.aliases[`${key}/*`] = [path.resolve(context.root, target, '*')]; } } }
    if (fields.has('experimental')) { const experimental = reader.object(fields.get('experimental')), auto = reader.read(experimental?.get('nitroAutoImports')); if (auto?.kind === ts.SyntaxKind.FalseKeyword) result.serverAutoImports = false; if (!experimental || auto && ![ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(auto.kind)) result.serverAutoImports = false; }
    for (const key of ['modules', 'hooks', 'plugins', 'routeRules', 'router', 'vite', 'webpack', 'experimental', 'ignore', 'ignorePrefix', 'extensions', 'serverHandlers', 'devServerHandlers', 'nitro']) if (fields.has(key)) {
      if (['modules', 'plugins', 'serverHandlers', 'devServerHandlers'].includes(key) && reader.array(fields.get(key))?.length === 0) continue;
      if (['hooks', 'routeRules'].includes(key) && reader.object(fields.get(key))?.size === 0) continue;
      gap(`Nuxt ${key} configuration has no dispatch/registration summary`, configFile); if (['modules', 'hooks', 'plugins', 'experimental'].includes(key)) result.autoComponents = false;
      if (['modules', 'hooks', 'vite', 'webpack'].includes(key)) { result.aliasesQualified = false; result.autoImports = false; }
    }
    if (fields.has('server')) { const server = reader.object(fields.get('server')), builder = reader.string(server?.get('builder')); if (!server || builder && !['nitro', '@nuxt/nitro-server'].includes(builder) || [...server.keys()].some(key => key !== 'builder') || server.has('builder') && !builder) { result.serverProfile = undefined; gap('Custom/Vite server.builder is outside the Nitro 2/H3 1 profile', configFile); } }
  }
  const automatic = [...context.files.values()].filter(file => file.path.startsWith(`${path.posix.join(project.root, 'layers')}/`) && /\/nuxt\.config\.[cm]?[jt]s$/.test(file.path) || file.path.startsWith(`${path.posix.join(project.root, 'modules')}/`) || file.path.startsWith(`${path.posix.join(result.src, 'plugins')}/`) || file.path.startsWith(`${result.server}/plugins/`) || file.path.startsWith(`${result.server}/modules/`) || path.posix.dirname(file.path) === path.posix.join(result.src, result.src === project.root ? 'app' : '.') && /^router\.options\.[cm]?[jt]s$/.test(path.posix.basename(file.path)));
  for (const file of automatic) { result.inputs.push(file.path); gap('Indexed layer/module/plugin/router options can alter Nuxt dispatch or registration', file.path); result.autoComponents = false; if (file.path.startsWith(`${path.posix.join(project.root, 'layers')}/`) || file.path.startsWith(`${path.posix.join(project.root, 'modules')}/`) || file.path.startsWith(`${result.server}/modules/`)) { result.aliasesQualified = false; result.autoImports = false; } }
  for (const name of ['h3', 'nitropack']) if (project.dependencies[name] && (!profile(project.dependencies[name], name === 'h3' ? 1 : 2) || !external(name))) { result.serverProfile = undefined; gap(`Declared ${name} version/binding conflicts with the external Nitro 2/H3 1 server profile`); }
  for (const directory of [result.src, result.server, result.layouts, ...result.pages ? [result.pages] : [], ...result.components.map(dir => dir.path)]) if (context.projects!.nodeOwner(directory).id !== project.id) gap('Source/page/layout/server/component directories in another Node project require a registration/application profile', configFile, true);
  for (const [key, dir] of Object.entries({ '~': result.src, '@': result.src, '~~': project.root, '@@': project.root, '#server': result.server, '#shared': path.posix.join(project.root, 'shared') })) { result.aliases[key] ??= [path.resolve(context.root, dir)]; result.aliases[`${key}/*`] ??= [path.resolve(context.root, dir, '*')]; }
  return result;
}

export function nuxtVirtualImport(config: NuxtConfig | undefined, specifier: string): boolean { return !!config?.valid && ['#imports', '#components', '#app', '#app/nuxt'].includes(specifier); }
