import { fork, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StructureFacts } from '../facts.js';

const WORKER = fileURLToPath(new URL(`./worker${path.extname(fileURLToPath(import.meta.url))}`, import.meta.url));
function workerArguments(): string[] {
  const args: string[] = [];
  for (let index = 0; index < process.execArgv.length; index++) {
    const arg = process.execArgv[index]!;
    if (/^--(?:import|loader|experimental-loader)=/.test(arg) || ['--experimental-sqlite', '--enable-source-maps', '--no-warnings'].includes(arg)) args.push(arg);
    else if (['--import', '--loader', '--experimental-loader'].includes(arg) && process.execArgv[index + 1]) args.push(arg, process.execArgv[++index]!);
  }
  return [...args, '--max-old-space-size=256'];
}
export class StructureParser {
  private child?: ChildProcess;
  private sequence = 0;
  constructor(private readonly timeoutMs = 10_000) {}
  async parse(language: string, content: string): Promise<StructureFacts> {
    if (!this.child) this.child = fork(WORKER, [], {
      execArgv: workerArguments(),
      serialization: 'advanced', stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const child = this.child, id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); child.off('message', message); child.off('error', failure); child.off('exit', exited); };
      const failure = (error: Error) => { cleanup(); if (this.child === child) this.close(); reject(error); };
      const exited = (code: number | null, signal: string | null) => failure(new Error(`Parser worker exited (${signal ?? code})`));
      const message = (result: { id: number; facts?: StructureFacts; error?: string }) => {
        if (result.id !== id) return;
        cleanup();
        if (result.error || !result.facts) reject(new Error(result.error ?? 'Invalid parser result'));
        else resolve(result.facts);
      };
      const timer = setTimeout(() => failure(new Error(`Parser exceeded ${this.timeoutMs} ms for ${language}`)), this.timeoutMs);
      child.on('message', message); child.once('error', failure); child.once('exit', exited);
      child.send({ id, language, content }, error => { if (error) failure(error); });
    });
  }
  close(): void { const child = this.child; this.child = undefined; if (child) { if (child.connected) child.disconnect(); child.kill(); } }
}
