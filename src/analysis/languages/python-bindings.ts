import type { PythonImportFact, StructureFacts } from '../facts.js';

/** Conservative lexical import provenance, separate from symbol/call binding.
 * Whole-scope writes invalidate a name: Python function locals are determined
 * for the whole body, while module execution order is not simulated here. */
export class PythonImportBindings {
  private readonly declarations;
  private readonly imports = new Map<string, Map<string, PythonImportFact[]>>();
  private readonly writes = new Map<string, Set<string>>();
  private readonly opaque = new Set<string>();
  private readonly scopes = new Map<string, (string | undefined)[]>();
  constructor(readonly facts: StructureFacts) {
    this.declarations = new Map<string, { parent?: string; kind: string }>([...facts.declarations, ...facts.python!.scopes].map(declaration => [declaration.key, declaration]));
    for (const scope of facts.python!.opaqueScopes) this.opaque.add(scope);
    for (const write of facts.python!.writes) {
      const scope = write.scope ?? '', names = this.writes.get(scope) ?? new Set<string>();
      names.add(write.kind === 'mutation' ? `${write.name}[]` : write.name); this.writes.set(scope, names);
    }
    for (const fact of facts.python!.imports) for (const binding of fact.bindings) {
      const scope = fact.scope ?? '', names = this.imports.get(scope) ?? new Map<string, PythonImportFact[]>(), entries = names.get(binding.local) ?? [];
      if (binding.imported === '*') this.opaque.add(scope);
      entries.push(fact); names.set(binding.local, entries); this.imports.set(scope, names);
    }
    for (const call of facts.python!.calls) if (['exec', 'eval', 'globals', 'locals'].includes(call.callee)) this.opaque.add(call.scope ?? '');
  }
  visible(scope: string | undefined): (string | undefined)[] {
    const cached = this.scopes.get(scope ?? ''); if (cached) return cached;
    const result: (string | undefined)[] = [scope];
    let parent = scope ? this.declarations.get(scope)?.parent : undefined;
    while (parent) { const declaration = this.declarations.get(parent); if (!declaration) break; if (declaration.kind !== 'class') result.push(parent); parent = declaration.parent; }
    if (scope) result.push(undefined); this.scopes.set(scope ?? '', result); return result;
  }
  written(scope: string | undefined, name: string): boolean { return this.writes.get(scope ?? '')?.has(name) ?? false; }
  shadowed(scope: string | undefined, name: string): boolean {
    return this.visible(scope).some(scope => this.opaque.has(scope ?? '') || this.written(scope, name) || this.imports.get(scope ?? '')?.has(name));
  }
  imported(scope: string | undefined, name: string, before: number, ignoreWriteStart?: number): { fact: PythonImportFact; imported: string } | undefined {
    for (const visible of this.visible(scope)) {
      const written = ignoreWriteStart === undefined ? this.written(visible, name) : this.facts.python!.writes.some(write => write.scope === visible && write.name === name && write.kind !== 'mutation' && write.start !== ignoreWriteStart);
      if (this.opaque.has(visible ?? '') || written) return undefined;
      const candidates = this.imports.get(visible ?? '')?.get(name);
      if (!candidates?.length) continue;
      if (candidates.length !== 1) return undefined;
      const fact = candidates[0]!;
      return fact.start < before && !fact.conditions.length ? { fact, imported: fact.bindings.find(binding => binding.local === name)!.imported } : undefined;
    }
    return undefined;
  }
}
