// HTTP routes for visualizer projections, lazy source and history. Read-only
// and bounded. Every projection route accepts `snapshot` (a stored snapshot ID;
// absent = live working-tree index) and `compareTo` (a baseline snapshot).
import type { ServerResponse } from 'node:http';
import { NotFoundError, type ProjectionService } from '../projection/service.js';
import { SourceError } from '../projection/source.js';
import type { ViewKey } from '../projection/dto.js';
import type { HistoryService } from '../history/service.js';
import type { GraphStore } from '../storage/sqlite.js';

export interface ProjectionContext { store: GraphStore; projection: ProjectionService; history?: HistoryService; root?: string; maxFileBytes: number }
const ID = '([^/]+)';
function numberParam(params: URLSearchParams, name: string): number | undefined { return params.has(name) ? Number(params.get(name)) : undefined; }
function text(params: URLSearchParams, name: string): string | undefined { return params.get(name) ?? undefined; }
const SNAPSHOT_ID = /^[\w:.-]{1,100}$/;
export function viewParams(params: URLSearchParams): ViewKey {
  const view: ViewKey = {};
  for (const name of ['snapshot', 'compareTo'] as const) {
    const value = params.get(name);
    if (value === null || value === '') continue;
    if (!SNAPSHOT_ID.test(value)) throw new Error(`Invalid ${name}`);
    view[name] = value;
  }
  return view;
}
export function isProjectionPath(pathname: string): boolean { return pathname.startsWith('/api/projection') || pathname === '/api/source' || pathname === '/api/source/diff' || pathname === '/api/history' || pathname.startsWith('/api/history/'); }

/** Returns true when the request was handled. */
export async function handleProjectionRoute(context: ProjectionContext, url: URL, response: ServerResponse): Promise<boolean> {
  const { pathname } = url;
  if (!isProjectionPath(pathname)) return false;
  const params = url.searchParams;
  const page = { limit: numberParam(params, 'limit'), offset: numberParam(params, 'offset') };
  const { projection } = context;
  try {
    const view = viewParams(params);
    if (pathname !== '/api/history') await projection.prepare(view);
    let result: unknown;
    let match: RegExpExecArray | null;
    if (pathname === '/api/projection') result = projection.meta(view);
    else if ((match = new RegExp(`^/api/projection/children/${ID}$`).exec(pathname))) result = projection.children(decodeURIComponent(match[1]!), { ...page, view });
    else if (pathname === '/api/projection/nodes') result = projection.nodes((params.get('ids') ?? '').split(',').filter(Boolean), view);
    else if ((match = new RegExp(`^/api/projection/locate/${ID}$`).exec(pathname))) result = projection.locate(decodeURIComponent(match[1]!), view);
    else if ((match = new RegExp(`^/api/projection/resolve/${ID}$`).exec(pathname))) {
      const from = viewParams(new URLSearchParams({ snapshot: params.get('from') ?? '' })).snapshot;
      if (from) await projection.prepare({ ...(view.snapshot ? { snapshot: view.snapshot } : {}), compareTo: from });
      result = projection.resolve(decodeURIComponent(match[1]!), view, from);
    }
    else if (pathname === '/api/projection/search') result = projection.search(params.get('q') ?? '', { ...page, type: text(params, 'type'), view });
    else if ((match = new RegExp(`^/api/projection/relations/${ID}$`).exec(pathname))) result = projection.relations(decodeURIComponent(match[1]!), { ...page, direction: text(params, 'direction'), type: text(params, 'type'), view });
    else if ((match = new RegExp(`^/api/projection/aggregate/${ID}$`).exec(pathname))) result = projection.aggregate(decodeURIComponent(match[1]!), { direction: text(params, 'direction'), type: text(params, 'type'), view });
    else if ((match = new RegExp(`^/api/projection/aggregate/${ID}/edges$`).exec(pathname))) {
      const anchor = params.get('anchor');
      if (!anchor) throw new Error('anchor is required');
      result = projection.aggregateEdges(decodeURIComponent(match[1]!), { ...page, anchor, direction: text(params, 'direction'), type: text(params, 'type'), view });
    } else if ((match = new RegExp(`^/api/projection/diagnostics/${ID}$`).exec(pathname))) result = projection.diagnostics(decodeURIComponent(match[1]!), { ...page, severity: text(params, 'severity'), view });
    else if (pathname === '/api/projection/between') {
      const a = params.get('a'), b = params.get('b');
      if (!a || !b) throw new Error('a and b are required');
      result = projection.between(a, b, view);
    } else if (pathname === '/api/source') {
      const side = text(params, 'side');
      result = await projection.source({ entity: text(params, 'entity'), relation: text(params, 'relation'), diagnostic: text(params, 'diagnostic'), evidence: numberParam(params, 'evidence'), start: numberParam(params, 'start'), end: numberParam(params, 'end'), ...(side !== undefined ? { side: side as 'baseline' } : {}) }, context.maxFileBytes, view);
    } else if (pathname === '/api/source/diff') {
      const entity = params.get('entity');
      if (!entity) throw new Error('entity is required');
      result = await projection.sourceDiff(entity, context.maxFileBytes, view, { context: numberParam(params, 'context'), ignoreWhitespace: params.get('whitespace') === 'ignore' });
    } else if (pathname === '/api/history') {
      if (!context.history) throw new SourceError(503, 'History is unavailable');
      result = await context.history.timeline(text(params, 'ref'));
    } else if (pathname === '/api/history/changes') result = projection.changes(view, { ...page, status: text(params, 'status'), type: text(params, 'type') });
    else if ((match = new RegExp(`^/api/history/change/${ID}$`).exec(pathname))) result = projection.change(decodeURIComponent(match[1]!), view);
    else if ((match = new RegExp(`^/api/history/entity/${ID}$`).exec(pathname))) {
      if (!context.history) throw new SourceError(503, 'History is unavailable');
      const ref = text(params, 'ref') ?? await context.history.defaultRef();
      const listed = await context.history.commits(ref);
      result = projection.entityHistory(decodeURIComponent(match[1]!), listed?.commits.map(commit => commit.sha) ?? [], await context.history.currentIdentity());
    }
    if (result === undefined) { response.writeHead(404).end(JSON.stringify({ error: 'Not found' })); return true; }
    response.end(JSON.stringify(result));
  } catch (error) {
    const status = error instanceof SourceError ? error.status : error instanceof NotFoundError ? 404 : 400;
    response.writeHead(status).end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  }
  return true;
}
