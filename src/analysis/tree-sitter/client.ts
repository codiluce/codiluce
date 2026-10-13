import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { deserialize } from 'node:v8';
import type { StructureFacts } from '../facts.js';

const WORKER = fileURLToPath(new URL('./native-worker.mjs', import.meta.url));
export class StructureParser<Facts = StructureFacts> {
  private child?: ChildProcess;
  private readonly retiring=new Set<ChildProcess>();
  private sequence = 0;
  private pending: Promise<void> = Promise.resolve();
  private generation = 0;
  private closing = 0;
  constructor(private readonly timeoutMs = 10_000, private readonly worker = WORKER, private readonly execArguments?:string[], private readonly resetOnReportedError=true) {}
  async parse(language: string, content: string, options: {objectiveCpp?:boolean;erbHost?:'html'|'javascript'|'css'|'unknown';razorKind?:'component'|'view';liquidHost?:'html'|'javascript'|'css'|'unknown';liquidEngine?:'shopify'|'unknown';liquidBodyTags?:boolean;nativeOnly?:boolean} = {}): Promise<Facts> {
    return this.request(language,{language,content,...options});
  }
  /** Shared cancellable transport for source-only parser services. */
  protected request(language:string,payload:Record<string,unknown>):Promise<Facts> {
    if (this.closing) return Promise.reject(Error('Parser worker is retiring'));
    const generation = this.generation;
    const result = this.pending.then(async () => {
      if (generation !== this.generation) throw Error('Parser request closed before dispatch');
      // The deadline belongs to the active source job, not the time spent
      // behind earlier jobs in the worker's synchronous IPC queue. Recovery
      // also proves that the previous native address space has disappeared.
      await this.waitForRetired();
      if (generation !== this.generation) throw Error('Parser request closed before dispatch');
      return this.dispatch(language, payload);
    });
    this.pending = result.then(() => {}, () => {});
    return result;
  }
  private dispatch(language:string,payload:Record<string,unknown>):Promise<Facts> {
    const child = this.start(), id = ++this.sequence;
    const started = process.hrtime.bigint(), deadline = started + BigInt(Math.ceil(this.timeoutMs * 1_000_000));
    return new Promise((resolve, reject) => {
      let settled = false;
      let completedBytes: number | undefined, expiry: ReturnType<typeof setImmediate> | undefined;
      let deliveryTimer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => { clearTimeout(timer); clearTimeout(deliveryTimer); clearImmediate(expiry); child.off('message', message); child.off('error', failure); child.off('exit', exited); };
      const failure = (error: Error) => { if (settled) return; settled = true; cleanup(); if (this.child === child) this.retire(); reject(error); };
      const exceeded = () => failure(new Error(`Parser exceeded ${this.timeoutMs} ms for ${language}`));
      const exited = (code: number | null, signal: string | null) => failure(new Error(`Parser worker exited (${signal ?? code})`));
      const message = (result: { id: number; type?: string; completedAtNs?: unknown; bytes?: unknown; payload?: unknown }) => {
        if (result.id !== id) return;
        if (settled) return;
        if (result.type === 'completed') {
          if (completedBytes !== undefined || typeof result.completedAtNs !== 'string' || !/^\d{1,20}$/.test(result.completedAtNs) || typeof result.bytes !== 'number' || !Number.isSafeInteger(result.bytes) || result.bytes < 1) {
            failure(Error('Invalid parser completion')); return;
          }
          // Forked workers share the host's monotonic clock. Include startup,
          // input delivery, parsing, extraction and response serialization in
          // the original budget, independently of the parent's busy loop.
          const completed = BigInt(result.completedAtNs);
          if (completed < started || completed > process.hrtime.bigint()) { failure(Error('Invalid parser completion clock')); return; }
          if (completed > deadline) { exceeded(); return; }
          completedBytes = result.bytes;
          clearTimeout(timer); clearImmediate(expiry);
          // A small completion frame precedes the encoded response. Bound a
          // missing payload by time the parent is idle and can receive IPC;
          // synchronous analysis must not consume this delivery allowance.
          const usage = performance.eventLoopUtilization();
          const awaitPayload = () => {
            const remaining = this.timeoutMs - performance.eventLoopUtilization(usage).idle;
            if (remaining <= 0) failure(Error(`Parser response exceeded ${this.timeoutMs} idle ms for ${language}`));
            else deliveryTimer = setTimeout(awaitPayload, Math.max(1, Math.ceil(remaining)));
          };
          deliveryTimer = setTimeout(awaitPayload, this.timeoutMs);
          return;
        }
        if (result.type !== 'result' || completedBytes === undefined || !Buffer.isBuffer(result.payload) || result.payload.byteLength !== completedBytes) {
          failure(Error('Invalid parser response')); return;
        }
        let decoded: {facts?: Facts; error?: string};
        try { decoded = deserialize(result.payload); if (!decoded || typeof decoded !== 'object') throw Error('Invalid parser response'); }
        catch { failure(Error('Invalid parser response')); return; }
        settled = true;
        cleanup();
        if (decoded.error || !decoded.facts) {
          // A WASM trap can leave the runtime/loaded parsers unusable. Never
          // reuse that process after a caught error. Providers which create a
          // fresh engine per job can opt out for ordinary reported source errors.
          if (this.child === child && (this.resetOnReportedError || !decoded.error)) this.retire();
          reject(new Error(decoded.error ?? 'Invalid parser result'));
        }
        else resolve(decoded.facts);
      };
      // Give pending IPC one poll before expiring. Only a worker completion
      // stamped inside the original deadline can cancel this expiry.
      const timer = setTimeout(() => { expiry = setImmediate(() => { if (completedBytes === undefined) exceeded(); }); }, this.timeoutMs);
      child.on('message', message); child.once('error', failure); child.once('exit', exited);
      child.send({ id,...payload }, error => { if (error) failure(error); });
    });
  }
  /** Only launches the process; no source job or optional compiler import. */
  protected start():ChildProcess {
    // Source-free prewarming uses this entry point too. It cannot bypass the
    // retirement barrier that guards queued source requests.
    if(this.closing||this.retiring.size)throw Error('Parser worker is retiring');
    if(this.child&&(this.child.exitCode!==null||this.child.signalCode!==null))this.retire();
    if (!this.child) this.child = fork(this.worker, [], {
      execArgv: this.execArguments ?? ['--max-old-space-size=256'],
      serialization: 'advanced', stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    return this.child;
  }
  close(): void {
    this.generation++;
    this.retire();
  }
  private retire(): void {
    const child=this.child;this.child=undefined;if(!child)return;
    if(child.pid&&child.exitCode===null&&child.signalCode===null){this.retiring.add(child);child.once('exit',()=>this.retiring.delete(child));}
    // Termination closes IPC itself. Explicit disconnect during a message
    // callback can null Node's channel while another decoded frame is still
    // queued; keep it intact until the process exits and pending frames drain.
    child.kill();
  }
  /** Wait for the native address space to disappear before starting another
   * parser phase. A deadline cannot silently authorize overlapping workers. */
  async closeAndWait():Promise<void> {
    this.closing++;
    try {
      this.close();
      await this.waitForRetired();
      await this.pending;
    } finally { this.closing--; }
  }
  private async waitForRetired():Promise<void> {
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
