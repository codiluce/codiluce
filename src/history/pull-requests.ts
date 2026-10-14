// Pull request markers. Git records merges, not pull requests: a PR number,
// title or author is only authoritative when it comes from the hosting
// provider. Commit-message conventions are kept as clearly labeled hints.
//
// The provider is read only when asked (`--pr-metadata github`): merged pull
// requests at history indexing, and open, merged and closed ones (with the
// files of a pull request whose commits are not in the local repository) for
// the Pull requests panel. GITHUB_TOKEN (or GH_TOKEN) is sent when set.
import type { CommitInfo } from './git.js';
import { git } from './git.js';
import type { PullRequestRecord } from './store.js';

export interface PullRequestRef {
  number: number; title?: string; url?: string; author?: string; headRef?: string;
  /** `github`: provider API record. `merge-message`/`squash-message`: inferred from the commit message, unverified. */
  source: string;
}
/** GitHub/GitLab default merge and squash messages. */
export function pullRequestFromMessage(commit: Pick<CommitInfo, 'subject' | 'body' | 'parents'>): PullRequestRef | undefined {
  const merge = /^Merge pull request #(\d+) from (\S+)/.exec(commit.subject);
  if (merge && commit.parents.length > 1) return { number: Number(merge[1]), headRef: merge[2], ...(commit.body ? { title: commit.body.split('\n')[0] } : {}), source: 'merge-message' };
  const gitlab = /See merge request [\w./-]+!(\d+)/.exec(commit.body);
  if (gitlab && commit.parents.length > 1) return { number: Number(gitlab[1]), title: commit.subject.replace(/^Merge branch '([^']+)'.*$/, '$1'), source: 'merge-message' };
  const squash = /^(.*\S)\s+\(#(\d+)\)$/.exec(commit.subject);
  if (squash) return { number: Number(squash[2]), title: squash[1], source: 'squash-message' };
  return undefined;
}

export type Fetcher = (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; headers?: { get(name: string): string | null }; json(): Promise<unknown> }>;
export interface GitHubRepository { owner: string; repo: string }
/** owner/repo of a GitHub remote URL (https or ssh), if it is one. */
export function githubRepository(remote: string): GitHubRepository | undefined {
  const match = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(remote.trim());
  return match ? { owner: match[1]!, repo: match[2]! } : undefined;
}
/** The GitHub repository of the `origin` remote, if it is one. */
export async function originRepository(root: string): Promise<GitHubRepository | undefined> {
  return githubRepository(await git(root, ['remote', 'get-url', 'origin']).catch(() => ''));
}
/** A token for the GitHub API from the environment, if one is set. */
export function githubToken(env: NodeJS.ProcessEnv = process.env): string | undefined { return env.GITHUB_TOKEN || env.GH_TOKEN || undefined; }
export interface GitHubOptions { token?: string; fetcher?: Fetcher; signal?: AbortSignal }
async function githubGet(path: string, options: GitHubOptions): Promise<unknown> {
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'codiluce-history' };
  const token = options.token ?? githubToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const fetcher: Fetcher = options.fetcher ?? ((url, init) => fetch(url, init));
  const response = await fetcher(`https://api.github.com${path}`, { headers, ...(options.signal ? { signal: options.signal } : {}) });
  if (!response.ok) {
    const limited = (response.status === 403 || response.status === 429) && response.headers?.get('x-ratelimit-remaining') === '0';
    throw new Error(`GitHub API responded ${response.status}${limited ? ` (rate limit reached${token ? '' : '; set GITHUB_TOKEN for a higher one'})` : response.status === 404 || response.status === 401 ? ' (private repository? set GITHUB_TOKEN)' : ''}`);
  }
  return response.json();
}
const repoPath = (repository: GitHubRepository) => `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}`;
/**
 * Merged pull requests from the GitHub REST API (opt-in; needs GITHUB_TOKEN
 * for private repositories). Pages newest-first until PRs are older than the
 * oldest commit of interest.
 */
export async function fetchGitHubPullRequests(root: string, options: { since?: string; token?: string; fetcher?: Fetcher; maxPages?: number } = {}): Promise<PullRequestRecord[]> {
  const repository = await originRepository(root);
  if (!repository) throw new Error('The origin remote is not a GitHub repository');
  const pulls = await fetchGitHubPulls(repository, { ...options, state: 'closed', maxPages: options.maxPages ?? 50 });
  return pulls.flatMap(pull => pull.state === 'merged' && pull.mergeCommitSha ? [{ provider: 'github', number: pull.number, title: pull.title, url: pull.url, ...(pull.author ? { author: pull.author } : {}), mergedAt: pull.mergedAt!, mergeCommitSha: pull.mergeCommitSha, ...(pull.headRef ? { headRef: pull.headRef } : {}) }] : []);
}
export function pullRequestFromRecord(record: PullRequestRecord): PullRequestRef {
  return { number: record.number, title: record.title, ...(record.url ? { url: record.url } : {}), ...(record.author ? { author: record.author } : {}), ...(record.headRef ? { headRef: record.headRef } : {}), source: record.provider };
}

/** A pull request as the provider records it. */
export interface ProviderPull {
  number: number; title: string; url: string; author?: string;
  state: 'open' | 'merged' | 'closed'; draft: boolean;
  createdAt: string; updatedAt: string; closedAt?: string; mergedAt?: string;
  /** The commit that landed it on the base branch (a merge, a squash or the last rebased commit). */
  mergeCommitSha?: string;
  headRef?: string; headSha?: string; baseRef?: string;
}
export type PullFileStatus = 'added' | 'modified' | 'removed' | 'renamed';
/** A file a pull request changes: lines added and deleted, and the path before a rename. */
export interface PullFileChange { path: string; added: number; deleted: number; status: PullFileStatus; from?: string }
interface GitHubPull {
  number: number; title: string; html_url: string; user?: { login?: string }; state: string; draft?: boolean;
  created_at: string; updated_at: string; closed_at?: string | null; merged_at: string | null; merge_commit_sha: string | null;
  head?: { ref?: string; sha?: string }; base?: { ref?: string };
}
/**
 * Open or closed pull requests (closed ones include the merged), most
 * recently updated first. Paging stops at `since` (all updated before it).
 */
export async function fetchGitHubPulls(repository: GitHubRepository, options: GitHubOptions & { state: 'open' | 'closed'; since?: string; maxPages?: number }): Promise<ProviderPull[]> {
  const pulls: ProviderPull[] = [];
  for (let page = 1; page <= (options.maxPages ?? 10); page++) {
    const items = await githubGet(`${repoPath(repository)}/pulls?state=${options.state}&sort=updated&direction=desc&per_page=100&page=${page}`, options) as GitHubPull[];
    for (const item of items) {
      pulls.push({
        number: item.number, title: item.title, url: item.html_url, ...(item.user?.login ? { author: item.user.login } : {}),
        state: item.merged_at ? 'merged' : item.state === 'open' ? 'open' : 'closed', draft: !!item.draft,
        createdAt: item.created_at, updatedAt: item.updated_at, ...(item.closed_at ? { closedAt: item.closed_at } : {}), ...(item.merged_at ? { mergedAt: item.merged_at } : {}),
        ...(item.merged_at && item.merge_commit_sha ? { mergeCommitSha: item.merge_commit_sha } : {}),
        ...(item.head?.ref ? { headRef: item.head.ref } : {}), ...(item.head?.sha ? { headSha: item.head.sha } : {}), ...(item.base?.ref ? { baseRef: item.base.ref } : {}),
      });
    }
    if (items.length < 100 || (options.since && items.every(item => item.updated_at < options.since!))) break;
  }
  return pulls;
}
const FILE_STATUS: Record<string, PullFileStatus> = { added: 'added', removed: 'removed', renamed: 'renamed', copied: 'added' };
/** The files a pull request changes, as the provider lists them (GitHub lists 3,000 at most). */
export async function fetchGitHubPullFiles(repository: GitHubRepository, number: number, options: GitHubOptions & { maxPages?: number } = {}): Promise<PullFileChange[]> {
  if (!Number.isSafeInteger(number) || number < 1) throw new Error('Invalid pull request number');
  const files: PullFileChange[] = [];
  for (let page = 1; page <= (options.maxPages ?? 30); page++) {
    const items = await githubGet(`${repoPath(repository)}/pulls/${number}/files?per_page=100&page=${page}`, options) as { filename: string; status: string; additions: number; deletions: number; previous_filename?: string }[];
    for (const item of items) files.push({ path: item.filename, added: item.additions, deleted: item.deletions, status: FILE_STATUS[item.status] ?? 'modified', ...(item.previous_filename ? { from: item.previous_filename } : {}) });
    if (items.length < 100) break;
  }
  return files;
}
