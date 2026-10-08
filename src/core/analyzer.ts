import type { AtlasConfig, ApplicationConfig } from './config.js';
import type { GraphBuilder, Evidence, EffectFact } from './graph.js';
import type { AnalysisCache } from '../pipeline/cache.js';
import type { IndexedSources } from '../analysis/indexed-sources.js';
import type { ProjectCatalog } from '../analysis/project-model.js';
import type { TypeScriptServices } from '../analysis/languages/typescript-services.js';
import type { StructureFacts } from '../analysis/facts.js';
import type { PythonResolver } from '../analysis/resolution/python.js';
import type { EmbeddedSources } from '../analysis/embedded/index.js';
import type { EmbeddedRegion } from '../analysis/embedded/source.js';
export interface ScannedFile { path: string; absolutePath: string; id: string; language?: string; analyzable: boolean; application?: ApplicationConfig; embedded?: EmbeddedRegion }
export interface HttpObservation {
  callerId: string; fileId: string; method?: string; url?: string; expression: string; evidence: Evidence;
  /** A URL built from a proven base: target application, path pattern and the proof hops. */
  resolved?: { app?: string; relative: boolean; pattern: string; holes: number; proof: Evidence[]; display: string };
  /** The caller's network effect; the matcher records the endpoint it reaches. */
  effect?: EffectFact;
}
export interface AnalysisContext {
  root: string; config: AtlasConfig; graph: GraphBuilder; repositoryId: string;
  applicationIds: Map<string, string>; files: Map<string, ScannedFile>; http: HttpObservation[];
  /** Commit whose tree was materialized at `root` (tracked files only). Absent for a working-tree scan. */
  revision?: string;
  /** Persistent cache of analyzer work (working-tree indexing with a state directory). */
  cache?: AnalysisCache;
  sources?: IndexedSources;
  projects?: ProjectCatalog;
  typescript?: TypeScriptServices;
  /** Serializable syntax facts and exact declaration sites for language services. */
  syntax?: Map<string, { facts: StructureFacts; declarations: Map<string, string> }>;
  python?: PythonResolver;
  embedded?: EmbeddedSources;
}
export interface Analyzer { name: string; version: string; analyze(context: AnalysisContext): Promise<void> }
