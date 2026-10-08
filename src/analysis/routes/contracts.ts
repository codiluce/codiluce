/** Serializable routing facts shared by framework packs, history and matching.
 * Opaque syntax is retained as a competing candidate, never a confirmed match. */
export type RoutePart = { kind: 'literal'; value: string } | { kind: 'parameter'; name: string; converter?: 'int' | 'float' | 'uuid' };
export type RouteSegment = { kind: 'segment'; parts: RoutePart[] } | { kind: 'rest'; name: string; minimum: 0 | 1 };
export interface RoutePattern {
  version: 1; dialect: 'express-common' | 'express-4' | 'express-5' | 'starlette'; original: string;
  status: 'exact' | 'partial'; reason?: string; alternatives: RouteSegment[][];
  caseSensitive: boolean; strict: boolean;
}
export interface RoutingContract {
  version: 1; pattern: RoutePattern; methods: string[] | '*'; executionContext: 'server';
  registration: { file: string; line: number; receiver: string };
  mounts: { id: string; file: string; line: number; prefix: string }[];
  middleware: string[]; conditions: string[];
}
export interface RouterOptions { caseSensitive?: boolean; strict?: boolean }
const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Express 5 braces expand into bounded alternatives. Regex paths and legacy
 * regex-like strings are deliberately not evaluated as target expressions. */
function expandGroups(path: string, limit = 32): string[] | undefined {
  const open = path.indexOf('{');
  if (open < 0) return path.includes('}') ? undefined : [path];
  let depth = 0, close = -1;
  for (let i = open; i < path.length; i++) { if (path[i] === '{') depth++; if (path[i] === '}' && --depth === 0) { close = i; break; } }
  if (close < 0) return undefined;
  const suffix = expandGroups(path.slice(close + 1), limit), included = expandGroups(path.slice(open + 1, close), limit);
  if (!suffix || !included || suffix.length * (included.length + 1) > limit) return undefined;
  return suffix.flatMap(tail => [path.slice(0, open) + tail, ...included.map(group => path.slice(0, open) + group + tail)]);
}
export function compileExpressPath(original: string, major: 4 | 5 | undefined, options: RouterOptions = {}): RoutePattern {
  const pattern: RoutePattern = { version: 1, dialect: major ? `express-${major}` : 'express-common', original, status: 'exact', alternatives: [], caseSensitive: options.caseSensitive ?? false, strict: options.strict ?? false };
  const partial = (reason: string): RoutePattern => ({ ...pattern, status: 'partial', reason, alternatives: [] });
  if (!original.startsWith('/') || original.includes('//') || original.includes('\\') || /[\[\]()!#]/.test(original)) return partial('Repeated slashes, regex paths, escapes and regex-like string syntax require a separate constrained matcher');
  if (!major && /[{}?*+]/.test(original)) return partial('The declared Express version does not select one route syntax profile');
  let variants: string[] | undefined = major === 5 ? expandGroups(original) : [original];
  if (!variants || variants.length > 32) return partial('Optional route groups exceed the bounded parser or are unbalanced');
  if (major === 4) {
    variants = [original];
    // Whole optional parameters are the supported Express 4 string subset.
    for (const segment of original.split('/')) if (/^:[A-Za-z_]\w*\?$/.test(segment)) {
      if (variants.length > 16) return partial('Too many optional route parameters');
      variants = variants.flatMap(value => [value.replace(`/${segment}`, ''), value.replace(segment, segment.slice(0, -1))]);
    }
  }
  for (const variant of [...new Set(variants)]) {
    const segments: RouteSegment[] = [];
    for (const raw of variant.split('/').filter(Boolean)) {
      const wildcard = major === 5 ? /^\*([A-Za-z_]\w*)$/.exec(raw) : major === 4 && raw === '*' ? ['', 'wildcard'] : null;
      if (wildcard) { segments.push({ kind: 'rest', name: wildcard[1]!, minimum: major === 5 ? 1 : 0 }); continue; }
      if (/[{}?*+]/.test(raw)) return partial('Unsupported or version-incompatible route modifier');
      const parts: RoutePart[] = []; let cursor = 0;
      const parameters = /:([A-Za-z_]\w*)/g;
      for (const match of raw.matchAll(parameters)) {
        if (match.index! > cursor) parts.push({ kind: 'literal', value: raw.slice(cursor, match.index) });
        parts.push({ kind: 'parameter', name: match[1]! }); cursor = match.index! + match[0].length;
      }
      if (cursor < raw.length) parts.push({ kind: 'literal', value: raw.slice(cursor) });
      if (parts.some(part => part.kind === 'literal' && part.value.includes(':')) || parts.some((part, i) => part.kind === 'parameter' && parts[i + 1]?.kind === 'parameter')) return partial('Quoted or adjacent route parameters are outside the supported subset');
      segments.push({ kind: 'segment', parts });
    }
    pattern.alternatives.push(segments);
  }
  return pattern;
}
export function composeRoutePath(prefix: string, child: string): string { return `${prefix.replace(/\/$/, '')}/${child.replace(/^\//, '')}` || '/'; }
/** Starlette converters constrain matching; custom converters stay opaque. */
export function compileStarlettePath(original: string): RoutePattern {
  const pattern: RoutePattern = { version: 1, dialect: 'starlette', original, status: 'exact', alternatives: [], caseSensitive: true, strict: true };
  const partial = (reason: string): RoutePattern => ({ ...pattern, status: 'partial', reason });
  if (!original.startsWith('/') || original.includes('//') || original.includes('\\') || /[?#]/.test(original)) return partial('Unsupported Starlette path syntax');
  const segments: RouteSegment[] = [];
  for (const raw of original.split('/').filter(Boolean)) {
    if (/^\{\w+:path\}$/.test(raw)) { segments.push({ kind: 'rest', name: raw.slice(1, -6), minimum: 0 }); continue; }
    const parts: RoutePart[] = []; let cursor = 0;
    for (const match of raw.matchAll(/\{([A-Za-z_]\w*)(?::(\w+))?\}/g)) {
      if (match.index! > cursor) parts.push({ kind: 'literal', value: raw.slice(cursor, match.index) });
      const converter = match[2] ?? 'str';
      if (!['str', 'int', 'float', 'uuid'].includes(converter)) return partial('Custom or embedded path converter is unsupported');
      parts.push({ kind: 'parameter', name: match[1]!, ...(converter !== 'str' ? { converter: converter as 'int' | 'float' | 'uuid' } : {}) }); cursor = match.index! + match[0].length;
    }
    if (cursor < raw.length) parts.push({ kind: 'literal', value: raw.slice(cursor) });
    if (parts.some(part => part.kind === 'literal' && /[{}]/.test(part.value))) return partial('Unbalanced path parameter');
    segments.push({ kind: 'segment', parts });
  }
  pattern.alternatives = [segments]; return pattern;
}
export function matchRoutePattern(pattern: RoutePattern, pathname: string, strictHoles = true): boolean {
  if (pattern.status === 'partial') return true;
  if (pattern.dialect === 'starlette' && !pathname.includes('{*}')) {
    const parameter = (part: RoutePart) => part.kind === 'literal' ? escaped(part.value) : part.converter === 'int' ? '[0-9]+' : part.converter === 'float' ? '[0-9]+(?:\\.[0-9]+)?' : part.converter === 'uuid' ? '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}' : '[^/]+';
    return pattern.alternatives.some(segments => new RegExp(`^/${segments.map(segment => segment.kind === 'rest' ? '.*' : segment.parts.map(parameter).join('')).join('/')}${pattern.original !== '/' && pattern.original.endsWith('/') ? '/' : ''}$`).test(pathname));
  }
  if (pattern.strict && pathname.endsWith('/') !== pattern.original.endsWith('/') && pathname !== '/') return false;
  const request = pathname.split('/').filter(Boolean);
  const matches = (segments: RouteSegment[], index: number, cursor: number): boolean => {
    if (index === segments.length) return cursor === request.length;
    const segment = segments[index]!;
    if (segment.kind === 'rest') {
      for (let end = cursor + segment.minimum; end <= request.length; end++) if (matches(segments, index + 1, end)) return true;
      return false;
    }
    const value = request[cursor]; if (value === undefined) return false;
    if (value === '{*}') {
      if (strictHoles && !(segment.parts.length === 1 && segment.parts[0]?.kind === 'parameter')) return false;
    } else {
      const regex = segment.parts.map(part => part.kind === 'literal' ? escaped(part.value) : part.converter === 'int' ? '[0-9]+' : part.converter === 'float' ? '[0-9]+(?:\\.[0-9]+)?' : part.converter === 'uuid' ? '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}' : '[^/]+').join('');
      if (!new RegExp(`^${regex}$`, pattern.caseSensitive ? '' : 'i').test(value)) return false;
    }
    return matches(segments, index + 1, cursor + 1);
  };
  return pattern.alternatives.some(segments => matches(segments, 0, 0));
}
export function routingContract(value: unknown): RoutingContract | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const contract = value as RoutingContract;
  return contract.version === 1 && contract.pattern?.version === 1 && Array.isArray(contract.pattern.alternatives) && (contract.methods === '*' || Array.isArray(contract.methods)) ? contract : undefined;
}
