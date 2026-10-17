/** Observations, never claims about an agent's attention or intent. */
import type { HarnessId, HarnessProfile } from '../harnesses/registry.js';
export type AgentProvider = HarnessId;
export type ActivityKind = 'read' | 'edit' | 'search' | 'command' | 'test' | 'status';
export type ActivityPhase = 'started' | 'completed' | 'failed' | 'status';
export type AgentStatus = 'running' | 'waiting' | 'idle' | 'finished' | 'interrupted' | 'error' | 'unknown';
export interface ActivityPath { path: string; scope: 'file' | 'directory'; id?: string; ancestors?: string[]; exact?: boolean }
export interface ActivityEvent {
  id: string; at: number; provider: AgentProvider; actor: string;
  sessionId?: string; agentId?: string; toolId?: string; tool?: string;
  kind: ActivityKind; phase: ActivityPhase; label: string; paths: ActivityPath[];
  query?: string; status?: AgentStatus; sessionTitle?: string;
  lifecycle?: 'session-start' | 'session-end' | 'turn-start' | 'turn-end' | 'child-start' | 'child-end' | 'interrupt';
  turnId?: string; parentSessionId?: string; sourceEventId?: string; sourceInstanceId?: string;
}
export interface AgentSession {
  actor: string; provider: AgentProvider; sessionId: string; agentId?: string;
  status: AgentStatus; lastSeen: number; label: string; title?: string;
}
export interface AgentConnection {
  provider: AgentProvider; configured: boolean; sources: string[];
  trust: 'trusted' | 'needs-review' | 'modified' | 'unknown'; disabled?: boolean;
  error?: string;
  mcp?: { configured?: boolean; sources: string[] };
  profiles?: { id: string; configured: boolean; sources: string[]; mcp?: { configured?: boolean; sources: string[] } }[];
}
export interface AgentSetup {
  available: boolean; codex?: unknown; claude?: unknown; connections?: AgentConnection[];
  harnesses?: { id: HarnessId; label: string; profiles: HarnessProfile[]; historyNote: string; childAttribution: string }[];
  integrations?: AgentIntegration[];
}
export interface AgentIntegration {
  provider: HarnessId; profile: string; label: string; instructions: string[];
  files: { path: string; content: string; purpose: 'mcp' | 'activity' | 'plugin'; executable?: boolean }[];
  command: string;
}
export interface ActivitySnapshot {
  events: ActivityEvent[]; sessions: AgentSession[]; enabled: boolean;
}
export const ACTIVITY_TRAIL_MS = 30_000;
