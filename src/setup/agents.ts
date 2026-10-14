// Connecting coding agents to Codiluce's MCP server (`codiluce mcp`): the
// command that starts it for this install, which agents are on this computer,
// whether they already have it, and adding it through their own CLIs (Claude
// Code, Codex) or their configuration file (Cursor).
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { InstallKind } from './settings.js';

const execute = promisify(execFile);
export interface Launch { command: string; args: string[] }
export type AgentId = 'claude' | 'codex' | 'cursor';
export interface Agent {
  id: AgentId; name: string;
  /** Found on this computer. */
  installed: boolean;
  /** Already has a `codiluce` server for this repository (Claude Code) or for every repository (Codex, Cursor). */
  connected: boolean;
  /** Where the connection is kept, for the summary. */
  scope: string;
}

/**
 * The command an agent runs to start `codiluce mcp`. A source checkout runs
 * its TypeScript; an installed package runs its own bin with this Node; npx
 * (a cache that may be replaced) goes through npx again. `repo` binds it to one
 * repository; without it, the server serves the repository it is started in.
 */
export function mcpLaunch(toolDirectory: string, kind: InstallKind, options: { repo?: string; stateDirectory?: string } = {}): Launch {
  const scope = [...options.repo ? ['--repo', options.repo] : [], ...options.stateDirectory ? ['--state-dir', options.stateDirectory] : []];
  if (kind === 'checkout') return { command: process.execPath, args: ['--experimental-sqlite', '--no-warnings', '--import', path.join(toolDirectory, 'node_modules/tsx/dist/loader.mjs'), path.join(toolDirectory, 'src/cli.ts'), 'mcp', ...scope] };
  if (kind === 'npx') return { command: 'npx', args: ['-y', 'codiluce', 'mcp', ...scope] };
  return { command: process.execPath, args: [path.join(toolDirectory, 'bin/codiluce.js'), 'mcp', ...scope] };
}
export function shellLine(launch: Launch): string { return [launch.command, ...launch.args].map(quote).join(' '); }
function quote(part: string): string { return /^[\w@%+=:,./${}-]+$/.test(part) ? part : `'${part.replace(/'/g, `'\\''`)}'`; }

const CURSOR_CONFIG = () => path.join(os.homedir(), '.cursor', 'mcp.json');
async function succeeds(command: string, args: string[], cwd: string): Promise<boolean> {
  try { await execute(command, args, { cwd, timeout: 15_000, windowsHide: true }); return true; } catch { return false; }
}
/** The agents on this computer and whether each already reaches Codiluce. */
export async function detectAgents(root: string): Promise<Agent[]> {
  const [claude, codex] = await Promise.all([succeeds('claude', ['--version'], root), succeeds('codex', ['--version'], root)]);
  const [claudeConnected, codexConnected] = await Promise.all([claude ? succeeds('claude', ['mcp', 'get', 'codiluce'], root) : false, codex ? succeeds('codex', ['mcp', 'get', 'codiluce'], root) : false]);
  const cursorConfig = CURSOR_CONFIG();
  const cursor = existsSync(path.dirname(cursorConfig));
  let cursorConnected = false;
  try { cursorConnected = !!(JSON.parse(readFileSync(cursorConfig, 'utf8')) as { mcpServers?: Record<string, unknown> }).mcpServers?.codiluce; } catch { /* none yet */ }
  return [
    { id: 'claude', name: 'Claude Code', installed: claude, connected: claudeConnected, scope: 'for this repository' },
    { id: 'codex', name: 'Codex', installed: codex, connected: codexConnected, scope: 'for every repository (~/.codex/config.toml)' },
    { id: 'cursor', name: 'Cursor', installed: cursor, connected: cursorConnected, scope: 'for every workspace (~/.cursor/mcp.json)' },
  ];
}
/**
 * Add Codiluce to an agent. Claude Code keeps servers per project, so its
 * command names this repository; Codex and Cursor keep one list for every
 * repository, so theirs follows the folder the agent works in (Cursor fills in
 * its workspace; Codex starts servers in its working directory).
 */
export async function connectAgent(agent: AgentId, toolDirectory: string, kind: InstallKind, root: string, stateDirectory?: string): Promise<void> {
  if (agent === 'claude') {
    const launch = mcpLaunch(toolDirectory, kind, { repo: root, stateDirectory });
    await execute('claude', ['mcp', 'remove', 'codiluce', '-s', 'local'], { cwd: root, timeout: 15_000 }).catch(() => undefined);
    await execute('claude', ['mcp', 'add', '-s', 'local', 'codiluce', '--', launch.command, ...launch.args], { cwd: root, timeout: 30_000 });
  } else if (agent === 'codex') {
    const launch = mcpLaunch(toolDirectory, kind);
    await execute('codex', ['mcp', 'remove', 'codiluce'], { cwd: root, timeout: 15_000 }).catch(() => undefined);
    await execute('codex', ['mcp', 'add', 'codiluce', '--', launch.command, ...launch.args], { cwd: root, timeout: 30_000 });
  } else {
    const launch = mcpLaunch(toolDirectory, kind, { repo: '${workspaceFolder}' });
    const file = CURSOR_CONFIG();
    let config: { mcpServers?: Record<string, unknown> } & Record<string, unknown> = {};
    try { config = JSON.parse(readFileSync(file, 'utf8')) as typeof config; } catch { /* a new file */ }
    config.mcpServers = { ...config.mcpServers, codiluce: { command: launch.command, args: launch.args } };
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  }
}
/** The JSON other MCP clients take (Windsurf, Zed, VS Code…), for the summary. */
export function mcpJson(launch: Launch): string { return JSON.stringify({ mcpServers: { codiluce: { command: launch.command, args: launch.args } } }, null, 2); }
