import type { AnalysisContext } from '../core/analyzer.js';
import type { Entity, Relation, Diagnostic } from '../core/graph.js';
import type { EmbeddedSnapshot } from '../analysis/embedded/index.js';
import type { CacheEvent, CacheLimits, GraphPatch } from '../pipeline/cache.js';

/** Limits on the default indexer's compiler address space and IPC payloads.
 * Old space is not total RSS: Buffers, native parsers and young space differ. */
export const TYPESCRIPT_WORKER_LIMITS = Object.freeze({ oldSpaceMiB: 1024, semiSpaceMiB: 16, maxMessageBytes: 64 * 1024 * 1024, maxStderrBytes: 64 * 1024 });
export const TYPESCRIPT_WORKER_PROTOCOL = 3;
export interface TypeScriptWorkerRequest {
  protocol: number;
  context: Pick<AnalysisContext, 'root' | 'config' | 'repositoryId' | 'applicationIds' | 'files' | 'http' | 'revision' | 'directoryInventory' | 'scannedDirectories' | 'fileInventory'>;
  graph: { namespace: string; entities: Entity[]; relations: Relation[]; diagnostics: Diagnostic[] };
  embedded?: EmbeddedSnapshot;
  prepareEmbedded?: boolean;
  sourceFailures: [string, string][];
  cache?: { directory: string; limits: CacheLimits };
  packs: [string, string][];
}
export interface TypeScriptWorkerResult {
  protocol: number;
  patch: GraphPatch;
  sourceReads: string[];
  typescriptFiles: string[];
  sourceFailures: [string, string][];
  cacheEvents: CacheEvent[];
  usage: { pid: number; heapLimitBytes: number; heapUsedBytes: number; maxRssKiB: number };
}
