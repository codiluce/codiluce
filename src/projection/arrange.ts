// Arrangements of the map that need no language model. Pure and deterministic.
//
// Data families: the tables the migrations declare, grouped by their foreign
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
//
// Folder groups: the files of a large folder can be drawn in groups, by the
// first word of their names (ImportSongs, ImportWords → "Import…") or by data
// family, whichever puts more of them in groups of a readable number (a fixed
// score), or as the user chose for that folder.
import { fileResolver } from './catalog.js';
import type { ProjectionIndex, ProjectionNode, SpatialGroup } from './hierarchy.js';

/** A table with links to at least this many other tables is a hub. */
export const HUB_DEGREE = 6;
/** Folders with at least this many files are grouped automatically; overrides need at least `ARRANGE_MIN`. */
export const ARRANGE_THRESHOLD = 16;
export const ARRANGE_MIN = 6;
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
const CODE_LANGUAGES = new Set(['typescript', 'javascript', 'php', 'vue', 'svelte']);

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

// Folder groups ---------------------------------------------------------------------
export type ArrangeKey = 'name' | 'data';
export type ArrangeChoice = ArrangeKey | 'none';
/** How the user arranges folders: `auto` groups every large folder as it fits best; per folder, a choice overrides it. */
export interface ArrangeSpec { mode: 'auto' | 'off'; folders: Record<string, ArrangeChoice | 'auto'> }
const FOLDER_ID = /^[\w:.-]{1,200}$/;
const CHOICES = new Set(['auto', 'name', 'data', 'none']);
/** `auto` or `off`, then `;<folder id>=<choice>` per folder (the query parameter `arrange`). */
export function parseArrange(text: string): ArrangeSpec {
  if (text.length > 8000) throw new Error('arrange is too long');
  const [mode, ...items] = text.split(';');
  if (mode !== 'auto' && mode !== 'off') throw new Error('arrange must start with auto or off');
  const folders: ArrangeSpec['folders'] = {};
  for (const item of items) {
    const at = item.lastIndexOf('=');
    const id = item.slice(0, at), choice = item.slice(at + 1);
    if (at < 1 || !FOLDER_ID.test(id) || !CHOICES.has(choice)) throw new Error(`Invalid arrange item ${item.slice(0, 60)}`);
    folders[id] = choice as ArrangeChoice | 'auto';
  }
  return { mode, folders };
}
/** The canonical text of a spec (choices equal to the mode's default dropped, folders sorted); undefined when nothing is grouped. */
export function arrangeText(spec: ArrangeSpec): string | undefined {
  const items = Object.entries(spec.folders).filter(([, choice]) => choice !== (spec.mode === 'auto' ? 'auto' : 'none')).sort((a, b) => compare(a[0], b[0]));
  if (spec.mode === 'off' && !items.length) return undefined;
  return [spec.mode, ...items.map(([id, choice]) => `${id}=${choice}`)].join(';');
}
export interface ArrangeOption {
  key: ArrangeKey;
  /** Groups of at least two files, largest first. */
  groups: { value: string; name: string; files: string[] }[];
  /** Files in those groups. */
  grouped: number;
  /** Higher is better; `fits` says whether Auto may choose it. */
  score: number; fits: boolean;
}
export interface FolderPlan { id: string; files: number; auto: ArrangeChoice; options: ArrangeOption[] }
/**
 * The ways a folder's files can be grouped. Auto takes the option that puts
 * the most files in groups (data families slightly preferred, as they connect
 * to the rest of the map), when at least half of the files are grouped, in two
 * groups or more, none holding more than 60% of the files.
 */
export function planFolder(index: ProjectionIndex, families: FamilyAssignment, folder: ProjectionNode): FolderPlan | undefined {
  const files = folder.children.map(id => index.node(id)!).filter(node => node.kind === 'entity' && node.type === 'file' && node.change?.status !== 'removed');
  if (files.length < ARRANGE_MIN) return undefined;
  const names = new Map(families.families.map(family => [family.key, family.name]));
  const option = (key: ArrangeKey, valueOf: (file: ProjectionNode) => { value: string; name: string } | undefined): ArrangeOption => {
    const byValue = new Map<string, { value: string; name: string; files: string[] }>();
    for (const file of files) {
      const found = valueOf(file);
      if (!found) continue;
      const entry = byValue.get(found.value) ?? { ...found, files: [] };
      entry.files.push(file.id); byValue.set(found.value, entry);
    }
    const groups = [...byValue.values()].filter(group => group.files.length >= 2).sort((a, b) => b.files.length - a.files.length || compare(a.name.toLowerCase(), b.name.toLowerCase()));
    const grouped = groups.reduce((sum, group) => sum + group.files.length, 0);
    const largest = groups[0]?.files.length ?? 0;
    const share = grouped / files.length;
    const fits = share >= 0.5 && groups.length >= 2 && largest <= files.length * 0.6 && groups.length <= Math.max(4, Math.ceil(files.length / 3));
    // Many small groups read less well than a few (past 8 groups, each costs a little), and one group holding most files says little.
    const score = share - 0.02 * Math.max(0, groups.length - 8) - Math.max(0, largest / files.length - 0.35) + (key === 'data' ? 0.05 : 0);
    return { key, groups, grouped, score: Math.round(score * 1000) / 1000, fits };
  };
  // A plural meets its singular when both start names here (Song, Songs).
  const tokens = new Map(files.map(file => [file.id, nameToken(file.name)]));
  const words = new Set([...tokens.values()].flatMap(token => token ? [token.value] : []));
  const singular = (word: string) => word.length > 3 && word.endsWith('s') && words.has(word.slice(0, -1)) ? word.slice(0, -1) : word;
  const byName = option('name', file => { const token = tokens.get(file.id); return token ? { value: singular(token.value), name: `${token.value === singular(token.value) ? token.label : token.label.slice(0, -1)}…` } : undefined; });
  const byData = option('data', file => { const key = families.of.get(file.id); return key ? { value: key, name: names.get(key) ?? key } : undefined; });
  const options = [byName, byData];
  const fitting = options.filter(item => item.fits).sort((a, b) => b.score - a.score);
  return { id: folder.id, files: files.length, auto: files.length >= ARRANGE_THRESHOLD && fitting[0] ? fitting[0].key : 'none', options };
}
/** The groups a folder is drawn with for a choice (none when the choice groups nothing). */
export function folderGroups(index: ProjectionIndex, families: FamilyAssignment, plan: FolderPlan, key: ArrangeKey): SpatialGroup[] {
  const option = plan.options.find(item => item.key === key)!;
  const folder = index.node(plan.id)!;
  const where = folder.path ?? folder.name;
  const tables = new Map(families.families.map(family => [family.key, family.tables]));
  return option.groups.map(group => ({
    id: `projection:arrange:${plan.id}:${key}:${group.value}`, name: group.name,
    explanation: key === 'name'
      ? `Projection grouping: the files of ${where} whose names start with "${group.name.replace(/…$/, '')}". Their folder is unchanged.`
      : `Projection grouping: the files of ${where} that use the ${group.name} data family (${tables.get(group.value)?.slice(0, 6).join(', ') ?? group.value}${(tables.get(group.value)?.length ?? 0) > 6 ? '…' : ''}), directly or through the code they use. Their folder is unchanged.`,
    members: group.files,
  }));
}
/**
 * The first word of a file name: `ImportSongs.php` → import, `use-auth.ts` →
 * use, `create_users_table` → create. Numbers (dates) are skipped. The label
 * keeps the case.
 */
export function nameToken(fileName: string): { value: string; label: string } | undefined {
  const base = fileName.replace(/\.[^.]+$/, '').replace(/\.(test|spec|stories|module|d)$/i, '');
  const words = base.split(/[^A-Za-z0-9]+/).flatMap(part => part.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[0-9]+/g) ?? []).filter(word => !/^\d+$/.test(word));
  const first = words[0];
  if (!first || first.length < 2) return undefined;
  return { value: first.toLowerCase(), label: first };
}
