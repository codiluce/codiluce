// Domains from the model's rules, applied to the index deterministically.
//
// The model names the domains and gives each the paths it includes; every file
// takes the domain of the longest path that matches it. A file no path matches
// takes the domain most of its connected files have (imports, calls, renders,
// requests, table access; a widely used file, such as the user model, counts
// less than a specific one) when they clearly agree, over a few rounds, and is
// marked inferred; what is
// left goes to `platform` (shared code). A `platform` path is a weak rule:
// models tend to file whole shared folders there (services, models), so a file
// it matches moves to the product domain that most of its connections clearly
// belong to. Entities that are not in a file follow
// their code: an endpoint its handler, a page its component, a command its
// class, a scheduled task its command, a table the code reading or writing it.
import type { ProjectionIndex } from '../projection/hierarchy.js';

export interface DomainRule { key: string; name: string; summary: string; include: string[] }
export interface DomainAssignment {
  domains: { key: string; name: string; summary: string; files: number; color: number }[];
  /** Entity ID → domain key (files, and the entities placed by their code). */
  of: Map<string, string>;
  inferred: Set<string>;
}
const VOTING = new Set(['imports', 'exports', 'calls', 'renders', 'references', 'requests', 'handles', 'routes_to', 'invokes', 'reads', 'writes', 'extends', 'implements']);
const CODE = new Set(['typescript', 'javascript', 'php', 'vue', 'svelte']);
export const PLATFORM = 'platform';
/** A platform file moves to a product domain holding at least this share of its votes (and two of them). */
const CLEAR_MAJORITY = 0.6;

export function assignDomains(index: ProjectionIndex, rules: DomainRule[]): DomainAssignment {
  const domains = rules.map(rule => ({ ...rule, include: rule.include.map(item => item.replace(/^\.?\/+/, '').replace(/\/+$/, '')) }));
  if (!domains.some(rule => rule.key === PLATFORM)) domains.push({ key: PLATFORM, name: 'Platform', summary: 'Code that serves every part of the product: shared parts, setup and configuration.', include: [] });
  const rulesByPath = domains.flatMap(rule => rule.include.map(prefix => ({ prefix, key: rule.key }))).sort((a, b) => b.prefix.length - a.prefix.length);
  const matchPath = (path: string) => rulesByPath.find(rule => path === rule.prefix || path.startsWith(`${rule.prefix}/`))?.key;
  const fileOf = new Map<string, string>();
  const files: string[] = [];
  for (const node of index.nodes.values()) {
    if (node.kind !== 'entity') continue;
    if (node.type === 'file') { files.push(node.id); fileOf.set(node.id, node.id); continue; }
    for (let parent = node.canonicalParentId ? index.node(node.canonicalParentId) : undefined; parent; parent = parent.canonicalParentId ? index.node(parent.canonicalParentId) : undefined) if (parent.type === 'file') { fileOf.set(node.id, parent.id); break; }
  }
  const of = new Map<string, string>(), inferred = new Set<string>();
  for (const id of files) { const key = matchPath(index.node(id)!.path ?? ''); if (key) of.set(id, key); }
  // Neighbours between files, from relations of the files and their symbols.
  const neighbours = new Map<string, string[]>();
  for (const relation of index.relations) {
    if (!VOTING.has(relation.type) || relation.change === 'removed') continue;
    const a = fileOf.get(relation.from) ?? index.fileByPath.get(index.node(relation.from)?.path ?? ''), b = fileOf.get(relation.to) ?? index.fileByPath.get(index.node(relation.to)?.path ?? '');
    if (!a || !b || a === b) continue;
    neighbours.set(a, [...neighbours.get(a) ?? [], b]); neighbours.set(b, [...neighbours.get(b) ?? [], a]);
  }
  // A neighbour's vote weighs less the more files it is connected to: hubs say little about a file.
  const weight = (id: string) => 1 / Math.log2(2 + (neighbours.get(id)?.length ?? 0));
  for (let round = 0; round < 4; round++) {
    let changed = false;
    for (const id of files) {
      if (of.has(id)) continue;
      const votes = new Map<string, number>();
      let total = 0;
      for (const other of neighbours.get(id) ?? []) { const key = of.get(other); if (!key) continue; total += weight(other); if (key !== PLATFORM) votes.set(key, (votes.get(key) ?? 0) + weight(other)); }
      // Only a clear majority decides; a file connected to many domains is shared code.
      const best = [...votes].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
      if (best && best[1] / total >= CLEAR_MAJORITY) { of.set(id, best[0]); inferred.add(id); changed = true; }
    }
    if (!changed) break;
  }
  for (const id of files) if (!of.has(id)) { of.set(id, PLATFORM); inferred.add(id); }
  // Weak platform matches: a file that mostly serves one product domain belongs to it
  // (a few rounds, so a controller can follow the services that moved before it).
  for (let round = 0; round < 3; round++) {
    const moves = new Map<string, string>();
    for (const id of files) {
      if (of.get(id) !== PLATFORM) continue;
      const votes = new Map<string, { weight: number; count: number }>();
      let total = 0;
      for (const other of neighbours.get(id) ?? []) {
        const key = of.get(other);
        if (!key) continue;
        total += weight(other);
        if (key !== PLATFORM) { const vote = votes.get(key) ?? { weight: 0, count: 0 }; vote.weight += weight(other); vote.count++; votes.set(key, vote); }
      }
      const best = [...votes].sort((a, b) => b[1].weight - a[1].weight || (a[0] < b[0] ? -1 : 1))[0];
      if (best && best[1].count >= 2 && best[1].weight / total >= CLEAR_MAJORITY) moves.set(id, best[0]);
    }
    if (!moves.size) break;
    for (const [id, key] of moves) { of.set(id, key); inferred.add(id); }
  }
  // Symbols take their file's domain; entities outside files follow their code.
  for (const [id, file] of fileOf) if (id !== file) of.set(id, of.get(file)!);
  const follow = (id: string, types: string[], direction: 'out' | 'in'): string | undefined => {
    const votes = new Map<string, number>();
    for (const i of index.adjacency.get(id) ?? []) {
      const relation = index.relations[i]!;
      if (!types.includes(relation.type) || relation.change === 'removed') continue;
      const other = direction === 'out' ? (relation.from === id ? relation.to : undefined) : (relation.to === id ? relation.from : undefined);
      const key = other ? of.get(other) : undefined;
      if (key) votes.set(key, (votes.get(key) ?? 0) + 1);
    }
    return [...votes].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0];
  };
  const byPath = (id: string) => { const path = index.node(id)?.path; const file = path ? index.fileByPath.get(path) : undefined; return file ? of.get(file) : undefined; };
  for (const node of index.nodes.values()) {
    if (node.kind !== 'entity' || of.has(node.id)) continue;
    let key: string | undefined;
    if (node.type === 'api_endpoint') key = follow(node.id, ['handles', 'renders'], 'out') ?? byPath(node.id);
    else if (node.type === 'route') key = follow(node.id, ['routes_to'], 'out') ?? byPath(node.id);
    else if (node.type === 'command') key = follow(node.id, ['handles'], 'out') ?? byPath(node.id);
    else if (node.type === 'database_table') key = follow(node.id, ['reads', 'writes', 'maps_to'], 'in') ?? byPath(node.id);
    if (key) of.set(node.id, key);
  }
  for (const node of index.nodes.values()) if (node.type === 'scheduled_task' && !of.has(node.id)) { const key = follow(node.id, ['invokes'], 'out') ?? byPath(node.id); if (key) of.set(node.id, key); }
  // Domain sizes count code files (styles, images and data files are placed, not counted).
  const counts = new Map<string, number>();
  for (const id of files) if (CODE.has(index.node(id)!.language ?? '')) counts.set(of.get(id)!, (counts.get(of.get(id)!) ?? 0) + 1);
  return { domains: domains.map((rule, color) => ({ key: rule.key, name: rule.name, summary: rule.summary, files: counts.get(rule.key) ?? 0, color })), of, inferred };
}
