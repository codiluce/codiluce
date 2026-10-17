import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { indexRepository } from '../src/pipeline/index.js';
import { resolveConfig } from '../src/core/config.js';

const roots: string[] = [];
after(async () => { await Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))); });

test('methods of object literals are named by where the object sits, so sibling objects do not collide', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'codiluce-symbols-')); roots.push(root);
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'tool', dependencies: { typescript: '^5' } }));
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src/tasks.ts'), `interface Task { collect(): string[]; parse(text: string): number }
export const folders: Task = { collect() { return []; }, parse(text) { return text.length; } };
export const files = { collect() { return []; }, parse(text: string) { return text.length; } } satisfies Task;
export function tools() {
  return [{ name: 'search', run() { return 1; } }, { name: 'entity', run() { return 2; } }, { run() { return 3; } }];
}
export const nested = { api: { get() { return 1; } }, admin: { get() { return 2; } } };
export class Service { collect() { return []; } }`);
  const config = await resolveConfig(root, { repository: { name: 'tool' }, applications: [{ name: 'tool', path: '.' }] });
  const graph = await indexRepository(root, { config });
  const names = graph.entities.filter(entity => entity.path === 'src/tasks.ts' && entity.type === 'method').map(entity => entity.metadata.qualifiedName).sort();
  assert.deepEqual(names, ['Service.collect', 'files.collect', 'files.parse', 'folders.collect', 'folders.parse', 'nested.admin.get', 'nested.api.get', 'tools.2.run', 'tools.entity.run', 'tools.search.run']);
  assert.equal(graph.diagnostics.some(item => item.code === 'duplicate-symbol'), false, JSON.stringify(graph.diagnostics));
});
