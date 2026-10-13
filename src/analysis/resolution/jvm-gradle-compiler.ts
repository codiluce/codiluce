import type { GradleToken } from './jvm-manifest.js';

export interface GradleCompilerInputs {
    javaToolchains: { languageVersion: number; start: number }[];
    kotlinArgumentUpdates: { operation: 'add' | 'addAll' | 'set'; arguments: { value: string; start: number }[]; start: number }[];
    testPlatforms: { selector: string; platform: 'junit-platform'; start: number }[];
}
export const emptyGradleCompilerInputs = (): GradleCompilerInputs => ({ javaToolchains: [], kotlinArgumentUpdates: [], testPlatforms: [] });
const symbol = (token: GradleToken | undefined, value: string) => token?.value === value && !token.literal && !token.escapedIdentifier;
const sequence = (tokens: GradleToken[], values: string[]) => tokens.length === values.length && tokens.every((token, index) => symbol(token, values[index]!));
const trimSeparators = (tokens: GradleToken[]) => {
    let start = 0, end = tokens.length;
    while (symbol(tokens[start], ';')) start++;
    while (symbol(tokens[end - 1], ';')) end--;
    return tokens.slice(start, end);
};

/** Complete literal standard extension/task blocks only. These are observed
 * inputs, not executed configuration or a selected host/compiler installation. */
export function readGradleCompilerBlock(tokens: GradleToken[], at: number, kotlinDsl: boolean): (GradleCompilerInputs & { end: number; gaps: string[] }) | undefined {
    const first = tokens[at];
    if (!first || first.literal || first.escapedIdentifier || !['java', 'kotlin', 'test', 'tasks'].includes(first.value))
        return;
    let opening = at + 1;
    if (first.value === 'tasks') {
        while (opening < tokens.length && !symbol(tokens[opening], '{') && !symbol(tokens[opening], ';') && !symbol(tokens[opening], '}') && opening - at < 32)
            opening++;
    }
    if (!symbol(tokens[opening], '{') || tokens[opening]!.depth !== first.depth)
        return;
    const closing = tokens.findIndex((token, index) => index > opening && symbol(token, '}') && token.depth === first.depth + 1);
    if (closing < 0)
        return;
    const result = { ...emptyGradleCompilerInputs(), end: closing + 1, gaps: [] as string[] };
    const body = trimSeparators(tokens.slice(opening + 1, closing));
    const header = tokens.slice(at, opening);
    if (first.value === 'java') {
        let selected = body;
        if (sequence(body.slice(0, 2), ['toolchain', '{']) && symbol(body.at(-1), '}'))
            selected = trimSeparators(body.slice(2, -1));
        else {
            result.gaps.push('Custom Gradle Java extension requires a reviewed compiler/source model');
            return result;
        }
        let expression: GradleToken[];
        if (sequence(selected.slice(0, 2), ['languageVersion', '=']))
            expression = selected.slice(2);
        else if (sequence(selected.slice(0, 4), ['languageVersion', '.', 'set', '(']) && symbol(selected.at(-1), ')'))
            expression = selected.slice(4, -1);
        else {
            result.gaps.push('Opaque Gradle Java toolchain language version');
            return result;
        }
        const qualifier = ['org', '.', 'gradle', '.', 'jvm', '.', 'toolchain', '.'];
        if (sequence(expression.slice(0, qualifier.length), qualifier))
            expression = expression.slice(qualifier.length);
        const value = expression[4];
        if (sequence(expression.slice(0, 4), ['JavaLanguageVersion', '.', 'of', '(']) && expression.length === 6 && symbol(expression[5], ')')
            && value && !value.escapedIdentifier && /^[1-9]\d*$/.test(value.value) && Number(value.value) <= 2147483647
            && (!value.literal || !kotlinDsl || value.quote === '"')) {
            result.javaToolchains.push({ languageVersion: Number(value.value), start: selected[0]!.start });
        }
        else result.gaps.push('Opaque/nonliteral Gradle Java toolchain language version');
    }
    else if (first.value === 'kotlin') {
        if (!sequence(body.slice(0, 2), ['compilerOptions', '{']) || !symbol(body.at(-1), '}')) {
            result.gaps.push('Custom Gradle Kotlin extension requires a reviewed compiler/source model');
            return result;
        }
        const options = trimSeparators(body.slice(2, -1));
        let i = 0;
        while (i < options.length) {
            if (symbol(options[i], ';')) { i++; continue; }
            const operation = options[i + 2]?.value;
            if (!sequence(options.slice(i, i + 2), ['freeCompilerArgs', '.']) || !['add', 'addAll', 'set'].includes(operation ?? '')
                || options[i + 2]?.literal || options[i + 2]?.escapedIdentifier || !symbol(options[i + 3], '(')) {
                result.gaps.push('Unreviewed Gradle Kotlin compiler option statement');
                break;
            }
            const start = options[i]!.start, arguments_: { value: string; start: number }[] = [];
            i += 4;
            let wrapper: ')' | ']' | undefined;
            if (symbol(options[i], 'listOf') && symbol(options[i + 1], '(') && kotlinDsl) { wrapper = ')'; i += 2; }
            else if (symbol(options[i], '[') && !kotlinDsl) { wrapper = ']'; i++; }
            let malformed = false;
            while (options[i]?.literal) {
                arguments_.push({ value: options[i]!.value, start: options[i]!.start });
                i++;
                if (!symbol(options[i], ',')) break;
                i++;
                if (!options[i]?.literal) {
                    if (!kotlinDsl || !symbol(options[i], wrapper ?? ')')) malformed = true;
                    break;
                }
            }
            if (malformed || !arguments_.length && !wrapper || wrapper && !symbol(options[i++], wrapper) || !symbol(options[i++], ')') || operation === 'add' && (arguments_.length !== 1 || !!wrapper)
                || operation === 'set' && !wrapper) {
                result.gaps.push('Opaque Gradle Kotlin compiler argument list');
                break;
            }
            result.kotlinArgumentUpdates.push({ operation: operation as 'add' | 'addAll' | 'set', arguments: arguments_, start });
            for (const argument of arguments_) {
                if (!/^-Xjsr305=(?:strict|warn|ignore)$/.test(argument.value) && argument.value !== '-java-parameters' && argument.value !== '-Xannotation-default-target=param-property')
                    result.gaps.push('Unreviewed Kotlin compiler argument can change source/binding inputs: ' + argument.value);
            }
        }
    }
    else {
        const typed = (prefix: string[], suffix: string[]) => sequence(header, [...prefix, 'Test', ...suffix])
            || sequence(header, [...prefix, 'org', '.', 'gradle', '.', 'api', '.', 'tasks', '.', 'testing', '.', 'Test', ...suffix]);
        const named = !kotlinDsl && header.length === 6 && sequence(header.slice(0, 4), ['tasks', '.', 'named', '(']) && header[4]?.literal && header[4].value === 'test' && symbol(header[5], ')');
        const typedNamed = kotlinDsl && header.at(-2)?.literal && header.at(-2)?.value === 'test' && symbol(header.at(-1), ')')
            && (sequence(header.slice(0, -2), ['tasks', '.', 'named', '<', 'Test', '>', '('])
                || sequence(header.slice(0, -2), ['tasks', '.', 'named', '<', 'org', '.', 'gradle', '.', 'api', '.', 'tasks', '.', 'testing', '.', 'Test', '>', '(']));
        const reviewed = !kotlinDsl && sequence(header, ['test']) || sequence(header, ['tasks', '.', 'test']) || named || typedNamed
            || kotlinDsl && (typed(['tasks', '.', 'withType', '<'], ['>']) || typed(['tasks', '.', 'withType', '<'], ['>', '(', ')', '.', 'configureEach']))
            || !kotlinDsl && (typed(['tasks', '.', 'withType', '('], [')']) || typed(['tasks', '.', 'withType', '('], [')', '.', 'configureEach']));
        if (!reviewed || !sequence(body, ['useJUnitPlatform', '(', ')']))
            result.gaps.push('Custom Gradle test task/framework configuration requires a reviewed task model');
        else result.testPlatforms.push({ selector: header.map(token => token.literal ? token.quote + token.value + token.quote : token.value).join(''), platform: 'junit-platform', start: first.start });
    }
    return result;
}
