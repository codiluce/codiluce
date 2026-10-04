// Flow overlay routes: the only data the server writes by default.
//
//   GET    /api/flows             { storage, writable, flows }
//   POST   /api/flows             create { id?, name, type, steps }
//   PUT    /api/flows/:id         replace { name, type, steps, revision } (409 when the revision is stale)
//   DELETE /api/flows/:id
//   POST   /api/flows/import      { flows }: bring in flows kept in a browser
//
// Writes must come from the visualizer itself: a JSON body, the
// `X-Archipelago-Request: flows` header (a cross-origin page cannot send it
// without a CORS preflight, which this server never grants), a Host that is
// this loopback server (no DNS rebinding) and, when the browser sends one, an
// Origin of that same host. `serve --read-only` turns every write off.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { FlowError, type FlowStore } from '../storage/flows.js';
import type { GraphStore } from '../storage/sqlite.js';

export const FLOW_REQUEST_HEADER = 'x-archipelago-request';
const FLOW_BODY_LIMIT = 64 * 1024, IMPORT_BODY_LIMIT = 2 * 1024 * 1024;
export interface FlowRouteContext { store: GraphStore; flows?: FlowStore; writable: boolean }
export function isFlowPath(pathname: string): boolean { return pathname === '/api/flows' || pathname.startsWith('/api/flows/'); }

const LOOPBACK = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/;
/**
 * Whether a write request comes from the visualizer on this machine; the
 * reason when not. The Host and Origin may name another loopback port: the
 * development UI proxies /api from its own port.
 */
export function writeRefusal(request: IncomingMessage, header: string): string | undefined {
  if (request.headers[FLOW_REQUEST_HEADER] !== header) return `Expected the X-Archipelago-Request: ${header} header`;
  if (!LOOPBACK.test(request.headers.host ?? '')) return 'Writes are accepted only through a loopback address';
  const origin = request.headers.origin;
  if (origin !== undefined && !(origin.startsWith('http://') && LOOPBACK.test(origin.slice('http://'.length)))) return 'Cross-origin writes are refused';
  return undefined;
}
async function body(request: IncomingMessage, limit: number): Promise<unknown> {
  if (!/^application\/json\b/.test(request.headers['content-type'] ?? '')) throw new FlowError(415, 'Expected a JSON body');
  let text = '';
  for await (const chunk of request) { text += chunk; if (text.length > limit) throw new FlowError(413, 'Request too large'); }
  try { return JSON.parse(text); } catch { throw new FlowError(400, 'Invalid JSON'); }
}

export async function handleFlowRoute(context: FlowRouteContext, request: IncomingMessage, response: ServerResponse, pathname: string): Promise<void> {
  const send = (status: number, value: unknown) => { response.writeHead(status).end(value === undefined ? undefined : JSON.stringify(value)); };
  try {
    const repositoryId = context.store.currentRun()?.repositoryId;
    if (!repositoryId) throw new FlowError(503, 'No indexed graph; run index first');
    const match = /^\/api\/flows\/([^/]+)$/.exec(pathname);
    const id = match && match[1] !== 'import' ? decodeURIComponent(match[1]!) : undefined;
    if (request.method === 'GET') {
      if (pathname === '/api/flows') { send(200, { storage: 'server', writable: context.writable && !!context.flows, flows: context.flows?.list(repositoryId) ?? [] }); return; }
      const flow = id ? context.flows?.get(repositoryId, id) : undefined;
      if (!flow) throw new FlowError(404, 'Unknown flow');
      send(200, flow);
      return;
    }
    if (!['POST', 'PUT', 'DELETE'].includes(request.method ?? '')) { response.writeHead(405, { Allow: 'GET, POST, PUT, DELETE' }).end(JSON.stringify({ error: 'Method not allowed' })); return; }
    if (!context.writable || !context.flows) throw new FlowError(403, 'Flows are read-only on this server (started with --read-only)');
    const refusal = writeRefusal(request, 'flows');
    if (refusal) throw new FlowError(403, refusal);
    const flows = context.flows;
    if (request.method === 'POST' && pathname === '/api/flows') { send(201, flows.create(repositoryId, await body(request, FLOW_BODY_LIMIT))); return; }
    if (request.method === 'POST' && pathname === '/api/flows/import') { const input = await body(request, IMPORT_BODY_LIMIT) as { flows?: unknown }; send(200, flows.import(repositoryId, input?.flows)); return; }
    if (request.method === 'PUT' && id) { const input = await body(request, FLOW_BODY_LIMIT) as { revision?: unknown }; send(200, flows.update(repositoryId, id, input, input?.revision)); return; }
    if (request.method === 'DELETE' && id) { if (!flows.remove(repositoryId, id)) throw new FlowError(404, 'Unknown flow'); send(204, undefined); return; }
    throw new FlowError(404, 'Not found');
  } catch (error) {
    if (response.headersSent) return;
    const status = error instanceof FlowError ? error.status : 500;
    send(status, { error: error instanceof Error ? error.message : String(error), ...(error instanceof FlowError && error.flow ? { flow: error.flow } : {}) });
  }
}
