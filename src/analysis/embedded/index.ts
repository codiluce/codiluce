import path from 'node:path';
import ts from 'typescript';
import type { AnalysisContext, Analyzer, ScannedFile } from '../../core/analyzer.js';
import { evidence, type Entity } from '../../core/graph.js';
import { fileKey } from '../../pipeline/cache.js';
import { featureOutcomes, fileAnalysis } from '../facts.js';
import { IndexedSources, type SourceMemoOptions } from '../indexed-sources.js';
import { SourceText } from '../source-map.js';
import { EMBEDDED_VERSION, embeddedText, extractEmbedded, mappedRange, type EmbeddedFacts, type EmbeddedLanguage, type EmbeddedRegion } from './source.js';
export { EMBEDDED_VERSION } from './source.js';

export interface EmbeddedInput { file: ScannedFile; region?: EmbeddedRegion; readonly text: string; facade?: boolean }
export const EMBEDDED_SOURCE_MEMO_MAX_BYTES = 32 * 1024 * 1024;
export const EMBEDDED_SOURCE_MEMO_MAX_ENTRIES = 4096;
interface EmbeddedRecipe { input: EmbeddedInput; suffix: string; facadeText?: string }
function bindings(input: EmbeddedInput, text: string): { names: Map<string, boolean>; exports: Map<string, boolean>; stars: string[] } {
  const names = new Map<string, boolean>(), exports = new Map<string, boolean>(), stars: string[] = [];
  const source = ts.createSourceFile(input.file.absolutePath, text, ts.ScriptTarget.Latest, true, input.region?.extension === 'tsx' ? ts.ScriptKind.TSX : input.region?.extension === 'jsx' ? ts.ScriptKind.JSX : input.region?.language === 'javascript' ? ts.ScriptKind.JS : ts.ScriptKind.TS);
  const add = (name: ts.BindingName, typeOnly = false): string[] => ts.isIdentifier(name) ? (names.set(name.text, typeOnly), [name.text]) : name.elements.flatMap(element => ts.isBindingElement(element) ? add(element.name, typeOnly) : []);
  for (const node of source.statements) {
    if (!input.region || !mappedRange(input.region, node.getStart(source), node.end)) continue;
    const publicDeclaration = ts.canHaveModifiers(node) && ts.getModifiers(node)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) && !ts.getModifiers(node)?.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword);
    if (ts.isVariableStatement(node)) for (const declaration of node.declarationList.declarations) for (const name of add(declaration.name)) { if (publicDeclaration) exports.set(name, false); }
    else if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isEnumDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) && node.name) {
      const typeOnly = ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node); names.set(node.name.text, typeOnly); if (publicDeclaration) exports.set(node.name.text, typeOnly);
    } else if (ts.isImportDeclaration(node) && node.importClause) {
      const clause = node.importClause; if (clause.name) names.set(clause.name.text, clause.isTypeOnly);
      if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) names.set(clause.namedBindings.name.text, clause.isTypeOnly);
      else if (clause.namedBindings) for (const item of clause.namedBindings.elements) names.set(item.name.text, clause.isTypeOnly || item.isTypeOnly);
    } else if (ts.isExportDeclaration(node)) {
      if (node.exportClause && ts.isNamedExports(node.exportClause)) for (const item of node.exportClause.elements) { if (item.name.text !== 'default') exports.set(item.name.text, node.isTypeOnly || item.isTypeOnly); }
      else if (node.moduleSpecifier && !node.exportClause) stars.push(node.getText(source));
    }
  }
  return { names, exports, stars };
}
/** In-memory compiler inputs are never inserted into the indexed file set.
 * Only original scanned source can produce graph entities and evidence. */
export class EmbeddedSources {
  private readonly virtual = new Map<string, EmbeddedInput>();
  private readonly recipes = new Map<string, EmbeddedRecipe>();
  private readonly texts = new Map<string, { text: string; bytes: number }>();
  private bytes = 0; private peakBytes = 0; private peakEntries = 0;
  private hits = 0; private misses = 0; private evictions = 0; private bypasses = 0;
  private readonly maxBytes: number; private readonly maxEntries: number;
  private readonly byOriginal = new Map<string, EmbeddedInput[]>();
  private readonly facades = new Map<string, string>();
  readonly facts = new Map<string, EmbeddedFacts>();
  constructor(private readonly context: AnalysisContext, options: SourceMemoOptions = {}) {
    this.maxBytes = options.maxBytes ?? EMBEDDED_SOURCE_MEMO_MAX_BYTES;
    this.maxEntries = options.maxEntries ?? EMBEDDED_SOURCE_MEMO_MAX_ENTRIES;
    for (const limit of [this.maxBytes, this.maxEntries]) if (!Number.isSafeInteger(limit) || limit < 0) throw Error('Embedded source memo limits must be nonnegative safe integers');
  }
  /** UTF-16 virtual text/key ownership, separate from recipes, live programs,
   * compiler trees, semantic facts and physical process memory. */
  memoStats() { return { bytes: this.bytes, entries: this.texts.size, maxBytes: this.maxBytes, maxEntries: this.maxEntries, peakBytes: this.peakBytes, peakEntries: this.peakEntries, hits: this.hits, misses: this.misses, evictions: this.evictions, bypasses: this.bypasses }; }
  clearTextMemo(): void { this.texts.clear(); this.bytes = 0; }
  private forget(fileName: string): void { const cached = this.texts.get(fileName); if (cached) { this.bytes -= cached.bytes; this.texts.delete(fileName); } }
  private forgetOriginal(file: ScannedFile): void {
    for (const input of this.byOriginal.get(file.path) ?? []) this.forget(input.file.absolutePath);
    const facade = this.facades.get(path.join(this.context.root, file.path)); if (facade) this.forget(facade);
  }
  private inputRecipe(file: ScannedFile, region?: EmbeddedRegion, facadeText?: string): EmbeddedRecipe {
    const service = this;
    const input: EmbeddedInput = { file, ...region ? { region } : { facade: true }, get text() {
      const text = service.readFile(region ? file.absolutePath : `${file.absolutePath}.__codiluce_component.ts`);
      if (text === undefined) throw Error(`Indexed embedded source unavailable: ${file.path}`);
      return text;
    } };
    return { input, suffix: '', ...facadeText === undefined ? {} : { facadeText } };
  }
  private materialize(recipe: EmbeddedRecipe, original: string): string { return recipe.facadeText ?? embeddedText(original, recipe.input.region!) + recipe.suffix; }
  add(file: ScannedFile, original: string, facts: EmbeddedFacts): void {
    this.forgetOriginal(file);
    for (const input of this.byOriginal.get(file.path) ?? []) { this.virtual.delete(input.file.absolutePath); this.recipes.delete(input.file.absolutePath); }
    const oldFacade = this.facades.get(file.absolutePath); if (oldFacade) { this.virtual.delete(oldFacade); this.recipes.delete(oldFacade); }
    this.byOriginal.delete(file.path); this.facades.delete(file.absolutePath);
    this.facts.set(file.path, facts);
    // Keep original ranges and compiler-only suffixes. No persistent
    // input object owns a padded copy of the whole original component.
    const recipes: EmbeddedRecipe[] = [], failed = facts.issues.some(issue => issue.fatal);
    for (const region of facts.regions) if (region.supported && !failed) {
      const absolutePath = `${file.absolutePath}.__codiluce_${region.key.replace(':', '_')}.${region.extension}`;
      if (this.context.files.has(path.relative(this.context.root, absolutePath).split(path.sep).join('/'))) { facts.issues.push({ code: 'virtual-collision', reason: 'An indexed file occupies the compiler input namespace', start: region.start, fatal: true }); recipes.length = 0; break; }
      recipes.push(this.inputRecipe({ ...file, absolutePath, embedded: region }, region));
    }
    const facade = `${file.absolutePath}.__codiluce_component.ts`;
    if (this.context.files.has(path.relative(this.context.root, facade).split(path.sep).join('/'))) { facts.issues.push({ code: 'virtual-collision', reason: 'An indexed file occupies the component compiler namespace', start: 0, fatal: true }); return; }
    // Named module exports stay available through a component import. Default
    // component construction is deliberately opaque until its pack qualifies it.
    const modules = recipes.filter(recipe => recipe.input.region?.role === 'module'), publicExports: string[] = [];
    for (const module of modules) {
      const bound = bindings(module.input, this.materialize(module, original)), specifier = JSON.stringify(`./${path.basename(module.input.file.absolutePath)}`);
      for (const [name, typeOnly] of bound.exports) publicExports.push(`export ${typeOnly ? 'type ' : ''}{ ${JSON.stringify(name)} } from ${specifier};`);
      publicExports.push(...bound.stars);
      for (const [name, typeOnly] of bound.names) module.suffix += `\nexport ${typeOnly ? 'type ' : ''}{ ${name} as __codiluce_private_${name} };`;
      for (const target of recipes.filter(recipe => ['setup', 'instance'].includes(recipe.input.region!.role))) {
        const shadowed = bindings(target.input, this.materialize(target, original)).names;
        for (const [name, typeOnly] of bound.names) if (!shadowed.has(name)) target.suffix += `\nimport ${typeOnly ? 'type ' : ''}{ __codiluce_private_${name} as ${name} } from ${specifier};`;
      }
    }
    const component = this.inputRecipe(file, undefined, `${publicExports.join('\n')}\ndeclare const __codiluce_component: unknown;\nexport default __codiluce_component;\n`);
    // Compiler-only recipes must not keep sliced identifier/export strings
    // backed by an original component. Preserve every UTF-16 code unit.
    component.facadeText = Buffer.from(component.facadeText!, 'utf16le').toString('utf16le');
    for (const recipe of recipes) recipe.suffix = Buffer.from(recipe.suffix, 'utf16le').toString('utf16le');
    this.virtual.set(facade, component.input); this.recipes.set(facade, component); this.facades.set(file.absolutePath, facade);
    this.byOriginal.set(file.path, recipes.map(recipe => recipe.input));
    for (const recipe of recipes) { this.virtual.set(recipe.input.file.absolutePath, recipe.input); this.recipes.set(recipe.input.file.absolutePath, recipe); }
  }
  inputs(file: ScannedFile): ScannedFile[] { return this.byOriginal.get(file.path)?.map(input => input.file) ?? []; }
  facade(fileName: string): string | undefined { return this.facades.get(fileName); }
  input(fileName: string): EmbeddedInput | undefined { return this.virtual.get(fileName); }
  original(fileName: string): string { return this.virtual.get(fileName)?.file.path ?? path.relative(this.context.root, fileName).split(path.sep).join('/'); }
  mapped(fileName: string, start: number, end: number): boolean { const input = this.virtual.get(fileName); return !input || !!input.region && !!mappedRange(input.region, start, end); }
  readFile(fileName: string): string | undefined {
    const recipe = this.recipes.get(fileName); if (!recipe) return undefined;
    const cached = this.texts.get(fileName);
    if (cached) { this.hits++; this.texts.delete(fileName); this.texts.set(fileName, cached); return cached.text; }
    this.misses++;
    const sources = this.context.sources ??= new IndexedSources(this.context);
    let original: string;
    try { original = sources.readText(path.join(this.context.root, recipe.input.file.path), { revalidate: true }); }
    catch (error) { this.forgetOriginal(recipe.input.file); sources.failures.set(recipe.input.file.path, error instanceof Error ? error.message : String(error)); return undefined; }
    const text = this.materialize(recipe, original), bytes = 2 * (fileName.length + text.length);
    if (!this.maxEntries || bytes > this.maxBytes) { this.bypasses++; return text; }
    while (this.texts.size >= this.maxEntries || this.bytes + bytes > this.maxBytes) { this.forget(this.texts.keys().next().value!); this.evictions++; }
    this.texts.set(fileName, { text, bytes }); this.bytes += bytes;
    this.peakBytes = Math.max(this.peakBytes, this.bytes); this.peakEntries = Math.max(this.peakEntries, this.texts.size);
    return text;
  }
  internal(specifier: string, importer: string): string | undefined {
    if (!this.virtual.has(importer) || !specifier.startsWith('./')) return undefined;
    const candidate = path.resolve(path.dirname(importer), specifier), input = this.virtual.get(candidate);
    return input?.region?.role === 'module' && input.file.path === this.virtual.get(importer)!.file.path ? candidate : undefined;
  }
}
export function sourcePath(context: AnalysisContext, fileName: string): string { return context.embedded?.original(fileName) ?? path.relative(context.root, fileName).split(path.sep).join('/'); }
export function sourceAvailable(context: AnalysisContext, fileName: string): boolean { return !!context.files.get(sourcePath(context, fileName))?.analyzable; }
export function sourceMapped(context: AnalysisContext, fileName: string, start: number, end: number): boolean { return context.embedded?.mapped(fileName, start, end) ?? true; }
export function embeddedOwner(context: AnalysisContext, file: ScannedFile): Entity | undefined {
  if (!file.embedded) return undefined;
  const scopes = context.graph.entities.get(file.id)?.metadata.embeddedScopes as Record<string, string> | undefined;
  return scopes?.[file.embedded.key] ? context.graph.entities.get(scopes[file.embedded.key]!) : undefined;
}
export const embeddedAnalyzer: Analyzer = {
  name: 'embedded-source', version: EMBEDDED_VERSION,
  async analyze(context) {
    const sources = context.sources ??= new IndexedSources(context), embedded = context.embedded = new EmbeddedSources(context);
    for (const file of context.files.values()) if (['vue', 'svelte', 'astro'].includes(file.language ?? '')) {
      const entity = context.graph.entities.get(file.id)!;
      const analysis = entity.metadata.analysis = { version: 1 as const, adapter: `embedded-${file.language}`, adapterVersion: EMBEDDED_VERSION, features: featureOutcomes('unsupported', 'Template/framework semantics require a component pack') };
      if (!file.analyzable) { analysis.features = featureOutcomes('disabled', String(entity.metadata.analysisSkipped ?? 'Source unavailable')); continue; }
      const text = sources.readFile(file.absolutePath);
      if (text === undefined) { analysis.features = featureOutcomes('failed', 'Indexed component source unavailable'); continue; }
      const compute = async () => extractEmbedded(text, file.language as EmbeddedLanguage);
      const facts = context.cache ? await context.cache.value(this.name, file.path, { version: EMBEDDED_VERSION, file: fileKey(context, file.path) }, compute) : await compute();
      embedded.add(file, text, structuredClone(facts)); const actual = embedded.facts.get(file.path)!;
      entity.metadata.embeddedRegions = actual.regions; entity.metadata.embeddedTemplates = actual.templates;
      const failed = actual.issues.some(issue => issue.fatal);
      analysis.features.structure = { status: failed ? 'failed' : 'partial', reason: failed ? 'Component block extraction failed' : 'Original component identity and embedded script declarations; template semantics require a pack' };
      for (const issue of actual.issues) context.graph.diagnose({ analyzer: this.name, severity: issue.fatal ? 'error' : 'warning', code: `embedded-${issue.code}`, file: file.path, line: new SourceText(text).position(issue.start).line, entityId: file.id, reason: issue.reason });
      const range = new SourceText(text).range(0, text.length), id = context.graph.id('component', file.language!, file.application?.name ?? '.', file.path);
      context.graph.contain({ id, type: 'component', name: path.basename(file.path, path.extname(file.path)), path: file.path, language: file.language, parentId: file.id, sourceRange: range, metadata: { framework: file.language, role: 'component', componentFile: true, registration: 'convention' }, evidence: [evidence('framework', this.name, file.path, 1, 'Original component file identity; generated compiler modules are not source files')] });
      entity.metadata.component = id; entity.metadata.defaultExport = id;
      const scopes: Record<string, string> = {};
      for (const region of actual.regions) if (region.supported && !failed) {
        const scopeId = context.graph.id('embedded-scope', file.path, region.key);
        context.graph.contain({ id: scopeId, type: 'function', name: region.role === 'client' ? `client script ${region.key.split(':')[1]}` : `${region.role} script`, path: file.path, language: file.language, parentId: id, sourceRange: region.range, metadata: { role: 'script', embeddedRegion: region.key, executionContext: region.executionContext, qualifiedName: region.key, synthetic: false }, evidence: [evidence('syntax', this.name, file.path, region.range.startLine, 'Original embedded script execution scope')] });
        scopes[region.key] = scopeId;
      }
      entity.metadata.embeddedScopes = scopes;
    }
  },
};
export function embeddedOutcome(context: AnalysisContext, file: ScannedFile, failed: boolean): void {
  const analysis = fileAnalysis(context.graph.entities.get(file.id)?.metadata.analysis); if (!file.embedded || !analysis) return;
  for (const feature of ['imports', 'references', 'effects', 'guards'] as const) if (analysis.features[feature].status !== 'failed') analysis.features[feature] = { status: failed ? 'failed' : 'partial', reason: failed ? 'Embedded script parsing failed' : 'Static embedded JS/TS subset; template semantics remain separate' };
  if (failed) analysis.features.structure = { status: 'failed', reason: 'Embedded script parsing failed' };
}
