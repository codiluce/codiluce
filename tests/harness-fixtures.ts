import type { HarnessId } from '../src/harnesses/registry.js';

/** Representative wire shapes modeled from the official references linked in the registry. */
export function nativeActivityFixture(id: HarnessId, cwd: string): Record<string, unknown> {
  const common = { session_id: 'session:one', cwd, hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: 'src/a.ts' }, tool_use_id: 'call:one' };
  switch (id) {
    case 'codex': case 'claude-code': return common;
    case 'cursor': return { conversation_id: 'session:one', workspace_roots: [cwd], hook_event_name: 'postToolUse', tool_name: 'Read', tool_input: { file_path: 'src/a.ts' }, tool_use_id: 'call:one' };
    case 'opencode': return { event: 'tool.execute.after', cwd, sessionID: 'session:one', callID: 'call:one', tool: 'read', args: { filePath: 'src/a.ts' } };
    case 'pi': return { event: 'tool_result', cwd, session_id: 'session:one', toolCallId: 'call:one', toolName: 'read', input: { path: 'src/a.ts' }, isError: false };
    case 'github-copilot': return { hook_event_name: 'postToolUse', sessionId: 'session:one', cwd, toolName: 'read_file', toolArgs: { path: 'src/a.ts' }, toolResult: { resultType: 'success' } };
    case 'gemini-cli': return { ...common, hook_event_name: 'AfterTool', tool_name: 'read_file' };
    case 'cline': return { hookName: 'PostToolUse', taskId: 'session:one', workspaceRoots: [cwd], postToolUse: { toolName: 'read_file', parameters: { path: 'src/a.ts' }, success: true } };
    case 'antigravity': return { codiluce_event: 'PostToolUse', conversationId: 'session:one', workspacePaths: [cwd], stepIdx: 3, toolCall: { name: 'view_file', args: { AbsolutePath: 'src/a.ts' } } };
    case 'windsurf': return { agent_action_name: 'post_read_code', trajectory_id: 'session:one', execution_id: 'turn:one', codiluce_cwd: cwd, tool_info: { file_path: 'src/a.ts' } };
    case 'openclaw': return { event: 'after_tool_call', cwd, context: { sessionId: 'session:one' }, data: { toolName: 'read', params: { path: 'src/a.ts' }, toolCallId: 'call:one' } };
    case 'hermes': return { ...common, hook_event_name: 'post_tool_call', tool_name: 'read_file', extra: { tool_call_id: 'call:one', status: 'success' } };
  }
}
