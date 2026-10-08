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
