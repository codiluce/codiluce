import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import type { AnalysisContext, ScannedFile } from '../../core/analyzer.js';
import type { ApplicationConfig } from '../../core/config.js';
import { applicationAt } from '../../core/config.js';
import { evidence, type Evidence } from '../../core/graph.js';
import { IndexedSources } from '../indexed-sources.js';

export interface PythonProject {
  id: string; root: string; application?: ApplicationConfig; manifest?: string;
  layout: 'configured' | 'manifest' | 'inferred'; gaps: string[];
  sourceRoots: { path: string; proof: Evidence }[];
}
export interface PythonModule {
  name: string; file?: ScannedFile; directory: string; package: boolean;
  namespace: boolean; root: string; proof: Evidence[];
  excluded?: true;
}
export type PythonModuleOutcome = { status: 'resolved'; modules: PythonModule[]; parents: PythonModule[]; proof: Evidence[] }
  | { status: 'ambiguous'; candidates: PythonModule[]; reason: string }
  | { status: 'external' | 'unresolved' | 'excluded' | 'unsupported'; reason: string };
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const identifier = (value: string) => /^[\p{ID_Start}_][\p{ID_Continue}]*$/u.test(value);
const TEST_PATH = /(?:^|\/)(?:tests?|__tests__|spec|fixtures|__fixtures__|testdata)(?:\/|$)/;
const inside = (file: string, root: string) => root === '.' || file === root || file.startsWith(`${root}/`);

/** Import names come from source paths/package roots, never distribution names.
 * Search paths are explicit or manifest-evidenced; installed Python packages,
 * cwd/sys.path, build output and Python execution are not consulted. */
export class PythonResolver {
  readonly projects: PythonProject[] = [];
  private readonly files: ScannedFile[];
  private readonly indexes = new Map<string, Map<string, PythonModule[]>>();
  private readonly byFile = new Map<string, PythonModule[]>();
  private readonly ownership = new Map<string, PythonProject>();
  constructor(private readonly context: AnalysisContext, private readonly sources = context.sources ?? new IndexedSources(context)) {
    this.files = [...context.files.values()].filter(file => file.language === 'python' && file.analyzable).sort((a, b) => a.path.localeCompare(b.path, 'en'));
    const manifests = [...context.files.values()].filter(file => file.analyzable && /(?:^|\/)(?:pyproject\.toml|setup\.cfg|setup\.py|Pipfile|requirements[\w.-]*\.txt)$/.test(file.path) && (!TEST_PATH.test(file.path) || context.config.applications.some(app => app.path === path.posix.dirname(file.path))));
    const roots = new Set<string>(['.', ...manifests.map(file => path.posix.dirname(file.path)), ...context.config.applications.filter(app => app.ecosystems.includes('python') || this.files.some(file => file.application === app)).map(app => app.path)]);
    for (const root of [...roots].sort()) {
      if (!this.files.some(file => inside(file.path, root))) continue;
      const application = applicationAt(context.config.applications, root), manifest = manifests.find(file => path.posix.dirname(file.path) === root && file.path.endsWith('pyproject.toml')) ?? manifests.find(file => path.posix.dirname(file.path) === root);
      const project: PythonProject = { id: context.graph.id('project', 'python', root), root, ...(application ? { application } : {}), ...(manifest ? { manifest: manifest.path } : {}), sourceRoots: [], layout: 'inferred', gaps: [] };
      const gap = (code: string, reason: string, file = manifest?.path): void => { project.gaps.push(reason); this.issue(file, code, reason); };
      const add = (relative: string, explanation: string, source: Evidence['source'] = 'filesystem', declaration = manifest?.path): void => {
        if (path.posix.isAbsolute(relative) || /^[A-Za-z]:/.test(relative) || relative.includes('\\') || relative.includes('\0')) { this.issue(manifest?.path, 'excluded-python-source-root', `Unsupported source root: ${relative}`); return; }
        const location = path.posix.normalize(path.posix.join(root, relative));
        if (location === '..' || location.startsWith('../')) { this.issue(manifest?.path, 'excluded-python-source-root', `Source root escapes the repository: ${relative}`); return; }
        if (!this.files.some(file => inside(file.path, location))) { this.issue(manifest?.path, 'excluded-python-source-root', `Source root has no indexed Python inputs: ${location}`); return; }
        if (!project.sourceRoots.some(item => item.path === location)) project.sourceRoots.push({ path: location, proof: evidence(source, 'python-resolver', source === 'framework' ? undefined : declaration, undefined, explanation) });
      };
      const configured = application?.path === root ? application.sourceRoots?.python : undefined;
      if (configured) {
        project.layout = 'configured';
        for (const location of configured) add(location, `Configured Python source root relative to ${root}: ${location}`, 'framework');
      }
      else {
        let declaredRoots = false;
        const manifestRoot = (location: string, reason: string, declaration = manifest?.path): void => { declaredRoots = true; add(location, reason, 'filesystem', declaration); };
        if (manifest?.path.endsWith('pyproject.toml')) {
          try {
            const value = record(parseToml(this.sources.readText(manifest.path))), tool = record(value.tool), setuptools = record(tool.setuptools), packageDir = record(setuptools['package-dir']);
            if (typeof packageDir[''] === 'string') manifestRoot(packageDir[''], 'Literal setuptools package-dir source root');
            if (Object.keys(packageDir).some(key => key !== '')) { declaredRoots = true; gap('unsupported-python-package-map', 'Named setuptools package-dir mappings require a package-specific root profile'); }
            const where = record(record(setuptools.packages).find).where;
            if (Array.isArray(where)) for (const location of where) if (typeof location === 'string') manifestRoot(location, 'Literal setuptools packages.find.where source root');
            const packages = record(tool.poetry).packages;
            if (Array.isArray(packages)) for (const item of packages) if (typeof record(item).from === 'string') manifestRoot(record(item).from as string, 'Literal Poetry package source root'); else if (typeof record(item).include === 'string') manifestRoot('.', 'Literal Poetry flat package source root');
            const hatchPackages = record(record(record(record(tool.hatch).build).targets).wheel).packages;
            if (Array.isArray(hatchPackages)) for (const location of hatchPackages) if (typeof location === 'string') {
              if (/[*?{}[\]]/.test(location)) { declaredRoots = true; gap('unsupported-python-package-map', 'Hatch package patterns require a literal source-root profile'); }
              else manifestRoot(path.posix.dirname(location), 'Literal Hatch wheel package source parent');
            }
          } catch { declaredRoots = true; gap('python-project-config-error', 'Cannot read static pyproject source roots'); }
        }
        if (!declaredRoots) {
          const setup = manifests.find(file => path.posix.dirname(file.path) === root && file.path.endsWith('setup.cfg'));
          if (setup) try {
            const section = /^\[options\][ \t]*\r?\n([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(this.sources.readText(setup.path))?.[1] ?? '';
            const block = /^package_dir[ \t]*=[ \t]*\r?\n((?:[ \t]+[^\r\n]*(?:\r?\n|$))*)/m.exec(section)?.[1] ?? '';
            const match = /^[ \t]*=[ \t]*([^\r\n]+)/m.exec(block);
            if (match) manifestRoot(match[1]!.trim(), 'Literal setup.cfg package_dir source root', setup.path);
            else if (/^package_dir\s*=/m.test(section)) { declaredRoots = true; gap('unsupported-python-package-map', 'setup.cfg package_dir is outside the static empty-key mapping subset', setup.path); }
            if (block.split(/\r?\n/).some(line => !/^[ \t]*(?:#|;)/.test(line) && /^[ \t]*[^\s=][^=]*=/.test(line))) { declaredRoots = true; gap('unsupported-python-package-map', 'Named setup.cfg package_dir mappings require a package-specific root profile', setup.path); }
          } catch { declaredRoots = true; gap('python-project-config-error', 'Cannot read static setup.cfg source roots', setup.path); }
        }
        if (declaredRoots) project.layout = 'manifest';
        else {
          const setup = manifests.find(file => path.posix.dirname(file.path) === root && file.path.endsWith('setup.py'));
          if (setup) gap('python-executable-project-config', 'Executable setup.py is not evaluated; configure sourceRoots.python or provide a literal packaging root', setup.path);
          // Disjoint conventional roots give src files their installed import
          // names. Duplicate names across roots remain ambiguous: runtime
          // sys.path order is not inferred from the analyzer's working directory.
          add('.', 'Static Python project directory source root');
          if (this.files.some(file => inside(file.path, path.posix.join(root, 'src')))) add('src', 'Conventional src layout source root; source-path assumption is recorded', 'heuristic');
        }
      }
      this.projects.push(project);
    }
    this.projects.sort((a, b) => (b.root === '.' ? 0 : b.root.length) - (a.root === '.' ? 0 : a.root.length));
    for (const project of this.projects) {
      const index = this.index(project); this.indexes.set(project.id, index);
      for (const modules of index.values()) for (const module of modules) if (module.file && this.owner(module.file.path) === project) {
        const list = this.byFile.get(module.file.path) ?? []; list.push(module); this.byFile.set(module.file.path, list);
      }
    }
  }
  private issue(file: string | undefined, code: string, reason: string): void { this.context.graph.diagnose({ analyzer: 'python-resolver', severity: 'warning', code, ...(file ? { file, entityId: this.context.files.get(file)?.id } : {}), reason }); }
  owner(file: string): PythonProject | undefined { const previous = this.ownership.get(file); if (previous) return previous; const project = this.projects.find(project => inside(file, project.root)); if (project) this.ownership.set(file, project); return project; }
  modulesFor(file: string): PythonModule[] { return this.byFile.get(file) ?? []; }
  private index(project: PythonProject): Map<string, PythonModule[]> {
    const index = new Map<string, PythonModule[]>();
    const put = (module: PythonModule): void => {
      if (!module.name || !module.name.split('.').every(identifier)) return;
      const list = index.get(module.name) ?? [];
      if (!list.some(item => item.file?.path === module.file?.path && item.directory === module.directory)) list.push(module);
      index.set(module.name, list);
    };
    for (const root of project.sourceRoots) for (const file of this.context.files.values()) {
      if (file.language !== 'python') continue;
      if (!inside(file.path, root.path)) continue;
      if (!file.path.endsWith('.py')) continue; // .pyi is type input; .pyw launch semantics require a profile.
      if (project.layout === 'inferred' && project.sourceRoots.some(other => other.path !== root.path && inside(other.path, root.path) && inside(file.path, other.path))) continue;
      // Explicit shared roots may cross project boundaries. Inferred roots
      // cannot consume nested applications/projects as their own modules.
      if (this.owner(file.path) !== project && !(project.application?.sourceRoots?.python && root.proof.source === 'framework') && !(project.layout === 'manifest' && !inside(root.path, project.root))) continue;
      const relative = path.posix.relative(root.path, file.path), parts = relative.replace(/\.py$/, '').split('/'), isPackage = parts.at(-1) === '__init__';
      if (isPackage) parts.pop();
      const name = parts.join('.');
      const proof = [root.proof, evidence('filesystem', 'python-resolver', file.path, undefined, `Indexed Python ${isPackage ? 'package initializer' : 'module'} ${name}`)];
      put({ name, file, directory: path.posix.dirname(file.path), package: isPackage, namespace: false, root: root.path, proof, ...(!file.analyzable ? { excluded: true as const } : {}) });
      for (let i = 1; i < parts.length + (isPackage ? 1 : 0); i++) {
        const packageName = parts.slice(0, i).join('.'), directory = path.posix.join(root.path, ...parts.slice(0, i)), initializer = this.context.files.get(path.posix.join(directory, '__init__.py'));
        if (initializer && !initializer.analyzable) put({ name: packageName, file: initializer, directory, package: true, namespace: false, excluded: true, root: root.path, proof: [root.proof, evidence('filesystem', 'python-resolver', initializer.path, undefined, 'Known package initializer is not a readable indexed input')] });
        else if (!initializer) put({ name: packageName, directory, package: true, namespace: true, root: root.path, proof: [root.proof, evidence('filesystem', 'python-resolver', file.path, undefined, `Indexed namespace package portion ${packageName} at ${directory}`)] });
      }
    }
    return index;
  }
  resolve(importer: string, specifier: string): PythonModuleOutcome {
    const input = this.context.files.get(importer);
    if (!input?.analyzable || input.language !== 'python' || !importer.endsWith('.py')) return { status: 'excluded', reason: 'Importing file is not an indexed Python runtime input' };
    const project = this.owner(importer);
    if (!project) return { status: 'excluded', reason: 'No Python source project owns the importing file' };
    if (!project.sourceRoots.length) return { status: 'unsupported', reason: 'Static Python source roots are unavailable; conventional fallback is not used after an explicit root failure' };
    if (project.gaps.length) return { status: 'unsupported', reason: `Python source-root profile is incomplete: ${project.gaps.join('; ')}` };
    const dots = /^\.+/.exec(specifier)?.[0].length ?? 0;
    if (dots && this.context.syntax?.get(importer)?.facts.python?.writes.some(write => !write.scope && write.name === '__package__')) return { status: 'unsupported', reason: 'Relative import package context is assigned at runtime' };
    if (specifier.slice(dots) && !specifier.slice(dots).split('.').every(identifier)) return { status: 'unsupported', reason: 'Import specifier is outside static dotted module syntax' };
    if (!dots && ['sys', 'builtins'].includes(specifier)) return { status: 'external', reason: 'Python interpreter builtin module; repository files do not replace the builtin finder' };
    let names = [specifier];
    let relativePackage: { name: string; directory: string }[] = [];
    if (dots) {
      const contexts = this.modulesFor(importer);
      const parents = contexts.map(module => module.package ? module.name : module.name.split('.').slice(0, -1).join('.'));
      if (!parents.length || parents.some(parent => parent.split('.').filter(Boolean).length < dots)) return { status: 'unresolved', reason: 'Relative import climbs above the known package or the importer has no package context' };
      names = [...new Set(parents.map(parent => [...parent.split('.').slice(0, parent.split('.').length - dots + 1), ...specifier.slice(dots).split('.').filter(Boolean)].join('.')))];
      if (names.length !== 1) return { status: 'ambiguous', candidates: this.modulesFor(importer), reason: 'Source roots give the importing file multiple package names' };
      relativePackage = contexts.map((module, i) => {
        let directory = module.directory;
        for (let level = 1; level < dots; level++) directory = path.posix.dirname(directory);
        return { name: parents[i]!.split('.').slice(0, parents[i]!.split('.').length - dots + 1).join('.'), directory };
      });
    }
    if (!names[0] || !names[0].split('.').every(identifier)) return { status: 'unsupported', reason: 'Import specifier is outside static dotted module syntax' };
    const index = this.indexes.get(project.id)!, parts = names[0].split('.');
    const parents: PythonModule[] = [];
    let modules: PythonModule[] = [];
    for (let i = 0; i < parts.length; i++) {
      const name = parts.slice(0, i + 1).join('.');
      let candidates = index.get(name) ?? [];
      if (relativePackage.some(parent => name === parent.name || parent.name.startsWith(`${name}.`))) {
        const directories = relativePackage.map(parent => {
          let directory = parent.directory;
          for (let depth = name.split('.').length; depth < parent.name.split('.').length; depth++) directory = path.posix.dirname(directory);
          return directory;
        });
        const anchored = candidates.filter(candidate => !candidate.namespace && candidate.package && directories.includes(candidate.directory));
        if (anchored.length) candidates = anchored;
        else if (candidates.some(candidate => !candidate.namespace)) return { status: 'unresolved', reason: 'Known importing package does not belong to the regular package search path' };
        // Namespace parents retain all portions; the importer may legitimately
        // import a sibling from another physical portion of the same package.
      }
      if (i) {
        if (modules.some(parent => parent.file && this.context.syntax?.get(parent.file.path)?.facts.python?.writes.some(write => !write.scope && (write.name === '__path__' || write.name.startsWith('__path__.'))))) return { status: 'unsupported', reason: 'Parent package search path is assigned at runtime' };
        if (modules.some(parent => parent.file && this.context.syntax?.get(parent.file.path)?.facts.python?.calls.some(call => !call.scope && /^__path__\.(?:append|insert|extend|clear|pop|remove|sort|reverse)$/.test(call.callee)))) return { status: 'unsupported', reason: 'Parent package search path is mutated at runtime' };
        candidates = candidates.filter(candidate => modules.some(parent => parent.package && (candidate.package ? candidate.directory === path.posix.join(parent.directory, parts[i]!) : candidate.directory === parent.directory)));
      }
      if (!candidates.length) return { status: !i && !dots ? 'external' : 'unresolved', reason: !i && !dots ? 'No eligible indexed module satisfies this absolute import' : 'No indexed module satisfies the known parent package search path' };
      // FileFinder checks a regular package before a same-named .py file in
      // each root. Across roots, choosing an order requires runtime evidence.
      const concrete = candidates.filter(module => !module.namespace).filter(module => module.package || !candidates.some(other => !other.namespace && other.package && other.root === module.root));
      if (concrete.length > 1) return { status: 'ambiguous', candidates: concrete, reason: `Multiple source roots provide ${name}; runtime search order is not established` };
      if (concrete.some(module => module.excluded)) return { status: 'excluded', reason: 'A known module/package initializer is not an analyzable indexed input; it cannot be treated as an external dependency or namespace portion' };
      if (i) parents.push(...modules);
      modules = concrete.length ? concrete : candidates.filter(module => module.namespace);
    }
    return { status: 'resolved', modules, parents, proof: [...parents, ...modules].flatMap(module => module.proof) };
  }
  describe(): unknown[] {
    return this.projects.map(project => ({ id: project.id, ecosystem: 'python', root: project.root, ...(project.application ? { application: project.application.name } : {}), ...(project.manifest ? { manifest: project.manifest } : {}), layout: project.layout, sourceRoots: project.sourceRoots.map(root => root.path), ...(project.gaps.length ? { gaps: project.gaps } : {}) }));
  }
}
