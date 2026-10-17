import path from 'node:path';
import type { HarnessId } from './registry.js';

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown): string => typeof value === 'string' ? value : '';
const oneRoot = (value: unknown): unknown => Array.isArray(value) && value.length === 1 ? value[0] : undefined;

const EVENTS: Record<string, string> = {
  sessionStart: 'SessionStart', sessionEnd: 'SessionEnd', userPromptSubmitted: 'UserPromptSubmit',
  preToolUse: 'PreToolUse', postToolUse: 'PostToolUse', postToolUseFailure: 'PostToolUseFailure',
  agentStop: 'Stop', stop: 'Stop', subagentStart: 'SubagentStart', subagentStop: 'SubagentStop', errorOccurred: 'RuntimeError',
  BeforeAgent: 'UserPromptSubmit', AfterAgent: 'Stop', BeforeTool: 'PreToolUse', AfterTool: 'PostToolUse',
  TaskStart: 'SessionStart', TaskResume: 'SessionStart', TaskComplete: 'Stop', TaskCancel: 'Interrupt', TaskError: 'RuntimeError', SessionShutdown: 'SessionEnd',
  session_start: 'SessionStart', session_shutdown: 'SessionEnd', agent_start: 'UserPromptSubmit', agent_settled: 'Stop', tool_call: 'PreToolUse', tool_result: 'PostToolUse',
  'tool.execute.before': 'PreToolUse', 'tool.execute.after': 'PostToolUse', 'session.created': 'SessionStart', 'session.idle': 'Stop', 'session.error': 'RuntimeError',
  pre_user_prompt: 'UserPromptSubmit', post_cascade_response: 'Stop', pre_read_code: 'PreToolUse', post_read_code: 'PostToolUse', pre_write_code: 'PreToolUse', post_write_code: 'PostToolUse', pre_run_command: 'PreToolUse', post_run_command: 'PostToolUse', pre_mcp_tool_use: 'PreToolUse', post_mcp_tool_use: 'PostToolUse',
  PreInvocation: 'UserPromptSubmit',
  before_tool_call: 'PreToolUse', after_tool_call: 'PostToolUse', agent_end: 'Stop', session_end: 'SessionEnd',
  on_session_start: 'SessionStart', pre_llm_call: 'UserPromptSubmit', pre_tool_call: 'PreToolUse', post_tool_call: 'PostToolUse', post_llm_call: 'Stop', on_session_finalize: 'SessionEnd', subagent_stop: 'SubagentStop',
};

/** Explicit tool vocabularies; unknown names stay unattributed commands. */
export function toolObservation(tool: string, raw: unknown): { name: string; input: Record<string, unknown> } {
  const args = object(raw);
  const input = { ...args };
  input.file_path = args.file_path ?? args.filePath ?? args.path ?? args.absolute_path ?? args.AbsolutePath ?? args.TargetFile ?? args.target_file ?? args.FilePath;
  input.path = args.path ?? args.directory ?? args.dir_path ?? args.Path ?? args.SearchDirectory ?? args.SearchPath ?? args.TargetDirectory;
  input.command = args.command ?? args.cmd ?? args.command_line ?? args.CommandLine;
  input.workdir = args.workdir ?? args.cwd ?? args.working_directory ?? args.Cwd;
  input.pattern = args.pattern ?? args.query ?? args.regex ?? args.SearchTerm ?? args.Query ?? args.Pattern;
  const key = tool.toLowerCase();
  const name = ['read', 'view', 'readfile', 'read_file', 'view_file', 'read_code', 'readtextfile', 'read_text_file'].includes(key) ? 'Read'
    : ['write', 'create', 'edit', 'write_file', 'edit_file', 'write_to_file', 'replace_file_content', 'multi_replace_file_content', 'str_replace', 'replace', 'replace_in_file', 'delete_file', 'remove_file', 'fs_write', 'fs_append'].includes(key) ? 'Edit'
    : ['grep', 'glob', 'search', 'search_files', 'grep_search', 'find_by_name', 'find', 'ls', 'list', 'list_files', 'list_directory', 'list_dir', 'glob_search', 'file_search', 'text_search'].includes(key) ? 'Grep'
    : ['bash', 'shell', 'powershell', 'terminal', 'run_command', 'run_shell_command', 'execute_command', 'exec', 'exec_command', 'shell_command', 'execute_bash', 'execute_pwsh'].includes(key) ? 'Bash'
    : tool;
  if (['apply_diff', 'patch'].includes(key) && input.file_path) return { name: 'Edit', input };
  if (name === 'Bash') input.workdir ??= args.dir_path;
  return { name, input };
}

/** Adapt native payloads to the small hook vocabulary consumed by shared normalization. */
export function decodeActivity(provider: HarnessId, payload: unknown): Record<string, unknown> | undefined {
  const body = object(payload), context = object(body.context), extra = object(body.extra);
  let event = string(body.hook_event_name ?? body.hookName ?? body.event ?? body.agent_action_name ?? body.codiluce_event);
  let session = body.session_id ?? body.sessionId;
  let cwd = body.cwd;
  let tool = body.tool_name ?? body.toolName;
  let input: unknown = body.tool_input ?? body.toolArgs;
  let call = body.tool_use_id ?? body.toolCallId;
  let child = body.agent_id;
  let parent = body.parent_session_id;
  let turn = body.turn_id ?? body.turnId;
  let response: unknown = body.tool_response ?? body.tool_result ?? body.toolResult;
  let title = body.session_title;
  let failed = body.success === false;

  if (provider === 'cursor') {
    session = body.conversation_id ?? session;
    cwd ??= oneRoot(body.workspace_roots);
    turn ??= body.generation_id;
    // Only a unique child conversation ID is an instance identity.
    if (event === 'subagentStop') { child = body.child_conversation_id ?? body.subagent_id; parent = session; }
    else child = body.agent_id ?? body.child_conversation_id;
    failed ||= body.status === 'error' || event === 'postToolUseFailure';
  } else if (provider === 'github-copilot') {
    input ??= body.tool_input;
    tool ??= body.tool_name;
    child ??= body.agentId;
    failed ||= !!body.error;
  } else if (provider === 'gemini-cli') {
    response ??= body.tool_response;
    if (event === 'Notification') {
      if (body.notification_type !== 'ToolPermission' && body.notification_type !== 'permission_prompt') return undefined;
      event = 'PermissionRequest';
    }
  } else if (provider === 'cline') {
    const detail = object(body.preToolUse ?? body.postToolUse ?? body.data);
    session ??= body.taskId;
    cwd ??= oneRoot(body.workspaceRoots);
    tool ??= detail.toolName;
    input ??= detail.parameters ?? body.input;
    response ??= detail.result ?? body.result;
    call ??= detail.toolCallId ?? body.tool_call_id;
    failed ||= detail.success === false || body.isError === true;
  } else if (provider === 'antigravity') {
    const detail = object(body.toolCall);
    session = body.conversationId;
    cwd ??= oneRoot(body.workspacePaths);
    tool = detail.name;
    input = detail.args;
    response = body.toolResult ?? body.result;
    call = detail.id ?? body.toolCallId ?? (Number.isSafeInteger(body.stepIdx) ? `step:${body.stepIdx}` : undefined);
    failed ||= !!body.error || body.terminationReason === 'error';
    if (event === 'Stop' && body.fullyIdle === false) event = 'RuntimeRunning';
  } else if (provider === 'windsurf') {
    const detail = object(body.tool_info);
    session = body.trajectory_id;
    turn = body.execution_id;
    cwd ??= detail.cwd;
    input = { ...detail, command: detail.command_line };
    tool = /read_code$/.test(event) ? 'Read' : /write_code$/.test(event) ? 'Edit' : /run_command$/.test(event) ? 'Bash' : string(detail.mcp_tool_name) || 'MCP';
    if (/mcp_tool_use$/.test(event)) input = detail.mcp_tool_arguments;
    // execution_id identifies a whole turn, never a tool call.
    call = body.tool_call_id;
  } else if (provider === 'opencode') {
    const detail = object(body.properties), native = object(body.input);
    session = body.sessionID ?? native.sessionID ?? detail.sessionID ?? object(detail.info).id;
    call = body.callID ?? native.callID;
    tool = body.tool ?? native.tool;
    input = body.args ?? object(body.output).args;
    response = body.result;
    parent = body.parentSessionID ?? object(detail.info).parentID;
    title = body.title ?? object(detail.info).title;
    if (parent) { child = session; session = parent; }
    if (event === 'session.status') {
      const status = string(object(detail.status).type ?? body.status);
      event = status === 'idle' ? 'Stop' : status === 'busy' || status === 'retry' ? 'UserPromptSubmit' : '';
    }
    failed ||= body.error === true;
  } else if (provider === 'pi') {
    tool = body.toolName ?? tool;
    input = body.input ?? input;
    call = body.toolCallId ?? call;
    failed ||= body.isError === true;
  } else if (provider === 'openclaw') {
    const native = object(body.data);
    session = context.sessionId ?? native.sessionId ?? body.sessionId;
    cwd = body.cwd ?? context.workspaceDir ?? context.cwd;
    tool = native.toolName ?? context.toolName;
    input = native.params;
    call = native.toolCallId ?? context.toolCallId;
    response = native.result;
    failed ||= !!native.error || native.success === false;
    // An OpenClaw configured agentId is a role, not a spawned instance.
    child = body.childSessionId;
    parent = body.parentSessionId;
  } else if (provider === 'hermes') {
    call ??= extra.tool_call_id;
    turn ??= extra.turn_id;
    failed ||= ['error', 'blocked', 'failed'].includes(string(extra.status)) || !!extra.error_type;
    if (event === 'subagent_stop') {
      parent = extra.parent_session_id ?? session;
      child = extra.child_session_id;
      session = parent;
    }
  }
  event = EVENTS[event] ?? event;
  if (!['codex', 'claude-code'].includes(provider)) {
    // The lightweight forwarding process can supply its actual working directory.
    // It never substitutes the repository it was configured for.
    cwd ??= body.codiluce_cwd;
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return undefined;
  }
  if (typeof session !== 'string' || !session || session.length > 512) return undefined;
  if (event === 'SubagentStop' && !child) return undefined;
  if (failed && event === 'PostToolUse') event = 'PostToolUseFailure';
  if (failed && event === 'Stop') event = 'RuntimeError';
  const mapped = toolObservation(string(tool), input);
  return {
    hook_event_name: event, session_id: session, cwd, agent_id: child,
    parent_session_id: parent, turn_id: turn,
    tool_name: string(tool), observed_tool: mapped.name, tool_input: mapped.input,
    tool_use_id: call, tool_response: response, session_title: title,
    source_event_id: body.source_event_id, source_instance_id: body.source_instance_id,
  };
}
