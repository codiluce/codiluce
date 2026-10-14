import { getHeapStatistics } from 'node:v8';
import { typescriptAnalyzer } from './typescript.js';
import { typescriptFrameworkPacks } from '../analysis/frameworks/index.js';
import { EmbeddedSources } from '../analysis/embedded/index.js';
import { IndexedSources } from '../analysis/indexed-sources.js';
import { GraphBuilder, validateGraph } from '../core/graph.js';
import type { AnalysisContext } from '../core/analyzer.js';
import { AnalysisCache, captureGraphPatch } from '../pipeline/cache.js';
import { TYPESCRIPT_WORKER_PROTOCOL, type TypeScriptWorkerRequest, type TypeScriptWorkerResult } from './ts-worker-protocol.js';

/** This entry point runs only Codiluce's analyzers over hash-validated inputs. */
export async function analyzeTypeScriptWorker(request: TypeScriptWorkerRequest): Promise<TypeScriptWorkerResult> {
  if (request.protocol !== TYPESCRIPT_WORKER_PROTOCOL || JSON.stringify(request.packs) !== JSON.stringify(typescriptFrameworkPacks.map(pack => [pack.id, pack.version]))) throw Error('Unsupported TypeScript worker or framework registry');
  const graph = new GraphBuilder(request.graph.namespace);
  for (const entity of request.graph.entities) graph.entities.set(entity.id, entity);
  for (const relation of request.graph.relations) graph.relations.set(relation.id, relation);
  for (const diagnostic of request.graph.diagnostics) graph.diagnostics.set(diagnostic.id, diagnostic);
  const context: AnalysisContext = { ...request.context, graph, sourceReads: new Set() };
  context.sources = new IndexedSources(context);
  for (const [file, reason] of request.sourceFailures) context.sources.failures.set(file, reason);
  if (request.embedded) context.embedded = EmbeddedSources.fromSnapshot(context, request.embedded);
  if (request.cache) context.cache = new AnalysisCache(request.cache.directory, request.cache.limits);
  try {
    const patch = await captureGraphPatch(context, () => typescriptAnalyzer.analyze(context));
    validateGraph({ schemaVersion: 1, run: { repositoryId: context.repositoryId } as never, entities: [...graph.entities.values()], relations: [...graph.relations.values()], diagnostics: [...graph.diagnostics.values()] });
    return { protocol: TYPESCRIPT_WORKER_PROTOCOL, patch, sourceReads: [...context.sourceReads!], typescriptFiles: context.typescript?.projects.flatMap(project => project.inputs.map(file => file.path)) ?? [], sourceFailures: [...context.sources.failures], cacheEvents: context.cache?.events ?? [], usage: { pid: process.pid, heapLimitBytes: getHeapStatistics().heap_size_limit, heapUsedBytes: process.memoryUsage().heapUsed, maxRssKiB: process.resourceUsage().maxRSS } };
  } finally {
    context.typescript?.releasePrograms();
    await context.templateFrameworks?.closeAndWait();
  }
}
