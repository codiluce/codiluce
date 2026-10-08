import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { indexRepository } from '../src/pipeline/index.js';
import { resolveConfig } from '../src/core/config.js';
import { AnalysisCache } from '../src/pipeline/cache.js';
import { canonicalJson } from '../src/history/fingerprint.js';
import type { SoftwareGraph } from '../src/core/graph.js';

const temporary: string[] = [];
after(async () => { await Promise.all(temporary.map(root => rm(root, { recursive: true, force: true }))); });
async function repository(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'codiluce-nest-')); temporary.push(root);
  for (const [file, text] of Object.entries(files)) { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), text); }
  return root;
}
const json = JSON.stringify;
const manifest = json({ dependencies: { '@nestjs/core': '^11.1.0', '@nestjs/common': '^11.1.0' } });
const endpoints = (graph: SoftwareGraph) => graph.entities.filter(entity => entity.type === 'api_endpoint');
const semantic = (graph: SoftwareGraph) => canonicalJson({ entities: graph.entities, relations: graph.relations, diagnostics: graph.diagnostics });

test('Nest bootstrap reaches imported modules/controllers with aliases, prefixes, arrays and exact method calls', async () => {
  const root = await repository({
    'package.json': manifest,
    'main.ts': 'import { NestFactory as Factory } from "@nestjs/core"; import { Root as Module } from "./modules"; async function bootstrap(prefix) { const app = await Factory.create(Module); app.setGlobalPrefix(prefix); await app.listen(3000); } bootstrap("api");',
    'modules.ts': 'import { Module as Register } from "@nestjs/common"; import { Catalog as Controller } from "./barrel"; @Register({ controllers: [Controller] }) class Child {} @Register({ imports: [Child] }) export class Root {}',
    'barrel.ts': 'export { Catalog } from "./controllers";',
    'controllers.ts': 'import { Controller as Group, Get as Read, Post, HttpCode } from "@nestjs/common"; function leaf() {} @Group(["items", "products"]) export class Catalog { @Read(["", ":id"]) list() { leaf(); return []; } @Post() @HttpCode(202) save() { return {}; } }',
  });
  const graph = await indexRepository(root);
  assert.deepEqual(endpoints(graph).map(endpoint => endpoint.name).sort(), ['GET /api/items', 'GET /api/items/:id', 'GET /api/products', 'GET /api/products/:id', 'POST /api/items', 'POST /api/products']);
  const list = graph.entities.find(entity => entity.name === 'list')!, leaf = graph.entities.find(entity => entity.name === 'leaf')!;
  assert.ok(graph.relations.some(relation => relation.type === 'calls' && relation.from === list.id && relation.to === leaf.id));
  const save = graph.entities.find(entity => entity.name === 'save')!;
  assert.equal((save.metadata.effects as any[]).filter(effect => effect.category === 'response').length, 1);
  assert.equal((save.metadata.effects as any[])[0].status, 202);
  assert.ok(graph.entities.some(entity => entity.name === 'Catalog' && entity.type === 'controller'));
});

test('unregistered controllers, unused bootstraps, lookalike decorators and application contexts do not become HTTP endpoints', async () => {
  const root = await repository({
    'package.json': manifest,
    'main.ts': 'import { NestFactory } from "@nestjs/core"; import { Module, Controller, Get } from "@nestjs/common"; @Controller("live") class Live { @Get() run() {} } @Controller("unused") class Unused { @Get() run() {} } @Module({ controllers: [Live] }) class Root {} @Module({ controllers: [Unused] }) class Hidden {} async function never() { await NestFactory.create(Hidden); } async function bootstrap() { await NestFactory.create(Root); await NestFactory.createApplicationContext(Hidden); } bootstrap();',
    'fake.ts': 'function Controller(path) { return () => {}; } function Get(path?) { return () => {}; } @Controller("fake") export class Fake { @Get() run() {} }',
  });
  const graph = await indexRepository(root);
  assert.deepEqual(endpoints(graph).map(endpoint => endpoint.name), ['GET /live']);
});

test('declared constructor injection and controller/method/global framework roles are references, not execution claims', async () => {
  const root = await repository({
    'package.json': manifest,
    'main.ts': 'import { NestFactory } from "@nestjs/core"; import { Module, Controller, Injectable, Get, UseGuards, UsePipes, UseInterceptors, Inject } from "@nestjs/common"; @Injectable() class Service { work() {} } class Guard {} class Pipe {} class Interceptor {} @Controller("items") @UseGuards(Guard) class Items { constructor(private service: Service, @Inject("TOKEN") unknown) {} @Get() @UsePipes(Pipe) @UseInterceptors(Interceptor) list() { return []; } } @Module({ controllers: [Items], providers: [Service] }) class Root {} async function bootstrap() { const app = await NestFactory.create(Root); app.useGlobalGuards(new Guard()); } bootstrap();',
  });
  const graph = await indexRepository(root);
  const controller = graph.entities.find(entity => entity.name === 'Items')!, service = graph.entities.find(entity => entity.name === 'Service')!;
  assert.ok(graph.relations.some(relation => relation.from === controller.id && relation.to === service.id && relation.type === 'references' && relation.metadata?.role === 'injection'));
  assert.equal(graph.relations.some(relation => relation.from === controller.id && relation.to === service.id && relation.type === 'calls'), false);
  const roles = graph.relations.filter(relation => relation.from === endpoints(graph)[0]?.id && relation.type === 'references').map(relation => relation.metadata?.role);
  for (const role of ['guard', 'pipe', 'interceptor']) assert.ok(roles.includes(role));
  assert.ok(graph.diagnostics.some(diagnostic => diagnostic.code === 'nest-unresolved-injection'));
});

test('URI versions compose after global prefix, method versions override controller versions, and neutral routes omit them', async () => {
  const root = await repository({
    'package.json': manifest,
    'main.ts': 'import { NestFactory } from "@nestjs/core"; import { Module, Controller, Get, Version, VersioningType, VERSION_NEUTRAL } from "@nestjs/common"; @Controller({ path: "items", version: ["1", "2"] }) class Items { @Get() list() {} @Get("special") @Version("3") special() {} @Get("health") @Version(VERSION_NEUTRAL) health() {} } @Controller("unversioned") class Unversioned { @Get() missing() {} } @Module({ controllers: [Items, Unversioned] }) class Root {} async function bootstrap() { const app = await NestFactory.create(Root); app.setGlobalPrefix("api"); app.enableVersioning({ type: VersioningType.URI }); } bootstrap();',
  });
  const graph = await indexRepository(root);
  assert.deepEqual(endpoints(graph).map(endpoint => endpoint.name).sort(), ['GET /api/items/health', 'GET /api/v1/items', 'GET /api/v2/items', 'GET /api/v3/items/special']);
  assert.ok(graph.diagnostics.some(diagnostic => diagnostic.code === 'nest-unversioned-route'));
  assert.ok(endpoints(graph).every(endpoint => !endpoint.metadata.constraintsUnresolved));
});

test('nested RouterModule records mount only bootstrap-imported modules and retain mount proof', async () => {
  const root = await repository({
    'package.json': manifest,
    'main.ts': 'import { NestFactory, RouterModule } from "@nestjs/core"; import { Module, Controller, Get } from "@nestjs/common"; @Controller("users") class Users { @Get(":id") get() {} } @Controller("settings") class Settings { @Get() get() {} } @Module({ controllers: [Users] }) class Admin {} @Module({ controllers: [Settings] }) class Config {} @Module({ imports: [Admin, Config, RouterModule.register([{ path: "admin", module: Admin, children: [{ path: "config", module: Config }] }])] }) class Root {} async function bootstrap() { await NestFactory.create(Root); } bootstrap();',
  });
  const graph = await indexRepository(root);
  assert.deepEqual(endpoints(graph).map(endpoint => endpoint.name).sort(), ['GET /admin/config/settings', 'GET /admin/users/:id']);
  assert.ok(endpoints(graph).every(endpoint => endpoint.evidence.some(fact => fact.explanation?.includes('RouterModule.register'))));
});

test('Fastify transport emits Nest endpoints once; host, header-version and dynamic prefix constraints cannot confirm requests', async () => {
  const root = await repository({
    'package.json': json({ dependencies: { '@nestjs/core': '^11.1.0', '@nestjs/common': '^11.1.0', '@nestjs/platform-fastify': '^11.1.0', express: '^5.1.0' } }),
    'main.ts': 'import { NestFactory } from "@nestjs/core"; import { FastifyAdapter } from "@nestjs/platform-fastify"; import { Module, Controller, Get, VersioningType } from "@nestjs/common"; @Controller({ path: "items", host: ":tenant.api.invalid", version: "1" }) class Items { @Get() list() {} } @Module({ controllers: [Items] }) class Root {} async function bootstrap() { const app = await NestFactory.create(Root, new FastifyAdapter()); app.enableVersioning({ type: VersioningType.HEADER, header: "X-Version" }); } bootstrap(); function request() { fetch("https://api.invalid/items"); }',
  });
  const config = await resolveConfig(root, { repository: { name: 'fixture' }, applications: [{ name: 'api', path: '.', apiOrigins: ['https://api.invalid'] }] });
  const graph = await indexRepository(root, { config });
  assert.equal(endpoints(graph).length, 1);
  assert.equal(endpoints(graph)[0]!.metadata.transport, 'fastify');
  assert.equal(endpoints(graph)[0]!.metadata.constraintsUnresolved, true);
  assert.equal(graph.relations.some(relation => relation.type === 'requests'), false);
  assert.ok(graph.diagnostics.some(diagnostic => diagnostic.code === 'constrained-http-match'));
});

test('Nest endpoints match configured origins and cache/history replay preserves registered handlers', async () => {
  const root = await repository({
    'api/package.json': manifest,
    'api/main.ts': 'import { NestFactory } from "@nestjs/core"; import { Root } from "./module"; async function bootstrap() { await NestFactory.create(Root); } bootstrap();',
    'api/module.ts': 'import { Module, Controller, Get } from "@nestjs/common"; @Controller("items") class Items { @Get(":id") item() {} } @Module({ controllers: [Items] }) export class Root {}',
    'web/package.json': json({ dependencies: { next: '*' } }),
    'web/client.ts': '"use client"; export function request() { fetch("https://api.invalid/items/7"); }',
  });
  const config = await resolveConfig(root, { repository: { name: 'fixture' }, applications: [{ name: 'api', path: 'api', apiOrigins: ['https://api.invalid'] }, { name: 'web', path: 'web' }] });
  const cache = new AnalysisCache(path.join(root, '.codiluce/cache'));
  const cold = await indexRepository(root, { config, cache }), warm = await indexRepository(root, { config, cache });
  assert.equal(cold.relations.filter(relation => relation.type === 'requests').length, 1);
  assert.equal(semantic(warm), semantic(cold));
  const revision = await indexRepository(root, { config, revision: '1'.repeat(40) });
  assert.equal(canonicalJson(revision.entities), canonicalJson(cold.entities));
  assert.equal(canonicalJson(revision.relations), canonicalJson(cold.relations));
  await writeFile(path.join(root, 'api/module.ts'), 'import { Module, Controller, Get } from "@nestjs/common"; @Controller("things") class Items { @Get(":id") item() {} } @Module({ controllers: [Items] }) export class Root {}');
  const changed = await indexRepository(root, { config, cache });
  assert.deepEqual(endpoints(changed).map(endpoint => endpoint.name), ['GET /things/:id']);
  assert.equal(changed.relations.some(relation => relation.type === 'requests'), false);
});

test('default URI versioning, forwardRef modules and factory-returned app aliases retain bootstrap proof and stable IDs', async () => {
  const root = await repository({
    'package.json': manifest,
    'main.ts': 'import { NestFactory } from "@nestjs/core"; import { Module, Controller, Get, forwardRef } from "@nestjs/common"; @Controller("items") class Items { @Get() item() {} } @Module({ controllers: [Items], imports: [forwardRef(() => Root)] }) class Child {} @Module({ imports: [Child] }) class Root {} async function make() { return await NestFactory.create(Root); } async function bootstrap() { const created = await make(); const app = created; app.setGlobalPrefix("api"); app.enableVersioning({ defaultVersion: "1", prefix: false }); } void bootstrap();',
  });
  const before = await indexRepository(root);
  assert.deepEqual(endpoints(before).map(endpoint => endpoint.name), ['GET /api/1/items']);
  const text = await import('node:fs/promises').then(fs => fs.readFile(path.join(root, 'main.ts'), 'utf8'));
  await writeFile(path.join(root, 'main.ts'), `// inserted source line\n${text}`);
  const after = await indexRepository(root);
  assert.deepEqual(endpoints(after).map(endpoint => endpoint.id), endpoints(before).map(endpoint => endpoint.id));
  assert.ok(endpoints(after)[0]!.evidence.some(fact => fact.explanation?.includes('bootstrap helper')));
});

test('type-only framework bindings, custom composite decorators and dynamic metadata cannot invent confirmed registrations', async () => {
  const root = await repository({
    'package.json': manifest,
    'main.ts': 'import { NestFactory } from "@nestjs/core"; import type { NestFactory as TypeFactory } from "@nestjs/core"; import { Controller, Module, Get } from "@nestjs/common"; function Custom(path) { return () => {}; } @Controller("live") class Live { @Get() list() {} @Custom("/hidden") hidden() {} } @Module({ controllers: [Live], imports: [dynamicModule()] }) class Root {} function dynamicModule() { return process.env.MODULE; } async function bootstrap() { const app = await NestFactory.create(Root); app.setGlobalPrefix(process.env.PREFIX); } bootstrap(); TypeFactory.create(Root);',
  });
  const graph = await indexRepository(root);
  assert.equal(endpoints(graph).length, 1);
  assert.equal(endpoints(graph)[0]!.metadata.constraintsUnresolved, true);
  assert.ok(graph.diagnostics.some(diagnostic => diagnostic.code === 'nest-unresolved-module-member'));
  assert.ok(graph.diagnostics.some(diagnostic => diagnostic.code === 'nest-dynamic-prefix'));
  assert.ok(graph.diagnostics.some(diagnostic => diagnostic.code === 'nest-custom-decorator'));
});

test('workspace controller/module bindings preserve owning compiler declarations and invalidate consumers', async () => {
  const root = await repository({
    'package.json': json({ workspaces: ['app', 'shared'] }),
    'app/package.json': json({ dependencies: { '@nestjs/core': '^11.1.0', '@fixture/controllers': 'workspace:*' } }),
    'app/main.ts': 'import { NestFactory } from "@nestjs/core"; import { SharedModule } from "@fixture/controllers"; async function bootstrap() { const app = await NestFactory.create(SharedModule); app.setGlobalPrefix("api"); } bootstrap();',
    'shared/package.json': json({ name: '@fixture/controllers', exports: './main.ts', dependencies: { '@nestjs/common': '^11.1.0' } }),
    'shared/main.ts': 'import { Module, Controller, Get } from "@nestjs/common"; @Controller("shared") class SharedController { @Get() list() {} } @Module({ controllers: [SharedController] }) export class SharedModule {}',
  });
  const config = await resolveConfig(root, { repository: { name: 'fixture' }, applications: [{ name: 'app', path: 'app' }] });
  const cache = new AnalysisCache(path.join(root, '.codiluce/cache'));
  const graph = await indexRepository(root, { config, cache });
  assert.deepEqual(endpoints(graph).map(endpoint => endpoint.name), ['GET /api/shared']);
  const handler = graph.entities.find(entity => entity.name === 'list')!;
  assert.equal(handler.path, 'shared/main.ts');
  assert.ok(graph.relations.some(relation => relation.type === 'handles' && relation.to === handler.id));
  const warm = await indexRepository(root, { config, cache });
  assert.equal(semantic(warm), semantic(graph));
});
