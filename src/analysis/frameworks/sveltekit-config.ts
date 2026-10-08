import ts from 'typescript';
import path from 'node:path';
import type { AnalysisContext } from '../../core/analyzer.js';
import type { NodeProject } from '../project-model.js';
import type { IndexedSources } from '../indexed-sources.js';
import { profile, propertyName } from './typescript-static.js';
import { unwrap } from './typescript-binding.js';

export interface KitConfig {
  profile: 'sveltekit-2' | 'sveltekit-3'; project: NodeProject;
  routes?: string; params?: string; lib?: string; base?: string;
  aliases: Record<string, string[]>; inputs: string[]; conditions: string[];
  hooks: string[]; valid: boolean;
}
/** A deliberately local literal reader. No imports, factories, plugins or
 * configuration modules are evaluated. Unknown spreads invalidate the object. */
class ConfigReader {
  private readonly constants = new Map<string, ts.Expression>();
  private readonly writes = new Set<string>();
  constructor(readonly source: ts.SourceFile) {
    for (const statement of source.statements) if (ts.isVariableStatement(statement) && statement.declarationList.flags & ts.NodeFlags.Const) for (const declaration of statement.declarationList.declarations) if (ts.isIdentifier(declaration.name) && declaration.initializer) this.constants.set(declaration.name.text, declaration.initializer);
    const root = (node: ts.Expression): string | undefined => { node = unwrap(node); while (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) node = node.expression; return ts.isIdentifier(node) ? node.text : undefined; };
    const mark = (node: ts.Expression, seen = new Set<string>()): void => { const name = root(node); if (!name || seen.has(name)) return; seen.add(name); this.writes.add(name); const value = this.constants.get(name); if (value) mark(value, seen); };
    const visit = (node: ts.Node): void => {
      if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) mark(node.left);
      if (ts.isPostfixUnaryExpression(node) || ts.isPrefixUnaryExpression(node) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator)) mark(node.operand);
      if (ts.isCallExpression(node) && !this.api(node.expression, 'vite', 'defineConfig') && !this.api(node.expression, '@sveltejs/kit/vite', 'sveltekit')) { if (ts.isPropertyAccessExpression(node.expression)) mark(node.expression.expression); for (const argument of node.arguments) mark(argument); }
      ts.forEachChild(node, visit);
    }; visit(source);
  }
  api(node: ts.Expression, module: string, member: string): boolean {
    if (!ts.isIdentifier(node)) return false;
    const bindings = this.source.statements.filter(ts.isImportDeclaration).flatMap(statement => ts.isStringLiteralLike(statement.moduleSpecifier) && statement.moduleSpecifier.text === module && !statement.importClause?.isTypeOnly && statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings) ? statement.importClause.namedBindings.elements.filter(item => !item.isTypeOnly && item.name.text === node.text && (item.propertyName ?? item.name).text === member) : []);
    return bindings.length === 1 && !this.writes.has(node.text) && !this.constants.has(node.text);
  }
  read(node: ts.Expression | undefined, seen = new Set<string>()): ts.Expression | undefined {
    if (!node || seen.size > 20) return undefined; node = unwrap(node);
    if (ts.isIdentifier(node)) { if (this.writes.has(node.text) || seen.has(node.text)) return undefined; seen.add(node.text); return this.read(this.constants.get(node.text), seen); }
    return node;
  }
  object(node: ts.Expression | undefined, depth = 0): Map<string, ts.Expression> | undefined {
    node = this.read(node); if (!node || !ts.isObjectLiteralExpression(node) || depth > 12 || node.properties.length > 128) return undefined;
    const fields = new Map<string, ts.Expression>();
    for (const property of node.properties) {
      if (ts.isSpreadAssignment(property)) { const spread = this.object(property.expression, depth + 1); if (!spread) return undefined; for (const [key, value] of spread) fields.set(key, value); }
      else if (ts.isPropertyAssignment(property) && propertyName(property.name)) fields.set(propertyName(property.name)!, property.initializer);
      else if (ts.isShorthandPropertyAssignment(property)) fields.set(property.name.text, property.name);
      else return undefined;
    }
    return fields;
  }
  array(node: ts.Expression | undefined, depth = 0): ts.Expression[] | undefined {
    node = this.read(node); if (!node || !ts.isArrayLiteralExpression(node) || depth > 12 || node.elements.length > 128) return undefined;
    const values: ts.Expression[] = [];
    for (const item of node.elements) if (ts.isSpreadElement(item)) { const spread = this.array(item.expression, depth + 1); if (!spread) return undefined; values.push(...spread); } else if (!ts.isOmittedExpression(item)) values.push(item); else return undefined;
    return values.length <= 128 ? values : undefined;
  }
  string(node: ts.Expression | undefined): string | undefined { node = this.read(node); return node && ts.isStringLiteralLike(node) ? node.text : undefined; }
}

export function kitConfiguration(context: AnalysisContext, project: NodeProject, sources: IndexedSources): KitConfig | undefined {
  const version = project.dependencies['@sveltejs/kit']; if (!version) return undefined;
  const major = profile(version, 2) ? 2 : profile(version, 3) ? 3 : undefined;
  const diagnose = (code: string, reason: string, file = project.manifest ?? `${project.root}/package.json`) => context.graph.diagnose({ analyzer: 'sveltekit', severity: 'warning', code, file, reason });
  if (!major) { diagnose('sveltekit-version-profile', `SvelteKit ${version} is outside the qualified 2/3 profiles`); return undefined; }
  if (context.projects?.packageBinding(project, '@sveltejs/kit').status !== 'external') { diagnose('sveltekit-version-profile', 'An indexed local package named @sveltejs/kit cannot qualify framework conventions by spelling'); return undefined; }
  const result: KitConfig = { profile: `sveltekit-${major}`, project, routes: path.posix.join(project.root, 'src/routes'), params: path.posix.join(project.root, 'src/params'), lib: major === 2 ? path.posix.join(project.root, 'src/lib') : undefined, base: '', aliases: {}, inputs: [], conditions: [], hooks: [], valid: true };
  const gap = (reason: string, file?: string, fatal = false) => { result.conditions.push(reason); if (fatal) result.valid = false; diagnose('sveltekit-config-gap', reason, file); };
  const configs = [...context.files.values()].filter(file => path.posix.dirname(file.path) === project.root && /^(?:svelte|vite)\.config\.[cm]?[jt]s$/.test(path.posix.basename(file.path)));
  let options: Map<string, ts.Expression> | undefined, reader: ConfigReader | undefined, configPath: string | undefined;
  for (const file of configs) {
    result.inputs.push(file.path);
    if (major === 3 && path.posix.basename(file.path).startsWith('svelte.')) { gap('SvelteKit 3 no longer loads svelte.config; remove/migrate this configuration before route qualification', file.path, true); continue; }
    const text = sources.readFile(file.absolutePath); if (text === undefined) { gap('Indexed Kit configuration is unavailable', file.path, true); continue; }
    const source = ts.createSourceFile(file.absolutePath, text, ts.ScriptTarget.Latest, true), current = new ConfigReader(source);
    if ((source as ts.SourceFile & { parseDiagnostics: ts.Diagnostic[] }).parseDiagnostics.length) { gap('Malformed Kit configuration prevents static qualification', file.path, true); continue; }
    const exported = source.statements.find(ts.isExportAssignment); if (!exported || exported.isExportEquals) { gap('Kit configuration has no static default export', file.path, true); continue; }
    let root = current.read(exported.expression), fields: Map<string, ts.Expression> | undefined;
    if (path.posix.basename(file.path).startsWith('svelte.')) fields = current.object(current.object(root)?.get('kit')) ?? (current.object(root)?.has('kit') ? undefined : new Map());
    else {
      if (root && ts.isCallExpression(root) && current.api(root.expression, 'vite', 'defineConfig') && root.arguments.length === 1) root = root.arguments[0];
      const plugins = current.array(current.object(root)?.get('plugins'));
      const calls = plugins?.map(item => current.read(item)).filter((item): item is ts.CallExpression => !!item && ts.isCallExpression(item) && current.api(item.expression, '@sveltejs/kit/vite', 'sveltekit'));
      if (calls?.length === 1 && calls[0]!.arguments.length <= 1) fields = calls[0]!.arguments.length ? current.object(calls[0]!.arguments[0]) : new Map();
      else if (major === 2 && plugins && calls?.length === 0) continue;
    }
    if (!fields) { gap('Dynamic or unregistered Kit configuration/options are unresolved', file.path, true); continue; }
    if (!fields.size && options) continue;
    if (options?.size && fields.size) { gap('Conflicting Kit options in multiple configuration inputs', file.path, true); continue; }
    options = fields; reader = current; configPath = file.path;
  }
  if (major === 3 && !options) gap('SvelteKit 3 requires a statically registered sveltekit Vite plugin', configPath, true);
  if (options && reader) {
    const nested = (key: string) => options!.has(key) ? reader!.object(options!.get(key)) : new Map<string, ts.Expression>();
    const files = nested('files'), paths = nested('paths');
    if (!files) gap('Dynamic Kit files configuration prevents route qualification', configPath, true);
    else {
      const indexedPath = (value: string | undefined): string | undefined => { if (value === undefined || path.posix.isAbsolute(value) || value.includes('\\')) return undefined; const resolved = path.posix.normalize(path.posix.join(project.root, value)); return resolved === '..' || resolved.startsWith('../') ? undefined : resolved; };
      let src = 'src'; if (files.has('src')) { src = reader.string(files.get('src')) ?? ''; if (!src || !indexedPath(src)) gap('Dynamic/invalid Kit source directory', configPath, true); }
      for (const key of ['routes', 'params', 'lib'] as const) {
        if (major === 3 && key === 'lib') { if (files.has(key)) gap('SvelteKit 3 removed files.lib; use package imports', configPath, true); continue; }
        result[key] = files.has(key) ? indexedPath(reader.string(files.get(key))) : path.posix.join(project.root, src, key);
        if (!result[key]) gap(`Dynamic/invalid Kit ${key} directory`, configPath, key === 'routes');
      }
      const hooks = files.has('hooks') ? reader.object(files.get('hooks')) : undefined;
      if (files.has('hooks') && !hooks) gap('Dynamic hook paths can change dispatch', configPath);
      for (const kind of ['server', 'client', 'universal']) {
        const configured = hooks?.get(kind), base = configured ? indexedPath(reader.string(configured)) : path.posix.join(project.root, src, `hooks${kind === 'universal' ? '' : `.${kind}`}`);
        if (!base) { gap(`Dynamic ${kind} hook path`, configPath); continue; }
        result.hooks.push(...[...context.files.values()].filter(file => file.path === base || ['.js', '.ts'].some(extension => file.path === base + extension)).map(file => file.path));
      }
    }
    result.base = paths?.has('base') ? reader.string(paths.get('base')) : paths ? '' : undefined;
    if (result.base === undefined || result.base !== '' && (!result.base.startsWith('/') || result.base.endsWith('/') || /[?#]/.test(result.base))) { result.base = undefined; gap('Dynamic/invalid Kit public base path prevents exact endpoint matching', configPath); }
    if (major === 2) {
      const aliases = nested('alias');
      if (!aliases) gap('Dynamic Kit aliases are unresolved', configPath);
      else for (const [name, value] of aliases) { const target = reader.string(value); if (!target || path.posix.isAbsolute(target) || target.includes('..') || (name.match(/\*/g)?.length ?? 0) > 1) { gap(`Unsupported Kit alias ${name}`, configPath); continue; } result.aliases[name] = [path.resolve(context.root, project.root, target)]; if (!name.includes('*')) result.aliases[`${name}/*`] = [path.resolve(context.root, project.root, target, '*')]; }
    }
    if (options.has('moduleExtensions') || options.has('extensions')) gap('Custom Kit source extensions are outside the indexed .svelte/.js/.ts profile', configPath, true);
    const router = nested('router'); if (!router || router.has('type') && reader.string(router.get('type')) !== 'pathname') gap('Unknown/hash Kit router changes public URL semantics', configPath);
  } else {
    result.hooks = [...context.files.values()].filter(file => path.posix.dirname(file.path) === path.posix.join(project.root, 'src') && /^hooks(?:\.(?:server|client))?\.[jt]s$/.test(path.posix.basename(file.path))).map(file => file.path);
  }
  if (major === 2 && result.lib) { result.aliases.$lib = [path.resolve(context.root, result.lib)]; result.aliases['$lib/*'] = [path.resolve(context.root, result.lib, '*')]; }
  return result;
}

export function kitVirtualImport(config: KitConfig | undefined, specifier: string, file: string): boolean {
  if (!config?.valid) return false;
  if (config.routes && (file === config.routes || file.startsWith(`${config.routes}/`)) && /^\.\/\$types(?:\.js)?$/.test(specifier)) return true;
  const modules = config.profile === 'sveltekit-2' ? ['$app/environment', '$app/forms', '$app/navigation', '$app/paths', '$app/state', '$app/stores', '$app/server', '$service-worker', '$env/static/private', '$env/static/public', '$env/dynamic/private', '$env/dynamic/public'] : ['$app/env', '$app/env/private', '$app/env/public', '$app/forms', '$app/navigation', '$app/paths', '$app/state', '$app/server', '$app/manifest', '$app/service-worker', '$app/types'];
  return modules.includes(specifier);
}
