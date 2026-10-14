// Source-only bootstrap. Production loads compiled Codiluce, never target modules.
import { existsSync } from 'node:fs';
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
    let maxBytes = 64 * 1024 * 1024, policy;
    const seen = new Set();
    for (const arg of process.argv.slice(2)) {
      const name = arg.split('=', 1)[0];
      if (seen.has(name)) throw Error('Duplicate owned compiler transfer limit');
      seen.add(name);
      if (/^--max-message-bytes=\d+$/.test(arg)) maxBytes = Number(arg.slice('--max-message-bytes='.length));
      else if (/^--codec-limits=[\w-]{1,1024}$/.test(arg)) {
        policy = JSON.parse(Buffer.from(arg.slice('--codec-limits='.length), 'base64url').toString());
        if (!policy || typeof policy !== 'object' || Array.isArray(policy)) throw Error('Invalid owned compiler structural limits');
      } else throw Error('Invalid owned compiler transfer argument');
    }
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 64 * 1024 * 1024) throw Error('Invalid owned compiler transfer limit');
    if (!Buffer.isBuffer(message) || message.length > maxBytes) throw Error('Invalid TypeScript worker input');
    const entry = new URL('./ts-worker.js', import.meta.url);
    const { analyzeTypeScriptWorker } = await import(existsSync(entry) ? entry.href : new URL('./ts-worker.ts', import.meta.url).href);
    const codec = new URL('./ts-worker-codec.js', import.meta.url);
    const { encodeTypeScriptPayload, decodeTypeScriptPayload } = await import(existsSync(codec) ? codec.href : new URL('./ts-worker-codec.ts', import.meta.url).href);
    const result = encodeTypeScriptPayload(await analyzeTypeScriptWorker(decodeTypeScriptPayload(message, maxBytes, undefined, policy)), maxBytes, undefined, policy);
    process.send(result, error => { process.exitCode = error ? 1 : 0; intentionalDisconnect = true; if (process.connected) process.disconnect(); });
  } catch (error) {
    process.exitCode = 1;
    process.send({ error: String(error).slice(0, 4096) }, () => { intentionalDisconnect = true; if (process.connected) process.disconnect(); });
  }
});
