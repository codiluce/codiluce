// Pull request markers. Git records merges, not pull requests: a PR number,
// title or author is only authoritative when it comes from the hosting
// provider. Commit-message conventions are kept as clearly labeled hints.
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

type Fetcher = (url: string, init: { headers: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
/** owner/repo of a GitHub remote URL (https or ssh), if it is one. */
export function githubRepository(remote: string): { owner: string; repo: string } | undefined {
  const match = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(remote.trim());
  return match ? { owner: match[1]!, repo: match[2]! } : undefined;
}
/**
 * Merged pull requests from the GitHub REST API (opt-in; needs GITHUB_TOKEN
 * for private repositories). Pages newest-first until PRs are older than the
 * oldest commit of interest.
 */
export async function fetchGitHubPullRequests(root: string, options: { since?: string; token?: string; fetcher?: Fetcher; maxPages?: number } = {}): Promise<PullRequestRecord[]> {
  const remote = await git(root, ['remote', 'get-url', 'origin']).catch(() => '');
  const repository = githubRepository(remote);
  if (!repository) throw new Error('The origin remote is not a GitHub repository');
  const fetcher: Fetcher = options.fetcher ?? ((url, init) => fetch(url, init));
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'archipelago-history' };
  const token = options.token ?? process.env.GITHUB_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  const records: PullRequestRecord[] = [];
  for (let page = 1; page <= (options.maxPages ?? 50); page++) {
    const url = `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=${page}`;
    const response = await fetcher(url, { headers });
    if (!response.ok) throw new Error(`GitHub API responded ${response.status}${response.status === 404 || response.status === 401 ? ' (private repository? set GITHUB_TOKEN)' : ''}`);
    const items = await response.json() as { number: number; title: string; html_url: string; user?: { login?: string }; merged_at: string | null; updated_at: string; merge_commit_sha: string | null; head?: { ref?: string } }[];
    for (const item of items) if (item.merged_at && item.merge_commit_sha) records.push({ provider: 'github', number: item.number, title: item.title, url: item.html_url, ...(item.user?.login ? { author: item.user.login } : {}), mergedAt: item.merged_at, mergeCommitSha: item.merge_commit_sha, ...(item.head?.ref ? { headRef: item.head.ref } : {}) });
    if (items.length < 100 || (options.since && items.every(item => item.updated_at < options.since!))) break;
  }
  return records;
}
export function pullRequestFromRecord(record: PullRequestRecord): PullRequestRef {
  return { number: record.number, title: record.title, ...(record.url ? { url: record.url } : {}), ...(record.author ? { author: record.author } : {}), ...(record.headRef ? { headRef: record.headRef } : {}), source: record.provider };
}
