import path from 'node:path';
import type { AnalysisContext } from '../../core/analyzer.js';
import { evidence, type Evidence } from '../../core/graph.js';
import { fileAnalysis, type RubyCallFact, type RubyExpression, type RubySite } from '../facts.js';
import type { RubySymbols } from '../languages/ruby-symbols.js';
import type { RubyAutoloadCatalog, RubyAutoloadModel } from '../resolution/ruby-autoload.js';
import { RailsInflections } from './rails-inflections.js';
import { RailsControllers } from './rails-controllers.js';
import { compileRailsPath, normalizeRailsPath, type RailsConstraint } from '../routes/rails-patterns.js';
import type { RoutingContract } from '../routes/contracts.js';

export const RAILS_VERSION = '1';
interface Site extends RubySite { file: string }
interface Resource { name: string; controller: string; collection: string; member: string; nested: string; new: string; singleton: boolean; param: string; nestedParam: string }
interface Frame { file: string; scope: string; path: string; module: string; controller?: string; actionDefault?: string; resource?: Resource; level: 'root' | 'resource' | 'member' | 'collection' | 'new'; shallow: boolean; shallowPath: string; format?: boolean | string; constraints: Record<string, RailsConstraint>; host?: string; conditions: string[]; proof: Evidence[]; bindings: Map<string, RubyExpression>; stack: string[]; pathNames: Record<string, string>; only?: string[]; except?: string[]; depth?: number }
interface Entry { site: Site; scope: string; path: string; controller?: string; action?: string; methods: string[] | '*'; format?: boolean | string; constraints: Record<string, RailsConstraint>; host?: string; conditions: string[]; proof: Evidence[]; name?: string; status?: number; redirect?: string; unresolvedPrefix?: string }
interface Root { model: RubyAutoloadModel; file: string; id: string; entries: Entry[]; gaps: string[]; apiOnly?: boolean; inflections: RailsInflections; concerns: Map<string, { file: string; call: RubyCallFact; conditions: string[] }>; steps: number }
const chain = (value: RubyExpression | undefined): string | undefined => value?.kind === 'constant' ? value.name.replace(/^::/, '') : value?.kind === 'identifier' ? value.name : value?.kind === 'call' && !value.args.length && value.receiver ? `${chain(value.receiver)}.${value.method}` : undefined;
const string = (value: RubyExpression | undefined): string | undefined => value?.kind === 'symbol' ? value.name : value?.kind === 'literal' && typeof value.value === 'string' ? value.value : undefined;
const strings = (value: RubyExpression | undefined): string[] | undefined => value?.kind === 'array' ? value.items.every(item => string(item) !== undefined) ? value.items.map(item => string(item)!) : undefined : string(value) !== undefined ? [string(value)!] : undefined;
const bool = (value: RubyExpression | undefined): boolean | undefined => value?.kind === 'literal' && typeof value.value === 'boolean' ? value.value : undefined;
const nil = (value: RubyExpression | undefined): boolean => value?.kind === 'literal' && value.value === null;
const join = (base: string, child: string) => normalizeRailsPath(base + '/' + child);
const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'CONNECT', 'TRACE'];
const actions = ['index', 'create', 'new', 'show', 'update', 'destroy', 'edit'];

/** Bounded Rails Mapper summaries over original indexed syntax. Static draw
 * files/concerns share the invoking root; target Ruby and Rails never run. */
export class RailsRegistrations {
  private readonly controllers: RailsControllers;
  constructor(private readonly context: AnalysisContext, private readonly symbols: RubySymbols, private readonly catalog: RubyAutoloadCatalog) { this.controllers = new RailsControllers(context, symbols, catalog, RAILS_VERSION); }
  private proof(site: Site, explanation: string): Evidence[] { return [{ ...evidence('framework', 'rails', site.file, site.range.startLine, explanation), analyzerVersion: RAILS_VERSION, endLine: site.range.endLine }]; }
  private issue(site: Site, reason: string, code = 'route-gap'): void { this.context.graph.diagnose({ analyzer: 'rails', severity: 'warning', code: `rails-${code}`, file: site.file, line: site.range.startLine, entityId: this.context.files.get(site.file)?.id, reason }); }
  private site(file: string, call: RubySite): Site { return { file, ...call }; }
  private value(value: RubyExpression, frame: Frame, depth = 0): RubyExpression {
    if (depth > 32) return { ...value, kind: 'unknown', text: 'Route value budget exceeded' };
    if (value.kind === 'identifier' && frame.bindings.has(value.name)) return this.value(frame.bindings.get(value.name)!, frame, depth + 1);
    if (value.kind === 'identifier') {
      const facts = this.symbols.resolver.facts(frame.file), ancestors = this.symbols.resolver.ancestors(frame.file, frame.scope), writes = facts?.locals.filter(local => local.name === value.name && ancestors.some(scope => scope.key === local.scope));
      if (writes?.length === 1 && writes[0]!.kind === 'write') {
        const assignment = facts?.assignments.find(item => item.target.kind === 'identifier' && item.target.name === value.name && item.start === writes[0]!.start && item.start < value.start && !item.augmentation);
        if (assignment && !this.symbols.resolver.ancestors(frame.file, assignment.scope).some(scope => scope.conditional || scope.kind === 'method')) return this.value(assignment.value, frame, depth + 1);
      }
    }
    if (value.kind === 'call' && value.method === '[]' && value.receiver?.kind === 'identifier' && value.args.length === 1) { const object = frame.bindings.get(value.receiver.name), key = string(value.args[0]); if (object?.kind === 'hash' && key) return object.items.find(item => string(item.key) === key)?.value ?? { ...value, kind: 'literal', value: null }; }
    return value;
  }
  private args(call: RubyCallFact, frame: Frame): { values: RubyExpression[]; options: Map<string, RubyExpression>; gaps: string[] } {
    const values: RubyExpression[] = [], options = new Map<string, RubyExpression>(), gaps: string[] = [];
    for (const source of call.expression.args) {
      const arg = this.value(source, frame); if (arg.kind !== 'hash') { values.push(arg); continue; }
      for (const item of arg.items) { const key = string(item.key); if (item.key.kind === 'literal' && typeof item.key.value === 'string' && !values.length && !options.has('to') && methods.map(method => method.toLowerCase()).concat('match').includes(call.expression.method)) { values.push(item.key); options.set('to', this.value(item.value, frame)); } else if (!key || options.has(key)) gaps.push('Dynamic/duplicate route option key'); else options.set(key, this.value(item.value, frame)); }
    }
    return { values, options, gaps };
  }
  run(): void {
    for (const model of this.catalog.models.values()) {
      if (!model.rails) continue;
      const file = path.posix.join(model.project.root, 'config/routes.rb'), facts = this.symbols.resolver.facts(file), source = this.context.files.get(file);
      if (!source || !facts?.complete) { if (this.context.fileInventory?.has(file)) this.context.graph.diagnose({ analyzer: 'rails', severity: 'warning', code: 'rails-routes-unavailable', file, reason: 'Conventional Rails route source is denied or incomplete' }); continue; }
      const anchors = facts.calls.filter(call => chain(call.expression.receiver) === 'Rails.application.routes' && call.expression.method === 'draw' && call.blockScope && !call.expression.args.length);
      if (!anchors.length) { this.issue(this.site(file, facts.scopes[0]!), 'No original Rails.application.routes.draw block selects this route DSL'); continue; }
      const root: Root = { model, file, id: this.context.graph.id('router', 'rails', model.project.id, file), entries: [], gaps: [...model.gaps], apiOnly: false, inflections: new RailsInflections(), concerns: new Map(), steps: 0 };
      if (anchors.length > 1) root.gaps.push('Multiple route draws require a selected reset/reload initialization profile');
      if (facts.definitions.length || facts.gaps.length || facts.assignments.some(item => item.target.kind === 'constant')) root.gaps.push('Custom/reflective route DSL definitions require a setup summary');
      this.configuration(root);
      for (const anchor of anchors) {
        const conditions = this.symbols.resolver.ancestors(file, anchor.scope).filter(scope => scope.conditional || scope.kind === 'method').map(scope => `Conditional/deferred route draw ${scope.kind}`);
        this.walk(root, { file, scope: anchor.blockScope!, path: '/', module: '', level: 'root', shallow: false, shallowPath: '/', constraints: {}, conditions, proof: [...model.profile.proof, ...this.proof(this.site(file, anchor), 'Original conventional Rails route draw')], bindings: new Map(), stack: [file], pathNames: { new: 'new', edit: 'edit' } });
      }
      for (const gap of new Set(root.gaps)) this.issue(this.site(file, anchors[0]!), gap);
      for (const [order, entry] of root.entries.entries()) this.emit(root, entry, order);
      const entity = this.context.graph.entities.get(source.id)!; entity.metadata.railsRoutes = { version: RAILS_VERSION, root: root.id, profile: model.profile, apiOnly: root.apiOnly, entries: root.entries.length, gaps: [...new Set(root.gaps)], inflectionGaps: root.inflections.gaps };
    }
  }
  private configuration(root: Root): void {
    const project = root.model.project;
    for (const file of [...this.context.files.values()].filter(file => this.symbols.resolver.owner(file.path)?.id === project.id && file.path.startsWith(path.posix.join(project.root, 'config') + '/')).sort((a, b) => a.path.localeCompare(b.path, 'en'))) {
      const facts = this.symbols.resolver.facts(file.path); if (!facts) continue;
      const environment = file.path.includes('/environments/') || file.path.startsWith('config/environments/'), selected = !environment || path.posix.basename(file.path, '.rb') === project.application?.ruby?.environment;
      for (const assignment of facts.assignments.filter(item => chain(item.target) === 'config.api_only')) {
        if (!selected || this.symbols.resolver.ancestors(file.path, assignment.scope).some(scope => scope.conditional || scope.kind === 'method') || bool(assignment.value) === undefined) root.apiOnly = undefined;
        else root.apiOnly = bool(assignment.value);
      }
      const anchors = facts.calls.filter(call => chain(call.expression.receiver) === 'ActiveSupport::Inflector' && call.expression.method === 'inflections' && call.blockScope);
      for (const anchor of anchors) {
        const parameter = facts.locals.find(local => local.scope === anchor.blockScope && local.kind === 'parameter')?.name;
        for (const call of facts.calls.filter(call => call.expression.receiver?.kind === 'identifier' && call.expression.receiver.name === parameter && this.symbols.resolver.ancestors(file.path, call.scope).some(scope => scope.key === anchor.blockScope))) {
          if (!['irregular', 'uncountable', 'plural', 'singular', 'clear'].includes(call.expression.method)) continue;
          if (!selected || facts.locals.some(local => local.name === parameter && local.kind === 'write') || this.symbols.resolver.ancestors(file.path, call.scope).some(scope => scope.conditional || scope.kind === 'method') || anchor.expression.args.some(arg => arg.kind !== 'symbol' || arg.name !== 'en')) { root.inflections.gaps.push('Unselected/conditional/custom Rails word inflection configuration'); continue; }
          const values = call.expression.args.flatMap(arg => strings(arg) ?? []);
          if (values.length !== call.expression.args.flatMap(arg => arg.kind === 'array' ? arg.items : [arg]).length || !values.every(value => /^[A-Za-z_][A-Za-z0-9_]*$/.test(value))) { root.inflections.gaps.push('Dynamic Rails word inflection'); continue; }
          if (call.expression.method === 'irregular' && values.length === 2) root.inflections.addIrregular(values[0]!, values[1]!);
          else if (call.expression.method === 'uncountable') root.inflections.addUncountable(values);
          else root.inflections.gaps.push('Custom plural/singular/clear rules require a reviewed inflection profile');
        }
      }
    }
    const core = (name: string) => name.split(/::|\./).some(part => ['ActionController', 'AbstractController'].includes(part));
    for (const file of this.context.files.values()) {
      if (this.symbols.resolver.owner(file.path)?.id !== project.id) continue;
      const facts = this.symbols.resolver.facts(file.path);
      if (facts?.definitions.some(def => ['class', 'module'].includes(def.kind) && core(def.name) || def.kind === 'singleton_method' && core(chain(def.receiver) ?? '')) || facts?.assignments.some(item => item.target.kind === 'constant' && core(item.target.name))) root.gaps.push('Indexed ActionController/AbstractController shadow requires a core dispatch summary');
      if (facts?.assignments.some(item => /(?:routes|draw_paths)(?:\.|$)/.test(chain(item.target) ?? '')) || facts?.calls.some(call => /\.routes(?:\.|$)/.test(chain(call.expression.receiver) ?? '') && !['draw', 'url_helpers'].includes(call.expression.method))) root.gaps.push('Custom route-set/draw-path mutation requires an initialization summary');
      if (facts?.definitions.some(def => def.kind === 'singleton_method' && /^(?:Rails|ActiveSupport|Zeitwerk)(?:::|\.|$)/.test(chain(def.receiver) ?? ''))) root.gaps.push('Indexed framework routing facade override requires an initialization summary');
    }
  }
  private calls(frame: Frame): RubyCallFact[] {
    const facts = this.symbols.resolver.facts(frame.file); if (!facts) return [];
    const calls = facts.calls.filter(call => { const ancestors = this.symbols.resolver.ancestors(frame.file, call.scope); return ancestors.find(scope => scope.kind !== 'control')?.key === frame.scope && !(call.bare && facts.locals.some(local => local.name === call.expression.method && ancestors.some(scope => scope.key === local.scope))); });
    return calls.filter(call => !calls.some(parent => parent !== call && parent.start <= call.start && parent.end >= call.end && (parent.start !== call.start || parent.end !== call.end))).sort((a, b) => a.start - b.start);
  }
  private unknown(root: Root, frame: Frame, call: RubyCallFact, reason: string, base = frame.path): void {
    this.issue(this.site(frame.file, call), reason); root.entries.push({ site: this.site(frame.file, call), scope: call.scope, path: join(base, '*unresolved'), methods: '*', format: false, constraints: {}, unresolvedPrefix: base, conditions: [...frame.conditions, reason], proof: [...frame.proof, ...this.proof(this.site(frame.file, call), 'Bounded unresolved Rails route competitor')] });
  }
  private walk(root: Root, frame: Frame): void {
    const depth = (frame.depth ?? 0) + 1;
    if (depth > 32) { root.gaps.push('Rails route expansion depth budget exceeded'); return; }
    for (const call of this.calls(frame)) {
      if (++root.steps > 30_000 || root.entries.length > 8192) { root.gaps.push('Rails route expansion budget exceeded'); return; }
      const site = this.site(frame.file, call), { values, options, gaps } = this.args(call, frame), method = call.expression.method;
      const conditions = [...frame.conditions, ...gaps, ...this.symbols.resolver.ancestors(frame.file, call.scope).filter(scope => scope.conditional).map(scope => `Conditional Rails ${scope.conditional}`)];
      const local: Frame = { ...frame, depth, conditions, proof: [...frame.proof, ...this.proof(site, `Original Rails ${method} DSL site`)] };
      if (call.expression.receiver && chain(call.expression.receiver) !== 'self') { this.unknown(root, local, call, 'Receiver-qualified route DSL is unproven'); continue; }
      if (method === 'concern') { const name = string(values[0]); if (!name || values.length !== 1 || !call.blockScope || options.size) this.unknown(root, local, call, 'Dynamic/callable route concern'); else { if (root.concerns.has(name) && local.conditions.length) root.gaps.push('Conditional concern redefinition requires initialization selection'); root.concerns.set(name, { file: frame.file, call, conditions: local.conditions }); } continue; }
      if (method === 'concerns') { this.concerns(root, local, call, values, options); continue; }
      if (method === 'draw') { const name = string(values[0]); if (!name || values.length !== 1 || options.size || !/^[A-Za-z0-9_/-]+$/.test(name) || name.startsWith('/') || name.includes('//')) { this.unknown(root, local, call, 'Dynamic/nonportable draw source'); continue; } const file = path.posix.join(root.model.project.root, 'config/routes', name + '.rb'); if (!this.context.files.get(file)?.analyzable || !this.symbols.resolver.facts(file)?.complete || frame.stack.includes(file)) { this.unknown(root, local, call, 'Denied/incomplete/cyclic route draw source'); root.gaps.push('Unresolved draw may alter previous route setup'); continue; } const drawn = this.symbols.resolver.facts(file)!; if (drawn.definitions.length || drawn.gaps.length || drawn.assignments.some(item => item.target.kind === 'constant')) root.gaps.push('Custom/reflective drawn route DSL requires a setup summary'); const scope = drawn.scopes.find(scope => scope.kind === 'file')!.key; this.walk(root, { ...local, file, scope, stack: [...frame.stack, file] }); continue; }
      if (['resources', 'resource'].includes(method)) { this.resource(root, local, call, values, options); continue; }
      if (['scope', 'namespace', 'controller', 'constraints', 'defaults', 'shallow'].includes(method)) { this.scope(root, local, call, values, options); continue; }
      if (['member', 'collection', 'new'].includes(method)) { if (!frame.resource || !call.blockScope || values.length || options.size) { this.unknown(root, local, call, 'Resource method scope requires a proven resource'); continue; } this.walk(root, { ...local, scope: call.blockScope, level: method as Frame['level'], path: frame.resource[method as 'member' | 'collection' | 'new'] }); continue; }
      if (methods.map(value => value.toLowerCase()).includes(method) || ['match', 'root'].includes(method)) { this.route(root, local, call, values, options); continue; }
      if (['direct', 'resolve'].includes(method)) { this.issue(site, 'URL generation helper execution is unsupported', 'url-helper-gap'); continue; }
      if (method === 'mount') { const mapping = call.expression.args.find(arg => arg.kind === 'hash' && arg.items.some(item => item.key.kind === 'constant')); const base = string(options.get('at')) ?? (mapping?.kind === 'hash' ? string(mapping.items.find(item => item.key.kind === 'constant')?.value) : undefined); this.unknown(root, local, call, 'Mounted engine/Rack dispatch requires its own route context', base ? join(frame.path, base) : frame.path); continue; }
      this.unknown(root, local, call, 'Custom route helper requires an indexed registration summary'); root.gaps.push('Custom route helpers can change route setup or previously declared routes');
    }
  }
  private configured(frame: Frame, options: Map<string, RubyExpression>): Frame {
    const result = { ...frame, constraints: { ...frame.constraints }, pathNames: { ...frame.pathNames }, conditions: [...frame.conditions] };
    const known = ['path', 'module', 'controller', 'action', 'to', 'as', 'format', 'constraints', 'defaults', 'via', 'on', 'only', 'except', 'path_names', 'param', 'shallow', 'shallow_path', 'shallow_prefix', 'concerns', 'at', 'host'];
    for (const [key, value] of options) {
      if (!known.includes(key) && !(value.kind === 'unknown' && /^\/(?:\\d\+|\[0-9\]\+|\[\^\\\/\]\+)\/$/.test(value.text))) result.conditions.push(`Unreviewed route option/default ${key}`);
      if (['path', 'module', 'controller', 'action', 'as', 'on', 'param', 'shallow_path', 'shallow_prefix'].includes(key) && string(value) === undefined && !(nil(value) && ['path', 'module', 'as'].includes(key))) result.conditions.push(`Dynamic route ${key}`);
      if (key === 'to' && !(value.kind === 'literal' && typeof value.value === 'string') && !(value.kind === 'call' && !value.receiver && value.method === 'redirect')) result.conditions.push('Dynamic/unreviewed route target: Rails :to requires a String or Rack/action callable');
    }
    const defaults = options.get('defaults'); if (defaults && defaults.kind !== 'hash') result.conditions.push('Dynamic route defaults');
    else if (defaults?.kind === 'hash') for (const item of defaults.items) { const key = string(item.key); if (key === 'controller' || key === 'action') { const selected = string(item.value); if (selected === undefined) result.conditions.push('Dynamic dispatch defaults'); else if (key === 'controller') result.controller = selected; else result.actionDefault = selected; } }
    if (options.has('format')) { const value = options.get('format'); const selected = bool(value) ?? (value?.kind === 'literal' && typeof value.value === 'string' ? value.value : undefined); if (selected === undefined) result.conditions.push('Dynamic/unreviewed format option'); else result.format = selected; }
    const map = options.get('constraints'); if (map && map.kind !== 'hash') result.conditions.push('Request/callable route constraint requires invocation proof');
    const fields = [...map?.kind === 'hash' ? map.items.map(item => [string(item.key), item.value] as const) : [], ...options].filter(([key]) => key && !['constraints', 'format'].includes(key));
    for (const [key, value] of fields) {
      if (key === 'host') { if (string(value)) result.host = string(value); else result.conditions.push('Unreviewed host constraint'); }
      if (value.kind === 'unknown' && /^\/(?:\\d\+|\[0-9\]\+)\/$/.test(value.text)) result.constraints[key!] = 'digits';
      else if (value.kind === 'unknown' && value.text === '/[^\\/]+/') result.constraints[key!] = 'segment-with-dots';
      else if (value.kind === 'unknown' && /^\/\[-?[A-Za-z0-9_]+\]\+\/$/.test(value.text)) result.conditions.push('Unreviewed segment constraint');
      else if (map?.kind === 'hash' && map.items.some(item => string(item.key) === key) && key !== 'host') result.conditions.push('Unreviewed request/path constraint');
    }
    const pathNames = options.get('path_names'); if (pathNames?.kind === 'hash') for (const item of pathNames.items) { const key = string(item.key), value = string(item.value); if (key && ['new', 'edit'].includes(key) && value !== undefined) result.pathNames[key] = value; else result.conditions.push('Dynamic/unreviewed resource path name'); }
    else if (pathNames) result.conditions.push('Dynamic resource path names');
    return result;
  }
  private scope(root: Root, frame: Frame, call: RubyCallFact, values: RubyExpression[], options: Map<string, RubyExpression>): void {
    if (!call.blockScope) { this.unknown(root, frame, call, 'Route scope needs an original block'); return; }
    const method = call.expression.method, selected = this.configured(frame, options), name = values[0] && string(values[0]);
    if (method === 'constraints' && values[0]) options = new Map(options).set('constraints', values[0]);
    if (method === 'defaults' && values[0]?.kind === 'hash') for (const item of values[0].items) if (string(item.key)) options.set(string(item.key)!, item.value);
    let child = this.configured(selected, options);
    const base = frame.resource && frame.level === 'resource' ? frame.resource.nested : frame.path;
    if (method === 'namespace') { if (!name || values.length !== 1) { this.unknown(root, frame, call, 'Namespace needs a literal name'); return; } const prefix = options.has('path') ? string(options.get('path')) ?? (nil(options.get('path')) ? '' : undefined) : name, module = options.has('module') ? string(options.get('module')) ?? (nil(options.get('module')) ? '' : undefined) : name; if (prefix === undefined || module === undefined) child.conditions.push('Dynamic namespace path/module'); else { child.path = join(base, prefix); child.module = [frame.module, module].filter(Boolean).join('/'); child.shallowPath = child.path; } }
    else { const prefix = string(options.get('path')) ?? (method === 'scope' ? name : undefined); if (values.length && method === 'scope' && name === undefined) child.conditions.push('Dynamic scope path'); child.path = prefix === undefined ? base : join(base, prefix); if (options.has('module')) { const module = string(options.get('module')); if (module === undefined) child.conditions.push('Dynamic scope module'); else child.module = [frame.module, module].filter(Boolean).join('/'); } }
    if (method === 'controller') { child.controller = name; if (!name || values.length !== 1) child.conditions.push('Dynamic controller scope'); }
    if (options.has('controller')) child.controller = string(options.get('controller'));
    if (options.has('action')) child.actionDefault = string(options.get('action'));
    if (method === 'shallow') child.shallow = true;
    if (options.has('shallow')) { if (bool(options.get('shallow')) === undefined) child.conditions.push('Dynamic shallow routing'); else child.shallow = bool(options.get('shallow'))!; }
    if (options.has('shallow_path')) { const shallow = string(options.get('shallow_path')); if (shallow === undefined) child.conditions.push('Dynamic shallow path'); else child.shallowPath = join(frame.shallowPath, shallow); }
    for (const key of ['only', 'except'] as const) if (options.has(key)) { const selected = strings(options.get(key)); if (!selected) child.conditions.push('Dynamic scoped resource actions'); else child[key] = selected; }
    if (frame.resource && ['scope', 'namespace', 'controller', 'shallow'].includes(method)) child.conditions.push('Resource scope wrapper needs a nested member/collection context summary');
    this.walk(root, { ...child, scope: call.blockScope, resource: ['constraints', 'defaults'].includes(method) ? frame.resource : undefined, level: ['constraints', 'defaults'].includes(method) ? frame.level : 'root' });
  }
  private concerns(root: Root, frame: Frame, call: RubyCallFact, values: RubyExpression[], options: Map<string, RubyExpression>): void {
    const selected = values.flatMap(value => strings(value) ?? []);
    if (!selected.length) { this.unknown(root, frame, call, 'Dynamic concern selection'); return; }
    for (const name of selected) {
      const concern = root.concerns.get(name), key = 'concern:' + name;
      if (!concern?.call.blockScope || frame.stack.includes(key)) { this.unknown(root, frame, call, 'Missing/cyclic route concern'); continue; }
      const facts = this.symbols.resolver.facts(concern.file)!, parameters = facts.locals.filter(local => local.scope === concern.call.blockScope && local.kind === 'parameter');
      const bindings = new Map(frame.bindings); if (parameters.length > 1 || parameters.some(parameter => facts.locals.some(local => local.name === parameter.name && local.kind === 'write'))) { this.unknown(root, frame, call, 'Mutable/unreviewed concern parameter'); continue; }
      if (parameters[0]) bindings.set(parameters[0].name, { ...call, kind: 'hash', items: [...options].map(([key, value]) => ({ key: { ...call, kind: 'symbol', name: key }, value })) });
      this.walk(root, { ...frame, conditions: [...frame.conditions, ...concern.conditions], file: concern.file, scope: concern.call.blockScope, stack: [...frame.stack, key], bindings, proof: [...frame.proof, ...this.proof(this.site(concern.file, concern.call), `Original invoked route concern ${name}`)] });
    }
  }
  private resource(root: Root, frame: Frame, call: RubyCallFact, values: RubyExpression[], options: Map<string, RubyExpression>): void {
    const selected = values.flatMap(value => strings(value) ?? []); if (!selected.length || selected.length > 128 || values.some(value => !strings(value))) { this.unknown(root, frame, call, 'Resources need bounded literal names'); return; }
    for (const name of selected) {
      const local = this.configured(frame, options), singleton = call.expression.method === 'resource', base = frame.resource && frame.level === 'resource' ? frame.resource.nested : frame.path;
      if (frame.resource && frame.level === 'resource' && frame.constraints[frame.resource.param]) local.constraints[frame.resource.nestedParam] = frame.constraints[frame.resource.param]!;
      local.conditions.push(...root.inflections.gaps);
      const resourcePath = string(options.get('path')) ?? name, controller = options.has('controller') && !nil(options.get('controller')) ? string(options.get('controller')) : singleton ? root.inflections.pluralize(name) : name, singular = root.inflections.singularize(string(options.get('as')) ?? name), param = string(options.get('param')) ?? 'id';
      if (!controller || !singular || !/^[A-Za-z_]\w*$/.test(param)) { this.unknown(root, local, call, 'Resource names/params need a reviewed inflection profile'); continue; }
      const shallow = options.has('shallow') ? bool(options.get('shallow')) : frame.shallow;
      if (shallow === undefined) local.conditions.push('Dynamic shallow option');
      if (options.has('shallow_path') && string(options.get('shallow_path')) !== undefined) local.shallowPath = join(frame.shallowPath, string(options.get('shallow_path'))!);
      const collection = join(base, resourcePath), member = singleton ? collection : join(shallow && frame.resource ? join(local.shallowPath, resourcePath) : collection, ':' + param);
      const nestedParam = singular + '_' + param;
      const resource: Resource = { name, controller, collection, member, nested: singleton ? collection : join(shallow && frame.resource ? join(local.shallowPath, resourcePath) : collection, ':' + nestedParam), new: join(collection, local.pathNames.new!), singleton, param, nestedParam };
      const resourceFrame: Frame = { ...local, controller, path: collection, scope: call.blockScope ?? frame.scope, resource, level: 'resource', shallow: shallow ?? false };
      if (call.blockScope) this.walk(root, resourceFrame);
      if (options.has('concerns')) this.concerns(root, resourceFrame, call, [options.get('concerns')!], new Map());
      const only = options.has('only') ? strings(options.get('only')) : frame.only, except = options.has('except') ? strings(options.get('except')) : frame.except;
      if (options.has('only') && !only || options.has('except') && !except || [...only ?? [], ...except ?? []].some(value => !actions.includes(value))) { this.unknown(root, local, call, 'Invalid/dynamic resource action restriction'); continue; }
      const allowed = (only ?? actions.filter(action => !(singleton && action === 'index') && !(root.apiOnly && ['new', 'edit'].includes(action)))).filter(action => !except?.includes(action));
      for (const action of ['index', 'create', 'new', 'edit', 'show', 'update', 'destroy']) {
        if (!allowed.includes(action) || singleton && action === 'index') continue;
        const routePath = ['index', 'create'].includes(action) ? collection : action === 'new' ? resource.new : action === 'edit' ? join(member, local.pathNames.edit!) : member;
        const verbs = action === 'create' ? ['POST'] : action === 'update' ? ['PATCH', 'PUT'] : action === 'destroy' ? ['DELETE'] : ['GET'];
        this.add(root, resourceFrame, call, routePath, controller, action, verbs, undefined, root.apiOnly === undefined && !only && ['new', 'edit'].includes(action) ? ['Resource new/edit defaults require selected api_only configuration'] : []);
      }
    }
  }
  private route(root: Root, frame: Frame, call: RubyCallFact, values: RubyExpression[], options: Map<string, RubyExpression>): void {
    const method = call.expression.method, local = this.configured(frame, options), raw = method === 'root' ? '/' : options.has('path') ? string(options.get('path')) : string(values[0]);
    if (raw === undefined || values.length > 1) { this.unknown(root, local, call, 'Dynamic/multiple Rails route path'); return; }
    let to = options.get('to') ?? (method === 'root' ? values[0] : undefined), controller = options.has('controller') ? string(options.get('controller')) : local.controller, action = options.has('action') ? string(options.get('action')) : local.actionDefault;
    const target = string(to); if (target?.includes('#')) [controller, action] = target.split('#'); else if (target) action = target;
    let child = raw;
    if (!action && method !== 'root' && /^[\w-]+$/.test(raw)) action = raw.replace(/-/g, '_');
    if (!to && !controller && raw.includes('#')) { [controller, action] = raw.split('#'); child = controller + '/' + action; }
    const shorthand = raw.replace(/\(\.:format\)$/, '');
    if (!to && !options.has('action') && !(local.controller && local.actionDefault) && /^\/?[-\w]+\/[-\w/]+$/.test(shorthand) && values[0]?.kind === 'literal') { const parts = shorthand.replace(/^\//, '').replace(/-/g, '_').split('/'); action = parts.pop(); controller = parts.join('/'); }
    if (target && target.split('#').length > 2) local.conditions.push('Invalid controller/action separator');
    const on = string(options.get('on')); let base = frame.path;
    if (on) { if (!frame.resource || !['member', 'collection', 'new'].includes(on)) local.conditions.push('Invalid/unproven resource on scope'); else base = frame.resource[on as 'member' | 'collection' | 'new']; }
    else if (frame.resource && frame.level === 'resource' && method !== 'root') { base = frame.resource.nested; if (frame.constraints[frame.resource.param]) local.constraints[frame.resource.nestedParam] = frame.constraints[frame.resource.param]!; }
    const verbs = method === 'match' ? strings(options.get('via'))?.map(value => value.toUpperCase()) : [method === 'root' ? 'GET' : method.toUpperCase()];
    if (!verbs?.length || verbs.some(value => !methods.includes(value) && value !== 'ALL')) { this.unknown(root, local, call, 'match requires reviewed literal via methods'); return; }
    const routePath = join(base, child), name = string(options.get('as'));
    if (to?.kind === 'call' && !to.receiver && to.method === 'redirect' && to.args[0]?.kind === 'literal' && typeof to.args[0].value === 'string') {
      const location = to.args[0].value, opts = to.args.filter(arg => arg.kind === 'hash').flatMap(arg => arg.items), statusValue = opts.find(item => string(item.key) === 'status')?.value;
      const status = statusValue === undefined ? 301 : statusValue.kind === 'literal' && typeof statusValue.value === 'number' && statusValue.value >= 300 && statusValue.value < 400 ? statusValue.value : undefined;
      const source = this.symbols.resolver.facts(frame.file)?.calls.find(item => item.expression.start === to.start && item.expression.end === to.end);
      if (!status || source?.blockScope || opts.some(item => string(item.key) !== 'status') || to.args.length > 2 || /%\{/.test(location)) local.conditions.push('Dynamic/parameterized redirect requires a response summary');
      root.entries.push({ site: this.site(frame.file, call), scope: call.scope, path: routePath, methods: verbs.includes('ALL') ? '*' : verbs, format: local.format, constraints: local.constraints, host: local.host, conditions: local.conditions, proof: local.proof, status, redirect: location }); return;
    }
    this.add(root, local, call, routePath, controller, action, verbs.includes('ALL') ? '*' : verbs, name);
  }
  private add(root: Root, frame: Frame, call: RubyCallFact, path: string, controller: string | undefined, action: string | undefined, methods: Entry['methods'], name?: string, extra: string[] = []): void {
    const selected = controller?.startsWith('/') ? controller.slice(1) : [frame.module, controller].filter(Boolean).join('/');
    root.entries.push({ site: this.site(frame.file, call), scope: call.scope, path, controller: selected || undefined, action, methods, format: frame.format, constraints: frame.constraints, host: frame.host, name, conditions: [...frame.conditions, ...extra, ...(!selected || !action ? ['Dynamic/Rack route target is unproven'] : [])], proof: frame.proof });
  }
  private emit(root: Root, entry: Entry, order: number): void {
    const source = this.context.files.get(entry.site.file)!, entity = this.context.graph.entities.get(source.id)!, analysis = fileAnalysis(entity.metadata.analysis), app = root.model.project.application;
    const parentId = app ? this.context.applicationIds.get(app.name) : undefined; if (!parentId) { this.issue(entry.site, 'Rails route deployment application is unavailable'); return; }
    const pattern = entry.unresolvedPrefix !== undefined ? { ...compileRailsPath(entry.path), status: 'partial' as const, alternatives: [], prefix: normalizeRailsPath(entry.unresolvedPrefix).split(/[:*(]/)[0] || '/', reason: 'Unresolved Rails registration competitor' } : compileRailsPath(entry.path, entry.format, entry.constraints), selected = !root.gaps.some(reason => /core dispatch summary|routing facade override/.test(reason)) && !entry.unresolvedPrefix && !entry.conditions.some(reason => /Dynamic.*(?:controller|action|module|dispatch|route target)/.test(reason)) && entry.controller && entry.action ? this.controllers.action(root.model, root.file, entry.site.file, entry.scope, entry.site, entry.controller, entry.action) : undefined;
    const gaps = [...root.gaps, ...entry.conditions, ...selected?.reason ? [selected.reason] : []], conditions = [...new Set([...root.model.conditions, ...gaps, ...selected?.conditions ?? []])];
    const verbs = entry.methods === '*' ? '*' : [...new Set([...entry.methods, ...entry.methods.includes('GET') ? ['HEAD'] : []])];
    const routing: RoutingContract = { version: 1, pattern, methods: verbs, executionContext: 'server', registration: { file: entry.site.file, line: entry.site.range.startLine, receiver: root.id }, mounts: [], middleware: [], conditions, ...(entry.host ? { host: entry.host } : {}), dispatch: { dialect: 'rails', root: root.id, order }, ...(entry.methods === '*' || entry.methods.includes('GET') && !entry.methods.includes('HEAD') ? { fallbackMethods: ['HEAD'] } : {}) };
    const method = entry.methods === '*' ? 'ANY' : entry.methods.join('|'), id = this.context.graph.id('api_endpoint', 'rails', root.id, entry.site.file, method, entry.path, entry.controller ?? '', entry.action ?? '', String(order));
    const proof = [...entry.proof, ...selected?.proof ?? []];
    this.context.graph.contain({ id, type: 'api_endpoint', name: `${method} ${entry.path}`, path: entry.site.file, language: 'ruby', parentId, sourceRange: entry.site.range, evidence: proof, metadata: { framework: 'rails', frameworkVersion: RAILS_VERSION, profile: root.model.profile, method, routePath: entry.path, routing, registration: gaps.length ? 'candidate' : 'registered', routeOrder: order, controller: entry.controller, action: entry.action, urlName: entry.name, ...(selected?.controller ? { controllerClass: selected.controller } : {}), ...(gaps.length || pattern.status === 'partial' ? { constraintsUnresolved: true } : {}), ...(entry.status ? { automaticResponse: true, statusCode: entry.status, redirect: entry.redirect } : {}) } });
    if (selected?.target) this.context.graph.relate(id, selected.target, 'handles', proof, { framework: 'rails', role: 'controller_action', conditions: selected.conditions });
    for (const [index, callback] of (selected?.callbacks ?? []).entries()) {
      if (callback.target && selected?.target) this.context.graph.relate(selected.target, callback.target, 'references', callback.proof, { framework: 'rails', role: 'action_callback', kind: callback.kind, order: index, action: entry.action, endpoint: id, conditions: callback.conditions }, JSON.stringify([id, callback.kind, callback.method, index]));
      else this.issue(this.site(callback.file, callback.site), 'Callback method is not an original proven source declaration', 'callback-gap');
    }
    entity.metadata.frameworkPacks = [...new Set([...Array.isArray(entity.metadata.frameworkPacks) ? entity.metadata.frameworkPacks : [], 'rails'])];
    if (analysis) analysis.features.framework = { status: 'partial', reason: 'Version-qualified Rails routes/resources/scopes/draw/concerns, original controller actions and callback references; dynamic DSL, engines and runtime callback effects retain gaps' };
    for (const gap of new Set(gaps)) this.issue(entry.site, gap);
  }
}
