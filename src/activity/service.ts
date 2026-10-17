import type { ActivityEvent, ActivityPath, ActivitySnapshot, AgentSession } from './model.js';

const MAX_EVENTS = 500, MAX_SESSIONS = 100;
const STALE_SESSION_MS = 5 * 60_000;
/** Only attributed hook observations. No filesystem watcher or transcript storage. */
export class ActivityService {
  private events: ActivityEvent[] = [];
  private sessions = new Map<string, AgentSession>();
  private pending = new Map<string, Map<string, 'running' | 'waiting'>>();
  private listeners = new Set<() => void>();
  private titleReads = new Map<string, number>();
  private closed = false;
  private sourceEvents = new Set<string>();
  constructor(
    readonly root: string | undefined, readonly enabled: boolean, readonly stateDirectory?: string,
    private readonly resolve?: (target: ActivityPath) => ActivityPath,
    private readonly readTitle?: (session: AgentSession) => Promise<string | undefined>,
  ) {}
  snapshot(now = Date.now()): ActivitySnapshot {
    return {
      enabled: this.enabled,
      // Re-resolve retained observations after the repository is indexed again.
      events: this.events.map(event => this.resolve ? { ...event, paths: event.paths.map(this.resolve) } : { ...event }),
      sessions: [...this.sessions.values()].map(session => now - session.lastSeen > STALE_SESSION_MS && ['running', 'waiting'].includes(session.status) ? { ...session, status: 'unknown' as const } : { ...session }),
    };
  }
  observedPath(eventId: string, index: number): ActivityPath | undefined {
    const target = this.events.find(event => event.id === eventId)?.paths[index];
    return target && this.resolve ? this.resolve(target) : target;
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  refresh(): void { if (!this.closed) for (const listener of this.listeners) listener(); }
  record(event: ActivityEvent): void {
    if (!this.enabled || this.closed || !event.sessionId) return;
    if (event.sourceEventId) {
      const key = JSON.stringify([event.provider, event.sourceInstanceId, event.sessionId, event.agentId, event.sourceEventId]);
      if (this.sourceEvents.has(key)) return;
      this.sourceEvents.add(key);
      while (this.sourceEvents.size > MAX_EVENTS) this.sourceEvents.delete(this.sourceEvents.values().next().value!);
    }
    this.events.push(event); this.events = this.events.slice(-MAX_EVENTS);
    const active = this.pending.get(event.actor) ?? new Map<string, 'running' | 'waiting'>();
    if (event.toolId && event.phase === 'started') active.set(event.toolId, event.status === 'waiting' ? 'waiting' : 'running');
    while (active.size > 128) active.delete(active.keys().next().value!);
    if (event.toolId && ['completed', 'failed'].includes(event.phase)) active.delete(event.toolId);
    if (event.kind === 'status' && ['idle', 'finished', 'interrupted'].includes(event.status ?? '')) active.clear();
    this.pending.set(event.actor, active);
    const previous = this.sessions.get(event.actor);
    const title = event.sessionTitle ?? previous?.title;
    const session: AgentSession = { actor: event.actor, provider: event.provider, sessionId: event.sessionId, ...(event.agentId ? { agentId: event.agentId } : {}), ...(title ? { title } : {}), status: [...active.values()].includes('waiting') ? 'waiting' : active.size ? 'running' : event.status ?? 'running', lastSeen: event.at, label: event.label };
    this.sessions.delete(event.actor); this.sessions.set(event.actor, session);
    while (this.sessions.size > MAX_SESSIONS) { const key = this.sessions.keys().next().value!; this.sessions.delete(key); this.pending.delete(key); this.titleReads.delete(key); }
    this.refresh();
    if (this.readTitle && !event.sessionTitle && Date.now() - (this.titleReads.get(event.actor) ?? 0) > 30_000) {
      this.titleReads.set(event.actor, Date.now());
      void this.readTitle(session).then(title => {
        const current = this.sessions.get(event.actor);
        if (!this.closed && current && current.title === session.title && title && title !== current.title) { this.sessions.set(event.actor, { ...current, title }); this.refresh(); }
      }).catch(() => undefined);
    }
  }
  close(): void { this.closed = true; this.listeners.clear(); }
}
