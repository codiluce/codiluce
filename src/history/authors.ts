// Who changed which files, read from the Git history. Deterministic: one
// `git log --numstat` pass per commit the map shows (newest first, children
// before parents), cached in memory and, for the live index, in the state
// directory. No language model is involved.
//
// People: the author of every commit, and anyone named in a `Co-authored-by`
// trailer. Git's .mailmap is applied to authors. Identities with the same
// e-mail address (case-insensitive; GitHub's no-reply addresses by login), or
// the same full name of two words or more, are one person. Known coding agents
// (Claude, Copilot, Cursor, Codex, Devin…) and automation accounts (`[bot]`,
// Dependabot, Renovate…) are told apart from humans by name and address.
//
// Changes: lines added and deleted per file. Renames are followed: a change
// recorded under an older path is credited to the path the file has at the
// commit shown. Merge commits are read for ancestry only: their changes are
// counted in the commits they merge.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const AUTHORS_VERSION = 1;
/** Commits read at most per log; older history is left out (and said so). */
export const AUTHORS_MAX_COMMITS = 10_000;
const CACHE_FILE = 'authors.json';
export type PersonKind = 'human' | 'agent' | 'bot';
export interface Identity { name: string; email: string }
export interface LogChange { path: string; added: number; deleted: number; /** The path before a rename. */ from?: string }
export interface LogCommit {
  sha: string; parents: string[];
  /** Identity indexes: the author, then co-authors from trailers. */
  author: number; coauthors: number[];
  authoredAt: string; committedAt: string; subject: string;
  changes: LogChange[];
}
export interface AuthorLog {
  version: number; head: string; maxCommits: number;
  /** The history went on beyond `maxCommits`. */
  truncated: boolean;
  identities: Identity[];
  /** Newest first; parents always after their children. */
  commits: LogCommit[];
}
export interface Person {
  key: string; name: string; emails: string[]; kind: PersonKind; identities: number[];
  /** Position by first commit in the log (0: the earliest): stable whatever the window, so colors can follow it. */
  order: number;
}

/** Read the history reachable from `head`, newest first, with the files each commit changed. */
export function readAuthorLog(root: string, head: string, maxCommits = AUTHORS_MAX_COMMITS): Promise<AuthorLog> {
  if (!/^[0-9a-f]{40}$/.test(head)) return Promise.reject(new Error('Invalid commit'));
  return new Promise((resolve, reject) => {
    // --relative: paths relative to the scanned root, which may be a subdirectory of the Git work tree.
    const format = '%x1e%H%x1f%P%x1f%aN%x1f%aE%x1f%aI%x1f%cI%x1f%s%x1f%(trailers:key=Co-authored-by,valueonly,separator=%x1d)';
    const child = spawn('git', ['-c', 'core.quotepath=off', 'log', '--topo-order', '-M', '--numstat', '-z', '--relative', `--max-count=${maxCommits + 1}`, `--format=${format}`, head, '--'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' } });
    const identities: Identity[] = [], known = new Map<string, number>();
    const identity = (name: string, email: string) => {
      const key = `${name}\0${email}`;
      let index = known.get(key);
      if (index === undefined) { index = identities.push({ name, email }) - 1; known.set(key, index); }
      return index;
    };
    const commits: LogCommit[] = [];
    let buffer = '', errors = '';
    const record = (chunk: string) => {
      const header = chunk.indexOf('\0');
      const [sha, parents, name, email, authoredAt, committedAt, subject, trailers] = (header < 0 ? chunk : chunk.slice(0, header)).replace(/\n+$/, '').split('\x1f');
      if (!sha || !authoredAt) return;
      const coauthors = [...new Set((trailers ?? '').split('\x1d').map(coauthor).filter((value): value is Identity => !!value).map(value => identity(value.name, value.email)))];
      const author = identity(name ?? '', email ?? '');
      const changes: LogChange[] = [];
      const tokens = header < 0 ? [] : chunk.slice(header + 1).split('\0');
      for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index]!.replace(/^\n+/, '');
        if (!token) continue;
        const match = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(token);
        if (!match) continue;
        const added = match[1] === '-' ? 0 : Number(match[1]), deleted = match[2] === '-' ? 0 : Number(match[2]);
        if (match[3]) { changes.push({ path: match[3], added, deleted }); continue; }
        // A rename: the old and new paths follow as their own tokens.
        const from = tokens[++index], to = tokens[++index];
        if (from === undefined || to === undefined) break;
        changes.push({ path: to, added, deleted, from });
      }
      commits.push({ sha, parents: parents ? parents.split(' ').filter(Boolean) : [], author, coauthors: coauthors.filter(index => index !== author), authoredAt, committedAt: committedAt ?? authoredAt, subject: subject ?? '', changes });
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (data: string) => {
      buffer += data;
      const parts = buffer.split('\x1e');
      buffer = parts.pop()!;
      for (const part of parts) record(part);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (data: string) => { if (errors.length < 2000) errors += data; });
    child.once('error', reject);
    child.once('close', code => {
      if (code !== 0) { reject(new Error(errors.trim().split('\n')[0] || `git log exited with ${code}`)); return; }
      record(buffer);
      const truncated = commits.length > maxCommits;
      resolve({ version: AUTHORS_VERSION, head, maxCommits, truncated, identities, commits: truncated ? commits.slice(0, maxCommits) : commits });
    });
  });
}
/** `Name <address>` from a trailer. */
function coauthor(value: string): Identity | undefined {
  const text = value.trim();
  if (!text) return undefined;
  const match = /^(.*?)\s*<([^<>]*)>\s*$/.exec(text);
  return match ? { name: match[1]!.trim() || match[2]!.trim(), email: match[2]!.trim() } : { name: text, email: '' };
}

// People ---------------------------------------------------------------------------------
/** Coding agents, by name or address. Checked before bots: some agents commit as `[bot]` accounts. */
const AGENT_NAMES = /^(claude( code)?|(github )?copilot|copilot-swe-agent(\[bot\])?|cursor( agent)?|cursoragent|devin(-ai-integration(\[bot\])?)?|(openai )?codex|chatgpt-codex-connector(\[bot\])?|(google-labs-)?jules(\[bot\])?|gemini( cli| code assist)?|amp|openhands(-agent)?|sweep(-ai)?(\[bot\])?|windsurf|cascade|factory droid|aider)$/i;
const AGENT_EMAILS = /^(noreply@anthropic\.com|.*\bclaude\b.*@anthropic\.com|cursoragent@cursor\.com|.*copilot.*@users\.noreply\.github\.com|.*devin-ai-integration.*@users\.noreply\.github\.com|.*codex.*@(users\.noreply\.github\.com|openai\.com)|.*jules.*@(users\.noreply\.github\.com|google\.com)|amp@ampcode\.com|openhands@all-hands\.dev|aider@aider\.chat)$/i;
const BOT_NAMES = /(\[bot\]$|^(dependabot|renovate|github-actions|greenkeeper|snyk-bot|semantic-release-bot|pre-commit-ci|imgbot|allcontributors|mergify|codecov|deepsource-autofix|restyled-io|weblate|transifex)\b)/i;
export function kindOf(identity: Identity): PersonKind {
  const name = identity.name.trim(), email = identity.email.trim();
  if (AGENT_NAMES.test(name) || / \(aider\)$/i.test(name) || AGENT_EMAILS.test(email)) return 'agent';
  if (BOT_NAMES.test(name) || /\[bot\]@/i.test(email)) return 'bot';
  return 'human';
}
function emailKey(email: string): string | undefined {
  const address = email.trim().toLowerCase();
  if (!address || !address.includes('@')) return undefined;
  const github = /^(?:\d+\+)?([^@]+)@users\.noreply\.github\.com$/.exec(address);
  return github ? `github:${github[1]}` : `email:${address}`;
}
/** A full name (two words or more), without case, accents or repeated spaces. */
function nameKey(name: string): string | undefined {
  const normal = name.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
  return normal.includes(' ') && !/\(aider\)$/.test(normal) ? `name:${normal}` : undefined;
}
/**
 * Merge identities into people. `weight` (commits per identity) picks the
 * name shown: the one used most. Keys are stable while a person's addresses
 * stay the same.
 */
export function resolvePeople(identities: Identity[], weight: (index: number) => number = () => 0): { people: Person[]; personOf: number[] } {
  const parent = identities.map((_, index) => index);
  const find = (index: number): number => { let root = index; while (parent[root] !== root) root = parent[root]!; parent[index] = root; return root; };
  const union = (a: number, b: number) => { const x = find(a), y = find(b); if (x !== y) parent[Math.max(x, y)] = Math.min(x, y); };
  const seen = new Map<string, number>();
  const kinds = identities.map(kindOf);
  identities.forEach((identity, index) => {
    // Agents and bots merge by address only: a shared display name says nothing about them. An agent
    // committing under a human's address (aider's "Name (aider)") stays apart from that human.
    const keys = [emailKey(identity.email), kinds[index] === 'human' ? nameKey(identity.name) : undefined, !identity.email ? `bare:${identity.name.trim().toLowerCase()}` : undefined];
    for (const key of keys) { if (!key) continue; const kindKey = `${kinds[index]}|${key}`; const other = seen.get(kindKey); if (other === undefined) seen.set(kindKey, index); else union(index, other); }
  });
  const groups = new Map<number, number[]>();
  identities.forEach((_, index) => { const root = find(index); groups.set(root, [...groups.get(root) ?? [], index]); });
  const personOf = new Array<number>(identities.length);
  const people: Person[] = [];
  for (const members of groups.values()) {
    const ranked = [...members].sort((a, b) => weight(b) - weight(a) || a - b);
    const kind = kinds[members[0]!]!;
    const emails = [...new Set(members.map(index => identities[index]!.email.trim()).filter(Boolean))].sort();
    const anchor = [...new Set(members.map(index => emailKey(identities[index]!.email) ?? `name:${identities[index]!.name.trim().toLowerCase()}`))].sort()[0]!;
    const person: Person = {
      key: createHash('sha1').update(`${kind}|${anchor}`).digest('hex').slice(0, 12),
      name: identities[ranked[0]!]!.name.trim().replace(/\s+/g, ' ') || emails[0] || 'Unknown',
      emails, kind, identities: members.sort((a, b) => a - b), order: 0,
    };
    for (const index of members) personOf[index] = people.length;
    people.push(person);
  }
  return { people, personOf };
}

// Folding the history onto one commit ---------------------------------------------------
export interface FoldedChange { path: string; added: number; deleted: number }
export interface FoldedCommit {
  /** Index in the log. */
  index: number; sha: string; subject: string; authoredAt: string;
  /** People (indexes): the author first, then the co-authors. */
  people: number[];
  /** Files under the path each had at the anchor. */
  changes: FoldedChange[];
}
export interface FoldedHistory {
  anchor: string; until: string;
  /** Commits that changed files, newest first (merges and empty commits left out). */
  commits: FoldedCommit[];
  /** Every commit reachable from the anchor in the log, merges included. */
  reachable: Set<string>;
}
/** An author log with its people resolved, ready to fold onto any commit it contains. */
export class AuthorHistory {
  readonly people: Person[];
  readonly personOf: number[];
  readonly bySha = new Map<string, number>();
  private readonly folded = new Map<string, FoldedHistory>();
  constructor(readonly log: AuthorLog) {
    const commitsBy = new Array<number>(log.identities.length).fill(0);
    log.commits.forEach((commit, index) => { this.bySha.set(commit.sha, index); if (commit.parents.length <= 1) for (const id of [commit.author, ...commit.coauthors]) commitsBy[id]!++; });
    ({ people: this.people, personOf: this.personOf } = resolvePeople(log.identities, index => commitsBy[index]!));
    // Order by first commit, oldest first (people only seen in merges last).
    const first = new Map<number, number>();
    for (let index = log.commits.length - 1; index >= 0; index--) {
      const commit = log.commits[index]!;
      if (commit.parents.length > 1) continue;
      for (const id of [commit.author, ...commit.coauthors]) { const person = this.personOf[id]!; if (!first.has(person)) first.set(person, first.size); }
    }
    this.people.forEach((person, index) => { person.order = first.get(index) ?? first.size + index; });
  }
  has(sha: string): boolean { return this.bySha.has(sha); }
  /** Commits reachable from `sha` within the log. */
  reachable(sha: string): Set<string> {
    const seen = new Set<string>();
    const stack = this.bySha.has(sha) ? [sha] : [];
    while (stack.length) {
      const current = stack.pop()!;
      if (seen.has(current)) continue;
      seen.add(current);
      const commit = this.log.commits[this.bySha.get(current)!]!;
      for (const parent of commit.parents) if (this.bySha.has(parent) && !seen.has(parent)) stack.push(parent);
    }
    return seen;
  }
  /** The history as seen from `anchor`: every change under the path its file has there. */
  fold(anchor: string): FoldedHistory | undefined {
    const cached = this.folded.get(anchor);
    if (cached) return cached;
    const start = this.bySha.get(anchor);
    if (start === undefined) return undefined;
    const reachable = this.reachable(anchor);
    /** Historical path → its path at the anchor. */
    const alias = new Map<string, string>();
    const commits: FoldedCommit[] = [];
    for (let index = start; index < this.log.commits.length; index++) {
      const commit = this.log.commits[index]!;
      if (!reachable.has(commit.sha) || commit.parents.length > 1) continue;
      const changes: FoldedChange[] = [];
      for (const change of commit.changes) {
        const current = alias.get(change.path) ?? change.path;
        if (change.from !== undefined && !alias.has(change.from)) alias.set(change.from, current);
        changes.push({ path: current, added: change.added, deleted: change.deleted });
      }
      if (!changes.length) continue;
      commits.push({ index, sha: commit.sha, subject: commit.subject, authoredAt: commit.authoredAt, people: [...new Set([commit.author, ...commit.coauthors].map(id => this.personOf[id]!))], changes });
    }
    const folded: FoldedHistory = { anchor, until: this.log.commits[start]!.committedAt, commits, reachable };
    this.folded.set(anchor, folded);
    if (this.folded.size > 6) this.folded.delete(this.folded.keys().next().value!);
    return folded;
  }
}

/**
 * Author histories by head, read once each (the live index's from the state
 * directory when it was read before). A commit is folded on a log that
 * contains it; another log is read only when none does.
 */
export class AuthorLogs {
  private readonly logs = new Map<string, Promise<AuthorHistory>>();
  constructor(private readonly root?: string, private readonly stateDirectory?: string, private readonly maxCommits = AUTHORS_MAX_COMMITS) {}
  get available(): boolean { return !!this.root; }
  async containing(sha: string, options: { persist?: boolean } = {}): Promise<AuthorHistory> {
    if (!this.root) throw new Error('No repository root');
    for (const [head, pending] of this.logs) {
      const history = await pending.catch(() => undefined);
      if (!history) { this.logs.delete(head); continue; }
      if (history.has(sha)) return history;
    }
    // Another request may have started reading this very commit meanwhile.
    const started = this.logs.get(sha);
    if (started) return started;
    const pending = this.read(sha, !!options.persist);
    this.logs.set(sha, pending);
    if (this.logs.size > 3) this.logs.delete(this.logs.keys().next().value!);
    return pending;
  }
  private async read(head: string, persist: boolean): Promise<AuthorHistory> {
    const file = this.stateDirectory ? path.join(this.stateDirectory, CACHE_FILE) : undefined;
    if (file) {
      try {
        const saved = JSON.parse(await readFile(file, 'utf8')) as AuthorLog;
        if (saved.version === AUTHORS_VERSION && saved.head === head && saved.maxCommits === this.maxCommits) return new AuthorHistory(saved);
      } catch { /* not read before, or unreadable */ }
    }
    const log = await readAuthorLog(this.root!, head, this.maxCommits);
    if (file && persist) {
      try { const temporary = `${file}.${process.pid}.tmp`; await writeFile(temporary, JSON.stringify(log)); await rename(temporary, file); }
      catch { /* read-only state directory: read again next time */ }
    }
    return new AuthorHistory(log);
  }
}
