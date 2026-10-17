// Lightweight hook entry: avoid loading analyzers, SQLite or the visualizer per tool call.
import { parseArgs } from 'node:util';
import path from 'node:path';
import { forwardHook, neutralHookOutput } from './forward.js';
import { harnessId } from '../harnesses/registry.js';
let provider: ReturnType<typeof harnessId>, profile: string | undefined, event: string | undefined;
try {
  const args = process.argv.slice(2);
  const { values } = parseArgs({ args: args[0] === 'activity' && args[1] === 'hook' ? args.slice(2) : args, options: { agent: { type: 'string' }, profile: { type: 'string' }, event: { type: 'string' }, repo: { type: 'string' }, 'state-dir': { type: 'string' } } });
  provider = harnessId(values.agent); profile = values.profile; event = values.event;
  if (provider) await forwardHook(provider, path.resolve(values['state-dir'] ?? path.join(values.repo ?? process.cwd(), '.codiluce')), process.stdin, { profile, event });
} catch { /* A hook observer never blocks agent work. */ }
finally {
  // Native response contracts: no permission decision, context or tool changes.
  process.stdout.write(neutralHookOutput(provider, profile, event));
}
