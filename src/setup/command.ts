// `codiluce setup`: the first-run questions, asked again whenever the user
// wants (API keys, describing the code, connecting agents), and loads all Git history.
// Estimates use the last analysis; nothing is analyzed or served here.
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from '../core/config.js';
import { toolDirectory } from '../launcher.js';
import { describeEstimate } from './start.js';
import { installKind, packageVersion, readState } from './settings.js';
import { createTerminal, Writer } from './terminal.js';
import { printSummary, runSetup } from './wizard.js';

export async function setupCommand(options: { repo?: string; stateDirectory?: string }): Promise<number> {
  const terminal = createTerminal();
  const w = new Writer(terminal);
  if (!terminal.interactive) { console.error('codiluce setup asks questions, so it needs a terminal. Edit .codiluce/config.yml (history, annotations) instead.'); return 1; }
  const root = await realpath(options.repo ?? process.cwd());
  const stateDirectory = path.resolve(options.stateDirectory ?? path.join(root, '.codiluce'));
  const config = await loadConfig(root, stateDirectory);
  const tool = await toolDirectory();
  const version = packageVersion(tool);
  const { c, s } = w;
  w.write();
  w.write(`  ${c.accent(s.mark)}  ${c.bold('codiluce')} ${c.dim(version)}  ${c.muted('Setup')}`);
  w.write();
  const context = {
    root, stateDirectory, repositoryName: config.repository.name, toolDirectory: tool, kind: installKind(tool, root), version,
    analysisMs: readState(stateDirectory).analysisMs,
    base: { repository: config.repository, applications: config.applications, maxFileBytes: config.maxFileBytes },
    estimateDescriptions: () => describeEstimate(root, stateDirectory),
  };
  const result = await runSetup(w, context, { mode: 'ask' });
  printSummary(w, result, context);
  w.write();
  w.write(`  ${c.muted('Run')} ${c.bold('codiluce start')} ${c.muted('to open the map with your Git history ready.')}`);
  w.write();
  return 0;
}
