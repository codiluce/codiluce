import { rustIdentifier, rustName, rustString } from '../languages/rust-cfg.js';

export interface WarpPathSyntax {
  segments: ({ kind: 'literal'; value: string } | { kind: 'type'; text: string })[];
  end: boolean;
}

/** The public path! grammar consumes individual token trees. This reader only
 * accepts original string literals and bare type identifiers, without expanding
 * the macro or inventing generated declarations. Comments never join tokens. */
export function warpPathSyntax(tokens: string): WarpPathSyntax | undefined {
  if (tokens.length > 8192 || !['()', '[]', '{}'].includes(tokens[0]! + tokens.at(-1))) return;
  const text = tokens.slice(1, -1), pieces: string[] = [];
  let i = 0;
  const whitespace = (): boolean => {
    while (i < text.length) {
      if (/\s/u.test(text[i]!)) { i++; continue; }
      if (text.startsWith('//', i)) { const end = text.indexOf('\n', i + 2); i = end < 0 ? text.length : end + 1; continue; }
      if (text.startsWith('/*', i)) {
        let depth = 1; i += 2;
        while (i < text.length && depth) {
          if (text.startsWith('/*', i)) { depth++; i += 2; }
          else if (text.startsWith('*/', i)) { depth--; i += 2; }
          else i++;
        }
        if (depth) return false;
        continue;
      }
      break;
    }
    return true;
  };
  while (true) {
    if (!whitespace()) return;
    if (i === text.length) break;
    if (pieces.length >= 64) return;
    const start = i, raw = /^r(#{0,255})"/.exec(text.slice(i));
    if (raw) {
      const end = text.indexOf('"' + raw[1], i + raw[0].length);
      if (end < 0) return;
      i = end + 1 + raw[1]!.length;
    } else if (text[i] === '"') {
      i++;
      while (i < text.length && text[i] !== '"') { if (text[i] === '\\') i++; i++; }
      if (i >= text.length) return;
      i++;
    } else if (text.startsWith('..', i)) i += 2;
    else {
      const identifier = /^(?:r#)?[_\p{ID_Start}][_\p{ID_Continue}]*/u.exec(text.slice(i));
      if (!identifier) return;
      i += identifier[0].length;
    }
    pieces.push(text.slice(start, i));
    if (!whitespace()) return;
    if (i === text.length) break;
    if (text[i++] !== '/') return;
    if (!whitespace() || i === text.length) return;
  }
  const segments: WarpPathSyntax['segments'] = [];
  let end = true;
  for (const [index, piece] of pieces.entries()) {
    if (piece === '..') {
      if (!index || index !== pieces.length - 1) return;
      end = false; continue;
    }
    const value = rustString(piece);
    if (value !== undefined) {
      if (!value || value.includes('/')) return;
      segments.push({ kind: 'literal', value });
    } else if (rustIdentifier(piece)) segments.push({ kind: 'type', text: rustName(piece) });
    else return;
  }
  return { segments, end };
}
