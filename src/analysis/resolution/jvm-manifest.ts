import path from 'node:path';
/** Bounded XML data reader. Never expands DTDs, external entities or schemas. */
export interface XmlNode {
    name: string;
    text: string;
    children: XmlNode[];
    start: number;
    attributes?: Record<string, string>;
}
export function readPomXml(text: string): XmlNode | undefined {
    if (text.length > 1 << 20 || /<!DOCTYPE|<!ENTITY/i.test(text))
        return;
    const document: XmlNode = { name: '', text: '', children: [], start: 0 }, stack = [document];
    let offset = 0, count = 0;
    const decode = (value: string) => value.replace(/&(?:amp|lt|gt|quot|apos);/g, entity => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" }[entity]!));
    while (offset < text.length) {
        if (++count > 50000 || stack.length > 100)
            return;
        if (text.startsWith('<!--', offset)) {
            const end = text.indexOf('-->', offset + 4);
            if (end < 0 || text.slice(offset + 4, end).includes('--'))
                return;
            offset = end + 3;
            continue;
        }
        if (text.startsWith('<?', offset)) {
            const end = text.indexOf('?>', offset + 2), target = /^<\?([A-Za-z_][\w.-]*)(?:\s|\?>)/.exec(text.slice(offset));
            if (end < 0 || !target || target[1]!.toLowerCase() === 'xml' && offset > 3)
                return;
            offset = end + 2;
            continue;
        }
        if (text.startsWith('<![CDATA[', offset)) {
            const end = text.indexOf(']]>', offset + 9);
            if (end < 0 || stack.length === 1)
                return;
            stack.at(-1)!.text += text.slice(offset + 9, end);
            offset = end + 3;
            continue;
        }
        if (text[offset] !== '<') {
            const end = text.indexOf('<', offset), stop = end < 0 ? text.length : end, value = text.slice(offset, stop);
            if (/&(?!(?:amp|lt|gt|quot|apos);)/.test(value))
                return;
            stack.at(-1)!.text += decode(value);
            offset = stop;
            continue;
        }
        const match = /^<(\/)?([A-Za-z_][\w.-]*)(\s+(?:[A-Za-z_:][\w:.-]*\s*=\s*(?:"[^"<]*"|'[^'<]*')\s*)*)?\s*(\/?)>/.exec(text.slice(offset));
        if (!match)
            return;
        const [, close, name, attrs, self] = match;
        if (close) {
            if (attrs || self || stack.length === 1 || stack.at(-1)!.name !== name)
                return;
            stack.pop();
        }
        else {
            const attributes: Record<string, string> = {};
            for (const attribute of (attrs ?? '').matchAll(/([A-Za-z_:][\w:.-]*)\s*=\s*(["'])(.*?)\2/g)) {
                if (attribute[1]! in attributes || /&(?!(?:amp|lt|gt|quot|apos);)/.test(attribute[3]!))
                    return;
                attributes[attribute[1]!] = decode(attribute[3]!);
            }
            if (attributes.xmlns && attributes.xmlns !== 'http://maven.apache.org/POM/4.0.0')
                return;
            const node: XmlNode = { name: name!, text: '', children: [], start: offset, attributes };
            stack.at(-1)!.children.push(node);
            if (!self)
                stack.push(node);
        }
        offset += match[0].length;
    }
    if (stack.length !== 1 || document.children.length !== 1 || document.text.trim() || document.children[0]!.name !== 'project')
        return;
    return document.children[0];
}
export const xmlChildren = (node: XmlNode | undefined, name: string) => node?.children.filter(child => child.name === name) ?? [];
export function xmlChild(node: XmlNode | undefined, name: string): XmlNode | undefined { const values = xmlChildren(node, name); return values.length === 1 ? values[0] : undefined; }
export const xmlValue = (node: XmlNode | undefined, name: string) => { const item = xmlChild(node, name); return item && !item.children.length ? item.text.trim() : undefined; };
export function jvmPath(root: string, value: string): string | undefined {
    if (!value || value.length > 2048 || /[\0\\*?{}\[\]$]/.test(value) || path.posix.isAbsolute(value) || /^[A-Za-z]:/.test(value))
        return;
    const result = path.posix.normalize(path.posix.join(root, value));
    return result === '..' || result.startsWith('../') ? undefined : result;
}
export interface GradleToken {
    value: string;
    literal?: boolean;
    quote?: string;
    start: number;
    end: number;
    depth: number;
}
/** Tokenize the literal data subset; interpolation, opaque strings and broken
 * delimiters are gaps. No Groovy/Kotlin script, plugin or target build runs. */
export function gradleTokens(text: string): GradleToken[] | undefined {
    if (text.length > 1 << 20)
        return;
    const tokens: GradleToken[] = [], stack: string[] = [];
    let i = 0;
    while (i < text.length) {
        if (tokens.length > 50000 || stack.length > 100)
            return;
        if (/\s/.test(text[i]!)) {
            i++;
            continue;
        }
        if (text.startsWith('//', i)) {
            const end = text.indexOf('\n', i);
            i = end < 0 ? text.length : end;
            continue;
        }
        if (text.startsWith('/*', i)) {
            const end = text.indexOf('*/', i + 2);
            if (end < 0 || text.slice(i + 2, end).includes('/*'))
                return;
            i = end + 2;
            continue;
        }
        const start = i, quote = text[i];
        if (quote === '"' || quote === "'") {
            i++;
            const end = text.indexOf(quote, i);
            if (end < 0 || /[\n\r\\$]/.test(text.slice(i, end)) || text.slice(start, start + 3) === quote.repeat(3))
                return;
            tokens.push({ value: text.slice(i, end), literal: true, quote, start, end: end + 1, depth: stack.length });
            i = end + 1;
            continue;
        }
        const match = /^[A-Za-z_][\w-]*|^\d+(?:\.\d+)*|^[{}()[\].,:;=]/.exec(text.slice(i));
        if (!match)
            return;
        const value = match[0], depth = stack.length;
        if ('{(['.includes(value))
            stack.push(value);
        else if ('})]'.includes(value)) {
            const opening = stack.pop();
            if (opening !== ({ '}': '{', ')': '(', ']': '[' }[value]))
                return;
        }
        tokens.push({ value, start, end: start + value.length, depth });
        i += value.length;
    }
    return stack.length ? undefined : tokens;
}
export function tokenArguments(tokens: GradleToken[], at: number): {
    values: GradleToken[];
    end: number;
} | undefined {
    const opening = tokens[at]?.value === '(';
    const values: GradleToken[] = [];
    let end = at + (opening ? 1 : 0);
    if (!tokens[end]?.literal)
        return;
    while (tokens[end]?.literal) {
        values.push(tokens[end++]!);
        if (tokens[end]?.value !== ',')
            break;
        if (!tokens[++end]?.literal)
            return;
    }
    if (opening) {
        if (tokens[end]?.value !== ')')
            return;
        end++;
    }
    return { values, end };
}
export interface GradleSettingsModel {
    includes: string[];
    directories: {
        project: string;
        path: string;
    }[];
    gaps: string[];
}
/** A complete literal settings subset. Unknown statements constrain the whole
 * workspace, even when a recognizable include appears elsewhere. */
export function readGradleSettings(tokens: GradleToken[], kotlinDsl = false): GradleSettingsModel {
    const model: GradleSettingsModel = { includes: [], directories: [], gaps: [] };
    if (kotlinDsl && tokens.some(token => token.literal && token.quote !== '"')) {
        model.gaps.push('Kotlin Gradle string forms require double-quoted literals');
        return model;
    }
    let i = 0;
    while (i < tokens.length) {
        if (tokens[i]?.value === ';') {
            i++;
            continue;
        }
        const token = tokens[i]!;
        if (!token.literal && token.value === 'include') {
            const args = tokenArguments(tokens, i + 1);
            if (args && (!kotlinDsl || tokens[i + 1]?.value === '(')) {
                model.includes.push(...args.values.map(item => item.value));
                i = args.end;
                continue;
            }
        }
        if (!token.literal && token.value === 'rootProject' && tokens[i + 1]?.value === '.' && tokens[i + 2]?.value === 'name' && tokens[i + 3]?.value === '=' && tokens[i + 4]?.literal) {
            i += 5;
            continue;
        }
        if (!token.literal && token.value === 'project') {
            const args = tokenArguments(tokens, i + 1), end = args?.end;
            if (args?.values.length === 1 && tokens[end!]?.value === '.' && tokens[end! + 1]?.value === 'projectDir' && tokens[end! + 2]?.value === '=' && tokens[end! + 3]?.value === 'file') {
                const location = tokenArguments(tokens, end! + 4);
                if (location?.values.length === 1) {
                    model.directories.push({ project: args.values[0]!.value, path: location.values[0]!.value });
                    i = location.end;
                    continue;
                }
            }
        }
        model.gaps.push('Custom Gradle settings/build selection requires a recorded project model');
        break;
    }
    return model;
}
export interface GradleBuildModel {
    plugins: {
        id: string;
        version?: string;
        start: number;
    }[];
    dependencies: {
        scope: string;
        project?: string;
        coordinate?: string;
        start: number;
    }[];
    gaps: string[];
}
/** Parse only complete reviewed DSL statements. Recognizable words in arbitrary
 * expressions never select plugins, roots or dependencies. */
export function readGradleBuild(tokens: GradleToken[], kotlinDsl = false): GradleBuildModel {
    const model: GradleBuildModel = { plugins: [], dependencies: [], gaps: [] };
    if (kotlinDsl && tokens.some(token => token.literal && token.quote !== '"')) {
        model.gaps.push('Kotlin Gradle string forms require double-quoted literals');
        return model;
    }
    const scopes = new Set(['api', 'implementation', 'compileOnly', 'compileOnlyApi', 'runtimeOnly', 'testImplementation', 'testCompileOnly', 'testRuntimeOnly']);
    let i = 0;
    while (i < tokens.length) {
        if (tokens[i]?.value === ';') {
            i++;
            continue;
        }
        const token = tokens[i]!;
        if (!token.literal && ['group', 'version'].includes(token.value) && tokens[i + 1]?.value === '=' && tokens[i + 2]?.literal) {
            i += 3;
            continue;
        }
        if (!['plugins', 'dependencies', 'repositories'].includes(token.value) || token.literal || tokens[i + 1]?.value !== '{') {
            model.gaps.push('Custom Gradle roots/classpath/flow require a recorded compilation model');
            break;
        }
        const section = token.value;
        i += 2;
        while (i < tokens.length && tokens[i]?.value !== '}') {
            if (tokens[i]?.value === ';') {
                i++;
                continue;
            }
            const item = tokens[i]!;
            if (section === 'plugins') {
                let id: string | undefined, end = i + 1;
                if (kotlinDsl && !item.literal && item.value === 'java')
                    id = item.value;
                else if (!item.literal && (item.value === 'id' || kotlinDsl && item.value === 'kotlin') && (!kotlinDsl || tokens[i + 1]?.value === '(')) {
                    const args = tokenArguments(tokens, i + 1);
                    if (args?.values.length === 1) {
                        id = item.value === 'kotlin' ? `org.jetbrains.kotlin.${args.values[0]!.value}` : args.values[0]!.value;
                        end = args.end;
                    }
                }
                if (!id || !['java', 'java-library', 'org.jetbrains.kotlin.jvm'].includes(id)) {
                    model.gaps.push('Unreviewed Gradle plugin selection can change source/classpath inputs');
                    break;
                }
                let version: string | undefined;
                if (!tokens[end]?.literal && tokens[end]?.value === 'version') {
                    const args = tokenArguments(tokens, end + 1);
                    if (args?.values.length !== 1) {
                        model.gaps.push('Dynamic Gradle plugin version');
                        break;
                    }
                    version = args.values[0]!.value;
                    end = args.end;
                }
                if (tokens[end]?.value === 'apply') {
                    model.gaps.push('Gradle apply flags require a selected plugin application model');
                    break;
                }
                model.plugins.push({ id, version, start: item.start });
                i = end;
            }
            else if (section === 'repositories') {
                if (!['mavenCentral', 'google', 'mavenLocal'].includes(item.value) || tokens[i + 1]?.value !== '(' || tokens[i + 2]?.value !== ')') {
                    model.gaps.push('Custom Gradle repository DSL requires a recorded dependency model');
                    break;
                }
                i += 3;
            }
            else {
                if (!scopes.has(item.value) || item.literal) {
                    model.gaps.push('Unreviewed Gradle dependency configuration');
                    break;
                }
                const outer = tokens[i + 1]?.value === '(', expressionAt = i + (outer ? 2 : 1), expression = tokens[expressionAt];
                let project: string | undefined, coordinate: string | undefined, end = expressionAt + 1;
                if (expression?.literal)
                    coordinate = expression.value;
                else if (expression?.value === 'project') {
                    const args = tokenArguments(tokens, expressionAt + 1);
                    if (args?.values.length === 1) {
                        project = args.values[0]!.value;
                        end = args.end;
                    }
                }
                if (kotlinDsl && !outer || (!project && !coordinate) || outer && tokens[end]?.value !== ')') {
                    model.gaps.push('Gradle catalog/provider/map dependency requires a recorded selection');
                    break;
                }
                if (outer)
                    end++;
                if (tokens[end]?.value === '{' || tokens[end]?.value === '.') {
                    model.gaps.push('Gradle dependency customization requires a recorded selection');
                    break;
                }
                model.dependencies.push({ scope: item.value, project, coordinate, start: item.start });
                i = end;
            }
        }
        if (model.gaps.length)
            break;
        if (tokens[i]?.value !== '}') {
            model.gaps.push('Incomplete Gradle DSL block');
            break;
        }
        i++;
    }
    return model;
}
