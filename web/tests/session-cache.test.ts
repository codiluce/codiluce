import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SessionListCache, type SessionPage } from '../lib/session-cache';

function storage() {
  const items = new Map<string, string>();
  return { items, getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => { items.set(key, value); } };
}
const page = (scope = 'project-one', title = 'Saved session'): SessionPage => ({ scope, readOnly: false, total: 1, offset: 0, limit: 30, items: [{ id: 'codex:one', sessionId: 'one', provider: 'codex', title, cwd: '/project', excerpt: 'A discussion', messages: 3, paths: 1 }] });
const response = (value: SessionPage, etag = '"first"') => new Response(JSON.stringify(value), { headers: { ETag: etag } });

test('session summaries survive reloads and remain available during conditional background refresh', async () => {
  const saved = storage();
  const first = new SessionListCache(saved, async () => response(page())); first.setScope('project-one');
  await first.refresh();
  let resolve!: (value: Response) => void, calls = 0;
  const next = new SessionListCache(saved, async (_url, options) => {
    calls++; assert.equal(new Headers(options?.headers).get('If-None-Match'), '"first"');
    return new Promise(done => { resolve = done; });
  });
  next.setScope('project-one');
  const cached = next.peek(); assert.equal(cached?.items[0]?.title, 'Saved session');
  const checking = next.refresh(); assert.equal(next.refresh(), checking); assert.equal(calls, 1);
  assert.equal(next.peek(), cached, 'refresh never clears visible summaries');
  resolve(new Response(null, { status: 304 }));
  assert.equal(await checking, cached, 'unchanged responses reuse the existing list');
});

test('updated summaries replace the cache and failed refreshes keep the previous list', async () => {
  let fail = false, title = 'Old';
  const cache = new SessionListCache(storage(), async () => { if (fail) throw new Error('offline'); return response(page('project-one', title)); });
  cache.setScope('project-one'); await cache.refresh();
  title = 'New'; await cache.refresh(); assert.equal(cache.peek()?.items[0]?.title, 'New');
  fail = true; await assert.rejects(cache.refresh(), /offline/);
  assert.equal(cache.peek()?.items[0]?.title, 'New');
});

test('archive scopes isolate projects and discard responses still arriving from the previous project', async () => {
  const saved = storage(); let resolve!: (value: Response) => void;
  const cache = new SessionListCache(saved, async () => new Promise(done => { resolve = done; }));
  cache.setScope('project-one'); const checking = cache.refresh();
  cache.setScope('project-two'); resolve(response(page()));
  await assert.rejects(checking, { name: 'AbortError' }); assert.equal(cache.peek(), undefined);
  const other = new SessionListCache(saved, async () => response(page('project-two')));
  other.setScope('project-two'); await other.refresh();
  other.setScope('project-one'); assert.equal(other.peek(), undefined);
});

test('bad or expired browser storage and quota errors do not prevent loading sessions', async () => {
  for (const raw of ['broken JSON', JSON.stringify({ version: 1, value: page(), savedAt: 0 }), JSON.stringify({ version: 1, value: page('another-project'), savedAt: Date.now() })]) {
    const cache = new SessionListCache({ getItem: () => raw, setItem: () => { throw new Error('quota'); } }, async () => response(page()));
    cache.setScope('project-one'); assert.equal(cache.peek(), undefined);
    await cache.refresh(); assert.equal(cache.peek()?.total, 1);
  }
});

test('filtered pages stay in memory and manual synchronization waits for an older request before refreshing', async () => {
  const saved = storage(); let calls = 0, resolve!: (value: Response) => void;
  const cache = new SessionListCache(saved, async () => ++calls === 1 ? new Promise(done => { resolve = done; }) : response(page('project-one', 'After import')));
  cache.setScope('project-one'); const pending = cache.refresh(); const afterImport = cache.refresh({}, true);
  resolve(response(page('project-one', 'Before import'))); await pending; await afterImport;
  assert.equal(cache.peek()?.items[0]?.title, 'After import'); assert.equal(calls, 2);
  await cache.refresh({ query: 'decision' });
  const reloaded = new SessionListCache(saved); reloaded.setScope('project-one');
  assert.ok(reloaded.peek()); assert.equal(reloaded.peek({ query: 'decision' }), undefined);
});
