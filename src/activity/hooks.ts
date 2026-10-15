import path from 'node:path';
import { HOOK_EVENTS } from './normalize.js';
import type { AgentProvider } from './model.js';
import { shellLine, type Launch } from '../setup/agents.js';
import type { InstallKind } from '../setup/settings.js';

export function activityLaunch(tool: string, kind: InstallKind, provider: AgentProvider, root: string, stateDirectory: string): Launch {
  const scope = ['--agent', provider, '--repo', root, '--state-dir', stateDirectory];
  if (kind === 'checkout') return { command: process.execPath, args: ['--no-warnings', '--import', path.join(tool, 'node_modules/tsx/dist/loader.mjs'), path.join(tool, 'src/activity/hook-cli.ts'), ...scope] };
  if (kind === 'npx') return { command: 'npx', args: ['-y', 'codiluce', 'activity', 'hook', ...scope] };
  return { command: process.execPath, args: ['--no-warnings', path.join(tool, 'dist/src/activity/hook-cli.js'), ...scope] };
}

/** Produce a mergeable snippet; never overwrite an agent's existing settings. */
export function hookConfiguration(provider: AgentProvider, launch: Launch): { hooks: Record<string, unknown[]> } {
  const events = [...HOOK_EVENTS.filter(event => provider !== 'claude-code' || event !== 'Interrupt'), ...(provider === 'claude-code' ? ['PostToolUseFailure'] : [])];
  return { hooks: Object.fromEntries(events.map(event => [event, [{ hooks: [{ type: 'command', command: shellLine(launch), timeout: 10 }] }]])) };
}

export { forwardHook } from './forward.js';
