/** Observations, never claims about an agent's attention or intent. */
export type AgentProvider = 'codex' | 'claude-code';
export type ActivityKind = 'read' | 'edit' | 'search' | 'command' | 'test' | 'status';
export type ActivityPhase = 'started' | 'completed' | 'failed' | 'status';
export type AgentStatus = 'running' | 'waiting' | 'idle' | 'finished' | 'interrupted' | 'error' | 'unknown';
export interface ActivityPath { path: string; scope: 'file' | 'directory'; id?: string; ancestors?: string[]; exact?: boolean }
export interface ActivityEvent {
  id: string; at: number; provider: AgentProvider; actor: string;
  sessionId?: string; agentId?: string; toolId?: string; tool?: string;
  kind: ActivityKind; phase: ActivityPhase; label: string; paths: ActivityPath[];
  query?: string; status?: AgentStatus; sessionTitle?: string;
}
export interface AgentSession {
  actor: string; provider: AgentProvider; sessionId: string; agentId?: string;
  status: AgentStatus; lastSeen: number; label: string; title?: string;
}
export interface AgentConnection {
  provider: AgentProvider; configured: boolean; sources: string[];
  trust: 'trusted' | 'needs-review' | 'modified' | 'unknown'; disabled?: boolean;
  error?: string;
}
export interface AgentSetup {
  available: boolean; codex?: unknown; claude?: unknown; connections?: AgentConnection[];
}
export interface ActivitySnapshot {
  events: ActivityEvent[]; sessions: AgentSession[]; enabled: boolean;
}
export const ACTIVITY_TRAIL_MS = 30_000;
