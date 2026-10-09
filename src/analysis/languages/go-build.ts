import path from 'node:path';
import type { GoBuildConfig } from '../../core/config.js';
import type { GoSyntaxFacts } from '../facts.js';

export const GO_BUILD_VERSION = '1';
// The go/build filename vocabulary includes historical targets. It is not a
// claim that every OS/architecture combination is a supported toolchain.
export const GOOS = new Set('aix android darwin dragonfly freebsd hurd illumos ios js linux nacl netbsd openbsd plan9 solaris wasip1 windows zos'.split(' '));
export const GOARCH = new Set('386 amd64 amd64p32 arm armbe arm64 arm64be loong64 mips mipsle mips64 mips64le mips64p32 mips64p32le ppc ppc64 ppc64le riscv riscv64 s390 s390x sparc sparc64 wasm'.split(' '));
const UNIX = new Set('aix android darwin dragonfly freebsd hurd illumos ios linux netbsd openbsd solaris'.split(' '));
type Truth = boolean | 'unknown';
type Expr = { tag: string } | { not: Expr } | { and: [Expr, Expr] } | { or: [Expr, Expr] };
export interface GoSelection { status: 'active' | 'inactive' | 'conditional' | 'invalid'; conditions: string[]; expressions: string[]; test: boolean }
const and = (a: Truth, b: Truth): Truth => a === false || b === false ? false : a === true && b === true ? true : 'unknown';
const or = (a: Truth, b: Truth): Truth => a === true || b === true ? true : a === false && b === false ? false : 'unknown';
function evaluate(expr: Expr, tag: (name: string) => Truth): Truth {
  if ('tag' in expr) return tag(expr.tag);
  if ('not' in expr) { const value = evaluate(expr.not, tag); return value === 'unknown' ? value : !value; }
  return 'and' in expr ? and(evaluate(expr.and[0], tag), evaluate(expr.and[1], tag)) : or(evaluate(expr.or[0], tag), evaluate(expr.or[1], tag));
}
function modern(text: string): Expr | undefined {
  if (text.length > 4096) return undefined;
  const tokens = text.match(/&&|\|\||[!()]|[A-Za-z0-9_.]+|\S/g) ?? []; let i = 0;
  if (!tokens.length || tokens.length > 256) return undefined;
  function primary(depth: number): Expr | undefined {
    if (depth > 32) return undefined;
    const token = tokens[i++];
    if (token === '!') { const item = primary(depth + 1); return item && { not: item }; }
    if (token === '(') { const item = disjunction(depth + 1); return tokens[i++] === ')' ? item : undefined; }
    return token && /^[A-Za-z0-9_.]+$/.test(token) ? { tag: token } : undefined;
  }
  function conjunction(depth: number): Expr | undefined { let value = primary(depth); while (value && tokens[i] === '&&') { i++; const right = primary(depth); if (!right) return undefined; value = { and: [value, right] }; } return value; }
  function disjunction(depth: number): Expr | undefined { let value = conjunction(depth); while (value && tokens[i] === '||') { i++; const right = conjunction(depth); if (!right) return undefined; value = { or: [value, right] }; } return value; }
  const result = disjunction(0); return i === tokens.length ? result : undefined;
}
function legacy(text: string): Expr | undefined {
  if (text.length > 4096) return undefined;
  const groups = text.trim().split(/\s+/); if (!groups.length || groups.length > 128) return undefined;
  let result: Expr | undefined, count = 0;
  for (const group of groups) {
    let clause: Expr | undefined;
    for (const token of group.split(',')) { if (++count > 256 || !/^!?[A-Za-z0-9_.]+$/.test(token)) return undefined; const value: Expr = token.startsWith('!') ? { not: { tag: token.slice(1) } } : { tag: token }; clause = clause ? { and: [clause, value] } : value; }
    if (clause) result = result ? { or: [result, clause] } : clause;
  }
  return result;
}
function equivalent(a: Expr, b: Expr): boolean | undefined {
  const names = new Set<string>(), collect = (expr: Expr): void => { if ('tag' in expr) names.add(expr.tag); else if ('not' in expr) collect(expr.not); else for (const child of 'and' in expr ? expr.and : expr.or) collect(child); }; collect(a); collect(b);
  if (names.size > 12) return undefined;
  const tags = [...names];
  for (let bits = 0; bits < 2 ** tags.length; bits++) { const values = new Map(tags.map((tag, i) => [tag, !!(bits & 2 ** i)])); if (evaluate(a, tag => values.get(tag)!) !== evaluate(b, tag => values.get(tag)!)) return false; }
  return true;
}
export function goTag(name: string, config: GoBuildConfig): Truth {
  if (config.tags?.includes(name)) return true;
  if (name === 'cgo') return config.cgoEnabled ?? 'unknown';
  if (name === 'gc' || name === 'gccgo') return config.compiler === undefined ? 'unknown' : config.compiler === name;
  if (name === 'unix') return config.goos === undefined ? 'unknown' : UNIX.has(config.goos);
  if (GOOS.has(name)) return config.goos === undefined ? 'unknown' : config.goos === name || name === 'linux' && config.goos === 'android' || name === 'darwin' && config.goos === 'ios' || name === 'solaris' && config.goos === 'illumos';
  if (GOARCH.has(name)) return config.goarch === undefined ? 'unknown' : config.goarch === name;
  if (/^go1\.\d+$/.test(name)) return config.toolchainVersion === undefined ? 'unknown' : Number(config.toolchainVersion.split('.')[1]) >= Number(name.slice(4));
  return config.tags === undefined ? 'unknown' : false;
}
export function selectGoFile(file: string, facts: GoSyntaxFacts, text: string, config: GoBuildConfig = {}): GoSelection {
  const conditions: string[] = [], expressions: string[] = [], base = path.posix.basename(file), test = base.endsWith('_test.go'); let truth: Truth = true;
  const result = (status: GoSelection['status']): GoSelection => ({ status, conditions, expressions, test });
  if (/^[_.]/.test(base) || !base.endsWith('.go') || test && !config.includeTests) return result('inactive');
  if (config.goos && !GOOS.has(config.goos) || config.goarch && !GOARCH.has(config.goarch)) { conditions.push('Unreviewed target OS/architecture vocabulary'); return result('invalid'); }
  const filename = base.slice(0, -3).replace(/_test$/, ''), parts = filename.split('_');
  if (parts.length > 1 && GOARCH.has(parts.at(-1)!)) { const arch = parts.pop()!; expressions.push(arch); truth = and(truth, goTag(arch, config)); }
  if (parts.length > 1 && GOOS.has(parts.at(-1)!)) { const os = parts.pop()!; expressions.push(os); truth = and(truth, goTag(os, config)); }
  const builds: { expression: string; expr?: Expr; modern: boolean }[] = [];
  for (const comment of facts.comments) {
    const match = /^(\/\/go:build|\/\/\s*\+build)(?:[ \t]+(.*))?$/.exec(comment.text); if (!match) continue;
    const expression = match[2]?.trim() ?? '', isModern = match[1] === '//go:build';
    if (comment.start >= (facts.package?.start ?? 0) || !/(?:\r?\n)[ \t]*(?:\r?\n)/.test(text.slice(comment.end, facts.package?.start))) { conditions.push('Misplaced build constraint or missing blank line before package'); return result('invalid'); }
    const expr = isModern ? modern(expression) : legacy(expression); if (!expr) { conditions.push('Malformed or over-budget build constraint'); return result('invalid'); }
    builds.push({ expression, expr, modern: isModern });
    if (builds.length > 64) { conditions.push('Build constraint count exceeds extraction budget'); return result('invalid'); }
  }
  const current = builds.filter(build => build.modern), old = builds.filter(build => !build.modern);
  if (current.length > 1) { conditions.push('Multiple go:build constraints'); return result('invalid'); }
  let oldExpr: Expr | undefined; for (const build of old) oldExpr = oldExpr ? { and: [oldExpr, build.expr!] } : build.expr;
  if (current[0] && oldExpr && equivalent(current[0].expr!, oldExpr) !== true) { conditions.push('Modern/legacy build constraints disagree or exceed equivalence budget'); return result('invalid'); }
  const constraint = current[0]?.expr ?? oldExpr;
  if (constraint) { expressions.push(...(current.length ? current : old).map(build => build.expression)); truth = and(truth, evaluate(constraint, name => goTag(name, config))); }
  if (facts.imports.some(item => item.specifier === 'C')) { expressions.push('cgo enabled for import C'); truth = and(truth, config.cgoEnabled ?? 'unknown'); }
  if (truth === false) return result('inactive');
  if (!facts.complete || !facts.package) { conditions.push('Incomplete Go syntax cannot qualify this compilation unit'); return result('invalid'); }
  if (truth === 'unknown') conditions.push(`Unknown build inputs for ${expressions.join(' && ')}`);
  return result(truth === 'unknown' ? 'conditional' : 'active');
}
