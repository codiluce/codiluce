import { randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, type AtlasConfig } from '../core/config.js';
import { GraphBuilder, SCHEMA_VERSION, type AnalysisRun, type SoftwareGraph } from '../core/graph.js';
import type { AnalysisContext, Analyzer } from '../core/analyzer.js';
import { filesystemAnalyzer } from '../analyzers/filesystem.js';
import { gitMetricsAnalyzer } from '../analyzers/git-metrics.js';
import { typescriptAnalyzer } from '../analyzers/typescript.js';
import { laravelAnalyzer } from '../analyzers/laravel.js';
import { apiMatcher } from './api-matcher.js';
import { inertiaLinker } from './inertia-linker.js';
import { AnalysisCache, type CacheEvent } from './cache.js';

const execute = promisify(execFile);
export const analyzers: Analyzer[] = [filesystemAnalyzer, gitMetricsAnalyzer, typescriptAnalyzer, laravelAnalyzer, inertiaLinker, apiMatcher];
export interface IndexOptions {
  stateDirectory?: string; config?: AtlasConfig; onProgress?: (name: string) => void;
  /** Index a materialized commit tree: Git is not consulted and the run records this commit, clean. */
  revision?: string;
  /** Reuse unchanged analyzer work: a cache directory (or cache). Ignored for revisions. */
  cache?: string | AnalysisCache;
  onCache?: (event: CacheEvent) => void;
}
export async function indexRepository(repository: string, options: IndexOptions = {}): Promise<SoftwareGraph> {
  const root = await realpath(repository);
  const config = options.config ?? await loadConfig(root, options.stateDirectory ?? path.join(root, '.codiluce'));
  const graph = new GraphBuilder(config.repository.id ?? config.repository.name);
  const repositoryId = graph.id('repository');
  const cache = options.revision || !options.cache ? undefined : typeof options.cache === 'string' ? new AnalysisCache(options.cache, undefined, options.onCache) : options.cache;
  const context: AnalysisContext = { root, config, graph, repositoryId, applicationIds: new Map(), files: new Map(), http: [], ...(options.revision ? { revision: options.revision } : {}), ...(cache ? { cache } : {}) };
  let commitSha: string | undefined, dirty: boolean | undefined;
  if (options.revision) { commitSha = options.revision; dirty = false; }
  else try {
    const [commit, status] = await Promise.all([
      execute('git', ['rev-parse', 'HEAD'], { cwd: root }),
      execute('git', ['status', '--porcelain', '-z', '--untracked-files=normal'], { cwd: root, maxBuffer: 16 * 1024 * 1024 }),
    ]);
    commitSha = commit.stdout.trim(); dirty = status.stdout.length > 0;
  } catch {
    graph.diagnose({ analyzer: 'indexer', severity: 'info', code: 'git-metadata-unavailable', reason: 'No readable Git HEAD/status; this is still a valid working-tree scan' });
  }
  for (const analyzer of analyzers) { options.onProgress?.(analyzer.name); await analyzer.analyze(context); }
  const run: AnalysisRun = { id: randomUUID(), repositoryId, repositoryName: config.repository.name, ...(commitSha ? { commitSha } : {}), ...(dirty !== undefined ? { dirty } : {}), analyzedAt: new Date().toISOString(), configDigest: createHash('sha256').update(JSON.stringify(config)).digest('hex'), schemaVersion: SCHEMA_VERSION, analyzerVersions: Object.fromEntries(analyzers.map(analyzer => [analyzer.name, analyzer.version])) };
  return graph.finish(run);
}
