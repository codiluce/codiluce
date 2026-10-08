import type { RoutePart, RoutePattern, RouteSegment } from '../routes/contracts.js';
import type { AstroConfig } from './astro-config.js';

/** The filename is a pattern, not the set of getStaticPaths output URLs. */
export function astroPath(file: string, base = '', trailingSlash: AstroConfig['trailingSlash'] = 'ignore'): RoutePattern | undefined {
  if (file.split('/').some(part => part.startsWith('_')) || /\.d\.ts$/.test(file)) return undefined;
  const endpoint = /\.[jt]s$/.test(file);
  let stem = file.replace(/\.(?:astro|mdx?|[jt]s)$/, '').replace(/(?:^|\/)index$/, '');
  stem = `${base}/${stem}`.replace(/\/$/, '') || '/';
  const extension = endpoint && /\.[^/\[\]]+$/.test(stem);
  if (!extension && trailingSlash === 'always' && stem !== '/') stem += '/';
  const pattern: RoutePattern = { version: 1, dialect: 'astro', original: stem, status: 'exact', alternatives: [[]], caseSensitive: true, strict: !!extension || trailingSlash !== 'ignore' };
  const partial = (reason: string): RoutePattern => ({ ...pattern, status: 'partial', reason, alternatives: [] });
  if (stem.length > 4096 || /[?#\\]/.test(stem) || stem.includes('//')) return partial('Invalid/oversized Astro filesystem path');
  const names = new Set<string>(); let restSeen = false;
  for (const raw of stem.split('/').filter(Boolean)) {
    const rest = /^\[\.\.\.([A-Za-z_]\w*)\]$/.exec(raw); let segment: RouteSegment;
    if (rest) {
      if (restSeen || names.has(rest[1]!)) return partial('Multiple/duplicate Astro rest parameters require a separate static-generation profile');
      restSeen = true; names.add(rest[1]!); segment = { kind: 'rest', name: rest[1]!, minimum: 0 };
    } else {
      const parts: RoutePart[] = []; let cursor = 0;
      for (const match of raw.matchAll(/\[([A-Za-z_]\w*)\]/g)) {
        if (match.index! > cursor) parts.push({ kind: 'literal', value: raw.slice(cursor, match.index).normalize() });
        if (names.has(match[1]!)) return partial('Duplicate Astro parameter name'); names.add(match[1]!);
        parts.push({ kind: 'parameter', name: match[1]! }); cursor = match.index! + match[0].length;
      }
      if (cursor < raw.length) parts.push({ kind: 'literal', value: raw.slice(cursor).normalize() });
      if (parts.some(part => part.kind === 'literal' && /[\[\]]/.test(part.value)) || parts.some((part, index) => part.kind === 'parameter' && parts[index + 1]?.kind === 'parameter')) return partial('Unsupported/unbalanced/adjacent Astro filename parameters');
      segment = { kind: 'segment', parts };
    }
    pattern.alternatives[0]!.push(segment);
  }
  return pattern;
}
