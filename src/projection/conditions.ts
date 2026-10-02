// The conditions a call site runs under, read from the source at request time.
//
// Given a file's content and a site line inside an owner's source range, walk
// from the innermost node on that line up to the owner's boundary and record
// every branch passed: `if` / `else`, the arms of a conditional, the right
// side of `&&` / `||`, `switch` cases, `catch`, and — in each enclosing
// block — the early exits that precede the site (`if (x) return;`). Nothing is
// stored in the index: conditions follow the source of the snapshot being
// viewed (Git blobs for commits). A file that cannot be parsed, or a line with
// no node, yields no guards rather than a wrong one.
import ts from 'typescript';
import { Engine } from 'php-parser';
import { ast, nodes, type Ast } from '../analyzers/php-ast.js';

export interface Guard {
  /** The condition's source text, whitespace-collapsed and bounded. */
  text: string;
  /** The site runs when the condition is false (an else arm, an early-exit guard, `||`). */
  negated: boolean;
  form: 'if' | 'else' | 'ternary' | 'and' | 'or' | 'case' | 'default' | 'catch' | 'guard';
  line: number;
}
const MAX_TEXT = 90, MAX_GUARDS = 6;
function bounded(text: string): string { const value = text.replace(/\s+/g, ' ').trim().replace(/^\((.*)\)$/s, '$1'); return value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT - 1)}…` : value; }

const TS_CACHE = new Map<string, ts.SourceFile>();
function tsSource(key: string, fileName: string, content: string): ts.SourceFile {
  const cached = TS_CACHE.get(key);
  if (cached) return cached;
  const source = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true);
  TS_CACHE.set(key, source);
  if (TS_CACHE.size > 24) TS_CACHE.delete(TS_CACHE.keys().next().value!);
  return source;
}
/**
 * `key` identifies the content (e.g. its hash) for caching parsed trees.
 * `hint` names what is called at the site (a callee, a component): on a line
 * with several branches it picks the right one.
 */
export function guardsAt(key: string, fileName: string, language: string | undefined, content: string, line: number, owner?: { startLine: number; endLine: number }, hint?: string): Guard[] {
  try {
    if (language === 'php') return phpGuards(key, content, line, owner, hint);
    if (language === 'typescript' || language === 'javascript') return tsGuards(tsSource(key, fileName, content), line, owner, hint);
  } catch { /* unparseable: no guards */ }
  return [];
}

function tsGuards(source: ts.SourceFile, line: number, owner?: { startLine: number; endLine: number }, hint?: string): Guard[] {
  const lineOf = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  // The hinted name on the site line, else the innermost node starting on it.
  let site: ts.Node | undefined, named: ts.Node | undefined;
  const find = (node: ts.Node): void => {
    const start = lineOf(node), end = source.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
    if (start > line || end < line) return;
    if (start === line && !ts.isSourceFile(node)) site = node;
    if (start === line && hint && !named && (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) && node.text === hint) named = node;
    ts.forEachChild(node, find);
  };
  find(source);
  site = named ?? site;
  if (!site) return [];
  const guards: Guard[] = [];
  const text = (node: ts.Node) => bounded(node.getText(source));
  const exits = (statement: ts.Statement): boolean => ts.isReturnStatement(statement) || ts.isThrowStatement(statement) || ts.isBreakStatement(statement) || ts.isContinueStatement(statement) || (ts.isBlock(statement) && statement.statements.length > 0 && exits(statement.statements.at(-1)!));
  for (let node: ts.Node = site, parent = site.parent; parent && !ts.isSourceFile(parent); node = parent, parent = parent.parent) {
    if (owner && ts.isFunctionLike(parent) && lineOf(parent) <= owner.startLine) break;
    if (ts.isIfStatement(parent) && node !== parent.expression) guards.push({ text: text(parent.expression), negated: node === parent.elseStatement, form: node === parent.elseStatement ? 'else' : 'if', line: lineOf(parent.expression) });
    else if (ts.isConditionalExpression(parent) && node !== parent.condition) guards.push({ text: text(parent.condition), negated: node === parent.whenFalse, form: 'ternary', line: lineOf(parent.condition) });
    else if (ts.isBinaryExpression(parent) && node === parent.right && parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) guards.push({ text: text(parent.left), negated: false, form: 'and', line: lineOf(parent.left) });
    else if (ts.isBinaryExpression(parent) && node === parent.right && parent.operatorToken.kind === ts.SyntaxKind.BarBarToken) guards.push({ text: text(parent.left), negated: true, form: 'or', line: lineOf(parent.left) });
    else if (ts.isCaseClause(parent) && node !== parent.expression) guards.push({ text: `${text(parent.parent.parent.expression)} is ${text(parent.expression)}`, negated: false, form: 'case', line: lineOf(parent) });
    else if (ts.isDefaultClause(parent)) guards.push({ text: `${text(parent.parent.parent.expression)} matches no case`, negated: false, form: 'default', line: lineOf(parent) });
    else if (ts.isCatchClause(parent)) guards.push({ text: 'an error was thrown', negated: false, form: 'catch', line: lineOf(parent) });
    if (ts.isBlock(parent) || ts.isSourceFile(parent)) {
      // Early exits before the statement holding the site.
      for (const statement of parent.statements) {
        if (statement === node) break;
        if (ts.isIfStatement(statement) && !statement.elseStatement && exits(statement.thenStatement)) guards.push({ text: text(statement.expression), negated: true, form: 'guard', line: lineOf(statement) });
      }
    }
  }
  return order(guards);
}
/** Outermost first, bounded; `unless !x` reads as `when x`. */
function order(guards: Guard[]): Guard[] {
  return guards.reverse().slice(-MAX_GUARDS).map(guard => guard.negated && /^!\s*[\w$.?[\]'"()-]+$/.test(guard.text) && !/\)\s*[|&]/.test(guard.text) ? { ...guard, text: guard.text.replace(/^!\s*/, ''), negated: false } : guard);
}

const PHP_CACHE = new Map<string, Ast>();
const PHP = new Engine({ parser: { version: '8.4', suppressErrors: true }, ast: { withPositions: true } });
function phpGuards(key: string, content: string, line: number, owner?: { startLine: number; endLine: number }, hint?: string): Guard[] {
  let root = PHP_CACHE.get(key);
  if (!root) { root = PHP.parseCode(content, 'source.php') as unknown as Ast; PHP_CACHE.set(key, root); if (PHP_CACHE.size > 24) PHP_CACHE.delete(PHP_CACHE.keys().next().value!); }
  const parents = new Map<Ast, Ast>();
  let site: Ast | undefined, named: Ast | undefined;
  const lower = hint?.toLowerCase();
  const visit = (node: Ast): void => {
    const start = node.loc?.start.line, end = node.loc?.end.line;
    if (start !== undefined && end !== undefined && (start > line || end < line)) return;
    if (start === line) site = node;
    if (start === line && lower && !named && (node.kind === 'name' || node.kind === 'identifier') && String(node.name).toLowerCase().split('\\').at(-1) === lower) named = node;
    for (const [field, value] of Object.entries(node)) {
      if (field === 'loc' || field === 'leadingComments' || field === 'trailingComments') continue;
      for (const child of Array.isArray(value) ? nodes(value) : ast(value) ? [ast(value)!] : []) { parents.set(child, node); visit(child); }
    }
  };
  visit(root);
  site = named ?? site;
  if (!site) return [];
  const text = (node: unknown) => { const item = ast(node); return item?.loc ? bounded(content.slice(item.loc.start.offset, item.loc.end.offset)) : ''; };
  const lineOf = (node: unknown) => ast(node)?.loc?.start.line ?? line;
  const exits = (statement: Ast | undefined): boolean => {
    if (!statement) return false;
    if (['return', 'throw', 'break', 'continue'].includes(statement.kind)) return true;
    if (statement.kind === 'expressionstatement') { const expression = ast(statement.expression); return expression?.kind === 'call' && ['abort', 'abort_if', 'abort_unless'].includes(String(ast(expression.what)?.name ?? '').toLowerCase()); }
    if (statement.kind === 'block') { const children = nodes(statement.children); return exits(children.at(-1)); }
    return false;
  };
  const guards: Guard[] = [];
  for (let node: Ast = site, parent = parents.get(site); parent; node = parent, parent = parents.get(parent)) {
    if (['method', 'function', 'closure', 'arrowfunc'].includes(parent.kind) && owner && (parent.loc?.start.line ?? 0) <= owner.startLine) break;
    if (parent.kind === 'if' && node !== parent.test) guards.push({ text: text(parent.test), negated: node === parent.alternate, form: node === parent.alternate ? 'else' : 'if', line: lineOf(parent.test) });
    else if (parent.kind === 'retif' && node !== parent.test) guards.push({ text: text(parent.test), negated: node === parent.falseExpr, form: 'ternary', line: lineOf(parent.test) });
    else if (parent.kind === 'bin' && node === parent.right && ['&&', 'and'].includes(String(parent.type))) guards.push({ text: text(parent.left), negated: false, form: 'and', line: lineOf(parent.left) });
    else if (parent.kind === 'bin' && node === parent.right && ['||', 'or'].includes(String(parent.type))) guards.push({ text: text(parent.left), negated: true, form: 'or', line: lineOf(parent.left) });
    else if (parent.kind === 'case' && node !== parent.test) { const switcher = parents.get(parents.get(parent) ?? parent); guards.push(parent.test ? { text: `${text(switcher?.test)} is ${text(parent.test)}`, negated: false, form: 'case', line: lineOf(parent) } : { text: `${text(switcher?.test)} matches no case`, negated: false, form: 'default', line: lineOf(parent) }); }
    else if (parent.kind === 'catch') guards.push({ text: 'an exception was thrown', negated: false, form: 'catch', line: lineOf(parent) });
    const siblings = parent.kind === 'block' || parent.kind === 'program' || parent.kind === 'namespace' ? nodes(parent.children) : ['method', 'function', 'closure'].includes(parent.kind) && ast(parent.body)?.kind === 'block' ? [] : [];
    for (const statement of siblings) {
      if (statement === node) break;
      if (statement.kind === 'if' && !statement.alternate && exits(ast(statement.body))) guards.push({ text: text(statement.test), negated: true, form: 'guard', line: lineOf(statement) });
    }
  }
  return order(guards);
}
/** The first name in a call's text (`localStorage.setItem(…)` → localStorage, `$user->update(…)` → update, `User::where` → User). */
export function hintOf(detail: string): string | undefined {
  const call = /(?:->|::|\.)?([A-Za-z_][\w]*)\s*\(/.exec(detail.replace(/^\$\w+->/, ''));
  return call?.[1] ?? /[A-Za-z_]\w*/.exec(detail)?.[0];
}
/** Human phrasing: `when x`, `unless x`, `when status is 'a'`, `on error`. */
export function phrase(guard: Guard): string {
  if (guard.form === 'catch') return `when ${guard.text}`;
  if (guard.form === 'case' || guard.form === 'default') return `when ${guard.text}`;
  return `${guard.negated ? 'unless' : 'when'} ${guard.text}`;
}
