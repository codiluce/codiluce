import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { AnalysisContext } from '../core/analyzer.js';

/** The repository I/O boundary for resolvers. Existence checks consult the
 * scan, never the disk; reads require an indexed, readable, unchanged file.
 * Compiler-owned standard libraries are handled separately by their host. */
export class IndexedSources {
  private readonly texts = new Map<string, string>();
  private readonly directories = new Set<string>(['.']);
  readonly failures = new Map<string, string>();
  constructor(private readonly context: Pick<AnalysisContext, 'root' | 'files' | 'config' | 'graph'>) {
    for (const relative of context.files.keys()) {
      let directory = path.posix.dirname(relative);
      while (!this.directories.has(directory)) { this.directories.add(directory); directory = path.posix.dirname(directory); }
    }
  }
  private relative(fileName: string): string | undefined {
    if (fileName.includes('\0')) return undefined;
    const absolute = path.resolve(this.context.root, fileName);
    const relative = path.relative(this.context.root, absolute).split(path.sep).join('/') || '.';
    return relative === '..' || relative.startsWith('../') || path.isAbsolute(relative) ? undefined : relative;
  }
  fileExists = (fileName: string): boolean => {
    const relative = this.relative(fileName);
    return relative !== undefined && !!this.context.files.get(relative)?.analyzable;
  };
  directoryExists = (directory: string): boolean => {
    const relative = this.relative(directory);
    return relative !== undefined && this.directories.has(relative);
  };
  getDirectories = (directory: string): string[] => {
    const relative = this.relative(directory);
    return relative === undefined ? [] : [...this.directories].filter(item => item !== relative && path.posix.dirname(item) === relative).map(item => path.posix.basename(item)).sort();
  };
  readText(fileName: string): string {
    const relative = this.relative(fileName), file = relative === undefined ? undefined : this.context.files.get(relative);
    if (!file?.analyzable) throw new Error(`Source is not an indexed readable file: ${relative ?? 'outside repository'}`);
    const cached = this.texts.get(file.path);
    if (cached !== undefined) return cached;
    const expected = path.join(this.context.root, ...file.path.split('/'));
    const resolved = realpathSync(expected), info = lstatSync(expected);
    if (resolved !== expected || !info.isFile()) throw new Error(`Source became a symlink or non-file: ${file.path}`);
    if (info.size > this.context.config.maxFileBytes) throw new Error(`Source exceeds maxFileBytes: ${file.path}`);
    const buffer = readFileSync(expected);
    if (buffer.length > this.context.config.maxFileBytes || buffer.includes(0)) throw new Error(`Source became oversized or binary: ${file.path}`);
    const indexedHash = this.context.graph.entities.get(file.id)?.metadata.contentHash;
    if (typeof indexedHash === 'string' && createHash('sha256').update(buffer).digest('hex') !== indexedHash) throw new Error(`Source changed after the scan: ${file.path}`);
    const text = buffer.toString('utf8'); this.texts.set(file.path, text); return text;
  }
  /** TypeScript's synchronous host treats denied reads as unavailable. Keep
   * the reason so the analyzer can report races/read failures explicitly. */
  readFile = (fileName: string): string | undefined => {
    if (!this.fileExists(fileName)) return undefined;
    try { return this.readText(fileName); }
    catch (error) { const relative = this.relative(fileName)!; this.failures.set(relative, error instanceof Error ? error.message : String(error)); return undefined; }
  };
  readonly moduleHost = {
    fileExists: this.fileExists, readFile: this.readFile, directoryExists: this.directoryExists,
    getDirectories: this.getDirectories, realpath: (fileName: string) => fileName,
    getCurrentDirectory: () => this.context.root,
  };
}
