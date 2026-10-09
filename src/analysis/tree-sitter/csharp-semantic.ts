import type { Node } from 'web-tree-sitter';
import type { CsharpArgument, CsharpAttribute, CsharpBindingFact, CsharpDefinitionFact, CsharpExpression, CsharpParameter, CsharpScope, CsharpSemanticFacts, DeclarationFact } from '../facts.js';
import type { SourceText } from '../source-map.js';
const types = new Set(['class', 'interface', 'struct', 'enum', 'record', 'type']);
const name = (value: string) => value.replace(/\s+/g, '').replace(/@([\p{L}_][\p{L}\p{N}_]*)/gu, '$1');
/** Scoped original C# syntax; compiler, preprocessor and generated code never run. */
export function extractCsharpSemantic(root: Node, declarations: DeclarationFact[], source: SourceText): CsharpSemanticFacts {
    const facts: CsharpSemanticFacts = { scopes: [], definitions: [], bindings: [], writes: [], references: [], calls: [], returns: [], complete: !root.hasError, gaps: [] };
    const site = (node: Node) => ({ start: Math.min(node.startIndex, source.text.length), end: Math.min(node.endIndex, source.text.length), range: source.range(node.startIndex, node.endIndex) });
    const unknown = (node: Node): CsharpExpression => ({ ...site(node), kind: 'unknown', text: node.text.slice(0, 300) });
    const children = (node: Node) => node.namedChildren.filter(child => child.type !== 'comment');
    const bySite = new Map(declarations.map(fact => [`${fact.start}:${fact.end}`, fact])), lambdaKeys = new Map<number, string>();
    let nodes = 0, expressions = 0, scopeOrdinal = 0, lambdaOrdinal = 0;
    const lambdaKey = (node: Node) => {
        let key = lambdaKeys.get(node.id);
        if (!key) {
            key = 'csharp-lambda:' + lambdaOrdinal++;
            lambdaKeys.set(node.id, key);
        }
        return key;
    };
    const args = (node: Node | undefined, depth = 0): CsharpArgument[] => {
        if (!node)
            return [];
        if (node.namedChildren.length > 128) {
            facts.complete = false;
            return [];
        }
        return children(node).map(argument => {
            const parts = children(argument), identifier = argument.childForFieldName('name'), value = parts.at(-1) ?? argument;
            let alias = identifier?.text;
            const assigned = value.type === 'assignment_expression' && value.childForFieldName('operator')?.text === '=';
            if (assigned)
                alias = value.childForFieldName('left')?.text;
            else if (argument.children.some(child => child.type === ':'))
                alias = parts[0]?.text;
            const modifier = argument.children.find(child => ['ref', 'out', 'in'].includes(child.type))?.text;
            return { ...alias ? { name: name(alias) } : {}, ...modifier ? { modifier } : {}, value: expression(assigned ? value.childForFieldName('right') ?? value : value, depth + 1) };
        });
    };
    const expression = (node: Node, depth = 0): CsharpExpression => {
        if (++expressions > 200000 || depth > 32) {
            facts.complete = false;
            return unknown(node);
        }
        const base = site(node), parts = children(node);
        if (['identifier', 'qualified_name', 'alias_qualified_name', 'predefined_type'].includes(node.type))
            return { ...base, kind: 'name', name: name(node.text) };
        if (['this', 'base', 'this_expression', 'base_expression'].includes(node.type))
            return { ...base, kind: 'name', name: node.text };
        if (['parenthesized_expression', 'arrow_expression_clause', 'await_expression'].includes(node.type) && parts[0])
            return expression(parts[0], depth + 1);
        if (['true', 'false', 'boolean_literal'].includes(node.type))
            return { ...base, kind: 'literal', value: node.text === 'true', type: 'bool' };
        if (node.type === 'null_literal')
            return { ...base, kind: 'literal', value: null, type: 'null' };
        if (node.type === 'integer_literal') {
            const text = node.text.replaceAll('_', ''), suffix = /[uUlL]+$/.exec(text)?.[0] ?? '', raw = text.slice(0, text.length - suffix.length), value = Number(raw);
            return Number.isSafeInteger(value) ? { ...base, kind: 'literal', value, type: /u/i.test(suffix) ? /l/i.test(suffix) ? 'ulong' : 'uint' : /l/i.test(suffix) ? 'long' : value <= 2147483647 ? 'int' : value <= 4294967295 ? 'uint' : 'long' } : unknown(node);
        }
        if (node.type === 'real_literal') {
            const suffix = /[fFdDmM]$/.exec(node.text)?.[0], value = Number(node.text.replaceAll('_', '').replace(/[fFdDmM]$/, ''));
            return Number.isFinite(value) ? { ...base, kind: 'literal', value, type: /m/i.test(suffix ?? '') ? 'decimal' : /f/i.test(suffix ?? '') ? 'float' : 'double' } : unknown(node);
        }
        if (node.type === 'string_literal') {
            try {
                return { ...base, kind: 'literal', value: JSON.parse(node.text), type: 'string' };
            }
            catch {
                return unknown(node);
            }
        }
        if (node.type === 'verbatim_string_literal')
            return { ...base, kind: 'literal', value: node.text.slice(2, -1).replaceAll('""', '"'), type: 'string' };
        if (node.type === 'character_literal') {
            try {
                const value = JSON.parse('"' + node.text.slice(1, -1).replaceAll('"', '\\"').replaceAll("\\'", "'") + '"');
                return typeof value === 'string' && value.length === 1 ? { ...base, kind: 'literal', value, type: 'char' } : unknown(node);
            }
            catch {
                return unknown(node);
            }
        }
        if (node.type === 'member_access_expression') {
            const object = node.childForFieldName('expression'), member = node.childForFieldName('name');
            return object && member ? { ...base, kind: 'member', object: expression(object, depth + 1), name: name(member.text) } : unknown(node);
        }
        if (node.type === 'invocation_expression') {
            const callee = node.childForFieldName('function');
            return callee ? { ...base, kind: 'call', callee: expression(callee, depth + 1), args: args(node.childForFieldName('arguments') ?? undefined, depth + 1) } : unknown(node);
        }
        if (node.type === 'object_creation_expression') {
            const type = node.childForFieldName('type');
            return type ? { ...base, kind: 'new', type: name(type.text), args: args(node.childForFieldName('arguments') ?? undefined, depth + 1), ...parts.some(child => child.type === 'initializer_expression') ? { initializer: true } : {} } : unknown(node);
        }
        if (['lambda_expression', 'anonymous_method_expression'].includes(node.type))
            return { ...base, kind: 'lambda', key: lambdaKey(node) };
        if (node.type === 'binary_expression') {
            const left = node.childForFieldName('left'), right = node.childForFieldName('right');
            return left && right ? { ...base, kind: 'binary', operator: node.childForFieldName('operator')?.text ?? '', left: expression(left, depth + 1), right: expression(right, depth + 1) } : unknown(node);
        }
        if (['prefix_unary_expression', 'postfix_unary_expression'].includes(node.type) && parts[0])
            return { ...base, kind: 'unary', operator: node.children.find(child => !child.isNamed)?.text ?? '', value: expression(parts[0], depth + 1) };
        if (node.type === 'cast_expression') {
            const type = node.childForFieldName('type'), value = node.childForFieldName('value');
            return type && value ? { ...base, kind: 'cast', type: name(type.text), value: expression(value, depth + 1) } : unknown(node);
        }
        if (node.type === 'typeof_expression') {
            const type = node.childForFieldName('type') ?? parts[0];
            return type ? { ...base, kind: 'typeof', type: name(type.text) } : unknown(node);
        }
        return unknown(node);
    };
    const attribute = (node: Node, target?: string): CsharpAttribute => ({ ...site(node), type: name(node.childForFieldName('name')?.text ?? ''), args: args(children(node).find(child => child.type === 'attribute_argument_list')), ...target ? { target } : {} });
    const attributes = (node: Node) => children(node).filter(child => child.type === 'attribute_list').flatMap(list => children(list).filter(child => child.type === 'attribute').map(child => attribute(child, children(list).find(child => child.type === 'attribute_target_specifier')?.text)));
    const parameters = (node: Node | undefined): CsharpParameter[] => {
        if (!node)
            return [];
        if (node.type === 'implicit_parameter')
            return [{ name: name(node.text), modifiers: [] }];
        return children(node).filter(child => ['parameter', 'implicit_parameter', 'identifier'].includes(child.type)).map(parameter => { const identifier = parameter.childForFieldName('name') ?? (parameter.type === 'identifier' || parameter.type === 'implicit_parameter' ? parameter : undefined), type = parameter.childForFieldName('type'), value = children(parameter).find(child => child.id !== identifier?.id && child.id !== type?.id && !['modifier', 'attribute_list'].includes(child.type)); return { name: name(identifier?.text ?? ''), ...type ? { type: name(type.text) } : {}, modifiers: parameter.children.filter(child => ['ref', 'out', 'in', 'params', 'this', 'scoped'].includes(child.type) || child.type === 'modifier').map(child => child.text), ...parameter.children.some(child => child.type === '=') && value ? { default: expression(value) } : {} }; });
    };
    const scope = (node: Node, kind: CsharpScope['kind'], parent?: CsharpScope, owner?: string, namespace = parent?.namespace ?? ''): CsharpScope => { const value: CsharpScope = { ...site(node), key: 'csharp-scope:' + scopeOrdinal++, kind, namespace, ...parent ? { parent: parent.key } : {}, ...owner ? { owner } : {}, gaps: [], ...kind === 'lambda' ? { deferred: true } : {} }; facts.scopes.push(value); return value; };
    const fileScope = scope(root, 'file'), fileNamespace = root.namedChildren.find(child => child.type === 'file_scoped_namespace_declaration'), namespaceScope = fileNamespace ? scope(root, 'namespace', fileScope, undefined, name(fileNamespace.childForFieldName('name')?.text ?? '')) : undefined;
    if (namespaceScope)
        namespaceScope.start = fileNamespace!.endIndex;
    const globals = root.namedChildren.filter(child => child.type === 'global_statement');
    let topScope: CsharpScope | undefined;
    if (globals.length) {
        const start = globals[0]!.startIndex, end = globals.at(-1)!.endIndex, base = { start, end: Math.min(end, source.text.length), range: source.range(start, end) }, key = 'csharp-top-level';
        topScope = scope(root, 'function', fileScope, key);
        Object.assign(topScope, base);
        facts.definitions.push({ ...base, key, name: '<top-level>', kind: 'top-level', scope: fileScope.key, bodyScope: topScope.key, parameters: [], modifiers: [], typeParameters: [], attributes: [], gaps: [], hasBody: true });
        if (fileNamespace || globals.some(child => child.startIndex > root.namedChildren.find(child => child.type.endsWith('_declaration') && child.type !== 'file_scoped_namespace_declaration')?.startIndex!))
            topScope.gaps.push('Top-level statements with namespace/preceding type declarations are invalid');
    }
    const refType = (node: Node | undefined, current: CsharpScope, kind: 'type' | 'attribute' = 'type') => {
        if (!node)
            return;
        const type = typeNameNode(node);
        facts.references.push({ ...site(node), scope: current.key, expression: { ...site(node), kind: 'name', name: type }, kind });
    };
    function typeNameNode(node: Node): string { return name(node.text); }
    const definition = (node: Node, current: CsharpScope, fact: DeclarationFact | undefined, kind: string): {
        value: CsharpDefinitionFact;
        body?: CsharpScope;
    } => {
        const key = fact?.key ?? lambdaKey(node), body = node.childForFieldName('body'), params = parameters(node.childForFieldName('parameters') ?? undefined), mods = fact?.modifiers ?? node.children.filter(child => child.type === 'modifier' || ['static', 'async'].includes(child.type)).map(child => child.text), parent = fact?.parent && declarations.find(item => item.key === fact.parent && item.kind !== 'namespace')?.key;
        const value: CsharpDefinitionFact = { ...site(node), key, name: fact?.name ?? '<lambda>', kind, scope: current.key, ...parent ? { parent } : {}, parameters: params, modifiers: mods, typeParameters: children(node).find(child => child.type === 'type_parameter_list')?.namedChildren.map(child => name(child.childForFieldName('name')?.text ?? child.text)) ?? [], attributes: attributes(node), gaps: [], hasBody: !!body };
        const returnNode = node.childForFieldName('returns') ?? (!types.has(kind) && kind !== 'constructor' ? node.childForFieldName('type') : null);
        if (returnNode)
            value.returnType = name(returnNode.text);
        if (mods.some(modifier => ['extern', 'unsafe'].includes(modifier)))
            value.gaps.push('External/unsafe original member requires a reviewed binding profile');
        if (node.type === 'property_declaration')
            value.gaps.push('Property accessor dispatch is not an ordinary direct method');
        if (types.has(kind)) {
            const bodyScope = body ? scope(body, 'type', current, key) : undefined;
            if (bodyScope) {
                value.typeScope = bodyScope.key;
                params.forEach(parameter => facts.bindings.push({ ...site(node.childForFieldName('parameters') ?? node), name: parameter.name, scope: bodyScope.key, kind: 'parameter', type: parameter.type, modifiers: parameter.modifiers }));
            }
            facts.definitions.push(value);
            return { value, body: bodyScope };
        }
        const bodyScope = body ? scope(body, kind === 'lambda' ? 'lambda' : 'function', current, key) : undefined;
        if (bodyScope)
            value.bodyScope = bodyScope.key;
        facts.definitions.push(value);
        if (bodyScope)
            params.forEach(parameter => facts.bindings.push({ ...site(node.childForFieldName('parameters') ?? node), name: parameter.name, scope: bodyScope.key, kind: 'parameter', type: parameter.type, modifiers: parameter.modifiers }));
        refType(returnNode ?? undefined, current);
        const parameterNodes = node.childForFieldName('parameters')?.namedChildren ?? [];
        for (const parameter of parameterNodes)
            refType(parameter.childForFieldName('type') ?? undefined, bodyScope ?? current);
        for (const annotation of value.attributes)
            facts.references.push({ ...annotation, scope: current.key, expression: { ...annotation, kind: 'name', name: annotation.type }, kind: 'attribute' });
        return { value, body: bodyScope };
    };
    const enclosingDeclarationSpace = (current: CsharpScope): CsharpScope => {
        let found = current;
        while (found.kind === 'control' && found.parent)
            found = facts.scopes.find(scope => scope.key === found.parent) ?? found;
        return found;
    };
    const opaqueNames = (node: Node, current: CsharpScope, kind: CsharpBindingFact['kind']) => {
        if (node.type === 'identifier') {
            if (node.text !== '_')
                facts.bindings.push({ ...site(node), name: name(node.text), scope: current.key, kind, modifiers: [] });
            return;
        }
        for (const child of children(node))
            opaqueNames(child, current, kind);
    };
    const walk = (node: Node, current: CsharpScope): void => {
        if (++nodes > 200000 || facts.calls.length + facts.references.length + facts.bindings.length > 50000) {
            facts.complete = false;
            return;
        }
        if (['comment', 'using_directive', 'file_scoped_namespace_declaration', 'attribute_list'].includes(node.type) || node.type.startsWith('preproc_'))
            return;
        if (node.type === 'namespace_declaration') {
            const childScope = scope(node, 'namespace', current, undefined, [current.namespace, name(node.childForFieldName('name')?.text ?? '')].filter(Boolean).join('.'));
            for (const child of node.childForFieldName('body')?.namedChildren ?? [])
                walk(child, childScope);
            return;
        }
        if (node.type === 'global_statement' && topScope) {
            for (const child of children(node))
                walk(child, topScope);
            return;
        }
        const fact = bySite.get(`${node.startIndex}:${Math.min(node.endIndex, source.text.length)}`);
        if (fact?.kind === 'namespace')
            return;
        if (fact && types.has(fact.kind)) {
            const result = definition(node, current, fact, fact.kind);
            for (const base of children(node).find(child => child.type === 'base_list')?.namedChildren ?? [])
                refType(base, current);
            for (const annotation of result.value.attributes)
                facts.references.push({ ...annotation, scope: current.key, expression: { ...annotation, kind: 'name', name: annotation.type }, kind: 'attribute' });
            if (result.body)
                for (const child of node.childForFieldName('body')?.namedChildren ?? [])
                    walk(child, result.body);
            return;
        }
        if (fact && ['method', 'constructor', 'function', 'property'].includes(fact.kind)) {
            const result = definition(node, current, fact, fact.kind);
            if (fact.kind === 'property' && node.type === 'variable_declarator') {
                const typeNode = node.parent?.childForFieldName('type'), value = children(node).find(child => child.id !== node.childForFieldName('name')?.id);
                result.value.returnType = typeNode ? name(typeNode.text) : undefined;
                refType(typeNode ?? undefined, current);
                if (value) {
                    result.value.value = expression(value);
                    const initializer = scope(value, 'initializer', current, fact.key);
                    walk(value, initializer);
                }
                result.value.hasBody = false;
            }
            else if (result.body) {
                const body = node.childForFieldName('body')!;
                if (body.type === 'block')
                    for (const child of children(body))
                        walk(child, result.body);
                else {
                    walk(body, result.body);
                    if (body.type === 'arrow_expression_clause' && children(body)[0])
                        facts.returns.push({ ...site(body), scope: result.body.key, value: expression(children(body)[0]!) });
                }
            }
            const initializer = node.namedChildren.find(child => child.type === 'constructor_initializer');
            if (initializer) {
                result.value.gaps.push('Constructor base/this initializers require a reviewed constructor chain');
                for (const child of initializer.namedChildren)
                    walk(child, current);
            }
            return;
        }
        if (['lambda_expression', 'anonymous_method_expression'].includes(node.type)) {
            const result = definition(node, current, undefined, 'lambda');
            if (result.body) {
                const body = node.childForFieldName('body')!;
                if (body.type === 'block')
                    for (const child of children(body))
                        walk(child, result.body);
                else {
                    walk(body, result.body);
                    facts.returns.push({ ...site(body), scope: result.body.key, value: expression(body) });
                }
            }
            return;
        }
        if (node.type === 'block') {
            const block = scope(node, 'block', current);
            for (const child of children(node))
                walk(child, block);
            return;
        }
        if (['for_statement', 'foreach_statement', 'if_statement', 'while_statement', 'do_statement', 'switch_statement', 'switch_section', 'catch_clause', 'using_statement', 'lock_statement', 'fixed_statement'].includes(node.type)) {
            const control = scope(node, 'control', current);
            if (['fixed_statement', 'using_statement'].includes(node.type))
                control.gaps.push('Using/fixed lifetime or implicit disposal is outside direct call binding');
            if (node.type === 'foreach_statement') {
                const identifier = node.childForFieldName('left'), type = node.childForFieldName('type');
                if (identifier?.type === 'tuple_pattern')
                    opaqueNames(identifier, control, 'loop');
                else if (identifier)
                    facts.bindings.push({ ...site(identifier), name: name(identifier.text), scope: control.key, kind: 'loop', type: type ? name(type.text) : undefined, modifiers: [] });
            }
            for (const child of children(node))
                walk(child, control);
            return;
        }
        if (['declaration_pattern', 'recursive_pattern', 'declaration_expression', 'catch_declaration'].includes(node.type)) {
            const identifier = node.childForFieldName('name'), type = node.childForFieldName('type');
            refType(type ?? undefined, current);
            if (identifier) {
                // Pattern definite assignment and out inference require compiler data;
                // reserve original names throughout the enclosing declaration space.
                const target = node.type === 'catch_declaration' ? current : enclosingDeclarationSpace(current);
                opaqueNames(identifier, target, node.type === 'catch_declaration' ? 'catch' : 'pattern');
            }
            for (const child of children(node))
                if (child.id !== identifier?.id && child.id !== type?.id)
                    walk(child, current);
            return;
        }
        if (node.type === 'variable_declaration' && node.parent?.type !== 'field_declaration') {
            const type = node.childForFieldName('type');
            refType(type ?? undefined, current);
            for (const variable of children(node).filter(child => child.type === 'variable_declarator')) {
                const identifier = variable.childForFieldName('name'), tuple = children(variable).find(child => child.type === 'tuple_pattern'), value = children(variable).find(child => child.id !== identifier?.id && child.id !== tuple?.id);
                if (tuple)
                    opaqueNames(tuple, current, 'local');
                if (identifier)
                    facts.bindings.push({ ...site(variable), name: name(identifier.text), scope: current.key, kind: 'local', ...type && type.type !== 'implicit_type' ? { type: name(type.text) } : {}, ...value ? { value: expression(value) } : {}, modifiers: [] });
                if (value)
                    walk(value, current);
            }
            return;
        }
        if (node.type === 'assignment_expression') {
            const target = node.childForFieldName('left'), value = node.childForFieldName('right');
            if (target?.type === 'tuple_expression') {
                const reserveWrites = (child: Node) => {
                    if (child.type === 'identifier')
                        facts.writes.push({ ...site(child), scope: current.key, target: expression(child), operator: 'deconstruction write' });
                    else
                        for (const part of children(child))
                            reserveWrites(part);
                };
                reserveWrites(target);
            }
            if (target)
                facts.writes.push({ ...site(node), scope: current.key, target: expression(target), operator: node.childForFieldName('operator')?.text ?? '=', ...value ? { value: expression(value) } : {} });
        }
        if (['prefix_unary_expression', 'postfix_unary_expression'].includes(node.type) && /[+][+]|--/.test(node.text) && children(node)[0])
            facts.writes.push({ ...site(node), scope: current.key, target: expression(children(node)[0]!), operator: 'mutation' });
        if (node.type === 'argument' && node.children.some(child => ['ref', 'out'].includes(child.type)) && children(node).at(-1))
            facts.writes.push({ ...site(node), scope: current.key, target: expression(children(node).at(-1)!), operator: 'ref/out' });
        if (['invocation_expression', 'object_creation_expression', 'implicit_object_creation_expression'].includes(node.type))
            facts.calls.push({ ...site(node), scope: current.key, expression: expression(node) });
        if (node.type === 'object_creation_expression')
            refType(node.childForFieldName('type') ?? undefined, current);
        if (node.type === 'return_statement' && children(node)[0])
            facts.returns.push({ ...site(node), scope: current.key, value: expression(children(node)[0]!) });
        const parent = node.parent, memberChild = parent?.type === 'member_access_expression', declarationName = parent?.childForFieldName('name')?.id === node.id;
        if (node.type === 'member_access_expression' && !memberChild || node.type === 'identifier' && !memberChild && !declarationName && !['qualified_name', 'alias_qualified_name', 'generic_name', 'parameter', 'type_parameter', 'variable_declarator', 'object_creation_expression'].includes(parent?.type ?? ''))
            facts.references.push({ ...site(node), scope: current.key, expression: expression(node), kind: 'value' });
        for (const child of children(node))
            walk(child, current);
    };
    for (const node of root.namedChildren)
        walk(node, namespaceScope && node.startIndex >= namespaceScope.start ? namespaceScope : fileScope);
    facts.gaps = [...new Set(facts.gaps)].sort();
    return facts;
}
