import type { AnalysisContext, Analyzer } from '../core/analyzer.js';
import type { AnalysisFeature, SupportStatus } from './facts.js';

export interface LanguageAdapter {
  id: string; version: string; languages: readonly string[];
  features: Partial<Record<AnalysisFeature, SupportStatus>>;
}
export interface FrameworkPack extends Analyzer {
  frameworks: readonly string[];
  requires: readonly string[];
  features: Partial<Record<AnalysisFeature, SupportStatus>>;
  applies(context: AnalysisContext): boolean;
}
/** Deterministic registration; dependency errors fail before any graph mutation. */
export class AnalysisRegistry {
  private readonly adapters = new Map<string, LanguageAdapter>();
  private readonly packs = new Map<string, FrameworkPack>();
  registerLanguage(adapter: LanguageAdapter): void {
    if (this.adapters.has(adapter.id) || this.packs.has(adapter.id)) throw new Error(`Duplicate language adapter: ${adapter.id}`);
    for (const previous of this.adapters.values()) if (previous.languages.some(language => adapter.languages.includes(language))) throw new Error(`Multiple authoritative adapters for ${adapter.languages.join(', ')}`);
    this.adapters.set(adapter.id, adapter);
  }
  registerPack(pack: FrameworkPack): void {
    if (this.packs.has(pack.name) || this.adapters.has(pack.name)) throw new Error(`Duplicate framework pack: ${pack.name}`);
    this.packs.set(pack.name, pack);
  }
  language(language: string): LanguageAdapter | undefined { return [...this.adapters.values()].find(adapter => adapter.languages.includes(language)); }
  orderedPacks(): FrameworkPack[] {
    const result: FrameworkPack[] = [], visiting = new Set<string>(), visited = new Set<string>();
    const visit = (name: string): void => {
      if (visited.has(name) || this.adapters.has(name)) return;
      if (visiting.has(name)) throw new Error(`Framework pack dependency cycle: ${name}`);
      const pack = this.packs.get(name);
      if (!pack) throw new Error(`Missing analysis dependency: ${name}`);
      visiting.add(name);
      for (const dependency of [...pack.requires].sort()) visit(dependency);
      visiting.delete(name); visited.add(name); result.push(pack);
    };
    for (const name of [...this.packs.keys()].sort()) visit(name);
    return result;
  }
}
