import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ConversationService } from './service.js';
import type { ConversationQuery } from './model.js';
import type { AgentProvider } from '../activity/model.js';
import { createHash } from 'node:crypto';

export interface ConversationRoutes { conversations: ConversationService; readOnly?: boolean; liveSessions?: () => { provider: AgentProvider; sessionId: string }[] }
export function isConversationPath(pathname: string): boolean { return /^\/api\/conversations(?:\/|$)/.test(pathname); }
export async function handleConversationRoute(context: ConversationRoutes, request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
  const send = (status: number, value: unknown) => { response.writeHead(status); response.end(JSON.stringify(value)); };
  try {
    const match = /^\/api\/conversations(?:\/([^/]+))?$/.exec(url.pathname);
    if (!match) return send(404, { error: 'Not found' });
    const id = match[1] ? decodeURIComponent(match[1]) : undefined;
    if (request.method === 'GET') {
      if (id === 'live') return send(200, { items: await context.conversations.live(context.liveSessions?.() ?? []) });
      if (id) {
        const params = url.searchParams;
        const item = context.conversations.store.read(id, { offset: params.has('offset') ? Number(params.get('offset')) : undefined, limit: params.has('limit') ? Number(params.get('limit')) : undefined, messageId: params.get('message') ?? undefined, query: params.get('q') ?? undefined });
        return item ? send(200, item) : send(404, { error: 'This agent session has not been imported. Refresh history to import available sessions.' });
      }
      const params = url.searchParams, provider = params.get('provider'), action = params.get('action');
      if (provider && provider !== 'codex' && provider !== 'claude-code') throw new Error('Unsupported provider');
      if (action && !['read', 'edited', 'added'].includes(action)) throw new Error('Invalid file action');
      const query: ConversationQuery = { query: params.get('q') ?? undefined, provider: provider as ConversationQuery['provider'] || undefined, path: params.get('path') ?? undefined, action: action as ConversationQuery['action'] || undefined, limit: params.has('limit') ? Number(params.get('limit')) : undefined, offset: params.has('offset') ? Number(params.get('offset')) : undefined };
      const etag = `"${createHash('sha256').update(JSON.stringify([context.conversations.scope, context.conversations.store.revision(), !!context.readOnly, query])).digest('hex').slice(0, 32)}"`;
      response.setHeader('ETag', etag); response.setHeader('Cache-Control', 'private, no-cache');
      if (request.headers['if-none-match'] === etag) { response.writeHead(304); response.end(); return; }
      return send(200, { ...context.conversations.store.list(query), readOnly: !!context.readOnly, scope: context.conversations.scope });
    }
    if (context.readOnly) return send(403, { error: 'Agent sessions are read-only' });
    if (request.headers['x-codiluce-request'] !== 'journal') return send(400, { error: 'Expected X-Codiluce-Request: journal' });
    if (id === 'sync' && request.method === 'POST') return send(200, await context.conversations.sync(url.searchParams.get('live') === '1' ? context.liveSessions?.() ?? [] : undefined));
    return send(405, { error: 'Method not allowed' });
  } catch (error) { send(400, { error: error instanceof Error ? error.message : String(error) }); }
}
