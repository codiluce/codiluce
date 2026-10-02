// The timeline served to the visualizer: a branch's first-parent commits
// (read live from Git when available, otherwise as recorded by the indexer),
// which of them have snapshots, and pull request markers. Optional on-demand
// indexing runs the `history index` command in a child process, one commit at
// a time, so the server itself stays read-only and responsive.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GraphStore } from '../storage/sqlite.js';
import type { TimelineEntry, TimelineResponse } from '../projection/dto.js';
import { snapshotRef } from '../projection/source.js';
import { WorkingTreeSnapshot } from './snapshot.js';
import { isSha, listCommits, resolveCommit, validRef, type CommitInfo } from './git.js';
import { childExecArgv, HISTORY_DATABASE, historyConfig, historyIdentity } from './indexer.js';
import { pullRequestFromMessage, pullRequestFromRecord } from './pull-requests.js';
import { HistoryStore } from './store.js';

const MAX_ENTRIES = 5000;
/** Opens `<state>/history.db` read-only once it exists (it may be created while the server runs). */
export class HistoryAccess {
  private store?: HistoryStore;
  private checkedAt = 0;
  constructor(readonly stateDirectory?: string) {}
  get = (): HistoryStore | undefined => {
    if (this.store || !this.stateDirectory) return this.store;
    if (Date.now() - this.checkedAt < 3000) return undefined;
    this.checkedAt = Date.now();
    const file = path.join(this.stateDirectory, HISTORY_DATABASE);
    if (!existsSync(file)) return undefined;
    try {
      const store = new HistoryStore(file, true);
      // An empty store (created by an indexer that is still starting) has no schema yet.
      store.db.prepare('SELECT 1 FROM snapshots LIMIT 1').all();
      this.store = store;
    } catch { /* not initialized yet */ }
    return this.store;
  };
  close(): void { this.store?.close(); this.store = undefined; }
}

export interface HistoryServiceOptions { root?: string; stateDirectory?: string; store: GraphStore; history: HistoryAccess; indexing?: boolean }
export class HistoryService {
  private live?: { ref: string; head: string; commits: CommitInfo[] };
  private identity?: { at: number; value: string };
  private readonly queue: string[] = [];
  private active?: { sha: string };
  private readonly failed = new Map<string, string>();
  constructor(private readonly options: HistoryServiceOptions) {}
  get indexingEnabled(): boolean { return !!this.options.indexing && !!this.options.root && !!this.options.stateDirectory; }
  /** Snapshot identity for the current configuration; snapshots made under another one are marked stale. */
  async currentIdentity(): Promise<string | undefined> {
    if (!this.options.root || !this.options.stateDirectory) return undefined;
    if (this.identity && Date.now() - this.identity.at < 10_000) return this.identity.value;
    try { this.identity = { at: Date.now(), value: historyIdentity(await historyConfig(this.options.root, this.options.stateDirectory)) }; }
    catch { return undefined; }
    return this.identity.value;
  }
  async defaultRef(): Promise<string> { return this.options.history.get()?.meta('default_ref') ?? 'HEAD'; }
  /** First-parent commits of `ref`, oldest first: live from Git (cached per head), else as recorded. */
  async commits(ref: string): Promise<{ head?: string; commits: CommitInfo[] } | undefined> {
    const { root } = this.options;
    const history = this.options.history.get();
    if (root) {
      try {
        const head = await resolveCommit(root, ref);
        if (this.live?.ref !== ref || this.live.head !== head) this.live = { ref, head, commits: await listCommits(root, { ref, firstParent: true }) };
        return { head, commits: this.live.commits };
      } catch { /* not a Git checkout here: fall back to the recorded timeline */ }
    }
    const stored = history?.timeline(ref);
    if (!stored || !history) return undefined;
    const known = history.commits(stored.commits);
    return { head: stored.head, commits: stored.commits.map(sha => known.get(sha)).filter((commit): commit is CommitInfo => !!commit) };
  }
  async timeline(requestedRef?: string): Promise<TimelineResponse> {
    if (requestedRef !== undefined && !validRef(requestedRef)) throw new Error('Invalid ref');
    const history = this.options.history.get();
    const run = this.options.store.currentRun();
    const workingTree = run ? { ...snapshotRef(new WorkingTreeSnapshot(this.options.store, this.options.root, run)), stats: { entities: Number(this.options.store.db.prepare('SELECT count(*) AS count FROM entities').get()!.count) } } : undefined;
    const indexing = { enabled: this.indexingEnabled, ...(this.active ? { active: this.active.sha } : {}), queued: [...this.queue], failed: [...this.failed].map(([sha, error]) => ({ sha, error })) };
    if (!history) return { available: false, reason: 'No history has been indexed for this state directory. Run: npm run archipelago -- history index --repo PATH --state-dir PATH', firstParent: true, entries: [], ...(workingTree ? { workingTree } : {}), indexing };
    const ref = requestedRef ?? await this.defaultRef();
    const listed = await this.commits(ref);
    if (!listed) return { available: false, reason: `No timeline is recorded for ${ref}`, ref, firstParent: true, entries: [], ...(workingTree ? { workingTree } : {}), indexing };
    const identity = await this.currentIdentity();
    const snapshots = history.snapshotsByCommit(identity);
    const pullRequests = new Map(history.pullRequests().map(record => [record.mergeCommitSha!, pullRequestFromRecord(record)]));
    const entries: TimelineEntry[] = listed.commits.slice(-MAX_ENTRIES).map(commit => {
      const snapshot = snapshots.get(commit.sha);
      const pullRequest = pullRequests.get(commit.sha) ?? pullRequestFromMessage(commit);
      return {
        sha: commit.sha, parents: commit.parents, authorName: commit.authorName, authoredAt: commit.authoredAt, committedAt: commit.committedAt, subject: commit.subject,
        merge: commit.parents.length > 1, ...(pullRequest ? { pullRequest } : {}),
        ...(snapshot ? { snapshot: { id: snapshot.id, stale: identity !== undefined && snapshot.identity !== identity, stats: snapshot.stats } } : {}),
      };
    });
    return { available: true, ref, ...(listed.head ? { head: listed.head } : {}), firstParent: true, entries, ...(workingTree ? { workingTree } : {}), indexing };
  }

  // On-demand indexing -------------------------------------------------------------
  /** Queue one commit of the timeline for indexing. Only commits listed on the timeline are accepted. */
  async request(sha: string, ref?: string): Promise<{ queued: boolean; position: number }> {
    if (!this.indexingEnabled) throw new Error('On-demand indexing is disabled; start serve with --history-indexing');
    if (!isSha(sha)) throw new Error('sha must be a full commit SHA');
    const timelineRef = ref ?? await this.defaultRef();
    const listed = await this.commits(timelineRef);
    if (!listed?.commits.some(commit => commit.sha === sha)) throw new Error('Commit is not on the timeline');
    if (this.active?.sha === sha || this.queue.includes(sha)) return { queued: true, position: this.queue.indexOf(sha) + 1 };
    this.failed.delete(sha);
    this.queue.push(sha);
    void this.drain(timelineRef);
    return { queued: true, position: this.queue.length };
  }
  private async drain(ref: string): Promise<void> {
    if (this.active) return;
    const sha = this.queue.shift();
    if (!sha) return;
    this.active = { sha };
    const cli = fileURLToPath(new URL(`../cli${path.extname(fileURLToPath(import.meta.url))}`, import.meta.url));
    const args = [...childExecArgv(), cli, 'history', 'index', '--repo', this.options.root!, '--state-dir', this.options.stateDirectory!, '--ref', ref, '--commits', sha, '--jobs', '1'];
    await new Promise<void>(resolve => {
      const child = spawn(process.execPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
      child.on('error', error => { this.failed.set(sha, error.message); resolve(); });
      child.on('close', code => { if (code !== 0) this.failed.set(sha, stderr.trim().split('\n').filter(line => !/ExperimentalWarning|--trace-warnings/.test(line)).slice(-3).join(' ') || `exit ${code}`); resolve(); });
    });
    this.active = undefined;
    void this.drain(ref);
  }
}
