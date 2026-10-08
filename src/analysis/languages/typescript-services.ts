import ts from 'typescript';
import path from 'node:path';
import type { Entity } from '../../core/graph.js';
import type { AnalysisContext, Analyzer, ScannedFile } from '../../core/analyzer.js';
import { ANALYZER_VERSION } from '../../core/graph.js';
import { ProjectCatalog, type NodeProject } from '../project-model.js';
import { TypeScriptResolver } from '../resolution/typescript.js';
import { IndexedSources } from '../indexed-sources.js';
import { createApplicationProgram } from '../../analyzers/ts-program.js';
import { sourcePath, sourceMapped, embeddedOwner } from '../embedded/index.js';
import { kitConfiguration, type KitConfig } from '../frameworks/sveltekit-config.js';

/** A node's exact source site, not its spelling, bridges separate compiler
 * programs. Each program keeps its own options, checker and global scope. */
export class DeclarationIndex extends Map<ts.Node, Entity> {
  private readonly bySite = new Map<string, Entity>();
  private site(node: ts.Node): string | undefined { const source = node.getSourceFile(); return source ? JSON.stringify([source.fileName, node.kind, node.getStart(source), node.end]) : undefined; }
  override set(node: ts.Node, entity: Entity): this { const site = this.site(node); if (site) this.bySite.set(site, entity); return super.set(node, entity); }
  override get(node: ts.Node): Entity | undefined { const direct = super.get(node); if (direct) return direct; const site = this.site(node); return site ? this.bySite.get(site) : undefined; }
  override has(node: ts.Node): boolean { return this.get(node) !== undefined; }
  override clear(): void { super.clear(); this.bySite.clear(); }
}
export interface TypeScriptProject {
  project: NodeProject; files: ScannedFile[]; inputs: ScannedFile[];
  program(): ts.Program;
  owners(source: ts.SourceFile): Map<ts.Node, Entity>;
  rememberOwners(source: ts.SourceFile, owners: Map<ts.Node, Entity>): void;
  releaseProgram(): void;
}
export interface TypeScriptServices {
  projects: TypeScriptProject[];
  declarations: DeclarationIndex;
  resolver: TypeScriptResolver;
  sveltekit: Map<string, KitConfig>;
  projectFor(relative: string): TypeScriptProject | undefined;
  releasePrograms(): void;
}

/** Recover declaration ownership after a graph-cache hit without extracting
 * a second set of graph entities. Source ranges identify the exact AST node. */
function restoreOwners(context: AnalysisContext, source: ts.SourceFile, declarations: DeclarationIndex): Map<ts.Node, Entity> {
  const relative = sourcePath(context, source.fileName), region = context.embedded?.input(source.fileName)?.region;
  const entities = new Map([...context.graph.entities.values()].filter(entity => entity.path === relative && entity.sourceRange && (!region || entity.metadata.embeddedRegion === region.key) && ['function', 'method', 'class', 'component', 'controller'].includes(entity.type)).map(entity => {
    const range = entity.sourceRange!;
    return [JSON.stringify([range.startLine, range.startColumn, range.endLine, range.endColumn]), entity];
  }));
  const owners = new Map<ts.Node, Entity>();
  const file = context.files.get(relative), scope = file && region ? embeddedOwner(context, { ...file, embedded: region }) : undefined;
  if (scope) { owners.set(source, scope); declarations.set(source, scope); }
  const visit = (node: ts.Node): void => {
    const start = source.getLineAndCharacterOfPosition(node.getStart(source)), end = source.getLineAndCharacterOfPosition(node.end);
    const entity = entities.get(JSON.stringify([start.line + 1, start.character + 1, end.line + 1, end.character + 1]));
    if (entity) {
      owners.set(node, entity); declarations.set(node, entity);
      if (ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) {
        const initializer = node.initializer;
        const callback = initializer && ts.isCallExpression(initializer) ? initializer.arguments[0] : initializer;
        if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) { owners.set(callback, entity); declarations.set(callback, entity); }
        if (initializer && callback !== initializer) { owners.set(initializer, entity); declarations.set(initializer, entity); }
      }
      if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && ts.isExportAssignment(node.parent)) declarations.set(node.parent, entity);
    }
    ts.forEachChild(node, visit);
  };
  visit(source); return owners;
}

export function createTypeScriptServices(context: AnalysisContext): TypeScriptServices {
  const sources = context.sources ??= new IndexedSources(context);
  const catalog = context.projects ??= new ProjectCatalog(context, sources);
  const resolver = new TypeScriptResolver(context, catalog, sources), declarations = new DeclarationIndex(), sveltekit = new Map<string, KitConfig>();
  for (const project of catalog.node) {
    const tsconfig = path.join(context.root, project.root, 'tsconfig.json');
    const configFile = sources.fileExists(tsconfig) ? tsconfig : path.join(context.root, project.root, 'jsconfig.json');
    let options: ts.CompilerOptions = { allowJs: true, jsx: ts.JsxEmit.ReactJSX, moduleResolution: ts.ModuleResolutionKind.Bundler, module: ts.ModuleKind.ESNext };
    if (sources.fileExists(configFile)) {
      const configHost = resolver.configHost(project);
      const read = ts.readConfigFile(configFile, configHost.readFile!);
      if (read.error) context.graph.diagnose({ analyzer: 'typescript-nextjs', severity: 'error', code: 'tsconfig-error', file: path.relative(context.root, configFile).split(path.sep).join('/'), reason: ts.flattenDiagnosticMessageText(read.error.messageText, '\n') });
      else {
        const parsed = ts.parseJsonConfigFileContent(read.config, { ...configHost, useCaseSensitiveFileNames: true, readDirectory: () => [] }, path.dirname(configFile));
        options = { ...options, ...parsed.options };
        for (const error of parsed.errors.filter(error => error.code !== 18003 && error.code !== 18002)) context.graph.diagnose({ analyzer: 'typescript-nextjs', severity: 'error', code: 'tsconfig-error', file: path.relative(context.root, configFile).split(path.sep).join('/'), reason: ts.flattenDiagnosticMessageText(error.messageText, '\n') });
        const inside = (absolute: string): string | undefined => { const relative = path.relative(context.root, absolute).split(path.sep).join('/') || '.'; return relative === '..' || relative.startsWith('../') || path.isAbsolute(relative) ? undefined : relative; };
        project.sourceRoots = [...new Set([options.rootDir, ...options.rootDirs ?? []].filter((root): root is string => !!root).map(inside).filter((root): root is string => root !== undefined))];
        if (!project.sourceRoots.length) project.sourceRoots = [project.root];
        project.references = [...new Set((parsed.projectReferences ?? []).map(reference => inside(reference.path)).filter((root): root is string => root !== undefined))].sort();
      }
    }
    const kit = kitConfiguration(context, project, sources);
    if (kit) {
      sveltekit.set(project.id, kit); for (const file of kit.inputs) resolver.configInputs.add(file);
      if (kit.valid) options.paths = { ...kit.aliases, ...options.paths };
    }
    resolver.options.set(project.id, options);
  }
  const projects = catalog.node.map(project => {
    const inputs = catalog.nodeFiles(project), files = inputs.flatMap(file => ['vue', 'svelte', 'astro'].includes(file.language ?? '') ? context.embedded?.inputs(file) ?? [] : [file]), bySource = new Map<ts.SourceFile, Map<ts.Node, Entity>>();
    const facades = inputs.map(file => context.embedded?.facade(file.absolutePath)).filter((file): file is string => !!file);
    let program: ts.Program | undefined;
    const runtime: TypeScriptProject = {
      project, files, inputs,
      program() {
        if (!program) {
          const texts = new Map<string, string>();
          for (const file of files) { const text = context.embedded?.readFile(file.absolutePath) ?? sources.readFile(file.absolutePath); if (text !== undefined) texts.set(file.absolutePath, text); }
          for (const facade of facades) texts.set(facade, context.embedded!.readFile(facade)!);
          program = createApplicationProgram(texts, resolver.options.get(project.id)!, path.join(context.root, project.root), {
            rootNames: [...texts.keys()], moduleHost: sources.moduleHost, readSource: fileName => context.embedded?.readFile(fileName) ?? sources.readFile(fileName),
            resolveModuleNameLiterals: (literals, containingFile, _redirect, _options, source) => literals.map(literal => resolver.resolve(literal.text, containingFile, ts.getModeForUsageLocation(source, literal, resolver.options.get(resolver.owner(containingFile).id)!), !!context.embedded?.input(containingFile)?.facade || literal.pos >= 0 && !sourceMapped(context, containingFile, literal.pos, literal.end))),
          });
        }
        return program;
      },
      owners(source) { let owners = bySource.get(source); if (!owners) { owners = restoreOwners(context, source, declarations); bySource.set(source, owners); } return owners; },
      rememberOwners(source, owners) { bySource.set(source, owners); },
      releaseProgram() { program = undefined; bySource.clear(); },
    };
    return runtime;
  }).filter(project => project.inputs.length);
  const byProject = new Map(projects.map(runtime => [runtime.project.id, runtime]));
  const services: TypeScriptServices = {
    projects, declarations, resolver, sveltekit, projectFor: relative => byProject.get(catalog.nodeOwner(relative).id),
    releasePrograms() { for (const runtime of projects) runtime.releaseProgram(); declarations.clear(); },
  };
  context.typescript = services;
  const repository = context.graph.entities.get(context.repositoryId)!;
  repository.metadata.projects = [...catalog.describe(), ...(Array.isArray(repository.metadata.projects) ? repository.metadata.projects.filter((project: { ecosystem?: string }) => project.ecosystem !== 'node') : [])];
  return services;
}

/** Place TS framework packs before this step. Programs/checkers need not
 * remain alive while unrelated language analyzers and API matching run;
 * the services can rebuild them lazily from indexed inputs and graph ranges. */
export const typescriptServicesRelease: Analyzer = {
  name: 'typescript-services-release', version: ANALYZER_VERSION,
  async analyze(context): Promise<void> { context.typescript?.releasePrograms(); },
};

/** A weak dependency component is the smallest safe cache unit when graph
 * patches contain declarations and cross-project relations. Compiler programs
 * remain separate, so unrelated global scripts cannot bind to each other. */
export function typescriptComponents(context: AnalysisContext, services: TypeScriptServices): TypeScriptProject[][] {
  const groups = new Map(services.projects.map(runtime => [runtime, new Set([runtime])])), catalog = services.resolver.projects;
  const connect = (a: TypeScriptProject, root: NodeProject | undefined): void => {
    const b = services.projects.find(runtime => runtime.project === root); if (!b || b === a) return;
    const combined = new Set([...groups.get(a)!, ...groups.get(b)!]);
    for (const runtime of combined) groups.set(runtime, combined);
  };
  for (const runtime of services.projects) {
    for (const name of Object.keys(runtime.project.dependencies)) { const binding = catalog.packageBinding(runtime.project, name); if (binding.status === 'resolved') connect(runtime, binding.project); }
    for (const reference of runtime.project.references) connect(runtime, catalog.node.find(project => project.root === reference));
    for (const file of runtime.files) {
      const text = context.embedded?.readFile(file.absolutePath) ?? context.sources!.readFile(file.absolutePath); if (text === undefined) continue;
      for (const imported of ts.preProcessFile(text, true, true).importedFiles) {
        // Relative directory imports use main/types fields, rather than
        // conditional package exports. One conservative probe is sufficient
        // for dependency invalidation; graph edges still use the actual mode.
        const modes: ts.ResolutionMode[] = imported.fileName.startsWith('.') ? [undefined] : [undefined, ts.ModuleKind.ESNext, ts.ModuleKind.CommonJS];
        for (const mode of modes) {
          const target = services.resolver.resolve(imported.fileName, file.absolutePath, mode).resolvedModule;
          if (target) connect(runtime, services.resolver.owner(target.resolvedFileName));
        }
      }
    }
  }
  return [...new Set(groups.values())].map(group => [...group].sort((a, b) => a.project.id.localeCompare(b.project.id))).sort((a, b) => a[0]!.project.id.localeCompare(b[0]!.project.id));
}
