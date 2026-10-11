// Own IPC probe, not target repository code. Exposes loop progress while the
// parent deliberately withholds/misroutes acknowledgments or disconnects.
import { publishHistoryResult } from '../../src/history/worker-channel.js';
let completed = 0;
process.on('message', (message: { type?: string; id?: number }) => {
  if (message.type === 'probe') process.send?.({ type: 'probe', id: message.id, completed });
});
process.once('message', async () => {
  try {
    for (let i = 0; i < 3; i++) {
      await publishHistoryResult({ type: 'error', sha: `commit-${i}`, message: 'probe' }); completed++;
    }
    process.send?.({ type: 'complete', completed }, () => process.disconnect());
  } catch (error) {
    process.stdout.write(JSON.stringify({ disconnected: true, completed, error: String(error) }));
    process.exitCode = 0;
  }
});
