// Prepare the complete Git file timeline without running historical analyzers.
import { FileHistory } from '../history/file-history.js';
import { listCommits } from '../history/git.js';
import type { GitFacts } from './settings.js';
import { spinner, type Writer } from './terminal.js';

export async function prepareGitHistory(w: Writer, root: string, stateDirectory: string, facts: GitFacts, readOnly = false): Promise<number | undefined> {
  if (!facts.repository) { w.note('History: not a Git repository, so there is no history to index.', w.c.muted); return undefined; }
  if (!facts.topLevel) { w.note('History: start Codiluce at the top-level folder of the Git repository to index its history.', w.c.muted); return undefined; }
  if (!facts.commits) { w.note('History: no commits yet.', w.c.muted); return 0; }
  if (facts.shallow) w.note('History: shallow clone; indexing all available commits. Run git fetch --unshallow to include older history.', w.c.muted);
  const count = (commits: number) => `${commits.toLocaleString('en-US')} commit${commits === 1 ? '' : 's'}`;
  const progress = spinner(w);
  progress.start(`Loading all ${count(facts.commits)} and file changes from Git…`);
  try {
    const commits = await listCommits(root, { ref: 'HEAD' });
    await new FileHistory(root, stateDirectory, readOnly).load(commits);
    progress.stop(`History: all ${count(commits.length)} and file changes ready`, 'ok');
    return commits.length;
  } catch (error) {
    progress.stop(`History unavailable: ${error instanceof Error ? error.message : String(error)}`, 'error');
    return undefined;
  }
}
