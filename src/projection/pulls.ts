// Pull requests of a view: what was merged into the branch up to the commit
// the map shows (in the people window), and the work open now. Pure and
// deterministic over its inputs (history/pull-sources.ts gathers them).
//
// Merged: every commit on the first-parent line of the commit shown, with the
// commits it brought in (a merge: those of the branch it merged; any other
// commit: itself). A line commit is a pull request when the provider records
// it as one's merge commit, or when its message follows GitHub's or GitLab's
// merge or squash conventions (then labeled unverified). A merge naming no
// pull request is a merged branch, unless it only pulled a branch's remote
// copy into it ("Merge branch 'main' of github.com:…"). Its changes are those
// of its commits, under the paths the files have at the commit shown (renames
// followed), as People counts them; its people, their authors and co-authors.
//
// Open: the provider's open pull requests, and branches not merged into the
// base (a branch whose head a pull request has is that pull request). Their
// changes are the net change since they forked, placed on the map by path
// (the path before a rename first). A file they add is not on the map yet: it
// goes to the deepest folder of the map holding its path (the repository at
// worst), with the new folders below it. Closed: the provider's, unmerged.
import { resolvePeople, type AuthorHistory, type AuthorLog, type FoldedCommit } from '../history/authors.js';
import { pullRequestFromMessage, type ProviderPull, type PullFileChange, type PullFileStatus, type PullRequestRef } from '../history/pull-requests.js';
import type { BaseBranch, OpenBranch } from '../history/pull-sources.js';
import type { PullRequestRecord } from '../history/store.js';
import type { ProjectionIndex, ProjectionNode } from './hierarchy.js';
import { coveredFiles, definingFile, ENTRY_TYPES, type AuthorshipComputation } from './authorship.js';
import type { AuthorshipCommit, AuthorshipWindow, EntityPull, EntityPulls, PersonKind, PullDetail, PullFile, PullPerson, PullsResult, PullSummary } from './dto.js';

const LIST = 300, OUTSIDE = 300, COMMITS = 100, FOLDERS = 40, ENTITY_MERGED = 12;
export interface PullChange { path: string; added: number; deleted: number; status?: PullFileStatus; from?: string }
/** A pull request, a merged branch or a branch not merged: what it is, what it changes, its commits and people. */
export interface ChangeSet {
  summary: Omit<PullSummary, 'files' | 'added' | 'deleted' | 'inView' | 'commits'>;
  /** Merged: under the paths files have at the commit shown. Open and closed: at its head (`from`: before a rename). Absent while unknown. */
  changes?: PullChange[];
  /** Newest first, merges left out. */
  commits: AuthorshipCommit[];
  /** Most commits first. */
  people: PullPerson[];
  /** When it was merged, closed or last updated. */
  at: string;
  /** Why its changes are not known. */
  unknown?: string;
}
export interface PullsInputs {
  authorship: AuthorshipComputation;
  /** Merge commits of the first-parent line, with their whole message. */
  messages: Map<string, { subject: string; body: string }>;
  /** The provider's pull requests (any state), and the merged ones recorded at history indexing. */
  provider: ProviderPull[]; recorded: PullRequestRecord[];
  /** Whether the provider was asked (what its absence means). */
  providerAsked: boolean;
  branches: OpenBranch[];
  /** What provider pull requests not merged here change, when known (from Git, or fetched). */
  pullChanges: Map<number, { changes: PullFileChange[]; log?: AuthorLog }>;
  base?: BaseBranch;
  snapshotOf: (sha: string) => string | undefined;
}
export interface PullsComputation {
  window: AuthorshipWindow; truncated: boolean;
  /** Merged in the window, newest first. */
  merged: ChangeSet[];
  open: ChangeSet[]; closed: ChangeSet[];
  /** Every one, the merged outside the window too. */
  byId: Map<string, ChangeSet>;
  fileOf: (path: string) => string | undefined;
}

/** Each commit of the first-parent line from `anchor` (newest first, log indexes) with the commits it brought in. */
export function landings(history: AuthorHistory, anchor: string): { index: number; brought: number[] }[] {
  let cached = landingCache.get(history);
  if (!cached) { cached = new Map(); landingCache.set(history, cached); }
  const known = cached.get(anchor);
  if (known) return known;
  const commits = history.log.commits;
  const line: number[] = [];
  for (let at = history.bySha.get(anchor); at !== undefined;) {
    line.push(at);
    const parent = commits[at]!.parents[0];
    at = parent === undefined ? undefined : history.bySha.get(parent);
  }
  // Oldest first: what a line commit reaches through its first parent was seen with the line commits before it.
  const seen = new Set<number>();
  const result: { index: number; brought: number[] }[] = [];
  for (let position = line.length - 1; position >= 0; position--) {
    const index = line[position]!;
    const brought: number[] = [];
    const stack = commits[index]!.parents.slice(1).flatMap(sha => { const at = history.bySha.get(sha); return at === undefined ? [] : [at]; });
    while (stack.length) {
      const at = stack.pop()!;
      if (seen.has(at)) continue;
      seen.add(at); brought.push(at);
      for (const parent of commits[at]!.parents) { const next = history.bySha.get(parent); if (next !== undefined && !seen.has(next)) stack.push(next); }
    }
    seen.add(index);
    result.push({ index, brought: brought.sort((a, b) => a - b) });
  }
  result.reverse();
  cached.set(anchor, result);
  if (cached.size > 6) cached.delete(cached.keys().next().value!);
  return result;
}
const landingCache = new WeakMap<AuthorHistory, Map<string, { index: number; brought: number[] }[]>>();

/** The branch a merge commit merged, or undefined when it only pulled a branch's remote copy (or the base) into it. */
export function mergedBranch(subject: string, baseName: string | undefined): { name?: string; title: string } | undefined {
  const usual = (name: string) => name === baseName || ['main', 'master', 'develop', 'trunk'].includes(name);
  const local = /^Merge branch '([^']+)'(?: of (\S+))?/.exec(subject);
  if (local) return (local[2] && usual(local[1]!)) || local[1] === baseName ? undefined : { name: local[1]!, title: local[1]! };
  const remote = /^Merge remote-tracking branch '([^']+)'/.exec(subject);
  if (remote) { const name = remote[1]!.replace(/^[^/]+\//, ''); return usual(name) ? undefined : { name, title: name }; }
  return { title: subject || 'Merge' };
}
const GITHUB_LOGIN = /^(?:\d+\+)?([^@]+)@users\.noreply\.github\.com$/i;
const loginCache = new WeakMap<AuthorHistory, Map<string, number>>();
/** People by GitHub login (from their no-reply addresses). */
function byLogin(history: AuthorHistory): Map<string, number> {
  let map = loginCache.get(history);
  if (!map) {
    map = new Map();
    history.people.forEach((person, index) => { for (const email of person.emails) { const login = GITHUB_LOGIN.exec(email)?.[1]; if (login) map!.set(login.toLowerCase(), index); } });
    loginCache.set(history, map);
  }
  return map;
}
const identityCache = new WeakMap<AuthorHistory, Map<string, number>>();
/** People of another log (a branch's), as the history knows them when it does. */
function peopleOfLog(history: AuthorHistory, log: AuthorLog): (identity: number) => Omit<PullPerson, 'commits'> {
  let known = identityCache.get(history);
  if (!known) { known = new Map(history.log.identities.map((identity, index) => [`${identity.name}\0${identity.email}`, history.personOf[index]!])); identityCache.set(history, known); }
  let own: ReturnType<typeof resolvePeople> | undefined;
  return identity => {
    const value = log.identities[identity]!;
    const main = known!.get(`${value.name}\0${value.email}`);
    if (main !== undefined) { const person = history.people[main]!; return { key: person.key, name: person.name, kind: person.kind, order: person.order }; }
    own ??= resolvePeople(log.identities);
    const person = own.people[own.personOf[identity]!]!;
    return { key: person.key, name: person.name, kind: person.kind };
  };
}
/** People of commits, most commits first (then by first commit). */
function rankPeople(rows: Omit<PullPerson, 'commits'>[][]): PullPerson[] {
  const counts = new Map<string, PullPerson>();
  for (const row of rows) for (const person of row) { const entry = counts.get(person.key!) ?? { ...person, commits: 0 }; entry.commits++; counts.set(person.key!, entry); }
  return [...counts.values()].sort((a, b) => b.commits - a.commits || (a.order ?? Infinity) - (b.order ?? Infinity) || (a.name < b.name ? -1 : 1));
}
function providerAuthor(history: AuthorHistory, login: string, people: PullPerson[]): PullPerson {
  const index = byLogin(history).get(login.toLowerCase());
  const person = index === undefined ? undefined : history.people[index];
  if (person) return { key: person.key, name: person.name, kind: person.kind, order: person.order, login, commits: people.find(item => item.key === person.key)?.commits ?? 0 };
  const kind: PersonKind = /\[bot\]$/i.test(login) ? 'bot' : /^(copilot|claude|devin-ai-integration|cursor)/i.test(login) ? 'agent' : 'human';
  return { name: login, login, kind, commits: 0 };
}
const sum = (changes: { added: number; deleted: number }[]) => changes.reduce((total, change) => ({ added: total.added + change.added, deleted: total.deleted + change.deleted }), { added: 0, deleted: 0 });

export function computePulls(inputs: PullsInputs): PullsComputation {
  const { authorship } = inputs;
  const history = authorship.history, anchor = authorship.window.anchor;
  const commits = history.log.commits;
  const folded = history.fold(anchor);
  const foldedBySha = new Map<string, FoldedCommit>(folded?.commits.map(commit => [commit.sha, commit]) ?? []);
  const keyOf = (person: number) => history.people[person]!;
  const asPerson = (person: number): Omit<PullPerson, 'commits'> => { const known = keyOf(person); return { key: known.key, name: known.name, kind: known.kind, order: known.order }; };
  const row = (commit: FoldedCommit): AuthorshipCommit => {
    const lines = sum(commit.changes), snapshot = inputs.snapshotOf(commit.sha);
    return { sha: commit.sha, subject: commit.subject, authoredAt: commit.authoredAt, people: commit.people.map(person => keyOf(person).key), files: commit.changes.length, ...lines, ...(snapshot ? { snapshot } : {}) };
  };
  // Provider records of merged pull requests, by the commit that landed them.
  const landed = new Map<string, { ref: PullRequestRef; mergedAt?: string; createdAt?: string; baseRef?: string }>();
  for (const record of inputs.recorded) if (record.mergeCommitSha) landed.set(record.mergeCommitSha, { ref: { number: record.number, title: record.title, ...(record.url ? { url: record.url } : {}), ...(record.author ? { author: record.author } : {}), ...(record.headRef ? { headRef: record.headRef } : {}), source: 'github' }, ...(record.mergedAt ? { mergedAt: record.mergedAt } : {}) });
  for (const pull of inputs.provider) if (pull.state === 'merged' && pull.mergeCommitSha) landed.set(pull.mergeCommitSha, { ref: { number: pull.number, title: pull.title, url: pull.url, ...(pull.author ? { author: pull.author } : {}), ...(pull.headRef ? { headRef: pull.headRef } : {}), source: 'github' }, ...(pull.mergedAt ? { mergedAt: pull.mergedAt } : {}), createdAt: pull.createdAt, ...(pull.baseRef ? { baseRef: pull.baseRef } : {}) });
  const byId = new Map<string, ChangeSet>();
  const unique = (id: string, sha: string) => byId.has(id) ? `${id}-${sha.slice(0, 8)}` : id;
  const all: ChangeSet[] = [];
  for (const { index, brought } of landings(history, anchor)) {
    const commit = commits[index]!;
    const merge = commit.parents.length > 1;
    const message = inputs.messages.get(commit.sha) ?? { subject: commit.subject, body: '' };
    const provider = landed.get(commit.sha);
    const ref = provider?.ref ?? pullRequestFromMessage({ subject: message.subject, body: message.body, parents: commit.parents });
    const branch = !ref && merge ? mergedBranch(message.subject, inputs.base?.name) : undefined;
    if (!ref && !branch) continue;
    const parts = (merge ? brought : [index]).flatMap(at => { const found = foldedBySha.get(commits[at]!.sha); return found ? [found] : []; });
    const changes = new Map<string, PullChange>();
    for (const part of parts) for (const change of part.changes) {
      const entry = changes.get(change.path) ?? { path: change.path, added: 0, deleted: 0 };
      entry.added += change.added; entry.deleted += change.deleted;
      changes.set(change.path, entry);
    }
    const people = rankPeople(parts.map(part => part.people.map(asPerson)));
    const at = provider?.mergedAt ?? commit.committedAt;
    const snapshot = inputs.snapshotOf(commit.sha);
    const id = unique(ref ? `pr-${ref.number}` : `merge-${commit.sha.slice(0, 12)}`, commit.sha);
    const author = ref?.author && ref.source === 'github' ? providerAuthor(history, ref.author, people) : people[0];
    const set: ChangeSet = {
      summary: {
        id, ...(ref ? { number: ref.number } : {}), title: ref?.title || branch?.title || message.subject, state: 'merged', source: (ref?.source ?? 'merge') as PullSummary['source'],
        ...(ref?.url ? { url: ref.url } : {}), ...(author ? { author } : {}),
        ...(provider?.baseRef ?? inputs.base?.name ? { baseRef: provider?.baseRef ?? inputs.base!.name } : {}),
        ...(ref?.headRef ?? branch?.name ? { headRef: ref?.headRef ?? branch!.name } : {}),
        commit: commit.sha, mergedAt: at, ...(provider?.createdAt ? { createdAt: provider.createdAt } : {}), ...(snapshot ? { snapshot } : {}),
      },
      changes: [...changes.values()].sort((a, b) => (a.path < b.path ? -1 : 1)),
      commits: parts.map(row), people, at,
    };
    byId.set(id, set);
    all.push(set);
  }
  // The window: by when they were merged, or (comparing) those the baseline did not have.
  const window = authorship.window;
  let merged = all;
  if (window.key === 'range' && window.baseline) {
    const before = history.has(window.baseline) ? history.reachable(window.baseline) : new Set<string>();
    merged = all.filter(set => !before.has(set.summary.commit!));
  } else if (window.since) { const start = Date.parse(window.since); merged = all.filter(set => Date.parse(set.at) >= start); }

  // Open and closed: the provider's, then branches no open pull request stands for.
  const fromLog = (log: AuthorLog | undefined) => {
    if (!log) return { commits: [] as AuthorshipCommit[], people: [] as PullPerson[] };
    const personOf = peopleOfLog(history, log);
    const rows = log.commits.filter(commit => commit.parents.length <= 1);
    const people = rows.map(commit => [...new Map([commit.author, ...commit.coauthors].map(personOf).map(person => [person.key!, person])).values()]);
    return {
      commits: rows.map((commit, position): AuthorshipCommit => { const snapshot = inputs.snapshotOf(commit.sha); return { sha: commit.sha, subject: commit.subject, authoredAt: commit.authoredAt, people: people[position]!.map(person => person.key!), files: commit.changes.length, ...sum(commit.changes), ...(snapshot ? { snapshot } : {}) }; }),
      people: rankPeople(people),
    };
  };
  const open: ChangeSet[] = [], closed: ChangeSet[] = [];
  const heads = new Set<string>(), names = new Set<string>();
  for (const pull of inputs.provider) {
    if (pull.state === 'merged') continue;
    const known = inputs.pullChanges.get(pull.number);
    const { commits: rows, people } = fromLog(known?.log);
    const id = unique(`pr-${pull.number}`, pull.headSha ?? String(pull.number));
    const set: ChangeSet = {
      summary: {
        id, number: pull.number, title: pull.title, state: pull.state, source: 'github', ...(pull.draft ? { draft: true } : {}), url: pull.url,
        ...(pull.author ? { author: providerAuthor(history, pull.author, people) } : people[0] ? { author: people[0] } : {}),
        ...(pull.baseRef ? { baseRef: pull.baseRef } : {}), ...(pull.headRef ? { headRef: pull.headRef } : {}), ...(pull.headSha ? { commit: pull.headSha } : {}),
        createdAt: pull.createdAt, updatedAt: pull.updatedAt, ...(pull.closedAt ? { closedAt: pull.closedAt } : {}),
      },
      ...(known ? { changes: known.changes } : { unknown: 'Its commits are not in this repository: GitHub is asked for its files when you select it.' }),
      commits: rows, people, at: pull.state === 'closed' ? pull.closedAt ?? pull.updatedAt : pull.updatedAt,
    };
    byId.set(id, set);
    (pull.state === 'open' ? open : closed).push(set);
    if (pull.state === 'open') { if (pull.headSha) heads.add(pull.headSha); if (pull.headRef) names.add(pull.headRef); }
  }
  for (const branch of inputs.branches) {
    // A pull request from this very branch (same head, or a branch of origin by its name) stands for it.
    if (heads.has(branch.tip) || (names.has(branch.name) && branch.refs.some(ref => ref.startsWith('refs/remotes/origin/')))) continue;
    const { commits: rows, people } = fromLog(branch.log);
    const id = unique(`branch:${branch.name}`, branch.tip);
    const set: ChangeSet = {
      summary: {
        id, title: branch.name, state: 'open', source: 'branch', ...(people[0] ? { author: people[0] } : {}),
        ...(inputs.base ? { baseRef: inputs.base.name || inputs.base.ref } : {}), headRef: branch.name, commit: branch.tip,
        ...(rows.length ? { createdAt: rows.at(-1)!.authoredAt } : {}), updatedAt: branch.date,
      },
      changes: branch.changes, commits: rows, people, at: branch.date,
    };
    byId.set(id, set);
    open.push(set);
  }
  const recent = (a: ChangeSet, b: ChangeSet) => Date.parse(b.at) - Date.parse(a.at) || (a.summary.id < b.summary.id ? -1 : 1);
  open.sort(recent); closed.sort(recent);
  return { window, truncated: authorship.truncated, merged, open, closed, byId, fileOf: authorship.fileOf };
}

/** The file of this view a change is on: the path before a rename first. */
function placeOf(computed: PullsComputation, change: PullChange): string | undefined {
  return (change.from !== undefined ? computed.fileOf(change.from) : undefined) ?? computed.fileOf(change.path);
}
const folderCache = new WeakMap<ProjectionIndex, Map<string, string>>();
/** Folders of a view by path (a directory before an application at the same path). */
function foldersByPath(index: ProjectionIndex): Map<string, string> {
  let folders = folderCache.get(index);
  if (folders) return folders;
  folders = new Map();
  for (const node of index.nodes.values()) {
    if (node.kind !== 'entity' || !node.path || node.change?.status === 'removed') continue;
    if (node.type === 'directory' || (node.type === 'application' && !folders.has(node.path))) folders.set(node.path, node.id);
  }
  folderCache.set(index, folders);
  return folders;
}
/** Where a file this view does not have would be: the deepest folder holding its path (the repository at worst), and the folders below it that do not exist yet. */
export function nearestFolder(index: ProjectionIndex, path: string): { id: string; fresh: string[] } {
  const folders = foldersByPath(index), parts = path.split('/').slice(0, -1);
  for (let depth = parts.length; depth > 0; depth--) {
    const id = folders.get(parts.slice(0, depth).join('/'));
    if (id) return { id, fresh: parts.slice(depth) };
  }
  return { id: index.rootId, fresh: parts };
}
/** A file the change set adds that is not on this view's map. */
const isNew = (computed: PullsComputation, change: PullChange) => change.status === 'added' && !placeOf(computed, change);
export function pullSummary(computed: PullsComputation, set: ChangeSet): PullSummary {
  if (!set.changes) return { ...set.summary, commits: set.commits.length };
  let inView = 0, newFiles = 0;
  for (const change of set.changes) { if (placeOf(computed, change)) inView++; else if (change.status === 'added') newFiles++; }
  return { ...set.summary, files: set.changes.length, ...sum(set.changes), inView, ...(newFiles ? { newFiles } : {}), commits: set.commits.length };
}
/** Words of a query, all of which must be in the title, number, branch or author. */
function matcher(query: string | undefined): (set: ChangeSet) => boolean {
  const words = (query ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return () => true;
  return set => {
    const { summary } = set;
    const text = [summary.title, summary.number !== undefined ? `#${summary.number}` : '', summary.headRef ?? '', summary.author?.name ?? '', summary.author?.login ?? '', summary.commit?.slice(0, 12) ?? ''].join('\u0000').toLowerCase();
    return words.every(word => text.includes(word));
  };
}
export function pullsResult(computed: PullsComputation, context: { base?: BaseBranch; provider: PullsResult['provider']; branchesTruncated: boolean; branchError?: string }, options: { query?: string } = {}): PullsResult {
  const match = matcher(options.query);
  const merged = computed.merged.filter(match);
  return {
    available: true, window: computed.window, truncated: computed.truncated,
    ...(context.base ? { base: { ref: context.base.name || context.base.ref, sha: context.base.sha } } : {}),
    provider: context.provider,
    open: computed.open.filter(match).map(set => pullSummary(computed, set)),
    merged: merged.slice(0, LIST).map(set => pullSummary(computed, set)), mergedTotal: merged.length,
    closed: computed.closed.filter(match).slice(0, LIST).map(set => pullSummary(computed, set)),
    branchesTruncated: context.branchesTruncated, ...(context.branchError ? { branchError: context.branchError } : {}),
  };
}

/** What one pull request changes on the map: its files, the files it adds in the folders that will hold them, the areas and folders holding both, the rest, its commits and people. */
export function pullDetail(computed: PullsComputation, set: ChangeSet, index: ProjectionIndex): PullDetail {
  const files: PullDetail['files'] = {}, areas: Record<string, number> = {};
  const folders = new Map<string, { files: number; lines: number; newFiles: number; newFolders: Set<string> }>();
  const folder = (id: string) => { let entry = folders.get(id); if (!entry) { entry = { files: 0, lines: 0, newFiles: 0, newFolders: new Set() }; folders.set(id, entry); } return entry; };
  const outside: PullFile[] = [];
  let outsideTotal = 0;
  for (const change of set.changes ?? []) {
    const id = placeOf(computed, change);
    if (!id) {
      outsideTotal++;
      // A file it adds: counted in the folder that will hold it, and the areas around.
      const near = change.status === 'added' ? nearestFolder(index, change.path) : undefined;
      if (near) {
        const node = index.node(near.id)!;
        for (const area of [...index.spatialAncestors(node), node]) areas[area.id] = (areas[area.id] ?? 0) + 1;
        const entry = folder(near.id);
        entry.newFiles++; entry.lines += change.added + change.deleted;
        if (near.fresh.length) entry.newFolders.add(near.fresh.join('/'));
      }
      if (outside.length < OUTSIDE) outside.push({ path: change.path, added: change.added, deleted: change.deleted, ...(change.status ? { status: change.status } : {}), ...(change.from ? { from: change.from } : {}), ...(near ? { near: near.id } : {}) });
      continue;
    }
    const known = files[id];
    if (known) { known.added += change.added; known.deleted += change.deleted; continue; }
    files[id] = { added: change.added, deleted: change.deleted, ...(change.status ? { status: change.status } : {}) };
    const node = index.node(id)!;
    for (const ancestor of index.spatialAncestors(node)) areas[ancestor.id] = (areas[ancestor.id] ?? 0) + 1;
    if (node.canonicalParentId) { const entry = folder(node.canonicalParentId); entry.files++; entry.lines += change.added + change.deleted; }
  }
  const entries: string[] = [];
  for (const node of index.nodes.values()) {
    if (node.kind !== 'entity' || !ENTRY_TYPES.has(node.type) || node.change?.status === 'removed') continue;
    const file = definingFile(index, node);
    if (file && files[file]) entries.push(node.id);
  }
  return {
    pull: pullSummary(computed, set), window: computed.window, files, entries, areas,
    folders: [...folders].map(([id, { files, lines, newFiles, newFolders }]) => ({ id, path: index.node(id)?.path ?? index.node(id)?.name ?? id, files, lines, ...(newFiles ? { newFiles, ...(newFolders.size ? { newFolders: [...newFolders].sort() } : {}) } : {}) }))
      .sort((a, b) => b.files + (b.newFiles ?? 0) - a.files - (a.newFiles ?? 0) || b.lines - a.lines || (a.path < b.path ? -1 : 1)).slice(0, FOLDERS),
    outside: outside.sort((a, b) => (a.path < b.path ? -1 : 1)), outsideTotal,
    commits: set.commits.slice(0, COMMITS), shas: set.commits.map(commit => commit.sha.slice(0, 12)),
    people: set.people, ...(set.unknown && !set.changes ? { unknownReason: set.unknown } : {}),
  };
}

/** The open pull requests changing a selection (a file; a symbol's or an entry point's file; the files of an area, with those they add in it), and the latest merged ones. */
export function entityPulls(computed: PullsComputation, index: ProjectionIndex, node: ProjectionNode): EntityPulls {
  const covered = coveredFiles(index, node);
  const ids = new Set(covered.files.map(file => file.id));
  const within = (folder: string) => folder === node.id || index.spatialAncestors(index.node(folder)!).some(ancestor => ancestor.id === node.id);
  const touching = (sets: ChangeSet[]): EntityPull[] => sets.flatMap(set => {
    let files = 0, added = 0, deleted = 0;
    for (const change of set.changes ?? []) {
      const id = placeOf(computed, change);
      if (id ? !ids.has(id) : !isNew(computed, change) || !within(nearestFolder(index, change.path).id)) continue;
      files++; added += change.added; deleted += change.deleted;
    }
    return files ? [{ ...pullSummary(computed, set), here: { files, added, deleted } }] : [];
  });
  const merged = ids.size ? touching(computed.merged) : [];
  return {
    id: node.id, available: true, window: computed.window, scope: covered.scope, files: covered.files.length,
    open: ids.size ? touching(computed.open) : [], merged: merged.slice(0, ENTITY_MERGED), mergedTotal: merged.length,
  };
}
/** The files of this view a pull request changes. */
export function pullFiles(computed: PullsComputation, set: ChangeSet): string[] {
  return [...new Set((set.changes ?? []).flatMap(change => { const id = placeOf(computed, change); return id ? [id] : []; }))];
}
