import type { RoutePattern, RoutePart, RouteSegment } from '../routes/contracts.js';

export interface KitPath { path: string; groups: string[]; matchers: string[]; pattern: RoutePattern }
/** Compile filesystem syntax into bounded matching facts, never a target regex. */
export function kitPath(directory: string, base = ''): KitPath {
  const groups = directory.split('/').filter(segment => /^\([^)]+\)$/.test(segment));
  const visible = directory.split('/').filter(segment => segment && !/^\([^)]+\)$/.test(segment)), path = `${base}/${visible.join('/')}`;
  const result: KitPath = { path, groups, matchers: [], pattern: { version: 1, dialect: 'sveltekit', original: path, alternatives: [[]], status: 'exact', strict: false, caseSensitive: true } };
  const names = new Set<string>(); let restSeen = false;
  const partial = (reason: string): KitPath => { result.pattern.status = 'partial'; result.pattern.reason = reason; result.pattern.alternatives = []; return result; };
  if (path.length > 4096 || directory.includes('//') || directory.includes('\\')) return partial('Invalid or oversized SvelteKit route directory');
  for (const raw of [...base.split('/').filter(Boolean), ...visible]) {
    const rest = /^\[\.\.\.(\w+)(?:=(\w+))?\]$/.exec(raw), optional = /^\[\[(\w+)(?:=(\w+))?\]\]$/.exec(raw);
    let segment: RouteSegment;
    if (rest || optional) {
      const name = (rest ?? optional)![1]!;
      if (names.has(name)) return partial('Duplicate SvelteKit parameter name'); names.add(name);
      if ((rest ?? optional)![2]) result.matchers.push((rest ?? optional)![2]!);
      if (optional && restSeen) return partial('Optional parameter after a rest parameter is invalid');
      if (rest && restSeen) return partial('Multiple rest parameters are outside the bounded profile');
      if (rest) { restSeen = true; segment = { kind: 'rest', name, minimum: 0 }; }
      else segment = { kind: 'segment', parts: [{ kind: 'parameter', name }] };
      if (optional) {
        if (result.pattern.alternatives.length >= 32) return partial('Optional SvelteKit parameters exceed the 32-alternative budget');
        result.pattern.alternatives = result.pattern.alternatives.flatMap(parts => [parts, [...parts, segment]]); continue;
      }
    } else {
      const parts: RoutePart[] = []; let cursor = 0;
      for (const match of raw.matchAll(/\[(?:(x)\+([\da-fA-F]{2})|(u)\+([\da-fA-F]+(?:-[\da-fA-F]+)*)|(\w+)(?:=(\w+))?)\]/g)) {
        if (match.index! > cursor) parts.push({ kind: 'literal', value: raw.slice(cursor, match.index) });
        if (match[1] || match[3]) {
          try { const codes = (match[2] ?? match[4]!).split('-').map(code => parseInt(code, 16)); if (codes.some(code => code > 0xffff)) return partial('Non-BMP single-codepoint escapes require a version-specific encoding profile; UTF-16 pair escapes are supported'); const decoded = String.fromCharCode(...codes); if (decoded.includes('/') || decoded.includes('\0')) return partial('Escaped route delimiters are outside the bounded profile'); parts.push({ kind: 'literal', value: decoded }); }
          catch { return partial('Invalid escaped SvelteKit route character'); }
        } else {
          if (names.has(match[5]!)) return partial('Duplicate SvelteKit parameter name'); names.add(match[5]!);
          parts.push({ kind: 'parameter', name: match[5]! }); if (match[6]) result.matchers.push(match[6]);
        }
        cursor = match.index! + match[0].length;
      }
      if (cursor < raw.length) parts.push({ kind: 'literal', value: raw.slice(cursor) });
      if (parts.some(part => part.kind === 'literal' && /[\[\]()?#]/.test(part.value) && !raw.includes('[x+') && !raw.includes('[u+')) || parts.some((part, i) => part.kind === 'parameter' && parts[i + 1]?.kind === 'parameter')) return partial('Unsupported/unbalanced/adjacent SvelteKit route parameters');
      segment = { kind: 'segment', parts };
    }
    result.pattern.alternatives = result.pattern.alternatives.map(parts => [...parts, segment]);
  }
  return result;
}
