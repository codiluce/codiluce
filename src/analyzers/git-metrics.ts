// Per-file Git metrics of the working-tree index: how many commits changed a
// file, how many distinct authors, how many lines were added and deleted in
// total (churn), and when and in which commit it last changed.
//
// One `git log --numstat` pass over the newest commits (bounded), newest
// first, read as a stream. Renames are followed: history recorded under an
// older path is credited to the file's current path. Merge commits are not
// counted (their changes are counted in the commits they merge). Metrics
// describe committed history only: uncommitted edits are not in them, and a
// file never committed has none ("not measured", never zero). History
// snapshots (`revision`) skip this analyzer: they index one commit's tree.
import { execFile, spawn } from 'node:child_process';
import { ANALYZER_VERSION } from '../core/graph.js';
import type { Analyzer, AnalysisContext } from '../core/analyzer.js';

/** Commits read at most; older history is left out (and said so). */
export const GIT_METRICS_MAX_COMMITS = 10_000;
export interface FileGitMetrics { commits: number; authors: number; churn: number; lastChangedAt: string; lastCommit: string }

export const gitMetricsAnalyzer: Analyzer = {
  name: 'git-metrics', version: ANALYZER_VERSION,
  async analyze(context: AnalysisContext): Promise<void> {
    if (context.revision) return;
    const { graph } = context;
    let result: { metrics: Map<string, FileGitMetrics>; commits: number };
    try {
      // Committed history only: one HEAD always gives the same metrics.
      const head = await headOf(context.root);
      const read = async () => { const value = await readGitMetrics(context.root, GIT_METRICS_MAX_COMMITS); return { metrics: [...value.metrics], commits: value.commits }; };
      const value = context.cache ? await context.cache.value('git-metrics', 'repository', { head, root: context.root, max: GIT_METRICS_MAX_COMMITS }, read) : await read();
      result = { metrics: new Map(value.metrics), commits: value.commits };
    }
    catch (error) {
      graph.diagnose({ analyzer: 'git-metrics', severity: 'info', code: 'git-metrics-unavailable', reason: `No per-file Git metrics: ${error instanceof Error ? error.message : String(error)}` });
      return;
    }
    if (result.commits >= GIT_METRICS_MAX_COMMITS) graph.diagnose({ analyzer: 'git-metrics', severity: 'info', code: 'git-metrics-truncated', reason: `Per-file Git metrics cover the newest ${GIT_METRICS_MAX_COMMITS} commits; older history is not counted` });
    for (const file of context.files.values()) {
      const metrics = result.metrics.get(file.path);
      const entity = graph.entities.get(file.id);
      if (metrics && entity) entity.metrics = { ...entity.metrics, ...metrics };
    }
  },
};

function headOf(root: string): Promise<string> {
  return new Promise((resolve, reject) => execFile('git', ['rev-parse', 'HEAD'], { cwd: root }, (error, stdout) => error ? reject(new Error('no Git HEAD')) : resolve(stdout.trim())));
}
/** Stream `git log` and fold it into per-path metrics under each file's current path. */
export function readGitMetrics(root: string, maxCommits: number): Promise<{ metrics: Map<string, FileGitMetrics>; commits: number }> {
  return new Promise((resolve, reject) => {
    // --relative: paths relative to the scanned root, which may be a subdirectory of the Git work tree.
    const child = spawn('git', ['-c', 'core.quotepath=off', 'log', '--no-merges', '-M', '--numstat', '-z', '--relative', `--max-count=${maxCommits}`, '--format=%x1e%H%x1f%aI%x1f%aE', 'HEAD', '--'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    const totals = new Map<string, { commits: number; authors: Set<string>; churn: number; lastChangedAt: string; lastCommit: string }>();
    /** Historical path → the path its content has now. */
    const alias = new Map<string, string>();
    let buffer = '', commits = 0, errors = '';
    const credit = (path: string, added: number, deleted: number, commit: { sha: string; date: string; author: string }) => {
      const current = alias.get(path) ?? path;
      let entry = totals.get(current);
      if (!entry) { entry = { commits: 0, authors: new Set(), churn: 0, lastChangedAt: commit.date, lastCommit: commit.sha }; totals.set(current, entry); }
      entry.commits++; entry.authors.add(commit.author); entry.churn += added + deleted;
      return current;
    };
    const record = (chunk: string) => {
      const header = chunk.indexOf('\0');
      if (header < 0) return;
      const [sha, date, author] = chunk.slice(0, header).split('\x1f');
      if (!sha || !date) return;
      commits++;
      const commit = { sha, date, author: (author ?? '').toLowerCase() };
      const tokens = chunk.slice(header + 1).split('\0');
      for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index]!.replace(/^\n/, '');
        if (!token) continue;
        const match = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(token);
        if (!match) continue;
        const added = match[1] === '-' ? 0 : Number(match[1]), deleted = match[2] === '-' ? 0 : Number(match[2]);
        if (match[3]) { credit(match[3], added, deleted, commit); continue; }
        // A rename: the old and new paths follow as their own tokens.
        const from = tokens[++index], to = tokens[++index];
        if (from === undefined || to === undefined) break;
        const current = credit(to, added, deleted, commit);
        if (!alias.has(from)) alias.set(from, current);
      }
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
      const metrics = new Map<string, FileGitMetrics>();
      for (const [path, entry] of totals) metrics.set(path, { commits: entry.commits, authors: entry.authors.size, churn: entry.churn, lastChangedAt: entry.lastChangedAt, lastCommit: entry.lastCommit });
      resolve({ metrics, commits });
    });
  });
}
