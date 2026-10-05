// Collects resolved call sites, renders and function references while
// analyzers walk their sources, then writes one relation per (from, to, type)
// with every site as evidence. Relation metadata summarizes the sites:
// how many, on which lines, in which forms (`call`, `new`, `render`,
// `handler`, `callback`, `value`; `eloquent`/`query` for table reads and
// writes; `dispatch` for queued jobs; `artisan` for console commands run by
// name), and which event props bound them.
import type { CallSites, EffectFact, Evidence, GraphBuilder } from '../core/graph.js';

export type SiteType = 'calls' | 'renders' | 'references' | 'reads' | 'writes' | 'invokes';
export type SiteForm = 'call' | 'new' | 'render' | 'handler' | 'callback' | 'value' | 'dispatch' | 'eloquent' | 'query' | 'artisan';
export interface Site { from: string; to: string; type: SiteType; form: SiteForm; evidence: Evidence; event?: string }
/** Evidence records kept per relation; `metadata.sites` keeps the full count. */
export const MAX_SITE_EVIDENCE = 25;
const MAX_LINES = 50, MAX_EFFECTS = 40, MAX_UNRESOLVED_NAMES = 40;

export class SiteCollector {
  private readonly groups = new Map<string, { from: string; to: string; type: SiteType; evidence: Evidence[]; sites: number; lines: Set<number>; forms: Set<string>; events: Set<string> }>();
  private readonly coverage = new Map<string, CallSites>();
  private readonly effects = new Map<string, EffectFact[]>();
  add(site: Site): void {
    const key = `${site.from}\u0000${site.to}\u0000${site.type}`;
    let group = this.groups.get(key);
    if (!group) { group = { from: site.from, to: site.to, type: site.type, evidence: [], sites: 0, lines: new Set(), forms: new Set(), events: new Set() }; this.groups.set(key, group); }
    group.sites++;
    if (group.evidence.length < MAX_SITE_EVIDENCE) group.evidence.push(site.evidence);
    if (site.evidence.line && group.lines.size < MAX_LINES) group.lines.add(site.evidence.line);
    group.forms.add(site.form);
    if (site.event) group.events.add(site.event);
  }
  count(owner: string, outcome: 'resolved' | 'external' | 'unresolved', name?: string): void {
    const entry = this.coverage.get(owner) ?? { resolved: 0, external: 0, unresolved: 0 };
    entry[outcome]++;
    if (outcome === 'unresolved' && name) {
      const names = entry.unresolvedNames ??= {};
      if (names[name] !== undefined || Object.keys(names).length < MAX_UNRESOLVED_NAMES) names[name] = (names[name] ?? 0) + 1;
    }
    this.coverage.set(owner, entry);
  }
  effect(owner: string, fact: EffectFact): EffectFact {
    const list = this.effects.get(owner) ?? [];
    if (list.length < MAX_EFFECTS) list.push(fact);
    this.effects.set(owner, list);
    return fact;
  }
  /** Write relations and per-entity metadata (`callSites`, `effects`). */
  flush(graph: GraphBuilder): void {
    for (const key of [...this.groups.keys()].sort()) {
      const group = this.groups.get(key)!;
      if (!graph.entities.has(group.from) || !graph.entities.has(group.to)) continue;
      graph.relate(group.from, group.to, group.type, group.evidence, { sites: group.sites, lines: [...group.lines].sort((a, b) => a - b), forms: [...group.forms].sort(), ...(group.events.size ? { events: [...group.events].sort() } : {}) });
    }
    for (const [id, entry] of this.coverage) {
      const entity = graph.entities.get(id);
      if (entity) entity.metadata.callSites = entry.unresolvedNames ? { ...entry, unresolvedNames: Object.fromEntries(Object.entries(entry.unresolvedNames).sort(([a], [b]) => a < b ? -1 : 1)) } : entry;
    }
    for (const [id, list] of this.effects) {
      const entity = graph.entities.get(id);
      if (entity) entity.metadata.effects = list.sort((a, b) => a.line - b.line || (a.category < b.category ? -1 : a.category > b.category ? 1 : 0));
    }
    this.groups.clear(); this.coverage.clear(); this.effects.clear();
  }
}
