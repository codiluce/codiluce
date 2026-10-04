import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { stringify } from 'yaml';
import { indexRepository } from '../src/pipeline/index.js';
import { AnalysisCache, type CacheEvent } from '../src/pipeline/cache.js';
import type { SoftwareGraph } from '../src/core/graph.js';

const fixture = fileURLToPath(new URL('./fixtures/repository', import.meta.url));
const temporary: string[] = [];
after(async () => { for (const folder of temporary) await rm(folder, { recursive: true, force: true }); });
async function directory(prefix: string): Promise<string> { const folder = await mkdtemp(path.join(tmpdir(), prefix)); temporary.push(folder); return folder; }
async function createFixture(): Promise<string> {
  const root = await directory('atlas-cache-');
  await cp(fixture, root, { recursive: true });
  await mkdir(path.join(root, '.archipelago'));
  await writeFile(path.join(root, '.archipelago/config.yml'), stringify({ repository: { name: 'fixture' }, applications: [{ name: 'frontend', path: 'frontend', type: 'nextjs' }, { name: 'backend', path: 'backend', type: 'laravel', apiOrigins: ['https://api.fixture.test'], apiOriginEnv: ['NEXT_PUBLIC_API_URL'] }] }));
  return root;
}
/** Graphs are persisted as JSON: compare what is stored (keys holding `undefined` are not). */
function same(actual: SoftwareGraph, expected: SoftwareGraph, message: string): void {
  const stored = (value: unknown) => JSON.parse(JSON.stringify(value));
  assert.deepEqual(stored(actual.entities), stored(expected.entities), `${message}: entities`);
  assert.deepEqual(stored(actual.relations), stored(expected.relations), `${message}: relations`);
  assert.deepEqual(stored(actual.diagnostics), stored(expected.diagnostics), `${message}: diagnostics`);
}
async function indexWith(root: string, cache: string): Promise<{ graph: SoftwareGraph; hits: string[]; misses: string[] }> {
  const events: CacheEvent[] = [];
  const graph = await indexRepository(root, { cache, onCache: event => events.push(event) });
  return { graph, hits: events.filter(event => event.hit).map(event => `${event.analyzer}:${event.unit}`).sort(), misses: events.filter(event => !event.hit).map(event => `${event.analyzer}:${event.unit}`).sort() };
}
const UNITS = ['php-laravel:laravel', 'typescript-nextjs:backend', 'typescript-nextjs:frontend'];

test('indexing again replays every unchanged application and builds exactly the same graph', async () => {
  const root = await createFixture(), cache = await directory('atlas-cache-dir-');
  const first = await indexWith(root, cache);
  assert.deepEqual(first.misses, UNITS);
  const second = await indexWith(root, cache);
  assert.deepEqual([second.hits, second.misses], [UNITS, []]);
  same(second.graph, first.graph, 'replayed');
  same(second.graph, await indexRepository(root), 'versus no cache');
  // Effects updated by the API matcher (the endpoint a request reaches) are rebuilt on replay, not stored.
  const signIn = second.graph.entities.find(entity => entity.name === 'signIn')!;
  assert.ok((signIn.metadata.effects as { endpoint?: string }[]).some(effect => effect.endpoint));
});
test('a change re-analyzes only the application it belongs to; new files invalidate every application', async () => {
  const root = await createFixture(), cache = await directory('atlas-cache-dir-');
  await indexWith(root, cache);
  await writeFile(path.join(root, 'backend/app/Services/AuditLog.php'), "<?php\nnamespace App\\Services;\nclass AuditLog {\n    public function record(int $id): void {}\n    public function clear(): void {}\n}\n");
  const backend = await indexWith(root, cache);
  assert.deepEqual([backend.hits, backend.misses], [['typescript-nextjs:backend', 'typescript-nextjs:frontend'], ['php-laravel:laravel']]);
  same(backend.graph, await indexRepository(root), 'after a PHP edit');
  await writeFile(path.join(root, 'frontend/src/components/LoginForm.tsx'), "export async function login(email: string) {\n  return fetch('https://api.fixture.test/auth/login', { method: 'POST', body: email.trim() });\n}\nexport function LoginForm() {\n  return <form onSubmit={() => login('demo@example.com')}><button>Login</button></form>;\n}\n");
  const frontend = await indexWith(root, cache);
  assert.deepEqual([frontend.hits, frontend.misses], [['php-laravel:laravel', 'typescript-nextjs:backend'], ['typescript-nextjs:frontend']]);
  same(frontend.graph, await indexRepository(root), 'after a TypeScript edit');
  await writeFile(path.join(root, 'notes.md'), '# notes\n');
  const added = await indexWith(root, cache);
  assert.deepEqual(added.misses, UNITS, 'imports and route includes resolve against the path set');
});
test('the cache is bounded per unit and in bytes, and unreadable entries are misses', async () => {
  const root = await createFixture(), dir = await directory('atlas-cache-dir-');
  const cache = new AnalysisCache(dir, { perUnit: 2, maxBytes: 64 * 1024 * 1024 });
  const form = path.join(root, 'frontend/src/components/LoginForm.tsx');
  for (const variant of ['a', 'b', 'c']) { await writeFile(form, `export const ${variant} = 1;\n`); await indexRepository(root, { cache }); }
  const entries = (await readdir(dir)).filter(name => name.startsWith('typescript-nextjs.frontend'));
  assert.equal(entries.length, 2, 'only the two newest versions of the frontend are kept');
  for (const name of await readdir(dir)) await writeFile(path.join(dir, name), 'not gzip');
  const events: CacheEvent[] = [];
  const recovered = await indexRepository(root, { cache: new AnalysisCache(dir, undefined, event => events.push(event)) });
  assert.ok(events.every(event => !event.hit), 'corrupt entries are ignored');
  same(recovered, await indexRepository(root), 'after recovering from corrupt entries');
  const tiny = new AnalysisCache(dir, { perUnit: 2, maxBytes: 1 });
  tiny.prune();
  assert.deepEqual(await readdir(dir), [], 'a byte budget smaller than any entry empties the cache');
  // History snapshots (revisions) never use the cache.
  const revision: CacheEvent[] = [];
  await indexRepository(root, { cache: new AnalysisCache(dir, undefined, event => revision.push(event)), revision: '0'.repeat(40) });
  assert.deepEqual(revision, []);
});
