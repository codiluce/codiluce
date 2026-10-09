import type { Node } from 'web-tree-sitter';
import type { DeclarationFact, RubyExpression, RubyScopeFact, RubySyntaxFacts } from '../facts.js';
import type { SourceText } from '../source-map.js';

/** Decode literal Ruby strings without evaluating interpolation, encodings,
 * shell literals or user conversion methods. Byte escapes must be valid UTF-8. */
function stringValue(text: string): string | undefined {
  const quote = text[0];
  let value: string, close: string, single: boolean;
  if (quote === "'" || quote === '"') { if (text.at(-1) !== quote) return; value = text.slice(1, -1); close = quote; single = quote === "'"; }
  else {
    const match = /^%(q|Q)([^\w\s])/.exec(text); if (!match) return;
    close = ({ '(': ')', '[': ']', '{': '}', '<': '>' } as Record<string, string>)[match[2]!] ?? match[2]!;
    if (text.at(-1) !== close) return; value = text.slice(3, -1); single = match[1] === 'q';
  }
  const bytes: number[] = [], add = (part: string) => bytes.push(...Buffer.from(part, 'utf8'));
  for (let i = 0; i < value.length; i++) {
    const char = value[i]!;
    if (char !== '\\') { const point = value.codePointAt(i)!; add(String.fromCodePoint(point)); if (point > 0xffff) i++; continue; }
    const escape = value[++i]; if (escape === undefined) return;
    if (single) { add(escape === '\\' || escape === close || quote === '%' && value[i] === text[2] ? escape : '\\' + escape); continue; }
    const basic: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', a: '\x07', e: '\x1b', s: ' ', '\n': '' };
    if (escape in basic) { add(basic[escape]!); continue; }
    if (/[0-7]/.test(escape)) { const octal = /^[0-7]{1,3}/.exec(value.slice(i))![0]; bytes.push(parseInt(octal, 8) & 255); i += octal.length - 1; continue; }
    if (escape === 'x') { const hex = /^[0-9a-fA-F]{1,2}/.exec(value.slice(i + 1)); if (!hex) return; bytes.push(parseInt(hex[0], 16)); i += hex[0].length; continue; }
    if (escape === 'u') {
      const fixed = /^[0-9a-fA-F]{4}/.exec(value.slice(i + 1)), group = /^\{([0-9a-fA-F]+(?:[ \t]+[0-9a-fA-F]+)*)\}/.exec(value.slice(i + 1));
      const points = fixed ? [parseInt(fixed[0], 16)] : group ? group[1]!.split(/[ \t]+/).map(point => parseInt(point, 16)) : undefined;
      if (!points || points.some(point => point > 0x10ffff || point >= 0xd800 && point <= 0xdfff)) return;
      for (const point of points) add(String.fromCodePoint(point)); i += fixed ? 4 : group![0].length; continue;
    }
    if (['c', 'C', 'M'].includes(escape)) return;
    add(escape);
  }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes)); } catch { return; }
}

export function extractRubySemantic(root: Node, declarations: DeclarationFact[], source: SourceText): { facts: RubySyntaxFacts; truncated: boolean } {
  const facts: RubySyntaxFacts = { scopes: [], definitions: [], calls: [], locals: [], assignments: [], references: [], gaps: [], complete: false };
  let visits = 0, truncated = false;
  const bySite = new Map(declarations.map(item => [`${item.start}:${item.end}`, item]));
  const site = (node: Node) => ({ start: node.startIndex, end: node.endIndex, range: source.range(node.startIndex, node.endIndex) });
  const children = (node: Node | undefined) => node?.namedChildren.filter(child => child.type !== 'comment') ?? [];
  const field = (node: Node, name: string) => node.childForFieldName(name) ?? undefined;
  const unknown = (node: Node): RubyExpression => ({ ...site(node), kind: 'unknown', text: node.text.slice(0, 200) });
  function expression(node: Node, depth = 0): RubyExpression {
    if (depth > 64) { truncated = true; return unknown(node); }
    switch (node.type) {
      case 'constant': case 'scope_resolution': return { ...site(node), kind: 'constant', name: node.text.replace(/\s+/g, '') };
      case 'identifier': case 'self': case 'global_variable': return { ...site(node), kind: 'identifier', name: node.text };
      case 'string': { if (node.descendantsOfType('interpolation').length) return unknown(node); const value = stringValue(node.text); return value === undefined ? unknown(node) : { ...site(node), kind: 'literal', value }; }
      case 'simple_symbol': return { ...site(node), kind: 'symbol', name: node.text.slice(1) };
      case 'true': case 'false': case 'nil': return { ...site(node), kind: 'literal', value: node.type === 'nil' ? null : node.type === 'true' };
      case 'integer': { const value = Number(node.text.replaceAll('_', '')); return Number.isSafeInteger(value) ? { ...site(node), kind: 'literal', value } : unknown(node); }
      case 'parenthesized_statements': { const values = children(node); return values.length === 1 ? expression(values[0]!, depth + 1) : unknown(node); }
      case 'array': return { ...site(node), kind: 'array', items: children(node).map(child => expression(child, depth + 1)) };
      case 'string_array': return { ...site(node), kind: 'array', items: children(node).map(child => child.type === 'bare_string' && !child.descendantsOfType('interpolation').length && !child.text.includes('\\') ? { ...site(child), kind: 'literal' as const, value: child.text } : unknown(child)) };
      case 'pair': { const key = field(node, 'key'), value = field(node, 'value'); return key && value ? { ...site(node), kind: 'hash', items: [{ key: expression(key, depth + 1), value: expression(value, depth + 1) }] } : unknown(node); }
      case 'hash': return { ...site(node), kind: 'hash', items: children(node).map(child => { const key = field(child, 'key'), value = field(child, 'value'); return key && value ? { key: expression(key, depth + 1), value: expression(value, depth + 1) } : { key: unknown(child), value: unknown(child) }; }) };
      case 'hash_key_symbol': return { ...site(node), kind: 'symbol', name: node.text.replace(/:$/, '') };
      case 'call': { const method = field(node, 'method'), receiver = field(node, 'receiver'); return method ? { ...site(node), kind: 'call', method: method.text, ...(receiver ? { receiver: expression(receiver, depth + 1) } : {}), args: children(field(node, 'arguments')).map(child => expression(child, depth + 1)) } : unknown(node); }
      case 'element_reference': { const object = field(node, 'object'); return object ? { ...site(node), kind: 'call', receiver: expression(object, depth + 1), method: '[]', args: children(node).filter(child => child.id !== object.id).map(child => expression(child, depth + 1)) } : unknown(node); }
      default: return unknown(node);
    }
  }
  function scope(node: Node, parent: string | undefined, kind: RubyScopeFact['kind'], details: Partial<RubyScopeFact> = {}): string {
    const key = `${kind}:${node.startIndex}:${node.endIndex}`;
    facts.scopes.push({ ...site(node), key, parent, kind, ...details }); return key;
  }
  const gap = (node: Node, current: string, kind: RubySyntaxFacts['gaps'][number]['kind'], reason: string) => facts.gaps.push({ ...site(node), scope: current, kind, reason });
  function parameters(node: Node | undefined, current: string): void {
    for (const parameter of children(node)) {
      const name = parameter.type === 'identifier' ? parameter : field(parameter, 'name');
      const names = parameter.type === 'destructured_parameter' ? parameter.descendantsOfType('identifier') : name?.type === 'identifier' ? [name] : [];
      for (const name of names) facts.locals.push({ ...site(name), scope: current, name: name.text, kind: parameter.type === 'identifier' && node && field(node, 'locals')?.id === parameter.id ? 'block_local' : 'parameter' });
      const value = field(parameter, 'value'); if (value) walk(value, current);
    }
  }
  let depth = 0;
  function walk(node: Node, current: string): void {
    if (++depth > 512) { depth--; truncated = true; return; }
    try { visit(node, current); } finally { depth--; }
  }
  function visit(node: Node, current: string): void {
    if (++visits > 200_000) { truncated = true; return; }
    if (['class', 'module', 'method', 'singleton_method'].includes(node.type)) {
      const name = field(node, 'name'), body = field(node, 'body'); if (!name) return;
      const declaration = bySite.get(`${node.startIndex}:${node.endIndex}`);
      const superclass = children(field(node, 'superclass'))[0], receiver = field(node, 'object');
      const inner = scope(node, current, node.type === 'singleton_method' ? 'method' : node.type as 'class' | 'module' | 'method', { name: name.text.replace(/\s+/g, ''), owner: declaration?.key, ...(node.type.includes('method') ? { deferred: true } : {}) });
      facts.definitions.push({ ...site(node), key: declaration?.key ?? `${node.startIndex}:${node.endIndex}:${node.type}`, kind: node.type as 'class' | 'module' | 'method' | 'singleton_method', name: name.text.replace(/\s+/g, ''), scope: current, bodyScope: inner, ...(superclass ? { superclass: expression(superclass) } : {}), ...(receiver ? { receiver: expression(receiver) } : {}) });
      if (superclass) walk(superclass, current);
      if (name.type === 'scope_resolution' && field(name, 'scope')) walk(field(name, 'scope')!, current);
      parameters(field(node, 'parameters'), inner);
      if (body) walk(body, inner); return;
    }
    if (node.type === 'singleton_class') { const inner = scope(node, current, 'singleton'); gap(node, inner, 'scope', 'Singleton-class lexical and loader context requires a receiver summary'); children(node).forEach(child => walk(child, inner)); return; }
    if (['block', 'do_block', 'lambda'].includes(node.type)) { const inner = scope(node, current, 'block', { deferred: true }); const params = field(node, 'parameters'); parameters(params, inner); children(node).filter(child => child.id !== params?.id).forEach(child => walk(child, inner)); return; }
    if (['if', 'unless', 'elsif', 'if_modifier', 'unless_modifier', 'case', 'case_match', 'in_clause', 'match_pattern', 'test_pattern', 'when', 'while', 'until', 'for', 'while_modifier', 'until_modifier', 'rescue', 'ensure', 'conditional', 'binary'].includes(node.type)) {
      if (node.type === 'binary' && children(node).some(child => child.type === 'global_variable' && ['$LOAD_PATH', '$:', '$LOADED_FEATURES', '$"'].includes(child.text))) gap(node, current, 'path', 'Ruby load path or loaded-feature binary operations require a state summary');
      const inner = scope(node, current, 'control', node.type !== 'binary' || ['and', 'or', '&&', '||'].includes(field(node, 'operator')?.text ?? '') ? { conditional: `${node.type} at line ${site(node).range.startLine}` } : {});
      const operator = field(node, 'operator')?.text, left = field(node, 'left'), right = field(node, 'right');
      if (node.type === 'binary' && operator && !['and', 'or', '&&', '||'].includes(operator) && left && right) facts.calls.push({ ...site(node), scope: inner, expression: { ...site(node), kind: 'call', receiver: expression(left), method: operator, args: [expression(right)] } });
      if (node.type === 'binary' && field(node, 'operator')?.text === '=~') for (const regex of node.namedChildren.filter(child => child.type === 'regex')) for (const capture of regex.text.matchAll(/\(\?<([\p{L}_][\p{L}\p{N}_]*)>/gu)) facts.locals.push({ ...site(regex), scope: inner, name: capture[1]!, kind: 'write' });
      const pattern = field(node, 'pattern') ?? field(node, 'variable');
      if (pattern) for (const target of [...pattern.type === 'identifier' ? [pattern] : pattern.descendantsOfType('identifier'), ...pattern.descendantsOfType('hash_key_symbol')]) facts.locals.push({ ...site(target), scope: inner, name: target.text.replace(/:$/, ''), kind: 'write' });
      children(node).filter(child => child.id !== pattern?.id).forEach(child => walk(child, inner)); return;
    }
    if (['assignment', 'operator_assignment', 'multiple_assignment'].includes(node.type)) {
      const left = field(node, 'left'), right = field(node, 'right');
      if (left && right) { const target = expression(left); facts.assignments.push({ ...site(node), scope: current, target, value: expression(right), ...(node.type !== 'assignment' ? { augmentation: true } : {}) }); if (target.kind === 'call') facts.calls.push({ ...site(node), scope: current, expression: { ...target, ...site(node), method: target.method + '=', args: [...target.args, expression(right)] } }); for (const target of left.type === 'identifier' ? [left] : left.type === 'left_assignment_list' ? left.descendantsOfType('identifier') : []) facts.locals.push({ ...site(target), scope: current, name: target.text, kind: 'write' }); if (left.text.includes('$LOAD_PATH') || left.text.includes('$:') || left.text.includes('$LOADED_FEATURES') || left.text.includes('$"')) gap(node, current, 'path', 'Ruby load path or loaded-feature state is reassigned'); walk(right, current); }
      else children(node).forEach(child => walk(child, current)); return;
    }
    if (['alias', 'undef'].includes(node.type)) { gap(node, current, 'loader', node.type === 'alias' ? 'Ruby method aliases can replace loader identity' : 'Ruby undef can remove loader method identity'); return; }
    if (node.type === 'call') {
      const value = expression(node);
      if (value.kind === 'call') {
        const block = field(node, 'block');
        facts.calls.push({ ...site(node), scope: current, expression: value, ...(block ? { blockScope: `block:${block.startIndex}:${block.endIndex}` } : {}), ...(node.children.some(child => child.type === '&.') ? { safeNavigation: true } : {}) });
        const receiver = field(node, 'receiver');
        if (receiver?.text.includes('$LOAD_PATH') || receiver?.text.includes('$:') || receiver?.text.includes('$LOADED_FEATURES') || receiver?.text.includes('$"')) gap(node, current, 'path', 'Ruby load path or loaded-feature operations require a state summary');
        if (value.receiver?.kind === 'constant' && ['Dir', '::Dir', 'FileUtils', '::FileUtils'].includes(value.receiver.name) && ['chdir', 'cd'].includes(value.method)) gap(node, current, 'path', 'Ruby working-directory changes require a recorded runtime state summary');
        if (['const_set', 'remove_const', 'private_constant', 'const_missing', 'class_eval', 'module_eval', 'instance_eval', 'eval', 'define_method', 'define_singleton_method', 'remove_method', 'undef_method', 'alias_method'].includes(value.method)) gap(node, current, ['const_set', 'remove_const', 'private_constant', 'const_missing'].includes(value.method) ? 'constants' : 'loader', `Ruby ${value.method} requires a runtime namespace/method summary`);
      }
      children(node).filter(child => child.id !== field(node, 'method')?.id).forEach(child => walk(child, current)); return;
    }
    if (['super', 'yield', 'element_reference'].includes(node.type)) { const value = expression(node); facts.calls.push({ ...site(node), scope: current, expression: value.kind === 'call' ? value : { ...site(node), kind: 'call', method: node.type, args: children(field(node, 'arguments')).map(child => expression(child)) } }); children(node).forEach(child => walk(child, current)); return; }
    if (['constant', 'scope_resolution'].includes(node.type)) { const value = expression(node); if (value.kind === 'constant') facts.references.push({ ...site(node), expression: value, scope: current }); return; }
    if (node.type === 'identifier' && !['__FILE__', '__LINE__', '__ENCODING__'].includes(node.text)) { facts.calls.push({ ...site(node), scope: current, bare: true, expression: { ...site(node), kind: 'call', method: node.text, args: [] } }); return; }
    children(node).forEach(child => walk(child, current));
  }
  walk(root, scope(root, undefined, 'file'));
  facts.complete = !truncated && !root.hasError;
  return { facts, truncated };
}
