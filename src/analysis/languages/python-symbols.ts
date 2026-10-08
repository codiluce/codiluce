import type { AnalysisContext } from '../../core/analyzer.js';
import { evidence, type CallSites, type Evidence } from '../../core/graph.js';
import { fileAnalysis, type DeclarationFact, type PythonAssignmentFact, type PythonExpression, type PythonImportFact, type StructureFacts } from '../facts.js';
import type { PythonModule, PythonResolver } from '../resolution/python.js';

export type PythonBound =
  | { kind: 'symbol'; file: string; declaration: DeclarationFact; id: string }
  | { kind: 'value'; file: string; assignment: PythonAssignmentFact }
  | { kind: 'module'; importer: string; name: string; modules: PythonModule[] }
  | { kind: 'external'; name: string }
  | { kind: 'builtin'; name: string }
  | { kind: 'unresolved'; reason: string };
const missing = (reason: string): PythonBound => ({ kind: 'unresolved', reason });
const builtins = new Set(['print', 'len', 'str', 'int', 'float', 'bool', 'dict', 'list', 'tuple', 'set', 'frozenset', 'range', 'enumerate', 'zip', 'sorted', 'min', 'max', 'sum', 'any', 'all', 'isinstance', 'issubclass', 'getattr', 'setattr', 'hasattr', 'super', 'object', 'type', 'staticmethod', 'classmethod', 'property', 'open', 'next', 'iter', 'abs', 'round', 'map', 'filter', 'Exception', 'ValueError', 'RuntimeError', 'NotImplementedError']);

/** Bounded Python names, not a type checker or runtime. Whole-scope writes,
 * conditional definitions, cycles and dynamic namespace hooks stop selection. */
export class PythonSymbols {
  private readonly active = new Set<string>();
  private readonly invalidClasses = new Set<string>();
  private readonly invalidMembers = new Map<string, Set<string>>();
  private readonly mutatedAttributes = new Map<string, Set<string>>();
  private steps = 0;
  constructor(readonly context: AnalysisContext, readonly resolver: PythonResolver) {
    const mutations: { receiver: PythonBound; name: string }[] = [];
    for (const [file, parsed] of context.syntax ?? []) for (const write of parsed.facts.python?.writes ?? []) {
      if (!write.name.includes('.') || write.kind === 'declaration' || write.kind === 'parameter') continue;
      const parts = write.name.split('.'), name = parts.pop()!;
      mutations.push({ receiver: this.name(file, parts.join('.'), write.scope, write.start), name });
    }
    for (const mutation of mutations) {
      if (mutation.receiver.kind === 'symbol') { const names = this.mutatedAttributes.get(mutation.receiver.id) ?? new Set<string>(); names.add(mutation.name); this.mutatedAttributes.set(mutation.receiver.id, names); }
      if (mutation.receiver.kind === 'symbol' && mutation.receiver.declaration.kind === 'class') this.invalidClasses.add(mutation.receiver.id);
      if (mutation.receiver.kind === 'module') for (const module of mutation.receiver.modules) if (module.file) { const names = this.invalidMembers.get(module.file.path) ?? new Set<string>(); names.add(mutation.name); this.invalidMembers.set(module.file.path, names); }
    }
  }
  facts(file: string): StructureFacts | undefined { return this.context.syntax?.get(file)?.facts; }
  attributeWrites(id: string): string[] { return [...this.mutatedAttributes.get(id) ?? []]; }
  moduleAttributeWritten(file: string, name: string): boolean { return this.invalidMembers.get(file)?.has(name) ?? false; }
  private deferred(facts: StructureFacts, scope?: string): boolean {
    while (scope) { const item = facts.declarations.find(item => item.key === scope) ?? facts.python?.scopes.find(item => item.key === scope); if (!item) break; if (['function', 'method', 'lambda'].includes(item.kind)) return true; scope = item.parent; }
    return false;
  }
  private visible(facts: StructureFacts, scope?: string): (string | undefined)[] {
    const scopes = [scope]; let parent = scope ? (facts.declarations.find(item => item.key === scope) ?? facts.python?.scopes.find(item => item.key === scope))?.parent : undefined;
    while (parent) { const item = facts.declarations.find(item => item.key === parent) ?? facts.python?.scopes.find(item => item.key === parent); if (!item) break; if (item.kind !== 'class') scopes.push(parent); parent = item.parent; }
    if (scope) scopes.push(undefined); return scopes;
  }
  resolve(file: string, expression: PythonExpression, scope?: string, before = Infinity, depth = 0): PythonBound {
    if (depth > 32 || ++this.steps > 500_000) return missing('Python binding budget exceeded');
    if (expression.kind === 'member') return this.member(this.resolve(file, expression.object, scope, before, depth + 1), expression.name, depth + 1);
    if (expression.kind !== 'name') return missing('Expression requires runtime value/type evaluation');
    const facts = this.facts(file), syntax = facts?.python;
    if (!facts || !syntax || facts.truncated || facts.issues.length) return missing('Complete indexed Python syntax is unavailable');
    if ((this.context.graph.entities.get(this.context.files.get(file)!.id)?.metadata.importGaps as { path: boolean }[] | undefined)?.some(gap => gap.path)) return missing('Runtime import-path mutation prevents static binding');
    const name = expression.name;
    for (const visible of this.visible(facts, scope)) {
      if (syntax.opaqueScopes.includes(visible ?? '') || syntax.calls.some(call => call.scope === visible && ['exec', 'eval', 'globals', 'locals'].includes(call.callee))) return missing('Dynamic/global/nonlocal namespace is unsupported');
      const imports = syntax.imports.filter(item => item.scope === visible && item.bindings.some(binding => binding.local === name));
      const writes = syntax.writes.filter(item => item.scope === visible && item.name === name && item.kind !== 'mutation');
      if (imports.length || writes.length) {
        if (!writes.length && imports.length > 1 && imports.every(item => item.kind === 'import' && item.moduleBinding === 'head' && item.specifier.split('.')[0] === name && !item.conditions.length && item.start < before)) return this.imported(file, imports[0]!, name, before, depth + 1);
        if (imports.length + writes.length !== 1) return missing(`Multiple writes/imports bind ${name}`);
        if (imports.length) return this.imported(file, imports[0]!, name, before, depth + 1);
        const write = writes[0]!;
        if (write.kind === 'parameter') return missing(`Parameter ${name} has no proven runtime type`);
        if (write.kind === 'augmentation') return missing(`Augmented binding ${name} requires runtime evaluation`);
        const deferred = this.deferred(facts, scope);
        if (write.start >= before && !deferred) return missing(`Binding ${name} is not yet defined`);
        if (write.kind === 'declaration') {
          const declaration = facts.declarations.find(item => item.name === name && item.parent === visible && item.start === write.start);
          if (!declaration || syntax.definitions.find(item => item.key === declaration.key)?.conditions.length) return missing(`Conditional declaration ${name}`);
          const id = this.context.syntax!.get(file)!.declarations.get(declaration.key);
          return id ? { kind: 'symbol', file, declaration, id } : missing('Declaration site is unavailable');
        }
        const assignment = syntax.assignments.find(item => item.scope === visible && item.name === name && item.start === write.start);
        if (!assignment || assignment.conditions.length) return missing(`Nonliteral or conditional assignment ${name}`);
        const key = JSON.stringify([file, visible, name]);
        if (this.active.has(key)) return missing('Cyclic Python alias/re-export');
        if (['name', 'member'].includes(assignment.value.kind)) {
          this.active.add(key); const result = this.resolve(file, assignment.value, visible, assignment.start, depth + 1); this.active.delete(key); return result;
        }
        return { kind: 'value', file, assignment };
      }
      const wildcards = syntax.imports.filter(item => item.scope === visible && item.bindings.some(binding => binding.imported === '*'));
      if (wildcards.length) {
        const candidates: PythonBound[] = [];
        for (const imported of wildcards) {
          if (imported.conditions.length || imported.start >= before) return missing('Conditional/deferred wildcard import');
          const module = this.resolver.resolve(file, imported.specifier);
          if (module.status !== 'resolved' || module.modules.length !== 1 || !module.modules[0]!.file) return missing('Wildcard source is not one indexed module');
          const target = module.modules[0]!.file!.path, all = this.exportNames(target);
          if (!all) return missing('Wildcard import requires a bounded literal __all__');
          if (all.includes(name)) candidates.push(this.exported(target, name, depth + 1));
        }
        if (candidates.length) return candidates.length === 1 ? candidates[0]! : missing('Ambiguous wildcard exports');
      }
    }
    return builtins.has(name) ? { kind: 'builtin', name } : missing(`No proven binding for ${name}`);
  }
  name(file: string, name: string, scope?: string, before = Infinity): PythonBound {
    const [head, ...tail] = name.split('.'); let result = this.resolve(file, { kind: 'name', name: head! }, scope, before);
    for (const member of tail) result = this.member(result, member, 0); return result;
  }
  exportNames(file: string): string[] | undefined {
    const facts = this.facts(file), syntax = facts?.python;
    if (!syntax || facts!.truncated || facts!.issues.length || syntax.opaqueScopes.includes('')) return undefined;
    const writes = syntax.writes.filter(item => !item.scope && (item.name === '__all__' || item.name.startsWith('__all__.')));
    const assignments = syntax.assignments.filter(item => !item.scope && item.name === '__all__' && !item.conditions.length);
    if (writes.length !== 1 || assignments.length !== 1 || syntax.calls.some(item => !item.scope && item.callee.startsWith('__all__.'))) return undefined;
    const value = assignments[0]!.value;
    return value.kind === 'sequence' && value.container !== 'set' && value.items.every(item => item.kind === 'literal' && typeof item.value === 'string') ? value.items.map(item => (item as { value: string }).value) : undefined;
  }
  private exported(file: string, name: string, depth: number): PythonBound {
    const syntax = this.facts(file)?.python;
    if (this.invalidMembers.get(file)?.has(name)) return missing('Module attribute is assigned through an indexed alias');
    if (!syntax || syntax.writes.some(write => !write.scope && write.name === '__getattr__')) return missing('Dynamic module attributes require runtime evaluation');
    if (!syntax.writes.some(write => !write.scope && write.name === name) && !syntax.imports.some(fact => !fact.scope && fact.bindings.some(binding => binding.local === name || binding.imported === '*'))) return missing('No declared/imported module attribute');
    const key = JSON.stringify(['export', file, name]);
    if (this.active.has(key) || depth > 32) return missing('Cyclic Python re-export');
    this.active.add(key); const result = this.resolve(file, { kind: 'name', name }, undefined, Infinity, depth + 1); this.active.delete(key); return result;
  }
  private imported(file: string, fact: PythonImportFact, local: string, before: number, depth: number): PythonBound {
    const entry = (this.context.graph.entities.get(this.context.files.get(file)!.id)?.metadata.importOutcomes as { range: { startLine: number }; specifier: string; typeOnly?: boolean }[] | undefined)?.find(item => item.specifier === fact.specifier && item.range.startLine === fact.range.startLine);
    if (fact.conditions.length || entry?.typeOnly || fact.start >= before) return missing('Conditional/type-only/not-yet-executed import');
    const imported = fact.bindings.find(binding => binding.local === local)!;
    const module = this.resolver.resolve(file, fact.specifier);
    if (module.status === 'external') return { kind: 'external', name: fact.kind === 'from' ? `${fact.specifier}.${imported.imported}` : fact.moduleBinding === 'head' ? fact.specifier.split('.')[0]! : fact.specifier };
    if (module.status !== 'resolved') return missing(module.reason);
    if (fact.kind === 'from') return this.member({ kind: 'module', importer: file, name: module.modules[0]!.name, modules: module.modules }, imported.imported, depth + 1);
    const name = fact.moduleBinding === 'head' ? fact.specifier.split('.')[0]! : fact.specifier;
    const head = fact.moduleBinding === 'head' ? this.resolver.resolve(file, name) : module;
    return head.status === 'resolved' ? { kind: 'module', importer: file, name, modules: head.modules } : missing('Imported module head is unavailable');
  }
  private member(value: PythonBound, name: string, depth: number): PythonBound {
    if (depth > 32) return missing('Python member binding budget exceeded');
    if (value.kind === 'external') return { kind: 'external', name: `${value.name}.${name}` };
    if (value.kind === 'module') {
      const exports = value.modules.filter(module => module.file).map(module => this.exported(module.file!.path, name, depth + 1));
      const bound = exports.filter(item => item.kind !== 'unresolved' && item.kind !== 'builtin');
      if (bound.length) return bound.length === 1 ? bound[0]! : missing('Ambiguous module exports');
      // A known attribute, dynamic __getattr__, or re-export cycle has precedence
      // over an on-disk child module; do not fall through and invent a target.
      if (value.modules.some(module => module.file && this.facts(module.file.path)?.python?.writes.some(write => !write.scope && [name, '__getattr__'].includes(write.name)) || module.file && this.facts(module.file.path)?.python?.imports.some(fact => !fact.scope && fact.bindings.some(binding => binding.local === name || binding.imported === '*')))) return missing('Package attribute/re-export is unresolved');
      const child = this.resolver.resolve(value.importer, `${value.name}.${name}`);
      return child.status === 'resolved' ? { kind: 'module', importer: value.importer, name: `${value.name}.${name}`, modules: child.modules } : missing('No proven module attribute');
    }
    if (value.kind === 'symbol' && value.declaration.kind === 'class') {
      const facts = this.facts(value.file)!, syntax = facts.python!;
      const definition = syntax.definitions.find(item => item.key === value.declaration.key);
      if (definition?.bases.length || definition?.decorators.length || this.invalidClasses.has(value.id) || syntax.writes.some(write => write.name === `${value.declaration.name}.${name}`)) return missing('Inheritance/metaclass/decorated or mutated class member');
      const declarations = facts.declarations.filter(item => item.parent === value.declaration.key && item.name === name), writes = syntax.writes.filter(item => item.scope === value.declaration.key && item.name === name);
      if (declarations.length !== 1 || writes.length !== 1 || syntax.definitions.find(item => item.key === declarations[0]!.key)?.conditions.length) return missing('Class member is ambiguous or dynamically assigned');
      const declaration = declarations[0]!, id = this.context.syntax!.get(value.file)!.declarations.get(declaration.key)!;
      return { kind: 'symbol', file: value.file, declaration, id };
    }
    return missing('Receiver has no proven static member');
  }
  callable(value: PythonBound): boolean {
    if (value.kind !== 'symbol') return false;
    const definition = this.facts(value.file)?.python?.definitions.find(item => item.key === value.declaration.key);
    if (value.declaration.kind === 'class' && definition?.bases.length) return false;
    if (!definition?.decorators.length) return true;
    if (this.context.graph.entities.get(value.id)?.metadata.pythonCallable === true) return true;
    return definition.decorators.every(expression => { const bound = this.resolve(value.file, expression, value.declaration.parent, value.declaration.start); return bound.kind === 'builtin' && ['staticmethod', 'classmethod'].includes(bound.name); });
  }
  analyze(): void {
    const graph = this.context.graph;
    for (const [file, parsed] of this.context.syntax ?? []) {
      const syntax = parsed.facts.python, scanned = this.context.files.get(file)!;
      if (!syntax || !file.endsWith('.py')) continue;
      const analysis = fileAnalysis(graph.entities.get(scanned.id)!.metadata.analysis)!;
      const fact = (line: number, explanation: string): Evidence => evidence('syntax', 'python-symbols', file, line, explanation);
      const owner = (scope?: string): string => { let key = scope; while (key) { const id = parsed.declarations.get(key); if (id) return id; key = syntax.scopes.find(item => item.key === key)?.parent; } return scanned.id; };
      for (const imported of syntax.imports.filter(item => item.bindings.some(binding => binding.imported === '*'))) {
        const module = this.resolver.resolve(file, imported.specifier);
        if (module.status !== 'resolved' || module.modules.length !== 1 || !module.modules[0]!.file || !this.exportNames(module.modules[0]!.file!.path)) graph.diagnose({ analyzer: 'python-symbols', severity: 'warning', code: 'python-wildcard-import', file, entityId: scanned.id, line: imported.range.startLine, reason: 'Wildcard binding requires one indexed source with bounded literal __all__' });
      }
      for (const reference of syntax.references) {
        const bound = this.name(file, reference.name, reference.scope, reference.start);
        if (bound.kind === 'symbol' && bound.id !== owner(reference.scope)) graph.relate(owner(reference.scope), bound.id, 'references', [fact(reference.range.startLine, `Lexically bound Python reference ${reference.name}`)]);
      }
      for (const declaration of parsed.facts.declarations) if (declaration.kind === 'class') for (const base of syntax.definitions.find(item => item.key === declaration.key)?.bases ?? []) {
        const bound = this.resolve(file, base, declaration.parent, declaration.start);
        if (bound.kind === 'symbol' && bound.declaration.kind === 'class') graph.relate(parsed.declarations.get(declaration.key)!, bound.id, 'extends', [fact(declaration.range.startLine, 'Indexed Python base class')]);
      }
      const coverage = new Map<string, CallSites>();
      for (const call of syntax.calls) {
        const id = owner(call.scope), sites = coverage.get(id) ?? { resolved: 0, external: 0, unresolved: 0 };
        const bound = call.expression.kind === 'call' ? this.resolve(file, call.expression.callee, call.scope, call.start) : missing('Opaque callee');
        if (this.callable(bound) && bound.kind === 'symbol') { sites.resolved++; graph.relate(id, bound.id, 'calls', [fact(call.range.startLine, `Bound Python call ${call.callee}`)]); }
        else if (bound.kind === 'external' || bound.kind === 'builtin') sites.external++;
        else { sites.unresolved++; (sites.unresolvedNames ??= {})[call.callee] = (sites.unresolvedNames?.[call.callee] ?? 0) + 1; }
        coverage.set(id, sites);
      }
      for (const [id, callSites] of coverage) graph.entities.get(id)!.metadata.callSites = callSites;
      graph.entities.get(scanned.id)!.metadata.symbolResolver = { adapter: 'python', version: 1 };
      analysis.features.references = { status: parsed.facts.issues.length || parsed.facts.truncated ? 'failed' : 'partial', reason: 'Lexical declarations, imported members, aliases, bounded re-exports/__all__ and direct class members; dynamic dispatch, instance types, inheritance and namespace writes remain unresolved' };
    }
  }
}
