// Historical indexing: analyze commits of a branch's first-parent history
// into the versioned snapshot store. Commits are materialized from Git blobs
// into scratch directories (the target repository is only read), analyzed
// with the same pipeline as the working tree, and never executed.
import { fork } from 'node:child_process';
import { mkdtemp, realpath, rm, lstat } from 'node:fs/promises';
import { cpus, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applicationKind, detectApplications, readRawConfig, repoPath, resolveConfig, type ApplicationInput, type AtlasConfig, type RawConfig } from '../core/config.js';
import { SCHEMA_VERSION, type SoftwareGraph } from '../core/graph.js';
import { analyzers, indexRepository } from '../pipeline/index.js';
import { ProjectionIndex } from '../projection/hierarchy.js';
import { emptyRegistry, extendRegistry, TIMELINE_LAYOUT_VERSION, type TimelineRegistry } from '../projection/layout.js';
import { canonicalJson, digest } from './fingerprint.js';
import { commitInfo, currentBranch, git, listCommits, renamedPaths, resolveCommit, TreeMirror, type CommitInfo } from './git.js';
import { computeLineage } from './lineage.js';
import type { SnapshotEntity } from './snapshot.js';
import { fetchGitHubPullRequests } from './pull-requests.js';
import { HISTORY_SCHEMA_VERSION, HistoryStore, type SnapshotRecord, type SnapshotStats } from './store.js';

export const HISTORY_DATABASE = 'history.db';
/** How applications are chosen at a revision; part of the snapshot identity. */
const APPLICATION_POLICY = 'configured-substitute-detected:3';

/**
 * Snapshot identity inputs other than the commit: the configuration as
 * written, the analyzers and schemas. Re-analyzing a commit under a
 * different identity creates a new snapshot rather than overwriting one.
 */
export function historyIdentity(raw: RawConfig): string {
  return digest(canonicalJson({
    history: HISTORY_SCHEMA_VERSION, graph: SCHEMA_VERSION, policy: APPLICATION_POLICY,
    analyzers: Object.fromEntries(analyzers.map(analyzer => [analyzer.name, analyzer.version])),
    config: { repository: raw.repository ?? null, applications: raw.applications ?? null, ignore: raw.ignore ?? [], maxFileBytes: raw.maxFileBytes ?? null },
  }), 24);
}
/** The configuration file of the state directory, with the repository identity pinned to the real checkout name. */
export async function historyConfig(root: string, stateDirectory: string): Promise<RawConfig> {
  const raw = await readRawConfig(stateDirectory);
  return { ...raw, repository: raw.repository ?? { name: path.basename(root) } };
}
export interface RevisionApplications {
  /** configured: every configured application exists; substituted: some live at another path then; detected: none configured exists. */
  source: 'configured' | 'substituted' | 'detected';
  /** Configured applications found at another path: name → path at this revision. */
  substituted: Record<string, string>;
  missing: string[];
}
/**
 * Applications move over time (e.g. api/ → backend/). At a revision,
 * configured applications whose directory exists are used. A configured
 * application that is missing is matched to the one autodetected application
 * of the same kind (primary framework, else ecosystem; see `applicationKind`),
 * keeping the configured *name*: application names are
 * part of symbol identities, so the same application keeps its entities
 * across the move. When nothing configured can be placed, the revision's
 * autodetected applications are used as they are.
 */
export async function revisionConfig(raw: RawConfig, root: string): Promise<{ config: AtlasConfig; applications: RevisionApplications }> {
  if (!Array.isArray(raw.applications)) return { config: await resolveConfig(root, raw), applications: { source: 'detected', substituted: {}, missing: [] } };
  const present: ApplicationInput[] = [], missing: ApplicationInput[] = [];
  for (const app of raw.applications) {
    let directory = false;
    try { directory = typeof app?.path === 'string' && (await lstat(repoPath(root, app.path))).isDirectory(); } catch { /* absent at this revision */ }
    (directory ? present : missing).push(app);
  }
  const substituted: Record<string, string> = {};
  if (missing.length) {
    const overlaps = (a: string, b: string) => a === b || a === '.' || b === '.' || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
    const detected = (await detectApplications(root, raw.repository?.name)).filter(app => !present.some(item => overlaps(item.path, app.path)));
    for (const app of [...missing]) {
      const kind = applicationKind(app);
      const sameKind = missing.filter(item => applicationKind(item) === kind), candidates = detected.filter(item => applicationKind(item) === kind);
      if (!kind || sameKind.length !== 1 || candidates.length !== 1) continue;
      present.push({ ...app, path: candidates[0]!.path });
      substituted[app.name] = candidates[0]!.path;
      missing.splice(missing.indexOf(app), 1);
    }
  }
  const config = await resolveConfig(root, { ...raw, applications: present.length ? present : undefined });
  const source = !present.length ? 'detected' : Object.keys(substituted).length ? 'substituted' : 'configured';
  return { config, applications: { source, substituted, missing: missing.map(app => app.name) } };
}
export interface AnalyzedCommit { sha: string; graph: SoftwareGraph; durationMs: number; applications: RevisionApplications }
export async function analyzeCommit(mirror: TreeMirror, raw: RawConfig, sha: string): Promise<AnalyzedCommit> {
  const started = performance.now();
  await mirror.checkout(sha);
  const { config, applications } = await revisionConfig(raw, mirror.directory);
  const graph = await indexRepository(mirror.directory, { config, revision: sha });
  return { sha, graph, durationMs: performance.now() - started, applications };
}

export type HistoryProgress =
  | { type: 'plan'; ref: string; head: string; timeline: number; targets: number; pending: number; jobs: number }
  | { type: 'indexed'; done: number; total: number; commit: CommitInfo; snapshot: SnapshotRecord }
  | { type: 'failed'; done: number; total: number; commit: CommitInfo; error: string }
  | { type: 'layout'; snapshots: number; rebuilt: boolean; durationMs: number }
  | { type: 'pull-requests'; count: number }
  | { type: 'warning'; message: string };
export interface HistoryIndexOptions {
  root: string; stateDirectory: string;
  ref?: string; firstParent?: boolean;
  /** Only the newest N commits of the timeline. */
  limit?: number;
  /** Only commits since this date (Git date syntax). */
  since?: string;
  /** Specific commits (full or abbreviated SHAs, or refs). */
  commits?: string[];
  /** Parallel analysis processes (default: up to 6). */
  jobs?: number;
  pullRequests?: 'github';
  onProgress?: (event: HistoryProgress) => void;
}
export interface HistoryIndexResult { ref: string; head: string; indexed: number; failed: number; skipped: number; snapshots: number }

export async function indexHistory(options: HistoryIndexOptions): Promise<HistoryIndexResult> {
  const root = await realpath(options.root);
  const top = await realpath((await git(root, ['rev-parse', '--show-toplevel'])).trim());
  if (top !== root) throw new Error(`History indexing needs the repository's top-level directory (${top})`);
  const raw = await historyConfig(root, options.stateDirectory);
  const identity = historyIdentity(raw);
  const history = new HistoryStore(path.join(options.stateDirectory, HISTORY_DATABASE));
  const progress = options.onProgress ?? (() => undefined);
  try {
    const ref = options.ref ?? await currentBranch(root) ?? 'HEAD';
    const firstParent = options.firstParent !== false;
    const head = await resolveCommit(root, ref);
    const timeline = await listCommits(root, { ref, firstParent });
    history.saveCommits(timeline);
    history.saveTimeline(ref, head, timeline.map(commit => commit.sha), firstParent);
    let targets = timeline;
    if (options.commits?.length) {
      const wanted: CommitInfo[] = [];
      for (const item of options.commits) {
        const sha = await resolveCommit(root, item);
        wanted.push(timeline.find(commit => commit.sha === sha) ?? await commitInfo(root, sha));
      }
      history.saveCommits(wanted);
      targets = [...new Map(wanted.map(commit => [commit.sha, commit])).values()];
    }
    if (options.since) { const recent = new Set((await listCommits(root, { ref, firstParent, since: options.since })).map(commit => commit.sha)); targets = targets.filter(commit => recent.has(commit.sha)); }
    if (options.limit !== undefined) targets = targets.slice(-options.limit);
    const pending = targets.filter(commit => !history.hasSnapshot(commit.sha, identity));
    const jobs = Math.max(1, Math.min(pending.length, options.jobs ?? Math.min(6, Math.max(1, Math.floor(cpus().length / 2)))));
    progress({ type: 'plan', ref, head, timeline: timeline.length, targets: targets.length, pending: pending.length, jobs });
    let done = 0, failed = 0;
    const save = (result: AnalyzedCommit) => {
      const commit = pending.find(item => item.sha === result.sha)!;
      try {
        const snapshot = history.saveSnapshot(result.graph, identity, { durationMs: result.durationMs, applicationSource: result.applications.source, substitutedApplications: result.applications.substituted, missingApplications: result.applications.missing });
        progress({ type: 'indexed', done: ++done, total: pending.length, commit, snapshot });
      } catch (error) { failed++; progress({ type: 'failed', done: ++done, total: pending.length, commit, error: error instanceof Error ? error.message : String(error) }); }
    };
    const fail = (sha: string, error: string) => { failed++; progress({ type: 'failed', done: ++done, total: pending.length, commit: pending.find(item => item.sha === sha)!, error }); };
    if (jobs === 1) await analyzeInProcess(root, raw, pending.map(commit => commit.sha), save, fail);
    else await analyzeInWorkers(root, raw, pending.map(commit => commit.sha), jobs, save, fail);
    const layout = await updateLayoutRegistry(history, root, timeline.map(commit => commit.sha), identity);
    progress({ type: 'layout', ...layout });
    if (options.pullRequests === 'github') {
      try { const records = await fetchGitHubPullRequests(root, { since: timeline[0]?.committedAt }); history.savePullRequests(records); progress({ type: 'pull-requests', count: records.length }); }
      catch (error) { progress({ type: 'warning', message: `Pull request metadata unavailable: ${error instanceof Error ? error.message : String(error)}` }); }
    }
    return { ref, head, indexed: done - failed, failed, skipped: targets.length - pending.length, snapshots: history.snapshots().length };
  } finally { history.close(); }
}

async function scratch(): Promise<string> { return realpath(await mkdtemp(path.join(tmpdir(), 'archipelago-history-'))); }
async function analyzeInProcess(root: string, raw: RawConfig, shas: string[], save: (result: AnalyzedCommit) => void, fail: (sha: string, error: string) => void): Promise<void> {
  const directory = await scratch();
  const mirror = new TreeMirror(root, path.join(directory, 'tree'));
  try {
    for (const sha of shas) {
      try { save(await analyzeCommit(mirror, raw, sha)); }
      catch (error) { fail(sha, error instanceof Error ? error.message : String(error)); }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
}
/** Node options for child processes: loaders and experimental flags, never test-runner options. */
export function childExecArgv(): string[] { return process.execArgv.filter(arg => !arg.startsWith('--test') && !arg.startsWith('--watch')); }
const WORKER = fileURLToPath(new URL(`./worker${path.extname(fileURLToPath(import.meta.url))}`, import.meta.url));
export type WorkerMessage = { type: 'result'; result: AnalyzedCommit } | { type: 'error'; sha: string; message: string } | { type: 'done' };
export interface WorkerJob { root: string; directory: string; raw: RawConfig; commits: string[] }
/** Contiguous chunks keep each worker's tree mirror applying small diffs. */
async function analyzeInWorkers(root: string, raw: RawConfig, shas: string[], jobs: number, save: (result: AnalyzedCommit) => void, fail: (sha: string, error: string) => void): Promise<void> {
  const size = Math.ceil(shas.length / jobs);
  const chunks = Array.from({ length: jobs }, (_, i) => shas.slice(i * size, (i + 1) * size)).filter(chunk => chunk.length);
  await Promise.all(chunks.map(async commits => {
    const directory = await scratch();
    const remaining = new Set(commits);
    try {
      await new Promise<void>(resolve => {
        const child = fork(WORKER, [], { execArgv: childExecArgv(), serialization: 'advanced', stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
        child.on('message', (message: WorkerMessage) => {
          if (message.type === 'result') { remaining.delete(message.result.sha); save(message.result); }
          else if (message.type === 'error') { remaining.delete(message.sha); fail(message.sha, message.message); }
        });
        child.on('exit', code => { for (const sha of remaining) fail(sha, `Analysis process exited (${code ?? 'signal'})`); remaining.clear(); resolve(); });
        child.send({ root, directory: path.join(directory, 'tree'), raw, commits } satisfies WorkerJob);
      });
    } finally { await rm(directory, { recursive: true, force: true }); }
  }));
}

/**
 * The timeline slot registry (see projection/layout.ts): every container's
 * children in first-appearance order along the timeline, with their largest
 * sizes, so one union layout gives every entity a fixed place in history.
 * Consecutive snapshots are linked by lineage, so a renamed or moved entity
 * inherits its predecessor's slot. Appending newer commits extends the
 * registry; anything else rebuilds it.
 */
export async function updateLayoutRegistry(history: HistoryStore, root: string | undefined, timeline: string[], identity?: string): Promise<{ snapshots: number; rebuilt: boolean; durationMs: number }> {
  const started = performance.now();
  const chosen = history.snapshotsByCommit(identity);
  const ordered = timeline.map(sha => chosen.get(sha)).filter((item): item is SnapshotRecord => !!item);
  const existing = history.layoutRegistry();
  const prefix = !!existing && existing.state.version === TIMELINE_LAYOUT_VERSION && existing.snapshots.length <= ordered.length && existing.snapshots.every((id, i) => ordered[i]!.id === id);
  const registry: TimelineRegistry = prefix ? existing!.state : emptyRegistry();
  const start = prefix ? existing!.snapshots.length : 0;
  let previous: { record: SnapshotRecord; entities: SnapshotEntity[] } | undefined = start > 0 ? { record: ordered[start - 1]!, entities: history.entities(ordered[start - 1]!.seq) } : undefined;
  for (const snapshot of ordered.slice(start)) {
    const entities = history.entities(snapshot.seq);
    if (previous) {
      let renames = new Map<string, string>();
      if (root) try { renames = await renamedPaths(root, previous.record.commitSha, snapshot.commitSha); } catch { /* names and fingerprints still apply */ }
      for (const [from, to] of computeLineage(previous.entities, entities, renames).forward) if (registry.nodes[to] === undefined && registry.alias[to] === undefined) registry.alias[to] = registry.alias[from] ?? from;
    }
    const index = new ProjectionIndex(snapshot.id, entities, [], []);
    extendRegistry(registry, index.layoutNodes(), index.rootId);
    previous = { record: snapshot, entities };
  }
  if (start < ordered.length || !prefix) history.saveLayoutRegistry(ordered.map(item => item.id), registry);
  return { snapshots: ordered.length, rebuilt: !prefix, durationMs: Math.round(performance.now() - started) };
}
export type { SnapshotStats };
