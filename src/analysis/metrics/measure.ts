// Code health metrics: a few numbers per function that mean the same thing in
// every language, measured on tree-sitter syntax.
//
// Each language describes its syntax in grammars/queries/<language>/metrics.scm
// with the captures below; this engine applies one set of rules to all of them.
//   @function   a function bound to a name: a declaration, a method, or a
//               function value assigned to a variable, field or property.
//               @name in the same pattern names it; @receiver qualifies it.
//   @lambda     an anonymous function. Inside a named function it is part of
//               that function (its body adds one nesting level). Anywhere else
//               (top level, or inside a top-level callback, as `it` inside
//               `describe`) it is a unit of its own, named by @name if captured.
//   @scope      a class-like container; its @name qualifies what it holds.
//   @branch     a decision point: if and else-if, a loop, a case arm, a catch,
//               a ternary, a short-circuit && or || (not ?? or ?.).
//   @nesting    a structure whose body is indented: if, loop, switch, try.
//   @else_if    an `if` continuing an else-if chain: a branch, no extra depth.
//   @parameter  a declared parameter (not self/cls, not a Go receiver).
//   @comment    comments and docstrings: they never count as length.
//
// Per function:
// - length: lines holding code. Lines of named functions written inside it
//   belong to them, and lines with only brackets and punctuation (`}`, `});`)
//   do not count, so brace style does not change the number. The first line
//   always counts.
// - complexity: McCabe's cyclomatic complexity, 1 + decision points.
// - nesting: the deepest @nesting, counting the anonymous functions around it.
// - parameters: the function's own, not those of the lambdas inside it.
// Per file: lines holding code, by the same rule.
import type { Query, Node, TreeCursor } from 'web-tree-sitter';

export const METRICS_VERSION = 1;
export interface FunctionMetrics { name: string; startLine: number; endLine: number; length: number; complexity: number; nesting: number; parameters: number }
export interface FileMetrics { lines: number; functions: FunctionMetrics[] }

interface Unit { name: string; anonymous: boolean; startLine: number; endLine: number; lines: Set<number>; decisions: number; nesting: number; parameters: number }
/** `own`: the closest function around the node is the unit itself, not a lambda inside it. */
interface Frame { unit?: Unit; own: boolean; depth: number; scope: string[]; comment: boolean }
const MAX_CALLEE = 40;

export function measure(root: Node, query: Query): FileMetrics {
  const named = new Map<number, string | undefined>(), lambdas = new Map<number, string | undefined>(), scopes = new Map<number, string>();
  const branches = new Set<number>(), nesting = new Set<number>(), elseIf = new Set<number>(), parameters = new Set<number>(), comments = new Set<number>();
  for (const match of query.matches(root)) {
    const name = match.captures.find(capture => capture.name === 'name')?.node.text;
    const receiver = match.captures.find(capture => capture.name === 'receiver')?.node.text;
    for (const { name: role, node } of match.captures) {
      const id = node.id;
      if (role === 'function') {
        // A pattern with a receiver is more specific than a bare declaration pattern.
        const own = name ?? node.childForFieldName('name')?.text;
        if (!named.has(id) || receiver) named.set(id, receiver && own ? `${receiver}.${own}` : named.get(id) ?? own);
      }
      else if (role === 'lambda') { if (!lambdas.get(id)) lambdas.set(id, name && `${name.length > MAX_CALLEE ? `${name.slice(0, MAX_CALLEE)}…` : name} callback`); }
      else if (role === 'scope') { if (name) scopes.set(id, name); }
      else if (role === 'branch') branches.add(id);
      else if (role === 'nesting') nesting.add(id);
      else if (role === 'else_if') elseIf.add(id);
      else if (role === 'parameter') parameters.add(id);
      else if (role === 'comment') comments.add(id);
    }
  }

  const units: Unit[] = [], fileLines = new Set<number>();
  // Most nodes change nothing: a node shares its parent's frame, copied only when it differs.
  const enter = (cursor: TreeCursor, parent: Frame): Frame => {
    const id = cursor.nodeId;
    let frame = parent;
    if (!parent.comment && comments.has(id)) frame = { ...parent, comment: true };
    const scope = scopes.get(id);
    if (scope) { if (frame === parent) frame = { ...parent }; frame.scope = [...parent.scope, scope]; }
    const isNamed = named.has(id), isLambda = lambdas.has(id);
    if (isNamed || (isLambda && (!parent.unit || parent.unit.anonymous))) {
      const name = (isNamed ? named.get(id) : lambdas.get(id)) ?? '(anonymous)';
      const row = cursor.startPosition.row, qualified = [...frame.scope, name];
      const unit: Unit = { name: qualified.join('.'), anonymous: !isNamed, startLine: row + 1, endLine: cursor.endPosition.row + 1, lines: new Set(), decisions: 0, nesting: 0, parameters: 0 };
      units.push(unit);
      // Its first line declares it, even as bare punctuation: `() => {`.
      unit.lines.add(row); fileLines.add(row);
      return { ...frame, unit, own: true, depth: 0, scope: qualified };
    }
    const unit = frame.unit;
    if (!unit) return frame;
    if (isLambda) { if (frame === parent) frame = { ...parent }; frame.depth++; frame.own = false; }
    if (branches.has(id)) unit.decisions++;
    if (nesting.has(id) && !elseIf.has(id)) { if (frame === parent) frame = { ...parent }; frame.depth++; unit.nesting = Math.max(unit.nesting, frame.depth); }
    // Parameters belong to the closest function: the unit itself, not a lambda inside it.
    if (parameters.has(id) && frame.own) unit.parameters++;
    return frame;
  };
  const leaf = (cursor: TreeCursor, frame: Frame): void => {
    if (frame.comment) return;
    // Anonymous tokens are keywords (`else`, `return`) or punctuation (`}`, `;`): only keywords hold code.
    if (!cursor.nodeIsNamed && !/\w/.test(cursor.nodeType)) return;
    const start = cursor.startPosition, end = cursor.endPosition;
    if (start.row === end.row && start.column === end.column) return;
    const last = end.column === 0 && end.row > start.row ? end.row - 1 : end.row;
    for (let row = start.row; row <= last; row++) { fileLines.add(row); frame.unit?.lines.add(row); }
  };

  // Iterative walk: deep expression chains must not exhaust the call stack.
  const cursor = root.walk(), frames: Frame[] = [];
  let frame = enter(cursor, { own: false, depth: 0, scope: [], comment: false });
  try {
    walk: for (;;) {
      if (cursor.gotoFirstChild()) { frames.push(frame); frame = enter(cursor, frame); continue; }
      leaf(cursor, frame);
      for (;;) {
        if (cursor.gotoNextSibling()) { frame = enter(cursor, frames.at(-1)!); continue walk; }
        if (!cursor.gotoParent()) break walk;
        frame = frames.pop()!;
      }
    }
  } finally { cursor.delete(); }

  return {
    lines: fileLines.size,
    functions: units.map(unit => ({ name: unit.name, startLine: unit.startLine, endLine: unit.endLine, length: unit.lines.size, complexity: 1 + unit.decisions, nesting: unit.nesting, parameters: unit.parameters })),
  };
}
