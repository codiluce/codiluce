import { normalizeHook, repositoryPath } from '../activity/normalize.js';
import type { ConversationPath, FileAction } from './model.js';

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Read a small, literal JS value. No evaluation, variable lookup, or interpolation. */
function literal(code: string, start: number): { value: unknown; end: number } | undefined {
  let i = start, depth = 0;
  const space = () => { while (/\s/.test(code[i] ?? '') && i < code.length) i++; };
  const read = (): unknown => {
    if (++depth > 12) throw new Error('Nested literal');
    space(); const quote = code[i]; let value: unknown;
    if (quote === '"' || quote === "'" || quote === '`') {
      i++; let text = '', closed = false;
      while (i < code.length) {
        const c = code[i++]!;
        if (c === quote) { closed = true; break; }
        if (quote === '`' && c === '$' && code[i] === '{') throw new Error('Interpolation');
        if (c === '\\') {
          const next = code[i++];
          if (next === undefined) throw new Error('Unclosed escape');
          if (next === 'u') { const hex = code.slice(i, i + 4); if (!/^[\da-f]{4}$/i.test(hex)) throw new Error('Escape'); text += String.fromCharCode(parseInt(hex, 16)); i += 4; }
          else text += ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' } as Record<string, string>)[next] ?? next;
        } else text += c;
      }
      if (!closed) throw new Error('Unclosed string'); value = text;
    } else if (quote === '{' || quote === '[') {
      const array = quote === '['; i++; const result: unknown[] | Record<string, unknown> = array ? [] : Object.create(null); space();
      while (code[i] !== (array ? ']' : '}')) {
        if (i >= code.length) throw new Error('Unclosed literal');
        if (array) (result as unknown[]).push(read());
        else {
          space(); let key: string;
          if (code[i] === '"' || code[i] === "'") key = String(read());
          else { const match = /^[A-Za-z_$][\w$]*/.exec(code.slice(i)); if (!match) throw new Error('Key'); key = match[0]; i += key.length; }
          space(); if (code[i++] !== ':') throw new Error('Not a literal object');
          (result as Record<string, unknown>)[key] = read();
        }
        space(); if (code[i] === ',') { i++; space(); } else if (code[i] !== (array ? ']' : '}')) throw new Error('Expression');
      }
      i++; value = result;
    } else {
      const match = /^(?:true|false|null|-?\d+(?:\.\d+)?)(?![\w.])/.exec(code.slice(i));
      if (!match) throw new Error('Expression'); value = JSON.parse(match[0]); i += match[0].length;
    }
    depth--; return value;
  };
  try { return { value: read(), end: i }; } catch { return undefined; }
}

/** Extract only literal tool calls in Codex's JS orchestration wrapper. */
export function nestedCalls(code: string): { name: string; input: unknown }[] {
  const calls: { name: string; input: unknown }[] = [];
  // Skip strings and comments so sample code and quoted tool names aren't observations.
  for (let i = 0; i < Math.min(code.length, 1024 * 1024); i++) {
    if (['"', "'", '`'].includes(code[i]!)) { const value = literal(code, i); if (value) { i = value.end - 1; continue; } break; }
    if (code.slice(i, i + 2) === '//') { i = code.indexOf('\n', i); if (i < 0) break; continue; }
    if (code.slice(i, i + 2) === '/*') { const end = code.indexOf('*/', i + 2); if (end < 0) break; i = end + 1; continue; }
    if (!code.startsWith('tools.', i) || i > 0 && /[\w.$]/.test(code[i - 1]!)) continue;
    const match = /^(?:tools\.)((?:[\w]+__)?(?:exec_command|apply_patch|read_file|write_file))\s*\(/.exec(code.slice(i));
    if (!match) continue;
    const parsed = literal(code, i + match[0].length);
    if (parsed) { calls.push({ name: match[1]!, input: parsed.value }); i = parsed.end - 1; }
  }
  return calls;
}

export function toolPaths(root: string, cwd: string, name: string, raw: unknown): Omit<ConversationPath, 'messageId' | 'callId' | 'status'>[] {
  const input = record(raw), results: Omit<ConversationPath, 'messageId' | 'callId' | 'status'>[] = [];
  const add = (value: unknown, action: FileAction, scope: 'file' | 'directory' = 'file', base = cwd) => {
    if (typeof value !== 'string') return;
    const relative = repositoryPath(root, base, value);
    if (relative !== undefined && !results.some(p => p.path === relative && p.action === action && p.scope === scope)) results.push({ path: relative, action, scope });
  };
  const tool = name.replace(/^.*(?:__|\.)/, '');
  if (tool === 'exec') {
    for (const call of nestedCalls(typeof raw === 'string' ? raw : String(input.code ?? ''))) results.push(...toolPaths(root, cwd, call.name, call.input));
  } else if (/^(Read|read_file)$/.test(tool)) {
    add(input.file_path ?? input.path, 'read');
  } else if (/^(Write|Edit|MultiEdit|write_file|edit_file|NotebookEdit)$/.test(tool)) {
    add(input.file_path ?? input.path ?? input.notebook_path, 'edited');
  } else if (/^(list_directory|list_files)$/.test(tool)) {
    add(input.path ?? input.directory ?? '.', 'read', 'directory');
  } else if (tool === 'apply_patch') {
    const patch = typeof raw === 'string' ? raw : String(input.patch ?? input.input ?? input.command ?? '');
    for (const match of patch.matchAll(/^\*\*\* (Add File|Update File|Delete File|Move to): (.+)\r?$/gm)) add(match[2]!.trim(), match[1] === 'Add File' ? 'added' : 'edited');
  } else if (/^(Bash|exec_command|shell_command)$/.test(tool)) {
    // Share the live feed's conservative shell interpretation; never execute the command.
    const observed = normalizeHook(root, 'codex', { cwd, session_id: 'history-import', hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input });
    if (observed?.kind === 'read') for (const target of observed.paths) add(target.path, 'read', target.scope, root);
  }
  return results;
}
