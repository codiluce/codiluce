import ts from 'typescript';
import path from 'node:path';
import type { AnalysisContext } from '../../core/analyzer.js';
import type { IndexedSources } from '../indexed-sources.js';
import type { NodeProject } from '../project-model.js';
import { profile, propertyName } from './typescript-static.js';
import { unwrap } from './typescript-binding.js';

export interface AstroConfig {
  profile: 'astro-5' | 'astro-6' | 'astro-7'; project: NodeProject;
  src: string; base: string; output: 'static' | 'server'; trailingSlash: 'always' | 'never' | 'ignore';
  adapter?: string; fetchFile?: string | null; renderers: string[]; inputs: string[]; conditions: string[]; valid: boolean;
  rendererFilters: Record<string, { include?: string[]; exclude?: string[] }>;
}
/** Local literals only. Configuration factories, imports, adapters and plugins
 * are never evaluated. An escaped or mutated receiver loses its qualification. */
class AstroConfigReader {
  private readonly constants = new Map<string, ts.Expression>();
  private readonly writes = new Set<string>();
  constructor(readonly source: ts.SourceFile, private readonly external: (module: string) => boolean) {
    for (const statement of source.statements) if (ts.isVariableStatement(statement) && statement.declarationList.flags & ts.NodeFlags.Const) for (const declaration of statement.declarationList.declarations) if (ts.isIdentifier(declaration.name) && declaration.initializer) this.constants.set(declaration.name.text, declaration.initializer);
    const mark = (node: ts.Expression, seen = new Set<string>()): void => {
      node = unwrap(node); while (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) node = node.expression;
      if (!ts.isIdentifier(node) || seen.has(node.text)) return; seen.add(node.text); this.writes.add(node.text);
      const value = this.constants.get(node.text); if (value) mark(value, seen);
    };
    const visit = (node: ts.Node): void => {
      if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) mark(node.left);
      if (ts.isPostfixUnaryExpression(node) || ts.isPrefixUnaryExpression(node) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator)) mark(node.operand);
      if (ts.isCallExpression(node) && !this.api(node.expression, 'astro/config', 'defineConfig')) { if (ts.isPropertyAccessExpression(node.expression)) mark(node.expression.expression); for (const argument of node.arguments) mark(argument); }
      ts.forEachChild(node, visit);
    }; visit(source);
  }
  binding(node: ts.Expression): { module: string; member: string } | undefined {
    node = unwrap(node);
    const name = ts.isIdentifier(node) ? node.text : ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) ? node.expression.text : undefined;
    if (!name || this.writes.has(name) || this.constants.has(name)) return undefined;
    for (const statement of this.source.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier) || !statement.importClause || statement.importClause.isTypeOnly) continue;
      const module = statement.moduleSpecifier.text, clause = statement.importClause;
      if (!this.external(module)) continue;
      if (clause.name?.text === name && ts.isIdentifier(node)) return { module, member: 'default' };
      if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings) && clause.namedBindings.name.text === name && ts.isPropertyAccessExpression(node)) return { module, member: node.name.text };
      if (clause.namedBindings && ts.isNamedImports(clause.namedBindings) && ts.isIdentifier(node)) for (const item of clause.namedBindings.elements) if (!item.isTypeOnly && item.name.text === name) return { module, member: (item.propertyName ?? item.name).text };
    }
    return undefined;
  }
  api(node: ts.Expression, module: string, member: string): boolean { const binding = this.binding(node); return binding?.module === module && binding.member === member; }
  read(node: ts.Expression | undefined, seen = new Set<string>()): ts.Expression | undefined {
    if (!node || seen.size > 20) return undefined; node = unwrap(node);
    if (ts.isIdentifier(node)) { if (seen.has(node.text) || this.writes.has(node.text)) return undefined; seen.add(node.text); return this.read(this.constants.get(node.text), seen); }
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
    const result: ts.Expression[] = [];
    for (const item of node.elements) if (ts.isSpreadElement(item)) { const spread = this.array(item.expression, depth + 1); if (!spread) return undefined; result.push(...spread); } else if (!ts.isOmittedExpression(item)) result.push(item); else return undefined;
    return result.length <= 128 ? result : undefined;
  }
  string(node: ts.Expression | undefined): string | undefined { node = this.read(node); return node && ts.isStringLiteralLike(node) ? node.text : undefined; }
}

export function astroConfiguration(context: AnalysisContext, project: NodeProject, sources: IndexedSources): AstroConfig | undefined {
  const version = project.dependencies.astro; if (!version) return undefined;
  const major = ([5, 6, 7] as const).find(major => profile(version, major));
  const diagnose = (reason: string, file = project.manifest, code = 'astro-config-gap') => context.graph.diagnose({ analyzer: 'astro', severity: 'warning', code, file, reason });
  const external = (module: string): boolean => !module.startsWith('.') && context.projects?.packageBinding(project, module.startsWith('@') ? module.split('/').slice(0, 2).join('/') : module.split('/')[0]!).status === 'external';
  if (!major || !external('astro')) { diagnose(`Astro ${version} does not select a qualified external 5/6/7 profile`, project.manifest, 'astro-version-profile'); return undefined; }
  const result: AstroConfig = { profile: `astro-${major}`, project, src: path.posix.join(project.root, 'src'), base: '', output: 'static', trailingSlash: 'ignore', ...(major === 7 ? { fetchFile: 'fetch' } : {}), renderers: [], rendererFilters: {}, inputs: [], conditions: [], valid: true };
  const gap = (reason: string, file?: string, fatal = false): void => { result.conditions.push(reason); if (fatal) result.valid = false; diagnose(reason, file); };
  const configs = [...context.files.values()].filter(file => path.posix.dirname(file.path) === project.root && /^astro\.config\.[cm]?[jt]s$/.test(path.posix.basename(file.path)));
  if (configs.length > 1) gap('Multiple Astro configuration inputs prevent an unambiguous static profile', configs[0]?.path, true);
  for (const file of configs) {
    result.inputs.push(file.path); const text = sources.readFile(file.absolutePath);
    if (text === undefined) { gap('Unavailable Astro configuration', file.path, true); continue; }
    const source = ts.createSourceFile(file.absolutePath, text, ts.ScriptTarget.Latest, true), reader = new AstroConfigReader(source, external);
    if ((source as ts.SourceFile & { parseDiagnostics: ts.Diagnostic[] }).parseDiagnostics.length) { gap('Malformed Astro configuration', file.path, true); continue; }
    const exported = source.statements.find(ts.isExportAssignment); let root = exported && !exported.isExportEquals ? reader.read(exported.expression) : undefined;
    if (root && ts.isCallExpression(root) && reader.api(root.expression, 'astro/config', 'defineConfig') && root.arguments.length === 1) root = root.arguments[0];
    const fields = reader.object(root); if (!fields) { gap('Dynamic/unproven Astro configuration prevents default route guesses', file.path, true); continue; }
    if (fields.has('root')) gap('An overridden Astro root requires a separate configuration profile', file.path, true);
    if (fields.has('srcDir')) {
      const src = reader.string(fields.get('srcDir')), absolute = src && path.resolve(context.root, project.root, src), relative = absolute && path.relative(context.root, absolute).split(path.sep).join('/');
      if (!relative || relative === '..' || relative.startsWith('../') || src!.includes('\\')) gap('Dynamic/outside-index Astro source directory', file.path, true); else result.src = relative;
    }
    if (fields.has('base')) {
      const base = reader.string(fields.get('base'));
      if (!base || !base.startsWith('/') || /[?#\\]/.test(base) || base.includes('//') || base.split('/').some(part => part === '.' || part === '..')) gap('Dynamic/invalid Astro base prevents exact route qualification', file.path, true); else result.base = base.replace(/\/$/, '');
    }
    if (fields.has('output')) { const output = reader.string(fields.get('output')); if (output === 'static' || output === 'server') result.output = output; else gap('Unknown/version-incompatible Astro output mode', file.path, true); }
    if (fields.has('trailingSlash')) { const value = reader.string(fields.get('trailingSlash')); if (value === 'always' || value === 'never' || value === 'ignore') result.trailingSlash = value; else gap('Dynamic trailing slash policy', file.path, true); }
    if (fields.has('fetchFile')) { const value = reader.read(fields.get('fetchFile')); if (major === 7 && value?.kind === ts.SyntaxKind.NullKeyword) result.fetchFile = null; else { const name = reader.string(value); if (major === 7 && name && /^[A-Za-z_][\w-]*$/.test(name)) result.fetchFile = name; else gap('Unsupported custom fetch entrypoint name/profile', file.path); } }
    if (fields.has('adapter')) { const value = reader.read(fields.get('adapter')), binding = value && ts.isCallExpression(value) && reader.binding(value.expression); if (binding && binding.member === 'default' && ['@astrojs/node', '@astrojs/netlify', '@astrojs/vercel', '@astrojs/cloudflare'].includes(binding.module)) result.adapter = binding.module; else gap('Unqualified custom/dynamic adapter; deployment dispatch remains constrained', file.path); }
    if (fields.has('integrations')) {
      const integrations = reader.array(fields.get('integrations'));
      if (!integrations) gap('Dynamic integrations may inject routes/renderers', file.path);
      else for (const item of integrations) {
        const value = reader.read(item), binding = value && ts.isCallExpression(value) ? reader.binding(value.expression) : undefined;
        if (binding?.member === 'default' && ['@astrojs/vue', '@astrojs/svelte', '@astrojs/react'].includes(binding.module) && value && ts.isCallExpression(value)) {
          const renderer = binding.module.slice('@astrojs/'.length), options = value.arguments.length === 0 ? new Map<string, ts.Expression>() : value.arguments.length === 1 ? reader.object(value.arguments[0]) : undefined;
          if (!options) { diagnose(`Dynamic ${renderer} integration options prevent renderer qualification`, file.path); continue; }
          const filters: { include?: string[]; exclude?: string[] } = {}; let valid = true;
          for (const key of ['include', 'exclude'] as const) if (options.has(key)) { const array = reader.array(options.get(key)), patterns = array?.map(item => reader.string(item)); if (!patterns || patterns.some(pattern => pattern === undefined || pattern.length > 4096 || /[{}()[\]!\\]/.test(pattern))) valid = false; else filters[key] = patterns as string[]; }
          if (!valid || result.renderers.includes(renderer)) { diagnose(`Unsupported/conflicting ${renderer} renderer include/exclude policy`, file.path); continue; }
          result.renderers.push(renderer); result.rendererFilters[renderer] = filters;
        }
        else gap(`Integration ${binding?.module ?? 'expression'} has no static route/renderer summary`, file.path);
      }
    }
    for (const key of ['vite', 'i18n', 'redirects', 'experimental', 'legacy', 'middleware']) if (fields.has(key)) gap(`Astro ${key} configuration requires a separate dispatch summary`, file.path);
  }
  if (result.fetchFile) for (const file of context.files.values()) if (path.posix.dirname(file.path) === result.src && path.posix.basename(file.path).replace(/\.[cm]?[jt]s$/, '') === result.fetchFile) { result.inputs.push(file.path); gap('Astro 7 custom fetch pipeline may override filesystem dispatch', file.path); }
  return result;
}

export function astroVirtualImport(config: AstroConfig | undefined, specifier: string): boolean {
  return !!config?.valid && ['astro:middleware', 'astro:assets', 'astro:actions', 'astro:content', 'astro:env/client', 'astro:env/server', 'astro:transitions', 'astro:transitions/client', 'astro:config/client', 'astro:config/server'].includes(specifier);
}
