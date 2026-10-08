import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { indexRepository } from '../src/pipeline/index.js';
import { resolveConfig, type ApplicationInput } from '../src/core/config.js';
import { canonicalJson } from '../src/history/fingerprint.js';
import { AnalysisCache } from '../src/pipeline/cache.js';
import { compileExpressPath, matchRoutePattern } from '../src/analysis/routes/contracts.js';
import type { SoftwareGraph } from '../src/core/graph.js';

const temporary: string[] = [];
after(async () => { await Promise.all(temporary.map(root => rm(root, { recursive: true, force: true }))); });
async function repository(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'codiluce-express-')); temporary.push(root);
  for (const [file, text] of Object.entries(files)) { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), text); }
  return root;
}
const json = JSON.stringify;
const endpoints = (graph: SoftwareGraph) => graph.entities.filter(entity => entity.type === 'api_endpoint');
const stored = (graph: SoftwareGraph) => canonicalJson({ entities: graph.entities, relations: graph.relations, diagnostics: graph.diagnostics });

test('Express imports, helper summaries, arrays, chained verbs and nested multiple mounts bind exact handlers', async () => {
  const root = await repository({
    'package.json': json({ dependencies: { express: '^5.1.0' } }),
    'main.ts': 'import create from "express"; import router, { register } from "./router"; const app = create(); app.use("/v1", router); app.use("/v2", router); register(app); app.listen(3000);',
    'router.ts': 'import { Router as make } from "express"; import { list as handler } from "./barrel"; const router = make(); const child = make(); child.route("/:id").get(handler).post([handler, (req, res) => leaf()]); router.use("/items", child); export default router; export function register(app) { app.get(["/health", "/ready"], handler); } function leaf() {}',
    'barrel.ts': 'export { list } from "./handlers";',
    'handlers.ts': 'export function list(req, res) { return "ok"; }',
  });
  const graph = await indexRepository(root);
  assert.deepEqual(endpoints(graph).map(endpoint => endpoint.name).sort(), ['GET /health', 'GET /ready', 'GET /v1/items/:id', 'GET /v2/items/:id', 'POST /v1/items/:id', 'POST /v2/items/:id']);
  const list = graph.entities.find(entity => entity.name === 'list')!;
  assert.equal(graph.relations.filter(relation => relation.type === 'handles' && relation.to === list.id).length, 6);
  const inline = graph.entities.find(entity => entity.metadata.framework === 'express' && entity.metadata.role === 'handler')!;
  const leaf = graph.entities.find(entity => entity.name === 'leaf')!;
  assert.ok(graph.relations.some(relation => relation.type === 'calls' && relation.from === inline.id && relation.to === leaf.id));
  assert.equal(graph.entities.find(entity => entity.path === 'main.ts' && entity.type === 'file')?.metadata.analysis && (graph.entities.find(entity => entity.path === 'main.ts' && entity.type === 'file')!.metadata.analysis as any).features.framework.status, 'partial');
});

test('same-line inline callbacks own calls and HTTP effects independently before language references', async () => {
  const root = await repository({
    'package.json': json({ dependencies: { express: '5.1.0' } }),
    'main.ts': 'import express from "express"; const app = express(); function one() {} function two() {} app.get("/one", () => { one(); fetch("https://remote.invalid/one"); }); app.get("/two", () => { two(); fetch("https://remote.invalid/two"); });',
  });
  const graph = await indexRepository(root);
  for (const name of ['one', 'two']) {
    const endpoint = endpoints(graph).find(endpoint => endpoint.name === `GET /${name}`)!;
    const handlerId = graph.relations.find(relation => relation.type === 'handles' && relation.from === endpoint.id)!.to;
    const handler = graph.entities.find(entity => entity.id === handlerId)!;
    const target = graph.entities.find(entity => entity.name === name)!;
    assert.ok(graph.relations.some(relation => relation.type === 'calls' && relation.from === handlerId && relation.to === target.id));
    assert.equal((handler.metadata.effects as any[]).filter(effect => effect.category === 'network').length, 1);
    assert.ok((handler.metadata.effects as any[]).some(effect => effect.detail.endsWith(`/${name}`)));
  }
  const file = graph.entities.find(entity => entity.type === 'file' && entity.path === 'main.ts')!;
  assert.equal((file.metadata.effects as any[] | undefined)?.some(effect => effect.category === 'network') ?? false, false);
});

test('unmounted routers, unused factories, type-only imports and unrelated get/use methods do not emit endpoints', async () => {
  const root = await repository({
    'package.json': json({ dependencies: { express: '^4.21.0' } }),
    'main.ts': 'import express, { Router } from "express"; import type { Router as TypeRouter } from "express"; const hidden = Router(); hidden.get("/hidden", () => {}); function unused() { const app = express(); app.get("/unused", () => {}); } const fake = { get() {}, use() {} }; fake.get("/fake", () => {}); const types = TypeRouter(); types.get("/type", () => {}); const app = express(); app.get("env"); app.get("/live", () => {});',
  });
  const graph = await indexRepository(root);
  assert.deepEqual(endpoints(graph).map(endpoint => endpoint.name), ['GET /live']);
  const file = graph.entities.find(entity => entity.type === 'file' && entity.path === 'main.ts')!;
  assert.ok((file.metadata.registrations as any[]).some(receiver => receiver.kind === 'router' && receiver.routes.some((route: any) => route.paths.includes('/hidden'))));
});

test('Express 4/5 route profiles preserve optional groups, wildcard cardinality, literals and opaque competitors', () => {
  const optional4 = compileExpressPath('/users/:id?', 4);
  assert.ok(matchRoutePattern(optional4, '/users'));
  assert.ok(matchRoutePattern(optional4, '/users/12'));
  assert.equal(matchRoutePattern(optional4, '/users/12/edit'), false);
  const optional5 = compileExpressPath('/files{/:name}{.:ext}', 5);
  assert.equal(optional5.status, 'exact');
  for (const path of ['/files', '/files/test', '/files/test.json']) assert.ok(matchRoutePattern(optional5, path));
  assert.equal(matchRoutePattern(compileExpressPath('/*splat', 5), '/'), false);
  assert.ok(matchRoutePattern(compileExpressPath('/{*splat}', 5), '/'));
  assert.ok(matchRoutePattern(compileExpressPath('/ab?cd', 4), '/abcd'));
  assert.equal(compileExpressPath('/ab?cd', 4).status, 'partial');
  assert.equal(compileExpressPath('/users/:id?', 5).status, 'partial');
  assert.equal(compileExpressPath('/{*splat}', undefined).status, 'partial');
  assert.equal(matchRoutePattern(compileExpressPath('/users/new', 5), '/users/{*}'), false);
  assert.ok(matchRoutePattern(compileExpressPath('/users/new', 5), '/users/{*}', false));
});

test('CommonJS construction, destructured Router aliases, factories and duplicate mount sites retain registration identity', async () => {
  const root = await repository({
    'package.json': json({ dependencies: { express: '^4.21.0' } }),
    'main.js': 'const create = require("express"); const { Router: make } = require("express"); function factory() { const router = make(); router.get("/users/:id?", (req, res) => {}); return router; } const app = create(); const first = factory(); const second = factory(); app.use("/v1", first); app.use("/v2", second); app.use("/v1", first);',
  });
  const graph = await indexRepository(root);
  assert.equal(endpoints(graph).length, 3);
  assert.equal(new Set(endpoints(graph).map(endpoint => endpoint.id)).size, 3);
  assert.equal(endpoints(graph).filter(endpoint => endpoint.name === 'GET /v1/users/:id?').length, 2);
  assert.ok(endpoints(graph).every(endpoint => (endpoint.metadata.routing as any).pattern.dialect === 'express-4'));
});

test('conditional and opaque registrations remain candidates and prevent an unjustified unique HTTP match', async () => {
  const root = await repository({
    'package.json': json({ dependencies: { express: '^5.1.0' } }),
    'main.ts': 'import express from "express"; const app = express(); app.get("/known", () => {}); if (process.env.ENABLED) app.get("/conditional", () => {}); app.get(/unknown.*/, () => {}); function client() { fetch("https://api.invalid/known"); }',
  });
  const config = await resolveConfig(root, { repository: { name: 'fixture' }, applications: [{ name: 'server', path: '.', apiOrigins: ['https://api.invalid'] }] });
  const graph = await indexRepository(root, { config });
  assert.equal(endpoints(graph).length, 3);
  assert.equal(graph.relations.some(relation => relation.type === 'requests'), false);
  assert.ok(graph.diagnostics.some(diagnostic => diagnostic.code === 'ambiguous-http-match'));
  assert.ok(endpoints(graph).filter(endpoint => endpoint.metadata.constraintsUnresolved).length === 2);
});

test('framework barrel aliases and indexed CommonJS router/handler exports resolve without dependency installation', async () => {
  const root = await repository({
    'package.json': json({ dependencies: { express: '^5.1.0' } }),
    'main.js': 'const express = require("express"); const router = require("./router"); const { register: helper } = require("./helper"); const app = express(); app.use("/api", router); helper(app);',
    'router.js': 'import { make } from "./framework"; const { list: handler } = require("./handlers"); const router = make(); router.get("/items", handler); module.exports = router;',
    'framework.js': 'export { Router as make } from "express";',
    'handlers.js': 'function list(req, res) { return "ok"; } module.exports = { list };',
    'helper.js': 'function register(app) { app.get("/health", () => {}); } module.exports = { register };',
  });
  const graph = await indexRepository(root);
  assert.deepEqual(endpoints(graph).map(endpoint => endpoint.name).sort(), ['GET /api/items', 'GET /health'], canonicalJson({ diagnostics: graph.diagnostics, registrations: graph.entities.filter(entity => entity.type === 'file').map(entity => [entity.path, entity.metadata.registrations]) }));
  const list = graph.entities.find(entity => entity.name === 'list')!;
  assert.ok(graph.relations.some(relation => relation.type === 'handles' && relation.to === list.id));
});

test('reassigned framework factories and mutated receiver APIs do not retain stale framework identity', async () => {
  const root = await repository({
    'package.json': json({ dependencies: { express: '^5.1.0' } }),
    'main.ts': 'import express from "express"; let create = express; create = () => ({ get() {} }); const fake = create(); fake.get("/fake", () => {}); const app = express(); app.get = () => {}; app.get("/changed", () => {});',
  });
  const graph = await indexRepository(root);
  assert.equal(endpoints(graph).length, 0);
});

test('GET includes implicit HEAD and all() covers other verbs without inventing separate endpoint identities', async () => {
  const root = await repository({
    'package.json': json({ dependencies: { express: '^5.1.0' } }),
    'main.ts': 'import express from "express"; const app = express(); app.get(["/get", "/get"], () => {}); app.all("/any", () => {}); export function head() { fetch("https://api.invalid/get", { method: "HEAD" }); } export function put() { fetch("https://api.invalid/any", { method: "PUT" }); }',
  });
  const config = await resolveConfig(root, { repository: { name: 'fixture' }, applications: [{ name: 'server', path: '.', apiOrigins: ['https://api.invalid'] }] });
  const graph = await indexRepository(root, { config });
  assert.equal(endpoints(graph).length, 2);
  const requests = graph.relations.filter(relation => relation.type === 'requests');
  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map(relation => relation.metadata?.method).sort(), ['HEAD', 'PUT']);
});

test('generic endpoints require explicit origins or browser proxy proof; server-relative calls stay unresolved', async () => {
  const root = await repository({
    'web/package.json': json({ dependencies: { next: '*' } }),
    'web/client.ts': '"use client"; export function absolute() { fetch("https://api.invalid/items/7"); } export function relative() { fetch("/proxy/items/7"); }',
    'server/package.json': json({ dependencies: { express: '^5.1.0' } }),
    'server/main.ts': 'import express from "express"; const app = express(); app.get("/items/:id", () => {}); app.get("/outgoing", () => fetch("/items/7"));',
  });
  const applications: ApplicationInput[] = [{ name: 'web', path: 'web', apiProxies: [{ target: 'server', pathPrefix: '/proxy', targetPrefix: '/' }] }, { name: 'server', path: 'server', apiOrigins: ['https://api.invalid'] }];
  const graph = await indexRepository(root, { config: await resolveConfig(root, { repository: { name: 'fixture' }, applications }) });
  const requests = graph.relations.filter(relation => relation.type === 'requests');
  assert.equal(requests.length, 2, canonicalJson(graph.diagnostics));
  assert.ok(requests.some(relation => relation.metadata?.resolution === 'configured-proxy'));
  assert.ok(graph.diagnostics.some(diagnostic => diagnostic.code === 'unverified-relative-api-boundary' && diagnostic.file === 'server/main.ts'));
  const configWithout = await resolveConfig(root, { repository: { name: 'fixture' }, applications: applications.map(app => ({ ...app, apiProxies: undefined })) });
  const without = await indexRepository(root, { config: configWithout });
  assert.equal(without.relations.filter(relation => relation.type === 'requests').length, 1);
});

test('cold, warm and revision graphs preserve handler ownership; shared registration changes invalidate consumers', async () => {
  const root = await repository({
    'package.json': json({ workspaces: ['app', 'shared'] }),
    'app/package.json': json({ dependencies: { express: '^5.1.0', '@fixture/router': 'workspace:*' } }),
    'app/main.ts': 'import express from "express"; import router from "@fixture/router"; const app = express(); app.use("/api", router);',
    'shared/package.json': json({ name: '@fixture/router', exports: './main.ts', dependencies: { express: '^5.1.0' } }),
    'shared/main.ts': 'import { Router } from "express"; const router = Router(); function leaf() {} router.get("/one", () => leaf()); export default router;',
  });
  const config = await resolveConfig(root, { repository: { name: 'fixture' }, applications: [{ name: 'app', path: 'app' }] });
  const cache = new AnalysisCache(path.join(root, '.codiluce/cache'));
  const cold = await indexRepository(root, { config, cache }), warm = await indexRepository(root, { config, cache });
  assert.deepEqual(endpoints(cold).map(endpoint => endpoint.name), ['GET /api/one']);
  assert.equal(stored(warm), stored(cold));
  assert.ok(cache.events.some(event => event.analyzer === 'typescript-nextjs' && event.hit));
  const revision = await indexRepository(root, { config, revision: '1'.repeat(40) });
  assert.equal(canonicalJson(revision.entities), canonicalJson(cold.entities));
  assert.equal(canonicalJson(revision.relations), canonicalJson(cold.relations));
  await writeFile(path.join(root, 'shared/main.ts'), 'import { Router } from "express"; const router = Router(); function leaf() {} router.get("/two", () => leaf()); export default router;');
  const changed = await indexRepository(root, { config, cache });
  assert.deepEqual(endpoints(changed).map(endpoint => endpoint.name), ['GET /api/two']);
  assert.equal(cache.events.at(-1)?.hit, false);
});
