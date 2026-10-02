// Read-only Git access for historical indexing and history views. Every call
// runs `git` without a shell against the target repository; nothing writes to
// its worktree, index or refs. Commits are materialized into a scratch
// directory from blobs (no `git worktree`/checkout), incrementally between
// consecutive commits.
import { execFile, spawn } from 'node:child_process';
import { mkdir, rm, rmdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const SHA = /^[0-9a-f]{40}$/;
// Literal pathspecs: indexed paths are never interpreted as patterns or magic.
const ENV = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_LITERAL_PATHSPECS: '1', LC_ALL: 'C' };

export class GitError extends Error {}
export function git(root: string, args: string[], options: { maxBuffer?: number } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: root, env: ENV, maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) reject(new GitError(`git ${args[0]} failed: ${(stderr || error.message).trim().split('\n')[0]}`));
      else resolve(stdout);
    });
  });
}
function gitBuffer(root: string, args: string[], maxBuffer: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: root, env: ENV, maxBuffer, encoding: 'buffer' }, (error, stdout, stderr) => {
      if (error) reject(new GitError(`git ${args[0]} failed: ${(stderr.toString() || error.message).trim().split('\n')[0]}`));
      else resolve(stdout);
    });
  });
}
export function isSha(value: unknown): value is string { return typeof value === 'string' && SHA.test(value); }
/** A ref name as given on the command line; options and revision syntax beyond a plain name are refused. */
export function validRef(ref: string): boolean { return ref.length > 0 && ref.length <= 200 && !ref.startsWith('-') && /^[\w./@{}^~-]+$/.test(ref) && !ref.includes('..'); }
export async function resolveCommit(root: string, ref: string): Promise<string> {
  if (!validRef(ref)) throw new GitError(`Invalid ref ${JSON.stringify(ref)}`);
  const sha = (await git(root, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`]).catch(() => '')).trim();
  if (!isSha(sha)) throw new GitError(`Unknown ref ${ref}`);
  return sha;
}
export async function currentBranch(root: string): Promise<string | undefined> {
  return (await git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '')).trim() || undefined;
}

export interface CommitInfo {
  sha: string; tree: string; parents: string[];
  authorName: string; authorEmail: string; authoredAt: string; committedAt: string;
  subject: string; body: string;
}
const FIELDS = ['%H', '%T', '%P', '%an', '%ae', '%aI', '%cI', '%s', '%b'].join('%x1f');
function parseCommits(output: string): CommitInfo[] {
  return output.split('\0').filter(record => record.trim()).map(record => {
    const [sha, tree, parents, authorName, authorEmail, authoredAt, committedAt, subject, body] = record.replace(/^\n/, '').split('\x1f');
    return { sha: sha!, tree: tree!, parents: parents ? parents.split(' ').filter(Boolean) : [], authorName: authorName ?? '', authorEmail: authorEmail ?? '', authoredAt: authoredAt!, committedAt: committedAt!, subject: subject ?? '', body: (body ?? '').trim() };
  });
}
/**
 * Commits reachable from `ref`, oldest first. The default follows first
 * parents only: Git history is a DAG, and the first-parent chain is the
 * sequence the branch itself went through.
 */
export async function listCommits(root: string, options: { ref: string; firstParent?: boolean; limit?: number; since?: string }): Promise<CommitInfo[]> {
  const head = await resolveCommit(root, options.ref);
  const args = ['log', '-z', `--format=${FIELDS}`];
  if (options.firstParent !== false) args.push('--first-parent');
  if (options.limit !== undefined) { if (!Number.isSafeInteger(options.limit) || options.limit < 1) throw new GitError('limit must be a positive integer'); args.push(`--max-count=${options.limit}`); }
  if (options.since !== undefined) { if (!/^[\w :.+-]{1,40}$/.test(options.since)) throw new GitError('Invalid --since value'); args.push(`--since=${options.since}`); }
  args.push(head, '--');
  return parseCommits(await git(root, args, { maxBuffer: 512 * 1024 * 1024 })).reverse();
}
export async function commitInfo(root: string, sha: string): Promise<CommitInfo> {
  if (!isSha(sha)) throw new GitError('Invalid commit');
  const [commit] = parseCommits(await git(root, ['show', '-s', '-z', `--format=${FIELDS}`, sha, '--']));
  if (!commit) throw new GitError(`Unknown commit ${sha}`);
  return commit;
}

interface TreeChange { srcMode: string; dstMode: string; dstSha: string; status: string; path: string }
async function diffTree(root: string, from: string, to: string): Promise<TreeChange[]> {
  const output = await git(root, ['diff-tree', '-r', '-z', '--no-renames', '--no-commit-id', from, to], { maxBuffer: 512 * 1024 * 1024 });
  const parts = output.split('\0');
  const changes: TreeChange[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const header = parts[i]!.replace(/^:/, '').split(' ');
    if (header.length < 5) continue;
    changes.push({ srcMode: header[0]!, dstMode: header[1]!, dstSha: header[3]!, status: header[4]!.charAt(0), path: parts[i + 1]! });
  }
  return changes;
}
/** Streams blobs through one `git cat-file --batch` process. */
async function readBlobs(root: string, shas: string[], onBlob: (sha: string, content: Buffer) => Promise<void>): Promise<void> {
  if (!shas.length) return;
  const child = spawn('git', ['cat-file', '--batch'], { cwd: root, env: ENV, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = new Promise<number | null>(resolve => child.on('close', resolve));
  const writer = (async () => {
    for (const sha of shas) if (!child.stdin.write(`${sha}\n`)) await new Promise(resolve => child.stdin.once('drain', resolve));
    child.stdin.end();
  })();
  let buffer: Buffer = Buffer.alloc(0);
  let index = 0;
  for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
    for (;;) {
      const newline = buffer.indexOf(10);
      if (newline < 0) break;
      const [sha, type, size] = buffer.subarray(0, newline).toString('utf8').split(' ');
      if (type === 'missing' || size === undefined) throw new GitError(`Missing Git object ${sha}`);
      const length = Number(size);
      if (buffer.length < newline + 1 + length + 1) break;
      await onBlob(shas[index++]!, buffer.subarray(newline + 1, newline + 1 + length));
      buffer = buffer.subarray(newline + 1 + length + 1);
    }
  }
  await writer;
  if (await exited !== 0 || index !== shas.length) throw new GitError(`git cat-file failed: ${stderr.trim() || 'incomplete output'}`);
}

/**
 * Materializes commits into `directory`. Each checkout applies only the tree
 * difference from the previously materialized commit, so walking a branch's
 * history writes changed files only. Symlinks are recreated as symlinks (the
 * scanner skips them, as it does in a working tree); submodules become empty
 * directories.
 */
export class TreeMirror {
  private current?: string;
  constructor(private readonly root: string, readonly directory: string) {}
  get commit(): string | undefined { return this.current; }
  async checkout(sha: string): Promise<{ written: number; removed: number }> {
    if (!isSha(sha)) throw new GitError('Invalid commit');
    if (this.current === sha) return { written: 0, removed: 0 };
    if (!this.current) { await rm(this.directory, { recursive: true, force: true }); await mkdir(this.directory, { recursive: true }); }
    const changes = await diffTree(this.root, this.current ?? EMPTY_TREE, sha);
    const target = (relative: string) => {
      const absolute = path.resolve(this.directory, relative);
      if (relative.includes('\0') || !absolute.startsWith(`${this.directory}${path.sep}`)) throw new GitError(`Refusing tree path ${JSON.stringify(relative)}`);
      return absolute;
    };
    // Deletions (and the old side of type changes) first, so a path can turn from file into directory or back.
    const touchedDirectories = new Set<string>();
    let removed = 0;
    for (const change of changes) {
      if (change.status !== 'D' && change.status !== 'T' && !(change.status === 'M' && change.srcMode !== change.dstMode)) continue;
      await rm(target(change.path), { recursive: true, force: true });
      touchedDirectories.add(path.posix.dirname(change.path));
      if (change.status === 'D') removed++;
    }
    for (const directory of [...touchedDirectories].sort((a, b) => b.length - a.length)) {
      for (let current = directory; current !== '.' && current !== ''; current = path.posix.dirname(current)) {
        try { await rmdir(target(current)); } catch { break; }
      }
    }
    const writes = changes.filter(change => change.status !== 'D');
    const byBlob = new Map<string, TreeChange[]>();
    for (const change of writes) {
      if (change.dstMode === '160000') { await mkdir(target(change.path), { recursive: true }); continue; }
      const list = byBlob.get(change.dstSha) ?? []; list.push(change); byBlob.set(change.dstSha, list);
    }
    await readBlobs(this.root, [...byBlob.keys()], async (blob, content) => {
      for (const change of byBlob.get(blob)!) {
        const file = target(change.path);
        await mkdir(path.dirname(file), { recursive: true });
        await rm(file, { recursive: true, force: true });
        if (change.dstMode === '120000') await symlink(content.toString('utf8'), file);
        else await writeFile(file, content);
      }
    });
    this.current = sha;
    return { written: writes.length, removed };
  }
}

/** One regular file's content at a commit, bounded by size. Symlinks and non-blobs are refused. */
export async function readBlobAt(root: string, commit: string, relative: string, maxBytes: number): Promise<{ blob: string; content: Buffer }> {
  if (!isSha(commit)) throw new GitError('Invalid commit');
  if (!relative || path.posix.isAbsolute(relative) || relative.split('/').includes('..') || relative.includes('\0')) throw new GitError('Path must be repository-relative');
  const entry = (await git(root, ['ls-tree', '-z', '--full-tree', commit, '--', relative])).split('\0')[0];
  const match = entry ? /^(\d{6}) (\w+) ([0-9a-f]{40})\t(.*)$/s.exec(entry) : null;
  if (!match || match[4] !== relative) throw new GitError('File is not in this commit');
  if (match[2] !== 'blob' || (match[1] !== '100644' && match[1] !== '100755')) throw new GitError('Not a regular file in this commit');
  const size = Number((await git(root, ['cat-file', '-s', match[3]!])).trim());
  if (!Number.isSafeInteger(size) || size > maxBytes) throw new GitError('File exceeds the configured maxFileBytes');
  return { blob: match[3]!, content: await gitBuffer(root, ['cat-file', 'blob', match[3]!], maxBytes + 1024) };
}

/**
 * Renamed paths between two commits (old → new), from Git's rename detection.
 * `to` undefined compares against the working tree (tracked files only).
 */
export async function renamedPaths(root: string, from: string, to?: string): Promise<Map<string, string>> {
  if (!isSha(from) || (to !== undefined && !isSha(to))) throw new GitError('Invalid commit');
  const output = await git(root, ['diff', '--no-ext-diff', '-M', '-l3000', '--diff-filter=R', '--name-status', '-z', from, ...(to ? [to] : []), '--'], { maxBuffer: 256 * 1024 * 1024 });
  const parts = output.split('\0');
  const renames = new Map<string, string>();
  for (let i = 0; i + 2 < parts.length; i += 3) if (parts[i]!.startsWith('R')) renames.set(parts[i + 1]!, parts[i + 2]!);
  return renames;
}
