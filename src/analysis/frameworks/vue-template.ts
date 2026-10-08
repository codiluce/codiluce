import ts from 'typescript';
import { tagAt, expressionEnd } from '../embedded/source.js';

export interface VueTemplateSite { kind: 'component' | 'expression' | 'event' | 'gap'; start: number; end: number; name?: string; reason?: string; locals: string[] }
const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
function bindingNames(text: string): string[] | undefined {
  const source = ts.createSourceFile('binding.ts', `const ${text.trim()} = value;`, ts.ScriptTarget.Latest, true);
  if ((source as ts.SourceFile & { parseDiagnostics: ts.Diagnostic[] }).parseDiagnostics.length || source.statements.length !== 1 || !ts.isVariableStatement(source.statements[0]!)) return undefined;
  const names: string[] = [];
  const add = (node: ts.BindingName): void => { if (ts.isIdentifier(node)) names.push(node.text); else for (const item of node.elements) if (ts.isBindingElement(item)) add(item.name); };
  const declarations = source.statements[0]!.declarationList.declarations;
  if (declarations.length !== 1) return undefined; add(declarations[0]!.name); return names;
}
/** HTML and Vue expressions share the original UTF-16 coordinates. Local
 * loops/slots and v-pre are tracked before any script binding is considered. */
export function vueTemplateSites(text: string, start: number, end: number): VueTemplateSite[] {
  const sites: VueTemplateSite[] = [], stack: { name: string; locals: string[]; skip: boolean }[] = [];
  let cursor = start, steps = 0;
  const localNames = () => [...new Set(stack.flatMap(item => item.locals))];
  const add = (site: Omit<VueTemplateSite, 'locals'>, locals = localNames()) => sites.push({ ...site, locals });
  while (cursor < end && ++steps <= 100_000 && sites.length < 2_000) {
    if (text.startsWith('<!--', cursor)) { const close = text.indexOf('-->', cursor + 4); cursor = close < 0 ? end : close + 3; continue; }
    if (text.startsWith('<![CDATA[', cursor)) { const close = text.indexOf(']]>', cursor + 9); cursor = close < 0 ? end : close + 3; continue; }
    if (text.startsWith('{{', cursor)) {
      const close = expressionEnd(text, cursor + 1);
      if (!close || text[close] !== '}') { add({ kind: 'gap', start: cursor, end: cursor + 2, reason: 'Malformed or over-budget interpolation' }); break; }
      if (!stack.some(item => item.skip)) add({ kind: 'expression', start: cursor + 2, end: close - 1 }); cursor = close + 1; continue;
    }
    if (text[cursor] !== '<') { cursor++; continue; }
    const tag = tagAt(text, cursor); if (!tag || tag.end > end) { cursor++; continue; }
    if (tag.closing) { const index = stack.map(item => item.name).lastIndexOf(tag.name); if (index >= 0) stack.length = index; cursor = tag.end; continue; }
    if (['script', 'style'].includes(tag.name)) { const closing = new RegExp(`</${tag.name}\\s*>`, 'gi'); closing.lastIndex = tag.end; const found = !tag.selfClosing && closing.exec(text); cursor = found ? found.index + found[0].length : tag.end; continue; }
    const locals = localNames(); let skip = stack.some(item => item.skip) || Object.hasOwn(tag.attributes, 'v-pre');
    const loop = tag.attributes['v-for'];
    if (!skip && typeof loop === 'string') {
      const left = /^(.*?)\s+(?:in|of)\s+([\s\S]+)$/.exec(loop)?.[1]?.trim();
      const names = left?.startsWith('(') && left.endsWith(')') ? left.slice(1, -1).split(',').flatMap(part => bindingNames(part) ?? []) : left ? bindingNames(left) : undefined;
      if (!names?.length) { skip = true; add({ kind: 'gap', start: cursor, end: tag.end, reason: 'Unresolved v-for scope' }); } else locals.push(...names);
    }
    for (const attribute of tag.sites) if (/^(?:v-slot(?::|$)|#)/.test(attribute.name) && attribute.valueStart !== undefined && !skip) {
      const names = bindingNames(text.slice(attribute.valueStart, attribute.valueEnd));
      if (!names) { skip = true; add({ kind: 'gap', start: attribute.start, end: attribute.end, reason: 'Unresolved slot scope' }); } else locals.push(...names);
    }
    if (!skip) {
      add({ kind: 'component', name: tag.rawName, start: cursor, end: tag.end }, locals);
      if (tag.name === 'component' || Object.hasOwn(tag.attributes, 'is') || Object.hasOwn(tag.attributes, ':is') || Object.hasOwn(tag.attributes, 'v-bind:is')) add({ kind: 'gap', start: cursor, end: tag.end, reason: 'Dynamic component selection requires a separate profile' }, locals);
      for (const attribute of tag.sites) {
        if (attribute.valueStart === undefined || attribute.valueEnd === undefined) continue;
        const name = attribute.name, valueStart = attribute.valueStart, valueEnd = attribute.valueEnd;
        if (name.startsWith('@') || name.startsWith('v-on:')) {
          const event = name.replace(/^@|^v-on:/, '').split('.')[0]!;
          if (!/^[\w:-]+$/.test(event)) add({ kind: 'gap', start: attribute.start, end: attribute.end, reason: 'Dynamic event names are not statically bound' }, locals);
          else add({ kind: 'event', name: event, start: valueStart, end: valueEnd }, locals);
        } else if (name === 'v-on' || name === 'v-bind') add({ kind: 'gap', start: attribute.start, end: attribute.end, reason: 'Object directive binding needs a separate profile' }, locals);
        else if (name.startsWith(':') || name.startsWith('v-bind:') || ['v-if', 'v-else-if', 'v-show', 'v-text', 'v-html', 'v-model'].includes(name)) add({ kind: 'expression', start: valueStart, end: valueEnd }, locals);
      }
    }
    const raw = ['script', 'style', 'textarea', 'title'].includes(tag.name);
    if (raw && !tag.selfClosing) { const closing = new RegExp(`</${tag.name}\\s*>`, 'gi'); closing.lastIndex = tag.end; const found = closing.exec(text); cursor = found ? found.index + found[0].length : end; continue; }
    if (!tag.selfClosing && !voidTags.has(tag.name)) stack.push({ name: tag.name, locals, skip: skip || Object.hasOwn(tag.attributes, 'v-html') });
    cursor = tag.end;
  }
  if (steps > 100_000 || sites.length >= 2_000) add({ kind: 'gap', start: cursor, end: cursor, reason: 'Template analysis budget exceeded' });
  return sites;
}
