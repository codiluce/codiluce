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
import python from 'highlight.js/lib/languages/python';
import go from 'highlight.js/lib/languages/go';
import rust from 'highlight.js/lib/languages/rust';
import java from 'highlight.js/lib/languages/java';
import kotlin from 'highlight.js/lib/languages/kotlin';
import scala from 'highlight.js/lib/languages/scala';
import csharp from 'highlight.js/lib/languages/csharp';
import fsharp from 'highlight.js/lib/languages/fsharp';
import vbnet from 'highlight.js/lib/languages/vbnet';
import ruby from 'highlight.js/lib/languages/ruby';
import erb from 'highlight.js/lib/languages/erb';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import objectivec from 'highlight.js/lib/languages/objectivec';
import swift from 'highlight.js/lib/languages/swift';
import ini from 'highlight.js/lib/languages/ini';
import groovy from 'highlight.js/lib/languages/groovy';
import cmake from 'highlight.js/lib/languages/cmake';
import makefile from 'highlight.js/lib/languages/makefile';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import protobuf from 'highlight.js/lib/languages/protobuf';
import graphql from 'highlight.js/lib/languages/graphql';
import properties from 'highlight.js/lib/languages/properties';
import django from 'highlight.js/lib/languages/django';

const LANGUAGES = {
  typescript, javascript, php, css, scss, json, yaml, markdown, xml, bash, sql, python, go, rust, java, kotlin, scala, csharp, fsharp, vbnet,
  ruby, erb, c, cpp, objectivec, swift, ini, groovy, cmake, makefile, dockerfile, protobuf, graphql, properties, django,
};
for (const [name, language] of Object.entries(LANGUAGES)) if (!hljs.getLanguage(name)) hljs.registerLanguage(name, language);
/**
 * Indexed language → grammar. Component files (Vue, Svelte, Astro, Razor) read
 * as HTML, whose grammar highlights their script and style blocks; Liquid as
 * Django templates, which share its `{% %}` and `{{ }}` tags.
 */
const ALIASES: Record<string, string> = {
  typescript: 'typescript', javascript: 'javascript', php: 'php', css: 'css', scss: 'scss', json: 'json', yaml: 'yaml', markdown: 'markdown', html: 'xml', xml: 'xml',
  shell: 'bash', sql: 'sql', python: 'python', go: 'go', rust: 'rust', java: 'java', kotlin: 'kotlin', scala: 'scala', csharp: 'csharp', fsharp: 'fsharp',
  vbnet: 'vbnet', ruby: 'ruby', erb: 'erb', c: 'c', cpp: 'cpp', 'objective-c': 'objectivec', swift: 'swift', toml: 'ini', groovy: 'groovy', cmake: 'cmake',
  makefile: 'makefile', dockerfile: 'dockerfile', protobuf: 'protobuf', graphql: 'graphql', properties: 'properties',
  vue: 'xml', svelte: 'xml', astro: 'xml', razor: 'xml', liquid: 'django',
};

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
