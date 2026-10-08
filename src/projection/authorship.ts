// Authorship of a view: who changed its files, from the Git history folded
// onto the commit the view shows (history/authors.ts). Pure and deterministic.
//
// A window keeps the commits of the last year, 90 or 30 days up to that commit
// (by author date), all of them, or, in a comparison, those the baseline did not
// have yet. A commit counts for its author and every co-author. The person who
// changed a file most is the one with the most lines added plus deleted in the
// commits they authored there (then in all their commits, then most commits).
// Files only exist in the map under their current path: changes to files that
// are gone count for people's totals, not for any place on the map.
import type { AuthorHistory, FoldedCommit, FoldedHistory } from '../history/authors.js';
import type { ProjectionIndex, ProjectionNode } from './hierarchy.js';
import { CONSOLE_TYPES, INTERFACE_TYPES, SYMBOL_TYPES } from './hierarchy.js';
import type { AuthorshipCommit, AuthorshipResult, AuthorshipWindow, AuthorshipWindowKey, EntityAuthorship, EntityPerson, PersonAuthorship, PersonSummary } from './dto.js';

const DAYS: Record<string, number | undefined> = { all: undefined, '365d': 365, '90d': 90, '30d': 30 };
export const AUTHORSHIP_WINDOWS: AuthorshipWindowKey[] = ['all', '365d', '90d', '30d', 'range'];
export function isAuthorshipWindow(value: unknown): value is AuthorshipWindowKey { return typeof value === 'string' && (AUTHORSHIP_WINDOWS as string[]).includes(value); }
/** Entry points shown outside files (districts): they take the people of the file defining them. */
const ENTRY_TYPES = new Set([...INTERFACE_TYPES, ...CONSOLE_TYPES]);
const RECENT = 15, PERSON_COMMITS = 60, FOLDERS = 40;
const DAY_MS = 86_400_000;

interface FileShare { commits: number; lines: number; authored: number; last: string }
interface PersonTotals { commits: number; coauthored: number; lines: number; files: Set<string>; first: string; last: string }
export interface AuthorshipComputation {
  window: AuthorshipWindow; truncated: boolean;
  history: AuthorHistory;
  /** Commits of the window, newest first. */
  commits: FoldedCommit[];
  /** Present file node → person index → what they changed there. */
  files: Map<string, Map<number, FileShare>>;
  /** Present file node → the person who changed it most. */
  main: Map<string, number>;
  /** Most commits first. */
  people: PersonSummary[];
  /** Person key → person index. */
  byKey: Map<string, number>;
  /** File path (as in the history, at the anchor) → present file node. */
  fileOf: (path: string) => string | undefined;
}
/** The files of a view that exist (comparison ghosts excluded). */
function presentFiles(index: ProjectionIndex): ProjectionNode[] {
  return [...index.nodes.values()].filter(node => node.kind === 'entity' && node.type === 'file' && !!node.path && node.change?.status !== 'removed');
}
const newer = (a: string, b: string) => Date.parse(a) > Date.parse(b);

export function computeAuthorship(history: AuthorHistory, folded: FoldedHistory, index: ProjectionIndex, options: { window: AuthorshipWindowKey; baseline?: string }): AuthorshipComputation {
  const until = folded.until;
  const days = DAYS[options.window];
  let commits = folded.commits;
  let since: string | undefined;
  if (options.window === 'range') {
    if (!options.baseline) throw new Error('The range window needs a comparison');
    const before = history.has(options.baseline) ? history.reachable(options.baseline) : new Set<string>();
    commits = commits.filter(commit => !before.has(commit.sha));
  } else if (days !== undefined) {
    since = new Date(Date.parse(until) - days * DAY_MS).toISOString();
    const start = Date.parse(since);
    commits = commits.filter(commit => Date.parse(commit.authoredAt) >= start);
  }
  const byPath = new Map(presentFiles(index).map(node => [node.path!, node.id]));
  const fileOf = (path: string) => byPath.get(path);
  const files = new Map<string, Map<number, FileShare>>();
  const totals = new Map<number, PersonTotals>();
  for (const commit of commits) {
    const lines = commit.changes.reduce((sum, change) => sum + change.added + change.deleted, 0);
    commit.people.forEach((person, position) => {
      let total = totals.get(person);
      if (!total) { total = { commits: 0, coauthored: 0, lines: 0, files: new Set(), first: commit.authoredAt, last: commit.authoredAt }; totals.set(person, total); }
      total.commits++; total.lines += lines;
      if (position > 0) total.coauthored++;
      if (newer(total.first, commit.authoredAt)) total.first = commit.authoredAt;
      if (newer(commit.authoredAt, total.last)) total.last = commit.authoredAt;
    });
    for (const change of commit.changes) {
      const id = fileOf(change.path);
      if (!id) continue;
      let shares = files.get(id);
      if (!shares) { shares = new Map(); files.set(id, shares); }
      commit.people.forEach((person, position) => {
        let share = shares!.get(person);
        if (!share) { share = { commits: 0, lines: 0, authored: 0, last: commit.authoredAt }; shares!.set(person, share); }
        share.commits++; share.lines += change.added + change.deleted;
        if (position === 0) share.authored += change.added + change.deleted;
        if (newer(commit.authoredAt, share.last)) share.last = commit.authoredAt;
        totals.get(person)!.files.add(id);
      });
    }
  }
  const main = new Map<string, number>();
  for (const [id, shares] of files) {
    const ranked = [...shares].sort(([a, x], [b, y]) => y.authored - x.authored || y.lines - x.lines || y.commits - x.commits || Date.parse(y.last) - Date.parse(x.last) || compare(history.people[a]!.key, history.people[b]!.key));
    main.set(id, ranked[0]![0]);
  }
  const people = [...totals].map(([person, total]): PersonSummary => {
    const known = history.people[person]!;
    return { key: known.key, name: known.name, emails: known.emails, kind: known.kind, order: known.order, commits: total.commits, coauthored: total.coauthored, lines: total.lines, files: total.files.size, first: total.first, last: total.last };
  }).sort((a, b) => b.commits - a.commits || b.lines - a.lines || compare(a.name, b.name) || compare(a.key, b.key));
  const byKey = new Map(history.people.map((person, position) => [person.key, position]));
  const window: AuthorshipWindow = { key: options.window, anchor: folded.anchor, until, ...(since ? { since } : {}), ...(options.window === 'range' ? { baseline: options.baseline! } : {}), commits: commits.length };
  return { window, truncated: history.log.truncated, history, commits, files, main, people, byKey, fileOf };
}
function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }

/** The file defining an entry point (by its path), if it is in the view. */
function definingFile(index: ProjectionIndex, node: ProjectionNode): string | undefined {
  if (!node.path) return undefined;
  const id = index.fileByPath.get(node.path);
  return id && index.node(id)?.change?.status !== 'removed' ? id : undefined;
}

/** Every person's place on the map: the main person of each file, and the files of each area by main person. */
export function authorshipResult(computed: AuthorshipComputation, index: ProjectionIndex, dirty: boolean): AuthorshipResult {
  const keyOf = (person: number) => computed.history.people[person]!.key;
  const of: Record<string, string> = {}, areas: Record<string, Record<string, number>> = {};
  let unchanged = 0;
  for (const node of presentFiles(index)) {
    const person = computed.main.get(node.id);
    const key = person === undefined ? 'none' : keyOf(person);
    if (person === undefined) unchanged++; else of[node.id] = key;
    for (const ancestor of index.spatialAncestors(node)) { const counts = areas[ancestor.id] ??= {}; counts[key] = (counts[key] ?? 0) + 1; }
  }
  for (const node of index.nodes.values()) {
    if (node.kind !== 'entity' || !ENTRY_TYPES.has(node.type) || node.change?.status === 'removed') continue;
    const file = definingFile(index, node);
    if (file && of[file]) of[node.id] = of[file]!;
  }
  return { available: true, window: computed.window, truncated: computed.truncated, dirty, people: computed.people, of, areas, unchanged };
}

/** What one person changed in the view: their files, the areas and folders holding them, and their commits. */
export function personAuthorship(computed: AuthorshipComputation, index: ProjectionIndex, key: string, snapshotOf: (sha: string) => string | undefined): PersonAuthorship | undefined {
  const person = computed.byKey.get(key);
  const summary = computed.people.find(item => item.key === key);
  if (person === undefined || !summary) return undefined;
  const files: Record<string, { commits: number; lines: number }> = {}, areas: Record<string, number> = {};
  const folders = new Map<string, { files: number; lines: number }>();
  for (const [id, shares] of computed.files) {
    const share = shares.get(person);
    if (!share) continue;
    files[id] = { commits: share.commits, lines: share.lines };
    const node = index.node(id)!;
    for (const ancestor of index.spatialAncestors(node)) areas[ancestor.id] = (areas[ancestor.id] ?? 0) + 1;
    if (node.canonicalParentId) { const folder = folders.get(node.canonicalParentId) ?? { files: 0, lines: 0 }; folder.files++; folder.lines += share.lines; folders.set(node.canonicalParentId, folder); }
  }
  const entries: string[] = [];
  for (const node of index.nodes.values()) {
    if (node.kind !== 'entity' || !ENTRY_TYPES.has(node.type) || node.change?.status === 'removed') continue;
    const file = definingFile(index, node);
    if (file && files[file]) entries.push(node.id);
  }
  const theirs = computed.commits.filter(commit => commit.people.includes(person));
  const present = new Set(Object.keys(files));
  return {
    person: summary, window: computed.window, files, entries, areas,
    folders: [...folders].map(([id, folder]) => ({ id, path: index.node(id)?.path ?? index.node(id)?.name ?? id, ...folder })).sort((a, b) => b.files - a.files || b.lines - a.lines || compare(a.path, b.path)).slice(0, FOLDERS),
    commits: theirs.slice(0, PERSON_COMMITS).map(commit => commitRow(computed, commit, id => present.has(id), snapshotOf)),
    shas: theirs.map(commit => commit.sha.slice(0, 12)),
  };
}

/** Which files a selection stands for: itself (a file), the file holding or defining it, or every file inside an area. */
function coveredFiles(index: ProjectionIndex, node: ProjectionNode): { scope: EntityAuthorship['scope']; files: ProjectionNode[]; file?: ProjectionNode } {
  const present = (id: string | undefined) => { const found = id ? index.node(id) : undefined; return found && found.change?.status !== 'removed' ? found : undefined; };
  if (node.kind === 'entity' && node.type === 'file') return { scope: 'file', files: node.change?.status === 'removed' ? [] : [node], file: node };
  if (node.kind === 'entity' && ['repository', 'application', 'directory'].includes(node.type)) return { scope: 'area', files: presentFiles(index).filter(file => index.contains(node, file)) };
  if (node.kind === 'group') {
    // A district (routes, tables, console): the files defining what it holds.
    const ids = new Set<string>();
    for (const inside of index.nodes.values()) if (inside !== node && inside.kind === 'entity' && index.contains(node, inside)) { const file = definingFile(index, inside); if (file) ids.add(file); }
    return { scope: 'area', files: [...ids].map(id => index.node(id)!) };
  }
  const holder = SYMBOL_TYPES.has(node.type) ? index.canonicalAncestors(node).reverse().find(item => item.type === 'file') : undefined;
  const file = holder ?? present(definingFile(index, node));
  return file ? { scope: 'symbol', files: [file], file } : { scope: 'symbol', files: [] };
}

/** Who changed what a selection stands for, and its latest commits. */
export function entityAuthorship(computed: AuthorshipComputation, index: ProjectionIndex, node: ProjectionNode, snapshotOf: (sha: string) => string | undefined): EntityAuthorship {
  const covered = coveredFiles(index, node);
  const ids = new Set(covered.files.map(file => file.id));
  const inside = (id: string) => ids.has(id);
  const people = new Map<number, Omit<EntityPerson, 'key' | 'name' | 'kind' | 'order' | 'share' | 'files'> & { files: Set<string> }>();
  const changed = new Set<string>();
  const recent: AuthorshipCommit[] = [];
  let commits = 0, lines = 0;
  for (const commit of computed.commits) {
    let added = 0, deleted = 0;
    const touched = new Set<string>();
    for (const change of commit.changes) {
      const id = computed.fileOf(change.path);
      if (!id || !inside(id)) continue;
      added += change.added; deleted += change.deleted; touched.add(id);
    }
    if (!touched.size) continue;
    commits++; lines += added + deleted;
    for (const id of touched) changed.add(id);
    if (recent.length < RECENT) recent.push(commitRow(computed, commit, inside, snapshotOf));
    for (const person of commit.people) {
      let entry = people.get(person);
      if (!entry) { entry = { commits: 0, lines: 0, added: 0, deleted: 0, files: new Set(), first: commit.authoredAt, last: commit.authoredAt }; people.set(person, entry); }
      entry.commits++; entry.lines += added + deleted; entry.added += added; entry.deleted += deleted;
      for (const id of touched) entry.files.add(id);
      if (newer(entry.first, commit.authoredAt)) entry.first = commit.authoredAt;
      if (newer(commit.authoredAt, entry.last)) entry.last = commit.authoredAt;
    }
  }
  const rows = [...people].map(([person, entry]): EntityPerson => {
    const known = computed.history.people[person]!;
    return { key: known.key, name: known.name, kind: known.kind, order: known.order, commits: entry.commits, lines: entry.lines, added: entry.added, deleted: entry.deleted, files: entry.files.size, share: lines ? entry.lines / lines : entry.commits / commits, first: entry.first, last: entry.last };
  }).sort((a, b) => b.lines - a.lines || b.commits - a.commits || compare(a.name, b.name));
  return {
    id: node.id, available: true, window: computed.window, scope: covered.scope,
    ...(covered.file ? { file: { id: covered.file.id, path: covered.file.path ?? covered.file.name } } : {}),
    files: covered.files.length, changedFiles: changed.size, commits, lines, people: rows, recent,
  };
}

function commitRow(computed: AuthorshipComputation, commit: FoldedCommit, inside: (id: string) => boolean, snapshotOf: (sha: string) => string | undefined): AuthorshipCommit {
  let files = 0, added = 0, deleted = 0;
  for (const change of commit.changes) {
    const id = computed.fileOf(change.path);
    if (!id || !inside(id)) continue;
    files++; added += change.added; deleted += change.deleted;
  }
  const snapshot = snapshotOf(commit.sha);
  return { sha: commit.sha, subject: commit.subject, authoredAt: commit.authoredAt, people: commit.people.map(person => computed.history.people[person]!.key), files, added, deleted, ...(snapshot ? { snapshot } : {}) };
}
