import os from 'node:os';
import path from 'node:path';
import { access, readFile, lstat } from 'node:fs/promises';
import { mcpLaunch, shellLine, type Launch } from '../setup/agents.js';
import { activityLaunch, hookConfiguration } from '../activity/hooks.js';
import type { InstallKind } from '../setup/settings.js';
import type { AgentIntegration } from '../activity/model.js';
import { harness, runtimeProfile, type HarnessId, type HarnessProfile, type ConfigFormat } from './registry.js';
import { editConfiguration, parseConfiguration, readConfiguration, record, valueAt, writeReviewedFile, upsertConfigurationItems } from './config.js';
import { collectorSource } from './collectors.js';

export interface SetupOptions { profile?: string; scope?: 'project' | 'user'; home?: string; env?: NodeJS.ProcessEnv; activity?: boolean; mcp?: boolean }
export interface SetupChange { path: string; before: string; after: string; executable?: boolean }
export interface SetupPlan { integration: AgentIntegration; changes: SetupChange[] }
const exists = async (file: string) => { try { await access(file); return true; } catch { return false; } };

export function userPath(id: HarnessId, relative: string, options: SetupOptions = {}): string {
  const home = options.home ?? os.homedir(), env = options.env ?? process.env;
  const overrides: Partial<Record<HarnessId, string | undefined>> = { codex: env.CODEX_HOME, 'claude-code': env.CLAUDE_CONFIG_DIR, pi: env.PI_CODING_AGENT_DIR, 'github-copilot': env.COPILOT_HOME, openclaw: env.OPENCLAW_STATE_DIR, hermes: env.HERMES_HOME };
  if (id === 'openclaw' && relative === '.openclaw/openclaw.json' && env.OPENCLAW_CONFIG_PATH) return path.resolve(env.OPENCLAW_CONFIG_PATH);
  if (id === 'cline' && relative.endsWith('cline_mcp_settings.json') && env.CLINE_MCP_SETTINGS_PATH) return path.resolve(env.CLINE_MCP_SETTINGS_PATH);
  const prefix = harness(id).home, override = overrides[id];
  if (override && (relative === prefix || relative.startsWith(`${prefix}/`))) return path.resolve(override, relative.slice(prefix.length + 1));
  if (id === 'opencode' && env.XDG_CONFIG_HOME && relative.startsWith('.config/')) return path.resolve(env.XDG_CONFIG_HOME, relative.slice('.config/'.length));
  return path.resolve(home, relative);
}

export function configurationPath(id: HarnessId, profile: HarnessProfile, purpose: 'mcp' | 'activity', root: string, options: SetupOptions = {}): string | undefined {
  const spec = profile[purpose];
  const scope = options.scope ?? (spec.project ? 'project' : 'user');
  const relative = spec[scope];
  return relative ? scope === 'project' ? path.resolve(root, relative) : userPath(id, relative, options) : undefined;
}

function serverConfiguration(profile: HarnessProfile, launch: Launch): Record<string, unknown> {
  return profile.mcp.shape === 'command-array' ? { type: 'local', command: [launch.command, ...launch.args], enabled: true }
    : { ...(profile.mcp.shape === 'stdio' ? { type: 'stdio' } : {}), command: launch.command, args: launch.args };
}
const script = (launch: Launch, profile: string, event: string): string => `#!/usr/bin/env node\n// Codiluce observer v1. No context, permission, or tool mutations.\nconst args=${JSON.stringify([...launch.args, '--profile', profile, '--event', event])};\nconst neutral=${JSON.stringify(profile === 'cline-legacy' ? '{"cancel":false}\n' : '{}\n')};\nlet done=false;const finish=()=>{if(!done){done=true;process.stdout.write(neutral);}};\n(async()=>{try {const {spawn}=await import('node:child_process');const child=spawn(${JSON.stringify(launch.command)},args,{stdio:['pipe','ignore','ignore'],windowsHide:true});process.stdin.pipe(child.stdin);child.stdin.on('error',()=>{});child.on('error',finish);child.on('close',finish);const timer=setTimeout(()=>{child.kill();finish();},2500);timer.unref();}catch{finish();}})().catch(finish);\n`;

function ownedHook(value: unknown, id: HarnessId, root: string, state: string): boolean {
  const item = record(value);
  if (Array.isArray(item.hooks)) return item.hooks.length > 0 && item.hooks.every(entry => ownedHook(entry, id, root, state));
  const args = Array.isArray(item.args) ? item.args : typeof item.command === 'string' ? item.command.match(/'(?:[^']|'\\'')*'|"[^"\n]*"|[^\s'"]+/g)?.map(token => token.replace(/^(['"])(.*)\1$/, '$2').replace(/'\\''/g, "'")) : undefined;
  if (!args) return false;
  const arg = (key: string) => args[args.indexOf(key) + 1];
  return arg('--agent') === id && arg('--repo') === root && arg('--state-dir') === state;
}

/** Snippets contain only Codiluce-owned settings, never existing secrets or transcript text. */
export function integrationConfiguration(id: HarnessId, tool: string, kind: InstallKind, root: string, stateDirectory: string, options: SetupOptions = {}): AgentIntegration {
  const item = harness(id), profile = runtimeProfile(id, options.profile);
  const files: AgentIntegration['files'] = [], instructions: string[] = [];
  const launch = mcpLaunch(tool, kind, { repo: root, stateDirectory });
  const mcpFile = configurationPath(id, profile, 'mcp', root, options);
  if (options.mcp !== false) {
    let content = '';
    for (const [key, value] of Object.entries(serverConfiguration(profile, launch))) content = editConfiguration(content, profile.mcp.format, [...profile.mcp.key, 'codiluce', key], value);
    files.push({ path: mcpFile ?? 'Merge in the MCP settings opened by your harness', content, purpose: 'mcp' });
    if (!mcpFile) instructions.push('This profile does not expose a settings path at the chosen scope. Merge the MCP snippet using the harness settings UI.');
  }
  if (options.activity !== false) {
    const activityFile = configurationPath(id, profile, 'activity', root, options);
    if (!activityFile) instructions.push('Activity installation is unavailable at this scope. Choose user scope or use the supplied project profile.');
    else if (['opencode', 'pi'].includes(profile.activity.format)) files.push({ path: activityFile, content: collectorSource(id, root, stateDirectory), purpose: 'plugin' });
    else if (profile.activity.format === 'openclaw') {
      files.push({ path: path.join(activityFile, 'index.js'), content: collectorSource(id, root, stateDirectory), purpose: 'plugin' });
      files.push({ path: path.join(activityFile, 'openclaw.plugin.json'), content: JSON.stringify({ id: 'codiluce', name: 'Codiluce activity', activation: { onCapabilities: ['hook'] }, configSchema: { type: 'object', properties: {}, additionalProperties: false } }, null, 2) + '\n', purpose: 'plugin' });
      files.push({ path: path.join(activityFile, 'package.json'), content: JSON.stringify({ name: 'codiluce-openclaw', version: '1.0.0', type: 'module', openclaw: { extensions: ['./index.js'] } }, null, 2) + '\n', purpose: 'plugin' });
      instructions.push(`Install the local observer: openclaw plugins install -l ${shellLine({ command: activityFile, args: [] })}`, 'Enable codiluce in OpenClaw and review its hook capability. Existing plugin allowlists are not changed.');
    } else if (profile.activity.format === 'scripts') {
      const observer = activityLaunch(tool, kind, id, root, stateDirectory);
      for (const event of profile.activity.events) files.push({ path: path.join(activityFile, event), content: script(observer, profile.id, event), purpose: 'activity', executable: true });
    } else {
      const hooks = hookConfiguration(id, activityLaunch(tool, kind, id, root, stateDirectory), profile.id);
      const format: ConfigFormat = profile.activity.format === 'hermes' ? 'yaml' : 'jsonc';
      let content = '';
      if (hooks.version) content = editConfiguration(content, format, ['version'], hooks.version);
      content = editConfiguration(content, format, ['hooks'], hooks.hooks);
      files.push({ path: activityFile, content, purpose: 'activity' });
    }
  }
  if (id === 'codex') instructions.push('Review and trust the generated definitions with /hooks in Codex. Saved hook trust is never changed by Codiluce.');
  if (id === 'pi') instructions.push('Trust this project in Pi before project MCP/extension configuration can run. Prefer one observer installation scope.');
  if (profile.note) instructions.push(profile.note);
  instructions.push('Reload the harness configuration or restart its session, then run a file read to confirm activity delivery.', item.historyNote, item.childAttribution);
  const command = shellLine({ command: 'codiluce', args: ['harness', 'setup', '--agent', id, '--profile', profile.id, '--repo', root, '--state-dir', stateDirectory, ...(options.scope ? ['--scope', options.scope] : []), '--apply'] });
  return { provider: id, profile: profile.id, label: profile.label, files, instructions, command };
}

/** Preview all file mutations and validate every config before any file is written. */
export async function planIntegration(id: HarnessId, tool: string, kind: InstallKind, root: string, stateDirectory: string, options: SetupOptions = {}): Promise<SetupPlan> {
  const integration = integrationConfiguration(id, tool, kind, root, stateDirectory, options), profile = runtimeProfile(id, options.profile);
  const changes = new Map<string, SetupChange>();
  for (const file of integration.files) {
    if (!path.isAbsolute(file.path)) continue; // A UI-managed MCP destination is supplied as instructions only.
    if (id === 'opencode' && file.purpose === 'mcp' && !await exists(file.path) && await exists(file.path.replace(/\.json$/, '.jsonc'))) file.path = file.path.replace(/\.json$/, '.jsonc');
    let change = changes.get(file.path);
    if (file.purpose === 'plugin' || file.executable) {
      let before = '';
      try { const info = await lstat(file.path); if (!info.isFile() || info.isSymbolicLink() || info.size > 2 * 1024 * 1024) throw new Error(`Unsafe observer destination: ${file.path}`); before = await readFile(file.path, 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (before && before !== file.content && !before.includes('Codiluce observer v1') && !before.includes('"codiluce"') && !before.includes('"codiluce-openclaw"')) throw new Error(`An unrelated file already exists: ${file.path}`);
      changes.set(file.path, { path: file.path, before, after: file.content, ...(file.executable ? { executable: true } : {}) }); continue;
    }
    const format = file.purpose === 'mcp' ? profile.mcp.format : profile.activity.format === 'hermes' ? 'yaml' : 'jsonc';
    if (!change) { const config = await readConfiguration(file.path, format); change = { path: file.path, before: config.text, after: config.text }; changes.set(file.path, change); }
    const snippet = parseConfiguration(file.content, format);
    if (file.purpose === 'mcp') {
      const server = record(valueAt(snippet, [...profile.mcp.key, 'codiluce']));
      for (const [key, value] of Object.entries(server)) change.after = editConfiguration(change.after, format, [...profile.mcp.key, 'codiluce', key], value);
    } else {
      if (snippet.version) {
        const previousVersion = parseConfiguration(change.after, format).version;
        if (previousVersion !== undefined && previousVersion !== snippet.version) throw new Error(`Unsupported hook configuration version: ${String(previousVersion)}`);
        change.after = editConfiguration(change.after, format, ['version'], snippet.version);
      }
      for (const [event, entries] of Object.entries(record(snippet.hooks))) {
        change.after = upsertConfigurationItems(change.after, format as 'jsonc' | 'yaml', ['hooks', event], entries as unknown[], value => ownedHook(value, id, root, stateDirectory));
      }
    }
  }
  return { integration, changes: [...changes.values()] };
}

export async function applyIntegration(plan: SetupPlan): Promise<void> {
  // Check the complete preview first so a known conflict cannot leave half an installation.
  for (const change of plan.changes) {
    let current = ''; try { current = await readFile(change.path, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (current !== change.before) throw new Error(`Configuration changed since preview: ${change.path}`);
  }
  for (const change of plan.changes) await writeReviewedFile(change.path, change.before, change.after, change.executable);
}
