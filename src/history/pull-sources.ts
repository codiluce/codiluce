// Where pull requests come from besides the branch's own commits (which
// projection/pulls.ts reads from the author log): work not merged yet, from
// Git alone, and, when asked (`--pr-metadata github`), the provider's pull
// requests with the files of those whose commits are not in the repository.
//
// Work not merged yet: branches, local and remote-tracking, whose tips the
// base branch (the one the history follows, else the one checked out) does
// not contain; the most recently committed first. A branch whose every change
// is already in the base by content (a squash-merged branch left behind) is
// left out. Git is only read: nothing is fetched into the repository.
import { readAuthorLog, type AuthorLog } from './authors.js';
import { currentBranch, git, isSha, resolveCommit } from './git.js';
import { fetchGitHubPullFiles, fetchGitHubPulls, githubToken, originRepository, type Fetcher, type GitHubRepository, type ProviderPull, type PullFileChange, type PullFileStatus } from './pull-requests.js';

/** Branches looked at, most recent first. */
export const MAX_BRANCHES = 30;
/** Commits read per branch or pull request. */
const MAX_BRANCH_COMMITS = 500;
const PROVIDER_TTL = 5 * 60_000, REFRESH_MIN = 20_000, FAILURE_TTL = 60_000;
const PROVIDER_TIMEOUT = 20_000;

export interface BaseBranch { ref: string; name: string; sha: string }
/** A branch not merged into the base: its tip, the refs pointing there, the date of its last commit. */
export interface BranchTip { name: string; refs: string[]; tip: string; date: string }
/** Work between a base and a tip: where it forked, its commits (newest first), the net change of its files since the fork. */
export interface ChangeSetData { mergeBase: string; log: AuthorLog; changes: PullFileChange[] }
export interface OpenBranch extends BranchTip, ChangeSetData {}
export interface OpenWork { base?: BaseBranch; branches: OpenBranch[]; truncated: boolean; error?: string }
export interface ProviderState {
  status: 'off' | 'ok' | 'error' | 'unsupported';
  repository?: string; fetchedAt?: string; error?: string;
  /** A token is set in the environment. */
  token: boolean;
  pulls: ProviderPull[];
}

/** A branch name without `refs/heads/` or `refs/remotes/<remote>/`. */
export function branchName(ref: string): string { return ref.replace(/^refs\/heads\//, '').replace(/^refs\/remotes\/[^/]+\//, ''); }
/** The branch the work is measured against: the one asked for (the history's), else the one checked out, else HEAD. */
export async function baseBranch(root: string, preferred?: string): Promise<BaseBranch | undefined> {
  const current = await currentBranch(root);
  for (const ref of [preferred && preferred !== 'HEAD' ? preferred : undefined, current]) {
    if (!ref) continue;
    try { return { ref, name: branchName(ref.replace(/^origin\//, 'refs/remotes/origin/')), sha: await resolveCommit(root, ref) }; } catch { /* not here */ }
  }
  try { return { ref: 'HEAD', name: '', sha: await resolveCommit(root, 'HEAD') }; } catch { return undefined; }
}
/** Branches whose tips the base does not contain, most recently committed first (the base's own refs and symbolic refs left out). */
export async function unmergedBranches(root: string, base: BaseBranch, max = MAX_BRANCHES): Promise<{ branches: BranchTip[]; truncated: boolean }> {
  const output = await git(root, ['for-each-ref', `--no-merged=${base.sha}`, '--sort=-committerdate', '--format=%(refname)%00%(objectname)%00%(committerdate:iso-strict)%00%(symref)', 'refs/heads', 'refs/remotes']);
  const byTip = new Map<string, BranchTip>();
  for (const line of output.split('\n')) {
    const [ref, tip, date, symref] = line.split('\0');
    if (!ref || !tip || !isSha(tip) || symref) continue;
    const name = branchName(ref);
    if (base.name && name === base.name) continue;
    const known = byTip.get(tip);
    if (known) { known.refs.push(ref); if (ref.startsWith('refs/heads/') && !known.refs[0]!.startsWith('refs/heads/')) known.name = name; continue; }
    byTip.set(tip, { name, refs: [ref], tip, date: date ?? '' });
  }
  const branches = [...byTip.values()];
  return { branches: branches.slice(0, max), truncated: branches.length > max };
}

const STATUS: Record<string, PullFileStatus> = { A: 'added', D: 'removed', R: 'renamed', C: 'added' };
/** The files changed from one commit to another: lines added and deleted, status, and the path before a rename. */
export async function diffChanges(root: string, from: string, to: string): Promise<PullFileChange[]> {
  if (!isSha(from) || !isSha(to)) throw new Error('Invalid commit');
  const args = ['-c', 'core.quotepath=off', 'diff', '--no-ext-diff', '-z', '-M', '--relative'];
  const [numstat, names] = await Promise.all([git(root, [...args, '--numstat', from, to, '--'], { maxBuffer: 256 * 1024 * 1024 }), git(root, [...args, '--name-status', from, to, '--'], { maxBuffer: 256 * 1024 * 1024 })]);
  const status = new Map<string, { status: PullFileStatus; from?: string }>();
  const parts = names.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i]!.charAt(0);
    if (!code) continue;
    if (code === 'R' || code === 'C') { const before = parts[++i]!, after = parts[++i]!; status.set(after, { status: STATUS[code]!, ...(code === 'R' ? { from: before } : {}) }); }
    else status.set(parts[++i]!, { status: STATUS[code] ?? 'modified' });
  }
  const changes: PullFileChange[] = [];
  const tokens = numstat.split('\0');
  for (let i = 0; i < tokens.length; i++) {
    const match = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(tokens[i]!.replace(/^\n+/, ''));
    if (!match) continue;
    const added = match[1] === '-' ? 0 : Number(match[1]), deleted = match[2] === '-' ? 0 : Number(match[2]);
    // A rename: the old and new paths follow as their own tokens.
    const path = match[3] ? match[3] : (i += 2, tokens[i]!);
    const known = status.get(path);
    changes.push({ path, added, deleted, status: known?.status ?? 'modified', ...(known?.from ? { from: known.from } : {}) });
  }
  return changes;
}
/** A tip's work over a base: commits the base does not have, and the net change since they forked. Undefined for unrelated histories. */
export async function changeSet(root: string, base: string, tip: string): Promise<ChangeSetData | undefined> {
  const mergeBase = (await git(root, ['merge-base', base, tip]).catch(() => '')).trim();
  if (!isSha(mergeBase)) return undefined;
  const [log, changes] = await Promise.all([readAuthorLog(root, tip, MAX_BRANCH_COMMITS, { exclude: base }), diffChanges(root, mergeBase, tip)]);
  return { mergeBase, log, changes };
}
/** Every file a branch changes already has, in the base, the content it has at the tip (a squash merge left the branch behind). */
async function mergedByContent(root: string, base: string, tip: string, changes: PullFileChange[]): Promise<boolean> {
  if (!changes.length || changes.length > 400) return false;
  const paths = [...new Set(changes.flatMap(change => change.from ? [change.path, change.from] : [change.path]))];
  const differ = await git(root, ['diff', '--no-ext-diff', '--name-only', '--relative', '-z', tip, base, '--', ...paths]).catch(() => 'x');
  return differ === '';
}
async function commitExists(root: string, sha: string): Promise<boolean> {
  if (!isSha(sha)) return false;
  return git(root, ['cat-file', '-e', `${sha}^{commit}`]).then(() => true, () => false);
}
/** Run `work` over `items`, `limit` at a time, in order. */
export async function pool<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (next < items.length) { const index = next++; results[index] = await work(items[index]!); } }));
  return results;
}

export interface PullSourcesOptions { provider?: 'github'; token?: string; fetcher?: Fetcher }
/**
 * Open work and provider pull requests for one repository. Branches are
 * listed on every request (one `git for-each-ref`; requests at the same time
 * share it), and each branch's work is kept by base and tip; the provider's
 * list is kept for minutes (a refresh asks again), each pull request's files
 * by head commit.
 */
export class PullSources {
  private listing?: { base: string; value: Promise<OpenWork> };
  private last?: { key: string; value: OpenWork };
  private readonly sets = new Map<string, Promise<ChangeSetData | undefined>>();
  private readonly merged = new Map<string, Promise<boolean>>();
  private providerState?: { at: number; value: Promise<ProviderState> };
  private readonly files = new Map<string, Promise<{ changes: PullFileChange[]; log?: AuthorLog; mergeBase?: string }>>();
  /** Pull requests whose files the provider failed to list lately: not asked again for a minute. */
  private readonly failures = new Map<string, { at: number; error: Error }>();
  private repository?: Promise<GitHubRepository | undefined>;
  private prefix?: Promise<string>;
  /** Whether a commit is in the repository, by SHA (a head fetched later is seen after a refresh). */
  private readonly local = new Map<string, Promise<boolean>>();
  constructor(private readonly root: string | undefined, private readonly options: PullSourcesOptions = {}) {}
  get providerEnabled(): boolean { return this.options.provider === 'github'; }
  private token(): string | undefined { return this.options.token ?? githubToken(); }
  /** Branches not merged into `base`, with their work. */
  async open(base: BaseBranch): Promise<OpenWork> {
    if (!this.root) return { base, branches: [], truncated: false };
    if (this.listing?.base === base.sha) return this.listing.value;
    const root = this.root;
    const value = (async (): Promise<OpenWork> => {
      try {
        const { branches, truncated } = await unmergedBranches(root, base);
        const key = `${base.sha}|${truncated}|${branches.map(branch => `${branch.tip}:${branch.refs.join(',')}`).join(';')}`;
        if (this.last?.key === key) return this.last.value;
        const sets = await pool(branches, 4, async tip => {
          const data = await this.changeSetOf(base.sha, tip.tip);
          if (!data || !data.log.commits.length || await this.mergedByContentOf(base.sha, tip.tip, data.changes)) return undefined;
          return { ...tip, ...data };
        });
        const work = { base, branches: sets.filter((item): item is OpenBranch => !!item), truncated };
        this.last = { key, value: work };
        return work;
      } catch (error) { return { base, branches: [], truncated: false, error: error instanceof Error ? error.message : String(error) }; }
    })();
    this.listing = { base: base.sha, value };
    void value.finally(() => { if (this.listing?.value === value) this.listing = undefined; });
    return value;
  }
  private mergedByContentOf(base: string, tip: string, changes: PullFileChange[]): Promise<boolean> {
    const key = `${base}|${tip}`;
    let pending = this.merged.get(key);
    if (!pending) { pending = mergedByContent(this.root!, base, tip, changes); this.merged.set(key, pending); if (this.merged.size > 200) this.merged.delete(this.merged.keys().next().value!); }
    return pending;
  }
  private changeSetOf(base: string, tip: string): Promise<ChangeSetData | undefined> {
    const key = `${base}|${tip}`;
    let pending = this.sets.get(key);
    if (!pending) {
      pending = changeSet(this.root!, base, tip).catch(() => undefined);
      this.sets.set(key, pending);
      if (this.sets.size > 200) this.sets.delete(this.sets.keys().next().value!);
    }
    return pending;
  }
  /** The provider's pull requests: open ones, and the closed and merged ones updated lately. `refresh` asks again (at most every 20 s). */
  async provider(options: { refresh?: boolean; since?: string } = {}): Promise<ProviderState> {
    const token = !!this.token();
    if (!this.providerEnabled || !this.root) return { status: 'off', token, pulls: [] };
    const age = this.providerState ? Date.now() - this.providerState.at : Infinity;
    if (this.providerState && age < (options.refresh ? REFRESH_MIN : PROVIDER_TTL)) return this.providerState.value;
    const previous = this.providerState?.value;
    this.forgetLocal();
    const value = (async (): Promise<ProviderState> => {
      const repository = await this.githubRepository();
      if (!repository) return { status: 'unsupported', token, pulls: [], error: 'The origin remote is not a GitHub repository.' };
      const name = `${repository.owner}/${repository.repo}`;
      try {
        const common = { token: this.token(), ...(this.options.fetcher ? { fetcher: this.options.fetcher } : {}), signal: AbortSignal.timeout(PROVIDER_TIMEOUT) };
        const [open, closed] = await Promise.all([fetchGitHubPulls(repository, { ...common, state: 'open', maxPages: 10 }), fetchGitHubPulls(repository, { ...common, state: 'closed', maxPages: 5, ...(options.since ? { since: options.since } : {}) })]);
        return { status: 'ok', repository: name, fetchedAt: new Date().toISOString(), token, pulls: [...open, ...closed] };
      } catch (error) {
        // What was read before stays usable.
        const before = await previous?.catch(() => undefined);
        return { status: 'error', repository: name, token, error: error instanceof Error ? error.message : String(error), pulls: before?.pulls ?? [], ...(before?.fetchedAt ? { fetchedAt: before.fetchedAt } : {}) };
      }
    })();
    this.providerState = { at: Date.now(), value };
    return value;
  }
  private githubRepository(): Promise<GitHubRepository | undefined> { return this.repository ??= originRepository(this.root!); }
  /** The scanned root's path inside the Git work tree (`''` at its top), to read provider paths as the map's. */
  private rootPrefix(): Promise<string> { return this.prefix ??= git(this.root!, ['rev-parse', '--show-prefix']).then(text => text.trim(), () => ''); }
  /**
   * What a provider pull request changes: from Git when its head commit is in
   * the repository (over its base branch, or `base`), else from the provider.
   * With `fetch` false, only what Git or an earlier fetch knows.
   */
  async pullChanges(pull: ProviderPull, base: string | undefined, options: { fetch?: boolean } = {}): Promise<{ changes: PullFileChange[]; log?: AuthorLog; mergeBase?: string; source: 'git' | 'provider' } | undefined> {
    if (!this.root) return undefined;
    const key = `${pull.number}@${pull.headSha ?? ''}`;
    const known = this.files.get(key);
    if (known) { const value = await known.catch(() => undefined); if (value) return { ...value, source: value.log ? 'git' : 'provider' }; this.files.delete(key); }
    if (pull.headSha && await this.isLocal(pull.headSha)) {
      const baseSha = await this.localBase(pull.baseRef) ?? base;
      if (baseSha) {
        const data = await this.changeSetOf(baseSha, pull.headSha);
        if (data) { this.files.set(key, Promise.resolve(data)); return { ...data, source: 'git' }; }
      }
    }
    if (options.fetch === false || !this.providerEnabled) return undefined;
    const failure = this.failures.get(key);
    if (failure && Date.now() - failure.at < FAILURE_TTL) throw failure.error;
    const repository = await this.githubRepository();
    if (!repository) return undefined;
    const pending = (async () => {
      const prefix = await this.rootPrefix();
      const files = await fetchGitHubPullFiles(repository, pull.number, { token: this.token(), ...(this.options.fetcher ? { fetcher: this.options.fetcher } : {}), signal: AbortSignal.timeout(PROVIDER_TIMEOUT) });
      const inside = (file: string) => !prefix || file.startsWith(prefix);
      return { changes: files.filter(file => inside(file.path)).map(file => ({ ...file, path: file.path.slice(prefix.length), ...(file.from && inside(file.from) ? { from: file.from.slice(prefix.length) } : {}) })) };
    })();
    this.files.set(key, pending);
    if (this.files.size > 500) this.files.delete(this.files.keys().next().value!);
    try { return { ...await pending, source: 'provider' }; }
    catch (error) {
      this.files.delete(key);
      this.failures.set(key, { at: Date.now(), error: error instanceof Error ? error : new Error(String(error)) });
      if (this.failures.size > 500) this.failures.delete(this.failures.keys().next().value!);
      throw error;
    }
  }
  private isLocal(sha: string): Promise<boolean> {
    let known = this.local.get(sha);
    if (!known) { known = commitExists(this.root!, sha); this.local.set(sha, known); if (this.local.size > 2000) this.local.delete(this.local.keys().next().value!); }
    return known;
  }
  /** Forget what was learned about commits (a refresh: heads may have been fetched since). */
  private forgetLocal(): void { for (const [sha, known] of this.local) void known.then(found => { if (!found) this.local.delete(sha); }); }
  /** The local commit of a provider base branch name (its remote-tracking branch first). */
  private async localBase(name: string | undefined): Promise<string | undefined> {
    if (!name) return undefined;
    for (const ref of [`refs/remotes/origin/${name}`, `refs/heads/${name}`]) {
      const sha = (await git(this.root!, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`]).catch(() => '')).trim();
      if (isSha(sha)) return sha;
    }
    return undefined;
  }
}
