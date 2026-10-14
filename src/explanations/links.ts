// Links in explanations: Markdown links whose targets name code by what a
// model knows (repo-relative paths), not by index IDs. Pure, so the server,
// the MCP tools and the browser read them the same way.
//
//   [checkout](app/Http/Controllers/CheckoutController.php)   a file
//   [controllers](app/Http/Controllers/)                       a folder
//   [store](app/Http/Controllers/CheckoutController.php#store) a symbol in a file
//   [the guard](app/Http/Kernel.php#L40-L62)                   lines of a file
//   [checkout flow](flow:POST%20/api/checkout)                 a flow by its entry point
//   [the fix](commit:3fe7e5b)  [PR 42](pr:42)  [orders](table:orders)  [billing](feature:billing)

export type LinkKind = 'path' | 'flow' | 'commit' | 'pr' | 'table' | 'feature' | 'external';
export interface ParsedLink {
  kind: LinkKind;
  /** The href as written. */
  href: string;
  /** path: repo-relative, no leading `./` or `/`; trailing `/` kept off. Others: the decoded value after the scheme. */
  target: string;
  /** path: a symbol name after `#` (`store`, `CheckoutController.store`). */
  symbol?: string;
  /** path: `#L40` or `#L40-L62`. */
  lines?: { start: number; end: number };
  /** path: written with a trailing `/` (a folder). */
  folder?: boolean;
}
export interface LinkOccurrence { text: string; href: string; index: number }

const SCHEMES = ['flow', 'commit', 'pr', 'table', 'feature'] as const;

/** Classify one href; undefined for anchors and empty links. */
export function parseLink(href: string): ParsedLink | undefined {
  const raw = href.trim().replace(/^<|>$/g, '');
  if (!raw || raw.startsWith('#')) return undefined;
  if (/^(https?:|mailto:)/i.test(raw)) return { kind: 'external', href, target: raw };
  const scheme = /^([a-z]+):(.*)$/s.exec(raw);
  if (scheme && (SCHEMES as readonly string[]).includes(scheme[1]!)) {
    const value = decode(scheme[2]!).trim();
    if (!value) return undefined;
    return { kind: scheme[1] as LinkKind, href, target: scheme[1] === 'commit' ? value.toLowerCase() : scheme[1] === 'pr' ? value.replace(/^#/, '') : value };
  }
  // Anything else with a scheme (vscode:, file:) is not code we index.
  if (scheme && /^[a-z][a-z0-9+.-]*$/i.test(scheme[1]!) && scheme[1]!.length > 1) return { kind: 'external', href, target: raw };
  const hash = raw.indexOf('#');
  let path = decode(hash >= 0 ? raw.slice(0, hash) : raw).trim();
  const fragment = hash >= 0 ? decode(raw.slice(hash + 1)).trim() : '';
  path = path.replace(/^\.\/+/, '').replace(/^\/+/, '');
  const folder = path.endsWith('/') || path === '.' || path === '';
  path = path.replace(/\/+$/, '');
  if (path === '.') path = '';
  const link: ParsedLink = { kind: 'path', href, target: path, ...(folder ? { folder: true } : {}) };
  const lines = /^L(\d+)(?:-L?(\d+))?$/i.exec(fragment);
  if (lines) { const start = Number(lines[1]), end = Number(lines[2] ?? lines[1]); link.lines = { start: Math.min(start, end), end: Math.max(start, end) }; }
  else if (fragment) link.symbol = fragment;
  return link;
}
function decode(text: string): string { try { return decodeURIComponent(text.replace(/\+/g, '%20')); } catch { return text; } }

/**
 * The links of a Markdown text, in order (images and code spans excluded).
 * Lenient like the renderer: a destination may hold spaces (`flow:POST /x`).
 */
export function linksIn(markdown: string): LinkOccurrence[] {
  const result: LinkOccurrence[] = [];
  const text = stripCode(markdown);
  const pattern = /(!?)\[([^\]\n]*)\]\(([^()\n]*(?:\([^()\n]*\)[^()\n]*)*)\)/g;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    if (match[1]) continue;
    const href = match[3]!.trim().replace(/\s+"[^"]*"$/, '');
    if (href) result.push({ text: match[2]!, href, index: match.index });
  }
  return result;
}
/** Code fences and spans blanked out (same length), so links inside code are not links. */
export function stripCode(markdown: string): string {
  return markdown.replace(/```[\s\S]*?(```|$)|~~~[\s\S]*?(~~~|$)/g, block => block.replace(/[^\n]/g, ' ')).replace(/`[^`\n]*`/g, span => ' '.repeat(span.length));
}

/** The href that links an indexed entity: its path, with the symbol (or lines) after `#`. */
export function pathHref(path: string, options: { symbol?: string; lines?: { start: number; end?: number }; folder?: boolean } = {}): string {
  const encoded = path.split('/').map(part => encodeURIComponent(part)).join('/') + (options.folder && path ? '/' : '');
  if (options.symbol) return `${encoded}#${encodeURIComponent(options.symbol)}`;
  if (options.lines) return `${encoded}#L${options.lines.start}${options.lines.end && options.lines.end !== options.lines.start ? `-L${options.lines.end}` : ''}`;
  return encoded || './';
}
export function schemeHref(kind: Exclude<LinkKind, 'path' | 'external'>, value: string): string { return `${kind}:${encodeURIComponent(value).replace(/%2F/gi, '/').replace(/%3A/gi, ':')}`; }

/** A short guide to the link syntax, for models (MCP tool descriptions, the chat's instructions). */
export const LINK_GUIDE = [
  'Link every file, folder, symbol, flow, table and commit you mention, with Markdown links, so the reader can light it on the Codiluce map:',
  '- a file: [CheckoutController](app/Http/Controllers/CheckoutController.php)',
  '- a folder: [the controllers](app/Http/Controllers/)',
  '- a symbol in its file: [store](app/Http/Controllers/CheckoutController.php#store) (also Class.method)',
  '- lines of a file: [the guard](app/Http/Kernel.php#L40-L62)',
  '- a flow by its entry point: [the checkout request](flow:POST%20/api/checkout); a page: [cart page](flow:/cart)',
  '- a commit: [the fix](commit:3fe7e5b), a pull request: [PR 42](pr:42), a table: [orders](table:orders), a feature: [billing](feature:billing)',
  'Paths are relative to the repository root. Copy the `link` values the tools return; do not invent paths.',
].join('\n');

const SYMBOLS = new Set(['class', 'controller', 'component', 'function', 'method', 'model', 'test']);
/** The href of an entity from what the browser knows of it (its parent: the class around a method). */
export function hrefForNode(node: { type: string; name: string; path?: string; kind?: string }, parent?: { type: string; name: string }): string | undefined {
  if (node.kind === 'group') return undefined;
  if (node.type === 'repository') return './';
  if (node.type === 'database_table') return schemeHref('table', node.name);
  if (['route', 'api_endpoint', 'command', 'scheduled_task'].includes(node.type)) return schemeHref('flow', node.name);
  if (!node.path) return undefined;
  if (node.type === 'file') return pathHref(node.path);
  if (node.type === 'directory' || node.type === 'application') return pathHref(node.path, { folder: true });
  return pathHref(node.path, { symbol: parent && SYMBOLS.has(parent.type) && SYMBOLS.has(node.type) ? `${parent.name}.${node.name}` : node.name });
}
