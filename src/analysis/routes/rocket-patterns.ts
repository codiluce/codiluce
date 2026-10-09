import type { Entity } from '../../core/graph.js';
import type { RoutePattern, RouteSegment, RoutingContract } from './contracts.js';
export interface RocketPathData {
    segments: ({
        literal: string;
    } | {
        name: string;
        rest: boolean;
        guard?: string;
    })[];
    query: {
        name: string;
        value: string;
    }[];
    queryParameters: {
        name: string;
        rest: boolean;
    }[];
    defaultRank: number;
}
const namePattern = /^(?:_|[_\p{ID_Start}][_\p{ID_Continue}]*)$/u;
/** Mounts use strict Origin::parse, while route attributes use parse_route. */
export function reviewedRocketMount(original: string): boolean {
    const question = original.indexOf('?'), path = question < 0 ? original : original.slice(0, question), query = question < 0 ? '' : original.slice(question + 1);
    return original.length <= 4096 && path.startsWith('/') && /^[A-Za-z0-9%._~!$&'()*+,;=:@/\[\]-]*$/.test(path) && /^[A-Za-z0-9%._~!$&'()*+,;=:@/?{}\[\]\\^`|-]*$/.test(query);
}
/** Native 0.5 URI metadata. Path components are split before percent decoding;
 * empty components are ignored. No target URI parser or FromParam runs. */
export function compileRocketPath(original: string, guards: Record<string, string> = {}): RoutePattern {
    const pattern: RoutePattern = { version: 1, dialect: 'rocket-0.5', original, status: 'exact', alternatives: [], caseSensitive: true, strict: false };
    const partial = (reason: string): RoutePattern => ({ ...pattern, status: 'partial', reason, prefix: original.match(/^\/[\w./~-]*/)?.[0] ?? '/', alternatives: [] });
    if (original.length > 4096 || !original.startsWith('/') || /[#\x00-\x1f\x7f]/.test(original) || original.split('?').length > 2)
        return partial('Unreviewed Rocket origin URI');
    const [path, query] = original.split('?'), data: RocketPathData = { segments: [], query: [], queryParameters: [], defaultRank: 0 }, alternatives: RouteSegment[] = [], names = new Set<string>();
    const parts = path!.split('/').filter(Boolean);
    for (const [index, part] of parts.entries()) {
        const capture = /^<([^<>]+?)(\.\.)?>$/.exec(part);
        if (capture) {
            const name = capture[1]!, rest = !!capture[2];
            if (!namePattern.test(name) || name !== '_' && names.has(name) || rest && index !== parts.length - 1)
                return partial('Unreviewed/duplicate/nonterminal Rocket capture');
            names.add(name);
            data.segments.push({ name, rest, guard: guards[name] });
            alternatives.push(rest ? { kind: 'rest', name, minimum: 0 } : { kind: 'segment', parts: [{ kind: 'parameter', name }] });
        }
        else {
            if (/[<>]/.test(part))
                return partial('Rocket captures require a whole path component');
            data.segments.push({ literal: part });
            alternatives.push({ kind: 'segment', parts: [{ kind: 'literal', value: part }] });
        }
    }
    const fields = query?.split('&').filter(Boolean) ?? [];
    for (const [index, field] of fields.entries()) {
        const capture = /^<([^<>]+?)(\.\.)?>$/.exec(field);
        if (capture) {
            const name = capture[1]!, rest = !!capture[2];
            if (!namePattern.test(name) || name !== '_' && names.has(name) || rest && index !== fields.length - 1)
                return partial('Unreviewed Rocket query capture');
            names.add(name);
            data.queryParameters.push({ name, rest });
        }
        else {
            if (/[<>]/.test(field))
                return partial('Unreviewed embedded Rocket query capture');
            const equals = field.indexOf('=');
            data.query.push({ name: equals < 0 ? field : field.slice(0, equals), value: equals < 0 ? '' : field.slice(equals + 1) });
        }
    }
    const color = (staticCount: number, total: number) => staticCount === total ? 3 : staticCount === 0 ? 1 : 2;
    data.defaultRank = -(((color(data.segments.filter(s => 'literal' in s).length, data.segments.length) << 2) | (fields.length ? color(data.query.length, fields.length) : 0)) - 3);
    return { ...pattern, alternatives: [alternatives], rocket: data };
}
function decoded(segment: string): string {
    const bytes: number[] = [], encoder = new TextEncoder();
    for (let i = 0; i < segment.length;) {
        const hex = /^%([a-f\d]{2})/i.exec(segment.slice(i));
        if (hex) {
            bytes.push(parseInt(hex[1]!, 16));
            i += 3;
        }
        else {
            const char = String.fromCodePoint(segment.codePointAt(i)!);
            bytes.push(...encoder.encode(char));
            i += char.length;
        }
    }
    return new TextDecoder('utf-8', { ignoreBOM: true }).decode(new Uint8Array(bytes));
}
function guardMatches(type: string | undefined, value: string, strict: boolean): boolean {
    if (!type || type === 'str')
        return true;
    if (value.includes('{*}'))
        return !strict;
    if (type === 'bool')
        return value === 'true' || value === 'false';
    const integer = /^([iu])(8|16|32|64|128)$/.exec(type);
    if (!integer)
        return false;
    if (!(integer[1] === 'u' ? /^\+?\d+$/ : /^[+-]?\d+$/).test(value) || /\s/u.test(value) || value.length > 4096)
        return false;
    const bits = BigInt(integer[2]!), signed = integer[1] === 'i', limit = 1n << (signed ? bits - 1n : bits), number = BigInt(value);
    return number >= (signed ? -limit : 0n) && number < limit;
}
export function matchRocketPath(pattern: RoutePattern, path: string, strict = true): boolean {
    if (path.length > 8192 || !path.startsWith('/'))
        return false;
    if (pattern.status === 'partial')
        return path.startsWith(pattern.prefix ?? '/');
    const route = pattern.rocket?.segments;
    if (!route)
        return false;
    const request = path.split('/').filter(Boolean).map(decoded), rest = route.at(-1);
    if (rest && 'name' in rest && rest.rest ? request.length < route.length - 1 : request.length !== route.length)
        return false;
    for (const [index, segment] of route.entries()) {
        if ('name' in segment && segment.rest)
            return true;
        const value = request[index]!;
        if ('literal' in segment) {
            if (value !== segment.literal && (!value.includes('{*}') || strict))
                return false;
        }
        else if (!guardMatches(segment.guard, value, strict))
            return false;
    }
    return true;
}
export function matchRocketQuery(pattern: RoutePattern, query: URLSearchParams): boolean {
    return (pattern.rocket?.query ?? []).every(field => query.getAll(field.name).includes(field.value));
}
/** Rocket startup collisions ignore query predicates and parameter conversion.
 * Formats remain separately constrained by the pack rather than executed. */
export function rocketPathsCollide(a: RoutePattern, b: RoutePattern): boolean {
    const left = a.rocket?.segments, right = b.rocket?.segments;
    if (!left || !right)
        return true;
    for (let i = 0; i < Math.min(left.length, right.length); i++) {
        const x = left[i]!, y = right[i]!;
        if ('name' in x && x.rest || 'name' in y && y.rest)
            return true;
        if ('literal' in x && 'literal' in y && x.literal !== y.literal)
            return false;
    }
    const extra = left[right.length] ?? right[left.length];
    return left.length === right.length || !!extra && 'name' in extra && extra.rest;
}
export function preferRocketRoutes(items: Entity[], contract: (entity: Entity) => RoutingContract | undefined, method: string): Entity[] {
    return items.filter(entity => {
        const own = contract(entity);
        if (own?.dispatch?.dialect !== 'rocket')
            return true;
        return !items.some(other => {
            if (other === entity || other.metadata.constraintsUnresolved)
                return false;
            const next = contract(other);
            if (next?.dispatch?.dialect !== 'rocket' || next.dispatch.root !== own.dispatch!.root)
                return false;
            if (method === 'HEAD' && own.rust?.headFallback && !next.rust?.headFallback)
                return true;
            if (method === 'HEAD' && !own.rust?.headFallback && next.rust?.headFallback)
                return false;
            return (next.rust?.rank ?? Infinity) < (own.rust?.rank ?? Infinity);
        });
    });
}
