// Hashes that separate storage identity from semantic change.
//
// - storageHash: the complete record (evidence, positions, metrics). Equal
//   hashes are deduplicated in the versioned store.
// - shapeHash: what the entity *is*, without positions. A function pushed
//   down by an edit above it keeps its shape; a changed signature, export
//   flag, route or metadata value changes it.
// - contentHash (from analyzers): the entity's own source text.
import { createHash } from 'node:crypto';
import type { Entity } from '../core/graph.js';

/** JSON with sorted object keys, so equal values always hash equally. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(item => item === undefined ? 'null' : canonicalJson(item)).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).filter(key => object[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
}
export function digest(text: string, length = 40): string { return createHash('sha256').update(text).digest('hex').slice(0, length); }
export function storageHash(value: unknown): string { return digest(canonicalJson(value)); }

/** Keys that locate something in a file rather than describe it, plus fingerprints compared separately. */
const POSITIONAL = new Set(['line', 'endLine', 'startLine', 'startColumn', 'endColumn', 'callerId', 'contentHash', 'bodyHash', 'bytes']);
export function withoutPositions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutPositions);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key]) => !POSITIONAL.has(key)).map(([key, item]) => [key, withoutPositions(item)]));
}
export function shapeHash(entity: Pick<Entity, 'type' | 'name' | 'language' | 'metadata'>): string {
  return digest(canonicalJson({ type: entity.type, name: entity.name, language: entity.language, metadata: withoutPositions(entity.metadata) }), 32);
}
/** Content identity: analyzer source hash when present; otherwise size for unread files. */
export function contentKey(entity: Pick<Entity, 'metadata'>): string | undefined {
  const metadata = entity.metadata;
  if (typeof metadata.contentHash === 'string') return metadata.contentHash;
  if (typeof metadata.bytes === 'number') return `bytes:${metadata.bytes}`;
  return undefined;
}
