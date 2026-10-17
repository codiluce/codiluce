import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { indexRepository } from '../src/pipeline/index.js';
import { resolveConfig } from '../src/core/config.js';

const roots: string[] = [];
after(async () => { await Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))); });
async function index(files: Record<string, string>) {
  const root = await mkdtemp(path.join(tmpdir(), 'codiluce-held-wrappers-')); roots.push(root);
  for (const [file, text] of Object.entries({ 'package.json': JSON.stringify({ name: 'tool', bin: { tool: 'main.ts' }, dependencies: { typescript: '^5' } }), ...files })) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), text);
  }
  const config = await resolveConfig(root, { repository: { name: 'tool' }, applications: [{ name: 'tool', path: '.' }] });
  return indexRepository(root, { config });
}
const server = `import {createServer} from 'node:http';
createServer((req,res)=>{const pathname=new URL(req.url ?? '/','http://local').pathname;
if(req.method !== 'GET'){res.end('bad');return;}
if(pathname==='/api/items'){return res.end('[]');}
});`;
const client = (construction: string) => `type Fetch=(input:string,init?:RequestInit)=>Promise<Response>;
export class Api {
  constructor(private readonly base='', private readonly fetcher: Fetch = (input, init) => fetch(input, init)) {}
  private async get(path: string) { return (await this.fetcher(\`\${this.base}\${path}\`, { headers: { Accept: 'application/json' } })).json(); }
  items() { return this.get('/api/items'); }
}
export const api = ${construction};`;

test('requests through a function held by a constructor parameter property resolve when every new of the class leaves it to its default', async () => {
  const graph = await index({ 'main.ts': server, 'client.ts': client(`new Api('')`) });
  const items = graph.entities.find(entity => entity.metadata.qualifiedName === 'Api.items')!;
  const endpoint = graph.entities.find(entity => entity.type === 'api_endpoint' && entity.name === 'GET /api/items')!;
  assert.ok(items && endpoint);
  const request = graph.relations.find(relation => relation.type === 'requests' && relation.from === items.id && relation.to === endpoint.id);
  assert.ok(request, JSON.stringify(graph.diagnostics.filter(item => item.code.includes('http'))));
  // The base is proven by the one construction: new Api('').
  assert.ok(request.evidence.some(fact => /this\.base is assigned ''/.test(fact.explanation ?? '')), JSON.stringify(request.evidence));
});

test('a held function some construction replaces, or a base it passes from a variable, stays unresolved', async () => {
  for (const construction of [`new Api('', (input) => Promise.resolve(new Response(input)))`, `new Api(process.argv[2] ?? '')`]) {
    const graph = await index({ 'main.ts': server, 'client.ts': client(construction) });
    assert.equal(graph.relations.some(relation => relation.type === 'requests'), false, construction);
  }
});

test('a browser request with a templated URL reaches a plain Node server through a configured proxy', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'codiluce-held-wrappers-')); roots.push(root);
  const files: Record<string, string> = {
    'server/package.json': JSON.stringify({ name: 'server', dependencies: { typescript: '^5' } }), 'server/main.ts': server,
    'web/package.json': JSON.stringify({ name: 'web', dependencies: { next: '*' } }),
    'web/client.ts': `"use client"; export function load(page: number) { return fetch(\`/api/items?page=\${page}\`); }`,
  };
  for (const [file, text] of Object.entries(files)) { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), text); }
  const config = await resolveConfig(root, { repository: { name: 'tool' }, applications: [{ name: 'web', path: 'web', apiProxies: [{ target: 'server', pathPrefix: '/api' }] }, { name: 'server', path: 'server' }] });
  const graph = await indexRepository(root, { config });
  const load = graph.entities.find(entity => entity.name === 'load')!, endpoint = graph.entities.find(entity => entity.type === 'api_endpoint' && entity.name === 'GET /api/items')!;
  const request = graph.relations.find(relation => relation.type === 'requests' && relation.from === load.id && relation.to === endpoint.id);
  assert.equal(request?.metadata?.resolution, 'configured-proxy', JSON.stringify(graph.diagnostics));
});
