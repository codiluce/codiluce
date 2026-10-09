import type { Node } from 'web-tree-sitter';
import type { GoSyntaxFacts } from '../facts.js';
import type { SourceText } from '../source-map.js';

/** Decode Go's raw/interpreted strings without running a target toolchain.
 * Byte escapes are decoded as UTF-8 together, rather than as JS code points. */
export function goString(text: string): string | undefined {
  if (text.startsWith('`') && text.endsWith('`') && !text.slice(1, -1).includes('`')) return text.slice(1, -1).replace(/\r/g, '');
  if (!text.startsWith('"') || !text.endsWith('"')) return undefined;
  const bytes: number[] = [], encoder = new TextEncoder(), simple: Record<string, number> = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, '\\': 92, '"': 34 };
  for (let i = 1; i < text.length - 1; i++) {
    const char = text[i]!;
    if (char === '"' || char === '\n' || char === '\r') return undefined;
    if (char !== '\\') { const point = text.codePointAt(i)!; if (point >= 0xd800 && point <= 0xdfff) return undefined; bytes.push(...encoder.encode(String.fromCodePoint(point))); if (point > 0xffff) i++; continue; }
    const escape = text[++i]; if (!escape || i >= text.length - 1) return undefined;
    if (escape in simple) { bytes.push(simple[escape]!); continue; }
    const size = escape === 'x' ? 2 : escape === 'u' ? 4 : escape === 'U' ? 8 : /[0-7]/.test(escape) ? 3 : 0;
    if (!size) return undefined;
    const octal = /[0-7]/.test(escape), start = octal ? i : i + 1, digits = text.slice(start, start + size);
    if (start + size > text.length - 1 || digits.length !== size || !(octal ? /^[0-7]+$/ : /^[0-9a-fA-F]+$/).test(digits)) return undefined;
    const value = parseInt(digits, octal ? 8 : 16); i = start + size - 1;
    if (octal || escape === 'x') { if (value > 255) return undefined; bytes.push(value); }
    else { if (value > 0x10ffff || value >= 0xd800 && value <= 0xdfff) return undefined; bytes.push(...encoder.encode(String.fromCodePoint(value))); }
  }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes)); } catch { return undefined; }
}

export function extractGoImports(root: Node, source: SourceText): { facts: GoSyntaxFacts; truncated: boolean } {
  const facts: GoSyntaxFacts = { imports: [], comments: [], complete: !root.hasError }, clauses = root.namedChildren.filter(node => node.type === 'package_clause');
  const clause = clauses.length === 1 ? clauses[0] : undefined, name = clause?.namedChildren.find(node => node.type === 'package_identifier');
  if (name && name.text !== '_' && !clause!.hasError) facts.package = { name: name.text, range: source.range(clause!.startIndex, clause!.endIndex), start: clause!.startIndex };
  else facts.complete = false;
  let count = 0, truncated = false;
  for (const node of root.namedChildren) {
    if (++count > 20_000) { truncated = true; break; }
    if (node.type === 'comment') facts.comments.push({ text: node.text, start: node.startIndex, end: node.endIndex });
    if (node.type !== 'import_declaration') continue;
    for (const spec of node.descendantsOfType('import_spec')) {
      if (++count > 20_000) { truncated = true; break; }
      const literal = spec.childForFieldName('path'), alias = spec.childForFieldName('name')?.text, specifier = literal && goString(literal.text);
      if (!specifier || /[\s\0\\]/.test(specifier) || spec.hasError) { facts.complete = false; continue; }
      facts.imports.push({ specifier, ...(alias ? { local: alias } : {}), kind: alias === '.' ? 'dot' : alias === '_' ? 'blank' : alias ? 'named' : 'default', range: source.range(spec.startIndex, spec.endIndex), start: spec.startIndex, end: spec.endIndex });
    }
  }
  if (truncated) facts.complete = false;
  return { facts, truncated };
}
