import path from 'node:path';
import { HOOK_EVENTS } from './normalize.js';
import type { AgentProvider } from './model.js';
import { shellLine, type Launch } from '../setup/agents.js';
import { npxPackage, type InstallKind } from '../setup/settings.js';
import { runtimeProfile } from '../harnesses/registry.js';

export function activityLaunch(tool: string, kind: InstallKind, provider: AgentProvider, root: string, stateDirectory: string): Launch {
  const scope = hookScope(provider, root, stateDirectory);
  if (kind === 'checkout') return { command: process.execPath, args: ['--no-warnings', '--import', path.join(tool, 'node_modules/tsx/dist/loader.mjs'), path.join(tool, 'src/activity/hook-cli.ts'), ...scope] };
  if (kind === 'npx') return { command: 'npx', args: ['-y', npxPackage(tool), 'activity', 'hook', ...scope] };
  return { command: process.execPath, args: ['--no-warnings', path.join(tool, 'dist/src/activity/hook-cli.js'), ...scope] };
}
function hookScope(provider: AgentProvider, root: string, stateDirectory: string): string[] { return ['--agent', provider, '--repo', root, '--state-dir', stateDirectory]; }

/**
 * npx installs: hooks run on every tool call, and npx itself takes most of a second each time. Setup writes this
 * launcher into the state directory instead; it runs this version from npx's cache directly, and through npx only if
 * that cache was cleared. Plain JavaScript: no shell syntax, so it works however a harness runs commands.
 */
export const ACTIVITY_LAUNCHER = 'activity-hook.mjs';
export function activityLauncher(tool: string, stateDirectory: string): { path: string; content: string } {
  const direct = path.join(tool, 'dist/src/activity/hook-cli.js');
  return {
    path: path.join(stateDirectory, ACTIVITY_LAUNCHER),
    content: `#!/usr/bin/env node
// Codiluce observer v1: activity hooks start ${npxPackage(tool)} here, from npx's cache when it is still there (fast),
// otherwise through npx. Written by codiluce setup; it changes nothing in the agent's work.
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const direct = ${JSON.stringify(direct)};
if (existsSync(direct)) await import(pathToFileURL(direct).href);
else spawn('npx', ${JSON.stringify(['-y', npxPackage(tool), 'activity', 'hook'])}.concat(process.argv.slice(2)), { stdio: 'inherit', shell: process.platform === 'win32', windowsHide: true }).on('error', () => {});
`,
  };
}
/** The hook command that runs the launcher (`activityLauncher`) with this Node. */
export function launcherLaunch(provider: AgentProvider, root: string, stateDirectory: string): Launch {
  return { command: process.execPath, args: ['--no-warnings', path.join(stateDirectory, ACTIVITY_LAUNCHER), ...hookScope(provider, root, stateDirectory)] };
}

/** Produce a mergeable snippet; never overwrite an agent's existing settings. */
export function hookConfiguration(provider: AgentProvider, launch: Launch, profileId?: string): { hooks: Record<string, unknown[]>; version?: number } {
  const profile = runtimeProfile(provider, profileId), format = profile.activity.format;
  if (['scripts', 'opencode', 'pi', 'openclaw'].includes(format)) return { hooks: {} };
  return { ...(['flat', 'copilot'].includes(format) && provider !== 'windsurf' ? { version: 1 } : {}), hooks: Object.fromEntries(profile.activity.events.map(event => {
    const command = shellLine({ ...launch, args: [...launch.args, '--profile', profile.id, '--event', event] });
    const hook = { type: 'command', command, timeout: 10 };
    return [event, format === 'nested' ? [{ hooks: [hook] }] : format === 'copilot' ? [{ type: 'command', exec: launch.command, args: [...launch.args, '--profile', profile.id, '--event', event], timeoutSec: 10 }] : [{ command, ...(format === 'hermes' ? { timeout: 10, fail_closed: false } : {}) }]];
  })) };
}

export { forwardHook } from './forward.js';
