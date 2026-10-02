// Child process of the history indexer: materializes and analyzes a
// contiguous run of commits and sends each graph back to the parent, which
// owns the store.
import { rmSync } from 'node:fs';
import { analyzeCommit, type WorkerJob, type WorkerMessage } from './indexer.js';
import { TreeMirror } from './git.js';

function send(message: WorkerMessage): Promise<void> {
  return new Promise((resolve, reject) => process.send!(message, undefined, undefined, error => error ? reject(error) : resolve()));
}
process.once('message', async (job: WorkerJob) => {
  const cleanup = () => rmSync(job.directory, { recursive: true, force: true });
  process.once('SIGINT', () => { cleanup(); process.exit(130); });
  process.once('SIGTERM', () => { cleanup(); process.exit(143); });
  const mirror = new TreeMirror(job.root, job.directory);
  try {
    for (const sha of job.commits) {
      try { await send({ type: 'result', result: await analyzeCommit(mirror, job.raw, sha) }); }
      catch (error) { await send({ type: 'error', sha, message: error instanceof Error ? error.message : String(error) }); }
    }
  } finally {
    cleanup();
    process.disconnect();
  }
});
