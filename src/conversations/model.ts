import type { ActivityPath, AgentProvider } from '../activity/model.js';
import { sessionKey } from '../harnesses/registry.js';

export type FileAction = 'read' | 'edited' | 'added';
export type CallStatus = 'completed' | 'failed' | 'unknown';
export interface ConversationMessage {
  id: string; role: 'user' | 'assistant' | 'tool'; text: string; at?: string;
  tool?: string; callId?: string; status?: CallStatus;
  truncated?: boolean;
}
/** Paths are observations from a tool's literal arguments, never mentions in prose. */
export interface ConversationPath {
  messageId: string; callId: string; path: string; scope: 'file' | 'directory';
  action: FileAction; status: CallStatus;
}
export interface ConversationSummary {
  id: string; provider: AgentProvider; sessionId: string; title: string; cwd: string;
  startedAt?: string; updatedAt?: string; messages: number; paths: number; excerpt: string;
}
export interface Conversation extends Omit<ConversationSummary, 'messages' | 'paths'> {
  messages: ConversationMessage[]; paths: ConversationPath[];
}
export interface ConversationQuery {
  query?: string; provider?: AgentProvider; path?: string; action?: FileAction;
  limit?: number; offset?: number;
}
export interface ConversationPage { items: ConversationSummary[]; total: number; limit: number; offset: number }
export interface ConversationDetail extends Conversation {
  totalMessages: number; offset: number; limit: number;
  footprint: (ConversationPath & { count: number })[];
  matches: string[];
}
/** A session told again on the map: its prompts, replies and tool calls in order, each call with the paths it named. */
export interface ReplayStep {
  at?: string; role: 'user' | 'assistant' | 'tool'; tool?: string; callId?: string; status?: CallStatus;
  paths: (ActivityPath & { action: FileAction })[];
}
export interface ConversationReplay {
  id: string; provider: AgentProvider; sessionId: string; title: string; steps: ReplayStep[];
  /** Earlier steps were left out (only the latest are replayed). */
  truncated: boolean;
}
export interface ImportResult { imported: number; unchanged: number; skipped: number; errors: string[] }
/** Latest public assistant text, read separately from the full archived transcript. */
export interface SessionUpdate { id: string; text: string; at?: string }
export interface LiveSession { id: string; provider: AgentProvider; sessionId: string; update?: SessionUpdate }
export const conversationId = sessionKey;
