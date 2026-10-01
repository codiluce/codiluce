// Syntax highlighting for a bounded window of source lines. highlight.js output
// is HTML-escaped; spans that cross line breaks are closed and reopened so each
// line can be rendered (and highlighted) independently.
import hljs from 'highlight.js/lib/core';
import typescript from 'highlight.js/lib/languages/typescript';
import javascript from 'highlight.js/lib/languages/javascript';
import php from 'highlight.js/lib/languages/php';
import css from 'highlight.js/lib/languages/css';
import scss from 'highlight.js/lib/languages/scss';
import json from 'highlight.js/lib/languages/json';
import yaml from 'highlight.js/lib/languages/yaml';
import markdown from 'highlight.js/lib/languages/markdown';
import xml from 'highlight.js/lib/languages/xml';
import bash from 'highlight.js/lib/languages/bash';
import sql from 'highlight.js/lib/languages/sql';

const LANGUAGES = { typescript, javascript, php, css, scss, json, yaml, markdown, xml, bash, sql };
for (const [name, language] of Object.entries(LANGUAGES)) if (!hljs.getLanguage(name)) hljs.registerLanguage(name, language);
const ALIASES: Record<string, string> = { typescript: 'typescript', javascript: 'javascript', php: 'php', css: 'css', scss: 'scss', json: 'json', yaml: 'yaml', markdown: 'markdown', html: 'xml', xml: 'xml', shell: 'bash', sql: 'sql' };

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
/** Split highlighted HTML into lines, carrying open <span> tags across breaks. */
export function splitHighlighted(html: string): string[] {
  const lines: string[] = [];
  const open: string[] = [];
  let current = '';
  const tag = /<span[^>]*>|<\/span>|\n/g;
  let last = 0, match: RegExpExecArray | null;
  while ((match = tag.exec(html))) {
    current += html.slice(last, match.index);
    last = match.index + match[0].length;
    if (match[0] === '\n') { lines.push(current + '</span>'.repeat(open.length)); current = open.join(''); }
    else if (match[0] === '</span>') { open.pop(); current += match[0]; }
    else { open.push(match[0]); current += match[0]; }
  }
  current += html.slice(last);
  lines.push(current + '</span>'.repeat(open.length));
  return lines;
}
export function highlightLines(lines: string[], language: string | undefined): string[] {
  const grammar = language ? ALIASES[language] : undefined;
  const text = lines.join('\n');
  if (!grammar || text.length > 400_000) return lines.map(escapeHtml);
  try { return splitHighlighted(hljs.highlight(text, { language: grammar, ignoreIllegals: true }).value); }
  catch { return lines.map(escapeHtml); }
}
