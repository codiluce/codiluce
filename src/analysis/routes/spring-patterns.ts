import type { Entity } from '../../core/graph.js';
import type { RoutePattern, RoutingContract } from './contracts.js';
export interface SpringPathData { segments: { expression: string; capture: boolean; wildcard: boolean }[]; catchAll: boolean; score: number; length: number }
const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Reviewed PathPattern grammar; expressions are generated from literal tokens
 * and fixed character classes. Arbitrary target Java regex is never run. */
export function compileSpringPath(original: string, dialect: 'spring-path-6.2' | 'spring-path-7.0'): RoutePattern {
  const pattern: RoutePattern = { version: 1, dialect, original, status: 'exact', alternatives: [], caseSensitive: true, strict: true };
  const partial = (reason: string): RoutePattern => ({ ...pattern, status: 'partial', reason, prefix: /^\/[\p{L}\p{N}_./-]*/u.exec(original)?.[0] ?? '/' });
  if (original.length > 4096 || !original.startsWith('/') || /[\\#]/.test(original) || original.includes('${') || original.includes('#{')) return partial('Opaque/escaped/placeholder Spring path requires a reviewed pattern profile');
  const segments: SpringPathData['segments'] = [], names = new Set<string>();
  let catchAll = false, score = 0, length = 0;
  const pieces = original.slice(1).split('/');
  for (let position = 0; position < pieces.length; position++) {
    const raw = pieces[position]!;
    if (raw === '**' || /^\{\*[A-Za-z_]\w*\}$/.test(raw)) {
      if (position !== pieces.length - 1) return partial('Spring catch-all must be the final path element');
      const name = raw.startsWith('{') ? raw.slice(2, -1) : undefined;
      if (name && names.has(name)) return partial('Duplicate Spring path variable');
      catchAll = true; break;
    }
    let expression = '', capture = false, wildcard = false, variableLengths = 0; length++;
    for (let cursor = 0; cursor < raw.length;) {
      const token = raw[cursor]!;
      if (token === '*') { if(++variableLengths>1)return partial('Multiple variable-length tokens in one Spring segment require a bounded automaton profile');expression += '[\\s\\S]*'; wildcard = true; score += 100; length++; cursor++; }
      else if (token === '?') { expression += '[\\s\\S]'; wildcard = true; length++; cursor++; }
      else if (token === '{') {
        if(++variableLengths>1)return partial('Multiple variable-length tokens in one Spring segment require a bounded automaton profile');
        const end = raw.indexOf('}', cursor + 1), body = raw.slice(cursor + 1, end), separator = body.indexOf(':'), name = separator < 0 ? body : body.slice(0, separator), constraint = separator < 0 ? undefined : body.slice(separator + 1);
        if (end < 0 || !/^[A-Za-z_]\w*$/.test(name) || names.has(name)) return partial('Malformed/duplicate Spring path capture');
        names.add(name); capture = true; score++; length++;
        const reviewed: Record<string,string> = { '[0-9]+': '[0-9]+', '[a-z]+': '[a-z]+', '[A-Za-z]+': '[A-Za-z]+', '[a-zA-Z]+': '[A-Za-z]+', '[A-Za-z0-9_-]+': '[A-Za-z0-9_-]+', '[a-zA-Z0-9_-]+': '[A-Za-z0-9_-]+' };
        if (constraint && !reviewed[constraint]) return partial('Custom Java path regex requires a reviewed constrained pattern profile');
        expression += constraint ? reviewed[constraint] : '[\\s\\S]+'; cursor = end + 1;
      } else if (token === '}' || token === ';') return partial('Malformed capture or literal matrix-parameter Spring pattern');
      else { expression += escaped(token); length++; cursor++; }
    }
    segments.push({ expression, capture, wildcard });
  }
  pattern.spring = { segments, catchAll, score, length };
  return pattern;
}
export function combineSpringPath(base: string, child: string): string | undefined {
  if (!base) return child.startsWith('/') ? child : '/' + child;
  if (!child) return base.startsWith('/') ? base : '/' + base;
  // PathPattern has special extension/wildcard combination rules. Only the
  // reviewed terminal /* removal and ordinary literal/capture join are used.
  if (base.includes('**') || base.includes('{*') || /\*\./.test(base)) return undefined;
  if (base.endsWith('/*')) base = base.slice(0, -2);
  return base.replace(/\/$/, '') + '/' + child.replace(/^\//, '');
}
export function matchSpringPath(pattern: RoutePattern, pathname: string, strictHoles = true): boolean {
  if (pattern.status === 'partial') return !pattern.prefix || pathname.includes('{*}') || pathname.startsWith(pattern.prefix);
  const data = pattern.spring; if (!data || !pathname.startsWith('/') || pathname.length > 16384) return false;
  const request = pathname.slice(1).split('/');
  if (!data.catchAll && request.length !== data.segments.length || data.catchAll && request.length < data.segments.length) return false;
  for (let i = 0; i < data.segments.length; i++) {
    const value = request[i]!;
    if (value === '{*}') { if (strictHoles && (!data.segments[i]!.capture || data.segments[i]!.expression !== '[\\s\\S]+')) return false; continue; }
    let decoded: string;
    try { decoded = decodeURIComponent(value.split(';')[0]!); } catch { return false; }
    if (!new RegExp(`^(?:${data.segments[i]!.expression})$`).test(decoded)) return false;
  }
  // A terminal catch-all includes the empty path after its preceding element,
  // without normalizing duplicate separators, case or trailing slashes.
  if (data.catchAll) for (const value of request.slice(data.segments.length)) { try { decodeURIComponent(value); } catch { return false; } }
  return true;
}
export interface SpringNameCondition { name: string; value?: string; negated: boolean }
export function springNameCondition(value: string): SpringNameCondition | undefined {
  if (value.length > 2048) return undefined;
  const equal = value.indexOf('='), negated = equal >= 0 ? value[equal - 1] === '!' : value.startsWith('!'), name = equal >= 0 ? value.slice(0, negated ? equal - 1 : equal) : value.slice(negated ? 1 : 0);
  return name && !/[\s!=&]/.test(name) ? { name, negated, ...equal >= 0 ? { value: value.slice(equal + 1) } : {} } : undefined;
}
export function matchSpringParams(contract: RoutingContract, query: URLSearchParams): boolean {
  return (contract.spring?.params ?? []).every(item => {
    const match = item.value === undefined ? query.has(item.name) || query.has(item.name+'.x') || query.has(item.name+'.y') : query.get(item.name) === item.value;
    return item.negated ? !match : match;
  });
}
/** Only unconstrained same-context mappings are compared. Unknown headers,
 * versions, custom conditions or registration gaps stay competing candidates. */
export function preferSpringRoutes<T extends Entity>(entities: T[], contractFor: (entity: T) => RoutingContract | undefined, method?: string): T[] {
  const spring = entities.filter(entity => contractFor(entity)?.dispatch?.dialect === 'spring');
  if (spring.length < 2 || spring.length !== entities.length || new Set(spring.map(entity => contractFor(entity)!.dispatch!.root)).size !== 1 || spring.some(entity => entity.metadata.constraintsUnresolved || !contractFor(entity)?.pattern.spring || contractFor(entity)!.pattern.status !== 'exact')) return entities;
  const compare = (left: RoutingContract, right: RoutingContract) => {
    if (method === 'HEAD') { const a = left.spring?.declaredMethods?.includes('HEAD'), b = right.spring?.declaredMethods?.includes('HEAD'); if (a !== b) return a ? -1 : 1; }
    const a = left.pattern.spring!, b = right.pattern.spring!;
    if (a.catchAll !== b.catchAll) return a.catchAll ? 1 : -1;
    if (a.catchAll && a.length !== b.length) return b.length - a.length;
    if (a.score !== b.score) return a.score - b.score;
    if (a.length !== b.length) return b.length - a.length;
    const params = (right.spring?.params?.length ?? 0) - (left.spring?.params?.length ?? 0);
    if (params) return params;
    const positive = (contract: RoutingContract) => contract.spring?.params?.filter(item => !item.negated && item.value !== undefined).length ?? 0;
    if (positive(left) !== positive(right)) return positive(right) - positive(left);
    return (left.methods === '*' ? 1 : 0) - (right.methods === '*' ? 1 : 0);
  };
  const sorted = [...spring].sort((a,b) => compare(contractFor(a)!,contractFor(b)!)), best = contractFor(sorted[0]!)!;
  const winners = sorted.filter(entity => compare(contractFor(entity)!,best) === 0), handlers = new Set<string>();
  return winners.filter(entity => { const handler = String(entity.metadata.handler ?? entity.id); if (handlers.has(handler)) return false; handlers.add(handler); return true; });
}
