import path from 'node:path';
import { readFile } from 'node:fs/promises';
import type { AgentProvider } from './model.js';
/** A quiet, fail-open observer. The bridge has no model credentials and never prints hook decisions. */
export async function forwardHook(provider: AgentProvider, stateDirectory: string, input: AsyncIterable<Uint8Array | string>, options: { event?: string; profile?: string } = {}): Promise<void> {
  try {
    let bytes = 0; const chunks: Buffer[] = [];
    for await (const chunk of input) { const buffer = Buffer.from(chunk); bytes += buffer.length; if (bytes > 256 * 1024) return; chunks.push(buffer); }
    const payload: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
    Object.assign(payload, { codiluce_cwd: process.cwd(), ...(options.event ? { codiluce_event: options.event } : {}) });
    const endpoint = JSON.parse(await readFile(path.join(stateDirectory, 'serve.json'), 'utf8')) as { url?: string };
    const url = new URL('/api/agents/events', endpoint.url);
    if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) || url.username || url.password) return;
    await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Codiluce-Request': 'activity' }, body: JSON.stringify({ provider, payload }), signal: AbortSignal.timeout(1500), redirect: 'error' });
  } catch { /* Observation must not interrupt the agent, including when the map is stopped. */ }
}
