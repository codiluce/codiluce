import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentConversations } from '../lib/agent-conversations';
import type { AgentSession } from '../../src/activity/model';
import type { ConversationSummary } from '../../src/conversations/model';

const saved: ConversationSummary = { id: 'codex:one', provider: 'codex', sessionId: 'one', title: 'Fix login', cwd: '/repo', messages: 3, paths: 1, excerpt: 'Why did login fail?', updatedAt: '2026-10-15T10:00:00Z' };
const now = Date.parse('2026-10-15T11:00:00Z');
const session: AgentSession = { actor: 'codex:one', provider: 'codex', sessionId: 'one', status: 'running', lastSeen: now, label: 'Read file', title: 'Fix login' };

test('merges live agents by provider and session, preserving the saved conversation and separate provider identity', () => {
  const rows = agentConversations([saved], [session, { ...session, actor: 'subagent', agentId: 'child', status: 'waiting' }, { ...session, actor: 'claude-code:one', provider: 'claude-code' }], now, true);
  assert.equal(rows.length, 2);
  const codex = rows.find(row => row.id === 'codex:one')!;
  assert.equal(codex.sessions.length, 2); assert.equal(codex.status, 'waiting'); assert.equal(codex.saved, saved);
  assert.equal(rows.find(row => row.id === 'claude-code:one')?.saved, undefined);
});

test('active sessions rise above history, stale sessions lose running status, and filtered history excludes unmatched live sessions', () => {
  const recent = { ...saved, id: 'codex:two', sessionId: 'two', updatedAt: new Date(now + 1000).toISOString() };
  assert.equal(agentConversations([recent, saved], [session], now, true)[0]!.id, saved.id);
  assert.equal(agentConversations([recent, saved], [session], now + 300001, true).find(row => row.id === saved.id)?.status, 'unknown');
  assert.deepEqual(agentConversations([recent], [session], now, false).map(row => row.id), [recent.id]);
  assert.equal(agentConversations([recent], [{ ...session, sessionId: 'different', title: recent.title }], now, true).length, 2, 'a matching title does not merge different sessions');
});
