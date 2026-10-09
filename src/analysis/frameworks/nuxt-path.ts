import type { RoutePattern, RoutePart, RouteSegment } from '../routes/contracts.js';

/** Nuxt's Vue Router page syntax and Nitro's Radix server syntax are distinct. */
export function nuxtPath(file: string, base = '', server = false): RoutePattern | undefined {
  if (/\.d\.[cm]?[jt]s$/.test(file) || !/\.(?:vue|[cm]?[jt]sx?)$/.test(file) || file.split('/').some(part => part.startsWith('-'))) return undefined;
  let stem = file.replace(/\.(?:vue|[cm]?[jt]sx?)$/, '');
  if (server) stem = stem.replace(/(?:\.(?:connect|delete|get|head|options|patch|post|put|trace))?(?:\.(?:dev|prod|prerender))?$/, '');
  else if (/\.(?:client|server)$/.test(stem) || stem.includes('@')) return { version: 1, dialect: 'nuxt-page', original: `${base}/${stem}`, status: 'partial', reason: 'Server/client page modes and named outlets require a version-specific registration summary', alternatives: [], caseSensitive: false, strict: false };
  const visible = stem.split('/').filter(part => part && !/^\([^)]+\)$/.test(part)); if (visible.at(-1) === 'index') visible.pop();
  const original = `${base}/${visible.join('/')}` || '/', pattern: RoutePattern = { version: 1, dialect: server ? 'nitro-2' : 'nuxt-page', original, status: 'exact', alternatives: [[]], caseSensitive: server, strict: false };
  const partial = (reason: string): RoutePattern => ({ ...pattern, status: 'partial', reason, alternatives: [] });
  if (original.length > 4096 || /[?#\\]/.test(original) || file.includes('//')) return partial('Invalid/oversized Nuxt filesystem route');
  const names = new Set<string>(); let restSeen = false;
  for (const raw of [...base.split('/').filter(Boolean), ...visible]) {
    const rest = /^\[\.\.\.(\w*)\]$/.exec(raw), optional = server ? null : /^\[\[(\w+)\]\]$/.exec(raw); let segment: RouteSegment;
    if (rest || optional) {
      const name = (rest ?? optional)![1] || '_'; if (names.has(name)) return partial('Duplicate Nuxt route parameter'); names.add(name);
      if (rest && restSeen || optional && restSeen) return partial('Multiple rest/optional-after-rest routes need a separate matching profile');
      if (rest) { if (server && raw !== visible.at(-1)) return partial('Nitro catch-all parameters must terminate the bounded route'); segment = { kind: 'rest', name, minimum: server && (base || visible.indexOf(raw) > 0) ? 1 : 0 }; restSeen = true; }
      else segment = { kind: 'segment', parts: [{ kind: 'parameter', name }] };
      if (optional) { if (pattern.alternatives.length >= 32) return partial('Nuxt optional route budget exceeded'); pattern.alternatives = pattern.alternatives.flatMap(parts => [parts, [...parts, segment]]); continue; }
    } else {
      const parts: RoutePart[] = []; let cursor = 0;
      for (const match of raw.matchAll(/\[(\w+)\]/g)) { if (match.index! > cursor) parts.push({ kind: 'literal', value: raw.slice(cursor, match.index) }); if (names.has(match[1]!)) return partial('Duplicate Nuxt route parameter'); names.add(match[1]!); parts.push({ kind: 'parameter', name: match[1]! }); cursor = match.index! + match[0].length; }
      if (cursor < raw.length) parts.push({ kind: 'literal', value: raw.slice(cursor) });
      if (parts.some(part => part.kind === 'literal' && /[\[\]()]/.test(part.value)) || parts.some((part, i) => part.kind === 'parameter' && parts[i + 1]?.kind === 'parameter')) return partial('Unbalanced/adjacent Nuxt parameters');
      // Radix3 recognizes parameters only at the start of a complete segment;
      // it does not implement Vue Router's mixed literal/parameter syntax.
      if (server && parts.some(part => part.kind === 'parameter') && parts.length !== 1) return partial('Mixed Nitro parameter/literal segments require a Radix-specific summary');
      segment = { kind: 'segment', parts };
    }
    pattern.alternatives = pattern.alternatives.map(parts => [...parts, segment]);
  }
  return pattern;
}
