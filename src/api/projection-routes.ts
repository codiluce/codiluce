// HTTP routes for visualizer projections and lazy source. Read-only and bounded.
import type { ServerResponse } from 'node:http';
import { NotFoundError, type ProjectionService } from '../projection/service.js';
import { readIndexedSource, SourceError } from '../projection/source.js';
import type { GraphStore } from '../storage/sqlite.js';

export interface ProjectionContext { store: GraphStore; projection: ProjectionService; root?: string; maxFileBytes: number }
const ID = '([^/]+)';
function numberParam(params: URLSearchParams, name: string): number | undefined { return params.has(name) ? Number(params.get(name)) : undefined; }
function text(params: URLSearchParams, name: string): string | undefined { return params.get(name) ?? undefined; }

/** Returns true when the request was handled. */
export async function handleProjectionRoute(context: ProjectionContext, url: URL, response: ServerResponse): Promise<boolean> {
  const { pathname } = url;
  if (!pathname.startsWith('/api/projection') && pathname !== '/api/source') return false;
  const params = url.searchParams;
  const page = { limit: numberParam(params, 'limit'), offset: numberParam(params, 'offset') };
  const { projection } = context;
  try {
    let result: unknown;
    let match: RegExpExecArray | null;
    if (pathname === '/api/projection') result = projection.meta();
    else if ((match = new RegExp(`^/api/projection/children/${ID}$`).exec(pathname))) result = projection.children(decodeURIComponent(match[1]!), page);
    else if (pathname === '/api/projection/nodes') result = projection.nodes((params.get('ids') ?? '').split(',').filter(Boolean));
    else if ((match = new RegExp(`^/api/projection/locate/${ID}$`).exec(pathname))) result = projection.locate(decodeURIComponent(match[1]!));
    else if (pathname === '/api/projection/search') result = projection.search(params.get('q') ?? '', { ...page, type: text(params, 'type') });
    else if ((match = new RegExp(`^/api/projection/relations/${ID}$`).exec(pathname))) result = projection.relations(decodeURIComponent(match[1]!), { ...page, direction: text(params, 'direction'), type: text(params, 'type') });
    else if ((match = new RegExp(`^/api/projection/aggregate/${ID}$`).exec(pathname))) result = projection.aggregate(decodeURIComponent(match[1]!), { direction: text(params, 'direction'), type: text(params, 'type') });
    else if ((match = new RegExp(`^/api/projection/aggregate/${ID}/edges$`).exec(pathname))) {
      const anchor = params.get('anchor');
      if (!anchor) throw new Error('anchor is required');
      result = projection.aggregateEdges(decodeURIComponent(match[1]!), { ...page, anchor, direction: text(params, 'direction'), type: text(params, 'type') });
    } else if ((match = new RegExp(`^/api/projection/diagnostics/${ID}$`).exec(pathname))) result = projection.diagnostics(decodeURIComponent(match[1]!), { ...page, severity: text(params, 'severity') });
    else if (pathname === '/api/projection/between') {
      const a = params.get('a'), b = params.get('b');
      if (!a || !b) throw new Error('a and b are required');
      result = projection.between(a, b);
    } else if (pathname === '/api/source') {
      if (!context.root) throw new SourceError(503, 'Source viewing requires the server to be started with a repository root');
      result = await readIndexedSource(context.store, context.root, context.maxFileBytes, { entity: text(params, 'entity'), relation: text(params, 'relation'), diagnostic: text(params, 'diagnostic'), evidence: numberParam(params, 'evidence'), start: numberParam(params, 'start'), end: numberParam(params, 'end') });
    }
    if (result === undefined) { response.writeHead(404).end(JSON.stringify({ error: 'Not found' })); return true; }
    response.end(JSON.stringify(result));
  } catch (error) {
    const status = error instanceof SourceError ? error.status : error instanceof NotFoundError ? 404 : 400;
    response.writeHead(status).end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  }
  return true;
}
