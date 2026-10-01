import { createServer, type Server } from 'node:http';
import type { GraphStore } from '../storage/sqlite.js';
import { ProjectionService } from '../projection/service.js';
import { handleProjectionRoute } from './projection-routes.js';
import { serveStatic } from './static.js';

export interface InspectionServerOptions {
  /** Repository root; required for source viewing. */
  root?: string;
  /** State directory; persisted layout slots live here when writable. */
  stateDirectory?: string;
  /** Statically exported visualizer UI served for non-API paths. */
  uiDirectory?: string;
  maxFileBytes?: number;
}
export function createInspectionServer(store: GraphStore, options: InspectionServerOptions = {}): Server {
  const projection = new ProjectionService(store, { stateDirectory: options.stateDirectory });
  const projectionContext = { store, projection, root: options.root, maxFileBytes: options.maxFileBytes ?? 1024 * 1024 };
  return createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    if (request.method !== 'GET') { response.writeHead(405, { Allow: 'GET' }).end(JSON.stringify({ error: 'Read-only API' })); return; }
    const fail = (error: unknown) => { if (!response.headersSent) response.writeHead(500); response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })); };
    let pathname: string;
    try { pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname; } catch { response.writeHead(400).end(JSON.stringify({ error: 'Bad request' })); return; }
    if (options.uiDirectory && pathname !== '/api' && !pathname.startsWith('/api/')) { serveStatic(options.uiDirectory, pathname, response).catch(fail); return; }
    if (pathname.startsWith('/api/projection') || pathname === '/api/source') {
      handleProjectionRoute(projectionContext, new URL(request.url ?? '/', 'http://127.0.0.1'), response).catch(fail);
      return;
    }
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const params = url.searchParams;
      const limit = params.has('limit') ? Number(params.get('limit')) : undefined;
      const offset = params.has('offset') ? Number(params.get('offset')) : undefined;
      let result: unknown;
      if (url.pathname === '/' || url.pathname === '/api') result = { name: 'Archipelago inspection API', endpoints: ['/api/summary', '/api/entities?search=login&type=method&limit=100', '/api/entities/:id', '/api/entities/:id/children', '/api/entities/:id/relations?direction=outgoing&type=handles', '/api/relations/:id', '/api/diagnostics?severity=error', '/api/projection', '/api/projection/children/:id', '/api/projection/locate/:id', '/api/projection/search?q=login', '/api/projection/relations/:id', '/api/projection/aggregate/:id', '/api/projection/diagnostics/:id', '/api/projection/between?a=ID&b=ID', '/api/source?entity=ID'] };
      else if (url.pathname === '/api/summary') result = store.summary();
      else if (url.pathname === '/api/entities') result = store.entities({ limit, offset, search: params.get('search') ?? undefined, type: params.get('type') ?? undefined, path: params.get('path') ?? undefined, parentId: params.get('parentId') ?? undefined });
      else if (url.pathname === '/api/diagnostics') result = store.diagnostics({ limit, offset, severity: params.get('severity') ?? undefined, code: params.get('code') ?? undefined });
      else {
        const entity = /^\/api\/entities\/([^/]+)(?:\/(children|relations))?$/.exec(url.pathname);
        const relation = /^\/api\/relations\/([^/]+)$/.exec(url.pathname);
        if (entity) {
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
    } catch (error) { response.writeHead(400).end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })); }
  });
}
