import type { AtlasConfig, ApplicationConfig } from './config.js';
import type { GraphBuilder, Evidence } from './graph.js';
export interface ScannedFile { path: string; absolutePath: string; id: string; language?: string; analyzable: boolean; application?: ApplicationConfig }
export interface HttpObservation { callerId: string; fileId: string; method?: string; url?: string; expression: string; evidence: Evidence }
export interface AnalysisContext {
  root: string; config: AtlasConfig; graph: GraphBuilder; repositoryId: string;
  applicationIds: Map<string, string>; files: Map<string, ScannedFile>; http: HttpObservation[];
  /** Commit whose tree was materialized at `root` (tracked files only). Absent for a working-tree scan. */
  revision?: string;
}
export interface Analyzer { name: string; version: string; analyze(context: AnalysisContext): Promise<void> }
