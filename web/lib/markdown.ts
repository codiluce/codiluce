// A small Markdown reader for explanations: the blocks and inline marks models
// write (headings, paragraphs, nested lists, code, quotes, tables, rules;
// bold, italic, code spans, links), as a tree the Explanations column renders
// with its own links. Never produces HTML, so model output cannot inject any.

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'strong' | 'em' | 'del'; children: Inline[] }
  | { kind: 'code'; text: string }
  | { kind: 'link'; href: string; children: Inline[] }
  | { kind: 'break' };
export type Block =
  | { kind: 'heading'; level: number; children: Inline[] }
  | { kind: 'paragraph'; children: Inline[] }
  | { kind: 'list'; ordered: boolean; start: number; items: Block[][] }
  | { kind: 'code'; language: string; text: string }
  | { kind: 'quote'; children: Block[] }
  | { kind: 'table'; align: ('left' | 'center' | 'right' | undefined)[]; head: Inline[][]; rows: Inline[][][] }
  | { kind: 'rule' };

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]*)/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^ {0,3}([-*_])(\s*\1){2,}\s*$/;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;

export function parseMarkdown(source: string): Block[] { return blocks(source.replace(/\r\n?/g, '\n').split('\n')); }

function blocks(lines: string[]): Block[] {
  const result: Block[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (!line.trim()) { index++; continue; }
    // HTML comments (a tour's scene markers) are not read.
    if (/^ {0,3}<!--[\s\S]*-->\s*$/.test(line)) { index++; continue; }
    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1]!, body: string[] = [];
      index++;
      while (index < lines.length && !new RegExp(`^ {0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}\\s*$`).test(lines[index]!)) body.push(lines[index++]!);
      index++;
      result.push({ kind: 'code', language: fence[2] ?? '', text: body.join('\n') });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) { result.push({ kind: 'heading', level: heading[1]!.length, children: inline(heading[2]!) }); index++; continue; }
    if (RULE.test(line)) { result.push({ kind: 'rule' }); index++; continue; }
    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (index < lines.length && lines[index]!.trim() && (QUOTE.test(lines[index]!) || body.length)) { const quoted = QUOTE.exec(lines[index]!); if (!quoted && FENCE.test(lines[index]!)) break; body.push(quoted ? quoted[1]! : lines[index]!); index++; }
      result.push({ kind: 'quote', children: blocks(body) });
      continue;
    }
    if (ITEM.test(line)) { const [list, next] = listAt(lines, index); result.push(list); index = next; continue; }
    if (line.includes('|') && index + 1 < lines.length && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(lines[index + 1]!)) {
      const split = (row: string) => row.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, '|'));
      const head = split(line), align = split(lines[index + 1]!).map(cell => cell.startsWith(':') && cell.endsWith(':') ? 'center' as const : cell.endsWith(':') ? 'right' as const : cell.startsWith(':') ? 'left' as const : undefined);
      index += 2;
      const rows: Inline[][][] = [];
      while (index < lines.length && lines[index]!.includes('|') && lines[index]!.trim()) rows.push(split(lines[index++]!).map(cell => inline(cell)));
      result.push({ kind: 'table', align, head: head.map(cell => inline(cell)), rows });
      continue;
    }
    const body: string[] = [];
    while (index < lines.length && lines[index]!.trim() && !FENCE.test(lines[index]!) && !HEADING.test(lines[index]!) && !RULE.test(lines[index]!) && !QUOTE.test(lines[index]!) && !(ITEM.test(lines[index]!) && body.length && !/^\s{4,}/.test(lines[index]!))) body.push(lines[index++]!);
    if (!body.length) { body.push(lines[index++]!); }
    result.push({ kind: 'paragraph', children: inline(body.join('\n')) });
  }
  return result;
}
/** A list from `start`: items at its indentation, each holding the lines indented under it (nested lists among them). */
function listAt(lines: string[], start: number): [Block, number] {
  const first = ITEM.exec(lines[start]!)!;
  const indent = first[1]!.length, ordered = /\d/.test(first[2]!);
  const items: Block[][] = [];
  let index = start;
  while (index < lines.length) {
    const match = ITEM.exec(lines[index]!);
    if (!match || match[1]!.length !== indent || /\d/.test(match[2]!) !== ordered) {
      if (match && match[1]!.length > indent && items.length) { index = appendNested(lines, index, indent, items); continue; }
      break;
    }
    const content = [match[3]!];
    const width = indent + match[2]!.length + 1;
    index++;
    let blank = false;
    while (index < lines.length) {
      const line = lines[index]!;
      if (!line.trim()) { blank = true; index++; continue; }
      const leading = line.length - line.trimStart().length;
      const nestedItem = ITEM.exec(line);
      if (nestedItem && nestedItem[1]!.length <= indent) break;
      if (leading >= Math.min(width, indent + 2) || (!blank && !nestedItem)) { content.push(blank ? `\n${line.slice(Math.min(leading, width))}` : line.slice(Math.min(leading, width))); blank = false; index++; continue; }
      break;
    }
    items.push(blocks(content.join('\n').split('\n')));
    // A blank line, then something not in the list: the list ends.
  }
  return [{ kind: 'list', ordered, start: ordered ? Number(/\d+/.exec(first[2]!)![0]) : 1, items }, index];
}
function appendNested(lines: string[], index: number, indent: number, items: Block[][]): number {
  const [list, next] = listAt(lines, index);
  items[items.length - 1]!.push(list);
  void indent;
  return next;
}

/** Inline marks of a paragraph or cell. */
export function inline(text: string): Inline[] {
  const result: Inline[] = [];
  let buffer = '';
  const flush = () => { if (buffer) { result.push({ kind: 'text', text: buffer }); buffer = ''; } };
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    if (char === '\\' && index + 1 < text.length) {
      if (text[index + 1] === '\n') { flush(); result.push({ kind: 'break' }); index += 2; continue; }
      if (/[\\`*_{}[\]()#+\-.!|~<>]/.test(text[index + 1]!)) { buffer += text[index + 1]; index += 2; continue; }
    }
    if (char === '\n') {
      if (buffer.endsWith('  ')) { buffer = buffer.trimEnd(); flush(); result.push({ kind: 'break' }); }
      else buffer += ' ';
      index++; continue;
    }
    if (char === '`') {
      const ticks = /^`+/.exec(text.slice(index))![0];
      const end = text.indexOf(ticks, index + ticks.length);
      if (end > 0) { flush(); result.push({ kind: 'code', text: text.slice(index + ticks.length, end).replace(/\n/g, ' ').replace(/^ (.+) $/, '$1') }); index = end + ticks.length; continue; }
      buffer += ticks; index += ticks.length; continue;
    }
    if (char === '!' && text[index + 1] === '[') {
      const link = linkAt(text, index + 1);
      if (link) { buffer += link.label; index = link.end; continue; }
    }
    if (char === '[') {
      const link = linkAt(text, index);
      if (link) { flush(); result.push({ kind: 'link', href: link.href, children: inline(link.label) }); index = link.end; continue; }
    }
    if (char === '<') {
      const auto = /^<(https?:\/\/[^\s>]+)>/.exec(text.slice(index));
      if (auto) { flush(); result.push({ kind: 'link', href: auto[1]!, children: [{ kind: 'text', text: auto[1]! }] }); index += auto[0].length; continue; }
    }
    if (char === '*' || char === '_' || char === '~') {
      const run = new RegExp(`^\\${char}+`).exec(text.slice(index))![0];
      const size = char === '~' ? (run.length >= 2 ? 2 : 0) : Math.min(run.length, 2);
      // Underscores inside words (snake_case) are text.
      const intraword = char === '_' && /\w/.test(text[index - 1] ?? '') ;
      if (size && !intraword && text[index + size] && !/\s/.test(text[index + size]!)) {
        const marker = char.repeat(size);
        const close = findClose(text, index + size, marker);
        if (close > index + size) {
          flush();
          result.push({ kind: char === '~' ? 'del' : size === 2 ? 'strong' : 'em', children: inline(text.slice(index + size, close)) });
          index = close + size; continue;
        }
      }
      buffer += run; index += run.length; continue;
    }
    buffer += char; index++;
  }
  flush();
  return result;
}
/** `[label](href)` at `start`: the label may nest brackets; the destination may hold spaces and one level of parentheses. */
function linkAt(text: string, start: number): { label: string; href: string; end: number } | undefined {
  let depth = 0, index = start;
  for (; index < text.length; index++) {
    const char = text[index];
    if (char === '\\') { index++; continue; }
    if (char === '`') { const end = text.indexOf('`', index + 1); if (end > 0) { index = end; continue; } }
    if (char === '[') depth++;
    else if (char === ']' && --depth === 0) break;
  }
  if (depth !== 0 || text[index + 1] !== '(') return undefined;
  const label = text.slice(start + 1, index);
  let parens = 0, end = index + 2;
  for (; end < text.length; end++) {
    const char = text[end];
    if (char === '\n') return undefined;
    if (char === '(') parens++;
    else if (char === ')') { if (parens === 0) break; parens--; }
  }
  if (end >= text.length) return undefined;
  const href = text.slice(index + 2, end).trim().replace(/\s+"[^"]*"$/, '').replace(/^<(.*)>$/, '$1');
  return href ? { label, href, end: end + 1 } : undefined;
}
function findClose(text: string, from: number, marker: string): number {
  for (let index = from; index <= text.length - marker.length; index++) {
    const char = text[index];
    if (char === '\\') { index++; continue; }
    if (char === '`') { const end = text.indexOf('`', index + 1); if (end > 0) { index = end; continue; } }
    if (char === '[') { const link = linkAt(text, index); if (link) { index = link.end - 1; continue; } }
    if (text.startsWith(marker, index) && !/\s/.test(text[index - 1] ?? ' ') && (marker.length === 2 || text[index + 1] !== marker[0]) && !(marker[0] === '_' && /\w/.test(text[index + marker.length] ?? ''))) return index;
  }
  return -1;
}
/** Plain text of inline marks (titles, aria labels). */
export function plainText(nodes: Inline[]): string {
  return nodes.map(node => node.kind === 'text' || node.kind === 'code' ? node.text : node.kind === 'break' ? ' ' : plainText(node.children)).join('');
}
