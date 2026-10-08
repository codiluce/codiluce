import ts from 'typescript';
import type { SourceRange } from '../../core/graph.js';
import { SourceText } from '../source-map.js';

export const EMBEDDED_VERSION = '1.0.0';
export type EmbeddedLanguage = 'vue' | 'svelte' | 'astro';
export type EmbeddedRole = 'module' | 'instance' | 'setup' | 'frontmatter' | 'client';
export interface EmbeddedRegion {
  key: string; role: EmbeddedRole; language: 'javascript' | 'typescript'; extension: 'js' | 'jsx' | 'ts' | 'tsx';
  start: number; end: number; range: SourceRange; supported: boolean;
  executionContext: 'browser' | 'server' | 'unknown'; attributes: Record<string, string | true>; src?: string;
}
export interface EmbeddedIssue { code: string; reason: string; start: number; fatal?: boolean }
export interface EmbeddedFacts { regions: EmbeddedRegion[]; templates: { start: number; end: number }[]; issues: EmbeddedIssue[] }
const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const regexStarts = new Set([ts.SyntaxKind.OpenBraceToken, ts.SyntaxKind.OpenParenToken, ts.SyntaxKind.OpenBracketToken, ts.SyntaxKind.EqualsToken, ts.SyntaxKind.CommaToken, ts.SyntaxKind.ColonToken, ts.SyntaxKind.QuestionToken, ts.SyntaxKind.EqualsGreaterThanToken, ts.SyntaxKind.ReturnKeyword, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.ExclamationToken]);

/** Skip a markup expression with JS lexical rules. Quotes, comments, regular
 * expressions and nested template substitutions cannot introduce HTML tags. */
export function expressionEnd(text: string, start: number): number | undefined {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, text);
  scanner.setTextPos(start); let depth = 0, previous = ts.SyntaxKind.OpenBraceToken, steps = 0;
  const templates: number[] = [];
  while (++steps < 100_000) {
    let token = scanner.scan();
    if (token === ts.SyntaxKind.EndOfFileToken) return undefined;
    if ((token === ts.SyntaxKind.SlashToken || token === ts.SyntaxKind.SlashEqualsToken) && regexStarts.has(previous)) token = scanner.reScanSlashToken();
    if (token === ts.SyntaxKind.TemplateHead) { templates.push(depth); depth++; }
    else if (token === ts.SyntaxKind.OpenBraceToken) depth++;
    else if (token === ts.SyntaxKind.CloseBraceToken) {
      if (templates.length && depth === templates.at(-1)! + 1) {
        token = scanner.reScanTemplateToken(false);
        if (token === ts.SyntaxKind.TemplateTail) { depth--; templates.pop(); }
      } else if (--depth === 0) return scanner.getTextPos();
    }
    previous = token;
  }
  return undefined;
}
export interface MarkupAttribute { name: string; start: number; end: number; valueStart?: number; valueEnd?: number }
export interface Tag { name: string; rawName: string; closing: boolean; selfClosing: boolean; end: number; attributes: Record<string, string | true>; sites: MarkupAttribute[]; dynamic: boolean; duplicate: boolean }
export function tagAt(text: string, start: number): Tag | undefined {
  const match = /^<\s*(\/?)\s*([A-Za-z][\w:.-]*)/.exec(text.slice(start, start + 256)); if (!match) return undefined;
  const attributes: Record<string, string | true> = Object.create(null), sites: MarkupAttribute[] = []; let cursor = start + match[0].length, dynamic = false, duplicate = false, count = 0;
  while (cursor - start < 16_384 && ++count < 128) {
    while (/\s/.test(text[cursor] ?? '') && cursor < text.length) cursor++;
    if (text[cursor] === '>') return { name: match[2]!.toLowerCase(), rawName: match[2]!, closing: !!match[1], selfClosing: false, end: cursor + 1, attributes, sites, dynamic, duplicate };
    if (text.startsWith('/>', cursor)) return { name: match[2]!.toLowerCase(), rawName: match[2]!, closing: !!match[1], selfClosing: true, end: cursor + 2, attributes, sites, dynamic, duplicate };
    if (text[cursor] === '{') { const end = expressionEnd(text, cursor); if (!end) return undefined; dynamic = true; cursor = end; continue; }
    const name = /^[^\s=<>/{}]+/.exec(text.slice(cursor, Math.min(text.length, cursor + 512)))?.[0]; if (!name) return undefined;
    const attributeStart = cursor; let valueStart: number | undefined, valueEnd: number | undefined;
    cursor += name.length; while (/\s/.test(text[cursor] ?? '') && cursor < text.length) cursor++;
    let value: string | true = true;
    if (text[cursor] === '=') {
      cursor++; while (/\s/.test(text[cursor] ?? '') && cursor < text.length) cursor++;
      const quote = text[cursor];
      if (quote === '"' || quote === "'") { const end = text.indexOf(quote, ++cursor); if (end < 0) return undefined; valueStart = cursor; valueEnd = end; value = text.slice(cursor, end); cursor = end + 1; }
      else if (quote === '{') { const end = expressionEnd(text, cursor); if (!end) return undefined; valueStart = cursor; valueEnd = end; value = text.slice(cursor, end); dynamic = true; cursor = end; }
      else { const raw = /^[^\s>]+/.exec(text.slice(cursor))?.[0]; if (!raw) return undefined; valueStart = cursor; value = raw.endsWith('/') && text[cursor + raw.length] === '>' ? raw.slice(0, -1) : raw; cursor += value.length; valueEnd = cursor; }
    }
    if (Object.hasOwn(attributes, name)) duplicate = true;
    attributes[name] = value;
    sites.push({ name, start: attributeStart, end: cursor, ...(valueStart !== undefined ? { valueStart, valueEnd } : {}) });
  }
  return undefined;
}
export function originalRange(text: string, start: number, end: number): SourceRange {
  return new SourceText(text).range(start, end);
}
/** A bounded block extractor, not a framework compiler. Templates/custom
 * preprocessors remain input to framework packs, never emitted JS. */
export function extractEmbedded(text: string, language: EmbeddedLanguage): EmbeddedFacts {
  const regions: EmbeddedRegion[] = [], templates: EmbeddedFacts['templates'] = [], issues: EmbeddedIssue[] = [], counts = new Map<string, number>();
  const source = new SourceText(text);
  let cursor = 0, blocks = 0, branchDepth = 0; const stack: string[] = [];
  const issue = (code: string, reason: string, start: number, fatal = false) => issues.push({ code, reason, start, ...(fatal ? { fatal } : {}) });
  function region(start: number, end: number, role: EmbeddedRole, attributes: Record<string, string | true>, supported = true, dynamic = false): void {
    const count = counts.get(role) ?? 0; counts.set(role, count + 1);
    if (regions.length >= 32) { issue('region-limit', 'Embedded script region budget exceeded', start, true); return; }
    if (language !== 'astro' && count) issue('duplicate-script', `Multiple ${role} script blocks are invalid`, start, true);
    const lang = attributes.lang ?? (language === 'astro' ? 'ts' : 'js'), extension = lang === 'javascript' ? 'js' : lang === 'typescript' ? 'ts' : lang;
    if (!['js', 'jsx', 'ts', 'tsx'].includes(String(extension)) || dynamic) { supported = false; issue('unsupported-script', 'Dynamic script attributes or a script preprocessor require a separate profile', start); }
    if (Object.hasOwn(attributes, 'src')) { supported = false; issue('external-script', 'External script blocks need an indexed framework loading profile', start); }
    if (role === 'setup' && attributes.src) issue('invalid-setup-src', 'Vue script setup cannot use src', start, true);
    regions.push({ key: role === 'client' ? `client:${count}` : role, role, language: ['ts', 'tsx'].includes(String(extension)) ? 'typescript' : 'javascript', extension: ['js', 'jsx', 'ts', 'tsx'].includes(String(extension)) ? extension as EmbeddedRegion['extension'] : 'js', start, end, range: source.range(start, end), supported, executionContext: role === 'frontmatter' ? 'server' : language === 'astro' ? 'browser' : 'unknown', attributes, ...(typeof attributes.src === 'string' ? { src: attributes.src } : {}) });
  }
  if (language === 'astro') {
    const opener = /^\uFEFF?[ \t]*---[ \t]*(?:\r?\n|$)/.exec(text);
    if (opener) {
      const fence = /^[ \t]*---[ \t]*(?:\r?$)/gm; fence.lastIndex = opener[0].length; const closing = fence.exec(text);
      if (!closing) { issue('unclosed-frontmatter', 'Astro frontmatter has no closing fence', 0, true); return { regions, templates, issues }; }
      region(opener[0].length, closing.index, 'frontmatter', {}); cursor = closing.index + closing[0].length;
    }
  }
  const templateStart = cursor;
  while (cursor < text.length && ++blocks <= 200_000) {
    if (text.startsWith('<!--', cursor)) { const end = text.indexOf('-->', cursor + 4); if (end < 0) { issue('unclosed-comment', 'Unclosed markup comment', cursor, true); break; } cursor = end + 3; continue; }
    if (text.startsWith('<![CDATA[', cursor)) { const end = text.indexOf(']]>', cursor + 9); if (end < 0) { issue('unclosed-cdata', 'Unclosed CDATA block', cursor, true); break; } cursor = end + 3; continue; }
    if (language === 'svelte' && text.startsWith('{/', cursor)) { const close = /^\{\/(?:if|each|await|key|snippet)\s*\}/.exec(text.slice(cursor, cursor + 128)); if (close) { branchDepth = Math.max(0, branchDepth - 1); cursor += close[0].length; continue; } }
    if (text[cursor] === '{') { const end = expressionEnd(text, cursor); if (!end) { issue('unclosed-expression', 'Unclosed or over-budget markup expression', cursor, true); break; } if (language === 'svelte') { const body = text.slice(cursor + 1, end - 1).trim(); if (/^#(?:if|each|await|key|snippet)\b/.test(body)) branchDepth++; else if (/^\/(?:if|each|await|key|snippet)\b/.test(body)) branchDepth = Math.max(0, branchDepth - 1); } cursor = end; continue; }
    if (text[cursor] !== '<') { cursor++; continue; }
    const tag = tagAt(text, cursor);
    if (!tag) { if (/^<\/?[A-Za-z]/.test(text.slice(cursor, cursor + 3))) issue('invalid-tag', 'Unclosed or over-budget markup tag', cursor, true); cursor++; continue; }
    if (tag.duplicate) issue('duplicate-attribute', 'Duplicate markup attributes are not a reviewed profile', cursor, true);
    if (tag.closing) { const index = stack.lastIndexOf(tag.name); if (language === 'vue' && tag.name === 'template' && index === 0 && templates.at(-1)?.end === -1) templates.at(-1)!.end = cursor; if (index >= 0) stack.length = index; cursor = tag.end; continue; }
    const top = stack.length === 0;
    if (['script', 'style', 'textarea', 'title'].includes(tag.name) || (language === 'vue' && top && tag.name !== 'template')) {
      const closing = new RegExp(`</${tag.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*>`, 'gi'); closing.lastIndex = tag.end;
      const end = tag.selfClosing ? { index: tag.end, 0: '' } : closing.exec(text);
      if (!end) { issue('unclosed-block', `Unclosed ${tag.name} block`, cursor, true); break; }
      if (tag.name === 'script' && (top || language === 'astro')) {
        if (language === 'svelte' && branchDepth) issue('conditional-script', 'A component script inside a template block is not a top-level script', cursor, true);
        let role: EmbeddedRole = language === 'astro' ? 'client' : language === 'vue' ? Object.hasOwn(tag.attributes, 'setup') ? 'setup' : 'module' : Object.hasOwn(tag.attributes, 'module') || tag.attributes.context === 'module' ? 'module' : 'instance';
        if (language === 'svelte' && (tag.attributes.context !== undefined && tag.attributes.context !== 'module' || tag.attributes.module !== undefined && tag.attributes.module !== true)) issue('invalid-script-context', 'Svelte script context is not a reviewed module/instance form', cursor, true);
        const type = tag.attributes.type, data = typeof type === 'string' && !['module', 'text/javascript', 'application/javascript'].includes(type);
        const processed = language !== 'astro' || Object.keys(tag.attributes).every(key => key === 'src');
        if (!processed && !data) issue('unprocessed-script', 'Astro scripts with extra attributes are browser-native scripts; bundler/module binding requires a separate profile', cursor);
        if (!data) region(tag.end, end.index, role, tag.attributes, processed, tag.dynamic);
      }
      cursor = end.index + end[0].length; continue;
    }
    if (language === 'vue' && top && tag.name === 'template') {
      if (templates.length) issue('duplicate-template', 'Multiple Vue template blocks are invalid', cursor, true);
      templates.push({ start: tag.end, end: tag.selfClosing ? tag.end : -1 });
      if (tag.attributes.lang && tag.attributes.lang !== 'html' || tag.attributes.src || tag.dynamic) issue('unsupported-template', 'Template preprocessor/external/dynamic attributes require a framework profile', cursor);
    }
    if (!tag.selfClosing && !voidTags.has(tag.name)) stack.push(tag.name);
    cursor = tag.end;
  }
  if (blocks > 200_000) issue('markup-limit', 'Markup token budget exceeded', cursor, true);
  if (templates.some(template => template.end < 0)) issue('unclosed-template', 'Vue template has no closing block', text.length, true);
  if (language !== 'vue') templates.push({ start: templateStart, end: text.length });
  return { regions, templates, issues };
}
/** Identity offsets: masking preserves every UTF-16 position and line break.
 * Compiler-only module sentinels are outside the mapped interval. */
export function embeddedText(original: string, region: Pick<EmbeddedRegion, 'start' | 'end'>): string {
  const mask = (text: string) => text.replace(/[^\r\n\u2028\u2029]/g, ' ');
  return mask(original.slice(0, region.start)) + original.slice(region.start, region.end) + mask(original.slice(region.end)) + '\nexport {};\n';
}
export function mappedRange(region: Pick<EmbeddedRegion, 'start' | 'end'>, start: number, end: number): { start: number; end: number } | undefined {
  return start >= region.start && end >= start && end <= region.end ? { start, end } : undefined;
}
