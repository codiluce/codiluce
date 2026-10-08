import path from 'node:path';
import { satisfies, valid, validRange } from 'semver';
import type { AnalysisContext, Analyzer, ScannedFile } from '../core/analyzer.js';
import { applicationAt, matchesGlob, type ApplicationConfig } from '../core/config.js';
import { ANALYZER_VERSION, evidence, type Evidence } from '../core/graph.js';
import { nodeWorkspacePatterns } from '../core/workspaces.js';
import { IndexedSources } from './indexed-sources.js';

export interface NodeProject {
  id: string; root: string; name: string; application?: ApplicationConfig;
  manifest?: string; packageName?: string; packageVersion?: string;
  workspaceRoots: string[]; sourceRoots: string[]; references: string[];
  dependencies: Record<string, string>;
}
export type PackageBinding = { status: 'resolved'; project: NodeProject; proof: Evidence[] }
  | { status: 'ambiguous'; candidates: NodeProject[]; reason: string }
  | { status: 'external' | 'excluded' | 'unsupported'; reason: string };
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const TEST_PATH = /(?:^|\/)(?:tests?|__tests__|spec|fixtures|__fixtures__|testdata)(?:\/|$)/;
export const PROJECT_VERSION = `${ANALYZER_VERSION}:node-projects:1`;

/** Static project ownership and workspace dependency evidence. A project is
 * a compilation/package boundary; it need not be a runtime application. */
export class ProjectCatalog {
  readonly node: NodeProject[] = [];
  private readonly packageNames = new Map<string, NodeProject[]>();
  private readonly ownership = new Map<string, NodeProject>();
  private ownershipOrder: NodeProject[] = [];
  constructor(private readonly context: AnalysisContext, readonly sources: IndexedSources) {
    const manifests = new Map<string, { file: string; value: Record<string, unknown> }>();
    const workspaces: { root: string; include: string[]; exclude: string[] }[] = [];
    for (const file of [...context.files.values()].sort((a, b) => a.path.localeCompare(b.path, 'en'))) {
      const name = path.posix.basename(file.path);
      if (!file.analyzable || !['package.json', 'pnpm-workspace.yaml'].includes(name) || TEST_PATH.test(file.path) && !context.config.applications.some(app => app.path === path.posix.dirname(file.path))) continue;
      const text = sources.readFile(file.absolutePath);
      if (text === undefined) continue;
      const patterns = nodeWorkspacePatterns(name, text), root = path.posix.dirname(file.path);
      for (const reason of patterns.issues) context.graph.diagnose({ analyzer: 'project-model', severity: 'warning', code: 'unsupported-workspace', file: file.path, entityId: file.id, reason });
      for (const pattern of [...patterns.include, ...patterns.exclude]) {
        const normalized = path.posix.normalize(path.posix.join(root, pattern));
        if (normalized === '..' || normalized.startsWith('../')) context.graph.diagnose({ analyzer: 'project-model', severity: 'warning', code: 'excluded-workspace-member', file: file.path, entityId: file.id, reason: `Workspace path escapes the repository: ${pattern}` });
      }
      if (patterns.include.length) workspaces.push({ root, include: patterns.include, exclude: patterns.exclude });
      if (name === 'package.json') {
        try { manifests.set(root, { file: file.path, value: record(JSON.parse(text)) }); }
        catch { context.graph.diagnose({ analyzer: 'project-model', severity: 'warning', code: 'invalid-project-manifest', file: file.path, entityId: file.id, reason: 'Cannot parse indexed package.json' }); }
      }
    }
    const membership = (root: string) => [...new Set(workspaces.filter(workspace => {
      if (root === workspace.root) return true;
      const relative = path.posix.relative(workspace.root, root);
      return workspace.include.some(pattern => matchesGlob(relative, pattern)) && !workspace.exclude.some(pattern => matchesGlob(relative, pattern));
    }).map(workspace => workspace.root))].sort();
    const roots = new Set(context.config.applications.map(app => app.path));
    for (const [root] of manifests) if (!applicationAt(context.config.applications, root) || membership(root).length) roots.add(root);
    // A declared file/link dependency is a package boundary even inside a
    // directory otherwise owned by an application.
    for (const [root, manifest] of manifests) for (const key of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) for (const value of Object.values(record(manifest.value[key]))) {
      if (typeof value !== 'string' || !/^(?:file|link):/.test(value)) continue;
      const local = value.slice(value.indexOf(':') + 1);
      if (path.posix.isAbsolute(local) || /^[A-Za-z]:/.test(local)) continue;
      const target = path.posix.normalize(path.posix.join(root, local));
      if (target !== '..' && !target.startsWith('../') && manifests.has(target)) roots.add(target);
    }
    roots.add('.');
    for (const root of [...roots].sort()) {
      const app = context.config.applications.find(app => app.path === root), manifest = manifests.get(root);
      const packageName = typeof manifest?.value.name === 'string' ? manifest.value.name : undefined;
      const dependencies = Object.fromEntries(['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].flatMap(key => Object.entries(record(manifest?.value[key]))).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
      const project: NodeProject = {
        id: context.graph.id('project', 'node', app?.name ?? root), root, name: app?.name ?? packageName ?? (root === '.' ? context.config.repository.name : root),
        ...(app ? { application: app } : {}), ...(manifest ? { manifest: manifest.file } : {}), ...(packageName ? { packageName } : {}),
        ...(typeof manifest?.value.version === 'string' ? { packageVersion: manifest.value.version } : {}),
        workspaceRoots: membership(root), sourceRoots: [root], references: [], dependencies,
      };
      this.node.push(project);
      if (packageName) { const list = this.packageNames.get(packageName) ?? []; list.push(project); this.packageNames.set(packageName, list); }
    }
    this.ownershipOrder = [...this.node].sort((a, b) => (b.root === '.' ? 0 : b.root.length) - (a.root === '.' ? 0 : a.root.length) || a.id.localeCompare(b.id));
  }
  nodeOwner(relative: string): NodeProject {
    let owner = this.ownership.get(relative);
    if (!owner) { owner = this.ownershipOrder.find(project => project.root === '.' || relative === project.root || relative.startsWith(`${project.root}/`))!; this.ownership.set(relative, owner); }
    return owner;
  }
  nodeFiles(project: NodeProject): ScannedFile[] {
    return [...this.context.files.values()].filter(file => file.analyzable && ['typescript', 'javascript'].includes(file.language ?? '') && this.nodeOwner(file.path) === project).sort((a, b) => a.path.localeCompare(b.path, 'en'));
  }
  packageBinding(importer: NodeProject, name: string): PackageBinding {
    if (!/^(?:@[a-zA-Z0-9_.-]+\/)?[a-zA-Z0-9_.-]+$/.test(name)) return { status: 'unsupported', reason: `Unsupported package name: ${name}` };
    const proof = (target: NodeProject, explanation: string): Evidence[] => [
      evidence('filesystem', 'project-model', importer.manifest, undefined, explanation),
      evidence('filesystem', 'project-model', target.manifest, undefined, `Indexed local package ${target.packageName ?? name} at ${target.root}`),
    ];
    if (importer.packageName === name) return { status: 'resolved', project: importer, proof: proof(importer, 'Package self-reference by its declared name') };
    const specifier = importer.dependencies[name];
    if (!specifier) return { status: 'external', reason: 'No declared local dependency for this package' };
    if (/^(?:file|link):/.test(specifier)) {
      const local = specifier.slice(specifier.indexOf(':') + 1);
      if (path.posix.isAbsolute(local) || /^[A-Za-z]:/.test(local)) return { status: 'excluded', reason: 'Absolute local dependency paths are outside the repository-relative resolution contract' };
      const root = path.posix.normalize(path.posix.join(importer.root, local));
      if (root === '..' || root.startsWith('../') || path.posix.isAbsolute(root)) return { status: 'excluded', reason: 'Local dependency path escapes the indexed repository' };
      const target = this.node.find(project => project.root === root);
      return target ? { status: 'resolved', project: target, proof: proof(target, `Declared local dependency ${name}: ${specifier}`) } : { status: 'excluded', reason: `Local dependency project is not indexed: ${root}` };
    }
    const candidates = (this.packageNames.get(name) ?? []).filter(project => project.workspaceRoots.some(root => importer.workspaceRoots.includes(root)));
    if (candidates.length > 1) return { status: 'ambiguous', candidates, reason: 'Multiple indexed workspace packages declare the same name' };
    const target = candidates[0];
    if (!target) return { status: specifier.startsWith('workspace:') ? 'excluded' : 'external', reason: 'No eligible indexed package in this workspace' };
    const range = specifier.replace(/^workspace:/, '');
    const explicit = specifier.startsWith('workspace:');
    const compatible = explicit && ['*', '^', '~'].includes(range) || range === '*' || !!target.packageVersion && !!valid(target.packageVersion) && !!validRange(range) && satisfies(target.packageVersion, range);
    if (!compatible) return { status: explicit ? 'unsupported' : 'external', reason: `Local package version does not satisfy ${specifier}` };
    return { status: 'resolved', project: target, proof: proof(target, `Declared workspace dependency ${name}: ${specifier}`) };
  }
  describe(): unknown[] {
    return this.node.map(project => ({
      id: project.id, ecosystem: 'node', root: project.root, name: project.name, ...(project.application ? { application: project.application.name } : {}),
      ...(project.manifest ? { manifest: project.manifest } : {}), ...(project.packageName ? { package: project.packageName } : {}), ...(project.packageVersion ? { version: project.packageVersion } : {}),
      workspaces: project.workspaceRoots, sourceRoots: project.sourceRoots, references: project.references,
      dependencies: Object.entries(project.dependencies).sort(([a], [b]) => a.localeCompare(b)).map(([name, specifier]) => {
        const binding = this.packageBinding(project, name);
        return { name, specifier, status: binding.status, ...(binding.status === 'resolved' ? { target: binding.project.id } : binding.status === 'ambiguous' ? { candidates: binding.candidates.map(item => item.id) } : {}) };
      }),
    }));
  }
}

export const projectAnalyzer: Analyzer = {
  name: 'project-model', version: PROJECT_VERSION,
  async analyze(context): Promise<void> {
    context.sources = new IndexedSources(context);
    context.projects = new ProjectCatalog(context, context.sources);
    context.graph.entities.get(context.repositoryId)!.metadata.projects = context.projects.describe();
    for (const file of context.files.values()) if (['typescript', 'javascript', 'vue', 'svelte', 'astro'].includes(file.language ?? '')) context.graph.entities.get(file.id)!.metadata.project = context.projects.nodeOwner(file.path).id;
  },
};
