import type { ActivityEvent, ActivitySnapshot } from '../../src/activity/model';
import type { FamilyOverlay } from './renderer';

export { harnessLabel as providerName } from '../../src/harnesses/registry';
import { sessionKey } from '../../src/harnesses/registry';
export function agentColor(actor: string): string {
  let hash = 0; for (const char of actor) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return `hsl(${(hash >>> 0) % 360} 72% 58%)`;
}
export interface ObservedFile { event: ActivityEvent; index: number }
/** Files of the current observed turn; failed attempts and earlier idle turns stay out. */
export function activeSessionFiles(snapshot: ActivitySnapshot | undefined, now: number, sessionId?: string, focus?: string): ObservedFile[] {
  if (!snapshot?.enabled) return [];
  const active = new Set(snapshot.sessions.filter(session => ['running', 'waiting'].includes(session.status) && now - session.lastSeen <= 300_000 && (!sessionId || sessionKey(session.provider, session.sessionId) === sessionId) && (!focus || session.actor === focus)).map(session => session.actor));
  const stopped = new Map<string, number>(), failed = new Set<string>(), seen = new Set<string>(), files: ObservedFile[] = [];
  for (const event of snapshot.events) {
    if (event.phase === 'status' && ['idle', 'finished', 'interrupted'].includes(event.status ?? '')) stopped.set(event.actor, Math.max(stopped.get(event.actor) ?? 0, event.at));
    if (event.phase === 'failed' && event.toolId) failed.add(`${event.actor}:${event.toolId}`);
  }
  for (const event of [...snapshot.events].reverse()) {
    if (!active.has(event.actor) || event.at < (stopped.get(event.actor) ?? 0) || event.phase === 'failed' || event.toolId && failed.has(`${event.actor}:${event.toolId}`)) continue;
    event.paths.forEach((target, index) => {
      const key = `${target.scope}:${target.path}`;
      if (!seen.has(key) && files.length < 64) { seen.add(key); files.push({ event, index }); }
    });
  }
  return files;
}

/** Same focus treatment as explanation links; directory scopes light areas, never invented reads. */
export function activeAgentOverlay(snapshot: ActivitySnapshot | undefined, now: number, focus?: string): FamilyOverlay | undefined {
  const key = 'agent-work', of = new Map<string, string>(), areas = new Map<string, Record<string, number>>();
  const seen = new Set<string>();
  for (const { event, index } of activeSessionFiles(snapshot, now, undefined, focus)) {
    const target = event.paths[index]!;
    if (!target.id || seen.has(target.id)) continue; seen.add(target.id);
    if (target.scope === 'file' && target.exact !== false) of.set(target.id, key);
    else areas.set(target.id, { [key]: 1 });
    for (const ancestor of target.ancestors ?? []) areas.set(ancestor, { [key]: (areas.get(ancestor)?.[key] ?? 0) + 1 });
  }
  return of.size || areas.size ? { of, areas, names: new Map([[key, 'Agent activity']]), hues: new Map([[key, 175]]), focus: key } : undefined;
}
