// Lightweight hook entry: avoid loading analyzers, SQLite or the visualizer per tool call.
import { parseArgs } from 'node:util';
import path from 'node:path';
import { forwardHook } from './forward.js';
try {
  const { values } = parseArgs({ options: { agent: { type: 'string' }, repo: { type: 'string' }, 'state-dir': { type: 'string' } } });
  if (values.agent === 'codex' || values.agent === 'claude-code') await forwardHook(values.agent, path.resolve(values['state-dir'] ?? path.join(values.repo ?? process.cwd(), '.codiluce')), process.stdin);
} catch { /* A hook observer never blocks agent work. */ }
