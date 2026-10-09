import type { Node } from 'web-tree-sitter';
import type { DeclarationFact, RustSite, RustExpression, RustTypeFact, RustSyntaxFacts, RustSemanticFacts, RustScopeFact, RustDefinitionFact, RustParameter } from '../facts.js';
import type { SourceText } from '../source-map.js';
import { rustName, rustString } from '../languages/rust-cfg.js';
/** Original syntax only. No compiler type inference, macro expansion or target execution. */
export function extractRustSemantic(root: Node, declarations: DeclarationFact[], source: SourceText, syntax: RustSyntaxFacts): RustSemanticFacts {
    const facts: RustSemanticFacts = { definitions: [], impls: [], bindings: [], references: [], calls: [], statements: [], writes: [], returns: [], complete: syntax.complete, gaps: [] };
    const byStart = new Map(declarations.map(d => [d.start, d])), byScope = new Map(syntax.scopes.map(s => [s.key, s]));
    let visits = 0;
    const site = (node: Node): RustSite => ({ start: node.startIndex, end: node.endIndex, range: source.range(node.startIndex, node.endIndex) });
    const attributes = (node: Node) => {
        const result: string[] = [];
        for (let p = node.previousNamedSibling; p?.type === 'attribute_item'; p = p.previousNamedSibling)
            result.unshift(p.text);
        return result;
    };
    const visibility = (node: Node) => node.namedChildren.find(n => n.type === 'visibility_modifier')?.text.replace(/\s+/g, '') ?? 'private';
    const typeParameters = (node: Node) => node.childForFieldName('type_parameters')?.namedChildren.map(n => n.childForFieldName('name')?.text).filter((name): name is string => !!name).map(rustName) ?? [];
    const scopeAt = (node: Node, current: RustScopeFact) => {
        const kinds:RustScopeFact['kind'][]=node.type==='block'?['block']:['closure_expression','async_block'].includes(node.type)?['lambda']:['if_expression','while_expression','for_expression','match_arm'].includes(node.type)?['control']:node.type==='impl_item'?['impl']:node.type==='trait_item'?['trait']:['declaration_list','enum_variant_list'].includes(node.type)?['module','enum']:[];
        return syntax.scopes.find(scope=>kinds.includes(scope.kind)&&scope.start===node.startIndex&&scope.end===node.endIndex)??current;
    };
    const textPath = (node: Node) => { const text = node.text.replace(/\s+/g, ''), valid = /^(?:::)?(?:r#)?[_\p{ID_Start}][_\p{ID_Continue}]*(?:::(?:r#)?[_\p{ID_Start}][_\p{ID_Continue}]*)*$/u.test(text); return valid ? { segments: text.split('::').filter(Boolean).map(rustName), absolute: text.startsWith('::') } : undefined; };
    function type(node: Node | null | undefined, depth = 0): RustTypeFact | undefined {
        if (!node)
            return;
        if (depth > 64)
            return { ...site(node), kind: 'unknown', text: node.text };
        if (node.type === 'reference_type') {
            const inner = type(node.childForFieldName('type'), depth + 1);
            return { ...site(node), kind: 'reference', text: node.text, inner, mutable: node.namedChildren.some(n => n.type === 'mutable_specifier') };
        }
        if (node.type === 'function_type')
            return { ...site(node), kind: 'function', text: node.text };
        if (node.type === 'generic_type') {
            const head = node.childForFieldName('type'), path = head && textPath(head);
            return { ...site(node), kind: path ? 'path' : 'unknown', text: node.text, ...path, generics: true };
        }
        const path = textPath(node);
        return { ...site(node), kind: path ? 'path' : 'unknown', text: node.text, ...path };
    }
    function expression(node: Node | null | undefined, depth = 0): RustExpression {
        if (!node)
            return { start: 0, end: 0, range: { startLine: 1, endLine: 1 }, kind: 'unknown', text: 'Missing original expression' };
        const at = site(node), unknown = (): RustExpression => ({ ...at, kind: 'unknown', text: node.text.slice(0, 1000) });
        if (depth > 64)
            return unknown();
        const next = (n: Node | null | undefined) => expression(n, depth + 1);
        if (node.type === 'macro_invocation') {
            const macro = syntax.macros?.find(macro => macro.start === node.startIndex && macro.end === node.endIndex);
            if (macro) return { ...at, kind: 'macro', path: macro.path, absolute:macro.absolute, tokens: macro.tokens, operands: macro.operands };
        }
        if (['identifier', 'scoped_identifier', 'type_identifier', 'scoped_type_identifier', 'self', 'crate', 'super', 'primitive_type'].includes(node.type)) {
            const path = textPath(node);
            return path ? { ...at, kind: 'path', ...path } : { ...at, kind: 'path', segments: [], absolute: false, qualified: true };
        }
        if (node.type === 'generic_function') {
            const base = next(node.childForFieldName('function'));
            return base.kind === 'path' ? { ...base, ...at, generics: node.childForFieldName('type_arguments')?.namedChildren.map(n => n.text) ?? [] } : unknown();
        }
        if (node.type === 'field_expression')
            return { ...at, kind: 'field', value: next(node.childForFieldName('value')), name: rustName(node.childForFieldName('field')?.text ?? '') };
        if (node.type === 'call_expression')
            return { ...at, kind: 'call', callee: next(node.childForFieldName('function')), args: node.childForFieldName('arguments')?.namedChildren.filter(n => !n.type.includes('comment')).map(next) ?? [] };
        if (['closure_expression', 'async_block'].includes(node.type))
            return { ...at, kind: node.type === 'async_block' ? 'async' : 'closure', key: `${node.startIndex}:${node.endIndex}:${node.type === 'async_block' ? 'async' : 'closure'}` };
        if (node.type === 'reference_expression')
            return { ...at, kind: 'reference', value: next(node.childForFieldName('value')), mutable: node.namedChildren.some(n => n.type === 'mutable_specifier') };
        if (node.type === 'unary_expression' && node.text.trimStart().startsWith('*'))
            return { ...at, kind: 'deref', value: next(node.namedChildren.at(-1)) };
        if (['await_expression', 'parenthesized_expression', 'try_expression'].includes(node.type))
            return { ...at, kind: node.type === 'await_expression' ? 'await' : node.type === 'try_expression' ? 'try' : 'paren', value: next(node.namedChildren[0]) };
        if (node.type === 'type_cast_expression')
            return { ...at, kind: 'cast', value: next(node.childForFieldName('value')), type: type(node.childForFieldName('type'))! };
        if (node.type === 'struct_expression')
            return { ...at, kind: 'struct', type: type(node.childForFieldName('name'))!, fields: (node.childForFieldName('body')?.namedChildren ?? []).filter(n => ['field_initializer', 'shorthand_field_initializer'].includes(n.type)).map(n => ({ name: rustName(n.childForFieldName('field')?.text ?? n.text), value: next(n.childForFieldName('value') ?? n.namedChildren.at(-1)) })) };
        if (['tuple_expression', 'array_expression'].includes(node.type))
            return { ...at, kind: node.type === 'tuple_expression' ? 'tuple' : 'array', values: node.namedChildren.map(next) };
        if (node.type === 'block')
            return { ...at, kind: 'block', scope: scopeAt(node, syntax.scopes[0]!).key };
        if (['string_literal', 'raw_string_literal'].includes(node.type)) {
            const value = rustString(node.text);
            return value === undefined ? unknown() : { ...at, kind: 'literal', value };
        }
        if (node.type === 'boolean_literal')
            return { ...at, kind: 'literal', value: node.text === 'true' };
        if (['integer_literal', 'float_literal'].includes(node.type)) {
            const value = Number(node.text.replaceAll('_', '').replace(/(?:[iu](?:8|16|32|64|128|size)|f(?:32|64))$/, ''));
            return Number.isFinite(value) ? { ...at, kind: 'literal', value } : unknown();
        }
        return unknown();
    }
    const chain = (scope: RustScopeFact) => {
        const result: RustScopeFact[] = [];
        for (let s: RustScopeFact | undefined = scope; s && result.length < 128; s = s.parent ? byScope.get(s.parent) : undefined)
            result.push(s);
        return result;
    };
    const owner = (scope: RustScopeFact) => chain(scope).find(s => s.owner)?.owner;
    const conditional = (scope: RustScopeFact) => {
        for (const s of chain(scope)) {
            if (s.kind === 'control')
                return true;
            if (s.owner)
                return false;
        }
        return false;
    };
    function pattern(node: Node | null | undefined, scope: RustScopeFact, activation: number, kind: 'parameter' | 'local' | 'pattern', value?: RustExpression, annotation?: RustTypeFact, mutable = false, attrs: string[] = [], gaps: string[] = [], depth = 0): void {
        if (!node || depth > 64)
            return;
        if (['identifier', 'self', 'shorthand_field_identifier'].includes(node.type)) {
            facts.bindings.push({ ...site(node), name: rustName(node.text), scope: scope.key, activation, kind, ...value ? { value } : {}, ...annotation ? { type: annotation } : {}, mutable, attributes: attrs, gaps });
            return;
        }
        if (node.type === 'mut_pattern' || node.type === 'ref_pattern' || node.type === 'reference_pattern') {
            const child = node.namedChildren.find(n => n.type !== 'mutable_specifier');
            pattern(child, scope, activation, kind, value, annotation, mutable || node.text.startsWith('mut '), attrs, gaps, depth + 1);
            return;
        }
        if (node.type === 'tuple_pattern') {
            for (const [index, n] of node.namedChildren.entries())
                pattern(n, scope, activation, kind, value?.kind === 'tuple' ? value.values[index] : undefined, undefined, mutable, attrs, gaps, depth + 1);
            return;
        }
        if (node.type === 'field_pattern') {
            pattern(node.childForFieldName('pattern') ?? node.namedChildren.find(n => n.type === 'shorthand_field_identifier'), scope, activation, kind, undefined, undefined, mutable, attrs, [...gaps, 'Destructured Rust field value/type inference is unavailable'], depth + 1);
            return;
        }
        for (const n of node.namedChildren) {
            if (n.id === node.childForFieldName('type')?.id || n.id === node.childForFieldName('condition')?.id || ['type_identifier', 'scoped_identifier', 'scoped_type_identifier', 'field_identifier', 'mutable_specifier'].includes(n.type))
                continue;
            pattern(n, scope, activation, kind, undefined, undefined, mutable, attrs, [...gaps, 'Pattern-bound Rust value/type inference is unavailable'], depth + 1);
        }
    }
    const typeReferences = (node: Node | null | undefined, scope: RustScopeFact, attrs: string[]) => {
        if (!node)
            return;
        let count = 0;
        const visit = (n: Node) => {
            if (++count > 2048)
                return;
            if (['type_identifier', 'scoped_type_identifier', 'generic_type', 'primitive_type', 'scoped_identifier'].includes(n.type)) {
                const selected = n.type === 'generic_type' ? n.childForFieldName('type')! : n;
                const value = expression(selected);
                facts.references.push({ ...site(selected), scope: scope.key, expression: value, kind: 'type', attributes: attrs });
                if (n.type === 'generic_type')
                    for (const t of n.childForFieldName('type_arguments')?.namedChildren ?? [])
                        visit(t);
                return;
            }
            for (const c of n.namedChildren)
                visit(c);
        };
        visit(node);
    };
    function parameters(node: Node | null | undefined, scope: RustScopeFact, attrs: string[]): RustParameter[] {
        const result: RustParameter[] = [];
        for (const n of node?.namedChildren ?? []) {
            if (n.type.includes('comment') || n.type === 'attribute_item')
                continue;
            if (n.type === 'self_parameter') {
                const text = n.text.replace(/\s+/g, ''), receiver = text === 'self' || text === 'mutself' ? 'value' : text === '&self' ? 'shared' : text === '&mutself' ? 'mutable' : 'opaque';
                result.push({ ...site(n), name: 'self', receiver, mutable: receiver === 'mutable' || text === 'mutself' });
                facts.bindings.push({ ...site(n), name: 'self', scope: scope.key, activation: scope.start, kind: 'parameter', mutable: false, attributes: attrs, gaps: [] });
                continue;
            }
            const p = n.childForFieldName('pattern') ?? n, annotation = type(n.childForFieldName('type')), name = ['identifier', 'self'].includes(p.type) ? rustName(p.text) : undefined, mutable = n.text.trimStart().startsWith('mut ');
            result.push({ ...site(n), ...name ? { name } : {}, ...annotation ? { type: annotation } : {}, mutable });
            pattern(p, scope, scope.start, 'parameter', undefined, annotation, mutable, attrs);
            typeReferences(n.childForFieldName('type'), scope, attrs);
        }
        return result;
    }
    function walk(node: Node, current: RustScopeFact, inherited: string[] = []): void {
        if (++visits > 200000 || facts.references.length + facts.calls.length > 40000) {
            facts.complete = false;
            return;
        }
        if (['attribute_item', 'inner_attribute_item', 'comment', 'line_comment', 'block_comment', 'use_declaration', 'extern_crate_declaration', 'macro_definition', 'macro_invocation'].includes(node.type))
            return;
        const scope = scopeAt(node, current), attrs = [...inherited, ...attributes(node)];
        if (node.type === 'expression_statement' && node.namedChildren[0])
            facts.statements.push({ ...site(node), scope: scope.key, expression: expression(node.namedChildren[0]), attributes: attrs });
        if (node.type === 'impl_item') {
            const selected = type(node.childForFieldName('type'));
            if (selected)
                facts.impls.push({ ...site(node), key: scope.key, scope: scope.key, parent: current.key, type: selected, ...node.childForFieldName('trait') ? { trait: type(node.childForFieldName('trait')) } : {}, generics: !!node.childForFieldName('type_parameters') || node.namedChildren.some(n => n.type === 'where_clause'), typeParameters: typeParameters(node), attributes: attrs, gaps: [] });
            typeReferences(node.childForFieldName('type'), current, attrs);
            typeReferences(node.childForFieldName('trait'), current, attrs);
            for (const n of node.childForFieldName('body')?.namedChildren ?? [])
                walk(n, scope);
            return;
        }
        const declaration = byStart.get(node.startIndex), original = declaration?.end === node.endIndex ? declaration : undefined;
        if (['function_item', 'function_signature_item', 'closure_expression', 'async_block'].includes(node.type)) {
            const isClosure = node.type === 'closure_expression' || node.type === 'async_block', body = node.childForFieldName('body') ?? node.namedChildren.find(n => n.type === 'block'), bodyScope = isClosure ? scope : body ? scopeAt(body, current) : current;
            const kind = isClosure ? node.type === 'async_block' ? 'async' : 'closure' : original?.kind ?? 'function', key = isClosure ? `${node.startIndex}:${node.endIndex}:${kind}` : original?.key;
            if (!key)
                return;
            const definition: RustDefinitionFact = { ...site(node), key, name: isClosure ? kind === 'async' ? '<async block>' : '<closure>' : rustName(original!.name), kind, scope: current.key, ...body ? { body: bodyScope.key } : {}, parameters: parameters(node.childForFieldName('parameters'), bodyScope, attrs), ...node.childForFieldName('return_type') ? { returnType: type(node.childForFieldName('return_type')) } : {}, visibility: visibility(node), attributes: attrs, generics: !!node.childForFieldName('type_parameters') || node.namedChildren.some(n => n.type === 'where_clause'), async: node.type === 'async_block' || !!node.children.find(n => n.type === 'async') || !!node.namedChildren.find(n => n.type === 'function_modifiers' && /\basync\b/.test(n.text)), ...['impl', 'trait'].includes(current.kind) ? { impl: current.key } : {}, gaps: [] };
            facts.definitions.push(definition);
            definition.typeParameters = typeParameters(node);
            typeReferences(node.childForFieldName('return_type'), bodyScope, attrs);
            if (body) {
                walk(body, bodyScope);
                const tail = body.type === 'block' ? body.namedChildren.at(-1) : body;
                if (tail && tail.type !== 'return_expression' && tail.type !== 'let_declaration' && tail.type !== 'empty_statement' && !tail.type.endsWith('_item') && !(tail.type === 'expression_statement' && tail.text.trimEnd().endsWith(';'))) {
                    const n = tail.type === 'expression_statement' ? tail.namedChildren[0]! : tail;
                    facts.returns.push({ ...site(n), scope: scopeAt(body, bodyScope).key, owner: key, value: expression(n), conditional: conditional(bodyScope) });
                }
            }
            return;
        }
        if (original && ['struct', 'union', 'enum', 'trait', 'type', 'constant', 'static', 'field', 'variant'].includes(original.kind)) {
            facts.definitions.push({ ...site(node), key: original.key, name: rustName(original.name), kind: original.kind, scope: current.key, parameters: [], visibility: visibility(node), attributes: attrs, generics: !!node.childForFieldName('type_parameters') || node.namedChildren.some(n => n.type === 'where_clause'), typeParameters: typeParameters(node), async: false, ...original.parent ? { parent: original.parent } : {}, ...node.childForFieldName('type') ? { returnType: type(node.childForFieldName('type')) } : {}, ...node.childForFieldName('value') ? { value: expression(node.childForFieldName('value')) } : {}, gaps: node.type === 'static_item' && node.namedChildren.some(n => n.type === 'mutable_specifier') ? ['Mutable Rust static value is unavailable'] : [] });
            typeReferences(node.childForFieldName('type'), current, attrs);
            if (['type', 'constant', 'static', 'field'].includes(original.kind))
                return;
        }
        if (node.type === 'let_declaration') {
            const value = node.childForFieldName('value'), annotation = type(node.childForFieldName('type'));
            pattern(node.childForFieldName('pattern'), scope, node.endIndex, 'local', value ? expression(value) : undefined, annotation, node.namedChildren.some(n => n.type === 'mutable_specifier'), attrs);
            typeReferences(node.childForFieldName('type'), scope, attrs);
            if (value)
                walk(value, scope, attrs);
            for (const alternative of node.namedChildren.filter(n => n.type === 'block' || n.type === 'else_clause'))
                walk(alternative, scope, attrs);
            return;
        }
        if (node.type === 'let_condition') {
            const value = node.childForFieldName('value');
            if (value)
                walk(value, scope, attrs);
            pattern(node.childForFieldName('pattern'), scope, node.endIndex, 'pattern', undefined, undefined, false, attrs);
            return;
        }
        if (node.type === 'for_expression') {
            const value = node.childForFieldName('value');
            if (value)
                walk(value, current, attrs);
            pattern(node.childForFieldName('pattern'), scope, value?.endIndex ?? node.startIndex, 'pattern', undefined, undefined, false, attrs);
            const body = node.childForFieldName('body');
            if (body)
                walk(body, scope, attrs);
            return;
        }
        if (node.type === 'match_arm') {
            const p = node.childForFieldName('pattern');
            pattern(p, scope, p?.startIndex ?? node.startIndex, 'pattern', undefined, undefined, false, attrs);
            const guard = p?.childForFieldName('condition');
            if (guard)
                walk(guard, scope, attrs);
            const value = node.childForFieldName('value');
            if (value)
                walk(value, scope, attrs);
            return;
        }
        if (node.type === 'if_expression' || node.type === 'while_expression') {
            for (const n of node.namedChildren)
                walk(n, n.type === 'else_clause' ? current : scope, attrs);
            return;
        }
        if (node.type === 'return_expression') {
            const key = owner(scope), value = node.namedChildren[0];
            if (key && value)
                facts.returns.push({ ...site(node), scope: scope.key, owner: key, value: expression(value), conditional: conditional(scope) });
            if (value)
                walk(value, scope, attrs);
            return;
        }
        if (['assignment_expression', 'compound_assignment_expr'].includes(node.type)) {
            const left = node.childForFieldName('left'), right = node.childForFieldName('right');
            if (left)
                facts.writes.push({ ...site(node), scope: scope.key, target: expression(left), ...right && node.type === 'assignment_expression' ? { value: expression(right) } : {}, kind: 'assignment' });
            if (right)
                walk(right, scope, attrs);
            return;
        }
        if (node.type === 'reference_expression' && node.namedChildren.some(n => n.type === 'mutable_specifier'))
            facts.writes.push({ ...site(node), scope: scope.key, target: expression(node.childForFieldName('value')), kind: 'mutable-borrow' });
        if (node.type === 'call_expression') {
            const value = expression(node) as RustExpression & {
                kind: 'call';
            };
            facts.calls.push({ ...site(node), scope: scope.key, expression: value, attributes: attrs, awaited: node.parent?.type === 'await_expression' });
            const fn = node.childForFieldName('function');
            if (fn) {
                facts.references.push({ ...site(fn), scope: scope.key, expression: expression(fn), kind: 'value', attributes: attrs });
                if (fn.type === 'field_expression') {
                    const receiver = fn.childForFieldName('value');
                    if (receiver)
                        walk(receiver, scope, attrs);
                }
                else if (!['identifier', 'scoped_identifier', 'generic_function', 'type_identifier', 'scoped_type_identifier'].includes(fn.type))
                    walk(fn, scope, attrs);
            }
            for (const arg of node.childForFieldName('arguments')?.namedChildren ?? [])
                walk(arg, scope, attrs);
            return;
        }
        if (['identifier', 'scoped_identifier', 'self', 'field_expression', 'generic_function'].includes(node.type)) {
            facts.references.push({ ...site(node), scope: scope.key, expression: expression(node), kind: 'value', attributes: attrs });
            if (node.type === 'field_expression') {
                const receiver = node.childForFieldName('value');
                if (receiver)
                    walk(receiver, scope, attrs);
            }
            return;
        }
        if (node.type === 'struct_expression') {
            typeReferences(node.childForFieldName('name'), scope, attrs);
            for (const n of node.childForFieldName('body')?.namedChildren ?? []) {
                const value = n.childForFieldName('value');
                if (value)
                    walk(value, scope, attrs);
            }
            return;
        }
        for (const n of node.namedChildren)
            walk(n, scope, attrs);
    }
    for (const node of root.namedChildren)
        walk(node, syntax.scopes[0]!);
    if (!facts.complete)
        facts.gaps.push('Incomplete/truncated original Rust semantic syntax');
    return facts;
}
