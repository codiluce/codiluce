import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { indexRepository } from '../src/pipeline/index.js';
import { resolveConfig, type ApplicationInput } from '../src/core/config.js';
import { canonicalJson } from '../src/history/fingerprint.js';
import { AnalysisCache } from '../src/pipeline/cache.js';
import { compileStarlettePath, matchRoutePattern } from '../src/analysis/routes/contracts.js';
import type { SoftwareGraph } from '../src/core/graph.js';

const temporary: string[] = [];
after(async () => { await Promise.all(temporary.map(root => rm(root, { recursive: true, force: true }))); });
async function repository(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'codiluce-fastapi-')); temporary.push(root);
  for (const [file, content] of Object.entries({ 'requirements.txt': 'fastapi==0.115.0\n', ...files })) { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), content); }
  return root;
}
async function index(root: string, cache?: AnalysisCache, revision?: string, applications: ApplicationInput[] = [{ name: 'api', path: '.', frameworks: ['fastapi'] }]) {
  const config = await resolveConfig(root, { repository: { name: 'fastapi' }, applications }); return indexRepository(root, { config, cache, revision });
}
const endpoints = (graph: SoftwareGraph) => graph.entities.filter(entity => entity.type === 'api_endpoint');
const stored = (graph: SoftwareGraph) => canonicalJson({ entities: graph.entities, relations: graph.relations, diagnostics: graph.diagnostics.filter(item => !['git-metrics', 'indexer'].includes(item.analyzer) && item.code !== 'git-ignore-unavailable') });

test('FastAPI composes aliases, nested and reused routers, multi-method routes and exact imported handlers', async () => {
  const root = await repository({
    'main.py': 'from fastapi import FastAPI as Make\nfrom service import router\napp = Make()\napp.include_router(router, prefix="/v1")\napp.include_router(router, prefix="/v2")\n',
    'service/__init__.py': 'from .routes import router\n',
    'service/routes.py': 'from fastapi import APIRouter as Router\nfrom .handlers import leaf as handler\nchild = Router(prefix="/items")\nchild.add_api_route("/{id:int}", handler, methods=["get", "POST"], status_code=201)\nrouter = Router()\nrouter.include_router(child, prefix="/api")\n',
    'service/handlers.py': 'def helper():\n    return 1\ndef leaf():\n    return helper()\n',
  });
  const graph = await index(root);
  assert.deepEqual(endpoints(graph).map(item => item.name).sort(), ['GET /v1/api/items/{id:int}', 'GET /v2/api/items/{id:int}']);
  for (const endpoint of endpoints(graph)) { assert.equal(endpoint.metadata.constraintsUnresolved, undefined); assert.deepEqual((endpoint.metadata.routing as any).methods, ['GET', 'POST']); assert.equal(endpoint.metadata.statusCode, 201); }
  const leaf = graph.entities.find(item => item.name === 'leaf')!, helper = graph.entities.find(item => item.name === 'helper')!;
  assert.equal(graph.relations.filter(item => item.type === 'handles' && item.to === leaf.id).length, 2);
  assert.ok(graph.relations.some(item => item.type === 'calls' && item.from === leaf.id && item.to === helper.id));
});

test('FastAPI decorators, default methods and inclusion snapshots do not manufacture HEAD or late child routes', async () => {
  const root = await repository({ 'main.py': 'import fastapi as f\napp = f.FastAPI()\nr = f.APIRouter(prefix="/r")\n@r.get("/early")\ndef early():\n    return 1\napp.include_router(r)\n@r.post("/late")\ndef late():\n    return 2\n@app.api_route("/default")\ndef default():\n    return 3\n@app.head("/head")\ndef head():\n    return 4\n' });
  const graph = await index(root);
  assert.deepEqual(endpoints(graph).map(item => item.name).sort(), ['GET /default', 'GET /r/early', 'HEAD /head']);
  assert.deepEqual((endpoints(graph).find(item => item.name === 'GET /r/early')!.metadata.routing as any).methods, ['GET']);
});

test('FastAPI invoked factories and registration helpers bind receiver parameters; unused factories and routers stay private', async () => {
  const root = await repository({ 'main.py': 'from fastapi import FastAPI, APIRouter\ndef register(app, prefix="/health"):\n    @app.get(prefix)\n    def health():\n        return 1\ndef create_app():\n    app = FastAPI()\n    register(app)\n    return app\napp = create_app()\ndef unused():\n    app = FastAPI()\n    @app.get("/unused")\n    def hidden():\n        return 0\n    return app\nr = APIRouter()\n@r.get("/private")\ndef private():\n    return 0\n' });
  const graph = await index(root);
  assert.deepEqual(endpoints(graph).map(item => item.name), ['GET /health']);
  assert.ok(graph.relations.some(item => item.type === 'handles' && graph.entities.find(entity => entity.id === item.to)?.metadata.qualifiedName === 'register.health'));
});

test('FastAPI dependencies link declarations and nested dependencies, including Annotated and Security, without inventing calls', async () => {
  const root = await repository({ 'main.py': 'from fastapi import FastAPI, APIRouter, Depends, Security\nfrom typing import Annotated\ndef token():\n    return "t"\ndef annotated_only():\n    return 1\ndef user(value=Depends(token)):\n    return value\napp = FastAPI(dependencies=[Depends(token)])\nr = APIRouter(dependencies=[Security(user)])\n@r.get("/me", dependencies=[Depends(user)])\ndef me(value: Annotated[str, Depends(annotated_only)]):\n    return value\napp.include_router(r)\n' });
  const graph = await index(root), endpoint = endpoints(graph)[0]!;
  assert.equal(endpoint.metadata.constraintsUnresolved, undefined);
  const names = graph.relations.filter(item => item.type === 'references' && item.from === endpoint.id).map(item => graph.entities.find(entity => entity.id === item.to)!.name).sort();
  assert.deepEqual(names, ['annotated_only', 'token', 'user']);
  assert.equal(graph.relations.some(item => item.type === 'calls' && item.from === endpoint.id), false);
});

test('FastAPI local lookalikes, conditional/type-only imports, reassigned objects and unused bootstrap code produce no endpoints', async () => {
  for (const source of [
    'class FastAPI:\n    def get(self, path):\n        return path\napp = FastAPI()\n@app.get("/fake")\ndef fake():\n    return 1\n',
    'from typing import TYPE_CHECKING\nif TYPE_CHECKING:\n    from fastapi import FastAPI\napp = FastAPI()\n@app.get("/types")\ndef fake():\n    return 1\n',
    'from fastapi import FastAPI\napp = FastAPI()\napp = other\n@app.get("/reassigned")\ndef fake():\n    return 1\n',
  ]) { const root = await repository({ 'main.py': source }); assert.equal(endpoints(await index(root)).length, 0); }
  const root = await repository({ 'fastapi.py': 'class FastAPI:\n    pass\n', 'main.py': 'from fastapi import FastAPI\napp = FastAPI()\n@app.get("/fake")\ndef fake():\n    return 1\n' }); assert.equal(endpoints(await index(root)).length, 0);
});

test('FastAPI mounted subapps retain mount boundaries and only expose composed routes', async () => {
  const root = await repository({ 'main.py': 'from fastapi import FastAPI\napp = FastAPI()\nsub = FastAPI()\n@sub.get("/items")\ndef items():\n    return 1\napp.mount("/sub", sub)\n@app.get("/root")\ndef root():\n    return 1\n' });
  const graph = await index(root);
  assert.deepEqual(endpoints(graph).map(item => item.name).sort(), ['GET /root', 'GET /sub/items']);
  const sub = endpoints(graph).find(item => item.name === 'GET /sub/items')!;
  assert.ok(sub.metadata.mountedApplication); assert.equal((sub.metadata.routing as any).mounts[0].prefix, '/sub');
});

test('Starlette path converter matching preserves case, slashes, integer/UUID/float constraints and opaque custom converters', () => {
  const path = compileStarlettePath('/Items/{id:int}/');
  assert.ok(matchRoutePattern(path, '/Items/12/')); assert.equal(matchRoutePattern(path, '/items/12/'), false); assert.equal(matchRoutePattern(path, '/Items/12'), false); assert.equal(matchRoutePattern(path, '/Items/no/'), false);
  assert.ok(matchRoutePattern(compileStarlettePath('/{n:float}'), '/1.2')); assert.equal(matchRoutePattern(compileStarlettePath('/{n:float}'), '/-1.2'), false);
  assert.ok(matchRoutePattern(compileStarlettePath('/{id:uuid}'), '/123e4567-e89b-12d3-a456-426614174000')); assert.equal(matchRoutePattern(compileStarlettePath('/{id:uuid}'), '/garbage'), false);
  assert.ok(matchRoutePattern(compileStarlettePath('/files/{path:path}'), '/files/a/b'));
  assert.ok(matchRoutePattern(compileStarlettePath('/files/{path:path}'), '/files/')); assert.equal(matchRoutePattern(compileStarlettePath('/files/{path:path}'), '/files'), false);
  assert.equal(compileStarlettePath('/{id:custom}').status, 'partial');
});

test('FastAPI dynamic paths, conditional registrations, unresolved dependencies and custom handler wrappers stay constrained', async () => {
  const root = await repository({ 'main.py': 'from fastapi import FastAPI, Depends\napp = FastAPI()\n@app.get(path)\ndef dynamic():\n    return 1\nif flag:\n    @app.post("/conditional")\n    def conditional():\n        return 1\n@app.get("/wrapped")\n@custom\ndef wrapped():\n    return 1\n@app.get("/deps", dependencies=[Depends(unknown)])\ndef deps():\n    return 1\n' });
  const graph = await index(root);
  assert.equal(endpoints(graph).length, 4); assert.ok(endpoints(graph).every(item => item.metadata.constraintsUnresolved));
  assert.ok(graph.diagnostics.some(item => item.code === 'fastapi-dynamic-path')); assert.ok(graph.diagnostics.some(item => item.code === 'fastapi-unresolved-dependency'));
  const wrapped = endpoints(graph).find(item => item.name === 'GET /wrapped')!; assert.equal(graph.relations.some(item => item.from === wrapped.id && item.type === 'handles'), false);
});

test('TS frontend matches FastAPI only through an explicit origin; opaque competitors block false unique matches', async () => {
  const root = await repository({ 'api/main.py': 'from fastapi import FastAPI\napp = FastAPI()\n@app.get("/items/{id:int}")\ndef item():\n    return 1\n', 'web/package.json': '{"dependencies":{"next":"^16.0.0"}}', 'web/client.ts': 'export function load() { return fetch("https://api.example/items/12"); }' });
  const applications: ApplicationInput[] = [{ name: 'api', path: 'api', frameworks: ['fastapi'], apiOrigins: ['https://api.example'] }, { name: 'web', path: 'web', frameworks: ['nextjs'] }];
  const graph = await index(root, undefined, undefined, applications);
  assert.equal(graph.relations.filter(item => item.type === 'requests').length, 1);
  await writeFile(path.join(root, 'api/main.py'), 'from fastapi import FastAPI\napp = FastAPI()\n@app.get("/items/{id:int}")\ndef item():\n    return 1\n@app.get(path)\ndef dynamic():\n    return 1\n');
  const ambiguous = await index(root, undefined, undefined, applications);
  assert.equal(ambiguous.relations.filter(item => item.type === 'requests').length, 0); assert.ok(ambiguous.diagnostics.some(item => item.code === 'ambiguous-http-match'));
});

test('FastAPI cache/revision parity, handler ownership and line-insertion identity survive replay and edits', async () => {
  const source = 'from fastapi import FastAPI\ndef leaf():\n    return 1\napp = FastAPI()\n@app.get("/one")\ndef one():\n    return leaf()\n';
  const root = await repository({ 'main.py': source }), cache = new AnalysisCache(path.join(root, '.cache'));
  const cold = await index(root, cache), warm = await index(root, cache), revision = await index(root, undefined, 'fixture-revision');
  assert.equal(stored(warm), stored(cold)); assert.equal(stored(revision), stored(cold)); assert.ok(cache.events.some(event => event.analyzer === 'python-imports' && event.hit));
  await writeFile(path.join(root, 'main.py'), `# moved\n\n${source}`);
  const moved = await index(root, cache); assert.deepEqual(endpoints(moved).map(item => item.id), endpoints(cold).map(item => item.id)); assert.equal(stored(moved), stored(await index(root)));
});

test('FastAPI factory instances retain separate identities across line edits and custom decorator order preserves registration only', async () => {
  const source = 'from fastapi import FastAPI\ndef make():\n    app = FastAPI()\n    @app.get("/one")\n    def one():\n        return 1\n    return app\na = make()\nb = make()\n@custom\n@a.get("/wrapped")\ndef wrapped():\n    return 1\ndef run():\n    wrapped()\n';
  const root = await repository({ 'main.py': source }), graph = await index(root);
  assert.equal(endpoints(graph).filter(item => item.name === 'GET /one').length, 2);
  const wrapped = graph.entities.find(item => item.name === 'wrapped')!, run = graph.entities.find(item => item.name === 'run')!;
  assert.ok(graph.relations.some(item => item.type === 'handles' && item.to === wrapped.id));
  assert.equal(graph.relations.some(item => item.type === 'calls' && item.from === run.id && item.to === wrapped.id), false);
  await writeFile(path.join(root, 'main.py'), `# shifted\n\n${source}`);
  assert.deepEqual(endpoints(await index(root)).map(item => item.id).sort(), endpoints(graph).map(item => item.id).sort());
});

test('FastAPI receiver mutations, dependency overrides and unknown includes block confirmed request matches', async () => {
  for (const mutation of ['app.dependency_overrides[dep] = other', 'app.router.routes = []', 'app.include_router(unknown)']) {
    const root = await repository({ 'main.py': `from fastapi import FastAPI, Depends\ndef dep():\n    return 1\napp = FastAPI()\n${mutation}\n@app.get("/one", dependencies=[Depends(dep)])\ndef one():\n    return 1\n` });
    const graph = await index(root); assert.equal(endpoints(graph).length, 1); assert.ok(endpoints(graph)[0]!.metadata.constraintsUnresolved, mutation);
    assert.ok(graph.diagnostics.some(item => ['fastapi-receiver-mutation', 'fastapi-unresolved-router'].includes(item.code)), mutation);
  }
});

test('FastAPI excluded local modules cannot impersonate external framework provenance', async () => {
  const root = await repository({ 'main.py': 'from fastapi import FastAPI\napp = FastAPI()\n@app.get("/fake")\ndef fake():\n    return 1\n', 'fastapi.py': '# opaque\n'.repeat(200_000) });
  assert.equal(endpoints(await index(root)).length, 0);
});

test('FastAPI reviewed live inclusion sees later routes and mounts; broad/unversioned ranges remain constrained', async () => {
  const source = 'from fastapi import FastAPI, APIRouter\napp = FastAPI()\nr = APIRouter()\napp.include_router(r, prefix="/api")\napp.include_router(r, prefix="/api")\n@r.get("/late")\ndef late():\n    return 1\nsub = FastAPI()\n@sub.get("/child")\ndef child():\n    return 1\nr.mount("/sub", sub)\n';
  const root = await repository({ 'requirements.txt': 'fastapi==0.141.1\n', 'main.py': source }), graph = await index(root);
  assert.deepEqual(endpoints(graph).map(item => item.name).sort(), ['GET /api/late', 'GET /api/late', 'GET /api/sub/child', 'GET /api/sub/child']);
  assert.ok(endpoints(graph).every(item => item.metadata.inclusionProfile === 'live' && !item.metadata.constraintsUnresolved));
  await writeFile(path.join(root, 'requirements.txt'), 'fastapi>=0.141.1,<1.0.0\n');
  const unknown = await index(root); assert.ok(endpoints(unknown).every(item => item.metadata.constraintsUnresolved)); assert.ok(unknown.diagnostics.some(item => item.code === 'fastapi-version-profile'));
  await writeFile(path.join(root, 'requirements.txt'), 'fastapi==0.115.0\n');
  assert.equal(endpoints(await index(root)).length, 0, 'snapshot includes precede all child routes; APIRouter mounts are not copied');
});

test('FastAPI factory binding honors Python parameter kinds and rejects incompatible invocations', async () => {
  const source = 'from fastapi import FastAPI\ndef make(prefix, /, *, path="/one"):\n    app = FastAPI()\n    @app.get(path)\n    def one():\n        return 1\n    return app\n';
  const root = await repository({ 'main.py': `${source}\napp = make("p", path="/valid")\n` }); assert.deepEqual(endpoints(await index(root)).map(item => item.name), ['GET /valid']);
  for (const invocation of ['make(prefix="p")', 'make("p", "/invalid")', 'make("p", path="/a", path="/b")']) {
    await writeFile(path.join(root, 'main.py'), `${source}\napp = ${invocation}\n`);
    const graph = await index(root); assert.equal(endpoints(graph).length, 0); assert.ok(graph.diagnostics.some(item => item.code === 'fastapi-factory-arguments'));
  }
});
