import ts from 'typescript';
import { parse as parseToml } from 'smol-toml';
import { parseDocument } from 'yaml';
import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ConfigFormat } from './registry.js';

export const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
export function valueAt(value: unknown, keys: readonly string[]): unknown { return keys.reduce<unknown>((item, key) => record(item)[key], value); }

/** JSON/JSONC/JSON5 data only. Never evaluate a config or permit executable expressions. */
function jsonTree(text: string): { root: ts.ObjectLiteralExpression; file: ts.JsonSourceFile; data: Record<string, unknown> } {
  const file = ts.parseJsonText('settings.json', text);
  if ((file as ts.JsonSourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length) throw new Error('Invalid JSON configuration');
  const root = (file.statements[0] as ts.ExpressionStatement | undefined)?.expression;
  if (!root || !ts.isObjectLiteralExpression(root)) throw new Error('Configuration must be an object');
  const read = (node: ts.Expression): unknown => {
    if (ts.isObjectLiteralExpression(node)) {
      const out: Record<string, unknown> = Object.create(null);
      for (const prop of node.properties) {
        if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name) && !ts.isStringLiteral(prop.name) && !ts.isNumericLiteral(prop.name)) throw new Error('Unsupported configuration property');
        if (Object.hasOwn(out, prop.name.text)) throw new Error(`Duplicate configuration property: ${prop.name.text}`);
        out[prop.name.text] = read(prop.initializer);
      }
      return out;
    }
    if (ts.isArrayLiteralExpression(node)) return node.elements.map(item => read(item as ts.Expression));
    if (ts.isStringLiteral(node)) return node.text;
    if (ts.isNumericLiteral(node)) return Number(node.text);
    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(node.operand)) return -Number(node.operand.text);
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (node.kind === ts.SyntaxKind.NullKeyword) return null;
    throw new Error('Configuration contains a non-data expression');
  };
  return { root, file, data: record(read(root)) };
}

export function parseConfiguration(text: string, format: ConfigFormat): Record<string, unknown> {
  if (!text.trim()) return {};
  if (format === 'toml') return record(parseToml(text));
  if (format === 'yaml') {
    const doc = parseDocument(text);
    if (doc.errors.length) throw new Error(`Invalid YAML configuration: ${doc.errors[0]!.message}`);
    const result: unknown = doc.toJS({ maxAliasCount: 100 });
    if (!result || Array.isArray(result) || typeof result !== 'object') throw new Error('Configuration must be an object');
    return record(result);
  }
  return jsonTree(text).data;
}

function property(node: ts.ObjectLiteralExpression, key: string): ts.PropertyAssignment | undefined {
  return node.properties.find((prop): prop is ts.PropertyAssignment => ts.isPropertyAssignment(prop) && (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) || ts.isNumericLiteral(prop.name)) && prop.name.text === key);
}
function jsonEdit(text: string, keys: readonly string[], value: unknown, append = false): string {
  text = text.trim() ? text : '{}\n';
  const tree = jsonTree(text);
  let node: ts.Expression = tree.root;
  const insert = (container: ts.ObjectLiteralExpression | ts.ArrayLiteralExpression, content: string) => {
    const items = ts.isObjectLiteralExpression(container) ? container.properties : container.elements;
    const last = items.at(-1), comma = last && !items.hasTrailingComma ? ',' : '';
    const prefix = comma ? text.slice(0, last!.end) + comma + text.slice(last!.end, container.end - 1) : text.slice(0, container.end - 1);
    return `${prefix}\n${content}\n${text.slice(container.end - 1)}`;
  };
  for (let index = 0; index < keys.length; index++) {
    if (!ts.isObjectLiteralExpression(node)) throw new Error(`Expected an object at ${keys.slice(0, index).join('.')}`);
    const prop = property(node, keys[index]!);
    if (prop) {
      node = prop.initializer;
      if (index !== keys.length - 1) continue;
      if (append) {
        if (!ts.isArrayLiteralExpression(node)) throw new Error(`Expected an array at ${keys.join('.')}`);
        const items = value as unknown[];
        if (!items.length) return text;
        return insert(node, items.map(item => JSON.stringify(item, null, 2)).join(',\n'));
      }
      return text.slice(0, node.getStart(tree.file)) + JSON.stringify(value, null, 2) + text.slice(node.end);
    }
    let subtree = value;
    for (const key of keys.slice(index + 1).reverse()) subtree = { [key]: subtree };
    return insert(node, `${JSON.stringify(keys[index])}: ${JSON.stringify(subtree, null, 2)}`);
  }
  throw new Error('A configuration key is required');
}

function tomlEdit(text: string, keys: readonly string[], value: unknown): string {
  parseConfiguration(text, 'toml');
  const section = keys.slice(0, -1).join('.'), key = keys.at(-1)!;
  if (!/^[\w.-]+$/.test(section) || !/^\w+$/.test(key)) throw new Error('Unsupported TOML key');
  const escaped = section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const header = new RegExp(`^\\[${escaped}\\][ \\t]*(?:#.*)?$`, 'm').exec(text);
  if (!header) {
    const existing = valueAt(parseConfiguration(text, 'toml'), keys.slice(0, -1));
    if (existing !== undefined) throw new Error('This TOML uses an inline or quoted server table. Edit the supplied MCP snippet into that table manually.');
    return `${text.trimEnd()}\n\n[${section}]\n${key} = ${JSON.stringify(value)}\n`;
  }
  const start = header.index + header[0].length;
  const tail = text.slice(start), boundary = /^[ \t]*\[[\w."' -]+\][ \t]*(?:#.*)?$/m.exec(tail), end = boundary ? start + boundary.index : text.length;
  const body = text.slice(start, end), match = new RegExp(`^([ \\t]*${key}[ \\t]*=[ \\t]*)(.*)$`, 'm').exec(body);
  if (!match) return text.slice(0, end) + `${body.endsWith('\n') ? '' : '\n'}${key} = ${JSON.stringify(value)}\n` + text.slice(end);
  const valueStart = start + match.index + match[1]!.length;
  let valueEnd = text.indexOf('\n', valueStart); if (valueEnd < 0 || valueEnd > end) valueEnd = end;
  for (;;) {
    try { parseToml(`value = ${text.slice(valueStart, valueEnd)}`); break; }
    catch { const following = text.indexOf('\n', valueEnd + 1); if (following < 0 || following > end) throw new Error('Cannot safely update this TOML value'); valueEnd = following; }
  }
  return text.slice(0, valueStart) + JSON.stringify(value) + text.slice(valueEnd);
}

/** Change only the requested value; comments and unrelated settings stay in place. */
export function editConfiguration(text: string, format: ConfigFormat, keys: readonly string[], value: unknown, append = false): string {
  const before = parseConfiguration(text, format), previous = valueAt(before, keys);
  if (!append && JSON.stringify(previous) === JSON.stringify(value)) return text;
  let result: string;
  if (format === 'jsonc') result = jsonEdit(text, keys, value, append);
  else if (format === 'toml') result = tomlEdit(text, keys, value);
  else {
    const doc = parseDocument(text || '{}\n');
    if (doc.errors.length) throw new Error('Invalid YAML configuration');
    if (append && previous !== undefined && !Array.isArray(previous)) throw new Error(`Expected an array at ${keys.join('.')}`);
    if (append && Array.isArray(previous)) for (const item of value as unknown[]) doc.addIn(keys, item);
    else doc.setIn(keys, value);
    result = doc.toString();
  }
  parseConfiguration(result, format);
  return result.endsWith('\n') ? result : `${result}\n`;
}

/** Replace only an owned array item; preserve the source of every unrelated item/comment. */
export function upsertConfigurationItems(text: string, format: 'jsonc' | 'yaml', keys: readonly string[], values: unknown[], owned: (value: unknown) => boolean): string {
  const existing = valueAt(parseConfiguration(text, format), keys);
  if (existing !== undefined && !Array.isArray(existing)) throw new Error(`Expected an array at ${keys.join('.')}`);
  if (!Array.isArray(existing)) return editConfiguration(text, format, keys, values);
  const indices = existing.flatMap((entry, index) => owned(entry) ? [index] : []);
  if (!indices.length) return editConfiguration(text, format, keys, values, true);
  if (indices.length === values.length && indices.every((index, ordinal) => JSON.stringify(existing[index]) === JSON.stringify(values[ordinal]))) return text;
  if (format === 'yaml') {
    const doc = parseDocument(text);
    for (const index of [...indices].reverse()) doc.deleteIn([...keys, index]);
    for (const value of values) doc.addIn(keys, value);
    return doc.toString();
  }
  const tree = jsonTree(text);
  let node: ts.Expression = tree.root;
  for (const key of keys) {
    if (!ts.isObjectLiteralExpression(node)) throw new Error('Invalid hook array location');
    const found = property(node, key); if (!found) throw new Error('Missing hook array'); node = found.initializer;
  }
  if (!ts.isArrayLiteralExpression(node)) throw new Error('Invalid hook array');
  // Replace the first owned slot and remove surplus owned slots in reverse order.
  for (const index of indices.slice(1).reverse()) {
    const item = node.elements[index]!, previous = node.elements[index - 1], next = node.elements[index + 1];
    let start = item.getStart(tree.file), end = item.end;
    if (next || node.elements.hasTrailingComma) {
      const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, text, undefined, end);
      if (scanner.scan() === ts.SyntaxKind.CommaToken) end = scanner.getTextPos();
    } else if (previous) {
      const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, text, undefined, previous.end);
      if (scanner.scan() === ts.SyntaxKind.CommaToken) { const commaStart = scanner.getTokenPos(), commaEnd = scanner.getTextPos(); text = text.slice(0, start) + text.slice(end); text = text.slice(0, commaStart) + text.slice(commaEnd); continue; }
    }
    text = text.slice(0, start) + text.slice(end);
  }
  // The first item's offsets are before every deletion and therefore unchanged.
  const first = node.elements[indices[0]!]!;
  const result = text.slice(0, first.getStart(tree.file)) + values.map(value => JSON.stringify(value, null, 2)).join(',\n') + text.slice(first.end);
  jsonTree(result);
  return result;
}

export async function readConfiguration(file: string, format: ConfigFormat): Promise<{ text: string; data: Record<string, unknown> }> {
  let text: string;
  try { const info = await lstat(file); if (info.isSymbolicLink() || !info.isFile() || info.size > 2 * 1024 * 1024) throw new Error(`Refusing unsafe or oversized config: ${file}`); text = await readFile(file, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') text = ''; else throw error; }
  return { text, data: parseConfiguration(text, format) };
}

/** Compare the preview against disk before applying; never clobber a concurrent edit. */
export async function writeReviewedFile(file: string, before: string, after: string, executable = false): Promise<void> {
  let current = '';
  try { const info = await lstat(file); if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Refusing non-file destination: ${file}`); current = await readFile(file, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (current !== before) throw new Error(`Configuration changed since preview: ${file}`);
  if (current === after) return;
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.codiluce-${randomUUID()}.tmp`;
  await writeFile(temporary, after, { mode: executable ? 0o700 : 0o600, flag: 'wx' });
  await rename(temporary, file);
}
