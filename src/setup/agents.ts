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
import { HARNESSES, harnessId, type HarnessId } from '../harnesses/registry.js';

const execute = promisify(execFile);
export interface Launch { command: string; args: string[] }
export type AgentId = HarnessId | 'claude';
export interface Agent {
  id: AgentId; name: string;
  /** Found on this computer. */
  installed: boolean;
  /** Its `codiluce` server serves this repository with this install's command (Claude Code, Codex, Cursor), or it has one at all (other agents). */
  connected: boolean;
  /** It has a `codiluce` server that does not: bound to another repository, or started by another install. */
  elsewhere?: string;
  /** Where the connection is kept, for the summary. */
  scope: string;
}
/** The install that connects agents: which command starts `codiluce mcp`, and a state directory outside the repository, if any. */
export interface Install { toolDirectory: string; kind: InstallKind; stateDirectory?: string }

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
function quote(part: string): string { return /^[\w@%+=:,./-]+$/.test(part) ? part : `'${part.replace(/'/g, `'\\''`)}'`; }

const CURSOR_CONFIG = () => path.join(os.homedir(), '.cursor', 'mcp.json');
async function succeeds(command: string, args: string[], cwd: string): Promise<boolean> {
  try { await execute(command, args, { cwd, timeout: 15_000, windowsHide: true }); return true; } catch { return false; }
}
async function output(command: string, args: string[], cwd: string): Promise<string | undefined> {
  try { return (await execute(command, args, { cwd, timeout: 15_000, windowsHide: true })).stdout; } catch { return undefined; }
}
/**
 * The server each agent gets. Claude Code keeps servers per project, so its
 * command names this repository; Codex and Cursor keep one list for every
 * repository, so theirs follows the folder the agent works in (Cursor fills in
 * its workspace; Codex starts servers in its working directory).
 */
export function agentLaunch(agent: 'claude' | 'codex' | 'cursor', install: Install, root: string): Launch {
  if (agent === 'claude') return mcpLaunch(install.toolDirectory, install.kind, { repo: root, stateDirectory: install.stateDirectory });
  return mcpLaunch(install.toolDirectory, install.kind, agent === 'cursor' ? { repo: '${workspaceFolder}' } : {});
}
/**
 * Whether an agent's `codiluce` server (its command and arguments, joined by
 * spaces where its CLI prints them that way) is the one `agentLaunch` gives,
 * and if not, what it points at instead.
 */
function compare(found: { command: string; args: string } | undefined, expected: Launch, root: string): Pick<Agent, 'connected' | 'elsewhere'> {
  if (!found) return { connected: false };
  // Bound to this repository or following the agent's folder: both serve it.
  const here = (args: string) => ` ${args} `.replace(` --repo ${root} `, ' ').trim();
  if (found.command === expected.command && here(found.args) === here(expected.args.join(' '))) return { connected: true };
  const repo = /(?:^| )--repo (\S+)/.exec(found.args)?.[1];
  const other = repo && repo !== '${workspaceFolder}' && path.resolve(repo) !== path.resolve(root);
  return { connected: false, elsewhere: other ? `connected to ${path.basename(repo)}` : 'connected through another Codiluce install' };
}
/**
 * The server Claude Code would start here, read from its configuration (`claude
 * mcp get` starts the server to check it, which takes seconds): this
 * repository's local servers, then its .mcp.json, then the user's.
 */
function claudeServer(root: string): { command: string; args: string } | undefined {
  type Servers = { mcpServers?: Record<string, { command?: unknown; args?: unknown }> };
  const read = (file: string) => { try { return JSON.parse(readFileSync(file, 'utf8')) as Servers & { projects?: Record<string, Servers> }; } catch { return undefined; } };
  const user = read(path.join(os.homedir(), '.claude.json'));
  const server = user?.projects?.[root]?.mcpServers?.codiluce ?? read(path.join(root, '.mcp.json'))?.mcpServers?.codiluce ?? user?.mcpServers?.codiluce;
  return server ? { command: String(server.command ?? ''), args: Array.isArray(server.args) ? server.args.join(' ') : '' } : undefined;
}
function codexServer(text: string | undefined): { command: string; args: string } | undefined {
  if (text === undefined) return undefined;
  try {
    const transport = (JSON.parse(text) as { transport?: { command?: unknown; args?: unknown } }).transport;
    if (typeof transport?.command === 'string') return { command: transport.command, args: Array.isArray(transport.args) ? transport.args.join(' ') : '' };
  } catch { /* An older Codex without --json: it has a server, of unknown shape. */ }
  return { command: '', args: '' };
}
/** The agents on this computer and whether each reaches Codiluce for this repository, through this install. */
export async function detectAgents(root: string, install: Install): Promise<Agent[]> {
  const [claude, codex] = await Promise.all([succeeds('claude', ['--version'], root), succeeds('codex', ['--version'], root)]);
  const codexFound = codex ? await output('codex', ['mcp', 'get', 'codiluce', '--json'], root) : undefined;
  const cursorConfig = CURSOR_CONFIG();
  const cursor = existsSync(path.dirname(cursorConfig));
  let cursorFound: { command: string; args: string } | undefined;
  try {
    const server = (JSON.parse(readFileSync(cursorConfig, 'utf8')) as { mcpServers?: Record<string, { command?: unknown; args?: unknown }> }).mcpServers?.codiluce;
    if (server) cursorFound = { command: String(server.command ?? ''), args: Array.isArray(server.args) ? server.args.join(' ') : '' };
  } catch { /* none yet */ }
  const existing: Agent[] = [
    { id: 'claude', name: 'Claude Code', installed: claude, ...compare(claude ? claudeServer(root) : undefined, agentLaunch('claude', install, root), root), scope: 'for this repository' },
    { id: 'codex', name: 'Codex', installed: codex, ...compare(codexServer(codexFound), agentLaunch('codex', install, root), root), scope: 'for every repository (~/.codex/config.toml)' },
    { id: 'cursor', name: 'Cursor', installed: cursor, ...compare(cursorFound, agentLaunch('cursor', install, root), root), scope: 'for every workspace (~/.cursor/mcp.json)' },
  ];
  const { configurationPath } = await import('../harnesses/setup.js');
  const { readConfiguration, valueAt } = await import('../harnesses/config.js');
  for (const item of HARNESSES.filter(item => !['claude-code', 'codex', 'cursor'].includes(item.id))) {
    const profile = item.profiles[0]!;
    const files = [configurationPath(item.id, profile, 'mcp', root, { scope: 'project' }), configurationPath(item.id, profile, 'mcp', root, { scope: 'user' })].filter((file): file is string => !!file);
    let connected = false;
    for (const file of files) try { connected ||= !!valueAt((await readConfiguration(file, profile.mcp.format)).data, [...profile.mcp.key, 'codiluce']); } catch { /* Diagnostics are shown in the explicit setup flow. */ }
    const binaries = item.binaries.filter(binary => (process.env.PATH ?? '').split(path.delimiter).some(directory => existsSync(path.join(directory, binary))));
    const installed = existsSync(path.join(os.homedir(), item.home)) || files.some(file => existsSync(file)) || (await Promise.all(binaries.map(binary => succeeds(binary, ['--version'], root)))).some(Boolean);
    existing.push({ id: item.id, name: item.label, installed, connected, scope: profile.mcp.project ? 'for this repository' : 'in user settings, bound to this repository' });
  }
  return existing;
}
/** Add Codiluce to an agent, with the server `agentLaunch` gives it (replacing any it had). */
export async function connectAgent(agent: AgentId, toolDirectory: string, kind: InstallKind, root: string, stateDirectory?: string): Promise<void> {
  const install: Install = { toolDirectory, kind, stateDirectory };
  if (agent === 'claude') {
    const launch = agentLaunch('claude', install, root);
    await execute('claude', ['mcp', 'remove', 'codiluce', '-s', 'local'], { cwd: root, timeout: 15_000 }).catch(() => undefined);
    await execute('claude', ['mcp', 'add', '-s', 'local', 'codiluce', '--', launch.command, ...launch.args], { cwd: root, timeout: 30_000 });
  } else if (agent === 'codex') {
    const launch = agentLaunch('codex', install, root);
    await execute('codex', ['mcp', 'remove', 'codiluce'], { cwd: root, timeout: 15_000 }).catch(() => undefined);
    await execute('codex', ['mcp', 'add', 'codiluce', '--', launch.command, ...launch.args], { cwd: root, timeout: 30_000 });
  } else if (agent === 'cursor') {
    const launch = agentLaunch('cursor', install, root);
    const file = CURSOR_CONFIG();
    const { readConfiguration, editConfiguration, writeReviewedFile } = await import('../harnesses/config.js');
    const before = (await readConfiguration(file, 'jsonc')).text;
    let after = editConfiguration(before, 'jsonc', ['mcpServers', 'codiluce', 'command'], launch.command);
    after = editConfiguration(after, 'jsonc', ['mcpServers', 'codiluce', 'args'], launch.args);
    await writeReviewedFile(file, before, after);
  } else {
    const id = harnessId(agent); if (!id) throw new Error(`Unsupported agent: ${agent}`);
    const { planIntegration, applyIntegration } = await import('../harnesses/setup.js');
    await applyIntegration(await planIntegration(id, toolDirectory, kind, root, stateDirectory ?? path.join(root, '.codiluce'), { activity: false }));
  }
}
/** The JSON other MCP clients take (Windsurf, Zed, VS Code…), for the summary. */
export function mcpJson(launch: Launch): string { return JSON.stringify({ mcpServers: { codiluce: { command: launch.command, args: launch.args } } }, null, 2); }
