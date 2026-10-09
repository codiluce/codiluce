import type { Entity } from '../../core/graph.js';
import type { RoutePattern, RoutePart, RouteSegment, RoutingContract } from './contracts.js';
export type RustRouteDialect = 'axum-0.7' | 'axum-0.8' | 'actix-web-4';
export interface RustPathData {
    sources: string[];
    prefixDefault?: boolean;
}
export interface RustEndpointData {
    resource: string;
    resourceOrder: number;
    routeOrder: number;
    fallback?: 'path' | 'method' | 'resource';
    resourceMethods?: string[] | '*';
    lineage?: {
        id: string;
        order: number;
    }[];
    headFallback?: boolean;
}
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const parameterName = /^[A-Za-z_]\w*$/;
function pathSegments(path: string): string[] | undefined {
    const segments: string[] = [];
    let current = '', depth = 0, characterClass = false, escaped = false;
    for (const c of path.slice(1)) {
        if (depth && escaped) {
            current += c;
            escaped = false;
            continue;
        }
        if (depth && c === '\\') {
            current += c;
            escaped = true;
            continue;
        }
        if (depth && c === '[')
            characterClass = true;
        else if (depth && c === ']')
            characterClass = false;
        if (!characterClass) {
            if (c === '{')
                depth++;
            else if (c === '}' && --depth < 0)
                return;
        }
        if (c === '/' && !depth) {
            segments.push(current);
            current = '';
        }
        else
            current += c;
    }
    if (depth || characterClass)
        return;
    segments.push(current);
    return segments;
}
function captures(raw: string): {
    index: number;
    end: number;
    name: string;
    constraint?: string;
}[] | undefined {
    const result: {
        index: number;
        end: number;
        name: string;
        constraint?: string;
    }[] = [];
    for (let i = 0; i < raw.length; i++)
        if (raw[i] === '{') {
            const start = i;
            let depth = 1, characterClass = false, escaped = false;
            while (++i < raw.length && depth) {
                const c = raw[i];
                if (escaped) {
                    escaped = false;
                    continue;
                }
                if (c === '\\') {
                    escaped = true;
                    continue;
                }
                if (c === '[')
                    characterClass = true;
                else if (c === ']')
                    characterClass = false;
                if (!characterClass) {
                    if (c === '{')
                        depth++;
                    else if (c === '}')
                        depth--;
                }
            }
            // The loop advances once after the terminating brace.
            const end = i;
            if (depth)
                return;
            const text = raw.slice(start + 1, end - 1), colon = text.indexOf(':');
            result.push({ index: start, end, name: colon < 0 ? text : text.slice(0, colon), ...colon < 0 ? {} : { constraint: text.slice(colon + 1) } });
            i = end - 1;
        }
    return result;
}
/** Original native path syntax. Only fixed regex translations are reviewed;
 * arbitrary target regexes, macros and framework code never execute. */
export function compileRustPath(original: string, dialect: RustRouteDialect, legacyLiterals = false): RoutePattern {
    const pattern: RoutePattern = { version: 1, dialect, original, status: 'exact', alternatives: [], caseSensitive: true, strict: true };
    const partial = (reason: string): RoutePattern => ({ ...pattern, status: 'partial', reason, prefix: original.match(/^\/[\w./~-]*/)?.[0] || '/', alternatives: [] });
    if (original.length > 4096 || /[?#\x00-\x1f\x7f]/.test(original))
        return partial('Rust path contains unreviewed URI/control syntax');
    const path = dialect === 'actix-web-4' && !original.startsWith('/') ? '/' + original : original;
    if (!path.startsWith('/') || path.includes('//'))
        return partial('Rust path must have a reviewed absolute slash structure');
    const segments: RouteSegment[] = [], names = new Set<string>();
    let source = '^';
    if (path === '/') {
        pattern.alternatives = [[]];
        return { ...pattern, rust: { sources: ['^/$'] } };
    }
    const rawSegments = pathSegments(path);
    if (!rawSegments)
        return partial('Unbalanced original Rust route capture');
    for (const [index, raw] of rawSegments.entries()) {
        source += '/';
        if (!raw) {
            if (index !== rawSegments.length - 1)
                return partial('Unreviewed empty Rust route segment');
            source += '';
            continue;
        }
        if (dialect !== 'actix-web-4') {
            const modern = dialect === 'axum-0.8', capture = modern ? /^\{(\*?)([^{}]+)\}$/.exec(raw) : /^([:*])(.+)$/.exec(raw);
            if (capture) {
                const rest = modern ? capture[1] === '*' : capture[1] === '*', name = capture[2]!;
                if (!parameterName.test(name) || names.has(name))
                    return partial('Invalid/duplicate original Axum capture');
                names.add(name);
                if (rest) {
                    if (index !== rawSegments.length - 1)
                        return partial('Axum wildcard must be the terminal segment');
                    segments.push({ kind: 'rest', name, minimum: 1 });
                    source += '.+';
                }
                else {
                    segments.push({ kind: 'segment', parts: [{ kind: 'parameter', name }] });
                    source += '[^/]+';
                }
                continue;
            }
            if (/[{}]/.test(raw) || !modern && /[:*]/.test(raw) || modern && /^[*:]/.test(raw) && !legacyLiterals)
                return partial('Embedded, escaped or version-incompatible Axum path syntax is unreviewed');
            segments.push({ kind: 'segment', parts: [{ kind: 'literal', value: raw }] });
            source += escape(raw);
            continue;
        }
        const parts: RoutePart[] = [];
        let cursor = 0;
        const matches = captures(raw);
        if (!matches)
            return partial('Unbalanced original Actix path capture');
        if (matches.length > 1)
            return partial('Multiple Actix captures in one segment require a bounded non-backtracking matcher');
        for (const match of matches) {
            const name = match.name, constraint = match.constraint, literal = raw.slice(cursor, match.index);
            if (!parameterName.test(name) || /[{}]/.test(literal) || names.has(name))
                return partial('Invalid/duplicate original Actix capture');
            names.add(name);
            if (literal) {
                parts.push({ kind: 'literal', value: literal });
                source += escape(literal);
            }
            if (constraint === '.*' || constraint === '.+') {
                if (match.index !== 0 || match.end !== raw.length || index !== rawSegments.length - 1)
                    return partial('Actix tail capture must be the terminal whole segment');
                segments.push({ kind: 'rest', name, minimum: constraint === '.*' ? 0 : 1 });
                source += constraint === '.*' ? '[^\n]*' : '[^\n]+';
                cursor = raw.length;
                break;
            }
            const converter = constraint === '[0-9]+' ? 'int' : ['[-A-Za-z0-9_]+', '[A-Za-z0-9_-]+', '[a-zA-Z0-9_-]+'].includes(constraint ?? '') ? 'slug' : undefined;
            if (constraint !== undefined && !converter && !['[^/]+', '[^{}/]+'].includes(constraint))
                return partial('Actix custom regex requires a reviewed constrained matcher');
            parts.push({ kind: 'parameter', name, ...converter ? { converter } : {} });
            source += converter === 'int' ? '[0-9]+' : converter === 'slug' ? '[-A-Za-z0-9_]+' : constraint === '[^/]+' ? '[^/]+' : '[^{}/]+';
            cursor = match.end;
        }
        const tail = raw.slice(cursor);
        if (/[{}\\]/.test(tail))
            return partial('Unbalanced/custom original Actix path syntax');
        if (tail) {
            parts.push({ kind: 'literal', value: tail });
            source += escape(tail);
        }
        if (parts.length)
            segments.push({ kind: 'segment', parts });
    }
    pattern.alternatives = [segments];
    return { ...pattern, rust: { sources: [source + '$'] } };
}
/** Actix's native Quoter preserves encoded slash/plus and invalid escapes,
 * decodes other bytes once and converts invalid UTF-8 lossily. */
export function actixPath(path: string): string {
    const bytes: number[] = [], encoder = new TextEncoder();
    for (let i = 0; i < path.length;) {
        const hex = /^%([a-f\d]{2})/i.exec(path.slice(i));
        if (hex && !['25', '2f', '2b'].includes(hex[1]!.toLowerCase())) {
            bytes.push(parseInt(hex[1]!, 16));
            i += 3;
        }
        else {
            const character = String.fromCodePoint(path.codePointAt(i)!);
            bytes.push(...encoder.encode(character));
            i += character.length;
        }
    }
    return new TextDecoder('utf-8', { ignoreBOM: true }).decode(new Uint8Array(bytes));
}
export function matchRustPath(pattern: RoutePattern, pathname: string, strictHoles = true): boolean {
    if (pathname.length > 8192)
        return false;
    if (pattern.status === 'partial')
        return !pattern.prefix || pathname.includes('{*}') || pathname.startsWith(pattern.prefix);
    const path = pattern.dialect === 'actix-web-4' ? actixPath(pathname) : pathname;
    if (!path.includes('{*}'))
        return pattern.rust?.sources.some(source => new RegExp(source).test(path)) ?? false;
    if (!pattern.rust?.prefixDefault && path.endsWith('/') !== pattern.original.endsWith('/') && path !== '/')
        return false;
    const values = path.slice(1).split('/');
    if (values.at(-1) === '')
        values.pop();
    const segments = pattern.alternatives[0] ?? [];
    for (let index = 0; index < segments.length; index++) {
        const segment = segments[index]!, value = values[index];
        if (segment.kind === 'rest')
            return values.length - index >= segment.minimum;
        if (value === undefined)
            return false;
        if (value === '{*}') {
            if (strictHoles && !(segment.parts.length === 1 && segment.parts[0]?.kind === 'parameter' && !segment.parts[0].converter))
                return false;
        }
        else {
            const regex = segment.parts.map(part => part.kind === 'literal' ? escape(part.value) : part.converter === 'int' ? '[0-9]+' : part.converter === 'slug' ? '[-A-Za-z0-9_]+' : pattern.dialect === 'actix-web-4' ? '[^{}/]+' : '[^/]+').join('');
            if (!new RegExp('^' + regex + '$').test(value))
                return false;
        }
    }
    return values.length === segments.length;
}
/** Native dispatch after literal URI matching. Actix chooses resources before
 * their routes; Axum chooses paths before methods. Unknown competitors stay. */
export function preferRustRoutes(entities: Entity[], all: Entity[], contract: (entity: Entity) => RoutingContract | undefined, matches: (entity: Entity) => boolean, method: string): Entity[] {
    const groups = new Map<string, Entity[]>(), keep = new Set(entities.map(e => e.id));
    for (const entity of entities) {
        const dispatch = contract(entity)?.dispatch;
        if (!dispatch || !['axum', 'actix-web'].includes(dispatch.dialect))
            continue;
        groups.set(dispatch.root, [...groups.get(dispatch.root) ?? [], entity]);
    }
    for (const [root, candidates] of groups) {
        const paths = all.filter(e => { const c = contract(e), guard = c?.rust?.resourceMethods; return c?.dispatch?.root === root && (guard === undefined || guard === '*' || guard.includes(method)) && matches(e); });
        const dialect = contract(candidates[0]!)!.dispatch!.dialect;
        if (dialect === 'actix-web') {
            const lineage = (e: Entity) => contract(e)?.rust?.lineage ?? [{ id: contract(e)!.rust!.resource, order: contract(e)!.rust!.resourceOrder }];
            const compare = (a: Entity, b: Entity) => {
                const x = lineage(a), y = lineage(b);
                for (let i = 0; i < Math.min(x.length, y.length); i++)
                    if (x[i]!.id !== y[i]!.id)
                        return x[i]!.order - y[i]!.order;
                return x.length - y.length;
            };
            const first = paths.filter(e => !e.metadata.constraintsUnresolved).sort(compare)[0];
            if (!first)
                continue;
            const selected = contract(first)!.rust!, eligible = candidates.filter(e => contract(e)?.rust?.resource === selected.resource), route = eligible.filter(e => !e.metadata.constraintsUnresolved).sort((a, b) => (contract(a)!.rust?.routeOrder ?? 0) - (contract(b)!.rust?.routeOrder ?? 0))[0];
            for (const entity of candidates) {
                const data = contract(entity)?.rust;
                if (!data)
                    continue;
                if (compare(entity, first) > 0 || data.resource === selected.resource && route && data.routeOrder > contract(route)!.rust!.routeOrder)
                    keep.delete(entity.id);
            }
        }
        else {
            const rank = (e: Entity) => contract(e)?.pattern.alternatives[0]?.map(s => s.kind === 'rest' ? 0 : s.parts.every(p => p.kind === 'literal') ? 2 : 1) ?? [];
            const compare = (a: Entity, b: Entity) => {
                const x = rank(a), y = rank(b);
                for (let i = 0; i < Math.max(x.length, y.length); i++)
                    if (x[i] !== y[i])
                        return (y[i] ?? -1) - (x[i] ?? -1);
                return 0;
            };
            const explicit = paths.filter(e => !contract(e)?.rust?.fallback && !e.metadata.constraintsUnresolved).sort(compare)[0];
            const fallback = !explicit ? paths.filter(e => contract(e)?.rust?.fallback === 'path' && !e.metadata.constraintsUnresolved).sort(compare)[0] : undefined;
            for (const entity of candidates) {
                const data = contract(entity)?.rust;
                if (!data)
                    continue;
                if (explicit && data.fallback === 'path' || explicit && !entity.metadata.constraintsUnresolved && compare(entity, explicit) > 0)
                    keep.delete(entity.id);
                if (fallback && !entity.metadata.constraintsUnresolved && compare(entity, fallback) > 0)
                    keep.delete(entity.id);
                if (data.headFallback && method === 'HEAD' && candidates.some(other => other.id !== entity.id && contract(other)?.rust?.resource === data.resource && !contract(other)?.rust?.headFallback && !contract(other)?.rust?.fallback && !other.metadata.constraintsUnresolved))
                    keep.delete(entity.id);
            }
        }
    }
    return entities.filter(e => keep.has(e.id));
}
