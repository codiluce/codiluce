import path from 'node:path';
import { readXmlData, type XmlNode } from './jvm-manifest.js';
export const readMsbuildXml = (text: string): XmlNode | undefined => readXmlData(text, 'Project', 'http://schemas.microsoft.com/developer/msbuild/2003');
/** Portable original repository paths, including literal Windows separators. */
export function dotnetPath(root: string, value: string, glob = false): string | undefined {
    if (!value || value.length > 2048 || /[\0$%@{}\[\]]/.test(value) || (!glob && /[*?]/.test(value)) || /^[A-Za-z]:|^[\\/]/.test(value))
        return;
    const result = path.posix.normalize(path.posix.join(root, value.replace(/\\/g, '/')));
    return result === '..' || result.startsWith('../') ? undefined : result;
}
export function dotnetGlob(pattern: string, file: string): boolean {
    // MSBuild's **/ matches zero directories as well. No brace/extglob execution.
    const expression = pattern.split(/(\*\*\/|\*\*|\*|\?)/).map(part => part === '**/' ? '(?:.*/)?' : part === '**' ? '.*' : part === '*' ? '[^/]*' : part === '?' ? '[^/]' : part.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('');
    return new RegExp('^' + expression + '$').test(file);
}
export type DataTruth = boolean | undefined;
/** Bounded literal condition parser; unknown property values remain unknown.
 * Relational/version/property-function/item expansions are never evaluated. */
export function msbuildCondition(text: string | undefined, exists: (value: string) => DataTruth): DataTruth {
    if (text === undefined || !text.trim())
        return true;
    if (text.length > 4096 || /\$\(|[@%]\(|\$\[|::/.test(text))
        return;
    const tokens: string[] = [];
    let offset = 0;
    while (offset < text.length) {
        const match = /^\s*(?:('(?:[^']*)'|"(?:[^"]*)"|==|!=|[()!]|\bAnd\b|\bOr\b|\bExists\b|\btrue\b|\bfalse\b))\s*/i.exec(text.slice(offset));
        if (!match)
            return;
        tokens.push(match[1]!);
        offset += match[0].length;
        if (tokens.length > 256)
            return;
    }
    let i = 0, depth = 0, failed = false;
    const and = (a: DataTruth, b: DataTruth): DataTruth => a === false || b === false ? false : a === undefined || b === undefined ? undefined : true;
    const or = (a: DataTruth, b: DataTruth): DataTruth => a === true || b === true ? true : a === undefined || b === undefined ? undefined : false;
    const atom = (): DataTruth => {
        if (++depth > 32) {
            failed = true;
            return;
        }
        let value: DataTruth;
        const token = tokens[i++];
        if (token === '!') {
            const child = atom();
            value = child === undefined ? undefined : !child;
        }
        else if (token === '(') {
            value = expression();
            if (tokens[i++] !== ')')
                failed = true;
        }
        else if (/^Exists$/i.test(token ?? '')) {
            if (tokens[i++] !== '(')
                failed = true;
            const argument = tokens[i++];
            if (!argument || !/^['"]/.test(argument) || tokens[i++] !== ')')
                failed = true;
            else
                value = exists(argument.slice(1, -1));
        }
        else if (/^['"]/.test(token ?? '')) {
            const operator = tokens[i++], right = tokens[i++];
            if (!['==', '!='].includes(operator ?? '') || !right || !/^['"]/.test(right))
                failed = true;
            else {
                const same = token!.slice(1, -1).toLowerCase() === right.slice(1, -1).toLowerCase();
                value = operator === '==' ? same : !same;
            }
        }
        else if (/^(true|false)$/i.test(token ?? ''))
            value = token!.toLowerCase() === 'true';
        else
            failed = true;
        depth--;
        return value;
    };
    const conjunction = (): DataTruth => {
        let value = atom();
        while (/^And$/i.test(tokens[i] ?? '')) {
            i++;
            value = and(value, atom());
        }
        return value;
    };
    const expression = (): DataTruth => {
        let value = conjunction();
        while (/^Or$/i.test(tokens[i] ?? '')) {
            i++;
            value = or(value, conjunction());
        }
        return value;
    };
    const result = expression();
    return failed || i !== tokens.length ? undefined : result;
}
/** Conservative glob/directory intersection, without inventing a filename. */
export function dotnetGlobWithinDirectory(pattern: string, directory: string): boolean {
    const parts = pattern.split('/'), wild = parts.findIndex(part => /[*?]/.test(part));
    const prefix = wild < 0 ? path.posix.dirname(pattern) : parts.slice(0, wild).join('/') || '.';
    const within = (file: string, root: string) => root === '.' || file === root || file.startsWith(root + '/');
    return within(prefix, directory) || within(directory, prefix);
}
/** Only an exclusion of the complete subtree proves a pruned root harmless. */
export function dotnetCoveredDirectory(pattern: string, directory: string): boolean {
    if (!pattern.endsWith('/**'))
        return false;
    const root = pattern.slice(0, -3);
    let parent = directory;
    while (parent !== '.') {
        if (dotnetGlob(root, parent))
            return true;
        parent = path.posix.dirname(parent);
    }
    return false;
}
/** Initial reviewed TFM subset, based on Microsoft's compatibility rules.
 * Platform negotiation, framework/coreapp legacy and custom TFMs stay gaps.
 * https://learn.microsoft.com/en-us/dotnet/standard/net-standard
 * https://learn.microsoft.com/en-us/dotnet/standard/library-guidance/nuget-package-compatibility-rules */
export function dotnetTargetCompatible(consumer: string | undefined, dependency: string | undefined): boolean {
    if (consumer === dependency)
        return true;
    const modern = (value: string | undefined) => /^net([5-9]|10)\.0$/.exec(value ?? '')?.[1];
    const target = modern(consumer), source = modern(dependency);
    if (target && (dependency === 'netstandard2.0' || dependency === 'netstandard2.1'))
        return true;
    return !!target && !!source && Number(target) >= Number(source);
}
