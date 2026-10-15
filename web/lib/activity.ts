import { ACTIVITY_TRAIL_MS, type ActivityEvent } from '../../src/activity/model';

export const providerName = (provider: string): string => provider === 'codex' ? 'Codex' : 'Claude Code';
export function agentColor(actor: string): string {
  let hash = 0; for (const char of actor) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return `hsl(${(hash >>> 0) % 360} 72% 58%)`;
}
export interface ActivityMark { id: string; ancestors: string[]; actor: string; color: string; label: string; age: number; search: boolean }
/** No descendant expansion: a search marks its scope; files mark themselves or their visible ancestor. */
export function activityMarks(events: ActivityEvent[], now: number, focus?: string): ActivityMark[] {
  const marks: ActivityMark[] = [], seen = new Set<string>(), failed = new Set<string>();
  for (const event of [...events].reverse()) {
    const age = now - event.at;
    const call = event.toolId ? `${event.actor}:${event.toolId}` : undefined;
    if (event.phase === 'failed') { if (call) failed.add(call); continue; }
    if (age < 0 || age >= ACTIVITY_TRAIL_MS || focus && event.actor !== focus || call && failed.has(call)) continue;
    for (const target of event.paths) {
      if (!target.id) continue;
      const key = `${event.actor}:${target.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const prefix = event.provider === 'codex' ? 'CX' : 'CC';
      marks.push({ id: target.id, ancestors: target.ancestors ?? [], actor: event.actor, color: agentColor(event.actor), label: `${prefix} · ${event.kind}`, age, search: event.kind === 'search' || target.exact === false });
      if (marks.length >= 120) return marks;
    }
  }
  return marks;
}
