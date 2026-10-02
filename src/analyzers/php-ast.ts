// php-parser AST access shared by the Laravel analyzer and PHP call resolution.
// The parser's declarations do not discriminate node kinds. Keep that boundary
// narrow and runtime-checked instead of spreading untyped AST values downstream.
import type { ScannedFile } from '../core/analyzer.js';

export interface Ast { kind: string; loc?: { start: { line: number; column: number; offset: number }; end: { line: number; column: number; offset: number } }; [key: string]: unknown }
export interface Scope { namespace: string; imports: Map<string, string> }
export interface ParsedFile { file: ScannedFile; ast: Ast; content: string }
export function ast(value: unknown): Ast | undefined { return value && typeof value === 'object' && 'kind' in value ? value as Ast : undefined; }
export function nodes(value: unknown): Ast[] { return Array.isArray(value) ? value.map(ast).filter((node): node is Ast => !!node) : []; }
export function name(value: unknown): string | undefined { return typeof value === 'string' ? value : typeof ast(value)?.name === 'string' ? ast(value)!.name as string : undefined; }
export function literal(value: unknown): string | undefined { const node = ast(value); return node?.kind === 'string' && typeof node.value === 'string' ? node.value : undefined; }
export function args(node: Ast): Ast[] { return nodes(node.arguments); }
export function text(node: Ast | undefined, parsed: ParsedFile): string { return node?.loc ? parsed.content.slice(node.loc.start.offset, node.loc.end.offset) : ''; }
export function walk(node: Ast, visit: (node: Ast) => void): void {
  visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === 'loc' || key === 'comments' || key === 'leadingComments' || key === 'trailingComments') continue;
    if (Array.isArray(value)) for (const child of nodes(value)) walk(child, visit);
    else { const child = ast(value); if (child) walk(child, visit); }
  }
}
export function resolve(value: unknown, scope: Scope): string | undefined {
  const raw = name(value);
  if (!raw) return undefined;
  if (raw.startsWith('\\') || ast(value)?.resolution === 'fqn') return raw.replace(/^\\/, '');
  if (raw.startsWith('namespace\\')) return [scope.namespace, raw.slice(10)].filter(Boolean).join('\\');
  const [first, ...rest] = raw.split('\\');
  const imported = [...scope.imports.entries()].find(([alias]) => alias.toLowerCase() === first!.toLowerCase())?.[1];
  return imported ? [imported, ...rest].join('\\') : [scope.namespace, raw].filter(Boolean).join('\\');
}
export function scopedChildren(root: Ast, scope: Scope, visit: (children: Ast[], scope: Scope) => void): void {
  const children = nodes(root.children);
  const local = { namespace: scope.namespace, imports: new Map(scope.imports) };
  for (const item of children) if (item.kind === 'usegroup' && !item.type) {
    for (const use of nodes(item.items)) {
      if (use.type) continue;
      const fqn = [name(item.name), name(use.name)].filter(Boolean).join('\\').replace(/^\\/, '');
      if (fqn) local.imports.set(name(use.alias) ?? fqn.split('\\').at(-1)!, fqn);
    }
  }
  visit(children.filter(item => item.kind !== 'namespace'), local);
  for (const child of children) if (child.kind === 'namespace') scopedChildren(child, { namespace: name(child.name) ?? '', imports: new Map() }, visit);
}
export function classConstant(value: unknown, scope: Scope): string | undefined {
  const node = ast(value);
  return node?.kind === 'staticlookup' && name(node.offset)?.toLowerCase() === 'class' ? resolve(node.what, scope) : undefined;
}
