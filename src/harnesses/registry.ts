/** Browser-safe integration metadata. Executable adapters live at the server boundary. */
export const HARNESS_IDS = ['codex', 'claude-code', 'cursor', 'opencode', 'pi', 'github-copilot', 'gemini-cli', 'cline', 'antigravity', 'windsurf', 'openclaw', 'hermes'] as const;
export type HarnessId = typeof HARNESS_IDS[number];
export type ConfigFormat = 'jsonc' | 'toml' | 'yaml';
export type HookFormat = 'nested' | 'flat' | 'copilot' | 'scripts' | 'opencode' | 'pi' | 'openclaw' | 'hermes';
export type HistoryFormat = 'codex' | 'claude' | 'pi' | 'gemini' | 'copilot' | 'openclaw' | 'export';
export interface HarnessProfile {
  id: string; label: string;
  mcp: { project?: string; user?: string; key: string[]; format: ConfigFormat; shape?: 'command-array' | 'stdio' };
  activity: { project?: string; user?: string; format: HookFormat; events: string[] };
  note?: string;
}
export interface Harness {
  id: HarnessId; label: string; short: string; aliases: string[]; binaries: string[]; home: string;
  character: string; color: string; profiles: HarnessProfile[];
  history: HistoryFormat; historyNote: string; childAttribution: string; docs: string[];
}
const nested = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'SubagentStart', 'SubagentStop', 'Stop'];
const mcp = (project: string | undefined, user: string | undefined, key = ['mcpServers'], format: ConfigFormat = 'jsonc'): HarnessProfile['mcp'] => ({ project, user, key, format });
const hooks = (project: string | undefined, user: string | undefined, format: HookFormat, events: string[]): HarnessProfile['activity'] => ({ project, user, format, events });
export const HARNESSES: readonly Harness[] = [
  { id: 'codex', label: 'Codex', short: 'CX', aliases: [], binaries: ['codex'], home: '.codex', character: 'terminal-cloud', color: '#3e6ff4', history: 'codex', historyNote: 'Local Codex JSONL sessions and archived sessions.', childAttribution: 'Child lifecycle when IDs are supplied; tool hooks may use the parent session.', docs: ['https://learn.chatgpt.com/docs/hooks'], profiles: [
    { id: 'codex', label: 'Codex', mcp: mcp('.codex/config.toml', '.codex/config.toml', ['mcp_servers'], 'toml'), activity: hooks('.codex/hooks.json', '.codex/hooks.json', 'nested', [...nested, 'Interrupt']) },
  ] },
  { id: 'claude-code', label: 'Claude Code', short: 'CC', aliases: ['claude'], binaries: ['claude'], home: '.claude', character: 'clawd', color: '#d97757', history: 'claude', historyNote: 'Local Claude project transcripts, including explicit sidechains.', childAttribution: 'Explicit agent IDs; shared parent IDs do not imply child tool ownership.', docs: ['https://code.claude.com/docs/en/hooks'], profiles: [
    { id: 'claude-code', label: 'Claude Code', mcp: mcp('.mcp.json', '.claude.json'), activity: hooks('.claude/settings.local.json', '.claude/settings.json', 'nested', [...nested, 'PostToolUseFailure']) },
  ] },
  { id: 'cursor', label: 'Cursor', short: 'CU', aliases: [], binaries: ['cursor', 'agent'], home: '.cursor', character: 'pointer-scout', color: '#747f98', history: 'export', historyNote: 'Import a Codiluce session export. Private editor databases are not read.', childAttribution: 'Explicit child conversation IDs only; permission hooks are not installed.', docs: ['https://cursor.com/docs/hooks'], profiles: [
    { id: 'cursor', label: 'Cursor IDE / CLI', mcp: mcp('.cursor/mcp.json', '.cursor/mcp.json'), activity: hooks('.cursor/hooks.json', '.cursor/hooks.json', 'flat', ['sessionStart', 'sessionEnd', 'postToolUse', 'postToolUseFailure', 'subagentStop', 'stop']), note: 'Observes completed tools. Pre-tool and subagent-start permission hooks are deliberately excluded so observation cannot approve or block an action.' },
  ] },
  { id: 'opencode', label: 'OpenCode', short: 'OC', aliases: ['open-code'], binaries: ['opencode'], home: '.config/opencode', character: 'terminal-cube', color: '#59665c', history: 'export', historyNote: 'Import a Codiluce session export; private OpenCode storage is not scanned.', childAttribution: 'Explicit parent session IDs from the plugin session metadata.', docs: ['https://opencode.ai/docs/plugins/', 'https://opencode.ai/docs/mcp-servers/'], profiles: [
    { id: 'opencode', label: 'OpenCode plugin', mcp: { ...mcp('opencode.json', '.config/opencode/opencode.json', ['mcp']), shape: 'command-array' }, activity: hooks('.opencode/plugins/codiluce.js', '.config/opencode/plugins/codiluce.js', 'opencode', ['tool.execute.before', 'tool.execute.after', 'session.created', 'session.status', 'session.idle', 'session.error']) },
  ] },
  { id: 'pi', label: 'Pi', short: 'PI', aliases: ['pi-coding-agent'], binaries: ['pi'], home: '.pi/agent', character: 'round-builder', color: '#dc68a4', history: 'pi', historyNote: 'Pi JSONL trees are imported along the active branch; system and reasoning entries are excluded.', childAttribution: 'Extension-specific IDs only. A fork is a new session, not an inferred child.', docs: ['https://pi.dev/docs/latest/mcp', 'https://pi.dev/docs/latest/extensions', 'https://pi.dev/docs/latest/session-format'], profiles: [
    { id: 'pi', label: 'Pi with native MCP', mcp: mcp('.pi/mcp.json', '.pi/agent/mcp.json'), activity: hooks('.pi/extensions/codiluce.js', '.pi/agent/extensions/codiluce.js', 'pi', ['session_start', 'session_shutdown', 'agent_start', 'agent_settled', 'tool_call', 'tool_result']), note: 'Requires Pi with native MCP. Legacy third-party MCP bridges are not configured automatically.' },
  ] },
  { id: 'github-copilot', label: 'GitHub Copilot', short: 'GH', aliases: ['copilot'], binaries: ['copilot'], home: '.copilot', character: 'visor-pilot', color: '#6c63db', history: 'copilot', historyNote: 'Copilot CLI session-state JSONL. VS Code Local uses the portable session export.', childAttribution: 'Only explicit IDs. Some built-in agents do not emit child lifecycle events.', docs: ['https://docs.github.com/en/copilot/reference/hooks-reference', 'https://code.visualstudio.com/docs/copilot/customization/hooks'], profiles: [
    { id: 'copilot-cli', label: 'Copilot CLI', mcp: mcp('.mcp.json', '.copilot/mcp-config.json'), activity: hooks('.github/hooks/codiluce.json', '.copilot/hooks/codiluce.json', 'copilot', ['sessionStart', 'sessionEnd', 'userPromptSubmitted', 'preToolUse', 'postToolUse', 'postToolUseFailure', 'agentStop', 'subagentStart', 'subagentStop', 'errorOccurred']) },
    { id: 'copilot-vscode', label: 'VS Code Copilot harness', mcp: { ...mcp('.vscode/mcp.json', undefined, ['servers']), shape: 'stdio' }, activity: hooks('.github/hooks/codiluce-vscode.json', undefined, 'flat', ['sessionStart', 'sessionEnd', 'userPromptSubmitted', 'preToolUse', 'postToolUse', 'postToolUseFailure', 'agentStop', 'subagentStart', 'subagentStop', 'errorOccurred']), note: 'Select the Copilot session target in VS Code. Uses the shared Copilot SDK hook schema with shell commands for editor compatibility.' },
    { id: 'vscode-local', label: 'VS Code Local harness', mcp: { ...mcp('.vscode/mcp.json', undefined, ['servers']), shape: 'stdio' }, activity: hooks('.github/hooks/codiluce-local.json', undefined, 'nested', nested), note: 'Select Local in VS Code. Copilot, Claude and Codex session targets use their own runtime hook contracts.' },
  ] },
  { id: 'gemini-cli', label: 'Gemini CLI', short: 'GM', aliases: ['gemini'], binaries: ['gemini'], home: '.gemini', character: 'twin-star', color: '#568cec', history: 'gemini', historyNote: 'Gemini CLI project chat JSON files, scoped by projectHash / project metadata.', childAttribution: 'Session-level unless the source explicitly supplies a child instance ID.', docs: ['https://geminicli.com/docs/hooks/reference/', 'https://geminicli.com/docs/tools/mcp-server/'], profiles: [
    { id: 'gemini-cli', label: 'Gemini CLI', mcp: mcp('.gemini/settings.json', '.gemini/settings.json'), activity: hooks('.gemini/settings.json', '.gemini/settings.json', 'nested', ['SessionStart', 'SessionEnd', 'BeforeAgent', 'AfterAgent', 'BeforeTool', 'AfterTool', 'Notification']) },
  ] },
  { id: 'cline', label: 'Cline', short: 'CL', aliases: [], binaries: ['cline'], home: '.cline', character: 'notebook-courier', color: '#df9b3d', history: 'export', historyNote: 'Import a Codiluce session export; editor task databases are not scanned.', childAttribution: 'CLI/Desktop and editor extensions differ. Children do not inherit MCP access in the documented CLI contract.', docs: ['https://github.com/cline/cline/blob/main/sdk/examples/plugins/README.md', 'https://github.com/cline/cline/blob/main/.clinerules/hooks/README.md'], profiles: [
    { id: 'cline-cli', label: 'Cline CLI / Desktop file hooks', mcp: mcp(undefined, '.cline/data/settings/cline_mcp_settings.json'), activity: hooks('.cline/hooks', '.cline/hooks', 'scripts', ['TaskStart', 'TaskResume', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'TaskComplete', 'TaskCancel', 'TaskError', 'SessionShutdown']) },
    { id: 'cline-legacy', label: 'Cline editor legacy hooks', mcp: mcp(undefined, undefined), activity: hooks('.clinerules/hooks', undefined, 'scripts', ['TaskStart', 'TaskResume', 'TaskCancel', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse']), note: 'Open Configure MCP Servers in the Cline extension and merge the supplied MCP configuration there. The extension chooses its settings location.' },
  ] },
  { id: 'antigravity', label: 'Google Antigravity', short: 'AG', aliases: [], binaries: ['antigravity', 'agy'], home: '.gemini/antigravity', character: 'orbit-mechanic', color: '#a56ddd', history: 'export', historyNote: 'Import a Codiluce session export. Internal brain/log files are not assumed stable.', childAttribution: 'Explicit source IDs only; collaboration tool names do not prove child identity.', docs: ['https://antigravity.google/docs/hooks', 'https://antigravity.google/docs/mcp'], profiles: [
    { id: 'antigravity', label: 'Antigravity App / CLI / IDE', mcp: mcp('.agents/mcp_config.json', '.gemini/config/mcp_config.json'), activity: hooks('.agents/hooks.json', '.gemini/config/hooks.json', 'nested', ['SessionStart', 'PostToolUse', 'PreInvocation', 'Stop']), note: 'Uses observation-only events. The PreToolUse permission gate is not installed.' },
  ] },
  { id: 'windsurf', label: 'Windsurf / Devin Desktop', short: 'WS', aliases: ['cascade', 'devin-desktop'], binaries: ['windsurf'], home: '.codeium/windsurf', character: 'wave-courier', color: '#38a99c', history: 'export', historyNote: 'Import a Codiluce session export. Cascade transcript hooks are not enabled for activity collection.', childAttribution: 'trajectory_id identifies the session; execution_id identifies a turn, not a child agent.', docs: ['https://docs.devin.ai/desktop/cascade/hooks', 'https://docs.devin.ai/desktop/cascade/mcp'], profiles: [
    { id: 'cascade', label: 'Cascade (Windsurf / Devin Desktop)', mcp: mcp(undefined, '.codeium/windsurf/mcp_config.json'), activity: hooks('.windsurf/hooks.json', '.codeium/windsurf/hooks.json', 'flat', ['pre_read_code', 'post_read_code', 'pre_write_code', 'post_write_code', 'pre_run_command', 'post_run_command', 'pre_mcp_tool_use', 'post_mcp_tool_use', 'pre_user_prompt', 'post_cascade_response']), note: 'Devin Local Agent has a different contract and is not this profile.' },
  ] },
  { id: 'openclaw', label: 'OpenClaw', short: 'OCW', aliases: [], binaries: ['openclaw'], home: '.openclaw', character: 'claw-scout', color: '#e15b55', history: 'openclaw', historyNote: 'OpenClaw agent JSONL sessions with explicit repository metadata; unrelated messaging sessions are skipped.', childAttribution: 'Plugin context session and agent IDs; tool ownership never inferred from model or tool name.', docs: ['https://docs.openclaw.ai/gateway/config-extensions', 'https://docs.openclaw.ai/plugins/hooks/reference'], profiles: [
    { id: 'openclaw', label: 'OpenClaw native plugin', mcp: mcp(undefined, '.openclaw/openclaw.json', ['mcp', 'servers']), activity: hooks(undefined, '.openclaw/extensions/codiluce', 'openclaw', ['before_tool_call', 'after_tool_call', 'session_start', 'session_end', 'agent_end']), note: 'Install/enable the generated plugin with OpenClaw and grant only its required hook capability. Existing plugin allowlists and trust settings are preserved.' },
  ] },
  { id: 'hermes', label: 'Hermes Agent', short: 'HM', aliases: ['hermes-agent'], binaries: ['hermes'], home: '.hermes', character: 'winged-courier', color: '#bd8c49', history: 'export', historyNote: 'Import a Codiluce session export. Hermes private SQLite stores are not read.', childAttribution: 'Explicit child session IDs supplied in shell-hook extra metadata.', docs: ['https://hermes-agent.nousresearch.com/docs/user-guide/features/hooks', 'https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/mcp.md'], profiles: [
    { id: 'hermes', label: 'Hermes shell hooks', mcp: mcp(undefined, '.hermes/config.yaml', ['mcp_servers'], 'yaml'), activity: hooks(undefined, '.hermes/config.yaml', 'hermes', ['on_session_start', 'pre_llm_call', 'pre_tool_call', 'post_tool_call', 'post_llm_call', 'on_session_finalize', 'subagent_stop']), note: 'Hermes hook consent remains in effect. on_session_end is not used as session termination because it can fire after each turn.' },
  ] },
];
export function isHarnessId(value: unknown): value is HarnessId { return typeof value === 'string' && HARNESS_IDS.includes(value as HarnessId); }
export function harnessId(value: unknown): HarnessId | undefined {
  if (isHarnessId(value)) return value;
  return typeof value === 'string' ? HARNESSES.find(item => item.aliases.includes(value))?.id : undefined;
}
export function harness(value: HarnessId): Harness { return HARNESSES.find(item => item.id === value)!; }
export function harnessLabel(value: string): string { const id = harnessId(value); return id ? harness(id).label : value || 'Agent'; }
export function runtimeProfile(id: HarnessId, profileId?: string): HarnessProfile {
  const found = profileId ? harness(id).profiles.find(item => item.id === profileId) : harness(id).profiles[0];
  if (!found) throw new Error(`Unsupported ${harness(id).label} profile: ${profileId}`);
  return found;
}
/** Preserve legacy deep links. Escape components for newly supported harnesses. */
export function sessionKey(id: HarnessId, session: string, child?: string): string {
  const encode = id === 'codex' || id === 'claude-code' ? (value: string) => value : encodeURIComponent;
  return `${id}:${encode(session)}${child ? `:${encode(child)}` : ''}`;
}
