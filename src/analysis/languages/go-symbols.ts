import type { AnalysisContext, ScannedFile } from '../../core/analyzer.js';
import { declarationHashes, evidence, type CallSites, type Evidence } from '../../core/graph.js';
import { fileAnalysis, type GoBindingFact, type GoDefinitionFact, type GoExpression, type GoImportFact, type GoSemanticFacts } from '../facts.js';
import { type GoPackage, type GoResolution, GoResolver } from '../resolution/go.js';

export const GO_SYMBOL_VERSION = '1';
const BUILTINS = new Set('append cap clear close complex copy delete imag len make max min new panic print println real recover'.split(' '));
const BASIC_TYPES = new Set('any bool byte comparable complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune string uint uint8 uint16 uint32 uint64 uintptr'.split(' '));
const exported = (name: string) => /^\p{Lu}/u.test(name);
interface Unit { file: ScannedFile; facts: GoSemanticFacts; scopes: Map<string, GoSemanticFacts['scopes'][number]>; bindings: Map<string, Map<string, (Binding | Definition)[]>>; imports: Import[]; pkg: Package }
interface Definition { fact: GoDefinitionFact; unit: Unit; id: string }
interface Binding { fact: GoBindingFact; unit: Unit; mutable: boolean }
interface Import { fact: GoImportFact; outcome: GoResolution; name?: string; target?: Package }
interface Package { key: string; source: GoPackage; origin: string; units: Map<string, Unit>; globals: Map<string, (Binding | Definition)[]>; methods: Definition[]; dependencies: Package[]; gaps: string[]; ready: boolean; cyclic?: boolean }
interface Typed { definition: Definition; pointer: boolean; addressable: boolean }
export type GoBoundValue =
  | { kind: 'function'; id: string; definition: Definition; proof: Evidence[]; methodExpression?: boolean }
  | { kind: 'type' | 'instance'; type: Typed; proof: Evidence[] }
  | { kind: 'namespace'; imported: Import; unit: Unit; proof: Evidence[] }
  | { kind: 'external'; specifier: string; members: string[]; proof: Evidence[] }
  | { kind: 'builtin' | 'builtin-type'; name: string; proof: Evidence[] }
  | { kind: 'unknown'; reason: string; proof: Evidence[] };
const unknown = (reason: string, proof: Evidence[] = []): GoBoundValue => ({ kind: 'unknown', reason, proof });

/** Lexical and package binding under recorded compilation inputs. It deliberately
 * leaves dynamic dispatch and the unreviewed parts of Go's type system open. */
export class GoSymbols {
  private readonly packages = new Map<string, Package>();
  private readonly closures = new Map<string, string>();
  private readonly roots = new Map<string, Package>();
  constructor(readonly context: AnalysisContext, readonly resolver: GoResolver) {}
  private proof(unit: Unit, expression: GoExpression, reason: string): Evidence[] {
    return [{ ...evidence('syntax', 'go-symbols', unit.file.path, expression.range.startLine, reason), analyzerVersion: GO_SYMBOL_VERSION, endLine: expression.range.endLine }];
  }
  private package(source: GoPackage, origin: string): Package {
    const env = this.resolver.environment(origin), key = JSON.stringify([source.key, env.mains.map(main => main.id), env.workspace?.file, this.resolver.owner(origin)?.id, this.context.files.get(origin)?.application?.path]);
    const existing = this.packages.get(key); if (existing) return existing;
    const pkg: Package = { key, source, origin, units: new Map(), globals: new Map(), methods: [], dependencies: [], gaps: [...source.conditions, ...env.conditions, ...(env.error ? [env.error.reason] : [])], ready: false };
    this.packages.set(key, pkg);
    if (this.packages.size > 2048) { pkg.gaps.push('Go package-context budget exceeded'); pkg.ready = true; return pkg; }
    for (const file of source.files) {
      const parsed = this.context.syntax?.get(file.path), go = parsed?.facts.go, facts = go?.semantic;
      if (!go?.complete || !facts || parsed?.facts.truncated || this.resolver.selection(file.path, this.resolver.config(origin)).status !== 'active') { pkg.gaps.push(`${file.path}: incomplete or conditional compilation unit`); continue; }
      const unit: Unit = { file, facts, scopes: new Map(facts.scopes.map(scope => [scope.key, scope])), bindings: new Map(), imports: [], pkg }; pkg.units.set(file.path, unit);
      for (const fact of facts.definitions) {
        const id = fact.kind === 'closure' ? this.closure(unit, fact) : parsed!.declarations.get(fact.key); if (!id) { pkg.gaps.push('Original declaration identity is unavailable'); continue; }
        const def = { fact, unit, id };
        if (fact.kind === 'method') pkg.methods.push(def);
        else if (fact.kind !== 'closure') {
          if (unit.scopes.get(fact.scope)?.kind === 'file') this.global(pkg, fact.name, def);
          else this.local(unit, fact.scope, fact.name, def);
        }
      }
      // A short declaration redeclares existing variables in its own block.
      // Record writes rather than inventing another binding for those names.
      for (const fact of facts.bindings) {
        const binding = { fact, unit, mutable: false };
        if (unit.scopes.get(fact.scope)?.kind === 'file') { if (fact.name !== '_') this.global(pkg, fact.name, binding); continue; }
        const previous = this.localEntries(unit, fact.scope, fact.name);
        if (fact.kind === 'short' && previous.length === 1 && 'mutable' in previous[0]!) { previous[0].mutable = true; continue; }
        this.local(unit, fact.scope, fact.name, binding);
      }
      pkg.gaps.push(...facts.gaps.map(gap => `${file.path}: ${gap}`));
    }
    for (const unit of pkg.units.values()) {
      for (const fact of this.context.syntax!.get(unit.file.path)!.facts.go!.imports) {
        const outcome = this.resolver.resolve(unit.file.path, fact.specifier, origin);
        const target = outcome.status === 'resolved' ? this.package(outcome.package, origin) : undefined;
        const name = fact.kind === 'named' ? fact.local : fact.kind === 'default' ? target?.source.name ?? (outcome.status === 'external' && outcome.standardLibrary ? fact.specifier.split('/').filter(part => !/^v\d+$/.test(part)).at(-1) : undefined) : undefined;
        unit.imports.push({ fact, outcome, target, name }); if (target && !pkg.dependencies.includes(target)) pkg.dependencies.push(target);
      }
    }
    for (const [name, entries] of pkg.globals) if (name !== 'init' && entries.length > 1) pkg.gaps.push(`Duplicate package declaration ${name}`);
    for (const unit of pkg.units.values()) {
      for (const [scope, names] of unit.bindings) for (const [name, entries] of names) if (entries.length > 1) pkg.gaps.push(`Duplicate block declaration ${name} in ${scope}`);
      for (const imported of unit.imports) if (imported.name && (pkg.globals.has(imported.name) || unit.imports.filter(other => other.name === imported.name).length > 1)) pkg.gaps.push(`Package/file namespace collision ${imported.name}`);
    }
    pkg.ready = true; return pkg;
  }
  private global(pkg: Package, name: string, entry: Binding | Definition): void {
    if (name === '_' || name === 'init') return; const entries = pkg.globals.get(name) ?? []; entries.push(entry); pkg.globals.set(name, entries);
  }
  // Definitions share the same scope index as variables, while their activation
  // is determined by their declaration kind during lookup.
  private local(unit: Unit, scope: string, name: string, entry: Binding | Definition): void {
    const names = unit.bindings.get(scope) ?? new Map(), entries = names.get(name) ?? []; entries.push(entry); names.set(name, entries); unit.bindings.set(scope, names);
  }
  private localEntries(unit: Unit, scope: string, name: string): (Binding | Definition)[] {
    return unit.bindings.get(scope)?.get(name) ?? [];
  }
  private closure(unit: Unit, fact: GoDefinitionFact): string {
    const key = `${unit.file.path}:${fact.key}`, known = this.closures.get(key); if (known) return known;
    const owner = this.owner(unit, fact.scope), content = this.resolver.sources.readText(unit.file.path).slice(fact.start, fact.end), hashes = declarationHashes(content, 0);
    const base = this.context.graph.id('symbol', 'go', unit.file.path, owner, 'closure', hashes.contentHash ?? JSON.stringify(hashes));
    let id = base, ordinal = 1; while (this.context.graph.entities.has(id)) id = this.context.graph.id('symbol', base, String(++ordinal));
    this.context.graph.contain({ id, type: 'function', name: '<closure>', path: unit.file.path, language: 'go', parentId: owner, sourceRange: fact.range, metrics: { loc: fact.range.endLine - fact.range.startLine + 1 }, metadata: { declarationKind: 'closure', role: 'closure', signature: fact.signature, ...hashes }, evidence: [{ ...evidence('syntax', 'go-symbols', unit.file.path, fact.range.startLine, 'Original Go function literal'), analyzerVersion: GO_SYMBOL_VERSION, endLine: fact.range.endLine }] });
    this.closures.set(key, id); return id;
  }
  private owner(unit: Unit, scope: string): string {
    let current = unit.scopes.get(scope); while (current) {
      if (current.owner) return this.context.syntax!.get(unit.file.path)!.declarations.get(current.owner) ?? this.closures.get(`${unit.file.path}:${current.owner}`) ?? unit.file.id;
      current = current.parent ? unit.scopes.get(current.parent) : undefined;
    } return unit.file.id;
  }
  private lexical(unit: Unit, scope: string, name: string, start: number): (Binding | Definition)[] | undefined {
    let current = unit.scopes.get(scope);
    while (current && current.kind !== 'file') {
      const entries = this.localEntries(unit, current.key, name).filter(entry => 'mutable' in entry ? entry.fact.end <= start : entry.fact.start <= start);
      if (entries.length) return entries;
      current = current.parent ? unit.scopes.get(current.parent) : undefined;
    } return undefined;
  }
  private declaration(unit: Unit, scope: string, name: string, start: number): (Binding | Definition)[] | undefined {
    return this.lexical(unit, scope, name, start) ?? unit.pkg.globals.get(name);
  }
  private markWrites(): void {
    for (const pkg of this.packages.values()) for (const unit of pkg.units.values()) for (const write of unit.facts.writes) {
      // Assignment through a field does not change a variable's static concrete
      // type. Function-valued fields are never bound to an initializer here.
      if (write.target.kind !== 'name') continue;
      for (const entry of this.declaration(unit, write.scope, write.target.name, write.start) ?? []) if ('mutable' in entry) entry.mutable = true;
    }
  }
  private cycles(): void {
    const active: Package[] = [], done = new Set<Package>();
    const visit = (pkg: Package) => {
      const index = active.indexOf(pkg); if (index >= 0) { for (const item of active.slice(index)) item.cyclic = true; return; }
      if (done.has(pkg)) return; if (active.length > 256) { pkg.gaps.push('Package traversal depth exceeded'); return; }
      active.push(pkg); pkg.dependencies.forEach(visit); active.pop(); done.add(pkg);
    }; for (const pkg of this.packages.values()) visit(pkg);
  }
  private qualified(pkg: Package): boolean { return pkg.ready && !pkg.gaps.length && !pkg.cyclic; }
  prepare(files: ScannedFile[]): void {
    for (const file of files) { const own = this.resolver.packageFor(file.path); if (own.status === 'resolved') this.roots.set(file.path, this.package(own.package, file.path)); }
    this.cycles(); this.markWrites(); this.methodOwners();
  }
  private methodOwners(): void {
    const assignments = new Map<string, Set<string>>();
    for (const pkg of this.packages.values()) if (this.qualified(pkg)) for (const method of pkg.methods) {
      const type = method.fact.receiver && this.type(method.unit, method.fact.scope, method.fact.receiver.type, new Set(), 0);
      if (type?.kind !== 'type' || type.type.definition.unit.pkg !== pkg || type.type.definition.fact.alias) continue;
      const owners = assignments.get(method.id) ?? new Set(); owners.add(type.type.definition.id); assignments.set(method.id, owners);
    }
    for (const [id, owners] of assignments) if (owners.size === 1) {
      const entity = this.context.graph.entities.get(id)!, owner = [...owners][0]!;
      if (entity.parentId === owner) continue;
      for (const [key, relation] of this.context.graph.relations) if (relation.type === 'contains' && relation.to === id) this.context.graph.relations.delete(key);
      entity.parentId = owner; this.context.graph.relate(owner, id, 'contains', entity.evidence);
    }
  }
  private entry(entry: Binding | Definition, visited: Set<object>, depth: number): GoBoundValue {
    if (visited.has(entry) || depth > 64) return unknown('Recursive or excessive binding expansion');
    const next = new Set(visited).add(entry), { fact, unit } = entry;
    if (!this.qualified(unit.pkg)) return unknown('Package syntax/build/import cycle does not prove a unique runtime binding');
    const proof = this.proof(unit, { ...fact, kind: 'name', name: fact.name }, `Go ${fact.kind} binding ${fact.name}`);
    if ('id' in entry) {
      if (fact.kind === 'type') {
        const def = entry as Definition;
        if (def.fact.alias && def.fact.underlying) { const value = this.type(unit, def.fact.typeScope ?? fact.scope, def.fact.underlying, next, depth + 1); return { ...value, proof: [...proof, ...value.proof] }; }
        return { kind: 'type', type: { definition: def, pointer: false, addressable: false }, proof };
      }
      return { kind: 'function', id: entry.id, definition: entry, proof };
    }
    const binding = entry as Binding;
    if (binding.fact.kind === 'type-parameter') return unknown('Generic type parameter has no proven concrete runtime type', proof);
    if (binding.fact.type) {
      const type = this.type(unit, fact.scope, binding.fact.type, next, depth + 1);
      if (type.kind === 'type') return { kind: 'instance', type: { ...type.type, addressable: true }, proof: [...proof, ...type.proof] };
      // A function/interface annotation cannot prove the runtime function value.
      if (binding.fact.kind === 'parameter' || binding.mutable) return unknown('Parameter/interface/function type does not identify its runtime implementation', proof);
    }
    if (binding.mutable) {
      // Go variables keep their static type after reassignment. An inferred
      // concrete type is useful; an inferred function identity is not stable.
      if (binding.fact.value && !binding.fact.tuple) {
        const initial = this.value(unit, fact.scope, binding.fact.value, next, depth + 1);
        if (initial.kind === 'instance') return { ...initial, type: { ...initial.type, addressable: true }, proof: [...proof, ...initial.proof] };
      }
      return unknown('Reassigned or address-exposed function/value binding', proof);
    }
    if (binding.fact.tuple || !binding.fact.value) return unknown('No single statically proven initializer', proof);
    const value = this.value(unit, fact.scope, binding.fact.value, next, depth + 1);
    if (value.kind === 'instance') return { ...value, type: { ...value.type, addressable: true }, proof: [...proof, ...value.proof] };
    return { ...value, proof: [...proof, ...value.proof] };
  }
  private name(unit: Unit, scope: string, expression: GoExpression & { kind: 'name' }, visited: Set<object>, depth: number): GoBoundValue {
    const local = this.lexical(unit, scope, expression.name, expression.start);
    if (local) return local.length === 1 ? this.entry(local[0]!, visited, depth + 1) : unknown('Competing block declarations');
    const imports = unit.imports.filter(item => item.name === expression.name);
    if (imports.length) {
      if (imports.length !== 1 || unit.pkg.globals.has(expression.name)) return unknown('Competing file/package import bindings');
      const imported = imports[0]!;
      if (!['resolved', 'external'].includes(imported.outcome.status) || ('conditions' in imported.outcome && imported.outcome.conditions.length)) return unknown('Import namespace is unqualified');
      return { kind: 'namespace', imported, unit, proof: [...this.proof(unit, expression, `Go file import namespace ${imported.fact.specifier}`), ...('proof' in imported.outcome ? imported.outcome.proof : [])] };
    }
    const dot = unit.imports.filter(item => item.fact.kind === 'dot'), members = exported(expression.name) ? dot.flatMap(item => item.target?.globals.get(expression.name) ?? []) : [];
    const global = unit.pkg.globals.get(expression.name) ?? [];
    if (dot.some(item => !item.target || !this.qualified(item.target))) return unknown('Unindexed or conditional dot import may supply this name');
    const entries = [...global, ...members];
    if (entries.length) return entries.length === 1 ? this.entry(entries[0]!, visited, depth + 1) : unknown('Competing package/dot-import declarations');
    if (BUILTINS.has(expression.name)) return { kind: 'builtin', name: expression.name, proof: this.proof(unit, expression, 'Unshadowed Go universe function') };
    if (BASIC_TYPES.has(expression.name)) return { kind: 'builtin-type', name: expression.name, proof: this.proof(unit, expression, 'Unshadowed Go universe type') };
    return unknown(`No proven Go binding for ${expression.name}`);
  }
  private type(unit: Unit, scope: string, expression: GoExpression, visited: Set<object>, depth: number): GoBoundValue {
    if (depth > 64) return unknown('Type expansion budget exceeded');
    if (expression.kind === 'unary' && expression.operator === '*') {
      const inner = this.type(unit, scope, expression.object, visited, depth + 1);
      return inner.kind === 'type' && !inner.type.pointer ? { ...inner, type: { ...inner.type, pointer: true } } : unknown('Unqualified pointer element type', inner.proof);
    }
    if (expression.kind === 'index') {
      const type = this.type(unit, scope, expression.object, visited, depth + 1);
      return type.kind === 'type' && type.type.definition.fact.generic ? type : unknown('Indexed type is not a proven generic declaration', type.proof);
    }
    const value = this.value(unit, scope, expression, visited, depth + 1); return ['type', 'builtin-type', 'external'].includes(value.kind) ? value : unknown('Expression does not prove a named static type', value.proof);
  }
  private member(unit: Unit, scope: string, expression: GoExpression & { kind: 'member' }, visited: Set<object>, depth: number): GoBoundValue {
    const object = this.value(unit, scope, expression.object, visited, depth + 1);
    if (object.kind === 'namespace') {
      const { imported } = object;
      if (!exported(expression.name)) return unknown('Imported package member is not exported', object.proof);
      if (imported.outcome.status === 'external') return { kind: 'external', specifier: imported.fact.specifier, members: [expression.name], proof: object.proof };
      if (!imported.target || !this.qualified(imported.target)) return unknown('Imported package does not prove a unique compilation context', object.proof);
      const entries = imported.target.globals.get(expression.name) ?? [];
      if (entries.length !== 1) return unknown('Missing or competing imported member', object.proof);
      const value = this.entry(entries[0]!, visited, depth + 1); return { ...value, proof: [...object.proof, ...value.proof] };
    }
    if (object.kind !== 'instance' && object.kind !== 'type') return unknown('Selector receiver has no proven concrete type', object.proof);
    const { definition, pointer, addressable } = object.type, target = definition.unit.pkg;
    if (target !== unit.pkg && !exported(expression.name)) return unknown('Receiver member is not exported', object.proof);
    if (definition.fact.interface) return unknown('Interface method dispatch requires runtime implementation proof', object.proof);
    const fields = definition.fact.fields?.filter(field => field.name === expression.name) ?? [];
    const methods = target.methods.filter(method => method.fact.name === expression.name && this.receiver(method, definition, visited, depth + 1));
    if (fields.length && methods.length || fields.length > 1 || methods.length > 1) return unknown('Conflicting field/method selectors', object.proof);
    if (fields.length) {
      if (object.kind === 'type') return unknown('A field has no method-expression value', object.proof);
      const type = this.type(definition.unit, definition.fact.typeScope ?? definition.fact.scope, fields[0]!.type, visited, depth + 1);
      return type.kind === 'type' ? { kind: 'instance', type: { ...type.type, addressable: pointer || addressable }, proof: [...object.proof, ...type.proof] } : unknown('Function/interface/collection field has no direct implementation', object.proof);
    }
    if (methods.length === 1) {
      const method = methods[0]!, receiver = this.type(method.unit, method.fact.scope, method.fact.receiver!.type, visited, depth + 1);
      if (receiver.kind !== 'type' || receiver.type.pointer && !(pointer || object.kind === 'instance' && addressable)) return unknown('Pointer method is outside the receiver method set', object.proof);
      return { kind: 'function', id: method.id, definition: method, ...(object.kind === 'type' ? { methodExpression: true } : {}), proof: [...object.proof, ...this.proof(unit, expression, 'Direct concrete Go receiver method')] };
    }
    return unknown(definition.fact.fields?.some(field => field.embedded) ? 'Promoted embedded selectors require an ambiguity-aware type profile' : 'No direct method or field on the proven receiver', object.proof);
  }
  private receiver(method: Definition, definition: Definition, visited: Set<object>, depth: number): boolean {
    if (!method.fact.receiver) return false; const receiver = this.type(method.unit, method.fact.scope, method.fact.receiver.type, visited, depth + 1);
    return receiver.kind === 'type' && receiver.type.definition.id === definition.id && !receiver.type.definition.fact.alias;
  }
  private struct(definition: Definition, visited: Set<object>, depth: number): boolean {
    if (depth > 32 || visited.has(definition)) return false;
    if (definition.fact.fields) return true;
    if (!definition.fact.underlying || definition.fact.interface) return false;
    const type = this.type(definition.unit, definition.fact.typeScope ?? definition.fact.scope, definition.fact.underlying, new Set(visited).add(definition), depth + 1);
    return type.kind === 'type' && !type.type.pointer && this.struct(type.type.definition, new Set(visited).add(definition), depth + 1);
  }
  private value(unit: Unit, scope: string, expression: GoExpression, visited = new Set<object>(), depth = 0): GoBoundValue {
    if (depth > 64 || visited.size > 128) return unknown('Expression expansion budget exceeded');
    if (!this.qualified(unit.pkg)) return unknown('Package syntax/build/import cycle does not prove a unique runtime binding');
    switch (expression.kind) {
      case 'name': return this.name(unit, scope, expression, visited, depth);
      case 'member': return this.member(unit, scope, expression, visited, depth);
      case 'function': {
        const fact = unit.facts.definitions.find(def => def.key === expression.key), id = this.closures.get(`${unit.file.path}:${expression.key}`);
        return fact && id ? { kind: 'function', id, definition: { id, fact, unit }, proof: this.proof(unit, expression, 'Original Go function literal binding') } : unknown('Function literal identity unavailable');
      }
      case 'index': {
        const value = this.value(unit, scope, expression.object, visited, depth + 1);
        return value.kind === 'type' && value.type.definition.fact.generic || value.kind === 'function' && value.definition.fact.generic ? value : unknown('Collection/non-generic index cannot prove a runtime function/type', value.proof);
      }
      case 'composite': {
        const type = this.type(unit, scope, expression.type, visited, depth + 1);
        return type.kind === 'type' && !type.type.pointer && this.struct(type.type.definition, visited, depth + 1) ? { kind: 'instance', type: { ...type.type, addressable: false }, proof: type.proof } : unknown('Composite literal has no qualified concrete named struct type', type.proof);
      }
      case 'unary': {
        const value = this.value(unit, scope, expression.object, visited, depth + 1);
        if (expression.operator === '*' && value.kind === 'type') return { ...value, type: { ...value.type, pointer: true } };
        if (value.kind === 'instance' && expression.operator === '&' && !value.type.pointer) return { ...value, type: { ...value.type, pointer: true, addressable: false } };
        if (value.kind === 'instance' && expression.operator === '*' && value.type.pointer) return { ...value, type: { ...value.type, pointer: false, addressable: true } };
        return unknown('Unsupported or unqualified unary value', value.proof);
      }
      case 'call': {
        const callee = this.value(unit, scope, expression.callee, visited, depth + 1);
        if (callee.kind === 'builtin' && callee.name === 'new' && expression.args.length === 1) {
          const type = this.type(unit, scope, expression.args[0]!, visited, depth + 1);
          return type.kind === 'type' && !type.type.pointer && !type.type.definition.fact.interface ? { kind: 'instance', type: { ...type.type, pointer: true, addressable: false }, proof: type.proof } : unknown('new has no concrete named element type', type.proof);
        }
        if (callee.kind === 'type') return !callee.type.definition.fact.interface ? { kind: 'instance', type: { ...callee.type, addressable: false }, proof: callee.proof } : unknown('Interface conversion does not prove runtime dispatch', callee.proof);
        if (callee.kind === 'function' && callee.definition.fact.results.length === 1) {
          const def = callee.definition, type = this.type(def.unit, def.fact.bodyScope ?? def.fact.scope, def.fact.results[0]!.type, visited, depth + 1);
          if (type.kind === 'type' && !type.type.definition.fact.interface) return { kind: 'instance', type: { ...type.type, addressable: false }, proof: [...callee.proof, ...type.proof] };
        }
        return unknown('Call result requires a proven concrete result signature', callee.proof);
      }
      default: return unknown('Literal or unreviewed expression has no callable/type identity');
    }
  }
  /** Shared by router packs: scope and original expressions come from cached
   * parser facts; qualified imports and callbacks carry their proof hops. */
  resolveExpression(file: string, expression: GoExpression, scope: string, origin = file): GoBoundValue {
    const pkg = this.roots.get(origin); const unit = pkg?.units.get(file);
    return unit ? this.value(unit, scope, expression) : unknown('No prepared Go compilation unit');
  }
  analyze(files: ScannedFile[]): void {
    for (const file of files) {
      const entity = this.context.graph.entities.get(file.id)!, analysis = fileAnalysis(entity.metadata.analysis); if (!analysis) continue;
      if (!this.context.syntax?.get(file.path)?.facts.go?.semantic) { analysis.features.references = { status: 'failed', reason: 'Go semantic syntax facts are unavailable' }; continue; }
      const selection = this.resolver.selection(file.path), pkg = this.roots.get(file.path), unit = pkg?.units.get(file.path);
      if (selection.status === 'inactive') { analysis.features.references = { status: 'disabled', reason: 'Inactive under recorded build/test inputs' }; continue; }
      if (!pkg || !unit || !this.qualified(pkg)) {
        const reasons = pkg ? [...pkg.gaps, ...(pkg.cyclic ? ['Package import cycle'] : [])] : ['No prepared qualified Go package'];
        analysis.features.references = { status: 'partial', reason: [...new Set(reasons)].join('; ').slice(0, 2000) };
        for (const reason of [...new Set(reasons)]) this.context.graph.diagnose({ analyzer: 'go-symbols', severity: 'warning', code: 'go-symbol-gap', file: file.path, entityId: file.id, reason }); continue;
      }
      const counts = new Map<string, CallSites>(), outcomes: unknown[] = [];
      const count = (owner: string) => { const known = counts.get(owner) ?? { resolved: 0, external: 0, unresolved: 0, unresolvedNames: {} }; counts.set(owner, known); return known; };
      for (const reference of unit.facts.references) {
        const value = this.value(unit, reference.scope, reference.expression), owner = this.owner(unit, reference.scope);
        const target = value.kind === 'function' ? value.id : value.kind === 'type' || value.kind === 'instance' ? value.type.definition.id : undefined;
        if (target && target !== owner) this.context.graph.relate(owner, target, 'references', [...this.proof(unit, reference.expression, 'Lexically bound Go reference'), ...value.proof], { adapter: 'go', version: GO_SYMBOL_VERSION });
      }
      for (const call of unit.facts.calls) {
        const value = this.value(unit, call.scope, call.expression.callee), owner = this.owner(unit, call.scope), sites = count(owner), proof = [...this.proof(unit, call.expression, 'Original Go call site'), ...value.proof];
        const text = this.resolver.sources.readText(file.path), name = text.slice(call.expression.callee.start, call.expression.callee.start + 200).slice(0, Math.max(1, text.indexOf('(', call.expression.callee.start) - call.expression.callee.start)).trim();
        if (value.kind === 'type' || value.kind === 'builtin-type') { outcomes.push({ range: call.range, kind: 'conversion', timing: call.timing, proof }); continue; }
        if (value.kind === 'function') {
          sites.resolved++; this.context.graph.relate(owner, value.id, 'calls', proof, { adapter: 'go', version: GO_SYMBOL_VERSION, timing: call.timing, ...(value.methodExpression ? { methodExpression: true } : {}) }, JSON.stringify([call.timing, !!value.methodExpression]));
          outcomes.push({ range: call.range, kind: 'resolved', target: value.id, timing: call.timing, proof });
        } else if (value.kind === 'external' || value.kind === 'builtin') { sites.external++; outcomes.push({ range: call.range, kind: 'external', ...(value.kind === 'external' ? { specifier: value.specifier, members: value.members } : { builtin: value.name }), timing: call.timing, proof }); }
        else { sites.unresolved++; sites.unresolvedNames![name] = (sites.unresolvedNames![name] ?? 0) + 1; outcomes.push({ range: call.range, kind: 'unresolved', reason: value.kind === 'unknown' ? value.reason : 'Namespace is not callable', timing: call.timing, proof }); }
      }
      for (const [id, sites] of counts) this.context.graph.entities.get(id)!.metadata.callSites = sites;
      entity.metadata.goCallOutcomes = outcomes;
      analysis.features.references = { status: 'partial', reason: 'Bound package/file/block scopes, immutable function values, original closures, imported members and direct concrete receiver methods; interface dispatch, promoted selectors, full generics/type checking and higher-order returns remain explicit gaps' };
    }
  }
}
