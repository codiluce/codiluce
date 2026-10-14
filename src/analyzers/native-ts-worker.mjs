// Source-only bootstrap. Production loads compiled Codiluce, never target modules.
import { existsSync } from 'node:fs';
import { deserialize, serialize } from 'node:v8';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

if (!process.send) throw Error('TypeScript worker requires its own IPC channel');
// Report optional parser ownership before dispatching any of its source jobs.
// The parent also owns the POSIX process group for fatal bootstrap/heap exits.
const fork = cp.fork;
const children = new Set();
let intentionalDisconnect = false;
process.once('disconnect', () => {
  if (intentionalDisconnect) return;
  for (const child of children) child.kill('SIGKILL');
  if (process.platform !== 'win32') { try { process.kill(-process.pid, 'SIGKILL'); } catch { /* no owned process group */ } }
  process.exit(1);
});
cp.fork = (...args) => {
  const child = fork(...args);
  if (child.pid) {
    children.add(child);
    process.send({ type: 'child-started', pid: child.pid });
    child.once('exit', () => { children.delete(child); if (process.connected) process.send({ type: 'child-closed', pid: child.pid }); });
  }
  return child;
};
syncBuiltinESMExports();
process.once('message', async message => {
  try {
    if (!Buffer.isBuffer(message) || message.length > 64 * 1024 * 1024) throw Error('Invalid TypeScript worker input');
    const entry = new URL('./ts-worker.js', import.meta.url);
    const { analyzeTypeScriptWorker } = await import(existsSync(entry) ? entry.href : new URL('./ts-worker.ts', import.meta.url).href);
    const result = serialize(await analyzeTypeScriptWorker(deserialize(message)));
    if (result.length > 64 * 1024 * 1024) throw Error('TypeScript worker output exceeds 64 MiB');
    process.send(result, error => { process.exitCode = error ? 1 : 0; intentionalDisconnect = true; if (process.connected) process.disconnect(); });
  } catch (error) {
    process.exitCode = 1;
    process.send({ error: String(error).slice(0, 4096) }, () => { intentionalDisconnect = true; if (process.connected) process.disconnect(); });
  }
});
