import path from 'node:path';
import type { AnalysisContext, ScannedFile } from '../../core/analyzer.js';
import { applicationAt, matchesGlob, type ApplicationConfig } from '../../core/config.js';
import { ANALYZER_VERSION, evidence, type Evidence } from '../../core/graph.js';
import type { RubyCallFact, RubyExpression, RubySyntaxFacts } from '../facts.js';
import { IndexedSources } from '../indexed-sources.js';

export const RUBY_RESOLVER_VERSION = `${ANALYZER_VERSION}:ruby-resolver:1`;
export interface RubyProject { id: string; root: string; application?: ApplicationConfig; manifests: string[]; loadPaths: { path: string; proof: Evidence }[]; cwd?: string }
export type RubyLoadKind = 'require' | 'require_relative' | 'load' | 'autoload';
export type RubyLoadOutcome =
  | { status: 'resolved'; target: ScannedFile; proof: Evidence[]; conditions: string[] }
  | { status: 'external'; dependency: string; proof: Evidence[]; conditions: string[] }
  | { status: 'ambiguous'; candidates: string[]; reason: string }
  | { status: 'unresolved' | 'unsupported' | 'excluded'; reason: string };
export interface RubyLoad { kind: RubyLoadKind; site: RubyCallFact; specifier?: string; constant?: string; wrapped: boolean; outcome: RubyLoadOutcome; conditions: string[] }
interface Value { path: string; absolute: boolean; proof: Evidence[] }
const LOADERS = new Set(['require', 'require_relative', 'load', 'autoload']);
const inside = (file: string, root: string) => root === '.' || file === root || file.startsWith(root + '/');
const relative = (value: string) => !path.posix.isAbsolute(value) && !/^[A-Za-z]:/.test(value) && !/[\\\0]/.test(value);

/** Source/configuration inputs only. Gem names do not invent require features;
 * neither the host cwd/load path nor installed gems/native code are consulted. */
export class RubyResolver {
  readonly projects: RubyProject[] = [];
  private readonly ownership = new Map<string, RubyProject>();
  private readonly loads = new Map<string, RubyLoad[]>();
  private readonly directories: Set<string | undefined>;
  private readonly scopes = new Map<string, Map<string, RubySyntaxFacts['scopes'][number]>>();
  constructor(private readonly context: AnalysisContext, private readonly sources = context.sources ?? new IndexedSources(context)) {
    this.directories = new Set([...context.graph.entities.values()].filter(entity => ['directory', 'application'].includes(entity.type)).map(entity => entity.path));
    const files = [...context.files.values()].filter(file => file.language === 'ruby');
    const manifests = files.filter(file => path.posix.basename(file.path) === 'Gemfile' || file.path.endsWith('.gemspec'));
    const roots = new Set(['.', ...manifests.map(file => path.posix.dirname(file.path)), ...context.config.applications.filter(app => app.ecosystems.includes('ruby') || files.some(file => file.application === app)).map(app => app.path)]);
    for (const root of [...roots].sort()) {
      if (!files.some(file => inside(file.path, root))) continue;
      const application = applicationAt(context.config.applications, root);
      const project: RubyProject = { id: context.graph.id('project', 'ruby', root), root, application, manifests: manifests.filter(file => path.posix.dirname(file.path) === root).map(file => file.path).sort(), loadPaths: [] };
      if (application?.path === root) {
        for (const value of application.sourceRoots?.ruby ?? []) {
          const directory = path.posix.normalize(path.posix.join(root, value));
          project.loadPaths.push({ path: directory, proof: this.proof(undefined, undefined, `Recorded Ruby load path ${directory}; order follows sourceRoots.ruby`, 'framework') });
        }
        if (application.ruby?.cwd !== undefined) project.cwd = path.posix.normalize(path.posix.join(root, application.ruby.cwd));
      }
      this.projects.push(project);
    }
    for (const file of files) {
      const project = this.projects.filter(project => inside(file.path, project.root)).sort((a, b) => b.root.length - a.root.length)[0];
      if (project) this.ownership.set(file.path, project);
    }
  }
  owner(file: string): RubyProject | undefined { return this.ownership.get(file); }
  describe(): Record<string, unknown>[] { return this.projects.map(project => ({ id: project.id, ecosystem: 'ruby', root: project.root, application: project.application?.name, manifests: project.manifests, sourceRoots: project.loadPaths.map(item => item.path), ...(project.cwd !== undefined ? { cwd: project.cwd } : {}), resolver: RUBY_RESOLVER_VERSION, gaps: ['Gem activation, executable gemspec/Gemfile, implicit installed load paths and Zeitwerk conventions require later profiles'] })); }
  private proof(file: string | undefined, line: number | undefined, explanation: string, source: Evidence['source'] = 'syntax'): Evidence { return { ...evidence(source, 'ruby-resolver', file, line, explanation), analyzerVersion: RUBY_RESOLVER_VERSION }; }
  facts(file: string): RubySyntaxFacts | undefined { return this.context.syntax?.get(file)?.facts.ruby; }
  ancestors(file: string, scope: string): RubySyntaxFacts['scopes'] { let index = this.scopes.get(file); if (!index) { index = new Map(this.facts(file)?.scopes.map(item => [item.key, item])); this.scopes.set(file, index); } const result: RubySyntaxFacts['scopes'] = [], seen = new Set<string>(); let current = index.get(scope); while (current && !seen.has(current.key)) { seen.add(current.key); result.push(current); current = current.parent ? index.get(current.parent) : undefined; } return result; }
  conditions(file: string, scope: string): string[] { return this.ancestors(file, scope).flatMap(item => [...item.conditional ? [`Conditional Ruby ${item.conditional}`] : [], ...item.deferred ? [`Ruby ${item.kind} body requires invocation proof`] : [], ...item.kind === 'singleton' ? ['Singleton-class loader/constant context is unresolved'] : []]); }
  private identity(file: string, site: RubyCallFact, method = site.expression.method): string | undefined {
    const facts = this.facts(file); if (!facts?.complete) return 'Complete Ruby syntax is required to establish loader identity';
    const scopes = this.ancestors(file, site.scope), receiver = site.expression.receiver;
    if (receiver && !(receiver.kind === 'constant' && ['Kernel', '::Kernel'].includes(receiver.name))) return 'Receiver-qualified Ruby loader identity is unresolved';
    if (receiver && facts.gaps.some(gap => gap.kind === 'constants')) return 'Ruby constant mutation can change the Kernel loader namespace';
    if (facts.definitions.some(def => ['class', 'module'].includes(def.kind) && def.name.replace(/^::/, '') === 'Kernel') || facts.assignments.some(item => item.target.kind === 'constant' && item.target.name.replace(/^::/, '') === 'Kernel')) return 'Indexed Kernel constant shadows the standard loader namespace';
    if (facts.definitions.some(def => def.kind === 'singleton_method' && def.receiver?.kind === 'constant' && ['Kernel', '::Kernel'].includes(def.receiver.name) && def.name === method)) return 'Indexed Kernel singleton method replaces standard loader identity';
    if (facts.gaps.some(gap => gap.kind === 'loader' || gap.kind === 'scope' && scopes.some(scope => scope.key === gap.scope))) return 'Ruby method mutation/opaque scope can replace loader identity';
    if (!receiver) {
      if (facts.definitions.some(def => def.name === method && (this.ancestors(file, def.scope).every(item => !['class', 'module'].includes(item.kind)) || scopes.some(scope => scope.key === def.scope)))) return `Indexed ${method} method shadows the implicit Ruby loader`;
      if (scopes.some(scope => ['class', 'module'].includes(scope.kind) && facts.definitions.some(def => def.bodyScope === scope.key && def.superclass))) return 'Inherited Ruby loader identity requires a superclass method summary';
      if (facts.calls.some(call => ['include', 'prepend', 'extend'].includes(call.expression.method) && scopes.some(scope => scope.key === call.scope))) return 'Ruby mixins can replace implicit loader identity';
    }
    return;
  }
  private fileGlobal(file: string, name: string): boolean { return !!this.facts(file)?.definitions.some(def => ['class', 'module'].includes(def.kind) && def.name.replace(/^::/, '') === name) || !!this.facts(file)?.assignments.some(item => item.target.kind === 'constant' && item.target.name.replace(/^::/, '') === name); }
  private value(file: string, expression: RubyExpression, depth = 0): Value | undefined {
    if (depth > 32) return;
    if (expression.kind === 'literal' && typeof expression.value === 'string') return { path: expression.value, absolute: false, proof: [] };
    if (expression.kind === 'identifier' && ['__dir__', '__FILE__'].includes(expression.name)) {
      if (expression.name === '__dir__' && (this.facts(file)?.definitions.some(def => def.name === '__dir__') || this.facts(file)?.assignments.some(item => item.target.kind === 'identifier' && item.target.name === '__dir__'))) return;
      return { path: expression.name === '__dir__' ? path.posix.dirname(file) : file, absolute: true, proof: [this.proof(file, expression.range.startLine, `Original Ruby ${expression.name} source path${expression.name === '__FILE__' ? '; launch filename spelling and cwd require runtime proof' : ''}`)] };
    }
    if (expression.kind !== 'call' || expression.receiver?.kind !== 'constant' || !['File', '::File'].includes(expression.receiver.name) || this.fileGlobal(file, 'File')) return;
    if (this.facts(file)?.gaps.some(gap => gap.kind === 'constants' || gap.kind === 'loader')) return;
    if (this.facts(file)?.definitions.some(def => def.kind === 'singleton_method' && def.receiver?.kind === 'constant' && ['File', '::File'].includes(def.receiver.name) && def.name === expression.method)) return;
    const values = expression.args.map(arg => this.value(file, arg, depth + 1)); if (values.some(value => !value)) return;
    const parts = values as Value[], proof = [...parts.flatMap(value => value.proof), this.proof(file, expression.range.startLine, `Bounded standard File.${expression.method} path expression`)];
    if (expression.method === 'dirname' && parts.length === 1) return { path: path.posix.dirname(parts[0]!.path), absolute: parts[0]!.absolute, proof };
    if (expression.method === 'join' && parts.length && parts.slice(1).every(value => !value.absolute && relative(value.path))) return { path: path.posix.join(...parts.map(value => value.path)), absolute: parts[0]!.absolute, proof };
    if (expression.method === 'expand_path' && parts.length >= 1 && parts.length <= 2) {
      const first = parts[0]!; if (first.absolute) return { ...first, proof };
      if (!relative(first.path) || first.path.startsWith('~')) return;
      const project = this.owner(file), base = parts[1] ?? (project?.cwd !== undefined ? { path: project.cwd, absolute: true, proof: [this.proof(undefined, undefined, `Recorded Ruby cwd ${project.cwd}`, 'framework')] } : undefined);
      if (!base) return;
      const prefix = base.absolute ? base.path : project?.cwd !== undefined && relative(base.path) ? path.posix.join(project.cwd, base.path) : undefined;
      if (prefix === undefined) return;
      return { path: path.posix.normalize(path.posix.join(prefix, first.path)), absolute: true, proof: [...proof, ...base.proof] };
    }
    return;
  }
  private candidate(file: string): { file?: ScannedFile; denied?: string } {
    if (!relative(file) || file === '..' || file.startsWith('../')) return { denied: 'Ruby load target escapes the indexed repository' };
    if (this.context.config.ignore.some(pattern => matchesGlob(file, pattern) || matchesGlob(path.posix.dirname(file), pattern))) return { denied: `Ruby load target is excluded by an ignore rule: ${file}` };
    const target = this.context.files.get(file);
    if (!target && this.context.fileInventory?.has(file)) return { denied: `Observed Ruby feature is excluded or symlinked: ${file}` };
    for (let directory = file; directory !== '.'; directory = path.posix.dirname(directory)) if (this.context.directoryInventory?.has(directory) && !this.directories.has(directory)) return { denied: `Ruby feature crosses an unindexed directory or symlink boundary: ${directory}` };
    if (target && (!target.analyzable || !this.sources.fileExists(file))) return { denied: `Ruby load target is not an indexed readable source: ${file}` };
    if (target && target.language !== 'ruby') return { denied: `Ruby loading of this extension needs a source/parser profile: ${file}` };
    if (target && this.sources.readFile(file) === undefined) return { denied: this.sources.failures.get(file) ?? `Ruby load target became unavailable: ${file}` };
    return { file: target };
  }
  resolve(file: string, kind: RubyLoadKind, value: string, absolute = false, extraProof: Evidence[] = []): RubyLoadOutcome {
    if (!value || !relative(value) || value.startsWith('~')) return { status: 'excluded', reason: 'Ruby load path is empty, absolute, nonportable or outside recorded inputs' };
    if (/\.(?:so|o|bundle|dll|dylib)$/i.test(value)) return { status: 'unsupported', reason: 'Native Ruby extension loading is not executed or guessed' };
    const project = this.owner(file), proof = [...extraProof]; let roots: { path: string; proof?: Evidence }[];
    if (absolute) roots = [{ path: '.' }];
    else if (kind === 'require_relative') roots = [{ path: path.posix.dirname(file), proof: this.proof(file, undefined, 'require_relative selects the original calling file directory') }];
    else if (/^\.{1,2}\//.test(value)) {
      if (project?.cwd === undefined) return { status: 'unsupported', reason: 'Explicit relative require/load needs a recorded Ruby cwd; it is not relative to the source file' };
      roots = [{ path: project.cwd, proof: this.proof(undefined, undefined, `Recorded Ruby cwd ${project.cwd}`, 'framework') }];
    } else {
      if (!project?.loadPaths.length) return { status: 'unsupported', reason: 'Bare Ruby features need recorded ordered sourceRoots.ruby load paths; installed gems and host paths are unknown' };
      roots = project.loadPaths;
      if (kind === 'load' && project.cwd !== undefined) roots = [...roots, { path: project.cwd, proof: this.proof(undefined, undefined, 'Ruby load falls back to recorded cwd after its load paths', 'framework') }];
    }
    const feature = kind === 'load' || value.endsWith('.rb') ? value : value + '.rb';
    for (const root of roots) {
      const requested = path.posix.normalize(path.posix.join(root.path, feature)), result = this.candidate(requested);
      if (result.denied) return { status: 'excluded', reason: result.denied };
      if (result.file) return { status: 'resolved', target: result.file, conditions: [], proof: [...proof, ...root.proof ? [root.proof] : [], this.proof(result.file.path, undefined, `Indexed ${kind} feature ${value}`, 'filesystem')] };
    }
    // Ruby searches its source suffix across all load paths before native
    // suffixes, so a native file on an earlier root cannot hide a later .rb.
    if (kind !== 'load' && !value.endsWith('.rb') && roots.some(root => ['.so', '.bundle', '.dll'].some(ext => this.context.fileInventory?.has(path.posix.join(root.path, value + ext))))) return { status: 'unsupported', reason: 'Observed native Ruby feature requires a platform/extension profile' };
    return kind === 'require_relative' || absolute || /^\.{1,2}\//.test(value) || kind === 'load' ? { status: 'unresolved', reason: `No indexed Ruby load target for ${value}` } : { status: 'external', dependency: value, conditions: [], proof: [...proof, this.proof(undefined, undefined, 'No matching indexed feature on the recorded Ruby load paths; external feature identity is not a gem-name mapping', 'filesystem')] };
  }
  fileLoads(file: string): RubyLoad[] {
    const cached = this.loads.get(file); if (cached) return cached;
    const facts = this.facts(file), result: RubyLoad[] = [];
    for (const site of facts?.calls ?? []) {
      const kind = site.expression.method as RubyLoadKind; if (!LOADERS.has(kind)) continue;
      const args = site.expression.args, argument = args[kind === 'autoload' ? 1 : 0], value = argument ? this.value(file, argument) : undefined;
      const name = kind === 'autoload' && (args[0]?.kind === 'symbol' ? args[0].name : args[0]?.kind === 'literal' && typeof args[0].value === 'string' ? args[0].value : undefined);
      const constant = typeof name === 'string' && /^\p{Lu}[\p{ID_Continue}]*$/u.test(name) ? name : undefined;
      const conditions = this.conditions(file, site.scope), wrap = kind === 'load' ? args[1] : undefined;
      const wrapped = !!wrap && !(wrap.kind === 'literal' && (wrap.value === false || wrap.value === null));
      if (wrapped) conditions.push('Wrapped Ruby load uses an isolated or explicit module namespace');
      if (kind === 'load') conditions.push('Ruby load re-executes source; runtime ordering and mutations need a summary');
      let reason = this.identity(file, site);
      if (!reason && (args.length !== (kind === 'autoload' ? 2 : kind === 'load' && args.length === 2 ? 2 : 1) || site.blockScope)) reason = 'Expanded, block or mismatched Ruby loader arguments are unsupported';
      if (!reason && kind === 'autoload' && !constant) reason = 'Ruby autoload requires a literal valid constant name';
      if (!reason && !value) reason = 'Dynamic or unsupported Ruby load path expression';
      if (!reason && facts?.gaps.some(gap => gap.kind === 'path') && kind !== 'require_relative' && !value?.absolute) reason = 'Ruby load-path/loaded-feature mutation prevents static feature selection';
      if (!reason && facts?.gaps.some(gap => gap.kind === 'path') && value?.proof.some(fact => fact.explanation?.includes('Recorded Ruby cwd'))) reason = 'Ruby working-directory mutation invalidates a cwd-dependent path expression';
      if (facts?.gaps.some(gap => gap.kind === 'path')) conditions.push('Ruby path/loaded-feature state is mutable; source initialization needs a summary');
      if (value?.proof.some(fact => fact.explanation?.includes('launch filename spelling'))) conditions.push('Ruby __FILE__ path depends on launch filename spelling and runtime cwd');
      const outcome: RubyLoadOutcome = reason ? { status: 'unsupported', reason } : this.resolve(file, kind, value!.path, value!.absolute, value!.proof);
      result.push({ kind, site, specifier: value?.path, ...(constant ? { constant } : {}), wrapped, outcome, conditions });
    }
    this.loads.set(file, result); return result;
  }
  /** Refine known earlier source loads before emitting edges. Imported source
   * can change Kernel/File or path state; cycles retain initialization gaps. */
  prepare(files: ScannedFile[]): void {
    const initial = new Map(files.map(file => [file.path, this.fileLoads(file.path).map(load => ({ ...load, conditions: [...load.conditions] }))]));
    for (const file of files) for (const load of this.fileLoads(file.path)) {
      if (!['resolved', 'external'].includes(load.outcome.status)) continue;
      const dependencies = new Set<string>(), visited = new Set<string>(), active = new Set<string>(); let steps = 0, cycle = false, limited = false;
      const callerScopes = new Set(this.ancestors(file.path, load.site.scope).map(scope => scope.key));
      const visit = (unit: string, limit: number, depth: number): void => {
        if (++steps > 100_000 || depth > 128) { limited = true; return; }
        if (active.has(unit)) { cycle = true; return; }
        const key = `${unit}:${limit}`; if (visited.has(key)) return; visited.add(key); active.add(unit);
        for (const prior of initial.get(unit) ?? []) {
          if (prior.site.start >= limit || !['require', 'require_relative', 'load'].includes(prior.kind) || prior.wrapped) continue;
          const deferred = this.ancestors(unit, prior.site.scope).filter(scope => scope.deferred);
          if (deferred.length && (unit !== file.path || deferred.some(scope => !callerScopes.has(scope.key)))) continue;
          if (prior.outcome.status === 'external') { load.conditions.push('Earlier external Ruby feature requires a reviewed startup/method summary'); continue; }
          if (prior.outcome.status !== 'resolved') { load.conditions.push('Earlier Ruby load has an unresolved source/startup boundary'); continue; }
          dependencies.add(prior.outcome.target.path); visit(prior.outcome.target.path, Infinity, depth + 1);
        }
        active.delete(unit);
      };
      visit(file.path, load.site.start, 0);
      const earlier = new Set(dependencies);
      if (load.outcome.status === 'resolved' && load.kind !== 'autoload' && !load.wrapped) visit(load.outcome.target.path, Infinity, 0);
      dependencies.clear(); for (const dependency of earlier) dependencies.add(dependency);
      if (cycle) load.conditions.push('Cyclic Ruby loads require a partial-initialization summary');
      let reason = limited ? 'Ruby source-load summary reached its traversal budget' : undefined;
      for (const dependency of dependencies) {
        const facts = this.facts(dependency); if (!facts?.complete) { reason ??= 'Earlier Ruby source load has incomplete syntax'; continue; }
        if (facts.gaps.some(gap => gap.kind === 'loader')) reason ??= 'Earlier Ruby source load can change loader method identity';
        if (load.site.expression.receiver && facts.gaps.some(gap => gap.kind === 'constants')) reason ??= 'Earlier Ruby source load can mutate the Kernel constant namespace';
        if (facts.definitions.some(def => def.name.replace(/^::/, '') === 'Kernel' || def.kind === 'singleton_method' && def.receiver?.kind === 'constant' && ['Kernel', '::Kernel'].includes(def.receiver.name) && def.name === load.kind) || facts.assignments.some(item => item.target.kind === 'constant' && item.target.name.replace(/^::/, '') === 'Kernel')) reason ??= 'Earlier Ruby source load reopens or replaces Kernel';
        if (!load.site.expression.receiver && facts.definitions.some(def => def.name === load.kind && this.ancestors(dependency, def.scope).every(scope => !['class', 'module'].includes(scope.kind)))) reason ??= 'Earlier Ruby source load defines an implicit loader method';
        const argument = load.site.expression.args[load.kind === 'autoload' ? 1 : 0];
        const usesFile = (value: RubyExpression | undefined): boolean => !!value && value.kind === 'call' && (value.receiver?.kind === 'constant' && ['File', '::File'].includes(value.receiver.name) || value.args.some(usesFile));
        if (usesFile(argument) && (this.fileGlobal(dependency, 'File') || facts.gaps.some(gap => gap.kind === 'constants') || facts.definitions.some(def => def.kind === 'singleton_method' && def.receiver?.kind === 'constant' && ['File', '::File'].includes(def.receiver.name)))) reason ??= 'Earlier Ruby source load changes the File path namespace';
        const usesDir = (value: RubyExpression | undefined): boolean => !!value && (value.kind === 'identifier' && value.name === '__dir__' || value.kind === 'call' && value.args.some(usesDir));
        if (usesDir(argument) && facts.definitions.some(def => def.name === '__dir__')) reason ??= 'Earlier Ruby source load changes __dir__ identity';
        const usesCwd = argument && this.value(file.path, argument)?.proof.some(fact => fact.explanation?.includes('Recorded Ruby cwd'));
        if (facts.gaps.some(gap => gap.kind === 'path') && (load.kind !== 'require_relative' && (!argument || argument.kind === 'literal') || usesCwd)) reason ??= 'Earlier Ruby source load changes load-path/cwd/loaded-feature state';
        if (facts.gaps.some(gap => gap.kind === 'path')) load.conditions.push('Earlier Ruby load mutates path/feature state; source initialization is constrained');
      }
      if (reason) load.outcome = { status: 'unsupported', reason };
      load.conditions = [...new Set(load.conditions)];
    }
  }
}
