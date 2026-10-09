import type { Node } from 'web-tree-sitter';
import type { CsharpSyntaxFacts, DeclarationFact } from '../facts.js';
import { extractCsharpSemantic } from './csharp-semantic.js';
import type { SourceText } from '../source-map.js';
const types = new Set(['class', 'interface', 'struct', 'enum', 'record', 'type']);
const name = (text: string) => text.replace(/\s+/g, '').replace(/@([\p{L}_][\p{L}\p{N}_]*)/gu, '$1');
/** Original directives/types only. Conditional preprocessing is a recorded
 * boundary until a selected compiler profile can prove the active tree. */
export function extractCsharp(root: Node, declarations: DeclarationFact[], source: SourceText): CsharpSyntaxFacts {
    const facts: CsharpSyntaxFacts = { imports: [], declarations: [], namespaces: [], complete: !root.hasError, gaps: [] };
    const fileNamespace = root.namedChildren.find(node => node.type === 'file_scoped_namespace_declaration');
    const namespaceAt = (node: Node): string => {
        const segments: string[] = [];
        for (let parent = node.parent; parent; parent = parent.parent)
            if (parent.type === 'namespace_declaration')
                segments.unshift(name(parent.childForFieldName('name')?.text ?? ''));
        if (fileNamespace && node.startIndex > fileNamespace.startIndex)
            segments.unshift(name(fileNamespace.childForFieldName('name')?.text ?? ''));
        return segments.filter(Boolean).join('.');
    };
    const nodes = new Map<number, Node>(), stack = [root];
    let visited = 0;
    while (stack.length) {
        const node = stack.pop()!;
        if (++visited > 200000) {
            facts.complete = false;
            facts.gaps.push('C# syntax node budget exceeded');
            break;
        }
        nodes.set(node.startIndex, node);
        if (node.type === 'identifier' && /\\u[0-9a-fA-F]{4}|\\U[0-9a-fA-F]{8}/.test(node.text))
            facts.gaps.push('Escaped C# identifiers require reviewed lexical normalization');
        if (node.type.startsWith('preproc_') && !['preproc_region', 'preproc_endregion', 'preproc_nullable', 'preproc_pragma', 'preproc_arg'].includes(node.type))
            facts.gaps.push('Conditional/preprocessor source requires a selected C# lexical profile');
        if (node.type === 'extern_alias_directive')
            facts.gaps.push('Extern assembly aliases require reviewed metadata references');
        if (node.type === 'using_directive') {
            const alias = node.childForFieldName('name'), target = node.namedChildren.find(child => child.id !== alias?.id);
            if (!target || node.hasError)
                facts.complete = false;
            else {
                const namespace = namespaceAt(node), global = node.children.some(child => child.type === 'global'), isStatic = node.children.some(child => child.type === 'static');
                let scope: Node | undefined;
                for (let parent = node.parent; parent; parent = parent.parent)
                    if (parent.type === 'namespace_declaration') {
                        scope = parent;
                        break;
                    }
                facts.imports.push({ specifier: name(target.text), kind: alias ? 'alias' : isStatic ? 'static' : 'namespace', ...(alias ? { alias: name(alias.text) } : {}), global, namespace, scopeStart: scope?.startIndex ?? (namespace && fileNamespace ? fileNamespace.endIndex : 0), scopeEnd: scope?.endIndex ?? source.text.length, start: node.startIndex, end: node.endIndex, range: source.range(node.startIndex, node.endIndex) });
                if (global && namespace)
                    facts.gaps.push('Global using inside a namespace is invalid');
                const container = node.parent?.type === 'declaration_list' ? node.parent : root;
                if (container.namedChildren.some(child => child.startIndex < node.startIndex && (child.type.endsWith('_declaration') && !['using_directive', 'extern_alias_directive', 'file_scoped_namespace_declaration'].includes(child.type) || global && child.type === 'using_directive' && !child.children.some(token => token.type === 'global'))))
                    facts.gaps.push('Using directive appears after declarations or ordinary usings');
            }
        }
        if (['namespace_declaration', 'file_scoped_namespace_declaration'].includes(node.type))
            facts.namespaces.push({ name: [namespaceAt(node), name(node.childForFieldName('name')?.text ?? '')].filter(Boolean).join('.'), start: node.startIndex, range: source.range(node.startIndex, node.endIndex) });
        // Reverse iteration preserves source order for later deterministic facts.
        for (const child of [...node.namedChildren].reverse())
            stack.push(child);
    }
    if (fileNamespace && root.namedChildren.some(node => node.startIndex < fileNamespace.startIndex && node.type.endsWith('_declaration')))
        facts.gaps.push('File-scoped namespace follows another namespace/type declaration');
    const byKey = new Map(declarations.map(declaration => [declaration.key, declaration]));
    for (const declaration of declarations) {
        if (declaration.kind === 'namespace')
            continue;
        // Several nodes share a start (variable declaration / declarator); find
        // the declaration's exact original extent rather than allocation IDs.
        let node: Node | null | undefined = nodes.get(declaration.start);
        if (!node || node.endIndex !== declaration.end)
            node = root.descendantForIndex(declaration.start, declaration.end);
        while (node && node.startIndex === declaration.start && node.endIndex !== declaration.end && node.parent)
            node = node.parent;
        if (!node) {
            facts.complete = false;
            continue;
        }
        const parent = declaration.parent ? byKey.get(declaration.parent) : undefined, parentType = parent && types.has(parent.kind), type = types.has(declaration.kind), modifiers = declaration.modifiers ?? [];
        const parameters = node.namedChildren.find(child => child.type === 'type_parameter_list')?.namedChildren.filter(child => child.type === 'type_parameter').length ?? 0;
        const namespace = namespaceAt(node), visibility = modifiers.includes('protected') ? modifiers.includes('private') ? 'private protected' : modifiers.includes('internal') ? 'protected internal' : 'protected' : declaration.visibility ?? (parentType ? ['interface', 'enum'].includes(parent.kind) ? 'public' : 'private' : 'internal');
        facts.declarations.push({ key: declaration.key, name: name(declaration.name), qualifiedName: name(declaration.qualifiedName), namespace, ...(parentType ? { parent: parent.key } : {}), type, arity: parameters, partial: modifiers.includes('partial'), static: modifiers.includes('static') || modifiers.includes('const'), visibility, fileLocal: modifiers.includes('file'), flavor: declaration.kind === 'record' ? (node.children.some(child => child.type === 'struct') ? 'record-struct' : 'record-class') : declaration.kind, typeParameters: node.namedChildren.find(child => child.type === 'type_parameter_list')?.namedChildren.map(child => name(child.childForFieldName('name')?.text ?? child.text)) ?? [], constraints: node.namedChildren.filter(child => child.type === 'type_parameter_constraints_clause').map(child => name(child.text)), bases: node.namedChildren.find(child => child.type === 'base_list')?.namedChildren.map(child => name(child.text)) ?? [] });
    }
    facts.gaps = [...new Set(facts.gaps)].sort();
    facts.semantic = extractCsharpSemantic(root, declarations, source);
    facts.complete &&= facts.semantic.complete;
    return facts;
}
