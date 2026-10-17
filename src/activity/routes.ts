import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ActivityService } from './service.js';
import { normalizeHook } from './normalize.js';
import { activityLaunch, hookConfiguration } from './hooks.js';
import { toolDirectory } from '../launcher.js';
import { installKind } from '../setup/settings.js';
import type { ActivityPath, AgentConnection } from './model.js';
import { HARNESSES, harnessId } from '../harnesses/registry.js';
import { integrationConfiguration } from '../harnesses/setup.js';

export interface ActivityRouteOptions {
  connections?: () => Promise<AgentConnection[]>;
  reveal?: (target: ActivityPath) => Promise<{ path: ActivityPath; refreshed: boolean }>;
}
export async function handleActivityRoute(service: ActivityService, request: IncomingMessage, response: ServerResponse, url: URL, stateDirectory?: string, options: ActivityRouteOptions = {}): Promise<void> {
  const send = (status: number, body: unknown) => { response.writeHead(status); response.end(JSON.stringify(body)); };
  if (request.method === 'GET' && url.pathname === '/api/agents') return send(200, service.snapshot());
  if (request.method === 'GET' && url.pathname === '/api/agents/setup') {
    if (!service.root || !stateDirectory) return send(200, { available: false });
    const tool = await toolDirectory(), kind = installKind(tool, service.root);
    return send(200, { available: service.enabled, codex: hookConfiguration('codex', activityLaunch(tool, kind, 'codex', service.root, stateDirectory)), claude: hookConfiguration('claude-code', activityLaunch(tool, kind, 'claude-code', service.root, stateDirectory)), connections: await options.connections?.() ?? [],
      harnesses: HARNESSES.map(({ id, label, profiles, historyNote, childAttribution }) => ({ id, label, profiles, historyNote, childAttribution })),
      integrations: HARNESSES.flatMap(item => item.profiles.map(profile => integrationConfiguration(item.id, tool, kind, service.root!, stateDirectory, { profile: profile.id }))),
    });
  }
  if (request.method === 'GET' && url.pathname === '/api/agents/stream') {
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    const emit = () => { if (!response.destroyed) { if (response.writableLength > 1024 * 1024) { response.destroy(); return; } response.write(`data: ${JSON.stringify(service.snapshot())}\n\n`); } };
    let scheduled: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = service.subscribe(() => { scheduled ??= setTimeout(() => { scheduled = undefined; emit(); }, 50); });
    emit();
    const heartbeat = setInterval(() => emit(), 15_000); heartbeat.unref();
    response.on('close', () => { clearInterval(heartbeat); if (scheduled) clearTimeout(scheduled); unsubscribe(); });
    return;
  }
  if (request.method !== 'POST' || !['/api/agents/events', '/api/agents/reveal'].includes(url.pathname)) return send(404, { error: 'Not found' });
  if (!service.enabled || !service.root) return send(403, { error: 'Agent activity is disabled on this server' });
  if (request.headers['x-codiluce-request'] !== 'activity' || !/^application\/json\b/.test(request.headers['content-type'] ?? '')) return send(400, { error: 'Expected JSON with X-Codiluce-Request: activity' });
  try {
    const chunks: Buffer[] = []; let bytes = 0;
    for await (const chunk of request) { bytes += chunk.length; if (bytes > 256 * 1024) return send(413, { error: 'Request too large' }); chunks.push(Buffer.from(chunk)); }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { provider?: unknown; payload?: unknown; eventId?: unknown; index?: unknown };
    if (url.pathname === '/api/agents/reveal') {
      if (!options.reveal) return send(403, { error: 'Revealing observed files is unavailable' });
      if (typeof body.eventId !== 'string' || !Number.isSafeInteger(body.index) || Number(body.index) < 0) return send(400, { error: 'Specify an observed event and path index' });
      const target = service.observedPath(body.eventId, Number(body.index));
      if (!target) return send(404, { error: 'This observation has expired. Select a more recent action.' });
      try {
        const result = await options.reveal(target);
        service.refresh();
        return send(200, { ...result, snapshot: service.snapshot() });
      } catch (error) { return send(422, { error: error instanceof Error ? error.message : 'Could not reveal the observed file' }); }
    }
    const provider = harnessId(body.provider);
    if (!provider) return send(400, { error: 'Unsupported agent provider' });
    const event = normalizeHook(service.root, provider, body.payload);
    if (!event) return send(400, { error: 'Invalid or out-of-repository hook event' });
    service.record(event); send(202, { accepted: true });
  } catch { send(400, { error: 'Invalid hook event' }); }
}
