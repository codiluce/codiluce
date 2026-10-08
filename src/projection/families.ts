// Data families, without a language model. Pure and deterministic.
//
// The tables the migrations declare, grouped by their foreign
// keys, with the code that uses them. A table that many tables reference (the
// users table, a shared dictionary) is a hub: it has a family of its own and
// never joins the families that reference it to each other. A table named
// after another one (song_artists → songs) joins it; a table named after a hub
// joins the hub only when nothing else connects it. A file takes the family of
// the tables its own code maps (a model), declares (a migration), writes or
// reads. A file that touches no table takes the family of the code it uses when
// most of that code is in one family (a command follows the service it runs, a
// page the endpoints it requests), or the family of the code using it when all
// of that code is in one (a style sheet follows its component); shared code
// stays apart. Entities outside files follow their code: an endpoint its
// handler, a command its class.
import { fileResolver } from './catalog.js';
import { CODE_LANGUAGES } from '../core/languages.js';
import type { ProjectionIndex, ProjectionNode } from './hierarchy.js';

/** A table with links to at least this many other tables is a hub. */
export const HUB_DEGREE = 6;
/** The family of code that reaches no table. */
export const NO_FAMILY = 'none';
export interface DataFamily {
  key: string; name: string;
  /** Table names, the family's main table first. */
  tables: string[];
  /** Referenced by many tables: it does not join their families. */
  hub: boolean;
  /** Files placed in the family (those placed through connected code included). */
  files: number;
}
export interface FamilyAssignment {
  /** Most files first. */
  families: DataFamily[];
  /** Entity → family key: tables, files, and routes, endpoints, commands and scheduled tasks. */
  of: Map<string, string>;
  /** Files placed through the code they are connected to (no table access of their own). */
  inferred: Set<string>;
}
/** How much one access ties a file to a table's family. */
const ACCESS: Record<string, number> = { maps_to: 4, writes: 2, reads: 1 };
const DECLARES = 4;
/** Relationships between code that let a file without tables follow its neighbours. */
const LINKS = new Set(['imports', 'calls', 'renders', 'references', 'requests', 'handles', 'routes_to', 'invokes', 'extends', 'implements']);
const ENTRY_TYPES = new Set(['api_endpoint', 'route', 'command', 'scheduled_task']);
/** What an entry point runs: an endpoint's handler, a page's component, a command's class, a task's command. */
const RUNS = new Set(['handles', 'renders', 'routes_to', 'invokes']);
/** A file joins a family holding at least this share of the code it uses. */
const CLEAR_MAJORITY = 0.6;

export function dataFamilies(index: ProjectionIndex): FamilyAssignment {
  const present = (node: ProjectionNode | undefined): node is ProjectionNode => !!node && node.kind === 'entity' && node.change?.status !== 'removed';
  const relations = index.relations.filter(relation => relation.change !== 'removed');
  const tables = [...index.nodes.values()].filter(node => present(node) && node.type === 'database_table').sort((a, b) => compare(a.name, b.name) || compare(a.id, b.id));
  const tableIds = new Set(tables.map(table => table.id));
  // Foreign keys, both ways, between distinct tables.
  const links = new Map<string, Set<string>>(tables.map(table => [table.id, new Set()]));
  for (const relation of relations) {
    if (relation.type !== 'foreign_key' || relation.from === relation.to || !tableIds.has(relation.from) || !tableIds.has(relation.to)) continue;
    links.get(relation.from)!.add(relation.to); links.get(relation.to)!.add(relation.from);
  }
  const hubs = new Set(tables.filter(table => links.get(table.id)!.size >= HUB_DEGREE).map(table => table.id));
  const parent = new Map(tables.map(table => [table.id, table.id]));
  const find = (id: string): string => { let root = id; while (parent.get(root) !== root) root = parent.get(root)!; parent.set(id, root); return root; };
  const union = (a: string, b: string) => { const x = find(a), y = find(b); if (x !== y) parent.set(x < y ? y : x, x < y ? x : y); };
  for (const table of tables) if (!hubs.has(table.id)) for (const other of links.get(table.id)!) if (!hubs.has(other)) union(table.id, other);
  // Tables named after another table: song_artists → songs (the longest matching prefix).
  const byName = new Map(tables.map(table => [table.name.toLowerCase(), table]));
  const namedAfter = (table: ProjectionNode): ProjectionNode | undefined => {
    const parts = table.name.toLowerCase().split('_');
    for (let n = parts.length - 1; n >= 1; n--) {
      const prefix = parts.slice(0, n).join('_');
      for (const name of [prefix, `${prefix}s`, `${prefix}es`, prefix.replace(/y$/, 'ies')]) { const found = byName.get(name); if (found && found !== table) return found; }
    }
    return undefined;
  };
  const toHub: [string, string][] = [];
  for (const table of tables) {
    if (hubs.has(table.id)) continue;
    const target = namedAfter(table);
    if (target && !hubs.has(target.id)) union(table.id, target.id);
    else if (target) toHub.push([table.id, target.id]);
  }
  // Tables sharing a first word that names no table (crm_contacts, crm_tags).
  const byWord = new Map<string, string[]>();
  for (const table of tables) {
    const parts = table.name.toLowerCase().split('_');
    if (hubs.has(table.id) || parts.length < 2 || parts[0]!.length < 3 || namedAfter(table)) continue;
    byWord.set(parts[0]!, [...byWord.get(parts[0]!) ?? [], table.id]);
  }
  for (const ids of byWord.values()) for (const id of ids.slice(1)) union(ids[0]!, id);
  // A table named after a hub joins it only when nothing else connects it (it cannot join two families through the hub).
  const sizes = new Map<string, number>();
  for (const table of tables) sizes.set(find(table.id), (sizes.get(find(table.id)) ?? 0) + 1);
  for (const [id, hub] of toHub) if (sizes.get(find(id)) === 1) union(id, hub);
  // Families: their tables, and which table names them.
  const members = new Map<string, ProjectionNode[]>();
  for (const table of tables) members.set(find(table.id), [...members.get(find(table.id)) ?? [], table]);

  // Files: the tables their own code maps, declares, writes or reads.
  const fileOf = fileResolver(index);
  const touches = new Map<string, Map<string, number>>();
  const touch = (file: string, table: string, weight: number) => { const map = touches.get(file) ?? new Map<string, number>(); map.set(table, (map.get(table) ?? 0) + weight); touches.set(file, map); };
  for (const relation of relations) {
    const weight = ACCESS[relation.type];
    if (!weight || !tableIds.has(relation.to)) continue;
    const file = fileOf(relation.from);
    if (file) touch(file, relation.to, weight);
  }
  // Migrations declare or change tables (known for the live index; otherwise the table's own migration).
  for (const table of tables) for (const path of table.migrations ?? (table.path ? [table.path] : [])) { const file = index.fileByPath.get(path); if (file) touch(file, table.id, DECLARES); }
  // The table that names a family: a hub, else the one most tables are named after (songs for
  // song_artists), the most linked inside it, the most used, the shortest name.
  const use = new Map<string, number>();
  for (const map of touches.values()) for (const [table, weight] of map) use.set(table, (use.get(table) ?? 0) + weight);
  const namesakes = new Map<string, number>();
  for (const table of tables) { const target = namedAfter(table); if (target) namesakes.set(target.id, (namesakes.get(target.id) ?? 0) + 1); }
  const families = new Map<string, { key: string; name: string; tables: ProjectionNode[]; hub: boolean }>();
  const familyOfTable = new Map<string, string>();
  const keys = new Set<string>();
  for (const list of members.values()) {
    const inside = new Set(list.map(table => table.id));
    const degree = (table: ProjectionNode) => [...links.get(table.id)!].filter(other => inside.has(other)).length;
    const ordered = [...list].sort((a, b) => Number(hubs.has(b.id)) - Number(hubs.has(a.id)) || (namesakes.get(b.id) ?? 0) - (namesakes.get(a.id) ?? 0) || degree(b) - degree(a) || (use.get(b.id) ?? 0) - (use.get(a.id) ?? 0) || a.name.length - b.name.length || compare(a.name, b.name));
    const main = ordered[0]!;
    let key = main.name.toLowerCase();
    for (let n = 2; keys.has(key) || key === NO_FAMILY; n++) key = `${main.name.toLowerCase()}-${n}`;
    keys.add(key);
    families.set(key, { key, name: familyName(ordered.map(table => table.name)), tables: ordered, hub: list.some(table => hubs.has(table.id)) });
    for (const table of list) familyOfTable.set(table.id, key);
  }
  const of = new Map<string, string>(familyOfTable);
  // A hub family counts half: code that also uses a specific family belongs to that one.
  const hubFamily = (key: string) => families.get(key)!.hub;
  for (const [file, map] of [...touches].sort((a, b) => compare(a[0], b[0]))) {
    const scores = new Map<string, number>();
    for (const [table, weight] of map) { const key = familyOfTable.get(table)!; scores.set(key, (scores.get(key) ?? 0) + weight * (hubFamily(key) ? 0.5 : 1)); }
    of.set(file, best(scores)!);
  }

  // Files without tables follow the code they use, or the code using them.
  const uses = new Map<string, Set<string>>(), usedBy = new Map<string, Set<string>>();
  const link = (map: Map<string, Set<string>>, a: string, b: string) => { const set = map.get(a) ?? new Set<string>(); set.add(b); map.set(a, set); };
  const filesOf = (id: string, depth = 0): string[] => {
    const node = index.node(id);
    if (!present(node) || node.type === 'database_table') return [];
    if (!ENTRY_TYPES.has(node.type)) { const file = fileOf(id); return file ? [file] : []; }
    if (depth > 1) return [];
    return (index.adjacency.get(id) ?? []).flatMap(i => { const relation = index.relations[i]!; return relation.from === id && RUNS.has(relation.type) && relation.change !== 'removed' ? filesOf(relation.to, depth + 1) : []; });
  };
  for (const relation of relations) {
    if (!LINKS.has(relation.type)) continue;
    // An entry point's own links (to what it runs) are bridged: its callers meet its handler.
    if (RUNS.has(relation.type) && ENTRY_TYPES.has(index.node(relation.from)?.type ?? '')) continue;
    for (const a of filesOf(relation.from)) for (const b of filesOf(relation.to)) if (a !== b) { link(uses, a, b); link(usedBy, b, a); }
  }
  // A neighbour weighs less the more files it is connected to (widely used code says little), and half when its family is a hub's.
  const degree = (id: string) => (uses.get(id)?.size ?? 0) + (usedBy.get(id)?.size ?? 0);
  const weight = (id: string) => (of.has(id) && hubFamily(of.get(id)!) ? 0.5 : 1) / Math.log2(2 + degree(id));
  const code = (id: string) => CODE_LANGUAGES.has(index.node(id)?.language ?? '');
  const files = [...index.nodes.values()].filter(node => present(node) && node.type === 'file').map(node => node.id).sort(compare);
  const inferred = new Set<string>();
  // Rounds of two rules, applied together per round so the order of files does not matter:
  // a file whose own code clearly mostly uses one family's code joins it (a command its service,
  // a page the endpoints it requests); a file all of whose users are in one family joins it (a
  // style sheet its component, a resource class its controller). Shared code stays apart.
  for (let round = 0; round < 8; round++) {
    const moves: [string, string][] = [];
    for (const id of files) {
      if (of.has(id)) continue;
      const votes = new Map<string, number>();
      let total = 0;
      for (const other of uses.get(id) ?? []) {
        if (!code(other)) continue;
        const key = of.get(other);
        if (key) { total += weight(other); votes.set(key, (votes.get(key) ?? 0) + weight(other)); continue; }
        // Code only this file uses follows it later; other code without a family counts half against a majority.
        if ((usedBy.get(other)?.size ?? 0) > 1) total += weight(other) / 2;
      }
      const key = best(votes);
      if (key && votes.get(key)! / total >= CLEAR_MAJORITY) { moves.push([id, key]); continue; }
      const users = [...usedBy.get(id) ?? []];
      const keys = new Set(users.map(user => of.get(user)));
      if (users.length && keys.size === 1 && !keys.has(undefined)) moves.push([id, of.get(users[0]!)!]);
    }
    if (!moves.length) break;
    for (const [id, key] of moves) { of.set(id, key); inferred.add(id); }
  }
  // Entry points follow what they run (a scheduled task its command, after the commands).
  const follow = (id: string): string | undefined => {
    const votes = new Map<string, number>();
    for (const i of index.adjacency.get(id) ?? []) {
      const relation = index.relations[i]!;
      if (relation.from !== id || !RUNS.has(relation.type) || relation.change === 'removed') continue;
      const key = of.get(relation.to) ?? of.get(fileOf(relation.to) ?? '');
      if (key) votes.set(key, (votes.get(key) ?? 0) + 1);
    }
    return best(votes);
  };
  for (const pass of [['api_endpoint', 'route', 'command'], ['scheduled_task']]) {
    for (const node of index.nodes.values()) {
      if (!present(node) || !pass.includes(node.type)) continue;
      const key = follow(node.id);
      if (key) of.set(node.id, key);
    }
  }
  const counts = new Map<string, number>();
  for (const id of files) { const key = of.get(id); if (key) counts.set(key, (counts.get(key) ?? 0) + 1); }
  const list = [...families.values()].map(family => ({ key: family.key, name: family.name, tables: family.tables.map(table => table.name), hub: family.hub, files: counts.get(family.key) ?? 0 }));
  list.sort((a, b) => b.files - a.files || b.tables.length - a.tables.length || compare(a.name, b.name));
  return { families: list, of, inferred };
}
/** The key with the highest score (ties: the first key in order). */
function best(scores: Map<string, number>): string | undefined {
  let found: string | undefined, top = -Infinity;
  for (const [key, score] of [...scores].sort((a, b) => compare(a[0], b[0]))) if (score > top) { top = score; found = key; }
  return found;
}
/** A family is named by its main table (first); tables all sharing a short prefix by the prefix (crm_leads, crm_tags → CRM). */
export function familyName(tables: string[]): string {
  const words = tables.map(table => table.toLowerCase().split('_'));
  const first = words[0]![0]!;
  if (tables.length > 1 && first.length <= 3 && words.every(parts => parts.length > 1 && parts[0] === first)) return first.toUpperCase();
  return title(tables[0]!.replace(/_/g, ' '));
}
function title(text: string): string { return text.charAt(0).toUpperCase() + text.slice(1); }
function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
