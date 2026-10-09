import path from 'node:path';
import { valid } from 'semver';
import { goString } from '../tree-sitter/go-imports.js';

export interface GoReplace { module: string; version?: string; target: string; targetVersion?: string; local: boolean }
export interface GoManifest { kind: 'module' | 'workspace'; module?: string; goVersion?: string; toolchain?: string; requires: Record<string, string>; excludes: { module: string; version: string }[]; replacements: GoReplace[]; uses: string[]; godebug: Record<string, string>; tools: string[]; retracts: string[]; issues: string[]; valid: boolean }
export function goModulePath(value: string): boolean { return /^[A-Za-z0-9][A-Za-z0-9._~/-]*$/.test(value) && !value.endsWith('/') && path.posix.normalize(value) === value && !value.split('/').some(part => part === '.' || part === '..'); }
function version(module: string, value: string): boolean {
  if (!value.startsWith('v') || !valid(value)) return false;
  const major = Number(value.slice(1).split('.')[0]), suffix = /\/v(\d+)$/.exec(module) ?? (module.startsWith('gopkg.in/') ? /\.v(\d+)$/.exec(module) : null);
  return suffix ? Number(suffix[1]) === major && (module.startsWith('gopkg.in/') || major >= 2) : major < 2 || value.endsWith('+incompatible');
}
/** go.mod/work are data, not executable configuration. This bounded lexer
 * keeps comments/quoted paths out of directive matching and refuses recovery
 * that could turn a malformed main-module declaration into a default. */
export function parseGoManifest(text: string, kind: GoManifest['kind']): GoManifest {
  const result: GoManifest = { kind, requires: {}, excludes: [], replacements: [], uses: [], godebug: {}, tools: [], retracts: [], issues: [], valid: true };
  const rows: string[][] = [], tokens: string[] = []; let count = 0;
  const issue = (reason: string) => { if (result.issues.length < 32) result.issues.push(reason); result.valid = false; };
  const row = () => { if (tokens.length) rows.push(tokens.splice(0)); };
  if (text.length > 1 << 20) { issue('Go manifest exceeds extraction budget'); return result; }
  for (let i = 0; i < text.length;) {
    if (++count > 40_000) { issue('Go manifest exceeds token budget'); break; }
    const char = text[i]!;
    if (char === '\n' || char === '\r') { row(); i++; continue; }
    if (/\s/.test(char)) { i++; continue; }
    if (text.startsWith('//', i)) { const end = text.indexOf('\n', i); i = end < 0 ? text.length : end; continue; }
    if (char === '"') {
      const start = i++; let closed = false;
      while (i < text.length) { const next = text[i++]!; if (next === '\\') i++; else if (next === '"') { closed = true; break; } else if (next === '\n' || next === '\r') break; }
      const value = closed && goString(text.slice(start, i)); if (typeof value !== 'string') { issue('Malformed quoted Go manifest token'); break; } tokens.push(value); continue;
    }
    if (char === '`' || char === ';' || text.startsWith('/*', i)) { issue('Unsupported Go manifest lexical syntax'); break; }
    if (char === '(' || char === ')') { tokens.push(char); i++; continue; }
    if (text.startsWith('=>', i)) { tokens.push('=>'); i += 2; continue; }
    const start = i; while (i < text.length && !/[\s()"`;]/.test(text[i]!) && !text.startsWith('//', i) && !text.startsWith('=>', i)) i++;
    if (i === start) { issue('Invalid Go manifest token'); break; } tokens.push(text.slice(start, i));
  }
  row(); let block: string | undefined;
  const seen = new Set<string>();
  for (const values of rows) {
    if (values[0] === ')') { if (!block || values.length !== 1) issue('Unbalanced Go manifest block'); block = undefined; continue; }
    const directive = block ?? values[0]!, args = block ? values : values.slice(1);
    if (args[0] === '(') { if (block || args.length !== 1 || !['require', 'replace', 'exclude', 'retract', 'tool', 'godebug', 'use'].includes(directive)) issue('Invalid Go manifest block'); else block = directive; continue; }
    const duplicate = (key: string) => { if (seen.has(key)) issue(`Repeated ${key} directive`); seen.add(key); };
    if (directive === 'module') { duplicate('module'); if (kind !== 'module' || args.length !== 1 || !goModulePath(args[0]!)) issue('Invalid module path directive'); else result.module = args[0]; }
    else if (directive === 'go') { duplicate('go'); if (args.length !== 1 || !/^1\.\d+(?:\.\d+)?$/.test(args[0]!)) issue('Invalid go version directive'); else result.goVersion = args[0]; }
    else if (directive === 'toolchain') { duplicate('toolchain'); if (args.length !== 1 || !/^(?:default|go1\.\d+(?:\.\d+)?(?:rc\d+|beta\d+)?)$/.test(args[0]!)) issue('Invalid toolchain directive'); else result.toolchain = args[0]; }
    else if (directive === 'require' || directive === 'exclude') {
      if (kind !== 'module' || args.length !== 2 || !goModulePath(args[0]!) || !version(args[0]!, args[1]!)) { issue(`Invalid ${directive} directive`); continue; }
      duplicate(`${directive}:${args[0]}${directive === 'exclude' ? `@${args[1]}` : ''}`); if (directive === 'require') result.requires[args[0]!] = args[1]!; else result.excludes.push({ module: args[0]!, version: args[1]! });
    } else if (directive === 'replace') {
      const arrow = args.indexOf('=>'), left = args.slice(0, arrow), right = args.slice(arrow + 1), local = right[0] === '.' || right[0]?.startsWith('./') || right[0]?.startsWith('../') || path.posix.isAbsolute(right[0] ?? '') || /^[A-Za-z]:/.test(right[0] ?? '');
      if (arrow < 1 || arrow > 2 || right.length !== (local ? 1 : 2) || !goModulePath(left[0]!) || left[1] && !version(left[0]!, left[1]) || !local && (!goModulePath(right[0]!) || !version(right[0]!, right[1]!))) { issue('Invalid replace directive'); continue; }
      duplicate(`replace:${left[0]}@${left[1] ?? '*'}`); result.replacements.push({ module: left[0]!, ...(left[1] ? { version: left[1] } : {}), target: right[0]!, ...(right[1] ? { targetVersion: right[1] } : {}), local });
    } else if (directive === 'use') { if (kind !== 'workspace' || args.length !== 1 || !args[0] || /[\0\\]/.test(args[0]!)) issue('Invalid workspace use directive'); else { duplicate(`use:${args[0]}`); result.uses.push(args[0]!); } }
    else if (directive === 'tool') { if (kind !== 'module' || args.length !== 1 || !goModulePath(args[0]!)) issue('Invalid tool declaration'); else { duplicate(`tool:${args[0]}`); result.tools.push(args[0]!); } }
    else if (directive === 'godebug') { const match = args.length === 1 && /^([A-Za-z][A-Za-z0-9]*)=([A-Za-z0-9_.-]+)$/.exec(args[0]!); if (!match) issue('Invalid godebug declaration'); else { duplicate(`godebug:${match[1]}`); result.godebug[match[1]!] = match[2]!; } }
    else if (directive === 'retract') { const value = args.join(''), versions = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1).split(',') : [value]; if (kind !== 'module' || versions.length > 2 || !versions.every(value => value.startsWith('v') && !!valid(value))) issue('Invalid retraction declaration'); else result.retracts.push(value); }
    else issue(`Unreviewed ${directive} manifest directive`);
  }
  if (block) issue('Unterminated Go manifest block');
  if (kind === 'module' && !result.module) issue('Missing module directive');
  if (kind === 'workspace' && !result.goVersion) issue('Missing workspace go version');
  return result;
}
