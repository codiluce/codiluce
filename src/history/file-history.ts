// Git-only evolution. Source is never materialized or passed to an analyzer.
// Cache first-parent file deltas by commit; an appended HEAD reads only new commits.
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_IGNORES, matchesGlob } from '../core/config.js';
import { GraphBuilder } from '../core/graph.js';
import { languageOf } from '../core/languages.js';
import type { EvolutionResponse, GitCommitChanges, GitFileChange } from '../projection/dto.js';
import { computeEvolution } from '../projection/evolution.js';
import { ProjectionIndex } from '../projection/hierarchy.js';
import { emptyRegistry, extendRegistry, timelineLayout, type LayoutNode } from '../projection/layout.js';
import { git, type CommitInfo } from './git.js';
import type { SnapshotEntity } from './snapshot.js';

const VERSION = 1, MAX_CACHE_BYTES = 64 * 1024 * 1024, LOG_BATCH_COMMITS = 250;
type Cache = { version: number; root: string; entries: GitCommitChanges[] };
function validGitPath(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && !path.posix.isAbsolute(value) && !value.includes('\0') && !value.split('/').some(part => part === '..' || part === '.'); }
export function ignoredHistoryPath(relative: string, ignore: string[]): boolean {
  if (!validGitPath(relative)) return true;
  const patterns = [...DEFAULT_IGNORES, ...ignore];
  for (let current = relative; current !== '.'; current = path.posix.dirname(current)) if (patterns.some(glob => matchesGlob(current, glob))) return true;
  return false;
}
export function summarizeFiles(files: GitFileChange[]): GitCommitChanges['summary'] {
  const result = { files: files.length, added: 0, modified: 0, removed: 0, moved: 0, insertions: 0, deletions: 0, binary: 0 };
  for (const file of files) { result[file.status]++; result.insertions += file.added; result.deletions += file.deleted; if (file.binary) result.binary++; }
  return result;
}

/** NUL records keep tabs/newlines and rename paths intact. Raw records supply status, modes and blob IDs. */
export function parseFileLog(output: string): GitCommitChanges[] {
  const result: GitCommitChanges[] = [];
  const tokens = output.split('\0');
  let current: GitCommitChanges | undefined, byPath = new Map<string, GitFileChange>();
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!.replace(/^\n+/, '');
    if (/^COMMIT:[0-9a-f]{40}$/.test(token)) {
      current = { sha: token.slice(7), files: [], summary: summarizeFiles([]) };
      result.push(current); byPath = new Map();
    } else if (current && token.startsWith(':')) {
      const match = /^:\d{6} (\d{6}) [0-9a-f]{40} ([0-9a-f]{40}) ([A-Z])\d*$/.exec(token);
      if (!match) throw new Error('Invalid Git file change record');
      const original = tokens[++i]!;
      const moved = match[3] === 'R' || match[3] === 'C';
      const target = moved ? tokens[++i]! : original;
      const file: GitFileChange = { path: target, ...(match[3] === 'R' ? { from: original } : {}), status: match[3] === 'A' || match[3] === 'C' ? 'added' : match[3] === 'D' ? 'removed' : match[3] === 'R' ? 'moved' : 'modified', blob: match[2]!, mode: match[1]!, added: 0, deleted: 0, binary: false };
      current.files.push(file); byPath.set(target, file);
    } else if (current) {
      const match = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(token);
      if (!match) continue;
      let target = match[3]!;
      if (!target) { i++; target = tokens[++i]!; }
      const file = byPath.get(target);
      if (!file) throw new Error('Git line counts have no corresponding file change');
      file.binary = match[1] === '-'; file.added = Number(match[1]) || 0; file.deleted = Number(match[2]) || 0;
    }
  }
  for (const entry of result) entry.summary = summarizeFiles(entry.files);
  return result;
}

export class FileHistory {
  private entries = new Map<string, GitCommitChanges>();
  private loaded = false;
  private pending?: Promise<void>;
  constructor(private readonly root: string, private readonly stateDirectory?: string, private readonly readOnly = false) {}
  async load(commits: CommitInfo[]): Promise<Map<string, GitCommitChanges>> {
    // Serialize cache refreshes from timeline polling, detail and playback requests.
    if (this.pending) { await this.pending; return this.load(commits); }
    this.pending = this.refresh(commits);
    try { await this.pending; return this.entries; } finally { this.pending = undefined; }
  }
  private async refresh(commits: CommitInfo[]): Promise<void> {
    const file = this.stateDirectory && path.join(this.stateDirectory, 'git-file-history.json');
    if (!this.loaded) {
      this.loaded = true;
      if (file) try {
        if ((await stat(file)).size <= MAX_CACHE_BYTES) {
          const cached = JSON.parse(await readFile(file, 'utf8')) as Cache;
          if (cached.version === VERSION && cached.root === this.root && Array.isArray(cached.entries) && cached.entries.every(entry => /^[0-9a-f]{40}$/.test(entry.sha) && Array.isArray(entry.files) && entry.files.every(change => validGitPath(change.path) && (change.from === undefined || validGitPath(change.from)) && /^[0-9a-f]{40}$/.test(change.blob) && /^\d{6}$/.test(change.mode) && ['added','modified','removed','moved'].includes(change.status) && typeof change.binary === 'boolean' && Number.isSafeInteger(change.added) && change.added >= 0 && Number.isSafeInteger(change.deleted) && change.deleted >= 0))) {
            this.entries = new Map(cached.entries.map(entry => [entry.sha, { ...entry, summary: summarizeFiles(entry.files) }]));
          }
        }
      } catch { /* Missing/corrupt cache is recomputed from Git. */ }
    }
    const missing = commits.filter(commit => !this.entries.has(commit.sha));
    if (!missing.length) return;
    // In ordinary use the missing commits form a suffix. For rewrites/branch switches
    // read the line again; never assume a cached HEAD is still an ancestor.
    const firstMissing = commits.findIndex(commit => !this.entries.has(commit.sha));
    const suffix = commits.slice(firstMissing);
    // Bound each Git response independently of the length of the complete history.
    for (let offset = 0; offset < suffix.length; offset += LOG_BATCH_COMMITS) {
      const batch = suffix.slice(offset, offset + LOG_BATCH_COMMITS);
      const output = await git(this.root, ['log', '--first-parent', '--diff-merges=first-parent', '--root', '--no-ext-diff', '--no-textconv', '--raw', '--numstat', '--no-abbrev', '-M', '-z', '--format=%x00COMMIT:%H', `--max-count=${batch.length}`, batch.at(-1)!.sha, '--']);
      for (const entry of parseFileLog(output)) this.entries.set(entry.sha, entry);
    }
    this.entries = new Map(commits.map(commit => {
      const entry = this.entries.get(commit.sha);
      if (!entry) throw new Error(`Git changes unavailable for ${commit.sha}`);
      return [commit.sha, entry];
    }));
    if (file && !this.readOnly) try {
      const json = JSON.stringify({ version: VERSION, root: this.root, entries: [...this.entries.values()] } satisfies Cache);
      if (Buffer.byteLength(json) <= MAX_CACHE_BYTES) {
        await mkdir(path.dirname(file), { recursive: true });
        const temporary = `${file}.${process.pid}.tmp`;
        await writeFile(temporary, json); await rename(temporary, file);
      }
    } catch { /* Persistence is an optimization. */ }
  }

  async evolution(commits: CommitInfo[], changes: Map<string, GitCommitChanges>, repositoryName: string, ignore: string[], mapNodes: (index: ProjectionIndex) => Map<string, LayoutNode> = index => index.layoutNodes(), namespace = repositoryName): Promise<EvolutionResponse> {
    const graph = new GraphBuilder(namespace), rootId = graph.id('repository');
    const versions = new Map<number, SnapshotEntity>(), present = new Map<string, number>();
    const fileIds = new Set<string>();
    const deltas = new Map<number, { added: number[]; removed: number[] }>();
    const registry = emptyRegistry();
    let version = 0, structureChanged = true;
    const ignoredPaths = new Map<string, boolean>();
    const ignored = (relative: string) => {
      if (!ignoredPaths.has(relative)) ignoredPaths.set(relative, ignoredHistoryPath(relative, ignore));
      return ignoredPaths.get(relative)!;
    };
    const put = (entity: SnapshotEntity, delta: { added: number[]; removed: number[] }) => {
      const previous = present.get(entity.path ?? '.');
      if (previous === undefined) structureChanged = true;
      if (entity.type === 'file') { entity.parentId = path.posix.dirname(entity.path!) === '.' ? rootId : graph.id('directory', path.posix.dirname(entity.path!)); fileIds.add(entity.id); }
      if (previous !== undefined) delta.removed.push(previous);
      versions.set(++version, entity); present.set(entity.path ?? '.', version); delta.added.push(version);
    };
    const remove = (relative: string, delta: { added: number[]; removed: number[] }) => {
      const previous = present.get(relative);
      if (previous !== undefined) { delta.removed.push(previous); present.delete(relative); structureChanged = true; }
    };
    const seed = { added: [] as number[], removed: [] as number[] };
    put({ id: rootId, name: repositoryName, type: 'repository', shape: '', path: '.' }, seed);
    // A bounded timeline may start mid-history. Seed it from its actual parent tree.
    const parent = commits[0]?.parents[0];
    if (parent) {
      const tree = await git(this.root, ['ls-tree', '-r', '-z', parent, '--']);
      for (const record of tree.split('\0')) {
        const match = /^(100644|100755) blob ([0-9a-f]{40})\t(.*)$/s.exec(record);
        if (match && !ignored(match[3]!)) put({ id: graph.id('file', match[3]!), name: path.posix.basename(match[3]!), type: 'file', path: match[3]!, content: match[2], shape: match[1]!, language: languageOf(match[3]!) }, seed);
      }
    }
    for (const [position, commit] of commits.entries()) {
      structureChanged = position === 0;
      const delta = position === 0 ? seed : { added: [] as number[], removed: [] as number[] };
      for (const change of changes.get(commit.sha)?.files ?? []) {
        const previous = present.get(change.from ?? change.path);
        const prior = previous !== undefined ? versions.get(previous) : undefined;
        if (change.from) remove(change.from, delta);
        if (change.status === 'removed' || !/^100(644|755)$/.test(change.mode) || ignored(change.path)) { remove(change.path, delta); continue; }
        // A moved path needs its own display record, linked to the previous slot.
        // Reusing an old path gets a new identity so two live files cannot overlap.
        const canonical = graph.id('file', change.path);
        const id = !change.from && prior?.type === 'file' ? prior.id : fileIds.has(canonical) ? graph.id('file', change.path, commit.sha) : canonical;
        if (change.from && prior?.type === 'file') registry.alias[id] = registry.alias[prior.id] ?? prior.id;
        put({ id, type: 'file', name: path.posix.basename(change.path), path: change.path, content: change.blob, shape: change.mode, language: languageOf(change.path) }, delta);
      }
      // Maintain the directory hierarchy independently of applications/frameworks.
      if (structureChanged) {
        const directories = new Set<string>();
        for (const vid of present.values()) {
          const entity = versions.get(vid)!;
          if (entity.type !== 'file') continue;
          for (let directory = path.posix.dirname(entity.path!); directory !== '.'; directory = path.posix.dirname(directory)) directories.add(directory);
        }
        for (const [relative, vid] of present) if (versions.get(vid)!.type === 'directory' && !directories.has(relative)) remove(relative, delta);
        for (const directory of [...directories].sort()) if (!present.has(directory)) put({ id: graph.id('directory', directory), type: 'directory', name: path.posix.basename(directory), path: directory, parentId: path.posix.dirname(directory) === '.' ? rootId : graph.id('directory', path.posix.dirname(directory)), shape: '' }, delta);
      }
      if (position === 0) { delta.added = [...present.values()]; delta.removed = []; }
      else { const transient = new Set(delta.added.filter(vid => delta.removed.includes(vid))); delta.added = delta.added.filter(vid => !transient.has(vid)); delta.removed = delta.removed.filter(vid => !transient.has(vid)); }
      deltas.set(position + 1, delta);
      if (structureChanged) {
        const index = new ProjectionIndex(commit.sha, [...present.values()].map(vid => versions.get(vid)!), [], []);
        extendRegistry(registry, mapNodes(index), rootId);
      }
      if (position % 25 === 0) await new Promise<void>(resolve => setImmediate(resolve));
    }
    const layout = timelineLayout(registry, rootId);
    const data = await computeEvolution({ entityVersions: () => versions, entityDelta: seq => deltas.get(seq)! }, commits.map((commit, i) => ({ id: commit.sha, seq: i + 1 })), () => ({ registry, layout }), undefined, mapNodes);
    return { status: 'ready', stamp: createHash('sha256').update(JSON.stringify([VERSION, commits.map(c => c.sha), ignore, repositoryName])).digest('hex'), nodes: data!.nodes, frames: data!.frames };
  }
}
