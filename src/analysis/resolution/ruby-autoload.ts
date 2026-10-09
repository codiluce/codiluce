import path from 'node:path';
import semver from 'semver';
import type { AnalysisContext, ScannedFile } from '../../core/analyzer.js';
import { evidence, type Evidence } from '../../core/graph.js';
import { fileAnalysis, type RubyCallFact, type RubyDefinitionFact, type RubyExpression } from '../facts.js';
import { IndexedSources } from '../indexed-sources.js';
import { rubyGemProfile, type RubyGemProfile } from '../languages/ruby-profile.js';
import type { RubyProject, RubyResolver } from './ruby.js';

export const RUBY_AUTOLOAD_VERSION = '1';
interface Root { path: string; namespace: string; loader: 'main' | 'once'; source: 'loader' | 'recorded' | 'autoload_paths' | 'autoload_once_paths' | 'eager_load_paths' | 'conventional' | 'preview'; proof: Evidence[] }
export interface RubyAutoloadModel { project: RubyProject; profile: RubyGemProfile; loaderProfile?: RubyGemProfile; rails: boolean; roots: Root[]; gaps: string[]; conditions: string[]; seeds: { file: string; fact: RubyDefinitionFact; name: string; proof: Evidence[] }[]; main: Inflector; once: Inflector; ignore: string[]; collapse: string[] }
interface Inflector { kind: 'rails' | 'zeitwerk'; overrides: Map<string, string>; acronyms: Map<string, string>; ignore: string[]; collapse: string[]; proof: Evidence[] }
export interface RubyAutoloadCandidate { name: string; kind: 'file' | 'implicit'; file?: ScannedFile; path: string; directories: string[]; shadowed: string[]; loader: 'main' | 'once'; proof: Evidence[]; conditions: string[]; reason?: string }
const inside = (file: string, root: string) => root === '.' || file === root || file.startsWith(root + '/');
const cname = (name: string) => /^\p{Lu}[\p{ID_Continue}]*$/u.test(name);
const chain = (value: RubyExpression | undefined): string | undefined => !value ? undefined : value.kind === 'constant' ? value.name.replace(/^::/, '') : value.kind === 'identifier' ? value.name : value.kind === 'call' && !value.args.length && value.receiver ? `${chain(value.receiver)}.${value.method}` : undefined;
const strings = (value: RubyExpression): string[] | undefined => value.kind === 'literal' && typeof value.value === 'string' ? [value.value] : value.kind === 'array' && value.items.every(item => item.kind === 'literal' && typeof item.value === 'string') ? value.items.map(item => item.kind === 'literal' ? String(item.value) : '') : undefined;
const keyword = (args: RubyExpression[], name: string) => args.flatMap(arg => arg.kind === 'hash' ? arg.items : []).find(item => item.key.kind === 'symbol' && item.key.name === name)?.value;

/** Declarative loader contracts and whitelisted Rails configuration syntax.
 * Filename conventions produce candidates; the symbol service checks the
 * original constant definition when activation occurs. No target setup runs. */
export class RubyAutoloadCatalog {
  readonly models = new Map<string, RubyAutoloadModel>();
  private readonly indexes = new Map<string, Map<string, RubyAutoloadCandidate>>();
  private readonly lateOnce = new Map<string, string[]>();
  private readonly eagerReset = new Set<string>();
  private readonly autoloadReset = new Set<string>();
  private readonly directories: Set<string>;
  constructor(readonly context: AnalysisContext, readonly resolver: RubyResolver) {
    this.directories = new Set([...context.graph.entities.values()].filter(entity => ['directory', 'application'].includes(entity.type) && entity.path).map(entity => entity.path!));
    for (const project of resolver.projects) this.configure(project);
  }
  private proof(file: string | undefined, line: number | undefined, reason: string, source: Evidence['source'] = 'syntax'): Evidence[] { return [{ ...evidence(source, 'ruby-autoload', file, line, reason), analyzerVersion: RUBY_AUTOLOAD_VERSION }]; }
  private rails71(model: RubyAutoloadModel): boolean | undefined {
    if (model.profile.version) return semver.satisfies(model.profile.version, '>=7.1.0 <7.2.0');
    if (model.profile.range && semver.subset(model.profile.range, '>=7.1.0 <7.2.0')) return true;
    if (model.profile.range && semver.subset(model.profile.range, '>=7.2.0 <8.2.0')) return false;
    return;
  }
  private root(model: RubyAutoloadModel, directory: string, namespace: string, loader: Root['loader'], proof: Evidence[], source: Root['source'] = 'recorded'): void {
    const normalized = path.posix.normalize(directory);
    if (normalized === '..' || normalized.startsWith('../') || path.posix.isAbsolute(normalized) || /[\\\0*?\[\]{}]/.test(normalized)) { model.gaps.push('Autoload path is outside bounded repository inputs'); return; }
    const old = model.roots.find(item => item.path === normalized && item.source === source && item.loader === loader);
    if (old) { old.namespace = namespace === 'Object' ? '' : namespace; old.loader = loader; old.proof.push(...proof); }
    else model.roots.push({ path: normalized, namespace: namespace === 'Object' ? '' : namespace, loader, source, proof });
  }
  private configure(project: RubyProject): void {
    const configured = project.application?.ruby?.autoload;
    const rails = !!project.application?.frameworks.includes('rails') || project.manifests.some(file => this.resolver.facts(file)?.calls.some(call => call.expression.method === 'gem' && call.expression.args[0]?.kind === 'literal' && call.expression.args[0].value === 'rails'));
    if (!rails && !configured) return;
    const profile = rubyGemProfile(this.context, this.resolver, project, rails ? 'rails' : 'zeitwerk', rails ? undefined : configured?.version);
    const inflector = (): Inflector => ({ kind: configured?.inflector ?? (rails ? 'rails' : 'zeitwerk'), overrides: new Map(Object.entries(configured?.inflections ?? {})), acronyms: new Map(), ignore: (configured?.ignore ?? []).map(value => path.posix.join(project.root, value)), collapse: (configured?.collapse ?? []).map(value => path.posix.join(project.root, value)), proof: this.proof(undefined, undefined, 'Recorded autoload inflector inputs', 'framework') });
    const model: RubyAutoloadModel = { project, profile, rails, roots: [], gaps: [...profile.gaps], conditions: ['Indexed loader contract; target boot, setup, eager loading and reload are not executed'], seeds: [], main: inflector(), once: inflector(), ignore: (configured?.ignore ?? []).map(value => path.posix.join(project.root, value)), collapse: (configured?.collapse ?? []).map(value => path.posix.join(project.root, value)) };
    this.models.set(project.id, model);
    if (rails) {
      const lock = (this.context.sources ?? new IndexedSources(this.context)).readFile(path.posix.join(project.root, 'Gemfile.lock'));
      const declared = project.manifests.some(file => this.resolver.facts(file)?.calls.some(call => call.expression.args[0]?.kind === 'literal' && call.expression.args[0].value === 'zeitwerk' && ['gem', 'add_dependency', 'add_runtime_dependency'].includes(call.expression.method)));
      if (configured?.version || declared || /^    zeitwerk \(/m.test(lock ?? '')) {
        model.loaderProfile = rubyGemProfile(this.context, this.resolver, project, 'zeitwerk', configured?.version, true); model.gaps.push(...model.loaderProfile.gaps);
      } else model.conditions.push('Rails loader contract assumes reviewed Zeitwerk 2.6/2.7 behavior; its installed version is not recorded');
      const application = path.posix.join(project.root, 'config/application.rb'), syntax = this.resolver.facts(application);
      if (!syntax?.complete || !syntax.definitions.some(def => def.kind === 'class' && def.superclass?.kind === 'constant' && ['Rails::Application', '::Rails::Application'].includes(def.superclass.name))) model.gaps.push('A complete original Rails::Application declaration is required for conventional autoload setup');
      if ([...this.context.files.values()].filter(file => this.resolver.owner(file.path)?.id === project.id).some(file => this.resolver.facts(file.path)?.definitions.some(def => ['class', 'module'].includes(def.kind) && ['Rails', 'ActiveSupport', 'Zeitwerk'].includes(def.name.replace(/^::/, '').split('::')[0]!)) || this.resolver.facts(file.path)?.assignments.some(item => item.target.kind === 'constant' && ['Rails', 'ActiveSupport', 'Zeitwerk'].includes(item.target.name.replace(/^::/, '').split('::')[0]!)))) model.gaps.push('Indexed Rails/ActiveSupport/Zeitwerk namespace shadow invalidates the framework loader facade');
      const configs = [...this.context.files.values()].filter(file => this.resolver.owner(file.path)?.id === project.id && (file.path === application || inside(file.path, path.posix.join(project.root, 'config/initializers')) || inside(file.path, path.posix.join(project.root, 'config/environments')))).sort((a, b) => a.path === application ? -1 : b.path === application ? 1 : a.path < b.path ? -1 : 1);
      for (const file of configs) {
        const environment = inside(file.path, path.posix.join(project.root, 'config/environments'));
        if (environment && path.posix.basename(file.path, '.rb') !== project.application?.ruby?.environment) {
          if (this.touchesLoader(file.path)) model.gaps.push('Unselected Rails environment can change autoload inputs; record ruby.environment'); continue;
        }
        this.readRails(model, file, file.path === application);
      }
      const app = path.posix.join(project.root, 'app'), dirs = [...new Set([...this.directories, ...this.context.directoryInventory ?? []])].filter(dir => path.posix.dirname(dir) === app && !['assets', 'javascript', 'views'].includes(path.posix.basename(dir)) && !path.posix.basename(dir).startsWith('.')).flatMap(dir => this.directories.has(dir + '/concerns') || this.context.directoryInventory?.has(dir + '/concerns') ? [dir, dir + '/concerns'] : [dir]).sort();
      if (!(this.rails71(model) && this.eagerReset.has(project.id))) for (const directory of dirs) this.root(model, directory, '', 'main', [...profile.proof, ...this.proof(application, undefined, 'Rails app directory/concerns Object-root convention', 'framework')], 'conventional');
      const previews = path.posix.join(project.root, 'test/mailers/previews');
      if ((this.directories.has(previews) || this.context.directoryInventory?.has(previews)) && !(this.rails71(model) && this.autoloadReset.has(project.id))) this.root(model, previews, '', 'main', [...profile.proof, ...this.proof(application, undefined, 'Rails engine preview autoload path convention', 'framework')], 'preview');
      if (this.rails71(model) === undefined && (this.eagerReset.has(project.id) || model.roots.some(root => root.source === 'eager_load_paths'))) model.gaps.push('Rails requirement crosses 7.1/7.2 eager-path ordering profiles; select a lock version');
      if (this.rails71(model) === undefined && model.roots.some(root => root.source === 'preview') && (this.autoloadReset.has(project.id) || model.roots.some(root => root.source === 'autoload_paths'))) model.gaps.push('Rails requirement crosses 7.1/7.2 preview-path ordering profiles; select a lock version');
    }
    for (const root of configured?.roots ?? []) {
      const directory = path.posix.join(project.root, root.path); model.roots = model.roots.filter(item => item.path !== directory);
      this.root(model, directory, root.namespace ?? '', root.loader ?? 'main', this.proof(undefined, undefined, `Recorded ordered ${root.loader ?? 'main'} autoload root ${root.path}${root.namespace ? ` under ${root.namespace}` : ''}`, 'framework'));
    }
    const legacyPaths = model.rails && this.rails71(model) === true;
    const priority: Record<Root['source'], number> = { loader: 0, recorded: 0, autoload_paths: 1, autoload_once_paths: 1, preview: legacyPaths ? 0.5 : 1.5, conventional: legacyPaths ? 2 : 3, eager_load_paths: legacyPaths ? 3 : 2 };
    model.roots.sort((a, b) => Number(b.loader === 'once') - Number(a.loader === 'once') || priority[a.source] - priority[b.source]);
    model.roots = model.roots.filter((root, i, roots) => roots.findIndex(item => item.path === root.path) === i);
    if (model.roots.some(root => root.loader === 'once')) model.gaps.push(...this.lateOnce.get(project.id) ?? []);
    model.gaps = [...new Set(model.gaps)]; this.index(model);
  }
  private touchesLoader(file: string): boolean { return !!this.resolver.facts(file)?.calls.some(call => /autoload|inflect|acronym|collapse|push_dir/.test(call.expression.method) || /autoload|inflect/.test(chain(call.expression.receiver) ?? '')) || !!this.resolver.facts(file)?.assignments.some(item => /autoload|inflect/.test(chain(item.target) ?? '')); }
  private path(model: RubyAutoloadModel, file: string, value: RubyExpression): string | undefined {
    if (value.kind === 'literal' && typeof value.value === 'string') {
      if (/^(?:\/|[A-Za-z]:)|[\\\0*?\[\]{}]/.test(value.value)) return;
      const base = model.project.cwd; return base === undefined ? undefined : path.posix.normalize(path.posix.join(base, value.value));
    }
    if (value.kind === 'identifier' && value.name === '__dir__' && !this.resolver.facts(file)?.definitions.some(def => def.name === '__dir__') && !this.resolver.facts(file)?.locals.some(local => local.name === '__dir__')) return path.posix.dirname(file);
    if (value.kind !== 'call') return;
    const receiver = chain(value.receiver);
    if (value.method === 'root' && receiver === 'Rails' && !value.args.length) return model.project.root;
    if (value.method === 'join' && receiver === 'Rails.root' && value.args.every(arg => arg.kind === 'literal' && typeof arg.value === 'string' && !path.posix.isAbsolute(arg.value))) return path.posix.join(model.project.root, ...value.args.map(arg => arg.kind === 'literal' ? String(arg.value) : ''));
    if (receiver === 'File' && ['join', 'expand_path'].includes(value.method) && value.args.length) {
      const facts = this.resolver.facts(file);
      if (facts?.definitions.some(def => ['File', '::File'].includes(def.name) || def.kind === 'singleton_method' && chain(def.receiver) === 'File' && def.name === value.method) || facts?.assignments.some(item => item.target.kind === 'constant' && chain(item.target) === 'File') || facts?.gaps.some(gap => ['loader', 'constants', 'path'].includes(gap.kind))) return;
      const relative = (text: string) => !/^(?:\/|[A-Za-z]:|~)|[\\\0*?\[\]{}]/.test(text);
      if (value.method === 'expand_path') { const first = strings(value.args[0]!); const base = value.args[1] ? this.path(model, file, value.args[1]) : model.project.cwd; return value.args.length <= 2 && first?.length === 1 && base !== undefined && relative(first[0]!) ? path.posix.normalize(path.posix.join(base, first[0]!)) : undefined; }
      const first = this.path(model, file, value.args[0]!), rest = value.args.slice(1).map(arg => strings(arg)); return first !== undefined && rest.every(parts => parts?.length === 1 && relative(parts[0]!)) ? path.posix.join(first, ...rest.map(parts => parts![0]!)) : undefined;
    }
    return;
  }
  private readRails(model: RubyAutoloadModel, file: ScannedFile, application: boolean): void {
    const facts = this.resolver.facts(file.path); if (!facts?.complete) { if (this.touchesLoader(file.path) || application) model.gaps.push(`Incomplete Rails loader configuration ${file.path}`); return; }
    if (facts.gaps.some(gap => ['loader', 'constants', 'path', 'scope'].includes(gap.kind))) model.gaps.push(`Reflective/opaque Rails configuration requires a state summary: ${file.path}`);
    if (facts.definitions.some(def => ['config', 'root', 'autoloaders'].includes(def.name))) model.gaps.push(`Custom Rails configuration facade requires a method summary: ${file.path}`);
    const assignments: RubyCallFact[] = facts.assignments.filter(item => chain(item.target)?.endsWith('.inflector')).map(item => ({ ...item, expression: { ...item.target, ...item, kind: 'call', method: 'inflector=', args: [item.value], receiver: item.target.kind === 'call' ? item.target.receiver : undefined } }));
    const calls = [...facts.calls.filter(call => call.expression.method !== 'inflector='), ...assignments].sort((a, b) => a.end - b.end);
    const initializer = inside(file.path, path.posix.join(model.project.root, 'config/initializers'));
    const receiverChain = (call: RubyCallFact) => {
      const original = chain(call.expression.receiver); if (!original) return;
      const [head, ...members] = original.split('.'), scopes = this.resolver.ancestors(file.path, call.scope);
      const lexical = scopes.find(scope => ['file', 'class', 'module', 'method', 'singleton'].includes(scope.kind));
      const aliases = facts.assignments.filter(item => item.target.kind === 'identifier' && item.target.name === head && item.end <= call.start && scopes.some(scope => scope.key === item.scope) && this.resolver.ancestors(file.path, item.scope).find(scope => ['file', 'class', 'module', 'method', 'singleton'].includes(scope.kind))?.key === lexical?.key);
      if (aliases.length !== 1 || facts.locals.filter(local => local.name === head && local.kind === 'write').length !== 1 || aliases[0]!.augmentation || this.resolver.ancestors(file.path, aliases[0]!.scope).some(scope => scope.conditional || scope.kind === 'method')) return original;
      const value = chain(aliases[0]!.value); return value?.startsWith('Rails.autoloaders') ? [value, ...members].join('.') : original;
    };
    const anchors = calls.filter(call => call.blockScope && (receiverChain(call) === 'Rails.autoloaders' && call.expression.method === 'each' || receiverChain(call) === 'ActiveSupport::Inflector' && call.expression.method === 'inflections' || receiverChain(call) === 'Rails.application' && call.expression.method === 'configure'));
    const target = (call: RubyCallFact): ('main' | 'once')[] => {
      const receiver = receiverChain(call);
      if (receiver === 'Rails.autoloaders.main' || receiver === 'Rails.autoloaders.main.inflector') return ['main'];
      if (receiver === 'Rails.autoloaders.once' || receiver === 'Rails.autoloaders.once.inflector') return ['once'];
      for (const anchor of anchors) {
        if (!this.resolver.ancestors(file.path, call.scope).some(scope => scope.key === anchor.blockScope)) continue;
        const parameter = facts.locals.find(local => local.scope === anchor.blockScope && local.kind === 'parameter')?.name;
        if (parameter && (receiver === parameter || receiver === parameter + '.inflector')) {
          if (facts.locals.some(local => local.name === parameter && local.kind === 'write')) { model.gaps.push('Rails loader block parameter is mutable'); return []; }
          return receiverChain(anchor) === 'Rails.autoloaders' ? ['main', 'once'] : [];
        }
      }
      return [];
    };
    const configScope = (call: RubyCallFact) => application && this.resolver.ancestors(file.path, call.scope).some(scope => facts.definitions.some(def => def.bodyScope === scope.key && def.superclass?.kind === 'constant' && def.superclass.name.replace(/^::/, '') === 'Rails::Application')) || anchors.some(anchor => chain(anchor.expression.receiver) === 'Rails.application' && this.resolver.ancestors(file.path, call.scope).some(scope => scope.key === anchor.blockScope));
    for (const call of calls) {
      if (call.bare && facts.locals.some(local => local.name === call.expression.method && this.resolver.ancestors(file.path, call.scope).some(scope => scope.key === local.scope))) continue;
      const expression = call.expression, receiver = receiverChain(call), loaders = target(call), proof = this.proof(file.path, call.range.startLine, `Original literal Rails ${expression.method} loader configuration`);
      if (this.resolver.ancestors(file.path, call.scope).some(scope => scope.conditional || scope.kind === 'method') && (loaders.length || /autoload|acronym/.test(expression.method))) { model.gaps.push('Conditional/deferred Rails loader configuration requires invocation proof'); continue; }
      if (['inflector=', 'inflect', 'push_dir', 'collapse', 'ignore'].includes(expression.method) && !loaders.length) { model.gaps.push('Unproven/aliased Rails loader configuration receiver'); continue; }
      if (loaders.length && (expression.method === 'inflect' && !receiver?.endsWith('.inflector') || ['inflector=', 'push_dir', 'collapse', 'ignore'].includes(expression.method) && receiver?.endsWith('.inflector'))) { model.gaps.push('Rails loader/inflector method has the wrong facade receiver'); continue; }
      if (initializer && loaders.includes('once') && ['inflector=', 'inflect', 'push_dir', 'collapse', 'ignore'].includes(expression.method)) this.lateOnce.set(model.project.id, [...this.lateOnce.get(model.project.id) ?? [], 'Once-loader configuration in initializers occurs after once setup']);
      if (initializer && /autoload_lib|autoload_paths|autoload_once_paths|eager_load_paths/.test(receiver ?? '') || initializer && ['autoload_lib', 'autoload_lib_once', 'autoload_paths=', 'autoload_once_paths=', 'eager_load_paths='].includes(expression.method)) { model.gaps.push('Rails configuration path mutation in initializers occurs after path setup'); continue; }
      if (receiver?.startsWith('config') && (expression.method === 'root=' || expression.method === 'javascript_path=' || expression.method === '[]=' && receiver === 'config.paths') || /config\.(?:autoload_paths|autoload_once_paths|eager_load_paths)/.test(receiver ?? '') && !['<<', 'push', 'append', 'concat'].includes(expression.method) || loaders.length && ['clear', 'delete', 'delete_if', 'reset', 'unload', 'reload', 'on_setup', 'on_load', 'on_unload'].includes(expression.method)) { model.gaps.push('Custom Rails root/path/loader mutation requires an ordered profile'); continue; }
      if (receiver === 'config' && facts.locals.some(local => local.name === 'config') && /autoload|eager_load/.test(expression.method)) { model.gaps.push('Local config binding shadows the Rails application facade'); continue; }
      if (expression.method === 'inflector=' && loaders.length) {
        const value = expression.args[0];
        if (value?.kind !== 'call' || value.method !== 'new' || value.args.length || chain(value.receiver) !== 'Zeitwerk::Inflector') model.gaps.push('Custom Rails inflector implementation is outside the bounded profile');
        else for (const loader of loaders) { model[loader].kind = 'zeitwerk'; model[loader].overrides.clear(); model[loader].proof.push(...proof); }
      } else if (expression.method === 'inflect' && loaders.length) {
        const items = expression.args.flatMap(arg => arg.kind === 'hash' ? arg.items : []);
        if (!items.length || expression.args.some(arg => arg.kind !== 'hash') || items.some(item => item.key.kind !== 'literal' || typeof item.key.value !== 'string' || item.value.kind !== 'literal' || typeof item.value.value !== 'string' || !cname(item.value.value))) { model.gaps.push('Dynamic/invalid Rails inflector override'); continue; }
        for (const loader of loaders) { for (const item of items) model[loader].overrides.set(String(item.key.kind === 'literal' ? item.key.value : ''), String(item.value.kind === 'literal' ? item.value.value : '')); model[loader].proof.push(...proof); }
      } else if (expression.method === 'acronym') {
        const anchor = anchors.find(anchor => chain(anchor.expression.receiver) === 'ActiveSupport::Inflector' && this.resolver.ancestors(file.path, call.scope).some(scope => scope.key === anchor.blockScope));
        const parameter = anchor && facts.locals.find(local => local.scope === anchor.blockScope && local.kind === 'parameter')?.name;
        if (!anchor || receiver !== parameter) continue;
        if (facts.locals.some(local => local.name === parameter && local.kind === 'write')) { model.gaps.push('ActiveSupport inflection block parameter is mutable'); continue; }
        const name = expression.args[0]; if (expression.args.length !== 1 || name?.kind !== 'literal' || typeof name.value !== 'string' || !/^[A-Za-z][A-Za-z0-9]*$/.test(name.value) || anchor.expression.args.some(arg => arg.kind !== 'symbol' || arg.name !== 'en')) { model.gaps.push('Dynamic/unreviewed ActiveSupport acronym configuration'); continue; }
        for (const loader of ['main', 'once'] as const) { model[loader].acronyms.set(name.value.toLowerCase(), name.value); model[loader].proof.push(...proof); }
        if (initializer && model.once.kind === 'rails') this.lateOnce.set(model.project.id, [...this.lateOnce.get(model.project.id) ?? [], 'Once-loader acronym changes in initializers occur after once setup']);
      } else if (['autoload_lib', 'autoload_lib_once'].includes(expression.method) && receiver === 'config' && configScope(call)) {
        const ignore = keyword(expression.args, 'ignore'), values = ignore && strings(ignore); if (!values || expression.args.some(arg => arg.kind !== 'hash') || expression.args.flatMap(arg => arg.kind === 'hash' ? arg.items : []).some(item => item.key.kind !== 'symbol' || item.key.name !== 'ignore')) { model.gaps.push('autoload_lib requires a bounded literal ignore list'); continue; }
        const loader = expression.method.endsWith('_once') ? 'once' : 'main', ignored = values.map(value => path.posix.join(model.project.root, 'lib', value));
        this.root(model, path.posix.join(model.project.root, 'lib'), '', loader, proof, loader === 'once' ? 'autoload_once_paths' : 'autoload_paths'); model.ignore.push(...ignored); model[loader].ignore.push(...ignored);
      } else if (['<<', 'push', 'append', 'concat', 'autoload_paths=', 'autoload_once_paths=', 'eager_load_paths='].includes(expression.method) && /^(?:config\.(?:autoload_paths|autoload_once_paths|eager_load_paths)|config)$/.test(receiver ?? '') && configScope(call)) {
        if (expression.method.endsWith('=') !== (receiver === 'config')) { model.gaps.push('Rails path setter/collection mutation has the wrong facade receiver'); continue; }
        const setter = expression.method.endsWith('='), arrays = setter || expression.method === 'concat';
        if (setter && expression.args.length !== 1 || expression.method === '<<' && expression.args.length !== 1 || expression.args.some(arg => arrays ? arg.kind !== 'array' : arg.kind === 'array' || arg.kind === 'hash')) { model.gaps.push('Rails path collection requires correctly shaped literal arguments'); continue; }
        const name = expression.method.endsWith('=') ? expression.method.slice(0, -1) : receiver!.split('.').at(-1)!, values = expression.args.flatMap(arg => arg.kind === 'array' ? arg.items : [arg]), directories = values.map(value => this.path(model, file.path, value));
        if (directories.some(value => value === undefined)) { model.gaps.push('Dynamic Rails autoload/eager root configuration'); continue; }
        if (expression.method.endsWith('=')) model.roots = model.roots.filter(root => root.source !== name);
        if (expression.method === 'eager_load_paths=') this.eagerReset.add(model.project.id);
        if (expression.method === 'autoload_paths=') this.autoloadReset.add(model.project.id);
        for (const directory of directories) this.root(model, directory!, '', name === 'autoload_once_paths' ? 'once' : 'main', proof, name as Root['source']);
      } else if (['push_dir', 'ignore', 'collapse'].includes(expression.method) && loaders.length) {
        const values = expression.args.filter(arg => arg.kind !== 'hash').flatMap(arg => arg.kind === 'array' ? arg.items : [arg]), directories = values.map(value => this.path(model, file.path, value));
        if (!directories.length || directories.some(value => value === undefined)) { model.gaps.push('Dynamic Rails loader directories/globs require a profile'); continue; }
        const options = expression.args.flatMap(arg => arg.kind === 'hash' ? arg.items : []);
        if (options.some(item => expression.method !== 'push_dir' || item.key.kind !== 'symbol' || item.key.name !== 'namespace') || expression.method === 'push_dir' && directories.length !== 1) { model.gaps.push('Invalid/unreviewed Rails loader directory arguments'); continue; }
        if (expression.method === 'push_dir') { const namespace = keyword(expression.args, 'namespace'); if (namespace && namespace.kind !== 'constant') { model.gaps.push('Custom root namespace is not a literal constant'); continue; } for (const loader of loaders) for (const directory of directories) this.root(model, directory!, namespace?.kind === 'constant' ? namespace.name.replace(/^::/, '') : '', loader, proof, 'loader'); }
        else { const setting = expression.method === 'ignore' ? 'ignore' : 'collapse'; model[setting].push(...directories as string[]); for (const loader of loaders) model[loader][setting].push(...directories as string[]); }
      }
    }
    if (facts.assignments.some(item => item.augmentation && /autoload|eager_load|inflector/.test(chain(item.target) ?? ''))) model.gaps.push('Augmented Rails loader assignment requires an ordered state summary');
    for (const definition of facts.definitions.filter(def => ['class', 'module'].includes(def.kind))) {
      const scopes = this.resolver.ancestors(file.path, definition.scope); if (scopes.some(scope => scope.deferred || scope.conditional || scope.kind === 'singleton')) continue;
      const parents = scopes.filter(scope => ['class', 'module'].includes(scope.kind)).reverse().map(scope => scope.name!); if ([...parents, definition.name].some(name => !cname(name))) continue;
      model.seeds.push({ file: file.path, fact: definition, name: [...parents, definition.name].join('::'), proof: this.proof(file.path, definition.range.startLine, 'Original namespace in Rails loader configuration') });
    }
  }
  private camelize(model: RubyAutoloadModel, basename: string, loader: Root['loader']): string | undefined {
    const inflector = model[loader], override = inflector.overrides.get(basename); if (override) return cname(override) ? override : undefined;
    if (!/^[\p{L}\p{N}_]+$/u.test(basename)) return;
    if (inflector.kind === 'rails') {
      const word = (value: string) => inflector.acronyms.get(value) ?? (value[0]?.toUpperCase() ?? '') + value.slice(1);
      const name = basename.replace(/^[a-z\d]*/, word).replace(/_([a-z\d]*)/g, (_match, value: string) => word(value)); return cname(name) ? name : undefined;
    }
    // Ruby capitalize uses Unicode titlecase mappings, which are not identical
    // to JavaScript uppercase/lowercase. Exact overrides remain authoritative.
    if (/[^\x00-\x7f]/.test(basename)) return;
    const name = basename.split('_').filter(Boolean).map(word => {
      if (inflector.kind === 'rails' && inflector.acronyms.has(word)) return inflector.acronyms.get(word)!;
      const [first, ...rest] = [...word]; const capital = first?.toUpperCase(); return capital && [...capital].length === 1 ? capital + rest.join('').toLowerCase() : '';
    }).join(''); return cname(name) ? name : undefined;
  }
  private index(model: RubyAutoloadModel): void {
    const index = new Map<string, RubyAutoloadCandidate>(); this.indexes.set(model.project.id, index);
    const paths = [...new Set([...this.context.files.keys(), ...this.context.fileInventory ?? []])].filter(file => file.endsWith('.rb')).sort();
    for (const root of model.roots) for (const file of paths) {
      const selected = model.roots.filter(root => inside(file, root.path) && file !== root.path).sort((a, b) => b.path.length - a.path.length)[0]; if (selected !== root || model[root.loader].ignore.some(directory => inside(file, directory))) continue;
      const relative = path.posix.relative(root.path, file), parts = relative.split('/'); if (parts.some(part => part.startsWith('.'))) continue;
      const names = root.namespace ? root.namespace.split('::') : []; let directory = root.path;
      for (let i = 0; i < parts.length; i++) {
        const leaf = i === parts.length - 1, basename = leaf ? parts[i]!.slice(0, -3) : parts[i]!; directory = path.posix.join(directory, parts[i]!);
        if (!leaf && model[root.loader].collapse.includes(directory)) continue;
        const name = this.camelize(model, basename, root.loader); if (!name) { model.gaps.push(`Invalid/unreviewed autoload basename ${directory}`); break; } names.push(name);
        const qualified = names.join('::'), previous = index.get(qualified), target = this.context.files.get(file);
        const proof = [...model.profile.proof, ...model.loaderProfile?.proof ?? [], ...root.proof, ...model[root.loader].proof, ...this.proof(leaf ? file : directory, undefined, `Indexed ${leaf ? 'file' : 'implicit namespace'} autoload contract ${qualified}`, 'filesystem')];
        if (!leaf) { if (previous) { if (!previous.directories.includes(directory)) previous.directories.push(directory); } else index.set(qualified, { name: qualified, kind: 'implicit', path: directory, directories: [directory], shadowed: [], loader: root.loader, proof, conditions: model.conditions }); continue; }
        const reason = !target?.analyzable || target.language !== 'ruby' ? `Observed autoload target is excluded, symlinked or not indexed: ${file}` : !this.resolver.facts(file)?.complete ? `Incomplete original autoload source ${file}` : undefined;
        if (previous?.kind === 'file') { previous.shadowed.push(file); continue; }
        index.set(qualified, { name: qualified, kind: 'file', file: target, path: file, directories: previous?.directories ?? [], shadowed: [], loader: root.loader, proof, conditions: model.conditions, reason });
      }
    }
    for (const root of model.roots) for (const directory of this.context.directoryInventory ?? []) if (inside(directory, root.path) && !this.directories.has(directory) && !path.posix.relative(root.path, directory).split('/').some(part => part.startsWith('.')) && !model[root.loader].ignore.some(ignored => inside(directory, ignored))) model.gaps.push(`Autoload root crosses an unindexed directory/symlink boundary ${directory}`);
    model.gaps = [...new Set(model.gaps)];
  }
  model(origin: string): RubyAutoloadModel | undefined { const owner = this.resolver.owner(origin); return owner && this.models.get(owner.id); }
  lookup(origin: string, name: string, file = origin, deferred = false): RubyAutoloadCandidate | undefined {
    const model = this.model(origin); if (!model) return;
    const candidate = this.indexes.get(model.project.id)?.get(name); if (!candidate) return;
    const boot = model.rails && !deferred && (file === path.posix.join(model.project.root, 'config/application.rb') || inside(file, path.posix.join(model.project.root, 'config/initializers')));
    return { ...candidate, ...(model.gaps.length ? { reason: model.gaps.join('; ') } : boot && candidate.loader === 'main' ? { reason: 'Reloadable Rails main constants cannot be autoloaded directly during application/initializer boot' } : {}) };
  }
  describe(): Record<string, unknown>[] { return [...this.models.values()].map(model => ({ project: model.project.id, adapter: model.rails ? 'rails-zeitwerk' : 'zeitwerk', version: RUBY_AUTOLOAD_VERSION, profile: model.profile, loaderProfile: model.loaderProfile, roots: model.roots, ignore: model.ignore, collapse: model.collapse, inflectors: { main: { kind: model.main.kind, ignore: model.main.ignore, collapse: model.main.collapse, overrides: Object.fromEntries(model.main.overrides), acronyms: Object.fromEntries(model.main.acronyms) }, once: { kind: model.once.kind, ignore: model.once.ignore, collapse: model.once.collapse, overrides: Object.fromEntries(model.once.overrides), acronyms: Object.fromEntries(model.once.acronyms) } }, gaps: model.gaps, conditions: model.conditions })); }
  annotate(): void {
    for (const file of this.context.files.values()) {
      if (file.language !== 'ruby') continue; const model = this.model(file.path); if (!model) continue;
      const entity = this.context.graph.entities.get(file.id)!;
      const candidates = [...this.indexes.get(model.project.id)?.values() ?? []].filter(item => item.path === file.path || item.shadowed.includes(file.path));
      entity.metadata.rubyAutoload = { adapter: model.rails ? 'rails-zeitwerk' : 'zeitwerk', version: RUBY_AUTOLOAD_VERSION, profile: model.profile, loaderProfile: model.loaderProfile, candidates: candidates.map(item => ({ name: item.name, loader: item.loader, selected: item.path === file.path, shadowed: item.shadowed, reason: item.reason })), gaps: model.gaps, conditions: model.conditions };
      const analysis = fileAnalysis(entity.metadata.analysis); if (analysis && model.profile.reviewed && !model.gaps.length && candidates.some(candidate => !candidate.reason) && !Array.isArray(entity.metadata.frameworkPacks)) analysis.features.framework = { status: 'partial', reason: 'Version-qualified autoload root/inflector contract; executable boot/reload and wider framework depth remain unsupported' };
    }
  }
}
