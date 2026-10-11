import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { AnalysisContext } from '../core/analyzer.js';

export const SOURCE_MEMO_MAX_BYTES = 32 * 1024 * 1024;
export const SOURCE_MEMO_MAX_ENTRIES = 4096;
export interface SourceMemoOptions { maxBytes?: number; maxEntries?: number }

/** The repository I/O boundary for resolvers. Existence checks consult the
 * scan, never the disk; reads require an indexed, readable, unchanged file.
 * Compiler-owned standard libraries are handled separately by their host. */
export class IndexedSources {
  private readonly texts = new Map<string, string>();
  private bytes = 0;
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private bypasses = 0;
  private readonly maxBytes: number;
  private readonly maxEntries: number;
  private readonly directories = new Set<string>(['.']);
  readonly failures = new Map<string, string>();
  constructor(private readonly context: Pick<AnalysisContext, 'root' | 'files' | 'config' | 'graph' | 'sourceReads'>, options: SourceMemoOptions = {}) {
    this.maxBytes = options.maxBytes ?? SOURCE_MEMO_MAX_BYTES;
    this.maxEntries = options.maxEntries ?? SOURCE_MEMO_MAX_ENTRIES;
    for (const limit of [this.maxBytes, this.maxEntries]) if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('Source memo limits must be non-negative safe integers');
    for (const relative of context.files.keys()) {
      let directory = path.posix.dirname(relative);
      while (!this.directories.has(directory)) { this.directories.add(directory); directory = path.posix.dirname(directory); }
    }
  }
  /** Conservative UTF-16 text + key payload accounting, not a process RSS cap.
   * Entry count separately bounds Map/object overhead. Callers may retain text
   * or compiler trees independently; eviction never changes the input limit. */
  memoStats() { return { bytes: this.bytes, entries: this.texts.size, maxBytes: this.maxBytes, maxEntries: this.maxEntries, hits: this.hits, misses: this.misses, evictions: this.evictions, bypasses: this.bypasses }; }
  clear(): void { this.texts.clear(); this.bytes = 0; }
  private forget(file: string): void {
    const text = this.texts.get(file);
    if (text !== undefined) { this.bytes -= 2 * (file.length + text.length); this.texts.delete(file); }
  }
  private remember(file: string, text: string): void {
    const cost = 2 * (file.length + text.length);
    if (cost > this.maxBytes || !this.maxEntries) { this.bypasses++; return; }
    while (this.texts.size >= this.maxEntries || this.bytes + cost > this.maxBytes) {
      this.forget(this.texts.keys().next().value!); this.evictions++;
    }
    this.texts.set(file, text); this.bytes += cost;
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
  readText(fileName: string, options: { revalidate?:boolean } = {}): string {
    const relative = this.relative(fileName), file = relative === undefined ? undefined : this.context.files.get(relative);
    if (!file?.analyzable) throw new Error(`Source is not an indexed readable file: ${relative ?? 'outside repository'}`);
    this.context.sourceReads?.add(file.path);
    const cached = this.texts.get(file.path);
    if (cached !== undefined && !options.revalidate) {
      this.hits++; this.texts.delete(file.path); this.texts.set(file.path, cached); return cached;
    }
    this.misses++;
    // A forced validation must not leave a stale memo available after failure.
    this.forget(file.path);
    const expected = path.join(this.context.root, ...file.path.split('/'));
    const resolved = realpathSync(expected), info = lstatSync(expected);
    if (resolved !== expected || !info.isFile()) throw new Error(`Source became a symlink or non-file: ${file.path}`);
    if (info.size > this.context.config.maxFileBytes) throw new Error(`Source exceeds maxFileBytes: ${file.path}`);
    const buffer = readFileSync(expected);
    if (buffer.length > this.context.config.maxFileBytes || buffer.includes(0)) throw new Error(`Source became oversized or binary: ${file.path}`);
    const indexedHash = this.context.graph.entities.get(file.id)?.metadata.contentHash;
    if (typeof indexedHash === 'string' && createHash('sha256').update(buffer).digest('hex') !== indexedHash) throw new Error(`Source changed after the scan: ${file.path}`);
    const text = buffer.toString('utf8'); this.remember(file.path, text); return text;
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
