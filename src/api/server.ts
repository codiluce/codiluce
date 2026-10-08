import { createServer, type Server } from 'node:http';
import type { GraphStore } from '../storage/sqlite.js';
import { ProjectionService } from '../projection/service.js';
import { HistoryAccess, HistoryService } from '../history/service.js';
import { handleProjectionRoute, isProjectionPath, viewParams } from './projection-routes.js';
import { serveStatic } from './static.js';
import { existsSync } from 'node:fs';
import { AnnotationAccess } from '../ai/store.js';

export interface InspectionServerOptions {
  /** Repository root; required for source viewing and live Git history. */
  root?: string;
  /** State directory; persisted layout slots and history.db live here. */
  stateDirectory?: string;
  /** Statically exported visualizer UI served for non-API paths. */
  uiDirectory?: string;
  maxFileBytes?: number;
  /**
   * Accept POST /api/history/index to analyze one missing timeline commit in a
   * child process. Off by default: the server is otherwise read-only.
   */
  historyIndexing?: boolean;
}
/** Header that a cross-origin page cannot send without a CORS preflight, which this server never grants. */
export const INDEX_REQUEST_HEADER = 'x-codiluce-request';
export function createInspectionServer(store: GraphStore, options: InspectionServerOptions = {}): Server {
  const access = new HistoryAccess(options.stateDirectory);
  const notes = new AnnotationAccess(options.stateDirectory, existsSync);
  const projection = new ProjectionService(store, { stateDirectory: options.stateDirectory, root: options.root, history: access.get, annotations: notes.get });
  const history = new HistoryService({ root: options.root, stateDirectory: options.stateDirectory, store, history: access, indexing: options.historyIndexing });
  const projectionContext = { store, projection, history, root: options.root, maxFileBytes: options.maxFileBytes ?? 1024 * 1024 };
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    const fail = (error: unknown) => { if (!response.headersSent) response.writeHead(500); response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })); };
    let pathname: string;
    try { pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname; } catch { response.writeHead(400).end(JSON.stringify({ error: 'Bad request' })); return; }
    if (request.method === 'POST' && pathname === '/api/history/index') { handleIndexRequest(request, response, history).catch(fail); return; }
    if (request.method !== 'GET') { response.writeHead(405, { Allow: 'GET' }).end(JSON.stringify({ error: 'Read-only API' })); return; }
    if (options.uiDirectory && pathname !== '/api' && !pathname.startsWith('/api/')) { serveStatic(options.uiDirectory, pathname, response).catch(fail); return; }
    if (isProjectionPath(pathname)) {
      handleProjectionRoute(projectionContext, new URL(request.url ?? '/', 'http://127.0.0.1'), response, request.headers['accept-encoding']).catch(fail);
      return;
    }
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const params = url.searchParams;
      const limit = params.has('limit') ? Number(params.get('limit')) : undefined;
      const offset = params.has('offset') ? Number(params.get('offset')) : undefined;
      let result: unknown;
      if (url.pathname === '/' || url.pathname === '/api') result = { name: 'Codiluce inspection API', endpoints: ['/api/summary', '/api/entities?search=login&type=method&limit=100', '/api/entities/:id', '/api/entities/:id/children', '/api/entities/:id/relations?direction=outgoing&type=handles', '/api/relations/:id', '/api/diagnostics?severity=error', '/api/projection', '/api/projection/children/:id', '/api/projection/locate/:id', '/api/projection/search?q=login', '/api/projection/relations/:id', '/api/projection/aggregate/:id', '/api/projection/diagnostics/:id', '/api/projection/between?a=ID&b=ID', '/api/projection/impact/:id?depth=4&types=calls,renders', '/api/projection/steps/:id', '/api/projection/request-flows?entity=ID', '/api/projection/request-flows/:id', '/api/history/impact?snapshot=ID&compareTo=ID', '/api/source?entity=ID', '/api/history', '/api/history/changes?snapshot=ID&compareTo=ID', '/api/history/change/:id?snapshot=ID&compareTo=ID', '/api/history/entity/:id', '/api/history/evolution', '/api/source/diff?entity=ID&snapshot=ID&compareTo=ID', '/api/projection/flows?entity=ID&kind=page', '/api/projection/coverage', '/api/projection/families', '/api/annotations'], views: 'Projection, source and entity/relation detail routes accept snapshot=ID (a history snapshot) and compareTo=ID (a baseline). The live map also accepts lens=data (by data family) and lens=domains (by domain).' };
      else if (url.pathname === '/api/summary') result = store.summary();
      else if (url.pathname === '/api/entities') result = store.entities({ limit, offset, search: params.get('search') ?? undefined, type: params.get('type') ?? undefined, path: params.get('path') ?? undefined, parentId: params.get('parentId') ?? undefined });
      else if (url.pathname === '/api/diagnostics') result = store.diagnostics({ limit, offset, severity: params.get('severity') ?? undefined, code: params.get('code') ?? undefined });
      else {
        const entity = /^\/api\/entities\/([^/]+)(?:\/(children|relations))?$/.exec(url.pathname);
        const relation = /^\/api\/relations\/([^/]+)$/.exec(url.pathname);
        const view = viewParams(params);
        const historical = !!(view.snapshot || view.compareTo);
        if (entity && historical && !entity[2]) result = projection.entity(decodeURIComponent(entity[1]!), view);
        else if (relation && historical) result = projection.relation(decodeURIComponent(relation[1]!), view);
        else if (entity) {
          const id = decodeURIComponent(entity[1]!);
          if (!store.entity(id)) { response.writeHead(404).end(JSON.stringify({ error: 'Entity not found' })); return; }
          if (entity[2] === 'children') result = store.entities({ parentId: id, limit, offset });
          else if (entity[2] === 'relations') {
            const direction = params.get('direction') ?? 'both';
            if (!['incoming', 'outgoing', 'both'].includes(direction)) throw new Error('direction must be incoming, outgoing or both');
            result = store.relations({ entityId: id, direction: direction as 'incoming' | 'outgoing' | 'both', type: params.get('type') ?? undefined, limit, offset });
          } else result = store.entity(id);
        } else if (relation) result = store.relation(decodeURIComponent(relation[1]!));
      }
      if (result === undefined) { response.writeHead(404).end(JSON.stringify({ error: 'Not found' })); return; }
      response.end(JSON.stringify(result, null, 2));
    } catch (error) { response.writeHead(error instanceof Error && /^Unknown snapshot/.test(error.message) ? 404 : 400).end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })); }
  });
  server.on('close', () => { access.close(); notes.close(); });
  return server;
}
async function handleIndexRequest(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse, history: HistoryService): Promise<void> {
  if (!history.indexingEnabled) { response.writeHead(403).end(JSON.stringify({ error: 'On-demand indexing is disabled; start serve with --history-indexing' })); return; }
  if (request.headers[INDEX_REQUEST_HEADER] !== 'index' || !/^application\/json\b/.test(request.headers['content-type'] ?? '')) { response.writeHead(400).end(JSON.stringify({ error: 'Expected a JSON request with the X-Codiluce-Request: index header' })); return; }
  let body = '';
  for await (const chunk of request) { body += chunk; if (body.length > 2048) { response.writeHead(413).end(JSON.stringify({ error: 'Request too large' })); return; } }
  try {
    const { sha, ref } = JSON.parse(body) as { sha?: unknown; ref?: unknown };
    const result = await history.request(String(sha ?? ''), typeof ref === 'string' ? ref : undefined);
    response.writeHead(202).end(JSON.stringify(result));
  } catch (error) { response.writeHead(400).end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })); }
}
