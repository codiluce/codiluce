import type { Node, Query } from 'web-tree-sitter';
import type { DeclarationFact, ParseIssue, StructureFacts } from '../facts.js';
import { SourceText } from '../source-map.js';
import { extractPythonImports } from './python-imports.js';

const MAX_DECLARATIONS = 20_000, MAX_ISSUES = 100, MAX_NODES = 200_000;
const compact = (text: string) => text.replace(/\s+/g, ' ').trim();
const FIELD_BODIES = new Set(['block', 'body_statement', 'class_body', 'declaration_list', 'field_declaration_list', 'enum_body', 'function_body', 'arrow_expression_clause', 'constructor_body', 'accessor_list']);
const CALLABLES = new Set(['function', 'method', 'constructor']);
const METHOD_OWNERS = new Set(['class', 'struct', 'interface', 'trait', 'record', 'object', 'enum']);
function child(node: Node, ...types: string[]): Node | undefined { return node.namedChildren.find(item => types.includes(item.type)); }
function body(node: Node): Node | undefined { return node.childForFieldName('body') ?? node.namedChildren.find(item => FIELD_BODIES.has(item.type)); }
function prefix(root: Node, language: string): string {
  const node = root.namedChildren.find(item => ['package_declaration', 'package_header', 'package_clause', 'file_scoped_namespace_declaration'].includes(item.type));
  if (!node) return '';
  const name = node.childForFieldName('name') ?? node.namedChildren.find(item => !['annotation', 'modifiers'].includes(item.type));
  return name?.text ?? '';
}
function declarationKind(language: string, node: Node, kind: string): string {
  if (language === 'go' && kind === 'type') {
    const type = node.childForFieldName('type');
    return type?.type === 'struct_type' ? 'struct' : type?.type === 'interface_type' ? 'interface' : 'type';
  }
  if (language === 'kotlin' && kind === 'class') {
    const header = node.text.slice(0, (body(node)?.startIndex ?? node.endIndex) - node.startIndex);
    if (/\binterface\b/.test(header)) return 'interface';
    if (/\benum\s+class\b/.test(header)) return 'enum';
  }
  return kind;
}
function parameters(node: Node): Node | undefined { return node.childForFieldName('parameters') ?? child(node, 'function_value_parameters', 'formal_parameters', 'parameter_list', 'method_parameters'); }
function signature(node: Node, name: Node, kind: string): string {
  if (node.type === 'type_spec' && ['struct', 'interface'].includes(kind)) return kind;
  if (kind === 'property') return compact(node.childForFieldName('type')?.text ?? '');
  if (CALLABLES.has(kind)) {
    const params = parameters(node)?.text ?? '()';
    const parameterNode = parameters(node);
    const result = node.childForFieldName('return_type') ?? node.childForFieldName('result') ?? node.childForFieldName('returns') ?? node.childForFieldName('type')
      ?? (node.type === 'function_declaration' && parameterNode ? node.namedChildren.find(item => item.startIndex > parameterNode.endIndex && ['user_type', 'nullable_type', 'function_type'].includes(item.type)) : undefined);
    return compact(params + (result ? ` → ${result.text}` : '')).slice(0, 1200);
  }
  // Type headers carry inheritance/generics but not methods, attributes or docs.
  const end = body(node)?.startIndex ?? node.endIndex;
  return compact(node.text.slice(name.endIndex - node.startIndex, end - node.startIndex)).slice(0, 1200);
}
function modifiers(node: Node): string[] {
  const values = node.namedChildren.filter(item => ['modifiers', 'modifier', 'visibility_modifier'].includes(item.type));
  return [...values.flatMap(item => (item.type === 'modifiers' ? item.namedChildren : [item])).filter(item => !/annotation|attribute/.test(item.type)).map(item => compact(item.text)),
    ...(node.type === 'singleton_method' ? ['static'] : []),
    ...(node.children.some(item => item.type === 'async') ? ['async'] : [])];
}
function annotations(node: Node): string[] {
  const result: string[] = [];
  const owner = node.parent?.type === 'decorated_definition' ? node.parent : node;
  const inspect = (item: Node): void => {
    if (/^(decorator|annotation|marker_annotation|attribute_list)$/.test(item.type)) result.push(item.text.trim());
    else if (['modifiers', 'modifier'].includes(item.type)) item.namedChildren.forEach(inspect);
  };
  owner.namedChildren.forEach(inspect);
  // Rust attributes are siblings immediately before the declaration.
  for (let sibling = node.previousNamedSibling; sibling?.type === 'attribute_item'; sibling = sibling.previousNamedSibling) result.unshift(sibling.text.trim());
  return result;
}
interface Captured { node: Node; name: Node; kind: string }

export function extractStructure(root: Node, query: Query, language: string, content: string): StructureFacts {
  const source = new SourceText(content), issues: ParseIssue[] = [];
  const damaged: { start: number; end: number }[] = [];
  let truncated = false, visited = 0;
  const queue = [root];
  while (queue.length) {
    const node = queue.pop()!;
    if (++visited > MAX_NODES) { truncated = true; break; }
    if (node.isError || node.isMissing) {
      damaged.push({ start: node.startIndex, end: node.endIndex });
      if (issues.length < MAX_ISSUES) issues.push({ code: 'syntax-parse-error', reason: node.isMissing ? `Missing ${node.type}` : 'Parser recovered from invalid syntax', range: source.range(node.startIndex, node.endIndex) });
      else truncated = true;
    }
    if (node.hasError) for (const item of node.children) if (item.hasError || item.isError || item.isMissing) queue.push(item);
  }
  const captured: Captured[] = [];
  for (const match of query.matches(root, { matchLimit: 4096 })) {
    const definition = match.captures.find(item => item.name.startsWith('declaration.'));
    const name = match.captures.find(item => item.name === 'name')?.node;
    if (!definition || !name || name.isMissing || name.hasError) continue;
    const node = definition.node;
    const headerEnd = body(node)?.startIndex ?? node.endIndex;
    if (damaged.some(item => item.start < headerEnd && item.end >= node.startIndex)) continue;
    captured.push({ node, name, kind: declarationKind(language, node, definition.name.slice('declaration.'.length)) });
    if (captured.length >= MAX_DECLARATIONS) { truncated = true; break; }
  }
  if (query.didExceedMatchLimit()) truncated = true;
  captured.sort((a, b) => a.node.startIndex - b.node.startIndex || b.node.endIndex - a.node.endIndex || a.kind.localeCompare(b.kind));
  const declarations: DeclarationFact[] = [], byNode = new Map<number, DeclarationFact>();
  const separator = language === 'rust' || language === 'ruby' ? '::' : '.';
  const top = prefix(root, language);
  const owners = new Map<string, DeclarationFact[]>();
  const receiverMethods: { fact: DeclarationFact; target: string; scope: string }[] = [];
  for (const { node, name, kind: rawKind } of captured) {
    let parent: DeclarationFact | undefined, impl: Node | undefined;
    for (let ancestor = node.parent; ancestor; ancestor = ancestor.parent) {
      if (ancestor.type === 'impl_item') impl = ancestor;
      parent = byNode.get(ancestor.id);
      if (parent) break;
    }
    const receiver = node.childForFieldName('receiver');
    const target = (impl?.childForFieldName('type')?.text ?? receiver?.descendantsOfType('type_identifier')[0]?.text)?.replace(/<.*>$/, '');
    const kind = rawKind === 'function' && (impl || (parent && METHOD_OWNERS.has(parent.kind))) ? 'method' : rawKind;
    const owner = node.parent?.type === 'decorated_definition' ? node.parent : node;
    const qualifiedName = [parent?.qualifiedName ?? top, name.text].filter(Boolean).join(separator);
    const mods = modifiers(node), notes = annotations(node);
    const visibility = mods.find(item => /^(public|private|protected|internal|pub(?:\(.+\))?)$/.test(item));
    const fact: DeclarationFact = {
      key: String(node.id), ...(parent ? { parent: parent.key } : {}), name: name.text, qualifiedName, kind,
      entityType: CALLABLES.has(kind) ? (kind === 'function' ? 'function' : 'method') : kind === 'property' ? 'method' : 'class',
      signature: `${mods.includes('static') && CALLABLES.has(kind) ? 'static ' : ''}${signature(node, name, kind)}`, range: source.range(owner.startIndex, owner.endIndex),
      start: owner.startIndex, end: owner.endIndex, nameEnd: name.endIndex,
      ...(visibility ? { visibility } : {}), ...(mods.length ? { modifiers: mods } : {}), ...(notes.length ? { annotations: notes } : {}),
      ...(language === 'go' ? { exported: /^[A-Z]/.test(name.text) } : language === 'rust' ? { exported: !!visibility?.startsWith('pub') } : {}),
    };
    declarations.push(fact); byNode.set(node.id, fact);
    if (target) receiverMethods.push({ fact, target, scope: parent?.qualifiedName ?? top });
    if (!CALLABLES.has(kind)) { const list = owners.get(qualifiedName) ?? []; list.push(fact); owners.set(qualifiedName, list); }
  }
  // Resolve local receiver ownership after collecting every declaration:
  // both languages permit a method/impl before its type. External owners
  // stay unattached, with a receiver-qualified name for later binding.
  const previousNames = new Map(declarations.map(fact => [fact.key, fact.qualifiedName]));
  for (const { fact, target, scope } of receiverMethods) {
    const qualifiedTarget = [scope, target].filter(Boolean).join(separator);
    const candidates = owners.get(qualifiedTarget) ?? [];
    if (candidates.length === 1) fact.parent = candidates[0]!.key;
    fact.qualifiedName = `${qualifiedTarget}${separator}${fact.name}`;
  }
  const byKey = new Map(declarations.map(fact => [fact.key, fact]));
  const updated = new Set(receiverMethods.map(item => item.fact.key));
  const qualify = (fact: DeclarationFact): void => {
    if (updated.has(fact.key)) return;
    updated.add(fact.key);
    const parent = fact.parent ? byKey.get(fact.parent) : undefined;
    if (!parent) return;
    qualify(parent);
    if (parent.qualifiedName !== previousNames.get(parent.key)) fact.qualifiedName = `${parent.qualifiedName}${separator}${fact.name}`;
  };
  declarations.forEach(qualify);
  // Parser node IDs are allocation identities; only positional keys are sent
  // across the worker boundary. Neither kind of key becomes a graph identity.
  const keys = new Map(declarations.map(item => [item.key, `${item.start}:${item.end}:${item.kind}`]));
  for (const declaration of declarations) { const key = keys.get(declaration.key)!; if (declaration.parent) declaration.parent = keys.get(declaration.parent); declaration.key = key; }
  issues.sort((a, b) => (a.range?.startLine ?? 0) - (b.range?.startLine ?? 0) || (a.range?.startColumn ?? 0) - (b.range?.startColumn ?? 0) || a.reason.localeCompare(b.reason));
  const python = language === 'python' ? extractPythonImports(root, declarations, source) : undefined;
  truncated ||= python?.truncated ?? false;
  if (truncated) issues.push({ code: 'syntax-budget-exceeded', reason: 'Structural extraction reached its node, declaration, diagnostic or query limit' });
  return { declarations, issues, truncated, ...(python ? { python: python.facts } : {}) };
}
