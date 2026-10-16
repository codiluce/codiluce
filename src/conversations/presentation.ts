import type { AgentProvider } from '../activity/model.js';
import type { ConversationMessage } from './model.js';

/** Codex injects these as user messages; keep the archive, hide the setup row in the reader. */
export function isSessionSetup(message: Pick<ConversationMessage, 'role' | 'text'>, provider: AgentProvider): boolean {
  if (provider !== 'codex' || message.role !== 'user') return false;
  const value = message.text.trim();
  return /^# AGENTS\.md instructions for [^\n]+\r?\n\s*<INSTRUCTIONS>[\s\S]*<\/INSTRUCTIONS>(?:\s*<environment_context>[\s\S]*<\/environment_context>)?\s*$/.test(value)
    || /^<environment_context>[\s\S]*<\/environment_context>\s*$/.test(value);
}
