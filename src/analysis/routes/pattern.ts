/** The existing Next/Laravel route dialect, compiled once for matching. Keep
 * the original spelling: future packs must supply their own dialect parser
 * rather than erase converters, optional groups or regular expressions. */
export type IndexedPathSegment = { kind: 'literal'; value: string }
  | { kind: 'parameter'; name: string; optional: boolean }
  | { kind: 'rest'; name: string; minimum: 0 | 1 };
export interface IndexedPathPattern { version: 1; dialect: 'next-laravel'; original: string; segments: IndexedPathSegment[] }
export function compileIndexedPath(original: string): IndexedPathPattern {
  const segments: IndexedPathSegment[] = original.split('/').filter(Boolean).map(segment => {
    if (/^\{[^/{}]+\?\}$/.test(segment)) return { kind: 'parameter', name: segment.slice(1, -2), optional: true };
    if (/^\{[^/{}]+\}$/.test(segment)) return { kind: 'parameter', name: segment.slice(1, -1), optional: false };
    if (/^:[^*+]+$/.test(segment)) return { kind: 'parameter', name: segment.slice(1), optional: false };
    if (/^:[^/]+[+*]$/.test(segment)) return { kind: 'rest', name: segment.slice(1, -1), minimum: segment.endsWith('*') ? 0 : 1 };
    return { kind: 'literal', value: segment };
  });
  return { version: 1, dialect: 'next-laravel', original, segments };
}
export function requestPathSegments(path: string): string[] { return path.split('/').filter(Boolean); }
/** A request hole fills exactly one segment. Strict matching requires a
 * parameter; loose matching retains competing literal routes for ambiguity. */
export function matchIndexedPath(pattern: IndexedPathPattern, request: readonly string[], strict = true): boolean {
  let cursor = 0;
  for (const segment of pattern.segments) {
    if (segment.kind === 'parameter' && segment.optional) { if (cursor < request.length) cursor++; }
    else if (segment.kind === 'parameter') { if (!request[cursor++]) return false; }
    else if (segment.kind === 'rest') return segment.minimum === 0 || cursor < request.length;
    else { const value = request[cursor++]; if (value === '{*}' ? strict : segment.value !== value) return false; }
  }
  return cursor === request.length;
}

type PrefixEntry<T> = { value: T; order: number };
interface PrefixNode<T> { entries: PrefixEntry<T>[]; children: Map<string, PrefixNode<T>> }

/** Candidate selection only: the authoritative matcher still decides every
 * match. Index the existing Next/Laravel dialect's leading literal segments;
 * other dialects, root parameters and catch-alls remain in the fallback set.
 * Preserve registration order, including interleaved fallback candidates. */
export class IndexedPathCandidates<T> {
  private readonly root: PrefixNode<T> = { entries: [], children: new Map() };
  private readonly all: T[];
  private indexed = false;
  constructor(entries: readonly { value: T; pattern?: IndexedPathPattern }[]) {
    this.all = entries.map(entry => entry.value);
    entries.forEach(({ value, pattern }, order) => {
      let node = this.root;
      for (const segment of pattern?.segments ?? []) {
        if (segment.kind !== 'literal') break;
        let child = node.children.get(segment.value);
        if (!child) { child = { entries: [], children: new Map() }; node.children.set(segment.value, child); }
        node = child;
      }
      if (node !== this.root) this.indexed = true;
      node.entries.push({ value, order });
    });
  }
  candidates(path: string): readonly T[] {
    if (!this.indexed) return this.all;
    const segments = requestPathSegments(path);
    // Loose matching of holes can match literals. Keep the full inventory
    // when a caller supplies a dynamic request summary.
    if (segments.includes('{*}')) return this.all;
    let node = this.root;
    const selected = [...node.entries];
    for (const segment of segments) {
      const child = node.children.get(segment);
      if (!child) break;
      node = child;
      for (const entry of node.entries) selected.push(entry);
    }
    return selected.sort((a, b) => a.order - b.order).map(entry => entry.value);
  }
}
