import type { RoutePart, RoutePattern, RouteSegment, RoutingContract } from './contracts.js';
export interface GoPattern { path: string; methods: string[] | '*'; host?: string; pattern: RoutePattern; invalid?: boolean }
const identifier = /^[\p{L}_][\p{L}\p{Nd}_]*$/u;
const literal = (value: string): RouteSegment => ({ kind: 'segment', parts: [{ kind: 'literal', value }] });
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Keep only an ASCII literal prefix before opaque syntax or escaped spellings.
// An impossible raw prefix must not hide a competing unreviewed registration.
const opaquePrefix = (value: string): string | undefined => /^\/[A-Za-z0-9/_.-]*/.exec(value)?.[0];
export function compileGoMux(original: string, modern: boolean): GoPattern {
  let path = original, methods: string[] | '*' = '*', host: string | undefined;
  if (modern) { const token = /^([^ \t]+)[ \t]+/.exec(path); if (token) { methods = token[1] === 'GET' ? ['GET', 'HEAD'] : [token[1]!]; path = path.slice(token[0].length); } }
  if (!path.startsWith('/')) { const slash = path.indexOf('/'); if (slash >= 0) { host = path.slice(0, slash); path = path.slice(slash); } }
  const pattern: RoutePattern = { version: 1, dialect: modern ? 'go-servemux-122' : 'go-servemux-121', original: path, status: 'exact', alternatives: [], caseSensitive: true, strict: true };
  const partial = (reason: string, invalid = false): GoPattern => ({ path, methods, ...(host ? { host } : {}), pattern: { ...pattern, status: 'partial', reason, prefix: opaquePrefix(path) }, ...(invalid ? { invalid } : {}) });
  if (!path.startsWith('/') || path.length > 4096 || host && /[\s{}:]/.test(host)) return partial('Invalid or unreviewed host/path pattern', modern);
  if (modern && (Array.isArray(methods) && !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(methods[0]!) || path.includes('//') || path.split('/').some(part => part === '.' || part === '..'))) return partial('Invalid/unclean ServeMux pattern', true);
  if (/\\|[?#]/.test(path)) return partial('Escaped/query-like path syntax requires a separate profile');
  const segments: RouteSegment[] = [], names = new Set<string>(), raw = path.slice(1).split('/'); if (!raw.at(-1)) raw.pop();
  for (const [index, part] of raw.entries()) {
    if (modern && part === '{$}') { if (index !== raw.length - 1) return partial('End wildcard must terminate the pattern', true); pattern.original = path.slice(0, -3); continue; }
    const wildcard = modern && /^\{([^{}]+?)(\.\.\.)?\}$/.exec(part);
    if (wildcard) {
      const name = wildcard[1]!; if (!identifier.test(name) || names.has(name)) return partial('Invalid or duplicate Go wildcard identifier', true); names.add(name);
      if (wildcard[2]) { if (index !== raw.length - 1) return partial('Multi wildcard must terminate the pattern', true); segments.push({ kind: 'rest', name, minimum: 0 }); }
      else segments.push({ kind: 'segment', parts: [{ kind: 'parameter', name }] });
    } else {
      if (modern && /[{}]/.test(part)) return partial('Wildcards must occupy an entire Go path segment', true);
      try { segments.push(literal(modern ? decodeURIComponent(part) : part)); } catch { segments.push(literal(part)); }
    }
  }
  if (path.endsWith('/')) segments.push({ kind: 'rest', name: 'subtree', minimum: 0 });
  pattern.alternatives = [segments]; return { path, methods, ...(host ? { host } : {}), pattern };
}
export function compileChiPath(original: string): RoutePattern {
  const pattern: RoutePattern = { version: 1, dialect: 'chi-5', original, status: 'exact', alternatives: [], caseSensitive: true, strict: true };
  const partial = (reason: string): RoutePattern => ({ ...pattern, status: 'partial', reason, prefix: opaquePrefix(original) });
  if (!original.startsWith('/') || original.length > 4096 || /[\\?#]/.test(original)) return partial('Invalid or unreviewed Chi path syntax');
  const segments: RouteSegment[] = [], names = new Set<string>(), raw = original.slice(1).split('/'); if (!raw.at(-1)) raw.pop();
  for (const [index, part] of raw.entries()) {
    if (part === '*') { if (index !== raw.length - 1) return partial('Chi wildcard must terminate the path'); segments.push({ kind: 'rest', name: 'wildcard', minimum: 0 }); continue; }
    const parts: RoutePart[] = []; let cursor = 0;
    for (const match of part.matchAll(/\{([^{}:]+)(?::([^{}]+))?\}/g)) {
      if (names.has(match[1]!)) return partial('Duplicate Chi parameter'); names.add(match[1]!);
      if (match.index! > cursor) parts.push({ kind: 'literal', value: part.slice(cursor, match.index) });
      const regex = match[2], converter = regex === '[0-9]+' || regex === '\\d+' ? 'int' : ['[a-zA-Z0-9_-]+', '[A-Za-z0-9_-]+', '[-a-zA-Z0-9_]+'].includes(regex ?? '') ? 'slug' : undefined;
      if (regex && !converter) return partial('Chi RE2 constraint requires a reviewed bounded matcher');
      parts.push({ kind: 'parameter', name: match[1]!, ...(converter ? { converter } : {}) }); cursor = match.index! + match[0].length;
    }
    if (cursor < part.length) parts.push({ kind: 'literal', value: part.slice(cursor) });
    if (parts.some(value => value.kind === 'literal' && /[{}*]/.test(value.value))) return partial('Unbalanced or unreviewed embedded Chi pattern');
    segments.push({ kind: 'segment', parts });
  }
  pattern.alternatives = [segments]; return pattern;
}
export function compileGinPath(original: string): RoutePattern {
  const pattern: RoutePattern = { version: 1, dialect: 'gin-1', original, status: 'exact', alternatives: [], caseSensitive: true, strict: true };
  const partial = (reason: string): RoutePattern => ({ ...pattern, status: 'partial', reason, prefix: opaquePrefix(original) });
  if (!original.startsWith('/') || original.length > 4096 || /[\\?#]/.test(original)) return partial('Invalid or unreviewed Gin path syntax');
  const segments: RouteSegment[] = [], raw = original.slice(1).split('/'); if (!raw.at(-1)) raw.pop();
  for (const [index, part] of raw.entries()) {
    const star = part.indexOf('*'), colon = part.indexOf(':');
    if (star >= 0) { if (star !== 0 || index !== raw.length - 1 || part.length === 1 || part.slice(1).includes(':') || part.slice(1).includes('*')) return partial('Invalid Gin catch-all'); segments.push({ kind: 'rest', name: part.slice(1), minimum: 0 }); }
    else if (colon >= 0) { if (colon === part.length - 1 || part.slice(colon + 1).includes(':')) return partial('Invalid Gin parameter'); segments.push({ kind: 'segment', parts: [...colon ? [{ kind: 'literal' as const, value: part.slice(0, colon) }] : [], { kind: 'parameter', name: part.slice(colon + 1) }] }); }
    else segments.push(literal(part));
  }
  pattern.alternatives = [segments]; return pattern;
}
export function compileEchoPath(original: string, major: 4 | 5): RoutePattern {
  const path = original.startsWith('/') ? original : `/${original}`;
  const pattern = compileGinPath(path.replace(/\/\*$/, '/*catchall'));
  pattern.dialect = `echo-${major}`; pattern.original = path;
  if (path === '/*') pattern.alternatives = [[{ kind: 'rest', name: 'wildcard', minimum: 0 }]];
  return pattern;
}
export function compileFiberPath(original: string, major: 2 | 3, options: { caseSensitive?: boolean; strict?: boolean; unescape?: boolean; integerBits?: 32 | 64 } = {}): RoutePattern {
  const path = original ? original.startsWith('/') ? original : `/${original}` : '/';
  const pattern: RoutePattern = { version: 1, dialect: `fiber-${major}`, original: path, status: 'exact', alternatives: [], caseSensitive: options.caseSensitive ?? false, strict: options.strict ?? false, encoded: !options.unescape, integerBits: options.integerBits ?? 64 };
  const partial = (reason: string): RoutePattern => ({ ...pattern, status: 'partial', reason, prefix: opaquePrefix(path) });
  if (path.length > 4096 || /[\\#]/.test(path)) return partial('Unreviewed Fiber escapes or path length');
  let alternatives: RouteSegment[][] = [[]]; const raw = path.slice(1).split('/'); if (!raw.at(-1)) raw.pop();
  for (const [index, part] of raw.entries()) {
    if (['*', '+'].includes(part)) { if (index !== raw.length - 1) return partial('Nonterminal Fiber greedy parameters require a separate matcher'); alternatives.forEach(items => items.push({ kind: 'rest', name: part, minimum: part === '+' ? 1 : 0 })); continue; }
    const optional = /^:([A-Za-z0-9_]+)(?:<(int|float|uuid|bool)>)?\?$/.exec(part);
    if (optional) { if (alternatives.length >= 32) return partial('Optional Fiber parameters exceed the expansion budget'); const parameter: RouteSegment = { kind: 'segment', parts: [{ kind: 'parameter', name: optional[1]!, ...(optional[2] === 'int' ? { converter: 'go-int' as const } : {}) }] }; if (optional[2] && optional[2] !== 'int') return partial('Unreviewed Fiber constraint'); alternatives = alternatives.flatMap(items => [items, [...items, parameter]]); continue; }
    const parts: RoutePart[] = []; let cursor = 0;
    for (const match of part.matchAll(/:([A-Za-z0-9_]+)(?:<([^<>]+)>)?/g)) {
      if (match.index! > cursor) parts.push({ kind: 'literal', value: part.slice(cursor, match.index) });
      if (match[2] && match[2] !== 'int') return partial('Fiber constraint requires a reviewed bounded matcher');
      parts.push({ kind: 'parameter', name: match[1]!, ...(match[2] ? { converter: 'go-int' as const } : {}) }); cursor = match.index! + match[0].length;
    }
    if (cursor < part.length) parts.push({ kind: 'literal', value: part.slice(cursor) });
    if (parts.some(item => item.kind === 'literal' && /[:*+?<>]/.test(item.value))) return partial('Unreviewed Fiber path syntax');
    if (parts.some((item, i) => item.kind === 'parameter' && parts[i + 1]?.kind === 'parameter') || parts.length > 1 && parts.some(item => item.kind === 'parameter' && item.converter)) return partial('Adjacent or embedded constrained Fiber parameters require a delimiter matcher');
    alternatives.forEach(items => items.push({ kind: 'segment', parts }));
  }
  pattern.alternatives = alternatives; return pattern;
}
export function compileGorillaPath(original: string, options: { prefix?: boolean; strict?: boolean; encoded?: boolean; skipClean?: boolean } = {}): RoutePattern {
  const pattern = compileChiPath(original); pattern.dialect = 'gorilla-1'; pattern.strict = true; pattern.encoded = options.encoded ?? false; pattern.skipClean = options.skipClean ?? false; pattern.pathPrefix = options.prefix;
  // PathPrefix is a byte prefix, including a partial final segment.
  if (options.prefix && /[{}]/.test(original)) return { ...pattern, status: 'partial', reason: 'Templated Gorilla PathPrefix requires a prefix matcher', prefix: opaquePrefix(original) };
  return pattern;
}
function goEscapePath(path: string): string {
  return encodeURIComponent(path).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`).replace(/%2F|%3A|%40|%26|%3D|%2B|%24|%2C|%3B/g, text => decodeURIComponent(text));
}
export function matchGoPath(pattern: RoutePattern, path: string, strictHoles = true): boolean {
  if (pattern.status === 'partial') return !pattern.prefix || path.includes('{*}') || path.startsWith(pattern.prefix);
  if (!path.startsWith('/')) return false;
  const modern = pattern.dialect === 'go-servemux-122', mux = modern || pattern.dialect === 'go-servemux-121';
  const fiber = pattern.dialect.startsWith('fiber-'), echo = pattern.dialect.startsWith('echo-'), gorilla = pattern.dialect === 'gorilla-1';
  if (mux && (path.includes('//') || path.split('/').some(part => part === '.' || part === '..'))) return false; // Redirects have no application handler.
  if (gorilla && !pattern.skipClean && (path.includes('//') || path.split('/').some(part => part === '.' || part === '..'))) return false;
  let parts: string[];
  try {
    if (modern) parts = path.slice(1).split('/').map(decodeURIComponent);
    else { const decoded = decodeURIComponent(path); if (!(fiber || gorilla) || !pattern.encoded) { if (!(pattern.dialect === 'chi-5' || echo) || goEscapePath(decoded) === path) path = decoded; } if (!pattern.caseSensitive) path = path.toLowerCase(); parts = path.slice(1).split('/'); }
  } catch { return false; }
  if (pattern.pathPrefix) return path.startsWith(pattern.caseSensitive ? pattern.original : pattern.original.toLowerCase());
  const slash = path.endsWith('/'); if (!parts.at(-1)) parts.pop();
  return pattern.alternatives.some(segments => {
    const rest = segments.at(-1)?.kind === 'rest';
    if (pattern.strict && !rest && slash !== pattern.original.endsWith('/') && path !== '/') return false;
    if (!fiber && rest && parts.length === segments.length - 1 && !slash && path !== '/') return false;
    let cursor = 0;
    for (const segment of segments) {
      if (segment.kind === 'rest') return parts.length - cursor >= segment.minimum;
      const value = parts[cursor++]; if (value === undefined) return false;
      if (value === '{*}') { if (strictHoles && !(segment.parts.length === 1 && segment.parts[0]?.kind === 'parameter')) return false; continue; }
      const regex = segment.parts.map(part => part.kind === 'literal' ? escape(part.value) : part.converter === 'int' ? '[0-9]+' : part.converter === 'go-int' ? '[+-]?[0-9]+' : part.converter === 'slug' ? '[-A-Za-z0-9_]+' : modern ? '.+' : '[^/]+').join('');
      if (!new RegExp(`^${regex}$`, pattern.caseSensitive ? '' : 'i').test(value)) return false;
      if (segment.parts.length === 1 && segment.parts[0]?.kind === 'parameter' && segment.parts[0].converter === 'go-int') { const bits = BigInt(pattern.integerBits ?? 64), integer = BigInt(value); if (integer < -(1n << (bits - 1n)) || integer >= 1n << (bits - 1n)) return false; }
    }
    return cursor === parts.length;
  });
}
/** A safe subset of ServeMux's request-set ordering. Incomparable paths stay
 * ambiguous; target regexes never execute. Also used to detect startup conflicts. */
export function goRouteSubset(a: RoutingContract, b: RoutingContract): boolean {
  if (a.host !== b.host && b.host) return false;
  if (b.methods !== '*' && (a.methods === '*' || a.methods.some(method => !b.methods.includes(method)))) return false;
  const x = a.pattern.alternatives[0], y = b.pattern.alternatives[0]; if (!x || !y || a.pattern.status !== 'exact' || b.pattern.status !== 'exact') return false;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const left = x[i], right = y[i];
    if (right?.kind === 'rest') return i < x.length || a.pattern.original.endsWith('/');
    if (!left || !right || left.kind === 'rest') return false;
    if (right.parts.length === 1 && right.parts[0]?.kind === 'parameter' && !right.parts[0].converter) continue;
    if (JSON.stringify(left.parts.map(part => part.kind === 'literal' ? part : { kind: part.kind, converter: part.converter })) !== JSON.stringify(right.parts.map(part => part.kind === 'literal' ? part : { kind: part.kind, converter: part.converter }))) return false;
  }
  return a.pattern.original.endsWith('/') === b.pattern.original.endsWith('/');
}
export function goPatternsOverlap(a: RoutePattern, b: RoutePattern): boolean {
  const x = a.alternatives[0], y = b.alternatives[0]; if (!x || !y) return true;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const left = x[i], right = y[i]; if (left?.kind === 'rest' || right?.kind === 'rest') return !!left && !!right || left?.kind === 'rest' && b.original.endsWith('/') || right?.kind === 'rest' && a.original.endsWith('/');
    if (!left || !right) return false;
    if (left.parts.every(part => part.kind === 'literal') && right.parts.every(part => part.kind === 'literal') && left.parts.map(part => part.value).join('') !== right.parts.map(part => part.value).join('')) return false;
  }
  return a.original.endsWith('/') === b.original.endsWith('/');
}
export function preferGoRoutes<T>(items: T[], contract: (item: T) => RoutingContract | undefined, method?: string): T[] {
  if (items.length < 2) return items;
  return items.filter(item => !items.some(other => {
    if (other === item) return false; const first = contract(other), second = contract(item);
    if (!first || !second || ['rails','aspnet'].includes(first.dispatch?.dialect ?? '') || ['rails','aspnet'].includes(second.dispatch?.dialect ?? '') || first.conditions.length || second.conditions.length) return false;
    const left = [...first.guards ?? [], first], right = [...second.guards ?? [], second];
    if (method && left[0]?.dispatch?.root === right[0]?.dispatch?.root && !!first.fallbackMethods?.includes(method) !== !!second.fallbackMethods?.includes(method)) return !first.fallbackMethods?.includes(method);
    for (let level = 0; level < Math.min(left.length, right.length); level++) {
      const a = left[level]!, b = right[level]!;
      if (!a.dispatch || !b.dispatch || a.dispatch.root !== b.dispatch.root || a.dispatch.dialect !== b.dispatch.dialect || a.conditions.length || b.conditions.length) return false;
      if (a.dispatch.order === b.dispatch.order && level < Math.min(left.length, right.length) - 1) continue;
      if (method && !!a.fallbackMethods?.includes(method) !== !!b.fallbackMethods?.includes(method)) return !a.fallbackMethods?.includes(method);
      if (a.dispatch.dialect === 'go-servemux') return !!a.host && !b.host || goRouteSubset(a, b) && !goRouteSubset(b, a);
      if (['fiber', 'gorilla'].includes(a.dispatch.dialect)) return a.dispatch.order < b.dispatch.order;
      const x = a.pattern.alternatives[0], y = b.pattern.alternatives[0]; if (!x || !y || a.pattern.status !== 'exact' || b.pattern.status !== 'exact') return false;
      for (let i = 0; i < Math.min(x.length, y.length); i++) {
        const rank = (segment: RouteSegment) => segment.kind === 'rest' ? 0 : segment.parts.every(part => part.kind === 'literal') ? 3 : segment.parts.some(part => part.kind === 'parameter' && part.converter) ? 2 : 1;
        if (rank(x[i]!) !== rank(y[i]!)) return rank(x[i]!) > rank(y[i]!);
      } return !!b.notFoundFallback && !a.notFoundFallback && goRouteSubset({ ...a, methods: '*' }, { ...b, methods: '*' }) && goRouteSubset({ ...b, methods: '*' }, { ...a, methods: '*' });
    } return false;
  }));
}
