import type { Node } from 'web-tree-sitter';
import type { DeclarationFact, GoBindingFact, GoDefinitionFact, GoExpression, GoParameterFact, GoSemanticFacts } from '../facts.js';
import type { SourceText } from '../source-map.js';
import { goString } from './go-imports.js';

/** Bounded, serializable original-source facts. No compiler or target code. */
export function extractGoSemantic(root: Node, declarations: DeclarationFact[], source: SourceText): { facts: GoSemanticFacts; truncated: boolean } {
  const facts: GoSemanticFacts = { scopes: [], definitions: [], bindings: [], writes: [], references: [], calls: [], gaps: [] };
  const byStart = new Map(declarations.map(item => [item.start, item])), seenClosures = new Set<number>();
  let visited = 0, truncated = false;
  const site = (node: Node) => ({ start: node.startIndex, range: source.range(node.startIndex, node.endIndex) });
  const field = (node: Node, name: string) => node.childForFieldName(name) ?? undefined;
  const items = (node: Node | undefined) => node?.namedChildren ?? [];
  const limit = () => { if (++visited > 200_000) truncated = true; return !truncated; };
  const unknown = (node: Node): GoExpression => ({ ...site(node), kind: 'unknown', text: node.text.slice(0, 200) });
  function expression(node: Node | undefined, depth = 0): GoExpression {
    if (!node) return { kind: 'unknown', text: '', start: 0, range: source.range(0, 0) };
    if (depth > 64 || !limit()) return unknown(node);
    const recurse = (child: Node | undefined) => expression(child, depth + 1), s = site(node);
    switch (node.type) {
      case 'identifier': case 'type_identifier': case 'package_identifier': case 'field_identifier': return { ...s, kind: 'name', name: node.text };
      case 'interpreted_string_literal': case 'raw_string_literal': { const value = goString(node.text); return value === undefined ? unknown(node) : { ...s, kind: 'literal', value }; }
      case 'true': case 'false': return { ...s, kind: 'literal', value: node.text === 'true' };
      case 'nil': return { ...s, kind: 'literal', value: null };
      case 'int_literal': return { ...s, kind: 'literal', value: Number(node.text.replace(/_/g, '')) };
      case 'parenthesized_expression': case 'parenthesized_type': case 'type_elem': return recurse(node.namedChildren[0]);
      case 'selector_expression': return { ...s, kind: 'member', object: recurse(field(node, 'operand')), name: field(node, 'field')?.text ?? '' };
      case 'qualified_type': return { ...s, kind: 'member', object: recurse(field(node, 'package')), name: field(node, 'name')?.text ?? '' };
      case 'call_expression': return { ...s, kind: 'call', callee: recurse(field(node, 'function')), args: items(field(node, 'arguments')).map(recurse) };
      // Go's grammar cannot disambiguate F[T](x) from a generic conversion.
      // The symbol binder makes that decision using the actual declaration.
      case 'type_conversion_expression': return { ...s, kind: 'call', callee: recurse(field(node, 'type')), args: field(node, 'operand') ? [recurse(field(node, 'operand'))] : [] };
      case 'pointer_type': return { ...s, kind: 'unary', operator: '*', object: recurse(node.namedChildren[0]) };
      case 'unary_expression': return { ...s, kind: 'unary', operator: node.children.find(child => !child.isNamed)?.text ?? '', object: recurse(field(node, 'operand')) };
      case 'index_expression': return { ...s, kind: 'index', object: recurse(field(node, 'operand')), index: recurse(field(node, 'index')) };
      case 'generic_type': return { ...s, kind: 'index', object: recurse(field(node, 'type')) };
      case 'composite_literal': return { ...s, kind: 'composite', type: recurse(field(node, 'type')) };
      case 'func_literal': return { ...s, kind: 'function', key: `closure:${node.startIndex}:${Math.min(node.endIndex, source.text.length)}` };
      default: return unknown(node);
    }
  }
  function scope(node: Node, parent: string | undefined, kind: GoSemanticFacts['scopes'][number]['kind'], owner?: string): string {
    const key = `${kind}:${node.startIndex}:${node.endIndex}`;
    facts.scopes.push({ key, parent, kind, owner, start: node.startIndex, end: Math.min(node.endIndex, source.text.length) }); return key;
  }
  function parameters(node: Node | undefined): GoParameterFact[] {
    if (!node) return [];
    if (node.type !== 'parameter_list') return [{ type: expression(node) }];
    return node.namedChildren.flatMap(parameter => {
      const names = parameter.childrenForFieldName('name'), type = expression(field(parameter, 'type')), variadic = parameter.type === 'variadic_parameter_declaration';
      return names.length ? names.map(name => ({ name: name.text, type, ...(variadic ? { variadic } : {}) })) : [{ type, ...(variadic ? { variadic } : {}) }];
    });
  }
  function typeParameters(node: Node, target: string): void {
    for (const parameter of items(field(node, 'type_parameters'))) for (const name of parameter.childrenForFieldName('name')) facts.bindings.push({ ...site(name), end: name.endIndex, scope: target, name: name.text, kind: 'type-parameter' });
  }
  function definition(node: Node, current: string): void {
    const declaration = byStart.get(node.startIndex), closure = node.type === 'func_literal', body = field(node, 'body');
    const key = closure ? `closure:${node.startIndex}:${Math.min(node.endIndex, source.text.length)}` : declaration?.key;
    if (!key) { facts.gaps.push('Declaration missing from structural facts'); return; }
    if (closure) { if (seenClosures.has(node.id)) return; seenClosures.add(node.id); }
    const kind = closure ? 'closure' : node.type === 'method_declaration' ? 'method' : node.type === 'function_declaration' ? 'function' : 'type';
    const name = field(node, 'name')?.text ?? '<closure>', params = parameters(field(node, 'parameters')), results = parameters(field(node, 'result')), receiver = parameters(field(node, 'receiver'))[0];
    const def: GoDefinitionFact = { ...site(node), key, name, kind, scope: current, end: Math.min(node.endIndex, source.text.length), signature: declaration?.signature ?? node.text.slice(0, (body?.startIndex ?? node.endIndex) - node.startIndex).replace(/\s+/g, ' '), parameters: params, results, ...(receiver ? { receiver } : {}), ...(field(node, 'type_parameters') ? { generic: true } : {}) };
    if (kind === 'type') {
      def.typeScope = scope(node, current, 'type', key); typeParameters(node, def.typeScope);
      const type = field(node, 'type'); def.alias = node.type === 'type_alias'; def.underlying = expression(type); def.interface = type?.type === 'interface_type';
      if (type?.type === 'struct_type') def.fields = (type.namedChildren.find(child => child.type === 'field_declaration_list')?.namedChildren ?? []).flatMap<NonNullable<GoDefinitionFact['fields']>[number]>(item => {
        const names = item.childrenForFieldName('name'), value = expression(field(item, 'type'));
        if (names.length) return names.map(name => ({ name: name.text, type: value, embedded: false }));
        const pointer = item.children.some(child => child.type === '*'); return [{ type: pointer ? { ...site(item), kind: 'unary' as const, operator: '*', object: value } : value, embedded: true }];
      });
      facts.definitions.push(def); if (type) read(type, def.typeScope, true); return;
    }
    facts.definitions.push(def);
    for (const part of [...params, ...results, ...(receiver ? [receiver] : [])]) facts.references.push({ ...part.type, expression: part.type, scope: current });
    if (!body) { facts.gaps.push('Bodyless function needs external implementation'); return; }
    const inner = def.bodyScope = scope(body, current, 'function', key); typeParameters(node, inner);
    for (const part of [...params, ...results, ...(receiver ? [receiver] : [])]) if (part.name && part.name !== '_') facts.bindings.push({ ...site(body), start: body.startIndex, end: body.startIndex, name: part.name, kind: 'parameter', scope: inner, type: part.type });
    // Generic receiver identifiers shadow package names in the method body.
    if (receiver) for (const identifier of field(node, 'receiver')?.descendantsOfType('type_arguments').flatMap(item => item.descendantsOfType('type_identifier')) ?? []) facts.bindings.push({ ...site(identifier), end: identifier.endIndex, scope: inner, name: identifier.text, kind: 'type-parameter' });
    items(body).forEach(child => walk(child, inner));
  }
  function read(node: Node, current: string, typeOnly = false, parentReference = false): void {
    if (!limit()) return;
    if (node.type === 'func_literal') { definition(node, current); return; }
    if (['call_expression', 'type_conversion_expression'].includes(node.type) && !typeOnly) {
      const value = expression(node); if (value.kind === 'call') facts.calls.push({ ...site(node), expression: value, scope: current, timing: node.parent?.type === 'defer_statement' ? 'deferred' : node.parent?.type === 'go_statement' ? 'goroutine' : 'immediate' });
    }
    if (node.type === 'unary_expression' && node.children.some(child => child.type === '&')) { const target = field(node, 'operand'); if (target) facts.writes.push({ ...site(node), target: expression(target), scope: current, kind: 'address' }); }
    const reference = ['identifier', 'type_identifier', 'selector_expression', 'qualified_type'].includes(node.type);
    if (reference && !parentReference) facts.references.push({ ...site(node), scope: current, expression: expression(node) });
    if (['interpreted_string_literal', 'raw_string_literal', 'comment'].includes(node.type)) return;
    if (node.type === 'keyed_element') { if (node.namedChildren[0]?.type !== 'literal_element' || node.namedChildren[0]?.namedChildren[0]?.type !== 'identifier') { const key = node.namedChildren[0]; if (key) read(key, current, typeOnly); } const value = node.namedChildren.at(-1); if (value) read(value, current, typeOnly); return; }
    if (['field_declaration', 'parameter_declaration', 'variadic_parameter_declaration', 'type_parameter_declaration'].includes(node.type)) { const type = field(node, 'type'); if (type) read(type, current, true); return; }
    if (node.type === 'method_elem') { for (const child of node.namedChildren) if (child !== field(node, 'name')) read(child, current, true); return; }
    for (const child of node.namedChildren) {
      if (reference && (child === field(node, 'field') || child === field(node, 'name'))) continue;
      read(child, current, typeOnly, reference && child === (field(node, 'operand') ?? field(node, 'package')));
    }
  }
  function bind(node: Node, current: string, kind: GoBindingFact['kind'], left?: Node, right?: Node): void {
    const names = left?.namedChildren ?? node.childrenForFieldName('name'), values = items(right ?? field(node, 'value')), type = field(node, 'type');
    for (const [index, name] of names.entries()) {
      if (name.type !== 'identifier' || name.text === '_') { if (name.text !== '_') read(name, current); continue; }
      facts.bindings.push({ ...site(name), scope: current, name: name.text, end: node.endIndex, kind, ...(type ? { type: expression(type) } : {}), ...(values.length === names.length ? { value: expression(values[index]) } : values.length === 1 ? { value: expression(values[0]), tuple: names.length !== 1 } : {}) });
    }
    if (type) read(type, current, true); for (const value of values) read(value, current);
  }
  function walk(node: Node, current: string): void {
    if (!limit()) return;
    switch (node.type) {
      case 'package_clause': case 'import_declaration': case 'comment': return;
      case 'function_declaration': case 'method_declaration': case 'type_spec': case 'type_alias': case 'func_literal': definition(node, current); return;
      case 'block': { const inner = scope(node, current, 'block'); items(node).forEach(child => walk(child, inner)); return; }
      case 'if_statement': case 'for_statement': case 'expression_switch_statement': case 'type_switch_statement': case 'select_statement': {
        const inner = scope(node, current, 'control');
        if (node.type === 'type_switch_statement') {
          const value = field(node, 'value'); if (value) read(value, inner);
          for (const child of node.namedChildren) {
            if (['type_case', 'default_case'].includes(child.type)) {
              const branch = scope(child, inner, 'case'), names = items(field(node, 'alias')), types = child.childrenForFieldName('type');
              for (const name of names) if (name.text !== '_') facts.bindings.push({ ...site(name), end: child.startIndex, name: name.text, scope: branch, kind: 'parameter', ...(types.length === 1 ? { type: expression(types[0]) } : {}) });
              for (const part of child.namedChildren) { if (part.type === 'statement_list') walk(part, branch); else read(part, branch, true); }
            } else if (child !== value && child !== field(node, 'alias')) walk(child, inner);
          }
        } else items(node).forEach(child => walk(child, inner)); return;
      }
      case 'expression_case': case 'communication_case': case 'default_case': case 'type_case': { const inner = scope(node, current, 'case'); items(node).forEach(child => walk(child, inner)); return; }
      case 'var_spec': bind(node, current, 'var'); return;
      case 'const_spec': bind(node, current, 'const'); return;
      case 'short_var_declaration': bind(node, current, 'short', field(node, 'left'), field(node, 'right')); return;
      case 'range_clause': case 'receive_statement': {
        const left = field(node, 'left'), right = field(node, 'right');
        if (node.children.some(child => child.type === ':=')) bind(node, current, 'range', left, undefined);
        else for (const target of items(left)) { facts.writes.push({ ...site(target), target: expression(target), scope: current, kind: 'assignment' }); read(target, current); }
        if (right) read(right, current); return;
      }
      case 'assignment_statement': case 'inc_statement': case 'dec_statement': {
        const targets = field(node, 'left')?.namedChildren ?? node.namedChildren.slice(0, 1), assignment = node.type === 'assignment_statement' && node.children.some(child => child.type === '=');
        for (const target of targets) { facts.writes.push({ ...site(target), target: expression(target), scope: current, kind: assignment ? 'assignment' : 'augmentation' }); read(target, current); }
        const right = field(node, 'right'); if (right) read(right, current); return;
      }
      case 'labeled_statement': { const statement = node.namedChildren.at(-1); if (statement) walk(statement, current); return; }
      case 'break_statement': case 'continue_statement': case 'goto_statement': return;
      default:
        if (node.type.endsWith('_declaration') || ['statement_list', 'for_clause', 'var_spec_list', 'const_spec_list'].includes(node.type)) items(node).forEach(child => walk(child, current));
        else read(node, current);
    }
  }
  const file = scope(root, undefined, 'file'); root.namedChildren.forEach(node => walk(node, file));
  facts.gaps = [...new Set(facts.gaps)]; return { facts, truncated };
}
