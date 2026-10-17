import path from 'node:path';
import { HOOK_EVENTS } from './normalize.js';
import type { AgentProvider } from './model.js';
import { shellLine, type Launch } from '../setup/agents.js';
import type { InstallKind } from '../setup/settings.js';
import { runtimeProfile } from '../harnesses/registry.js';

export function activityLaunch(tool: string, kind: InstallKind, provider: AgentProvider, root: string, stateDirectory: string): Launch {
  const scope = ['--agent', provider, '--repo', root, '--state-dir', stateDirectory];
  if (kind === 'checkout') return { command: process.execPath, args: ['--no-warnings', '--import', path.join(tool, 'node_modules/tsx/dist/loader.mjs'), path.join(tool, 'src/activity/hook-cli.ts'), ...scope] };
  if (kind === 'npx') return { command: 'npx', args: ['-y', 'codiluce', 'activity', 'hook', ...scope] };
  return { command: process.execPath, args: ['--no-warnings', path.join(tool, 'dist/src/activity/hook-cli.js'), ...scope] };
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
