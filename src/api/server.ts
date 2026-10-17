import { createServer, type Server } from 'node:http';
import { GraphStore } from '../storage/sqlite.js';
import { ProjectionService } from '../projection/service.js';
import { HistoryAccess, HistoryService } from '../history/service.js';
import { handleProjectionRoute, isProjectionPath, viewParams } from './projection-routes.js';
import { serveStatic } from './static.js';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { AnnotationAccess } from '../ai/store.js';
import type { MapVisibilityAction } from '../projection/dto.js';
import { ExplanationService } from '../explanations/service.js';
import { ChatService } from '../explanations/chat.js';
import { codeTools } from '../explanations/tools.js';
import { handleExplanationRoute, isExplanationPath } from '../explanations/routes.js';
import { SERVE_FILE } from '../explanations/mcp.js';
import { keyFiles } from '../setup/settings.js';
import { ActivityService } from '../activity/service.js';
import { handleActivityRoute } from '../activity/routes.js';
import { AgentMetadata } from '../activity/providers.js';
import { repositoryPath } from '../activity/normalize.js';
import type { ActivityPath } from '../activity/model.js';
import { stat } from 'node:fs/promises';
import { ConversationService } from '../conversations/service.js';
import { handleConversationRoute, isConversationPath } from '../conversations/routes.js';

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
  /** Refuse every write: on-demand history indexing and explanations (asking, renaming, deleting). */
  readOnly?: boolean;
  /** Files the chat reads ANTHROPIC_API_KEY or OPENAI_API_KEY from (src/setup/settings.ts `keyFiles`; never the target repository). */
  keyFiles?: string[];
  /** Read pull requests from the provider (open, merged, closed), with GITHUB_TOKEN when set. Off by default: the server makes no other network request. */
  pullRequests?: 'github';
  /** Override provider stores, primarily for isolated installations and fixtures. */
  conversationSources?: { codexHome?: string; claudeHome?: string; harnessHomes?: Partial<Record<import('../harnesses/registry.js').HarnessId, string>> };
}
/** Header that a cross-origin page cannot send without a CORS preflight, which this server never grants. */
export const INDEX_REQUEST_HEADER = 'x-codiluce-request';
export function createInspectionServer(store: GraphStore, options: InspectionServerOptions = {}): Server {
  const access = new HistoryAccess(options.stateDirectory);
  const notes = new AnnotationAccess(options.stateDirectory, existsSync);
  const projection = new ProjectionService(store, { readOnly: options.readOnly, stateDirectory: options.stateDirectory, root: options.root, history: access.get, annotations: notes.get, ...(options.pullRequests ? { pullRequests: options.pullRequests } : {}) });
  const agentMetadata = options.root && options.stateDirectory ? new AgentMetadata(options.root, options.stateDirectory) : undefined;
  const resolveActivityPath = (target: ActivityPath): ActivityPath => {
    const context = projection.linkContext();
    let relative = target.path;
    let id = relative === '.' ? context.index.rootId : target.scope === 'file' ? context.index.fileByPath.get(relative) : context.byPath.get(relative);
    const exact = !!id;
    while (!id && relative !== '.') { relative = path.posix.dirname(relative); id = context.byPath.get(relative); }
    id ??= context.index.rootId;
    const node = context.index.node(id);
    return { ...target, id, exact, ancestors: node ? context.index.spatialAncestors(node).map(item => item.id) : [] };
  };
  const activity = new ActivityService(options.root, !!options.root && !options.readOnly, options.stateDirectory, resolveActivityPath, session => agentMetadata?.title(session) ?? Promise.resolve(undefined));
  const journal = options.root && options.stateDirectory ? {
    conversations: new ConversationService({ root: options.root, stateDirectory: options.stateDirectory, readOnly: options.readOnly, ...options.conversationSources }),
    readOnly: options.readOnly,
    liveSessions: () => activity.snapshot().sessions.filter(session => Date.now() - session.lastSeen <= 300_000),
    resolve: resolveActivityPath,
  } : undefined;
  let activityIndexing: Promise<void> | undefined;
  const revealActivityPath = async (target: ActivityPath): Promise<{ path: ActivityPath; refreshed: boolean }> => {
    const current = resolveActivityPath(target);
    if (current.exact || target.scope === 'directory') return { path: current, refreshed: false };
    const root = options.root!, stateDirectory = options.stateDirectory;
    if (!stateDirectory || repositoryPath(root, root, target.path) !== target.path) throw new Error('This file cannot be revealed outside the repository.');
    const info = await stat(path.join(root, target.path)).catch(() => undefined);
    if (!info?.isFile()) throw new Error('This file no longer exists. Its earlier activity remains in the feed.');
    // Only an explicit click on an observed file may refresh the architecture index.
    activityIndexing ??= (async () => {
      const { indexRepository } = await import('../pipeline/index.js');
      const { readRawConfig, resolveConfig } = await import('../core/config.js');
      const raw = await readRawConfig(stateDirectory);
      const config = await resolveConfig(root, { ...raw, repository: raw.repository ?? { name: store.currentRun()!.repositoryName } });
      const graph = await indexRepository(root, { stateDirectory, config, cache: path.join(stateDirectory, 'cache') });
      const database = store.db.prepare('PRAGMA database_list').all().find(row => row.name === 'main')?.file;
      const writable = store.readOnly ? new GraphStore(String(database)) : store;
      try { writable.save(graph); } finally { if (writable !== store) writable.close(); }
    })().finally(() => { activityIndexing = undefined; });
    await activityIndexing;
    const resolved = resolveActivityPath(target);
    if (!resolved.exact) throw new Error('This file is excluded from the index. Update the repository indexing settings to show it on the map.');
    return { path: resolved, refreshed: true };
  };
  const history = new HistoryService({ root: options.root, stateDirectory: options.stateDirectory, store, history: access, indexing: options.historyIndexing && !options.readOnly, readOnly: options.readOnly });
  const projectionContext = { store, projection, history, root: options.root, maxFileBytes: options.maxFileBytes ?? 1024 * 1024, sessionScope: journal?.conversations.scope };
  // Explanations live in the state directory: text from language models whose links name code (src/explanations).
  const explanations = options.stateDirectory ? (() => {
    const service = new ExplanationService({ stateDirectory: options.stateDirectory!, root: options.root, projection, history, readOnly: options.readOnly });
    const tools = codeTools({ service, projection, history, root: options.root, maxFileBytes: projectionContext.maxFileBytes });
    return { service, chat: new ChatService({ service, tools, keyFiles: options.keyFiles ?? keyFiles(options.stateDirectory!) }), stateDirectory: options.stateDirectory! };
  })() : undefined;
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    const fail = (error: unknown) => { if (!response.headersSent) response.writeHead(500); response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })); };
    let pathname: string;
    try { pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname; } catch { response.writeHead(400).end(JSON.stringify({ error: 'Bad request' })); return; }
    if (isConversationPath(pathname)) {
      if (!journal) { response.writeHead(503).end(JSON.stringify({ error: 'Agent session history needs a repository and state directory' })); return; }
      handleConversationRoute(journal, request, response, new URL(request.url ?? '/', 'http://127.0.0.1')).catch(fail); return;
    }
    if (pathname === '/api/agents' || pathname.startsWith('/api/agents/')) { handleActivityRoute(activity, request, response, new URL(request.url ?? '/', 'http://127.0.0.1'), options.stateDirectory, { connections: () => agentMetadata?.connections() ?? Promise.resolve([]), ...(!options.readOnly ? { reveal: revealActivityPath } : {}) }).catch(fail); return; }
    if (request.method === 'POST' && pathname === '/api/history/index') { handleIndexRequest(request, response, history).catch(fail); return; }
    if (request.method === 'POST' && pathname === '/api/projection/map-visibility') { if (options.readOnly) { response.writeHead(403).end(JSON.stringify({ error: 'Map preferences are read-only' })); return; } handleMapVisibility(request, response, projection).catch(fail); return; }
    if (isExplanationPath(pathname)) {
      if (!explanations) { response.writeHead(503).end(JSON.stringify({ error: 'Explanations need a state directory' })); return; }
      handleExplanationRoute(explanations, request, response, new URL(request.url ?? '/', 'http://127.0.0.1')).catch(fail);
      return;
    }
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
      if (url.pathname === '/' || url.pathname === '/api') result = { name: 'Codiluce inspection API', endpoints: ['/api/agents', '/api/agents/stream', '/api/agents/setup', '/api/agents/events', '/api/summary', '/api/entities?search=login&type=method&limit=100', '/api/entities/:id', '/api/entities/:id/children', '/api/entities/:id/relations?direction=outgoing&type=handles', '/api/relations/:id', '/api/diagnostics?severity=error', '/api/projection', '/api/projection/children/:id', '/api/projection/locate/:id', '/api/projection/search?q=login', '/api/projection/relations/:id', '/api/projection/aggregate/:id', '/api/projection/diagnostics/:id', '/api/projection/between?a=ID&b=ID', '/api/projection/impact/:id?depth=4&types=calls,renders&group=feature', '/api/projection/impact-working?group=app', '/api/projection/steps/:id', '/api/projection/request-flows?entity=ID', '/api/projection/request-flows/:id', '/api/history/impact?snapshot=ID&compareTo=ID', '/api/source?entity=ID', '/api/history', '/api/history/changes?snapshot=ID&compareTo=ID', '/api/history/change/:id?snapshot=ID&compareTo=ID', '/api/history/entity/:id', '/api/history/evolution', '/api/source/diff?entity=ID&snapshot=ID&compareTo=ID', '/api/projection/flows?entity=ID&kind=page', '/api/projection/coverage', '/api/projection/families', '/api/projection/features', '/api/projection/files?feature=KEY|family=KEY|coverage=CATEGORY|person=KEY', '/api/annotations', '/api/authorship?window=90d', '/api/authorship/person/:key', '/api/authorship/entity/:id', '/api/pulls?window=90d&q=TEXT&refresh=1', '/api/pulls/item/:id', '/api/pulls/entity/:id', '/api/projection/impact-pull?pull=ID', '/api/projection/files?pull=ID'], views: 'Projection, source and entity/relation detail routes accept snapshot=ID (a history snapshot) and compareTo=ID (a baseline).' };
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
  // Where the map listens, so `codiluce mcp` can link an explanation it saves (removed when the server closes).
  const serveFile = options.stateDirectory ? path.join(options.stateDirectory, SERVE_FILE) : undefined;
  server.on('listening', () => {
    const address = server.address();
    if (!serveFile || !address || typeof address === 'string' || !existsSync(options.stateDirectory!)) return;
    try { writeFileSync(serveFile, `${JSON.stringify({ url: `http://127.0.0.1:${address.port}/`, pid: process.pid, startedAt: new Date().toISOString() })}\n`); } catch { /* optional */ }
  });
  server.on('close', () => {
    journal?.conversations.close();
    activity.close();
    agentMetadata?.close();
    access.close(); notes.close();
    if (serveFile) { try { if ((JSON.parse(readFileSync(serveFile, 'utf8')) as { pid?: number }).pid === process.pid) rmSync(serveFile); } catch { /* optional */ } }
  });
  return server;
}
async function handleMapVisibility(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse, projection: ProjectionService): Promise<void> {
  if (request.headers[INDEX_REQUEST_HEADER] !== 'map-visibility' || !/^application\/json\b/.test(request.headers['content-type'] ?? '')) { response.writeHead(400).end(JSON.stringify({ error: 'Expected a JSON request with the X-Codiluce-Request: map-visibility header' })); return; }
  let body = '';
  for await (const chunk of request) { body += chunk; if (Buffer.byteLength(body) > 65536) { response.writeHead(413).end(JSON.stringify({ error: 'Request too large' })); return; } }
  try {
    const action: unknown = JSON.parse(body);
    if (!action || typeof action !== 'object' || Array.isArray(action)) throw new Error('Expected a map visibility action');
    const result = projection.updateMapVisibility(action as MapVisibilityAction);
    response.end(JSON.stringify(result));
  } catch (error) { response.writeHead(400).end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })); }
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
