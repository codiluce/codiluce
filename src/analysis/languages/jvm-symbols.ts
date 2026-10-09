import type { AnalysisContext, ScannedFile } from '../../core/analyzer.js';
import { declarationHashes, evidence, type CallSites, type Evidence } from '../../core/graph.js';
import { fileAnalysis, type JvmBindingFact, type JvmDefinitionFact, type JvmExpression, type JvmSemanticFacts } from '../facts.js';
import { JvmResolver, type JvmResolution, type JvmSymbol } from '../resolution/jvm.js';

export const JVM_SYMBOL_VERSION = '2';
const TYPE_KINDS = new Set(['class', 'interface', 'enum', 'record', 'annotation', 'object', 'typealias']);
const CALLABLE_KINDS = new Set(['method', 'function', 'constructor', 'lambda']);
const PRIMITIVES = new Set(['byte', 'short', 'char', 'int', 'long', 'float', 'double', 'boolean', 'void']);
const KOTLIN_BUILTINS: Record<string, string> = { Byte: 'byte', Short: 'short', Char: 'char', Int: 'int', Long: 'long', Float: 'float', Double: 'double', Boolean: 'boolean', String: 'String', Unit: 'void' };
interface Unit {
  file: ScannedFile; facts: JvmSemanticFacts;
  scopes: Map<string, JvmSemanticFacts['scopes'][number]>;
  definitions: Map<string, JvmDefinition>;
  names: Map<string, Map<string, Entry[]>>;
}
export interface JvmDefinition { fact: JvmDefinitionFact; unit: Unit; id: string; symbol?: JvmSymbol }
interface Binding { fact: JvmBindingFact; unit: Unit }
type Entry = JvmDefinition | Binding;
export type JvmBoundValue =
  | { kind: 'type'; definition: JvmDefinition; proof: Evidence[] }
  | { kind: 'instance'; definition: JvmDefinition; exact: boolean; proof: Evidence[] }
  | { kind: 'callable'; definitions: JvmDefinition[]; direct: boolean; reason?: string; proof: Evidence[] }
  | { kind: 'property'; definition: JvmDefinition; proof: Evidence[] }
  | { kind: 'primitive'; name: string; proof: Evidence[] }
  | { kind: 'external'; name: string; proof: Evidence[] }
  | { kind: 'unknown'; reason: string; proof: Evidence[] };
export type JvmConstant = { status: 'resolved'; value: string | number | boolean | null | JvmConstantValue[]; proof: Evidence[] } | { status: 'unresolved'; reason: string; proof: Evidence[] };
type JvmConstantValue = string | number | boolean | null | JvmConstantValue[];
const unknown = (reason: string, proof: Evidence[] = []): JvmBoundValue => ({ kind: 'unknown', reason, proof });
const noConstant = (reason: string, proof: Evidence[] = []): JvmConstant => ({ status: 'unresolved', reason, proof });

/** Bounded original-source binding under the resolver's selected compilation
 * contract. No target compiler, build, binary, plugin or application is run. */
export class JvmSymbols {
  private readonly units = new Map<string, Unit>();
  private readonly byId = new Map<string, JvmDefinition>();
  private readonly memberNames = new Map<string, Map<string, JvmDefinition[]>>();
  private operations = 0;
  private inferenceDepth = 0;
  private selectedCallableScopes = new Set<string>();
  constructor(readonly context: AnalysisContext, readonly resolver: JvmResolver) {
    const symbols = new Map(resolver.symbols.map(symbol => [symbol.id, symbol]));
    for (const file of context.files.values()) {
      const parsed = context.syntax?.get(file.path), facts = parsed?.facts.jvm?.semantic;
      if (!facts?.complete) continue;
      const unit: Unit = { file, facts, scopes: new Map(facts.scopes.map(scope => [scope.key, scope])), definitions: new Map(), names: new Map() };
      this.units.set(file.path, unit);
      const ordinals = new Map<string, number>();
      for (const fact of facts.definitions) {
        const owner = this.owner(unit, fact.scope), ordinal = ordinals.get(owner) ?? 0;
        const id = fact.kind === 'lambda' ? context.graph.id('symbol', 'jvm', file.path, owner, 'lambda', String(ordinal)) : parsed!.declarations.get(fact.key);
        if (fact.kind === 'lambda') ordinals.set(owner, ordinal + 1);
        if (!id) continue;
        const definition: JvmDefinition = { fact, unit, id, symbol: symbols.get(id) };
        unit.definitions.set(fact.key, definition); this.byId.set(id, definition);
        if (fact.kind !== 'lambda') this.add(unit, fact.scope, fact.name, definition);
      }
      for (const fact of facts.bindings) {
        // Kotlin local properties have both an original declaration and a local
        // binding. Use the latter for activation/shadowing and value inference.
        if (fact.declaration) {
          const entries = unit.names.get(fact.scope)?.get(fact.name);
          if (entries) unit.names.get(fact.scope)!.set(fact.name, entries.filter(entry => !('id' in entry) || entry.fact.key !== fact.declaration));
        }
        this.add(unit, fact.scope, fact.name, { fact, unit });
      }
    }
    for (const definition of this.byId.values()) if (definition.fact.parent) {
      const owner = definition.unit.definitions.get(definition.fact.parent);
      if (!owner || definition.fact.scope !== owner.fact.typeScope) continue;
      const names = this.memberNames.get(owner.id) ?? new Map(), members = names.get(definition.fact.name) ?? [];
      members.push(definition); names.set(definition.fact.name, members); this.memberNames.set(owner.id, names);
    }
  }
  private add(unit: Unit, scope: string, name: string, entry: Entry): void {
    const names = unit.names.get(scope) ?? new Map(), entries = names.get(name) ?? [];
    entries.push(entry); names.set(name, entries); unit.names.set(scope, names);
  }
  definition(file: string, key: string): JvmDefinition | undefined { return this.units.get(file)?.definitions.get(key); }
  definitions(file: string): JvmDefinition[] { return [...this.units.get(file)?.definitions.values() ?? []]; }
  private proof(unit: Unit, expression: Pick<JvmExpression, 'range'>, reason: string): Evidence[] {
    return [{ ...evidence('syntax', 'jvm-symbols', unit.file.path, expression.range.startLine, reason), analyzerVersion: JVM_SYMBOL_VERSION, endLine: expression.range.endLine }];
  }
  private chain(unit: Unit, scope: string): JvmSemanticFacts['scopes'] {
    const result: JvmSemanticFacts['scopes'] = [], seen = new Set<string>();
    let current = unit.scopes.get(scope);
    while (current && !seen.has(current.key) && result.length < 128) {
      seen.add(current.key); result.push(current); current = current.parent ? unit.scopes.get(current.parent) : undefined;
    }
    return result;
  }
  private scopeGap(unit: Unit, scope: string): string | undefined {
    return this.chain(unit, scope).flatMap(item => item.gaps.filter(gap=>!(this.selectedCallableScopes.has(item.key)&&gap==='Implicit Kotlin lambda parameter/receiver requires a selected callable type')))[0];
  }
  private owner(unit: Unit, scope: string): string {
    for (const item of this.chain(unit, scope)) if (item.owner) return unit.definitions.get(item.owner)?.id ?? this.context.syntax?.get(unit.file.path)?.declarations.get(item.owner) ?? unit.file.id;
    return unit.file.id;
  }
  private enclosingType(unit: Unit, scope: string): JvmDefinition | undefined {
    for (const item of this.chain(unit, scope)) if (item.owner) {
      const definition = unit.definitions.get(item.owner);
      if (definition && TYPE_KINDS.has(definition.fact.kind)) return definition;
    }
    return undefined;
  }
  private staticScope(unit: Unit, scope: string): boolean {
    for (const item of this.chain(unit, scope)) if (item.owner) {
      const definition = unit.definitions.get(item.owner);
      if (definition?.fact.kind === 'lambda') continue;
      if (definition && CALLABLE_KINDS.has(definition.fact.kind)) return !!definition.symbol?.syntax.static;
    }
    return false;
  }
  private lexical(unit: Unit, scope: string, name: string, start: number): Entry[] | undefined {
    for (const item of this.chain(unit, scope)) {
      if (item.kind === 'type') {
        const types = unit.names.get(item.key)?.get(name)?.filter(entry => 'id' in entry && TYPE_KINDS.has(entry.fact.kind));
        if (item.owner && unit.definitions.get(item.owner)?.fact.typeParameters.includes(name)) return [];
        return types?.length ? types : undefined;
      }
      const entries = unit.names.get(item.key)?.get(name);
      // Even an uninitialized/future local masks the outer name. It cannot
      // acquire the imported/type identity merely because inference failed.
      if (entries?.length) return entries;
      if (item.owner && unit.definitions.get(item.owner)?.fact.typeParameters.includes(name)) return [];
    }
    return undefined;
  }
  private accessible(definition: JvmDefinition, unit: Unit, scope: string): boolean {
    if (!definition.symbol) return definition.unit === unit;
    const environment = this.resolver.environment(unit.file.path);
    if (environment.status !== 'resolved') return false;
    const currentType = this.enclosingType(unit, scope), ancestors = new Set(this.chain(unit, scope).flatMap(item => item.owner ? [item.owner] : []));
    let target: JvmDefinition | undefined = definition;
    const seen = new Set<string>();
    while (target?.symbol && !seen.has(target.id)) {
      seen.add(target.id);
      const symbol = target.symbol, access = symbol.syntax.visibility;
      if (access === 'internal' && symbol.project.id !== environment.project.id) return false;
      if (access === 'package' && symbol.package !== environment.syntax.package) return false;
      if (access === 'protected') {
        // Java's same-package case is reviewed. Subclass receiver restrictions
        // and Kotlin protected access require a future inheritance profile.
        if (target.unit.file.language !== 'java' || symbol.package !== environment.syntax.package) return false;
      }
      if (access === 'private') {
        if (target.unit !== unit) return false;
        if (target.fact.parent && !ancestors.has(target.fact.parent) && currentType?.fact.key !== target.fact.parent) return false;
      }
      target = target.fact.parent ? target.unit.definitions.get(target.fact.parent) : undefined;
    }
    return true;
  }
  private fromDefinitions(definitions: JvmDefinition[], unit: Unit, scope: string, proof: Evidence[], exact = false): JvmBoundValue {
    if (!definitions.length) return unknown('Original declaration is unavailable', proof);
    if (definitions.some(definition => !this.accessible(definition, unit, scope))) return unknown('Original JVM declaration is inaccessible or has unreviewed protected/nest access', proof);
    if (definitions.every(definition => CALLABLE_KINDS.has(definition.fact.kind))) {
      const direct = definitions.every(definition => this.direct(definition, exact));
      return { kind: 'callable', definitions, direct, ...direct ? {} : { reason: 'Virtual/interface receiver dispatch is not an exact original handler call' }, proof: [...proof, ...definitions.flatMap(definition => definition.symbol?.proof ?? this.proof(definition.unit, definition.fact, 'Original local declaration'))] };
    }
    if (definitions.length !== 1) return unknown('Competing original JVM declarations; no classpath/overload winner is assumed', proof);
    const definition = definitions[0]!, facts = [...proof, ...definition.symbol?.proof ?? this.proof(definition.unit, definition.fact, 'Original local declaration')];
    if (TYPE_KINDS.has(definition.fact.kind)) {
      if (definition.fact.kind === 'typealias') return unknown('Kotlin typealias expansion requires a reviewed type profile', facts);
      return { kind: 'type', definition, proof: facts };
    }
    if (definition.fact.kind === 'property') return { kind: 'property', definition, proof: facts };
    return unknown('Declaration kind is not a reviewed JVM value', facts);
  }
  private direct(definition: JvmDefinition, exact: boolean, suspend = false): boolean {
    if (definition.fact.gaps.length || definition.fact.typeParameters.length || definition.fact.modifiers.some(modifier => ['abstract', 'native', 'external', 'expect', 'actual', ...suspend?[]:['suspend']].includes(modifier))) return false;
    if (['function', 'lambda', 'constructor'].includes(definition.fact.kind) && (!definition.fact.parent || definition.fact.kind !== 'function' || !TYPE_KINDS.has(definition.unit.definitions.get(definition.fact.parent)?.fact.kind ?? ''))) return true;
    const owner = definition.fact.parent ? definition.unit.definitions.get(definition.fact.parent) : undefined;
    if (owner?.fact.kind === 'interface' || owner?.fact.kind === 'annotation') return false;
    if (definition.symbol?.syntax.static || definition.fact.modifiers.includes('private') || definition.fact.modifiers.includes('final')) return true;
    if (owner && this.finalType(owner)) return true;
    if (exact && owner && ['class', 'object'].includes(owner.fact.kind)) return true;
    return definition.unit.file.language === 'kotlin' && !definition.fact.modifiers.some(modifier => ['open', 'override', 'abstract'].includes(modifier));
  }
  private finalType(definition: JvmDefinition): boolean {
    return definition.fact.modifiers.includes('final') || ['enum', 'record', 'object'].includes(definition.fact.kind) || definition.unit.file.language === 'kotlin' && definition.fact.kind === 'class' && !definition.fact.modifiers.some(modifier => ['open', 'abstract', 'sealed'].includes(modifier));
  }
  private importValue(unit: Unit, scope: string, outcome: JvmResolution): JvmBoundValue {
    if (outcome.status === 'resolved') return this.fromDefinitions(outcome.symbols.flatMap(symbol => this.byId.get(symbol.id) ? [this.byId.get(symbol.id)!] : []), unit, scope, outcome.proof);
    if (outcome.status === 'external') return { kind: 'external', name: outcome.dependency, proof: outcome.proof };
    return unknown(outcome.reason);
  }
  private typeName(unit: Unit, scope: string, expression: JvmExpression): JvmBoundValue {
    if (expression.kind !== 'name') return unknown('Nullable/generic/array/function type requires a reviewed type profile');
    const name = expression.name, lexical = this.lexical(unit, scope, name, expression.start);
    if (lexical) return lexical.length && lexical.every(entry => 'id' in entry && TYPE_KINDS.has(entry.fact.kind)) ? this.fromDefinitions(lexical as JvmDefinition[], unit, scope, []) : unknown('Lexical value/type parameter masks the JVM type name');
    const value = this.name(unit, scope, expression, true);
    const builtIn = unit.file.language === 'java' ? PRIMITIVES.has(name) ? name : name === 'String' || name === 'java.lang.String' ? 'String' : undefined : KOTLIN_BUILTINS[name] ?? (name.startsWith('kotlin.') ? KOTLIN_BUILTINS[name.slice(7)] : undefined);
    if (builtIn && (value.kind === 'external' && ['java.lang.String', ...Object.keys(KOTLIN_BUILTINS).map(key => `kotlin.${key}`)].includes(value.name) || value.kind === 'unknown' && !this.hasExplicitName(unit, name) && !this.resolver.facts(unit.file.path)?.imports.some(fact => fact.kind.endsWith('star')))) return { kind: 'primitive', name: builtIn, proof: this.proof(unit, expression, 'Reviewed JVM primitive/string source type') };
    return value;
  }
  private hasExplicitName(unit: Unit, name: string): boolean {
    return !!this.resolver.facts(unit.file.path)?.imports.some(fact => !fact.kind.endsWith('star') && (fact.alias ?? fact.specifier.split('.').at(-1)) === name);
  }
  private name(unit: Unit, scope: string, expression: JvmExpression & { kind: 'name' }, typeOnly = false): JvmBoundValue {
    const name = expression.name, environment = this.resolver.environment(unit.file.path);
    if (environment.status !== 'resolved') return unknown(environment.reason);
    if (name.includes('.')) {
      const head = name.split('.')[0]!;
      if (this.lexical(unit, scope, head, expression.start) || this.hasExplicitName(unit, head) || environment.symbols.some(symbol => !symbol.syntax.parent && symbol.package === environment.syntax.package && symbol.syntax.name === head)) return unknown('A source/imported type or lexical binding masks the qualified JVM package head');
    }
    if (name === 'this' || name === 'super') {
      if (name === 'super') return unknown('Explicit super dispatch requires a reviewed ancestor/constructor profile');
      const owner = this.enclosingType(unit, scope);
      return owner && !this.staticScope(unit, scope) ? { kind: 'instance', definition: owner, exact: this.finalType(owner), proof: owner.symbol?.proof ?? [] } : unknown('No reviewed implicit this receiver');
    }
    const lexical = this.lexical(unit, scope, name, expression.start);
    if (lexical) {
      if (!lexical.length) return unknown('JVM type parameter masks the outer declaration');
      if (lexical.every(entry => 'id' in entry)) return this.fromDefinitions(lexical as JvmDefinition[], unit, scope, []);
      if (lexical.length !== 1 || 'id' in lexical[0]!) return unknown('Competing lexical JVM bindings');
      return this.binding(lexical[0] as Binding, scope, expression.start);
    }
    if (!typeOnly) {
      const owner = this.enclosingType(unit, scope);
      if (owner) {
        const members = this.members(owner, name);
        if (members.length) {
          if (this.staticScope(unit, scope) && members.some(member => !member.symbol?.syntax.static)) return unknown('Instance member is unavailable in a static JVM context');
          if (owner.fact.bases.length) return unknown('Inherited overloads/overrides require a reviewed ancestor profile');
          return this.fromDefinitions(members, unit, scope, [], this.finalType(owner));
        }
      }
    }
    const imports = environment.syntax.imports.filter(fact => !fact.kind.endsWith('star') && (fact.alias ?? fact.specifier.split('.').at(-1)) === name);
    if (imports.length) {
      if (imports.length !== 1) return unknown('Competing explicit JVM imports');
      return this.importValue(unit, scope, this.resolver.resolve(unit.file.path, imports[0]!));
    }
    const accept = (symbol: JvmSymbol) => typeOnly ? TYPE_KINDS.has(symbol.declaration.kind) : unit.file.language === 'kotlin' || TYPE_KINDS.has(symbol.declaration.kind);
    const qualified = name.includes('.') ? name : [environment.syntax.package, name].filter(Boolean).join('.');
    const local = this.resolver.qualified(unit.file.path, qualified, accept);
    if (local.status === 'resolved') return this.importValue(unit, scope, local);
    if (name.includes('.')) return this.importValue(unit, scope, local);
    // On-demand imports remain possible competitors even when the external
    // classpath is absent. Do not silently prefer the first source candidate.
    const stars = environment.syntax.imports.filter(fact => fact.kind.endsWith('star'));
    const candidates: JvmSymbol[] = [];
    for (const star of stars) {
      const result = this.resolver.resolve(unit.file.path, star);
      if (result.status !== 'resolved') return unknown('An on-demand JVM import has an unverified source/export set');
      candidates.push(...result.symbols.filter(symbol => symbol.syntax.name === name && accept(symbol)));
    }
    if (candidates.length) return this.fromDefinitions([...new Set(candidates.map(symbol => symbol.id))].flatMap(id => this.byId.get(id) ? [this.byId.get(id)!] : []), unit, scope, candidates.flatMap(symbol => symbol.proof));
    return unknown('No original JVM lexical/import/package declaration matches the name');
  }
  private members(owner: JvmDefinition, name: string): JvmDefinition[] {
    return this.memberNames.get(owner.id)?.get(name) ?? [];
  }
  private changed(binding: Binding): boolean {
    return binding.unit.facts.writes.some(write => write.target.kind === 'name' && write.target.name === binding.fact.name && this.lexical(binding.unit, write.scope, write.target.name, write.start)?.includes(binding));
  }
  private binding(binding: Binding, scope: string, start: number): JvmBoundValue {
    const { fact, unit } = binding;
    if (fact.kind !== 'parameter' && fact.kind !== 'catch' && fact.kind !== 'loop' && fact.end > start) return unknown('JVM local has not completed initialization');
    if (fact.kind === 'loop' || fact.kind === 'catch' || fact.kind === 'pattern') return unknown('Loop/catch/pattern value requires a reviewed flow profile');
    const declared = fact.type ? this.typeName(unit, fact.scope, fact.type) : undefined;
    if (declared && !['type', 'primitive'].includes(declared.kind)) return unknown('Declared JVM binding type is outside the reviewed type profile', declared.proof);
    if (fact.value && fact.immutable && !this.changed(binding) && !(unit.file.language === 'java' && fact.value.kind === 'lambda')) {
      const value = this.value(unit, fact.scope, fact.value);
      if (!declared && value.kind !== 'unknown' && value.kind !== 'external' && value.kind !== 'type') return value;
      if (declared?.kind === 'type' && value.kind === 'instance' && declared.definition.id === value.definition.id) return value;
    }
    if (declared?.kind === 'type') return { kind: 'instance', definition: declared.definition, exact: this.finalType(declared.definition), proof: declared.proof };
    if (declared?.kind === 'primitive') return declared;
    return unknown('Mutable, captured, inferred or untyped JVM value has no reviewed exact receiver/type');
  }
  private propertyValue(value: JvmBoundValue & { kind: 'property' }, seen = new Set<string>()): JvmBoundValue {
    const { definition } = value;
    if (seen.has(definition.id)) return unknown('Cyclic JVM property initializer', value.proof);
    const immutable = definition.fact.immutable === true;
    // Properties can have custom getters, delegates and open overrides. Only
    // original immutable fields with literal/new initializers are propagated.
    if (!immutable || definition.fact.gaps.length || !definition.fact.value || definition.fact.modifiers.some(modifier => ['open', 'override', 'lateinit', 'expect', 'actual'].includes(modifier))) return unknown('Mutable/custom/injected JVM property is not a proven initialized receiver', value.proof);
    seen.add(definition.id);
    const expression = definition.fact.value;
    if (!['literal', 'new', 'call', 'lambda'].includes(expression.kind)) return unknown('JVM property initializer requires a reviewed constant/receiver profile', value.proof);
    const bound = this.value(definition.unit, definition.fact.scope, expression);
    if (definition.fact.returnType) {
      const declared = this.typeName(definition.unit, definition.fact.scope, definition.fact.returnType);
      if (declared.kind === 'primitive') return { ...declared, proof: [...value.proof, ...declared.proof] };
      if (declared.kind !== 'type' || bound.kind !== 'instance' || declared.definition.id !== bound.definition.id) return unknown('Declared JVM property type is not the proven initializer type', [...value.proof, ...declared.proof]);
    }
    return { ...bound, proof: [...value.proof, ...bound.proof] };
  }
  private value(unit: Unit, scope: string, expression: JvmExpression, depth = 0): JvmBoundValue {
    if (++this.inferenceDepth > 64) { this.inferenceDepth--; return unknown('Cyclic/deep JVM value inference exceeds the binding budget'); }
    try { return this.valueInner(unit, scope, expression, depth); }
    finally { this.inferenceDepth--; }
  }
  private valueInner(unit: Unit, scope: string, expression: JvmExpression, depth = 0): JvmBoundValue {
    if (++this.operations > 2_000_000 || depth > 32) return unknown('JVM reference binding budget exceeded');
    const gap = this.scopeGap(unit, scope); if (gap) return unknown(gap);
    const environment = this.resolver.environment(unit.file.path); if (environment.status !== 'resolved') return unknown(environment.reason);
    if (expression.kind === 'unknown') return unknown('Expression is outside the reviewed JVM syntax/type subset');
    if (expression.kind === 'literal') return { kind: 'primitive', name: expression.literalType ?? (typeof expression.value === 'string' ? 'String' : typeof expression.value === 'boolean' ? 'boolean' : expression.value === null ? 'null' : 'int'), proof: this.proof(unit, expression, 'Original JVM literal type') };
    if (expression.kind === 'name') return this.name(unit, scope, expression);
    if (expression.kind === 'lambda') {
      if (unit.file.language !== 'kotlin') return unknown('Java lambda invocation requires a reviewed functional-interface/SAM profile');
      const definition = unit.definitions.get(expression.key);
      return definition ? { kind: 'callable', definitions: [definition], direct: true, proof: this.proof(unit, expression, 'Original JVM lambda value') } : unknown('Original JVM lambda identity is unavailable');
    }
    if (expression.kind === 'member') {
      if (expression.safe) return unknown('Nullable/safe-navigation JVM dispatch requires a reviewed flow profile');
      let object = this.value(unit, scope, expression.object, depth + 1);
      if (object.kind === 'property') object = this.propertyValue(object);
      if (object.kind === 'external') return { ...object, name: `${object.name}.${expression.name}` };
      if (object.kind !== 'type' && object.kind !== 'instance') return unknown('JVM selector receiver is not a proven original type/value', object.proof);
      if (object.definition.fact.bases.length || object.definition.fact.typeParameters.length) return unknown('Inherited/generic JVM member set requires a reviewed ancestor/type profile', object.proof);
      const members = this.members(object.definition, expression.name);
      if (object.kind === 'type' && members.some(member => !member.symbol?.syntax.static && !TYPE_KINDS.has(member.fact.kind)) && object.definition.fact.kind !== 'object') return unknown('Instance member cannot be selected through an original JVM type', object.proof);
      return this.fromDefinitions(members, unit, scope, object.proof, object.kind === 'instance' && object.exact || object.definition.fact.kind === 'object');
    }
    if (expression.kind === 'new') {
      if (expression.anonymous) return unknown('Anonymous JVM construction has an unreviewed receiver type');
      const type = this.typeName(unit, scope, expression.type);
      return type.kind === 'type' && this.construction(unit, scope, expression, type.definition) ? { kind: 'instance', definition: type.definition, exact: true, proof: type.proof } : unknown('Constructed receiver is not a reviewed concrete original JVM class/signature', type.proof);
    }
    if (expression.kind === 'call') {
      const callee = this.value(unit, scope, expression.callee, depth + 1);
      if (unit.file.language === 'kotlin' && callee.kind === 'type' && this.construction(unit, scope, expression, callee.definition)) return { kind: 'instance', definition: callee.definition, exact: true, proof: callee.proof };
      return unknown('JVM call-result/factory propagation requires a reviewed return/type profile', callee.proof);
    }
    if (expression.kind === 'method-reference') return unknown('Method-reference overload/SAM binding requires a reviewed expected type; no invocation is inferred');
    if (expression.kind === 'class') return this.typeName(unit, scope, expression.type);
    return unknown('Cast/operator/index JVM typing requires a reviewed type profile');
  }
  private construction(unit: Unit, scope: string, expression: JvmExpression & { kind: 'call' | 'new' }, definition: JvmDefinition): boolean {
    if (definition.fact.kind !== 'class' || definition.fact.modifiers.includes('abstract') || definition.fact.typeParameters.length || definition.fact.gaps.length) return false;
    const constructors = [...definition.unit.definitions.values()].filter(item => item.fact.parent === definition.fact.key && item.fact.kind === 'constructor');
    if (!constructors.length && definition.unit.file.language === 'java') return expression.args.length === 0;
    // The primary constructor signature is original class syntax; it validates
    // a receiver value without fabricating a generated callable graph entity.
    const selected = this.select(unit, scope, expression, { kind: 'callable', definitions: constructors.length ? constructors : [definition], direct: true, proof: [] });
    return selected.kind === 'callable' && selected.definitions.length === 1;
  }
  bound(file: string, scope: string, expression: JvmExpression, typeOnly = false, selectedCallableScopes: string[] = []): JvmBoundValue {
    this.operations = 0;
    const unit = this.units.get(file);
    this.selectedCallableScopes=new Set(selectedCallableScopes);
    try{return unit ? typeOnly ? this.typeName(unit, scope, expression) : this.value(unit, scope, expression) : unknown('Complete selected JVM semantic facts are unavailable');}
    finally{this.selectedCallableScopes.clear();}
  }
  /** Pack-specific syntax propagation. A declared external/generic type is kept
   * as data for the pack to validate; it is never generalized to JVM typing. */
  initialized(file:string,scope:string,expression:JvmExpression,selectedCallableScopes:string[]=[]):{file:string;scope:string;expression:JvmExpression;type?:JvmExpression;storage:'local'|'property';proof:Evidence[]}|undefined{
    this.operations=0;const unit=this.units.get(file);if(!unit||this.resolver.environment(file).status!=='resolved')return;
    this.selectedCallableScopes=new Set(selectedCallableScopes);
    try{
      if(this.scopeGap(unit,scope))return;
      if(expression.kind==='name'){
        const entries=this.lexical(unit,scope,expression.name,expression.start);
        if(entries?.length===1&&!('id'in entries[0]!)){
          const binding=entries[0] as Binding,fact=binding.fact;
          if(fact.kind!=='local'||!fact.value||fact.end>expression.start||this.changed(binding)||unit.file.language==='kotlin'&&!fact.immutable)return;
          return {file,scope:fact.scope,expression:fact.value,type:fact.type,storage:'local',proof:this.proof(unit,fact,'Original unchanged local initializer under the selected functional API')};
        }
      }
      const value=this.value(unit,scope,expression);
      if(value.kind!=='property')return;
      const definition=value.definition,fact=definition.fact;
      if(!fact.immutable||!fact.value||fact.gaps.length||fact.modifiers.some(item=>['open','override','lateinit','expect','actual'].includes(item)))return;
      if(definition.unit.facts.writes.some(write=>write.target.kind==='name'&&write.target.name===fact.name||write.target.kind==='member'&&write.target.name===fact.name))return;
      return {file:definition.unit.file.path,scope:fact.scope,expression:fact.value,type:fact.returnType,storage:'property',proof:value.proof};
    }finally{this.selectedCallableScopes.clear();}
  }
  /** Known functional API expected type only. No registration-time invocation
   * or general SAM/overload inference is added to the call graph. */
  functionalHandler(file:string,scope:string,expression:JvmExpression,requestType:string,resultType:string,resultArgument?:string,suspend=false,selectedScopes:string[]=[]):{definition?:JvmDefinition;reason?:string;proof:Evidence[]}{
    const matches=(definition:JvmDefinition,where:string,type:JvmExpression|undefined,name:string,argument?:string):boolean=>{
      if(!type)return false;
      const base=type.kind==='generic-type'?type.name:type,bound=this.bound(definition.unit.file.path,where,base,true,selectedScopes);
      if(bound.kind!=='external'||bound.name!==name)return false;
      return argument?type.kind==='generic-type'&&type.arguments.length===1&&matches(definition,where,type.arguments[0],argument):type.kind!=='generic-type';
    };
    if(expression.kind==='lambda'){
      const definition=this.definition(file,expression.key);
      if(!definition||definition.fact.parameters.length!==1&&!(definition.unit.file.language==='kotlin'&&!definition.fact.parameters.length))return{reason:'Functional handler lambda requires one original request parameter',proof:[]};
      if(definition.fact.parameters.some(parameter=>parameter.type&&!matches(definition,definition.fact.scope,parameter.type,requestType)))return{reason:'Functional handler lambda has a competing explicit parameter type',proof:[]};
      return{definition,proof:this.proof(definition.unit,expression,'Original lambda under the selected WebFlux handler expected type')};
    }
    if(expression.kind!=='method-reference')return{reason:'Functional handler value is not an original reviewed lambda/method reference',proof:[]};
    const selector:JvmExpression=expression.object?{...expression,kind:'member',object:expression.object,name:expression.name}:{...expression,kind:'name',name:expression.name};
    const bound=this.bound(file,scope,selector,false,selectedScopes);
    if(bound.kind!=='callable')return{reason:bound.kind==='unknown'?bound.reason:'Method reference does not bind an original callable',proof:bound.proof};
    const candidates=bound.definitions.filter(definition=>definition.fact.parameters.length===1&&!definition.fact.parameters[0]?.variadic&&!definition.fact.parameters[0]?.default&&matches(definition,definition.fact.scope,definition.fact.parameters[0]?.type,requestType)&&matches(definition,definition.fact.scope,definition.fact.returnType,resultType,resultArgument)&&definition.fact.modifiers.includes('suspend')===suspend);
    if(candidates.length!==1)return{reason:'Functional handler expected request/result types do not select one reviewed original overload',proof:bound.proof};
    const definition=candidates[0]!;
    if(!bound.direct&&!(suspend&&this.direct(definition,false,true)))return{reason:bound.reason??'Functional receiver dispatch is not a proven original method',proof:bound.proof};
    return{definition,proof:bound.proof};
  }
  constant(file: string, scope: string, expression: JvmExpression): JvmConstant {
    this.operations = 0;
    const unit = this.units.get(file); if (!unit) return noConstant('Complete JVM semantic facts are unavailable');
    const evaluate = (origin: Unit, where: string, item: JvmExpression, seen: Set<string>, depth: number): JvmConstant => {
      if (++this.operations > 100_000 || depth > 32) return noConstant('JVM constant evaluation budget exceeded');
      if (item.kind === 'literal') return { status: 'resolved', value: item.value, proof: this.proof(origin, item, 'Original JVM annotation/constant literal') };
      if (item.kind === 'array') {
        const values = item.items.map(part => evaluate(origin, where, part, seen, depth + 1)), invalid = values.find(value => value.status !== 'resolved');
        if (invalid) return invalid;
        return { status: 'resolved', value: values.map(value => (value as JvmConstant & { status: 'resolved' }).value), proof: values.flatMap(value => value.proof) };
      }
      if (item.kind === 'binary' && item.operator === '+') {
        const left = evaluate(origin, where, item.left, seen, depth + 1), right = evaluate(origin, where, item.right, seen, depth + 1);
        if (left.status === 'resolved' && right.status === 'resolved' && typeof left.value === 'string' && typeof right.value === 'string' && left.value.length + right.value.length <= 8192) return { status: 'resolved', value: left.value + right.value, proof: [...left.proof, ...right.proof] };
        return noConstant('Only bounded original constant string concatenation is reviewed');
      }
      const bound = this.value(origin, where, item);
      if (bound.kind !== 'property') return noConstant('Annotation value is not a reviewed original literal/constant field', bound.proof);
      const { definition } = bound;
      const immutable = definition.unit.file.language === 'java' ? definition.fact.modifiers.includes('static') && definition.fact.modifiers.includes('final') : definition.fact.modifiers.includes('const');
      if (!immutable || !definition.fact.value || seen.has(definition.id) || definition.fact.gaps.length) return noConstant('Annotation constant is mutable, non-constant, cyclic or opaque', bound.proof);
      const next = new Set(seen); next.add(definition.id);
      const result = evaluate(definition.unit, definition.fact.scope, definition.fact.value, next, depth + 1);
      return { ...result, proof: [...bound.proof, ...result.proof] };
    };
    const environment = this.resolver.environment(file);
    return environment.status === 'resolved' ? evaluate(unit, scope, expression, new Set(), 0) : noConstant(environment.reason);
  }
  private argumentType(unit: Unit, scope: string, expression: JvmExpression): string | undefined {
    let value = this.value(unit, scope, expression);
    if (value.kind === 'property') value = this.propertyValue(value);
    return value.kind === 'primitive' ? value.name : value.kind === 'instance' ? value.definition.id : undefined;
  }
  private select(unit: Unit, scope: string, expression: JvmExpression & { kind: 'call' | 'new' }, callable: JvmBoundValue & { kind: 'callable' }): JvmBoundValue {
    if (expression.kind === 'call' && expression.typeArguments || expression.args.some(arg => arg.spread)) return unknown('Explicit generics/spread JVM overload binding is outside the reviewed subset', callable.proof);
    if (callable.definitions.some(definition => definition.fact.gaps.length || definition.fact.typeParameters.length || definition.fact.receiverType || definition.fact.parameters.some(parameter => parameter.variadic || parameter.default))) return unknown('Generic/extension/vararg/default overload set requires a reviewed type profile', callable.proof);
    const types = expression.args.map(arg => this.argumentType(unit, scope, arg.value));
    if (types.some(type => !type)) return unknown('Unknown argument type prevents certified original JVM overload binding', callable.proof);
    const matches: JvmDefinition[] = [];
    for (const definition of callable.definitions) {
      if (definition.fact.parameters.length !== types.length) continue;
      const namedArgs = expression.args.some(arg => arg.name);
      if (namedArgs && (unit.file.language !== 'kotlin' || definition.unit.file.language !== 'kotlin')) return unknown('Named arguments are not reviewed for this JVM declaration', callable.proof);
      const positions = expression.args.map((arg, index) => arg.name ? definition.fact.parameters.findIndex(parameter => parameter.name === arg.name) : index);
      if (positions.some(position => position < 0) || new Set(positions).size !== positions.length || expression.args.some((arg, index) => !arg.name && expression.args.slice(0, index).some(previous => previous.name))) continue;
      const expected = definition.fact.parameters.map(parameter => parameter.type ? this.typeName(definition.unit, definition.fact.bodyScope ?? definition.fact.scope, parameter.type) : unknown('Untyped parameter'));
      const names = expected.map(value => value.kind === 'primitive' ? value.name : value.kind === 'type' ? value.definition.id : undefined);
      if (names.some(name => !name)) return unknown('An overload parameter has an unreviewed original type', callable.proof);
      // Exact types only: widening, boxing, null specificity, inheritance and
      // SAM conversions deliberately remain unresolved rather than guessed.
      if (types.every((type, index) => type === names[positions[index]!])) matches.push(definition);
    }
    if (matches.length !== 1) return unknown(matches.length ? 'Competing exact original JVM overloads' : 'No reviewed exact JVM signature matches these arguments', callable.proof);
    return { ...callable, definitions: matches, direct: this.direct(matches[0]!, callable.direct), ...this.direct(matches[0]!, callable.direct) ? { reason: undefined } : {} };
  }
  private closures(unit: Unit): void {
    for (const definition of unit.definitions.values()) {
      if (definition.fact.kind !== 'lambda' || this.context.graph.entities.has(definition.id)) continue;
      const fact = definition.fact, content = this.context.sources!.readText(unit.file.path).slice(fact.start, fact.end), owner = this.owner(unit, fact.scope);
      this.context.graph.contain({ id: definition.id, type: 'function', name: '<lambda>', path: unit.file.path, language: unit.file.language, parentId: owner, sourceRange: fact.range, metrics: { loc: fact.range.endLine - fact.range.startLine + 1 }, metadata: { declarationKind: 'lambda', role: 'closure', ...declarationHashes(content, 0) }, evidence: this.proof(unit, fact, 'Original JVM lambda source') });
    }
  }
  analyze(files: ScannedFile[]): void {
    for (const file of files) {
      const entity = this.context.graph.entities.get(file.id)!, analysis = fileAnalysis(entity.metadata.analysis), unit = this.units.get(file.path);
      if (!analysis) continue;
      const environment = this.resolver.environment(file.path);
      if (!unit || environment.status !== 'resolved') {
        analysis.features.references = { status: environment.status === 'excluded' ? 'disabled' : 'unsupported', reason: environment.status === 'resolved' ? 'Complete JVM semantic facts are unavailable' : environment.reason };
        continue;
      }
      this.closures(unit);
      const references: unknown[] = [], calls: unknown[] = [], counts = new Map<string, CallSites>();
      const targets = (bound: JvmBoundValue) => bound.kind === 'type' || bound.kind === 'instance' || bound.kind === 'property' ? [bound.definition.id] : bound.kind === 'callable' ? bound.definitions.map(definition => definition.id) : [];
      const serialize = (bound: JvmBoundValue) => bound.kind === 'unknown' ? { status: 'unresolved', reason: bound.reason } : bound.kind === 'external' ? { status: 'external', dependency: bound.name } : { status: 'resolved', declarations: targets(bound), kind: bound.kind };
      for (const reference of unit.facts.references) {
        this.operations = 0;
        const bound = reference.kind === 'type' ? this.typeName(unit, reference.scope, reference.expression) : this.value(unit, reference.scope, reference.expression), owner = this.owner(unit, reference.scope), proof = [...this.proof(unit, reference, 'Original scoped JVM reference'), ...bound.proof];
        references.push({ range: reference.range, kind: reference.kind, outcome: serialize(bound), proof });
        for (const target of targets(bound)) if (target !== owner) this.context.graph.relate(owner, target, 'references', proof, { adapter: 'jvm', version: JVM_SYMBOL_VERSION });
      }
      for (const call of unit.facts.calls) {
        this.operations = 0;
        const owner = this.owner(unit, call.scope), count = counts.get(owner) ?? { resolved: 0, external: 0, unresolved: 0, unresolvedNames: {} }, expression = call.expression;
        let bound = expression.kind === 'call' ? this.value(unit, call.scope, expression.callee) : expression.kind === 'new' ? this.typeName(unit, call.scope, expression.type) : unknown('Explicit this/super constructor dispatch requires a reviewed ancestor profile');
        if (bound.kind === 'property') bound = this.propertyValue(bound);
        if (bound.kind === 'type' && (expression.kind === 'new' || expression.kind === 'call' && file.language === 'kotlin')) {
          const type = bound.definition;
          const constructors = [...type.unit.definitions.values()].filter(definition => definition.fact.parent === type.fact.key && definition.fact.kind === 'constructor');
          bound = constructors.length ? { kind: 'callable', definitions: constructors, direct: true, proof: bound.proof } : unknown('Implicit/primary/compiler-generated constructor has no original callable declaration', bound.proof);
        }
        if (bound.kind === 'callable' && (expression.kind === 'call' || expression.kind === 'new')) bound = this.select(unit, call.scope, expression, bound);
        const proof = [...this.proof(unit, call, 'Original JVM call site'), ...bound.proof], conditions = [...environment.conditions, ...this.chain(unit, call.scope).flatMap(scope => [...scope.conditional ? [scope.conditional] : [], ...scope.deferred ? ['Invocation is inside an original deferred lambda body'] : []])];
        if (bound.kind === 'callable' && bound.direct && bound.definitions.length === 1) {
          count.resolved++; const target = bound.definitions[0]!.id;
          this.context.graph.relate(owner, target, 'calls', proof, { adapter: 'jvm', version: JVM_SYMBOL_VERSION, dispatch: 'direct', conditions });
          calls.push({ range: call.range, kind: call.kind, status: 'resolved', target, conditions, proof });
        } else {
          count.unresolved++;
          const name = this.context.sources!.readText(file.path).slice(call.start, Math.min(call.end, call.start + 200));
          count.unresolvedNames![name] = (count.unresolvedNames![name] ?? 0) + 1;
          const reason = bound.kind === 'unknown' ? bound.reason : bound.kind === 'callable' ? bound.reason : bound.kind === 'external' ? 'External spelling has no certified binary/API callable identity' : 'JVM value is not a reviewed original callable';
          calls.push({ range: call.range, kind: call.kind, status: 'unresolved', reason, ...bound.kind === 'callable' ? { candidates: targets(bound) } : {}, ...bound.kind === 'external' ? { dependency: bound.name } : {}, conditions, proof });
        }
        counts.set(owner, count);
      }
      for (const [id, countsForOwner] of counts) this.context.graph.entities.get(id)!.metadata.callSites = countsForOwner;
      entity.metadata.jvmReferenceOutcomes = references; entity.metadata.jvmCallOutcomes = calls;
      analysis.features.references = { status: 'partial', reason: 'Original scoped declarations, selected source types, exact typed overloads and direct static/private/final/concrete calls; virtual/inherited/generic/compiler interop, nullability, full type checking and generated constructors retain gaps' };
    }
  }
}
