import type { Entity } from '../../core/graph.js';
import type { RoutePattern, RouteSegment, RoutingContract } from './contracts.js';

export type WarpDialect = 'warp-0.3' | 'warp-0.4';
export type WarpNode =
  | { kind: 'any' | 'end' | 'tail' | 'extract' }
  | { kind: 'literal'; value: string }
  | { kind: 'param'; type?: string; guard?: string }
  | { kind: 'method'; methods: string[] }
  | { kind: 'and' | 'or'; left: WarpNode; right: WarpNode }
  | { kind: 'handler'; input: WarpNode; id: string; fallible: boolean }
  | { kind: 'mount'; input: WarpNode; id: string; prefix: string; file: string; line: number }
  | { kind: 'opaque'; input?: WarpNode; reason: string; pathNeutral?: boolean };

export interface WarpPathData { branch: WarpNode }
export interface WarpDispatchData { program: WarpNode; handler: string }
export interface WarpBranch { node: WarpNode; handler?: string; methods: string[] | '*'; conditions: string[]; mounts?: RoutingContract['mounts'] }
const distinct = <T>(items: T[]): T[] => [...new Set(items)];
const intersection = (a: string[] | '*', b: string[] | '*') => a === '*' ? b : b === '*' ? a : a.filter(method => b.includes(method));

/** Both public families use the original URI path, including escapes. They do
 * not percent-decode or normalize repeated slashes. A consumed segment skips
 * exactly one slash; this is why /a and /a/ both satisfy path("a").and(end()). */
function segment(path: string, cursor: number): { value: string; next: number } {
  const slash = path.indexOf('/', cursor), end = slash < 0 ? path.length : slash;
  return { value: path.slice(cursor, end), next: end === path.length ? end : end + 1 };
}
export function warpParamMatches(guard: string | undefined, value: string): boolean | undefined {
  if (!value) return false;
  if (guard === 'String') return true;
  if (guard === 'bool') return value === 'true' || value === 'false';
  const integer = /^([iu])(8|16|32|64|128)$/.exec(guard ?? '');
  if (!integer) return undefined;
  if (!(integer[1] === 'u' ? /^\+?\d+$/ : /^[+-]?\d+$/).test(value) || /\s/u.test(value) || value.length > 4096) return false;
  const bits = BigInt(integer[2]!), signed = integer[1] === 'i', limit = 1n << (signed ? bits - 1n : bits), number = BigInt(value);
  return number >= (signed ? -limit : 0n) && number < limit;
}
interface State { cursor: number; handler?: string; uncertain: boolean }
interface Outcome { success: State[]; rejects: boolean; exhausted?: boolean }

/** Execute only the reviewed filter predicates. Unknown predicates preserve
 * success and rejection possibilities. An or resets to its original cursor;
 * a rejection after a successful inner or never retries that inner right side. */
export function evaluateWarp(program: WarpNode, path: string, method: string, strict = true): Outcome {
  let steps = 0;
  const walk = (node: WarpNode, state: State, depth = 0): Outcome => {
    if (++steps > 4096 || depth > 64) return { success: [], rejects: true, exhausted: true };
    const pass = (next = state): Outcome => ({ success: [next], rejects: false });
    const reject = (): Outcome => ({ success: [], rejects: true });
    if (node.kind === 'and') {
      const left = walk(node.left, state, depth + 1), success: State[] = [];
      let rejects = left.rejects, exhausted = left.exhausted;
      for (const next of left.success) {
        const right = walk(node.right, next, depth + 1);
        success.push(...right.success); rejects ||= right.rejects; exhausted ||= right.exhausted;
      }
      return { success, rejects, ...exhausted ? { exhausted: true } : {} };
    }
    if (node.kind === 'or') {
      const left = walk(node.left, state, depth + 1);
      if (!left.rejects || left.exhausted) return left;
      const right = walk(node.right, state, depth + 1);
      return { success: [...left.success, ...right.success], rejects: right.rejects, ...right.exhausted ? { exhausted: true } : {} };
    }
    if (node.kind === 'handler') {
      const input = walk(node.input, state, depth + 1);
      return { ...input, success: input.success.map(next => ({ ...next, handler: node.id, uncertain: next.uncertain || node.fallible || !!next.handler })), rejects: input.rejects || node.fallible && input.success.length > 0 };
    }
    if (node.kind === 'mount') return walk(node.input,state,depth+1);
    if (node.kind === 'opaque') {
      const input = node.input ? walk(node.input, state, depth + 1) : pass();
      const possible = (next: State): State[] => {
        if (node.pathNeutral) return [{ ...next, uncertain: true }];
        // A custom filter/wrapper may change the cursor or handle a prior
        // rejection. Do not borrow the original path proof for its result.
        return distinct([next.cursor, ...Array.from(path.matchAll(/\//g), match => match.index! + 1), path.length]).map(cursor => ({ ...next, cursor, uncertain: true }));
      };
      const success = input.success.flatMap(possible);
      if (node.input && !node.pathNeutral && input.rejects) success.push(...possible(state));
      return { success: success.slice(0, 512), rejects: true, ...input.exhausted || success.length > 512 ? { exhausted: true } : {} };
    }
    if (node.kind === 'any' || node.kind === 'extract') return pass();
    if (node.kind === 'tail') return pass({ ...state, cursor: path.length });
    if (node.kind === 'end') return state.cursor === path.length ? pass() : reject();
    if (node.kind === 'method') return method === '*' || node.methods.includes(method) ? pass() : reject();
    const next = segment(path, state.cursor), hole = next.value.includes('{*}');
    if (node.kind === 'literal') return next.value === node.value ? pass({ ...state, cursor: next.next }) : hole && !strict ? { success: [{ ...state, cursor: next.next, uncertain: true }], rejects: true } : reject();
    if (node.kind === 'param') {
      if (hole) return strict ? reject() : { success: [{ ...state, cursor: next.next, uncertain: true }], rejects: true };
      const matches = warpParamMatches(node.guard, next.value);
      return matches === false ? reject() : { success: [{ ...state, cursor: next.next, uncertain: state.uncertain || matches === undefined }], rejects: matches === undefined };
    }
    return reject();
  };
  return path.length <= 8192 && path.startsWith('/') ? walk(program, { cursor: 1, uncertain: false }) : { success: [], rejects: true, exhausted: true };
}

/** Branches are source endpoint summaries only. The full program above owns
 * request selection; flattening these summaries cannot reproduce nested or. */
export function warpBranches(program: WarpNode): WarpBranch[] | undefined {
  let count = 0;
  const walk = (node: WarpNode, depth = 0): WarpBranch[] | undefined => {
    if (++count > 2048 || depth > 64) return;
    if (node.kind === 'and' || node.kind === 'or') {
      const left = walk(node.left, depth + 1), right = walk(node.right, depth + 1);
      if (!left || !right || (node.kind === 'and' ? left.length * right.length : left.length + right.length) > 256) return;
      if (node.kind === 'or') return [...left, ...right];
      return left.flatMap(a => right.map(b => ({ node: { kind: 'and' as const, left: a.node, right: b.node }, methods: intersection(a.methods, b.methods), handler: b.handler ?? a.handler, mounts:[...a.mounts??[],...b.mounts??[]], conditions: distinct([...a.conditions, ...b.conditions, ...a.handler && b.handler ? ['Multiple Warp mapper stages require native extraction/reply transformation proof'] : []]) })));
    }
    if (node.kind === 'handler') {
      return walk(node.input, depth + 1)?.map(branch => ({ ...branch, node: { ...node, input: branch.node }, handler: node.id, conditions: distinct([...branch.conditions, ...branch.handler ? ['Multiple Warp mapper stages require native extraction/reply transformation proof'] : [], ...node.fallible ? ['Warp and_then can reject after native path/method filters; source return success is unproven'] : []]) }));
    }
    if (node.kind === 'mount') return walk(node.input,depth+1)?.map(branch=>({...branch,node:{...node,input:branch.node},mounts:[{id:node.id,prefix:node.prefix,file:node.file,line:node.line},...branch.mounts??[]]}));
    if (node.kind === 'opaque') {
      return (node.input ? walk(node.input, depth + 1) : [{ node: { kind: 'any' as const }, methods: '*' as const, conditions: [] }])?.map(branch => ({ ...branch, node: { ...node, ...node.input ? { input: branch.node } : {} }, conditions: distinct([...branch.conditions, node.reason]) }));
    }
    return [{ node, methods: node.kind === 'method' ? node.methods : '*', conditions: node.kind === 'param' && !node.guard ? ['Warp FromStr parameter type/implementation is unreviewed'] : [] }];
  };
  return walk(program);
}

export function compileWarpPath(branch: WarpNode, dialect: WarpDialect): RoutePattern {
  const segments: RouteSegment[] = [];
  let ended = false, captures = 0, partial = false;
  const read = (node: WarpNode, depth = 0): void => {
    if (depth > 64) { partial = true; return; }
    if (node.kind === 'and') { read(node.left, depth + 1); read(node.right, depth + 1); }
    else if (node.kind === 'handler' || node.kind === 'mount') read(node.input, depth + 1);
    else if (node.kind === 'opaque') { partial = true; if (node.input) read(node.input, depth + 1); }
    else if (node.kind === 'literal') { if (ended) partial = true; segments.push({ kind: 'segment', parts: [{ kind: 'literal', value: node.value }] }); }
    else if (node.kind === 'param') { if (ended) partial = true; segments.push({ kind: 'segment', parts: [{ kind: 'parameter', name: `p${captures++}`, ...node.guard ? { constraint: node.guard } : {} }] }); }
    else if (node.kind === 'tail') { segments.push({ kind: 'rest', name: `tail${captures++}`, minimum: 0 }); ended = true; }
    else if (node.kind === 'end') ended = true;
    else if (node.kind === 'or') partial = true;
  };
  read(branch);
  const path = '/' + segments.map(s => s.kind === 'rest' ? `<${s.name}..>` : s.parts.map(p => p.kind === 'literal' ? p.value : `<${p.name}>`).join('')).join('/');
  const original = path + (!ended && segments.length ? '/..' : ''), alternatives = ended ? segments : [...segments, { kind: 'rest' as const, name: '__remaining', minimum: 0 as const }];
  return { version: 1, dialect, original, status: partial ? 'partial' : 'exact', ...partial ? { reason: 'Original Warp filter branch contains unreviewed predicates or cursor transformations', prefix: '/' } : {}, alternatives: [alternatives], caseSensitive: true, strict: false, warp: { branch } };
}
export function matchWarpPath(pattern: RoutePattern, path: string, strict = true): boolean {
  const node = pattern.warp?.branch;
  return !!node && evaluateWarp(node, path, '*', strict).success.length > 0;
}
export function preferWarpRoutes(items: Entity[], contract: (entity: Entity) => RoutingContract | undefined, path: string, method: string, strict = true): Entity[] {
  const outcomes = new Map<string, Outcome>();
  return items.filter(entity => {
    const own = contract(entity);
    if (own?.dispatch?.dialect !== 'warp' || !own.warp) return true;
    let result = outcomes.get(own.dispatch.root);
    if (!result) { result = evaluateWarp(own.warp.program, path, method, strict); outcomes.set(own.dispatch.root, result); }
    // An opaque successful branch without an original response callback can
    // compete even when it produced no source endpoint entity.
    return !result.exhausted && !result.success.some(state => !state.handler) && result.success.some(state => state.handler === own.warp!.handler);
  });
}
