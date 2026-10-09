import type { Entity } from '../../core/graph.js';
import type { RoutePattern, RoutingContract } from './contracts.js';
export interface AspNetParameter {
    kind: 'parameter';
    name: string;
    optional: boolean;
    default?: string;
    catchAll?: 1 | 2;
    policies: {
        name: string;
        arguments: string[];
    }[];
}
export type AspNetPart = {
    kind: 'literal';
    value: string;
} | AspNetParameter;
export interface AspNetPathData {
    segments: AspNetPart[][];
    precedence: number[];
}
export interface AspNetEndpointData {
    order?: number;
    hosts?: string[];
    registrationKnown: boolean;
    dispatchKnown: boolean;
    authorization: string[];
    anonymous: boolean;
    filters: string[];
    name?: string;
}
const ascii = (value: string) => /^[\x00-\x7f]*$/.test(value);
const equal = (left: string, right: string) => ascii(left) && ascii(right) ? left.toLowerCase() === right.toLowerCase() : left === right;
const builtins = new Set(['int', 'long', 'bool', 'guid', 'alpha', 'min', 'max', 'range', 'minlength', 'maxlength', 'length', 'required']);
/** Reviewed ASP.NET Core 8–10 inbound templates. Arbitrary CLR regex/policies
 * never run; incomplete templates remain conservative routing competitors. */
export function compileAspNetPath(original: string, major: 8 | 9 | 10): RoutePattern {
    const pattern: RoutePattern = { version: 1, dialect: `aspnet-${major}`, original, status: 'exact', alternatives: [], caseSensitive: false, strict: false };
    const data: AspNetPathData = { segments: [], precedence: [] };
    pattern.aspnet = data;
    const gap = (reason: string) => { pattern.status = 'partial'; pattern.reason = pattern.reason ? pattern.reason + '; ' + reason : reason; };
    if (original.length > 4096 || /[\0\r\n\\]/.test(original)) {
        gap('Unreviewed or oversized ASP.NET route template');
        return pattern;
    }
    let text = original.replace(/^~?\//, '').replace(/\/$/, '');
    if (original.startsWith('~') && !original.startsWith('~/') || text.includes('//')) {
        gap('Invalid route prefix or empty route segment');
        return pattern;
    }
    const names = new Set<string>();
    for (const raw of text ? text.split('/') : []) {
        const parts: AspNetPart[] = [];
        let literal = '', cursor = 0;
        const flush = () => {
            if (literal) {
                if (!ascii(literal))
                    gap('Non-ASCII ordinal case matching requires a reviewed profile');
                parts.push({ kind: 'literal', value: literal });
                literal = '';
            }
        };
        while (cursor < raw.length) {
            if (raw.startsWith('{{', cursor)) {
                literal += '{';
                cursor += 2;
                continue;
            }
            if (raw.startsWith('}}', cursor)) {
                literal += '}';
                cursor += 2;
                continue;
            }
            if (raw[cursor] !== '{') {
                if (raw[cursor] === '}')
                    gap('Unbalanced route braces');
                literal += raw[cursor++];
                continue;
            }
            flush();
            const end = raw.indexOf('}', cursor + 1);
            if (end < 0) {
                gap('Unbalanced or custom route parameter');
                return pattern;
            }
            let body = raw.slice(cursor + 1, end), optional = body.endsWith('?');
            if (optional)
                body = body.slice(0, -1);
            const catchAll = body.startsWith('**') ? 2 : body.startsWith('*') ? 1 : undefined;
            body = body.replace(/^\*{1,2}/, '');
            const policyParts: string[] = [];
            let token = '', depth = 0, defaultValue: string | undefined;
            for (let i = 0; i < body.length; i++) {
                const char = body[i]!;
                if (char === '(')
                    depth++;
                if (char === ')')
                    depth--;
                if (char === '=' && depth === 0) {
                    defaultValue = body.slice(i + 1);
                    break;
                }
                if (char === ':' && depth === 0) {
                    policyParts.push(token);
                    token = '';
                }
                else
                    token += char;
            }
            policyParts.push(token);
            const name = policyParts.shift() ?? '';
            if (!/^[A-Za-z_]\w*$/.test(name) || names.has(name.toLowerCase()) || depth !== 0 || optional && defaultValue !== undefined) {
                gap('Invalid/duplicate/default optional route parameter');
                return pattern;
            }
            names.add(name.toLowerCase());
            const policies = policyParts.map(value => {
                const match = /^([A-Za-z_]\w*)(?:\(([^()]*)\))?$/.exec(value);
                const policy = { name: match?.[1] ?? value, arguments: match?.[2]?.split(',').map(item => item.trim()) ?? [] };
                if (!match || !builtins.has(policy.name) || !validPolicy(policy))
                    gap('Custom, regex or unreviewed ASP.NET route policy: ' + value);
                return policy;
            });
            parts.push({ kind: 'parameter', name, optional, ...defaultValue !== undefined ? { default: defaultValue } : {}, ...catchAll ? { catchAll } : {}, policies });
            cursor = end + 1;
        }
        flush();
        if (!parts.length) {
            gap('Empty route segment');
            return pattern;
        }
        if (parts.some((part, index) => part.kind === 'parameter' && (part.catchAll && (part.optional || parts.length !== 1 || raw !== text.split('/').at(-1)) || part.optional && (index !== parts.length - 1 || parts.length > 1 && (parts[index - 1]?.kind !== 'literal' || (parts[index - 1] as {
            value: string;
        }).value !== '.')) || parts[index + 1]?.kind === 'parameter'))) {
            gap('Invalid catch-all, optional separator or adjacent parameters');
            return pattern;
        }
        data.segments.push(parts);
        const single = parts.length === 1 ? parts[0] : undefined;
        data.precedence.push(!single ? 2 : single.kind === 'literal' ? 1 : single.catchAll ? single.policies.length ? 4 : 5 : single.policies.length ? 2 : 3);
    }
    if (data.segments.length > 28) {
        gap('ASP.NET route segment budget exceeded');
        data.segments = [];
        return pattern;
    }
    // Structural alternatives support generic inspectors; matching uses native data.
    pattern.alternatives = [data.segments.map(parts => parts.length === 1 && parts[0]?.kind === 'parameter' && parts[0].catchAll ? { kind: 'rest' as const, name: parts[0].name, minimum: 0 as const } : { kind: 'segment' as const, parts: parts.map(part => part.kind === 'literal' ? part : { kind: 'parameter' as const, name: part.name }) })];
    return pattern;
}
function validPolicy(policy: AspNetParameter['policies'][number]): boolean {
    const count = { min: 1, max: 1, range: 2, minlength: 1, maxlength: 1, length: policy.arguments.length === 2 ? 2 : 1 }[policy.name];
    if (count === undefined)
        return policy.arguments.length === 0;
    return policy.arguments.length === count && policy.arguments.every(value => /^-?\d+$/.test(value) && Number.isSafeInteger(Number(value))) && (!['length', 'minlength', 'maxlength'].includes(policy.name) || policy.arguments.every(value => Number(value) >= 0)) && (!(policy.name === 'range' || policy.name === 'length' && count === 2) || Number(policy.arguments[0]) <= Number(policy.arguments[1]));
}
/** CLR Guid.TryParse N/D/B/P/X, including its documented compatibility prefixes.
 * ASCII subset only; request matching separately retains ordinal Unicode gaps. */
function guid(original: string): boolean {
    const value = original.trim();
    if (value.length < 32)
        return false;
    const hex = (token: string, limit = 0xffffffffn) => {
        token = token.replace(/^\+/, '').replace(/^0x/i, '');
        if (!/^[0-9a-f]*$/i.test(token))
            return false;
        const meaningful = token.replace(/^0+/, '');
        return meaningful.length <= 8 && BigInt('0x' + (meaningful || '0')) <= limit;
    };
    const d = (text: string) => text.length === 36 && [8, 13, 18, 23].every(index => text[index] === '-') && [text.slice(0, 8), text.slice(9, 13), text.slice(14, 18), text.slice(19, 23), text.slice(24, 28)].every(token => hex(token)) && /^[0-9a-f]{8}$/i.test(text.slice(28));
    if (value[0] === '(')
        return value.endsWith(')') && d(value.slice(1, -1));
    if (value[0] === '{') {
        if (value[9] === '-')
            return value.endsWith('}') && d(value.slice(1, -1));
        const compact = value.replace(/[\t\n\v\f\r ]/g, '');
        const match = /^\{(0x[^,]+),(0x[^,]+),(0x[^,]+),\{([^{}]+)\}\}$/i.exec(compact);
        if (!match)
            return false;
        const bytes = match[4]!.split(',');
        return [match[1]!, match[2]!, match[3]!].every(token => hex(token.slice(2))) && bytes.length === 8 && bytes.every(token => /^0x/i.test(token) && hex(token.slice(2), 255n));
    }
    return value[8] === '-' ? d(value) : /^[0-9a-f]{32}$/i.test(value);
}
function accepts(parameter: AspNetParameter, value: string): boolean {
    return parameter.policies.every(policy => {
        if (!builtins.has(policy.name) || !validPolicy(policy))
            return true;
        if (policy.name === 'required')
            return value.length > 0;
        if (policy.name === 'alpha')
            return /^[A-Za-z]+$/.test(value);
        if (policy.name === 'bool')
            return /^(?:true|false)$/i.test(value.trim());
        if (policy.name === 'guid')
            return guid(value);
        if (policy.name === 'int' || policy.name === 'long') {
            if (!/^[+-]?\d+$/.test(value.trim()))
                return false;
            try {
                const number = BigInt(value.trim()), bits = policy.name === 'int' ? 31n : 63n;
                return number >= -(1n << bits) && number < (1n << bits);
            }
            catch {
                return false;
            }
        }
        const args = policy.arguments.map(Number);
        if (policy.name === 'minlength')
            return value.length >= args[0]!;
        if (policy.name === 'maxlength')
            return value.length <= args[0]!;
        if (policy.name === 'length')
            return args.length === 1 ? value.length === args[0] : value.length >= args[0]! && value.length <= args[1]!;
        // .NET min/max/range use invariant Int64 parsing, not JS floating point.
        if (!/^[+-]?\d+$/.test(value.trim()))
            return false;
        try {
            const number = BigInt(value.trim());
            if (number < -(1n << 63n) || number >= (1n << 63n))
                return false;
            const lower = BigInt(policy.arguments[0]!);
            return policy.name === 'min' ? number >= lower : policy.name === 'max' ? number <= lower : number >= lower && number <= BigInt(policy.arguments[1]!);
        }
        catch {
            return false;
        }
    });
}
/** Native complex segments select literal delimiters right-to-left and require
 * nonempty captures. No backtracking into earlier delimiter choices. */
function captureComplex(parts: AspNetPart[], value: string): Map<string, string> | undefined {
    const result = new Map<string, string>();
    let end = value.length, pending: AspNetParameter | undefined;
    for (let i = parts.length - 1; i >= 0; i--) {
        const part = parts[i]!;
        if (part.kind === 'parameter') {
            pending = part;
            continue;
        }
        if (!ascii(part.value) || !ascii(value))
            return undefined;
        const position = value.toLowerCase().lastIndexOf(part.value.toLowerCase(), end - (pending ? 1 : 0) - part.value.length);
        if (position < 0 || !pending && position + part.value.length !== end)
            return undefined;
        if (pending) {
            const capture = value.slice(position + part.value.length, end);
            if (!capture)
                return undefined;
            result.set(pending.name, capture);
            pending = undefined;
        }
        end = position;
    }
    if (pending) {
        if (!end)
            return undefined;
        result.set(pending.name, value.slice(0, end));
        end = 0;
    }
    return end === 0 ? result : undefined;
}
export function matchAspNetPath(pattern: RoutePattern, pathname: string, strictHoles = true): boolean {
    const data = pattern.aspnet;
    if (!data || !data.segments.length && pattern.original.replace(/^~?\//, '').replace(/\/$/, '') !== '')
        return pattern.status === 'partial';
    if (!pathname.startsWith('/') || pathname.length > 16384)
        return false;
    let raw = pathname.slice(1);
    if (raw.endsWith('/'))
        raw = raw.slice(0, -1);
    const values = raw ? raw.split('/') : [];
    let cursor = 0;
    for (const parts of data.segments) {
        const single = parts.length === 1 ? parts[0] : undefined;
        if (single?.kind === 'parameter' && single.catchAll) {
            let captured = values.slice(cursor).join('/');
            try {
                captured = decodeURIComponent(captured.replace(/%2f/ig, '%252F'));
            }
            catch {
                return false;
            }
            return captured.includes('{*}') || accepts(single, captured || (single.default ?? ''));
        }
        const encoded = values[cursor++];
        if (encoded === undefined) {
            if (single?.kind === 'parameter' && (single.optional || single.default !== undefined) && (!single.policies.length || single.optional || accepts(single, single.default!)))
                continue;
            return false;
        }
        if (!encoded)
            return false;
        let value: string;
        try {
            value = decodeURIComponent(encoded.replace(/%2f/ig, '%252F'));
        }
        catch {
            return false;
        }
        if (value.includes('{*}')) {
            if (strictHoles && parts.some(part => part.kind === 'literal'))
                return false;
            continue;
        }
        if (single?.kind === 'literal') {
            if (!ascii(single.value) || !ascii(value))
                continue;
            if (!equal(single.value, value))
                return false;
            continue;
        }
        if (single?.kind === 'parameter') {
            if (!accepts(single, value))
                return false;
            continue;
        }
        if (!ascii(value) || parts.some(part => part.kind === 'literal' && !ascii(part.value)))
            continue;
        let captures = captureComplex(parts, value);
        const last = parts.at(-1), separator = parts.at(-2);
        if (!captures && last?.kind === 'parameter' && last.optional && separator?.kind === 'literal' && separator.value === '.' && !value.endsWith('.'))
            captures = captureComplex(parts.slice(0, -2), value);
        if (!captures) {
            if (pattern.status === 'partial')
                continue;
            return false;
        }
        if (parts.some(part => part.kind === 'parameter' && captures!.has(part.name) && !accepts(part, captures!.get(part.name)!)))
            return false;
    }
    return cursor >= values.length;
}
export function validAspNetHost(value: string): boolean { return value.length <= 512 && /^(?:(?:\*\.)?[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?|\*)(?::(?:\*|\d{1,5}))?$/i.test(value) && !value.includes('..') && (!/:\d/.test(value) || Number(value.split(':')[1]) <= 65535); }
export function matchAspNetHosts(hosts: string[] | undefined, url: URL): boolean {
    if (!hosts?.length)
        return true;
    const hostname = url.hostname.toLowerCase(), port = url.port || (url.protocol === 'https:' ? '443' : '80');
    return hosts.some(value => { const [host, selectedPort] = value.toLowerCase().split(':'); return (!selectedPort || selectedPort === '*' || Number(selectedPort) === Number(port)) && (host === '*' || host === hostname || host!.startsWith('*.') && hostname.endsWith(host!.slice(1))); });
}
function compare(left: RoutingContract, right: RoutingContract): number | undefined {
    if (!left.aspnet?.dispatchKnown || !right.aspnet?.dispatchKnown || left.pattern.status !== 'exact' || right.pattern.status !== 'exact' || left.aspnet.order === undefined || right.aspnet.order === undefined)
        return;
    if (left.aspnet.order !== right.aspnet.order)
        return left.aspnet.order - right.aspnet.order;
    const a = left.pattern.aspnet!.precedence, b = right.pattern.aspnet!.precedence;
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const difference = (a[i] ?? 0) - (b[i] ?? 0);
        if (difference)
            return difference;
    }
    return Number(left.methods === '*') - Number(right.methods === '*') || Number(!left.aspnet.hosts?.length) - Number(!right.aspnet.hosts?.length);
}
/** Inbound order, native template precedence, method then host metadata.
 * Equal scores remain ambiguous. Unknown competitors are never discarded. */
export function preferAspNetRoutes(entities: Entity[], contractFor: (entity: Entity) => RoutingContract | undefined): Entity[] {
    const groups = new Map<string, Entity[]>(), removed = new Set<string>();
    for (const entity of entities) {
        const contract = contractFor(entity);
        if (contract?.dispatch?.dialect !== 'aspnet')
            continue;
        const group = groups.get(contract.dispatch.root) ?? [];
        group.push(entity);
        groups.set(contract.dispatch.root, group);
    }
    for (const group of groups.values())
        for (const candidate of group) {
            const value = contractFor(candidate)!;
            if (group.some(other => { const selected = contractFor(other)!; return selected.aspnet?.registrationKnown && compare(selected, value) !== undefined && compare(selected, value)! < 0; }))
                removed.add(candidate.id);
        }
    return entities.filter(entity => !removed.has(entity.id));
}
export function reviewedAspNetRequest(path: string): boolean {
    try {
        return /^[\x00-\x7f]*$/.test(decodeURIComponent(path));
    }
    catch {
        return false;
    }
}
