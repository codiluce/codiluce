// Child process of the history indexer: materializes and analyzes a
// contiguous run of commits and sends each graph back to the parent, which
// owns the store.
import { rmSync } from 'node:fs';
import { analyzeCommit, type WorkerJob } from './indexer.js';
import { TreeMirror } from './git.js';
import { publishHistoryResult } from './worker-channel.js';
process.once('message', async (job: WorkerJob) => {
  const cleanup = () => rmSync(job.directory, { recursive: true, force: true });
  process.once('SIGINT', () => { cleanup(); process.exit(130); });
  process.once('SIGTERM', () => { cleanup(); process.exit(143); });
  const disconnected = () => { cleanup(); process.exit(1); };
  process.once('disconnect', disconnected);
  const mirror = new TreeMirror(job.root, job.directory);
  try {
    for (const sha of job.commits) {
      try { await publishHistoryResult({ type: 'result', result: await analyzeCommit(mirror, job.raw, sha) }); }
      catch (error) {
        if (!process.connected) throw error;
        await publishHistoryResult({ type: 'error', sha, message: error instanceof Error ? error.message : String(error) });
      }
    }
  } finally {
    cleanup();
    process.off('disconnect', disconnected);
    if (process.connected) process.disconnect();
  }
});
