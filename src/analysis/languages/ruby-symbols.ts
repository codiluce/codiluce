import type { AnalysisContext, ScannedFile } from '../../core/analyzer.js';
import { evidence, type CallSites, type Evidence } from '../../core/graph.js';
import { fileAnalysis, type RubyCallFact, type RubyDefinitionFact, type RubyExpression, type RubyScopeFact, type RubySite, type RubySyntaxFacts } from '../facts.js';
import type { RubyLoad, RubyResolver } from '../resolution/ruby.js';
import type { RubyAutoloadCatalog, RubyAutoloadCandidate } from '../resolution/ruby-autoload.js';

export const RUBY_SYMBOL_VERSION = '3';
interface Definition { fact: RubyDefinitionFact; file: string; id: string; proof: Evidence[] }
interface Constant { order: number; name: string; definition?: Definition; value?: RubyValue; reason?: string; implicit?: boolean; proof: Evidence[] }
interface Method { order: number; definition: Definition; name: string; owner: string; singleton: boolean; visibility: string; reason?: string }
interface Unit { file: ScannedFile; facts: RubySyntaxFacts; scopes: Map<string, RubyScopeFact>; nesting: Map<string, string[] | string>; marks: Map<string, number>; activation: Evidence[]; invoked?: Set<string> }
interface Barrier { order: number; reason: string; owner?: string; constants?: boolean; methods?: boolean }
interface Pending { order: number; file?: ScannedFile; reason?: string; proof: Evidence[]; source: string; site: RubySite }
interface Activation { file: string; site: RubySite; name: string; target?: string; kind: 'file' | 'implicit'; status: string; reason?: string; proof: Evidence[] }
interface Snapshot { origin: string; order: number; units: Map<string, Unit>; constants: Map<string, Constant[]>; methods: Map<string, Method[]>; barriers: Barrier[]; loaded: Set<string>; loading: Set<string>; visits: number; pending: Map<string, Pending>; activating: Set<string>; activations: Activation[]; conditions: string[]; refinements: Map<string, RubyLoad>; invalid?: string }
export type RubyValue =
  | { kind: 'namespace'; name: string; definitions: Definition[]; proof: Evidence[] }
  | { kind: 'instance'; name: string; proof: Evidence[] }
  | { kind: 'function'; id: string; proof: Evidence[] }
  | { kind: 'constructor'; name: string; target?: string; proof: Evidence[] }
  | { kind: 'literal'; value: string | number | boolean | null; proof: Evidence[] }
  | { kind: 'local'; proof: Evidence[] }
  | { kind: 'unknown'; reason: string; proof: Evidence[] };
export interface RubyFrameworkMethod { id: string; file: string; fact: RubyDefinitionFact; visibility: string; proof: Evidence[]; reason?: string }
const unknown = (reason: string, proof: Evidence[] = []): RubyValue => ({ kind: 'unknown', reason, proof });
const siteKey = (site: RubySite) => `${site.start}:${site.end}`;
const methodKey = (owner: string, singleton: boolean, name: string) => JSON.stringify([owner, singleton, name]);
const MUTATIONS = new Set(['alias_method', 'undef_method', 'remove_method', 'define_method', 'define_singleton_method', 'class_eval', 'module_eval', 'instance_eval', 'eval', 'include', 'prepend', 'extend', 'module_function', 'refine', 'using', 'private_class_method', 'public_class_method', 'attr', 'attr_reader', 'attr_writer', 'attr_accessor', 'send', '__send__', 'public_send', 'freeze']);
const CONSTANT_MUTATIONS = new Set(['const_set', 'remove_const', 'private_constant', 'const_missing']);
const HOOKS = new Set(['inherited', 'included', 'prepended', 'extended', 'append_features', 'prepend_features', 'method_added', 'singleton_method_added', 'const_added']);

/** Source snapshots, never Ruby execution. Each origin follows only its recorded
 * unconditional requires. Deferred bodies use the completed source snapshot and
 * retain an invocation-time condition; unrelated indexed files are not globals. */
export class RubySymbols {
  private readonly snapshots = new Map<string, Snapshot>();
  constructor(readonly context: AnalysisContext, readonly resolver: RubyResolver, readonly autoload?: RubyAutoloadCatalog) {}
  private proof(file: string, site: RubySite, reason: string): Evidence[] {
    return [{ ...evidence('syntax', 'ruby-symbols', file, site.range.startLine, reason), analyzerVersion: RUBY_SYMBOL_VERSION, endLine: site.range.endLine }];
  }
  private ancestors(unit: Unit, scope: string): RubyScopeFact[] {
    const result: RubyScopeFact[] = [], seen = new Set<string>(); let current = unit.scopes.get(scope);
    while (current && !seen.has(current.key)) { result.push(current); seen.add(current.key); current = current.parent ? unit.scopes.get(current.parent) : undefined; }
    return result;
  }
  private nesting(unit: Unit, scope: string): string[] | string {
    for (const ancestor of this.ancestors(unit, scope)) {
      if (ancestor.kind === 'singleton') return 'Singleton-class constant and receiver context is unresolved';
      const known = unit.nesting.get(ancestor.key); if (known !== undefined) return known;
    }
    return [];
  }
  private deferred(unit: Unit, scope: string): boolean { return this.ancestors(unit, scope).some(item => item.deferred && !unit.invoked?.has(item.key)); }
  private conditional(unit: Unit, scope: string): boolean { return this.ancestors(unit, scope).some(item => item.conditional); }
  private barrier(snapshot: Snapshot, order: number, name: string, feature: 'constants' | 'methods'): string | undefined {
    return snapshot.invalid ?? snapshot.barriers.find(item => item.order <= order && item[feature] && (item.owner === undefined || item.owner === name || name.startsWith(item.owner + '::')))?.reason;
  }
  private entries(snapshot: Snapshot, name: string, order: number): Constant[] { return (snapshot.constants.get(name) ?? []).filter(item => item.order <= order); }
  private activate(snapshot: Snapshot, name: string, order: number, unit: Unit, scope: string, site: RubySite): boolean {
    const registered = snapshot.pending.get(name), pending = registered && registered.order <= order ? registered : undefined;
    const candidate: RubyAutoloadCandidate | undefined = pending ? { name, kind: 'file', file: pending.file, path: pending.file?.path ?? pending.source, directories: [], shadowed: [], loader: 'main', proof: pending.proof, conditions: [], reason: pending.reason } : this.autoload?.lookup(snapshot.origin, name, unit.file.path, this.deferred(unit, scope));
    if (!candidate) return false;
    const proof = [...this.proof(unit.file.path, site, `Original constant access activates ${name}`), ...candidate.proof], activation: Activation = { file: unit.file.path, site, name, kind: candidate.kind, target: candidate.file?.id, status: 'unresolved', proof };
    snapshot.activations.push(activation); snapshot.conditions = [...new Set([...snapshot.conditions, ...candidate.conditions, ...this.deferred(unit, scope) ? ['Lazy constant activation in a deferred body requires invocation timing proof'] : []])];
    let reason = candidate.reason;
    if (!reason && this.conditional(unit, scope)) reason = 'Conditional autoload activation requires a branch and initialization-order summary';
    if (!reason && snapshot.activating.has(name)) reason = `Cyclic autoload activation for ${name}`;
    if (reason) { activation.reason = reason; this.addConstant(snapshot, { order: ++snapshot.order, name, reason, proof }); unit.marks.set(siteKey(site), snapshot.order); return true; }
    if (candidate.kind === 'implicit') {
      activation.status = 'resolved'; this.addConstant(snapshot, { order: ++snapshot.order, name, implicit: true, value: { kind: 'namespace', name, definitions: [], proof }, proof }); unit.marks.set(siteKey(site), snapshot.order); return true;
    }
    if (!candidate.file) { activation.reason = 'Autoload has no indexed original source'; this.addConstant(snapshot, { order: ++snapshot.order, name, reason: activation.reason, proof }); return true; }
    snapshot.activating.add(name);
    this.build(snapshot, candidate.file, 0, proof);
    snapshot.activating.delete(name);
    const entries = this.entries(snapshot, name, snapshot.order);
    const boundary = this.barrier(snapshot, snapshot.order, name, 'constants');
    if (boundary || !entries.length || entries.some(entry => entry.reason)) {
      activation.reason = boundary ?? entries.find(entry => entry.reason)?.reason ?? `Autoload source ${candidate.path} does not define expected constant ${name}`;
      snapshot.barriers.push({ order: ++snapshot.order, constants: true, methods: true, reason: activation.reason });
      this.addConstant(snapshot, { order: snapshot.order, name, reason: activation.reason, proof });
    } else activation.status = 'resolved';
    unit.marks.set(siteKey(site), snapshot.order); return true;
  }
  private constant(snapshot: Snapshot, name: string, order: number, depth = 0, query?: { unit: Unit; scope: string; site: RubySite }): RubyValue {
    if (depth > 64) return unknown('Ruby constant alias lookup budget exceeded');
    const barrier = this.barrier(snapshot, order, name, 'constants'); if (barrier) return unknown(barrier);
    let entries = this.entries(snapshot, name, order);
    if (!entries.length && query && this.activate(snapshot, name, order, query.unit, query.scope, query.site)) { order = snapshot.order; const boundary = this.barrier(snapshot, order, name, 'constants'); if (boundary) return unknown(boundary); entries = this.entries(snapshot, name, order); }
    if (!entries.length) return unknown(`No initialized indexed constant ${name}`);
    if (entries.length > 128) return unknown(`Ruby namespace/reopening candidate budget exceeded for ${name}`);
    if (entries.some(item => item.reason)) return unknown(entries.find(item => item.reason)!.reason!, entries.flatMap(item => item.proof));
    const writes = entries.filter(item => !item.definition && !item.implicit);
    if (writes.length) {
      if (writes.length !== 1 || entries.length !== 1) return unknown(`Constant ${name} is reassigned or reopened through an alias`, entries.flatMap(item => item.proof));
      let value = writes[0]!.value ?? unknown(`Constant ${name} has no bounded value`);
      if (value.kind === 'namespace' && value.name !== name) value = this.constant(snapshot, value.name, order, depth + 1, query);
      return { ...value, proof: [...writes[0]!.proof, ...value.proof] };
    }
    const definitions = entries.flatMap(item => item.definition ? [item.definition] : []);
    if (entries.some(item => item.implicit) && definitions.some(item => item.fact.kind === 'class')) return unknown(`Implicit namespace ${name} cannot be reopened as a class`);
    if (!definitions.length) return { kind: 'namespace', name, definitions: [], proof: entries.flatMap(item => item.proof) };
    if (new Set(definitions.map(item => item.fact.kind)).size !== 1) return unknown(`Class/module kind mismatch for reopened ${name}`);
    const explicit = definitions.filter(item => item.fact.superclass);
    if (explicit.some(item => item.fact.superclass?.kind !== 'constant') || new Set(explicit.map(item => item.fact.superclass?.kind === 'constant' ? item.fact.superclass.name : '')).size > 1 || !definitions[0]!.fact.superclass && explicit.length) return unknown(`Reopened ${name} has an unproved or incompatible superclass`);
    return { kind: 'namespace', name, definitions, proof: entries.flatMap(item => item.proof) };
  }
  private head(snapshot: Snapshot, unit: Unit, scope: string, name: string, order: number, site: RubySite): RubyValue {
    const nesting = this.nesting(unit, scope); if (typeof nesting === 'string') return unknown(nesting);
    for (const owner of nesting) {
      const candidate = `${owner}::${name}`;
      if (this.entries(snapshot, candidate, order).length || snapshot.pending.get(candidate)?.order! <= order || this.autoload?.lookup(snapshot.origin, candidate, unit.file.path, this.deferred(unit, scope))) return this.constant(snapshot, candidate, order, 0, { unit, scope, site });
    }
    // Ancestors precede Object fallback. Do not guess past an unreviewed
    // superclass or mixin when a lexical constant was not found.
    const owner = nesting[0];
    if (owner) {
      const barrier = this.barrier(snapshot, order, owner, 'constants'); if (barrier) return unknown(barrier);
      if (this.entries(snapshot, owner, order).some(item => item.definition?.fact.superclass)) return unknown(`Inherited constant lookup for ${owner} requires an ancestor summary`);
    }
    return this.constant(snapshot, name, order, 0, { unit, scope, site });
  }
  private resolveConstant(snapshot: Snapshot, unit: Unit, scope: string, spelling: string, order: number, depth = 0, site?: RubySite): RubyValue {
    if (depth > 64) return unknown('Ruby constant lookup budget exceeded');
    const absolute = spelling.startsWith('::'), parts = spelling.replace(/^::/, '').split('::');
    if (!parts.length || parts.some(part => !/^\p{Lu}[\p{ID_Continue}]*$/u.test(part))) return unknown('Dynamic Ruby constant path is unsupported');
    const original = site ?? unit.scopes.get(scope)!;
    let value = absolute ? this.constant(snapshot, parts[0]!, order, 0, { unit, scope, site: original }) : this.head(snapshot, unit, scope, parts[0]!, order, original);
    for (const part of parts.slice(1)) {
      if (value.kind !== 'namespace') return value.kind === 'unknown' ? value : unknown('Qualified constant receiver is not an indexed namespace');
      const name = `${value.name}::${part}`, direct = this.entries(snapshot, name, order);
      if (!direct.length && value.definitions.some(item => item.fact.superclass)) return unknown(`Qualified inherited constant ${name} requires an ancestor summary`);
      value = this.constant(snapshot, name, Math.max(order, unit.marks.get(siteKey(original)) ?? order), 0, { unit, scope, site: original });
    }
    return value;
  }
  private targetName(snapshot: Snapshot, unit: Unit, scope: string, spelling: string, order: number): string | undefined {
    const parts = spelling.replace(/^::/, '').split('::');
    if (parts.length > 1) {
      const parent = this.resolveConstant(snapshot, unit, scope, `${spelling.startsWith('::') ? '::' : ''}${parts.slice(0, -1).join('::')}`, order);
      return parent.kind === 'namespace' ? `${parent.name}::${parts.at(-1)}` : undefined;
    }
    const nesting = this.nesting(unit, scope);
    return typeof nesting === 'string' ? undefined : spelling.startsWith('::') || !nesting.length ? parts[0] : `${nesting[0]}::${parts[0]}`;
  }
  private definition(unit: Unit, fact: RubyDefinitionFact): Definition | undefined {
    const id = this.context.syntax?.get(unit.file.path)?.declarations.get(fact.key); return id ? { fact, file: unit.file.path, id, proof: unit.activation } : undefined;
  }
  private addConstant(snapshot: Snapshot, entry: Constant): void { const entries = snapshot.constants.get(entry.name) ?? []; entries.push(entry); snapshot.constants.set(entry.name, entries); }
  private namespace(snapshot: Snapshot, unit: Unit, fact: RubyDefinitionFact, order: number): void {
    if (fact.superclass) { this.value(snapshot, unit, fact.scope, fact.superclass, order); order = Math.max(order, snapshot.order); }
    const nesting = this.nesting(unit, fact.scope); let name = this.targetName(snapshot, unit, fact.scope, fact.name, order);
    if (!name || typeof nesting === 'string') { unit.nesting.set(fact.bodyScope, 'Namespace owner is not initialized by indexed source'); return; }
    if (!this.entries(snapshot, name, order).length && !snapshot.activating.has(name) && this.autoload?.lookup(snapshot.origin, name)?.file?.path !== unit.file.path) this.activate(snapshot, name, order, unit, fact.scope, fact);
    order = Math.max(order, snapshot.order);
    const existing = this.entries(snapshot, name, order).length ? this.constant(snapshot, name, order) : undefined;
    if (existing?.kind === 'namespace') name = existing.name;
    const definition = this.definition(unit, fact);
    const reason = this.conditional(unit, fact.scope) ? `Conditional namespace definition ${name}` : existing && existing.kind !== 'namespace' ? 'Class/module reopening receiver is not a bounded namespace' : !definition ? 'Original declaration identity is unavailable' : undefined;
    if (!this.entries(snapshot, name, order).some(entry => entry.definition?.id === definition?.id)) this.addConstant(snapshot, { name, order, definition, reason, proof: [...unit.activation, ...this.proof(unit.file.path, fact, `Original ${fact.kind} definition/reopening ${name}`)] });
    unit.nesting.set(fact.bodyScope, reason ?? [name, ...nesting]);
  }
  private registerMethod(snapshot: Snapshot, unit: Unit, fact: RubyDefinitionFact, order: number, visibility: Map<string, string>): void {
    const definition = this.definition(unit, fact), nesting = this.nesting(unit, fact.scope);
    unit.nesting.set(fact.bodyScope, nesting);
    if (!definition || typeof nesting === 'string') return;
    let owner = nesting[0] ?? '', singleton = fact.kind === 'singleton_method';
    if (singleton && fact.receiver?.kind !== 'identifier') {
      const receiver = fact.receiver && this.value(snapshot, unit, fact.scope, fact.receiver, order);
      if (receiver?.kind !== 'namespace') { unit.nesting.set(fact.bodyScope, 'Singleton method receiver is not a bounded namespace'); snapshot.barriers.push({ order, methods: true, reason: 'Singleton definition has an unbounded receiver identity' }); return; } owner = receiver.name;
    } else if (singleton && fact.receiver?.kind === 'identifier' && fact.receiver.name !== 'self') {
      unit.nesting.set(fact.bodyScope, 'Object singleton methods require an object identity summary'); snapshot.barriers.push({ order, methods: true, reason: 'Object singleton definition can override concrete receiver dispatch' }); return;
    } else if (singleton && !owner) { unit.nesting.set(fact.bodyScope, 'Top-level singleton receiver requires a runtime self summary'); return; }
    const key = methodKey(owner, singleton, fact.name), entries = snapshot.methods.get(key) ?? [];
    entries.push({ order, definition, name: fact.name, owner, singleton, visibility: visibility.get(fact.scope) ?? 'public', ...(this.conditional(unit, fact.scope) ? { reason: `Conditional method definition ${fact.name}` } : {}) }); snapshot.methods.set(key, entries);
    if (HOOKS.has(fact.name) && (singleton || ['Class', 'Module', 'Object', 'BasicObject'].includes(owner))) snapshot.barriers.push({ order, methods: true, constants: true, reason: `Ruby ${fact.name} hook requires a bounded activation summary` });
  }
  private processCall(snapshot: Snapshot, unit: Unit, call: RubyCallFact, order: number, visibility: Map<string, string>): void {
    if (call.bare && this.localScope(unit, call.scope, call.expression.method, call.start)) return;
    const expression = call.expression, nesting = this.nesting(unit, call.scope), owner = typeof nesting === 'string' ? undefined : nesting[0] ?? '';
    if (['public', 'private', 'protected'].includes(expression.method) && !expression.receiver) {
      if (!expression.args.length) visibility.set(call.scope, expression.method);
      else snapshot.barriers.push({ order, owner, methods: true, reason: 'Named or wrapped Ruby visibility changes require a method summary' });
    }
    if (MUTATIONS.has(expression.method) || CONSTANT_MUTATIONS.has(expression.method)) {
      const receiver = expression.receiver && this.value(snapshot, unit, call.scope, expression.receiver, order);
      const target = receiver?.kind === 'namespace' ? receiver.name : expression.receiver && !(expression.receiver.kind === 'identifier' && expression.receiver.name === 'self') ? undefined : owner;
      snapshot.barriers.push({ order, owner: target && !['Object', 'Class', 'BasicObject', 'Kernel'].includes(target) ? target : undefined, methods: MUTATIONS.has(expression.method), constants: CONSTANT_MUTATIONS.has(expression.method) || ['include', 'prepend', 'extend', 'class_eval', 'module_eval', 'eval', 'send', '__send__', 'public_send', 'freeze'].includes(expression.method), reason: `Ruby ${expression.method} requires a runtime namespace/method summary` });
    }
  }
  private build(snapshot: Snapshot, file: ScannedFile, depth = 0, activation: Evidence[] = []): void {
    if (snapshot.loading.has(file.path)) { snapshot.barriers.push({ order: ++snapshot.order, constants: true, methods: true, reason: 'Cyclic Ruby initialization requires a runtime load-order summary' }); return; }
    if (snapshot.loaded.has(file.path)) return;
    if (depth > 64 || snapshot.units.size >= 256 || snapshot.visits > 200_000) { snapshot.invalid = 'Ruby source snapshot budget exceeded'; return; }
    const facts = this.resolver.facts(file.path);
    if (!facts?.complete) { snapshot.barriers.push({ order: ++snapshot.order, constants: true, methods: true, reason: `Incomplete Ruby syntax in ${file.path}` }); return; }
    const unit: Unit = { file, facts, scopes: new Map(facts.scopes.map(scope => [scope.key, scope])), nesting: new Map(), marks: new Map(), activation };
    snapshot.units.set(file.path, unit); snapshot.loading.add(file.path);
    const events = [
      ...facts.definitions.map(fact => ({ at: fact.start, kind: 'definition' as const, fact })),
      ...facts.assignments.map(fact => ({ at: fact.end, kind: 'assignment' as const, fact })),
      ...facts.calls.map(fact => ({ at: fact.end, kind: 'call' as const, fact })),
      ...facts.references.map(fact => ({ at: fact.end, kind: 'reference' as const, fact })),
      ...facts.gaps.filter(fact => fact.kind === 'scope' || /aliases|undef can/.test(fact.reason)).map(fact => ({ at: fact.start, kind: 'gap' as const, fact })),
    ].sort((a, b) => a.at - b.at || (a.kind === 'definition' ? -1 : b.kind === 'definition' ? 1 : 0));
    const visibility = new Map<string, string>(), loads = new Map(this.resolver.fileLoads(file.path).map(load => [siteKey(load.site), load]));
    const inputs = (source: string) => { const project = this.resolver.owner(source); return JSON.stringify([project?.loadPaths.map(item => item.path), project?.cwd]); };
    for (const event of events) {
      if (++snapshot.visits > 200_000) { snapshot.invalid = 'Ruby source snapshot event budget exceeded'; break; }
      const order = ++snapshot.order, { fact } = event; unit.marks.set(siteKey(fact), order);
      const deferred = this.deferred(unit, fact.scope);
      if (deferred) {
        if (event.kind === 'definition') { unit.nesting.set(event.fact.bodyScope, 'Definitions inside deferred Ruby bodies require invocation and activation proof'); snapshot.barriers.push({ order, methods: true, constants: ['class', 'module'].includes(event.fact.kind), reason: 'Deferred definition requires invocation and activation proof' }); }
        if (event.kind === 'call' && (MUTATIONS.has(event.fact.expression.method) || CONSTANT_MUTATIONS.has(event.fact.expression.method))) this.processCall(snapshot, unit, event.fact, order, visibility);
        if (event.kind === 'assignment' && event.fact.target.kind === 'constant') snapshot.barriers.push({ order, constants: true, reason: 'Deferred constant assignment requires invocation and activation proof' });
        if (event.kind === 'gap') snapshot.barriers.push({ order, methods: true, constants: event.fact.kind === 'scope', reason: event.fact.reason });
        if (event.kind === 'call' && loads.has(siteKey(fact))) snapshot.barriers.push({ order, methods: true, constants: true, reason: 'Deferred Ruby load requires invocation and initialization proof' });
        continue;
      }
      if (event.kind === 'definition') {
        if (['class', 'module'].includes(event.fact.kind)) this.namespace(snapshot, unit, event.fact, order);
        else this.registerMethod(snapshot, unit, event.fact, order, visibility);
      } else if (event.kind === 'assignment' && event.fact.target.kind === 'constant') {
        const name = this.targetName(snapshot, unit, fact.scope, event.fact.target.name, order);
        if (name) this.addConstant(snapshot, { name, order, value: this.value(snapshot, unit, fact.scope, event.fact.value, order), proof: [...unit.activation, ...this.proof(file.path, fact, `Original constant assignment ${name}`)], ...(this.conditional(unit, fact.scope) || event.fact.augmentation ? { reason: `Conditional or augmented constant assignment ${name}` } : {}) });
        else snapshot.barriers.push({ order, constants: true, reason: 'Constant assignment receiver is not an initialized indexed namespace' });
      } else if (event.kind === 'gap') snapshot.barriers.push({ order, methods: true, constants: event.fact.kind === 'scope', reason: event.fact.reason });
      else if (event.kind === 'call') {
        this.processCall(snapshot, unit, event.fact, order, visibility);
        let load = loads.get(siteKey(fact)); if (!load) continue;
        if (load.kind !== 'require_relative' && inputs(file.path) !== inputs(snapshot.origin)) { snapshot.barriers.push({ order, constants: true, methods: true, reason: 'Shared source has different recorded Ruby load-path/cwd inputs; consumer initialization is not established' }); continue; }
        if (load.kind === 'autoload') {
          const nesting = this.nesting(unit, fact.scope); let owner = typeof nesting !== 'string' ? nesting[0] : undefined;
          const receiver = load.site.expression.receiver;
          if (this.entries(snapshot, 'Module', order).length) { load = { ...load, outcome: { status: 'unsupported', reason: 'Indexed Module namespace requires a builtin autoload method summary' } }; snapshot.refinements.set(`${file.path}:${siteKey(fact)}`, load); }
          if (receiver && !(receiver.kind === 'constant' && ['Kernel', '::Kernel'].includes(receiver.name))) {
            const value = this.value(snapshot, unit, fact.scope, receiver, order);
            if (value.kind === 'namespace' && value.definitions.every(def => !def.fact.superclass) && !this.barrier(snapshot, order, value.name, 'methods') && !(snapshot.methods.get(methodKey(value.name, true, 'autoload')) ?? []).length && !['Module', 'Kernel'].some(core => this.entries(snapshot, core, order).length)) {
              load = this.resolver.qualifiedAutoload(file.path, load.site); owner = value.name; snapshot.refinements.set(`${file.path}:${siteKey(fact)}`, load);
            }
          }
          const name = typeof nesting !== 'string' && load.constant ? [owner, load.constant].filter(Boolean).join('::') : undefined;
          if (name && !load.conditions.length && load.outcome.status === 'resolved') snapshot.pending.set(name, { order, file: load.outcome.target, proof: [...unit.activation, ...this.proof(file.path, fact, `Original lazy autoload registration ${name}`), ...load.outcome.proof], source: file.path, site: fact });
          else snapshot.barriers.push({ order, constants: true, methods: true, reason: 'Ruby autoload registration is conditional, dynamic, external or unresolved' }); continue;
        }
        if (load.kind !== 'load' && !load.wrapped && !load.conditions.length && load.outcome.status === 'resolved' && !load.outcome.conditions.length && !this.conditional(unit, fact.scope)) this.build(snapshot, load.outcome.target, depth + 1, [...unit.activation, ...this.proof(file.path, fact, `Unconditional indexed ${load.kind} activates original source`), ...load.outcome.proof]);
        else snapshot.barriers.push({ order, constants: true, methods: true, reason: `Ruby ${load.kind} initialization is external, conditional, repeated, wrapped or unresolved` });
      } else if (event.kind === 'reference') {
        this.resolveConstant(snapshot, unit, fact.scope, event.fact.expression.name, order, 0, fact); unit.marks.set(siteKey(fact), snapshot.order);
      }
    }
    snapshot.loading.delete(file.path); snapshot.loaded.add(file.path);
  }
  prepare(files: ScannedFile[]): void {
    for (const file of files) {
      if (this.snapshots.size >= 1024) break;
      const snapshot: Snapshot = { origin: file.path, order: 0, units: new Map(), constants: new Map(), methods: new Map(), barriers: [], loaded: new Set(), loading: new Set(), visits: 0, pending: new Map(), activating: new Set(), activations: [], conditions: [], refinements: new Map() };
      this.snapshots.set(file.path, snapshot);
      const model = this.autoload?.model(file.path);
      if (model && !model.gaps.length) for (const seed of model.seeds) {
        if (seed.file === file.path) continue; const id = this.context.syntax?.get(seed.file)?.declarations.get(seed.fact.key); if (!id) continue;
        snapshot.conditions = [...new Set([...snapshot.conditions, ...model.conditions])];
        this.addConstant(snapshot, { order: ++snapshot.order, name: seed.name, definition: { fact: seed.fact, file: seed.file, id, proof: seed.proof }, proof: [...model.profile.proof, ...model.loaderProfile?.proof ?? [], ...seed.proof] });
      }
      this.build(snapshot, file);
      const prepared = new Set<string>();
      for (let pass = 0; pass < 256; pass++) {
        const units = [...snapshot.units.values()].filter(unit => !prepared.has(unit.file.path)); if (!units.length) break;
        for (const unit of units) { prepared.add(unit.file.path); for (const reference of unit.facts.references) if (this.deferred(unit, reference.scope)) this.resolveConstant(snapshot, unit, reference.scope, reference.expression.name, snapshot.order, 0, reference); }
      }
    }
  }
  private limit(snapshot: Snapshot, unit: Unit, scope: string, site: RubySite): number { return this.deferred(unit, scope) ? snapshot.order : unit.marks.get(siteKey(site)) ?? snapshot.order; }
  private lexicalScope(unit: Unit, scope: string): RubyScopeFact | undefined { return this.ancestors(unit, scope).find(item => item.kind !== 'control'); }
  private localScope(unit: Unit, scope: string, name: string, start: number, depth = 0): { scope: string; blocked?: string } | undefined {
    if (depth > 64) return { scope, blocked: 'Ruby local-scope lookup budget exceeded' };
    const lexical = this.lexicalScope(unit, scope); if (!lexical) return;
    const entries = unit.facts.locals.filter(item => this.lexicalScope(unit, item.scope)?.key === lexical.key && item.name === name && (item.kind !== 'write' || item.start < start));
    if (entries.some(item => item.kind !== 'write')) return { scope: lexical.key, blocked: 'Ruby parameter/block-local receiver has no concrete value' };
    if (lexical.kind === 'block' && lexical.parent) {
      const captured = this.localScope(unit, lexical.parent, name, Math.min(start, lexical.start), depth + 1); if (captured) return captured;
    }
    if (entries.length) return { scope: lexical.key };
    if (lexical.kind === 'block' && lexical.parent) return this.localScope(unit, lexical.parent, name, start, depth + 1);
    return;
  }
  private local(snapshot: Snapshot, unit: Unit, scope: string, expression: RubyExpression & { kind: 'identifier' }, order: number, depth: number): RubyValue {
    const binding = this.localScope(unit, scope, expression.name, expression.start); if (!binding) return unknown(`Ruby identifier ${expression.name} is not a bounded local value`);
    if (binding.blocked) return unknown(binding.blocked);
    const writes = unit.facts.locals.filter(item => item.name === expression.name && item.kind === 'write' && this.localScope(unit, item.scope, item.name, item.end)?.scope === binding.scope);
    const assignments = unit.facts.assignments.filter(item => item.target.kind === 'identifier' && item.target.name === expression.name && this.localScope(unit, item.scope, expression.name, item.target.end)?.scope === binding.scope);
    if (writes.length !== 1 || assignments.length !== 1 || assignments[0]!.end > expression.start || assignments[0]!.augmentation || this.conditional(unit, assignments[0]!.scope)) return unknown(`Ruby local ${expression.name} is mutable, conditional or not yet initialized`);
    const assignment = assignments[0]!, activation = this.deferred(unit, assignment.scope) ? order : (unit.marks.get(siteKey(assignment)) ?? order) - 1;
    return this.value(snapshot, unit, assignment.scope, assignment.value, activation, depth + 1);
  }
  private dispatch(snapshot: Snapshot, unit: Unit, scope: string, receiver: RubyValue, name: string, order: number, implicit: boolean): RubyValue {
    const namespace = receiver.kind === 'namespace', owner = namespace || receiver.kind === 'instance' ? receiver.name : receiver.kind === 'local' ? '' : undefined;
    if (owner === undefined) return receiver.kind === 'unknown' ? receiver : unknown('Ruby receiver has no bounded method table');
    const barrier = this.barrier(snapshot, order, owner, 'methods'); if (barrier) return unknown(barrier);
    const entries = (snapshot.methods.get(methodKey(owner, namespace, name)) ?? []).filter(item => item.order <= order);
    if (entries.length > 128) return unknown(`Ruby method redefinition candidate budget exceeded for ${name}`);
    if (entries.some(item => item.reason)) return unknown(entries.find(item => item.reason)!.reason!);
    const method = entries.at(-1);
    if (method) {
      if (method.visibility !== 'public' && !implicit) return unknown('Explicit Ruby receiver cannot prove private/protected method access');
      return { kind: 'function', id: method.definition.id, proof: [...receiver.proof, ...method.definition.proof, ...this.proof(method.definition.file, method.definition.fact, `Latest initialized ${namespace ? 'singleton' : 'instance'} method ${owner || '<main>'}.${name}`)] };
    }
    if (name === 'new' && namespace && receiver.definitions.length && receiver.definitions.every(item => item.fact.kind === 'class' && !item.fact.superclass) && !['Class', 'Object', 'BasicObject', 'Kernel'].some(builtin => this.entries(snapshot, builtin, order).length)) {
      const initializer = (snapshot.methods.get(methodKey(owner, false, 'initialize')) ?? []).filter(item => item.order <= order);
      if (initializer.some(item => item.reason)) return unknown('Conditional Ruby initializer requires an activation summary');
      return { kind: 'constructor', name: owner, target: initializer.at(-1)?.definition.id, proof: [...receiver.proof, ...initializer.at(-1) ? this.proof(initializer.at(-1)!.definition.file, initializer.at(-1)!.definition.fact, 'Direct original Ruby initializer') : []] };
    }
    return unknown(`No initialized direct ${namespace ? 'singleton' : 'instance'} method ${owner || '<main>'}.${name}; ancestors, generated methods and method_missing remain unresolved`);
  }
  private self(snapshot: Snapshot, unit: Unit, scope: string, order: number): RubyValue {
    if (this.ancestors(unit, scope).some(item => item.kind === 'method' || item.kind === 'block' || item.kind === 'singleton')) return unknown('Ruby runtime self and overriding dispatch require an invocation receiver summary');
    const nesting = this.nesting(unit, scope); return typeof nesting === 'string' ? unknown(nesting) : nesting.length ? this.constant(snapshot, nesting[0]!, order) : { kind: 'local', proof: [] };
  }
  private value(snapshot: Snapshot, unit: Unit, scope: string, expression: RubyExpression, order: number, depth = 0): RubyValue {
    if (depth > 64) return unknown('Ruby expression/alias lookup budget exceeded');
    if (expression.kind === 'constant') return this.resolveConstant(snapshot, unit, scope, expression.name, order, depth, expression);
    if (expression.kind === 'literal') return { kind: 'literal', value: expression.value, proof: this.proof(unit.file.path, expression, 'Original literal Ruby value') };
    if (expression.kind === 'identifier') return expression.name === 'self' ? this.self(snapshot, unit, scope, order) : this.local(snapshot, unit, scope, expression, order, depth);
    if (expression.kind === 'call') {
      const receiver = expression.receiver ? this.value(snapshot, unit, scope, expression.receiver, order, depth + 1) : this.self(snapshot, unit, scope, order);
      const result = this.dispatch(snapshot, unit, scope, receiver, expression.method, order, !expression.receiver || expression.receiver.kind === 'identifier' && expression.receiver.name === 'self');
      return result.kind === 'constructor' ? { kind: 'instance', name: result.name, proof: result.proof } : result.kind === 'function' ? unknown('Ruby method return values require a bounded return summary', result.proof) : result;
    }
    return unknown('Ruby expression is outside the bounded constant/receiver subset');
  }
  resolve(file: string, scope: string, expression: RubyExpression, origin = file): RubyValue {
    const snapshot = this.snapshots.get(origin), unit = snapshot?.units.get(file); if (!snapshot || !unit) return unknown('No complete prepared Ruby source snapshot');
    return this.value(snapshot, unit, scope, expression, this.limit(snapshot, unit, scope, expression));
  }
  fileLoads(file: string): RubyLoad[] { const snapshot = this.snapshots.get(file); return this.resolver.fileLoads(file).map(load => snapshot?.refinements.get(`${file}:${siteKey(load.site)}`) ?? load); }
  /** A reviewed framework invokes its indexed DSL source. This restores the
   * original unit in that origin; it never runs Ruby or the target framework. */
  frameworkConstant(origin: string, file: string, scope: string, name: string, site: RubySite, proof: Evidence[] = []): RubyValue {
    const snapshot = this.snapshots.get(origin), source = this.context.files.get(file); if (!snapshot || !source) return unknown('Framework origin/source is not indexed');
    if (!snapshot.units.has(file)) this.build(snapshot, source, 0, proof);
    const unit = snapshot.units.get(file); if (!unit) return unknown('Complete original framework syntax is required');
    unit.invoked ??= new Set(); for (const ancestor of this.ancestors(unit, scope)) if (ancestor.kind === 'block') unit.invoked.add(ancestor.key);
    return this.resolveConstant(snapshot, unit, scope, name, snapshot.order, 0, site);
  }
  frameworkMethods(origin: string, name: string, singleton = false): { methods: RubyFrameworkMethod[]; conditions: string[]; reason?: string } {
    const snapshot = this.snapshots.get(origin); if (!snapshot) return { methods: [], conditions: [], reason: 'Framework origin is not prepared' };
    const reason = this.barrier(snapshot, snapshot.order, name, 'methods'); if (reason) return { methods: [], conditions: snapshot.conditions, reason };
    const methods: RubyFrameworkMethod[] = [];
    for (const entries of snapshot.methods.values()) {
      const selected = entries.filter(item => item.owner === name && item.singleton === singleton && item.order <= snapshot.order).at(-1); if (!selected) continue;
      methods.push({ id: selected.definition.id, file: selected.definition.file, fact: selected.definition.fact, visibility: selected.visibility, proof: [...selected.definition.proof, ...this.proof(selected.definition.file, selected.definition.fact, 'Original framework-selected instance method')], ...(selected.reason ? { reason: selected.reason } : {}) });
    }
    return { methods, conditions: snapshot.conditions };
  }
  private call(snapshot: Snapshot, unit: Unit, fact: RubyCallFact): RubyValue {
    const order = this.limit(snapshot, unit, fact.scope, fact);
    if (fact.bare && this.localScope(unit, fact.scope, fact.expression.method, fact.start)) return { kind: 'local', proof: [] };
    const receiver = fact.expression.receiver ? this.value(snapshot, unit, fact.scope, fact.expression.receiver, order) : this.self(snapshot, unit, fact.scope, order);
    return this.dispatch(snapshot, unit, fact.scope, receiver, fact.expression.method, order, !fact.expression.receiver || fact.expression.receiver.kind === 'identifier' && fact.expression.receiver.name === 'self');
  }
  private owner(unit: Unit, scope: string): string { const key = this.ancestors(unit, scope).find(item => item.owner)?.owner; return key ? this.context.syntax?.get(unit.file.path)?.declarations.get(key) ?? unit.file.id : unit.file.id; }
  analyze(files: ScannedFile[]): void {
    for (const file of files) {
      const entity = this.context.graph.entities.get(file.id)!, analysis = fileAnalysis(entity.metadata.analysis); if (!analysis) continue;
      const snapshot = this.snapshots.get(file.path), unit = snapshot?.units.get(file.path);
      if (!snapshot || !unit) { analysis.features.references = { status: 'partial', reason: !snapshot && this.snapshots.size >= 1024 ? 'Ruby source snapshot context budget exceeded' : 'Complete Ruby syntax/source snapshot is unavailable' }; continue; }
      const counts = new Map<string, CallSites>(), references: unknown[] = [], calls: unknown[] = [];
      const condition = (scope: string) => [...snapshot.conditions, ...this.deferred(unit, scope) ? ['Completed indexed source snapshot; invocation timing and later runtime mutations are not established'] : []];
      for (const reference of unit.facts.references) {
        const value = this.resolve(file.path, reference.scope, reference.expression), owner = this.owner(unit, reference.scope), proof = [...this.proof(file.path, reference, 'Original scoped Ruby constant reference'), ...value.proof];
        const targets = value.kind === 'namespace' ? value.definitions.map(item => item.id) : [];
        for (const target of targets) if (target !== owner) this.context.graph.relate(owner, target, 'references', proof, { adapter: 'ruby', version: RUBY_SYMBOL_VERSION, origin: file.path, conditions: condition(reference.scope) });
        references.push({ range: reference.range, spelling: reference.expression.name, kind: value.kind, ...(value.kind === 'namespace' ? { name: value.name, targets } : value.kind === 'unknown' ? { reason: value.reason } : value.kind === 'literal' ? { value: value.value } : {}), proof, conditions: condition(reference.scope) });
      }
      for (const call of unit.facts.calls) {
        const value = this.call(snapshot, unit, call); if (value.kind === 'local') continue;
        const owner = this.owner(unit, call.scope), sites = counts.get(owner) ?? { resolved: 0, external: 0, unresolved: 0, unresolvedNames: {} }, proof = [...this.proof(file.path, call, 'Original Ruby call site'), ...value.proof]; counts.set(owner, sites);
        const target = value.kind === 'function' ? value.id : value.kind === 'constructor' ? value.target : undefined;
        if (target) { sites.resolved++; this.context.graph.relate(owner, target, 'calls', proof, { adapter: 'ruby', version: RUBY_SYMBOL_VERSION, origin: file.path, conditions: condition(call.scope), constructor: value.kind === 'constructor', ...(call.safeNavigation ? { safeNavigation: true } : {}) }, value.kind === 'constructor' ? 'constructor' : ''); }
        else if (value.kind === 'constructor') sites.external++;
        else { sites.unresolved++; sites.unresolvedNames![call.expression.method] = (sites.unresolvedNames![call.expression.method] ?? 0) + 1; }
        calls.push({ range: call.range, method: call.expression.method, kind: target ? 'resolved' : value.kind === 'constructor' ? 'constructor' : 'unresolved', ...(target ? { target } : {}), ...(value.kind === 'unknown' ? { reason: value.reason } : {}), proof, conditions: condition(call.scope), ...(call.safeNavigation ? { safeNavigation: true } : {}) });
      }
      for (const [id, sites] of counts) this.context.graph.entities.get(id)!.metadata.callSites = sites;
      for (const [name, entries] of snapshot.constants) for (const entry of entries) if (entry.definition?.file === file.path) {
        const declaration = this.context.graph.entities.get(entry.definition.id)!; declaration.metadata.rubyNamespace = { name, snapshot: file.path, reopenedDeclarations: entries.filter(item => item.definition).map(item => item.definition!.id) };
      }
      entity.metadata.rubyReferenceOutcomes = references; entity.metadata.rubyCallOutcomes = calls;
      entity.metadata.rubyAutoloadOutcomes = snapshot.activations.map(item => ({ ...item, conditions: snapshot.conditions, origin: file.path }));
      for (const activation of snapshot.activations) if (activation.target && activation.status === 'resolved') this.context.graph.relate(this.context.files.get(activation.file)!.id, activation.target, 'imports', activation.proof, { adapter: 'ruby-autoload', version: RUBY_SYMBOL_VERSION, kind: 'autoload-trigger', name: activation.name, origin: file.path, range: activation.site.range, conditions: snapshot.conditions }, JSON.stringify(['autoload-trigger', activation.name, file.path]));
      entity.metadata.rubySnapshot = { origin: file.path, sources: [...snapshot.loaded].sort(), conditions: snapshot.conditions, gaps: [...new Set(snapshot.barriers.map(item => item.reason).concat(snapshot.invalid ?? []))] };
      analysis.features.references = { status: 'partial', reason: 'Scoped constants, source-ordered reopenings, immutable concrete receivers and bounded original methods, with literal/profile-qualified lazy autoload activation; ancestors/mixins, dynamic self, reflection, executable loader hooks/reload and higher-order returns remain gaps' };
    }
  }
}
