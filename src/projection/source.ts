// Lazy, bounded, read-only source access. Requests name indexed identities
// (entity, relation evidence, diagnostic) — never filesystem paths or
// commits. The file must be an indexed, analyzable file entity of the
// snapshot being read: working-tree content is reached without symlinks and
// within the repository; historical content is the Git blob of that
// snapshot's own commit. Both are bounded by the configured size limit.
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { Entity, Evidence } from '../core/graph.js';
import { SnapshotFileError, WorkingTreeSnapshot, type SnapshotSource } from '../history/snapshot.js';
import type { GraphStore } from '../storage/sqlite.js';

export const SOURCE_MAX_LINES = 400;
export const SOURCE_CONTEXT_LINES = 12;
export const SOURCE_MAX_LINE_CHARS = 2000;
export const SOURCE_MAX_BYTES = 256 * 1024;
export class SourceError extends Error { constructor(readonly status: number, message: string) { super(message); } }
import type { SnapshotRef, SourceRequest, SourceResponse } from './dto.js';
export type { SourceRequest, SourceResponse } from './dto.js';
function integer(value: number | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 1 || value > 10_000_000) throw new SourceError(400, `${name} must be a positive integer`);
  return value;
}
export function snapshotRef(source: SnapshotSource): SnapshotRef {
  const info = source.info;
  return { id: info.id, kind: info.kind, ...(info.commitSha ? { commitSha: info.commitSha } : {}), ...(info.dirty !== undefined ? { dirty: info.dirty } : {}), analyzedAt: info.run.analyzedAt };
}
export function splitLines(content: string): string[] { return content.length === 0 ? [] : content.replace(/\r?\n$/, '').split(/\r?\n/); }
/** Live working-tree source for the current index. */
export async function readIndexedSource(store: GraphStore, root: string, maxFileBytes: number, request: SourceRequest): Promise<SourceResponse> {
  const run = store.currentRun();
  if (!run) throw new SourceError(404, 'No indexed graph');
  return readSnapshotSource([new WorkingTreeSnapshot(store, root, run)], maxFileBytes, request);
}
/** An indexed, analyzable file of `source`, and its bounded content. */
export async function readSnapshotFile(source: SnapshotSource, relative: string, maxFileBytes: number): Promise<{ file: Entity; buffer: Buffer; indexedHash?: string }> {
  const file = source.fileByPath(relative);
  if (!file || file.type !== 'file') throw new SourceError(404, 'Source file is not an indexed file');
  const metadata = file.metadata as { analysisSkipped?: string; contentHash?: string };
  if (metadata.analysisSkipped || !file.language) throw new SourceError(422, `Source is unavailable for this file${metadata.analysisSkipped ? `: ${metadata.analysisSkipped}` : ''}`);
  if (path.isAbsolute(relative) || relative.split('/').includes('..') || relative.includes('\0')) throw new SourceError(403, 'Indexed path is not repository-relative');
  let buffer: Buffer;
  try { buffer = await source.readFile(relative, maxFileBytes); }
  catch (error) { if (error instanceof SnapshotFileError) throw new SourceError(error.status, error.message); throw error; }
  if (buffer.includes(0)) throw new SourceError(422, 'File now contains binary content');
  return { file, buffer, ...(metadata.contentHash ? { indexedHash: metadata.contentHash } : {}) };
}
/**
 * Read source for an owner resolved in the first snapshot of `sources` that
 * knows it (a comparison view passes target then baseline, so removed
 * entities read their last indexed content).
 */
export async function readSnapshotSource(sources: SnapshotSource[], maxFileBytes: number, request: SourceRequest): Promise<SourceResponse> {
  const owners = [request.entity, request.relation, request.diagnostic].filter(value => value !== undefined);
  if (owners.length !== 1) throw new SourceError(400, 'Specify exactly one of entity, relation or diagnostic');
  const evidenceIndex = request.evidence === undefined ? undefined : Number(request.evidence);
  if (evidenceIndex !== undefined && (!Number.isSafeInteger(evidenceIndex) || evidenceIndex < 0 || evidenceIndex > 10_000)) throw new SourceError(400, 'evidence must be a non-negative index');
  const start = integer(request.start, 'start'), end = integer(request.end, 'end');
  if ((start === undefined) !== (end === undefined)) throw new SourceError(400, 'start and end must be given together');
  if (start !== undefined && end! < start) throw new SourceError(400, 'end must not precede start');

  let filePath: string | undefined, focus: SourceResponse['focus'], source: SnapshotSource | undefined;
  const fromEvidence = (facts: Evidence[], owner: string): void => {
    const fact = facts[evidenceIndex!];
    if (!fact) throw new SourceError(404, `${owner} has no evidence #${evidenceIndex}`);
    if (!fact.file) throw new SourceError(422, 'This evidence record has no source file');
    filePath = fact.file;
    if (fact.line) focus = { startLine: fact.line, endLine: Math.max(fact.line, fact.endLine ?? fact.line), kind: 'evidence', label: fact.explanation ?? `${fact.analyzer} evidence` };
  };
  if (request.relation !== undefined) {
    if (evidenceIndex === undefined) throw new SourceError(400, 'Relation source requires an evidence index');
    let relation;
    for (const candidate of sources) if ((relation = candidate.relation(request.relation))) { source = candidate; break; }
    if (!relation) throw new SourceError(404, 'Relation not found');
    fromEvidence(relation.evidence, 'Relation');
  } else if (request.diagnostic !== undefined) {
    let diagnostic;
    for (const candidate of sources) if ((diagnostic = candidate.diagnostic(request.diagnostic))) { source = candidate; break; }
    if (!diagnostic) throw new SourceError(404, 'Diagnostic not found');
    if (!diagnostic.file) throw new SourceError(422, 'This finding is not attached to a file');
    filePath = diagnostic.file;
    if (diagnostic.line) focus = { startLine: diagnostic.line, endLine: diagnostic.line, kind: 'diagnostic', label: diagnostic.code };
  } else {
    let entity: Entity | undefined;
    for (const candidate of sources) if ((entity = candidate.entity(request.entity!))) { source = candidate; break; }
    if (!entity) throw new SourceError(404, 'Entity not found');
    if (evidenceIndex !== undefined) fromEvidence(entity.evidence, 'Entity');
    else {
      if (!entity.path || entity.type === 'directory' || entity.type === 'application' || entity.type === 'repository') throw new SourceError(422, `A ${entity.type} has no single source file`);
      filePath = entity.path;
      if (entity.type !== 'file' && entity.sourceRange) focus = { startLine: entity.sourceRange.startLine, endLine: entity.sourceRange.endLine, kind: 'symbol', label: `${entity.type} ${entity.name}` };
    }
  }
  const { file, buffer, indexedHash } = await readSnapshotFile(source!, filePath!, maxFileBytes);
  const relative = file.path!;
  const currentHash = createHash('sha256').update(buffer).digest('hex');
  const changedSinceIndex = indexedHash !== undefined && indexedHash !== currentHash;
  const all = splitLines(buffer.toString('utf8'));
  const totalLines = all.length;
  const notices: string[] = [];
  if (changedSinceIndex) notices.push('The file changed since it was indexed. Line numbers and highlighted ranges may no longer match; reindex to refresh.');
  if (indexedHash === undefined) notices.push('No indexed content hash is available to detect changes.');
  if (focus && focus.startLine > totalLines) notices.push(`Indexed line ${focus.startLine} is beyond the current end of file (${totalLines} lines).`);

  let from: number, to: number, truncated = false;
  if (start !== undefined) { from = start; to = end!; }
  else if (focus) { from = focus.startLine - SOURCE_CONTEXT_LINES; to = focus.endLine + SOURCE_CONTEXT_LINES; }
  else { from = 1; to = SOURCE_MAX_LINES; }
  from = Math.max(1, from);
  if (to - from + 1 > SOURCE_MAX_LINES) { to = from + SOURCE_MAX_LINES - 1; truncated = true; }
  to = Math.min(to, totalLines);
  const lines: string[] = [];
  let bytes = 0;
  for (let line = from; line <= to; line++) {
    let text = all[line - 1]!;
    if (text.length > SOURCE_MAX_LINE_CHARS) { text = `${text.slice(0, SOURCE_MAX_LINE_CHARS)}…`; truncated = true; }
    bytes += Buffer.byteLength(text) + 1;
    if (bytes > SOURCE_MAX_BYTES) { truncated = true; to = line - 1; break; }
    lines.push(text);
  }
  if (from > totalLines) { from = totalLines + 1; to = totalLines; }
  return { file: { id: file.id, path: relative, ...(file.language ? { language: file.language } : {}) }, snapshot: snapshotRef(source!), totalLines, start: from, end: to, lines, ...(focus ? { focus } : {}), ...(indexedHash ? { indexedHash } : {}), currentHash, changedSinceIndex, truncated, notices };
}
