// Lazy, bounded, read-only source access. Requests name indexed identities
// (entity, relation evidence, diagnostic) — never filesystem paths. The file
// must be an indexed, analyzable file entity inside the configured repository,
// reached without symlinks, and within the configured size limit.
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { Entity, Evidence } from '../core/graph.js';
import { repoPath } from '../core/config.js';
import type { GraphStore } from '../storage/sqlite.js';

export const SOURCE_MAX_LINES = 400;
export const SOURCE_CONTEXT_LINES = 12;
export const SOURCE_MAX_LINE_CHARS = 2000;
export const SOURCE_MAX_BYTES = 256 * 1024;
export class SourceError extends Error { constructor(readonly status: number, message: string) { super(message); } }
import type { SourceRequest, SourceResponse } from './dto.js';
export type { SourceRequest, SourceResponse } from './dto.js';
function integer(value: number | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 1 || value > 10_000_000) throw new SourceError(400, `${name} must be a positive integer`);
  return value;
}
export async function readIndexedSource(store: GraphStore, root: string, maxFileBytes: number, request: SourceRequest): Promise<SourceResponse> {
  const owners = [request.entity, request.relation, request.diagnostic].filter(value => value !== undefined);
  if (owners.length !== 1) throw new SourceError(400, 'Specify exactly one of entity, relation or diagnostic');
  const evidenceIndex = request.evidence === undefined ? undefined : Number(request.evidence);
  if (evidenceIndex !== undefined && (!Number.isSafeInteger(evidenceIndex) || evidenceIndex < 0 || evidenceIndex > 10_000)) throw new SourceError(400, 'evidence must be a non-negative index');
  const start = integer(request.start, 'start'), end = integer(request.end, 'end');
  if ((start === undefined) !== (end === undefined)) throw new SourceError(400, 'start and end must be given together');
  if (start !== undefined && end! < start) throw new SourceError(400, 'end must not precede start');

  let filePath: string | undefined, focus: SourceResponse['focus'];
  const fromEvidence = (facts: Evidence[], owner: string): void => {
    const fact = facts[evidenceIndex!];
    if (!fact) throw new SourceError(404, `${owner} has no evidence #${evidenceIndex}`);
    if (!fact.file) throw new SourceError(422, 'This evidence record has no source file');
    filePath = fact.file;
    if (fact.line) focus = { startLine: fact.line, endLine: Math.max(fact.line, fact.endLine ?? fact.line), kind: 'evidence', label: fact.explanation ?? `${fact.analyzer} evidence` };
  };
  if (request.relation !== undefined) {
    if (evidenceIndex === undefined) throw new SourceError(400, 'Relation source requires an evidence index');
    const relation = store.relation(request.relation);
    if (!relation) throw new SourceError(404, 'Relation not found');
    fromEvidence(relation.evidence, 'Relation');
  } else if (request.diagnostic !== undefined) {
    const row = store.db.prepare('SELECT file, line, code FROM diagnostics WHERE id=?').get(request.diagnostic);
    if (!row) throw new SourceError(404, 'Diagnostic not found');
    if (!row.file) throw new SourceError(422, 'This finding is not attached to a file');
    filePath = String(row.file);
    if (row.line) focus = { startLine: Number(row.line), endLine: Number(row.line), kind: 'diagnostic', label: String(row.code) };
  } else {
    const entity: Entity | undefined = store.entity(request.entity!);
    if (!entity) throw new SourceError(404, 'Entity not found');
    if (evidenceIndex !== undefined) fromEvidence(entity.evidence, 'Entity');
    else {
      if (!entity.path || entity.type === 'directory' || entity.type === 'application' || entity.type === 'repository') throw new SourceError(422, `A ${entity.type} has no single source file`);
      filePath = entity.path;
      if (entity.type !== 'file' && entity.sourceRange) focus = { startLine: entity.sourceRange.startLine, endLine: entity.sourceRange.endLine, kind: 'symbol', label: `${entity.type} ${entity.name}` };
    }
  }
  const file = store.db.prepare("SELECT id, path, language, metadata FROM entities WHERE type='file' AND path=?").get(filePath!);
  if (!file) throw new SourceError(404, 'Source file is not an indexed file');
  const metadata = JSON.parse(String(file.metadata)) as { analysisSkipped?: string; contentHash?: string };
  if (metadata.analysisSkipped || !file.language) throw new SourceError(422, `Source is unavailable for this file${metadata.analysisSkipped ? `: ${metadata.analysisSkipped}` : ''}`);

  // Containment: lexical check, then no symlink anywhere between root and file.
  const relative = String(file.path);
  if (path.isAbsolute(relative) || relative.split('/').includes('..') || relative.includes('\0')) throw new SourceError(403, 'Indexed path is not repository-relative');
  let absolute: string;
  try { absolute = repoPath(root, relative); } catch { throw new SourceError(403, 'Path escapes the repository'); }
  let resolved: string;
  try { resolved = await realpath(absolute); } catch { throw new SourceError(410, 'File no longer exists in the working tree; reindex to refresh'); }
  const realRoot = await realpath(root);
  if (resolved !== path.join(realRoot, ...relative.split('/'))) throw new SourceError(403, 'Refusing to follow a symlink or escaped path');
  const info = await lstat(resolved);
  if (!info.isFile()) throw new SourceError(403, 'Not a regular file');
  if (info.size > maxFileBytes) throw new SourceError(413, 'File exceeds the configured maxFileBytes');

  const buffer = await readFile(resolved);
  if (buffer.includes(0)) throw new SourceError(422, 'File now contains binary content');
  const currentHash = createHash('sha256').update(buffer).digest('hex');
  const changedSinceIndex = metadata.contentHash !== undefined && metadata.contentHash !== currentHash;
  const content = buffer.toString('utf8');
  const all = content.length === 0 ? [] : content.replace(/\r?\n$/, '').split(/\r?\n/);
  const totalLines = all.length;
  const notices: string[] = [];
  if (changedSinceIndex) notices.push('The file changed since it was indexed. Line numbers and highlighted ranges may no longer match; reindex to refresh.');
  if (metadata.contentHash === undefined) notices.push('No indexed content hash is available to detect changes.');
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
  return { file: { id: String(file.id), path: relative, ...(file.language ? { language: String(file.language) } : {}) }, totalLines, start: from, end: to, lines, ...(focus ? { focus } : {}), ...(metadata.contentHash ? { indexedHash: metadata.contentHash } : {}), currentHash, changedSinceIndex, truncated, notices };
}
