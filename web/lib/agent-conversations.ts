import type { AgentSession, AgentStatus } from '../../src/activity/model';
import type { ConversationSummary } from '../../src/conversations/model';
import { harnessLabel, sessionKey } from '../../src/harnesses/registry';

export interface AgentConversation {
  id: string; provider: AgentSession['provider']; sessionId: string; title: string;
  saved?: ConversationSummary; sessions: AgentSession[]; status?: AgentStatus; lastSeen: number;
}
/** Identity comes from provider + session ID, never from a similar title. */
export function agentConversations(items: ConversationSummary[], sessions: AgentSession[], now: number, includeUnimported: boolean): AgentConversation[] {
  const rows = new Map<string, AgentConversation>(items.map(saved => [saved.id, { ...saved, saved, sessions: [], lastSeen: 0 }]));
  for (const session of sessions) {
    const id = sessionKey(session.provider, session.sessionId);
    let row = rows.get(id);
    if (!row && includeUnimported) { row = { id, provider: session.provider, sessionId: session.sessionId, title: session.title ?? `${harnessLabel(session.provider)} session`, sessions: [], lastSeen: 0 }; rows.set(id, row); }
    if (!row) continue;
    row.sessions.push(session); row.lastSeen = Math.max(row.lastSeen, session.lastSeen);
  }
  const priority: AgentStatus[] = ['waiting', 'running', 'error', 'interrupted', 'idle', 'finished', 'unknown'];
  for (const row of rows.values()) row.status = priority.find(status => row.sessions.some(session => (now - session.lastSeen > 300_000 && ['running', 'waiting'].includes(session.status) ? 'unknown' : session.status) === status));
  return [...rows.values()].sort((a, b) => {
    const active = (row: AgentConversation) => row.status === 'running' || row.status === 'waiting';
    return Number(active(b)) - Number(active(a)) || Math.max(b.lastSeen, Date.parse(b.saved?.updatedAt ?? '') || 0) - Math.max(a.lastSeen, Date.parse(a.saved?.updatedAt ?? '') || 0) || a.id.localeCompare(b.id);
  });
}
