import type { Entity } from '../../core/graph.js';
import type { RoutePattern, RouteSegment, RoutingContract } from './contracts.js';

export type RailsConstraint = 'digits' | 'slug' | 'segment-with-dots';
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function normalizeRailsPath(path: string): string { return ('/' + path).replace(/\/+/g, '/').replace(/\/$/, '').replace(/%[a-f0-9]{2}/g, value => value.toUpperCase()) || '/'; }
function groups(text: string, nesting = 0): string[] | undefined {
  if (nesting > 16) return;
  const start = text.indexOf('('); if (start < 0) return text.includes(')') ? undefined : [text];
  let depth = 0, end = -1;
  for (let i = start; i < text.length; i++) { if (text[i] === '(') depth++; else if (text[i] === ')' && --depth === 0) { end = i; break; } }
  if (end < 0 || depth > 16) return;
  const body = groups(text.slice(start + 1, end), nesting + 1), tail = groups(text.slice(end + 1), nesting + 1);
  if (!body || !tail || tail.length * (body.length + 1) > 32) return;
  return tail.flatMap(suffix => [text.slice(0, start) + suffix, ...body.map(part => text.slice(0, start) + part + suffix)]);
}
/** Reviewed Journey tokens and fixed constraint translations. No target
 * regular expression, router or executable configuration runs. */
export function compileRailsPath(path: string, format?: boolean | string, constraints: Record<string, RailsConstraint> = {}): RoutePattern {
  let original = normalizeRailsPath(path).replace(/\/(\(+)\/?/g, '$1/');
  // Mapper moves the slash into leading optional groups. Entirely optional
  // parameter paths retain a leading slash so the empty alternative is '/'.
  if (/^(\(+[^)]+\))(\(+\/:[^)]+\))*$/.test(original)) original = original.replace(/^(\(+)\//, '/$1');
  const pattern: RoutePattern = { version: 1, dialect: 'rails', original, status: 'exact', alternatives: [], caseSensitive: true, strict: false };
  const partial = (reason: string): RoutePattern => ({ ...pattern, status: 'partial', reason, prefix: original.match(/^[A-Za-z0-9_/.~-]*/)?.[0] || '/', alternatives: [] });
  if (original.length > 4096 || /[^\x21-\x7e]|[\\?#\[\]{}%"<>`^|]/.test(original)) return partial('Unreviewed Rails path encoding or token syntax');
  if (typeof format === 'string' && !/^[A-Za-z0-9_-]+$/.test(format)) return partial('Custom Rails format expression requires a reviewed matcher');
  const formatted = format === true ? original + '.:format' : format !== false && !original.includes('(.:format)') ? original + '(.:format)' : original;
  const variants = groups(formatted); if (!variants) return partial('Rails optional groups exceed the bounded parser or are unbalanced');
  const sources: string[] = [];
  for (const variant of variants) {
    if (variant.split('/').some(segment => (segment.match(/[:*][A-Za-z_]\w*/g)?.length ?? 0) > 2 || /[:*][A-Za-z_]\w*[:*]/.test(segment))) return partial('Ambiguous adjacent Rails parameters exceed the reviewed matcher');
    let ambiguous = 0;
    for (const segment of variant.split('/')) {
      const tokens = [...segment.matchAll(/([:*])([A-Za-z_]\w*)/g)]; if (tokens.length < 2) continue;
      const left = tokens[0]!, right = tokens[1]!, separator = segment.slice(left.index! + left[0].length, right.index), converter = constraints[left[2]!];
      const consumes = (character: string) => left[1] === '*' ? true : converter === 'digits' ? /[0-9]/.test(character) : converter === 'slug' ? /[-A-Za-z0-9_]/.test(character) : converter === 'segment-with-dots' ? character !== '/' : !'/?.'.includes(character);
      if ([...separator].every(consumes) && ++ambiguous > 1) return partial('Multiple ambiguous Rails segments require a bounded matcher summary');
    }
    let source = '', cursor = 0, rest = 0; const names = new Set<string>(), segments: RouteSegment[] = [];
    for (const match of variant.matchAll(/([:*])([A-Za-z_]\w*)/g)) {
      if (names.has(match[2]!)) return partial('Duplicate Rails path parameter'); names.add(match[2]!);
      const literal = variant.slice(cursor, match.index); if (/[:*]/.test(literal)) return partial('Invalid Rails parameter or wildcard');
      source += escape(literal);
      const name = match[2]!, converter = constraints[name];
      if (match[1] === '*') { if (++rest > 1) return partial('Multiple Rails globs require a bounded ambiguity summary'); source += '[\\s\\S]+?'; }
      else source += converter === 'digits' ? '[0-9]+' : converter === 'slug' ? '[-A-Za-z0-9_]+' : converter === 'segment-with-dots' ? '[^/]+' : name === 'format' && format === true ? '[^\\n]+' : name === 'format' && typeof format === 'string' ? escape(format) : '[^/.?]+';
      cursor = match.index! + match[0].length;
    }
    if (/[:*]/.test(variant.slice(cursor))) return partial('Invalid Rails parameter or wildcard');
    sources.push('^' + source + escape(variant.slice(cursor)) + '$');
    for (const raw of variant.split('/').filter(Boolean)) {
      if (/^\*\w+(?:\.:format)?$/.test(raw)) { segments.push({ kind: 'rest', name: raw.slice(1).split('.')[0]!, minimum: 1 }); continue; }
      const parts: Extract<RouteSegment, { kind: 'segment' }>['parts'] = []; let end = 0;
      for (const match of raw.matchAll(/:([A-Za-z_]\w*)/g)) { if (match.index! > end) parts.push({ kind: 'literal', value: raw.slice(end, match.index) }); parts.push({ kind: 'parameter', name: match[1]!, converter: constraints[match[1]!] === 'digits' ? 'int' : constraints[match[1]!] === 'slug' ? 'slug' : constraints[match[1]!] === 'segment-with-dots' ? undefined : 'rails-segment' }); end = match.index! + match[0].length; }
      if (end < raw.length) parts.push({ kind: 'literal', value: raw.slice(end) }); segments.push({ kind: 'segment', parts });
    }
    pattern.alternatives.push(segments);
  }
  return { ...pattern, rails: { sources } };
}
export function matchRailsLiteral(pattern: RoutePattern, pathname: string): boolean {
  if (pathname.length > 8192) return false;
  const normalized = normalizeRailsPath(pathname);
  return pattern.rails?.sources.some(source => new RegExp(source).test(normalized)) ?? false;
}
/** Journey prefers explicit HEAD routes globally before falling back to GET,
 * then uses insertion order. Unknown competitors remain visible. */
export function preferRailsRoutes(entities: Entity[], contract: (entity: Entity) => RoutingContract | undefined, method: string | undefined): Entity[] {
  const groups = new Map<string, Entity[]>();
  for (const entity of entities) { const dispatch = contract(entity)?.dispatch; if (dispatch?.dialect !== 'rails') continue; const group = groups.get(dispatch.root) ?? []; group.push(entity); groups.set(dispatch.root, group); }
  const keep = new Set(entities.map(entity => entity.id));
  for (let group of groups.values()) {
    const all = group, explicit = method === 'HEAD' ? group.filter(entity => !contract(entity)?.fallbackMethods?.includes('HEAD')) : [];
    if (explicit.some(entity => !entity.metadata.constraintsUnresolved)) group = explicit;
    const ordered = group.sort((a, b) => contract(a)!.dispatch!.order - contract(b)!.dispatch!.order);
    const selected = ordered.find(entity => !entity.metadata.constraintsUnresolved); if (!selected) continue;
    const order = contract(selected)!.dispatch!.order;
    for (const entity of all) {
      if (method === 'HEAD' && explicit.length && !explicit.some(item => !item.metadata.constraintsUnresolved) && explicit.includes(entity)) continue;
      if (contract(entity)!.dispatch!.order > order || method === 'HEAD' && !contract(selected)?.fallbackMethods?.includes('HEAD') && contract(entity)?.fallbackMethods?.includes('HEAD')) keep.delete(entity.id);
    }
  }
  return entities.filter(entity => keep.has(entity.id));
}
