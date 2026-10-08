import ts from 'typescript';
import path from 'node:path';
import type { AnalysisContext } from '../../core/analyzer.js';
import type { NodeProject, ProjectCatalog, PackageBinding } from '../project-model.js';
import type { IndexedSources } from '../indexed-sources.js';

export function packageName(specifier: string): string | undefined {
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('#') || specifier.includes(':')) return undefined;
  const parts = specifier.split('/'); return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}
/** Let the TS resolver interpret exports/conditions/extensions. Its virtual
 * node_modules probes are translated to declared, indexed local packages;
 * no installed target dependencies or unindexed files are visible. */
export class TypeScriptResolver {
  readonly options = new Map<string, ts.CompilerOptions>();
  readonly configInputs = new Set<string>();
  private readonly results = new Map<string, ts.ResolvedModuleWithFailedLookupLocations>();
  private readonly hosts = new Map<string, ts.ModuleResolutionHost>();
  private readonly owners = new Map<string, NodeProject>();
  constructor(private readonly context: AnalysisContext, readonly projects: ProjectCatalog, readonly sources: IndexedSources) {}
  owner(fileName: string): NodeProject { let project = this.owners.get(fileName); if (!project) { project = this.projects.nodeOwner(path.relative(this.context.root, fileName).split(path.sep).join('/')); this.owners.set(fileName, project); } return project; }
  binding(specifier: string, containingFile: string): PackageBinding | undefined {
    const name = packageName(specifier); return name ? this.projects.packageBinding(this.owner(containingFile), name) : undefined;
  }
  private virtualHost(importer: NodeProject): ts.ModuleResolutionHost {
    const cached = this.hosts.get(importer.id); if (cached) return cached;
    const eligible = [...new Set([importer.packageName, ...Object.keys(importer.dependencies)].filter((name): name is string => !!name))].filter(name => this.projects.packageBinding(importer, name).status === 'resolved');
    const targets = new Map(eligible.flatMap(name => { const binding = this.projects.packageBinding(importer, name); return binding.status === 'resolved' ? [[name, binding.project] as const] : []; }));
    const translate = (fileName: string): string | undefined => {
      const normalized = fileName.split(path.sep).join('/');
      const match = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)(?:\/(.*))?$/.exec(normalized);
      if (!match) return /(?:^|\/)node_modules(?:\/|$)/.test(normalized) ? undefined : fileName;
      const target = targets.get(match[1]!);
      return target ? path.join(this.context.root, target.root, match[2] ?? '') : undefined;
    };
    const host: ts.ModuleResolutionHost = {
      fileExists: fileName => { const target = translate(fileName); return target !== undefined && this.sources.fileExists(target); },
      readFile: fileName => { const target = translate(fileName); return target === undefined ? undefined : this.sources.readFile(target); },
      directoryExists: directory => {
        const normalized = directory.split(path.sep).join('/');
        if (/(?:^|\/)node_modules$/.test(normalized)) return eligible.length > 0;
        const scope = /(?:^|\/)node_modules\/(@[^/]+)$/.exec(normalized);
        if (scope) return eligible.some(name => name.startsWith(`${scope[1]}/`));
        const target = translate(directory); return target !== undefined && this.sources.directoryExists(target);
      },
      realpath: fileName => translate(fileName) ?? fileName,
      getCurrentDirectory: () => this.context.root,
    };
    this.hosts.set(importer.id, host); return host;
  }
  configHost(project: NodeProject): ts.ModuleResolutionHost {
    const host = this.virtualHost(project);
    return { ...host, readFile: fileName => {
      const physical = host.realpath!(fileName), text = host.readFile!(fileName);
      if (this.sources.fileExists(physical)) this.configInputs.add(path.relative(this.context.root, physical).split(path.sep).join('/'));
      return text;
    } };
  }
  resolve(specifier: string, containingFile: string, mode?: ts.ResolutionMode): ts.ResolvedModuleWithFailedLookupLocations {
    const project = this.owner(containingFile), options = this.options.get(project.id) ?? {};
    const key = JSON.stringify([containingFile, specifier, mode]);
    const cached = this.results.get(key); if (cached) return cached;
    const host = this.virtualHost(project);
    let result = ts.resolveModuleName(specifier, containingFile, options, host, undefined, undefined, mode);
    if (result.resolvedModule) {
      const physical = host.realpath!(result.resolvedModule.resolvedFileName);
      // Every graph/program target is a canonical indexed path, even when
      // the target project asks the runtime to preserve workspace symlinks.
      result = { ...result, resolvedModule: this.sources.fileExists(physical) ? { ...result.resolvedModule, resolvedFileName: physical, isExternalLibraryImport: false, packageId: undefined } : undefined };
    }
    this.results.set(key, result); return result;
  }
}
