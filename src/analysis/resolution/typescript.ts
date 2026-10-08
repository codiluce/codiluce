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
  /** Literal Node subpath imports also identify indexed non-TS assets. Complex
   * conditional targets stay with the compiler resolver, not a guessed path. */
  assetCandidates(specifier: string, containingFile: string): string[] {
    if (!specifier.startsWith('#')) return [];
    const project = this.owner(containingFile), manifest = project.manifest && this.sources.readFile(path.resolve(this.context.root, project.manifest));
    if (!manifest) return [];
    try {
      const imports: unknown = JSON.parse(manifest).imports;
      if (!imports || typeof imports !== 'object' || Array.isArray(imports)) return [];
      const matches = Object.entries(imports).filter(([key]) => { const star = key.indexOf('*'); return star < 0 ? specifier === key : specifier.startsWith(key.slice(0, star)) && specifier.endsWith(key.slice(star + 1)); }).sort(([a], [b]) => Number(b === specifier) - Number(a === specifier) || b.indexOf('*') - a.indexOf('*') || b.length - a.length);
      const entry = matches[0]; if (!entry || typeof entry[1] !== 'string' || !entry[1].startsWith('./') || entry[1].includes('..') || entry[1].includes('\\')) return [];
      const [key, target] = entry, star = key.indexOf('*'), capture = star < 0 ? '' : specifier.slice(star, specifier.length - (key.length - star - 1));
      return [path.resolve(this.context.root, project.root, target.replaceAll('*', capture))];
    } catch { return []; }
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
    const componentProbe = (target: string): string | undefined => {
      if (this.sources.fileExists(target)) return undefined;
      const match = /^(.*)\.d\.(vue|svelte|astro)\.ts$/.exec(target) ?? /^(.*)\.(vue|svelte|astro)\.(?:ts|tsx|js|jsx)$/.exec(target);
      const original = match ? `${match[1]}.${match[2]}` : undefined;
      return original && this.sources.fileExists(original) ? this.context.embedded?.facade(original) : undefined;
    };
    const host: ts.ModuleResolutionHost = {
      fileExists: fileName => { const target = translate(fileName); return target !== undefined && (this.sources.fileExists(target) || !!this.context.embedded?.input(target) || !!componentProbe(target)); },
      readFile: fileName => { const target = translate(fileName); return target === undefined ? undefined : this.context.embedded?.readFile(target) ?? this.sources.readFile(target); },
      directoryExists: directory => {
        const normalized = directory.split(path.sep).join('/');
        if (/(?:^|\/)node_modules$/.test(normalized)) return eligible.length > 0;
        const scope = /(?:^|\/)node_modules\/(@[^/]+)$/.exec(normalized);
        if (scope) return eligible.some(name => name.startsWith(`${scope[1]}/`));
        const target = translate(directory); return target !== undefined && this.sources.directoryExists(target);
      },
      realpath: fileName => { const target = translate(fileName) ?? fileName; return componentProbe(target) ?? target; },
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
  resolve(specifier: string, containingFile: string, mode?: ts.ResolutionMode, generated = false): ts.ResolvedModuleWithFailedLookupLocations {
    const project = this.owner(containingFile), options = this.options.get(project.id) ?? {};
    const key = JSON.stringify([containingFile, specifier, mode, generated]);
    const cached = this.results.get(key); if (cached) return cached;
    const internal = generated ? this.context.embedded?.internal(specifier, containingFile) : undefined;
    if (internal) return { resolvedModule: { resolvedFileName: internal, extension: internal.endsWith('.js') ? ts.Extension.Js : internal.endsWith('.jsx') ? ts.Extension.Jsx : internal.endsWith('.tsx') ? ts.Extension.Tsx : ts.Extension.Ts, isExternalLibraryImport: false } };
    if (specifier.includes('.__codiluce_')) return { resolvedModule: undefined };
    const host = this.virtualHost(project);
    let result = ts.resolveModuleName(specifier, containingFile, options, host, undefined, undefined, mode);
    if (result.resolvedModule) {
      const physical = host.realpath!(result.resolvedModule.resolvedFileName);
      // Every graph/program target is a canonical indexed path, even when
      // the target project asks the runtime to preserve workspace symlinks.
      const facade = this.context.embedded?.input(physical)?.facade;
      result = { ...result, resolvedModule: facade || this.sources.fileExists(physical) && !this.context.embedded?.input(physical) ? { ...result.resolvedModule, ...(facade ? { extension: ts.Extension.Ts } : {}), resolvedFileName: physical, isExternalLibraryImport: false, packageId: undefined } : undefined };
    }
    if (!result.resolvedModule && /\.(?:vue|svelte|astro)$/.test(specifier)) {
      const candidates: string[] = []; if (specifier.startsWith('.')) candidates.push(path.resolve(path.dirname(containingFile), specifier));
      const base = options.baseUrl ?? (options as ts.CompilerOptions & { pathsBasePath?: string }).pathsBasePath ?? path.join(this.context.root, project.root);
      for (const [alias, replacements] of Object.entries(options.paths ?? {})) {
        const star = alias.indexOf('*');
        if (star < 0 ? specifier !== alias : !specifier.startsWith(alias.slice(0, star)) || !specifier.endsWith(alias.slice(star + 1))) continue;
        const capture = star < 0 ? '' : specifier.slice(star, specifier.length - (alias.length - star - 1));
        for (const replacement of replacements) candidates.push(path.resolve(base, replacement.replace('*', capture)));
      }
      for (const candidate of candidates) {
        const physical = host.realpath!(candidate), facade = this.sources.fileExists(physical) ? this.context.embedded?.facade(physical) : undefined;
        if (facade) { result = { ...result, resolvedModule: { resolvedFileName: facade, extension: ts.Extension.Ts, isExternalLibraryImport: false } }; break; }
      }
    }
    this.results.set(key, result); return result;
  }
}
