import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { gzipSync, gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { stringify } from 'yaml';
import { indexRepository } from '../src/pipeline/index.js';
import { AnalysisCache, type CacheEvent } from '../src/pipeline/cache.js';
import type { SoftwareGraph } from '../src/core/graph.js';

test('cache budgets reject invalid limits and zero budgets disable reads and writes', async () => {
  const dir = await directory('codiluce-cache-bounds-');
  for (const limits of [{perUnit:-1,maxBytes:1024},{perUnit:1.5,maxBytes:1024},{perUnit:1,maxBytes:Infinity},{perUnit:1,maxBytes:1024,maxEntryBytes:NaN}]) assert.throws(() => new AnalysisCache(dir,limits), /nonnegative safe integer/);
  const seeded = new AnalysisCache(dir); await seeded.value('sample','unit',{},async()=> 'old');
  for (const limits of [{perUnit:0,maxBytes:1024},{perUnit:1,maxBytes:0},{perUnit:1,maxBytes:1024,maxEntryBytes:0}]) {
    const cache = new AnalysisCache(dir,limits);
    assert.equal(await cache.value('sample','unit',{},async()=> 'fresh'),'fresh');assert.equal(cache.events[0]!.hit,false);
  }
  assert.equal(await seeded.value('sample','unit',{},async()=> 'unexpected'),'old');
});
test('compressed and decoded entry budgets skip persistence while returning the computed result', async () => {
  for (const limits of [{perUnit:1,maxBytes:1,maxEntryBytes:1024},{perUnit:1,maxBytes:1024,maxEntryBytes:128}]) {
    const dir = await directory('codiluce-cache-bounds-'), cache = new AnalysisCache(dir,limits), value = '😀'.repeat(128);
    assert.equal(await cache.value('sample','unit',{},async()=>value),value);assert.deepEqual(await readdir(dir),[]);
    await cache.value('sample','unit',{},async()=>value);assert.ok(cache.events.every(event=>!event.hit));
  }
});
test('an oversized decoded cache payload becomes a miss despite its small gzip size', async () => {
  const dir = await directory('codiluce-cache-bounds-'), cache = new AnalysisCache(dir,{perUnit:2,maxBytes:4096,maxEntryBytes:256});
  await cache.value('sample','unit',{},async()=> 'small');
  const file = path.join(dir,(await readdir(dir))[0]!);
  await writeFile(file,gzipSync(JSON.stringify({format:1,value:'x'.repeat(1024*1024)})));
  assert.ok((await stat(file)).size<4096);
  assert.equal(await cache.value('sample','unit',{},async()=> 'recomputed'),'recomputed');assert.equal(cache.events.at(-1)!.hit,false);
  assert.equal(await cache.value('sample','unit',{},async()=> 'unexpected'),'recomputed');assert.equal(cache.events.at(-1)!.hit,true);
});
test('pruning enforces changed limits across all units and never exempts an oversized kept entry', async () => {
  const dir = await directory('codiluce-cache-bounds-'), cache = new AnalysisCache(dir,{perUnit:3,maxBytes:4096});
  for(const unit of ['one','two'])for(let i=0;i<3;i++)await cache.value('sample',unit,{i},async()=>i);
  assert.equal((await readdir(dir)).length,6);
  const smaller = new AnalysisCache(dir,{perUnit:1,maxBytes:4096});smaller.prune();assert.equal((await readdir(dir)).length,2);
  const keep = path.join(dir,(await readdir(dir))[0]!);await writeFile(keep,Buffer.alloc(5000));smaller.prune('sample','one',keep);
  assert.ok(!(await readdir(dir)).includes(path.basename(keep)));
  const files=await readdir(dir);assert.ok((await Promise.all(files.map(file=>stat(path.join(dir,file))))).reduce((sum,item)=>sum+item.size,0)<=4096);
});
test('malformed application patches are rejected before any graph replay and recovered from source', async () => {
  const root=await createFixture(), dir=await directory('codiluce-cache-shape-');await indexRepository(root,{cache:dir});
  const name=(await readdir(dir)).find(name=>name.startsWith('typescript-nextjs.frontend'))!, file=path.join(dir,name);
  const record=JSON.parse(gunzipSync(await readFile(file)).toString('utf8'));record.merged=[{id:'broken',evidence:null}];
  await writeFile(file,gzipSync(JSON.stringify(record)));
  const recovered=await indexWith(root,dir);assert.ok(recovered.misses.includes('typescript-nextjs:frontend'));
  same(recovered.graph,await indexRepository(root),'malformed patch recovery');
});

const fixture = fileURLToPath(new URL('./fixtures/repository', import.meta.url));
const temporary: string[] = [];
after(async () => { for (const folder of temporary) await rm(folder, { recursive: true, force: true }); });
async function directory(prefix: string): Promise<string> { const folder = await mkdtemp(path.join(tmpdir(), prefix)); temporary.push(folder); return folder; }
async function createFixture(): Promise<string> {
  const root = await directory('atlas-cache-');
  await cp(fixture, root, { recursive: true });
  await mkdir(path.join(root, '.codiluce'));
  await writeFile(path.join(root, '.codiluce/config.yml'), stringify({ repository: { name: 'fixture' }, applications: [{ name: 'frontend', path: 'frontend', type: 'nextjs' }, { name: 'backend', path: 'backend', type: 'laravel', apiOrigins: ['https://api.fixture.test'], apiOriginEnv: ['NEXT_PUBLIC_API_URL'] }] }));
  return root;
}
/** Graphs are persisted as JSON: compare what is stored (keys holding `undefined` are not). */
function same(actual: SoftwareGraph, expected: SoftwareGraph, message: string): void {
  const stored = (value: unknown) => JSON.parse(JSON.stringify(value));
  assert.deepEqual(stored(actual.entities), stored(expected.entities), `${message}: entities`);
  assert.deepEqual(stored(actual.relations), stored(expected.relations), `${message}: relations`);
  assert.deepEqual(stored(actual.diagnostics), stored(expected.diagnostics), `${message}: diagnostics`);
}
async function indexWith(root: string, cache: string): Promise<{ graph: SoftwareGraph; hits: string[]; misses: string[]; syntax:CacheEvent[] }> {
  const events: CacheEvent[] = [];
  const graph = await indexRepository(root, { cache, onCache: event => events.push(event) });
  const applications=events.filter(event=>event.analyzer!=='php-syntax-facts');
  return { graph, hits: applications.filter(event => event.hit).map(event => `${event.analyzer}:${event.unit}`).sort(), misses: applications.filter(event => !event.hit).map(event => `${event.analyzer}:${event.unit}`).sort(),syntax:events.filter(event=>event.analyzer==='php-syntax-facts') };
}
const UNITS = ['php-laravel:laravel', 'typescript-nextjs:backend', 'typescript-nextjs:frontend'];

test('indexing again replays every unchanged application and builds exactly the same graph', async () => {
  const root = await createFixture(), cache = await directory('atlas-cache-dir-');
  const first = await indexWith(root, cache);
  assert.deepEqual(first.misses, UNITS);
  assert.equal(first.syntax.length,24);assert.ok(first.syntax.every(event=>!event.hit));
  const second = await indexWith(root, cache);
  assert.deepEqual([second.hits, second.misses], [UNITS, []]);
  assert.equal(second.syntax.length,24);assert.ok(second.syntax.every(event=>event.hit));
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
  assert.deepEqual(backend.syntax.filter(event=>!event.hit).map(event=>event.unit),['backend/app/Services/AuditLog.php']);
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
