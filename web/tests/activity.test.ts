import assert from 'node:assert/strict';
import { sessionKey } from '../../src/harnesses/registry';
import { test } from 'node:test';
import type { ActivityEvent } from '../../src/activity/model';
import { agentColor } from '../lib/activity';

const event = (extra: Partial<ActivityEvent> = {}): ActivityEvent => ({ id: '1', at: 1000, actor: 'codex:one', provider: 'codex', kind: 'read', phase: 'completed', label: 'Read', paths: [{ path: 'src/a.ts', scope: 'file', id: 'file', ancestors: ['root', 'src'] }], ...extra });
test('each agent keeps its own color', () => {
  assert.equal(agentColor('codex:one'), agentColor('codex:one'));
  assert.notEqual(agentColor('codex:one'), agentColor('claude:two'));
});

test('the files of the current turn stay listed until idle, without failed calls', async () => {
  const { activeSessionFiles } = await import('../lib/activity');
  const snapshot = { enabled: true, sessions: [{ actor: 'codex:one', provider: 'codex' as const, sessionId: 'one', status: 'running' as const, lastSeen: 60000, label: 'Read file' }], events: [
    event({ id: 'old', at: 500, paths: [{ path: 'src/old.ts', scope: 'file', id: 'old' }] }),
    event({ id: 'idle', at: 1000, kind: 'status', phase: 'status', status: 'idle', paths: [] }),
    event({ id: 'current', at: 2000, toolId: 'read' }),
    event({ id: 'bad-start', at: 3000, toolId: 'bad', paths: [{ path: 'bad.ts', scope: 'file', id: 'bad' }] }),
    event({ id: 'bad-end', at: 4000, toolId: 'bad', phase: 'failed', paths: [] }),
    event({ id: 'scope', at: 5000, kind: 'search', paths: [{ path: 'other', scope: 'directory', id: 'other', ancestors: ['root'] }] }),
  ] };
  assert.deepEqual(activeSessionFiles(snapshot, 60000).map(item => item.event.id), ['scope', 'current']);
  assert.deepEqual(activeSessionFiles({ ...snapshot, sessions: snapshot.sessions.map(session => ({ ...session, status: 'idle' })) }, 60000), []);
  assert.deepEqual(activeSessionFiles(snapshot, 400001), [], 'unconfirmed stale activity is no longer current');
});

test('new harness session keys retain file activity when native IDs contain separators', async () => {
  const { activeSessionFiles } = await import('../lib/activity');
  const id = sessionKey('pi', 'session:one');
  const snapshot = { enabled: true, sessions: [{ actor: id, provider: 'pi' as const, sessionId: 'session:one', status: 'running' as const, lastSeen: 2000, label: 'Read' }], events: [event({ actor: id, provider: 'pi', sessionId: 'session:one' })] };
  assert.equal(activeSessionFiles(snapshot, 2000, id).length, 1);
  assert.equal(activeSessionFiles(snapshot, 2000, 'pi:another').length, 0);
});
