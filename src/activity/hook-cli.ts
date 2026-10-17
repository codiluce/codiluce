// Lightweight hook entry: avoid loading analyzers, SQLite or the visualizer per tool call.
import { parseArgs } from 'node:util';
import path from 'node:path';
import { forwardHook } from './forward.js';
import { harnessId } from '../harnesses/registry.js';
let provider: ReturnType<typeof harnessId>, profile: string | undefined, event: string | undefined;
try {
  const { values } = parseArgs({ options: { agent: { type: 'string' }, profile: { type: 'string' }, event: { type: 'string' }, repo: { type: 'string' }, 'state-dir': { type: 'string' } } });
  provider = harnessId(values.agent); profile = values.profile; event = values.event;
  if (provider) await forwardHook(provider, path.resolve(values['state-dir'] ?? path.join(values.repo ?? process.cwd(), '.codiluce')), process.stdin, { profile, event });
} catch { /* A hook observer never blocks agent work. */ }
finally {
  // Native response contracts: no permission decision, context or tool changes.
  if (provider === 'cline') process.stdout.write(profile === 'cline-legacy' ? '{"cancel":false}\n' : '{}\n');
  else if (provider === 'cursor') process.stdout.write('{}\n');
  else if (provider === 'antigravity') process.stdout.write(event === 'Stop' ? '{"decision":"stop"}\n' : '{}\n');
}
