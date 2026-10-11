import type { AnalyzedCommit } from './indexer.js';

export type WorkerResult = { type: 'result'; result: AnalyzedCommit } | { type: 'error'; sha: string; message: string };
export interface WorkerAcknowledgment { type: 'stored'; sha: string }

/** An IPC write callback only means the bytes were handed to the channel.
 * Wait until the parent finishes handling this commit before materializing
 * another graph. Each worker can retain at most one unacknowledged result. */
export function publishHistoryResult(message: WorkerResult): Promise<void> {
  const sha = message.type === 'result' ? message.result.sha : message.sha;
  return new Promise((resolve, reject) => {
    const cleanup = () => { process.off('message', received); process.off('disconnect', disconnected); process.off('error', failed); };
    const failed = (error: Error) => { cleanup(); reject(error); };
    const disconnected = () => failed(new Error('History parent disconnected before acknowledging the result'));
    const received = (ack: unknown) => {
      if (!ack || typeof ack !== 'object' || !('type' in ack) || ack.type !== 'stored' || !('sha' in ack) || ack.sha !== sha) return;
      cleanup(); resolve();
    };
    if (!process.connected || !process.send) { disconnected(); return; }
    process.on('message', received); process.once('disconnect', disconnected); process.once('error', failed);
    try { process.send(message, error => { if (error) failed(error); }); }
    catch (error) { failed(error instanceof Error ? error : new Error(String(error))); }
  });
}
