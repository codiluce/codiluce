#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

async function main() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 12)) {
    throw new Error(`Codiluce requires Node.js >=22.12.0; you are running ${process.version}.`);
  }
  const args = process.argv.slice(2);
  if (args.length === 1 && (args[0] === '--version' || args[0] === '-v')) {
    console.log(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
    return;
  }
  const cli = new URL('../dist/src/cli.js', import.meta.url);
  if (!existsSync(cli)) {
    throw new Error('The compiled Codiluce CLI is missing. Run npm run build:cli in a source checkout, or reinstall Codiluce.');
  }
  // Node 22.12 needs a startup flag; newer releases expose SQLite directly.
  // Running in the same process when possible also preserves normal signals.
  if (process.getBuiltinModule('node:sqlite')) {
    await import(cli.href);
    return;
  }
  const child = spawn(process.execPath, ['--experimental-sqlite', fileURLToPath(cli), ...args], { stdio: 'inherit' });
  const interrupt = () => { if (!child.killed) child.kill('SIGINT'); };
  const terminate = () => { if (!child.killed) child.kill('SIGTERM'); };
  const cleanup = () => { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  child.once('error', error => { cleanup(); console.error(error.message); process.exitCode = 1; });
  child.once('exit', (code, signal) => {
    cleanup();
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  });
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
