import type { RustCfgInput } from '../../core/config.js';
export type RustTruth = true | false | 'unknown';
export interface RustCfgEnvironment {
    cfg?: RustCfgInput;
    targetTriple?: string;
    features?: Set<string>;
    test: boolean;
}
export const rustAnd = (values: RustTruth[]): RustTruth => values.includes(false) ? false : values.includes('unknown') ? 'unknown' : true;
export const rustOr = (values: RustTruth[]): RustTruth => values.includes(true) ? true : values.includes('unknown') ? 'unknown' : false;
export const rustIdentifier = (text: string) => /^(?:r#)?[_\p{ID_Start}][_\p{ID_Continue}]*$/u.test(text) && text !== '_';
export const rustName = (text: string) => text.replace(/^r#/, '');
function stringEnd(text: string, start: number): number | undefined {
    const raw = /^r(#{0,255})"/.exec(text.slice(start));
    if (raw) {
        const end = text.indexOf('"' + raw[1], start + raw[0].length);
        return end < 0 ? undefined : end + 1 + raw[1]!.length;
    }
    if (text[start] !== '"')
        return;
    for (let i = start + 1; i < text.length; i++) {
        if (text[i] === '\\')
            i++;
        else if (text[i] === '"')
            return i + 1;
    }
}
/** Literal Rust strings only; no macro expansion, byte-string conversion or evaluation. */
export function rustString(text: string): string | undefined {
    if (stringEnd(text, 0) !== text.length)
        return;
    const raw = /^r(#{0,255})"([\s\S]*)"\1$/.exec(text);
    if (raw)
        return raw[2];
    if (!text.startsWith('"') || !text.endsWith('"'))
        return;
    let result = '';
    for (let i = 1; i < text.length - 1; i++) {
        const char = text[i]!;
        if (char !== '\\') {
            result += char;
            continue;
        }
        const next = text[++i], basic: Record<string, string> = { n: '\n', r: '\r', t: '\t', '0': '\0', '\\': '\\', '"': '"', "'": "'" };
        if (next !== undefined && next in basic) {
            result += basic[next];
            continue;
        }
        if (next === '\n' || next === '\r' && text[i + 1] === '\n') {
            while (/\s/.test(text[i + 1] ?? '') && i < text.length - 2)
                i++;
            continue;
        }
        if (next === 'x') {
            const value = /^[0-9a-fA-F]{2}/.exec(text.slice(i + 1));
            if (!value || parseInt(value[0], 16) > 127)
                return;
            result += String.fromCodePoint(parseInt(value[0], 16));
            i += 2;
            continue;
        }
        if (next === 'u') {
            const value = /^\{([0-9a-fA-F_]{1,12})\}/.exec(text.slice(i + 1));
            if (!value)
                return;
            const digits = value[1]!.replaceAll('_', ''), point = parseInt(digits, 16);
            if (!digits || digits.length > 6 || point > 0x10ffff || point >= 0xd800 && point <= 0xdfff)
                return;
            result += String.fromCodePoint(point);
            i += value[0].length;
            continue;
        }
        return;
    }
    return result;
}
/** Three-valued cfg predicates. Absent target/custom configuration stays unknown. */
export function rustCfg(expression: string, env: RustCfgEnvironment): RustTruth {
    if (expression.length > 8192)
        return 'unknown';
    const tokens: string[] = [];
    let position = 0;
    const token = /(?:r#)?[_\p{ID_Start}][_\p{ID_Continue}]*|[=(),]/uy;
    while (position < expression.length) {
        while (/\s/u.test(expression[position] ?? '') && position < expression.length)
            position++;
        if (position === expression.length)
            break;
        if (tokens.length >= 1024)
            return 'unknown';
        const end = stringEnd(expression, position);
        if (end !== undefined) {
            tokens.push(expression.slice(position, end));
            position = end;
            continue;
        }
        token.lastIndex = position;
        const match = token.exec(expression);
        if (!match)
            return 'unknown';
        tokens.push(match[0]);
        position = token.lastIndex;
    }
    let index = 0;
    const parse = (depth = 0): RustTruth => {
        if (depth > 64)
            throw new Error('cfg depth');
        const input = tokens[index++];
        if (!input || !rustIdentifier(input))
            throw new Error('cfg name');
        const name = rustName(input);
        if (tokens[index] === '(') {
            index++;
            const values: RustTruth[] = [];
            while (tokens[index] !== ')') {
                values.push(parse(depth + 1));
                if (tokens[index] === ',') {
                    index++;
                    if (tokens[index] === ')')
                        break;
                }
                else if (tokens[index] !== ')')
                    throw new Error('cfg separator');
            }
            index++;
            return name === 'all' ? rustAnd(values) : name === 'any' ? rustOr(values) : name === 'not' && values.length === 1 ? values[0] === 'unknown' ? 'unknown' : !values[0] : 'unknown';
        }
        if (tokens[index] === '=') {
            index++;
            const value = rustString(tokens[index++] ?? '');
            if (value === undefined)
                throw new Error('cfg literal');
            if (name === 'feature')
                return env.features ? env.features.has(value) : 'unknown';
            return env.cfg ? (env.cfg.values?.[name] ?? []).includes(value) : 'unknown';
        }
        if (name === 'test')
            return env.test;
        if (name === 'true' || name === 'false')
            return 'unknown'; // New cfg boolean syntax needs a compiler/version profile.
        return env.cfg ? (env.cfg.flags ?? []).includes(name) : 'unknown';
    };
    try {
        const result = parse();
        return index === tokens.length ? result : 'unknown';
    }
    catch {
        return 'unknown';
    }
}
export function rustSplit(text: string): string[] | undefined {
    const parts: string[] = [];
    let start = 0, depth = 0;
    if (text.length > 8192)
        return;
    for (let i = 0; i < text.length; i++) {
        const char = text[i]!;
        const end = stringEnd(text, i);
        if (end !== undefined) {
            i = end - 1;
            continue;
        }
        if (char === '"' || /^r#*"/.test(text.slice(i)))
            return;
        if (char === '(') {
            if (++depth > 64)
                return;
        }
        else if (char === ')') {
            if (--depth < 0)
                return;
        }
        else if (char === ',' && depth === 0) {
            parts.push(text.slice(start, i).trim());
            start = i + 1;
        }
    }
    if (depth)
        return;
    const tail = text.slice(start).trim();
    if (tail)
        parts.push(tail);
    return parts;
}
export interface RustAttributes {
    active: RustTruth;
    path?: string;
    noStd: boolean;
    noCore: boolean;
    noPrelude: boolean;
    macroExport: boolean;
    gaps: string[];
}
export function rustAttributes(attributes: string[], env: RustCfgEnvironment): RustAttributes {
    const result: RustAttributes = { active: true, noStd: false, noCore: false, noPrelude: false, macroExport: false, gaps: [] };
    const apply = (attribute: string, depth = 0): void => {
        if (depth > 32) {
            result.gaps.push('Rust attribute nesting budget');
            return;
        }
        const text = attribute.replace(/^#!?\[/, '').replace(/\]$/, '').trim();
        const call = /^([\w:]+)\s*\(([\s\S]*)\)$/.exec(text);
        if (call?.[1] === 'cfg') {
            const value = rustCfg(call[2]!, env);
            result.active = rustAnd([result.active, value]);
            if (value === 'unknown')
                result.gaps.push(`Unselected Rust cfg(${call[2]})`);
            return;
        }
        if (call?.[1] === 'cfg_attr') {
            const values = rustSplit(call[2]!);
            if (!values || values.length < 2) {
                result.gaps.push('Malformed Rust cfg_attr');
                return;
            }
            const value = rustCfg(values[0]!, env);
            if (value === true)
                for (const nested of values.slice(1))
                    apply(nested, depth + 1);
            else if (value === 'unknown')
                result.gaps.push(`Unselected Rust cfg_attr(${values[0]})`);
            return;
        }
        const selectedPath = /^path\s*=\s*([\s\S]*)$/.exec(text);
        if (selectedPath) {
            const value = rustString(selectedPath[1]!);
            if (value === undefined || result.path !== undefined)
                result.gaps.push('Opaque/competing Rust module path attributes');
            else
                result.path = value;
            return;
        }
        if (text === 'no_std') {
            result.noStd = true;
            return;
        }
        if (text === 'no_core') {
            result.noCore = true;
            result.gaps.push('Unreviewed Rust no_core/compiler feature profile');
            return;
        }
        if (text === 'no_implicit_prelude') {
            result.noPrelude = true;
            return;
        }
        if (text === 'macro_export') {
            result.macroExport = true;
            return;
        }
        if (text === 'test') {
            result.active = rustAnd([result.active, env.test]);
            return;
        }
        if (call?.[1] === 'derive') {
            const derives = rustSplit(call[2]!);
            if (derives?.every(value => ['Clone', 'Copy', 'Debug', 'Default', 'Eq', 'Hash', 'Ord', 'PartialEq', 'PartialOrd'].includes(value)))
                return;
        }
        const name = /^([\w:]+)/.exec(text)?.[1];
        if (name && ['allow', 'warn', 'deny', 'forbid', 'expect', 'doc', 'deprecated', 'inline', 'cold', 'must_use', 'repr', 'non_exhaustive', 'track_caller', 'no_mangle', 'export_name', 'link', 'link_name'].includes(name))
            return;
        result.gaps.push(`Unreviewed Rust attribute ${name ?? text.slice(0, 80)} may generate/change items`);
    };
    for (const attribute of attributes)
        apply(attribute);
    return result;
}
