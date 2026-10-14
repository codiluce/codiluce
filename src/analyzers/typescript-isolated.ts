import { fork } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deserialize, serialize } from 'node:v8';
import type { Analyzer, AnalysisContext } from '../core/analyzer.js';
import { ANALYZER_VERSION } from '../core/graph.js';
import { typescriptFrameworkPacks } from '../analysis/frameworks/index.js';
import { applyGraphPatch } from '../pipeline/cache.js';
import { TYPESCRIPT_WORKER_LIMITS, TYPESCRIPT_WORKER_PROTOCOL, type TypeScriptWorkerRequest, type TypeScriptWorkerResult } from './ts-worker-protocol.js';
import { typescriptAnalyzer } from './typescript.js';
import { embeddedAnalyzer, EMBEDDED_VERSION } from '../analysis/embedded/index.js';
import { encodeTypeScriptPayload, decodeTypeScriptPayload, TypeScriptCodecLimitError } from './ts-worker-codec.js';

const WORKER = fileURLToPath(new URL('./native-ts-worker.mjs', import.meta.url));
const activeWorkers = new Map<ReturnType<typeof fork>, Set<number>>();
function killOwned(child: ReturnType<typeof fork>, children: Set<number>): void {
  if (child.pid) { try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* already retired */ } }
  for (const pid of children) { try { process.kill(pid, 'SIGKILL'); } catch { /* already retired */ } }
}
function ownerExit(): void { for (const [child, children] of activeWorkers) killOwned(child, children); }
function ownerSignal(signal: 'SIGINT' | 'SIGTERM'): void {
  ownerExit();
  // Preserve an application's own shutdown handler. With no such handler,
  // restore Node's signal termination after retiring our owned processes.
  const ours = signal === 'SIGINT' ? ownerInt : ownerTerm;
  if (!process.listeners(signal).some(listener => listener !== ours)) { process.off(signal, ours); process.kill(process.pid, signal); }
}
function ownerInt(): void { ownerSignal('SIGINT'); }
function ownerTerm(): void { ownerSignal('SIGTERM'); }
function watchOwner(): void { if (activeWorkers.size === 1) { process.on('exit', ownerExit); process.on('SIGINT', ownerInt); process.on('SIGTERM', ownerTerm); } }
function unwatchOwner(child: ReturnType<typeof fork>): void { activeWorkers.delete(child); if (!activeWorkers.size) { process.off('exit', ownerExit); process.off('SIGINT', ownerInt); process.off('SIGTERM', ownerTerm); } }
export interface TypeScriptWorkerOptions { worker?: string; oldSpaceMiB?: number; semiSpaceMiB?: number; maxMessageBytes?: number }
export class TypeScriptWorkerError extends Error {
  constructor(message: string, readonly pid: number | undefined, readonly code: number | null, readonly signal: NodeJS.Signals | null, readonly stderr: string) { super(message); this.name = 'TypeScriptWorkerError'; }
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); } catch { return false; }
  if (process.platform === 'linux') {
    try { const stat = readFileSync(`/proc/${pid}/stat`, 'utf8'), state = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0]; if (state === 'Z' || state === 'X') return false; } catch { return false; }
  }
  return true;
}
function groupAlive(pid: number): boolean {
  if (process.platform === 'win32') return false;
  try { process.kill(-pid, 0); } catch { return false; }
  if (process.platform !== 'linux') return true;
  // Zombies have already released their address spaces. Enumerate only when
  // the owned group still exists, including development-loader descendants.
  return readdirSync('/proc').some(name => {
    if (!/^\d+$/.test(name)) return false;
    try { const stat = readFileSync(`/proc/${name}/stat`, 'utf8'), fields = stat.slice(stat.lastIndexOf(')') + 2).split(' '); return Number(fields[2]) === pid && fields[0] !== 'Z' && fields[0] !== 'X'; } catch { return false; }
  });
}
async function retireChildren(pid: number | undefined, children: Set<number>): Promise<void> {
  if (pid && process.platform !== 'win32') { try { process.kill(-pid, 'SIGKILL'); } catch { /* already retired */ } }
  for (const child of children) { try { process.kill(child, 'SIGKILL'); } catch { /* already retired */ } }
  const deadline = performance.now() + 2000;
  while ([...children].some(alive) || !!pid && groupAlive(pid)) {
    if (performance.now() >= deadline) throw Error('TypeScript worker descendants did not retire');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
/** An owned-worker seam for conformance probes; target repositories cannot
 * select a worker or override the default indexer's fixed limits. */
export async function runTypeScriptWorker(request: TypeScriptWorkerRequest, options: TypeScriptWorkerOptions = {}): Promise<TypeScriptWorkerResult> {
  const worker = options.worker ?? WORKER, old = options.oldSpaceMiB ?? TYPESCRIPT_WORKER_LIMITS.oldSpaceMiB, young = options.semiSpaceMiB ?? TYPESCRIPT_WORKER_LIMITS.semiSpaceMiB, maxBytes = options.maxMessageBytes ?? TYPESCRIPT_WORKER_LIMITS.maxMessageBytes;
  for (const value of [old, young, maxBytes]) if (!Number.isSafeInteger(value) || value < 1) throw Error('TypeScript worker limits require positive safe integers');
  let payload: Buffer;
  try { payload = worker === WORKER ? encodeTypeScriptPayload(request, maxBytes) : serialize(request); }
  catch (error) { if (error instanceof TypeScriptCodecLimitError) throw Error(`TypeScript worker input exceeds ${maxBytes} bytes`); throw error; }
  if (payload.length > maxBytes) throw Error(`TypeScript worker input exceeds ${maxBytes} bytes`);
  const execArgv = [`--max-old-space-size=${old}`, `--max-semi-space-size=${young}`];
  if (worker === WORKER && !existsSync(new URL('./ts-worker.js', import.meta.url))) execArgv.push('--import', createRequire(import.meta.url).resolve('tsx'));
  // Caller hooks, inspectors, loaders and NODE_OPTIONS must not expand the
  // compiler budget or execute inside the child. The owned source loader is
  // needed only for development; an installed package uses ordinary JS.
  const env = { ...process.env }; delete env.NODE_OPTIONS; delete env.NODE_PATH;
  const args = worker === WORKER && maxBytes < TYPESCRIPT_WORKER_LIMITS.maxMessageBytes ? [`--max-message-bytes=${maxBytes}`] : [];
  const child = fork(worker, args, { cwd: path.dirname(worker), execArgv, env, detached: process.platform !== 'win32', serialization: 'advanced', stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  return new Promise((resolve, reject) => {
    let response: TypeScriptWorkerResult | undefined, failure: Error | undefined, stderr = '', stderrBytes = 0;
    const children = new Set<number>();
    activeWorkers.set(child, children); watchOwner();
    const stop = (error: Error) => {
      failure ??= error;
      killOwned(child, children);
    };
    child.stderr!.on('data', (chunk: Buffer) => {
      const take = Math.max(0, TYPESCRIPT_WORKER_LIMITS.maxStderrBytes - stderrBytes);
      stderr += chunk.subarray(0, take).toString(); stderrBytes += Math.min(chunk.length, take);
    });
    child.on('message', message => {
      if (message && typeof message === 'object' && !Buffer.isBuffer(message) && 'type' in message && 'pid' in message && Number.isSafeInteger(message.pid) && Number(message.pid) > 0 && message.pid !== child.pid) {
        if (message.type === 'child-started') { const duplicate = children.has(Number(message.pid)); children.add(Number(message.pid)); if (duplicate || children.size > 1) stop(Error('Overlapping TypeScript parser children')); return; }
        if (message.type === 'child-closed' && children.delete(Number(message.pid))) return;
      }
      if (response || failure) { stop(Error('Duplicate TypeScript worker response')); return; }
      if (!Buffer.isBuffer(message)) { stop(Error(`TypeScript worker failed: ${typeof message === 'object' && message && 'error' in message ? String(message.error) : 'invalid response'}`)); return; }
      if (message.length > maxBytes) { stop(Error(`TypeScript worker output exceeds ${maxBytes} bytes`)); return; }
      try {
        const result = (worker === WORKER ? decodeTypeScriptPayload(message, maxBytes) : deserialize(message)) as TypeScriptWorkerResult;
        const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');
        if (!result || result.protocol !== TYPESCRIPT_WORKER_PROTOCOL || !result.patch || !strings(result.sourceReads) || !strings(result.typescriptFiles) || !Array.isArray(result.sourceFailures) || !result.sourceFailures.every(item => Array.isArray(item) && item.length === 2 && item.every(value => typeof value === 'string')) || !Array.isArray(result.cacheEvents) || !result.cacheEvents.every(event => typeof event.analyzer === 'string' && typeof event.unit === 'string' && typeof event.hit === 'boolean' && Number.isFinite(event.ms) && event.ms >= 0) || result.usage?.pid !== child.pid || !Number.isSafeInteger(result.usage.heapLimitBytes) || result.usage.heapLimitBytes > (old + 3 * young) * 1024 * 1024) throw Error('Invalid TypeScript worker result');
        response = result;
      } catch (error) { stop(error instanceof Error ? error : Error(String(error))); }
    });
    child.once('error', stop);
    child.once('close', async (code, signal) => {
      // A fatal compiler exit cannot run finally. Its POSIX process group also
      // owns optional framework children, so terminate that group on failure.
      if (code !== 0 || signal || !response) stop(Error(`TypeScript worker exited (${signal ?? code})${stderr ? `: ${stderr}` : ''}`));
      try { await retireChildren(child.pid, children); }
      catch (error) { failure = error instanceof Error ? error : Error(String(error)); }
      unwatchOwner(child);
      if (failure) reject(new TypeScriptWorkerError(failure.message, child.pid, code, signal, stderr)); else resolve(response!);
    });
    child.send(payload, error => { if (error) stop(error); });
  });
}
export function typeScriptWorkerRequest(context: AnalysisContext): TypeScriptWorkerRequest {
  const { root, config, repositoryId, applicationIds, files, http, revision, directoryInventory, scannedDirectories, fileInventory } = context;
  return { protocol: TYPESCRIPT_WORKER_PROTOCOL, context: { root, config, repositoryId, applicationIds, files, http, revision, directoryInventory, scannedDirectories, fileInventory }, graph: { namespace: context.graph.namespace, entities: [...context.graph.entities.values()], relations: [...context.graph.relations.values()], diagnostics: [...context.graph.diagnostics.values()] }, embedded: context.embedded?.snapshot(), prepareEmbedded: context.embeddedPreparationPending, sourceFailures: [...context.sources?.failures ?? []], cache: context.cache ? { directory: context.cache.directory, limits: context.cache.limits } : undefined, packs: typescriptFrameworkPacks.map(pack => [pack.id, pack.version]) };
}
/** Preserve the analyzer ordering and its ordinary disabled-file outcomes;
 * component extraction and recipe binding run inside the semantic worker. */
export const isolatedEmbeddedAnalyzer: Analyzer = {
  name: 'embedded-source', version: EMBEDDED_VERSION,
  async analyze(context) {
    if ([...context.files.values()].some(file => file.analyzable && ['vue', 'svelte', 'astro'].includes(file.language ?? ''))) context.embeddedPreparationPending = true;
    else await embeddedAnalyzer.analyze(context);
  },
};
export const isolatedTypescriptAnalyzer: Analyzer = {
  name: 'typescript-nextjs', version: ANALYZER_VERSION,
  async analyze(context) {
    // Empty/non-Node scans need no compiler construction. Indexed compiler
    // configuration still requires isolation even when it selects no roots.
    const compilerInputs = [...context.files.values()].some(file => file.analyzable && (['typescript', 'javascript', 'vue', 'svelte', 'astro'].includes(file.language ?? '') || /(?:^|\/)(?:ts|js)config[^/]*\.json$/.test(file.path)));
    if (!compilerInputs && !context.embeddedPreparationPending) { await typescriptAnalyzer.analyze(context); return; }
    const result = await runTypeScriptWorker(typeScriptWorkerRequest(context));
    if (!applyGraphPatch(context, result.patch)) throw Error('TypeScript worker graph patch does not fit the indexed graph');
    context.typescriptFiles = new Set(result.typescriptFiles);
    context.embeddedPreparationPending = false;
    for (const file of result.sourceReads) context.sourceReads?.add(file);
    for (const [file, reason] of result.sourceFailures) context.sources?.failures.set(file, reason);
    context.cache?.acceptEvents(result.cacheEvents);
    context.embedded?.clearTextMemo();
  },
};
