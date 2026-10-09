/** Serializable routing facts shared by framework packs, history and matching.
 * Opaque syntax is retained as a competing candidate, never a confirmed match. */
export type RoutePart = { kind: 'literal'; value: string } | { kind: 'parameter'; name: string; converter?: 'int' | 'go-int' | 'float' | 'uuid' | 'slug' };
export type RouteSegment = { kind: 'segment'; parts: RoutePart[] } | { kind: 'rest'; name: string; minimum: 0 | 1 };
import { matchGoPath } from './go-patterns.js';
export interface RoutePattern {
  version: 1; dialect: 'express-common' | 'express-4' | 'express-5' | 'starlette' | 'werkzeug' | 'django-path' | 'django-re-path' | 'sveltekit' | 'astro' | 'nuxt-page' | 'nitro-2' | 'go-servemux-121' | 'go-servemux-122' | 'chi-5' | 'gin-1' | 'echo-4' | 'echo-5' | 'fiber-2' | 'fiber-3' | 'gorilla-1'; original: string;
  status: 'exact' | 'partial'; reason?: string; alternatives: RouteSegment[][];
  prefix?: string;
  caseSensitive: boolean; strict: boolean;
  encoded?: boolean; skipClean?: boolean; pathPrefix?: boolean; integerBits?: 32 | 64;
}
export interface RoutingContract {
  version: 1; pattern: RoutePattern; methods: string[] | '*'; executionContext: 'server';
  excludedMethods?: string[];
  registration: { file: string; line: number; receiver: string };
  mounts: { id: string; file: string; line: number; prefix: string }[];
  middleware: string[]; conditions: string[];
  host?: string;
  hostAuthority?: boolean;
  dispatch?: { dialect: 'go-servemux' | 'chi' | 'gin' | 'echo' | 'fiber' | 'gorilla'; root: string; order: number };
  excludedHosts?: string[];
  queries?: { name: string; value?: string }[];
  schemes?: string[];
  /** Parent dispatch decisions expressed in the externally visible path. */
  guards?: RoutingContract[];
  fallbackMethods?: string[];
  notFoundFallback?: boolean;
  /** StripPrefix also checks RawPath; alternate escaped prefix spellings fail. */
  rawPrefix?: string;
  /** Form actions share a page URL; the query selector chooses an operation. */
  action?: { name: string };
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
/** Reviewed Werkzeug built-ins only. Converter arguments, host rules and
 * custom converters require a constrained matcher; target regexes never run. */
export function compileWerkzeugPath(original: string, strict = true): RoutePattern {
  const pattern: RoutePattern = { version: 1, dialect: 'werkzeug', original, status: 'exact', alternatives: [], caseSensitive: true, strict };
  const partial = (reason: string): RoutePattern => ({ ...pattern, status: 'partial', reason });
  if (!original.startsWith('/') || original.includes('//') || original.includes('\\') || /[?#]/.test(original)) return partial('Unsupported Werkzeug rule syntax');
  const segments: RouteSegment[] = [];
  for (const raw of original.split('/').filter(Boolean)) {
    const rest = /^<path:([A-Za-z_]\w*)>$/.exec(raw);
    if (rest) { segments.push({ kind: 'rest', name: rest[1]!, minimum: 1 }); continue; }
    const parts: RoutePart[] = []; let cursor = 0;
    for (const match of raw.matchAll(/<(?:(\w+):)?([A-Za-z_]\w*)>/g)) {
      if (match.index! > cursor) parts.push({ kind: 'literal', value: raw.slice(cursor, match.index) });
      const converter = match[1] ?? 'string';
      if (!['string', 'int', 'float', 'uuid'].includes(converter)) return partial('Custom or embedded path converter is unsupported');
      parts.push({ kind: 'parameter', name: match[2]!, ...(converter !== 'string' ? { converter: converter as 'int' | 'float' | 'uuid' } : {}) }); cursor = match.index! + match[0].length;
    }
    if (cursor < raw.length) parts.push({ kind: 'literal', value: raw.slice(cursor) });
    if (parts.some(part => part.kind === 'literal' && /[<>]/.test(part.value))) return partial('Converter arguments or unbalanced rule parameter');
    segments.push({ kind: 'segment', parts });
  }
  pattern.alternatives = [segments]; return pattern;
}
/** Django built-ins, including lowercase UUIDs and ASCII slugs. Path converters
 * accept nonempty strings beginning with a slash, unlike Werkzeug's path. */
export function compileDjangoPath(original: string): RoutePattern {
  const pattern: RoutePattern = { version: 1, dialect: 'django-path', original, status: 'exact', alternatives: [], caseSensitive: true, strict: true };
  const partial = (reason: string): RoutePattern => ({ ...pattern, status: 'partial', reason });
  if (original.length > 4096 || !original.startsWith('/') || original.includes('//') || /[\\?#]/.test(original)) return partial('Unsupported Django path syntax');
  const segments: RouteSegment[] = [], names = new Set<string>();
  for (const raw of original.split('/').filter(Boolean)) {
    const rest = /^<path:([A-Za-z_]\w*)>$/.exec(raw);
    if (rest) { if (names.has(rest[1]!)) return partial('Duplicate Django converter name'); names.add(rest[1]!); segments.push({ kind: 'rest', name: rest[1]!, minimum: 1 }); continue; }
    const parts: RoutePart[] = []; let cursor = 0;
    for (const match of raw.matchAll(/<(?:(\w+):)?([A-Za-z_]\w*)>/g)) {
      if (match.index! > cursor) parts.push({ kind: 'literal', value: raw.slice(cursor, match.index) });
      const converter = match[1] ?? 'str';
      if (names.has(match[2]!)) return partial('Duplicate Django converter name'); names.add(match[2]!);
      if (!['str', 'int', 'uuid', 'slug'].includes(converter)) return partial('Custom or embedded path converter requires a reviewed profile');
      parts.push({ kind: 'parameter', name: match[2]!, ...(converter !== 'str' ? { converter: converter as 'int' | 'uuid' | 'slug' } : {}) }); cursor = match.index! + match[0].length;
    }
    if (cursor < raw.length) parts.push({ kind: 'literal', value: raw.slice(cursor) });
    if (parts.some(part => part.kind === 'literal' && /[<>]/.test(part.value))) return partial('Unbalanced Django converter');
    segments.push({ kind: 'segment', parts });
  }
  pattern.alternatives = [segments]; return pattern;
}
/** Translate a bounded anchored literal/named-converter subset. Arbitrary
 * target regexes, assertions, alternations and Python regex syntax never run. */
export function djangoRegexRoute(original: string, include = false): string | undefined {
  if (original.length > 4096 || !original.startsWith('^')) return undefined;
  let body = original.slice(1);
  if (include && (body.endsWith('\\Z') || body.endsWith('$'))) return undefined;
  if (body.endsWith('\\Z')) body = body.slice(0, -2); else if (body.endsWith('$')) body = body.slice(0, -1); else if (!include) return undefined;
  let route = '', cursor = 0;
  while (cursor < body.length) {
    if (body.startsWith('(?P<', cursor)) {
      const nameEnd = body.indexOf('>', cursor + 4), end = body.indexOf(')', nameEnd + 1), name = body.slice(cursor + 4, nameEnd), converter = { '[0-9]+': 'int', '[^/]+': 'str', '[-a-zA-Z0-9_]+': 'slug', '[a-zA-Z0-9_-]+': 'slug', '.+': 'path' }[body.slice(nameEnd + 1, end)];
      if (nameEnd < 0 || end < 0 || !/^[A-Za-z_]\w*$/.test(name) || !converter) return undefined;
      route += `<${converter}:${name}>`; cursor = end + 1;
    } else if (body.startsWith('\\.', cursor)) { route += '.'; cursor += 2; }
    else if (/^[A-Za-z0-9_\-/]$/.test(body[cursor]!)) route += body[cursor++];
    else return undefined;
  }
  return route;
}
export function matchRoutePattern(pattern: RoutePattern, pathname: string, strictHoles = true): boolean {
  if (['go-servemux-121', 'go-servemux-122', 'chi-5', 'gin-1', 'echo-4', 'echo-5', 'fiber-2', 'fiber-3', 'gorilla-1'].includes(pattern.dialect)) return matchGoPath(pattern, pathname, strictHoles);
  if (['nitro-2', 'nuxt-page'].includes(pattern.dialect) && pathname.includes('//')) return false;
  if (pattern.dialect === 'astro') {
    // Repeated encoding has version-specific fallback semantics. The common
    // profile qualifies one decoding pass without guessing a percent cascade.
    if (/%25/i.test(pathname)) return false;
    try { pathname = decodeURI(pathname); } catch { return false; }
  }
  if (pattern.dialect === 'sveltekit') {
    try { pathname = pathname.split('/').map(segment => decodeURIComponent(segment)).join('/'); }
    catch { return false; }
  }
  if (pattern.status === 'partial') return !pattern.prefix || pathname.includes('{*}') || pathname.startsWith(pattern.prefix);
  const django = pattern.dialect.startsWith('django-');
  const parameter = (part: RoutePart) => part.kind === 'literal' ? escaped(part.value) : part.converter === 'int' ? '[0-9]+' : part.converter === 'float' ? pattern.dialect === 'werkzeug' ? '[0-9]+\\.[0-9]+' : '[0-9]+(?:\\.[0-9]+)?' : part.converter === 'slug' ? '[-a-zA-Z0-9_]+' : part.converter === 'uuid' ? django ? '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' : '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}' : '[^/]+';
  if ((['starlette', 'werkzeug'].includes(pattern.dialect) || django) && !pathname.includes('{*}')) {
    return pattern.alternatives.some(segments => {
      const body = segments.map(segment => segment.kind === 'rest' ? segment.minimum ? django ? '.+' : '[^/].*' : '.*' : segment.parts.map(parameter).join('')).join('/');
      const suffix = pattern.original !== '/' && pattern.original.endsWith('/') ? '/' : '';
      return new RegExp(`^/${body}${pattern.strict ? suffix : body ? '/?' : ''}$`).test(pathname);
    });
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
      const regex = segment.parts.map(parameter).join('');
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
