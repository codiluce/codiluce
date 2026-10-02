// Line diff (Myers' O(ND) algorithm) producing unified-diff hunks. Bounded:
// common prefix/suffix are trimmed first, and a diff needing more than
// `maxEdits` edits reports `tooLarge` instead of a script.
export interface DiffLine { kind: 'context' | 'added' | 'removed'; text: string; oldLine?: number; newLine?: number }
export interface Hunk { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: DiffLine[] }
export interface LineDiff { hunks: Hunk[]; added: number; removed: number; identical: boolean; tooLarge: boolean; truncated: boolean }
type Op = 0 | 1 | 2; // equal, delete (old), insert (new)

function editScript(a: Int32Array, b: Int32Array, maxEdits: number): Op[] | undefined {
  const n = a.length, m = b.length, max = n + m, offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= Math.min(max, maxEdits) && found < 0; d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? v[offset + k + 1]! : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[offset + k] = x;
      if (x >= n && y >= m) { found = d; break; }
    }
  }
  if (found < 0) return undefined;
  const ops: Op[] = [];
  let x = n, y = m;
  for (let d = found; d >= 0; d--) {
    const saved = trace[d]!, at = (k: number) => saved[k + d + 1]!;
    const k = x - y;
    const previousK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const previousX = d === 0 ? 0 : at(previousK), previousY = previousX - previousK;
    while (x > previousX && y > previousY) { ops.push(0); x--; y--; }
    if (d > 0) ops.push(x === previousX ? 2 : 1);
    x = previousX; y = previousY;
  }
  return ops.reverse();
}

/** `ignoreWhitespace` compares lines with whitespace runs collapsed (indentation and reformatting are not changes); output keeps the real text. */
export function lineDiff(before: string[], after: string[], options: { context?: number; maxEdits?: number; maxLines?: number; oldStart?: number; newStart?: number; ignoreWhitespace?: boolean } = {}): LineDiff {
  const context = options.context ?? 3, maxLines = options.maxLines ?? 4000;
  const oldBase = options.oldStart ?? 1, newBase = options.newStart ?? 1;
  const normalize = options.ignoreWhitespace ? (line: string) => line.replace(/\s+/g, ' ').trim() : (line: string) => line;
  const a = before.map(normalize), b = after.map(normalize);
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
  const empty = { hunks: [], added: 0, removed: 0, truncated: false };
  if (prefix === a.length && prefix === b.length) return { ...empty, identical: true, tooLarge: false };
  // Intern lines so comparisons are integer compares.
  const ids = new Map<string, number>();
  const intern = (lines: string[]) => Int32Array.from(lines, line => { let id = ids.get(line); if (id === undefined) { id = ids.size; ids.set(line, id); } return id; });
  const middle = editScript(intern(a.slice(prefix, a.length - suffix)), intern(b.slice(prefix, b.length - suffix)), options.maxEdits ?? 3000);
  if (!middle) return { ...empty, identical: false, tooLarge: true };
  const ops: Op[] = [...new Array<Op>(prefix).fill(0), ...middle, ...new Array<Op>(suffix).fill(0)];
  const positions: { op: Op; i: number; j: number }[] = [];
  let i = 0, j = 0, added = 0, removed = 0;
  for (const op of ops) { positions.push({ op, i, j }); if (op !== 2) i++; if (op !== 1) j++; if (op === 1) removed++; else if (op === 2) added++; }
  // Group changes separated by at most 2 × context unchanged lines; each group is one hunk with context around it.
  const groups: [number, number][] = [];
  positions.forEach((position, index) => {
    if (position.op === 0) return;
    const last = groups.at(-1);
    if (last && index - last[1] - 1 <= context * 2) last[1] = index; else groups.push([index, index]);
  });
  const hunks: Hunk[] = [];
  let emitted = 0, truncated = false;
  for (const [first, last] of groups) {
    const from = Math.max(0, first - context), to = Math.min(positions.length - 1, last + context);
    if (emitted + (to - from + 1) > maxLines) { truncated = true; break; }
    const hunk: Hunk = { oldStart: oldBase + positions[from]!.i, newStart: newBase + positions[from]!.j, oldLines: 0, newLines: 0, lines: [] };
    for (let index = from; index <= to; index++) {
      const { op, i: oi, j: nj } = positions[index]!;
      if (op === 0) { hunk.lines.push({ kind: 'context', text: before[oi]!, oldLine: oldBase + oi, newLine: newBase + nj }); hunk.oldLines++; hunk.newLines++; }
      else if (op === 1) { hunk.lines.push({ kind: 'removed', text: before[oi]!, oldLine: oldBase + oi }); hunk.oldLines++; }
      else { hunk.lines.push({ kind: 'added', text: after[nj]!, newLine: newBase + nj }); hunk.newLines++; }
    }
    emitted += hunk.lines.length;
    hunks.push(hunk);
  }
  return { hunks, added, removed, identical: false, tooLarge: false, truncated };
}
