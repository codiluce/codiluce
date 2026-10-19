// HTTP routes for explanations, and what connected agents are doing. Reads
// are plain GETs; writes (asking, renaming, deleting) need the
// X-Codiluce-Request header that a cross-origin page cannot send without a
// CORS preflight, which this server never grants. Asking streams the answer
// as it is written: one JSON event per line.
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChatService } from './chat.js';
import { readActivity } from './activity.js';
import type { AgentActivityList, AgentConnectionList, AskEvent, ExplanationsSetup } from './model.js';
import { ReadOnlyError, type ExplanationService } from './service.js';
import { detectAgents, mcpLaunch, shellLine, type Install } from '../setup/agents.js';
import { installKind } from '../setup/settings.js';

export const EXPLAIN_REQUEST = 'explain';
export interface ExplanationRoutes { service: ExplanationService; chat: ChatService; stateDirectory: string }
export function isExplanationPath(pathname: string): boolean { return pathname === '/api/explanations' || pathname.startsWith('/api/explanations/'); }

export async function handleExplanationRoute(context: ExplanationRoutes, request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
  const { service, chat } = context;
  const method = request.method ?? 'GET';
  const send = (status: number, body: unknown) => { if (!response.headersSent) response.writeHead(status); response.end(JSON.stringify(body)); };
  try {
    const rest = url.pathname.slice('/api/explanations'.length).replace(/^\//, '');
    if (method === 'GET') {
      if (!rest) return send(200, await service.list());
      if (rest === 'setup') return send(200, setup(context));
      // The agents on this computer and whether each already reaches this repository (about a second: their CLIs are asked).
      if (rest === 'agents') return send(200, await connections(context));
      // Agents connected over MCP and what they are explaining right now (polled every few seconds: files only, no index work).
      if (rest === 'activity') return send(200, { items: readActivity(context.stateDirectory) } satisfies AgentActivityList);
      const entity = /^entity\/([^/]+)$/.exec(rest);
      if (entity) return send(200, await service.forEntity(decodeURIComponent(entity[1]!)));
      if (/^[^/]+$/.test(rest)) { const detail = await service.detail(decodeURIComponent(rest)); return detail ? send(200, detail) : send(404, { error: 'No such explanation' }); }
      return send(404, { error: 'Not found' });
    }
    if (request.headers['x-codiluce-request'] !== EXPLAIN_REQUEST) return send(400, { error: 'Expected the X-Codiluce-Request: explain header' });
    if (service.readOnly) return send(403, { error: new ReadOnlyError().message });
    if (method === 'DELETE' && /^[^/]+$/.test(rest)) return service.remove(decodeURIComponent(rest)) ? send(200, { removed: true }) : send(404, { error: 'No such explanation' });
    if (!/^application\/json\b/.test(request.headers['content-type'] ?? '')) return send(415, { error: 'Expected a JSON body' });
    const body = await readJson(request, 64 * 1024);
    if (method === 'PATCH' && /^[^/]+$/.test(rest)) return send(200, service.rename(decodeURIComponent(rest), String((body as { title?: unknown }).title ?? '')));
    if (method === 'POST' && rest === 'ask') return ask(chat, body, response);
    return send(405, { error: 'Method not allowed' });
  } catch (error) {
    send(error instanceof ReadOnlyError ? 403 : error instanceof BodyError ? error.status : 400, { error: error instanceof Error ? error.message : String(error) });
  }
}

async function ask(chat: ChatService, body: unknown, response: ServerResponse): Promise<void> {
  const input = body as { question?: unknown; explanationId?: unknown; refresh?: unknown; model?: unknown; context?: unknown };
  const controller = new AbortController();
  let finished = false;
  response.on('close', () => { if (!finished) controller.abort(); });
  response.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
  const emit = (event: AskEvent) => { if (!response.writableEnded) response.write(`${JSON.stringify(event)}\n`); };
  try {
    const detail = await chat.ask({
      question: typeof input.question === 'string' ? input.question : '',
      ...(typeof input.explanationId === 'string' && input.explanationId ? { explanationId: input.explanationId } : {}),
      ...(input.refresh === true ? { refresh: true } : {}),
      ...(typeof input.model === 'string' && input.model ? { model: input.model } : {}),
      ...(Array.isArray(input.context) ? { context: input.context.filter((item): item is string => typeof item === 'string') } : {}),
    }, emit, controller.signal);
    emit({ type: 'done', explanation: detail });
  } catch (error) {
    if (!controller.signal.aborted) emit({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  } finally { finished = true; response.end(); }
}

/** This server's install, which agents connect to. */
function install(context: ExplanationRoutes): Install {
  const root = context.service.root;
  const toolDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const state = root && path.resolve(context.stateDirectory) !== path.join(root, '.codiluce') ? path.resolve(context.stateDirectory) : undefined;
  return { toolDirectory, kind: installKind(toolDirectory, root), ...(state ? { stateDirectory: state } : {}) };
}
async function connections(context: ExplanationRoutes): Promise<AgentConnectionList> {
  const root = context.service.root;
  if (!root) return { items: [] };
  const agents = await detectAgents(root, install(context));
  return { items: agents.filter(agent => agent.installed || agent.connected).map(agent => ({ id: agent.id, name: agent.name, connected: agent.connected, ...(agent.elsewhere ? { elsewhere: agent.elsewhere } : {}) })) };
}
/** How to reach explanations from here: writing allowed, models with keys, and the command that connects an agent. */
function setup(context: ExplanationRoutes): ExplanationsSetup {
  const root = context.service.root;
  const { toolDirectory: tool, kind, stateDirectory: state } = install(context);
  const project = mcpLaunch(tool, kind, { ...(root ? { repo: root } : {}), ...(state ? { stateDirectory: state } : {}) });
  const line = shellLine(project);
  return {
    readOnly: context.service.readOnly, ...(root ? { root } : {}),
    // Codex keeps one list for every repository, so its server follows the folder it works in (as setup connects it).
    mcp: { command: project.command, args: project.args, claude: `claude mcp add codiluce -- ${line}`, codex: `codex mcp add codiluce -- ${shellLine(mcpLaunch(tool, kind))}` },
    models: context.chat.models(), keyFiles: context.chat.keyFiles(), maxCost: context.chat.cap,
  };
}
class BodyError extends Error { constructor(readonly status: number, message: string) { super(message); } }
async function readJson(request: IncomingMessage, limit: number): Promise<unknown> {
  let body = '';
  for await (const chunk of request) { body += chunk; if (body.length > limit) throw new BodyError(413, 'Request too large'); }
  try { return JSON.parse(body || '{}'); } catch { throw new BodyError(400, 'The body is not valid JSON'); }
}
