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
  private readonly retiring=new Set<ChildProcess>();
  private sequence = 0;
  constructor(private readonly timeoutMs = 10_000, private readonly worker = WORKER, private readonly execArguments?:string[], private readonly resetOnReportedError=true) {}
  async parse(language: string, content: string, options: {objectiveCpp?:boolean;erbHost?:'html'|'javascript'|'css'|'unknown';razorKind?:'component'|'view';liquidHost?:'html'|'javascript'|'css'|'unknown';liquidEngine?:'shopify'|'unknown';liquidBodyTags?:boolean;nativeOnly?:boolean} = {}): Promise<StructureFacts> {
    return this.request(language,{language,content,...options});
  }
  /** Shared cancellable transport for source-only parser services. */
  protected async request(language:string,payload:Record<string,unknown>):Promise<StructureFacts> {
    const child = this.start(), id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); child.off('message', message); child.off('error', failure); child.off('exit', exited); };
      const failure = (error: Error) => { cleanup(); if (this.child === child) this.close(); reject(error); };
      const exited = (code: number | null, signal: string | null) => failure(new Error(`Parser worker exited (${signal ?? code})`));
      const message = (result: { id: number; facts?: StructureFacts; error?: string }) => {
        if (result.id !== id) return;
        cleanup();
        if (result.error || !result.facts) {
          // A WASM trap can leave the runtime/loaded parsers unusable. Never
          // reuse that process after a caught error. Providers which create a
          // fresh engine per job can opt out for ordinary reported source errors.
          if (this.child === child && (this.resetOnReportedError || !result.error)) this.close();
          reject(new Error(result.error ?? 'Invalid parser result'));
        }
        else resolve(result.facts);
      };
      const timer = setTimeout(() => failure(new Error(`Parser exceeded ${this.timeoutMs} ms for ${language}`)), this.timeoutMs);
      child.on('message', message); child.once('error', failure); child.once('exit', exited);
      child.send({ id,...payload }, error => { if (error) failure(error); });
    });
  }
  /** Only launches the process; no source job or optional compiler import. */
  protected start():ChildProcess {
    if(this.child&&(this.child.exitCode!==null||this.child.signalCode!==null))this.close();
    if (!this.child) this.child = fork(this.worker, [], {
      execArgv: this.execArguments ?? workerArguments(),
      serialization: 'advanced', stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    return this.child;
  }
  close(): void {
    const child=this.child;this.child=undefined;if(!child)return;
    if(child.pid&&child.exitCode===null&&child.signalCode===null){this.retiring.add(child);child.once('exit',()=>this.retiring.delete(child));}
    if(child.connected)child.disconnect();child.kill();
  }
  /** Wait for the native address space to disappear before starting another
   * parser phase. A deadline cannot silently authorize overlapping workers. */
  async closeAndWait():Promise<void> {
    this.close();
    // Include generations retired by deadlines/exits/reported failures, not
    // just the most recent successful worker.
    await Promise.all([...this.retiring].map(child=>new Promise<void>((resolve,reject)=>{
      if(child.exitCode!==null||child.signalCode!==null){resolve();return;}
      let deadline:ReturnType<typeof setTimeout>;
      const cleanup=()=>{clearTimeout(deadline);child.off('exit',exited);child.off('error',failed);};
      const exited=()=>{cleanup();resolve();};
      const failed=(error:Error)=>{cleanup();reject(error);};
      child.once('exit',exited);child.once('error',failed);
      deadline=setTimeout(()=>{child.kill('SIGKILL');deadline=setTimeout(()=>{cleanup();reject(Error('Parser worker did not terminate'));},1000);},1000);
    })));
  }
}
