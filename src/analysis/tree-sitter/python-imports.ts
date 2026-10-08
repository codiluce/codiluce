import type { Node } from 'web-tree-sitter';
import type { DeclarationFact, PythonExpression, PythonGuardFact, PythonSyntaxFacts } from '../facts.js';
import { SourceText } from '../source-map.js';

const MAX_NODES = 200_000, MAX_FACTS = 20_000;
const compact = (value: string) => value.replace(/\s+/g, ' ').trim().slice(0, 500);
const dotted = (node: Node) => node.text.replace(/\s/g, '');
/** A deliberately small expression language; no literal_eval or target runtime.
 * Escaped/bytes/formatted strings remain opaque rather than being misdecoded. */
function expression(node: Node | null, depth = 0): PythonExpression {
  const unknown: PythonExpression = { kind: 'unknown', text: compact(node?.text ?? '') };
  if (!node || node.hasError || depth > 16 || node.namedChildCount > 64) return unknown;
  const next = (child: Node | null) => expression(child, depth + 1);
  if (node.type === 'identifier') return { kind: 'name', name: node.text };
  if (node.type === 'attribute') return { kind: 'member', object: next(node.childForFieldName('object')), name: node.childForFieldName('attribute')?.text ?? '' };
  if (['true', 'false', 'none'].includes(node.type)) return { kind: 'literal', value: node.type === 'none' ? null : node.type === 'true' };
  if (node.type === 'integer' && /^\d+$/.test(node.text) && Number.isSafeInteger(Number(node.text))) return { kind: 'literal', value: Number(node.text) };
  if (node.type === 'string') {
    const match = /^([rRuU]?)("""|'''|"|')([\s\S]*)\2$/.exec(node.text);
    if (match && (!match[3]!.includes('\\') || match[1]!.toLowerCase() === 'r')) return { kind: 'literal', value: match[3]! };
  }
  if (node.type === 'parenthesized_expression') return next(node.namedChildren[0] ?? null);
  if (node.type === 'type') return next(node.namedChildren[0] ?? null);
  if (['list', 'tuple', 'set', 'type_parameter'].includes(node.type)) return { kind: 'sequence', items: node.namedChildren.map(next) };
  if (node.type === 'subscript' || node.type === 'generic_type') {
    const items = node.type === 'generic_type' ? node.namedChildren[1]?.namedChildren ?? [] : node.childrenForFieldName('subscript');
    return { kind: 'subscript', object: next(node.childForFieldName('value') ?? node.namedChildren[0] ?? null), items: items.flatMap(item => item.type === 'tuple' ? item.namedChildren : [item]).map(next) };
  }
  if (node.type === 'call') return { kind: 'call', callee: next(node.childForFieldName('function')), args: (node.childForFieldName('arguments')?.namedChildren ?? []).map(arg => arg.type === 'keyword_argument' ? { name: arg.childForFieldName('name')?.text, value: next(arg.childForFieldName('value')) } : { value: next(arg), ...(/splat/.test(arg.type) ? { spread: true } : {}) }) };
  return unknown;
}
/** Extract imports from grammar nodes, retaining lexical owners and branch
 * context. No module, decorator, config or user code is executed here. */
export function extractPythonImports(root: Node, declarations: DeclarationFact[], source: SourceText): { facts: PythonSyntaxFacts; truncated: boolean } {
  const facts: PythonSyntaxFacts = { imports: [], writes: [], calls: [], assignments: [], returns: [], definitions: [], references: [], scopes: [], opaqueScopes: [], opaqueModule: false };
  const scopes = new Map(declarations.map(item => [item.start, item]));
  const scopesByKey = new Map(declarations.map(item => [item.key, item]));
  const lexical = new Map<string, { parent?: string; kind: string }>(declarations.map(item => [item.key, item]));
  const comprehensions = new Set(['list_comprehension', 'set_comprehension', 'dictionary_comprehension', 'generator_expression']);
  type Frame = { node: Node; scope?: string; conditions: string[]; guards: PythonGuardFact[] };
  const pending: Frame[] = [{ node: root, conditions: [], guards: [] }];
  let visited = 0, truncated = false;
  const write = (node: Node | null, scope: string | undefined, kind: 'assignment' | 'augmentation' | 'mutation' | 'parameter' | 'declaration'): void => {
    if (!node || node.hasError || facts.writes.length >= MAX_FACTS) return;
    if (node.type === 'identifier') facts.writes.push({ name: node.text, start: node.startIndex, line: source.range(node.startIndex, node.endIndex).startLine, kind, ...(scope ? { scope } : {}) });
    else if (['pattern_list', 'tuple_pattern', 'list_pattern', 'tuple', 'list', 'list_splat_pattern', 'dictionary_splat_pattern'].includes(node.type)) node.namedChildren.forEach(child => write(child, scope, kind));
    else if (node.type === 'attribute') facts.writes.push({ name: dotted(node), start: node.startIndex, line: source.range(node.startIndex, node.endIndex).startLine, kind, ...(scope ? { scope } : {}) });
    else if (node.type === 'subscript') write(node.childForFieldName('value'), scope, 'mutation');
  };
  while (pending.length) {
    const frame = pending.pop()!, { node } = frame;
    if (++visited > MAX_NODES || [facts.imports, facts.writes, facts.calls, facts.scopes, facts.assignments, facts.returns, facts.definitions, facts.references].some(items => items.length >= MAX_FACTS)) { truncated = true; break; }
    let scope = frame.scope;
    const declaration = scopes.get(node.startIndex);
    if (declaration && (node.type === 'decorated_definition' || ['function_definition', 'class_definition'].includes(node.type))) {
      if (scope !== declaration.key) {
        facts.writes.push({ name: declaration.name, start: node.startIndex, line: declaration.range.startLine, kind: 'declaration', ...(scope ? { scope } : {}) });
        scope = declaration.key;
        const definition = node.type === 'decorated_definition' ? node.childForFieldName('definition') ?? node.namedChildren.at(-1) : node;
        const parameters = definition?.childForFieldName('parameters');
        facts.definitions.push({ key: declaration.key, conditions: frame.conditions, decorators: node.type === 'decorated_definition' ? node.namedChildren.filter(child => child.type === 'decorator').map(child => expression(child.namedChildren[0] ?? null)) : [], bases: (definition?.childForFieldName('superclasses')?.namedChildren ?? []).map(child => expression(child)), parameters: (parameters?.namedChildren ?? []).filter(child => !['positional_separator', 'keyword_separator'].includes(child.type)).map(parameter => {
          const name = parameter.type === 'identifier' ? parameter : parameter.childForFieldName('name') ?? parameter.namedChildren.find(child => child.type === 'identifier' || /splat_pattern$/.test(child.type));
          const actualName = name && /splat_pattern$/.test(name.type) ? name.namedChildren[0] : name;
          const value = parameter.childForFieldName('value'), annotation = parameter.childForFieldName('type');
          return { name: actualName?.text ?? '', ...(value ? { default: expression(value) } : {}), ...(annotation ? { annotation: expression(annotation) } : {}), ...(/splat/.test(parameter.type) || !!name && /splat/.test(name.type) ? { variadic: true } : {}) };
        }) });
        for (const parameter of parameters?.namedChildren ?? []) {
          const name = parameter.type === 'identifier' ? parameter : parameter.childForFieldName('name') ?? parameter.namedChildren.find(child => child.type === 'identifier' || /splat_pattern$/.test(child.type)) ?? null;
          write(name, scope, 'parameter');
        }
      }
    }
    if (comprehensions.has(node.type) || node.type === 'lambda') {
      const key = `${node.startIndex}:${node.endIndex}:${node.type}`, kind = node.type === 'lambda' ? 'lambda' : 'comprehension';
      const record = { key, kind, start: node.startIndex, end: node.endIndex, ...(scope ? { parent: scope } : {}) } as const;
      facts.scopes.push(record); lexical.set(key, record); scope = key;
      if (kind === 'lambda') for (const parameter of node.childForFieldName('parameters')?.namedChildren ?? []) write(parameter.type === 'identifier' ? parameter : parameter.childForFieldName('name') ?? parameter.namedChildren.find(child => child.type === 'identifier' || /splat_pattern$/.test(child.type)) ?? null, scope, 'parameter');
    }
    if ((node.type === 'import_statement' || node.type === 'import_from_statement') && !node.hasError) {
      const from = node.type === 'import_from_statement', moduleNode = node.childForFieldName('module_name');
      const names = node.childrenForFieldName('name');
      const binding = (item: Node, moduleImport: boolean) => {
        const name = item.type === 'aliased_import' ? item.childForFieldName('name')! : item;
        return { imported: dotted(name), local: item.childForFieldName('alias')?.text ?? (moduleImport ? dotted(name).split('.')[0]! : dotted(name)) };
      };
      const common = { ...(scope ? { scope } : {}), range: source.range(node.startIndex, node.endIndex), start: node.startIndex, end: node.endIndex, conditions: frame.conditions, guards: frame.guards };
      if (from && moduleNode) facts.imports.push({ ...common, kind: 'from', specifier: dotted(moduleNode), bindings: node.namedChildren.some(child => child.type === 'wildcard_import') ? [{ imported: '*', local: '*' }] : names.map(item => binding(item, false)) });
      else if (!from) for (const item of names) facts.imports.push({ ...common, kind: 'import', specifier: binding(item, true).imported, bindings: [binding(item, true)], moduleBinding: item.type === 'aliased_import' ? 'exact' : 'head' });
      continue;
    }
    if (['assignment', 'augmented_assignment', 'named_expression', 'for_statement', 'for_in_clause'].includes(node.type)) {
      let bindingScope = scope;
      if (node.type === 'named_expression') while (bindingScope && lexical.get(bindingScope)?.kind === 'comprehension') bindingScope = lexical.get(bindingScope)?.parent;
      write(node.childForFieldName('left') ?? node.childForFieldName('name'), bindingScope, node.type === 'augmented_assignment' ? 'augmentation' : 'assignment');
      const left = node.childForFieldName('left'), right = node.childForFieldName('right');
      if (node.type === 'assignment' && left?.type === 'identifier' && right) facts.assignments.push({ name: left.text, value: expression(right), start: left.startIndex, range: source.range(node.startIndex, node.endIndex), conditions: frame.conditions, ...(bindingScope ? { scope: bindingScope } : {}) });
    }
    if (node.type === 'as_pattern') {
      const alias = node.childForFieldName('alias');
      write(alias?.type === 'as_pattern_target' ? alias.namedChildren[0] ?? null : alias, scope, 'assignment');
    }
    if (node.type === 'delete_statement') node.namedChildren.forEach(child => write(child, scope, 'assignment'));
    if (['global_statement', 'nonlocal_statement'].includes(node.type) && !facts.opaqueScopes.includes(scope ?? '')) facts.opaqueScopes.push(scope ?? '');
    if (node.type === 'return_statement') facts.returns.push({ value: expression(node.namedChildren[0] ?? null), start: node.startIndex, conditions: frame.conditions, ...(scope ? { scope } : {}) });
    if ((node.type === 'identifier' || node.type === 'attribute') && node.parent?.type !== 'attribute') {
      const parent = node.parent, excluded = !parent || ['parameters', 'lambda_parameters', 'typed_parameter', 'typed_default_parameter', 'default_parameter', 'global_statement', 'nonlocal_statement', 'keyword_argument', 'as_pattern_target'].includes(parent.type) && node.id !== parent.childForFieldName('value')?.id && node.id !== parent.childForFieldName('type')?.id || ['function_definition', 'class_definition'].includes(parent.type) && node.id === parent.childForFieldName('name')?.id || ['assignment', 'augmented_assignment', 'named_expression', 'for_statement', 'for_in_clause'].includes(parent.type) && node.id === parent.childForFieldName('left')?.id;
      if (!excluded && /^[\p{ID_Start}_][\p{ID_Continue}]*(?:\.[\p{ID_Start}_][\p{ID_Continue}]*)*$/u.test(dotted(node))) facts.references.push({ name: dotted(node), start: node.startIndex, range: source.range(node.startIndex, node.endIndex), ...(scope ? { scope } : {}) });
    }
    if (node.type === 'call') {
      const callee = node.childForFieldName('function');
      if (callee && !callee.hasError) facts.calls.push({ callee: ['identifier', 'attribute'].includes(callee.type) ? dotted(callee) : compact(callee.text), expression: expression(node), standalone: node.parent?.type === 'expression_statement', conditions: frame.conditions, start: node.startIndex, range: source.range(node.startIndex, node.endIndex), ...(scope ? { scope } : {}) });
      let current = scope, deferred = false;
      while (current) { const declaration = lexical.get(current); if (!declaration) break; if (['function', 'method', 'lambda'].includes(declaration.kind)) { deferred = true; break; } current = declaration.parent; }
      if (!deferred) facts.opaqueModule = true;
    }
    if (node.type === 'if_statement' || node.type === 'elif_clause') {
      const test = node.childForFieldName('condition'), consequence = node.childForFieldName('consequence');
      for (const child of [...node.namedChildren].reverse()) {
        if (child.id === test?.id || child.type === 'comment') continue;
        const branch = child.id === consequence?.id;
        const condition = `${branch ? 'if' : 'else'} ${compact(test?.text ?? '<unknown>')}`;
        pending.push({ node: child, ...(scope ? { scope } : {}), conditions: [...frame.conditions, condition], guards: [...frame.guards, { expression: compact(test?.text ?? ''), branch, ...(scope ? { scope } : {}) }] });
      }
      if (test) pending.push({ node: test, ...(scope ? { scope } : {}), conditions: frame.conditions, guards: frame.guards });
      continue;
    }
    const condition = ['for_statement', 'while_statement', 'try_statement', 'except_clause', 'with_statement', 'match_statement', 'case_clause'].includes(node.type) ? `${node.type}: ${compact(node.text.split(/\r?\n/)[0] ?? '')}` : undefined;
    for (const child of [...node.namedChildren].reverse()) {
      let childScope = scope;
      if (node.type === 'decorated_definition' && child.type === 'decorator') childScope = frame.scope;
      if (['function_definition', 'class_definition'].includes(node.type) && child.id !== node.childForFieldName('body')?.id) childScope = scope ? scopesByKey.get(scope)?.parent : undefined;
      if (node.type === 'for_in_clause' && comprehensions.has(node.parent?.type ?? '') && node.parent?.namedChildren.find(item => item.type === 'for_in_clause')?.id === node.id && child.id === node.childForFieldName('right')?.id) childScope = scope ? lexical.get(scope)?.parent : undefined;
      if (node.type === 'lambda' && child.id === node.childForFieldName('parameters')?.id) childScope = frame.scope;
      pending.push({ node: child, ...(childScope ? { scope: childScope } : {}), conditions: condition ? [...frame.conditions, condition] : frame.conditions, guards: frame.guards });
    }
  }
  facts.imports.sort((a, b) => a.start - b.start || a.specifier.localeCompare(b.specifier, 'en'));
  facts.writes.sort((a, b) => a.start - b.start || a.name.localeCompare(b.name, 'en'));
  facts.calls.sort((a, b) => a.start - b.start || a.callee.localeCompare(b.callee, 'en'));
  facts.opaqueScopes.sort();
  return { facts, truncated };
}
