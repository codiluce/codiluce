import path from 'node:path';
import { realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { ActivityEvent, ActivityKind, ActivityPath, AgentProvider, AgentStatus } from './model.js';
import { shellInput } from './shell.js';

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown, max = 256): string => typeof value === 'string' ? value.slice(0, max) : '';
export const HOOK_EVENTS = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'SubagentStart', 'SubagentStop', 'Stop', 'Interrupt'] as const;

/** Deleted paths are checked through their nearest existing ancestor; symlink escapes are rejected. */
export function repositoryPath(root: string, cwd: string, value: string): string | undefined {
  if (!value || value.length > 4096 || value.includes('\0')) return undefined;
  const absolute = path.resolve(cwd, value);
  const within = (base: string, candidate: string) => { const rel = path.relative(base, candidate); return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel); };
  if (!within(root, absolute)) return undefined;
  let parent = absolute;
  for (;;) {
    try { if (!within(realpathSync(root), realpathSync(parent))) return undefined; break; }
    catch { const next = path.dirname(parent); if (next === parent) return undefined; parent = next; }
  }
  return path.relative(root, absolute).split(path.sep).join('/') || '.';
}

export function normalizeHook(root: string, provider: AgentProvider, payload: unknown, now = Date.now()): ActivityEvent | undefined {
  const body = object(payload), event = text(body.hook_event_name), sessionId = text(body.session_id);
  if (!sessionId || !HOOK_EVENTS.includes(event as typeof HOOK_EVENTS[number]) && event !== 'PostToolUseFailure') return undefined;
  const cwd = typeof body.cwd === 'string' ? path.resolve(body.cwd) : root;
  if (repositoryPath(root, root, cwd) === undefined) return undefined;
  const agentId = text(body.agent_id) || undefined;
  const actor = `${provider}:${sessionId}${agentId ? `:${agentId}` : ''}`;
  const tool = text(body.tool_name), original = object(body.tool_input);
  const command = text(original.command ?? original.cmd, 64 * 1024);
  const interpreted = ['Bash', 'exec_command', 'shell_command'].includes(tool) ? shellInput(command) : undefined;
  const name = interpreted?.tool ?? tool;
  const input: Record<string, unknown> = interpreted?.input ?? original;
  let kind: ActivityKind = 'status', label = event;
  const paths: ActivityPath[] = [];
  const workdir = typeof original.workdir === 'string' ? path.resolve(cwd, original.workdir) : cwd;
  const add = (value: unknown, scope: ActivityPath['scope']) => {
    if (typeof value !== 'string') return;
    const relative = repositoryPath(root, workdir, value);
    if (relative !== undefined && !paths.some(item => item.path === relative)) paths.push({ path: relative, scope });
  };
  const isTool = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest'].includes(event);
  if (isTool) {
    kind = 'command'; label = tool || 'Tool call';
    if (/^(Read|read_file)$/.test(name) || /__read_file$/.test(name)) { kind = 'read'; label = 'Read file'; add(input.file_path ?? input.path, 'file'); }
    else if (/^(Write|Edit|MultiEdit|write_file|edit_file|NotebookEdit)$/.test(name)) { kind = 'edit'; label = 'Edit file'; add(input.file_path ?? input.path ?? input.notebook_path, 'file'); }
    else if (/^(Grep|Glob|search|search_files)$/.test(name)) { kind = 'search'; label = name === 'Glob' ? 'Find files' : 'Search'; if (!Array.isArray(input.paths)) add(input.path ?? input.directory ?? '.', 'directory'); }
    else if (name === 'apply_patch') {
      kind = 'edit'; label = 'Apply patch';
      const patch = text(input.command ?? input.input ?? input.patch, 64 * 1024);
      for (const match of patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)) add(match[1], 'file');
    } else if (['Bash', 'exec_command', 'shell_command'].includes(name)) {
      const simple = !/[;|&><\n`$()]/.test(command);
      kind = simple && /^(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|(?:(?:python|python3)\s+-m\s+)?pytest\b|(?:npx\s+)?(?:vitest|jest|playwright)\b|(?:cargo|go)\s+test\b|node\s+[^\n]*--test\b)/.test(command.trim()) ? 'test' : 'command';
      label = kind === 'test' ? 'Run tests' : 'Run command';
    }
    if (Array.isArray(input.paths)) for (const item of input.paths.slice(0, 40)) add(item, kind === 'search' ? 'directory' : 'file');
  }
  const response = object(body.tool_response);
  const failed = event === 'PostToolUseFailure' || response.isError === true || typeof response.exit_code === 'number' && response.exit_code !== 0;
  let status: AgentStatus | undefined;
  if (event === 'PermissionRequest') status = 'waiting';
  else if (event === 'SessionEnd' || event === 'SubagentStop') status = 'finished';
  else if (event === 'Stop') status = 'idle';
  else if (event === 'Interrupt') status = 'interrupted';
  else status = failed ? 'error' : 'running';
  const phase = failed ? 'failed' : event === 'PostToolUse' ? 'completed' : isTool ? 'started' : 'status';
  const query = kind === 'search' ? text(input.pattern ?? input.query, 256) : '';
  const sessionTitle = text(body.session_title).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return { id: randomUUID(), at: now, provider, actor, sessionId, ...(agentId ? { agentId } : {}), ...(tool ? { tool } : {}), ...(text(body.tool_use_id) ? { toolId: text(body.tool_use_id) } : {}), kind, phase, label, paths: paths.slice(0, 40), ...(query ? { query } : {}), ...(sessionTitle ? { sessionTitle } : {}), status };
}
