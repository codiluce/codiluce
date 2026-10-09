import semver from 'semver';
import type { AnalysisContext } from '../../core/analyzer.js';
import { evidence, type Evidence } from '../../core/graph.js';
import type { RubyCallFact, RubyDefinitionFact, RubyExpression, RubySite } from '../facts.js';
import type { RubySymbols, RubyFrameworkMethod } from '../languages/ruby-symbols.js';
import type { RubyAutoloadModel, RubyAutoloadCatalog } from '../resolution/ruby-autoload.js';

interface Definition { fact: RubyDefinitionFact; file: string; id: string; proof: Evidence[] }
interface Level { name: string; definitions: Definition[]; methods: RubyFrameworkMethod[]; abstract: boolean }
export interface RailsCallback { kind: 'before' | 'after' | 'around'; method: string; target?: string; conditions: string[]; proof: Evidence[]; file: string; site: RubyCallFact }
export interface RailsAction { target?: string; controller?: string; proof: Evidence[]; conditions: string[]; reason?: string; callbacks: RailsCallback[] }
const text = (value: RubyExpression | undefined) => value?.kind === 'symbol' ? value.name : value?.kind === 'literal' && typeof value.value === 'string' ? value.value : undefined;
const names = (value: RubyExpression | undefined): string[] | undefined => !value ? undefined : value.kind === 'array' ? value.items.every(item => text(item) !== undefined) ? value.items.map(item => text(item)!) : undefined : text(value) === undefined ? undefined : [text(value)!];
const options = (call: RubyCallFact) => new Map(call.expression.args.flatMap(arg => arg.kind === 'hash' ? arg.items : []).map(item => [text(item.key), item.value]));

/** Proven original class/method identities with a reviewed Rails dispatch
 * boundary. Callbacks are configuration references, never fabricated calls. */
export class RailsControllers {
  constructor(private readonly context: AnalysisContext, private readonly symbols: RubySymbols, private readonly catalog: RubyAutoloadCatalog, private readonly version: string) {}
  private proof(file: string, site: RubySite, reason: string): Evidence[] { return [{ ...evidence('framework', 'rails', file, site.range.startLine, reason), analyzerVersion: this.version, endLine: site.range.endLine }]; }
  constant(model: RubyAutoloadModel, path: string): string | undefined {
    if (!/^[a-zA-Z_][a-zA-Z0-9_/]*$/.test(path) || path.includes('//')) return;
    // Controller parameter camelization uses ActiveSupport, independently of
    // a loader-specific Zeitwerk inflector or basename override.
    const camelize = (name: string) => {
      const word = (value: string) => model.main.acronyms.get(value) ?? (value[0]?.toUpperCase() ?? '') + value.slice(1);
      return name.replace(/^[a-z\d]*/, word).replace(/_([a-z\d]*)/g, (_all, value: string) => word(value));
    };
    return path.split('/').map((part, i, parts) => camelize(part + (i === parts.length - 1 ? '_controller' : ''))).join('::');
  }
  action(model: RubyAutoloadModel, origin: string, file: string, scope: string, site: RubySite, controller: string, action: string): RailsAction {
    const proof = this.proof(file, site, `Reviewed Rails controller/action dispatch ${controller}#${action}`), conditions = [...model.conditions], chain: Level[] = [], callbacks: RailsCallback[] = [];
    const fail = (reason: string): RailsAction => ({ proof, conditions, reason, callbacks });
    const constant = this.constant(model, controller); if (!constant) return fail('Controller parameter is outside reviewed constant camelization');
    if (model.gaps.length) return fail(model.gaps.join('; '));
    let value = this.symbols.frameworkConstant(origin, file, scope, '::' + constant, site, proof), native: string | undefined;
    const seen = new Set<string>();
    while (value.kind === 'namespace') {
      if (chain.length >= 32 || seen.has(value.name)) return fail('Cyclic/deep Rails controller inheritance'); seen.add(value.name);
      if (!value.definitions.length || value.definitions.some(def => def.fact.kind !== 'class')) return fail('Controller is not an original indexed class');
      const methods = this.symbols.frameworkMethods(origin, value.name); conditions.push(...methods.conditions); if (methods.reason) return fail(methods.reason);
      const singleton = this.symbols.frameworkMethods(origin, value.name, true);
      if (singleton.reason || singleton.methods.some(method => ['action_methods', 'internal_methods', 'abstract?', 'abstract!', 'method_for_action', '_handle_action', 'process', 'action', 'dispatch', 'before_action', 'after_action', 'around_action', 'skip_before_action', 'skip_after_action', 'skip_around_action', 'prepend_before_action', 'prepend_after_action', 'prepend_around_action', 'append_before_action', 'append_after_action', 'append_around_action', 'set_callback', 'skip_callback', 'reset_callbacks'].includes(method.fact.name))) return fail(singleton.reason ?? 'Custom controller/callback facade requires a dispatch summary');
      const declarations = value.definitions.flatMap(definition => (this.symbols.resolver.facts(definition.file)?.calls ?? []).filter(call => !call.expression.receiver && call.expression.method === 'abstract!' && this.symbols.resolver.ancestors(definition.file, call.scope).find(scope => scope.kind !== 'control')?.key === definition.fact.bodyScope).map(call => ({ definition, call })));
      if (declarations.some(({ definition, call }) => call.expression.args.length || this.symbols.resolver.ancestors(definition.file, call.scope).some(scope => scope.conditional))) return fail('Conditional/custom abstract controller boundary');
      chain.push({ name: value.name, definitions: value.definitions, methods: methods.methods, abstract: declarations.length > 0 }); proof.push(...value.proof);
      const parents = value.definitions.filter(def => def.fact.superclass); if (!parents.length) return fail('Controller has no reviewed ActionController superclass');
      const parent = parents[0]!, expression = parent.fact.superclass!; if (expression.kind !== 'constant') return fail('Dynamic controller superclass');
      const spelling = expression.name.replace(/^::/, '');
      if (['ActionController::Base', 'ActionController::API', 'ActionController::Metal'].includes(spelling)) { native = spelling; proof.push(...this.proof(parent.file, parent.fact, `Reviewed stock ${spelling} dispatch boundary`)); break; }
      value = this.symbols.frameworkConstant(origin, parent.file, parent.fact.scope, expression.name, expression, proof);
    }
    if (!native) return fail(value.kind === 'unknown' ? value.reason : 'Controller superclass is not a reviewed Rails boundary');
    if (chain.some(level => level.methods.some(method => ['action_methods', 'process_action', 'method_missing', 'method_for_action', '_handle_action', 'process', 'dispatch', '_run_process_action_callbacks'].includes(method.fact.name)))) return fail('Custom Rails action dispatch requires a method summary');
    const selected = new Map<string, RubyFrameworkMethod>();
    for (const level of chain) for (const method of level.methods) if (!selected.has(method.fact.name)) selected.set(method.fact.name, method);
    // 8.1 excludes underscore-prefixed public methods; older reviewed versions
    // expose them. A crossing requirement is not one selected behavior.
    if (action.startsWith('_')) {
      const profile = model.profile, hidden = profile.version ? semver.satisfies(profile.version, '>=8.1.0') : profile.range && semver.subset(profile.range, '>=8.1.0');
      const visible = profile.version ? semver.satisfies(profile.version, '<8.1.0') : profile.range && semver.subset(profile.range, '<8.1.0');
      if (hidden || !visible) return fail(hidden ? 'Rails 8.1 excludes underscore-prefixed actions' : 'Underscore action behavior requires a selected Rails version');
    }
    const method = selected.get(action), abstract = chain.findIndex(level => level.abstract), owner = chain.findIndex(level => level.methods.some(item => item.id === method?.id));
    if (!method || method.visibility !== 'public' || method.reason || abstract >= 0 && owner >= abstract && owner !== 0) return fail(method?.reason ?? 'No original public Rails action method; abstract/internal methods, implicit templates and generated actions remain unsupported');
    for (const level of [...chain].reverse()) {
      for (const definition of level.definitions) {
        const facts = this.symbols.resolver.facts(definition.file); if (!facts) continue;
        const calls = facts.calls.filter(call => this.symbols.resolver.ancestors(definition.file, call.scope).find(scope => scope.kind !== 'control')?.key === definition.fact.bodyScope && (!call.expression.receiver || call.expression.receiver.kind === 'identifier' && call.expression.receiver.name === 'self') && /^(?:(?:append|prepend|skip)_)?(?:before|after|around)_action$/.test(call.expression.method)).sort((a, b) => a.start - b.start);
        for (const call of calls) {
          if (native === 'ActionController::Metal') return fail('Metal callbacks require an indexed callback module summary');
          const opts = options(call), only = names(opts.get('only')), except = names(opts.get('except')), conditional = this.symbols.resolver.ancestors(definition.file, call.scope).some(scope => scope.conditional);
          if ([...opts.keys()].some(key => !key || !['only', 'except', 'if', 'unless', 'raise'].includes(key))) { conditions.push('Unreviewed callback option requires initialization proof'); continue; }
          if (opts.has('only') && !only || opts.has('except') && !except) { conditions.push('Dynamic callback action filter'); continue; }
          if (only && !only.includes(action) || except?.includes(action)) continue;
          const args = call.expression.args.filter(arg => arg.kind !== 'hash'), filters = args.flatMap(arg => names(arg) ?? []), kind = /(?:^|_)(before|after|around)_action$/.exec(call.expression.method)![1] as RailsCallback['kind'];
          if (call.blockScope || !filters.length || args.some(arg => !names(arg))) { conditions.push('Block/dynamic callback requires an original callback summary'); continue; }
          for (const filter of filters) {
            if (call.expression.method.startsWith('skip_')) { const index = callbacks.findIndex(item => item.kind === kind && item.method === filter), raise = opts.get('raise'); if (conditional || opts.has('if') || opts.has('unless')) { if (index >= 0) callbacks[index]!.conditions.push('Conditional callback skip requires predicate/initialization proof'); conditions.push('Conditional callback skip remains an invocation candidate'); } else if (index >= 0) callbacks.splice(index, 1); else if (!(raise?.kind === 'literal' && raise.value === false)) return fail('Skipping an unproven inherited callback may fail during class initialization'); continue; }
            const target = selected.get(filter), item: RailsCallback = { kind, method: filter, target: target?.reason ? undefined : target?.id, conditions: [...conditional ? ['Conditional callback declaration requires initialization proof'] : [], ...opts.has('if') || opts.has('unless') ? ['Callback predicate requires invocation proof'] : [], 'Callback order is registration order; before/around can halt or replace execution and after callbacks unwind'], proof: [...this.proof(definition.file, call, `Original Rails ${call.expression.method} callback ${filter}`), ...target?.proof ?? []], file: definition.file, site: call };
            const duplicate = callbacks.findIndex(old => old.kind === kind && old.method === filter); if (duplicate >= 0 && !conditional) callbacks.splice(duplicate, 1);
            if (call.expression.method.startsWith('prepend_')) callbacks.unshift(item); else callbacks.push(item);
          }
        }
      }
    }
    return { target: method.id, controller: chain[0]!.definitions[0]!.id, proof: [...proof, ...method.proof], conditions: [...new Set(conditions)], callbacks };
  }
}
