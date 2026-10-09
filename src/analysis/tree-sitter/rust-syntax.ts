import type { Node } from 'web-tree-sitter';
import type { DeclarationFact, RustImportFact, RustItemFact, RustScopeFact, RustSyntaxFacts } from '../facts.js';
import type { SourceText } from '../source-map.js';
import { rustName, rustIdentifier } from '../languages/rust-cfg.js';
import { extractRustSemantic } from './rust-semantic.js';
export function extractRust(root: Node, declarations: DeclarationFact[], source: SourceText): RustSyntaxFacts {
    const facts: RustSyntaxFacts = { scopes: [], items: [], imports: [], complete: !root.hasError, gaps: [] };
    let visits = 0;
    const byStart = new Map(declarations.map(item => [item.start, item]));
    const site = (node: Node) => ({ start: node.startIndex, end: node.endIndex, range: source.range(node.startIndex, node.endIndex) });
    const attributes = (node: Node) => {
        const values: string[] = [];
        for (let s = node.previousNamedSibling; s?.type === 'attribute_item'; s = s.previousNamedSibling)
            values.unshift(s.text);
        return values;
    };
    const visibility = (node: Node) => node.namedChildren.find(n => n.type === 'visibility_modifier')?.text.replace(/\s+/g, '') ?? 'private';
    function scope(node: Node, kind: RustScopeFact['kind'], parent?: RustScopeFact, module?: string): RustScopeFact {
        const key = kind === 'file' ? 'root' : `${node.startIndex}:${node.endIndex}:${kind}`;
        const value: RustScopeFact = { key, kind, ...site(node), ...(parent ? { parent: parent.key } : {}), module: module ?? parent?.module ?? key, attributes: node.namedChildren.filter(n => n.type === 'inner_attribute_item').map(n => n.text), gaps: [] };
        facts.scopes.push(value);
        return value;
    }
    function useTree(node: Node, prefix: string[], base: Omit<RustImportFact, 'segments' | 'specifier' | 'alias' | 'glob' | 'selfOnly'>, absolute = false, depth = 0): void {
        if (depth > 64 || facts.imports.length > 20000) {
            facts.complete = false;
            return;
        }
        const emit = (segments: string[], alias?: string, glob = false, selfOnly = false) => facts.imports.push({ ...base, segments, specifier: (absolute ? '::' : '') + segments.join('::') + (glob ? '::*' : ''), absolute, ...(alias ? { alias } : {}), glob, selfOnly });
        if (node.type === 'use_as_clause') {
            const children = node.namedChildren;
            const target = children[0], alias = children.at(-1)?.text;
            if (!target || !alias)
                return;
            const before = facts.imports.length;
            useTree(target, prefix, base, absolute, depth + 1);
            for (const item of facts.imports.slice(before))
                item.alias = rustName(alias);
            return;
        }
        if (node.type === 'use_list') {
            for (const child of node.namedChildren)
                if (!['comment', 'line_comment', 'block_comment'].includes(child.type))
                    useTree(child, prefix, base, absolute, depth + 1);
            return;
        }
        if (node.type === 'scoped_use_list') {
            const list = node.namedChildren.find(n => n.type === 'use_list'), path = node.namedChildren.find(n => n.type !== 'use_list');
            const parts = path?.text.replace(/\s+/g, '').split('::').filter(Boolean) ?? [];
            if (list)
                useTree(list, [...prefix, ...parts.map(rustName)], base, absolute || node.text.trimStart().startsWith('::'), depth + 1);
            return;
        }
        if (node.type === 'use_wildcard') {
            const text = node.text.replace(/\s+/g, '').replace(/(?:::)?\*$/, '');
            absolute = absolute || text.startsWith('::');
            emit([...prefix, ...text.split('::').filter(Boolean).map(rustName)], undefined, true);
            return;
        }
        const text = node.text.replace(/\s+/g, ''), parts = text.split('::').filter(Boolean).map(rustName);
        if (parts.some(part => !rustIdentifier(part) && !['self', 'super', 'crate'].includes(part))) {
            emit([...prefix, ...parts]);
            facts.imports.at(-1)!.gaps.push('Unreviewed Rust use tree');
            return;
        }
        const selfOnly = parts.at(-1) === 'self' && (prefix.length > 0 || parts.length > 1);
        if (selfOnly)
            parts.pop();
        emit([...prefix, ...parts], undefined, false, selfOnly);
        facts.imports.at(-1)!.absolute = absolute || text.startsWith('::');
        facts.imports.at(-1)!.specifier = (facts.imports.at(-1)!.absolute ? '::' : '') + facts.imports.at(-1)!.segments.join('::');
    }
    const top = scope(root, 'file');
    function visit(node: Node, current: RustScopeFact, enumVisibility?: string): void {
        if (++visits > 200000) {
            facts.complete = false;
            return;
        }
        if (['attribute_item', 'inner_attribute_item', 'comment', 'line_comment', 'block_comment'].includes(node.type))
            return;
        if (node.type === 'macro_invocation') {
            current.gaps.push('Rust macro invocation can supply generated/scoped items; expansion is unavailable');
            return;
        }
        if (node.type === 'use_declaration') {
            const tree = node.childForFieldName('argument') ?? node.namedChildren.find(n => n.type !== 'visibility_modifier');
            if (tree)
                useTree(tree, [], { ...site(node), scope: current.key, absolute: false, visibility: visibility(node), attributes: attributes(node), kind: 'use', gaps: [] });
            return;
        }
        if (node.type === 'extern_crate_declaration') {
            const names = node.namedChildren.filter(n => ['identifier', 'self'].includes(n.type));
            const name = names[0]?.text, alias = names[1]?.text;
            if (name)
                facts.imports.push({ ...site(node), scope: current.key, specifier: rustName(name), segments: [rustName(name)], absolute: false, ...(alias ? { alias: rustName(alias) } : {}), glob: false, selfOnly: false, visibility: visibility(node), attributes: attributes(node), kind: 'extern', gaps: [] });
            return;
        }
        const declaration = byStart.get(node.startIndex);
        let item: RustItemFact | undefined;
        if (declaration?.end === node.endIndex && !['impl', 'trait'].includes(current.kind) && ['module', 'struct', 'union', 'enum', 'trait', 'type', 'function', 'constant', 'static', 'macro', 'variant'].includes(declaration.kind)) {
            const namespaces: RustItemFact['namespaces'] = declaration.kind === 'macro' ? ['macro'] : ['function', 'constant', 'static'].includes(declaration.kind) ? ['value'] : declaration.kind === 'variant' ? ['type', 'value'] : declaration.kind === 'struct' && !node.namedChildren.some(n => n.type === 'field_declaration_list') ? ['type', 'value'] : ['type'];
            item = { ...site(node), key: declaration.key, scope: current.key, name: rustName(declaration.name), kind: declaration.kind, namespaces, visibility: enumVisibility ?? visibility(node), attributes: attributes(node), gaps: [] };
            facts.items.push(item);
        }
        if (node.type === 'mod_item') {
            if (!item)
                return;
            const body = node.childForFieldName('body') ?? node.namedChildren.find(n => n.type === 'declaration_list');
            if (body) {
                const child = scope(body, 'module', current);
                child.module = child.key;
                item.memberScope = child.key;
                for (const n of body.namedChildren)
                    visit(n, child);
            }
            return;
        }
        if (node.type === 'enum_item') {
            const body = node.childForFieldName('body') ?? node.namedChildren.find(n => n.type === 'enum_variant_list');
            if (body && item) {
                const child = scope(body, 'enum', current);
                item.memberScope = child.key;
                for (const n of body.namedChildren)
                    visit(n, child, item.visibility);
            }
            return;
        }
        if (node.type === 'block') {
            const child = scope(node, 'block', current, current.module);
            for (const n of node.namedChildren)
                visit(n, child);
            return;
        }
        if (['impl_item', 'trait_item'].includes(node.type)) {
            const child = scope(node, node.type === 'impl_item' ? 'impl' : 'trait', current);
            child.attributes.push(...attributes(node));
            const body = node.childForFieldName('body');
            if (body)
                for (const n of body.namedChildren)
                    visit(n, child);
            return; // Associated definitions remain outside the import namespace.
        }
        if (['closure_expression', 'async_block'].includes(node.type)) {
            const child = scope(node, 'lambda', current);
            child.owner = `${node.startIndex}:${node.endIndex}:${node.type === 'async_block' ? 'async' : 'closure'}`;
            const body = node.childForFieldName('body') ?? node.namedChildren.find(n => n.type === 'block');
            if (body)
                visit(body, child);
            return;
        }
        if (['if_expression', 'while_expression', 'for_expression', 'match_arm'].includes(node.type)) {
            const child = scope(node, 'control', current);
            child.attributes.push(...attributes(node));
            for (const n of node.namedChildren)
                visit(n, n.type === 'else_clause' ? current : child);
            return;
        }
        if (node.type === 'function_item') {
            const body = node.childForFieldName('body');
            if (body) {
                const child = scope(body, 'block', current, current.module);
                child.owner = declaration?.key;
                child.attributes.push(...attributes(node));
                if (item)
                    item.body = child.key;
                for (const n of body.namedChildren)
                    visit(n, child);
            }
            return;
        }
        // Declarations' type/initializer nodes cannot introduce module imports;
        // blocks still retain their own original lexical scopes.
        for (const n of node.namedChildren)
            visit(n, current, enumVisibility);
    }
    for (const node of root.namedChildren)
        visit(node, top);
    if (!facts.complete)
        facts.gaps.push('Incomplete/truncated original Rust syntax');
    facts.semantic = extractRustSemantic(root, declarations, source, facts);
    return facts;
}
