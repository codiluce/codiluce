import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ActivityEvent } from '../../src/activity/model';
import { activityMarks, agentColor } from '../lib/activity';

const event = (extra: Partial<ActivityEvent> = {}): ActivityEvent => ({ id: '1', at: 1000, actor: 'codex:one', provider: 'codex', kind: 'read', phase: 'completed', label: 'Read', paths: [{ path: 'src/a.ts', scope: 'file', id: 'file', ancestors: ['root', 'src'] }], ...extra });
test('map badges fade out, keep overlapping agents, and searches only mark their directory', () => {
  const events = [event(), event({ actor: 'claude:two', provider: 'claude-code' }), event({ id: '3', actor: 'codex:search', kind: 'search', paths: [{ path: 'src', scope: 'directory', id: 'src', ancestors: ['root'] }] })];
  const marks = activityMarks(events, 2000);
  assert.equal(marks.filter(mark => mark.id === 'file').length, 2);
  assert.equal(marks.filter(mark => mark.id === 'src').length, 1);
  assert.equal(marks.find(mark => mark.id === 'src')!.search, true);
  assert.equal(activityMarks(events, 31000).length, 0);
  assert.equal(activityMarks(events, 2000, 'codex:one').length, 1);
  assert.equal(activityMarks([event(), event({ at: 1500 })], 2000).length, 1);
  assert.equal(activityMarks([event({ phase: 'failed' })], 2000).length, 0);
  assert.equal(activityMarks([event({ toolId: 'failed-read', phase: 'started' }), event({ toolId: 'failed-read', phase: 'failed', at: 1500 })], 2000).length, 0);
  assert.equal(agentColor('codex:one'), agentColor('codex:one'));
  assert.notEqual(agentColor('codex:one'), agentColor('claude:two'));
});
